/**
 * The app's commands (spec 30 R12 #48-#53), the twin of the canvas's src/client/shell/commands.ts: the names, the call
 * every dispatch point makes, and the forwarding paths whose input is recorded elsewhere. Types and names only, frozen
 * before the spec 30 streams split; the commands stream builds `appCmd()` (one `cmd` record pair per command into
 * app.jsonl, perf-records.ts `CmdRecord`, through `recorder.event`), its table of deadlines and codes, and the
 * recording in `runCommand` (views.ts:841), `tabAct` (views.ts:1058) and the page-channel funnel (bridge.ts:625-650).
 *
 * - The app records nothing for a relay (#51): a View or Jam menu item and the tab menu's Mark All as Seen are the
 *   shell's, `via: 'relay'`, with `mv:menu-click`'s `in` (app-api.ts `MenuClick`).
 * - Native menu roles are `window` events, not commands (#53, app-perf.ts `WINDOW_EVENTS`); the Edit roles are typing.
 * - A dispatch that returns before the work is done ends on the work (#49): a tab page's retry on the new document's
 *   hello, export-report on its file, close on the tab gone or the sheet refused.
 * - `move-to-apps` is written through the mover's durable handoff (`MoveCmd`), by the next recorder to start.
 */
import type { AppCommand } from './keys.ts'
import type { CmdIn, CmdVia } from '../../../src/shared/perf-records.ts'

/** The tab actions (`tabAct`, views.ts:1058): the tab's right-click, the File and View menus, the Window menu's tabs,
 *  the » overflow. Its `mark-all-seen` is a relay, recorded by the shell. */
export const TAB_ACTIONS = ['activate', 'open-browser', 'reveal', 'copy-link', 'reload', 'force-reload', 'close'] as const
/** The strip (views.ts:1199-1204), by key or click. */
export const STRIP_COMMANDS = ['tab-activate', 'tab-close', 'tab-menu', 'tabs-more', 'link-open'] as const
/** Home (channels.ts:178-181; pages/home/main.ts): `copy`'s `arg` is `dev`, `init` or `update` (FIXED_COMMANDS). */
export const HOME_COMMANDS = ['copy', 'copy-start', 'show-files', 'tab-activate', 'link-open', 'link-cancel'] as const
/** Settings, the pill and the tab page (channels.ts:165, :253): `setting`'s `arg` is the key, never the value. */
export const PAGE_COMMANDS = [
  'setting', 'settings-reveal', 'notification-settings', 'pill-button', 'pill-dismiss',
  'retry', 'reload', 'copy-start', 'copy-details', 'reveal', 'open-browser', 'close', 'export-report',
] as const
/** The Marver and Help menus' own items (menu.ts:98-150). */
export const MENU_COMMANDS = ['help', 'show-perf-files', 'export-report', 'update'] as const
/** Inputs that reach main by another way: a notification's click, the Dock, a second launch, the red button, the hang
 *  sheet, the Move to Applications dialog, the updater's alert. */
export const OTHER_COMMANDS = ['notice-open', 'dock-activate', 'relaunch', 'window-close-button', 'hang-reload', 'move-to-apps', 'update-alert'] as const

/** Every app command name. The same name on two paths (a tab action's `reload` and ⌘R's) is told apart by `in` and `via`. */
export type AppCmdName =
  | AppCommand
  | (typeof TAB_ACTIONS)[number]
  | (typeof STRIP_COMMANDS)[number]
  | (typeof HOME_COMMANDS)[number]
  | (typeof PAGE_COMMANDS)[number]
  | (typeof MENU_COMMANDS)[number]
  | (typeof OTHER_COMMANDS)[number]

/** One row of the Mac app table: `once` for an answer decided in the input's turn, else a start and an end. */
export interface AppCmdSpec {
  life: 'once' | 'start-end'
  /** the table's "(N s)", else 10 s (perf-records.ts `CMD_BOUNDS.deadlineMs`) */
  deadlineMs: number
  failed?: readonly string[]
  noop?: readonly string[]
  cancelled?: true
}

/** How and where the input arrived (#50); `tab` the tab it acts on; `arg` a fixed identifier, never a value. */
export interface AppCmdOpts { via: CmdVia; in: CmdIn; keys?: string; arg?: string; tab?: string }

/** A command in flight - the canvas's `CmdHandle`, the same rules (first end wins; a completion after `unobserved` is a
 *  second end with `late: true`). */
export interface AppCmdHandle {
  readonly id: string
  done(): void
  fail(why: string): void
  noop(why: string): void
  cancel(why?: string): void
  unobserved(why: string): void
  step(name: string): void
}
/** The one call every app dispatch point makes. */
export type AppCmdFn = (name: AppCmdName, o: AppCmdOpts) => AppCmdHandle

/** What `attachKeys` (keys.ts:74) passes `run()` with the command (#50): the matched combination as `descriptor()`
 *  writes it, and the surface it arrived on. */
export interface KeyFrom { keys: string; in: Extract<CmdIn, 'strip' | 'home' | 'settings' | 'tabpage' | 'shell'> }

/**
 * `move-to-apps`' durable handoff (the R12 row): `offerMove` writes `move.cmd` into the update file (mover.ts:290)
 * `pending` before it acts, then the result it observed; the next recorder to start writes the `cmd` start and end
 * once and clears it. One still `pending` then is `unobserved`, why `unknown`.
 */
export interface MoveCmd {
  id: string
  at: number
  /** a fixed button name */
  answer: string
  state: 'pending' | 'moved' | 'opened-existing' | 'revealed' | 'declined' | 'failed'
}

/** Forwarding paths with declared owners (R16's static gate), the twin of the canvas's `RELAYS`. */
export interface AppRelay { from: string; owner: string; why: string }
export const APP_RELAYS: readonly AppRelay[] = [
  { from: "a menu item's cmd() helper (menu.ts)", owner: 'runCommand (views.ts:841)', why: "via 'menu'" },
  { from: 'a tab menu item (views.ts:1127-1152), the View menu Reload items, the Window menu tabs, the » overflow', owner: 'tabAct (views.ts:1058)', why: 'one recording owner' },
  { from: "an app page's button (api.activate, api.action, ...)", owner: "main's channel handler (bridge.ts:625-650)", why: 'the page funnel records' },
  { from: 'a View or Jam menu item, the tab menu Mark All as Seen (mv:menu-click)', owner: 'the shell (app-bridge.ts runMenuItem)', why: '#51: the executing side records; the app records nothing' },
]
