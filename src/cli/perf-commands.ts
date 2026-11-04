/**
 * The `cmd` records read back (spec 30 R12 #48, #49, for R10's summary): commands failed or unobserved by code, and those
 * interrupted - a start with no end whose page or app is gone, which is never written, only read. Page and app alike.
 *
 * A start is `interrupted` once its longest possible deadline has passed with no end: a page still alive writes an end
 * (at the latest `unobserved`) by then, so a start past it has no live page behind it.
 */
type Rec = Record<string, any>

/** #49's longest deadline (board-open and history-nav: 120 s, export 120 s), and a batch's way to the log. */
export const CMD_DEADLINE_MAX_MS = 130_000

export interface CommandsSummary {
  /** failed, by code */
  failed: Record<string, number>
  /** unobserved, by code (`deadline`, `hidden`, ...) */
  unobserved: Record<string, number>
  interrupted: number
}

/** Each command's last word, once: a `late` second end does not count against it; the first end says what was seen by its deadline. */
export function commandsSummary(records: readonly Rec[], now = Date.now()): CommandsSummary {
  const failed: Record<string, number> = {}, unobserved: Record<string, number> = {}
  const ended = new Set<string>()
  const started = new Map<string, number>()
  const seen = new Set<string>()
  const add = (o: Record<string, number>, k: unknown) => { const c = typeof k === 'string' && k ? k : 'unknown'; o[c] = (o[c] ?? 0) + 1 }
  for (const r of records) {
    if (r.kind !== 'cmd' || typeof r.id !== 'string') continue
    if (r.phase === 'start') { started.set(r.id, r.ts); continue }
    if (r.late) { ended.add(r.id); continue }
    ended.add(r.id)
    if (seen.has(r.id)) continue
    seen.add(r.id)
    if (r.outcome === 'failed') add(failed, r.why)
    else if (r.outcome === 'unobserved') add(unobserved, r.why)
  }
  let interrupted = 0
  for (const [id, ts] of started) if (!ended.has(id) && now - ts > CMD_DEADLINE_MAX_MS) interrupted++
  return { failed, unobserved, interrupted }
}
