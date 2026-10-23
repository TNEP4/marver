/**
 * Headless perf runs, the server's half (spec 28 A3.4, A3.8 #17-#22): the run registry, the barrier, and the
 * driver of script 1 in the canvas's own headless Chrome (cdp.ts's `Browser`, never `shootFrame()`, which makes
 * posters on purpose). Owner: the headless stream. The contract with the page is src/shared/perf-run.ts.
 *
 * - `perfRunBarrier()`, mounted right after the workspace guard (plugin.ts), **refuses and counts** any other
 *   mutating request whose run id it finds: the `x-mv-perfrun` header, else the `Referer`'s query (a frame's own
 *   fetch; best effort). Counts are per run id. `POST /api/poster` is refused for any run id, registered or not.
 * - The server, never the page, stamps `run` on a run's records (perf.ts `logPage(root, raws, { run })`).
 * - `POST /api/perf/run` reads the whole body before it registers a run; from then on the run is cancelled when the
 *   response closes before it finished (`res.on('close')` with `res.writableFinished` false), never `req.on('close')`.
 *
 * FROZEN (A3.8 #53): `RunReg`, `runs`, `runIdOf`, `perfRunBarrier`, `runOnce`'s signature, `RUN_T`. The registry
 * and the barrier are built; the driver is the headless stream's to fill.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ROUTE } from '../cli/name.ts'
import { allowedInRun, RUN_HEADER, RUN_ID, RUN_PARAM, type RunLine, type RunStreamLine } from '../shared/perf-run.ts'

export * from '../shared/perf-run.ts'

/** The driver's durations (A3.4, A3.8 #20, #22); overridable only when `MARVER_SLOT_BASE` is set (the tests' marker). */
export const RUN_T = {
  warmMs: 60_000,
  settleMs: 120_000,
  bakeIdleMs: 30_000,
  gestureEndMs: 5000,
  fitIdleMs: 3000,
  eventMs: 16,
  pauseMs: 500,
  heapMs: 1000,
  statusMs: 100,
  watcherLagMs: 300,
  watcherReadyMs: 30_000,
  heartbeatMs: 10_000,
} as const

/** A run while it is registered. */
export interface RunReg {
  id: string
  board: string
  startedAt: number
  phase: 'warm' | 'measured' | 'closing'
  /** mutating requests refused for this id, and the first ten of them (`METHOD /path`) */
  forbidden: number
  forbiddenPaths: string[]
  /** the first watched path that changed while registered: sticky, even if the file is restored (A3.8 #21) */
  inputsChanged: string | null
  /** its cleaned page records, as logPage kept them (bounded) */
  records: Record<string, unknown>[]
  /** another run was registered at some moment of this one */
  overlapped: boolean
}

const RECORDS_MAX = 20_000
const live = new Map<string, RunReg>()

/** Module state, so Vite's in-place restart keeps it (A3.8 #22). */
export const runs = {
  /** a new run with its own id */
  register(board: string, id: string): RunReg {
    if (!RUN_ID.test(id)) throw new Error('perf-run: a run id is 16 hex')
    const reg: RunReg = { id, board, startedAt: Date.now(), phase: 'warm', forbidden: 0, forbiddenPaths: [], inputsChanged: null, records: [], overlapped: live.size > 0 }
    for (const other of live.values()) other.overlapped = true
    live.set(id, reg)
    return reg
  },
  get: (id: string): RunReg | undefined => live.get(id),
  /** the run ends: unregistered, and handed back for its line */
  end(id: string): RunReg | undefined { const r = live.get(id); live.delete(id); return r },
  /** a mutating request refused for `id` (an unregistered id counts nowhere) */
  forbidden(id: string, what: string): void {
    const r = live.get(id)
    if (!r) return
    r.forbidden += 1
    if (r.forbiddenPaths.length < 10) r.forbiddenPaths.push(what)
  },
  /** a watched file changed: every registered run's sticky flag */
  changed(file: string): void { for (const r of live.values()) r.inputsChanged ??= file },
  /** a run's cleaned records (perf.ts logPage's `kept`) */
  records(id: string, recs: Record<string, unknown>[]): void {
    const r = live.get(id)
    if (!r) return
    for (const x of recs) { if (r.records.length >= RECORDS_MAX) break; r.records.push(x) }
  },
  active: (): RunReg[] => [...live.values()],
}

/** A request's run id: the header, else `mvperfrun` in the Referer's query; null when it names none. */
export function runIdOf(req: Pick<IncomingMessage, 'headers'>): string | null {
  const h = req.headers[RUN_HEADER]
  const head = Array.isArray(h) ? h[0] : h
  if (typeof head === 'string' && RUN_ID.test(head)) return head
  const ref = req.headers.referer
  if (typeof ref !== 'string') return null
  try {
    const id = new URL(ref).searchParams.get(RUN_PARAM)
    return id && RUN_ID.test(id) ? id : null
  } catch { return null }
}

type Next = (err?: unknown) => void

/** The server's barrier (A3.8 #17), right after the workspace guard: a run's mutating request outside the allowed list is refused (403) and counted. */
export function perfRunBarrier(): (req: IncomingMessage, res: ServerResponse, next: Next) => void {
  return (req, res, next) => {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
    const id = runIdOf(req)
    if (!id) return next()
    let path = '/'
    try { path = new URL(req.url ?? '/', 'http://x').pathname } catch { /* refused below */ }
    const base = `${ROUTE}/api/`
    const api = path.startsWith(base) ? path.slice(base.length) : null
    if (allowedInRun(method, api)) return next()
    runs.forbidden(id, `${method} ${path}`)
    res.statusCode = 403
    res.setHeader('content-type', 'application/json')
    res.setHeader(RUN_HEADER, 'refused')
    res.end('{"error":"a perf run is read-only"}')
  }
}

/** What one run needs. `progress` writes a stream line; `signal` is the response closing early. */
export interface RunOptions {
  root: string
  /** the dev server's own origin, as the shell is served */
  origin: string
  board: string
  slow: boolean
  signal: AbortSignal
  progress(l: RunStreamLine): void
}

/** One run of script 1: the warm-up, the measured load and its three gestures, the line (A3.8 #20). The headless stream fills it. */
export async function runOnce(o: RunOptions): Promise<RunLine> {
  void o
  throw new Error('perf-run: the driver is not built yet (spec 28 A3.8 #20)')
}
