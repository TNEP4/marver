/**
 * `marver perf --all` (spec 30 R10 #46): every canvas the Mac knows, one summary, read-only and with no repo needed:
 * `~/.marver/running/*.json` (`root`, `ws`, `name`) plus the app's `state/recent.json` (`root`, `workspace`, `name`),
 * deduplicated by real path; a root with no records says so. Per canvas over `--days` (14 by default) the 4 Nov
 * baseline's columns - loads, after an edit, settled, all-ready p50/p90/max, frames max, heap max, worst gesture p95 -
 * then edit to last redraw, ambiguous and unknown full reloads, re-render totals (React's render work only), the
 * longest theme switch, comments mode's shown p50, errors by source, commands failed or unobserved by code. Then the
 * app's: launches, crashes, hangs, flashes, candidates by `why`, uncovered window time. `--json` emits the same. It
 * replaces agg-loads.mjs, with its quantile: the value at `floor(p * n)` of the sorted list.
 *
 * Every page and reload record is read once by `(page, seq)` (#7): a retry past the server's window can write one twice.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppRecord } from '../shared/app-perf.ts'
import { readPage, readReloads } from '../server/perf.ts'
import { marverHome } from '../server/slots.ts'
import { commandsSummary, type CommandsSummary } from './perf-commands.ts'
import { readAppLog } from './perf-app.ts'
import { dedupeSeq, loadsSummary, ownLoads, type LoadSummary } from './perf.ts'

type Rec = Record<string, any>

export interface KnownCanvas { root: string; name: string; ws?: string; running: boolean }

/** The canvases this Mac knows (#46): those running, then those the app remembers; one per real path, the running one's name kept. */
export function knownCanvases(home = marverHome()): KnownCanvas[] {
  const seen = new Map<string, KnownCanvas>()
  const add = (root: unknown, name: unknown, ws: unknown, running: boolean) => {
    if (typeof root !== 'string' || !root) return
    let real = root
    try { real = realpathSync(root) } catch { /* gone since: still known, its records say */ }
    const had = seen.get(real)
    if (had) { had.running ||= running; had.ws ??= typeof ws === 'string' ? ws : undefined; return }
    seen.set(real, { root: real, name: typeof name === 'string' && name ? name : real.split('/').at(-1) ?? real, ...(typeof ws === 'string' ? { ws } : {}), running })
  }
  const read = (f: string): any => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
  const running = join(home, 'running')
  let names: string[] = []
  try { names = readdirSync(running) } catch { /* none */ }
  for (const n of names.filter((x) => x.endsWith('.json')).sort()) { const e = read(join(running, n)); if (e) add(e.root, e.name, e.ws, true) }
  const recent = read(join(home, 'state', 'recent.json'))
  if (Array.isArray(recent?.canvases)) for (const e of recent.canvases) add(e?.root, e?.name, e?.workspace, false)
  return [...seen.values()]
}

/** The baseline's quantile (agg-loads.mjs): the value at `floor(p * n)` of the sorted list. */
export const quantile = (xs: readonly number[], p: number): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!
}
const nums = (xs: readonly unknown[]): number[] => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
const threes = (xs: number[]) => ({ p50: quantile(xs, 0.5), p90: quantile(xs, 0.9), max: quantile(xs, 1) })
const twos = (xs: number[]) => ({ p50: quantile(xs, 0.5), max: quantile(xs, 1) })

export interface CanvasSummary {
  root: string; name: string; ws?: string; running: boolean
  /** false: nothing recorded in the window */
  records: boolean
  loads: number; afterEdit: number; settled: number
  allReadyMs: { p50: number | null; p90: number | null; max: number | null }
  framesMax: number | null; heapMaxMB: number | null
  gestureWorstP95: { p50: number | null; max: number | null }
  editToRedrawMs: { n: number; p50: number | null; p90: number | null }
  fullReloads: { ambiguous: number; unknown: number }
  /** React's render work only (`actualDuration`), not layout or paint */
  renders: { commits: number; ms: number; inGesture: number }
  themeMaxMs: number | null
  commentsShownP50Ms: number | null
  errors: Record<string, number>
  commands: CommandsSummary
  /** lines the safety cap deleted (#43) */
  retentionCap: number
}

/**
 * Edit to last redraw (#2): a change, the revisions that carried it (`invalidate`, in parts: many to many), and the
 * latest `ready` that names one of those revisions. From the watcher's event: the change line's time less its flight,
 * else its `hmrTs`. A change no ready names is not in it.
 */
export function editToRedraw(reloads: readonly Rec[]): number[] {
  const at = new Map<string, number>()
  const revisions = new Map<string, Set<string>>()
  for (const r of reloads) {
    if (r.kind === 'change' && typeof r.change === 'string') at.set(r.change, typeof r.flightMs === 'number' ? r.ts - r.flightMs : typeof r.hmrTs === 'number' ? r.hmrTs : r.ts)
    if ((r.kind === 'invalidate' || r.kind === 'invalidate-ids') && typeof r.revision === 'string' && Array.isArray(r.changes)) {
      for (const c of r.changes) { if (typeof c !== 'string') continue; let s = revisions.get(c); if (!s) revisions.set(c, s = new Set()); s.add(r.revision) }
    }
  }
  const lastReady = new Map<string, number>()
  for (const r of reloads) {
    if (r.kind !== 'ready' || !Array.isArray(r.revisions) || typeof r.ts !== 'number') continue
    for (const v of r.revisions) if (typeof v === 'string' && r.ts > (lastReady.get(v) ?? -Infinity)) lastReady.set(v, r.ts)
  }
  const out: number[] = []
  for (const [c, t0] of at) {
    const last = Math.max(...[...(revisions.get(c) ?? [])].map((v) => lastReady.get(v) ?? -Infinity), -Infinity)
    if (last !== -Infinity && last >= t0) out.push(last - t0)
  }
  return out
}

/** One canvas's figures from what it recorded since `since`. */
export function canvasSummary(c: KnownCanvas, since: number, now = Date.now()): CanvasSummary {
  const page = dedupeSeq(ownLoads(readPage(c.root, since)).records)
  const reloads = dedupeSeq(readReloads(c.root, since))
  const loads: LoadSummary[] = loadsSummary(page)
  const settled = loads.filter((l) => l.state === 'settled')
  const fulls = reloads.filter((r) => r.kind === 'full-reload')
  const renders = { commits: 0, ms: 0, inGesture: 0 }
  for (const r of page) if (r.kind === 'renders' && Array.isArray(r.rows)) for (const x of r.rows) { renders.commits += Number(x?.commits) || 0; renders.ms += Number(x?.ms) || 0; renders.inGesture += Number(x?.inGesture) || 0 }
  const errors: Record<string, number> = {}
  for (const r of page) if (r.kind === 'error') { const k = String(r.source ?? 'unknown'); errors[k] = (errors[k] ?? 0) + 1 }
  const edits = editToRedraw(reloads)
  return {
    root: c.root, name: c.name, ...(c.ws ? { ws: c.ws } : {}), running: c.running,
    records: page.length > 0 || reloads.length > 0,
    loads: loads.length, afterEdit: loads.filter((l) => l.cause === 'disk-reload').length, settled: settled.length,
    allReadyMs: threes(nums(settled.map((l) => l.allReadyMs))),
    framesMax: quantile(nums(loads.map((l) => l.frames)), 1),
    heapMaxMB: quantile(nums(loads.map((l) => l.weight?.heapMB)), 1),
    gestureWorstP95: twos(nums(loads.map((l) => l.gestures?.worstP95))),
    editToRedrawMs: { n: edits.length, p50: quantile(edits, 0.5), p90: quantile(edits, 0.9) },
    fullReloads: { ambiguous: fulls.filter((r) => r.by === 'ambiguous').length, unknown: fulls.filter((r) => r.by === 'unknown').length },
    renders: { commits: renders.commits, ms: Math.round(renders.ms), inGesture: renders.inGesture },
    themeMaxMs: quantile(nums(page.filter((r) => r.kind === 'theme').map((r) => r.maxMs)), 1),
    commentsShownP50Ms: quantile(nums(page.filter((r) => r.kind === 'mode' && r.mode === 'comments' && r.phase === 'enter').map((r) => r.shownMs)), 0.5),
    errors,
    commands: commandsSummary(page, now),
    retentionCap: [...page, ...reloads].filter((r) => r.kind === 'dropped' && r.reason === 'retention-cap').reduce((n, r) => n + (Number(r.n) || 0), 0),
  }
}

export interface AppSummary {
  records: boolean
  launches: number
  /** launch to the first canvas uncovered, ms from process start; launches with no canvas by why */
  toFirstCanvasMs: { p50: number | null; max: number | null }
  noCanvas: Record<string, number>
  crashes: number; hangs: number; flashes: number
  candidates: Record<string, number>
  uncoveredMs: { stage: number; budget: number; hidden: number }
  capture: { captures: number; captureMs: number; overrunMs: number; skipped: number }
  commands: CommandsSummary
}

/** The app's figures from `readAppLog`'s records. A crash is a canvas renderer's end that main did not ask for. */
export function appSummary(app: readonly AppRecord[], now = Date.now()): AppSummary {
  const launches = app.filter((r) => r.kind === 'launch') as Rec[]
  const noCanvas: Record<string, number> = {}
  for (const l of launches) if (!l.firstCanvas && typeof l.why === 'string') noCanvas[l.why] = (noCanvas[l.why] ?? 0) + 1
  const candidates: Record<string, number> = {}
  for (const r of app) {
    if (r.kind !== 'whiteout-candidate') continue
    const why = (r as Rec).why as unknown
    for (const k of Array.isArray(why) && why.length ? why : ['gesture']) candidates[String(k)] = (candidates[String(k)] ?? 0) + 1
  }
  const uncoveredMs = { stage: 0, budget: 0, hidden: 0 }
  const capture = { captures: 0, captureMs: 0, overrunMs: 0, skipped: 0 }
  for (const r of app) {
    const w = r.kind === 'sample' ? (r as Rec).whiteout : null
    if (!w) continue
    for (const k of ['stage', 'budget', 'hidden'] as const) uncoveredMs[k] += Number(w.uncoveredMs?.[k]) || 0
    for (const k of ['captures', 'captureMs', 'overrunMs', 'skipped'] as const) capture[k] += Number(w[k]) || 0
  }
  return {
    records: app.length > 0,
    launches: launches.length,
    toFirstCanvasMs: twos(nums(launches.map((l) => l.firstCanvas?.uncoveredMs))),
    noCanvas,
    crashes: app.filter((r) => r.kind === 'gone' && (r as Rec).role === 'canvas' && (r as Rec).ours !== true).length,
    hangs: app.filter((r) => r.kind === 'unresponsive' && (r as Rec).role === 'canvas').length,
    flashes: app.filter((r) => r.kind === 'flash').length,
    candidates, uncoveredMs, capture,
    commands: commandsSummary(app as readonly Rec[], now),
  }
}

export interface AllSummary { days: number; canvases: CanvasSummary[]; app: AppSummary }

export function allSummary(o: { days?: number | string; home?: string; now?: number } = {}): AllSummary {
  const days = Number(o.days) > 0 ? Math.min(90, Number(o.days)) : 14
  const now = o.now ?? Date.now()
  const since = now - days * 86_400_000
  const home = o.home ?? marverHome()
  return { days, canvases: knownCanvases(home).map((c) => canvasSummary(c, since, now)), app: appSummary(readAppLog(home, since), now) }
}

// ---- the words -----------------------------------------------------------------------------------------------------

const s1 = (ms: number | null) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)}`)
const dur = (ms: number | null) => (ms === null ? '-' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`)
const tilde = (p: string) => { const h = homedir(); return p === h ? '~' : p.startsWith(h + '/') ? `~${p.slice(h.length)}` : p }
const list = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(', ')
const num1 = (v: number | null) => (v === null ? '-' : String(Math.round(v * 10) / 10))

/** A command's lines: failed and unobserved by code, interrupted. */
function commandsWords(c: CommandsSummary): string[] {
  return [
    ...(Object.keys(c.failed).length ? [`commands failed: ${list(c.failed)}`] : []),
    ...(Object.keys(c.unobserved).length ? [`unobserved: ${list(c.unobserved)}`] : []),
    ...(c.interrupted ? [`interrupted: ${c.interrupted}`] : []),
  ]
}

/** `marver perf --all`. */
export function allPerf(opts: { days?: number | string; json?: boolean }): void {
  const sum = allSummary({ days: opts.days })
  if (opts.json) { console.log(JSON.stringify(sum, null, 2)); return }
  const withRecords = sum.canvases.filter((c) => c.records).length
  console.log(`every canvas, last ${sum.days} days - ${sum.canvases.length} known, ${withRecords} with records`)
  if (!sum.canvases.length) console.log('\nno canvas known yet - a canvas this Mac ran or the app opened is listed here')
  for (const c of sum.canvases) {
    console.log(`\n  ${c.name}  ${tilde(c.root)}${c.running ? '' : '  (not running)'}`)
    if (!c.records) { console.log(existsSync(c.root) ? '    no records in the window' : '    no records: its folder is gone'); continue }
    console.log(`    loads ${c.loads} · after an edit ${c.afterEdit} · settled ${c.settled} · all ready ${s1(c.allReadyMs.p50)} / ${s1(c.allReadyMs.p90)} / ${s1(c.allReadyMs.max)} s · frames max ${c.framesMax ?? '-'} · heap max ${c.heapMaxMB === null ? '-' : `${Math.round(c.heapMaxMB)} MB`} · gesture worst p95 ${num1(c.gestureWorstP95.p50)} / ${num1(c.gestureWorstP95.max)} ms`)
    const more = [
      ...(c.editToRedrawMs.n ? [`edit to last redraw ${dur(c.editToRedrawMs.p50)} / ${dur(c.editToRedrawMs.p90)} (${c.editToRedrawMs.n})`] : []),
      ...(c.fullReloads.ambiguous || c.fullReloads.unknown ? [`full reloads ambiguous ${c.fullReloads.ambiguous}, unknown ${c.fullReloads.unknown}`] : []),
      ...(c.renders.commits ? [`re-renders ${c.renders.commits} commits, ${c.renders.ms} ms of React's render work (not layout or paint), ${c.renders.inGesture} in gestures`] : []),
      ...(c.themeMaxMs !== null ? [`theme switch max ${dur(c.themeMaxMs)}`] : []),
      ...(c.commentsShownP50Ms !== null ? [`comments mode shown p50 ${dur(c.commentsShownP50Ms)}`] : []),
    ]
    if (more.length) console.log(`    ${more.join(' · ')}`)
    const trouble = [
      ...(Object.keys(c.errors).length ? [`errors: ${list(c.errors)}`] : []),
      ...commandsWords(c.commands),
      ...(c.retentionCap ? [`${c.retentionCap} lines deleted by the safety cap`] : []),
    ]
    if (trouble.length) console.log(`    ${trouble.join(' · ')}`)
  }
  const a = sum.app
  console.log('\nthe Mac app')
  if (!a.records) { console.log('  no records in the window'); return }
  console.log(`  launches ${a.launches} · to first canvas p50 ${dur(a.toFirstCanvasMs.p50)}, max ${dur(a.toFirstCanvasMs.max)}${Object.keys(a.noCanvas).length ? ` · no canvas: ${list(a.noCanvas)}` : ''} · crashes ${a.crashes} · hangs ${a.hangs} · flashes ${a.flashes}`)
  console.log(`  white-out candidates (automatic, not verified)${Object.keys(a.candidates).length ? `: ${list(a.candidates)}` : ': 0'} · captures ${a.capture.captures}, ${dur(a.capture.captureMs)}${a.capture.overrunMs ? ` (${dur(a.capture.overrunMs)} past their 500 ms)` : ''} · uncovered window time: stage ${dur(a.uncoveredMs.stage)}, budget ${dur(a.uncoveredMs.budget)}, hidden ${dur(a.uncoveredMs.hidden)}`)
  const cmds = commandsWords(a.commands)
  if (cmds.length) console.log(`  ${cmds.join(' · ')}`)
}
