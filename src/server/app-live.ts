/**
 * The live stream (spec 28 A4.1, A4.6 #4-#15): what waits on the owner in this canvas, for the Mac app's marks and
 * notices. `GET /__mv/app/live` is an event stream of whole snapshots (`LiveEvent` v1, src/shared/app-api.ts), proved
 * both ways - the request by `x-mv-app`, the answer by `liveProof` over the app's fresh nonce - so only the slot key's
 * holder is answered, and a listener that took the port after a canvas stopped can never put words into a notice.
 *
 * Four parts, each pure or nearly: the selector `liveSnapshot(input)` (#7-#11), the id hash (#9), the encoder with its
 * byte budget (#11, r1 #4), and the hub `createLiveHub` with its clients (#14), behind the route `liveRoute` (#5, #6).
 * The adapters that read the real sources - the comment logs, the marks, the Jam view, `marver work`'s leases - stay in
 * plugin.ts as the hub's `read()`. Erasable TypeScript, no Vite, only `node:crypto`, `./proof.ts` and the shared
 * contracts: the Mac app's fake canvas runs it under Node's type stripping over a scripted `read()`, so the app's cases
 * meet this code, not a copy (#4).
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { appProofOk, proofHeaders, type DocProof } from './proof.ts'
import { asks, type Thread } from '../shared/events.ts'
import { LIVE_BOUNDS, LIVE_TITLES_MAX, LIVE_WIRE, type LiveEvent, type LiveItem, type LiveKind } from '../shared/app-api.ts'
import type { QueueView } from './jam/live.ts'

/** A snapshot without what the hub adds (`v`, `instance`, `seq`). */
export type LiveBody = Omit<LiveEvent, 'v' | 'instance' | 'seq'>
type ViewCard = QueueView['cards'][number]

/** What the selector reads: one snapshot of the four sources (#7), each gathered by an adapter in plugin.ts. */
export interface LiveInput {
  /** each board's log replayed, by the log's own name */
  boards: { board: string; threads: Thread[] }[]
  /** the frames new to the owner (marks.ts `freshFrames`) */
  fresh: readonly string[]
  /** Jam's view, absent when Jam is off or another server holds the repo's Jam lock */
  jam?: QueueView
  /** the frames `marver work` holds (`workActivity.leases('cli')`) - never Jam's own leases (A4.6 r2 #3) */
  cli: readonly string[]
  /** spec 32 F2: since when `marver work` has held frames (work.ts `workClock.since()`), absent when it holds none */
  cliSince?: number
  /** spec 32 F2: the boards, by name, that pin a frame `marver work` holds (work.ts `pinningBoards`, no auto board) */
  pinning?: readonly string[]
  /** spec 32 F2: every board's title, by its name (boards.ts `boardFields().title`, as the manifest carries it) */
  titles?: Readonly<Record<string, string>>
  /** the time now (a test's clock); `Date.now()` when absent */
  now?: number
}

/**
 * Spec 32 F2: the time app-live first saw a working Jam card with no `startedAt` (an older batch never claimed), by its
 * card - what its run counts from then. Kept for the process, a card leaving work forgets it.
 */
const firstSeenWorking = new Map<string, number>()

// ---- the selector ---------------------------------------------------------------------------------------------

/** An item's id (#9): its kind and the first 20 hex of a sha256 over the occurrence's persisted parts, NUL-joined. */
export const liveId = (kind: LiveKind, ...parts: (string | number)[]): string =>
  `${kind}:${createHash('sha256').update(parts.map(String).join('\0')).digest('hex').slice(0, 20)}`

/** One line of at most `max` UTF-16 units: whitespace collapsed, control characters gone, never cut inside a pair. A
 *  log is data: a body that is not a string (a hand edit, a dev POST) reads as none, never stopping the stream. */
export function oneLine(s: string | undefined, max: number = LIVE_BOUNDS.title): string {
  const t = (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut
}

/** Every ref an item carries is at most `LIVE_BOUNDS.ref`: one past it can never be shown, so it is counted, never sent. */
const refsFit = (i: LiveItem): boolean =>
  [i.board, i.frame, i.thread, i.msg, i.batch, ...(i.cards ?? [])].every((r) => r === undefined || r.length <= LIVE_BOUNDS.ref)

const byMade = (a: ViewCard, b: ViewCard) => a.made - b.made || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const firstFrame = (c: ViewCard) => c.frames[0]

/**
 * What waits on the owner now (#7, #8, #10, #12): one item per need, newest first, at most `LIVE_BOUNDS.items`, with
 * exact counts. Pure and deterministic - the same input gives the same bytes. `ask` from the threads alone (a Jam card
 * in `asks` is the same question, carried as its target); `review`, `failed` and `stalled` from Jam's view, each
 * failed or stalled run one item; unseen frames a count; `working` from `marver work`'s leases and the runs at work.
 */
export function liveSnapshot(input: LiveInput): LiveBody {
  const view = input.jam
  const cards = view?.cards ?? []
  const threadOf = new Map<string, Thread>()
  for (const { board, threads } of input.boards) for (const t of threads) threadOf.set(`${board}\0${t.id}`, t)
  const items: LiveItem[] = []

  // ask (#8): open, Marver took part, its word last, and that word asks - a thread with no frame too (A4.6 r1 #3)
  for (const { board, threads } of input.boards) for (const t of threads) {
    if (t.resolved || !(t.agent || t.replies.some((r) => r.agent))) continue
    const last = t.replies.length ? t.replies[t.replies.length - 1] : t
    if (!last.agent || !asks(last, last === t)) continue
    const msg = last === t ? t.id : (last as Thread['replies'][number]).id
    const card = cards.filter((c) => c.state === 'asks' && c.board === board && c.thread === t.id).sort(byMade).map((c) => c.id)
    items.push({ id: liveId('ask', board, t.id, msg), kind: 'ask', board, title: oneLine(last.body), at: last.ts,
      ...(t.frame ? { frame: t.frame } : {}), thread: t.id, msg, ...(card.length ? { cards: card.slice(0, LIVE_BOUNDS.cards) } : {}) })
  }

  // a card's words: a capture's or a record's title, a comment card's thread root
  const titleOf = (c: ViewCard) => oneLine(c.kind === 'comment' ? (c.thread ? threadOf.get(`${c.board}\0${c.thread}`)?.body : undefined) ?? c.title : c.title)
  const thread = (c: ViewCard) => (c.kind === 'comment' && c.thread ? { thread: c.thread } : {})

  // review (#8, #9): each card waiting on your look, named by its card and how many times it entered review
  for (const c of cards.filter((x) => x.state === 'review').sort(byMade)) {
    const occ = c.att ?? 0
    items.push({ id: liveId('review', c.id, occ), kind: 'review', board: c.board, title: titleOf(c), at: c.at,
      ...(firstFrame(c) ? { frame: firstFrame(c) } : {}), ...thread(c), cards: [c.id], ...(c.batch ? { batch: c.batch } : {}), occ })
  }

  // failed (#10): a run's failed cards are one item, named by its batch and how many times it failed; a card that
  // failed with no run (refused before it ran: a requeued card has no batch, queue.ts requeue) its own, by its card and
  // its attempts. The batch alone says which: a journal from before the counters has none, and an absent one reads 0 (#9)
  const failed = new Map<string, ViewCard[]>()
  for (const c of cards.filter((x) => x.state === 'failed').sort(byMade)) {
    const k = c.batch ? `b\0${c.batch}` : `c\0${c.id}`
    failed.set(k, [...(failed.get(k) ?? []), c])
  }
  for (const [k, group] of failed) {
    const c = group[0]
    const run = k.startsWith('b\0')
    const occ = run ? c.fails ?? 0 : c.att ?? 0
    items.push({ id: run ? liveId('failed', c.batch!, occ) : liveId('failed', c.id, occ), kind: 'failed', board: c.board, title: titleOf(c),
      ...(c.note ? { note: oneLine(c.note, LIVE_BOUNDS.note) } : {}), at: Math.max(...group.map((x) => x.at)),
      ...(firstFrame(c) ? { frame: firstFrame(c) } : {}), ...thread(c), cards: group.map((x) => x.id).slice(0, LIVE_BOUNDS.cards),
      ...(run ? { batch: c.batch } : {}), occ })
  }

  // stalled (#8): a session run gone quiet waits on your choice - one item per run, by its batch, its claim and stalls
  const stalled = new Map<string, ViewCard[]>()
  for (const c of cards.filter((x) => x.state === 'working' && x.runner?.kind === 'session' && x.runner.state === 'stalled').sort(byMade)) {
    const k = c.runner!.batch
    stalled.set(k, [...(stalled.get(k) ?? []), c])
  }
  for (const [batch, group] of stalled) {
    const c = group[0]
    const gen = c.runner!.gen ?? 0, occ = c.runner!.stalls ?? 0
    items.push({ id: liveId('stalled', batch, gen, occ), kind: 'stalled', board: c.board, title: titleOf(c), at: Math.max(...group.map((x) => x.at)),
      ...(firstFrame(c) ? { frame: firstFrame(c) } : {}), ...thread(c), cards: group.map((x) => x.id).slice(0, LIVE_BOUNDS.cards), batch, gen, occ })
  }

  const counts = { ask: 0, review: 0, failed: 0, stalled: 0 }
  for (const i of items) counts[i.kind]++
  // newest first; ties by id, so the order never depends on the input's
  const shown = items.filter(refsFit).sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  // at work (#8): `marver work` holds a frame, or a Jam run runs - a background run, or a claimed one; a stalled,
  // offered, waiting or stopping one does not, whatever leases the daemon keeps for it meanwhile
  // (spec 32 F2: one whose run has not begun - it forms, takes its pictures before, or waits for a slot - is not either)
  const runsNow = cards.filter((c) => c.state === 'working' && !c.unstarted && (!c.runner || !c.runner.state || c.runner.state === 'claimed'))
  const working = input.cli.length > 0 || runsNow.length > 0
  const kept = shown.slice(0, LIVE_BOUNDS.items)
  const work = workOf(input, runsNow)
  const titles = titlesOf(input.titles, [...(work?.board ? [work.board] : []), ...kept.map((i) => i.board)])
  return {
    jam: view ? 'on' : 'off',
    items: kept,
    cut: Math.max(0, shown.length - LIVE_BOUNDS.items),
    counts,
    unseen: input.fresh.length,
    working,
    session: !!view?.session,
    ...(work ? { work } : {}),
    ...(titles ? { titles } : {}),
  }
}

/**
 * Spec 32 F2, `work`: since when something has been at work, and on which board. `since` is the earlier of `marver
 * work`'s clock and the oldest working run's start (its `startedAt`, else when it was first seen working); `board` the
 * newest working Jam card's board (the last made, then by id - never the latest run start), else the first board by name pinning a frame
 * the CLI holds; absent when nothing works.
 */
function workOf(input: LiveInput, runsNow: ViewCard[]): LiveEvent['work'] {
  const now = input.now ?? Date.now()
  const ids = new Set(runsNow.map((c) => c.id))
  for (const id of [...firstSeenWorking.keys()]) if (!ids.has(id)) firstSeenWorking.delete(id)
  const startOf = (c: ViewCard): number => {
    if (typeof c.startedAt === 'number') return c.startedAt
    let t = firstSeenWorking.get(c.id)
    if (t === undefined) firstSeenWorking.set(c.id, (t = now))
    return t
  }
  const cli = input.cli.length > 0 && typeof input.cliSince === 'number' ? input.cliSince : undefined
  const all = [...(cli !== undefined ? [cli] : []), ...runsNow.map(startOf)]
  if (!all.length) return undefined
  // the newest working card: the last made (a card's age, never its run's restart), then by id
  const newest = [...runsNow].sort((a, b) => b.made - a.made || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
  const board = newest?.board ?? (input.cli.length ? input.pinning?.[0] : undefined)
  return { ...(board && board.length <= LIVE_BOUNDS.ref ? { board } : {}), since: Math.min(...all) }
}

/** Spec 32 F2, `titles`: the titles of the boards named, in that order, each once - at most `LIVE_TITLES_MAX`, a key a
 *  ref (at most `LIVE_BOUNDS.ref`) and a value one line of at most `LIVE_BOUNDS.title`; absent when none has one. */
function titlesOf(all: LiveInput['titles'], boards: readonly string[]): Record<string, string> | undefined {
  if (!all) return undefined
  const out: Record<string, string> = {}
  let n = 0
  for (const b of boards) {
    if (n >= LIVE_TITLES_MAX) break
    if (Object.hasOwn(out, b) || b.length > LIVE_BOUNDS.ref || !Object.hasOwn(all, b)) continue
    const t = oneLine(all[b])
    if (!t) continue
    out[b] = t
    n++
  }
  return n ? out : undefined
}

// ---- the encoder ----------------------------------------------------------------------------------------------

const block = (e: LiveEvent) => `event: ${LIVE_WIRE.event}\ndata: ${JSON.stringify(e)}\n\n`

/** The event with only these items, and only the titles they or `work` still name (spec 32 F2: titles count in the bytes). */
function withItems(e: LiveEvent, items: LiveItem[], cut: number): LiveEvent {
  const { titles, ...rest } = e
  const named = new Set([...(e.work?.board ? [e.work.board] : []), ...items.map((i) => i.board)])
  const kept = titles ? Object.fromEntries(Object.entries(titles).filter(([b]) => named.has(b))) : {}
  return { ...rest, items, cut, ...(Object.keys(kept).length ? { titles: kept } : {}) }
}

/**
 * The event as written (#11, r1 #4): `event: live`, one `data:` line, a blank line - within `LIVE_BOUNDS.eventBytes`
 * in UTF-8. While it is over, the oldest whole items go (the end of `items`), counted in `cut`; `counts` stay exact.
 */
export function encodeLive(e: LiveEvent): string {
  const text = block(e)
  if (Buffer.byteLength(text) <= LIVE_BOUNDS.eventBytes) return text
  // the most items that fit, by bisection over the event as written: an item that goes takes the titles only it named
  // (spec 32 F2), and `cut`'s digits change, so only the written event is measured. Fewer items never write more bytes
  const at = (keep: number) => block(withItems(e, e.items.slice(0, keep), e.cut + e.items.length - keep))
  const fits = (keep: number) => Buffer.byteLength(at(keep)) <= LIVE_BOUNDS.eventBytes
  let lo = 0, hi = e.items.length - 1          // the whole event is over: at most n - 1 fit
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  return at(lo)
}

// ---- the hub --------------------------------------------------------------------------------------------------

/** What the hub needs of a response: a test can hand it a stand-in. */
export type LiveClient = Pick<ServerResponse, 'write' | 'end' | 'destroy' | 'on' | 'writableLength'>

export interface LiveHub {
  /** a source changed: recompute, debounced (trailing 150 ms, at most 1 s) */
  changed(): void
  /** recompute now (the fake canvas's setLive) */
  push(): void
  /** a client that passed the route: a fresh snapshot at once */
  add(res: LiveClient): void
  clients(): number
  /** ends every client's response; the hub stays (a dropped connection, in the fake canvas) */
  drop(): void
  close(): void
}

/** `seq`: per server process, rising across Vite restarts - one counter for every hub this module makes (#11, #14). */
const SEQ = { n: 0 }
const hubs = new Set<LiveHub>()

/** A source the stream reads changed - beside each place the server already tells pages (#13). Pokes every open hub. */
export function liveChanged(): void { for (const h of hubs) h.changed() }

export const LIVE_DEBOUNCE_MS = 150
export const LIVE_DEBOUNCE_MAX_MS = 1000

/**
 * One hub per server (#14). It computes only while a client is connected, and writes only a snapshot that differs
 * from the last one written, `seq` one higher. A new client gets the snapshot at once - alone, when nothing changed.
 * A heartbeat `: hb` every 30 s recomputes too, so a missed hook costs 30 s at most. A fifth client ends the oldest; a
 * client with more than 64 KiB unsent is destroyed before the next write (it reconnects for a fresh snapshot). `on`
 * subscribes the hub to a source that tells it of changes itself (workActivity), unsubscribed at close.
 */
export function createLiveHub(o: { instance: string; read: () => LiveBody; clock?: () => number; seq?: { n: number }; on?: (fn: () => void) => () => void }): LiveHub {
  const now = o.clock ?? Date.now
  const seq = o.seq ?? SEQ
  const clients: LiveClient[] = []
  let last: string | null = null   // the body last written, as JSON
  let text = ''                    // and as the event it was written as
  let timer: ReturnType<typeof setTimeout> | undefined
  let first = 0
  let beat: ReturnType<typeof setInterval> | undefined
  let closed = false

  /** no client left: no timer runs */
  const idle = () => { if (!clients.length) { clearInterval(beat); beat = undefined; clearTimeout(timer); timer = undefined } }
  const remove = (res: LiveClient) => {
    const i = clients.indexOf(res)
    if (i >= 0) clients.splice(i, 1)
    idle()
  }
  const write = (res: LiveClient, chunk: string) => {
    // a slow client is dropped before it holds more (#14): it reconnects and gets a fresh snapshot
    if (res.writableLength > LIVE_WIRE.slowBytes) { remove(res); res.destroy(); return }
    res.write(chunk)
  }
  /** Read the sources; a changed snapshot goes to every client. False when the read failed (nothing written). */
  const recompute = (): boolean => {
    let body: LiveBody
    try { body = o.read() } catch { return false }
    const key = JSON.stringify(body)
    if (key === last) return true
    last = key
    text = encodeLive({ v: 1, instance: o.instance, seq: ++seq.n, ...body })
    for (const c of [...clients]) write(c, text)
    return true
  }
  const fire = () => { timer = undefined; if (clients.length && !closed) recompute() }

  const hub: LiveHub = {
    changed() {
      if (closed || !clients.length) return   // no client, no work
      const t = now()
      if (timer === undefined) first = t
      clearTimeout(timer)
      timer = setTimeout(fire, Math.max(0, Math.min(LIVE_DEBOUNCE_MS, first + LIVE_DEBOUNCE_MAX_MS - t)))
    },
    push() { clearTimeout(timer); timer = undefined; if (!closed) recompute() },
    add(res) {
      if (closed) { res.end(); return }
      // a half-open socket from before a sleep must never lock the app out: the oldest goes
      while (clients.length >= LIVE_WIRE.clients) { const old = clients.shift()!; old.end() }
      clients.push(res)
      // the response's close, never the request's (a GET's request closes once read, A3.8 r2 #3)
      res.on('close', () => remove(res))
      res.on('error', () => remove(res))
      const was = last
      // changed since the last write: every client gets it (this one too); else this one alone
      if (recompute() && last === was && text) write(res, text)
      beat ??= setInterval(() => {
        recompute()
        for (const c of [...clients]) write(c, `${LIVE_WIRE.heartbeat}\n\n`)
      }, LIVE_WIRE.heartbeatMs)
      ;(beat as { unref?: () => void }).unref?.()
    },
    clients: () => clients.length,
    drop() { for (const c of clients.splice(0)) c.destroy(); idle() },
    close() {
      if (closed) return
      closed = true
      hubs.delete(hub)
      off?.()
      for (const c of clients.splice(0)) { try { c.end() } catch { /* gone */ } }
      clearInterval(beat); beat = undefined
      clearTimeout(timer); timer = undefined
    },
  }
  const off = o.on?.(() => hub.changed())
  hubs.add(hub)
  return hub
}

// ---- the route ------------------------------------------------------------------------------------------------

const refuse = (res: ServerResponse, status: number, extra: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra })
  res.end(String(status))
}

/**
 * `GET /__mv/app/live` (#5, #6): mounted right after the workspace guard (an `x-mv-ws` naming another workspace is a
 * 409 before anything is read) and the perf barrier. Another method 405; an `x-mv-app` that is not `appProof(key,
 * port)` 403, and a missing or malformed `x-mv-nonce` 400 - before anything is read or computed. The 200 carries
 * `x-mv-instance` and `x-mv-proof` = `liveProof`. No hub or no proof (no slot: an in-process plugin, a test server):
 * 404. Proved, the stream admits nothing else: it never makes a document trusted.
 */
export function liveRoute(hub: LiveHub | null, proof: DocProof | undefined) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if ((req.url ?? '').split('?')[0] !== LIVE_WIRE.path) return next()
    if (!hub || !proof) return refuse(res, 404)
    if (req.method !== 'GET') return refuse(res, 405, { allow: 'GET' })
    if (!appProofOk(proof, req.headers['x-mv-app'])) return refuse(res, 403)
    const signed = proofHeaders(proof, req.headers['x-mv-nonce'], 'live')
    if (!signed) return refuse(res, 400)
    res.writeHead(200, { 'content-type': `${LIVE_WIRE.type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...signed })
    res.socket?.setNoDelay(true)
    res.flushHeaders?.()
    hub.add(res)
  }
}
