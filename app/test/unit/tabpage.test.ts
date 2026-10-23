/**
 * The tab's own page (spec 28 A2.11, A2.14 #21, #22, v1.13 r2 #3, v1.14 r3 #3, #4): `pageFor` row by row, the
 * snapshot's key (a probe that finds the same thing bumps no rev), the crash latch with one owner (a fake clock),
 * the retry and check schedule, the hang sheet's words and Copy Details' allowlist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allTabs, onCommit, onRegistry, onFail, type Tab } from '../../src/main/tabs.ts'
import {
  copyDetails, hangSheetText, nextDelay, onLifted, onShown, pageFor, personReload, recover, scheduleRetry, snapshotKey, stopRetries,
} from '../../src/main/tabpage.ts'
import { entry, liveTab, show, world, type World } from './window-fakes.ts'

let w: World
beforeEach(() => { w = world() })
afterEach(() => { vi.useRealTimers() })

const HOME = '/Users/nic'
const add = (o: Parameters<typeof entry>[0] = {}) => { const e = entry(o); onRegistry({ kind: 'entry', entry: e }); return allTabs().find((x) => x.reg?.instance === e.instance)! }
const gone = (t: Tab) => onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })

describe('pageFor: which page, when (A2.11\'s table)', () => {
  it('starting while the registry says so; opening for a ready canvas\'s first load', () => {
    const s = add({ state: 'starting', origin: null, root: '/Users/nic/tms-broker', name: 'TMS broker' })
    expect(pageFor(s, 5, HOME)).toMatchObject({ page: 'starting', phase: 'starting', name: 'TMS broker', folder: '~/tms-broker' })
    const r = add()
    r.loadAt = 42
    expect(pageFor(r, 99, HOME)).toMatchObject({ page: 'starting', phase: 'opening', since: 42 })
  })

  it('a lifted document gets no page; a kept page of a stopped canvas gets none either (the pill speaks)', () => {
    const t = liveTab(w)
    expect(pageFor(t, 1, HOME)).toBeNull()
    gone(t)
    expect(pageFor(t, 1, HOME)).toBeNull()
  })

  it('stopped, never shown: the start command with ~, copied with the full path elsewhere; an explicit port adds --port', () => {
    const t = add({ root: '/Users/nic/tms-broker' })
    gone(t)
    expect(pageFor(t, 7, HOME)).toMatchObject({ page: 'stopped', command: 'cd ~/tms-broker && npx marver dev', retained: false, probe: { state: 'none', lastAt: null } })
    const p = add({ root: '/Users/nic/x', slot: null, port: 41234 })
    gone(p)
    expect(pageFor(p, 7, HOME)).toMatchObject({ command: 'cd ~/x && npx marver dev --port 41234' })
  })

  it('retained and the probe ride on stopped, unverified and unreachable alike (v1.14 r3 #3)', () => {
    const t = liveTab(w)
    onFail(t, { why: 'unverified', code: -20, errorPage: false })
    t.probe = { state: 'answers', lastAt: 3 }
    expect(pageFor(t, 9, HOME)).toMatchObject({ page: 'unverified', retained: true, probe: { state: 'answers', lastAt: 3 }, origin: t.reg!.origin })
    onFail(t, { why: 'unreachable', code: -102, errorPage: false })
    expect(pageFor(t, 9, HOME)).toMatchObject({ page: 'unreachable', retained: true, reason: 'nothing' })
    gone(t)
    expect(pageFor(t, 9, HOME)).toMatchObject({ page: 'stopped', retained: true })
  })

  it('unverified: the address as its name, never a logo; a workspace elsewhere is stopped', () => {
    const t = add({ port: 40808 })
    t.logo = 'data:image/svg+xml;base64,PHN2Zz4='
    onFail(t, { why: 'unverified', code: -20, errorPage: true })
    const b = pageFor(t, 1, HOME)!
    expect(b).toMatchObject({ page: 'unverified', name: 'localhost:40808' })
    expect('logo' in b).toBe(false)
    onFail(t, { why: 'elsewhere', code: -20, errorPage: true })
    expect(pageFor(t, 1, HOME)!.page).toBe('stopped')
  })

  it('a gone tab whose reload failed shows stopped, never unreachable', () => {
    const t = add()
    gone(t)
    t.fail = { why: 'unreachable', at: 1, code: -102 }
    expect(pageFor(t, 1, HOME)!.page).toBe('stopped')
  })

  it('crashed: reloading (not latched) then keeps crashing (latched), with the reason and the count', () => {
    const t = liveTab(w)
    recover(t, { kind: 'crash', reason: 'oom', exitCode: 9 })
    expect(pageFor(t, 1, HOME)).toMatchObject({ page: 'crashed', latched: false, reason: 'oom', crashes: 1 })
    t.crash.latched = true
    expect(pageFor(t, 1, HOME)).toMatchObject({ page: 'crashed', latched: true })
  })

  it('a probe that finds the same state again sends no new snapshot; a new state does', () => {
    const t = liveTab(w)
    onFail(t, { why: 'unreachable', code: -102, errorPage: false })
    t.probe = { state: 'silent', lastAt: 1 }
    const a = snapshotKey(pageFor(t, 1, HOME)!)
    t.probe = { state: 'silent', lastAt: 2 }
    expect(snapshotKey(pageFor(t, 1, HOME)!)).toBe(a)
    t.probe = { state: 'answers', lastAt: 3 }
    expect(snapshotKey(pageFor(t, 1, HOME)!)).not.toBe(a)
  })
})

describe('crashes: one owner, a latch (A2.11, the budget: a reload started within 1 s)', () => {
  it('the active tab\'s first crash starts its reload at once, in the same turn; the lift confirms it', () => {
    const t = liveTab(w)
    recover(t, { kind: 'crash', reason: 'crashed', exitCode: 1 })
    expect(w.reloads).toEqual([t.id])
    expect(t.reopen).toBe(true)
    expect(t.crash).toMatchObject({ count: 1, inFlight: 'auto', latched: false })
    onCommit(t, { gen: 2, url: `${t.reg!.origin}/`, attributed: true, admitted: 'd2' })
    onLifted(t)
    expect(w.confirmed).toEqual([t.id])
    expect(t.crash.inFlight).toBe(false)
  })

  it('a second crash within 60 s of an automatic reload latches: no further load, also after switching away and back', () => {
    const t = liveTab(w)
    recover(t, { kind: 'crash', reason: 'crashed', exitCode: 1 })
    onCommit(t, { gen: 2, url: `${t.reg!.origin}/`, attributed: true, admitted: 'd2' }); onLifted(t)
    w.clock.now += 30_000
    recover(t, { kind: 'crash', reason: 'crashed', exitCode: 1 })
    expect(t.crash.latched).toBe(true)
    expect(w.reloads).toEqual([t.id])
    show('home'); show(t.id)
    expect(w.reloads).toEqual([t.id])
    expect(w.loads).toEqual([])
  })

  it('a crash more than 60 s after the automatic reload is a new first crash', () => {
    const t = liveTab(w)
    recover(t, { kind: 'crash', reason: 'crashed', exitCode: 1 })
    onCommit(t, { gen: 2, url: `${t.reg!.origin}/`, attributed: true, admitted: 'd2' }); onLifted(t)
    w.clock.now += 61_000
    recover(t, { kind: 'crash', reason: 'crashed', exitCode: 1 })
    expect(t.crash.latched).toBe(false)
    expect(w.reloads).toEqual([t.id, t.id])
  })

  it('a hidden tab that crashed loads only when shown; crashing again there latches it', () => {
    const t = liveTab(w)
    show('home')
    recover(t, { kind: 'crash', reason: 'killed', exitCode: 9 })
    expect(w.reloads).toEqual([])
    expect(t.crash.pendingShow).toBe(true)
    show(t.id)
    onShown(t)
    expect(w.reloads).toEqual([t.id])
    w.clock.now += 1000
    recover(t, { kind: 'crash', reason: 'killed', exitCode: 9 })
    expect(t.crash.latched).toBe(true)
  })

  it('further crashes during one attempt count once', () => {
    const t = liveTab(w)
    recover(t, { kind: 'crash', reason: 'crashed', exitCode: 1 })
    recover(t, { kind: 'crash', reason: 'crashed', exitCode: 1 })   // the automatic attempt's renderer went
    recover(t, { kind: 'crash', reason: 'crashed', exitCode: 1 })   // more events of that same attempt
    recover(t, { kind: 'crash', reason: 'crashed', exitCode: 1 })
    expect(t.crash).toMatchObject({ count: 2, latched: true })
    personReload(t)
    recover(t, { kind: 'crash', reason: 'crashed', exitCode: 1 })
    recover(t, { kind: 'crash', reason: 'crashed', exitCode: 1 })
    expect(t.crash.count).toBe(3)
  })

  it('a renderer the app ended itself counts nothing; a confirmed force reload reloads through recover', () => {
    const t = liveTab(w)
    t.appEnding = true
    t.crash.inFlight = 'force'
    recover(t, { kind: 'app' })
    expect(t.crash.count).toBe(0)
    expect(t.crash.latched).toBe(false)
    expect(w.reloads).toEqual([t.id])
    expect(t.appEnding).toBe(false)
  })

  it('a latch clears when the person\'s reload has run 60 s without crashing - and not before', () => {
    vi.useFakeTimers()
    const t = liveTab(w)
    t.crash.latched = true; t.crash.count = 2; t.view = 'crashed'
    personReload(t)
    expect(t.crash.inFlight).toBe('person')
    onCommit(t, { gen: 3, url: `${t.reg!.origin}/`, attributed: true, admitted: 'd3' }); onLifted(t)
    vi.advanceTimersByTime(59_000)
    expect(t.crash.latched).toBe(true)
    vi.advanceTimersByTime(2_000)
    expect(t.crash).toMatchObject({ latched: false, count: 0 })
  })

  it('a crash before the 60 s are up keeps the latch', () => {
    vi.useFakeTimers()
    const t = liveTab(w)
    t.crash.latched = true; t.crash.count = 2
    personReload(t)
    onCommit(t, { gen: 3, url: `${t.reg!.origin}/`, attributed: true, admitted: 'd3' }); onLifted(t)
    vi.advanceTimersByTime(10_000)
    recover(t, { kind: 'crash', reason: 'crashed', exitCode: 1 })
    vi.advanceTimersByTime(60_000)
    expect(t.crash.latched).toBe(true)
  })

  it('a crashed tab whose canvas stopped has nothing to reload into', () => {
    const t = liveTab(w)
    gone(t)
    recover(t, { kind: 'crash', reason: 'crashed', exitCode: 1 })
    expect(w.reloads).toEqual([])
    expect(pageFor(t, 1, HOME)!.page).toBe('stopped')
  })
})

describe('coming back from a failure (A2.3, A2.11, v1.13 r2 #3)', () => {
  it('5 s while active; 1, 2, 4, 8 s, then every 30 s while hidden', () => {
    expect(nextDelay(0, true)).toBe(5000)
    expect([0, 1, 2, 3, 4, 9].map((n) => nextDelay(n, false))).toEqual([1000, 2000, 4000, 8000, 30_000, 30_000])
  })

  it('nothing retained: an answer loads the tab; a retained page only probes, its line changing', async () => {
    vi.useFakeTimers()
    const t = liveTab(w)
    onFail(t, { why: 'unreachable', code: -102, errorPage: true })
    w.probeWith = () => 'answers'
    scheduleRetry(t)
    await vi.advanceTimersByTimeAsync(5000)
    expect(w.loads).toEqual([t.id])
    const k = liveTab(w)
    onFail(k, { why: 'unreachable', code: -102, errorPage: false })
    w.loads.length = 0
    scheduleRetry(k)
    await vi.advanceTimersByTimeAsync(5000)
    expect(w.loads).toEqual([])
    expect(k.probe?.state).toBe('answers')
    w.probeWith = () => 'proved'
    await vi.advanceTimersByTimeAsync(5000)
    expect(k.probe?.state).toBe('proved')
    expect(w.loads).toEqual([])
    stopRetries(k)
  })
})

describe('the words', () => {
  it('the hang sheet names what the page last held and every other tab of the process; Keep Waiting first (default)', () => {
    const t = liveTab(w, { entry: { name: 'TMS broker' }, busy: { unsaved: true, why: ['capture-unsent'] } })
    expect(hangSheetText(t, ['Tidewell'])).toEqual({
      message: 'TMS broker isn\'t responding',
      detail: 'Reloading ends it now and loses what it hasn\'t saved: a capture not yet sent. This also reloads Tidewell.',
      buttons: ['Keep Waiting', 'Reload Page'],
    })
  })

  it('Copy Details holds no path, no name, no board, no error text', () => {
    const t = liveTab(w, { entry: { name: 'Secret client', root: '/Users/nic/secret-client' } })
    recover(t, { kind: 'crash', reason: 'oom', exitCode: 9 })
    const text = copyDetails(t, { app: '0.1.0', electron: '45.0.0', chrome: '156.0.8078.48', marver: '0.27.1', macos: '26.0', model: 'Mac16,1', memGB: 36, pressure: 1 })
    expect(text).toMatch(/^Marver app 0\.1\.0 · Electron 45\.0\.0 · Chromium 156\.0\.8078\.48 · Marver 0\.27\.1\nmacOS 26\.0 · Mac16,1 · 36 GB\nreason oom · exit 9\ncrashes 1 at \d\d:\d\d:\d\d\nmemory pressure 1\n$/)
    for (const bad of ['Secret', 'secret', '/Users', 'ERR_', t.path, 'main']) expect(text).not.toContain(bad)
    expect(copyDetails(t, { app: '../../etc', electron: 'x y', chrome: '1', macos: '26', memGB: 8 })).toContain('Marver app unknown · Electron unknown')
  })
})
