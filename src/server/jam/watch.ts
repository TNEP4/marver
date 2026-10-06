/**
 * The pending-work scan. Pure over the current logs + journal: returns the
 * owner-authorized @marver mentions not yet processed. Every trigger gate is `triggers()`, in one
 * place, so the scan AND the crash-resume path (daemon.ts) apply exactly the same rule:
 *   - agent-authored events never trigger (recursion guard, §4)
 *   - only new create/reply types (edits/reacts/resolves never trigger, §2)
 *   - the body mentions @marver
 *   - the event id is in the device ledger (the trust boundary, §1) - synced-in events fail this
 */
import { listBoards, readLog, type CommentEvent } from '../comments.ts'
import { has } from './ledger.ts'
import { threadId } from './packet.ts'
import type { Journal, Pending } from './types.ts'

const MENTION = /@marver\b/i

/** Threads Marver is already ENGAGED in, each with the moment it engaged. `owners` is the ledger
 *  check: only the owner's own mentions start a conversation (a synced collaborator's never does). An owner follow-up in an
 *  engaged thread written AFTER that moment is a conversation turn - it triggers without re-tagging;
 *  one written before it never wakes a job retroactively, whatever engages the thread later.
 *  - a chat agent's note or reply from the CLI engages from that event;
 *  - a Live Jam reply engages from the @marver mention that started the conversation, so an owner
 *    follow-up written while the job ran still counts. A jam reply with no mention in its thread
 *    answered a follow-up, which a CLI event already engaged - it adds nothing. */
export function engagedThreads(events: CommentEvent[], owners: (id: string) => boolean): Map<string, number> {
  const s = new Map<string, number>()
  const engage = (thread: string, at: number) => s.set(thread, Math.min(s.get(thread) ?? Infinity, at))
  const mentioned = new Map<string, number>()   // thread -> its first OWNER @marver (ledgered - the trust gate)
  for (const ev of events) {
    if (ev.agent || (ev.type !== 'create' && ev.type !== 'reply') || !MENTION.test(ev.body ?? '') || !owners(ev.id)) continue
    const t = threadId(ev)
    if (t) mentioned.set(t, Math.min(mentioned.get(t) ?? Infinity, ev.ts))
  }
  for (const ev of events) {
    if (!ev.agent) continue
    if (ev.type === 'create' && ev.commentId) engage(ev.commentId, ev.ts)
    if (ev.type !== 'reply' || !ev.parentId) continue
    if (!ev.id.startsWith('jam-')) engage(ev.parentId, ev.ts)
    else if (mentioned.has(ev.parentId)) engage(ev.parentId, mentioned.get(ev.parentId)!)
  }
  return s
}

/** The one gate. An event on `board` triggers a job iff it passes every clause. Keyed on
 *  (board, id) in the ledger, so a synced event reusing a ledgered id on another board fails.
 *  Trigger = an explicit @marver, OR an owner REPLY in an engaged thread (answering Marver is
 *  a trigger - you don't re-tag someone mid-conversation). New threads always need the tag. */
export function triggers(root: string, board: string, ev: CommentEvent, engaged?: Map<string, number>): boolean {
  if (ev.agent) return false
  if (ev.type !== 'create' && ev.type !== 'reply') return false
  const since = ev.type === 'reply' ? engaged?.get(threadId(ev)) : undefined
  const followUp = since !== undefined && ev.ts > since
  if (!MENTION.test(ev.body ?? '') && !followUp) return false
  return has(root, board, ev.id)
}

export function scanPending(root: string, commentsDir: string, journal: Journal): Pending[] {
  const seen = new Set(journal.seen)
  const out: Pending[] = []
  for (const board of listBoards(commentsDir)) {
    const events = readLog(commentsDir, board)
    const engaged = engagedThreads(events, (id) => has(root, board, id))
    // the frame each thread sits on (a reply names only its thread) - what a hold is keyed on
    const frameOf = new Map<string, string>()
    for (const ev of events) if (ev.type === 'create' && ev.commentId && ev.frame) frameOf.set(ev.commentId, ev.frame)
    for (const ev of events) {
      if (seen.has(ev.id) || !triggers(root, board, ev, engaged)) continue
      const frame = ev.frame ?? frameOf.get(threadId(ev))
      out.push({ board, event: ev, ...(frame ? { frame } : {}) })
    }
  }
  return out
}

/** Every event id currently in the logs - the activation baseline (§3.2). */
export function allEventIds(commentsDir: string): string[] {
  const ids: string[] = []
  for (const board of listBoards(commentsDir)) for (const ev of readLog(commentsDir, board)) ids.push(ev.id)
  return ids
}
