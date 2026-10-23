/** Whole writes (src/main/fsx.ts; spec 28 A2.12, v1.10 r1 #14): temp, fsync, rename; one queue per file; temp sweep; state set aside. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { faults, readCapped, readState, settled, stateWriter, sweepTemps, TMP, writeWhole, writeWholeSync } from '../../src/main/fsx.ts'

let dir: string
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-fsx-'))); faults.clear() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); faults.clear() })

const tmps = () => readdirSync(dir).filter((n) => TMP.test(n))

describe('writeWhole', () => {
  it('writes the whole file at mode 600, leaving no temp file', async () => {
    const f = join(dir, 'a.json')
    await writeWhole(f, '{"a":1}\n')
    expect(readFileSync(f, 'utf8')).toBe('{"a":1}\n')
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(tmps()).toEqual([])
  })

  for (const at of ['open', 'write', 'rename'] as const) {
    it(`a failure at ${at} leaves the old file byte-identical and no temp`, async () => {
      const f = join(dir, 'recent.json')
      writeFileSync(f, 'old bytes')
      faults.inject({ match: 'recent\\.json$', code: 'ENOSPC', at })
      await expect(writeWhole(f, 'new bytes')).rejects.toMatchObject({ code: 'ENOSPC' })
      expect(readFileSync(f, 'utf8')).toBe('old bytes')
      expect(tmps()).toEqual([])
      await writeWhole(f, 'new bytes')   // the fault was for one write
      expect(readFileSync(f, 'utf8')).toBe('new bytes')
    })
  }

  it('one queue per file: two writes land in order, three keep the last (the middle one replaced while waiting)', async () => {
    const f = join(dir, 'tabs.json')
    const seen: string[] = []
    const a = writeWhole(f, 'one').then(() => seen.push(readFileSync(f, 'utf8')))
    const b = writeWhole(f, 'two')
    const c = writeWhole(f, 'three')
    await Promise.all([a, b, c])
    expect(seen).toEqual(['one'])
    expect(readFileSync(f, 'utf8')).toBe('three')
  })

  it('an async write that started before a sync one never lands over it', async () => {
    const f = join(dir, 'recent.json')
    const late = writeWhole(f, 'older')
    writeWholeSync(f, 'newer')
    await late
    expect(readFileSync(f, 'utf8')).toBe('newer')
    expect(tmps()).toEqual([])
  })

  it('writeWholeSync: whole, mode as asked, a fault leaves nothing', () => {
    const f = join(dir, 'README.md')
    writeWholeSync(f, 'hello', 0o644)
    expect(statSync(f).mode & 0o777).toBe(0o644)
    faults.inject({ match: 'README', code: 'EIO', at: 'write' })
    expect(() => writeWholeSync(f, 'broken')).toThrow(/EIO/)
    expect(readFileSync(f, 'utf8')).toBe('hello')
    expect(tmps()).toEqual([])
  })
})

describe('sweepTemps', () => {
  it('removes only our temp names, and only those older than a minute', () => {
    const now = Date.now()
    const old = join(dir, 'tabs.json.0123456789ab.tmp')
    const fresh = join(dir, 'tabs.json.ba9876543210.tmp')
    const notOurs = join(dir, 'notes.tmp')
    for (const f of [old, fresh, notOurs]) writeFileSync(f, 'x')
    utimesSync(old, new Date(now - 120_000), new Date(now - 120_000))
    utimesSync(fresh, new Date(now - 10_000), new Date(now - 10_000))
    utimesSync(notOurs, new Date(now - 120_000), new Date(now - 120_000))
    expect(sweepTemps(dir, 60_000, now)).toEqual(['tabs.json.0123456789ab.tmp'])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(notOurs)).toBe(true)
  })
})

describe('readState', () => {
  const isV1 = (v: unknown): v is { v: 1 } => (v as { v?: unknown })?.v === 1

  it('absent: undefined, nothing set aside', () => {
    expect(readState(join(dir, 'recent.json'), isV1)).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])
  })

  it('cut short: undefined, its bytes kept as .bad (the last one only)', () => {
    const f = join(dir, 'recent.json')
    writeFileSync(f, '{"v":1,"canv')
    expect(readState(f, isV1)).toBeUndefined()
    expect(readFileSync(`${f}.bad`, 'utf8')).toBe('{"v":1,"canv')
    writeFileSync(f, '{"v":2}')
    expect(readState(f, isV1)).toBeUndefined()
    expect(readFileSync(`${f}.bad`, 'utf8')).toBe('{"v":2}')
  })

  it('a good file reads back', () => {
    const f = join(dir, 'tabs.json')
    writeFileSync(f, '{"v":1}')
    expect(readState(f, isV1)).toEqual({ v: 1 })
  })
})

describe('readCapped', () => {
  it('undefined when absent, the bytes, or tooBig past the cap', async () => {
    const f = join(dir, 'config.json')
    expect(await readCapped(f)).toBeUndefined()
    writeFileSync(f, 'x'.repeat(100))
    expect((await readCapped(f, 100) as Buffer).length).toBe(100)
    expect(await readCapped(f, 99)).toEqual({ tooBig: true })
    expect(await readCapped(dir)).toEqual({ error: 'EISDIR' })
  })
})

describe('stateWriter', () => {
  it('writes the last value after its debounce, reports each failure and the recovery', async () => {
    const f = join(dir, 'recent.json')
    const noted: (string | null)[] = []
    const w = stateWriter<{ n: number }>(f, 20, { writable: () => true, noted: (_f, e) => noted.push(e ? e.code ?? 'E' : null) })
    w.set({ n: 1 })
    w.set({ n: 2 })
    expect(existsSync(f)).toBe(false)
    await new Promise((r) => setTimeout(r, 60))
    await settled()
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ n: 2 })
    faults.inject({ match: 'recent', code: 'ENOSPC' })
    w.set({ n: 3 })
    await w.flush()
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ n: 2 })
    w.set({ n: 4 })
    w.flushSync()
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ n: 4 })
    expect(noted).toEqual([null, 'ENOSPC', null])
  })

  it('keeps nothing while the home cannot be written', async () => {
    const f = join(dir, 'tabs.json')
    const w = stateWriter<{ n: number }>(f, 1, { writable: () => false, noted: () => { throw new Error('no write expected') } })
    w.set({ n: 1 })
    await w.flush()
    w.flushSync()
    expect(existsSync(f)).toBe(false)
  })
})
