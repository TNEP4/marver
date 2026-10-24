/**
 * Every duration the app keeps, in one table (spec 28 A2.14 #27, A3.8 #53). No literal durations elsewhere.
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

  // ---- A3 (app 0.2): frozen names, starting values (A3.8 #53); retuned only from the recorder's numbers ----

  /** the one sampler's tick (A3.1, A3.8 #4) and its minute aggregate on disk (A3.8 #7) */
  sampleMs: 5000,
  sampleDiskMs: 60_000,
  /** the JSONL writer's flush (A3.8 #12) */
  writeBatchMs: 2000,
  /** retention at launch, then daily (A3.6); the launch's pass waits this long after ready, past the launch budget's window (A3.8 #50) */
  retentionMs: 86_400_000,
  retentionDelayMs: 5000,
  /** ioreg's AGX read while recording with the window visible (A3.1) */
  agxMs: 30_000,
  /** every probe spawn's timeout: ioreg, sysctl for the profile (A3.2) */
  spawnTimeoutMs: 2000,
  /** sysctl's pressure read (A3.8 #6) */
  pressureReadMs: 1000,
  /** a canvas preload's `mem` answer counts within this, and serves this long (A3.8 #5) */
  memAnswerMs: 1000,
  memServesMs: 10_000,
  /** a `shown` answer later than this is dropped (A3.8 #9) */
  shownAnswerMs: 5000,
  /** the profile waits this long for getGPUInfo('complete'); lines at launch wait this long for the first hash (A3.8 #11) */
  profileGpuWaitMs: 2000,
  profileHoldMs: 3000,
  /** display, power and GPU changes debounced before a new profile (A3.8 #11) */
  profileDebounceMs: 1000,
  /** a new GPU process with no child-gone within this writes gpu-restart (A3.8 #9) */
  gpuRestartMs: 2000,
  /** Mark a Flash (A3.8 #13): the debounce, the picture's bound, the GPU-event window after the mark */
  flashDebounceMs: 2000,
  flashPictureMs: 2000,
  flashGpuWindowMs: 1000,
  /** the white-out detector (A3.8 #15, #16): its tick (250 ms; 500 ms at 2 Hz), the tail after a gesture, the
   *  longest gesture, a capture abandoned past this, a probe answer later than this inconclusive */
  whiteoutTickMs: 250,
  whiteoutTailMs: 500,
  whiteoutMaxMs: 30_000,
  whiteoutCaptureMs: 500,
  probeAnswerMs: 150,
  /** the one ground (A3.8 #27, #28): animation frames the shell waits (1-8; a count, main's tunable), the lift's
   *  extra wait, the live resize's quiet timer */
  presentFrames: 2,
  uncoverDelayMs: 0,
  liveResizeQuietMs: 500,
  /** unloading (A2.6, A3.8 #39-#45): hidden this long at least, the soft unloads' cooldown, the act's own wait for
   *  destroyed or the page's refusal, the effect's "after", a reopened document's hello wait */
  unloadMinHiddenMs: 10_000,
  unloadCooldownMs: 30_000,
  unloadActMs: 10_000,
  unloadEffectMs: 5000,
  reopenHelloMs: 30_000,
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
