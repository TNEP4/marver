/**
 * Channel handlers and the capability map (spec 28 "Channels and who may use them", A2.14 #19, v1.12 r1 #1).
 * Owner: the trust stream.
 *
 * Each webContents main creates is recorded with its kind (`register`); `kindOf` is what the navigation policy
 * reads, at event time.
 *
 * **Canvas documents** (src/shared/app-api.ts; v1.12 r1 #1, v1.13 r2 #1):
 * - `mv:doc` - the preload's one synchronous call at document start - always answers `{ reopen }`, trusted or not,
 *   from a one-shot flag the tab's crash recovery sets (`reopenNext`); it grants and binds nothing;
 * - at an attributed (trusted) commit main mints the document's `doc` and sends `mv:admit { doc }` to the frame
 *   that committed - in the same turn, from the adapter's commit event - and again at its `dom-ready` while nothing
 *   stamped with that `doc` has arrived (Electron drops a message that reaches a frame before its document element
 *   exists); an unattributed commit and a back-forward restore get neither;
 * - `mv:hello`, `mv:theme`, `mv:busy`, `mv:menu` are accepted only from a canvas's main frame, on its tab's origin,
 *   stamped with the committed document's `doc`, while that document is trusted, and within app-api.ts's bounds:
 *   unknown fields stripped, a known one of the wrong type or past its bound refuses the message, as does a busy
 *   whose `busy` or `unsaved` disagrees with its `why`;
 * - the document's safety (v1.13 r2 #1): `unknown` from its commit until its first accepted `mv:busy`, then `fresh`,
 *   and `stale` once its trust goes while it lives - a registry change, a failed load that may have kept it - when
 *   main also sends it `mv:app-state untrusted` (A2.14 #13), so the shell stops every microphone track;
 * - main's messages to a canvas carry the admitted `doc`, so a late one never reaches a later document.
 *
 * **App pages** (A2.5, A2.14 #19): a channel is accepted only from the kinds `SENDERS` lists (src/shared/
 * channels.ts), from that webContents' main frame, while its frame shows the page's own pinned document
 * (`marver-app://<kind>/`), with every field checked here; `send` reaches a page only once it said `app:ready`,
 * and again only after a new document commits there (a refused navigation keeps the page and its readiness).
 * The wire format is the channel name and its payload exactly as channels.ts types it (`ipcRenderer.send` /
 * `invoke`; `INVOKES` below are the invokes, as the app preload calls them). The IPC listeners of a channel are
 * installed when its first handler is (`handle`, `onReady`).
 */
import { randomBytes } from 'node:crypto'
import { ipcMain, webFrameMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron'
import { BOUNDS, CANVAS_CHANNELS, UNSAVED_WHY, WHY, type AppState, type Busy, type DocAnswer, type Hello, type MenuItem, type Theme, type Why } from '../../../src/shared/app-api.ts'
import { CH, INVOKES as INVOKE_LIST, SENDERS, type PageKind } from '../shared/channels.ts'
import { mainFrameOf, safely } from './frames.ts'
import { adapterFor, attachNav, type NavEvent } from './nav.ts'
import { isTrusted, targetOf, unsafePrefs } from './proof.ts'
import { appRegistry, type Registry } from './registry.ts'
import type { Safety } from './tabs.ts'
import { note, testMode } from './testing/index.ts'

/** What the bridge hands the tabs: a canvas document's safety and its accepted reports, the latest of each. */
export interface CanvasReports {
  /** unknown until the document's first accepted `mv:busy`; stale once its trust went while it lives */
  safety: Safety
  hello?: Hello
  theme?: Theme
  busy?: Busy
  menu?: MenuItem[]
}

/** Who sent an app page's message, as main's map knows it. */
export interface PageCtx { wc: WebContents; kind: PageKind; tabId?: string }

export interface Bridge {
  /** record a webContents main created, with its kind (and its tab, for a canvas or a tab page) */
  register(wc: WebContents, kind: PageKind, tabId?: string): void
  /** admit a canvas document at its trusted commit: mints its `doc` and sends `mv:admit` (v1.12 r1 #1). The
   *  bridge admits by itself from the adapter's commit; calling this again for that commit returns the same doc */
  admit(tabId: string): string | null
  /** a canvas document's reports or safety changed (a new document starts at `{ safety: 'unknown' }`, doc '') */
  onReport(fn: (tabId: string, doc: string, r: CanvasReports) => void): () => void
  /** the current document's reports */
  reports(tabId: string): CanvasReports | undefined
  /** `mv:app-state shown | hidden` to a tab's admitted, trusted document */
  appState(tabId: string, state: Exclude<AppState, 'untrusted'>): boolean
  /** `mv:menu-click` to a tab's admitted, trusted document, for an item its last `mv:menu` offers */
  menuClick(tabId: string, id: string): boolean
  /** the next `mv:doc` from this tab's main frame answers `reopen: true`, once (A2.11's crash reload) */
  reopenNext(tabId: string): void
  /** a tab's binding changed outside a registry event: every admitted document's trust is looked at again (the
   *  bridge already does it on each registry event, and at each failed load) */
  trustChanged(): void
  /** an app page's channel: called only for a valid sender and payload; an invoke answers with the return value */
  handle(channel: string, fn: (ctx: PageCtx, payload: unknown) => unknown): void
  /** an app page said `app:ready` (again after a reload): send it every snapshot now */
  onReady(fn: (ctx: PageCtx) => void): () => void
  /** a snapshot to every ready page of a kind, or to one webContents; false when nothing was sent */
  send(target: PageKind | WebContents, channel: string, payload: unknown): boolean
}

// ---- payload checks (pure) -----------------------------------------------------------------------------------

const CONTROL = /[\u0000-\u001f\u007f]/
const text = (v: unknown, max: number, min = 0): v is string => typeof v === 'string' && v.length >= min && v.length <= max && !CONTROL.test(v)
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const UNSAVED = new Set<string>(UNSAVED_WHY)
const WHYS = new Set<string>(WHY)

export function checkHello(p: unknown): Hello | null {
  if (!obj(p)) return null
  if (!text(p.version, BOUNDS.version, 1) || !BOUNDS.versionChars.test(p.version)) return null
  if (p.board !== null && !text(p.board, BOUNDS.board)) return null
  if (typeof p.page !== 'string' || !BOUNDS.page.test(p.page)) return null
  return { version: p.version, board: p.board as string | null, page: p.page }
}
export function checkTheme(p: unknown): Theme | null {
  return obj(p) && typeof p.dark === 'boolean' ? { dark: p.dark } : null
}
export function checkBusy(p: unknown): Busy | null {
  if (!obj(p) || typeof p.busy !== 'boolean' || typeof p.unsaved !== 'boolean' || !Array.isArray(p.why) || p.why.length > WHY.length) return null
  if (!p.why.every((w) => typeof w === 'string' && WHYS.has(w)) || new Set(p.why).size !== p.why.length) return null
  const why = WHY.filter((w) => (p.why as string[]).includes(w))   // the contract's order
  if (p.busy !== why.length > 0 || p.unsaved !== why.some((w) => UNSAVED.has(w))) return null
  return { busy: p.busy, unsaved: p.unsaved, why: why as Why[] }
}
export function checkMenu(p: unknown): MenuItem[] | null {
  if (!Array.isArray(p) || p.length > BOUNDS.menuItems) return null
  const out: MenuItem[] = []
  const ids = new Set<string>()
  for (const it of p) {
    if (!obj(it) || typeof it.id !== 'string' || !BOUNDS.menuId.test(it.id) || ids.has(it.id)) return null
    if (it.group !== 'view' && it.group !== 'jam') return null
    if (!text(it.label, BOUNDS.label, 1)) return null
    if (it.hint !== undefined && !text(it.hint, BOUNDS.hint)) return null
    if (it.checked !== undefined && typeof it.checked !== 'boolean') return null
    ids.add(it.id)
    out.push({ id: it.id, group: it.group, label: it.label, ...(it.hint !== undefined ? { hint: it.hint as string } : {}), ...(it.checked !== undefined ? { checked: it.checked as boolean } : {}) })
  }
  return out
}
const CANVAS_CHECKS = { hello: checkHello, theme: checkTheme, busy: checkBusy, menu: checkMenu } as const
type Report = keyof typeof CANVAS_CHECKS

const TAB_ID = /^[A-Za-z0-9_-]{1,32}$/
const coord = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 20_000
const rev = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
const one = <T extends string>(v: unknown, set: readonly T[]): v is T => typeof v === 'string' && (set as readonly string[]).includes(v)

/** An app page channel's payload, checked and stripped; null refuses it (pure). */
export function checkPagePayload(channel: string, p: unknown): { ok: true; value: unknown } | { ok: false } {
  const yes = (value: unknown) => ({ ok: true as const, value })
  const no = { ok: false as const }
  switch (channel) {
    case CH.ready: case CH.settingsGet: case CH.settingsReveal: return yes(null)
    case CH.tabActivate: case CH.tabClose:
      return obj(p) && typeof p.id === 'string' && TAB_ID.test(p.id) ? yes({ id: p.id }) : no
    case CH.tabMenu:
      return obj(p) && typeof p.id === 'string' && TAB_ID.test(p.id) && coord(p.x) && coord(p.y) ? yes({ id: p.id, x: p.x, y: p.y }) : no
    case CH.tabsMore:
      return obj(p) && Array.isArray(p.ids) && p.ids.length <= 64 && p.ids.every((i) => typeof i === 'string' && TAB_ID.test(i)) && coord(p.x) && coord(p.y)
        ? yes({ ids: [...p.ids], x: p.x, y: p.y }) : no
    case CH.linkOpen:
      return obj(p) && typeof p.url === 'string' && p.url.length <= 2048 ? yes({ url: p.url }) : no
    case CH.pillAction:
      return obj(p) && rev(p.rev) && one(p.act, ['button', 'dismiss'] as const) ? yes({ rev: p.rev, act: p.act }) : no
    case CH.tabpageAction:
      return obj(p) && rev(p.rev) && one(p.action, ['retry', 'reload', 'copy-start', 'copy-details', 'reveal', 'open-browser', 'close'] as const) ? yes({ rev: p.rev, action: p.action }) : no
    case CH.homeAction:
      if (!obj(p)) return no
      if (p.action === 'copy') return one(p.id, ['dev', 'init', 'update'] as const) ? yes({ action: 'copy', id: p.id }) : no
      if (p.action === 'copy-start') return typeof p.id === 'string' && TAB_ID.test(p.id) ? yes({ action: 'copy-start', id: p.id }) : no
      if (p.action === 'show-files') return yes({ action: 'show-files' })
      return no
    case CH.settingsSet:
      return obj(p) && one(p.file, ['config', 'theme'] as const) && typeof p.key === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(p.key)
        && (typeof p.value === 'boolean' || (typeof p.value === 'number' && Number.isFinite(p.value)) || text(p.value, 64))
        ? yes({ file: p.file, key: p.key, value: p.value }) : no
    default: return no
  }
}

/** An app page's own pinned document: `marver-app://<kind>/` (its index.html, a hash at most). */
export function isPinnedUrl(url: string, kind: PageKind): boolean {
  if (kind === 'canvas') return false
  let u: URL
  try { u = new URL(url) } catch { return false }
  return u.protocol === 'marver-app:' && u.host === kind && (u.pathname === '/' || u.pathname === '/index.html') && !u.search && !u.username && !u.password
}

/** May this sender use this app channel? (pure) */
export function mayUsePageChannel(channel: string, kind: PageKind | undefined, mainFrame: boolean, frameUrl: string | undefined): boolean {
  if (!kind || !mainFrame || frameUrl === undefined) return false
  const allowed = SENDERS[channel]
  return !!allowed && allowed.includes(kind) && isPinnedUrl(frameUrl, kind)
}

/**
 * The page-to-main channels that are invokes, answered with the handler's value: channels.ts's `INVOKES` itself,
 * the one list the app preload also follows, so the two can never disagree. Every other channel is a send.
 */
export const INVOKES: ReadonlySet<string> = new Set<string>(INVOKE_LIST)
/** What an invoke whose payload is refused answers (the channel's own "no"). */
const REFUSED_ANSWER: Record<string, unknown> = {
  [CH.linkOpen]: { ok: false, why: 'bad' },
  [CH.homeAction]: { ok: false },
  [CH.settingsSet]: { ok: false, why: 'bad-value' },
}

// ---- the map ---------------------------------------------------------------------------------------------

interface Reg { wc: WebContents; kind: PageKind; tabId?: string; ready: boolean }
const regs = new Map<number, Reg>()
const tabWc = new Map<string, number>()

/** The kind main recorded for a webContents, or undefined (never one main made). */
export const kindOf = (webContentsId: number): PageKind | undefined => regs.get(webContentsId)?.kind
/** The tab a canvas or tab-page webContents belongs to. */
export const tabOf = (webContentsId: number): string | undefined => regs.get(webContentsId)?.tabId

interface DocRecord extends CanvasReports {
  doc?: string
  /** the adapter's commit count when admitted: one doc per commit */
  commit: number
  frame?: { processId: number; routingId: number }
  /** `mv:admit` has gone to the frame at least once */
  sent?: boolean
  /** a message stamped with this doc has arrived */
  heard: boolean
}

/** Test builds: each `mv:admit` held this long, so a case can make the page speak well before it lands. */
let admitDelayMs = 0
export function delayAdmits(ms: number): void { if (__MV_TEST__ && testMode()) admitDelayMs = Math.max(0, ms) }
const docs = new Map<number, DocRecord>()
const reopen = new Set<string>()

function sameFrame(a: WebFrameMain | null | undefined, b: WebFrameMain | null | undefined): boolean {
  return !!a && !!b && !!safely(() => a.processId === b.processId && a.routingId === b.routingId)
}
function frameOf(wc: WebContents, rec: DocRecord): WebFrameMain | null {
  if (wc.isDestroyed()) return null
  const f = rec.frame ? webFrameMain.fromId(rec.frame.processId, rec.frame.routingId) : undefined
  const frame = f && !f.isDestroyed() && !f.detached ? f : mainFrameOf(wc)
  return frame && !frame.isDestroyed() ? frame : null
}
const trace = (event: string, data: Record<string, unknown>) => { if (__MV_TEST__) note('bridge', { event, ...data }) }

let installed: Bridge | null = null

/** Installs the IPC handlers, at ready, before any view. A second call gives the same bridge. */
export function installBridge(): Bridge {
  if (installed) return installed
  const reportFns = new Set<(tabId: string, doc: string, r: CanvasReports) => void>()
  const readyFns = new Set<(ctx: PageCtx) => void>()
  const handlers = new Map<string, (ctx: PageCtx, payload: unknown) => unknown>()
  const listening = new Set<string>()
  let watched: Registry | null = null
  let unwatch: (() => void) | null = null

  const publicReports = (rec: DocRecord): CanvasReports => ({
    safety: rec.safety,
    ...(rec.hello ? { hello: { ...rec.hello } } : {}), ...(rec.theme ? { theme: { ...rec.theme } } : {}),
    ...(rec.busy ? { busy: { ...rec.busy, why: [...rec.busy.why] } } : {}), ...(rec.menu ? { menu: rec.menu.map((m) => ({ ...m })) } : {}),
  })
  const tell = (wcId: number) => {
    const tabId = regs.get(wcId)?.tabId
    const rec = docs.get(wcId)
    if (!tabId || !rec) return
    const r = publicReports(rec)
    for (const fn of [...reportFns]) {
      try { fn(tabId, rec.doc ?? '', r) } catch (err) { process.stderr.write(`marver-app: a report listener threw: ${(err as Error).message}\n`) }
    }
  }
  const sendCanvas = (wcId: number, channel: string, payload: unknown): boolean => {
    const r = regs.get(wcId)
    const rec = docs.get(wcId)
    if (!r || !rec?.doc) return false
    const f = frameOf(r.wc, rec)
    if (!f) return false
    try { f.send(channel, payload); return true } catch { return false }
  }

  /** Trust went while the document lives: stale, and the page told so (it stops its microphone). */
  const lose = (wcId: number, why: string) => {
    const rec = docs.get(wcId)
    if (!rec?.doc || rec.safety === 'stale') return
    rec.safety = 'stale'
    trace('untrusted', { wc: wcId, why })
    sendCanvas(wcId, CANVAS_CHANNELS.appState, { doc: rec.doc, s: 'untrusted' satisfies AppState })
    tell(wcId)
  }
  const recheck = () => { for (const id of docs.keys()) if (!isTrusted(id)) lose(id, 'registry') }
  const watchRegistry = () => {
    const r = appRegistry()
    if (r === watched) return
    unwatch?.()
    watched = r
    unwatch = r ? r.on(() => recheck()) : null
  }

  /** The record of the tab's current commit: a new commit starts a new one, `unknown` (v1.13 r2 #1). */
  const current = (wcId: number, commit: number): DocRecord => {
    const had = docs.get(wcId)
    if (had && had.commit === commit) return had
    const fresh: DocRecord = { safety: 'unknown', commit, heard: false }
    docs.set(wcId, fresh)
    return fresh
  }
  const admitNow = (wcId: number): string | null => {
    const r = regs.get(wcId)
    const a = adapterFor(wcId)
    if (!r || r.kind !== 'canvas' || !a || !isTrusted(wcId)) return null
    const rec = current(wcId, a.commits())
    if (rec.doc) return rec.doc   // this commit's doc, minted once whoever asks first
    const doc = rec.doc = randomBytes(18).toString('base64url')
    rec.frame = a.frame()
    watchRegistry()
    const send = () => {
      if (docs.get(wcId) !== rec || !isTrusted(wcId)) return
      rec.sent = true
      const sent = sendCanvas(wcId, CANVAS_CHANNELS.admit, { doc })
      trace('admit', { wc: wcId, tab: r.tabId, sent, at: Date.now() })
    }
    if (__MV_TEST__ && admitDelayMs > 0) setTimeout(send, admitDelayMs)
    else send()
    tell(wcId)
    return rec.doc
  }

  const onNav = (wcId: number) => (e: NavEvent) => {
    if (e.kind === 'commit') {
      const a = adapterFor(wcId)
      if (!a) return
      const rec = current(wcId, a.commits())
      if (e.attributed) admitNow(wcId)
      else if (!rec.doc) tell(wcId)
    } else if (e.kind === 'fail') {
      lose(wcId, 'failed load')   // whatever is committed lost its trust; Chromium may have kept it alive
    }
  }

  // mv:doc - synchronous, always answered, grants nothing
  ipcMain.on(CANVAS_CHANNELS.doc, (e: IpcMainEvent) => {
    let answer: DocAnswer = { reopen: false }
    try {
      const r = regs.get(e.sender.id)
      if (r?.kind === 'canvas' && r.tabId && sameFrame(e.senderFrame, mainFrameOf(e.sender)) && reopen.delete(r.tabId)) answer = { reopen: true }
    } finally { e.returnValue = answer }
  })

  // the canvas's reports
  for (const ch of Object.keys(CANVAS_CHECKS) as Report[]) {
    ipcMain.on(CANVAS_CHANNELS[ch], (e: IpcMainEvent, msg: unknown) => {
      const id = e.sender.id
      const refuse = (why: string) => { trace('refused', { wc: id, ch, why }) }
      const r = regs.get(id)
      if (!r || r.kind !== 'canvas') return refuse('not a canvas')
      if (!sameFrame(e.senderFrame, mainFrameOf(e.sender))) return refuse('not the main frame')
      const rec = docs.get(id)
      const m = obj(msg) ? msg : null
      if (!m || typeof m.doc !== 'string' || !rec?.doc || m.doc !== rec.doc) return refuse('not the admitted document')
      if (!isTrusted(id)) return refuse('untrusted')
      const origin = targetOf(id)?.entry.origin
      if (!origin || e.senderFrame?.origin !== origin) return refuse('not the canvas origin')
      const v = CANVAS_CHECKS[ch](m.p)
      if (v === null) return refuse('payload')
      ;(rec as unknown as Record<Report, unknown>)[ch] = v
      rec.heard = true
      if (ch === 'busy') rec.safety = 'fresh'
      trace('accepted', { wc: id, ch })
      tell(id)
    })
  }

  // app pages
  const pageCtx = (e: IpcMainEvent | IpcMainInvokeEvent, channel: string): PageCtx | null => {
    const r = regs.get(e.sender.id)
    const ok = mayUsePageChannel(channel, r?.kind, sameFrame(e.senderFrame, mainFrameOf(e.sender)), e.senderFrame?.url)
    if (!ok || !r) { trace('page-refused', { wc: e.sender.id, channel, kind: r?.kind }); return null }
    return { wc: r.wc, kind: r.kind, ...(r.tabId ? { tabId: r.tabId } : {}) }
  }
  const listen = (channel: string) => {
    if (listening.has(channel) || !SENDERS[channel]) return
    listening.add(channel)
    if (INVOKES.has(channel)) {
      ipcMain.handle(channel, async (e, payload: unknown) => {
        const ctx = pageCtx(e, channel)
        if (!ctx) throw new Error('refused')
        const p = checkPagePayload(channel, payload)
        if (!p.ok) { trace('page-refused', { wc: e.sender.id, channel, why: 'payload' }); return REFUSED_ANSWER[channel] ?? null }
        return await handlers.get(channel)?.(ctx, p.value)
      })
      return
    }
    ipcMain.on(channel, (e, payload: unknown) => {
      const ctx = pageCtx(e, channel)
      if (!ctx) return
      const p = checkPagePayload(channel, payload)
      if (!p.ok) { trace('page-refused', { wc: e.sender.id, channel, why: 'payload' }); return }
      if (channel === CH.ready) {
        const r = regs.get(e.sender.id)
        if (r) r.ready = true
        for (const fn of [...readyFns]) { try { fn(ctx) } catch (err) { process.stderr.write(`marver-app: a ready listener threw: ${(err as Error).message}\n`) } }
        return
      }
      try { void handlers.get(channel)?.(ctx, p.value) } catch (err) { process.stderr.write(`marver-app: ${channel} threw: ${(err as Error).message}\n`) }
    })
  }

  installed = {
    register(wc, kind, tabId) {
      if (wc.isDestroyed()) return
      const id = wc.id
      const unsafe = unsafePrefs(wc)
      if (unsafe) {
        // loud, and closed: a view made outside canvasWebPreferences / appWebPreferences gets no channel and no trust
        process.stderr.write(`marver-app: a ${kind} view was made with ${unsafe} - it is refused every channel (sessions.ts canvasWebPreferences / appWebPreferences)\n`)
        trace('unsafe-view', { wc: id, kind, why: unsafe })
        return
      }
      const had = regs.get(id)
      if (had) {
        // once per webContents: a second call changes nothing but its tab
        if (had.kind === kind && tabId && had.tabId !== tabId) { had.tabId = tabId; if (kind === 'canvas') tabWc.set(tabId, id) }
        return
      }
      regs.set(id, { wc, kind, ...(tabId ? { tabId } : {}), ready: false })
      if (tabId && kind === 'canvas') tabWc.set(tabId, id)
      wc.once('destroyed', () => {
        const r = regs.get(id)
        regs.delete(id)
        docs.delete(id)
        if (r?.tabId && tabWc.get(r.tabId) === id) tabWc.delete(r.tabId)
      })
      if (kind !== 'canvas') {
        // a new document says ready again; until then it gets nothing. Only a commit makes one - a document
        // (did-navigate), an error page (did-fail-provisional-load: Electron sends it for a committed error page
        // alone) - or a renderer gone. Never did-start-navigation: it fires before the policy refuses a
        // navigation, and the page that stays has said ready already
        const unready = () => { const r = regs.get(id); if (r) r.ready = false }
        wc.on('did-navigate', unready)
        wc.on('did-fail-provisional-load', (_e, _code, _d, _url, isMain) => { if (isMain) unready() })
        wc.on('render-process-gone', unready)
        return
      }
      docs.set(id, { safety: 'unknown', commit: -1, heard: false })
      attachNav(wc).on(onNav(id))
      watchRegistry()
      wc.on('dom-ready', () => {
        // the admit may have reached the frame before its document element: Electron drops such a message
        const rec = docs.get(id)
        if (rec?.doc && rec.sent && !rec.heard && isTrusted(id)) {
          const sent = sendCanvas(id, CANVAS_CHANNELS.admit, { doc: rec.doc })
          trace('admit-again', { wc: id, sent })
        }
      })
      wc.on('render-process-gone', () => { docs.set(id, { safety: 'unknown', commit: -1, heard: false }); tell(id) })
    },
    admit(tabId) {
      const id = tabWc.get(tabId)
      return id === undefined ? null : admitNow(id)
    },
    onReport(fn) { reportFns.add(fn); return () => { reportFns.delete(fn) } },
    reports(tabId) {
      const id = tabWc.get(tabId)
      const rec = id === undefined ? undefined : docs.get(id)
      return rec ? publicReports(rec) : undefined
    },
    appState(tabId, state) {
      const id = tabWc.get(tabId)
      const rec = id === undefined ? undefined : docs.get(id)
      if (id === undefined || !rec?.doc || !isTrusted(id) || (state !== 'shown' && state !== 'hidden')) return false
      return sendCanvas(id, CANVAS_CHANNELS.appState, { doc: rec.doc, s: state })
    },
    menuClick(tabId, itemId) {
      const id = tabWc.get(tabId)
      const rec = id === undefined ? undefined : docs.get(id)
      if (id === undefined || !rec?.doc || !isTrusted(id) || !rec.menu?.some((m) => m.id === itemId)) return false
      return sendCanvas(id, CANVAS_CHANNELS.menuClick, { doc: rec.doc, id: itemId })
    },
    reopenNext(tabId) { reopen.add(tabId) },
    trustChanged() { recheck() },
    handle(channel, fn) {
      if (!SENDERS[channel]) throw new Error(`bridge: ${channel} is not an app page channel`)
      handlers.set(channel, fn)
      listen(channel)
    },
    onReady(fn) {
      readyFns.add(fn)
      listen(CH.ready)
      return () => { readyFns.delete(fn) }
    },
    send(target, channel, payload) {
      const to = typeof target === 'string' ? [...regs.values()].filter((r) => r.kind === target) : [regs.get(target.id)].filter((r): r is Reg => !!r)
      let sent = false
      for (const r of to) {
        const url = r.kind === 'canvas' || !r.ready ? undefined : safely(() => mainFrameOf(r.wc)?.url)
        if (url === undefined || !isPinnedUrl(url, r.kind)) continue
        // a page whose renderer went (the strip's is reloaded by window.ts) gets nothing; it is sent all again at its next app:ready
        try { r.wc.send(channel, payload); sent = true } catch { /* the frame went */ }
      }
      return sent
    },
  }
  return installed
}
