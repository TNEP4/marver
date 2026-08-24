import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimInvite, createInvite, loadStore, provisionFromMarverId, sessionUser, signIn } from '../src/server/auth.ts'

/**
 * Provisioning: turning a proved identity into local access.
 *
 * This is where L1a's central decision lives. The identity service proves WHO
 * somebody is; the canvas alone decides whether they may IN. If anything here is
 * wrong, a stranger walks into somebody's private canvas - so most of these
 * tests are about who gets refused, and several exist because a review found the
 * refusal missing.
 */

const ISSUER = 'https://id.example.test'
let dir: string

const identity = (email: string, subject: string, issuer = ISSUER) => ({ email, subject, issuer })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mv-prov-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Put an address on the canvas's list the way an owner actually would. */
const invite = (email: string) => createInvite(dir, email)

describe('the allowlist is the boundary', () => {
  it('admits somebody the owner invited, and mints a session', () => {
    invite('a@x.test')
    const res = provisionFromMarverId(dir, identity('a@x.test', 'sub_1'))
    expect(res).not.toBeNull()
    expect(sessionUser(dir, res!.session)?.email).toBe('a@x.test')
  })

  it('REFUSES a stranger - proving who you are is not an invitation', () => {
    const res = provisionFromMarverId(dir, identity('stranger@x.test', 'sub_9'))
    expect(res).toBeNull()
    expect(loadStore(dir).users).toHaveLength(0)
  })

  it('admits the bootstrap owner only while the canvas has no accounts', () => {
    const first = provisionFromMarverId(dir, identity('owner@x.test', 's1'), { ownerEmail: 'owner@x.test' })
    expect(first?.user.role).toBe('owner')
    // Now that an owner exists, the bootstrap door is shut.
    expect(provisionFromMarverId(dir, identity('other@x.test', 's2'), { ownerEmail: 'owner@x.test' })).toBeNull()
  })

  it('normalizes the address, so casing cannot slip past the list', () => {
    invite('person@x.test')
    const res = provisionFromMarverId(dir, identity('  Person@X.Test ', 's1'))
    expect(res?.user.email).toBe('person@x.test')
  })

  it('SPENDS the invite that authorised entry', () => {
    // Found in review: leaving it pending left a password-based second door into
    // an account that now exists.
    invite('a@x.test')
    expect(provisionFromMarverId(dir, identity('a@x.test', 's1'))).not.toBeNull()
    expect(loadStore(dir).invites).toHaveLength(0)
  })
})

describe('account safety', () => {
  it('stores NO password material for an identity account', () => {
    invite('a@x.test')
    provisionFromMarverId(dir, identity('a@x.test', 's1'))
    const user = loadStore(dir).users[0]!
    expect(user.auth).toBe('marver-id')
    expect(user.salt).toBeUndefined()
    expect(user.hash).toBeUndefined()
  })

  it('cannot be signed into with a password - there is no second door', () => {
    invite('a@x.test')
    provisionFromMarverId(dir, identity('a@x.test', 's1'))
    for (const guess of ['', 'password', 'a@x.test', 'undefined']) {
      expect(signIn(dir, 'a@x.test', guess)).toBeNull()
    }
  })

  it('re-signing in reuses the account rather than duplicating it', () => {
    invite('a@x.test')
    provisionFromMarverId(dir, identity('a@x.test', 's1'))
    provisionFromMarverId(dir, identity('a@x.test', 's1'))
    expect(loadStore(dir).users).toHaveLength(1)
  })

  it('REFUSES a different subject claiming an address we already bound', () => {
    invite('a@x.test')
    provisionFromMarverId(dir, identity('a@x.test', 's1'))
    expect(provisionFromMarverId(dir, identity('a@x.test', 'IMPOSTER'))).toBeNull()
  })

  it('REFUSES the same subject from a DIFFERENT issuer', () => {
    // Subjects are only unique within an issuer. Repointing a canvas at another
    // identity service must not silently bind a colliding subject from it.
    invite('a@x.test')
    provisionFromMarverId(dir, identity('a@x.test', 's1', ISSUER))
    expect(provisionFromMarverId(dir, identity('a@x.test', 's1', 'https://evil.test'))).toBeNull()
  })

  it('links an existing password account without converting it', () => {
    const { token } = createInvite(dir, 'human@x.test')
    claimInvite(dir, token, { password: 'a-real-password', name: 'Human' })
    expect(provisionFromMarverId(dir, identity('human@x.test', 's1'))).not.toBeNull()

    const user = loadStore(dir).users[0]!
    expect(user.hash).toBeDefined()
    expect(signIn(dir, 'human@x.test', 'a-real-password')).not.toBeNull()
    expect(loadStore(dir).users).toHaveLength(1)
  })
})

describe('the duplicate-account takeover, closed', () => {
  it('the invite is already SPENT, so it cannot be claimed afterwards', () => {
    // The attack a review found: after ID provisioning, an old invite could still
    // be claimed, creating a SECOND user with the same email. Sessions resolve by
    // email to the first match - so the claimant inherited the owner's account.
    //
    // Two independent defences now close it. This is the first: provisioning
    // consumes the invite, so there is no token left to redeem.
    const { token } = createInvite(dir, 'owner@x.test')
    provisionFromMarverId(dir, identity('owner@x.test', 's1'), { ownerEmail: 'owner@x.test' })

    expect(() => claimInvite(dir, token, { password: 'attacker-chosen', name: 'Not The Owner' }))
      .toThrow(/invalid, expired, or already used/i)

    const store = loadStore(dir)
    expect(store.users).toHaveLength(1)
    expect(store.users[0]!.auth).toBe('marver-id')
    expect(store.invites).toHaveLength(0)
  })

  it('no new invite can even be minted for an address that now has an account', () => {
    // The second defence, and it turns out to predate this work: createInvite
    // itself refuses. So there is no way to get a fresh token for an address
    // that Marver ID has already provisioned.
    provisionFromMarverId(dir, identity('a@x.test', 's1'), { ownerEmail: 'a@x.test' })
    expect(() => createInvite(dir, 'a@x.test')).toThrow(/already has an account/i)
    expect(loadStore(dir).users).toHaveLength(1)
  })

  it('one email can never end up with two accounts', () => {
    const { token } = createInvite(dir, 'a@x.test')
    provisionFromMarverId(dir, identity('a@x.test', 's1'))
    try { claimInvite(dir, token, { password: 'whatever12', name: 'X' }) } catch { /* expected */ }
    const emails = loadStore(dir).users.map((u) => u.email)
    expect(new Set(emails).size).toBe(emails.length)
  })
})
