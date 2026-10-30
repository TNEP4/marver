/**
 * What a notice's click names, against what the page holds now (spec 28 A4.6 #30, r1 #1, r3 #2) - pure, so its rules
 * are the package's unit cases: the occurrence compared, its state and its counter, and the target to open. A target
 * that still stands in that state with that counter is `handled`; one in another state, or the same state with another
 * counter (a second stall of one claim, a redelivery that failed again, a review after More work), is `stale` and opens
 * as it stands - never another item; one gone is `missing`. A comment card the queue's view no longer holds (it keeps a
 * finished one 60 s) is not gone while its thread stands: stale, its thread opened.
 */
import { asks, type Thread } from '../../shared/events.ts'
import type { OpenItem } from '../../shared/app-api.ts'
import type { JamCard } from './jam-queue.ts'

/** Where it opens: a thread (`openThreadAt`), a card's tile surface (`openTile`), or a run's controls (`openRunControls`). */
export type Target = { thread: string } | { tile: string } | { controls: JamCard }
/** `unread`: it stands on the queue, which was not read - nothing can be said, nothing moves. */
export type Resolution = { result: 'handled' | 'stale'; target: Target } | 'missing' | 'unread'

/** A card's target as it stands: a comment card's thread, else its tile's surface. */
const asItStands = (c: JamCard): Target => (c.kind === 'comment' && c.thread ? { thread: c.thread } : { tile: c.id })

/** `threads`: every board's, as the comments store holds them; `cards`: the queue's view read now, or null when unread. */
export function resolveItem(p: OpenItem, threads: readonly Thread[], cards: readonly JamCard[] | null): Resolution {
  const threadOf = (id?: string) => (id ? threads.find((t) => t.id === id && (!t.board || t.board === p.board)) : undefined)
  const mine = (cards ?? []).filter((c) => p.cards?.includes(c.id))
  const viaThread = (): Resolution => { const t = threadOf(p.thread); return t ? { result: 'stale', target: { thread: t.id } } : 'missing' }
  if (p.kind === 'ask') {
    const t = threadOf(p.thread)
    if (!t) return 'missing'
    const last = t.replies.length ? t.replies[t.replies.length - 1] : t
    const msg = last === t ? t.id : (last as Thread['replies'][number]).id
    const now = !t.resolved && msg === p.msg && !!last.agent && asks(last, last === t)
    // its Jam card is only a way in: read, and still asking, it opens through the card (a capture keeps its panel)
    const card = now ? mine.find((c) => c.state === 'asks' && c.thread === t.id) : undefined
    return { result: now ? 'handled' : 'stale', target: card ? { tile: card.id } : { thread: t.id } }
  }
  if (!cards) return 'unread'
  if (p.kind === 'review') {
    const c = mine[0]
    if (!c) return 'missing'
    const now = c.state === 'review' && c.batch === p.batch && (c.att ?? 0) === p.occ
    return { result: now ? 'handled' : 'stale', target: now ? { tile: c.id } : asItStands(c) }
  }
  // failed: the same run failing again is another occurrence - its batch and failures, or (no run) the card's attempts;
  // stalled: a second stall of the same claim is another
  const now = p.kind === 'failed'
    ? mine.find((c) => c.state === 'failed' && (p.batch ? c.batch === p.batch && (c.fails ?? 0) === p.occ : (c.att ?? 0) === p.occ))
    : mine.find((c) => c.state === 'working' && c.runner?.state === 'stalled' && c.runner.batch === p.batch && c.runner.gen === p.gen && (c.runner.stalls ?? 0) === p.occ)
  if (now) return { result: 'handled', target: { controls: now } }
  return mine[0] ? { result: 'stale', target: asItStands(mine[0]) } : viaThread()
}
