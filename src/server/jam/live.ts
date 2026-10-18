/**
 * The running daemon's door for the dev server's routes (one per process, like workActivity):
 * the page's comment route pokes it right after it appends, and the jam routes read the queue and
 * act on cards through it. Empty when jam is off or another server holds the repo lock.
 */
import type { Card } from './types.ts'

export interface QueueView {
  agent: string
  cards: (Pick<Card, 'id' | 'kind' | 'board' | 'thread' | 'frames' | 'events' | 'state' | 'note' | 'rev' | 'made' | 'order' | 'at' | 'follows' | 'reply'> & {
    position?: number    // 1 = next, counting every queued card - tags and captures share one queue
    waiting?: string     // why a queued card is held
    exclusive?: boolean
    batch?: string       // the batch that ran it last - a page folds one batch's failures into one notice
  })[]
}

export const jamLive: {
  poke?: () => void
  view?: () => QueueView
  act?: (id: string, rev: number, action: string) => Promise<{ ok: boolean; card?: unknown; error?: string }>
} = {}
