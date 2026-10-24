/**
 * The machine profile's start, against fakes of Electron and of `execFile` (spec 28 A3.2, A3.8 #11; the review of
 * a3-recorder): the app's host and a headless run's (`machine-host.ts` `hostProfile()`) fed the same spawn answers
 * hash alike - this Mac's, an Intel Mac's (no perflevels: sysctl exits non-zero), a spawn that fails once and answers
 * the second time, garbage; a hash stamps lines only once its file is written; the launch's collection counts every
 * main-thread step, spawns included; a profile file pruned between the check and the touch is written again.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ---- fakes ---------------------------------------------------------------------------------------------------------

type Answer = string | Error
const spawn = {
  /** by absolute path: the answers in turn (the last one repeats) */
  answers: new Map<string, Answer[]>(),
  calls: [] as string[],
}
const IOREG_TEXT = readFileSync(join(import.meta.dirname, 'fixtures', 'ioreg-agx.txt'), 'utf8')
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (file: string, _args: string[], _o: unknown, cb: (err: Error | null, out: string, errOut: string) => void) => {
    spawn.calls.push(file)
    const list = spawn.answers.get(file) ?? [file.endsWith('ioreg') ? IOREG_TEXT : new Error('no answer')]
    const a = list.length > 1 ? list.shift()! : list[0]!
    setTimeout(() => (a instanceof Error ? cb(a, '', '') : cb(null, a, '')), 1)
    return {}
  },
}))

const gate = { on: false, reached: () => {}, open: () => {} }
vi.mock('node:fs/promises', async (orig) => {
  const m = await orig<typeof import('node:fs/promises')>()
  return {
    ...m,
    open: async (...a: Parameters<typeof m.open>) => {
      if (gate.on && /machine\/[0-9a-f]{16}\.json\.[0-9a-f]{12}\.tmp$/.test(String(a[0]))) { gate.on = false; gate.reached(); await new Promise<void>((r) => { gate.open = r }) }
      return m.open(...a)
    },
    utimes: async (...a: Parameters<typeof m.utimes>) => {
      // a prune that took the file between writeProfile's check and its touch
      if (unlinkBeforeTouch.has(String(a[0]))) { unlinkBeforeTouch.delete(String(a[0])); unlinkSync(String(a[0])) }
      return m.utimes(...a)
    },
  }
})
const unlinkBeforeTouch = new Set<string>()

vi.mock('electron', () => ({
  app: {
    on: () => {},
    getGPUInfo: async (kind: string) => (kind === 'complete' ? { auxAttributes: { glRenderer: 'ANGLE (Apple M5 Pro)', skiaBackendType: 'GraphiteDawnMetal' }, gpuDevice: [{ vendorId: 0x106b, active: true }] } : {}),
    getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled' }),
  },
  powerMonitor: { on: () => {}, isOnBatteryPower: () => false },
  screen: {
    on: () => {},
    getAllDisplays: () => [{ id: 1, internal: true, size: { width: 1512, height: 982 }, scaleFactor: 2, displayFrequency: 120, colorSpace: '' }],
    getDisplayMatching: () => ({ id: 1 }),
  },
}))

const M = await import('../../src/main/machine.ts')
const { hostProfile, profileHash: headlessHash } = await import('../../../src/server/machine-host.ts')

const SYSCTL = '/usr/sbin/sysctl', SW_VERS = '/usr/bin/sw_vers'
let base: string
beforeEach(() => { spawn.answers.clear(); spawn.calls.length = 0 })
afterAll(() => { if (base) rmSync(base, { recursive: true, force: true }) })

describe('the app and a headless run read one host alike (A3.8 #11)', () => {
  const both = async () => {
    const answers = new Map([...spawn.answers].map(([k, v]) => [k, [...v]]))
    const app = await M.readAppHost()
    spawn.answers.clear()
    for (const [k, v] of answers) spawn.answers.set(k, v)
    const run = await hostProfile()
    return { app, run }
  }
  const cases: [string, Answer[], Answer[], Partial<{ p: number | 'unknown'; model: string; os: string }>][] = [
    ['this Mac', ['6\n12\nMac17,8\n'], ['26.6.2\n'], { p: 6, model: 'Mac17,8', os: '26.6.2' }],
    ['an Intel Mac: no perflevels, sysctl exits non-zero', [new Error('exit 1')], ['15.7\n'], { p: 'unknown', model: 'unknown', os: '15.7' }],
    ['a spawn that fails once (a busy launch), then answers', [new Error('timed out'), '6\n12\nMac17,8\n'], [new Error('timed out'), '26.6.2\n'], { p: 6, model: 'Mac17,8', os: '26.6.2' }],
    ['answers that do not parse', ['6\n12\n'], ['Version 26'], { p: 'unknown', model: 'unknown', os: 'unknown' }],
  ]
  for (const [name, sysctl, sw, want] of cases) {
    it(`${name}: the same host, the same hostHash`, async () => {
      spawn.answers.set(SYSCTL, sysctl)
      spawn.answers.set(SW_VERS, sw)
      const { app, run } = await both()
      expect(app).toEqual(run)
      expect(M.profileHash(app)).toBe(headlessHash(run))
      expect({ p: app.cores.p, model: app.model, os: app.os }).toMatchObject(want)
    })
  }
})

describe('the profile at launch (A3.8 #11)', () => {
  it('a hash stamps lines only once its file is written; the launch counts every main-thread step, the spawns too', async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-machine-')))
    spawn.answers.set(SYSCTL, ['6\n12\nMac17,8\n'])
    spawn.answers.set(SW_VERS, ['26.6.2\n'])
    const reached = new Promise<void>((r) => { gate.reached = r })
    gate.on = true
    M.startMachine({ home: { dir: base, writable: true, state: '', crashpad: '', ms: 0 }, window: () => null })
    await reached
    // the profile is in force, its file still being written: no line names it yet
    const hash = M.currentHash()
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(M.stampHash()).toBe(null)
    expect(existsSync(join(base, 'perf', 'machine', `${hash}.json`))).toBe(false)
    gate.open()
    await vi.waitFor(() => expect(M.stampHash()).toBe(hash))
    expect(existsSync(join(base, 'perf', 'machine', `${hash}.json`))).toBe(true)
    const st = M.machineStats()
    expect(st.launchMs).toBe(st.collectMs)
    expect(Object.keys(st.parts).sort()).toEqual(['build', 'gpu', 'host', 'spawns'])
    expect(st.collectMs).toBeCloseTo(Object.values(st.parts).reduce((n, v) => n + v, 0), 6)
    expect(spawn.calls).toEqual(expect.arrayContaining([SYSCTL, SW_VERS, M.IOREG]))
  })

  it('a profile file a prune took between the check and the touch is written again', async () => {
    const dir = join(base, 'perf', 'machine')
    const file = join(dir, `${'e'.repeat(16)}.json`)
    await M.writeProfile(dir, 'e'.repeat(16), { v: 1 })
    expect(existsSync(file)).toBe(true)
    unlinkBeforeTouch.add(file)
    await M.writeProfile(dir, 'e'.repeat(16), { v: 1 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1 })
  })
})
