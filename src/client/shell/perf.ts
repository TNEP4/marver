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
import { gestureOff, gestureOn } from './app-perf.ts'
import { recorder } from './recorder.ts'
import { gestureStats } from './recorder-core.ts'
import { canvasCtl } from './canvas/ctl.ts'
import { frameByWindow } from './canvas/frame-registry.ts'
import { currentCmd } from './commands.ts'
import { fullRecorder } from '../recorder-level.ts'
import { keepLongest, pickLoafs, type LoafEntry } from './recorder-signals-core.ts'
import { useStore } from './store.ts'

const LOAF = typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes ?? []).includes('long-animation-frame')
const frames: number[] = []   // inter-frame intervals (ms) across gestures, for report()
const longs: number[] = []    // the long frames (or long tasks) that started inside a gesture, their durations (ms), for report()
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

interface Run {
  t0: number; last: number; dts: number[]; pan: boolean; zoom: boolean; layout: boolean; longs: number[]; obs?: PerformanceObserver; raf: number
  // spec 30 #34, #35: at the full level, the camera's scale over its frames, the longest frames, the command behind it
  scale?: { from: number; to: number; min: number; max: number }; top: LoafEntry[]; by?: string
}
const FULL = fullRecorder()
const scaleNow = (): number | undefined => { const s = canvasCtl.transform()?.s; return typeof s === 'number' && s > 0 ? s : undefined }
function readScale(run: Run): void {
  const s = FULL ? scaleNow() : undefined
  if (s === undefined) return
  if (!run.scale) { run.scale = { from: s, to: s, min: s, max: s }; return }
  run.scale.to = s
  if (s < run.scale.min) run.scale.min = s
  if (s > run.scale.max) run.scale.max = s
}
/** What a script's path or window names (#35): a frame's module, else the frame whose document ran it. */
function frameOf(src: string, win: unknown): string | undefined {
  const s = useStore.getState()
  const byPath = src ? s.manifest?.frames.find((f) => `/${f.file}` === src)?.id : undefined
  if (byPath) return byPath
  const reg = frameByWindow(win)
  return reg ? s.nodes.find((n) => n.key === reg.key)?.frame : undefined
}
const r3 = (x: number) => Math.round(x * 1000) / 1000
/** The command behind a layout animation (#34), read in the turn that starts it - the sampler hears of it a microtask
 *  later, from the observer, and a command's name lasts its turn - and kept only that long. */
let nextBy: string | undefined
export function noteGestureCmd(): void {
  if (!FULL) return
  nextBy = currentCmd()
  if (nextBy) queueMicrotask(() => queueMicrotask(() => { nextBy = undefined }))
}
/** the gesture running now */
let g: Run | null = null
/** gestures ended so far, every one (a headless perf run waits for each of its three, spec 28 A3.8 #20) */
let ended = 0
/** How many gestures have ended since the page loaded. */
export const gesturesEnded = (): number => ended
/** Is a gesture (a pan, a zoom, a layout animation) running now? */
export const gestureRunning = (): boolean => g !== null

function note(m: Motion) {
  if (!g) return
  if (m.camera) { if (document.body.classList.contains('sh-panning')) g.pan = true; else g.zoom = true }
  if (m.preset) g.layout = true
}

function begin(m: Motion) {
  const run: Run = { t0: performance.now(), last: 0, dts: [], pan: false, zoom: false, layout: false, longs: [], raf: 0, top: [], ...(FULL ? { by: nextBy ?? currentCmd() } : {}) }
  g = run
  note(m)
  readScale(run)
  // the Mac app's recorder hears it start (the white-out detector's window, spec 28 A3.8 #15); nothing elsewhere
  gestureOn(run.pan ? 'pan' : run.zoom ? 'zoom' : run.layout ? 'layout' : undefined)
  try {
    run.obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.startTime >= run.t0) { run.longs.push(e.duration); if (FULL) keepLongest(run.top, e as unknown as LoafEntry) } })
    run.obs.observe({ type: LOAF ? 'long-animation-frame' : 'longtask', buffered: false })
  } catch { /* neither entry type (Safari): the intervals still sample */ }
  // this gesture's own loop: a frame of an earlier one that is still queued finds another run and stops
  const tick = (t: number) => {
    if (g !== run) return
    if (run.last) run.dts.push(t - run.last)
    run.last = t
    readScale(run)
    run.raf = requestAnimationFrame(tick)
  }
  run.raf = requestAnimationFrame(tick)
}

function end() {
  const run = g!
  g = null
  ended++
  cancelAnimationFrame(run.raf)
  const t1 = performance.now()
  for (const e of run.obs?.takeRecords() ?? []) if (e.startTime >= run.t0 && e.startTime <= t1) { run.longs.push(e.duration); if (FULL) keepLongest(run.top, e as unknown as LoafEntry) }
  run.obs?.disconnect()
  gestureOff()
  for (const d of run.dts) { frames.push(d); if (frames.length > MAX) frames.shift() }
  for (const d of run.longs) { longs.push(d); if (longs.length > MAX) longs.shift() }
  if (run.dts.length < 2) return   // a press that never moved the camera
  readScale(run)
  const c = run.scale
  recorder.gesture({
    type: run.pan ? 'pan' : run.zoom ? 'zoom' : 'layout', ms: Math.round(t1 - run.t0), ...gestureStats(run.dts, run.longs.length),
    ...(c ? { scale: { from: r3(c.from), to: r3(c.to), min: r3(c.min), max: r3(c.max) } } : {}),
    ...(run.top.length ? { loaf: pickLoafs(run.top, frameOf) } : {}),
    ...(run.by ? { by: run.by } : {}),
  })
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
    // the intervals as they are, and the main thread's own work: long frames (> 50 ms) that started in a gesture,
    // how many, their p95 and the longest (the same nearest-rank rule)
    report() {
      const s = gestureStats(frames, longs.length), l = gestureStats(longs, 0)
      return { gestureFrames: s.frames, frameP50: s.p50, frameP95: s.p95, frameMax: s.max, over17ms: s.over17ms, over33ms: s.over33ms, longFrames: s.longFrames, longFrameP95: l.p95, longFrameMax: l.max, counters: { ...counters } }
    },
    reset() { frames.length = 0; longs.length = 0; marks.length = 0; for (const k in counters) counters[k] = 0 },
    marks: () => [...marks],
  }
}
