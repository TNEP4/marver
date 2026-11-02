/**
 * The updater's attempt model (spec 28 A5.1 #13, #14, #21, #22; spike S6's fake half), on testing/updater.ts's fake
 * adapter and clock: the gates and setup, one attempt through a slow download with the timer, a wake and a manual
 * check overlapping it, a synchronous throw, an error, late events, the 4 h boundary and `ready` for good; errors by
 * phase; the failure apart from the phase; each action's requirement; the pill's and the menu's reading of the state.
 * Electron's own events on a real signed pair are S6's native half, not here.
 */
import type { AutoUpdater } from 'electron'
import { describe, expect, it } from 'vitest'
import { FakeClock, FakeUpdater } from '../../src/main/testing/updater.ts'
import { T } from '../../src/main/timings.ts'
import { menuItem, pillOf, startUpdates, type UpdateBody, type UpdateGates, type UpdateModel, type UpdaterAdapter } from '../../src/main/update-model.ts'

// held by the typecheck: Electron 45's own autoUpdater is an UpdaterAdapter as it is (#13)
void ((u: AutoUpdater): UpdaterAdapter => u)

const FEED = 'https://github.com/TNEP4/marver-app-test/releases/latest/download/releases.json'
const OPEN: UpdateGates = { inApplications: true, writable: true }

interface Rig {
  u: FakeUpdater
  clock: FakeClock
  m: UpdateModel
  records: UpdateBody[]
  answers: string[]
  changes: number
  requests: { kind: string; version: string }[]
  downloads: number
  explained: string[]
  restartFailed: string[]
  quits: number
  online: boolean
}

/** A launch: the model started on the fakes, running 0.99.1; setup's macrotask run unless `raw`. */
function rig(o: { feed?: string; gates?: UpdateGates; duringFeed?: (u: FakeUpdater) => void; raw?: boolean } = {}): Rig {
  const u = new FakeUpdater()
  if (o.duringFeed) u.duringFeed = o.duringFeed
  const clock = new FakeClock()
  const r = { u, clock, records: [], answers: [], changes: 0, requests: [], downloads: 0, explained: [], restartFailed: [], quits: 0, online: true } as Omit<Rig, 'm'> as Rig
  r.m = startUpdates({
    adapter: u, clock, feed: o.feed ?? FEED, version: '0.99.1',
    record: (b) => { r.records.push(b) },
    changed: () => { r.changes += 1 },
    answer: (_a, text) => { r.answers.push(text) },
    online: () => r.online,
    request: (kind, t) => { r.requests.push({ kind, version: t.version }) },
    openDownload: () => { r.downloads += 1 },
    explain: (why) => { r.explained.push(why) },
    restartFailed: (message) => { r.restartFailed.push(message) },
    beforeQuitForUpdate: () => { r.quits += 1 },
  }, o.gates ?? OPEN)
  if (!o.raw) clock.tick()
  return r
}

const kind = (r: Rig): string => r.m.state().phase.kind
const checks = (r: Rig): number => r.u.count('checkForUpdates')
/** an attempt's records, start to end, by phase */
const story = (r: Rig, id: number): string[] => r.records.filter((b) => b.attempt === id).map((b) => b.phase)
const ENDS = new Set(['current', 'downloaded', 'error'])
const ends = (r: Rig): UpdateBody[] => r.records.filter((b) => ENDS.has(b.phase) && b.attempt !== undefined)
/** the first automatic attempt, started and still in flight */
function first(r: Rig): void { r.clock.advance(T.updateFirstMs); expect(kind(r)).toBe('checking') }
/** the first attempt through to `ready` with this version */
function toReady(r: Rig, version = '0.99.2', notes = 'Boards open faster\nAnd more'): void {
  first(r)
  r.u.emit('update-available')
  r.u.downloaded(version, notes)
  expect(r.m.state().phase).toEqual({ kind: 'ready', version, notes })
}
const FAILURE = { from: '0.99.1', to: '0.99.2', at: 1_700_000_000_000 }

describe('the gates (#13)', () => {
  it('each gate gives blocked with one reason, one record and no adapter call - and nothing starts after', () => {
    const cases: [string, string, UpdateGates][] = [
      ['feed', '', OPEN],
      ['location', FEED, { inApplications: false, writable: true }],
      ['write', FEED, { inApplications: true, writable: false }],
      // one reason, in #13's order
      ['feed', '', { inApplications: false, writable: false }],
      ['location', FEED, { inApplications: false, writable: false }],
    ]
    for (const [why, feed, gates] of cases) {
      const r = rig({ feed, gates })
      expect(r.m.state()).toEqual({ phase: { kind: 'blocked', why }, failure: null })
      expect(r.records).toEqual([{ phase: 'blocked', why }])
      expect(r.u.calls).toEqual([])
      r.clock.advance(3 * T.updateEveryMs)
      expect(r.m.wake()).toBe(false)
      expect(r.m.act({ act: 'check' })).toBe(false)
      expect(r.u.calls).toEqual([])
      expect(r.records).toHaveLength(1)
      expect(r.clock.pending()).toBe(0)
    }
  })
})

describe('setup, a phase of its own (#13, r1 #5)', () => {
  it('the six listeners exist before setFeedURL, which is called once with the feed as JSON; setup ends one macrotask later', () => {
    const r = rig({ raw: true })
    expect(r.u.calls.slice(0, 6).sort()).toEqual([
      'on:before-quit-for-update', 'on:checking-for-update', 'on:error', 'on:update-available', 'on:update-downloaded', 'on:update-not-available',
    ])
    expect(r.u.calls.slice(6)).toEqual(['setFeedURL'])
    expect(r.u.feeds).toEqual([{ url: FEED, serverType: 'json' }])
    expect(kind(r)).toBe('setup')
    expect(menuItem(r.m.state())).toEqual({ label: 'Check for Updates…', enabled: false, token: null })
    expect(r.m.wake()).toBe(false)   // only idle starts one
    expect(r.m.act({ act: 'check' })).toBe(false)
    r.clock.tick()
    expect(kind(r)).toBe('idle')
    expect(r.records).toEqual([])
    expect(checks(r)).toBe(0)
  })

  const blockedForGood = (r: Rig, message: string): void => {
    expect(r.m.state().phase).toEqual({ kind: 'blocked', why: 'setup' })
    expect(r.records).toEqual([{ phase: 'blocked', why: 'setup', message }])
    r.clock.advance(3 * T.updateEveryMs)
    expect(r.m.wake()).toBe(false)
    expect(r.m.act({ act: 'check' })).toBe(false)
    expect(checks(r)).toBe(0)
    expect(r.clock.pending()).toBe(0)
    expect(menuItem(r.m.state())).toEqual({ label: 'Updates Unavailable…', enabled: true, token: { act: 'explain', why: 'setup' } })
  }

  it('a setFeedURL throw (Electron checking its arguments) is blocked(setup), and no check is ever made after', () => {
    blockedForGood(rig({ duringFeed: () => { throw new Error('bad options') } }), 'bad options')
  })

  it('an error event inside setFeedURL (Electron 45 catching Squirrel\'s exception) is blocked(setup) the same', () => {
    const m = 'Could not get code signature for running application'
    blockedForGood(rig({ duringFeed: (u) => u.fail(m) }), m)
  })

  it('an error after the call returns but before the macrotask is still setup\'s; once setup has ended it is late', () => {
    const r = rig({ raw: true })
    r.u.fail('just after the call')
    r.clock.tick()
    blockedForGood(r, 'just after the call')

    const s = rig()
    s.u.fail('after setup')
    expect(kind(s)).toBe('idle')
    expect(s.records).toEqual([{ phase: 'late', why: 'error', message: 'after setup' }])
    first(s)   // and the first check still comes
  })

  it('an error event and then a throw inside the call block once, with one record', () => {
    blockedForGood(rig({ duringFeed: (u) => { u.fail('event first'); throw new Error('then a throw') } }), 'event first')
  })
})

describe('one attempt at a time (#14; S6)', () => {
  it('the first attempt starts updateFirstMs after setup ends, and not before', () => {
    const r = rig()
    r.clock.advance(T.updateFirstMs - 1)
    expect(checks(r)).toBe(0)
    r.clock.advance(1)
    expect(checks(r)).toBe(1)
    expect(r.records).toEqual([{ phase: 'check', attempt: 1 }])
    expect(menuItem(r.m.state())).toEqual({ label: 'Checking for Updates…', enabled: false, token: null })
  })

  it('a slow download: the timer, a wake and a manual check overlapping it start nothing; one slow record; then ready', () => {
    const r = rig()
    r.clock.advance(10_000)
    expect(r.m.act({ act: 'check' })).toBe(true)   // a manual one, before the first timer
    const startedAt = r.clock.now()
    r.u.emit('checking-for-update')
    expect(kind(r)).toBe('checking')
    r.u.emit('update-available')                   // the middle of the attempt, never its end
    expect(kind(r)).toBe('downloading')
    expect(menuItem(r.m.state())).toEqual({ label: 'Downloading Update…', enabled: false, token: null })

    r.clock.advance(T.updateFirstMs)               // past where the first timer stood
    expect(r.m.wake()).toBe(false)
    expect(r.m.act({ act: 'check' })).toBe(false)
    expect(checks(r)).toBe(1)

    r.clock.advance(startedAt + T.updateSlowMs - 1 - r.clock.now())
    expect(story(r, 1)).toEqual(['check', 'downloading'])
    r.clock.advance(1)
    expect(story(r, 1)).toEqual(['check', 'downloading', 'slow'])
    expect(kind(r)).toBe('downloading')            // no watchdog: still in flight

    r.clock.advance(T.updateWakeQuietMs)           // a wake past the quiet time: still not idle
    expect(r.m.wake()).toBe(false)
    r.clock.advance(T.updateEveryMs)
    expect(checks(r)).toBe(1)
    expect(story(r, 1)).toEqual(['check', 'downloading', 'slow'])   // one slow, ever

    r.u.downloaded('0.99.2', 'Boards open faster')
    expect(r.m.state().phase).toEqual({ kind: 'ready', version: '0.99.2', notes: 'Boards open faster' })
    expect(r.records).toEqual([
      { phase: 'check', attempt: 1, manual: true }, { phase: 'downloading', attempt: 1 }, { phase: 'slow', attempt: 1 },
      { phase: 'downloaded', attempt: 1, version: '0.99.2' },
    ])
    expect(r.answers).toEqual([])                  // a check that finds one says nothing
  })

  it('a synchronous throw from checkForUpdates() ends its attempt once, and the next comes updateEveryMs after', () => {
    const r = rig()
    r.u.duringCheck = () => { throw new Error('no native updater') }
    r.clock.advance(T.updateFirstMs)
    expect(checks(r)).toBe(1)
    expect(kind(r)).toBe('idle')
    expect(r.records).toEqual([{ phase: 'check', attempt: 1 }, { phase: 'error', attempt: 1, message: 'no native updater' }])
    r.clock.advance(T.updateEveryMs - 1)
    expect(checks(r)).toBe(1)
    r.clock.advance(1)
    expect(checks(r)).toBe(2)
    // nothing of the ended attempt in between: no `slow` for it, 25 min on
    expect(r.records).toEqual([
      { phase: 'check', attempt: 1 }, { phase: 'error', attempt: 1, message: 'no native updater' },
      { phase: 'check', attempt: 2 }, { phase: 'error', attempt: 2, message: 'no native updater' },
    ])
  })

  it('an event inside checkForUpdates() is its own attempt\'s: an error and then a throw end it once', () => {
    const r = rig()
    r.u.duringCheck = (u) => { u.fail('feed 404'); throw new Error('and a throw') }
    r.clock.advance(T.updateFirstMs)
    expect(kind(r)).toBe('idle')
    expect(ends(r)).toEqual([{ phase: 'error', attempt: 1, message: 'feed 404' }])
    expect(r.records.at(-1)).toEqual({ phase: 'late', why: 'throw', attempt: 1, message: 'and a throw' })

    const s = rig()
    s.u.duringCheck = (u) => u.emit('update-not-available')
    s.clock.advance(T.updateFirstMs)
    expect(kind(s)).toBe('idle')
    expect(s.records).toEqual([{ phase: 'check', attempt: 1 }, { phase: 'current', attempt: 1 }])
  })

  it('an error during the download ends that attempt once; a second error is late', () => {
    const r = rig()
    first(r)
    r.u.emit('update-available')
    r.clock.advance(3 * 60_000)
    r.u.fail('The network connection was lost.')
    expect(kind(r)).toBe('idle')
    r.u.fail('again')
    expect(kind(r)).toBe('idle')
    expect(ends(r)).toEqual([{ phase: 'error', attempt: 1, message: 'The network connection was lost.' }])
    expect(r.records.at(-1)).toEqual({ phase: 'late', why: 'error', message: 'again' })
    expect(story(r, 1)).toEqual(['check', 'downloading', 'error'])
  })

  it('a late event changes nothing: not the phase, the next attempt\'s time or the pill', () => {
    const r = rig()
    expect(r.m.act({ act: 'check' })).toBe(true)
    r.u.emit('update-not-available')
    const endedAt = r.clock.now()
    expect(r.answers).toEqual(['Marver 0.99.1 is up to date'])
    const changes = r.changes
    r.clock.advance(60_000)
    r.u.emit('update-not-available')
    r.u.emit('checking-for-update')
    r.u.emit('update-available')
    expect(kind(r)).toBe('idle')
    expect(r.records.slice(-3)).toEqual([
      { phase: 'late', why: 'update-not-available' }, { phase: 'late', why: 'checking-for-update' }, { phase: 'late', why: 'update-available' },
    ])
    expect(r.answers).toHaveLength(1)
    expect(r.changes).toBe(changes)
    r.clock.advance(endedAt + T.updateEveryMs - 1 - r.clock.now())
    expect(checks(r)).toBe(1)
    r.clock.advance(1)
    expect(checks(r)).toBe(2)
  })

  it('a late update-downloaded still means ready: Squirrel holds the bundle', () => {
    const r = rig()
    r.u.downloaded('0.99.2', 'notes')
    expect(r.m.state().phase).toEqual({ kind: 'ready', version: '0.99.2', notes: 'notes' })
    expect(r.records).toEqual([{ phase: 'late', why: 'update-downloaded', version: '0.99.2' }])
    expect(r.clock.pending()).toBe(0)              // the first attempt's timer gone with it
    r.clock.advance(3 * T.updateEveryMs)
    expect(checks(r)).toBe(0)
  })

  it('the 4 h boundary counts from the last attempt\'s end, not its start', () => {
    const r = rig()
    first(r)
    r.u.emit('update-available')
    r.clock.advance(20 * 60_000)                   // Squirrel's own download timeout ends it
    r.u.fail('timed out')
    r.clock.advance(T.updateEveryMs - 1)
    expect(checks(r)).toBe(1)
    r.clock.advance(1)
    expect(checks(r)).toBe(2)
    expect(r.records.at(-1)).toEqual({ phase: 'check', attempt: 2 })
  })

  it('a wake starts one only from idle, and only when none started in the last updateWakeQuietMs', () => {
    const r = rig()
    expect(r.m.wake()).toBe(true)                  // idle, none started yet
    const startedAt = r.clock.now()
    r.u.emit('update-not-available')
    r.clock.advance(startedAt + T.updateWakeQuietMs - 1 - r.clock.now())
    expect(r.m.wake()).toBe(false)
    expect(checks(r)).toBe(1)
    r.clock.advance(1)
    expect(r.m.wake()).toBe(true)
    expect(checks(r)).toBe(2)
    expect(r.records.at(-1)).toEqual({ phase: 'check', attempt: 2 })
    expect(r.answers).toEqual([])
  })

  it('ready for good: no attempt and no setFeedURL again, after 4 h, a wake, Check for Updates… or late events', () => {
    const r = rig()
    toReady(r)
    expect(r.clock.pending()).toBe(0)
    r.clock.advance(3 * T.updateEveryMs)
    expect(r.m.wake()).toBe(false)
    expect(r.m.act({ act: 'check' })).toBe(false)
    r.u.emit('update-not-available')
    r.u.fail('Squirrel complains')
    r.u.downloaded('0.99.3')                       // the first bundle stays the one installed
    expect(r.m.state().phase).toEqual({ kind: 'ready', version: '0.99.2', notes: 'Boards open faster\nAnd more' })
    expect(checks(r)).toBe(1)
    expect(r.u.count('setFeedURL')).toBe(1)
    expect(r.records.slice(-3)).toEqual([
      { phase: 'late', why: 'update-not-available' }, { phase: 'error', message: 'Squirrel complains' },
      { phase: 'late', why: 'update-downloaded', version: '0.99.3' },
    ])
  })
})

describe('an error is dispatched by phase (#14, r1 #5)', () => {
  it('checking ends the attempt; ready and waiting record it unchanged; restarting is #17\'s, once; idle and blocked are late', () => {
    const r = rig()
    first(r)
    r.u.fail('no answer')                          // checking, after the call
    expect(ends(r)).toEqual([{ phase: 'error', attempt: 1, message: 'no answer' }])

    const s = rig()
    toReady(s)
    s.u.fail('in ready')
    expect(kind(s)).toBe('ready')
    expect(s.m.hold('tab-a', 4)).toBe(true)
    s.u.fail('in waiting')
    expect(s.m.state().phase).toEqual({ kind: 'waiting', version: '0.99.2', notes: 'Boards open faster\nAnd more', tab: 'tab-a', commit: 4 })
    expect(s.records.slice(-2)).toEqual([{ phase: 'error', message: 'in ready' }, { phase: 'error', message: 'in waiting' }])
    expect(s.m.restarting('0.99.2')).toBe(true)
    s.u.fail('relaunch request failed')
    s.u.fail('a second one')
    expect(s.restartFailed).toEqual(['relaunch request failed'])
    expect(s.m.state().phase).toEqual({ kind: 'restarting', version: '0.99.2' })
    expect(s.records.at(-1)).toEqual({ phase: 'error', message: 'a second one' })

    const b = rig({ gates: { inApplications: false, writable: true } })
    b.u.fail('never heard: no listener')           // gates block before any listener
    expect(b.records).toEqual([{ phase: 'blocked', why: 'location' }])
    const sb = rig({ duringFeed: () => { throw new Error('x') } })
    sb.u.fail('after the block')
    expect(sb.records.at(-1)).toEqual({ phase: 'late', why: 'error', message: 'after the block' })
    expect(sb.m.state().phase).toEqual({ kind: 'blocked', why: 'setup' })
  })

  it('before-quit-for-update, emitted twice with a window open (#16), is passed on once', () => {
    const r = rig()
    toReady(r)
    r.m.restarting('0.99.2')
    r.u.quitAndInstall()
    expect(r.quits).toBe(1)
  })
})

describe('a manual check answers in the pill; automatic checks never speak (#14)', () => {
  it('up to date, offline, and try again later - a synchronous throw included', () => {
    const r = rig()
    r.m.act({ act: 'check' })
    r.u.emit('update-not-available')
    r.clock.advance(1)
    r.online = false
    r.m.act({ act: 'check' })
    r.u.fail('The Internet connection appears to be offline.')
    r.online = true
    r.m.act({ act: 'check' })
    r.u.fail('feed did not parse')
    r.u.duringCheck = () => { throw new Error('thrown') }
    r.m.act({ act: 'check' })
    expect(r.answers).toEqual([
      'Marver 0.99.1 is up to date', 'Couldn\'t check for updates · You\'re offline',
      'Couldn\'t check for updates · Try again later', 'Couldn\'t check for updates · Try again later',
    ])
    expect(r.records.filter((b) => b.phase === 'check')).toEqual([1, 2, 3, 4].map((attempt) => ({ phase: 'check', attempt, manual: true })))
  })

  it('automatic ones end the same three ways and say nothing', () => {
    const r = rig()
    first(r)
    r.u.emit('update-not-available')
    r.online = false
    r.clock.advance(T.updateEveryMs)
    r.u.fail('offline')
    r.u.duringCheck = () => { throw new Error('thrown') }
    r.clock.advance(T.updateEveryMs)
    expect(ends(r).map((b) => b.phase)).toEqual(['current', 'error', 'error'])
    expect(r.answers).toEqual([])
  })
})

describe('the failure, apart from the phase (#14, #18, #21, r1 #8)', () => {
  it('a check runs while it is shown, and one that finds nothing keeps it', () => {
    const r = rig()
    r.m.failed(FAILURE)
    expect(r.m.state()).toEqual({ phase: { kind: 'idle' }, failure: FAILURE })
    expect(menuItem(r.m.state())).toEqual({ label: 'Check for Updates…', enabled: true, token: { act: 'check' } })
    first(r)
    expect(pillOf(r.m.state(), () => '')?.show).toBe('failed')   // whatever the phase
    r.u.emit('update-not-available')
    expect(r.m.state().failure).toEqual(FAILURE)
  })

  it('Download right after the reconciliation acts; after Dismiss it does nothing, and the pill is chosen again', () => {
    const r = rig()
    r.m.failed(FAILURE)
    expect(r.m.act({ act: 'download', version: '0.99.2' })).toBe(true)
    expect(r.downloads).toBe(1)
    expect(r.m.state().failure).toEqual(FAILURE)   // Download keeps it; Dismiss clears it
    expect(r.m.act({ act: 'dismiss', version: '0.99.2' })).toBe(true)
    expect(r.m.state().failure).toBe(null)
    const changes = r.changes
    expect(r.m.act({ act: 'download', version: '0.99.2' })).toBe(false)
    expect(r.m.act({ act: 'dismiss', version: '0.99.2' })).toBe(false)
    expect(r.downloads).toBe(1)
    expect(r.changes).toBe(changes + 2)
    expect(pillOf(r.m.state(), () => '')).toBe(null)
  })

  it('a later update-downloaded clears it: Download does nothing, Restart to Update acts', () => {
    const r = rig()
    r.m.failed(FAILURE)
    toReady(r, '0.99.3')
    expect(r.m.state().failure).toBe(null)
    expect(r.m.act({ act: 'download', version: '0.99.2' })).toBe(false)
    expect(r.downloads).toBe(0)
    expect(r.m.act({ act: 'restart', version: '0.99.3' })).toBe(true)
    expect(r.requests).toEqual([{ kind: 'update', version: '0.99.3' }])
  })

  it('a later installed clears it; a stale failure\'s Download does nothing', () => {
    const r = rig()
    r.m.failed(FAILURE)
    expect(r.m.act({ act: 'download', version: '0.99.9' })).toBe(false)
    r.m.installed()
    expect(r.m.state().failure).toBe(null)
    expect(r.m.act({ act: 'download', version: '0.99.2' })).toBe(false)
    expect(r.downloads).toBe(0)
  })
})

describe('each action requires its own state (#21, #22, r1 #8)', () => {
  it('Restart to Update needs ready or waiting with its version; Try Again, waiting with it; restarting, neither', () => {
    const r = rig()
    toReady(r)
    expect(r.m.act({ act: 'restart', version: '0.99.1' })).toBe(false)
    expect(r.m.act({ act: 'try-again', version: '0.99.2' })).toBe(false)
    expect(r.m.act({ act: 'restart', version: '0.99.2' })).toBe(true)
    r.m.hold('tab-a', 7)
    expect(r.m.act({ act: 'try-again', version: '0.99.1' })).toBe(false)
    expect(r.m.act({ act: 'try-again', version: '0.99.2' })).toBe(true)
    expect(r.m.act({ act: 'restart', version: '0.99.2' })).toBe(true)
    expect(r.m.restarting('0.99.1')).toBe(false)
    expect(r.m.restarting('0.99.2')).toBe(true)
    expect(r.m.act({ act: 'restart', version: '0.99.2' })).toBe(false)
    expect(r.m.act({ act: 'try-again', version: '0.99.2' })).toBe(false)
    expect(r.requests).toEqual([0, 1, 2].map(() => ({ kind: 'update', version: '0.99.2' })))
  })

  it('Check for Updates… needs idle; a blocked item\'s alert needs that block', () => {
    const r = rig()
    first(r)
    expect(r.m.act({ act: 'check' })).toBe(false)
    expect(r.m.act({ act: 'restart', version: '0.99.2' })).toBe(false)
    const b = rig({ gates: { inApplications: false, writable: true } })
    expect(b.m.act({ act: 'explain', why: 'write' })).toBe(false)
    expect(b.m.act({ act: 'explain', why: 'location' })).toBe(true)
    expect(b.explained).toEqual(['location'])
    expect(r.m.act({ act: 'explain', why: 'location' })).toBe(false)
    expect(r.requests).toEqual([])
  })
})

describe('waiting (#15, #21)', () => {
  it('a refusal by unsaved work names the tab and its document; only that tab, or a refusal of another kind, takes it back', () => {
    const r = rig()
    expect(r.m.hold('tab-a', 3)).toBe(false)       // nothing to hold yet
    toReady(r)
    expect(r.m.hold('tab-a', 3)).toBe(true)
    expect(r.m.state().phase).toMatchObject({ kind: 'waiting', version: '0.99.2', tab: 'tab-a', commit: 3 })
    expect(r.m.unhold('tab-b')).toBe(false)        // another tab's report changes nothing
    expect(kind(r)).toBe('waiting')
    expect(r.m.unhold('tab-a')).toBe(true)
    expect(r.m.state().phase).toEqual({ kind: 'ready', version: '0.99.2', notes: 'Boards open faster\nAnd more' })
    r.m.hold('tab-b', 9)
    expect(r.m.unhold()).toBe(true)                // Cancel on a sheet, a busy tab
    expect(kind(r)).toBe('ready')
    expect(r.requests).toEqual([])                 // leaving waiting never restarts
  })
})

describe('the pill and the menu read the state (#21, #22)', () => {
  const name = (t: string): string => (t === 'tab-a' ? 'Board A' : t)

  it('the pill: ready or waiting first, else the failure whatever the phase, else none; checking has none', () => {
    const r = rig()
    expect(pillOf(r.m.state(), name)).toBe(null)
    first(r)
    expect(pillOf(r.m.state(), name)).toBe(null)
    r.u.emit('update-available')
    r.u.downloaded('0.99.2', '\n  Boards open faster  \nAnd more')
    r.m.failed(FAILURE)                            // the reconciliation's, set after: ready still shows first
    expect(pillOf(r.m.state(), name)).toEqual({
      show: 'ready', version: '0.99.2', text: '0.99.2 is ready', short: 'Restart to Update', tooltip: 'Boards open faster',
      button: { label: 'Restart to Update', token: { act: 'restart', version: '0.99.2' } },
    })
    r.m.hold('tab-a', 5)
    expect(pillOf(r.m.state(), name)).toEqual({
      show: 'waiting', version: '0.99.2', tab: 'tab-a', commit: 5, text: '0.99.2 waits for Board A', short: 'Update waits',
      button: { label: 'Try Again', token: { act: 'try-again', version: '0.99.2' } },
    })
    r.m.restarting('0.99.2')
    expect(pillOf(r.m.state(), name)).toEqual({
      show: 'failed', version: '0.99.2', text: '0.99.2 couldn\'t be installed', short: 'Update failed',
      button: { label: 'Download', token: { act: 'download', version: '0.99.2' } }, dismiss: { act: 'dismiss', version: '0.99.2' },
    })
  })

  it('the menu: each state\'s label, enablement and token; every change reaches the ports', () => {
    expect(menuItem(rig({ feed: '' }).m.state())).toBe(null)
    expect(menuItem(rig({ gates: { inApplications: false, writable: true } }).m.state()))
      .toEqual({ label: 'Updates Need the Applications Folder…', enabled: true, token: { act: 'explain', why: 'location' } })
    expect(menuItem(rig({ gates: { inApplications: true, writable: false } }).m.state()))
      .toEqual({ label: 'Updates Unavailable…', enabled: true, token: { act: 'explain', why: 'write' } })
    const r = rig()
    expect(menuItem(r.m.state())).toEqual({ label: 'Check for Updates…', enabled: true, token: { act: 'check' } })
    let c = r.changes
    toReady(r)                                     // checking, downloading, ready
    expect(r.changes).toBe(c + 3)
    expect(menuItem(r.m.state())).toEqual({ label: 'Restart to Install Update', enabled: true, token: { act: 'restart', version: '0.99.2' } })
    r.m.hold('tab-a', 1)
    expect(menuItem(r.m.state())).toEqual({ label: 'Restart to Install Update', enabled: true, token: { act: 'restart', version: '0.99.2' } })
    c = r.changes
    r.m.restarting('0.99.2')
    expect(r.changes).toBe(c + 1)
    expect(menuItem(r.m.state())).toEqual({ label: 'Restarting…', enabled: false, token: null })
  })
})
