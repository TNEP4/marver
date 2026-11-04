/**
 * #30: Vite's socket lost, and the canvas back - api.ts's two hooks, in a module of their own: api.ts sits under store.ts
 * and every stream module that reads the stores, so what it imports reaches nothing that imports it back at load.
 * `lost` queues `hmr {phase:'lost'}` when `vite:ws:disconnect` arrives; `back` is `resume()`'s: it writes `hmr
 * {phase:'back', downMs}` and waits at most `HMR_BACK_WAIT_MS` for it to go, before the page may reload itself. The
 * queue's own retries apply (#7): a server down longer than they last counts `lost` in a `dropped` record, and `back`'s
 * `downMs` still says how long.
 */
import { HMR_BACK_WAIT_MS } from '../../shared/perf-records.ts'
import { fullRecorder } from '../recorder-level.ts'
import { perfSeams } from './recorder-seams.ts'

let lostAt: number | null = null

/** `vite:ws:disconnect`. */
export function hmrLost(): void {
  try {
    if (!perfSeams.on || !fullRecorder() || lostAt !== null) return
    lostAt = performance.now()
    perfSeams.record('hmr', { phase: 'lost' })
  } catch { /* never in the way */ }
}

/** The canvas answered again (`resume()`): says so once per loss, and waits at most a second for it to go. Nothing to
 *  wait for when the socket was never lost. */
export async function hmrBack(): Promise<void> {
  try {
    if (!perfSeams.on || lostAt === null) return
    const downMs = Math.round(performance.now() - lostAt)
    lostAt = null
    perfSeams.record('hmr', { phase: 'back', downMs })
    // the recorder's flush, late-bound: recorder.ts imports this module's importer
    const sent = import('./recorder.ts').then((r) => r.flush()).catch(() => false)
    await Promise.race([sent, new Promise((r) => setTimeout(r, HMR_BACK_WAIT_MS))])
  } catch { /* never in the way */ }
}
