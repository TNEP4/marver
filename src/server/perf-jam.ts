/**
 * Jam timings (0.26.1, spec 27a Part D): one JSON line per event in design/.local/perf/jam.jsonl - local, never
 * committed, never published, never sent. `npx marver perf --jam` reads it back.
 *
 * Numbers and fixed codes only. Every event is rebuilt from an allowlist: opaque ids, frame ids, enums, bounded
 * integers - no words, notes, prompts, replies, titles, names, timelines or free-text errors (a failure is a code).
 * Writes are buffered and appended by one serialized writer off the hot path; past 1,000 events or 1 MB waiting,
 * new events are dropped and counted (the count written when the writer catches up). A write that fails changes
 * nothing for the operation it measured.
 */
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const jamLog = (root: string) => join(root, 'design', '.local', 'perf', 'jam.jsonl')

const MAX_FILE = 2_000_000          // past this the oldest half goes
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
      return prune({ kind: 'capture', capture, sealMs: ms(raw.sealMs), wordsWaitMs: ms(raw.wordsWaitMs),
        pictures: prune({ count: count(p.count), ms: msList(p.ms), late: count(p.late), failed: count(p.failed) }),
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

/** `bytes` and the queue's length count what waits AND what is being appended - released once the append settles. */
interface Writer { queue: string[]; bytes: number; inFlight: number; dropped: number; busy: boolean; writes: number }
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
    const w = writers.get(root) ?? { queue: [], bytes: 0, inFlight: 0, dropped: 0, busy: false, writes: 0 }
    writers.set(root, w)
    if (w.queue.length + w.inFlight >= MAX_EVENTS || w.bytes + line.length > MAX_BYTES) { w.dropped++; return }
    w.queue.push(line); w.bytes += line.length
    if (!w.busy) { w.busy = true; setImmediate(() => void drain(root, w)) }
  } catch { /* the log never stands in the way */ }
}

async function drain(root: string, w: Writer): Promise<void> {
  const file = jamLog(root)
  try { mkdirSync(join(file, '..'), { recursive: true }) } catch { /* the append says */ }
  while (w.queue.length || w.dropped) {
    const lines = w.queue.splice(0)
    const held = lines.reduce((n, l) => n + l.length, 0)
    w.inFlight = lines.length
    if (w.dropped) { lines.push(JSON.stringify({ v: 1, ts: Date.now(), kind: 'dropped', count: w.dropped }) + '\n'); w.dropped = 0 }
    try {
      await appendFile(file, lines.join(''))
      // now and then: past its size, the oldest half goes
      if (++w.writes % 50 === 0 && (await stat(file)).size > MAX_FILE) {
        const all = (await readFile(file, 'utf8')).split('\n')
        await writeFile(file, all.slice(Math.floor(all.length / 2)).join('\n'))
      }
    } catch { /* lost - the operation it measured is not */ }
    // settled: what it held is free again
    w.inFlight = 0
    w.bytes = Math.max(0, w.bytes - held)
  }
  w.busy = false
}

/** Wait for every buffered event to be written (tests, and a server shutting down). */
export async function flushJam(root: string): Promise<void> {
  for (let i = 0; i < 200 && writers.get(root)?.busy; i++) await new Promise((r) => setTimeout(r, 10))
}

/** The log read back from `since` (epoch ms): malformed lines skipped. */
export function readJam(root: string, since = 0): { events: Record<string, any>[]; first?: number } {
  try {
    const all = readFileSync(jamLog(root), 'utf8').split('\n').flatMap((l) => {
      try { const e = JSON.parse(l); return e && typeof e.ts === 'number' ? [e] : [] } catch { return [] }
    })
    return { events: all.filter((e) => e.ts >= since), ...(all.length ? { first: all[0].ts } : {}) }
  } catch { return { events: [] } }
}
