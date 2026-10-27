/**
 * Session runs (spec 29b, Parts 4 and 7): who runs a batch - the owner's own session, a copy of it, or
 * a fresh agent - and the life of a run handed to a session: offered, claimed, completing, released or
 * withdrawn, stalled, stopping.
 *
 * The daemon keeps everything else of a batch's life (packet, glow, pictures, results first, delivery);
 * a session run only replaces the middle - where a spawned agent ran, the session takes the run with
 * `marver jam next` and hands it back with `marver jam done`. Its state lives on the batch in the
 * journal (`runner`, `offer`, `claim`, `gen`, `early`), and every request that changes it leaves a
 * receipt written with the change - so a restart of `marver dev` keeps it, and a request sent again
 * gets the answer it got the first time.
 */
import type { JamConfig } from '../config.ts'
import { alive, closeConn, eligible, gone, listConns, readConn, readOffers, readPrefs, upsertConn, writeOffers, type Conn, type ConnAgent } from './conn.ts'
import { forkable, newestOf, transcriptOf, type ForkAgent } from './fork.ts'
import { parseAgentText } from './packet.ts'
import type { Queue } from './queue.ts'
import { answer, sweep, takeRequests, verify, type Req } from './transport.ts'
import type { Batch, Card } from './types.ts'

/** An offer Claude Code has not pulled in this long goes to a copy or a fresh agent. */
export const OFFER_MS = 2 * 60_000
/** Codex and Cursor pull at the end of a turn: an offer still open this long after the turn ended is withdrawn. */
export const IDLE_OFFER_MS = 30_000
/** A claimed run with no word from its session in this long is stalled - the owner decides. */
export const STALL_MS = 15 * 60_000
/** How long a request's answer is kept for the same request sent again. */
const RECEIPT_MS = 10 * 60_000
/** The longest final message a session hands back (its replies, not its work). */
export const DONE_MAX = 400_000

export type AgentRun = { reply: string; asks: boolean; model?: string; ok: boolean; reanchors: import('./types.ts').Reanchor[]; said?: string; raw?: string }

/** What this machine's Jam does now: design/config.ts, with the start sheet's switches over it. */
export interface Settings { runner: JamConfig['runner']; session: boolean; context: 'fork' | 'fresh'; mcp: boolean; skills: boolean; others: boolean; sessionMax: number }
export function settingsOf(root: string, cfg: JamConfig): Settings {
  const p = readPrefs(root)
  const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  return {
    runner: cfg.runner ?? 'auto', session: cfg.session !== false, sessionMax: cfg.sessionMax ?? 3,
    context: p.context === 'fork' || p.context === 'fresh' ? p.context : cfg.context ?? 'fork',
    mcp: b(p.mcp, cfg.mcp ?? true), skills: b(p.skills, cfg.skills ?? true), others: b(p.others, cfg.others ?? false),
  }
}

/** Who runs a batch. `wait`: `jam.runner: 'session'` with no session to take it yet. */
export type Choice =
  | { kind: 'session'; conn: Conn }
  | { kind: 'fork'; agent: ForkAgent; session: string }
  | { kind: 'fresh'; agent: string; why?: string }
  | { kind: 'wait' }

export const handleOf = (b: Batch, gen: number) => `r-${b.batchId.slice(0, 8)}.${gen}`
const HANDLE = /^r-([0-9a-f]{8})\.(\d+)$/

export interface RunsDeps {
  root: string
  cfg: JamConfig
  q: Queue
  log(m: string): void
  /** the queue changed: push it to pages */
  changed(): void
  /** the startup barrier is behind us: nothing is answered before it */
  ready(): boolean
  /** a Jam session runs - the only time a session takes work (spec 29b v2, 15) */
  jamOn(): boolean
  /** the run's prompt for a session that took it */
  goal(b: Batch, handle: string): string
  /** post a session's early line on a one-member run, with its journaled id (once: an id already in the log is not posted again) */
  say(b: Batch): boolean
  /** the agents this machine can spawn (on PATH) */
  canSpawn(agent: string): boolean
}

export interface Runs {
  settings(): Settings
  /** the session that takes the work now, if any */
  selected(now?: number): Conn | undefined
  /** `spawnOnly`: a session cannot take it (released, withdrawn) - a copy or a fresh agent */
  choose(b: Batch, now?: number, spawnOnly?: boolean): Choice
  /** Offer a batch to a session (none: wait for one) and wait: its `done` (a parsed run), or null - released,
   *  withdrawn or stopped: the daemon decides what next. A run already claimed (a restart) just waits; one
   *  already completed (a restart after `done`) answers at once. */
  run(b: Batch, conn?: Conn): Promise<AgentRun | null>
  /** The daemon finished a session run's delivery (`done` answers with it). */
  delivered(batchId: string, ok: boolean, note?: string): void
  /** timers: withdraw, stall, finish a stop, answer requests */
  tick(now?: number): Promise<void>
  /** a stalled or running session run's choices, from the lane or a thread: by batch and its claim's generation */
  act(batchId: string, gen: number, action: 'again' | 'background' | 'drop'): Promise<{ ok: boolean; error?: string }>
  view(now?: number): { sessions: { id: string; agent: ConnAgent; busy: boolean; selected: boolean; since: number; mode?: string }[] }
  /** a batch's runner, as the lane shows it */
  runnerOf(b: Batch | undefined): { kind: 'session' | 'fork' | 'fresh'; agent: string; state?: 'offered' | 'claimed' | 'stalled' | 'stopping' | 'waiting'; why?: string; batch: string; gen?: number } | undefined
  stop(): void
}

/** A session's final message, parsed as any agent's. */
const parsedRun = (text: string): AgentRun => { const p = parseAgentText(text); return { reply: p.reply, asks: p.asks, reanchors: p.reanchors, said: text, ok: !!p.reply } }

export function createRuns(d: RunsDeps): Runs {
  const { root, q } = d
  let stopped = false
  const waiters = new Map<string, (r: AgentRun | null) => void>()
  const deliveries = new Map<string, ((r: { ok: boolean; note?: string }) => void)[]>()
  const seenReqs = new Set<string>()
  /** each connection's offers as last written: a new batch among them grows its generation */
  const offered = new Map<string, Set<string>>()

  const settings = () => settingsOf(root, d.cfg)
  const live = (now = Date.now()) => listConns(root).filter((c) => eligible(c, now))
  const open = () => q.j.batches.filter((b) => b.state === 'claimed' && !b.results)
  /** runs a connection holds now: offered to it, or claimed by it and not stopping */
  const load = (id: string) => open().filter((b) => b.offer?.conn === id || (b.claim?.conn === id && !b.claim.stopping)).length

  const selected = (now = Date.now()): Conn | undefined => {
    const conns = live(now)
    const pick = readPrefs(root).pick
    return conns.find((c) => c.id === pick) ?? conns.sort((a, b) => b.since - a.since)[0]
  }
  /** Can it take an offer now? Claude Code always (its inbox wakes it); Codex and Cursor while a turn runs. */
  const offerable = (c: Conn) => c.agent === 'claude' || c.busy
  /** Does a session take work now? Sessions on, the owner's context allowed, and a Jam session running. */
  const sessionsOn = (s: Settings) => s.session && s.context === 'fork' && s.runner !== 'background' && d.jamOn()

  const choose = (b: Batch, now = Date.now(), spawnOnly = false): Choice => {
    const s = settings()
    const pick = s.session ? selected(now) : undefined
    if (!spawnOnly && sessionsOn(s)) {
      if (pick && offerable(pick) && load(pick.id) < s.sessionMax) return { kind: 'session', conn: pick }
      if (s.runner === 'session') return { kind: 'wait' }
    }
    if (!spawnOnly && s.runner === 'session' && s.session && s.context === 'fork') return { kind: 'wait' }
    // the agent of the session that would have taken it, else the one Jam is set to
    const agent = pick?.agent ?? d.cfg.agent
    if (s.context === 'fork' && (agent === 'claude' || agent === 'codex') && d.canSpawn(agent)) {
      const conns = listConns(root).filter((c) => c.agent === agent && alive(c, now)).sort((x, y) => y.since - x.since)
      const src = (pick?.agent === agent ? transcriptOf(root, agent, pick.session) : null)
        ?? conns.map((c) => transcriptOf(root, agent, c.session)).find((t) => !!t)
        ?? newestOf(root, agent)
      if (forkable(src)) return { kind: 'fork', agent, session: src.session }
      if (src) return { kind: 'fresh', agent, why: 'your session is too long to copy - a fresh agent took it' }
    }
    return { kind: 'fresh', agent: d.canSpawn(agent) ? agent : d.cfg.agent }
  }

  /** Write every connection's offers file: how many runs wait for it, the runs it must let go, and a new
   *  generation when either has something new. */
  const publish = () => {
    const by = new Map<string, string[]>()
    const stops = new Map<string, string[]>()
    for (const b of open()) {
      if (b.offer) by.set(b.offer.conn, [...(by.get(b.offer.conn) ?? []), b.batchId])
      if (b.claim?.stopping) stops.set(b.claim.conn, [...(stops.get(b.claim.conn) ?? []), handleOf(b, b.claim.gen)])
    }
    for (const id of new Set([...by.keys(), ...offered.keys(), ...stops.keys()])) {
      const now = new Set(by.get(id) ?? [])
      const was = offered.get(id) ?? new Set()
      const prev = readOffers(root, id)
      const stop = stops.get(id) ?? []
      const newOffer = [...now].some((x) => !was.has(x))
      const newStop = JSON.stringify(stop) !== JSON.stringify(prev?.stop ?? [])
      if (now.size) offered.set(id, now); else offered.delete(id)
      if (!newOffer && !newStop && prev?.n === now.size) continue
      // a generation never goes back, across restarts too: the listener posts once per generation it has not seen
      const gen = newOffer || (newStop && stop.length) ? Math.max((prev?.gen ?? 0) + 1, Date.now()) : prev?.gen ?? 0
      try { writeOffers(root, id, { n: now.size, gen, ...(stop.length ? { stop } : {}) }) } catch { /* its listener looks again */ }
    }
  }

  const settle = (b: Batch, r: AgentRun | null) => { const w = waiters.get(b.batchId); if (w) { waiters.delete(b.batchId); w(r) } }

  const run = (b: Batch, conn?: Conn): Promise<AgentRun | null> => new Promise((resolve) => {
    // completed before a restart: its final message is on the batch
    if (b.claim?.result !== undefined) return resolve(parsedRun(b.claim.result))
    waiters.set(b.batchId, resolve)
    void q.lock(() => {
      if (!b.claim && !b.offer) {
        b.runner = { kind: 'session', agent: conn?.agent ?? '' }
        if (conn) { b.runner.conn = conn.id; b.offer = { conn: conn.id, at: Date.now() } }
      }
      q.persist()
    }).then(() => { publish(); d.changed() }, () => settle(b, null))
  })

  /** Take an offer back (not pulled in time, its session gone, Jam ended): the daemon runs the batch another way. */
  const withdraw = async (b: Batch, why: string) => {
    const did = await q.lock(() => { if (!b.offer) return false; delete b.offer; b.runner = undefined; q.persist(); return true })
    if (!did) return
    d.log(`  jam: a run offered to your session went another way (${why})`)
    publish(); settle(b, null); d.changed()
  }

  /** A stop the owner chose is confirmed (released, or its writer gone): the run goes on as they chose. */
  const finishStop = async (b: Batch) => {
    const how = await q.lock(() => {
      const c = b.claim
      if (!c?.stopping) return null
      b.gen = Math.max(b.gen ?? 0, c.gen); delete b.claim; b.runner = undefined
      if (c.stopping === 'drop') b.dropped = true
      q.persist()
      return c.stopping
    })
    if (!how) return
    publish(); settle(b, null); d.changed()
  }

  // ---- the session's commands --------------------------------------------------------------------------

  const findClaim = (conn: Conn, handle: unknown): { b: Batch; gen: number } | string => {
    const m = typeof handle === 'string' ? HANDLE.exec(handle) : null
    if (!m) return 'that is not a run handle (r-xxxxxxxx.N)'
    const gen = Number(m[2])
    const b = open().find((x) => x.batchId.startsWith(m[1]))
    if (!b) return 'that run is over'
    if (!b.claim || b.claim.conn !== conn.id) return 'that run is not yours - it went to another runner'
    if (b.claim.gen !== gen) return 'that handle is old - the run was taken again since'
    return { b, gen }
  }

  /** A change and its receipt, in one journal write. */
  const receipt = (req: Req, out: Record<string, unknown>) => { (q.j.receipts ??= {})[req.id] = { at: Date.now(), out } }

  const ops = async (req: Req, conn: Conn): Promise<Record<string, unknown>> => {
    const now = Date.now()
    if (req.op === 'release') {
      const found = findClaim(conn, req.args.handle)
      if (typeof found === 'string') return { ok: false, error: found }
      const { b } = found
      if (b.claim!.result !== undefined) return { ok: false, error: 'it is already handed back' }
      const out = { ok: true, text: b.claim!.stopping ? 'Released - the owner\'s choice goes ahead.' : 'Released - another runner takes it.' }
      const stopping = !!b.claim!.stopping
      if (stopping) { await finishStop(b); await q.lock(() => { receipt(req, out); q.persist() }); return out }
      await q.lock(() => { b.gen = Math.max(b.gen ?? 0, b.claim!.gen); delete b.claim; b.runner = undefined; receipt(req, out); q.persist() })
      publish(); settle(b, null); d.changed()
      return out
    }
    if (!eligible(conn, now)) return { ok: false, error: conn.muted ? 'this session is muted for Jam until it ends' : 'this session cannot take Jam work now' }
    if (req.op === 'mute') {
      upsertConn(root, conn.agent, conn.session, { muted: true })
      for (const b of open().filter((x) => x.offer?.conn === conn.id)) await withdraw(b, 'muted')
      return { ok: true, text: 'Muted: this session takes no Jam work until it ends.' }
    }
    if (req.op === 'status') {
      const mine = open().filter((b) => b.offer?.conn === conn.id || b.claim?.conn === conn.id)
      const line = (b: Batch) => b.offer ? `offered: run ${b.batchId.slice(0, 8)} (${b.frames.join(', ')}) - take it with \`npx marver jam next\`` : `${b.claim!.stopping ? 'stopping - release it' : b.claim!.result !== undefined ? 'handed back' : b.claim!.stalled ? 'stalled' : 'yours'}: ${handleOf(b, b.claim!.gen)} (${b.frames.join(', ')})`
      return { ok: true, text: [`Connected: ${conn.agent} session ${conn.id}${selected(now)?.id === conn.id ? ' - it takes the work' : ''}${d.jamOn() ? '' : ' (no Jam session runs on the canvas now)'}.`, ...(mine.length ? mine.map(line) : ['No runs for it now.'])].join('\n') }
    }
    if (req.op === 'next') {
      const b0 = open().filter((b) => b.offer?.conn === conn.id).sort((a, b) => a.offer!.at - b.offer!.at)[0]
      if (!b0) return { ok: true, text: 'Nothing waits for this session now.' }
      const out = await q.lock(() => {
        if (b0.offer?.conn !== conn.id || b0.results) return null
        const gen = Math.max(b0.gen ?? 0, b0.claim?.gen ?? 0) + 1
        delete b0.offer
        b0.gen = gen
        b0.runner = { kind: 'session', agent: conn.agent, conn: conn.id }
        b0.claim = { conn: conn.id, gen, at: Date.now(), progress: Date.now() }
        const handle = handleOf(b0, gen)
        const o = { ok: true, handle, frames: b0.frames, text: [`Run ${handle} - frames ${b0.frames.join(', ') || '(the whole canvas)'}.`, '', d.goal(b0, handle)].join('\n') }
        receipt(req, o)
        q.persist()
        return o
      })
      if (!out) return { ok: true, text: 'That run went to another runner - nothing waits for this session now.' }
      publish(); d.changed()
      return out
    }
    const found = findClaim(conn, req.args.handle)
    if (typeof found === 'string') return { ok: false, error: found }
    const { b } = found
    if (b.claim!.stopping) return { ok: false, error: `the owner moved this run elsewhere - stop working on it and run \`npx marver jam release ${handleOf(b, b.claim!.gen)}\`` }
    if (b.claim!.result !== undefined) return { ok: false, error: 'it is already handed back' }
    if (req.op === 'progress') {
      await q.lock(() => { b.claim!.progress = Date.now(); delete b.claim!.stalled; q.persist() })
      d.changed()
      return { ok: true, text: 'Noted - still yours.' }
    }
    if (req.op === 'say') {
      const text = String(req.args.text ?? '').trim().slice(0, 2_000)
      if (!text) return { ok: false, error: 'say what' }
      if (b.members.length !== 1) return { ok: false, error: 'a run of several asks posts no early line - its replies come with done' }
      if (b.early) return { ok: false, error: 'its early line is already posted' }
      const out = { ok: true, text: 'Posted.' }
      // journaled first, posted after with the id it names: a restart in between posts it then, never twice
      await q.lock(() => {
        b.early = { body: text, asks: false, commentId: `jam-c-e${b.attempts}-${b.batchId}`, ts: Date.now() }
        b.claim!.progress = Date.now(); delete b.claim!.stalled
        receipt(req, out); q.persist()
      })
      if (!d.say(b)) return { ok: false, error: 'it could not be posted now - it will be, before the run is delivered' }
      d.changed()
      return out
    }
    // done: the completion boundary - checked and stored under the lock, so a stop after it is refused, a second
    // done too, and a restart delivers it from here; then the daemon delivers, and this answers with how it went
    const text = String(req.args.text ?? '').slice(0, DONE_MAX)
    if (!parsedRun(text).reply) return { ok: false, error: 'the final message is empty - write the marver-reply blocks to the file' }
    const posted = new Promise<{ ok: boolean; note?: string }>((res) => {
      deliveries.set(b.batchId, [...(deliveries.get(b.batchId) ?? []), res])
      setTimeout(() => res({ ok: true, note: 'it is being posted' }), 100_000).unref?.()
    })
    const took = await q.lock(() => {
      if (!b.claim || b.claim.gen !== found.gen || b.claim.stopping || b.claim.result !== undefined) return false
      b.claim.result = text; b.claim.progress = Date.now(); delete b.claim.stalled
      receipt(req, { ok: true, text: 'Delivered - the frames are free.' })
      q.persist()
      return true
    })
    if (!took) return { ok: false, error: 'the run changed meanwhile - run `npx marver jam status`' }
    settle(b, parsedRun(text))
    d.changed()
    const r = await posted
    return r.ok ? { ok: true, text: `Delivered${r.note ? ` (${r.note})` : ''} - the frames are free.` } : { ok: false, error: `it could not be delivered: ${r.note ?? 'unknown'}` }
  }

  const answerAll = async () => {
    for (const { raw } of takeRequests(root)) {
      const id = (raw as { id?: unknown } | null)?.id
      // the same request again (its answer lost, a restart between): the answer it got
      const kept = typeof id === 'string' ? q.j.receipts?.[id] : undefined
      const v = verify(root, raw, kept ? new Set() : seenReqs)
      if (!v.ok) { if (v.id) answer(root, v.id, { ok: false, error: v.error }); continue }
      if (kept) { answer(root, v.req.id, kept.out); continue }
      let out: Record<string, unknown>
      try { out = await ops(v.req, v.conn) } catch (err) { out = { ok: false, error: (err as Error).message } }
      try { if (alive(v.conn)) upsertConn(root, v.conn.agent, v.conn.session, {}) } catch { /* it answered; seen is a nicety */ }
      answer(root, v.req.id, out)
    }
    if (seenReqs.size > 5_000) seenReqs.clear()   // every one older than a minute is refused by age anyway
  }

  let lastSweep = 0
  const tick = async (now = Date.now()) => {
    if (stopped || !d.ready()) return
    await answerAll()
    const s = settings()
    for (const b of open()) {
      if (b.offer) {
        const c = readConn(root, b.offer.conn)
        if (!c || !eligible(c, now) || !sessionsOn(s)) { await withdraw(b, !c || gone(c) ? 'it ended' : !d.jamOn() ? 'the Jam session ended' : 'it cannot take work now'); continue }
        if (s.runner === 'session') continue   // wait for it, however long
        if (c.agent === 'claude' ? now - b.offer.at > OFFER_MS : !c.busy && now - Math.max(b.offer.at, c.seen) > IDLE_OFFER_MS) await withdraw(b, c.agent === 'claude' ? 'not taken in 2 minutes' : 'its turn ended without taking it')
      } else if (b.claim) {
        if (b.claim.result !== undefined) continue   // handed back: the daemon delivers it
        const c = readConn(root, b.claim.conn)
        if (b.claim.stopping) { if (gone(c)) await finishStop(b); continue }
        if (!b.claim.stalled && (gone(c) || (c && !alive(c, now)) || now - b.claim.progress > STALL_MS)) {
          await q.lock(() => { if (b.claim) b.claim.stalled = true; q.persist() })
          d.log(`  jam: a run your session took went quiet (${gone(c) ? 'the session ended' : 'no word for 15 minutes'}) - choose in the lane`)
          d.changed()
        }
      } else if (b.runner?.kind === 'session' && waiters.has(b.batchId)) {
        // waiting for a session (`jam.runner: 'session'`, or one released): offer it the moment there is one
        const c = sessionsOn(s) ? selected(now) : undefined
        if (c && offerable(c) && load(c.id) < s.sessionMax) {
          await q.lock(() => { b.runner = { kind: 'session', agent: c.agent, conn: c.id }; b.offer = { conn: c.id, at: Date.now() }; q.persist() })
          d.changed()
        }
      }
    }
    publish()
    if (now - lastSweep > 60_000) {
      lastSweep = now
      sweep(root, now)
      // receipts kept as long as a request can come again; connections gone and holding nothing, removed
      const old = Object.entries(q.j.receipts ?? {}).filter(([, r]) => now - r.at > RECEIPT_MS)
      if (old.length) await q.lock(() => { for (const [k] of old) delete q.j.receipts![k]; q.persist() })
      const held = new Set(open().flatMap((b) => [b.offer?.conn, b.claim?.conn]).filter(Boolean))
      for (const c of listConns(root)) if (!held.has(c.id) && (c.ended || !alive(c, now)) && now - c.seen > 60_000) closeConn(root, c.id)
    }
  }

  return {
    settings, selected, choose, run, tick,
    delivered(batchId, ok, note) { const rs = deliveries.get(batchId); if (rs) { deliveries.delete(batchId); for (const r of rs) r({ ok, note }) } },
    async act(batchId, gen, action) {
      const b = open().find((x) => x.batchId === batchId)
      if (!b?.claim || b.claim.gen !== gen) return { ok: false, error: 'the run changed - look again' }
      if (b.claim.result !== undefined) return { ok: false, error: 'it just finished - its reply is being posted' }
      if (action === 'again') {
        // the same claim and handle: the session keeps going (a new claim would need the old writer stopped)
        await q.lock(() => { if (b.claim) { b.claim.progress = Date.now(); delete b.claim.stalled; delete b.claim.stopping }; q.persist() })
        publish(); d.changed()
        return { ok: true }
      }
      // background or drop: the session must let go first - its `done` is refused from now, it is told to stop,
      // and the frames stay reserved until it releases the run or its writer is proven gone
      await q.lock(() => { if (b.claim) { b.claim.stopping = action; delete b.claim.stalled }; q.persist() })
      if (gone(readConn(root, b.claim.conn))) await finishStop(b)
      else { publish(); d.changed() }
      return { ok: true }
    },
    view(now = Date.now()) {
      const sel = selected(now)
      return { sessions: live(now).map((c) => ({ id: c.id, agent: c.agent, busy: c.busy, selected: c.id === sel?.id, since: c.since, ...(c.mode ? { mode: c.mode } : {}) })) }
    },
    runnerOf(b) {
      if (!b?.runner) return undefined
      const state = b.offer ? 'offered' as const : b.claim?.stopping ? 'stopping' as const : b.claim?.stalled ? 'stalled' as const : b.claim ? 'claimed' as const : b.runner.kind === 'session' ? 'waiting' as const : undefined
      return { kind: b.runner.kind, agent: b.runner.agent, batch: b.batchId, ...(b.claim ? { gen: b.claim.gen } : {}), ...(state ? { state } : {}), ...(b.runner.why ? { why: b.runner.why } : {}) }
    },
    stop() { stopped = true; for (const w of waiters.values()) w(null); waiters.clear() },
  }
}
