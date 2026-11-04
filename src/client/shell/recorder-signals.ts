/**
 * What the page signals beyond loads (spec 30 R3-R6): theme switches by transition (#21-#23), modes (#24-#27), the new
 * error sources and their budgets (#28-#33: console, vite, api, resource, the frames' `sh:dropped` counts), the
 * gesture's scale, awake count and Long Animation Frames (#34, #35), and the React Profiler's minutes (#36). Owner: the
 * signals stream.
 *
 * A stub until then: recorder.ts calls `startSignals()` once, at the full level only, after the page recorder is on.
 * It subscribes through recorder-seams.ts (`frameMessage`, `stageMessage`, `answered`) and the stores, writes through
 * `perfSeams.record`, sets `perfSeams.transition`, and asks the Mac app for `theme` windows with app-perf.ts
 * `watchWindow`.
 */

/** recorder.ts `startRecorder`, at the full level: the watchers and listeners. */
export function startSignals(): void {}
