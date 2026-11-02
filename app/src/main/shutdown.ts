/**
 * The one shutdown coordinator (spec 28 A5.1 #15-#18, #20; spike S4; the owner's decision of 30 Oct: one guarded quit,
 * no second shutdown path). Every way the app ends once its window exists comes here: ⌘Q, the menu, the Dock and a
 * logout (`before-quit` while not quitting), a stuck sheet's Force Quit Tab, and Restart to Update (the pill's and the
 * menu's one entry, update-model.ts `act`). It is the only caller of `app.quit()` and `autoUpdater.quitAndInstall()`
 * from then on; before it, only the single-instance lock and the mover's relaunch at launch (mover.ts) quit, when no
 * tab and no listener of ours exists.
 *
 * - **One entry**, `request(kind, token?)`; **one in flight**: a request while one runs, or once quitting, is noted and
 *   ignored - a quit during an update's sweep is that same shutdown, and an update asked during a quit is not needed,
 *   since a downloaded update installs at that quit (#18).
 * - **The steps** (#15): tabs.json written now (`writeTabsNow`, #20: a false is noted and the shutdown goes on - the
 *   files pill already says so, and a restart promises no tabs, #19); then `guardAll({ kind })`, a throw counting as
 *   `refused`.
 * - **refused**: the flags cleared (`sweeping` by guardAll, `inFlight` here); the window forward, the refusing tab
 *   already in front (tabs.ts `refuse`). An update refused by a tab's unsaved work - the tab whose `held` this request
 *   set, `held.action === 'update'` - waits on that tab (`waiting`, #21); one refused by the person's Cancel on a sheet,
 *   or by a tab already busy, is `ready` again. Nothing is retried.
 * - **stuck**: the flags cleared and the stuck sheet (Keep Waiting, Force Quit Tab), moved from views.ts unchanged; its
 *   Force Quit Tab asks `request(kind)` again, for an update too.
 * - **done**: tabs.json again; the notes (recent.json, shared.json); `quitting`, the one flag close-to-hide and
 *   tabs.json's debounced save read; #18's intent in `update.json` when an update is ready; `flushAll` once (the
 *   presentation records, the recorder's queue, notices.json - each idempotent, all run again at `will-quit`); then
 *   `app.quit()` for a quit, `quitAndInstall()` for an update.
 * - **The restart** (#16, #17; S4 on Electron 45): `before-quit-for-update` comes twice with a window open - the model
 *   passes it on once and it is recorded once here (`restart`); the window's close is not cancelled (`quitting` is set
 *   before the call); the do-nothing `window-all-closed` listener holds off Electron's default quit, which would race
 *   Squirrel's arming. A preparation failure comes after the window and every view are gone: an `error` while
 *   restarting, or no exit `restartWaitMs` after the windows closed (counted from the call until they close, so a
 *   close that never ends is caught too). Either is recorded `restart-failed`, shows #17's app-modal alert once and
 *   quits once, the intent kept: the next launch reconciles against the version it finds (#18).
 *
 * Pure (no Electron import): views.ts installs the ports, updater.ts the update's side (`setUpdateSide`).
 */
import type { UpdateBody } from '../../../src/shared/app-perf.ts'
import type { UpdateFile } from './config.ts'
import { allTabs, getTab, tabName, type GuardAllAction, type GuardAllAnswer, type Sheet, type Tab } from './tabs.ts'
import { T } from './timings.ts'

export type ShutdownKind = 'quit' | 'update'
/** #18's intent, as `update.json` keeps it. */
export type UpdateIntent = NonNullable<UpdateFile['intent']>

/**
 * #18: `via: 'quit'` rests on Squirrel installing a downloaded update when the app ends without a restart (it arms
 * its installer at the download). S2 confirms it on Electron 45; if it does not, this is false and no quit writes an
 * intent - the one switch.
 */
export const QUIT_INSTALLS = true

/** #17's alert: app-modal (the window is gone), one button. Its words are frozen (#41); the docs copy them. */
export interface RestartAlert { message: string; detail: string; buttons: readonly ['Quit'] }
export function restartAlert(version: string): RestartAlert {
  return {
    message: `Marver couldn't restart to install ${version}`,
    detail: `Your canvases were closed safely. Open Marver again: it may already be ${version}, and if not, it tells you how to get it.`,
    buttons: ['Quit'],
  }
}

export interface ShutdownPorts {
  /** the tabs' clock (TabsPorts.now): a hold this request set is told by its `at` */
  now(): number
  /** tabs.json's snapshot handed over and written now (views.ts, #20): false when it is not on disk */
  writeTabsNow(): boolean
  /** every canvas tab through the guard (tabs.ts) */
  guardAll(a: GuardAllAction): Promise<GuardAllAnswer>
  /** the tabs whose unload's close is still outstanding (tabs.ts `stuckUnloads`) */
  stuck(): Tab[]
  /** the guard's sheet seam (views.ts `ask`): true when the person confirmed */
  ask(s: Sheet): Promise<boolean>
  /** Force Quit Tab (unload-act.ts): false when the tab has no close outstanding */
  forceUnload(t: Tab): boolean
  /** the window shown and in front */
  forward(): void
  /** Home's notes on the way out: every canvas still running seen now (recent.json), shared.json written */
  notes(): void
  /** the presentation records, the recorder's queue, notices.json: each idempotent, each run again at will-quit */
  flushAll(): void
  /** `app.quit()` */
  quit(): void
  /** `app.on('before-quit')` */
  onBeforeQuit(fn: (e: { preventDefault(): void }) => void): void
  /** `app.on('window-all-closed')`: the listener that holds Electron's default quit off (#16) */
  onWindowAllClosed(fn: () => void): void
  /** #17's alert, app-modal; resolves when it is answered */
  alert(a: RestartAlert): Promise<void>
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
  /** the journal (test builds) */
  log?(topic: string, data: unknown): void
  /** the `update` record (#25), written whatever `recorder` says */
  record?(body: UpdateBody): void
}

/** The updater's side (updater.ts, through update-model.ts): set once the updater starts. */
export interface UpdateSide {
  /** the version running (`app.getVersion()`), the intent's `from` */
  version: string
  /** the version downloaded while `ready` or `waiting`, else null */
  ready(): string | null
  /** #15: refused by this tab's unsaved work - `waiting` on it */
  hold(tab: string, commit: number): boolean
  /** #15: refused otherwise - `ready` again */
  unhold(): boolean
  /** #16: `restarting`, just before `quitAndInstall()`; false when that version is no longer the one ready */
  restarting(version: string): boolean
  /** #18: `update.json`'s intent, whole and synchronously (`flushSync`, #20); false when it is not on disk */
  writeIntent(i: UpdateIntent): boolean
  quitAndInstall(): void
}

/** The model's part of the side (update-model.ts `UpdateModel`, structurally). */
interface SideModel {
  state(): { phase: { kind: string; version?: string } }
  hold(tab: string, commit: number): boolean
  unhold(tab?: string): boolean
  restarting(version: string): boolean
}

/** The side as updater.ts builds it from the model, the version running, update.json's writer and the adapter. */
export function updateSide(m: SideModel, o: { version: string; writeIntent(i: UpdateIntent): boolean; quitAndInstall(): void }): UpdateSide {
  return {
    version: o.version,
    ready: () => { const p = m.state().phase; return (p.kind === 'ready' || p.kind === 'waiting') && p.version ? p.version : null },
    hold: (tab, commit) => m.hold(tab, commit),
    unhold: () => m.unhold(),
    restarting: (v) => m.restarting(v),
    writeIntent: (i) => o.writeIntent(i),
    quitAndInstall: () => o.quitAndInstall(),
  }
}

let P: ShutdownPorts | null = null
let side: UpdateSide | null = null
let quitting = false
let inFlight: ShutdownKind | null = null
let stuckSheetOpen = false
/** the restart under way (#16, #17): from `quitAndInstall()` until the process ends */
let restart: { version: string; timer: unknown; failed: boolean; announced: boolean } | null = null

/** The one flag: close-to-hide (window.ts) and tabs.json's debounced save (views.ts) read it. */
export const isQuitting = (): boolean => quitting

const msg = (e: unknown): string => String((e as Error)?.message ?? e)

/** views.ts at startViews, where its `before-quit` handler was. */
export function startShutdown(p: ShutdownPorts): void {
  P = p
  // ⌘Q, the menu, the Dock, a logout - as before: prevented and guarded while not quitting; once quitting, the
  // app's own quit (and the installer's, #16) passes
  p.onBeforeQuit((e) => {
    if (quitting) return
    e.preventDefault()
    request('quit')
  })
  // #16: a listener that quits nothing. A single-window Mac app never quits on a closed window, and during a restart
  // Electron's default quit would race Squirrel's arming. A quit in progress never emits it; a restart's close does
  p.onWindowAllClosed(() => { if (restart && !restart.failed) { p.log?.('shutdown', { windowAllClosed: restart.version }); arm(p) } })
}

/** updater.ts, once the model exists; null takes it away (tests). */
export function setUpdateSide(u: UpdateSide | null): void { side = u }

/**
 * The one entry (#15). An update needs its version (`token`, the record's - update-model.ts `act` checked it holds)
 * to be the one ready now. False when ignored.
 */
export function request(kind: ShutdownKind, token?: { version: string }): boolean {
  const p = P
  if (!p) return false
  if (quitting || inFlight) { p.log?.('shutdown', { ignored: kind, ...(inFlight ? { inFlight } : { quitting: true }) }); return false }
  let version: string | undefined
  if (kind === 'update') {
    version = token?.version ?? side?.ready() ?? undefined
    if (!side || !version || side.ready() !== version) { p.log?.('shutdown', { ignored: 'update', version: version ?? null, ready: side?.ready() ?? null }); return false }
  }
  inFlight = kind
  const since = p.now()
  tabsNow(p)                                                                             // the session as the shutdown starts
  p.log?.('quit', kind === 'quit' ? { asked: true } : { asked: true, update: version })
  let answer: Promise<GuardAllAnswer>
  try { answer = p.guardAll({ kind }) } catch (err) { answer = Promise.reject(err) }
  // a throw in the guard (its sheet, an act, a compose): this shutdown is refused, never the next one - one left in
  // flight would swallow every later ⌘Q, Dock quit and logout until Force Quit
  void answer.catch((err: unknown) => {
    p.log?.('quit', { error: msg(err) })
    return 'refused' as const
  }).then((r) => answered(p, kind, version, since, r))
  return true
}

/** writeTabsNow, which never holds the shutdown: a false or a throw is noted and it goes on (#20). */
function tabsNow(p: ShutdownPorts): boolean {
  try {
    const ok = p.writeTabsNow()
    if (!ok) p.log?.('shutdown', { tabsJson: false })
    return ok
  } catch (err) {
    p.log?.('quit', { tabsJson: msg(err) })
    return false
  }
}

function answered(p: ShutdownPorts, kind: ShutdownKind, version: string | undefined, since: number, r: GuardAllAnswer): void {
  inFlight = null
  p.log?.('quit', kind === 'quit' ? { answer: r } : { answer: r, update: version })
  // an unload's close that has not ended (code review r2 #1): this shutdown is over, and the person is asked about it
  if (r === 'stuck') { void stuckSheet(p, kind, version); return }
  if (r !== 'done') {
    if (kind === 'update') refusedUpdate(since)
    // cancelled, and said so where the person can see it: a quit from the Dock or a logout may start with the window
    // hidden (tabs.ts refuse() brought its tab forward); never retried by itself
    try { p.forward() } catch { /* the window went */ }
    return
  }
  done(p, kind, version)
}

/** #15: `waiting` on the tab whose unsaved work refused this request; any other refusal, `ready` again. */
function refusedUpdate(since: number): void {
  const u = side
  if (!u) return
  const t = allTabs().find((x) => x.held?.action === 'update' && x.held.at >= since)
  if (t) u.hold(t.id, t.doc?.commits ?? 0)
  else u.unhold()
}

function done(p: ShutdownPorts, kind: ShutdownKind, version: string | undefined): void {
  // what is saved on the way out never holds the shutdown
  tabsNow(p)
  try { p.notes() } catch (err) { p.log?.('quit', { recent: msg(err) }) }
  quitting = true
  const ready = side?.ready() ?? null
  const restarts = kind === 'update' && !!version && ready === version
  if (side && ready && (restarts || QUIT_INSTALLS)) {
    // #18: written whole and synchronously before the end; a failed write is noted (the writer records it in
    // status.json and the files pill) and the shutdown goes on - the next launch, finding no intent, says nothing
    const ok = side.writeIntent({ from: side.version, to: ready, via: restarts ? 'restart' : 'quit', at: p.now() })
    if (!ok) p.log?.('shutdown', { intent: false })
  }
  try { p.flushAll() } catch (err) { p.log?.('shutdown', { flushAll: msg(err) }) }
  // an update no longer ready by now cannot happen (nothing leaves `ready` but this): every tab is closed, so it ends
  // as a quit rather than not at all
  if (restarts && side!.restarting(version!)) { begin(p, version!); return }
  p.quit()
}

/** #16: `quitAndInstall()`, `quitting` already set, the wait for its end armed first. */
function begin(p: ShutdownPorts, version: string): void {
  restart = { version, timer: null, failed: false, announced: false }
  arm(p)
  p.log?.('shutdown', { quitAndInstall: version })
  try { side!.quitAndInstall() } catch (err) { restartFailed(msg(err)) }
}

/** #17's wait: `restartWaitMs` from the call, counted again from the windows' close. */
function arm(p: ShutdownPorts): void {
  const r = restart
  if (!r || r.failed) return
  if (r.timer !== null) p.clearTimeout(r.timer)
  r.timer = p.setTimeout(() => { r.timer = null; restartFailed(`no exit ${T.restartWaitMs} ms after the windows closed`) }, T.restartWaitMs)
}

/** #16: Electron 45 emits it twice with a window open; the model passes it on once, and it is recorded once. */
export function beforeQuitForUpdate(): void {
  const p = P
  if (!p) return
  const r = restart
  if (!r || r.announced) { p.log?.('shutdown', { beforeQuitForUpdate: r ? 'again' : 'unasked' }); return }
  r.announced = true
  p.record?.({ phase: 'restart', version: r.version })
  p.log?.('shutdown', { beforeQuitForUpdate: r.version })
}

/**
 * #17: the restart's preparation failed - the first `error` while restarting (update-model.ts passes it once), or the
 * wait. The window and every view are gone (Electron closed them before Squirrel's step), so nothing is rebuilt:
 * recorded, the alert once, then the quit (still `quitting`), the intent kept. Squirrel armed its installer at the
 * download, so that quit may still install; the next launch reads the version it finds (#18).
 */
export function restartFailed(message: string): void {
  const p = P
  const r = restart
  if (!p || !r || r.failed) return
  r.failed = true
  if (r.timer !== null) { p.clearTimeout(r.timer); r.timer = null }
  p.record?.({ phase: 'restart-failed', version: r.version, message })
  let shown: Promise<void>
  try { shown = p.alert(restartAlert(r.version)) } catch (err) { shown = Promise.reject(err) }
  void shown.catch((err: unknown) => { p.log?.('shutdown', { alert: msg(err) }) }).then(() => {
    p.log?.('shutdown', { restartFailed: r.version })
    p.quit()
  })
}

/**
 * A shutdown answered 'stuck' (code review r2 #1): an unload's close has not ended within `quitWaitMs`. The shutdown
 * is over and its flags cleared, so a later ⌘Q is heard; the person is asked, through the guard's sheet seam, about the
 * tabs still closing - Keep Waiting (the default, `Esc`) changes nothing: the unload goes on owning its tab and ends at
 * `destroyed`; Force Quit Tab ends each one by hand (unload-act.ts forceUnload: its own `forced` outcome, never a
 * completed unload), then asks again - through guardAll, every other tab guarded as on any quit. One sheet at a time:
 * a later stuck shutdown while it is open only brings the window forward. Moved from views.ts unchanged, but that
 * Force Quit Tab now goes on for an update too (#15).
 */
async function stuckSheet(p: ShutdownPorts, kind: ShutdownKind, version: string | undefined): Promise<void> {
  const stuck = p.stuck()
  // ended meanwhile: nothing to ask, and a later ⌘Q goes through
  if (!stuck.length) { p.log?.('quit', { stuck: 'ended' }); return }
  if (stuckSheetOpen) { p.forward(); return }
  stuckSheetOpen = true
  let force = false
  try {
    force = await p.ask({ action: { kind }, tabs: stuck.map((t) => ({ id: t.id, name: tabName(t), why: { kind: 'stuck' } })) })
  } catch (err) { p.log?.('quit', { stuckSheet: msg(err) }) } finally { stuckSheetOpen = false }
  if (!force) { p.log?.('quit', { stuck: 'keep-waiting', tabs: stuck.map((t) => t.id) }); return }
  // only those still closing: one that ended while the sheet was open is not forced
  const forced = stuck.filter((t) => getTab(t.id) === t && p.forceUnload(t)).map((t) => t.id)
  p.log?.('quit', { stuck: 'forced', tabs: forced })
  request(kind, version ? { version } : undefined)
}

/** The coordinator's state, for the `shutdown` test hook. */
export function shutdownState(): { quitting: boolean; inFlight: ShutdownKind | null; restart: { version: string; failed: boolean; announced: boolean } | null } {
  return { quitting, inFlight, restart: restart ? { version: restart.version, failed: restart.failed, announced: restart.announced } : null }
}

/** Test seam. */
export function resetShutdown(): void {
  if (restart?.timer != null) P?.clearTimeout(restart.timer)
  P = null; side = null; quitting = false; inFlight = null; stuckSheetOpen = false; restart = null
}
