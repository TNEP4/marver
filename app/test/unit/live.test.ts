/**
 * The live streams (src/main/live.ts; spec 28 A4.6 #11, #16, #18, r1 #7), against an in-process Node server that
 * signs as a 0.29 canvas does (src/server/proof.ts): chunked events and comment lines, the byte budget, every field
 * checked again, `seq` and `instance`; a bad proof, instance, type or status applying nothing; the backoff and its
 * reset; idle; 403, 404, 405 and 409 stopping until the instance changes; `gone` dropping the snapshot; only ready
 * entries listing `live`; an old connection's late callbacks doing nothing.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appProofOk, liveProof, proofHeaders } from '../../../src/server/proof.ts'
import { LIVE_BOUNDS, LIVE_TITLES_MAX, LIVE_WIRE, type LiveEvent, type LiveItem } from '../../../src/shared/app-api.ts'
import { backoffMs, createLive, parseLive, SseReader, wantsLive, type Live, type LiveChange } from '../../src/main/live.ts'
import type { RegistryEntry } from '../../src/main/registry.ts'
import { T } from '../../src/main/timings.ts'

const saved = { backoff: T.liveBackoffMs, max: T.liveBackoffMaxMs, idle: T.liveIdleMs }
beforeEach(() => { T.liveBackoffMs = [40, 80, 160]; T.liveBackoffMaxMs = 200; T.liveIdleMs = 400 })
afterEach(() => { T.liveBackoffMs = saved.backoff; T.liveBackoffMaxMs = saved.max; T.liveIdleMs = saved.idle })

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<V>(fn: () => V, ok: (v: V) => boolean, ms = 2000): Promise<V> {
  const end = Date.now() + ms
  for (;;) { const v = fn(); if (ok(v) || Date.now() > end) return v; await wait(10) }
}

const item = (n: number, o: Partial<LiveItem> = {}): LiveItem => ({ id: `ask:${n.toString(16).padStart(20, '0')}`, kind: 'ask', board: 'main', title: `Question ${n}`, at: 1000 + n, thread: `t${n}`, msg: `m${n}`, ...o })
const event = (instance: string, seq: number, o: Partial<LiveEvent> = {}): LiveEvent => {
  const items = o.items ?? []
  return { v: 1, instance, seq, jam: 'on', items, cut: 0, counts: { ask: items.length, review: 0, failed: 0, stalled: 0 }, unseen: 0, working: false, session: false, ...o }
}
const frame = (e: unknown) => `event: live\ndata: ${JSON.stringify(e)}\n\n`

type Handle = (req: IncomingMessage, res: ServerResponse, n: number) => void
interface Canvas { server: Server; entry: RegistryEntry; reqs: IncomingMessage['headers'][]; handle: Handle; open: ServerResponse[]; close(): Promise<void> }

/** A canvas on 127.0.0.1 (an ephemeral port, never the owner's): its entry, its requests, a handler a case swaps. */
async function canvas(o: { features?: string[]; state?: RegistryEntry['state'] } = {}): Promise<Canvas> {
  const key = randomBytes(32)
  const c = { reqs: [], open: [] } as unknown as Canvas
  c.handle = (req, res) => sign(c, req, res)
  c.server = createServer((req, res) => {
    if (req.url !== LIVE_WIRE.path) { res.writeHead(404); res.end(); return }
    c.reqs.push({ ...req.headers })
    c.open.push(res)
    c.handle(req, res, c.reqs.length)
  })
  await new Promise<void>((r) => c.server.listen(0, '127.0.0.1', r))
  const port = (c.server.address() as AddressInfo).port
  c.entry = {
    file: `/home/running/slot-${port}.json`, key, state: o.state ?? 'ready', pid: 1, instance: randomUUID(), slot: null, port,
    origin: `http://127.0.0.1:${port}`, url: `http://localhost:${port}/`, root: '/r', name: 'Pilot', version: '0.29.0',
    features: o.features ?? ['bridge', 'inset', 'live'], ws: randomBytes(8).toString('hex'), startedAt: 1,
  }
  c.close = async () => { c.server.closeAllConnections(); await new Promise<void>((r) => c.server.close(() => r())) }
  return c
}

/** The 200 a 0.29 canvas answers: refused without the app's proof, signed with liveProof over the request's nonce. */
function sign(c: Canvas, req: IncomingMessage, res: ServerResponse, o: { key?: Buffer; instance?: string; type?: string } = {}): boolean {
  const e = c.entry
  if (!appProofOk({ key: e.key, port: e.port, instance: e.instance }, req.headers['x-mv-app'])) { res.writeHead(403); res.end(); return false }
  const h = proofHeaders({ key: o.key ?? e.key, port: e.port, instance: o.instance ?? e.instance }, req.headers['x-mv-nonce'], 'live')
  res.writeHead(200, { 'content-type': o.type ?? 'text/event-stream; charset=utf-8', ...h })
  res.flushHeaders()
  return true
}

let lives: Live[] = []
let canvases: Canvas[] = []
afterEach(async () => {
  for (const l of lives) l.close()
  for (const c of canvases) await c.close()
  lives = []; canvases = []
})

function start(c: Canvas, o: { random?: () => number; fetch?: typeof fetch } = {}) {
  const changes: { instance: string; why: LiveChange }[] = []
  const logs: Record<string, unknown>[] = []
  const live = createLive({ changed: (instance, why) => changes.push({ instance, why }), random: o.random ?? (() => 0), log: (_t, d) => logs.push(d as Record<string, unknown>), ...(o.fetch ? { fetch: o.fetch } : {}) })
  lives.push(live)
  canvases.push(c)
  live.start([c.entry])
  return { live, changes, logs }
}

describe('parsing (A4.6 #11, #16)', () => {
  it('event-stream lines: split across chunks and inside a character, comments skipped, one data line per live event', () => {
    const r = new SseReader()
    const text = Buffer.from(`: hb\n\nevent: live\ndata: {"t":"héllo"}\n\nevent: other\ndata: x\n\nevent: live\ndata: a\ndata: b\n\n`)
    const got: (string | null)[] = []
    for (let i = 0; i < text.length; i += 7) { const g = r.push(text.subarray(i, i + 7)); expect(g).not.toBe('too-big'); got.push(...(g as (string | null)[])) }
    expect(got).toEqual(['{"t":"héllo"}', null])
  })

  it('an event past eventBytes as written is too big - a long line before its newline too', () => {
    const data = 'x'.repeat(LIVE_BOUNDS.eventBytes - 'event: live\n'.length - 'data: \n'.length - 1)
    expect(new SseReader().push(Buffer.from(`event: live\ndata: ${data}\n\n`))).toEqual([data])   // exactly at the budget
    expect(new SseReader().push(Buffer.from(`event: live\ndata: ${data}x\n\n`))).toBe('too-big')
    expect(new SseReader().push(Buffer.from(`data: ${'y'.repeat(LIVE_BOUNDS.eventBytes)}`))).toBe('too-big')
  })

  it('every field checked again: unknown fields stripped, an unknown kind dropped, a bad field refusing the event', () => {
    const ok = event('i', 3, { items: [{ ...item(1), extra: 'x' } as LiveItem, { ...item(2), kind: 'stopped' } as unknown as LiveItem, item(3, { kind: 'stalled', id: `stalled:${'a'.repeat(20)}`, batch: 'b', gen: 2, occ: 1, cards: ['c1'] })] })
    const p = parseLive({ ...ok, more: 1 })!
    expect(p.items.map((i) => i.id)).toEqual([item(1).id, `stalled:${'a'.repeat(20)}`])
    expect(p.items[0]).not.toHaveProperty('extra')
    expect(p).not.toHaveProperty('more')
    for (const bad of [
      { ...ok, v: 2 }, { ...ok, seq: -1 }, { ...ok, jam: 'maybe' }, { ...ok, cut: 1.5 }, { ...ok, counts: { ask: 1, review: 0, failed: 0 } },
      { ...ok, working: 'yes' }, { ...ok, items: Array.from({ length: 101 }, (_, i) => item(i)) },
      { ...ok, items: [item(1, { title: 'x'.repeat(141) })] }, { ...ok, items: [item(1, { title: 'a\nb' })] },
      { ...ok, items: [item(1, { id: 'ask:short' })] }, { ...ok, items: [item(1, { board: 'b'.repeat(129) })] },
      { ...ok, items: [item(1, { cards: Array.from({ length: 9 }, (_, i) => `c${i}`) })] }, { ...ok, items: [item(1, { gen: 1.5 })] },
      { ...ok, items: [item(1, { note: 'n'.repeat(141) })] }, { ...ok, items: ['ask'] },
    ]) expect(parseLive(bad), JSON.stringify(bad).slice(0, 80)).toBeNull()
  })

  it('spec 32 F2: work and titles are kept and bounded; either malformed is dropped alone, never the event', () => {
    const ok = event('i', 3, { items: [item(1)] })
    const titles = Object.fromEntries(Array.from({ length: LIVE_TITLES_MAX }, (_, i) => [`b${i}`, `Board ${i}`]))
    const p = parseLive({ ...ok, work: { board: 'tab-strip', since: 1700, extra: 1 }, titles })!
    expect(p.work).toEqual({ board: 'tab-strip', since: 1700 })
    expect(p.titles).toEqual(titles)
    expect(parseLive({ ...ok, work: { since: 5 } })!.work).toEqual({ since: 5 })
    for (const work of [{ board: 'x' }, { since: -1 }, { since: Number.NaN }, { since: 1, board: 'b'.repeat(129) }, { since: 1, board: 'a\nb' }, 'now', [1]]) {
      const q = parseLive({ ...ok, work })
      expect(q, JSON.stringify(work)).not.toBeNull()
      expect(q).not.toHaveProperty('work')
    }
    for (const t of [{ ...titles, extra: 'one too many' }, { b: 'x'.repeat(141) }, { b: 'a\nb' }, { ['k'.repeat(129)]: 'x' }, { '': 'x' }, { b: 1 }, ['x'], 'titles']) {
      const q = parseLive({ ...ok, titles: t })
      expect(q).not.toBeNull()
      expect(q).not.toHaveProperty('titles')
    }
    // a 0.31 canvas sends neither
    const old = parseLive(ok)!
    expect(old).not.toHaveProperty('work')
    expect(old).not.toHaveProperty('titles')
  })

  it('a stream is wanted only for a ready entry with an origin that lists live', () => {
    const e = { state: 'ready' as const, origin: 'http://127.0.0.1:1', features: ['bridge', 'live'] }
    expect(wantsLive(e)).toBe(true)
    expect(wantsLive({ ...e, state: 'starting' })).toBe(false)
    expect(wantsLive({ ...e, origin: null })).toBe(false)
    expect(wantsLive({ ...e, features: ['bridge', 'inset'] })).toBe(false)
  })

  it('the backoff: 1, 2, 4, 8, 16 s, then every 30 s, each with up to 20 % jitter', () => {
    T.liveBackoffMs = saved.backoff; T.liveBackoffMaxMs = saved.max
    expect([0, 1, 2, 3, 4, 5, 9].map((a) => backoffMs(a, 0))).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000])
    expect(backoffMs(0, 1)).toBe(1200)
    expect(backoffMs(5, 0.5)).toBe(33_000)
  })
})

describe('a stream (A4.6 #16)', () => {
  it('asks with the app\'s proof, a fresh nonce each time, and applies a signed snapshot sent in pieces, comments between', async () => {
    const c = await canvas()
    c.handle = (req, res) => {
      if (!sign(c, req, res)) return
      const text = `: hb\n\n${frame(event(c.entry.instance, 7, { items: [item(1, { title: 'Which logo – the round one?' })], unseen: 3, working: true }))}`
      const b = Buffer.from(text)
      let i = 0
      const step = () => { if (i < b.length) { res.write(b.subarray(i, i + 11)); i += 11; setTimeout(step, 1) } }
      step()
    }
    const { live, changes } = start(c)
    await until(() => live.held(c.entry.instance), (h) => !!h)
    expect(live.held(c.entry.instance)).toMatchObject({ ws: c.entry.ws, name: 'Pilot', stale: false, event: { seq: 7, unseen: 3, working: true, items: [{ title: 'Which logo – the round one?' }] } })
    expect(changes).toEqual([{ instance: c.entry.instance, why: 'applied' }])
    expect(c.reqs[0]).toMatchObject({ 'x-mv-ws': c.entry.ws, accept: 'text/event-stream' })
    expect(c.reqs[0]!['x-mv-nonce']).toMatch(/^[A-Za-z0-9_-]{32}$/)
    c.open[0]!.destroy()   // the canvas restarts: a reconnect, with a nonce of its own
    await until(() => c.reqs.length, (n) => n >= 2)
    expect(c.reqs[1]!['x-mv-nonce']).not.toBe(c.reqs[0]!['x-mv-nonce'])
  })

  it('on one connection: a seq that goes back, another instance and a malformed event are dropped and the stream kept', async () => {
    const c = await canvas()
    const inst = () => c.entry.instance
    c.handle = (req, res) => {
      if (!sign(c, req, res)) return
      res.write(frame(event(inst(), 5, { items: [item(1)] })))
      res.write(frame(event(inst(), 4, { items: [item(2)] })))           // back: dropped
      res.write(frame(event('someone-else', 6, { items: [item(3)] })))   // another instance: dropped
      res.write('event: live\ndata: {"v":1,\n\n')                          // malformed: dropped
      res.write(frame(event(inst(), 6, { items: [item(4)] })))
    }
    const { live, changes } = start(c)
    await until(() => live.held(inst())?.event.seq, (s) => s === 6)
    expect(live.held(inst())!.event.items.map((i) => i.title)).toEqual(['Question 4'])
    expect(changes.filter((x) => x.why === 'applied')).toHaveLength(2)
    expect(c.reqs).toHaveLength(1)
  })

  it('a new connection\'s first snapshot is applied whole, whatever its seq', async () => {
    const c = await canvas()
    c.handle = (req, res, n) => { if (sign(c, req, res)) res.write(frame(event(c.entry.instance, n === 1 ? 9 : 2, { unseen: n }))) }
    const { live } = start(c)
    await until(() => live.held(c.entry.instance), (h) => !!h)
    c.open[0]!.destroy()
    await until(() => live.held(c.entry.instance)?.event.seq, (s) => s === 2)
    expect(live.held(c.entry.instance)!.event.unseen).toBe(2)
  })

  it('an event past the byte budget drops the connection; the next one, after the backoff, is applied', async () => {
    const c = await canvas()
    c.handle = (req, res, n) => {
      if (!sign(c, req, res)) return
      if (n === 1) res.write(`event: live\ndata: ${'x'.repeat(LIVE_BOUNDS.eventBytes)}\n\n`)
      else res.write(frame(event(c.entry.instance, 1)))
    }
    const { live, logs } = start(c)
    await until(() => live.held(c.entry.instance), (h) => !!h)
    expect(logs.some((l) => l.tooBig)).toBe(true)
    expect(c.reqs).toHaveLength(2)
  })

  for (const [what, how] of [
    ['a proof signed with another key', (c: Canvas, req: IncomingMessage, res: ServerResponse) => sign(c, req, res, { key: randomBytes(32) })],
    ['another x-mv-instance', (c: Canvas, req: IncomingMessage, res: ServerResponse) => sign(c, req, res, { instance: randomUUID() })],
    ['no proof at all', (_c: Canvas, _req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); return true }],
    ['another type', (c: Canvas, req: IncomingMessage, res: ServerResponse) => sign(c, req, res, { type: 'text/plain' })],
    ['a 500', (_c: Canvas, _req: IncomingMessage, res: ServerResponse) => { res.writeHead(500); res.end(); return false }],
  ] as const) {
    it(`${what}: nothing applied, and asked again after the backoff`, async () => {
      const c = await canvas()
      c.handle = (req, res) => { if (how(c, req, res)) res.write(frame(event(c.entry.instance, 1, { items: [item(1)] }))) }
      const { live, changes } = start(c)
      await until(() => c.reqs.length, (n) => n >= 3)
      expect(live.held(c.entry.instance)).toBeUndefined()
      expect(changes).toEqual([])
    })
  }

  it('the backoff spaces the retries and resets once a connection delivered a valid snapshot', async () => {
    const c = await canvas()
    const at: number[] = []
    let good = false
    c.handle = (req, res) => {
      at.push(Date.now())
      if (!good) { res.writeHead(500); res.end(); return }
      if (sign(c, req, res)) { res.write(frame(event(c.entry.instance, at.length))); res.end() }   // a snapshot, then the end
    }
    const { live } = start(c)
    await until(() => at.length, (n) => n >= 4)
    const gaps = at.slice(1).map((t, i) => t - at[i]!)
    expect(gaps[0]).toBeGreaterThanOrEqual(35); expect(gaps[1]).toBeGreaterThanOrEqual(75); expect(gaps[2]).toBeGreaterThanOrEqual(150)
    expect(live.dump()[0]!.attempt).toBeGreaterThanOrEqual(3)
    good = true
    await until(() => live.held(c.entry.instance), (h) => !!h, 3000)
    // each connection delivered a snapshot: the backoff is back at its first step every time
    const n = at.length
    await until(() => at.length, (k) => k >= n + 2)
    expect(at.at(-1)! - at.at(-2)!).toBeLessThan(150)
  })

  it('idle: no byte for liveIdleMs aborts and reconnects; the held snapshot goes stale, and fresh again', async () => {
    const c = await canvas()
    c.handle = (req, res, n) => { if (sign(c, req, res) && n === 1) res.write(frame(event(c.entry.instance, 1, { items: [item(1)] }))) }
    const { live, changes } = start(c)
    await until(() => live.held(c.entry.instance), (h) => !!h)
    await until(() => c.reqs.length, (k) => k >= 2, 1500)
    // a proved connection again, but the stream has been down to the snapshot: never zero, never dropped
    await until(() => live.held(c.entry.instance)?.stale, (s) => s === true, 1500)
    expect(live.held(c.entry.instance)!.event.items).toHaveLength(1)
    expect(changes.map((x) => x.why)).toContain('stale')
    c.handle = (req, res) => { if (sign(c, req, res)) res.write(frame(event(c.entry.instance, 2))) }
    await until(() => live.held(c.entry.instance)?.stale, (s) => s === false, 2000)
    expect(changes.map((x) => x.why)).toContain('applied')
  })

  for (const status of [403, 404, 405, 409]) {
    it(`a ${status} stops the stream until the instance changes - asked once, never stormed`, async () => {
      const c = await canvas()
      c.handle = (_req, res) => { res.writeHead(status); res.end() }
      const { live } = start(c)
      await until(() => c.reqs.length, (n) => n >= 1)
      await wait(400)
      expect(c.reqs).toHaveLength(1)
      expect(live.dump()[0]).toMatchObject({ refused: status })
      live.resume()   // the Mac woke: still not asked
      live.onRegistry({ kind: 'entry', entry: { ...c.entry } })   // the same instance read again
      await wait(100)
      expect(c.reqs).toHaveLength(1)
      // the canvas restarted in its slot: a new instance, asked again
      c.handle = (req, res) => { if (sign(c, req, res)) res.write(frame(event(c.entry.instance, 1))) }
      c.entry = { ...c.entry, instance: randomUUID() }
      live.onRegistry({ kind: 'entry', entry: c.entry })
      await until(() => live.held(c.entry.instance), (h) => !!h)
      expect(c.reqs).toHaveLength(2)
    })
  }

  it('gone drops the snapshot and ends the stream; a re-read with the same instance keeps it', async () => {
    const c = await canvas()
    c.handle = (req, res) => { if (sign(c, req, res)) res.write(frame(event(c.entry.instance, 1, { items: [item(1)] }))) }
    const { live, changes } = start(c)
    await until(() => live.held(c.entry.instance), (h) => !!h)
    live.onRegistry({ kind: 'entry', entry: { ...c.entry, name: 'Pilot renamed' } })
    await wait(80)
    expect(c.reqs).toHaveLength(1)
    expect(live.held(c.entry.instance)!.name).toBe('Pilot renamed')
    live.onRegistry({ kind: 'gone', file: c.entry.file, instance: c.entry.instance, why: 'pid' })
    expect(live.held(c.entry.instance)).toBeUndefined()
    expect(changes.at(-1)).toEqual({ instance: c.entry.instance, why: 'dropped' })
    await wait(200)
    expect(c.reqs).toHaveLength(1)
    expect(live.dump()).toEqual([])
  })

  it('only a ready entry with an origin that lists live gets a stream', async () => {
    for (const o of [{ features: ['bridge', 'inset'] }, { state: 'starting' as const }]) {
      const c = await canvas(o)
      start(c)
      await wait(100)
      expect(c.reqs, JSON.stringify(o)).toHaveLength(0)
    }
  })

  it('another instance in the same slot file: the old stream ends before the new one opens', async () => {
    const c = await canvas()
    c.handle = (req, res) => { if (sign(c, req, res)) res.write(frame(event(c.entry.instance, 1))) }
    const { live } = start(c)
    await until(() => live.held(c.entry.instance), (h) => !!h)
    const old = c.entry.instance
    c.entry = { ...c.entry, instance: randomUUID() }
    live.onRegistry({ kind: 'entry', entry: c.entry })
    expect(live.held(old)).toBeUndefined()
    await until(() => live.held(c.entry.instance), (h) => !!h)
    expect(live.dump().map((d) => d.instance)).toEqual([c.entry.instance])
  })
})

describe('generations (A4.6 r1 #7)', () => {
  /** A fetch whose bodies the case writes into: each call's controller, its request's nonce and abort. */
  function scripted(c: Canvas) {
    const calls: { nonce: string; push(s: string): void; end(): void; error(): void; aborted: boolean }[] = []
    const f = (async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      let ctl!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({ start(x) { ctl = x } })
      const call = {
        nonce: headers['x-mv-nonce']!, aborted: false,
        push: (s: string) => { try { ctl.enqueue(new TextEncoder().encode(s)) } catch { /* closed */ } },
        end: () => { try { ctl.close() } catch { /* closed */ } },
        error: () => { try { ctl.error(new Error('reset')) } catch { /* closed */ } },
      }
      init.signal?.addEventListener('abort', () => { call.aborted = true })
      calls.push(call)
      const e = c.entry
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-mv-instance': e.instance, 'x-mv-proof': liveProof(e.key, call.nonce, e.port) } })
    }) as unknown as typeof fetch
    return { f, calls }
  }

  it('an old connection\'s buffered event, its end and its error, after a replacement, apply nothing, mark nothing stale and schedule nothing', async () => {
    const c = await canvas()
    const s = scripted(c)
    const { live, changes } = start(c, { fetch: s.f })
    await until(() => s.calls.length, (n) => n === 1)
    s.calls[0]!.push(frame(event(c.entry.instance, 1, { unseen: 1 })))
    await until(() => live.held(c.entry.instance)?.event.unseen, (u) => u === 1)
    live.resume()   // the Mac woke: a new connection
    await until(() => s.calls.length, (n) => n === 2)
    expect(s.calls[0]!.aborted).toBe(true)
    s.calls[1]!.push(frame(event(c.entry.instance, 1, { unseen: 2 })))
    await until(() => live.held(c.entry.instance)?.event.unseen, (u) => u === 2)
    const before = changes.length
    // what the old connection had read, and its finalisers, run now
    s.calls[0]!.push(frame(event(c.entry.instance, 9, { unseen: 99 })))
    s.calls[0]!.end()
    s.calls[0]!.error()
    await wait(T.liveBackoffMs[0]! * 3)
    expect(live.held(c.entry.instance)!.event.unseen).toBe(2)
    expect(changes.length).toBe(before)
    expect(s.calls).toHaveLength(2)
    expect(live.dump()[0]).toMatchObject({ attempt: 0, stale: false })
  })

  it('its idle timer after a replacement does nothing: the current connection stays open', async () => {
    T.liveIdleMs = 150
    const c = await canvas()
    const s = scripted(c)
    const { live } = start(c, { fetch: s.f })
    await until(() => s.calls.length, (n) => n === 1)
    s.calls[0]!.push(frame(event(c.entry.instance, 1)))
    live.resume()
    await until(() => s.calls.length, (n) => n === 2)
    // the current connection hears a heartbeat every 50 ms; the old one's idle timer would have fired by now
    for (let i = 0; i < 6; i++) { s.calls[1]!.push(': hb\n\n'); await wait(50) }
    expect(s.calls).toHaveLength(2)
    expect(s.calls[1]!.aborted).toBe(false)
  })
})
