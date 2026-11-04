import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allPerf, allSummary, appSummary, editToRedraw, knownCanvases, quantile } from '../src/cli/perf-all.ts'
import { commandsSummary } from '../src/cli/perf-commands.ts'
import { perfCommand } from '../src/cli/perf.ts'

/**
 * Spec 30 R10 #46: `marver perf --all` over two fixture roots and a fake MARVER_HOME (running/ and state/recent.json):
 * every canvas the Mac knows, deduplicated by real path, read-only and with no repo; the 4 Nov baseline's columns with
 * agg-loads.mjs's quantile; what the spec adds; the app's section; a root with no records says so; `--flashes --all`
 * keeps its meaning.
 */

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0)
const MIN = 60_000, DAY = 86_400_000
const WS = '163cf821d349d94a', PG = '90879e227f04'
let base = '', home = '', one = '', two = '', gone = ''
const ln = (rs: unknown[]) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n'
const perf = (root: string) => join(root, 'design', '.local', 'perf')
const wasHome = process.env.MARVER_HOME

/** One board load as the page records it: settled, or cut. */
let seq = 0
function load(id: string, ago: number, o: { cause?: string; allReady?: number; frames?: number; heap?: number; p95?: number; cut?: boolean } = {}) {
  const env = (kind: string, at: number, body: Record<string, unknown>) => ({ v: 1, ws: WS, page: PG, load: id, seq: seq++, ts: NOW - at, kind, ...body })
  return [
    env('load', ago, { board: 'main', cause: o.cause ?? 'boot', request: id }),
    env('commit', ago - 100, { request: id, ms: 100, frames: o.frames ?? 10, byKind: { hifi: 1 } }),
    ...(o.cut ? [env('cut', ago - 200, { reason: 'reload', ms: 200, frames: o.frames ?? 10, ready: 1 })] : [env('settled', ago - 300, { ms: 300, moves: 0, allReadyMs: o.allReady ?? 1000, visibleReadyMs: 500, weight: { heapMB: o.heap ?? 100 } })]),
    ...(o.p95 !== undefined ? [env('gesture', ago - 400, { type: 'pan', ms: 100, frames: 6, p95: o.p95, over33ms: 0 })] : []),
  ]
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mv-r30-all-')))
  home = join(base, 'home'); one = join(base, 'one'); two = join(base, 'two'); gone = join(base, 'gone')
  for (const d of [join(home, 'running'), join(home, 'state'), join(home, 'perf'), perf(one), perf(two)]) mkdirSync(d, { recursive: true })
  writeFileSync(join(home, 'running', 'slot-1.json'), JSON.stringify({ v: 1, state: 'ready', root: one, ws: WS, name: 'One Canvas', port: 4805 }))
  // the same canvas, through a link and by the app's memory: one row, the running name kept
  symlinkSync(one, join(base, 'one-link'))
  writeFileSync(join(home, 'state', 'recent.json'), JSON.stringify({ v: 1, canvases: [
    { workspace: WS, root: join(base, 'one-link'), name: 'Old Name', origin: 'x', lastSeen: 1 },
    { workspace: 'bbbbbbbbbbbbbbbb', root: two, name: 'Two Canvas', origin: 'y', lastSeen: 2 },
    { workspace: 'cccccccccccccccc', root: gone, name: 'Gone Canvas', origin: 'z', lastSeen: 3 },
  ] }))
  writeFileSync(join(home, 'running', 'junk.json'), '{')
  process.env.MARVER_HOME = home
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  seq = 0
})
afterEach(() => { vi.useRealTimers(); process.env.MARVER_HOME = wasHome; rmSync(base, { recursive: true, force: true }) })

describe('the canvases the Mac knows (#46)', () => {
  it('those running and those the app remembers, deduplicated by real path; a broken file costs only itself', () => {
    expect(knownCanvases(home)).toEqual([
      { root: one, name: 'One Canvas', ws: WS, running: true },
      { root: two, name: 'Two Canvas', ws: 'bbbbbbbbbbbbbbbb', running: false },
      { root: gone, name: 'Gone Canvas', ws: 'cccccccccccccccc', running: false },
    ])
  })
  it('no home yet: none, and no throw', () => { expect(knownCanvases(join(base, 'nowhere'))).toEqual([]) })
})

describe('one summary per canvas (#46)', () => {
  it('the baseline\'s columns, as agg-loads.mjs computed them: loads, after an edit, settled, all ready, frames, heap, worst gesture p95', () => {
    writeFileSync(join(perf(one), 'page.jsonl'), ln([
      ...load('a00000000001', 100 * MIN, { allReady: 1000, frames: 10, heap: 100, p95: 16 }),
      ...load('a00000000002', 90 * MIN, { allReady: 2000, frames: 75, heap: 2356.3, p95: 30, cause: 'disk-reload' }),
      ...load('a00000000003', 80 * MIN, { allReady: 3000, p95: 9 }),
      ...load('a00000000004', 70 * MIN, { allReady: 9000, cause: 'disk-reload', cut: true }),
    ]))
    const c = allSummary({ now: NOW, home }).canvases.find((x) => x.name === 'One Canvas')!
    expect(c).toMatchObject({ records: true, running: true, loads: 4, afterEdit: 2, settled: 3, framesMax: 75, heapMaxMB: 2356.3 })
    // floor(p * n) of the sorted list: [1000, 2000, 3000]: p50 index 1, p90 index 2, max index 2
    expect(c.allReadyMs).toEqual({ p50: 2000, p90: 3000, max: 3000 })
    expect(c.gestureWorstP95).toEqual({ p50: 16, max: 30 })
    expect(quantile([3, 1, 2, 4], 0.5)).toBe(3)
  })

  it('what the spec adds: edit to last redraw through revisions, ambiguous and unknown reloads, re-renders, theme, comments, errors, commands', () => {
    const env = (kind: string, at: number, body: Record<string, unknown>) => ({ v: 1, ws: WS, page: PG, load: '-', seq: seq++, ts: NOW - at, kind, ...body })
    writeFileSync(join(perf(one), 'page.jsonl'), ln([
      env('renders', 10 * MIN, { minute: 1, rows: [{ who: 'shell', commits: 3, ms: 10.5, maxMs: 5, inGesture: 1 }, { who: 'n1', frame: 'x/1', commits: 7, ms: 20, maxMs: 9, inGesture: 0 }] }),
      env('renders', 9 * MIN, { minute: 2, rows: [{ who: 'others', commits: 2, ms: 1, maxMs: 1, inGesture: 0, rows: 4 }] }),
      env('theme', 8 * MIN, { t: 'a', scope: 'view', to: 'dark', frames: 3, applied: 3, maxMs: 180, outcome: 'done' }),
      env('theme', 7 * MIN, { t: 'b', scope: 'view', to: 'light', frames: 3, applied: 3, maxMs: 420, outcome: 'done' }),
      env('mode', 6 * MIN, { mode: 'comments', phase: 'enter', t: 'c', shownMs: 300, outcome: 'done' }),
      env('mode', 5 * MIN, { mode: 'comments', phase: 'exit', t: 'c', heldMs: 900, errors: 0 }),
      env('mode', 4 * MIN, { mode: 'laser', phase: 'enter', t: 'd', shownMs: 9000, outcome: 'done' }),
      env('error', 3 * MIN, { source: 'console', message: 'x' }),
      env('error', 3 * MIN, { source: 'frame', message: 'y' }),
      env('error', 3 * MIN, { source: 'console', message: 'z' }),
      env('cmd', 3 * MIN, { phase: 'once', id: 'aaaaaaaaaaa1', cmd: 'copy-image', via: 'key', in: 'shell', outcome: 'failed', why: 'clipboard-blocked', ms: 3 }),
      env('cmd', 3 * MIN, { phase: 'end', id: 'aaaaaaaaaaa2', cmd: 'board-open', outcome: 'unobserved', why: 'hidden', ms: 3 }),
      env('cmd', 3 * MIN, { phase: 'end', id: 'aaaaaaaaaaa2', cmd: 'board-open', outcome: 'done', ms: 30, late: true }),
      // a start with no end and nothing to say its page ended: unmatched once its longest deadline has passed, not before
      env('cmd', 10 * MIN, { phase: 'start', id: 'aaaaaaaaaaa3', cmd: 'reload', via: 'key', in: 'shell' }),
      env('cmd', 60_000, { phase: 'start', id: 'aaaaaaaaaaa4', cmd: 'reload', via: 'key', in: 'shell' }),
      { v: 1, ts: NOW - 1000, kind: 'dropped', n: 12, reason: 'retention-cap' },
    ]))
    writeFileSync(join(perf(one), 'reloads.jsonl'), ln([
      { ts: NOW - 20 * MIN, kind: 'change', change: 'deadbeef:1', file: 'a.tsx', event: 'update', hmrTs: NOW - 20 * MIN - 5, flightMs: 40 },
      { ts: NOW - 20 * MIN, kind: 'invalidate', revision: 'r1', frames: 2, changes: ['deadbeef:1'] },
      { ts: NOW - 20 * MIN + 1, kind: 'invalidate-ids', revision: 'r2', part: 1, parts: 1, changes: ['deadbeef:1', 'deadbeef:2'] },
      { ts: NOW - 20 * MIN + 500, kind: 'ready', tab: 's', page: PG, seq: 10, node: 'n1', frame: 'x/1', revisions: ['r1'], cause: 'job', ms: 100 },
      { ts: NOW - 20 * MIN + 900, kind: 'ready', tab: 's', page: PG, seq: 11, node: 'n2', frame: 'x/2', revisions: ['r2'], cause: 'job', ms: 100 },
      // the same line again, past the server's window: read once, and it changes nothing
      { ts: NOW - 20 * MIN + 900, kind: 'ready', tab: 's', page: PG, seq: 11, node: 'n2', frame: 'x/2', revisions: ['r2'], cause: 'job', ms: 100 },
      // a change whose frame never redrew: not in the figure
      { ts: NOW - 19 * MIN, kind: 'change', change: 'deadbeef:3', file: 'b.tsx', event: 'update', flightMs: 40 },
      { ts: NOW - 18 * MIN, kind: 'full-reload', passed: true, triggeredBy: null, path: null, by: 'ambiguous', candidates: { ids: ['x', 'y'], n: 2 } },
      { ts: NOW - 17 * MIN, kind: 'full-reload', passed: true, triggeredBy: null, path: null, by: 'unknown', candidates: { ids: [], n: 0 } },
      { ts: NOW - 16 * MIN, kind: 'full-reload', passed: true, triggeredBy: null, path: null, by: 'hook', change: 'deadbeef:1', file: 'a.tsx' },
    ]))
    const c = allSummary({ now: NOW, home }).canvases.find((x) => x.name === 'One Canvas')!
    expect(c.editToRedrawMs.n).toBe(1)
    expect(c.editToRedrawMs.p50).toBe(940)                   // from the watcher's event (the line's time less its flight) to the later ready
    expect(c.fullReloads).toEqual({ ambiguous: 1, unknown: 1 })
    expect(c.renders).toEqual({ commits: 12, ms: 32, inGesture: 1 })
    expect(c.themeMaxMs).toBe(420)
    expect(c.commentsShownP50Ms).toBe(300)
    expect(c.errors).toEqual({ console: 2, frame: 1 })
    expect(c.commands).toEqual({ failed: { 'clipboard-blocked': 1 }, unobserved: { hidden: 1 }, interrupted: 0, unmatched: 1 })
    expect(c.retentionCap).toBe(12)
  })

  it('a root with no records says so, and one gone; the days given are the days read', () => {
    writeFileSync(join(perf(two), 'page.jsonl'), ln(load('a00000000005', 20 * DAY)))
    const days = allSummary({ now: NOW, home, days: 14 })
    expect(days.days).toBe(14)
    expect(days.canvases.map((c) => [c.name, c.records])).toEqual([['One Canvas', false], ['Two Canvas', false], ['Gone Canvas', false]])
    expect(allSummary({ now: NOW, home, days: 30 }).canvases[1]!.loads).toBe(1)
    const out: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')) })
    try { allPerf({}) } finally { log.mockRestore() }
    const text = out.join('\n')
    expect(text).toContain('every canvas, last 14 days - 3 known, 0 with records')
    expect(text).toContain('no records in the window')
    expect(text).toContain('no records: its folder is gone')
    expect(existsSync(gone)).toBe(false)                     // read-only: nothing made
  })

  it('reads segments and old files alike', () => {
    writeFileSync(join(perf(one), `page.${NOW - 3 * DAY}-${NOW - 2 * DAY}.jsonl`), ln(load('a00000000006', 3 * DAY)))
    writeFileSync(join(perf(one), 'page.jsonl'), ln(load('a00000000007', 2 * DAY)))
    expect(allSummary({ now: NOW, home }).canvases[0]!.loads).toBe(2)
  })
})

describe('a start with no end (#48): interrupted takes evidence, elapsed time alone says unmatched', () => {
  const PAGE = 'p00000000001', OTHER = 'p00000000002', ID1 = 'c00000000001'
  const pageStart = (ago: number) => ({ v: 1, ws: WS, page: PAGE, load: '-', seq: 1, ts: NOW - ago, kind: 'cmd', phase: 'start', id: ID1, cmd: 'copy-image', via: 'key', in: 'shell' })
  const appLine = (kind: string, ago: number, o: Record<string, unknown> = {}) => ({ v: 1, ts: NOW - ago, kind, app: 'a00000000001', seq: 0, flavour: 'release', machine: null, ...o })
  const LATE = 10 * MIN
  const read = (records: Record<string, any>[], lifecycle?: Record<string, any>[]) => { const { interrupted, unmatched } = commandsSummary(records, NOW, lifecycle); return { interrupted, unmatched } }

  it('a hung or suspended renderer, or a lost end: past its deadline, unmatched, never interrupted', () => {
    expect(read([pageStart(LATE)], [])).toEqual({ interrupted: 0, unmatched: 1 })
    expect(read([pageStart(LATE - 1), { ...pageStart(LATE), phase: 'end', outcome: 'done', ms: 1 }], [])).toEqual({ interrupted: 0, unmatched: 0 })
  })
  it('under its deadline, with nothing else: still going, neither', () => {
    expect(read([pageStart(60_000)], [])).toEqual({ interrupted: 0, unmatched: 0 })
  })
  it('its tab booted another page: interrupted, at once', () => {
    const boot = { ts: NOW - 1000, kind: 'shell-boot', tab: 's', page: OTHER, seq: 1, prev: PAGE }
    expect(read([pageStart(2000)], [boot])).toEqual({ interrupted: 1, unmatched: 0 })
  })
  it('another tab\'s boot says nothing of this page', () => {
    const boots = [{ ts: NOW - 1000, kind: 'shell-boot', tab: 't', page: OTHER, seq: 1 }, { ts: NOW - 900, kind: 'shell-boot', tab: 'u', page: 'p00000000003', seq: 1, prev: OTHER }]
    expect(read([pageStart(LATE)], boots)).toEqual({ interrupted: 0, unmatched: 1 })
  })
  it('the app says its renderer is gone: interrupted', () => {
    expect(read([pageStart(LATE)], [appLine('gone', 1000, { tab: 't1', page: PAGE, role: 'canvas', reason: 'killed', ours: false })])).toEqual({ interrupted: 1, unmatched: 0 })
    expect(read([pageStart(LATE)], [appLine('gone', 1000, { tab: 't2', page: OTHER, role: 'canvas', reason: 'killed', ours: false })])).toEqual({ interrupted: 0, unmatched: 1 })
  })
  it('the app that held its page launched again after it: interrupted; a launch before it, or the other flavour\'s, says nothing', () => {
    const held = appLine('shown', LATE + 1000, { tab: 't1', page: PAGE, ms: 3 })
    const next = appLine('start', 1000, { app: 'a00000000002', seq: 0 })
    expect(read([pageStart(LATE)], [held, next])).toEqual({ interrupted: 1, unmatched: 0 })
    expect(read([pageStart(LATE)], [held, { ...next, ts: NOW - LATE - 500 }])).toEqual({ interrupted: 0, unmatched: 1 })
    expect(read([pageStart(LATE)], [held, { ...next, flavour: 'dev' }])).toEqual({ interrupted: 0, unmatched: 1 })
    expect(read([pageStart(LATE)], [next]), 'nothing ties this page to an app').toEqual({ interrupted: 0, unmatched: 1 })
    const first = appLine('launch', LATE + 1000, { firstCanvas: { tab: 't1', page: PAGE, uncoveredMs: 900, cause: 'doc' } })
    expect(read([pageStart(LATE)], [first, next]), 'the launch line names its first page').toEqual({ interrupted: 1, unmatched: 0 })
  })
  it('an app command: a later launch of its flavour is the evidence; its own start, or the other flavour\'s, is not', () => {
    const start = appLine('cmd', LATE, { phase: 'start', id: ID1, cmd: 'reload', via: 'key', in: 'main' })
    const own = appLine('start', LATE + 2000)
    const next = appLine('start', 1000, { app: 'a00000000002' })
    expect(read([own, start])).toEqual({ interrupted: 0, unmatched: 1 })
    expect(read([own, start, { ...next, flavour: 'dev' }])).toEqual({ interrupted: 0, unmatched: 1 })
    expect(read([own, start, next])).toEqual({ interrupted: 1, unmatched: 0 })
  })
  it('--all reads them together: a canvas\'s starts against its reload lines and the app\'s; the words tell them apart', () => {
    const start = (id: string, page: string, seq: number) => ({ ...pageStart(LATE), id, page, seq })
    writeFileSync(join(perf(one), 'page.jsonl'), ln([start('c00000000001', 'p00000000011', 1), start('c00000000002', 'p00000000012', 2), start('c00000000003', 'p00000000013', 3)]))
    writeFileSync(join(perf(one), 'reloads.jsonl'), ln([{ ts: NOW - 1000, kind: 'shell-boot', tab: 's', page: 'p00000000099', seq: 1, prev: 'p00000000011' }]))
    writeFileSync(join(home, 'perf', 'app.jsonl'), ln([appLine('gone', 1000, { tab: 't1', page: 'p00000000012', role: 'canvas', reason: 'killed', ours: false })]))
    const c = allSummary({ now: NOW, home }).canvases.find((x) => x.name === 'One Canvas')!
    expect(c.commands).toMatchObject({ interrupted: 2, unmatched: 1 })
    const out: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')) })
    try { allPerf({}) } finally { log.mockRestore() }
    expect(out.join('\n')).toContain('interrupted: 2 · no end, nothing says why: 1')
  })
})

describe('the app\'s section (#46)', () => {
  const env = (kind: string, ago: number, body: Record<string, unknown>, seqN = 0) => ({ v: 1, ts: NOW - ago, kind, app: 'a1b2c3d4e5f6', seq: seqN, flavour: 'release', machine: null, ...body })
  it('launches, crashes, hangs, flashes, candidates by why, uncovered window time, over app.jsonl and samples.jsonl', () => {
    let n = 0
    writeFileSync(join(home, 'perf', 'app.jsonl'), ln([
      env('launch', 90 * MIN, { readyMs: 200, firstCanvas: { tab: 't1', page: PG, uncoveredMs: 900, cause: 'doc' }, tabs: { restored: 1, local: 1, remote: 0, active: 'local' } }, n++),
      env('launch', 80 * MIN, { readyMs: 200, firstCanvas: { tab: 't1', page: PG, uncoveredMs: 1500, cause: 'doc' }, tabs: { restored: 1, local: 1, remote: 0, active: 'local' } }, n++),
      env('launch', 70 * MIN, { readyMs: 200, why: 'home', tabs: { restored: 0, local: 0, remote: 0, active: 'home' } }, n++),
      env('gone', 60 * MIN, { role: 'canvas', reason: 'crashed', ours: false, pid: 1, born: 1, exitCode: 1 }, n++),
      env('gone', 59 * MIN, { role: 'canvas', reason: 'unload', ours: true, pid: 1, born: 1, exitCode: 0 }, n++),
      env('unresponsive', 58 * MIN, { role: 'canvas', pid: 1, born: 1 }, n++),
      env('flash', 57 * MIN, { id: 'x', via: 'key', recorder: true }, n++),
      env('whiteout-candidate', 56 * MIN, { gesture: 1, why: ['load', 'theme'], observedAt: [1, 2], gpuEvents: [] }, n++),
      env('whiteout-candidate', 55 * MIN, { gesture: 2, observedAt: [1, 2], gpuEvents: [] }, n++),   // 1.0.0's: a gesture's
    ]))
    writeFileSync(join(home, 'perf', 'samples.jsonl'), ln([
      env('sample', 50 * MIN, { span: 60_000, whiteout: { windows: 1, captures: 3, captureMs: 300, overrunMs: 0, skipped: 1, uncoveredMs: { stage: 500, budget: 250, hidden: 0 }, byWhy: { load: 1 } } }, n++),
      env('sample', 49 * MIN, { span: 60_000, whiteout: { windows: 1, captures: 1, captureMs: 4000, overrunMs: 3500, skipped: 2, uncoveredMs: { stage: 0, budget: 750, hidden: 1000 }, byWhy: { shown: 1 } } }, n++),
      env('sample', 48 * MIN, { span: 60_000 }, n++),
    ]))
    const a = allSummary({ now: NOW, home }).app
    expect(a).toMatchObject({ records: true, launches: 3, crashes: 1, hangs: 1, flashes: 1 })
    expect(a.toFirstCanvasMs).toEqual({ p50: 1500, max: 1500 })
    expect(a.noCanvas).toEqual({ home: 1 })
    expect(a.candidates).toEqual({ load: 1, theme: 1, gesture: 1 })
    expect(a.uncoveredMs).toEqual({ stage: 500, budget: 1000, hidden: 1000 })
    expect(a.capture).toEqual({ captures: 4, captureMs: 4300, overrunMs: 3500, skipped: 3 })
  })
  it('none: says so; a record of no kind it knows costs nothing', () => {
    expect(appSummary([]).records).toBe(false)
    const out: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')) })
    try { allPerf({}) } finally { log.mockRestore() }
    expect(out.join('\n')).toContain('the Mac app\n  no records in the window')
  })
})

describe('the command (#46)', () => {
  it('--all needs no repo, --json emits the same, and --flashes --all keeps its meaning', async () => {
    writeFileSync(join(perf(one), 'page.jsonl'), ln(load('a00000000008', MIN)))
    const out: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')) })
    try {
      await perfCommand(join(base, 'not-a-repo'), { all: true, json: true })
      const j = JSON.parse(out.join('\n'))
      expect(j).toEqual(JSON.parse(JSON.stringify(allSummary({ now: NOW, home }))))
      expect(j.canvases[0].loads).toBe(1)
      out.length = 0
      await perfCommand(one, { flashes: true, all: true })
      expect(out[0]).toContain('flashes marked')
      out.length = 0
      await perfCommand(one, { flashes: true, all: true, json: true })
      expect(JSON.parse(out.join('\n'))).toHaveProperty('marks')
    } finally { log.mockRestore() }
  })

  it('editToRedraw on 0.29 lines finds nothing rather than guessing', () => {
    expect(editToRedraw([{ ts: 1, kind: 'update', file: 'a', reload: [], inPlace: [] }, { ts: 2, kind: 'ready', cause: 'job' }])).toEqual([])
  })
})
