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
import type { PressureLevel, PressureReading } from '../../../src/shared/app-perf.ts'

export type { PressureLevel, PressureReading }

/** sysctl's answer: line 1 exactly 1, 2 or 4, line 2 an integer 0-100; a non-zero exit is all unknown. */
export function parsePressure(code: number | null, stdout: string): Omit<PressureReading, 'at'> {
  void code; void stdout
  return { level: null, availablePct: null }   // A3 recorder stream
}

/** One read (shared while in flight). */
export async function readPressure(): Promise<PressureReading> {
  return { level: null, availablePct: null, at: Date.now() }   // A3 recorder stream: the spawn
}

/** The last reading (Copy Details' "memory pressure", A3.8 #46), or null before any. */
export function lastPressure(): PressureReading | null { return null }

/** Test builds (`pressure:inject`): the level every read gives until cleared with null. */
export function injectPressure(r: { level: PressureLevel | null; availablePct?: number } | null): void { void r }

/** Test builds: sysctl spawns so far ("no sysctl while nothing could be unloaded"). */
export function pressureSpawns(): number { return 0 }
