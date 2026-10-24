/**
 * The perf-run contract between the shell and the server (spec 28 A3.4, A3.8 #17-#22): how a headless run names
 * itself, what its page may send, what the page tells the driver, and the one line a run writes to
 * `design/.local/perf/runs.jsonl`. `src/client/shell/perf-run.ts` and `src/server/perf-run.ts` re-export it, so the
 * two halves read one list.
 *
 * FROZEN before the A3 streams split (A3.8 #53); the headless stream fills both halves. Read-only is enforced
 * twice, before anything is sent: in the page (`mvFetch`'s barrier, a synthetic 403, counted as `refused`) and in
 * the server (`perfRunBarrier()` right after the workspace guard, refused and counted per run id as `forbidden`).
 * Stricter than A3.4's `/api/perf/*`: `perf/reload` and `perf/jam` would put headless documents into those logs.
 */
import type { HostProfile } from './machine.ts'

/** The script's version: a run line compares only with lines of the same script (A3.4). */
export const RUN_SCRIPT = 1 as const

/** A run's own generated id: the same in the URL, the request headers and the output line (A3.4). */
export const RUN_ID = /^[0-9a-f]{16}$/
/** The header every request of a run's page carries. */
export const RUN_HEADER = 'x-mv-perfrun'
/** The query parameter: on the shell's URL (`?mvperfrun=<id>`), and added by `withWs()` to frame URLs, the play stage and Jam pictures. */
export const RUN_PARAM = 'mvperfrun'
/** `&warm=1`: the unrecorded warm-up load - the recorder runs and posts nothing. */
export const WARM_PARAM = 'warm'

/**
 * The only mutating requests a run may make, under `${ROUTE}/api/` (A3.8 #17): its own page records, and the
 * sleep bakes - `POST /api/bakes` only fills a derived cache, so it is allowed and never counted (A3.4). GET and
 * HEAD always pass. `POST /api/poster` is refused for any run id, registered or not.
 */
export const RUN_ALLOWED: readonly { method: 'POST'; path: string }[] = [
  { method: 'POST', path: 'perf/page' },
  { method: 'POST', path: 'bakes' },
]

/** May a run send this? `apiPath` is the path under `${ROUTE}/api/` (no leading slash, no query), or null for any other path. */
export function allowedInRun(method: string, apiPath: string | null): boolean {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD') return true
  if (apiPath === null) return false
  return RUN_ALLOWED.some((a) => a.method === m && a.path === apiPath)
}

/**
 * The page's own bake work (A3.8 #18): four counts of their own - `sleep.pending` says nothing about idleness. The
 * run is bake-idle only when these four and the server's `jobsOf(run)` (queued, running) are all zero.
 */
export interface BakeWork {
  /** FrameNode's 250 ms timer and both retry timers, through one `scheduleSleep()` */
  scheduled: number
  /** a sleep from its entry to its `finally`: fonts, the ask, decode, texture install */
  running: number
  /** asks batched and not yet sent */
  queued: number
  /** the bake POST in flight */
  inflight: number
}

/** `window.__mvPerfRun.status()`, polled by the driver through CDP (A3.8 #17). */
export interface PerfRunStatus {
  run: string
  warm: boolean
  /** the load the recorder owns now */
  load: { id: string; state: 'requested' | 'committed' | 'settled' | 'cut'; reason?: string; sinceNav?: number } | null
  /** the page's four counts at zero (not the run's bake-idle: the server's jobs are the driver's to add) */
  bakeIdle: boolean
  bake: BakeWork
  /** the camera in flight */
  moving: boolean
  /** gestures ended so far (perf.ts) */
  gestures: number
  /** same-origin frames whose root says data-mv-poster-skipped */
  postersSkipped: number
  /** requests the page refused before sending */
  refused: number
}

/** `window.__mvPerfRun`, in perf mode only. */
export interface PerfRunProbe {
  status(): PerfRunStatus
  /** canvasCtl.fitAll(), then the camera idle (3 s at most) */
  fit(): Promise<boolean>
  /** the canvas element's client rect centre */
  centre(): { x: number; y: number }
  /** the recorder's outbox sent until empty: whether every batch landed */
  flush(): Promise<boolean>
}

/** Why a run is invalid: the first that holds, in this order (A3.8 #22). */
export const INVALID_REASONS = ['cancelled', 'crash', 'inputs', 'writes', 'cut', 'frames', 'errors', 'bakes', 'gesture', 'records'] as const
export type InvalidReason = (typeof INVALID_REASONS)[number]

/** One line of `design/.local/perf/runs.jsonl` (A3.4, A3.8 #22). */
export interface RunLine {
  v: 1
  script: typeof RUN_SCRIPT
  run: string
  /** 'app' is the later real-window run (A3.4's last bullet) */
  where: 'headless' | 'app'
  ts: number
  board: string
  /** the fingerprint at the start (A3.8 #21) - once the warm-up has loaded the board, so the files outside the root the
   *  watcher adds as a frame's imports load are in it: null when the watcher was not ready - the run is invalid 'inputs' */
  inputs: { hash: string; files: number } | null
  /** the same files' fingerprint after the end and the 300 ms wait */
  inputsEnd: string | null
  frames: number | null
  marver: string
  chrome: string
  flags: string[]
  /** SystemInfo.getInfo's feature status and device */
  renderer: { gpuCompositing?: string; rasterization?: string; vendor?: string; device?: string } | null
  /** the headless profile's hash */
  machine: string
  host: HostProfile
  power: 'ac' | 'battery' | 'unknown'
  slow: boolean
  /** the warm-up reached settled and bake-idle within 60 s */
  bakes: 'warm' | 'cold'
  postersMissing: number
  /** heights known at start */
  saved: { measuring: number; savedHeights: number } | null
  /** from navigation start: `load.sinceNav + settled.ms`, on the page's monotonic clock (A3.8 #20) */
  loadToSettledMs: number | null
  /** from A1's load request */
  settledMs: number | null
  moves: number
  lateMoves: number
  gestures: number
  p50: number | null
  p95: number | null
  /** null when no frame was timed (the review of a3-runs: widened from `number` - "not measured" is not "no slow
   *  frames"); a valid run always has it */
  over33ms: number | null
  /** Runtime.getHeapUsage at 1 Hz */
  heapPeakMB: number | null
  errors: number
  /** mutating requests the server refused for this run id */
  forbidden: number
  refusedInPage: number
  /** another run was registered at any moment of this one: never compared */
  overlapped: boolean
  valid: boolean
  invalidReason?: InvalidReason
  /** the cut's reason, when the load was cut - the recorder's (`timeout`, `hidden`, ...), or the driver's: `unresponsive`
   *  (a call to the page went unanswered for 15 s: its main thread stopped, a frame's script that never returns) and
   *  `overrun` (the run drove past its 7 minutes) */
  cut?: string
  /** the dev server restarted in place during the run (an .env or config edit): its inputs changed, and its stream
   *  ended - invalid `inputs`, never `cancelled` (A3.8 #22; added by the review of a3-runs) */
  restarted?: true
}

/**
 * `POST /api/perf/run` (work-token gated, A3.8 #22) answers NDJSON: headers at once, then these lines - a phase as
 * each starts, a heartbeat every 10 s (Node's fetch cuts a body silent for 300 s), one `line` per run, then `done`.
 * The body is read whole before a run registers; the response closing early cancels the run.
 */
export type RunStreamLine =
  | { phase: 'warm' | 'measured' | 'closing'; run: string }
  | { heartbeat: number }
  | { line: RunLine }
  | { done: true }
  | { error: string }

/** The request's body. `repeat` 1-5, 1 by default. */
export interface RunRequest { board: string; slow?: boolean; repeat?: number }
