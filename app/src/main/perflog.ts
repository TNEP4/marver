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
 * As built:
 * - The appends are synchronous (one `O_APPEND` descriptor, `writeSync` until the batch is down, a few KB every 2 s):
 *   no append is ever in flight across a turn, and a failed one knows to the byte what landed.
 * - A whole rewrite (rotation, pruning) never blocks main on a large write: the file is read off the main thread
 *   (bytes, cut at the last newline byte, so a multi-byte character is never split), then in one synchronous turn
 *   what was appended since is taken as raw bytes and appends pause; the new file is written off the main thread
 *   (fsx `writeWhole`: a temp file, fsync, rename) and appends resume after its rename. Lines meanwhile wait in the
 *   queue. A quit (or main's error, below) during that write writes the new file with the queue at once
 *   (`writeWholeSync`, which the write in flight then never renames over), so no batch is lost or torn.
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
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeSync } from 'node:fs'
import { open, readdir, readFile, rm, stat, unlink, chmod, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_LOG, type AppBody, type AppKind, type Flavour } from '../../../src/shared/app-perf.ts'
import type { Config, Home } from './config.ts'
import { faults, sweepTemps, writeWhole, writeWholeSync } from './fsx.ts'
import { note } from './testing/index.ts'
import { T } from './timings.ts'

/** The file a flavour writes. */
export const appLogFile = (home: Pick<Home, 'dir'>, flavour: Flavour): string => join(home.dir, 'perf', APP_LOG[flavour])

export interface PerflogStart {
  home: Home
  flavour: Flavour
  config(): Config
  /** the profile hash lines are stamped with (machine.ts `stampHash`: its file written, or its write failed) */
  machine(): string | null
}

/** The queue's bound: past it the oldest lines go, and a `dropped` line says how many (A3.8 #12). */
export const QUEUE_MAX = 2000
/** Past this a file keeps its newest half, whole lines (A3.6). */
export const ROTATE_BYTES = 5 * 1024 * 1024
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

let s: PerflogStart | null = null
let file = ''
let perfDir = ''
let id = ''
let seq = 0
let startedAt = 0
let held: Held[] = []
let holding = false
let queue: string[] = []
let lost = 0
let torn = false
let flushTimer: NodeJS.Timeout | null = null
let pruneTimer: NodeJS.Timeout | null = null
let launchPrune: NodeJS.Timeout | null = null
let rewriting: Promise<void> | null = null
let pruning: Promise<PruneReport> | null = null
let rotateWanted = false
/** a whole rewrite whose new file is being written off the main thread: its bytes; appends wait meanwhile */
let swap: { data: Buffer } | null = null
/** waiting for the hold at launch to end (retention's profile pass) */
let released: (() => void)[] = []
/** test builds: the next append lands this many bytes, then fails with `code` (a disk filling mid-batch) */
let partial: { bytes: number; code: string } | null = null

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

function enqueue(line: string): void {
  queue.push(line)
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
  for (const h of held) enqueue(lineOf(h, m))
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
  // an earlier launch may have left the file ending inside a line (a full disk, a power loss): this launch's first
  // write checks, and starts on a line of its own
  torn = true
  if (!o.home.writable) return
  perfDir = join(o.home.dir, 'perf')
  file = appLogFile(o.home, o.flavour)
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

/** A line for app.jsonl: the envelope stamped now, queued. */
export function append<K extends AppKind>(kind: K, body: AppBody<K>): void {
  if (!s || !file) return
  const h: Held = { ts: Date.now(), kind, seq: seq++, body: body as unknown as Record<string, unknown> }
  if (holding) { held.push(h); release(); return }
  enqueue(lineOf(h, s.machine()))
}

/**
 * A line that cannot wait (main's uncaught errors, errors.ts): queued like any, then the hold ends - `machine: null`
 * if no hash exists yet - and everything queued is written in this turn. What follows such an error may be the
 * process's end (a native crash, a SIGKILL, a hang), where a line still in the 2 s queue would be lost.
 */
export function appendNow<K extends AppKind>(kind: K, body: AppBody<K>): void {
  if (!s || !file) return
  append(kind, body)
  flush(true)
}

/** Whether a line could be written at all (a writable home, the writer started). */
export const writing = (): boolean => !!s && !!file

/** The bytes of `lines` past the first `landed` (the lines wholly written are not queued again; one cut short is, whole). */
function linesPast(lines: string[], landed: number): string[] {
  let end = 0
  for (const [i, l] of lines.entries()) {
    end += Buffer.byteLength(l)
    if (end > landed) return lines.slice(i)
  }
  return []
}

/**
 * One flush: the queue appended now, a `dropped` line for what the bound let go. While a whole rewrite is being
 * written the lines wait for it; a forced flush (the quit, an error) writes them with it instead.
 */
function flush(force = false): boolean {
  if (!s || !file) return false
  release(force)
  if (lost > 0) {
    // after what the bound kept, outside the bound: it says how many went
    const n = lost
    lost = 0
    queue.push(lineOf({ ts: Date.now(), kind: 'dropped', seq: seq++, body: { n } }, s.machine()))
  }
  if (!queue.length) return true
  if (swap && !force) return true
  const lines = queue
  queue = []
  if (swap) return writeWithSwap(swap, lines)
  let landed = 0
  let prefix = ''
  try {
    mkdirSync(perfDir, { recursive: true, mode: 0o700 })
    if (__MV_TEST__) faults.check(file, 'write')
    const fresh = !existsSync(file)
    // after a failed append, or at a launch's first write, the file may end inside a torn line: ours starts on a line
    // of its own
    prefix = torn && !fresh && !endsWithNewline(file) ? '\n' : ''
    const data = Buffer.from(prefix + lines.join(''))
    const fd = openSync(file, 'a', 0o600)
    try {
      while (landed < data.length) {
        let n = data.length - landed
        if (__MV_TEST__ && partial && landed + n > partial.bytes) {
          const p = partial
          partial = null
          n = Math.max(0, p.bytes - landed)
          if (n > 0) landed += writeSync(fd, data, landed, n)
          throw Object.assign(new Error(`${p.code}: injected after ${p.bytes} bytes for ${file}`), { code: p.code })
        }
        landed += writeSync(fd, data, landed, n)
      }
    } finally { closeSync(fd) }
    if (fresh) chmodSync(file, 0o600)
    torn = false
  } catch (err) {
    torn = true
    // what landed stays; the lines past it are kept for the next flush, before what came since, within the bound
    queue = [...linesPast(lines, Math.max(0, landed - Buffer.byteLength(prefix))), ...queue]
    while (queue.length > QUEUE_MAX) { queue.shift(); lost += 1 }
    if (__MV_TEST__) note('perflog', { error: (err as NodeJS.ErrnoException).code ?? String(err), landed })
    return false
  }
  try { if (statSync(file).size > ROTATE_BYTES) { rotateWanted = true; void rotate() } } catch { /* gone */ }
  return true
}

/**
 * A forced flush while a rewrite's new file is being written: that file and these lines, written whole now. fsx's
 * write in flight then never renames over it (a sync write that landed is newer), so neither the rewrite nor the
 * lines are lost.
 */
function writeWithSwap(w: { data: Buffer }, lines: string[]): boolean {
  try {
    const sep = w.data.length && w.data[w.data.length - 1] !== 0x0a ? '\n' : ''
    writeWholeSync(file, Buffer.concat([w.data, Buffer.from(sep + lines.join(''))]), 0o600)
    if (swap === w) swap = null
    torn = false
    return true
  } catch (err) {
    queue = [...lines, ...queue]
    while (queue.length > QUEUE_MAX) { queue.shift(); lost += 1 }
    if (__MV_TEST__) note('perflog', { error: (err as NodeJS.ErrnoException).code ?? String(err), swap: true })
    return false
  }
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
 * Test builds (`recorder:flush`): what the 2 s timer does, now, once a rewrite under way has ended - the queue
 * appended, the hold at launch kept (it ends at the first hash or after profileHoldMs, as it would without the hook).
 */
export async function flushQueued(): Promise<boolean> {
  for (let i = 0; i < 20 && rewriting; i++) await rewriting
  return flush(false)
}

/** Whether lines at launch are still held for the first hash. */
export const holdingAtLaunch = (): boolean => holding

// ---- whole rewrites: rotation and pruning --------------------------------------------------------------------

/** The file's bytes from `from` to `to`, read now. */
function readRange(f: string, from: number, to: number): Buffer {
  const b = Buffer.alloc(to - from)
  const fd = openSync(f, 'r')
  try {
    let off = 0
    while (off < b.length) {
      const n = readSync(fd, b, off, b.length - off, from + off)
      if (n <= 0) break
      off += n
    }
    return off === b.length ? b : b.subarray(0, off)
  } finally { closeSync(fd) }
}

/**
 * Rewrites this flavour's file: `keep` chooses from its whole lines. The file is read off the main thread as bytes and
 * cut at its last newline byte (a line being torn, or a character split by a read that met an append, is never
 * judged or decoded: its bytes are kept as they are). Then, in one synchronous turn, what was appended since is taken
 * as raw bytes from where the read ended and appends pause; the new file is written off the main thread (fsx
 * `writeWhole`) and appends resume once it is renamed into place, or once it failed (the old file stays). One at a
 * time.
 */
function rewrite(keep: (lines: string[]) => string[]): Promise<void> {
  const run = async (): Promise<void> => {
    if (!file) return
    let buf: Buffer
    try { buf = await readFile(file) } catch { return }
    const cut = buf.lastIndexOf(0x0a) + 1
    const whole = buf.subarray(0, cut).toString('utf8').split('\n').filter(Boolean)
    const kept = keep(whole)
    if (kept.length === whole.length || !s || !file) return
    let mine: { data: Buffer }
    try {
      const size = statSync(file).size
      // shorter than what was read: not the file read (never rewritten over)
      if (size < buf.length) return
      const since = size > buf.length ? readRange(file, buf.length, size) : Buffer.alloc(0)
      mine = { data: Buffer.concat([Buffer.from(kept.length ? kept.join('\n') + '\n' : ''), buf.subarray(cut), since]) }
    } catch (err) {
      if (__MV_TEST__) note('perflog', { rewrite: (err as NodeJS.ErrnoException).code ?? String(err) })
      return
    }
    swap = mine
    try {
      await writeWhole(file, mine.data, 0o600)
    } catch (err) {
      if (__MV_TEST__) note('perflog', { rewrite: (err as NodeJS.ErrnoException).code ?? String(err) })
    } finally {
      // a forced flush meanwhile wrote this file and its lines itself, and took the swap down
      if (swap === mine) { swap = null; flush() }
    }
  }
  const p = (rewriting ?? Promise.resolve()).then(run, run)
  const tracked: Promise<void> = p.finally(() => { if (rewriting === tracked) rewriting = null })
  rewriting = tracked
  return p
}

/**
 * Past 5 MB: the newest half of the file's bytes, whole lines only (A3.6) - and always at least the newest line, so
 * one line larger than half the file never leaves none.
 */
export function newestHalf(lines: string[]): string[] {
  const total = lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)
  let kept = 0
  let i = lines.length
  while (i > 0 && kept + Buffer.byteLength(lines[i - 1]!) + 1 <= total / 2) { kept += Buffer.byteLength(lines[i - 1]!) + 1; i-- }
  return lines.slice(Math.min(i, Math.max(0, lines.length - 1)))
}

function rotate(): Promise<void> {
  if (!rotateWanted) return Promise.resolve()
  rotateWanted = false
  return rewrite((lines) => (lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0) > ROTATE_BYTES ? newestHalf(lines) : lines))
}

const TS = /^\{"v":1,"ts":(\d{10,16})[,}]/
/** A line's time, read without parsing it all (the envelope comes first); else from the parsed line; null for garbage. */
export function tsOf(line: string): number | null {
  const m = TS.exec(line)
  if (m) return Number(m[1])
  try { const o = JSON.parse(line) as { ts?: unknown }; return typeof o?.ts === 'number' && Number.isFinite(o.ts) ? o.ts : null } catch { return null }
}
const MACHINE = /"machine":"([0-9a-f]{16})"/

export interface PruneReport { lines: number; pictures: number; dumps: number; skippedLocked: number; profiles: number }

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
  const r: PruneReport = { lines: 0, pictures: 0, dumps: 0, skippedLocked: 0, profiles: 0 }
  if (!s || !file) return r
  const cutoff = now - days() * DAY
  if (!(await mode700(perfDir))) return r

  // this flavour's lines older than keepPerfDays (the other flavour's file is never touched)
  await rewrite((lines) => {
    const kept = lines.filter((l) => { const t = tsOf(l); return t !== null && t >= cutoff })
    r.lines = lines.length - kept.length
    return kept
  })
  await mode600(file)

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
    for (const f of Object.values(APP_LOG)) {
      let text = ''
      try { text = await readFile(join(perfDir, f), 'utf8') } catch { continue }
      for (const l of text.split('\n')) { const m = MACHINE.exec(l); if (m) named.add(m[1]!) }
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

/** Tests: retention's launch pass, if it is still waiting, run now; then once every rewrite and prune under way has ended. */
export async function idle(): Promise<void> {
  if (launchPrune) { clearTimeout(launchPrune); launchPrune = null; void prune() }
  for (let i = 0; i < 20 && (rewriting || pruning); i++) await Promise.all([rewriting, pruning])
}

/** Test builds: the next append lands `bytes` bytes, then fails with `code` (ENOSPC partway through a batch). */
export function failAppendAfter(bytes: number, code = 'ENOSPC'): void { if (__MV_TEST__) partial = { bytes, code } }

/** Unit tests: forget everything (timers stopped). */
export function resetPerflog(): void {
  if (flushTimer) clearInterval(flushTimer)
  if (pruneTimer) clearInterval(pruneTimer)
  if (launchPrune) clearTimeout(launchPrune)
  flushTimer = pruneTimer = launchPrune = null
  for (const f of released.splice(0)) f()
  s = null; file = ''; perfDir = ''; id = ''; seq = 0; startedAt = 0; held = []; holding = false; queue = []; lost = 0; torn = false
  rewriting = null; pruning = null; rotateWanted = false; swap = null; partial = null
}
