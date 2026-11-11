/**
 * The updater's attempts and its one state model (spec 28 A5.1 #13, #14, #21, #22, #25; spike S6). Pure (no Electron
 * import): updater.ts gives it Electron's `autoUpdater` as the adapter, `performance.now()` and the timers as the
 * clock, and the recorder, the pill, the menu and the shutdown coordinator as ports. Nothing persists: every launch
 * starts afresh, so a clock change or a corrupt file can never skip or repeat a check.
 *
 * - **Gates** (#13): no feed, outside the Applications folder, or a bundle or folder the person cannot write:
 *   `blocked(why)`, one record, and no adapter call at all.
 * - **Setup** (#13, r1 #5): the six listeners first, then `setFeedURL` once, in a `try`. A throw, or an `error` before
 *   setup ends - one macrotask after the call returns, since Electron 45's SetFeedURL reports Squirrel's failure as an
 *   event and returns with no native updater - is `blocked('setup')` for the launch. Then `idle`.
 * - **One attempt at a time** (#14): only `idle` starts one, and it is in flight before `checkForUpdates()` is called,
 *   so an event inside the call is its own. It ends once: at `update-not-available`, `update-downloaded`, `error`, or a
 *   synchronous throw. `update-available` is its middle (the zip downloading).
 * - **Errors by phase**, before the late rule: `setup` blocks; `checking`/`downloading` end the attempt; `restarting`
 *   is #17's; `ready`/`waiting` are recorded with the state unchanged; `idle`/`blocked` are recorded `late`.
 * - **Late**: any other event with no attempt in flight is recorded and changes nothing - but `update-downloaded`
 *   always means ready (Squirrel holds the bundle).
 * - **When** (#14): one timer for the next automatic attempt, `updateFirstMs` after setup ends, then `updateEveryMs`
 *   after each attempt's end; a wake starts one only when none started in `updateWakeQuietMs`; Check for Updates….
 *   Once `ready`, nothing starts again this launch and the feed is never set again.
 * - **The failure** (#14, #18) is apart from the phase: a check runs while it is shown. Dismiss, a later
 *   `update-downloaded` and a later `installed` clear it.
 * - **Actions** (#21, #22): the pill and the menu call `act(token)`, which acts only while its token still holds.
 * - **Spec 33** (app 1.2.1): `last`, the last check's end on the wall clock (Settings' "Last checked"); `auto`, the
 *   `autoUpdate` key - off, the timer and a wake start nothing (a manual check still runs); `updateRow`, Settings' view.
 */
import type { UpdateBody } from '../../../src/shared/app-perf.ts'
import type { BlockedWhy, UpdateRow, UpdateToken } from '../shared/channels.ts'
import { T } from './timings.ts'

// ---- the frozen contracts (#41) ---------------------------------------------------------------------------------

type Listener<A extends unknown[] = []> = (...args: A) => void

/** Electron's `autoUpdater`, as far as the updater uses it (#13): Electron's object is one, as it is. */
export interface UpdaterAdapter {
  on(event: 'checking-for-update', listener: Listener): unknown
  on(event: 'update-available', listener: Listener): unknown
  on(event: 'update-not-available', listener: Listener): unknown
  on(event: 'update-downloaded', listener: Listener<[event: unknown, releaseNotes: string, releaseName: string, releaseDate: Date, updateURL: string]>): unknown
  on(event: 'error', listener: Listener<[error: Error]>): unknown
  on(event: 'before-quit-for-update', listener: Listener): unknown
  setFeedURL(options: { url: string; serverType?: 'json' | 'default' }): void
  checkForUpdates(): void
  quitAndInstall(): void
}

export type { BlockedWhy, UpdateRow, UpdateToken }

/** Eight values (#14). `downloading` is the middle of an attempt; `waiting` is an update refused by a tab's unsaved work. */
export type UpdatePhase =
  | { kind: 'setup' }
  | { kind: 'blocked'; why: BlockedWhy }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'downloading' }
  | { kind: 'ready'; version: string; notes: string }
  | { kind: 'waiting'; version: string; notes: string; tab: string; commit: number }
  | { kind: 'restarting'; version: string }

/** #18's reconciliation found the version it left: the update did not install. */
export interface UpdateFailure { from: string; to: string; at: number }

/** `last` (spec 33 C1): the last check's end this launch, `at` on the wall clock; null until one ends. */
export interface UpdateState { phase: UpdatePhase; failure: UpdateFailure | null; last: { at: number; ok: boolean } | null }

/** The `update` record (#25), frozen in app-perf.ts beside the other kinds. */
export type { UpdateBody }

/** A manual check's end, as the pill says it (#14); a check that finds one says nothing. */
export type CheckAnswer = 'current' | 'offline' | 'later'

/** The timers run on this (#14): a monotonic clock, its timeouts, and one macrotask later for setup's end. */
export interface UpdateClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setImmediate(fn: () => void): void
}

export interface UpdatePorts {
  adapter: UpdaterAdapter
  clock: UpdateClock
  /** `__MARVER_FEED__`: '' in every build but a release's (#4) */
  feed: string
  /** the version running, `app.getVersion()` */
  version: string
  record(body: UpdateBody): void
  /** every change of phase or failure: the pill chooses again, the menu is rebuilt (`invalidateMenu`) */
  changed(s: UpdateState): void
  /** a manual check's end (tier 2, sub `update`) */
  answer(a: CheckAnswer, text: string): void
  /** `net.isOnline()`, read when a manual check ends in an error */
  online(): boolean
  /** the coordinator's one entry (#15): Restart to Update and Try Again */
  request(kind: 'update', token: { version: string }): void
  /** Download: `latest/download/Marver-arm64.dmg` in the browser (#18) */
  openDownload(): void
  /** a blocked menu item's alert (#22) */
  explain(why: Exclude<BlockedWhy, 'feed'>): void
  /** #17: the first `error` while restarting; the coordinator records `restart-failed`, alerts once and quits */
  restartFailed(message: string): void
  /** Electron 45 emits it twice with a window open (#16): passed on once */
  beforeQuitForUpdate(): void
  /** spec 33 C1: `autoUpdate`, read at each automatic start; absent reads true */
  auto?(): boolean
}

/** What updater.ts reads before setup (#13): `app.isInApplicationsFolder()`, and W_OK on the bundle and its folder. */
export interface UpdateGates { inApplications: boolean; writable: boolean }

export interface UpdateModel {
  state(): UpdateState
  /** the menu's item and the pill's buttons, one entry (#22): acts only while the token holds */
  act(token: UpdateToken): boolean
  /** the Mac woke (`powerMonitor`'s `resume`) */
  wake(): boolean
  /** #15: an update refused by this tab's unsaved work */
  hold(tab: string, commit: number): boolean
  /** #21: the waiting tab's `unsaved` turned false, it closed or its document changed; with no tab, any refusal but unsaved work (#15) */
  unhold(tab?: string): boolean
  /** #15, #16: the coordinator's `done`, just before it calls `quitAndInstall()` */
  restarting(version: string): boolean
  /** #18's reconciliation: `install-failed` sets the failure, `installed` clears it */
  failed(f: UpdateFailure): void
  installed(): void
  /** the quit: no timer left */
  stop(): void
}

// ---- the rules on a state (pure) --------------------------------------------------------------------------------

const held = (p: UpdatePhase): p is Extract<UpdatePhase, { kind: 'ready' | 'waiting' }> => p.kind === 'ready' || p.kind === 'waiting'

/** Each action's requirement (#21, r1 #8): a click whose token no longer holds does nothing. */
export function holds(s: UpdateState, t: UpdateToken): boolean {
  const p = s.phase
  switch (t.act) {
    case 'check': return p.kind === 'idle'
    case 'restart': return held(p) && p.version === t.version
    case 'try-again': return p.kind === 'waiting' && p.version === t.version
    case 'download': case 'dismiss': return s.failure?.to === t.version
    case 'explain': return p.kind === 'blocked' && p.why === t.why
  }
}

export interface UpdateMenuItem { label: string; enabled: boolean; token: UpdateToken | null }

/** The Marver menu's item after About Marver (#22); none while blocked by the feed. */
export function menuItem(s: UpdateState): UpdateMenuItem | null {
  const p = s.phase
  const off = (label: string): UpdateMenuItem => ({ label, enabled: false, token: null })
  switch (p.kind) {
    case 'blocked':
      if (p.why === 'feed') return null
      return { label: p.why === 'location' ? 'Updates Need the Applications Folder…' : 'Updates Unavailable…', enabled: true, token: { act: 'explain', why: p.why } }
    case 'setup': return off('Check for Updates…')
    case 'idle': return { label: 'Check for Updates…', enabled: true, token: { act: 'check' } }
    case 'checking': return off('Checking for Updates…')
    case 'downloading': return off('Downloading Update…')
    case 'ready': case 'waiting': return { label: 'Restart to Install Update', enabled: true, token: { act: 'restart', version: p.version } }
    case 'restarting': return off('Restarting…')
  }
}

export interface UpdatePill {
  show: 'ready' | 'waiting' | 'failed'
  version: string
  /** `waiting`'s refusing tab and its document (`commit`), which pill.ts's onPillAction checks again */
  tab?: string
  commit?: number
  text: string
  short: string
  button: { label: string; token: UpdateToken }
  tooltip?: string
  dismiss?: UpdateToken
}

/** The update's pill, tier 5 (#21): `ready` or `waiting` first, else the failure whatever the phase, else none. */
export function pillOf(s: UpdateState, tabName: (tab: string) => string): UpdatePill | null {
  const p = s.phase
  if (p.kind === 'ready') {
    const tip = p.notes.split('\n').map((l) => l.trim()).find(Boolean)
    return { show: 'ready', version: p.version, text: `${p.version} is ready`, short: 'Restart to Update', button: { label: 'Restart to Update', token: { act: 'restart', version: p.version } }, ...(tip ? { tooltip: tip } : {}) }
  }
  if (p.kind === 'waiting') {
    return { show: 'waiting', version: p.version, tab: p.tab, commit: p.commit, text: `${p.version} waits for ${tabName(p.tab)}`, short: 'Update waits', button: { label: 'Try Again', token: { act: 'try-again', version: p.version } } }
  }
  const f = s.failure
  if (!f) return null
  return { show: 'failed', version: f.to, text: `${f.to} couldn't be installed`, short: 'Update failed', button: { label: 'Download', token: { act: 'download', version: f.to } }, dismiss: { act: 'dismiss', version: f.to } }
}

/** One line per non-empty line of the feed's notes, "- " stripped, at most 5 (spec 33 C4). */
export const noteLines = (notes: string): string[] =>
  notes.split('\n').map((l) => l.trim().replace(/^- /, '').trim()).filter(Boolean).slice(0, 5)

/** Settings' Updates row (spec 33 C3): the state as a row, first match wins. */
export function updateRow(s: UpdateState, version: string, tabName: (tab: string) => string): UpdateRow {
  const p = s.phase
  const checkedAt = s.last?.at ?? null
  const row = (show: UpdateRow['show'], token: UpdateToken | null, more: Partial<UpdateRow> = {}): UpdateRow => ({ show, version, checkedAt, token, ...more })
  switch (p.kind) {
    case 'blocked': return p.why === 'feed' ? row('off', null) : row('blocked', { act: 'explain', why: p.why }, { why: p.why })
    case 'restarting': return row('restarting', null, { next: p.version })
    case 'ready': return row('ready', { act: 'restart', version: p.version }, { next: p.version, notes: noteLines(p.notes) })
    case 'waiting': return row('waiting', { act: 'try-again', version: p.version }, { next: p.version, notes: noteLines(p.notes), tab: tabName(p.tab) })
    case 'checking': return row('checking', null)
    case 'downloading': return row('downloading', null)
    case 'setup': return row('idle', null)
    case 'idle':
      if (s.failure) return row('failed', { act: 'download', version: s.failure.to }, { next: s.failure.to })
      if (s.last) return row(s.last.ok ? 'current' : 'error', { act: 'check' })
      return row('idle', { act: 'check' })
  }
}

/** A manual check's words (#14). */
export function answerText(a: CheckAnswer, version: string): string {
  if (a === 'current') return `Marver ${version} is up to date`
  return `Couldn't check for updates · ${a === 'offline' ? "You're offline" : 'Try again later'}`
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ---- the model --------------------------------------------------------------------------------------------------

/** Starts the updater once the views exist (#13): the gates, then setup; an attempt only from `idle`. */
export function startUpdates(p: UpdatePorts, g: UpdateGates): UpdateModel {
  const c = p.clock
  let phase: UpdatePhase = { kind: 'setup' }
  let failure: UpdateFailure | null = null
  let last: UpdateState['last'] = null
  const auto = (): boolean => p.auto?.() ?? true
  /** the attempt in flight: set before `checkForUpdates()` is called, cleared at its one end */
  let flight: { id: number; manual: boolean } | null = null
  let ids = 0
  let lastStart: number | null = null
  let next: unknown = null
  let slow: unknown = null
  let quitPassed = false
  let restartPassed = false

  const state = (): UpdateState => ({ phase, failure, last })
  const set = (ph: UpdatePhase, f: UpdateFailure | null = failure): void => { phase = ph; failure = f; p.changed(state()) }
  const clear = (h: unknown): null => { if (h !== null) c.clearTimeout(h); return null }
  const quiet = (): void => { next = clear(next); slow = clear(slow) }
  /** the next automatic attempt: one timer, replaced at every end; one firing mid-attempt starts nothing, and with
   *  `autoUpdate` off (spec 33 C1) none starts and the timer is armed again */
  const arm = (ms: number): void => {
    next = clear(next)
    next = c.setTimeout(() => { next = null; if (auto()) start(false); else arm(T.updateEveryMs) }, ms)
  }

  function block(why: BlockedWhy, message?: string): void {
    if (phase.kind === 'blocked') return   // once per launch
    quiet()
    set({ kind: 'blocked', why })
    p.record({ phase: 'blocked', why, ...(message !== undefined ? { message } : {}) })
  }

  function start(manual: boolean): boolean {
    if (phase.kind !== 'idle') return false
    const id = ++ids
    flight = { id, manual }
    lastStart = c.now()
    slow =c.setTimeout(() => { slow = null; if (flight?.id === id) p.record({ phase: 'slow', attempt: id }) }, T.updateSlowMs)
    set({ kind: 'checking' })
    p.record({ phase: 'check', attempt: id, ...(manual ? { manual: true } : {}) })
    try {
      p.adapter.checkForUpdates()
    } catch (e) {
      // the throw ends its attempt, unless an event inside the call already did
      if (flight?.id === id) end({ how: 'error', message: messageOf(e) })
      else p.record({ phase: 'late', why: 'throw', attempt: id, message: messageOf(e) })
    }
    return true
  }

  type End = { how: 'current' } | { how: 'error'; message: string } | { how: 'downloaded'; version: string; notes: string }
  function end(e: End): void {
    const f = flight!
    flight = null
    slow = clear(slow)
    if (e.how === 'downloaded') {
      p.record({ phase: 'downloaded', attempt: f.id, version: e.version })
      ready(e.version, e.notes)
      return
    }
    p.record(e.how === 'current' ? { phase: 'current', attempt: f.id } : { phase: 'error', attempt: f.id, message: e.message })
    last = { at: Date.now(), ok: e.how === 'current' }
    set({ kind: 'idle' })
    arm(T.updateEveryMs)
    if (!f.manual) return
    const a: CheckAnswer = e.how === 'current' ? 'current' : p.online() ? 'later' : 'offline'
    p.answer(a, answerText(a, p.version))
  }

  /** for good: no timer, no attempt, no `setFeedURL` again this launch; the bundle downloaded is the one installed */
  function ready(version: string, notes: string): void {
    quiet()
    set({ kind: 'ready', version, notes }, null)
  }

  function onEvent(name: 'checking-for-update' | 'update-available' | 'update-not-available'): void {
    if (!flight) { p.record({ phase: 'late', why: name }); return }
    if (name === 'update-not-available') end({ how: 'current' })
    else if (name === 'update-available' && phase.kind === 'checking') {
      set({ kind: 'downloading' })
      p.record({ phase: 'downloading', attempt: flight.id })
    }
  }

  function onDownloaded(notes: unknown, name: unknown): void {
    const version = typeof name === 'string' ? name : ''
    const text = typeof notes === 'string' ? notes : ''
    if (flight) { end({ how: 'downloaded', version, notes: text }); return }
    p.record({ phase: 'late', why: 'update-downloaded', version })
    // Squirrel holds a bundle: ready, unless one is already held - the first stays the one installed
    if (!held(phase) && phase.kind !== 'restarting') ready(version, text)
  }

  /** Dispatched by phase, before any rule about late events (#14, r1 #5). */
  function onError(err: unknown): void {
    const message = messageOf(err)
    switch (phase.kind) {
      case 'setup': block('setup', message); return
      case 'checking': case 'downloading': end({ how: 'error', message }); return
      case 'restarting':
        if (!restartPassed) { restartPassed = true; p.restartFailed(message) } else p.record({ phase: 'error', message })
        return
      case 'ready': case 'waiting': p.record({ phase: 'error', message }); return
      case 'idle': case 'blocked': p.record({ phase: 'late', why: 'error', message }); return
    }
  }

  const model: UpdateModel = {
    state,
    act(t) {
      if (!holds(state(), t)) { p.changed(state()); return false }
      switch (t.act) {
        case 'check': return start(true)
        case 'restart': case 'try-again': p.request('update', { version: t.version }); return true
        case 'download': p.openDownload(); return true
        case 'dismiss': set(phase, null); return true
        case 'explain': p.explain(t.why); return true
      }
    },
    wake() {
      if (!auto()) return false
      if (lastStart !== null && c.now() - lastStart < T.updateWakeQuietMs) return false
      return start(false)
    },
    hold(tab, commit) {
      if (!held(phase)) return false
      set({ kind: 'waiting', version: phase.version, notes: phase.notes, tab, commit })
      return true
    },
    unhold(tab) {
      if (phase.kind !== 'waiting' || (tab !== undefined && tab !== phase.tab)) return false
      set({ kind: 'ready', version: phase.version, notes: phase.notes })
      return true
    },
    restarting(version) {
      if (!held(phase) || phase.version !== version) return false
      set({ kind: 'restarting', version })
      return true
    },
    failed(f) { set(phase, { ...f }) },
    installed() { if (failure) set(phase, null) },
    stop() { quiet() },
  }

  // the gates: blocked before any adapter call
  const why = !p.feed ? 'feed' : !g.inApplications ? 'location' : !g.writable ? 'write' : null
  if (why) { block(why); return model }

  // setup: the listeners first, then the feed once
  const a = p.adapter
  a.on('checking-for-update', () => onEvent('checking-for-update'))
  a.on('update-available', () => onEvent('update-available'))
  a.on('update-not-available', () => onEvent('update-not-available'))
  a.on('update-downloaded', (_e, notes, name) => onDownloaded(notes, name))
  a.on('error', (err) => onError(err))
  a.on('before-quit-for-update', () => { if (!quitPassed) { quitPassed = true; p.beforeQuitForUpdate() } })
  try {
    a.setFeedURL({ url: p.feed, serverType: 'json' })
  } catch (e) {
    block('setup', messageOf(e))
  }
  // an `error` emitted inside the call, or before this macrotask, is setup's
  c.setImmediate(() => {
    if (phase.kind !== 'setup') return
    set({ kind: 'idle' })
    arm(T.updateFirstMs)
  })
  return model
}
