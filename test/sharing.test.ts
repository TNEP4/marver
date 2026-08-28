import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { serve } from '../src/server/serve.ts'
import { claimInvite, createInvite, provisionFromMarverId, revokeUser, signIn } from '../src/server/auth.ts'
import {
  ceilingsFromRights, commentAllowed, ensureShare, entryAllowed, loadShare, provisionVerdict,
  reclampShare, resolveAccess, saveShare, upsertGrant, type ShareStore,
} from '../src/server/share.ts'

/**
 * The sharing v1 enforcement surface, end to end against a real serve().
 *
 * Started with the seed relocation (04-solution §8 item 1, acceptance 3):
 * comment history is identity history, so the raw JSONL must never be
 * reachable as a static file - not from a new build (seeds live outside the
 * web root) and not from an old one (the server refuses the path outright).
 */

const PORT = 4741
let root = ''
let server: Server | null = null

const seedEvent = (id: string) =>
  JSON.stringify({ id, ts: 1, type: 'create', commentId: id, frame: 'x/y', author: { email: 'past@author.test', name: 'Past' }, body: 'hello' })

/** A minimal published canvas on disk - what buildSite leaves behind, hand-rolled. */
function scaffold() {
  const dist = join(root, 'design', '.dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body>BUNDLE</body></html>')
  writeFileSync(join(dist, 'meta.json'), JSON.stringify({ name: 'Seed Test', branding: true, rights: { main: 'comment' } }))
}

async function boot(env: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  server = await serve(root, PORT)
  await new Promise((r) => setTimeout(r, 50))
}

const get = (path: string) => fetch(`http://localhost:${PORT}${path}`, { redirect: 'manual' })

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mv-sharing-')) })
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r))
  server = null
  rmSync(root, { recursive: true, force: true })
  delete process.env.MARVER_DATA_DIR
  delete process.env.MARVER_PASSWORD
})

describe('seeds out of the web root (acceptance 3)', () => {
  it('refuses /design/comments/* statically even when an old build left the file in dist', async () => {
    scaffold()
    const legacy = join(root, 'design', '.dist', 'design', 'comments')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'main.jsonl'), seedEvent('ev-legacy') + '\n')
    const data = join(root, 'data')
    await boot({ MARVER_DATA_DIR: data })

    // the raw log is not served - not the file, and not the shell fallback either
    const res = await get('/design/comments/main.jsonl')
    expect(res.status).toBe(404)
    // a missing log is indistinguishable from a present one
    expect((await get('/design/comments/other.jsonl')).status).toBe(404)

    // but the seed still reached the live store (old-build compatibility)
    const stored = readFileSync(join(data, 'comments', 'main.jsonl'), 'utf8')
    expect(stored).toContain('ev-legacy')
  })

  it('unions seeds from design/.dist-seeds (the new home, outside the web root)', async () => {
    scaffold()
    const seeds = join(root, 'design', '.dist-seeds')
    mkdirSync(seeds, { recursive: true })
    writeFileSync(join(seeds, 'main.jsonl'), seedEvent('ev-relocated') + '\n')
    const data = join(root, 'data')
    await boot({ MARVER_DATA_DIR: data })

    const stored = readFileSync(join(data, 'comments', 'main.jsonl'), 'utf8')
    expect(stored).toContain('ev-relocated')
    // and nothing under the seeds dir is reachable over HTTP - a miss falls back
    // to the shell (hash routing), never to the log bytes
    expect(await (await get('/design/.dist-seeds/main.jsonl')).text()).not.toContain('past@author.test')
    expect(await (await get('/../.dist-seeds/main.jsonl')).text()).not.toContain('past@author.test')
  })

  it('refuses the path on a static-only serve too (no data dir, no API)', async () => {
    scaffold()
    const legacy = join(root, 'design', '.dist', 'design', 'comments')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'main.jsonl'), seedEvent('ev-static') + '\n')
    await boot()
    expect((await get('/design/comments/main.jsonl')).status).toBe(404)
  })
})

// ---- the resolver, pure (01-sharing §4) ----

const CEILINGS = ceilingsFromRights({ 'release-review': 'comment', roadmap: 'comment', internal: 'read' } as any)
const baseStore = (over: Partial<ShareStore> = {}): ShareStore => ({
  version: 1, general: { mode: 'private', role: 'view' }, blocked: [], grants: [], ...over,
})

describe('resolveAccess - blocklist, additive grants, ceiling clamp', () => {
  it("resolves the intent's own headline case: personal grant survives the narrower domain grant", () => {
    // canvas grant: sam comment; board grant: @openai.com view on roadmap
    const store = baseStore({
      grants: [
        { principal: 'sam@openai.com', scope: 'canvas', assigned: 'comment',
          boardRole: { 'release-review': 'comment', roadmap: 'comment', internal: 'view' }, expires: null, by: 't', at: 't' },
        { principal: '@openai.com', scope: 'board:roadmap', assigned: 'view',
          boardRole: { roadmap: 'view' }, expires: null, by: 't', at: 't' },
      ],
    })
    const sam = resolveAccess({ email: 'sam@openai.com', store, ceilings: CEILINGS })
    expect(sam.boards.roadmap).toBe('comment')          // min(comment ceiling, max(comment, view))
    const other = resolveAccess({ email: 'dana@openai.com', store, ceilings: CEILINGS })
    expect(other.boards.roadmap).toBe('view')           // domain only
    expect(other.boards['release-review']).toBe('none') // no grant reaches it
    expect(other.entry).toBe(true)                      // one board ≥ view is the whole entry test
  })

  it('blocklist beats every grant, including the domain that would admit', () => {
    const store = baseStore({
      blocked: ['ex@openai.com'],
      grants: [{ principal: '@openai.com', scope: 'canvas', assigned: 'comment',
        boardRole: { 'release-review': 'comment', roadmap: 'comment', internal: 'view' }, expires: null, by: 't', at: 't' }],
    })
    const r = resolveAccess({ email: 'ex@openai.com', store, ceilings: CEILINGS })
    expect(r.entry).toBe(false)
    expect(Object.values(r.boards).every((x) => x === 'none')).toBe(true)
    expect(provisionVerdict(store, 'ex@openai.com')).toBe('blocked')
    expect(provisionVerdict(store, 'ok@openai.com')).toBe('granted')
  })

  it('an expired grant contributes nothing', () => {
    const store = baseStore({
      grants: [{ principal: 'dana@acme.co', scope: 'canvas', assigned: 'comment',
        boardRole: { 'release-review': 'comment' }, expires: '2020-01-01T00:00:00Z', by: 't', at: 't' }],
    })
    expect(resolveAccess({ email: 'dana@acme.co', store, ceilings: CEILINGS }).entry).toBe(false)
    expect(provisionVerdict(store, 'dana@acme.co')).toBe('none')
  })

  it('the owner role precedes principal matching but never beats the ceiling', () => {
    const r = resolveAccess({ email: 'own@x.co', userRole: 'owner', store: baseStore(), ceilings: CEILINGS })
    expect(r.boards['release-review']).toBe('comment')
    expect(r.boards.internal).toBe('view')              // read-ceiling board clamps even the owner
    expect(r.entry).toBe(true)
  })

  it('general access (password/public) contributes view to everyone, anonymous included', () => {
    const store = baseStore({ general: { mode: 'password', role: 'view' } })
    const anon = resolveAccess({ email: null, store, ceilings: CEILINGS })
    expect(anon.entry).toBe(true)
    expect(anon.boards.roadmap).toBe('view')
    const priv = resolveAccess({ email: null, store: baseStore(), ceilings: CEILINGS })
    expect(priv.entry).toBe(false)
  })
})

// ---- the per-board ratchet (acceptance 7) ----

describe('boardRole ratchet - ceiling round-trip never silently re-promotes', () => {
  it('dip and rise leaves the entry demoted on exactly the board that dipped', () => {
    const dir = join(root, 'data')
    const both = ceilingsFromRights({ a: 'comment', b: 'comment' } as any)
    ensureShare(dir, 'private', [], both)
    upsertGrant(dir, both, { principal: 'dana@acme.co', scope: 'canvas', assigned: 'comment', by: 'owner' })
    expect(loadShare(dir)!.grants[0].boardRole).toEqual({ a: 'comment', b: 'comment' })

    // the owner lowers board a's ceiling and redeploys
    reclampShare(dir, ceilingsFromRights({ a: 'read', b: 'comment' } as any))
    expect(loadShare(dir)!.grants[0].boardRole).toEqual({ a: 'view', b: 'comment' })

    // then raises it back and redeploys - the ratchet must NOT restore comment
    reclampShare(dir, both)
    const g = loadShare(dir)!.grants[0]
    expect(g.boardRole).toEqual({ a: 'view', b: 'comment' })
    expect(g.assigned).toBe('comment')                  // what the owner asked for is remembered, displayed, never read

    // and the read side agrees: dana cannot comment on a, still can on b
    expect(commentAllowed(dir, { email: 'dana@acme.co', role: 'member' }, 'a', both)).toBe(false)
    expect(commentAllowed(dir, { email: 'dana@acme.co', role: 'member' }, 'b', both)).toBe(true)
  })

  it('a board new to this build gets its entry at min(assigned, ceiling) on the boot that first sees it', () => {
    const dir = join(root, 'data')
    ensureShare(dir, 'private', [], ceilingsFromRights({ a: 'comment' } as any))
    upsertGrant(dir, ceilingsFromRights({ a: 'comment' } as any), { principal: 'dana@acme.co', scope: 'canvas', assigned: 'comment', by: 'owner' })
    reclampShare(dir, ceilingsFromRights({ a: 'comment', later: 'read' } as any))
    expect(loadShare(dir)!.grants[0].boardRole).toEqual({ a: 'comment', later: 'view' })
  })
})

// ---- every door refuses (acceptance 2), end to end ----

describe('a revoked or blocked member is refused at every door', () => {
  it('gate, static, comment GET/POST, events and fresh sign-in all say no', async () => {
    scaffold()
    const data = join(root, 'data')
    // an owner and a member, both password accounts, existing BEFORE first boot
    const inv1 = createInvite(data, 'owner@x.test')
    const owner = claimInvite(data, inv1.token, { password: 'long-enough-pass', name: 'Owner' })
    const inv2 = createInvite(data, 'member@x.test')
    const member = claimInvite(data, inv2.token, { password: 'long-enough-pass', name: 'Member' })

    await boot({ MARVER_DATA_DIR: data, MARVER_PASSWORD: 'canvas-pw' })
    // migration ran: password canvas, both accounts granted comment
    const share = loadShare(data)!
    expect(share.general.mode).toBe('password')
    expect(share.grants.map((g) => g.principal).sort()).toEqual(['member@x.test', 'owner@x.test'])

    const asMember = { headers: { cookie: `mv_s=${member.session}` } }
    const bundle = await fetch(`http://localhost:${PORT}/`, asMember)
    expect(await bundle.text()).toContain('BUNDLE')

    // the owner blocks the member and shuts the anonymous door
    share.blocked = ['member@x.test']
    share.general.mode = 'private'
    saveShare(data, share)

    // the gate: the session still exists, but the resolver's answer has changed
    expect(await (await fetch(`http://localhost:${PORT}/`, asMember)).text()).not.toContain('BUNDLE')
    // static assets behind the gate
    expect(await (await fetch(`http://localhost:${PORT}/assets/x.js`, asMember)).text()).not.toContain('BUNDLE')
    // the API doors, Bearer included (it pierces the gate only for the still-admitted)
    const bearer = { headers: { authorization: `Bearer ${member.session}` } }
    const cg = await fetch(`http://localhost:${PORT}/__mv/api/comments/main`, bearer)
    expect(cg.headers.get('content-type')).toContain('text/html')   // the gate page, not events
    const ev = await fetch(`http://localhost:${PORT}/__mv/api/events`, bearer)
    expect(ev.headers.get('content-type')).not.toContain('event-stream')
    // a fresh sign-in attempt
    const si = await fetch(`http://localhost:${PORT}/__mv/api/auth/signin`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'member@x.test', password: 'long-enough-pass' }),
    })
    expect(si.status).toBe(401)
    // the canvas password door is shut too (general access went Private)
    const pw = await fetch(`http://localhost:${PORT}/__mv/auth`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=canvas-pw',
    })
    expect(await pw.text()).toContain('members-only')

    // and the owner is untouched
    const asOwner = { headers: { cookie: `mv_s=${owner.session}` } }
    expect(await (await fetch(`http://localhost:${PORT}/`, asOwner)).text()).toContain('BUNDLE')
  })

  it('two signed-in people on the same comment board get different write outcomes (acceptance 1)', async () => {
    const data = join(root, 'data')
    const ceil = ceilingsFromRights({ main: 'comment' } as any)
    ensureShare(data, 'private', [], ceil)
    upsertGrant(data, ceil, { principal: 'writer@x.test', scope: 'canvas', assigned: 'comment', by: 'owner' })
    upsertGrant(data, ceil, { principal: 'reader@x.test', scope: 'canvas', assigned: 'view', by: 'owner' })
    expect(commentAllowed(data, { email: 'writer@x.test', role: 'member' }, 'main', ceil)).toBe(true)
    expect(commentAllowed(data, { email: 'reader@x.test', role: 'member' }, 'main', ceil)).toBe(false)
    expect(entryAllowed(data, { email: 'reader@x.test', role: 'member' }, ceil)).toBe(true)
    // expiry crossing mid-session: the next request is the one that notices
    upsertGrant(data, ceil, { principal: 'writer@x.test', scope: 'canvas', assigned: 'comment', by: 'owner', expires: new Date(Date.now() - 1000).toISOString() })
    expect(commentAllowed(data, { email: 'writer@x.test', role: 'member' }, 'main', ceil)).toBe(false)
    expect(entryAllowed(data, { email: 'writer@x.test', role: 'member' }, ceil)).toBe(false)
  })
})

// ---- store coherence across auth.json and share.json ----

describe('the two stores stay coherent', () => {
  const CEIL = ceilingsFromRights({ main: 'comment' } as any)
  const ISSUER = 'https://id.example.test'

  it('revoking an account removes its grant too - the next sign-in cannot re-provision it', () => {
    const data = join(root, 'data')
    ensureShare(data, 'private', [], CEIL)
    // an identity owner, then a granted member who signed in once
    provisionFromMarverId(data, { email: 'owner@x.test', subject: 's-own', issuer: ISSUER }, { ownerEmail: 'owner@x.test', ceilings: CEIL })
    upsertGrant(data, CEIL, { principal: 'dana@x.test', scope: 'canvas', assigned: 'comment', by: 'owner' })
    expect(provisionFromMarverId(data, { email: 'dana@x.test', subject: 's-dana', issuer: ISSUER }, { ceilings: CEIL })).not.toBeNull()

    revokeUser(data, 'dana@x.test')
    expect(loadShare(data)!.grants.some((g) => g.principal === 'dana@x.test')).toBe(false)
    // the door stays shut: no account, no invite, no grant
    expect(provisionFromMarverId(data, { email: 'dana@x.test', subject: 's-dana', issuer: ISSUER }, { ceilings: CEIL })).toBeNull()
  })

  it('a verified rename carries the exact grant to the new address, and a block on either address refuses', () => {
    const data = join(root, 'data')
    ensureShare(data, 'private', [], CEIL)
    provisionFromMarverId(data, { email: 'owner@x.test', subject: 's-own', issuer: ISSUER }, { ownerEmail: 'owner@x.test', ceilings: CEIL })
    upsertGrant(data, CEIL, { principal: 'old@corp.test', scope: 'canvas', assigned: 'comment', by: 'owner' })
    expect(provisionFromMarverId(data, { email: 'old@corp.test', subject: 's-ren', issuer: ISSUER }, { ceilings: CEIL })).not.toBeNull()

    // the same subject returns under a new address: admitted, grant follows
    const renamed = provisionFromMarverId(data, { email: 'new@corp.test', subject: 's-ren', issuer: ISSUER }, { ceilings: CEIL })
    expect(renamed).not.toBeNull()
    const grants = loadShare(data)!.grants
    expect(grants.some((g) => g.principal === 'new@corp.test')).toBe(true)
    expect(grants.some((g) => g.principal === 'old@corp.test')).toBe(false)

    // and a rename is never a way out of the blocklist
    const share = loadShare(data)!
    share.blocked = ['new@corp.test']
    saveShare(data, share)
    expect(provisionFromMarverId(data, { email: 'third@corp.test', subject: 's-ren', issuer: ISSUER }, { ceilings: CEIL })).toBeNull()
  })

  it('v1 refuses board-scoped grants and domain grants outside identity mode at creation', () => {
    const data = join(root, 'data')
    ensureShare(data, 'private', [], CEIL)
    expect(() => upsertGrant(data, CEIL, { principal: 'x@y.test', scope: 'board:main', assigned: 'view', by: 'o' }))
      .toThrow(/canvas-scoped/)
    expect(() => upsertGrant(data, CEIL, { principal: '@y.test', scope: 'canvas', assigned: 'view', by: 'o' }))
      .toThrow(/identity gate/)
    expect(upsertGrant(data, CEIL, { principal: '@y.test', scope: 'canvas', assigned: 'view', by: 'o' }, { identityMode: true }).principal).toBe('@y.test')
  })

  it('a malformed share.json fails closed, never open', () => {
    const data = join(root, 'data')
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'share.json'), JSON.stringify({
      version: 1, general: { mode: 'privat', role: 'view' }, blocked: [], grants: [],
    }))
    expect(() => loadShare(data)).toThrow(/malformed/)
    writeFileSync(join(data, 'share.json'), JSON.stringify({
      version: 1, general: { mode: 'private', role: 'view' }, blocked: [],
      grants: [{ principal: 'a@b.c', scope: 'canvas', assigned: 'comment', boardRole: { main: 'commment' }, expires: null, by: 'o', at: 't' }],
    }))
    expect(() => loadShare(data)).toThrow(/malformed/)
  })

  it('an invite redeemed after migration materialises the comment grant it always meant', () => {
    const data = join(root, 'data')
    ensureShare(data, 'private', [], CEIL)
    const inv = createInvite(data, 'late@x.test')
    claimInvite(data, inv.token, { password: 'long-enough-pass', name: 'Late' }, CEIL)
    const g = loadShare(data)!.grants.find((x) => x.principal === 'late@x.test')
    expect(g?.assigned).toBe('comment')
    expect(g?.boardRole).toEqual({ main: 'comment' })
    // and sign-in works through the resolver door
    expect(signIn(data, 'late@x.test', 'long-enough-pass', CEIL)).not.toBeNull()
  })

  it('migration matrix: identity mode → Private; ungated+data → Public', async () => {
    scaffold()
    const data = join(root, 'data')
    await boot({ MARVER_DATA_DIR: data })          // no gate at all
    expect(loadShare(data)!.general.mode).toBe('public')
  })
})

// ---- writes through the real route after revocation ----

describe('comment POST refuses after a grant is revoked mid-session', () => {
  it('the same session writes, loses the grant, and cannot write again', async () => {
    scaffold()
    const data = join(root, 'data')
    const inv1 = createInvite(data, 'owner@x.test')
    claimInvite(data, inv1.token, { password: 'long-enough-pass', name: 'Owner' })
    const inv2 = createInvite(data, 'member@x.test')
    const member = claimInvite(data, inv2.token, { password: 'long-enough-pass', name: 'Member' })
    await boot({ MARVER_DATA_DIR: data, MARVER_PASSWORD: 'canvas-pw' })

    const post = () => fetch(`http://localhost:${PORT}/__mv/api/comments/main`, {
      method: 'POST',
      headers: { authorization: `Bearer ${member.session}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ id: crypto.randomUUID(), ts: Date.now(), type: 'create', commentId: crypto.randomUUID(), frame: 'x/y', anchor: {}, author: { email: 'member@x.test', name: 'Member' }, body: 'hi' }] }),
    })
    expect((await post()).status).toBe(200)

    // the owner downgrades the member to view - same session, next request refused
    const share = loadShare(data)!
    const g = share.grants.find((x) => x.principal === 'member@x.test')!
    g.assigned = 'view'
    g.boardRole = { main: 'view' }
    saveShare(data, share)
    expect((await post()).status).toBe(403)
  })
})

// ---- the identity-minimised projection (acceptance 4) ----

describe('no member email travels to a browser', () => {
  it('projects GET + keeps the CLI operator raw + refuses client-sent ids', async () => {
    scaffold()
    const data = join(root, 'data')
    const inv1 = createInvite(data, 'owner@x.test')
    const owner = claimInvite(data, inv1.token, { password: 'long-enough-pass', name: 'Owner' })
    const inv2 = createInvite(data, 'member@x.test')
    const member = claimInvite(data, inv2.token, { password: 'long-enough-pass', name: 'Member' })
    const secret = 'a'.repeat(48)
    await boot({ MARVER_DATA_DIR: data, MARVER_PASSWORD: 'canvas-pw', MARVER_CLI_TOKEN: secret })

    // the owner writes a comment through the API
    const post = (author: any) => fetch(`http://localhost:${PORT}/__mv/api/comments/main`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.session}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ id: crypto.randomUUID(), ts: Date.now(), type: 'create', commentId: crypto.randomUUID(), frame: 'x/y', anchor: {}, author, body: 'note' }] }),
    })
    expect((await post({ email: 'owner@x.test', name: 'Owner' })).status).toBe(200)
    // a client-sent opaque id is refused - it would fork the canonical log
    expect((await post({ email: 'owner@x.test', name: 'Owner', id: 'forged' })).status).toBe(400)

    // the member's browser transport: no email anywhere, opaque ids instead
    const asMember = { headers: { authorization: `Bearer ${member.session}` } }
    const got = await (await fetch(`http://localhost:${PORT}/__mv/api/comments/main`, asMember)).json() as any
    expect(JSON.stringify(got)).not.toContain('owner@x.test')
    expect(got.events[0].author.id).toMatch(/^[0-9a-f]{24}$/)
    expect(got.events[0].author.name).toBe('Owner')

    // the session response carries the viewer's own id, and their own email stays theirs
    const me = await (await fetch(`http://localhost:${PORT}/__mv/api/me`, asMember)).json() as any
    expect(me.id).toMatch(/^[0-9a-f]{24}$/)
    expect(me.user.email).toBe('member@x.test')
    expect(me.id).not.toBe(got.events[0].author.id)

    // the operator's session (CLI sync) still receives canonical bytes
    const cli = await (await fetch(`http://localhost:${PORT}/__mv/api/cli-session`, {
      method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: '{}',
    })).json() as any
    const raw = await (await fetch(`http://localhost:${PORT}/__mv/api/comments/main`, { headers: { authorization: `Bearer ${cli.token}` } })).json() as any
    expect(raw.events[0].author.email).toBe('owner@x.test')
    expect(raw.events[0].author.id).toBeUndefined()

    // and the canonical log on disk is untouched
    expect(readFileSync(join(data, 'comments', 'main.jsonl'), 'utf8')).toContain('owner@x.test')
    delete process.env.MARVER_CLI_TOKEN
  })
})

// ---- publish.json v2 (01-sharing §5.1) ----

describe('resolvePolicy - v2 policy with v1 read-compat', () => {
  const write = (policy: unknown) => {
    mkdirSync(join(root, 'design', 'boards'), { recursive: true })
    writeFileSync(join(root, 'design', 'boards', 'a.json'), '{}')
    writeFileSync(join(root, 'design', 'boards', 'deck.json'), '{}')
    writeFileSync(join(root, 'design', 'publish.json'), JSON.stringify(policy))
  }
  const boards = () => ({ a: {}, deck: {} })

  it('reads a v1 policy unchanged and defaults type to mix, source to OFF', async () => {
    const { resolvePolicy } = await import('../src/server/build.ts')
    write({ boards: { a: 'comment' } })
    const p = resolvePolicy(root, boards())
    expect(p.boards.a).toEqual({ max: 'comment', type: 'mix' })
    expect(p.reveal).toEqual({ structure: true, source: false })
  })

  it('parses v2 rows: max, type, open, lock', async () => {
    const { resolvePolicy } = await import('../src/server/build.ts')
    write({ version: 2, boards: { a: { max: 'comment', type: 'doc' }, deck: { max: 'read', type: 'slides', open: 'slides', lock: true } }, reveal: { source: true } })
    const p = resolvePolicy(root, boards())
    expect(p.boards.a).toEqual({ max: 'comment', type: 'doc' })
    expect(p.boards.deck).toEqual({ max: 'read', type: 'slides', open: 'slides', lock: true })
    expect(p.reveal.source).toBe(true)
  })

  it('lock without open fails the build; junk types and modes fail it too', async () => {
    const { resolvePolicy } = await import('../src/server/build.ts')
    write({ boards: { a: { max: 'read', lock: true } } })
    expect(() => resolvePolicy(root, boards())).toThrow(/lock" without "open/)
    write({ boards: { a: { max: 'read', type: 'movie' } } })
    expect(() => resolvePolicy(root, boards())).toThrow(/type "movie"/)
    write({ boards: { a: { max: 'read', open: 'cinema' } } })
    expect(() => resolvePolicy(root, boards())).toThrow(/open "cinema"/)
    write({ boards: { a: { type: 'doc' } } })
    expect(() => resolvePolicy(root, boards())).toThrow(/needs "max"/)
  })
})

// ---- the front door: /__mv/api/summary + identity + seen (04-solution §9.1-9.2) ----

describe('the summary endpoint', () => {
  it('answers a valid summary token with a signed JWS; refuses cookies, strangers and junk', async () => {
    scaffold()
    const data = join(root, 'data')
    const ISSUER_PORT = PORT + 1
    // a pretend identity service: one keypair, one JWKS route
    const { generateKeyPairSync, createSign, createVerify } = await import('node:crypto')
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = { ...kp.publicKey.export({ format: 'jwk' }), kid: 'iss-kid', alg: 'ES256', use: 'sig' }
    const { createServer } = await import('node:http')
    const issuer = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })) })
    await new Promise<void>((r) => issuer.listen(ISSUER_PORT, r))
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const mint = (claims: Record<string, unknown>, typ = 'marver-summary+jwt') => {
      const h = b64({ alg: 'ES256', kid: 'iss-kid', typ })
      const p = b64(claims)
      const s = createSign('SHA256'); s.update(`${h}.${p}`); s.end()
      return `${h}.${p}.${s.sign({ key: kp.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
    }
    const now = () => Math.floor(Date.now() / 1000)
    const claims = (email: string, over: Record<string, unknown> = {}) => ({
      iss: `http://localhost:${ISSUER_PORT}`, aud: `http://localhost:${PORT}`, azp: 'https://app.marver.design',
      sub: `sub-${email}`, email, iat: now(), exp: now() + 60, ...over,
    })

    // an identity-mode canvas with an owner and one granted member
    const { provisionFromMarverId: prov } = await import('../src/server/auth.ts')
    const ceil = ceilingsFromRights({ main: 'comment' } as any)
    ensureShare(data, 'private', [], ceil)
    prov(data, { email: 'owner@x.test', subject: 's-own', issuer: `http://localhost:${ISSUER_PORT}` }, { ownerEmail: 'owner@x.test', ceilings: ceil })
    upsertGrant(data, ceil, { principal: 'member@x.test', scope: 'canvas', assigned: 'comment', by: 'owner' })
    // a comment so the thread counters have something to count
    const { appendEvents } = await import('../src/server/comments.ts')
    appendEvents(join(data, 'comments'), 'main', [
      { id: 'ev-1', ts: Date.now(), type: 'create', commentId: 'th-1', frame: 'x/y', author: { email: 'owner@x.test' }, body: 'open thread' } as any,
    ])

    await boot({
      MARVER_DATA_DIR: data,
      MARVER_ID_ISSUER: `http://localhost:${ISSUER_PORT}`,
      MARVER_PUBLIC_ORIGIN: `http://localhost:${PORT}`,
    })

    // key discovery is public
    const idr = await (await get('/__mv/api/identity')).json() as any
    expect(idr.kid).toMatch(/^[0-9a-f]{64}$/)
    expect(idr.jwk.kty).toBe('EC')

    // a valid token for a granted member: 200, a compact JWS that verifies
    const ok = await fetch(`http://localhost:${PORT}/__mv/api/summary`, { headers: { authorization: `Bearer ${mint(claims('member@x.test'))}` } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.marver.design')
    const jws = await ok.text()
    const [h, p, sg] = jws.split('.')
    const vf = createVerify('SHA256'); vf.update(`${h}.${p}`); vf.end()
    const { createPublicKey } = await import('node:crypto')
    expect(vf.verify({ key: createPublicKey({ key: idr.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(sg, 'base64url'))).toBe(true)
    const body = JSON.parse(Buffer.from(p, 'base64url').toString())
    expect(body.role).toBe('comment')
    expect(body.boards).toEqual([{ name: 'main', role: 'comment', type: 'mix' }])
    expect(body.threads).toEqual({ open: 1, unread: 1 })
    expect(body.owner).toBe(false)
    expect(body.people).toBeUndefined()
    expect(body.kid).toBe(idr.kid)
    expect(JSON.parse(Buffer.from(h, 'base64url').toString()).kid).toBe(idr.kid)

    // the owner sees people; a stranger gets an opaque 404; junk gets 401
    const own = await fetch(`http://localhost:${PORT}/__mv/api/summary`, { headers: { authorization: `Bearer ${mint(claims('owner@x.test'))}` } })
    const ownBody = JSON.parse(Buffer.from((await own.text()).split('.')[1], 'base64url').toString())
    expect(ownBody.owner).toBe(true)
    expect(ownBody.people).toBe(1)
    expect((await fetch(`http://localhost:${PORT}/__mv/api/summary`, { headers: { authorization: `Bearer ${mint(claims('nobody@x.test'))}` } })).status).toBe(404)
    expect((await fetch(`http://localhost:${PORT}/__mv/api/summary`, { headers: { authorization: 'Bearer junk' } })).status).toBe(401)
    // a gate-typ token is refused at this door (distinct typ, never replayable)
    expect((await fetch(`http://localhost:${PORT}/__mv/api/summary`, { headers: { authorization: `Bearer ${mint(claims('member@x.test'), 'marver-assertion+jwt')}` } })).status).toBe(401)
    // a cookie-bearing request is refused before routing
    expect((await fetch(`http://localhost:${PORT}/__mv/api/summary`, { headers: { authorization: `Bearer ${mint(claims('member@x.test'))}`, cookie: 'mv_s=whatever' } })).status).toBe(401)
    // preflight answers with exact-origin CORS
    const pre = await fetch(`http://localhost:${PORT}/__mv/api/summary`, { method: 'OPTIONS' })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.marver.design')

    // mark-seen zeroes unread and moves nothing else
    const { sessionUser: _su } = await import('../src/server/auth.ts')
    const member = prov(data, { email: 'member@x.test', subject: 's-mem', issuer: `http://localhost:${ISSUER_PORT}` }, { ceilings: ceil })!
    const seen = await fetch(`http://localhost:${PORT}/__mv/api/seen`, {
      method: 'POST', headers: { authorization: `Bearer ${member.session}`, 'content-type': 'application/json' },
      body: JSON.stringify({ board: 'main' }),
    })
    expect(seen.status).toBe(204)
    expect((await fetch(`http://localhost:${PORT}/__mv/api/seen`, {
      method: 'POST', headers: { authorization: `Bearer ${member.session}`, 'content-type': 'application/json' },
      body: JSON.stringify({ board: 'ghost' }),
    })).status).toBe(422)
    const after = await fetch(`http://localhost:${PORT}/__mv/api/summary`, { headers: { authorization: `Bearer ${mint(claims('member@x.test'))}` } })
    const afterBody = JSON.parse(Buffer.from((await after.text()).split('.')[1], 'base64url').toString())
    expect(afterBody.threads).toEqual({ open: 1, unread: 0 })

    await new Promise<void>((r) => issuer.close(() => r()))
    delete process.env.MARVER_ID_ISSUER
    delete process.env.MARVER_PUBLIC_ORIGIN
  })
})
