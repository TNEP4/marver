/**
 * `marver perf` (spec 26 Part 1): the reload log read back - per edited file, the frames it reached
 * and how; every page-wide reload (sent or dropped) and every time the canvas page itself booted,
 * with what came just before; the slowest frames to settle; one line per board load. Reads
 * design/.local/perf/reloads.jsonl, and page.jsonl for the loads (`--loads`: each load in full, spec 28 A1.8).
 */
import { readPage, readReloads } from '../server/perf.ts'
import { readJam } from '../server/perf-jam.ts'
import { humanize } from '../shared/board-tree.ts'

export function perfCommand(root: string, opts: { minutes?: number; json?: boolean; jam?: boolean; loads?: boolean }): void {
  if (opts.jam) return jamPerf(root, opts)
  if (opts.loads) return loadsPerf(root, opts)
  const minutes = Number(opts.minutes) > 0 ? Number(opts.minutes) : 60
  const since = Date.now() - minutes * 60_000
  const log = readReloads(root, since)
  const loads = loadsSummary(readPage(root, since))
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
      loads: loads.map((l) => ({ at: l.at, board: l.board, cause: l.cause, state: l.state, settledMs: l.settledMs, cut: l.cut, moves: l.moves.count, late: l.moves.late.count, errors: l.errors.length, lateErrors: l.errors.filter((e) => e.late).length })) }, null, 2))
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
    const w = Math.max(...loads.map((l) => (l.board ?? '?').length))
    for (const l of loads) {
      const bits = [
        endOf(l),
        ...(l.moves.count || l.moves.late.count ? [`${l.moves.count} move${l.moves.count === 1 ? '' : 's'}${l.moves.late.count ? ` (${l.moves.late.count} late)` : ''}`] : []),
        ...(l.errors.length ? [`${l.errors.length} error${l.errors.length === 1 ? '' : 's'}${lateErrors(l) ? ` (${lateErrors(l)} late)` : ''}`] : []),
      ]
      console.log(`  ${t(l.at)}  ${(l.board ?? '?').padEnd(w)}  ${(l.cause ?? '').padEnd(11)} ${bits.join(' · ')}`)
    }
  }
}

// ---- board loads, from the page (spec 28 A1.7, A1.8) ----------------------------------------------------------------

type Ranked = [string, number][]
export interface LoadSummary {
  ws: string; page: string; load: string; at: number
  board?: string; cause?: string
  /** settled; cut (a request that never committed too: `cut.request`); or open - still going, or its end past the window */
  state: 'settled' | 'cut' | 'open'
  cut?: { reason: string; ms?: number; request?: true }
  committed: boolean
  commitMs?: number; frames?: number; byKind?: Record<string, number>; measuring?: number; savedHeights?: number
  visible?: number; visibleAssumed?: true; visibleMs?: number
  visibleReadyMs?: number; allReadyMs?: number; quietMs?: number; settledMs?: number
  /** when the board last moved before the load ended (settled or cut); none while nothing moved. `quietMs` is the
   *  first second it held still after the commit - moves can come after it */
  lastMoveMs?: number
  /** the move records (a drag or a resize merged per node while unsent), their distance in px, the top causes;
   *  `late` = after settled */
  moves: { count: number; distance: number; causes: Ranked; late: { count: number; causes: Ranked } }
  /** the five slowest frames: settled, else ready, in ms from the load's request (a document kept from before it has none) */
  slowest: { node: string; frame?: string; ms: number; outcome: string }[]
  /** each error once, every one (one after the load ended is `late`: the load owns the board for as long as it stays
   *  open) - the printed report shows the first ERRORS_SHOWN and says how many more */
  errors: { source: string; frame?: string; component?: string; message: string; late?: true }[]
  /** errors past the load's 50: counted, not recorded */
  errorsNotRecorded: number
  neverReady: string[]; missing: string[]
  /** frames still pending when the load was cut */
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
    const slowest = frames.flatMap((f) => { const ms = f.settled ?? f.ready; return typeof ms === 'number' ? [{ node: f.node, ...(f.frame ? { frame: f.frame } : {}), ms, outcome: f.outcome }] : [] })
      .sort((a, b) => b.ms - a.ms).slice(0, 5)
    const seenErr = new Set<string>()
    const errors = of('error').flatMap((e) => {
      const k = `${e.source}|${e.frame ?? ''}|${e.message}|${e.late ? 'late' : ''}`
      if (seenErr.has(k)) return []
      seenErr.add(k)
      return [{ source: e.source, ...(e.frame ? { frame: e.frame } : {}), ...(e.component ? { component: e.component } : {}), message: String(e.message ?? ''), ...(e.late ? { late: true as const } : {}) }]
    })
    const gs = of('gesture')
    out.push({
      ws: g[0].ws, page: g[0].page, load: g[0].load, at: load?.ts ?? Math.min(...g.map((r) => r.ts)),
      ...(load ? { board: load.board, cause: load.cause } : {}),
      state: settled ? 'settled' : cut ? 'cut' : 'open',
      ...(cut && !settled ? { cut: { reason: cut.reason, ...(typeof cut.ms === 'number' ? { ms: cut.ms } : {}), ...(!commit ? { request: true as const } : {}) } } : {}),
      committed: !!commit,
      ...(commit ? { commitMs: commit.ms, frames: commit.frames, byKind: commit.byKind, measuring: commit.measuring, savedHeights: commit.savedHeights } : {}),
      ...(visible ? { visible: visible.nodes, visibleMs: visible.ms, ...(visible.assumed ? { visibleAssumed: true as const } : {}) } : {}),
      ...(settled ? { visibleReadyMs: settled.visibleReadyMs, allReadyMs: settled.allReadyMs, settledMs: settled.ms, weight: settled.weight } : {}),
      ...(quiet ? { quietMs: quiet.ms } : {}),
      ...(typeof (settled ?? cut)?.lastMove === 'number' ? { lastMoveMs: (settled ?? cut)!.lastMove } : {}),
      moves: { count: moves.count, distance: Math.round(moves.distance), causes: ranked(moves.causes), late: { count: late.count, causes: ranked(late.causes) } },
      slowest, errors, errorsNotRecorded: notRecorded(g),
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
const boardName = (b?: string) => (b === '~unplaced' ? 'Not on a board' : b ? humanize(b) : 'a board (its request is older)')
/** How a load ended, in a few words. */
function endOf(l: LoadSummary): string {
  if (l.state === 'settled') return `settled ${secs(l.settledMs)}`
  if (l.cut?.request) return `not committed (${l.cut.reason})`
  if (l.cut) return `cut (${l.cut.reason})${l.cut.ms !== undefined ? ` at ${secs(l.cut.ms)}` : ''}`
  return 'not settled yet'
}

/** `marver perf --loads` (spec 28 A1.8): each board load in full, from design/.local/perf/page.jsonl. */
function loadsPerf(root: string, opts: { minutes?: number; json?: boolean }) {
  const minutes = Number(opts.minutes) > 0 ? Number(opts.minutes) : 60
  const records = readPage(root, Date.now() - minutes * 60_000)
  const loads = loadsSummary(records)
  const dropped = droppedOf(records)
  if (opts.json) { console.log(JSON.stringify({ minutes, loads, unowned: unownedOf(records), dropped }, null, 2)); return }
  console.log(`board loads, last ${minutes} min - design/.local/perf/page.jsonl`)
  if (!loads.length) { console.log('\nnothing yet - open a board in the canvas'); return }
  const t = (ts: number) => new Date(ts).toLocaleTimeString()
  const list = (r: Ranked) => r.map(([k, n]) => `${k} ${n}`).join(', ')
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  for (const l of loads) {
    const head = `${boardName(l.board)}${l.cause ? ` (${l.cause})` : ''}`
    console.log(`\n  ${t(l.at)}  ${head.padEnd(40)} ${endOf(l)}`)
    if (!l.committed) continue
    const kinds = Object.entries(l.byKind ?? {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k === 'hifi' ? 'hi-fi' : k}`)
    console.log(`    committed ${secs(l.commitMs)} · ${plural(l.frames ?? 0, 'frame')}${kinds.length ? ` (${kinds.join(', ')})` : ''}${l.measuring ? ` · ${l.measuring} measure, ${l.savedHeights ?? 0} opened at a known height` : ''}`)
    const times = [
      ...(l.visibleReadyMs !== undefined ? [`visible ready ${secs(l.visibleReadyMs)}${l.visible !== undefined ? ` (${plural(l.visible, 'frame')}${l.visibleAssumed ? ', no fit' : ''})` : ''}`] : []),
      ...(l.allReadyMs !== undefined ? [`all ready ${secs(l.allReadyMs)}`] : []),
      ...(l.quietMs !== undefined ? [`quiet ${secs(l.quietMs)}`] : []),
      ...(l.lastMoveMs !== undefined ? [`last move ${secs(l.lastMoveMs)}`] : []),
      ...(l.settledMs !== undefined ? [`settled ${secs(l.settledMs)}`] : []),
    ]
    if (times.length) console.log(`    ${times.join(' · ')}`)
    const m = l.moves
    console.log(`    ${plural(m.count, 'move')}${m.count ? `, ${m.distance} px: ${list(m.causes)}` : ''}${m.late.count ? ` · late: ${m.late.count} (${list(m.late.causes)})` : ''}`)
    if (l.slowest.length) console.log(`    slowest: ${l.slowest.map((f) => `${f.frame ?? f.node} ${secs(f.ms)}`).join(', ')}`)
    const gone = [...(l.neverReady.length ? [`never ready: ${l.neverReady.join(', ')}`] : []), ...(l.missing.length ? [`missing: ${l.missing.join(', ')}`] : []), ...(l.unfinished ? [`${l.unfinished} not done when it ended`] : [])]
    if (gone.length) console.log(`    ${gone.join(' · ')}`)
    for (const e of l.errors.slice(0, ERRORS_SHOWN)) console.log(`    ${e.late ? 'late error' : 'error'} (${e.source}${e.frame ? ` ${e.frame}` : ''}${e.component ? `, in ${e.component}` : ''}): ${e.message}`)
    if (l.errors.length > ERRORS_SHOWN) console.log(`    ${plural(l.errors.length - ERRORS_SHOWN, 'more error')} not shown (--json lists every one)`)
    if (l.errorsNotRecorded) console.log(`    ${plural(l.errorsNotRecorded, 'more error')} past the first 50, not recorded`)
    if (l.gestures) console.log(`    ${plural(l.gestures.n, 'gesture')} · worst p95 ${l.gestures.worstP95} ms · ${plural(l.gestures.over33ms, 'frame')} over 33 ms`)
  }
  if (dropped) console.log(`\n  ${plural(dropped, 'record')} never reached this log: a page's queue was full, or its sends failed`)
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
