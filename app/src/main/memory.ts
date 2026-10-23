/**
 * Unloading hidden tabs under pressure: the policy (spec 28 A2.6, A3.8 #40, #41, #45). Owner: the unloading stream.
 * `decide` is pure; the tick around it runs on the one sampler's samples (recorder.ts), also with the recorder off.
 *
 * At each sample: at critical (4), every candidate, least recently shown first; at warn (2), or when canvas
 * renderers together are strictly above half of `os.totalmem()`, only the least recently shown one, then
 * `unloadCooldownMs` before the next such unload, one at a time - the kernel's level lags the freeing. An unknown
 * level never triggers; the half-RAM rule rests on the sampler alone. "Least recently shown" is the smallest
 * `hiddenAt`, a tie to the lower tab id. Canvas memory is the sum over unique canvas processes of `footprintMB`,
 * else `rssMB`. A candidate is a tab whose `unloadRefusal(tab, now)` is null (tabs.ts); the act is
 * `guard(tab, { kind: 'unload', reason })`. Records go through `event`: `pressure` on a change of level, `unload-skip`
 * once per tab and reason in each pressure episode, `unload-effect` 5 s after an unload.
 *
 * FROZEN (A3.8 #53): `Candidate`, `DecideInput`, `Decision`, `decide`, `canvasMemory`, `MemoryDeps`, `startMemory`.
 */
import type { AppBody, AppKind, PressureLevel, Sample, Sampler, TabIdent, UnloadReason } from '../../../src/shared/app-perf.ts'
import type { Tab } from './tabs.ts'

export interface Candidate { id: string; hiddenAt: number }

export interface DecideInput {
  /** config.unloadUnderPressure */
  on: boolean
  level: PressureLevel | null
  /** canvasMemory(sample); null with no sample */
  canvasMB: number | null
  /** os.totalmem() in MB (a test may set it) */
  totalMB: number
  candidates: Candidate[]
  /** a warn or half-RAM unload not yet ended */
  softInFlight: boolean
  lastSoftAt: number | null
  now: number
}

export interface Decision { unload: { id: string; reason: UnloadReason }[] }

export function decide(i: DecideInput): Decision {
  void i
  return { unload: [] }   // A3 unloading stream
}

/** Σ over unique canvas processes of footprintMB, else rssMB (A3.8 #41); null when the sample has no canvas process. */
export function canvasMemory(s: Sample): number | null {
  void s
  return null   // A3 unloading stream
}

export interface MemoryDeps {
  config(): { unloadUnderPressure: boolean }
  sampler: Sampler
  totalMB(): number
  /** recorder.event */
  event<K extends AppKind>(kind: K, who: Tab | TabIdent | null, body: Omit<AppBody<K>, keyof TabIdent>): void
  now(): number
}

/** At ready, after the views (tabs.ts holds the model): the sampler's subscriber and `wantPressure`. */
export function startMemory(d: MemoryDeps): void { void d }   // A3 unloading stream
