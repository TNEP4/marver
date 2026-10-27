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
    /** notes written in its read-back after it ended */
    added?: { at: number; text: string }[]
    notes?: number
    session?: string     // the session it was made in, or whose record it writes
    file?: string        // a session record: the file it writes
    /** who runs it now (spec 29b): the owner's session, a copy of it, or a fresh agent - and where it stands */
    runner?: { kind: 'session' | 'fork' | 'fresh'; agent: string; state?: 'offered' | 'claimed' | 'stalled' | 'stopping' | 'waiting'; why?: string; batch: string; gen?: number }
  })[]
  /** the sessions connected to this repo now, and the one that takes the work */
  sessions?: { id: string; agent: 'claude' | 'codex' | 'cursor'; busy: boolean; selected: boolean; since: number; mode?: string }[]
  /** what Jam does now on this machine: the config with the start sheet's switches over it */
  settings?: { runner: 'auto' | 'session' | 'background'; session: boolean; context: 'fork' | 'fresh'; mcp: boolean; skills: boolean; others: boolean; sessionMax: number }
  /** the lane's run, while one lasts (captures made since then) */
  run?: { since: number }
  /** the Jam session running now */
  session?: { id: string; since: number }
  /** this view's place in order (per server run): a page never applies one older than what it shows */
  seq?: { boot: string; n: number }
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
  captureOpen?: (capture: string, session: string, on: boolean) => 'ok' | 'ended'
  tags?: (session: string) => number
  /** a session run's choice (spec 29b): by batch and its claim's generation */
  runAct?: (batch: string, gen: number, action: 'again' | 'background' | 'drop') => Promise<{ ok: boolean; error?: string }>
  /** push the queue to pages now (a switch changed what it shows) */
  refresh?: () => void
  /** what the connectors did last (spec 29b): at boot, at a session's start, at a switch in the sheet */
  connectors?: import('./connectors.ts').ConnectorResult[]
} = {}
