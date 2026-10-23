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
 *
 * As built: every joined item says how it was joined (`join`): `page` (the app record carries the page id its
 * document's hello sent, and page.jsonl has that page), `ws+time` (no page: a 0.27.0 canvas, or none said hello yet -
 * the page of that workspace whose records were the latest before it, within 2 minutes) or `none`. What is
 * machine-wide (the GPU process, a utility process, an app page, the minute before a crash) is joined by time alone
 * and is labelled so. Records of one launch are deduplicated by `flavour/app/seq`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { APP_LOG, parseAppLine, type AppRecord, type Flavour } from '../shared/app-perf.ts'
import type { RunLine } from '../shared/perf-run.ts'
import { workspaceId } from '../server/workspace.ts'
import { loadsSummary, type LoadSummary } from './perf.ts'

/** Both flavours' app records from `since` (epoch ms), in file order per flavour; a line without the envelope skipped; a line written twice (its launch, flavour and seq) once. */
export function readAppLog(home: string, since = 0): AppRecord[] {
  const out: AppRecord[] = []
  const seen = new Set<string>()
  for (const f of Object.keys(APP_LOG) as Flavour[]) {
    let text = ''
    try { text = readFileSync(join(home, 'perf', APP_LOG[f]), 'utf8') } catch { continue }
    for (const l of text.split('\n')) {
      const r = l ? parseAppLine(l) : null
      if (!r || r.ts < since) continue
      const k = `${r.flavour}/${r.app}/${r.seq}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(r)
    }
  }
  return out
}

/** A repo's workspaces (A3.8 #23): its own id and every `ws` its page.jsonl holds - a `--recover` run's effective one among them. */
export function repoWorkspaces(root: string, page: Record<string, any>[]): Set<string> {
  const out = new Set<string>([workspaceId(root)])
  for (const r of page) if (typeof r.ws === 'string') out.add(r.ws)
  return out
}

// ---- the joins ------------------------------------------------------------------------------------------------------

type Rec = Record<string, any>
/** How an app record met the page half. */
export type Join = 'page' | 'ws+time' | 'none'
/** What the page half says about the moment: the load that owned the board then, and the last gesture before it. */
export interface PageMoment {
  join: Join
  page?: string
  board?: string
  load?: { id: string; cause?: string; settled: boolean; settledMs?: number; state: LoadSummary['state'] }
  /** the page's last gesture record before the moment (its end), how long before */
  gesture?: { type: string; ms?: number; p95?: number; endedMsBefore: number }
}

const WS_TIME_MS = 120_000

/** The page records of the moment's page: by its id, else (no page) the workspace's page latest before it. */
function pageOf(rec: Rec, page: Rec[]): { join: Join; records: Rec[]; page?: string } {
  if (typeof rec.page === 'string') {
    const records = page.filter((r) => r.page === rec.page)
    if (records.length) return { join: 'page', records, page: rec.page }
  }
  if (typeof rec.ws === 'string') {
    let best: { page: string; ts: number } | null = null
    for (const r of page) {
      if (r.ws !== rec.ws || typeof r.ts !== 'number' || r.ts > rec.ts || rec.ts - r.ts > WS_TIME_MS) continue
      if (!best || r.ts > best.ts) best = { page: r.page, ts: r.ts }
    }
    if (best) return { join: 'ws+time', records: page.filter((r) => r.page === best!.page), page: best.page }
  }
  return { join: 'none', records: [] }
}

/** The page half at `ts`: the load whose commit came last before it (it owned the geometry), settled or not then; the last gesture that ended before it. */
export function momentOf(rec: Rec, page: Rec[], ts = rec.ts as number): PageMoment {
  const { join, records, page: id } = pageOf(rec, page)
  if (join === 'none') return { join }
  const out: PageMoment = { join, ...(id ? { page: id } : {}) }
  const commits = records.filter((r) => r.kind === 'commit' && r.ts <= ts).sort((a, b) => a.ts - b.ts)
  const owning = commits.at(-1)
  if (owning) {
    const l = loadsSummary(records).find((x) => x.load === owning.load)
    const settled = records.find((r) => r.load === owning.load && r.kind === 'settled' && r.ts <= ts)
    if (l) out.load = { id: l.load, ...(l.cause ? { cause: l.cause } : {}), settled: !!settled, ...(settled ? { settledMs: settled.ms } : {}), state: l.state }
    if (l?.board) out.board = l.board
  }
  const g = records.filter((r) => r.kind === 'gesture' && r.ts <= ts).sort((a, b) => a.ts - b.ts).at(-1)
  if (g) out.gesture = { type: g.type, ...(typeof g.ms === 'number' ? { ms: g.ms } : {}), ...(typeof g.p95 === 'number' ? { p95: g.p95 } : {}), endedMsBefore: ts - g.ts }
  return out
}

/** The minute before a moment, from the same launch (by time: machine-wide). */
function minuteBefore(app: AppRecord[], rec: AppRecord, pid?: number) {
  const s = app.filter((r) => r.kind === 'sample' && r.app === rec.app && r.flavour === rec.flavour && r.ts <= rec.ts).at(-1) as (AppRecord & { kind: 'sample' }) | undefined
  if (!s) return undefined
  const p = typeof pid === 'number' ? s.procs.find((x) => x.pid === pid) : undefined
  return {
    join: 'time' as const, ts: s.ts, msBefore: rec.ts - s.ts,
    pressure: s.pressure.last, pressureMax: s.pressure.max, thermal: s.thermal,
    canvasMB: s.canvases.memMB.last, gpuProcessRssMB: s.gpu?.gpuProcessRssMB.last ?? null,
    ...(p ? { procMB: p.footprintMB.last ?? p.rssMB.last, procCpu: p.cpu.last } : {}),
  }
}

// ---- --crashes -----------------------------------------------------------------------------------------------------

export interface CrashItem extends PageMoment {
  at: number; flavour: Flavour; app: string
  tab?: string; ws?: string; commit?: number
  pid: number; born: number; reason: string; exitCode: number
  pressure: number | null
  /** the minute before it, by time (machine-wide) */
  before?: ReturnType<typeof minuteBefore>
}
export interface HangItem extends PageMoment { at: number; flavour: Flavour; tab?: string; ws?: string; pid: number; role: string; respondedAfterMs?: number }
export interface MachineWideItem { at: number; flavour: Flavour; join: 'time'; what: 'child-gone' | 'gpu-restart' | 'app-page-gone'; text: string; record: Rec }
export interface CrashesSummary { crashes: CrashItem[]; hangs: HangItem[]; byTime: MachineWideItem[]; dumps: number }
export interface FlashItem extends PageMoment {
  at: number; id: string; via: string; flavour: Flavour; tab?: string; ws?: string
  recorder: boolean
  gpuEvents: { kind: string; ts: number }[]
  pressure: number | null; thermal: string
  gpuProcessRssMB: number | null
  agx: Rec
  /** the picture's absolute path, or null with why */
  picture: string | null; pictureWhy?: string
}
export interface CandidateItem extends PageMoment { at: number; flavour: Flavour; tab?: string; ws?: string; gestureSeq?: number; observedAt: number[]; rateHz?: number; samples?: number; skipped?: number; inconclusive?: number; gpuEvents: number }
export interface FlashesSummary { marks: FlashItem[]; others: number; candidates: CandidateItem[] }
export interface ProfileItem {
  hash: string; kind: 'app' | 'headless' | 'unknown'; hostHash: string | null; current: boolean
  records: number; runs: number; mtime: number
  chip?: string; model?: string; os?: string; electron?: string; displays?: string; gpu?: string; power?: string
}
export interface MachineSummary { profiles: ProfileItem[]; byHost: { hostHash: string | null; profiles: string[] }[] }
export interface RunsSummary { boards: unknown[]; invalid: RunLine[]; overlapped: RunLine[] }

const ofWs = (r: Rec, ws: Set<string>) => typeof r.ws === 'string' && ws.has(r.ws)

/** `--crashes`: gone (not ours) and unresponsive on this repo's canvases, joined by page; child-gone and gpu-restart by time. */
export function crashesSummary(app: AppRecord[], page: Record<string, any>[], workspaces: Set<string>, home: string): CrashesSummary {
  const crashes: CrashItem[] = []
  const hangs: HangItem[] = []
  const byTime: MachineWideItem[] = []
  for (const r of app) {
    const x = r as Rec
    if (r.kind === 'gone') {
      if (x.role !== 'canvas') { byTime.push({ at: r.ts, flavour: r.flavour, join: 'time', what: 'app-page-gone', text: `the app's ${x.role} page's renderer ended: ${x.reason}${typeof x.exitCode === 'number' ? ` (exit ${x.exitCode})` : ''}`, record: x }); continue }
      if (x.ours === true || !ofWs(x, workspaces)) continue
      crashes.push({
        at: r.ts, flavour: r.flavour, app: r.app,
        ...(x.tab ? { tab: x.tab } : {}), ...(x.ws ? { ws: x.ws } : {}), ...(typeof x.commit === 'number' ? { commit: x.commit } : {}),
        pid: x.pid, born: x.born, reason: x.reason, exitCode: x.exitCode, pressure: x.pressure ?? null,
        ...momentOf(x, page),
        before: minuteBefore(app, r, x.pid),
      })
    } else if (r.kind === 'unresponsive') {
      if (x.role !== 'canvas' || !ofWs(x, workspaces)) continue
      const back = app.find((y) => y.kind === 'responsive' && y.app === r.app && y.flavour === r.flavour && (y as Rec).tab === x.tab && (y as Rec).pid === x.pid && y.ts >= r.ts)
      hangs.push({ at: r.ts, flavour: r.flavour, ...(x.tab ? { tab: x.tab } : {}), ...(x.ws ? { ws: x.ws } : {}), pid: x.pid, role: x.role, ...(back ? { respondedAfterMs: back.ts - r.ts } : {}), ...momentOf(x, page) })
    } else if (r.kind === 'child-gone') {
      byTime.push({ at: r.ts, flavour: r.flavour, join: 'time', what: 'child-gone', text: `${x.type === 'GPU' ? 'the GPU process' : `a ${x.name ?? x.type} process`} ended: ${x.reason}${typeof x.exitCode === 'number' ? ` (exit ${x.exitCode})` : ''}`, record: x })
    } else if (r.kind === 'gpu-restart') {
      byTime.push({ at: r.ts, flavour: r.flavour, join: 'time', what: 'gpu-restart', text: `a new GPU process (pid ${x.pid}) with no ending reported${x.was ? `, after pid ${x.was.pid}` : ''}`, record: x })
    }
  }
  let dumps = 0
  try { dumps = readdirSync(join(home, 'perf', 'crashpad', 'completed')).filter((n) => n.endsWith('.dmp')).length } catch { /* none */ }
  const byAt = (a: { at: number }, b: { at: number }) => a.at - b.at
  return { crashes: crashes.sort(byAt), hangs: hangs.sort(byAt), byTime: byTime.sort(byAt), dumps }
}

// ---- --flashes -----------------------------------------------------------------------------------------------------

/** `--flashes`: marks on this repo's canvases (all with `all`), joined by page to the board and a gesture within 2 s; candidates apart. */
export function flashesSummary(app: AppRecord[], page: Record<string, any>[], workspaces: Set<string>, o: { all?: boolean; home?: string } = {}): FlashesSummary {
  const marks: FlashItem[] = []
  const candidates: CandidateItem[] = []
  let others = 0
  for (const r of app) {
    const x = r as Rec
    if (r.kind === 'flash') {
      const mine = ofWs(x, workspaces)
      if (!mine) { others++; if (!o.all) continue }
      const m = momentOf(x, page)
      // a gesture joins a mark when it ended within 2 s of it, before or after (the page writes the record at its end)
      const pg = m.page ? page.filter((p) => p.page === m.page && p.kind === 'gesture' && Math.abs(p.ts - r.ts) <= 2000).sort((a, b) => Math.abs(a.ts - r.ts) - Math.abs(b.ts - r.ts))[0] : undefined
      const gesture = pg ? { type: pg.type, ...(typeof pg.ms === 'number' ? { ms: pg.ms } : {}), ...(typeof pg.p95 === 'number' ? { p95: pg.p95 } : {}), endedMsBefore: r.ts - pg.ts } : undefined
      const { gesture: _g, ...rest } = m
      void _g
      marks.push({
        at: r.ts, id: x.id, via: x.via, flavour: r.flavour, ...(x.tab ? { tab: x.tab } : {}), ...(x.ws ? { ws: x.ws } : {}),
        recorder: !!x.recorder,
        gpuEvents: Array.isArray(x.gpuEvents) ? x.gpuEvents.map((e: Rec) => ({ kind: e.kind, ts: e.ts })) : [],
        pressure: x.pressure?.level ?? null, thermal: x.thermal ?? 'unknown',
        gpuProcessRssMB: x.now?.gpu?.gpuProcessRssMB ?? null,
        agx: x.agx ?? {},
        picture: typeof x.picture === 'string' && o.home ? join(o.home, 'perf', x.picture) : (typeof x.picture === 'string' ? x.picture : null),
        ...(x.pictureWhy ? { pictureWhy: x.pictureWhy } : {}),
        ...rest, ...(gesture ? { gesture } : {}),
      })
    } else if (r.kind === 'whiteout-candidate') {
      if (!ofWs(x, workspaces) && !o.all) continue
      const observedAt: number[] = Array.isArray(x.observedAt) ? x.observedAt : []
      candidates.push({
        at: observedAt[0] ?? r.ts, flavour: r.flavour, ...(x.tab ? { tab: x.tab } : {}), ...(x.ws ? { ws: x.ws } : {}),
        ...(typeof x.gesture === 'number' ? { gestureSeq: x.gesture } : {}),
        observedAt, rateHz: x.rateHz, samples: x.samples, skipped: x.skipped, inconclusive: x.inconclusive,
        gpuEvents: Array.isArray(x.gpuEvents) ? x.gpuEvents.length : 0,
        ...momentOf(x, page, observedAt[0] ?? r.ts),
      })
    }
  }
  const byAt = (a: { at: number }, b: { at: number }) => a.at - b.at
  return { marks: marks.sort(byAt), others, candidates: candidates.sort(byAt) }
}

// ---- --machine -----------------------------------------------------------------------------------------------------

/** `--machine`: the profiles under perf/machine, by hostHash, which is current, and how many records and runs name each. */
export function machineSummary(home: string, app: AppRecord[], runs: RunLine[]): MachineSummary {
  const dir = join(home, 'perf', 'machine')
  let names: string[] = []
  try { names = readdirSync(dir).filter((n) => /^[0-9a-f]{16}\.json$/.test(n)) } catch { /* none */ }
  const named = new Map<string, number>()
  for (const r of app) if (r.machine) named.set(r.machine, (named.get(r.machine) ?? 0) + 1)
  const ran = new Map<string, number>()
  for (const l of runs) if (typeof l.machine === 'string') ran.set(l.machine, (ran.get(l.machine) ?? 0) + 1)
  // current: the hash the newest app line names, per flavour; and the newest run's
  const current = new Set<string>()
  for (const f of Object.keys(APP_LOG) as Flavour[]) { const last = app.filter((r) => r.flavour === f && r.machine).at(-1); if (last?.machine) current.add(last.machine) }
  const lastRun = [...runs].sort((a, b) => a.ts - b.ts).at(-1)
  if (lastRun?.machine) current.add(lastRun.machine)
  const profiles: ProfileItem[] = []
  for (const n of names) {
    const hash = n.slice(0, 16)
    let p: Rec = {}
    let mtime = 0
    try { p = JSON.parse(readFileSync(join(dir, n), 'utf8')) as Rec; mtime = statSync(join(dir, n)).mtimeMs } catch { /* unreadable: listed as unknown */ }
    const kind = p.kind === 'app' || p.kind === 'headless' ? p.kind : 'unknown'
    const host: Rec = p.host ?? {}
    profiles.push({
      hash, kind, hostHash: typeof p.hostHash === 'string' ? p.hostHash : null, current: current.has(hash),
      records: named.get(hash) ?? 0, runs: ran.get(hash) ?? 0, mtime,
      ...(host.chip ? { chip: host.chip } : {}), ...(host.model ? { model: host.model } : {}), ...(host.os ? { os: host.os } : {}),
      ...(p.electron ? { electron: `Electron ${p.electron}, Chrome ${p.chrome}` } : {}),
      ...(Array.isArray(p.displays) ? { displays: p.displays.map((d: Rec) => `${d.internal ? 'built-in' : 'external'} ${d.pixels?.[0]}x${d.pixels?.[1]} @ ${d.hz} Hz`).join(', ') } : {}),
      ...(p.gpu ? { gpu: `${p.gpu.renderer}${p.gpu.gpuCores !== 'unknown' ? `, ${p.gpu.gpuCores} cores` : ''}` } : {}),
      ...(p.power ? { power: typeof p.power === 'string' ? p.power : p.power.source } : {}),
    })
  }
  profiles.sort((a, b) => Number(b.current) - Number(a.current) || b.mtime - a.mtime)
  const byHost = new Map<string | null, string[]>()
  for (const p of profiles) byHost.set(p.hostHash, [...(byHost.get(p.hostHash) ?? []), p.hash])
  return { profiles, byHost: [...byHost].map(([hostHash, ps]) => ({ hostHash, profiles: ps })) }
}

/** `--runs`: comparisons inside one cohort (script, board, chrome, flags, machine, power, slow, bakes), by inputs; `against` two runs of one cohort. */
export function runsSummary(runs: RunLine[], o: { against?: string } = {}): RunsSummary {
  void runs; void o
  return { boards: [], invalid: [], overlapped: [] }   // A3 headless stream
}
