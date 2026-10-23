/**
 * The window (spec 28 A2.2, A2.11, A2.13, A2.14 #1, #19, #20, #21, #33). Owner: the window stream.
 *
 * One `BaseWindow` named `main` (window place: `windowStatePersistence` does nothing without a name). Its stack,
 * bottom to top: the content views (canvases, Home, Settings), the tab pages, the cover, the strip. App 0.1 has
 * the opaque strip: every view sits below the 44 px strip, and the cover - main's plain view, in the ground of the
 * active tab's look - is always shown under the strip's tabs (plan.ts).
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
import { app, BaseWindow, nativeTheme, View, WebContentsView, type WebContents, type WebPreferences } from 'electron'
import { CH, type PageKind, type PageFocus, type TabsSnapshot, type TabView, type WindowView } from '../shared/channels.ts'
import { STRIP_HEIGHT, below, ground, plan, type Plan, type PlanTab } from './plan.ts'
import { activeTab, allTabs, darkOf, getTab, ordered, viewOf, type Tab } from './tabs.ts'
import { pageFor, snapshotKey, type PageBody } from './tabpage.ts'
import { recompute as recomputePill, onVisibility } from './pill.ts'
import { afterShow, setFocusPorts, track } from './focus.ts'
import { invalidateMenu } from './menu.ts'
import { note } from './testing/index.ts'
import { T } from './timings.ts'

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
}

let win: BaseWindow | null = null
let cover: View | null = null
let strip: WebContentsView | null = null
let deps: WindowDeps | null = null
let turn = 0

const j = (topic: string, data: unknown) => { if (__MV_TEST__) note(topic, data) }

/** The app pages' preferences: sandboxed, isolated, no dialogs, the app preload, on persist:app (A2.5, A2.14 #14). */
export const appPrefs = (): WebPreferences => ({
  partition: 'persist:app', preload: PRELOAD_APP, sandbox: true, contextIsolation: true, nodeIntegration: false,
  webviewTag: false, spellcheck: false, disableDialogs: true,
})

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
  view.setBounds(below(width, height))
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
let pillBody: unknown = null

function send(wc: WebContents | undefined, channel: string, payload: unknown): void {
  if (!wc || wc.isDestroyed() || !ready.has(wc)) return
  if (deps?.send) deps.send(wc, channel, payload)
  else wc.send(channel, payload)
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
  if (kind === 'strip' && pillBody !== null) send(wc, CH.pill, pillBody)
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
  // a page that reloads (or whose renderer went) says ready again before it gets anything
  wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) ready.delete(wc) })
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
  const body = { focused: win.isFocused(), fullScreen: win.isFullScreen() }
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
  view.setBounds(below(width, height))
  // above the content views, beneath the cover and the strip
  win!.contentView.addChildView(view, Math.max(0, win!.contentView.children.length - 2))
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

function planTab(t: Tab, appDark: boolean): PlanTab {
  const h = pages.get(t.id)
  return {
    id: t.id, kind: t.kind, view: content.has(t.id), page: !!h && !h.closing && !!h.body, pageView: !!h,
    dark: darkOf(t, appDark),
  }
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
  const p: Plan = plan({ tabs: allTabs().map((t) => planTab(t, appDark)), active: activeTab()?.id ?? 'home', w, h, appDark })
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
  // 3. the cover (always shown in 0.1) and the strip, on top
  cover!.setBounds(p.cover.rect)
  strip!.setBounds(p.strip)
  if (p.cover.color !== coverWas.color) { cover!.setBackgroundColor(p.cover.color); win!.setBackgroundColor(p.cover.color) }
  if (p.cover.visible !== coverWas.visible) cover!.setVisible(p.cover.visible)
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
  const a = activeTab()
  if (a?.kind === 'local' && a.doc && a.doc.lifted && applied.get(`${a.id}:view`)?.vis) { a.doc.shown = true; a.retained = true }
  if (__MV_TEST__ && changes.length) note('compose', { turn, active: p.active, w, h, cover: coverWas, changes })
  feedTabs()
  feedWindow()
  recomputePill()
  invalidateMenu()
}

/** Every view's bounds and visibility as Electron reports them now (test builds read it). */
export function viewsNow(): { key: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean }[] {
  const out: { key: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean }[] = []
  for (const [id, c] of content) out.push({ key: `${id}:view`, bounds: c.view.getBounds(), visible: c.view.getVisible() })
  for (const [id, h] of pages) out.push({ key: `${id}:page`, bounds: h.view.getBounds(), visible: h.view.getVisible() })
  if (cover) out.push({ key: 'cover', bounds: cover.getBounds(), visible: cover.getVisible() })
  if (strip) out.push({ key: 'strip', bounds: strip.getBounds(), visible: strip.getVisible() })
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// The window itself

export function openWindow(d: WindowDeps): BaseWindow {
  if (win) return win
  deps = d
  const dark = nativeTheme.shouldUseDarkColors
  win = new BaseWindow({
    name: 'main', windowStatePersistence: true,
    width: 1280, height: 820, minWidth: 720, minHeight: 480,
    titleBarStyle: 'hidden', trafficLightPosition: LIGHTS,
    backgroundColor: ground(dark), show: false, title: 'Marver',
  })
  cover = new View()
  cover.setBackgroundColor(ground(dark))
  coverWas = { visible: true, color: ground(dark) }
  strip = new WebContentsView({ webPreferences: appPrefs() })
  strip.setBackgroundColor('#00000000')   // transparent over the cover: only the strip draws the tabs and dots
  registerApp(strip.webContents, 'strip')
  track(strip.webContents, { part: 'strip' })
  strip.webContents.on('render-process-gone', () => {
    // the cover stays, showing ground; the strip comes back
    j('strip', { gone: true })
    setTimeout(() => { if (strip && !strip.webContents.isDestroyed()) void strip.webContents.loadURL(`${APP_ORIGIN}strip/`).catch(() => {}) }, 0)
  })
  win.contentView.addChildView(cover)
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
  win.on('resize', () => { compose(); deferred() })
  win.on('enter-full-screen', () => { compose(); deferred() })
  win.on('leave-full-screen', () => { compose(); deferred() })
  win.on('focus', () => feedWindow())
  win.on('blur', () => feedWindow())
  for (const ev of ['show', 'hide', 'minimize', 'restore'] as const) win.on(ev as 'show', () => { onVisibility(); feedWindow() })
  win.on('close', (e) => {
    // ⇧⌘W and the red button hide the window: the views stay as they are (A2.2)
    if (deps?.quitting()) return
    e.preventDefault()
    win?.hide()
  })
  win.on('closed', () => { win = null })
  nativeTheme.on('updated', () => compose())
  compose()
  return win
}

/** Show the window: at launch (once the strip loaded, or after 300 ms), from the Dock, a second launch. */
export function showWindow(o: { focus?: boolean } = {}): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  if (o.focus === false) win.showInactive()
  else { win.show(); win.focus() }
  onVisibility()
}

/** A second launch focuses the window (A2.1). */
export function focusWindow(): void {
  showWindow()
  app.focus({ steal: true })
}

export const hideWindow = (): void => { win?.hide(); onVisibility() }
export const windowVisible = (): boolean => !!win && win.isVisible() && !win.isMinimized()
