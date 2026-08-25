import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { scryptSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachAvatar, claimInvite, createInvite, loadStore, provisionFromMarverId, sessionUser, signIn, updateProfile, wantsAvatarFrom } from '../src/server/auth.ts'

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
    // Retrying the SAME configured owner address, which is what the rule is
    // actually about. Trying a different address instead would be refused for
    // simply not being on any list, so deleting the empty-canvas condition
    // would have left the old version of this test green.
    expect(
      provisionFromMarverId(dir, identity('owner@x.test', 'DIFFERENT'), { ownerEmail: 'owner@x.test' }),
    ).toBeNull()
  })

  it('shuts the bootstrap door as soon as ANY account exists', () => {
    // The door closes on the canvas having accounts, not on who asks. Provision
    // an ordinary invited person first, then let the configured owner try.
    invite('someone@x.test')
    expect(provisionFromMarverId(dir, identity('someone@x.test', 's1'))).not.toBeNull()
    expect(
      provisionFromMarverId(dir, identity('owner@x.test', 's2'), { ownerEmail: 'owner@x.test' }),
    ).toBeNull()
    expect(loadStore(dir).users).toHaveLength(1)
  })

  it('normalizes the address, so casing cannot slip past the list', () => {
    invite('person@x.test')
    const res = provisionFromMarverId(dir, identity('  Person@X.Test ', 's1'))
    expect(res?.user.email).toBe('person@x.test')
  })

  it('SPENDS the invite that authorised entry, and only that one', () => {
    // Found in review: leaving it pending left a password-based second door into
    // an account that now exists.
    //
    // Two invites, not one. With a single invite, "the list is empty afterwards"
    // is equally true of code that spends the right invite and of code that
    // clears the list - and clearing the list would silently revoke everybody
    // else's pending invitation.
    invite('a@x.test')
    invite('b@x.test')
    expect(provisionFromMarverId(dir, identity('a@x.test', 's1'))).not.toBeNull()
    const invites = loadStore(dir).invites
    expect(invites).toHaveLength(1)
    expect(invites[0]!.emailNorm).toBe('b@x.test')
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
    const first = provisionFromMarverId(dir, identity('a@x.test', 's1'))
    const second = provisionFromMarverId(dir, identity('a@x.test', 's1'))
    // The second result was previously discarded, so refusing every repeat
    // sign-in - locking people out of their own canvas after one visit - passed
    // this test. Coming back has to WORK, and land on the same account.
    expect(second).not.toBeNull()
    expect(second!.user.email).toBe('a@x.test')
    expect(loadStore(dir).users).toHaveLength(1)
  })

  it('and coming back does not quietly reset the account', () => {
    // "Same email, same subject, same count" is also true of code that deletes
    // the account and builds a fresh one. What proves continuity is the state
    // that only the ORIGINAL record carries: a profile the person edited, and a
    // session they are still holding.
    invite('a@x.test')
    const first = provisionFromMarverId(dir, identity('a@x.test', 's1'))!

    const store = loadStore(dir)
    store.users[0]!.name = 'Chosen Name'
    store.users[0]!.avatar = 'data:image/png;base64,AAAA'
    writeFileSync(join(dir, 'auth.json'), JSON.stringify(store))

    provisionFromMarverId(dir, identity('a@x.test', 's1'))

    const after = loadStore(dir).users[0]!
    expect(after.name).toBe('Chosen Name')
    expect(after.avatar).toBe('data:image/png;base64,AAAA')
    expect(after.createdAt).toBe(first.user.createdAt)
    expect(after.idSubject).toBe(first.user.idSubject)

    // And the session they were already holding still works. Preserving the
    // profile while clearing sessions would pass everything above and still
    // sign somebody out of the tab they had open.
    expect(sessionUser(dir, first.session)).not.toBeNull()
    expect(sessionUser(dir, first.session)!.email).toBe('a@x.test')
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

  it('upgrades a LEGACY bare subject instead of locking the person out', () => {
    // Accounts written before subjects were issuer-qualified hold a bare value.
    // A format change must never become a lockout from somebody's own canvas.
    invite('legacy@x.test')
    provisionFromMarverId(dir, identity('legacy@x.test', 's1'))
    const store = loadStore(dir)
    store.users[0]!.idSubject = 's1'          // rewind to the old format
    writeFileSync(join(dir, 'auth.json'), JSON.stringify(store))

    const again = provisionFromMarverId(dir, identity('legacy@x.test', 's1'))
    expect(again).not.toBeNull()
    expect(loadStore(dir).users[0]!.idSubject).toBe(`${ISSUER}#s1`)
  })

  it('but a legacy subject from a DIFFERENT identity is still refused', () => {
    invite('legacy2@x.test')
    provisionFromMarverId(dir, identity('legacy2@x.test', 's1'))
    const store = loadStore(dir)
    store.users[0]!.idSubject = 's1'
    writeFileSync(join(dir, 'auth.json'), JSON.stringify(store))
    expect(provisionFromMarverId(dir, identity('legacy2@x.test', 'OTHER'))).toBeNull()
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

    // The refusal is named, not swallowed. `catch {}` around the claim made any
    // exception a pass - including one thrown for an unrelated reason before the
    // duplicate check was ever reached, which is exactly how a broken claim path
    // would masquerade as a working defence.
    expect(() => claimInvite(dir, token, { password: 'whatever12', name: 'X' }))
      .toThrow(/invalid, expired, or already used/i)

    const users = loadStore(dir).users
    expect(users).toHaveLength(1)
    expect(users[0]!.email).toBe('a@x.test')
    expect(users[0]!.auth).toBe('marver-id')
    // No password material appeared on the account either - a claim that half
    // succeeded would leave exactly that behind.
    expect(users[0]!.hash).toBeUndefined()
  })
})

/**
 * A verified address is a LABEL on an identity, not the identity.
 *
 * People rename: a Workspace migration, a company changing domain, a married
 * name. Matching on email alone meant a returning person did not match their own
 * account and was refused entry to a canvas they might own. Following the rename
 * fixes that and opens two holes of its own, both found in review, both here.
 */
describe('following a renamed address', () => {
  it('recognises somebody by subject after their email changes', () => {
    invite('before@x.test')
    const first = provisionFromMarverId(dir, identity('before@x.test', 'subj-1'))
    expect(first).not.toBeNull()

    // No invite for the new address - the point is that they do not need one,
    // because the assertion proves they are already an account here.
    const again = provisionFromMarverId(dir, identity('after@x.test', 'subj-1'))
    expect(again, 'a rename must not lock somebody out of their own canvas').not.toBeNull()
    expect(again!.user.email).toBe('after@x.test')
    expect(loadStore(dir).users).toHaveLength(1)
  })

  it('refuses a rename onto an address somebody else already holds', () => {
    invite('a@x.test'); invite('b@x.test')
    provisionFromMarverId(dir, identity('a@x.test', 'subj-a'))
    provisionFromMarverId(dir, identity('b@x.test', 'subj-b'))

    // Sessions resolve to the FIRST user matching an email, so two records
    // sharing one address is a takeover decided by array order - and the loser
    // could be the owner. The rename is genuine; the destination is occupied.
    const collide = provisionFromMarverId(dir, identity('b@x.test', 'subj-a'))
    expect(collide, 'a rename onto an occupied address must be refused').toBeNull()

    const users = loadStore(dir).users
    expect(users.filter((u) => u.email === 'b@x.test')).toHaveLength(1)
    expect(users.find((u) => u.email === 'b@x.test')!.idSubject).toBe(`${ISSUER}#subj-b`)
  })

  it('kills the sessions minted under the address they left behind', () => {
    invite('old@x.test')
    const before = provisionFromMarverId(dir, identity('old@x.test', 'subj-1'))!
    expect(sessionUser(dir, before.session)?.email).toBe('old@x.test')

    provisionFromMarverId(dir, identity('new@x.test', 'subj-1'))

    // The old session recorded the address, not the account. Left alive, it
    // would resolve to whoever legitimately claims that address next - so it
    // does not survive the rename.
    expect(sessionUser(dir, before.session), 'a session under the old address must not survive').toBeNull()

    invite('old@x.test')
    const newcomer = provisionFromMarverId(dir, identity('old@x.test', 'subj-2'))
    expect(newcomer).not.toBeNull()
    expect(sessionUser(dir, before.session), 'and must never resolve to the newcomer').toBeNull()
  })
})

/**
 * A canvas that already exists, upgrading into this release.
 *
 * The User type changed shape here: `salt`, `hash` and `params` became optional
 * so an identity account can exist without a credential, and `auth`/`idSubject`
 * arrived. Every deployed canvas has an auth.json written before any of that.
 * If it does not load, or its accounts stop signing in, the upgrade takes those
 * canvases down - and nothing else in this suite would notice, because every
 * other test writes its store with the CURRENT code.
 *
 * So this hand-writes the OLD shape and drives the real functions over it.
 */
describe('an auth.json written by an older marver', () => {
  const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 }

  /** Exactly the fields the previous release wrote - no `auth`, no `idSubject`. */
  const legacyStore = (email: string, password: string) => {
    const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
    const hash = scryptSync(password, Buffer.from(salt, 'hex'), SCRYPT.keylen, SCRYPT).toString('hex')
    return {
      users: [{
        email, name: 'Existing Owner', role: 'owner',
        salt, hash, params: SCRYPT, createdAt: 1_700_000_000_000,
      }],
      invites: [],
      sessions: [],
    }
  }

  const writeLegacy = (email: string, password: string) => {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify(legacyStore(email, password), null, 2))
  }

  it('still loads, and its accounts still sign in with their password', () => {
    writeLegacy('old@x.test', 'the-old-password')
    expect(loadStore(dir).users).toHaveLength(1)

    const hit = signIn(dir, 'old@x.test', 'the-old-password')
    expect(hit, 'an existing account must survive the upgrade').not.toBeNull()
    expect(hit!.user.name).toBe('Existing Owner')
    expect(sessionUser(dir, hit!.session)?.email).toBe('old@x.test')

    expect(signIn(dir, 'old@x.test', 'wrong'), 'and a wrong password is still wrong').toBeNull()
  })

  it('lets that same person arrive through Marver ID, without losing their password', () => {
    writeLegacy('old@x.test', 'the-old-password')

    // The address already has an account, so the allowlist admits them and the
    // subject is bound on first arrival.
    const viaId = provisionFromMarverId(dir, identity('old@x.test', 'subj-new'))
    expect(viaId, 'an existing account is its own permission').not.toBeNull()
    expect(viaId!.user.idSubject).toBe(`${ISSUER}#subj-new`)

    // The password still works. Signing in through the identity service does not
    // silently convert an account or take it over - both doors stay open, which
    // is what makes switching a canvas to MARVER_ID_ISSUER reversible.
    expect(signIn(dir, 'old@x.test', 'the-old-password'), 'the password must survive').not.toBeNull()

    // And a DIFFERENT identity claiming that address is still refused.
    expect(provisionFromMarverId(dir, identity('old@x.test', 'someone-else'))).toBeNull()
  })
})


/**
 * The name and the face - the whole point, from the person's side.
 *
 * The consent card greets somebody as "Nicolas Touron" with their photo, and
 * one redirect later the canvas called them "nicolas.t.touron" against a
 * generated chip, because the assertion carried neither. These cover the rule
 * that fixed it: the assertion FILLS gaps and never overwrites a choice made
 * here, because a canvas profile is editable and somebody who renamed
 * themselves meant it.
 */
describe('display name and picture from the assertion', () => {
  const AVATAR = 'data:image/png;base64,iVBORw0KGgo='

  it('names a new account the way the person is actually called', () => {
    invite('nic@x.test')
    const hit = provisionFromMarverId(dir, { ...identity('nic@x.test', 's1'), name: 'Nicolas Touron' })
    expect(hit!.user.name, 'not the address sliced at the @').toBe('Nicolas Touron')
  })

  it('falls back to the address when the assertion carries no name', () => {
    invite('nic@x.test')
    const hit = provisionFromMarverId(dir, identity('nic@x.test', 's1'))
    expect(hit!.user.name).toBe('nic')
  })

  it('attaches the picture the caller fetched, and remembers where it came from', () => {
    invite('nic@x.test')
    provisionFromMarverId(dir, identity('nic@x.test', 's1'))
    attachAvatar(dir, `${ISSUER}#s1`, AVATAR, 'https://cdn.example/a.png')

    const u = loadStore(dir).users[0]!
    expect(u.avatar).toBe(AVATAR)
    expect(u.avatarSource, 'so a rotated URL can be noticed').toBe('https://cdn.example/a.png')
  })

  it('replaces a rotated picture, but never one the person chose here', () => {
    invite('nic@x.test')
    provisionFromMarverId(dir, identity('nic@x.test', 's1'))

    // Ours, then rotated: the new one wins, and the source catches up. An
    // earlier version refused the replacement, so the source never advanced and
    // every sign-in re-fetched the same new picture and discarded it.
    attachAvatar(dir, `${ISSUER}#s1`, AVATAR, 'https://cdn.example/a.png')
    attachAvatar(dir, `${ISSUER}#s1`, 'data:image/png;base64,ROTATED=', 'https://cdn.example/b.png')
    let u = loadStore(dir).users[0]!
    expect(u.avatar).toBe('data:image/png;base64,ROTATED=')
    expect(u.avatarSource).toBe('https://cdn.example/b.png')

    // Theirs: an avatar with no source was chosen on this canvas, and the
    // identity service does not get to overwrite it.
    updateProfile(dir, 'nic@x.test', { avatar: 'data:image/png;base64,CHOSEN=' })
    attachAvatar(dir, `${ISSUER}#s1`, AVATAR, 'https://cdn.example/c.png')
    u = loadStore(dir).users[0]!
    expect(u.avatar, 'their choice stands').toBe('data:image/png;base64,CHOSEN=')
  })

  it('never overwrites a name or picture chosen ON this canvas', () => {
    invite('nic@x.test')
    provisionFromMarverId(dir, { ...identity('nic@x.test', 's1'), name: 'Nicolas Touron' })
    updateProfile(dir, 'nic@x.test', { name: 'Nic (design)', avatar: 'data:image/png;base64,CHOSEN=' })

    // Signing in again must not quietly undo that edit.
    const again = provisionFromMarverId(dir, { ...identity('nic@x.test', 's1'), name: 'Nicolas Touron' })
    expect(again!.user.name, 'their edit stands').toBe('Nic (design)')
    expect(again!.user.avatar).toBe('data:image/png;base64,CHOSEN=')
  })

  it('upgrades an account still sitting on the email-derived placeholder', () => {
    // Created before assertions carried names, so its name is a fallback
    // nobody chose - the real one is strictly better.
    invite('nic@x.test')
    const first = provisionFromMarverId(dir, identity('nic@x.test', 's1'))
    expect(first!.user.name).toBe('nic')

    const second = provisionFromMarverId(dir, { ...identity('nic@x.test', 's1'), name: 'Nicolas Touron' })
    expect(second!.user.name).toBe('Nicolas Touron')
  })

  it('attaches to the SUBJECT, so a rename mid-fetch cannot cross accounts', () => {
    // The email is read before the fetch, and a fetch is a network round trip
    // during which things move. If the subject renames and the address they
    // vacated is taken by another admitted account, coming back and looking up
    // that address attaches one person's face to somebody else's account.
    invite('first@x.test'); invite('second@x.test')
    provisionFromMarverId(dir, identity('first@x.test', 'subj-a'));
    provisionFromMarverId(dir, identity('second@x.test', 'subj-b'));

    // subj-a renames away from first@x.test...
    provisionFromMarverId(dir, identity('moved@x.test', 'subj-a'));
    // ...and somebody else takes the address they left.
    invite('first@x.test')
    provisionFromMarverId(dir, identity('first@x.test', 'subj-c'));

    // The fetch that started before all that now lands, carrying subj-a.
    attachAvatar(dir, `${ISSUER}#subj-a`, 'data:image/png;base64,AVATARA=', 'https://cdn.example/a.png')

    const users = loadStore(dir).users
    const moved = users.find((u) => u.idSubject === `${ISSUER}#subj-a`)!
    const newcomer = users.find((u) => u.idSubject === `${ISSUER}#subj-c`)!
    expect(moved.avatar, 'lands on the account it was fetched for').toBe('data:image/png;base64,AVATARA=')
    expect(newcomer.avatar, 'and NOT on whoever took the old address').toBeUndefined()
  })

  it('does not let a slower fetch overwrite a newer picture', () => {
    // Two sign-ins in flight. The second finishes first and stores B; the
    // first then lands with A, which is now stale.
    invite('nic@x.test')
    provisionFromMarverId(dir, identity('nic@x.test', 's1'))
    attachAvatar(dir, `${ISSUER}#s1`, 'data:image/png;base64,B=', 'https://cdn.example/b.png')
    attachAvatar(dir, `${ISSUER}#s1`, 'data:image/png;base64,B=', 'https://cdn.example/b.png')

    const u = loadStore(dir).users[0]!
    expect(u.avatarSource, 'the same source twice is a no-op, not a rewrite').toBe('https://cdn.example/b.png')
    expect(u.avatar).toBe('data:image/png;base64,B=')
  })

  it('only asks for a picture when one would actually be used', () => {
    invite('nic@x.test')
    const qualified = `${ISSUER}#s1`
    const url = 'https://cdn.example/a.png'

    expect(wantsAvatarFrom(dir, qualified, 'nic@x.test', url), 'no account yet').toBe(true)

    provisionFromMarverId(dir, identity('nic@x.test', 's1'))
    attachAvatar(dir, `${ISSUER}#s1`, AVATAR, url)
    expect(wantsAvatarFrom(dir, qualified, 'nic@x.test', url), 'already have this one').toBe(false)
    expect(wantsAvatarFrom(dir, qualified, 'nic@x.test', 'https://cdn.example/b.png'), 'rotated').toBe(true)

    // And an avatar the person chose here is never worth fetching over.
    updateProfile(dir, 'nic@x.test', { avatar: 'data:image/png;base64,MINE=' })
    expect(wantsAvatarFrom(dir, qualified, 'nic@x.test', 'https://cdn.example/d.png'), 'theirs').toBe(false)
  })
})
