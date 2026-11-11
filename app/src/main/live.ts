/**
 * The live streams (spec 28 A4.2, A4.6 #11, #12, #16, #18, r1 #7): one `GET <origin>/__mv/app/live` per running
 * canvas, in main, so a hidden or unloaded tab keeps its marks. No Electron: Node's `fetch`, as `fetchLogo` does,
 * and the ports main.ts installs. notify.ts reads what is held here; nothing else does.
 *
 * - **Which**: one stream per registry entry that is `ready`, has an origin and lists `live`, keyed by instance and
 *   independent of tabs and views. Started from the registry's events and the entries found at launch; stopped at
 *   that instance's `gone` (its snapshot dropped), when another instance takes its slot file (the old one aborted
 *   first), and at quit. A re-read with the same instance keeps its stream.
 * - **The request**: `x-mv-ws`, a fresh 24-byte `x-mv-nonce` on every connect, `x-mv-app` = `appProof(key, port)`,
 *   `accept: text/event-stream`; `redirect: 'error'`, `cache: 'no-store'`. It counts only when the status is 200, the
 *   type `text/event-stream`, `x-mv-instance` the entry's and `checkProof` kind `live` answers `ok`: a listener that
 *   took the port after a canvas stopped can never put words into a notice. A 403, 404, 405 or 409 stops the stream
 *   until the entry's instance changes - an older canvas or an impostor is asked once, never stormed.
 * - **Parsing** (`SseReader`, `parseLive`): comment lines skipped; `event: live` with one `data:` line; an event past
 *   `LIVE_BOUNDS.eventBytes` as written drops the connection. Every field is checked against `LIVE_BOUNDS`, unknown
 *   ones stripped; an item of an unknown kind is dropped, not the event; a malformed event is dropped and the stream
 *   kept. An event counts only if its `instance` is the entry's and, on one connection, its `seq` is above the last
 *   one applied there; a new connection's first snapshot is applied whole.
 * - **Generations** (r1 #7): every connect raises the stream's `conn`, and every callback of a connection - an
 *   event, its idle timer, its end, error or abort, a reconnect - first checks its generation is still current.
 * - **Reconnects**: `liveBackoffMs`, then every `liveBackoffMaxMs`, each with up to 20 % jitter, reset once a
 *   connection delivered a valid snapshot; `liveIdleMs` with no byte aborts and reconnects; `resume()` (the Mac woke)
 *   reconnects every stream at once.
 * - **Stale is not zero** (#18): while a stream reconnects its last snapshot stays; once no proved connection has
 *   received a byte for `liveIdleMs` it is held `stale`. Only the registry's `gone` drops a snapshot.
 */
import { randomBytes } from 'node:crypto'
import { appProof } from '../../../src/server/proof.ts'
import { FEATURE, LIVE_BOUNDS, LIVE_KINDS, LIVE_TITLES_MAX, LIVE_WIRE, type LiveEvent, type LiveItem, type LiveKind } from '../../../src/shared/app-api.ts'
import { checkProof } from './proof.ts'
import type { RegistryEntry, RegistryEvent } from './registry.ts'
import { T } from './timings.ts'

// ---- the event, checked (pure) ----------------------------------------------------------------------------------

const CONTROL = /[\u0000-\u001f\u007f]/
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const line = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !CONTROL.test(v)
const ref = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= LIVE_BOUNDS.ref && !CONTROL.test(v)

/** One item, its known fields checked and the rest stripped; null refuses the event, `'skip'` drops the item alone. */
function checkItem(p: unknown): LiveItem | 'skip' | null {
  if (!obj(p)) return null
  if (typeof p.kind !== 'string') return null
  if (!(LIVE_KINDS as readonly string[]).includes(p.kind)) return 'skip'   // a kind a later canvas adds
  if (typeof p.id !== 'string' || !LIVE_BOUNDS.id.test(p.id)) return null
  if (!ref(p.board) || !line(p.title, LIVE_BOUNDS.title)) return null
  if (typeof p.at !== 'number' || !Number.isFinite(p.at) || p.at < 0) return null
  const it: LiveItem = { id: p.id, kind: p.kind as LiveKind, board: p.board, title: p.title, at: p.at }
  if (p.note !== undefined) { if (!line(p.note, LIVE_BOUNDS.note)) return null; it.note = p.note }
  for (const k of ['frame', 'thread', 'msg', 'batch'] as const) {
    if (p[k] === undefined) continue
    if (!ref(p[k])) return null
    it[k] = p[k]
  }
  if (p.cards !== undefined) {
    if (!Array.isArray(p.cards) || p.cards.length > LIVE_BOUNDS.cards || !p.cards.every(ref)) return null
    it.cards = [...p.cards] as string[]
  }
  for (const k of ['gen', 'occ'] as const) {
    if (p[k] === undefined) continue
    if (!whole(p[k])) return null
    it[k] = p[k]
  }
  return it
}

/** Spec 32 F2: `work`, checked - `since` a time, `board` a ref when present; undefined (dropped) when malformed. */
function checkWork(p: unknown): LiveEvent['work'] | undefined {
  if (!obj(p) || typeof p.since !== 'number' || !Number.isFinite(p.since) || p.since < 0) return undefined
  if (p.board !== undefined && !ref(p.board)) return undefined
  return { since: p.since, ...(p.board !== undefined ? { board: p.board as string } : {}) }
}

/** Spec 32 F2: `titles`, checked - at most `LIVE_TITLES_MAX` keys, each a ref, each value a title line; undefined
 *  (dropped, never the event) when malformed. */
function checkTitles(p: unknown): Record<string, string> | undefined {
  if (!obj(p)) return undefined
  const keys = Object.keys(p)
  if (keys.length > LIVE_TITLES_MAX) return undefined
  const out: Record<string, string> = {}
  for (const k of keys) {
    const v = p[k]
    if (!ref(k) || !line(v, LIVE_BOUNDS.title) || k === '__proto__') return undefined
    out[k] = v
  }
  return out
}

/**
 * A `LiveEvent` v1, every field checked again (A4.6 #16, A2.14 #19); null for a malformed one. Spec 32 F2's optional
 * `work` and `titles` are bounded too, and either is dropped alone when malformed, never the event.
 */
export function parseLive(p: unknown): LiveEvent | null {
  if (!obj(p) || p.v !== 1 || typeof p.instance !== 'string' || !whole(p.seq) || (p.jam !== 'on' && p.jam !== 'off')) return null
  if (!Array.isArray(p.items) || p.items.length > LIVE_BOUNDS.items || !whole(p.cut)) return null
  const c = p.counts
  if (!obj(c) || !LIVE_KINDS.every((k) => whole(c[k]))) return null
  if (!whole(p.unseen) || typeof p.working !== 'boolean' || typeof p.session !== 'boolean') return null
  const items: LiveItem[] = []
  for (const raw of p.items) {
    const it = checkItem(raw)
    if (it === null) return null
    if (it !== 'skip') items.push(it)
  }
  const work = p.work === undefined ? undefined : checkWork(p.work)
  const titles = p.titles === undefined ? undefined : checkTitles(p.titles)
  return {
    v: 1, instance: p.instance, seq: p.seq, jam: p.jam, items, cut: p.cut,
    counts: { ask: c.ask as number, review: c.review as number, failed: c.failed as number, stalled: c.stalled as number },
    unseen: p.unseen, working: p.working, session: p.session,
    ...(work ? { work } : {}), ...(titles ? { titles } : {}),
  }
}

/**
 * The event-stream reader (A4.6 #16): bytes in, `live` events' data out. Lines are split on the bytes, so one too
 * long is caught before it is decoded; an event (its `event:` and `data:` lines and the blank line) past
 * `eventBytes` answers `'too-big'` and the caller drops the connection. Comment lines are skipped.
 */
export class SseReader {
  private pending = Buffer.alloc(0)
  private bytes = 0
  private event = ''
  private data: string[] = []
  constructor(private readonly max: number = LIVE_BOUNDS.eventBytes) {}

  /** The `live` events' data lines this chunk completed (an event with other than one data line gives `null`). */
  push(chunk: Uint8Array): (string | null)[] | 'too-big' {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk)
    const out: (string | null)[] = []
    for (;;) {
      const i = this.pending.indexOf(0x0a)
      if (i < 0) return this.bytes + this.pending.length > this.max ? 'too-big' : out
      let raw = this.pending.subarray(0, i)
      this.pending = this.pending.subarray(i + 1)
      if (raw.length && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1)
      if (!raw.length) {
        // the blank line ends an event
        if (this.event || this.data.length) {
          if (this.bytes + 1 > this.max) return 'too-big'
          if (this.event === LIVE_WIRE.event) out.push(this.data.length === 1 ? this.data[0]! : null)
        }
        this.event = ''; this.data = []; this.bytes = 0
        continue
      }
      if (raw[0] === 0x3a) { if (i + 1 > this.max) return 'too-big'; continue }   // `: hb`, a comment
      this.bytes += i + 1
      if (this.bytes > this.max) return 'too-big'
      const text = raw.toString('utf8')
      const colon = text.indexOf(':')
      const field = colon < 0 ? text : text.slice(0, colon)
      const value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') this.event = value
      else if (field === 'data') this.data.push(value)
    }
  }
}

// ---- the streams ------------------------------------------------------------------------------------------------

/** What main holds of a canvas's stream: its last applied snapshot, and whether it is out of date (#18). */
export interface Held { instance: string; ws: string; name: string; event: LiveEvent; stale: boolean }

export type LiveChange = 'applied' | 'stale' | 'fresh' | 'dropped'

export interface LivePorts {
  /** Node's fetch (tests pass their own) */
  fetch?: typeof fetch
  now?(): number
  /** 0-1, for the jitter */
  random?(): number
  /** a stream's snapshot was applied, went stale or fresh again, or was dropped */
  changed(instance: string, why: LiveChange): void
  log?(topic: string, data: unknown): void
}

export interface Live {
  /** a registry event (views.ts's listener's order: the tabs first) */
  onRegistry(e: RegistryEvent): void
  /** the entries found at launch */
  start(entries: RegistryEntry[]): void
  /** `powerMonitor` `resume`: every stream reconnects at once */
  resume(): void
  /** at quit, once `guardAll` answered `done`: every stream ends, every timer cleared */
  close(): void
  held(instance: string): Held | undefined
  /** test view: each stream's state */
  dump(): { instance: string; conn: number; attempt: number; refused?: number; held: boolean; stale: boolean }[]
}

const STOPS = new Set([403, 404, 405, 409])

interface Stream {
  entry: RegistryEntry
  conn: number
  ctrl?: AbortController
  attempt: number
  retry?: ReturnType<typeof setTimeout>
  idle?: ReturnType<typeof setTimeout>
  staleTimer?: ReturnType<typeof setTimeout>
  held?: LiveEvent
  stale: boolean
  /** the status that stopped it until the instance changes */
  refused?: number
  closed: boolean
}

/** A stream is wanted for this entry: ready, with an origin, its slot file listing `live`. */
export const wantsLive = (e: Pick<RegistryEntry, 'state' | 'origin' | 'features'>): boolean => e.state === 'ready' && !!e.origin && e.features.includes(FEATURE.live)

/** The next reconnect's wait (pure): the backoff's step, then every `liveBackoffMaxMs`, plus up to 20 % jitter. */
export function backoffMs(attempt: number, random: number): number {
  const base = T.liveBackoffMs[attempt] ?? T.liveBackoffMaxMs
  return Math.round(base * (1 + 0.2 * Math.min(1, Math.max(0, random))))
}

export function createLive(ports: LivePorts): Live {
  const streams = new Map<string, Stream>()
  const doFetch = ports.fetch ?? fetch
  const random = ports.random ?? Math.random
  const log = (data: Record<string, unknown>) => ports.log?.('live', data)
  const unref = (t: ReturnType<typeof setTimeout>) => { (t as { unref?: () => void }).unref?.(); return t }

  const clear = (s: Stream) => {
    for (const t of [s.retry, s.idle, s.staleTimer]) if (t) clearTimeout(t)
    s.retry = s.idle = s.staleTimer = undefined
  }
  /** this connection is still the stream's current one */
  const current = (s: Stream, gen: number) => !s.closed && s.conn === gen && streams.get(s.entry.instance) === s

  /** a proved connection received a byte: the snapshot is not stale, and goes stale `liveIdleMs` after the last one */
  const alive = (s: Stream) => {
    if (s.staleTimer) clearTimeout(s.staleTimer)
    s.staleTimer = unref(setTimeout(() => {
      s.staleTimer = undefined
      if (s.closed || !s.held || s.stale) return
      s.stale = true
      log({ instance: s.entry.instance, stale: true })
      ports.changed(s.entry.instance, 'stale')
    }, T.liveIdleMs))
    if (s.stale && s.held) { s.stale = false; ports.changed(s.entry.instance, 'fresh') }
  }

  const armIdle = (s: Stream, gen: number) => {
    if (s.idle) clearTimeout(s.idle)
    s.idle = unref(setTimeout(() => {
      if (!current(s, gen)) return
      log({ instance: s.entry.instance, conn: gen, idle: true })
      s.ctrl?.abort()
      again(s, gen)
    }, T.liveIdleMs))
  }

  /** this connection ended or failed: one reconnect, after the backoff */
  const again = (s: Stream, gen: number) => {
    if (!current(s, gen) || s.refused !== undefined) return
    s.conn += 1   // nothing of the old connection counts from here
    if (s.idle) { clearTimeout(s.idle); s.idle = undefined }
    const wait = backoffMs(s.attempt, random())
    s.attempt += 1
    const gen2 = s.conn
    if (s.retry) clearTimeout(s.retry)
    s.retry = unref(setTimeout(() => { s.retry = undefined; if (s.conn === gen2 && !s.closed) void connect(s) }, wait))
  }

  async function connect(s: Stream): Promise<void> {
    if (s.closed || s.refused !== undefined) return
    s.ctrl?.abort()
    const gen = ++s.conn
    const ctrl = new AbortController()
    s.ctrl = ctrl
    const e = s.entry
    const nonce = randomBytes(24).toString('base64url')
    armIdle(s, gen)
    let res: Response
    try {
      res = await doFetch(`${e.origin}${LIVE_WIRE.path}`, {
        headers: { 'x-mv-ws': e.ws, 'x-mv-nonce': nonce, 'x-mv-app': appProof(e.key, e.port), accept: LIVE_WIRE.type },
        redirect: 'error', cache: 'no-store', signal: ctrl.signal,
      })
    } catch (err) {
      if (current(s, gen)) { log({ instance: e.instance, conn: gen, error: String((err as Error)?.message ?? err) }); again(s, gen) }
      return
    }
    const drop = () => { void res.body?.cancel().catch(() => {}) }
    if (!current(s, gen)) { drop(); return }
    armIdle(s, gen)
    if (STOPS.has(res.status)) {
      drop()
      s.refused = res.status
      if (s.idle) { clearTimeout(s.idle); s.idle = undefined }
      log({ instance: e.instance, conn: gen, refused: res.status })
      return
    }
    const h = Object.fromEntries(res.headers) as Record<string, string>
    const type = (h['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    const proved = res.status === 200 && type === LIVE_WIRE.type && h['x-mv-instance'] === e.instance
      && checkProof({ headers: h, nonce, key: e.key, port: e.port, instance: e.instance, kind: 'live' }) === 'ok'
    if (!proved) {
      drop()
      log({ instance: e.instance, conn: gen, status: res.status, type, unproved: true })
      again(s, gen)
      return
    }
    log({ instance: e.instance, conn: gen, open: true })
    alive(s)
    const reader = res.body?.getReader()
    if (!reader) { again(s, gen); return }
    const sse = new SseReader()
    let lastSeq = -1
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (!current(s, gen)) { void reader.cancel().catch(() => {}); return }
        if (done) break
        armIdle(s, gen)
        alive(s)
        const got = sse.push(value)
        if (got === 'too-big') {
          log({ instance: e.instance, conn: gen, tooBig: true })
          void reader.cancel().catch(() => {})
          ctrl.abort()
          break
        }
        for (const data of got) {
          const ev = data === null ? null : parseLiveText(data)
          if (!ev || ev.instance !== e.instance || ev.seq <= lastSeq) { log({ instance: e.instance, conn: gen, dropped: ev ? (ev.instance !== e.instance ? 'instance' : 'seq') : 'malformed' }); continue }
          lastSeq = ev.seq
          s.held = ev
          s.attempt = 0
          s.stale = false
          ports.changed(e.instance, 'applied')
        }
      }
    } catch (err) {
      if (!current(s, gen)) return
      log({ instance: e.instance, conn: gen, error: String((err as Error)?.message ?? err) })
    }
    if (current(s, gen)) { log({ instance: e.instance, conn: gen, ended: true }); again(s, gen) }
  }

  const parseLiveText = (data: string): LiveEvent | null => { try { return parseLive(JSON.parse(data)) } catch { return null } }

  /** Ends a stream; its snapshot dropped when `drop` (the registry's gone, another instance in its place). */
  const stop = (s: Stream, why: string) => {
    s.closed = true
    s.conn += 1
    s.ctrl?.abort()
    clear(s)
    streams.delete(s.entry.instance)
    log({ instance: s.entry.instance, stop: why })
    if (s.held) ports.changed(s.entry.instance, 'dropped')
  }

  const add = (e: RegistryEntry) => {
    const had = streams.get(e.instance)
    if (had) {
      if (!wantsLive(e)) stop(had, 'not live')
      else had.entry = e   // the same instance read again: its stream stays
      return
    }
    if (!wantsLive(e)) return
    // another instance in this slot file: the old stream ends before the new one opens
    for (const s of [...streams.values()]) if (s.entry.file === e.file) stop(s, 'replaced')
    const s: Stream = { entry: e, conn: 0, attempt: 0, stale: false, closed: false }
    streams.set(e.instance, s)
    void connect(s)
  }

  return {
    onRegistry(ev) {
      if (ev.kind === 'gone') { const s = streams.get(ev.instance); if (s) stop(s, `gone:${ev.why}`); return }
      add(ev.entry)
    },
    start(entries) { for (const e of entries) add(e) },
    resume() {
      for (const s of streams.values()) {
        if (s.refused !== undefined || s.closed) continue
        if (s.retry) { clearTimeout(s.retry); s.retry = undefined }
        s.attempt = 0
        void connect(s)
      }
    },
    close() { for (const s of [...streams.values()]) { s.closed = true; s.conn += 1; s.ctrl?.abort(); clear(s) } streams.clear() },
    held(instance) {
      const s = streams.get(instance)
      return s?.held ? { instance, ws: s.entry.ws, name: s.entry.name, event: s.held, stale: s.stale } : undefined
    },
    dump: () => [...streams.values()].map((s) => ({ instance: s.entry.instance, conn: s.conn, attempt: s.attempt, ...(s.refused !== undefined ? { refused: s.refused } : {}), held: !!s.held, stale: s.stale })),
  }
}
