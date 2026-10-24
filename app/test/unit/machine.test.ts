/**
 * The machine (spec 28 A3.2, A3.7, A3.8 #11), without Electron: ioreg's AGX figures read against this Mac's own text
 * (`"In use system memory (driver)"=0` before `"In use system memory"=...`), a missing key 'unknown'; the host's spawns
 * parsed as a headless run parses them; the profile's every field filled or 'unknown'; its hash independent of key
 * order, changed by a display's rate, never by thermal state (not in the profile: samples carry it).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGX_UNKNOWN, makeProfile, parseAgx, parseGpuCores, profileHash, tileBudgetMB, type ProfileInputs } from '../../src/main/machine.ts'
import { canonical, withHostSpawns, type HostProfile } from '../../../src/shared/machine.ts'
import { basicHost, profileHash as headlessHash } from '../../../src/server/machine-host.ts'

const IOREG = readFileSync(join(import.meta.dirname, 'fixtures', 'ioreg-agx.txt'), 'utf8')

describe('parseAgx (A3.8 #9)', () => {
  it('this Mac\'s text: "In use system memory" matched exactly, bytes to MB', () => {
    expect(IOREG).toContain('"In use system memory (driver)"=0')
    expect(parseAgx(IOREG)).toEqual({ gpuSystemMemoryMB: 1154.5, allocMB: 7677, utilPct: 13, rendererPct: 13, tilerPct: 7, recoveryCount: 0, machineWide: true })
    expect(parseGpuCores(IOREG)).toBe(20)
  })
  it('the (driver) key alone is not the figure; empty output and a timeout (null text) are all unknown', () => {
    expect(parseAgx('"PerformanceStatistics" = {"In use system memory (driver)"=5}').gpuSystemMemoryMB).toBe('unknown')
    expect(parseAgx('')).toEqual(AGX_UNKNOWN)
    expect(parseAgx(null as unknown as string)).toEqual(AGX_UNKNOWN)
    expect(parseGpuCores('')).toBe('unknown')
  })
})

describe('the host (A3.8 #11)', () => {
  const base: HostProfile = { chip: 'Apple M5 Pro', cores: { total: 18, p: 'unknown', e: 'unknown' }, model: 'unknown', memGB: 48, os: 'unknown', arch: 'arm64' }
  it('sysctl "6\\n12\\nMac17,8\\n" gives p 6, e 12, model Mac17,8; sw_vers the macOS version', () => {
    expect(withHostSpawns(base, '6\n12\nMac17,8\n', '26.6.2\n')).toEqual({ ...base, cores: { total: 18, p: 6, e: 12 }, model: 'Mac17,8', os: '26.6.2' })
  })
  it('a failed spawn (null) or text that does not parse stays unknown', () => {
    expect(withHostSpawns(base, null, null)).toEqual(base)
    expect(withHostSpawns(base, 'x\n\n; rm -rf\n', 'Version 26')).toEqual(base)
  })
  it('the floor is the headless run\'s own, so app and run hash a host alike', () => {
    const h = basicHost()
    expect(h.cores.total).toBeGreaterThan(0)
    expect(profileHash(h)).toBe(headlessHash(h))
  })
})

const display = (id: number, hz: number, o: Partial<ProfileInputs['displays'][number]> = {}) => ({
  id, internal: id === 1, size: { width: 1512, height: 982 }, scaleFactor: 2, displayFrequency: hz, colorSpace: '{primaries:P3}', ...o,
})
const inputs = (o: Partial<ProfileInputs> = {}): ProfileInputs => ({
  host: { chip: 'Apple M5 Pro', cores: { total: 18, p: 6, e: 12 }, model: 'Mac17,8', memGB: 48, os: '26.6.2', arch: 'arm64' },
  electron: '45.0.0', chrome: '142.0.0.0',
  gpuInfo: { auxAttributes: { glRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Version 26.6.2)', skiaBackendType: 'GraphiteDawnMetal' }, gpuDevice: [{ vendorId: 0x106b, deviceId: 0, active: true }] },
  gpuCores: 20,
  featureStatus: { gpu_compositing: 'enabled', rasterization: 'enabled', webgl: 'enabled' },
  displays: [display(2, 60, { internal: false, size: { width: 2560, height: 1440 }, scaleFactor: 1 }), display(1, 120)],
  windowDisplay: 1,
  totalMemBytes: 48 * 2 ** 30,
  onBattery: false,
  ...o,
})

describe('the profile (A3.2)', () => {
  it('every field filled, displays sorted by id, the tile budget for the window\'s display', () => {
    const p = makeProfile(inputs())
    expect(p).toMatchObject({
      v: 1, kind: 'app', electron: '45.0.0', chrome: '142.0.0.0',
      gpu: { renderer: expect.stringContaining('ANGLE'), backend: 'GraphiteDawnMetal', vendorId: 0x106b, gpuCores: 20, featureStatus: { gpu_compositing: 'enabled' } },
      power: { source: 'ac', lowPowerMode: 'unknown' },
    })
    expect(p.displays.map((d) => d.internal)).toEqual([true, false])
    expect(p.displays[0]).toEqual({ internal: true, sizeDip: [1512, 982], scaleFactor: 2, pixels: [3024, 1964], hz: 120, colorSpace: '{primaries:P3}' })
    expect(p.tileBudgetMB).toBe(tileBudgetMB([3024, 1964], 48 * 2 ** 30))
    expect(p.hostHash).toBe(headlessHash(p.host))
  })
  it('with nothing from the GPU, every GPU field is unknown - present, never missing', () => {
    const p = makeProfile(inputs({ gpuInfo: null, gpuCores: 'unknown', featureStatus: null, displays: [], windowDisplay: null }))
    expect(p.gpu).toEqual({ renderer: 'unknown', backend: 'unknown', vendorId: 'unknown', gpuCores: 'unknown', featureStatus: 'unknown' })
    expect(p.tileBudgetMB).toBe('unknown')
    const walk = (v: unknown): void => {
      expect(v).not.toBe(undefined)
      if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x)
    }
    walk(p)
  })
  it('its hash: independent of key order; a display\'s rate changes it; the battery changes it', () => {
    const a = makeProfile(inputs())
    const reverse = (v: unknown): unknown => Array.isArray(v) ? v.map(reverse) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)])) : v
    const reordered = reverse(a)
    expect(Object.keys(reordered as object)[0]).toBe('power')
    expect(profileHash(reordered)).toBe(profileHash(a))
    expect(canonical(reordered)).toBe(canonical(a))
    expect(profileHash(makeProfile(inputs({ displays: [display(2, 60, { internal: false, size: { width: 2560, height: 1440 }, scaleFactor: 1 }), display(1, 60)] })))).not.toBe(profileHash(a))
    expect(profileHash(makeProfile(inputs({ onBattery: true })))).not.toBe(profileHash(a))
    // thermal state and the speed limit are not in a profile at all: they go in samples
    expect(JSON.stringify(a)).not.toMatch(/thermal|speedLimit/)
    expect(profileHash(a)).toMatch(/^[0-9a-f]{16}$/)
  })
  it('the tile budget: research b §1\'s formula, at least 512, at most RAM / 4', () => {
    expect(tileBudgetMB([4112, 2658], 64 * 2 ** 30)).toBe(1152)
    expect(tileBudgetMB([1280, 800], 64 * 2 ** 30)).toBe(512)
    expect(tileBudgetMB([7680, 4320], 8 * 2 ** 30)).toBe(2048)
    expect(tileBudgetMB(null, 1)).toBe('unknown')
  })
})
