/**
 * Process ownership and CPU math for the one sampler (spec 28 A3.1, A3.8 #4, #48, #49). Owner: the recorder stream.
 * Pure: no Electron at run time (its types only), unit-tested without it.
 *
 * A process is keyed by `(pid, creationTime)`: a reused pid is a new process. CPU is Δ`cumulativeCPUUsage` over Δ
 * monotonic time - `null` on a process's first sample and after a resume, never `percentCPUUsage`, whose interval
 * every caller shares. `rssMB` is `workingSetSize / 1024` (KB), once per process. Ownership comes from the tick's own
 * turn (recorder.ts reads each webContents' `getOSProcessId()` and, for a canvas, every `framesInSubtree` frame's
 * `osProcessId` through frames.ts's `safely()`), so out-of-process iframes count for their tab and a renderer of two
 * tabs is counted once. The budgets' process sets come from roles through `inOwnSet`, the one function.
 *
 * FROZEN (A3.8 #53): `procKey`, `Owners`, `Baseline`, `build`'s signature, `inOwnSet`.
 */
import type { ProcessMetric } from 'electron'
import type { ProcSample, ProcType, Role, Sample } from '../../../src/shared/app-perf.ts'

export type { ProcSample, ProcType, Role }

/** A process's key: pid and creation time. */
export const procKey = (pid: number, born: number): string => `${pid}:${born}`

/** What hosts a renderer, read in the tick's turn: the page kinds (a role each) and the tabs with any frame in it. */
export interface Owner { roles: Set<Exclude<Role, 'mixed' | 'none' | 'unknown'>>; tabs: Set<string> }
export type Owners = Map<number, Owner>

/** The last cumulative CPU seen of a process, on the monotonic clock. */
export interface Baseline { mono: number; cum: number | undefined }

export interface Built {
  procs: ProcSample[]
  gpu: Sample['gpu']
  /** the next tick's baselines: the processes alive now */
  baselines: Map<string, Baseline>
}

/**
 * One tick's processes from `getAppMetrics()`: types, roles, tabs, CPU against `prev`, RSS, and the canvas
 * renderers' footprints the preload answered (`footprints`: pid -> MB, each at most 10 s old, A3.8 #5).
 */
export function build(metrics: readonly ProcessMetric[], owners: Owners, prev: ReadonlyMap<string, Baseline>, mono: number, footprints: ReadonlyMap<number, number>): Built {
  void metrics; void owners; void prev; void mono; void footprints
  return { procs: [], gpu: null, baselines: new Map() }   // A3 recorder stream
}

/**
 * The budgets' sets (A3.8 #4, #48, #49): is this process the app's own?
 * - `cpu`: the browser, the GPU process, every utility process and every app-page renderer (Crashpad's handler is
 *   read from outside); a canvas renderer never - it is reported, not gated;
 * - `memory-no-canvas`: the same (the GPU process counted only on a run with no canvas open, Nic, 23 Oct);
 * - `memory-canvases`: the same without the GPU process, which is reported beside it.
 * A renderer whose role is unknown (a spare one) stays in the app's figure: it can fail a run, never pass one.
 */
export type OwnGate = 'cpu' | 'memory-no-canvas' | 'memory-canvases'
export function inOwnSet(p: Pick<ProcSample, 'type' | 'role'>, gate: OwnGate): boolean {
  if (p.type === 'gpu') return gate !== 'memory-canvases'
  if (p.type === 'renderer') return p.role !== 'canvas'
  return true
}
