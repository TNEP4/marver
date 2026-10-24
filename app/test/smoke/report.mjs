/**
 * The packaged smoke's end (code review r2 #2): its report and its exit status, apart from smoke.mjs so the build's
 * judge (scripts/build.mjs `judgeSmoke`) and the tests read the same rule.
 *
 * The exit status is the number of FAIL lines - only when the run ended normally: every check run and recorded, then
 * its cleanup (the slot block released, the run folder removed), then the report written with `completed: true`.
 * Anything thrown outside a recorded check - a case's code, a closing check, the cleanup, the report's own write - is
 * an error of the harness, never a failing check: the report (when it can still be written) says `completed: false`
 * and its `harnessErrors`, and the status is HARNESS_ERROR, which no build option waives. A count of failures can
 * never be mistaken for it: the status counts at most MAX_FAIL_STATUS of them (the report holds every one, and a
 * report whose FAIL lines and status differ never adds up for the build). A process that ends without the smoke's
 * own end - an exception, a top-level await left unsettled - exits HARNESS_ERROR too (`guardProcess`).
 */

/** The smoke's exit status for an error of its own harness: never a count of failing checks, never waived. */
export const HARNESS_ERROR = 100
/** The most failing checks an exit status counts (exit statuses wrap at 256: 256 failures would read as none). */
export const MAX_FAIL_STATUS = 99

const said = (err) => String(err?.stack ?? err).split('\n').slice(0, 3).map((l) => l.trim()).join(' | ')

/**
 * The run's end, in this order: `cleanup()`, then the report - `base` with `failures`, `results`, `completed` and,
 * when anything threw, `harnessErrors` - handed to `write()`. `harnessErrors` are those the run met before its end.
 * Returns the report and the exit status: the FAIL count (at most MAX_FAIL_STATUS) when it completed and the report
 * was written, else HARNESS_ERROR.
 * @param {{ results: { verdict: string }[]; harnessErrors?: string[]; base?: Record<string, unknown>; cleanup?: () => void; write: (report: Record<string, any>) => void }} o
 */
export function finalize({ results, harnessErrors = [], base = {}, cleanup = () => {}, write }) {
  const errors = [...harnessErrors]
  try { cleanup() } catch (err) { errors.push(`cleanup: ${said(err)}`) }
  const failures = results.filter((r) => r.verdict === 'FAIL').length
  const completed = errors.length === 0
  const report = { ...base, failures, results, completed, ...(completed ? {} : { harnessErrors: errors }) }
  let written = true
  try { write(report) } catch (err) { written = false; errors.push(`report: ${said(err)}`) }
  return { report, status: completed && written ? Math.min(failures, MAX_FAIL_STATUS) : HARNESS_ERROR, errors }
}

/**
 * The process's own net: an uncaught exception or rejection goes to `onError` (the smoke then ends: `finalize`, then
 * the exit), and a process that exits without `ended()` saying the smoke's own end ran exits HARNESS_ERROR, whatever
 * its code - never 0 for a run that did not finish, never a failure count.
 * @param {(message: string) => void} onError
 * @param {() => boolean} ended
 */
export function guardProcess(onError, ended) {
  process.on('uncaughtException', (err) => onError(said(err)))
  process.on('unhandledRejection', (err) => onError(said(err)))
  process.on('exit', () => { if (!ended()) process.exitCode = HARNESS_ERROR })
}

export { said as describeError }
