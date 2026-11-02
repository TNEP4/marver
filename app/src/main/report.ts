/**
 * The performance report, made and saved (spec 28 A5.1 #26-#28; r1 #9). Owner: the report stream. What may leave and
 * how it is folded is `src/shared/app-report.ts`'s (`PerfReport` v1, frozen); this file reads its sources and writes
 * the one file. Electron is never imported here: the save panel, Finder and the alert are views.ts's ports
 * (effects.ts), so the whole flow runs in unit tests on temporary folders.
 *
 * **Sources** (#26): `~/.marver/perf/` only - this flavour's log (`app.jsonl`, Marver Dev's `app-dev.jsonl`), the
 * machine profiles its lines name (`machine/<hash>.json`, the hash checked by the envelope's pattern) and
 * `crashpad/`'s `completed/` and `pending/` reports, counted by their file's time. Never a repo's `.marver/perf/`:
 * board loads and run lines are `npx marver perf`'s, in that repo.
 *
 * **Never blocking main on a whole file**: the log is read as a stream (`readline` over a read stream), a line outside
 * the window skipped by its envelope's `ts` before it is parsed; a rotation renaming a new file over it meanwhile
 * leaves this read on the old one, whole. A read that fails after some lines gives what it read, `partial`; one that
 * fails before any, `unreadable`.
 *
 * **Where it is offered** (#28): Help > Export Performance Report… and the crashed tab page's latched state, both
 * `exportReport`. A save panel on `~/Downloads/Marver-report-YYYY-MM-DD.json` (the person's local date); the report
 * made once a path is chosen, after the log's queued lines are appended (perflog's 2 s flush, run now), so it holds
 * the moments before the click; written whole (fsx `writeWhole`: a temp file beside it, fsync, rename - a failure
 * removes the temp file, so no half-written file is ever left), then shown in Finder. Nothing is uploaded. A failure
 * says why in an alert. One export at a time: another while one runs does nothing.
 */
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { APP_LOG, type Flavour } from '../../../src/shared/app-perf.ts'
import { ReportFold, reportDays, type CrashpadSection, type LogRead, type PerfReport, type ProfileRead, type SectionStatus } from '../../../src/shared/app-report.ts'
import { readCapped, writeWhole } from './fsx.ts'

const DAY = 86_400_000
/** a profile's file, at most */
const PROFILE_MAX = 65_536
/** Crashpad's reports looked at per folder (retention keeps 10 completed ones) */
const DUMPS_LOOKED = 500
const DMP = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\.dmp$/

/** An error's errno code, never its text (which may hold a path); `fallback` for one with none. */
const codeOf = (e: unknown, fallback = 'EIO'): string => {
  const c = (e as NodeJS.ErrnoException | null)?.code
  return typeof c === 'string' && /^E[A-Z0-9]{1,20}$/.test(c) ? c : fallback
}

/** What a report is made from: the perf folder, the flavour, `keepPerfDays`, now, and the running app's versions. */
export interface ReportInput {
  /** `<MARVER_HOME>/perf` */
  perfDir: string
  flavour: Flavour
  keepPerfDays: unknown
  now: number
  version: string
  electron: string
  macos: string
}

/** The log, line by line into the fold: how the read went. */
async function readLog(file: string, fold: ReportFold): Promise<LogRead> {
  let fh: Awaited<ReturnType<typeof open>>
  try { fh = await open(file, 'r') } catch (e) { return codeOf(e) === 'ENOENT' ? 'missing' : 'unreadable' }
  let lines = 0
  let failed = false
  const input = fh.createReadStream({ encoding: 'utf8' })
  input.on('error', () => { failed = true })
  const rl = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of rl) { lines += 1; fold.line(line) }
  } catch { failed = true } finally {
    rl.close()
    input.destroy()
    await fh.close().catch(() => { /* closed with its stream */ })
  }
  return failed ? (lines > 0 ? 'stopped' : 'unreadable') : 'ok'
}

/** A named profile's file: its JSON, absent, or unreadable (an error, past 64 KB, or no JSON). */
async function readProfile(file: string): Promise<ProfileRead> {
  const b = await readCapped(file, PROFILE_MAX)
  if (b === undefined) return 'absent'
  if (!Buffer.isBuffer(b)) return 'unreadable'
  try { return { json: JSON.parse(b.toString('utf8')) } } catch { return 'unreadable' }
}

/** Crashpad's completed and pending reports whose file's time is in the window: counts only (#26). */
async function crashpadCounts(dir: string, start: number, end: number): Promise<CrashpadSection> {
  try {
    if (!(await stat(dir)).isDirectory()) return { status: 'unreadable', completed: 0, pending: 0 }
  } catch (e) { return { status: codeOf(e) === 'ENOENT' ? 'missing' : 'unreadable', completed: 0, pending: 0 } }
  let status: SectionStatus = 'ok'
  const count = async (sub: string): Promise<number> => {
    let names: string[]
    try { names = await readdir(join(dir, sub)) } catch (e) { if (codeOf(e) !== 'ENOENT') status = 'partial'; return 0 }
    const dumps = names.filter((n) => DMP.test(n))
    if (dumps.length > DUMPS_LOOKED) status = 'partial'
    let n = 0
    for (const name of dumps.slice(0, DUMPS_LOOKED)) {
      try { const t = (await stat(join(dir, sub, name))).mtimeMs; if (t >= start && t <= end) n += 1 } catch { /* gone meanwhile (retention) */ }
    }
    return n
  }
  const completed = await count('completed')
  const pending = await count('pending')
  return { status, completed, pending }
}

/** The report (#26, #27): its sources read, folded and bounded. Never throws for a source it cannot read - its section says so. */
export async function buildReport(i: ReportInput): Promise<{ report: PerfReport; json: string }> {
  const end = i.now
  const start = end - reportDays(i.keepPerfDays) * DAY
  const fold = new ReportFold(start, end)
  const log = await readLog(join(i.perfDir, APP_LOG[i.flavour]), fold)
  // the hash is the envelope's, 16 hex (readEnvelope): a file name, never a path
  for (const hash of fold.wanted()) fold.profile(hash, await readProfile(join(i.perfDir, 'machine', `${hash}.json`)))
  const crashpad = await crashpadCounts(join(i.perfDir, 'crashpad'), start, end)
  return fold.finish({ made: i.now, version: i.version, electron: i.electron, macos: i.macos, flavour: i.flavour, log, crashpad })
}

// ---- the export (#28) ---------------------------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, '0')
/** The save panel's name: `Marver-report-YYYY-MM-DD.json`, the person's local date. */
export function reportName(now: number): string {
  const d = new Date(now)
  return `Marver-report-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`
}

/** The alert's words (#28): why, in words, never a path or an error's text. */
export const REPORT_FAILED = 'The performance report wasn\'t saved'
export function failureDetail(stage: 'panel' | 'make' | 'write', code: string): string {
  if (stage === 'panel') return `The save panel didn't open (${code}). Nothing was written.`
  if (stage === 'make') return `Something went wrong while making it (${code}). Nothing was written.`
  switch (code) {
    case 'ENOSPC': case 'EDQUOT': return 'The disk is full. Free some space, then export it again.'
    case 'EACCES': case 'EPERM': return 'Marver can\'t write to that folder. Choose another one.'
    case 'EROFS': return 'That disk is read-only. Choose another folder.'
    case 'ENOENT': case 'ENOTDIR': return 'That folder isn\'t there any more. Choose another one.'
    case 'EISDIR': return 'A folder already has that name. Choose another name.'
    case 'ENAMETOOLONG': return 'That name is too long. Choose a shorter one.'
    default: return `Marver couldn't write it (${code}). Nothing was written.`
  }
}

export interface ExportPorts {
  /** the save panel on `defaultPath`: the path chosen, or null when cancelled (effects.ts) */
  savePanel(defaultPath: string): Promise<string | null>
  /** the file written, selected in Finder (effects.ts) */
  showItem(file: string): void
  /** a failure, said in an alert (effects.ts) */
  alert(message: string, detail: string): void
  /** the log's queued lines appended now (perflog's 2 s flush), so the report holds the moments before the click */
  flush(): Promise<unknown>
  /** `~/Downloads` */
  downloads(): string
  /** what the report is made from, read when it is made */
  input(): ReportInput
}

export type ExportResult =
  | { result: 'saved'; file: string; bytes: number }
  | { result: 'cancelled' }
  | { result: 'failed'; stage: 'panel' | 'make' | 'write'; code: string }
  | { result: 'busy' }

let busy = false

/** Help > Export Performance Report… and the latched crashed page's button (#28): one at a time. */
export async function exportReport(p: ExportPorts): Promise<ExportResult> {
  if (busy) return { result: 'busy' }
  busy = true
  try {
    let file: string | null
    try { file = await p.savePanel(join(p.downloads(), reportName(Date.now()))) } catch (e) {
      const code = codeOf(e, 'ERROR')
      p.alert(REPORT_FAILED, failureDetail('panel', code))
      return { result: 'failed', stage: 'panel', code }
    }
    if (!file) return { result: 'cancelled' }
    let json: string
    try {
      await p.flush().catch(() => { /* a failed append is perflog's to say; the report reads what is on disk */ })
      json = (await buildReport(p.input())).json
    } catch (e) {
      const code = codeOf(e, 'ERROR')
      p.alert(REPORT_FAILED, failureDetail('make', code))
      return { result: 'failed', stage: 'make', code }
    }
    try { await writeWhole(file, json, 0o644) } catch (e) {
      const code = codeOf(e)
      p.alert(REPORT_FAILED, failureDetail('write', code))
      return { result: 'failed', stage: 'write', code }
    }
    p.showItem(file)
    return { result: 'saved', file, bytes: Buffer.byteLength(json) }
  } finally { busy = false }
}
