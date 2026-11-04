/**
 * The perf logs, one JSON line per event in design/.local/perf/ - local, never committed, the owner's alone (the
 * directory 700, every file in it 600). `npx marver perf` reads them back.
 *  - reloads.jsonl, the reload log (spec 26 Part 1): the server's view (an edit and the frames it reached, a full
 *    reload sent or dropped) and the page's (each document that actually booted, and how long it took);
 *  - page.jsonl, the recorder's page half (spec 28 A1.7): what each board load did, from the page - its request and
 *    commit, each frame's outcome, every move and why, quiet, the last move and settled - plus gestures and
 *    errors. Each record is rebuilt from its kind's allowlist; `npx marver perf --loads` reads them back.
 *
 * Spec 30: every log is written and read through `perfLogs` (#1, #42) - one writer per file: a live file plus closed
 * segments, retention by age and the safety cap (perf-segments.ts); the records' shapes and bounds are
 * src/shared/perf-records.ts's. Each stream fills its own kinds' cleaners in `BODY`.
 */
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { checkRealDirs } from './boards.ts'
import { CMD_IN, CMD_OUTCOMES, CMD_PHASES, CMD_VIA, DEDUPE, DROP_REASONS as R30_DROP_REASONS, ERROR_SOURCES, HELD_BY, LOAD_TRIGGERS, LOAF, MODES, PAGE_KINDS as R30_PAGE_KINDS, RELOAD_BOUNDS, RENDERS, RESOURCE_TAGS, SELF_HOOKS, SHELL_RELOAD_KINDS, THEME_SCOPES, TRANSITION_OUTCOMES, WARNINGS, WRITER_ATTRIBUTION, type BatchAnswer, type BatchFailed, type SegmentedFile, type ShellReloadKind } from '../shared/perf-records.ts'
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
/** 0.29's sources and spec 30's (perf-records.ts) */
export const SOURCES = ERROR_SOURCES
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

// ---- spec 30, signals: the fields' own shapes (#29-#36)
const fixed = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : undefined)
const ROUTE_RE = /^[a-z0-9:._/-]{1,64}$/i, METHOD_RE = /^[A-Z]{3,7}$/, THEME_RE = /^[\w][\w .-]{0,63}$/
const status = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1000 ? v : undefined)
const epoch = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 1e12 && v < 1e14 ? Math.round(v) : undefined)
/** #29: a file inside the repo, relative to it; anything else as given - this Mac's own path, in the owner's own file. */
const repoFile = (v: unknown, root?: string) => {
  const f = str(v)
  if (!f || !root || !isAbsolute(f)) return f
  const rel = relative(root, f)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : f
}
/** #34 */
const scaleOf = (v: unknown) => {
  const o = obj(v), num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 1e4 ? Math.round(x * 1000) / 1000 : undefined)
  const from = num(o.from), to = num(o.to), min = num(o.min), max = num(o.max)
  return from !== undefined && to !== undefined && min !== undefined && max !== undefined ? { from, to, min, max } : undefined
}
/** #35: at most 3; a script's `src` a path (`/...`), never a query */
const loafs = (v: unknown) => {
  if (!Array.isArray(v)) return undefined
  const out = v.slice(0, LOAF.kept).flatMap((x) => {
    const o = obj(x), m = ms(o.ms)
    if (m === undefined) return []
    const c = obj(o.script), src = typeof c.src === 'string' && c.src.startsWith('/') ? c.src.split('?')[0].slice(0, 200) : undefined
    const script = o.script && ms(c.ms) !== undefined ? prune({ src, frame: str(c.frame), fn: str(c.fn, LOAF.fn), invoker: str(c.invoker, LOAF.fn), ms: ms(c.ms), where: str(c.where, 32) }) : undefined
    return [prune({ ms: m, blockMs: ms(o.blockMs), script })]
  })
  return out.length ? out : undefined
}

// ---- commands (spec 30 R12 #48-#52): names, key combinations, ids, counts and times - never a value (#4) -------------

/** A command's name or a code (its `why`, a step), as commands.ts writes them. */
const NAME = /^[a-z][a-z0-9-]{0,31}$/
/** `descriptor()`'s combination (jam-keys.ts:33): modifiers, then one key - one character or a named key. */
const KEYS = /^(?:Ctrl\+)?(?:Meta\+)?(?:Alt\+)?(?:Shift\+)?(?:[^\s]|[A-Z][A-Za-z0-9]{1,15})$/
/** A frame id (`scene/name`) or a node key. */
const FRAME = /^[A-Za-z0-9_~.:/-]{1,160}$/
const cmdName = (v: unknown) => (typeof v === 'string' && NAME.test(v) ? v : undefined)
/** `arg`: a fixed identifier (a setting's key, a Jam switch, a device, `2x`) - never a value (#4). */
const ARG = /^[a-z0-9][a-z0-9-]{0,31}$/
function cleanCmd(r: Record<string, unknown>): Record<string, unknown> | null {
  const phase = oneOf(r.phase, CMD_PHASES), cid = id(r.id), c = cmdName(r.cmd)
  if (!phase || !cid || !c) return null
  const via = oneOf(r.via, CMD_VIA), where = oneOf(r.in, CMD_IN)
  if (phase !== 'end' && (!via || !where)) return null
  const input = phase === 'end' ? {} : {
    via, in: where,
    keys: typeof r.keys === 'string' && KEYS.test(r.keys) ? r.keys : undefined,
    arg: typeof r.arg === 'string' && ARG.test(r.arg) ? r.arg : undefined, board: typeof r.board === 'string' && BOARD.test(r.board) ? r.board : undefined,
    frames: count(r.frames), frame: typeof r.frame === 'string' && FRAME.test(r.frame) ? r.frame : undefined,
  }
  if (phase === 'start') return { phase, id: cid, cmd: c, ...input }
  const outcome = oneOf(r.outcome, CMD_OUTCOMES)
  if (!outcome) return null
  const steps = Array.isArray(r.steps)
    ? r.steps.slice(0, 16).flatMap((x) => { const o = obj(x), n = cmdName(o.name), m = ms(o.ms); return n && m !== undefined ? [{ name: n, ms: m }] : [] })
    : []
  return { phase, id: cid, cmd: c, ...input, outcome, why: cmdName(r.why), ms: ms(r.ms) ?? 0, steps: steps.length ? steps : undefined, late: flag(r.late) }
}

/** Each kind's fields, rebuilt from what the page sent - anything else is left out; null = the record is dropped.
 *  `root`, the canvas's own folder, for the one field that names a file (#29). */
const BODY: Record<typeof PAGE_KINDS[number], (r: Record<string, unknown>, root?: string) => Record<string, unknown> | null> = {
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
    return type ? {
      type, ms: ms(r.ms), frames: count(r.frames), p50: tenth(r.p50), p95: tenth(r.p95), max: tenth(r.max), over17ms: count(r.over17ms), over33ms: count(r.over33ms), longFrames: count(r.longFrames), hz: hz(r.hz),
      scale: scaleOf(r.scale), visible: count(r.visible), awake: count(r.awake), loaf: loafs(r.loaf), by: id(r.by),
    } : null
  },
  error: (r, root) => {
    const source = oneOf(r.source, ERROR_SOURCES), message = str(r.message)
    const stack = Array.isArray(r.stack) ? r.stack.slice(0, 3).map((l) => str(l)).filter((l): l is string => !!l) : []
    if (!source || !message) return null
    const modes = Array.isArray(r.modes) ? [...new Set(r.modes.flatMap((m) => oneOf(m, MODES) ?? []))] : []
    return {
      source, frame: str(r.frame), component: str(r.component), message, stack: stack.length ? stack : undefined, late: flag(r.late),
      route: fixed(r.route, ROUTE_RE), method: fixed(r.method, METHOD_RE), status: r.status === 'timeout' ? 'timeout' : status(r.status), ms: ms(r.ms),
      tag: oneOf(r.tag, RESOURCE_TAGS), url: str(r.url)?.split(/[?#]/)[0], file: repoFile(str(r.file)?.split(/[?#]/)[0], root), plugin: str(r.plugin, 64), modes: modes.length ? modes : undefined,
    }
  },
  dropped: (r) => (count(r.n) === undefined ? null : { n: count(r.n), reason: oneOf(r.reason, DROP_REASONS) }),

  // ---- spec 30: each stream fills its own kinds (perf-records.ts has their fields); null drops the record until then
  // signals (R3-R6)
  renders: (r) => {
    const rows = Array.isArray(r.rows) ? r.rows.slice(0, RENDERS.rows + 1).flatMap((x) => {
      const o = obj(x), who = str(o.who, 64)
      return who ? [prune({ who, frame: str(o.frame), commits: count(o.commits), ms: tenth(o.ms), maxMs: tenth(o.maxMs), inGesture: count(o.inGesture), rows: count(o.rows) })] : []
    }) : []
    return rows.length && epoch(r.minute) !== undefined ? { minute: epoch(r.minute), rows } : null
  },
  warnings: (r) => {
    const top = Array.isArray(r.top) ? r.top.slice(0, WARNINGS.top).flatMap((x) => {
      const o = obj(x), node = str(o.node, 64), n = count(o.n)
      return node && n !== undefined ? [{ node, n }] : []
    }) : []
    return count(r.n) === undefined ? null : { n: count(r.n), top }
  },
  theme: (r) => {
    const t = id(r.t), scope = oneOf(r.scope, THEME_SCOPES), to = fixed(r.to, THEME_RE), outcome = oneOf(r.outcome, TRANSITION_OUTCOMES)
    return t && scope && to && outcome ? { t, scope, to, by: id(r.by), frames: count(r.frames), applied: count(r.applied), p50Ms: ms(r.p50Ms), maxMs: ms(r.maxMs), late: count(r.late), outcome } : null
  },
  mode: (r) => {
    const mode = oneOf(r.mode, MODES), phase = oneOf(r.phase, ['enter', 'exit'] as const), t = id(r.t)
    return mode && phase && t ? { mode, phase, t, by: id(r.by), shownMs: ms(r.shownMs), firstFrameMs: ms(r.firstFrameMs), frames: count(r.frames), outcome: oneOf(r.outcome, TRANSITION_OUTCOMES), heldMs: ms(r.heldMs), errors: count(r.errors) } : null
  },
  hmr: (r) => { const phase = oneOf(r.phase, ['lost', 'back'] as const); return phase ? { phase, downMs: ms(r.downMs) } : null },
  // commands (R12)
  cmd: (r) => cleanCmd(r),
  // app-store (R15 #58): the recorder's own cost over 5 minutes
  self: (r) => {
    const cpuMs = tenth(r.cpuMs), hooks = obj(r.hookMs)
    if (cpuMs === undefined) return null
    return { cpuMs, hookMs: prune(Object.fromEntries(SELF_HOOKS.map((k) => [k, tenth(hooks[k])]))), records: count(r.records), bytes: count(r.bytes), dropped: count(r.dropped) }
  },
}

/** A page record rebuilt from the envelope and its kind's allowlist, or null. Strings are cut to 200 characters. */
export function cleanPageRecord(raw: unknown, now = Date.now(), root?: string): Record<string, unknown> | null {
  const r = obj(raw)
  if (r.v !== 1) return null
  const kind = oneOf(r.kind, PAGE_KINDS)
  const ws = typeof r.ws === 'string' && WS.test(r.ws) ? r.ws : undefined
  const page = id(r.page), load = r.load === '-' ? '-' : id(r.load), seq = count(r.seq)
  if (!kind || !ws || !page || !load || seq === undefined) return null
  const body = BODY[kind](r, root)
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
  const recs = raws.slice(0, 5_000).flatMap((x) => { const c = cleanPageRecord(x, now, root); return c ? [o.run ? { ...c, run: o.run } : c] : [] })
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
  'shell-boot': (r) => ({ nav: oneOf(r.nav, NAV_TYPES), resumed: flag(r.resumed), prev: typeof r.prev === 'string' && ID.test(r.prev) ? r.prev : undefined }),
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
    return { node, frame: str(r.frame), hmrTs: ts, fetched: true, applyMs: ms(r.applyMs), nextObservedCommitMs: ms(r.nextObservedCommitMs), applied: r.applied, noAfterUpdate: flag(r.noAfterUpdate) }
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
  const recs = raws.slice(0, 5_000).flatMap((x) => { const c = cleanPageRecord(x, now, root); return c ? [o.run ? { ...c, run: o.run } : c] : [] })
  return writeBatch(root, 'page', recs, now, o.kept)
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
