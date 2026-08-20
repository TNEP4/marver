import { createRoot } from 'react-dom/client'
import { App, ShellBoundary } from './App.tsx'
import { useStore } from './store.ts'
import './styles.css'

// dev aid: inspectable store (harmless in builds; the canvas is a dev surface)
;(window as any).__sh = useStore

createRoot(document.getElementById('root')!).render(<ShellBoundary><App /></ShellBoundary>)
