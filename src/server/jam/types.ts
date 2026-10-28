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

/** What a spawned run may use (spec 29b, Part 1): full power by default - the shell inside the tool's
 *  sandbox, your MCP servers and skills - and, for a fork, the session it copies. */
export interface SpawnOpts {
  root: string
  mcp: boolean
  skills: boolean
  /** the tool's own session id to copy (`--resume --fork-session`, `exec fork`) */
  fork?: string
  /** how to run this marver (`jam permit`, Claude Code's permission tool): a command and its first args */
  marver?: { cmd: string; args: string[] }
  /** can the tool's sandbox run here (default: detected - macOS, Linux with its prerequisites) */
  sandbox?: boolean
}

/** One agent CLI the daemon can spawn. The full set lives in adapter/index.ts. */
export interface JamAdapter {
  name: JamAgent
  supportsSubagents: boolean
  /** argv for a one-shot, tool-less call of a small fast model (a capture's short name) - none: no names */
  namerArgs?(prompt: string): { cmd: string; args: string[] }
  /** argv for a goal-phrased, workspace-jailed run over `goal`. Never full-access, never prompts.
   *  `env` (rare) is merged over the daemon's env - a per-run knob for CLIs whose jail is
   *  configured that way (opencode's OPENCODE_PERMISSION), never a credential channel. */
  spawnArgs(goal: string, opts?: SpawnOpts): { cmd: string; args: string[]; env?: Record<string, string> }
  /** Can it copy one of its own sessions (`opts.fork`)? */
  forks?: boolean
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
  edited?: number            // when its text (rev) was last edited by the owner, if it was
  note?: string              // "dropped - not an ask", "someone else - context only"
}

export interface Brief {
  asks: Msg[]
  history: Msg[]
  capture?: Payload          // a capture's frozen payload: the record, your edit, the reviewed run
  follows?: { asks: Msg[]; result: string }
  /** a wrap-up's sealed content (Part 5): what the session record is written from */
  wrapup?: { content: import('./session.ts').Wrapup; hash: string }
}

// ---- captures (Part 3) ---------------------------------------------------------------------------

/** An element as a frame describes it (safeBundle): never a field's value or a secret's words. */
export interface Bundle { tag?: string; quote?: string; testId?: string; ariaLabel?: string; role?: string; cssPath?: string; source?: string }
export interface View { board?: string; frames?: string[]; theme?: string; viewport?: string; width?: number; height?: number; variant?: string; zoom?: number; mode?: string }
export type Step = { at: number; frame?: string } & (
  | { event: 'words'; text: string; words?: { w: string; at: number }[] }
  | { event: 'note'; text: string }
  | { event: 'pick' | 'click' | 'hover'; point?: number; bundle: Bundle; mode: 'canvas' | 'interact' | 'play'; selects?: boolean }
  | { event: 'field'; bundle: Bundle; value: string }
  | { event: 'screen'; to: string } | { event: 'scroll'; y: number }
  | { event: 'view'; view: View }
  | { event: 'select'; frames: string[] }
  | { event: 'device'; frame: string; viewport: string; width: number; height: number }
  | { event: 'theme'; theme: 'light' | 'dark' }
  | { event: 'copied'; what: 'path' | 'image'; frame: string }
  | { event: 'interact'; on: boolean }
  | { event: 'picture'; id: string; why: 'key' | 'pick' | 'end' }
  | { event: 'missing'; what: string })
/** The sealed capture (design/.local/jam/captures/<id>.json). No category: a capture is what you said and did. */
export interface CaptureRecord {
  format: 'marver.jam.capture'; v: 1; id: string
  context: { canvas: string; board: string; session?: string; reviewing?: { card: string; batch: string; rev: number }
    /** a capture that continues a draft ended too soon: that draft's id, and when recording resumed
     *  (every step before it is the draft's, moved up to close the pause) */
    resumes?: { id: string; at: number }
    /** sealed by its page leaving (0.26.1): as it stood, with a missing step - always a draft, even with `jam.capture: 'at-once'` */
    interrupted?: true
    /** ended with ⇧E (Stop to review): it waits for its read-back; ended with E it is queued as soon as it is sealed */
    review?: true }
  view: View; timeline: Step[]; pictures: string[]
  /** each frame it is about, at the size it was on screen (a device, or a custom width): its run is pictured
   *  before and after at that size */
  sizes?: Record<string, { w: number; h: number; play?: true }>
}
/** What a capture card's brief carries, frozen at confirm. `note` marks a capture that is context, not an ask. */
export interface Payload { record: CaptureRecord; recordHash: string; edited?: string; reviewed?: Reviewed; note?: string
  /** when `edited` was last set (an edit made in the read-back is as new as itself among its notes) */
  editedAt?: number
  /** notes written in its read-back after it ended, in order */
  added?: { at: number; text: string; id?: string }[] }
/** The run a capture was made while reviewing: its ask (and, for a capture, its own record and edit) and the result. */
export interface Reviewed { asks: Msg[]; result: string; capture?: { record: CaptureRecord; recordHash: string; edited?: string; added?: { at: number; text: string; id?: string }[] } }

export interface Card {
  id: string                 // 'c-' + the first event id, or the capture / wrap-up id
  kind: CardKind             // what made the card - a source, not a category
  board: string
  frames: string[]           // every frame it names
  thread?: string            // the thread it lives in
  capture?: string           // the capture this thread was made for (M2)
  events: string[]           // the owner's asks it holds, in order - all ledgered
  when?: Record<string, number>   // each ask's time, so asks merged from several cards stay in order
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
  name?: string              // a capture's title as you named it (Rename) - in place of its first words
  autoName?: string          // a short name a small model gave it from its words, as it landed (yours wins)
  session?: string           // the session it was made in (a capture), or whose record it writes (a wrap-up)
  verdict?: 'looks good' | 'more work'   // your verdict on its review (the session record copies it)
  /** a capture card: the sealed record's hash, your edit (with its hash, ledgered at confirm) and the
   *  reviewed run it followed - what every brief on its thread carries */
  payload?: { recordHash: string; edited?: string; editedAt?: number; editedHash?: string; reviewed?: Reviewed; added?: { at: number; text: string; id?: string }[] }
  /** the run on screen when this capture started (a capture made during a review) */
  reviewing?: { card: string; batch: string; rev: number }
  /** a recoverable step in flight - confirm (or keep from the read-back) and More work: the exact
   *  comment it writes, so a crash resumes it and a retried request finds it done */
  pending?: { op: 'confirm' | 'more'; end?: 'queued' | 'kept'; event: import('../../shared/events.ts').CommentEvent }
  shared?: number            // how many times it answered `shared` (a second one fails it)
  /** back in the queue from a run that left its session while another runner held one of its frames (F4), or - naming no
   *  frame - while anything else ran (F5): it waits for every frame to be free, or with none to run alone (never formed
   *  beside another run again), and runs spawned when `spawn` - the decision it had.
   *  What that run had goes to the run formed from it: the frames it made (`created`, a run of one) and its pictures
   *  from before its first edit (`shots`) - its frames given as it worked are in `frames` already. `loose`: it named no frame
   *  when it went back (F5) - it runs alone whatever frames it was given as it worked */
  alone?: { spawn?: true; why?: string; created?: string[]; shots?: { frame: string; before: string; at?: number }[]; loose?: true }
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
  /** a capture that asked for something new: its thread moves onto the frame its run made (done at delivery) */
  hosts?: { member: string; frame: string }[]
  /** frames its run made (kept as soon as found: a rerun after a crash pictures them again and hosts from them) */
  created?: string[]
  /** the frames there were before its first attempt (a rerun compares with these) */
  before?: string[]
  /** the scenes there were before its first attempt, a frame or a shared file in each (F5): one it made is its own whole -
   *  its `_` files are no shared file it changed, a rerun after a restart too */
  scenes?: string[]
  /** the scenes its run made (F5): not there before its first attempt, and its first frame there given to this run (`--run`)
   *  or found as its own - never one another run made first. Its whole: its `_` files are no shared file it changed */
  madeScenes?: string[]
  /** something else ran beside it at some point (another job, a terminal hold): a frame that appeared is no one's */
  crowded?: boolean
  early?: { body: string; asks: boolean; commentId: string; ts: number }
  note?: string              // why it failed (two failed attempts) - what a card that follows it reads
  undelivered?: boolean      // its results are saved but could not be posted: Retry posts them, never reruns
  posted?: boolean           // every reply and reanchor of `results` is in the log
  /** before and after pictures of every reserved frame, for a batch that holds a capture (picture ids) */
  shots?: { frame: string; before?: string; beforeAt?: number; after?: string; same?: boolean; new?: boolean }[]   // `same`: the run left it as it was; `new`: the run made it; `beforeAt`: when its before was taken
  model?: string
  /** who runs it (spec 29b): the owner's session, a copy of it, or a fresh agent - and why, when it is not the obvious one */
  runner?: { kind: 'session' | 'fork' | 'fresh'; agent: string; conn?: string; session?: string; why?: string }
  /** offered to a session (that incarnation of its connection), not taken yet */
  offer?: { conn: string; inc: string; at: number }
  /** taken by a session (`marver jam next`): which incarnation and process took it, its handle's generation, and its
   *  last word (say, progress) */
  claim?: { conn: string; inc: string; pid?: number; gen: number; at: number; progress: number; stalled?: boolean; stopping?: 'background' | 'drop'
    /** its final message, stored at `done` under the lock: the completion boundary (a restart delivers it from here) */
    result?: string
    /** the owner gave it back after it stalled: the session is told to carry on, until its next word */
    resumed?: boolean }
  /** the decision taken when a session let it go (released, withdrawn, stopped for the background): it runs spawned,
   *  whatever routing says after - a restart in between honours it. `queue`: under `jam.runner: 'session'`, a run that
   *  may not be held beside a run on one of its frames goes back to the queue (never spawned, never waiting with the frame) */
  handoff?: 'spawn' | 'queue'
  /** why an offer to your session was taken back - the copy that runs it says so */
  handoffWhy?: string
  /** what its spawned runs may use, fixed when it was first run (a restart runs it the same way) */
  power?: { mcp: boolean; skills: boolean }
  /** other people's words reached it (`jam.others` when it was formed) */
  others?: boolean
  /** the last generation handed out - a release or a stop keeps it, so an old handle stays refused */
  gen?: number
  /** the owner dropped it while a session held it: it fails, never runs elsewhere */
  dropped?: boolean
  /** formed beside runs of this session incarnation, sharing a frame with them (F4) - or, naming no frame, beside whatever
   *  runs (F5): only it may run it - offered to it, claimed by it, or back in the queue; a run of anyone else never shares a
   *  frame, and one with no frame spawned runs alone */
  share?: { conn: string; inc: string }
  /** the runs it shared a frame with when it was formed (words only: the ping, the brief) */
  overlaps?: string[]
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
  run?: { since: number }    // the lane's run: captures made since then (queue.ts touchRun)
  session?: { id: string; since: number }   // the Jam session running now (Part 5): its id and when it began
  /** a session's requests that changed something, with the answer each got (spec 29b): the same request again gets it again */
  receipts?: Record<string, { at: number; out: Record<string, unknown>; op?: string; batch?: string }>
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
