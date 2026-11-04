/**
 * The recorder's own cost (spec 30 R15 #58): every 5 minutes in which it recorded anything, a `self` record - `cpuMs`,
 * `hookMs` by hook (charged through recorder-seams.ts `hooked()`, which calls `perfSeams.selfCost`), `records`,
 * `bytes`, `dropped`. Also the page's `load` white-out window (R8 #38): from a load's request to its settled or cut,
 * asked of the Mac app through app-perf.ts `watchWindow`. Owner: the app-store stream.
 *
 * recorder.ts calls `startSelf()` once, at the full level only, after the page recorder is on; under `core` nothing here
 * runs and `selfCounts.on` stays false. `cpuMs` is what the recorder's code took on this thread as far as it can tell:
 * the measured hooks and `rec()` outside them. `performance.now()` is coarse in a page (100 µs), so a figure is a sum
 * of coarse readings, right on average and never to the microsecond.
 */
import { SELF_MS, type SelfBody, type SelfHook } from '../../shared/perf-records.ts'
import { SLOW_HOOK, SLOW_HOOK_MS, busyWait } from '../recorder-level.ts'
import { watchWindow } from './app-perf.ts'
import { insideHook, perfSeams, type LoadPhase } from './recorder-seams.ts'

/** What recorder.ts's `rec()` and `send()` add to, read here; `on` keeps them silent under `core`. */
export const selfCounts = {
  on: false,
  records: 0,
  bytes: 0,
  dropped: 0,
  /** `rec()` outside any hook (a hook's own time holds the records it writes) */
  recMs: 0,
  /** recorder.ts `rec()`, as it returns */
  record(ms: number): void { this.records++; if (!insideHook()) this.recMs += ms },
}
let hookMs: Partial<Record<SelfHook, number>> = {}

const tenth = (n: number) => Math.round(n * 10) / 10

/** The period's record, when it recorded anything; the counts start over either way. */
export function writeSelf(): void {
  if (selfCounts.records > 0) {
    const hooks = Object.entries(hookMs).reduce((n, [, v]) => n + (v ?? 0), 0)
    const body: SelfBody = {
      cpuMs: tenth(hooks + selfCounts.recMs),
      hookMs: Object.fromEntries(Object.entries(hookMs).map(([k, v]) => [k, tenth(v ?? 0)])),
      records: selfCounts.records,
      bytes: selfCounts.bytes,
      dropped: selfCounts.dropped,
    }
    perfSeams.record('self', body as unknown as Record<string, unknown>)
  }
  selfCounts.records = 0
  selfCounts.bytes = 0
  selfCounts.dropped = 0
  selfCounts.recMs = 0
  hookMs = {}
}

/** #38: one window per load, open from its request until it settled or was cut. */
function loadWindows(): void {
  const open = new Set<string>()
  perfSeams.load.on((p: LoadPhase) => {
    if (p.phase === 'request') { open.add(p.load); watchWindow('load', true); return }
    if ((p.phase === 'settled' || p.phase === 'cut') && open.delete(p.load)) watchWindow('load', false)
  })
}

/** recorder.ts `startRecorder`, at the full level. */
export function startSelf(): void {
  selfCounts.on = true
  perfSeams.selfCost = (hook, ms) => { hookMs[hook] = (hookMs[hook] ?? 0) + ms }
  loadWindows()
  setInterval(writeSelf, SELF_MS)
  // #58's test-only switch (`?mvslowhook=console`): the console's way through this page costs 5 ms more, so the cost
  // run must fail. `hooked('console', ...)` waits too (recorder-seams.ts); this holds for any console.error of the shell.
  if (SLOW_HOOK === 'console') {
    const was = console.error
    console.error = (...a: unknown[]) => { busyWait(SLOW_HOOK_MS); was.apply(console, a) }
  }
}
