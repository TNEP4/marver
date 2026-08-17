/**
 * Comment events - the PURE half of the store (SPEC-M3 §1), shared by the node side
 * (JSONL persistence in server/comments.ts) and the browser shell (thread state from
 * fetched events). No node imports here, ever.
 */

// 'reanchor' (Live Jam): re-pin a thread to a new element after the agent moved it.
export type EventType = 'create' | 'reply' | 'edit' | 'resolve' | 'reopen' | 'react' | 'profile' | 'reanchor'

// Live Jam: provenance stamped by the daemon on agent-authored events (who orchestrated the change).
export interface AgentMeta { devUser?: string; harness?: string; model?: string; effort?: string }

export interface CommentEvent {
  id: string                      // client-generated UUID - the idempotency key
  ts: number                      // ms epoch at creation
  type: EventType
  commentId?: string              // the comment this event belongs to (root id = thread id)
  parentId?: string               // replies: the ROOT comment id (threads are flat)
  board?: string
  nodeKey?: string                // a frame can sit on a board twice - comments are node-scoped
  frame?: string
  anchor?: unknown                // SPEC-M3 §5 bundle; absent = frame-level comment; on 'reanchor' = the new anchor
  author?: { email: string; name?: string; avatar?: string }
  body?: string                   // plain text in v1
  emoji?: string                  // react events
  addressedIn?: string            // resolve events: the variant frame that answered
  // --- Live Jam additions ---
  agent?: boolean                 // true = written by the Marver agent (never trusted for execution; render + guard only)
  agentMeta?: AgentMeta           // provenance for the Marver avatar tooltip (agent events only)
  origin?: string                 // server-stamped 'local' on dev-owner writes; the daemon's owner-trigger key
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
  replies: { id: string; author?: CommentEvent['author']; body?: string; ts: number; agent?: boolean; agentMeta?: AgentMeta }[]
  reactions: Record<string, string[]>   // emoji -> author emails (toggle semantics)
}

/** Events the other side lacks, by id - the sync payload in either direction. */
export function diffEvents(mine: CommentEvent[], theirIds: Iterable<string>): CommentEvent[] {
  const have = new Set(theirIds)
  return mine.filter((e) => !have.has(e.id))
}

/** Replay a board's events into current thread state. Deterministic: replay order is
 *  (ts, id) so two stores holding the same event SET always derive the same state.
 *  TWO passes - creates first, then everything else - so a reply whose author's clock
 *  ran ahead of the creator's still lands instead of being dropped forever. */
export function replay(events: CommentEvent[]): Thread[] {
  const ordered = [...events].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  const threads = new Map<string, Thread>()
  for (const ev of ordered) {
    if (ev.type !== 'create') continue
    if (!ev.commentId || threads.has(ev.commentId)) continue
    threads.set(ev.commentId, {
      id: ev.commentId, board: ev.board, nodeKey: ev.nodeKey, frame: ev.frame,
      anchor: ev.anchor, author: ev.author, body: ev.body, ts: ev.ts,
      resolved: false, agent: ev.agent, agentMeta: ev.agentMeta, replies: [], reactions: {},
    })
  }
  for (const ev of ordered) {
    switch (ev.type) {
      case 'reply': {
        const t = ev.parentId ? threads.get(ev.parentId) : undefined
        if (!t || !ev.commentId || t.replies.some((r) => r.id === ev.commentId)) break
        t.replies.push({ id: ev.commentId, author: ev.author, body: ev.body, ts: ev.ts, agent: ev.agent, agentMeta: ev.agentMeta })
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
      case 'reanchor': {
        // Live Jam: re-pin the whole thread to a new element (the agent moved the target).
        const t = ev.commentId ? threads.get(ev.commentId) : undefined
        if (t && ev.anchor !== undefined) t.anchor = ev.anchor
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
