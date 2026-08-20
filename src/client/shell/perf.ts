/**
 * B0.4: canvas performance instrumentation. Zero cost unless explicitly enabled.
 *
 * Enabled in dev, or in ANY build (incl. packed/published - the gate is dev AND
 * publish) via `?mvperf` in the URL or `localStorage.mvPerf==='1'`. So publish-side gate
 * measurement is possible without shipping an always-on probe.
 *
 * Two honest signals, sampled ONLY while a gesture is active (the `#sh-world.sh-gesturing`
 * class every gesture path already sets):
 *  - frame INTERVALS (rAF deltas). A healthy 60Hz frame is ~16.7ms, so the interval is NOT
 *    "main-thread work" - we report its p50/p95/max and, as the jank signal, `dropped` =
 *    intervals over 32ms (a missed refresh).
 *  - long-task durations (PerformanceObserver 'longtask', >50ms by spec) landing during a
 *    gesture: actual main-thread work that blew the budget. 0 long-tasks = smooth.
 *
 * Read it live:  __mvPerf.report()  /  __mvPerf.reset()
 * perfMark(name) + counters are the plug points Stages 2-3 use (blank-frame / warm-latency).
 */

// "in motion" = a pan/zoom/drag gesture OR a device-sweep/tidy preset animation - both are the
// windows where jank matters and the perf gate is measured.
const GESTURING = () => {
  const w = document.getElementById('sh-world')
  return !!w && (w.classList.contains('sh-camera') || w.classList.contains('sh-preset'))
}

const frames: number[] = []   // inter-frame intervals (ms) during gestures
const tasks: number[] = []    // long-task durations (ms) during gestures
const MAX = 1200
let last = 0
let raf = 0

const counters: Record<string, number> = { blankFrames: 0 }
const marks: { name: string; t: number }[] = []

const enabled = (): boolean => {
  if (import.meta.env.DEV) return true
  try {
    if (typeof location !== 'undefined' && /[?&]mvperf\b/.test(location.search)) return true
    return localStorage.getItem('mvPerf') === '1'
  } catch { return false }
}

const tick = (t: number) => {
  if (last && GESTURING()) { const dt = t - last; frames.push(dt); if (frames.length > MAX) frames.shift() }
  last = t
  raf = requestAnimationFrame(tick)
}

const pct = (sorted: number[], p: number): number => {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return Math.round(sorted[i] * 100) / 100
}
const top = (sorted: number[]): number => (sorted.length ? Math.round(sorted[sorted.length - 1] * 100) / 100 : 0)
const frac = (n: number, d: number): number => (d ? Math.round((n / d) * 1000) / 1000 : 0)

/** One-shot event later stages record (e.g. a blank frame, or warm-promotion latency). */
export const perfMark = (name: string): void => {
  counters[name] = (counters[name] ?? 0) + 1
  marks.push({ name, t: last })
  if (marks.length > 400) marks.shift()
}

/** Start the sampler. Idempotent; a no-op unless enabled() (dev, ?mvperf, or localStorage). */
export function startPerf(): void {
  if (raf || !enabled()) return
  raf = requestAnimationFrame(tick)
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (GESTURING()) { tasks.push(e.duration); if (tasks.length > MAX) tasks.shift() }
    })
    obs.observe({ type: 'longtask', buffered: false })
  } catch { /* longtask entry type unsupported (e.g. Safari) - frame intervals still sample */ }
  ;(window as unknown as { __mvPerf: unknown }).__mvPerf = {
    report() {
      const fi = [...frames].sort((a, b) => a - b)
      const tw = [...tasks].sort((a, b) => a - b)
      const dropped = fi.filter((d) => d > 32).length
      return {
        gestureFrames: fi.length,
        frameP50: pct(fi, 50), frameP95: pct(fi, 95), frameMax: top(fi),
        dropped, droppedFrac: frac(dropped, fi.length),
        // actual main-thread work during gestures (long tasks >50ms). 0 = smooth.
        longTasks: tw.length, longTaskP95: pct(tw, 95), longTaskMax: top(tw),
        counters: { ...counters },
      }
    },
    reset() { frames.length = 0; tasks.length = 0; marks.length = 0; for (const k in counters) counters[k] = 0 },
    marks: () => [...marks],
  }
}
