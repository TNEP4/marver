/**
 * The Live Jam daemon - a module inside the long-lived dev server.
 *
 * The loop (spec 27): watch design/comments/ (dir-watch + ~5s rescan) → the queue ingests owner
 * events (queue.ts: only a ledgered tag makes a card) → when a slot frees, claim what can run - the
 * queued cards of one board on one frame make one batch, up to 8, with every brief frozen as text
 * and the packet written to its file → spawn one headless agent (adapter) on a goal-phrased prompt
 * that names the file → split its final message into one reply per member → write every result
 * into the journal BEFORE posting anything → post each reply with a deterministic id → move the
 * cards. A tag's card ends done ("replied") - its reply is in its thread; nothing raises a notice
 * but a question or a failure.
 *
 * Startup is a barrier: nothing is scheduled until every orphan is fenced (`pgid`), the CLI holds
 * are restored, batches with results are reconciled (posted, never rerun) and the rest re-armed.
 *
 * `createJam` is the loop with no timers or lock (a test drives `tick()` directly with an
 * injected adapter); `startJam` wraps it with the repo lock, dir-watch, and rescan interval.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { tmpdir } from 'node:os'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, watch as fsWatch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { toFrameId } from '../manifest.ts'
import { appendEvents, readLog, replay, type CommentEvent } from '../comments.ts'
import type { JamConfig } from '../config.ts'
import { localProfile } from '../profile.ts'
import { adapters } from './adapter/index.ts'
import { workActivity } from '../work.ts'
import { acquireLock, releaseLock } from './journal.ts'
import { buildPacket, goalText, packetPath, parseAgentText, parseMembers, refusedAsk, sharedWhy } from './packet.ts'
import { uncheckedAnchor, type AnchorCheck, type AnchorLook, type AnchorTarget } from '../../shared/anchor.ts'
import { ownerOnly, act, addCapture, addWrapup, endSession, moreWrapup, startSession, textOf, wrapupIntact, wrapupOf, answeredSince, captureIntact, beginStep, captureComment, conflictStep, createQueue, ctxFor, endStep, looksGood, payloadKey, redelivering, requeue, joinAlone, runsAlone, sameComment, stillOwned, undelivered, fail, form, pending, prune, settle, type Queue, type Settled } from './queue.ts'
import { jamReservations, restoreHolds } from './reserve.ts'
import { jamLive, type QueueView } from './live.ts'
import type { Batch, Brief, Card, JamAdapter, JobPacket, Journal, Msg, Reanchor, Result } from './types.ts'
import { CAPTURE_ID, captureFrames, captureWords, checkRecord, continues, firstPoint, picturePath, readCapture, storeCapture } from './capture.ts'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { logJam } from '../perf-jam.ts'
import { has as ledgerHas, record as ledgerRecord } from './ledger.ts'
import { buildWrapup, moreOf, readWrapup, recordFile, recordPathProblem, SESSION_ID, storeWrapup } from './session.ts'
import { sessionBrief } from './session-brief.ts'
import { isApproval } from '../../shared/approval.ts'
import { createRuns, handleOf, type AgentRun, type Choice, type Runs } from './runs.ts'
import { connDir, readConn } from './conn.ts'
import { reqDir } from './transport.ts'
import { hookBin } from './connectors.ts'
import { onPath, AGENT_BIN, type JamAgent } from './agent.ts'
import type { SpawnOpts } from './types.ts'

const LEASE_MS = 12 * 60_000
const JOB_TIMEOUT_MS = 10 * 60_000   // high-fi rebuilds legitimately run 5-8 min; 5 min was fencing good work
const MAX_ATTEMPTS = 2
const MAX_OUT = 2_000_000
const RESCAN_MS = 5_000
/** How often a card held by a chat agent's `work start` looks again. */
const HOLD_RECHECK_MS = 2_000

export interface JamDaemon { stop(): void }
export interface JamCore {
  tick(): Promise<void>
  stop(): void
  snapshot(): Journal
  view(): QueueView
  act(id: string, rev: number, action: string, body?: string): Promise<{ ok: boolean; card?: Card; error?: string }>
  /** A sealed capture from the page (POST /jam/capture): stored once - ended with E, its card made queued; with ⇧E, a
   *  draft. `held`: an E capture the queue would not take, left a draft (why, in words). */
  capture(record: unknown): Promise<{ ok: boolean; card?: Card; error?: string; held?: string }>
  /** Is this capture's record still the one sealed (its bytes hash to what its card holds)? Resume
   *  starts only from an intact record. */
  sealed(id: string): boolean
  /** ingest now (the page's comment route, right after it appends) */
  poke(): Promise<void>
  /** The Jam session (Part 5): start one, or end it - with no record, or with a wrap-up that writes one. */
  session(op: { action: 'start'; id: string } | { action: 'end'; id: string } | { action: 'wrapup'; id: string; instructions: string; includeTalk: boolean; tags: number; board: string }): Promise<{ ok: boolean; session?: { id: string; since: number } | null; card?: Card; error?: string }>
  /** A session record's file and what it says now, and the agent's reply on it. */
  record(id: string): { file: string; text: string | null; reply?: string } | null
  /** Could the session's record be written now? Why not, or null - asked before its talk is ended. */
  canWrap(id: string): string | null
  /** Tags written during the session running (answered in their threads): the wrap-up sheet's one line. */
  tags(id: string): number
  /** A capture of a session is open on a page (recording, sealing, waiting to send) - or no longer. Renewed
   *  every 20 s by its page while it is; one not renewed for a minute (its tab gone) is forgotten. */
  /** 'ended': the session is over - the capture is not in it */
  captureOpen(capture: string, session: string, on: boolean): 'ok' | 'ended'
  /** Session runs (spec 29b): the requests from sessions, the offers, the stalls - what `startJam` ticks. */
  runs: Runs
}
/** Side-effect hooks the dev server wires up (presence glow, instant reply delivery).
 *  Optional, so tests stay pure. */
export interface JamHooks {
  work?(frame: string | undefined, on: boolean): void
  /** The daemon wrote events (reply/reanchor) to `board` - nudge clients to fetch NOW
   *  instead of waiting out the 30s comment poll. */
  changed?(board: string): void
  /** Is a CHAT-driven agent working on this frame right now (`marver work start`)? Then a job
   *  on it waits - two agents never edit one file at once - and runs once the frame is free. */
  held?(frame: string): boolean
  /** Any `work start` hold at all - an exclusive job waits for every one to end. */
  anyHold?(): boolean
  /** Call `fn` whenever a terminal (`marver work`) hold exists after a change - however briefly; returns the unsubscribe. */
  watchHolds?(fn: () => void): () => void
  /** The queue changed - push it to pages (sh:jam-queue). */
  queue?(): void
  /** Shoot one frame into a jam picture (the dev server's shootFrame); null when it fails - a
   *  missing picture, never a failed job. */
  shoot?(frame: string, theme: string, entry: { capture?: string; batch?: string }, size?: { w: number; h: number }): Promise<string | null>
  /** Find a re-pin's element in the rendered frame (the dev server's anchor check, as the CLI's
   *  `comments move`). Absent = the anchor is written unchecked. */
  anchor?(frame: string, target: AnchorTarget, others: { key: string; anchor: unknown }[], look?: AnchorLook): Promise<AnchorCheck>
}

/** What each tool's sandbox holds, as a spawned run is told it - only what it really does (spec 29b v2, 24). */
const SANDBOX_SAYS: Partial<Record<string, string>> = {
  claude: 'the repo is writable, keys are not readable, no network',
  codex: 'the repo is writable, no network; Codex\'s reviewer judges anything more',
  cursor: 'the repo is writable, no network',
}

/** Kill a whole process group (the child is detached, so pid === pgid). Best-effort. */
const fenceGroup = (pid?: number) => { try { if (pid) process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }

/**
 * What a spawned agent is allowed to inherit.
 *
 * Agents get the environment because they need it - PATH, HOME, the API key
 * their own CLI signs in with. `MARVER_CLI_TOKEN` is the exception: it is the
 * operator's credential for the PUBLISHED canvas, it is accepted as a shell
 * fallback by `comments connect`, and an agent is the one process on this machine
 * that is running somebody else's instructions. Handing it over would let a
 * prompt-injected agent take the published canvas, which is a much larger blast
 * radius than the frames it was asked to edit.
 *
 * Exported so the removal is testable: a spawn option nobody asserts is a spawn
 * option that quietly grows back.
 */
export function agentEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // ...and a session's own handles (spec 29b): a `marver dev` started from inside Claude Code or Codex carries
  // that session's inbox and ids, and a run Marver spawns must never post to that inbox, register as that
  // session, or pass for it. MARVER_JAM_BACKGROUND keeps every hook of ours quiet inside it.
  const { MARVER_CLI_TOKEN: _withheld, CLAUDE_CODE_MESSAGING_SOCKET: _s, CLAUDE_CODE_MESSAGING_TOKEN: _t, CLAUDE_CODE_SESSION_ID: _i, CLAUDE_PID: _p, CLAUDE_CODE_SESSION_ATTENDED: _a, CODEX_THREAD_ID: _ct, CODEX_SESSION_ID: _cs, ...rest } = from
  return { ...rest, MARVER_JAM_BACKGROUND: '1' }
}

const FRAME_FILE = /\.(tsx|jsx|html)$/

/** Every frame FILE under design/scenes, as `frame id -> mtimeMs`. Used to see which frames the
 *  agent creates or edits mid-job (so the working glow can follow the work, not sit on the frame
 *  the comment happened to be pinned to). Infra files (`_layout`, `_fixtures`) are skipped. */
const sceneFrameMtimes = (root: string): Map<string, number> => {
  const scenesDir = join(root, 'design', 'scenes')
  const out = new Map<string, number>()
  let entries: string[]
  try { entries = readdirSync(scenesDir, { recursive: true }) as string[] } catch { return out }
  for (const rel of entries) {
    const parts = rel.split(/[\\/]/)
    const base = parts[parts.length - 1]
    if (!FRAME_FILE.test(base) || base.startsWith('_') || parts.slice(1, -1).some((s) => s.startsWith('_'))) continue   // as scanFrames: #8
    try { out.set(toFrameId(`scenes/${rel}`), statSync(join(scenesDir, rel)).mtimeMs) } catch { /* vanished mid-walk */ }
  }
  return out
}

/** The early ack posts VERBATIM, so a first line that narrates the agent's plan instead of
 *  addressing the owner must not ship. Deliberately NARROW - "acknowledg" only ever appears
 *  in meta-talk (a real ack never names itself), and the openers are pure plan phrasing.
 *  A skipped line just promotes the NEXT streamed text to ack; worst case is a later ack,
 *  never a lost one (the final reply posts regardless). */
export const metaNarration = (text: string): boolean =>
  /acknowledg/i.test(text) || /^(let me |i'?ll start|i will start|first,? i |my plan|i'?m going to start|i am going to start)/i.test(text.trim())

/** Every file under design/ that is not a frame - the shared design source and assets a job may
 *  not edit - as `path -> mtimeMs`. The comment logs, the journal and pictures (.local), the board
 *  files, the build and the generated manifest are not design source. */
const sharedMtimes = (root: string): Map<string, number> => {
  const design = join(root, 'design')
  const out = new Map<string, number>()
  let entries: string[]
  try { entries = readdirSync(design, { recursive: true }) as string[] } catch { return out }
  for (const rel of entries) {
    const parts = rel.split(/[\\/]/)
    if (parts[0] === 'comments' || parts[0] === 'boards' || parts[0].startsWith('.') || rel === 'manifest.json') continue
    const base = parts[parts.length - 1]
    const frame = parts[0] === 'scenes' && FRAME_FILE.test(base) && !base.startsWith('_') && !parts.slice(1, -1).some((x) => x.startsWith('_'))
    if (frame) continue
    try { const st = statSync(join(design, rel)); if (st.isFile()) out.set(`design/${rel.split(/[\\/]/).join('/')}`, st.mtimeMs) } catch { /* vanished */ }
  }
  return out
}

/** Why a `shared` file is refused as the disk sees it, or null: past the lexical check (any case - this filesystem
 *  may not care), its nearest existing ancestor must resolve inside design/, and the resolved path must still be
 *  shared design source - a symlink cannot alias local state, a board file or the outside. The reason is the
 *  validator's own (the owner reads it, F1). */
export function canonicalSharedWhy(root: string, f: string): string | null {
  const lexical = sharedWhy(f) ?? sharedWhy(f.toLowerCase())
  if (lexical) return lexical
  try {
    const design = realpathSync(join(root, 'design'))
    let at = join(root, f)
    const tail: string[] = []
    // walk up to the nearest path that EXISTS AS AN ENTRY (lstat: a dangling symlink is one) - and
    // realpath it, which throws on a dangling link, so a link to nowhere is refused
    for (;;) { try { lstatSync(at); break } catch { tail.unshift(basename(at)); at = dirname(at) } }
    const rel = relative(design, join(realpathSync(at), ...tail))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return 'it is a link that leads outside the design folder'
    const to = `design/${rel.split(sep).join('/')}`
    const why = sharedWhy(to.toLowerCase())
    return why ? `it is a link to ${to}, and ${why}` : null
  } catch { return 'it is a link that leads nowhere' }
}
/** A `shared` file as the disk sees it (`canonicalSharedWhy` found nothing against it), else null. */
export function canonicalShared(root: string, f: string): string | null {
  return canonicalSharedWhy(root, f) ? null : f
}

/** The loop, without timers/watch/lock. Loads the queue (upgrading a v1 journal, baselining a
 *  fresh one); the first `tick()` recovers what a dead process left (the startup barrier), and
 *  every tick ingests, claims what can run and waits until the work is idle. */
export function createJam(root: string, cfg: JamConfig, adapter: JamAdapter, log: (m: string) => void = () => {}, hooks: JamHooks = {}): JamCore {
  const commentsDir = join(root, 'design', 'comments')
  let stopped = false
  const q0: Queue = createQueue(root, (fence) => {
    for (const pid of fence) fenceGroup(pid)
    log(`  jam: only comments that tag @marver start work now - plain replies are listed in \`npx marver marks\` for your agent`)
  }, () => !stopped)

  // a stopped daemon never writes the journal again: a timer or a delivery still in flight when it
  // stopped must not overwrite what the server that replaced it wrote
  const q: Queue = {
    get j() { return q0.j },
    ctx: () => q0.ctx(),
    lock: (fn) => q0.lock((j, ctx) => { if (stopped) throw new Error('jam stopped'); return fn(j, ctx) }),
    persist: () => { if (!stopped) q0.persist() },
  }
  const activeChildren = new Set<ChildProcess>()   // concurrent jobs (bounded by jam.concurrency)
  const running = new Map<string, Promise<void>>()   // batchId -> its run
  const runningBatches = new Map<string, Batch>()
  /** every run that starts, counted: a run knows whether another began while it ran */
  let batchStarts = 0

  const runAgent = (ad: JamAdapter, opts: SpawnOpts | undefined, goal: string, onSpawn: (pid?: number) => void, onEarly?: (text: string, asks: boolean, model?: string) => void): Promise<AgentRun> =>
    new Promise((resolve) => {
      const adapter = ad
      const { cmd, args, env } = adapter.spawnArgs(goal, opts)
      let child: ChildProcess
      // stderr is discarded at the OS level: an undrained pipe would fill and block the child.
      // PWD is pinned to the workspace: spawn's cwd does not update the inherited env var, and
      // some CLIs (opencode, verified) trust PWD over getcwd - without this, a dev server whose
      // own cwd differs from the repo root would have the agent editing the WRONG directory.
      try { child = spawn(cmd, args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...agentEnv(), ...env, PWD: root } }) }
      catch { return resolve({ reply: '', asks: false, ok: false, reanchors: [] }) }
      activeChildren.add(child)
      try { onSpawn(child.pid) } catch { /* pgid persist failed; the run still proceeds, fencing degrades */ }
      let out = ''
      let lineBuf = ''          // scan complete stdout lines for the agent's FIRST message
      let earlyFired = !onEarly || !adapter.earlyText
      let settled = false
      // a UTF-8 char split across chunks must not become replacement bytes mid-JSONL
      const decoder = new StringDecoder('utf8')
      const settle = (r: AgentRun) => {
        if (settled) return
        settled = true; clearTimeout(to); activeChildren.delete(child); resolve(r)
      }
      const to = setTimeout(() => { fenceGroup(child.pid); settle({ reply: '', asks: false, ok: false, reanchors: [] }) }, JOB_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer) => {
        const d = decoder.write(chunk)
        out += d; if (out.length > MAX_OUT) out = out.slice(-MAX_OUT)
        if (earlyFired) return
        lineBuf += d
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop() ?? ''
        for (const line of lines) {
          const hit = adapter.earlyText!(line)
          if (!hit) continue
          // A first message that already carries the completion fence IS the completion, not an
          // ack: codex streams a single message at the very end, and a fast claude run can do the
          // same. Post what is INSIDE the block - never the raw fence - and since that equals what
          // parse() will return, the final reply dedupes itself instead of doubling up.
          // A fenceless first message is a plain ACK, and models append plan narration to it
          // ("On it.\n\nNow let me gather context..."). The ack is ONE line to the owner, so keep
          // only the first paragraph - the narration after the blank line never reaches the thread.
          // A fenced first message is the real completion; leave its (possibly multi-paragraph) body.
          // One parser either way (packet.ts). A plain ack asks nothing: only the final block can
          // say `ask`, and when its words match the ack the daemon re-flags it - so a flag only
          // ever turns on, the way a question's notice can follow.
          // A fenced first message is parsed the way the final one is - by member (`m1 asks` included);
          // a `shared` or empty block is no ack at all.
          const fenced = /```marver-reply/.test(hit.text)
          const block = fenced ? parseMembers(hit.text, ['m1']).m1 : null
          if (block && !('body' in block)) continue
          const text = block && 'body' in block ? block.body : parseAgentText(hit.text).reply.split(/\n\s*\n/)[0].trim()
          if (!text || metaNarration(text)) continue
          earlyFired = true
          try { onEarly!(text, !!block && 'body' in block && block.asks, hit.model) } catch { /* early delivery is best-effort */ }
          break
        }
      })
      child.on('close', (code) => settle({ ...adapter.parse(out, code ?? 1), raw: out }))
      child.on('error', () => settle({ reply: '', asks: false, ok: false, reanchors: [] }))
    })

  /** Persist each run's raw stream to design/.local/jam-logs/ (gitignored, last 10 kept) - so
   *  "why did it reply THAT" is always answerable from the actual agent output. */
  const logRun = (batchId: string, raw?: string) => {
    if (!raw) return
    try {
      const dir = join(root, 'design', '.local', 'jam-logs')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${batchId}.log`), raw, { mode: 0o600 })
      const files = readdirSync(dir).filter((f) => f.endsWith('.log'))
        .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
      for (const { f } of files.slice(10)) rmSync(join(dir, f), { force: true })
    } catch { /* diagnostics only - never fail the job over a log */ }
  }

  /** House style: never an em/en dash in a reply - a plain dash reads human. */
  const plainDashes = (s: string) => s.replace(/\s*[—–]\s*/g, ' - ')

  const me = () => localProfile(root)
  /** The agent that ran a batch - its runner's, or the one Jam is set to. */
  const harnessOf = (b: Batch) => b.runner?.agent || adapter.name
  /** Post one reply in a card's thread. Deterministic ids - `jam-<batch>-<member>` for the reply,
   *  `jam-e<attempt>-<batch>` for a one-member job's early ack - so posting twice is a no-op. */
  const postReply = (b: Batch, c: Card, member: string, body: string, asks: boolean, model?: string, kind: 'reply' | 'early' = 'reply', alsoChanged?: string[]): { commentId: string; ts: number } => {
    const suffix = kind === 'early' ? `e${b.attempts}-${b.batchId}` : `${b.batchId}-${member}`
    const who = me()
    const reply: CommentEvent = {
      id: `jam-${suffix}`, ts: Date.now(), type: 'reply',
      commentId: `jam-c-${suffix}`, parentId: c.thread,
      board: c.board, author: who, body: plainDashes(body), asks,
      ...(alsoChanged?.length ? { alsoChanged } : {}),
      agent: true, agentMeta: { devUser: who.name, harness: harnessOf(b), model, ...(b.runner ? { runner: b.runner.kind } : {}) },
    }
    appendEvents(commentsDir, c.board, [reply])
    return { commentId: reply.commentId!, ts: reply.ts }
  }

  /** How a spawned run reaches this marver (`jam permit`): the repo's install, else the CLI running now. */
  const marverCmd = (): { cmd: string; args: string[] } => {
    const bin = hookBin(root)
    if (bin) return { cmd: bin, args: [] }
    // this very package: dist/cli.mjs beside the bundle, or src/cli/index.ts from the source (Node runs TypeScript)
    const here = dirname(fileURLToPath(import.meta.url))
    const self = [join(here, 'cli.mjs'), join(here, '..', 'cli.mjs'), join(here, '..', '..', 'cli', 'index.ts')].find((f) => existsSync(f))
    return self ? { cmd: process.execPath, args: [self] } : { cmd: 'npx', args: ['--no-install', 'marver'] }
  }

  // Session runs (spec 29b): the owner's session takes a batch with `marver jam next` and hands it back with `done`
  const runs: Runs = createRuns({
    root, cfg, q, log,
    // routing, ownership or room changed (an offer, a claim, a release, a stop): what waited may start now - a request on
    // a frame your session's run just took, say (Codex's review of the F4 design)
    changed: () => { queueChanged(); pumpSoon() },
    goal: (b, handle, conn) => {
      const as = conn.agent === 'cursor' ? conn.id : undefined
      let packet: JobPacket | null = null
      try { packet = JSON.parse(readFileSync(join(root, packetPath(b.batchId)), 'utf8')) as JobPacket } catch { packet = null }
      return packet ? sessionBrief(packet, handle, as, { agent: conn.agent, conn: conn.id, overlaps: overlapsOf(b, conn) }) : `The packet of this run is missing (${packetPath(b.batchId)}) - release it: \`npx marver jam release ${handle}${as ? ` --as ${as}` : ''}\`.`
    },
    say: (b) => ensureEarly(b),
    ready: () => ready,
    // the session record a wrap-up queues belongs to the session it closes: it goes to your session too
    // a Jam session runs (its own record, written once it ended, is offered to your session by runs.ts - nothing else)
    jamOn: () => !!q.j.session,
    canSpawn: (agent) => Object.hasOwn(AGENT_BIN, agent) && onPath(AGENT_BIN[agent as JamAgent]),
    own: (b, frame) => {
      if (!/^[\w.@+-]+(\/[\w.@+-]+)+$/.test(frame)) return 'name a frame: <scene>/<name>'
      if (b.frames.includes(frame)) return null
      const other = [...runningBatches.values()].find((x) => x.batchId !== b.batchId && x.frames.includes(frame))
      if (other) return `another run is working on ${frame} - make the variant a frame of its own`
      if (hooks.held?.(frame)) return `your agent in chat is working on ${frame}`
      b.frames = [...b.frames, frame]
      // a frame the run made (not there when it began): its review pictures it as new, and it can host the thread
      if (!(b.before ?? []).includes(frame)) { b.created = [...new Set([...(b.created ?? []), frame])]; madeScene(b, frame) }
      reserve()
      return null
    },
    mayHold: (b, conn) => [...runningBatches.values()].every((x) => x.batchId === b.batchId || !x.frames.some((f) => b.frames.includes(f)) || heldBy(x, conn)),
  })
  /** A frame a run made, given to it or found as its own, in a scene that was not there when it began and that no other run
   *  made first: the scene is this run's (F5) - its `_` files are no shared file it changed. Under the lock. */
  function madeScene(b: Batch, frame: string) {
    const sc = frame.split('/')[0]
    if (!b.scenes || b.scenes.includes(sc) || q.j.batches.some((x) => x.madeScenes?.includes(sc))) return
    b.madeScenes = [...(b.madeScenes ?? []), sc]
  }
  /** Is a running batch this session incarnation's (F4): offered to it, taken by it and not stopping, or formed for it -
   *  or done editing (its results saved, being posted)? Two such runs may share a frame: the session coordinates them. */
  function heldBy(x: Batch, c: { id: string; inc: string }): boolean {
    if (x.results) return true
    if (x.handoff) return false
    return (!!x.offer && x.offer.conn === c.id && x.offer.inc === c.inc)
      || (!!x.claim && x.claim.conn === c.id && x.claim.inc === c.inc && !x.claim.stopping)
      || (!!x.share && x.share.conn === c.id && x.share.inc === c.inc && !x.offer && !x.claim)
  }

  /** The runs of this same session incarnation that share a frame with `b` (F4) - named in its brief: their handle (or,
   *  offered and not taken yet, their short id), the frames they share, their title. */
  const overlapsOf = (b: Batch, conn: { id: string; inc: string }) => q.j.batches
    .filter((x) => x.batchId !== b.batchId && x.state === 'claimed' && !x.results && x.frames.some((f) => b.frames.includes(f))
      && ((x.claim && x.claim.conn === conn.id && x.claim.inc === conn.inc) || (x.offer && x.offer.conn === conn.id && x.offer.inc === conn.inc)))
    .map((x) => ({ handle: x.claim ? handleOf(x, x.claim.gen) : `${x.batchId.slice(0, 8)} (offered, not taken yet)`, frames: x.frames.filter((f) => b.frames.includes(f)), title: runs.title(x) }))

  /** A session's early line (`marver jam say`), journaled on the batch before it is posted: posted with the id it
   *  names, once - an id already in the log is not posted again (a restart between the two posts it then). */
  const ensureEarly = (b: Batch): boolean => {
    const e = b.early
    const one = b.members.length === 1 ? q.j.cards.find((c) => c.id === b.members[0].card) : undefined
    if (!e || !one?.thread || stopped) return false
    const id = e.commentId.replace(/^jam-c-/, 'jam-')
    try {
      if (!readLog(commentsDir, one.board).some((x) => x.id === id)) {
        const who = me()
        appendEvents(commentsDir, one.board, [{ id, ts: e.ts, type: 'reply', commentId: e.commentId, parentId: one.thread, board: one.board, author: who, body: plainDashes(e.body), asks: false,
          agent: true, agentMeta: { devUser: who.name, harness: harnessOf(b), ...(b.runner ? { runner: b.runner.kind } : {}) } }])
      }
      hooks.changed?.(one.board)
      return true
    } catch { return false }
  }

  /** Emit reanchor events for threads the agent re-pinned, in the shared anchor format: each
   *  element found in the rendered frame the way `comments move` finds it, unchecked when the
   *  check cannot run, skipped when the frame shows no such element or several. Owner-authored +
   *  agent:true (attributable, never a trigger), deterministic ids so a re-run dedups. */
  const emitReanchors = async (b: Batch, cards: Card[], reanchors: Reanchor[]): Promise<number> => {
    let n = 0
    for (const [k, r] of reanchors.entries()) {
      const m = b.members.find((x) => cards.find((c) => c.id === x.card)?.thread === r.thread) ?? b.members[0]
      const board = m.board
      const threads = replay(readLog(commentsDir, board))
      const t = threads.find((t) => t.id === r.thread)
      if (!t?.frame) { log(`  jam: re-pin skipped - no thread ${r.thread} on ${board}`); continue }
      const others = threads.filter((o) => !o.resolved && o.frame === t.frame && o.id !== t.id).map((o) => ({ key: o.id, anchor: o.anchor }))
      const check: AnchorCheck = hooks.anchor
        ? await hooks.anchor(t.frame, r.target, others, r.look).catch((err) => ({ ok: false as const, unchecked: (err as Error).message }))
        : { ok: false, unchecked: 'no anchor check here' }
      if (stopped) return n   // stopped while the check ran: a successor owns the log now
      if (!check.ok && 'refused' in check) { log(`  jam: re-pin skipped - ${t.frame} shows ${check.refused === 'none' ? 'no' : 'several'} matching elements`); continue }
      const who = me()
      appendEvents(commentsDir, board, [{
        id: `jam-${b.batchId}-${m.id}-r${k}`, ts: Date.now(), type: 'reanchor',
        commentId: t.id, anchor: check.ok ? check.anchor : uncheckedAnchor(r.target), board, author: who,
        agent: true, agentMeta: { devUser: who.name, harness: harnessOf(b) },
      }])
      n++
    }
    return n
  }

  /** A short name for a capture, from its words, by a small fast model (the adapter's namer - Haiku with Claude
   *  Code), as soon as it lands: the lane, the panel and its thread show it. Never over a name you gave it;
   *  nothing when the agent has no namer, the capture has no words, or the call fails (its first words stay). */
  const naming = new Set<string>()
  let namerDir: string | undefined
  // Jam timings (spec 27a Part D), in memory only: when this daemon saw each card enter the queue (a card already
  // queued when it started has no known wait), and each claimed batch's members' waits
  const queuedSince = new Map<string, number>()
  const atBoot = new Set<string>()
  let scanned = false
  const noteQueued = () => {
    try {
      const now = performance.now()
      const queued = new Set<string>()
      for (const c of q.j.cards) if (c.state === 'queued') {
        queued.add(c.id)
        if (!queuedSince.has(c.id)) { queuedSince.set(c.id, now); if (!scanned) atBoot.add(c.id) }
      }
      scanned = true
      for (const k of [...queuedSince.keys()]) if (!queued.has(k)) { queuedSince.delete(k); atBoot.delete(k) }
    } catch { /* the journal is not read yet */ }
  }
  const batchWaits = new Map<string, Map<string, number>>()
  const nameCapture = (id: string) => {
    const c0 = q.j.cards.find((x) => x.id === id)
    if (!adapter.namerArgs || cfg.names === false || !c0 || c0.kind !== 'capture' || c0.name || c0.autoName || naming.has(id)) return
    const cap = readCapture(root, id)
    const words = cap ? [captureWords(cap.record, c0.payload?.edited), ...(c0.payload?.added ?? []).map((a) => a.text)].join('\n').trim() : ''
    if (!words) return
    naming.add(id)
    const prompt = 'Name this design note in 2 to 6 plain words, like a short task title (e.g. "New product page", "Quieter save button"). ' +
      'Reply with the name only - no quotes, no punctuation at the end.\n\nThe note (spoken and written):\n' + words.slice(0, 4000)
    const { cmd, args } = adapter.namerArgs(prompt)
    let out = ''
    let child: ChildProcess
    // in a private folder of its own: no project instructions to read, nothing of the repo in reach
    namerDir ??= mkdtempSync(join(tmpdir(), 'marver-namer-'))
    const cwd = namerDir
    const t0 = performance.now()
    let named = false
    const timed = (ok: boolean) => { if (named) return; named = true; logJam(root, { kind: 'name', capture: id, ms: performance.now() - t0, ok }) }
    try { child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], env: { ...agentEnv(), PWD: cwd } }) } catch { naming.delete(id); return }
    const to = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, 45_000)
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); if (out.length > 4000) out = out.slice(0, 4000) })
    child.on('error', () => { clearTimeout(to); naming.delete(id); timed(false) })
    child.on('close', (code) => {
      clearTimeout(to)
      naming.delete(id)
      if (stopped || code !== 0) { if (!stopped) timed(false); return }
      const name = (out.split('\n').map((l) => l.trim()).find(Boolean) ?? '').replace(/^["'“”‘’`*#\s-]+|["'“”‘’`*.\s]+$/g, '').replace(/\s+/g, ' ').slice(0, 60).trim()
      timed(!!name)
      if (!name) return
      void q.lock((j) => {
        const c = j.cards.find((x) => x.id === id)
        if (!c || c.name || c.autoName) return
        // (its revision stays: a name changes nothing a review or a follow-up was bound to)
        c.autoName = name
        q.persist()
      }).then(() => { titles.delete(id); queueChanged() })
    })
  }

  /** A capture names every frame its run made (hosted on one or not) - and so does work queued on its thread
   *  meanwhile: a tag or a More work waiting on it holds those frames when it runs. At delivery, and when the run
   *  fails (its Retry is a new batch from the card: it must still hold them). Under the lock. */
  const ownCreated = (j: Journal, b: Batch) => {
    if (!b.created?.length || b.members.length !== 1) return
    const live = liveCreated(b)
    const c = j.cards.find((x) => x.id === b.members[0].card)
    if (c) for (const x of j.cards.filter((y) => y === c || (y.state === 'queued' && y.board === c.board && !!c.thread && y.thread === c.thread))) {
      const add = live.filter((f) => !x.frames.includes(f))
      if (add.length) { x.frames = [...x.frames, ...add]; if (x !== c) { x.rev += 1; x.at = Date.now() } }
    }
  }

  /** A capture whose run made a new frame and left every frame it named as it was asked for something new: at
   *  delivery (again after a restart - it is in the batch with the results), its thread moves onto the new frame
   *  (a re-pin naming the frame, frame-level, a deterministic id: written once) and its card names that frame. */
  const hostOnNew = (b: Batch) => {
    const live = new Set(liveCreated(b))
    for (const h of b.hosts ?? []) {
      if (!live.has(h.frame)) continue   // gone since (renamed, removed): the thread stays where it is
      const m = b.members.find((x) => x.id === h.member)
      const c = m && q.j.cards.find((x) => x.id === m.card)
      if (!c?.thread) continue
      const id = `jam-${b.batchId}-${h.member}-host`
      if (readLog(commentsDir, c.board).some((e) => e.id === id)) continue
      const who = me()
      appendEvents(commentsDir, c.board, [{ id, ts: Date.now(), type: 'reanchor', commentId: c.thread, frame: h.frame, board: c.board, author: who, agent: true, agentMeta: { devUser: who.name, harness: harnessOf(b) } }])
    }
  }
  /** The frames a run made that still exist, on a board it works on (one made, then renamed or removed, is not). */
  const liveCreated = (b: Batch): string[] => {
    if (!b.created?.length) return []
    const now = sceneFrameMtimes(root)
    const boards = [...new Set(b.members.map((m) => m.board))]
    const onBoard = (f: string) => boards.some((board) => {
      try { const j = JSON.parse(readFileSync(join(root, 'design', 'boards', `${board}.json`), 'utf8')); return j.auto === true || (Array.isArray(j.nodes) && j.nodes.some((n: any) => n?.frame === f)) } catch { return false }
    })
    return b.created.filter((f) => now.has(f) && onBoard(f))
  }
  /** A frame's size where it sits on a board (its node's width and height), when the board says. */
  const sizeOnBoard = (frame: string, board: string): { w: number; h: number } | undefined => {
    try {
      const n = (JSON.parse(readFileSync(join(root, 'design', 'boards', `${board}.json`), 'utf8')).nodes ?? []).find((x: any) => x?.frame === frame)
      return n && Number.isFinite(n.w) && Number.isFinite(n.h) && n.w > 0 && n.h > 0 ? { w: Math.round(n.w), h: Math.round(n.h) } : undefined
    } catch { return undefined }
  }

  /** Frames that exist now and did not when the run began, on a board the batch works on - three at most. */
  const newFrames = (start: { has(f: string): boolean }, b: Batch): string[] => {
    const boards = [...new Set(b.members.map((m) => m.board))]
    const onBoard = (f: string) => boards.some((board) => {
      try { const j = JSON.parse(readFileSync(join(root, 'design', 'boards', `${board}.json`), 'utf8')); return j.auto === true || (Array.isArray(j.nodes) && j.nodes.some((n: any) => n?.frame === f)) } catch { return false }
    })
    return [...sceneFrameMtimes(root).keys()].filter((f) => !start.has(f) && onBoard(f))
  }

  const realShared = (f: string) => canonicalShared(root, f)
  const cards0 = (b: Batch) => b.members.map((m) => q.j.cards.find((c) => c.id === m.card)).filter((c): c is Card => !!c)

  const changedBoards = (b: Batch) => { for (const board of new Set(b.members.map((m) => m.board))) hooks.changed?.(board) }
  /** The session that takes the work now and its room - `record`: the one a session's record goes to (F5) - looked at once */
  const takersNow = () => {
    let on: ReturnType<Runs['takes']>[] | undefined
    return (record: boolean) => (on ??= [runs.takes(), runs.takes(undefined, true)])[record ? 1 : 0]
  }
  /** Does a queued card run alone now (queue.ts runsAlone), with the session that takes the work as it is now (F5) */
  const aloneNow = (taking = takersNow()) => (c: Card) => runsAlone(c, (record) => !!taking(record))
  const reserve = (exclusiveWaiting?: boolean) => {
    if (stopped) return   // the table is the process's: a successor may own it now
    jamReservations.frames = new Map([...runningBatches.values()].flatMap((b) => b.frames.map((f) => [f, b.batchId] as [string, string])))
    const exclusiveRunning = [...runningBatches.values()].some((b) => b.exclusive)
    const alone = aloneNow()
    jamReservations.exclusive = exclusiveRunning ? 'running'
      : (exclusiveWaiting ?? q.j.cards.some((c) => c.state === 'queued' && alone(c))) ? 'waiting' : null
    // results still to be posted (the barrier, a retried delivery): no new hold until they settle
    jamReservations.settling = !ready || delivering.size > 0
  }
  const queueChanged = () => { noteQueued(); try { hooks.queue?.() } catch { /* a push is advisory */ } }
  const settled = (out: Settled[]) => {
    for (const s of out) if (s.notice === 'failed') log(`  jam: ${s.card.id} failed - ${s.card.note}`)
  }

  /** Post a batch's results (each append a no-op if it already landed) and move its cards. Never
   *  runs the agent: a batch with results is reconciled, not rerun. Everything it needs is in the
   *  journal (results, re-pins, the early ack), so a resumed delivery does exactly what the first
   *  one would have. */
  const deliver = async (b: Batch) => {
    if (stopped) return
    // a session's early line is journaled before it is posted: it must be in the thread before the final reply is
    // matched against it - else a reply with the same words would never be posted at all
    if (b.early && !ensureEarly(b)) throw new Error('its early line could not be posted')
    const cards = b.members.map((m) => q.j.cards.find((c) => c.id === m.card)).filter((c): c is Card => !!c)
    const early = b.early
    const posted: Record<string, { reply?: string; answered?: boolean; asked?: number }> = {}
    const loggedTs = (board: string, id: string) => readLog(commentsDir, board).find((e) => e.id === id)?.ts
    for (const m of b.members) {
      const c = cards.find((x) => x.id === m.card)
      const r: Result | undefined = b.results?.[m.id]
      if (!c || !r || !('body' in r) || !c.thread) continue
      const sameAsEarly = !!early && b.members.length === 1 && r.body === early.body
      // a question you answered before it was asked: the early line asked it (or this one repeats it),
      // and you replied after that line - done, no notice, posted as not asking. Equal words only
      // decide whether the early line IS the reply (no second post).
      const earlyAsked = !!early && b.members.length === 1 && (sameAsEarly || early.asks || /\?\s*$/.test(early.body))
      const answered = r.asks && earlyAsked && answeredSince(ctxFor(root), c.board, c.thread, early!.ts)
      if (sameAsEarly) {
        if (r.asks && !early!.asks && !answered) {
          const who = me()
          appendEvents(commentsDir, c.board, [{
            id: `jam-f-e${b.attempts}-${b.batchId}`, ts: Date.now(), type: 'edit', commentId: early!.commentId, asks: true, board: c.board,
            author: who, agent: true, agentMeta: { devUser: who.name, harness: harnessOf(b) },
          }])
        }
        // the early ack is the reply: a shared file the job changed anyway is said on it
        if (r.alsoChanged?.length) {
          const who = me()
          appendEvents(commentsDir, c.board, [{
            id: `jam-ac-${b.batchId}`, ts: Date.now(), type: 'edit', commentId: early!.commentId, alsoChanged: r.alsoChanged, board: c.board,
            author: who, agent: true, agentMeta: { devUser: who.name, harness: harnessOf(b) },
          }])
        }
        posted[m.id] = { reply: early!.commentId, answered, asked: early!.ts }
      } else {
        const p = postReply(b, c, m.id, r.body, r.asks && !answered, r.model, 'reply', r.alsoChanged)
        // the question's own time, as logged - a resumed post is a no-op and keeps the first one's
        posted[m.id] = { reply: p.commentId, answered, asked: loggedTs(c.board, `jam-${b.batchId}-${m.id}`) ?? p.ts }
      }
    }
    hostOnNew(b)
    const repinned = await emitReanchors(b, cards, b.reanchors ?? [])
    if (stopped) return
    changedBoards(b)
    await q.lock((j) => {
      ownCreated(j, b)
      // answered while the reply was being posted, or before a restart: look again, under the lock
      for (const m of b.members) {
        const c = j.cards.find((x) => x.id === m.card)
        const r = b.results?.[m.id]
        const p = posted[m.id]
        if (c?.thread && p && !p.answered && r && 'body' in r && r.asks && p.asked) p.answered = answeredSince(ctxFor(root), c.board, c.thread, p.asked)
      }
      b.posted = true
      settled(settle(j, b, posted))
      q.persist()
    })
    queueChanged()
    const replies = Object.keys(posted).length
    log(`  jam: replied ${replies} of ${b.members.length}${b.model ? ` (${b.model})` : ''}${repinned ? ` · re-pinned ${repinned}` : ''}`)
  }

  const runBatch = async (b: Batch) => {
    // its timing (spec 27a Part D): the pictures before and after, each agent attempt, the delivery; logged once, at its end
    const timing: { beforeMs?: number; agentMs: number[]; afterMs?: number; deliverMs?: number } = { agentMs: [] }
    let timed = false
    // the members as the run began: one its setup turned away still counts (as failed - its card says so)
    const members0 = [...b.members]
    const timeRun = (failure?: 'agent' | 'changed' | 'delivery' | 'other') => {
      if (timed) return
      timed = true
      const waits = batchWaits.get(b.batchId)
      batchWaits.delete(b.batchId)
      logJam(root, { kind: 'run', batch: b.batchId, attempts: b.attempts, ...timing, ...(failure ? { failure } : {}),
        members: members0.map((m) => { const c = q.j.cards.find((x) => x.id === m.card); return { kind: c?.kind, waitMs: waits?.get(m.card), outcome: failure || !b.members.includes(m) ? 'failed' : c?.state } }) })
    }
    // every end writes its line - setup that threw included (any end not timed below is "other")
    try {
    // a frame that appears during a run is this run's only if nothing else ran beside it (no other job could
    // have made it)
    const myStart = ++batchStarts
    const aloneAtStart = [...runningBatches.keys()].every((k) => k === b.batchId)
    // and nothing working in a terminal (a `marver work` hold) at any point while it ran - however briefly
    let crowded = !!hooks.anyHold?.()
    // (kept at once: a crash right after must not forget it)
    const markCrowded = (x: Batch) => { if (x.crowded) return; void q.lock(() => { x.crowded = true; q.persist() }) }
    const unwatch = hooks.watchHolds?.(() => { crowded = true; markCrowded(b) }) ?? (() => {})
    // a run starting beside others: each of them has company too, from now
    for (const o of runningBatches.values()) if (o !== b) markCrowded(o)
    // The packet the agent reads is made again from the journal right before every run - its members,
    // their kinds, their frozen briefs - never trusted from the file on disk; a session record's content
    // comes from its seal, checked (a changed file cannot point the agent anywhere else)
    const bad: string[] = []
    const logs = new Map<string, ReturnType<typeof replay>>()
    const threadsOf = (board: string) => { let t = logs.get(board); if (!t) logs.set(board, (t = replay(readLog(commentsDir, board)))); return t }
    const members: JobPacket['members'] = []
    // (a batch from an older journal kept its briefs only in the packet: those are read from it, by card -
    // never a member's kind or a record's content, which come from the journal and the seal)
    let disk: JobPacket | null = null
    try { disk = JSON.parse(readFileSync(join(root, packetPath(b.batchId)), 'utf8')) as JobPacket } catch { disk = null }
    for (const m of b.members) {
      const c = q.j.cards.find((x) => x.id === m.card)
      const kept = m.brief ?? (c && c.kind !== 'wrapup' ? disk?.members.find((x) => x.card === m.card && x.id === m.id)?.brief : undefined)
      if (!c || !kept) { bad.push(m.card); continue }
      let brief = kept
      if (c.kind === 'wrapup') {
        const w = readWrapup(root, wrapupOf(c))
        if (!w || !wrapupIntact(q.ctx(), c) || recordPathProblem(root, w.wrapup.file)) { bad.push(m.card); continue }
        brief = { ...brief, wrapup: { content: w.wrapup, hash: w.hash } }
      } else if (brief.wrapup) { const { wrapup: _w, ...rest } = brief; brief = rest }   // only a record carries one
      // owner-only (spec 29b v2, 7): a brief frozen with other people's words - before 0.28, when it carries no policy
      // of its own - is cleaned before any runner reads it, and kept cleaned
      if (b.others === undefined || (b.others && !runs.settings().others)) { brief = ownerOnly(brief, me()); m.brief = brief }
      const t = c.thread ? threadsOf(m.board).find((x) => x.id === c.thread) : undefined
      members.push({ id: m.id, card: c.id, kind: c.kind, board: m.board, ...(c.thread ? { thread: c.thread } : {}), frames: c.frames,
        ...(t?.anchor !== undefined ? { anchor: t.anchor } : {}), brief })
    }
    if (bad.length) {
      await q.lock((j) => { for (const id of bad) { const c = j.cards.find((x) => x.id === id); if (c && c.state === 'working') { c.state = 'failed'; c.note = c.kind === 'wrapup' ? 'the session record changed after it was written - write it again' : 'interrupted - Retry'; c.rev += 1; c.at = Date.now() } } q.persist() })
      b.members = b.members.filter((m) => !bad.includes(m.card))
      if (!b.members.length) { await q.lock((j) => { const x = j.batches.find((y) => y.batchId === b.batchId); if (x) x.state = 'failed'; q.persist() }); queueChanged(); timeRun('changed'); return }
    }
    const packet = buildPacket(b.batchId, members, b.frames, b.exclusive ? [...new Set(cards0(b).flatMap((c) => c.exclusive ?? []))] : undefined)
    writeFileSync(join(root, packetPath(b.batchId)), JSON.stringify(packet, null, 1), { mode: 0o600 })
    const cards = () => b.members.map((m) => q.j.cards.find((c) => c.id === m.card)).filter((c): c is Card => !!c)
    // Presence glow that FOLLOWS the work. Jam agents have no shell to run `marver work`, so the
    // daemon moves the glow itself: the reserved frames light up at once ("I heard you"), then as
    // the agent CREATES or EDITS frames the glow moves to those. The tick also re-marks every lit
    // frame to keep its lease alive.
    const lit = new Set<string>()
    const light = (f?: string) => { if (f && !lit.has(f)) { hooks.work?.(f, true); lit.add(f) } }
    const clearGlow = () => { for (const f of lit) hooks.work?.(f, false); lit.clear() }
    const startMtimes = sceneFrameMtimes(root)
    const sharedBefore = b.exclusive ? null : sharedMtimes(root)
    const sceneOf = (f: string) => /^design\/scenes\/([^/]+)\//.exec(f)?.[1]
    // the frames there were before its FIRST attempt, kept with the batch: a rerun after a crash still knows which
    // frames its run made (and whether anything else could have)
    // A rerun after a restart: a frame that appeared while nothing was watching (the daemon down) is no one's -
    // it joins `before`; only frames this run was seen to make (kept in `created`) stay its own
    // (and the scenes there were: one it made is its own whole, a rerun too - F5, Codex's review)
    await q.lock(() => {
      const made = new Set(b.created ?? [])
      b.before = [...new Set([...(b.before ?? []), ...[...startMtimes.keys()].filter((f) => !made.has(f))])]
      if (sharedBefore && !b.scenes) b.scenes = [...new Set([...[...sharedBefore.keys()].flatMap((f) => sceneOf(f) ?? []), ...[...startMtimes.keys()].map((f) => f.split('/')[0])])]
      q.persist()
    })
    if (crowded || !aloneAtStart) await q.lock(() => { b.crowded = true; q.persist() })
    // frames this run made, found as it runs (every beat) and once more as it ends - kept with the batch and held
    // with its frames the moment they are found, so a crash after cannot lose them. Only for a batch of one
    // capture that nothing ran beside.
    const one0 = b.members.length === 1 ? q.j.cards.find((c) => c.id === b.members[0].card) : undefined
    const discover = async () => {
      if (one0?.kind !== 'capture' || b.crowded || crowded || !aloneAtStart || batchStarts !== myStart || hooks.anyHold?.()) return
      const found = newFrames(new Set(b.before ?? []), b).filter((f) => !(b.created ?? []).includes(f))
      if (!found.length) return
      await q.lock(() => { b.created = [...(b.created ?? []), ...found]; b.frames = [...new Set([...b.frames, ...b.created])]; for (const f of found) madeScene(b, f); q.persist() })
      reserve()
    }
    const touched = new Set<string>()
    for (const f of b.frames) light(f)
    // a batch that holds a capture shoots its reserved frames before and after - both while it still
    // holds them, so no other job's edit lands in between (a batch of tags alone shoots none)
    const capturing = cards().some((c) => !!c.capture)
    const theme = (() => { const c = cards().find((x) => x.capture); return (c && readCapture(root, c.capture!)?.record.view.theme) || 'light' })()
    // each frame at the size it was on screen when captured (a device, or a width you dragged it to)
    const sizes: Record<string, { w: number; h: number }> = Object.assign({}, ...cards().flatMap((c) => (c.capture ? [readCapture(root, c.capture)?.record.sizes ?? {}] : [])))
    const shoot = async (when: 'before' | 'after') => {
      if (!capturing || !hooks.shoot) return
      const shots: NonNullable<Batch['shots']> = b.shots ?? b.frames.map((frame) => ({ frame }))
      for (const s of shots) { if (stopped) return; if (s.new) continue; const id = await hooks.shoot(s.frame, theme, { batch: b.batchId }, sizes[s.frame]).catch(() => null); if (id) { s[when] = id; if (when === 'before') s.beforeAt = Date.now() } }
      // a frame the run left exactly as it was (the same pixels) is marked: the review shows the frames
      // that changed, not every frame the capture named
      if (when === 'after') for (const s of shots) { if (s.before && s.after && samePicture(s.before, s.after)) s.same = true; else delete s.same }
      await q.lock(() => { b.shots = shots; q.persist() })
    }
    if (!b.shots?.some((s) => s.before)) { const t = performance.now(); await shoot('before'); if (capturing) timing.beforeMs = performance.now() - t }   // a retry keeps the first attempt's
    const followWork = () => {
      if (hooks.anyHold?.()) crowded = true
      void discover()
      for (const [id, mt] of sceneFrameMtimes(root)) if (startMtimes.get(id) !== mt) touched.add(id)   // created or edited
      for (const id of touched) light(id)
      for (const f of lit) hooks.work?.(f, true)   // heartbeat: keep every lit frame's lease alive
    }
    let early: { body: string; asks: boolean; commentId: string; ts: number } | undefined
    let run: Awaited<ReturnType<typeof runAgent>> = { reply: '', asks: false, ok: false, reanchors: [] }
    try {
      // Who runs it (spec 29b): the owner's session when it can take it - or already holds it (a restart keeps a
      // session's run its own) - else a copy of that session, else a fresh agent; every one with full power.
      // What a spawned run may use is fixed with the batch the first time it runs (a restart runs it the same way).
      if (!b.power) { const s0 = runs.settings(); await q.lock(() => { b.power = { mcp: s0.mcp, skills: s0.skills }; q.persist() }) }
      // dropped by the owner while a session held it (a restart in between too): it fails, never runs elsewhere
      if (b.dropped) {
        await q.lock((j) => { settled(fail(j, b, 'you dropped it while your session had it')); q.persist() })
        runs.delivered(b.batchId, false, 'the owner dropped it')
        queueChanged(); timeRun('agent'); return
      }
      let sessionRan = false
      const spawnedBefore = b.runner && b.runner.kind !== 'session' ? b.runner : undefined
      const sessionHeld = !spawnedBefore && !b.handoff && (!!b.claim || !!b.offer || b.runner?.kind === 'session')
      let first: Choice = sessionHeld ? { kind: 'wait' } : spawnedBefore || b.handoff ? { kind: 'fresh', agent: '' } : runs.choose(b)
      // your session was passed over at once (it holds sessionMax runs, or Codex or Cursor sat idle): the copy says so
      const passedOver = !sessionHeld && !spawnedBefore && !b.handoff && (first.kind === 'fork' || first.kind === 'fresh') ? first.why : undefined
      if (b.early && b.claim) ensureEarly(b)   // a session's early line journaled before a restart: posted now if it was not
      while (!spawnedBefore && !b.handoff && (sessionHeld || first.kind === 'session' || first.kind === 'wait')) {
        const beat = setInterval(followWork, 2_000)
        beat.unref?.()
        const tAgent = performance.now()
        let r: AgentRun | null
        try { r = await runs.run(b, first.kind === 'session' ? first.conn : undefined) }
        finally { clearInterval(beat); timing.agentMs.push(performance.now() - tAgent) }
        if (stopped) return
        if (b.dropped) {
          await q.lock((j) => { settled(fail(j, b, 'you dropped it while your session had it')); q.persist() })
          runs.delivered(b.batchId, false, 'the owner dropped it')
          queueChanged(); timeRun('agent'); return
        }
        if (r) { run = r; sessionRan = true; break }
        // released, withdrawn or moved by the owner: `handoff` says it runs spawned; with none (released under
        // `jam.runner: 'session'`) it waits for a session again
        first = { kind: 'wait' }
      }
      if (!sessionRan) {
        // Leaving a session while another runner holds one of its frames (F4: it was formed beside a run of your session,
        // or that run left first): it never runs beside it. It goes back to the queue - first in line among its frames'
        // requests, never shared again, spawned as it was going to be - and waits for its frames; a queued request holds
        // nothing, so two of them never wait on each other (Codex's review of the design: no waiting loop, no deadlock)
        // F5: formed with no frame beside the others for your session, it is never spawned as it is - a spawned run's new
        // frames are found only when nothing runs beside it, from start to end: it goes back too, and runs alone - exclusive,
        // so nothing starts beside it after either (Codex's review: one spawned while nothing else ran was not exclusive, and
        // a request after it ran beside it)
        let loose = false
        const back = await q.lock((j) => {
          loose = !b.exclusive && cards0(b).every((c) => !c.frames.length)
          // (`queue` - under session-only, crowded out of its session: back whatever holds its frames now, never spawned)
          if (b.handoff !== 'queue' && !loose && ![...runningBatches.values()].some((o) => o.batchId !== b.batchId && o.frames.some((f) => b.frames.includes(f)))) return false
          const spawn = b.handoff === 'spawn' || !!spawnedBefore
          const why = b.handoffWhy ?? spawnedBefore?.why
          // what it had goes with it (Codex's review): the frames given to it as it worked (a variant placed with
          // `boards place --run`) join its card, so the run that takes it over holds them and may finish them; the frames
          // it made (a run of one: who made them is known) and its pictures from before any edit go to that run, so its
          // review starts from there - never from the partial work
          const shots = (b.shots ?? []).flatMap((s) => (!s.new && s.before ? [{ frame: s.frame, before: s.before, ...(s.beforeAt ? { at: s.beforeAt } : {}) }] : []))
          const created = b.members.length === 1 ? b.created ?? [] : []
          for (const m of b.members) {
            const c = j.cards.find((x) => x.id === m.card)
            if (!c || c.state !== 'working' || c.batch !== b.batchId) continue
            const add = b.frames.filter((f) => !c.frames.includes(f))
            if (add.length) c.frames = [...c.frames, ...add]
            // (on the card that waits now - merged into one already queued on its thread, that one)
            const t = requeue(j, c, Date.now())
            // (with no frame of its own: it runs alone with the frames it was given too - a restart included)
            t.alone = joinAlone(t.alone, { ...(spawn ? { spawn: true as const } : {}), ...(why ? { why } : {}),
              ...(created.length ? { created: [...created] } : {}), ...(shots.length ? { shots: shots.map((s) => ({ ...s })) } : {}), ...(loose ? { loose: true as const } : {}) })
          }
          b.state = 'done'; b.at = Date.now(); b.note = loose ? 'back in the queue - with no frame, it runs alone' : 'back in the queue - another runner holds one of its frames'
          q.persist()
          return true
        })
        if (back) { log(loose ? '  jam: a run with no frame went back to the queue - it runs alone once the other work is done' : '  jam: a run went back to the queue - another runner holds one of its frames; it starts when they are free'); queueChanged(); timeRun('other'); return }
        const ch: { kind: 'fork' | 'fresh'; agent: string; session?: string; why?: string } = spawnedBefore
          ? { kind: spawnedBefore.kind as 'fork' | 'fresh', agent: spawnedBefore.agent, ...(spawnedBefore.session ? { session: spawnedBefore.session } : {}), ...(spawnedBefore.why ? { why: spawnedBefore.why } : {}) }
          : (() => {
            const pick = runs.choose(b, Date.now(), true)
            const p = pick.kind === 'fork' || pick.kind === 'fresh' ? pick : { kind: 'fresh' as const, agent: cfg.agent }
            // offered to your session first and taken back: the copy says why it, not your session, runs it
            const why = b.handoffWhy === 'not taken in 2 minutes' || b.handoffWhy === 'its turn ended without taking it' ? "your session didn't take it - it was busy or away"
              : b.handoffWhy === 'your session let it go' ? "your session didn't take it - it let it go"
              // full when its offer was to be made (two runs chose its last slot at once): the room said again, under the lock
              : b.handoffWhy?.startsWith("your session didn't take it") ? b.handoffWhy
              : b.handoffWhy === 'the Jam session ended' ? 'the Jam session had ended' : passedOver
            return why && !('why' in p && p.why) ? { ...p, why } : p
          })()
        const agent = (Object.hasOwn(adapters, ch.agent) ? ch.agent : cfg.agent) as JamAgent
        const ad = agent === cfg.agent ? adapter : adapters[agent]
        const s = { mcp: b.power?.mcp ?? true, skills: b.power?.skills ?? true }
        const full = agent === 'claude' || agent === 'codex' || agent === 'cursor'
        const opts: SpawnOpts | undefined = full ? { root, mcp: s.mcp, skills: s.skills, ...(ch.kind === 'fork' && ch.session ? { fork: ch.session } : {}), marver: marverCmd() } : undefined
        // the runner is the decision now: saved before it runs, and the handoff it came from is spent
        await q.lock(() => { b.runner = { kind: ch.kind, agent, ...(ch.kind === 'fork' && ch.session ? { session: ch.session } : {}), ...(ch.why ? { why: ch.why } : {}) }; delete b.handoff; q.persist() })
        queueChanged()
        // a process slot of its own, whatever brought it here (jam.concurrency is the most Marver spawns at once)
        const permit = await takePermit()
        try {
        while (!stopped && b.attempts < MAX_ATTEMPTS) {
          await q.lock(() => { b.attempts += 1; b.leaseUntil = Date.now() + LEASE_MS; q.persist() })
          // every spawn reads the packet the journal makes, written again now (a record's seal checked again)
          for (const m of packet.members) if (m.kind === 'wrapup') {
            const c = q.j.cards.find((x) => x.id === m.card)
            const w = c && readWrapup(root, wrapupOf(c))
            if (!c || !w || !wrapupIntact(q.ctx(), c) || recordPathProblem(root, w.wrapup.file)) throw new Error('the session record changed after it was written - write it again')
            m.brief = { ...m.brief, wrapup: { content: w.wrapup, hash: w.hash } }
          }
          writeFileSync(join(root, packetPath(b.batchId)), JSON.stringify(packet, null, 1), { mode: 0o600 })
          const beat = setInterval(followWork, 2_000)
          beat.unref?.()
          const tAgent = performance.now()
          try {
            const one = b.members.length === 1 ? cards()[0] : undefined
            // a copy that fails is tried once more fresh (the session it copied may be gone, or too long since)
            // (from the saved runner, a restart included; it turns fresh only after a copy was tried and failed, below)
            const forked = b.runner?.kind === 'fork' ? b.runner.session : undefined
            const goal = goalText(packet, cfg.subagents && ad.supportsSubagents, full ? { kind: forked ? 'fork' : 'fresh', shell: true, mcp: s.mcp, skills: s.skills, sandbox: SANDBOX_SAYS[agent] } : undefined)
            run = await runAgent(ad, opts && { ...opts, fork: forked }, goal, (pid) => { b.pgid = pid; q.persist() },
              one?.thread && !b.early ? (text, asks, model) => {
                if (stopped) return   // output buffered past stop(): a successor owns the log
                // write FIRST, remember after: if the append throws, the final must not be suppressed
                // as a "duplicate" of an ack that never actually posted
                const p = postReply(b, one, 'm1', text, asks, model, 'early')
                early = { body: text, asks, commentId: p.commentId, ts: p.ts }
                hooks.changed?.(one.board)
              } : undefined)
            if (!run.ok && forked) await q.lock(() => { b.runner = { kind: 'fresh', agent, why: 'the copy of your session could not run - a fresh agent took it' }; q.persist() })
          } finally { clearInterval(beat); timing.agentMs.push(performance.now() - tAgent) }
          logRun(b.batchId, run.raw)
          if (run.ok) break
        }
        } finally { permit() }
      }
      if (stopped) return
      if (!run.ok) {
        // what it made before it failed is still its own (a last look, then the card holds them)
        await discover()
        await q.lock((j) => { ownCreated(j, b); settled(fail(j, b, 'the agent could not finish - its run log is in design/.local/jam-logs')); q.persist() })
        runs.delivered(b.batchId, false, 'the run failed')
        queueChanged()
        log(`  jam: gave up on a batch of ${b.members.length} after ${b.attempts} attempts`)
        timeRun('agent')
        return
      }
      // the last look for frames it made - before its after pictures, so a crash while they are taken keeps them
      if (!aloneAtStart || batchStarts !== myStart || crowded || hooks.anyHold?.()) { if (!b.crowded) await q.lock(() => { b.crowded = true; q.persist() }) }
      await discover()
      const tAfter = performance.now()
      await shoot('after')
      // frames the run made (on its board): pictured as they are (new, nothing before) at their size on the board
      const one = b.members.length === 1 ? cards()[0] : undefined
      // (as they are now: one made then renamed or removed during the run is not pictured, nor hosts the thread)
      const created = capturing && one?.kind === 'capture' ? liveCreated(b) : []
      let hosts: { member: string; frame: string }[] = []
      // (a rerun: the new frames are pictured again from what is there now - a picture of one gone since goes)
      if (!created.length && b.shots?.some((x) => x.new)) await q.lock(() => { b.shots = (b.shots ?? []).filter((x) => !x.new); q.persist() })
      if (created.length && hooks.shoot) {
        // pictured as they are now (again on a rerun: the frame may have changed since)
        const shots = (b.shots ?? []).filter((x) => !x.new)
        // (all of them are its frames; three are pictured)
        for (const f of created.slice(0, 3)) { if (stopped) return; if (shots.some((x) => x.frame === f)) continue; const id = await hooks.shoot(f, theme, { batch: b.batchId }, sizeOnBoard(f, one!.board)).catch(() => null); shots.push({ frame: f, ...(id ? { after: id } : {}), new: true }) }
        // its own frames came out as they were: it asked for something new - its thread goes onto the new frame
        const own = shots.filter((x) => !x.new && one!.frames.includes(x.frame))
        if (one!.thread && own.every((x) => x.same)) hosts = [{ member: b.members[0].id, frame: created[0] }]
        await q.lock(() => { b.shots = shots; q.persist() })
      }
      if (capturing) timing.afterMs = performance.now() - tAfter
      // results first: every member's result in ONE journal write, before anything is posted
      const split = parseMembers(run.said ?? run.reply, b.members.map((m) => m.id))
      // (a scene this run made is its own whole: its `_` files, a helper or a note, are not shared files it changed - one
      // another run made is not, though it was not there when this one began; F5, Codex's review)
      const changedShared = sharedBefore ? [...sharedMtimes(root)].filter(([f, mt]) => { const sc = sceneOf(f); return sharedBefore.get(f) !== mt && !(sc && b.madeScenes?.includes(sc)) }).map(([f]) => f) : []
      const results: Record<string, Result> = {}
      for (const [id, r0] of Object.entries(split)) {
        let r = r0
        // what passed the words but not the disk (a case alias, a link elsewhere): none left, the owner is asked, told why
        if ('shared' in r) { const files = r.shared.map(realShared).filter((f): f is string => !!f); r = files.length ? { shared: files } : { body: refusedAsk(r.shared.map((f) => ({ file: f, why: canonicalSharedWhy(root, f) ?? 'it could not be read' }))), asks: true } }
        results[id] = 'body' in r ? { body: r.body, asks: r.asks, ...(run.model ? { model: run.model } : {}), reanchors: [], ...(changedShared.length ? { alsoChanged: changedShared } : {}) } : r
      }
      await q.lock(() => {
        b.results = results
        if (run.reanchors.length) b.reanchors = run.reanchors
        if (hosts.length) b.hosts = hosts
        if (early) b.early = early
        if (run.model) b.model = run.model
        q.persist()
      })
      if (changedShared.length) log(`  jam: also changed ${changedShared.map((f) => relative('design', f)).join(', ')}`)
      const tDeliver = performance.now()
      try { await deliver(b) } catch (err) {
        // its results are kept and posted again later (`redeliver`, which logs its own `redelivered` line)
        timing.deliverMs = performance.now() - tDeliver
        timeRun('delivery')
        runs.delivered(b.batchId, true, 'retrying')
        throw err
      }
      runs.delivered(b.batchId, true)
      timing.deliverMs = performance.now() - tDeliver
      timeRun()
    } finally {
      unwatch()
      clearGlow()
    }
    } finally {
      // any other end (setup that threw, a record changed under it, a thrown step): its line is written once, as "other"
      if (!stopped) timeRun('other')
    }
  }

  // ---- captures: confirm, keep, Looks good, More work ------------------------------------------------

  /** Write a card's pending comment (once - an event already there must say the same, or the step
   *  fails closed), ledger it, and end the step. Called under the lock, synchronously; resumable at any point. */
  const finishIn = (j: Journal, c: Card) => {
    const p = c.pending
    if (!p) return
    const there = readLog(commentsDir, c.board).find((e) => e.id === p.event.id)
    if (there && !sameComment(there, p.event)) { conflictStep(j, c); q.persist(); return }
    if (!there) appendEvents(commentsDir, c.board, [p.event])
    ledgerRecord(root, c.board, p.event.id)
    if (p.op === 'confirm') ledgerRecord(root, c.board, payloadKey(c))
    settled(endStep(j, c))
    q.persist()
  }
  const finishStep = (id: string) => q.lock((j) => {
    const c = j.cards.find((x) => x.id === id)
    if (!c) return undefined
    finishIn(j, c)
    return structuredClone(c)
  })

  /** Where a capture's comment is pinned: on its first point (found in the rendered frame), else its first frame,
   *  else the board. A render - so it is looked up before any lock is taken. */
  const pinOf = async (record: import('./types.ts').CaptureRecord): Promise<{ frame?: string; anchor?: unknown }> => {
    const point = firstPoint(record)
    let at: { frame?: string; anchor?: unknown } = { frame: point?.frame ?? captureFrames(record)[0] }
    if (point?.frame && hooks.anchor) {
      const target = point.bundle.quote && point.bundle.quote !== '•••' ? { on: point.bundle.quote } : point.bundle.testId && point.bundle.testId !== '•••' ? { at: point.bundle.testId } : point.bundle.cssPath ? { at: point.bundle.cssPath } : null
      if (target) {
        const check = await hooks.anchor(point.frame, target, [], undefined).catch(() => null)
        if (check?.ok) at = { frame: point.frame, anchor: check.anchor }
      }
    }
    return at
  }

  /** Confirm a draft (`end: queued`) or keep it from its read-back (`end: kept`): one recoverable step.
   *  A retried request after a lost answer finds the step done and answers with the card. */
  const confirm = async (id: string, rev: number, end: 'queued' | 'kept') => {
    const c0 = q.j.cards.find((x) => x.id === id)
    if (!c0 || c0.kind !== 'capture') return { ok: false, error: 'no such capture' }
    if (c0.pending?.op === 'confirm') return { ok: true, card: await finishStep(id) }
    if (c0.thread && (c0.state === end || (end === 'queued' && ['working', 'asks', 'review', 'done'].includes(c0.state)))) return { ok: true, card: structuredClone(c0) }
    if (c0.state !== 'draft' || c0.rev !== rev) return { ok: false, card: structuredClone(c0), error: 'the card changed - look again' }
    const cap = readCapture(root, id)
    if (!cap || cap.hash !== c0.payload?.recordHash) return { ok: false, card: structuredClone(c0), error: 'the capture changed after it was sealed' }
    const at = await pinOf(cap.record)
    const began = await q.lock((j) => {
      const c = j.cards.find((x) => x.id === id)
      if (!c || c.state !== 'draft' || c.rev !== rev) return null
      beginStep(j, c, 'confirm', captureComment(c, cap.record, at, me()), Date.now(), end)
      q.persist()
      return true
    })
    if (!began) return { ok: false, card: structuredClone(q.j.cards.find((x) => x.id === id)!), error: 'the card changed - look again' }
    const card = await finishStep(id)
    reserve(); queueChanged(); void pump()
    return { ok: card?.state === end, card, ...(card?.state === end ? {} : { error: card?.note }) }
  }

  /** More work on a review: your words post as an @marver reply in the capture's thread (a ledgered
   *  `mw-` reply that mints no tag card) and the SAME card goes round again, first. Recoverable. */
  const moreWork = async (id: string, rev: number, words: string) => {
    const c0 = q.j.cards.find((x) => x.id === id)
    if (c0?.pending?.op === 'more') return { ok: true, card: await finishStep(id) }
    if (!words.trim()) return { ok: false, card: c0 && structuredClone(c0), error: 'say what more to do' }
    // a session record has no thread: More work is a new record job from the same content, your note added
    if (c0?.kind === 'wrapup') {
      // your note is sealed and ledgered too, in a wrap-up of its own - from the first one's content, checked
      const r = await q.lock((j, ctx) => {
        const c = j.cards.find((x) => x.id === id)
        if (!c || c.state !== 'review' || c.rev !== rev || !c.payload) return { error: 'the card changed - look again' }
        const prev = readWrapup(root, c.id)
        if (!prev || !wrapupIntact(ctx, c)) return { error: 'the session record changed after it was written - write it again' }
        const w = moreOf(prev.wrapup, words.trim())
        const hash = storeWrapup(root, w)
        ledgerRecord(root, c.board, `wrapup:${w.id}:${hash}`)
        const next = moreWrapup(j, c, w, hash)
        q.persist()
        return { card: structuredClone(next) }
      })
      if ('error' in r) { const c = q.j.cards.find((x) => x.id === id); return { ok: false, card: c && structuredClone(c), error: r.error } }
      reserve(); queueChanged(); void pump()
      return { ok: true, card: r.card }
    }
    const began = await q.lock((j) => {
      const c = j.cards.find((x) => x.id === id)
      if (!c || c.state !== 'review' || c.rev !== rev || !c.thread) return null
      const who = me()
      beginStep(j, c, 'more', { id: `mw-${c.id}-${c.rev}`, ts: Date.now(), type: 'reply', commentId: `mw-c-${c.id}-${c.rev}`, parentId: c.thread, board: c.board, author: who, body: `@marver ${words.trim()}`.slice(0, 20_000) })
      q.persist()
      return true
    })
    if (!began) { const c = q.j.cards.find((x) => x.id === id); return { ok: false, card: c && structuredClone(c), error: 'the card changed - look again' } }
    const card = await finishStep(id)
    reserve(); queueChanged(); void pump()
    hooks.changed?.(card?.board ?? '')
    return { ok: card?.state === 'queued', card }
  }

  /** Looks good: done, and the thread resolved (an ordinary owner resolve) unless something newer is open. */
  const good = async (id: string, rev: number) => {
    const r = await q.lock((j, ctx) => {
      const c = j.cards.find((x) => x.id === id)
      if (!c || c.state !== 'review' || c.rev !== rev) return { ok: false, card: c && structuredClone(c), error: 'the card changed - look again' }
      const { resolve } = looksGood(j, ctx, c, readLog(commentsDir, c.board))
      if (resolve && c.thread) appendEvents(commentsDir, c.board, [{ id: `rs-${c.id}-${rev}`, ts: Date.now(), type: 'resolve', commentId: c.thread, board: c.board, author: me() }])
      q.persist()
      return { ok: true, card: structuredClone(c) }
    })
    if (r.ok) { queueChanged(); hooks.changed?.(r.card!.board) }
    return r
  }

  // ---- the scheduler --------------------------------------------------------------------------
  /** A pump soon, once however often it is asked for, outside whatever lock asks for it. */
  let pumpDue: ReturnType<typeof setTimeout> | null = null
  const pumpSoon = () => {
    if (pumpDue || stopped) return
    pumpDue = setTimeout(() => { pumpDue = null; void pump().catch((err) => log(`  jam: pump error - ${(err as Error).message}`)) }, 0)
    pumpDue.unref?.()
  }
  /** Spawned processes at once: never more than jam.concurrency, whatever routing decided - a run that falls back from
   *  your session (released, withdrawn, moved by you, a restart) takes a permit before its first attempt and gives it
   *  back after its last (Codex's review of the F3 design). First come, first served. */
  const permits = { free: Math.max(1, cfg.concurrency), waiting: [] as (() => void)[] }
  const takePermit = (): Promise<() => void> => new Promise((res) => {
    const grant = () => {
      permits.free -= 1
      let back = false
      res(() => { if (back) return; back = true; permits.free += 1; permits.waiting.shift()?.() })
    }
    if (permits.free > 0 && !permits.waiting.length) grant(); else permits.waiting.push(grant)
  })
  let recheck: ReturnType<typeof setTimeout> | null = null
  const holdLater = () => {
    if (recheck || stopped) return
    recheck = setTimeout(() => { recheck = null; void pump() }, HOLD_RECHECK_MS)
    recheck.unref?.()
  }
  const waitingSaid = new Set<string>()

  /** Batches recovered at boot that still wait for a chat agent's hold to end; they keep their frames. */
  const deferred: Batch[] = []

  /** Claim what can run now and start it. Under the lock, after the ingest. */
  const pump = async (): Promise<void> => {
    if (stopped || !ready) return
    if (delivering.size) { holdLater(); return }   // results first: nothing new until they are posted
    for (const b of [...deferred]) {
      if (b.frames.some((f) => hooks.held?.(f)) || (b.exclusive && hooks.anyHold?.())) { holdLater(); continue }
      deferred.splice(deferred.indexOf(b), 1)
      launch(b)
    }
    const started = await q.lock((j, ctx) => {
      noteQueued()   // a card queued since the last change was seen: its wait starts no later than now
      const frames = new Set([...runningBatches.values()].flatMap((b) => b.frames))
      // runs a session holds (offered, taken, or waiting for one) count against its own limit, not jam.concurrency - which
      // caps what Marver spawns (F3: a Claude Code session dispatching holds up to 8): the slots are the spawned ones left,
      // and the session's room on top
      const sessionSide = (x: Batch) => x.handoff !== 'spawn' && (!!x.offer || !!x.claim || x.runner?.kind === 'session')
      const spawned = [...runningBatches.values()].filter((x) => !sessionSide(x)).length
      // F4: a request on a frame the session taking the work holds - every run on it that session's - is not held back:
      // it is offered to that session, which decides (hold it, fold it in, or a variant beside it)
      const taker = runs.taker()
      // F5: a request with no frame runs beside the others for the session that takes the work now, full or not (a
      // session's record: the session it closes takes it though that has ended) - with none, alone
      const taking = takersNow()
      const { batches, exclusiveWaiting } = form(j, ctx, {
        session: (record) => { const t = taking(record); return t && { conn: t.conn.id, inc: t.conn.inc, room: t.room } },
        free: Math.max(1, cfg.concurrency) - spawned + runs.room(),
        ...(taker ? {
          share: (f: string) => {
            const hs = [...runningBatches.values()].filter((x) => x.frames.includes(f))
            return hs.length && hs.every((x) => !x.exclusive && heldBy(x, taker)) ? hs.map((x) => x.batchId) : null
          },
          shareRoom: runs.room(), sharer: { conn: taker.id, inc: taker.inc },
        } : {}),
        running: frames,
        active: runningBatches.size,
        exclusiveRunning: [...runningBatches.values()].some((b) => b.exclusive),
        held: (f) => !!hooks.held?.(f),
        anyHold: () => !!hooks.anyHold?.(),
        others: runs.settings().others,
      })
      prune(j)
      q.persist()
      for (const b of batches) runningBatches.set(b.batchId, b)
      // each member's wait, measured now (it leaves the queue as it is claimed)
      const now = performance.now()
      for (const b of batches) batchWaits.set(b.batchId, new Map(b.members.flatMap((m) => { const t = queuedSince.get(m.card); return t !== undefined && !atBoot.has(m.card) ? [[m.card, now - t] as [string, number]] : [] })))
      reserve(exclusiveWaiting)
      // a queued card that waits on a chat agent's hold: say so once, look again soon
      const alone = aloneNow()
      for (const c of j.cards) {
        if (c.state !== 'queued') continue
        const held = c.frames.find((f) => hooks.held?.(f))
        if (held || (exclusiveWaiting && alone(c))) {
          holdLater()
          if (held && !waitingSaid.has(c.id)) { waitingSaid.add(c.id); log(`  jam: waiting - ${held} is being worked on in chat; the comment runs once it is done`) }
        } else waitingSaid.delete(c.id)
      }
      return batches
    })
    if (started.length) queueChanged()
    for (const b of started) launch(b)
  }

  /** Batches whose results are saved and whose replies wait to be posted again. While any does, it
   *  keeps its frames, nothing new is dispatched and no new hold is taken: what it moves (a `shared`
   *  answer turns exclusive) must exist before anything else starts. */
  const delivering = new Set<string>()
  const settleDelivery = (b: Batch) => { delivering.delete(b.batchId); runningBatches.delete(b.batchId); reserve(); queueChanged(); void pump() }
  /** Post a batch's results again after a failed delivery - a few times, further apart. If it never
   *  posts, its cards fail with the results kept: Retry posts them (and a boot tries again) - the agent
   *  never runs twice for one result. */
  const timers = new Set<ReturnType<typeof setTimeout>>()
  /** a wait that stop() cancels (it resolves at once then; the caller checks `stopped`) */
  const naps = new Set<() => void>()
  const nap = (ms: number) => new Promise<void>((done) => {
    const t = setTimeout(() => { timers.delete(t); naps.delete(wake); done() }, ms)
    const wake = () => { clearTimeout(t); timers.delete(t); done() }
    timers.add(t); naps.add(wake)
  })
  const redeliver = (b: Batch, n: number, delay = 5_000 * n) => {
    if (stopped) return
    delivering.add(b.batchId); runningBatches.set(b.batchId, b); reserve()
    const t = setTimeout(() => {
      timers.delete(t)
      if (stopped) return
      const tDeliver = performance.now()
      deliver(b).then(() => { logJam(root, { kind: 'run', batch: b.batchId, redelivered: true, deliverMs: performance.now() - tDeliver }); settleDelivery(b) }, async (err) => {
        log(`  jam: posting failed again - ${(err as Error).message}`)
        if (n < 5) return redeliver(b, n + 1)
        logJam(root, { kind: 'run', batch: b.batchId, redelivered: true, failure: 'delivery' })
        await q.lock((j) => { settled(undelivered(j, b, 'its replies could not be posted - Retry posts them')); q.persist() }).catch(() => {})
        settleDelivery(b)
      })
    }, delay)
    timers.add(t)
    t.unref?.()
  }

  const launch = (b: Batch) => {
    runningBatches.set(b.batchId, b)
    const p = (async () => {
      try { await runBatch(b) } catch (err) {
        log(`  jam: batch error - ${(err as Error).message}`)
        // a batch with results did its work: only posting broke - post again later, never rerun it
        if (b.results) redeliver(b, 1)
        else {
          runs.delivered(b.batchId, false, (err as Error).message)
          try { await q.lock((j) => { settled(fail(j, b, `the job broke: ${(err as Error).message}`)); q.persist() }) } catch { /* the journal keeps it claimed; boot recovers it */ }
          queueChanged()
        }
      } finally {
        if (!delivering.has(b.batchId)) runningBatches.delete(b.batchId)   // a delivery being retried keeps its frames
        running.delete(b.batchId)
        reserve()
        // what this batch held is free: start what waited on it BEFORE this run counts as over, so
        // `tick()` (and an orderly stop) sees the next batch in `running`
        try { await pump() } catch (err) { log(`  jam: pump error - ${(err as Error).message}`) }
      }
    })()
    running.set(b.batchId, p)
  }

  // ---- the startup barrier ----------------------------------------------------------------------
  let ready = false
  let recovering: Promise<void> | null = null
  const recover = () => recovering ??= (async () => {
    // a confirm or a More work a crash interrupted resumes first: its comment is in the journal
    for (const c of q.j.cards.filter((x) => x.pending)) await finishStep(c.id).catch((err) => log(`  jam: could not resume a step - ${(err as Error).message}`))
    const leftover = await q.lock((j) => {
      const out: { b: Batch; results: boolean }[] = []
      for (const b of j.batches) {
        if (b.state !== 'claimed') continue
        if (b.results) { out.push({ b, results: true }); continue }
        // a run a session holds (claimed, completing, stopping): kept exactly as the session saw it - its members,
        // their ids, its frames reserved - and waited on again; the session's handle still works (spec 29b v2, 5)
        if (b.claim) { out.push({ b, results: false }); continue }
        fenceGroup(b.pgid)   // an orphan may still be editing
        // Nothing reaches the agent that is not still the owner's: an ask stands only if its event is
        // in the log, ledgered, and its frozen revision is the event itself or a ledgered edit of it.
        // The journal's briefs (which `follows` reads later) and the packet are cleaned alike.
        const ctx = q.ctx()
        const logs = new Map<string, CommentEvent[]>()
        const logOf = (board: string) => { let l = logs.get(board); if (!l) logs.set(board, (l = readLog(commentsDir, board))); return l }
        const owned = (board: string, id: string) => ctx.owned.has(`${board}\t${id}`) && logOf(board).some((e) => e.id === id)
        const askOk = (board: string, a: Msg) => stillOwned(ctx, board, logOf(board), a)
        const clean = (board: string, brief: Brief | undefined, comment: boolean): Brief | undefined => !brief || !comment ? brief : {
          ...brief,
          asks: brief.asks.filter((a) => askOk(board, a)),
          history: brief.history.map((m) => (m.owner && !askOk(board, m) ? { id: m.id, ...(m.author ? { author: m.author } : {}), body: m.body, ts: m.ts, note: 'someone else - context only' } : m)),
          ...(brief.follows ? { follows: { ...brief.follows, asks: brief.follows.asks.filter((a) => askOk(board, a)) } } : {}),
        }
        for (const m of b.members) {
          const c = j.cards.find((x) => x.id === m.card)
          if (!c) continue
          // a capture changed since it was confirmed never runs again, whoever carries it
          if (c.capture && !captureIntact(j, ctx, c.capture)) { c.state = 'failed'; c.note = 'the capture changed after it was confirmed - capture it again'; c.rev += 1; c.at = Date.now(); continue }
          // a session record whose sealed content changed never runs again either
          if (c.kind === 'wrapup' && !wrapupIntact(ctx, c)) { c.state = 'failed'; c.note = 'the session record changed after it was written - write it again'; c.rev += 1; c.at = Date.now(); continue }
          // every kind's asks are checked (a capture's More work and merged tags are events too); only
          // a tag's card has nothing left to do without them - a capture still has its payload
          const comment = c.kind === 'comment'
          const had = c.brief?.asks.length ?? 0
          c.brief = clean(c.board, c.brief, true)
          m.brief = clean(m.board, m.brief, true)
          const events = c.events.filter((id) => owned(c.board, id))
          // a surviving card keeps only its authorized asks; a dropped one keeps what it was, for the record
          if (events.length !== c.events.length && (events.length || !comment)) c.events = events
          // dropped when none of its asks is the owner's any more - by its events, or by the frozen brief
          if (comment && (!events.length || (had > 0 && !c.brief?.asks.length))) { c.state = 'dropped'; c.note = 'no longer authorized'; c.rev += 1; c.at = Date.now() }
        }
        const survivors = b.members.filter((m) => j.cards.find((x) => x.id === m.card)?.state === 'working')
        if (!survivors.length) { b.state = 'done'; continue }
        // survivors are numbered again from m1, so the prompt and the early ack name a member that exists
        const ids = new Map(survivors.map((m, i) => [m.card, `m${i + 1}`]))
        const renumbered = survivors.some((m) => ids.get(m.card) !== m.id) || survivors.length !== b.members.length
        b.members = survivors.map((m) => ({ ...m, id: ids.get(m.card)! }))
        const file = join(root, packetPath(b.batchId))
        try {
          const packet = JSON.parse(readFileSync(file, 'utf8')) as JobPacket
          const members = packet.members.filter((m) => ids.has(m.card)).map((m) => ({ ...m, id: ids.get(m.card)!, brief: clean(m.board, m.brief, true)! }))
          const next = { ...packet, members }
          if (renumbered || JSON.stringify(next) !== JSON.stringify(packet)) writeFileSync(file, JSON.stringify(next, null, 1), { mode: 0o600 })
        } catch { b.state = 'failed'; b.note = 'its packet is gone'; for (const m of b.members) { const c = j.cards.find((x) => x.id === m.card); if (c) { c.state = 'failed'; c.note = 'interrupted - Retry'; c.rev += 1; c.at = Date.now() } } continue }
        out.push({ b, results: false })
      }
      q.persist()
      return out
    })
    for (const { b } of leftover) runningBatches.set(b.batchId, b)
    reserve()
    // reconcile first (post what is left, move the cards), then re-arm the rest
    // ...and the barrier holds until each is reconciled: nothing new starts, no hold is taken, before a
    // recovered batch's cards have moved (its `shared` rerun must reserve the canvas first). A posting
    // that keeps failing is tried a few times, then its cards fail - with their results kept, so the
    // replies are in the journal and nothing pretends the work was not done.
    for (const { b } of leftover.filter((x) => x.results)) {
      await q.lock((j) => { redelivering(j, b); q.persist() })   // one a previous boot gave up on, too
      for (let n = 1; ; n++) {
        const tDeliver = performance.now()
        try { await deliver(b); logJam(root, { kind: 'run', batch: b.batchId, redelivered: true, deliverMs: performance.now() - tDeliver }); break } catch (err) {
          if (n >= 4 || stopped) {
            log(`  jam: could not post a recovered batch - ${(err as Error).message}; its cards fail, Retry posts them`)
            logJam(root, { kind: 'run', batch: b.batchId, redelivered: true, failure: 'delivery' })
            await q.lock((j) => { settled(undelivered(j, b, 'its replies could not be posted - Retry posts them')); q.persist() })
            break
          }
          await nap(500 * 2 ** n)
          if (stopped) return
        }
      }
      runningBatches.delete(b.batchId)
    }
    ready = true
    reserve()
    // a resumed batch still waits for a hold restored at boot (an exclusive one, for every hold)
    for (const { b } of leftover.filter((x) => !x.results)) deferred.push(b)
  })()

  const idle = async () => { while (running.size && !stopped) await Promise.race([...running.values()]) }

  const tick = async () => {
    if (stopped) return
    try {
      await recover()
      await pump()
    } catch (err) {
      log(`  jam: tick error - ${(err as Error).message}`)
    }
    await idle()
  }

  /** A capture's record is the one sealed: its card holds the hash of these bytes, ledgered at the seal. */
  const sourceIntact = (id: string): boolean => {
    const card = q.j.cards.find((c) => c.id === id && c.kind === 'capture')
    const cap = readCapture(root, id)
    return !!card?.payload && !!cap && cap.hash === card.payload.recordHash && ledgerHas(root, card.board, `capture:${id}:${cap.hash}`)
  }
  /** Already stored under this id (a retried upload): the checks ran when it was first taken. */
  const storedOnce = (rec: { id: string }) => q.j.cards.some((c) => c.id === rec.id)

  /** A capture's More work asks (its events after the confirm - each ledgered as yours), in order, each
   *  with the result of the run that took it (none yet for one still queued or working). */
  const moreAsks = (j: Journal, ctx: ReturnType<Queue['ctx']>, c: Card): { ask: string; result?: string }[] => {
    if (!c.events.length) return []
    const log = readLog(commentsDir, c.board)
    // its runs, oldest first: a More work ask may have run more than once (Retry, a shared-file rerun)
    const runs = [...(c.ran ?? []), ...(c.batch ? [c.batch] : [])].map((id) => j.batches.find((b) => b.batchId === id)).filter((b): b is Batch => !!b)
    // your More work replies only - a tag that joined the card is answered in its thread, not in the record
    return c.events.filter((id) => id.startsWith('mw-')).flatMap((id) => {
      const ev = log.find((e) => e.id === id)
      if (!ev || !ctx.owned.has(`${c.board}\t${id}`)) return []
      const took = runs.flatMap((b) => { const m = b.members.find((x) => x.card === c.id && x.brief?.asks.some((a) => a.id === id)); return m ? [{ b, m }] : [] })
      // the words as the agent got them (the last run's frozen ask), else - not run yet - your latest ledgered edit
      const last = took[took.length - 1]
      const frozen = last?.m.brief?.asks.find((a) => a.id === id)?.body
      const ask = (frozen ?? textOf(ctx, c.board, log, ev, true).body).replace(/^@marver\s*/i, '').trim()
      // what came of it: the run that answered it (the last one that did), else that it failed, else open
      const answered = [...took].reverse().find(({ b, m }) => { const r = b.results?.[m.id]; return !!r && 'body' in r })
      const r = answered?.b.results?.[answered.m.id]
      const failed = !answered && took.length > 0 && took.every(({ b }) => b.state === 'done' || b.state === 'failed')
      return [{ ask, ...(r && 'body' in r ? { result: r.body } : failed ? { result: '(the run failed - not done)' } : {}) }]
    })
  }


  /** A sealed capture taken in: checked (and, resumed, as a continuation), stored, ledgered - ended with E, a card
   *  queued in the same step that makes it; ended with ⇧E (or sealed by its page leaving), a draft card. `held`: an
   *  E capture the queue would not take - it stays a draft, and this says why (the page says so in one line). */
  const landCapture = async (rec: import('./types.ts').CaptureRecord): Promise<{ ok: boolean; card?: Card; error?: string; held?: string }> => {
    // Resume: only from a record still as it was sealed, and only as its continuation - every step of
    // it, moved by one offset, ahead of the new ones, and its pictures kept
    const rs = rec.context.resumes
    if (rs && !storedOnce(rec)) {
      const src = readCapture(root, rs.id)
      if (!src || !sourceIntact(rs.id)) return { ok: false, error: 'the capture it resumes changed after it was sealed - capture it again' }
      if (!continues(src.record, rec, rs.at)) return { ok: false, error: 'this capture does not continue the one it resumes' }
    }
    const stored = storeCapture(root, rec)
    if (typeof stored === 'string') return { ok: false, error: stored }
    ledgerRecord(root, rec.context.board, `capture:${rec.id}:${stored.hash}`)
    // Ended with ⇧E (Stop to review), or sealed by its page leaving (unfinished): a draft that waits for its read-back.
    // Ended with E: no read-back, nothing to confirm - its card is made queued. Made, its confirm begun (journaled: a
    // crash resumes it), its comment written and the card queued, all in ONE synchronous turn under the lock, so no
    // push, poll or answer ever carries it as a draft (27 Oct: the draft published first, then confirmed, flashed
    // "To confirm" and opened the read-back on the canvas). Its pin is a render, so it is found before the lock.
    const auto = !rec.context.interrupted && !rec.context.review
    const at = auto && !storedOnce(rec) ? await pinOf(rec) : undefined
    let card = await q.lock((j) => {
      const fresh = !j.cards.some((c) => c.id === rec.id)
      const c = addCapture(j, rec, stored.hash)
      if (fresh && at) {
        beginStep(j, c, 'confirm', captureComment(c, rec, at, me()), Date.now(), 'queued')
        q.persist()
        finishIn(j, c)
      }
      q.persist()
      return structuredClone(c)
    })
    // a confirm an earlier landing of this record began and never finished (a write that threw): finished now
    if (card.pending?.op === 'confirm') card = (await finishStep(card.id)) ?? card
    // landed again (a retried upload) as a draft an earlier server made of an E capture: queued now, as then
    if (auto && card.state === 'draft' && !card.note) {
      const r = await confirm(card.id, card.rev, 'queued')
      if ('card' in r && r.card) card = r.card
    }
    reserve(); queueChanged(); void pump()
    // the queue would not take it (a conflicting comment under its id): it waits as a draft, never opened for you
    if (auto && card.state === 'draft') return { ok: true, card, held: card.note ?? 'it could not be queued' }
    return { ok: true, card }
  }

  /** Captures of a session open on some page, until they land: capture id -> its session, renewed until. */
  const openCaps = new Map<string, { session: string; until: number }>()
  /** Captures of a session being taken in right now (counted: a retry may overlap the first upload). */
  const landing = new Map<string, { session: string; n: number }>()
  const openFor = (session: string): boolean => {
    const now = Date.now()
    for (const [k, v] of openCaps) if (v.until < now) openCaps.delete(k)
    return [...openCaps.values()].some((v) => v.session === session) || [...landing.values()].some((v) => v.session === session)
  }
  /** Tags written since a session began (they are answered in their threads, not in its record). */
  // counted per tag, by when each was written (tags merged into one card, or joining a card from before the
  // session, each count once)
  const tagsSince = (j: Journal, since: number): number => {
    const seen = new Set<string>()   // one tag once, whatever cards carry it (a merge keeps it on both)
    // on any card that carries tags - one joining a queued capture too; never a capture's own comment or a More work reply
    for (const c of j.cards) for (const id of c.events) if (!id.startsWith('cap-') && !id.startsWith('mw-') && (c.when?.[id] ?? c.made) >= since) seen.add(`${c.board}|${id}`)
    return seen.size
  }

  /** The agent's reply on a card's last run, as it said it. */
  const resultFor = (j: Journal, c: Card): string | undefined => {
    const b = j.batches.find((x) => x.batchId === (c.batch ?? c.ran?.[c.ran.length - 1]))
    const m = b?.members.find((x) => x.card === c.id)
    const r = m && b?.results?.[m.id]
    return r && 'body' in r ? r.body : undefined
  }

  /** Two pictures with the same bytes (the same render of the same pixels). */
  const samePicture = (a: string, b: string): boolean => {
    const fa = picturePath(root, a), fb = picturePath(root, b)
    if (!fa || !fb) return false
    try { const h = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex'); return h(fa.path) === h(fb.path) } catch { return false }
  }

  /** What the lane and the review need of a capture card - its first words, whether it is in the
   *  run, its last run's before and after pictures, the run it reviewed, your edit, its notes. */
  const titles = new Map<string, { title: string; notes: number }>()
  const captureView = (c: Card) => {
    if (c.kind === 'wrapup') return {
      // a session record: its file, and the agent's reply once it ran
      title: c.name ?? 'Session record', inRun: !!q.j.run && c.made >= q.j.run.since,
      ...(c.session ? { session: c.session } : {}),
      ...(readWrapup(root, wrapupOf(c)) ? { file: readWrapup(root, wrapupOf(c))!.wrapup.file } : {}),
    }
    let t = titles.get(c.id)
    if (!t) {
      const rec = readCapture(root, c.id)?.record
      const words = rec ? rec.timeline.flatMap((x) => (x.event === 'words' || x.event === 'note' ? [x.text] : [])).join(' ').replace(/\s+/g, ' ').trim() : ''
      // up to 300 characters: the tile trims it, its tooltip shows it whole
      t = { title: words.slice(0, 300) || 'Capture', notes: rec ? rec.timeline.filter((x) => x.event === 'note').length : 0 }
      if (rec) titles.set(c.id, t)
    }
    const b = q.j.batches.find((x) => x.batchId === c.batch)
    return {
      title: c.name ?? c.autoName ?? (c.payload?.edited !== undefined ? (c.payload.edited.replace(/\s+/g, ' ').trim().slice(0, 300) || '(no words)') : t.title), notes: t.notes,
      ...(c.name ? { named: true } : {}), ...(c.name ?? c.autoName ? { name: c.name ?? c.autoName } : {}),
      inRun: !!q.j.run && c.made >= q.j.run.since, ...(c.session ? { session: c.session } : {}),
      ...(b?.shots ? { shots: b.shots } : {}), ...(c.reviewing ? { reviewing: c.reviewing } : {}),
      ...(c.payload?.edited !== undefined ? { edited: c.payload.edited } : {}),
      ...(c.payload?.added?.length ? { added: c.payload.added } : {}),
    }
  }
  // every view is numbered as it is built: a page that gets an answer and a push out of order keeps the newer
  const boot = Math.random().toString(36).slice(2, 10)
  let viewN = 0
  const view = (): QueueView => {
    const j = q.j
    // a queued card waits on a frame another run holds (one job per frame), or your agent in chat: it says which and
    // whose, and counts no place in line - the places are of the requests that can start, first come first
    const busyFrame = (c: Card) => c.frames.find((f) => jamReservations.frames.has(f) || !!hooks.held?.(f))
    const taking = takersNow()
    const alone = aloneNow(taking)
    // one with no frame that goes to your session while it holds all the runs it can: it waits for the session, not its
    // place - a request after it may start first (Codex's review: it read "Queued · next")
    const full = (c: Card) => !c.frames.length && !alone(c) && (taking(c.kind === 'wrapup')?.room ?? 0) < 1
    const queued = j.cards.filter((c) => c.state === 'queued' && !busyFrame(c) && !full(c)).sort((a, b) => a.order - b.order || a.made - b.made)
    const shown = j.cards.filter((c) => pending(c) || c.at > Date.now() - 60_000 || (!!j.run && c.kind !== 'comment' && c.made >= j.run.since))
    const exclusiveAhead = jamReservations.exclusive
    return {
      agent: adapter.name, seq: { boot, n: ++viewN },
      ...(q.j.run ? { run: q.j.run } : {}),
      ...(q.j.session ? { session: q.j.session } : {}),
      cards: shown.map((c) => {
        const busy = c.state === 'queued' ? busyFrame(c) : undefined
        const holder = busy ? j.batches.find((b) => b.batchId === jamReservations.frames.get(busy)) : undefined
        const waitsFor = busy ? { frame: busy, ...(holder ? { by: runs.title(holder) } : hooks.held?.(busy) ? { by: 'chat' } : {}) } : undefined
        const position = c.state === 'queued' && !busy && !full(c) ? queued.indexOf(c) + 1 : undefined
        // more than its place: it runs alone once the other work is done, one that runs alone goes first, or your session is full
        const waiting = c.state === 'queued' && exclusiveAhead === 'waiting' && alone(c) ? 'alone' as const
          : c.state === 'queued' && exclusiveAhead ? 'behind' as const
          : c.state === 'queued' && full(c) ? 'session' as const : undefined
        return {
          id: c.id, kind: c.kind, board: c.board, ...(c.thread ? { thread: c.thread } : {}), frames: c.frames, events: c.events,
          state: c.state, ...(c.note ? { note: c.note } : {}), rev: c.rev, made: c.made, order: c.order, at: c.at,
          ...(c.follows ? { follows: c.follows } : {}), ...(c.reply ? { reply: c.reply } : {}), ...(c.batch ? { batch: c.batch } : {}),
          ...(position ? { position } : {}), ...(waitsFor ? { waitsFor } : {}), ...(waiting ? { waiting } : {}), ...(c.exclusive ? { exclusive: true } : {}),
          ...(c.kind !== 'comment' ? captureView(c) : {}),
          ...(c.state === 'working' ? (() => { const r = runs.runnerOf(j.batches.find((b) => b.batchId === c.batch)); return r ? { runner: r } : {} })() : {}),
        }
      }),
      ...runs.view(),
      settings: runs.settings(),
    }
  }

  return {
    tick,
    runs,
    stop() {
      stopped = true; jamReservations.settling = false
      runs.stop()
      if (recheck) clearTimeout(recheck)
      if (pumpDue) clearTimeout(pumpDue)
      // a run waiting for a process slot ends (it looks at `stopped` first)
      for (const w of permits.waiting.splice(0)) w()
      for (const t of timers) clearTimeout(t)
      timers.clear()
      for (const wake of naps) wake()
      naps.clear()
      for (const c of activeChildren) fenceGroup(c.pid)
    },
    snapshot() { return q.j },
    view,
    sealed: (id) => sourceIntact(id),
    async session(op) {
      if (!SESSION_ID.test(op.id)) return { ok: false, error: 'bad session id' }
      if (op.action === 'start') {
        const r = await q.lock((j) => { const ses = startSession(j, op.id); q.persist(); return ses })
        queueChanged()
        return { ok: r.id === op.id, session: r, ...(r.id === op.id ? {} : { error: 'a session already runs' }) }
      }
      if (op.action === 'end') {
        const ended = await q.lock((j) => { const ok = endSession(j, op.id); q.persist(); return ok })
        queueChanged()
        return { ok: ended, session: null, ...(ended ? {} : { error: 'no such session runs' }) }
      }
      // the wrap-up: sealed at this moment (as of now), ledgered with its hash, a queued card - and the
      // session ends
      if (!/^[a-z0-9][a-z0-9-]*$/.test(op.board)) return { ok: false, error: 'bad board' }
      const r = await q.lock((j, ctx) => {
        if (j.session?.id !== op.id) return { error: 'no such session runs' }
        // checked again here, where the record is sealed: a capture opened in some tab meanwhile holds it back
        if (openFor(op.id)) return { error: 'a capture of the session is still recording or being sent - end it first, then write the record' }
        const w = buildWrapup(j, root, {
          session: op.id, since: j.session.since, instructions: op.instructions, includeTalk: op.includeTalk, tags: tagsSince(j, j.session.since),
          title: (c) => (captureView(c) as { title?: string }).title ?? c.id, reply: (c) => resultFor(j, c),
          intact: (c) => captureIntact(j, ctx, c.id),
          more: (c) => moreAsks(j, ctx, c),
        })
        if ('error' in w) return { error: w.error }
        const unsafe = recordPathProblem(root, w.file)
        if (unsafe) return { error: `the record's file is not safe to write: ${unsafe}` }
        const hash = storeWrapup(root, w)
        ledgerRecord(root, op.board, `wrapup:${w.id}:${hash}`)
        const card = addWrapup(j, w, hash, op.board)
        endSession(j, op.id)
        q.persist()
        return { card: structuredClone(card) }
      })
      if ('error' in r) return { ok: false, error: r.error }
      reserve(); queueChanged(); void pump()
      return { ok: true, session: null, card: r.card }
    },
    captureOpen(capture, session, on) {
      if (!CAPTURE_ID.test(capture) || !SESSION_ID.test(session)) return 'ok'
      if (!on) { openCaps.delete(capture); return 'ok' }
      // a renewal for one that has landed is late news: ignored (only landing or an explicit off clears one) -
      // unless it landed outside the session (it reached the server after the session ended): said again
      const landed = q.j.cards.find((c) => c.id === capture)
      if (landed) return landed.kind === 'capture' && landed.session !== session ? 'ended' : 'ok'
      // the session has ended (its record written, or ended without one): this capture is not in it - it
      // stands on its own, and its page is told (one already held open keeps holding until it lands)
      if (q.j.session?.id !== session && !openCaps.has(capture)) return 'ended'
      openCaps.set(capture, { session, until: Date.now() + 60_000 })
      return 'ok'
    },
    tags(id) {
      const ses = q.j.session
      return ses && ses.id === id ? tagsSince(q.j, ses.since) : 0
    },
    canWrap(id) {
      // the ledger as it is now (the queue's own copy refreshes only under its lock)
      const j = q.j, ctx = ctxFor(root)
      if (j.session?.id !== id) return 'no such session runs'
      // a capture of the session still open in some tab (recording, sealing, sending) belongs in the record
      if (openFor(id)) return 'a capture of the session is still recording or being sent - end it first, then write the record'
      for (const c of j.cards) {
        if (c.kind !== 'capture' || c.session !== id || ['draft', 'dropped', 'confirming'].includes(c.state)) continue
        if (!captureIntact(j, ctx, c.id)) return 'a capture of the session changed after it was confirmed - capture it again, then write the record'
      }
      const unsafe = recordPathProblem(root, recordFile(root, j.session.since, id))
      return unsafe ? `the record's file is not safe to write: ${unsafe}` : null
    },
    record(id) {
      const c = q.j.cards.find((x) => x.id === id && x.kind === 'wrapup')
      const w = c && readWrapup(root, wrapupOf(c))
      if (!c || !w) return null
      const file = w.wrapup.file
      let text: string | null = null
      // read only the record's own file - never through a link, never outside the project
      try { if (!recordPathProblem(root, file)) text = readFileSync(join(root, file), 'utf8').slice(0, 500_000) } catch { text = null }
      const reply = resultFor(q.j, c)
      return { file, text, ...(reply ? { reply } : {}) }
    },
    async capture(raw) {
      const rec = checkRecord(raw)
      if (typeof rec === 'string') return { ok: false, error: rec }
      // it is still open until it has landed whole - its card made, and queued at once when that is the
      // setting: only then is it no longer open (a record sealed meanwhile waits for it)
      // (and while it lands - a retry or a re-sent upload included - it is held open here on the server)
      const ses = rec.context.session
      if (ses) landing.set(rec.id, { session: ses, n: (landing.get(rec.id)?.n ?? 0) + 1 })
      try {
        const r = await landCapture(rec)
        if (r.ok) nameCapture(rec.id)
        // made in a session that had ended when it reached the server: it stands on its own - its page is told
        const c = r.ok ? q.j.cards.find((x) => x.id === rec.id) : undefined
        return ses && c && c.session !== ses ? { ...r, outside: true as const } : r
      } finally {
        openCaps.delete(rec.id)
        const l = landing.get(rec.id)
        if (l) { if (l.n <= 1) landing.delete(rec.id); else l.n -= 1 }
      }
    },

    async act(id, rev, action, body) {
      const c = q.j.cards.find((x) => x.id === id)
      // a run your session went quiet on (spec 29b, Part 7): give it back, run it in the background, or drop it -
      // through its card, at the run's current generation (the run API names both)
      if (action === 'session-again' || action === 'session-background' || action === 'session-drop') {
        if (!c || c.rev !== rev) return { ok: false, ...(c ? { card: structuredClone(c) } : {}), error: 'the card changed - look again' }
        const b = q.j.batches.find((x) => x.batchId === c.batch)
        if (!b?.claim) return { ok: false, card: structuredClone(c), error: 'no session holds it now' }
        const r = await runs.act(b.batchId, b.claim.gen, action === 'session-again' ? 'again' : action === 'session-background' ? 'background' : 'drop')
        queueChanged()
        return { ...r, card: structuredClone(c) }
      }
      if (c?.kind === 'capture' && (action === 'confirm' || (action === 'keep' && (c.state === 'draft' || c.state === 'confirming')))) return confirm(id, rev, action === 'confirm' ? 'queued' : 'kept')
      if (action === 'good' && c && c.kind !== 'comment') return good(id, rev)
      // a More-work note that only approves ("looks good") settles the review - it never runs the work again
      if (action === 'more' && c && c.kind !== 'comment' && c.state === 'review' && isApproval(body ?? '')) return good(id, rev)
      if (action === 'more' && c && c.kind !== 'comment') return moreWork(id, rev, body ?? '')
      // Retry on a card whose results are saved but were never posted posts them - it never reruns
      const saved = await q.lock((j) => {
        const c = j.cards.find((x) => x.id === id)
        const b = c && action === 'retry' && c.state === 'failed' && c.rev === rev ? j.batches.find((x) => x.batchId === c.batch && x.state === 'claimed' && x.results && x.undelivered) : undefined
        const r = b?.results?.[b.members.find((m) => m.card === id)?.id ?? '']
        if (!b || !r || !('body' in r)) return null   // only a saved reply is posted again; anything else reruns
        redelivering(j, b); q.persist()
        return { b, card: structuredClone(c!) }
      })
      if (saved) { redeliver(saved.b, 1, 0); queueChanged(); return { ok: true, card: saved.card } }
      // the card as this action left it - a copy, so the next claim cannot change the answer under the caller
      const r = await q.lock((j) => { const out = act(j, id, rev, action, Date.now(), body); if (out.ok) q.persist(); return { ...out, ...(out.card ? { card: structuredClone(out.card) } : {}) } })
      if (r.ok) { reserve(); queueChanged(); void pump() }
      return r
    },
    async poke() {
      const sig = () => q.j.cards.map((c) => `${c.id}:${c.rev}`).join()
      const before = sig()
      await q.lock(() => {})
      if (sig() !== before) { queueChanged(); void pump() }
    },
  }
}

/** Start the daemon inside the dev server. Presence goes through the process-wide shared
 *  activity set (work.ts) - the `marver work` CLI writes the same set, so the canvas shows
 *  one merged glow, and its holds are also reservations (reserve.ts), restored here before
 *  anything is scheduled. Returns null when the adapter is unavailable or another dev server
 *  already holds the repo lock (that one runs the loop; this one watches without it). `watched` takes the comments
 *  watcher as it is made, so its error is the dev server's to say (dev.ts watchGuard), never Node's unhandled one. */
export function startJam(root: string, cfg: JamConfig, log: (m: string) => void = () => {}, onChanged: (board: string) => void = () => {}, anchor?: JamHooks['anchor'], onQueue?: () => void, shoot?: JamHooks['shoot'], watched?: (w: FSWatcher) => unknown): JamDaemon | null {
  const adapter: JamAdapter | null = adapters[cfg.agent] ?? null
  if (!adapter) { log(`  jam: the "${cfg.agent}" adapter is not available yet; Live Jam is off`); return null }
  if (!acquireLock(root)) { log('  jam: another marver dev holds the repo lock; this server watches without the daemon'); return null }

  const commentsDir = join(root, 'design', 'comments')
  mkdirSync(commentsDir, { recursive: true })   // so the watcher always attaches (not just after the first comment)
  const activity = workActivity
  restoreHolds(root, activity)
  const core = createJam(root, cfg, adapter, log, {
    // jam-scoped leases: a `marver work done --all` from a chat agent must never
    // extinguish a running jam job's glow (and vice versa)
    work: (f, on) => (on ? activity.mark(f ?? '', undefined, 'jam') : activity.clear(f ?? '', 'jam')),
    changed: onChanged,
    held: (f) => activity.has(f, 'cli'),
    anyHold: () => activity.leases('cli').length > 0,
    watchHolds: (fn) => activity.onChange(() => { if (activity.leases('cli').length > 0) fn() }),
    queue: onQueue,
    anchor,
    shoot,
  })
  let stopped = false
  let scheduled: ReturnType<typeof setTimeout> | null = null
  const schedule = () => { if (!scheduled && !stopped) scheduled = setTimeout(() => { scheduled = null; void core.poke() }, 150) }

  let watcher: FSWatcher | null = null
  try { watcher = fsWatch(commentsDir, { persistent: false }, schedule); watched?.(watcher) } catch { /* rescan is the backstop */ }
  const interval = setInterval(() => void core.poke(), RESCAN_MS)
  interval.unref?.()
  // session runs (spec 29b): requests from sessions answered at once, offers and stalls looked at every 2 s
  let ticking = false
  const runTick = () => { if (ticking || stopped) return; ticking = true; core.runs.tick().catch((err) => log(`  jam: session tick error - ${(err as Error).message}`)).finally(() => { ticking = false }) }
  const sessionWatchers: FSWatcher[] = []
  // (a session connecting or ending shows in the start sheet and the lane at once: the queue is pushed)
  let pushDue: ReturnType<typeof setTimeout> | null = null
  const connsChanged = () => { runTick(); pushDue ??= setTimeout(() => { pushDue = null; try { onQueue?.() } catch { /* advisory */ } }, 250) }
  for (const [dir, on] of [[reqDir(root), runTick], [connDir(root), connsChanged]] as const) {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); const w = fsWatch(dir, { persistent: false }, on); w.on('error', () => {}); sessionWatchers.push(w) } catch { /* the interval is the backstop */ }
  }
  const sessionInterval = setInterval(runTick, 2_000)
  sessionInterval.unref?.()
  // stale-glow expiry (a dead job's lease) is swept by the dev server, which owns the shared set
  void core.tick()
  jamLive.poke = () => void core.poke()
  jamLive.view = () => core.view()
  jamLive.act = (id, rev, action, body) => core.act(id, rev, action, body)
  jamLive.capture = (record) => core.capture(record)
  jamLive.sealed = (id) => core.sealed(id)
  jamLive.session = (op) => core.session(op)
  jamLive.record = (id) => core.record(id)
  jamLive.canWrap = (id) => core.canWrap(id)
  jamLive.captureOpen = (c, ses, on) => core.captureOpen(c, ses, on)
  jamLive.tags = (id) => core.tags(id)
  jamLive.runAct = (batch, gen, action) => core.runs.act(batch, gen, action)
  jamLive.refresh = () => { try { onQueue?.() } catch { /* a push is advisory */ } runTick() }

  // Jam arms itself, so this line is the only notice a workspace with no jam block gets -
  // it has to name the agent AND the way out.
  log(`  jam: on (${adapter.name}) - tag @marver in a comment and it does the work; \`jam: false\` in design/config.ts turns it off`)
  return {
    stop() {
      stopped = true
      if (scheduled) clearTimeout(scheduled)
      clearInterval(interval)
      clearInterval(sessionInterval)
      if (pushDue) clearTimeout(pushDue)
      watcher?.close()
      for (const w of sessionWatchers) w.close()
      core.stop()
      delete jamLive.poke; delete jamLive.view; delete jamLive.act; delete jamLive.capture
      jamReservations.frames.clear(); jamReservations.exclusive = null; jamReservations.settling = false
      releaseLock(root)
    },
  }
}

