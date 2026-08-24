import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimInvite, createInvite, provisionFromMarverId, signIn, sessionUser, loadStore } from '../src/server/auth.ts'

/**
 * Provisioning: turning a proved identity into local access.
 *
 * This is where L1a's central decision lives. The identity service proves WHO
 * somebody is; the canvas alone decides whether they may IN. If the allowlist
 * check here is wrong, anyone with a Marver account walks into every canvas -
 * so these tests are mostly about who gets refused.
 */

let dir: string
const allowAll = () => true
const allowNone = () => false
const allowOnly = (...emails: string[]) => (e: string) => emails.includes(e)

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mv-prov-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('provisionFromMarverId - the allowlist is the boundary', () => {
  it('creates an account and a session for an allowed email', () => {
    const res = provisionFromMarverId(dir, { email: 'a@x.test', subject: 'sub_1' }, allowAll)
    expect(res).not.toBeNull()
    expect(sessionUser(dir, res!.session)?.email).toBe('a@x.test')
  })

  it('REFUSES an email that is not on the allowlist - proof of identity is not an invitation', () => {
    const res = provisionFromMarverId(dir, { email: 'stranger@x.test', subject: 'sub_9' }, allowNone)
    expect(res).toBeNull()
    // and leaves no trace behind
    expect(loadStore(dir).users).toHaveLength(0)
  })

  it('only admits the addresses actually listed', () => {
    const allowed = allowOnly('invited@x.test')
    expect(provisionFromMarverId(dir, { email: 'invited@x.test', subject: 's1' }, allowed)).not.toBeNull()
    expect(provisionFromMarverId(dir, { email: 'uninvited@x.test', subject: 's2' }, allowed)).toBeNull()
  })

  it('normalizes the address, so casing and spacing cannot slip past the list', () => {
    const res = provisionFromMarverId(dir, { email: '  Person@X.Test ', subject: 's1' }, allowOnly('person@x.test'))
    expect(res?.user.email).toBe('person@x.test')
  })

  it('gives the first account ownership, and later ones membership', () => {
    const first = provisionFromMarverId(dir, { email: 'first@x.test', subject: 's1' }, allowAll)
    const second = provisionFromMarverId(dir, { email: 'second@x.test', subject: 's2' }, allowAll)
    expect(first?.user.role).toBe('owner')
    expect(second?.user.role).toBe('member')
  })
})

describe('provisionFromMarverId - account safety', () => {
  it('stores NO password material for an identity-provisioned account', () => {
    provisionFromMarverId(dir, { email: 'a@x.test', subject: 'sub_1' }, allowAll)
    const user = loadStore(dir).users[0]!
    expect(user.auth).toBe('marver-id')
    expect(user.salt).toBeUndefined()
    expect(user.hash).toBeUndefined()
  })

  it('cannot be signed into with a password - there is no second door', () => {
    provisionFromMarverId(dir, { email: 'a@x.test', subject: 'sub_1' }, allowAll)
    for (const guess of ['', 'password', 'a@x.test', 'undefined']) {
      expect(signIn(dir, 'a@x.test', guess)).toBeNull()
    }
  })

  it('re-signing in reuses the same account rather than duplicating it', () => {
    provisionFromMarverId(dir, { email: 'a@x.test', subject: 'sub_1' }, allowAll)
    provisionFromMarverId(dir, { email: 'a@x.test', subject: 'sub_1' }, allowAll)
    expect(loadStore(dir).users).toHaveLength(1)
  })

  it('REFUSES when a different identity claims an address we have already bound', () => {
    // Two identity-service accounts asserting the same address is either a bug
    // upstream or an attack. Guessing which one is the "real" person is exactly
    // the wrong move, so we refuse and let a human look.
    provisionFromMarverId(dir, { email: 'a@x.test', subject: 'sub_1' }, allowAll)
    expect(provisionFromMarverId(dir, { email: 'a@x.test', subject: 'sub_IMPOSTER' }, allowAll)).toBeNull()
  })

  it('does NOT take over an existing password account, and leaves its password working', () => {
    const { token } = createInvite(dir, 'human@x.test')
    claimInvite(dir, token, { password: 'a-real-password', name: 'Human' })

    // The same person arrives through the identity service.
    const res = provisionFromMarverId(dir, { email: 'human@x.test', subject: 'sub_1' }, allowAll)
    expect(res).not.toBeNull()

    const user = loadStore(dir).users[0]!
    // Their password still works - we linked, we did not convert.
    expect(user.hash).toBeDefined()
    expect(signIn(dir, 'human@x.test', 'a-real-password')).not.toBeNull()
    expect(loadStore(dir).users).toHaveLength(1)
  })
})
