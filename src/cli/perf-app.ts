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
 * document's hello sent, and page.jsonl has that page), `page-unrecorded` (it carries a page id and page.jsonl has
 * nothing of that page - a renderer that ended before its first 2 s batch: never another document's page, A3.8 #8),
 * `ws+time` (no page id at all: a 0.27.0 canvas, or none said hello yet - the page of that workspace whose records
 * were the latest before it, within 2 minutes) or `none`. What is machine-wide (the GPU process, a utility process,
 * an app page, the minute before a crash) is joined by time alone and is labelled so. Records of one launch are
 * deduplicated by `flavour/app/seq`. A flash is dated by its mark (`now.ts`, `markTime`), not by its line's `ts`,
 * which is when it was written, about mark + 2 s (A3.8 #13).
 *
 * A gesture record is written at the gesture's end, `ms` long: it spans `[ts - ms, ts]`. A moment inside that span
 * was *during* the gesture (a flash during a zoom, a white-out candidate, a hang); else the gesture is the last one
 * that ended before the moment (a flash: the nearest end within 2 s, before or after it). Every offset is signed,
 * never clamped.
 *
 * The flashes' and candidates' "GPU process events" are the GPU process's alone (`child-gone` of type GPU,
 * `gpu-restart`, `gpu`), whatever a line holds: a renderer's end or a utility process's is not one. A flash's pressure
 * is the reading at the mark only when it was at most 10 s old then (two samples); older, it is unknown.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
/** How an app record met the page half: by its page id; its page id with nothing of that page recorded; by workspace and time (no page id); none. */
export type Join = 'page' | 'page-unrecorded' | 'ws+time' | 'none'
/**
 * A gesture against a moment. The page writes a gesture's record at its end (`ts`), `ms` long, so it spans
 * `[ts - ms, ts]`. Both offsets are signed: positive = before the moment, negative = after it.
 */
export interface GestureAt {
  type: string; ms?: number; p95?: number
  /** the moment fell inside the gesture */
  during: boolean
  /** from the gesture's start to the moment (when its `ms` is known) */
  startedMsBefore?: number
  /** from the gesture's end to the moment: negative when it ended after the moment */
  endedMsBefore: number
}
/** What the page half says about the moment: the load that owned the board then, and the gesture it fell in or the last one before it. */
export interface PageMoment {
  join: Join
  page?: string
  board?: string
  load?: { id: string; cause?: string; settled: boolean; settledMs?: number; state: LoadSummary['state'] }
  gesture?: GestureAt
}

const WS_TIME_MS = 120_000
/** A flash joins the gesture it fell in, else the one whose end is nearest within this, before or after (A3.3). */
export const FLASH_GESTURE_MS = 2000
/** A pressure reading older than this at the mark (two 5 s samples) is unknown there (A3.8 #13). */
export const PRESSURE_FRESH_MS = 10_000

/**
 * The page records of the moment's page. A record with a page id joins that page or nothing: a document never gets
 * another document's records (A3.8 #8) - with none of its own (it ended before its first batch) it is
 * `page-unrecorded`. Only a record with no page id joins by workspace and time: that workspace's page whose records
 * were the latest before `ts`, within 2 minutes.
 */
function pageOf(rec: Rec, page: Rec[], ts: number): { join: Join; records: Rec[]; page?: string } {
  if (typeof rec.page === 'string') {
    const records = page.filter((r) => r.page === rec.page)
    return { join: records.length ? 'page' : 'page-unrecorded', records, page: rec.page }
  }
  if (typeof rec.ws === 'string') {
    let best: { page: string; ts: number } | null = null
    for (const r of page) {
      if (r.ws !== rec.ws || typeof r.ts !== 'number' || r.ts > ts || ts - r.ts > WS_TIME_MS) continue
      if (!best || r.ts > best.ts) best = { page: r.page, ts: r.ts }
    }
    if (best) return { join: 'ws+time', records: page.filter((r) => r.page === best!.page), page: best.page }
  }
  return { join: 'none', records: [] }
}

/**
 * When a flash was marked: its `now` sample's `ts`, taken in the mark's turn (A3.8 #13 step 2). The line's own `ts`
 * is when it was written - after the +1 s GPU window, the AGX read and the picture, so about mark + 2 s - and is
 * used only for a record with no `now`.
 */
export function markTime(x: Rec): number {
  const t = x.now?.ts
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : x.ts
}

/**
 * The gesture a moment fell in - the latest to start, should two hold it - else the last that ended before it, or
 * with `withinMs` the one whose end is nearest the moment within that, before or after.
 */
export function gestureAt(records: Rec[], ts: number, withinMs?: number): GestureAt | undefined {
  const gs = records.filter((r) => r.kind === 'gesture' && typeof r.ts === 'number')
  const start = (g: Rec): number => (typeof g.ms === 'number' && g.ms >= 0 ? g.ts - g.ms : g.ts)
  const inside = gs.filter((g) => start(g) <= ts && ts <= g.ts).sort((a, b) => start(a) - start(b)).at(-1)
  const near = (withinMs === undefined ? gs.filter((g) => g.ts <= ts) : gs.filter((g) => Math.abs(g.ts - ts) <= withinMs))
    .sort((a, b) => Math.abs(a.ts - ts) - Math.abs(b.ts - ts))[0]
  const g = inside ?? near
  if (!g) return undefined
  return {
    type: g.type, ...(typeof g.ms === 'number' ? { ms: g.ms } : {}), ...(typeof g.p95 === 'number' ? { p95: g.p95 } : {}),
    during: g === inside,
    ...(typeof g.ms === 'number' && g.ms >= 0 ? { startedMsBefore: ts - start(g) } : {}),
    endedMsBefore: ts - g.ts,
  }
}

/** The page half at `ts`: the load whose commit came last before it (it owned the geometry), settled or not then; the gesture it fell in, or the last before it (`gestureWithinMs`: the nearest end within that, either side). */
export function momentOf(rec: Rec, page: Rec[], ts = rec.ts as number, o: { gestureWithinMs?: number } = {}): PageMoment {
  const { join, records, page: id } = pageOf(rec, page, ts)
  if (join === 'none' || join === 'page-unrecorded') return { join, ...(id ? { page: id } : {}) }
  const out: PageMoment = { join, ...(id ? { page: id } : {}) }
  const commits = records.filter((r) => r.kind === 'commit' && r.ts <= ts).sort((a, b) => a.ts - b.ts)
  const owning = commits.at(-1)
  if (owning) {
    const l = loadsSummary(records).find((x) => x.load === owning.load)
    const settled = records.find((r) => r.load === owning.load && r.kind === 'settled' && r.ts <= ts)
    if (l) out.load = { id: l.load, ...(l.cause ? { cause: l.cause } : {}), settled: !!settled, ...(settled ? { settledMs: settled.ms } : {}), state: l.state }
    if (l?.board) out.board = l.board
  }
  const g = gestureAt(records, ts, o.gestureWithinMs)
  if (g) out.gesture = g
  return out
}

/** The GPU process's own events (A3.3, A3.8 #13): its end, its silent replacement, a feature change - never a renderer's or a utility process's. */
export const isGpuProcessEvent = (e: Rec): boolean => e?.kind === 'gpu-restart' || e?.kind === 'gpu' || (e?.kind === 'child-gone' && e.type === 'GPU')

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
  /** on one of this repo's canvases (its workspace one of the repo's) */
  mine: boolean
  recorder: boolean
  /** the GPU process's events from 1 s before the mark to 1 s after it */
  gpuEvents: { kind: string; ts: number }[]
  /** the level at the mark: null when unknown, or when the reading was older than 10 s then (`pressureAgeMs` says how old) */
  pressure: number | null; pressureAgeMs?: number
  thermal: string
  gpuProcessRssMB: number | null
  agx: Rec
  /** the picture's absolute path, or null with why; `picturePruned` when the file is gone since (50 are kept) */
  picture: string | null; pictureWhy?: string; picturePruned?: true
}
export interface CandidateItem extends PageMoment { at: number; flavour: Flavour; tab?: string; ws?: string; gestureSeq?: number; observedAt: number[]; rateHz?: number; samples?: number; skipped?: number; inconclusive?: number; gpuEvents: number }
export interface FlashesSummary { marks: FlashItem[]; others: number; candidates: CandidateItem[] }
export interface ProfileItem {
  hash: string; kind: 'app' | 'headless' | 'unknown'; hostHash: string | null; current: boolean
  records: number; runs: number; mtime: number
  chip?: string; model?: string; os?: string; electron?: string; displays?: string; gpu?: string; power?: string
}
export interface MachineSummary { profiles: ProfileItem[]; byHost: { hostHash: string | null; profiles: string[] }[] }
/** `boards`: one entry per board and cohort (the headless stream typed it; it was `unknown[]`); `against` with --against. */
export interface RunsSummary { boards: RunBoard[]; invalid: RunLine[]; overlapped: RunLine[]; against?: (RunCompare & { run: string; within10: boolean }) | { run: string; error: string } }

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

/** `--flashes`: marks on this repo's canvases (all with `all`), joined by page to the board and the gesture the mark fell in or ended within 2 s of it; candidates apart. */
export function flashesSummary(app: AppRecord[], page: Record<string, any>[], workspaces: Set<string>, o: { all?: boolean; home?: string } = {}): FlashesSummary {
  const marks: FlashItem[] = []
  const candidates: CandidateItem[] = []
  let others = 0
  for (const r of app) {
    const x = r as Rec
    if (r.kind === 'flash') {
      const mine = ofWs(x, workspaces)
      if (!mine) { others++; if (!o.all) continue }
      // every figure is measured from the mark, never from when its line was written (about mark + 2 s)
      const at = markTime(x)
      const p = x.pressure as Rec | null | undefined
      const age = typeof p?.at === 'number' && p.at > 0 ? at - p.at : undefined
      const fresh = age === undefined || age <= PRESSURE_FRESH_MS
      const picture = typeof x.picture === 'string' ? (o.home ? join(o.home, 'perf', x.picture) : x.picture) : null
      marks.push({
        at, id: x.id, via: x.via, flavour: r.flavour, ...(x.tab ? { tab: x.tab } : {}), ...(x.ws ? { ws: x.ws } : {}),
        mine, recorder: !!x.recorder,
        gpuEvents: Array.isArray(x.gpuEvents) ? x.gpuEvents.filter(isGpuProcessEvent).map((e: Rec) => ({ kind: e.kind, ts: e.ts })) : [],
        pressure: fresh ? p?.level ?? null : null, ...(age !== undefined ? { pressureAgeMs: age } : {}),
        thermal: x.thermal ?? 'unknown',
        gpuProcessRssMB: x.now?.gpu?.gpuProcessRssMB ?? null,
        agx: x.agx ?? {},
        picture,
        ...(x.pictureWhy ? { pictureWhy: x.pictureWhy } : {}),
        ...(picture && o.home && !existsSync(picture) ? { picturePruned: true as const } : {}),
        // the gesture the mark fell in, else the one whose end is nearest within 2 s, either side
        ...momentOf(x, page, at, { gestureWithinMs: FLASH_GESTURE_MS }),
      })
    } else if (r.kind === 'whiteout-candidate') {
      if (!ofWs(x, workspaces) && !o.all) continue
      const observedAt: number[] = Array.isArray(x.observedAt) ? x.observedAt : []
      candidates.push({
        at: observedAt[0] ?? r.ts, flavour: r.flavour, ...(x.tab ? { tab: x.tab } : {}), ...(x.ws ? { ws: x.ws } : {}),
        ...(typeof x.gesture === 'number' ? { gestureSeq: x.gesture } : {}),
        observedAt, rateHz: x.rateHz, samples: x.samples, skipped: x.skipped, inconclusive: x.inconclusive,
        gpuEvents: Array.isArray(x.gpuEvents) ? x.gpuEvents.filter(isGpuProcessEvent).length : 0,
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
      // the latest run of its cohort AFTER it: the deltas always go from the earlier run to the later (the review of
      // a3-runs' fixes - the latest other run could be older, and its signs reversed)
      const latest = [...ordered].reverse().find((r) => r.run !== base.run && r.ts > base.ts && cohortKey(r) === cohortKey(base) && comparable(r))
      out.against = latest && comparable(base)
        ? { run: base.run, ...compare(base, latest), within10: within(base, latest) }
        : { run: base.run, error: !comparable(base) ? `run ${base.run} is ${base.valid ? 'overlapped' : `invalid (${base.invalidReason})`}: never compared` : 'no later valid run of its cohort (script, board, Chrome, flags, machine, power, --slow, bakes) - pass the earlier run' }
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
