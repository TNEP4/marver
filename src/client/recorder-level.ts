/**
 * The recorder's level (spec 30 #57, #58): the one switch every spec 30 hook is gated by, in the shell, the frame host
 * and the stage alike. `core` records what 0.29 recorded - the load tracking a headless run's driver reads
 * (`currentLoad`, recorder.ts) - and nothing spec 30 adds; `full`, the default, records everything.
 *
 * Set by the page's URL, `?mvrecorder=core` (perf-records.ts `RECORDER_PARAM`): `marver perf run <board> --recorder
 * core` puts it on the shell's URL, and `withWs()` (api.ts) carries it onto every frame and stage URL, so a document's
 * hooks keep its page's level. Dev only: a production build has no recorder and reads `full`. bridge.js ships
 * verbatim and imports nothing new (build.ts copies it): it reads the parameter itself, the same way.
 *
 * Owner: app-store (R15) - the run's `--recorder` input, `self` records and the cost test. Every other stream calls
 * `fullRecorder()` (or starts from recorder.ts's stream starters, which are not called under `core`).
 */
import { RECORDER_PARAM, type RecorderLevel } from '../shared/perf-records.ts'

/** This document's level, read once at module load. */
export const RECORDER_LEVEL: RecorderLevel = (() => {
  if (!import.meta.env.DEV) return 'full'
  try { return new URLSearchParams(location.search).get(RECORDER_PARAM) === 'core' ? 'core' : 'full' } catch { return 'full' }
})()

/** The level, for a hook deciding whether to run. */
export const recorderLevel = (): RecorderLevel => RECORDER_LEVEL
/** Does this document record what spec 30 adds? */
export const fullRecorder = (): boolean => RECORDER_LEVEL === 'full'
