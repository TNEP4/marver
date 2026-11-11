/**
 * The app pages' channels (spec 28 "Channels and who may use them", amended for app 0.1 by A2.14 #19,
 * v1.13 and v1.14): one typed list, read by `bridge.ts` (who may send what), the app preload and the pages. The canvas
 * channels live in the package's `src/shared/app-api.ts`, shared with the shell.
 *
 * DRAFT contract, frozen before the streams split (A2.14 #32). Owners: trust (bridge.ts checks every field in
 * main), window (tabs, pill, window, page:focus, tabpage), home and files (home, settings, recent). No
 * Electron or file-system imports: pages import it too.
 *
 * A4 (app 0.3) amends it, frozen before its streams split (A4.6 #56): a tab's marks (`TabView.marks`, #19), the
 * remote tab and its view (`TabKind` and `PageKind` `remote`, #39, #40, #49), the notices offer (`PillView.kind`
 * `offer`, #26), Settings' notices (`SettingsView.notices` and `settings:action`, #27), `link:open` without
 * `later` (#39) and Home's Shared canvases (`shared`, #47).
 *
 * Spec 32 (app 1.2) amends it in writing (F1, F3b #3), frozen before its streams split (G3), all additive: the tab's
 * Marver menu (`tab-menu`, `tab:menu-pick`, `tab:menu-shown`; `TabMenuView`, `MenuAsk`), `SENDERS` of `tab:menu` and
 * `tabs:more` narrowed to the strip, `WindowView.immersive`, `TabView.hung`, `TabMarks`' `kinds`, `stopped`, `top`
 * and `work`, `SharedLink.id`, Home's card actions (`copy-link`, `copy-path`, `reveal`, `HomeActionAnswer.why`) and
 * how Home's inputs were made (`via`, `keys`, `cancel`), which the bridge keeps from Home alone. No new page kind.
 *
 * Spec 33 (app 1.2.1), additive: Settings' Updates row (`SettingsView.update`, `UpdateRow`; `UpdateToken`,
 * `BlockedWhy` and `BLOCKED_TITLE` moved here from update-model.ts so the page can carry a token), `settings:action`'s
 * `update` and `release-notes`, and `settings:set` from Home with `via: 'key'` (D switches light and dark).
 */
import type { IconName } from '../pages/dom.ts'

/**
 * The kind `bridge.ts` records for each webContents it created. `remote` (A4.6 #40): a shared canvas's view - no
 * preload, no channels, never in `SENDERS`, no pinned page; recorded so `kindOf()` can answer for its permissions.
 */
export type PageKind = 'strip' | 'home' | 'settings' | 'tabpage' | 'canvas' | 'remote'
/** The app's own pages: the kinds the app preload serves, with channels of their own. */
export type AppPageKind = Exclude<PageKind, 'canvas' | 'remote'>

/** What a tab is (tabs.ts `Tab.kind`): a local canvas, a shared one opened by its https link (A4.6 #39), Home, Settings. */
export type TabKind = 'local' | 'remote' | 'home' | 'settings'

/**
 * What waits on the owner in a local canvas (A4.6 #19), from its server's live stream and main's own stop: set only
 * for a local tab with a snapshot or a stop, whatever its view state, so hidden and unloaded tabs keep theirs; Home,
 * Settings and remote tabs have none. The strip's one slot shows `needs` (orange), else `unseen` (blue), else
 * `working` (a sweep); `session` a teal dot on the logo, whatever the slot shows.
 */
export interface TabMarks {
  /** the stream's `counts.ask + review + failed + stalled` (exact past the 100-item cap), plus 1 for a stop not yet
   *  acknowledged (#20) */
  needs: number
  unseen: number
  working: boolean
  session: boolean
  /** the stream has been down `liveIdleMs`: drawn dimmed, "may be out of date" - never zero (#18) */
  stale?: boolean
  /** spec 32 F1 (notify.ts `marksOf`): the stream's canvas-wide `counts`, by kind */
  kinds?: { ask: number; review: number; failed: number; stalled: number }
  /** spec 32 F1: a stop main has not had acknowledged (the local stop map), with or without a held snapshot */
  stopped?: true
  /** spec 32 F1, D6.1: what Home's card leads with - the kind by D6.1's priority over the counts, and its board's title
   *  only when every one of that kind is on one board */
  top?: { kind: 'stopped' | 'ask' | 'failed' | 'stalled' | 'review'; board?: string }
  /** spec 32 F1: the stream's `work` (app-api.ts `LiveEvent.work`), its board as a title */
  work?: { board?: string; since: number }
}

/**
 * A2.4's display state. `displayState(tab)` in tabs.ts computes it. `unloaded` is A3's (A3.8 #43, #46): a hidden
 * tab whose document main unloaded under memory pressure - the strip and Home dim its logo and add "unloaded" to its
 * name; shown again it reopens under its `reopening` tab page.
 */
export type DisplayState = 'none' | 'live' | 'hidden' | 'gone' | 'starting' | 'unverified' | 'unreachable' | 'crashed' | 'unloaded'

export interface TabView {
  id: string
  kind: TabKind
  /**
   * The canvas's name as its shell shows it (the slot file's `name`). For an `unverified` tab the pages never show
   * it: they name the tab by its link's host ("localhost:4808, not a Marver canvas", A2.13; frame mac-app/05), so
   * main may send either and no page wears a name a canvas has not proved.
   */
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
  /**
   * Whether the canvas's slot file offers the bridge (`features: ['bridge']`, A2.9; 0.27.1 on): the guard's own fact
   * (tabs.ts hasBridge), so Home's "Update to Marver 0.27.2" note and the degraded guard never disagree - a canvas
   * built from 0.27.1's code still reads 0.27.0 until its release. Absent for a tab with no registry entry.
   */
  bridge?: boolean
  link?: string
  /** a `data:` URL main checked (A2.4) */
  logo?: string
  /** the tab's own look (A2.14 #26) */
  dark?: boolean
  /**
   * 0-7: which of the eight initials hues (A2.4) a tab without a logo wears, picked by main from `workspaceId` -
   * `hueOf(ws)` in src/shared/hue.ts. Optional (added by the pages stream): absent, the page picks one from the name.
   */
  hue?: number
  /** A4 (A4.6 #19): what waits on the owner in this local canvas */
  marks?: TabMarks
  /** spec 31 E4: a newer release of Marver than this canvas runs (Home's card: "<update> available" and its command) */
  update?: string
  /** spec 32 F1: Chromium's hang monitor says its renderer does not respond (tabs.ts `Tab.hung`) - Home's "Not responding" */
  hung?: boolean
}

/** `tabs` (main to strip, home). */
export interface TabsSnapshot { rev: number; active: string; tabs: TabView[] }

/** `tabs:more` (strip to main): the ids the strip put behind `»`, and where to pop the menu; spec 32 adds `MenuAsk`. */
export interface TabsMore { ids: string[]; x: number; y: number }

/**
 * Spec 32 B2: added to `tab:menu {id, x, y}` and `tabs:more {ids, x, y}` - how the menu was asked for (B3.1, B14). `key`:
 * ContextMenu, ⇧F10, or Enter or Space on `#more`; `hadFocus`: the strip had keyboard focus before the press. Booleans,
 * absent reading false, so an older strip reads as a pointer open with no focus.
 */
export interface MenuAsk { key: boolean; hadFocus: boolean }

/** Spec 32 B2: `tab-menu` (main to strip): the menu to show, or null to close it. */
export interface TabMenuView {
  rev: number
  /** where it opens, in strip CSS px (= window content px) */
  x: number; y: number
  kind: 'tab' | 'more'
  rows: TabMenuRow[]
}
/** A row of the strip's Marver menu: the icon by name only (dom.ts `IconName`), never a path from main. */
export type TabMenuRow =
  | { kind: 'item'; id: string; label: string; icon?: IconName; enabled: boolean; checked?: boolean }
  | { kind: 'sep' }
/** Spec 32 B2: `tab:menu-pick` (strip to main): the row chosen, or null for a close with no pick. No `via`: a pick
 *  records what the native click recorded. */
export interface TabMenuPick { rev: number; id: string | null }
/** Spec 32 B2: `tab:menu-shown` (strip to main): the menu is on screen. */
export interface TabMenuShown { rev: number }

/** `window` (main to every app page): replaces `focus`. */
export interface WindowView {
  rev: number; focused: boolean; fullScreen: boolean
  /**
   * The strip draws the still dots under its tabs now (A3.8 #3, #29): while app 0.1's plain cover is shown - the look
   * 0.1 had, kept until spike S15 chooses a cover (with one chosen, never: the cover or plain ground holds them, #29).
   * Absent reads false.
   */
  dots?: boolean
  /** spec 32 C10: immersive play hides the strip - `body.immersive` runs its CSS out (no-drag first). Absent reads false */
  immersive?: boolean
  /**
   * spec 32 C9 amendment (Nic, 11 Nov): the strip, run out, is now the 16 px band main keeps at the window's top while
   * immersive - `body.band`: every control hidden, no pointer target, the body a drag region. Absent reads false
   */
  band?: boolean
}

/** `page:focus` (main to the strip and a tab page): A2.13's focus rule and F6. */
export interface PageFocus { target: 'active-tab' | 'heading' }

/** `pill` (main to strip), or null: the one pill main chose (A2.2). */
export interface PillView {
  rev: number
  /** `offer` (A4.6 #26): "Get a notice when a canvas needs you", Turn On, dismissible - tier 4, beside `test` */
  kind: 'unsaved' | 'stopped' | 'not-responding' | 'confirmation' | 'files' | 'test' | 'offer'
    /** A5.1 #21: the updater's pill, tier 5 after `offer` - ready (Restart to Update), waiting (Try Again), failed (Download) */
    | 'update'
  lead?: string
  text: string
  short: string
  icon?: 'check'
  button?: { label: string; style: 'plain' | 'accent' | 'cmd' }
  tooltip?: string
  dismissible?: boolean
}
/** `via` (spec 30 #50): `key`, Esc on a dismissible pill; absent reads a click. */
export interface PillAction { rev: number; act: 'button' | 'dismiss'; via?: 'key' }

/**
 * What main's probe of a failed tab's address last found (A2.11, v1.14 r3 #3, #4): A2.3's retries, A2.11's 5 s
 * check and the registry, whichever ran last; `none` again at each failure. Only `proved` names the canvas.
 * Main sends a new snapshot when `state` changes; `lastAt` rides along with the next one (never a `rev` bump).
 */
export interface TabPageProbe {
  /** no probe yet, no answer, an answer with no proof, the tab's own canvas proved */
  state: 'none' | 'silent' | 'answers' | 'proved'
  /** the last probe's time; null before the first */
  lastAt: number | null
}
/** On `stopped`, `unverified` and `unreachable` alike (v1.13 r2 #3, v1.14 r3 #3). */
interface TabPageFailure {
  /** a failed load may have left the shown page alive beneath (the tab record's `retained`) */
  retained: boolean
  probe: TabPageProbe
}

/** `tabpage` (main to a tab page): the state as a union; timestamps only, never a countdown (A2.14 #19). */
interface TabPageBase {
  rev: number; name: string; logo?: string; dark?: boolean; folder?: string; since: number
  /** as `TabView.hue` (optional, added by the pages stream): the tab page wears the strip's initials hue */
  hue?: number
}
export type TabPageView =
  | TabPageBase & { page: 'starting'; phase: 'starting' | 'opening' }
  | TabPageBase & TabPageFailure & { page: 'stopped'; command: string; origin?: string }
  | TabPageBase & TabPageFailure & { page: 'unverified'; origin: string; host?: string }
  | TabPageBase & TabPageFailure & { page: 'unreachable'; origin: string; reason?: string }
  | TabPageBase & { page: 'crashed'; latched: boolean; reason?: string; crashes?: number }
  /**
   * A3 (A3.8 #42, #43): an unloaded tab opening again on its saved path, or an activation queued while its unload's
   * close is outstanding. `unloadedAt`: the act's start, then the time it unloaded ("Unloaded at 14:02");
   * `cameraKept`: false when the tab was rebound to another origin while unloaded (camera storage is per origin) -
   * the page then promises the board alone.
   */
  | TabPageBase & { page: 'reopening'; unloadedAt: number; cameraKept: boolean }
/** `export-report` (A5.1 #28): the crashed page's latched state, beside Copy Details */
export type TabPageAction = 'retry' | 'reload' | 'copy-start' | 'copy-details' | 'reveal' | 'open-browser' | 'close' | 'export-report'

/**
 * `recent` (main to home): Recently here (A2.12). `id` is main's (`r_` and the workspace, within the bridge's id
 * pattern `[A-Za-z0-9_-]{1,32}`); `folder` with `~`. `hue` as `TabView.hue`.
 */
export interface RecentView {
  id: string; name: string; folder: string; lastSeen: number; logo?: string; hue?: number
  /** spec 31 D1: the canvas a `marver://` link named while it does not run - first, highlighted, with its start command */
  linked?: true
}

/** `home:info` (main to home). */
export interface HomeInfo { welcome: boolean; writable: boolean }
/** `home:focus` (main to home). */
export type HomeFocus =
  | { field: 'link'; back?: string }
  /** spec 31 D1: a `marver://` link to a canvas not running - its card, highlighted and its start command focused */
  | { field: 'recent'; id: string }
/** Spec 32 D8.8: the key that made a Home activation or menu pick. */
export type HomeKeys = 'Enter' | 'Space'
/**
 * Spec 32 D8.8: how a Home menu row was picked - absent reads a click; `via: 'key'` with the key pressed. The bridge
 * keeps both only from Home.
 */
export interface HomeVia { via?: 'key'; keys?: HomeKeys }
/** `home:action` (home to main; an invoke, `INVOKES`, answering `HomeActionAnswer`). */
export type HomeAction = HomeVia & (
  | { action: 'copy'; id: 'dev' | 'init' | 'update' }
  /** `id` a recent's `r_<ws>` or (spec 32 D8.1) a gone tab's id */
  | { action: 'copy-start'; id: string }
  /** spec 31 E4: a running canvas's update command, in its folder - `id` its tab */
  | { action: 'copy-update'; id: string }
  | { action: 'show-files' }
  /**
   * spec 32 D8.1: a card's Copy link, Copy path, Reveal in Finder - `id` a tab's id, a recent's `r_<ws>` or a past shared
   * link's `s_<hash>`; main resolves root, link or url from its own records, never from Home
   */
  | { action: 'copy-link' | 'copy-path' | 'reveal'; id: string }
)

/** `home:action`'s answer: false when there was nothing to do (a recent id main no longer holds); `why` (spec 32 D8.1)
 *  `missing` when the card, or a field its action needs, is not there. */
export interface HomeActionAnswer { ok: boolean; why?: 'missing' }

/**
 * `link:open` (strip, home; an invoke). An https link opens a shared canvas's tab (A4.6 #39): never `later` from A4. Its
 * message may say `via: 'click'` (spec 30 #50: a past shared canvas's card); absent reads Return in the field.
 */
export type LinkOpenAnswer = { ok: true } | { ok: false; why: 'bad' | 'nothing' | 'not-canvas' | 'refused' }

/**
 * `shared` (main to home, A4.6 #47): Home's Shared canvases - links opened before, newest first, at most 12, each `url`
 * a shell destination of its origin (never a sign-in URL); a card's click sends `link:open` with its `url`.
 */
export interface SharedLink {
  url: string; host: string; lastSeen: number
  /** spec 32 F1: Home's view only - `s_` and the first 16 hex of sha256 over the link's origin (within the bridge's id
   *  pattern), so a past card's Copy link names it by id */
  id?: string
  /** spec 31 E3: what its `meta.json` named it, and its logo - read through its tab's session, kept by origin (Home's view only) */
  name?: string
  logo?: string
}

/**
 * Settings, a view of the files (A2.7, A2.12; the home-and-files stream). `settings:get` answers a `SettingsView`;
 * `status` (main to settings) pushes a `FilesStatus` whenever a file is judged or a write fails or recovers, and
 * the page asks `settings:get` again. `notices` joins at A4.2 (A4.6 #27).
 */
export interface FileProblem { key?: string; message: string }
/** What main last judged of one file, and what is in force. Written whole into `state/status.json` (README rule). */
export interface FileState {
  present: boolean
  ok: boolean
  /** sha256 (hex) of the bytes last judged; '' when absent */
  sha256: string
  problems?: FileProblem[]
  /** what is in force: the last file that applied (this run, or `status.json`'s at launch), else the defaults ('') */
  applied: { sha256: string; values: Record<string, unknown> }
}
export interface FilesStatus {
  v: 1
  /** the app's version */
  app: string
  at: number
  writable: boolean
  /** why the home cannot be written (an errno code) */
  reason?: string
  files: { 'config.json': FileState; 'theme.json': FileState }
  /** the last failed app-owned write, until that file writes again */
  write?: { file: string; code: string; at: number }
}
export interface SettingsFileView extends FileState {
  /** effective values: the defaults, then what is applied */
  values: Record<string, unknown>
  /** the file's text, only when it does not apply (at most 64 KB; shown as text) */
  text?: string
}
export interface SettingsView {
  /** the folder, with `~` */
  dir: string
  /** where an agent checks its edit, with `~`: `state/status.json`, `state-dev/status.json` in Marver Dev */
  statusFile: string
  config: SettingsFileView
  theme: SettingsFileView
  status: FilesStatus
  /** the keys this build shows, as `<file>.<key>` (settings-keys.ts `since`) */
  shown: string[]
  /**
   * A4 (A4.6 #25, #27): what macOS did with the last notice posted - `accepted` (it took the request: never a claim
   * that it was seen), `failed` (it could not schedule it: the row says "macOS couldn't post Marver's last notice"; a notice macOS hides - Don't Allow, a Focus - still reads `accepted`),
   * `unknown` (none posted yet). `state/notices.json`'s `lastOutcome`, absent reading `unknown`.
   */
  notices: { outcome: 'unknown' | 'accepted' | 'failed' }
  /** spec 33 C2: the Updates row */
  update: UpdateRow
}
/** `settings:set` (settings and Home to main; an invoke): one key into one file. `via: 'key'` (spec 33 D): D's theme
 *  switch; absent reads a click. From Home the bridge takes only `theme mode` light or dark. */
export interface SettingsSet { file: 'config' | 'theme'; key: string; value: boolean | number | string; via?: 'key' }
export type SettingsSetResult =
  | { ok: true }
  | { ok: false; why: 'unknown-key' | 'bad-value' | 'unwritable' | 'write-failed'; code?: string }
/** `settings:action` (settings to main; a send, A4.6 #27): the Notices row's Open System Settings; spec 33 C4, C5: the
 *  Updates row's button (its token, acted on only while it holds) and Release notes (main builds the link). */
export type SettingsAction =
  | { action: 'open-notification-settings' }
  | { action: 'release-notes' }
  | { action: 'update'; token: UpdateToken }

/** Why the updater is blocked (spec 28 A5.1 #13). */
export type BlockedWhy = 'feed' | 'location' | 'write' | 'setup'
/** What a click acts on (A5.1 #21, #22): its act and the state and version it was offered for. */
export type UpdateToken =
  | { act: 'check' }
  | { act: 'restart' | 'try-again' | 'download' | 'dismiss'; version: string }
  | { act: 'explain'; why: Exclude<BlockedWhy, 'feed'> }
/** A blocked updater's title (#22): the alert's message, and Settings' state line (spec 33 C3). */
export const BLOCKED_TITLE: Record<Exclude<BlockedWhy, 'feed'>, string> = {
  location: 'Marver updates itself only from the Applications folder',
  write: "Marver can't update itself here",
  setup: "Marver can't check for updates",
}
/** Settings' Updates row (spec 33 C2, C3): one more view of the updater's state, beside the pill and the menu. */
export interface UpdateRow {
  show: 'off' | 'blocked' | 'idle' | 'current' | 'checking' | 'downloading' | 'ready' | 'waiting' | 'restarting' | 'error' | 'failed'
  /** the version running */
  version: string
  /** ready, waiting, restarting, failed: the version it goes to */
  next?: string
  /** ready, waiting: the feed's notes, one per non-empty line, "- " stripped, at most 5 */
  notes?: string[]
  /** waiting: the tab whose unsaved work holds it */
  tab?: string
  /** blocked */
  why?: Exclude<BlockedWhy, 'feed'>
  /** the last check's end (wall clock), this launch */
  checkedAt: number | null
  /** the button's; null: none, or disabled */
  token: UpdateToken | null
}

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
  /** A4 (A4.6 #27, #47) */
  settingsAction: 'settings:action',
  shared: 'shared',
  /** spec 32 B2: the strip's Marver menu - main's view (to strip), the pick and the shown ack (strip to main) */
  tabMenuView: 'tab-menu',
  tabMenuPick: 'tab:menu-pick',
  tabMenuShown: 'tab:menu-shown',
} as const

/**
 * The page-to-main channels that are invokes (`ipcRenderer.invoke` / `ipcMain.handle`, the handler's return value
 * the answer); every other channel in `SENDERS` is a send (`ipcRenderer.send` / `ipcMain.on`). The preload, the
 * bridge and the pages harness all read this list (added by the pages stream: the draft named `link:open` alone).
 *   link:open    -> LinkOpenAnswer
 *   home:action  -> HomeActionAnswer
 *   settings:get -> SettingsView
 *   settings:set -> SettingsSetResult
 */
export const INVOKES = [CH.linkOpen, CH.homeAction, CH.settingsGet, CH.settingsSet] as const
export type InvokeChannel = (typeof INVOKES)[number]
export const isInvoke = (ch: string): ch is InvokeChannel => (INVOKES as readonly string[]).includes(ch)

/** Who may SEND each page-to-main channel (bridge.ts refuses anyone else, A2.5). */
export const SENDERS: Record<string, readonly PageKind[]> = {
  [CH.ready]: ['strip', 'home', 'settings', 'tabpage'],
  [CH.tabsMore]: ['strip'],
  [CH.tabActivate]: ['strip', 'home'],
  [CH.tabClose]: ['strip', 'home'],
  // spec 32 B2: the strip alone - Home's menus are its own DOM (D8)
  [CH.tabMenu]: ['strip'],
  [CH.linkOpen]: ['strip', 'home'],
  [CH.pillAction]: ['strip'],
  [CH.tabpageAction]: ['tabpage'],
  [CH.homeAction]: ['home'],
  [CH.settingsGet]: ['settings'],
  // spec 33 D: Home's D, `theme mode` light or dark alone (the bridge)
  [CH.settingsSet]: ['settings', 'home'],
  [CH.settingsReveal]: ['settings'],
  [CH.settingsAction]: ['settings'],
  // spec 32 B2: the strip's menu - no input of their own (the pick records what `tabAct` opens)
  [CH.tabMenuPick]: ['strip'],
  [CH.tabMenuShown]: ['strip'],
}

/** Main-to-page channels each kind receives: the app preload subscribes to these alone (added by the pages stream). */
export const RECEIVES: Record<AppPageKind, readonly string[]> = {
  strip: [CH.tabs, CH.window, CH.pill, CH.pageFocus, CH.tabMenuView],
  home: [CH.tabs, CH.window, CH.recent, CH.homeInfo, CH.homeFocus, CH.shared],
  settings: [CH.window, CH.status],
  tabpage: [CH.window, CH.tabpage, CH.pageFocus],
}

/**
 * What the app preload (src/preload/app.ts) exposes as `window.marverPage` (added by the pages stream): narrow named
 * methods for the one page kind it finds at document start (`marver-app://<kind>/`), never a generic send.
 * Subscriptions get the payload alone (no Electron event), the latest held value at once, and after it only a
 * newer `rev` (A2.14 #19). `ready()` says `app:ready` once; main sends a page nothing before it, then every snapshot
 * its kind receives. `window` reaches every app page.
 */
type Off = () => void
interface PageApiBase {
  ready(): void
  onWindow(fn: (w: WindowView) => void): Off
}
/** Spec 30 #50: how a strip or Home tab was chosen - `tab:activate`'s `via` (allowlisted by the bridge), so the
 *  `tab-activate` command records it; absent reads `click`. */
export type ActivateVia = 'key' | 'click'
/**
 * `tab:activate`'s payload. Spec 32 D8.8 (Home only, kept by the bridge from Home alone): `cancel` - the link field's
 * Escape, back to the tab ⌘L came from; `keys` - a card activated by Enter or Space.
 */
export interface TabActivate { id: string; via?: ActivateVia; cancel?: true; keys?: HomeKeys }
export interface StripApi extends PageApiBase {
  readonly kind: 'strip'
  onTabs(fn: (s: TabsSnapshot) => void): Off
  onPill(fn: (p: PillView | null) => void): Off
  onPageFocus(fn: (f: PageFocus) => void): Off
  /** spec 32 B2: main's menu view, or null to close it */
  onTabMenu(fn: (v: TabMenuView | null) => void): Off
  activate(id: string, via?: ActivateVia): void
  close(id: string): void
  /** spec 32 B2: the ask optional until the strip passes it (absent reads false) */
  tabMenu(id: string, x: number, y: number, ask?: Partial<MenuAsk>): void
  more(m: TabsMore & Partial<MenuAsk>): void
  /** spec 32 B2: the row chosen, or null */
  menuPick(p: TabMenuPick): void
  /** spec 32 B2: the menu of this rev is on screen */
  menuShown(p: TabMenuShown): void
  pillAction(a: PillAction): void
  openLink(url: string, via?: 'click'): Promise<LinkOpenAnswer>
}
export interface HomeApi extends PageApiBase {
  readonly kind: 'home'
  onTabs(fn: (s: TabsSnapshot) => void): Off
  onRecent(fn: (r: RecentView[]) => void): Off
  onHomeInfo(fn: (i: HomeInfo) => void): Off
  onHomeFocus(fn: (f: HomeFocus) => void): Off
  /** A4 (A4.6 #47): the Shared canvases list */
  onShared(fn: (s: SharedLink[]) => void): Off
  /** spec 32 D8.8: Home's own - `cancel: true` and `keys` are sent only when given and valid */
  activate(id: string, via?: ActivateVia, o?: { cancel?: true; keys?: HomeKeys }): void
  close(id: string): void
  /** spec 32 D8.8: `via: 'key'` with `keys` - a past shared link's card by key */
  openLink(url: string, via?: 'click' | 'key', keys?: HomeKeys): Promise<LinkOpenAnswer>
  /** spec 32 D8.8: `via` and `keys` sent when given */
  action(a: HomeAction): Promise<HomeActionAnswer>
  /** spec 33 D: D's switch - `settings:set theme mode` with `via: 'key'` */
  setTheme(mode: 'light' | 'dark'): Promise<SettingsSetResult>
}
export interface SettingsApi extends PageApiBase {
  readonly kind: 'settings'
  onStatus(fn: (s: FilesStatus) => void): Off
  get(): Promise<SettingsView>
  set(s: SettingsSet): Promise<SettingsSetResult>
  reveal(): void
  /** A4 (A4.6 #27): Open System Settings, on the Notifications pane; spec 33: the Updates row's button, Release notes */
  action(a: SettingsAction): void
}
export interface TabPageApi extends PageApiBase {
  readonly kind: 'tabpage'
  onTabpage(fn: (v: TabPageView) => void): Off
  onPageFocus(fn: (f: PageFocus) => void): Off
  action(rev: number, action: TabPageAction): void
}
export type PageApi = StripApi | HomeApi | SettingsApi | TabPageApi
