/**
 * One holder per file (spec 28 A1.2): dev.lock and the slot files in ~/.marver/running/ share it.
 *
 * The rules, none of which guess a holder dead from time or from an unanswered request:
 * - no file: create it exclusively. Done.
 * - a file whose pid runs: it is held (a slow or paused holder too).
 * - a file whose pid is dead: reclaim it while holding `<file>.reclaim` (also exclusive): read it
 *   again, still the same dead holder -> replace it. A reclaim file already there means another
 *   start is reclaiming: wait a second and start over once; still there -> stuck. A `.reclaim` left
 *   by a process killed mid-reclaim is never guessed stale from its age.
 * - a file that is there but names no holder: unreadable, never guessed stale either.
 *
 * Files are created by linking a fully written temp file into place, so a reader never sees an
 * empty or half-written one - `link` fails if the name exists, which is the exclusive create.
 */
import { createServer } from 'node:net'
import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

export interface Holder { pid: number; instance: string; at: number }
export type Took =
  | { ok: true; release(): void }
  | { ok: false; why: 'held'; holder: Holder }   // its pid runs (a process paused with SIGSTOP too)
  | { ok: false; why: 'unreadable' }             // there, but not a holder
  | { ok: false; why: 'stuck' }                  // <file>.reclaim stayed through the wait: a start mid-reclaim, or a crashed one

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

/** A JSON file's value: undefined when there is no file, null when it is there but unreadable. */
export const readJson = (file: string): unknown | undefined => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null
  }
}
/** The holder a file names - any JSON object with a numeric pid and a string instance (a slot file's
 *  other fields are ignored). */
export const asHolder = (v: unknown): Holder | null => {
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

const code = (err: unknown) => (err as NodeJS.ErrnoException).code

/** Take `file` for `me`, writing `body` (which names me.pid and me.instance). On success the caller
 *  owns it until `release()`, which removes it only while it still names me.instance. */
export async function takeExclusive(file: string, me: Holder, body: string, opts: { reclaimWaitMs?: number } = {}): Promise<Took> {
  const reclaim = `${file}.reclaim`
  const release = () => releaseExclusive(file, me.instance)
  for (let round = 0; round < 2; round++) {
    try { createExclusive(file, body); return { ok: true, release } } catch (err) { if (code(err) !== 'EEXIST') throw err }
    const raw = readJson(file)
    if (raw === undefined) continue   // released between the create and the read - try again
    const holder = asHolder(raw)
    if (!holder) return { ok: false, why: 'unreadable' }
    if (pidRuns(holder.pid)) return { ok: false, why: 'held', holder }
    // a dead holder: reclaim it, one starter at a time. The reclaim file names the claimant only - a
    // slot's key never sits in a .reclaim a crash left behind
    try { createExclusive(reclaim, JSON.stringify(me)) } catch (err) {
      if (code(err) !== 'EEXIST') throw err
      if (round === 0) { await new Promise((r) => setTimeout(r, opts.reclaimWaitMs ?? 1000)); continue }
      return { ok: false, why: 'stuck' }
    }
    try {
      const again = asHolder(readJson(file))
      if (again && again.pid === holder.pid && again.instance === holder.instance) {
        unlinkSync(file)
        try { createExclusive(file, body); return { ok: true, release } } catch (err) {
          if (code(err) !== 'EEXIST') throw err
          // a fresh start took the free name in between: it holds it now
        }
      }
    } finally { try { unlinkSync(reclaim) } catch { /* gone */ } }
    // the file changed under us: whoever holds it now decides, on the next round
  }
  const last = asHolder(readJson(file))
  return last && pidRuns(last.pid) ? { ok: false, why: 'held', holder: last } : { ok: false, why: 'stuck' }
}

/** Remove `file` if it still names `instance` - a file some other start took over stays. */
export function releaseExclusive(file: string, instance: string): void {
  try { if (asHolder(readJson(file))?.instance === instance) unlinkSync(file) } catch { /* already gone */ }
}
