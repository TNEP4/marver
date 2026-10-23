import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crashesSummary, flashesSummary, machineSummary, momentOf, readAppLog, repoWorkspaces } from '../src/cli/perf-app.ts'
import { perfCommand } from '../src/cli/perf.ts'
import { pageLog, perfDir, runsLog } from '../src/server/perf.ts'
import { workspaceId } from '../src/server/workspace.ts'
import type { AppRecord } from '../src/shared/app-perf.ts'
import type { RunLine } from '../src/shared/perf-run.ts'

/** `marver perf --crashes`, `--flashes`, `--machine` (spec 28 A3.5, A3.8 #23) over fixtures: the app's records
 *  (app.jsonl, app-dev.jsonl) joined to the repo's page.jsonl by `page`, by workspace and time when a record has none,
 *  and by time alone for what is machine-wide, each saying so; a `--recover` run's workspace counts as the repo's;
 *  `--loads` hides a headless run's loads and says how many. */

const APP = '0123456789ab', DEV = 'ba9876543210', H_APP = 'aaaaaaaaaaaaaaaa', H_RUN = 'bbbbbbbbbbbbbbbb', HOST = 'cccccccccccccccc'
const P1 = 'p00000000001', P2 = 'p00000000002', L1 = 'l00000000001', L2 = 'l00000000002'

let root = ''
let home = ''
let WS = ''
const RECOVER = 'fedcba9876543210', OTHER = '1111111111111111'
const NOW = Date.now()

function pageFixture() {
  let seq = 0
  const r = (page: string, load: string, kind: string, ago: number, body: Record<string, unknown> = {}, ws = WS) => ({ v: 1, ws, page, load, seq: seq++, ts: NOW - ago, kind, ...body })
  return [
    r(P1, L1, 'load', 60_000, { board: 'tidewell', cause: 'boot', request: L1, sinceNav: 300 }),
    r(P1, L1, 'commit', 59_000, { request: L1, ms: 1000, frames: 12 }),
    r(P1, L1, 'settled', 57_000, { ms: 3000, moves: 0 }),
    r(P1, L1, 'gesture', 10_400, { type: 'zoom', ms: 800, frames: 48, p50: 8.3, p95: 12.1, max: 20, over17ms: 1, over33ms: 0, longFrames: 0, hz: 120 }),
    // the --recover run's page, under the workspace an earlier address used
    r(P2, L2, 'load', 40_000, { board: 'notes', cause: 'boot', request: L2 }, RECOVER),
    r(P2, L2, 'commit', 39_000, { request: L2, ms: 1000, frames: 3 }, RECOVER),
  ]
}

function appFixture(): string[] {
  let seq = 0
  const line = (kind: string, ago: number, body: Record<string, unknown>, o: { app?: string; flavour?: string; machine?: string } = {}) =>
    JSON.stringify({ v: 1, ts: NOW - ago, kind, app: o.app ?? APP, seq: seq++, flavour: o.flavour ?? 'release', machine: o.machine ?? H_APP, ...body })
  const agg = (v: number) => ({ mean: v, max: v, last: v })
  return [
    line('start', 70_000, { version: '0.2.0', electron: '45.0.0', chrome: '142', recorder: true, pid: 1 }),
    line('sample', 15_000, { span: 60_000, n: 12, pressure: { last: 2, max: 2 }, thermal: 'fair', procs: [{ pid: 777, born: 1, type: 'renderer', role: 'canvas', tabs: ['t1'], cpu: agg(0.5), rssMB: agg(300), footprintMB: agg(420) }], gpu: { pid: 9, born: 1, cpu: agg(0.1), gpuProcessRssMB: agg(150) }, canvases: { memMB: agg(420), byTab: {} }, visible: null, sys: null, spawnMs: 4 }),
    // a crash with its page: joined by page
    line('gone', 10_000, { tab: 't1', ws: WS, commit: 3, page: P1, role: 'canvas', pid: 777, born: 1, reason: 'oom', exitCode: 9, ours: false, pressure: 2 }),
    // ours (an unload, Reload Page): not a crash
    line('gone', 9_000, { tab: 't1', ws: WS, commit: 4, page: P1, role: 'canvas', pid: 778, born: 2, reason: 'killed', exitCode: 9, ours: true, source: 'unload', pressure: 2 }),
    // no page (a 0.27.0 canvas): by workspace and time, under the --recover run's workspace
    line('gone', 30_000, { tab: 't2', ws: RECOVER, commit: 1, role: 'canvas', pid: 779, born: 3, reason: 'crashed', exitCode: 11, ours: false, pressure: 1 }),
    // another repo's canvas: not this repo's
    line('gone', 8_000, { tab: 't3', ws: OTHER, commit: 1, page: 'p00000000009', role: 'canvas', pid: 780, born: 4, reason: 'crashed', exitCode: 11, ours: false, pressure: 1 }),
    line('unresponsive', 20_000, { tab: 't1', ws: WS, commit: 3, page: P1, role: 'canvas', pid: 777, born: 1 }),
    line('responsive', 17_500, { tab: 't1', ws: WS, commit: 3, page: P1, role: 'canvas', pid: 777, born: 1 }),
    // machine-wide: by time
    line('child-gone', 11_000, { type: 'GPU', reason: 'crashed', exitCode: 11, ours: false, machineWide: false }),
    line('gpu-restart', 5_000, { pid: 10, born: 5, was: { pid: 9, born: 1 } }),
    line('gone', 4_000, { role: 'strip', pid: 50, born: 1, reason: 'crashed', exitCode: 11, ours: false, pressure: 1 }),
    // a mark on P1, 0.4 s after a zoom ended; one on Home; one on another repo
    line('flash', 10_000, { id: 'm1', via: 'key', tab: 't1', ws: WS, commit: 3, page: P1, recorder: true, ring: null, now: { gpu: { pid: 9, born: 1, cpu: 0.1, gpuProcessRssMB: 160 } }, gpuEvents: [{ kind: 'child-gone', ts: NOW - 10_600 }], thermal: 'fair', pressure: { level: 2, availablePct: 20, at: 0 }, featureStatus: {}, agx: { gpuSystemMemoryMB: 1154.5, utilPct: 13, machineWide: true }, picture: 'flashes/m1.png' }),
    line('flash', 3_000, { id: 'm2', via: 'menu', recorder: false, ring: null, now: {}, gpuEvents: [], thermal: 'nominal', pressure: null, featureStatus: {}, agx: {}, picture: null, pictureWhy: 'window hidden' }, { app: DEV, flavour: 'dev' }),
    line('flash', 2_000, { id: 'm3', via: 'key', tab: 't3', ws: OTHER, page: 'p00000000009', recorder: true, ring: null, now: {}, gpuEvents: [], thermal: 'nominal', pressure: null, featureStatus: {}, agx: {}, picture: null, pictureWhy: 'timeout' }),
    line('whiteout-candidate', 9_500, { tab: 't1', ws: WS, commit: 3, page: P1, gesture: 7, observedAt: [NOW - 9_500, NOW - 9_250], rateHz: 4, samples: 6, skipped: 0, inconclusive: 1, gpuEvents: [], agx: {} }),
  ]
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-perf-app-')))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mv-perf-app-home-')))
  WS = workspaceId(root)
  mkdirSync(perfDir(root), { recursive: true })
  writeFileSync(pageLog(root), pageFixture().map((r) => JSON.stringify(r)).join('\n') + '\n')
  mkdirSync(join(home, 'perf', 'machine'), { recursive: true })
  mkdirSync(join(home, 'perf', 'crashpad', 'completed'), { recursive: true })
  writeFileSync(join(home, 'perf', 'crashpad', 'completed', 'aaaaaaaa-1111-2222-3333-444444444444.dmp'), 'x')
  const lines = appFixture()
  // the dev launch's line goes to app-dev.jsonl; a line repeated (a quit's flush of a batch already written) counts once
  writeFileSync(join(home, 'perf', 'app.jsonl'), lines.filter((l) => !l.includes(`"app":"${DEV}"`)).join('\n') + '\n' + lines[2] + '\n{"v":1,"ts":1,"kind":"main-error"}\n')
  writeFileSync(join(home, 'perf', 'app-dev.jsonl'), lines.filter((l) => l.includes(`"app":"${DEV}"`)).join('\n') + '\n')
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) })

const page = () => pageFixture()

describe('the app log, read', () => {
  it('both flavours, the envelope checked, a line written twice once; the repo\'s workspaces include a --recover run\'s', () => {
    const app = readAppLog(home)
    expect(app.filter((r) => r.kind === 'gone')).toHaveLength(5)
    expect(app.some((r) => r.flavour === 'dev')).toBe(true)
    // from `since`: the release's file in its order, then Marver Dev's
    expect(readAppLog(home, NOW - 6_000).map((r) => [r.kind, r.flavour])).toEqual([['gpu-restart', 'release'], ['gone', 'release'], ['flash', 'release'], ['flash', 'dev']])
    expect([...repoWorkspaces(root, page())].sort()).toEqual([WS, RECOVER].sort())
  })
})

describe('--crashes (A3.8 #23)', () => {
  it('a canvas crash joined by page to its load (settled) and the last gesture; ours and other repos left out; no page: by workspace and time', () => {
    const app = readAppLog(home)
    const s = crashesSummary(app, page(), repoWorkspaces(root, page()), home)
    expect(s.crashes.map((c) => c.pid)).toEqual([779, 777])   // in time order, both flavours together
    const c = s.crashes.find((x) => x.pid === 777)!
    expect(c).toMatchObject({ join: 'page', page: P1, board: 'tidewell', reason: 'oom', exitCode: 9, pressure: 2, load: { id: L1, cause: 'boot', settled: true, settledMs: 3000 } })
    expect(c.gesture).toMatchObject({ type: 'zoom', endedMsBefore: 400 })
    // the minute before it: by time, from the same launch
    expect(c.before).toMatchObject({ join: 'time', pressure: 2, thermal: 'fair', canvasMB: 420, gpuProcessRssMB: 150, procMB: 420, msBefore: 5000 })
    const noPage = s.crashes.find((x) => x.pid === 779)!
    expect(noPage).toMatchObject({ join: 'ws+time', page: P2, board: 'notes' })
    expect(noPage.load).toMatchObject({ settled: false })
    // the hang, and when it answered again
    expect(s.hangs).toEqual([expect.objectContaining({ pid: 777, respondedAfterMs: 2500, join: 'page', board: 'tidewell' })])
    // machine-wide, by time: the GPU process, its silent replacement, an app page's renderer
    expect(s.byTime.map((m) => [m.what, m.join])).toEqual([['child-gone', 'time'], ['gpu-restart', 'time'], ['app-page-gone', 'time']])
    expect(s.dumps).toBe(1)
  })

  it('printed: each crash with its board in words, the minute before, the machine-wide ends labelled by time, the dump count', () => {
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
    const was = process.env.MARVER_HOME
    process.env.MARVER_HOME = home
    try { perfCommand(root, { crashes: true }) } finally { process.env.MARVER_HOME = was }
    const text = out.join('\n')
    expect(text).toMatch(/canvas crashes: 2/)
    expect(text).toMatch(/oom \(exit 9\) · pid 777 · pressure warn/)
    expect(text).toMatch(/Tidewell · its load settled in 3\.0 s · last gesture zoom 0\.40 s before/)
    expect(text).toMatch(/joined by workspace and time: no page id/)
    expect(text).toMatch(/the minute before \(by time, machine-wide\): pressure warn, thermal fair, canvases 420 MB, the GPU process 150 MB, this renderer 420 MB/)
    expect(text).toMatch(/by time \(machine-wide\): 3/)
    expect(text).toMatch(/the GPU process ended: crashed \(exit 11\)/)
    expect(text).toMatch(/crash reports: 1 in /)
    out.length = 0
    process.env.MARVER_HOME = home
    try { perfCommand(root, { crashes: true, json: true }) } finally { process.env.MARVER_HOME = was }
    expect(JSON.parse(out.join('\n')).crashes).toHaveLength(2)
  })
})

describe('--flashes (A3.8 #23)', () => {
  it('a mark joined by page to its board and the gesture that ended 0.4 s before; Home\'s and another repo\'s counted, shown with --all; candidates apart', () => {
    const app = readAppLog(home)
    const ws = repoWorkspaces(root, page())
    const s = flashesSummary(app, page(), ws, { home })
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0]).toMatchObject({ id: 'm1', join: 'page', board: 'tidewell', gesture: { type: 'zoom', endedMsBefore: 400, p95: 12.1 }, pressure: 2, thermal: 'fair', gpuProcessRssMB: 160, picture: join(home, 'perf', 'flashes', 'm1.png') })
    expect(s.marks[0]!.gpuEvents).toEqual([{ kind: 'child-gone', ts: NOW - 10_600 }])
    expect(s.others).toBe(2)
    expect(s.candidates).toEqual([expect.objectContaining({ gestureSeq: 7, rateHz: 4, observedAt: [NOW - 9_500, NOW - 9_250], join: 'page', board: 'tidewell' })])
    const all = flashesSummary(app, page(), ws, { all: true, home })
    expect(all.marks.map((m) => [m.id, m.join])).toEqual([['m1', 'page'], ['m2', 'none'], ['m3', 'none']])
    expect(all.marks.find((m) => m.id === 'm2')).toMatchObject({ picture: null, pictureWhy: 'window hidden', recorder: false, flavour: 'dev' })
  })

  it('printed: the mark in words, the picture\'s path, how many others; candidates "automatic, not verified"', () => {
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
    const was = process.env.MARVER_HOME
    process.env.MARVER_HOME = home
    try { perfCommand(root, { flashes: true }) } finally { process.env.MARVER_HOME = was }
    const text = out.join('\n')
    expect(text).toMatch(/Tidewell · its load settled in 3\.0 s · last gesture zoom 0\.40 s before/)
    expect(text).toContain(join(home, 'perf', 'flashes', 'm1.png'))
    expect(text).toMatch(/2 more marks on other canvases or on Home \(--all shows them\)/)
    expect(text).toMatch(/white-out candidates \(automatic, not verified\): 1/)
  })
})

describe('--machine (A3.8 #11, #23)', () => {
  it('an app and a headless profile of one host grouped by hostHash; which is current; how many records and runs name each', () => {
    const host = { chip: 'Apple M5 Pro', cores: { total: 18, p: 6, e: 12 }, model: 'Mac17,8', memGB: 48, os: '26.6.2', arch: 'arm64' }
    writeFileSync(join(home, 'perf', 'machine', `${H_APP}.json`), JSON.stringify({ v: 1, kind: 'app', host, hostHash: HOST, electron: '45.0.0', chrome: '142', gpu: { renderer: 'ANGLE Metal', backend: 'x', vendorId: 4203, gpuCores: 20, featureStatus: {} }, displays: [{ internal: true, sizeDip: [1512, 982], scaleFactor: 2, pixels: [3024, 1964], hz: 120, colorSpace: '' }], tileBudgetMB: 1152, power: { source: 'ac', lowPowerMode: 'unknown' } }))
    writeFileSync(join(home, 'perf', 'machine', `${H_RUN}.json`), JSON.stringify({ v: 1, kind: 'headless', host, hostHash: HOST, power: 'ac' }))
    writeFileSync(join(home, 'perf', 'machine', 'dddddddddddddddd.json'), JSON.stringify({ v: 1, kind: 'app', host: { ...host, os: '26.5' }, hostHash: 'eeeeeeeeeeeeeeee' }))
    const runs = [{ v: 1, script: 1, run: '0123456789abcdef', ts: NOW, machine: H_RUN } as unknown as RunLine]
    const app = readAppLog(home)
    const s = machineSummary(home, app, runs)
    const by = Object.fromEntries(s.profiles.map((p) => [p.hash, p]))
    expect(by[H_APP]).toMatchObject({ kind: 'app', hostHash: HOST, current: true, records: app.filter((r) => r.machine === H_APP).length, runs: 0, displays: 'built-in 3024x1964 @ 120 Hz' })
    expect(by[H_RUN]).toMatchObject({ kind: 'headless', hostHash: HOST, current: true, records: 0, runs: 1 })
    expect(by.dddddddddddddddd).toMatchObject({ current: false, records: 0, runs: 0 })
    expect(s.byHost.find((g) => g.hostHash === HOST)!.profiles.sort()).toEqual([H_APP, H_RUN].sort())
    // printed, with the runs.jsonl the repo holds
    writeFileSync(runsLog(root), JSON.stringify(runs[0]) + '\n')
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
    const was = process.env.MARVER_HOME
    process.env.MARVER_HOME = home
    try { perfCommand(root, { machine: true }) } finally { process.env.MARVER_HOME = was }
    const text = out.join('\n')
    expect(text).toMatch(new RegExp(`host ${HOST}: Apple M5 Pro · Mac17,8 · macOS 26.6.2`))
    expect(text).toMatch(new RegExp(`${H_RUN}  headless \\(current\\) · 0 app records, 1 run`))
  })
})

describe('the page half beside the app\'s', () => {
  it('--loads hides a headless run\'s loads and says how many', () => {
    const recs = [...page(), { v: 1, ws: WS, page: 'p00000000003', load: 'l00000000003', seq: 0, ts: NOW - 1000, kind: 'load', board: 'tidewell', cause: 'boot', request: 'l00000000003', run: '0123456789abcdef' }]
    writeFileSync(pageLog(root), recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
    perfCommand(root, { loads: true, json: true })
    const j = JSON.parse(out.join('\n'))
    expect(j.runLoads).toBe(1)
    expect(j.loads.map((l: { page: string }) => l.page)).toEqual([P1, P2])
    out.length = 0
    perfCommand(root, { loads: true })
    expect(out.join('\n')).toMatch(/1 headless run load not shown: marver perf --runs/)
  })

  it('a moment with no page and no workspace record near it joins nothing, and says so', () => {
    expect(momentOf({ ts: NOW, ws: OTHER } as AppRecord & Record<string, unknown>, page())).toEqual({ join: 'none' })
  })
})
