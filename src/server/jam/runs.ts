/**
 * Session runs (spec 29b, Parts 4 and 7): who runs a batch - the owner's own session, a copy of it, or
 * a fresh agent - and the life of a run handed to a session: offered, claimed, completing, released or
 * withdrawn, stalled, stopping.
 *
 * The daemon keeps everything else of a batch's life (packet, glow, pictures, results first, delivery);
 * a session run only replaces the middle - where a spawned agent ran, the session takes the run with
 * `marver jam next` and hands it back with `marver jam done`. Its state lives on the batch in the
 * journal (`runner`, `offer`, `claim`, `gen`, `early`, `handoff`), and every request that changes it
 * leaves a receipt written in the same journal write - so a restart of `marver dev` keeps it, and a
 * request sent again gets the answer it got (or, for one still being posted, where it stands now).
 *
 * Every transition looks the batch up and checks it again under the queue's lock: a check made before
 * the lock is a guess.
 */
import { requestWords } from './capture.ts'
import type { JamConfig } from '../config.ts'
import { alive, closeConn, eligible, listConns, patchConn, pidAlive, pingLine, readConn, readOffers, readPrefs, upsertConn, writeOffers, type Conn, type ConnAgent, type Offers } from './conn.ts'
import { forkable, newestAny, transcriptOf, type ForkAgent } from './fork.ts'
import { parseAgentText, sanitize } from './packet.ts'
import type { Queue } from './queue.ts'
import { answer, sweep, takeRequests, verify, type Req } from './transport.ts'
import type { Batch } from './types.ts'

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

/** Runs one session holds at once (F3). Claude Code dispatches each run to a background subagent of its own, so it can
 *  hold several at once: 8. Marver gives Codex and Cursor runs one after another in their own thread: 3 (as before).
 *  `jam.sessionMax` caps every session. */
export const sessionMaxFor = (cfg: Pick<JamConfig, 'sessionMax'>, agent: ConnAgent): number => cfg.sessionMax ?? (agent === 'claude' ? 8 : 3)

/** What this machine's Jam does now: design/config.ts, with the start sheet's switches over it. `sessionMax`: the
 *  selected session's own limit (the config's when set). */
export interface Settings { runner: JamConfig['runner']; session: boolean; context: 'fork' | 'fresh'; mcp: boolean; skills: boolean; others: boolean; sessionMax: number }
export function settingsOf(root: string, cfg: JamConfig, agent?: ConnAgent): Settings {
  const p = readPrefs(root)
  const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  return {
    runner: cfg.runner ?? 'auto', session: cfg.session !== false, sessionMax: agent ? sessionMaxFor(cfg, agent) : cfg.sessionMax ?? 3,
    context: p.context === 'fork' || p.context === 'fresh' ? p.context : cfg.context ?? 'fork',
    mcp: b(p.mcp, cfg.mcp ?? true), skills: b(p.skills, cfg.skills ?? true), others: b(p.others, cfg.others ?? false),
  }
}

/** Who runs a batch. `wait`: `jam.runner: 'session'` with no session to take it yet. */
export type Choice =
  | { kind: 'session'; conn: Conn }
  | { kind: 'fork'; agent: ForkAgent; session: string; why?: string }
  | { kind: 'fresh'; agent: string; why?: string }
  | { kind: 'wait' }

export const handleOf = (b: Batch, gen: number) => `r-${b.batchId.slice(0, 8)}.${gen}`
/** A session command as that session must type it - Cursor's names its connection (it has no session id in its shell). */
const cmdFor = (conn: Conn | null | undefined, op: string, handle?: string) => `\`npx marver jam ${op}${handle ? ` ${handle}` : ''}${conn?.agent === 'cursor' ? ` --as ${conn.id}` : ''}\``
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
  /** the run's prompt (its brief) for the session connection that took it */
  goal(b: Batch, handle: string, conn: Conn): string
  /** post a session's early line on a one-member run, with its journaled id (once: an id already in the log is not posted again) */
  say(b: Batch): boolean
  /** the agents this machine can spawn (on PATH) */
  canSpawn(agent: string): boolean
  /** Give a frame to a run its session holds (`boards place --run`, F4): why not, or null once it is the run's - called
   *  under the lock. Another runner's frame, or one your agent in chat holds, is refused. */
  own(b: Batch, frame: string): string | null
  /** May this session incarnation hold `b` (F4)? Every other open run on one of its frames is held by it too (offered,
   *  taken and not stopping, or formed for it) - else it is someone else's frame now. Called under the lock. */
  mayHold(b: Batch, conn: Conn): boolean
}

export interface Runs {
  settings(): Settings
  /** Runs the session that takes the work now can still take (its limit less what it holds); 0 when none can (F3: they
   *  count against its own limit, not jam.concurrency) */
  room(now?: number): number
  /** that session, while it has room - the one a request on a frame its own runs hold may be offered to (F4) */
  taker(now?: number): Conn | undefined
  /** that session, full or not, and its room (F5: a request with no frame runs beside the others while one takes the work);
   *  `record`: the one a session's record goes to, though the Jam session it closes has ended */
  takes(now?: number, record?: boolean): { conn: Conn; room: number } | undefined
  /** the session that takes the work now, if any */
  selected(now?: number): Conn | undefined
  /** `spawnOnly`: a session cannot take it (released, withdrawn, the owner's choice) - a copy or a fresh agent */
  choose(b: Batch, now?: number, spawnOnly?: boolean): Choice
  /** Offer a batch to a session (none: wait for one) and wait: its `done` (a parsed run), or null - released,
   *  withdrawn or stopped: the batch says what next (`handoff`, `dropped`). A run already claimed (a restart) just
   *  waits; one already completed (a restart after `done`) answers at once. */
  run(b: Batch, conn?: Conn): Promise<AgentRun | null>
  /** The daemon finished a session run's delivery (`done` answers with it). */
  delivered(batchId: string, ok: boolean, note?: string): void
  /** timers: withdraw, stall, finish a stop, answer requests */
  tick(now?: number): Promise<void>
  /** a stalled or running session run's choices, from the lane or a thread: by batch and its claim's generation */
  act(batchId: string, gen: number, action: 'again' | 'background' | 'drop'): Promise<{ ok: boolean; error?: string }>
  view(now?: number): { sessions: { id: string; agent: ConnAgent; busy: boolean; selected: boolean; since: number; mode?: string }[] }
  /** what a run is called (its first card's name, else the owner's words, clipped) - a ping, a tile waiting on it */
  title(b: Batch): string
  /** a batch's runner, as the lane shows it */
  runnerOf(b: Batch | undefined): { kind: 'session' | 'fork' | 'fresh'; agent: string; state?: 'offered' | 'claimed' | 'stalled' | 'stopping' | 'waiting'; why?: string; batch: string; gen?: number } | undefined
  stop(): void
}

/** A session's final message, parsed as any agent's. */
export const parsedRun = (text: string): AgentRun => { const p = parseAgentText(text); return { reply: p.reply, asks: p.asks, reanchors: p.reanchors, said: text, ok: !!p.reply } }

type Out = Record<string, unknown>

export function createRuns(d: RunsDeps): Runs {
  const { root, q } = d
  let stopped = false
  const waiters = new Map<string, (r: AgentRun | null) => void>()
  /** a `done` waits for its delivery: by batch, the answers to write when it is posted */
  const deliveries = new Map<string, ((r: { ok: boolean; note?: string }) => void)[]>()
  /** how a batch's delivery went, for a `done` sent again */
  const outcome = new Map<string, { ok: boolean; note?: string }>()
  const seenReqs = new Set<string>()
  /** each connection's offers as last written: a new batch among them grows its generation */
  const offered = new Map<string, Set<string>>()
  /** connections whose offers file last said a stop or a carry-on: looked at again until it says none */
  const worded = new Set<string>()
  /** connections whose offers this daemon has written since it started */
  const published = new Set<string>()

  const settings = () => settingsOf(root, d.cfg)
  const maxOf = (c: Conn) => sessionMaxFor(d.cfg, c.agent)
  /** may this session take Jam work now: alive, not muted or in plan mode, and its tool's connector not turned off */
  const usable = (c: Conn | null | undefined, now = Date.now()): boolean => !!c && eligible(c, now) && !readPrefs(root).off?.[c.agent]
  const live = (now = Date.now()) => listConns(root).filter((c) => usable(c, now))
  const open = () => q.j.batches.filter((b) => b.state === 'claimed' && !b.results)
  const byId = (id: string) => open().find((b) => b.batchId === id)
  /** a run formed beside this connection's runs (F4) and not offered yet: its slot is kept for it from the moment it is formed */
  const kept = (b: Batch, id: string) => b.share?.conn === id && !b.offer && !b.claim && !b.handoff
  /** runs a connection holds now: offered to it, claimed by it and not stopping, or kept for it */
  const load = (id: string) => open().filter((b) => b.offer?.conn === id || (b.claim?.conn === id && !b.claim.stopping) || kept(b, id)).length

  const selected = (now = Date.now()): Conn | undefined => {
    const conns = live(now)
    const pick = readPrefs(root).pick
    return conns.find((c) => c.id === pick) ?? conns.sort((a, b) => b.since - a.since)[0]
  }
  /** Can it take an offer now? Claude Code always (its inbox wakes it); Codex and Cursor while a turn runs. */
  const offerable = (c: Conn) => c.agent === 'claude' || c.busy
  /** Is it the record of a Jam session (a wrap-up)? Offered to your session though the session it records has ended. */
  const recordRun = (b: Batch) => b.members.some((m) => q.j.cards.find((c) => c.id === m.card)?.kind === 'wrapup')
  /** Does a session take work now - this run, when one is named (`record`: a session's record)? Sessions on, the owner's
   *  context allowed, not background-only, and a Jam session running (or, for a session's own record, just ended: never
   *  any other run). */
  const sessionsOn = (s: Settings, b?: Batch | 'record') => s.session && s.context === 'fork' && s.runner !== 'background' && (d.jamOn() || b === 'record' || (!!b && recordRun(b)))
  /** Is the writer of a claim proven gone? Its process is (Claude Code, Codex), or - Cursor - that very incarnation
   *  said it ended. A connection file missing, or silence, is "unknown", never "gone". */
  const writerGone = (claim: NonNullable<Batch['claim']>): boolean => {
    if (claim.pid) return !pidAlive(claim.pid)
    const c = readConn(root, claim.conn)
    return !!c && c.inc === claim.inc && !!c.ended
  }

  const choose = (b: Batch, now = Date.now(), spawnOnly = false): Choice => {
    const s = settings()
    // your session would have taken it and did not: the copy says why (A8)
    let skipped: string | undefined
    // formed beside runs of one session incarnation (F4): that one runs it while it takes the work (its slot kept, whatever
    // its room). Once it does not (you chose another session, it restarted, Codex or Cursor sat idle) it is routed as any
    // request is, below - never spawned just for that (Codex's review: under session-only the stale share skipped the
    // wait and spawned it): an offer to another session is made only when it may hold it beside the runs on its frames
    // (run(), next and the tick check mayHold, else it goes back to the queue), and a spawn that would run beside
    // another runner goes back to the queue (the daemon)
    if (!spawnOnly && !b.handoff && b.share) {
      const pick = sessionsOn(s, b) ? selected(now) : undefined
      if (pick && pick.id === b.share.conn && pick.inc === b.share.inc && offerable(pick)) return { kind: 'session', conn: pick }
    }
    if (!spawnOnly && !b.handoff) {
      const pick = sessionsOn(s, b) ? selected(now) : undefined
      if (pick && offerable(pick) && load(pick.id) < maxOf(pick)) return { kind: 'session', conn: pick }
      // session-only waits for one, as long as sessions can take work at all
      if (s.runner === 'session' && s.session && s.context === 'fork') return { kind: 'wait' }
      if (pick) skipped = offerable(pick) ? `your session didn't take it - it already holds ${load(pick.id)} run${load(pick.id) === 1 ? '' : 's'}` : `your session was idle - ${pick.agent === 'codex' ? 'Codex' : 'Cursor'} takes a run only while it works`
    }
    // the agent of the session that would have taken it, else the one Jam is set to
    const pick = s.session ? selected(now) : undefined
    const agent = pick?.agent ?? d.cfg.agent
    if (s.context === 'fork') {
      const can = (a: ForkAgent) => d.canSpawn(a)
      // the selected session first, then the newest connected one, then the newest of either tool on disk
      const conns = listConns(root).filter((c) => (c.agent === 'claude' || c.agent === 'codex') && alive(c, now) && can(c.agent)).sort((x, y) => y.since - x.since)
      const src = (pick && (pick.agent === 'claude' || pick.agent === 'codex') && can(pick.agent) ? transcriptOf(root, pick.agent, pick.session) : null)
        ?? conns.map((c) => transcriptOf(root, c.agent as ForkAgent, c.session)).find((t) => !!t)
        ?? newestAny(root, can)
      if (src && forkable(src)) return { kind: 'fork', agent: src.agent, session: src.session, ...(skipped ? { why: skipped } : {}) }
      if (src) return { kind: 'fresh', agent: src.agent, why: 'your session is too long to copy - a fresh agent took it' }
    }
    return { kind: 'fresh', agent: d.canSpawn(agent) ? agent : d.cfg.agent, ...(skipped ? { why: skipped } : {}) }
  }

  /** What a run is called in a ping: its card's name, else the owner's words (a capture's first words - its name comes later), clipped. */
  const titleOf = (b: Batch): string => {
    const c = q.j.cards.find((x) => x.id === b.members[0]?.card)
    // a capture's words and the notes added in its read-back
    const words = c?.name ?? c?.autoName ?? b.members[0]?.brief?.asks?.[0]?.body ?? (b.members[0]?.brief?.capture ? requestWords(b.members[0].brief.capture, ' ') || undefined : undefined) ?? (c?.kind === 'wrapup' ? 'Session record' : 'a request')
    // as the brief cleans words: no escape or control character reaches the session's inbox
    const t = sanitize(String(words), 400).replace(/@marver\b/gi, '').replace(/\s+/g, ' ').trim() || 'a request'
    const cps = [...t]
    return cps.length > 60 ? `${cps.slice(0, 59).join('')}…` : t
  }
  /** Write every connection's offers file: how many runs wait for it, the runs it must let go or carry on with, a new
   *  generation when any of that is new - and the words its listener posts for it. */
  const publish = () => {
    const by = new Map<string, string[]>()
    const stops = new Map<string, string[]>()
    const resumes = new Map<string, string[]>()
    for (const b of open()) {
      if (b.offer) by.set(b.offer.conn, [...(by.get(b.offer.conn) ?? []), b.batchId])
      if (b.claim?.stopping) stops.set(b.claim.conn, [...(stops.get(b.claim.conn) ?? []), handleOf(b, b.claim.gen)])
      if (b.claim?.resumed) resumes.set(b.claim.conn, [...(resumes.get(b.claim.conn) ?? []), handleOf(b, b.claim.gen)])
    }
    for (const id of new Set([...by.keys(), ...offered.keys(), ...stops.keys(), ...resumes.keys(), ...worded])) {
      const now = new Set(by.get(id) ?? [])
      const prev = readOffers(root, id)
      // the newest offer named: the batch offered last
      const newest = open().filter((b) => b.offer?.conn === id).sort((x, y) => (y.offer!.at - x.offer!.at))[0]
      // (and the run of yours it overlaps, F4: its handle once taken, else its short id)
      const over = newest?.overlaps?.map((x) => open().find((y) => y.batchId === x)).find((y) => !!y)
      const latest = newest ? { id: newest.batchId.slice(0, 8), title: titleOf(newest), ...(over ? { overlaps: over.claim ? handleOf(over, over.claim.gen) : over.batchId.slice(0, 8) } : {}) } : undefined
      // the first look after a restart: what its offers file already announced is not new - the session was told
      const was = offered.get(id) ?? (!published.has(id) && prev && prev.n === now.size && prev.latest?.id === latest?.id ? now : new Set<string>())
      published.add(id)
      const stop = stops.get(id) ?? []
      const resume = resumes.get(id) ?? []
      const newOffer = [...now].some((x) => !was.has(x))
      const newWord = JSON.stringify([stop, resume]) !== JSON.stringify([prev?.stop ?? [], prev?.resume ?? []])
      if (now.size) offered.set(id, now); else offered.delete(id)
      if (stop.length || resume.length) worded.add(id); else worded.delete(id)
      if (!newOffer && !newWord && prev?.n === now.size) continue
      // a generation never goes back, across restarts too: the listener posts once per generation it has not seen
      const gen = newOffer || (newWord && (stop.length || resume.length)) ? Math.max((prev?.gen ?? 0) + 1, Date.now()) : prev?.gen ?? 0
      const o: Offers = { n: now.size, gen, ...(stop.length ? { stop } : {}), ...(resume.length ? { resume } : {}), ...(latest ? { latest } : {}) }
      // the line its listener posts for a new gen; kept as it was until the next one (its "(again)" reads it)
      const line = gen > (prev?.gen ?? 0) ? pingLine(o, prev?.line) : prev?.line
      try { writeOffers(root, id, { ...o, ...(line ? { line } : {}) }) } catch { /* its listener looks again */ }
    }
  }

  const settle = (id: string, r: AgentRun | null) => { const w = waiters.get(id); if (w) { waiters.delete(id); w(r) } }

  const run = (b: Batch, conn?: Conn): Promise<AgentRun | null> => new Promise((resolve) => {
    // completed before a restart: its final message is on the batch
    if (b.claim?.result !== undefined) return resolve(parsedRun(b.claim.result))
    waiters.set(b.batchId, resolve)
    let gone = false
    void q.lock(() => {
      if (!b.claim && !b.offer) {
        // its session's room checked again here, under the lock: two runs chosen at once never take one last slot
        // (Codex's review of the F3 design) - the one that finds it full goes where a full session sends it
        const held = conn ? load(conn.id) - (kept(b, conn.id) ? 1 : 0) : 0
        if (conn && held >= maxOf(conn)) {
          letGo(b)
          if (b.handoff) { b.handoffWhy = `your session didn't take it - it already holds ${held} run${held === 1 ? '' : 's'}`; gone = true }
        } else if (conn && !d.mayHold(b, conn)) {
          // another runner holds one of its frames now (F4, Codex's review): never offered beside it
          crowdedOut(b); gone = true
        } else {
          b.runner = { kind: 'session', agent: conn?.agent ?? '' }
          if (conn) { b.runner.conn = conn.id; b.offer = { conn: conn.id, inc: conn.inc, at: Date.now() } }
        }
      }
      q.persist()
    }).then(() => { publish(); d.changed(); if (gone) settle(b.batchId, null) }, () => settle(b.batchId, null))
  })

  /** Does a run a session let go of (not an explicit choice of the owner's) wait for a session again? Only under
   *  `jam.runner: 'session'`, while sessions can take work at all. */
  const waitsForSession = (s = settings()) => s.runner === 'session' && s.session && s.context === 'fork'
  /** Where a run goes once its session lets go: back to waiting under session-only, else spawned. Call under the lock. */
  const letGo = (b: Batch) => { if (waitsForSession()) { delete b.handoff; b.runner = { kind: 'session', agent: '' } } else b.handoff = 'spawn' }
  /** It may not be held beside a run on one of its frames (F4: another runner's, or another incarnation's): it leaves its
   *  session - spawned as letGo says, or under session-only back to the queue, never waiting for a session with the frame
   *  kept (Codex's review: two runs waiting on one frame for the session you switched to each kept the frame the other
   *  needed, forever - a queued request holds nothing, so two never wait on each other). Call under the lock. */
  const crowdedOut = (b: Batch) => { letGo(b); b.handoff ??= 'queue'; b.handoffWhy = 'another runner holds one of its frames' }

  /** Take an offer back (not pulled in time, its session gone, Jam ended): where it goes is decided and saved in one write. */
  const withdraw = async (id: string, why: string) => {
    const did = await q.lock(() => {
      const b = byId(id)
      if (!b?.offer) return false
      delete b.offer; letGo(b)
      if (b.handoff) b.handoffWhy = why
      q.persist()
      return true
    })
    if (!did) return
    d.log(`  jam: a run offered to your session went another way (${why})`)
    publish(); if (byId(id)?.handoff) settle(id, null); d.changed()
  }

  /** The owner's stop, made final: dropped, or handed to a spawned runner (the owner's explicit choice wins over
   *  session-only waiting). Call under the lock. */
  const stopNow = (b: Batch) => {
    const c = b.claim!
    b.gen = Math.max(b.gen ?? 0, c.gen)
    if (c.stopping === 'drop') b.dropped = true
    else b.handoff = 'spawn'
    delete b.claim
  }
  /** A stop the owner chose is confirmed by its writer proven gone: it runs as they chose - saved first. */
  const finishStop = async (id: string): Promise<boolean> => {
    const did = await q.lock(() => {
      const b = byId(id)
      if (!b?.claim?.stopping || b.claim.result !== undefined) return false
      stopNow(b)
      q.persist()
      return true
    })
    if (did) { publish(); settle(id, null); d.changed() }
    return did
  }

  // ---- the session's commands --------------------------------------------------------------------------

  /** The batch a handle names, checked for this connection - call it under the lock. */
  const claimOf = (conn: Conn, handle: unknown): { b: Batch; gen: number } | string => {
    const m = typeof handle === 'string' ? HANDLE.exec(handle) : null
    if (!m) return 'that is not a run handle (r-xxxxxxxx.N)'
    const gen = Number(m[2])
    const b = open().find((x) => x.batchId.startsWith(m[1]))
    if (!b) return 'that run is over'
    if (!b.claim || b.claim.conn !== conn.id || b.claim.inc !== conn.inc) return 'that run is not yours - it went to another runner'
    if (b.claim.gen !== gen) return 'that handle is old - the run was taken again since'
    return { b, gen }
  }

  /** A change's receipt, in the same journal write as the change. */
  const keep = (req: Req, out: Out, b?: Batch) => { (q.j.receipts ??= {})[req.id] = { at: Date.now(), out, op: req.op, ...(b ? { batch: b.batchId } : {}) } }

  /** How a handed-back run's delivery stands, from the batch itself - what every answer about it says. Null: not
   *  settled yet (being posted). */
  const deliveryOf = (id: string): Out | null => {
    const b = q.j.batches.find((x) => x.batchId === id)
    if (!b) return { ok: false, error: 'that run is gone from the journal' }
    if (b.posted || b.state === 'done') return { ok: true, text: 'Delivered - its replies are posted and the frames are free.' }
    if (b.undelivered) return { ok: false, error: 'its replies are saved, but they could not be posted - Retry on the card posts them' }
    if (b.state === 'failed') return { ok: false, error: `it could not be delivered: ${b.note ?? 'the run failed'}` }
    if (b.results) { const o = outcome.get(id); return o && !o.ok ? { ok: false, error: `it could not be delivered: ${o.note ?? 'unknown'}` } : o?.note === 'retrying' ? { ok: true, text: 'Handed back - its replies are saved; posting them failed once and is being tried again.' } : null }
    const o = outcome.get(id)
    return o && !o.ok ? { ok: false, error: `it could not be delivered: ${o.note ?? 'unknown'}` } : null
  }

  /** A `done` or `say` sent again: where its run stands now, not what was hoped when it was taken. */
  const replay = (r: NonNullable<NonNullable<typeof q.j.receipts>[string]>, conn: Conn): Out | Promise<Out> => {
    if (r.op === 'mute') { try { patchConn(root, conn.id, conn.inc, { muted: true }) } catch { /* said as taken */ } return r.out }
    if (r.op === 'done' && r.batch) return deliveryOf(r.batch) ?? waitDelivery(r.batch)
    if (r.op === 'say' && r.batch) {
      const b = q.j.batches.find((x) => x.batchId === r.batch)
      return b?.early && d.say(b) ? { ok: true, text: 'Posted.' } : { ok: true, text: 'Taken - it is posted before the run is delivered.' }
    }
    return r.out
  }

  const waitDelivery = (id: string): Promise<Out> => new Promise((res) => {
    const to = setTimeout(() => res(deliveryOf(id) ?? { ok: true, text: 'Handed back - it is being posted; the canvas shows it in the thread.' }), 100_000)
    to.unref?.()
    deliveries.set(id, [...(deliveries.get(id) ?? []), () => { clearTimeout(to); res(deliveryOf(id) ?? { ok: true, text: 'Handed back - it is being posted; the canvas shows it in the thread.' }) }])
  })

  /** One request. Returns its answer, or a promise of it (a `done` answers once its replies are posted - and never
   *  holds up the requests after it). */
  const ops = async (req: Req, conn: Conn): Promise<Out | { later: Promise<Out> }> => {
    const now = Date.now()
    if (req.op === 'release') {
      let out: Out = { ok: false, error: 'that run is over' }
      let id = ''
      await q.lock(() => {
        const f = claimOf(conn, req.args.handle)
        if (typeof f === 'string') { out = { ok: false, error: f }; return }
        const b = f.b
        if (b.claim!.result !== undefined) { out = { ok: false, error: 'it is already handed back' }; return }
        id = b.batchId
        if (b.claim!.stopping) { out = { ok: true, text: 'Released - the owner\'s choice goes ahead.' }; stopNow(b) }
        else {
          b.gen = Math.max(b.gen ?? 0, b.claim!.gen); delete b.claim; letGo(b)
          // the copy that takes it says why (A8); under session-only it waits for a session again
          if (b.handoff) b.handoffWhy = 'your session let it go'
          out = { ok: true, text: b.handoff ? 'Released - another runner takes it.' : 'Released - it waits for a session again.' }
        }
        keep(req, out, b)
        q.persist()
      })
      if (id && out.ok) { publish(); if (byId(id)?.handoff || byId(id)?.dropped || !byId(id)) settle(id, null); d.changed() }
      return out
    }
    if (!usable(conn, now)) return { ok: false, error: conn.muted ? 'this session is muted for Jam until it ends' : 'this session cannot take Jam work now' }
    if (req.op === 'mute') {
      // journaled first; a restart between the two finds the receipt and mutes it then (replay)
      const out = { ok: true, text: 'Muted: this session takes no Jam work until it ends.' }
      await q.lock(() => { keep(req, out); q.persist() })
      patchConn(root, conn.id, conn.inc, { muted: true })
      for (const b of open().filter((x) => x.offer?.conn === conn.id)) await withdraw(b.batchId, 'muted')
      return out
    }
    if (req.op === 'status') {
      const mine = open().filter((b) => b.offer?.conn === conn.id || b.claim?.conn === conn.id)
      const line = (b: Batch) => b.offer ? `offered: run ${b.batchId.slice(0, 8)} (${b.frames.join(', ')}) - take it with ${cmdFor(conn, 'next')}` : `${b.claim!.stopping ? `stopping - release it: ${cmdFor(conn, 'release', handleOf(b, b.claim!.gen))}` : b.claim!.result !== undefined ? 'handed back' : b.claim!.stalled ? 'stalled' : 'yours'}: ${handleOf(b, b.claim!.gen)} (${b.frames.join(', ')})`
      return { ok: true, text: [`Connected: ${conn.agent} session ${conn.id}${selected(now)?.id === conn.id ? ' - it takes the work' : ''}${d.jamOn() ? '' : ' (no Jam session runs on the canvas now)'}.`, ...(mine.length ? mine.map(line) : ['No runs for it now.'])].join('\n') }
    }
    if (req.op === 'own') {
      // a run's new frame (a variant beside the frame it works on), given to it before it is placed: no other runner gets it
      const frame = String(req.args.frame ?? '')
      let out: Out = { ok: false, error: 'that run is over' }
      await q.lock(() => {
        const f = claimOf(conn, req.args.handle)
        if (typeof f === 'string') { out = { ok: false, error: f }; return }
        const c = f.b.claim!
        if (c.stopping) { out = { ok: false, error: `the owner moved this run elsewhere - stop working on it and run ${cmdFor(conn, 'release', String(req.args.handle))}` }; return }
        if (c.result !== undefined) { out = { ok: false, error: 'it is already handed back' }; return }
        const why = d.own(f.b, frame)
        if (why) { out = { ok: false, error: why }; return }
        c.progress = Date.now(); delete c.stalled
        out = { ok: true, text: `${frame} is this run's now - no other runner gets it until the run is handed back.` }
        keep(req, out, f.b)
        q.persist()
      })
      if (out.ok) { publish(); d.changed() }
      return out
    }
    if (req.op === 'next') {
      const let_go: string[] = []
      const out = await q.lock((): Out => {
        // taken only by the session it was offered to, while sessions may take work, it is still the selected one,
        // and the very registration that signed the request - all read again here, under the lock
        const s = settings()
        const cur = readConn(root, conn.id)
        if (!cur || cur.inc !== conn.inc || !usable(cur)) return { ok: false, error: 'this session\'s connection changed - run the command again' }
        const mine = open().filter((x) => x.offer?.conn === conn.id && x.offer.inc === conn.inc && sessionsOn(s, x)).sort((a, z) => a.offer!.at - z.offer!.at)
        if (!sessionsOn(s) && !mine.length) return { ok: true, text: 'Nothing waits for this session now (no Jam session takes it).' }
        if (selected(now)?.id !== conn.id) return { ok: true, text: 'Nothing waits for this session now - another session takes the work.' }
        // checked again as it is taken (F4, Codex's review): a run whose frame another runner holds now is not this
        // session's to take - it goes back through the scheduler, and the next one is taken
        let b: Batch | undefined
        for (const x of mine) {
          if (d.mayHold(x, conn)) { b = x; break }
          delete x.offer; crowdedOut(x); let_go.push(x.batchId)
        }
        if (!b) { if (let_go.length) q.persist(); return { ok: true, text: 'Nothing waits for this session now.' } }
        const gen = Math.max(b.gen ?? 0, b.claim?.gen ?? 0) + 1
        delete b.offer; delete b.handoff
        b.gen = gen
        b.runner = { kind: 'session', agent: conn.agent, conn: conn.id }
        b.claim = { conn: conn.id, inc: conn.inc, ...(conn.pid ? { pid: conn.pid } : {}), gen, at: Date.now(), progress: Date.now() }
        const handle = handleOf(b, gen)
        const o = { ok: true, handle, frames: b.frames, text: d.goal(b, handle, conn) }
        keep(req, o, b)
        q.persist()
        return o
      })
      for (const id of let_go) settle(id, null)
      if (out.handle || let_go.length) { publish(); d.changed() }
      return out
    }
    if (req.op === 'progress') {
      let out: Out = { ok: true, text: 'Noted - still yours.' }
      await q.lock(() => {
        const f = claimOf(conn, req.args.handle)
        if (typeof f === 'string') { out = { ok: false, error: f }; return }
        const c = f.b.claim!
        if (c.stopping) { out = { ok: false, error: `the owner moved this run elsewhere - stop working on it and run ${cmdFor(conn, 'release', String(req.args.handle))}` }; return }
        c.progress = Date.now(); delete c.stalled; delete c.resumed
        keep(req, out, f.b)
        q.persist()
      })
      if (out.ok) { publish(); d.changed() }
      return out
    }
    if (req.op === 'say') {
      const text = String(req.args.text ?? '').trim().slice(0, 2_000)
      if (!text) return { ok: false, error: 'say what' }
      let out: Out = { ok: true, text: 'Posted.' }
      let b0: Batch | undefined
      await q.lock(() => {
        const f = claimOf(conn, req.args.handle)
        if (typeof f === 'string') { out = { ok: false, error: f }; return }
        const b = f.b, c = b.claim!
        if (c.stopping) { out = { ok: false, error: `the owner moved this run elsewhere - stop working on it and run ${cmdFor(conn, 'release', String(req.args.handle))}` }; return }
        if (c.result !== undefined) { out = { ok: false, error: 'it is already handed back' }; return }
        if (b.members.length !== 1) { out = { ok: false, error: 'a run of several asks posts no early line - its replies come with done' }; return }
        if (b.early) { out = { ok: false, error: 'its early line is already posted' }; return }
        // journaled first, posted after with the id it names: a restart in between posts it then, never twice
        b.early = { body: text, asks: false, commentId: `jam-c-e${b.attempts}-${b.batchId}`, ts: Date.now() }
        c.progress = Date.now(); delete c.stalled
        keep(req, { ok: true, text: 'Posted.' }, b)
        q.persist()
        b0 = b
      })
      if (!b0) return out
      if (!d.say(b0)) return { ok: true, text: 'Taken - it is posted before the run is delivered.' }
      d.changed()
      return out
    }
    // done: the completion boundary - checked and stored under the lock, so a stop after it is refused, a second
    // done too, and a restart delivers it from here; the answer comes once the replies are posted
    const text = String(req.args.text ?? '').slice(0, DONE_MAX)
    if (!parsedRun(text).reply) return { ok: false, error: 'the final message is empty - write the marver-reply blocks to the file' }
    let err: string | undefined
    let id = ''
    await q.lock(() => {
      const f = claimOf(conn, req.args.handle)
      if (typeof f === 'string') { err = f; return }
      const c = f.b.claim!
      if (c.stopping) { err = `the owner moved this run elsewhere - stop working on it and run ${cmdFor(conn, 'release', String(req.args.handle))}`; return }
      if (c.result !== undefined) { err = 'it is already handed back'; return }
      c.result = text; c.progress = Date.now(); delete c.stalled; delete c.resumed
      id = f.b.batchId
      keep(req, { ok: true }, f.b)
      q.persist()
    })
    if (err) return { ok: false, error: err }
    const later = waitDelivery(id)
    settle(id, parsedRun(text))
    d.changed()
    return { later }
  }

  const answerAll = async () => {
    for (const { raw } of takeRequests(root)) {
      const rid = (raw as { id?: unknown } | null)?.id
      // the same request again (its answer lost, a restart between): the answer it got, or where it stands now
      const kept = typeof rid === 'string' ? q.j.receipts?.[rid] : undefined
      const v = verify(root, raw, kept ? new Set() : seenReqs)
      if (!v.ok) { if (v.id) answer(root, v.id, { ok: false, error: v.error }); continue }
      if (kept) { const r = replay(kept, v.conn); if (r instanceof Promise) void r.then((o) => answer(root, v.req.id, o)); else answer(root, v.req.id, r); continue }
      let out: Out | { later: Promise<Out> }
      try { out = await ops(v.req, v.conn) } catch (e) { out = { ok: false, error: (e as Error).message } }
      // (only a live one: a refused request from a registration that went silent must not make it eligible again)
      try { if (alive(v.conn)) patchConn(root, v.conn.id, v.conn.inc, {}) } catch { /* it answered; seen is a nicety */ }
      if ('later' in out && out.later instanceof Promise) { const id = v.req.id; void out.later.then((o) => answer(root, id, o)) }
      else answer(root, v.req.id, out as Out)
    }
    if (seenReqs.size > 5_000) seenReqs.clear()   // every one older than a minute is refused by age anyway
  }

  let lastSweep = 0
  /** who takes the work and their room, as the last tick read it */
  let routed = ''
  const tick = async (now = Date.now()) => {
    if (stopped || !d.ready()) return
    await answerAll()
    const s = settings()
    const chosen = selected(now)
    for (const b of open()) {
      // the session that takes this run (a session's own record is offered once it has ended; nothing else is)
      const sel = sessionsOn(s, b) ? chosen : undefined
      if (b.offer) {
        const c = readConn(root, b.offer.conn)
        if (!c || !usable(c, now) || c.inc !== b.offer.inc) { await withdraw(b.batchId, 'it ended or cannot take work now'); continue }
        if (!sessionsOn(s, b)) { await withdraw(b.batchId, d.jamOn() ? 'sessions are off' : 'the Jam session ended'); continue }
        if (sel?.id !== c.id) { await withdraw(b.batchId, 'another session takes the work now'); continue }
        if (s.runner === 'session') continue   // wait for it, however long
        if (c.agent === 'claude' ? now - b.offer.at > OFFER_MS : !c.busy && now - Math.max(b.offer.at, c.seen) > IDLE_OFFER_MS) await withdraw(b.batchId, c.agent === 'claude' ? 'not taken in 2 minutes' : 'its turn ended without taking it')
      } else if (b.claim) {
        const claim = b.claim
        if (claim.result !== undefined) continue   // handed back: the daemon delivers it
        if (claim.stopping) { if (writerGone(claim)) await finishStop(b.batchId); continue }
        const quiet = writerGone(claim) || now - claim.progress > STALL_MS
        if (!claim.stalled && quiet) {
          await q.lock(() => { const x = byId(b.batchId)?.claim; if (x && x.result === undefined && !x.stopping) { x.stalled = true; q.persist() } })
          d.log(`  jam: a run your session took went quiet (${writerGone(claim) ? 'the session ended' : 'no word for 15 minutes'}) - choose in the lane`)
          d.changed()
        }
      } else if (b.runner?.kind === 'session' && !b.handoff && waiters.has(b.batchId)) {
        // waiting for a session (`jam.runner: 'session'`, or released under it): offer it the moment there is one -
        // or, once waiting is no longer the rule (sessions or your context turned off), it goes spawned
        if (!waitsForSession(s) && !sel) {
          await q.lock(() => { const x = byId(b.batchId); if (x && !x.offer && !x.claim) { x.handoff = 'spawn'; q.persist() } })
          settle(b.batchId, null); d.changed()
          continue
        }
        // (its own kept slot aside: a run formed for this session is not in its own way)
        const fits = (x: Batch) => load(sel!.id) - (kept(x, sel!.id) ? 1 : 0) < maxOf(sel!)
        if (sel && offerable(sel) && fits(b)) {
          // the session could take it, but a run it may not be held beside is on one of its frames (another runner's, or
          // one waiting too): it goes back to the queue rather than keep the frame and wait (Codex's review)
          let out = false
          await q.lock(() => {
            const x = byId(b.batchId)
            if (!x || x.offer || x.claim || x.handoff || !fits(x)) return
            if (d.mayHold(x, sel)) { x.runner = { kind: 'session', agent: sel.agent, conn: sel.id }; x.offer = { conn: sel.id, inc: sel.inc, at: Date.now() } }
            else { crowdedOut(x); out = true }
            q.persist()
          })
          if (out) settle(b.batchId, null)
          d.changed()
        }
      }
    }
    // the session that takes the work changed, or its room (you chose another, one connected, ended or was muted): what
    // waits for a session may start now - no run of it moved to say so (Codex's review: a request with no frame waited on
    // a full session after you switched to an idle one)
    const routing = [roomOf(now), roomOf(now, true)].map((r) => (r ? `${r.conn.id}.${r.conn.inc}.${r.room}` : '')).join('|')
    if (routing !== routed) { routed = routing; d.changed() }
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

  /** the session that takes new work now and its room for more (F3, F4) - `record`: a session's record (F5) */
  const roomOf = (now = Date.now(), record = false): { conn: Conn; room: number } | undefined => {
    const s = settings()
    const sel = sessionsOn(s, record ? 'record' : undefined) ? selected(now) : undefined
    return sel && offerable(sel) ? { conn: sel, room: Math.max(0, maxOf(sel) - load(sel.id)) } : undefined
  }

  return {
    settings: () => { const sel = selected(); return settingsOf(root, d.cfg, sel?.agent) },
    room: (now) => roomOf(now)?.room ?? 0,
    taker: (now) => { const r = roomOf(now); return r && r.room > 0 ? r.conn : undefined },
    takes: roomOf,
    selected, choose, run, tick, title: titleOf,
    delivered(batchId, ok, note) {
      outcome.set(batchId, { ok, ...(note ? { note } : {}) })
      if (outcome.size > 200) outcome.delete(outcome.keys().next().value!)
      const rs = deliveries.get(batchId)
      if (rs) { deliveries.delete(batchId); for (const r of rs) r({ ok, note }) }
    },
    async act(batchId, gen, action) {
      let out: { ok: boolean; error?: string } = { ok: true }
      let check = false
      await q.lock(() => {
        const b = byId(batchId)
        const c = b?.claim
        if (!b || !c || c.gen !== gen) { out = { ok: false, error: 'the run changed - look again' }; return }
        if (c.result !== undefined) { out = { ok: false, error: 'it just finished - its reply is being posted' }; return }
        if (action === 'again') {
          // the same claim and handle: the session keeps going, told so (a new claim would need the old writer stopped)
          c.progress = Date.now(); delete c.stalled; delete c.stopping; c.resumed = true
        } else {
          // background or drop: the session must let go first - its `done` is refused from now, it is told to stop,
          // and the frames stay reserved until it releases the run or its writer is proven gone
          c.stopping = action; delete c.stalled; delete c.resumed
          check = true
        }
        q.persist()
      })
      if (!out.ok) return out
      if (check) { const c = byId(batchId)?.claim; if (c && writerGone(c)) await finishStop(batchId) }
      publish(); d.changed()
      return out
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
