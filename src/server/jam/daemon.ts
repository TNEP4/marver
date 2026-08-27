/**
 * The Live Jam daemon - a module inside the long-lived dev server.
 *
 * The loop: watch design/comments/ (dir-watch + ~5s rescan) → find owner-ledgered @marver
 * mentions (watch.ts, the trust boundary) → claim each as a durable single-member batch
 * (journal.ts) → spawn one headless agent (adapter) with a goal-phrased untrusted packet
 * (packet.ts) → capture its reply → write it in-process as an owner-authored `agent:true`
 * event (comments.appendEvents) → mark the batch done.
 *
 * M1 = single-member batches, one at a time; M4 promotes to real multi-member batches.
 *
 * Crash safety: the reply event id is DETERMINISTIC per batch (`jam-<batchId>`), so a re-run
 * after a crash between "reply written" and "batch removed" dedups to one reply. A batch left
 * `claimed` by a dead process is re-run, but only after its members are re-validated through the
 * SAME trust gate (a synced event that reused a ledgered id on another board can never replace
 * the authorized job), and after best-effort fencing the orphan's process group.
 *
 * `createJam` is the loop with no timers or lock (a test drives `tick()` directly with an
 * injected adapter); `startJam` wraps it with the repo lock, dir-watch, and rescan interval.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync, watch as fsWatch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { toFrameId } from '../manifest.ts'
import { appendEvents, readLog, replay, type CommentEvent } from '../comments.ts'
import type { JamConfig } from '../config.ts'
import { localProfile } from '../profile.ts'
import { adapters } from './adapter/index.ts'
import { workActivity } from '../work.ts'
import { acquireLock, baseline, releaseLock, write } from './journal.ts'
import { buildMember, buildPacket, extractReanchors, extractReplyBlock, goalText, threadId } from './packet.ts'
import { scanPending, triggers, engagedThreads, allEventIds } from './watch.ts'
import type { Batch, JamAdapter, Journal, Pending, Reanchor } from './types.ts'

const LEASE_MS = 12 * 60_000
const JOB_TIMEOUT_MS = 10 * 60_000   // high-fi rebuilds legitimately run 5-8 min; 5 min was fencing good work
const MAX_ATTEMPTS = 2
const MAX_OUT = 2_000_000
const RESCAN_MS = 5_000

export interface JamDaemon { stop(): void }
export interface JamCore { tick(): Promise<void>; stop(): void; snapshot(): Journal }
/** Side-effect hooks the dev server wires up (presence glow, instant reply delivery).
 *  Optional, so tests stay pure. */
export interface JamHooks {
  work?(frame: string | undefined, on: boolean): void
  /** The daemon wrote events (reply/reanchor) to `board` - nudge clients to fetch NOW
   *  instead of waiting out the 30s comment poll. */
  changed?(board: string): void
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
  const { MARVER_CLI_TOKEN: _withheld, ...rest } = from
  return rest
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
    const base = rel.split('/').pop() ?? rel
    if (base.startsWith('_') || !FRAME_FILE.test(base)) continue
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

/** The loop, without timers/watch/lock. Baselines on creation, then each `tick()` resumes any
 *  leftover batches (re-validate + fence + re-run) and claims new owner-ledgered mentions. */
export function createJam(root: string, cfg: JamConfig, adapter: JamAdapter, log: (m: string) => void = () => {}, hooks: JamHooks = {}): JamCore {
  const commentsDir = join(root, 'design', 'comments')
  let journal: Journal = baseline(root, allEventIds(commentsDir))
  const persist = () => write(root, (journal = { ...journal }))

  let stopped = false
  const activeChildren = new Set<ChildProcess>()   // concurrent jobs (bounded by jam.concurrency)

  type AgentRun = { reply: string; model?: string; ok: boolean; reanchors: Reanchor[]; raw?: string }
  type Env = NodeJS.ProcessEnv
  const runAgent = (goal: string, onSpawn: (pid?: number) => void, onEarly?: (text: string, model?: string) => void): Promise<AgentRun> =>
    new Promise((resolve) => {
      const { cmd, args, env } = adapter.spawnArgs(goal)
      let child: ChildProcess
      // stderr is discarded at the OS level: an undrained pipe would fill and block the child.
      // PWD is pinned to the workspace: spawn's cwd does not update the inherited env var, and
      // some CLIs (opencode, verified) trust PWD over getcwd - without this, a dev server whose
      // own cwd differs from the repo root would have the agent editing the WRONG directory.
      try { child = spawn(cmd, args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...agentEnv(), ...env, PWD: root } }) }
      catch { return resolve({ reply: '', ok: false, reanchors: [] }) }
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
      const to = setTimeout(() => { fenceGroup(child.pid); settle({ reply: '', ok: false, reanchors: [] }) }, JOB_TIMEOUT_MS)
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
          const visible = extractReanchors(hit.text).reply
          const block = extractReplyBlock(visible)
          // A fenceless first message is a plain ACK, and models append plan narration to it
          // ("On it.\n\nNow let me gather context..."). The ack is ONE line to the owner, so keep
          // only the first paragraph - the narration after the blank line never reaches the thread.
          // A fenced first message is the real completion; leave its (possibly multi-paragraph) body.
          const hasFence = block !== visible.trim()
          const text = hasFence ? block : block.split(/\n\s*\n/)[0].trim()
          if (!text || metaNarration(text)) continue
          earlyFired = true
          try { onEarly!(text, hit.model) } catch { /* early delivery is best-effort */ }
          break
        }
      })
      child.on('close', (code) => settle({ ...adapter.parse(out, code ?? 1), raw: out }))
      child.on('error', () => settle({ reply: '', ok: false, reanchors: [] }))
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

  const writeReply = (b: Batch, p: Pending, body: string, model?: string, kind: 'reply' | 'early' = 'reply') => {
    const me = localProfile(root)
    // Deterministic ids: a re-run produces the SAME reply, so appendEvents dedups it (crash-safe).
    // The early ack gets its own id, so ack + final coexist as two thread messages.
    // early ids are per-ATTEMPT: attempt 2's ack must not dedup against attempt 1's (which said
    // something else) - a suppressed ack also poisoned the final's clarify-dedup
    const suffix = kind === 'early' ? `e${b.attempts}-${b.batchId}` : b.batchId
    const reply: CommentEvent = {
      id: `jam-${suffix}`, ts: Date.now(), type: 'reply',
      commentId: `jam-c-${suffix}`, parentId: threadId(p.event),
      board: b.board, author: me, body: plainDashes(body),
      agent: true, agentMeta: { devUser: me.name, harness: adapter.name, model },
    }
    appendEvents(commentsDir, b.board, [reply])
  }

  /** Emit reanchor events for threads the agent re-pinned. Owner-authored + agent:true
   *  (attributable, never re-triggers), deterministic ids so a re-run dedups. */
  const emitReanchors = (b: Batch, reanchors: Reanchor[]) => {
    if (!reanchors.length) return
    const me = localProfile(root)
    const events: CommentEvent[] = reanchors.map((r, i) => ({
      id: `jam-ra-${b.batchId}-${i}`, ts: Date.now(), type: 'reanchor',
      commentId: r.thread, anchor: r.anchor, board: b.board, author: me,
      agent: true, agentMeta: { devUser: me.name, harness: adapter.name },
    }))
    appendEvents(commentsDir, b.board, events)
  }

  const finish = (b: Batch) => { journal.batches = journal.batches.filter((x) => x.batchId !== b.batchId); persist() }

  /** Resolve a batch member from ITS board only, re-checking the trust gate. readLog dedups by id
   *  keeping the first occurrence (the owner's, written first), so a colliding synced id cannot win,
   *  and `triggers` re-confirms ledger/agent/type/mention - the job can never drift to other content. */
  const resolveMember = (board: string, id: string): Pending | null => {
    const events = readLog(commentsDir, board)
    const engaged = engagedThreads(events)
    for (const ev of events) if (ev.id === id) return triggers(root, board, ev, engaged) ? { board, event: ev } : null
    return null
  }

  const runBatch = async (b: Batch, p: Pending) => {
    b.attempts += 1; b.state = 'claimed'; b.leaseUntil = Date.now() + LEASE_MS; persist()
    const threads = replay(readLog(commentsDir, b.board))
    const member = buildMember(p, threads)
    const packet = buildPacket(b.batchId, [member])
    // Presence glow that FOLLOWS the work. Jam agents have no shell to run `marver work`, so the
    // daemon moves the glow itself: the commented frame lights up instantly ("I heard you"), then
    // as the agent CREATES or EDITS frames the glow moves to those - and off the commented frame
    // once the agent is clearly building elsewhere (it was only the trigger, not the target). A
    // common ask is "one frame per page", where the answer is five NEW frames, not an edit to the
    // one the comment sits on. The tick also re-marks every lit frame to keep its lease alive.
    const lit = new Set<string>()
    const light = (f?: string) => { if (f && !lit.has(f)) { hooks.work?.(f, true); lit.add(f) } }
    const clearGlow = () => { for (const f of lit) hooks.work?.(f, false); lit.clear() }
    const startMtimes = sceneFrameMtimes(root)
    const touched = new Set<string>()
    light(member.frame)
    const followWork = () => {
      for (const [id, mt] of sceneFrameMtimes(root)) if (startMtimes.get(id) !== mt) touched.add(id)   // created or edited
      for (const id of touched) light(id)
      // the commented frame was only the trigger if the agent built elsewhere and never touched it
      if (member.frame && lit.has(member.frame) && !touched.has(member.frame) && touched.size > 0) {
        hooks.work?.(member.frame, false); lit.delete(member.frame)
      }
      for (const f of lit) hooks.work?.(f, true)   // heartbeat: keep every lit frame's lease alive
    }
    const beat = setInterval(followWork, 2_000)
    beat.unref?.()
    // The agent's FIRST line streams out within seconds - post it live (its own ack, or its
    // clarifying question). Real output, not a canned placeholder.
    let earlyBody: string | undefined
    let run: Awaited<ReturnType<typeof runAgent>>
    try {
      run = await runAgent(goalText(packet, cfg.subagents && adapter.supportsSubagents), (pid) => { b.pgid = pid; persist() }, (text, model) => {
        // write FIRST, remember after: if the append throws, the final must not be suppressed
        // as a "duplicate" of an ack that never actually posted
        writeReply(b, p, text, model, 'early')
        earlyBody = text
        hooks.changed?.(b.board)
      })
    } finally { clearInterval(beat) }
    logRun(b.batchId, run.raw)
    if (stopped) { clearGlow(); return }
    if (run.ok) {
      // Clarify-and-stop: the agent asked a question and ended - its final message IS the early
      // one, so don't post it twice.
      if (run.reply !== earlyBody) writeReply(b, p, run.reply, run.model)
      emitReanchors(b, run.reanchors)
      hooks.changed?.(b.board)
      clearGlow()
      finish(b)
      log(`  jam: replied on ${b.board}${run.model ? ` (${run.model})` : ''}${run.reanchors.length ? ` · re-pinned ${run.reanchors.length}` : ''}`)
    } else if (b.attempts >= MAX_ATTEMPTS) {
      writeReply(b, p, "I couldn't finish that one. The raw run log is in design/.local/jam-logs - the troubleshooting drill in design/instructions/jam.md reads it. Or just rephrase and try again.", run.model)
      hooks.changed?.(b.board)
      clearGlow()
      finish(b)
      log(`  jam: gave up on ${b.board} after ${b.attempts} attempts`)
    } else {
      b.state = 'pending'; persist()   // retried by the chain; keep the glow (still in progress)
    }
  }

  const claim = (p: Pending): Batch => {
    const b: Batch = { batchId: randomUUID(), board: p.board, memberEventIds: [p.event.id], state: 'claimed', leaseUntil: 0, attempts: 0 }
    journal.seen = [...journal.seen, p.event.id]
    journal.batches = [...journal.batches, b]
    persist()
    return b
  }

  // ---- the continuous scheduler --------------------------------------------------
  // Claim-on-sight, per-FRAME serial chains, a GLOBAL concurrency cap, and a pump that starts a
  // new chain the moment a mention lands - even while other agents are mid-run. (The old
  // single-flight tick made a new ask wait for the ENTIRE current run to finish - a second
  // comment fired during a long job could stall for minutes.) The same frame file never has
  // two agents (per-key queue = strict serial); different frames run concurrently up to
  // jam.concurrency. Claiming is SYNCHRONOUS (scan -> claim -> enqueue with no await between),
  // so overlapping wakes can never double-claim an event.
  const chains = new Map<string, { items: { b: Batch; p: Pending }[]; running: boolean }>()
  let activeChains = 0

  const frameKey = (p: Pending): string => {
    // the EFFECTIVE frame: a reply inherits the root thread's frame, and a frame file is global
    // across boards - so replies on one thread and the same file on two boards both serialize
    if (p.event.frame) return `f:${p.event.frame}`
    const rt = replay(readLog(commentsDir, p.board)).find((t) => t.id === threadId(p.event))
    return rt?.frame ? `f:${rt.frame}` : `t:${threadId(p.event) || p.event.id}`
  }

  const pump = () => {
    if (stopped) return
    for (const [key, q] of chains) {
      if (activeChains >= Math.max(1, cfg.concurrency)) break
      if (q.running || !q.items.length) continue
      q.running = true
      activeChains += 1
      void (async () => {
        try {
          while (!stopped && q.items.length) {
            const job = q.items.shift()!
            try { await runBatch(job.b, job.p) } catch (err) {
              // a THROW must not strand the batch as `claimed` outside every queue (rescans skip
              // seen ids; resume runs once) - mark pending so the re-push below retries it, still
              // bounded by MAX_ATTEMPTS
              log(`  jam: batch error - ${(err as Error).message}`)
              if (job.b.attempts < MAX_ATTEMPTS) { job.b.state = 'pending'; try { persist() } catch { /* retried in-memory regardless */ } }
              else finish(job.b)
            }
            if (job.b.state === 'pending') q.items.push(job)   // failed attempt - retry after the rest of the chain
          }
        } finally {
          q.running = false
          activeChains -= 1
          if (!q.items.length) chains.delete(key)
          pump()
        }
      })()
    }
  }

  const enqueue = (b: Batch, p: Pending) => {
    const key = frameKey(p)
    const q = chains.get(key) ?? { items: [], running: false }
    q.items.push({ b, p })
    chains.set(key, q)
    pump()
  }

  /** All work idle - every chain drained. Lets `tick()` stay awaitable (tests, orderly shutdown).
   *  ONE shared waiter: overlapping ticks (the 5s rescan during a 10-min job) join the same
   *  promise instead of each spinning its own poll loop. */
  let idleP: Promise<void> | null = null
  const idle = () => {
    if (activeChains === 0 && chains.size === 0) return Promise.resolve()
    idleP ??= new Promise<void>((res) => {
      const check = () => {
        if (stopped || (activeChains === 0 && chains.size === 0)) { idleP = null; res() }
        else setTimeout(check, 50)
      }
      check()
    })
    return idleP
  }

  let resumed = false
  const tick = async () => {
    if (stopped) return
    try {
      // 1. once per daemon life: resume batches a dead process left behind (fence + re-validate, §3.2)
      if (!resumed) {
        resumed = true
        for (const b of [...journal.batches]) {
          if (b.state !== 'claimed' && b.state !== 'pending') continue
          if (b.state === 'claimed') fenceGroup(b.pgid)   // an orphan may still be editing
          const p = resolveMember(b.board, b.memberEventIds[0])
          if (p) enqueue(b, p)
          else finish(b)   // no longer authorized/present → drop, never run stale/foreign content
        }
      }
      // 2. claim new owner-ledgered mentions IMMEDIATELY (sync) and pump
      for (const p of scanPending(root, commentsDir, journal)) enqueue(claim(p), p)
    } catch (err) {
      log(`  jam: tick error - ${(err as Error).message}`)
    }
    await idle()
  }

  return {
    tick,
    stop() { stopped = true; for (const c of activeChildren) fenceGroup(c.pid) },
    snapshot() { return journal },
  }
}

/** Start the daemon inside the dev server. Presence goes through the process-wide shared
 *  activity set (work.ts) - the `marver work` CLI writes the same set, so the canvas shows
 *  one merged glow. Returns null when the adapter is unavailable or another dev server
 *  already holds the repo lock (that one runs the loop; this one watches without it). */
export function startJam(root: string, cfg: JamConfig, log: (m: string) => void = () => {}, onChanged: (board: string) => void = () => {}): JamDaemon | null {
  const adapter: JamAdapter | null = adapters[cfg.agent] ?? null
  if (!adapter) { log(`  jam: the "${cfg.agent}" adapter is not available yet; Live Jam is off`); return null }
  if (!acquireLock(root)) { log('  jam: another marver dev holds the repo lock; this server watches without the daemon'); return null }

  const commentsDir = join(root, 'design', 'comments')
  mkdirSync(commentsDir, { recursive: true })   // so the watcher always attaches (not just after the first comment)
  const activity = workActivity
  const core = createJam(root, cfg, adapter, log, {
    // jam-scoped leases: a `marver work done --all` from a chat agent must never
    // extinguish a running jam job's glow (and vice versa)
    work: (f, on) => (on ? activity.mark(f ?? '', undefined, 'jam') : activity.clear(f ?? '', 'jam')),
    changed: onChanged,
  })
  let stopped = false
  let scheduled: ReturnType<typeof setTimeout> | null = null
  const schedule = () => { if (!scheduled && !stopped) scheduled = setTimeout(() => { scheduled = null; void core.tick() }, 150) }

  let watcher: FSWatcher | null = null
  try { watcher = fsWatch(commentsDir, { persistent: false }, schedule) } catch { /* rescan is the backstop */ }
  const interval = setInterval(() => void core.tick(), RESCAN_MS)
  interval.unref?.()
  // stale-glow expiry (a dead job's lease) is swept by the dev server, which owns the shared set
  void core.tick()

  // Jam arms itself, so this line is the only notice a workspace with no jam block gets -
  // it has to name the agent AND the way out.
  log(`  jam: on (${adapter.name}) - tag @marver in a comment and it does the work; \`jam: false\` in design/config.ts turns it off`)
  return {
    stop() {
      stopped = true
      if (scheduled) clearTimeout(scheduled)
      clearInterval(interval)
      watcher?.close()
      core.stop()
      releaseLock(root)
    },
  }
}

