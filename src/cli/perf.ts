/**
 * `marver perf` (spec 26 Part 1): the reload log read back - per edited file, the frames it reached
 * and how; every page-wide reload (sent or dropped) and every time the canvas page itself booted,
 * with what came just before; the slowest frames to settle; one line per board load. Reads
 * design/.local/perf/reloads.jsonl, and page.jsonl for the loads (`--loads`: each load in full, spec 28 A1.8).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { boardFields, checkBoardsDir, listBoardFiles } from '../server/boards.ts'
import { readPage, readReloads, readRuns } from '../server/perf.ts'
import { readJam } from '../server/perf-jam.ts'
import { marverHome } from '../server/slots.ts'
import { isBoardName, labelOf } from '../shared/board-tree.ts'
import type { RunLine } from '../shared/perf-run.ts'
import { crashesSummary, flashesSummary, machineSummary, PRESSURE_FRESH_MS, readAppLog, repoWorkspaces, type PageMoment } from './perf-app.ts'

export interface PerfOptions {
  minutes?: number; json?: boolean; jam?: boolean; loads?: boolean
  /** the headless runs (spec 28 A3.4, the headless stream's `--runs`, `--against`) */
  runs?: boolean; against?: string
  /** the Mac app's records (spec 28 A3.5): 14 days by default (`days`, which `--runs` reads too) */
  crashes?: boolean; flashes?: boolean; machine?: boolean; all?: boolean; days?: number | string
}

export function perfCommand(root: string, opts: PerfOptions): void {
  if (opts.jam) return jamPerf(root, opts)
  if (opts.loads) return loadsPerf(root, opts)
  if (opts.crashes) return crashesPerf(root, opts)
  if (opts.flashes) return flashesPerf(root, opts)
  if (opts.machine) return machinePerf(root, opts)
  const minutes = Number(opts.minutes) > 0 ? Number(opts.minutes) : 60
  const since = Date.now() - minutes * 60_000
  const log = readReloads(root, since)
  const { records: pageRecords, runLoads } = ownLoads(readPage(root, since))
  const loads = loadsSummary(pageRecords)
  const files = new Map<string, { edits: number; reload: Set<string>; inPlace: Set<string> }>()
  for (const e of log) if (e.kind === 'update') {
    const f = files.get(e.file ?? '(no file)') ?? { edits: 0, reload: new Set(), inPlace: new Set() }
    f.edits++
    for (const id of e.reload ?? []) f.reload.add(id)
    for (const id of e.inPlace ?? []) f.inPlace.add(id)
    files.set(e.file ?? '(no file)', f)
  }
  const reloads = log.filter((e) => e.kind === 'full-reload')
  const boots = log.flatMap((e, i) => (e.kind === 'shell-boot' ? [{ ts: e.ts, before: log.slice(Math.max(0, i - 3), i).filter((x) => x.kind !== 'ready' && x.kind !== 'settled') }] : []))
  const slow = log.filter((e) => e.kind === 'settled' && typeof e.ms === 'number').sort((a, b) => b.ms - a.ms).slice(0, 5)
  const booted = log.filter((e) => e.kind === 'ready')
  const by = (c: string) => booted.filter((e) => e.cause === c).length
  const reloaded = by('job')
  if (opts.json) {
    console.log(JSON.stringify({ minutes, files: Object.fromEntries([...files].map(([k, v]) => [k, { edits: v.edits, reached: [...v.reload], inPlace: [...v.inPlace] }])), documents: { afterEdit: reloaded, byHand: by('manual'), retried: by('retry'), self: by('self'), first: by('first') }, reloads, boots, slow,
      loads: loads.map((l) => ({ at: l.at, board: l.board, cause: l.cause, state: l.state, settledMs: l.settledMs, cut: l.cut, ...(l.mountedAfterCut ? { mountedAfterCut: true } : {}), moves: l.moves.count, late: l.moves.late.count, errors: l.errors.length, lateErrors: l.errors.filter((e) => e.late).length })), runLoads }, null, 2))
    return
  }
  const t = (ts: number) => new Date(ts).toLocaleTimeString()
  console.log(`last ${minutes} min - design/.local/perf/reloads.jsonl`)
  console.log(`\nedits (${files.size} files)`)
  for (const [file, f] of [...files].sort((a, b) => b[1].edits - a[1].edits))
    console.log(`  ${file}  ${f.edits}x  reached ${f.reload.size} frame${f.reload.size === 1 ? '' : 's'}${f.inPlace.size ? `, ${f.inPlace.size} updated in place` : ''}`)
  console.log(`\nframe documents booted: ${reloaded} after an edit (a frame off screen reloads when it comes into view), ${by('first')} first loads, ${by('manual')} by hand, ${by('retry')} watchdog retries, ${by('self')} reloaded themselves`)
  console.log(`\npage-wide reloads: ${reloads.filter((r) => r.passed).length} sent (dependency rebuilds), ${reloads.filter((r) => !r.passed).length} dropped`)
  for (const r of reloads) console.log(`  ${t(r.ts)}  ${r.passed ? 'sent   ' : 'dropped'}  ${r.triggeredBy ?? 'no file named'}`)
  console.log(`\ncanvas page loads: ${boots.length}`)
  for (const b of boots) console.log(`  ${t(b.ts)}${b.before.length ? `  after: ${b.before.map((x) => x.kind + (x.file ? ` ${x.file}` : '')).join(', ')}` : ''}`)
  if (slow.length) {
    console.log('\nslowest to settle')
    for (const s of slow) console.log(`  ${s.frame}  ${s.ms} ms`)
  }
  if (loads.length || runLoads) console.log(`\nboard loads: ${loads.length}  (--loads: each in full)`)
  if (runLoads) console.log(`(${runLoads} headless run load${runLoads === 1 ? '' : 's'} not shown: npx marver perf --runs)`)
  if (loads.length) {
    const name = namer(root)
    const w = Math.max(...loads.map((l) => name(l.board).length))
    for (const l of loads) {
      const bits = [
        endOf(l),
        ...(l.moves.count || l.moves.late.count ? [`${l.moves.count} move${l.moves.count === 1 ? '' : 's'}${l.moves.late.count ? ` (${l.moves.late.count} late)` : ''}`] : []),
        ...(l.errors.length ? [`${l.errors.length} error${l.errors.length === 1 ? '' : 's'}${lateErrors(l) ? ` (${lateErrors(l)} late)` : ''}`] : []),
      ]
      console.log(`  ${t(l.at)}  ${name(l.board).padEnd(w)}  ${(l.cause ?? '').padEnd(11)} ${bits.join(' · ')}`)
    }
  }
}

// ---- board loads, from the page (spec 28 A1.7, A1.8) ----------------------------------------------------------------

type Ranked = [string, number][]
export interface LoadSummary {
  ws: string; page: string; load: string; at: number
  board?: string; cause?: string
  /** settled; cut (a request cut before it mounted too: `cut.request`); or open - still going, or its end past the window */
  state: 'settled' | 'cut' | 'open'
  cut?: { reason: string; ms?: number; request?: true }
  committed: boolean
  /** a request cut before it mounted (its deadline passed, the page hid) whose board arrived after all: it mounted,
   *  and what its board did from then is late */
  mountedAfterCut?: true
  commitMs?: number; frames?: number; byKind?: Record<string, number>; measuring?: number; savedHeights?: number
  visible?: number; visibleAssumed?: true; visibleMs?: number
  visibleReadyMs?: number; allReadyMs?: number; quietMs?: number; settledMs?: number
  /** when the board last moved before the load ended (settled or cut); none while nothing moved. `quietMs` is the
   *  first second it held still after the commit - moves can come after it */
  lastMoveMs?: number
  /** the move records (a drag or a resize merged per node while unsent), their distance in px, the top causes;
   *  `late` = after the load ended, settled or cut (a board cut at 120 s stays open and goes on loading) */
  moves: { count: number; distance: number; causes: Ranked; late: { count: number; causes: Ranked } }
  /** the five slowest frames that reached an outcome: settled, else ready, in ms from the load's request (a document
   *  kept from before it has none) - a frame still on its way when the load was cut is `unfinished`, never here. Each
   *  says when it started (`admittedMs`: its turn in the admission queue, which starts frames a few at a time) and when
   *  it was ready (`readyMs`), so a frame's own time (`ms - admittedMs`) is told from its wait for a turn */
  slowest: { node: string; frame?: string; ms: number; outcome: string; admittedMs?: number; readyMs?: number }[]
  /** when the load's first frame started (its admission), ms from the request: the wait before anything could render */
  firstStartedMs?: number
  /** a load cut after it mounted: the frames on its board when it was cut (those added while it loaded included,
   *  those removed not), and how many of them were ready (settled, or ready) by then - both the page's, of one set */
  framesAtCut?: number; readyByCut?: number
  /** each error once, every one (one after the load ended is `late`: the load owns the board for as long as it stays
   *  open) - the printed report shows the first ERRORS_SHOWN and says how many more */
  errors: { source: string; frame?: string; component?: string; message: string; late?: true }[]
  /** errors past the load's 50: counted, not recorded */
  errorsNotRecorded: number
  neverReady: string[]; missing: string[]
  /** frames still on their way when the load was cut: they never finished */
  unfinished: number
  gestures?: { n: number; worstP95: number; over33ms: number }
  weight?: Record<string, number>
}

/** Each record once: a send retried after its first attempt landed repeats its records - same ws, page and seq. */
function unique(records: Record<string, any>[]): Record<string, any>[] {
  const seen = new Set<string>()
  return records.filter((r) => { const k = `${r.ws}/${r.page}/${r.seq}`; if (seen.has(k)) return false; seen.add(k); return true })
}
const ranked = (counts: Map<string, number>, n = 5): Ranked => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n)
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)

/** Board loads (spec 28 A1.8): page.jsonl's records grouped by ws/page/load, each group in seq order; a node's last
 *  `frame` record is its outcome. A load whose `load` record fell before the window still shows what is in it.
 *  Records of no load (`load: '-'`, before the page's first board committed) are `unownedOf`'s. */
export function loadsSummary(records: Record<string, any>[]): LoadSummary[] {
  const groups = new Map<string, Record<string, any>[]>()
  for (const r of unique(records)) {
    if (typeof r.load !== 'string' || r.load === '-' || typeof r.kind !== 'string') continue
    const k = `${r.ws}/${r.page}/${r.load}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const out: LoadSummary[] = []
  for (const g of groups.values()) {
    g.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    const of = (kind: string) => g.filter((r) => r.kind === kind)
    const one = (kind: string) => g.find((r) => r.kind === kind)
    const load = one('load'), commit = one('commit'), settled = one('settled'), cut = one('cut'), quiet = one('quiet'), visible = one('visible')
    const moves = { count: 0, distance: 0, causes: new Map<string, number>() }, late = { count: 0, causes: new Map<string, number>() }
    for (const m of of('move')) {
      const cause = typeof m.cause === 'string' ? m.cause : 'unknown'
      if (m.late) { late.count++; bump(late.causes, cause); continue }
      moves.count++
      bump(moves.causes, cause)
      moves.distance += Math.hypot(m.dx ?? 0, m.dy ?? 0) + Math.abs(m.dw ?? 0) + Math.abs(m.dh ?? 0)
    }
    const last = new Map<string, Record<string, any>>()
    for (const f of of('frame')) if (typeof f.node === 'string') last.set(f.node, f)
    const frames = [...last.values()]
    const name = (f: Record<string, any>) => String(f.frame ?? f.node)
    const num = (v: unknown): v is number => typeof v === 'number'
    const slowest = frames.filter((f) => f.outcome !== 'cut').flatMap((f) => {
      const ms = f.settled ?? f.ready
      return num(ms) ? [{ node: f.node, ...(f.frame ? { frame: f.frame } : {}), ms, outcome: f.outcome, ...(num(f.admitted) ? { admittedMs: f.admitted } : {}), ...(num(f.ready) ? { readyMs: f.ready } : {}) }] : []
    }).sort((a, b) => b.ms - a.ms).slice(0, 5)
    const started = frames.map((f) => f.admitted).filter(num)
    const seenErr = new Set<string>()
    const errors = of('error').flatMap((e) => {
      const k = `${e.source}|${e.frame ?? ''}|${e.message}|${e.late ? 'late' : ''}`
      if (seenErr.has(k)) return []
      seenErr.add(k)
      return [{ source: e.source, ...(e.frame ? { frame: e.frame } : {}), ...(e.component ? { component: e.component } : {}), message: String(e.message ?? ''), ...(e.late ? { late: true as const } : {}) }]
    })
    const gs = of('gesture')
    // the cut of the request, before it mounted - its board may have arrived after all, and mounted late
    const cutFirst = !!cut && (typeof cut.request === 'string' || !commit)
    out.push({
      ws: g[0].ws, page: g[0].page, load: g[0].load, at: load?.ts ?? Math.min(...g.map((r) => r.ts)),
      ...(load ? { board: load.board, cause: load.cause } : {}),
      state: settled ? 'settled' : cut ? 'cut' : 'open',
      ...(cut && !settled ? { cut: { reason: cut.reason, ...(typeof cut.ms === 'number' ? { ms: cut.ms } : {}), ...(cutFirst ? { request: true as const } : {}) } } : {}),
      committed: !!commit,
      ...(commit && cutFirst ? { mountedAfterCut: true as const } : {}),
      ...(commit ? { commitMs: commit.ms, frames: commit.frames, byKind: commit.byKind, measuring: commit.measuring, savedHeights: commit.savedHeights } : {}),
      ...(visible ? { visible: visible.nodes, visibleMs: visible.ms, ...(visible.assumed ? { visibleAssumed: true as const } : {}) } : {}),
      ...(settled ? { visibleReadyMs: settled.visibleReadyMs, allReadyMs: settled.allReadyMs, settledMs: settled.ms, weight: settled.weight } : {}),
      ...(quiet ? { quietMs: quiet.ms } : {}),
      ...(typeof (settled ?? cut)?.lastMove === 'number' ? { lastMoveMs: (settled ?? cut)!.lastMove } : {}),
      moves: { count: moves.count, distance: Math.round(moves.distance), causes: ranked(moves.causes), late: { count: late.count, causes: ranked(late.causes) } },
      slowest, ...(started.length ? { firstStartedMs: Math.min(...started) } : {}),
      ...(cut && !settled && commit && !cutFirst && typeof cut.frames === 'number' && typeof cut.ready === 'number' ? { framesAtCut: cut.frames, readyByCut: cut.ready } : {}),
      errors, errorsNotRecorded: notRecorded(g),
      neverReady: frames.filter((f) => f.outcome === 'never-ready').map(name),
      missing: frames.filter((f) => f.outcome === 'missing').map(name),
      unfinished: frames.filter((f) => f.outcome === 'cut').length,
      ...(gs.length ? { gestures: { n: gs.length, worstP95: Math.max(...gs.map((x) => x.p95 ?? 0)), over33ms: gs.reduce((n, x) => n + (x.over33ms ?? 0), 0) } } : {}),
    })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Errors past a load's 50 (`dropped` records with reason `errors`): counted by the page, never recorded. */
const notRecorded = (g: Record<string, any>[]) => g.filter((r) => r.kind === 'dropped' && r.reason === 'errors').reduce((n, r) => n + (Number(r.n) || 0), 0)

/** What a page recorded before its first board committed: its errors (those past 50 counted), and how many gestures. */
export function unownedOf(records: Record<string, any>[]) {
  const mine = unique(records).filter((r) => r.load === '-')
  return {
    errors: mine.filter((r) => r.kind === 'error').map((e) => ({ at: e.ts, source: e.source, ...(e.frame ? { frame: e.frame } : {}), message: e.message })),
    errorsNotRecorded: notRecorded(mine),
    gestures: mine.filter((r) => r.kind === 'gesture').length,
  }
}

/** Records the pages lost before they reached the log - past a page's queue, or in a send that failed three times
 *  (`dropped` records without a reason; errors past a load's 50 are that load's). */
export const droppedOf = (records: Record<string, any>[]): number =>
  unique(records).filter((r) => r.kind === 'dropped' && r.reason === undefined).reduce((n, r) => n + (Number(r.n) || 0), 0)

const lateErrors = (l: LoadSummary) => l.errors.filter((e) => e.late).length
/** The errors `--loads` prints for a load, as examples: the rest are counted on a line of their own (--json has all). */
const ERRORS_SHOWN = 10
const secs = (ms?: number) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : '-')
/** a wait or a frame's own time, often under a second: to the hundredth */
const secs2 = (ms: number) => (ms >= 10_000 ? secs(ms) : `${(Math.max(0, ms) / 1000).toFixed(2)} s`)
/** Each board by the name the sidebar shows it under - its title, else its name Title-Cased (board-tree's labelOf) - read
 *  from design/boards/ now; `--json` keeps the board's id. */
function namer(root: string): (board?: string) => string {
  const titles = new Map<string, string>()
  try {
    const dir = join(root, 'design', 'boards')
    if (!checkBoardsDir(root, dir)) for (const b of listBoardFiles(dir).boards) { const t = boardFields(b.json, isBoardName).title; if (t) titles.set(b.name, t) }
  } catch { /* unreadable: the names alone */ }
  return (b) => (b === '~unplaced' ? 'Not on a board' : b ? labelOf(b, titles.get(b)) : 'a board (its request is older)')
}
/** How a load ended, in a few words. */
function endOf(l: LoadSummary): string {
  if (l.state === 'settled') return `settled ${secs(l.settledMs)}`
  if (l.cut?.request && l.mountedAfterCut) return `cut (${l.cut.reason})${l.cut.ms !== undefined ? ` at ${secs(l.cut.ms)}` : ''} before it mounted · mounted ${secs(l.commitMs)}`
  if (l.cut?.request) return `not committed (${l.cut.reason})`
  if (l.cut) return `cut (${l.cut.reason})${l.cut.ms !== undefined ? ` at ${secs(l.cut.ms)}` : ''}`
  return 'not settled yet'
}

/** A page's records without a headless run's (spec 28 A3.8 #17: the server stamps them `run`; `--runs` is theirs),
 *  and how many run loads that hid. */
export function ownLoads(records: Record<string, any>[]): { records: Record<string, any>[]; runLoads: number } {
  const loads = new Set<string>()
  const own = records.filter((r) => { if (typeof r.run !== 'string') return true; if (r.kind === 'load') loads.add(`${r.ws}/${r.page}/${r.load}`); return false })
  return { records: own, runLoads: loads.size }
}

/** `marver perf --loads` (spec 28 A1.8): each board load in full, from design/.local/perf/page.jsonl. */
function loadsPerf(root: string, opts: { minutes?: number; json?: boolean }) {
  const minutes = Number(opts.minutes) > 0 ? Number(opts.minutes) : 60
  const { records, runLoads } = ownLoads(readPage(root, Date.now() - minutes * 60_000))
  const loads = loadsSummary(records)
  const dropped = droppedOf(records)
  if (opts.json) { console.log(JSON.stringify({ minutes, loads, unowned: unownedOf(records), dropped, runLoads }, null, 2)); return }
  console.log(`board loads, last ${minutes} min - design/.local/perf/page.jsonl`)
  const hidden = runLoads ? `${runLoads} headless run load${runLoads === 1 ? '' : 's'} not shown: npx marver perf --runs` : ''
  if (!loads.length) { console.log(`\nnothing yet - open a board in the canvas${hidden ? `\n  ${hidden}` : ''}`); return }
  const t = (ts: number) => new Date(ts).toLocaleTimeString()
  const list = (r: Ranked) => r.map(([k, n]) => `${k} ${n}`).join(', ')
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  const boardName = namer(root)
  for (const l of loads) {
    const head = `${boardName(l.board)}${l.cause ? ` (${l.cause})` : ''}`
    console.log(`\n  ${t(l.at)}  ${head.padEnd(40)} ${endOf(l)}`)
    if (!l.committed) continue
    const kinds = Object.entries(l.byKind ?? {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k === 'hifi' ? 'hi-fi' : k}`)
    console.log(`    ${l.mountedAfterCut ? 'mounted after its cut' : 'committed'} ${secs(l.commitMs)} · ${plural(l.frames ?? 0, 'frame')}${kinds.length ? ` (${kinds.join(', ')})` : ''}${l.measuring ? ` · ${l.measuring} measure, ${l.savedHeights ?? 0} opened at a known height` : ''}`)
    const times = [
      ...(l.firstStartedMs !== undefined ? [`first frame started ${secs2(l.firstStartedMs)}`] : []),
      ...(l.readyByCut !== undefined ? [`${l.readyByCut} of ${l.framesAtCut} ready`] : []),
      ...(l.visibleReadyMs !== undefined ? [`visible ready ${secs(l.visibleReadyMs)}${l.visible !== undefined ? ` (${plural(l.visible, 'frame')}${l.visibleAssumed ? ', no fit' : ''})` : ''}`] : []),
      ...(l.allReadyMs !== undefined ? [`all ready ${secs(l.allReadyMs)}`] : []),
      // settled: still from its last move (the commit, when nothing moved), and settled a second after that at the
      // soonest; `quiet` - the first still second, which a later move can follow - is --json's alone
      ...(l.state === 'settled' ? [`still from ${secs(l.lastMoveMs ?? l.commitMs)}`] : l.lastMoveMs !== undefined ? [`last move ${secs(l.lastMoveMs)}`] : []),
      ...(l.settledMs !== undefined ? [`settled ${secs(l.settledMs)}`] : []),
    ]
    if (times.length) console.log(`    ${times.join(' · ')}`)
    const m = l.moves
    console.log(`    ${plural(m.count, 'move')}${m.count ? `, ${m.distance} px: ${list(m.causes)}` : ''}${m.late.count ? ` · late, after it ${l.state === 'settled' ? 'settled' : l.state === 'cut' ? 'was cut' : 'ended'}: ${m.late.count} (${list(m.late.causes)})` : ''}`)
    // the slowest of the frames that finished, by when each settled - its last height, or ready for a frame that does not
    // measure: a later clock than "all ready", which is each frame's first render - how long each waited for its turn
    // to start, then took once started; those a cut left on their way, counted apart
    const took = (f: LoadSummary['slowest'][number]) => `${f.frame ?? f.node} ${secs(f.ms)}${f.admittedMs !== undefined ? ` (waited ${secs2(f.admittedMs)}, then ${secs2(f.ms - f.admittedMs)})` : ''}`
    const slow = [...(l.slowest.length ? [`slowest to settle: ${l.slowest.map(took).join(', ')}`] : []), ...(l.unfinished ? [`${l.unfinished} never finished`] : [])]
    if (slow.length) console.log(`    ${slow.join(' · ')}`)
    const gone = [...(l.neverReady.length ? [`never ready: ${l.neverReady.join(', ')}`] : []), ...(l.missing.length ? [`missing: ${l.missing.join(', ')}`] : [])]
    if (gone.length) console.log(`    ${gone.join(' · ')}`)
    for (const e of l.errors.slice(0, ERRORS_SHOWN)) console.log(`    ${e.late ? 'late error' : 'error'} (${e.source}${e.frame ? ` ${e.frame}` : ''}${e.component ? `, in ${e.component}` : ''}): ${e.message}`)
    if (l.errors.length > ERRORS_SHOWN) console.log(`    ${plural(l.errors.length - ERRORS_SHOWN, 'more error')} not shown (--json lists every one)`)
    if (l.errorsNotRecorded) console.log(`    ${plural(l.errorsNotRecorded, 'more error')} past the first 50, not recorded`)
    if (l.gestures) console.log(`    ${plural(l.gestures.n, 'gesture')} · worst p95 ${l.gestures.worstP95} ms · ${plural(l.gestures.over33ms, 'frame')} over 33 ms`)
  }
  if (dropped) console.log(`\n  ${plural(dropped, 'record')} never reached this log: a page's queue was full, or its sends failed`)
  if (hidden) console.log(`\n  ${hidden}`)
}

/** Count, median, p90 and max of a list of ms. */
export function spread(xs: number[]): { n: number; median?: number; p90?: number; max?: number } {
  if (!xs.length) return { n: 0 }
  const v = [...xs].sort((a, b) => a - b)
  const at = (q: number) => v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)]
  return { n: v.length, median: at(0.5), p90: at(0.9), max: v[v.length - 1] }
}

/** `marver perf --jam`: each step of a capture and its run - count, median, p90, max - the runs by outcome, and the
 *  last problems, from design/.local/perf/jam.jsonl (numbers and codes only). */
export function jamSummary(events: Record<string, any>[]) {
  const of = (kind: string) => events.filter((e) => e.kind === kind)
  const nums = (xs: unknown[]) => xs.filter((x): x is number => typeof x === 'number')
  const caps = of('capture'), runs = of('run').filter((r) => !r.redelivered), shots = of('shot'), words = of('words')
  const steps = {
    'capture: E to sealed': spread(nums(caps.map((c) => c.sealMs))),
    'capture: last words': spread(nums(caps.map((c) => c.wordsWaitMs))),
    'capture: a picture': spread(nums(caps.flatMap((c) => c.pictures?.ms ?? []))),
    'upload': spread(nums(of('upload').map((u) => u.ms))),
    'naming': spread(nums(of('name').map((n) => n.ms))),
    'words: wait': spread(nums(words.map((w) => w.waitMs))),
    'words: transcription': spread(nums(words.map((w) => w.decodeMs))),
    'words: model load': spread(nums(words.map((w) => w.modelLoadMs))),
    'run: queued': spread(nums(runs.flatMap((r) => (r.members ?? []).map((m: any) => m.waitMs)))),
    'run: pictures before': spread(nums(runs.map((r) => r.beforeMs))),
    'run: agent': spread(nums(runs.flatMap((r) => r.agentMs ?? []))),
    'run: pictures after': spread(nums(runs.map((r) => r.afterMs))),
    'run: delivery': spread(nums(of('run').map((r) => r.deliverMs))),
    'shot': spread(nums(shots.map((s) => s.ms))),
  }
  const outcomes: Record<string, number> = {}
  for (const r of runs) for (const m of r.members ?? []) outcomes[m.outcome ?? 'unknown'] = (outcomes[m.outcome ?? 'unknown'] ?? 0) + 1
  const problems = [
    // every run line with a failure - a redelivery that gave up too (the counts above take first runs only)
    ...of('run').filter((r) => r.failure).map((r) => ({ ts: r.ts, what: `run ${String(r.batch).slice(0, 8)} ${r.redelivered ? 'could not post its replies' : `failed: ${r.failure}`}` })),
    ...shots.filter((s) => s.outcome && s.outcome !== 'ok').map((s) => ({ ts: s.ts, what: `shot ${s.frame ?? '?'}: ${s.outcome}${s.recaptures ? ` after ${s.recaptures} retakes` : ''}` })),
    ...caps.filter((c) => c.pictures?.late || c.pictures?.failed).map((c) => ({ ts: c.ts, what: `capture ${c.capture}: ${c.pictures.late ?? 0} picture(s) too late, ${c.pictures.failed ?? 0} failed` })),
    ...of('name').filter((n) => !n.ok).map((n) => ({ ts: n.ts, what: `naming ${n.capture} gave no name` })),
    ...of('dropped').map((d) => ({ ts: d.ts, what: `${d.count} event(s) dropped (the log was busy)` })),
  ].sort((a, b) => b.ts - a.ts).slice(0, 10)
  return { steps, outcomes, problems, retakes: shots.reduce((n, s) => n + (s.recaptures ?? 0), 0) }
}

function jamPerf(root: string, opts: { minutes?: number; json?: boolean }) {
  const minutes = Number(opts.minutes) > 0 ? Number(opts.minutes) : 24 * 60
  const since = Date.now() - minutes * 60_000
  const { events, first } = readJam(root, since)
  const sum = jamSummary(events)
  const partial = first !== undefined && first > since
  if (opts.json) { console.log(JSON.stringify({ minutes, ...(partial ? { startsAt: first } : {}), ...sum }, null, 2)); return }
  const span = minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`
  console.log(`Jam timings, last ${span} - design/.local/perf/jam.jsonl${partial ? ` (the log starts ${new Date(first!).toLocaleString()})` : ''}`)
  if (!events.length) { console.log('\nnothing yet - captures, runs and shots log here as they happen'); return }
  console.log('')
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(1, n - s.length))
  console.log(`  ${pad('step', 24)}${pad('count', 7)}${pad('median', 9)}${pad('p90', 9)}max`)
  const f = (v?: number) => (v === undefined ? '-' : v >= 10_000 ? `${(v / 1000).toFixed(0)} s` : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`)
  for (const [name, x] of Object.entries(sum.steps)) if (x.n) console.log(`  ${pad(name, 24)}${pad(String(x.n), 7)}${pad(f(x.median), 9)}${pad(f(x.p90), 9)}${f(x.max)}`)
  const out = Object.entries(sum.outcomes)
  if (out.length) console.log(`\nruns by outcome: ${out.map(([k, n]) => `${n} ${k}`).join(', ')}`)
  if (sum.retakes) console.log(`pictures taken again (a stale surface): ${sum.retakes}`)
  if (sum.problems.length) {
    console.log('\nlately')
    for (const p of sum.problems) console.log(`  ${new Date(p.ts).toLocaleTimeString()}  ${p.what}`)
  }
}

// ---- the Mac app's records (spec 28 A3.5, A3.8 #23) -------------------------------------------------------------

/** What the app's half and the repo's page half read, over `--days` (14 by default). */
function appInputs(root: string, opts: PerfOptions) {
  const days = Number(opts.days) > 0 ? Math.min(90, Number(opts.days)) : 14
  const since = Date.now() - days * 86_400_000
  const home = marverHome()
  const page = ownLoads(readPage(root, since)).records
  return { days, since, home, page, app: readAppLog(home, since), workspaces: repoWorkspaces(root, page) }
}
const when = (ts: number) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const LEVEL: Record<number, string> = { 1: 'normal', 2: 'warn', 4: 'critical' }
const level = (n: unknown) => (typeof n === 'number' ? LEVEL[n] ?? String(n) : 'unknown')
const tilde = (p: string) => { const h = homedir(); return p.startsWith(h + '/') ? `~${p.slice(h.length)}` : p }
/** A long wait in words: seconds, then minutes, then hours. */
const long = (ms: number): string => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : ms < 7_200_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`)
/** An offset from a moment, signed (positive = before it), in words: never clamped. */
const offset = (ms: number): string => (ms === 0 ? 'at it' : `${secs2(Math.abs(ms))} ${ms > 0 ? 'before' : 'after'}`)
const gestureName = (t: string) => (t === 'layout' ? 'layout animation' : t)
/** A gesture against the moment: the one it fell in, else the last before it (a flash's may end after it). */
function gestureWords(g: NonNullable<PageMoment['gesture']>): string {
  const n = gestureName(g.type)
  if (g.during) return `during a ${n}${g.startedMsBefore !== undefined ? ` (started ${offset(g.startedMsBefore)}, ended ${offset(g.endedMsBefore)})` : ''}`
  if (g.endedMsBefore < 0) return `a ${n} ${g.startedMsBefore !== undefined ? `started ${offset(g.startedMsBefore)}, ` : ''}ended ${offset(g.endedMsBefore)}`
  return `last gesture a ${n}, ended ${offset(g.endedMsBefore)}`
}
/** The page half at a moment, in a few words, with how it was joined. `ended`: the moment is the document's end (a crash). */
function momentWords(m: PageMoment, name: (b?: string) => string, o: { ended?: boolean } = {}): string {
  if (m.join === 'none') return 'no page record of it (its canvas recorded nothing here)'
  // its own page and nothing else: never the tab's earlier document (A3.8 #8)
  if (m.join === 'page-unrecorded') return o.ended ? `its page ${m.page} recorded nothing before it ended (it ended before its first batch of records, 2 s?)` : `its page ${m.page} has no record in page.jsonl`
  const bits = [name(m.board)]
  if (m.load) bits.push(m.load.settled ? `its load settled${m.load.settledMs !== undefined ? ` in ${secs(m.load.settledMs)}` : ''}` : 'its load had not settled')
  if (m.gesture) bits.push(gestureWords(m.gesture))
  return bits.join(' · ') + (m.join === 'ws+time' ? ' (joined by workspace and time: the record has no page id)' : '')
}

/** `marver perf --crashes`: the app's canvas crashes and hangs for this repo, joined to the page half; the machine-wide ends by time. */
function crashesPerf(root: string, opts: PerfOptions) {
  const i = appInputs(root, opts)
  const sum = crashesSummary(i.app, i.page, i.workspaces, i.home)
  if (opts.json) { console.log(JSON.stringify({ days: i.days, workspaces: [...i.workspaces], ...sum }, null, 2)); return }
  const name = namer(root)
  console.log(`crashes, last ${i.days} days - ${tilde(join(i.home, 'perf'))}/app.jsonl and app-dev.jsonl, joined to design/.local/perf/page.jsonl by page`)
  console.log(`\ncanvas crashes: ${sum.crashes.length}`)
  for (const c of sum.crashes) {
    console.log(`  ${when(c.at)}  ${c.reason}${typeof c.exitCode === 'number' ? ` (exit ${c.exitCode})` : ''} · pid ${c.pid} · pressure ${level(c.pressure)}${c.flavour === 'dev' ? ' · Marver Dev' : ''}`)
    console.log(`    ${momentWords(c, name, { ended: true })}`)
    const b = c.before
    if (b) console.log(`    the minute before (by time, machine-wide): pressure ${level(b.pressure)}, thermal ${b.thermal}, canvases ${b.canvasMB ?? '-'} MB, the GPU process ${b.gpuProcessRssMB ?? '-'} MB${b.procMB != null ? `, this renderer ${Math.round(b.procMB)} MB` : ''}`)
  }
  if (sum.hangs.length) {
    console.log(`\nnot responding: ${sum.hangs.length}`)
    for (const h of sum.hangs) console.log(`  ${when(h.at)}  pid ${h.pid}${h.respondedAfterMs !== undefined ? `, answered again after ${secs(h.respondedAfterMs)}` : ', never answered again'} · ${momentWords(h, name)}`)
  }
  console.log(`\nby time (machine-wide): ${sum.byTime.length}`)
  for (const m of sum.byTime) console.log(`  ${when(m.at)}  ${m.text}${m.flavour === 'dev' ? ' (Marver Dev)' : ''}`)
  console.log(`\ncrash reports: ${sum.dumps} in ${tilde(join(i.home, 'perf', 'crashpad', 'completed'))}`)
}

/** `marver perf --flashes`: the marks made on this repo's canvases (`--all`: every one), and the detector's candidates apart. */
function flashesPerf(root: string, opts: PerfOptions) {
  const i = appInputs(root, opts)
  const sum = flashesSummary(i.app, i.page, i.workspaces, { all: !!opts.all, home: i.home })
  if (opts.json) { console.log(JSON.stringify({ days: i.days, workspaces: [...i.workspaces], ...sum }, null, 2)); return }
  const name = namer(root)
  console.log(`flashes marked (⌃⌥F), last ${i.days} days - ${tilde(join(i.home, 'perf'))}, joined to design/.local/perf/page.jsonl by page`)
  if (!sum.marks.length) console.log('\nnone on this repo\'s canvases')
  for (const m of sum.marks) {
    // where: from the mark's own tab and workspace, then its join - this repo's canvas with nothing near it says so
    const where = !m.tab ? 'Home or Settings' : !m.ws ? 'a canvas (no workspace recorded)' : !m.mine ? 'a canvas of another repo'
      : m.join === 'none' ? 'this repo\'s canvas (no page record near it)' : momentWords(m, name)
    console.log(`\n  ${when(m.at)}  ${where}`)
    const agx = m.agx as Record<string, unknown>
    // the pressure at the mark: its reading's age said; a reading older than 10 s then is unknown
    const age = m.pressureAgeMs
    const pressure = m.pressure !== null ? `pressure ${level(m.pressure)}${age !== undefined ? ` (read ${offset(age)})` : ''}`
      : age !== undefined && age > PRESSURE_FRESH_MS ? `pressure unknown (the last reading was ${long(age)} old at the mark)` : 'pressure unknown'
    console.log(`    ${pressure} · thermal ${m.thermal} · the GPU process ${m.gpuProcessRssMB !== null ? `${Math.round(m.gpuProcessRssMB)} MB` : 'unknown'} · GPU in use ${agx.gpuSystemMemoryMB ?? 'unknown'} MB, ${agx.utilPct ?? 'unknown'} % (machine-wide)`)
    if (m.gpuEvents.length) console.log(`    GPU process events within 1 s: ${m.gpuEvents.map((e) => `${e.kind} ${e.ts >= m.at ? '+' : '-'}${secs2(Math.abs(e.ts - m.at))}`).join(', ')}`)
    if (!m.recorder) console.log('    the recorder was off: no samples before it')
    console.log(`    ${m.picturePruned ? 'no picture: pruned since (at most 50 are kept, none older than keepPerfDays)' : m.picture ? `picture (the app's views, not the screen): ${m.picture}` : `no picture: ${m.pictureWhy ?? 'unknown'}`}`)
  }
  if (!opts.all && sum.others) console.log(`\n${sum.others} more mark${sum.others === 1 ? '' : 's'} on other canvases or on Home (--all shows them)`)
  console.log(`\nwhite-out candidates (automatic, not verified): ${sum.candidates.length}`)
  for (const c of sum.candidates) console.log(`  ${when(c.at)}  white at ${c.observedAt.length} samples ${c.rateHz ? `at ${c.rateHz} Hz ` : ''}(${c.observedAt.map((t) => secs2(t - c.at)).join(', ')}) · ${momentWords(c, name)}`)
}

/** `marver perf --machine`: the machine profiles, by host, which is current, and how many records and runs name each. */
function machinePerf(root: string, opts: PerfOptions) {
  const i = appInputs(root, opts)
  const runs = readRuns(root, i.since) as RunLine[]
  const sum = machineSummary(i.home, i.app, runs)
  if (opts.json) { console.log(JSON.stringify({ days: i.days, ...sum }, null, 2)); return }
  console.log(`machine profiles - ${tilde(join(i.home, 'perf', 'machine'))} (records of the last ${i.days} days)`)
  if (!sum.profiles.length) { console.log('\nnone yet - the Mac app and `marver perf run` write them'); return }
  const by = new Map(sum.profiles.map((p) => [p.hash, p]))
  for (const g of sum.byHost) {
    const first = by.get(g.profiles[0]!)!
    console.log(`\nhost ${g.hostHash ?? 'unknown'}: ${[first.chip, first.model, first.os ? `macOS ${first.os}` : undefined].filter(Boolean).join(' · ')}`)
    for (const h of g.profiles) {
      const p = by.get(h)!
      console.log(`  ${p.hash}  ${p.kind}${p.current ? ' (current)' : ''} · ${p.records} app record${p.records === 1 ? '' : 's'}, ${p.runs} run${p.runs === 1 ? '' : 's'}`)
      const more = [p.electron, p.gpu, p.displays, p.power ? `power ${p.power}` : undefined].filter(Boolean)
      if (more.length) console.log(`    ${more.join(' · ')}`)
    }
  }
}
