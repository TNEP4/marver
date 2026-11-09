import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '../src/server/serve.ts'
import { claimInvite, createInvite } from '../src/server/auth.ts'

/**
 * Spec 31 C.4 and C.6 on a published canvas (a real serve(), port 5633): the server says it takes deletes; a delete is
 * its author's alone; a deleted message's words never travel to a browser again (the log keeps them for sync, the
 * operator's raw transport too); an older client's events are taken as before.
 */

const PORT = 5633
let root = ''
let server: Server | null = null
let owner = { session: '' }, member = { session: '' }
const H = (s: string) => ({ authorization: `Bearer ${s}`, 'content-type': 'application/json' })
const post = (s: string, events: unknown[]) => fetch(`http://localhost:${PORT}/__mv/api/comments/main`, { method: 'POST', headers: H(s), body: JSON.stringify({ events }) })
const get = async (s: string) => (await (await fetch(`http://localhost:${PORT}/__mv/api/comments/main`, { headers: H(s) })).json()) as { events: any[] }
const id = () => crypto.randomUUID()

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-r31-serve-'))
  const dist = join(root, 'design', '.dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body>BUNDLE</body></html>')
  writeFileSync(join(dist, 'meta.json'), JSON.stringify({ name: 'R31', branding: true, rights: { main: 'comment' } }))
  const data = join(root, 'data')
  owner = claimInvite(data, createInvite(data, 'owner@x.test').token, { password: 'long-enough-pass', name: 'Owner' })
  member = claimInvite(data, createInvite(data, 'member@x.test').token, { password: 'long-enough-pass', name: 'Member' })
  process.env.MARVER_DATA_DIR = data
  process.env.MARVER_PASSWORD = 'canvas-pw'
  server = await serve(root, PORT)
  await new Promise((r) => setTimeout(r, 50))
})
afterAll(async () => {
  if (server) await new Promise((r) => server!.close(r))
  delete process.env.MARVER_DATA_DIR
  delete process.env.MARVER_PASSWORD
  rmSync(root, { recursive: true, force: true })
})

describe('a published canvas (spec 31 C.4, C.6)', () => {
  it('takes deletes, the author\'s only; a deleted message travels to browsers without its words', async () => {
    const caps = await fetch(`http://localhost:${PORT}/__mv/api/capabilities`, { headers: H(member.session) })
    expect(await caps.json()).toEqual({ delete: true })
    const c = id(), r = id()
    // an older client's events: as before - no capabilities asked, no op, no delete
    expect((await post(owner.session, [{ id: id(), ts: Date.now(), type: 'create', commentId: c, frame: 'x/y', anchor: {}, author: { email: 'owner@x.test', name: 'Owner' }, body: 'the secret plan' }])).status).toBe(200)
    expect((await post(member.session, [{ id: id(), ts: Date.now(), type: 'reply', commentId: r, parentId: c, author: { email: 'member@x.test', name: 'Member' }, body: 'nice' }])).status).toBe(200)
    // the member cannot delete the owner's message
    const theirs = await post(member.session, [{ id: id(), ts: Date.now(), type: 'delete', commentId: c, author: { email: 'member@x.test', name: 'Member' } }])
    expect(theirs.status).toBe(400)
    expect(((await theirs.json()) as any).error).toMatch(/only the author/)
    expect((await post(owner.session, [{ id: id(), ts: Date.now(), type: 'delete', commentId: c, author: { email: 'owner@x.test', name: 'Owner' } }])).status).toBe(200)
    const seen = await get(member.session)
    expect(JSON.stringify(seen)).not.toContain('the secret plan')
    expect(seen.events.find((e) => e.commentId === r).body).toBe('nice')
    expect(seen.events.some((e) => e.type === 'delete' && e.commentId === c)).toBe(true)
    // the log keeps it (sync is by id) - the operator's raw transport is canonical, never redacted
    expect(readFileSync(join(root, 'data', 'comments', 'main.jsonl'), 'utf8')).toContain('the secret plan')
    // an edit of a deleted message is refused
    expect((await post(owner.session, [{ id: id(), ts: Date.now(), type: 'edit', commentId: c, author: { email: 'owner@x.test', name: 'Owner' }, body: 'back' }])).status).toBe(400)
  })
})
