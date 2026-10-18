/**
 * One reservation table for every writer (spec 27, "One job per frame"). A jam batch reserves
 * every frame its cards name; `marver work start` holds frames for a chat agent. A batch starts
 * only when none of its frames is held, and `work start` on a frame a batch holds is refused - one
 * table, both directions. An exclusive job (a shared file, a board-level comment) reserves the
 * whole canvas: while it waits or runs, no new batch starts and no NEW hold is taken, but a hold
 * that already exists may renew and end, so an agent mid-edit never loses it.
 *
 * The jam side lives in memory (the daemon re-forms it at boot from the journal); the CLI's holds
 * are written to design/.local/work-holds.json with their expiry and restored at boot, before any
 * batch is scheduled, so a hold taken before a restart still holds after it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Activity } from './activity.ts'

export interface Reservations {
  /** frame -> the batch holding it */
  frames: Map<string, string>
  /** an exclusive job waits (queued) or runs */
  exclusive: 'waiting' | 'running' | null
  /** results wait to be posted (the startup barrier, or a delivery being retried): what they move
   *  is not known yet - a `shared` answer turns exclusive - so no new hold is taken meanwhile */
  settling?: boolean
}

/** One per process - the daemon writes it, the work route reads it. */
export const jamReservations: Reservations = { frames: new Map(), exclusive: null }

/** Why `work start` may not take `frame` now, or null. `holding`: the CLI already holds it (a
 *  renewal is always allowed). */
export function refuseHold(frame: string, holding: boolean, r: Reservations = jamReservations): string | null {
  if (holding) return null
  if (r.frames.has(frame)) return 'Marver is working on this frame - try again when it is done'
  if (r.exclusive) return 'Marver is changing a shared file - try again when it is done'
  if (r.settling) return 'Marver is finishing a job - try again in a moment'
  return null
}

const holdsFile = (root: string) => join(root, 'design', '.local', 'work-holds.json')

/** Write the CLI's unexpired holds (frame and expiry only). Best-effort and atomic. */
export function saveHolds(root: string, activity: Activity): void {
  try {
    mkdirSync(join(root, 'design', '.local'), { recursive: true })
    const tmp = `${holdsFile(root)}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(activity.leases('cli'))), { mode: 0o600 })
    renameSync(tmp, holdsFile(root))
  } catch { /* the hold still stands in memory */ }
}

/** Bring back the holds a previous server wrote - expired ones stay gone. */
export function restoreHolds(root: string, activity: Activity): number {
  let n = 0
  try {
    const v = JSON.parse(readFileSync(holdsFile(root), 'utf8'))
    for (const [frame, until] of Object.entries(v ?? {})) {
      if (typeof until === 'number' && until > Date.now()) { activity.restore(frame, until, 'cli'); n++ }
    }
  } catch { /* none, or unreadable: nothing to restore */ }
  return n
}
