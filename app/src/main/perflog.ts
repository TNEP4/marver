/**
 * The app's JSONL writer and its retention (spec 28 A3.6, A3.8 #12). Owner: the recorder stream.
 *
 * **One writer per file**: the release writes `perf/app.jsonl`, Marver Dev `perf/app-dev.jsonl` (its flash pictures
 * carry `-dev`), so no rotation needs locking between processes. `append` stamps the envelope (`app`, `seq` counted
 * per launch, `flavour`, `machine`) and queues the line (2,000 at most, then a `dropped` line); the queue is flushed
 * every 2 s with `appendFile` (mode 600) and at once at `will-quit`. Appends are exempt from A2.12's whole-write
 * rule; rotation (past 5 MB a file keeps its newest half, whole lines) and pruning are whole writes (fsx). At launch
 * and daily `keepPerfDays` prunes `~/.marver/perf/` only: this flavour's old lines; flash pictures (the newest 50 of
 * both flavours kept); in `crashpad/` only `completed/` reports (the newest 10) and `pending/` ones older than
 * `keepPerfDays`, each deleted only under Crashpad's own report lock (`O_EXLOCK`, skipped when held); machine
 * profiles no retained line names. Folders 700, files 600. errors.ts's `main-error` lines go through `append` once
 * this is built.
 *
 * FROZEN signatures (A3.8 #53).
 */
import { join } from 'node:path'
import { APP_LOG, type AppBody, type AppKind, type Flavour } from '../../../src/shared/app-perf.ts'
import type { Config, Home } from './config.ts'

/** The file a flavour writes. */
export const appLogFile = (home: Pick<Home, 'dir'>, flavour: Flavour): string => join(home.dir, 'perf', APP_LOG[flavour])

export interface PerflogStart {
  home: Home
  flavour: Flavour
  config(): Config
  /** the profile hash in force (machine.ts) */
  machine(): string | null
}

/** At ready, before the recorder's first line: the writer, and retention at launch then daily. */
export function startPerflog(o: PerflogStart): void { void o }   // A3 recorder stream

/** This launch's id (12 hex), stamped as every line's `app`. */
export function launchId(): string { return '' }   // A3 recorder stream

/** A line for app.jsonl: the envelope stamped now, queued. */
export function append<K extends AppKind>(kind: K, body: AppBody<K>): void { void kind; void body }   // A3 recorder stream

/** `will-quit`: everything queued, written now. */
export function flushSync(): void {}   // A3 recorder stream
