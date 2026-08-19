/**
 * The Live Jam daemon (SPEC-live-jam §3) - a module inside the long-lived dev server.
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
import { appendEvents, readLog, replay, type CommentEvent } from '../comments.ts'
import type { JamConfig } from '../config.ts'
import { localProfile } from '../profile.ts'
import { claudeAdapter } from './adapter/claude.ts'
import { codexAdapter } from './adapter/codex.ts'
import { createActivity } from './activity.ts'
import { acquireLock, baseline, releaseLock, write } from './journal.ts'
import { buildMember, buildPacket, goalText, threadId } from './packet.ts'
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

/** The loop, without timers/watch/lock. Baselines on creation, then each `tick()` resumes any
 *  leftover batches (re-validate + fence + re-run) and claims new owner-ledgered mentions. */
export function createJam(root: string, cfg: JamConfig, adapter: JamAdapter, log: (m: string) => void = () => {}, hooks: JamHooks = {}): JamCore {
  const commentsDir = join(root, 'design', 'comments')
  let journal: Journal = baseline(root, allEventIds(commentsDir))
  const persist = () => write(root, (journal = { ...journal }))

  let stopped = false
  const activeChildren = new Set<ChildProcess>()   // concurrent jobs (bounded by jam.concurrency)

  type AgentRun = { reply: string; model?: string; ok: boolean; reanchors: Reanchor[]; raw?: string }
  const runAgent = (goal: string, onSpawn: (pid?: number) => void, onEarly?: (text: string) => void): Promise<AgentRun> =>
    new Promise((resolve) => {
      const { cmd, args } = adapter.spawnArgs(goal)
      let child: ChildProcess
      // stderr is discarded at the OS level: an undrained pipe would fill and block the child.
      try { child = spawn(cmd, args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'ignore'] }) }
      catch { return resolve({ reply: '', ok: false, reanchors: [] }) }
      activeChildren.add(child)
      try { onSpawn(child.pid) } catch { /* pgid persist failed; the run still proceeds, fencing degrades */ }
      let out = ''
      let lineBuf = ''          // scan complete stdout lines for the agent's FIRST message
      let earlyFired = !onEarly || !adapter.earlyText
      let settled = false
      // a UTF-8 char split across chunks must not become replacement bytes mid-JSONL (Codex P2)
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
          const text = adapter.earlyText!(line)
          if (text) { earlyFired = true; try { onEarly!(text) } catch { /* early delivery is best-effort */ } break }
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

  /** Nic's rule: never an em/en dash in a reply - a plain dash reads human. */
  const plainDashes = (s: string) => s.replace(/\s*[—–]\s*/g, ' - ')

  const writeReply = (b: Batch, p: Pending, body: string, model?: string, kind: 'reply' | 'early' = 'reply') => {
    const me = localProfile(root)
    // Deterministic ids: a re-run produces the SAME reply, so appendEvents dedups it (crash-safe).
    // The early ack gets its own id, so ack + final coexist as two thread messages.
    // early ids are per-ATTEMPT: attempt 2's ack must not dedup against attempt 1's (which said
    // something else) - a suppressed ack also poisoned the final's clarify-dedup (Codex P1)
    const suffix = kind === 'early' ? `e${b.attempts}-${b.batchId}` : b.batchId
    const reply: CommentEvent = {
      id: `jam-${suffix}`, ts: Date.now(), type: 'reply',
      commentId: `jam-c-${suffix}`, parentId: threadId(p.event),
      board: b.board, author: me, body: plainDashes(body),
      agent: true, agentMeta: { devUser: me.name, harness: adapter.name, model },
    }
    appendEvents(commentsDir, b.board, [reply])
  }

  /** Emit reanchor events for threads the agent re-pinned (SPEC §11). Owner-authored + agent:true
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
    // Presence glow (SPEC §10/§13): the frame is "working" for the WHOLE run - a heartbeat keeps
    // the activity lease alive (long jobs run many minutes; a one-shot mark lapsed at 90s and the
    // glow died mid-job). The glow clears ONLY when the job ends (done or terminal failure).
    hooks.work?.(member.frame, true)
    const beat = setInterval(() => hooks.work?.(member.frame, true), 30_000)
    beat.unref?.()
    // The agent's FIRST line streams out within seconds - post it live (its own ack, or its
    // clarifying question). Real output, not a canned placeholder.
    let earlyBody: string | undefined
    let run: Awaited<ReturnType<typeof runAgent>>
    try {
      run = await runAgent(goalText(packet), (pid) => { b.pgid = pid; persist() }, (text) => {
        // write FIRST, remember after: if the append throws, the final must not be suppressed
        // as a "duplicate" of an ack that never actually posted (Codex P1)
        writeReply(b, p, text, undefined, 'early')
        earlyBody = text
        hooks.changed?.(b.board)
      })
    } finally { clearInterval(beat) }
    logRun(b.batchId, run.raw)
    if (stopped) { hooks.work?.(member.frame, false); return }
    if (run.ok) {
      // Clarify-and-stop: the agent asked a question and ended - its final message IS the early
      // one, so don't post it twice.
      if (run.reply !== earlyBody) writeReply(b, p, run.reply, run.model)
      emitReanchors(b, run.reanchors)
      hooks.changed?.(b.board)
      hooks.work?.(member.frame, false)
      finish(b)
      log(`  jam: replied on ${b.board}${run.model ? ` (${run.model})` : ''}${run.reanchors.length ? ` · re-pinned ${run.reanchors.length}` : ''}`)
    } else if (b.attempts >= MAX_ATTEMPTS) {
      writeReply(b, p, "I couldn't finish that one. Try rephrasing, or check the dev logs.", run.model)
      hooks.changed?.(b.board)
      hooks.work?.(member.frame, false)
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

  // ---- the continuous scheduler (SPEC §12) --------------------------------------------------
  // Claim-on-sight, per-FRAME serial chains, a GLOBAL concurrency cap, and a pump that starts a
  // new chain the moment a mention lands - even while other agents are mid-run. (The old
  // single-flight tick made a new ask wait for the ENTIRE current run to finish - Nic hit a
  // 6.5-minute stall firing a second comment during a long job.) The same frame file never has
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
              // bounded by MAX_ATTEMPTS (Codex P1)
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

/** Start the daemon inside the dev server. `onActivity` receives the set of frames currently being
 *  worked, for the presence glow (SPEC §10). Returns null when the adapter is unavailable or another
 *  dev server already holds the repo lock (that one runs the loop; this one watches without it). */
export function startJam(root: string, cfg: JamConfig, log: (m: string) => void = () => {}, onActivity: (frames: string[]) => void = () => {}, onChanged: (board: string) => void = () => {}): JamDaemon | null {
  const adapter: JamAdapter | null = cfg.agent === 'claude' ? claudeAdapter : cfg.agent === 'codex' ? codexAdapter : null
  if (!adapter) { log(`  jam: the "${cfg.agent}" adapter is not available yet; Live Jam is off`); return null }
  if (!acquireLock(root)) { log('  jam: another marver dev holds the repo lock; this server watches without the daemon'); return null }

  const commentsDir = join(root, 'design', 'comments')
  mkdirSync(commentsDir, { recursive: true })   // so the watcher always attaches (not just after the first comment)
  const activity = createActivity()
  activity.onChange(onActivity)
  const core = createJam(root, cfg, adapter, log, {
    work: (f, on) => (on ? activity.mark(f ?? '') : activity.clear(f ?? '')),
    changed: onChanged,
  })
  let stopped = false
  let scheduled: ReturnType<typeof setTimeout> | null = null
  const schedule = () => { if (!scheduled && !stopped) scheduled = setTimeout(() => { scheduled = null; void core.tick() }, 150) }

  let watcher: FSWatcher | null = null
  try { watcher = fsWatch(commentsDir, { persistent: false }, schedule) } catch { /* rescan is the backstop */ }
  const interval = setInterval(() => void core.tick(), RESCAN_MS)
  interval.unref?.()
  const sweep = setInterval(() => activity.sweep(), 30_000)   // expire stale glows if a job died
  sweep.unref?.()
  void core.tick()

  log(`  jam: watching for @marver (${adapter.name})`)
  return {
    stop() {
      stopped = true
      if (scheduled) clearTimeout(scheduled)
      clearInterval(interval)
      clearInterval(sweep)
      watcher?.close()
      core.stop()
      releaseLock(root)
    },
  }
}

