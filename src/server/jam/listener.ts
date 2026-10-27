/**
 * The Claude Code listener's lock (spec 29b, Part 5): one listener per Claude Code process, at
 * design/.local/jam/listen/<CLAUDE_PID>.json. A second start finds it alive and hands over the current
 * session id (a new prompt, /clear, compaction, a resume); a lock whose listener is gone is taken over.
 * S29-5b's lesson: without it, the wake-up's own prompt hook starts a second listener, and a third.
 *
 * Taking over a dead listener's lock happens under a reclaim lock of its own (created exclusively), and
 * only after reading the lock again under it - so two starts that both saw it stale never both win.
 */
import { mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { jamDir, pidAlive, writeAtomic } from './conn.ts'

export interface Listener { pid: number; session: string; mode?: string }

export const listenerFile = (root: string, claudePid: number) => join(jamDir(root), 'listen', `${claudePid}.json`)

export function readListener(root: string, claudePid: number): Listener | null {
  try {
    const l = JSON.parse(readFileSync(listenerFile(root, claudePid), 'utf8')) as Listener
    return Number.isInteger(l?.pid) && typeof l.session === 'string' ? l : null
  } catch { return null }
}

/** Hand over a new session id or mode - only to the listener that holds the lock now. */
export function writeListener(root: string, claudePid: number, l: Listener): void {
  if (readListener(root, claudePid)?.pid !== l.pid) return
  writeAtomic(listenerFile(root, claudePid), JSON.stringify(l))
}

/** Is the lock held by nobody alive? A lock that cannot be read and is not new (a start that crashed mid-write) is. */
function stale(file: string, held: Listener | null): boolean {
  if (held) return !pidAlive(held.pid)
  try { return Date.now() - statSync(file).mtimeMs > 5_000 } catch { return true }
}

/** Take the lock: created exclusively when there is none; a dead one replaced only under the reclaim lock. */
export function claimListener(root: string, claudePid: number, l: Listener): boolean {
  const file = listenerFile(root, claudePid)
  mkdirSync(join(jamDir(root), 'listen'), { recursive: true, mode: 0o700 })
  const create = () => { try { writeFileSync(file, JSON.stringify(l), { flag: 'wx', mode: 0o600 }); return true } catch { return false } }
  if (create()) return true
  if (!stale(file, readListener(root, claudePid))) return false
  const reclaim = `${file}.reclaim`
  try { mkdirSync(reclaim) } catch {
    // another start is reclaiming it - or one crashed mid-reclaim long ago: that one is cleared, and the next start wins
    try { if (Date.now() - statSync(reclaim).mtimeMs > 10_000) rmdirSync(reclaim) } catch { /* gone */ }
    return false
  }
  try {
    if (!stale(file, readListener(root, claudePid))) return false   // taken meanwhile, by a live one
    rmSync(file, { force: true })
    return create()
  } finally { try { rmdirSync(reclaim) } catch { /* gone */ } }
}

export function releaseListener(root: string, claudePid: number, pid: number): void {
  const l = readListener(root, claudePid)
  if (l?.pid === pid) rmSync(listenerFile(root, claudePid), { force: true })
}

/** A successor being started (`marver jam listen` again, on the upgraded build): its pid, whether it has exited, and
 *  how to stop it. */
export interface Successor { pid?: number; gone(): boolean; kill(signal?: NodeJS.Signals): void }

/** Wait for `next` to hold the lock (it read its whole input and started), up to `ms`: true once it - or a listener a
 *  hook started meanwhile - holds it (this one goes); false once `me` holds the lock again (`next` died, or held
 *  nothing in time and was stopped) and keeps listening. */
export function handOver(root: string, claudePid: number, me: Listener, next: Successor, ms: number): Promise<boolean> {
  return new Promise((done) => {
    const deadline = Date.now() + ms
    let stopped = 0, killed = false
    const wait = setInterval(() => {
      // the successor holds it (or a listener a hook started meanwhile): this one goes - never for the one it is stopping
      const l = readListener(root, claudePid)
      if (l && l.pid !== me.pid && pidAlive(l.pid) && !(stopped && l.pid === next.pid)) { clearInterval(wait); return done(true) }
      if (!next.gone()) {
        if (Date.now() < deadline) return
        // too late: it is stopped, and the lock taken back only once it is gone - a signal lands later, and one that
        // took the lock as it was stopped would still read alive here, then let it go as it died: no listener at all
        if (!stopped) { stopped = Date.now(); try { next.kill() } catch { /* gone */ } }
        else if (!killed && Date.now() - stopped > 5_000) { killed = true; try { next.kill('SIGKILL') } catch { /* gone */ } }
        return
      }
      // a lock still being written, or being reclaimed by another start, is looked at again at the next tick
      if (claimListener(root, claudePid, me)) { clearInterval(wait); done(false) }
    }, 100)
  })
}
