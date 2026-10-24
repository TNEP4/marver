/**
 * `marver perf` (spec 26 Part 1): the reload log read back - per edited file, the frames it reached
 * and how; every page-wide reload (sent or dropped) and every time the canvas page itself booted,
 * with what came just before; the slowest frames to settle; one line per board load. Reads
 * design/.local/perf/reloads.jsonl, and page.jsonl for the loads (`--loads`: each load in full, spec 28 A1.8).
 */
import { join } from 'node:path'
import { boardFields, checkBoardsDir, listBoardFiles } from '../server/boards.ts'
import { readPage, readReloads, readRuns } from '../server/perf.ts'
import { readJam } from '../server/perf-jam.ts'
import { readDevInfo } from '../server/work.ts'
import { isBoardName, labelOf } from '../shared/board-tree.ts'
import type { RunLine, RunStreamLine } from '../shared/perf-run.ts'
import { runsSummary } from './perf-app.ts'

export function perfCommand(root: string, opts: { minutes?: number; json?: boolean; jam?: boolean; loads?: boolean; runs?: boolean; days?: number | string; against?: string }): void {
  if (opts.jam) return jamPerf(root, opts)
  if (opts.loads) return loadsPerf(root, opts)
  if (opts.runs) return runsPerf(root, opts)
  const minutes = Number(opts.minutes) > 0 ? Number(opts.minutes) : 60
  const since = Date.now() - minutes * 60_000
  const log = readReloads(root, since)
  const loads = loadsSummary(ownLoads(readPage(root, since)).records)
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
      loads: loads.map((l) => ({ at: l.at, board: l.board, cause: l.cause, state: l.state, settledMs: l.settledMs, cut: l.cut, ...(l.mountedAfterCut ? { mountedAfterCut: true } : {}), moves: l.moves.count, late: l.moves.late.count, errors: l.errors.length, lateErrors: l.errors.filter((e) => e.late).length })) }, null, 2))
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
  if (loads.length) {
    console.log(`\nboard loads: ${loads.length}  (--loads: each in full)`)
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

// ---- headless perf runs (spec 28 A3.4, A3.8 #20-#22) ---------------------------------------------------------------

const ms2 = (v: number | null | undefined) => (typeof v === 'number' ? (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`) : '-')
const mms = (v: number | null | undefined) => (typeof v === 'number' ? `${v} ms` : '-')
const why = (l: RunLine) => `invalid: ${l.invalidReason}${l.restarted ? ' (the dev server restarted)' : l.cut ? ` (${l.cut})` : ''}`
const over33 = (n: number | null) => (n === null ? 'frames over 33 ms not measured' : `${n} frame${n === 1 ? '' : 's'} over 33 ms`)
/** What an invalid run asks of the agent, when its reason alone does not say it. */
const hint = (l: RunLine): string | null =>
  l.restarted ? 'the dev server restarted during the run (an .env or config edit): its inputs changed - run it again'
  : l.cut === 'unresponsive' ? 'the page stopped answering for 15 s: a frame\'s script that never returns (an endless loop) - open the board and see which frame hangs'
  : l.invalidReason === 'gesture' && l.over33ms === null ? 'no frame was timed: requestAnimationFrame never ran in the gestures (the page read as hidden?)'
  : null
/** One run, as `perf run` and `perf --runs` print it: three lines, and a fourth when an invalid run has a hint. */
export function runBlock(l: RunLine, name: (b?: string) => string): string[] {
  const h = l.valid ? null : hint(l)
  return [
    `run ${l.run} · ${name(l.board)} · Chrome ${l.chrome.split('.')[0]} · bakes ${l.bakes}${l.slow ? ' · --slow' : ''}${l.overlapped ? ' · overlapped' : ''}`,
    `load to settled ${ms2(l.loadToSettledMs)} · ${l.moves} move${l.moves === 1 ? '' : 's'}${l.lateMoves ? ` (${l.lateMoves} late)` : ''} · p50 ${mms(l.p50)} p95 ${mms(l.p95)} · ${over33(l.over33ms)} · heap peak ${l.heapPeakMB ?? '-'} MB${l.postersMissing ? ` · ${l.postersMissing} without a poster` : ''}`,
    `${l.valid ? 'valid' : why(l)} · inputs ${l.inputs ? `${l.inputs.hash.slice(0, 8)}… (${l.inputs.files.toLocaleString('en-US')} files)` : 'unknown'}${l.forbidden ? ` · ${l.forbidden} write${l.forbidden === 1 ? '' : 's'} refused` : ''}`,
    ...(h ? [h] : []),
  ]
}

/**
 * The stream broke before its end with a run under way: the dev server restarted in place (an .env or config edit) or
 * stopped. The run's line reaches runs.jsonl once its end has run - its pages closed, its compiles awaited, 50 s at
 * most - so it is waited for, 90 s at most, and no longer once the dev server has not answered for 5 s (it stopped).
 */
async function lineAfterDrop(root: string, run: string, port: number): Promise<RunLine | null> {
  const by = Date.now() + 90_000
  let downSince: number | null = null
  for (let n = 0; Date.now() < by; n++) {
    const l = (readRuns(root, Date.now() - 3_600_000) as RunLine[]).find((x) => x.run === run)
    if (l) return l
    if (n % 4 === 0) {
      const up = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)
      if (up) downSince = null
      else if ((downSince ??= Date.now()) < Date.now() - 5000) return null
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

/**
 * `marver perf run <board> [--slow] [--repeat n] [--json]`: the board's script in the canvas's own headless Chrome
 * (`marver dev` must be running), read-only - one line per run in design/.local/perf/runs.jsonl. Ctrl-C closes the
 * request, which cancels the run (its line says `cancelled`).
 */
export async function perfRunCommand(root: string, board: string | undefined, opts: { slow?: boolean; repeat?: string | number; json?: boolean }): Promise<number> {
  if (!board) throw new Error('name the board: marver perf run <board> [--slow] [--repeat 1-5] [--json]')
  const info = readDevInfo(root)
  if (!info) throw new Error('`marver dev` is not running in this repo (design/.local/dev.json not found) - start it first.')
  const repeat = opts.repeat === undefined ? 1 : Number(opts.repeat)
  if (!(Number.isInteger(repeat) && repeat >= 1 && repeat <= 5)) throw new Error('--repeat must be 1-5')
  const ac = new AbortController()
  const stop = () => ac.abort()
  process.once('SIGINT', stop)
  const name = namer(root)
  const lines: RunLine[] = []
  let under: string | null = null   // the run under way: its phases name it, its line ends it
  try {
    const res = await fetch(`http://localhost:${info.port}/__mv/api/perf/run`, {
      method: 'POST', signal: ac.signal,
      headers: { 'x-mv-work': info.token, 'content-type': 'application/json' },
      body: JSON.stringify({ board, slow: !!opts.slow, repeat }),
    })
    if (!res.ok || !res.body) {
      const b = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(b.error ?? `the run could not start (${res.status})`)
    }
    let buf = ''
    const dec = new TextDecoder()
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const text = buf.slice(0, nl); buf = buf.slice(nl + 1)
        let m: RunStreamLine
        try { m = JSON.parse(text) } catch { continue }
        if ('error' in m) throw new Error(m.error)
        if ('phase' in m) { under = m.run; if (!opts.json) console.log(m.phase === 'warm' ? `run ${m.run}: warming up` : m.phase === 'measured' ? '  measuring' : '  closing') }
        if ('line' in m) { under = null; lines.push(m.line); if (!opts.json) for (const l of runBlock(m.line, name)) console.log(`  ${l}`) }
      }
    }
  } catch (err) {
    if (ac.signal.aborted) { if (!opts.json) console.log('  cancelled - the run\'s line says so'); return 130 }
    // the stream broke under a run: the dev server restarted (spec 28 A3.8 #22) or stopped - its line says which
    if (!under) throw err
    if (!opts.json) console.log('  the connection to the dev server dropped - waiting for the run\'s line')
    const line = await lineAfterDrop(root, under, info.port)
    if (!line) throw new Error(`the connection to the dev server dropped during run ${under}, and no line came for it - did \`marver dev\` stop? (${(err as Error).message})`)
    lines.push(line)
    if (!opts.json) for (const l of runBlock(line, name)) console.log(`  ${l}`)
  } finally { process.off('SIGINT', stop) }
  if (opts.json) console.log(JSON.stringify({ runs: lines }, null, 2))
  else console.log(`\n  design/.local/perf/runs.jsonl · compare: npx marver perf --runs`)
  return lines.length && lines.every((l) => l.valid) ? 0 : 1
}

/** `marver perf --runs [--against <run>] [--days n]`: the headless runs, compared inside their cohorts. */
function runsPerf(root: string, opts: { days?: number | string; json?: boolean; against?: string }) {
  const days = Number(opts.days) > 0 ? Number(opts.days) : 14
  const lines = readRuns(root, Date.now() - days * 86_400_000) as RunLine[]
  const sum = runsSummary(lines, { against: opts.against })
  if (opts.json) { console.log(JSON.stringify({ days, runs: lines, ...sum }, null, 2)); return }
  const name = namer(root)
  console.log(`headless runs, last ${days} days - design/.local/perf/runs.jsonl`)
  if (!lines.length) { console.log('\nnone yet - npx marver perf run <board>'); return }
  const pct = (a: number | null, b: number | null) => (a && b !== null ? `${b >= a ? '+' : ''}${Math.round(((b - a) / a) * 100)} %` : '-')
  for (const b of sum.boards) {
    console.log(`\n  ${name(b.board)} · Chrome ${String(b.cohort.chrome).split('.')[0]} · bakes ${b.cohort.bakes}${b.cohort.slow ? ' · --slow' : ''} · ${b.runs} valid run${b.runs === 1 ? '' : 's'}`)
    const d33 = b.afterChange?.deltas.over33ms ?? null
    console.log(`    latest ${b.latest.run}: load to settled ${ms2(b.latest.loadToSettledMs)} · p95 ${mms(b.latest.p95)} · ${b.latest.over33ms ?? '-'} over 33 ms · inputs ${b.latest.inputs?.slice(0, 8) ?? 'unknown'}…`)
    if (b.sameInputs) console.log(`    against ${b.sameInputs.from.run} (same inputs): ${b.sameInputs.within10 ? 'within 10 %' : 'NOT within 10 %'} - load ${pct(b.sameInputs.from.loadToSettledMs, b.latest.loadToSettledMs)}, p95 ${pct(b.sameInputs.from.p95, b.latest.p95)}`)
    if (b.afterChange) console.log(`    after a change, against ${b.afterChange.from.run}: load ${pct(b.afterChange.from.loadToSettledMs, b.latest.loadToSettledMs)}, p95 ${pct(b.afterChange.from.p95, b.latest.p95)}, over 33 ms ${d33 === null ? '-' : `${d33 >= 0 ? '+' : ''}${d33}`}`)
  }
  if (sum.against) {
    const a = sum.against
    if ('error' in a) console.log(`\n  --against ${a.run}: ${a.error}`)
    else console.log(`\n  --against ${a.run}: ${a.to.run} ${a.within10 ? 'within 10 %' : 'differs'} - load ${pct(a.from.loadToSettledMs, a.to.loadToSettledMs)}, p95 ${pct(a.from.p95, a.to.p95)}`)
  }
  if (sum.overlapped.length) console.log(`\n  ${sum.overlapped.length} overlapped (another run at the same time): never compared - ${sum.overlapped.map((r) => r.run).join(', ')}`)
  if (sum.invalid.length) {
    console.log(`\n  invalid (${sum.invalid.length})`)
    for (const r of sum.invalid.slice(-10)) console.log(`    ${new Date(r.ts).toLocaleString()}  ${r.run}  ${name(r.board)}  ${why(r)}`)
  }
}
