/**
 * This Mac's profile (spec 28 A3.2, A3.8 #11) and the machine-wide GPU figures (A3.1). Owner: the recorder stream.
 *
 * At launch and on display, power or GPU feature changes (debounced 1 s), the app's profile is collected - under
 * 50 ms of main-thread work (a test), every spawn `execFile` with an absolute path - and written to
 * `<MARVER_HOME>/perf/machine/<hash>.json` (700/600, a `wx` temp file renamed; an existing one only touched).
 * `getGPUInfo('complete')` is waited for 2 s at most, then the profile is written with 'unknown' where it lacks; a
 * late answer makes a new profile and hash, the stamp from then on. Lines at launch wait for the first hash 3 s at
 * most, then say `machine: null`. The host part and its hash are the headless run's too (src/shared/machine.ts).
 *
 * FROZEN signatures (A3.8 #53).
 */
import { createHash } from 'node:crypto'
import type { BaseWindow } from 'electron'
import type { AgxReading } from '../../../src/shared/app-perf.ts'
import { canonical, PROFILE_HASH_HEX, type AppProfile } from '../../../src/shared/machine.ts'
import type { Home } from './config.ts'

/** A profile's hash: the same function machine-host.ts uses, so the two kinds meet by `hostHash`. */
export const profileHash = (p: unknown): string => createHash('sha256').update(canonical(p)).digest('hex').slice(0, PROFILE_HASH_HEX)

/** No figure read: what a failed or missing ioreg gives. */
export const AGX_UNKNOWN: AgxReading = { gpuSystemMemoryMB: 'unknown', allocMB: 'unknown', utilPct: 'unknown', rendererPct: 'unknown', tilerPct: 'unknown', recoveryCount: 'unknown', machineWide: true }

/** At ready, after ensureHome: the first profile, then its watch. */
export function startMachine(o: { home: Home; window(): BaseWindow | null }): void { void o }   // A3 recorder stream

/** The profile hash in force now, or null before the first. */
export function currentHash(): string | null { return null }

/** The current profile, or null before the first. */
export function currentProfile(): AppProfile | null { return null }

/** The first hash, waited for `ms` at most (lines at launch, A3.8 #11). */
export async function firstHash(ms: number): Promise<string | null> { void ms; return null }

/** `ioreg -rc AGXAccelerator -d1`'s text: `"In use system memory"=` matched exactly (the line also holds a `(driver)` key); a missing key 'unknown'. */
export function parseAgx(text: string): AgxReading { void text; return AGX_UNKNOWN }   // A3 recorder stream

/** One ioreg read, `timeoutMs` at most; best effort. */
export async function readAgx(timeoutMs: number): Promise<AgxReading> { void timeoutMs; return AGX_UNKNOWN }
