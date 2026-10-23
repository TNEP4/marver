/**
 * A3's frozen contracts (spec 28 A3.8 #53), without Electron: the bridge's checks of `mv:perf` and `mv:presented`
 * and `mv:hello`'s inset; the rate limit; the app.jsonl envelope; the machine profiles' canonical form and hash,
 * the same in the app and a headless run; the budgets' process sets; the geometry's pure reads; the guard's unload
 * as one serialized operation (`done`, the waits, `sweeping`, a silent refusal) while its admission is not built.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { checkHello, checkPerf, checkPresented, perfBucket } from '../../src/main/bridge.ts'
import { inOwnSet } from '../../src/main/procs.ts'
import { profileHash as appHash } from '../../src/main/machine.ts'
import { docInset, placed, seeThrough } from '../../src/main/layout.ts'
import { blankTab, displayState, guard, guardAll, isSweeping, unloadRefusal, wantsLoad, type GuardAction, type Tab } from '../../src/main/tabs.ts'
import { T } from '../../src/main/timings.ts'
import { APP_KINDS, parseAppLine } from '../../../src/shared/app-perf.ts'
import { canonical } from '../../../src/shared/machine.ts'
import { profileHash as hostHash } from '../../../src/server/machine-host.ts'
import { CANVAS_CHANNELS, PERF_BOUNDS } from '../../../src/shared/app-api.ts'
import { deferred, flush, liveTab, world, type World } from './window-fakes.ts'

describe('mv:perf (A3.8 #10)', () => {
  const view = { w: 1440, h: 900 }
  it('each kind accepted, unknown fields stripped', () => {
    expect(checkPerf({ kind: 'gesture', on: true, seq: 3, type: 'zoom', extra: 1 })).toEqual({ kind: 'gesture', on: true, seq: 3, type: 'zoom' })
    expect(checkPerf({ kind: 'gesture', on: false, seq: 3 })).toEqual({ kind: 'gesture', on: false, seq: 3 })
    expect(checkPerf({ kind: 'probes', tick: 9, at: 'before', points: [[10, 60], [20000, 0]], cam: { x: -400.5, y: 12, s: 0.25 }, view, x: 1 }))
      .toEqual({ kind: 'probes', tick: 9, at: 'before', points: [[10, 60], [20000, 0]], cam: { x: -400.5, y: 12, s: 0.25 }, view })
    expect(checkPerf({ kind: 'probes', tick: 9, at: 'after', valid: [true, false], cam: null, view })).toEqual({ kind: 'probes', tick: 9, at: 'after', valid: [true, false], cam: null, view })
    expect(checkPerf({ kind: 'mem', tick: 1, privateKB: 152_000, heapUsedKB: 40_000.5, heapTotalKB: 60_000 })).toEqual({ kind: 'mem', tick: 1, privateKB: 152_000, heapUsedKB: 40_000.5, heapTotalKB: 60_000 })
    expect(checkPerf({ kind: 'shown', tick: 4, ms: 1 })).toEqual({ kind: 'shown', tick: 4 })
    expect(checkPerf({ kind: 'board', frames: 120, asleep: 80 })).toEqual({ kind: 'board', frames: 120, asleep: 80 })
  })
  it('a value past its bound, or of the wrong type, refuses the message', () => {
    const pts = (n: number) => Array.from({ length: n }, (_, i) => [i, i])
    expect(checkPerf({ kind: 'probes', tick: 1, at: 'before', points: pts(PERF_BOUNDS.points), cam: null, view })).not.toBe(null)
    expect(checkPerf({ kind: 'probes', tick: 1, at: 'before', points: pts(PERF_BOUNDS.points + 1), cam: null, view })).toBe(null)
    expect(checkPerf({ kind: 'probes', tick: 1, at: 'before', points: [[20_001, 0]], cam: null, view })).toBe(null)
    expect(checkPerf({ kind: 'probes', tick: 1, at: 'before', points: [[-1, 0]], cam: null, view })).toBe(null)
    expect(checkPerf({ kind: 'probes', tick: 1, at: 'after', valid: [1], cam: null, view })).toBe(null)
    expect(checkPerf({ kind: 'probes', tick: 1, at: 'after', valid: [], cam: { x: 0, y: 0, s: 0 }, view })).toBe(null)
    expect(checkPerf({ kind: 'probes', tick: 1, at: 'sideways', valid: [], cam: null, view })).toBe(null)
    expect(checkPerf({ kind: 'mem', tick: 1, privateKB: 1e9 + 1, heapUsedKB: 0, heapTotalKB: 0 })).toBe(null)
    expect(checkPerf({ kind: 'gesture', on: 'yes', seq: 1 })).toBe(null)
    expect(checkPerf({ kind: 'gesture', on: true, seq: 1, type: 'scroll' })).toBe(null)
    expect(checkPerf({ kind: 'shown', tick: -1 })).toBe(null)
    expect(checkPerf({ kind: 'shown', tick: 1.5 })).toBe(null)
    expect(checkPerf({ kind: 'nope' })).toBe(null)
    expect(checkPerf(null)).toBe(null)
  })
  it('30 a second per webContents, a burst of 64', () => {
    const b = perfBucket(0)
    let ok = 0
    for (let i = 0; i < 100; i++) if (b.take(0)) ok += 1
    expect(ok).toBe(PERF_BOUNDS.burst)
    expect(b.take(10)).toBe(false)          // 10 ms: a third of a token
    expect(b.take(1000)).toBe(true)         // a second later: 30 more
    let more = 1
    while (b.take(1000)) more += 1
    expect(more).toBe(30)
  })
  it('the channels are named', () => {
    expect([CANVAS_CHANNELS.perf, CANVAS_CHANNELS.perfAsk, CANVAS_CHANNELS.present, CANVAS_CHANNELS.presented]).toEqual(['mv:perf', 'mv:perf-ask', 'mv:present', 'mv:presented'])
  })
})

describe('mv:presented and mv:hello\'s inset (A3.8 #26, #27)', () => {
  it('presented: an integer epoch, a viewport within bounds', () => {
    expect(checkPresented({ epoch: 7, w: 1440, h: 856, x: 1 })).toEqual({ epoch: 7, w: 1440, h: 856 })
    expect(checkPresented({ epoch: 7.5, w: 1, h: 1 })).toBe(null)
    expect(checkPresented({ epoch: -1, w: 1, h: 1 })).toBe(null)
    expect(checkPresented({ epoch: 1, w: 20_001, h: 1 })).toBe(null)
    expect(checkPresented({ epoch: 1, w: Number.NaN, h: 1 })).toBe(null)
  })
  it('hello: inset 0 or 44 when present, any other value refuses; absent reads 0 (no field)', () => {
    const base = { version: '0.27.2', board: 'main', page: 'PAGE_0123456789' }
    expect(checkHello({ ...base, inset: 44 })).toEqual({ ...base, inset: 44 })
    expect(checkHello({ ...base, inset: 0 })).toEqual({ ...base, inset: 0 })
    expect(checkHello(base)).toEqual(base)
    expect(checkHello({ ...base, inset: 12 })).toBe(null)
    expect(checkHello({ ...base, inset: '44' })).toBe(null)
  })
})

describe('app.jsonl\'s envelope (A3.8 #8)', () => {
  const env = { v: 1, ts: 1_761_000_000_000, kind: 'dropped', app: '0123456789ab', seq: 0, flavour: 'release', machine: '0123456789abcdef', n: 3 }
  it('a line with the envelope parses, its body passed on', () => {
    expect(parseAppLine(JSON.stringify(env))).toEqual(env)
    expect(parseAppLine(JSON.stringify({ ...env, machine: null, flavour: 'dev' }))).not.toBe(null)
  })
  it('anything else is null - app 0.1\'s main-error lines among them', () => {
    expect(parseAppLine(JSON.stringify({ v: 1, ts: 1, kind: 'main-error', what: 'exception', name: 'Error', message: 'x', stack: [] }))).toBe(null)
    for (const bad of [{ v: 2 }, { kind: 'nope' }, { app: 'XYZ' }, { seq: -1 }, { seq: 1.5 }, { flavour: 'beta' }, { machine: 'short' }, { ts: 'now' }]) {
      expect(parseAppLine(JSON.stringify({ ...env, ...bad }))).toBe(null)
    }
    expect(parseAppLine('{')).toBe(null)
    expect(parseAppLine('[]')).toBe(null)
  })
  it('the frozen kinds', () => {
    expect(APP_KINDS).toEqual(['start', 'sample', 'agx', 'gone', 'child-gone', 'gpu-restart', 'unresponsive', 'responsive', 'gpu', 'power',
      'tab', 'shown', 'pressure', 'unload', 'unload-skip', 'unload-effect', 'reopen', 'cover', 'flash', 'whiteout-candidate', 'dropped', 'main-error'])
  })
})

describe('the machine profile\'s hash (A3.8 #11)', () => {
  it('canonical: keys sorted at every depth, so field order never changes the hash', () => {
    expect(canonical({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null }, u: undefined })).toBe('{"a":{"c":null,"d":[2,{"x":0,"y":1}]},"b":1}')
    const a = { chip: 'Apple M3 Max', cores: { total: 16, p: 12, e: 4 }, memGB: 64 }
    const b = { memGB: 64, cores: { e: 4, p: 12, total: 16 }, chip: 'Apple M3 Max' }
    expect(appHash(a)).toBe(appHash(b))
    expect(appHash(a)).toMatch(/^[0-9a-f]{16}$/)
  })
  it('the app and a headless run hash a host alike, so their profiles meet by hostHash', () => {
    const host = { chip: 'Apple M3 Max', cores: { total: 16, p: 12, e: 4 }, model: 'Mac15,9', memGB: 64, os: '26.6.2', arch: 'arm64' }
    expect(appHash(host)).toBe(hostHash(host))
  })
})

describe('the budgets\' process sets (A3.8 #4, #48, #49)', () => {
  it('the app\'s own: browser, GPU (not with canvases open), utility, app pages; a canvas renderer never; an unknown renderer counts against the app', () => {
    const p = (type: 'browser' | 'gpu' | 'utility' | 'renderer' | 'other', role: 'canvas' | 'strip' | 'home' | 'none' | 'unknown' | 'mixed' | 'cover' = 'none') => ({ type, role })
    for (const gate of ['cpu', 'memory-no-canvas', 'memory-canvases'] as const) {
      expect(inOwnSet(p('browser'), gate)).toBe(true)
      expect(inOwnSet(p('utility'), gate)).toBe(true)
      expect(inOwnSet(p('renderer', 'strip'), gate)).toBe(true)
      expect(inOwnSet(p('renderer', 'cover'), gate)).toBe(true)
      expect(inOwnSet(p('renderer', 'unknown'), gate)).toBe(true)
      expect(inOwnSet(p('renderer', 'canvas'), gate)).toBe(false)
    }
    expect(inOwnSet(p('gpu'), 'cpu')).toBe(true)
    expect(inOwnSet(p('gpu'), 'memory-no-canvas')).toBe(true)
    expect(inOwnSet(p('gpu'), 'memory-canvases')).toBe(false)
  })
})

describe('the geometry\'s pure reads (A3.8 #24, #26)', () => {
  it('a new tab is below, insets 0, and is never seen through', () => {
    const t = blankTab('t1', 'local', 'x')
    expect(t.geo).toEqual({ layout: 'below', htmlFullscreen: false })
    expect(placed(t)).toBe('below')
    expect(docInset(t)).toBe(0)
    expect(seeThrough(t)).toBe(false)
  })
  it('HTML fullscreen places it below whatever its layout; the inset is the pending layout\'s first', () => {
    const t = blankTab('t1', 'local', 'x', { geo: { layout: 'full', htmlFullscreen: true } })
    expect(placed(t)).toBe('below')
    expect(docInset(t)).toBe(44)
    t.geo = { layout: 'full', htmlFullscreen: false, pending: { gen: 2, instance: 'i', layout: 'below' } }
    expect(docInset(t)).toBe(0)
  })
  it('the starting timings are A3.8\'s', () => {
    expect([T.sampleMs, T.unloadMinHiddenMs, T.unloadCooldownMs, T.unloadActMs, T.unloadEffectMs, T.presentFrames, T.uncoverDelayMs]).toEqual([5000, 10_000, 30_000, 10_000, 5000, 2, 0])
  })
})

describe('the guard\'s unload (A3.8 #39, #42) while its admission is not built', () => {
  let w: World
  beforeEach(() => { w = world() })
  const unload: GuardAction = { kind: 'unload', reason: 'warn' }

  it('a hidden tab is refused silently: no sheet, no act, nothing brought forward, the operation ended', async () => {
    const t = liveTab(w)
    const other = liveTab(w)   // shown last: t is hidden
    expect(other.id).not.toBe(t.id)
    expect(await guard(t, unload)).toBe('refused')
    expect(w.sheets).toHaveLength(0)
    expect(w.acts).toHaveLength(0)
    expect(w.forwards).toBe(0)
    expect(t.held).toBeUndefined()
    expect(t.replacing).toBeUndefined()
    expect(unloadRefusal(t, w.clock.now)).not.toBe(null)
    expect(unloadRefusal(blankTab('home', 'home', 'Home'), w.clock.now)).toBe('not-canvas')
  })

  it('another action on the tab waits for the unload\'s done, then is judged on what is left', async () => {
    const t = liveTab(w)
    const u = guard(t, unload)
    const op = t.replacing!
    expect(op.action).toEqual(unload)
    let settled = false
    void op.done.then(() => { settled = true })
    const c = guard(t, { kind: 'close' })   // queued behind it, never refused for it
    expect(await u).toBe('refused')
    await flush()
    expect(settled).toBe(true)
    expect(await c).toBe('done')
    expect(w.acts.map((a) => a.action.kind)).toEqual(['close'])
  })

  it('every operation\'s done settles after Tab.replacing is cleared', async () => {
    const t = liveTab(w)
    const gate = deferred<'done' | 'refused'>()
    w.actWith = () => gate.promise
    const p = guard(t, { kind: 'reload' })
    const op = t.replacing!
    let seen: unknown = 'not yet'
    void op.done.then(() => { seen = t.replacing })
    gate.resolve('done')
    expect(await p).toBe('done')
    await flush()
    expect(seen).toBeUndefined()
  })

  it('guardAll sweeps no unload in, and clears the sweep when it is refused', async () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    expect(isSweeping()).toBe(false)
    const q = guardAll({ kind: 'quit' })
    expect(isSweeping()).toBe(true)
    expect(await q).toBe('refused')
    expect(isSweeping()).toBe(false)
    expect(t.held?.action).toBe('quit')
  })

  it('an unloaded tab shows as unloaded and loads when shown (the reopen is the unloading stream\'s)', () => {
    const t = liveTab(w, { show: false })
    t.view = 'unloaded'
    t.retained = false
    expect(displayState(t, false)).toBe('unloaded')
    expect(wantsLoad(t)).toBe(true)
  })
})
