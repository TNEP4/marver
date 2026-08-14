/**
 * B0.4: canvas performance instrumentation (dev-only, zero cost in published builds).
 *
 * The SPEC-M4 gate is stated in frame-time: p95 main-thread work < 16 ms per animation
 * frame while panning/zooming a heavy board. This samples exactly that - inter-frame
 * deltas recorded ONLY while a gesture is active (the `#sh-world.sh-gesturing` class,
 * which every gesture path already sets), so idle time never pollutes the numbers and
 * we don't wire a probe into each of pan/zoom/drag/sweep separately.
 *
 * Read it live from the console or a headless check:
 *   __mvPerf.report()  -> { frames, p50, p95, max, long16, longFrac }
 *   __mvPerf.reset()
 *
 * Blank-frame and warm-latency counters are stubs here (nothing blanks or warms until the
 * snapshot facade / working set land in Stages 2-3); they hang off the same object so later
 * stages plug in without a new surface. `perfMark(name)` is the one-shot they'll call.
 */

const GESTURING = () => document.getElementById('sh-world')?.classList.contains('sh-gesturing') ?? false

const deltas: number[] = []   // gesturing-frame deltas (ms), ring-buffered
const MAX = 1200
let last = 0
let raf = 0

const counters: Record<string, number> = { blankFrames: 0 }
const marks: { name: string; t: number }[] = []

const tick = (t: number) => {
  if (last) {
    const dt = t - last
    if (GESTURING()) { deltas.push(dt); if (deltas.length > MAX) deltas.shift() }
  }
  last = t
  raf = requestAnimationFrame(tick)
}

const pct = (sorted: number[], p: number): number => {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return Math.round(sorted[i] * 100) / 100
}

/** One-shot event later stages record (e.g. a blank frame, or warm-promotion latency). */
export const perfMark = (name: string): void => {
  counters[name] = (counters[name] ?? 0) + 1
  marks.push({ name, t: last })
  if (marks.length > 400) marks.shift()
}

/** Start the dev sampler. Idempotent; a no-op in production builds. */
export function startPerf(): void {
  if (raf || !import.meta.env.DEV) return
  raf = requestAnimationFrame(tick)
  ;(window as unknown as { __mvPerf: unknown }).__mvPerf = {
    report() {
      const a = [...deltas].sort((x, y) => x - y)
      const long = a.filter((d) => d > 16).length
      return {
        frames: a.length,
        p50: pct(a, 50),
        p95: pct(a, 95),
        max: a.length ? Math.round(a[a.length - 1] * 100) / 100 : 0,
        long16: long,
        longFrac: a.length ? Math.round((long / a.length) * 1000) / 1000 : 0,
        counters: { ...counters },
      }
    },
    reset() { deltas.length = 0; marks.length = 0; for (const k in counters) counters[k] = 0 },
    marks: () => [...marks],
  }
}
