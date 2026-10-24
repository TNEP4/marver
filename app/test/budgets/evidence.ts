/**
 * The CPU gate's evidence from the release's own log (spec 28 A3.8 #49, r3 #2, r4 #1; review of a3-native, major #8),
 * pure: the measured launch's `app.jsonl` lines from the last `sample` before the window to the first after it, which
 * must be whole (`seq` contiguous, no `dropped` line, both bounding samples), and the canvas renderers they name.
 * Inconclusive, never passed, when a canvas renderer may have started or ended inside the window: a canvas tab's
 * `gone` or `unload`, or a `tab` line whose `commit` or main frame `(pid, born)` differs from the tab's last line
 * before the window (a reload, a navigation, a cross-process navigation) - a `tab` line is written only on a change,
 * so the comparison is with what the tab was before, never only between two lines inside. A canvas tab line inside
 * the window with no line before it to compare with is inconclusive too. Also the recorder's own figure, for the
 * cross-check against the outside one.
 */
import type { AppRecord } from '../../../src/shared/app-perf.ts'

type Line = AppRecord & Record<string, any>   // eslint-disable-line @typescript-eslint/no-explicit-any

export type Evidence =
  | { why: string; canvas?: undefined }
  | { canvas: { pid: number; born: number }[]; recorderCores: number | null; spawnMs: number; lines: number; why?: undefined }

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
  // the recorder's own figure: its minute lines inside the evidence (each covering the minute before its ts), CPU of
  // the processes it does not call canvas, and the GPU process's
  const minutes = span.filter((l) => l.kind === 'sample' && l.seq > before.seq)
  const secs = minutes.reduce((s, l) => s + (l.procs as { role: string; cpu: { mean: number | null } }[]).filter((p) => p.role !== 'canvas').reduce((a, p) => a + (p.cpu.mean ?? 0) * (l.span as number) / 1000, 0) + ((l.gpu as { cpu: { mean: number | null } } | null)?.cpu.mean ?? 0) * (l.span as number) / 1000, 0)
  const spanS = minutes.reduce((s, l) => s + (l.span as number) / 1000, 0)
  return { canvas, recorderCores: spanS ? secs / spanS : null, spawnMs: minutes.reduce((s, l) => s + ((l.spawnMs as number | undefined) ?? 0), 0), lines: span.length }
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
