/**
 * The shell's side of `mv:perf` (spec 28 A3.8 #9, #10, #16): what a 0.27.2 shell tells the Mac app's recorder -
 * its gestures (perf.ts's begin and end, the white-out detector's window), its probe answers (whiteout-probes.ts,
 * given by the canvas: `answerProbesWith`)
 * and its board's frame count at each commit. Inert unless `window.marverApp.perf` exists (app 0.2): in Chrome, on
 * a published canvas and inside app 0.1 nothing here sends, listens or runs a timer. The preload sends `mem` and
 * `shown` by itself; the shell never sees a `doc`.
 *
 * FROZEN signatures (A3.8 #53); the recorder stream fills them (the probes' geometry is the flash stream's
 * whiteout-probes.ts). Every message goes through `APP.perf` in a try: the app going away never breaks the page.
 *
 * As built: a gesture's `on` and `off` carry one `seq` (a new start while one is open ends it first, so main never
 * holds two); `board` is sent when the frame count or the sleeping count changed, read at each change of the board's
 * nodes and again at each gesture's end (frames fall asleep without the store moving), never more.
 */
import type { PerfMsg } from '../../shared/app-api.ts'
import { APP } from './marver-app.ts'
import { useStore } from './store.ts'
import { sleepingCount } from './canvas/sleep.ts'

/** Whether this page talks to the recorder at all. */
export const PERF_ON = typeof APP?.perf === 'function'

/** The white-out probes (whiteout-probes.ts' pick and verify), given by the canvas (Canvas.tsx): canvas code, never
 *  in an all-boards-locked bundle, whose shell has no canvas - an ask there goes unanswered, which main reads as an
 *  inconclusive sample, as it reads any probe answer that never came. */
export interface Probes { pick(tick: number): PerfMsg; verify(tick: number): PerfMsg }
let probes: Probes | null = null
/** Canvas.tsx, at import: the probes this page answers with. */
export function answerProbesWith(p: Probes): void { probes = p }

let started = false
let seq = 0
let open: number | null = null
let lastBoard = ''

/** The board now: its frames and how many sleep, sent when either changed. */
function boardNow(): void {
  try { boardChanged(useStore.getState().nodes.length, sleepingCount()) } catch { /* the page goes on */ }
}

/** main.tsx, after startAppBridge(): the probes' ask listener and the board subscription. Nothing without `APP.perf`. */
export function startAppPerf(): void {
  if (!PERF_ON || started) return
  started = true
  try {
    APP!.onPerfAsk?.((a) => {
      if (a.kind !== 'probes' || !probes) return
      try { sendPerf(a.at === 'before' ? probes.pick(a.tick) : probes.verify(a.tick)) } catch { /* no answer: main reads the sample as inconclusive */ }
    })
  } catch { /* the app's own */ }
  useStore.subscribe((s, prev) => { if (s.nodes !== prev.nodes) boardNow() })
  boardNow()
}

/** perf.ts's begin(): a gesture starts. */
export function gestureOn(type?: 'pan' | 'zoom' | 'layout'): void {
  if (!PERF_ON) return
  if (open !== null) gestureOff()
  seq = seq >= 2 ** 31 - 2 ? 1 : seq + 1
  open = seq
  sendPerf({ kind: 'gesture', on: true, seq, ...(type ? { type } : {}) })
}

/** perf.ts's end(): the gesture that started last ends. */
export function gestureOff(): void {
  if (!PERF_ON || open === null) return
  const s = open
  open = null
  sendPerf({ kind: 'gesture', on: false, seq: s })
  boardNow()
}

/** The board committed: its frame count and how many sleep. */
export function boardChanged(frames: number, asleep: number): void {
  if (!PERF_ON) return
  const k = `${frames}/${asleep}`
  if (k === lastBoard) return
  lastBoard = k
  sendPerf({ kind: 'board', frames, asleep })
}

/** The display's refresh rate main last said (`display` ask), for gesture records' `hz`; null until it says. */
export function displayHz(): number | null {
  try { return APP?.perfInfo?.().hz ?? null } catch { return null }
}

/** One message to the app, never throwing. */
export function sendPerf(p: PerfMsg): void {
  if (!PERF_ON) return
  try { APP!.perf!(p) } catch { /* the page goes on */ }
}
