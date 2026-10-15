import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimInvite, createInvite, issueDeviceSession, opaqueId, provisionFromMarverId } from '../src/server/auth.ts'
import { collabHandler } from '../src/server/collab.ts'
import { appendEvents, readLog, type CommentEvent } from '../src/server/comments.ts'
import { saveShare } from '../src/server/share.ts'
import { collabFileFor, syncOnce } from '../src/server/sync.ts'

/**
 * No more All Scenes (spec 26, Part 7), on a published canvas: the old all-scenes comment log keeps
 * working for the threads whose frame ships. Readable by anyone admitted when some published board
 * shows the frame; a reply or a resolve needs comment rights on one of those boards; editing stays
 * the author's; a thread on a frame that does not ship is never exposed; and sync carries them.
 */

const ISSUER = 'https://id.example.test'
const SECRET = 'a-secret-long-enough-to-be-honoured-01'
let dir = ''
const dist = () => join(dir, 'dist')
const comments = () => join(dir, 'comments')

/** What a 0.25 build writes: each published board's ceiling, and the frames it shows. */
const publish = (meta: object) => { mkdirSync(dist(), { recursive: true }); writeFileSync(join(dist(), 'meta.json'), JSON.stringify(meta)) }
const RIGHTS = { flow: 'comment', specs: 'comment', notes: 'read' }
const SHOWS = { flow: ['shop/cart'], specs: ['shop/cart', 'shop/spec'], notes: ['shop/note'] }

let n = 0
const id = () => `ev-${String(++n).padStart(8, '0')}`
const ev = (e: Partial<CommentEvent>): CommentEvent => ({ id: id(), ts: Date.now() - 60_000, board: 'all-scenes', ...e } as CommentEvent)
const thread = (commentId: string, frame: string, email: string) => ev({ type: 'create', commentId, frame, author: { email, name: email.split('@')[0] }, body: `about ${frame}` })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mv-no-all-')); n = 0 })
afterEach(() => { rmSync(collabFileFor(dir), { force: true }); rmSync(dir, { recursive: true, force: true }); delete process.env.MARVER_CLI_TOKEN })

function drive(method: string, path: string, headers: Record<string, string> = {}, body: unknown = {}) {
  const handler = collabHandler(dir, dist())
  const req: any = {
    method, url: `/__mv/api/${path}`,
    headers: { host: 'localhost:4199', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    _cbs: {} as Record<string, (arg?: unknown) => void>,
    _pending: method === 'POST' ? Buffer.from(JSON.stringify(body)) : undefined,
    on(ev: string, cb: (arg?: unknown) => void) {
      this._cbs[ev] = cb
      if (ev === 'end' && this._pending !== undefined) { const raw = this._pending; this._pending = undefined; queueMicrotask(() => { this._cbs.data?.(raw); this._cbs.end?.() }) }
      return this
    },
    destroy() { /* unused */ },
  }
  const res: any = { statusCode: 0, headers: {}, body: '', setHeader(k: string, v: string) { this.headers[k] = v }, end(s?: string) { this.body = s ?? ''; this._done?.() } }
  return new Promise<{ status: number; json: any }>((resolve) => {
    res._done = () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(res.body) } catch { return null } })() })
    void handler(req, res, new URL(`http://localhost:4199/__mv/api/${path}`)).then((handled) => { if (!handled) resolve({ status: 404, json: null }) })
  })
}

/** The owner, a collaborator with comment rights on `flow` only, and a viewer - as bearer sessions. */
function people() {
  const owner = provisionFromMarverId(dir, { email: 'owner@x.test', subject: 's-own', issuer: ISSUER }, { ownerEmail: 'owner@x.test' })!
  const join_ = (email: string) => claimInvite(dir, createInvite(dir, email).token, { password: 'a-long-enough-password', name: email.split('@')[0] })
  const dana = join_('dana@x.test'), vic = join_('vic@x.test')
  const grant = (principal: string, boardRole: Record<string, string>) => ({ principal, scope: 'canvas' as const, assigned: 'comment' as const, boardRole, expires: null, by: 'owner', at: new Date().toISOString() })
  saveShare(dir, { version: 1, general: { mode: 'private', role: 'view' }, blocked: [], grants: [
    grant('dana@x.test', { flow: 'comment', specs: 'view', notes: 'view' }),                    // a grant that comments on one board only
    grant('vic@x.test', { flow: 'view', specs: 'view', notes: 'view' }),
  ] } as any)
  const as = (s: { session: string }) => ({ authorization: `Bearer ${s.session}` })
  return { owner: as(owner), dana: as(dana), vic: as(vic) }
}

describe('the old all-scenes log on a republished canvas', () => {
  it('serves the threads whose frame ships, to anyone admitted; a thread on an unshipped frame stays unexposed', async () => {
    publish({ rights: RIGHTS, shows: SHOWS })
    appendEvents(comments(), 'all-scenes', [
      thread('t-cart-000', 'shop/cart', 'dana@x.test'), thread('t-note-000', 'shop/note', 'dana@x.test'), thread('t-secret00', 'shop/secret', 'dana@x.test'),
      ev({ type: 'reply', commentId: 'r-secret00', parentId: 't-secret00', author: { email: 'dana@x.test' }, body: 'still hidden' }),
    ])
    const r = await drive('GET', 'comments/all-scenes')
    expect(r.status).toBe(200)
    expect(r.json.events.map((e: CommentEvent) => e.commentId)).toEqual(['t-cart-000', 't-note-000'])
    expect(JSON.stringify(r.json)).not.toContain('dana@x.test')                    // the browser transport, projected as ever
    expect((await drive('GET', 'boards')).json.legacy).toEqual({ board: 'all-scenes', frames: ['shop/cart', 'shop/spec'] })   // what sync may push: a commentable board's frames
  })

  it('a canvas built before 0.25 is unchanged until it is published again: the log stays unexposed', async () => {
    publish({ rights: RIGHTS })
    appendEvents(comments(), 'all-scenes', [thread('t-cart-000', 'shop/cart', 'dana@x.test')])
    expect((await drive('GET', 'comments/all-scenes')).status).toBe(404)
    expect((await drive('GET', 'boards')).json.legacy).toBeUndefined()
  })

  it('reply and resolve need comment rights on a board showing the frame; editing stays the author\'s; no new threads from a browser', async () => {
    publish({ rights: RIGHTS, shows: SHOWS })
    const p = people()
    appendEvents(comments(), 'all-scenes', [thread('t-cart-000', 'shop/cart', 'dana@x.test'), thread('t-note-000', 'shop/note', 'dana@x.test'), thread('t-secret00', 'shop/secret', 'dana@x.test'), thread('t-spec-000', 'shop/spec', 'dana@x.test')])
    const post = (who: Record<string, string>, e: Partial<CommentEvent>) => drive('POST', 'comments/all-scenes', who, { events: [ev(e)] })
    const reply = (parentId: string, email: string) => ({ type: 'reply' as const, commentId: id(), parentId, author: { email }, body: 'answer' })
    // shop/cart is on flow (dana comments there) and specs (view only): one board is enough
    expect((await post(p.dana, reply('t-cart-000', 'dana@x.test'))).status).toBe(200)
    expect((await post(p.dana, { type: 'resolve', commentId: 't-cart-000' })).status).toBe(200)
    expect((await post(p.dana, { type: 'reopen', commentId: 't-cart-000' })).status).toBe(200)
    // shop/spec is only on specs, where her grant reads; shop/note only on a read-only board
    expect((await post(p.dana, reply('t-spec-000', 'dana@x.test'))).status).toBe(403)
    expect((await post(p.dana, reply('t-note-000', 'dana@x.test'))).status).toBe(403)
    expect((await post(p.owner, reply('t-note-000', 'owner@x.test'))).status).toBe(403)   // nobody comments on a read-only board
    expect((await post(p.owner, reply('t-spec-000', 'owner@x.test'))).status).toBe(200)
    // a viewer comments nowhere; a frame that does not ship takes nothing
    expect((await post(p.vic, reply('t-cart-000', 'vic@x.test'))).status).toBe(403)
    expect((await post(p.dana, reply('t-secret00', 'dana@x.test'))).status).toBe(403)
    // editing: the author's, never another commenter's
    const firstReply = readLog(comments(), 'all-scenes').find((e) => e.type === 'reply')!
    expect((await post(p.owner, { type: 'edit', commentId: firstReply.commentId, author: { email: 'owner@x.test' }, body: 'mine now' })).status).toBe(400)
    expect((await post(p.dana, { type: 'edit', commentId: firstReply.commentId, author: { email: 'dana@x.test' }, body: 'answer, edited' })).status).toBe(200)
    // someone known only from the old log can be mentioned like anyone else
    appendEvents(comments(), 'all-scenes', [thread('t-ghost-00', 'shop/cart', 'ghost@x.test')])
    expect((await post(p.owner, { ...reply('t-ghost-00', 'owner@x.test'), mentions: [{ id: opaqueId(dir, 'ghost@x.test'), label: 'ghost' }] })).status).toBe(200)
    // a resolve is judged by the thread it names, never by a parentId riding along
    expect((await post(p.dana, { type: 'resolve', commentId: 't-spec-000', parentId: 't-cart-000' })).status).toBe(403)
    // a new thread lives on a board, never in the old log
    expect((await post(p.dana, { type: 'create', commentId: id(), frame: 'shop/cart', author: { email: 'dana@x.test' }, body: 'new' })).status).toBe(403)
    expect((await drive('POST', 'comments/all-scenes', {}, { events: [ev(reply('t-cart-000', 'dana@x.test'))] })).status).toBe(401)
  })

  it('sync carries them: the owner\'s replies and threads on frames that ship go up, a collaborator\'s come down, the rest stays home', async () => {
    publish({ rights: RIGHTS, shows: SHOWS })
    const p = people()
    process.env.MARVER_CLI_TOKEN = SECRET
    const op = issueDeviceSession(dir, SECRET)!
    // the published side: a collaborator's thread, and her reply in it
    appendEvents(comments(), 'all-scenes', [thread('t-cart-000', 'shop/cart', 'dana@x.test')])
    expect((await drive('POST', 'comments/all-scenes', p.dana, { events: [ev({ type: 'reply', commentId: 'r-dana-000', parentId: 't-cart-000', author: { email: 'dana@x.test' }, body: 'from the web' })] })).status).toBe(200)
    const repo = join(dir, 'repo')
    const local = join(repo, 'design', 'comments')
    const server: Server = createServer((req, res) => {
      void collabHandler(dir, dist())(req, res, new URL(req.url ?? '/', 'http://localhost')).then((handled) => { if (!handled) { res.statusCode = 404; res.end() } })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    // a checkout that never had the log pulls it all the same: the canvas names it
    try { expect((await syncOnce(repo, { url, token: op.token }))['all-scenes']).toEqual({ pulled: 2, pushed: 0 }) }
    finally { rmSync(local, { recursive: true, force: true }) }
    // the repo's side: the same thread with the owner's reply, a thread never pushed on a shipped frame, one on a frame that does not ship
    appendEvents(local, 'all-scenes', [
      ...readLog(comments(), 'all-scenes').filter((e) => e.type === 'create'),
      ev({ type: 'reply', commentId: 'r-owner-00', parentId: 't-cart-000', author: { email: 'owner@x.test' }, body: 'from the repo' }),
      thread('t-local-00', 'shop/spec', 'owner@x.test'),
      thread('t-private', 'shop/secret', 'owner@x.test'),
    ])
    try {
      const out = await syncOnce(repo, { url, token: op.token })
      expect(out['all-scenes']).toEqual({ pulled: 1, pushed: 2 })
      const remote = readLog(comments(), 'all-scenes').map((e) => e.commentId)
      expect(remote).toEqual(expect.arrayContaining(['r-owner-00', 't-local-00']))
      expect(remote).not.toContain('t-private')
      expect(readLog(local, 'all-scenes').map((e) => e.commentId)).toContain('r-dana-000')
      // and again: nothing new either way
      expect((await syncOnce(repo, { url, token: op.token }))['all-scenes']).toEqual({ pulled: 0, pushed: 0 })
    } finally { server.close() }
  })
})
