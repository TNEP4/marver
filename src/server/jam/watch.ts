/**
 * The pending-work scan (SPEC-live-jam §3.1). Pure over the current logs + journal: returns the
 * owner-authorized @marver mentions not yet processed. Every gate is here, in one place:
 *   - agent-authored events never trigger (recursion guard, §4)
 *   - only new create/reply types (edits/reacts/resolves never trigger, §2)
 *   - the event id is not already batched (journal.seen)
 *   - the body mentions @marver
 *   - the event id is in the device ledger (the trust boundary, §1) - synced-in events fail this
 */
import { listBoards, readLog } from '../comments.ts'
import { has } from './ledger.ts'
import type { Journal, Pending } from './types.ts'

const MENTION = /@marver\b/i

export function scanPending(root: string, commentsDir: string, journal: Journal): Pending[] {
  const seen = new Set(journal.seen)
  const out: Pending[] = []
  for (const board of listBoards(commentsDir)) {
    for (const ev of readLog(commentsDir, board)) {
      if (ev.agent) continue
      if (ev.type !== 'create' && ev.type !== 'reply') continue
      if (seen.has(ev.id)) continue
      if (!MENTION.test(ev.body ?? '')) continue
      if (!has(root, ev.id)) continue
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
