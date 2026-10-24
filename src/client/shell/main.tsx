import { createRoot } from 'react-dom/client'
import { App, ShellBoundary } from './App.tsx'
import { useStore } from './store.ts'
import { currentLoad, flush, startRecorder } from './recorder.ts'
import { capturesPending, sealOnLeave } from './jam-capture.ts'
import { startAppBridge } from './app-bridge.ts'
import { startAppPerf } from './app-perf.ts'
import { installPerfRunProbe, PERF_RUN, postersSkipped, refusedInPage } from './perf-run.ts'
import { bakeIdle, bakeWork } from './canvas/sleep.ts'
import { canvasCtl } from './canvas/ctl.ts'
import { gestureRunning, gesturesEnded } from './perf.ts'
import './styles.css'

// dev aid: inspectable store (harmless in builds; the canvas is a dev surface)
;(window as any).__sh = useStore
// what each board load does, from the page (spec 28 A1.7): before the first load; nothing on a published canvas
startRecorder({ capturesPending, sealCaptures: sealOnLeave })
// in the Mac app: hello, theme, busy and menu before the first render (spec 28 A2.9); nothing anywhere else
startAppBridge()
// in the Mac app 0.2: the recorder's probes and the board's frame count (spec 28 A3.8 #9, #16); nothing anywhere else
startAppPerf()
// a headless perf run (spec 28 A3.8 #17): what its driver reads and asks, through CDP - nothing without ?mvperfrun
if (PERF_RUN) {
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

createRoot(document.getElementById('root')!).render(<ShellBoundary><App /></ShellBoundary>)
