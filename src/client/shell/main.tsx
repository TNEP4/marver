import { createRoot } from 'react-dom/client'
import { App, ShellBoundary } from './App.tsx'
import { useStore } from './store.ts'
import { startRecorder } from './recorder.ts'
import { capturesPending, sealOnLeave } from './jam-capture.ts'
import './styles.css'

// dev aid: inspectable store (harmless in builds; the canvas is a dev surface)
;(window as any).__sh = useStore
// what each board load does, from the page (spec 28 A1.7): before the first load; nothing on a published canvas
startRecorder({ capturesPending, sealCaptures: sealOnLeave })

createRoot(document.getElementById('root')!).render(<ShellBoundary><App /></ShellBoundary>)
