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
 */
import { createServer } from 'node:net'
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'

export interface Holder { pid: number; instance: string; at: number }
export type Taken = { ok: true; instance: string; release(): void } | { ok: false; message: string }

const localDir = (root: string) => join(root, 'design', '.local')
const lockPath = (root: string) => join(localDir(root), 'dev.lock')
const reclaimPath = (root: string) => `${lockPath(root)}.reclaim`
const infoPath = (root: string) => join(localDir(root), 'dev.json')

/** Is this pid a running process? EPERM means it runs under another user - still running. A
 *  process paused with SIGSTOP runs too, as far as this is concerned. */
export function pidRuns(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Create `file` holding `body`, failing with EEXIST if it is there - atomically, content included. */
export function createExclusive(file: string, body: string): void {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  try { linkSync(tmp, file) } finally { try { unlinkSync(tmp) } catch { /* gone */ } }
}

const readJson = (file: string): unknown | undefined => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null   // null: there, unreadable
  }
}
const asHolder = (v: unknown): Holder | null => {
  const h = v as Partial<Holder> | null
  return h && typeof h.pid === 'number' && typeof h.instance === 'string' ? { pid: h.pid, instance: h.instance, at: Number(h.at) || 0 } : null
}

/** Is anything listening on `port` on this machine? Vite binds ::1 for `localhost`, an older or
 *  configured one 127.0.0.1 - a port is in use if either refuses the bind. */
export async function portInUse(port: number): Promise<boolean> {
  const bind = (host: string) => new Promise<boolean>((res) => {
    const s = createServer()
    s.once('error', (err: NodeJS.ErrnoException) => res(err.code === 'EADDRINUSE' || err.code === 'EACCES'))
    s.once('listening', () => s.close(() => res(false)))
    s.listen(port, host)
  })
  return (await bind('127.0.0.1')) || (await bind('::1'))
}

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
}

/** Take the folder's canvas lock. On success the caller owns dev.lock until `release()` (which
 *  removes it only while it still names this instance). */
export async function takeDevLock(root: string, opts: TakeOptions = {}): Promise<Taken> {
  mkdirSync(localDir(root), { recursive: true })
  const me: Holder = { pid: opts.pid ?? process.pid, instance: randomUUID(), at: Date.now() }
  const body = JSON.stringify(me)
  const release = () => releaseDevLock(root, me.instance)
  const won = async (): Promise<Taken> => {
    // a canvas started by 0.25 holds no lock: dev.json is the only trace. A pid in it decides; without
    // one, the port does - in use, something answers there; free, the file is stale.
    const info = readJson(infoPath(root)) as { port?: unknown; pid?: unknown; instance?: unknown } | null | undefined
    if (info && info.instance !== me.instance) {
      const live = typeof info.pid === 'number' ? pidRuns(info.pid)
        : typeof info.port === 'number' ? await portInUse(info.port) : false
      if (live) {
        release()
        return { ok: false, message: `${runsHere(root)}${typeof info.pid === 'number' ? '' : ' (or delete design/.local/dev.json if it is not)'}` }
      }
    }
    return { ok: true, instance: me.instance, release }
  }

  for (let round = 0; round < 2; round++) {
    try { createExclusive(lockPath(root), body); return await won() } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const raw = readJson(lockPath(root))
    if (raw === undefined) continue   // released between the create and the read - try again
    const holder = asHolder(raw)
    if (!holder) return { ok: false, message: 'design/.local/dev.lock is unreadable: delete it if no canvas runs' }
    if (pidRuns(holder.pid)) return { ok: false, message: runsHere(root) }
    // a dead holder: reclaim it, one starter at a time
    try { createExclusive(reclaimPath(root), body) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (round === 0) { await new Promise((r) => setTimeout(r, opts.reclaimWaitMs ?? 1000)); continue }
      return { ok: false, message: RECLAIM_STUCK }
    }
    try {
      const again = asHolder(readJson(lockPath(root)))
      if (again && again.pid === holder.pid && again.instance === holder.instance) {
        unlinkSync(lockPath(root))
        try { createExclusive(lockPath(root), body); return await won() } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
          // a fresh start took the free name in between: it is the canvas now
        }
      }
    } finally { try { unlinkSync(reclaimPath(root)) } catch { /* gone */ } }
    // the lock changed under us: whoever holds it now decides, on the next round
  }
  const last = asHolder(readJson(lockPath(root)))
  return { ok: false, message: last && pidRuns(last.pid) ? runsHere(root) : RECLAIM_STUCK }
}

/** Remove dev.lock if it still names `instance` - a lock some other start took over stays. */
export function releaseDevLock(root: string, instance: string): void {
  try { if (asHolder(readJson(lockPath(root)))?.instance === instance) unlinkSync(lockPath(root)) } catch { /* already gone */ }
}
