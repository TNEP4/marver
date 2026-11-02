/**
 * The one shutdown coordinator (spec 28 A5.1 #15-#18, #20; spike S4's order on Electron 45), on fake ports and the
 * window stream's fake tabs: a quit and an update through one `request`; overlapping requests ignored; `done`,
 * `refused`, `stuck` and a throw each leaving the flags as #15 says; `quitting` before `app.quit()` and before
 * `quitAndInstall()`; tabs.json written before the guard and after `done`; `flushAll` once; #18's intent before
 * `quitAndInstall()` and at a quit with an update ready, never at a quit without one; Force Quit Tab after `stuck`
 * asking the same kind again; `before-quit-for-update` delivered twice (testing/updater.ts's fake, as Electron 45 does),
 * recorded once and acted on once; #17's error and wait paths each showing the alert once and quitting once; the
 * `window-all-closed` listener installed. The model is update-model.ts's, on the fake adapter and clock.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  beforeQuitForUpdate, isQuitting, QUIT_INSTALLS, request, resetShutdown, restartAlert, restartFailed, setUpdateSide, shutdownState, startShutdown,
  updateSide, type RestartAlert, type UpdateIntent,
} from '../../src/main/shutdown.ts'
import { FakeClock, FakeUpdater } from '../../src/main/testing/updater.ts'
import { T } from '../../src/main/timings.ts'
import { startUpdates, type UpdateBody, type UpdateModel } from '../../src/main/update-model.ts'
import type { GuardAllAction, GuardAllAnswer, Sheet, Tab } from '../../src/main/tabs.ts'
import { deferred, flush, liveTab, world, type World } from './window-fakes.ts'

interface Rig {
  w: World
  /** every port call, in order; quit and quitAndInstall say whether `quitting` was set */
  calls: string[]
  clock: FakeClock
  guardWith: (a: GuardAllAction) => Promise<GuardAllAnswer> | GuardAllAnswer
  askWith: (s: Sheet) => Promise<boolean> | boolean
  tabsOk: boolean
  stuck: Tab[]
  sheets: Sheet[]
  alerts: RestartAlert[]
  records: UpdateBody[]
  logs: { topic: string; data: Record<string, unknown> }[]
  intents: UpdateIntent[]
  prevented: number
  beforeQuit: () => void
  allClosed?: () => void
}

function rig(): Rig {
  resetShutdown()
  const clock = new FakeClock()
  const r: Rig = {
    w: world(), calls: [], clock, guardWith: () => 'done', askWith: () => false, tabsOk: true, stuck: [], sheets: [], alerts: [], records: [], logs: [], intents: [],
    prevented: 0, beforeQuit: () => {},
  }
  let bq: ((e: { preventDefault(): void }) => void) | undefined
  startShutdown({
    now: () => r.w.clock.now,
    writeTabsNow: () => { r.calls.push('writeTabsNow'); return r.tabsOk },
    guardAll: (a) => { r.calls.push(`guardAll:${a.kind}`); return Promise.resolve(r.guardWith(a)) },
    stuck: () => r.stuck,
    ask: async (s) => { r.sheets.push(s); return r.askWith(s) },
    forceUnload: (t) => { r.calls.push(`force:${t.id}`); return true },
    forward: () => { r.calls.push('forward') },
    notes: () => { r.calls.push('notes') },
    flushAll: () => { r.calls.push('flushAll') },
    quit: () => { r.calls.push(`quit:${isQuitting()}`) },
    onBeforeQuit: (fn) => { bq = fn },
    onWindowAllClosed: (fn) => { r.allClosed = fn },
    alert: async (a) => { r.calls.push('alert'); r.alerts.push(a) },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h),
    log: (topic, data) => { r.logs.push({ topic, data: data as Record<string, unknown> }) },
    record: (b) => { r.records.push(b) },
  })
  r.beforeQuit = () => bq!({ preventDefault: () => { r.prevented += 1 } })
  return r
}

/** An updater on the fakes, wired as updater.ts wires it: `ready` with 0.99.2, its side set. */
function withUpdate(r: Rig): { u: FakeUpdater; m: UpdateModel; uc: FakeClock } {
  const u = new FakeUpdater()
  const uc = new FakeClock()
  const m = startUpdates({
    adapter: u, clock: uc, feed: 'https://example.invalid/releases.json', version: '0.99.1',
    record: (b) => { r.records.push(b) }, changed: () => {}, answer: () => {}, online: () => true,
    request: (kind, t) => { request(kind, t) }, openDownload: () => {}, explain: () => {},
    restartFailed: (message) => restartFailed(message), beforeQuitForUpdate: () => beforeQuitForUpdate(),
  }, { inApplications: true, writable: true })
  uc.tick()
  uc.advance(T.updateFirstMs)
  u.emit('update-available')
  u.downloaded('0.99.2', 'Boards open faster')
  expect(m.state().phase.kind).toBe('ready')
  setUpdateSide(updateSide(m, {
    version: '0.99.1',
    writeIntent: (i) => { r.calls.push(`intent:${i.via}`); r.intents.push(i); return true },
    quitAndInstall: () => { r.calls.push(`quitAndInstall:${isQuitting()}`); u.quitAndInstall() },
  }))
  return { u, m, uc }
}

const restart = { act: 'restart', version: '0.99.2' } as const
const quitLines = (r: Rig) => r.logs.filter((l) => l.topic === 'quit').map((l) => l.data)

beforeEach(() => { resetShutdown() })

describe('one entry, one shutdown in flight (#15)', () => {
  it('a quit: tabs.json, the guard, tabs.json again, the notes, quitting, flushAll once, then app.quit() - and its journal as before', async () => {
    const r = rig()
    expect(request('quit')).toBe(true)
    expect(r.calls).toEqual(['writeTabsNow', 'guardAll:quit'])
    await flush()
    expect(r.calls).toEqual(['writeTabsNow', 'guardAll:quit', 'writeTabsNow', 'notes', 'flushAll', 'quit:true'])
    expect(isQuitting()).toBe(true)
    // the quit's journal is the one views.ts wrote: prod's unload and errors cases read it line for line
    expect(quitLines(r)).toEqual([{ asked: true }, { answer: 'done' }])
    expect(r.intents).toEqual([])
  })

  it('an update: the same steps through the same entry, the intent, then quitAndInstall() with quitting set', async () => {
    const r = rig()
    const { m } = withUpdate(r)
    expect(m.act(restart)).toBe(true)
    await flush()
    expect(r.calls).toEqual(['writeTabsNow', 'guardAll:update', 'writeTabsNow', 'notes', 'intent:restart', 'flushAll', 'quitAndInstall:true'])
    expect(r.intents).toEqual([{ from: '0.99.1', to: '0.99.2', via: 'restart', at: r.w.clock.now }])
    expect(m.state().phase).toEqual({ kind: 'restarting', version: '0.99.2' })
    expect(quitLines(r)).toEqual([{ asked: true, update: '0.99.2' }, { answer: 'done', update: '0.99.2' }])
  })

  it('before-quit while not quitting is prevented and asks for a quit; once quitting, Electron\'s own quit passes', async () => {
    const r = rig()
    r.beforeQuit()
    expect(r.prevented).toBe(1)
    expect(r.calls).toEqual(['writeTabsNow', 'guardAll:quit'])
    await flush()
    expect(r.calls.at(-1)).toBe('quit:true')
    r.beforeQuit()
    expect(r.prevented).toBe(1)
    expect(r.calls.filter((c) => c.startsWith('guardAll'))).toHaveLength(1)
  })

  it('a request while one runs is noted and ignored: a quit during an update\'s sweep, an update during a quit, ⌘Q twice', async () => {
    const r = rig()
    const { m } = withUpdate(r)
    const sweep = deferred<GuardAllAnswer>()
    r.guardWith = () => sweep.promise
    expect(m.act(restart)).toBe(true)
    expect(request('quit')).toBe(false)
    r.beforeQuit()
    expect(r.prevented).toBe(1)                          // prevented, and still one shutdown
    expect(request('update', { version: '0.99.2' })).toBe(false)
    expect(r.calls.filter((c) => c.startsWith('guardAll'))).toEqual(['guardAll:update'])
    expect(r.logs.filter((l) => l.topic === 'shutdown' && l.data.ignored)).toHaveLength(3)
    sweep.resolve('refused')
    await flush()
    // over: the next is heard
    r.guardWith = () => 'refused'
    expect(request('quit')).toBe(true)
  })

  it('an update needs the version ready now; a quit needs nothing', () => {
    const r = rig()
    expect(request('update', { version: '0.99.2' })).toBe(false)   // no updater
    withUpdate(r)
    expect(request('update', { version: '0.99.3' })).toBe(false)
    expect(r.calls).toEqual([])
  })
})

describe('the answers leave the flags as #15 says', () => {
  it('done: quitting set, nothing in flight; tabs.json written before the guard and after done', async () => {
    const r = rig()
    request('quit')
    await flush()
    expect(shutdownState()).toMatchObject({ quitting: true, inFlight: null })
    expect(r.calls.indexOf('writeTabsNow')).toBeLessThan(r.calls.indexOf('guardAll:quit'))
    expect(r.calls.lastIndexOf('writeTabsNow')).toBeGreaterThan(r.calls.indexOf('guardAll:quit'))
    expect(r.calls.filter((c) => c === 'flushAll')).toHaveLength(1)
  })

  it('refused: nothing in flight, not quitting, the window forward; never retried', async () => {
    const r = rig()
    r.guardWith = () => 'refused'
    request('quit')
    await flush()
    expect(shutdownState()).toMatchObject({ quitting: false, inFlight: null })
    expect(r.calls).toEqual(['writeTabsNow', 'guardAll:quit', 'forward'])
    expect(quitLines(r)).toEqual([{ asked: true }, { answer: 'refused' }])
  })

  it('a throw in the guard counts as refused: the flags cleared, and the next quit is heard', async () => {
    const r = rig()
    r.guardWith = () => { throw new Error('the sheet threw') }
    request('quit')
    await flush()
    expect(shutdownState()).toMatchObject({ quitting: false, inFlight: null })
    expect(quitLines(r)).toEqual([{ asked: true }, { error: 'the sheet threw' }, { answer: 'refused' }])
    r.guardWith = () => 'done'
    expect(request('quit')).toBe(true)
    await flush()
    expect(isQuitting()).toBe(true)
  })

  it('a writeTabsNow that fails or throws is noted, and the shutdown goes on (#20)', async () => {
    const r = rig()
    r.tabsOk = false
    request('quit')
    await flush()
    expect(r.calls.at(-1)).toBe('quit:true')
    expect(r.logs.filter((l) => l.topic === 'shutdown' && l.data.tabsJson === false)).toHaveLength(2)
  })

  it('stuck: the flags cleared and the sheet; Keep Waiting changes nothing, Force Quit Tab asks for the same kind again', async () => {
    for (const kind of ['quit', 'update'] as const) {
      const r = rig()
      const { m } = kind === 'update' ? withUpdate(r) : { m: null }
      const t = liveTab(r.w)
      r.stuck = [t]
      r.guardWith = () => 'stuck'
      r.askWith = () => false
      if (m) m.act(restart)
      else request('quit')
      await flush()
      expect(shutdownState()).toMatchObject({ quitting: false, inFlight: null })
      expect(r.sheets).toHaveLength(1)
      expect(r.sheets[0]).toMatchObject({ action: { kind }, tabs: [{ id: t.id, why: { kind: 'stuck' } }] })
      expect(quitLines(r)).toContainEqual({ stuck: 'keep-waiting', tabs: [t.id] })
      expect(r.calls.filter((c) => c.startsWith('guardAll'))).toHaveLength(1)
      // stuck again; this time Force Quit Tab: the tab forced, then the same kind asked again - through the guard
      // (which refuses it this time, so the case ends)
      let n = 0
      r.guardWith = () => (n++ === 0 ? 'stuck' : 'refused')
      r.askWith = () => true
      if (m) m.act(restart)
      else request('quit')
      await flush()
      await flush()
      expect(r.calls).toContain(`force:${t.id}`)
      expect(r.calls.filter((c) => c.startsWith('guardAll'))).toEqual([`guardAll:${kind}`, `guardAll:${kind}`, `guardAll:${kind}`])
      expect(quitLines(r)).toContainEqual({ stuck: 'forced', tabs: [t.id] })
    }
  })

  it('stuck with the close ended meanwhile: nothing to ask, and a later quit goes through', async () => {
    const r = rig()
    r.stuck = []
    r.guardWith = () => 'stuck'
    request('quit')
    await flush()
    expect(r.sheets).toHaveLength(0)
    expect(quitLines(r)).toContainEqual({ stuck: 'ended' })
    r.guardWith = () => 'done'
    expect(request('quit')).toBe(true)
  })
})

describe('an update refused (#15, #21)', () => {
  it('by a tab\'s unsaved work: waiting on that tab and its document', async () => {
    const r = rig()
    const { m } = withUpdate(r)
    const t = liveTab(r.w)
    // as tabs.ts refuse() does for unsaved work: the hold names this request's action
    r.guardWith = () => { t.held = { at: r.w.clock.now, action: 'update' }; return 'refused' }
    m.act(restart)
    await flush()
    expect(m.state().phase).toMatchObject({ kind: 'waiting', version: '0.99.2', tab: t.id, commit: t.doc!.commits })
    expect(r.calls).toEqual(['writeTabsNow', 'guardAll:update', 'forward'])
    expect(isQuitting()).toBe(false)
  })

  it('by a Cancel on a sheet or a tab already busy (no hold of this request): ready again, from waiting too', async () => {
    const r = rig()
    const { m } = withUpdate(r)
    const t = liveTab(r.w)
    expect(m.hold(t.id, 1)).toBe(true)
    // an older hold, from an earlier request: not this one's
    t.held = { at: r.w.clock.now - 1, action: 'update' }
    r.guardWith = () => 'refused'
    m.act({ act: 'try-again', version: '0.99.2' })
    await flush()
    expect(m.state().phase).toEqual({ kind: 'ready', version: '0.99.2', notes: 'Boards open faster' })
  })

  it('a quit refused leaves the update as it was', async () => {
    const r = rig()
    const { m } = withUpdate(r)
    r.guardWith = () => 'refused'
    request('quit')
    await flush()
    expect(m.state().phase.kind).toBe('ready')
    expect(r.intents).toEqual([])
  })
})

describe('#18\'s intent', () => {
  it('written before quitAndInstall(), and at a quit with an update ready - never at a quit without one', async () => {
    const plain = rig()
    request('quit')
    await flush()
    expect(plain.intents).toEqual([])

    const q = rig()
    withUpdate(q)
    request('quit')
    await flush()
    expect(QUIT_INSTALLS).toBe(true)
    expect(q.intents).toEqual([{ from: '0.99.1', to: '0.99.2', via: 'quit', at: q.w.clock.now }])
    expect(q.calls.indexOf('intent:quit')).toBeLessThan(q.calls.indexOf('quit:true'))
    expect(q.calls.indexOf('intent:quit')).toBeGreaterThan(q.calls.lastIndexOf('notes'))

    const u = rig()
    const { m } = withUpdate(u)
    m.act(restart)
    await flush()
    expect(u.calls.indexOf('intent:restart')).toBeLessThan(u.calls.indexOf('quitAndInstall:true'))
  })

  it('a failed write is noted and the restart still happens (it is the person\'s choice)', async () => {
    const r = rig()
    const { m, u } = withUpdate(r)
    setUpdateSide(updateSide(m, { version: '0.99.1', writeIntent: () => false, quitAndInstall: () => { r.calls.push('quitAndInstall'); u.quitAndInstall() } }))
    m.act(restart)
    await flush()
    expect(r.calls.at(-1)).toBe('quitAndInstall')
    expect(r.logs.some((l) => l.topic === 'shutdown' && l.data.intent === false)).toBe(true)
  })
})

describe('the restart (#16, #17; S4)', () => {
  it('before-quit-for-update, emitted twice with a window open, is recorded once and acted on once', async () => {
    const r = rig()
    const { m, u } = withUpdate(r)
    m.act(restart)
    await flush()
    expect(u.count('quitAndInstall')).toBe(1)
    expect(r.records.filter((b) => b.phase === 'restart')).toEqual([{ phase: 'restart', version: '0.99.2' }])
    // a third, as Electron's last-window observer could send: still nothing
    u.emit('before-quit-for-update')
    beforeQuitForUpdate()
    expect(r.records.filter((b) => b.phase === 'restart')).toHaveLength(1)
    expect(r.calls.filter((c) => c.startsWith('quit'))).toEqual(['quitAndInstall:true'])
  })

  it('the window-all-closed listener is installed, and quits nothing', async () => {
    const r = rig()
    expect(r.allClosed).toBeTypeOf('function')
    r.allClosed!()
    expect(r.calls).toEqual([])
  })

  it('an error after the windows closed: restart-failed recorded, the alert once, the quit once, the intent kept', async () => {
    const r = rig()
    const { m, u } = withUpdate(r)
    m.act(restart)
    await flush()
    r.allClosed!()
    u.fail('Could not write update request')
    await flush()
    u.fail('again')
    restartFailed('and again')
    r.clock.advance(T.restartWaitMs * 2)
    await flush()
    expect(r.alerts).toEqual([restartAlert('0.99.2')])
    expect(r.alerts[0]).toEqual({
      message: "Marver couldn't restart to install 0.99.2",
      detail: 'Your canvases were closed safely. Open Marver again: it may already be 0.99.2, and if not, it tells you how to get it.',
      buttons: ['Quit'],
    })
    expect(r.calls.filter((c) => c === 'alert' || c.startsWith('quit:'))).toEqual(['alert', 'quit:true'])
    expect(r.records.filter((b) => b.phase === 'restart-failed')).toEqual([{ phase: 'restart-failed', version: '0.99.2', message: 'Could not write update request' }])
    expect(r.intents).toHaveLength(1)
    expect(m.state().phase.kind).toBe('restarting')   // nothing starts another attempt
  })

  it('no exit restartWaitMs after the windows closed: the same, once; counted from the close, not the call', async () => {
    const r = rig()
    const { m, u } = withUpdate(r)
    m.act(restart)
    await flush()
    r.clock.advance(10_000)
    r.allClosed!()                                       // the windows closed 10 s after the call
    r.clock.advance(T.restartWaitMs - 1)
    await flush()
    expect(r.alerts).toEqual([])
    r.clock.advance(1)
    await flush()
    expect(r.alerts).toHaveLength(1)
    u.fail('late')
    await flush()
    expect(r.calls.filter((c) => c === 'alert' || c.startsWith('quit:'))).toEqual(['alert', 'quit:true'])
    expect(r.records.filter((b) => b.phase === 'restart-failed')).toHaveLength(1)
  })

  it('windows that never close: the wait counts from the call', async () => {
    const r = rig()
    const { m } = withUpdate(r)
    m.act(restart)
    await flush()
    r.clock.advance(T.restartWaitMs)
    await flush()
    expect(r.alerts).toHaveLength(1)
    expect(r.calls.at(-1)).toBe('quit:true')
  })

  it('a quitAndInstall() that throws is a preparation failure too', async () => {
    const r = rig()
    const { m } = withUpdate(r)
    setUpdateSide(updateSide(m, { version: '0.99.1', writeIntent: () => true, quitAndInstall: () => { throw new Error('No update available') } }))
    m.act(restart)
    await flush()
    await flush()
    expect(r.records.find((b) => b.phase === 'restart-failed')).toMatchObject({ message: 'No update available' })
    expect(r.calls.at(-1)).toBe('quit:true')
  })
})
