import { describe, expect, it } from 'vitest'
import { resolveItem } from '../src/client/shell/open-resolve.ts'
import { liveId } from '../src/server/app-live.ts'
import type { Thread } from '../src/shared/events.ts'
import type { OpenItem } from '../src/shared/app-api.ts'
import type { JamCard } from '../src/client/shell/jam-queue.ts'

/**
 * A notice's click, resolved against what the page holds now (spec 28 A4.6 #30, r1 #1, r3 #2): the occurrence - its
 * state and its counter - handled, stale (opened as it stands) or missing, and through which helper it opens.
 */

const thread = (id: string, o: Partial<Thread> = {}): Thread => ({ id, board: 'home', ts: 1, resolved: false, replies: [], reactions: {}, body: 'make it blue', frame: 'demo/one', ...o })
const reply = (id: string, o: Partial<Thread['replies'][number]> = {}): Thread['replies'][number] => ({ id, ts: 2, body: 'ok', ...o })
const asking = (id: string, o: Partial<Thread> = {}) => thread(id, { replies: [reply(`${id}-q`, { agent: true, asks: true, body: 'Which blue?' })], ...o })
const card = (id: string, o: Partial<JamCard> = {}): JamCard => ({ id, kind: 'capture', board: 'home', frames: ['demo/one'], events: [], state: 'queued', rev: 1, made: 1, order: 1, at: 1, ...o })
const ask = (t: string, msg: string, cards?: string[]): OpenItem => ({ id: liveId('ask', 'home', t, msg), kind: 'ask', board: 'home', thread: t, msg, ...(cards ? { cards } : {}) })
const runner = (state: 'stalled' | 'claimed', stalls: number, gen = 3) => ({ kind: 'session' as const, agent: 'claude', batch: 'b1', gen, state, stalls })

describe('an ask', () => {
  it('still asking: handled, through its thread - or its Jam card in asks, when the queue was read', () => {
    expect(resolveItem(ask('t', 't-q'), [asking('t')], null)).toEqual({ result: 'handled', target: { thread: 't' } })
    const c = card('c', { state: 'asks', thread: 't' })
    expect(resolveItem(ask('t', 't-q', ['c']), [asking('t')], [c])).toEqual({ result: 'handled', target: { tile: 'c' } })
    // the queue unread: its thread alone (the card is only a way in)
    expect(resolveItem(ask('t', 't-q', ['c']), [asking('t')], null)).toEqual({ result: 'handled', target: { thread: 't' } })
  })

  it('answered, resolved, or a newer question asked since: stale, its thread opened as it stands; another board\'s thread of that id is not it; gone: missing', () => {
    const answered = thread('t', { replies: [reply('t-q', { agent: true, asks: true }), reply('t-a', { body: 'light' })] })
    const newer = thread('t', { replies: [reply('t-q', { agent: true, asks: true }), reply('t-a'), reply('t-q2', { agent: true, asks: true })] })
    for (const t of [answered, asking('t', { resolved: true }), newer]) expect(resolveItem(ask('t', 't-q'), [t], null)).toEqual({ result: 'stale', target: { thread: 't' } })
    expect(resolveItem(ask('t', 't-q'), [asking('t', { board: 'other' })], null)).toBe('missing')
    expect(resolveItem(ask('t', 't-q'), [], null)).toBe('missing')
  })
})

describe('a review', () => {
  const item: OpenItem = { id: liveId('review', 'c', 1), kind: 'review', board: 'home', cards: ['c'], batch: 'b1', occ: 1 }
  it('in review with its batch and att: handled; after More work (att 2, a new batch) or decided: stale; gone: missing; the queue unread: nothing said', () => {
    expect(resolveItem(item, [], [card('c', { state: 'review', batch: 'b1', att: 1 })])).toEqual({ result: 'handled', target: { tile: 'c' } })
    expect(resolveItem(item, [], [card('c', { state: 'review', batch: 'b2', att: 2 })])).toEqual({ result: 'stale', target: { tile: 'c' } })
    // the counter alone: the same batch in review again is another occurrence
    expect(resolveItem(item, [], [card('c', { state: 'review', batch: 'b1', att: 2 })])).toEqual({ result: 'stale', target: { tile: 'c' } })
    expect(resolveItem(item, [], [card('c', { state: 'done', batch: 'b1', att: 1 })])).toEqual({ result: 'stale', target: { tile: 'c' } })
    expect(resolveItem(item, [], [])).toBe('missing')
    expect(resolveItem(item, [], null)).toBe('unread')
  })
})

describe('a failed run', () => {
  const item: OpenItem = { id: liveId('failed', 'b1', 1), kind: 'failed', board: 'home', thread: 't', cards: ['c'], batch: 'b1', occ: 1 }
  it('still failed with its batch and failures: handled, its run controls; a redelivery failing again (failures 2) or a retry running: stale', () => {
    const c = card('c', { kind: 'comment', thread: 't', state: 'failed', batch: 'b1', fails: 1 })
    expect(resolveItem(item, [thread('t')], [c])).toEqual({ result: 'handled', target: { controls: c } })
    expect(resolveItem(item, [thread('t')], [{ ...c, fails: 2 }])).toEqual({ result: 'stale', target: { thread: 't' } })
    expect(resolveItem(item, [thread('t')], [{ ...c, state: 'queued' }])).toEqual({ result: 'stale', target: { thread: 't' } })
  })

  it('a card that failed with no run is named by its attempts', () => {
    const c = card('c', { state: 'failed', att: 2 })
    const noRun: OpenItem = { id: liveId('failed', 'c', 2), kind: 'failed', board: 'home', cards: ['c'], occ: 2 }
    expect(resolveItem(noRun, [], [c])).toEqual({ result: 'handled', target: { controls: c } })
    expect(resolveItem(noRun, [], [{ ...c, att: 3 }])).toEqual({ result: 'stale', target: { tile: 'c' } })
  })

  it('failed, then its thread resolved (the card turned done): stale, its thread; past the view\'s 60 s with the thread standing: stale, never missing (r3 #2); thread gone too: missing', () => {
    expect(resolveItem(item, [thread('t', { resolved: true })], [card('c', { kind: 'comment', thread: 't', state: 'done', batch: 'b1', fails: 1 })])).toEqual({ result: 'stale', target: { thread: 't' } })
    expect(resolveItem(item, [thread('t', { resolved: true })], [])).toEqual({ result: 'stale', target: { thread: 't' } })
    expect(resolveItem(item, [], [])).toBe('missing')
  })
})

describe('a stalled run', () => {
  const item: OpenItem = { id: liveId('stalled', 'b1', 3, 1), kind: 'stalled', board: 'home', cards: ['c'], batch: 'b1', gen: 3, occ: 1 }
  it('still stalled under its gen with its stalls: handled; given back (claimed), stalled again (stalls 2) or another claim (gen 4): stale', () => {
    const c = card('c', { state: 'working', batch: 'b1', runner: runner('stalled', 1) })
    expect(resolveItem(item, [], [c])).toEqual({ result: 'handled', target: { controls: c } })
    for (const r of [runner('claimed', 1), runner('stalled', 2), runner('stalled', 1, 4)]) expect(resolveItem(item, [], [{ ...c, runner: r }])).toEqual({ result: 'stale', target: { tile: 'c' } })
    expect(resolveItem(item, [], [])).toBe('missing')
  })
})
