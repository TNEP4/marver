/**
 * Spec 30 R9 (#42-#45), the Mac app's writer, on a temporary MARVER_HOME: `sample` and `agx` lines in their own file
 * with one `seq` across both; each file a live file plus closed segments, closed by size and by age, named with a
 * conservative newest bound and deleted whole once it is keepPerfDays old, without a read; the safety cap's counted
 * drop; 1.0.0's file closed as a segment at the first 1.0.1 launch and left to retention by the cap; a failed append
 * to one file not costing the other; and the machine-profile pass reading every segment of both files.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config, Home } from '../../src/main/config.ts'
import { APP_LOG, parseAppLine } from '../../../src/shared/app-perf.ts'
import { parseSegmentName, SEGMENTS, segmentName } from '../../../src/shared/perf-records.ts'
import { appLogFiles } from '../../../src/server/perf-segments.ts'

type Perflog = typeof import('../../src/main/perflog.ts')
let base: string
let home: Home
let L: Perflog
const DAY = 86_400_000
const H1 = '0123456789abcdef'
const config = (o: Partial<Config> = {}): Config => ({ restoreTabs: true, unloadUnderPressure: true, recorder: true, dockBadge: false, keepPerfDays: 14, ...o })
const perf = () => join(home.dir, 'perf')
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [])
const segs = (name: string) => (existsSync(perf()) ? readdirSync(perf()).filter((f) => f.startsWith(`${name}.`) && f !== `${name}.jsonl`).sort() : [])
const start = (o: Partial<Config> = {}) => L.startPerflog({ home, flavour: 'release', config: () => config(o), machine: () => H1 })
const old = (seq: number, ts: number, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, ts, kind: 'dropped', app: 'aaaaaaaaaaaa', seq, flavour: 'release', machine: H1, n: seq, ...extra })
const SAMPLE = { n: 12 } as never
const AGX = { gpuSystemMemoryMB: 1, allocMB: 2, utilPct: 3, rendererPct: 4, tilerPct: 5, recoveryCount: 0, machineWide: true as const }

beforeEach(async () => {
  vi.resetModules()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-r30-')))
  home = { dir: join(base, 'home'), writable: true, state: join(base, 'home', 'state'), crashpad: join(base, 'home', 'perf', 'crashpad'), ms: 0 }
  mkdirSync(home.dir, { recursive: true, mode: 0o700 })
  L = await import('../../src/main/perflog.ts')
})
afterEach(async () => {
  await L.idle()
  L.resetPerflog()
  rmSync(base, { recursive: true, force: true })
})

describe('samples get their own file, unchanged (#44)', () => {
  it('sample and agx go to samples.jsonl, everything else to app.jsonl; one seq per launch runs across both', () => {
    start()
    L.append('start', { version: '1.0.1', electron: '45', chrome: '142', recorder: true, pid: 1 })
    L.append('sample', SAMPLE)
    L.append('dropped', { n: 0 })
    L.append('agx', AGX)
    L.append('sample', SAMPLE)
    expect(L.flushNow()).toBe(true)
    const app = lines(L.appLogFile(home, 'release')).map((l) => parseAppLine(l)!)
    const sam = lines(L.samplesLogFile(home, 'release')).map((l) => parseAppLine(l)!)
    expect(app.map((r) => [r.seq, r.kind])).toEqual([[0, 'start'], [2, 'dropped']])
    expect(sam.map((r) => [r.seq, r.kind])).toEqual([[1, 'sample'], [3, 'agx'], [4, 'sample']])
    expect(new Set([...app, ...sam].map((r) => r.app))).toEqual(new Set([L.launchId()]))
    expect(statSync(L.samplesLogFile(home, 'release')).mode & 0o777).toBe(0o600)
  })

  it('Marver Dev writes samples-dev.jsonl; a row keeps every field as it was given', () => {
    L.startPerflog({ home, flavour: 'dev', config: () => config(), machine: () => H1 })
    const row = { procs: [{ pid: 7, born: 1700000000000.5, rssMB: { min: 1, mean: 2, max: 3 }, cpu: { min: 0, mean: 0.5, max: 1 } }], n: 12, dtMs: 60_000 }
    L.append('sample', row as never)
    L.flushNow()
    const [r] = lines(join(perf(), 'samples-dev.jsonl')).map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(r!.procs).toEqual(row.procs)
    expect(existsSync(join(perf(), 'samples.jsonl'))).toBe(false)
  })

  it('a failed append to one file does not cost the other: its lines wait for the next flush, nothing lost or doubled', () => {
    start()
    L.append('dropped', { n: 1 })
    L.append('sample', SAMPLE)
    // the first file written (app.jsonl) lands nothing; samples.jsonl goes on
    L.failAppendAfter(0)
    expect(L.flushNow()).toBe(false)
    expect(lines(L.appLogFile(home, 'release'))).toEqual([])
    expect(lines(L.samplesLogFile(home, 'release'))).toHaveLength(1)
    expect(L.flushNow()).toBe(true)
    expect(lines(L.appLogFile(home, 'release')).map((l) => parseAppLine(l)!.seq)).toEqual([0])
    expect(lines(L.samplesLogFile(home, 'release')).map((l) => parseAppLine(l)!.seq)).toEqual([1])
  })
})

describe('segments (#42)', () => {
  it('a file closes by size, a rename, right after the append that passes it; every line stays readable', () => {
    start()
    const pad = 'x'.repeat(4000)
    const seg = SEGMENTS['app.jsonl'].segmentBytes
    let n = 0
    while (!segs('app').length && n < 5000) { L.append('dropped', { n: n++, pad } as never); L.flushNow() }
    const [name] = segs('app')
    const size = statSync(join(perf(), name!)).size
    expect(size).toBeGreaterThanOrEqual(seg)
    expect(size - size / n).toBeLessThan(seg)
    expect(existsSync(L.appLogFile(home, 'release'))).toBe(false)
    L.append('dropped', { n: -1 })
    L.flushNow()
    const all = appLogFiles(perf(), 'release').flatMap((f) => lines(f)).map((l) => (JSON.parse(l) as { n: number }).n)
    expect(all).toEqual([...Array(n).keys(), -1])
  })

  it('a file closes before an append once it was opened 24 h ago; its bound is the later of the close and its largest ts', () => {
    let now = Date.now()
    const t0 = now
    L.setPerflogClock(() => now)
    start()
    L.append('dropped', { n: 1 })
    L.flushNow()
    now = t0 + DAY - 1
    L.append('dropped', { n: 2 })
    L.flushNow()
    expect(segs('app')).toEqual([])
    now = t0 + DAY + 1
    L.append('dropped', { n: 3 })
    L.flushNow()
    expect(segs('app')).toHaveLength(1)
    const p = parseSegmentName('app.jsonl', segs('app')[0]!)!
    expect(p.openedAt).toBe(t0)
    expect(p.bound).toBe(t0 + DAY + 1)
    expect(lines(L.appLogFile(home, 'release')).map((l) => (JSON.parse(l) as { n: number }).n)).toEqual([3])
  })

  it('retention unlinks a segment past keepPerfDays without reading it; a segment within them stays, whatever its lines\' times say', async () => {
    const now = Date.now()
    mkdirSync(perf(), { recursive: true, mode: 0o700 })
    const gone = join(perf(), segmentName('samples.jsonl', now - 20 * DAY, now - 14 * DAY - 1))
    const kept = join(perf(), segmentName('samples.jsonl', now - 20 * DAY + 1, now - 14 * DAY + 60_000))
    writeFileSync(gone, old(0, now - 20 * DAY) + '\n')
    writeFileSync(kept, old(1, now - 20 * DAY) + '\n')   // old lines, a recent bound: a later event time in it, or an adopted file
    chmodSync(gone, 0o000)                               // unreadable: an unlink needs no read
    start()
    const r = await L.prune()
    expect(existsSync(gone)).toBe(false)
    expect(existsSync(kept)).toBe(true)
    expect(r.segments).toBeGreaterThanOrEqual(1)
  })

  it('keepPerfDays applies live, and retention also runs hourly in the flush\'s own turn', async () => {
    let now = Date.now()
    const t0 = now
    L.setPerflogClock(() => now)
    mkdirSync(perf(), { recursive: true, mode: 0o700 })
    let days = 14
    L.startPerflog({ home, flavour: 'release', config: () => config({ keepPerfDays: days }), machine: () => H1 })
    await L.prune()                                       // the launch's pass
    const seg = join(perf(), segmentName('app.jsonl', t0 - 10 * DAY, t0 - 8 * DAY))
    writeFileSync(seg, old(0, t0 - 10 * DAY) + '\n')
    days = 7
    now = t0 + 30 * 60_000
    L.flushNow()
    expect(existsSync(seg)).toBe(true)                    // not an hour yet
    now = t0 + 61 * 60_000
    L.flushNow()
    expect(existsSync(seg)).toBe(false)
  })

  it('the safety cap (#43): past it the oldest segments go, and a counted dropped line in that file says how many lines', async () => {
    const now = Date.now()
    mkdirSync(perf(), { recursive: true, mode: 0o700 })
    start()
    L.append('dropped', { n: 1 })                         // the samples file exists from here: see the 1.0.0 case
    L.append('sample', SAMPLE)
    L.flushNow()
    const line = old(0, now, { pad: 'p'.repeat(1000) }) + '\n'
    const per = Math.ceil(5 * 2 ** 20 / line.length)      // 5 MB a segment, 4 of them past the app file's 16 MB
    for (let i = 0; i < 4; i++) writeFileSync(join(perf(), segmentName('app.jsonl', now + i + 1, now + i + 2)), line.repeat(per))
    await L.prune()
    L.flushNow()
    expect(segs('app')).toHaveLength(3)
    const dropped = appLogFiles(perf(), 'release').flatMap((f) => lines(f)).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.reason === 'retention-cap')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatchObject({ kind: 'dropped', n: per, reason: 'retention-cap', app: L.launchId() })
  })
})

describe('the last flush (#43)', () => {
  it('a close at quit that trips the cap writes its counted line in the same flush', () => {
    const now = Date.now()
    mkdirSync(perf(), { recursive: true, mode: 0o700 })
    start()
    L.append('sample', SAMPLE)                            // this version's first samples line: the app file's cap applies from here
    L.flushNow()
    const line = old(0, now, { pad: 'p'.repeat(1000) }) + '\n'
    const per = Math.ceil(5 * 2 ** 20 / line.length)
    for (let i = 0; i < 3; i++) writeFileSync(join(perf(), segmentName('app.jsonl', now + i + 1, now + i + 2)), line.repeat(per))
    // past the app file's segment size in one append: it closes, and 4 segments of 5 MB pass its 16 MB
    L.append('dropped', { n: 1, pad: 'x'.repeat(5 * 2 ** 20) } as never)
    L.flushSync()
    const said = appLogFiles(perf(), 'release').flatMap((f) => lines(f)).filter((l) => l.includes('"retention-cap"'))
    expect(said).toHaveLength(1)
  })
})

describe('migration (#45)', () => {
  it('1.0.0\'s app.jsonl is closed as a segment at the first 1.0.1 launch: openedAt its first line\'s ts, bound its mtime + 24 h, nothing rewritten', () => {
    mkdirSync(perf(), { recursive: true, mode: 0o700 })
    const now = Date.now(), first = now - 3 * DAY
    const text = old(0, first) + '\n' + old(1, now - DAY) + '\n'
    const f = join(perf(), APP_LOG.release)
    writeFileSync(f, text, { mode: 0o600 })
    const m = new Date(now - DAY)
    utimesSync(f, m, m)
    start()
    expect(segs('app')).toEqual([segmentName('app.jsonl', first, Math.ceil(statSync(join(perf(), segs('app')[0]!)).mtimeMs + DAY))])
    expect(statSync(join(perf(), segs('app')[0]!)).mtimeMs).toBeCloseTo(m.getTime(), -2)
    expect(readFileSync(join(perf(), segs('app')[0]!), 'utf8')).toBe(text)
    expect(existsSync(f)).toBe(false)
  })

  it('a live file younger than a day is adopted: this launch appends to it, on a line of its own after a torn end', () => {
    mkdirSync(perf(), { recursive: true, mode: 0o700 })
    const now = Date.now()
    writeFileSync(L.appLogFile(home, 'release'), old(0, now - 3_600_000) + '\n{"v":1,"ts":17,"kind":"sam', { mode: 0o600 })
    start()
    expect(segs('app')).toEqual([])
    L.append('dropped', { n: 9 })
    L.flushNow()
    expect(lines(L.appLogFile(home, 'release')).map((l) => parseAppLine(l)?.seq ?? 'torn')).toEqual([0, 'torn', 0])
  })

  it('the app file\'s cap leaves 1.0.0\'s segment - samples and all, up to 28 MB - to retention', async () => {
    const now = Date.now()
    mkdirSync(perf(), { recursive: true, mode: 0o700 })
    const line = old(0, now - 3 * DAY, { pad: 'p'.repeat(1000) }) + '\n'
    writeFileSync(L.appLogFile(home, 'release'), line.repeat(Math.ceil(28 * 2 ** 20 / line.length)), { mode: 0o600 })
    start()
    L.append('sample', SAMPLE)
    L.append('dropped', { n: 1 })
    L.flushNow()
    await L.prune()
    L.flushNow()
    expect(segs('app')).toHaveLength(1)                   // not gone, though past the app file's 16 MB
    expect(appLogFiles(perf(), 'release').flatMap((f) => lines(f)).filter((l) => l.includes('retention-cap'))).toEqual([])
  })
})

describe('the machine-profile pass reads every segment of both files (#44)', () => {
  it('a profile named only by a samples segment, or by the other flavour\'s, stays; an unnamed old one goes', async () => {
    const now = Date.now()
    const machine = join(perf(), 'machine')
    mkdirSync(machine, { recursive: true, mode: 0o700 })
    const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb', C = 'cccccccccccccccc', D = 'dddddddddddddddd'
    for (const h of [A, B, C, D]) { const p = join(machine, `${h}.json`); writeFileSync(p, JSON.stringify({ v: 1, kind: 'app' }), { mode: 0o600 }); const t = new Date(now - 30 * DAY); utimesSync(p, t, t) }
    writeFileSync(join(perf(), segmentName('samples.jsonl', now - 2 * DAY, now - DAY)), JSON.stringify({ v: 1, ts: now - 2 * DAY, kind: 'sample', machine: A }) + '\n')
    writeFileSync(join(perf(), segmentName('app-dev.jsonl', now - 2 * DAY, now - DAY)), JSON.stringify({ v: 1, ts: now - 2 * DAY, kind: 'tab', machine: B }) + '\n')
    writeFileSync(join(perf(), 'samples-dev.jsonl'), JSON.stringify({ v: 1, ts: now - DAY, kind: 'agx', machine: C }) + '\n')
    start()
    await L.idle()
    expect(readdirSync(machine).sort()).toEqual([`${A}.json`, `${B}.json`, `${C}.json`])
  })
})
