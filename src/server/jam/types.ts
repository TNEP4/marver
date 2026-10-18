/**
 * Live Jam shared types. No node imports beyond types - kept small
 * so the adapter, packet, journal, queue and daemon modules share one vocabulary.
 *
 * 0.26 (spec 27): the journal holds two lists - cards (what the owner asked, and where it
 * stands) and batches (what the daemon ran). A tag's card lives in its thread; a capture's on
 * the lane. One queue, one lock, one scheduler for both.
 */
import type { CommentEvent } from '../../shared/events.ts'
import type { JamAgent } from './agent.ts'
import type { AnchorLook, AnchorTarget } from '../../shared/anchor.ts'

/** A re-pin: the agent moved the commented element, so the whole thread follows. It names the
 *  element the way `comments move` does; the daemon turns that into the shared anchor. */
export interface Reanchor { thread: string; target: AnchorTarget; look?: AnchorLook }

/** One agent CLI the daemon can spawn. The full set lives in adapter/index.ts. */
export interface JamAdapter {
  name: JamAgent
  supportsSubagents: boolean
  /** argv for a goal-phrased, workspace-jailed run over `goal`. Never full-access, never prompts.
   *  `env` (rare) is merged over the daemon's env - a per-run knob for CLIs whose jail is
   *  configured that way (opencode's OPENCODE_PERMISSION), never a credential channel. */
  spawnArgs(goal: string): { cmd: string; args: string[]; env?: Record<string, string> }
  /** Parse the agent's stdout + exit code into the reply, whether it asks, best-effort model id,
   *  and any reanchors - through the one shared parser (packet.ts `parseAgentText`). `said` is
   *  the agent's whole final message, which the daemon splits by member. */
  parse(stdout: string, code: number): { reply: string; asks: boolean; model?: string; ok: boolean; reanchors: Reanchor[]; said?: string }
  /** The agent's first message from one stdout line - with the model when the stream
   *  already names it, so the early ack's provenance matches the final reply's. The daemon
   *  posts the FIRST such text at once (one-member jobs only). Optional. */
  earlyText?(line: string): { text: string; model?: string } | null
}

// ---- journal v2: cards and batches -----------------------------------------------------------

export type CardKind = 'comment' | 'capture' | 'wrapup'
export type CardState = 'draft' | 'confirming' | 'queued' | 'working' | 'asks' | 'review' | 'done' | 'kept' | 'failed' | 'dropped'

/** One message of a brief, copied as text at claim. `ask` marks the card's own events; the rest
 *  is history. `rev` is the text revision copied (the event id, or its latest ledgered edit). */
export interface Msg {
  id: string                 // the event id
  author?: string
  agent?: boolean
  owner?: boolean            // a ledgered owner event (the only kind that can be an ask)
  body: string
  ts: number
  rev?: string
  note?: string              // "dropped - not an ask", "someone else - context only"
}

export interface Brief {
  asks: Msg[]
  history: Msg[]
  capture?: unknown          // a capture's frozen payload (M2)
  follows?: { asks: Msg[]; result: string }
}

export interface Card {
  id: string                 // 'c-' + the first event id, or the capture / wrap-up id
  kind: CardKind             // what made the card - a source, not a category
  board: string
  frames: string[]           // every frame it names
  thread?: string            // the thread it lives in
  capture?: string           // the capture this thread was made for (M2)
  events: string[]           // the owner's asks it holds, in order - all ledgered
  brief?: Brief              // frozen when its batch is claimed
  state: CardState
  follows?: string           // the card this one follows up
  batch?: string             // the batch that ran it last
  ran?: string[]             // its earlier batches, oldest first (More work, Retry)
  asked?: number             // when its question was posted, for answers that came first
  reply?: string             // the agent's reply: its comment id in `thread`
  note?: string              // why it is where it is
  resolved?: boolean         // the thread was resolved while the card was working
  exclusive?: string[]       // runs alone and may edit these shared files (a `shared` answer)
  shared?: number            // how many times it answered `shared` (a second one fails it)
  made: number               // when it was made - the lane's order
  order: number              // run position: `made`, unless Do next put it first
  rev: number                // bumped on every change; actions compare it
  at: number                 // last change, for pruning
}

/** One member of a batch. `brief` is the card's brief as this run froze it - a run is named by its
 *  batch, so More work and Retry read the previous run from here, never from the card. */
export interface Member { id: string; card: string; board: string; brief?: Brief }

export type Result =
  | { body: string; asks: boolean; model?: string; reanchors: Reanchor[]; alsoChanged?: string[] }
  | { missing: true }
  | { shared: string[] }

export interface Batch {
  batchId: string
  members: Member[]
  frames: string[]           // every frame it reserves
  exclusive?: boolean        // reserves the whole canvas
  state: 'claimed' | 'done' | 'failed'
  leaseUntil: number
  attempts: number
  pgid?: number              // spawned process group, for fencing an orphan on resume
  results?: Record<string, Result>   // written before any reply is posted
  /** the rest of the delivery record, written with `results`: the re-pins, and the one-member
   *  early ack the final reply may be (so a resumed delivery never posts it twice) */
  reanchors?: Reanchor[]
  early?: { body: string; asks: boolean; commentId: string; ts: number }
  note?: string              // why it failed (two failed attempts) - what a card that follows it reads
  posted?: boolean           // every reply and reanchor of `results` is in the log
  model?: string
  at: number
}

/** The on-disk journal (design/.local/jam-jobs.json), version 2. `seen` holds `board|id` for
 *  every event ingest has read (the dedup source of truth); `covered` maps an owner event id to
 *  the text revision a frozen brief copied (what takes a plain reply off `marver marks`);
 *  `legacy` holds plain replies a v1 journal took in without proof they were handled. `device`
 *  binds the file to the machine that wrote it (journal.ts). */
export interface Journal {
  version: 2
  device: string
  baselined: boolean
  seen: string[]
  cards: Card[]
  batches: Batch[]
  covered: Record<string, string>
  legacy: string[]
  upgraded?: number          // when a v1 journal became this one (the boot line says what changed)
}

/** The 0.25 journal, read once by the upgrade. */
export interface JournalV1 {
  version: 1
  device: string
  baselined: boolean
  seen: string[]
  batches: { batchId: string; board: string; memberEventIds: string[]; state: 'pending' | 'claimed' | 'done' | 'failed'; leaseUntil: number; attempts: number; pgid?: number }[]
}

// ---- the job packet -----------------------------------------------------------------------------

/** What the daemon hands one member to the agent - untrusted user data, framed as such. */
export interface PacketMember {
  id: string                 // 'm1', 'm2'...
  card: string
  kind: CardKind
  board: string
  thread?: string
  frames: string[]
  anchor?: unknown
  brief: Brief
}

export interface JobPacket {
  v: 2
  kind: 'marver.jam.job'
  batchId: string
  frames: string[]           // the frames this job may edit
  exclusive?: { files: string[] }
  members: PacketMember[]
}

/** A triggering event plus the board it lives on. */
export interface Pending { board: string; event: CommentEvent; /** the thread's frame, when known */ frame?: string }
