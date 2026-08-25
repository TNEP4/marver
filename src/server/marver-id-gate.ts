/**
 * The three endpoints that bracket a Marver ID sign-in.
 *
 *   GET  /__mv/id/start     mints a nonce bound to this browser, then sends the
 *                           tab to the identity service. A plain redirect - no
 *                           JavaScript is involved in leaving.
 *   GET  /__mv/id/finish    where the identity service sends the tab back, with
 *                           the assertion in the URL FRAGMENT. Reads it, hands
 *                           it to the callback, and shows what happened.
 *   POST /__mv/id/callback  verifies the assertion server-side and, if the owner
 *                           invited this address, issues a canvas session.
 *
 * This used to be a popup that handed the assertion back by postMessage. That
 * design is dead on arrival for social sign-in: Google serves
 * `Cross-Origin-Opener-Policy: same-origin`, which permanently severs the
 * popup's `window.opener` - and it does not come back when the popup returns to
 * our origin. Microsoft and Apple do the same. So the whole flow now happens in
 * ONE tab, and nothing depends on two windows being able to talk. It also fixes
 * popup blockers and mobile, where popups were never good.
 *
 * The assertion rides in the fragment on the way back, which is the one part of
 * a URL a browser never sends to a server: it stays out of this canvas's access
 * logs and out of any `Referer`.
 *
 * The important architectural choice is unchanged: a Marver ID sign-in ends with
 * the SAME `mv_s` session cookie a password sign-in produces. Nothing downstream
 * - the gate, the comment API, the event stream - learns that a new kind of
 * login exists. One session concept, one place to revoke it.
 *
 * The assertion never touches the browser's storage. It is read from the
 * fragment, POSTed straight here, and consumed. Authored frames run same-origin
 * in this canvas, so anything left in localStorage would be readable by them.
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
 *
 * What that leaves, stated rather than assumed. The prefix protects against
 * every OTHER host, and against nothing on this one: cookies ignore ports, so a
 * second service on the same hostname can still write the handle, and so can
 * anyone who takes over the hostname itself. A browser that does not implement
 * the prefix gets no protection at all. So the assumption a self-hosted canvas
 * is making is exclusive control of its own hostname, and modern browsers -
 * which is the same assumption its TLS certificate already makes.
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

      // A redirect, not JSON. The gate's Continue is an ordinary form submit, so
      // leaving this canvas needs no JavaScript at all and cannot be blocked.
      if (headers.length) res.setHeader('set-cookie', headers)
      res.statusCode = 302
      res.setHeader('location', authorize)
      // Minting is per-request; a cached redirect would hand somebody a spent nonce.
      res.setHeader('cache-control', 'no-store')
      res.end()
      return true
    }

    if (req.method === 'GET' && url.pathname === '/__mv/id/finish') {
      // Where the identity service sends the tab back. The assertion is in the
      // fragment, which never reached this server - so this page is the same
      // fixed bytes for everyone, and the work happens in the browser.
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('referrer-policy', 'no-referrer')
      res.end(finishPage())
      return true
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

/**
 * The page the identity service sends the tab back to.
 *
 * Fixed bytes for everyone: the assertion is in the fragment, which the browser
 * never sent here, so there is nothing to template and nothing to escape. The
 * script reads it, wipes it out of the address bar before doing anything else -
 * so it cannot be left behind in history or read off the screen - and hands it
 * to the callback over a SAME-ORIGIN POST, which is what keeps the browser
 * handle cookie flowing under SameSite=Lax.
 *
 * A refusal is shown HERE rather than bounced back to the gate, because this is
 * the page somebody is looking at. Being told "that account was not invited" on
 * the screen in front of you beats being returned to a form that silently
 * refuses to move.
 */
function finishPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Signing in - Marver</title>
<style>
  :root { color-scheme: light dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
         background:#fff; color:#111 }
  @media (prefers-color-scheme: dark) { body { background:#0a0a0a; color:#f5f5f5 } }
  .card { width:min(380px,88vw); text-align:center }
  h1 { font-size:17px; font-weight:600; margin:0 0 6px; letter-spacing:-.01em }
  p { margin:0; color:#666 }
  @media (prefers-color-scheme: dark) { p { color:#a3a3a3 } }
  a { display:inline-block; margin-top:18px; color:inherit; font-weight:500 }
</style></head>
<body><div class="card">
  <h1 id="t">Signing you in...</h1>
  <p id="m"></p>
  <a id="back" href="/" hidden>Back to the canvas</a>
</div>
<script>
(function () {
  var t = document.getElementById('t'), m = document.getElementById('m'), back = document.getElementById('back')
  function stop(title, msg) { t.textContent = title; m.textContent = msg; back.hidden = false }

  // Take it, then erase it - before any await, so a slow network cannot leave
  // the assertion sitting in the address bar.
  var assertion = location.hash.replace(/^#/, '')
  try { history.replaceState(null, '', location.pathname) } catch (e) {}

  if (!assertion) return stop('Nothing to sign in with', 'That link is incomplete. Start again from the canvas.')

  fetch('/__mv/id/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion: assertion })
  }).then(function (res) {
    if (res.ok) { location.replace('/'); return }
    if (res.status === 403) return stop('Not invited yet', 'That account has not been invited to this canvas. Ask whoever owns it to add your address.')
    stop('That sign-in did not work', 'Start again from the canvas, or try a different account.')
  }).catch(function () {
    stop('Could not reach the canvas', 'It may have stopped. Try again in a moment.')
  })
})()
</script>
</body></html>`
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
