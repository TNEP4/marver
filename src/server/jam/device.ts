/**
 * The device stamp - what makes "device-bound" true for the two files that decide whether
 * a comment may spawn an agent (the ledger and the journal).
 *
 * Both live in design/.local/, which is gitignored and never synced. But gitignore is a
 * convention, not provenance: a repo can force-add its own design/.local/ and hand a clone
 * a pre-authorized ledger plus a pre-baselined journal, and the daemon would run jobs the
 * owner never wrote. Stamping the files with THIS machine means a cloned one matches
 * nothing and is treated as absent.
 *
 * Derived, never stored: marver's whole uninstall story is "delete design/", so it writes
 * no state outside the repo. The trade is that the stamp is a hash of public facts, so it
 * is guessable by someone who already knows the target's hostname and username. It defeats
 * one repo published to everyone, not a stranger who knows your machine. The bigger lever in
 * that scenario is unchanged either way: design/config.ts is imported and executed by
 * `marver dev`, so running a dev server in a repo you do not trust is already running its code.
 */
import { createHash } from 'node:crypto'
import { homedir, hostname, userInfo } from 'node:os'

let cached: string | undefined

/** A short, stable id for this machine + user. */
export function deviceId(): string {
  if (cached) return cached
  let who = ''
  try { who = userInfo().username } catch { /* no passwd entry (some containers) */ }
  // NUL-joined: no hostname or username can contain one, so no two different triples
  // can hash to the same input string.
  return (cached = createHash('sha256').update([hostname(), who, homedir()].join('\0')).digest('hex').slice(0, 16))
}
