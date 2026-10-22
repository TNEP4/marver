import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { droppedOf, loadsSummary, perfCommand, unownedOf } from '../src/cli/perf.ts'
import { pageLog, perfDir } from '../src/server/perf.ts'

/** `marver perf --loads` (spec 28 A1.8) over a fixture page.jsonl: board loads grouped by ws/page/load, retried
 *  duplicates dropped, and the one line per load plain `marver perf` adds. */

const WS = '0123456789abcdef', P1 = 'aaaaaaaaaaa1', P2 = 'aaaaaaaaaaa2'
const A = 'a00000000001', B = 'b00000000001', C = 'c00000000001', D = 'd00000000001'

function fixture(now = Date.now()) {
  const seqs = new Map<string, number>()
  const rec = (page: string, load: string, kind: string, at: number, body: Record<string, unknown> = {}) => {
    const seq = seqs.get(page) ?? 0
    seqs.set(page, seq + 1)
    return { v: 1, ws: WS, page, load, seq, ts: now - at, kind, ...body }
  }
  const min = 60_000
  const records = [
    rec(P1, '-', 'gesture', 31 * min, { type: 'pan', ms: 300, frames: 18, p50: 16.7, p95: 18, max: 20, over17ms: 3, over33ms: 0, longFrames: 0 }),
    // load A: the page's first board, settled, with moves before and after and two errors (one twice)
    rec(P1, A, 'load', 30 * min, { board: 'start-here', cause: 'boot', request: A, sinceNav: 400 }),
    rec(P1, A, 'commit', 30 * min - 400, { request: A, ms: 400, frames: 7, byKind: { hifi: 3, content: 3, html: 1 }, measuring: 3, savedHeights: 2 }),
    rec(P1, A, 'visible', 30 * min - 500, { nodes: 4, ms: 500 }),
    rec(P1, A, 'move', 30 * min - 900, { node: 'k-1', dx: 0, dy: 0, dw: 0, dh: 300, cause: 'measure-height' }),
    rec(P1, A, 'move', 30 * min - 1300, { node: 'k-2', dx: 0, dy: 300, dw: 0, dh: 0, cause: 'reflow:measured' }),
    rec(P1, A, 'move', 30 * min - 1300, { node: 'k-3', dx: 0, dy: 400, dw: 0, dh: 0, cause: 'reflow:measured' }),
    rec(P1, A, 'frame', 30 * min - 1000, { node: 'k-1', frame: 'docs/a', ready: 700, firstMeasure: 800, settled: 1600, outcome: 'settled' }),
    rec(P1, A, 'frame', 30 * min - 1000, { node: 'k-2', frame: 'docs/b', ready: 600, settled: 1200, outcome: 'settled' }),
    rec(P1, A, 'frame', 30 * min - 1000, { node: 'k-3', frame: 'docs/c', ready: 650, settled: 1100, outcome: 'settled' }),
    rec(P1, A, 'frame', 30 * min - 1000, { node: 'k-4', frame: 'kit/f1', ready: 500, outcome: 'ready' }),
    rec(P1, A, 'frame', 30 * min - 1000, { node: 'k-5', frame: 'kit/f2', ready: 900, outcome: 'ready' }),
    // k-5 again: its document was replaced and reported later - the last record wins
    rec(P1, A, 'frame', 30 * min - 1000, { node: 'k-5', frame: 'kit/f2', ready: 1900, outcome: 'ready' }),
    rec(P1, A, 'frame', 30 * min - 1000, { node: 'k-6', frame: 'kit/f3', outcome: 'never-ready' }),
    rec(P1, A, 'frame', 30 * min - 1000, { node: 'k-7', frame: 'kit/old', outcome: 'missing' }),
    rec(P1, A, 'error', 30 * min - 1100, { source: 'frame', frame: 'kit/f4', message: 'Cannot read properties of undefined' }),
    rec(P1, A, 'error', 30 * min - 1200, { source: 'frame', frame: 'kit/f4', message: 'Cannot read properties of undefined' }),
    rec(P1, A, 'quiet', 30 * min - 2300, { ms: 1300 }),
    rec(P1, A, 'settled', 30 * min - 3200, { ms: 3200, moves: 3, distance: 1000, causes: { 'measure-height': 1, 'reflow:measured': 2 }, lastMove: 1300, visibleReadyMs: 900, allReadyMs: 1900, missing: 1, neverReady: 1, errors: 0, weight: { domNodes: 3000, iframes: 6, awake: 2, asleep: 4 } }),
    rec(P1, A, 'move', 29 * min, { node: 'k-2', dx: 40, dy: 0, dw: 0, dh: 0, cause: 'drag', late: true }),
    rec(P1, A, 'move', 29 * min, { node: 'k-3', dx: 0, dy: 0, dw: 0, dh: 20, cause: 'measure-height', late: true }),
    // load B: a switch requested, committed, then cut by another switch (its request C never commits)
    // a load record carries its request's id as its load
    rec(P1, B, 'load', 20 * min, { board: 'docs', cause: 'switch', request: B }),
  ]
  records.push(
    rec(P1, B, 'commit', 20 * min - 300, { request: B, ms: 300, frames: 2, byKind: { hifi: 0, content: 2, html: 0 }, measuring: 2, savedHeights: 0 }),
    rec(P1, B, 'move', 20 * min - 700, { node: 'k-b1', dx: 0, dy: 0, dw: 0, dh: 120, cause: 'measure-height' }),
    rec(P1, C, 'load', 20 * min - 1000, { board: 'notes', cause: 'switch', request: C }),
    rec(P1, C, 'cut', 20 * min - 1100, { reason: 'superseded', request: C, ms: 100 }),
    // a frame ready but not yet settled when the cut came - unfinished, never among the slowest - and one that settled
    rec(P1, B, 'frame', 20 * min - 900, { node: 'k-b2', frame: 'docs/y', ready: 500, settled: 900, outcome: 'settled' }),
    rec(P1, B, 'frame', 20 * min - 1400, { node: 'k-b1', frame: 'docs/x', ready: 1350, outcome: 'cut' }),
    rec(P1, B, 'cut', 20 * min - 1400, { reason: 'switch', ms: 1400, lastMove: 700, frames: 2, ready: 1 }),
    // the Not on a board view on another page of the same canvas: both are `boot`, and never mix
    rec(P2, D, 'load', 10 * min, { board: '~unplaced', cause: 'boot', request: D }),
    rec(P2, D, 'commit', 10 * min - 200, { request: D, ms: 200, frames: 1, byKind: { hifi: 1, content: 0, html: 0 }, measuring: 0, savedHeights: 0 }),
    rec(P2, D, 'settled', 10 * min - 1500, { ms: 1500, moves: 0, distance: 0, causes: {}, allReadyMs: 600, visibleReadyMs: 600, missing: 0, neverReady: 0, errors: 0 }),
    // load A's board, still open long after it settled: an error then is late; errors past its 50 were counted, not
    // recorded; and records the page lost (its queue full, or a send that failed three times)
    rec(P1, A, 'error', 5 * min, { source: 'shell', message: 'ResizeObserver loop completed with undelivered notifications', late: true }),
    rec(P1, A, 'dropped', 5 * min, { n: 12, reason: 'errors' }),
    rec(P1, A, 'dropped', 5 * min, { n: 5 }),
  )
  // a retried send whose first attempt landed: its records again - moves (two of them late), a frame, errors, the
  // gesture before any board, what was dropped, a load's end
  const again = (r: Record<string, any>) => (r.load === A && ['move', 'error', 'dropped'].includes(r.kind)) || (r.load === B && r.kind === 'frame') || r.kind === 'gesture' || (r.load === D && r.kind === 'settled')
  records.push(...records.filter(again).map((r) => ({ ...r })))
  // another page's record with the same seq is its own: it counts
  const twin = records.find((r) => r.load === A && r.kind === 'move' && !('late' in r))!
  records.push({ ...twin, page: P2, load: D })
  // two hours old: outside the default window
  const old = { v: 1, ws: WS, page: 'eeeeeeeeeee1', load: 'e00000000001', seq: 0, ts: now - 120 * min, kind: 'load', board: 'old', cause: 'boot', request: 'e00000000001' }
  return [old, ...records]
}

describe('board loads (marver perf --loads)', () => {
  it('groups by workspace, page and load, in time order', () => {
    const loads = loadsSummary(fixture())
    expect(loads.map((l) => [l.board, l.cause, l.state])).toEqual([
      ['old', 'boot', 'open'], ['start-here', 'boot', 'settled'], ['docs', 'switch', 'cut'], ['notes', 'switch', 'cut'], ['~unplaced', 'boot', 'settled'],
    ])
    const d = loads.find((l) => l.load === D)!
    expect(d.page).toBe(P2)
    expect(d.settledMs).toBe(1500)
  })

  it('a settled load: its times, moves (late ones apart), the slowest frames, errors once, what never came', () => {
    const a = loadsSummary(fixture()).find((l) => l.load === A)!
    expect(a).toMatchObject({ committed: true, commitMs: 400, frames: 7, measuring: 3, savedHeights: 2, visible: 4, visibleReadyMs: 900, allReadyMs: 1900, quietMs: 1300, lastMoveMs: 1300, settledMs: 3200 })
    expect(a.moves).toEqual({ count: 3, distance: 1000, causes: [['reflow:measured', 2], ['measure-height', 1]], late: { count: 2, causes: [['drag', 1], ['measure-height', 1]] } })
    expect(a.slowest.map((f) => [f.frame, f.ms])).toEqual([['kit/f2', 1900], ['docs/a', 1600], ['docs/b', 1200], ['docs/c', 1100], ['kit/f1', 500]])
    expect(a.errors).toEqual([
      { source: 'frame', frame: 'kit/f4', message: 'Cannot read properties of undefined' },
      { source: 'shell', message: 'ResizeObserver loop completed with undelivered notifications', late: true },
    ])
    expect(a.errorsNotRecorded).toBe(12)
    expect(a.neverReady).toEqual(['kit/f3'])
    expect(a.missing).toEqual(['kit/old'])
  })

  it('a load cut by a switch, and a request that never committed', () => {
    const loads = loadsSummary(fixture())
    const b = loads.find((l) => l.load === B)!, c = loads.find((l) => l.load === C)!
    expect(b).toMatchObject({ state: 'cut', cut: { reason: 'switch', ms: 1400 }, committed: true, unfinished: 1, lastMoveMs: 700 })
    expect(b.moves.count).toBe(1)
    // a cut load: how many frames were ready by the cut, of the frames it had then; the slowest only of those that finished
    expect(b.readyByCut).toBe(1)
    expect(b.framesAtCut).toBe(2)
    expect(b.slowest).toEqual([{ node: 'k-b2', frame: 'docs/y', ms: 900, outcome: 'settled' }])
    expect(loads.find((l) => l.load === A)!.readyByCut).toBeUndefined()
    expect(c.readyByCut).toBeUndefined()
    expect(c).toMatchObject({ state: 'cut', cut: { reason: 'superseded', request: true }, committed: false })
    expect(c.lastMoveMs).toBeUndefined()
  })

  it('what came before any board committed is apart', () => {
    expect(unownedOf(fixture())).toEqual({ errors: [], errorsNotRecorded: 0, gestures: 1 })
  })

  it('a retried send counts once (same ws, page and seq); the same seq on another page is that page\'s own', () => {
    const records = fixture()
    expect(records.filter((r) => r.kind === 'move' && r.page === P1 && r.load === A)).toHaveLength(10)   // five, each twice
    const loads = loadsSummary(records)
    const a = loads.find((l) => l.load === A)!, b = loads.find((l) => l.load === B)!, d = loads.find((l) => l.load === D)!
    expect(a.moves).toMatchObject({ count: 3, distance: 1000, late: { count: 2 } })
    expect(a.errorsNotRecorded).toBe(12)
    expect(b.unfinished).toBe(1)
    expect(unownedOf(records).gestures).toBe(1)
    expect(droppedOf(records)).toBe(5)
    expect(d.moves).toMatchObject({ count: 1, distance: 300 })
    expect(d.settledMs).toBe(1500)
  })
})

describe('marver perf, printed', () => {
  let root = ''
  let out: string[] = []
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mv-perf-cli-'))
    mkdirSync(perfDir(root), { recursive: true })
    writeFileSync(pageLog(root), fixture().map((r) => JSON.stringify(r)).join('\n') + '\n')
    out = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
  })
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

  it('--loads --json: the last hour by default; --minutes reaches further', () => {
    perfCommand(root, { loads: true, json: true })
    const j = JSON.parse(out.join('\n'))
    expect(j.minutes).toBe(60)
    expect(j.loads.map((l: any) => l.board)).toEqual(['start-here', 'docs', 'notes', '~unplaced'])
    expect(j.loads.map((l: any) => l.lastMoveMs)).toEqual([1300, 700, undefined, undefined])
    expect(j.loads.map((l: any) => [l.readyByCut, l.unfinished])).toEqual([[undefined, 0], [1, 1], [undefined, 0], [undefined, 0]])
    expect(j.unowned.gestures).toBe(1)
    expect(j.dropped).toBe(5)
    out = []
    perfCommand(root, { loads: true, json: true, minutes: 180 })
    expect(JSON.parse(out.join('\n')).loads[0].board).toBe('old')
  })

  it('--loads: one block per load, in words', () => {
    perfCommand(root, { loads: true })
    const text = out.join('\n')
    expect(text).toMatch(/Start Here \(boot\)\s+settled 3\.2 s/)
    expect(text).toContain('committed 0.4 s · 7 frames (3 hi-fi, 3 content, 1 html) · 3 measure, 2 opened at a known height')
    expect(text).toContain('visible ready 0.9 s (4 frames) · all ready 1.9 s · quiet 1.3 s · last move 1.3 s · settled 3.2 s')
    expect(text).toMatch(/Docs \(switch\)\s+cut \(switch\) at 1\.4 s\n.*\n {4}1 of 2 ready · last move 0\.7 s\n.*\n {4}slowest: docs\/y 0\.9 s · 1 never finished\n/)
    expect(text).not.toContain('docs/x')
    expect(text).toContain('3 moves, 1000 px: reflow:measured 2, measure-height 1 · late, after it settled: 2 (drag 1, measure-height 1)')
    expect(text).toContain('slowest: kit/f2 1.9 s, docs/a 1.6 s, docs/b 1.2 s, docs/c 1.1 s, kit/f1 0.5 s')
    expect(text).toContain('never ready: kit/f3 · missing: kit/old')
    expect(text).toContain('error (frame kit/f4): Cannot read properties of undefined')
    expect(text).toContain('late error (shell): ResizeObserver loop completed with undelivered notifications')
    expect(text).toContain('12 more errors past the first 50, not recorded')
    expect(text).toContain('5 records never reached this log')
    expect(text).toMatch(/Docs \(switch\)\s+cut \(switch\) at 1\.4 s/)
    expect(text).toMatch(/Notes \(switch\)\s+not committed \(superseded\)/)
    expect(text).toContain('Not on a board (boot)')
  })

  it('plain marver perf adds one line per load; its JSON a brief of each', () => {
    perfCommand(root, {})
    const text = out.join('\n')
    expect(text).toContain('board loads: 4')
    expect(text).toMatch(/start-here\s+boot\s+settled 3\.2 s · 3 moves \(2 late\) · 2 errors \(1 late\)/)
    expect(text).toMatch(/docs\s+switch\s+cut \(switch\) at 1\.4 s · 1 move/)
    out = []
    perfCommand(root, { json: true })
    const j = JSON.parse(out.join('\n'))
    expect(j.loads).toHaveLength(4)
    expect(j.loads[0]).toMatchObject({ board: 'start-here', cause: 'boot', state: 'settled', settledMs: 3200, moves: 3, late: 2, errors: 2, lateErrors: 1 })
  })

  it('a load with twenty errors: every one counted and in the JSON; --loads prints ten and says how many more', () => {
    const now = Date.now()
    const E = 'e00000000001', P3 = 'aaaaaaaaaaa3'
    let seq = 0
    const rec = (kind: string, body: Record<string, unknown> = {}) => ({ v: 1, ws: WS, page: P3, load: E, seq: seq++, ts: now - 60_000 + seq, kind, ...body })
    const records = [
      rec('load', { board: 'errors', cause: 'boot', request: E }),
      rec('commit', { request: E, ms: 100, frames: 1, byKind: { hifi: 1, content: 0, html: 0 }, measuring: 0, savedHeights: 0 }),
      ...Array.from({ length: 20 }, (_, i) => rec('error', { source: 'frame', frame: 'kit/boom', message: `error number ${i + 1}` })),
      rec('settled', { ms: 900, moves: 0, distance: 0, causes: {}, missing: 0, neverReady: 0, errors: 1 }),
    ]
    writeFileSync(pageLog(root), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    expect(loadsSummary(records)[0].errors).toHaveLength(20)
    perfCommand(root, { loads: true, json: true })
    expect(JSON.parse(out.join('\n')).loads[0].errors.map((e: any) => e.message)).toEqual(Array.from({ length: 20 }, (_, i) => `error number ${i + 1}`))
    out = []
    perfCommand(root, { loads: true })
    const text = out.join('\n')
    expect(text).toContain('error (frame kit/boom): error number 10')
    expect(text).not.toContain('error number 11')
    expect(text).toContain('10 more errors not shown (--json lists every one)')
    out = []
    perfCommand(root, {})
    expect(out.join('\n')).toMatch(/errors\s+boot\s+settled 0\.9 s · 20 errors/)
    out = []
    perfCommand(root, { json: true })
    expect(JSON.parse(out.join('\n')).loads[0]).toMatchObject({ errors: 20 })
  })

  it('a load cut at 120 s goes on loading: its moves after the cut are late, and --loads says after it was cut', () => {
    const now = Date.now()
    const T = 'f00000000001', P4 = 'aaaaaaaaaaa4'
    let seq = 0
    const rec = (kind: string, body: Record<string, unknown> = {}) => ({ v: 1, ws: WS, page: P4, load: T, seq: seq++, ts: now - 300_000 + seq * 1000, kind, ...body })
    const records = [
      rec('load', { board: 'archive', cause: 'boot', request: T }),
      rec('commit', { request: T, ms: 100, frames: 2, byKind: { hifi: 0, content: 2, html: 0 }, measuring: 2, savedHeights: 0 }),
      rec('move', { node: 'k-1', dx: 0, dy: 0, dw: 0, dh: 300, cause: 'measure-height' }),
      rec('frame', { node: 'k-1', frame: 'docs/a', ready: 900, settled: 1500, outcome: 'settled' }),
      rec('frame', { node: 'k-2', frame: 'docs/b', outcome: 'cut' }),
      rec('cut', { reason: 'timeout', ms: 120_000, lastMove: 1400 }),
      rec('move', { node: 'k-2', dx: 0, dy: 0, dw: 0, dh: 200, cause: 'measure-height', late: true }),
      rec('move', { node: 'k-3', dx: 0, dy: 200, dw: 0, dh: 0, cause: 'reflow:measured', late: true }),
    ]
    writeFileSync(pageLog(root), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    perfCommand(root, { loads: true, json: true })
    expect(JSON.parse(out.join('\n')).loads[0]).toMatchObject({ state: 'cut', cut: { reason: 'timeout' }, moves: { count: 1, late: { count: 2 } } })
    out = []
    perfCommand(root, { loads: true })
    expect(out.join('\n')).toContain('1 move, 300 px: measure-height 1 · late, after it was cut: 2 (measure-height 1, reflow:measured 1)')
  })

  it('a load cut while it loads: ready by the cut, of the frames on its board then - two added and ready, one removed', () => {
    const now = Date.now()
    const K = 'f00000000003', P6 = 'aaaaaaaaaaa6'
    let seq = 0
    const rec = (kind: string, body: Record<string, unknown> = {}) => ({ v: 1, ws: WS, page: P6, load: K, seq: seq++, ts: now - 300_000 + seq * 1000, kind, ...body })
    const records = [
      rec('load', { board: 'slow', cause: 'boot', request: K }),
      rec('commit', { request: K, ms: 100, frames: 2, byKind: { hifi: 1, content: 1, html: 0 }, measuring: 1, savedHeights: 0 }),
      // the hi-fi frame it opened with: ready, then removed
      rec('frame', { node: 'k-gone', frame: 'kit/hifi', ready: 400, outcome: 'ready' }),
      // two frames placed while it loads, both ready
      rec('frame', { node: 'k-n1', frame: 'kit/hifi', ready: 900, outcome: 'ready' }),
      rec('frame', { node: 'k-n2', frame: 'kit/hifi', ready: 950, outcome: 'ready' }),
      rec('frame', { node: 'k-doc', frame: 'docs/slow', ready: 300, outcome: 'cut' }),
      rec('cut', { reason: 'hidden', ms: 4000, frames: 3, ready: 2 }),
    ]
    expect(loadsSummary(records)[0]).toMatchObject({ frames: 2, framesAtCut: 3, readyByCut: 2 })
    writeFileSync(pageLog(root), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    perfCommand(root, { loads: true })
    expect(out.join('\n')).toContain('2 of 3 ready')
  })

  it('a request cut while the page was hidden whose board mounts after all: its cut kept, its mount said, its moves late', () => {
    const now = Date.now()
    const H = 'f00000000002', P5 = 'aaaaaaaaaaa5'
    let seq = 0
    const rec = (kind: string, body: Record<string, unknown> = {}) => ({ v: 1, ws: WS, page: P5, load: H, seq: seq++, ts: now - 300_000 + seq * 1000, kind, ...body })
    const records = [
      rec('load', { board: 'archive', cause: 'switch', request: H }),
      rec('cut', { reason: 'hidden', request: H, ms: 400 }),
      rec('commit', { request: H, ms: 3200, frames: 2, byKind: { hifi: 2, content: 0, html: 0 }, measuring: 0, savedHeights: 0, late: true }),
      rec('move', { node: 'k-1', dx: 120, dy: 80, dw: 0, dh: 0, cause: 'drag', late: true }),
    ]
    const [l] = loadsSummary(records)
    expect(l).toMatchObject({ state: 'cut', cut: { reason: 'hidden', ms: 400, request: true }, committed: true, mountedAfterCut: true, commitMs: 3200, frames: 2, moves: { count: 0, late: { count: 1, causes: [['drag', 1]] } } })
    // nothing was ready by a cut that came before the board mounted
    expect(l.readyByCut).toBeUndefined()
    writeFileSync(pageLog(root), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    perfCommand(root, { loads: true })
    const text = out.join('\n')
    expect(text).toMatch(/Archive \(switch\)\s+cut \(hidden\) at 0\.4 s before it mounted · mounted 3\.2 s\n/)
    expect(text).toContain('mounted after its cut 3.2 s · 2 frames (2 hi-fi)')
    expect(text).toContain('0 moves · late, after it was cut: 1 (drag 1)')
    expect(text).not.toContain('not committed')
    out = []
    perfCommand(root, {})
    expect(out.join('\n')).toMatch(/archive\s+switch\s+cut \(hidden\) at 0\.4 s before it mounted · mounted 3\.2 s · 0 moves \(1 late\)/)
  })

  it('nothing in the window says so', () => {
    writeFileSync(pageLog(root), '')
    perfCommand(root, { loads: true })
    expect(out.join('\n')).toContain('nothing yet')
  })
})

describe('marver perf --help', () => {
  it('--loads says what it counts: how many moves and their causes - it lists no frames that moved', () => {
    const help = execFileSync(process.execPath, [join(import.meta.dirname, '..', 'dist', 'cli.mjs'), 'perf', '--help'], { encoding: 'utf8' })
    const loads = help.split('\n').find((l) => l.includes('--loads'))
    expect(loads).toContain('how many moves and their causes')
    expect(loads).toContain('the last move')
    expect(loads).not.toContain('frames that moved')
  })
})
