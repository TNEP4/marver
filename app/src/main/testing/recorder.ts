/**
 * The recorder's test hooks (spec 28 A3.7; dev builds with MARVER_APP_TEST=1 only, like every hook): `recorder:samples`
 * (the ring), `recorder:flush` (the writer now), `recorder:inject` (a sample or an event, for the budgets' and
 * memory.ts's cases), `recorder:events`, `recorder:need`; `pressure:inject`, `memory:tick`, `memory:state`,
 * `memory:totalmem`. Owners: the recorder stream (its hooks) and the unloading stream (memory's and pressure's).
 *
 * FROZEN signature (A3.8 #53): main.ts calls it once in test mode, after the recorder started.
 *
 * The recorder stream's, as built:
 * - `recorder:samples` -> `{ samples, last, stats, perf }`: the ring's samples, the last one published, the sampler's
 *   counts (every getAppMetrics() call the app made, `metricsCalls`, and by why: tick, mark, identity - the hooks' own
 *   apart as `test`; ticks, the minute so far, whether anything needs it) and the bridge's `mv:perf` counts;
 * - `recorder:events` -> the ring's events (60 s);
 * - `recorder:tick` -> one tick now, as the timer runs it: `{ sample, metrics }`, `metrics` what that tick's
 *   `getAppMetrics()` said per process (pid, creation time, type, working set in KB), read in the wrapper before the
 *   sampler's wiring touched it - null when nothing needs the sampler;
 * - `recorder:flush` `{ minute? }` -> the unwritten minute written (with `minute: true`), then what the writer's 2 s
 *   timer does, now: the queue appended once a rewrite under way has ended, the hold at launch kept (it ends at the
 *   first hash or after profileHoldMs, as without the hook: the hook never ends it early, so it never makes a line
 *   `machine: null` that the hash would have stamped):
 *   `{ file, holding, minute }`, `minute` the folded body, the last tick's time and its raw metrics, or null;
 * - `recorder:need` `{ on }` -> the sampler kept on as memory.ts's `wantPressure()` would;
 * - `recorder:inject` `{ sample }` (handed to the consumers, never written) or `{ event: { kind, ident?, body } }`;
 * - `recorder:machine` -> the profile in force, its file and the last collection's main-thread ms;
 * - `recorder:prune` -> retention now (its report);
 * - `recorder:process` `{ pid }` and `recorder:metrics` -> what `getAppMetrics()` says now (pid, creation time, type,
 *   working set in KB, cumulative CPU);
 * - `pressure:inject` `{ level, availablePct? } | null` -> every read gives that until cleared; `pressure:spawns`.
 */
import type { AppKind, Sample, TabIdent } from '../../../../src/shared/app-perf.ts'
import { installBridge } from '../bridge.ts'
import { currentFile, currentProfile, machineStats } from '../machine.ts'
import { appLogFile, flushQueued, holdingAtLaunch, prune } from '../perflog.ts'
import { injectPressure, pressureSpawns, type PressureLevel } from '../pressure.ts'
import { appMetrics, recorderTesting, sampler } from '../recorder.ts'
import { currentHome } from '../config.ts'
import { provide } from './index.ts'

const arg = <T>(a: unknown): T => (a ?? {}) as T

export function provideRecorderHooks(): void {
  provide('recorder:samples', () => ({ samples: recorderTesting.ring().samples, last: sampler.last(), stats: recorderTesting.stats(), perf: installBridge().perfCounts() }))
  provide('recorder:events', () => recorderTesting.ring().events)
  provide('recorder:tick', async () => {
    const sample = await recorderTesting.tick()
    return sample ? { sample, metrics: recorderTesting.rawOf(sample) } : null
  })
  provide('recorder:flush', async (a) => {
    const minute = arg<{ minute?: boolean }>(a).minute ? recorderTesting.writeMinute() : null
    await flushQueued()
    return { file: appLogFile(currentHome(), __MARVER_RELEASE__ ? 'release' : 'dev'), holding: holdingAtLaunch(), minute }
  })
  provide('recorder:need', (a) => { recorderTesting.need(!!arg<{ on?: boolean }>(a).on); return true })
  provide('recorder:inject', (a) => {
    const x = arg<{ sample?: Sample; event?: { kind: AppKind; ident?: TabIdent | null; body?: Record<string, unknown> } }>(a)
    if (x.sample) recorderTesting.inject(x.sample)
    if (x.event) recorderTesting.event(x.event.kind, x.event.ident ?? null, x.event.body ?? {})
    return true
  })
  provide('recorder:machine', () => ({ ...machineStats(), profile: currentProfile(), file: currentFile() }))
  provide('recorder:prune', () => prune())
  provide('recorder:process', (a) => {
    const pid = arg<{ pid?: number }>(a).pid
    const m = appMetrics('test').find((x) => x.pid === pid)
    return m ? { pid: m.pid, born: m.creationTime, type: m.type, workingSetKB: m.memory.workingSetSize } : null
  })
  provide('recorder:metrics', () => appMetrics('test').map((m) => ({ pid: m.pid, born: m.creationTime, type: m.type, workingSetKB: m.memory.workingSetSize, cum: m.cpu.cumulativeCPUUsage ?? null })))
  provide('pressure:inject', (a) => {
    const x = a as { level: PressureLevel | null; availablePct?: number } | null
    injectPressure(x && typeof x === 'object' && 'level' in x ? x : null)
    return true
  })
  provide('pressure:spawns', () => pressureSpawns())
  // A3 unloading stream: memory:tick, memory:state, memory:totalmem
}
