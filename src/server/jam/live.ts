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
    // captures (the lane, the review): its first words, the run it is in, the run's shots, its reply
    title?: string
    inRun?: boolean
    shots?: { frame: string; before?: string; after?: string }[]
    reviewing?: { card: string; batch: string; rev: number }
    edited?: string
    notes?: number
    session?: string     // the session it was made in, or whose record it writes
    file?: string        // a session record: the file it writes
  })[]
  /** the lane's run, while one lasts (captures made since then) */
  run?: { since: number }
  /** the Jam session running now */
  session?: { id: string; since: number }
}

export const jamLive: {
  poke?: () => void
  view?: () => QueueView
  act?: (id: string, rev: number, action: string, body?: string) => Promise<{ ok: boolean; card?: unknown; error?: string }>
  capture?: (record: unknown) => Promise<{ ok: boolean; card?: unknown; error?: string }>
  sealed?: (id: string) => boolean
  session?: (op: any) => Promise<{ ok: boolean; session?: unknown; card?: unknown; error?: string }>
  record?: (id: string) => { file: string; text: string | null; reply?: string } | null
  canWrap?: (id: string) => string | null
} = {}
