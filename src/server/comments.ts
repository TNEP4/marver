/**
 * The comment event store (SPEC-M3 §1) - an append-only JSONL log, one file per board.
 *
 * Events are immutable and identified by client-generated UUIDs; two logs merge by SET
 * UNION on id. That single rule is the entire sync protocol: idempotent, order-
 * independent, retry-safe, tolerant of a deploy-overlap double-writer. Current thread
 * state is derived by replaying events (ordered by ts then id, last writer wins per
 * field). Files, not a database - tens to low hundreds of events per board.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type EventType = 'create' | 'reply' | 'edit' | 'resolve' | 'reopen' | 'react' | 'profile'

export interface CommentEvent {
  id: string                      // client-generated UUID - the idempotency key
  ts: number                      // ms epoch at creation
  type: EventType
  commentId?: string              // the comment this event belongs to (root id = thread id)
  parentId?: string               // replies: the ROOT comment id (threads are flat)
  board?: string
  nodeKey?: string                // a frame can sit on a board twice - comments are node-scoped
  frame?: string
  anchor?: unknown                // SPEC-M3 §5 bundle; absent = frame-level comment
  author?: { email: string; name?: string; avatar?: string }
  body?: string                   // plain text in v1
  emoji?: string                  // react events
  addressedIn?: string            // resolve events: the variant frame that answered
}

export interface Thread {
  id: string
  board?: string; nodeKey?: string; frame?: string
  anchor?: unknown
  author?: CommentEvent['author']
  body?: string
  ts: number
  resolved: boolean
  addressedIn?: string
  replies: { id: string; author?: CommentEvent['author']; body?: string; ts: number }[]
  reactions: Record<string, string[]>   // emoji -> author emails (toggle semantics)
}

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
    appendFileSync(file, lead + fresh.map((e) => JSON.stringify(e)).join('\n') + '\n')
  }
  return fresh
}

/** Board names present in a log directory. */
export function listBoards(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).filter((n) => BOARD_RE.test(n)).sort()
}

/** Events the other side lacks, by id - the sync payload in either direction. */
export function diffEvents(mine: CommentEvent[], theirIds: Iterable<string>): CommentEvent[] {
  const have = new Set(theirIds)
  return mine.filter((e) => !have.has(e.id))
}

/** Replay a board's events into current thread state. Deterministic: replay order is
 *  (ts, id) so two stores holding the same event SET always derive the same state. */
export function replay(events: CommentEvent[]): Thread[] {
  const ordered = [...events].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  const threads = new Map<string, Thread>()
  for (const ev of ordered) {
    switch (ev.type) {
      case 'create': {
        if (!ev.commentId || threads.has(ev.commentId)) break
        threads.set(ev.commentId, {
          id: ev.commentId, board: ev.board, nodeKey: ev.nodeKey, frame: ev.frame,
          anchor: ev.anchor, author: ev.author, body: ev.body, ts: ev.ts,
          resolved: false, replies: [], reactions: {},
        })
        break
      }
      case 'reply': {
        const t = ev.parentId ? threads.get(ev.parentId) : undefined
        if (!t || !ev.commentId || t.replies.some((r) => r.id === ev.commentId)) break
        t.replies.push({ id: ev.commentId, author: ev.author, body: ev.body, ts: ev.ts })
        break
      }
      case 'edit': {
        if (!ev.commentId || ev.body === undefined) break
        const t = threads.get(ev.commentId)
        if (t) { t.body = ev.body; break }
        for (const th of threads.values()) {
          const r = th.replies.find((r) => r.id === ev.commentId)
          if (r) { r.body = ev.body; break }
        }
        break
      }
      case 'resolve': {
        const t = ev.commentId ? threads.get(ev.commentId) : undefined
        if (t) { t.resolved = true; if (ev.addressedIn) t.addressedIn = ev.addressedIn }
        break
      }
      case 'reopen': {
        const t = ev.commentId ? threads.get(ev.commentId) : undefined
        if (t) { t.resolved = false; t.addressedIn = undefined }
        break
      }
      case 'react': {
        // toggle keyed on comment+author+emoji: present removes, absent adds
        const t = ev.commentId ? threads.get(ev.commentId) : undefined
        const who = ev.author?.email
        if (!t || !who || !ev.emoji) break
        const users = (t.reactions[ev.emoji] ??= [])
        const at = users.indexOf(who)
        if (at === -1) users.push(who)
        else { users.splice(at, 1); if (!users.length) delete t.reactions[ev.emoji] }
        break
      }
      // 'profile' events update author snapshots at write time on the client - replay ignores them
    }
  }
  return [...threads.values()]
}

/** Where serve keeps its live store: MARVER_DATA_DIR is REQUIRED when collaboration is
 *  on - failing loudly beats silently writing into an ephemeral working directory that a
 *  redeploy wipes (SPEC-M3 §2). */
export function dataDir(): string {
  const dir = process.env.MARVER_DATA_DIR
  if (!dir) throw new Error(
    'collaboration needs a durable home: set MARVER_DATA_DIR to a directory on a persistent volume ' +
    '(comments written anywhere else would vanish on redeploy)')
  mkdirSync(join(dir, 'comments'), { recursive: true })
  return dir
}
