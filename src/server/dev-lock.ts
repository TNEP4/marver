/**
 * One canvas per folder (#19, spec 27 Part 7). `marver dev` takes design/.local/dev.lock before it
 * starts the server, so a second `marver dev` in the same folder says where the first one runs
 * instead of taking over dev.json (which the CLI - `work`, `shot`, `comments new --on` - reads to
 * find the canvas).
 *
 * The rules, none of which guess a holder dead from time or from an unanswered request:
 * - no lock: create it exclusively. Done.
 * - a lock whose pid runs: a canvas runs here (a slow or paused one too) - stop with its link.
 * - a lock whose pid is dead: reclaim it while holding dev.lock.reclaim (also exclusive): read it
 *   again, still the same dead holder -> replace it. A reclaim lock already there means another
 *   start is reclaiming: wait a second and start over once; still there -> fail closed.
 * - a 0.25 server writes no lock and no pid: dev.json without a lock is decided by binding its port.
 *
 * Both files are created by linking a fully written temp file into place, so a reader never sees
 * an empty or half-written lock - `link` fails if the name exists, which is the exclusive create.
 * The file rules themselves live in exclusive.ts (spec 28 A1.2), shared with the slot files; this
 * module keeps the lock's words and the 0.25 check.
 */
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pidRuns, portInUse, readJson, releaseExclusive, takeExclusive, type Holder } from './exclusive.ts'

// the shared primitives (spec 28 A1.2) - re-exported for the callers and tests that import them from here
export { createExclusive, pidRuns, portInUse, type Holder } from './exclusive.ts'
export type Taken = { ok: true; instance: string; release(): void } | { ok: false; message: string }

const localDir = (root: string) => join(root, 'design', '.local')
const lockPath = (root: string) => join(localDir(root), 'dev.lock')
const infoPath = (root: string) => join(localDir(root), 'dev.json')

const runsHere = (root: string): string => {
  const port = (readJson(infoPath(root)) as { port?: unknown } | null | undefined)?.port
  return typeof port === 'number' ? `a canvas already runs here: http://localhost:${port} - open it, or stop it first`
    : 'a canvas already runs here - open it, or stop it first'
}
export const RECLAIM_STUCK = 'a canvas is starting here, or a start crashed: delete design/.local/dev.lock.reclaim if no canvas runs'

export interface TakeOptions {
  /** How long to wait for another start's reclaim before trying once more (tests shorten it). */
  reclaimWaitMs?: number
  pid?: number
  /** Called with the release the moment the lock is ours - before the 0.25 check below awaits - so a
   *  signal that lands in between still gives it back (spec 28 A1.1). */
  onTaken?: (release: () => void) => void
}

/** Take the folder's canvas lock. On success the caller owns dev.lock until `release()` (which
 *  removes it only while it still names this instance). */
export async function takeDevLock(root: string, opts: TakeOptions = {}): Promise<Taken> {
  mkdirSync(localDir(root), { recursive: true })
  const me: Holder = { pid: opts.pid ?? process.pid, instance: randomUUID(), at: Date.now() }
  const r = await takeExclusive(lockPath(root), me, JSON.stringify(me), { reclaimWaitMs: opts.reclaimWaitMs })
  if (!r.ok) {
    return { ok: false, message: r.why === 'held' ? runsHere(root)
      : r.why === 'unreadable' ? 'design/.local/dev.lock is unreadable: delete it if no canvas runs' : RECLAIM_STUCK }
  }
  opts.onTaken?.(r.release)
  // a canvas started by 0.25 holds no lock: dev.json is the only trace. A pid in it decides; without
  // one, the port does - in use, something answers there; free, the file is stale.
  const info = readJson(infoPath(root)) as { port?: unknown; pid?: unknown; instance?: unknown } | null | undefined
  if (info && info.instance !== me.instance) {
    const live = typeof info.pid === 'number' ? pidRuns(info.pid)
      : typeof info.port === 'number' ? await portInUse(info.port) : false
    if (live) {
      r.release()
      return { ok: false, message: `${runsHere(root)}${typeof info.pid === 'number' ? '' : ' (or delete design/.local/dev.json if it is not)'}` }
    }
  }
  return { ok: true, instance: me.instance, release: r.release }
}

/** Remove dev.lock if it still names `instance` - a lock some other start took over stays. */
export function releaseDevLock(root: string, instance: string): void {
  releaseExclusive(lockPath(root), instance)
}
