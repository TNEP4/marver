/**
 * The app's JSONL writer and its retention (spec 28 A3.6, A3.7, A3.8 #12), on a temporary MARVER_HOME: one writer
 * per file (the release app.jsonl, Marver Dev app-dev.jsonl), folders 700 and files 600, the envelope, the hold for
 * the machine's first hash, the 2,000-line bound and its `dropped` line, an ENOSPC that loses no earlier line,
 * rotation past 5 MB to the newest half of whole lines, and retention at launch: old lines, the newest 50 pictures,
 * the newest 10 completed Crashpad reports (each under its lock; new/ and settings.dat untouched; a locked one
 * skipped), machine profiles kept while a retained line names them.
 */
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config, Home } from '../../src/main/config.ts'
import { parseAppLine } from '../../../src/shared/app-perf.ts'

type Perflog = typeof import('../../src/main/perflog.ts')
let base: string
let home: Home
let L: Perflog
const DAY = 86_400_000
const H1 = '0123456789abcdef'

const config = (o: Partial<Config> = {}): Config => ({ restoreTabs: true, unloadUnderPressure: true, recorder: true, dockBadge: false, keepPerfDays: 14, ...o })
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [])
const mode = (p: string) => statSync(p).mode & 0o777

beforeEach(async () => {
  vi.resetModules()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-perflog-')))
  home = { dir: join(base, 'home'), writable: true, state: join(base, 'home', 'state'), crashpad: join(base, 'home', 'perf', 'crashpad'), ms: 0 }
  mkdirSync(home.dir, { recursive: true, mode: 0o700 })
  L = await import('../../src/main/perflog.ts')
})
afterEach(async () => {
  vi.useRealTimers()
  await L.idle()
  L.resetPerflog()
  rmSync(base, { recursive: true, force: true })
})

describe('the writer (A3.8 #12)', () => {
  it('the first line makes perf/ 700 and app.jsonl 600; every line has the envelope, seq contiguous from 0', async () => {
    L.startPerflog({ home, flavour: 'release', config: () => config(), machine: () => H1 })
    L.append('start', { version: '0.2.0', electron: '45.0.0', chrome: '142', recorder: true, pid: 1 })
    L.append('dropped', { n: 0 })
    expect(L.flushNow()).toBe(true)
    const f = join(home.dir, 'perf', 'app.jsonl')
    expect(mode(join(home.dir, 'perf'))).toBe(0o700)
    expect(mode(f)).toBe(0o600)
    const recs = lines(f).map((l) => parseAppLine(l))
    expect(recs.every(Boolean)).toBe(true)
    expect(recs.map((r) => [r!.seq, r!.kind, r!.flavour, r!.machine, r!.app])).toEqual([[0, 'start', 'release', H1, L.launchId()], [1, 'dropped', 'release', H1, L.launchId()]])
    expect(L.launchId()).toMatch(/^[0-9a-f]{12}$/)
    // the envelope comes first in the line (retention reads ts without parsing it all)
    expect(lines(f)[0]).toMatch(/^\{"v":1,"ts":\d+,"kind":"start","app":/)
    expect(existsSync(join(home.dir, 'perf', 'app-dev.jsonl'))).toBe(false)
  })

  it('Marver Dev writes app-dev.jsonl, never app.jsonl; a body never overrides the envelope', () => {
    L.startPerflog({ home, flavour: 'dev', config: () => config(), machine: () => H1 })
    L.append('dropped', { n: 1, seq: 99, flavour: 'release' } as never)
    L.flushNow()
    expect(existsSync(join(home.dir, 'perf', 'app.jsonl'))).toBe(false)
    const r = parseAppLine(lines(join(home.dir, 'perf', 'app-dev.jsonl'))[0]!)!
    expect([r.flavour, r.seq]).toEqual(['dev', 0])
  })

  it('lines at launch wait for the first hash (3 s at most), then say it - or null', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    let hash: string | null = null
    L.startPerflog({ home, flavour: 'release', config: () => config(), machine: () => hash })
    const f = join(home.dir, 'perf', 'app.jsonl')
    L.append('dropped', { n: 1 })
    await vi.advanceTimersByTimeAsync(2000)   // the first flush: no hash yet, within the hold
    expect(lines(f)).toEqual([])
    hash = H1
    await vi.advanceTimersByTimeAsync(2000)
    expect(lines(f).map((l) => parseAppLine(l)!.machine)).toEqual([H1])
    // another launch that never gets one: machine null after the hold
    await L.idle()
    L.resetPerflog()
    rmSync(f)
    L.startPerflog({ home, flavour: 'release', config: () => config(), machine: () => null })
    L.append('dropped', { n: 2 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(lines(f)).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(lines(f).map((l) => parseAppLine(l)!.machine)).toEqual([null])
  })

  it('past 2,000 queued lines the oldest go and a dropped line says how many', () => {
    L.startPerflog({ home, flavour: 'release', config: () => config(), machine: () => H1 })
    for (let i = 0; i < L.QUEUE_MAX + 7; i++) L.append('dropped', { n: i })
    L.flushNow()
    const recs = lines(join(home.dir, 'perf', 'app.jsonl')).map((l) => parseAppLine(l)! as unknown as { kind: string; n: number; seq: number })
    expect(recs).toHaveLength(L.QUEUE_MAX + 1)
    expect(recs[0]!.n).toBe(7)
    expect(recs.at(-1)).toMatchObject({ kind: 'dropped', n: 7, seq: L.QUEUE_MAX + 7 })
  })

  it('an ENOSPC (fsx\'s faults) keeps the batch for the next flush: no earlier line lost, none torn', async () => {
    const { faults } = await import('../../src/main/fsx.ts')
    L.startPerflog({ home, flavour: 'release', config: () => config(), machine: () => H1 })
    const f = join(home.dir, 'perf', 'app.jsonl')
    L.append('dropped', { n: 1 })
    L.flushNow()
    // a torn line already in the file (a full disk mid-write): the next line still starts on its own
    writeFileSync(f, readFileSync(f, 'utf8') + '{"v":1,"ts":1,"ki', { flag: 'w' })
    faults.inject({ match: 'app\\.jsonl$', code: 'ENOSPC', at: 'write' })
    L.append('dropped', { n: 2 })
    expect(L.flushNow()).toBe(false)
    L.append('dropped', { n: 3 })
    expect(L.flushNow()).toBe(true)
    faults.clear()
    const all = lines(f)
    expect(all).toHaveLength(4)
    expect(all.map((l) => (parseAppLine(l) as unknown as { n?: number } | null)?.n ?? 'torn')).toEqual([1, 'torn', 2, 3])
  })

  it('past 5 MB the file keeps its newest half, whole lines only', async () => {
    mkdirSync(join(home.dir, 'perf'), { mode: 0o700 })
    L.startPerflog({ home, flavour: 'release', config: () => config(), machine: () => H1 })
    await L.idle()
    const f = join(home.dir, 'perf', 'app.jsonl')
    const now = Date.now()
    const pad = 'x'.repeat(500)
    const old = Array.from({ length: 10_400 }, (_, i) => JSON.stringify({ v: 1, ts: now - 1000 + (i % 100), kind: 'dropped', app: 'aaaaaaaaaaaa', seq: i, flavour: 'release', machine: H1, n: i, pad }))
    writeFileSync(f, old.join('\n') + '\n', { mode: 0o600 })
    const before = statSync(f).size
    expect(before).toBeGreaterThan(5.2 * 1024 * 1024)
    L.append('dropped', { n: -1 })
    L.flushNow()
    await L.idle()
    const after = lines(f)
    const size = statSync(f).size
    // the newest half of the bytes, to within a line
    expect(Math.abs(size - before / 2)).toBeLessThan(1500)
    for (const l of after) expect(() => JSON.parse(l)).not.toThrow()
    // the newest kept, the last one the line just written
    expect((JSON.parse(after.at(-1)!) as { n: number }).n).toBe(-1)
    expect((JSON.parse(after.at(-2)!) as { n: number }).n).toBe(10_399)
    expect(L.newestHalf(['aa', 'bb', 'cc', 'dd'])).toEqual(['cc', 'dd'])
  })

  it('two flavours on one perf/, writing at once: two files, every line whole and parsed', async () => {
    L.startPerflog({ home, flavour: 'release', config: () => config(), machine: () => H1 })
    vi.resetModules()
    const D = await import('../../src/main/perflog.ts')
    D.startPerflog({ home, flavour: 'dev', config: () => config(), machine: () => H1 })
    for (let i = 0; i < 300; i++) {
      L.append('dropped', { n: i })
      D.append('dropped', { n: i })
      if (i % 37 === 0) { L.flushNow(); D.flushNow() }
    }
    L.flushNow(); D.flushNow()
    const rel = lines(join(home.dir, 'perf', 'app.jsonl')).map((l) => parseAppLine(l))
    const dev = lines(join(home.dir, 'perf', 'app-dev.jsonl')).map((l) => parseAppLine(l))
    expect(rel.every((r) => r?.flavour === 'release')).toBe(true)
    expect(dev.every((r) => r?.flavour === 'dev')).toBe(true)
    expect(rel.map((r) => r!.seq)).toEqual([...Array(300).keys()])
    expect(dev.map((r) => r!.seq)).toEqual([...Array(300).keys()])
    expect(D.launchId()).not.toBe(L.launchId())
    await D.idle()
    D.resetPerflog()
  })

  it('an unwritable home writes nothing and never throws', () => {
    L.startPerflog({ home: { ...home, writable: false }, flavour: 'release', config: () => config(), machine: () => H1 })
    expect(L.writing()).toBe(false)
    expect(() => { L.append('dropped', { n: 1 }); L.flushSync() }).not.toThrow()
    expect(existsSync(join(home.dir, 'perf'))).toBe(false)
  })
})

describe('retention at launch (A3.6, A3.8 #12, r1 #7)', () => {
  const perf = () => join(home.dir, 'perf')
  const touch = (p: string, ageMs: number, body = 'x') => {
    writeFileSync(p, body, { mode: 0o644 })
    const t = new Date(Date.now() - ageMs)
    utimesSync(p, t, t)
  }
  const uuid = (i: number) => `0000000${i.toString(16)}-1111-2222-3333-444444444444`.slice(-36).replace(/^.{8}/, i.toString(16).padStart(8, '0'))

  it('old lines, the 51st picture, the 11th completed dump and stale pending ones go; new/, settings.dat and the other flavour\'s file stay', async () => {
    const now = Date.now()
    mkdirSync(join(perf(), 'flashes'), { recursive: true, mode: 0o755 })
    mkdirSync(join(perf(), 'crashpad', 'completed'), { recursive: true })
    mkdirSync(join(perf(), 'crashpad', 'pending'), { recursive: true })
    mkdirSync(join(perf(), 'crashpad', 'new'), { recursive: true })
    mkdirSync(join(perf(), 'machine'), { recursive: true })
    const H_OLD_NAMED = 'aaaaaaaaaaaaaaaa', H_OLD = 'bbbbbbbbbbbbbbbb', H_NEW = 'cccccccccccccccc', H_OTHER = 'dddddddddddddddd'
    const line = (ts: number, machine: string, n: number) => JSON.stringify({ v: 1, ts, kind: 'dropped', app: 'aaaaaaaaaaaa', seq: n, flavour: 'release', machine, n })
    writeFileSync(join(perf(), 'app.jsonl'), [line(now - 20 * DAY, H_OLD, 0), 'garbage', line(now - DAY, H_OLD_NAMED, 1)].join('\n') + '\n', { mode: 0o644 })
    const devText = [line(now - 30 * DAY, H_OTHER, 0)].join('\n') + '\n'
    writeFileSync(join(perf(), 'app-dev.jsonl'), devText, { mode: 0o600 })
    for (let i = 0; i < 51; i++) touch(join(perf(), 'flashes', `20261020-0000${String(i).padStart(2, '0')}-ab12.png`), (60 - i) * 60_000)
    touch(join(perf(), 'flashes', 'very-old.png'), 20 * DAY)
    for (let i = 0; i < 11; i++) {
      touch(join(perf(), 'crashpad', 'completed', `${uuid(i + 1)}.dmp`), (20 - i) * 3600_000)
      mkdirSync(join(perf(), 'crashpad', 'attachments', uuid(i + 1)), { recursive: true })
      writeFileSync(join(perf(), 'crashpad', 'attachments', uuid(i + 1), 'a.txt'), 'x')
    }
    touch(join(perf(), 'crashpad', 'pending', `${uuid(100)}.dmp`), 20 * DAY)
    touch(join(perf(), 'crashpad', 'pending', `${uuid(101)}.dmp`), DAY)
    touch(join(perf(), 'crashpad', 'new', 'x.dmp'), 40 * DAY)
    touch(join(perf(), 'crashpad', 'settings.dat'), 40 * DAY)
    for (const [h, age] of [[H_OLD_NAMED, 30 * DAY], [H_OLD, 30 * DAY], [H_NEW, DAY], [H_OTHER, 30 * DAY], [H1, 30 * DAY]] as const) touch(join(perf(), 'machine', `${h}.json`), age, '{}')

    L.startPerflog({ home, flavour: 'release', config: () => config(), machine: () => H1 })
    await L.idle()

    // this flavour's lines: the 20-day-old one and the garbage gone; the other flavour's file untouched
    expect(lines(join(perf(), 'app.jsonl')).map((l) => (JSON.parse(l) as { n: number }).n)).toEqual([1])
    expect(mode(join(perf(), 'app.jsonl'))).toBe(0o600)
    expect(readFileSync(join(perf(), 'app-dev.jsonl'), 'utf8')).toBe(devText)
    // pictures: the newest 50, the oldest and the 20-day-old one gone; the folder 700, the files 600
    const pics = readdirSync(join(perf(), 'flashes')).sort()
    expect(pics).toHaveLength(50)
    expect(pics).not.toContain('20261020-000000-ab12.png')
    expect(pics).not.toContain('very-old.png')
    expect(mode(join(perf(), 'flashes'))).toBe(0o700)
    expect(mode(join(perf(), 'flashes', pics[0]!))).toBe(0o600)
    // crashpad: the oldest completed report and its attachments gone, the stale pending one gone; nothing else
    const completed = readdirSync(join(perf(), 'crashpad', 'completed'))
    expect(completed).toHaveLength(10)
    expect(completed).not.toContain(`${uuid(1)}.dmp`)
    expect(existsSync(join(perf(), 'crashpad', 'attachments', uuid(1)))).toBe(false)
    expect(existsSync(join(perf(), 'crashpad', 'attachments', uuid(2)))).toBe(true)
    expect(readdirSync(join(perf(), 'crashpad', 'pending'))).toEqual([`${uuid(101)}.dmp`])
    expect(existsSync(join(perf(), 'crashpad', 'new', 'x.dmp'))).toBe(true)
    expect(existsSync(join(perf(), 'crashpad', 'settings.dat'))).toBe(true)
    // machine profiles: a retained line names one, the other flavour's names one, one is new, one is current; the old unnamed one goes
    expect(readdirSync(join(perf(), 'machine')).sort()).toEqual([H1, H_OLD_NAMED, H_NEW, H_OTHER].map((h) => `${h}.json`).sort())
    expect(statSync(join(perf(), 'machine', `${H1}.json`)).mtimeMs).toBeGreaterThan(now - 60_000)   // touched
  })

  it('a report a Crashpad handler holds (its lock) is skipped until the next prune; keepPerfDays applies live', async () => {
    mkdirSync(join(perf(), 'crashpad', 'completed'), { recursive: true })
    const held = join(perf(), 'crashpad', 'completed', `${uuid(7)}.dmp`)
    touch(held, 20 * DAY)
    const fd = openSync(held, constants.O_RDONLY | 0x20 /* O_EXLOCK */)
    let days = 30
    L.startPerflog({ home, flavour: 'release', config: () => config({ keepPerfDays: days }), machine: () => H1 })
    await L.idle()
    expect(existsSync(held)).toBe(true)   // 20 days old, but 30 kept
    days = 14
    const r1 = await L.prune()
    expect(r1.skippedLocked).toBe(1)
    expect(existsSync(held)).toBe(true)
    closeSync(fd)
    const r2 = await L.prune()
    expect(r2.dumps).toBe(1)
    expect(existsSync(held)).toBe(false)
  })
})
