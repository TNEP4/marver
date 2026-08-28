/**
 * Accounts, invites, sessions - the minimal credible implementation,
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
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { grantFromInviteRedemption, provisionVerdict, shareState } from './share.ts'

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
  /** How this account proves who it is. Absent = 'password' (accounts predate
   *  the field). A 'marver-id' account has NO local credential at all: it holds
   *  no salt/hash, and signIn() refuses it outright. That is deliberate - a
   *  fabricated password hash would be a second, weaker way into the same
   *  account, which is exactly what the identity service is meant to remove. */
  auth?: 'password' | 'marver-id'
  salt?: string                   // hex   - password accounts only
  hash?: string                   // hex scrypt(password, salt) - password accounts only
  params?: typeof SCRYPT
  /** `<issuer>#<subject>` from the identity service - qualified so a canvas
   *  repointed at a different service cannot bind a colliding subject. */
  idSubject?: string
  /** The picture URL this account's avatar was fetched FROM. Kept so a rotated
   *  URL can be noticed and re-fetched, and so we never fetch the same one twice. */
  avatarSource?: string
  createdAt: number
}
interface Invite { emailNorm: string; tokenHash: string; exp: number }
interface Session {
  tokenHash: string; emailNorm: string; exp: number
  /** Set only on sessions minted by the operator credential: a fingerprint of the
   *  MARVER_CLI_TOKEN that produced it. Rotating that variable changes the
   *  fingerprint and every session carrying an old one stops resolving - which is
   *  what makes "rotate to revoke" true rather than a hope. */
  via?: string
}
interface Store { users: User[]; invites: Invite[]; sessions: Session[] }

export const normEmail = (e: string) => e.trim().toLowerCase()
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const token = () => randomBytes(32).toString('base64url')

const storeFile = (dir: string) => join(dir, 'auth.json')

/** Only a MISSING file is an empty store. A present-but-unreadable/corrupt auth.json
 *  must fail CLOSED - treating it as empty would let the owner bootstrap re-run and
 *  a later save overwrite every account. */
export function loadStore(dir: string): Store {
  let raw: string
  try { raw = readFileSync(storeFile(dir), 'utf8') }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { users: [], invites: [], sessions: [] }
    throw new Error(`auth store unreadable (${(err as Error).message}) - refusing to treat it as empty`)
  }
  let parsed: any
  try { parsed = JSON.parse(raw) } catch { throw new Error('auth store is corrupt JSON - refusing to treat it as empty. Restore it or delete it deliberately.') }
  if (!Array.isArray(parsed?.users) || !Array.isArray(parsed?.invites) || !Array.isArray(parsed?.sessions))
    throw new Error('auth store has an unexpected shape - refusing to load it')
  return parsed
}

/** Atomic rewrite (tmp + rename) - a crash mid-write must never lose every account.
 *  0600 throughout: the store holds emails and password verifiers. */
function saveStore(dir: string, store: Store) {
  const file = storeFile(dir)
  mkdirSync(dirname(file), { recursive: true })
  // expired invites and sessions are garbage-collected on every write
  const now = Date.now()
  store.invites = store.invites.filter((i) => i.exp > now)
  store.sessions = store.sessions.filter((s) => s.exp > now)
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  // fsync before rename: an acked account/session/invite must survive a crash or
  // volume interruption, not just reach the page cache
  const fd = openSync(tmp, 'wx', 0o600)
  try { writeSync(fd, JSON.stringify(store, null, 2)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
}

/** Cross-process mutex over auth.json's read-modify-write. Within one Node process
 *  the store mutations are already synchronous and atomic; this covers deploy overlap
 *  and any accidental multi-instance run (the supported setup is single-instance) -
 *  without it, a sign-in that loaded a pre-revoke snapshot could rename it back over a
 *  successful revoke. A crashed holder's lock is stolen after 10s; waiting past 5s
 *  fails loudly rather than hanging. */
export function withLock<T>(dir: string, fn: () => T, lockName = '.auth.lock'): T {
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, lockName)
  const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  const deadline = Date.now() + 5000
  for (;;) {
    try { closeSync(openSync(lock, 'wx')); break }        // O_EXCL create = acquired
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try { if (Date.now() - statSync(lock).mtimeMs > 10_000) { unlinkSync(lock); continue } } catch { continue }
      if (Date.now() > deadline) throw new Error('auth store is busy - please retry')
      nap(25)
    }
  }
  try { return fn() } finally { try { unlinkSync(lock) } catch { /* already released */ } }
}

const findUser = (store: Store, email: string) => store.users.find((u) => normEmail(u.email) === normEmail(email))

/** Mint a single-use invite for an email (this IS the allowlist entry - inviting an
 *  address authorizes it). Re-inviting an email replaces its pending invite. The raw
 *  token is returned exactly once; only its hash is stored. */
/** The owner's display name - public-safe (never the email). Null before claim. */
export function ownerName(dir: string): string | null {
  const owner = loadStore(dir).users.find((u) => u.role === 'owner')
  return owner?.name?.trim() || null
}

/** Peek at a live invite: the claim screens show WHO the invite is for. The raw
 *  token is the proof - holding it means the owner sent it to you. */
export function inviteInfo(dir: string, rawToken: string): { email: string } | null {
  const hash = sha256(rawToken)
  const invite = loadStore(dir).invites.find((i) => i.tokenHash === hash && i.exp > Date.now())
  return invite ? { email: invite.emailNorm } : null
}

export function createInvite(dir: string, email: string): { token: string; exp: number } {
  return withLock(dir, () => {
  const store = loadStore(dir)
  if (findUser(store, email)) throw new Error(`${normEmail(email)} already has an account`)
  const raw = token()
  const exp = Date.now() + INVITE_TTL
  store.invites = store.invites.filter((i) => i.emailNorm !== normEmail(email))
  store.invites.push({ emailNorm: normEmail(email), tokenHash: sha256(raw), exp })
  saveStore(dir, store)
  return { token: raw, exp }
  })
}

/** Claim an invite: burns it, creates the account, opens the first session. */
export function claimInvite(
  dir: string, rawToken: string, profile: { password: string; name: string; avatar?: string },
): { user: User; session: string } {
  if (profile.password.length < 8) throw new Error('password must be at least 8 characters')
  if (!profile.name.trim()) throw new Error('a display name is required')
  return withLock(dir, () => {
  const store = loadStore(dir)
  const hash = sha256(rawToken)
  const invite = store.invites.find((i) => i.tokenHash === hash && i.exp > Date.now())
  if (!invite) throw new Error('this invite link is invalid, expired, or already used')
  // An account for this address may have appeared since the invite was minted -
  // through Marver ID, say. Creating a second user with the same email would be
  // an account takeover, not a duplicate: sessions resolve by email to the FIRST
  // matching user, so the claimant would inherit whatever that first user is.
  if (findUser(store, invite.emailNorm)) {
    store.invites = store.invites.filter((i) => i !== invite)
    saveStore(dir, store)
    throw new Error('an account already exists for this address - sign in instead')
  }
  store.invites = store.invites.filter((i) => i !== invite)
  const salt = randomBytes(16).toString('hex')
  const user: User = {
    email: invite.emailNorm, name: profile.name.trim(), avatar: profile.avatar,
    role: store.users.length ? 'member' : 'owner',    // first account owns the canvas
    salt, hash: scryptSync(profile.password, Buffer.from(salt, 'hex'), SCRYPT.keylen, SCRYPT).toString('hex'),
    params: SCRYPT, createdAt: Date.now(),
  }
  store.users.push(user)
  // the invite materialises its grant on redemption (01-sharing §10)
  grantFromInviteRedemption(dir, invite.emailNorm)
  const session = pushSession(store, user)
  saveStore(dir, store)
  return { user, session }
  })
}

/** Password sign-in. One generic failure - never reveal whether the email exists. */
export function signIn(dir: string, email: string, password: string): { user: User; session: string } | null {
  return withLock(dir, () => {
  const store = loadStore(dir)
  const found = findUser(store, email)
  // An account provisioned by the identity service has no password to check.
  // Treat it exactly like an unknown email - same generic failure, same scrypt
  // cost - so this path never reveals which accounts exist or how they sign in.
  const user = found && found.auth !== 'marver-id' && found.salt && found.hash ? found : null
  // unknown email still pays a scrypt to keep timing flat
  const salt = user ? Buffer.from(user.salt!, 'hex') : randomBytes(16)
  const params = user?.params ?? SCRYPT
  const got = scryptSync(password, salt, params.keylen, params)
  const want = user ? Buffer.from(user.hash!, 'hex') : randomBytes(SCRYPT.keylen)
  if (!user || got.length !== want.length || !timingSafeEqual(got, want)) return null
  // The resolver answers this door too (04-solution §2.2.1): a blocked or
  // fully-revoked member fails sign-in with the same generic refusal - a
  // correct password is who they are, not whether they are still let in.
  // The owner keeps standing; pre-migration stores keep legacy behaviour.
  const share = shareState(dir)
  if (share && user.role !== 'owner') {
    const verdict = provisionVerdict(share, user.email)
    if (verdict !== 'granted') return null
  }
  const session = pushSession(store, user)
  saveStore(dir, store)
  return { user, session }
  })
}

/**
 * Turn a verified Marver ID identity into a local session.
 *
 * The identity service has already proved who this person is; this function
 * decides whether they may in - and that decision is LOCAL, which is the whole
 * shape of L1a. The identity service knows nothing about who is allowed where.
 *
 * `allowed` is the owner's allowlist. An email that is not on it gets no account
 * and no session: being able to prove you are someone is not the same as being
 * invited. The first allowed account to arrive owns the canvas, matching the
 * invite flow's rule.
 *
 * No password is fabricated. A marver-id account carries no salt or hash at all,
 * so there is no second, weaker door into it.
 */
export function provisionFromMarverId(
  dir: string,
  identity: {
    email: string; subject: string; issuer: string
    /** Display name from the assertion, already bounded by the verifier. */
    name?: string
  },
  opts: { ownerEmail?: string } = {},
): { user: User; session: string } | null {
  const emailNorm = normEmail(identity.email)
  if (!emailNorm) return null

  return withLock(dir, () => {
    const store = loadStore(dir)

    // The allowlist decision happens HERE, inside the lock, against the store we
    // are about to write. Reading it outside meant two concurrent callbacks could
    // both pass a check that was already stale - which is exactly the race the
    // lock exists to prevent.
    const qualified = `${identity.issuer}#${identity.subject}`

    // Find them by SUBJECT first, then by address.
    //
    // The subject is the stable identity; the address is a label on it that
    // people genuinely change - a Workspace rename, a married name, a company
    // moving domain. Looking up by email alone meant a returning person whose
    // address had changed did not match their own account, fell through to the
    // allowlist with an address nobody had invited, and was refused entry to a
    // canvas they may well own. Their account is right there, bound to the
    // subject the assertion just proved.
    const bound = store.users.find((u) => u.idSubject === qualified)
    const existing = bound ?? findUser(store, emailNorm)

    // Follow a rename, but never onto an address somebody else already holds.
    //
    // Sessions are stored by email and resolved to the FIRST user matching one,
    // so letting two records carry the same address is not a duplicate - it is a
    // takeover with the winner decided by array order. If A's verified address
    // changes to one B already owns, A's next session can resolve to B, and B may
    // be the owner. Refusing is the only safe answer: the rename is genuine but
    // the destination is occupied, and a canvas cannot tell which of the two
    // people is meant to keep it.
    if (bound && normEmail(bound.email) !== emailNorm) {
      const clash = findUser(store, emailNorm)
      if (clash && clash !== bound) return null
      const vacated = normEmail(bound.email)
      bound.email = emailNorm

      // Every session issued under the OLD address dies with it.
      //
      // A session records the email it was minted for, and resolves by looking
      // that email up again. So a rename leaves the old sessions pointing at an
      // address their owner no longer holds - and the moment somebody else
      // legitimately claims it, those sessions start resolving to that person
      // instead. The account records are fine; the stale keys are the problem.
      //
      // Dropping them is the conservative half of the fix: the worst case is
      // signing in again on other devices, against a silent handover of whatever
      // that account can reach. The session minted just below is created after
      // this, so the person doing the renaming stays signed in here.
      store.sessions = store.sessions.filter((s) => s.emailNorm !== vacated)
    }

    const invite = store.invites.find((i) => i.emailNorm === emailNorm && i.exp > Date.now())

    // An empty canvas with a named owner is RESERVED for that owner.
    //
    // Without the reservation, any pending invite on a canvas with no accounts
    // was enough to walk in - and the first account through the door is made
    // owner, so whoever arrived first took the canvas. Rare, because an empty
    // canvas usually has no invites to hold, but the cost of it happening is the
    // whole canvas and the guard is one condition.
    const ownerNorm = opts.ownerEmail ? normEmail(opts.ownerEmail) : ''
    const reservedForOwner = !!ownerNorm && !store.users.length && ownerNorm !== emailNorm
    const isBootstrapOwner = !!ownerNorm && !store.users.length && ownerNorm === emailNorm
    if (reservedForOwner) return null

    // The resolver precedes the legacy chain (04-solution §2.2.1). With a
    // roster present: a blocked address is refused whatever else is true, a
    // domain or exact grant admits without an invite, and an existing MEMBER
    // whose grants are gone no longer walks in on the strength of having
    // existed - revocation has to be real at this door too. The owner and the
    // bootstrap path keep their standing (someone must administer), and a
    // pending invite still admits (it materialises a grant below). Without a
    // roster (pre-migration) the legacy chain is exactly what runs.
    const share = shareState(dir)
    if (share) {
      const verdict = provisionVerdict(share, emailNorm)
      if (verdict === 'blocked') return null
      const standing = verdict === 'granted' || existing?.role === 'owner' || !!invite || isBootstrapOwner
      if (!standing) return null
    } else if (!existing && !invite && !isBootstrapOwner) return null

    // An invite that authorises entry is SPENT by it. Leaving it pending would
    // leave a password-based second door into an account that now exists.
    if (invite) store.invites = store.invites.filter((i) => i !== invite)

    let user = existing

    if (user) {
      // An existing PASSWORD account keeps its password; signing in through the
      // identity service does not silently convert it, and must not be a way to
      // take one over. Same address, same person, both doors still work.
      if (!user.idSubject) {
        user.idSubject = qualified
      } else if (user.idSubject === identity.subject) {
        // A store written before subjects were issuer-qualified. The same person,
        // recorded the old way - upgrade it in place rather than locking them out
        // of their own canvas over a format change.
        user.idSubject = qualified
      } else if (user.idSubject !== qualified) {
        // A subject that disagrees means a different identity claims this
        // address. Refuse rather than guess. Qualified by issuer, so pointing a
        // canvas at a new service cannot bind a coincidentally identical subject.
        return null
      }
    } else {
      user = {
        email: emailNorm,
        // Their actual name when the assertion carries one. The address sliced
        // at the @ is the fallback, not the intent: it produced "nicolas.t.touron"
        // on every comment for somebody the consent card had just greeted by name.
        name: identity.name || emailNorm.split('@')[0] || emailNorm,
        role: store.users.length ? 'member' : 'owner',
        auth: 'marver-id',
        idSubject: `${identity.issuer}#${identity.subject}`,
        createdAt: Date.now(),
      }
      store.users.push(user)
    }

    // Fill what is missing; never overwrite what they set HERE.
    //
    // A canvas profile is editable, and somebody who renamed themselves or
    // picked a different picture on this canvas meant it. So the assertion is
    // treated as a source for gaps rather than as the truth every sign-in
    // reasserts - otherwise every visit would quietly undo their edit.
    //
    // The exception is the email-derived placeholder: an account created before
    // assertions carried names is sitting on a fallback nobody chose, and the
    // real name is strictly better.
    if (identity.name && (!user.name || user.name === emailNorm.split('@')[0])) {
      user.name = identity.name
    }
    // A redeemed invite materialises the canvas-scoped comment grant it always
    // meant (01-sharing §10) - so the person it admitted keeps commenting after
    // the invite itself is gone. Separate lock file, so no re-entrancy here.
    if (invite) grantFromInviteRedemption(dir, emailNorm)
    const session = pushSession(store, user)
    saveStore(dir, store)
    return { user, session }
  })
}

/**
 * Attach a picture the identity service supplied.
 *
 * Separate from provisioning because the fetch happens after admission and
 * outside the lock, so by the time there are bytes the account already exists.
 *
 * `avatarSource` is what makes this safe to repeat: its presence means "this
 * picture came from the identity service", and only such a picture may be
 * replaced. An avatar with no source was chosen HERE, by the person, and the
 * identity service does not get to overwrite it - which is the same rule the
 * name follows.
 *
 * Replacing a rotated one is the point. Refusing to, as an earlier version did,
 * meant the stored source never caught up with the assertion, so every single
 * sign-in fetched the new picture and then threw it away.
 */
export function attachAvatar(
  dir: string,
  subjectQualified: string,
  avatar: string,
  source: string,
  /** What the stored source was when this fetch STARTED. See below. */
  expected: string | undefined,
): void {
  withLock(dir, () => {
    const store = loadStore(dir)
    // By SUBJECT, not by email.
    //
    // The email was read before the fetch, and a fetch is a network round trip
    // during which things move: the subject can be renamed, and the address
    // they vacated can be taken by another admitted account. Coming back and
    // looking up that address would then attach one person's face to somebody
    // else's account. The subject is the one identifier that does not move.
    const user = store.users.find((u) => u.idSubject === subjectQualified)
    if (!user) return
    if (user.avatar && !user.avatarSource) return      // theirs, not ours

    // Compare and swap, not "is it different".
    //
    // Two sign-ins can be in flight at once, and the slower one must not win.
    // Asking whether the stored source differs from ours does not achieve that:
    // if B lands first and a stale A arrives afterwards, A differs from B, so A
    // happily overwrites the newer picture. What has to hold is that nothing
    // changed underneath us - the stored source is still the one this fetch set
    // out to replace. Anything else means somebody got there first, and the
    // right move is to do nothing.
    if (user.avatarSource !== expected) return

    user.avatar = avatar
    user.avatarSource = source
    saveStore(dir, store)
  })
}

/**
 * Would a picture from the identity service actually be used?
 *
 * Read-only and outside the lock, so the gate can decide whether a network
 * fetch is worth making before it commits to one. Worst case it is wrong and we
 * fetch a picture that then gets discarded - which costs one request, versus
 * fetching an avatar on every single sign-in forever.
 */
export function avatarSourceFor(
  dir: string,
  subjectQualified: string,
  email: string,
  pictureUrl?: string,
): { wanted: boolean; source: string | undefined } {
  const store = loadStore(dir)
  const user = store.users.find((u) => u.idSubject === subjectQualified) ?? findUser(store, normEmail(email))
  if (!user) return { wanted: true, source: undefined }            // new account
  if (!user.avatar) return { wanted: true, source: user.avatarSource }
  if (!user.avatarSource) return { wanted: false, source: undefined } // theirs, never replaced
  return { wanted: user.avatarSource !== pictureUrl, source: user.avatarSource }
}

/**
 * Would a picture from the identity service actually be used?
 *
 * Read-only and outside the lock, so the gate can decide whether a network
 * fetch is worth making before it commits to one. Worst case it is wrong and we
 * fetch a picture that then gets discarded - which costs one request, versus
 * fetching an avatar on every single sign-in forever.
 */
export function wantsAvatarFrom(dir: string, subjectQualified: string, email: string, pictureUrl: string): boolean {
  return avatarSourceFor(dir, subjectQualified, email, pictureUrl).wanted
}

function pushSession(store: Store, user: User): string {
  const raw = token()
  store.sessions.push({ tokenHash: sha256(raw), emailNorm: normEmail(user.email), exp: Date.now() + SESSION_TTL })
  return raw
}

export function sessionUser(dir: string, rawToken: string): User | null {
  const store = loadStore(dir)
  const hash = sha256(rawToken)
  const s = store.sessions.find((s) => s.tokenHash === hash && s.exp > Date.now())
  if (!s) return null
  // An operator-minted session is only as alive as the secret that minted it. The
  // operator cannot revoke the owner's account - the store refuses to remove its
  // last owner - so rotation is the lever they actually have, and it has to work.
  if (s.via && s.via !== operatorFingerprint()) return null
  return store.users.find((u) => normEmail(u.email) === s.emailNorm) ?? null
}

/** The shortest `MARVER_CLI_TOKEN` worth honouring. Nothing rate-limits this
 *  credential and nothing slows a guess down, so its entropy is the whole
 *  defence - and a length floor is the only part of entropy a program can check.
 *  `openssl rand -hex 24` clears it with room to spare. */
export const MIN_CLI_TOKEN = 32

/** The alphabet a bearer token can actually travel in: both the gate and the API
 *  parse `Authorization` with `[\w-]+`, so a secret containing anything else is
 *  accepted at boot and then silently unusable. Checked HERE as well as at boot so
 *  the two can never drift apart. */
export const CLI_TOKEN_CHARS = /^[\w-]+$/

/**
 * The operator's own credential, read from the deployment environment.
 *
 * `comments connect` authenticates with a password, and an identity account has
 * none by design - so on an identity-gated canvas the whole CLI surface (invite,
 * revoke, and the comment sync the agent loop runs on) had no reachable
 * credential. This is the door, and where it lives is the entire point.
 *
 * The obvious alternative - a page that mints a token for whoever is signed in -
 * is the device flow this project already built and pulled (2d0850c). Authored
 * frames run same-origin in a canvas: frame JavaScript reads `mv_c`, every
 * request it makes carries the viewer's session, so any browser-reachable way to
 * mint a durable token is a way for a frame to mint one silently and carry it
 * off. There is no header that separates a frame from its own origin.
 *
 * An environment variable is on the other side of that line. It is never sent to
 * a page, no frame can read it, and reaching it already means reaching the
 * deployment - at which point the canvas was never the weakest thing in the room.
 * The cost is honest: it is a static secret that rotates by redeploying, and it
 * acts as the owner, so it is an operator credential rather than a person's.
 */
export function operatorUser(dir: string, presented: string): User | null {
  return operatorMatch(presented) ? ownerOf(dir) : null
}

/** The owner's account, or null on a canvas nobody has claimed yet. Chosen by
 *  stored ROLE, never by array order or by whatever MARVER_OWNER_EMAIL currently
 *  says - that variable only ever nominated a bootstrap account, and honouring it
 *  afterwards would let a changed environment repoint this at a different person. */
const ownerOf = (dir: string): User | null => loadStore(dir).users.find((u) => u.role === 'owner') ?? null

/**
 * Why a configured `MARVER_CLI_TOKEN` is unusable, or null when it is fine.
 *
 * One function so that boot and the matcher can never disagree. They did: boot
 * trimmed the value before checking it while `comments connect` sent the shell's
 * value as-is, so `" abcd... "` started a canvas that then refused the operator's
 * own token with no explanation anywhere. Surrounding whitespace is now a refusal
 * rather than something quietly repaired on one side of the wire.
 */
export function cliTokenProblem(raw: string): string | null {
  if (!raw) return null                                    // unset is a choice, not a mistake
  if (raw !== raw.trim())
    return 'MARVER_CLI_TOKEN has whitespace around it - quote it, or drop the quotes that put it there'
  if (raw.length < MIN_CLI_TOKEN)
    return `MARVER_CLI_TOKEN is too short to be a bearer credential (${raw.length} chars, needs ${MIN_CLI_TOKEN})`
  if (!CLI_TOKEN_CHARS.test(raw))
    return 'MARVER_CLI_TOKEN contains characters that cannot travel in an Authorization header'
  return null
}

/** The configured secret, or '' when there is none worth honouring. Never trimmed
 *  into shape: a value that needed trimming was refused at boot. */
const operatorSecret = (): string => {
  const raw = process.env.MARVER_CLI_TOKEN ?? ''
  return raw && !cliTokenProblem(raw) ? raw : ''
}

/** A fingerprint of the current secret, so a session can record WHICH one minted
 *  it. The hash, never the value: this is written to auth.json, and a store that
 *  quietly contains the operator's credential is the thing being avoided. */
const operatorFingerprint = (): string => {
  const secret = operatorSecret()
  return secret ? sha256(`cli-generation:${secret}`) : ''
}

function operatorMatch(presented: string): boolean {
  const secret = operatorSecret()
  if (!secret || !presented) return false
  // Compared as digests so the two are always the same length: timingSafeEqual
  // throws on a length mismatch, and catching that throw would leak the length
  // of the secret through which guesses cost nothing.
  return timingSafeEqual(Buffer.from(sha256(presented), 'hex'), Buffer.from(sha256(secret), 'hex'))
}

/**
 * Trade the operator's secret for an ordinary session, once, from the terminal.
 *
 * The secret itself must not become the thing a repo carries. `connect` persists
 * whatever it is given, and that file sits on a developer's disk for as long as
 * the project lasts - a non-expiring master key is the wrong shape for it. What comes back here expires, dies with
 * `comments revoke`, and can be replaced without touching the deployment.
 *
 * Only the operator secret opens this. Deliberately NOT any signed-in session:
 * authored frames run same-origin and ride the viewer's cookies, so a route that
 * minted sessions for whoever was signed in would be the pulled device flow
 * (2d0850c) with a different name. A frame cannot present this Bearer, because
 * the value it needs was never in the browser.
 */
export function issueDeviceSession(dir: string, presented: string): { token: string; exp: number; user: User } | null {
  if (!operatorMatch(presented)) return null
  return withLock(dir, () => {
    const store = loadStore(dir)
    const user = store.users.find((u) => u.role === 'owner')
    if (!user) return null
    const token = pushSession(store, user)
    // Stamp it with the generation of the secret that asked. Rotating
    // MARVER_CLI_TOKEN then ends every session it ever minted - the only
    // revocation lever an operator has over a credential that acts as the owner,
    // since the store refuses to delete its last owner.
    store.sessions[store.sessions.length - 1].via = operatorFingerprint()
    saveStore(dir, store)
    return { token, exp: Date.now() + SESSION_TTL, user }
  })
}

export function signOut(dir: string, rawToken: string) {
  withLock(dir, () => {
  const store = loadStore(dir)
  const hash = sha256(rawToken)
  store.sessions = store.sessions.filter((s) => s.tokenHash !== hash)
  saveStore(dir, store)
  })
}

/** Update name/avatar on an existing account. */
export function updateProfile(dir: string, email: string, patch: { name?: string; avatar?: string }) {
  return withLock(dir, () => {
  const store = loadStore(dir)
  const user = findUser(store, email)
  if (!user) throw new Error('no such account')
  if (patch.name?.trim()) user.name = patch.name.trim()
  if (patch.avatar !== undefined) {
    user.avatar = patch.avatar || undefined
    // Setting your own picture makes it YOURS, so the record of where the last
    // one came from has to go with it. Left behind, the account still looks
    // like it is carrying an identity-service avatar, and the next rotation
    // would overwrite the one they just chose.
    user.avatarSource = undefined
  }
  saveStore(dir, store)
  return user
  })
}

/** Remove an account and all its sessions (owner action). The LAST owner cannot be
 *  removed - a store with members but no owner has no one left to administer it,
 *  and bootstrap will not re-run while any user exists. */
export function revokeUser(dir: string, email: string) {
  withLock(dir, () => {
  const store = loadStore(dir)
  const target = store.users.find((u) => normEmail(u.email) === normEmail(email))
  if (target?.role === 'owner' && !store.users.some((u) => u.role === 'owner' && normEmail(u.email) !== normEmail(email)))
    throw new Error('cannot remove the last owner - the canvas would have no administrator left')
  store.users = store.users.filter((u) => normEmail(u.email) !== normEmail(email))
  store.sessions = store.sessions.filter((s) => s.emailNorm !== normEmail(email))
  store.invites = store.invites.filter((i) => i.emailNorm !== normEmail(email))
  saveStore(dir, store)
  })
}

/** The public shape of a user - what other viewers (and events) may see. */
export const publicUser = (u: User) => ({ email: u.email, name: u.name, avatar: u.avatar })
