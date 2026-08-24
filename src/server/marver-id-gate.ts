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
import { provisionFromMarverId } from './auth.ts'
import { TransactionStore, browserBinding, verifyAssertion } from './marver-id.ts'

/**
 * Names the browser across the two requests. Not a session - just a handle.
 *
 * Over https it carries the `__Host-` prefix, which is not decoration. The
 * handle is what binds a sign-in to the browser that started it, and without
 * the prefix a sibling host on a shared parent domain can set one - "cookie
 * tossing" - which means choosing the binding for somebody else's sign-in. The
 * prefix makes a cookie host-only and unsettable by any other host, and the
 * browser enforces it rather than us. Plain over http, where the prefix is
 * invalid; there is no https there to have, and localhost has no siblings.
 */
const BROWSER_COOKIE = 'mv_b'
const BROWSER_COOKIE_SECURE = '__Host-mv_b'
const browserCookieName = (secure: boolean) => (secure ? BROWSER_COOKIE_SECURE : BROWSER_COOKIE)
const SESSION_COOKIE = 'mv_s'
const MONTH = 30 * 24 * 3600

export function marverIdHandler(dir: string, issuer: string) {
  const transactions = new TransactionStore()

  // The canvas's own origin, pinned by the operator.
  //
  // This is REQUIRED rather than inferred, and that is a deliberate reversal.
  // Deriving it from x-forwarded-host let a raw client choose what the audience
  // check compares against: spoof the header, mint a transaction for another
  // origin, get an assertion for it, present it back with the same header, and
  // the exact-origin isolation this protocol promises evaporates. A value a
  // caller can suggest cannot be the value a security check trusts.
  //
  // Loopback is the one exception, so local development needs no configuration.
  const pinned = (process.env.MARVER_PUBLIC_ORIGIN ?? '').trim().replace(/\/$/, '')
  let publicOrigin: string | null = null
  if (pinned) {
    let u: URL
    try { u = new URL(pinned) } catch { throw new Error(`MARVER_PUBLIC_ORIGIN is not a URL: ${pinned}`) }
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
    if (u.pathname !== '/' || u.search || u.hash) throw new Error(`MARVER_PUBLIC_ORIGIN must be a bare origin: ${pinned}`)
    if (u.protocol !== 'https:' && !loopback) throw new Error(`MARVER_PUBLIC_ORIGIN must be https (or loopback): ${pinned}`)
    publicOrigin = u.origin
  }

  return async function handle(req: any, res: any, url: URL): Promise<boolean> {
    // Loopback development needs no configuration; anything else must be pinned.
    const origin = publicOrigin ?? localOrigin(req)
    if (!origin) {
      console.error(
        '[marver-id] MARVER_PUBLIC_ORIGIN is required when the canvas is not on localhost -\n' +
        '            set it to this canvas\'s exact public origin, e.g. https://canvas.example.com',
      )
      return json(res, 500, { error: 'misconfigured' })
    }

    // Cookie security follows the ORIGIN, not a header. x-forwarded-proto is as
    // spoofable as x-forwarded-host, and a Secure flag decided by the caller is
    // not a Secure flag.
    const secure = origin.startsWith('https://')

    if (req.method === 'GET' && url.pathname === '/__mv/id/start') {
      // Give the browser a stable handle if it has none, so the callback can
      // prove it is the same browser that started this.
      let browserId = readCookie(req, browserCookieName(secure))
      const headers: string[] = []
      if (!browserId) {
        browserId = randomBytes(24).toString('base64url')
        headers.push(cookie(browserCookieName(secure), browserId, { maxAge: 600, secure }))
      }

      const tx = transactions.mint(origin, browserBinding(browserId))
      const authorize = `${issuer}/authorize?origin=${encodeURIComponent(origin)}&nonce=${encodeURIComponent(tx.nonce)}`

      if (headers.length) res.setHeader('set-cookie', headers)
      return json(res, 200, { authorize, issuer })
    }

    if (req.method === 'POST' && url.pathname === '/__mv/id/callback') {
      const { body, tooLarge } = await readBody(req, 16_000)
      if (tooLarge) return json(res, 413, { error: 'too large' })
      let assertion = ''
      try {
        const parsed = JSON.parse(body) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const a = (parsed as Record<string, unknown>).assertion
          if (typeof a === 'string') assertion = a
        }
      } catch { /* handled below */ }
      if (!assertion) return json(res, 400, { error: 'bad request' })

      const browserId = readCookie(req, browserCookieName(secure))
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

      // Proved WHO. Now the local question: were they invited? That decision
      // happens inside the auth store's lock, so it cannot go stale between the
      // check and the write.
      const session = provisionFromMarverId(
        dir,
        { ...result.identity, issuer },
        { ownerEmail: process.env.MARVER_OWNER_EMAIL },
      )
      if (!session) {
        // Deliberately the same shape of refusal as a bad assertion. Whether an
        // address is on somebody's private invite list is not public knowledge.
        console.warn(`[marver-id] ${result.identity.email} is not on this canvas's list`)
        return json(res, 403, { error: 'not invited' })
      }

      res.setHeader('set-cookie', [
        cookie(SESSION_COOKIE, session.session, { maxAge: MONTH, secure }),
        // The browser handle has done its job.
        cookie(browserCookieName(secure), '', { maxAge: 0, secure }),
      ])
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { error: 'not found' })
  }
}

/**
 * The origin for a canvas genuinely being used over loopback.
 *
 * The Host HEADER is not evidence of anything: the server listens on every
 * interface, so a caller anywhere on the internet can send `Host: localhost`,
 * collect assertions for that audience, and replay the resulting session against
 * the real host. So the check is on the SOCKET - where the connection actually
 * came from and where it actually landed - which a remote caller cannot forge.
 *
 * The header still has to agree, because it is what the browser will use when
 * the popup posts back; but agreement alone was never enough.
 */
function localOrigin(req: any): string | null {
  const remote = req.socket?.remoteAddress ?? ''
  const local = req.socket?.localAddress ?? ''
  const isLoopbackAddr = (a: string) =>
    a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  if (!isLoopbackAddr(remote) || !isLoopbackAddr(local)) return null

  const host = String(req.headers.host ?? '')
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)
    ? `http://${host}`
    : null
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

/**
 * Read a bounded request body.
 *
 * Counts BYTES, not decoded characters, and signals an overflow rather than
 * destroying the socket - the previous version killed the connection and then
 * tried to write a response onto it, which cannot arrive.
 */
function readBody(req: any, limit: number): Promise<{ body: string; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (tooLarge: boolean) => {
      if (done) return
      done = true
      resolve({ body: tooLarge ? '' : Buffer.concat(chunks).toString('utf8'), tooLarge })
    }
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) { req.pause(); return finish(true) }
      chunks.push(c)
    })
    req.on('end', () => finish(false))
    req.on('error', () => finish(false))
  })
}
