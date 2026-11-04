/**
 * The perf logs, one JSON line per event in design/.local/perf/ - local, never committed, the owner's alone (the
 * directory 700, every file in it 600). `npx marver perf` reads them back.
 *  - reloads.jsonl, the reload log (spec 26 Part 1): the server's view (an edit and the frames it reached, a full
 *    reload sent or dropped) and the page's (each document that actually booted, and how long it took);
 *  - page.jsonl, the recorder's page half (spec 28 A1.7): what each board load did, from the page - its request and
 *    commit, each frame's outcome, every move and why, quiet, the last move and settled - plus gestures and
 *    errors. Each record is rebuilt from its kind's allowlist; `npx marver perf --loads` reads them back.
 *
 * Spec 30: every log is written and read through `perfLogs` (#1, #42) - one writer per file, which the app-store
 * stream reimplements with segments, retention by age and the safety cap, behind the same two calls; the records'
 * shapes and bounds are src/shared/perf-records.ts's. Each stream fills its own kinds' cleaners in `BODY`.
 */
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkRealDirs } from './boards.ts'
import { DROP_REASONS as R30_DROP_REASONS, PAGE_KINDS as R30_PAGE_KINDS, SELF_HOOKS, type SegmentedFile } from '../shared/perf-records.ts'
import { adoptLive, closeLive, dueToClose, enforceCap, lineTs, pruneAged, readSegmentedRecords, type LiveState } from './perf-segments.ts'
import { tidyJam } from './perf-jam.ts'

export const perfDir = (root: string) => join(root, 'design', '.local', 'perf')
export const reloadLog = (root: string) => join(perfDir(root), 'reloads.jsonl')
export const pageLog = (root: string) => join(perfDir(root), 'page.jsonl')
/** runs.jsonl, the headless runs' lines (spec 28 A3.4, A3.8 #22): segments and 14 days like the others (spec 30 R9). */
export const runsLog = (root: string) => join(perfDir(root), 'runs.jsonl')

/** design/, design/.local and its perf/ must be real directories inside the project: a log is never written through a link. */
const unsafe = (root: string) => checkRealDirs(root, [[join(root, 'design'), 'design'], [join(root, 'design', '.local'), 'design/.local'], [perfDir(root), 'design/.local/perf']])

// ---- the writer and the reader (spec 30 #1, #42) ------------------------------------------------------------------

/** The logs this writer owns, by name; jam.jsonl has its own (perf-jam.ts), under the same rules. */
export type PerfLog = 'page' | 'reloads' | 'runs'
const FILE: Record<PerfLog, SegmentedFile> = { page: 'page.jsonl', reloads: 'reloads.jsonl', runs: 'runs.jsonl' }
const LOGS = Object.keys(FILE) as PerfLog[]
/** Retention runs at start and then hourly, in the writer's own turn (an append), never on a timer of its own. */
export const PRUNE_EVERY_MS = 3_600_000

/**
 * The one way a perf log is written and read back (spec 30 R9): a live file plus closed segments named
 * `<name>.<openedAt>-<bound>.jsonl` (perf-records.ts `segmentName`), deleted whole by age in the writer's own order,
 * the safety cap's counted drop - so no caller ever names a file or knows about segments.
 */
export interface PerfLogs {
  /** Whole lines (none holding a newline), appended in order, synchronously. Throws when the append failed: nothing is
   *  retried here - a batch route answers 503 (#7), a server line is lost and never retried. */
  append(root: string, log: PerfLog, lines: readonly string[]): void
  /** Every line with a numeric `ts` from `since` (epoch ms) on - every segment in `openedAt` order, then the live
   *  file; malformed lines skipped. Readers dedupe page and shell lines by `(page, seq)` themselves (#7). */
  read(root: string, log: PerfLog, since?: number): Record<string, any>[]
}

/**
 * The writer's state: each live file it knows (when it was opened, the largest `ts` written into it, its size) and
 * when each directory was last pruned. Synchronous, so every close, prune and cap runs between two appends - the
 * writer's own queue (#42). One writer per root: the dev server.
 */
const lives = new Map<string, LiveState>()
const prunedAt = new Map<string, number>()

/** Test seam: the writer's clock (retention and the 24 h close read it), and its state forgotten (a restart). */
export const perfLogSeams: { now?: () => number; reset(): void } = { reset() { lives.clear(); prunedAt.clear() } }
const clock = () => (perfLogSeams.now ?? Date.now)()

/** The live file's state: what this writer tracked, else adopted from the disk (#42, #45), else none. A file replaced
 *  behind the writer's back (another inode) is adopted again. */
function liveOf(path: string): LiveState | null {
  const known = lives.get(path)
  let st
  try { st = lstatSync(path) } catch { lives.delete(path); return null }
  if (!st.isFile()) throw new Error('not a regular file')
  if (known && known.ino === st.ino) { known.size = st.size; return known }
  const s = adoptLive(path)
  if (s) lives.set(path, s); else lives.delete(path)
  return s
}

/** One log's upkeep (#42, #43): a live file opened 24 h ago or past its size closed; segments past the days kept
 *  unlinked; the oldest gone while the file passes its cap, then a counted `dropped` line. Never throws. */
function upkeep(root: string, log: PerfLog, now: number, prune: boolean): void {
  const dir = perfDir(root), file = FILE[log], path = join(dir, file)
  try {
    const s = liveOf(path)
    let closed = false
    if (s && dueToClose(file, s, now)) { closeLive(dir, file, s, now); lives.delete(path); closed = true }
    if (prune) pruneAged(dir, file, now)
    if (prune || closed) {
      const went = enforceCap(dir, file, lives.get(path)?.size ?? 0)
      if (went.segments) write(root, log, [JSON.stringify(droppedLine(log, went.lines, now))], now)
    }
  } catch { /* the log never stands in the way of the canvas */ }
}

/** The safety cap's line (#43): page.jsonl's names no page (it is the server's), runs.jsonl's no run. */
const droppedLine = (log: PerfLog, n: number, now: number) => (log === 'reloads' ? { ts: now, kind: 'dropped', n, reason: 'retention-cap' } : { v: 1, ts: now, kind: 'dropped', n, reason: 'retention-cap' })

/** The append itself: the directory 700 and the file 600 from their creation, never through a link. */
function write(root: string, log: PerfLog, lines: readonly string[], now: number): void {
  const dir = perfDir(root), path = join(dir, FILE[log])
  const s = liveOf(path)
  const text = lines.join('\n') + '\n'
  appendFileSync(path, text, { mode: 0o600 })
  let max = 0
  for (const l of lines) { const t = lineTs(l); if (t !== null && t > max) max = t }
  const st = lstatSync(path)
  if (s && s.ino === st.ino) { s.size = st.size; s.maxTs = Math.max(s.maxTs, max) }
  else lives.set(path, { openedAt: now, maxTs: max, adopted: false, size: st.size, ino: st.ino })
}

/** One append to a perf log (#42): a due close first, retention hourly, then the lines; past its segment size the live
 *  file closes at once. Throws when the append failed - callers swallow, or answer 503. */
function appendLog(root: string, log: PerfLog, lines: readonly string[]): void {
  const why = unsafe(root)
  if (why) throw new Error(why)
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  mkdirSync(perfDir(root), { recursive: true, mode: 0o700 })
  const now = clock()
  const dir = perfDir(root)
  const prune = now - (prunedAt.get(dir) ?? 0) >= PRUNE_EVERY_MS
  if (prune) { prunedAt.set(dir, now); for (const l of LOGS) upkeep(root, l, now, true) }
  else upkeep(root, log, now, false)
  write(root, log, lines, now)
  upkeep(root, log, now, false)
}

export const perfLogs: PerfLogs = {
  append(root, log, lines) { if (lines.length) appendLog(root, log, lines) },
  read(root, log, since = 0) { return readSegmentedRecords(perfDir(root), FILE[log], since) },
}

export function logReload(root: string, entry: Record<string, unknown>): void {
  try { perfLogs.append(root, 'reloads', [JSON.stringify({ ts: Date.now(), ...entry })]) } catch { /* the log never stands in the way of the canvas */ }
}

export const readReloads = (root: string, since = 0): Record<string, any>[] => perfLogs.read(root, 'reloads', since)
/** The page's records from `since` (epoch ms): malformed lines skipped. */
export const readPage = (root: string, since = 0): Record<string, any>[] => perfLogs.read(root, 'page', since)

// ---- the recorder's page half (spec 28 A1.7) ----------------------------------------------------------------------

/** What one request may carry. */
export const PAGE_BODY_MAX = 512 * 1024
/** 0.29's kinds and spec 30's, one list with the page's (perf-records.ts) */
export const PAGE_KINDS = R30_PAGE_KINDS
export const LOAD_CAUSES = ['boot', 'switch', 'disk-reload'] as const
export const CUT_REASONS = ['switch', 'reload', 'hidden', 'timeout', 'superseded', 'error', 'edited', 'unsaved'] as const
export const OUTCOMES = ['settled', 'ready', 'missing', 'error', 'never-ready', 'cut'] as const
export const GESTURES = ['pan', 'zoom', 'layout'] as const
export const SOURCES = ['shell', 'frame', 'stage'] as const
/** why records were dropped, when it is not the queue's bound or a failed send: errors past a load's 50, and spec 30's
 *  sources, commands, transitions and the safety cap (perf-records.ts) */
export const DROP_REASONS = R30_DROP_REASONS

// each id in its own generated format - free text never passes as one
const ID = /^[0-9a-f]{12}$/, WS = /^[0-9a-f]{16}$/
const CAUSE = /^[a-z][a-z0-9:+-]{0,63}$/
const BOARD = /^(?:~unplaced|[a-z0-9][a-z0-9-]{0,63})$/
const str = (v: unknown, n = 200) => (typeof v === 'string' && v ? v.slice(0, n) : undefined)
const id = (v: unknown) => (typeof v === 'string' && ID.test(v) ? v : undefined)
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e7 ? v : undefined)
const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v) : undefined)
const tenth = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e7 ? Math.round(v * 10) / 10 : undefined)
/** the display's refresh rate the Mac app told the shell (spec 28 A3.8 #9): 1-1000 Hz */
const hz = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 1000 ? Math.round(v) : undefined)
const delta = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7 ? Math.round(v) : undefined)
const flag = (v: unknown) => (v === true ? true : undefined)
const oneOf = <T extends string>(v: unknown, set: readonly T[]) => (typeof v === 'string' && (set as readonly string[]).includes(v) ? (v as T) : undefined)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const prune = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined))
const cause = (v: unknown) => (typeof v === 'string' && CAUSE.test(v) ? v : undefined)

/** Each kind's fields, rebuilt from what the page sent - anything else is left out; null = the record is dropped. */
const BODY: Record<typeof PAGE_KINDS[number], (r: Record<string, unknown>) => Record<string, unknown> | null> = {
  load: (r) => {
    const board = typeof r.board === 'string' && BOARD.test(r.board) ? r.board : undefined, c = oneOf(r.cause, LOAD_CAUSES), request = id(r.request)
    return board && c && request ? { board, cause: c, request, sinceNav: ms(r.sinceNav) } : null
  },
  commit: (r) => {
    const k = obj(r.byKind)
    return { request: id(r.request), ms: ms(r.ms), frames: count(r.frames), byKind: prune({ hifi: count(k.hifi), content: count(k.content), html: count(k.html), image: count(k.image) }), measuring: count(r.measuring), savedHeights: count(r.savedHeights), late: flag(r.late) }
  },
  visible: (r) => ({ nodes: count(r.nodes), ms: ms(r.ms), assumed: flag(r.assumed) }),
  frame: (r) => {
    const node = str(r.node), outcome = oneOf(r.outcome, OUTCOMES)
    return node && outcome ? { node, frame: str(r.frame), gen: str(r.gen, 32), boot: str(r.boot, 32), admitted: ms(r.admitted), ready: ms(r.ready), firstMeasure: ms(r.firstMeasure), settled: ms(r.settled), outcome, kept: flag(r.kept) } : null
  },
  move: (r) => {
    const node = str(r.node), c = cause(r.cause)
    return node && c ? { node, dx: delta(r.dx), dy: delta(r.dy), dw: delta(r.dw), dh: delta(r.dh), cause: c, late: flag(r.late) } : null
  },
  quiet: (r) => (ms(r.ms) === undefined ? null : { ms: ms(r.ms) }),
  settled: (r) => {
    if (ms(r.ms) === undefined) return null
    const w = obj(r.weight)
    return {
      ms: ms(r.ms), moves: count(r.moves), distance: count(r.distance), lastMove: ms(r.lastMove),
      causes: Object.fromEntries(Object.entries(obj(r.causes)).slice(0, 32).flatMap(([k, n]) => (cause(k) && count(n) !== undefined ? [[k, n]] : []))),
      visibleReadyMs: ms(r.visibleReadyMs), allReadyMs: ms(r.allReadyMs), missing: count(r.missing), neverReady: count(r.neverReady), errors: count(r.errors),
      weight: prune({ domNodes: count(w.domNodes), iframes: count(w.iframes), awake: count(w.awake), asleep: count(w.asleep), heapMB: tenth(w.heapMB) }),
    }
  },
  cut: (r) => { const reason = oneOf(r.reason, CUT_REASONS); return reason ? { reason, request: id(r.request), ms: ms(r.ms), lastMove: ms(r.lastMove), frames: count(r.frames), ready: count(r.ready) } : null },
  // spec 30: `load` and `cut` above are the edits stream's to extend (#17-#19); `gesture` and `error` below the signals
  // stream's (#27-#35)
  gesture: (r) => {
    const type = oneOf(r.type, GESTURES)
    return type ? { type, ms: ms(r.ms), frames: count(r.frames), p50: tenth(r.p50), p95: tenth(r.p95), max: tenth(r.max), over17ms: count(r.over17ms), over33ms: count(r.over33ms), longFrames: count(r.longFrames), hz: hz(r.hz) } : null
  },
  error: (r) => {
    const source = oneOf(r.source, SOURCES), message = str(r.message)
    const stack = Array.isArray(r.stack) ? r.stack.slice(0, 3).map((l) => str(l)).filter((l): l is string => !!l) : []
    return source && message ? { source, frame: str(r.frame), component: str(r.component), message, stack: stack.length ? stack : undefined, late: flag(r.late) } : null
  },
  dropped: (r) => (count(r.n) === undefined ? null : { n: count(r.n), reason: oneOf(r.reason, DROP_REASONS) }),

  // ---- spec 30: each stream fills its own kinds (perf-records.ts has their fields); null drops the record until then
  // signals (R3-R6)
  renders: () => null,
  warnings: () => null,
  theme: () => null,
  mode: () => null,
  hmr: () => null,
  // commands (R12)
  cmd: () => null,
  // app-store (R15)
  self: () => null,
}

/** A page record rebuilt from the envelope and its kind's allowlist, or null. Strings are cut to 200 characters. */
export function cleanPageRecord(raw: unknown, now = Date.now()): Record<string, unknown> | null {
  const r = obj(raw)
  if (r.v !== 1) return null
  const kind = oneOf(r.kind, PAGE_KINDS)
  const ws = typeof r.ws === 'string' && WS.test(r.ws) ? r.ws : undefined
  const page = id(r.page), load = r.load === '-' ? '-' : id(r.load), seq = count(r.seq)
  if (!kind || !ws || !page || !load || seq === undefined) return null
  const body = BODY[kind](r)
  if (!body) return null
  // the page's clock is this Mac's: when the event happened, kept across a send that waited - a value far off is
  // the server's receipt instead
  const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) && Math.abs(r.ts - now) < 86_400_000 ? Math.round(r.ts) : now
  return { v: 1, ws, page, load, seq, ts, kind, ...prune(body) }
}

/**
 * The page's records into design/.local/perf/page.jsonl - best effort; how many were kept. A headless run's records
 * are stamped with its `run` here, by the server and after the cleaner (spec 28 A3.8 #17): a page never names its
 * run - the cleaner rebuilds every record from its kind's allowlist, so a `run` a page sent is gone. `kept` (when
 * given) receives the cleaned records, for the run's collector.
 */
export function logPage(root: string, raws: unknown[], o: { run?: string; kept?: (records: Record<string, unknown>[]) => void } = {}): number {
  const now = Date.now()
  const recs = raws.slice(0, 5_000).flatMap((x) => { const c = cleanPageRecord(x, now); return c ? [o.run ? { ...c, run: o.run } : c] : [] })
  if (!recs.length) return 0
  try { perfLogs.append(root, 'page', recs.map((c) => JSON.stringify(c))) } catch { return 0 }
  o.kept?.(recs)
  return recs.length
}

/** One run line into runs.jsonl (spec 28 A3.8 #22) - best effort. A cancelled run writes its line too. */
export function appendRun(root: string, line: Record<string, unknown>): boolean {
  try { perfLogs.append(root, 'runs', [JSON.stringify(line)]); return true } catch { return false }
}
/** The run lines from `since` (epoch ms): malformed lines skipped. */
export const readRuns = (root: string, since = 0): Record<string, any>[] => perfLogs.read(root, 'runs', since).filter((l) => typeof l.run === 'string')

/**
 * At start (spec 28 A1.7, spec 30 R9): design/.local/perf/ is the owner's alone - the directory 700 and every file in it
 * 600, those earlier versions created without modes included. Then each log's upkeep, as the writer does it hourly: a
 * live file opened 24 h ago or past its size closed - a 0.29 file is closed as a segment, `openedAt` its first line's
 * `ts` and `bound` its mtime + 24 h (#45) - segments past 14 days unlinked, the safety cap. Nothing is rewritten.
 * jam.jsonl's upkeep is queued in its own writer (perf-jam.ts). Synchronous, before the server listens. Best effort; a
 * link is never followed.
 */
export function tidyPerfDir(root: string, now = clock()): void {
  try {
    if (unsafe(root)) return
    const dir = perfDir(root)
    let st
    try { st = lstatSync(dir) } catch { return }   // none yet: the first write makes it 700
    if (!st.isDirectory()) return
    chmodSync(dir, 0o700)
    for (const name of readdirSync(dir)) {
      const f = join(dir, name)
      try { if (lstatSync(f).isFile()) chmodSync(f, 0o600) } catch { /* the next file */ }
    }
    prunedAt.set(dir, now)
    for (const log of LOGS) upkeep(root, log, now, true)
    tidyJam(root, now)
  } catch { /* never in the way of the canvas */ }
}
