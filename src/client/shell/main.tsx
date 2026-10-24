import { createRoot } from 'react-dom/client'
// an all-boards-locked build gives LockedApp.tsx in App.tsx's place: what only the canvas uses comes through it
import { App, ShellBoundary, startPerfRunProbe } from './App.tsx'
import { useStore } from './store.ts'
import { startRecorder } from './recorder.ts'
import { capturesPending, sealOnLeave } from './jam-capture.ts'
import { startAppBridge } from './app-bridge.ts'
import { startAppPerf } from './app-perf.ts'
import { applyInset } from './inset.ts'
import './styles.css'

// dev aid: inspectable store (harmless in builds; the canvas is a dev surface)
;(window as any).__sh = useStore
// what each board load does, from the page (spec 28 A1.7): before the first load; nothing on a published canvas
startRecorder({ capturesPending, sealCaptures: sealOnLeave })
// under the Mac app's transparent strip (0.27.2, A3.8 #31): --mv-top on :root before anything is placed; nothing
// anywhere else (Chrome, a published canvas, app 0.1)
applyInset()
// in the Mac app: hello, theme, busy and menu before the first render (spec 28 A2.9); nothing anywhere else
startAppBridge()
// in the Mac app 0.2: the recorder's probes and the board's frame count (spec 28 A3.8 #9, #16); nothing anywhere else
startAppPerf()
// a headless perf run (spec 28 A3.8 #17): what its driver reads and asks, through CDP - nothing without ?mvperfrun
startPerfRunProbe()

createRoot(document.getElementById('root')!).render(<ShellBoundary><App /></ShellBoundary>)
