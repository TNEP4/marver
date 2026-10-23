/**
 * Main's error policy (spec 28 A2.1). An exception or a rejection that nothing in main caught never stops the app
 * behind Electron's modal error box ("A JavaScript error occurred in the main process"): that box blocks main on the
 * screen - every page, the guard and the quit with it - until the person clicks it, or until SIGKILL. It is
 * recorded instead, and the app goes on. Ending the app would end every canvas page in it, and with them what they
 * hold that is not yet saved, which is what the guard exists to keep.
 *
 * - one `main-error` line through the recorder's writer (perflog.ts, A3): `perf/app.jsonl` for the release,
 *   `perf/app-dev.jsonl` for Marver Dev (one writer per file, A3.8 #12), with the envelope `{ v: 1, ts, kind, app,
 *   seq, flavour, machine }` and `what, name, message, stack` (mode 600). The message and the first stack lines can
 *   hold paths, so like the page half's (A1.7) they stay on the Mac. At most 20 lines a run, each under 2 KB; written
 *   whatever `recorder` says (an error is not a sample). App 0.1 appended them itself, to app.jsonl, in Marver Dev
 *   too;
 * - a line on stderr; in a test build, the journal (`main-error`), so a case sees it.
 *
 * Installed by main.ts once the window and its pages exist: from then on an error has pages to keep alive. Before
 * that - a startup that failed - Electron's own box stays: no page holds anything yet, and a box says the app did
 * not start, where a recorded error would leave an app with no window. (Electron shows its box only while the app
 * has no `uncaughtException` listener of its own; Node turns an unhandled rejection into one only while there is
 * no `unhandledRejection` listener.) Pure but for `process` and the writer.
 */
import { append, writing } from './perflog.ts'
import { note } from './testing/index.ts'

export const MAX_RECORDS = 20
const MAX_LINE = 2048

/** One record's body (a pure function, for tests): `what, name, message, stack`, bounded so its line stays under 2 KB. */
export function errorBody(what: 'exception' | 'rejection', err: unknown): { what: 'exception' | 'rejection'; name: string; message: string; stack: string[] } {
  const e = err instanceof Error ? err : null
  const message = (e ? e.message : (() => { try { return String(err) } catch { return 'unprintable' } })()).slice(0, 500)
  const stack = (e?.stack ?? '').split('\n').slice(1, 6).map((l) => l.trim().slice(0, 200))
  const body = { what, name: (e?.name ?? typeof err).slice(0, 100), message, stack }
  // the envelope takes about 140 bytes: the body keeps the rest
  return JSON.stringify(body).length > MAX_LINE - 200 ? { ...body, stack: [] } : body
}

/** One record as a line, its envelope's `v`, `ts` and `kind` (a pure function, for tests and stderr). */
export function errorRecord(what: 'exception' | 'rejection', err: unknown, now: number): string {
  const line = JSON.stringify({ v: 1, ts: now, kind: 'main-error', ...errorBody(what, err) })
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line
}

let written = 0
let installed = false
let writable = false

/** Whether the home can be written (ensureHome's answer); the writer itself is perflog.ts's, started by the recorder. */
export function setErrorHome(home: { dir: string; writable: boolean }): void { writable = home.writable }

/** Record one error. Never throws: it runs where nothing else would catch. */
export function recordError(what: 'exception' | 'rejection', err: unknown): void {
  let line = ''
  let body: ReturnType<typeof errorBody> | null = null
  try { body = errorBody(what, err); line = errorRecord(what, err, Date.now()) } catch { line = '{"v":1,"kind":"main-error","message":"unrecordable"}' }
  try { process.stderr.write(`marver-app: uncaught ${what} in main (recorded, the app goes on): ${line}\n`) } catch { /* no stderr */ }
  try { if (__MV_TEST__) note('main-error', { what, line }) } catch { /* the journal went */ }
  if (!body || !writable || !writing() || written >= MAX_RECORDS) return
  written += 1
  try { append('main-error', body) } catch { /* stderr has it */ }
}

/** The listeners, once. */
export function installErrorPolicy(): void {
  if (installed) return
  installed = true
  process.on('uncaughtException', (err) => recordError('exception', err))
  process.on('unhandledRejection', (reason) => recordError('rejection', reason))
}

/** Test seam. */
export function resetErrorPolicy(): void { written = 0; writable = false }
