/**
 * Does this build carry the suite's seams? `__MV_TEST__` is set at build time (tsdown.config.ts), as the Mac app's is:
 * false for the npm build (`npm run build`), true only for the suite's own (test/global-setup.ts sets MV_TEST_BUILD=1).
 * Read from source - vitest, node's type stripping - it is undefined, and the seams are there, as a test expects.
 *
 * Every seam it guards is written `TEST_BUILD && ...` (or returns early on `!TEST_BUILD`), so the bundler folds the
 * constant and drops the seam from the published dist: bake.ts's `bakeSeams` (a held compile, a stop-asking answer, a
 * short deadline) with MV_BAKE_HOLD_MS and MV_BAKE_STOP_ASKING, perf-run.ts's `runSeams` (the driver, the CDP spy,
 * the durations) with MV_PERF_RUN_T.
 */
declare const __MV_TEST__: boolean | undefined
export const TEST_BUILD: boolean = typeof __MV_TEST__ === 'undefined' || __MV_TEST__
