/**
 * The sharing roster and the ONE resolver (01-sharing §4-5, 04-solution §2.2).
 *
 * `share.json` lives beside `auth.json` on the volume and is the only grant
 * store. `publish.json` (via meta.json `rights`) stays the per-board CEILING;
 * this file holds who was granted what and until when. The resolver is a pure
 * function - blocklist first, then the highest matching grant, then the ceiling
 * clamps - and it is consulted at every door: gate admission, identity
 * provisioning, password sign-in, comment writes, request-access eligibility
 * and SSE re-authorization. One function, so no door can drift.
 *
 * The non-promotion invariant is carried by two mechanics and nothing else:
 * reads always use `min(current ceiling, grant.boardRole[b])`, and every boot
 * re-clamps `boardRole[b] = min(previous ?? assigned, ceiling[b])` - ceilings
 * pull entries down, never up. A later ceiling rise leaves the entry low, which
 * is exactly the condition the owner's re-confirm action raises. No version
 * hashes, no reconcile ceremony.
 *
 * No share.json = pre-migration 0.11 behaviour, exactly. The file is created
 * once at serve boot from the migration matrix (01-sharing §10); until then
 * every caller falls back to the legacy rules it always had. A present but
 * corrupt or malformed file fails CLOSED - a policy typo must deny, never
 * quietly grant the ceiling.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { normEmail, withLock, type User } from './auth.ts'

export type ShareRole = 'none' | 'view' | 'comment'
export type GeneralMode = 'private' | 'password' | 'public'
export type Ceilings = Record<string, ShareRole>            // per PUBLISHED board

export interface ShareGrant {
  /** `sam@openai.com` (exact address) or `@openai.com` (any verified address there). */
  principal: string
  scope: 'canvas' | `board:${string}`
  /** What the owner asked for - display-only, NEVER read for authorization. */
  assigned: Exclude<ShareRole, 'none'>
  /** The per-board ratchet. Reads use min(ceiling[b], boardRole[b]); the boot
   *  re-clamp writes it; only the owner's explicit re-confirm raises an entry. */
  boardRole: Record<string, ShareRole>
  expires: string | null
  by: string
  at: string
}

export interface ShareStore {
  version: 1
  general: { mode: GeneralMode; role: 'view' }
  blocked: string[]
  grants: ShareGrant[]
}

const RANK: Record<ShareRole, number> = { none: 0, view: 1, comment: 2 }
export const roleMin = (a: ShareRole, b: ShareRole): ShareRole => (RANK[a] <= RANK[b] ? a : b)
export const roleMax = (a: ShareRole, b: ShareRole): ShareRole => (RANK[a] >= RANK[b] ? a : b)

export const shareFile = (dir: string) => join(dir, 'share.json')

/** meta.json rights → ceilings. `read` publishes at view; `comment` at comment. */
export const ceilingsFromRights = (rights: Record<string, 'read' | 'comment'>): Ceilings =>
  Object.fromEntries(Object.entries(rights).map(([b, r]) => [b, r === 'comment' ? 'comment' : 'view']))

const ROLES = new Set<string>(['none', 'view', 'comment'])
const MODES = new Set<string>(['private', 'password', 'public'])

/** Fail CLOSED on anything malformed: an unknown role string must never rank
 *  above a real one, and a misspelt mode must never open the anonymous door. */
function validateStore(p: any): asserts p is ShareStore {
  const bad = (why: string) => { throw new Error(`share store is malformed (${why}) - refusing to load it. Fix or delete it deliberately.`) }
  if (p?.version !== 1) bad('version must be 1')
  if (!MODES.has(p?.general?.mode)) bad(`general.mode "${p?.general?.mode}"`)
  if (p?.general?.role !== 'view') bad('general.role must be "view"')
  if (!Array.isArray(p?.blocked) || p.blocked.some((b: unknown) => typeof b !== 'string')) bad('blocked must be addresses')
  if (!Array.isArray(p?.grants)) bad('grants must be an array')
  for (const g of p.grants) {
    if (typeof g?.principal !== 'string' || !g.principal) bad('grant principal')
    if (g?.scope !== 'canvas' && !(typeof g?.scope === 'string' && g.scope.startsWith('board:'))) bad(`grant scope "${g?.scope}"`)
    if (g?.assigned !== 'view' && g?.assigned !== 'comment') bad(`grant assigned "${g?.assigned}"`)
    if (typeof g?.boardRole !== 'object' || g.boardRole === null) bad('grant boardRole')
    for (const r of Object.values(g.boardRole)) if (!ROLES.has(r as string)) bad(`boardRole value "${r}"`)
    if (g?.expires !== null && typeof g?.expires !== 'string') bad('grant expires')
  }
}

/** Null when no share.json exists (pre-migration) - callers keep legacy rules.
 *  A present-but-unreadable/corrupt/malformed file fails CLOSED. */
export function loadShare(dir: string): ShareStore | null {
  let raw: string
  try { raw = readFileSync(shareFile(dir), 'utf8') }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`share store unreadable (${(err as Error).message}) - refusing to treat it as absent`)
  }
  let parsed: any
  try { parsed = JSON.parse(raw) } catch { throw new Error('share store is corrupt JSON - refusing to treat it as absent. Restore it or delete it deliberately.') }
  validateStore(parsed)
  return parsed
}

/** Atomic rewrite; expired grants garbage-collect on every write, the same sweep
 *  invites and sessions already ride. 0600 - the roster is a list of addresses.
 *  The request-path cache is refreshed HERE, in-process: the supported setup is
 *  single-instance, so the writer and every reader share this module, and an
 *  mtime tie on a coarse filesystem can never serve a pre-revoke roster. */
export function saveShare(dir: string, store: ShareStore) {
  const now = Date.now()
  store.grants = store.grants.filter((g) => !g.expires || Date.parse(g.expires) > now)
  const file = shareFile(dir)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try { writeSync(fd, JSON.stringify(store, null, 2)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
  cache.set(dir, { mtime: statSync(file).mtimeMs, store })
}

// ---- request-path reads: cached so the gate can consult the roster on every
// request without re-parsing. Writes refresh the cache directly (above); the
// mtime check only covers out-of-band edits (an owner hand-editing the file).
const cache = new Map<string, { mtime: number; store: ShareStore | null }>()
export function shareState(dir: string): ShareStore | null {
  const file = shareFile(dir)
  let mtime = -1
  try { mtime = statSync(file).mtimeMs } catch { /* absent */ }
  const hit = cache.get(dir)
  if (hit && hit.mtime === mtime) return hit.store
  const store = mtime < 0 ? null : loadShare(dir)
  cache.set(dir, { mtime, store })
  return store
}

/** Materialise boardRole entries for a grant, clamped: canvas scope covers every
 *  published board, a board scope exactly its board. Existing entries are kept
 *  (the ratchet) unless the ceiling pulls them down. */
function materialise(g: ShareGrant, ceilings: Ceilings) {
  const boards = g.scope === 'canvas' ? Object.keys(ceilings) : [g.scope.slice('board:'.length)]
  for (const b of boards) {
    if (!(b in ceilings)) continue
    g.boardRole[b] = roleMin(g.boardRole[b] ?? g.assigned, ceilings[b])
  }
}

/** The boot re-clamp (01-sharing §3.6): atomically, before serving. Ceilings
 *  pull entries down never up; boards new to this build get entries at
 *  min(assigned, ceiling). Entries for boards no longer published are kept -
 *  the ratchet must survive a board leaving and returning. */
export function reclampShare(dir: string, ceilings: Ceilings) {
  withLock(dir, () => {
    const store = loadShare(dir)
    if (!store) return
    for (const g of store.grants) {
      materialise(g, ceilings)
      for (const b of Object.keys(g.boardRole)) if (b in ceilings) g.boardRole[b] = roleMin(g.boardRole[b], ceilings[b])
    }
    saveShare(dir, store)
  }, '.share.lock')
}

/**
 * First-boot migration (01-sharing §10): every live 0.11 canvas keeps its exact
 * behaviour. The generated roster is a normal file the owner can read; creating
 * it is logged by the caller. Existing accounts each get a canvas-scoped
 * `comment` grant (clamped per board) because that is precisely what they could
 * do yesterday; general access mirrors the gate the environment configures.
 */
export function ensureShare(dir: string, mode: GeneralMode, users: User[], ceilings: Ceilings): { created: boolean } {
  return withLock(dir, () => {
    if (existsSync(shareFile(dir))) return { created: false }
    const at = new Date().toISOString()
    const store: ShareStore = {
      version: 1,
      general: { mode, role: 'view' },
      blocked: [],
      grants: users.map((u) => {
        const g: ShareGrant = {
          principal: normEmail(u.email), scope: 'canvas', assigned: 'comment',
          boardRole: {}, expires: null, by: 'migration', at,
        }
        materialise(g, ceilings)
        return g
      }),
    }
    saveShare(dir, store)
    return { created: true }
  }, '.share.lock')
}

/** Upsert a grant (idempotent by principal+scope) and materialise its entries.
 *  Re-granting REPLACES: new assigned, fresh ratchet - the owner just said so.
 *
 *  v1 accepts `scope: "canvas"` ONLY (04-solution §9.4): before read privacy
 *  exists, a board-scoped grant would open the whole bundle while reading as
 *  "just this board" - the schema stays v2-ready, the door refuses. Domain
 *  principals need the identity gate: a canvas that cannot verify addresses
 *  cannot verify domains (01-sharing §4.4), and they ship only together with
 *  the blocklist, which is why creation demands `identityMode`. */
export function upsertGrant(
  dir: string, ceilings: Ceilings,
  input: { principal: string; scope: ShareGrant['scope']; assigned: 'view' | 'comment'; expires?: string | null; by: string },
  opts: { identityMode?: boolean } = {},
): ShareGrant & {
  /** False when an equivalent live grant already existed (same principal,
   *  scope and role) - the caller's "was this a real state transition"
   *  question, which is what decides whether an invite mail goes out. */
  changed: boolean
} {
  if (input.scope !== 'canvas') throw new Error('v1 accepts canvas-scoped grants only - board scopes arrive with read privacy (v2)')
  if (input.principal.startsWith('@') && !opts.identityMode)
    throw new Error('domain grants need the identity gate - a password canvas cannot verify who holds an address')
  return withLock(dir, () => {
    const store = loadShare(dir)
    if (!store) throw new Error('no share store - the canvas has not booted under v2 yet')
    const principal = input.principal.startsWith('@') ? input.principal.toLowerCase().trim() : normEmail(input.principal)
    const now = Date.now()
    const prior = store.grants.find((g) => g.principal === principal && g.scope === input.scope && live(g, now))
    const changed = !prior || prior.assigned !== input.assigned
    store.grants = store.grants.filter((g) => !(g.principal === principal && g.scope === input.scope))
    const g: ShareGrant = {
      principal, scope: input.scope, assigned: input.assigned,
      // a SAME-ROLE upsert (an expiry tweak, a re-add) carries the ratchet
      // FORWARD - rematerialising from scratch after a ceiling dip-and-rise
      // would silently restore the higher role without the owner's re-confirm,
      // which is the exact invariant the ratchet exists for. A role CHANGE is
      // the owner's fresh statement, and a fresh ratchet is what it means.
      boardRole: !changed && prior ? { ...prior.boardRole } : {},
      expires: input.expires ?? null, by: input.by, at: new Date().toISOString(),
    }
    materialise(g, ceilings)
    store.grants.push(g)
    saveShare(dir, store)
    return { ...g, changed }
  }, '.share.lock')
}

/** Remove every grant held by an exact principal. Ridden by account revocation:
 *  `revokeUser` alone would leave the grant behind, and on an identity canvas
 *  the next sign-in would quietly re-provision the account it just removed. */
export function removePrincipalGrants(dir: string, email: string) {
  withLock(dir, () => {
    const store = loadShare(dir)
    if (!store) return
    const norm = normEmail(email)
    const before = store.grants.length
    store.grants = store.grants.filter((g) => g.principal !== norm)
    if (store.grants.length !== before) saveShare(dir, store)
  }, '.share.lock')
}

/** Follow a verified rename: exact grants move to the address the same subject
 *  now holds - the owner granted the person, and the address is a label on
 *  them (docs promise: renames follow the subject). Domain grants never move;
 *  they simply re-evaluate against the new address. A grant already existing
 *  for the new address wins (it is the newer statement of intent). */
export function renamePrincipalGrants(dir: string, fromEmail: string, toEmail: string) {
  withLock(dir, () => {
    const store = loadShare(dir)
    if (!store) return
    const from = normEmail(fromEmail), to = normEmail(toEmail)
    let changed = false
    for (const g of store.grants) {
      if (g.principal !== from) continue
      if (store.grants.some((o) => o !== g && o.principal === to && o.scope === g.scope)) continue
      g.principal = to
      changed = true
    }
    if (changed) {
      store.grants = store.grants.filter((g) => g.principal !== from)
      saveShare(dir, store)
    }
  }, '.share.lock')
}

// ---- the resolver ----

export interface TraceStep { where: string; role: ShareRole; why: string; win: boolean }
export interface Resolution {
  /** May this person open the canvas at all: ≥ view on at least one board. */
  entry: boolean
  /** Effective role per published board. */
  boards: Record<string, ShareRole>
  /** The canvas-wide summary: the highest board role. */
  role: ShareRole
  trace: TraceStep[]
}

const domainOf = (email: string) => normEmail(email).split('@')[1] ?? ''
const grantMatches = (g: ShareGrant, email: string): boolean =>
  g.principal.startsWith('@') ? g.principal.slice(1) === domainOf(email) : g.principal === normEmail(email)
const live = (g: ShareGrant, now: number) => !g.expires || Date.parse(g.expires) > now

/**
 * The pure resolver. Blocklist first (the only deny), then grants additive
 * (highest wins, read through the boardRole ratchet with the read-time ceiling
 * min), general access contributes `view` when the mode is not Private, and the
 * owner/operator ROLE precedes principal matching exactly as `admin` does today
 * (clamped by the ceiling like everything else - an unpublished board is empty
 * even for the owner).
 *
 * `email: null` is an anonymous caller - someone past a password gate or on a
 * public canvas. They have no principal to match and cannot be blocked (there
 * is no identity to block), which is 01-sharing §3.4 stated as code.
 *
 * `exactOnly` drops domain grants from consideration: the password sign-in
 * door uses it, because domain membership is only meaningful when an identity
 * service verified the address (01-sharing §4.4).
 */
export function resolveAccess(input: {
  email: string | null
  userRole?: 'owner' | 'member'
  store: ShareStore
  ceilings: Ceilings
  exactOnly?: boolean
}): Resolution {
  const { store, ceilings } = input
  const email = input.email ? normEmail(input.email) : null
  const now = Date.now()
  const trace: TraceStep[] = []
  const boards: Record<string, ShareRole> = {}

  if (email && store.blocked.some((b) => normEmail(b) === email)) {
    for (const b of Object.keys(ceilings)) boards[b] = 'none'
    trace.push({ where: 'blocklist', role: 'none', why: `${email} is blocked - refused everywhere, ahead of every grant`, win: true })
    return { entry: false, boards, role: 'none', trace }
  }
  trace.push({ where: 'blocklist', role: 'none', why: email ? 'not blocked' : 'anonymous - no identity to block', win: false })

  const matching = email
    ? store.grants.filter((g) => live(g, now) && grantMatches(g, email) && !(input.exactOnly && g.principal.startsWith('@')))
    : []
  const anonView: ShareRole = store.general.mode !== 'private' ? 'view' : 'none'

  let top: ShareRole = 'none'
  for (const b of Object.keys(ceilings)) {
    let r: ShareRole = 'none'
    if (input.userRole === 'owner') r = roleMin('comment', ceilings[b])
    for (const g of matching) r = roleMax(r, roleMin(g.boardRole[b] ?? 'none', ceilings[b]))
    r = roleMax(r, roleMin(anonView, ceilings[b]))
    boards[b] = r
    top = roleMax(top, r)
  }

  if (input.userRole === 'owner') trace.push({ where: 'role', role: 'comment', why: 'canvas owner - precedes principal matching', win: true })
  if (matching.length) {
    const best = matching.map((g) => `${g.principal} ${g.assigned}${g.expires ? ` until ${g.expires.slice(0, 10)}` : ''}`).join(', ')
    trace.push({ where: 'grants', role: top, why: `highest of: ${best}`, win: input.userRole !== 'owner' })
  } else if (email && input.userRole !== 'owner') {
    trace.push({ where: 'grants', role: 'none', why: 'no matching grant', win: false })
  }
  if (anonView !== 'none') trace.push({ where: 'general', role: 'view', why: `general access is ${store.general.mode} - anyone admitted reads`, win: top === 'view' && !matching.length && input.userRole !== 'owner' })
  trace.push({ where: 'ceiling', role: top, why: 'publish.json clamps per board - reads use min(ceiling, boardRole)', win: false })

  return { entry: RANK[top] >= RANK.view, boards, role: top, trace }
}

/** What the gate consults, request-path cheap: is this identified person still
 *  let in at all? Owner always is (someone must administer). Pre-migration
 *  (no store) keeps legacy behaviour: any valid session is gate passage. */
export function entryAllowed(dir: string, user: { email: string; role: 'owner' | 'member' }, ceilings: Ceilings): boolean {
  const store = shareState(dir)
  if (!store) return true
  if (user.role === 'owner') return true
  return resolveAccess({ email: user.email, userRole: user.role, store, ceilings }).entry
}

/** The comment seam's new internals: may this person write on this board.
 *  Pre-migration keeps today's rule (any signed-in user on a comment board). */
export function commentAllowed(dir: string, user: { email: string; role: 'owner' | 'member' }, board: string, ceilings: Ceilings): boolean {
  const store = shareState(dir)
  if (!store) return ceilings[board] === 'comment'
  if (ceilings[board] !== 'comment') return false
  return resolveAccess({ email: user.email, userRole: user.role, store, ceilings }).boards[board] === 'comment'
}

/**
 * The provisioning doors' question: may this address be admitted at all.
 * `blocked` beats everything. With ceilings in hand (every real server has
 * them) the answer is the ONE resolver's entry test; without them (bare test
 * harnesses only) it falls back to the materialised entries, which are
 * ceiling-clamped already. `aliases` lets a verified rename count the grants
 * the subject held under its previous address.
 */
export function provisionVerdict(
  store: ShareStore, email: string,
  opts: { ceilings?: Ceilings; exactOnly?: boolean; aliases?: string[] } = {},
): 'blocked' | 'granted' | 'none' {
  const addresses = [email, ...(opts.aliases ?? [])].map(normEmail)
  for (const a of addresses) if (store.blocked.some((b) => normEmail(b) === a)) return 'blocked'
  const now = Date.now()
  for (const a of addresses) {
    if (opts.ceilings) {
      if (resolveAccess({ email: a, store: { ...store, general: { mode: 'private', role: 'view' } }, ceilings: opts.ceilings, exactOnly: opts.exactOnly }).entry) return 'granted'
    } else if (store.grants.some((g) =>
      live(g, now) && grantMatches(g, a) && !(opts.exactOnly && g.principal.startsWith('@')) &&
      Object.values(g.boardRole).some((r) => RANK[r] >= RANK.view))) return 'granted'
  }
  return 'none'
}

/** An unexpired v1 invite, redeemed after migration, materialises the same
 *  canvas-scoped comment grant an existing account received (01-sharing §10) -
 *  because that is exactly what claiming it would have produced under v1.
 *  A no-op before migration (no store) and on an address already granted. */
export function grantFromInviteRedemption(dir: string, email: string, ceilings: Ceilings = {}) {
  const store = shareState(dir)
  if (!store) return
  const principal = normEmail(email)
  if (store.grants.some((g) => g.principal === principal && g.scope === 'canvas')) return
  upsertGrant(dir, ceilings, { principal, scope: 'canvas', assigned: 'comment', by: 'invite' })
}

/** The operative general mode: what the environment can actually enforce clamps
 *  what the roster asks for. No gate can only be Public; a password gate cannot
 *  be Public (the password would be theater); an identity gate is Private in v1. */
export function operativeMode(stored: GeneralMode, env: { password: boolean; issuer: boolean }): GeneralMode {
  if (env.issuer) return 'private'
  if (env.password) return stored === 'private' ? 'private' : 'password'
  return 'public'
}

// ---- roster mutations (the owner API's verbs, 04-solution §9.4) ----

/** The strong ETag mutations are conditioned on: a hash of the exact stored
 *  roster bytes - share.json AND the pending requests, because approving a
 *  request is a mutation the roster read included, and a replay after any
 *  intervening change (a re-ask, a decline) must fail its precondition. */
export function rosterEtag(dir: string): string {
  let raw = ''
  try { raw = readFileSync(shareFile(dir), 'utf8') } catch { /* absent = empty */ }
  let reqRaw = ''
  try { reqRaw = readFileSync(join(dir, 'requests.json'), 'utf8') } catch { /* none */ }
  return createHash('sha256').update(raw).update('\n').update(reqRaw).digest('hex').slice(0, 32)
}

export function removeGrant(dir: string, principal: string, scope: ShareGrant['scope']) {
  withLock(dir, () => {
    const store = loadShare(dir)
    if (!store) return
    const norm = principal.startsWith('@') ? principal.toLowerCase().trim() : normEmail(principal)
    const before = store.grants.length
    store.grants = store.grants.filter((g) => !(g.principal === norm && g.scope === scope))
    if (store.grants.length !== before) saveShare(dir, store)
  }, '.share.lock')
}

/** The re-confirm badge's verb: raises ONE board's ratchet entry back to
 *  min(assigned, ceiling) - the only thing that ever raises one (01-sharing §3.6). */
export function reconfirmGrant(dir: string, ceilings: Ceilings, principal: string, scope: ShareGrant['scope'], board: string) {
  withLock(dir, () => {
    const store = loadShare(dir)
    if (!store) throw new Error('no share store')
    const norm = principal.startsWith('@') ? principal.toLowerCase().trim() : normEmail(principal)
    const g = store.grants.find((x) => x.principal === norm && x.scope === scope)
    if (!g) throw new Error('no such grant')
    if (!(board in ceilings)) throw new Error('no such board')
    g.boardRole[board] = roleMin(g.assigned, ceilings[board])
    saveShare(dir, store)
  }, '.share.lock')
}

export function setGeneralMode(dir: string, mode: GeneralMode) {
  withLock(dir, () => {
    const store = loadShare(dir)
    if (!store) throw new Error('no share store')
    store.general = { mode, role: 'view' }
    saveShare(dir, store)
  }, '.share.lock')
}

export function setBlocked(dir: string, address: string, blocked: boolean) {
  withLock(dir, () => {
    const store = loadShare(dir)
    if (!store) throw new Error('no share store')
    const norm = normEmail(address)
    const has = store.blocked.some((b) => normEmail(b) === norm)
    if (blocked && !has) store.blocked.push(norm)
    else if (!blocked && has) store.blocked = store.blocked.filter((b) => normEmail(b) !== norm)
    else return
    saveShare(dir, store)
  }, '.share.lock')
}

// ---- pending access requests (01-sharing §7.6, 04-solution §9.3) ----
// Their own file: share.json is THE grant schema and requests are not grants.
// One pending row per address - a repeat replaces the note and requestedRole,
// never multiplies - with a 30-day expiry swept on every write.

export interface AccessRequest {
  email: string
  name?: string
  picture?: string
  requestedRole: 'view' | 'comment'
  /** What the refused link pointed at - context in v1, enforced scope in v2. */
  target?: string
  note?: string
  at: string
  exp: number
}

const requestsFile = (dir: string) => join(dir, 'requests.json')

export function loadRequests(dir: string): AccessRequest[] {
  try {
    const p = JSON.parse(readFileSync(requestsFile(dir), 'utf8'))
    const now = Date.now()
    return Array.isArray(p) ? p.filter((r) => typeof r?.email === 'string' && r.exp > now) : []
  } catch { return [] }
}

function saveRequests(dir: string, rows: AccessRequest[]) {
  const file = requestsFile(dir)
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try { writeSync(fd, JSON.stringify(rows)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
}

export function putRequest(dir: string, req: Omit<AccessRequest, 'at' | 'exp'>): { fresh: boolean; at: string } {
  return withLock(dir, () => {
    const existing = loadRequests(dir)
    // one pending row per address: a repeat replaces the note and role and is
    // NOT a fresh ask - the owner was already told once
    const fresh = !existing.some((r) => normEmail(r.email) === normEmail(req.email))
    const at = new Date().toISOString()
    const rows = existing.filter((r) => normEmail(r.email) !== normEmail(req.email))
    rows.push({ ...req, email: normEmail(req.email), at, exp: Date.now() + 30 * 24 * 3600_000 })
    saveRequests(dir, rows)
    return { fresh, at }
  }, '.share.lock')
}

/** Approving adds the grant (canvas-wide in v1 - the dialog says so) and
 *  resolves the row; declining just resolves it, silently to the asker. */
export function resolveRequest(dir: string, ceilings: Ceilings, email: string, approve: { assigned: 'view' | 'comment'; by: string } | null): boolean {
  const rows = loadRequests(dir)
  const row = rows.find((r) => normEmail(r.email) === normEmail(email))
  if (!row) return false
  if (approve) upsertGrant(dir, ceilings, { principal: row.email, scope: 'canvas', assigned: approve.assigned, by: approve.by })
  withLock(dir, () => {
    saveRequests(dir, loadRequests(dir).filter((r) => normEmail(r.email) !== normEmail(email)))
  }, '.share.lock')
  return true
}
