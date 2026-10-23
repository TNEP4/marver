import { createRoot } from 'react-dom/client'
import { App, ShellBoundary } from './App.tsx'
import { useStore } from './store.ts'
import { startRecorder } from './recorder.ts'
import { capturesPending, sealOnLeave } from './jam-capture.ts'
import { startAppBridge } from './app-bridge.ts'
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

createRoot(document.getElementById('root')!).render(<ShellBoundary><App /></ShellBoundary>)
