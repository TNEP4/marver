/**
 * The jam queue as the page sees it (spec 27): the cards the dev server holds, fetched once and then
 * pushed on every change (`sh:jam-queue`). A tag's card shows only in its thread - the status icon by
 * its time - so the page needs the card, its state and its one move (Drop while queued, Retry when
 * failed). A card that fails raises one notice; nothing else here interrupts.
 */
import { create } from 'zustand'
import { ROUTE } from '../const.ts'
import { PUBLISHED } from './store.ts'

export type JamCardState = 'draft' | 'confirming' | 'queued' | 'working' | 'asks' | 'review' | 'done' | 'kept' | 'failed' | 'dropped'
export interface JamCard {
  id: string; kind: 'comment' | 'capture' | 'wrapup'; board: string; thread?: string; frames: string[]; events: string[]
  state: JamCardState; note?: string; rev: number; made: number; order: number; at: number
  follows?: string; reply?: string; position?: number; waiting?: string; exclusive?: boolean
}
interface QueueState {
  /** null: no queue here (published, jam off, or not loaded yet) - no icon anywhere */
  cards: JamCard[] | null
  agent: string | null
  load(): Promise<void>
  apply(view: unknown): void
  act(card: JamCard, action: 'drop' | 'retry'): Promise<boolean>
}

const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
const PENDING: JamCardState[] = ['queued', 'working', 'asks', 'failed', 'draft', 'confirming']

/** The card a thread message stands for, by its event id - the LAST tag of the card carries the
 *  icon (joined tags carry one), and only while there is something to wait for or act on. */
export function cardForEvent(cards: JamCard[] | null, board: string | undefined, eventId: string | undefined): JamCard | undefined {
  if (!cards || !eventId) return undefined
  return cards.find((c) => c.kind === 'comment' && (!board || c.board === board) && c.events[c.events.length - 1] === eventId && PENDING.includes(c.state))
}

export const useJamQueue = create<QueueState>((set, get) => {
  let loaded = false
  return {
    cards: null,
    agent: null,
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
      const next = v.cards.filter((c): c is JamCard => !!c && typeof c === 'object' && typeof (c as JamCard).id === 'string' && typeof (c as JamCard).state === 'string')
      const before = new Map((get().cards ?? []).map((c) => [c.id, c]))
      const first = !loaded
      loaded = true
      set({ cards: next, agent: typeof v.agent === 'string' ? v.agent : null })
      if (first) return
      // a failure interrupts once: a card that turned failed since the last look
      const failed = next.filter((c) => c.state === 'failed' && before.get(c.id)?.state !== 'failed')
      if (failed.length) void import('./store.ts').then(({ useStore }) => {
        for (const c of failed) useStore.getState().jamFailed(c)
      })
    },
    async act(card, action) {
      const res = await fetch(`${ROUTE}/api/jam/card`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf() },
        body: JSON.stringify({ id: card.id, rev: card.rev, action }),
      }).catch(() => null)
      void get().load()
      return !!res?.ok
    },
  }
})
