/**
 * The durable batch journal - design/.local/jam-jobs.json.
 *
 * This is job-DELIVERY state (event ids + batch status), never comment content and never the
 * agent session id (that stays in daemon memory), so it is not the session/form state the
 * privacy rule forbids. Written atomically (temp + rename + fsync) and torn-write tolerant:
 * a corrupt or absent file is treated as a fresh journal, which the activation baseline then
 * seeds so enabling Live Jam never replays every old @marver.
 *
 * A single daemon per repo is enforced by an advisory pid lock; a second dev server on the
 * same root runs without the jam loop.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { deviceId } from './device.ts'
import type { Journal } from './types.ts'

const localDir = (root: string) => join(root, 'design', '.local')
const journalFile = (root: string) => join(localDir(root), 'jam-jobs.json')
const lockFile = (root: string) => join(localDir(root), 'jam.lock')

const fresh = (): Journal => ({ version: 1, device: deviceId(), baselined: false, seen: [], batches: [] })

/** Load the journal, tolerating a missing or corrupt file (→ a fresh, unbaselined journal).
 *  A journal stamped by ANOTHER machine is treated as absent: a repo that ships its own
 *  design/.local/ would otherwise hand a clone a pre-baselined journal whose `seen` omits the
 *  attacker's own comments, and the daemon would run them. Rebaselining is the safe read -
 *  every event already on disk becomes seen, so nothing pre-existing executes. */
export function read(root: string): Journal {
  const file = journalFile(root)
  if (!existsSync(file)) return fresh()
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Journal
    if (j?.version !== 1 || j.device !== deviceId() || !Array.isArray(j.seen) || !Array.isArray(j.batches)) return fresh()
    return { version: 1, device: j.device, baselined: !!j.baselined, seen: j.seen, batches: j.batches }
  } catch { return fresh() }
}

/** Persist atomically and durably. */
export function write(root: string, j: Journal): void {
  const dir = localDir(root)
  mkdirSync(dir, { recursive: true })
  const file = journalFile(root)
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try { writeSync(fd, JSON.stringify(j)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
  // fsync the directory so the rename (the durable step) survives a power loss, not just the bytes.
  try { const dfd = openSync(dir, 'r'); try { fsyncSync(dfd) } finally { closeSync(dfd) } } catch { /* dir fsync unsupported */ }
}

/** First-enable safety: mark every pre-existing event id seen WITHOUT executing, so only events
 *  appended after activation ever become jobs. Idempotent - a baselined journal is returned as-is. */
export function baseline(root: string, existingIds: string[]): Journal {
  const j = read(root)
  if (j.baselined) return j
  const seen = new Set(j.seen)
  for (const id of existingIds) seen.add(id)
  const next = { ...j, baselined: true, seen: [...seen] }
  write(root, next)
  return next
}

// ---- advisory single-daemon lock (pid file with stale reclaim) --------------------------------

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

/** Acquire the repo's jam lock. Returns true if this process now holds it. A lock left by a dead
 *  process is reclaimed; a lock held by a live process is respected (that daemon runs the loop). */
export function acquireLock(root: string): boolean {
  const dir = localDir(root)
  mkdirSync(dir, { recursive: true })
  const file = lockFile(root)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600)   // O_EXCL: fails if the lock exists
      try { writeSync(fd, String(process.pid)) } finally { closeSync(fd) }
      return true
    } catch {
      // Lock exists. Read the holder and decide - never steal a lock we cannot prove is dead.
      let holder = 0
      try { holder = parseInt(readFileSync(file, 'utf8').trim(), 10) || 0 } catch { /* unreadable */ }
      if (!holder) return false               // empty/unreadable: mid-creation or foreign - back off
      if (holder === process.pid) return true  // we already hold it (idempotent)
      if (alive(holder)) return false          // a live foreign daemon owns it
      try { rmSync(file, { force: true }) } catch { return false }   // dead holder: reclaim + retry
    }
  }
  return false
}

/** Release the lock if we own it (best-effort). */
export function releaseLock(root: string): void {
  const file = lockFile(root)
  try {
    if (parseInt(readFileSync(file, 'utf8').trim(), 10) === process.pid) unlinkSync(file)
  } catch { /* already gone */ }
}
