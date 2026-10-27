/**
 * The Claude Code listener's lock (spec 29b, Part 5): one listener per Claude Code process, at
 * design/.local/jam/listen/<CLAUDE_PID>.json. A second start finds it alive and hands over the current
 * session id (a new prompt, /clear, compaction, a resume); a lock whose listener is gone is taken over.
 * S29-5b's lesson: without it, the wake-up's own prompt hook starts a second listener, and a third.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

export function writeListener(root: string, claudePid: number, l: Listener): void {
  writeAtomic(listenerFile(root, claudePid), JSON.stringify(l))
}

/** Take the lock: only when no live listener holds it. Two starts racing: the exclusive create decides. */
export function claimListener(root: string, claudePid: number, l: Listener): boolean {
  const file = listenerFile(root, claudePid)
  mkdirSync(join(jamDir(root), 'listen'), { recursive: true, mode: 0o700 })
  const held = readListener(root, claudePid)
  if (held && held.pid !== l.pid && pidAlive(held.pid)) return false
  if (held) rmSync(file, { force: true })   // its listener is gone
  try { writeFileSync(file, JSON.stringify(l), { flag: 'wx', mode: 0o600 }); return true } catch { return false }
}

export function releaseListener(root: string, claudePid: number, pid: number): void {
  const l = readListener(root, claudePid)
  if (l?.pid === pid) rmSync(listenerFile(root, claudePid), { force: true })
}
