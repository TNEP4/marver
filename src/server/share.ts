/**
 * The sharing roster and the ONE resolver (01-sharing §4-5, 04-solution §2.2).
 *
 * `share.json` lives beside `auth.json` on the volume and is the only grant
 * store. `publish.json` (via meta.json `rights`) stays the per-board CEILING;
 * this file holds who was granted what and until when. The resolver is a pure
 * function - blocklist first, then the highest matching grant, then the ceiling
 * clamps - and it is consulted at every door: gate admission, identity
 * provisioning, comment writes, request-access eligibility and SSE
 * re-authorization. One function, five doors, so no door can drift.
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
 * every caller falls back to the legacy rules it always had.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
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
  /** A boot-time snapshot of the publish ceilings (meta.json rights), written by
   *  every re-clamp. NOT a new authority - meta.json stays the policy transport
   *  and ceilings only change at a deploy, which is a boot, which rewrites this.
   *  It exists so callers without the dist in reach (identity provisioning,
   *  invite redemption) can materialise and check grants against the same
   *  ceilings the serving process enforces with. */
  ceilings: Ceilings
}

const RANK: Record<ShareRole, number> = { none: 0, view: 1, comment: 2 }
export const roleMin = (a: ShareRole, b: ShareRole): ShareRole => (RANK[a] <= RANK[b] ? a : b)
export const roleMax = (a: ShareRole, b: ShareRole): ShareRole => (RANK[a] >= RANK[b] ? a : b)

export const shareFile = (dir: string) => join(dir, 'share.json')

/** meta.json rights → ceilings. `read` publishes at view; `comment` at comment. */
export const ceilingsFromRights = (rights: Record<string, 'read' | 'comment'>): Ceilings =>
  Object.fromEntries(Object.entries(rights).map(([b, r]) => [b, r === 'comment' ? 'comment' : 'view']))

/** Null when no share.json exists (pre-migration) - callers keep legacy rules.
 *  A present-but-corrupt file fails CLOSED, same doctrine as auth.json. */
export function loadShare(dir: string): ShareStore | null {
  let raw: string
  try { raw = readFileSync(shareFile(dir), 'utf8') }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`share store unreadable (${(err as Error).message}) - refusing to treat it as absent`)
  }
  let parsed: any
  try { parsed = JSON.parse(raw) } catch { throw new Error('share store is corrupt JSON - refusing to treat it as absent. Restore it or delete it deliberately.') }
  if (!Array.isArray(parsed?.grants) || !Array.isArray(parsed?.blocked) || typeof parsed?.general?.mode !== 'string')
    throw new Error('share store has an unexpected shape - refusing to load it')
  parsed.ceilings ??= {}
  return parsed
}

/** Atomic rewrite; expired grants garbage-collect on every write, the same sweep
 *  invites and sessions already ride. 0600 - the roster is a list of addresses. */
export function saveShare(dir: string, store: ShareStore) {
  const now = Date.now()
  store.grants = store.grants.filter((g) => !g.expires || Date.parse(g.expires) > now)
  const file = shareFile(dir)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try { writeSync(fd, JSON.stringify(store, null, 2)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
}

// ---- request-path reads: mtime-cached so the gate can consult the roster on
// every request without re-parsing a file that changes rarely ----
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
    store.ceilings = ceilings
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
      ceilings,
    }
    saveShare(dir, store)
    return { created: true }
  }, '.share.lock')
}

/** Upsert a grant (idempotent by principal+scope) and materialise its entries
 *  against the store's boot ceilings. Re-granting REPLACES: new assigned, fresh
 *  ratchet - the owner just said so. */
export function upsertGrant(
  dir: string,
  input: { principal: string; scope: ShareGrant['scope']; assigned: 'view' | 'comment'; expires?: string | null; by: string },
): ShareGrant {
  return withLock(dir, () => {
    const store = loadShare(dir)
    if (!store) throw new Error('no share store - the canvas has not booted under v2 yet')
    const principal = input.principal.startsWith('@') ? input.principal.toLowerCase().trim() : normEmail(input.principal)
    store.grants = store.grants.filter((g) => !(g.principal === principal && g.scope === input.scope))
    const g: ShareGrant = {
      principal, scope: input.scope, assigned: input.assigned, boardRole: {},
      expires: input.expires ?? null, by: input.by, at: new Date().toISOString(),
    }
    materialise(g, store.ceilings)
    store.grants.push(g)
    saveShare(dir, store)
    return g
  }, '.share.lock')
}

/** An unexpired v1 invite, redeemed after migration, materialises the same
 *  canvas-scoped comment grant an existing account received (01-sharing §10) -
 *  because that is exactly what claiming it would have produced under v1.
 *  A no-op before migration (no store) and on an address already granted. */
export function grantFromInviteRedemption(dir: string, email: string) {
  const store = shareState(dir)
  if (!store) return
  const principal = normEmail(email)
  if (store.grants.some((g) => g.principal === principal && g.scope === 'canvas')) return
  upsertGrant(dir, { principal, scope: 'canvas', assigned: 'comment', by: 'invite' })
}

/** Provisioning's question, answerable without the dist in reach: may this
 *  address be admitted on the strength of the roster alone. `blocked` beats
 *  everything; `granted` means a live grant reaches ≥ view on some published
 *  board (boardRole entries are already ceiling-clamped, so any entry ≥ view
 *  is an entry through a real door). */
export function provisionVerdict(store: ShareStore, email: string): 'blocked' | 'granted' | 'none' {
  const norm = normEmail(email)
  if (store.blocked.some((b) => normEmail(b) === norm)) return 'blocked'
  const now = Date.now()
  const ok = store.grants.some((g) =>
    live(g, now) && grantMatches(g, norm) &&
    Object.entries(g.boardRole).some(([b, r]) => b in store.ceilings && RANK[r] >= RANK.view))
  return ok ? 'granted' : 'none'
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
 */
export function resolveAccess(input: {
  email: string | null
  userRole?: 'owner' | 'member'
  store: ShareStore
  ceilings: Ceilings
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

  const matching = email ? store.grants.filter((g) => live(g, now) && grantMatches(g, email)) : []
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

  if (input.userRole === 'owner') trace.push({ where: 'role', role: roleMin('comment', 'comment'), why: 'canvas owner - precedes principal matching', win: true })
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

/** The operative general mode: what the environment can actually enforce clamps
 *  what the roster asks for. No gate can only be Public; a password gate cannot
 *  be Public (the password would be theater); an identity gate is Private in v1. */
export function operativeMode(stored: GeneralMode, env: { password: boolean; issuer: boolean }): GeneralMode {
  if (env.issuer) return 'private'
  if (env.password) return stored === 'private' ? 'private' : 'password'
  return 'public'
}
