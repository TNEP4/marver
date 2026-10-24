/**
 * Memory pressure (spec 28 A3.7, A3.8 #6), without Electron: sysctl's 1, 2 and 4 read; any other value, a non-zero
 * exit (an unknown oid shifts the lines) and a timeout are null - unknown, never normal; two calls while one read
 * runs make one spawn; an injected level stands in for every read until cleared.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { injectPressure, lastPressure, parsePressure, PRESSURE_ARGS, pressureSpawns, readPressure, resetPressure, setPressureSpawner, SYSCTL } from '../../src/main/pressure.ts'

afterEach(() => resetPressure())

describe('parsePressure', () => {
  it('1, 2 and 4 read, with the available percentage', () => {
    expect(parsePressure(0, '1\n65\n')).toEqual({ level: 1, availablePct: 65 })
    expect(parsePressure(0, '2\n18\n')).toEqual({ level: 2, availablePct: 18 })
    expect(parsePressure(0, '4\n3\n')).toEqual({ level: 4, availablePct: 3 })
  })
  it('any other value is unknown, never normal', () => {
    for (const out of ['0\n50\n', '3\n50\n', '8\n50\n', '-1\n50\n', '1.0\n50\n', 'normal\n', '', '\n']) expect(parsePressure(0, out).level).toBe(null)
    expect(parsePressure(0, '1\n101\n')).toEqual({ level: 1, availablePct: null })
    expect(parsePressure(0, '1\n')).toEqual({ level: 1, availablePct: null })
  })
  it('a non-zero exit (an unknown oid shifts the lines) and a timeout (no code) are all unknown', () => {
    expect(parsePressure(1, '65\n')).toEqual({ level: null, availablePct: null })
    expect(parsePressure(null, '')).toEqual({ level: null, availablePct: null })
  })
})

describe('readPressure', () => {
  it('the one spawn: sysctl by its absolute path, both oids; two calls while it runs share it', async () => {
    const calls: { file: string; args: readonly string[]; timeoutMs: number }[] = []
    let answer!: (r: { code: number | null; stdout: string }) => void
    setPressureSpawner((file, args, timeoutMs) => { calls.push({ file, args, timeoutMs }); return new Promise((r) => { answer = r }) })
    const a = readPressure()
    const b = readPressure()
    expect(a).toBe(b)
    answer({ code: 0, stdout: '2\n30\n' })
    expect((await a).level).toBe(2)
    expect(calls).toEqual([{ file: SYSCTL, args: PRESSURE_ARGS, timeoutMs: 1000 }])
    expect(SYSCTL).toBe('/usr/sbin/sysctl')
    expect(pressureSpawns()).toBe(1)
    expect(lastPressure()).toMatchObject({ level: 2, availablePct: 30 })
    // the next call spawns again
    setPressureSpawner(async () => ({ code: null, stdout: '' }))
    expect((await readPressure()).level).toBe(null)
    expect(pressureSpawns()).toBe(2)
    expect(lastPressure()!.level).toBe(null)
  })

  it('a spawn that throws is unknown', async () => {
    setPressureSpawner(() => Promise.reject(new Error('EAGAIN')))
    expect(await readPressure()).toMatchObject({ level: null, availablePct: null })
  })

  it('an injected level stands in for every read, with no spawn, until cleared', async () => {
    let spawned = 0
    setPressureSpawner(async () => { spawned++; return { code: 0, stdout: '1\n70\n' } })
    injectPressure({ level: 4, availablePct: 2 })
    expect(await readPressure()).toMatchObject({ level: 4, availablePct: 2 })
    expect(spawned).toBe(0)
    injectPressure(null)
    expect((await readPressure()).level).toBe(1)
    expect(spawned).toBe(1)
  })

  it('this Mac\'s own sysctl answers 1, 2 or 4 (a real read, off the main thread)', async () => {
    const r = await readPressure()
    expect([1, 2, 4]).toContain(r.level)
    expect(r.availablePct).not.toBe(null)
  })
})
