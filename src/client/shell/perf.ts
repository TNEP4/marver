/**
 * Gesture timing (B0.4; spec 28 A1.7). Frame intervals are sampled ONLY while a gesture runs - a canvas pan or zoom
 * (`sh-camera` on #sh-world) or a layout animation (`sh-preset`) - and no frame is scheduled at rest: the camera
 * observer (canvas/camera-broadcast.ts) says when one starts and stops, and the rAF loop runs between the two. Each
 * gesture ends in one `gesture` record for the recorder (recorder.ts, dev only): the intervals as they are - p50,
 * p95, max, and the counts over 17 ms and over 33 ms - and the long animation frames that started inside it
 * (`longtask` entries where the browser has no long-animation-frame). No median-relative "missed" count: it would call
 * a steady half-rate gesture smooth.
 *
 * Sampled in dev, or in ANY build (a published one too) with `?mvperf` in the URL or `localStorage.mvPerf==='1'` - read
 * it live:  __mvPerf.report()  /  __mvPerf.reset()
 * perfMark(name) + counters are the plug points later stages use (blank-frame / warm-latency).
 */
import { onMotion, type Motion } from './canvas/camera-broadcast.ts'
import { recorder } from './recorder.ts'
import { gestureStats } from './recorder-core.ts'

const LOAF = typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes ?? []).includes('long-animation-frame')
const frames: number[] = []   // inter-frame intervals (ms) across gestures, for report()
const MAX = 1200

const counters: Record<string, number> = { blankFrames: 0 }
const marks: { name: string; t: number }[] = []

const enabled = (): boolean => {
  if (import.meta.env.DEV) return true
  try {
    if (typeof location !== 'undefined' && /[?&]mvperf\b/.test(location.search)) return true
    return localStorage.getItem('mvPerf') === '1'
  } catch { return false }
}

interface Run { t0: number; last: number; dts: number[]; pan: boolean; zoom: boolean; layout: boolean; long: number; obs?: PerformanceObserver; raf: number }
/** the gesture running now */
let g: Run | null = null

function note(m: Motion) {
  if (!g) return
  if (m.camera) { if (document.body.classList.contains('sh-panning')) g.pan = true; else g.zoom = true }
  if (m.preset) g.layout = true
}

function begin(m: Motion) {
  const run: Run = { t0: performance.now(), last: 0, dts: [], pan: false, zoom: false, layout: false, long: 0, raf: 0 }
  g = run
  note(m)
  try {
    run.obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.startTime >= run.t0) run.long++ })
    run.obs.observe({ type: LOAF ? 'long-animation-frame' : 'longtask', buffered: false })
  } catch { /* neither entry type (Safari): the intervals still sample */ }
  // this gesture's own loop: a frame of an earlier one that is still queued finds another run and stops
  const tick = (t: number) => {
    if (g !== run) return
    if (run.last) run.dts.push(t - run.last)
    run.last = t
    run.raf = requestAnimationFrame(tick)
  }
  run.raf = requestAnimationFrame(tick)
}

function end() {
  const run = g!
  g = null
  cancelAnimationFrame(run.raf)
  const t1 = performance.now()
  for (const e of run.obs?.takeRecords() ?? []) if (e.startTime >= run.t0 && e.startTime <= t1) run.long++
  run.obs?.disconnect()
  for (const d of run.dts) { frames.push(d); if (frames.length > MAX) frames.shift() }
  if (run.dts.length < 2) return   // a press that never moved the camera
  recorder.gesture({ type: run.pan ? 'pan' : run.zoom ? 'zoom' : 'layout', ms: Math.round(t1 - run.t0), ...gestureStats(run.dts, run.long) })
}

/** One-shot event later stages record (e.g. a blank frame, or warm-promotion latency). */
export const perfMark = (name: string): void => {
  counters[name] = (counters[name] ?? 0) + 1
  marks.push({ name, t: performance.now() })
  if (marks.length > 400) marks.shift()
}

let started = false
/** Watch for gestures. Idempotent; a no-op unless enabled() (dev, ?mvperf, or localStorage). */
export function startPerf(): void {
  if (started || !enabled()) return
  started = true
  onMotion((m) => {
    const moving = m.camera || m.preset
    if (moving && !g) begin(m)
    else if (!moving && g) end()
    else note(m)
  })
  ;(window as unknown as { __mvPerf: unknown }).__mvPerf = {
    report() {
      const s = gestureStats(frames, 0)
      return { gestureFrames: s.frames, frameP50: s.p50, frameP95: s.p95, frameMax: s.max, over17ms: s.over17ms, over33ms: s.over33ms, counters: { ...counters } }
    },
    reset() { frames.length = 0; marks.length = 0; for (const k in counters) counters[k] = 0 },
    marks: () => [...marks],
  }
}
