/**
 * The white-out detector (spec 28 A3.3, A3.7, A3.8 #15, #16, r1 #5), through fake ports, a fake view and a fake
 * clock: the verdicts, the pairing at 4 Hz and at 2 Hz, a skipped tick between two whites, the capture past 500 ms
 * that keeps its slot, the bracket's checks, and a frame that is white on purpose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { PerfMsg, PerfProbeAsk } from '../../../src/shared/app-api.ts'
import type { AppBody, TabIdent } from '../../../src/shared/app-perf.ts'
import { T } from '../../src/main/timings.ts'
import { classify, probeWhite, startWhiteout, stopWhiteout, wholeWhite, whiteoutStats, type WhiteoutPorts } from '../../src/main/whiteout.ts'

vi.mock('electron', () => ({ app: {} }))

const W = 100, H = 80
const solid = (w: number, h: number, v: number) => { const b = Buffer.alloc(w * h * 4, v); for (let i = 3; i < b.length; i += 4) b[i] = 255; return b }
/** what the view shows at a tick: all white, a grey board, or a white frame on purpose (white overall, grey at the probes) */
type Look = 'white' | 'clear' | 'purpose'
const image = (look: Look) => ({
  isEmpty: () => false,
  getSize: () => ({ width: W, height: H }),
  resize: () => ({ toBitmap: () => solid(64, 51, look === 'clear' ? 200 : 255) }),
  toBitmap: () => solid(W, H, look === 'white' ? 255 : 200),
})
const POINTS: [number, number][] = Array.from({ length: 10 }, (_, i) => [10 + i * 8, 40])

interface Rig {
  ports: WhiteoutPorts
  records: { ident: TabIdent; body: Omit<AppBody<'whiteout-candidate'>, keyof TabIdent> }[]
  asks: PerfProbeAsk[]
  captures: number[]
  send(msg: PerfMsg, doc?: string): void
  looks: Look[]
  o: { answerMs: number; captureMs: number; valid: boolean[]; commit: number; changeCommitAfterBefore: boolean; recorder: boolean; viewAfter?: { w: number; h: number } }
}

function rig(): Rig {
  let listener: ((tabId: string, doc: string, msg: PerfMsg) => void) | null = null
  const r = { records: [], asks: [], captures: [], looks: [] } as unknown as Rig
  r.o = { answerMs: 5, captureMs: 10, valid: POINTS.map(() => true), commit: 1, changeCommitAfterBefore: false, recorder: true }
  r.send = (msg, doc = 'doc-0000000000000001') => listener?.('t1', doc, msg)
  let k = 0
  const wc = {
    capturePage: () => new Promise((res) => {
      r.captures.push(Date.now())
      const look = r.looks[k++] ?? 'clear'
      setTimeout(() => res(image(look)), r.o.captureMs)
    }),
  } as unknown as WebContents
  r.ports = {
    recorderOn: () => r.o.recorder,
    target: () => ({ tabId: 't1', wc, ident: { tab: 't1', ws: 'ab'.repeat(8), commit: r.o.commit, page: 'page-0001' } }),
    onPerf: (fn) => { listener = fn; return () => { listener = null } },
    ask: (_tab, a) => {
      r.asks.push(a)
      setTimeout(() => {
        if (a.at === 'before') {
          r.send({ kind: 'probes', tick: a.tick, at: 'before', points: POINTS, cam: { x: 0, y: 0, s: 1 }, view: { w: W, h: H } })
          if (r.o.changeCommitAfterBefore) r.o.commit++
        } else r.send({ kind: 'probes', tick: a.tick, at: 'after', valid: r.o.valid, cam: { x: 0, y: 0, s: 1 }, view: r.o.viewAfter ?? { w: W, h: H } })
      }, r.o.answerMs)
      return true
    },
    gpuEvents: () => [],
    readAgx: async () => ({ gpuSystemMemoryMB: 1, allocMB: 2, utilPct: 3, rendererPct: 4, tilerPct: 5, recoveryCount: 0, machineWide: true }),
    record: (ident, body) => { r.records.push({ ident, body }) },
    now: () => Date.now(),
  }
  startWhiteout(r.ports)
  return r
}

const T0 = 1_800_000_000_000
const saved = { tick: T.whiteoutTickMs }
beforeEach(() => { vi.useFakeTimers({ now: T0 }) })
afterEach(() => { stopWhiteout(); T.whiteoutTickMs = saved.tick; vi.useRealTimers() })

/** a gesture held `ms`, then the tail */
async function gesture(r: Rig, ms: number) {
  r.send({ kind: 'gesture', on: true, seq: 7, type: 'zoom' })
  await vi.advanceTimersByTimeAsync(ms)
  r.send({ kind: 'gesture', on: false, seq: 7 })
  await vi.advanceTimersByTimeAsync(T.whiteoutTailMs + T.whiteoutTickMs + 50)
}

describe('the verdicts (A3.8 #15, #16)', () => {
  it('classify: fewer than 4 valid probes is inconclusive; 70 % or more white is white', () => {
    expect(classify([true, true, true, null, null])).toBe('inconclusive')
    expect(classify([...Array(7).fill(true), false, false, false])).toBe('white')
    expect(classify([...Array(6).fill(true), false, false, false, false])).toBe('clear')
    expect(classify([true, true, true, true])).toBe('white')
  })

  it('near-white is every colour channel at least 245; a probe is its 3 x 3 crop, 5 of 9; outside the image null', () => {
    expect(wholeWhite(solid(4, 4, 245))).toBe(1)
    expect(wholeWhite(solid(4, 4, 244))).toBe(0)
    const b = solid(10, 10, 255)
    expect(probeWhite(b, 10, 10, 5, 5)).toBe(true)
    expect(probeWhite(b, 10, 10, 0, 5)).toBeNull()
    for (const [x, y] of [[4, 4], [5, 4], [6, 4], [4, 5], [5, 5]]) { const i = (y! * 10 + x!) * 4; b[i] = b[i + 1] = b[i + 2] = 100 }
    expect(probeWhite(b, 10, 10, 5, 5)).toBe(false)
  })
})

describe('the detector, at 4 Hz', () => {
  it('two white samples at consecutive ticks make one candidate, white at those two moments only', async () => {
    const r = rig()
    r.looks = ['white', 'white', 'clear', 'clear', 'clear', 'clear']
    await gesture(r, 1000)
    expect(r.records).toHaveLength(1)
    const c = r.records[0]!
    expect(c.ident).toMatchObject({ tab: 't1', commit: 1, page: 'page-0001' })
    expect(c.body.observedAt.map((t) => t - c.body.observedAt[0]!)).toEqual([0, 250])
    expect(c.body).toMatchObject({ gesture: 7, rateHz: 4 })
    expect(c.body.agx.machineWide).toBe(true)
  })

  it('a run of whites is one record, as long as it lasts', async () => {
    const r = rig()
    r.looks = ['white', 'white', 'white', 'white', 'clear']
    await gesture(r, 1200)
    expect(r.records).toHaveLength(1)
    expect(r.records[0]!.body.observedAt).toHaveLength(4)
  })

  it('white, clear, white makes none; a lone white makes none', async () => {
    const r = rig()
    r.looks = ['white', 'clear', 'white', 'clear', 'clear']
    await gesture(r, 1200)
    expect(r.records).toEqual([])
  })

  it('a tick skipped between two whites makes none (the slot held by a slow capture)', async () => {
    const r = rig()
    r.o.captureMs = 300   // the sample spans the next tick: it is skipped
    r.looks = ['white', 'white', 'white', 'white', 'white', 'white']
    await gesture(r, 1500)
    expect(whiteoutStats().skipped).toBeGreaterThan(0)
    expect(whiteoutStats().white).toBeGreaterThanOrEqual(2)
    expect(r.records).toEqual([])
  })

  it('a capture past 500 ms is abandoned, and keeps the slot until it settles: captures never pile up', async () => {
    const r = rig()
    r.o.captureMs = 900
    r.looks = Array(20).fill('white')
    r.send({ kind: 'gesture', on: true, seq: 1 })
    await vi.advanceTimersByTimeAsync(880)
    expect(r.captures).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(400)   // the first settled at ~905; the tick at 1000 captures again
    expect(r.captures).toHaveLength(2)
    expect(r.captures[1]! - r.captures[0]!).toBeGreaterThanOrEqual(900)
    expect(whiteoutStats().abandoned).toBe(1)
    r.send({ kind: 'gesture', on: false, seq: 1 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(r.records).toEqual([])   // every sample abandoned: inconclusive, never white
  })

  it('inconclusive, never white: an answer later than 150 ms, a commit changed inside the bracket, another viewport, fewer than 4 valid probes', async () => {
    for (const set of [
      (r: Rig) => { r.o.answerMs = 160 },
      (r: Rig) => { r.o.changeCommitAfterBefore = true },
      (r: Rig) => { r.o.viewAfter = { w: W + 10, h: H } },
      (r: Rig) => { r.o.valid = POINTS.map((_, i) => i < 3) },
    ]) {
      const r = rig()
      set(r)
      r.looks = Array(10).fill('white')
      await gesture(r, 800)
      expect(r.records).toEqual([])
      expect(whiteoutStats().inconclusive).toBeGreaterThan(0)
      expect(whiteoutStats().white).toBe(0)
      stopWhiteout()
    }
  })

  it('a whole view under 85 % white is clear without the after ask', async () => {
    const r = rig()
    r.looks = Array(6).fill('clear')
    await gesture(r, 600)
    expect(r.asks.filter((a) => a.at === 'after')).toEqual([])
    expect(r.asks.filter((a) => a.at === 'before').length).toBeGreaterThan(1)
  })

  it('a frame white on purpose: the view is white but the probes are not, so no candidate', async () => {
    const r = rig()
    r.looks = Array(12).fill('purpose')
    await gesture(r, 1200)
    expect(r.records).toEqual([])
    expect(whiteoutStats().clear).toBeGreaterThan(1)
    // cleared by the probes, not by the whole-view test: every clear sample took the probe path
    expect(whiteoutStats().probed).toBe(whiteoutStats().clear)
  })

  it('a grey board is cleared by the whole-view test and never asks after', async () => {
    const r = rig()
    r.looks = Array(6).fill('clear')
    await gesture(r, 600)
    expect(whiteoutStats().clear).toBeGreaterThan(1)
    expect(whiteoutStats().probed).toBe(0)
    expect(r.asks.filter((a) => a.at === 'after')).toEqual([])
  })

  it('tick numbers are never reused across gesture windows, so a late answer of one window cannot meet the next (review of a3-native, minor #14)', async () => {
    const r = rig()
    r.looks = Array(20).fill('clear')
    await gesture(r, 600)
    const first = r.asks.map((a) => a.tick)
    // a late "before" for the first window's first tick, while the second window runs: no tick of the second has it
    await gesture(r, 600)
    const second = r.asks.slice(first.length).map((a) => a.tick)
    expect(first.length).toBeGreaterThan(1)
    expect(second.length).toBeGreaterThan(1)
    expect(Math.min(...second)).toBeGreaterThan(Math.max(...first))
  })

  it('only with the recorder on, and only from a gesture until 500 ms after it ends', async () => {
    const r = rig()
    r.o.recorder = false
    r.looks = Array(6).fill('white')
    await gesture(r, 800)
    expect(r.captures).toEqual([])
    r.o.recorder = true
    r.send({ kind: 'gesture', on: true, seq: 2 })
    await vi.advanceTimersByTimeAsync(400)
    r.send({ kind: 'gesture', on: false, seq: 2 })
    const n = r.captures.length
    await vi.advanceTimersByTimeAsync(T.whiteoutTailMs + 400)
    const after = r.captures.length
    expect(after - n).toBeLessThanOrEqual(3)   // the tail's ticks
    await vi.advanceTimersByTimeAsync(2000)
    expect(r.captures.length).toBe(after)
  })
})

describe('at 2 Hz (the cost case\'s fallback, A3.8 #15, r1 #5)', () => {
  it('two whites a tick (500 ms) apart pair - at most 800 ms; a skipped tick between them makes none', async () => {
    T.whiteoutTickMs = 500
    const r = rig()
    r.looks = ['white', 'white', 'clear', 'clear']
    await gesture(r, 1500)
    expect(r.records).toHaveLength(1)
    expect(r.records[0]!.body.rateHz).toBe(2)
    expect(r.records[0]!.body.observedAt[1]! - r.records[0]!.body.observedAt[0]!).toBe(500)
    stopWhiteout()
    const s = rig()
    s.o.captureMs = 495   // the sample (5 + 495 + 5 ms) spans the next tick, never abandoned: white, skipped, white
    s.looks = Array(10).fill('white')
    await gesture(s, 2500)
    expect(whiteoutStats().skipped).toBeGreaterThan(0)
    expect(whiteoutStats().white).toBeGreaterThanOrEqual(2)
    expect(s.records).toEqual([])
  })
})
