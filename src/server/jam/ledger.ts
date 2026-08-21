/**
 * The device-bound authorization ledger - the whole trust boundary.
 *
 * When the dev POST accepts an owner-gated write, it records that event's id here. The
 * daemon's owner-trigger check is `has(root, id)`, never a synced field: sync copies
 * `origin` byte-for-byte, so a remote comment can spoof `origin:'local'` (proven RCE),
 * but it can never appear in a file that is written only on THIS machine by the gated
 * POST and never synced. Synced-in events are never in the ledger, so they never trigger.
 *
 * One `<device>\t<board>\t<id>` per line, append-only, gitignored, never synced (design/.local/
 * is watch-ignored and sync-excluded). Agent-written events are never recorded (they are
 * daemon-authored, not owner input, so they cannot self-authorize a next job).
 *
 * The key is (device, board, id), never id alone:
 * - board, because event ids are client UUIDs that sync copies verbatim, so a remote
 *   collaborator could reuse an owner's ledgered id in a NEW malicious event. Binding to the
 *   board it was gate-written on defeats that - the forged copy lands on some board the ledger
 *   never authorized for that id, so it never triggers.
 * - device, because gitignore is a convention, not provenance: a repo can force-add its own
 *   design/.local/ and hand a clone a ledger full of pre-authorized ids. Lines stamped with
 *   another machine match nothing here (device.ts).
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deviceId } from './device.ts'

const ledgerFile = (root: string) => join(root, 'design', '.local', 'jam-ledger')
const line = (board: string, id: string) => `${deviceId()}\t${board}\t${id}`

/** Was this (board, id) authorized on this device by the gated dev POST? */
export function has(root: string, board: string, id: string): boolean {
  if (!board || !id) return false
  const file = ledgerFile(root)
  if (!existsSync(file)) return false
  const want = line(board, id)
  // Line-exact match; a torn final line (interrupted append) just won't match - safe.
  for (const l of readFileSync(file, 'utf8').split('\n')) if (l === want) return true
  return false
}

/** Authorize a (board, id). fsync'd (a 200-acked, ledgered write must survive a crash) and
 *  0600 (owner-only). Idempotent enough: a duplicate line is harmless, `has` matches either. */
export function record(root: string, board: string, id: string): void {
  if (!board || !id) return
  const file = ledgerFile(root)
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'a', 0o600)
  try { writeSync(fd, line(board, id) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
}
