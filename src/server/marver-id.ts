/**
 * Marver ID - the canvas half of the protocol.
 *
 * A canvas never trusts a token because it looks well-formed. The sequence is:
 *
 *   1. mintTransaction()  - the canvas invents a nonce and remembers it, bound
 *                           to this browser and this exact origin, for 5 minutes.
 *   2. the browser opens a popup at id.marver.design/authorize, which returns a
 *      signed assertion by postMessage.
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

/** How long a transaction may sit unused. Matches the assertion's own life. */
const TRANSACTION_TTL_MS = 5 * 60 * 1000
/** Servers drift; allow a little, but not enough to matter. */
const CLOCK_TOLERANCE_S = 30
/** Public keys are cached; rotation publishes a key well before it signs. */
const JWKS_TTL_MS = 10 * 60 * 1000
/** A ceiling on token size - nothing legitimate is close to this. */
const MAX_TOKEN_BYTES = 8192

export type Transaction = { nonce: string; origin: string; browser: string; exp: number }

export type VerifiedIdentity = {
  /** Stable id from the identity service. Grants bind to this, not to email. */
  subject: string
  email: string
}

export type VerifyResult =
  | { ok: true; identity: VerifiedIdentity }
  | { ok: false; reason: string }

/**
 * The transaction store.
 *
 * In memory on purpose: a transaction lives five minutes, and a canvas that
 * restarts mid-sign-in should simply ask the person to try again rather than
 * persist half-finished authentications to disk.
 */
/** A ceiling on live transactions - /start is unauthenticated by necessity. */
const MAX_TRANSACTIONS = 10_000

export class TransactionStore {
  private readonly items = new Map<string, Transaction>()

  /** Invent a nonce for a sign-in attempt from this browser to this origin. */
  mint(origin: string, browser: string): Transaction {
    this.sweep()
    // /__mv/id/start has to be reachable before sign-in, so it is a free
    // endpoint. Bounded rather than unbounded: past the cap, drop the oldest
    // rather than growing forever. A displaced person simply clicks again.
    if (this.items.size >= MAX_TRANSACTIONS) {
      const oldest = this.items.keys().next().value
      if (oldest) this.items.delete(oldest)
    }
    const tx: Transaction = {
      nonce: randomBytes(32).toString('base64url'),
      origin,
      browser,
      exp: Date.now() + TRANSACTION_TTL_MS,
    }
    this.items.set(tx.nonce, tx)
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
    if (tx.exp < Date.now()) return null
    return tx
  }

  private sweep() {
    const now = Date.now()
    for (const [k, v] of this.items) if (v.exp < now) this.items.delete(k)
  }

  get size(): number { return this.items.size }
}

/** Cached public keys from the identity service. */
type Jwks = { keys: Array<Record<string, unknown>> }
let jwksCache: { at: number; url: string; jwks: Jwks } | null = null

async function fetchJwks(issuer: string, force = false): Promise<Jwks> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`
  if (!force && jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < JWKS_TTL_MS) {
    return jwksCache.jwks
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`jwks fetch failed (${res.status})`)
  const jwks = (await res.json()) as Jwks
  if (!Array.isArray(jwks.keys)) throw new Error('jwks malformed')
  jwksCache = { at: Date.now(), url, jwks }
  return jwks
}

/** Only for tests - drop the cached keys. */
export function _resetJwksCache() { jwksCache = null }

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
}): Promise<VerifyResult> {
  const { token, origin, issuer, store, browser } = opts

  if (!token || token.length > MAX_TOKEN_BYTES) return { ok: false, reason: 'token size' }

  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'not a jws' }

  let header: Record<string, unknown>
  let claims: Record<string, unknown>
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
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

  // Signature last: everything above is free, this costs a key fetch.
  let verified = false
  try {
    verified = await verifySignature(parts, kid, issuer)
  } catch {
    return { ok: false, reason: 'key fetch failed' }
  }
  if (!verified) return { ok: false, reason: 'signature' }

  return { ok: true, identity: { subject: sub, email } }
}

async function verifySignature(parts: string[], kid: string, issuer: string): Promise<boolean> {
  let jwks = await fetchJwks(issuer)
  let jwk = jwks.keys.find((k) => (k as { kid?: string }).kid === kid)

  // An unknown kid may simply mean the service rotated since we last looked.
  // Refetch ONCE - never follow a url the token supplied.
  if (!jwk) {
    jwks = await fetchJwks(issuer, true)
    jwk = jwks.keys.find((k) => (k as { kid?: string }).kid === kid)
  }
  if (!jwk) return false

  const k = jwk as { kty?: string; crv?: string; alg?: string }
  if (k.kty !== 'EC' || k.crv !== 'P-256') return false
  if (k.alg && k.alg !== 'ES256') return false

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
