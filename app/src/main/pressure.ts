/**
 * Memory pressure, read only when something could use it (spec 28 A2.6, A3.8 #6). Owner: the recorder stream; the
 * unloading stream reads it through the sampler's samples.
 *
 * `/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level kern.memorystatus_level` with `execFile`, one read in
 * flight at a time (a call while one runs shares its promise), a 1 s timeout. A level other than 1, 2 or 4, a
 * non-zero exit (an unknown oid shifts the lines) or a timeout is null: unknown, never normal, never acted on. A tick
 * reads it only while the recorder is on or `wantPressure()` says an unload is possible; Electron 45 has no
 * memory-pressure event, and no daemon is added.
 *
 * FROZEN signatures (A3.8 #53).
 */
import { execFile } from 'node:child_process'
import type { PressureLevel, PressureReading } from '../../../src/shared/app-perf.ts'
import { T } from './timings.ts'

export type { PressureLevel, PressureReading }

export const SYSCTL = '/usr/sbin/sysctl'
export const PRESSURE_ARGS = ['-n', 'kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level'] as const

const LEVELS = new Set<number>([1, 2, 4])

/** sysctl's answer: line 1 exactly 1, 2 or 4, line 2 an integer 0-100; a non-zero exit is all unknown. */
export function parsePressure(code: number | null, stdout: string): Omit<PressureReading, 'at'> {
  if (code !== 0 || typeof stdout !== 'string') return { level: null, availablePct: null }
  const lines = stdout.split('\n').map((l) => l.trim())
  const l1 = lines[0] ?? ''
  const l2 = lines[1] ?? ''
  const level = /^\d{1,2}$/.test(l1) && LEVELS.has(Number(l1)) ? (Number(l1) as PressureLevel) : null
  const pct = /^\d{1,3}$/.test(l2) && Number(l2) <= 100 ? Number(l2) : null
  return { level, availablePct: pct }
}

let inFlight: Promise<PressureReading> | null = null
let last: PressureReading | null = null
let injected: { level: PressureLevel | null; availablePct?: number } | null = null
let spawns = 0

/** The spawn itself, replaceable by a unit test (no process is started there). */
export type Spawner = (file: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string }>
const realSpawn: Spawner = (file, args, timeoutMs) => new Promise((resolve) => {
  try {
    execFile(file, [...args], { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout) })
      // a timeout kills the child (`killed`, no numeric code): unknown, like any failure
      const c = (err as NodeJS.ErrnoException & { code?: unknown }).code
      resolve({ code: typeof c === 'number' ? c : null, stdout: String(stdout ?? '') })
    })
  } catch { resolve({ code: null, stdout: '' }) }
})
let spawner: Spawner = realSpawn
/** Unit tests: a fake spawn (null restores the real one). */
export function setPressureSpawner(s: Spawner | null): void { spawner = s ?? realSpawn }

/** One read (shared while in flight). */
export function readPressure(): Promise<PressureReading> {
  if (injected) {
    last = { level: injected.level, availablePct: injected.availablePct ?? null, at: Date.now() }
    return Promise.resolve(last)
  }
  if (inFlight) return inFlight
  spawns += 1
  const p = spawner(SYSCTL, PRESSURE_ARGS, T.pressureReadMs).then(
    (r) => ({ ...parsePressure(r.code, r.stdout), at: Date.now() }),
    () => ({ level: null, availablePct: null, at: Date.now() }),
  ).then((r: PressureReading) => {
    last = r
    inFlight = null
    return r
  })
  inFlight = p
  return p
}

/** The last reading (Copy Details' "memory pressure", A3.8 #46), or null before any. */
export function lastPressure(): PressureReading | null { return last }

/** Test builds (`pressure:inject`): the level every read gives until cleared with null. */
export function injectPressure(r: { level: PressureLevel | null; availablePct?: number } | null): void {
  injected = r && (r.level === null || LEVELS.has(r.level)) ? { level: r.level, ...(typeof r.availablePct === 'number' ? { availablePct: r.availablePct } : {}) } : null
}

/** Test builds: sysctl spawns so far ("no sysctl while nothing could be unloaded"). */
export function pressureSpawns(): number { return spawns }

/** Unit tests: forget everything. */
export function resetPressure(): void { inFlight = null; last = null; injected = null; spawns = 0; spawner = realSpawn }
