/**
 * Whole writes for every file the app owns (spec 28 A2.12, v1.10 r1 #14): one writer per file at a time, a temp file
 * in the same folder, `fsync`, then `rename` over the old one, so a reader sees the old file or the new one, never
 * half of either. Owner: the home-and-files stream; config.ts, home.ts and tabs.ts (tabs.json) write through it.
 *
 * - `writeWhole` is async with one queue per file: a write waits for the one in flight, and a newer write while one
 *   waits replaces the waiting data (its caller's promise settles with the write that carried the newer data).
 * - `writeWholeSync` is for launch (ensureHome), setting a file aside and the quit flush, and always carries the
 *   newest data of its file: once it lands, the write waiting in that file's queue is dropped (its callers settle
 *   ok) and the one in flight never renames over it. Each async write checks for a newer sync write and renames in
 *   one synchronous turn (`renameSync`), so no sync write can land between the check and the rename, and no rename
 *   handed to the thread pool can finish after a sync one.
 * - Temp names are `<file>.<12 hex>.tmp`; `sweepTemps` removes only those, and only when older than a minute.
 * - `readState` reads a `state/*.json` with a check of its shape; one that fails is set aside as `<name>.bad` (the
 *   last one only) and the caller goes on as if it were empty.
 * - Test builds can inject an errno into any write (`faults`), before anything is touched or after the temp file
 *   is open; the release build drops it (`__MV_TEST__`).
 */
import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** A temp file of ours: `<name>.<12 hex>.tmp`. */
export const TMP = /^(.+)\.[0-9a-f]{12}\.tmp$/

/** The largest state file the app reads back. */
export const STATE_MAX = 1024 * 1024

// ---- test faults ------------------------------------------------------------------------------------------------

export interface Fault { match: string; code: string; times: number; at: 'open' | 'write' | 'rename' }
const injected: Fault[] = []

/** Test builds only: the next `times` writes of a file whose path matches `match` (a regexp source) fail with `code`. */
export const faults = {
  inject(f: { match: string; code: string; times?: number; at?: Fault['at'] }): void {
    if (!__MV_TEST__) return
    injected.push({ match: f.match, code: f.code, times: f.times ?? 1, at: f.at ?? 'open' })
  },
  clear(): void { injected.length = 0 },
  list(): Fault[] { return injected.map((f) => ({ ...f })) },
  check(file: string, at: Fault['at']): void {
    if (!__MV_TEST__ || !injected.length) return
    const i = injected.findIndex((f) => f.at === at && f.times > 0 && new RegExp(f.match).test(file))
    if (i < 0) return
    const f = injected[i]
    if (--f.times <= 0) injected.splice(i, 1)
    throw Object.assign(new Error(`${f.code}: injected (${at}) for ${file}`), { code: f.code })
  },
}

// ---- writes -----------------------------------------------------------------------------------------------------

const tmpName = (file: string) => `${file}.${randomBytes(6).toString('hex')}.tmp`

/** Bumped by every sync write of a file that landed: an async write queued before it does not rename over it. */
const syncGen = new Map<string, number>()
const genOf = (file: string) => syncGen.get(file) ?? 0

export function writeWholeSync(file: string, data: string | Buffer, mode = 0o600): void {
  if (__MV_TEST__) faults.check(file, 'open')
  const tmp = tmpName(file)
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', mode)
    if (__MV_TEST__) faults.check(file, 'write')
    const buf = typeof data === 'string' ? Buffer.from(data) : data
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    if (__MV_TEST__) faults.check(file, 'rename')
    renameSync(tmp, file)
  } catch (err) {
    if (fd !== undefined) try { closeSync(fd) } catch { /* already closed */ }
    try { unlinkSync(tmp) } catch { /* never made */ }
    throw err
  }
  // landed, and newer than anything queued for this file: the one in flight stands down at its rename, the waiting
  // one is dropped - its callers' data is older than this
  syncGen.set(file, genOf(file) + 1)
  const q = queues.get(file)
  if (q?.waiting) {
    const dropped = q.waiting
    q.waiting = null
    for (const w of dropped.waiters) w.ok()
  }
}

/** One async write; `gen` is the file's sync generation when it was queued. */
async function writeOnce(file: string, data: string | Buffer, mode: number, gen: number): Promise<void> {
  if (__MV_TEST__) faults.check(file, 'open')
  const tmp = tmpName(file)
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(tmp, 'wx', mode)
    if (__MV_TEST__) faults.check(file, 'write')
    await fh.writeFile(data)
    await fh.sync()
    await fh.close()
    fh = undefined
    if (__MV_TEST__) faults.check(file, 'rename')
    // the check and the rename in one synchronous turn: a sync write that landed meanwhile is newer and stays
    if (genOf(file) !== gen) { await unlink(tmp).catch(() => {}); return }
    renameSync(tmp, file)
  } catch (err) {
    if (fh) await fh.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw err
  }
}

interface Job { data: string | Buffer; mode: number; gen: number; waiters: { ok: () => void; fail: (e: unknown) => void }[] }
interface Queue { running: boolean; waiting: Job | null }
const queues = new Map<string, Queue>()

export function writeWhole(file: string, data: string | Buffer, mode = 0o600): Promise<void> {
  return new Promise((ok, fail) => {
    let q = queues.get(file)
    if (!q) queues.set(file, q = { running: false, waiting: null })
    if (q.waiting) Object.assign(q.waiting, { data, mode, gen: genOf(file) }).waiters.push({ ok, fail })
    else q.waiting = { data, mode, gen: genOf(file), waiters: [{ ok, fail }] }
    if (!q.running) void pump(file, q)
  })
}

async function pump(file: string, q: Queue): Promise<void> {
  q.running = true
  while (q.waiting) {
    const job = q.waiting
    q.waiting = null
    try {
      await writeOnce(file, job.data, job.mode, job.gen)
      for (const w of job.waiters) w.ok()
    } catch (err) {
      for (const w of job.waiters) w.fail(err)
    }
  }
  q.running = false
  queues.delete(file)
}

/** Resolves once every write queued so far has settled (tests, the quit). */
export async function settled(): Promise<void> {
  while (queues.size) await new Promise((r) => setTimeout(r, 5))
}

// ---- reads ------------------------------------------------------------------------------------------------------

export type Capped = Buffer | undefined | { tooBig: true } | { error: string }

const errCode = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? 'EIO'

/** A file's bytes, at most `max`: undefined when it does not exist, `tooBig` past `max`, `error` when unreadable. */
export async function readCapped(file: string, max = 65536): Promise<Capped> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(file, 'r')
    const st = await fh.stat()
    if (!st.isFile()) return { error: 'EISDIR' }
    if (st.size > max) return { tooBig: true }
    const buf = Buffer.alloc(max + 1)
    let n = 0
    while (n <= max) {
      const { bytesRead } = await fh.read(buf, n, max + 1 - n, n)
      if (!bytesRead) break
      n += bytesRead
    }
    return n > max ? { tooBig: true } : buf.subarray(0, n)
  } catch (e) {
    return errCode(e) === 'ENOENT' ? undefined : { error: errCode(e) }
  } finally {
    await fh?.close().catch(() => {})
  }
}

export function readCappedSync(file: string, max = 65536): Capped {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const st = statSync(file)
    if (!st.isFile()) return { error: 'EISDIR' }
    if (st.size > max) return { tooBig: true }
    const buf = readFileSync(fd)
    return buf.length > max ? { tooBig: true } : buf
  } catch (e) {
    return errCode(e) === 'ENOENT' ? undefined : { error: errCode(e) }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* closed */ }
  }
}

/** Keeps a file that failed its check as `<file>.bad`, the last one only. Never throws. */
export function setAside(file: string, data: string | Buffer): boolean {
  try { writeWholeSync(`${file}.bad`, data); return true } catch { return false }
}

/**
 * A state file read back with a check of its shape: undefined when absent, or when it does not parse or fails the
 * check - then its bytes go aside as `<file>.bad` and the caller goes on as if it were empty.
 */
export function readState<T>(file: string, check: (v: unknown) => v is T): T | undefined {
  const raw = readCappedSync(file, STATE_MAX)
  if (raw === undefined) return undefined
  if (!Buffer.isBuffer(raw)) {
    // too big to be ours: the whole file goes aside by rename (nothing is read); unreadable: left as it is
    if ('tooBig' in raw) try { renameSync(file, `${file}.bad`) } catch { /* left */ }
    return undefined
  }
  let v: unknown
  try { v = JSON.parse(raw.toString('utf8')) } catch { setAside(file, raw); return undefined }
  if (!check(v)) { setAside(file, raw); return undefined }
  return v
}

/** Removes our temp files (`TMP`) in `dir` older than `olderThanMs`; anything else is never touched. */
export function sweepTemps(dir: string, olderThanMs = 60_000, now = Date.now()): string[] {
  const gone: string[] = []
  let names: string[]
  try { names = readdirSync(dir) } catch { return gone }
  for (const n of names) {
    if (!TMP.test(n)) continue
    const p = join(dir, n)
    try {
      const st = statSync(p)
      if (st.isFile() && now - st.mtimeMs > olderThanMs) { unlinkSync(p); gone.push(n) }
    } catch { /* went away */ }
  }
  return gone
}

// ---- debounced state writers ------------------------------------------------------------------------------------

export interface WriteHooks {
  /** false while the home cannot be written: a writer then keeps nothing */
  writable(): boolean
  /** a write failed (the pill, status.json, the log) or, with null, that file wrote again */
  noted(file: string, err: NodeJS.ErrnoException | null): void
}

export interface StateWriter<T> {
  set(v: T): void
  /** writes what waits now, synchronously (the quit) */
  flushSync(): void
  /** writes what waits now; resolves when written (or failed) */
  flush(): Promise<void>
  pending(): boolean
}

/** A JSON state file written whole, `debounceMs` after its last change. */
export function stateWriter<T>(file: string, debounceMs: number, hooks: WriteHooks): StateWriter<T> {
  let value: T | undefined
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const text = (v: T) => JSON.stringify(v, null, 2) + '\n'
  const write = async () => {
    timer = undefined
    if (!dirty || !hooks.writable()) return
    dirty = false
    try { await writeWhole(file, text(value as T)); hooks.noted(file, null) }
    catch (e) { hooks.noted(file, e as NodeJS.ErrnoException) }
  }
  return {
    set(v) {
      value = v
      dirty = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void write(), debounceMs)
      timer.unref?.()
    },
    flushSync() {
      if (timer) { clearTimeout(timer); timer = undefined }
      if (!dirty || !hooks.writable()) return
      dirty = false
      try { writeWholeSync(file, text(value as T)); hooks.noted(file, null) }
      catch (e) { hooks.noted(file, e as NodeJS.ErrnoException) }
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = undefined }
      await write()
    },
    pending: () => dirty,
  }
}
