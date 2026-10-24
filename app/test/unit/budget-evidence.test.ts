/**
 * The CPU gate's evidence and figure (spec 28 A3.8 #49, r3 #2, r4 #1; review of a3-native, majors #8, minors #9,
 * #18), pure, over fixture app.jsonl lines and fixture passes: the window's lines whole, a canvas reloaded, navigated
 * to another process or unloaded inside it inconclusive - a single new-commit line included - and the cases the
 * window cannot vouch for; a canvas burning CPU taken out and reported apart; a handler that changed or a figure that
 * went down inconclusive; helpers that came and went between any two reads reported.
 */
import { describe, expect, it } from 'vitest'
import type { CpuPass } from '../harness/outside.ts'
import { cpuWindow } from '../harness/outside.ts'
import { churn, releaseEvidence } from '../budgets/evidence.ts'

const APP = 'a1b2c3d4e5f6'
const MIN = 60_000
const T = 1_800_000_000_000
type L = Record<string, unknown>
const env = (seq: number, ts: number, kind: string, body: L = {}): L => ({ v: 1, ts, kind, app: APP, seq, flavour: 'release', machine: null, ...body })
const sample = (seq: number, ts: number, canvas: { pid: number; born: number; tab: string; cpu?: number }[], app = 0.0005) => env(seq, ts, 'sample', {
  span: MIN, n: 12, procs: [
    { pid: 100, born: 1, type: 'browser', role: 'none', tabs: [], cpu: { mean: app, max: app, last: app } },
    ...canvas.map((c) => ({ pid: c.pid, born: c.born, type: 'renderer', role: 'canvas', tabs: [c.tab], cpu: { mean: c.cpu ?? 0.001, max: 0, last: 0 } })),
  ],
  gpu: { pid: 101, born: 1, cpu: { mean: 0, max: 0, last: 0 } }, spawnMs: 12,
})
const tab = (seq: number, ts: number, t: string, commit: number, main = { pid: 200, born: 5 }) => env(seq, ts, 'tab', { tab: t, ws: 'ab', commit, page: 'p1', state: 'ready', active: false, view: 'shown', main })
const C = [{ pid: 200, born: 5, tab: 't1' }]
/** a launch: start, the canvas tab's line before the window, a sample before it, `inside`, samples after */
function log(inside: (seq: number) => L[] = () => []): L[] {
  const out: L[] = [env(1, T, 'start', { version: '0.2.0', electron: '45.0.0', chrome: '0', recorder: true, pid: 100 }), tab(2, T + 1000, 't1', 3), sample(3, T + MIN, C)]
  const mid = inside(4)
  out.push(...mid)
  let seq = 4 + mid.length
  for (let k = 2; k <= 7; k++) out.push(sample(seq++, T + k * MIN, C))
  return out
}
const FROM = T + MIN + 5000, TO = T + 6 * MIN + 5000
const ev = (lines: L[]) => releaseEvidence(lines as never, FROM, TO, 'release')

describe('the release log\'s evidence (r4 #1)', () => {
  it('a whole window names its canvas renderers and gives the recorder\'s own figure', () => {
    const e = ev(log())
    if (e.why !== undefined) throw new Error(e.why)
    expect(e.canvas).toContainEqual({ pid: 200, born: 5 })
    expect(e.recorderCores).toBeCloseTo(0.0005, 6)
  })

  it('a canvas reloaded inside the window - one tab line with a new commit, nothing else - is inconclusive', () => {
    expect(ev(log((s) => [tab(s, T + 3 * MIN, 't1', 4)])).why).toMatch(/new document/)
  })

  it('a canvas navigated to another process inside the window is inconclusive, even at the same commit count', () => {
    expect(ev(log((s) => [tab(s, T + 3 * MIN, 't1', 3, { pid: 300, born: 9 })])).why).toMatch(/another process/)
  })

  it('a tab line that changes nothing of its document (its display state) is not evidence of a change', () => {
    expect(ev(log((s) => [{ ...tab(s, T + 3 * MIN, 't1', 3), state: 'hidden' }])).why).toBeUndefined()
  })

  it('a canvas unloaded, or gone, inside the window is inconclusive', () => {
    expect(ev(log((s) => [env(s, T + 3 * MIN, 'unload', { tab: 't1', phase: 'done', reason: 'warn' })])).why).toMatch(/unload line/)
    expect(ev(log((s) => [env(s, T + 3 * MIN, 'gone', { tab: 't1', role: 'canvas', pid: 200, born: 5, reason: 'crashed', exitCode: 1, ours: false, pressure: null })])).why).toMatch(/gone line/)
  })

  it('a canvas tab line inside the window with none before it to compare with is inconclusive', () => {
    const lines = log((s) => [tab(s, T + 3 * MIN, 't1', 3)]).filter((l) => !(l.kind === 'tab' && l.seq === 2))
    // seq 2 removed: renumber so the window stays whole
    lines.forEach((l, i) => { l.seq = i + 1 })
    expect(ev(lines).why).toMatch(/none before it/)
  })

  it('a seq gap, a dropped line, or no sample after the window is inconclusive', () => {
    const gap = log().filter((l) => l.seq !== 5)
    expect(ev(gap).why).toMatch(/seq gap/)
    expect(ev(log((s) => [env(s, T + 3 * MIN, 'dropped', { n: 4 })])).why).toBe('a dropped line')
    expect(releaseEvidence(log() as never, FROM, T + 20 * MIN, 'release').why).toMatch(/after it/)
  })

  it('the measured launch is the last start line: an earlier launch\'s lines are not its evidence', () => {
    const earlier = log().map((l) => ({ ...l, app: 'ffffffffffff', ts: (l.ts as number) - 60 * MIN }))
    expect(ev([...earlier, ...log()]).canvas).toBeTruthy()
    expect(ev([...log(), env(1, T + 8 * MIN, 'start', { version: '0.2.0', electron: '45.0.0', chrome: '0', recorder: true, pid: 999 })].map((l, i, a) => (i === a.length - 1 ? { ...l, app: 'eeeeeeeeeeee' } : l))).why).toMatch(/no sample line/)
  })
})

/** a pass: the browser, its children and the handler, each `[pid, startedAt s, cpu s]` */
const pass = (at: number, browser: number, children: [number, number, number][], handler: [number, number, number][] = [[50, 1, 0.01]]): CpuPass => ({
  at, browser: { pid: 100, startedAt: 1000, ownS: browser, childrenS: 0 },
  children: children.map(([pid, st, s]) => ({ pid, startedAt: st * 1000, ownS: s, childrenS: 0 })),
  handler: handler.map(([pid, st, s]) => ({ pid, startedAt: st * 1000, ownS: s, childrenS: 0 })),
  childPids: children.map(([p]) => p),
})

describe('the window\'s figure (r3 #2; review minors #9, #18)', () => {
  it('a hidden canvas burning a third of a core is taken out and reported apart; the app\'s own figure stays under the gate', () => {
    const a = pass(0, 1.0, [[200, 5, 10], [201, 5, 2]])
    const b = pass(300_000, 1.6, [[200, 5, 110], [201, 5, 2.3]])   // the canvas burned 100 s in 300 s
    const w = cpuWindow(a, b, (pid) => pid === 200)
    expect(w.kind).toBe('measured')
    expect(w.canvases).toEqual([{ pid: 200, seconds: 100 }])
    expect(w.cores).toBeCloseTo(0.9 / 300, 6)
    expect(w.cores).toBeLessThan(0.01)
  })

  it('Crashpad\'s handler that changed between the passes, or a figure that went down, is inconclusive - never passed', () => {
    const a = pass(0, 1.0, [], [[50, 1, 0.01]])
    expect(cpuWindow(a, pass(300_000, 1.1, [], [[51, 2, 0.0]]), () => false)).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('handler changed') })
    expect(cpuWindow(a, pass(300_000, 1.1, [], [[50, 1, 0.01], [52, 9, 0]]), () => false).kind).toBe('inconclusive')
    expect(cpuWindow(a, pass(300_000, 0.5, []), () => false)).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('not a CPU time') })
  })

  it('helpers that started and ended between two reads are reported, not only those that differ from first to last', () => {
    const s = (...p: number[]) => new Set(p)
    expect(churn([s(1, 2), s(1, 2, 9), s(1, 2)])).toEqual({ started: [9], ended: [9] })
    expect(churn([s(1, 2), s(1), s(1, 3)])).toEqual({ started: [3], ended: [2] })
    expect(churn([s(1)])).toEqual({ started: [], ended: [] })
  })
})
