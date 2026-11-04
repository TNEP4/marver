/**
 * Spec 30 R8 (#38-#41), the white-out detector beyond gestures, through fake ports, a fake view and a fake clock: the
 * `watch` windows, their extension and their 10 s end; `shown`; one window per tab with every reason on its candidates;
 * the admission budget - admission stops once the minute's capture time reaches 3 s, a capture that settles after 4 s
 * is recorded at its true length and holds admission until it leaves the rolling window, then admission resumes;
 * uncovered time by reason (a covering stage, the budget, a hidden window); the bridge's check and the preload's
 * `perfInfo().watch`. A gesture's own rules are whiteout.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { PerfMsg, PerfProbeAsk } from '../../../src/shared/app-api.ts'
import { WATCH_MAX_MS, WATCH_WHY } from '../../../src/shared/app-api.ts'
import type { AppBody, TabIdent } from '../../../src/shared/app-perf.ts'
import { T } from '../../src/main/timings.ts'
import { ADMIT_MS, noteShown, startWhiteout, stopWhiteout, takeWhiteoutMinute, whiteoutStats, type WhiteoutPorts } from '../../src/main/whiteout.ts'

vi.mock('electron', () => ({ app: {}, ipcMain: { on() {}, handle() {} }, webFrameMain: {} }))
vi.mock('../../src/main/testing/index.ts', () => ({ note: vi.fn(), testMode: () => false }))

const W = 100, H = 80
const solid = (w: number, h: number, v: number) => { const b = Buffer.alloc(w * h * 4, v); for (let i = 3; i < b.length; i += 4) b[i] = 255; return b }
type Look = 'white' | 'clear'
const image = (look: Look) => ({
  isEmpty: () => false,
  getSize: () => ({ width: W, height: H }),
  resize: () => ({ toBitmap: () => solid(64, 51, look === 'clear' ? 200 : 255) }),
  toBitmap: () => solid(W, H, look === 'white' ? 255 : 200),
})
const POINTS: [number, number][] = Array.from({ length: 10 }, (_, i) => [10 + i * 8, 40])

interface Rig {
  send(msg: PerfMsg, tab?: string): void
  records: { ident: TabIdent; body: Omit<AppBody<'whiteout-candidate'>, keyof TabIdent> }[]
  captures: number[]
  o: { captureMs: number; look: Look; hidden: boolean; stage: boolean; recorder: boolean; tab: string }
}
function rig(): Rig {
  let listener: ((tabId: string, doc: string, msg: PerfMsg) => void) | null = null
  const r = { records: [], captures: [], o: { captureMs: 40, look: 'clear', hidden: false, stage: false, recorder: true, tab: 't1' } } as unknown as Rig
  r.send = (msg, tab = 't1') => listener?.(tab, 'doc-0000000000000001', msg)
  const wc = { capturePage: () => new Promise((res) => { r.captures.push(Date.now()); const look = r.o.look; setTimeout(() => res(image(look)), r.o.captureMs) }) } as unknown as WebContents
  const ports: WhiteoutPorts = {
    recorderOn: () => r.o.recorder,
    target: () => (r.o.hidden ? null : { tabId: r.o.tab, wc, ident: { tab: r.o.tab, ws: 'ab'.repeat(8), commit: 1, page: 'page-0001' } }),
    onPerf: (fn) => { listener = fn; return () => { listener = null } },
    ask: (_tab, a: PerfProbeAsk) => {
      setTimeout(() => {
        if (a.at === 'before') r.send({ kind: 'probes', tick: a.tick, at: 'before', points: r.o.stage ? [] : POINTS, cam: { x: 0, y: 0, s: 1 }, view: { w: W, h: H }, ...(r.o.stage ? { stage: true as const } : {}) })
        else r.send({ kind: 'probes', tick: a.tick, at: 'after', valid: POINTS.map(() => true), cam: { x: 0, y: 0, s: 1 }, view: { w: W, h: H } })
      }, 5)
      return true
    },
    gpuEvents: () => [],
    readAgx: async () => ({ gpuSystemMemoryMB: 1, allocMB: 2, utilPct: 3, rendererPct: 4, tilerPct: 5, recoveryCount: 0, machineWide: true }),
    record: (ident, body) => { r.records.push({ ident, body }) },
    now: () => Date.now(),
  }
  startWhiteout(ports)
  return r
}

const T0 = 1_800_000_000_000
beforeEach(() => { vi.useFakeTimers({ now: T0 }) })
afterEach(() => { stopWhiteout(); vi.useRealTimers() })
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const watch = (on: boolean, seq: number, why: 'load' | 'theme' | 'reload' = 'load') => ({ kind: 'watch' as const, on, seq, why })

describe('the windows (#38, #40)', () => {
  it('a watch window captures from its `on` until a tail after its `off`', async () => {
    const r = rig()
    r.send(watch(true, 1))
    await run(1000)
    const during = r.captures.length
    expect(during).toBeGreaterThanOrEqual(4)
    r.send(watch(false, 1))
    await run(T.whiteoutTailMs + T.whiteoutTickMs + 50)
    const after = r.captures.length
    await run(5000)
    expect(r.captures.length).toBe(after)                    // closed
    expect(whiteoutStats().windows).toBe(1)
  })

  it('a window nobody closes ends at 10 s, whatever the shell says', async () => {
    const r = rig()
    r.o.captureMs = 5
    r.send(watch(true, 1))
    await run(WATCH_MAX_MS - 300)
    const n = r.captures.length
    await run(200)
    expect(r.captures.length).toBeGreaterThanOrEqual(n)      // still going just before
    await run(WATCH_MAX_MS)
    expect(r.captures.at(-1)! - T0).toBeLessThanOrEqual(WATCH_MAX_MS)
    expect(whiteoutStats().windows).toBe(1)
  })

  it('a new reason extends it: one window, 10 s from the new reason, every reason on the minute', async () => {
    const r = rig()
    r.o.captureMs = 5
    r.send(watch(true, 1))
    await run(8000)
    r.send(watch(true, 2, 'theme'))
    await run(9000)
    expect(r.captures.at(-1)! - T0).toBeGreaterThan(WATCH_MAX_MS + 6000)
    await run(5000)
    expect(whiteoutStats().windows).toBe(1)
    expect(r.captures.at(-1)! - T0).toBeLessThanOrEqual(8000 + WATCH_MAX_MS)
    const m = takeWhiteoutMinute()!
    expect(m.windows).toBe(1)
    expect(m.byWhy).toEqual({ load: 1, theme: 1 })
  })

  it('it closes when its last reason closes, not its first', async () => {
    const r = rig()
    r.o.captureMs = 5
    r.send(watch(true, 1))
    r.send(watch(true, 2, 'reload'))
    await run(500)
    r.send(watch(false, 1))
    await run(1000)
    const n = r.captures.length
    await run(500)
    expect(r.captures.length).toBeGreaterThan(n)             // reload still open
    r.send(watch(false, 2, 'reload'))
    await run(T.whiteoutTailMs + T.whiteoutTickMs + 50)
    const end = r.captures.length
    await run(2000)
    expect(r.captures.length).toBe(end)
  })

  it('`shown` is main\'s own: a window from the show, ended at 10 s', async () => {
    const r = rig()
    r.o.captureMs = 5
    noteShown('t1')
    await run(1000)
    expect(r.captures.length).toBeGreaterThanOrEqual(4)
    await run(WATCH_MAX_MS + 1000)
    expect(r.captures.at(-1)! - T0).toBeLessThanOrEqual(WATCH_MAX_MS)
    expect(takeWhiteoutMinute()!.byWhy).toEqual({ shown: 1 })
  })

  it('a tab not on screen opens nothing; with the recorder off nothing opens', async () => {
    const r = rig()
    r.send(watch(true, 1), 't2')
    noteShown('t2')
    await run(1000)
    expect(whiteoutStats().windows).toBe(0)
    r.o.recorder = false
    r.send(watch(true, 2))
    noteShown('t1')
    await run(1000)
    expect(whiteoutStats().windows).toBe(0)
    expect(r.captures).toEqual([])
  })

  it('a candidate says why: its window\'s reasons, `gesture` still the window\'s seq', async () => {
    const r = rig()
    r.o.look = 'white'
    r.o.captureMs = 5
    r.send(watch(true, 7))
    await run(600)
    r.send(watch(true, 8, 'theme'))
    await run(400)
    r.o.look = 'clear'
    await run(600)
    expect(r.records).toHaveLength(1)
    expect(r.records[0]!.body.gesture).toBe(7)
    expect(r.records[0]!.body.why).toEqual(['load'])         // the run began before the theme came
    r.o.look = 'white'
    await run(600)
    r.o.look = 'clear'
    await run(600)
    expect(r.records[1]!.body.why).toEqual(['load', 'theme'])
    expect(r.records[1]!.body.gesture).toBe(7)
  })

  it('a gesture inside a watch window keeps its rules; a gesture alone says `gesture`', async () => {
    const r = rig()
    r.o.look = 'white'
    r.o.captureMs = 5
    r.send({ kind: 'gesture', on: true, seq: 3, type: 'zoom' })
    await run(600)
    r.o.look = 'clear'
    await run(300)
    r.send({ kind: 'gesture', on: false, seq: 3 })
    await run(T.whiteoutTailMs + T.whiteoutTickMs + 50)
    expect(r.records[0]!.body.why).toEqual(['gesture'])
    expect(r.records[0]!.body.gesture).toBe(3)
    // a watch running under a gesture: the gesture's ticks are never refused, and the window outlives its tail
    r.send(watch(true, 9))
    r.send({ kind: 'gesture', on: true, seq: 4, type: 'pan' })
    await run(400)
    r.send({ kind: 'gesture', on: false, seq: 4 })
    await run(2000)
    const n = r.captures.length
    await run(1000)
    expect(r.captures.length).toBeGreaterThan(n)             // the watch's own 10 s
  })
})

describe('the admission budget (#40)', () => {
  it('admission stops once the minute\'s capture time reaches 3 s; the rest is skipped, counted and uncovered', async () => {
    const r = rig()
    r.o.captureMs = 200
    // windows one after another, as heavy use would
    for (let i = 0; i < 3; i++) { r.send(watch(true, i + 1)); await run(WATCH_MAX_MS - 1000) }
    const m = takeWhiteoutMinute()!
    const n = r.captures.length
    expect(n).toBeLessThanOrEqual(Math.ceil(ADMIT_MS / 200) + 1)
    expect(m.captureMs).toBeGreaterThanOrEqual(ADMIT_MS - 500)
    expect(m.captureMs).toBeLessThan(ADMIT_MS + 200)
    expect(m.skipped).toBeGreaterThan(0)
    expect(m.uncoveredMs.budget).toBe(m.skipped * T.whiteoutTickMs)
  })

  it('a gesture\'s captures are never refused nor charged', async () => {
    const r = rig()
    r.o.captureMs = 200
    r.send({ kind: 'gesture', on: true, seq: 1, type: 'zoom' })
    await run(10_000)
    expect(r.captures.length).toBeGreaterThan(Math.ceil(ADMIT_MS / 200))
    expect(takeWhiteoutMinute()!.skipped).toBe(0)
    r.send({ kind: 'gesture', on: false, seq: 1 })
    await run(1000)
    // nothing charged: a watch right after still captures
    const n = r.captures.length
    r.send(watch(true, 2))
    await run(1000)
    expect(r.captures.length).toBeGreaterThan(n)
  })

  it('a capture that settles after 4 s is recorded at its true length and holds admission until it leaves the rolling minute; then admission resumes', async () => {
    const r = rig()
    r.o.captureMs = 4000
    r.send(watch(true, 1))
    await run(4100)
    expect(r.captures).toHaveLength(1)                       // abandoned at 500 ms, its slot kept: one outstanding
    const m1 = takeWhiteoutMinute()!
    expect(m1.captures).toBe(1)
    expect(m1.captureMs).toBe(4000)
    expect(m1.overrunMs).toBe(3500)
    expect(whiteoutStats().abandoned).toBe(1)
    // charged in full: past the budget, nothing admitted while it is in the rolling minute
    r.o.captureMs = 10
    await run(5000)
    expect(r.captures).toHaveLength(1)
    expect(takeWhiteoutMinute()!.uncoveredMs.budget).toBeGreaterThan(0)
    await run(20_000)                                        // the window ended meanwhile
    r.send(watch(true, 2))
    await run(5000)
    expect(r.captures).toHaveLength(1)                       // still within the minute
    // it settled 4 s after T0: from T0 + 64 s it has left the window
    await vi.advanceTimersByTimeAsync(T0 + 64_500 - Date.now())
    r.send(watch(true, 3))
    await run(1000)
    expect(r.captures.length).toBeGreaterThan(1)             // admission resumed
  })

  it('the estimate of the next is the last capture\'s length, 500 ms at most: admission stops short of 3 s, never past it by more than that', async () => {
    const r = rig()
    r.o.captureMs = 900
    r.send(watch(true, 1))
    await run(9000)
    const m = takeWhiteoutMinute()!
    // 900, 1800: under 3 s even with a 500 ms estimate; 2700 + 500 is not
    expect(m.captures).toBe(3)
    expect(m.captureMs).toBe(2700)
    expect(m.skipped).toBeGreaterThan(0)
  })
})

describe('coverage is honest (#39)', () => {
  it('a covering stage gives uncoveredMs.stage: no capture taken', async () => {
    const r = rig()
    r.o.stage = true
    r.send(watch(true, 1))
    await run(2000)
    expect(r.captures).toEqual([])
    const m = takeWhiteoutMinute()!
    expect(m.uncoveredMs.stage).toBeGreaterThanOrEqual(1500)
    expect(m.captures).toBe(0)
  })

  it('a hidden window gives uncoveredMs.hidden: no capture, no probe', async () => {
    const r = rig()
    r.send(watch(true, 1))
    r.o.hidden = true
    await run(1000)
    expect(r.captures).toEqual([])
    expect(takeWhiteoutMinute()!.uncoveredMs.hidden).toBeGreaterThanOrEqual(750)
    r.o.hidden = false
    await run(1000)
    expect(r.captures.length).toBeGreaterThan(0)
  })

  it('a watch that comes while the window is hidden opens a window that says so', async () => {
    const r = rig()
    r.o.hidden = true
    r.send(watch(true, 1))
    await run(2000)
    expect(whiteoutStats().windows).toBe(1)
    expect(takeWhiteoutMinute()!.uncoveredMs.hidden).toBeGreaterThanOrEqual(1500)
  })
})

describe('the minute (#41)', () => {
  it('takes the figures and starts a new minute; null with the detector off', async () => {
    expect(takeWhiteoutMinute()).toBeNull()
    const r = rig()
    r.o.captureMs = 10
    r.send(watch(true, 1))
    await run(1000)
    const m = takeWhiteoutMinute()!
    expect(m.windows).toBe(1)
    expect(m.captures).toBeGreaterThan(0)
    expect(m.captureMs).toBe(m.captures * 10)
    expect(m.overrunMs).toBe(0)
    expect(m.byWhy).toEqual({ load: 1 })
    expect(takeWhiteoutMinute()).toEqual({ windows: 0, captures: expect.any(Number), captureMs: expect.any(Number), overrunMs: 0, skipped: 0, uncoveredMs: { stage: 0, budget: 0, hidden: 0 }, byWhy: {} })
    stopWhiteout()
    expect(takeWhiteoutMinute()).toBeNull()
  })
})

describe('the wire (#38)', () => {
  it('the bridge takes `watch` with a known reason and a seq; `stage` only as true', async () => {
    const { checkPerf } = await import('../../src/main/bridge.ts')
    for (const why of WATCH_WHY) expect(checkPerf({ kind: 'watch', on: true, seq: 4, why, x: 1 })).toEqual({ kind: 'watch', on: true, seq: 4, why })
    expect(checkPerf({ kind: 'watch', on: false, seq: 4, why: 'load' })).toEqual({ kind: 'watch', on: false, seq: 4, why: 'load' })
    for (const bad of [{ on: 'yes', seq: 1, why: 'load' }, { on: true, seq: -1, why: 'load' }, { on: true, seq: 1, why: 'shown' }, { on: true, seq: 1 }]) expect(checkPerf({ kind: 'watch', ...bad })).toBeNull()
    const view = { w: 100, h: 80 }
    expect(checkPerf({ kind: 'probes', tick: 1, at: 'before', points: [], cam: null, view, stage: true })).toEqual({ kind: 'probes', tick: 1, at: 'before', points: [], cam: null, view, stage: true })
    expect(checkPerf({ kind: 'probes', tick: 1, at: 'before', points: [], cam: null, view, stage: 'yes' })).toEqual({ kind: 'probes', tick: 1, at: 'before', points: [], cam: null, view })
  })
})
