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
import { localProfile } from '../profile.ts'
import { fresh, readRaw, write } from './journal.ts'
import { buildPacket, packetPath, sanitize, threadId } from './packet.ts'
import type { Batch, Brief, Card, CardState, CaptureRecord, Journal, JournalV1, Member, Msg, PacketMember, Payload, Result } from './types.ts'
import { captureFrames, factsOf, hashOf, madeOf, readCapture, requestWords, wordsSince } from './capture.ts'
import { readWrapup, recordPathProblem, type Wrapup } from './session.ts'

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
      // a capture's comment and a More work reply are written by their own recoverable steps (the
      // card is already theirs): never a card of their own, whatever the words say
      if (ev.capture || ev.id.startsWith('mw-') || ev.id.startsWith('cap-')) continue
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
  const working = on.find((c) => c.state === 'working')
  const asking = on.find((c) => c.state === 'asks')
  const failed = on.filter((c) => c.state === 'failed').sort((a, b) => b.at - a.at)[0]
  // a tag answers a card that asks and retries one that failed - also when it joins a queued card
  if (asking) set(asking, 'done', now, 'answered')
  if (failed && !asking) set(failed, 'done', now, 'retried by a new tag')
  if (queued) {
    queued.events.push(ev.id); queued.when = { ...queued.when, [ev.id]: ev.ts }
    if (asking || failed) queued.follows ??= (asking ?? failed)!.id
    queued.rev += 1; queued.at = now
    return
  }
  let follows: string | undefined
  if (working) follows = working.id
  else if (asking) follows = asking.id
  else if (failed) follows = failed.id
  // every card on a capture's thread carries the capture - and all of its frames, reserved together
  const capCard = on.find((c) => c.capture)
  const capture = capCard?.capture
  const frames = capCard ? [...capCard.frames] : frame ? [frame] : []
  j.cards.push({
    id: `c-${ev.id}`, kind: 'comment', board, frames, thread,
    ...(capture ? { capture } : {}), events: [ev.id], when: { [ev.id]: ev.ts }, state: 'queued', ...(follows ? { follows } : {}),
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
  // the capture's OWN card survives (a tag on its thread carries `capture` too, but is not it)
  const [keep, gone] = other.kind === 'capture' && queued.kind !== 'capture' ? [other, queued] : [queued, other]
  // asks stay in the order they were made - each by its own time (a card's `made` for one that never
  // recorded it), the id breaking a tie - so the newest tag carries the icon, however many merges
  const when = { ...gone.when, ...keep.when }
  const at = (id: string) => when[id] ?? (gone.events.includes(id) ? gone.made : keep.made)
  keep.events = [...new Set([...gone.events, ...keep.events])].sort((a, b) => at(a) - at(b) || (a < b ? -1 : 1))
  keep.when = Object.fromEntries(keep.events.map((id) => [id, at(id)]))
  if (gone.exclusive || keep.exclusive) keep.exclusive = [...new Set([...(keep.exclusive ?? []), ...(gone.exclusive ?? [])])]
  keep.shared = Math.max(keep.shared ?? 0, gone.shared ?? 0) || undefined
  for (const f of gone.frames) if (!keep.frames.includes(f)) keep.frames.push(f)
  // what a run let go into the card that goes left there (F4: the frames it made, its pictures from before any edit) is
  // the survivor's - the one waiting already came first, so its pictures are the earlier (Codex's review)
  if (gone.alone) { keep.alone = joinAlone(gone.alone, keep.alone ?? {}); delete gone.alone }
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

export type Action = 'drop' | 'retry' | 'keep' | 'first' | 'confirm' | 'edit' | 'good' | 'more' | 'later' | 'rename' | 'note' | 'session-again' | 'session-background' | 'session-drop'
/** (the three `session-` actions are a stalled session run's choices - the daemon answers them, spec 29b Part 7) */
export const ACTIONS: Action[] = ['drop', 'retry', 'keep', 'first', 'confirm', 'edit', 'good', 'more', 'later', 'rename', 'note', 'session-again', 'session-background', 'session-drop']

/** One card action from the page (POST /jam/card). It applies only if the card is still at `rev`
 *  (two tabs cannot both decide); anything not allowed answers with the current card. */
export function act(j: Journal, id: string, rev: number, action: string, now = Date.now(), body?: string): { ok: boolean; card?: Card; error?: string } {
  const c = j.cards.find((x) => x.id === id)
  if (!c) return { ok: false, error: 'no such card' }
  if (c.rev !== rev) return { ok: false, card: c, error: 'the card changed - look again' }
  const capture = c.kind === 'capture'
  if (action === 'drop' && (c.state === 'queued' || ((capture || c.kind === 'wrapup') && (c.state === 'draft' || c.state === 'failed')))) {
    set(c, 'dropped', now, 'dropped'); return { ok: true, card: c }
  }
  if (action === 'retry' && c.state === 'failed') return { ok: true, card: requeue(j, c, now) }
  if (action === 'keep' && capture && c.state === 'queued') { set(c, 'kept', now, 'kept, not sent'); return { ok: true, card: c } }
  if (action === 'first' && capture && c.state === 'queued') {
    c.order = Math.min(c.order, ...j.cards.filter((x) => x.state === 'queued' && x !== c).map((x) => x.order - 1))
    c.rev += 1; c.at = now
    return { ok: true, card: c }
  }
  if (action === 'edit' && capture && c.state === 'draft' && typeof body === 'string') {
    // the same text again (an edit whose answer was lost, sent again at confirm) keeps the time it was made
    const text = body.slice(0, 20_000)
    c.payload = { ...c.payload!, edited: text, editedAt: text === c.payload?.edited && c.payload.editedAt ? c.payload.editedAt : now }; c.rev += 1; c.at = now
    return { ok: true, card: c }
  }
  // a note written in its read-back after it ended: added under what it recorded (before it is sent)
  // (sent as { id, text }: the same note sent again - its answer lost - is kept once)
  if (action === 'note' && capture && c.state === 'draft' && typeof body === 'string' && body.trim()) {
    let n: { id?: string; text: string; order?: number } = { text: body }
    try {
      const o = JSON.parse(body)
      if (o && typeof o.text === 'string') n = { ...(typeof o.id === 'string' && /^n-[a-z0-9]{6,24}$/.test(o.id) ? { id: o.id } : {}), text: o.text, ...(Number.isFinite(o.order) ? { order: Number(o.order) } : {}) }
    } catch { /* plain words */ }
    const text = n.text.trim().slice(0, 4000)
    const was = n.id ? c.payload?.added?.find((a) => a.id === n.id) : undefined
    if (was) {
      // the same note again: as it is in the field now (edited after its answer was lost: the new words)
      if (text && was.text !== text) { c.payload = { ...c.payload!, added: c.payload!.added!.map((a) => (a === was ? { ...a, text } : a)) }; c.rev += 1; c.at = now }
      return { ok: true, card: c }
    }
    if (text && (c.payload?.added?.length ?? 0) < 50) {
      // in the order they were written (a note sent again after a failure keeps its place before later ones)
      const added = [...(c.payload?.added ?? []), { at: n.order ?? now, text, ...(n.id ? { id: n.id } : {}) }].sort((a, b) => a.at - b.at)
      c.payload = { ...c.payload!, added }; c.rev += 1; c.at = now
      return { ok: true, card: c }
    }
  }
  // a capture's title as you name it (empty: its first words again) - the lane and the review show it;
  // what the agent reads never changes by it
  if (action === 'rename' && (capture || c.kind === 'wrapup') && c.state !== 'dropped' && typeof body === 'string') {
    const name = body.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (name) c.name = name; else delete c.name
    c.rev += 1; c.at = now
    return { ok: true, card: c }
  }
  if (action === 'later' && c.state === 'review') return { ok: true, card: c }
  // confirm, keep from the read-back, good and more are recoverable steps the daemon runs (daemon.ts)
  return { ok: false, card: c, error: `${action} is not allowed on this card` }
}

// ---- claiming ------------------------------------------------------------------------------------

/** The text of one message as the owner wrote it: for an owner event, its body or its latest
 *  LEDGERED edit (an edit that arrived by sync is never the owner's text); for anyone else, the
 *  latest edit as replay shows it. */
export function textOf(ctx: Ctx, board: string, events: CommentEvent[], ev: CommentEvent, owner: boolean): { body: string; rev: string } {
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
export function freezeBrief(j: Journal, ctx: Ctx, c: Card, events: CommentEvent[], others = true): Brief {
  const inThread = c.thread ? events.filter((e) => (e.type === 'create' && e.commentId === c.thread) || (e.type === 'reply' && e.parentId === c.thread)) : []
  // owner-only (spec 29b, Part 8; `jam.others: false`): every runner has the shell, MCP servers and skills
  // now, so only the owner's own words reach it - their ledgered messages and Marver's own replies (written
  // as this machine's owner). Left out here, before anything is frozen, so nothing left out is ever marked
  // read (`covered`).
  const me = others ? undefined : localProfile(ctx.root)
  // (Marver's replies carry this machine's profile - its email, or with none set, its name and no email)
  const mine = (a: CommentEvent['author']) => !!me && (me.email ? a?.email === me.email : !a?.email && a?.name === me.name)
  const msgs = others ? inThread : inThread.filter((e) => c.events.includes(e.id) || (!e.agent && isOwned(ctx, c.board, e.id)) || (!!e.agent && mine(e.author)))
  const dropped = new Set(j.cards.filter((x) => x.board === c.board && x.state === 'dropped').flatMap((x) => x.events))
  const asks = new Set(c.events)
  const toMsg = (e: CommentEvent): Msg => {
    const owner = !e.agent && isOwned(ctx, c.board, e.id)
    const { body, rev } = textOf(ctx, c.board, events, e, owner)
    const note = !owner && !e.agent ? 'someone else - context only'
      : owner && !asks.has(e.id) && dropped.has(e.id) ? 'dropped - not an ask' : undefined
    if (owner) j.covered[e.id] = rev
    return { id: e.id, ...(e.author?.name ? { author: sanitize(e.author.name, 80) } : {}), ...(e.agent ? { agent: true } : {}),
      ...(owner ? { owner: true, rev } : {}), ...(owner && rev !== e.id ? { edited: events.find((x) => x.id === rev)?.ts ?? e.ts } : {}),
      body: sanitize(body, Infinity), ts: e.ts, ...(note ? { note } : {}) }   // whole: the packet is a file, and a cut ask can lose its last constraint
  }
  const brief: Brief = {
    asks: c.events.map((id) => msgs.find((e) => e.id === id) ?? events.find((e) => e.id === id)).filter((e): e is CommentEvent => !!e).map(toMsg),
    history: msgs.filter((e) => !asks.has(e.id)).map(toMsg),
  }
  // every card on a capture's thread carries the capture: its record, your edit, the run it reviewed -
  // as context ("kept - not an ask") once the capture itself was kept or dropped
  if (c.capture) {
    const capCard = j.cards.find((x) => x.id === c.capture)
    const cap = readCapture(ctx.root, c.capture)
    if (cap && capCard?.payload) {
      const note = capCard !== c && capCard.state === 'kept' ? 'kept - not an ask' : capCard !== c && capCard.state === 'dropped' ? 'dropped - not an ask' : undefined
      brief.capture = { record: cap.record, recordHash: cap.hash, ...(capCard.payload.edited !== undefined ? { edited: capCard.payload.edited, ...(capCard.payload.editedAt ? { editedAt: capCard.payload.editedAt } : {}) } : {}), ...(capCard.payload.added?.length ? { added: capCard.payload.added } : {}),
        ...(capCard.payload.reviewed ? { reviewed: capCard.payload.reviewed } : {}), ...(note ? { note } : {}) }
    }
  }
  if (c.kind === 'wrapup') {
    const w = readWrapup(ctx.root, wrapupOf(c))
    if (w) brief.wrapup = { content: w.wrapup, hash: w.hash }
  }
  const followed = c.follows ? j.cards.find((x) => x.id === c.follows) : undefined
  // a run is named by its batch: the card's current one, or - requeued or merged since - its last in `ran`
  const lastRun = (x: Card) => x.batch ?? x.ran?.[x.ran.length - 1]
  // the earlier asks a follow-up copies are checked again, now: a ledger that lost one, or a revision
  // that is not that message's, never reaches the agent through `follows`
  const keep = (asks: Msg[] | undefined) => (asks ?? []).filter((a) => stillOwned(ctx, c.board, events, a))
  // a card run again (Retry, More work) reads its OWN previous run first; a first run reads what it follows
  if (followed && !c.ran?.length) {
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

/** A brief frozen with other people's words (before 0.28, or with `jam.others` on), made owner-only: the owner's
 *  own messages and Marver's own replies stay; everyone else's, and anything whose author is not known, go. */
export function ownerOnly(brief: Brief, me: { name: string }): Brief {
  const keep = (m: Msg) => !!m.owner || (!!m.agent && m.author === me.name)
  const asks = (l: Msg[]) => l.filter((m) => !!m.owner)
  const cap = brief.capture
  return {
    ...brief, history: brief.history.filter(keep), asks: asks(brief.asks),
    // every place a message can hide: the ask this one follows, and the run a capture reviewed
    ...(brief.follows ? { follows: { ...brief.follows, asks: asks(brief.follows.asks) } } : {}),
    ...(cap?.reviewed ? { capture: { ...cap, reviewed: { ...cap.reviewed, asks: asks(cap.reviewed.asks) } } } : {}),
  }
}

/** Are a card's asks still the owner's? Each must be in its board's log and ledgered; the ones that
 *  are not are dropped, and a card with none left is dropped ("no longer authorized"). */
/** Is a capture still what was ledgered at confirm - its sealed record's hash and the confirmed edit?
 *  Checked for EVERY card that carries the capture (a tag on its thread included), at claim and at
 *  resume: a record or an edit changed afterwards never reaches the agent. */
export function captureIntact(j: Journal, ctx: Ctx, capId: string): boolean {
  const capCard = j.cards.find((x) => x.id === capId && x.kind === 'capture')
  const cap = readCapture(ctx.root, capId)
  return !!capCard?.payload && !!cap && cap.hash === capCard.payload.recordHash && isOwned(ctx, capCard.board, payloadKey(capCard))
}

/** A wrap-up's content is the one sealed: its file hashes to what the card holds, and that is ledgered. */
export function wrapupIntact(ctx: Ctx, c: Card): boolean {
  const w = readWrapup(ctx.root, wrapupOf(c))
  return !!w && !!c.payload && w.hash === c.payload.recordHash && isOwned(ctx, c.board, `wrapup:${w.wrapup.id}:${w.hash}`)
}
/** The wrap-up content a card writes from (a More work card writes from the same, its note added). */
export const wrapupOf = (c: Card): string => c.id

function validate(ctx: Ctx, c: Card, events: CommentEvent[], now: number, j?: Journal): boolean {
  if (c.capture && j && !captureIntact(j, ctx, c.capture)) {
    set(c, 'failed', now, 'the capture changed after it was confirmed - capture it again')
    return false
  }
  if (c.kind === 'capture') {
    const ok = c.events.every((id) => isOwned(ctx, c.board, id) && events.some((e) => e.id === id))
    if (!ok) set(c, 'failed', now, 'an ask on this capture is no longer the owner\'s')
    return ok
  }
  if (c.kind === 'wrapup') {
    // its sealed content, as ledgered: changed after the seal, it never reaches the agent
    if (!wrapupIntact(ctx, c)) { set(c, 'failed', now, 'the session record changed after it was written - write it again'); return false }
    const w = readWrapup(ctx.root, c.id)
    const unsafe = w && recordPathProblem(ctx.root, w.wrapup.file)
    if (unsafe) { set(c, 'failed', now, `the record's file is not safe to write: ${unsafe}`); return false }
    return true
  }
  if (c.kind !== 'comment') return true
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
  /** other people's words reach the agent (`jam.others`; absent: they do, as context) */
  others?: boolean
  /** F4: the runs holding `frame` when a new request may share it - every one of them held by the session that takes
   *  the work now - else null: it waits for the frame. A request back from a run that left its session never shares */
  share?(frame: string): string[] | null
  /** how many runs that session can still take (a shared run must go to it) */
  shareRoom?: number
  /** that session's incarnation: what a shared run is formed for */
  sharer?: { conn: string; inc: string }
}

/** Claim what can run now: the queued cards of one board on one single frame join one batch, in
 *  run order, up to 8; a card naming several frames runs alone and waits for all of them; a card
 *  with no frame, or one that must edit a shared file, runs exclusive - alone, once nothing runs and
 *  no hold is left, and while it waits nothing new starts. Briefs are frozen, cards turn working,
 *  and each packet is written to its file. Returns the new batches (already in the journal). */
export function form(j: Journal, ctx: Ctx, o: FormOpts, now = Date.now()): { batches: Batch[]; exclusiveWaiting: boolean } {
  const logs = new Map<string, CommentEvent[]>()
  const log = (board: string) => { let l = logs.get(board); if (!l) logs.set(board, (l = readLog(ctx.dir, board))); return l }
  // an exclusive card that is no longer the owner's is dropped first - it must not hold the queue back
  for (const c of j.cards) if (c.state === 'queued' && (c.exclusive || !c.frames.length)) validate(ctx, c, log(c.board), now, j)
  const queued = j.cards.filter((c) => c.state === 'queued').sort((a, b) => a.order - b.order || a.made - b.made)
  const exclusive = queued.filter((c) => c.exclusive || !c.frames.length)
  type Forming = { board: string; frames: string[]; cards: Card[]; exclusive?: boolean; single: boolean; overlaps?: string[] }
  const forming: Forming[] = []
  if (exclusive.length) {
    if (o.exclusiveRunning || o.running.size || o.anyHold() || o.free < 1) return { batches: [], exclusiveWaiting: !o.exclusiveRunning }
    const c = exclusive[0]
    forming.push({ board: c.board, frames: [...c.frames], cards: [c], exclusive: true, single: false })
  } else if (!o.exclusiveRunning) {
    const reserved = new Set(o.running)
    // frames a batch of this pass took: never shared within it (a second request on one joins it, or waits)
    const formedNow = new Set<string>()
    let room = o.shareRoom ?? 0
    // F4: a frame a run of the session taking the work holds may be shared - offered to that session, which decides
    const sharable = (c: Card, f: string) => !c.alone && !formedNow.has(f) && !!o.share?.(f)
    for (const c of queued) {
      if (c.frames.length === 1) {
        const f = c.frames[0]
        // (one back from a run that left its session never joins a run formed beside another)
        const join = forming.find((b) => b.single && b.board === c.board && b.frames[0] === f && b.cards.length < MAX_MEMBERS && !(c.alone && b.overlaps))
        if (join) { if (validate(ctx, c, log(c.board), now, j)) join.cards.push(c); continue }
        const shared = reserved.has(f) && room > 0 && sharable(c, f)
        if ((reserved.has(f) && !shared) || o.held(f) || forming.length >= o.free) continue
        if (!validate(ctx, c, log(c.board), now, j)) continue
        forming.push({ board: c.board, frames: [f], cards: [c], single: true, ...(shared ? { overlaps: o.share!(f)! } : {}) })
        if (shared) room -= 1
        reserved.add(f); formedNow.add(f)
      } else {
        const busy = c.frames.filter((f) => reserved.has(f))
        const shared = busy.length > 0 && room > 0 && busy.every((f) => sharable(c, f))
        if ((busy.length && !shared) || c.frames.some((f) => o.held(f)) || forming.length >= o.free) continue
        if (!validate(ctx, c, log(c.board), now, j)) continue
        forming.push({ board: c.board, frames: [...c.frames], cards: [c], single: false, ...(shared ? { overlaps: [...new Set(busy.flatMap((f) => o.share!(f)!))] } : {}) })
        if (shared) room -= 1
        for (const f of c.frames) { reserved.add(f); formedNow.add(f) }
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
      const brief = freezeBrief(j, ctx, c, log(c.board), o.others !== false)
      const id = `m${members.length + 1}`
      c.brief = brief; c.batch = batchId
      set(c, 'working', now)
      members.push({ id, card: c.id, board: c.board, brief })
      const t = c.thread ? threads.find((x) => x.id === c.thread) : undefined
      packetMembers.push({ id, card: c.id, kind: c.kind, board: c.board, ...(c.thread ? { thread: c.thread } : {}), frames: c.frames,
        ...(t?.anchor !== undefined ? { anchor: t.anchor } : {}), brief })
    }
    const files = f.exclusive ? [...new Set(f.cards.flatMap((c) => c.exclusive ?? []))] : undefined
    // back from a run that left its session (F4): it runs as it was going to - spawned, saying why - and goes on from
    // where that run was, as a retry of it would: the frames it made are this run's (pictured as new), and its review
    // starts from that run's pictures from before any edit - never retaken after the partial work (a frame that run did
    // not picture is pictured after, as a retry pictures one whose before-picture failed)
    const back = f.cards.find((c) => c.alone?.spawn)?.alone
    const created = [...new Set(f.cards.flatMap((c) => c.alone?.created ?? []))].filter((x) => f.frames.includes(x))
    const kept = new Map<string, string>()
    for (const s of f.cards.flatMap((c) => c.alone?.shots ?? [])) if (f.frames.includes(s.frame) && !kept.has(s.frame)) kept.set(s.frame, s.before)
    // (frames it made and no picture kept - its before-picture had failed: still listed, so the frames it made read as new,
    // never pictured as a "before")
    const shots = kept.size || created.length ? f.frames.filter((x) => !created.includes(x)).map((x) => ({ frame: x, ...(kept.has(x) ? { before: kept.get(x)! } : {}) })) : undefined
    for (const c of f.cards) delete c.alone
    const b: Batch = { batchId, members, frames: f.frames, ...(f.exclusive ? { exclusive: true } : {}), state: 'claimed', leaseUntil: 0, attempts: 0, at: now, others: o.others !== false,
      ...(f.overlaps?.length && o.sharer ? { overlaps: f.overlaps, share: { ...o.sharer } } : {}),
      ...(back ? { handoff: 'spawn' as const, ...(back.why ? { handoffWhy: back.why } : {}) } : {}),
      ...(created.length ? { created } : {}), ...(shots ? { shots } : {}) }
    j.batches.push(b)
    writePacket(ctx.root, buildPacket(batchId, packetMembers, f.frames, f.exclusive ? files : undefined), new Set(j.batches.filter((x) => x.state === 'claimed').map((x) => x.batchId)))
    batches.push(b)
  }
  return { batches, exclusiveWaiting: exclusive.length > 0 && batches.length === 0 }
}

/** What a card waiting again carries from the runs that left it (F4) - joined, never replaced: a second run let go into the
 *  same card (a follow-up on its thread) adds the frames it made, and a frame's picture from before any edit is the
 *  first one kept (Codex's review: the second requeue replaced the first's, and its review started from partial work). */
export function joinAlone(was: Card['alone'], add: NonNullable<Card['alone']>): NonNullable<Card['alone']> {
  const created = [...new Set([...(was?.created ?? []), ...(add.created ?? [])])]
  const shots = [...(was?.shots ?? [])]
  for (const x of add.shots ?? []) if (!shots.some((y) => y.frame === x.frame)) shots.push({ ...x })
  const why = was?.why ?? add.why
  return { ...(was?.spawn || add.spawn ? { spawn: true as const } : {}), ...(why ? { why } : {}), ...(created.length ? { created } : {}), ...(shots.length ? { shots } : {}) }
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
  for (const m of b.members) settleOne(j, b, m, posted[m.id] ?? {}, now, out)
  b.state = 'done'; b.at = now
  return out
}

/** Move one member's card by its result (see `settle`). */
function settleOne(j: Journal, b: Batch, m: Member, p: { reply?: string; answered?: boolean; asked?: number }, now: number, out: Settled[]) {
  const c = j.cards.find((x) => x.id === m.card)
  const r: Result | undefined = b.results?.[m.id]
  if (!c || c.state !== 'working' || c.batch !== b.batchId || !r) return
  if ('body' in r) {
    if (p.reply) c.reply = p.reply
    if (c.resolved) set(c, 'done', now, 'replied')
    else if (r.asks && p.answered) set(c, 'done', now, 'answered')
    // a session record has no thread to ask in: it always comes back to review (More work answers it)
    else if (c.kind === 'wrapup') set(c, 'review', now, 'ready to review')
    else if (r.asks) { c.asked = p.asked ?? now; set(c, 'asks', now, 'asks you'); out.push({ card: c, notice: 'asks' }); return }
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

/** Results saved, posting failed for good: the cards show failed - Retry posts the saved replies - and
 *  the batch stays claimed with its results, so a boot reconciles it too. Never a rerun. */
export function undelivered(j: Journal, b: Batch, note: string, now = Date.now()): Settled[] {
  const out: Settled[] = []
  for (const m of b.members) {
    const c = j.cards.find((x) => x.id === m.card)
    if (!c || c.state !== 'working' || c.batch !== b.batchId) continue
    const r = b.results?.[m.id]
    // a result with nothing to post (a `shared` answer, a missing one) settles now - its exclusive
    // rerun exists before anything else may start; only a reply that could not be posted waits
    if (r && !('body' in r)) settleOne(j, b, m, {}, now, out)
    else { set(c, 'failed', now, note); out.push({ card: c, notice: 'failed' }) }
  }
  b.undelivered = true; b.at = now
  return out
}

/** A batch whose replies are posted again (Retry, or a boot): its failed cards go back to working. */
export function redelivering(j: Journal, b: Batch, now = Date.now()) {
  for (const m of b.members) {
    const c = j.cards.find((x) => x.id === m.card)
    const r = b.results?.[m.id]
    // only a reply that was never posted goes back: a missing answer stays failed (its Retry reruns)
    if (c && c.state === 'failed' && c.batch === b.batchId && r && 'body' in r) set(c, 'working', now, '')
  }
  b.undelivered = false
}

/** Forget finished cards and batches after a week, unless a live card follows one. */
export function prune(j: Journal, now = Date.now()) {
  // a live card keeps what it reads: the card it follows, its runs - and the capture it carries
  const needed = new Set(j.cards.filter(pending).flatMap((c) => [c.follows, ...(c.ran ?? []), c.batch, c.capture]).filter(Boolean) as string[])
  // a capture's own card is kept for good: a tag on its thread, written any time later, reads its
  // payload, frames and edit from it (one small card per capture)
  j.cards = j.cards.filter((c) => pending(c) || c.kind === 'capture' || c.at > now - KEEP_MS || needed.has(c.id))
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
    for (const b of v1.batches.filter((x) => x.board === board)) {
      const id = b.memberEventIds[0]
      const ev = events.find((e) => e.id === id)
      if (!ev) continue
      if (b.state === 'pending' || b.state === 'claimed') unfinished.add(id)
      const thread = threadId(ev)
      const frame = ev.frame ?? frames.get(thread)
      // v1 skipped its final reply when it matched the early one: then the early line IS the final
      const final = events.find((e) => e.id === `jam-${b.batchId}`)
        ?? (b.state === 'done' ? [...events].reverse().find((e) => new RegExp(`^jam-e\\d+-${b.batchId}$`).test(e.id)) : undefined)
      const tag = MENTION.test(ev.body ?? '') && isOwned(ctx, board, id)
      const card = (state: CardState, note: string): Card => ({
        id: `c-${id}`, kind: 'comment', board, frames: frame ? [frame] : [], thread, events: [id], state, note,
        batch: b.batchId, made: ev.ts, order: ev.ts, rev: 1, at: now,
      })
      if (final) {
        // a question the owner already answered (a ledgered reply after it) is done, not asking
        const answered = events.some((e) => e.type === 'reply' && e.parentId === thread && !e.agent && e.ts > final.ts && isOwned(ctx, board, e.id))
        // the message as it stands: v1 flags an early question by a later edit (`asks: true`)
        const shown = replay(events).find((x) => x.id === thread)?.replies.find((r) => r.id === final.commentId)
        const asks = !answered && (shown?.asks ?? final.asks ?? /\?\s*$/.test(final.body ?? ''))
        j.cards.push({ ...card(asks ? 'asks' : 'done', asks ? 'asks you' : answered ? 'answered' : 'replied'), reply: final.commentId, ...(asks ? { asked: final.ts } : {}) })
        j.batches.push({ batchId: b.batchId, members: [{ id: 'm1', card: `c-${id}`, board }], frames: frame ? [frame] : [], state: 'done', leaseUntil: 0,
          attempts: b.attempts, results: { m1: { body: final.body ?? '', asks, reanchors: [] } }, posted: true, at: now })
        continue
      }
      if (b.state === 'done') continue   // finished with no final in the log: nothing left to show
      if (b.state === 'claimed' && b.pgid) fence.push(b.pgid)
      if (!tag) continue
      j.cards.push(card('failed', b.state === 'failed' ? 'the agent could not finish - Retry' : 'interrupted by the upgrade - Retry'))
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

// ---- captures --------------------------------------------------------------------------------------

/** The ledger key that binds a confirmed capture's payload: its record hash and your edit. */
export const payloadKey = (c: Card): string => `cap:${c.id}:${hashOf({ recordHash: c.payload?.recordHash ?? '', edited: c.payload?.edited ?? null, ...(c.payload?.added?.length ? { added: c.payload.added } : {}) })}`   // no edit and an empty edit differ; notes added after, when any

/** A sealed capture becomes a draft card (once - a second post finds it). A capture made during a
 *  review follows the reviewed card and keeps the run it saw (`reviewing`). */
export function addCapture(j: Journal, record: CaptureRecord, hash: string, now = Date.now()): Card {
  const have = j.cards.find((c) => c.id === record.id)
  if (have) return have
  // Resume: this record continues a draft ended too soon - it takes the draft's place (its spot on the
  // lane, its name, your edit with the new words after it) and the draft leaves. A draft already
  // decided (confirmed, kept, dropped) is not taken: the record is then a capture of its own.
  const rs = record.context.resumes
  // what it carries on from (your edit, its name, the review it followed) - whatever became of it - and
  // the draft it replaces, only while that is still a draft
  const src = rs ? j.cards.find((c) => c.id === rs.id && c.kind === 'capture' && c.board === record.context.board) : undefined
  const prev = src?.state === 'draft' ? src : undefined
  const made = prev?.made ?? (madeOf(record.id) || now)
  // a capture follows a capture's review only (never a session record, never a tag's card)
  const r0 = record.context.reviewing ?? src?.reviewing
  const r = r0 && j.cards.find((x) => x.id === r0.card)?.kind === 'capture' ? r0 : undefined
  const more = src?.payload?.edited !== undefined && rs ? wordsSince(record, rs.at) : ''
  const edited = src?.payload?.edited !== undefined ? [src.payload.edited.trim(), more].filter(Boolean).join('\n') : undefined
  const c: Card = {
    // a resumed capture keeps every frame the recording it continues was about (that card's frames - a chain
    // of resumes carries them all), beside the new part's
    id: record.id, kind: 'capture', board: record.context.board, frames: [...new Set([...(src?.frames ?? []), ...captureFrames(record)])], capture: record.id, events: [],
    state: 'draft', made, order: prev?.order ?? made, rev: 1, at: now, payload: { recordHash: hash, ...(edited !== undefined ? { edited } : {}), ...(src?.payload?.added?.length ? { added: src.payload.added } : {}) },
    ...(r ? { reviewing: r, follows: r.card } : {}), ...(src?.name ? { name: src.name } : {}),
    // a capture of the session running now: in its record. One whose session has ended (it reached the server
    // only after the record was written - the page is told) stands on its own
    ...(record.context.session && j.session?.id === record.context.session ? { session: record.context.session } : {}),
  }
  if (prev) set(prev, 'dropped', now, `resumed as ${record.id}`)
  j.cards.push(c)
  touchRun(j, now)
  return c
}

/** The comment a capture writes at confirm: its words as confirmed (cut at 600 characters - the full
 *  text stays in the record), its facts, the capture it stands for; pinned on the first point, else
 *  its first frame, else the board. Deterministic ids, so a resumed confirm writes it once. */
export function captureComment(c: Card, record: CaptureRecord, at: { frame?: string; anchor?: unknown }, author: CommentEvent['author'], now = Date.now()): CommentEvent {
  const words = requestWords({ record, edited: c.payload?.edited, added: c.payload?.added })
  return {
    id: `cap-${c.id}-e`, ts: now, type: 'create', commentId: `cap-${c.id}`, board: c.board, author,
    body: (words.length > 600 ? words.slice(0, 599) + '…' : words) || '(a capture with no words)',
    capture: c.id, facts: factsOf(record),
    ...(at.frame ? { frame: at.frame } : {}), ...(at.anchor !== undefined ? { anchor: at.anchor } : {}),
  }
}

/** Begin a recoverable step on a card: the exact comment it will write is in the journal first. */
export function beginStep(j: Journal, c: Card, op: 'confirm' | 'more', event: CommentEvent, now = Date.now(), end?: 'queued' | 'kept') {
  c.pending = { op, event, ...(end ? { end } : {}) }
  if (op === 'confirm') {
    c.state = 'confirming'
    // the run this capture reviewed, frozen once into its payload (`payload.reviewed`)
    const r = c.reviewing && j.batches.find((b) => b.batchId === c.reviewing!.batch)
    const m = r && r.members.find((x) => x.card === c.reviewing!.card)
    if (m && !c.payload?.reviewed) c.payload = { ...c.payload!, reviewed: { asks: m.brief?.asks ?? [], result: resultText(j, r!.batchId, m.card, r!.note ?? ''),
      ...(m.brief?.capture ? { capture: { record: m.brief.capture.record, recordHash: m.brief.capture.recordHash, ...(m.brief.capture.edited !== undefined ? { edited: m.brief.capture.edited } : {}), ...(m.brief.capture.added?.length ? { added: m.brief.capture.added } : {}) } } : {}) } }
  }
  c.rev += 1; c.at = now
}

/** Did a comment already in the log under the step's id say exactly what the step would write? */
/** An event as stable text: every field, keys sorted at every depth - except `ts`, when it was written. */
const canon = (e: CommentEvent): string => {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v)
  const { ts: _ts, ...rest } = e
  return JSON.stringify(sort(rest))
}
/** Did a comment already in the log under the step's id say EXACTLY what the step would write - every
 *  field that matters, not just its words? Anything else fails closed. (`ts` is when it was written.) */
export const sameComment = (a: CommentEvent, b: CommentEvent): boolean => canon(a) === canon(b)

/** A step whose comment is written and ledgered ends: a confirm leaves the card queued (or kept), on
 *  its thread - and a capture made during a review sends that review back as More work, if the card
 *  is still in review from the run the capture saw, at the rev it saw (no @marver reply: this card is
 *  the one job). More work puts the SAME card back, first, with your words as its follow-up ask. */
export function endStep(j: Journal, c: Card, now = Date.now()): Settled[] {
  const p = c.pending
  if (!p) return []
  c.pending = undefined
  if (p.op === 'confirm') {
    c.thread = p.event.commentId
    set(c, p.end ?? 'queued', now, p.end === 'kept' ? 'kept, not sent' : undefined)
    if (p.end !== 'kept' && c.reviewing) {
      const r = j.cards.find((x) => x.id === c.reviewing!.card)
      if (r && r.kind === 'capture' && r.state === 'review' && r.batch === c.reviewing.batch && r.rev === c.reviewing.rev) { r.verdict = 'more work'; set(r, 'done', now, 'more work') }
    }
    touchRun(j, now)
    return [{ card: c }]
  }
  c.events = [...c.events, p.event.id]
  c.when = { ...c.when, [p.event.id]: p.event.ts }
  c.verdict = 'more work'
  return [{ card: requeue(j, c, now, true) }]
}

/** A step that found another comment in its place fails closed: nothing is ledgered, the card goes
 *  back to where it was, and says so. */
export function conflictStep(j: Journal, c: Card, now = Date.now()) {
  const p = c.pending
  c.pending = undefined
  set(c, p?.op === 'confirm' ? 'draft' : 'review', now, 'a conflicting comment took this one\'s place - write it again')
}

/** Looks good: done, and its thread resolved - unless a newer card on the thread is open, or an owner
 *  reply or edit arrived after its frozen brief (that answer stays open, on the answered list). */
export function looksGood(j: Journal, ctx: Ctx, c: Card, events: CommentEvent[], now = Date.now()): { resolve: boolean } {
  const newer = j.cards.some((x) => x !== c && x.board === c.board && x.thread === c.thread && pending(x) && x.made > c.made)
  // what the frozen brief copied: those messages, at those revisions
  const frozen = new Map([...(c.brief?.asks ?? []), ...(c.brief?.history ?? [])].map((m) => [m.id, m.rev ?? m.id]))
  // an owner message in this thread the brief never copied, or one whose latest ledgered revision is
  // not the one it copied (edited since - however many times before)
  const after = events.some((e) => {
    if (e.agent || !isOwned(ctx, c.board, e.id)) return false
    const inThread = (e.type === 'create' && e.commentId === c.thread) || (e.type === 'reply' && e.parentId === c.thread)
    if (!inThread) return false
    if (!frozen.has(e.id)) return e.type === 'reply'
    return textOf(ctx, c.board, events, e, true).rev !== frozen.get(e.id)
  })
  c.verdict = 'looks good'
  set(c, 'done', now, 'looks good')
  touchRun(j, now)
  return { resolve: !!c.thread && !newer && !after }
}

// ---- sessions (Part 5) ------------------------------------------------------------------------------

/** Start a session (once: one runs at a time). */
export function startSession(j: Journal, id: string, now = Date.now()): { id: string; since: number } {
  if (!j.session) { j.session = { id, since: now }; touchRun(j, now) }
  return j.session
}
/** End the session running (if it is `id`): the run then lasts while its captures are pending. */
export function endSession(j: Journal, id: string, now = Date.now()): boolean {
  if (j.session?.id !== id) return false
  j.session = undefined
  touchRun(j, now)
  return true
}
/** A sealed wrap-up becomes a queued card - the run's last tile; it writes the session's record. */
export function addWrapup(j: Journal, w: Wrapup, hash: string, board: string, now = Date.now()): Card {
  const have = j.cards.find((c) => c.id === w.id)
  if (have) return have
  const c: Card = {
    id: w.id, kind: 'wrapup', board, frames: [], events: [], state: 'queued', made: now, order: now, rev: 1, at: now,
    payload: { recordHash: hash }, session: w.session, name: 'Session record',
  }
  j.cards.push(c)
  touchRun(j, now)
  return c
}
/** More work on a record: a new record job from its own sealed wrap-up (the first's content, your note
 *  added, the same file) follows the record it improves, which is done. */
export function moreWrapup(j: Journal, prev: Card, w: Wrapup, hash: string, now = Date.now()): Card {
  const c: Card = {
    id: w.id, kind: 'wrapup', board: prev.board, frames: [], events: [], state: 'queued',
    made: now, order: now, rev: 1, at: now, follows: prev.id,
    payload: { recordHash: hash }, session: prev.session, name: 'Session record',
  }
  prev.verdict = 'more work'
  set(prev, 'done', now, 'more work')
  j.cards.push(c)
  touchRun(j, now)
  return c
}

/** The lane's run: the captures made since the lane last appeared. It lasts while any of them is
 *  pending (or a session runs - M4) and ends when every one is done, kept or dropped. */
export function touchRun(j: Journal, now = Date.now()) {
  const lane = j.cards.filter((c) => c.kind === 'capture' || c.kind === 'wrapup')
  const live = lane.filter((c) => pending(c))
  // a session holds the run open from its start, whatever is pending (its captures stay on the lane)
  if (j.session) { j.run = { since: Math.min(j.run?.since ?? Infinity, j.session.since, ...live.map((c) => c.made)) }; return }
  if (!j.run && live.length) j.run = { since: Math.min(...live.map((c) => c.made)) }
  else if (j.run && !live.length) j.run = undefined
  // an older capture that sealed later (S -> S, its pictures slower) is still in the run
  else if (j.run && live.length) j.run = { since: Math.min(j.run.since, ...live.map((c) => c.made)) }
  void now
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
export function createQueue(root: string, onUpgrade?: (fence: number[]) => void, alive: () => boolean = () => true): Queue {
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
        // a stopped daemon neither ingests nor writes: its server may already have a successor
        if (!alive()) throw new Error('jam stopped')
        ctx = ctxFor(root)
        if (ingest(j, ctx)) write(root, j)
        const out = await fn(j, ctx)
        touchRun(j)   // the lane's run follows every change
        return out
      })
      tail = run.catch(() => {})
      return run
    },
    persist() { if (alive()) write(root, j) },
  }
}
