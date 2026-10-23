/**
 * The app pages' channels (spec 28 "Channels and who may use them", amended for app 0.1 by A2.14 #19 and
 * v1.13): one typed list, read by `bridge.ts` (who may send what), the app preload and the pages. The canvas
 * channels live in the package's `src/shared/app-api.ts`, shared with the shell.
 *
 * DRAFT contract, frozen before the streams split (A2.14 #32). Owners: trust (bridge.ts checks every field in
 * main), window (tabs, pill, window, page:focus, tabpage), home and files (home, settings, recent). No
 * Electron or file-system imports: pages import it too.
 */

/** The kind `bridge.ts` records for each webContents it created. */
export type PageKind = 'strip' | 'home' | 'settings' | 'tabpage' | 'canvas'

/** A2.4's display state (`unloaded` and `reopening` are A3's). `displayState(tab)` in tabs.ts computes it. */
export type DisplayState = 'none' | 'live' | 'hidden' | 'gone' | 'starting' | 'unverified' | 'unreachable' | 'crashed'

export interface TabView {
  id: string
  kind: 'local' | 'home' | 'settings'
  name: string
  state: DisplayState
  verified: boolean
  /** 1-8, 9 for the last canvas tab (A2.4, A2.14 #23) */
  key?: number
  /** false for a running canvas whose tab the person closed: Home lists it, the strip does not */
  open: boolean
  slot?: number
  /** shown with `~` */
  folder?: string
  version?: string
  link?: string
  /** a `data:` URL main checked (A2.4) */
  logo?: string
  /** the tab's own look (A2.14 #26) */
  dark?: boolean
}

/** `tabs` (main to strip, home). */
export interface TabsSnapshot { rev: number; active: string; tabs: TabView[] }

/** `tabs:more` (strip to main): the ids the strip put behind `»`, and where to pop the menu. */
export interface TabsMore { ids: string[]; x: number; y: number }

/** `window` (main to every app page): replaces `focus`. */
export interface WindowView { rev: number; focused: boolean; fullScreen: boolean }

/** `page:focus` (main to the strip and a tab page): A2.13's focus rule and F6. */
export interface PageFocus { target: 'active-tab' | 'heading' }

/** `pill` (main to strip), or null: the one pill main chose (A2.2). */
export interface PillView {
  rev: number
  kind: 'unsaved' | 'stopped' | 'not-responding' | 'confirmation' | 'files' | 'test'
  lead?: string
  text: string
  short: string
  icon?: 'check'
  button?: { label: string; style: 'plain' | 'accent' | 'cmd' }
  tooltip?: string
  dismissible?: boolean
}
export interface PillAction { rev: number; act: 'button' | 'dismiss' }

/** `tabpage` (main to a tab page): the state as a union; timestamps only, never a countdown (A2.14 #19). */
interface TabPageBase { rev: number; name: string; logo?: string; dark?: boolean; folder?: string; since: number }
export type TabPageView =
  | TabPageBase & { page: 'starting'; phase: 'starting' | 'opening' }
  | TabPageBase & { page: 'stopped'; command: string; origin?: string; retained?: boolean }
  | TabPageBase & { page: 'unverified'; origin: string; host?: string }
  | TabPageBase & { page: 'unreachable'; origin: string; reason?: string }
  | TabPageBase & { page: 'crashed'; latched: boolean; reason?: string; crashes?: number }
export type TabPageAction = 'retry' | 'reload' | 'copy-start' | 'copy-details' | 'reveal' | 'open-browser' | 'close'

/** `recent` (main to home): Recently here (A2.12). `id` is main's; `folder` with `~`. */
export interface RecentView { id: string; name: string; folder: string; lastSeen: number; logo?: string }

/** `home:info` (main to home). */
export interface HomeInfo { welcome: boolean; writable: boolean }
/** `home:focus` (main to home). */
export interface HomeFocus { field: 'link'; back?: string }
/** `home:action` (home to main). */
export type HomeAction =
  | { action: 'copy'; id: 'dev' | 'init' | 'update' }
  | { action: 'copy-start'; id: string }
  | { action: 'show-files' }

/** `link:open` (strip, home; an invoke). */
export type LinkOpenAnswer = { ok: true } | { ok: false; why: 'bad' | 'nothing' | 'not-canvas' | 'later' | 'refused' }

/** The channel names. */
export const CH = {
  ready: 'app:ready',
  tabs: 'tabs',
  tabsMore: 'tabs:more',
  tabActivate: 'tab:activate',
  tabClose: 'tab:close',
  tabMenu: 'tab:menu',
  linkOpen: 'link:open',
  window: 'window',
  pageFocus: 'page:focus',
  pill: 'pill',
  pillAction: 'pill:action',
  tabpage: 'tabpage',
  tabpageAction: 'tabpage:action',
  recent: 'recent',
  homeInfo: 'home:info',
  homeFocus: 'home:focus',
  homeAction: 'home:action',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsReveal: 'settings:reveal',
  status: 'status',
} as const

/** Who may SEND each page-to-main channel (bridge.ts refuses anyone else, A2.5). */
export const SENDERS: Record<string, readonly PageKind[]> = {
  [CH.ready]: ['strip', 'home', 'settings', 'tabpage'],
  [CH.tabsMore]: ['strip'],
  [CH.tabActivate]: ['strip', 'home'],
  [CH.tabClose]: ['strip', 'home'],
  [CH.tabMenu]: ['strip', 'home'],
  [CH.linkOpen]: ['strip', 'home'],
  [CH.pillAction]: ['strip'],
  [CH.tabpageAction]: ['tabpage'],
  [CH.homeAction]: ['home'],
  [CH.settingsGet]: ['settings'],
  [CH.settingsSet]: ['settings'],
  [CH.settingsReveal]: ['settings'],
}
