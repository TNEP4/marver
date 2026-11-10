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
 *
 * As built:
 * - The module imports nothing of Electron or the window: bridge.ts, window.ts, tabs.ts and notify.ts call it from pure
 *   modules, and recorder.ts hands it `recorder.event` at its start (`connectCmds`), so no import cycle exists.
 * - The start is written at the end of the input's turn (`setImmediate`, or as the first end's own start), so a noop
 *   decided in that turn is one `once` record. Its `ts` is that of the writing, its `ms` from the input.
 * - The tab's identity is read when each line is written: `end` names the document it ended on, which a reload changes.
 * - Signals reach a command by the tab it waits on (`activated`, `waitForDoc`) or by its id (`cmdShown`). A handle that
 *   ended ignores them, so the funnel's last word (`pageEnd`) and a wait may race harmlessly: first end wins.
 */
import { randomBytes } from 'node:crypto'
import type { OpenResult } from '../../../src/shared/app-api.ts'
import type { TabIdent, WindowEvent } from '../../../src/shared/app-perf.ts'
import { CMD_BOUNDS, type CmdIn, type CmdOutcome, type CmdStep, type CmdVia } from '../../../src/shared/perf-records.ts'
import { CH, type PageKind } from '../shared/channels.ts'
import type { AppCommand } from './keys.ts'

/** The tab actions (`tabAct`, views.ts:1058): the tab's right-click, the File and View menus, the Window menu's tabs,
 *  the » overflow. Its `mark-all-seen` and `resolve-all-comments` are relays, recorded by the shell. */
export const TAB_ACTIONS = ['activate', 'open-browser', 'reveal', 'copy-link', 'reload', 'force-reload', 'close'] as const
/** The strip (views.ts:1199-1204), by key or click. */
export const STRIP_COMMANDS = ['tab-activate', 'tab-close', 'tab-menu', 'tabs-more', 'link-open'] as const
/** Home (channels.ts:178-181; pages/home/main.ts): `copy`'s `arg` is `dev`, `init` or `update` (FIXED_COMMANDS). Spec 32
 *  D8.1 adds a card's `copy-link`, `copy-path` and `reveal`. */
export const HOME_COMMANDS = ['copy', 'copy-start', 'copy-update', 'show-files', 'tab-activate', 'link-open', 'link-cancel', 'copy-link', 'copy-path', 'reveal'] as const
/** Settings, the pill and the tab page (channels.ts:165, :253): `setting`'s `arg` is the key, never the value. */
export const PAGE_COMMANDS = [
  'setting', 'settings-reveal', 'notification-settings', 'pill-button', 'pill-dismiss',
  'retry', 'reload', 'copy-start', 'copy-details', 'reveal', 'open-browser', 'close', 'export-report',
] as const
/** The Marver and Help menus' own items (menu.ts:98-150). */
export const MENU_COMMANDS = ['help', 'show-perf-files', 'export-report', 'update'] as const
/** Inputs that reach main by another way: a notification's click, the Dock, a second launch, the red button, the hang
 *  sheet, the Move to Applications dialog, the updater's alert. */
export const OTHER_COMMANDS = ['notice-open', 'dock-activate', 'relaunch', 'deep-link', 'window-close-button', 'hang-reload', 'move-to-apps', 'update-alert'] as const

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
  /** when the result was observed: `ms` runs from `at` to here, never to the next launch that writes the line */
  doneAt?: number
}

/** Forwarding paths with declared owners (R16's static gate), the twin of the canvas's `RELAYS`. */
export interface AppRelay {
  from: string
  owner: string
  why: string
  /** what R16's walk reads: the calls this path forwards through (or, for a dialog, the port it answers), where they may stand, and where its owner lives */
  calls: readonly string[]
  fromFile?: string
  ownerFile: string
  ownerFn: string
}
export const APP_RELAYS: readonly AppRelay[] = [
  { from: "a menu item's cmd() helper (menu.ts)", owner: 'runCommand (views.ts:841)', why: "via 'menu'", calls: ['acts.run'], ownerFile: 'src/main/views.ts', ownerFn: 'runCommand' },
  { from: 'a tab menu item (views.ts:1127-1152), the View menu Reload items, the Window menu tabs, the » overflow', owner: 'tabAct (views.ts:1058)', why: 'one recording owner', calls: ['acts.tab', 'tabAct'], ownerFile: 'src/main/views.ts', ownerFn: 'tabAct' },
  { from: 'the Marver and Help menus\' own items', owner: "the menu's acts (views.ts startViews)", why: 'each act records its own name', calls: ['acts.help', 'acts.perfFiles', 'acts.update', 'acts.exportReport'], ownerFile: 'src/main/views.ts', ownerFn: 'startViews' },
  { from: "an app page's button (api.activate, api.action, ...)", owner: "main's channel handler (bridge.ts:625-650)", why: 'the page funnel records', calls: ['api.'], ownerFile: 'src/main/bridge.ts', ownerFn: 'installBridge' },
  { from: 'a View or Jam menu item, the tab menu Mark All as Seen and Resolve All Comments (mv:menu-click)', owner: 'the shell (app-bridge.ts runMenuItem)', why: '#51: the executing side records; the app records nothing', calls: ['acts.canvasClick', 'markAllSeen', 'resolveAllComments'], ownerFile: '../src/client/shell/app-bridge.ts', ownerFn: 'runMenuItem' },
  { from: 'the Move to Applications dialog (main.ts, the mover\'s ask port)', owner: 'the mover\'s handoff (mover.ts offerMove), written by the next recorder (writeMoveCmd)', why: 'no recorder exists yet: the answer is durable first', calls: ['ask'], fromFile: 'src/main/main.ts', ownerFile: 'src/main/mover.ts', ownerFn: 'takeMoveCmd' },
]

// ---- the table: every name's deadline and codes ----------------------------------------------------------------------

const D = CMD_BOUNDS.deadlineMs
const S30 = 30_000, S120 = 120_000
const se = (o: Partial<Omit<AppCmdSpec, 'life'>> = {}): AppCmdSpec => ({ life: 'start-end', deadlineMs: D, ...o })
/** A tab shown (#49): noop with no tab; `gone` a renderer lost, `refused` a load that failed. */
const SHOW = se({ noop: ['no-tab'], failed: ['refused', 'gone'] })
/** The reload family's: ends on the new document's accepted hello; a declined sheet is `cancelled`, a page or its unsaved work refusing is `failed refused`. */
const RELOAD = se({ deadlineMs: S30, noop: ['no-tab'], failed: ['refused', 'gone'], cancelled: true })
const CLOSE = se({ noop: ['no-tab'], failed: ['refused'], cancelled: true })
const DONE_AT_ONCE = se({ noop: ['no-tab'] })
const EXPORT = se({ deadlineMs: S120, noop: ['busy'], failed: ['panel', 'make', 'write'], cancelled: true })

/**
 * The R12 "Mac app" table, by name. The table's deadlines: reload's and hang-reload's 30 s, export's 120 s; 10 s
 * otherwise. Where one name has two paths (`reload` by ⌘R, by a tab's menu, by a tab page) one row covers them: they
 * end on the same signal. Codes the table leaves open and this file adds, each saying what happened: `gone`,
 * `stale` (a pill or a tab page's rev no longer shown), `in-flight` (a quit already under way), `debounced` (a flash
 * within the mark's debounce), `mark-failed`, `untrusted`, `busy` (one export at a time), `missing` (a recent card main
 * no longer holds), `threw` (a page's handler threw: any name the funnel records may carry it).
 */
export const APP_COMMANDS: Record<AppCmdName, AppCmdSpec> = {
  // ---- the keys, and the menu's cmd() items
  home: DONE_AT_ONCE, 'open-link': DONE_AT_ONCE, settings: DONE_AT_ONCE,
  'close-tab': CLOSE, 'close-window': DONE_AT_ONCE,
  reload: RELOAD, 'force-reload': RELOAD,
  quit: se({ noop: ['in-flight'] }),
  hide: DONE_AT_ONCE, 'hide-others': DONE_AT_ONCE, minimize: DONE_AT_ONCE, fullscreen: DONE_AT_ONCE,
  'next-tab': SHOW, 'prev-tab': SHOW,
  'tab-1': SHOW, 'tab-2': SHOW, 'tab-3': SHOW, 'tab-4': SHOW, 'tab-5': SHOW, 'tab-6': SHOW, 'tab-7': SHOW, 'tab-8': SHOW, 'tab-last': SHOW,
  devtools: DONE_AT_ONCE, 'focus-strip': DONE_AT_ONCE, 'focus-strip-back': DONE_AT_ONCE,
  'mark-flash': se({ noop: ['debounced'], failed: ['mark-failed'] }),
  // ---- tabAct (`reload`, `force-reload` above)
  activate: se({ noop: ['no-tab', 'untrusted'], failed: ['refused', 'gone'] }),
  'open-browser': se({ noop: ['no-tab', 'untrusted'] }),
  // spec 32 D8.1: Home's card actions end `failed: missing` on main's `{ ok: false }` (`pageEnd`)
  reveal: se({ noop: ['no-tab', 'untrusted'], failed: ['missing'] }),
  'copy-link': se({ noop: ['no-tab', 'untrusted'], failed: ['missing'] }),
  close: se({ noop: ['no-tab', 'untrusted'], failed: ['refused'], cancelled: true }),
  // ---- the strip and Home
  'tab-activate': SHOW,
  'tab-close': CLOSE,
  // spec 32 B2: held until the strip says the menu shows; else refused (`not-ready`), replaced by a newer open, closed
  // before it showed, or past its deadline (`no-show`)
  'tab-menu': se({ noop: ['no-tab', 'not-ready', 'replaced', 'closed', 'no-show'] }),
  'tabs-more': se({ noop: ['no-tab', 'not-ready', 'replaced', 'closed', 'no-show'] }),
  'link-open': se({ failed: ['bad', 'nothing', 'not-canvas', 'refused'] }),
  copy: se({ failed: ['refused'] }),
  'copy-start': se({ noop: ['no-tab'], failed: ['missing'] }),
  // spec 31 E4: a running canvas's update command, in its folder
  'copy-update': se({ failed: ['missing'] }),
  // spec 32 D8.1: a card's folder path
  'copy-path': se({ noop: ['no-tab'], failed: ['missing'] }),
  'show-files': se(),
  'link-cancel': se({ noop: ['no-tab'], failed: ['refused', 'gone'] }),
  // ---- Settings, the pill, the tab page
  setting: se({ failed: ['unknown-key', 'bad-value', 'unwritable', 'write-failed'] }),
  'settings-reveal': se(),
  'notification-settings': se(),
  'pill-button': se({ noop: ['stale'] }),
  'pill-dismiss': se({ noop: ['stale'] }),
  retry: se({ deadlineMs: S30, noop: ['stale'], failed: ['refused', 'gone'], cancelled: true }),
  'copy-details': se({ noop: ['stale'] }),
  'export-report': EXPORT,
  // ---- the Marver and Help menus
  help: se(),
  'show-perf-files': se(),
  update: se({ noop: ['stale'] }),
  // ---- other inputs
  'notice-open': se({ noop: ['busy', 'no-tab'], failed: ['stale', 'missing', 'unsupported', 'not-sent', 'refused', 'gone'], cancelled: true }),
  'dock-activate': se(),
  relaunch: se(),
  // spec 31 D1: a marver:// link (open-url, a second launch's argv), routed once the app is ready
  'deep-link': se({ noop: ['bad'] }),
  'window-close-button': se(),
  'hang-reload': se({ deadlineMs: S30, noop: ['answered'], failed: ['refused', 'gone'], cancelled: true }),
  'move-to-apps': se({ failed: ['move-failed'], cancelled: true }),
  'update-alert': se({ noop: ['no-bundle'], cancelled: true }),
}

// ---- the writer ------------------------------------------------------------------------------------------------------

/**
 * Where a command's lines go: recorder.ts at its start, `recorder.event` and `identity`. Handed over rather than
 * imported, so this file stays free of Electron and of the window: bridge.ts, window.ts, tabs.ts and notify.ts call it
 * from pure modules, and recorder.ts (which imports window.ts and bridge.ts) calls it without a cycle. Before it is
 * connected a command writes nothing, as any record before the recorder's start.
 */
export interface CmdSink {
  event(kind: 'cmd' | 'dropped', who: TabIdent | null, body: Record<string, unknown>): void
  /** the tab's identity now (recorder.ts `identity`), or null for one that is gone */
  ident(tabId: string): TabIdent | null
}
let sink: CmdSink | null = null
export function connectCmds(s: CmdSink | null): void { sink = s }

const elapsed = (t0: number): number => Math.round((performance.now() - t0) * 10) / 10
const newId = (): string => randomBytes(6).toString('hex')
/** A command id for a handoff written before any recorder exists (the mover's). */
export const newCmdId = newId

// ---- the rate bound (#48) --------------------------------------------------------------------------------------------

let tokens: number = CMD_BOUNDS.burst
let refilled = -1
let droppedN = 0
let dropTimer: ReturnType<typeof setTimeout> | undefined

/** One start, or none: 10 a second, a burst of 20 (a token bucket). */
function takeToken(now: number): boolean {
  if (refilled < 0) refilled = now
  tokens = Math.min(CMD_BOUNDS.burst, tokens + Math.max(0, now - refilled) * CMD_BOUNDS.perSecond / 1000)
  refilled = now
  if (tokens < 1) return false
  tokens -= 1
  return true
}
function writeDropped(): void {
  if (dropTimer) { clearTimeout(dropTimer); dropTimer = undefined }
  if (droppedN > 0) sink?.event('dropped', null, { n: droppedN, reason: 'cmd' })
  droppedN = 0
}
/** Starts past the bound, coalesced into one `dropped` line a second. */
function countDropped(): void {
  droppedN += 1
  if (dropTimer) return
  dropTimer = setTimeout(writeDropped, 1000)
  ;(dropTimer as { unref?: () => void }).unref?.()
}

// ---- one command -----------------------------------------------------------------------------------------------------

/** How long a command past its deadline may still end late (#49) before it is let go: nothing waits for good. */
const LATE_MS = 5 * 60_000

interface Live {
  h: AppCmdHandle
  name: AppCmdName
  o: AppCmdOpts
  t0: number
  id: string
  steps: CmdStep[]
  /** `fresh`: its start not written yet - it may still become a `once` in its input's own turn */
  state: 'fresh' | 'running' | 'unobserved' | 'ended'
  timer?: ReturnType<typeof setTimeout>
  /** the turn's own effects: a `shown` asked, a load begun (`activated` reads them) */
  asked?: 'shown' | 'load'
  /** the dispatch returned before the work: its own end comes later, never the funnel's */
  held?: boolean
}
const lives = new WeakMap<AppCmdHandle, Live>()
const byId = new Map<string, Live>()
const fresh = new Set<Live>()
let current: Live | undefined

const NOTHING: AppCmdHandle = { id: '', done() {}, fail() {}, noop() {}, cancel() {}, unobserved() {}, step() {} }

const stepsOf = (l: Live) => (l.steps.length ? { steps: l.steps.map((s) => ({ ...s })) } : {})
const whoOf = (l: Live): TabIdent | null => (l.o.tab ? sink?.ident(l.o.tab) ?? { tab: l.o.tab } : null)
const input = (l: Live) => ({
  id: l.id, cmd: l.name, via: l.o.via, ...(l.o.keys ? { keys: l.o.keys } : {}), in: l.o.in, ...(l.o.arg ? { arg: l.o.arg } : {}),
})
function writeStart(l: Live): void {
  fresh.delete(l)
  l.state = 'running'
  sink?.event('cmd', whoOf(l), { phase: 'start', ...input(l) })
}
function writeEnd(l: Live, outcome: CmdOutcome, why: string | undefined, late: boolean): void {
  sink?.event('cmd', whoOf(l), { phase: 'end', id: l.id, cmd: l.name, outcome, ...(why ? { why } : {}), ms: elapsed(l.t0), ...stepsOf(l), ...(late ? { late: true } : {}) })
}
/** Nothing of it is waited on any more. */
function letGo(l: Live): void {
  if (l.timer) { clearTimeout(l.timer); l.timer = undefined }
  byId.delete(l.id)
  for (const w of tabWaits) if (w.l === l) tabWaits.delete(w)
  for (const w of windowWaits) if (w.l === l) windowWaits.delete(w)
  for (const [k, v] of noticeWaits) if (v === l) noticeWaits.delete(k)
}

/**
 * The one place a command ends (#48, #49). First end wins. A noop in its input's own turn (or a `once` name) is one
 * `once` record; any other first end writes the start it was holding and its end. `unobserved` leaves the door open:
 * a completion after it (done, failed or cancelled) is a second `end`, `late: true`, and then nothing more.
 */
function finish(l: Live, outcome: CmdOutcome, why?: string): void {
  if (l.state === 'ended') return
  if (l.state === 'fresh' && (outcome === 'noop' || APP_COMMANDS[l.name].life === 'once')) {
    fresh.delete(l)
    l.state = 'ended'
    sink?.event('cmd', whoOf(l), { phase: 'once', ...input(l), outcome, ...(why ? { why } : {}), ms: elapsed(l.t0), ...stepsOf(l) })
    letGo(l)
    return
  }
  if (l.state === 'fresh') writeStart(l)
  if (l.state === 'running') {
    writeEnd(l, outcome, why, false)
    if (outcome !== 'unobserved') { l.state = 'ended'; letGo(l); return }
    l.state = 'unobserved'
    if (l.timer) clearTimeout(l.timer)
    l.timer = setTimeout(() => { l.state = 'ended'; letGo(l) }, LATE_MS)
    ;(l.timer as { unref?: () => void }).unref?.()
    return
  }
  // past its deadline: a real ending is still written; another `unobserved`, or a noop, adds nothing
  if (outcome === 'unobserved' || outcome === 'noop') return
  writeEnd(l, outcome, why, true)
  l.state = 'ended'
  letGo(l)
}

/**
 * The one call every app dispatch point makes (#52). The start is written at the end of its input's turn, so a noop
 * decided in that turn can be its one `once` record instead; the id exists now, and names the command for the rest of
 * this turn (`currentAppCmd`). Past the rate bound it records nothing and counts one `dropped`. Writes through
 * `recorder.event`, so it obeys `recorder: true` as every other app kind does (the ring and the journal always).
 */
export const appCmd: AppCmdFn = (name, o) => {
  // spec 32 B12.4: main closes the strip's Marver menu before any app command runs (views.ts's hook)
  if (beforeCmd) { try { beforeCmd(name) } catch (err) { process.stderr.write(`marver-app: the before-command hook threw: ${(err as Error).message}\n`) } }
  const now = performance.now()
  if (!sink) return NOTHING
  if (!takeToken(now)) { countDropped(); return NOTHING }
  const id = newId()
  const l: Live = { h: NOTHING, name, o, t0: now, id, steps: [], state: 'fresh' }
  const h: AppCmdHandle = {
    id,
    done: () => finish(l, 'done'),
    fail: (why) => finish(l, 'failed', why),
    noop: (why) => finish(l, 'noop', why),
    cancel: (why) => finish(l, 'cancelled', why),
    unobserved: (why) => finish(l, 'unobserved', why),
    step: (n) => { if (l.state !== 'ended') l.steps.push({ name: n, ms: elapsed(l.t0) }) },
  }
  l.h = h
  lives.set(h, l)
  byId.set(id, l)
  fresh.add(l)
  current = l
  queueMicrotask(() => { if (current === l) current = undefined })
  setImmediate(() => { if (l.state === 'fresh') writeStart(l) })
  l.timer = setTimeout(() => { l.timer = undefined; finish(l, 'unobserved', 'deadline') }, APP_COMMANDS[name].deadlineMs)
  ;(l.timer as { unref?: () => void }).unref?.()
  return h
}

/** Spec 32 B12.4: told the name of every app command as it is opened, before it runs (null: nobody). */
let beforeCmd: ((name: AppCmdName) => void) | null = null
export function setBeforeCmd(fn: ((name: AppCmdName) => void) | null): void { beforeCmd = fn }

/** The command whose input this turn is, for an effect's `by`; undefined when none (or past the rate bound). */
export const currentAppCmd = (): AppCmdHandle | undefined => current?.h

/** `fn` run as `h`'s turn: what it causes before its first await names the command (`currentAppCmd`). */
export function withAppCmd<T>(h: AppCmdHandle, fn: () => T): T {
  const l = lives.get(h)
  if (!l) return fn()
  const was = current
  current = l
  try { return fn() } finally { current = was }
}

/** The dispatch returns before the work is done (#49): its own end comes later. */
export function holdCmd(h: AppCmdHandle | undefined): void {
  const l = h && lives.get(h)
  if (l) l.held = true
}

/** Before the quit's last write: starts still held and drops still counted, written now (a timer never runs again then). */
export function flushCmds(): void {
  for (const l of [...fresh]) writeStart(l)
  writeDropped()
}

// ---- a tab's signals (#49: `shown` or `reopen`, the new document's hello; never the dispatch returning) -------------

interface TabWait {
  l: Live
  tab: string
  kind: 'shown' | 'load' | 'doc'
  /** `doc`: the document it replaces (views.ts `docToken`): only a hello of another one ends it */
  token?: string
  /** an activation's: another tab chosen, or the window hidden, ends it */
  activation: boolean
}
const tabWaits = new Set<TabWait>()

/** views.ts `sendState`: this turn's `shown` was asked of the tab's document. */
export function askedShown(): void { if (current) current.asked = 'shown' }
/** views.ts `load`: this turn began a load of a documentless tab (no `shown` will come; its reopen or its hello will). */
export function askedLoad(): void { if (current && current.asked !== 'shown') current.asked = 'load' }

/**
 * An activation's dispatch is over: it ends at the tab's `shown`, or its `reopen` or hello when the turn began a load.
 * Neither was asked - Home, Settings, a tab page, a shared canvas, the tab already in front - the tab is shown by this
 * turn's compose, the one signal there is: done now.
 */
export function activated(h: AppCmdHandle, tabId: string): void {
  const l = lives.get(h)
  if (!l || l.state === 'ended') return
  if (!l.asked) { h.done(); return }
  tabWaits.add({ l, tab: tabId, kind: l.asked, activation: true })
}

/** A reload's end: the next document's accepted hello (or a shared canvas's next commit). `token` the document now. */
export function waitForDoc(h: AppCmdHandle | undefined, tabId: string, token: string): void {
  const l = h && lives.get(h)
  if (!l || l.state === 'ended') return
  l.held = true
  tabWaits.add({ l, tab: tabId, kind: 'doc', token, activation: false })
}

/** recorder.ts, with the `shown` line it just wrote: `by`'s command is done. */
export function cmdShown(by: string, tabId: string): void {
  for (const w of tabWaits) if (w.kind === 'shown' && w.l.id === by && w.tab === tabId) { w.l.h.done(); return }
  // an effect's by, on a command that ends on another signal (a link's answer): nothing to end
}

/**
 * The tab's document said hello (or a shared canvas committed); `token` that document. A wait on a `doc` ends only on
 * another document than the one it replaces; a load's on any. Without a token (a `reopen` record, which may have no
 * hello), a load's alone.
 */
export function tabDocument(tabId: string, token?: string): void {
  for (const w of tabWaits) {
    if (w.tab !== tabId) continue
    if (w.kind === 'load' || (w.kind === 'doc' && token !== undefined && token !== w.token)) w.l.h.done()
  }
}

/** A renderer gone (`gone`) or a load that failed (`refused`): what waited on the tab failed (#49). */
export function tabFailed(tabId: string, why: 'gone' | 'refused'): void {
  for (const w of tabWaits) if (w.tab === tabId) w.l.h.fail(why)
}

/** After each change of the tabs: an activation whose tab is no longer in front was overtaken (#49). */
export function cmdTabsChanged(activeId: string | undefined): void {
  for (const w of tabWaits) {
    if (!w.activation || w.tab === activeId) continue
    if (w.l.state === 'unobserved') tabWaits.delete(w)   // already said no signal came; this is not a completion
    else w.l.h.cancel('another-tab')
  }
}

/** The window hidden or minimized: an activation's `shown` cannot come while it draws nothing (#49). */
export function cmdWindowGone(): void {
  for (const w of tabWaits) if (w.activation && w.l.state !== 'ended') w.l.h.unobserved('hidden')
}

// ---- the window's own events (#53) -----------------------------------------------------------------------------------

const windowWaits = new Set<{ l: Live; events: readonly WindowEvent[] }>()
/** ⌘M, ⌃⌘F: the command asked for this event, which comes after its animation, in a later turn; it ends there. */
export function expectWindow(h: AppCmdHandle, events: readonly WindowEvent[]): void {
  const l = lives.get(h)
  if (l) { l.held = true; windowWaits.add({ l, events }) }
}
/** A `window` event's cause: `app` when a command asked for it, or this turn is a command's; else `unknown` (#53). */
export function windowCause(event: WindowEvent): 'app' | 'unknown' {
  for (const w of windowWaits) {
    if (w.events.includes(event) && w.l.state !== 'ended') { w.l.h.done(); return 'app' }
  }
  return current ? 'app' : 'unknown'
}

// ---- a notice's click (the `notice-open` row) ------------------------------------------------------------------------

const noticeWaits = new Map<string, Live>()
/** Before the click goes to its tab: the item's answer ends it. A click on the same item again replaces it. */
export function waitNotice(h: AppCmdHandle, itemId: string): void {
  const l = lives.get(h)
  if (!l) return
  const was = noticeWaits.get(itemId)
  if (was && was !== l) was.h.cancel('superseded')
  l.held = true
  noticeWaits.set(itemId, l)
}
/** tabs.ts: the held click went nowhere. `superseded` from its own click's turn is that click replacing an older one. */
export function noticeDropped(itemId: string, why: string): void {
  const l = noticeWaits.get(itemId)
  if (!l || (why === 'superseded' && current === l)) return
  if (why === 'wait') l.h.unobserved('wait')
  else if (why === 'no-open') l.h.fail('unsupported')
  else if (why === 'not-sent') l.h.fail('not-sent')
  else l.h.cancel(why)
}
/** bridge.ts: the shell's `mv:opened` (app-api.ts `OPEN_RESULTS`). */
export function noticeAnswered(itemId: string, result: OpenResult): void {
  const l = noticeWaits.get(itemId)
  if (!l) return
  if (result === 'handled') l.h.done()
  else if (result === 'busy') l.h.noop('busy')
  else if (result === 'dropped') l.h.unobserved('dropped')
  else l.h.fail(result)
}

// ---- the page funnel (bridge.ts:625-650) -----------------------------------------------------------------------------

/** What the funnel records for a page's message; `noop`: decided here, its handler never runs. */
export interface PageCommand { name: AppCmdName; o: AppCmdOpts; noop?: string }

/** The channels the funnel records (R16's gate reads this against `SENDERS`). `app:ready` and `settings:get` are no input,
 *  and so are spec 32's `tab:menu-pick` and `tab:menu-shown` (a pick records what `tabAct` opens; B2). */
export const PAGE_CHANNELS: readonly string[] = [
  CH.tabActivate, CH.tabClose, CH.tabMenu, CH.tabsMore, CH.linkOpen, CH.pillAction, CH.tabpageAction, CH.homeAction, CH.settingsSet, CH.settingsReveal, CH.settingsAction,
]

/**
 * A page's checked message as a command (#50: `via` from the page where only it can know; `in` the page's surface),
 * or null for what is no input. Names and fixed identifiers only (#4): `link:open`'s URL and `settings:set`'s value
 * are in the message, and go no further than this function reading past them.
 */
export function pageCommand(channel: string, ctx: { kind: PageKind; tabId?: string }, p: unknown): PageCommand | null {
  const v = (p ?? {}) as Record<string, unknown>
  const surface = ctx.kind as 'strip' | 'home' | 'settings' | 'tabpage'
  const id = typeof v.id === 'string' ? v.id : undefined
  switch (channel) {
    case CH.tabActivate: {
      const via: CmdVia = v.via === 'key' ? 'key' : 'click'
      // Home's field Escape says `cancel` (spec 32 D8.8): back to the tab ⌘L came from. With no such tab it names Home
      // itself: nothing to go back to
      if (ctx.kind === 'home' && v.cancel === true) return { name: 'link-cancel', o: { via: 'key', keys: 'Escape', in: 'home', ...(id ? { tab: id } : {}) }, ...(id === 'home' ? { noop: 'no-tab' } : {}) }
      // a Home card by Enter or Space records the key (spec 32 D8.8)
      const keys = ctx.kind === 'home' && via === 'key' && (v.keys === 'Enter' || v.keys === 'Space') ? { keys: v.keys } : {}
      return { name: 'tab-activate', o: { via, ...keys, in: surface, ...(id ? { tab: id } : {}) } }
    }
    // the strip closes by Delete or Backspace, it has no close button
    case CH.tabClose: return { name: 'tab-close', o: { via: ctx.kind === 'strip' ? 'key' : 'click', in: surface, ...(id ? { tab: id } : {}) } }
    // a right-click, or the context-menu key or ⇧F10: a context menu either way
    case CH.tabMenu: return { name: 'tab-menu', o: { via: 'context', in: surface, ...(id ? { tab: id } : {}) } }
    case CH.tabsMore: return { name: 'tabs-more', o: { via: 'click', in: 'strip' } }
    // absent reads Return in the field; a past shared canvas's card says `click` (channels.ts `openLink`), or by key its
    // Enter or Space (spec 32 D8.8, Home alone: the bridge refuses it from anyone else)
    case CH.linkOpen:
      if (v.via === 'key' && (v.keys === 'Enter' || v.keys === 'Space')) return { name: 'link-open', o: { via: 'key', keys: v.keys, in: surface } }
      return { name: 'link-open', o: v.via === 'click' ? { via: 'click', in: surface } : { via: 'key', keys: 'Enter', in: surface } }
    case CH.pillAction: {
      const key = v.via === 'key'
      return { name: v.act === 'dismiss' ? 'pill-dismiss' : 'pill-button', o: key ? { via: 'key', keys: 'Escape', in: 'pill' } : { via: 'click', in: 'pill' } }
    }
    case CH.tabpageAction: return { name: String(v.action) as AppCmdName, o: { via: 'click', in: 'tabpage', ...(ctx.tabId ? { tab: ctx.tabId } : {}) } }
    case CH.homeAction: {
      // spec 32 D8.8: a menu row picked by key records the key pressed; absent reads a click
      const how: Pick<AppCmdOpts, 'via' | 'keys'> = v.via === 'key' ? { via: 'key', ...(v.keys === 'Enter' || v.keys === 'Space' ? { keys: v.keys } : {}) } : { via: 'click' }
      if (v.action === 'copy') return { name: 'copy', o: { ...how, in: 'home', ...(id ? { arg: id } : {}) } }
      if (v.action === 'copy-start') return { name: 'copy-start', o: { ...how, in: 'home' } }
      if (v.action === 'copy-update') return { name: 'copy-update', o: { ...how, in: 'home' } }
      if (v.action === 'show-files') return { name: 'show-files', o: { ...how, in: 'home' } }
      // spec 32 D8.1: a card's link, path, folder - the names tabAct records too, told apart by `in: 'home'`
      if (v.action === 'copy-link' || v.action === 'copy-path' || v.action === 'reveal') return { name: v.action, o: { ...how, in: 'home' } }
      return null
    }
    case CH.settingsSet: return { name: 'setting', o: { via: 'click', in: 'settings', ...(typeof v.key === 'string' ? { arg: v.key } : {}) } }
    case CH.settingsReveal: return { name: 'settings-reveal', o: { via: 'click', in: 'settings' } }
    case CH.settingsAction: return { name: 'notification-settings', o: { via: 'click', in: 'settings' } }
    default: return null
  }
}

/**
 * A page's handler returned (a send) or answered (an invoke). One whose work goes on ended itself or is held (`holdCmd`,
 * a wait on its tab); otherwise its answer says: `{ ok }` an invoke's, false a rev or a token no longer shown; a send
 * that returned has done its work in this turn.
 */
export function pageEnd(h: AppCmdHandle, answer: unknown): void {
  const l = lives.get(h)
  if (!l || l.held || l.state === 'ended' || [...tabWaits].some((w) => w.l === l)) return
  if (answer && typeof answer === 'object' && 'ok' in answer) {
    const a = answer as { ok: boolean; why?: string }
    if (a.ok) h.done()
    else h.fail(a.why ?? 'missing')   // `home:action`'s false: a recent card main no longer holds
    return
  }
  if (answer === false) h.noop('stale')
  else h.done()
}

// ---- the mover's handoff ---------------------------------------------------------------------------------------------

/** `MoveCmd.state` as what it came to: anything still `pending` at the next recorder's start was never observed. */
export function moveOutcome(c: MoveCmd): { outcome: CmdOutcome; why?: string } {
  switch (c.state) {
    case 'moved': case 'opened-existing': case 'revealed': return { outcome: 'done', why: c.state }
    case 'declined': return { outcome: 'cancelled', why: 'declined' }
    case 'failed': return { outcome: 'failed', why: 'move-failed' }
    case 'pending': return { outcome: 'unobserved', why: 'unknown' }
  }
}

/**
 * The next recorder to start writes the move's `cmd` lines once (the R12 row). `ms` the time the mover measured to its
 * observed result; one never observed, from its answer to now. Their `ts` is this launch's: the line was written here.
 */
export function writeMoveCmd(c: MoveCmd, now: number): void {
  if (!sink) return
  const { outcome, why } = moveOutcome(c)
  sink.event('cmd', null, { phase: 'start', id: c.id, cmd: 'move-to-apps', via: 'click', in: 'main', arg: c.answer })
  sink.event('cmd', null, { phase: 'end', id: c.id, cmd: 'move-to-apps', outcome, ...(why ? { why } : {}), ms: Math.max(0, (c.doneAt ?? now) - c.at) })
}

// ---- test seam -------------------------------------------------------------------------------------------------------

/** Unit cases: everything forgotten, the bucket full. */
export function resetCmds(): void {
  for (const l of byId.values()) { l.state = 'ended'; letGo(l) }
  byId.clear(); fresh.clear(); tabWaits.clear(); windowWaits.clear(); noticeWaits.clear()
  current = undefined; tokens = CMD_BOUNDS.burst; refilled = -1; droppedN = 0
  if (dropTimer) { clearTimeout(dropTimer); dropTimer = undefined }
}
