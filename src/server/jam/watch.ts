/**
 * The pending-work scan (SPEC-live-jam §3.1). Pure over the current logs + journal: returns the
 * owner-authorized @marver mentions not yet processed. Every trigger gate is `triggers()`, in one
 * place, so the scan AND the crash-resume path (daemon.ts) apply exactly the same rule:
 *   - agent-authored events never trigger (recursion guard, §4)
 *   - only new create/reply types (edits/reacts/resolves never trigger, §2)
 *   - the body mentions @marver
 *   - the event id is in the device ledger (the trust boundary, §1) - synced-in events fail this
 */
import { listBoards, readLog, type CommentEvent } from '../comments.ts'
import { has } from './ledger.ts'
import type { Journal, Pending } from './types.ts'

const MENTION = /@marver\b/i

/** The one gate. An event on `board` triggers a job iff it passes every clause. Keyed on
 *  (board, id) in the ledger, so a synced event reusing a ledgered id on another board fails. */
export function triggers(root: string, board: string, ev: CommentEvent): boolean {
  if (ev.agent) return false
  if (ev.type !== 'create' && ev.type !== 'reply') return false
  if (!MENTION.test(ev.body ?? '')) return false
  return has(root, board, ev.id)
}

export function scanPending(root: string, commentsDir: string, journal: Journal): Pending[] {
  const seen = new Set(journal.seen)
  const out: Pending[] = []
  for (const board of listBoards(commentsDir)) {
    for (const ev of readLog(commentsDir, board)) {
      if (seen.has(ev.id) || !triggers(root, board, ev)) continue
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
