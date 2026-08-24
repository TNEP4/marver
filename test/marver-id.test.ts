import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, createSign } from 'node:crypto'
import {
  TransactionStore, browserBinding, verifyAssertion, _resetJwksCache,
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
    const future = Math.floor(Date.now() / 1000) + 3600
    const res = await verify(sign(goodClaims(tx.nonce, { iat: future, nbf: future, exp: future + 300 })))
    expect(res.ok).toBe(false)
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
    for (let i = 0; i < 10_050; i++) store.mint(ORIGIN, BROWSER)
    expect(store.size).toBeLessThanOrEqual(10_000)
  })

  it('issues a distinct nonce every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => store.mint(ORIGIN, BROWSER).nonce))
    expect(seen.size).toBe(50)
  })
})
