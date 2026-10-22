/**
 * The recorder's pure parts (spec 28 A1.7), kept apart from the browser-coupled store so they can be unit-tested
 * (the ready-watch.ts precedent): the bounded outbox, sizes in UTF-8 bytes, what fits a page's last keepalive send, a
 * gesture's numbers, and a node's outcome from what its live document said.
 */

export const KINDS = ['load', 'commit', 'visible', 'frame', 'move', 'quiet', 'settled', 'cut', 'gesture', 'error', 'dropped'] as const
export type Kind = typeof KINDS[number]
/** Every record: the workspace, this page, the load that owns the geometry ('-' before the first commit), its place
 *  in this page's order, and when it happened. */
export interface Envelope { v: 1; ws: string; page: string; load: string; seq: number; ts: number; kind: Kind }
export type PerfRecord = Envelope & Record<string, unknown>

/** The queue's bounds: past either, the oldest go and are counted. */
export const QUEUE_MAX = 2_000, QUEUE_BYTES = 256 * 1024
/** A page that is going sends at most this much with keepalive: the rest of the 64 KB allowance is the captures'. */
export const KEEPALIVE_BYTES = 16 * 1024
/** Records wait this long for company before a send; a failed send waits this long before it tries again. */
export const SEND_MS = 2_000
/** A board is quiet after this long without a move. */
export const QUIET_MS = 1_000
/** A load not settled by then is cut. */
export const LOAD_MAX_MS = 120_000

const enc = new TextEncoder()
/** Size in UTF-8 bytes, as the request body will carry it - not `.length`, which counts UTF-16 units. */
export const bytesOf = (x: unknown): number => enc.encode(typeof x === 'string' ? x : JSON.stringify(x)).length

/** Records waiting to be sent, oldest first. Past `max` records or `maxBytes` the oldest go, counted in `dropped`
 *  (the recorder sends that count in a `dropped` record and zeroes it). */
export class Outbox {
  private items: { rec: PerfRecord; bytes: number }[] = []
  private waiting = new Set<PerfRecord>()
  bytes = 0
  dropped = 0
  constructor(private max = QUEUE_MAX, private maxBytes = QUEUE_BYTES) {}
  get size(): number { return this.items.length }
  push(rec: PerfRecord): void {
    const bytes = bytesOf(rec)
    this.items.push({ rec, bytes })
    this.waiting.add(rec)
    this.bytes += bytes
    this.trim()
  }
  /** A waiting record changed in place (a coalesced move): its size again. */
  touch(rec: PerfRecord): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      if (it.rec !== rec) continue
      const bytes = bytesOf(rec)
      this.bytes += bytes - it.bytes
      it.bytes = bytes
      this.trim()
      return
    }
  }
  /** Still waiting (not sent, not dropped)? */
  has(rec: PerfRecord): boolean { return this.waiting.has(rec) }
  /** Everything waiting, oldest first; the outbox is empty after. */
  takeAll(): PerfRecord[] {
    const out = this.items.map((it) => it.rec)
    this.items = []
    this.waiting.clear()
    this.bytes = 0
    return out
  }
  private trim(): void {
    while (this.items.length && (this.items.length > this.max || this.bytes > this.maxBytes)) {
      const it = this.items.shift()!
      this.waiting.delete(it.rec)
      this.bytes -= it.bytes
      this.dropped++
    }
  }
}

/** For a page that is going: `first` (its cut, when there is one), then the oldest of `rest` while the whole body
 *  `{"records":[…]}` stays within `maxBytes` with `reserve` left for a `dropped` record. The others are `lost`. */
export function fitWithin(first: readonly PerfRecord[], rest: readonly PerfRecord[], maxBytes = KEEPALIVE_BYTES, reserve = 160): { fit: PerfRecord[]; lost: number } {
  const fit = [...first]
  let size = bytesOf({ records: [] }) + reserve + first.reduce((n, r, i) => n + bytesOf(r) + (i ? 1 : 0), 0)
  let taken = 0
  for (const r of rest) {
    const add = bytesOf(r) + (fit.length ? 1 : 0)
    if (size + add > maxBytes) break
    size += add
    fit.push(r)
    taken++
  }
  return { fit, lost: rest.length - taken }
}

/** A gesture's frame intervals as they are: nearest-rank percentiles (cli/perf.ts `spread`'s rule), one decimal; the
 *  counts over 17 ms and over 33 ms; `longFrames` as given. */
export function gestureStats(dts: readonly number[], longFrames: number): { frames: number; p50: number; p95: number; max: number; over17ms: number; over33ms: number; longFrames: number } {
  const v = [...dts].sort((a, b) => a - b)
  const at = (q: number) => (v.length ? v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)] : 0)
  const r = (x: number) => Math.round(x * 10) / 10
  return {
    frames: v.length, p50: r(at(0.5)), p95: r(at(0.95)), max: r(v[v.length - 1] ?? 0),
    over17ms: v.filter((d) => d > 17).length, over33ms: v.filter((d) => d > 33).length, longFrames,
  }
}

/** What a node of a load waits for: a settled measure at its width, its ready, or nothing (missing). */
export type Rule = 'measure' | 'ready' | 'missing'
export type Outcome = 'settled' | 'ready' | 'missing' | 'error' | 'never-ready'
/** One node's story, as its live document told it (page-level, by node key: a reload of the same board keeps the
 *  documents, and their facts carry over). Times are performance.now(). */
export interface Track {
  frame: string
  /** the document these facts belong to */
  boot?: string
  /** when the node's mount was admitted - not per document (a reload keeps its slot) */
  admittedAt?: number
  readyAt?: number
  firstMeasureAt?: number
  /** a settled report the store took at this width */
  settled?: { at: number; w: number }
  errorAt?: number
  /** the watchdog's second silence, for this navigation */
  neverReady?: { at: number; nav: number }
}

/** A message from document `boot`: kept only when that document is the one there now. A new live document starts
 *  the node's story over, and a message from a live document supersedes the watchdog's verdict. */
export function adopt(t: Track, boot: unknown, live: string | undefined): boolean {
  if (typeof boot !== 'string' || !boot || boot !== live) return false
  if (t.boot !== boot) { t.boot = boot; delete t.readyAt; delete t.firstMeasureAt; delete t.settled; delete t.errorAt }
  delete t.neverReady
  return true
}

/** The node's outcome now, or null (pending). An outcome a document reported counts only while that document is the
 *  live one - a document since replaced, or one still booting (no live boot yet), sends it back to pending.
 *  `missing` and `never-ready` have no document and are exempt: missing while the frame is absent from the manifest,
 *  never-ready for the navigation the watchdog gave up on, until a new navigation or a live message replaces it. */
export function outcomeOf(rule: Rule, t: Track | undefined, live: string | undefined, node: { w: number; nav?: number }): Outcome | null {
  if (rule === 'missing') return 'missing'
  if (!t) return null
  const current = !!live && t.boot === live
  if (current && t.errorAt !== undefined) return 'error'
  if (current && rule === 'ready' && t.readyAt !== undefined) return 'ready'
  if (current && rule === 'measure' && t.settled && t.settled.w === Math.round(node.w)) return 'settled'
  if (t.neverReady && t.neverReady.nav === (node.nav ?? 0)) return 'never-ready'
  return null
}

/** The first three stack lines of an error - Chrome's "    at …", else Safari's and Firefox's "fn@url:line:col" -
 *  each 200 characters at most. */
export function stackLines(stack: unknown): string[] | undefined {
  if (typeof stack !== 'string' || !stack) return undefined
  const lines = stack.split('\n')
  const chrome = lines.filter((l) => /^\s*at /.test(l))
  const picked = chrome.length ? chrome : lines.filter((l) => /@.*:\d+(:\d+)?$/.test(l.trim()))
  const out = picked.slice(0, 3).map((l) => l.trim().slice(0, 200)).filter(Boolean)
  return out.length ? out : undefined
}

/** A string bounded to `n` characters, or undefined. */
export const bound = (v: unknown, n = 200): string | undefined => (typeof v === 'string' && v ? v.slice(0, n) : undefined)

/** 12 hex characters: a page, a load or a document id. */
export function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')
}
