/**
 * The updater's Electron side (spec 28 A5.1 #4, #13, #14, #18, #21, #22, #24, #25): update-model.ts's pure model
 * driven through its ports. main.ts starts it once the views exist (the pill and the menu are there).
 *
 * - **The adapter**: Electron's `autoUpdater`, as it is; a test build's live fake behind `MARVER_APP_FAKE_UPDATER=1`
 *   (testing/updater.ts), never a feed (#4). The clock is `performance.now()` and the timers.
 * - **The feed** is `__MARVER_FEED__` alone (#4): never `app.isPackaged`, never `__MARVER_RELEASE__`, which ad-hoc builds
 *   share. Empty, the updater is `blocked('feed')` and has no menu item.
 * - **The gates** (#13): `app.isInApplicationsFolder()` - Electron 45 counts every domain's Applications folder,
 *   `~/Applications` included - and W_OK on the bundle and its folder, the two things Squirrel reads. A bundle on a
 *   read-only volume is `location`, never `write` (#24: an installation-location problem, as Squirrel's own
 *   `SQRLUpdaterErrorReadOnlyVolume` would be).
 * - **#18's reconciliation**, at launch before the first check, against the version actually running
 *   (`app.getVersion()`): `to` is "Updated to X" (tier 2, sub `update`) and `installed`; `from` is the update's
 *   `failure` and its pill, `install-failed`; anything else, or an intent over 30 days old, is cleared and recorded,
 *   nothing shown. The moved copy's one-time note (#23, v1.33) the same way: "Marver moved itself to Applications.",
 *   once, cleared as it is shown; over 30 days old, cleared unshown.
 * - **Ports**: every state change chooses the pill again (tier 5, pill.ts) and rebuilds the menu (`invalidateMenu`, the
 *   model's JSON being part of the menu's key, #22); a manual check's end is a confirmation; Restart to Update and Try
 *   Again are the shutdown coordinator's `request('update')` (#15); Download opens the DMG's link; a blocked item's
 *   alert explains (#22); the coordinator's side is set here (`updateSide`).
 * - **A waiting update** (#21) goes back to `ready` when its tab's fresh `unsaved` turns false, the tab closes or its
 *   document changes (`updaterTabs`, from views.ts's reports and tab changes; pill.ts `waitingEnds`).
 * - **Settings** (spec 33 C): `updateRowNow()` is its Updates row; every change pushes `status`, so it asks again;
 *   `autoUpdate` off stops the automatic checks (the model's `auto`).
 */
import { accessSync, appendFileSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app, autoUpdater, BaseWindow, dialog, net, powerMonitor } from 'electron'
import type { UpdateBody } from '../../../src/shared/app-perf.ts'
import { BLOCKED_TITLE, type UpdateRow } from '../shared/channels.ts'
import { tilde } from '../shared/command.ts'
import { appCmd } from './commands.ts'
import { pushStatus, readUpdateFile, values, writeUpdateFile, type UpdateFile } from './config.ts'
import { invalidateMenu } from './menu.ts'
import { APP_NAME, APPS } from './mover.ts'
import { confirm, setUpdatePill, waitingEnds } from './pill.ts'
import { beforeQuitForUpdate, request, restartFailed, setUpdateSide, updateSide } from './shutdown.ts'
import { getTab, tabName } from './tabs.ts'
import { LiveFakeUpdater, type FakeAnswer, type FakeRestart } from './testing/updater.ts'
import { note, provide, testMode } from './testing/index.ts'
import { T } from './timings.ts'
import {
  menuItem, pillOf, startUpdates, updateRow, type BlockedWhy, type CheckAnswer, type UpdateClock, type UpdateFailure, type UpdateGates, type UpdateMenuItem, type UpdateModel,
  type UpdaterAdapter, type UpdateState, type UpdateToken,
} from './update-model.ts'

/** Every download link (#29): the latest release's DMG, one name in every release. */
export const DOWNLOAD_URL = 'https://github.com/TNEP4/marver-app/releases/latest/download/Marver-arm64.dmg'
/** Settings' Release notes (spec 33 C4): the GitHub release of a version. */
export const releaseNotesUrl = (version: string): string => `https://github.com/TNEP4/marver-app/releases/tag/v${version}`

const j = (topic: string, data: unknown) => { if (__MV_TEST__) note(topic, data) }

// ---- the words (frozen, #41: the docs copy them) ------------------------------------------------------------------

/** A tier-2 confirmation (sub `update`): `lead` bold, then `text`; `short` below 960 px. */
export interface UpdateWords { lead?: string; text: string; short: string }

/** #14: a manual check's end; a check that finds one says nothing. The text is update-model.ts's `answerText`. */
export const ANSWER_SHORT: Record<CheckAnswer, string> = { current: 'Up to date', offline: "You're offline", later: "Couldn't check" }
/** #18: the first launch after an update. */
export const updatedWords = (version: string): UpdateWords => ({ text: `Updated to ${version}`, short: 'Updated' })
/** #23 (v1.33): the moved copy's first launch - from a disk image, or from a folder by its name (none known: no second line). */
export function movedWords(from: string): UpdateWords {
  const then = from === 'dmg' ? 'You can eject the disk image.' : from ? `You can delete the copy in ${from}.` : ''
  return { lead: 'Marver moved itself to Applications.', text: then, short: 'Moved to Applications' }
}

/** #22: a blocked item's alert - why, and what to do. `buttons[0]` is the default, and what Esc answers. */
export interface ExplainAlert { message: string; detail: string; buttons: string[] }
export function explainAlert(why: Exclude<BlockedWhy, 'feed'>, o: { folder: string; declined: boolean }): ExplainAlert {
  if (why === 'location') {
    return {
      message: BLOCKED_TITLE.location,
      detail: `This Marver runs from ${o.folder}. Quit it, move it to Applications, and open it from there: it then checks for updates on its own.`
        + (o.declined ? '\n\nMarver was told not to move itself there. Move at Next Launch lets it, the next time it opens from here.' : ''),
      buttons: ['OK', 'Show in Finder', ...(o.declined ? ['Move at Next Launch'] : [])],
    }
  }
  if (why === 'write') {
    return {
      message: BLOCKED_TITLE.write,
      detail: `Updating replaces Marver where it is, and this account can't change ${o.folder}. Download the latest Marver and install it again to update.`,
      buttons: ['OK', 'Download'],
    }
  }
  return {
    message: BLOCKED_TITLE.setup,
    detail: "Its updater couldn't start on this Mac. Download the latest Marver to update by hand.",
    buttons: ['OK', 'Download'],
  }
}

// ---- #18's reconciliation (pure) ----------------------------------------------------------------------------------

export interface Reconciled {
  /** update.json as it should now be; `changed` when it must be written */
  next: UpdateFile
  changed: boolean
  records: UpdateBody[]
  show: UpdateWords | null
  failure: UpdateFailure | null
  installed: boolean
}

/**
 * update.json at launch, against the version running - never the one expected (#18). The intent and the moved note
 * (#23) are cleared as they are read: each lives for one launch. A declined `move` and a `staging` record are the
 * mover's, kept. An intent that reads neither version is recorded `late` with why `intent` (no record phase names it),
 * one over 30 days old with why `intent-old`. The moved note is the moved copy's alone (code review r1 P3): read and
 * cleared only by a copy running from the mover's destination, so the copy it came from, opened again, leaves it.
 */
export function reconcile(f: UpdateFile, running: string, now: number, atDestination: boolean): Reconciled {
  const out: Reconciled = { next: { ...f }, changed: false, records: [], show: null, failure: null, installed: false }
  const i = f.intent
  if (i) {
    out.next.intent = null
    out.changed = true
    if (now - i.at > T.updateNoteMaxMs) out.records.push({ phase: 'late', why: 'intent-old', from: i.from, to: i.to, version: running })
    else if (running === i.to) {
      out.records.push({ phase: 'installed', from: i.from, to: i.to, version: running })
      out.show = updatedWords(i.to)
      out.installed = true
    } else if (running === i.from) {
      out.records.push({ phase: 'install-failed', from: i.from, to: i.to, version: running })
      out.failure = { from: i.from, to: i.to, at: now }
    } else out.records.push({ phase: 'late', why: 'intent', from: i.from, to: i.to, version: running })
  }
  const m = f.move
  if (m && 'moved' in m && atDestination) {
    out.next.move = null
    out.changed = true
    // the move itself, recorded by the copy it made: the copy that moved quit before its records could be written
    out.records.push({ phase: 'move', why: 'moved', version: running })
    if (now - m.at <= T.updateNoteMaxMs && !out.show) out.show = movedWords(m.from)
  }
  return out
}

// ---- the gates (#13, #24) -----------------------------------------------------------------------------------------

/** The `.app` bundle an executable runs from: the last `X.app` before `Contents/MacOS/<name>`. */
export function bundleOf(exe: string): string | null {
  const m = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe)
  return m ? m[1]! : null
}

/** W_OK on the bundle and its folder; a read-only volume is a location problem (#24). */
export function gatesOf(inApplications: boolean, bundle: string | null, access: (p: string) => void): UpdateGates {
  if (!bundle) return { inApplications, writable: false }
  let writable = true
  for (const p of [bundle, dirname(bundle)]) {
    try { access(p) } catch (e) {
      writable = false
      if ((e as NodeJS.ErrnoException).code === 'EROFS') return { inApplications: false, writable: false }
    }
  }
  return { inApplications, writable }
}

function readGates(): UpdateGates {
  let inApplications = false
  try { inApplications = app.isInApplicationsFolder() } catch { /* outside, as far as anyone can tell */ }
  return gatesOf(inApplications, bundleOf(app.getPath('exe')), (p) => accessSync(p, constants.W_OK))
}

// ---- the running updater ------------------------------------------------------------------------------------------

export interface UpdaterStart {
  /** the `update` record (#25), written whatever `recorder` says */
  record(body: UpdateBody): void
  /** a link in the browser (views.ts `openOutside`: recorded in a test build) */
  openExternal(url: string): void
  /** a file selected in Finder (recorded in a test build) */
  reveal(path: string): void
  /** tests: another adapter, clock, gates, feed and version than Electron's (the unit cases' fakes) */
  adapter?: UpdaterAdapter
  clock?: UpdateClock
  gates?: UpdateGates
  feed?: string
  version?: string
  /** tests: an alert answered by the case (else a native one, or in a test build the seam's answer) */
  ask?(a: ExplainAlert): Promise<string>
}

let model: UpdateModel | null = null
let started: UpdaterStart | null = null
let runVersion = ''

/** The Marver menu's item (#22), for views.ts's menu model: none before the updater starts, none while blocked by the feed. */
export const updateMenu = (): UpdateMenuItem | null => (model ? menuItem(model.state()) : null)
/** The menu's and the pill's one entry (#22): acts only while the token holds. */
export const updateAct = (t: UpdateToken): boolean => model?.act(t) ?? false
const nameOf = (tab: string): string => { const t = getTab(tab); return t ? tabName(t) : 'a closed tab' }
/** Settings' Updates row (spec 33 C2): `idle` with no button before the updater starts. */
export function updateRowNow(): UpdateRow {
  if (!model) return { show: 'idle', version: app.getVersion(), checkedAt: null, token: null }
  return updateRow(model.state(), runVersion, nameOf)
}
/** Settings' Release notes (spec 33 C4): the version the update goes to, else the one running. */
export function openReleaseNotes(): void {
  const r = updateRowNow()
  started?.openExternal(releaseNotesUrl(r.next ?? r.version))
}

/**
 * #21: a waiting update goes back to `ready` when its tab's fresh `unsaved` turns false (`reportTab`: a report of that
 * tab just accepted), the tab closes, or its document changes; never on a tab switch or a stale report.
 */
export function updaterTabs(reportTab?: string): void {
  const p = model?.state().phase
  if (!model || p?.kind !== 'waiting') return
  if (waitingEnds(p, reportTab)) model.unhold(p.tab)
}

/** A test build's fake and its answers (the hooks below). */
let fake: LiveFakeUpdater | null = null
let onlineStub: boolean | null = null
const alertsShown: ExplainAlert[] = []
let alertAnswer: string | null = null

const clockOf = (): UpdateClock => ({
  now: () => performance.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setImmediate: (fn) => { setImmediate(fn) },
})

/** Every window closed, as Electron's quitAndInstall() closes them (the live fake's). */
function closeWindows(say: (e: string) => void): Promise<void> {
  return new Promise((done) => {
    const wins = BaseWindow.getAllWindows()
    if (!wins.length) { done(); return }
    let left = wins.length
    for (const w of wins) { w.once('closed', () => { say('window-closed'); if (--left === 0) done() }); w.close() }
  })
}

/** Starts the updater (#13): #18's reconciliation, then the model's gates and setup. */
export function startUpdater(s: UpdaterStart): UpdateModel {
  started = s
  let adapter: UpdaterAdapter = s.adapter ?? autoUpdater
  let feed = s.feed ?? __MARVER_FEED__
  let version = s.version ?? app.getVersion()
  let gates = s.gates
  if (__MV_TEST__ && !s.adapter && testMode() && process.env.MARVER_APP_FAKE_UPDATER === '1') {
    // the dev flavour's fake (#4, #34): a feed of its own that nothing fetches, the gates and the version the case says.
    // The restart's events go to a file the case names, appended as they happen: what it reads once the process is gone
    const log = process.env.MARVER_APP_FAKE_UPDATER_LOG
    const say = (e: string) => { if (log) try { appendFileSync(log, `${e}\n`) } catch { /* the case reads what landed */ } }
    fake = new LiveFakeUpdater({ closeWindows: () => closeWindows(say), quit: () => app.quit(), later: (fn) => { setImmediate(fn) } })
    if (log) {
      fake.on('before-quit-for-update', () => say('before-quit-for-update'))
      // heard only beside the coordinator's own listener: one of the case's would hold Electron's default quit off by
      // itself, and the race the coordinator's listener prevents (#16) would go unseen
      if (app.listenerCount('window-all-closed') > 0) app.on('window-all-closed', () => say('window-all-closed'))
      app.on('before-quit', () => say('before-quit'))
      app.on('will-quit', () => say('will-quit'))
      process.on('exit', (code) => say(`exit ${code}`))
    }
    const next = process.env.MARVER_APP_FAKE_OFFER
    if (next) fake.next = { kind: 'offer', version: next, notes: 'What changed\nAnd more' }
    const r = process.env.MARVER_APP_FAKE_RESTART
    if (r === 'error' || r === 'silent') fake.restart = r
    adapter = fake
    const blocked = process.env.MARVER_APP_FAKE_GATES
    feed = blocked === 'feed' ? '' : 'https://example.invalid/marver-app/releases.json'
    version = process.env.MARVER_APP_FAKE_VERSION || version
    gates = { inApplications: blocked !== 'location', writable: blocked !== 'write' }
  }
  const run = version
  runVersion = run
  const ports = {
    adapter, clock: s.clock ?? clockOf(), feed, version: run,
    record: (b: UpdateBody) => s.record(b),
    changed: (st: UpdateState) => {
      setUpdatePill(pillOf(st, nameOf), updateAct)
      invalidateMenu()
      pushStatus()
      j('update', { phase: st.phase, failure: st.failure })
    },
    answer: (a: CheckAnswer, text: string) => confirm('update', { text, short: ANSWER_SHORT[a] }),
    online: () => (__MV_TEST__ && onlineStub !== null ? onlineStub : net.isOnline()),
    request: (kind: 'update', t: { version: string }) => { request(kind, t) },
    openDownload: () => s.openExternal(DOWNLOAD_URL),
    explain: (why: Exclude<BlockedWhy, 'feed'>) => { void explain(why) },
    restartFailed: (message: string) => restartFailed(message),
    beforeQuitForUpdate: () => beforeQuitForUpdate(),
    auto: () => values().config.autoUpdate !== false,
  }
  const m = startUpdates(ports, gates ?? readGates())
  model = m
  // the model told its first state (setup, or a gate's block) before it was here for the menu to read: told again
  ports.changed(m.state())
  setUpdateSide(updateSide(m, {
    version: run,
    writeIntent: (i) => writeUpdateFile({ ...readUpdateFile(), intent: i }),
    quitAndInstall: () => adapter.quitAndInstall(),
  }))

  // #18, before the first check (updateFirstMs after setup ends)
  const here = bundleOf(app.getPath('exe'))
  const r = reconcile(readUpdateFile(), run, Date.now(), here !== null && here === join(APPS, APP_NAME))
  for (const b of r.records) s.record(b)
  if (r.changed && !writeUpdateFile(r.next)) j('update', { reconciled: 'not written' })
  if (r.failure) m.failed(r.failure)
  if (r.installed) m.installed()
  if (r.show) confirm('update', r.show)

  if (!s.adapter) {
    powerMonitor.on('resume', () => { m.wake() })
    app.on('will-quit', () => m.stop())
  }
  if (__MV_TEST__ && testMode()) hooks()
  return m
}

/** #22: a blocked item's alert, and what its buttons do. */
async function explain(why: Exclude<BlockedWhy, 'feed'>): Promise<void> {
  const s = started
  if (!s) return
  const bundle = bundleOf(app.getPath('exe'))
  const folder = bundle ? tilde(dirname(bundle), homedir()) : 'here'
  const f = readUpdateFile()
  const declined = !!f.move && 'declined' in f.move
  const a = explainAlert(why, { folder, declined })
  const choice = await ask(a)
  j('update', { explained: why, choice })
  // spec 30's update-alert: the answer, a fixed button name; OK backs out
  const h = appCmd('update-alert', { via: 'click', in: 'main', arg: choice })
  if (choice === 'OK') { h.cancel(); return }
  if (choice === 'Show in Finder') {
    if (!bundle) { h.noop('no-bundle'); return }                     // not run from an app: nothing to select
    s.reveal(bundle)
  } else if (choice === 'Download') s.openExternal(DOWNLOAD_URL)
  else if (choice === 'Move at Next Launch') {
    // #23: the one way back from a declined move - the next launch from here moves into an empty Applications slot
    const now = readUpdateFile()
    if (now.move && 'declined' in now.move) writeUpdateFile({ ...now, move: null })
  }
  h.done()
}

async function ask(a: ExplainAlert): Promise<string> {
  if (started?.ask) return started.ask(a)
  if (__MV_TEST__ && testMode()) {
    alertsShown.push(a)
    const pick = alertAnswer && a.buttons.includes(alertAnswer) ? alertAnswer : a.buttons[0]!
    alertAnswer = null
    return pick
  }
  const r = await dialog.showMessageBox({ type: 'info', message: a.message, detail: a.detail, buttons: a.buttons, defaultId: 0, cancelId: 0, noLink: true })
  return a.buttons[r.response] ?? a.buttons[0]!
}

/** Test builds: the fake's events and answers, the state, the alerts (A5.1 #34, #35). */
function hooks(): void {
  const arg = <A>(a: unknown) => (a ?? {}) as A
  provide('updater', () => ({
    state: model?.state() ?? null, menu: updateMenu(), calls: fake ? [...fake.calls] : null, feeds: fake ? [...fake.feeds] : null,
    file: readUpdateFile(), alerts: [...alertsShown],
  }))
  provide('updater:act', (a) => updateAct(arg<{ token: UpdateToken }>(a).token))
  provide('updater:wake', () => model?.wake() ?? false)
  provide('updater:online', (a) => { const v = arg<{ online: boolean | null }>(a).online; onlineStub = typeof v === 'boolean' ? v : null; return true })
  provide('updater:answer', (a) => { alertAnswer = arg<{ button: string | null }>(a).button ?? null; return true })
  provide('updater:fake', (a) => {
    if (!fake) return false
    const o = arg<{ next?: FakeAnswer | null; restart?: FakeRestart }>(a)
    if (o.next !== undefined) fake.next = o.next
    if (o.restart) fake.restart = o.restart
    return true
  })
  provide('updater:emit', (a) => {
    if (!fake) return false
    const o = arg<{ event: 'checking-for-update' | 'update-available' | 'update-not-available' | 'error' | 'before-quit-for-update' | 'update-downloaded'; version?: string; notes?: string; message?: string }>(a)
    if (o.event === 'update-downloaded') fake.downloaded(o.version ?? '0.0.0', o.notes ?? '')
    else if (o.event === 'error') fake.fail(o.message ?? 'mv-test: an updater error')
    else fake.emit(o.event)
    return true
  })
}

/** Test seam (unit cases). */
export function resetUpdater(): void {
  model?.stop()
  model = null; started = null; runVersion = ''; fake = null; onlineStub = null; alertsShown.length = 0; alertAnswer = null
  setUpdateSide(null)
}
