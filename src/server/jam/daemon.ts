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
 * Recovery is fence + goal-phrased re-run: a batch left `claimed` by a dead process is
 * re-run on the next tick (the agent re-reads state, so a re-run reconciles a partial edit
 * without double-applying); a live child is killed by process group before the daemon stops.
 *
 * `createJam` is the loop with no timers or lock (a test drives `tick()` directly with an
 * injected adapter); `startJam` wraps it with the repo lock, dir-watch, and rescan interval.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { appendEvents, listBoards, readLog, replay, type CommentEvent } from '../comments.ts'
import type { JamConfig } from '../config.ts'
import { claudeAdapter } from './adapter/claude.ts'
import { acquireLock, baseline, releaseLock, write } from './journal.ts'
import { buildMember, buildPacket, goalText, threadId } from './packet.ts'
import { scanPending, allEventIds } from './watch.ts'
import type { Batch, JamAdapter, Journal, Pending } from './types.ts'

const LEASE_MS = 5 * 60_000
const JOB_TIMEOUT_MS = 5 * 60_000
const MAX_ATTEMPTS = 2
const MAX_OUT = 2_000_000
const RESCAN_MS = 5_000

export interface JamDaemon { stop(): void }
export interface JamCore { tick(): Promise<void>; stop(): void; snapshot(): Journal }

/** The loop, without timers/watch/lock. Baselines on creation, then each `tick()` resumes any
 *  leftover batches (fence + re-run) and claims new owner-ledgered mentions. */
export function createJam(root: string, cfg: JamConfig, adapter: JamAdapter, log: (m: string) => void = () => {}): JamCore {
  const commentsDir = join(root, 'design', 'comments')
  let journal: Journal = baseline(root, allEventIds(commentsDir))
  const persist = () => write(root, (journal = { ...journal }))

  let running = false
  let stopped = false
  let activeChild: ChildProcess | null = null

  const fence = (c: ChildProcess | null) => { try { if (c?.pid) process.kill(-c.pid, 'SIGKILL') } catch { /* already gone */ } }

  const runAgent = (goal: string): Promise<{ reply: string; model?: string; ok: boolean }> =>
    new Promise((resolve) => {
      const { cmd, args } = adapter.spawnArgs(goal)
      let child: ChildProcess
      try { child = spawn(cmd, args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
      catch { return resolve({ reply: '', ok: false }) }
      activeChild = child
      let out = ''
      const to = setTimeout(() => fence(child), JOB_TIMEOUT_MS)
      child.stdout?.on('data', (d: Buffer) => { out += d; if (out.length > MAX_OUT) out = out.slice(-MAX_OUT) })
      child.on('close', (code) => { clearTimeout(to); if (activeChild === child) activeChild = null; resolve(adapter.parse(out, code ?? 1)) })
      child.on('error', () => { clearTimeout(to); if (activeChild === child) activeChild = null; resolve({ reply: '', ok: false }) })
    })

  const writeReply = (p: Pending, body: string, model?: string) => {
    const me = localProfile(root)
    const reply: CommentEvent = {
      id: randomUUID(), ts: Date.now(), type: 'reply',
      commentId: randomUUID(), parentId: threadId(p.event),
      board: p.board, author: me, body,
      agent: true, agentMeta: { devUser: me.name, harness: adapter.name, model },
    }
    appendEvents(commentsDir, p.board, [reply])
  }

  const finish = (b: Batch) => { journal.batches = journal.batches.filter((x) => x.batchId !== b.batchId); persist() }

  const eventById = (id: string): Pending | null => {
    for (const board of listBoards(commentsDir)) for (const ev of readLog(commentsDir, board)) if (ev.id === id) return { board, event: ev }
    return null
  }

  const runBatch = async (b: Batch, members: Pending[]) => {
    b.attempts += 1; b.state = 'claimed'; b.leaseUntil = Date.now() + LEASE_MS; persist()
    const p = members[0]   // M1: single member
    const threads = replay(readLog(commentsDir, p.board))
    const packet = buildPacket(b.batchId, [buildMember(p, threads)])
    const run = await runAgent(goalText(packet))
    if (stopped) return
    if (run.ok) {
      writeReply(p, run.reply, run.model)
      finish(b)
      log(`  jam: replied on ${p.board}${run.model ? ` (${run.model})` : ''}`)
    } else if (b.attempts >= MAX_ATTEMPTS) {
      writeReply(p, "I couldn't finish that one. Try rephrasing, or check the dev logs.", run.model)
      finish(b)
      log(`  jam: gave up on ${p.board} after ${b.attempts} attempts`)
    } else {
      b.state = 'pending'; persist()   // retry on the next tick
    }
  }

  const claim = (p: Pending): Batch => {
    const b: Batch = { batchId: randomUUID(), memberEventIds: [p.event.id], state: 'claimed', leaseUntil: 0, attempts: 0 }
    journal.seen = [...journal.seen, p.event.id]
    journal.batches = [...journal.batches, b]
    persist()
    return b
  }

  const tick = async () => {
    if (running || stopped) return
    running = true
    try {
      // 1. resume batches a dead process left behind (fence + goal-phrased re-run, §3.2)
      for (const b of [...journal.batches]) {
        if (stopped) break
        if (b.state !== 'claimed' && b.state !== 'pending') continue
        const members = b.memberEventIds.map(eventById).filter((x): x is Pending => x != null)
        if (members.length) await runBatch(b, members)
        else finish(b)
      }
      // 2. claim new owner-ledgered mentions
      if (!stopped) for (const p of scanPending(root, commentsDir, journal)) {
        if (stopped) break
        await runBatch(claim(p), [p])
      }
    } catch (err) {
      log(`  jam: tick error - ${(err as Error).message}`)
    } finally { running = false }
  }

  return {
    tick,
    stop() { stopped = true; fence(activeChild) },
    snapshot() { return journal },
  }
}

/** Start the daemon inside the dev server. Returns null when the adapter is unknown or another
 *  dev server already holds the repo lock (that one runs the loop; this one watches without it). */
export function startJam(root: string, cfg: JamConfig, log: (m: string) => void = () => {}): JamDaemon | null {
  const adapter: JamAdapter | null = cfg.agent === 'claude' ? claudeAdapter : null
  if (!adapter) return null   // codex adapter lands in M5
  if (!acquireLock(root)) { log('  jam: another marver dev holds the repo lock; this server watches without the daemon'); return null }

  const commentsDir = join(root, 'design', 'comments')
  const core = createJam(root, cfg, adapter, log)
  let stopped = false
  let scheduled: ReturnType<typeof setTimeout> | null = null
  const schedule = () => { if (!scheduled && !stopped) scheduled = setTimeout(() => { scheduled = null; void core.tick() }, 150) }

  let watcher: FSWatcher | null = null
  try { watcher = fsWatch(commentsDir, { persistent: false }, schedule) } catch { /* dir appears later; rescan catches it */ }
  const interval = setInterval(() => void core.tick(), RESCAN_MS)
  interval.unref?.()
  void core.tick()

  log(`  jam: watching for @marver (${adapter.name})`)
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
