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
export interface RunsSummary { boards: unknown[]; invalid: RunLine[]; overlapped: RunLine[] }

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
  void runs; void o
  return { boards: [], invalid: [], overlapped: [] }   // A3 headless stream
}
