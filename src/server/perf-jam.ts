/**
 * Jam timings (0.26.1, spec 27a Part D): one JSON line per event in design/.local/perf/jam.jsonl - local, never
 * committed, never published, never sent. `npx marver perf --jam` reads it back.
 *
 * Numbers and fixed codes only. Every event is rebuilt from an allowlist: opaque ids, frame ids, enums, bounded
 * integers - no words, notes, prompts, replies, titles, names, timelines or free-text errors (a failure is a code).
 * Writes are buffered and appended by one serialized writer off the hot path; past 1,000 events or 1 MB waiting,
 * new events are dropped and counted (the count written when the writer catches up). A write that fails changes
 * nothing for the operation it measured.
 *
 * Spec 30 R9 (#42, #43): a live file plus closed segments, as perf.ts's logs - 2 MB or 24 h a segment, 14 days, an
 * 8 MB safety cap - and every close, prune and cap runs in this writer's own queue, between two appends: the dev
 * server's start queues its upkeep here (`tidyJam`), and the queue runs it again hourly. Nothing is rewritten.
 */
import { appendFile } from 'node:fs/promises'
import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { adoptLive, closeLive, dueToClose, enforceCap, lineTs, pruneAged, readSegmented, type LiveState } from './perf-segments.ts'

export const jamLog = (root: string) => join(root, 'design', '.local', 'perf', 'jam.jsonl')
const FILE = 'jam.jsonl'
const PRUNE_EVERY_MS = 3_600_000
/** A test seam: how a batch of lines is appended (to hold an append open). Never set outside tests. */
export const jamSeams: { append?: (file: string, data: string) => Promise<void>; now?: () => number } = {}
const clock = () => (jamSeams.now ?? Date.now)()
const MAX_EVENTS = 1_000, MAX_BYTES = 1_000_000

// each id in its own generated format - free text never passes as an id
const CAPTURE = /^cap-\d{10,16}-[a-z0-9]{4,12}$/
const BATCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FRAME = /^[a-z0-9][\w-]{0,79}(\/[a-z0-9][\w-]{0,79}){1,3}$/i
const capId = (v: unknown) => (typeof v === 'string' && CAPTURE.test(v) ? v : undefined)
const batchId = (v: unknown) => (typeof v === 'string' && BATCH.test(v) ? v : undefined)
const frameId = (v: unknown) => (typeof v === 'string' && FRAME.test(v) ? v : undefined)
const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v) : undefined)
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e6 ? v : undefined)
const oneOf = <T extends string>(v: unknown, set: readonly T[]) => (typeof v === 'string' && (set as readonly string[]).includes(v) ? (v as T) : undefined)
const msList = (v: unknown, max = 50) => (Array.isArray(v) ? v.slice(0, max).map(ms).filter((x): x is number => x !== undefined) : undefined)
const prune = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined && !(Array.isArray(x) && !x.length))) as T

export const RUN_OUTCOMES = ['review', 'done', 'asks', 'failed'] as const
export const FAILURES = ['agent', 'changed', 'delivery', 'stopped', 'other'] as const
export const SHOT_OUTCOMES = ['ok', 'unchecked', 'stale', 'timeout', 'error'] as const
export const KINDS = ['capture', 'comment', 'wrapup'] as const

/** An event rebuilt from the allowlist, or null. */
export function cleanJamEvent(raw: Record<string, unknown>): Record<string, unknown> | null {
  switch (raw.kind) {
    case 'capture': {
      const p = (raw.pictures && typeof raw.pictures === 'object' ? raw.pictures : {}) as Record<string, unknown>
      const capture = capId(raw.capture)
      if (!capture) return null
      // `live` (A4.6 #36): the Mac app's pictures of the stage kept, the ones that failed, the renders that replaced them
      const l = (p.live && typeof p.live === 'object' ? p.live : null) as Record<string, unknown> | null
      const live = l ? prune({ count: count(l.count), failed: count(l.failed), fellBack: count(l.fellBack) }) : undefined
      return prune({ kind: 'capture', capture, sealMs: ms(raw.sealMs), wordsWaitMs: ms(raw.wordsWaitMs),
        pictures: prune({ count: count(p.count), ms: msList(p.ms), late: count(p.late), failed: count(p.failed), live: live && Object.keys(live).length ? live : undefined }),
        interrupted: raw.interrupted === true ? true : undefined })
    }
    case 'upload': { const capture = capId(raw.capture); return capture ? prune({ kind: 'upload', capture, ms: ms(raw.ms), tries: count(raw.tries) }) : null }
    case 'name': { const capture = capId(raw.capture); return capture ? prune({ kind: 'name', capture, ms: ms(raw.ms), ok: raw.ok === true }) : null }
    case 'words': return prune({ kind: 'words', audioMs: ms(raw.audioMs), waitMs: ms(raw.waitMs), decodeMs: ms(raw.decodeMs), backlogMs: ms(raw.backlogMs), modelLoadMs: ms(raw.modelLoadMs) })
    case 'run': {
      const batch = batchId(raw.batch)
      if (!batch) return null
      const members = Array.isArray(raw.members) ? raw.members.slice(0, 50).map((m: any) => prune({ kind: oneOf(m?.kind, KINDS), waitMs: ms(m?.waitMs), outcome: oneOf(m?.outcome, RUN_OUTCOMES) })) : undefined
      return prune({ kind: 'run', batch, members, beforeMs: ms(raw.beforeMs), agentMs: msList(raw.agentMs, 10), afterMs: ms(raw.afterMs), deliverMs: ms(raw.deliverMs),
        attempts: count(raw.attempts), failure: oneOf(raw.failure, FAILURES), redelivered: raw.redelivered === true ? true : undefined })
    }
    case 'shot': return prune({ kind: 'shot', frame: frameId(raw.frame), scale: count(raw.scale), ms: ms(raw.ms), recaptures: count(raw.recaptures), outcome: oneOf(raw.outcome, SHOT_OUTCOMES) })
    default: return null
  }
}

/** `bytes` and the queue's length count what waits AND what is being appended - released once the append settles.
 *  `live`: the live file as this writer knows it; `upkeep`: retention asked for (at start, then hourly). */
interface Writer { queue: string[]; bytes: number; inFlight: number; dropped: number; busy: boolean; writes: number; draining?: Promise<void>; live: LiveState | null; upkeep: boolean; prunedAt: number }
const writers = new Map<string, Writer>()
/** Captures already logged, per root: a resent capture event is written once. */
const seenCaptures = new Map<string, Set<string>>()

/** Log one Jam event (best effort, never in the way): rebuilt from the allowlist, buffered, appended in order. */
export function logJam(root: string, raw: Record<string, unknown>): void {
  try {
    const ev = cleanJamEvent(raw)
    if (!ev) return
    if (ev.kind === 'capture') {
      const seen = seenCaptures.get(root) ?? new Set<string>()
      seenCaptures.set(root, seen)
      if (seen.has(ev.capture as string)) return
      seen.add(ev.capture as string)
      if (seen.size > 5_000) seen.delete(seen.values().next().value as string)
    }
    const line = JSON.stringify({ v: 1, ts: Date.now(), ...ev }) + '\n'
    const w = writerOf(root)
    if (w.queue.length + w.inFlight >= MAX_EVENTS || w.bytes + line.length > MAX_BYTES) { w.dropped++; return }
    w.queue.push(line); w.bytes += line.length
    kick(root, w)
  } catch { /* the log never stands in the way */ }
}

function writerOf(root: string): Writer {
  let w = writers.get(root)
  if (!w) writers.set(root, w = { queue: [], bytes: 0, inFlight: 0, dropped: 0, busy: false, writes: 0, live: null, upkeep: false, prunedAt: 0 })
  return w
}
function kick(root: string, w: Writer): void {
  if (!w.busy) { w.busy = true; w.draining = new Promise<void>((done) => setImmediate(() => void drain(root, w).finally(done))) }
}

/** The dev server's start (perf.ts `tidyPerfDir`): the log's upkeep queued in its own writer - a live file opened 24 h
 *  ago closed (a 0.29 file a segment, #45), segments past 14 days unlinked, the safety cap. */
export function tidyJam(root: string, now = clock()): void {
  try {
    const w = writerOf(root)
    w.upkeep = true
    w.prunedAt = now
    kick(root, w)
  } catch { /* never in the way */ }
}

/** The live file's state: this writer's, else adopted from the disk; a file replaced behind its back is adopted again. */
function liveOf(file: string, w: Writer): LiveState | null {
  let st
  try { st = lstatSync(file) } catch { w.live = null; return null }
  if (!st.isFile()) throw new Error('not a regular file')
  if (w.live && w.live.ino === st.ino) { w.live.size = st.size; return w.live }
  return (w.live = adoptLive(file))
}

/** Closes a due live file; with `prune`, unlinks the segments past 14 days; after either, the safety cap - its counted
 *  `dropped` line returned to go out with the next append. Synchronous: between two appends of this queue. */
function upkeep(file: string, w: Writer, prune: boolean): string | null {
  const dir = join(file, '..'), now = clock()
  try {
    const s = liveOf(file, w)
    let closed = false
    if (s && dueToClose(FILE, s, now)) { closeLive(dir, FILE, s, now); w.live = null; closed = true }
    if (prune) pruneAged(dir, FILE, now)
    if (!prune && !closed) return null
    const went = enforceCap(dir, FILE, w.live?.size ?? 0)
    return went.segments ? JSON.stringify({ v: 1, ts: now, kind: 'dropped', count: went.lines, reason: 'retention-cap' }) + '\n' : null
  } catch { return null }
}

async function drain(root: string, w: Writer): Promise<void> {
  const file = jamLog(root)
  // the directory 700 and the file 600 from their creation: the perf logs are the owner's alone (spec 28 A1.7)
  try { mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 }) } catch { /* the append says */ }
  /** the cap's line after a close past the segment size: it goes first in the next append */
  let carry: string | null = null
  while (w.queue.length || w.dropped || w.upkeep || carry) {
    // retention in the queue's own turn (#42): asked for at start, and hourly while events come
    const prune = w.upkeep || clock() - w.prunedAt >= PRUNE_EVERY_MS
    if (prune) w.prunedAt = clock()
    w.upkeep = false
    const capped = upkeep(file, w, prune)
    const lines = w.queue.splice(0)
    const held = lines.reduce((n, l) => n + l.length, 0)
    w.inFlight = lines.length
    if (capped) lines.unshift(capped)
    if (carry) { lines.unshift(carry); carry = null }
    if (w.dropped) { lines.push(JSON.stringify({ v: 1, ts: Date.now(), kind: 'dropped', count: w.dropped }) + '\n'); w.dropped = 0 }
    if (lines.length) {
      try {
        const before = liveOf(file, w)
        await (jamSeams.append ?? ((f: string, d: string) => appendFile(f, d, { mode: 0o600 })))(file, lines.join(''))
        w.writes++
        let max = 0
        for (const l of lines) { const t = lineTs(l); if (t !== null && t > max) max = t }
        const st = lstatSync(file)
        if (before && before.ino === st.ino && w.live === before) { before.size = st.size; before.maxTs = Math.max(before.maxTs, max) }
        else w.live = { openedAt: clock(), maxTs: max, adopted: false, size: st.size, ino: st.ino }
        // past its segment size: closed at once
        carry = upkeep(file, w, false)
      } catch { /* lost - the operation it measured is not */ }
    }
    // settled: what it held is free again
    w.inFlight = 0
    w.bytes = Math.max(0, w.bytes - held)
  }
  w.busy = false
}

/** Wait for every buffered event to be written (tests, and a server shutting down) - the writer's own drain, not a
 *  fixed time; `ms` at most. */
export async function flushJam(root: string, ms = 30_000): Promise<void> {
  const by = Date.now() + ms
  while (writers.get(root)?.busy && Date.now() < by) {
    const w = writers.get(root)!
    await Promise.race([w.draining, new Promise((r) => setTimeout(r, Math.max(1, by - Date.now())))])
  }
}

/** The log read back from `since` (epoch ms) - its segments in `openedAt` order, then the live file: malformed lines
 *  skipped. `first` is the oldest line kept. */
export function readJam(root: string, since = 0): { events: Record<string, any>[]; first?: number } {
  try {
    const all = readSegmented(join(jamLog(root), '..'), FILE).flatMap((l) => {
      try { const e = JSON.parse(l); return e && typeof e.ts === 'number' ? [e] : [] } catch { return [] }
    })
    return { events: all.filter((e) => e.ts >= since), ...(all.length ? { first: all.reduce((m, e) => Math.min(m, e.ts), Infinity) } : {}) }
  } catch { return { events: [] } }
}
