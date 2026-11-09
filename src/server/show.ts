/**
 * `marver show` on the dev server (spec 31 D3). `POST /__mv/api/show` (the dev token, or the owner) takes a show
 * target (shared/deep-link.ts `checkShowTarget`: the hash's own targets on one board, never a raw hash), numbers it and
 * broadcasts `sh:show { seq, board, n?, f?, s?, c? }` to every open shell tab; each tab answers `POST show/ack { seq,
 * page, outcome }` (`shown`, or `notice` when it held unsent words and did not move). `GET show/acks?seq=` is what the
 * CLI reads for its 3 s: how many tabs showed it, how many put up the notice. A newer seq supersedes an older one in
 * the tabs; here the last 32 shows keep their acks.
 */
import type { ShowTarget } from '../shared/deep-link.ts'

export const SHOW_OUTCOMES = ['shown', 'notice'] as const
export type ShowOutcome = (typeof SHOW_OUTCOMES)[number]
const KEEP = 32
const PAGE = /^[A-Za-z0-9_-]{8,64}$/

export interface Shows {
  /** a new show: its seq, and the command the tabs get */
  start(t: ShowTarget): { seq: number; cmd: ShowTarget & { seq: number } }
  /** a tab's answer: false for a seq not kept, a page or outcome off its grammar; one answer per page (the last) */
  ack(seq: unknown, page: unknown, outcome: unknown): boolean
  acks(seq: number): { shown: number; notice: number } | null
}

export function createShows(): Shows {
  let seq = 0
  const kept = new Map<number, Map<string, ShowOutcome>>()
  return {
    start(t) {
      seq += 1
      kept.set(seq, new Map())
      for (const k of kept.keys()) if (k <= seq - KEEP) kept.delete(k)
      return { seq, cmd: { ...t, seq } }
    },
    ack(s, page, outcome) {
      if (typeof s !== 'number' || !kept.has(s) || typeof page !== 'string' || !PAGE.test(page)) return false
      if (!(SHOW_OUTCOMES as readonly unknown[]).includes(outcome)) return false
      kept.get(s)!.set(page, outcome as ShowOutcome)
      return true
    },
    acks(s) {
      const m = kept.get(s)
      if (!m) return null
      let shown = 0, notice = 0
      for (const o of m.values()) { if (o === 'shown') shown++; else notice++ }
      return { shown, notice }
    },
  }
}
