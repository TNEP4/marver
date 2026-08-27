/**
 * The dev identity - ONE resolver for every server-side consumer (api, jam daemon, CLI).
 *
 * Two sources merge:
 *  - design/.local/profile.json  {name, email?, avatar?} - set from the composer's
 *    avatar popover
 *  - the connect account {email, name}, written by `comments connect` into
 *    ~/.marver/canvases/ - outside the repo, because `marver dev` serves the repo
 *
 * The connect account wins name + email (published serves validate author == session, so
 * events born here must carry an identity the remote will accept). The avatar always comes
 * from profile.json - connect doesn't carry one, and the local photo is still YOUR photo.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCollab } from './sync.ts'

export interface LocalProfile { email: string; name: string; avatar?: string }

const readJson = (path: string): Record<string, unknown> => {
  // `null`, arrays, and primitives are VALID JSON that would blow up property access
  // downstream - only a plain object counts as a profile file
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** True when a connect account provides the identity - name/email are then read-only in dev. */
export function isConnected(root: string): boolean {
  return !!str(loadCollab(root)?.email)
}

export function localProfile(root: string): LocalProfile {
  const dir = join(root, 'design', '.local')
  const prof = readJson(join(dir, 'profile.json'))
  // Through loadCollab, never by path: the credential moved out of the repo, and
  // reading the old location directly silently dropped the connected identity off
  // every comment the moment somebody upgraded.
  const collab = (loadCollab(root) ?? {}) as Record<string, unknown>
  return {
    // the unset default is "You" - the person at the keyboard, whatever their role
    // (the client renders it as the green Y avatar until a real profile is set)
    name: str(collab.name) || str(prof.name) || 'You',
    email: str(collab.email) || str(prof.email),
    // The connected account's picture wins, exactly as its name does.
    //
    // The account already HAS one - the server sends it with every sign-in - and
    // it was being dropped on the floor, so a connected repo showed the right
    // name against a generated initials chip. A local profile.json avatar still
    // works when there is no account to take one from.
    avatar: str(collab.avatar) || str(prof.avatar) || undefined,
  }
}
