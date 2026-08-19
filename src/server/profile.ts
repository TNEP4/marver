/**
 * The dev identity - ONE resolver for every server-side consumer (api, jam daemon, CLI).
 *
 * Two sources merge in design/.local/:
 *  - profile.json  {name, email?, avatar?} - set from the composer's avatar popover
 *  - collab.json   {email, name}           - the connect account, written by `comments connect`
 *
 * The connect account wins name + email (published serves validate author == session, so
 * events born here must carry an identity the remote will accept). The avatar always comes
 * from profile.json - connect doesn't carry one, and the local photo is still YOUR photo.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LocalProfile { email: string; name: string; avatar?: string }

const readJson = (path: string): Record<string, unknown> => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** True when a connect account provides the identity - name/email are then read-only in dev. */
export function isConnected(root: string): boolean {
  return !!str(readJson(join(root, 'design', '.local', 'collab.json')).email)
}

export function localProfile(root: string): LocalProfile {
  const dir = join(root, 'design', '.local')
  const prof = readJson(join(dir, 'profile.json'))
  const collab = readJson(join(dir, 'collab.json'))
  return {
    name: str(collab.name) || str(prof.name) || 'Designer',
    email: str(collab.email) || str(prof.email),
    avatar: str(prof.avatar) || undefined,
  }
}
