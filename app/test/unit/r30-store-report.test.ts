/**
 * Spec 30 #44, #56: samples moved to their own file, rows unchanged, read back through every reader as they were. A
 * log written the 1.0.0 way (samples in app.jsonl, one file) and the same lines the 1.0.1 way (samples.jsonl, closed
 * segments of both files) give PerfReport v1 byte for byte the same, and the CPU gate's evidence the same figure;
 * `launch`, `cmd` and `window` lines are counted, never exported.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAppLine, SAMPLE_KINDS } from '../../../src/shared/app-perf.ts'
import { segmentName, type SegmentedFile } from '../../../src/shared/perf-records.ts'
import { appLogFiles } from '../../../src/server/perf-segments.ts'
import { buildReport, type ReportInput } from '../../src/main/report.ts'
import { releaseEvidence } from '../budgets/evidence.ts'

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const MIN = 60_000, HOUR = 3_600_000
const H1 = '0123456789abcdef', APP = 'a1b2c3d4e5f6'
let seq = 0
const line = (ts: number, kind: string, body: Record<string, unknown> = {}) => JSON.stringify({ v: 1, ts, kind, app: APP, seq: seq++, flavour: 'release', machine: H1, ...body })
const agg = (v: number) => ({ mean: v, max: v, last: v })
const sample = (ts: number, canvasCpu: number) => line(ts, 'sample', {
  span: MIN, n: 12,
  procs: [
    { pid: 100, born: 1, type: 'browser', role: 'none', tabs: [], rssMB: agg(200), cpu: agg(0.01), cpuTime: { s: 0.6, ms: MIN } },
    { pid: 200, born: 5, type: 'renderer', role: 'canvas', tabs: ['t1'], rssMB: agg(800), cpu: agg(canvasCpu), cpuTime: { s: canvasCpu * 60, ms: MIN } },
  ],
  gpu: { pid: 101, born: 1, cpu: agg(0.02), gpuProcessRssMB: agg(500) },
  canvases: { memMB: agg(800), byTab: { t1: { memMB: agg(800), cpu: agg(canvasCpu) } } }, visible: null, sys: null, spawnMs: 12,
  own: { rssMB: agg(400), cpu: { s: 1, ms: MIN, unmeasuredMs: 0 } },
})

/** A launch's lines over two hours: events, samples every minute, agx, the new kinds. */
function launchLines(): string[] {
  seq = 0
  const t0 = NOW - 3 * HOUR
  const out = [line(t0, 'start', { version: '1.0.1', electron: '45.0.0', chrome: '142', recorder: true, pid: 100 })]
  out.push(line(t0 + 1000, 'tab', { tab: 't1', ws: 'ab'.repeat(8), commit: 1, page: 'p1', state: 'ready', active: true, view: 'live', main: { pid: 200, born: 5 } }))
  out.push(line(t0 + 2000, 'launch', { readyMs: 200, windowShownMs: 300, tabs: { restored: 1, local: 1, remote: 0, active: 'local' } }))
  for (let m = 1; m <= 120; m++) {
    out.push(sample(t0 + m * MIN, 0.001 * (1 + m % 3)))
    if (m % 2 === 0) out.push(line(t0 + m * MIN + 5, 'agx', { gpuSystemMemoryMB: 100 + m, allocMB: 1, utilPct: 3, rendererPct: 4, tilerPct: 5, recoveryCount: 0, machineWide: true }))
    if (m % 30 === 0) out.push(line(t0 + m * MIN + 10, 'shown', { tab: 't1', ms: 40 + m }))
    if (m % 40 === 0) out.push(line(t0 + m * MIN + 20, 'cmd', { phase: 'once', id: 'aaaaaaaaaaaa', cmd: 'reload', via: 'key', in: 'main', outcome: 'done', ms: 2 }))
  }
  out.push(line(t0 + 121 * MIN, 'window', { event: 'minimize', cause: 'unknown' }))
  return out
}

let base = ''
const dir = (name: string) => { const d = join(base, name); mkdirSync(join(d, 'machine'), { recursive: true }); return d }
const input = (perfDir: string): ReportInput => ({ perfDir, flavour: 'release', keepPerfDays: 14, now: NOW, version: '1.0.1', electron: '45.0.0', macos: '26.1' })
const isSample = (l: string) => (SAMPLE_KINDS as readonly string[]).includes((JSON.parse(l) as { kind: string }).kind)
const write = (f: string, ls: string[]) => writeFileSync(f, ls.join('\n') + '\n')

/** The same lines as 1.0.1 leaves them: samples apart, both files cut into closed segments and a live file. */
function newFormat(d: string, lines: string[]) {
  const app = lines.filter((l) => !isSample(l)), samples = lines.filter(isSample)
  const cut = (name: SegmentedFile, ls: string[]) => {
    const third = Math.floor(ls.length / 3)
    const ts = (l: string) => (JSON.parse(l) as { ts: number }).ts
    write(join(d, segmentName(name, ts(ls[0]!), ts(ls[third - 1]!))), ls.slice(0, third))
    write(join(d, segmentName(name, ts(ls[third]!), ts(ls[2 * third - 1]!))), ls.slice(third, 2 * third))
    write(join(d, name), ls.slice(2 * third))
  }
  cut('app.jsonl', app)
  cut('samples.jsonl', samples)
}

beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-r30-report-'))) })
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('PerfReport v1 over the new files (#56)', () => {
  it('new-format samples give the same report, byte for byte, as the same lines in one app.jsonl', async () => {
    const lines = launchLines()
    const one = dir('one'), two = dir('two')
    write(join(one, 'app.jsonl'), lines)
    newFormat(two, lines)
    expect(readdirSync(two).filter((f) => f.startsWith('samples.'))).toHaveLength(3)
    const a = await buildReport(input(one)), b = await buildReport(input(two))
    expect(b.report.samples.rows.length).toBeGreaterThan(0)
    expect(b.json).toBe(a.json)
  })

  it('launch, cmd and window lines are counted, never exported, until a report v2', async () => {
    const lines = launchLines()
    const two = dir('two')
    newFormat(two, lines)
    const { report, json } = await buildReport(input(two))
    expect(report.events.counts.launch).toBe(1)
    expect(report.events.counts.cmd).toBe(3)
    expect(report.events.counts.window).toBe(1)
    expect(json).not.toContain('"readyMs"')
    expect(json).not.toContain('"phase"')
  })

  it('a log with no files at all is `missing`; a samples file alone is read', async () => {
    const d = dir('none')
    expect((await buildReport(input(d))).report.samples.status).toBe('missing')
    const lines = launchLines().filter(isSample)
    write(join(d, 'samples.jsonl'), lines)
    const r = (await buildReport(input(d))).report
    expect(r.samples.status).toBe('ok')
    expect(r.samples.rows.length).toBeGreaterThan(0)
  })
})

describe('the CPU gate\'s evidence over either file (#44)', () => {
  it('computes the same canvases and the same figure from one app.jsonl as from both files, every segment, merged by app and seq', () => {
    const lines = launchLines()
    const one = dir('one'), two = dir('two')
    write(join(one, 'app.jsonl'), lines)
    newFormat(two, lines)
    const read = (d: string) => appLogFiles(d, 'release').flatMap((f) => readFileSync(f, 'utf8').split('\n')).map((l) => parseAppLine(l)).filter(Boolean)
    const from = NOW - 3 * HOUR + 60 * MIN + 5000, to = from + 5 * MIN
    const a = releaseEvidence(read(one) as never, from, to, 'release'), b = releaseEvidence(read(two) as never, from, to, 'release')
    if (a.why !== undefined) throw new Error(a.why)
    expect(b).toEqual(a)
    expect(a.canvas).toContainEqual({ pid: 200, born: 5 })
  })

  it('a seq gap in either file is still seen: a sample line lost from samples.jsonl makes the window inconclusive', () => {
    const lines = launchLines()
    const two = dir('two')
    newFormat(two, lines)
    const read = appLogFiles(two, 'release').flatMap((f) => readFileSync(f, 'utf8').split('\n')).map((l) => parseAppLine(l)).filter(Boolean)
    const from = NOW - 3 * HOUR + 60 * MIN + 5000, to = from + 5 * MIN
    const lost = read.filter((r) => !(r!.kind === 'agx' && r!.ts > from && r!.ts < to))
    expect(releaseEvidence(lost as never, from, to, 'release').why).toMatch(/seq gap/)
  })
})
