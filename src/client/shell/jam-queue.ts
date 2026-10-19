/**
 * The jam queue as the page sees it (spec 27): the cards the dev server holds, fetched once and then
 * pushed on every change (`sh:jam-queue`). A tag's card shows only in its thread - the status icon by
 * its time - so the page needs the card, its state and its one move (Drop while queued, Retry when
 * failed). A card that fails raises one notice; nothing else here interrupts.
 */
import { create } from 'zustand'
import { ROUTE } from '../const.ts'
import { PUBLISHED } from './store.ts'

export type JamAction = 'drop' | 'retry' | 'keep' | 'first' | 'confirm' | 'edit' | 'good' | 'more' | 'later' | 'rename' | 'note'
export type JamCardState = 'draft' | 'confirming' | 'queued' | 'working' | 'asks' | 'review' | 'done' | 'kept' | 'failed' | 'dropped'
export interface JamCard {
  id: string; kind: 'comment' | 'capture' | 'wrapup'; board: string; thread?: string; frames: string[]; events: string[]
  state: JamCardState; note?: string; rev: number; made: number; order: number; at: number
  follows?: string; reply?: string; position?: number; waiting?: string; exclusive?: boolean; batch?: string
  // captures: the lane and the review
  title?: string; inRun?: boolean; shots?: { frame: string; before?: string; after?: string; same?: boolean; new?: boolean }[]
  reviewing?: { card: string; batch: string; rev: number }; edited?: string; added?: { at: number; text: string }[]; notes?: number; capture?: string
  /** the title is the name you gave it (Rename), not its first words */
  named?: boolean
  /** its name - yours, or the one a small model gave it from its words */
  name?: string
  /** the session it was made in (a capture), or whose record it writes (a wrap-up) */
  session?: string
  /** a session record: the file it writes */
  file?: string
}
/** The review's frames: the ones the run changed (all of them when none did - there is still a before
 *  and after to look at). */
export const changedShots = (shots: JamCard['shots']) => { const all = shots ?? []; const changed = all.filter((x) => !x.same); return changed.length ? changed : all }

interface QueueState {
  /** null: no queue here (published, jam off, or not loaded yet) - no icon anywhere */
  cards: JamCard[] | null
  agent: string | null
  /** the lane's run, while one lasts */
  run: { since: number } | null
  /** the Jam session running now (spec 27 Part 5) */
  session: { id: string; since: number } | null
  load(): Promise<void>
  apply(view: unknown): void
  /** A session this page ended (the server said so): gone at once, and no view shows it again */
  forget(session: string): void
  act(card: JamCard, action: JamAction, body?: string): Promise<boolean>
}

const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
const PENDING: JamCardState[] = ['queued', 'working', 'asks', 'failed', 'draft', 'confirming']

/** The card a thread message stands for, by its event id - the LAST tag of the card carries the
 *  icon (joined tags carry one), and only while there is something to wait for or act on. */
export function cardForEvent(cards: JamCard[] | null, board: string | undefined, eventId: string | undefined): JamCard | undefined {
  if (!cards || !eventId) return undefined
  // a capture's comment (`cap-<id>-e`) wears its capture card's state
  const cap = /^cap-(.+)-e$/.exec(eventId)?.[1]
  if (cap) return cards.find((c) => c.id === cap && PENDING.includes(c.state) && c.state !== 'draft')
  return cards.find((c) => c.kind === 'comment' && (!board || c.board === board) && c.events[c.events.length - 1] === eventId && PENDING.includes(c.state))
}

export const useJamQueue = create<QueueState>((set, get) => {
  let loaded = false
  /** the newest view applied: an older one (a slow answer overtaken by a push) is never applied over it */
  let seen: { boot: string; n: number } | null = null
  /** sessions known to be over: a view built before the end (however it arrives) never brings one back */
  const over = new Set<string>()
  return {
    cards: null,
    agent: null,
    run: null,
    session: null,
    async load() {
      if (PUBLISHED) return
      try {
        const res = await fetch(`${ROUTE}/api/jam/queue`, { headers: { 'x-mv-c': csrf() } })
        if (res.ok) get().apply(await res.json())
      } catch { /* no queue: no icons */ }
    },
    apply(view) {
      const v = (view && typeof view === 'object' ? view : {}) as { cards?: unknown; agent?: unknown }
      if (!Array.isArray(v.cards)) return
      const seq = (v as { seq?: { boot?: unknown; n?: unknown } }).seq
      if (seq && typeof seq.boot === 'string' && typeof seq.n === 'number') {
        if (seen && seen.boot === seq.boot && seq.n <= seen.n) return
        seen = { boot: seq.boot, n: seq.n }
      }
      const next = v.cards.filter((c): c is JamCard => !!c && typeof c === 'object' && typeof (c as JamCard).id === 'string' && typeof (c as JamCard).state === 'string')
      const before = new Map((get().cards ?? []).map((c) => [c.id, c]))
      const first = !loaded
      loaded = true
      const run = (v as { run?: { since?: unknown } }).run
      const ses = (v as { session?: { id?: unknown; since?: unknown } }).session
      set({ cards: next, agent: typeof v.agent === 'string' ? v.agent : null, run: run && typeof run.since === 'number' ? { since: run.since } : null,
        session: ses && typeof ses.id === 'string' && typeof ses.since === 'number' && !over.has(ses.id) ? { id: ses.id, since: ses.since } : null })
      if (first) return
      // something to review: a soft chime, once per batch that leaves a capture to review, if the page
      // has focus - never a notice (spec 27, Part 2)
      const ready = new Set(next.filter((c) => c.state === 'review' && before.get(c.id)?.state !== 'review').map((c) => c.batch ?? c.id))
      if (ready.size && document.hasFocus()) void import('./store.ts').then(({ CONFIG }) => {
        if (CONFIG.jam?.chime === false) return
        void import('./sound.ts').then(({ playChime }) => playChime())
      })
      // a failure interrupts once per batch: the cards that turned failed since the last look, by batch
      const failed = next.filter((c) => c.state === 'failed' && before.get(c.id)?.state !== 'failed')
      const byBatch = new Map<string, JamCard[]>()
      for (const c of failed) { const k = c.batch ?? c.id; byBatch.set(k, [...(byBatch.get(k) ?? []), c]) }
      if (failed.length) void import('./store.ts').then(({ useStore }) => {
        for (const cards of byBatch.values()) useStore.getState().jamFailed(cards)
      })
    },
    forget(session) {
      over.add(session)
      if (get().session?.id === session) set({ session: null })
    },
    async act(card, action, body) {
      const res = await fetch(`${ROUTE}/api/jam/card`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf() },
        body: JSON.stringify({ id: card.id, rev: card.rev, action, ...(body !== undefined ? { body } : {}) }),
      }).catch(() => null)
      await get().load()   // the card as it is now (its new rev) before the caller acts again
      return !!res?.ok
    },
  }
})

if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) (window as any).__mvJamQueue = useJamQueue
