import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvents, readLog, replay, type CommentEvent } from '../src/server/comments.ts'
import { validateEvents } from '../src/server/collab.ts'
import { heldWords, localOnlyThreads, readHeld, syncOnce } from '../src/server/sync.ts'

/**
 * 0.37.1: `marver comments sync` against a published canvas through the operator session (the CLI token - the
 * owner), with the published validator itself deciding every push. Issue #25: comments written on `marver dev`
 * before the repo was connected carry no address. Issue #30: a thread Marver started, already on the canvas.
 */

const OWNER = { email: 'nic@owner.test', name: 'Nic' }
let clock = Date.now() - 60_000
const t = () => (clock += 10)
const create = (id: string, o: Partial<CommentEvent> = {}): CommentEvent => ({ id: `ev-${id}`, ts: t(), type: 'create', commentId: id, frame: 'demo/hero', board: 'main', author: OWNER, body: `about ${id}`, ...o })
const reply = (id: string, parent: string, o: Partial<CommentEvent> = {}): CommentEvent => ({ id: `ev-${id}`, ts: t(), type: 'reply', commentId: id, parentId: parent, board: 'main', author: OWNER, body: `re ${id}`, ...o })
const resolve = (thread: string): CommentEvent => ({ id: `rs-${thread}-${Math.random().toString(36).slice(2, 8)}`, ts: t(), type: 'resolve', commentId: thread })

/** A published canvas, enough of one: the real validator, as the operator session (the owner) - its 400 refuses the batch. */
async function canvas(seed: CommentEvent[] = []) {
  const store: CommentEvent[] = [...seed]
  const got: CommentEvent[][] = []
  const srv: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const p = (req.url ?? '').replace(/^\/__mv\/api\//, '')
    if (p === 'capabilities') return send(200, { delete: true })
    if (p === 'boards') return send(200, { rights: { main: 'comment' }, stored: ['main'] })
    if (p === 'comments/main' && req.method === 'GET') return send(200, { events: store })
    if (p === 'comments/main' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const { events } = JSON.parse(raw) as { events: CommentEvent[] }
        got.push(events)
        const bad = validateEvents(events, store, { email: OWNER.email, name: OWNER.name, role: 'owner', createdAt: 0 } as never, 'main', { operator: true })
        if (bad) return send(400, { error: bad })
        store.push(...events)
        send(200, { accepted: events.length })
      })
      return
    }
    send(404, { error: 'unknown' })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, store, got, close: () => new Promise<void>((r) => srv.close(() => r())) }
}
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'mv-sync0371-'))
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  return { root, dir: join(root, 'design', 'comments'), done: () => rmSync(root, { recursive: true, force: true }) }
}
const collab = (url: string) => ({ url, token: 't', email: OWNER.email, name: OWNER.name })

describe('#25: comments written on marver dev before the repo was connected', () => {
  it('the sync completes, exchange after exchange: they stay in the repo, said in one note; what came after still goes', async () => {
    const { root, dir, done } = temp()
    const srv = await canvas()
    try {
      // the dev profile before any connect: a name (or the "You" default) and no address
      const early = create('early0001', { author: { email: '', name: 'You' } })
      const early2 = create('early0002', { author: { name: 'Nic' } })
      appendEvents(dir, 'main', [early, reply('earlyr001', 'early0001', { author: { email: '', name: 'You' } }), early2, resolve('early0002')])
      // ...then connected: the owner's comments from here on carry the account
      appendEvents(dir, 'main', [create('after0001')])
      for (let i = 0; i < 2; i++) {
        const r = await syncOnce(root, collab(srv.url))
        expect(r.main).toMatchObject({ pushed: i === 0 ? 1 : 0, held: 4 })
      }
      expect(srv.store.map((e) => e.commentId)).toEqual(['after0001'])
      expect(srv.got.flat().some((e) => e.commentId?.startsWith('early'))).toBe(false)
      // one clear note for the board, naming why - never "another account"
      expect(heldWords(readHeld(root).main)).toEqual(['4 events kept local: written on marver dev before this repo was connected - the next publish carries them'])
      // nothing lost: every word is still in the repo
      expect(replay(readLog(dir, 'main')).map((x) => x.id).sort()).toEqual(['after0001', 'early0001', 'early0002'])
    } finally { await srv.close(); done() }
  })

  it('once a publish carried them (the build seeds them as they are), a later reply on one goes', async () => {
    const { root, dir, done } = temp()
    const early = create('early0003', { author: { email: '', name: 'You' } })
    const srv = await canvas([early])
    try {
      appendEvents(dir, 'main', [early, reply('later0003', 'early0003')])
      const r = await syncOnce(root, collab(srv.url))
      expect(r.main).toMatchObject({ pushed: 1 })
      expect(r.main.held).toBeUndefined()
      expect(srv.store.some((e) => e.commentId === 'later0003')).toBe(true)
    } finally { await srv.close(); done() }
  })
})

describe('#30: a thread Marver started that the published canvas already holds', () => {
  it('a resolve and the owner\'s reply on it reach the canvas; Marver\'s own reply never leaves; a note only here is never pushed', async () => {
    const { root, dir, done } = temp()
    // an older build seeded Marver's note onto the canvas
    const shipped = create('agentnt01', { agent: true, agentMeta: { devUser: 'Nic' }, author: OWNER, body: 'Marver note' } as Partial<CommentEvent>)
    const srv = await canvas([shipped])
    try {
      const marverReply = reply('agentrp01', 'agentnt01', { agent: true } as Partial<CommentEvent>)
      const localNote = create('agentnt02', { agent: true, body: 'only here' } as Partial<CommentEvent>)
      const captureNote = create('capture01', { capture: 'c1', body: 'my words' } as Partial<CommentEvent>)
      appendEvents(dir, 'main', [shipped, marverReply, { id: 'rx-agentrp01', ts: t(), type: 'react', commentId: 'agentrp01', emoji: '+1', author: OWNER } as CommentEvent,
        reply('ownerrp01', 'agentnt01'), resolve('agentnt01'),
        localNote, reply('ownerrp02', 'agentnt02'), resolve('agentnt02'), captureNote, resolve('capture01')])
      const r = await syncOnce(root, collab(srv.url))
      expect(r.main).toMatchObject({ pushed: 2 })
      expect(r.main.held).toBeUndefined()
      const sent = srv.got.flat()
      expect(sent.map((e) => e.commentId).sort()).toEqual(['agentnt01', 'ownerrp01'])
      expect(sent.some((e) => (e as { agent?: unknown }).agent)).toBe(false)
      expect(replay(srv.store).find((x) => x.id === 'agentnt01')).toMatchObject({ resolved: true })
      // a second exchange sends nothing again
      expect((await syncOnce(root, collab(srv.url))).main.pushed).toBe(0)
    } finally { await srv.close(); done() }
  })

  it('localOnlyThreads: what the canvas holds is not local-only; Marver\'s messages it lacks still are', () => {
    const note = create('agentnt09', { agent: true } as Partial<CommentEvent>)
    const mr = reply('agentrp09', 'agentnt09', { agent: true } as Partial<CommentEvent>)
    const or = reply('ownerrp09', 'agentnt09')
    expect([...localOnlyThreads([note, mr, or])].sort()).toEqual(['agentnt09', 'agentrp09', 'ownerrp09'])
    expect([...localOnlyThreads([note, mr, or], [note])].sort()).toEqual(['agentrp09'])
  })
})
