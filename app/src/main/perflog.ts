/**
 * The app's JSONL writer and its retention (spec 28 A3.6, A3.8 #12). Owner: the recorder stream.
 *
 * **One writer per file**: the release writes `perf/app.jsonl`, Marver Dev `perf/app-dev.jsonl` (its flash pictures
 * carry `-dev`), so no rotation needs locking between processes. `append` stamps the envelope (`app`, `seq` counted
 * per launch, `flavour`, `machine`) and queues the line (2,000 at most, then a `dropped` line); the queue is flushed
 * every 2 s with `appendFile` (mode 600) and at once at `will-quit`. Appends are exempt from A2.12's whole-write
 * rule; nothing is rewritten (spec 30: segments, below). At launch and daily `keepPerfDays` prunes `~/.marver/perf/`
 * only: this flavour's segments past it (spec 30); flash pictures (the newest 50 of
 * both flavours kept); in `crashpad/` only `completed/` reports (the newest 10) and `pending/` ones older than
 * `keepPerfDays`, each deleted only under Crashpad's own report lock (`O_EXLOCK`, skipped when held); machine
 * profiles no retained line names. Folders 700, files 600. errors.ts's `main-error` lines go through `append` once
 * this is built.
 *
 * As built:
 * - The appends are synchronous (one `O_APPEND` descriptor, `writeSync` until the batch is down, a few KB every 2 s):
 *   no append is ever in flight across a turn, and a failed one knows to the byte what landed.
 * - Retention's launch pass runs `retentionDelayMs` after ready, past the launch budget's window (A3.8 #50).
 * - Lines at launch are held until the machine profile's first hash exists - its file written, or its write failed
 *   (machine.ts `stampHash`) - or `profileHoldMs` passed (then `machine: null`), and stamped then (A3.8 #11): the
 *   first records never point at a half profile or at a file not yet on disk.
 * - `appendNow` is for main's uncaught errors (errors.ts): the hold ends (`machine: null` if no hash yet) and the
 *   queue is written in the same turn, since what follows such an error may be the process's end.
 * - A failed append (ENOSPC) queues again only the lines past what landed (a line cut short is written again whole);
 *   the next write starts on a fresh line, and so does a launch's first write after a file an earlier launch left
 *   ending inside a line. No line is lost, written twice or joined to a torn one.
 * - A headless run's profile (`kind: 'headless'`) is named only by `runs.jsonl` lines in the repos, which the app
 *   cannot read: it is kept at least as long as those lines are (14 days, A1's `tidyPerfDir`), whatever a shorter
 *   `keepPerfDays` says, so `--machine` never lists a retained run under no profile (A3.6: "kept while a retained line
 *   names them").
 * - The test hook's flush (`flushQueued`) is the 2 s timer's, run now: it never ends the hold at launch.
 *
 * FROZEN signatures (A3.8 #53).
 *
 * Spec 30 R9 (app 1.0.1, #42-#45) - the rotation and the line-by-line pruning above, both whole rewrites, are gone:
 * - **Two files a flavour, one seq.** `sample` and `agx` lines go to `samples.jsonl` (Marver Dev `samples-dev.jsonl`),
 *   rows unchanged (#44); everything else to `app.jsonl`. One `seq` per launch runs across both; readers merge them by
 *   `app` and `seq` (perf-segments.ts `appLogFiles` lists what they read).
 * - **Segments, deleted whole.** Each file is a live file plus closed segments `<name>.<openedAt>-<bound>.jsonl`
 *   (src/server/perf-segments.ts): the live file is closed - a rename - before an append once it was opened 24 h ago,
 *   and right after the append that passes its size (app 4 MB, samples 8 MB). `bound` is the later of the close and the
 *   largest `ts` written into it; a file this writer did not open (the 1.0.0 `app.jsonl` at the first 1.0.1 launch,
 *   #45, or a live file after a restart) has its first line's `ts` as `openedAt` and its mtime + 24 h as `bound`.
 *   Retention unlinks a segment once its bound is `keepPerfDays` old - never a read or a rewrite - at launch, hourly in
 *   the flush's own turn, and daily with the rest of the prune.
 * - **The safety cap** (#43; app 16 MB, samples 128 MB): past it the oldest segments go and a counted `dropped
 *   {reason: 'retention-cap'}` line says how many lines, in the file they went from. A segment opened before this
 *   version's first samples line (1.0.0's `app.jsonl`, samples and all, at most 28 MB) is left to retention: the app
 *   file's cap counts what 1.0.1 writes there, without samples.
 * - **The machine-profile pass** reads every segment of both files of both flavours, off the main thread (#44).
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs'
import { open, readdir, readFile, rm, stat, unlink, chmod, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_LOG, APP_SAMPLES_LOG, SAMPLE_KINDS, type AppBody, type AppKind, type Flavour } from '../../../src/shared/app-perf.ts'
import { SEGMENTS, type SegmentedFile } from '../../../src/shared/perf-records.ts'
import { adoptLive, appLogFiles, closeLive, dueToClose, enforceCap, lineTs, pruneAged, segmentsOf, type LiveState, type Segment } from '../../../src/server/perf-segments.ts'
import type { Config, Home } from './config.ts'
import { faults, sweepTemps } from './fsx.ts'
import { note } from './testing/index.ts'
import { T } from './timings.ts'

/** The file a flavour writes its events to. */
export const appLogFile = (home: Pick<Home, 'dir'>, flavour: Flavour): string => join(home.dir, 'perf', APP_LOG[flavour])
/** Spec 30 #44: the file a flavour writes its `sample` and `agx` lines to. */
export const samplesLogFile = (home: Pick<Home, 'dir'>, flavour: Flavour): string => join(home.dir, 'perf', APP_SAMPLES_LOG[flavour])

export interface PerflogStart {
  home: Home
  flavour: Flavour
  config(): Config
  /** the profile hash lines are stamped with (machine.ts `stampHash`: its file written, or its write failed) */
  machine(): string | null
}

/** The queue's bound: past it the oldest lines go, and a `dropped` line says how many (A3.8 #12). */
export const QUEUE_MAX = 2000
/** Spec 30 #42: segment retention runs in the flush's own turn once an hour has passed since it last ran. */
export const SEGMENT_PRUNE_MS = 3_600_000
/** Flash pictures kept, both flavours (A3.3). */
export const PICTURES_KEPT = 50
/** Completed Crashpad reports kept (A3.6). */
export const DUMPS_KEPT = 10
/** The repos keep `runs.jsonl` this long (A1's tidyPerfDir, A3.6): a headless run's profile is kept at least as long. */
export const RUN_LINES_DAYS = 14
/** Darwin's O_EXLOCK (fcntl.h), which Node's fs.constants lacks and `open` passes through (A3.8 r1 #7). */
export const O_EXLOCK = 0x20
const DAY = 86_400_000

interface Held { ts: number; kind: AppKind; seq: number; body: Record<string, unknown> }

/** Where a line goes (#44): `sample` and `agx` to the samples file, every other kind to the app file. */
type To = 'app' | 'samples'
const toOf = (kind: AppKind): To => ((SAMPLE_KINDS as readonly string[]).includes(kind) ? 'samples' : 'app')
interface Queued { to: To; line: string }
/** One of the two files: its path, its name among the segmented files, its live file as this writer knows it, and
 *  whether it may end inside a line (a failed append, or a launch's first write after an earlier launch's file). */
interface Out { path: string; name: SegmentedFile; live: LiveState | null; torn: boolean }

let s: PerflogStart | null = null
let outs: Record<To, Out> | null = null
let perfDir = ''
let id = ''
let seq = 0
let startedAt = 0
let held: Held[] = []
let holding = false
let queue: Queued[] = []
let lost = 0
let flushTimer: NodeJS.Timeout | null = null
let pruneTimer: NodeJS.Timeout | null = null
let launchPrune: NodeJS.Timeout | null = null
let pruning: Promise<PruneReport> | null = null
/** when segment retention last ran (the launch's pass, then hourly in a flush) */
let segmentsPrunedAt = 0
/** waiting for the hold at launch to end (retention's profile pass) */
let released: (() => void)[] = []
/** test builds: the next append lands this many bytes, then fails with `code` (a disk filling mid-batch) */
let partial: { bytes: number; code: string } | null = null
/** test builds: the writer's clock (the 24 h close and retention read it) */
let clockFn: () => number = Date.now

const days = (): number => {
  const d = Number(s?.config().keepPerfDays)
  return Number.isFinite(d) && d >= 1 ? Math.min(90, Math.round(d)) : 14
}

/** The envelope first, then the body (which never overrides it): `ts` is then early in every line, for pruning. */
function lineOf(h: Held, machine: string | null): string {
  const o: Record<string, unknown> = { v: 1, ts: h.ts, kind: h.kind, app: id, seq: h.seq, flavour: s!.flavour, machine }
  for (const [k, v] of Object.entries(h.body)) if (!(k in o) && v !== undefined) o[k] = v
  return JSON.stringify(o) + '\n'
}

function enqueue(to: To, line: string): void {
  queue.push({ to, line })
  while (queue.length > QUEUE_MAX) { queue.shift(); lost += 1 }
}

/** The hold at launch ends once the first hash exists or `profileHoldMs` passed: the held lines are stamped then. */
function release(force = false): void {
  if (!holding || !s) return
  const m = s.machine()
  if (m === null && !force && Date.now() - startedAt < T.profileHoldMs) return
  holding = false
  // test builds: how the hold ended - by the hash, past profileHoldMs, or forced (a quit, main's error) - and over what
  if (__MV_TEST__) note('perflog', { hold: { by: m !== null ? 'hash' : force ? 'forced' : 'timeout', machine: m, lines: held.length, startedAt, waitedMs: Date.now() - startedAt } })
  for (const h of held) enqueue(toOf(h.kind), lineOf(h, m))
  held = []
  for (const f of released.splice(0)) f()
}

/** Once the hold at launch has ended (at once when it has). */
function holdEnded(): Promise<void> {
  if (holding) release()
  return holding ? new Promise((r) => { released.push(r) }) : Promise.resolve()
}

/** At ready, before the recorder's first line: the writer, and retention at launch then daily. */
export function startPerflog(o: PerflogStart): void {
  if (s) return
  s = o
  id = randomBytes(6).toString('hex')
  seq = 0
  startedAt = Date.now()
  holding = true
  if (!o.home.writable) return
  perfDir = join(o.home.dir, 'perf')
  // an earlier launch may have left a file ending inside a line (a full disk, a power loss): this launch's first
  // write to it checks, and starts on a line of its own
  outs = {
    app: { path: appLogFile(o.home, o.flavour), name: APP_LOG[o.flavour] as SegmentedFile, live: null, torn: true },
    samples: { path: samplesLogFile(o.home, o.flavour), name: APP_SAMPLES_LOG[o.flavour] as SegmentedFile, live: null, torn: true },
  }
  // #45: a file opened over a day ago (1.0.0's app.jsonl at the first 1.0.1 launch) is closed as a segment now - a
  // rename, nothing rewritten; a younger one is adopted and closed when it is due
  for (const out of Object.values(outs)) { try { if (liveOf(out) && dueToClose(out.name, out.live!, clockFn())) close(out) } catch { /* the next write says */ } }
  flushTimer = setInterval(() => flush(), T.writeBatchMs)
  flushTimer.unref?.()
  // retention at launch - a moment after ready, out of the launch's way - then daily; keepPerfDays read at each pass
  // (it applies live)
  launchPrune = setTimeout(() => { launchPrune = null; void prune() }, T.retentionDelayMs)
  launchPrune.unref?.()
  pruneTimer = setInterval(() => { void prune() }, T.retentionMs)
  pruneTimer.unref?.()
}

/** This launch's id (12 hex), stamped as every line's `app`. */
export function launchId(): string { return id }

/** A line for app.jsonl (`sample` and `agx`: samples.jsonl): the envelope stamped now, queued. */
export function append<K extends AppKind>(kind: K, body: AppBody<K>): void {
  if (!s || !outs) return
  const h: Held = { ts: Date.now(), kind, seq: seq++, body: body as unknown as Record<string, unknown> }
  if (holding) { held.push(h); release(); return }
  enqueue(toOf(kind), lineOf(h, s.machine()))
}

/**
 * A line that cannot wait (main's uncaught errors, errors.ts): queued like any, then the hold ends - `machine: null`
 * if no hash exists yet - and everything queued is written in this turn. What follows such an error may be the
 * process's end (a native crash, a SIGKILL, a hang), where a line still in the 2 s queue would be lost.
 */
export function appendNow<K extends AppKind>(kind: K, body: AppBody<K>): void {
  if (!s || !outs) return
  append(kind, body)
  flush(true)
}

/** Whether a line could be written at all (a writable home, the writer started). */
export const writing = (): boolean => !!s && !!outs

/** The lines past the first `landed` bytes (the lines wholly written are not queued again; one cut short is, whole). */
function linesPast(lines: string[], landed: number): string[] {
  let end = 0
  for (const [i, l] of lines.entries()) {
    end += Buffer.byteLength(l)
    if (end > landed) return lines.slice(i)
  }
  return []
}

/** The live file as this writer knows it, else adopted from the disk (#42, #45); a file replaced behind its back is
 *  adopted again. Throws for a path that is not a regular file. */
function liveOf(out: Out): LiveState | null {
  let st
  try { st = lstatSync(out.path) } catch { out.live = null; return null }
  if (!st.isFile()) throw new Error('not a regular file')
  if (out.live && out.live.ino === st.ino) { out.live.size = st.size; return out.live }
  return (out.live = adoptLive(out.path))
}

/** The live file closed as a segment: a rename; the next append opens a new one, on a line of its own. */
function close(out: Out): void {
  if (!out.live) return
  closeLive(perfDir, out.name, out.live, clockFn())
  out.live = null
  out.torn = false
}

/**
 * One flush: the queue appended now, each line to its file, a `dropped` line for what the bound let go. A file whose
 * append fails keeps its lines past what landed for the next flush, before what came since; the other file is
 * written all the same.
 */
function flush(force = false): boolean {
  if (!s || !outs) return false
  release(force)
  if (lost > 0) {
    // after what the bound kept, outside the bound: it says how many went
    const n = lost
    lost = 0
    queue.push({ to: 'app', line: lineOf({ ts: Date.now(), kind: 'dropped', seq: seq++, body: { n } }, s.machine()) })
  }
  // segment retention, hourly, in this turn: between two appends (#42)
  if (clockFn() - segmentsPrunedAt >= SEGMENT_PRUNE_MS && segmentsPrunedAt > 0) pruneSegments()
  if (!queue.length) return true
  const batch = queue
  queue = []
  let ok = true
  const again: Queued[] = []
  for (const to of ['app', 'samples'] as const) {
    const lines = batch.filter((q) => q.to === to).map((q) => q.line)
    if (!lines.length) continue
    const rest = writeTo(outs[to], lines)
    if (rest.length) { ok = false; for (const line of rest) again.push({ to, line }) }
  }
  if (again.length) {
    queue = [...again, ...queue]
    while (queue.length > QUEUE_MAX) { queue.shift(); lost += 1 }
  }
  // a forced flush may be the last (a quit): the cap's line, queued while it wrote, goes with it
  if (force && ok && queue.length) return flush(true)
  return ok
}

/** Appends `lines` to one file: a due close first, the lines, a close past its size after. The lines not landed. */
function writeTo(out: Out, lines: string[]): string[] {
  let landed = 0
  let prefix = ''
  const now = clockFn()
  try {
    mkdirSync(perfDir, { recursive: true, mode: 0o700 })
    if (__MV_TEST__) faults.check(out.path, 'write')
    // opened 24 h ago: closed before this append (#42)
    const was = liveOf(out)
    if (was && dueToClose(out.name, was, now)) { close(out); capCheck(out) }
    const fresh = !existsSync(out.path)
    // after a failed append, or at a launch's first write, the file may end inside a torn line: ours starts on a line
    // of its own
    prefix = out.torn && !fresh && !endsWithNewline(out.path) ? '\n' : ''
    const data = Buffer.from(prefix + lines.join(''))
    const fd = openSync(out.path, 'a', 0o600)
    try {
      while (landed < data.length) {
        let n = data.length - landed
        if (__MV_TEST__ && partial && landed + n > partial.bytes) {
          const p = partial
          partial = null
          n = Math.max(0, p.bytes - landed)
          if (n > 0) landed += writeSync(fd, data, landed, n)
          throw Object.assign(new Error(`${p.code}: injected after ${p.bytes} bytes for ${out.path}`), { code: p.code })
        }
        landed += writeSync(fd, data, landed, n)
      }
      const st = fstatSync(fd)
      let max = 0
      for (const l of lines) { const t = lineTs(l); if (t !== null && t > max) max = t }
      if (out.live && out.live.ino === st.ino) { out.live.size = st.size; out.live.maxTs = Math.max(out.live.maxTs, max) }
      else out.live = { openedAt: now, maxTs: max, adopted: false, size: st.size, ino: st.ino }
    } finally { closeSync(fd) }
    if (fresh) chmodSync(out.path, 0o600)
    out.torn = false
  } catch (err) {
    out.torn = true
    if (__MV_TEST__) note('perflog', { error: (err as NodeJS.ErrnoException).code ?? String(err), landed })
    // what landed stays; the lines past it are kept for the next flush
    return linesPast(lines, Math.max(0, landed - Buffer.byteLength(prefix)))
  }
  // past its segment size: closed at once (#42)
  try { if (out.live && out.live.size >= SEGMENTS[out.name].segmentBytes) { close(out); capCheck(out) } } catch { /* the next write closes it */ }
  return []
}

/** The samples file's first `openedAt`: what this version wrote first (none yet: Infinity). */
function samplesSince(): number {
  if (!outs) return Infinity
  const segs = segmentsOf(perfDir, outs.samples.name)
  return Math.min(segs[0]?.openedAt ?? Infinity, outs.samples.live?.openedAt ?? (existsSync(outs.samples.path) ? liveOf(outs.samples)?.openedAt ?? Infinity : Infinity))
}

/** The safety cap (#43): the oldest segments past it unlinked, and a counted `dropped` line queued for the same file.
 *  The app file's cap leaves 1.0.0's segments (opened before this version's first samples line) to retention. */
function capCheck(out: Out): void {
  if (!s || !outs) return
  const since = out === outs.app ? samplesSince() : -Infinity
  const went = enforceCap(perfDir, out.name, out.live?.size ?? 0, SEGMENTS[out.name].capBytes, (g: Segment) => g.openedAt >= since)
  if (!went.segments) return
  if (__MV_TEST__) note('perflog', { cap: out.name, ...went })
  queue.push({ to: out === outs.app ? 'app' : 'samples', line: lineOf({ ts: Date.now(), kind: 'dropped', seq: seq++, body: { n: went.lines, reason: 'retention-cap' } }, s.machine()) })
}

/** Segment retention (#42): every segment of both files whose bound is `keepPerfDays` old unlinked - never read - then
 *  the cap. Synchronous: one turn, between two appends. How many went. */
function pruneSegments(now = clockFn()): number {
  if (!outs) return 0
  segmentsPrunedAt = now
  let n = 0
  for (const out of Object.values(outs)) {
    try {
      n += pruneAged(perfDir, out.name, now, days())
      liveOf(out)
      capCheck(out)
    } catch { /* the next pass */ }
  }
  return n
}

function endsWithNewline(f: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(f, 'r')
    const size = fstatSync(fd).size
    if (size === 0) return true
    const b = Buffer.alloc(1)
    readSync(fd, b, 0, 1, size - 1)
    return b[0] === 0x0a
  } catch { return true } finally { if (fd !== undefined) try { closeSync(fd) } catch { /* closed */ } }
}

/** `will-quit`: everything queued, written now. */
export function flushSync(): void { flush(true) }

/** Unit tests: write what is queued now, the hold ended for it (as a quit does). */
export const flushNow = (): boolean => flush(true)

/**
 * Test builds (`recorder:flush`): what the 2 s timer does, now - the queue appended, the hold at launch kept (it ends
 * at the first hash or after profileHoldMs, as it would without the hook).
 */
export async function flushQueued(): Promise<boolean> {
  return flush(false)
}

/** Whether lines at launch are still held for the first hash. */
export const holdingAtLaunch = (): boolean => holding

const TS = /^\{"v":1,"ts":(\d{10,16})[,}]/
/** A line's time, read without parsing it all (the envelope comes first); else from the parsed line; null for garbage. */
export function tsOf(line: string): number | null {
  const m = TS.exec(line)
  if (m) return Number(m[1])
  try { const o = JSON.parse(line) as { ts?: unknown }; return typeof o?.ts === 'number' && Number.isFinite(o.ts) ? o.ts : null } catch { return null }
}
const MACHINES = /"machine":"([0-9a-f]{16})"/g

/** `lines` is 0 from spec 30 (no line is pruned on its own); `segments`: the segments retention unlinked. */
export interface PruneReport { lines: number; pictures: number; dumps: number; skippedLocked: number; profiles: number; segments?: number }

/** Retention now (A3.6, A3.8 #12): at launch, daily, and from the test hook. */
export function prune(now = Date.now()): Promise<PruneReport> {
  if (pruning) return pruning
  const p = pruneOnce(now).catch((err): PruneReport => {
    if (__MV_TEST__) note('perflog', { prune: String(err) })
    return { lines: 0, pictures: 0, dumps: 0, skippedLocked: 0, profiles: 0 }
  })
  const tracked: Promise<PruneReport> = p.finally(() => { if (pruning === tracked) pruning = null })
  pruning = tracked
  return p
}

async function mode700(d: string): Promise<boolean> {
  try {
    const st = await stat(d)
    if (!st.isDirectory()) return false
    if ((st.mode & 0o777) !== 0o700) await chmod(d, 0o700)
    return true
  } catch { return false }
}
async function mode600(f: string): Promise<void> {
  try { const st = await stat(f); if (st.isFile() && (st.mode & 0o777) !== 0o600) await chmod(f, 0o600) } catch { /* gone */ }
}
async function listed(d: string): Promise<{ name: string; path: string; mtime: number }[]> {
  let names: string[]
  try { names = await readdir(d) } catch { return [] }
  const out: { name: string; path: string; mtime: number }[] = []
  for (const name of names) {
    const path = join(d, name)
    try { const st = await stat(path); if (st.isFile()) out.push({ name, path, mtime: st.mtimeMs }) } catch { /* gone */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
}

/**
 * Deletes one Crashpad report as Crashpad's own `DeleteReport` does (crash_report_database_mac.mm): its file opened
 * `O_RDONLY | O_NONBLOCK | O_EXLOCK` - held by a handler, it is skipped until the next prune - then unlinked, its
 * `attachments/<uuid>/` removed, then closed. True when deleted, 'locked' when skipped.
 */
export async function deleteReport(crashpad: string, path: string, uuid: string): Promise<boolean | 'locked'> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | O_EXLOCK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return 'locked'
    return false
  }
  try {
    await unlink(path).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e })
    await rm(join(crashpad, 'attachments', uuid), { recursive: true, force: true })
    return true
  } catch { return false } finally { await fh.close().catch(() => {}) }
}

/**
 * Flash pictures: the newest 50, none older than keepPerfDays (both flavours'; one already gone is no error), and a
 * picture's temporary file over a minute old - a write a quit or a crash abandoned (code review r1 #5). How many went.
 */
async function picturesPass(cutoff: number): Promise<number> {
  const flashes = join(perfDir, 'flashes')
  if (!(await mode700(flashes))) return 0
  let n = sweepTemps(flashes).length
  const pics = (await listed(flashes)).filter((f) => f.name.endsWith('.png'))
  for (const [i, f] of pics.entries()) {
    if (i < PICTURES_KEPT && f.mtime >= cutoff) { await mode600(f.path); continue }
    await unlink(f.path).then(() => { n++ }, () => {})
  }
  return n
}

/** After a flash's picture is written: the pictures pass alone (A3.3: at most 50). */
export function prunePictures(now = Date.now()): Promise<number> {
  if (!s || !perfDir) return Promise.resolve(0)
  return picturesPass(now - days() * DAY).catch(() => 0)
}

const UUID_DMP =/^([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\.dmp$/

async function pruneOnce(now: number): Promise<PruneReport> {
  const r: PruneReport = { lines: 0, pictures: 0, dumps: 0, skippedLocked: 0, profiles: 0, segments: 0 }
  if (!s || !outs) return r
  const cutoff = now - days() * DAY
  if (!(await mode700(perfDir))) return r

  // this flavour's segments whose bound is past keepPerfDays, unlinked in one turn (#42; the other flavour's files are
  // its own writer's)
  r.segments = pruneSegments(Math.max(now, clockFn()))
  for (const out of Object.values(outs)) await mode600(out.path)

  r.pictures = await picturesPass(cutoff)

  // crashpad: completed reports (the newest 10, none older than keepPerfDays) and stale pending ones, each under
  // its lock; never new/, settings.dat or anything else, and their modes are Crashpad's
  const crashpad = join(perfDir, 'crashpad')
  const reports = async (sub: string, keep: (i: number, mtime: number) => boolean) => {
    const dumps = (await listed(join(crashpad, sub))).filter((f) => UUID_DMP.test(f.name))
    for (const [i, f] of dumps.entries()) {
      if (keep(i, f.mtime)) continue
      const done = await deleteReport(crashpad, f.path, UUID_DMP.exec(f.name)![1]!)
      if (done === 'locked') r.skippedLocked++
      else if (done) r.dumps++
    }
  }
  await reports('completed', (i, m) => i < DUMPS_KEPT && m >= cutoff)
  await reports('pending', (_i, m) => m >= cutoff)
  if (__MV_TEST__) note('perflog', { pruned: { ...r }, days: days() })

  // machine profiles, once the hold at launch has ended - the first profile's file then written and touched, and its
  // hash the stamp (machine.ts stampHash) - so the current one is never taken for an old unnamed one: it is touched
  // first; then those older than keepPerfDays that no retained line of either flavour names go (read only - the
  // other flavour's file is its own writer's)
  await holdEnded()
  if (!s) return r
  const machine = join(perfDir, 'machine')
  if (await mode700(machine)) {
    const named = new Set<string>()
    const cur = s.machine()
    if (cur) named.add(cur)
    // every segment of both files of both flavours (#44), one at a time, off the main thread
    for (const f of Object.keys(APP_LOG) as Flavour[]) {
      for (const path of appLogFiles(perfDir, f)) {
        let text = ''
        try { text = await readFile(path, 'utf8') } catch { continue }
        for (const m of text.matchAll(MACHINES)) named.add(m[1]!)
      }
    }
    const profiles = (await listed(machine)).filter((f) => /^[0-9a-f]{16}\.json$/.test(f.name))
    // a headless run touches its profile at each run; only runs.jsonl lines, kept 14 days in the repos, name it
    const runsCutoff = now - Math.max(days(), RUN_LINES_DAYS) * DAY
    for (const f of profiles) {
      const hash = f.name.slice(0, 16)
      if (hash === cur) { const d = new Date(now); await utimes(f.path, d, d).catch(() => {}); await mode600(f.path); continue }
      if (f.mtime >= cutoff || named.has(hash)) { await mode600(f.path); continue }
      if (f.mtime >= runsCutoff && (await profileKind(f.path)) === 'headless') { await mode600(f.path); continue }
      await unlink(f.path).then(() => { r.profiles++ }, () => {})
    }
  }
  if (__MV_TEST__) note('perflog', { profiles: r.profiles })
  return r
}

/** A profile's `kind` ('app', 'headless'), or null when it cannot be read. */
async function profileKind(f: string): Promise<string | null> {
  try { const k = (JSON.parse(await readFile(f, 'utf8')) as { kind?: unknown }).kind; return typeof k === 'string' ? k : null } catch { return null }
}

/** Tests: retention's launch pass, if it is still waiting, run now; then once the prune under way has ended. */
export async function idle(): Promise<void> {
  if (launchPrune) { clearTimeout(launchPrune); launchPrune = null; void prune() }
  for (let i = 0; i < 20 && pruning; i++) await pruning
}

/** Unit tests: the writer's clock (the 24 h close and retention read it); none, Date.now. */
export function setPerflogClock(fn: (() => number) | null): void { clockFn = fn ?? Date.now }

/** Test builds: the next append lands `bytes` bytes, then fails with `code` (ENOSPC partway through a batch). */
export function failAppendAfter(bytes: number, code = 'ENOSPC'): void { if (__MV_TEST__) partial = { bytes, code } }

/** Unit tests: forget everything (timers stopped). */
export function resetPerflog(): void {
  if (flushTimer) clearInterval(flushTimer)
  if (pruneTimer) clearInterval(pruneTimer)
  if (launchPrune) clearTimeout(launchPrune)
  flushTimer = pruneTimer = launchPrune = null
  for (const f of released.splice(0)) f()
  s = null; outs = null; perfDir = ''; id = ''; seq = 0; startedAt = 0; held = []; holding = false; queue = []; lost = 0
  pruning = null; partial = null; segmentsPrunedAt = 0; clockFn = Date.now
}
