/**
 * The tab model (spec 28 A2.4, A2.14 #20, #23, v1.12 r1 #3, #5, v1.13 r2 #1-#3, v1.14 r3 #1-#3). Owner: the
 * window stream.
 *
 * SKELETON (ship stream): the frozen contracts - the `Tab` record, the guard's action and signatures,
 * `tabs.json`'s shape - and stubs. One field group per concern, one writer each; `displayState` and the tab page
 * are pure functions of the record. The guard's semantics are spec v1.14's (r2 #1-#4, r3 #1): what is here is
 * its shape only.
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
  /** the replacement in flight, one per tab, with its action and any consent (v1.13 r2 #2, v1.14 r3 #1, #2) */
  replacing?: GuardOperation
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

/**
 * One serialized operation per tab: the guard and its act (v1.13 r2 #2). After every wait, in the turn of its act,
 * it goes on only when the tab's document is the one it bound and either the tab is fresh and clean now or a
 * consent covers exactly that tab, document and action; else 'refused' (v1.14 r3 #1).
 */
export async function guard(_tab: Tab, _action: GuardAction): Promise<'done' | 'refused'> {
  throw new Error('tabs.ts: guard is the window stream\'s (spec 28 A2.2, A2.14 #16, v1.13 r2 #2, v1.14 r3 #1)')
}

/** Every canvas tab, for a quit or an update: one operation each, one shared sheet, one refusal stops the whole. */
export async function guardAll(_action: GuardAllAction): Promise<'done' | 'refused'> {
  return 'done'   // the skeleton holds no canvas tab
}

/** The guard's close, `guard(tab, { kind: 'close' })`: the view removed only after the page actually closed. */
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
