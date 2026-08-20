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

/** Threads Marver is already ENGAGED in (it has replied there). An owner follow-up in one of
 *  these is a conversation turn - it triggers without re-tagging @marver. */
export function engagedThreads(events: CommentEvent[]): Set<string> {
  const s = new Set<string>()
  for (const ev of events) if (ev.agent && ev.type === 'reply' && ev.parentId) s.add(ev.parentId)
  return s
}

/** The one gate. An event on `board` triggers a job iff it passes every clause. Keyed on
 *  (board, id) in the ledger, so a synced event reusing a ledgered id on another board fails.
 *  Trigger = an explicit @marver, OR an owner REPLY in an engaged thread (answering Marver is
 *  a trigger - you don't re-tag someone mid-conversation). New threads always need the tag. */
export function triggers(root: string, board: string, ev: CommentEvent, engaged?: Set<string>): boolean {
  if (ev.agent) return false
  if (ev.type !== 'create' && ev.type !== 'reply') return false
  const followUp = ev.type === 'reply' && !!engaged?.has(threadId(ev))
  if (!MENTION.test(ev.body ?? '') && !followUp) return false
  return has(root, board, ev.id)
}

export function scanPending(root: string, commentsDir: string, journal: Journal): Pending[] {
  const seen = new Set(journal.seen)
  const out: Pending[] = []
  for (const board of listBoards(commentsDir)) {
    const events = readLog(commentsDir, board)
    const engaged = engagedThreads(events)
    for (const ev of events) {
      if (seen.has(ev.id) || !triggers(root, board, ev, engaged)) continue
      out.push({ board, event: ev })
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
