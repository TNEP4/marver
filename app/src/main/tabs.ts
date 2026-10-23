/**
 * The tab model (spec 28 A2.4, A2.14 #20, #23, v1.12 r1 #3, #5, v1.13 r2 #1-#3). Owner: the window stream.
 *
 * SKELETON (ship stream): the frozen contracts - the `Tab` record, the guard's signatures, `tabs.json`'s
 * shape - and stubs. One field group per concern, one writer each; `displayState` and the tab page are pure
 * functions of the record. The guard's semantics are being finalised in spec v1.13 (r2 #1-#4): what is here
 * is its shape only.
 */
import type { DisplayState } from '../shared/channels.ts'
import type { Busy, MenuItem, Theme } from '../../../src/shared/app-api.ts'

export type TabKind = 'local' | 'home' | 'settings'   // 'remote' from A4

/** The registry's facts about the tab's canvas (writer: the registry). */
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
}

/** The view (writer: window.ts / tabs.ts). `unloaded` is A3's. */
export type TabViewState = 'none' | 'live' | 'crashed'

/** The committed document and its trust (writer: the adapter, nav.ts). */
export interface TabDoc {
  gen: number
  url: string
  trusted: boolean
  /** minted at the trusted commit and sent as `mv:admit` (v1.12 r1 #1) */
  doc?: string
  /** commits of this tab, counted (v1.13 r2 #2) */
  commits: number
  shown: boolean
}

/** The current document's safety (v1.12 r1 #2, v1.13 r2 #1): unknown until its first report; stale once main can no longer hear it. */
export type Safety = 'unknown' | 'fresh' | 'stale'

/** The current document's last reports (writer: the bridge). */
export interface TabReports { safety: Safety; busy?: Busy; theme?: Theme; menu?: MenuItem[] }

/** The crash record (writer: tabpage.ts `recover`). */
export interface TabCrash { count: number; lastAuto?: number; latched: boolean }

export interface Tab {
  /** main's opaque id, `t` and a counter, stable for the tab's life (A2.14 #10) */
  id: string
  kind: TabKind
  name: string
  reg?: TabReg
  view: TabViewState
  doc?: TabDoc
  reports: TabReports
  crash: TabCrash
  /** a failed load may have left the shown page alive beneath its tab page (v1.13 r2 #3) */
  retained: boolean
  /** the replacement in flight, one per tab (v1.13 r2 #2) */
  replacing?: GuardHow
  /** false: closed by the person for this canvas's run (Home still lists it) */
  open: boolean
  /** the shell's own document only: `/` or `/index.html`, its query and hash (v1.12 r1 #5) */
  path: string
  root?: string
  shownAt?: number
  hiddenAt?: number
}

/** A2.4's state, a pure function of the record. */
export function displayState(_tab: Tab, _active: boolean): DisplayState {
  throw new Error('tabs.ts: displayState is the window stream\'s (spec 28 A2.14 #20)')
}

/** Every way the app replaces a canvas's live document (v1.12 r1 #3). */
export type GuardHow = 'close' | 'quit' | 'update' | 'reload' | 'force-reload' | 'load'

/** One serialized operation per tab: the guard and its act (v1.13 r2 #2). */
export async function guard(_tab: Tab, _how: GuardHow): Promise<'done' | 'refused'> {
  throw new Error('tabs.ts: guard is the window stream\'s (spec 28 A2.2, A2.14 #16, v1.13 r2 #2)')
}

/** Every canvas tab, for a quit or an update: each record checked before any is closed. */
export async function guardAll(_how: 'quit' | 'update'): Promise<'done' | 'refused'> {
  return 'done'   // the skeleton holds no canvas tab
}

/** The guard's close: the view removed only after the page actually closed. */
export async function closeView(_tab: Tab): Promise<'closed' | 'refused'> {
  throw new Error('tabs.ts: closeView is the window stream\'s (spec 28 A2.2)')
}

/** `<state>/tabs.json` (v1.12 r1 #5). A file with another `v`, or a bad shape, goes aside as `tabs.json.bad`. */
export interface TabsFile {
  v: 1
  active: { kind: 'home' } | { kind: 'settings' } | { kind: 'canvas'; ws: string; origin: string }
  /** at most 20, newest shown first */
  canvases: { ws: string; origin: string; path: string; shownAt: number }[]
  settings: boolean
  /** closes for that canvas's run (A2.14 #23) */
  closed: { ws: string; instance: string }[]
}

export interface Tabs {
  all(): Tab[]
  active(): Tab | undefined
}

/** At ready, after the window: Home, then the canvases the registry holds (restored per `restoreTabs`). */
export function startTabs(): Tabs {
  return { all: () => [], active: () => undefined }
}
