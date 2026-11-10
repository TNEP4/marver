import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLiveHub, encodeLive, liveSnapshot, type LiveClient, type LiveInput } from '../src/server/app-live.ts'
import { createActivity } from '../src/server/jam/activity.ts'
import { boardsChanged, createWorkClock, pinningBoards, workActivity, workClock } from '../src/server/work.ts'
import { LIVE_BOUNDS, LIVE_TITLES_MAX, LIVE_WIRE, type LiveEvent, type LiveItem } from '../src/shared/app-api.ts'
import type { QueueView } from '../src/server/jam/live.ts'

/**
 * Spec 32 F2, the package half of "Agent working on X · N min" and of the board titles: `LiveEvent.work` - since when
 * something has been at work (`marver work`'s clock, kept at the activity source; each Jam run's start) and on which
 * board - and `LiveEvent.titles`, bounded and counted in the event's bytes. The clock lives for the process: a client
 * that disconnects and reconnects, a hub closed and made again (a Vite restart) and a change while no client listens
 * all keep it; a 'cli' lease that expired with no sweep, then a new mark, starts it again; Jam's own leases never time it.
 */

type Card = QueueView['cards'][number]
let t0 = 5_000_000
const card = (id: string, o: Partial<Card> = {}): Card => ({ id, kind: 'comment', board: 'home', frames: ['demo/one'], events: [], state: 'working', rev: 1, made: ++t0, order: t0, at: t0, ...o })
const input = (o: Partial<LiveInput> & { cards?: Card[] } = {}): LiveInput => {
  const { cards, ...rest } = o
  return { boards: [], fresh: [], cli: [], ...(cards ? { jam: { agent: 'claude', cards } } : {}), ...rest }
}
const item = (i: number, board: string): LiveItem => ({ id: `ask:${i.toString(16).padStart(20, '0')}`, kind: 'ask', board, title: 'x'.repeat(LIVE_BOUNDS.title), at: 1000 - i, thread: `t${i}`, msg: `m${i}` })

/** A response stand-in: what the hub writes. */
function client() {
  const handlers: Record<string, (() => void)[]> = {}
  const c = {
    chunks: [] as string[], writableLength: 0,
    write(s: string) { c.chunks.push(s); return true },
    end() { for (const f of handlers.close ?? []) f(); return c },
    destroy() { for (const f of handlers.close ?? []) f(); return c },
    on(ev: string, fn: () => void) { (handlers[ev] ??= []).push(fn); return c },
    events: () => c.chunks.filter((x) => x.startsWith('event:')).map((x) => JSON.parse(x.split('\n')[1].slice(6)) as LiveEvent),
  }
  return c as typeof c & LiveClient
}

afterEach(() => { vi.useRealTimers(); workActivity.clearAll('cli'); workActivity.clearAll('jam') })

describe('the CLI clock (work.ts createWorkClock)', () => {
  it('starts at the first mark, holds through refreshes and Jam\'s marks, clears when the CLI holds nothing', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const a = createActivity()
    const c = createWorkClock(a)
    expect(c.since()).toBeUndefined()
    a.mark('demo/a', 60_000, 'cli')
    expect(c.since()).toBe(1_000_000)
    vi.advanceTimersByTime(20_000)
    a.mark('demo/a', 60_000, 'cli')                  // a refresh
    a.mark('demo/b', 60_000, 'jam')                  // Jam's own mark: told, not timed
    expect(c.since()).toBe(1_000_000)
    a.clear('demo/a', 'cli')                         // the CLI holds nothing (a Jam lease remains)
    expect(c.since()).toBeUndefined()
    vi.advanceTimersByTime(5_000)
    a.mark('demo/c', 60_000, 'cli')                  // new CLI work beside a leftover Jam lease: its own time
    expect(c.since()).toBe(1_025_000)
    c.stop()
  })

  it('a lease that expired with no sweep, then a new mark - two non-empty callbacks, none empty between - starts again at the new mark', () => {
    vi.useFakeTimers({ now: 2_000_000 })
    const a = createActivity()
    const c = createWorkClock(a)
    const told: string[][] = []
    a.onChange((f) => told.push(f))
    a.mark('demo/a', 1_000, 'cli')
    expect(c.since()).toBe(2_000_000)
    vi.advanceTimersByTime(3_000)                     // expired, never swept: still in the map
    expect(c.since()).toBeUndefined()                // a read once `until` passed answers nothing
    a.mark('demo/b', 60_000, 'cli')
    expect(told.every((f) => f.length > 0)).toBe(true)
    expect(told.at(-1)).toEqual(['demo/a', 'demo/b'])
    expect(c.since()).toBe(2_003_000)
    c.stop()
  })

  it('pinningBoards: the boards pinning a frame, by name, never an auto board', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-s32-pin-')))
    try {
      const dir = join(root, 'design', 'boards')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'zeta.json'), JSON.stringify({ version: 1, name: 'zeta', nodes: [{ key: 'a', frame: 'demo/a' }] }))
      writeFileSync(join(dir, 'beta.json'), JSON.stringify({ version: 1, name: 'beta', nodes: [{ key: 'a', frame: 'demo/a' }, { key: 'b', frame: 'demo/b' }] }))
      writeFileSync(join(dir, 'all.json'), JSON.stringify({ version: 1, name: 'all', auto: true, nodes: [{ key: 'a', frame: 'demo/a' }] }))
      boardsChanged(root)
      expect(pinningBoards(root, ['demo/a'])).toEqual(['beta', 'zeta'])
      expect(pinningBoards(root, ['demo/b'])).toEqual(['beta'])
      expect(pinningBoards(root, ['demo/none'])).toEqual([])
      expect(pinningBoards(root, [])).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('LiveEvent.work (spec 32 F2)', () => {
  it('nothing at work: no `work`', () => {
    expect(liveSnapshot(input()).work).toBeUndefined()
    expect(liveSnapshot(input({ cards: [card('c', { state: 'queued' })] })).work).toBeUndefined()
  })

  it('the CLI alone: since its clock, on the first board by name pinning its frames', () => {
    expect(liveSnapshot(input({ cli: ['demo/a'], cliSince: 1234, pinning: ['alpha', 'beta'] })).work).toEqual({ board: 'alpha', since: 1234 })
    expect(liveSnapshot(input({ cli: ['demo/a'], cliSince: 1234 })).work).toEqual({ since: 1234 })
    // a clock with no lease behind it is never read (the CLI holds nothing)
    expect(liveSnapshot(input({ cli: [], cliSince: 1234, pinning: ['alpha'] })).work).toBeUndefined()
  })

  it('Jam runs: since the oldest working run\'s start, on the newest one\'s board; a stalled, offered, waiting or stopping run never counts', () => {
    const run = (id: string, board: string, startedAt: number, state?: 'offered' | 'claimed' | 'stalled' | 'stopping' | 'waiting') =>
      card(id, { board, startedAt, runner: { kind: state ? 'session' : 'fresh', agent: 'claude', batch: `b-${id}`, ...(state ? { state } : {}) } })
    const b = liveSnapshot(input({ cards: [run('a', 'first', 100), run('b', 'second', 300), run('c', 'third', 200, 'claimed')] }))
    expect(b.work).toEqual({ board: 'second', since: 100 })
    for (const st of ['offered', 'stalled', 'stopping', 'waiting'] as const) {
      expect(liveSnapshot(input({ cards: [run('x', 'gone', 50, st), run('y', 'live', 400)] })).work).toEqual({ board: 'live', since: 400 })
    }
    // the CLI and Jam together: the earlier start; the board is Jam's
    expect(liveSnapshot(input({ cli: ['demo/z'], cliSince: 80, pinning: ['pin'], cards: [run('a', 'jam', 100)] })).work).toEqual({ board: 'jam', since: 80 })
    expect(liveSnapshot(input({ cli: ['demo/z'], cliSince: 180, pinning: ['pin'], cards: [run('a', 'jam', 100)] })).work).toEqual({ board: 'jam', since: 100 })
  })

  it('a working run with no startedAt (an older batch never claimed) reads when app-live first saw it working, until it stops', () => {
    const c = card('old-1', { board: 'b' })
    expect(liveSnapshot(input({ cards: [c], now: 10_000 })).work).toEqual({ board: 'b', since: 10_000 })
    expect(liveSnapshot(input({ cards: [c], now: 70_000 })).work).toEqual({ board: 'b', since: 10_000 })
    expect(liveSnapshot(input({ cards: [{ ...c, state: 'done' }], now: 80_000 })).work).toBeUndefined()
    expect(liveSnapshot(input({ cards: [c], now: 90_000 })).work).toEqual({ board: 'b', since: 90_000 })
  })
})

describe('LiveEvent.titles (spec 32 F2)', () => {
  const ask = (board: string, id: string) => ({ board, threads: [{ id, ts: ++t0, resolved: false, replies: [{ id: `${id}-r`, ts: ++t0, body: 'Which one?', agent: true, asks: true }], reactions: {}, body: 'root', frame: 'demo/one' }] })

  it('the titles of the boards the items and work name, one line, bounded; none from a canvas without titles (0.31)', () => {
    const b = liveSnapshot({ boards: [ask('home', 't1'), ask('deck', 't2'), ask('plain', 't3')], fresh: [], cli: ['demo/a'], cliSince: 5, pinning: ['pinned'],
      titles: { home: 'Home\n  page', deck: 'The deck', pinned: 'Pinned board', other: 'Never named', long: 'x' } })
    expect(b.titles).toEqual({ pinned: 'Pinned board', home: 'Home page', deck: 'The deck' })
    expect(b.work).toEqual({ board: 'pinned', since: 5 })
    expect(liveSnapshot({ boards: [ask('home', 't1')], fresh: [], cli: [] })).not.toHaveProperty('titles')
    expect(liveSnapshot({ boards: [ask('home', 't1')], fresh: [], cli: [], titles: { other: 'x' } })).not.toHaveProperty('titles')
    // a title past 140 UTF-16 units is cut to one line of 140
    const long = liveSnapshot({ boards: [ask('home', 't1')], fresh: [], cli: [], titles: { home: 'y'.repeat(400) } })
    expect(long.titles!.home).toHaveLength(LIVE_BOUNDS.title)
  })

  it('at most LIVE_TITLES_MAX keys, never a key past LIVE_BOUNDS.ref', () => {
    const names = Array.from({ length: 40 }, (_, i) => `board-${String(i).padStart(2, '0')}`)
    const titles = Object.fromEntries(names.map((n) => [n, `Title ${n}`]))
    const b = liveSnapshot({ boards: names.map((n, i) => ask(n, `t${i}`)), fresh: [], cli: [], titles })
    expect(Object.keys(b.titles!)).toHaveLength(LIVE_TITLES_MAX)
    const far = 'k'.repeat(LIVE_BOUNDS.ref + 1)
    expect(liveSnapshot({ boards: [], fresh: [], cli: ['f'], cliSince: 1, pinning: [far], titles: { [far]: 'Far' } })).not.toHaveProperty('titles')
  })

  it('counted in the event\'s bytes: an event over budget sheds its oldest items and the titles only they named; work\'s board keeps its title', () => {
    const items = Array.from({ length: 100 }, (_, i) => item(i, `b${String(i).padStart(3, '0')}${'z'.repeat(100)}`))
    const titles: Record<string, string> = { worked: 'W'.repeat(LIVE_BOUNDS.title) }
    for (const i of items.slice(0, LIVE_TITLES_MAX - 1)) titles[i.board] = 'T'.repeat(LIVE_BOUNDS.title)
    const e: LiveEvent = { v: 1, instance: 'i', seq: 1, jam: 'on', items, cut: 0, counts: { ask: 100, review: 0, failed: 0, stalled: 0 }, unseen: 0, working: true, session: false,
      work: { board: 'worked', since: 1 }, titles }
    const text = encodeLive(e)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LIVE_BOUNDS.eventBytes)
    const out = JSON.parse(text.split('\n')[1].slice(6)) as LiveEvent
    expect(out.items.length).toBeLessThan(100)
    expect(out.cut).toBe(100 - out.items.length)
    const named = new Set(['worked', ...out.items.map((i) => i.board)])
    expect(Object.keys(out.titles!).every((k) => named.has(k))).toBe(true)
    expect(out.titles!.worked).toBe(titles.worked)
    expect(out.work).toEqual({ board: 'worked', since: 1 })
  })
})

describe('the process\'s clock across clients and hubs (spec 32 F2)', () => {
  const read = () => liveSnapshot({ boards: [], fresh: [], cli: workActivity.leases('cli').map(([f]) => f), ...(workClock.since() !== undefined ? { cliSince: workClock.since() } : {}) })

  it('set by a change while no client is connected; kept through a disconnect and reconnect, and a hub closed and made again', async () => {
    workActivity.mark('demo/s32', 60_000, 'cli')
    const since = workClock.since()!
    expect(typeof since).toBe('number')
    await new Promise((r) => setTimeout(r, 30))
    const hub = createLiveHub({ instance: 'i', read, seq: { n: 0 } })
    const a = client()
    hub.add(a)
    expect(a.events().at(-1)!.work).toEqual({ since })
    hub.drop()                                        // the connection dropped
    workActivity.mark('demo/s32', 60_000, 'cli')      // a refresh while no client listens
    const b = client()
    hub.add(b)
    expect(b.events().at(-1)!.work).toEqual({ since })
    hub.close()                                       // a Vite restart: a new hub
    const hub2 = createLiveHub({ instance: 'i', read, seq: { n: 0 } })
    const c = client()
    hub2.add(c)
    expect(c.events().at(-1)!.work).toEqual({ since })
    workActivity.clear('demo/s32', 'cli')
    expect(workClock.since()).toBeUndefined()
    hub2.push()
    expect(c.events().at(-1)).not.toHaveProperty('work')
    hub2.close()
    expect(LIVE_WIRE.path).toBe('/__mv/app/live')
  })

  it('liveSources: the CLI clock, the boards pinning its frames and every board\'s title reach the selector', async () => {
    const { liveSources } = await import('../src/server/plugin.ts')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-s32-src-')))
    try {
      const dir = join(root, 'design', 'boards')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'main.json'), JSON.stringify({ version: 1, name: 'main', title: 'The main board', nodes: [{ key: 'a', frame: 'demo/s32src' }] }))
      boardsChanged(root)
      workActivity.mark('demo/s32src', 60_000, 'cli')
      const src = liveSources(root)
      const got = src.read([], [{ name: 'main', title: 'The main board' }, { name: 'bare' }])
      expect(got).toMatchObject({ cli: ['demo/s32src'], cliSince: workClock.since(), pinning: ['main'], titles: { main: 'The main board' } })
      expect(liveSnapshot(got)).toMatchObject({ working: true, work: { board: 'main', since: workClock.since() }, titles: { main: 'The main board' } })
      workActivity.clear('demo/s32src', 'cli')
      const idle = src.read([], [{ name: 'main', title: 'The main board' }])
      expect(idle).not.toHaveProperty('cliSince')
      expect(idle).not.toHaveProperty('pinning')
      expect(liveSnapshot(idle)).not.toHaveProperty('work')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
