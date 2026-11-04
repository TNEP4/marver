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
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { checkRealDirs } from './boards.ts'
import { DEDUPE, DROP_REASONS as R30_DROP_REASONS, HELD_BY, LOAD_TRIGGERS, PAGE_KINDS as R30_PAGE_KINDS, RELOAD_BOUNDS, SHELL_RELOAD_KINDS, WRITER_ATTRIBUTION, type BatchAnswer, type BatchFailed, type ShellReloadKind } from '../shared/perf-records.ts'

const MAX = 2_000_000   // past this the oldest half goes: the log answers "what happened lately"
/** page.jsonl's: one load of a 120-frame board writes ~140 KB (two thirds of it moves), so 2 MB held about fourteen
 *  such loads - hours, not the 14 days the lines may stay. 8 MB holds four times as many. */
const PAGE_MAX = 8_000_000
const maxOf = (file: string) => (basename(file) === 'page.jsonl' ? PAGE_MAX : MAX)
const KEEP_MS = 14 * 86_400_000
/** The logs whose lines age out and whose size is held at start (spec 28 A1.7, A1.13): every one with a `ts` per line. */
const AGED = ['reloads.jsonl', 'page.jsonl', 'runs.jsonl', 'jam.jsonl']

export const perfDir = (root: string) => join(root, 'design', '.local', 'perf')
export const reloadLog = (root: string) => join(perfDir(root), 'reloads.jsonl')
export const pageLog = (root: string) => join(perfDir(root), 'page.jsonl')
/** runs.jsonl, the headless runs' lines (spec 28 A3.4, A3.8 #22): 2 MB, 14 days, in tidyPerfDir like the others. */
export const runsLog = (root: string) => join(perfDir(root), 'runs.jsonl')

/** design/, design/.local and its perf/ must be real directories inside the project: a log is never written through a link. */
const unsafe = (root: string) => checkRealDirs(root, [[join(root, 'design'), 'design'], [join(root, 'design', '.local'), 'design/.local'], [perfDir(root), 'design/.local/perf']])

/** One append to a perf log: the directory 700 and the file 600 from their creation, never through a link, the
 *  oldest half gone past its cap (maxOf). Throws - callers swallow. */
function appendLog(root: string, file: string, text: string): void {
  const why = unsafe(root)
  if (why) throw new Error(why)
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  mkdirSync(perfDir(root), { recursive: true, mode: 0o700 })
  if (existsSync(file)) {
    if (!lstatSync(file).isFile()) throw new Error('not a regular file')
    if (statSync(file).size > maxOf(file)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n'))
    }
  }
  appendFileSync(file, text, { mode: 0o600 })
}

const readLines = (file: string, since: number): Record<string, any>[] => {
  try {
    return readFileSync(file, 'utf8').split('\n').flatMap((l) => {
      try { const e = JSON.parse(l); return typeof e?.ts === 'number' && e.ts >= since ? [e] : [] } catch { return [] }
    })
  } catch { return [] }
}

// ---- the writer and the reader (spec 30 #1, #42) ------------------------------------------------------------------

/** The logs this writer owns, by name; jam.jsonl has its own (perf-jam.ts), under the same rules. */
export type PerfLog = 'page' | 'reloads' | 'runs'
const fileOf = (root: string, log: PerfLog) => (log === 'page' ? pageLog(root) : log === 'reloads' ? reloadLog(root) : runsLog(root))

/**
 * The one way a perf log is written and read back. Today: one file each, its oldest half gone past its cap. The
 * app-store stream reimplements both behind these signatures (R9): a live file plus closed segments named
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
export const perfLogs: PerfLogs = {
  append(root, log, lines) { if (lines.length) appendLog(root, fileOf(root, log), lines.join('\n') + '\n') },
  read(root, log, since = 0) { return readLines(fileOf(root, log), since) },
}

export function logReload(root: string, entry: Record<string, unknown>): void {
  try { perfLogs.append(root, 'reloads', [JSON.stringify({ ts: Date.now(), ...entry })]) } catch { /* the log never stands in the way of the canvas */ }
}

/** Lines of one event, one append and one time (spec 30 #10, #12): a list and its parts stay together. Never retried. */
export function logReloadLines(root: string, entries: readonly Record<string, unknown>[]): void {
  const ts = Date.now()
  try { perfLogs.append(root, 'reloads', entries.map((e) => JSON.stringify({ ts, ...e }))) } catch { /* the log never stands in the way of the canvas */ }
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

/** #18: a load's candidate writers: at most 8, each its page and at most 8 command ids, and their count. */
const writers = (v: unknown) => {
  if (!Array.isArray(v)) return undefined
  const out = v.slice(0, RELOAD_BOUNDS.candidates).flatMap((x) => {
    const c = obj(x), page = id(c.page), cmds = Array.isArray(c.cmds) ? c.cmds.slice(0, RELOAD_BOUNDS.candidates).flatMap((y) => id(y) ?? []) : []
    return page ? [{ page, cmds, n: Math.max(count(c.n) ?? 0, cmds.length) }] : []
  })
  return out.length ? out : undefined
}

/** Each kind's fields, rebuilt from what the page sent - anything else is left out; null = the record is dropped. */
const BODY: Record<typeof PAGE_KINDS[number], (r: Record<string, unknown>) => Record<string, unknown> | null> = {
  load: (r) => {
    const board = typeof r.board === 'string' && BOARD.test(r.board) ? r.board : undefined, c = oneOf(r.cause, LOAD_CAUSES), request = id(r.request)
    return board && c && request ? { board, cause: c, request, sinceNav: ms(r.sinceNav), trigger: oneOf(r.trigger, LOAD_TRIGGERS), writer: oneOf(r.writer, WRITER_ATTRIBUTION), candidates: writers(r.candidates), by: id(r.by) } : null
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
  cut: (r) => { const reason = oneOf(r.reason, CUT_REASONS); return reason ? { reason, request: id(r.request), ms: ms(r.ms), lastMove: ms(r.lastMove), frames: count(r.frames), ready: count(r.ready), visibleReadyMs: ms(r.visibleReadyMs), allReadyMs: ms(r.allReadyMs), visibleReady: count(r.visibleReady) } : null },
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

// ---- spec 30 R1, R2: the shell's reload lines, and acknowledged delivery (#7, #16) ------------------------------------

/** A revision: the dev server's boot, and its send's number (plugin.ts). */
const REVISION = /^\d{1,24}:\d{1,9}$/
const revision = (v: unknown) => (typeof v === 'string' && REVISION.test(v) ? v : undefined)
const NAV_TYPES = ['navigate', 'reload', 'back_forward', 'prerender'] as const
const WATCHDOG_ACTIONS = ['retry', 'gave-up'] as const
/** Vite's timestamp, epoch ms */
const hmrTs = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e14 ? Math.round(v) : undefined)
const strings = (v: unknown, n = RELOAD_BOUNDS.idsPerLine) => (Array.isArray(v) ? v.slice(0, n).flatMap((x) => str(x) ?? []) : [])

/** A shell line's fields by kind; null = dropped. `dropped` is R13's own: what the reload Outbox lost, counted (#5). */
const SHELL_BODY: Record<ShellReloadKind | 'dropped', (r: Record<string, unknown>) => Record<string, unknown> | null> = {
  'shell-boot': (r) => ({ nav: oneOf(r.nav, NAV_TYPES), resumed: flag(r.resumed) }),
  ready: (r) => {
    const node = str(r.node)
    if (!node) return null
    const revisions = Array.isArray(r.revisions) ? r.revisions.slice(0, RELOAD_BOUNDS.idsPerLine).flatMap((x) => revision(x) ?? []) : undefined
    return { cause: cause(r.cause), node, frame: str(r.frame), shown: str(r.shown), ms: ms(r.ms), revisions, queuedMs: ms(r.queuedMs), bootMs: ms(r.bootMs), heldBy: oneOf(r.heldBy, HELD_BY), asleep: flag(r.asleep) }
  },
  settled: (r) => { const node = str(r.node); return node ? { node, frame: str(r.frame), ms: ms(r.ms) } : null },
  invalidated: (r) => {
    const rev = revision(r.revision), h = obj(r.held)
    return rev ? { revision: rev, asked: count(r.asked), offBoard: count(r.offBoard), onBoard: count(r.onBoard), awake: count(r.awake), asleep: count(r.asleep), held: prune(Object.fromEntries(HELD_BY.map((k) => [k, count(h[k])]))), parts: count(r.parts) } : null
  },
  'invalidated-nodes': (r) => { const rev = revision(r.revision); return rev ? { revision: rev, part: count(r.part), parts: count(r.parts), nodes: strings(r.nodes) } : null },
  inplace: (r) => {
    const node = str(r.node), ts = hmrTs(r.hmrTs)
    // what was seen, no more (#15): `applied` is never true, and a line that says nothing was fetched is no line
    if (!node || ts === undefined || r.fetched !== true || (r.applied !== 'unknown' && r.applied !== false)) return null
    return { node, frame: str(r.frame), hmrTs: ts, fetched: true, applyMs: ms(r.applyMs), nextObservedCommitMs: ms(r.nextObservedCommitMs), applied: r.applied }
  },
  watchdog: (r) => { const node = str(r.node), action = oneOf(r.action, WATCHDOG_ACTIONS); return node && action ? { node, frame: str(r.frame), nav: count(r.nav), action } : null },
  dropped: (r) => (count(r.n) === undefined ? null : { n: count(r.n), reason: oneOf(r.reason, DROP_REASONS) }),
}
const SHELL_KINDS = [...SHELL_RELOAD_KINDS, 'dropped'] as const

/** A shell line rebuilt from its envelope and its kind's allowlist, or null (#16, as `cleanPageRecord`). */
export function cleanReloadRecord(raw: unknown, now = Date.now()): Record<string, unknown> | null {
  const r = obj(raw)
  const kind = oneOf(r.kind, SHELL_KINDS), page = id(r.page), seq = count(r.seq)
  if (!kind || !page || seq === undefined) return null
  const body = SHELL_BODY[kind](r)
  if (!body) return null
  const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) && Math.abs(r.ts - now) < 86_400_000 ? Math.round(r.ts) : now
  return { ts, kind, tab: str(r.tab, 16), page, seq, ...prune(body) }
}

/** #7: the `(page, seq)` a server wrote - best effort: 10 minutes, 4,096 per page, 64 pages. One window for both logs,
 *  whose records share one seq per page. Every reader dedupes again: a retry past it, or after an eviction, is written
 *  twice. Oldest first, by Map order. */
const written = new Map<string, Map<number, number>>()
const wroteLately = (root: string, page: string, seq: number, now: number): boolean => {
  const at = written.get(`${root}\0${page}`)?.get(seq)
  return at !== undefined && now - at < DEDUPE.windowMs
}
function rememberWrites(root: string, recs: readonly Record<string, unknown>[], now: number): void {
  for (const r of recs) {
    const key = `${root}\0${r.page as string}`
    const seqs = written.get(key) ?? new Map<number, number>()
    written.delete(key)   // newest last: the page evicted first is the one that wrote longest ago
    written.set(key, seqs)
    seqs.delete(r.seq as number)
    seqs.set(r.seq as number, now)
    if (seqs.size > DEDUPE.perPage) seqs.delete(seqs.keys().next().value!)
    if (written.size > DEDUPE.pages) written.delete(written.keys().next().value!)
  }
}

/** failed appends, by project (#7): each 503 says the count so far */
const failures = new Map<string, number>()
export const failedWrites = (root: string): number => failures.get(root) ?? 0

/** A batch into its log: duplicates dropped, the answer only after the append returned. `kept` receives what was written.
 *  An append that failed is `BatchFailed`, and remembers nothing: the retry writes it. */
function writeBatch(root: string, log: 'page' | 'reloads', recs: readonly Record<string, unknown>[], now: number, kept?: (recs: Record<string, unknown>[]) => void): BatchAnswer | BatchFailed {
  const inBatch = new Set<string>()
  const fresh = recs.filter((r) => {
    const k = `${r.page as string}:${r.seq as number}`
    if (inBatch.has(k) || wroteLately(root, r.page as string, r.seq as number, now)) return false
    inBatch.add(k)
    return true
  })
  if (fresh.length) {
    try { perfLogs.append(root, log, fresh.map((r) => JSON.stringify(r))) }
    catch {
      const n = failedWrites(root) + 1
      failures.set(root, n)
      return { error: 'the perf log could not be written', failedWrites: n }
    }
    rememberWrites(root, fresh, now)
    kept?.(fresh)
  }
  return { ok: true, accepted: fresh.length, duplicates: recs.length - fresh.length }
}

/** `POST perf/reload`'s batch (#16). */
export function takeReloadBatch(root: string, raws: unknown[], now = Date.now()): BatchAnswer | BatchFailed {
  return writeBatch(root, 'reloads', raws.slice(0, 5_000).flatMap((x) => { const c = cleanReloadRecord(x, now); return c ? [c] : [] }), now)
}
/** `POST perf/page`'s batch (#7): as `logPage`, a headless run's records stamped after the cleaner. */
export function takePageBatch(root: string, raws: unknown[], o: { run?: string; kept?: (records: Record<string, unknown>[]) => void } = {}, now = Date.now()): BatchAnswer | BatchFailed {
  const recs = raws.slice(0, 5_000).flatMap((x) => { const c = cleanPageRecord(x, now); return c ? [o.run ? { ...c, run: o.run } : c] : [] })
  return writeBatch(root, 'page', recs, now, o.kept)
}

/** One run line into runs.jsonl (spec 28 A3.8 #22) - best effort. A cancelled run writes its line too. */
export function appendRun(root: string, line: Record<string, unknown>): boolean {
  try { perfLogs.append(root, 'runs', [JSON.stringify(line)]); return true } catch { return false }
}
/** The run lines from `since` (epoch ms): malformed lines skipped. */
export const readRuns = (root: string, since = 0): Record<string, any>[] => perfLogs.read(root, 'runs', since)

/** At start (spec 28 A1.7): design/.local/perf/ is the owner's alone - the directory 700 and every file in it 600,
 *  those earlier versions created without modes included - and the logs whose lines age out lose the ones older than
 *  14 days and, still past their cap (2 MB; page.jsonl 8 MB), their oldest half. Synchronous, before the server
 *  listens: no append of this process interleaves. Best effort; a link is never followed. */
export function tidyPerfDir(root: string, now = Date.now()): void {
  try {
    if (unsafe(root)) return
    const dir = perfDir(root)
    let st
    try { st = lstatSync(dir) } catch { return }   // none yet: the first write makes it 700
    if (!st.isDirectory()) return
    chmodSync(dir, 0o700)
    for (const name of readdirSync(dir)) {
      const f = join(dir, name)
      try {
        if (!lstatSync(f).isFile()) continue
        chmodSync(f, 0o600)
        if (!AGED.includes(name)) continue
        const text = readFileSync(f, 'utf8')
        let lines = text.split('\n').filter((l) => { try { const e = JSON.parse(l); return typeof e?.ts === 'number' && e.ts >= now - KEEP_MS } catch { return false } })
        if (Buffer.byteLength(lines.join('\n')) > maxOf(name)) lines = lines.slice(Math.floor(lines.length / 2))
        const next = lines.length ? lines.join('\n') + '\n' : ''
        if (next === text) continue
        const tmp = `${f}.${process.pid}.tmp`
        writeFileSync(tmp, next, { mode: 0o600 })
        renameSync(tmp, f)
      } catch { /* the next file */ }
    }
  } catch { /* never in the way of the canvas */ }
}
