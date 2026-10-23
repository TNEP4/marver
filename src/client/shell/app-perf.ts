/**
 * The shell's side of `mv:perf` (spec 28 A3.8 #9, #10, #16): what a 0.27.2 shell tells the Mac app's recorder -
 * its gestures (perf.ts's begin and end, the white-out detector's window), its probe answers (whiteout-probes.ts)
 * and its board's frame count at each commit. Inert unless `window.marverApp.perf` exists (app 0.2): in Chrome, on
 * a published canvas and inside app 0.1 nothing here sends, listens or runs a timer. The preload sends `mem` and
 * `shown` by itself; the shell never sees a `doc`.
 *
 * FROZEN signatures (A3.8 #53); the recorder stream fills them (the probes' geometry is the flash stream's
 * whiteout-probes.ts). Every message goes through `APP.perf` in a try: the app going away never breaks the page.
 */
import type { PerfMsg } from '../../shared/app-api.ts'
import { APP } from './marver-app.ts'

/** Whether this page talks to the recorder at all. */
export const PERF_ON = typeof APP?.perf === 'function'

/** main.tsx, after startAppBridge(): the probes' ask listener and the board subscription. Nothing without `APP.perf`. */
export function startAppPerf(): void {
  if (!PERF_ON) return
  // A3 recorder stream: APP.onPerfAsk -> pick()/verify() (whiteout-probes.ts); a store subscription -> boardChanged()
}

/** perf.ts's begin(): a gesture starts. */
export function gestureOn(type?: 'pan' | 'zoom' | 'layout'): void { void type }

/** perf.ts's end(): the gesture that started last ends. */
export function gestureOff(): void {}

/** The board committed: its frame count and how many sleep. */
export function boardChanged(frames: number, asleep: number): void { void frames; void asleep }

/** The display's refresh rate main last said (`display` ask), for gesture records' `hz`; null until it says. */
export function displayHz(): number | null {
  try { return APP?.perfInfo?.().hz ?? null } catch { return null }
}

/** One message to the app, never throwing. */
export function sendPerf(p: PerfMsg): void {
  if (!PERF_ON) return
  try { APP!.perf!(p) } catch { /* the page goes on */ }
}
