/**
 * The window (spec 28 A2.2, A2.11, A2.13, A2.14 #1, #19, #20, #21, #33, A3.8 #24-#33). Owner: the window stream;
 * the one ground's parts (A3) the one-ground stream's.
 *
 * One `BaseWindow` named `main` (window place: `windowStatePersistence` does nothing without a name). Its stack,
 * bottom to top: the content views (canvases, Home, Settings), the tab pages, the cover, the strip. The strip is
 * transparent and paints controls only (A3.8 #29) - and the still dots while a cover that has it draw them covers
 * (the window snapshot's `dots`, from cover.ts's `stripDraws`: app 0.1's plain view until S15, variant 4 after), so a
 * canvas keeps 0.1's look until S15 chooses a cover. Home, Settings and every tab page run the window's full height
 * and paint the ground and still dots under the strip themselves - in every build, the gate open or shut (A3.8 #32
 * is built ungated: if S15 fails, #3's fallback is the opaque strip, and whether these pages stay at the full height
 * then is Nic's call). So in every 0.2 build a web view lies under the strip's transparent drag region over them,
 * and the strip's dots switch on and off through its renderer at each switch between them and a canvas (a frame of
 * plain ground or doubled dots, longer while the strip is stalled). A canvas runs full height only when its layout
 * says so (layout.ts), else below the strip; the cover - cover.ts's, in the ground of the active tab's look - is
 * shown whenever the active view may not be seen through (plan.ts).
 *
 * **The cover waits for spike S15** (A3.8 #3): until cover.ts makes one, the cover is app 0.1's plain view behind
 * cover.ts's interface, and no canvas is placed full height (layout.ts `setGround(false)`): a plain `View` may be
 * drawn beneath a full-height web view on macOS, and nothing has shown it is not. Over views below the strip it
 * covers by construction - they never overlap it. A test build can turn the gate on (`MARVER_APP_GROUND=1`) to drive
 * main's half of the one ground - the decisions, never the pixels.
 *
 * The presentation (A3.8 #27, #28): before the plan, compose derives the active canvas view's presentation key
 * (present.ts `observe`) - advancing its `gen` when it is shown after being hidden - and the cover lifts only for a
 * see-through view whose latest epoch is answered, with no live resize running; after the turn's view changes it
 * sends that epoch's request once (`flush`). A live resize is a person's drag, `will-resize` to `resized` (or 500 ms
 * of quiet): covered throughout, no request, and at its end every view's `gen` advances.
 *
 * `compose()` is the one writer of bounds and visibility (A2.14 #20): every handler changes the model, then calls
 * it; it derives the plan and applies only what changed, in one turn and in a fixed order - bounds, shows, the
 * cover, focus (A2.13), hides, lifted tab pages closed - then feeds the strip and the pages their snapshots, the
 * pill and the menu. Each `setBounds`, `setVisible`, add and remove goes into the view journal (test builds) with
 * the cover's state, for "in the same turn".
 *
 * App pages get nothing before they say `app:ready`, then every snapshot their kind receives, each with a `rev`
 * per channel; a page that reloads says ready again and gets everything again (A2.14 #19).
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { app, BaseWindow, nativeImage, nativeTheme, screen, View, WebContentsView, type WebContents, type WebPreferences } from 'electron'
import * as sessions from './sessions.ts'
import type { Present } from '../../../src/shared/app-api.ts'
import { CH, type PageKind, type PageFocus, type TabsSnapshot, type TabView, type WindowView } from '../shared/channels.ts'
import { STRIP_HEIGHT, full, ground, plan, type Plan, type PlanTab } from './plan.ts'
import { activeTab, allTabs, darkOf, getTab, ordered, viewOf, type Layout, type Tab } from './tabs.ts'
import { pageFor, snapshotKey, type PageBody } from './tabpage.ts'
import { recompute as recomputePill, onVisibility } from './pill.ts'
import { afterShow, setFocusPorts, track } from './focus.ts'
import { invalidateMenu } from './menu.ts'
import { note, noteTopic, provide, testMode } from './testing/index.ts'
import { T } from './timings.ts'
import { groundOn, onLayoutChange, placed, rectFor, seeThrough, setGround, setInsetOff } from './layout.ts'
import { bumpAll, bumpGen, epochOf, flush as presentFlush, genOf, gpuGone, liftAt, noteGpu, observe, onCoverRecord, onPresentLog, quitting as presentQuitting, showing, uncovered, windowHidden, windowShown } from './present.ts'
import { identity, recorder } from './recorder.ts'
import type { TabIdent } from '../../../src/shared/app-perf.ts'
import { makeCover, type Cover } from './cover.ts'

export { STRIP_HEIGHT }

/** the traffic lights centred in the 44 px strip (research c S1) */
const LIGHTS = { x: 14, y: 14 }
export const PRELOAD_APP = join(__dirname, 'preload-app.cjs')
export const APP_ORIGIN = 'marver-app://'

/** What the window needs from the rest of main: the bridge's registry and each view's wiring (keys, focus, pinning). */
export interface WindowDeps {
  register(wc: WebContents, kind: PageKind, tabId?: string): void
  /** keys (before-input-event), and anything else every app view gets */
  wire(wc: WebContents, kind: PageKind, tabId?: string): void
  /** the window's red button and ⇧⌘W hide it; the quit itself is main.ts's guarded quit */
  quitting(): boolean
  /** the bridge's send (it checks the page is ready and on its pinned document); else main sends itself */
  send?(wc: WebContents, channel: string, payload: unknown): boolean
  /** A3: `mv:present` to a tab's admitted document (bridge.ts `present`): compose's request after the turn's view changes (A3.8 #27) */
  present?(tabId: string, doc: string, r: Present): boolean
  /** A3: after each compose, once its changes are applied - the recorder's `tab` lines (A3.8 #9) */
  afterCompose?(): void
}

let win: BaseWindow | null = null
let cover: Cover | null = null
let strip: WebContentsView | null = null
let deps: WindowDeps | null = null
let turn = 0

const j = (topic: string, data: unknown) => { if (__MV_TEST__) note(topic, data) }

/**
 * The app pages' preferences: sandboxed, isolated, no dialogs, the app preload, on persist:app (A2.5, A2.14 #14) -
 * sessions.ts's `appWebPreferences()` when the trust stream provides it (the one place it writes them), else these.
 */
export const appPrefs = (): WebPreferences => {
  const fromTrust = (sessions as { appWebPreferences?: () => WebPreferences }).appWebPreferences
  return fromTrust ? { ...fromTrust(), spellcheck: false } : {
    partition: 'persist:app', preload: PRELOAD_APP, sandbox: true, contextIsolation: true, nodeIntegration: false,
    webviewTag: false, spellcheck: false, disableDialogs: true,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The view registry: content views by tab, tab pages by tab

const content = new Map<string, { view: WebContentsView; kind: PageKind }>()
interface PageHandle { view: WebContentsView; tab: string; rev: number; sent?: string; body: PageBody | null; closing: boolean; closeTimer?: ReturnType<typeof setTimeout> }
const pages = new Map<string, PageHandle>()
/** what compose() last applied, by plan key */
const applied = new Map<string, { r: string; vis: boolean; color: string }>()
let coverWas = { visible: false, color: '' }

export const mainWindow = (): BaseWindow | null => win
export const stripContents = (): WebContents | undefined => strip && !strip.webContents.isDestroyed() ? strip.webContents : undefined
export const contentView = (tabId: string): WebContentsView | undefined => content.get(tabId)?.view
export const pageView = (tabId: string): WebContentsView | undefined => pages.get(tabId)?.view

/** A content view (canvas, Home, Settings) goes beneath the tab pages, hidden until compose shows it. Never re-added. */
export function attachContent(tabId: string, view: WebContentsView, kind: PageKind): void {
  if (!win) throw new Error('window.ts: no window')
  if (content.get(tabId)?.view === view) return
  view.setVisible(false)
  const t = getTab(tabId)
  view.setBackgroundColor(ground(darkOf(t, nativeTheme.shouldUseDarkColors)))
  const { width, height } = win.getContentBounds()
  view.setBounds(t ? rectFor(t, width, height) : rectFor('app-page', width, height))
  win.contentView.addChildView(view, 0)
  content.set(tabId, { view, kind })
  applied.delete(`${tabId}:view`)
  if (kind !== 'canvas') registerApp(view.webContents, kind)
  j('view', { turn, op: 'add', key: `${tabId}:view`, kind })
}

/** Take a content view out of the window (its webContents is closed by its owner). */
export function detachContent(tabId: string): void {
  const c = content.get(tabId)
  if (!c) return
  content.delete(tabId)
  applied.delete(`${tabId}:view`)
  try { win?.contentView.removeChildView(c.view) } catch { /* the window is going */ }
  j('view', { turn, op: 'remove', key: `${tabId}:view` })
}

// ---------------------------------------------------------------------------------------------------------------
// App page snapshots (A2.14 #19)

const ready = new WeakSet<WebContents>()
const kindOf = new WeakMap<WebContents, PageKind>()
/** messages a page gets once it says ready, the latest of each channel (page:focus, home:focus) */
const heldFor = new WeakMap<WebContents, Map<string, unknown>>()
const revs = { tabs: 0, window: 0 }
let lastTabs = ''
let lastWindow = ''
let tabsBody: Omit<TabsSnapshot, 'rev'> | null = null
let windowBody: Omit<WindowView, 'rev'> | null = null
/** the pill main chose, null for none; undefined until pill.ts first chose (the strip gets its first `pill` even when null) */
let pillBody: unknown = undefined

function send(wc: WebContents | undefined, channel: string, payload: unknown): void {
  if (!wc || wc.isDestroyed() || !ready.has(wc)) return
  if (deps?.send) deps.send(wc, channel, payload)
  else { try { wc.send(channel, payload) } catch { /* its renderer went: sent again at its next app:ready */ } }
}

/** Every app page's webContents main made, with its kind. */
function appPages(): WebContents[] {
  const out: WebContents[] = []
  const s = stripContents()
  if (s) out.push(s)
  for (const c of content.values()) if (c.kind !== 'canvas' && !c.view.webContents.isDestroyed()) out.push(c.view.webContents)
  for (const h of pages.values()) if (!h.view.webContents.isDestroyed()) out.push(h.view.webContents)
  return out
}

/** `app:ready` from an app page (the bridge checked its sender): every snapshot of its kind, now. */
export function onAppReady(wc: WebContents): void {
  const kind = kindOf.get(wc)
  if (!kind || kind === 'canvas') return
  ready.add(wc)
  j('page', { ready: kind })
  if (windowBody) send(wc, CH.window, { rev: revs.window, ...windowBody })
  if ((kind === 'strip' || kind === 'home') && tabsBody) send(wc, CH.tabs, { rev: revs.tabs, ...tabsBody })
  // the first pill even when it is null: the strip takes the first tabs and the first pill after ready as the state
  // found at launch and announces neither (pages/strip)
  if (kind === 'strip' && pillBody !== undefined) send(wc, CH.pill, pillBody)
  if (kind === 'tabpage') {
    const h = [...pages.values()].find((x) => x.view.webContents === wc)
    if (h?.body) send(wc, CH.tabpage, { rev: h.rev, ...h.body })   // the latest, under the rev it already has
  }
  const held = heldFor.get(wc)
  if (held) { heldFor.delete(wc); for (const [ch, p] of held) send(wc, ch, p) }
}

function registerApp(wc: WebContents, kind: PageKind, tabId?: string): void {
  kindOf.set(wc, kind)
  deps?.register(wc, kind, tabId)
  deps?.wire(wc, kind, tabId)
  // a page that reloads (or whose renderer went) says ready again before it gets anything - from the commit of its
  // new document, as the bridge counts it (bridge.ts register): did-start-navigation also fires for a navigation
  // the policy then refuses, and the page that stays has said ready already, so it would get nothing again
  wc.on('did-navigate', () => ready.delete(wc))
  wc.on('did-fail-provisional-load', (_e, _code, _d, _url, isMain) => { if (isMain) ready.delete(wc) })
  wc.on('render-process-gone', () => ready.delete(wc))
}

/** A message to one app page now, or held (the latest of its channel) until the page says ready. */
export function sendHeld(wc: WebContents, channel: string, payload: unknown): void {
  if (wc.isDestroyed()) return
  if (ready.has(wc)) { send(wc, channel, payload); return }
  const m = heldFor.get(wc) ?? new Map<string, unknown>()
  m.set(channel, payload)
  heldFor.set(wc, m)
}

/** `page:focus`, held until the page says ready (A2.13). */
export function sendPageFocus(wc: WebContents, f: PageFocus): void { sendHeld(wc, CH.pageFocus, f) }

/** The strip's `pill` (pill.ts chose it). */
export function sendPill(v: unknown): void {
  pillBody = v
  send(stripContents(), CH.pill, v)
}

function feedTabs(): void {
  const a = activeTab()
  const home = homedir()
  const list = allTabs()
  const open = ordered(list)
  const closedLocals = list.filter((t) => t.kind === 'local' && !t.open)
  const views: TabView[] = [...open, ...closedLocals].map((t) => viewOf(t, t === a, home, list))
  const body = { active: a?.id ?? 'home', tabs: views }
  const s = JSON.stringify(body)
  if (s === lastTabs) return
  lastTabs = s
  tabsBody = body
  revs.tabs += 1
  const snap: TabsSnapshot = { rev: revs.tabs, ...body }
  send(stripContents(), CH.tabs, snap)
  send(content.get('home')?.view.webContents, CH.tabs, snap)
}

function feedWindow(): void {
  if (!win) return
  // the strip's still dots while a cover that has the strip draw them covers (app 0.1's plain view until S15, A3.8 #3;
  // variant 4 after): a canvas keeps 0.1's look under the tabs; over Home, Settings and a tab page the cover is hidden
  // and the page's own dots show there
  const body = { focused: win.isFocused(), fullScreen: win.isFullScreen(), dots: !!cover?.stripDraws && coverWas.visible }
  const s = JSON.stringify(body)
  if (s === lastWindow) return
  lastWindow = s
  windowBody = body
  revs.window += 1
  for (const wc of appPages()) send(wc, CH.window, { rev: revs.window, ...body })
}

// ---------------------------------------------------------------------------------------------------------------
// Tab pages (A2.11, A2.14 #21): only for the active tab; a hidden tab's closed 30 s after it was hidden

function createPage(t: Tab): PageHandle {
  const view = new WebContentsView({ webPreferences: appPrefs() })
  view.setBackgroundColor(ground(darkOf(t, nativeTheme.shouldUseDarkColors)))   // ground before its words paint
  view.setVisible(false)
  const h: PageHandle = { view, tab: t.id, rev: 0, body: null, closing: false }
  registerApp(view.webContents, 'tabpage', t.id)
  track(view.webContents, { part: 'page', tab: t.id })
  view.webContents.on('render-process-gone', () => { if (pages.get(t.id) === h) { closePage(t.id); compose() } })   // made again by the next compose
  const { width, height } = win!.getContentBounds()
  view.setBounds(full(width, height))   // the window's full height: it paints the ground under the strip (A3.8 #32)
  // above the content views, beneath the cover (when it is a view) and the strip
  win!.contentView.addChildView(view, Math.max(0, win!.contentView.children.length - (cover?.view ? 2 : 1)))
  void view.webContents.loadURL(`${APP_ORIGIN}tabpage/`).catch(() => { /* served by sessions.ts; a failure leaves its ground */ })
  pages.set(t.id, h)
  j('view', { turn, op: 'add', key: `${t.id}:page`, kind: 'tabpage' })
  return h
}

function closePage(tabId: string): void {
  const h = pages.get(tabId)
  if (!h) return
  pages.delete(tabId)
  applied.delete(`${tabId}:page`)
  if (h.closeTimer) clearTimeout(h.closeTimer)
  try { win?.contentView.removeChildView(h.view) } catch { /* the window is going */ }
  if (!h.view.webContents.isDestroyed()) h.view.webContents.close()
  j('view', { turn, op: 'remove', key: `${tabId}:page` })
}

/** The page's snapshot, when it changed (no clock in it: time passing never bumps the rev under a button). */
function sendTabpage(h: PageHandle): void {
  if (!h.body) return
  const s = snapshotKey(h.body)
  if (s === h.sent) return
  h.rev += 1
  h.sent = s
  send(h.view.webContents, CH.tabpage, { rev: h.rev, ...h.body })
}

/** The tab a tab page belongs to (registered with it, as createPage does); other app pages none. */
function tabOfPage(wc: WebContents): string | undefined {
  for (const h of pages.values()) if (h.view.webContents === wc) return h.tab
  return undefined
}

/** The latest rev main sent a tab page view, and its tab - for `tabpage:action`'s check. */
export function pageOf(wc: WebContents): { tab: string; rev: number; body: PageBody | null } | undefined {
  for (const h of pages.values()) if (h.view.webContents === wc) return { tab: h.tab, rev: h.rev, body: h.body }
  return undefined
}

function syncPages(now: number): void {
  const a = activeTab()
  for (const t of allTabs()) {
    if (t.kind !== 'local') continue
    const body = pageFor(t, now)
    let h = pages.get(t.id)
    if (!body) { if (h) h.closing = true; continue }
    if (!h) { if (t !== a) continue; h = createPage(t) }
    h.closing = false
    h.body = body
    if (t !== a) {
      if (!h.closeTimer) h.closeTimer = setTimeout(() => { const x = pages.get(t.id); if (x === h && getTab(t.id) !== activeTab()) { closePage(t.id); compose() } }, T.tabPageCloseMs)
    } else if (h.closeTimer) { clearTimeout(h.closeTimer); h.closeTimer = undefined }
    sendTabpage(h)
  }
  for (const [id, h] of pages) if (!getTab(id)) h.closing = true
}

// ---------------------------------------------------------------------------------------------------------------
// compose(): plan, then apply

let composing = false
let again: { focus?: 'shown' } | null = null
/** the plan compose() last derived: what shows now, or is about to in this turn */
let lastPlan: Plan | null = null
const shownNow = (key: string): boolean => !!lastPlan?.views.find((v) => v.key === key)?.visible

export function compose(o: { focus?: 'shown' } = {}): void {
  if (!win || win.isDestroyed()) return
  if (composing) { again = { focus: again?.focus ?? o.focus }; return }
  composing = true
  try {
    let next: { focus?: 'shown' } | null = o
    while (next) { again = null; composeOnce(next); next = again }
  } finally { composing = false }
}

/** The tab's own page shows over it this turn (A2.11). */
const pageShows = (t: Tab): boolean => { const h = pages.get(t.id); return !!h && !h.closing && !!h.body }

function planTab(t: Tab, appDark: boolean, presented: boolean): PlanTab {
  const h = pages.get(t.id)
  return {
    id: t.id, kind: t.kind, view: content.has(t.id), page: !!h && !h.closing && !!h.body, pageView: !!h,
    dark: darkOf(t, appDark), placed: placed(t), seeThrough: seeThrough(t), presented,
  }
}

// ---- the one ground's state: a live resize, the lift's delay ----

/** a person's live resize, `will-resize` .. `resized` (or the quiet timer) */
let resizing = false
let quietTimer: ReturnType<typeof setTimeout> | undefined
let liftTimer: ReturnType<typeof setTimeout> | undefined
/** each tab's current epoch and the tab's identity when it began: its `cover` record names that document (A3.8 #8) */
const epochIdent = new Map<string, { epoch: number; who: TabIdent }>()

function armQuiet(): void {
  clearTimeout(quietTimer)
  quietTimer = setTimeout(() => endLiveResize('quiet'), T.liveResizeQuietMs)
}
function startLiveResize(): void {
  armQuiet()
  if (resizing) return
  resizing = true
  if (__MV_TEST__) noteTopic('resize', { live: true, via: 'will-resize' })
  compose()
}
/** The drag ended: what was presented no longer counts - every view's gen advances, and one request follows (A3.8 #28). */
function endLiveResize(via: 'resized' | 'quiet'): void {
  if (!resizing) return
  resizing = false
  clearTimeout(quietTimer)
  bumpAll()
  if (__MV_TEST__) noteTopic('resize', { live: false, via })
  compose()
}

function viewFor(key: string): WebContentsView | undefined {
  const [id, part] = key.split(':')
  return part === 'page' ? pages.get(id!)?.view : content.get(id!)?.view
}

function composeOnce(o: { focus?: 'shown' }): void {
  turn += 1
  const now = Date.now()
  syncPages(now)
  const { width: w, height: h } = win!.getContentBounds()
  const appDark = nativeTheme.shouldUseDarkColors
  const a = activeTab()
  // 0. the presentation, before the plan (A3.8 #27): the active canvas view's key, from the model as it is now. A view
  // shown after being hidden advances its gen; any shown view with an admitted document has a key (so leaving HTML
  // fullscreen, or a hello, is a fresh epoch); only a see-through one asks and may lift the cover
  let presented = false
  let eligible = false
  let observed = false
  if (a?.kind === 'local' && content.has(a.id) && !pageShows(a)) {
    if (!applied.get(`${a.id}:view`)?.vis) bumpGen(a.id)
    const doc = a.doc?.trusted && a.doc.lifted ? a.doc.doc : undefined
    if (doc) {
      observed = true
      const r = rectFor(a, w, h)
      presented = observe(a.id, { doc, w: r.width, h: r.height, fs: a.geo.htmlFullscreen, gen: genOf(a.id) }, now)
      const e = epochOf(a.id)
      if (e !== null && epochIdent.get(a.id)?.epoch !== e) epochIdent.set(a.id, { epoch: e, who: identity(a) })
      eligible = seeThrough(a)
      // a lift waiting on uncoverDelayMs: compose again then
      const at = liftAt(a.id)
      if (eligible && !presented && at !== null && at > now) { clearTimeout(liftTimer); liftTimer = setTimeout(() => compose(), at - now + 1) }
    }
  }
  // no view observed this turn (Home, Settings, a tab page, a document not presentable): the one shown before ends
  // its sent epoch's record as hidden, and its replies are refused from now (A3.8 #27)
  if (!observed) showing(null, now)
  for (const id of epochIdent.keys()) if (epochOf(id) === null) epochIdent.delete(id)   // its view forgotten
  const p: Plan = plan({ tabs: allTabs().map((t) => planTab(t, appDark, t === a && eligible && presented)), active: a?.id ?? 'home', w, h, appDark, resizing })
  lastPlan = p
  const changes: unknown[] = []
  // 1. bounds, shown or hidden, and each view's ground
  for (const v of p.views) {
    const view = viewFor(v.key)
    if (!view) continue
    const prev = applied.get(v.key)
    const r = `${v.rect.x},${v.rect.y},${v.rect.width},${v.rect.height}`
    if (prev?.r !== r) { view.setBounds(v.rect); changes.push({ key: v.key, op: 'bounds', rect: v.rect }) }
    if (prev?.color !== v.color) view.setBackgroundColor(v.color)
    applied.set(v.key, { r, vis: prev?.vis ?? false, color: v.color })
  }
  // 2. shows
  for (const v of p.views) {
    const a = applied.get(v.key)
    const view = viewFor(v.key)
    if (!a || !view) continue
    if (v.visible && !a.vis) { view.setVisible(true); a.vis = true; changes.push({ key: v.key, op: 'visible', visible: true }) }
  }
  // 3. the cover and the strip, on top - the cover in the same turn as the views beneath (A3.8 #30)
  cover!.setRect(p.cover.rect)
  strip!.setBounds(p.strip)
  if (p.cover.color !== coverWas.color) { cover!.setLook(p.cover.dark); win!.setBackgroundColor(p.cover.color) }
  if (p.cover.visible !== coverWas.visible) {
    cover!.setVisible(p.cover.visible)
    changes.push({ key: 'cover', op: 'visible', visible: p.cover.visible })
    if (!p.cover.visible && a && eligible) {
      uncovered(a.id, now)
      if (__MV_TEST__) noteTopic('present', { tab: a.id, op: 'uncover', epoch: epochOf(a.id) ?? 0, gen: genOf(a.id) })
    }
  }
  coverWas = { visible: p.cover.visible, color: p.cover.color }
  // 4. focus, before the hides: what the active tab shows now holds it (A2.13)
  afterShow(o.focus)
  // 5. hides
  for (const v of p.views) {
    const a = applied.get(v.key)
    const view = viewFor(v.key)
    if (!a || !view) continue
    if (!v.visible && a.vis) { view.setVisible(false); a.vis = false; changes.push({ key: v.key, op: 'visible', visible: false }) }
  }
  // 6. lifted tab pages, closed after the canvas view shows
  for (const [id, hp] of [...pages]) if (hp.closing) closePage(id)
  // a document the person can see is retained: it may hold their work (v1.13 r2 #3)
  if (a?.kind === 'local' && a.doc && a.doc.lifted && applied.get(`${a.id}:view`)?.vis) { a.doc.shown = true; a.retained = true }
  // 7. after the views changed in this turn: the request goes out, so it reaches a view already shown and sized
  // (A3.8 #27) - never during a live resize, and never while the window cannot draw (present.ts holds it until the
  // window's show); a send that fails is retried by the next compose
  if (a && eligible && !resizing && deps?.present) presentFlush(a.id, (doc, r) => deps!.present!(a.id, doc, r), T.presentFrames)
  if (__MV_TEST__ && changes.length) {
    const layouts: Record<string, Layout> = {}
    for (const t of allTabs()) if (t.kind === 'local' && content.has(t.id)) layouts[t.id] = placed(t)
    noteTopic('compose', { turn, active: p.active, w, h, cover: coverWas, changes, resizing, layouts })
  }
  feedTabs()
  feedWindow()
  recomputePill()
  invalidateMenu()
  deps?.afterCompose?.()
}

/** Every view's bounds and visibility as Electron reports them now (test builds read it). */
export function viewsNow(): { key: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean }[] {
  const out: { key: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean }[] = []
  for (const [id, c] of content) out.push({ key: `${id}:view`, bounds: c.view.getBounds(), visible: c.view.getVisible() })
  for (const [id, h] of pages) out.push({ key: `${id}:page`, bounds: h.view.getBounds(), visible: h.view.getVisible() })
  if (cover?.view) out.push({ key: 'cover', bounds: cover.view.getBounds(), visible: cover.view.getVisible() })
  if (strip) out.push({ key: 'strip', bounds: strip.getBounds(), visible: strip.getVisible() })
  return out
}

/** A reconstructed app-content picture (A3.8 #14): each visible view as main stacks them, the cover as cover.ts draws it - never the screen. */
export interface AppPicture { png: Buffer; width: number; height: number; scale: number; layers: string[] }

/** Why captureApp took no picture (flashes.ts reads `why`). */
export class PictureRefused extends Error {
  readonly why: 'window hidden' | 'no window' | 'empty'
  constructor(why: 'window hidden' | 'no window' | 'empty') { super(`no picture: ${why}`); this.why = why }
}

/**
 * A3: Mark a Flash's picture (A3.3, A3.8 #14) - `captureWindow()` built into the release and scaled to `width` px
 * (480 for a flash). It refuses with 'window hidden' when the window is not visible. FROZEN signature (A3.8 #53):
 * the flash stream fills it, the one-ground stream draws its cover through cover.ts's `bitmap()`.
 *
 * Each layer is scaled before it is blended, so a 480 px picture never builds a full-resolution buffer: one
 * `capturePage()` per visible web view (a full readback each, 7-10 ms, S4), one resize, one blend. It is a picture of
 * what main stacked, not of the screen: no traffic lights, and a flash that happens in the compositor may not be in
 * it (the docs call it so; screen evidence is ScreenCaptureKit's, in tests only).
 */
export async function captureApp(o: { width?: number } = {}): Promise<AppPicture> {
  if (!win || win.isDestroyed()) throw new PictureRefused('no window')
  if (!windowVisible()) throw new PictureRefused('window hidden')
  const { drew, ...pic } = await composite(o.width)
  if (!drew) throw new PictureRefused('empty')
  return pic
}

/**
 * Test builds: a picture of the window's content area as the person sees it - every shown view, bottom to top, each
 * from its own `capturePage()` (the cover a plain fill of its ground), composited at the display's scale. The
 * traffic lights are AppKit's, outside any view, so they are not in it. Main's view stack is the one source: what
 * the picture holds is exactly what compose() left shown.
 */
export async function captureWindow(): Promise<AppPicture> {
  if (!win || win.isDestroyed()) throw new Error('window.ts: no window')
  const { drew: _drew, ...pic } = await composite()
  return pic
}

/** Every visible view of the window, bottom to top, `width` px wide (default: at the display's scale). */
async function composite(width?: number): Promise<AppPicture & { drew: boolean }> {
  const w0 = win!
  const { width: W, height: H } = w0.getContentBounds()
  const dsf = screen.getDisplayMatching(w0.getBounds()).scaleFactor || 1
  // sf: the picture's px per window point - the display's scale, or a picture of its own width (a flash's 480 px).
  // Every layer is drawn at it, the cover's bitmap too (cover.ts `bitmap(w, h, sf)`): never the display's scale
  // with a width at the picture's
  const sf = width && width > 0 ? width / Math.max(1, W) : dsf
  const PW = Math.max(1, Math.round(W * sf))
  const PH = Math.max(1, Math.round(H * sf))
  const out = Buffer.alloc(PW * PH * 4)   // BGRA, premultiplied (Skia's N32 on this Mac)
  const fill = (x0: number, y0: number, w: number, h: number, hex: string) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex)
    if (!m) return
    const [r, g, b] = [m[1], m[2], m[3]].map((c) => parseInt(c!, 16))
    for (let y = Math.max(0, y0); y < Math.min(PH, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(PW, x0 + w); x++) { const i = (y * PW + x) * 4; out[i] = b!; out[i + 1] = g!; out[i + 2] = r!; out[i + 3] = 255 }
    }
  }
  const blend = (bmp: Buffer, bw: number, bh: number, x0: number, y0: number) => {
    for (let y = 0; y < bh; y++) {
      const oy = y0 + y
      if (oy < 0 || oy >= PH) continue
      for (let x = 0; x < bw; x++) {
        const ox = x0 + x
        if (ox < 0 || ox >= PW) continue
        const si = (y * bw + x) * 4
        const di = (oy * PW + ox) * 4
        const a = bmp[si + 3]!
        if (a === 255) { out[di] = bmp[si]!; out[di + 1] = bmp[si + 1]!; out[di + 2] = bmp[si + 2]!; out[di + 3] = 255; continue }
        if (a === 0) continue
        const kk = (255 - a) / 255
        for (let c = 0; c < 4; c++) out[di + c] = Math.min(255, Math.round(bmp[si + c]! + out[di + c]! * kk))
      }
    }
  }
  fill(0, 0, PW, PH, coverWas.color || '#000000')
  const layers: string[] = []
  let drew = false
  for (const child of w0.contentView.children) {
    if (!child.getVisible()) continue
    const b = child.getBounds()
    const x0 = Math.round(b.x * sf)
    const y0 = Math.round(b.y * sf)
    const bw = Math.round(b.width * sf)
    const bh = Math.round(b.height * sf)
    if (bw <= 0 || bh <= 0) continue
    // the cover as cover.ts draws it, whatever view it is; a web-view cover with no bitmap of its own (S15's variant 3)
    // falls through to its capture, a plain one to a fill of its ground
    const own = child === cover?.view ? cover.bitmap(bw, bh, sf) : null
    if (own && own.length === bw * bh * 4) { blend(own, bw, bh, x0, y0); layers.push(`cover (bitmap) @${b.x},${b.y} ${b.width}x${b.height}`); continue }
    if (child instanceof WebContentsView) {
      if (child.webContents.isDestroyed()) continue
      let img = await child.webContents.capturePage()
      if (img.isEmpty()) { layers.push(`${child.webContents.getURL()} (empty)`); continue }
      // at the display's scale the capture is the layer as it is; a picture of another width scales it first
      let bmp = width ? Buffer.alloc(0) : img.toBitmap({ scaleFactor: dsf })
      if (bmp.length !== bw * bh * 4) { img = img.resize({ width: bw, height: bh, quality: width ? 'good' : 'best' }); bmp = img.toBitmap() }
      if (bmp.length !== bw * bh * 4) { const z = img.getSize(); layers.push(`${child.webContents.getURL()} (size ${z.width}x${z.height})`); continue }
      blend(bmp, bw, bh, x0, y0)
      drew = true
      layers.push(`${child.webContents.getURL()} @${b.x},${b.y} ${b.width}x${b.height}`)
    } else {
      // app 0.1's plain view, or a cover whose bitmap is null: a fill of its ground
      fill(x0, y0, bw, bh, coverWas.color)
      layers.push(`cover ${coverWas.color} @${b.x},${b.y} ${b.width}x${b.height}`)
    }
  }
  const png = nativeImage.createFromBitmap(out, { width: PW, height: PH, scaleFactor: 1 }).toPNG()
  return { png, width: PW, height: PH, scale: sf, layers, drew }
}

// ---------------------------------------------------------------------------------------------------------------
// The window itself

/**
 * The window, once. views.ts's startViews calls it with the deps; a call made earlier without them (main.ts of
 * another stream's merge) makes the window, and the later call binds the deps and registers and wires every app
 * page already made - so no page goes unregistered with the bridge or without its keys, whichever call came first.
 */
export function openWindow(d?: WindowDeps): BaseWindow {
  if (win) {
    if (d && !deps) {
      deps = d
      for (const wc of appPages()) { const kind = kindOf.get(wc); if (kind) { d.register(wc, kind, tabOfPage(wc)); d.wire(wc, kind, tabOfPage(wc)) } }
    }
    return win
  }
  deps = d ?? null
  const dark = nativeTheme.shouldUseDarkColors
  win = new BaseWindow({
    name: 'main', windowStatePersistence: true,
    width: 1280, height: 820, minWidth: 720, minHeight: 480,
    titleBarStyle: 'hidden', trafficLightPosition: LIGHTS,
    backgroundColor: ground(dark), show: false, title: 'Marver',
  })
  // the strip first, so a cover can use it (S15's variant 4 colours its native background); added last, on top
  strip = new WebContentsView({ webPreferences: appPrefs() })
  strip.setBackgroundColor('#00000000')   // transparent: it paints controls only, over the cover or the views beneath (A3.8 #29)
  // the cover S15 chose (cover.ts), else app 0.1's plain view - and with it no canvas at full height (A3.8 #3)
  let chosen: Cover | null = null
  try { chosen = makeCover(win, strip) } catch (err) { j('cover', { s15: String((err as Error)?.message ?? err) }) }
  cover = chosen ?? plainCover()
  setGround(!!chosen || (__MV_TEST__ && testMode() && process.env.MARVER_APP_GROUND === '1'))
  j('cover', { chosen: !!chosen, ground: groundOn() })
  cover.setLook(dark)
  cover.setVisible(true)
  coverWas = { visible: true, color: ground(dark) }
  if (__MV_TEST__) {
    onLayoutChange((d) => noteTopic('layout', d))
    onPresentLog((d) => noteTopic('present', d))
  }
  // each sent epoch's outcome, for tuning presentFrames and uncoverDelayMs (A3.8 #27): the recorder's `cover` line
  onCoverRecord((tab, epoch, body) => {
    const kept = epochIdent.get(tab)
    const t = getTab(tab)
    const who = kept?.epoch === epoch ? kept.who : t ? identity(t) : { tab }
    if (__MV_TEST__) note('cover-record', { ...who, ...body })
    try { recorder.event('cover', who, body) } catch { /* the recorder's to keep; the window goes on */ }
  })
  registerApp(strip.webContents, 'strip')
  track(strip.webContents, { part: 'strip' })
  strip.webContents.on('render-process-gone', () => {
    // the cover stays, showing ground; the strip comes back
    j('strip', { gone: true })
    setTimeout(() => { if (strip && !strip.webContents.isDestroyed()) void strip.webContents.loadURL(`${APP_ORIGIN}strip/`).catch(() => {}) }, 0)
  })
  if (cover.view) win.contentView.addChildView(cover.view)
  win.contentView.addChildView(strip)
  void strip.webContents.loadURL(`${APP_ORIGIN}strip/`).catch(() => { /* served by sessions.ts */ })

  setFocusPorts({
    active: () => activeTab()?.id,
    strip: () => stripContents(),
    // what the plan being applied shows (focus runs between the shows and the hides)
    content: (id) => { const c = content.get(id); return c && shownNow(`${id}:view`) ? c.view.webContents : undefined },
    page: (id) => { const h = pages.get(id); return h && !h.closing && h.body && shownNow(`${id}:page`) ? h.view.webContents : undefined },
    pageFocus: sendPageFocus,
    log: (t, data) => j(t, data),
  })

  const deferred = () => setTimeout(() => compose(), 0)
  // a live resize is a person's drag (A3.8 #28): macOS sends will-resize only for one, and resized at its end; a
  // full-screen transition, the window place restored and a test's setContentSize send only resize
  win.on('will-resize', () => startLiveResize())
  win.on('resized', () => endLiveResize('resized'))
  win.on('resize', () => { if (resizing) armQuiet(); compose(); deferred() })
  win.on('enter-full-screen', () => { compose(); deferred() })
  win.on('leave-full-screen', () => { compose(); deferred() })
  win.on('focus', () => feedWindow())
  win.on('blur', () => feedWindow())
  for (const ev of ['show', 'hide', 'minimize', 'restore'] as const) win.on(ev as 'show', () => { onVisibility(); feedWindow() })
  // the window hidden (on macOS also covered entirely: Electron 45 emits hide and show from its occlusion state alone):
  // the shown view's open epoch ends its record now, and no request goes out while its pages draw nothing (A3.8 #27).
  // Shown again, compose sends the epoch held meanwhile, its times starting then. Made hidden, it cannot draw until
  // showWindow shows it: a window made with show: false sends no show when it first appears (its occlusion state
  // never changed), so showWindow says so itself
  windowHidden(Date.now())
  win.on('hide', () => windowHidden(Date.now()))
  win.on('minimize', () => windowHidden(Date.now()))
  win.on('show', () => { if (windowShown(Date.now())) compose() })
  win.on('restore', () => { if (windowShown(Date.now())) compose() })
  // quitting: every open epoch's record, before the recorder's last write (main.ts's will-quit flushSync)
  app.prependListener('will-quit', () => presentQuitting(Date.now()))
  win.on('close', (e) => {
    // ⇧⌘W and the red button hide the window: the views stay as they are (A2.2)
    if (deps?.quitting()) return
    e.preventDefault()
    win?.hide()
  })
  win.on('closed', () => { win = null })
  nativeTheme.on('updated', () => compose())
  if (__MV_TEST__) groundHooks()
  compose()
  return win
}

/**
 * App 0.1's cover - one plain `View`, its background the ground - behind cover.ts's interface, until S15 picks one
 * (A3.8 #3). It is not S15's variant 1: whether a plain view can sit over a full-height web view is the spike's
 * question, so with this one no canvas is placed full height (`setGround`), and it only ever sits over nothing.
 */
function plainCover(): Cover {
  const view = new View()
  return {
    view,
    stripDraws: true,
    contents: () => null,
    setRect: (r) => view.setBounds(r),
    setVisible: (v) => view.setVisible(v),
    setLook: (d) => view.setBackgroundColor(ground(d)),
    bitmap: () => null,
  }
}

/**
 * The one ground's test hooks (dev builds, MARVER_APP_TEST=1): a live resize's events, the GPU process lost, replaced
 * or killed, the scroll edge's cost switch, the strip's heartbeat and its empty regions (the capture matrix's, A3.8
 * #34: read from the strip itself, never guessed). The matrix's case 15 load - a heavy board panning in a second
 * window on the same GPU process (`loadWindow`) - is the native acceptance stream's, with its heavy board.
 */
function groundHooks(): void {
  const arg = <A>(a: unknown) => (a ?? {}) as A
  // will-resize / resized / resize as macOS sends them for a person's drag (a test cannot drag the window's corner)
  provide('ground:emit', (a) => {
    const ev = arg<{ event: string }>(a).event
    if (!win || !['will-resize', 'resized', 'resize'].includes(ev)) return false
    win.emit(ev as 'resize', { preventDefault() {}, defaultPrevented: false }, win.getBounds(), { edge: 'bottom-right' })
    return true
  })
  // the scroll edge's cost (A3.8 #51): every document told 0 from now on (its next load), so the same board pans
  // without the inset. Its confound, for whoever reads the numbers: a document told 0 applies no inset and its hello
  // moves it below the strip (layout.ts), so the run without the band also paints a viewport 44 px shorter - the A/B
  // is TOP 44 at the full height against TOP 0 at h - 44, which can only make the band look dearer than it is
  provide('ground:inset-off', (a) => { setInsetOff(!!arg<{ on?: boolean }>(a).on); return true })
  // child-process-gone with type GPU, as views.ts hears it - no process is killed
  provide('ground:gpu-lost', () => { gpuGone(); compose(); return true })
  // the GPU process killed for real (SIGKILL: no crash report, no dialog): Electron's child-process-gone and the
  // replacement's gpu-info-update reach views.ts's own handlers. Its identity before, or null with none
  provide('ground:gpu-kill', () => {
    const m = app.getAppMetrics().find((x) => x.type === 'GPU')
    if (!m) return null
    process.kill(m.pid, 'SIGKILL')
    return { pid: m.pid, born: m.creationTime }
  })
  // an identity read (a sample, a gpu-info-update): a replacement with no child-process-gone
  provide('ground:gpu', (a) => { const id = arg<{ id?: { pid: number; born: number } | null }>(a).id ?? null; const changed = noteGpu(id); if (changed) compose(); return changed })
  provide('ground:state', () => ({
    ground: groundOn(), resizing, cover: { ...coverWas },
    tabs: allTabs().map((t) => ({ id: t.id, geo: { ...t.geo }, placed: placed(t), seeThrough: seeThrough(t), epoch: epochOf(t.id), gen: genOf(t.id) })),
  }))
  // the capture matrix's heartbeat (A3.8 #29): a 1 px opacity animation in the strip's corner, run by the compositor
  // and changing every frame - so the strip makes a frame each refresh (a ProMotion display stays at its full rate)
  // and a stalled strip main thread keeps it - test builds only; the release never carries it
  let beat: string | null = null
  provide('ground:heartbeat', async (a) => {
    const s = stripContents()
    if (!s) return false
    const on = !!arg<{ on?: boolean }>(a).on
    if (beat) { await s.removeInsertedCSS(beat).catch(() => {}); beat = null }
    if (on) beat = await s.insertCSS('html::after { content: ""; position: fixed; right: 0; bottom: 0; width: 1px; height: 1px; background: #808080; will-change: opacity; animation: mv-beat 1s linear infinite alternate; pointer-events: none } @keyframes mv-beat { from { opacity: 1 } to { opacity: .4 } }')   // the author origin: removeInsertedCSS takes only that one back
    return true
  })
  // the heartbeat's corner as the strip's compositor last drew it (capturePage, browser-side: it needs nothing of the
  // strip's main thread): the bottom-right device pixel, BGRA
  provide('ground:beat-pixel', async () => {
    const s = stripContents()
    if (!s || !strip) return null
    const b = strip.getBounds()
    const img = await s.capturePage({ x: b.width - 2, y: b.height - 2, width: 2, height: 2 })
    const bmp = img.toBitmap()
    return bmp.length >= 4 ? [...bmp.subarray(bmp.length - 4)] : null
  })
  // the strip's empty part, from the strip itself (A3.8 #34): right of the last tab (and `»`), left of the pill (or
  // the strip's right padding); the heartbeat's corner. In the strip's CSS px, which are the window's content coordinates
  provide('ground:strip-regions', async () => {
    const s = stripContents()
    if (!s) return null
    return s.executeJavaScript(`(() => {
      const W = innerWidth, H = innerHeight, cs = getComputedStyle(document.getElementById('strip'))
      const shown = (e) => e && !e.hidden && e.getClientRects().length > 0
      const rights = [...document.querySelectorAll('#tabs > *')].filter(shown).map((e) => e.getBoundingClientRect().right)
      const more = document.getElementById('more'), pill = document.getElementById('pill')
      if (shown(more)) rights.push(more.getBoundingClientRect().right)
      const tabsRight = Math.ceil(Math.max(parseFloat(cs.paddingLeft), ...rights))
      const pillLeft = Math.floor(shown(pill) ? pill.getBoundingClientRect().left : W - parseFloat(cs.paddingRight))
      const x = tabsRight + 8, r = pillLeft - 8
      return { width: W, height: H, tabsRight, pillLeft, empty: r > x ? [{ x, y: 0, width: r - x, height: H }] : [], heartbeat: { x: W - 1, y: H - 1, width: 1, height: 1 } }
    })()`)
  })
}

/** Show the window: at launch (once the strip loaded, or after 300 ms), from the Dock, a second launch. */
export function showWindow(o: { focus?: boolean } = {}): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  if (o.focus === false) win.showInactive()
  else { win.show(); win.focus() }
  onVisibility()
  // in front now, so it can draw: requests held while it could not go out (present.ts), the first show at launch too
  if (windowShown(Date.now())) compose()
}

/** A second launch focuses the window (A2.1). */
export function focusWindow(): void {
  showWindow()
  app.focus({ steal: true })
}

export const hideWindow = (): void => { win?.hide(); onVisibility() }
export const windowVisible = (): boolean => !!win && win.isVisible() && !win.isMinimized()
