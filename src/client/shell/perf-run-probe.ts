/**
 * A headless perf run's probe (spec 28 A3.8 #17): what its driver reads and asks, through CDP - nothing without
 * ?mvperfrun. Canvas code (the camera, the gestures, the sleeps): main.tsx reaches it through App.tsx, so an
 * all-boards-locked bundle, which the build gives LockedApp.tsx in App.tsx's place, carries none of it - a run's page
 * is always a dev canvas, never a locked one.
 */
import { currentLoad, flush } from './recorder.ts'
import { installPerfRunProbe, PERF_RUN, postersSkipped, refusedInPage } from './perf-run.ts'
import { bakeIdle, bakeWork } from './canvas/sleep.ts'
import { canvasCtl } from './canvas/ctl.ts'
import { gestureRunning, gesturesEnded } from './perf.ts'

/** main.tsx, after startAppPerf(): the probe, installed only on a run's page. */
export function startPerfRunProbe(): void {
  if (!PERF_RUN) return
  const run = PERF_RUN
  const moving = () => gestureRunning() || canvasCtl.cameraBusy()
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  installPerfRunProbe({
    status: () => ({ run: run.id, warm: run.warm, load: currentLoad(), bakeIdle: bakeIdle(), bake: bakeWork(), moving: moving(), gestures: gesturesEnded(), postersSkipped: postersSkipped(), refused: refusedInPage() }),
    // the whole board, then the camera still (two looks 50 ms apart), 3 s at most
    async fit() {
      canvasCtl.fitAll()
      const by = performance.now() + 3000
      for (let still = 0; performance.now() < by; await wait(50)) if (moving()) still = 0; else if (++still >= 2) return true
      return false
    },
    centre() {
      const r = document.querySelector('.sh-canvas')?.getBoundingClientRect()
      return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) }
    },
    flush,
  })
}
