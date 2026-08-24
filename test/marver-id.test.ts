import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, createSign } from 'node:crypto'
import {
  TransactionStore, browserBinding, normalizeIssuer, verifyAssertion, _resetJwksCache,
} from '../src/server/marver-id.ts'

/**
 * The canvas half of Marver ID, tested as an attacker would probe it.
 *
 * Each `it` below is a way a token could be wrong. A verifier that accepts any
 * one of them lets a stranger into somebody's private canvas, so the tests are
 * written as refusals rather than as coverage of the happy path - there is only
 * one of those and it is the first test.
 */

const ISSUER = 'https://id.example.test'
const ORIGIN = 'https://canvas.example.test'
const BROWSER = browserBinding('a-random-cookie-value')

// One keypair for the whole file: the "identity service" we are pretending to be.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'ES256', use: 'sig' }

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

/** Sign a token the way the real service does - ES256 over header.payload. */
function sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const h = b64({ alg: 'ES256', kid: 'test-kid', typ: 'marver-assertion+jwt', ...header })
  const p = b64(claims)
  const s = createSign('SHA256')
  s.update(`${h}.${p}`)
  s.end()
  const sig = s.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return `${h}.${p}.${sig}`
}

/** A claim set that is valid in every respect, for tests to spoil one field of. */
function goodClaims(nonce: string, over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: ISSUER, aud: ORIGIN, sub: 'user_123', email: 'someone@example.test',
    email_verified: true, nonce, jti: crypto.randomUUID(),
    iat: now, nbf: now, exp: now + 300, ...over,
  }
}

let store: TransactionStore

beforeEach(() => {
  _resetJwksCache()
  store = new TransactionStore()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })))
})
afterEach(() => vi.unstubAllGlobals())

const verify = (token: string, over: Partial<Parameters<typeof verifyAssertion>[0]> = {}) =>
  verifyAssertion({ token, origin: ORIGIN, issuer: ISSUER, store, browser: BROWSER, ...over })

describe('verifyAssertion - the happy path', () => {
  it('accepts a well-formed assertion and returns the identity', async () => {
    const tx = store.mint(ORIGIN, BROWSER)
    const res = await verify(sign(goodClaims(tx.nonce)))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.identity.email).toBe('someone@example.test')
      expect(res.identity.subject).toBe('user_123')
    }
  })
})

describe('verifyAssertion - refusals that keep strangers out', () => {
  it('refuses an assertion minted for ANOTHER origin', async () => {
    // The whole point of aud: a token captured on an attacker's canvas is inert.
    const tx = store.mint(ORIGIN, BROWSER)
    const res = await verify(sign(goodClaims(tx.nonce, { aud: 'https://evil.example.test' })))
    expect(res).toEqual({ ok: false, reason: 'aud' })
  })

  it('refuses an assertion from another issuer', async () => {
    const tx = store.mint(ORIGIN, BROWSER)
    const res = await verify(sign(goodClaims(tx.nonce, { iss: 'https://evil.example.test' })))
    expect(res).toEqual({ ok: false, reason: 'iss' })
  })

  it('refuses a nonce we never issued', async () => {
    const res = await verify(sign(goodClaims('a-nonce-from-nowhere')))
    expect(res).toEqual({ ok: false, reason: 'unknown or spent nonce' })
  })

  it('refuses to reuse a nonce - single use even inside its lifetime', async () => {
    const tx = store.mint(ORIGIN, BROWSER)
    const token = sign(goodClaims(tx.nonce))
    expect((await verify(token)).ok).toBe(true)
    expect(await verify(token)).toEqual({ ok: false, reason: 'unknown or spent nonce' })
  })

  it('spends the nonce when a SIGNATURE fails - no retries at forgery', async () => {
    // This is the ordering that matters. Static claims (aud, iss, exp) are
    // checked first and cost nothing, so rejecting on those leaves the
    // transaction alone. But once a token has claimed a nonce and only the
    // signature is left, that nonce is spent whatever the outcome - otherwise
    // an attacker could grind signatures against a single live transaction.
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const tx = store.mint(ORIGIN, BROWSER)
    const h = b64({ alg: 'ES256', kid: 'test-kid', typ: 'marver-assertion+jwt' })
    const p = b64(goodClaims(tx.nonce))
    const s = createSign('SHA256'); s.update(`${h}.${p}`); s.end()
    const forged = `${h}.${p}.${s.sign({ key: other.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`

    expect(await verify(forged)).toEqual({ ok: false, reason: 'signature' })
    // The real token for that same transaction is now worthless too.
    expect(await verify(sign(goodClaims(tx.nonce)))).toEqual({ ok: false, reason: 'unknown or spent nonce' })
  })

  it('leaves the transaction alone for cheap static rejections', async () => {
    // A token aimed at another audience never touched our transaction, so a
    // legitimate sign-in in the same window still works.
    const tx = store.mint(ORIGIN, BROWSER)
    await verify(sign(goodClaims(tx.nonce, { aud: 'https://evil.example.test' })))
    expect((await verify(sign(goodClaims(tx.nonce)))).ok).toBe(true)
  })

  it('refuses a transaction started by a DIFFERENT browser', async () => {
    const tx = store.mint(ORIGIN, BROWSER)
    const res = await verify(sign(goodClaims(tx.nonce)), { browser: browserBinding('someone-elses-cookie') })
    expect(res).toEqual({ ok: false, reason: 'unknown or spent nonce' })
  })

  it('refuses an expired assertion', async () => {
    const tx = store.mint(ORIGIN, BROWSER)
    const past = Math.floor(Date.now() / 1000) - 3600
    const res = await verify(sign(goodClaims(tx.nonce, { iat: past, nbf: past, exp: past + 300 })))
    expect(res).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses an assertion issued in the future', async () => {
    const tx = store.mint(ORIGIN, BROWSER)
    const now = Math.floor(Date.now() / 1000)
    const future = now + 3600
    // `nbf` stays current on purpose. Moving both meant the nbf check alone
    // produced the refusal, so deleting the iat check entirely left this green -
    // the test named one rule and exercised another.
    const res = await verify(sign(goodClaims(tx.nonce, { iat: future, nbf: now, exp: future + 300 })))
    expect(res).toEqual({ ok: false, reason: 'issued in the future' })
  })

  it('refuses an unverified email', async () => {
    const tx = store.mint(ORIGIN, BROWSER)
    const res = await verify(sign(goodClaims(tx.nonce, { email_verified: false })))
    expect(res).toEqual({ ok: false, reason: 'email unverified' })
  })
})

describe('verifyAssertion - refusals that defeat token forgery', () => {
  it('refuses alg:none', async () => {
    const tx = store.mint(ORIGIN, BROWSER)
    const h = b64({ alg: 'none', kid: 'test-kid', typ: 'marver-assertion+jwt' })
    const p = b64(goodClaims(tx.nonce))
    expect(await verify(`${h}.${p}.`)).toEqual({ ok: false, reason: 'alg' })
  })

  it('refuses a token signed by a DIFFERENT key', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const tx = store.mint(ORIGIN, BROWSER)
    const h = b64({ alg: 'ES256', kid: 'test-kid', typ: 'marver-assertion+jwt' })
    const p = b64(goodClaims(tx.nonce))
    const s = createSign('SHA256'); s.update(`${h}.${p}`); s.end()
    const sig = s.sign({ key: other.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    expect(await verify(`${h}.${p}.${sig}`)).toEqual({ ok: false, reason: 'signature' })
  })

  it('refuses a header that tries to name its own key source', async () => {
    // jku/x5u/jwk would let a token tell us where to fetch the key it was
    // signed with, which is a complete bypass.
    const tx = store.mint(ORIGIN, BROWSER)
    for (const bad of ['jku', 'x5u', 'jwk']) {
      const res = await verify(sign(goodClaims(tx.nonce), { [bad]: 'https://evil.example.test/keys' }))
      expect(res).toEqual({ ok: false, reason: 'header injection' })
    }
  })

  it('refuses the wrong token type even when correctly signed', async () => {
    const tx = store.mint(ORIGIN, BROWSER)
    const res = await verify(sign(goodClaims(tx.nonce), { typ: 'JWT' }))
    expect(res).toEqual({ ok: false, reason: 'typ' })
  })

  it('refuses structurally broken input without throwing', async () => {
    for (const junk of ['', 'x', 'a.b', 'a.b.c.d', 'not.base64.here']) {
      const res = await verify(junk)
      expect(res.ok).toBe(false)
    }
  })

  it('refuses an oversized token before parsing it', async () => {
    const res = await verify('a'.repeat(9000))
    expect(res).toEqual({ ok: false, reason: 'token size' })
  })
})

describe('TransactionStore', () => {
  it('expires transactions rather than keeping them forever', async () => {
    vi.useFakeTimers()
    try {
      const tx = store.mint(ORIGIN, BROWSER)
      vi.advanceTimersByTime(6 * 60 * 1000)
      expect(store.consume(tx.nonce, BROWSER)).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('does NOT let a stranger burn somebody else\'s live transaction', () => {
    // Found by adversarial review: consume() used to delete before checking the
    // browser, so anyone who learned a nonce could destroy a sign-in in flight.
    const tx = store.mint(ORIGIN, BROWSER)
    expect(store.consume(tx.nonce, browserBinding('a-stranger'))).toBeNull()
    // The rightful owner's transaction is untouched.
    expect(store.consume(tx.nonce, BROWSER)).not.toBeNull()
  })

  it('is bounded, so an open endpoint cannot exhaust memory', () => {
    // A distinct binding each time, which is what an attacker would present.
    // Reusing one browser would now hold a single slot and the cap would never
    // be approached - the test would pass without testing anything.
    for (let i = 0; i < 10_050; i++) store.mint(ORIGIN, browserBinding(`b-${i}`))
    expect(store.size).toBeLessThanOrEqual(10_000)
  })

  it('gives ONE browser one slot, so a single caller cannot flood it out', () => {
    // /start answers before anyone has signed in, so it is free to call. Without
    // a per-browser limit one caller mints thousands and evicts the real sign-ins
    // that were queued behind them.
    for (let i = 0; i < 500; i++) store.mint(ORIGIN, BROWSER)
    expect(store.size).toBe(1)
  })

  it('and starting again abandons the previous attempt rather than keeping both', () => {
    const first = store.mint(ORIGIN, BROWSER)
    const second = store.mint(ORIGIN, BROWSER)
    expect(store.consume(first.nonce, BROWSER)).toBeNull()
    expect(store.consume(second.nonce, BROWSER)).not.toBeNull()
  })

  it('one browser flooding does NOT evict a different browser\'s live sign-in', () => {
    const victim = browserBinding('someone-mid-signin')
    const tx = store.mint(ORIGIN, victim)
    for (let i = 0; i < 5_000; i++) store.mint(ORIGIN, BROWSER)
    expect(store.consume(tx.nonce, victim)).not.toBeNull()
  })

  it('issues a distinct nonce every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => store.mint(ORIGIN, BROWSER).nonce))
    expect(seen.size).toBe(50)
  })
})

describe('normalizeIssuer - the trust root is not a free-text field', () => {
  /**
   * Whatever this resolves to publishes the keys that decide who may open the
   * canvas. A value that is merely "a string the operator typed" is not a trust
   * root, so anything ambiguous is refused at boot rather than trusted at runtime.
   */

  it('accepts a bare https origin, and strips a trailing slash', () => {
    expect(normalizeIssuer('https://id.marver.design')).toBe('https://id.marver.design')
    expect(normalizeIssuer('https://id.marver.design/')).toBe('https://id.marver.design')
    expect(normalizeIssuer('  https://id.marver.design  ')).toBe('https://id.marver.design')
    expect(normalizeIssuer('https://id.example.test:8443')).toBe('https://id.example.test:8443')
  })

  it('REFUSES http, which hands the trust root to the network', () => {
    // Anyone on the path between the canvas and this address could serve their
    // own keys, and every assertion signed with them would verify.
    expect(normalizeIssuer('http://id.marver.design')).toBeNull()
    expect(normalizeIssuer('http://id.example.test:8443')).toBeNull()
  })

  it('allows http ONLY on loopback, where there is no network to sit on', () => {
    expect(normalizeIssuer('http://localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeIssuer('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    // A hostname that merely begins with the word is not loopback.
    expect(normalizeIssuer('http://localhost.evil.test')).toBeNull()
    expect(normalizeIssuer('http://127.0.0.1.evil.test')).toBeNull()
  })

  it('REFUSES anything where the address read is not the address fetched', () => {
    // Credentials, a path, a query or a fragment all mean the operator is
    // looking at one thing and the JWKS fetch will do another.
    expect(normalizeIssuer('https://user:pw@id.marver.design')).toBeNull()
    expect(normalizeIssuer('https://id.marver.design/tenant-a')).toBeNull()
    expect(normalizeIssuer('https://id.marver.design/?x=1')).toBeNull()
    expect(normalizeIssuer('https://id.marver.design/#frag')).toBeNull()
    expect(normalizeIssuer('https://evil.test\\@id.marver.design')).toBeNull()
  })

  it('REFUSES what is not a url at all', () => {
    for (const bad of ['', '   ', 'id.marver.design', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url']) {
      expect(normalizeIssuer(bad), bad).toBeNull()
    }
    expect(normalizeIssuer(undefined)).toBeNull()
    expect(normalizeIssuer(null)).toBeNull()
  })
})

describe('the key fetch cannot be turned into an amplifier', () => {
  /**
   * `kid` is chosen by whoever presents the token. An unknown one forces a
   * refetch, because it may mean the service rotated - so without a floor on how
   * often that may happen, each made-up kid becomes one outbound request and a
   * canvas becomes a lever pointed at its own identity service.
   */

  it('refetches ONCE for an unknown kid, then stops until the cooldown passes', async () => {
    // Prime the cache so the baseline is one fetch, not zero.
    await verify(sign(goodClaims(store.mint(ORIGIN, BROWSER).nonce)))
    const calls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    const primed = calls()

    // First unknown kid: one forced refetch is allowed and expected.
    await verify(sign(goodClaims(store.mint(ORIGIN, BROWSER).nonce), { kid: 'rotated-away' }))
    const afterFirst = calls()
    expect(afterFirst).toBe(primed + 1)

    // Twenty more, each with a different invented kid. None may reach the network.
    for (let i = 0; i < 20; i++) {
      await verify(sign(goodClaims(store.mint(ORIGIN, BROWSER).nonce), { kid: `made-up-${i}` }))
    }
    expect(calls()).toBe(afterFirst)
  })

  it('but a genuine rotation is still picked up once the cooldown has passed', async () => {
    vi.useFakeTimers()
    try {
      await verify(sign(goodClaims(store.mint(ORIGIN, BROWSER).nonce)))
      await verify(sign(goodClaims(store.mint(ORIGIN, BROWSER).nonce), { kid: 'unknown-1' }))
      const calls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
      const before = calls()

      vi.advanceTimersByTime(31_000)
      await verify(sign(goodClaims(store.mint(ORIGIN, BROWSER).nonce), { kid: 'unknown-2' }))
      // A cooldown that never lifts would be a canvas that can never follow a
      // key rotation - locking everybody out until the process restarts.
      expect(calls()).toBe(before + 1)
    } finally { vi.useRealTimers() }
  })
})
