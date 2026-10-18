/**
 * The jam queue (spec 27, Parts 1-2): cards and batches, and every rule that moves them.
 *
 * Only ledgered owner events become asks, and only a create or reply that tags `@marver` starts
 * work - a plain reply never does, in any thread. A tag joins its thread's queued card (a thread
 * has at most one), follows a working one, or makes a new card. Cards change in one place, under
 * one async lock, and every operation under it starts by ingesting the comment logs, so a claim or
 * an action always sees a reply, a tag or a resolve whose write finished before it.
 *
 * The functions here are synchronous over a journal held in memory; `createQueue` adds the lock
 * and the writes. The daemon (daemon.ts) runs what `form` claims and hands the results back.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listBoards, readLog, replay, type CommentEvent } from '../comments.ts'
import { owned as ownedSet } from './ledger.ts'
import { fresh, readRaw, write } from './journal.ts'
import { buildPacket, packetPath, sanitize, threadId } from './packet.ts'
import type { Batch, Brief, Card, CardState, Journal, JournalV1, Member, Msg, PacketMember, Result } from './types.ts'

export const MENTION = /@marver\b/i
/** A batch holds at most this many cards; the next waits for the next batch. */
export const MAX_MEMBERS = 8
const KEEP_MS = 7 * 24 * 60 * 60_000

const TERMINAL: CardState[] = ['done', 'dropped', 'kept']
export const pending = (c: Card): boolean => !TERMINAL.includes(c.state)

/** What every rule reads: where the logs are, and what this device ledgered (`board\tid`). */
export interface Ctx { root: string; dir: string; owned: Set<string> }
export const ctxFor = (root: string): Ctx => ({ root, dir: join(root, 'design', 'comments'), owned: ownedSet(root) })
const isOwned = (ctx: Ctx, board: string, id: string) => ctx.owned.has(`${board}\t${id}`)
const seenKey = (board: string, id: string) => `${board}|${id}`

const set = (c: Card, state: CardState, now: number, note?: string) => {
  c.state = state; c.rev += 1; c.at = now
  if (note !== undefined) c.note = note
}
const onThread = (j: Journal, board: string, thread: string) => j.cards.filter((c) => c.board === board && c.thread === thread)

/** The frame each thread sits on (a reply names only its thread). */
const framesOf = (events: CommentEvent[]) => {
  const m = new Map<string, string>()
  for (const ev of events) if (ev.type === 'create' && ev.commentId && ev.frame) m.set(ev.commentId, ev.frame)
  return m
}

// ---- ingest -----------------------------------------------------------------------------------

/** Read every log for events not seen yet and apply them. Synchronous - the watcher, the claim,
 *  the card actions and the page's comment route all call it. Returns whether a card changed.
 *  An owner-looking event that is not ledgered is left unseen and looked at again next time: the
 *  page ledgers it just after it appends, and a synced event never is (a set lookup each time). */
export function ingest(j: Journal, ctx: Ctx, now = Date.now()): boolean {
  const seen = new Set(j.seen)
  const before = seen.size
  let changed = false
  for (const board of listBoards(ctx.dir)) {
    const events = readLog(ctx.dir, board)
    let frames: Map<string, string> | undefined
    for (const ev of events) {
      const k = seenKey(board, ev.id)
      if (seen.has(k)) continue
      // agent events never move a card: the daemon moves its own cards when it posts
      if (ev.agent) { seen.add(k); continue }
      if (ev.type === 'resolve') { seen.add(k); changed = resolved(j, board, ev.commentId ?? '', now) || changed; continue }
      if (ev.type !== 'create' && ev.type !== 'reply' && ev.type !== 'edit') { seen.add(k); continue }
      if (!isOwned(ctx, board, ev.id)) continue
      seen.add(k)
      if (ev.type === 'edit') { changed = edited(j, board, events, ev, now) || changed; continue }
      const thread = threadId(ev)
      if (MENTION.test(ev.body ?? '')) {
        frames ??= framesOf(events)
        tagged(j, board, ev, ev.frame ?? frames.get(thread), now)
        changed = true
      } else if (ev.type === 'reply') changed = answered(j, board, thread, now) || changed
    }
  }
  if (seen.size !== before) j.seen = [...seen]
  return changed
}

/** An owner comment or reply that tags @marver. */
function tagged(j: Journal, board: string, ev: CommentEvent, frame: string | undefined, now: number) {
  const thread = threadId(ev)
  const on = onThread(j, board, thread)
  const queued = on.find((c) => c.state === 'queued')
  if (queued) { queued.events.push(ev.id); queued.rev += 1; queued.at = now; return }
  let follows: string | undefined
  const working = on.find((c) => c.state === 'working')
  const asking = on.find((c) => c.state === 'asks')
  const failed = on.filter((c) => c.state === 'failed').sort((a, b) => b.at - a.at)[0]
  if (working) follows = working.id
  else if (asking) { set(asking, 'done', now, 'answered'); follows = asking.id }
  else if (failed) { set(failed, 'done', now, 'retried by a new tag'); follows = failed.id }
  const capture = on.find((c) => c.capture)?.capture
  j.cards.push({
    id: `c-${ev.id}`, kind: 'comment', board, frames: frame ? [frame] : [], thread,
    ...(capture ? { capture } : {}), events: [ev.id], state: 'queued', ...(follows ? { follows } : {}),
    made: ev.ts, order: ev.ts, rev: 1, at: now,
  })
}

/** A plain owner reply: conversation, never a command. It answers a card that asks. */
function answered(j: Journal, board: string, thread: string, now: number): boolean {
  let changed = false
  for (const c of onThread(j, board, thread)) if (c.state === 'asks') { set(c, 'done', now, 'answered'); changed = true }
  return changed
}

/** An edit never starts work and never cancels it; it only changes the text of a card not yet
 *  claimed (the brief reads the latest ledgered edit at claim) - bump it so a page redraws. */
function edited(j: Journal, board: string, events: CommentEvent[], ev: CommentEvent, now: number): boolean {
  const target = events.find((e) => (e.type === 'create' || e.type === 'reply') && e.commentId === ev.commentId)
  if (!target) return false
  let changed = false
  for (const c of j.cards) if (c.board === board && c.state === 'queued' && c.events.includes(target.id)) { c.rev += 1; c.at = now; changed = true }
  return changed
}

/** A thread resolved by hand: a queued card is dropped, a working one runs to its end (and goes to
 *  done, not review), and one that asks, waits for review or failed is done. */
function resolved(j: Journal, board: string, thread: string, now: number): boolean {
  let changed = false
  for (const c of onThread(j, board, thread)) {
    if (c.state === 'queued') set(c, 'dropped', now, 'resolved')
    else if (c.state === 'working') { c.resolved = true; c.rev += 1; c.at = now }
    else if (c.state === 'asks' || c.state === 'review' || c.state === 'failed') set(c, 'done', now, 'resolved')
    else continue
    changed = true
  }
  return changed
}

// ---- the merge rule, and actions ------------------------------------------------------------------

/** Two cards meet on one thread (a Retry, a `shared` requeue): one survives with both cards' asks,
 *  its rev bumped, and the other turns done ("merged"). A capture card always survives - it keeps
 *  its tile, its scope and its review; with no capture card involved, `queued` (the card already
 *  waiting) survives. */
export function merge(j: Journal, queued: Card, other: Card, now: number): Card {
  const [keep, gone] = other.capture && !queued.capture ? [other, queued] : [queued, other]
  keep.events = [...new Set([...gone === queued ? queued.events : [], ...keep.events, ...gone === queued ? [] : gone.events])]
  if (gone.exclusive || keep.exclusive) keep.exclusive = [...new Set([...(keep.exclusive ?? []), ...(gone.exclusive ?? [])])]
  keep.shared = Math.max(keep.shared ?? 0, gone.shared ?? 0) || undefined
  for (const f of gone.frames) if (!keep.frames.includes(f)) keep.frames.push(f)
  // the card that ran and failed is what the survivor follows: its asks and what came of them
  if (gone.batch || gone.ran?.length) keep.follows ??= gone.id
  keep.state = 'queued'; keep.rev += 1; keep.at = now
  keep.order = Math.min(keep.order, gone.order)
  set(gone, 'done', now, 'merged')
  gone.note = `merged into ${keep.id}`
  return keep
}

/** Put a card back in the queue (Retry, a `shared` answer): its last run joins `ran`. If the thread
 *  already holds a queued card, the two merge. */
export function requeue(j: Journal, c: Card, now: number, first = false): Card {
  if (c.batch) c.ran = [...(c.ran ?? []), c.batch]
  c.batch = undefined
  c.note = undefined
  c.state = 'queued'; c.rev += 1; c.at = now
  if (first) c.order = Math.min(now, ...j.cards.filter((x) => x.state === 'queued' && x !== c).map((x) => x.order - 1))
  const other = c.thread ? onThread(j, c.board, c.thread).find((x) => x !== c && x.state === 'queued') : undefined
  return other ? merge(j, other, c, now) : c
}

export type Action = 'drop' | 'retry' | 'keep' | 'first' | 'confirm' | 'edit' | 'good' | 'more' | 'later'
export const ACTIONS: Action[] = ['drop', 'retry', 'keep', 'first', 'confirm', 'edit', 'good', 'more', 'later']

/** One card action from the page (POST /jam/card). It applies only if the card is still at `rev`
 *  (two tabs cannot both decide); anything not allowed answers with the current card. */
export function act(j: Journal, id: string, rev: number, action: string, now = Date.now()): { ok: boolean; card?: Card; error?: string } {
  const c = j.cards.find((x) => x.id === id)
  if (!c) return { ok: false, error: 'no such card' }
  if (c.rev !== rev) return { ok: false, card: c, error: 'the card changed - look again' }
  const capture = c.kind === 'capture'
  if (action === 'drop' && (c.state === 'queued' || (capture && (c.state === 'draft' || c.state === 'failed')))) {
    set(c, 'dropped', now, 'dropped'); return { ok: true, card: c }
  }
  if (action === 'retry' && c.state === 'failed') return { ok: true, card: requeue(j, c, now) }
  if (action === 'keep' && capture && c.state === 'queued') { set(c, 'kept', now, 'kept, not sent'); return { ok: true, card: c } }
  if (action === 'first' && capture && c.state === 'queued') {
    c.order = Math.min(c.order, ...j.cards.filter((x) => x.state === 'queued' && x !== c).map((x) => x.order - 1))
    c.rev += 1; c.at = now
    return { ok: true, card: c }
  }
  // confirm, edit and the verdicts arrive with captures (M2)
  return { ok: false, card: c, error: `${action} is not allowed on this card` }
}

// ---- claiming ------------------------------------------------------------------------------------

/** The text of one message as the owner wrote it: for an owner event, its body or its latest
 *  LEDGERED edit (an edit that arrived by sync is never the owner's text); for anyone else, the
 *  latest edit as replay shows it. */
function textOf(ctx: Ctx, board: string, events: CommentEvent[], ev: CommentEvent, owner: boolean): { body: string; rev: string } {
  let body = ev.body ?? ''
  let rev = ev.id
  for (const e of events) {
    if (e.type !== 'edit' || e.commentId !== ev.commentId || e.body === undefined) continue
    if (owner ? !e.agent && isOwned(ctx, board, e.id) : (!!e.agent === !!ev.agent)) { body = e.body; rev = e.id }
  }
  return { body, rev }
}

/** Is a copied ask still the owner's? Its event is in the log and ledgered, and its frozen revision is
 *  the event itself or a ledgered edit OF THAT MESSAGE (never another message's edit). */
export function stillOwned(ctx: Ctx, board: string, events: CommentEvent[], m: Pick<Msg, 'id' | 'rev'>): boolean {
  const ev = events.find((e) => e.id === m.id)
  if (!ev || ev.agent || !isOwned(ctx, board, m.id)) return false
  if (!m.rev || m.rev === m.id) return true
  const edit = events.find((e) => e.id === m.rev)
  return !!edit && edit.type === 'edit' && !edit.agent && edit.commentId === ev.commentId && isOwned(ctx, board, m.rev)
}

const resultText = (j: Journal, batchId: string | undefined, card: string, fallback = ''): string => {
  const b = j.batches.find((x) => x.batchId === batchId)
  const m = b?.members.find((x) => x.card === card)
  const r = m && b?.results?.[m.id]
  if (!r) return fallback
  if ('body' in r) return r.body
  if ('missing' in r) return 'the agent did not answer this one'
  return `needed shared files: ${r.shared.join(', ')}`
}

/** Freeze a card's brief as text, from the logs as they stand at claim. Covers every owner event it
 *  copies (the `covered` record that takes a plain reply off `marver marks`). */
export function freezeBrief(j: Journal, ctx: Ctx, c: Card, events: CommentEvent[]): Brief {
  const msgs = c.thread ? events.filter((e) => (e.type === 'create' && e.commentId === c.thread) || (e.type === 'reply' && e.parentId === c.thread)) : []
  const dropped = new Set(j.cards.filter((x) => x.board === c.board && x.state === 'dropped').flatMap((x) => x.events))
  const asks = new Set(c.events)
  const toMsg = (e: CommentEvent): Msg => {
    const owner = !e.agent && isOwned(ctx, c.board, e.id)
    const { body, rev } = textOf(ctx, c.board, events, e, owner)
    const note = !owner && !e.agent ? 'someone else - context only'
      : owner && !asks.has(e.id) && dropped.has(e.id) ? 'dropped - not an ask' : undefined
    if (owner) j.covered[e.id] = rev
    return { id: e.id, ...(e.author?.name ? { author: sanitize(e.author.name, 80) } : {}), ...(e.agent ? { agent: true } : {}),
      ...(owner ? { owner: true, rev } : {}), body: sanitize(body, Infinity), ts: e.ts, ...(note ? { note } : {}) }   // whole: the packet is a file, and a cut ask can lose its last constraint
  }
  const brief: Brief = {
    asks: c.events.map((id) => msgs.find((e) => e.id === id) ?? events.find((e) => e.id === id)).filter((e): e is CommentEvent => !!e).map(toMsg),
    history: msgs.filter((e) => !asks.has(e.id)).map(toMsg),
  }
  const followed = c.follows ? j.cards.find((x) => x.id === c.follows) : undefined
  // a run is named by its batch: the card's current one, or - requeued or merged since - its last in `ran`
  const lastRun = (x: Card) => x.batch ?? x.ran?.[x.ran.length - 1]
  // the earlier asks a follow-up copies are checked again, now: a ledger that lost one, or a revision
  // that is not that message's, never reaches the agent through `follows`
  const keep = (asks: Msg[] | undefined) => (asks ?? []).filter((a) => stillOwned(ctx, c.board, events, a))
  if (followed) {
    const b = lastRun(followed)
    brief.follows = { asks: keep(followed.brief?.asks), result: resultText(j, b, followed.id, j.batches.find((x) => x.batchId === b)?.note ?? followed.note ?? '') }
  }
  else if (c.ran?.length) {
    const last = c.ran[c.ran.length - 1]
    const m = j.batches.find((b) => b.batchId === last)?.members.find((x) => x.card === c.id)
    brief.follows = { asks: keep(m?.brief?.asks), result: resultText(j, last, c.id, j.batches.find((b) => b.batchId === last)?.note ?? 'the run failed') }
  }
  return brief
}

/** Are a card's asks still the owner's? Each must be in its board's log and ledgered; the ones that
 *  are not are dropped, and a card with none left is dropped ("no longer authorized"). */
function validate(ctx: Ctx, c: Card, events: CommentEvent[], now: number): boolean {
  if (c.kind !== 'comment') return true   // captures and wrap-ups are checked by their own seal (M2)
  const ok = c.events.filter((id) => isOwned(ctx, c.board, id) && events.some((e) => e.id === id))
  if (ok.length !== c.events.length) { c.events = ok; c.rev += 1; c.at = now }
  if (!ok.length) { set(c, 'dropped', now, 'no longer authorized'); return false }
  return true
}

export interface FormOpts {
  /** batch slots free (jam.concurrency minus what runs) */
  free: number
  /** frames the running batches hold */
  running: Set<string>
  /** does an exclusive batch run now? */
  exclusiveRunning: boolean
  /** a chat agent's `work start` holds this frame */
  held(frame: string): boolean
  /** any `work start` hold at all (an exclusive job waits for every one) */
  anyHold(): boolean
}

/** Claim what can run now: the queued cards of one board on one single frame join one batch, in
 *  run order, up to 8; a card naming several frames runs alone and waits for all of them; a card
 *  with no frame, or one that must edit a shared file, runs exclusive - alone, once nothing runs and
 *  no hold is left, and while it waits nothing new starts. Briefs are frozen, cards turn working,
 *  and each packet is written to its file. Returns the new batches (already in the journal). */
export function form(j: Journal, ctx: Ctx, o: FormOpts, now = Date.now()): { batches: Batch[]; exclusiveWaiting: boolean } {
  const queued = j.cards.filter((c) => c.state === 'queued').sort((a, b) => a.order - b.order || a.made - b.made)
  const exclusive = queued.filter((c) => c.exclusive || !c.frames.length)
  const logs = new Map<string, CommentEvent[]>()
  const log = (board: string) => { let l = logs.get(board); if (!l) logs.set(board, (l = readLog(ctx.dir, board))); return l }
  type Forming = { board: string; frames: string[]; cards: Card[]; exclusive?: boolean; single: boolean }
  const forming: Forming[] = []
  if (exclusive.length) {
    if (o.exclusiveRunning || o.running.size || o.anyHold() || o.free < 1) return { batches: [], exclusiveWaiting: !o.exclusiveRunning }
    for (const c of exclusive) {
      if (!validate(ctx, c, log(c.board), now)) continue
      forming.push({ board: c.board, frames: [...c.frames], cards: [c], exclusive: true, single: false })
      break
    }
  } else if (!o.exclusiveRunning) {
    const reserved = new Set(o.running)
    for (const c of queued) {
      if (c.frames.length === 1) {
        const f = c.frames[0]
        const join = forming.find((b) => b.single && b.board === c.board && b.frames[0] === f && b.cards.length < MAX_MEMBERS)
        if (join) { if (validate(ctx, c, log(c.board), now)) join.cards.push(c); continue }
        if (reserved.has(f) || o.held(f) || forming.length >= o.free) continue
        if (!validate(ctx, c, log(c.board), now)) continue
        forming.push({ board: c.board, frames: [f], cards: [c], single: true })
        reserved.add(f)
      } else {
        if (c.frames.some((f) => reserved.has(f) || o.held(f)) || forming.length >= o.free) continue
        if (!validate(ctx, c, log(c.board), now)) continue
        forming.push({ board: c.board, frames: [...c.frames], cards: [c], single: false })
        for (const f of c.frames) reserved.add(f)
      }
    }
  }
  const batches: Batch[] = []
  for (const f of forming) {
    const batchId = randomUUID()
    const members: Member[] = []
    const packetMembers: PacketMember[] = []
    const threads = replay(log(f.board))
    for (const c of f.cards) {
      const brief = freezeBrief(j, ctx, c, log(c.board))
      const id = `m${members.length + 1}`
      c.brief = brief; c.batch = batchId
      set(c, 'working', now)
      members.push({ id, card: c.id, board: c.board, brief })
      const t = c.thread ? threads.find((x) => x.id === c.thread) : undefined
      packetMembers.push({ id, card: c.id, kind: c.kind, board: c.board, ...(c.thread ? { thread: c.thread } : {}), frames: c.frames,
        ...(t?.anchor !== undefined ? { anchor: t.anchor } : {}), brief })
    }
    const files = f.exclusive ? [...new Set(f.cards.flatMap((c) => c.exclusive ?? []))] : undefined
    const b: Batch = { batchId, members, frames: f.frames, ...(f.exclusive ? { exclusive: true } : {}), state: 'claimed', leaseUntil: 0, attempts: 0, at: now }
    j.batches.push(b)
    writePacket(ctx.root, buildPacket(batchId, packetMembers, f.frames, f.exclusive ? files : undefined), new Set(j.batches.filter((x) => x.state === 'claimed').map((x) => x.batchId)))
    batches.push(b)
  }
  return { batches, exclusiveWaiting: exclusive.length > 0 && batches.length === 0 }
}

const PACKETS_KEPT = 50
/** Write a batch's packet once (a rerun reads the same file) and forget old ones - never one an
 *  unfinished batch (`keep`) still needs to resume. */
export function writePacket(root: string, packet: ReturnType<typeof buildPacket>, keep: Set<string> = new Set()) {
  const file = join(root, packetPath(packet.batchId))
  const dir = join(root, 'design', '.local', 'jam', 'packets')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(packet, null, 1), { mode: 0o600, flag: 'wx' })
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(PACKETS_KEPT)) if (!keep.has(f.replace(/\.json$/, ''))) rmSync(join(dir, f), { force: true })
  } catch { /* housekeeping only */ }
}

// ---- after the agent --------------------------------------------------------------------------

/** Did the owner answer in this thread after `since` (a ledgered create or reply)? A question the
 *  agent posted early may be answered while the job still runs. */
export function answeredSince(ctx: Ctx, board: string, thread: string, since: number): boolean {
  return readLog(ctx.dir, board).some((e) => (e.type === 'reply' && e.parentId === thread) && !e.agent && e.ts > since && isOwned(ctx, board, e.id))
}

export interface Settled { card: Card; notice?: 'asks' | 'failed' }

/** Move a batch's cards by their results, once every reply is posted. `posted` names each member's
 *  reply (comment id), whether its question was already answered, and when it was asked. */
export function settle(j: Journal, b: Batch, posted: Record<string, { reply?: string; answered?: boolean; asked?: number }>, now = Date.now()): Settled[] {
  const out: Settled[] = []
  for (const m of b.members) {
    const c = j.cards.find((x) => x.id === m.card)
    const r: Result | undefined = b.results?.[m.id]
    if (!c || c.state !== 'working' || c.batch !== b.batchId || !r) continue
    if ('body' in r) {
      const p = posted[m.id] ?? {}
      if (p.reply) c.reply = p.reply
      if (c.resolved) set(c, 'done', now, 'replied')
      else if (r.asks && p.answered) set(c, 'done', now, 'answered')
      else if (r.asks) { c.asked = p.asked ?? now; set(c, 'asks', now, 'asks you'); out.push({ card: c, notice: 'asks' }); continue }
      else set(c, c.kind === 'comment' ? 'done' : 'review', now, c.kind === 'comment' ? 'replied' : 'ready to review')
      out.push({ card: c })
    } else if (c.resolved) {
      set(c, 'done', now, 'resolved')                  // resolved while it ran: nothing comes back to it
      out.push({ card: c })
    } else if ('missing' in r) {
      set(c, 'failed', now, 'the agent did not answer this one'); out.push({ card: c, notice: 'failed' })
    } else if (c.exclusive || (c.shared ?? 0) >= 1) {
      set(c, 'failed', now, 'needed more shared files than it was given'); out.push({ card: c, notice: 'failed' })
    } else {
      c.exclusive = r.shared; c.shared = 1
      out.push({ card: requeue(j, c, now) })
    }
  }
  b.state = 'done'; b.at = now
  return out
}

/** Two failed attempts: every working card of the batch turns failed. */
export function fail(j: Journal, b: Batch, note: string, now = Date.now()): Settled[] {
  const out: Settled[] = []
  for (const m of b.members) {
    const c = j.cards.find((x) => x.id === m.card)
    if (!c || c.state !== 'working' || c.batch !== b.batchId) continue
    if (c.resolved) set(c, 'done', now, 'resolved')
    else { set(c, 'failed', now, note); out.push({ card: c, notice: 'failed' }) }
  }
  b.state = 'failed'; b.at = now; b.note = note
  return out
}

/** Forget finished cards and batches after a week, unless a live card follows one. */
export function prune(j: Journal, now = Date.now()) {
  const needed = new Set(j.cards.filter(pending).flatMap((c) => [c.follows, ...(c.ran ?? []), c.batch]).filter(Boolean) as string[])
  j.cards = j.cards.filter((c) => pending(c) || c.at > now - KEEP_MS || needed.has(c.id))
  const cardIds = new Set(j.cards.map((c) => c.id))
  j.batches = j.batches.filter((b) => b.state === 'claimed' || needed.has(b.batchId) || b.members.some((m) => cardIds.has(m.card)))
}

// ---- the first boot: baseline, and the v1 upgrade -----------------------------------------------

/** First-enable safety: every event already on disk is seen without being run. */
export function baseline(j: Journal, ctx: Ctx): void {
  if (j.baselined) return
  const seen = new Set(j.seen)
  for (const board of listBoards(ctx.dir)) for (const ev of readLog(ctx.dir, board)) seen.add(seenKey(board, ev.id))
  j.seen = [...seen]; j.baselined = true
}

/** A 0.25 journal becomes a v2 one (spec 27, Part 7). Every v1 batch stays a batch; one whose final
 *  reply (`jam-<batch>`) is already logged is reconciled, not rerun. Any other in flight is fenced
 *  (the caller kills `fence`) and, if its trigger tagged @marver, becomes a failed card with Retry;
 *  a plain reply never survives as work - it stays on `marver marks`' answered list. A plain reply
 *  v1 took in without running is `legacy`: listed apart, never as definitely unread. */
export function upgrade(v1: JournalV1, ctx: Ctx, now = Date.now()): { j: Journal; fence: number[] } {
  const j = fresh()
  j.baselined = v1.baselined
  j.upgraded = now
  const fence: number[] = []
  const v1seen = new Set(v1.seen)
  const unfinished = new Set<string>()
  for (const board of listBoards(ctx.dir)) {
    const events = readLog(ctx.dir, board)
    const frames = framesOf(events)
    for (const ev of events) if (v1seen.has(ev.id)) j.seen.push(seenKey(board, ev.id))
    for (const b of v1.batches.filter((x) => x.board === board && (x.state === 'pending' || x.state === 'claimed'))) {
      const id = b.memberEventIds[0]
      const ev = events.find((e) => e.id === id)
      if (!ev) continue
      unfinished.add(id)
      const thread = threadId(ev)
      const frame = ev.frame ?? frames.get(thread)
      const final = events.find((e) => e.id === `jam-${b.batchId}`)
      const tag = MENTION.test(ev.body ?? '') && isOwned(ctx, board, id)
      const card = (state: CardState, note: string): Card => ({
        id: `c-${id}`, kind: 'comment', board, frames: frame ? [frame] : [], thread, events: [id], state, note,
        batch: b.batchId, made: ev.ts, order: ev.ts, rev: 1, at: now,
      })
      if (final) {
        const asks = final.asks ?? /\?\s*$/.test(final.body ?? '')
        j.cards.push({ ...card(asks ? 'asks' : 'done', asks ? 'asks you' : 'replied'), reply: final.commentId, ...(asks ? { asked: final.ts } : {}) })
        j.batches.push({ batchId: b.batchId, members: [{ id: 'm1', card: `c-${id}`, board }], frames: frame ? [frame] : [], state: 'done', leaseUntil: 0,
          attempts: b.attempts, results: { m1: { body: final.body ?? '', asks, reanchors: [] } }, posted: true, at: now })
        continue
      }
      if (b.state === 'claimed' && b.pgid) fence.push(b.pgid)
      if (!tag) continue
      j.cards.push(card('failed', 'interrupted by the upgrade - Retry'))
      j.batches.push({ batchId: b.batchId, members: [{ id: 'm1', card: `c-${id}`, board }], frames: frame ? [frame] : [], state: 'failed', leaseUntil: 0,
        attempts: b.attempts, ...(b.pgid ? { pgid: b.pgid } : {}), at: now })
    }
    for (const ev of events) {
      if (ev.type === 'reply' && !ev.agent && v1seen.has(ev.id) && !unfinished.has(ev.id) && !MENTION.test(ev.body ?? '') && isOwned(ctx, board, ev.id)) j.legacy.push(ev.id)
    }
  }
  return { j, fence }
}

// ---- answered by you (marver marks) ---------------------------------------------------------------

export interface Answer { board: string; thread: string; frame?: string; event: string; body: string; ts: number }

/** Every ledgered plain owner reply, in an open thread where Marver spoke, that nothing has taken in
 *  yet: no frozen brief copied its current text, and the coding agent has not answered after it (a
 *  reply from the CLI, not a jam job's). A later ledgered edit makes it unread again. Cards on the
 *  thread, done or not, do not hide it. `earlier`: replies a v1 journal took in - maybe handled. */
export function answers(root: string): { answered: Answer[]; earlier: Answer[] } {
  const ctx = ctxFor(root)
  const raw = readRaw(root)
  const j = raw.v2 ?? (raw.v1 ? upgrade(raw.v1, ctx).j : fresh())
  const legacy = new Set(j.legacy)
  const out = { answered: [] as Answer[], earlier: [] as Answer[] }
  for (const board of listBoards(ctx.dir)) {
    const events = readLog(ctx.dir, board)
    for (const t of replay(events)) {
      if (t.resolved || !(t.agent || t.replies.some((r) => r.agent))) continue
      const msgs = events.filter((e) => (e.type === 'create' && e.commentId === t.id) || (e.type === 'reply' && e.parentId === t.id))
      for (const ev of msgs) {
        if (ev.type !== 'reply' || ev.agent || !isOwned(ctx, board, ev.id)) continue
        const { body, rev } = textOf(ctx, board, events, ev, true)
        if (MENTION.test(body)) continue
        const at = rev === ev.id ? ev.ts : (events.find((e) => e.id === rev)?.ts ?? ev.ts)
        if (j.covered[ev.id] === rev) continue
        if (msgs.some((e) => e.agent && !e.id.startsWith('jam-') && e.ts > at)) continue
        const a: Answer = { board, thread: t.id, ...(t.frame ? { frame: t.frame } : {}), event: ev.id, body: body.replace(/\s+/g, ' ').trim(), ts: ev.ts }
        ;(legacy.has(ev.id) ? out.earlier : out.answered).push(a)
      }
    }
  }
  return out
}

// ---- the queue: one lock, one writer -----------------------------------------------------------

export interface Queue {
  /** the journal in memory (read it under the lock) */
  readonly j: Journal
  ctx(): Ctx
  /** Run `fn` under the queue's one lock, after a fresh ingest. */
  lock<T>(fn: (j: Journal, ctx: Ctx) => T | Promise<T>): Promise<T>
  persist(): void
}

/** Load the journal - upgrading a v1 one, or starting fresh and baselining - and wrap it in the
 *  lock. `onUpgrade` gets the orphans to fence and runs once, before anything is scheduled. */
export function createQueue(root: string, onUpgrade?: (fence: number[]) => void): Queue {
  const raw = readRaw(root)
  let ctx = ctxFor(root)
  let j: Journal
  if (raw.v2) j = raw.v2
  else if (raw.v1) { const u = upgrade(raw.v1, ctx); j = u.j; onUpgrade?.(u.fence) }
  else j = fresh()
  baseline(j, ctx)
  write(root, j)
  let tail: Promise<unknown> = Promise.resolve()
  return {
    get j() { return j },
    ctx: () => ctx,
    lock<T>(fn: (j: Journal, ctx: Ctx) => T | Promise<T>): Promise<T> {
      const run = tail.then(async () => {
        ctx = ctxFor(root)
        if (ingest(j, ctx)) write(root, j)
        return fn(j, ctx)
      })
      tail = run.catch(() => {})
      return run
    },
    persist() { write(root, j) },
  }
}
