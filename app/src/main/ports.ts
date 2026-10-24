/**
 * The home-and-files stream's main-side API: who calls what, when, and with what (spec 28 A2.7, A2.12, A2.14 #24,
 * #32). FROZEN beside channels.ts and tabs.ts's guard - the trust and window streams build against it (added by the
 * pages stream after review: the draft froze the channels alone). Types only: home.ts and config.ts export
 * `homePorts` and `filesPorts`, which `satisfies` these, so a drift fails the typecheck.
 *
 * At integration, in main.ts at ready, once the bridge and the tabs exist - one call wires the pages:
 *
 *   mountPages(bridge, { running, onRunningChange, linkPorts, setFilesPill: (p) => setCondition('files', p) })
 *
 * which mounts `home:action`, `link:open`, `settings:get` and `settings:set` as invokes (channels.ts `INVOKES`) and
 * `settings:reveal` as a send, pushes `home:info` and `recent` to Home and `status` to Settings at their
 * `app:ready` and on every change, and feeds the files pill. The calls it cannot make are the other streams':
 *
 * | Who    | When                                                               | Calls                                   |
 * |--------|--------------------------------------------------------------------|-----------------------------------------|
 * | main   | before ready, in A2.14 #30's order                                 | ensureHome, readFiles, startHome        |
 * | main   | at ready                                                           | applyTheme, startFiles, mountPages      |
 * | trust  | a canvas tab's first trusted commit of each instance               | noteVerified({ ws, root, name, ... })   |
 * | window | Home's view: its first did-finish-load while Home is the active tab| noteHomeShown()                         |
 * | window | the registry says a canvas went away                               | noteGone(ws)                            |
 * | window | restore: is this the very first launch (Home active)               | isFirstLaunch()                         |
 * | window | restore: `restoreTabs` on                                          | readTabsFile()                          |
 * | window | every change of the tabs' saved state                              | tabsWriter().set(file)                  |
 * | window | the quit: as it starts, and again once guardAll answered 'done'    | tabsWriter().set(file); .flushSync()    |
 * | window | the quit, once guardAll answered 'done', before app.quit()         | flushRecent(runningWorkspaces)          |
 *
 * **tabs.json is config.ts's file**: `readTabsFile()` and `tabsWriter()` are its one reader and one writer (fsx's
 * whole write, its failures in the files pill and status.json). tabs.ts decides what goes in it and writes nothing
 * itself - two writers of one file overwrite each other's newer state.
 */
import type { FilesStatus, HomeActionAnswer, HomeInfo, LinkOpenAnswer, PageKind, RecentView, SettingsSetResult, SettingsView } from '../shared/channels.ts'
import type { FileName } from '../shared/settings-keys.ts'
import type { Config, Files, FilesPill, Home, ThemeFile } from './config.ts'
import type { StateWriter } from './fsx.ts'
import type { LinkPorts, VerifiedCanvas } from './home.ts'
import type { TabsFile } from './tabs.ts'

type Off = () => void

/**
 * What `mountPages` needs of the trust stream's bridge: a structural subset of bridge.ts's `Bridge`, so the real one
 * passes as it is. `handle` answers an invoke with its return value; `send` reaches only pages that said `app:ready`.
 */
export interface PageBridge {
  handle(channel: string, fn: (ctx: { kind: PageKind }, payload: unknown) => unknown): void
  onReady(fn: (ctx: { kind: PageKind }) => void): Off
  send(target: PageKind, channel: string, payload: unknown): boolean
}

/** What `mountPages` needs of the window stream. */
export interface WindowPorts {
  /** the workspaces of the canvases running now (the registry's `starting` and `ready` entries) */
  running(): string[]
  /** called when that set changes (a canvas started or went away) */
  onRunningChange(fn: () => void): Off
  /** opens a checked link in a canvas's tab (home.ts `LinkPorts`: its duties are listed there) */
  linkPorts: LinkPorts
  /** the strip's tier-3 pill (A2.2): the files pill, or null when its cause is gone; called at once, then on change */
  setFilesPill(p: FilesPill | null): void
}

export interface HomePorts {
  /** before ready, after ensureHome and readFiles: reads recent.json, knows whether this is the first launch */
  startHome(): void
  /** trust: a canvas tab's first trusted commit, and again on each new instance (`slot` null for a port of its own) */
  noteVerified(c: VerifiedCanvas): void
  /** window: Home's first did-finish-load while it is the active tab - writes `state/launched` once */
  noteHomeShown(): void
  /** window: a canvas went away - it was seen until now */
  noteGone(ws: string): void
  /** window: the very first launch (no `state/launched`), the same for the whole run */
  isFirstLaunch(): boolean
  /** window: the quit, once it is sure - every canvas still running seen now, recent.json written at once */
  flushRecent(running: Iterable<string>): void
  /** mounted by mountPages; exported for tests */
  homeInfo(): HomeInfo
  recentViews(running: Iterable<string>): RecentView[]
  onRecentChange(fn: () => void): Off
  homeAction(raw: unknown): Promise<HomeActionAnswer>
  openLink(raw: unknown, ports: LinkPorts): Promise<LinkOpenAnswer>
  /** at ready: mounts the home and settings channels and pushes (see the table above) */
  mountPages(bridge: PageBridge, w: WindowPorts): Off
}

export interface FilesPorts {
  /** before ready, before crashReporter.start (A2.1, A2.14 #24) */
  ensureHome(o?: { version?: string; dev?: boolean }): Home
  /** before ready: the files' first read */
  readFiles(home?: Home): Files
  /** at ready */
  applyTheme(files?: Files): void
  startFiles(): void
  /** what is in force now: tabs.ts reads `config.restoreTabs` */
  values(): { config: Config; theme: ThemeFile }
  /** a file's record changed what is in force */
  onChange(fn: (f: FileName) => void): Off
  /** tabs.json's one reader (undefined when absent; a bad one goes aside as tabs.json.bad) and one writer */
  readTabsFile(): TabsFile | undefined
  tabsWriter(): StateWriter<TabsFile>
  /** mounted by mountPages; exported for tests */
  settingsView(): SettingsView
  settingsSet(raw: unknown): Promise<SettingsSetResult>
  settingsReveal(): void
  filesStatus(): FilesStatus
  onStatus(fn: (s: FilesStatus) => void): Off
  /** the files pill now, at once, then on each change */
  onPill(fn: (p: FilesPill | null) => void): Off
}
