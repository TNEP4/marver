/**
 * Every duration the app keeps, in one table (spec 28 A2.14 #27). No literal durations elsewhere.
 *
 * Tests shorten one only where the rule, not the duration, is under test: in a dev build run with
 * `MARVER_APP_TEST=1`, `MARVER_APP_TIMINGS` (a JSON object of these keys) overrides them at launch. The
 * reconcile tick, the 1 s crash budget, the 5 s logo deadline and the 400 ms words run at their real
 * values in every test that times them. The release build drops the override (`__MV_TEST__`).
 */
export const T = {
  /** the registry: folder watch debounce, and the reconcile tick that notices a SIGKILLed canvas (A2.3) */
  watchDebounceMs: 100,
  reconcileMs: 5000,
  /** unverified / unreachable retries: 1, 2, 4, 8 s, then every 30 s (A2.3) */
  retryMs: [1000, 2000, 4000, 8000] as readonly number[],
  retryEveryMs: 30_000,
  /** the active tab's reachability check and its HEAD's timeout (A2.11) */
  activeCheckMs: 5000,
  headTimeoutMs: 3000,
  /** a logo fetch's deadline (A2.4) */
  logoDeadlineMs: 5000,
  /** the tab page: words only after 400 ms; "still starting" after 15 s (A2.11) */
  startingWordsMs: 400,
  stillStartingMs: 15_000,
  /** a hidden tab's tab page is closed this long after it was hidden (A2.14 #21) */
  tabPageCloseMs: 30_000,
  /** crashes: a second within this window of an automatic reload latches; a latch clears after this long (A2.11) */
  crashWindowMs: 60_000,
  latchClearMs: 60_000,
  /** the hang probe's own deadline (A2.11, A2.14 #22) */
  hangProbeMs: 1000,
  /** pills: a confirmation's time on screen, and how long one may wait before it is dropped (A2.2) */
  pillConfirmMs: 4000,
  pillDropMs: 30_000,
  /** the unsaved pill of a page without the bridge, or one main can no longer hear (A2.14 #33) */
  unsavedPillMs: 10_000,
  /** ~/.marver: the folder watch, and the debounce of state files (tabs.json, recent.json) (A2.7, A2.4) */
  configDebounceMs: 120,
  stateDebounceMs: 1000,
  /** the menu is rebuilt at most this often (A2.7) */
  menuDebounceMs: 100,
  /**
   * the guard's act: how long main waits for Chromium's outcome (the page closed or navigated, or refused) before
   * it answers 'refused' - Chromium itself goes on past a renderer that does not answer its beforeunload in time
   * (A2.14 v1.13 r2 #4); the view is still removed whenever it is destroyed
   */
  guardActMs: 60_000,
} satisfies Record<string, number | readonly number[]>

export type Timings = typeof T

/** Applied once by main.ts in test mode. Unknown keys and values of the wrong type are refused, loudly. */
export function overrideTimings(json: string): void {
  if (!__MV_TEST__) return
  const o = JSON.parse(json) as Record<string, unknown>
  for (const [k, v] of Object.entries(o)) {
    const was = (T as Record<string, unknown>)[k]
    if (was === undefined) throw new Error(`MARVER_APP_TIMINGS: no timing named ${k}`)
    const ok = Array.isArray(was) ? Array.isArray(v) && v.every((n) => typeof n === 'number') : typeof v === 'number'
    if (!ok) throw new Error(`MARVER_APP_TIMINGS: ${k} must be ${Array.isArray(was) ? 'an array of numbers' : 'a number'}`)
    ;(T as Record<string, unknown>)[k] = v
  }
}
