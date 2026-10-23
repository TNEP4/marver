/**
 * Main's error policy (spec 28 A2.1). An exception or a rejection that nothing in main caught never stops the app
 * behind Electron's modal error box ("A JavaScript error occurred in the main process"): that box blocks main on the
 * screen - every page, the guard and the quit with it - until the person clicks it, or until SIGKILL. It is
 * recorded instead, and the app goes on. Ending the app would end every canvas page in it, and with them what they
 * hold that is not yet saved, which is what the guard exists to keep.
 *
 * - one line in `<MARVER_HOME>/perf/app.jsonl` (mode 600): `{ v: 1, ts, kind: 'main-error', what, name, message,
 *   stack }` - A3's recorder file (A3.1), its `machine` A3's to add. The message and the first stack lines can hold
 *   paths, so like the page half's (A1.7) they stay on the Mac. At most 20 lines a run, each under 2 KB;
 * - a line on stderr; in a test build, the journal (`main-error`), so a case sees it.
 *
 * Installed by main.ts once the window and its pages exist: from then on an error has pages to keep alive. Before
 * that - a startup that failed - Electron's own box stays: no page holds anything yet, and a box says the app did
 * not start, where a recorded error would leave an app with no window. (Electron shows its box only while the app
 * has no `uncaughtException` listener of its own; Node turns an unhandled rejection into one only while there is
 * no `unhandledRejection` listener.) Pure but for `process` and the file.
 */
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { note } from './testing/index.ts'

export const MAX_RECORDS = 20
const MAX_LINE = 2048

/** One record, as written (a pure function, for tests). */
export function errorRecord(what: 'exception' | 'rejection', err: unknown, now: number): string {
  const e = err instanceof Error ? err : null
  const message = (e ? e.message : (() => { try { return String(err) } catch { return 'unprintable' } })()).slice(0, 500)
  const stack = (e?.stack ?? '').split('\n').slice(1, 6).map((l) => l.trim().slice(0, 200))
  const rec = { v: 1, ts: now, kind: 'main-error', what, name: e?.name ?? typeof err, message, stack }
  let line = JSON.stringify(rec)
  if (line.length > MAX_LINE) line = JSON.stringify({ ...rec, stack: [] }).slice(0, MAX_LINE)
  return line
}

let perfDir: string | null = null
let written = 0
let installed = false

/** Where the records go, once ensureHome made `perf/` (700); until then, stderr alone. */
export function setErrorHome(home: { dir: string; writable: boolean }): void {
  perfDir = home.writable ? join(home.dir, 'perf') : null
}

/** Record one error. Never throws: it runs where nothing else would catch. */
export function recordError(what: 'exception' | 'rejection', err: unknown): void {
  let line = ''
  try { line = errorRecord(what, err, Date.now()) } catch { line = '{"v":1,"kind":"main-error","message":"unrecordable"}' }
  try { process.stderr.write(`marver-app: uncaught ${what} in main (recorded, the app goes on): ${line}\n`) } catch { /* no stderr */ }
  try { if (__MV_TEST__) note('main-error', { what, line }) } catch { /* the journal went */ }
  if (!perfDir || written >= MAX_RECORDS) return
  written += 1
  try {
    mkdirSync(perfDir, { recursive: true, mode: 0o700 })
    const file = join(perfDir, 'app.jsonl')
    appendFileSync(file, line + '\n', { mode: 0o600 })
    chmodSync(file, 0o600)
  } catch { /* an unwritable home: stderr has it */ }
}

/** The listeners, once. */
export function installErrorPolicy(): void {
  if (installed) return
  installed = true
  process.on('uncaughtException', (err) => recordError('exception', err))
  process.on('unhandledRejection', (reason) => recordError('rejection', reason))
}

/** Test seam. */
export function resetErrorPolicy(): void { written = 0; perfDir = null }
