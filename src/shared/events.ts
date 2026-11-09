/**
 * Comment events - the PURE half of the store, shared by the node side
 * (JSONL persistence in server/comments.ts) and the browser shell (thread state from
 * fetched events). No node imports here, ever.
 */

// 'reanchor' (Live Jam): re-pin a thread to a new element after the agent moved it.
// 'delete' (0.31, spec 31 C.4): a terminal tombstone on one message - its author's only.
export type EventType = 'create' | 'reply' | 'edit' | 'resolve' | 'reopen' | 'react' | 'profile' | 'reanchor' | 'delete'

// Live Jam: provenance stamped by the daemon on agent-authored events (who orchestrated the change).
export interface AgentMeta { devUser?: string; harness?: string; model?: string; effort?: string; /** who ran it (spec 29b): the owner's session, a copy of it, or a fresh agent */ runner?: 'session' | 'fork' | 'fresh' }

/** A person named in a comment (sharing v1.1). Splits exactly like `author`:
 *  canonical logs carry `email`, browser transports carry `id` (the same
 *  opaque per-canvas HMAC) - exactly one of the two is present. `label` is the
 *  display name the composer inserted (bodies stay plain text; rendering
 *  highlights `@label` runs by matching it). */
export interface Mention { email?: string; id?: string; label: string }

export interface CommentEvent {
  id: string                      // client-generated UUID - the idempotency key
  ts: number                      // ms epoch at creation
  type: EventType
  commentId?: string              // the comment this event belongs to (root id = thread id)
  parentId?: string               // replies: the ROOT comment id (threads are flat)
  board?: string
  nodeKey?: string                // a frame can sit on a board twice - comments are node-scoped
  frame?: string
  anchor?: unknown                // anchor bundle; absent = frame-level comment; on 'reanchor' = the new anchor
  /** Canonical logs carry the email; the browser DTO replaces it with `id`, an
   *  opaque per-canvas HMAC of it (01-sharing §7.5) - a member's address never
   *  travels to another viewer's browser. Exactly one of the two is present. */
  author?: { email?: string; id?: string; name?: string; avatar?: string }
  body?: string                   // plain text in v1
  mentions?: Mention[]            // create/reply only - people named in the body (v1.1)
  emoji?: string                  // react events
  addressedIn?: string            // resolve events: the variant frame that answered
  /** create/reply (and an edit of one): does this message ask the human something (spec 26)?
   *  Absent = written before 0.25, read by `asks()` with the old rule. */
  asks?: boolean
  // --- Live Jam additions ---
  agent?: boolean                 // true = written by the Marver agent (never trusted for execution; render + guard only)
  agentMeta?: AgentMeta           // provenance for the Marver avatar tooltip (agent events only)
  /** A jam reply (0.26): shared files the job changed though it was not given them - drawn as one
   *  line under the reply ("Also changed _kit.tsx"). */
  alsoChanged?: string[]
  /** A capture's comment (0.26): the capture it stands for, and a short line of facts ("0:19 · 2 points
   *  · 1 picture"). A thread draws it as a capture block; ingest never makes a card of it. */
  capture?: string
  facts?: string
  origin?: string                 // server-stamped 'local' on dev-owner writes; the daemon's owner-trigger key
  /** resolve and reopen events (0.31, spec 31 B.3): the resolve-all operation that wrote it - what its Undo matches */
  op?: string
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
  agent?: boolean                 // root authored by the agent
  agentMeta?: AgentMeta
  mentions?: Mention[]
  asks?: boolean
  capture?: string                // a capture's comment (0.26)
  facts?: string
  /** the first comment was deleted (0.31): its replies stay under a "Comment deleted" placeholder - no body, author or mentions */
  deleted?: true
  /** when its words were last edited (0.31: "edited" is shown) - an edit that changes only a flag does not count */
  edited?: number
  replies: { id: string; author?: CommentEvent['author']; body?: string; ts: number; agent?: boolean; agentMeta?: AgentMeta; mentions?: Mention[]; asks?: boolean; alsoChanged?: string[]; edited?: number }[]
  reactions: Record<string, string[]>   // emoji -> author emails (toggle semantics)
}

/** Does this message ask the human something? The writer says so (`asks`); a message written
 *  before 0.25 says nothing, and the old rule reads it: a note asks, a reply asks when it ends
 *  in "?". `note` = the thread's root (a create event). */
export const asks = (m: { asks?: boolean; body?: string }, note: boolean): boolean =>
  m.asks ?? (note || /\?\s*$/.test(m.body ?? ''))

/** Events the other side lacks, by id - the sync payload in either direction. */
export function diffEvents(mine: CommentEvent[], theirIds: Iterable<string>): CommentEvent[] {
  const have = new Set(theirIds)
  return mine.filter((e) => !have.has(e.id))
}

/** The messages (create or reply comment ids) a log's tombstones name (spec 31 C.4): terminal, whatever came
 *  before or after them. Every reader that turns a request into agent input filters by it, per message. */
export function deletedMessages(events: readonly CommentEvent[]): Set<string> {
  const out = new Set<string>()
  for (const e of events) if (e.type === 'delete' && typeof e.commentId === 'string' && e.commentId) out.add(e.commentId)
  return out
}

/** An event as a browser may see it (spec 31 C.4): a create, reply or edit of a deleted message carries no words or
 *  mentions - the log keeps them (sync is by id), no transport to a page does. `gone`: deletedMessages of the log. */
export const withoutDeletedWords = (e: CommentEvent, gone: ReadonlySet<string>): CommentEvent =>
  gone.size && (e.type === 'create' || e.type === 'reply' || e.type === 'edit') && !!e.commentId && gone.has(e.commentId) ? { ...e, body: '', mentions: undefined } : e

/** The copy a published page keeps of what it just sent (spec 31 C.2): its author wears the viewer's own opaque id, as
 *  the server's projection of it will - the echo is a duplicate by id and dropped, so without it a message just written
 *  would not be "mine" (no Edit, no Delete) until a reload. Never sent: the server assigns ids. */
export const asSentBy = (events: CommentEvent[], myId: string | undefined): CommentEvent[] =>
  !myId ? events : events.map((e) => (e.author && !e.author.id ? { ...e, author: { ...e.author, id: myId } } : e))

/** Replay a board's events into current thread state. Deterministic: replay order is
 *  (ts, id) so two stores holding the same event SET always derive the same state.
 *  TWO passes - creates first, then everything else - so a reply whose author's clock
 *  ran ahead of the creator's still lands instead of being dropped forever. Deletes (0.31)
 *  apply after both, whatever their time: a deleted reply is gone; a deleted first comment
 *  keeps its surviving replies under a placeholder, and with none the thread is gone. */
export function replay(events: CommentEvent[]): Thread[] {
  const ordered = [...events].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  const threads = new Map<string, Thread>()
  for (const ev of ordered) {
    if (ev.type !== 'create') continue
    if (!ev.commentId || threads.has(ev.commentId)) continue
    threads.set(ev.commentId, {
      id: ev.commentId, board: ev.board, nodeKey: ev.nodeKey, frame: ev.frame,
      anchor: ev.anchor, author: ev.author, body: ev.body, ts: ev.ts,
      resolved: false, agent: ev.agent, agentMeta: ev.agentMeta, mentions: ev.mentions, asks: ev.asks, replies: [], reactions: {},
      ...(ev.capture ? { capture: ev.capture, ...(ev.facts ? { facts: ev.facts } : {}) } : {}),
    })
  }
  for (const ev of ordered) {
    switch (ev.type) {
      case 'reply': {
        const t = ev.parentId ? threads.get(ev.parentId) : undefined
        if (!t || !ev.commentId || t.replies.some((r) => r.id === ev.commentId)) break
        t.replies.push({ id: ev.commentId, author: ev.author, body: ev.body, ts: ev.ts, agent: ev.agent, agentMeta: ev.agentMeta, mentions: ev.mentions, asks: ev.asks, ...(ev.alsoChanged?.length ? { alsoChanged: ev.alsoChanged } : {}) })
        break
      }
      case 'edit': {
        // an edit changes the words, the `asks` flag, or both - and keeps whichever it leaves out
        if (!ev.commentId || (ev.body === undefined && ev.asks === undefined && ev.alsoChanged === undefined)) break
        const m = threads.get(ev.commentId) ?? [...threads.values()].flatMap((th) => th.replies).find((r) => r.id === ev.commentId)
        if (!m) break
        if (ev.body !== undefined) { if (ev.body !== m.body) m.edited = ev.ts; m.body = ev.body }
        if (ev.asks !== undefined) m.asks = ev.asks
        if (ev.alsoChanged !== undefined && !('replies' in m)) (m as { alsoChanged?: string[] }).alsoChanged = ev.alsoChanged   // a reply's
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
      case 'reanchor': {
        // Live Jam: re-pin the whole thread to a new element (the agent moved the target).
        // Only a root (thread) can be re-pinned, and a null/absent anchor is ignored (never un-pins).
        // One naming a FRAME moves the thread onto that frame (0.26: a capture whose work made a new frame
        // is hosted there) - its anchor, when it has one, else the frame itself; a reader that predates it
        // keeps the thread where it was.
        const t = ev.commentId ? threads.get(ev.commentId) : undefined
        if (t && typeof ev.frame === 'string' && ev.frame) { t.frame = ev.frame; t.nodeKey = ev.nodeKey; t.anchor = ev.anchor ?? undefined }
        else if (t && ev.anchor != null) t.anchor = ev.anchor
        break
      }
      case 'react': {
        // toggle keyed on comment+author+emoji: present removes, absent adds.
        // The key is the opaque id when the transport is projected, the email
        // when it is canonical - one store only ever sees one kind.
        const t = ev.commentId ? threads.get(ev.commentId) : undefined
        const who = ev.author?.id ?? ev.author?.email
        if (!t || !who || !ev.emoji) break
        const users = (t.reactions[ev.emoji] ??= [])
        const at = users.indexOf(who)
        if (at === -1) users.push(who)
        else { users.splice(at, 1); if (!users.length) delete t.reactions[ev.emoji] }
        break
      }
      // 'profile' events update author snapshots at write time on the client - replay ignores them
      // 'delete' events are applied below, after everything else
    }
  }
  const gone = deletedMessages(ordered)
  if (!gone.size) return [...threads.values()]
  const out: Thread[] = []
  for (const t of threads.values()) {
    t.replies = t.replies.filter((r) => !gone.has(r.id))
    if (gone.has(t.id)) {
      if (!t.replies.length) continue
      // the placeholder carries nothing of what was said, nor who said it
      t.deleted = true
      t.body = undefined; t.author = undefined; t.mentions = undefined; t.asks = undefined; t.edited = undefined
      delete t.capture; delete t.facts
    }
    out.push(t)
  }
  return out
}
