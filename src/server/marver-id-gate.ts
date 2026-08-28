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
import { attachAvatar, avatarSourceFor, provisionFromMarverId } from './auth.ts'
import { fetchAvatar } from './avatar.ts'
import { TransactionStore, browserBinding, verifyAssertion } from './marver-id.ts'
import { poweredByUrl } from '../shared/utm.ts'

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
/** The double-submit half of the session pair. See where it is set. */
const CSRF_COOKIE = 'mv_c'
const MONTH = 30 * 24 * 3600
/** Matches TRANSACTION_TTL_MS - one deadline, expressed in both halves. */
const HANDLE_TTL_S = 15 * 60

/**
 * Where to put somebody back, after they sign in.
 *
 * A canvas link carries its board and thread in the fragment - `#/b/strategy`,
 * `#/b/strategy?c=<thread>` - which no server ever receives. The gate's script
 * reads it and hands it here on the query string, which means that by the time
 * it arrives it is an ordinary attacker-reachable parameter: anyone can request
 * /__mv/id/start?next=<anything>.
 *
 * It ends up in location.replace() on this canvas, so it is an open redirect if
 * it is wrong. Only a hash route on this same canvas survives.
 *
 * The rejections worth naming:
 *   "#//evil.test"  - a browser reads what follows a bare // as a host
 *   "javascript:.." - not a route at all
 *   anything with a control character, which is how a value gets smuggled past
 *   a check and into a header or a log
 */
export function safeHash(raw: string | null): string | null {
  if (!raw) return null
  const value = raw.trim()

  // A canvas route and nothing else: "#/..." with no authority after the slash.
  if (!value.startsWith('#/')) return null
  if (value.startsWith('#//') || value.startsWith('#/\\')) return null
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  if (value.length > 512) return null

  // No dot segments, anywhere.
  //
  // The identity service's sanitiser learned to re-check its own OUTPUT,
  // because "/..//evil.test" normalises into an authority. That trick does not
  // transfer: a fragment is opaque to URL parsing, so nothing normalises it and
  // re-parsing tells you nothing. A browser will not resolve it either, which
  // makes this unexploitable rather than safe - and a canvas route has no
  // business containing ".." in the first place. Refusing is cheaper than
  // reasoning about it every time somebody reads this.
  if (/(^|\/)\.\.?(\/|$)/.test(value.slice(1))) return null

  // A single leading slash, then a route. Anything else is not ours.
  if (!/^#\/[\w\-./~%!$&'()*+,;=:@?[\]]*$/.test(value)) return null

  return value
}

export function marverIdHandler(dir: string, issuer: string, canvasName?: string, branding = true, ceilings: Record<string, 'none' | 'view' | 'comment'> = {}) {
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
  // REQUIRED, with no loopback exception and no inference.
  //
  // There used to be one: a request whose socket was loopback at both ends was
  // treated as a local browser, so development needed no configuration. That
  // does not survive contact with how canvases are actually deployed. nginx's
  // documented `proxy_pass http://localhost:PORT` replaces Host with the
  // upstream's name and adds no X-Forwarded-* headers at all - so a request from
  // the open internet arrives looking exactly like a local one, and the canvas
  // would hand its caller an http://localhost audience and a session cookie with
  // no Secure flag.
  //
  // Refusing forwarding headers was the first attempt, and it only narrows the
  // gap: absence of a header is not evidence of a browser. There is no signal
  // here that a proxy cannot erase, so the canvas stops guessing and asks. Local
  // development sets MARVER_PUBLIC_ORIGIN=http://localhost:4173 like anywhere
  // else - one variable, and the audience is a fact rather than an inference.
  const pinned = (process.env.MARVER_PUBLIC_ORIGIN ?? '').trim().replace(/\/$/, '')
  let publicOrigin: string
  {
    if (!pinned) {
      throw new Error(
        'MARVER_PUBLIC_ORIGIN is required when MARVER_ID_ISSUER is set.\n' +
        "  Set it to this canvas's exact public origin - scheme, host and port -\n" +
        '  e.g. https://canvas.example.com, or http://localhost:4173 in development.',
      )
    }
    let u: URL
    try { u = new URL(pinned) } catch { throw new Error(`MARVER_PUBLIC_ORIGIN is not a URL: ${pinned}`) }
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
    // Bare means bare: no path, no query, no fragment, and no credentials.
    // `https://user:pass@canvas.example` parses fine and normalises to the same
    // origin, so it would be accepted silently - an operator reading one thing
    // while the canvas uses another, which is the whole failure mode this
    // validation exists to prevent.
    if (u.username || u.password) throw new Error(`MARVER_PUBLIC_ORIGIN must not carry credentials: ${pinned}`)
    if (u.pathname !== '/' || u.search || u.hash) throw new Error(`MARVER_PUBLIC_ORIGIN must be a bare origin: ${pinned}`)
    // https anywhere, or http on loopback - and nothing else. The loopback
    // exception used to be written as "not https is fine if the host is local",
    // which also waved through ftp://localhost and every other scheme, each of
    // them quietly turning off the Secure flag on the way past.
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) {
      throw new Error(`MARVER_PUBLIC_ORIGIN must be https, or http on loopback: ${pinned}`)
    }
    publicOrigin = u.origin
  }

  return async function handle(req: any, res: any, url: URL): Promise<boolean> {
    const origin = publicOrigin

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
      }
      // Re-set it on every start, not only when it is missing.
      //
      // The handle and the transaction are two halves of one deadline, and only
      // the transaction was being renewed. A handle set once and left to expire
      // meant a sign-in could hold a perfectly live transaction it no longer had
      // the cookie to claim - and the callback's answer for that is the same
      // blank refusal as a forged token. Stamping it here keeps both halves
      // running from the same moment.
      headers.push(cookie(browserCookieName(secure), browserId, { maxAge: HANDLE_TTL_S, secure }))

      // Where they were heading, captured by the gate's script from the URL
      // fragment - the one part of a link no server ever receives. Kept in the
      // transaction; it never crosses to the identity service.
      const next = safeHash(url.searchParams.get('next'))

      const tx = transactions.mint(origin, browserBinding(browserId), next ?? undefined)
      const authorize = `${issuer}/authorize?origin=${encodeURIComponent(origin)}&nonce=${encodeURIComponent(tx.nonce)}`
        // The canvas's own name, so the sign-in page can say what it is for
        // rather than asking somebody to sign in to nothing in particular.
        + (canvasName ? `&name=${encodeURIComponent(canvasName)}` : '')

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
      // The assertion lands on this page. Framing it is somebody else watching
      // a sign-in complete.
      res.setHeader('content-security-policy', "frame-ancestors 'none'")
      res.setHeader('x-frame-options', 'DENY')
      res.end(finishPage(canvasName, new URL(origin).host,
        `${issuer}/switch?origin=${encodeURIComponent(origin)}`, branding))
      return true
    }

    if (req.method === 'POST' && url.pathname === '/__mv/id/callback') {
      const { body, tooLarge } = await readBody(req, 16_000)
      if (tooLarge) {
        // Answer, then hang up. The rest of an oversized or too-slow body is
        // still unread in the socket, and reusing a connection in that state
        // under keep-alive gets the next request parsed out of leftover bytes.
        // The refusal still arrives - it is written before the close.
        res.setHeader('connection', 'close')
        return json(res, 413, { error: 'too large' })
      }
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

      // consume() returns the transaction, which carries the deep link the gate
      // captured before leaving. Reading it here keeps it server-side start to
      // finish - it never travelled to the identity service and back.
      let landing: string | null = null
      const result = await verifyAssertion({
        token: assertion, origin, issuer, store: transactions,
        browser: browserBinding(browserId),
        onConsumed: (tx) => { landing = tx.next ?? null },
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
        { ownerEmail: process.env.MARVER_OWNER_EMAIL, ceilings },
      )

      if (!session) {
        // The REASON stays private - whether an address sits on somebody's invite
        // list is not public knowledge, and this refusal is deliberately the same
        // shape as one for a bad token.
        //
        // The address is different. It came out of an assertion this browser just
        // presented, signed by the identity service and bound to this browser's
        // own handle - so it is theirs, they supplied it, and handing it back
        // tells them nothing they did not already know. What it does buy is the
        // answer to the only question a refused person actually has: which
        // account did I just use? Withholding that made a correct refusal read as
        // a fault.
        console.warn(`[marver-id] ${result.identity.email} is not on this canvas's list`)
        // Being refused should offer a door (01-sharing §7.6): a VERIFIED
        // refusal mints the request token - short-lived, origin-bound, single
        // purpose - and the finish page renders the ask. A blocked address gets
        // no token: the blocklist beats request-access eligibility too. The
        // target rides as CONTEXT (the thing the link pointed at); approval in
        // v1 is canvas-wide and the owner's surface says so.
        let request: string | undefined
        try {
          const { shareState, provisionVerdict } = await import('./share.ts')
          const share = shareState(dir)
          const blocked = share ? provisionVerdict(share, result.identity.email) === 'blocked' : false
          if (!blocked) {
            const { signCanvasJws } = await import('./summary.ts')
            const now = Math.floor(Date.now() / 1000)
            request = signCanvasJws(dir, {
              aud: origin, sub: result.identity.subject, email: result.identity.email,
              ...(result.identity.name ? { name: result.identity.name } : {}),
              ...(result.identity.picture ? { picture: result.identity.picture } : {}),
              target: landing ?? '', iat: now, exp: now + 900, jti: randomBytes(12).toString('hex'),
            }, 'marver-reqaccess+jwt')
          }
        } catch { /* no data dir or no key - the refusal stands alone */ }
        return json(res, 403, { error: 'not invited', email: result.identity.email, ...(request ? { request } : {}) })
      }

      // Their picture, fetched only now - after they are in, and outside the
      // store lock.
      //
      // Both halves of that matter. Fetching before the allowlist decision let
      // anybody holding a valid assertion make this canvas issue an outbound
      // request, over and over, without ever being a member of it; the invite
      // list is what bounds it. And a lock held across a network round trip is
      // a lock held for as long as somebody else's CDN feels like taking, with
      // every other sign-in queued behind it.
      //
      // Best-effort to the end: a picture is decoration, and somebody who is
      // already through the door is not turned around over one.
      const picture = result.identity.picture
      const qualified = `${issuer}#${result.identity.subject}`
      if (picture) {
        // Read what is stored BEFORE fetching, and hand it back afterwards, so
        // the write can tell whether anything moved while the network was busy.
        const before = avatarSourceFor(dir, qualified, result.identity.email, picture)
        if (before.wanted) {
          const avatar = await fetchAvatar(picture)
          if (avatar) attachAvatar(dir, qualified, avatar, picture, before.source)
        }
      }

      res.setHeader('set-cookie', [
        cookie(SESSION_COOKIE, session.session, { maxAge: MONTH, secure }),
        // The other half of the double-submit pair, and NOT optional.
        //
        // Every mutation in collab.ts requires a JS-readable mv_c echoed back as
        // x-mv-c, and its check reads "no session, or a matching pair" - so a
        // session WITHOUT mv_c fails every time. Issuing mv_s alone produced a
        // canvas somebody could read and never write to: no comments, no profile,
        // no invites, all 403. The password path has always set both here; this
        // one simply forgot, and nothing failed loudly enough to notice.
        //
        // Deliberately NOT HttpOnly - the browser has to read it to echo it. It
        // carries no authority on its own; the session cookie does.
        `${CSRF_COOKIE}=${randomBytes(16).toString('base64url')}; Path=/; Max-Age=${MONTH}; SameSite=Lax${secure ? '; Secure' : ''}`,
        // The browser handle has done its job.
        cookie(browserCookieName(secure), '', { maxAge: 0, secure }),
      ])
      return json(res, 200, { ok: true, next: landing })
    }

    return json(res, 404, { error: 'not found' })
  }
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
/**
 * The mark and the escaper, defined here rather than imported from serve.ts.
 *
 * serve.ts imports this module, so reaching back for them would be a cycle. The
 * paths are the same ones the gate draws - if one changes, both change, which
 * is exactly the coupling the shared look depends on.
 */
const MARK_AT = (size: number) => `<svg viewBox="0 0 256 256" width="${size}" height="${size}" fill="currentColor" aria-hidden><path d="M239.29,59.28l-64.8,144a8,8,0,0,1-7.3,4.72H24a8,8,0,0,1-7.3-11.28l64.8-144A8,8,0,0,1,88.81,48H232A8,8,0,0,1,239.29,59.28Z" opacity=".1"/><path d="M245.43,47.31A15.94,15.94,0,0,0,232,40H88.81a16,16,0,0,0-14.59,9.43l-64.8,144A16,16,0,0,0,24,216H167.19a16,16,0,0,0,14.59-9.43l64.8-144A16,16,0,0,0,245.43,47.31ZM167.19,200H24L88.81,56H232Z"/></svg>`
const MARK = MARK_AT(18)
const MARK_LG = MARK_AT(24)
const ARROW = `<svg class="up" viewBox="0 0 256 256" width="11" height="11" fill="currentColor" aria-hidden><path d="M200,64V168a8,8,0,0,1-16,0V83.31L69.66,197.66a8,8,0,0,1-11.32-11.32L172.69,72H88a8,8,0,0,1,0-16H192A8,8,0,0,1,200,64Z"/></svg>`

/** The canvas name is the operator's own, but it still lands in HTML. */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * `share: { branding: false }` is documented as stripping every Marver mention,
 * and this page was the exception nobody noticed - the last screen of the flow,
 * still wearing the footer an operator had explicitly turned off. A setting that
 * holds almost everywhere is a setting you cannot rely on.
 */
function finishPage(canvasName: string | undefined, host: string, switchUrl: string, branding = true): string {
  const name = esc(canvasName || 'this canvas')
  const where = esc(host)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Signing in - ${name}</title>
<link rel="icon" href="/__mv/favicon/favicon.ico" sizes="48x48" />
<style>
  /* The gate's own tokens. This page is the last thing somebody sees before the
     canvas opens - or the only thing, if they are refused - so it belongs to
     the same surface rather than looking like an error from somewhere else. */
  * { box-sizing: border-box }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column;
         align-items: center; justify-content: center; gap: 18px;
         background-color: #e7e9ef;
         background-image: radial-gradient(#c9cbd5 1px, transparent 1px);
         background-size: 20px 20px;
         font: 500 14px -apple-system, system-ui, sans-serif; color: #18181b;
         -webkit-font-smoothing: antialiased }
  .card { width: 340px; padding: 24px; border-radius: 24px;
          background: rgba(255,255,255,.64);
          backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
          box-shadow: 0 1px 2px rgba(24,24,27,.04), 0 12px 32px rgba(24,24,27,.07);
          display: flex; flex-direction: column; gap: 14px }
  header { display: flex; align-items: center; gap: 9px }
  header svg { color: #0088ff; flex: none }
  h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -.01em }
  /* Pulled up against the address below it: the state line introduces that
     chip rather than floating between it and the canvas name. */
  .state { margin: 0 0 -8px; padding: 0 4px; font-size: 13.5px; font-weight: 600 }
  .chip { height: 40px; padding: 0 16px; border-radius: 999px;
          background: rgba(24,24,27,.05); display: flex; align-items: center;
          font: 500 13px ui-monospace, SFMono-Regular, Menlo, monospace;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  p.lead { margin: 0; padding: 0 4px; font-size: 12.5px; line-height: 1.5;
           color: rgba(24,24,27,.66) }
  p.lead strong { color: #18181b; font-weight: 600 }
  a.cta { height: 40px; border-radius: 999px; background: #18181b; color: #fafafa;
          font: 600 13px -apple-system, system-ui, sans-serif; text-decoration: none;
          display: flex; align-items: center; justify-content: center }
  footer a { display: inline-flex; align-items: center; gap: 7px;
             font: 600 12.5px -apple-system, system-ui, sans-serif;
             color: rgba(24,24,27,.5); text-decoration: none }
  footer a > svg:first-of-type { color: #0088ff }
  footer .md, footer .up { transition: color .15s, opacity .15s }
  footer a:hover .md { color: #0088ff; text-decoration: underline; text-underline-offset: 3px }
  footer .up { opacity: .45; margin-left: -3px }
  footer a:hover .up { opacity: 1; color: #0088ff }
  [hidden] { display: none !important }
  /* Shown only if the wait becomes long enough to be worth explaining.
     Painting the whole card first meant every successful sign-in flashed a
     panel naming the canvas and its address on the way past - a screen nobody
     needs, appearing and vanishing, which reads as a stutter rather than as
     progress. The card is for when something has to be SAID; getting in says
     itself by the canvas appearing. */
  /* the request-access ask (01-sharing §7.6): the gate's own language - chips,
     rounded field, the same CTA - below a hairline. */
  .rdiv { border: 0; height: 1px; background: rgba(24,24,27,.09); margin: 2px 2px 6px }
  .rrow { display: flex; gap: 8px; padding: 0 2px }
  .rchip { flex: 1; cursor: pointer }
  .rchip input { position: absolute; opacity: 0; pointer-events: none }
  .rchip span { display: flex; align-items: center; justify-content: center; height: 34px;
                border-radius: 999px; border: 1px solid rgba(24,24,27,.14); background: #fff;
                font: 500 12.5px -apple-system, system-ui, sans-serif; transition: border-color .15s, box-shadow .15s }
  .rchip input:checked + span { border-color: #0088ff; box-shadow: 0 0 0 3px rgba(0,136,255,.14); color: #0088ff }
  #req { display: flex; flex-direction: column; gap: 12px }
  #req[hidden] { display: none }
  #req textarea { padding: 10px 16px; border-radius: 16px; border: 1px solid rgba(24,24,27,.14);
                  background: #fff; color: #18181b; font: 500 13px -apple-system, system-ui, sans-serif;
                  outline: none; resize: none; width: 100% }
  #req textarea:focus { border-color: #0088ff; box-shadow: 0 0 0 3px rgba(0,136,255,.18) }
  #req button.cta { border: 0; width: 100%; cursor: pointer }
  #req button.cta:disabled { background: rgba(24,24,27,.35); cursor: default }
  .wait { width: 34px; height: 34px; border-radius: 50%;
          border: 3px solid rgba(24,24,27,.12); border-top-color: #0088ff;
          animation: spin .7s linear infinite }
  @keyframes spin { to { transform: rotate(360deg) } }
  @media (prefers-reduced-motion: reduce) {
    .wait { animation: none; border-top-color: rgba(24,24,27,.35) }
  }
</style></head>
<body>
  <div class="wait" id="wait" role="status" aria-label="Signing you in" hidden></div>
  <div class="card" id="card" hidden>
    <header>${MARK_LG}<h1 id="t">${name}</h1></header>
    <p class="state" id="s"></p>
    <div class="chip">${where}</div>
    <p class="lead" id="m"></p>
    <p class="lead" id="m2" hidden></p>
    <a class="cta" id="back" href="/" data-switch="${esc(switchUrl)}" hidden>Use a different account</a>
    <div id="req" hidden>
      <hr class="rdiv" />
      <p class="lead">Or ask for access - the owner decides who gets in.</p>
      <div class="rrow">
        <label class="rchip"><input type="radio" name="rrole" value="view" checked /><span>View</span></label>
        <label class="rchip"><input type="radio" name="rrole" value="comment" /><span>View + comment</span></label>
      </div>
      <textarea id="rnote" maxlength="500" rows="2" placeholder="Add a note (optional)"></textarea>
      <button class="cta" id="rgo" type="button">Request access</button>
    </div>
  </div>
  ${branding ? `<footer id="mark" hidden><a href="${poweredByUrl(canvasName, 'published-canvas', 'sign-in')}" target="_blank" rel="noopener">${MARK} <span>Powered by <span class="md">Marver.design</span></span> ${ARROW}</a></footer>` : ''}
<script>
(function () {
  var s = document.getElementById('s'), m = document.getElementById('m'), back = document.getElementById('back')
  var m2 = document.getElementById('m2')
  var wait = document.getElementById('wait'), card = document.getElementById('card')

  /**
   * A spinner, but only if the wait is long enough to need one.
   *
   * This page is usually one POST - fifty to two hundred milliseconds - and a
   * spinner that appears and vanishes inside that window is worse than no
   * spinner at all: it is a flicker, and a flicker reads as something going
   * wrong. Held back, the fast path shows only the dotted ground, which is the
   * same ground the canvas itself is drawn on - so it looks like the canvas
   * loading rather than like a screen in between.
   *
   * Past a second and a half the wait is real, and silence stops being calm and
   * starts being broken. That is when the spinner earns its place.
   */
  var slow = setTimeout(function () { wait.hidden = false }, 1500)

  /**
   * Stop waiting and show the card - only ever for something worth reading.
   *
   * The badge belongs to the CARD, not to the page. Left outside the hidden
   * card it sat by itself in the middle of an empty ground on every successful
   * sign-in - which is the same flash the card used to be, wearing a smaller
   * hat. Nothing is on screen until there is something to say.
   */
  var mark = document.getElementById('mark')
  function speak() {
    clearTimeout(slow)
    wait.hidden = true
    card.hidden = false
    if (mark) mark.hidden = false
  }
  /**
   * State, what happened, and - separately - what to do about it.
   *
   * The advice used to run on from the diagnosis in one paragraph, so the
   * sentence that tells somebody how to get unstuck was buried at the end of
   * the sentence explaining why they are stuck. They are two different thoughts
   * and the person only needs the second one.
   */
  function stop(state, msg, cta, advice) {
    speak()
    s.textContent = state; m.textContent = msg
    if (advice) { m2.textContent = advice; m2.hidden = false }
    if (cta) { back.textContent = cta; back.hidden = false }
  }

  /** Refused, and told which account did it. */
  function refused(email) {
    speak()
    s.textContent = "You haven't been invited"
    m.textContent = ''
    m.appendChild(document.createTextNode('You are signed in as '))
    var b = document.createElement('strong')
    b.textContent = email
    m.appendChild(b)
    m.appendChild(document.createTextNode(', and that address is not on the invite list for this canvas.'))
    m2.textContent = 'Ask whoever owns it to add you, or sign in with the address they invited.'
    m2.hidden = false
    back.textContent = 'Use a different account'
    // Signing out happens at the identity service - this canvas cannot reach
    // across origins to do it, and sending them back here would just hand them
    // the same account and the same refusal.
    back.href = back.getAttribute('data-switch') || '/'
    back.hidden = false
  }

  /** The door a refusal offers: role, note, one send. The response is the same
   *  whatever the server recognised (no probe oracle) - "sent" is all it says. */
  function offerRequest(token) {
    var req = document.getElementById('req'), go = document.getElementById('rgo')
    req.hidden = false
    go.addEventListener('click', function () {
      go.disabled = true
      var role = (document.querySelector('input[name="rrole"]:checked') || {}).value === 'comment' ? 'comment' : 'view'
      var note = (document.getElementById('rnote') || {}).value || ''
      fetch('/__mv/api/request-access', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ requestedRole: role, note: note.slice(0, 500) })
      }).then(function () { sent() }, function () { sent() })
      function sent() {
        go.textContent = 'Request sent'
        var lead = req.querySelector('p.lead')
        if (lead) lead.textContent = 'The owner will review it. If they approve, signing in again will let you straight in.'
      }
    })
  }

  // Take it, then erase it - before any await, so a slow network cannot leave
  // the assertion sitting in the address bar.
  var assertion = location.hash.replace(/^#/, '')
  try { history.replaceState(null, '', location.pathname) } catch (e) {}

  if (!assertion) return stop('Nothing to sign in with', 'That link is incomplete. Start again from the canvas.', 'Back to the canvas')

  fetch('/__mv/id/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion: assertion })
  }).then(function (res) {
    if (res.ok) {
      // Back to the board or thread the link pointed at. The server decides
      // where that is - it held the deep link the whole time - so a value in
      // this page cannot send anybody somewhere else.
      return res.json().then(function (body) {
        var to = body && typeof body.next === 'string' && body.next.indexOf('#/') === 0 ? body.next : ''
        location.replace('/' + to)
      }, function () { location.replace('/') })
    }
    if (res.status === 403) {
      return res.json().then(function (body) {
        var who = body && typeof body.email === 'string' ? body.email : ''
        // textContent, never innerHTML: the address is attested, but it is still
        // a string arriving over the wire and this page will not be the place
        // that learns the difference the hard way.
        who ? refused(who) : stop("You haven't been invited",
          'That account is not on the invite list for this canvas. Ask whoever owns it to add your address.',
          'Use a different account')
        if (who && body && typeof body.request === 'string') offerRequest(body.request)
      }, function () {
        stop("You haven't been invited",
          'That account is not on the invite list for this canvas.',
          'Use a different account',
          'Ask whoever owns it to add your address.')
      })
    }
    stop('That sign-in did not work', 'Start again from the canvas, or try a different account.', 'Try again')
  }).catch(function () {
    stop('Could not reach the canvas', 'It may have stopped. Try again in a moment.', 'Try again')
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
function readBody(req: any, limit: number, timeoutMs = 10_000): Promise<{ body: string; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (tooLarge: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ body: tooLarge ? '' : Buffer.concat(chunks).toString('utf8'), tooLarge })
    }

    // A deadline, because the size limit alone bounds only memory.
    //
    // /__mv/id/callback answers before anyone has signed in, so a caller can open
    // as many as they like and dribble bytes: each stays under 16KB forever and
    // holds a socket. Bounded memory and unbounded sockets is still a canvas
    // nobody can reach.
    // Treated exactly like an oversized body: stop reading, refuse, and let the
    // caller close the connection. Same reason as above - destroying here would
    // take the socket before the refusal could be written.
    const timer = setTimeout(() => { req.pause(); finish(true) }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    req.on('data', (c: Buffer) => {
      size += c.length
      // pause(), NOT destroy(). Destroying takes the socket with it, and the 413
      // we are about to write then has nowhere to go - which is the bug an
      // earlier version of this function already had and fixed. The un-drained
      // remainder is dealt with by closing the connection AFTER the response;
      // see the `connection: close` on the 413.
      if (size > limit) { req.pause(); return finish(true) }
      chunks.push(c)
    })
    req.on('end', () => finish(false))
    req.on('error', () => finish(true))
  })
}
