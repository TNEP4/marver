/**
 * Resolve all comments, and its Undo (spec 31 B.1-B.5) - one core for the dev server's routes and the CLI.
 *
 * Scope is what you see, never a log: a board = the open threads on frames that board shows; a folder = the union
 * over its boards, sub-folders included; a scene = the threads on that scene's frames; a frame = its own threads (the
 * sidebar's frame row, 0.33); the canvas = every open
 * thread. Each resolve is written to its thread's own log, so it is the same as resolving each by hand - Jam's
 * `asks`, `review` and `failed` items on it complete when the queue ingests it - except live work: a thread whose
 * Jam card is queued or working (or whose tag is written and not yet queued) is skipped and counted. The check and
 * the appends run in one synchronous step: nothing is awaited between them, so no ingest slips a card in.
 *
 * Every operation has a client id (`op`): a retry returns the same receipt. The receipt names, per thread, its log,
 * its resolve event and that event's time (after everything the thread held, whatever clock wrote it); Undo reopens a
 * thread only while that resolve is still its latest event of any kind, and says how many changed since. Jam items a resolve completed stay completed - Undo reopens conversations only.
 *
 * Receipts live in `design/.local/comment-ops/` (never synced). Event ids are derived from the op, so a crash
 * between the appends and the receipt is retried onto the same ids (appendEvents keeps one of each).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvents, listBoards, readLog, replay, type CommentEvent } from './comments.ts'
import { checkBoardsDir, listBoardFiles, readRegistry, boardFields } from './boards.ts'
import { scanFrames } from './manifest.ts'
import { buildTree, flatten, framesOn, isBoardName, type TreeItem } from '../shared/board-tree.ts'
import { readRaw } from './jam/journal.ts'
import { ctxFor, liveThreads } from './jam/queue.ts'

export type Scope = { board: string } | { folder: string } | { scene: string } | { frame: string } | { canvas: true }
export const OP_RE = /^[\w-]{8,64}$/
const SCENE_RE = /^[A-Za-z0-9_][\w.-]*$/
/** A frame id: its path under design/scenes/, without the extension (`website-v2/7-urls`). Only its shape is checked
 *  here - any name the manifest scans (`demo/-draft`, `demo/café`) - since scopeFrames takes exactly the manifest's ids:
 *  slash-separated, no empty, `.` or `..` segment, no backslash or NUL. */
const isFrameId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 300 && !/[\\\0]/.test(v) && v.split('/').every((p) => p !== '' && p !== '.' && p !== '..')

/** Exactly one scope, every name on its grammar - else what is wrong. An empty or malformed one is refused,
 *  never read as the whole canvas. */
export function parseScope(raw: unknown): Scope | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'expected a scope: {board} | {folder} | {scene} | {frame} | {canvas: true}'
  const keys = Object.keys(raw)
  if (keys.length !== 1) return 'name exactly one scope: board, folder, scene, frame or canvas'
  const o = raw as Record<string, unknown>
  if ('board' in o) return isBoardName(o.board) ? { board: o.board } : 'invalid board name'
  if ('folder' in o) return isBoardName(o.folder) ? { folder: o.folder } : 'invalid folder name'
  // '' is the root scene (frames straight in design/scenes/) - named, never a default
  if ('scene' in o) return typeof o.scene === 'string' && o.scene.length <= 120 && (o.scene === '' || SCENE_RE.test(o.scene)) ? { scene: o.scene } : 'invalid scene name'
  if ('frame' in o) return isFrameId(o.frame) ? { frame: o.frame } : 'invalid frame id'
  if ('canvas' in o) return o.canvas === true ? { canvas: true } : 'canvas scope is {canvas: true}'
  return 'unknown scope - board, folder, scene, frame or canvas'
}

export const scopeLabel = (s: Scope): string =>
  'board' in s ? `board ${s.board}` : 'folder' in s ? `folder ${s.folder}` : 'scene' in s ? (s.scene ? `scene ${s.scene}` : 'the root scene') : 'frame' in s ? `frame ${s.frame}` : 'the canvas'

/** The frames a scope covers (null = the whole canvas), or why it names nothing. */
export function scopeFrames(root: string, scope: Scope): { frames: Set<string> | null } | { error: string } {
  if ('canvas' in scope) return { frames: null }
  const manifest = scanFrames(root).frames
  const live = manifest.map((f) => f.id)
  if ('scene' in scope) {
    // the manifest's own scene of each frame - the sidebar's grouping, the root scene's ('') included
    const ids = manifest.filter((f) => f.scene === scope.scene).map((f) => f.id)
    return ids.length ? { frames: new Set(ids) } : { error: scope.scene ? `no scene "${scope.scene}"` : 'no frames in the root scene' }
  }
  if ('frame' in scope) return live.includes(scope.frame) ? { frames: new Set([scope.frame]) } : { error: `no frame "${scope.frame}"` }
  const dir = join(root, 'design', 'boards')
  const files = checkBoardsDir(root, dir) ? [] : listBoardFiles(dir).boards
  const framesOf = (names: string[]) => new Set(names.flatMap((n) => framesOn(files.find((b) => b.name === n)?.json, live)))
  if ('board' in scope) {
    const b = files.find((x) => x.name === scope.board)
    return b ? { frames: framesOf([b.name]) } : { error: `no board "${scope.board}"` }
  }
  const reg = readRegistry(dir)
  const tree = buildTree(files.map((b) => ({ name: b.name, ...boardFields(b.json, isBoardName) })), reg.state === 'ok' ? reg.folders : [])
  const find = (items: TreeItem[]): TreeItem | undefined => {
    for (const it of items) {
      if (it.kind !== 'folder') continue
      if (it.name === scope.folder) return it
      const inner = find(it.items)
      if (inner) return inner
    }
    return undefined
  }
  const f = find(tree)
  return f && f.kind === 'folder' ? { frames: framesOf(flatten(f.items)) } : { error: `no folder "${scope.folder}"` }
}

/** The threads Jam is at work on (`board\tthread`): the running daemon's journal in memory when it has one, else
 *  the journal on disk - queued work that would run at the next start is work too. */
export function jamBusy(root: string, live?: () => Set<string>): Set<string> {
  if (live) return live()
  const raw = readRaw(root)
  return raw.v2 ? liveThreads(raw.v2, ctxFor(root)) : new Set()
}

/** `board` is the log the event is written to; `stamp`, when it differs, the board its thread's own events name (a log
 *  copied from another board's keeps their `board`) - the event carries it, so every reader groups it with its thread. */
export interface Resolved { board: string; thread: string; event: string; stamp?: string; /** the event's time, fixed with the plan (a retry writes the same) */ ts?: number
  /** how many events the thread held when it was planned - Undo sees one arrived since whatever its clock said */
  known?: number }
export interface Receipt {
  op: string
  scope: Scope
  at: number
  state: 'pending' | 'done'
  /** each thread resolved: its log, and the resolve event written there */
  resolved: Resolved[]
  /** left open: Jam is at work on it */
  skipped: { board: string; thread: string; why: 'working' }[]
  /** a log that could not be written: its threads stay open */
  failed: { board: string; threads: string[]; error: string }[]
}
export interface UndoReceipt {
  op: string
  at: number
  state: 'pending' | 'done'
  reopened: Resolved[]
  /** resolved or reopened again (or deleted) since: left as it is */
  changed: { board: string; thread: string }[]
  failed: { board: string; threads: string[]; error: string }[]
}

const opsDir = (root: string) => join(root, 'design', '.local', 'comment-ops')
const receiptFile = (root: string, op: string, undo = false) => join(opsDir(root), `${op}${undo ? '.undo' : ''}.json`)
const readJson = <T>(f: string): T | null => { try { return JSON.parse(readFileSync(f, 'utf8')) as T } catch { return null } }
function save(file: string, v: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(v, null, 1) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
const idFor = (kind: 'ra' | 'ru', op: string, board: string, thread: string) =>
  `${kind}-${createHash('sha256').update(`${op}\0${board}\0${thread}`).digest('hex').slice(0, 32)}`

export const readReceipt = (root: string, op: string): Receipt | null => (OP_RE.test(op) ? readJson<Receipt>(receiptFile(root, op)) : null)

/** Every event of a thread in one log - its messages, and whatever names it or one of its replies (an edit, a reaction,
 *  a resolve, a delete) - in replay's order. */
export function threadEvents(events: readonly CommentEvent[], thread: string): CommentEvent[] {
  const ids = new Set([thread, ...events.filter((e) => e.type === 'reply' && e.parentId === thread && e.commentId).map((e) => e.commentId!)])
  return events.filter((e) => (e.type === 'reply' ? e.parentId === thread : !!e.commentId && ids.has(e.commentId)))
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
}
/** A time after everything the thread holds - what this clock says, or later when another clock ran ahead (replay
 *  orders by time: the write must come last to take effect). */
const after = (events: readonly CommentEvent[], thread: string, now: number) => Math.max(now, (threadEvents(events, thread).at(-1)?.ts ?? 0) + 1)

/** The open threads a scope covers, each with its own log - shown threads only (a deleted one is not). */
export function threadsIn(root: string, frames: Set<string> | null): { board: string; thread: string; frame?: string; stamp?: string }[] {
  const dir = join(root, 'design', 'comments')
  const out: { board: string; thread: string; frame?: string; stamp?: string }[] = []
  for (const board of listBoards(dir)) {
    for (const t of replay(readLog(dir, board))) {
      if (t.resolved) continue
      if (frames && (!t.frame || !frames.has(t.frame))) continue
      out.push({ board, thread: t.id, ...(t.frame ? { frame: t.frame } : {}), ...(t.board && t.board !== board ? { stamp: t.board } : {}) })
    }
  }
  return out
}

/** Append each log's events; a log that throws is reported with its threads, the others still land. */
function appendAll(dir: string, byBoard: Map<string, CommentEvent[]>): { board: string; threads: string[]; error: string }[] {
  const failed: { board: string; threads: string[]; error: string }[] = []
  for (const [board, events] of byBoard) {
    try { appendEvents(dir, board, events) }
    catch (err) { failed.push({ board, threads: events.map((e) => e.commentId!), error: (err as Error).message }) }
  }
  return failed
}

export interface ResolveAllOpts {
  /** the running daemon's busy threads (jamLive.busy), else the journal on disk is read */
  busy?: () => Set<string>
  /** don't write - count only (`--dry-run`) */
  dryRun?: boolean
  now?: number
}

/**
 * Resolve every open thread in `scope` but the ones Jam is at work on. SYNCHRONOUS from the Jam check to the last
 * append - keep it that way. A retry of an op returns its receipt (a pending one is finished first).
 */
export function resolveAll(root: string, op: string, scope: Scope, o: ResolveAllOpts = {}): Receipt | { error: string; status: number } {
  if (!OP_RE.test(op)) return { error: 'op must be an 8-64 char token', status: 400 }
  const dir = join(root, 'design', 'comments')
  const file = receiptFile(root, op)
  const had = o.dryRun ? null : readJson<Receipt>(file)
  if (had && JSON.stringify(had.scope) !== JSON.stringify(scope)) return { error: 'that op was used for another scope', status: 409 }
  if (had?.state === 'done') return had
  const at = o.now ?? Date.now()
  const busy = jamBusy(root, o.busy)
  const skipped: Receipt['skipped'] = []
  let plan: Resolved[]
  if (had) {
    // a pending receipt (a crash between its appends and its end): the same events again, minus what changed since
    plan = had.resolved.filter((r) => !busy.has(`${r.board}\t${r.thread}`))
    for (const r of had.resolved) if (busy.has(`${r.board}\t${r.thread}`)) skipped.push({ board: r.board, thread: r.thread, why: 'working' })
    skipped.push(...had.skipped.filter((x) => !skipped.some((y) => y.board === x.board && y.thread === x.thread)))
  } else {
    const where = scopeFrames(root, scope)
    if ('error' in where) return { error: where.error, status: 404 }
    plan = []
    const logs = new Map<string, CommentEvent[]>()
    const logOf = (b: string) => { let l = logs.get(b); if (!l) logs.set(b, (l = readLog(dir, b))); return l }
    for (const t of threadsIn(root, where.frames)) {
      if (busy.has(`${t.board}\t${t.thread}`)) { skipped.push({ board: t.board, thread: t.thread, why: 'working' }); continue }
      plan.push({ board: t.board, thread: t.thread, event: idFor('ra', op, t.board, t.thread), ...(t.stamp ? { stamp: t.stamp } : {}), ts: after(logOf(t.board), t.thread, at), known: threadEvents(logOf(t.board), t.thread).length })
    }
  }
  const receipt: Receipt = { op, scope, at: had?.at ?? at, state: 'pending', resolved: plan, skipped, failed: [] }
  if (o.dryRun) return { ...receipt, state: 'done' }
  save(file, receipt)
  const byBoard = new Map<string, CommentEvent[]>()
  for (const r of plan) {
    const ev: CommentEvent = { id: r.event, ts: r.ts ?? receipt.at, type: 'resolve', commentId: r.thread, board: r.stamp ?? r.board, op }
    byBoard.set(r.board, [...(byBoard.get(r.board) ?? []), ev])
  }
  const unwritten = appendAll(dir, byBoard)
  const missed = new Set(unwritten.flatMap((f) => f.threads.map((t) => `${f.board}\t${t}`)))
  receipt.failed = [...unwritten, ...verify(dir, plan.filter((r) => !missed.has(`${r.board}\t${r.thread}`)), true)]
  const lost = new Set(receipt.failed.flatMap((f) => f.threads.map((t) => `${f.board}\t${t}`)))
  receipt.resolved = plan.filter((r) => !lost.has(`${r.board}\t${r.thread}`))
  receipt.state = 'done'
  save(file, receipt)
  return receipt
}

/** What the logs say now, per planned thread: a write that took is counted, one that did not is reported. */
function verify(dir: string, plan: Resolved[], resolved: boolean): { board: string; threads: string[]; error: string }[] {
  const out = new Map<string, string[]>()
  for (const board of new Set(plan.map((r) => r.board))) {
    const state = new Map(replay(readLog(dir, board)).map((t) => [t.id, t.resolved]))
    for (const r of plan.filter((x) => x.board === board)) if (state.has(r.thread) && state.get(r.thread) !== resolved) out.set(board, [...(out.get(board) ?? []), r.thread])
  }
  return [...out].map(([board, threads]) => ({ board, threads, error: `a later event keeps ${threads.length === 1 ? 'it' : 'them'} ${resolved ? 'open' : 'resolved'}` }))
}

/** Undo an op: reopen each thread whose latest resolve or reopen is still the op's resolve. A retry returns the
 *  same answer. */
export function undoResolveAll(root: string, op: string, o: { now?: number } = {}): UndoReceipt | { error: string; status: number } {
  if (!OP_RE.test(op)) return { error: 'op must be an 8-64 char token', status: 400 }
  const done = readReceipt(root, op)
  if (!done || done.state !== 'done') return { error: 'no such resolve-all to undo', status: 404 }
  const file = receiptFile(root, op, true)
  const had = readJson<UndoReceipt>(file)
  if (had?.state === 'done') return had
  const dir = join(root, 'design', 'comments')
  const at = o.now ?? Date.now()
  const logs = new Map<string, CommentEvent[]>()
  const logOf = (b: string) => { let l = logs.get(b); if (!l) logs.set(b, (l = readLog(dir, b))); return l }
  let reopened: Resolved[] = [], changed: UndoReceipt['changed'] = []
  /** Nothing happened in the thread since the op resolved it: its latest event is that resolve, and no event arrived
   *  since the plan however its clock ordered it (a slower clock sorts before the resolve - Codex r3). */
  const untouched = (r: Resolved, events: CommentEvent[]) => {
    const evs = threadEvents(events, r.thread)
    if (evs.at(-1)?.id !== r.event) return false
    const reopen = idFor('ru', op, r.board, r.thread)
    return r.known === undefined || evs.filter((e) => e.id !== r.event && e.id !== reopen).length <= r.known
  }
  if (had) {
    // a pending undo (a crash between its appends and its end): the same reopens, at the same times - each one not
    // written yet checked again, as the first time: anything since, and it is left as it is (Codex r2)
    changed = [...had.changed]
    for (const r of had.reopened) {
      const events = logOf(r.board)
      if (events.some((e) => e.id === r.event)) { reopened.push(r); continue }
      const planned = done.resolved.find((x) => x.board === r.board && x.thread === r.thread)
      if (planned && untouched(planned, events)) reopened.push(r)
      else changed.push({ board: r.board, thread: r.thread })
    }
  } else for (const r of done.resolved) {
    const events = logOf(r.board)
    // its latest event must still be the op's resolve: a reply, an edit, a reaction, a reopen since - anything - and it
    // is left as it is (spec 31 B.3)
    const shown = replay(events).some((t) => t.id === r.thread)
    if (shown && untouched(r, events)) reopened.push({ board: r.board, thread: r.thread, event: idFor('ru', op, r.board, r.thread), ...(r.stamp ? { stamp: r.stamp } : {}), ts: after(events, r.thread, at) })
    else changed.push({ board: r.board, thread: r.thread })
  }
  const receipt: UndoReceipt = { op, at: had?.at ?? at, state: 'pending', reopened, changed, failed: [] }
  save(file, receipt)
  const byBoard = new Map<string, CommentEvent[]>()
  for (const r of reopened) byBoard.set(r.board, [...(byBoard.get(r.board) ?? []), { id: r.event, ts: r.ts ?? receipt.at, type: 'reopen', commentId: r.thread, board: r.stamp ?? r.board, op }])
  const unwritten = appendAll(dir, byBoard)
  const missed = new Set(unwritten.flatMap((f) => f.threads.map((t) => `${f.board}\t${t}`)))
  receipt.failed = [...unwritten, ...verify(dir, reopened.filter((r) => !missed.has(`${r.board}\t${r.thread}`)), false)]
  const lost = new Set(receipt.failed.flatMap((f) => f.threads.map((t) => `${f.board}\t${t}`)))
  receipt.reopened = reopened.filter((r) => !lost.has(`${r.board}\t${r.thread}`))
  receipt.state = 'done'
  save(file, receipt)
  return receipt
}

/** The words a person reads: "Resolved 31 conversations · 2 left open: work in progress". */
export function resolveSummary(r: Receipt): string {
  const n = r.resolved.length
  const parts = [n ? `Resolved ${n} conversation${n === 1 ? '' : 's'}` : 'Nothing to resolve']
  if (r.skipped.length) parts.push(`${r.skipped.length} left open: work in progress`)
  if (r.failed.length) parts.push(`${r.failed.reduce((k, f) => k + f.threads.length, 0)} not resolved: ${r.failed.map((f) => `${f.board} (${f.error})`).join(', ')}`)
  return parts.join(' · ')
}
export function undoSummary(u: UndoReceipt): string {
  const n = u.reopened.length
  const parts = [`Reopened ${n}${n ? ' (finished Jam items stay finished)' : ''}`]
  if (u.changed.length) parts.push(`${u.changed.length} changed since - left as is`)
  if (u.failed.length) parts.push(`${u.failed.reduce((k, f) => k + f.threads.length, 0)} could not be reopened: ${u.failed.map((f) => `${f.board} (${f.error})`).join(', ')}`)
  return parts.join(' · ')
}
