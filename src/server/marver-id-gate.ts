/**
 * The two endpoints that bracket a Marver ID sign-in.
 *
 *   GET  /__mv/id/start     "I am about to open the popup" - mints a nonce,
 *                           bound to this browser, and hands back the URL.
 *   POST /__mv/id/callback  "here is what the popup gave me" - verifies it
 *                           server-side and, if the owner invited this address,
 *                           issues an ordinary canvas session.
 *
 * The important architectural choice is the last line: a Marver ID sign-in ends
 * with the SAME `mv_s` session cookie that a password sign-in produces. Nothing
 * downstream - the gate, the comment API, the event stream - learns that a new
 * kind of login exists. One session concept, one place to revoke it.
 *
 * The assertion never touches the browser's storage. It arrives by postMessage,
 * is POSTed straight here, and is consumed. Authored frames run same-origin in
 * this canvas, so anything left in localStorage would be readable by them.
 */
import { randomBytes } from 'node:crypto'
import { loadStore, normEmail, provisionFromMarverId } from './auth.ts'
import { TransactionStore, browserBinding, verifyAssertion } from './marver-id.ts'

/** Names the browser across the two requests. Not a session - just a handle. */
const BROWSER_COOKIE = 'mv_b'
const SESSION_COOKIE = 'mv_s'
const MONTH = 30 * 24 * 3600

export function marverIdHandler(dir: string, issuer: string) {
  const transactions = new TransactionStore()

  // Validated once at startup rather than per request: a malformed value should
  // stop the server, not fail every sign-in with a confusing 400.
  const pinned = (process.env.MARVER_PUBLIC_ORIGIN ?? '').trim().replace(/\/$/, '')
  let publicOrigin: string | null = null
  if (pinned) {
    try {
      const u = new URL(pinned)
      if (u.pathname !== '/' || u.search || u.hash) throw new Error('not an origin')
      publicOrigin = u.origin
    } catch {
      throw new Error(`MARVER_PUBLIC_ORIGIN is not a valid origin: ${pinned}`)
    }
  }

  return async function handle(req: any, res: any, url: URL): Promise<boolean> {
    const secure = req.headers['x-forwarded-proto'] === 'https'

    // This canvas's own origin, as the browser sees it. Every assertion is bound
    // to this exact string, so getting it wrong breaks sign-in - and trusting it
    // blindly lets a client choose what the audience check compares against.
    //
    // MARVER_PUBLIC_ORIGIN pins it explicitly and always wins. Set it whenever the
    // canvas sits behind a proxy you do not control; the header fallback below is
    // for the ordinary case where the proxy is the one terminating TLS for you.
    const origin = publicOrigin ?? (() => {
      const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
      if (!host || !/^[\w.-]+(?::\d+)?$/.test(host)) return null
      return `${secure ? 'https' : 'http'}://${host}`
    })()
    if (!origin) return json(res, 400, { error: 'bad host' })

    if (req.method === 'GET' && url.pathname === '/__mv/id/start') {
      // Give the browser a stable handle if it has none, so the callback can
      // prove it is the same browser that started this.
      let browserId = readCookie(req, BROWSER_COOKIE)
      const headers: string[] = []
      if (!browserId) {
        browserId = randomBytes(24).toString('base64url')
        headers.push(cookie(BROWSER_COOKIE, browserId, { maxAge: 600, secure }))
      }

      const tx = transactions.mint(origin, browserBinding(browserId))
      const authorize = `${issuer}/authorize?origin=${encodeURIComponent(origin)}&nonce=${encodeURIComponent(tx.nonce)}`

      if (headers.length) res.setHeader('set-cookie', headers)
      return json(res, 200, { authorize, issuer })
    }

    if (req.method === 'POST' && url.pathname === '/__mv/id/callback') {
      const body = await readBody(req, 16_000)
      let assertion = ''
      try { assertion = String(JSON.parse(body).assertion ?? '') } catch { /* handled below */ }
      if (!assertion) return json(res, 400, { error: 'no assertion' })

      const browserId = readCookie(req, BROWSER_COOKIE)
      if (!browserId) {
        // Same refusal as a bad assertion, deliberately. Distinguishing "your
        // handle is gone" from "your token is wrong" tells a prober which half
        // of the flow to attack; the operator sees the difference in the logs.
        console.warn('[marver-id] callback with no browser handle')
        return json(res, 401, { error: 'not signed in' })
      }

      const result = await verifyAssertion({
        token: assertion, origin, issuer, store: transactions,
        browser: browserBinding(browserId),
      })

      if (!result.ok) {
        // The reason goes to the operator's logs, never to the browser: telling a
        // caller which check failed turns this endpoint into a debugger for
        // whoever is probing it.
        console.warn(`[marver-id] assertion rejected: ${result.reason}`)
        return json(res, 401, { error: 'not signed in' })
      }

      // Proved WHO. Now the local question: were they invited?
      const session = provisionFromMarverId(dir, result.identity, (email) => allowed(dir, email))
      if (!session) {
        // Deliberately the same shape of refusal as a bad assertion. Whether an
        // address is on somebody's private invite list is not public knowledge.
        console.warn(`[marver-id] ${result.identity.email} is not on this canvas's list`)
        return json(res, 403, { error: 'not invited' })
      }

      res.setHeader('set-cookie', [
        cookie(SESSION_COOKIE, session.session, { maxAge: MONTH, secure }),
        // The browser handle has done its job.
        cookie(BROWSER_COOKIE, '', { maxAge: 0, secure }),
      ])
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { error: 'not found' })
  }
}

/**
 * Whether an address may enter this canvas.
 *
 * Reuses the owner's existing invite list rather than introducing a second one:
 * an address is allowed if it already has an account, or holds an unexpired
 * invite, or is the bootstrap owner of a canvas with no accounts yet. An owner
 * therefore invites people exactly as they always have.
 */
function allowed(dir: string, emailNorm: string): boolean {
  const store = loadStore(dir)
  if (store.users.some((u) => normEmail(u.email) === emailNorm)) return true
  if (store.invites.some((i) => i.emailNorm === emailNorm && i.exp > Date.now())) return true
  const owner = process.env.MARVER_OWNER_EMAIL
  if (owner && !store.users.length && normEmail(owner) === emailNorm) return true
  return false
}

function json(res: any, status: number, body: unknown): boolean {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
  return true
}

function cookie(name: string, value: string, o: { maxAge: number; secure: boolean }): string {
  return `${name}=${value}; Path=/; Max-Age=${o.maxAge}; HttpOnly; SameSite=Lax${o.secure ? '; Secure' : ''}`
}

function readCookie(req: any, name: string): string {
  const m = new RegExp(`(?:^|;\\s*)${name}=([\\w-]+)`).exec(String(req.headers.cookie ?? ''))
  return m?.[1] ?? ''
}

function readBody(req: any, limit: number): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c: Buffer) => {
      body += c
      if (body.length > limit) { req.destroy(); resolve('') }
    })
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(''))
  })
}
