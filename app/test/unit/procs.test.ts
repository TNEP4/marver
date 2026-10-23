/**
 * The one sampler's pure parts (spec 28 A3.7, A3.8 #4, #5, #7), without Electron: a process is `(pid, creationTime)`,
 * its CPU Δ cumulative over Δ monotonic time (null on a first sample, never negative), its memory KB to MB once; a
 * renderer of two tabs counted once; an out-of-process iframe's pid for its tab; the GPU process apart; the minute on
 * disk exact over its intervals, never a mean of 5 s means.
 */
import { describe, expect, it } from 'vitest'
import type { ProcessMetric } from 'electron'
import { build, canvasMem, foldMinute, inOwnSet, procKey, type Baseline, type Owners } from '../../src/main/procs.ts'
import type { ProcSample, Role, Sample } from '../../../src/shared/app-perf.ts'

const metric = (pid: number, type: string, cum: number | undefined, kb = 100 * 1024, born = 1_000_000 + pid, name?: string): ProcessMetric => ({
  pid, type, creationTime: born, ...(name ? { name } : {}),
  cpu: { percentCPUUsage: 99, idleWakeupsPerSecond: 0, ...(cum === undefined ? {} : { cumulativeCPUUsage: cum }) },
  memory: { workingSetSize: kb, peakWorkingSetSize: kb },
} as unknown as ProcessMetric)

const owners = (o: Record<number, { roles: Exclude<Role, 'mixed' | 'none' | 'unknown'>[]; tabs?: string[] }>): Owners =>
  new Map(Object.entries(o).map(([pid, v]) => [Number(pid), { roles: new Set(v.roles), tabs: new Set(v.tabs ?? []) }]))

describe('build: a tick\'s processes (A3.8 #4)', () => {
  const m0 = [metric(1, 'Browser', 10), metric(2, 'GPU', 5, 512 * 1024), metric(3, 'Utility', 1, 8 * 1024, undefined, 'Network Service'), metric(4, 'Tab', 2), metric(5, 'Tab', 3)]
  const own = owners({ 4: { roles: ['canvas'], tabs: ['t2', 't1'] }, 5: { roles: ['strip'] } })

  it('a first sample: every CPU null; types, names, roles, tabs; KB to MB once', () => {
    const b = build(m0, own, new Map(), 1000, new Map())
    expect(b.procs.every((p) => p.cpu === null)).toBe(true)
    expect(b.procs.map((p) => [p.pid, p.type, p.role])).toEqual([[1, 'browser', 'none'], [2, 'gpu', 'none'], [3, 'utility', 'none'], [4, 'renderer', 'canvas'], [5, 'renderer', 'strip']])
    expect(b.procs.find((p) => p.pid === 3)!.name).toBe('Network Service')
    expect(b.procs.find((p) => p.pid === 4)!.tabs).toEqual(['t1', 't2'])
    expect(b.procs.find((p) => p.pid === 2)!.rssMB).toBe(512)
    expect(b.gpu).toEqual({ pid: 2, born: 1_000_002, cpu: null, gpuProcessRssMB: 512 })
    expect([...b.baselines.keys()]).toEqual(m0.map((m) => procKey(m.pid, m.creationTime)))
  })

  it('5 s later, 0.25 s of CPU more: 0.05 cores; a reused pid is a new process, its CPU null, never negative', () => {
    const b0 = build(m0, own, new Map(), 1000, new Map())
    const m1 = [metric(1, 'Browser', 10.25), metric(4, 'Tab', 0.1, 100 * 1024, 9_999_999)]   // pid 4 again, born anew: its CPU went down
    const b1 = build(m1, own, b0.baselines, 6000, new Map())
    expect(b1.procs.find((p) => p.pid === 1)!.cpu).toBeCloseTo(0.05, 10)
    expect(b1.procs.find((p) => p.pid === 4)!.cpu).toBe(null)
    expect(b1.procs.every((p) => p.cpu === null || p.cpu >= 0)).toBe(true)
    // the gone ones are no baseline any more
    expect(b1.baselines.has(procKey(2, 1_000_002))).toBe(false)
  })

  it('no cumulative (optional in the typings): CPU null; no time passed: null; a metric listed twice counts once', () => {
    const b0 = build([metric(1, 'Browser', undefined)], new Map(), new Map(), 1000, new Map())
    const b1 = build([metric(1, 'Browser', undefined)], new Map(), b0.baselines, 6000, new Map())
    expect(b1.procs[0]!.cpu).toBe(null)
    const c0 = build([metric(1, 'Browser', 1)], new Map(), new Map(), 1000, new Map())
    expect(build([metric(1, 'Browser', 2)], new Map(), c0.baselines, 1000, new Map()).procs[0]!.cpu).toBe(null)
    expect(build([metric(7, 'Tab', 1), metric(7, 'Tab', 1)], new Map(), new Map(), 1, new Map()).procs).toHaveLength(1)
  })

  it('a renderer with two page kinds is mixed, one no page reads is unknown (both stay the app\'s own)', () => {
    const b = build([metric(8, 'Tab', 1), metric(9, 'Tab', 1)], owners({ 8: { roles: ['home', 'settings'] } }), new Map(), 1, new Map())
    expect(b.procs.map((p) => p.role)).toEqual(['mixed', 'unknown'])
    for (const p of b.procs) expect(inOwnSet(p, 'cpu')).toBe(true)
  })

  it('a canvas renderer\'s footprint is its preload\'s answer; any other process has none', () => {
    const b = build(m0, own, new Map(), 1, new Map([[4, 151.5], [5, 40]]))
    expect(b.procs.find((p) => p.pid === 4)!.footprintMB).toBe(151.5)
    expect(b.procs.find((p) => p.pid === 5)!.footprintMB).toBe(null)
  })
})

describe('canvas memory (A3.8 #41)', () => {
  const p = (pid: number, role: Role, tabs: string[], rssMB: number, footprintMB: number | null = null, cpu: number | null = 0.1): ProcSample =>
    ({ pid, born: pid, type: 'renderer', role, tabs, cpu, rssMB, footprintMB })
  it('a renderer of two tabs counted once in the sum and shared in each tab; an out-of-process iframe\'s for its tab; the GPU never', () => {
    const c = canvasMem([
      p(10, 'canvas', ['t1', 't2'], 300, 400),   // the two tabs' main frames
      p(11, 'canvas', ['t1'], 50),                // t1's OOPIF: RSS stands in
      p(12, 'strip', [], 60),
      { pid: 2, born: 2, type: 'gpu', role: 'none', tabs: [], cpu: 0, rssMB: 900, footprintMB: null },
    ])!
    expect(c.memMB).toBe(450)
    expect(c.byTab.t1).toEqual({ memMB: 450, cpu: 0.2, pids: [10, 11], shared: true })
    expect(c.byTab.t2).toEqual({ memMB: 400, cpu: 0.1, pids: [10], shared: true })
    expect(canvasMem([p(12, 'strip', [], 60)])).toBe(null)
  })
})

describe('the minute on disk (A3.8 #7)', () => {
  const sample = (mono: number, dt: number | null, cpu: number | null, rssMB: number, extra: Partial<Sample> = {}): Sample => ({
    ts: 1_761_000_000_000 + mono, mono, dt,
    procs: [{ pid: 1, born: 1, type: 'browser', role: 'none', tabs: [], cpu, rssMB, footprintMB: null }],
    gpu: null, pressure: { level: 1, availablePct: 60, at: 0 }, thermal: 'nominal', sys: { freeMB: 1000, purgeableMB: 10 }, visible: null, ...extra,
  })

  it('CPU exact over the minute\'s intervals (Δ cumulative / Δ monotonic), not the mean of the 5 s figures', () => {
    // uneven intervals: 1 s at 1 core, then 9 s at 0 cores - 1 core-second over 10 s is 0.1; a mean of means says 0.5
    const body = foldMinute([sample(0, null, null, 100), sample(1000, 1, 1, 110), sample(10_000, 9, 0, 120)], 3)!
    const p = body.procs[0]!
    expect(p.cpu.mean).toBeCloseTo(0.1, 6)
    expect(p.cpu.max).toBe(1)
    expect(p.cpu.last).toBe(0)
    expect(p.cpuTime).toEqual({ s: 1, ms: 10_000 })
    expect(p.rssMB).toEqual({ mean: 110, max: 120, last: 120 })
    expect(body.span).toBe(10_000)
    expect(body.n).toBe(3)
    expect(body.spawnMs).toBe(3)
  })

  it('pressure last and max, thermal, visible and sys the last sample\'s; a process seen once listed once', () => {
    const body = foldMinute([
      sample(0, 5, 0.01, 100, { pressure: { level: 2, availablePct: 30, at: 0 } }),
      sample(5000, 5, 0.01, 100, { pressure: null, thermal: 'fair' }),
    ], 0)!
    expect(body.pressure).toEqual({ last: null, max: 2 })
    expect(body.thermal).toBe('fair')
    expect(body.procs).toHaveLength(1)
    expect(body.canvases.memMB).toEqual({ mean: null, max: null, last: null })
    expect(foldMinute([], 0)).toBe(null)
  })

  it('the GPU process and the canvases per tab, CPU weighed by interval', () => {
    const s = (mono: number, dt: number, canvasCpu: number): Sample => ({
      ...sample(mono, dt, 0, 50),
      procs: [{ pid: 20, born: 20, type: 'renderer', role: 'canvas', tabs: ['t1'], cpu: canvasCpu, rssMB: 300, footprintMB: 350 }],
      gpu: { pid: 2, born: 2, cpu: 0.2, gpuProcessRssMB: 80 },
    })
    const body = foldMinute([s(0, 2, 1), s(8000, 8, 0)], 0)!
    expect(body.gpu).toEqual({ pid: 2, born: 2, cpu: { mean: 0.2, max: 0.2, last: 0.2 }, gpuProcessRssMB: { mean: 80, max: 80, last: 80 } })
    expect(body.canvases.memMB.mean).toBe(350)
    expect(body.canvases.byTab.t1!.cpu.mean).toBeCloseTo(0.2, 6)
    expect(body.procs[0]!.footprintMB).toEqual({ mean: 350, max: 350, last: 350 })
  })

  it('a baseline map survives a round trip: Baseline keeps cum undefined when the metric had none', () => {
    const b: Baseline = build([metric(1, 'Browser', undefined)], new Map(), new Map(), 5, new Map()).baselines.get(procKey(1, 1_000_001))!
    expect(b).toEqual({ mono: 5, cum: undefined })
  })
})
