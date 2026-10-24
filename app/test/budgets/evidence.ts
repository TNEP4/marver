/**
 * The CPU gate's evidence from the release's own log (spec 28 A3.8 #49, r3 #2, r4 #1; review of a3-native, major #8),
 * pure: the measured launch's `app.jsonl` lines from the last `sample` before the window to the first after it, which
 * must be whole (`seq` contiguous, no `dropped` line, both bounding samples), and the canvas renderers they name.
 * Inconclusive, never passed, when a canvas renderer may have started or ended inside the window: a canvas tab's
 * `gone` or `unload`, or a `tab` line whose `commit` or main frame `(pid, born)` differs from the tab's last line
 * before the window (a reload, a navigation, a cross-process navigation) - a `tab` line is written only on a change,
 * so the comparison is with what the tab was before, never only between two lines inside. A canvas tab line inside
 * the window with no line before it to compare with is inconclusive too. Also the recorder's own figure, for the
 * cross-check against the outside one (`crossCheck`).
 */
import type { AppRecord } from '../../../src/shared/app-perf.ts'
import type { CpuPass, CpuRead, CpuWindow } from '../harness/outside.ts'

type Line = AppRecord & Record<string, any>   // eslint-disable-line @typescript-eslint/no-explicit-any

/** One process's CPU as the recorder counted it over its minute lines inside the window. */
export interface RecorderProc { pid: number; born: number; seconds: number; spanS: number }

export type Evidence =
  | { why: string; canvas?: undefined }
  | {
    canvas: { pid: number; born: number }[]
    /** the recorder's processes that are not canvases, the GPU process once (it is in `procs`; `gpu` repeats it) */
    recorder: RecorderProc[]
    /** the minute lines whose minute lies inside the window */
    minutes: number
    /** Σ of `recorder` over the minutes' span: reported, never compared (`crossCheck` compares like with like) */
    recorderCores: number | null
    spawnMs: number; lines: number; why?: undefined
  }

const sameMain = (a: { pid: number; born: number } | null | undefined, b: { pid: number; born: number } | null | undefined) =>
  (a?.pid ?? null) === (b?.pid ?? null) && Math.abs((a?.born ?? 0) - (b?.born ?? 0)) <= 1000

/** The evidence for a window [from, to] (epoch ms) of the launch whose `start` line is the last in the file. */
export function releaseEvidence(lines: readonly Line[], from: number, to: number, flavour: 'release' | 'dev'): Evidence {
  const start = [...lines].reverse().find((l) => l.kind === 'start' && l.flavour === flavour)
  if (!start) return { why: 'no start line' }
  const mine = lines.filter((l) => l.app === start.app && l.flavour === flavour).sort((a, b) => a.seq - b.seq)
  const samples = mine.filter((l) => l.kind === 'sample')
  const before = samples.filter((l) => l.ts <= from).at(-1)
  const after = samples.find((l) => l.ts >= to)
  if (!before || !after) return { why: `no sample line ${!before ? 'before the window' : 'after it'}` }
  const span = mine.filter((l) => l.seq >= before.seq && l.seq <= after.seq)
  for (let i = 1; i < span.length; i++) if (span[i]!.seq !== span[i - 1]!.seq + 1) return { why: `a seq gap at ${span[i - 1]!.seq}` }
  if (span.some((l) => l.kind === 'dropped')) return { why: 'a dropped line' }
  const canvasTabs = new Set(span.filter((l) => l.kind === 'sample').flatMap((l) => (l.procs as { role: string; tabs: string[] }[]).filter((p) => p.role === 'canvas').flatMap((p) => p.tabs)))
  // each canvas tab as its last line before the window left it
  const was = new Map<string, { commit?: number; main: { pid: number; born: number } | null }>()
  for (const l of mine) if (l.seq < before.seq && l.kind === 'tab') was.set(l.tab as string, { commit: l.commit as number | undefined, main: (l.main ?? null) as { pid: number; born: number } | null })
  for (const l of span) {
    if ((l.kind === 'gone' || l.kind === 'unload') && canvasTabs.has(l.tab as string)) return { why: `a canvas tab's ${l.kind} line inside the window` }
    if (l.kind === 'tab' && canvasTabs.has(l.tab as string)) {
      const w = was.get(l.tab as string)
      if (!w) return { why: `a canvas tab's line inside the window, with none before it to compare its document with` }
      if (w.commit !== l.commit) return { why: 'a canvas tab committed a new document inside the window (a reload or a navigation)' }
      if (!sameMain(w.main, l.main as { pid: number; born: number } | null)) return { why: 'a canvas tab\'s main frame moved to another process inside the window' }
      was.set(l.tab as string, { commit: l.commit as number | undefined, main: (l.main ?? null) as { pid: number; born: number } | null })
    }
  }
  const canvas = span.filter((l) => l.kind === 'sample').flatMap((l) => (l.procs as { pid: number; born: number; role: string }[]).filter((p) => p.role === 'canvas').map((p) => ({ pid: p.pid, born: p.born })))
  // the recorder's own figure (review of a3-native, minor #9): only the minute lines whose minute lies inside the
  // window (each covers the `span` ms before its ts), per process, the processes it does not call canvas - the GPU
  // process among them once: `procs` holds it, and `gpu` repeats it
  const minutes = span.filter((l) => l.kind === 'sample' && l.ts - (l.span as number) >= from && l.ts <= to)
  const per = new Map<string, RecorderProc>()
  for (const l of minutes) {
    for (const p of l.procs as { pid: number; born: number; role: string; cpu: { mean: number | null } }[]) {
      if (p.role === 'canvas' || p.cpu.mean === null) continue
      const k = `${p.pid}@${p.born}`
      const r = per.get(k) ?? { pid: p.pid, born: p.born, seconds: 0, spanS: 0 }
      r.seconds += p.cpu.mean * (l.span as number) / 1000
      r.spanS += (l.span as number) / 1000
      per.set(k, r)
    }
  }
  const recorder = [...per.values()]
  const spanS = minutes.reduce((s, l) => s + (l.span as number) / 1000, 0)
  return {
    canvas, recorder, minutes: minutes.length, recorderCores: spanS ? recorder.reduce((s, r) => s + r.seconds, 0) / spanS : null,
    spawnMs: minutes.reduce((s, l) => s + ((l.spawnMs as number | undefined) ?? 0), 0), lines: span.length,
  }
}

/** The cross-check's verdict: the two figures for the same processes, and how many were joined. */
export interface CrossCheck {
  kind: 'agree' | 'disagree' | 'unchecked'
  why?: string
  outsideCores: number
  recorderCores: number
  joined: number
  /** alive at both outside passes but in no minute line (or the reverse): left out of both sides */
  unjoined: { outside: number[]; recorder: number[] }
}

/**
 * The recorder against the outside figure, like with like (A3.8 #49, r3 #2; review of a3-native, minor #9): only the
 * processes alive at both outside passes (the browser and its children, never Crashpad's handler, which
 * getAppMetrics does not see), each one's own CPU (never the reaped children - the probes' sysctl and ioreg spawns,
 * which no process metric holds), joined to the recorder's by pid and a start time within 1 s of `born`; canvases
 * out of both. Each side's rate is Σ of its processes' own rates, so the windows need not be the same length. They
 * agree within 0.001 cores or 20 %; a disagreement says the recorder is broken (the harness's own error), and with no
 * minute line inside the window, or nothing joined, the check is not made.
 */
export function crossCheck(a: CpuPass, b: CpuPass, recorder: readonly RecorderProc[], canvas: (pid: number, startedAt: number) => boolean): CrossCheck {
  const key = (r: CpuRead) => `${r.pid}@${Math.round(r.startedAt / 1000)}`
  const at = (p: CpuPass) => new Map([...(p.browser ? [p.browser] : []), ...p.children].map((r) => [key(r), r]))
  const A = at(a), B = at(b)
  const spanS = (b.at - a.at) / 1000
  const both = [...B.entries()].filter(([k]) => A.has(k)).map(([k, r]) => ({ r, own: r.ownS - A.get(k)!.ownS })).filter(({ r }) => !canvas(r.pid, r.startedAt))
  const used = new Set<RecorderProc>()
  let outside = 0, rec = 0, joined = 0
  const lone: number[] = []
  for (const { r, own } of both) {
    const m = recorder.find((x) => x.pid === r.pid && Math.abs(x.born - r.startedAt) <= 1000 && !used.has(x))
    if (!m || !(m.spanS > 0)) { lone.push(r.pid); continue }
    used.add(m)
    joined++
    outside += own / spanS
    rec += m.seconds / m.spanS
  }
  const unjoined = { outside: lone, recorder: recorder.filter((x) => !used.has(x)).map((x) => x.pid) }
  if (!recorder.length) return { kind: 'unchecked', why: 'no recorder minute line inside the window', outsideCores: outside, recorderCores: rec, joined, unjoined }
  if (!joined || !(spanS > 0)) return { kind: 'unchecked', why: 'no process the recorder and the outside reads both saw through the window', outsideCores: outside, recorderCores: rec, joined, unjoined }
  const agree = Math.abs(rec - outside) <= Math.max(0.001, 0.2 * outside)
  return { kind: agree ? 'agree' : 'disagree', outsideCores: outside, recorderCores: rec, joined, unjoined }
}

/** Helpers seen to start or end between consecutive reads (an idle app should have none): the union over every pair. */
export function churn(seen: readonly ReadonlySet<number>[]): { started: number[]; ended: number[] } {
  const started = new Set<number>(), ended = new Set<number>()
  for (let i = 1; i < seen.length; i++) {
    for (const p of seen[i]!) if (!seen[i - 1]!.has(p)) started.add(p)
    for (const p of seen[i - 1]!) if (!seen[i]!.has(p)) ended.add(p)
  }
  return { started: [...started], ended: [...ended] }
}

/** The gate's verdict, and why when it is not one. */
export interface CpuGate { kind: 'pass' | 'fail' | 'inconclusive' | 'harness-error'; why?: string }

/**
 * The hidden-app CPU gate's verdict (A3.8 #49, r4 #1; code review r1 #3), in this order, each step only reached when
 * the one before it holds: the recorder's own log whole for the window (`releaseEvidence` without a `why`; else, or
 * none, inconclusive - in either flavour: a test hook naming the canvases is never the gate's evidence), the window's
 * figure measured (`cpuWindow`), the recorder's figure checked against the outside one and agreeing (`crossCheck`:
 * `unchecked` or none is inconclusive, `disagree` the harness's own error); only then the budget, pass or fail.
 * Missing evidence never passes and never fails: the roles it gives are what take the canvases out of the figure.
 */
export function cpuGate(o: { ev: Evidence | null; win?: CpuWindow | null; cross?: CrossCheck | null; budget: number }): CpuGate {
  if (!o.ev || o.ev.why !== undefined) return { kind: 'inconclusive', why: `the recorder's log does not prove the roles: ${o.ev?.why ?? 'no sample line (the recorder wrote none)'}` }
  if (!o.win) return { kind: 'inconclusive', why: 'the window was not measured' }
  if (o.win.kind !== 'measured') return { kind: 'inconclusive', why: o.win.why ?? 'the window was not measured' }
  if (!o.cross || o.cross.kind === 'unchecked') return { kind: 'inconclusive', why: `the recorder's figure was not checked against the outside one: ${o.cross?.why ?? 'no cross-check'}` }
  if (o.cross.kind === 'disagree') return { kind: 'harness-error', why: `the recorder's figure ${o.cross.recorderCores.toFixed(5)} and the outside one ${o.cross.outsideCores.toFixed(5)} for the same ${o.cross.joined} processes disagree: the recorder is broken (it cannot pass itself)` }
  return { kind: o.win.cores < o.budget ? 'pass' : 'fail' }
}
