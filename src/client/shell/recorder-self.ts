/**
 * The recorder's own cost (spec 30 R15 #58): every 5 minutes in which it recorded anything, a `self` record - `cpuMs`,
 * `hookMs` by hook (charged through recorder-seams.ts `hooked()`, which calls `perfSeams.selfCost`), `records`,
 * `bytes`, `dropped`. Owner: the app-store stream, which also asks the Mac app for `load` windows (app-perf.ts
 * `watchWindow`, from `perfSeams.load`).
 *
 * A stub until then: recorder.ts calls `startSelf()` once, at the full level only, after the page recorder is on.
 */

/** recorder.ts `startRecorder`, at the full level. */
export function startSelf(): void {}
