/**
 * Marver ID - the canvas half of the protocol.
 *
 * A canvas never trusts a token because it looks well-formed. The sequence is:
 *
 *   1. mint()             - the canvas invents a nonce and remembers it, bound
 *                           to this browser and this exact origin.
 *   2. the TAB goes to id.marver.design/authorize and comes back to
 *      /__mv/id/finish with the assertion in the URL fragment. One tab, one
 *      redirect each way - no popup and no postMessage, because Google serves
 *      COOP: same-origin and severs window.opener permanently. See
 *      marver-id-gate.ts for the full reasoning.
 *   3. verifyAssertion()  - the canvas SERVER checks every claim against the
 *                           published keys, then consumes the transaction.
 *
 * Step 3 is the one that matters. `aud` must equal this canvas's own origin,
 * so an assertion captured on an attacker's site is inert here; the nonce must
 * match a transaction we actually issued, so a token cannot be injected from
 * nowhere; and the transaction is single-use, so it cannot be replayed even
 * within its short life.
 *
 * Everything here is dependency-free and runs in the OSS canvas, because every
 * self-hosted deployment needs to do this for itself. Nothing phones home
 * except the periodic fetch of public keys.
 */
import { createHash, randomBytes, timingSafeEqual, createVerify } from 'node:crypto'

/**
 * How long a sign-in may take, start to finish.
 *
 * Was five minutes, which quietly assumed the identity service answers
 * instantly. It does not: a sign-in there can mean waiting for an emailed code,
 * and mail is store-and-forward - a first-time sender can be greylisted and
 * deferred for minutes before the message is even accepted. Somebody who went to
 * find their code and came back to "unknown or spent nonce" did nothing wrong.
 *
 * Fifteen minutes covers a slow round trip with room to spare, and costs little:
 * the nonce is single-use, bound to one browser and one origin, and useless
 * without a signature from the issuer. The browser handle below is set to match,
 * so the two halves of the same deadline expire together rather than leaving a
 * window where the transaction lives but the handle that owns it is gone.
 */
const TRANSACTION_TTL_MS = 15 * 60 * 1000
/** Servers drift; allow a little, but not enough to matter. */
const CLOCK_TOLERANCE_S = 30
/** Public keys are cached; rotation publishes a key well before it signs. */
const JWKS_TTL_MS = 10 * 60 * 1000
/** A ceiling on token size - nothing legitimate is close to this. */
const MAX_TOKEN_BYTES = 8192

export type Transaction = {
  nonce: string
  origin: string
  browser: string
  exp: number
  /**
   * The deep link they arrived on, kept here rather than sent anywhere.
   *
   * A canvas link carries its board and thread in the FRAGMENT, which no server
   * ever receives - so the only way it survives a sign-in is if the canvas holds
   * it. Putting it in the transaction means it never crosses to the identity
   * service, and it is spent with the nonce.
   */
  next?: string
}

export type VerifiedIdentity = {
  /** Stable id from the identity service. Grants bind to this, not to email. */
  subject: string
  email: string
  /**
   * Display only, and never load-bearing.
   *
   * Both are self-asserted at the identity service - somebody's name is whatever
   * they told Google - so nothing may branch on them. They exist so a canvas can
   * render a person the way they recognise themselves instead of slicing their
   * address at the @.
   *
   * `picture` is a URL that has been checked for shape and scheme here and
   * NOTHING else. Whether to fetch it, and how to survive doing so, is the
   * caller's problem - see fetchAvatar in auth.ts.
   */
  name?: string
  picture?: string
}

export type VerifyResult =
  | { ok: true; identity: VerifiedIdentity }
  | { ok: false; reason: string }

/**
 * The transaction store.
 *
 * In memory on purpose: a transaction is short-lived, and a canvas that
 * restarts mid-sign-in should simply ask the person to try again rather than
 * persist half-finished authentications to disk.
 */
/** A ceiling on live transactions - /start is unauthenticated by necessity. */
const MAX_TRANSACTIONS = 10_000

/** How often the expiry sweep is allowed to walk the whole map. */
const SWEEP_INTERVAL_MS = 10 * 1000

export class TransactionStore {
  private readonly items = new Map<string, Transaction>()
  /** nonce currently held by each browser, so one browser holds one slot. */
  private readonly byBrowser = new Map<string, string>()
  private lastSweep = 0

  /** Invent a nonce for a sign-in attempt from this browser to this origin. */
  mint(origin: string, browser: string, next?: string): Transaction {
    this.sweep()

    // One live transaction per browser, and starting again REUSES it.
    //
    // /__mv/id/start has to answer before anyone has signed in, so it is a free
    // endpoint and somebody can hold it down. Without a per-browser limit a
    // single caller mints unboundedly and pushes real sign-ins out of the map.
    //
    // Reusing rather than replacing matters just as much. The binding comes from
    // a cookie, and on a shared parent domain a sibling host can set one -
    // so if a second start DESTROYED the first, anyone who could make a browser
    // send a chosen value could cancel a sign-in already in flight. Handing back
    // the transaction that browser already holds removes the destructive move
    // entirely, and is what a person means by clicking Continue twice.
    const held = this.byBrowser.get(browser)
    if (held) {
      const live = this.items.get(held)
      if (live && live.exp >= Date.now() && live.origin === origin) {
        // Pressing Continue from a different board should still land there.
        if (next) live.next = next
        // Starting again restarts the clock.
        //
        // Reuse without renewal meant a second Continue handed back a nonce with
        // whatever was left of the first one's life - press it fourteen minutes
        // in and you get a fresh browser handle good for fifteen minutes and a
        // transaction with one. Somebody who starts over is asking for a full
        // attempt, and the deadline they are actually racing is the one that
        // started when they last pressed the button.
        live.exp = Date.now() + TRANSACTION_TTL_MS
        return live
      }
      if (held) this.items.delete(held)
    }

    // Still bounded overall, because a caller can always present a fresh
    // binding. Past the cap, drop the oldest; a displaced person clicks again.
    if (this.items.size >= MAX_TRANSACTIONS) {
      const oldest = this.items.keys().next().value
      if (oldest) {
        const victim = this.items.get(oldest)
        this.items.delete(oldest)
        if (victim && this.byBrowser.get(victim.browser) === oldest) {
          this.byBrowser.delete(victim.browser)
        }
      }
    }
    const tx: Transaction = {
      nonce: randomBytes(32).toString('base64url'),
      origin,
      browser,
      exp: Date.now() + TRANSACTION_TTL_MS,
      ...(next ? { next } : {}),
    }
    this.items.set(tx.nonce, tx)
    this.byBrowser.set(browser, tx.nonce)
    return tx
  }

  /**
   * Take a transaction, if it is real, unexpired, and belongs to this browser.
   *
   * The browser check happens BEFORE the delete, and that ordering is the whole
   * point: a stranger who somehow learns a nonce must not be able to destroy
   * somebody else's live sign-in by presenting it. Only the browser that owns a
   * transaction can spend it - for anyone else it is inert, and left alone.
   *
   * Once ownership is proved the transaction is removed unconditionally, so the
   * legitimate browser gets exactly one attempt and a forged signature cannot be
   * ground against a live nonce.
   */
  consume(nonce: string, browser: string): Transaction | null {
    const tx = this.items.get(nonce)
    if (!tx) return null
    if (!constantTimeEqual(tx.browser, browser)) return null
    this.items.delete(nonce)
    if (this.byBrowser.get(tx.browser) === nonce) this.byBrowser.delete(tx.browser)
    if (tx.exp < Date.now()) return null
    return tx
  }

  /**
   * Drop what has expired.
   *
   * Throttled, because this walks the whole map and it is reached from an
   * unauthenticated endpoint - running it on every mint turns /start into a
   * quadratic cost the caller controls. Expiry is still enforced exactly, in
   * consume(); this only reclaims memory, and ten seconds late is fine.
   */
  private sweep() {
    const now = Date.now()
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return
    this.lastSweep = now
    for (const [k, v] of this.items) {
      if (v.exp < now) {
        this.items.delete(k)
        if (this.byBrowser.get(v.browser) === k) this.byBrowser.delete(v.browser)
      }
    }
  }

  get size(): number { return this.items.size }
}

/**
 * Reduce a configured issuer to a bare origin, or refuse it.
 *
 * The issuer is the trust root: its published keys decide who may open this
 * canvas. Taken as a raw string it is far too easy to configure into something
 * that is not a trust root at all - `http://` invites anyone on the path
 * between here and there to serve their own keys, and a value carrying a path,
 * a query or embedded credentials means the URL the operator read is not the
 * URL that gets fetched.
 *
 * Loopback over http is allowed because that is how the protocol is developed
 * against a local identity service, and there is no network to sit on.
 *
 * Returns null when the value cannot be trusted, so the caller can refuse to
 * start rather than run with a trust root nobody vetted.
 */
export function normalizeIssuer(raw: string | undefined | null): string | null {
  if (!raw) return null

  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }

  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null

  // Credentials, a path, a query or a fragment all mean the operator is looking
  // at one thing and the fetch will do another.
  if (url.username || url.password) return null
  if (url.pathname !== '/' || url.search || url.hash) return null

  return url.origin
}

/** Cached public keys from the identity service. */
type Jwks = { keys: Array<Record<string, unknown>> }
let jwksCache: { at: number; url: string; jwks: Jwks } | null = null

/**
 * The last time an unknown kid forced a refetch, and how rarely that may happen.
 *
 * The token chooses the kid, so without a floor here a caller manufactures one
 * outbound request per attempt.
 */
let lastForcedFetch = 0
const FORCED_FETCH_COOLDOWN_MS = 30 * 1000

/**
 * The fetch currently in flight, if there is one.
 *
 * The cooldown above bounds refetches for an UNKNOWN kid, but says nothing about
 * a cold cache: at boot, or the moment the cache ages out, every callback that
 * arrives at once sees no entry and starts its own request. That is a thundering
 * herd pointed at the identity service, and a caller holding transactions can
 * time it deliberately. One request per URL, shared by everyone waiting for it.
 */
let inFlight: { url: string; p: Promise<Jwks> } | null = null

async function fetchJwks(issuer: string, force = false): Promise<Jwks> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`
  if (!force && jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < JWKS_TTL_MS) {
    return jwksCache.jwks
  }
  if (inFlight && inFlight.url === url) return inFlight.p
  const p = fetchJwksNow(url)
  inFlight = { url, p }
  try { return await p } finally { if (inFlight?.p === p) inFlight = null }
}

async function fetchJwksNow(url: string): Promise<Jwks> {
  // Never follow a redirect for the keys.
  //
  // normalizeIssuer() works hard to make the configured origin the trust root,
  // and a followed redirect hands that root away: an ordinary open redirect on
  // the identity service - the sort of bug that is usually a shrug - would
  // become "serve your own P-256 key and mint sessions for any invited address".
  // The real service answers this path directly, so a redirect here is either a
  // misconfiguration or an attack, and both deserve the same refusal.
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' })
  if (!res.ok) throw new Error(`jwks fetch failed (${res.status})`)
  const jwks = (await res.json()) as Jwks
  if (!Array.isArray(jwks.keys)) throw new Error('jwks malformed')
  jwksCache = { at: Date.now(), url, jwks }
  return jwks
}

/** Only for tests - drop the cached keys. */
export function _resetJwksCache() { jwksCache = null; lastForcedFetch = 0; inFlight = null }

/**
 * Verify an assertion against everything it claims to be.
 *
 * Deliberately returns a reason string rather than throwing: the caller logs it
 * and shows the person a single generic failure. Distinguishing "expired" from
 * "wrong audience" to the browser would be handing an attacker a debugger.
 */
export async function verifyAssertion(opts: {
  token: string
  /** This canvas's own origin - what `aud` must equal, exactly. */
  origin: string
  /** The identity service, e.g. https://id.marver.design */
  issuer: string
  /** Transaction store to consume the nonce from. */
  store: TransactionStore
  /** Opaque per-browser value, matched against the transaction. */
  browser: string
  /**
   * Called with the transaction at the moment it is spent.
   *
   * The caller needs what the transaction was carrying - the deep link somebody
   * arrived on - and consume() is single-use, so there is no second chance to
   * ask. Handing it over here keeps the verifier's own answer unchanged: it
   * still returns ok or a reason, and nothing else.
   */
  onConsumed?: (tx: Transaction) => void
}): Promise<VerifyResult> {
  const { token, origin, issuer, store, browser } = opts

  if (!token || token.length > MAX_TOKEN_BYTES) return { ok: false, reason: 'token size' }

  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'not a jws' }

  let header: Record<string, unknown>
  let claims: Record<string, unknown>
  try {
    const h = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as unknown
    const c = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown
    // `null`, `[]`, `1` and `"x"` are all valid JSON, and `null.alg` throws a
    // TypeError rather than returning a rejection - which would escape this
    // function's contract and, unhandled, take the process with it. Every caller
    // is entitled to a VerifyResult, never an exception.
    if (!isPlainObject(h) || !isPlainObject(c)) return { ok: false, reason: 'malformed json' }
    header = h
    claims = c
  } catch { return { ok: false, reason: 'malformed json' } }

  // Algorithm is pinned, not read from the token. `none`, HMAC confusion, and
  // anything else the header might ask for are refused here rather than later.
  if (header.alg !== 'ES256') return { ok: false, reason: 'alg' }
  if (header.typ !== 'marver-assertion+jwt') return { ok: false, reason: 'typ' }
  // A token must never be able to tell us where to fetch keys from.
  if ('jku' in header || 'x5u' in header || 'jwk' in header) return { ok: false, reason: 'header injection' }
  const kid = typeof header.kid === 'string' ? header.kid : null
  if (!kid || kid.length > 128) return { ok: false, reason: 'kid' }

  // Claims, checked before any cryptography: cheap rejections first.
  if (claims.iss !== issuer) return { ok: false, reason: 'iss' }
  if (claims.aud !== origin) return { ok: false, reason: 'aud' }
  if (claims.email_verified !== true) return { ok: false, reason: 'email unverified' }
  const sub = typeof claims.sub === 'string' ? claims.sub : ''
  const email = typeof claims.email === 'string' ? claims.email : ''
  const nonce = typeof claims.nonce === 'string' ? claims.nonce : ''
  if (!sub || !email || !nonce) return { ok: false, reason: 'missing claims' }

  const now = Math.floor(Date.now() / 1000)
  const exp = typeof claims.exp === 'number' ? claims.exp : 0
  const nbf = typeof claims.nbf === 'number' ? claims.nbf : 0
  const iat = typeof claims.iat === 'number' ? claims.iat : 0
  if (!exp || exp + CLOCK_TOLERANCE_S < now) return { ok: false, reason: 'expired' }
  if (nbf && nbf - CLOCK_TOLERANCE_S > now) return { ok: false, reason: 'not yet valid' }
  if (!iat || iat - CLOCK_TOLERANCE_S > now) return { ok: false, reason: 'issued in the future' }

  // The nonce must name a transaction WE issued, from THIS browser, to THIS
  // origin. Consumed either way, so a bad token burns its nonce.
  const tx = store.consume(nonce, browser)
  if (!tx) return { ok: false, reason: 'unknown or spent nonce' }
  if (tx.origin !== origin) return { ok: false, reason: 'origin mismatch' }
  // Only after the transaction has proved it belongs to this browser and this
  // origin. Handing the caller anything from an unproven one would let a
  // stranger's nonce decide where somebody lands.
  opts.onConsumed?.(tx)

  // Signature last: everything above is free, this costs a key fetch.
  let verified = false
  try {
    verified = await verifySignature(parts, kid, issuer)
  } catch {
    return { ok: false, reason: 'key fetch failed' }
  }
  if (!verified) return { ok: false, reason: 'signature' }

  return { ok: true, identity: { subject: sub, email, ...displayClaims(claims) } }
}

async function verifySignature(parts: string[], kid: string, issuer: string): Promise<boolean> {
  let jwks = await fetchJwks(issuer)
  let jwk = jwks.keys.find((k) => (k as { kid?: string }).kid === kid)

  // An unknown kid may simply mean the service rotated since we last looked, so
  // refetch once - never following a url the token supplied.
  //
  // Under a cooldown, though. The kid comes from the token, and a caller who
  // holds a transaction of their own chooses it freely: without this, every
  // made-up kid becomes an outbound request, and a canvas turns into an
  // amplifier pointed at its own identity service. One refresh per cooldown is
  // all rotation needs, because a rotating service publishes the new key well
  // before it signs with it.
  if (!jwk && Date.now() - lastForcedFetch >= FORCED_FETCH_COOLDOWN_MS) {
    lastForcedFetch = Date.now()
    jwks = await fetchJwks(issuer, true)
    jwk = jwks.keys.find((k) => (k as { kid?: string }).kid === kid)
  }
  if (!jwk) return false

  const k = jwk as { kty?: string; crv?: string; alg?: string; use?: string; key_ops?: unknown }
  if (k.kty !== 'EC' || k.crv !== 'P-256') return false
  if (k.alg && k.alg !== 'ES256') return false

  // A P-256 key on a JWKS is not automatically a key for THIS. The same curve
  // serves ECDH key agreement, and a service that publishes one of those beside
  // its signing keys would have us verify assertions with a key nobody thinks of
  // as an authority - whoever holds its private half could mint identities. So
  // the purpose is read where it is stated: `use` must be `sig` and `key_ops`
  // must include `verify`. Absent, both stay unconstrained, which is what RFC
  // 7517 means by optional - the check is on the claim, not on its presence.
  if (k.use && k.use !== 'sig') return false
  if (Array.isArray(k.key_ops) && !k.key_ops.includes('verify')) return false

  const { createPublicKey } = await import('node:crypto')
  const key = createPublicKey({ key: jwk as import('node:crypto').JsonWebKey, format: 'jwk' })

  // JWS ES256 signatures are raw r||s; Node's verifier wants DER unless told.
  const signature = Buffer.from(parts[2]!, 'base64url')
  if (signature.length !== 64) return false

  const v = createVerify('SHA256')
  v.update(`${parts[0]}.${parts[1]}`)
  v.end()
  return v.verify({ key, dsaEncoding: 'ieee-p1363' }, signature)
}

/**
 * Verify a short-lived bearer JWT the identity service minted for a NON-gate
 * purpose (the front door's summary token, 04-solution §9.1). Same trust root
 * and JWKS as the assertion path, but a distinct `typ` - so neither token can
 * ever be replayed at the other door - and no nonce: the token is not a
 * sign-in, it is a capability that expires in seconds.
 */
export async function verifyBearerJwt(opts: {
  token: string
  /** This canvas's own origin - what `aud` must equal, exactly. */
  origin: string
  issuer: string
  /** The pinned typ, e.g. `marver-summary+jwt`. */
  typ: string
  /** The party the token was minted to (`azp`), when the profile demands one. */
  azp?: string
  /** Maximum accepted lifetime in seconds - a profile that says "expiry ≤ 120s"
   *  must refuse a token minted for a week, however valid its signature. */
  maxAgeS?: number
}): Promise<{ ok: true; sub: string; email: string; claims: Record<string, unknown> } | { ok: false; reason: string }> {
  const { token, origin, issuer, typ } = opts
  if (!token || token.length > MAX_TOKEN_BYTES) return { ok: false, reason: 'token size' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'not a jws' }
  let header: Record<string, unknown>
  let claims: Record<string, unknown>
  try {
    const h = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as unknown
    const c = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown
    if (!isPlainObject(h) || !isPlainObject(c)) return { ok: false, reason: 'malformed json' }
    header = h
    claims = c
  } catch { return { ok: false, reason: 'malformed json' } }
  if (header.alg !== 'ES256') return { ok: false, reason: 'alg' }
  if (header.typ !== typ) return { ok: false, reason: 'typ' }
  if ('jku' in header || 'x5u' in header || 'jwk' in header) return { ok: false, reason: 'header injection' }
  const kid = typeof header.kid === 'string' ? header.kid : null
  if (!kid || kid.length > 128) return { ok: false, reason: 'kid' }
  if (claims.iss !== issuer) return { ok: false, reason: 'iss' }
  if (claims.aud !== origin) return { ok: false, reason: 'aud' }
  if (opts.azp && claims.azp !== opts.azp) return { ok: false, reason: 'azp' }
  const sub = typeof claims.sub === 'string' ? claims.sub : ''
  const email = typeof claims.email === 'string' ? claims.email : ''
  if (!sub || !email) return { ok: false, reason: 'missing claims' }
  const now = Math.floor(Date.now() / 1000)
  const exp = typeof claims.exp === 'number' ? claims.exp : 0
  const iat = typeof claims.iat === 'number' ? claims.iat : 0
  if (!exp || exp + CLOCK_TOLERANCE_S < now) return { ok: false, reason: 'expired' }
  if (!iat || iat - CLOCK_TOLERANCE_S > now) return { ok: false, reason: 'issued in the future' }
  if (opts.maxAgeS && exp - iat > opts.maxAgeS) return { ok: false, reason: 'lifetime' }
  let verified = false
  try { verified = await verifySignature(parts, kid, issuer) } catch { return { ok: false, reason: 'key fetch failed' } }
  if (!verified) return { ok: false, reason: 'signature' }
  return { ok: true, sub, email, claims }
}

/**
 * The optional display claims, taken only if they are the right shape.
 *
 * Deliberately forgiving: a malformed name or picture drops that ONE field and
 * lets the sign-in through, because neither decides anything. Refusing a valid
 * assertion over a bad avatar URL would trade a cosmetic problem for a lockout.
 *
 * The bounds are what stop this being a hole. A name is capped so it cannot be
 * used to write a paragraph into somebody's comment sidebar, and control
 * characters go because that is how a value gets smuggled into a log line. A
 * picture must be https and bounded - the canvas will make a server-side request
 * to whatever survives this, so http, data:, file: and friends never get that
 * far.
 */
function displayClaims(claims: Record<string, unknown>): { name?: string; picture?: string } {
  const out: { name?: string; picture?: string } = {}

  const raw = typeof claims.name === 'string' ? claims.name : ''
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (name) out.name = name

  if (typeof claims.picture === 'string' && claims.picture.length <= 2048) {
    try {
      const u = new URL(claims.picture)
      if (u.protocol === 'https:' && !u.username && !u.password) out.picture = u.toString()
    } catch { /* not a URL - no picture, and no failure */ }
  }
  return out
}

/** A JSON object, and not an array or null - both of which pass `typeof === 'object'`. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Length-safe string compare, so a mismatch leaks nothing through timing. */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/**
 * A stable, opaque handle for "this browser", used to bind a transaction to the
 * client that started it. Derived from a random cookie value the canvas already
 * sets - never from IP or user agent, both of which change legitimately
 * mid-flow (mobile networks, upgrades) and would lock people out.
 */
export function browserBinding(cookieValue: string): string {
  return createHash('sha256').update(cookieValue).digest('base64url')
}
