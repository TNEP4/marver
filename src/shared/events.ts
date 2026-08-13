/**
 * Comment events - the PURE half of the store (SPEC-M3 §1), shared by the node side
 * (JSONL persistence in server/comments.ts) and the browser shell (thread state from
 * fetched events). No node imports here, ever.
 */

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
