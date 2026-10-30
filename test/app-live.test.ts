import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLiveHub, encodeLive, liveChanged, liveId, liveRoute, liveSnapshot, oneLine, type LiveBody, type LiveClient, type LiveInput } from '../src/server/app-live.ts'
import { appProof, docProof, liveProof, logoProof, type DocProof } from '../src/server/proof.ts'
import { LIVE_BOUNDS, LIVE_WIRE, type LiveEvent, type LiveItem } from '../src/shared/app-api.ts'
import type { Thread } from '../src/shared/events.ts'
import type { QueueView } from '../src/server/jam/live.ts'

/**
 * The live stream's package half (spec 28 A4.6 #4-#14, r1 #1, #4, r2 #3; the unit cases of #52): the selector - one item
 * per need, ids that name the occurrence and nothing else, exact counts past the cap -, the encoder's byte budget, the
 * hub's debounce, seq, clients, backpressure, heartbeat and close, the route's refusals and its proof, and the hooks
 * beside every broadcast the stream reads.
 */

type Card = QueueView['cards'][number]
let t0 = 1_000_000
const reply = (id: string, o: Partial<Thread['replies'][number]> = {}): Thread['replies'][number] => ({ id, ts: ++t0, body: 'ok', ...o })
const thread = (id: string, o: Partial<Thread> = {}): Thread => ({ id, ts: ++t0, resolved: false, replies: [], reactions: {}, body: `root of ${id}`, frame: 'demo/one', ...o })
/** a thread you started where Marver's last word asks (`asks: true`) */
const asking = (id: string, o: Partial<Thread> = {}, r: Partial<Thread['replies'][number]> = {}) => thread(id, { replies: [reply(`${id}-r1`, { agent: true, asks: true, body: 'Which one?', ...r })], ...o })
const card = (id: string, o: Partial<Card> = {}): Card => ({ id, kind: 'capture', board: 'home', frames: ['demo/one'], events: [], state: 'queued', rev: 1, made: ++t0, order: t0, at: t0, title: `Capture ${id}`, ...o })
const input = (o: { threads?: Thread[]; cards?: Card[]; jam?: false; cli?: string[]; fresh?: string[]; session?: boolean } = {}): LiveInput => ({
  boards: [{ board: 'home', threads: o.threads ?? [] }],
  fresh: o.fresh ?? [],
  ...(o.jam === false ? {} : { jam: { agent: 'claude', cards: o.cards ?? [], ...(o.session ? { session: { id: 's1', since: 1 } } : {}) } }),
  cli: o.cli ?? [],
})
const ids = (b: LiveBody) => b.items.map((i) => i.id)
const one = (b: LiveBody) => { expect(b.items).toHaveLength(1); return b.items[0] }

describe('the selector: what waits on the owner (A4.6 #7, #8, #10)', () => {
  it('an ask by `asks: true` and by the old rule (a reply ending in "?", a Marver note); its id matches the pattern', () => {
    const flagged = one(liveSnapshot(input({ threads: [asking('t1')] })))
    expect(flagged).toMatchObject({ kind: 'ask', board: 'home', thread: 't1', msg: 't1-r1', frame: 'demo/one', title: 'Which one?' })
    expect(flagged.id).toMatch(LIVE_BOUNDS.id)
    expect(flagged.id).toBe(liveId('ask', 'home', 't1', 't1-r1'))
    // written before 0.25 (no `asks`): a reply asks when it ends in "?", a note always
    expect(one(liveSnapshot(input({ threads: [thread('t2', { replies: [reply('r', { agent: true, body: 'Blue or green? ' })] })] }))).msg).toBe('r')
    expect(one(liveSnapshot(input({ threads: [thread('t3', { agent: true, body: 'A note from Marver' })] }))).msg).toBe('t3')
  })

  it('answered, resolved and plain replies give nothing; nor a thread Marver never spoke in', () => {
    const answered = thread('a', { replies: [reply('a1', { agent: true, asks: true }), reply('a2', { body: 'the blue one' })] })
    const resolved = asking('b', { resolved: true })
    const plain = thread('c', { replies: [reply('c1', { agent: true, asks: false, body: 'Done?' })] })
    const human = thread('d', { body: 'what about this?', replies: [reply('d1', { body: 'and this?' })] })
    expect(liveSnapshot(input({ threads: [answered, resolved, plain, human] })).items).toEqual([])
  })

  it('a frameless ask counts (a Jam request with no frame can ask since rc3)', () => {
    const i = one(liveSnapshot(input({ threads: [asking('t', { frame: undefined })] })))
    expect([i.kind, i.frame, i.thread]).toEqual(['ask', undefined, 't'])
  })

  it('a Jam `asks` card and its thread are one question: one item, the card as its way in', () => {
    const b = liveSnapshot(input({ threads: [asking('t1')], cards: [card('c1', { kind: 'comment', thread: 't1', state: 'asks' }), card('c2', { thread: 'other', state: 'asks' })] }))
    expect(b.counts).toEqual({ ask: 1, review: 0, failed: 0, stalled: 0 })
    expect(one(b)).toMatchObject({ kind: 'ask', thread: 't1', cards: ['c1'] })
  })

  it('a re-ask - a later Marver question in the thread - is a new id; an early answer edited to ask is an item under its message', () => {
    const first = asking('t')
    const again = thread('t', { ts: first.ts, replies: [...first.replies, reply('t-r2', { body: 'yes' }), reply('t-r3', { agent: true, asks: true, body: 'And the size?' })] })
    expect(one(liveSnapshot(input({ threads: [again] }))).id).not.toBe(one(liveSnapshot(input({ threads: [first] }))).id)
    const early = thread('e', { replies: [reply('e-r1', { agent: true, asks: true, body: 'Working on it - which?' })] })
    expect(one(liveSnapshot(input({ threads: [early] }))).msg).toBe('e-r1')
  })

  it('a review: a new id after More work (att 2); a rename, a rev or an at change keeps it; it carries occ', () => {
    const r = card('c1', { state: 'review', batch: 'b1', att: 1 })
    const a = one(liveSnapshot(input({ cards: [r] })))
    expect(a).toMatchObject({ kind: 'review', cards: ['c1'], batch: 'b1', occ: 1, title: 'Capture c1' })
    expect(one(liveSnapshot(input({ cards: [{ ...r, title: 'Renamed', rev: 9, at: r.at + 5000 }] }))).id).toBe(a.id)
    expect(one(liveSnapshot(input({ cards: [{ ...r, att: 2, batch: 'b2' }] }))).id).not.toBe(a.id)
  })

  it('retry and fail: a rerun failing again (a new batch) and a redelivery failing again (failures + 1) are new ids', () => {
    const f = card('c1', { kind: 'comment', thread: 't1', state: 'failed', batch: 'b1', fails: 1, att: 1, note: 'the agent could not finish' })
    const first = one(liveSnapshot(input({ threads: [thread('t1', { body: 'make it blue' })], cards: [f] })))
    expect(first).toMatchObject({ kind: 'failed', batch: 'b1', occ: 1, cards: ['c1'], thread: 't1', title: 'make it blue', note: 'the agent could not finish' })
    expect(one(liveSnapshot(input({ cards: [{ ...f, batch: 'b2', att: 2 }] }))).id).not.toBe(first.id)
    expect(one(liveSnapshot(input({ cards: [{ ...f, fails: 2, att: 2 }] }))).id).not.toBe(first.id)
    // a card refused before it ran (no run counted): its own item, by its card and attempts
    const refused = one(liveSnapshot(input({ cards: [card('c9', { state: 'failed', att: 1 })] })))
    expect([refused.id, refused.batch, refused.occ]).toEqual([liveId('failed', 'c9', 1), undefined, 1])
  })

  it('a multi-card failed batch is one item listing its cards; counts count items, not cards', () => {
    const b = liveSnapshot(input({ cards: [card('c1', { state: 'failed', batch: 'b1', fails: 3 }), card('c2', { state: 'failed', batch: 'b1', fails: 3 }), card('c3', { state: 'failed', batch: 'b1', fails: 3 })] }))
    expect(one(b)).toMatchObject({ kind: 'failed', cards: ['c1', 'c2', 'c3'], batch: 'b1', occ: 3, title: 'Capture c1' })
    expect(b.counts.failed).toBe(1)
  })

  it('progress and a re-stall (stalled, Give it back, stalled again) give a new id under the same gen', () => {
    const run = (stalls: number, state: 'stalled' | 'claimed' = 'stalled') => card('c1', { state: 'working', batch: 'b1', runner: { kind: 'session', agent: 'claude', batch: 'b1', gen: 4, state, stalls } })
    const first = one(liveSnapshot(input({ cards: [run(1)] })))
    expect(first).toMatchObject({ kind: 'stalled', batch: 'b1', gen: 4, occ: 1, cards: ['c1'] })
    expect(liveSnapshot(input({ cards: [run(1, 'claimed')] })).items).toEqual([])   // given back: at work again
    expect(one(liveSnapshot(input({ cards: [run(2)] }))).id).not.toBe(first.id)
  })

  it('draft, confirming, queued, Waits for, offered, claimed, waiting, stopping, done and kept give nothing', () => {
    const r = (state: 'offered' | 'claimed' | 'waiting' | 'stopping') => ({ kind: 'session' as const, agent: 'claude', batch: 'b', gen: 1, state })
    const b = liveSnapshot(input({ cards: [
      card('a', { state: 'draft' }), card('b', { state: 'confirming' }), card('c', { state: 'queued', position: 1 }),
      card('d', { state: 'queued', waitsFor: { frame: 'demo/one', by: 'chat' } }), card('e', { state: 'working', runner: r('offered') }),
      card('f', { state: 'working', runner: r('claimed') }), card('g', { state: 'working', runner: r('waiting') }),
      card('h', { state: 'working', runner: r('stopping') }), card('i', { state: 'done' }), card('j', { state: 'kept' }),
    ] }))
    expect([b.items, b.counts]).toEqual([[], { ask: 0, review: 0, failed: 0, stalled: 0 }])
  })

  it('working: a `marver work` lease alone, a background or claimed run alone - never a stalled, offered, waiting or stopping one (r2 #3)', () => {
    expect(liveSnapshot(input({ cli: ['demo/one'] })).working).toBe(true)
    expect(liveSnapshot(input({ cards: [card('a', { kind: 'comment', frames: [], state: 'working' })] })).working).toBe(true)
    expect(liveSnapshot(input({ cards: [card('a', { state: 'working', runner: { kind: 'fresh', agent: 'claude', batch: 'b' } })] })).working).toBe(true)
    for (const state of ['stalled', 'offered', 'waiting', 'stopping'] as const)
      expect(liveSnapshot(input({ cards: [card('a', { state: 'working', runner: { kind: 'session', agent: 'claude', batch: 'b', gen: 1, state } })] })).working).toBe(false)
    expect(liveSnapshot(input({ cards: [card('a', { state: 'working', runner: { kind: 'session', agent: 'claude', batch: 'b', gen: 1, state: 'claimed' } })] })).working).toBe(true)
    expect(liveSnapshot(input()).working).toBe(false)
  })

  it('Jam off: `jam: off`, asks from the threads still, no Jam card as their way in; session and unseen as said', () => {
    const b = liveSnapshot(input({ jam: false, threads: [asking('t')], fresh: ['demo/one', 'demo/two'] }))
    expect(b).toMatchObject({ jam: 'off', counts: { ask: 1 }, unseen: 2, session: false })
    expect(b.items[0].cards).toBeUndefined()
    expect(liveSnapshot(input({ session: true })).session).toBe(true)
  })

  it('130 asks give 100 items, newest first, `cut` 30 and `counts.ask` 130; a ref past 128 is counted, never sent, never cut', () => {
    const threads = Array.from({ length: 130 }, (_, i) => asking(`t${i}`))
    const b = liveSnapshot(input({ threads }))
    expect([b.items.length, b.cut, b.counts.ask]).toEqual([100, 30, 130])
    expect(b.items[0].thread).toBe('t129')
    expect(b.items.every((x, i, a) => i === 0 || a[i - 1].at >= x.at)).toBe(true)
    const long = liveSnapshot(input({ threads: [asking('x'.repeat(129)), asking('ok')] }))
    expect([long.items.map((i) => i.thread), long.cut, long.counts.ask]).toEqual([['ok'], 0, 2])
  })

  it('the same input twice gives byte-identical snapshots', () => {
    const make = () => input({ threads: [asking('t1'), asking('t2')], cards: [card('c', { state: 'review', att: 1 }), card('d', { state: 'failed', batch: 'b', fails: 1 })], fresh: ['demo/one'] })
    t0 = 5_000_000
    const a = JSON.stringify(liveSnapshot(make()))
    t0 = 5_000_000
    expect(JSON.stringify(liveSnapshot(make()))).toBe(a)
  })

  it('titles: one line, no control characters, at most 140 UTF-16 units, never cut inside a pair', () => {
    expect(oneLine('  Which\n\tone?\u0007  ')).toBe('Which one?')
    expect(oneLine('a'.repeat(200))).toHaveLength(140)
    const cut = oneLine('a'.repeat(139) + '😀😀')
    expect([cut.length, cut]).toEqual([139, 'a'.repeat(139)])
    const t = one(liveSnapshot(input({ threads: [asking('t', {}, { body: 'x'.repeat(300) })] }))).title
    expect(t).toHaveLength(140)
  })
})

describe('the encoder: every event inside its byte budget (A4.6 #11, r1 #4)', () => {
  const ref = (c: string) => c.repeat(LIVE_BOUNDS.ref)
  const big = (n: number): LiveItem => ({
    id: liveId('failed', String(n)), kind: 'failed', board: ref('b'), title: ['€', '😀', '"', '\\'][n % 4].repeat(n % 4 === 1 ? 70 : 140),
    note: '€'.repeat(140), at: 10_000 - n, frame: ref('f'), thread: ref('t'), msg: ref('m'), cards: Array.from({ length: 8 }, (_, i) => `${i}`.repeat(LIVE_BOUNDS.ref)),
    batch: ref('x'), gen: 2 ** 31, occ: 2 ** 31,
  })
  const event = (items: LiveItem[], cut = 0): LiveEvent => ({ v: 1, instance: '00000000-0000-4000-8000-000000000000', seq: 2 ** 31, jam: 'on', items, cut,
    counts: { ask: 0, review: 0, failed: items.length + cut, stalled: 0 }, unseen: 1e6, working: true, session: true })
  const parse = (text: string): LiveEvent => {
    const lines = text.split('\n')
    expect([lines[0], lines.length, lines[2], lines[3]]).toEqual([`event: ${LIVE_WIRE.event}`, 4, '', ''])
    return JSON.parse(lines[1].slice('data: '.length)) as LiveEvent
  }

  it('one item at every bound is under 3 KB, an event with no items under 300 bytes', () => {
    expect(Buffer.byteLength(JSON.stringify(big(0)))).toBeLessThan(3072)
    expect(Buffer.byteLength(JSON.stringify(big(1)))).toBeLessThan(3072)
    expect(Buffer.byteLength(encodeLive(event([])))).toBeLessThan(300)
  })

  it('100 items at every bound - three- and four-byte characters, " and \\ - come out under 64 KiB, parseable, newest kept, counts exact, cut right', () => {
    const items = Array.from({ length: 100 }, (_, i) => big(i))
    const text = encodeLive(event(items, 30))
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LIVE_BOUNDS.eventBytes)
    const e = parse(text)
    expect(e.items.length).toBeGreaterThanOrEqual(20)
    expect(e.items).toEqual(items.slice(0, e.items.length))
    expect(e.cut).toBe(30 + 100 - e.items.length)
    expect(e.counts.failed).toBe(130)
    // and one more item would not have fitted
    const more = e.items.length + 1
    expect(Buffer.byteLength(`event: live\ndata: ${JSON.stringify({ ...event(items.slice(0, more), 30 + 100 - more), counts: e.counts })}\n\n`)).toBeGreaterThan(LIVE_BOUNDS.eventBytes)
  })

  it('an event that fits is written as it is', () => {
    const e = event([big(0)])
    expect(encodeLive(e)).toBe(`event: live\ndata: ${JSON.stringify(e)}\n\n`)
  })
})

/** A response stand-in: what the hub writes, ends and destroys. */
function client(o: { slow?: boolean } = {}) {
  const handlers: Record<string, (() => void)[]> = {}
  const c = {
    chunks: [] as string[], ended: false, destroyed: false, writableLength: o.slow ? LIVE_WIRE.slowBytes + 1 : 0,
    write(s: string) { c.chunks.push(s); return true },
    end() { c.ended = true; for (const f of handlers.close ?? []) f(); return c },
    destroy() { c.destroyed = true; for (const f of handlers.close ?? []) f(); return c },
    on(ev: string, fn: () => void) { (handlers[ev] ??= []).push(fn); return c },
    events: () => c.chunks.filter((x) => x.startsWith('event:')).map((x) => JSON.parse(x.split('\n')[1].slice(6)) as LiveEvent),
    beats: () => c.chunks.filter((x) => x === `${LIVE_WIRE.heartbeat}\n\n`).length,
  }
  return c as typeof c & LiveClient
}

describe('the hub (A4.6 #14)', () => {
  afterEach(() => { vi.useRealTimers() })
  const body = (o: Partial<LiveBody> = {}): LiveBody => ({ jam: 'on', items: [], cut: 0, counts: { ask: 0, review: 0, failed: 0, stalled: 0 }, unseen: 0, working: false, session: false, ...o })

  it('no client, no work: changed() reads nothing; a client gets the snapshot at once, seq from the counter', () => {
    const read = vi.fn(() => body())
    const hub = createLiveHub({ instance: 'i', read, seq: { n: 0 } })
    hub.changed(); hub.changed()
    expect(read).not.toHaveBeenCalled()
    const a = client()
    hub.add(a)
    expect(a.events()).toEqual([{ v: 1, instance: 'i', seq: 1, ...body() }])
    hub.close()
  })

  it('debounced: trailing 150 ms, at most 1 s; an unchanged recompute writes nothing; a change goes out seq one higher', () => {
    vi.useFakeTimers()
    let now = body()
    const read = vi.fn(() => now)
    const hub = createLiveHub({ instance: 'i', read, seq: { n: 0 } })
    const a = client()
    hub.add(a)
    read.mockClear()
    hub.changed()
    vi.advanceTimersByTime(149)
    expect(read).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(a.events()).toHaveLength(1)   // unchanged: nothing written
    // a change every 100 ms: the trailing edge never comes, the 1 s cap does
    now = body({ unseen: 1 })
    for (let t = 0; t < 1000; t += 100) { hub.changed(); vi.advanceTimersByTime(100) }
    expect(a.events().map((e) => [e.seq, e.unseen])).toEqual([[1, 0], [2, 1]])
    hub.close()
  })

  it('a late client gets the snapshot alone when nothing changed; a changed one goes to everyone', () => {
    let now = body()
    const hub = createLiveHub({ instance: 'i', read: () => now, seq: { n: 0 } })
    const a = client(), b = client()
    hub.add(a); hub.add(b)
    expect([a.events().length, b.events().map((e) => e.seq)]).toEqual([1, [1]])
    now = body({ working: true })
    const c = client()
    hub.add(c)
    expect([a, b, c].map((x) => x.events().at(-1)!.seq)).toEqual([2, 2, 2])
    hub.close()
  })

  it('one seq for every hub of the process: it keeps rising across a restart (a new hub)', () => {
    const seq = { n: 0 }
    const one = createLiveHub({ instance: 'i', read: () => body(), seq })
    const a = client()
    one.add(a)
    one.close()
    expect(a.ended).toBe(true)
    const two = createLiveHub({ instance: 'i', read: () => body(), seq })
    const b = client()
    two.add(b)
    expect([a.events()[0].seq, b.events()[0].seq]).toEqual([1, 2])
    two.close()
  })

  it('a fifth client ends the oldest; a slow one (64 KiB unsent) is destroyed before the next write', () => {
    let now = body()
    const hub = createLiveHub({ instance: 'i', read: () => now, seq: { n: 0 } })
    const cs = Array.from({ length: 5 }, () => client())
    for (const c of cs) hub.add(c)
    expect([cs[0].ended, cs.slice(1).some((c) => c.ended), hub.clients()]).toEqual([true, false, 4])
    const slow = cs[1] as ReturnType<typeof client>
    slow.writableLength = LIVE_WIRE.slowBytes + 1
    now = body({ unseen: 3 })
    hub.push()
    expect([slow.destroyed, slow.events().length, hub.clients()]).toEqual([true, 1, 3])
    expect(cs[2].events().at(-1)!.unseen).toBe(3)
    hub.close()
  })

  it('a heartbeat every 30 s while a client listens, recomputing as a backstop; close() ends every client and leaves no timer', () => {
    vi.useFakeTimers()
    let now = body()
    const off = vi.fn()
    let poke = () => {}
    const hub = createLiveHub({ instance: 'i', read: () => now, seq: { n: 0 }, on: (fn) => { poke = fn; return off } })
    const a = client()
    hub.add(a)
    now = body({ session: true })   // a change no hook told the hub of
    vi.advanceTimersByTime(LIVE_WIRE.heartbeatMs)
    expect([a.beats(), a.events().at(-1)!.session]).toEqual([1, true])
    // the subscription pokes it like any hook
    now = body({ session: true, working: true })
    poke()
    vi.advanceTimersByTime(150)
    expect(a.events().at(-1)!.working).toBe(true)
    hub.close()
    expect([a.ended, off.mock.calls.length, vi.getTimerCount()]).toEqual([true, 1, 0])
  })

  it('liveChanged() pokes every open hub, and no closed one', () => {
    vi.useFakeTimers()
    const reads = [0, 0]
    const hubs = [0, 1].map((n) => createLiveHub({ instance: 'i', read: () => { reads[n]++; return body() }, seq: { n: 0 } }))
    hubs.forEach((h) => h.add(client()))
    hubs[1].close()
    liveChanged()
    vi.advanceTimersByTime(150)
    expect(reads).toEqual([2, 1])
    hubs[0].close()
  })

  it('the last client gone, its timers stop; drop() ends every client and keeps the snapshot and seq', () => {
    vi.useFakeTimers()
    const hub = createLiveHub({ instance: 'i', read: () => body(), seq: { n: 0 } })
    const a = client()
    hub.add(a)
    a.end()
    expect([hub.clients(), vi.getTimerCount()]).toEqual([0, 0])
    const b = client()
    hub.add(b)
    hub.drop()
    expect([b.destroyed, hub.clients(), vi.getTimerCount()]).toEqual([true, 0, 0])
    const c = client()
    hub.add(c)
    expect(c.events()[0].seq).toBe(1)
    hub.close()
  })
})

describe('the route (A4.6 #5, #6)', () => {
  const servers: Server[] = []
  afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => { s.closeAllConnections(); s.close(r) }) })
  const key = randomBytes(32)
  const nonce = 'n'.repeat(32)

  async function serve(withHub = true) {
    const read = vi.fn((): LiveBody => ({ jam: 'off', items: [], cut: 0, counts: { ask: 0, review: 0, failed: 0, stalled: 0 }, unseen: 0, working: false, session: false }))
    const s = createServer()
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const port = (s.address() as { port: number }).port
    const proof: DocProof = { instance: 'the-instance', key, port }
    const hub = withHub ? createLiveHub({ instance: proof.instance, read, seq: { n: 0 } }) : null
    s.on('request', (req, res) => liveRoute(hub, withHub ? proof : undefined)(req, res, () => { res.writeHead(418); res.end() }))
    s.on('close', () => hub?.close())
    const ask = (o: { app?: string | null; nonce?: string | null; method?: string; path?: string } = {}) => {
      const headers: Record<string, string> = {}
      if (o.app !== null) headers['x-mv-app'] = o.app ?? appProof(key, port)
      if (o.nonce !== null) headers['x-mv-nonce'] = o.nonce ?? nonce
      return fetch(`http://127.0.0.1:${port}${o.path ?? LIVE_WIRE.path}`, { method: o.method ?? 'GET', headers })
    }
    return { port, read, hub, ask }
  }

  it('403 without the app proof, or with another port\'s or key\'s, before anything is read; 400 without a well-formed nonce; 405 another method', async () => {
    const s = await serve()
    for (const app of [null, appProof(key, s.port + 1), appProof(randomBytes(32), s.port), liveProof(key, nonce, s.port)]) {
      const r = await s.ask({ app })
      expect([r.status, r.headers.get('x-mv-proof'), await r.text()]).toEqual([403, null, '403'])
    }
    expect((await s.ask({ nonce: null })).status).toBe(400)
    expect((await s.ask({ nonce: 'short' })).status).toBe(400)
    expect((await s.ask({ method: 'POST' })).status).toBe(405)
    expect(s.read).not.toHaveBeenCalled()
    expect((await s.ask({ path: '/other' })).status).toBe(418)   // not its path: the next middleware
  })

  it('404 with no slot (no hub, no proof): an older canvas, a test server, a build', async () => {
    const s = await serve(false)
    expect((await s.ask()).status).toBe(404)
  })

  it('the 200: an event stream signed with liveProof over the nonce - neither the document\'s nor the logo\'s - and the snapshot at once', async () => {
    const s = await serve()
    const r = await s.ask()
    expect(r.status).toBe(200)
    expect(Object.fromEntries(['content-type', 'cache-control', 'x-content-type-options', 'x-mv-instance'].map((h) => [h, r.headers.get(h)])))
      .toEqual({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-mv-instance': 'the-instance' })
    const proof = r.headers.get('x-mv-proof')
    expect(proof).toBe(liveProof(key, nonce, s.port))
    expect([docProof(key, nonce, s.port), logoProof(key, nonce, s.port)]).not.toContain(proof)
    const reader = r.body!.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toMatch(/^event: live\ndata: \{"v":1,"instance":"the-instance","seq":1,"jam":"off"/)
    expect(s.hub!.clients()).toBe(1)
    await reader.cancel()
    await expect.poll(() => s.hub!.clients()).toBe(0)
  })
})

describe('the hooks: every broadcast of state the stream reads recomputes it (A4.6 #13)', () => {
  const READ = new Set(['sh:marks', 'sh:manifest', 'sh:jam-comment', 'sh:jam-queue', '(notify)'])
  // not read: invalidations, scene titles, the board list and files, and the working set (the hub subscribes to workActivity)
  const NOT_READ = new Set(['sh:frame-invalidated', 'sh:scenes', 'sh:boards', 'sh:board', 'sh:jam-activity'])
  it('each ws.send in plugin.ts and dev.ts is listed, and the ones the stream reads call liveChanged() beside it', () => {
    const seen: string[] = []
    for (const f of ['plugin.ts', 'dev.ts']) {
      for (const line of readFileSync(join(import.meta.dirname, '..', 'src', 'server', f), 'utf8').split('\n')) {
        if (!/ws\.send\(/.test(line)) continue
        const name = /ws\.send\('([\w:-]+)'/.exec(line)?.[1] ?? (/ws\.send\(event\b/.test(line) ? '(notify)' : '?')
        seen.push(name)
        expect(READ.has(name) || NOT_READ.has(name), `${f}: ${name} - is it state the live stream reads?`).toBe(true)
        if (READ.has(name)) expect(line, `${f}: ${name}`).toContain('liveChanged()')
      }
    }
    expect(new Set(seen)).toEqual(new Set([...READ, ...NOT_READ]))
  })
})

describe('the adapters\' cost (A4.6 #14): a recompute re-reads nothing unchanged', () => {
  it('a 5 MB log is read once; each recompute after is under 20 ms; an append re-reads that log alone', async () => {
    const { liveSources } = await import('../src/server/plugin.ts')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-live-cost-')))
    try {
      const dir = join(root, 'design', 'comments')
      mkdirSync(dir, { recursive: true })
      const lines: string[] = []
      let ts = 1
      for (let t = 0; lines.join('\n').length < 5_000_000 && t < 100_000; t++) {
        lines.push(JSON.stringify({ id: `c${t}`, ts: ts++, type: 'create', commentId: `t${t}`, board: 'big', frame: 'demo/one', body: 'x'.repeat(120) }))
        for (let r = 0; r < 9; r++) lines.push(JSON.stringify({ id: `r${t}-${r}`, ts: ts++, type: 'reply', commentId: `r${t}-${r}`, parentId: `t${t}`, board: 'big', agent: r === 8, asks: r === 8, body: 'y'.repeat(300) }))
      }
      writeFileSync(join(dir, 'big.jsonl'), lines.join('\n') + '\n')
      writeFileSync(join(dir, 'small.jsonl'), JSON.stringify({ id: 's', ts: 1, type: 'create', commentId: 's', board: 'small', body: 'hi' }) + '\n')
      const src = liveSources(root)
      const frames = [{ id: 'demo/one', file: 'design/scenes/demo/one.tsx', kind: 'tsx' as const }]
      const first = liveSnapshot(src.read(frames))
      expect([src.reads(), first.counts.ask > 1000]).toEqual([2, true])
      const times: number[] = []
      for (let i = 0; i < 5; i++) { const t = performance.now(); liveSnapshot(src.read(frames)); times.push(performance.now() - t) }
      expect(src.reads()).toBe(2)
      expect(Math.min(...times)).toBeLessThan(20)
      writeFileSync(join(dir, 'small.jsonl'), readFileSync(join(dir, 'small.jsonl'), 'utf8') + JSON.stringify({ id: 's2', ts: 2, type: 'reply', commentId: 's2', parentId: 's', board: 'small', agent: true, asks: true, body: 'Which?' }) + '\n')
      const after = liveSnapshot(src.read(frames))
      expect([src.reads(), after.counts.ask - first.counts.ask]).toEqual([3, 1])
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 60_000)
})
