/**
 * Accounts, invites, sessions (SPEC-M3 §3) - the minimal credible implementation,
 * extending the gate's own idiom. No framework: per-user salted scrypt verifiers,
 * opaque session tokens stored hashed, single-use invite links as the identity
 * bootstrap (no email infrastructure anywhere).
 *
 * Password = read, account = comment: everything here concerns accounts only; the
 * shared gate password (serve.ts) remains the outer READ boundary.
 *
 * State lives in MARVER_DATA_DIR as two small JSON files rewritten atomically -
 * users change rarely; the event-log treatment is reserved for comments.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// scrypt cost: N=2^15 (OWASP fallback tier), per-user random salt. Params are recorded
// per user so a future cost bump verifies old hashes and upgrades on next sign-in.
// maxmem: 128*N*r is exactly node's 32MB default - headroom or every hash throws
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 }
const INVITE_TTL = 7 * 24 * 3600_000
const SESSION_TTL = 30 * 24 * 3600_000

export interface User {
  email: string
  name: string
  avatar?: string                 // data-URI, client-resized (~4KB); absent = initials
  role: 'member' | 'owner'
  salt: string                    // hex
  hash: string                    // hex scrypt(password, salt)
  params: typeof SCRYPT
  createdAt: number
}
interface Invite { emailNorm: string; tokenHash: string; exp: number }
interface Session { tokenHash: string; emailNorm: string; exp: number }
interface Store { users: User[]; invites: Invite[]; sessions: Session[] }

export const normEmail = (e: string) => e.trim().toLowerCase()
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const token = () => randomBytes(32).toString('base64url')

const storeFile = (dir: string) => join(dir, 'auth.json')

export function loadStore(dir: string): Store {
  try { return { users: [], invites: [], sessions: [], ...JSON.parse(readFileSync(storeFile(dir), 'utf8')) } }
  catch { return { users: [], invites: [], sessions: [] } }
}

/** Atomic rewrite (tmp + rename) - a crash mid-write must never lose every account. */
function saveStore(dir: string, store: Store) {
  const file = storeFile(dir)
  mkdirSync(dirname(file), { recursive: true })
  // expired invites and sessions are garbage-collected on every write
  const now = Date.now()
  store.invites = store.invites.filter((i) => i.exp > now)
  store.sessions = store.sessions.filter((s) => s.exp > now)
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(store, null, 2))
  renameSync(tmp, file)
}

const findUser = (store: Store, email: string) => store.users.find((u) => normEmail(u.email) === normEmail(email))

/** Mint a single-use invite for an email (this IS the allowlist entry - inviting an
 *  address authorizes it). Re-inviting an email replaces its pending invite. The raw
 *  token is returned exactly once; only its hash is stored. */
export function createInvite(dir: string, email: string): { token: string; exp: number } {
  const store = loadStore(dir)
  if (findUser(store, email)) throw new Error(`${normEmail(email)} already has an account`)
  const raw = token()
  const exp = Date.now() + INVITE_TTL
  store.invites = store.invites.filter((i) => i.emailNorm !== normEmail(email))
  store.invites.push({ emailNorm: normEmail(email), tokenHash: sha256(raw), exp })
  saveStore(dir, store)
  return { token: raw, exp }
}

/** Claim an invite: burns it, creates the account, opens the first session. */
export function claimInvite(
  dir: string, rawToken: string, profile: { password: string; name: string; avatar?: string },
): { user: User; session: string } {
  if (profile.password.length < 8) throw new Error('password must be at least 8 characters')
  if (!profile.name.trim()) throw new Error('a display name is required')
  const store = loadStore(dir)
  const hash = sha256(rawToken)
  const invite = store.invites.find((i) => i.tokenHash === hash && i.exp > Date.now())
  if (!invite) throw new Error('this invite link is invalid, expired, or already used')
  store.invites = store.invites.filter((i) => i !== invite)
  const salt = randomBytes(16).toString('hex')
  const user: User = {
    email: invite.emailNorm, name: profile.name.trim(), avatar: profile.avatar,
    role: store.users.length ? 'member' : 'owner',    // first account owns the canvas
    salt, hash: scryptSync(profile.password, Buffer.from(salt, 'hex'), SCRYPT.keylen, SCRYPT).toString('hex'),
    params: SCRYPT, createdAt: Date.now(),
  }
  store.users.push(user)
  const session = pushSession(store, user)
  saveStore(dir, store)
  return { user, session }
}

/** Password sign-in. One generic failure - never reveal whether the email exists. */
export function signIn(dir: string, email: string, password: string): { user: User; session: string } | null {
  const store = loadStore(dir)
  const user = findUser(store, email)
  // unknown email still pays a scrypt to keep timing flat
  const salt = user ? Buffer.from(user.salt, 'hex') : randomBytes(16)
  const params = user?.params ?? SCRYPT
  const got = scryptSync(password, salt, params.keylen, params)
  const want = user ? Buffer.from(user.hash, 'hex') : randomBytes(SCRYPT.keylen)
  if (!user || got.length !== want.length || !timingSafeEqual(got, want)) return null
  const session = pushSession(store, user)
  saveStore(dir, store)
  return { user, session }
}

function pushSession(store: Store, user: User): string {
  const raw = token()
  store.sessions.push({ tokenHash: sha256(raw), emailNorm: normEmail(user.email), exp: Date.now() + SESSION_TTL })
  return raw
}

/** Resolve a session token to its user; null when unknown or expired. */
export function sessionUser(dir: string, rawToken: string): User | null {
  const store = loadStore(dir)
  const hash = sha256(rawToken)
  const s = store.sessions.find((s) => s.tokenHash === hash && s.exp > Date.now())
  return s ? (store.users.find((u) => normEmail(u.email) === s.emailNorm) ?? null) : null
}

export function signOut(dir: string, rawToken: string) {
  const store = loadStore(dir)
  const hash = sha256(rawToken)
  store.sessions = store.sessions.filter((s) => s.tokenHash !== hash)
  saveStore(dir, store)
}

/** Update name/avatar on an existing account. */
export function updateProfile(dir: string, email: string, patch: { name?: string; avatar?: string }) {
  const store = loadStore(dir)
  const user = findUser(store, email)
  if (!user) throw new Error('no such account')
  if (patch.name?.trim()) user.name = patch.name.trim()
  if (patch.avatar !== undefined) user.avatar = patch.avatar || undefined
  saveStore(dir, store)
  return user
}

/** Remove an account and all its sessions (owner action). */
export function revokeUser(dir: string, email: string) {
  const store = loadStore(dir)
  store.users = store.users.filter((u) => normEmail(u.email) !== normEmail(email))
  store.sessions = store.sessions.filter((s) => s.emailNorm !== normEmail(email))
  store.invites = store.invites.filter((i) => i.emailNorm !== normEmail(email))
  saveStore(dir, store)
}

/** The public shape of a user - what other viewers (and events) may see. */
export const publicUser = (u: User) => ({ email: u.email, name: u.name, avatar: u.avatar })
