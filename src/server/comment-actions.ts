/**
 * Resolve all comments, and its Undo (spec 31 B.1-B.5) - one core for the dev server's routes and the CLI.
 *
 * Scope is what you see, never a log: a board = the open threads on frames that board shows; a folder = the union
 * over its boards, sub-folders included; a scene = the threads on that scene's frames; the canvas = every open
 * thread. Each resolve is written to its thread's own log, so it is the same as resolving each by hand - Jam's
 * `asks`, `review` and `failed` items on it complete when the queue ingests it - except live work: a thread whose
 * Jam card is queued or working (or whose tag is written and not yet queued) is skipped and counted. The check and
 * the appends run in one synchronous step: nothing is awaited between them, so no ingest slips a card in.
 *
 * Every operation has a client id (`op`): a retry returns the same receipt. The receipt names, per thread, its log
 * and its resolve event; Undo reopens a thread only while that resolve is still its latest resolve or reopen, and
 * says how many changed since. Jam items a resolve completed stay completed - Undo reopens conversations only.
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

export type Scope = { board: string } | { folder: string } | { scene: string } | { canvas: true }
export const OP_RE = /^[\w-]{8,64}$/
const SCENE_RE = /^[A-Za-z0-9_][\w.-]*$/

/** Exactly one scope, every name on its grammar - else what is wrong. An empty or malformed one is refused,
 *  never read as the whole canvas. */
export function parseScope(raw: unknown): Scope | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'expected a scope: {board} | {folder} | {scene} | {canvas: true}'
  const keys = Object.keys(raw)
  if (keys.length !== 1) return 'name exactly one scope: board, folder, scene or canvas'
  const o = raw as Record<string, unknown>
  if ('board' in o) return isBoardName(o.board) ? { board: o.board } : 'invalid board name'
  if ('folder' in o) return isBoardName(o.folder) ? { folder: o.folder } : 'invalid folder name'
  if ('scene' in o) return typeof o.scene === 'string' && o.scene.length <= 120 && SCENE_RE.test(o.scene) ? { scene: o.scene } : 'invalid scene name'
  if ('canvas' in o) return o.canvas === true ? { canvas: true } : 'canvas scope is {canvas: true}'
  return 'unknown scope - board, folder, scene or canvas'
}

export const scopeLabel = (s: Scope): string =>
  'board' in s ? `board ${s.board}` : 'folder' in s ? `folder ${s.folder}` : 'scene' in s ? `scene ${s.scene}` : 'the canvas'

/** The frames a scope covers (null = the whole canvas), or why it names nothing. */
export function scopeFrames(root: string, scope: Scope): { frames: Set<string> | null } | { error: string } {
  if ('canvas' in scope) return { frames: null }
  const live = scanFrames(root).frames.map((f) => f.id)
  if ('scene' in scope) {
    const ids = live.filter((id) => id.startsWith(`${scope.scene}/`))
    return ids.length ? { frames: new Set(ids) } : { error: `no scene "${scope.scene}"` }
  }
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
export interface Resolved { board: string; thread: string; event: string; stamp?: string }
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
    for (const t of threadsIn(root, where.frames)) {
      if (busy.has(`${t.board}\t${t.thread}`)) { skipped.push({ board: t.board, thread: t.thread, why: 'working' }); continue }
      plan.push({ board: t.board, thread: t.thread, event: idFor('ra', op, t.board, t.thread), ...(t.stamp ? { stamp: t.stamp } : {}) })
    }
  }
  const receipt: Receipt = { op, scope, at: had?.at ?? at, state: 'pending', resolved: plan, skipped, failed: [] }
  if (o.dryRun) return { ...receipt, state: 'done' }
  save(file, receipt)
  const byBoard = new Map<string, CommentEvent[]>()
  for (const r of plan) {
    const ev: CommentEvent = { id: r.event, ts: at, type: 'resolve', commentId: r.thread, board: r.stamp ?? r.board, op }
    byBoard.set(r.board, [...(byBoard.get(r.board) ?? []), ev])
  }
  receipt.failed = appendAll(dir, byBoard)
  const lost = new Set(receipt.failed.flatMap((f) => f.threads.map((t) => `${f.board}\t${t}`)))
  receipt.resolved = plan.filter((r) => !lost.has(`${r.board}\t${r.thread}`))
  receipt.state = 'done'
  save(file, receipt)
  return receipt
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
  const reopened: Resolved[] = [], changed: UndoReceipt['changed'] = []
  for (const r of done.resolved) {
    const events = logOf(r.board)
    const reopen = idFor('ru', op, r.board, r.thread)
    // the thread's resolution history, in replay's order - its latest says whether it changed since
    const latest = events.filter((e) => (e.type === 'resolve' || e.type === 'reopen') && e.commentId === r.thread)
      .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)).pop()
    const shown = replay(events).some((t) => t.id === r.thread)
    if (shown && (latest?.id === r.event || latest?.id === reopen)) reopened.push({ board: r.board, thread: r.thread, event: reopen, ...(r.stamp ? { stamp: r.stamp } : {}) })
    else changed.push({ board: r.board, thread: r.thread })
  }
  const receipt: UndoReceipt = { op, at: had?.at ?? at, state: 'pending', reopened, changed, failed: [] }
  save(file, receipt)
  const byBoard = new Map<string, CommentEvent[]>()
  for (const r of reopened) {
    // never before the resolve it undoes, whatever this clock says (replay orders by time)
    const resolveTs = logOf(r.board).find((e) => e.id === idFor('ra', op, r.board, r.thread))?.ts ?? 0
    byBoard.set(r.board, [...(byBoard.get(r.board) ?? []), { id: r.event, ts: Math.max(at, resolveTs + 1), type: 'reopen', commentId: r.thread, board: r.stamp ?? r.board, op }])
  }
  receipt.failed = appendAll(dir, byBoard)
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
