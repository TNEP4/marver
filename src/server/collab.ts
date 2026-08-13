/**
 * The collaboration API (SPEC-M3 §2-§4) - mounted by serve under /__mv/api/* when
 * MARVER_DATA_DIR is set. Everything sits BEHIND the gate (the password stays the
 * outer READ boundary); accounts subdivide rights within it.
 *
 * Mutation protection (isolation path b, SPEC-M3 §0): double-submit cookie. The shell
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
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvents, listBoards, readLog, type CommentEvent } from './comments.ts'
import { claimInvite, createInvite, publicUser, revokeUser, sessionUser, signIn, signOut, updateProfile, type User } from './auth.ts'

const MONTH = 30 * 24 * 3600
const MAX_BODY = 256 * 1024

type Rights = Record<string, 'read' | 'comment'>

/** The permission seam (SPEC-M3 §3): v1 derives from publish policy + membership;
 *  a per-user ACL can replace the internals without touching a single route. */
export function can(user: User | null, rights: Rights, board: string, action: 'read' | 'comment' | 'resolve' | 'admin'): boolean {
  if (action === 'read') return board in rights
  if (action === 'admin') return user?.role === 'owner'
  return !!user && rights[board] === 'comment'
}

export function collabHandler(dataDir: string, distDir: string) {
  let rights: Rights = {}
  try { rights = JSON.parse(readFileSync(join(distDir, 'meta.json'), 'utf8')).rights ?? {} } catch { /* no policy = no boards */ }
  const commentsDir = join(dataDir, 'comments')

  // ---- SSE hub ----
  let seq = 0
  const ring: { seq: number; data: string }[] = []          // last 500 broadcast frames
  const clients = new Set<ServerResponse>()
  const broadcast = (board: string, events: CommentEvent[]) => {
    for (const ev of events) {
      const frame = `id: ${++seq}\nevent: comment\ndata: ${JSON.stringify({ board, ev })}\n\n`
      ring.push({ seq, data: frame })
      if (ring.length > 500) ring.shift()
      for (const res of clients) res.write(frame)
    }
  }
  setInterval(() => { for (const res of clients) res.write(': keepalive\n\n') }, 240_000).unref()

  // ---- naive per-IP rate limit on auth attempts (the scrypt cost is the real throttle) ----
  const attempts = new Map<string, { n: number; reset: number }>()
  const limited = (ip: string): boolean => {
    const now = Date.now()
    const a = attempts.get(ip)
    if (!a || a.reset < now) { attempts.set(ip, { n: 1, reset: now + 60_000 }); return false }
    return ++a.n > 10
  }

  const cookie = (req: IncomingMessage, name: string): string | undefined =>
    new RegExp(`(?:^|;\\s*)${name}=([\\w-]+)`).exec(String(req.headers.cookie ?? ''))?.[1]
  const currentUser = (req: IncomingMessage): User | null => {
    // browser session cookie, or a bearer token (the dev proxy / agent CLI path -
    // same session store, held server-side by the Vite process, never by a page)
    const bearer = /^Bearer ([\w-]+)$/.exec(String(req.headers.authorization ?? ''))?.[1]
    const tok = bearer ?? cookie(req, 'mv_s')
    return tok ? sessionUser(dataDir, tok) : null
  }
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }
  const readBody = (req: IncomingMessage): Promise<any> => new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > MAX_BODY) { reject(new Error('body too large')); req.destroy() } })
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new Error('bad json')) } })
  })
  const setSession = (req: IncomingMessage, res: ServerResponse, token: string) => {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
    res.setHeader('set-cookie', [
      `mv_s=${token}; Path=/; Max-Age=${MONTH}; HttpOnly; SameSite=Lax${secure}`,
      // the double-submit half: JS-readable, echoed as x-mv-c on every mutation
      `mv_c=${randomBytes(16).toString('base64url')}; Path=/; Max-Age=${MONTH}; SameSite=Lax${secure}`,
    ])
  }
  // mutations: double-submit check. Bearer requests skip it - a token IS the proof
  // (headers cannot be set cross-origin without CORS consent, which we never grant).
  const csrfOk = (req: IncomingMessage): boolean =>
    !!/^Bearer /.test(String(req.headers.authorization ?? '')) ||
    (!!cookie(req, 'mv_c') && req.headers['x-mv-c'] === cookie(req, 'mv_c'))

  /** Returns true when the request was handled. Mounted behind the gate by serve. */
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith('/__mv/api/')) return false
    const path = url.pathname.slice('/__mv/api/'.length)
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '?').split(',')[0]
    try {
      if (req.method === 'GET') {
        if (path === 'me') {
          const u = currentUser(req)
          return json(res, u ? 200 : 401, u ? { user: publicUser(u), role: u.role } : { error: 'signed out' }), true
        }
        if (path === 'boards')
          return json(res, 200, { rights, stored: listBoards(commentsDir) }), true
        const m = /^comments\/([a-z0-9][a-z0-9-]*)$/.exec(path)
        if (m) {
          if (!can(currentUser(req), rights, m[1], 'read')) return json(res, 404, { error: 'no such board' }), true
          return json(res, 200, { events: readLog(commentsDir, m[1]) }), true
        }
        if (path === 'events') {
          res.statusCode = 200
          res.setHeader('content-type', 'text/event-stream')
          res.setHeader('cache-control', 'no-store')
          res.setHeader('x-accel-buffering', 'no')
          res.write(': connected\n\n')
          const last = Number(req.headers['last-event-id'])
          if (Number.isFinite(last) && last > 0) {
            const missed = ring.filter((r) => r.seq > last)
            // a gap the ring cannot cover (or an older boot) = tell the client to refetch
            if (missed.length && missed[0].seq !== last + 1) res.write('event: resync\ndata: {}\n\n')
            else for (const r of missed) res.write(r.data)
          }
          clients.add(res)
          req.on('close', () => clients.delete(res))
          return true
        }
        return false
      }

      if (req.method !== 'POST') return false
      // claim/signin run BEFORE a session exists, so the double-submit pair cannot -
      // and need not - be present: CSRF protects authenticated state, and these have
      // none to ride (the scrypt cost + rate limit carry the abuse load)
      if (path !== 'auth/claim' && path !== 'auth/signin' && !csrfOk(req))
        return json(res, 403, { error: 'missing or stale request token - reload the page' }), true

      if (path === 'auth/claim') {
        if (limited(ip)) return json(res, 429, { error: 'too many attempts - wait a minute' }), true
        const b = await readBody(req)
        const { user, session } = claimInvite(dataDir, String(b.token ?? ''), {
          password: String(b.password ?? ''), name: String(b.name ?? ''),
          avatar: typeof b.avatar === 'string' && b.avatar.startsWith('data:image/') ? b.avatar : undefined,
        })
        setSession(req, res, session)
        return json(res, 200, { user: publicUser(user) }), true
      }
      if (path === 'auth/signin') {
        if (limited(ip)) return json(res, 429, { error: 'too many attempts - wait a minute' }), true
        const b = await readBody(req)
        const hit = signIn(dataDir, String(b.email ?? ''), String(b.password ?? ''))
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
          avatar: typeof b.avatar === 'string' && (b.avatar === '' || b.avatar.startsWith('data:image/')) ? b.avatar : undefined,
        })
        return json(res, 200, { user: publicUser(next) }), true
      }
      if (path === 'invite') {
        const u = currentUser(req)
        if (!can(u, rights, '', 'admin')) return json(res, 403, { error: 'owner only' }), true
        const b = await readBody(req)
        const email = String(b.email ?? '')
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'a valid email is required' }), true
        return json(res, 200, createInvite(dataDir, email)), true
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
        if (!can(u, rights, m[1], 'comment'))
          return json(res, u ? 403 : 401, { error: u ? 'this board is read-only' : 'sign in to comment' }), true
        const b = await readBody(req)
        const incoming: CommentEvent[] = Array.isArray(b.events) ? b.events : []
        if (incoming.length > 100) return json(res, 400, { error: 'too many events in one push' }), true
        // the author snapshot is the SERVER's idea of the user, never the client's claim
        const stamped = incoming.map((ev) => ({
          ...ev, board: m[1],
          author: ev.type === 'create' || ev.type === 'reply' || ev.type === 'react' || ev.type === 'edit'
            ? publicUser(u!) : ev.author,
        }))
        const fresh = appendEvents(commentsDir, m[1], stamped)
        broadcast(m[1], fresh)
        return json(res, 200, { accepted: fresh.length }), true
      }
      return false
    } catch (err) {
      return json(res, 400, { error: (err as Error).message }), true
    }
  }
}
