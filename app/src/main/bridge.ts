/**
 * Channel handlers and the capability map (spec 28 "Channels and who may use them", A2.14 #19, v1.12 r1 #1).
 * Owner: the trust stream.
 *
 * Each webContents main creates is recorded with its kind (`register`); `kindOf` is what the navigation policy
 * reads, at event time.
 *
 * **Canvas documents** (src/shared/app-api.ts; v1.12 r1 #1, v1.13 r2 #1):
 * - `mv:doc` - the preload's one synchronous call at document start, naming its document's own origin - always
 *   answers `{ reopen }`, trusted or not, from a one-shot flag the tab's crash recovery sets (`reopenNext`), which
 *   only a document on the tab's canvas origin takes: never an error page (an opaque origin) or another site, so a
 *   reload that failed leaves it for the load that lifts; it grants and binds nothing;
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
 * **A3** (app 0.2; A3.8 #10, #26, #27), frozen before its streams split and wired here:
 * - `mv:doc` also answers `inset` (`insetFor(tabId)`, layout.ts's `docInset`), and its sender check is "a top-level
 *   frame of a registered canvas webContents": at document start after a frame swap main may not yet have handled
 *   the commit, so `wc.mainFrame` can still be the old frame. A wrong 0 is safe;
 * - `mv:hello`'s `inset` is 0 or 44 when present, else the message is refused;
 * - `mv:perf` is accepted like the reports (a canvas main frame, the admitted `doc`, trusted, on the canvas origin),
 *   checked against `PERF_BOUNDS` (unknown fields stripped, a value past its bound refused) and rate limited per
 *   webContents (30 a second, a burst of 64; drops counted), then handed to `onPerf` - never stored: it is about
 *   now. `perfAsk` sends main's asks to the admitted, trusted document;
 * - `mv:presented` is accepted the same way and handed to `onPresented`; `present` sends `mv:present` only to the
 *   document named, admitted and trusted. Which epoch counts is present.ts's.
 *
 * **A4** (app 0.3; A4.6 #29, #35), signatures frozen before its streams split (A4.6 #56), wired by them:
 * - `openItem` sends `mv:open { doc, item }` to a tab's admitted, trusted document whose instance lists `open`, after
 *   its hello (tabs.ts holds the click until then), the item checked as the preload checks it (open-item.ts);
 *   `mv:opened`, the shell's answer, is accepted like the reports and journaled;
 * - `mv:capture`, the first canvas invoke, admits its sender as the reports do (an `IpcMainInvokeEvent`) with its
 *   instance listing `capture` (else `untrusted`), checks the rect (`checkCaptureRect`: inside the view, rounded out;
 *   else `bounds`), and hands an accepted ask to `onCapture`'s handler with a `still()` that runs the same admission
 *   again - the bridge holds no capture logic (live-picture.ts does);
 * - `settings:action` carries Settings' one action, `open-notification-settings` (A4.6 #27).
 * - a shared canvas's view (`remote`, A4.6 #40, r1 #8) is recorded like any view - its kind and tab, and its cleanup
 *   at `destroyed` - so `kindOf` answers for its permissions (sessions.ts `allowRemote`); then `register` returns,
 *   before the app-page and canvas wiring: it has no channel, no document record and no admission.
 *
 * **App pages** (A2.5, A2.14 #19): a channel is accepted only from the kinds `SENDERS` lists (src/shared/
 * channels.ts), from that webContents' main frame, while its frame shows the page's own pinned document
 * (`marver-app://<kind>/`), with every field checked here; `send` reaches a page only once it said `app:ready`,
 * and again only after a new document commits there (a refused navigation keeps the page and its readiness).
 * The wire format is the channel name and its payload exactly as channels.ts types it (`ipcRenderer.send` /
 * `invoke`; `INVOKES` below are the invokes, as the app preload calls them). The IPC listeners of a channel are
 * installed when its first handler is (`handle`, `onReady`).
 *
 * **Spec 30 (commands, R12 #52)**: every app page's message is one command, recorded here where they all pass
 * (`pageRun`): the handler runs as that command's turn, and what it does not end itself ends on its answer. A `via`
 * only the page can know is allowlisted in `checkPagePayload`: `tab:activate`, `link:open` and `pill:action`.
 * `mv:menu-click` carries the menu a relayed item came from (`in`, #51), and `mv:opened` ends its notice's command.
 */
import { randomBytes } from 'node:crypto'
import { ipcMain, webFrameMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron'
import {
  APP_MENU_IDS, BOUNDS, CANVAS_CHANNELS, FEATURE, PERF_BOUNDS, UNSAVED_WHY, WATCH_WHY, WHY, type WatchWhy,
  type AppState, type Busy, type CaptureAnswer, type CaptureRect, type ExportPdfAnswer, type DocAnswer, type Hello, type Inset, type MenuIn, type MenuItem, type OpenItem, type PerfAsk, type PerfCam,
  type PerfMsg, type PerfSize, type Present, type Presented, type Theme, type Why,
} from '../../../src/shared/app-api.ts'
import { CH, INVOKES as INVOKE_LIST, SENDERS, type PageKind } from '../shared/channels.ts'
import { appCmd, noticeAnswered, pageCommand, pageEnd, withAppCmd } from './commands.ts'
import { checkOpened, checkOpenItem } from '../shared/open-item.ts'
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

/**
 * A4 (A4.6 #35): main's answer to an accepted `mv:capture` - the tab and document that asked, the rect checked and
 * rounded out to whole CSS px, and `still()`, the bridge's admission of that sender and `doc` run again (admitted,
 * trusted, its instance listing `capture`), for the checks after the readback.
 */
export type CaptureHandler = (tabId: string, doc: string, rect: CaptureRect, still: () => boolean) => Promise<CaptureAnswer>

/**
 * Spec 31: main's answer to an accepted `mv:export-pdf` - the tab and document that asked, the canvas origin it was
 * admitted on, its webContents (whose session holds the owner cookie), the job id as sent (pdf-save.ts checks it), and
 * `still()`, the same admission run again (after the save panel).
 */
export type ExportPdfHandler = (ask: { tabId: string; doc: string; origin: string; wc: WebContents; job: unknown }, still: () => boolean) => Promise<ExportPdfAnswer>

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
  /** `mv:menu-click` to a tab's admitted, trusted document, for an item its last `mv:menu` offers; `where` the menu it came from (spec 30 #51) */
  menuClick(tabId: string, id: string, where?: MenuIn): boolean
  /** the next `mv:doc` from this tab's main frame, of a document on the tab's canvas origin, answers `reopen: true`, once (A2.11's crash reload) */
  reopenNext(tabId: string): void
  /** that flag taken back, if no `mv:doc` has taken it yet (A3: a link opened into a tab with no live document, A3.8 #42) */
  reopenCancel(tabId: string): void
  /** a tab's binding changed outside a registry event: every admitted document's trust is looked at again (the
   *  bridge already does it on each registry event, and at each failed load) */
  trustChanged(): void
  /** an app page's channel: called only for a valid sender and payload; an invoke answers with the return value */
  handle(channel: string, fn: (ctx: PageCtx, payload: unknown) => unknown): void
  /** an app page said `app:ready` (again after a reload): send it every snapshot now */
  onReady(fn: (ctx: PageCtx) => void): () => void
  /** a snapshot to every ready page of a kind, or to one webContents; false when nothing was sent */
  send(target: PageKind | WebContents, channel: string, payload: unknown): boolean

  // ---- A3 (A3.8 #10, #27) ----
  /** an accepted `mv:perf` from a tab's admitted, trusted document: checked, stripped, within its rate - never stored */
  onPerf(fn: (tabId: string, doc: string, msg: PerfMsg) => void): () => void
  /** `mv:perf-ask` to a tab's admitted, trusted document, stamped with its `doc`; false when there is none */
  perfAsk(tabId: string, ask: PerfAsk): boolean
  /** an accepted `mv:presented` from a tab's admitted, trusted document */
  onPresented(fn: (tabId: string, doc: string, r: Presented) => void): () => void
  /** `mv:present` to the tab's document `doc`, only while it is the admitted, trusted one; false otherwise (the next compose retries) */
  present(tabId: string, doc: string, r: Present): boolean
  /** `mv:perf` so far: accepted, refused by a check, dropped by the rate limit */
  perfCounts(): { accepted: number; refused: number; dropped: number }

  // ---- A4 (A4.6 #29, #35): signatures frozen here, built by their streams ----
  /** `mv:open { doc, item }` to the tab's admitted, trusted document whose instance lists `open`; false when there is
   *  none, or the item fails open-item.ts's check (A4.6 #29) */
  openItem(tabId: string, item: OpenItem): boolean
  /** main's handler for accepted `mv:capture` asks (live-picture.ts, A4.6 #35); null takes it away. The live pictures
   *  stream installs the invoke itself */
  onCapture(fn: CaptureHandler | null): void
  /** spec 31: main's handler for accepted `mv:export-pdf` asks (pdf-save.ts); null takes it away */
  onExportPdf(fn: ExportPdfHandler | null): void
}

/** What the bridge asks of the rest of main (main.ts passes them at install). */
export interface BridgeOptions {
  /** `mv:doc`'s inset for the tab's document now committing (layout.ts `docInset`); 0 without it */
  insetFor?(tabId: string): Inset
  /** A4 (A4.6 #35): the tab's content view in CSS px (its bounds over its zoom), which `mv:capture`'s rect must lie
   *  inside; null when it has none */
  viewSize?(tabId: string): { width: number; height: number } | null
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
  // the inset the shell applied (A3.8 #26): 0 or 44 when present, absent reads 0
  if (p.inset !== undefined && p.inset !== 0 && p.inset !== 44) return null
  return { version: p.version, board: p.board as string | null, page: p.page, ...(p.inset !== undefined ? { inset: p.inset as Inset } : {}) }
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
    if (it.group !== 'view' && it.group !== 'jam' && it.group !== 'file') return null
    if (!text(it.label, BOUNDS.label, 1)) return null
    if (it.hint !== undefined && !text(it.hint, BOUNDS.hint)) return null
    if (it.checked !== undefined && typeof it.checked !== 'boolean') return null
    ids.add(it.id)
    out.push({ id: it.id, group: it.group, label: it.label, ...(it.hint !== undefined ? { hint: it.hint as string } : {}), ...(it.checked !== undefined ? { checked: it.checked as boolean } : {}) })
  }
  return out
}
const CANVAS_CHECKS = { hello: checkHello, theme: checkTheme, busy: checkBusy, menu: checkMenu } as const

// ---- A3's canvas messages (pure; A3.8 #10, #27) -------------------------------------------------------------

const whole = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
const within = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max
/** a camera: world offsets finite (they may be negative), a positive scale */
const checkCam = (v: unknown): PerfCam | null | undefined => {
  if (v === null) return null
  if (!obj(v) || typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.s !== 'number') return undefined
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || Math.abs(v.x) > 1e9 || Math.abs(v.y) > 1e9 || !(v.s > 0 && v.s <= 1e4)) return undefined
  return { x: v.x, y: v.y, s: v.s }
}
const checkSize = (v: unknown): PerfSize | null => (obj(v) && within(v.w, PERF_BOUNDS.coord) && within(v.h, PERF_BOUNDS.coord) ? { w: v.w, h: v.h } : null)

/** An `mv:perf` payload, checked and stripped (A3.8 #10); null refuses it. */
export function checkPerf(p: unknown): PerfMsg | null {
  if (!obj(p)) return null
  const C = PERF_BOUNDS.counter
  switch (p.kind) {
    case 'gesture':
      if (typeof p.on !== 'boolean' || !whole(p.seq, C)) return null
      if (p.type !== undefined && p.type !== 'pan' && p.type !== 'zoom' && p.type !== 'layout') return null
      return { kind: 'gesture', on: p.on, seq: p.seq, ...(p.type !== undefined ? { type: p.type } : {}) }
    case 'probes': {
      if (!whole(p.tick, C)) return null
      const cam = checkCam(p.cam)
      const view = checkSize(p.view)
      if (cam === undefined || !view) return null
      if (p.at === 'before') {
        if (!Array.isArray(p.points) || p.points.length > PERF_BOUNDS.points) return null
        const points: [number, number][] = []
        for (const q of p.points) {
          if (!Array.isArray(q) || q.length !== 2 || !within(q[0], PERF_BOUNDS.coord) || !within(q[1], PERF_BOUNDS.coord)) return null
          points.push([q[0], q[1]])
        }
        return { kind: 'probes', tick: p.tick, at: 'before', points, cam, view, ...(p.stage === true ? { stage: true as const } : {}) }
      }
      if (p.at === 'after') {
        if (!Array.isArray(p.valid) || p.valid.length > PERF_BOUNDS.points || !p.valid.every((b) => typeof b === 'boolean')) return null
        return { kind: 'probes', tick: p.tick, at: 'after', valid: [...p.valid] as boolean[], cam, view }
      }
      return null
    }
    case 'mem':
      if (!whole(p.tick, C) || !within(p.privateKB, PERF_BOUNDS.kb) || !within(p.heapUsedKB, PERF_BOUNDS.kb) || !within(p.heapTotalKB, PERF_BOUNDS.kb)) return null
      return { kind: 'mem', tick: p.tick, privateKB: p.privateKB, heapUsedKB: p.heapUsedKB, heapTotalKB: p.heapTotalKB }
    case 'shown':
      return whole(p.tick, C) ? { kind: 'shown', tick: p.tick } : null
    case 'board':
      return whole(p.frames, PERF_BOUNDS.frames) && whole(p.asleep, PERF_BOUNDS.frames) ? { kind: 'board', frames: p.frames, asleep: p.asleep } : null
    case 'watch':
      // spec 30 #38: a white-out window a 0.30 shell opens or closes
      if (typeof p.on !== 'boolean' || !whole(p.seq, C) || !(WATCH_WHY as readonly unknown[]).includes(p.why)) return null
      return { kind: 'watch', on: p.on, seq: p.seq, why: p.why as WatchWhy }
    default:
      return null
  }
}

/** An `mv:presented` payload (A3.8 #27); null refuses it. */
export function checkPresented(p: unknown): Presented | null {
  if (!obj(p) || !whole(p.epoch, BOUNDS.epoch) || !within(p.w, BOUNDS.viewport) || !within(p.h, BOUNDS.viewport)) return null
  return { epoch: p.epoch, w: p.w, h: p.h }
}

/** `mv:capture`'s ask (A4.6 #35): the rect finite, `x, y >= 0`, `width, height >= 1`, inside the view (`view`, CSS px),
 *  rounded out to whole px; null answers `bounds` (pure). */
export function checkCaptureRect(p: unknown, view: { width: number; height: number } | null): CaptureRect | null {
  if (!obj(p) || !obj(p.rect) || !view) return null
  const { x, y, width, height } = p.rect
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || x < 0 || y < 0 || width < 1 || height < 1) return null
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.ceil(x + width), y1 = Math.ceil(y + height)
  if (x1 > Math.ceil(view.width) || y1 > Math.ceil(view.height)) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** A token bucket of `PERF_BOUNDS.burst`, refilled at `perSecond` (pure but for the clock it is given). */
export function perfBucket(now: number): { take(at: number): boolean } {
  let tokens: number = PERF_BOUNDS.burst
  let last = now
  return {
    take(at) {
      tokens = Math.min(PERF_BOUNDS.burst, tokens + Math.max(0, at - last) * PERF_BOUNDS.perSecond / 1000)
      last = at
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}
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
    case CH.settingsAction:
      return obj(p) && p.action === 'open-notification-settings' ? yes({ action: p.action }) : no
    case CH.tabActivate:
      // spec 30 #50: how it was chosen, which only the page knows; absent reads `click`
      if (!obj(p) || typeof p.id !== 'string' || !TAB_ID.test(p.id) || (p.via !== undefined && !one(p.via, ['key', 'click'] as const))) return no
      return yes({ id: p.id, ...(p.via !== undefined ? { via: p.via } : {}) })
    case CH.tabClose:
      return obj(p) && typeof p.id === 'string' && TAB_ID.test(p.id) ? yes({ id: p.id }) : no
    case CH.tabMenu:
      return obj(p) && typeof p.id === 'string' && TAB_ID.test(p.id) && coord(p.x) && coord(p.y) ? yes({ id: p.id, x: p.x, y: p.y }) : no
    case CH.tabsMore:
      return obj(p) && Array.isArray(p.ids) && p.ids.length <= 64 && p.ids.every((i) => typeof i === 'string' && TAB_ID.test(i)) && coord(p.x) && coord(p.y)
        ? yes({ ids: [...p.ids], x: p.x, y: p.y }) : no
    case CH.linkOpen:
      // `via`: `click`, a past shared canvas's card; absent reads Return in the field (spec 30 #50)
      if (!obj(p) || typeof p.url !== 'string' || p.url.length > 2048 || (p.via !== undefined && p.via !== 'click')) return no
      return yes({ url: p.url, ...(p.via !== undefined ? { via: p.via } : {}) })
    case CH.pillAction:
      // `via`: `key`, Esc on a dismissible pill; absent reads a click (spec 30 #50)
      if (!obj(p) || !rev(p.rev) || !one(p.act, ['button', 'dismiss'] as const) || (p.via !== undefined && p.via !== 'key')) return no
      return yes({ rev: p.rev, act: p.act, ...(p.via !== undefined ? { via: p.via } : {}) })
    case CH.tabpageAction:
      return obj(p) && rev(p.rev) && one(p.action, ['retry', 'reload', 'copy-start', 'copy-details', 'reveal', 'open-browser', 'close', 'export-report'] as const) ? yes({ rev: p.rev, action: p.action }) : no
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

/** An app page's own pinned document: `marver-app://<kind>/` (its index.html, a hash at most). A canvas and a remote
 *  view (A4.6 #40) have none. */
export function isPinnedUrl(url: string, kind: PageKind): boolean {
  if (kind === 'canvas' || kind === 'remote') return false
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
/** The bridge once installed, else null: views.ts registers a shared canvas's view here - there is no trust to fake for it. */
export const bridgeNow = (): Bridge | null => installed

/** Installs the IPC handlers, at ready, before any view. A second call gives the same bridge. */
export function installBridge(o: BridgeOptions = {}): Bridge {
  if (installed) return installed
  const reportFns = new Set<(tabId: string, doc: string, r: CanvasReports) => void>()
  const perfFns = new Set<(tabId: string, doc: string, msg: PerfMsg) => void>()
  const presentedFns = new Set<(tabId: string, doc: string, r: Presented) => void>()
  const buckets = new Map<number, ReturnType<typeof perfBucket>>()
  const perfCount = { accepted: 0, refused: 0, dropped: 0 }
  const readyFns = new Set<(ctx: PageCtx) => void>()
  const handlers = new Map<string, (ctx: PageCtx, payload: unknown) => unknown>()
  const listening = new Set<string>()
  /** A4: main's capture handler (A4.6 #35), read by the `mv:capture` invoke the live pictures stream adds */
  let captureFn: CaptureHandler | null = null
  /** spec 31: main's PDF save handler, read by the `mv:export-pdf` invoke */
  let exportPdfFn: ExportPdfHandler | null = null
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

  // mv:doc - synchronous, always answered, grants nothing. The origin is the document's own (the preload reads
  // location.origin at document start, before main may have processed the commit): only a document on the tab's
  // canvas origin takes the flag - an error page of a reload that failed (opaque, 'null') leaves it for the next
  // load, which is still the reload after the crash
  // A3: it also answers the document's inset (layout's, not trust's: it grants nothing), and the sender is "a top-level
  // frame of a registered canvas webContents" - at document start after a frame swap, `wc.mainFrame` may still be
  // the old frame when main has not yet handled the commit (A3.8 #26)
  ipcMain.on(CANVAS_CHANNELS.doc, (e: IpcMainEvent, msg: unknown) => {
    let answer: DocAnswer = { reopen: false }
    try {
      const r = regs.get(e.sender.id)
      const origin = obj(msg) && typeof msg.origin === 'string' ? msg.origin : null
      const top = !!safely(() => { const f = e.senderFrame; return !!f && !f.isDestroyed() && f.parent === null })
      const canvas = r?.kind === 'canvas' && !!r.tabId && top
      const own = r?.tabId && reopen.has(r.tabId) ? targetOf(e.sender.id)?.entry.origin : undefined
      const reopenNow = canvas && !!own && origin === own && reopen.delete(r!.tabId!)
      let inset: Inset = 0
      if (canvas) { try { inset = o.insetFor?.(r!.tabId!) === 44 ? 44 : 0 } catch { inset = 0 } }
      answer = canvas ? { reopen: reopenNow, inset } : { reopen: false }
      if (r?.tabId && reopen.has(r.tabId)) trace('reopen-kept', { wc: e.sender.id, origin })
      if (canvas) trace('doc', { wc: e.sender.id, tab: r!.tabId, reopen: reopenNow, inset })
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

  // A3: the recorder's messages and the presentation answers - the reports' checks, then their own; never stored
  /** The sender is the tab's admitted, trusted document on its canvas origin: its tab and doc, else why not. */
  const admittedSender = (e: IpcMainEvent | IpcMainInvokeEvent, m: Record<string, unknown> | null): { tabId: string; doc: string } | string => {
    const id = e.sender.id
    const r = regs.get(id)
    if (!r || r.kind !== 'canvas' || !r.tabId) return 'not a canvas'
    if (!sameFrame(e.senderFrame, mainFrameOf(e.sender))) return 'not the main frame'
    const rec = docs.get(id)
    if (!m || typeof m.doc !== 'string' || !rec?.doc || m.doc !== rec.doc) return 'not the admitted document'
    if (!isTrusted(id)) return 'untrusted'
    const origin = targetOf(id)?.entry.origin
    if (!origin || e.senderFrame?.origin !== origin) return 'not the canvas origin'
    return { tabId: r.tabId, doc: rec.doc }
  }
  ipcMain.on(CANVAS_CHANNELS.perf, (e: IpcMainEvent, msg: unknown) => {
    const id = e.sender.id
    let b = buckets.get(id)
    if (!b) { b = perfBucket(Date.now()); buckets.set(id, b) }
    if (!b.take(Date.now())) { perfCount.dropped += 1; return }
    const m = obj(msg) ? msg : null
    const who = admittedSender(e, m)
    if (typeof who === 'string') { perfCount.refused += 1; trace('refused', { wc: id, ch: 'perf', why: who }); return }
    const v = checkPerf(m!.p)
    if (!v) { perfCount.refused += 1; trace('refused', { wc: id, ch: 'perf', why: 'payload' }); return }
    perfCount.accepted += 1
    for (const fn of [...perfFns]) { try { fn(who.tabId, who.doc, v) } catch (err) { process.stderr.write(`marver-app: a perf listener threw: ${(err as Error).message}\n`) } }
  })
  ipcMain.on(CANVAS_CHANNELS.presented, (e: IpcMainEvent, msg: unknown) => {
    const id = e.sender.id
    const m = obj(msg) ? msg : null
    const who = admittedSender(e, m)
    if (typeof who === 'string') { trace('refused', { wc: id, ch: 'presented', why: who }); return }
    const v = checkPresented(m!.p)
    if (!v) { trace('refused', { wc: id, ch: 'presented', why: 'payload' }); return }
    trace('accepted', { wc: id, ch: 'presented', epoch: v.epoch })
    for (const fn of [...presentedFns]) { try { fn(who.tabId, who.doc, v) } catch (err) { process.stderr.write(`marver-app: a presented listener threw: ${(err as Error).message}\n`) } }
  })
  // A4: the shell's answer to a notice's click (A4.6 #29) - accepted like the reports, journaled, nothing more
  ipcMain.on(CANVAS_CHANNELS.opened, (e: IpcMainEvent, msg: unknown) => {
    const id = e.sender.id
    const m = obj(msg) ? msg : null
    const who = admittedSender(e, m)
    if (typeof who === 'string') { trace('refused', { wc: id, ch: 'opened', why: who }); return }
    const v = checkOpened(m!.p)
    if (!v) { trace('refused', { wc: id, ch: 'opened', why: 'payload' }); return }
    trace('accepted', { wc: id, ch: 'opened', tab: who.tabId, doc: who.doc, id: v.id, result: v.result })
    noticeAnswered(v.id, v.result)   // ends the click's command (spec 30's notice-open)
  })

  /** The tab's bound instance lists `feature` (A4.6 #2), as the registry has it now. */
  const lists = (wcId: number, feature: string): boolean => {
    const t = targetOf(wcId)
    return !!t && (appRegistry()?.byInstance(t.entry.instance) ?? t.entry).features.includes(feature)
  }
  // A4: the first canvas invoke (A4.6 #35) - a live picture of the asking document's own view. Admitted as the reports
  // are, its instance listing `capture`, the rect checked and rounded out here; the readback is live-picture.ts's, with
  // a `still()` that runs this admission again after it
  ipcMain.handle(CANVAS_CHANNELS.capture, async (e: IpcMainInvokeEvent, msg: unknown): Promise<CaptureAnswer> => {
    const id = e.sender.id
    const m = obj(msg) ? msg : null
    const admitted = () => { const w = admittedSender(e, m); return typeof w === 'string' || lists(id, FEATURE.capture) ? w : 'no capture' }
    const who = admitted()
    if (typeof who === 'string') { trace('refused', { wc: id, ch: 'capture', why: who }); return { ok: false, why: 'untrusted' } }
    let view: { width: number; height: number } | null = null
    try { view = o.viewSize?.(who.tabId) ?? null } catch { view = null }
    const rect = checkCaptureRect(m!.p, view)
    if (!rect) { trace('refused', { wc: id, ch: 'capture', why: 'bounds' }); return { ok: false, why: 'bounds' } }
    if (!captureFn) { trace('refused', { wc: id, ch: 'capture', why: 'no handler' }); return { ok: false, why: 'hidden' } }
    const still = () => { const w = admitted(); return typeof w !== 'string' && w.tabId === who.tabId && w.doc === who.doc }
    trace('accepted', { wc: id, ch: 'capture', rect })
    try { return await captureFn(who.tabId, who.doc, rect, still) } catch { return { ok: false, why: 'empty' } }
  })

  // spec 31: a finished deck PDF saved where the person says - admitted as the reports are, its instance listing `pdf`;
  // only the job id crosses, and main fetches the file itself from the origin the document was admitted on
  ipcMain.handle(CANVAS_CHANNELS.exportPdf, async (e: IpcMainInvokeEvent, msg: unknown): Promise<ExportPdfAnswer> => {
    const id = e.sender.id
    const m = obj(msg) ? msg : null
    const admitted = () => { const w = admittedSender(e, m); return typeof w === 'string' || lists(id, FEATURE.pdf) ? w : 'no pdf' }
    const who = admitted()
    if (typeof who === 'string') { trace('refused', { wc: id, ch: 'export-pdf', why: who }); return { ok: false, why: 'untrusted' } }
    const origin = targetOf(id)?.entry.origin
    const p = obj(m!.p) ? m!.p as Record<string, unknown> : null
    if (!origin || !p) { trace('refused', { wc: id, ch: 'export-pdf', why: 'payload' }); return { ok: false, why: 'bad-job' } }
    if (!exportPdfFn) { trace('refused', { wc: id, ch: 'export-pdf', why: 'no handler' }); return { ok: false, why: 'failed' } }
    const still = () => { const w = admitted(); return typeof w !== 'string' && w.tabId === who.tabId && w.doc === who.doc && targetOf(id)?.entry.origin === origin }
    trace('accepted', { wc: id, ch: 'export-pdf' })
    try { return await exportPdfFn({ tabId: who.tabId, doc: who.doc, origin, wc: e.sender, job: p.job }, still) } catch { return { ok: false, why: 'failed' } }
  })

  // app pages
  const pageCtx = (e: IpcMainEvent | IpcMainInvokeEvent, channel: string): PageCtx | null => {
    const r = regs.get(e.sender.id)
    const ok = mayUsePageChannel(channel, r?.kind, sameFrame(e.senderFrame, mainFrameOf(e.sender)), e.senderFrame?.url)
    if (!ok || !r) {
      const m = mainFrameOf(e.sender)
      trace('page-refused', { wc: e.sender.id, channel, kind: r?.kind, main: !!m, same: sameFrame(e.senderFrame, m), sender: safely(() => e.senderFrame ? [e.senderFrame.processId, e.senderFrame.routingId] : null), mainIds: safely(() => m ? [m.processId, m.routingId] : null), url: safely(() => e.senderFrame?.url) })
      return null
    }
    return { wc: r.wc, kind: r.kind, ...(r.tabId ? { tabId: r.tabId } : {}) }
  }
  /**
   * The page funnel (spec 30 #52): one command per message, its handler run as that command's turn (`currentAppCmd`),
   * and ended by the answer unless the work goes on (#49: `pageEnd`). A message refused above never gets here: nobody's
   * input reached anything.
   */
  const pageRun = (channel: string, ctx: PageCtx, value: unknown): unknown => {
    const fn = handlers.get(channel)
    const c = pageCommand(channel, ctx, value)
    if (!c) return fn?.(ctx, value)
    const h = appCmd(c.name, c.o)
    if (c.noop) { h.noop(c.noop); return undefined }
    let out: unknown
    try { out = withAppCmd(h, () => fn?.(ctx, value)) } catch (err) { h.fail('threw'); throw err }
    if (out instanceof Promise) return out.then((v: unknown) => { pageEnd(h, v); return v }, (err: unknown) => { h.fail('threw'); throw err })
    pageEnd(h, out)
    return out
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
        return await pageRun(channel, ctx, p.value)
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
      try { void pageRun(channel, ctx, p.value) } catch (err) { process.stderr.write(`marver-app: ${channel} threw: ${(err as Error).message}\n`) }
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
        buckets.delete(id)
        if (r?.tabId && tabWc.get(r.tabId) === id) tabWc.delete(r.tabId)
      })
      // a shared canvas: recorded for kindOf (its permissions), nothing more - no channel, no document (A4.6 r1 #8)
      if (kind === 'remote') { trace('remote', { wc: id, tab: tabId }); return }
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
    menuClick(tabId, itemId, where) {
      const id = tabWc.get(tabId)
      const rec = id === undefined ? undefined : docs.get(id)
      // an item the page's last mv:menu offers, or one of main's own (the tab's right-click Mark All as Seen)
      const offered = rec?.menu?.some((m) => m.id === itemId) || (APP_MENU_IDS as readonly string[]).includes(itemId)
      if (id === undefined || !rec?.doc || !isTrusted(id) || !offered) return false
      return sendCanvas(id, CANVAS_CHANNELS.menuClick, { doc: rec.doc, id: itemId, ...(where ? { in: where } : {}) })
    },
    reopenNext(tabId) { reopen.add(tabId) },
    reopenCancel(tabId) { reopen.delete(tabId) },
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
    onPerf(fn) { perfFns.add(fn); return () => { perfFns.delete(fn) } },
    perfAsk(tabId, ask) {
      const id = tabWc.get(tabId)
      const rec = id === undefined ? undefined : docs.get(id)
      if (id === undefined || !rec?.doc || !isTrusted(id)) return false
      return sendCanvas(id, CANVAS_CHANNELS.perfAsk, { doc: rec.doc, ...ask })
    },
    onPresented(fn) { presentedFns.add(fn); return () => { presentedFns.delete(fn) } },
    present(tabId, doc, r) {
      const id = tabWc.get(tabId)
      const rec = id === undefined ? undefined : docs.get(id)
      if (id === undefined || !rec?.doc || rec.doc !== doc || !isTrusted(id)) return false
      const sent = sendCanvas(id, CANVAS_CHANNELS.present, { doc, epoch: r.epoch, w: r.w, h: r.h, frames: r.frames })
      trace('present', { wc: id, tab: tabId, epoch: r.epoch, sent })
      return sent
    },
    perfCounts: () => ({ ...perfCount }),
    // A4.6 #29: to the admitted, trusted document of an instance that lists `open`, the item checked as the preload checks it
    openItem(tabId, item) {
      const id = tabWc.get(tabId)
      const rec = id === undefined ? undefined : docs.get(id)
      if (id === undefined || !rec?.doc || !isTrusted(id)) { trace('open', { tab: tabId, sent: false, why: 'not admitted' }); return false }
      if (!targetOf(id)?.entry.features.includes(FEATURE.open)) { trace('open', { wc: id, tab: tabId, sent: false, why: 'no open' }); return false }
      const it = checkOpenItem(item)
      if (!it) { trace('open', { wc: id, tab: tabId, sent: false, why: 'payload' }); return false }
      const sent = sendCanvas(id, CANVAS_CHANNELS.open, { doc: rec.doc, item: it })
      trace('open', { wc: id, tab: tabId, id: it.id, sent })
      return sent
    },
    onCapture(fn) { captureFn = fn; trace('capture-handler', { set: !!captureFn }) },
    onExportPdf(fn) { exportPdfFn = fn; trace('export-pdf-handler', { set: !!exportPdfFn }) },
  }
  return installed
}
