import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { serve } from '../src/server/serve.ts'
import { claimInvite, createInvite } from '../src/server/auth.ts'
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
  version: 1, general: { mode: 'private', role: 'view' }, blocked: [], grants: [], ceilings: CEILINGS, ...over,
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
    upsertGrant(dir, { principal: 'dana@acme.co', scope: 'canvas', assigned: 'comment', by: 'owner' })
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
    upsertGrant(dir, { principal: 'dana@acme.co', scope: 'canvas', assigned: 'comment', by: 'owner' })
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
    upsertGrant(data, { principal: 'writer@x.test', scope: 'canvas', assigned: 'comment', by: 'owner' })
    upsertGrant(data, { principal: 'reader@x.test', scope: 'canvas', assigned: 'view', by: 'owner' })
    expect(commentAllowed(data, { email: 'writer@x.test', role: 'member' }, 'main', ceil)).toBe(true)
    expect(commentAllowed(data, { email: 'reader@x.test', role: 'member' }, 'main', ceil)).toBe(false)
    expect(entryAllowed(data, { email: 'reader@x.test', role: 'member' }, ceil)).toBe(true)
    // expiry crossing mid-session: the next request is the one that notices
    upsertGrant(data, { principal: 'writer@x.test', scope: 'canvas', assigned: 'comment', by: 'owner', expires: new Date(Date.now() - 1000).toISOString() })
    expect(commentAllowed(data, { email: 'writer@x.test', role: 'member' }, 'main', ceil)).toBe(false)
    expect(entryAllowed(data, { email: 'writer@x.test', role: 'member' }, ceil)).toBe(false)
  })
})
