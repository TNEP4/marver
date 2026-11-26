import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvents, readLog, replay, type CommentEvent } from '../src/server/comments.ts'
import { heldWords, readHeld, syncOnce } from '../src/server/sync.ts'
import { validateEvents } from '../src/server/collab.ts'
import { activityJobs } from '../src/server/notify.ts'

const owner = { email: 'nic@test.dev', name: 'Nic', role: 'owner' as const, createdAt: 0 }
const now = Date.now()
const rootEvent: CommentEvent = { id: 'root-event01', type: 'create', commentId: 'thread01', ts: now - 1000, author: owner, body: 'Fix the flow', board: 'main' }
const reply: CommentEvent = { id: 'jam-backfill01', type: 'reply', commentId: 'jam-message01', parentId: 'thread01', ts: now - 30 * 60_000, author: owner, body: 'Fixed', asks: true, agent: true, board: 'main', agentMeta: { devUser: 'private machine', harness: 'codex', model: 'model', effort: 'high', runner: 'session' }, alsoChanged: ['private.ts'] }
const draw: CommentEvent = { ...rootEvent, id: 'draw-event01', commentId: 'draw-thread01', anchor: { el: { draw: { id: 'checkout:submit', type: 'rectangle' } } } }

async function canvas(caps: Record<string, boolean>, operator = true) {
  const events = [rootEvent], batches: CommentEvent[][] = []
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const send = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
    const p = String(url).replace('http://canvas.test/__mv/api/', '')
    if (p === 'capabilities') return send(200, caps)
    if (p === 'boards') return send(200, { rights: { main: 'comment' } })
    if (p === 'me') return send(200, { id: 'a'.repeat(24), operator })
    if (p === 'comments/main' && options?.method !== 'POST') return send(200, { events })
    if (p === 'comments/main' && options?.method === 'POST') {
      const incoming = JSON.parse(String(options.body)).events as CommentEvent[]
      batches.push(incoming)
      // 0.38 refuses provenance even from the operator, including the rest of its batch.
      const bad = !caps.agentEvents && incoming.some((e) => e.agent) ? 'agent provenance is daemon-only' : validateEvents(incoming, events, owner, 'main', { operator })
      if (bad) return send(400, { error: bad })
      events.push(...incoming); return send(200, { accepted: incoming.length })
    }
    return send(404, {})
  })
  return { events, batches, url: 'http://canvas.test', close: async () => fetchMock.mockRestore() }
}

describe('drawing and agent sync capabilities', () => {
  it('gives a 0.38 server a clean ordinary batch and holds agent and drawing events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-sync-draw-old-')), dir = join(root, 'design/comments'), remote = await canvas({ delete: true })
    try {
      const ordinary = { ...rootEvent, id: 'ordinary-event01', commentId: 'ordinary-thread01' }
      appendEvents(dir, 'main', [rootEvent, reply, draw, ordinary])
      const before = JSON.stringify(readLog(dir, 'main'))
      expect((await syncOnce(root, { url: remote.url, token: 'token', email: owner.email, operator: true })).main).toMatchObject({ pushed: 1, held: 2 })
      expect(remote.batches.flat()).toEqual([ordinary])
      expect(readHeld(root).main.map((h) => h.why)).toEqual(['old-canvas', 'old-canvas'])
      expect(heldWords(readHeld(root).main)[0]).toMatch(/older marver - publish it again/)
      expect(JSON.stringify(readLog(dir, 'main'))).toBe(before)
    } finally { await remote.close(); rmSync(root, { recursive: true, force: true }) }
  })
  it('holds events for password connections with the --token instruction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-sync-draw-password-')), remote = await canvas({ delete: true }, false)
    try {
      appendEvents(join(root, 'design/comments'), 'main', [rootEvent, reply, draw])
      expect((await syncOnce(root, { url: remote.url, token: 'password-session', email: owner.email, operator: false })).main).toMatchObject({ pushed: 0, held: 2 })
      expect(readHeld(root).main.every((h) => h.why === 'needs-operator')).toBe(true)
      expect(heldWords(readHeld(root).main)[0]).toContain('connect with --token')
      expect(remote.batches).toEqual([])
    } finally { await remote.close(); rmSync(root, { recursive: true, force: true }) }
  })
  it('backfills historical agent replies and edits, strips provenance, and pulls later corrections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-sync-draw-new-')), dir = join(root, 'design/comments'), remote = await canvas({ delete: true, agentEvents: true, drawAnchors: true })
    const edit: CommentEvent = { ...reply, id: 'jam-backfill-edit', type: 'edit', parentId: undefined, ts: reply.ts + 1, body: 'Fixed the label' }
    try {
      appendEvents(dir, 'main', [rootEvent, reply, edit, draw])
      expect((await syncOnce(root, { url: remote.url, token: 'token', email: owner.email, operator: true })).main).toMatchObject({ pushed: 3 })
      expect(JSON.stringify(remote.batches)).not.toMatch(/devUser|private machine|alsoChanged|private.ts/)
      expect(remote.events.find((e) => e.id === reply.id)).toMatchObject({ ts: reply.ts, asks: true, agent: true, agentMeta: { harness: 'codex', model: 'model', effort: 'high', runner: 'session' } })
      expect(activityJobs('main', remote.batches.flat(), remote.events, () => true, now).size).toBe(0)
      const correction: CommentEvent = { ...edit, id: 'jam-remote-edit', ts: now, body: 'Corrected remotely' }
      remote.events.push(correction)
      expect((await syncOnce(root, { url: remote.url, token: 'token', email: owner.email, operator: true })).main).toMatchObject({ pulled: 1, pushed: 0 })
      expect(replay(readLog(dir, 'main')).find((t) => t.id === 'thread01')?.replies[0].body).toBe('Corrected remotely')
      expect(readLog(dir, 'main').find((e) => e.id === reply.id)?.agentMeta?.devUser).toBe('private machine')
    } finally { await remote.close(); rmSync(root, { recursive: true, force: true }) }
  })
  it('holds malformed anchors and oversized bodies plus their dependent events without rewriting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-sync-draw-refused-')), dir = join(root, 'design/comments'), remote = await canvas({ delete: true, agentEvents: true, drawAnchors: true })
    try {
      const invalid = { ...draw, anchor: { el: { draw: { id: 'x'.repeat(257), type: 'rectangle' } } } }
      const long = { ...rootEvent, id: 'long-event01', commentId: 'long-thread01', body: 'x'.repeat(10001) }
      const dependent = { ...reply, id: 'jam-dependent01', commentId: 'jam-dependent-msg', parentId: long.commentId }
      appendEvents(dir, 'main', [rootEvent, invalid, long, dependent, reply])
      expect((await syncOnce(root, { url: remote.url, token: 'token', email: owner.email, operator: true })).main).toMatchObject({ pushed: 1, held: 3 })
      expect(readHeld(root).main.map((h) => h.why)).toEqual(expect.arrayContaining(['anchor-refused', 'body-refused', 'thread-kept-here']))
      expect(remote.batches.flat().map((e) => e.id)).toEqual([reply.id])
      expect(readLog(dir, 'main')).toContainEqual(invalid)
      expect(heldWords(readHeld(root).main).join(' ')).toMatch(/anchor is invalid/)
    } finally { await remote.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
