/**
 * `marver perf --crashes`, `--flashes`, `--machine` and `--runs` (spec 28 A3.5, A3.8 #22, #23): the app's records
 * (`~/.marver/perf/app.jsonl` and Marver Dev's `app-dev.jsonl`), the repo's `page.jsonl` and `runs.jsonl`, joined by
 * `page` and by workspace; time only for records that cannot carry a page (machine-wide samples), and the output says
 * so. Owners: the recorder stream (`--crashes`, `--flashes`, `--machine`), the headless stream (`--runs`).
 *
 * FROZEN signatures (A3.8 #53). Joins: a repo's workspaces are `workspaceId(root)` and every `ws` in its page.jsonl
 * (a `--recover` run's); a tab record with no page joins by `ws` and time; A1's dedup by `ws/page/seq` stays.
 * `--crashes`, `--flashes` and `--machine` cover 14 days by default; `--flashes` shows marks on this repo's canvases
 * and how many others (`--all` adds them); automatic candidates are their own section, "automatic, not verified".
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_LOG, parseAppLine, type AppRecord, type Flavour } from '../shared/app-perf.ts'
import type { RunLine } from '../shared/perf-run.ts'

/** Both flavours' app records from `since` (epoch ms), in file order per flavour; a line without the envelope skipped. */
export function readAppLog(home: string, since = 0): AppRecord[] {
  const out: AppRecord[] = []
  for (const f of Object.keys(APP_LOG) as Flavour[]) {
    let text = ''
    try { text = readFileSync(join(home, 'perf', APP_LOG[f]), 'utf8') } catch { continue }
    for (const l of text.split('\n')) { const r = l ? parseAppLine(l) : null; if (r && r.ts >= since) out.push(r) }
  }
  return out
}

export interface CrashesSummary { crashes: unknown[]; hangs: unknown[]; byTime: unknown[]; dumps: number }
export interface FlashesSummary { marks: unknown[]; others: number; candidates: unknown[] }
export interface MachineSummary { profiles: unknown[] }
/** `boards`: one entry per board and cohort (the headless stream typed it; it was `unknown[]`); `against` with --against. */
export interface RunsSummary { boards: RunBoard[]; invalid: RunLine[]; overlapped: RunLine[]; against?: (RunCompare & { run: string; within10: boolean }) | { run: string; error: string } }

/** `--crashes`: gone (not ours) and unresponsive on this repo's canvases, joined by page; child-gone and gpu-restart by time. */
export function crashesSummary(app: AppRecord[], page: Record<string, any>[], workspaces: Set<string>, home: string): CrashesSummary {
  void app; void page; void workspaces; void home
  return { crashes: [], hangs: [], byTime: [], dumps: 0 }   // A3 recorder stream
}
/** `--flashes`: marks on this repo's canvases (all with `all`), joined by page to the board and a gesture within 2 s; candidates apart. */
export function flashesSummary(app: AppRecord[], page: Record<string, any>[], workspaces: Set<string>, o: { all?: boolean } = {}): FlashesSummary {
  void app; void page; void workspaces; void o
  return { marks: [], others: 0, candidates: [] }   // A3 recorder stream
}
/** `--machine`: the profiles under perf/machine, by hostHash, which is current, and how many records and runs name each. */
export function machineSummary(home: string, app: AppRecord[], runs: RunLine[]): MachineSummary {
  void home; void app; void runs
  return { profiles: [] }   // A3 recorder stream
}
/** `--runs`: comparisons inside one cohort (script, board, chrome, flags, machine, power, slow, bakes), by inputs; `against` two runs of one cohort. */
export function runsSummary(runs: RunLine[], o: { against?: string } = {}): RunsSummary {
  const ordered = [...runs].sort((a, b) => a.ts - b.ts)
  const comparable = (r: RunLine) => r.valid && !r.overlapped
  const cohorts = new Map<string, RunLine[]>()
  for (const r of ordered.filter(comparable)) { const k = cohortKey(r); cohorts.set(k, [...(cohorts.get(k) ?? []), r]) }
  const boards: RunBoard[] = []
  for (const list of cohorts.values()) {
    const latest = list[list.length - 1]
    const before = list.slice(0, -1).reverse()
    const same = before.find((r) => r.inputs?.hash === latest.inputs?.hash)
    const other = before.find((r) => r.inputs?.hash !== latest.inputs?.hash)
    boards.push({
      board: latest.board, cohort: cohortOf(latest), runs: list.length, latest: brief(latest),
      ...(same ? { sameInputs: { ...compare(same, latest), within10: within(same, latest) } } : {}),
      ...(other ? { afterChange: compare(other, latest) } : {}),
    })
  }
  boards.sort((a, b) => a.board.localeCompare(b.board) || b.latest.ts - a.latest.ts)
  const out: RunsSummary = { boards, invalid: ordered.filter((r) => !r.valid), overlapped: ordered.filter((r) => r.valid && r.overlapped) }
  if (o.against) {
    const base = ordered.find((r) => r.run === o.against)
    if (!base) out.against = { run: o.against, error: 'no such run in the window' }
    else {
      const latest = [...ordered].reverse().find((r) => r.run !== base.run && cohortKey(r) === cohortKey(base) && comparable(r))
      out.against = latest && comparable(base)
        ? { run: base.run, ...compare(base, latest), within10: within(base, latest) }
        : { run: base.run, error: !comparable(base) ? `run ${base.run} is ${base.valid ? 'overlapped' : `invalid (${base.invalidReason})`}: never compared` : 'no later valid run of its cohort (script, board, Chrome, flags, machine, power, --slow, bakes)' }
    }
  }
  return out
}

/** One board's runs of one cohort: the latest valid one, against the one before with the same inputs, and against the
 *  latest with other inputs. */
export interface RunBoard {
  board: string
  cohort: Record<string, unknown>
  runs: number
  latest: RunBrief
  sameInputs?: RunCompare & { within10: boolean }
  afterChange?: RunCompare
}
export interface RunBrief { run: string; ts: number; inputs: string | null; loadToSettledMs: number | null; p50: number | null; p95: number | null; over33ms: number | null; heapPeakMB: number | null; moves: number }
export interface RunCompare { from: RunBrief; to: RunBrief; deltas: { loadToSettledMs: number | null; p95: number | null; over33ms: number | null; heapPeakMB: number | null } }

/** Runs compare only inside one cohort (A3.8 #22). */
export const cohortOf = (r: RunLine) => ({ script: r.script, board: r.board, chrome: r.chrome, flags: r.flags, machine: r.machine, power: r.power, slow: r.slow, bakes: r.bakes })
const cohortKey = (r: RunLine) => JSON.stringify(cohortOf(r))
const brief = (r: RunLine): RunBrief => ({ run: r.run, ts: r.ts, inputs: r.inputs?.hash ?? null, loadToSettledMs: r.loadToSettledMs, p50: r.p50, p95: r.p95, over33ms: r.over33ms, heapPeakMB: r.heapPeakMB, moves: r.moves })
const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((b - a) * 10) / 10)
function compare(a: RunLine, b: RunLine): RunCompare {
  return { from: brief(a), to: brief(b), deltas: { loadToSettledMs: diff(a.loadToSettledMs, b.loadToSettledMs), p95: diff(a.p95, b.p95), over33ms: diff(a.over33ms, b.over33ms), heapPeakMB: diff(a.heapPeakMB, b.heapPeakMB) } }
}
/** Two runs agree: `loadToSettledMs` and `p95` each within 10 % of the earlier one's (A3.7). */
export function within(a: RunLine, b: RunLine, pct = 10): boolean {
  const ok = (x: number | null, y: number | null) => x !== null && y !== null && Math.abs(y - x) <= (Math.max(Math.abs(x), 1) * pct) / 100
  return ok(a.loadToSettledMs, b.loadToSettledMs) && ok(a.p95, b.p95)
}
