/**
 * The `cmd` records read back (spec 30 R12 #48, #49, for R10's summary): commands failed or unobserved by code, and a
 * start with no end, which is never written, only read. Page and app alike.
 *
 * `interrupted` takes evidence that its page or app ended, read from the lifecycle lines: a page its tab replaced
 * (`shell-boot`'s `prev`), a page the app says is gone (`gone`), a launch of the app after the one that ran it - or that
 * held its page (a later `start` of that flavour). Elapsed time alone proves nothing: past its longest deadline a live
 * page has written an end, so what is left is `unmatched` - a renderer hung, a Mac asleep, a batch lost, a tab closed -
 * and the records do not say which (R0). Under that deadline with no evidence, it may still be going, and is neither.
 */
type Rec = Record<string, any>

/** #49's longest deadline (board-open and history-nav: 120 s, export 120 s), and a batch's way to the log. */
export const CMD_DEADLINE_MAX_MS = 130_000

export interface CommandsSummary {
  /** failed, by code */
  failed: Record<string, number>
  /** unobserved, by code (`deadline`, `hidden`, ...) */
  unobserved: Record<string, number>
  /** a start with no end, whose page or app is shown to have ended */
  interrupted: number
  /** a start with no end past its longest deadline, and nothing to say its page or app ended */
  unmatched: number
}

/** What the lifecycle lines prove: did the page or the launch behind this start end after it? */
function endedAfter(lifecycle: readonly Rec[]): (start: Rec) => boolean {
  const gone = new Set<string>()
  /** a page, and one app line that names it: its launch */
  const held = new Map<string, Rec>()
  const starts: Rec[] = []
  for (const r of lifecycle) {
    if (r.kind === 'shell-boot' && typeof r.prev === 'string') gone.add(r.prev)
    if (typeof r.app !== 'string') continue
    if (r.kind === 'start') starts.push(r)
    const page = r.page ?? r.firstCanvas?.page
    if (typeof page !== 'string') continue
    held.set(page, r)
    if (r.kind === 'gone') gone.add(page)
  }
  const launchedAfter = (of: Rec, ts: number) => starts.some((s) => s.app !== of.app && s.flavour === of.flavour && s.ts > ts)
  return (start) => {
    if (typeof start.app === 'string') return launchedAfter(start, start.ts)
    if (gone.has(start.page)) return true
    const launch = held.get(start.page)
    return !!launch && launchedAfter(launch, start.ts)
  }
}

/**
 * Each command's last word, once: a `late` second end does not count against it; the first end says what was seen by
 * its deadline. `lifecycle`: the lines that say a page or a launch ended, beside `records` when they live elsewhere.
 */
export function commandsSummary(records: readonly Rec[], now = Date.now(), lifecycle: readonly Rec[] = records): CommandsSummary {
  const failed: Record<string, number> = {}, unobserved: Record<string, number> = {}
  const ended = new Set<string>()
  const started = new Map<string, Rec>()
  const seen = new Set<string>()
  const add = (o: Record<string, number>, k: unknown) => { const c = typeof k === 'string' && k ? k : 'unknown'; o[c] = (o[c] ?? 0) + 1 }
  for (const r of records) {
    if (r.kind !== 'cmd' || typeof r.id !== 'string') continue
    if (r.phase === 'start') { started.set(r.id, r); continue }
    if (r.late) { ended.add(r.id); continue }
    ended.add(r.id)
    if (seen.has(r.id)) continue
    seen.add(r.id)
    if (r.outcome === 'failed') add(failed, r.why)
    else if (r.outcome === 'unobserved') add(unobserved, r.why)
  }
  const isOver = endedAfter(lifecycle)
  let interrupted = 0, unmatched = 0
  for (const [id, start] of started) {
    if (ended.has(id)) continue
    if (isOver(start)) interrupted++
    else if (now - start.ts > CMD_DEADLINE_MAX_MS) unmatched++
  }
  return { failed, unobserved, interrupted, unmatched }
}
