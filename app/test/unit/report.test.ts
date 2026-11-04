/**
 * The performance report (spec 28 A5.1 #26-#28, #32; r1 #9, r2 #4, r3 #5), on temporary folders with synthetic
 * `app.jsonl` lines, without Electron: an input of every kind and its output byte for byte; the samples' hour fold
 * against figures worked out by hand, from minutes procs.ts's `foldMinute` folded (two helpers one after the other, a
 * partial minute, a sleep, a missing cumulative reading, a role change within a minute, a line from before `own`);
 * secrets planted in dropped fields and in kept but ruled ones, and a malicious record of every kind, none reaching
 * the output; the 7-day window and keepPerfDays; the 2,000 events and the 2 MB bound; `missing`, `unreadable` and
 * `partial` sections, unknown kinds counted; the same input giving the same bytes. Then the export (#28): the save
 * panel's name, cancel, the file written whole and shown in Finder, a failure's alert leaving no file, one at a time.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_KINDS, type AppKind, type Sample, type SampleBody, type UPDATE_MOVE_WHY } from '../../../src/shared/app-perf.ts'
import {
  GPU_FEATURES, PROJECTIONS, REPORT_EVENTS_MAX, REPORT_MAX_BYTES, UNLOAD_REFUSALS, UPDATE_WHY, nearestRank, reportDays,
  type HourRow, type MacRow, type PerfReport,
} from '../../../src/shared/app-report.ts'
import { buildReport, exportReport, failureDetail, REPORT_FAILED, reportName, type ExportPorts, type ReportInput } from '../../src/main/report.ts'
import { foldMinute } from '../../src/main/procs.ts'
import { pageOffers, type PageBody } from '../../src/main/tabpage.ts'
import { faults } from '../../src/main/fsx.ts'
import type { UnloadRefusal } from '../../src/main/tabs.ts'
import type { BlockedWhy } from '../../src/main/update-model.ts'

const DAY = 86_400_000
const HOUR = 3_600_000
/** 2 Nov 2026, 12:00 UTC */
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
/** two days before, on the hour */
const T0 = NOW - 2 * DAY
const H1 = '0123456789abcdef'
const H2 = 'fedcba9876543210'
const H3 = '00000000000000ff'
const APP = 'a1b2c3d4e5f6'

let base: string
let perf: string
let seq = 0

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-report-')))
  perf = join(base, 'perf')
  mkdirSync(join(perf, 'machine'), { recursive: true })
  seq = 0
})
afterEach(() => {
  vi.useRealTimers()
  faults.clear()
  try { chmodSync(join(base, 'locked'), 0o700) } catch { /* none */ }
  rmSync(base, { recursive: true, force: true })
})

/** A line as perflog.ts writes it: the envelope first, then the body (which never overrides it). */
function line(ts: number, kind: string, body: Record<string, unknown> = {}, env: Partial<{ machine: string | null; app: string; flavour: string }> = {}): string {
  const o: Record<string, unknown> = { v: 1, ts, kind, app: env.app ?? APP, seq: seq++, flavour: env.flavour ?? 'release', machine: env.machine === undefined ? H1 : env.machine }
  for (const [k, v] of Object.entries(body)) if (!(k in o)) o[k] = v
  return JSON.stringify(o)
}
const writeLog = (lines: string[], file = 'app.jsonl') => writeFileSync(join(perf, file), lines.join('\n') + '\n')
const input = (o: Partial<ReportInput> = {}): ReportInput => ({ perfDir: perf, flavour: 'release', keepPerfDays: 14, now: NOW, version: '1.0.0', electron: '45.0.0', macos: '26.1', ...o })
const build = async (o: Partial<ReportInput> = {}) => buildReport(input(o))

/** an app profile as machine.ts writes it, with what the report must never take (the renderer, a display's id and colour space) */
const PROFILE = {
  v: 1, kind: 'app',
  host: { chip: 'Apple M3 Max', cores: { total: 16, p: 12, e: 4 }, model: 'Mac15,9', memGB: 64, os: '26.1', arch: 'arm64' },
  hostHash: 'abcdefabcdefabcd', electron: '45.0.0', chrome: '142.0.7444.52',
  gpu: { renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)', backend: 'metal', vendorId: 4203, gpuCores: 40, featureStatus: { webgl: 'enabled' } },
  displays: [{ internal: true, id: 1, sizeDip: [1728, 1117], scaleFactor: 2, pixels: [3456, 2234], hz: 120, colorSpace: '{primaries:P3, transfer:SRGB}' }],
  tileBudgetMB: 512, power: { source: 'ac', lowPowerMode: 'unknown' },
}
const writeProfile = (hash: string, p: unknown) => writeFileSync(join(perf, 'machine', `${hash}.json`), typeof p === 'string' ? p : JSON.stringify(p))

const UUID = (n: number) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`
function dump(sub: 'completed' | 'pending', n: number, at: number): void {
  mkdirSync(join(perf, 'crashpad', sub), { recursive: true })
  const f = join(perf, 'crashpad', sub, `${UUID(n)}.dmp`)
  writeFileSync(f, 'MDMP')
  utimesSync(f, at / 1000, at / 1000)
}

const AGX = { gpuSystemMemoryMB: 1024.5, allocMB: 'unknown', utilPct: 12, rendererPct: 10, tilerPct: 3, recoveryCount: 0, machineWide: true }
const AGX_OUT = { gpuSystemMemoryMB: 1024.5, allocMB: 'unknown', utilPct: 12, rendererPct: 10, tilerPct: 3, recoveryCount: 0 }

describe('an input of every kind, its output byte for byte (A5.1 #27, r1 #9)', () => {
  // [kind, body as the recorder writes it, what may leave (null: folded or counted)]
  const ROWS: [AppKind, Record<string, unknown>, Record<string, unknown> | null][] = [
    ['start', { version: '1.0.0', electron: '45.0.0', chrome: '142.0.7444.52', recorder: true, pid: 4242 }, { version: '1.0.0', electron: '45.0.0', recorder: true }],
    ['agx', AGX, AGX_OUT],
    ['gone', { tab: 't3', ws: 'ws-tidewell', commit: 4, page: 'home', role: 'canvas', pid: 501, born: 1700, reason: 'oom', exitCode: 9, ours: false, pressure: 2 },
      { tab: 't3', role: 'canvas', reason: 'oom', exitCode: 9, ours: false, pressure: 2 }],
    ['child-gone', { type: 'Utility', name: 'Network Service', reason: 'crashed', exitCode: 11, ours: false, machineWide: false }, { type: 'Utility', reason: 'crashed', exitCode: 11 }],
    ['gpu-restart', { pid: 600, born: 1800, was: { pid: 599, born: 1799 } }, {}],
    ['unresponsive', { tab: 't3', ws: 'ws-tidewell', page: 'home', role: 'canvas', pid: 501, born: 1700 }, { tab: 't3', role: 'canvas' }],
    ['responsive', { tab: 't3', ws: 'ws-tidewell', page: 'home', role: 'canvas', pid: 501, born: 1700 }, { tab: 't3', role: 'canvas' }],
    ['gpu', { featureStatus: { webgpu: 'disabled_off', '2d_canvas': 'enabled', webgl: 'enabled', skia_graphite: 'enabled_on' } },
      { featureStatus: { '2d_canvas': 'enabled', skia_graphite: 'enabled_on', webgl: 'enabled', webgpu: 'disabled_off' } }],
    ['power', { event: 'thermal-state-change', thermal: 'fair', limit: 80 }, { event: 'thermal-state-change', thermal: 'fair' }],
    ['tab', { tab: 't3', ws: 'ws-tidewell', commit: 4, page: 'home', state: 'live', active: true, view: 'live', main: { pid: 501, born: 1700 } }, null],
    ['shown', { tab: 't3', ws: 'ws-tidewell', page: 'home', ms: 42.2 }, null],
    ['pressure', { level: 2, availablePct: 30, was: 1 }, { level: 2, availablePct: 30 }],
    ['unload', { tab: 't4', ws: 'ws-gen', phase: 'done', reason: 'warn', why: 'x' }, { tab: 't4', phase: 'done', reason: 'warn' }],
    ['unload-skip', { tab: 't5', ws: 'ws-gen', reason: 'critical', why: 'active' }, { tab: 't5', reason: 'critical', why: 'active' }],
    ['unload-effect', {
      tab: 't4', ws: 'ws-gen', reason: 'warn', pidGone: true,
      before: { level: 2, availablePct: 30, canvasMB: 900.5, tab: { pids: [501, 502], memMB: 400 }, gpuProcessRssMB: 250 },
      after: { level: 1, availablePct: 45, canvasMB: 500, tab: { pids: [], memMB: null }, gpuProcessRssMB: 240 },
    }, {
      tab: 't4', reason: 'warn',
      before: { level: 2, availablePct: 30, canvasMB: 900.5, tab: { memMB: 400 }, gpuProcessRssMB: 250 },
      after: { level: 1, availablePct: 45, canvasMB: 500, tab: { memMB: null }, gpuProcessRssMB: 240 },
      pidGone: true,
    }],
    ['reopen', { tab: 't4', ws: 'ws-gen', page: 'p', commit: 2, activateToLiftMs: 820, unloadedForMs: 60_000 }, { tab: 't4', activateToLiftMs: 820, unloadedForMs: 60_000 }],
    ['cover', { tab: 't3', ws: 'ws-tidewell', epoch: 7, cause: 'show', outcome: 'uncovered', sentMs: 1, answeredMs: 30, uncoveredMs: 34, frames: 3, uncoverDelayMs: 4 },
      { tab: 't3', cause: 'show', outcome: 'uncovered', sentMs: 1, answeredMs: 30, uncoveredMs: 34, uncoverDelayMs: 4, frames: 3 }],
    ['flash', {
      tab: 't3', ws: 'ws-tidewell', page: 'home', id: '20261031T120017Z-ab12', via: 'menu', recorder: true, ring: { samples: [], events: [] },
      now: { ts: 1, mono: 1, dt: null, procs: [], gpu: null, pressure: null, thermal: 'nominal', sys: null, visible: null }, gpuEvents: [],
      thermal: 'nominal', pressure: { level: 1, availablePct: 60, at: 1 }, featureStatus: { webgl: 'enabled' }, agx: AGX, picture: 'flashes/20261031T120017Z-ab12.png',
    }, { tab: 't3', via: 'menu', recorder: true, thermal: 'nominal', pressure: 1, agx: AGX_OUT, picture: true }],
    ['whiteout-candidate', { tab: 't3', ws: 'ws-tidewell', gesture: 2, observedAt: [1, 2], rateHz: 4, samples: 9, skipped: 1, inconclusive: 0, gpuEvents: [], agx: AGX },
      { tab: 't3', rateHz: 4, samples: 9, skipped: 1, inconclusive: 0, agx: AGX_OUT }],
    ['dropped', { n: 3 }, { n: 3 }],
    ['main-error', { what: 'exception', name: 'TypeError', message: 'x is undefined', stack: ['at f (main.cjs:1:2)'] }, { what: 'exception', name: 'TypeError' }],
    ['update', { phase: 'move', why: 'moved', attempt: 2, version: '1.0.0', from: '0.3.0', to: '1.0.0', manual: false, message: 'm' },
      { phase: 'move', version: '1.0.0', from: '0.3.0', to: '1.0.0', why: 'moved', manual: false }],
    // spec 30 #56: counted, never exported, until a report v2
    ['launch', { readyMs: 410, windowShownMs: 520, tabs: { restored: 1, local: 1, remote: 0, active: 'local' }, why: 'home' }, null],
    ['cmd', { phase: 'once', id: 'aaaaaaaaaaaa', cmd: 'home', via: 'key', keys: 'Meta+T', in: 'strip', outcome: 'done', ms: 3 }, null],
    ['window', { event: 'enter-full-screen', cause: 'unknown' }, null],
  ]
  const SAMPLE: SampleBody = {
    span: 60_000, n: 12, pressure: { last: 1, max: 2 }, thermal: 'fair',
    procs: [{ pid: 7, born: 7, type: 'utility', role: 'none', name: 'Network Service', tabs: [], cpu: { mean: 0.01, max: 0.02, last: 0 }, rssMB: { mean: 20, max: 20, last: 20 }, footprintMB: { mean: null, max: null, last: null } }],
    gpu: { pid: 600, born: 1800, cpu: { mean: 0.1, max: 0.2, last: 0.1 }, gpuProcessRssMB: { mean: 150, max: 160.04, last: 150 } },
    canvases: { memMB: { mean: 400, max: 512.36, last: 400 }, byTab: { t3: { memMB: { mean: 400, max: 512.36, last: 400 }, cpu: { mean: 0.5, max: 1, last: 0.4 } } } },
    visible: { tab: 't3', ws: 'ws-tidewell', page: 'home', privateMB: 300, heapMB: 80, at: 1 }, sys: { freeMB: 1000, purgeableMB: 10 }, spawnMs: 12,
    own: { rssMB: { mean: 310.04, max: 333.36, last: 300 }, cpu: { s: 6.6, ms: 55_000, unmeasuredMs: 5000 } },
  }

  it('each kind through its projection; samples, shown and the Mac folded; crashpad counted', async () => {
    const lines = ROWS.map(([k, b], i) => line(T0 + i * 1000, k, b))
    lines.push(line(T0 + 30_000, 'sample', SAMPLE as unknown as Record<string, unknown>))
    writeLog(lines)
    writeProfile(H1, PROFILE)
    dump('completed', 1, NOW - DAY)
    dump('completed', 2, NOW - 3 * DAY)
    dump('completed', 3, NOW - 8 * DAY)     // outside the window
    dump('pending', 4, NOW - HOUR)
    writeFileSync(join(perf, 'crashpad', 'settings.dat'), 'x')

    const { report, json } = await build()
    const events = ROWS.map(([kind, , out], i) => (out ? { ts: T0 + i * 1000, kind, ...out } : null)).filter(Boolean).reverse()
    const counts = Object.fromEntries(APP_KINDS.map((k) => [k, 1]))
    const expected: PerfReport = {
      v: 1, made: NOW, version: '1.0.0', electron: '45.0.0', macos: '26.1', flavour: 'release', start: NOW - 7 * DAY, end: NOW,
      mac: { status: 'ok', unparsed: 0, absent: 0, cut: 0, rows: [{ from: T0, to: T0 + 30_000, chip: 'Apple M3 Max', cores: { total: 16, p: 12, e: 4 }, memGB: 64, model: 'Mac15,9', macos: '26.1', displays: [{ scaleFactor: 2, displayFrequency: 120 }] }] },
      samples: { status: 'ok', unparsed: 0, lines: 1, rows: [{
        hour: T0, minutes: 1, minutesMissing: 0, ownCpu: 0.12, ownCpuMaxMinute: 0.12, measuredS: 55, unmeasuredS: 5,
        ownRssMB: { mean: 310, max: 333.4 }, canvasMemMB: 512.4, gpuRssMB: 160, pressureMax: 2, thermalWorst: 'fair',
      }] },
      shown: { status: 'ok', unparsed: 0, lines: 1, days: [{ day: Math.floor((T0 + 10_000) / DAY) * DAY, n: 1, p50Ms: 42.2, p95Ms: 42.2 }] },
      events: { status: 'ok', unparsed: 0, unknown: 0, cut: 0, counts, list: events as PerfReport['events']['list'] },
      crashpad: { status: 'ok', completed: 2, pending: 1 },
    }
    expect(report).toEqual(expected)
    // byte for byte: the key order is the contract's
    expect(json).toBe(JSON.stringify(expected, null, 2) + '\n')
  })

  it('every exported kind has a projection, and the folded and counted kinds none', () => {
    const exported = APP_KINDS.filter((k) => !['sample', 'shown', 'tab', 'launch', 'cmd', 'window'].includes(k))
    expect(Object.keys(PROJECTIONS).sort()).toEqual([...exported].sort())
  })

  it('the same input gives the same bytes', async () => {
    writeLog(ROWS.map(([k, b], i) => line(T0 + i * 1000, k, b)))
    writeProfile(H1, PROFILE)
    expect((await build()).json).toBe((await build()).json)
  })
})

describe('the samples, one row per UTC hour, against figures worked out by hand (r2 #4, r3 #5)', () => {
  type P = { pid: number; type: 'browser' | 'gpu' | 'utility' | 'renderer'; role: Sample['procs'][number]['role']; cpu: number | null; rssMB: number; name?: string }
  const at = (mono: number, dt: number | null, procs: P[]): Sample => ({
    ts: 0, mono, dt, procs: procs.map((p) => ({ born: p.pid, tabs: [], footprintMB: null, ...p })), gpu: null, pressure: null, thermal: 'nominal', sys: null, visible: null,
  })
  const browser = (cpu: number | null): P => ({ pid: 1, type: 'browser', role: 'none', cpu, rssMB: 100 })
  const minute = (samples: Sample[]) => foldMinute(samples, 0)! as unknown as Record<string, unknown>

  it('helpers one after the other, a partial minute, a sleep, a missing reading, a role change, a line from before own', async () => {
    const hour = T0 + 3 * HOUR
    // A: helper 7 at one core, then helper 8 (its first interval unmeasured), then 8 at one core - one core, RSS never 7 + 8
    const A = minute([
      at(0, null, [browser(null)]),
      at(5000, 5, [browser(0), { pid: 7, type: 'utility', role: 'none', name: 'Helper A', cpu: 1, rssMB: 50 }]),
      at(10_000, 5, [browser(0), { pid: 8, type: 'utility', role: 'none', name: 'Helper B', cpu: null, rssMB: 60 }]),
      at(15_000, 5, [browser(0), { pid: 8, type: 'utility', role: 'none', name: 'Helper B', cpu: 1, rssMB: 60 }]),
    ])
    // B: a strip renderer that becomes a canvas renderer, then a missing cumulative reading (a partial minute: 15 s)
    const B = minute([
      at(0, 5, [browser(0), { pid: 9, type: 'renderer', role: 'strip', cpu: 0.5, rssMB: 40 }]),
      at(5000, 5, [browser(0), { pid: 9, type: 'renderer', role: 'canvas', cpu: 2, rssMB: 400 }]),
      at(10_000, 5, [browser(null), { pid: 9, type: 'renderer', role: 'canvas', cpu: 2, rssMB: 400 }]),
    ])
    // C: a line from before A5, with no own (its per-process list must never stand in)
    const C = { ...minute([at(0, 5, [browser(3)]), at(5000, 5, [browser(3)])]) }
    delete C.own
    // D: after a sleep - the wake's sample has no interval
    const D = minute([at(0, null, [browser(null)]), at(5000, 5, [browser(0.2)])])
    writeLog([
      line(hour + 60_000, 'sample', A), line(hour + 120_000, 'sample', B), line(hour + 180_000, 'sample', C), line(hour + 30 * 60_000, 'sample', D),
    ])
    const { report } = await build()
    // by hand: s = 10 + 2.5 + 1 = 13.5 over ms = 10 + 10 + 5 = 25 s measured, 5 + 5 = 10 s unmeasured: 0.54 cores;
    // the highest minute A's 10 / 10 = 1; RSS: A (100, 150, 160, 160: mean 142.5, n 4), B (140, 100, 100: 113.3333,
    // n 3), D (100, 100: n 2) - (570 + 340 + 200) / 9 = 123.3, max 160; C counted in minutesMissing only
    const row: HourRow = {
      hour, minutes: 4, minutesMissing: 1, ownCpu: 0.54, ownCpuMaxMinute: 1, measuredS: 25, unmeasuredS: 10,
      ownRssMB: { mean: 123.3, max: 160 }, canvasMemMB: 400, gpuRssMB: null, pressureMax: null, thermalWorst: 'nominal',
    }
    expect(report.samples.rows).toEqual([row])
  })

  it('hours apart, newest first; observed CPU is null with nothing measured, never zero', async () => {
    const own = (s: number, ms: number, unmeasuredMs: number, mean = 200) => ({ span: ms + unmeasuredMs, n: 12, own: { rssMB: { mean, max: mean, last: mean }, cpu: { s, ms, unmeasuredMs } } })
    writeLog([
      line(T0 + 10 * 60_000, 'sample', own(6, 60_000, 0)),
      line(T0 + HOUR + 60_000, 'sample', own(0, 0, 60_000)),           // a minute wholly unmeasured
      line(T0 + HOUR + 120_000, 'sample', { span: 60_000, n: 12 }),     // from before own
    ])
    const rows = (await build()).report.samples.rows
    expect(rows.map((r) => r.hour)).toEqual([T0 + HOUR, T0])
    expect(rows[0]).toMatchObject({ minutes: 2, minutesMissing: 1, ownCpu: null, ownCpuMaxMinute: null, measuredS: 0, unmeasuredS: 60, ownRssMB: { mean: 200, max: 200 } })
    expect(rows[1]).toMatchObject({ minutes: 1, minutesMissing: 0, ownCpu: 0.1, measuredS: 60, unmeasuredS: 0 })
  })

  it('pressure: the highest of 1, 2 and 4, else null; thermal the worst state, unknown with none known', async () => {
    writeLog([
      line(T0 + 1000, 'sample', { n: 1, pressure: { last: 1, max: 4 }, thermal: 'serious' }),
      line(T0 + 2000, 'sample', { n: 1, pressure: { last: 1, max: 2 }, thermal: 'critical' }),
      line(T0 + HOUR + 1000, 'sample', { n: 1, pressure: { last: null, max: 3 }, thermal: 'hot' }),
    ])
    const rows = (await build()).report.samples.rows
    expect(rows.map((r) => [r.pressureMax, r.thermalWorst])).toEqual([[null, 'unknown'], [4, 'critical']])
  })

  it('shown: each UTC day\'s n, p50 and p95 by nearest rank, newest day first', async () => {
    const day = Math.floor(T0 / DAY) * DAY
    writeLog([
      ...Array.from({ length: 20 }, (_, i) => line(day + 1000 + i, 'shown', { tab: 't1', ms: i + 1 })),
      line(day + DAY + 5, 'shown', { tab: 't1', ms: 7 }),
      line(day + DAY + 6, 'shown', { tab: 't1', ms: 'fast' }),   // not a number: not counted
    ])
    expect((await build()).report.shown.days).toEqual([{ day: day + DAY, n: 1, p50Ms: 7, p95Ms: 7 }, { day, n: 20, p50Ms: 10, p95Ms: 19 }])
    expect(nearestRank([1, 2, 3, 4], 50)).toBe(2)
    expect(nearestRank([1, 2, 3, 4], 95)).toBe(4)
  })
})

describe('privacy (A5.1 #27): nothing unlisted leaves', () => {
  it('secrets in dropped fields and in kept but ruled fields never reach the output', async () => {
    const S = 'SECRET'
    writeLog([
      line(T0, 'gone', { tab: 't1', ws: `/Users/nic/${S}-repo`, page: `${S} board`, origin: `https://${S}.example.com`, role: 'canvas', pid: 1, born: 1, reason: 'crashed', exitCode: 1, ours: false, pressure: null }),
      line(T0 + 1, 'main-error', { what: 'exception', name: `/Users/nic/${S}/x.ts`, message: `${S} message at https://${S}.example.com`, stack: [`at /Users/nic/${S}.js:1:1`] }),
      line(T0 + 2, 'flash', { tab: 't1', ws: S, page: S, via: 'key', recorder: false, thermal: 'nominal', pressure: null, agx: AGX, picture: `/Users/nic/.marver/perf/flashes/${S}.png`, id: S }),
      line(T0 + 3, 'child-gone', { type: 'Utility', name: `${S} Service`, reason: 'killed', exitCode: 15, ours: false, machineWide: false }),
      line(T0 + 4, 'gpu', { featureStatus: { [`${S}.example.com`]: 'enabled', webgl: `https://${S}.example.com`, webgl2: 'enabled' } }),
      line(T0 + 5, 'update', { phase: 'error', attempt: 1, message: `${S}: getaddrinfo ENOTFOUND github.com`, version: `${S}-1.0`, why: S }),
      line(T0 + 6, 'start', { version: `/Applications/${S}.app`, electron: `${S}`, chrome: S, recorder: true, pid: 7 }),
      line(T0 + 7, 'unresponsive', { tab: `${S}-tab`, role: S, pid: 1, born: 1 }),
      line(T0 + 8, 'sample', { n: 1, procs: [{ pid: 3, born: 3, type: 'utility', role: 'none', name: `${S} Helper`, tabs: [S] }], visible: { tab: 't1', ws: S, page: S }, canvases: { memMB: { max: 1 }, byTab: { [S]: {} } } }),
      line(T0 + 9, 'tab', { tab: 't1', ws: S, page: S, origin: S, state: S, view: S }),
      line(T0 + 10, `${S.toLowerCase()}-kind`, { secret: S }),
      line(T0 + 11, 'shown', { tab: S, ws: S, page: S, ms: 3 }),
    ])
    writeProfile(H1, { ...PROFILE, host: { ...PROFILE.host, chip: `Nic Touron ${S}`, model: `${S}1,1 x`, os: `${S}` }, gpu: { renderer: S }, displays: [{ id: 99, scaleFactor: 2, hz: 60, colorSpace: S }] })
    const { report, json } = await build()
    expect(json).not.toMatch(/secret/i)
    expect(json).not.toMatch(/Users|example\.com|github|Applications|\.png|Helper|Service|Nic Touron|ENOTFOUND/)
    // the envelope's launch id and profile hash never leave
    expect(json).not.toContain(APP)
    expect(json).not.toContain(H1)
    // the ruled values: other, or the key dropped and the value unknown
    const list = report.events.list
    expect(list.find((e) => e.kind === 'main-error')).toEqual({ ts: T0 + 1, kind: 'main-error', what: 'exception', name: 'other' })
    expect(list.find((e) => e.kind === 'gpu')).toEqual({ ts: T0 + 4, kind: 'gpu', featureStatus: { webgl: 'unknown', webgl2: 'enabled' } })
    expect(list.find((e) => e.kind === 'flash')).toMatchObject({ picture: true })
    expect(list.find((e) => e.kind === 'update')).toEqual({ ts: T0 + 5, kind: 'update', phase: 'error', version: 'other', why: 'other' })
    expect(list.find((e) => e.kind === 'start')).toEqual({ ts: T0 + 6, kind: 'start', version: 'other', electron: 'other', recorder: true })
    expect(list.find((e) => e.kind === 'unresponsive')).toEqual({ ts: T0 + 7, kind: 'unresponsive', tab: 'other', role: 'other' })
    expect(report.mac.rows[0]).toMatchObject({ chip: 'other', model: 'other', macos: 'other', displays: [{ scaleFactor: 2, displayFrequency: 60 }] })
    expect(report.events.unknown).toBe(1)
    expect(report.events.counts.tab).toBe(1)
  })

  it('a malicious record of every kind: planted fields, wrong types, nested extras - only listed fields, no secret', async () => {
    const S = 'SECRET'
    const plant = { secret: S, ws: S, page: S, origin: S, commit: 31337, pid: 31337, born: 31337, name: S, message: S, stack: [S], id: S, ring: { S }, now: { S }, gpuEvents: [S], observedAt: [31337], was: S, limit: 31337, chrome: S, attempt: 31337, epoch: 31337, gesture: 31337, pictureWhy: S, machineWide: S }
    const nested = { secret: S, pids: [31337], memMB: { S }, level: S, tab: S }
    const lines = APP_KINDS.map((k, i) => line(T0 + i, k, {
      ...plant, tab: S, role: S, reason: S, source: S, type: S, phase: S, why: S, via: S, cause: S, outcome: S, event: S, thermal: S, what: S,
      version: S, electron: S, from: S, to: S, recorder: S, ours: S, manual: S, pidGone: S, picture: { S },
      exitCode: '__INF__', availablePct: 'x', n: [1], ms: S, rateHz: S, frames: { S }, level: 3, pressure: { level: S },
      featureStatus: [S], agx: { ...nested, gpuSystemMemoryMB: S, allocMB: [S] }, before: nested, after: [nested],
      own: { secret: S, rssMB: S, cpu: { s: S } }, procs: [{ name: S }], visible: { ws: S }, canvases: { byTab: { [S]: S } },
    }).replace('"__INF__"', '1e999'))   // JSON has no Infinity: 1e999 parses as one
    writeLog(lines)
    writeProfile(H1, { v: 1, kind: 'app', host: { chip: S, cores: { total: S, p: S, e: [S], secret: S }, memGB: S, model: S, os: S, secret: S }, displays: [{ secret: S, hz: S, scaleFactor: S }, S], gpu: { renderer: S } })
    const { report, json } = await build()
    expect(json).not.toMatch(/secret/i)
    expect(json).not.toContain('31337')
    expect(json).not.toContain('Infinity')
    // every event carries only ts, kind and its projection's fields
    for (const e of report.events.list) {
      const allowed = new Set(['ts', 'kind', ...PROJECTIONS[e.kind].map(([k]) => k)])
      for (const k of Object.keys(e)) expect(allowed.has(k), `${e.kind}.${k}`).toBe(true)
    }
    // a string that fails its rule is other; a wrong type, an infinite number or a level not 1, 2 or 4 is dropped
    expect(report.events.list.find((e) => e.kind === 'gone')).toEqual({ ts: T0 + APP_KINDS.indexOf('gone'), kind: 'gone', tab: 'other', role: 'other', reason: 'other', source: 'other' })
    expect(report.events.list.find((e) => e.kind === 'unload-effect')).toEqual({ ts: T0 + APP_KINDS.indexOf('unload-effect'), kind: 'unload-effect', tab: 'other', reason: 'other', before: {} })
    expect(report.events.list.find((e) => e.kind === 'agx')).toEqual({ ts: T0 + APP_KINDS.indexOf('agx'), kind: 'agx' })
    expect(report.samples.rows[0]).toMatchObject({ minutes: 1, minutesMissing: 1, ownRssMB: { mean: null, max: null } })
    expect(report.mac.rows[0]).toEqual({ from: T0, to: T0 + APP_KINDS.length - 1, chip: 'other', cores: { total: undefined, p: 'other' }, model: 'other', macos: 'other', displays: [{}] })
  })

  it('tabs.ts\'s UnloadRefusal and the report\'s set are the same; every why the updater writes today is listed (held by the typecheck)', () => {
    type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    const same: Exact<(typeof UNLOAD_REFUSALS)[number], UnloadRefusal> = true
    expect(same).toBe(true)
    // update-model.ts's blocks and late events, and a move's whys: a new one is `other` until listed (A5.1 #25)
    const whys: readonly (typeof UPDATE_WHY)[number][] = [] as (BlockedWhy | 'throw' | 'error' | 'checking-for-update' | 'update-available' | 'update-not-available' | 'update-downloaded' | 'intent' | 'intent-old' | (typeof UPDATE_MOVE_WHY)[number])[]
    expect(whys).toEqual([])
    // updater.ts's #18 reconciliation records an intent it clears unshown as `late` with these (integration, 2 Nov)
    expect(UPDATE_WHY).toEqual(expect.arrayContaining(['intent', 'intent-old']))
    expect(GPU_FEATURES).toContain('webgl')
  })
})

describe('sources and bounds (A5.1 #26)', () => {
  it('the last 7 days, or fewer when keepPerfDays keeps fewer; lines outside skipped, a future one too', async () => {
    const start = NOW - 7 * DAY
    writeLog([
      line(start - 1, 'dropped', { n: 1 }), line(start, 'dropped', { n: 2 }), line(NOW, 'dropped', { n: 3 }), line(NOW + 1, 'dropped', { n: 4 }),
      // the envelope not first: parsed, then judged by its ts
      JSON.stringify({ kind: 'dropped', n: 5, v: 1, ts: NOW - 10, app: APP, seq: 99, flavour: 'release', machine: null }),
    ])
    const r = (await build()).report
    expect([r.start, r.end]).toEqual([start, NOW])
    expect(r.events.list.map((e) => e.n)).toEqual([3, 5, 2])
    expect(r.events.status).toBe('ok')
    expect((await build({ keepPerfDays: 3 })).report.start).toBe(NOW - 3 * DAY)
    expect((await build({ keepPerfDays: 3 })).report.events.list.map((e) => e.n)).toEqual([3, 5])
    expect([reportDays(30), reportDays(3), reportDays(1), reportDays('x'), reportDays(0), reportDays(2.6)]).toEqual([7, 3, 1, 7, 7, 3])
  })

  it('this flavour\'s log only: Marver Dev reads app-dev.jsonl', async () => {
    writeLog([line(T0, 'dropped', { n: 1 }, { flavour: 'release' })])
    writeLog([line(T0, 'dropped', { n: 2 }, { flavour: 'dev' })], 'app-dev.jsonl')
    expect((await build({ flavour: 'dev' })).report.events.list.map((e) => e.n)).toEqual([2])
    expect((await build({ flavour: 'dev' })).report.flavour).toBe('dev')
  })

  it('at most 2,000 events, the newest first; the rest counted as cut, the section partial', async () => {
    writeLog(Array.from({ length: 2500 }, (_, i) => line(T0 + i, 'dropped', { n: i })))
    const r = (await build()).report
    expect(r.events.list).toHaveLength(REPORT_EVENTS_MAX)
    expect(r.events.list[0]!.n).toBe(2499)
    expect(r.events.list.at(-1)!.n).toBe(500)
    expect(r.events).toMatchObject({ cut: 500, status: 'partial', counts: { dropped: 2500 } })
  })

  it('at most 2 MB: the oldest events go first, counted', async () => {
    const all = Object.fromEntries(GPU_FEATURES.map((k) => [k, 'unavailable_software']))
    writeLog(Array.from({ length: 2000 }, (_, i) => line(T0 + i, 'gpu', { featureStatus: all })))
    const { report, json } = await build()
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(REPORT_MAX_BYTES)
    expect(report.events.cut).toBeGreaterThan(0)
    expect(report.events.list.length + report.events.cut).toBe(2000)
    expect(report.events.list[0]!.ts).toBe(T0 + 1999)
    expect(report.events.status).toBe('partial')
  })
})

describe('each section says how it was read (A5.1 #26): never silently empty', () => {
  it('nothing there: every section missing', async () => {
    const r = (await build({ perfDir: join(base, 'none') })).report
    expect([r.mac.status, r.samples.status, r.shown.status, r.events.status, r.crashpad.status]).toEqual(['missing', 'missing', 'missing', 'missing', 'missing'])
  })

  it('a log that cannot be read, a crashpad that is no folder, a profile that is no JSON: unreadable', async () => {
    mkdirSync(join(perf, 'app.jsonl'))
    writeFileSync(join(perf, 'crashpad'), 'x')
    const r = (await build()).report
    expect([r.samples.status, r.shown.status, r.events.status, r.crashpad.status, r.mac.status]).toEqual(['unreadable', 'unreadable', 'unreadable', 'unreadable', 'unreadable'])
    rmSync(join(perf, 'app.jsonl'), { recursive: true })
    writeLog([line(T0, 'dropped', { n: 1 }, { machine: H3 })])
    writeProfile(H3, '{ not json')
    expect((await build()).report.mac).toMatchObject({ status: 'unreadable', unparsed: 1, rows: [] })
  })

  it('torn and garbage lines counted by the kind they still name; a missing profile beside a good one: partial', async () => {
    const torn = line(T0 + 2, 'sample', { n: 1, span: 60_000 })
    writeLog([
      line(T0, 'dropped', { n: 1 }),
      torn.slice(0, torn.length - 10),                                         // a sample line cut short
      'not json at all',
      line(T0 + 3, 'gone', { role: 'canvas' }, { app: 'NOT-AN-ID' }),          // a bad envelope
      line(T0 + 4, 'shown', { ms: 1 }).slice(0, 60),
      line(T0 + 5, 'dropped', { n: 2 }, { machine: H2 }),                        // its profile has no file
      line(T0 + 6, 'a-later-kind', { n: 9 }),
    ])
    writeProfile(H1, PROFILE)
    const r = (await build()).report
    expect(r.samples).toMatchObject({ status: 'partial', unparsed: 1, lines: 0 })
    expect(r.shown).toMatchObject({ status: 'partial', unparsed: 1 })
    expect(r.events).toMatchObject({ status: 'partial', unparsed: 2, unknown: 1, counts: { dropped: 2 } })
    expect(r.mac).toMatchObject({ status: 'partial', absent: 1, unparsed: 0 })
    expect(r.mac.rows).toHaveLength(1)
  })

  it('lines that name no profile: the Mac missing, never empty and ok; an empty log: ok, with its counts', async () => {
    writeLog([line(T0, 'dropped', { n: 1 }, { machine: null })])
    expect((await build()).report.mac).toMatchObject({ status: 'missing', rows: [] })
    writeFileSync(join(perf, 'app.jsonl'), '')
    const r = (await build()).report
    expect(r.events).toMatchObject({ status: 'ok', counts: {}, list: [] })
    expect(r.samples).toMatchObject({ status: 'ok', lines: 0, rows: [] })
  })

  it('two profiles alike (a launch on each) give one Mac; another display gives a second row, the newest first', async () => {
    writeProfile(H1, PROFILE)
    writeProfile(H2, { ...PROFILE, hostHash: 'another' })
    writeProfile(H3, { ...PROFILE, displays: [...PROFILE.displays, { internal: false, scaleFactor: 1, hz: 60 }] })
    writeLog([line(T0, 'dropped', { n: 1 }, { machine: H1 }), line(T0 + 1, 'dropped', { n: 1 }, { machine: H2 }), line(T0 + 2, 'dropped', { n: 1 }, { machine: H3 })])
    const rows: MacRow[] = (await build()).report.mac.rows
    expect(rows.map((x) => [x.from, x.to, x.displays.length])).toEqual([[T0 + 2, T0 + 2, 2], [T0, T0 + 1, 1]])
  })
})

describe('the export (A5.1 #28)', () => {
  const ports = (answer: string | null | (() => Promise<string | null>), o: Partial<ExportPorts> = {}) => {
    const calls = { panels: [] as string[], shown: [] as string[], alerts: [] as { message: string; detail: string }[], flushed: 0 }
    const p: ExportPorts = {
      savePanel: async (d) => { calls.panels.push(d); return typeof answer === 'function' ? answer() : answer },
      showItem: (f) => { calls.shown.push(f) },
      alert: (message, detail) => { calls.alerts.push({ message, detail }) },
      flush: async () => { calls.flushed += 1 },
      downloads: () => join(base, 'Downloads'),
      input: () => input(),
      ...o,
    }
    return { p, calls }
  }
  const leftovers = (dir: string) => (existsSync(dir) ? readdirSync(dir) : [])

  it('a save panel on ~/Downloads/Marver-report-YYYY-MM-DD.json, the person\'s own date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 2, 23, 30))
    const { p, calls } = ports(null)
    expect(await exportReport(p)).toEqual({ result: 'cancelled' })
    expect(calls.panels).toEqual([join(base, 'Downloads', 'Marver-report-2026-11-02.json')])
    expect(reportName(new Date(2027, 0, 5, 0, 1).getTime())).toBe('Marver-report-2027-01-05.json')
  })

  it('cancelled: nothing made, nothing written, nothing shown', async () => {
    const { p, calls } = ports(null)
    await exportReport(p)
    expect(calls).toMatchObject({ shown: [], alerts: [], flushed: 0 })
  })

  it('a path chosen: the log flushed, the report written whole, then shown in Finder', async () => {
    writeLog([line(T0, 'dropped', { n: 1 })])
    writeProfile(H1, PROFILE)
    const out = join(base, 'chosen.json')
    const { p, calls } = ports(out)
    const r = await exportReport(p)
    const text = readFileSync(out, 'utf8')
    expect(r).toEqual({ result: 'saved', file: out, bytes: Buffer.byteLength(text) })
    expect(text).toBe((await build()).json)
    expect(calls).toMatchObject({ shown: [out], alerts: [], flushed: 1 })
    // a file of that name is replaced whole (the panel asked first)
    writeFileSync(out, 'old')
    expect((await exportReport(ports(out).p)).result).toBe('saved')
    expect(readFileSync(out, 'utf8')).toBe(text)
    expect(leftovers(base).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('a folder gone, one it cannot write, a full disk: an alert says why and no file is left, half-written or whole', async () => {
    const gone = ports(join(base, 'gone', 'r.json'))
    expect(await exportReport(gone.p)).toEqual({ result: 'failed', stage: 'write', code: 'ENOENT' })
    expect(gone.calls.alerts).toEqual([{ message: REPORT_FAILED, detail: failureDetail('write', 'ENOENT') }])
    expect(gone.calls.shown).toEqual([])

    mkdirSync(join(base, 'locked'))
    chmodSync(join(base, 'locked'), 0o500)
    const locked = ports(join(base, 'locked', 'r.json'))
    expect(await exportReport(locked.p)).toMatchObject({ result: 'failed', code: 'EACCES' })
    expect(locked.calls.alerts[0]!.detail).toBe('Marver can\'t write to that folder. Choose another one.')
    expect(leftovers(join(base, 'locked'))).toEqual([])

    mkdirSync(join(base, 'full'))
    faults.inject({ match: 'full/r\\.json$', code: 'ENOSPC', at: 'write' })
    const full = ports(join(base, 'full', 'r.json'))
    expect(await exportReport(full.p)).toMatchObject({ result: 'failed', code: 'ENOSPC' })
    expect(full.calls.alerts[0]!.detail).toBe('The disk is full. Free some space, then export it again.')
    expect(leftovers(join(base, 'full'))).toEqual([])
  })

  it('a report that cannot be made says so with its code alone, never an error\'s text', async () => {
    const { p, calls } = ports(join(base, 'r.json'), { input: () => { throw new Error('boom at /Users/nic/SECRET') } })
    expect(await exportReport(p)).toEqual({ result: 'failed', stage: 'make', code: 'ERROR' })
    expect(calls.alerts[0]!.detail).not.toMatch(/SECRET|Users|boom/)
    expect(existsSync(join(base, 'r.json'))).toBe(false)
  })

  it('one at a time: another while one runs does nothing', async () => {
    let answer!: (v: string | null) => void
    const first = ports(() => new Promise((r) => { answer = r }))
    const running = exportReport(first.p)
    const second = ports(join(base, 'second.json'))
    expect(await exportReport(second.p)).toEqual({ result: 'busy' })
    expect(second.calls.panels).toEqual([])
    answer(join(base, 'first.json'))
    expect((await running).result).toBe('saved')
    expect((await exportReport(second.p)).result).toBe('saved')
  })

  it('offered on the latched crashed page only, beside Copy Details (tabpage.ts pageOffers)', () => {
    const crashed = (latched: boolean) => ({ page: 'crashed', latched, name: 'T', since: 0 }) as PageBody
    expect(pageOffers(crashed(true), false)).toEqual(['reload', 'copy-details', 'export-report'])
    expect(pageOffers(crashed(true), true)).toContain('export-report')
    expect(pageOffers(crashed(false), false)).toEqual([])
    for (const b of [
      { page: 'stopped', retained: true, probe: { state: 'none', lastAt: null }, command: 'x', name: 'T', since: 0 },
      { page: 'unreachable', retained: false, probe: { state: 'none', lastAt: null }, origin: 'http://localhost:1', name: 'T', since: 0 },
      { page: 'starting', phase: 'starting', name: 'T', since: 0 },
    ]) expect(pageOffers(b as PageBody, false)).not.toContain('export-report')
  })
})
