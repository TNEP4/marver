/**
 * Sidebar marks (spec 25 "what is new, what needs you", variant B - one slot). Pure: the shell and
 * the tests read the same rules.
 *
 * Two signals. NEW: a frame changed since you looked (blue). NEEDS YOU: an open Marver question on
 * a frame (orange). A row keeps ONE slot at its right edge; what fills it, first match wins: a
 * question (the bubble with how many), then the row's own count or status, then a frame's dot.
 */
import type { Thread } from './events.ts'

/** What the dev server says (spec 26): revisions, never clock times. `changed` = the last revision
 *  that touched a frame; `doc` = the last one that needs a new document to be seen; `seen` = the
 *  revision you acknowledged. `epoch` names the state: it changes only when the state starts over. */
export interface Marks {
  epoch: string
  changed: Record<string, number>
  doc: Record<string, number>
  seen: Record<string, number>
  /** each board's frames - a board you are not on rolls up over these */
  boards: Record<string, string[]>
}

export const isNew = (m: Marks | null, id: string): boolean =>
  !!m && (m.changed[id] ?? 0) > (m.seen[id] ?? 0)

/** A question's state is read from its thread - nobody sets it. Open with Marver's word last:
 *  needs you. Open with yours last, after Marver spoke: answered, waiting on the agent. */
export type Ask = { ask: number; answered: number }
export function questions(threads: readonly Thread[]): Map<string, Ask> {
  const out = new Map<string, Ask>()
  for (const t of threads) {
    if (t.resolved || !t.frame) continue
    const last = t.replies.length ? t.replies[t.replies.length - 1] : t
    const marver = !!t.agent || t.replies.some((r) => r.agent)
    if (!marver) continue
    const q = out.get(t.frame) ?? { ask: 0, answered: 0 }
    if (last.agent) q.ask++
    else q.answered++
    out.set(t.frame, q)
  }
  return out
}

/** A single frame's mark. */
export type FrameMark = { kind: 'ask' | 'answered'; n: number } | { kind: 'new' } | null
export function frameMark(m: Marks | null, q: Map<string, Ask>, id: string): FrameMark {
  const a = q.get(id)
  if (a?.ask) return { kind: 'ask', n: a.ask }
  if (a?.answered) return { kind: 'answered', n: a.answered }
  return isNew(m, id) ? { kind: 'new' } : null
}

/** A row that stands for many frames (a board you are not on, a folder, a folded scene). */
export function rollup(m: Marks | null, q: Map<string, Ask>, ids: Iterable<string>): { asks: number; fresh: number } {
  let asks = 0, fresh = 0
  for (const id of new Set(ids)) { asks += q.get(id)?.ask ?? 0; if (isNew(m, id)) fresh++ }
  return { asks, fresh }
}

/** `U`: the next frame that needs you, else the next new one - after `from` in reading order,
 *  wrapping. `order` is the board's frames top-to-bottom, left-to-right. */
export function nextToLook(m: Marks | null, q: Map<string, Ask>, order: readonly string[], from: string | null): string | null {
  const i = from ? order.indexOf(from) : -1
  const ring = [...order.slice(i + 1), ...order.slice(0, i + 1)]
  // an answered frame waits on the agent, not on you: U skips it even when it is also new
  return ring.find((id) => (q.get(id)?.ask ?? 0) > 0) ?? ring.find((id) => isNew(m, id) && !q.get(id)?.answered) ?? null
}
