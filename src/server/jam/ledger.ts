/**
 * The device-bound authorization ledger (SPEC-live-jam §1) - the whole trust boundary.
 *
 * When the dev POST accepts an owner-gated write, it records that event's id here. The
 * daemon's owner-trigger check is `has(root, id)`, never a synced field: sync copies
 * `origin` byte-for-byte, so a remote comment can spoof `origin:'local'` (proven RCE),
 * but it can never appear in a file that is written only on THIS machine by the gated
 * POST and never synced. Synced-in events are never in the ledger, so they never trigger.
 *
 * One id per line, append-only, gitignored, never synced (design/.local/ is watch-ignored
 * and sync-excluded). Agent-written events are never recorded (they are daemon-authored,
 * not owner input, so they cannot self-authorize a next job).
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ledgerFile = (root: string) => join(root, 'design', '.local', 'jam-ledger')

/** Was this event id authorized on this device by the gated dev POST? */
export function has(root: string, id: string): boolean {
  if (!id) return false
  const file = ledgerFile(root)
  if (!existsSync(file)) return false
  // Line-exact match; a torn final line (interrupted append) just won't match - safe.
  for (const line of readFileSync(file, 'utf8').split('\n')) if (line === id) return true
  return false
}

/** Authorize an event id. fsync'd (a 200-acked, ledgered write must survive a crash) and
 *  0600 (owner-only). Idempotent enough: a duplicate line is harmless, `has` matches either. */
export function record(root: string, id: string): void {
  if (!id) return
  const file = ledgerFile(root)
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'a', 0o600)
  try { writeSync(fd, id + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
}
