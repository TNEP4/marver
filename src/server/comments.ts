/**
 * The comment event store - an append-only JSONL log, one file per board.
 *
 * Events are immutable and identified by client-generated UUIDs; two logs merge by SET
 * UNION on id. That single rule is the entire sync protocol: idempotent, order-
 * independent, retry-safe, tolerant of a deploy-overlap double-writer. Current thread
 * state is derived by replaying events (ordered by ts then id, last writer wins per
 * field). Files, not a database - tens to low hundreds of events per board.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { CommentEvent } from '../shared/events.ts'

export { diffEvents, replay, type CommentEvent, type EventType, type Thread } from '../shared/events.ts'

const BOARD_RE = /^[a-z0-9][a-z0-9-]*$/
const boardFile = (dir: string, board: string) => {
  if (!BOARD_RE.test(board)) throw new Error(`bad board name: ${board}`)
  return join(dir, `${board}.jsonl`)
}

/** Read one board's log. Unparseable lines are skipped, never fatal - an interrupted
 *  append must not take the whole board down. Duplicate ids keep the first occurrence. */
export function readLog(dir: string, board: string): CommentEvent[] {
  const file = boardFile(dir, board)
  if (!existsSync(file)) return []
  const seen = new Set<string>()
  const out: CommentEvent[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let ev: CommentEvent
    try { ev = JSON.parse(line) } catch { continue }
    if (typeof ev?.id !== 'string' || !ev.id || seen.has(ev.id)) continue
    seen.add(ev.id)
    out.push(ev)
  }
  return out
}

/** Append events the log does not already hold; returns the ones actually written.
 *  This IS the merge rule - callers never need another. */
export function appendEvents(dir: string, board: string, events: CommentEvent[]): CommentEvent[] {
  mkdirSync(dir, { recursive: true })
  const have = new Set(readLog(dir, board).map((e) => e.id))
  const fresh = events.filter((e) => typeof e?.id === 'string' && e.id && !have.has(e.id) && (have.add(e.id), true))
  if (fresh.length) {
    const file = boardFile(dir, board)
    // a torn final line (interrupted append) must not swallow the next event - start on
    // a fresh line whenever the file does not end with one
    let lead = ''
    if (existsSync(file)) {
      const size = statSync(file).size
      if (size > 0) {
        const fd = openSync(file, 'r')
        const last = Buffer.alloc(1)
        readSync(fd, last, 0, 1, size - 1)
        closeSync(fd)
        if (last[0] !== 0x0a) lead = '\n'
      }
    }
    // fsync the append: a comment acked with HTTP 200 must survive a crash, not sit
    // in the page cache to be lost on a volume interruption
    const fd = openSync(file, 'a')
    try { writeSync(fd, lead + fresh.map((e) => JSON.stringify(e)).join('\n') + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  }
  return fresh
}

/** Board names present in a log directory. */
export function listBoards(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).filter((n) => BOARD_RE.test(n)).sort()
}


/** Where serve keeps its live store: MARVER_DATA_DIR is REQUIRED when collaboration is
 *  on - failing loudly beats silently writing into an ephemeral working directory that a
 *  redeploy wipes. */
export function dataDir(): string {
  const dir = process.env.MARVER_DATA_DIR
  if (!dir) throw new Error(
    'collaboration needs a durable home: set MARVER_DATA_DIR to a directory on a persistent volume ' +
    '(comments written anywhere else would vanish on redeploy)')
  mkdirSync(join(dir, 'comments'), { recursive: true })
  return dir
}

/** The old all-scenes comment log (spec 26, Part 7) outlives its board: a thread there is exposed
 *  when some published board shows its frame - `shows`, each published board's frames, written by
 *  builds from 0.25 on. Answers, for any event in the log or arriving with it, the published boards
 *  showing its thread's frame (none = unexposed). A reply finds its thread by parentId; a resolve,
 *  an edit or a reaction through the comment it names. */
export function legacyExposure(events: CommentEvent[], rights: Record<string, 'read' | 'comment'>, shows: Record<string, string[]>): (e: CommentEvent) => string[] {
  const boards = new Map<string, string[]>()   // thread id -> the published boards showing its frame
  const rootOf = new Map<string, string>()     // comment id (a thread or a reply) -> thread id
  for (const e of events) {
    if (e.type === 'create' && e.commentId && !boards.has(e.commentId)) {
      boards.set(e.commentId, Object.keys(rights).filter((b) => typeof e.frame === 'string' && !!shows[b]?.includes(e.frame)))
      rootOf.set(e.commentId, e.commentId)
    }
    if (e.type === 'reply' && e.commentId && e.parentId && !rootOf.has(e.commentId)) rootOf.set(e.commentId, e.parentId)
  }
  // a reply names its thread in parentId; every other event targets the comment it names
  return (e) => boards.get(rootOf.get((e.type === 'reply' ? e.parentId : e.commentId) ?? '') ?? '') ?? []
}
