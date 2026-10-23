/**
 * The tab model (spec 28 A2.4, A2.14 #20, #23, v1.12 r1 #3, #5, v1.13 r2 #1-#3, v1.14 r3 #1-#3). Owner: the
 * window stream.
 *
 * One field group per concern, one writer each; `displayState` and the tab page (`tabpage.ts` `pageFor`) are pure
 * functions of the record. This file holds no Electron import: the model, its transitions, the order and keys,
 * `tabs.json`, and the guard - every effect (a view, a load, an act on a page, a native sheet) goes through the
 * ports `views.ts` installs, so all of it is unit-tested without Electron.
 *
 * The guard (A2.2, v1.12 r1 #3, v1.13 r2 #1-#4, v1.14 r3 #1, #2): every way the app replaces a canvas's live
 * document is one operation of `guard(tab, action)` (`guardAll` for quit and update), one at a time per tab,
 * bound to `{ tab, commit, doc, action }` at its start and read again after every wait, in the turn of its act:
 * it goes on only when the tab's document is the one it bound and either its safety is fresh and clean now, or
 * the person's consent names exactly that tab, document and action. A fresh `unsaved` refuses at once, asking
 * nothing; a record not fresh (`unknown`, `stale`, or a canvas without the bridge) asks one native sheet first.
 */
import type { DisplayState, TabPageProbe, TabView } from '../shared/channels.ts'
import type { AppState, Busy, MenuItem, Theme, Why } from '../../../src/shared/app-api.ts'
import { UNSAVED_WHY, WHY_WORDS } from '../../../src/shared/app-api.ts'
import type { FailWhy } from './nav.ts'
import type { RegistryEntry, RegistryEvent } from './registry.ts'
import { tilde } from '../shared/command.ts'

export type TabKind = 'local' | 'home' | 'settings'   // 'remote' from A4

/** The registry's facts about the tab's canvas (writer: tabs.ts, from the registry's events). */
export interface TabReg {
  state: 'starting' | 'ready' | 'gone'
  file: string
  instance: string
  ws: string
  /** null while starting */
  origin: string | null
  port: number
  slot: number | null
  features: string[]
  /** the canvas's Marver version (the slot file's) - added by the window stream */
  version?: string
}

/** The view (writer: views.ts / tabs.ts). `unloaded` is A3's. */
export type TabViewState = 'none' | 'live' | 'crashed'

/** The committed document and its trust (writer: tabs.ts, from the adapter's events, nav.ts). */
export interface TabDoc {
  gen: number
  url: string
  /** trusted at its commit, and its instance still the tab's current, live registry instance (A2.14 #8) */
  trusted: boolean
  /** minted at the trusted commit and sent as `mv:admit` (v1.12 r1 #1) */
  doc?: string
  /** commits of this tab, counted: bumped at every commit and failure main sees and when the renderer or the view goes (v1.13 r2 #2) */
  commits: number
  /** this document has been shown */
  shown: boolean
  /** the commit was attributed (trusted at its commit): the tab page lifted for it - added by the window stream */
  lifted?: boolean
}

/** The current document's safety (v1.12 r1 #2, v1.13 r2 #1): unknown until its first report; stale once main can no longer hear it. */
export type Safety = 'unknown' | 'fresh' | 'stale'

/** The current document's last reports (writer: tabs.ts `onReport`, from the bridge). */
export interface TabReports { safety: Safety; busy?: Busy; theme?: Theme; menu?: MenuItem[] }

/**
 * The crash record (writer: tabpage.ts `recover`). `count`, `lastAuto` and `latched` are the frozen part; the
 * rest is the window stream's bookkeeping of A2.11's rules.
 */
export interface TabCrash {
  count: number
  lastAuto?: number
  latched: boolean
  /** when each counted crash happened (Copy Details) */
  times?: number[]
  reason?: 'oom' | 'killed' | 'crashed'
  exitCode?: number
  /** the reload in flight after a crash, by whom - until its document commits or fails */
  inFlight?: false | 'auto' | 'person' | 'force'
  /** this attempt already counted one crash: further ones count nothing (A2.11) */
  counted?: boolean
  /** a hidden tab crashed: its one automatic attempt waits for it to be shown */
  pendingShow?: boolean
  /** when a person's reload lifted: the latch clears 60 s later without a crash */
  personLiftAt?: number
}

/** The last load's failure, from the adapter (the tab page's state; cleared at an attributed commit or a rebind). */
export interface TabFail { why: FailWhy; at: number; code?: number }

export interface Tab {
  /** main's opaque id, `t` and a counter, stable for the tab's life (A2.14 #10); `home` and `settings` for those */
  id: string
  kind: TabKind
  name: string
  reg?: TabReg
  view: TabViewState
  doc?: TabDoc
  reports: TabReports
  crash: TabCrash
  /** a document that was shown or admitted may hold the person's work, alive in the view (v1.13 r2 #3) */
  retained: boolean
  /** the replacement in flight, one per tab, with its action and any consent (v1.13 r2 #2, v1.14 r3 #1, #2) */
  replacing?: GuardOperation
  /** false: closed by the person for this canvas's run (Home still lists it) */
  open: boolean
  /** the shell's own document only: `/` or `/index.html`, its query and hash (v1.12 r1 #5) */
  path: string
  root?: string
  shownAt?: number
  hiddenAt?: number

  // ---- added by the window stream (optional, so nothing that builds a Tab elsewhere breaks) ----
  /** the last load's failure; the tab page shows it while no document is lifted */
  fail?: TabFail
  /** what the probe of a failed tab's address last found (v1.14 r3 #3) */
  probe?: TabPageProbe
  /** Chromium's hang monitor: `unresponsive` until `responsive` */
  hung?: boolean
  /** the guard refused for unsaved work: the strip's "Unsaved work here" pill (A2.2) */
  held?: { at: number; action: GuardAction['kind'] }
  /** the app is ending this renderer itself: its render-process-gone counts nothing (A2.11) */
  appEnding?: boolean
  /** one-shot: the next document is `recover`'s reload, so `mv:doc` answers `{ reopen: true }` (A2.14 #9) */
  reopen?: boolean
  /** the tab's look this run: its documents' last trusted `mv:theme`, kept through a crash or a stop (A2.14 #26) */
  look?: boolean
  /** a checked `data:` URL (A2.4); never shown for an unverified tab */
  logo?: string
  /** when the registry last changed the tab's state, the last load started, the canvas went */
  regAt?: number
  loadAt?: number
  goneAt?: number
  /** unattributed commits in a row: the first is reloaded at once, the next on A2.3's schedule (A2.14 #8) */
  unattributed?: number
  /** documentless, with a view that holds nothing worth keeping (a rebind): loads when next shown (v1.13 r2 #5) */
  needsLoad?: boolean
}

// ---------------------------------------------------------------------------------------------------------------
// The guard's contract (frozen, v1.14 r3 #2)

/**
 * Every way the app replaces a canvas's live document (v1.12 r1 #3), as a value the caller builds once and the
 * operation copies at its start (v1.14 r3 #2): nothing read later changes what it does. A3 adds `{ kind: 'unload' }`.
 */
export type GuardAction =
  /** ⌘W, the strip's close, Close Tab: `close({ waitForBeforeUnload: true })` */
  | { kind: 'close' }
  /** ⌘Q, each tab under `guardAll`: a close */
  | { kind: 'quit' }
  /** A5's Restart to update, each tab under `guardAll`: a close */
  | { kind: 'update' }
  /** ⌘R, the menu: `reload()` */
  | { kind: 'reload' }
  /** ⇧⌘R: `reloadIgnoringCache()` */
  | { kind: 'forceReload' }
  /** a tab page's Try Again or Try Now: `loadURL` of the tab's path on its bound origin (a reload while it has not moved) */
  | { kind: 'tryAgain' }
  /** ⌘L or a same-origin `window.open`: `loadURL(url)`, the link already rebuilt on the bound origin and checked (A2.7) */
  | { kind: 'load'; url: string }

/** The two actions `guardAll` takes. */
export type GuardAllAction = Extract<GuardAction, { kind: 'quit' | 'update' }>

/**
 * The person's answer on a sheet: exactly this tab, this document and this action (v1.14 r3 #1). Held by the one
 * operation that asked; never another action, tab or document. A shared quit sheet makes one per tab it names.
 */
export interface GuardConsent { tab: string; commit: number; doc?: string; action: GuardAction }

/** One replacement in flight: what it bound at its start (v1.13 r2 #2, v1.14 r3 #1, #2). */
export interface GuardOperation { commit: number; doc?: string; action: GuardAction; consent?: GuardConsent }

/** Why a sheet names a tab (A2.14 #15, v1.12 r1 #2, v1.13 r2 #1). */
export type SheetWhy =
  | { kind: 'no-bridge'; version?: string }
  | { kind: 'unknown' }
  | { kind: 'stale'; stopped: boolean; held: Why[] }

/** One native sheet the guard asks (Cancel the default). */
export interface Sheet { action: GuardAction; tabs: { id: string; name: string; why: SheetWhy }[] }

/** What the guard's caller sees: `'done'` the act happened, `'refused'` nothing was replaced. */
export type GuardAnswer = 'done' | 'refused'

/** The effects the model needs; `views.ts` installs the real ones, tests fakes. */
export interface TabsPorts {
  now(): number
  /** the person's home folder, for `~` */
  home: string
  /** the app's own theme (theme.json `mode` through nativeTheme) - a tab with no look of its own wears it */
  appDark(): boolean
  /** compose(): the one writer of bounds and visibility, in this turn */
  changed(o?: { focus?: 'shown' }): void
  /** make the tab's view if needed and load its path on its bound origin: only ever a documentless tab (never guarded) */
  load(t: Tab): void
  /** `mv:app-state` to the tab's live document */
  appState(t: Tab, s: AppState): void
  /** the act on the page: Chromium runs its beforeunload first; 'refused' when the page refused */
  act(t: Tab, a: GuardAction): Promise<GuardAnswer>
  /** one native sheet; true when the person confirmed */
  ask(s: Sheet): Promise<boolean>
  /** close and drop a tab's view that holds nothing to guard (Settings; a documentless canvas) */
  forget(t: Tab): void
  /** tabs.json, soon (debounced) */
  save(): void
  /** the tab was just shown: its pending automatic crash reload starts now (tabpage.ts) */
  shown(t: Tab): void
  /** a journal line (test builds) */
  log?(topic: string, data: unknown): void
}

let ports: TabsPorts | null = null
export function setTabsPorts(p: TabsPorts): void { ports = p }
const P = (): TabsPorts => {
  if (!ports) throw new Error('tabs.ts: no ports (views.ts installs them at ready)')
  return ports
}

// ---------------------------------------------------------------------------------------------------------------
// The store

const tabs = new Map<string, Tab>()
let activeId = 'home'
let counter = 0
/** closes for a canvas's run, `ws|instance` (A2.14 #23), kept in tabs.json */
const closed = new Set<string>()
const closeKey = (ws: string, instance: string) => `${ws}|${instance}`

export function blankTab(id: string, kind: TabKind, name: string, extra: Partial<Tab> = {}): Tab {
  return { id, kind, name, view: 'none', reports: { safety: 'unknown' }, crash: { count: 0, latched: false }, retained: false, open: true, path: '/', ...extra }
}

/** Test seam: an empty model with Home. */
export function resetTabs(): void {
  tabs.clear(); closed.clear(); counter = 0; activeId = 'home'
  tabs.set('home', blankTab('home', 'home', 'Home'))
}
resetTabs()

export const allTabs = (): Tab[] => [...tabs.values()]
export const getTab = (id: string): Tab | undefined => tabs.get(id)
export const activeTab = (): Tab | undefined => tabs.get(activeId)
export const isActive = (t: Tab): boolean => t.id === activeId
export const closedRuns = (): { ws: string; instance: string }[] => [...closed].map((k) => { const [ws, instance] = k.split('|'); return { ws: ws!, instance: instance! } })

export interface Tabs {
  all(): Tab[]
  active(): Tab | undefined
}

/** At ready, after the window: the model with Home (restore() fills it from tabs.json and the registry). */
export function startTabs(): Tabs {
  if (!tabs.has('home')) tabs.set('home', blankTab('home', 'home', 'Home'))
  return { all: allTabs, active: activeTab }
}

// ---------------------------------------------------------------------------------------------------------------
// Pure views of the record

/** A live document the view still holds, which may hold the person's work (the guard's and the rebind's test). */
export const liveDoc = (t: Tab): boolean => t.kind === 'local' && t.view === 'live' && t.retained
/**
 * A tab loads when shown (A2.4's lazy views, v1.13 r2 #5): ready, not latched, not crashed (tabpage.ts owns that
 * reload), holding no live document, and with no view yet or a view a rebind left documentless.
 */
export const wantsLoad = (t: Tab): boolean => t.kind === 'local' && t.reg?.state === 'ready' && !!t.reg.origin && !t.crash.latched
  && t.view !== 'crashed' && !liveDoc(t) && !t.crash.inFlight && (t.view === 'none' || !!t.needsLoad)

/** The current document's record is fresh: trusted now, and heard since its commit. */
export const fresh = (t: Tab): boolean => t.reports.safety === 'fresh' && !!t.doc?.trusted
export const freshUnsaved = (t: Tab): boolean => fresh(t) && t.reports.busy?.unsaved === true
export const freshClean = (t: Tab): boolean => fresh(t) && t.reports.busy?.unsaved !== true
export const hasBridge = (t: Tab): boolean => !!t.reg?.features.includes('bridge')

/** The name the eye reads: an unverified tab is its address, never the slot file's name (frame 05, A2.13). */
export function tabName(t: Tab): string {
  if (t.kind === 'local' && t.fail?.why === 'unverified' && t.reg) return `localhost:${t.reg.port}`
  return t.name
}

/** A2.4's state, a pure function of the record. */
export function displayState(t: Tab, active: boolean): DisplayState {
  if (t.kind !== 'local') return active ? 'live' : 'hidden'
  const gone = !t.reg || t.reg.state === 'gone'
  if (t.fail?.why === 'unverified' && !gone) return 'unverified'
  if (gone) return 'gone'
  if (t.reg!.state === 'starting') return 'starting'
  if (t.view === 'crashed' || (t.crash.latched && !t.doc?.lifted)) return 'crashed'
  if (t.fail) return t.fail.why === 'unreachable' ? 'unreachable' : 'gone'
  if (t.view === 'none') return 'none'
  return active ? 'live' : 'hidden'
}

/** Home, local canvases by slot then explicit ports by port (a grey tab after a live one on the same slot), Settings (A2.14 #23). */
export function ordered(list: Tab[] = allTabs()): Tab[] {
  const rank = (t: Tab) => t.reg?.slot != null ? t.reg.slot : 10_000 + (t.reg?.port ?? 0)
  const num = (t: Tab) => Number.parseInt(t.id.slice(1), 36) || 0
  const local = list.filter((t) => t.kind === 'local' && t.open).sort((a, b) =>
    rank(a) - rank(b) || Number(a.reg?.state === 'gone') - Number(b.reg?.state === 'gone') || num(a) - num(b))
  return [...list.filter((t) => t.kind === 'home'), ...local, ...list.filter((t) => t.kind === 'settings')]
}

/** The canvas tabs in strip order: ⌘1-⌘8 are the first eight, ⌘9 the last (A2.4, A2.14 #23). */
export const canvasOrder = (list: Tab[] = allTabs()): Tab[] => ordered(list).filter((t) => t.kind === 'local')

export function forDigit(d: number, list: Tab[] = allTabs()): Tab | undefined {
  const c = canvasOrder(list)
  return d === 9 ? c.at(-1) : c[d - 1]
}

/** The key a canvas tab shows: 1-8 by place, 9 for the last (when it is past the eighth or the ninth). */
export function keyOf(t: Tab, list: Tab[] = allTabs()): number | undefined {
  const c = canvasOrder(list)
  const i = c.indexOf(t)
  if (i < 0) return undefined
  if (i < 8) return i + 1
  return i === c.length - 1 ? 9 : undefined
}

/** ⌃Tab / ⌃⇧Tab / ⇧⌘] / ⇧⌘[: every open tab, Home and Settings included, wrapping. */
export function cycleFrom(id: string, dir: 1 | -1, list: Tab[] = allTabs()): Tab | undefined {
  const o = ordered(list)
  if (!o.length) return undefined
  const i = o.findIndex((t) => t.id === id)
  return o[((i < 0 ? 0 : i + dir) + o.length) % o.length]
}

/** What the strip and Home get for one tab (A2.14 #19). No key, instance, ws or root unshortened. */
export function viewOf(t: Tab, active: boolean, home: string, list: Tab[] = allTabs()): TabView {
  const v: TabView = { id: t.id, kind: t.kind, name: tabName(t), state: displayState(t, active), verified: !!t.doc?.trusted, open: t.open }
  if (t.kind !== 'local') return v
  const key = keyOf(t, list)
  if (key !== undefined) v.key = key
  if (t.reg?.slot != null) v.slot = t.reg.slot
  if (t.root) v.folder = tilde(t.root, home)
  if (t.reg?.version) v.version = t.reg.version
  if (t.reg) v.link = `http://localhost:${t.reg.port}${t.path}`
  if (t.logo && t.fail?.why !== 'unverified') v.logo = t.logo
  if (t.look !== undefined) v.dark = t.look
  return v
}

/** The tab's look: its own last theme this run, else the app's (A2.14 #26). */
export const darkOf = (t: Tab | undefined, appDark: boolean): boolean => t?.kind === 'local' && t.look !== undefined ? t.look : appDark

// ---------------------------------------------------------------------------------------------------------------
// tabs.json (v1.12 r1 #5)

/** `<state>/tabs.json`. A file with another `v`, or a bad shape, goes aside as `tabs.json.bad`. */
export interface TabsFile {
  v: 1
  active: { kind: 'home' } | { kind: 'settings' } | { kind: 'canvas'; ws: string; origin: string }
  /** at most 20, newest shown first */
  canvases: { ws: string; origin: string; path: string; shownAt: number }[]
  settings: boolean
  /** closes for that canvas's run (A2.14 #23) */
  closed: { ws: string; instance: string }[]
}

const WS = /^[0-9a-f]{16}$/
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** The shell's own document only - `/` or `/index.html`, its query and hash - under 2 KB, else `/`. */
export function safePath(p: unknown): string {
  if (typeof p !== 'string' || p.length > 2048 || /[\s\\]/.test(p)) return '/'
  return /^\/(index\.html)?([?#].*)?$/.test(p) ? p : '/'
}

const loopbackOrigin = (o: unknown): o is string => typeof o === 'string' && o.length <= 64 && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(o)

/** The file's shape, checked; null when it does not hold (the caller sets it aside as `.bad`). */
export function parseTabsFile(raw: unknown): TabsFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1) return null
  const a = r.active as Record<string, unknown> | null
  let active: TabsFile['active']
  if (!a || typeof a !== 'object') return null
  if (a.kind === 'home' || a.kind === 'settings') active = { kind: a.kind }
  else if (a.kind === 'canvas' && typeof a.ws === 'string' && WS.test(a.ws) && loopbackOrigin(a.origin)) active = { kind: 'canvas', ws: a.ws, origin: a.origin }
  else return null
  if (!Array.isArray(r.canvases) || r.canvases.length > 20 || !Array.isArray(r.closed) || r.closed.length > 200 || typeof r.settings !== 'boolean') return null
  const canvases: TabsFile['canvases'] = []
  for (const c of r.canvases as unknown[]) {
    const x = c as Record<string, unknown>
    if (!x || typeof x !== 'object' || typeof x.ws !== 'string' || !WS.test(x.ws) || !loopbackOrigin(x.origin) || typeof x.path !== 'string' || typeof x.shownAt !== 'number' || !Number.isFinite(x.shownAt)) return null
    canvases.push({ ws: x.ws, origin: x.origin, path: safePath(x.path), shownAt: x.shownAt })
  }
  const closedList: TabsFile['closed'] = []
  for (const c of r.closed as unknown[]) {
    const x = c as Record<string, unknown>
    if (!x || typeof x !== 'object' || typeof x.ws !== 'string' || !WS.test(x.ws) || !isStr(x.instance, 64)) return null
    closedList.push({ ws: x.ws, instance: x.instance })
  }
  return { v: 1, active, canvases, settings: r.settings, closed: closedList }
}

/** What restore does at launch (pure): the canvas tabs to make, which are open, their paths, and the active tab. */
export interface RestorePlan {
  canvases: { entry: RegistryEntry; path: string; open: boolean }[]
  settings: boolean
  active: { kind: 'home' } | { kind: 'settings' } | { kind: 'canvas'; instance: string }
  closed: { ws: string; instance: string }[]
}

/**
 * Restoring (v1.12 r1 #5, A2.14 #23, A2.12): with `restoreTabs` on, each running canvas whose tab is open (not
 * closed for this run) takes the entry with its `(ws, origin)`, else the latest shown entry of its `ws` (a canvas
 * that moved slot), and loads that path on its own bound origin; the active tab is the entry that names exactly a
 * running canvas, Home or Settings, anything else Home. Off: every running canvas at `/`, a closed one included,
 * Home active. The very first launch is Home. Grey tabs are never restored: a canvas not running gets no tab.
 */
export function restorePlan(file: TabsFile | null, entries: RegistryEntry[], o: { restore: boolean; firstLaunch: boolean }): RestorePlan {
  const live = entries.filter((e) => e.state === 'ready' || e.state === 'starting')
  if (!o.restore || !file) {
    return { canvases: live.map((entry) => ({ entry, path: '/', open: true })), settings: false, active: { kind: 'home' }, closed: [] }
  }
  const isClosed = (e: RegistryEntry) => file.closed.some((c) => c.ws === e.ws && c.instance === e.instance)
  const pathOf = (e: RegistryEntry) => {
    const exact = e.origin ? file.canvases.find((c) => c.ws === e.ws && c.origin === e.origin) : undefined
    const latest = [...file.canvases].filter((c) => c.ws === e.ws).sort((a, b) => b.shownAt - a.shownAt)[0]
    return safePath((exact ?? latest)?.path ?? '/')
  }
  const canvases = live.map((entry) => ({ entry, path: pathOf(entry), open: !isClosed(entry) }))
  let active: RestorePlan['active'] = { kind: 'home' }
  if (!o.firstLaunch) {
    const a = file.active
    if (a.kind === 'settings') active = { kind: 'settings' }
    else if (a.kind === 'canvas') {
      const hit = canvases.find((c) => c.open && c.entry.state === 'ready' && c.entry.ws === a.ws && c.entry.origin === a.origin)
      if (hit) active = { kind: 'canvas', instance: hit.entry.instance }
    }
  }
  const closedKept = file.closed.filter((c) => live.some((e) => e.ws === c.ws && e.instance === c.instance))
  return { canvases, settings: file.settings || active.kind === 'settings', active, closed: closedKept }
}

/** The file as the model stands (written debounced 1 s; A5's quit snapshot writes it at once). */
export function snapshotFile(previous: TabsFile | null, now: number): TabsFile {
  const a = activeTab()
  const active: TabsFile['active'] = a?.kind === 'settings' ? { kind: 'settings' }
    : a?.kind === 'local' && a.reg?.origin ? { kind: 'canvas', ws: a.reg.ws, origin: a.reg.origin } : { kind: 'home' }
  const mine = allTabs().filter((t) => t.kind === 'local' && t.reg?.origin)
    .map((t) => ({ ws: t.reg!.ws, origin: t.reg!.origin!, path: safePath(t.path), shownAt: t.shownAt ?? t.regAt ?? now }))
  const kept = (previous?.canvases ?? []).filter((c) => !mine.some((m) => m.ws === c.ws && m.origin === c.origin))
  const canvases = [...mine, ...kept].sort((x, y) => y.shownAt - x.shownAt).slice(0, 20)
  // a close lasts for that canvas's run: kept while the model still knows that instance
  const runs = closedRuns().filter((c) => allTabs().some((t) => t.reg?.ws === c.ws && t.reg.instance === c.instance))
  return { v: 1, active, canvases, settings: tabs.has('settings'), closed: runs }
}

/** Apply a restore plan to an empty model (Home only). */
export function applyRestore(plan: RestorePlan): void {
  for (const c of plan.closed) closed.add(closeKey(c.ws, c.instance))
  for (const c of plan.canvases) {
    const t = createLocal(c.entry, c.open)
    t.path = c.path
  }
  if (plan.settings) openSettingsTab(false)
  const a = plan.active
  if (a.kind === 'settings') activeId = 'settings'
  else if (a.kind === 'canvas') activeId = allTabs().find((t) => t.reg?.instance === a.instance)?.id ?? 'home'
  else activeId = 'home'
  const t = activeTab()
  if (t) t.shownAt = P().now()
}

// ---------------------------------------------------------------------------------------------------------------
// Transitions: the registry (A2.3, A2.14 #10, v1.12 r1 #3, v1.13 r2 #5)

function factsOf(e: RegistryEntry): TabReg {
  return {
    state: e.state === 'ready' ? 'ready' : e.state === 'starting' ? 'starting' : 'gone',
    file: e.file, instance: e.instance, ws: e.ws, origin: e.origin ?? null, port: e.port, slot: e.slot,
    features: [...e.features], version: e.version,
  }
}

function createLocal(e: RegistryEntry, open: boolean): Tab {
  const now = ports?.now() ?? Date.now()
  const t = blankTab(`t${(++counter).toString(36)}`, 'local', e.name || `localhost:${e.port}`, { reg: factsOf(e), root: e.root, open, regAt: now })
  tabs.set(t.id, t)
  return t
}

/** Trust goes from a live document (a stop, a rebind): its record is stale from now, and the page stops its microphone (A2.14 #13). */
function revoke(t: Tab): void {
  if (!t.doc) return
  const had = t.doc.trusted
  t.doc.trusted = false
  t.reports.menu = undefined
  if (t.view === 'live' && t.doc.lifted) {
    t.reports.safety = 'stale'
    if (had) P().appState(t, 'untrusted')
  }
}

/** A registry event (A2.3). The tab's identity is its workspace and origin; a starting entry binds by workspace and port. */
export function onRegistry(ev: RegistryEvent): void {
  const p = P()
  const now = p.now()
  if (ev.kind === 'gone') {
    const t = allTabs().find((x) => x.kind === 'local' && x.reg?.instance === ev.instance)
    if (!t || t.reg!.state === 'gone') return
    if (!t.open && !liveDoc(t)) { dropTab(t); return }
    t.reg!.state = 'gone'
    t.goneAt = now; t.regAt = now
    revoke(t)
    p.log?.('registry', { tab: t.id, gone: ev.why })
    p.changed(); p.save()
    return
  }
  const e = ev.entry
  const locals = allTabs().filter((x) => x.kind === 'local')
  let t = locals.find((x) => x.reg?.instance === e.instance)
  if (t) {
    const was = t.reg!.state
    const docOrigin = t.doc?.url ? originOf(t.doc.url) : null
    if (e.state === 'ready' && e.origin && liveDoc(t) && docOrigin && docOrigin !== e.origin) {
      // bound at starting by port; ready on another origin while a page is kept: that page stays grey, the entry gets its own tab (A2.14 #10)
      t.reg = { ...t.reg!, state: 'gone', instance: `${t.reg!.instance}~split` }
      t.goneAt = now
      revoke(t)
      t = undefined
    } else {
      t.reg = factsOf(e)
      t.name = e.name || t.name
      t.root = e.root
      if (was !== t.reg.state) t.regAt = now
      if (was === 'starting' && t.reg.state === 'ready' && isActive(t) && wantsLoad(t)) p.load(t)
      p.changed(); p.save()
      return
    }
  }
  const sameAddr = (x: Tab) => x.reg?.ws === e.ws && (e.state === 'ready' && e.origin ? x.reg.origin === e.origin : x.reg.port === e.port)
  t = locals.find((x) => x.reg && sameAddr(x)) ?? locals.find((x) => x.reg?.ws === e.ws && !liveDoc(x))
  if (t) rebind(t, e)
  else createLocal(e, !closed.has(closeKey(e.ws, e.instance)))
  p.changed(); p.save()
}

/** A new instance of the tab's canvas (A2.3, v1.12 r1 #3, v1.13 r2 #5): same tab, new facts, trust revoked; a live page reloads itself. */
function rebind(t: Tab, e: RegistryEntry): void {
  const p = P()
  revoke(t)
  if (t.doc) t.doc.trusted = false
  t.reg = factsOf(e)
  t.name = e.name || t.name
  t.root = e.root
  t.regAt = p.now()
  t.open = true   // a new instance opens its tab by itself (A2.12)
  if (!liveDoc(t)) {
    t.fail = undefined
    t.probe = undefined
    if (t.view === 'live') t.needsLoad = true
    // documentless: loads when shown - at once if active; a latched tab is rebound, never reloaded (A2.11)
    if (isActive(t) && wantsLoad(t)) p.load(t)
  }
  p.log?.('registry', { tab: t.id, rebind: e.instance, live: liveDoc(t) })
}

const originOf = (u: string): string | null => { try { return new URL(u).origin } catch { return null } }

function dropTab(t: Tab): void {
  if (t.view !== 'none') P().forget(t)
  tabs.delete(t.id)
  if (activeId === t.id) activeId = 'home'
}

// ---------------------------------------------------------------------------------------------------------------
// Transitions: the document (from the adapter, nav.ts; A2.14 #8, v1.12 r1 #1, v1.13 r2 #3)

function ensureDoc(t: Tab): TabDoc {
  t.doc ??= { gen: 0, url: '', trusted: false, commits: 0, shown: false }
  return t.doc
}

/** A main-frame commit of the current generation. `admitted` is the bridge's `doc` for an attributed commit. */
export function onCommit(t: Tab, c: { gen: number; url: string; attributed: boolean; admitted: string | null }): void {
  const p = P()
  const d = ensureDoc(t)
  d.commits += 1
  d.gen = c.gen
  d.url = c.url
  d.trusted = c.attributed && t.reg?.state === 'ready'
  d.doc = d.trusted ? (c.admitted ?? undefined) : undefined
  d.lifted = d.trusted
  d.shown = false
  t.reports = { safety: 'unknown' }
  t.view = 'live'
  t.hung = false
  t.reopen = false
  if (d.trusted) {
    // the lift (A2.11): the tab page goes, in the turn compose() shows the canvas view
    t.fail = undefined
    t.probe = undefined
    t.unattributed = 0
    t.retained = true
    t.held = undefined
    const path = pathOf(c.url)
    if (path) t.path = path
  } else {
    // unattributed: untrusted, kept beneath its tab page, reloaded by main (views.ts) - never shown, it holds nothing of the person's
    t.retained = false
    t.unattributed = (t.unattributed ?? 0) + 1
  }
  p.log?.('commit', { tab: t.id, gen: c.gen, trusted: d.trusted, commits: d.commits })
}

/** A failure of the current attempt (A2.14 #8): whatever is committed loses trust; the view goes beneath its tab page. */
export function onFail(t: Tab, f: { why: FailWhy; code: number; errorPage: boolean }): void {
  const p = P()
  const d = ensureDoc(t)
  d.commits += 1
  revoke(t)
  t.fail = { why: f.why, at: p.now(), code: f.code }
  t.probe = { state: 'none', lastAt: null }
  // an error page committed proves the earlier document gone; in doubt it stays retained (v1.13 r2 #3)
  if (f.errorPage) { t.retained = false; d.lifted = false; d.doc = undefined }
  p.log?.('fail', { tab: t.id, why: f.why, code: f.code, errorPage: f.errorPage, retained: t.retained })
}

/** The renderer went, or the view closed: the document is gone. */
export function onDocumentGone(t: Tab, view: TabViewState): void {
  const d = ensureDoc(t)
  d.commits += 1
  d.trusted = false
  d.doc = undefined
  d.lifted = false
  d.url = ''
  t.view = view
  t.retained = false
  t.hung = false
  t.reports = { safety: 'unknown' }
}

/** A hash or pushState navigation inside the trusted document: the path follows the page (a board change). */
export function onInPage(t: Tab, url: string): void {
  if (!t.doc?.trusted) return
  const path = pathOf(url)
  if (path) { t.path = path; P().save() }
}

function pathOf(url: string): string | null {
  try {
    const u = new URL(url)
    const p = safePath(u.pathname + u.search + u.hash)
    return p
  } catch { return null }
}

/** A report from the admitted document (the bridge checked its `doc`, its trust and every field). */
export function onReport(tabId: string, doc: string, r: { busy?: Busy; theme?: Theme; menu?: MenuItem[] }): void {
  const t = tabs.get(tabId)
  if (!t?.doc?.trusted || t.doc.doc !== doc) return
  const p = P()
  if (r.busy) {
    // busy is any reason, unsaved any of the first five: a message where they disagree is refused (A2.14 #18)
    if (r.busy.unsaved !== r.busy.why.some((w) => (UNSAVED_WHY as readonly string[]).includes(w)) || r.busy.busy !== r.busy.why.length > 0) return
    t.reports.busy = { busy: r.busy.busy, unsaved: r.busy.unsaved, why: [...r.busy.why] }
    t.reports.safety = 'fresh'
    if (!r.busy.unsaved) t.held = undefined
  }
  if (r.theme) { t.reports.theme = { dark: r.theme.dark }; t.look = r.theme.dark }
  if (r.menu) t.reports.menu = r.menu.map((m) => ({ ...m }))
  p.changed()
}

/** `mv:doc`'s answer for this tab's next document (A2.14 #9): one-shot, set by `recover`'s reload. */
export function takeReopen(tabId: string): boolean {
  const t = tabs.get(tabId)
  if (!t?.reopen) return false
  t.reopen = false
  return true
}

// ---------------------------------------------------------------------------------------------------------------
// Switching, opening, closing (A2.4)

/** Show a tab: its view (or tab page), focused, in one compose; the old one hidden after (A2.13). */
export function activate(id: string): void {
  const p = P()
  const next = tabs.get(id)
  if (!next) return
  const prev = activeTab()
  const now = p.now()
  next.open = true
  if (prev && prev !== next) {
    prev.hiddenAt = now
    if (prev.kind === 'local' && prev.doc?.trusted) p.appState(prev, 'hidden')
  }
  activeId = next.id
  next.shownAt = now
  if (next.kind === 'local') {
    p.shown(next)
    // lazy views: a documentless tab loads when shown (never a latched one: its Reload is the person's)
    if (wantsLoad(next)) p.load(next)
    if (prev !== next && next.doc?.trusted) p.appState(next, 'shown')
  }
  p.changed({ focus: 'shown' })
  p.save()
}

/** The Settings tab: opened or brought forward (⌘,). */
export function openSettingsTab(show = true): Tab {
  let t = tabs.get('settings')
  if (!t) { t = blankTab('settings', 'settings', 'Settings'); tabs.set('settings', t) }
  if (show) activate('settings')
  return t
}

/** The neighbour a closed active tab hands over to: right, else left, else Home. */
function neighbour(t: Tab): string {
  const o = ordered()
  const i = o.findIndex((x) => x.id === t.id)
  return (o[i + 1] ?? o[i - 1] ?? tabs.get('home'))?.id ?? 'home'
}

/** ⌘W, the strip's close, Close Tab, Delete in the strip. The canvas keeps running; Home lists it. */
export async function closeTab(id: string): Promise<'closed' | 'refused'> {
  const t = tabs.get(id)
  if (!t || t.kind === 'home') return 'refused'
  const p = P()
  if (t.kind === 'settings') {
    const next = activeId === id ? neighbour(t) : null
    p.forget(t)
    tabs.delete(id)
    if (next) activate(next)
    p.changed(); p.save()
    return 'closed'
  }
  if (t.view !== 'none') {
    if ((await closeView(t)) === 'refused') return 'refused'
  }
  if (!tabs.has(id)) return 'closed'
  const next = activeId === id ? neighbour(t) : null
  if (t.reg && t.reg.state !== 'gone') {
    t.open = false
    closed.add(closeKey(t.reg.ws, t.reg.instance))
  } else tabs.delete(id)
  if (next) activate(next)
  p.changed(); p.save()
  return 'closed'
}

/** A canvas tab Home's card reopens: open for this run again. */
export function reopenTab(id: string): void {
  const t = tabs.get(id)
  if (!t || t.kind !== 'local') return
  if (t.reg) closed.delete(closeKey(t.reg.ws, t.reg.instance))
  activate(id)
}

// ---------------------------------------------------------------------------------------------------------------
// The guard

const sameAction = (a: GuardAction, b: GuardAction): boolean => a.kind === b.kind && (a.kind !== 'load' || (b.kind === 'load' && a.url === b.url))
const copyAction = (a: GuardAction): GuardAction => a.kind === 'load' ? { kind: 'load', url: a.url } : { kind: a.kind }

/** Whether the guard runs at all: a live document that was shown or admitted (v1.12 r1 #3's "not guarded" list). */
export const guarded = (t: Tab): boolean => liveDoc(t)

/** The document is the one the operation bound. */
const sameDoc = (t: Tab, op: GuardOperation): boolean => (t.doc?.commits ?? 0) === op.commit && t.doc?.doc === op.doc

const covers = (t: Tab, op: GuardOperation): boolean => {
  const c = op.consent
  return !!c && c.tab === t.id && c.commit === op.commit && c.doc === op.doc && sameAction(c.action, op.action)
}

/** The rule of r3 #1, read in the act's turn: the same document, and fresh and clean now or covered by exactly its consent. */
export function mayGo(t: Tab, op: GuardOperation): boolean {
  if (!sameDoc(t, op)) return false
  if (freshUnsaved(t)) return false
  return freshClean(t) || covers(t, op)
}

/** Why a sheet would name this tab. */
export function sheetWhy(t: Tab): SheetWhy {
  if (!hasBridge(t)) return { kind: 'no-bridge', version: t.reg?.version }
  if (t.reports.safety === 'stale') {
    const held = t.reports.busy?.unsaved ? t.reports.busy.why.filter((w) => (UNSAVED_WHY as readonly string[]).includes(w)) : []
    return { kind: 'stale', stopped: t.reg?.state === 'gone', held }
  }
  return { kind: 'unknown' }
}

/** Step 1 refused (or the page did): the tab comes forward with the pill when the reason is unsaved work. */
function refuse(t: Tab, a: GuardAction, unsaved: boolean): GuardAnswer {
  const p = P()
  if (unsaved) t.held = { at: p.now(), action: a.kind }
  p.log?.('guard', { tab: t.id, action: a.kind, answer: 'refused', unsaved })
  if ((a.kind === 'quit' || a.kind === 'update' || unsaved) && !isActive(t)) activate(t.id)
  else p.changed()
  return 'refused'
}

/** One serialized operation per tab: the guard and its act (v1.13 r2 #2, v1.14 r3 #1). */
export async function guard(tab: Tab, action: GuardAction): Promise<GuardAnswer> {
  const p = P()
  if (tab.replacing) { p.log?.('guard', { tab: tab.id, action: action.kind, answer: 'refused', busy: true }); return 'refused' }
  const a = copyAction(action)
  const op: GuardOperation = { commit: tab.doc?.commits ?? 0, doc: tab.doc?.doc, action: a }
  tab.replacing = op
  try {
    if (!guarded(tab)) {
      p.log?.('guard', { tab: tab.id, action: a.kind, unguarded: true })
      return await p.act(tab, a)
    }
    if (freshUnsaved(tab)) return refuse(tab, a, true)
    if (!fresh(tab)) {
      const ok = await p.ask({ action: a, tabs: [{ id: tab.id, name: tabName(tab), why: sheetWhy(tab) }] })
      if (!ok) { p.log?.('guard', { tab: tab.id, action: a.kind, answer: 'refused', sheet: 'cancel' }); return 'refused' }
      op.consent = { tab: tab.id, commit: op.commit, doc: op.doc, action: a }
    }
    // after every wait, in the act's turn
    if (!mayGo(tab, op)) return refuse(tab, a, freshUnsaved(tab))
    const r = await p.act(tab, a)
    p.log?.('guard', { tab: tab.id, action: a.kind, answer: r })
    if (r === 'refused') return refuse(tab, a, true)
    return r
  } finally {
    if (tab.replacing === op) tab.replacing = undefined
    p.changed()
  }
}

/** Every canvas tab, for a quit or an update: one operation each, one shared step 1 and sheet; one refusal stops the whole. */
export async function guardAll(action: GuardAllAction): Promise<GuardAnswer> {
  const p = P()
  const a = copyAction(action) as GuardAllAction
  const list = ordered(allTabs()).filter((t) => t.kind === 'local' && guarded(t))
  const busy = allTabs().find((t) => t.replacing)
  if (busy) { p.log?.('guard', { all: a.kind, answer: 'refused', busy: busy.id }); if (!isActive(busy)) activate(busy.id); return 'refused' }
  const ops = new Map<Tab, GuardOperation>()
  for (const t of list) { const op: GuardOperation = { commit: t.doc?.commits ?? 0, doc: t.doc?.doc, action: a }; ops.set(t, op); t.replacing = op }
  try {
    const holder = list.find(freshUnsaved)
    if (holder) return refuse(holder, a, true)
    const ask = list.filter((t) => !fresh(t))
    if (ask.length) {
      const ok = await p.ask({ action: a, tabs: ask.map((t) => ({ id: t.id, name: tabName(t), why: sheetWhy(t) })) })
      if (!ok) { p.log?.('guard', { all: a.kind, answer: 'refused', sheet: 'cancel' }); return 'refused' }
      for (const t of ask) { const op = ops.get(t)!; op.consent = { tab: t.id, commit: op.commit, doc: op.doc, action: a } }
    }
    // a tab that came to hold a live document meanwhile was named by no step: the whole stops
    const newcomer = () => allTabs().find((t) => guarded(t) && !ops.has(t))
    // after the sheet, every tab in one turn before any closes
    for (const t of list) if (!mayGo(t, ops.get(t)!)) return refuse(t, a, freshUnsaved(t))
    for (const t of list) {
      // each close is a wait: the next tab is read again just before its own act
      const late = newcomer()
      if (late) return refuse(late, a, freshUnsaved(late))
      if (!mayGo(t, ops.get(t)!)) return refuse(t, a, freshUnsaved(t))
      const r = await p.act(t, a)
      if (r === 'refused') return refuse(t, a, true)
    }
    const late = newcomer()
    if (late) return refuse(late, a, freshUnsaved(late))
    p.log?.('guard', { all: a.kind, answer: 'done', tabs: list.map((t) => t.id) })
    return 'done'
  } finally {
    for (const [t, op] of ops) if (t.replacing === op) t.replacing = undefined
    p.changed()
  }
}

/** The guard's close, `guard(tab, { kind: 'close' })`: the view removed only after the page actually closed. */
export async function closeView(tab: Tab): Promise<'closed' | 'refused'> {
  return (await guard(tab, { kind: 'close' })) === 'done' ? 'closed' : 'refused'
}

// ---------------------------------------------------------------------------------------------------------------
// The sheet's words (main's words only: the page's text never reaches a native sheet, A2.14 #18)

const VERB: Record<GuardAction['kind'], string> = { close: 'Close', quit: 'Quit', update: 'Restart', reload: 'Reload', forceReload: 'Reload', tryAgain: 'Reload', load: 'Open' }

function words(why: readonly Why[]): string {
  const w = why.map((x) => WHY_WORDS[x]).filter((x): x is string => !!x)
  if (!w.length) return 'work not yet saved'
  return w.length === 1 ? w[0]! : `${w.slice(0, -1).join(', ')} and ${w.at(-1)}`
}

/** One tab's line on a sheet. */
export function sheetLine(name: string, why: SheetWhy): string {
  switch (why.kind) {
    case 'no-bridge': return `${name} runs Marver ${why.version ?? '0.27.0'}, which can't tell the app about unsaved work.`
    case 'unknown': return `${name} hasn't told the app yet whether it holds unsaved work.`
    case 'stale':
      if (why.stopped) return why.held.length ? `When ${name} stopped, it held ${words(why.held)}.` : `${name} stopped, so the app can't hear it any more: it may hold work made since.`
      return why.held.length ? `The app can't hear ${name} any more. When it last could, it held ${words(why.held)}.` : `The app can't hear ${name} any more: it may hold work made since.`
  }
}

/** The native sheet's words: the question, what it costs, and its buttons - Cancel first (the default, `Esc`). */
export function sheetText(s: Sheet): { message: string; detail: string; buttons: [string, string] } {
  const a = s.action
  const one = s.tabs.length === 1 ? s.tabs[0]! : null
  const message = a.kind === 'quit' ? 'Quit Marver anyway?'
    : a.kind === 'update' ? 'Restart to update anyway?'
      : a.kind === 'load' ? `Open the link in ${one?.name ?? 'this canvas'} anyway?`
        : `${VERB[a.kind]} ${one?.name ?? 'it'} anyway?`
  const lines = s.tabs.map((t) => sheetLine(t.name, t.why))
  const cost = s.tabs.length > 1 ? 'What they haven\'t saved is lost.' : 'What it hasn\'t saved is lost.'
  return { message, detail: `${lines.join('\n')}\n\n${cost}`, buttons: ['Cancel', VERB[a.kind]] }
}

/** The theme a tab and its page wear right now. */
export const tabDark = (t: Tab | undefined): boolean => darkOf(t, P().appDark())
