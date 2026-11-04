/**
 * A 0.29-era record set, synthetic and shaped like the 4 Nov lines (spec 30 R16, compatibility): no segments, no change
 * ids, reload lists uncapped, shell lines naming no page, samples in app.jsonl. `golden/` holds what `marver perf`'s 0.29
 * code printed over it, in every view; r30-store-readers.test.ts holds 0.30's readers to the same.
 */
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 3 Nov 2026, 12:00 UTC: the fixture's now. */
export const NOW = Date.UTC(2026, 10, 3, 12, 0, 0)
const MIN = 60_000, HOUR = 3_600_000
export const WS1 = '163cf821d349d94a', WS2 = '6db75c4deeea0498'
const H1 = '7b2b481bec96d801', H2 = 'a90e807694120061'
const PAGE1 = '90879e227f04', PAGE2 = '3f6975886743', RUNPAGE = 'ea43633a2bb0'
const A = 'a51d669160cf', B = 'b0aac0bfea3a', C = 'c4ba412bd856', D = 'dccb75adf7fb', R = 'e6db90a040f8'
const ln = (rs: unknown[]) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n'

function reloads(): unknown[] {
  const big = Array.from({ length: 300 }, (_, i) => `onboarding/frame-${i}`)   // uncapped, as 0.29's were
  return [
    { ts: NOW - 50 * MIN, kind: 'shell-boot', tab: 's75aa0' },
    { ts: NOW - 50 * MIN + 1400, kind: 'ready', tab: 's75aa0', node: 'n_a', frame: 'onboarding/join', cause: 'first', shown: '2d04940d3eb3:1001', ms: 626 },
    { ts: NOW - 50 * MIN + 1500, kind: 'settled', tab: 's75aa0', node: 'n_a', frame: 'onboarding/join', ms: 290 },
    { ts: NOW - 40 * MIN, kind: 'update', cause: 'update', file: 'design/screens/onboarding/fixtures.ts', reload: big, inPlace: [] },
    { ts: NOW - 40 * MIN + 900, kind: 'ready', tab: 's75aa0', node: 'n_b', frame: 'onboarding/frame-1', cause: 'job', shown: '2d04940d3eb3:1002', ms: 800 },
    { ts: NOW - 39 * MIN, kind: 'update', cause: 'update', file: 'design/screens/onboarding/fixtures.ts', reload: ['onboarding/frame-301'], inPlace: ['onboarding/frame-2'] },
    { ts: NOW - 38 * MIN, kind: 'update', cause: 'reload', file: null, reload: ['onboarding/join', 'onboarding/papers'], inPlace: [] },
    { ts: NOW - 35 * MIN, kind: 'full-reload', passed: false, triggeredBy: '/Users/someone/repo/design/scenes/onboarding/full.tsx', path: '*' },
    { ts: NOW - 34 * MIN, kind: 'full-reload', passed: true, triggeredBy: null, path: null },
    { ts: NOW - 34 * MIN + 100, kind: 'shell-boot', tab: 's75aa1' },
    { ts: NOW - 33 * MIN, kind: 'ready', tab: 's75aa1', node: 'n_c', frame: 'onboarding/papers', cause: 'manual', shown: '2d04940d3eb4:1', ms: 1300 },
    { ts: NOW - 33 * MIN + 1, kind: 'ready', tab: 's75aa1', node: 'n_d', frame: 'onboarding/retry', cause: 'retry', shown: '2d04940d3eb4:2', ms: 11000 },
    { ts: NOW - 33 * MIN + 2, kind: 'ready', tab: 's75aa1', node: 'n_e', frame: 'onboarding/self', cause: 'self', shown: '2d04940d3eb4:3', ms: 450 },
    { ts: NOW - 32 * MIN, kind: 'settled', tab: 's75aa1', node: 'n_c', frame: 'onboarding/papers', ms: 2200 },
    { ts: NOW - 32 * MIN + 1, kind: 'settled', tab: 's75aa1', node: 'n_e', frame: 'onboarding/self', ms: 90 },
    // older than an hour: outside the default window, inside --minutes
    { ts: NOW - 3 * HOUR, kind: 'update', cause: 'update', file: 'design/scenes/old/a.tsx', reload: ['old/a'], inPlace: [] },
  ]
}

function page(): unknown[] {
  const seqs = new Map<string, number>()
  const rec = (pg: string, load: string, kind: string, ago: number, body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const seq = seqs.get(pg) ?? 0
    seqs.set(pg, seq + 1)
    return { v: 1, ws: WS1, page: pg, load, seq, ts: NOW - ago, kind, ...body, ...extra }
  }
  const P = (load: string, kind: string, ago: number, body: Record<string, unknown> = {}) => rec(PAGE1, load, kind, ago, body)
  const settled = (ago: number, ms: number) => ({ ms, moves: 3, distance: 400, lastMove: ms - 1000, causes: { 'reflow:stale': 3 }, visibleReadyMs: ms - 1500, allReadyMs: ms - 1200, missing: 0, neverReady: 0, errors: 1, weight: { domNodes: 13881, iframes: 75, awake: 12, asleep: 63, heapMB: 2356.3 } })
  const out: unknown[] = [
    P('-', 'gesture', 41 * MIN, { type: 'pan', ms: 300, frames: 18, p50: 16.7, p95: 18, max: 20, over17ms: 3, over33ms: 0, longFrames: 0 }),
    // A: settled
    P(A, 'load', 40 * MIN, { board: 'main', cause: 'boot', request: A, sinceNav: 412 }),
    P(A, 'commit', 40 * MIN - 400, { request: A, ms: 400, frames: 7, byKind: { hifi: 3, content: 3, html: 1 }, measuring: 3, savedHeights: 2 }),
    P(A, 'visible', 40 * MIN - 500, { nodes: 4, ms: 500 }),
    P(A, 'move', 40 * MIN - 900, { node: 'n_1', dx: 0, dy: 0, dw: 0, dh: 300, cause: 'measure-height' }),
    P(A, 'move', 40 * MIN - 1300, { node: 'n_2', dx: 0, dy: 300, dw: 0, dh: 0, cause: 'reflow:measured' }),
    P(A, 'frame', 40 * MIN - 1000, { node: 'n_1', frame: 'docs/a', admitted: 350, ready: 700, firstMeasure: 800, settled: 1600, outcome: 'settled' }),
    P(A, 'frame', 40 * MIN - 1000, { node: 'n_2', frame: 'docs/b', ready: 600, settled: 1200, outcome: 'settled' }),
    P(A, 'frame', 40 * MIN - 1000, { node: 'n_3', frame: 'kit/f', outcome: 'never-ready' }),
    P(A, 'frame', 40 * MIN - 1000, { node: 'n_4', frame: 'kit/g', outcome: 'missing' }),
    P(A, 'error', 40 * MIN - 1100, { source: 'frame', frame: 'docs/a', message: 'Failed to fetch dynamically imported module' }),
    P(A, 'quiet', 40 * MIN - 1500, { ms: 1500 }),
    P(A, 'settled', 40 * MIN - 2600, settled(0, 2600)),
    P(A, 'gesture', 39 * MIN, { type: 'zoom', ms: 500, frames: 30, p50: 16.7, p95: 25.8, max: 40, over17ms: 9, over33ms: 2, longFrames: 1, hz: 120 }),
    P(A, 'move', 39 * MIN + 1, { node: 'n_1', dx: 0, dy: 5, dw: 0, dh: 0, cause: 'reflow:stale', late: true }),
    // B: disk-reload, cut by the next
    P(B, 'load', 30 * MIN, { board: 'main', cause: 'disk-reload', request: B }),
    P(B, 'commit', 30 * MIN - 1000, { request: B, ms: 1000, frames: 75, byKind: { hifi: 68, content: 7, html: 0 }, measuring: 7, savedHeights: 7 }),
    P(B, 'frame', 30 * MIN - 2000, { node: 'n_1', frame: 'docs/a', gen: '3465', boot: 'e2cfc6ed2808', outcome: 'cut', kept: true }),
    P(B, 'cut', 30 * MIN - 8338, { reason: 'reload', ms: 8338, lastMove: 1867, frames: 75, ready: 10 }),
    // C: a request cut before it mounted, then mounted late
    P(C, 'load', 20 * MIN, { board: 'other-board', cause: 'switch', request: C }),
    P(C, 'cut', 20 * MIN - 500, { reason: 'hidden', request: C, ms: 500 }),
    P(C, 'commit', 20 * MIN - 3000, { request: C, ms: 3000, frames: 2, byKind: { hifi: 2 }, late: true }),
    // what was never recorded, said
    P(C, 'dropped', 20 * MIN - 3100, { n: 25, reason: 'errors' }),
    P(C, 'dropped', 20 * MIN - 3200, { n: 4 }),
    rec(PAGE2, D, 'load', 10 * MIN, { board: 'main', cause: 'boot', request: D, sinceNav: 300 }),
    rec(PAGE2, D, 'commit', 10 * MIN - 300, { request: D, ms: 300, frames: 12, byKind: { hifi: 12 } }),
    rec(PAGE2, D, 'settled', 10 * MIN - 1500, { ...settled(0, 1500), allReadyMs: 400, weight: { domNodes: 900, iframes: 12, awake: 12, asleep: 0, heapMB: 47 } }),
    // a headless run's load: --runs's, hidden from the others
    rec(RUNPAGE, R, 'load', 15 * MIN, { board: 'main', cause: 'boot', request: R, sinceNav: 100 }, { run: 'f00dfeedf00dfeed' }),
    rec(RUNPAGE, R, 'settled', 15 * MIN - 900, { ms: 900 }, { run: 'f00dfeedf00dfeed' }),
  ]
  // a send retried after its first attempt landed: the same records again
  return [...out, out[1], out[13]]
}

function jam(): unknown[] {
  const CAP = 'cap-1793361005698-bhfnus', BATCH = 'e751e77e-9727-4d58-835e-90af26e23f86'
  return [
    { v: 1, ts: NOW - 5 * HOUR, kind: 'capture', capture: CAP, sealMs: 812, wordsWaitMs: 300, pictures: { count: 2, ms: [400, 900], late: 1, failed: 1, live: { count: 1, failed: 1, fellBack: 1 } } },
    { v: 1, ts: NOW - 5 * HOUR + 1, kind: 'upload', capture: CAP, ms: 1200, tries: 1 },
    { v: 1, ts: NOW - 5 * HOUR + 2, kind: 'name', capture: CAP, ms: 3900, ok: false },
    { v: 1, ts: NOW - 5 * HOUR + 3, kind: 'words', audioMs: 8000, waitMs: 200, decodeMs: 1100, backlogMs: 0, modelLoadMs: 4000 },
    { v: 1, ts: NOW - 4 * HOUR, kind: 'run', batch: BATCH, members: [{ kind: 'capture', waitMs: 300, outcome: 'review' }, { kind: 'comment', waitMs: 500, outcome: 'done' }], beforeMs: 2100, agentMs: [62000], afterMs: 1900, deliverMs: 40, attempts: 1 },
    { v: 1, ts: NOW - 4 * HOUR + 1, kind: 'run', batch: BATCH, deliverMs: 90, redelivered: true, failure: 'delivery' },
    { v: 1, ts: NOW - 3 * HOUR, kind: 'shot', frame: 'demo/hero', scale: 2, ms: 640, recaptures: 2, outcome: 'stale' },
    { v: 1, ts: NOW - 3 * HOUR + 1, kind: 'dropped', count: 3 },
  ]
}

const runLine = (run: string, ago: number, o: Record<string, unknown> = {}) => ({
  v: 1, script: 1, run, where: 'headless', ts: NOW - ago, board: 'main', inputs: { hash: '0123456789abcdef', files: 1234 }, inputsEnd: '0123456789abcdef', frames: 7,
  marver: '0.29.0', chrome: '156.0.8078.48', flags: ['--headless=new'], renderer: { gpuCompositing: 'enabled' }, machine: H1,
  host: { chip: 'Apple M3 Max', cores: { total: 16, p: 12, e: 4 }, model: 'Mac15,9', memGB: 64, os: '26.1', arch: 'arm64' }, power: 'ac', slow: false, bakes: 'warm', postersMissing: 0,
  saved: { measuring: 3, savedHeights: 2 }, loadToSettledMs: 3000, settledMs: 2600, moves: 3, lateMoves: 0, gestures: 3, p50: 8.3, p95: 16.7, over33ms: 1, heapPeakMB: 120, errors: 0,
  forbidden: 0, refusedInPage: 0, overlapped: false, valid: true, ...o,
})
const runs = (): unknown[] => [
  runLine('aaaaaaaaaaaaaaa1', 4 * HOUR),
  runLine('aaaaaaaaaaaaaaa2', 3 * HOUR, { loadToSettledMs: 3100, p95: 17 }),
  runLine('aaaaaaaaaaaaaaa3', 2 * HOUR, { inputs: { hash: 'fedcba9876543210', files: 1235 }, inputsEnd: 'fedcba9876543210', loadToSettledMs: 3900, p95: 21, over33ms: 4 }),
  runLine('aaaaaaaaaaaaaaa4', HOUR, { overlapped: true }),
  runLine('aaaaaaaaaaaaaaa5', 30 * MIN, { valid: false, invalidReason: 'cut', cut: 'timeout', loadToSettledMs: null }),
]

function app(flavour: 'release' | 'dev', launch: string): unknown[] {
  let seq = 0
  const env = (ago: number, kind: string, body: Record<string, unknown>, machine = H1) => ({ v: 1, ts: NOW - ago, kind, app: launch, seq: seq++, flavour, machine, ...body })
  const agg = (v: number) => ({ mean: v, max: v, last: v })
  const sample = (ago: number) => env(ago, 'sample', {
    span: 60_021, n: 12, pressure: { last: 1, max: 2 }, thermal: 'nominal',
    procs: [
      { pid: 100, born: 1793392562973.58, type: 'browser', role: 'none', tabs: [], cpu: agg(0.0038), rssMB: agg(210) },
      { pid: 57221, born: 1793461525603.633, type: 'renderer', role: 'canvas', tabs: ['t2'], cpu: agg(0.12), rssMB: agg(900), footprintMB: agg(822.2) },
    ],
    gpu: { pid: 101, born: 1793392562999.1, cpu: agg(0.2), gpuProcessRssMB: agg(512.4) },
    canvases: { memMB: agg(822.2), byTab: { t2: { memMB: agg(822.2), cpu: agg(0.12) } } }, visible: null, sys: { freeMB: 4000, purgeableMB: 300 }, spawnMs: 12,
  })
  const ident = { tab: 't2', ws: WS1, commit: 4, page: PAGE1 }
  const agx = { gpuSystemMemoryMB: 608.4, allocMB: 6515.5, utilPct: 1, rendererPct: 1, tilerPct: 1, recoveryCount: 0, machineWide: true }
  const flash = {
    ...ident, id: '20261103-112000-ab12', via: 'key', recorder: true, ring: { samples: [], events: [] },
    now: { ts: NOW - 40 * MIN + 500, procs: [], gpu: { gpuProcessRssMB: 512.4 } }, gpuEvents: [{ kind: 'child-gone', type: 'GPU', ts: NOW - 40 * MIN + 400 }, { kind: 'gone', ts: NOW - 40 * MIN + 300 }],
    pressure: { level: 2, at: NOW - 40 * MIN - 500, availablePct: 40 }, thermal: 'nominal', agx, picture: 'flashes/20261103-112000-ab12.png',
  }
  const other = { tab: 't9', ws: WS2, commit: 1, page: 'cea843bc6700' }
  return [
    env(2 * HOUR, 'start', { version: '1.0.0', electron: '45.0.0', chrome: '156.0.8078.48', recorder: true, pid: 100 }),
    env(2 * HOUR - 1000, 'tab', { ...ident, state: 'shown', active: true, view: 'live', main: { pid: 57221, born: 1793461525603.633 } }),
    env(2 * HOUR - 2000, 'agx', agx),
    sample(45 * MIN),
    env(40 * MIN - 2000, 'flash', flash),
    env(40 * MIN + 100, 'shown', { ...ident, ms: 12.8 }),
    env(39 * MIN - 100, 'whiteout-candidate', { ...ident, gesture: 7, observedAt: [NOW - 39 * MIN + 60, NOW - 39 * MIN + 310], rateHz: 4, samples: 6, skipped: 0, inconclusive: 1, gpuEvents: [{ kind: 'gpu-restart', ts: NOW - 39 * MIN }], agx }),
    env(38 * MIN, 'flash', { ...flash, ...other, id: '20261103-112200-cd34', now: { ts: NOW - 38 * MIN, procs: [] }, gpuEvents: [], pressure: null, picture: null, pictureWhy: 'write failed' }),
    sample(30 * MIN),
    env(29 * MIN, 'unresponsive', { ...ident, role: 'canvas', pid: 57221, born: 1793461525603.633 }),
    env(29 * MIN - 4000, 'responsive', { ...ident, role: 'canvas', pid: 57221, born: 1793461525603.633 }),
    sample(21 * MIN),
    env(20 * MIN, 'gone', { ...ident, role: 'canvas', pid: 57221, born: 1793461525603.633, reason: 'crashed', exitCode: 11, ours: false, pressure: 2 }, H2),
    env(19 * MIN, 'gone', { ...ident, role: 'canvas', pid: 57222, born: 1793461525603.9, reason: 'unload', exitCode: 0, ours: true, source: 'unload', pressure: null }, H2),
    env(18 * MIN, 'child-gone', { type: 'GPU', reason: 'crashed', exitCode: 5, ours: false, machineWide: false }, H2),
    env(17 * MIN, 'gpu-restart', { pid: 102, born: 1793461525700.1, was: { pid: 101, born: 1793392562999.1 } }, H2),
    env(16 * MIN, 'gone', { role: 'strip', pid: 300, born: 1793392563000.1, reason: 'crashed', exitCode: 1, ours: false, pressure: null }, H2),
  ]
}

const profile = (kind: string) => ({
  v: 1, kind, host: { chip: 'Apple M3 Max', cores: { total: 16, p: 12, e: 4 }, model: 'Mac15,9', memGB: 64, os: '26.1', arch: 'arm64' }, hostHash: 'abcdefabcdefabcd', electron: '45.0.0', chrome: '156.0.8078.48',
  gpu: { renderer: 'Apple M3 Max', backend: 'metal', gpuCores: 40 }, displays: [{ internal: true, sizeDip: [1728, 1117], scaleFactor: 2, pixels: [3456, 2234], hz: 120 }], tileBudgetMB: 512, power: { source: 'ac', lowPowerMode: 'unknown' },
})

/** The fixture on disk: `root` a repo, `home` a MARVER_HOME. */
export function writeFixture(root: string, home: string): void {
  const perf = join(root, 'design', '.local', 'perf')
  mkdirSync(perf, { recursive: true })
  mkdirSync(join(root, 'design', 'boards'), { recursive: true })
  writeFileSync(join(root, 'design', 'boards', 'main.json'), JSON.stringify({ version: 1, name: 'main', title: 'The Main Board', order: 0, auto: false, nodes: [] }))
  writeFileSync(join(perf, 'reloads.jsonl'), ln(reloads()))
  writeFileSync(join(perf, 'page.jsonl'), ln(page()))
  writeFileSync(join(perf, 'jam.jsonl'), ln(jam()))
  writeFileSync(join(perf, 'runs.jsonl'), ln(runs()))
  const hp = join(home, 'perf')
  mkdirSync(join(hp, 'machine'), { recursive: true })
  mkdirSync(join(hp, 'crashpad', 'completed'), { recursive: true })
  writeFileSync(join(hp, 'app.jsonl'), ln(app('release', 'b29529ef1979')))
  writeFileSync(join(hp, 'app-dev.jsonl'), ln(app('dev', 'c29529ef1979').slice(0, 4)))
  writeFileSync(join(hp, 'crashpad', 'completed', '00000001-1111-2222-3333-444444444444.dmp'), 'x')
  const t = new Date(NOW - HOUR)
  for (const [h, kind] of [[H1, 'app'], [H2, 'app'], ['f00df00df00df00d', 'headless']] as const) {
    const p = join(hp, 'machine', `${h}.json`)
    writeFileSync(p, JSON.stringify(profile(kind)))
    utimesSync(p, t, t)
  }
}
