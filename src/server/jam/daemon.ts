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
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { appendEvents, readLog, replay, type CommentEvent } from '../comments.ts'
import type { JamConfig } from '../config.ts'
import { claudeAdapter } from './adapter/claude.ts'
import { codexAdapter } from './adapter/codex.ts'
import { createActivity } from './activity.ts'
import { acquireLock, baseline, releaseLock, write } from './journal.ts'
import { buildMember, buildPacket, goalText, threadId } from './packet.ts'
import { scanPending, triggers, allEventIds } from './watch.ts'
import type { Batch, JamAdapter, Journal, Pending, Reanchor } from './types.ts'

const LEASE_MS = 5 * 60_000
const JOB_TIMEOUT_MS = 5 * 60_000
const MAX_ATTEMPTS = 2
const MAX_OUT = 2_000_000
const RESCAN_MS = 5_000

export interface JamDaemon { stop(): void }
export interface JamCore { tick(): Promise<void>; stop(): void; snapshot(): Journal }
/** Side-effect hooks the dev server wires up (presence glow). Optional, so tests stay pure. */
export interface JamHooks { work?(frame: string | undefined, on: boolean): void }

/** Kill a whole process group (the child is detached, so pid === pgid). Best-effort. */
const fenceGroup = (pid?: number) => { try { if (pid) process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }

/** The loop, without timers/watch/lock. Baselines on creation, then each `tick()` resumes any
 *  leftover batches (re-validate + fence + re-run) and claims new owner-ledgered mentions. */
export function createJam(root: string, cfg: JamConfig, adapter: JamAdapter, log: (m: string) => void = () => {}, hooks: JamHooks = {}): JamCore {
  const commentsDir = join(root, 'design', 'comments')
  let journal: Journal = baseline(root, allEventIds(commentsDir))
  const persist = () => write(root, (journal = { ...journal }))

  let running = false
  let stopped = false
  const activeChildren = new Set<ChildProcess>()   // concurrent jobs (bounded by jam.concurrency)

  type AgentRun = { reply: string; model?: string; ok: boolean; reanchors: Reanchor[] }
  const runAgent = (goal: string, onSpawn: (pid?: number) => void): Promise<AgentRun> =>
    new Promise((resolve) => {
      const { cmd, args } = adapter.spawnArgs(goal)
      let child: ChildProcess
      // stderr is discarded at the OS level: an undrained pipe would fill and block the child.
      try { child = spawn(cmd, args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'ignore'] }) }
      catch { return resolve({ reply: '', ok: false, reanchors: [] }) }
      activeChildren.add(child)
      try { onSpawn(child.pid) } catch { /* pgid persist failed; the run still proceeds, fencing degrades */ }
      let out = ''
      let settled = false
      const settle = (r: AgentRun) => {
        if (settled) return
        settled = true; clearTimeout(to); activeChildren.delete(child); resolve(r)
      }
      const to = setTimeout(() => { fenceGroup(child.pid); settle({ reply: '', ok: false, reanchors: [] }) }, JOB_TIMEOUT_MS)
      child.stdout?.on('data', (d: Buffer) => { out += d; if (out.length > MAX_OUT) out = out.slice(-MAX_OUT) })
      child.on('close', (code) => settle(adapter.parse(out, code ?? 1)))
      child.on('error', () => settle({ reply: '', ok: false, reanchors: [] }))
    })

  const writeReply = (b: Batch, p: Pending, body: string, model?: string) => {
    const me = localProfile(root)
    // Deterministic ids: a re-run produces the SAME reply, so appendEvents dedups it (crash-safe).
    const reply: CommentEvent = {
      id: `jam-${b.batchId}`, ts: Date.now(), type: 'reply',
      commentId: `jam-c-${b.batchId}`, parentId: threadId(p.event),
      board: b.board, author: me, body,
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
    for (const ev of readLog(commentsDir, board)) if (ev.id === id) return triggers(root, board, ev) ? { board, event: ev } : null
    return null
  }

  const runBatch = async (b: Batch, p: Pending) => {
    b.attempts += 1; b.state = 'claimed'; b.leaseUntil = Date.now() + LEASE_MS; persist()
    const threads = replay(readLog(commentsDir, b.board))
    const member = buildMember(p, threads)
    const packet = buildPacket(b.batchId, [member])
    // Presence glow (SPEC §10/§13): the frame is "working" for the whole run. For a net-new frame
    // the node appears only once the agent scaffolds it, then picks up the glow from this set.
    hooks.work?.(member.frame, true)
    const run = await runAgent(goalText(packet), (pid) => { b.pgid = pid; persist() })
    if (stopped) { hooks.work?.(member.frame, false); return }
    if (run.ok) {
      writeReply(b, p, run.reply, run.model)
      emitReanchors(b, run.reanchors)
      hooks.work?.(member.frame, false)
      finish(b)
      log(`  jam: replied on ${b.board}${run.model ? ` (${run.model})` : ''}${run.reanchors.length ? ` · re-pinned ${run.reanchors.length}` : ''}`)
    } else if (b.attempts >= MAX_ATTEMPTS) {
      writeReply(b, p, "I couldn't finish that one. Try rephrasing, or check the dev logs.", run.model)
      hooks.work?.(member.frame, false)
      finish(b)
      log(`  jam: gave up on ${b.board} after ${b.attempts} attempts`)
    } else {
      b.state = 'pending'; persist()   // retry on the next tick; keep the glow (still in progress)
    }
  }

  const claim = (p: Pending): Batch => {
    const b: Batch = { batchId: randomUUID(), board: p.board, memberEventIds: [p.event.id], state: 'claimed', leaseUntil: 0, attempts: 0 }
    journal.seen = [...journal.seen, p.event.id]
    journal.batches = [...journal.batches, b]
    persist()
    return b
  }

  const tick = async () => {
    if (running || stopped) return
    running = true
    try {
      // 1. resume batches a dead process left behind (fence the orphan, re-validate, re-run, §3.2)
      for (const b of [...journal.batches]) {
        if (stopped) break
        if (b.state !== 'claimed' && b.state !== 'pending') continue
        if (b.state === 'claimed') fenceGroup(b.pgid)   // an orphan may still be editing
        const p = resolveMember(b.board, b.memberEventIds[0])
        if (p) await runBatch(b, p)
        else finish(b)   // no longer authorized/present → drop, never run stale/foreign content
      }
      // 2. claim new owner-ledgered mentions, grouped into per-FRAME serial chains that run
      //    bounded-parallel (SPEC §12): several frames build at once (multi-frame glow), but the
      //    SAME frame FILE never has two agents (non-negotiable). The key is the EFFECTIVE frame
      //    (a reply inherits the root thread's frame, and a frame file is global across boards),
      //    so replies on one thread and the same file shown on two boards both serialize.
      //    Honest residual: two concurrent jobs on DIFFERENT frames could still touch a shared
      //    component file - the goal-phrased re-run reconciles if so.
      if (!stopped) {
        const boardThreads = new Map<string, ReturnType<typeof replay>>()
        const threadsOf = (b: string) => boardThreads.get(b) ?? (boardThreads.set(b, replay(readLog(commentsDir, b))).get(b)!)
        const frameKey = (p: Pending): string => {
          if (p.event.frame) return `f:${p.event.frame}`
          const rt = threadsOf(p.board).find((t) => t.id === threadId(p.event))
          return rt?.frame ? `f:${rt.frame}` : `t:${threadId(p.event) || p.event.id}`
        }
        const chains = new Map<string, Pending[]>()
        for (const p of scanPending(root, commentsDir, journal)) {
          const key = frameKey(p)
          const arr = chains.get(key) ?? []
          arr.push(p); chains.set(key, arr)
        }
        await runPool([...chains.values()].map((ps) => async () => {
          for (const p of ps) { if (stopped) break; await runBatch(claim(p), p) }
        }), Math.max(1, cfg.concurrency))
      }
    } catch (err) {
      log(`  jam: tick error - ${(err as Error).message}`)
    } finally { running = false }
  }

  return {
    tick,
    stop() { stopped = true; for (const c of activeChildren) fenceGroup(c.pid) },
    snapshot() { return journal },
  }
}

/** Run thunks with a concurrency cap. Same-frame chains are already serial within a thunk. A
 *  thunk that throws is caught (its batch stays claimed and resumes next tick); the pool ALWAYS
 *  drains every worker before returning, so the tick never releases while a job is still live. */
async function runPool(thunks: (() => Promise<void>)[], limit: number): Promise<void> {
  const q = [...thunks]
  const worker = async () => { while (q.length) { const t = q.shift(); if (t) { try { await t() } catch { /* batch resumes next tick */ } } } }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, q.length || 1)) }, worker))
}

/** Start the daemon inside the dev server. `onActivity` receives the set of frames currently being
 *  worked, for the presence glow (SPEC §10). Returns null when the adapter is unavailable or another
 *  dev server already holds the repo lock (that one runs the loop; this one watches without it). */
export function startJam(root: string, cfg: JamConfig, log: (m: string) => void = () => {}, onActivity: (frames: string[]) => void = () => {}): JamDaemon | null {
  const adapter: JamAdapter | null = cfg.agent === 'claude' ? claudeAdapter : cfg.agent === 'codex' ? codexAdapter : null
  if (!adapter) { log(`  jam: the "${cfg.agent}" adapter is not available yet; Live Jam is off`); return null }
  if (!acquireLock(root)) { log('  jam: another marver dev holds the repo lock; this server watches without the daemon'); return null }

  const commentsDir = join(root, 'design', 'comments')
  mkdirSync(commentsDir, { recursive: true })   // so the watcher always attaches (not just after the first comment)
  const activity = createActivity()
  activity.onChange(onActivity)
  const core = createJam(root, cfg, adapter, log, { work: (f, on) => (on ? activity.mark(f ?? '') : activity.clear(f ?? '')) })
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

/** The dev-session owner identity (same source as api.ts's localProfile). The reply is authored
 *  by the owner + `agent:true`; the client renders it as "Marver" (SPEC §7). */
function localProfile(root: string): { email: string; name: string; avatar?: string } {
  try {
    const c = JSON.parse(readFileSync(join(root, 'design', '.local', 'collab.json'), 'utf8'))
    if (typeof c?.email === 'string' && c.email) return { email: c.email, name: c.name ?? 'Designer' }
  } catch { /* not connected */ }
  try {
    const p = JSON.parse(readFileSync(join(root, 'design', '.local', 'profile.json'), 'utf8'))
    if (typeof p?.name === 'string') return { email: p.email ?? '', name: p.name, avatar: p.avatar }
  } catch { /* no profile */ }
  return { email: '', name: 'Designer' }
}
