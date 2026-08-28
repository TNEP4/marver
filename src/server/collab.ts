/**
 * The collaboration API - mounted by serve under /__mv/api/* when
 * MARVER_DATA_DIR is set. Everything sits BEHIND the gate (the password stays the
 * outer READ boundary); accounts subdivide rights within it.
 *
 * Mutation protection (isolation path b): double-submit cookie. The shell
 * gets a JS-readable random cookie (mv_c) and must echo it in the x-mv-c header on
 * every POST; cross-origin pages and opaque-origin frames cannot read it. This stops
 * third-party pages cold; a frame in the user's own repo is trusted v1 - stated
 * plainly in the docs, replaced by real frame isolation in v1.1 without route changes.
 *
 * Live rail: SSE with a per-boot monotonic seq as the event id and a replay ring; a
 * reconnect inside the ring resumes seamlessly, anything else gets `resync` (client
 * refetches - logs are tiny). Heartbeat every 240s clears proxy idle cuts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvents, listBoards, readLog, type CommentEvent } from './comments.ts'
import { claimInvite, createInvite, inviteInfo, issueDeviceSession, loadStore, normEmail, opaqueId, ownerName, publicUser, revokeUser, sessionIsOperator, sessionUser, signIn, signOut, updateProfile, type User } from './auth.ts'
import { ceilingsFromRights, commentAllowed, entryAllowed, loadRequests, loadShare, putRequest, reconfirmGrant, removeGrant, resolveAccess, resolveRequest, rosterEtag, setBlocked, setGeneralMode, shareState, upsertGrant } from './share.ts'
import { canvasIdentity, deriveThreads, loadSeen, markSeen, signCanvasJws, unreadCount, verifyCanvasJws, type BoardThreads } from './summary.ts'
import { secureSuffix } from './secure-cookie.ts'

const MONTH = 30 * 24 * 3600
const MAX_BODY = 256 * 1024

type Rights = Record<string, 'read' | 'comment'>

/** The permission seam, per-person since the sharing release: `read` stays
 *  board-level (is it published - no read-privacy claim in v1), `admin` stays
 *  the owner role, and `comment` (which resolve/reopen ride, 01-sharing §7.4)
 *  asks the resolver - blocklist, grants, expiry, ceiling - freshly on every
 *  call, so a revocation or an expiry crossing bites on the next request.
 *  `dataDir` is what connects the seam to the roster; without a roster the
 *  legacy rule (any signed-in user on a comment board) is exactly what runs. */
export function can(user: User | null, rights: Rights, board: string, action: 'read' | 'comment' | 'resolve' | 'admin', dataDir?: string): boolean {
  if (action === 'read') return board in rights
  if (action === 'admin') return user?.role === 'owner'
  if (!user || rights[board] !== 'comment') return false
  if (!dataDir) return true
  return commentAllowed(dataDir, user, board, ceilingsFromRights(rights))
}

const EVENT_TYPES = new Set(['create', 'reply', 'edit', 'resolve', 'reopen', 'react', 'profile', 'reanchor'])
const ID_RE = /^[\w-]{8,64}$/
const MAX_BODY_TEXT = 10_000

/** An avatar the server will store: a raster data-URI whose ACTUAL decoded bytes
 *  match the declared type. The declared MIME alone is a lie an attacker controls
 *  (base64 SVG labelled image/png); the magic bytes are the truth. Capped small -
 *  the client downscales to a 128px jpeg (~15KB), 64KB is generous headroom. */
export function validAvatar(s: unknown): s is string {
  if (typeof s !== 'string' || s.length > 65536) return false
  const m = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(s)
  if (!m) return false
  let head: Buffer
  try { head = Buffer.from(m[2].slice(0, 24), 'base64') } catch { return false }
  const magic: Record<string, (b: Buffer) => boolean> = {
    jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
    gif: (b) => b.toString('latin1', 0, 4) === 'GIF8',
    webp: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  }
  return magic[m[1]]?.(head) ?? false
}

/** Reject anything the log must not absorb. Returns an error string or null.
 *  Events are append-only and synced by id, so acceptance is forever - validate hard. */
export function validateEvents(incoming: CommentEvent[], log: CommentEvent[], u: User, board: string): string | null {
  const now = Date.now()
  const creates = new Map<string, CommentEvent>()
  const authors = new Map<string, string>()               // commentId -> author email (create + reply)
  for (const ev of log) {
    if (ev.type === 'create' && ev.commentId && !creates.has(ev.commentId)) creates.set(ev.commentId, ev)
    if ((ev.type === 'create' || ev.type === 'reply') && ev.commentId && ev.author?.email && !authors.has(ev.commentId))
      authors.set(ev.commentId, ev.author.email.toLowerCase())
  }
  const me = u.email.toLowerCase()
  for (const ev of incoming) {
    if (!ev || typeof ev !== 'object') return 'malformed event'
    if (typeof ev.id !== 'string' || !ID_RE.test(ev.id)) return 'event id must be an 8-64 char token'
    if (!EVENT_TYPES.has(ev.type as string)) return `unknown event type "${ev.type}"`
    // Live Jam: agent provenance is daemon-only. A published client must never forge it
    // (would render a human comment as Marver). Synced agent replies, if ever enabled, take a
    // separate trusted path, not this authenticated-client validator.
    if ((ev as { agent?: unknown }).agent !== undefined || (ev as { agentMeta?: unknown }).agentMeta !== undefined)
      return 'agent provenance is daemon-only'
    // the opaque author id is a SERVER-projected field - a client-sent one would
    // land in the canonical log and fork it from every other copy
    if (ev.author && (ev.author as { id?: unknown }).id !== undefined)
      return 'author id is server-assigned'
    // past timestamps are legitimate (sync carries repo history); the FUTURE is the
    // attack surface - a far-future edit would win replay forever
    if (typeof ev.ts !== 'number' || ev.ts < 1_577_836_800_000 || ev.ts > now + 60_000)
      return 'event timestamp out of bounds'
    if (ev.board !== undefined && ev.board !== board) return 'event board does not match the endpoint'
    if (ev.body !== undefined && (typeof ev.body !== 'string' || ev.body.length > MAX_BODY_TEXT)) return 'body too long'
    const needsAuthor = ev.type === 'create' || ev.type === 'reply' || ev.type === 'react' || ev.type === 'edit' || ev.type === 'reanchor'
    if (needsAuthor && ev.author?.email?.toLowerCase() !== me)
      return 'event author must be the signed-in account'
    if (typeof ev.commentId !== 'string' || !ID_RE.test(ev.commentId)) {
      if (ev.type !== 'profile') return 'event needs a commentId'
    }
    switch (ev.type) {
      case 'create':
        if (creates.has(ev.commentId!)) return 'a thread with that id already exists'
        creates.set(ev.commentId!, ev)
        if (ev.author?.email) authors.set(ev.commentId!, ev.author.email.toLowerCase())
        break
      case 'reply':
        if (typeof ev.parentId !== 'string' || (!creates.has(ev.parentId) && !incoming.some((x) => x.type === 'create' && x.commentId === ev.parentId)))
          return 'reply parent does not exist'
        if (ev.author?.email) authors.set(ev.commentId!, ev.author.email.toLowerCase())
        break
      case 'edit': {
        const owner = authors.get(ev.commentId!)
        if (!owner) return 'cannot edit a comment that does not exist'
        if (owner !== me) return 'only the author can edit a comment'
        break
      }
      case 'resolve':
      case 'reopen':
        if (!creates.has(ev.commentId!) && !incoming.some((x) => x.type === 'create' && x.commentId === ev.commentId))
          return 'cannot resolve a thread that does not exist'
        break
      case 'reanchor': {
        // Live Jam: re-pin a thread (root) to a new element. Must target a real root, carry a
        // non-null anchor, and only the thread's author may move its pin (not any commenter).
        if (!creates.has(ev.commentId!) && !incoming.some((x) => x.type === 'create' && x.commentId === ev.commentId))
          return 'cannot reanchor a thread that does not exist'
        if (ev.anchor == null) return 'reanchor needs a new anchor'
        const owner = authors.get(ev.commentId!)
        if (owner && owner !== me) return 'only the thread author can reanchor'
        break
      }
    }
  }
  return null
}

export function collabHandler(dataDir: string, distDir: string) {
  let rights: Rights = {}
  let meta: { name?: string; boards?: Record<string, { type?: string }>; frontDoor?: boolean } = {}
  try {
    meta = JSON.parse(readFileSync(join(distDir, 'meta.json'), 'utf8'))
    rights = (meta as any).rights ?? {}
  } catch { /* no policy = no boards */ }
  const commentsDir = join(dataDir, 'comments')

  // ---- the front door's summary machinery (04-solution §9.1-9.2) ----
  // On only when the canvas already trusts an identity issuer, and not opted
  // out. The thread counters are MAINTAINED - built once here (boot reads the
  // logs anyway) and updated on each append - never rescanned per probe.
  const idIssuer = (process.env.MARVER_ID_ISSUER ?? '').trim() || null
  const publicOrigin = (process.env.MARVER_PUBLIC_ORIGIN ?? '').trim() || null
  const appOrigin = (process.env.MARVER_APP_ORIGIN ?? '').trim() || 'https://app.marver.design'
  const frontDoorOn = !!idIssuer && !!publicOrigin && meta.frontDoor !== false
  const threads = new Map<string, BoardThreads>()
  for (const b of Object.keys(rights)) threads.set(b, deriveThreads(readLog(commentsDir, b)))
  const boardType = (b: string) => meta.boards?.[b]?.type ?? 'mix'
  const cors = (res: ServerResponse) => {
    res.setHeader('access-control-allow-origin', appOrigin)
    res.setHeader('vary', 'origin')
    res.setHeader('access-control-allow-methods', 'GET, OPTIONS')
    res.setHeader('access-control-allow-headers', 'authorization')
    res.setHeader('access-control-max-age', '600')
  }

  // ---- SSE hub ----
  // ids are `<bootEpoch>-<seq>`: a reconnect from a previous boot cannot silently
  // miss the gap (its Last-Event-ID carries the old epoch → resync)
  const bootEpoch = randomBytes(4).toString('hex')
  let seq = 0
  const ring: { seq: number; data: string }[] = []          // last 500 broadcast frames
  // each client keeps the token it connected with, so the stream can be
  // re-authorized long after the gate let it in
  const clients = new Map<ServerResponse, { tok: string | null }>()
  const broadcast = (board: string, events: CommentEvent[]) => {
    for (const ev of events) {
      const frame = `id: ${bootEpoch}-${++seq}\nevent: comment\ndata: ${JSON.stringify({ board, ev })}\n\n`
      ring.push({ seq, data: frame })
      if (ring.length > 500) ring.shift()
      for (const res of clients.keys()) res.write(frame)
    }
  }
  setInterval(() => { for (const res of clients.keys()) res.write(': keepalive\n\n') }, 240_000).unref()

  // ---- SSE re-authorization (04-solution §2.2.1, acceptance 2) ----
  // A stream is admitted once and would otherwise outlive every revocation: a
  // blocked or expired member kept receiving each board's events for as long as
  // the socket held. So the resolver's answer is re-checked on a timer, and a
  // refused stream is CLOSED - the client's reconnect then faces the gate.
  // Anonymous streams (past a password gate / public canvas) stay only while
  // general access still says anyone may read.
  const ceilings = ceilingsFromRights(rights)
  const streamAllowed = (tok: string | null): boolean => {
    const store = shareState(dataDir)
    if (!store) return true                                 // pre-migration: legacy behaviour
    if (!tok) return store.general.mode !== 'private'
    const u = sessionUser(dataDir, tok)
    return !!u && entryAllowed(dataDir, u, ceilings)
  }
  setInterval(() => {
    for (const [res, c] of clients) {
      if (streamAllowed(c.tok)) continue
      clients.delete(res)
      try { res.end() } catch { /* already gone */ }
    }
  }, 60_000).unref()

  // ---- rate limit on auth attempts, keyed by BOTH network peer and target email.
  // X-Forwarded-For is client-controlled; trust it only when the deployer says the
  // proxy in front is trusted (MARVER_TRUSTED_PROXY=1 - true on Railway/Fly).
  // The map is capped so header rotation cannot grow it without bound.
  const attempts = new Map<string, { n: number; reset: number }>()
  const limited = (...keys: string[]): boolean => {
    const now = Date.now()
    if (attempts.size > 10_000) for (const [k, a] of attempts) { if (a.reset < now) attempts.delete(k) }
    if (attempts.size > 20_000) return true                 // under active flooding, fail closed
    let hit = false
    for (const key of keys) {
      const a = attempts.get(key)
      if (!a || a.reset < now) attempts.set(key, { n: 1, reset: now + 60_000 })
      else if (++a.n > 10) hit = true
    }
    return hit
  }

  // ---- the identity-minimised projection (01-sharing §7.5, acceptance 4) ----
  // Canonical JSONL is untouched everywhere; the BROWSER transport replaces
  // author.email with an opaque per-canvas id. One serialization per event for
  // every SSE subscriber - nothing per-viewer is ever fanned out. Only the
  // operator's own sessions (the CLI sync) receive canonical bytes.
  const project = (ev: CommentEvent): CommentEvent => {
    if (!ev.author?.email) return ev
    const { email, ...rest } = ev.author
    return { ...ev, author: { ...rest, id: opaqueId(dataDir, email) } }
  }
  const rawTransport = (req: IncomingMessage): boolean => {
    const tok = /^Bearer ([\w-]+)$/.exec(String(req.headers.authorization ?? ''))?.[1]
    return tok ? sessionIsOperator(dataDir, tok) : false
  }

  const cookie = (req: IncomingMessage, name: string): string | undefined =>
    new RegExp(`(?:^|;\\s*)${name}=([\\w-]+)`).exec(String(req.headers.cookie ?? ''))?.[1]
  /** browser session cookie, or a bearer token (the dev proxy / agent CLI path -
   *  same session store, held server-side by the Vite process, never by a page) */
  const sessionToken = (req: IncomingMessage): string | null =>
    /^Bearer ([\w-]+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? cookie(req, 'mv_s') ?? null
  const currentUser = (req: IncomingMessage): User | null => {
    const tok = sessionToken(req)
    return tok ? sessionUser(dataDir, tok) : null
  }
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }
  const readBody = (req: IncomingMessage): Promise<any> => new Promise((resolve, reject) => {
    // JSON only, declared as such: a cross-site <form> can post text/plain with a
    // JSON-shaped body, and content-type is the one thing it cannot forge
    if (!/^application\/json\b/.test(String(req.headers['content-type'] ?? '')))
      return reject(new Error('content-type must be application/json'))
    let body = ''
    let done = false
    const settle = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); fn() }

    // A deadline as well as a size limit.
    //
    // The size limit bounds memory and says nothing about time. A caller can
    // open a chunked POST and dribble bytes: it stays under the cap for ever
    // while holding a socket until Node's much longer server timeout. Bounded
    // memory and unbounded sockets is still a server nobody can reach.
    //
    // Kept after the device flow that motivated it was removed, because it was
    // never really about those two routes - auth/signin and auth/claim also
    // answer in front of the gate, and every route here is reachable by
    // somebody with a session who wants to be a nuisance.
    const timer = setTimeout(() => settle(() => {
      req.destroy()
      reject(new Error('body timed out'))
    }), 10_000)
    if (typeof timer.unref === 'function') timer.unref()

    req.on('data', (c) => {
      body += c
      if (body.length > MAX_BODY) settle(() => { req.destroy(); reject(new Error('body too large')) })
    })
    req.on('end', () => settle(() => {
      try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new Error('bad json')) }
    }))
    req.on('error', () => settle(() => reject(new Error('request failed'))))
  })
  const setSession = (req: IncomingMessage, res: ServerResponse, token: string) => {
    const secure = secureSuffix(req)
    res.setHeader('set-cookie', [
      `mv_s=${token}; Path=/; Max-Age=${MONTH}; HttpOnly; SameSite=Lax${secure}`,
      // the double-submit half: JS-readable, echoed as x-mv-c on every mutation
      `mv_c=${randomBytes(16).toString('base64url')}; Path=/; Max-Age=${MONTH}; SameSite=Lax${secure}`,
    ])
  }
  // mutations: double-submit check. Bearer requests skip it (a token IS the proof -
  // headers cannot be set cross-origin without CORS consent, which we never grant),
  // and so do sessionless requests: CSRF defends the SESSION cookie, and with no
  // mv_s there is nothing to ride - those requests fall through to a clean 401,
  // which is what tells the client to open the sign-in dialog.
  const csrfOk = (req: IncomingMessage): boolean =>
    !!/^Bearer /.test(String(req.headers.authorization ?? '')) ||
    !cookie(req, 'mv_s') ||
    (!!cookie(req, 'mv_c') && req.headers['x-mv-c'] === cookie(req, 'mv_c'))

  /** Returns true when the request was handled. Mounted behind the gate by serve. */
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith('/__mv/api/')) return false
    const path = url.pathname.slice('/__mv/api/'.length)
    const ip = process.env.MARVER_TRUSTED_PROXY
      ? String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '?').split(',')[0].trim()
      : String(req.socket.remoteAddress ?? '?')
    try {
      // ---- the front door (pre-gate; each route carries its own auth) ----
      if (frontDoorOn && path === 'summary' && req.method === 'OPTIONS') {
        cors(res)
        res.statusCode = 204
        return res.end(), true
      }
      if (frontDoorOn && path === 'identity' && req.method === 'GET') {
        // key discovery: public by design (02-home §2) - the browser pins the
        // kid at first consent and verifies every summary against it
        const id = canvasIdentity(dataDir)
        return json(res, 200, { kid: id.kid, jwk: id.publicJwk }), true
      }
      if (frontDoorOn && path === 'summary' && req.method === 'GET') {
        cors(res)
        // Bearer-only, by profile: a cookie-bearing request is refused before
        // anything else - the pairing (summary never accepts cookies, cookie
        // routes never receive CORS) is the whole CSRF invariant (04 §2.5)
        if (/(?:^|;\s*)mv_[sa]=/.test(String(req.headers.cookie ?? ''))) return json(res, 401, { error: 'not authorized' }), true
        if (limited(`sum:${ip}`)) return json(res, 429, { error: 'too many attempts - wait a minute' }), true
        const tok = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''
        const { verifyBearerJwt } = await import('./marver-id.ts')
        const v = await verifyBearerJwt({ token: tok, origin: publicOrigin!, issuer: idIssuer!, typ: 'marver-summary+jwt', azp: appOrigin })
        if (!v.ok) return json(res, 401, { error: 'not authorized' }), true
        // authorize BEFORE computing anything; no grant = an opaque 404 - a
        // valid token for an origin is not a right to learn a canvas is there
        const share = shareState(dataDir)
        const ceilings = ceilingsFromRights(rights)
        const account = loadStore(dataDir).users.find((u) => normEmail(u.email) === normEmail(v.email))
        const role = account?.role === 'owner' ? 'owner' as const : 'member' as const
        const resolution = share ? resolveAccess({ email: v.email, userRole: account?.role, store: share, ceilings }) : null
        const admitted = share ? (role === 'owner' || resolution!.entry) : !!account
        if (!admitted) return json(res, 404, { error: 'not found' }), true
        // totals from the maintained counters + this caller's seen marks
        const marks = loadSeen(dataDir)[normEmail(v.email)] ?? {}
        let open = 0, unread = 0
        for (const [b, st] of threads) { open += st.open.size; unread += unreadCount(st, marks[b]) }
        const boardNames = Object.keys(rights)
        const payload = {
          v: 1,
          name: meta.name ?? 'Marver',
          role: resolution?.role ?? (account ? 'comment' : 'view'),
          type: boardType(boardNames[0] ?? ''),
          boards: boardNames.map((b) => ({ name: b, role: resolution?.boards[b] ?? (rights[b] === 'comment' ? 'comment' : 'view'), type: boardType(b) })),
          threads: { open, unread },
          owner: role === 'owner',
          ...(role === 'owner' ? { people: loadStore(dataDir).users.length } : {}),
          kid: canvasIdentity(dataDir).kid,
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/jose')
        res.setHeader('cache-control', 'no-store')
        return res.end(signCanvasJws(dataDir, payload)), true
      }
      // ---- request access (01-sharing §7.6, 04-solution §9.3) ----
      // Two callers, one shape: a verified-but-refused identity presenting the
      // request token the gate minted, and an admitted viewer asking to
      // comment over their ordinary session. 202 for every well-formed call -
      // whether anything was stored is not the caller's to learn.
      if (idIssuer && publicOrigin && path === 'request-access' && req.method === 'POST') {
        if (limited(`req:${ip}`)) return json(res, 429, { error: 'too many attempts - wait a minute' }), true
        const b = await readBody(req)
        const requestedRole = b.requestedRole === 'comment' ? 'comment' as const : 'view' as const
        const note = typeof b.note === 'string' ? b.note.slice(0, 500) : undefined
        // a request token is a JWS (it has dots); a session token never does -
        // the admitted viewer's upgrade ask arrives over the ordinary session,
        // Bearer or cookie alike
        const tok0 = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1]
        const tok = tok0?.includes('.') ? tok0 : undefined
        const sessionCaller = tok ? null : currentUser(req)
        if (tok) {
          const v = verifyCanvasJws(dataDir, tok, 'marver-reqaccess+jwt', publicOrigin)
          if (v.ok && typeof v.claims.email === 'string') {
            putRequest(dataDir, {
              email: v.claims.email,
              name: typeof v.claims.name === 'string' ? v.claims.name : undefined,
              picture: typeof v.claims.picture === 'string' ? v.claims.picture : undefined,
              requestedRole,
              target: typeof v.claims.target === 'string' && v.claims.target ? v.claims.target.slice(0, 300) : undefined,
              note,
            })
          }
        } else if (sessionCaller && csrfOk(req)) {
          // the admitted viewer's "Ask to comment" - same queue, same shape
          putRequest(dataDir, { email: sessionCaller.email, name: sessionCaller.name, requestedRole, note })
        }
        return json(res, 202, { ok: true }), true
      }

      // ---- the owner API (01-sharing §9.1, 04-solution §9.4) ----
      // Bearer only, two credentials: an owner-mapped session (the CLI's device
      // path - marver share calls these same routes) or the per-mutation
      // owner-api token the ID service mints for the app. Cookies never open
      // this - an authored frame holding the viewer's session gains nothing.
      if (path.startsWith('share/')) {
        if (req.method === 'OPTIONS') {
          cors(res)
          res.setHeader('access-control-allow-methods', 'GET, PUT, POST, DELETE, OPTIONS')
          res.setHeader('access-control-allow-headers', 'authorization, content-type')
          res.statusCode = 204
          return res.end(), true
        }
        const body = req.method === 'GET' ? '' : await new Promise<string>((resolve, reject) => {
          let raw = ''
          req.on('data', (c) => { raw += c; if (raw.length > MAX_BODY) { req.destroy(); reject(new Error('body too large')) } })
          req.on('end', () => resolve(raw))
          req.on('error', () => reject(new Error('request failed')))
        })
        const tok = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''
        const owner = loadStore(dataDir).users.find((u) => u.role === 'owner')
        let allowed = false
        // (a) an owner session - the CLI device credential resolves to the owner
        const su = tok ? sessionUser(dataDir, tok) : null
        if (su && su.role === 'owner') allowed = true
        // (b) the app's owner-api token: verified against the issuer, mapped to
        // the LOCAL owner, and (mutations) digest-bound to this exact request
        // against the roster state it was computed on - replay is defused by
        // construction, not by state
        if (!allowed && tok && idIssuer && publicOrigin) {
          const { verifyBearerJwt } = await import('./marver-id.ts')
          const v = await verifyBearerJwt({ token: tok, origin: publicOrigin, issuer: idIssuer, typ: 'marver-owner-api+jwt', azp: appOrigin })
          if (v.ok && owner && normEmail(v.email) === normEmail(owner.email)) {
            if (req.method === 'GET') allowed = true
            else {
              const etag = rosterEtag(dataDir)
              const claimedEtag = typeof v.claims.etag === 'string' ? v.claims.etag : ''
              if (claimedEtag && claimedEtag !== etag) { cors(res); return json(res, 409, { error: 'roster changed - re-read and retry' }), true }
              const bodyHash = createHash('sha256').update(body).digest('hex')
              const want = createHash('sha256').update(`${req.method}\n${url.pathname}\n${bodyHash}\n${etag}`).digest('hex')
              if (v.claims.digest === want) allowed = true
            }
          }
        }
        cors(res)
        if (!allowed) return json(res, 403, { error: 'owner only' }), true
        const b = body ? (() => { try { return JSON.parse(body) } catch { return null } })() : {}
        if (b === null) return json(res, 422, { error: 'bad json' }), true
        const ceilings = ceilingsFromRights(rights)
        const roster = () => {
          const s = loadShare(dataDir)
          return {
            general: s?.general ?? { mode: 'private', role: 'view' },
            blocked: s?.blocked ?? [],
            grants: s?.grants ?? [],
            requests: loadRequests(dataDir).map(({ exp, ...r }) => r),
            etag: rosterEtag(dataDir),
          }
        }
        try {
          const sub = path.slice('share/'.length)
          if (sub === 'roster' && req.method === 'GET') {
            const r = roster()
            res.setHeader('etag', `"${r.etag}"`)
            return json(res, 200, r), true
          }
          if (sub === 'grant' && req.method === 'PUT') {
            upsertGrant(dataDir, ceilings, {
              principal: String(b.principal ?? ''), scope: b.scope === 'canvas' ? 'canvas' : String(b.scope ?? ''),
              assigned: b.assigned === 'comment' ? 'comment' : 'view',
              expires: typeof b.expires === 'string' ? b.expires : null,
              by: owner?.email ?? 'owner',
            } as any, { identityMode: !!idIssuer })
            return json(res, 200, roster()), true
          }
          if (sub === 'grant' && req.method === 'DELETE') {
            removeGrant(dataDir, String(b.principal ?? ''), b.scope === 'canvas' ? 'canvas' : String(b.scope ?? '') as any)
            return json(res, 200, roster()), true
          }
          if (sub === 'reconfirm' && req.method === 'POST') {
            reconfirmGrant(dataDir, ceilings, String(b.principal ?? ''), b.scope === 'canvas' ? 'canvas' : String(b.scope ?? '') as any, String(b.board ?? ''))
            return json(res, 200, roster()), true
          }
          if (sub === 'general' && req.method === 'PUT') {
            const mode = String(b.mode ?? '')
            if (mode !== 'private' && mode !== 'password' && mode !== 'public') return json(res, 422, { error: 'mode must be private | password | public' }), true
            setGeneralMode(dataDir, mode)
            return json(res, 200, roster()), true
          }
          if (sub === 'block' && (req.method === 'PUT' || req.method === 'DELETE')) {
            const address = String(b.address ?? '')
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return json(res, 422, { error: 'a valid address is required' }), true
            setBlocked(dataDir, address, req.method === 'PUT')
            return json(res, 200, roster()), true
          }
          const rm = /^request\/(.+)$/.exec(sub)
          if (rm && req.method === 'POST') {
            const email = decodeURIComponent(rm[1])
            const hit = resolveRequest(dataDir, ceilings, email,
              b.approve === true ? { assigned: b.assigned === 'comment' ? 'comment' : 'view', by: owner?.email ?? 'owner' } : null)
            if (!hit) return json(res, 422, { error: 'no pending request for that address' }), true
            return json(res, 200, roster()), true
          }
        } catch (err) {
          const msg = (err as Error).message
          return json(res, /canvas-scoped|identity gate|no such/.test(msg) ? 422 : 400, { error: msg }), true
        }
        return json(res, 404, { error: 'not found' }), true
      }

      if (path === 'seen' && req.method === 'POST') {
        // the canvas's own client calling home: ordinary session, no CORS -
        // and a cookie session pays the same double-submit toll as every
        // other mutation (this route sits above the shared POST gate)
        if (!csrfOk(req)) return json(res, 403, { error: 'missing or stale request token - reload the page' }), true
        const u = currentUser(req)
        if (!u) return json(res, 401, { error: 'sign in first' }), true
        const b = await readBody(req)
        const board = String(b.board ?? '')
        const st = threads.get(board)
        if (!st) return json(res, 422, { error: 'unknown board' }), true
        const latest = st.events[st.events.length - 1]?.id
        if (latest) markSeen(dataDir, normEmail(u.email), board, latest)
        res.statusCode = 204
        return res.end(), true
      }

      if (req.method === 'GET') {
        if (path === 'me') {
          // the session response carries the viewer's OWN opaque id once -
          // "is this mine" is a client-side id comparison from then on
          const u = currentUser(req)
          return json(res, u ? 200 : 401, u ? { user: publicUser(u), role: u.role, id: opaqueId(dataDir, u.email) } : { error: 'signed out' }), true
        }
        if (path === 'boards') {
          const name = ownerName(dataDir)
          return json(res, 200, { rights, stored: listBoards(commentsDir), ...(name ? { owner: { name } } : {}) }), true
        }
        const m = /^comments\/([a-z0-9][a-z0-9-]*)$/.exec(path)
        if (m) {
          if (!can(currentUser(req), rights, m[1], 'read')) return json(res, 404, { error: 'no such board' }), true
          const events = readLog(commentsDir, m[1])
          return json(res, 200, { events: rawTransport(req) ? events : events.map(project) }), true
        }
        if (path === 'invite-info') {
          if (limited(`ip:${ip}`)) return json(res, 429, { error: 'too many attempts - wait a minute' }), true
          const info = inviteInfo(dataDir, String(url.searchParams.get('token') ?? ''))
          return json(res, info ? 200 : 404, info ?? { error: 'this invite link is invalid, expired, or already used' }), true
        }
        if (path === 'events') {
          // the same answer the periodic re-check gives, asked at the door
          const tok = sessionToken(req)
          if (!streamAllowed(tok)) return json(res, 401, { error: 'not authorized' }), true
          res.statusCode = 200
          res.setHeader('content-type', 'text/event-stream')
          res.setHeader('cache-control', 'no-store')
          res.setHeader('x-accel-buffering', 'no')
          res.write(': connected\n\n')
          // resume ids are `<bootEpoch>-<seq>`; a different epoch (restart) or a gap
          // the ring cannot cover = resync (the client refetches - logs are tiny)
          const lastRaw = String(req.headers['last-event-id'] ?? '')
          const lm = /^([0-9a-f]{8})-(\d+)$/.exec(lastRaw)
          if (lastRaw) {
            const last = lm && lm[1] === bootEpoch ? Number(lm[2]) : NaN
            if (!Number.isFinite(last)) res.write('event: resync\ndata: {}\n\n')
            else {
              const missed = ring.filter((r) => r.seq > last)
              if (missed.length && missed[0].seq !== last + 1) res.write('event: resync\ndata: {}\n\n')
              else for (const r of missed) res.write(r.data)
            }
          }
          clients.set(res, { tok })
          req.on('close', () => clients.delete(res))
          return true
        }
        return false
      }

      if (req.method !== 'POST') return false
      // claim/signin run BEFORE a session exists, so the double-submit pair cannot -
      // and need not - be present: CSRF protects authenticated state, and these have
      // none to ride (the scrypt cost + rate limit carry the abuse load)
      const preAuth = path === 'auth/claim' || path === 'auth/signin'
      if (!preAuth && !csrfOk(req))
        return json(res, 403, { error: 'missing or stale request token - reload the page' }), true

      if (path === 'auth/claim') {
        if (limited(`ip:${ip}`)) return json(res, 429, { error: 'too many attempts - wait a minute' }), true
        const b = await readBody(req)
        const { user, session } = claimInvite(dataDir, String(b.token ?? ''), {
          password: String(b.password ?? ''), name: String(b.name ?? ''),
          avatar: validAvatar(b.avatar) ? b.avatar : undefined,
        }, ceilings)
        setSession(req, res, session)
        return json(res, 200, { user: publicUser(user) }), true
      }
      if (path === 'auth/signin') {
        const b = await readBody(req)
        const email = String(b.email ?? '').trim().toLowerCase()
        if (limited(`ip:${ip}`, `em:${email}`)) return json(res, 429, { error: 'too many attempts - wait a minute' }), true
        const hit = signIn(dataDir, email, String(b.password ?? ''), ceilings)
        if (!hit) return json(res, 401, { error: 'wrong email or password' }), true
        setSession(req, res, hit.session)
        return json(res, 200, { user: publicUser(hit.user) }), true
      }
      if (path === 'auth/signout') {
        const tok = cookie(req, 'mv_s')
        if (tok) signOut(dataDir, tok)
        res.setHeader('set-cookie', ['mv_s=; Path=/; Max-Age=0; HttpOnly', 'mv_c=; Path=/; Max-Age=0'])
        return json(res, 200, {}), true
      }
      if (path === 'profile') {
        const u = currentUser(req)
        if (!u) return json(res, 401, { error: 'sign in first' }), true
        const b = await readBody(req)
        const next = updateProfile(dataDir, u.email, {
          name: typeof b.name === 'string' ? b.name : undefined,
          avatar: b.avatar === '' ? '' : validAvatar(b.avatar) ? b.avatar : undefined,
        })
        return json(res, 200, { user: publicUser(next) }), true
      }
      if (path === 'cli-session') {
        // The operator secret, and nothing else, opens this - not a signed-in
        // session, because a frame rides those. It is read from the Authorization
        // header ONLY: a cookie is ambient, and this is the one route where being
        // reachable by something the browser sends automatically would matter.
        const bearer = /^Bearer ([\w-]+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''
        if (limited(`ip:${ip}`)) return json(res, 429, { error: 'too many attempts - wait a minute' }), true
        const issued = issueDeviceSession(dataDir, bearer)
        // One refusal for a wrong secret and for a canvas nobody owns yet. The
        // second is the common setup mistake, so it is named in the text without
        // the status telling a guesser which of the two they hit.
        if (!issued) return json(res, 401, { error: 'MARVER_CLI_TOKEN was refused, or nobody owns this canvas yet' }), true
        return json(res, 200, { token: issued.token, exp: issued.exp, user: publicUser(issued.user) }), true
      }
      if (path === 'invite') {
        const u = currentUser(req)
        if (!can(u, rights, '', 'admin')) return json(res, 403, { error: 'owner only' }), true
        const b = await readBody(req)
        const email = String(b.email ?? '')
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'a valid email is required' }), true
        // How the invite gets SPENT differs by gate mode, and only the server
        // knows which mode it is running in - so it says, rather than leaving
        // the CLI to print instructions that are wrong half the time. On an
        // identity canvas the link is inert (serve.ts keeps auth/claim behind
        // `!idIssuer`); the address itself is the invitation, matched at
        // sign-in. Reported from the pilot, where the printed advice named a
        // canvas password that does not exist in identity mode.
        const idMode = !!process.env.MARVER_ID_ISSUER
        return json(res, 200, { ...createInvite(dataDir, email), idMode }), true
      }
      if (path === 'revoke') {
        const u = currentUser(req)
        if (!can(u, rights, '', 'admin')) return json(res, 403, { error: 'owner only' }), true
        const b = await readBody(req)
        revokeUser(dataDir, String(b.email ?? ''))
        return json(res, 200, {}), true
      }
      const m = /^comments\/([a-z0-9][a-z0-9-]*)$/.exec(path)
      if (m) {
        const u = currentUser(req)
        if (!can(u, rights, m[1], 'comment', dataDir))
          return json(res, u ? 403 : 401, { error: u ? `this board is read-only - ask ${ownerName(dataDir) ?? 'the canvas owner'} for commenting access` : 'sign in to comment' }), true
        const b = await readBody(req)
        const incoming: CommentEvent[] = Array.isArray(b.events) ? b.events : []
        if (incoming.length > 100) return json(res, 400, { error: 'too many events in one push' }), true
        // VALIDATE, never rewrite: an accepted event must be byte-identical everywhere
        // (sync compares ids only - a server that mutates content forks the stores).
        // The author claim must match the session; ownership gates edits; timestamps
        // are bounded so nobody time-travels over someone else's thread.
        const log = readLog(commentsDir, m[1])
        const bad = validateEvents(incoming, log, u!, m[1])
        if (bad) return json(res, 400, { error: bad }), true
        const fresh = appendEvents(commentsDir, m[1], incoming)
        // the maintained thread counters follow every append (02-home §3)
        if (fresh.length) {
          const st = threads.get(m[1])
          threads.set(m[1], deriveThreads([...(st?.events ?? []), ...fresh]))
        }
        broadcast(m[1], fresh.map(project))   // the stream is a browser transport
        return json(res, 200, { accepted: fresh.length }), true
      }
      return false
    } catch (err) {
      return json(res, 400, { error: (err as Error).message }), true
    }
  }
}
