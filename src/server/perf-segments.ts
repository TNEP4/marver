/**
 * Segments (spec 30 R9 #42-#45): every perf log is a live file plus closed segments, deleted whole by age. The
 * primitives the writers share - the dev server's (perf.ts: page, reloads, runs), Jam's (perf-jam.ts) and the Mac
 * app's (app/src/main/perflog.ts: app and samples) - and the one reader every reader goes through (the CLI's views,
 * `--all`, the app's report). Node only; each writer keeps its own state and its own queue, and calls these in it.
 *
 * - A segment is `<name>.<openedAt>-<bound>.jsonl` (perf-records.ts `segmentName`): `bound` a conservative newest time,
 *   the later of its close and the largest `ts` written into it, since line times are event times and arrive out of
 *   order - neither a segment's first line nor the next segment's says how new its lines are.
 * - A live file the writer did not open itself (adopted after a restart, or a 0.29 file at the first 0.30 start, #45)
 *   has no tracked maximum: its `openedAt` is its first line's `ts` (one line read) and its bound its mtime + 24 h at
 *   the close (the server's cleaner keeps a page's clock within 24 h of its own, perf.ts `cleanPageRecord`).
 * - Closing is a rename (O(1)); retention an unlink of a segment whose bound is past the days kept, never a read or a
 *   rewrite; the safety cap (#43) deletes the oldest segments while the file's total passes it, and says how many
 *   lines went (that rare case reads the segment it deletes to count them: a record never lies).
 */
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { KEEP_DAYS, parseSegmentName, SEGMENT_MAX_AGE_MS, SEGMENTS, segmentName, type SegmentedFile } from '../shared/perf-records.ts'

const DAY = 86_400_000
/** #42: an adopted file's bound - its mtime plus the clock skew a line's `ts` may carry. */
export const ADOPTED_SKEW_MS = DAY

export interface Segment { name: string; path: string; openedAt: number; bound: number; size: number }

/** A closed segment of `file` in `dir`, oldest first (by `openedAt`, then name). A link or anything not a regular file is no segment. */
export function segmentsOf(dir: string, file: SegmentedFile): Segment[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const out: Segment[] = []
  for (const name of names) {
    const p = parseSegmentName(file, name)
    if (!p) continue
    const path = join(dir, name)
    try { const st = lstatSync(path); if (st.isFile()) out.push({ name, path, ...p, size: st.size }) } catch { /* gone */ }
  }
  return out.sort((a, b) => a.openedAt - b.openedAt || a.name.localeCompare(b.name))
}

/** A line's `ts`: the first `"ts":` (every writer puts the envelope's first), else the parsed line's; null when it has none. */
export function lineTs(line: string): number | null {
  const m = /"ts":(\d{10,16})(?:[.,}\]])/.exec(line)
  if (m) return Number(m[1])
  try { const o = JSON.parse(line) as { ts?: unknown }; return typeof o?.ts === 'number' && Number.isFinite(o.ts) ? o.ts : null } catch { return null }
}

/** The first whole line's `ts`, reading at most 64 KB (#45: one line read). */
export function firstLineTs(path: string): number | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const b = Buffer.alloc(65_536)
    const n = readSync(fd, b, 0, b.length, 0)
    const text = b.subarray(0, n).toString('utf8')
    const nl = text.indexOf('\n')
    return nl > 0 ? lineTs(text.slice(0, nl)) : null
  } catch { return null } finally { if (fd !== undefined) try { closeSync(fd) } catch { /* closed */ } }
}

/** What a writer keeps of its live file: when it was opened, the largest `ts` written into it (0: none tracked), its
 *  size, whether it was adopted (no tracked maximum before this process), and its inode (removed by hand: forgotten). */
export interface LiveState { openedAt: number; maxTs: number; adopted: boolean; size: number; ino: number }

/** The live file as this writer finds it the first time: adopted when it exists (openedAt its first line's ts, else
 *  its mtime), null when there is none. Throws for a path that is not a regular file. */
export function adoptLive(path: string): LiveState | null {
  let st
  try { st = lstatSync(path) } catch { return null }
  if (!st.isFile()) throw new Error('not a regular file')
  return { openedAt: firstLineTs(path) ?? st.mtimeMs, maxTs: 0, adopted: true, size: st.size, ino: st.ino }
}

/** The live file is due to close: opened 24 h ago or past its segment size. */
export const dueToClose = (file: SegmentedFile, s: LiveState, now: number): boolean =>
  s.size > 0 && (now - s.openedAt >= SEGMENT_MAX_AGE_MS || s.size >= SEGMENTS[file].segmentBytes)

/** The bound a live file closes with (#42): the later of the close and its largest ts; an adopted one's - no tracked
 *  maximum for what came before this writer - its mtime + 24 h (#45), which bounds every line in it. */
export function boundOf(path: string, s: LiveState, now: number): number {
  if (!s.adopted) return Math.ceil(Math.max(now, s.maxTs))
  let m: number
  try { m = statSync(path).mtimeMs } catch { m = now }
  return Math.ceil(Math.max(s.maxTs, m + ADOPTED_SKEW_MS))
}

/** Closes the live file `file` in `dir` as a segment: a rename, never a copy. The segment's path, or null when there
 *  was nothing to close. A name already taken (two closes in one ms) takes a later bound - still conservative. */
export function closeLive(dir: string, file: SegmentedFile, s: LiveState, now: number): string | null {
  const live = join(dir, file)
  if (!existsSync(live)) return null
  let bound = boundOf(live, s, now)
  const openedAt = Math.min(Math.floor(s.openedAt), bound)
  let to = join(dir, segmentName(file, openedAt, bound))
  for (let i = 0; existsSync(to) && i < 1000; i++) to = join(dir, segmentName(file, openedAt, ++bound))
  renameSync(live, to)
  return to
}

/** Retention (#42): every closed segment of `file` whose bound is more than `days` old, unlinked - never read. How many went. */
export function pruneAged(dir: string, file: SegmentedFile, now: number, days = KEEP_DAYS): number {
  let n = 0
  for (const s of segmentsOf(dir, file)) {
    if (s.bound >= now - days * DAY) continue
    try { unlinkSync(s.path); n++ } catch { /* gone, or not ours to remove */ }
  }
  return n
}

/** Lines in a file: its newline bytes (a torn last line counts as one). */
function countLines(path: string): number {
  try {
    const b = readFileSync(path)
    let n = 0
    for (let i = b.indexOf(0x0a); i >= 0; i = b.indexOf(0x0a, i + 1)) n++
    return b.length && b[b.length - 1] !== 0x0a ? n + 1 : n
  } catch { return 0 }
}

/** The safety cap (#43): while the file's segments and live file pass `cap` bytes, its oldest segment goes. The
 *  segments and lines that went (zero when it held). */
export function enforceCap(dir: string, file: SegmentedFile, liveSize: number, cap = SEGMENTS[file].capBytes): { segments: number; lines: number } {
  const segs = segmentsOf(dir, file)
  let total = liveSize + segs.reduce((n, s) => n + s.size, 0)
  const out = { segments: 0, lines: 0 }
  for (const s of segs) {
    if (total <= cap) break
    const lines = countLines(s.path)
    try { unlinkSync(s.path) } catch { continue }
    total -= s.size
    out.segments++
    out.lines += lines
  }
  return out
}

/**
 * Every line of `file` in `dir`: its segments in `openedAt` order, then the live file (#42). A segment whose bound is
 * before `since` holds nothing from then and is not read. A live file closed while it was read is followed into its
 * segment by its inode, from where the read ended, so nothing is skipped or read twice.
 */
export function readSegmented(dir: string, file: SegmentedFile, since = 0): string[] {
  const out: string[] = []
  const before = segmentsOf(dir, file)
  const seen = new Set(before.map((s) => s.name))
  const push = (text: string) => { for (const l of text.split('\n')) if (l) out.push(l) }
  for (const s of before) { if (s.bound >= since) { try { push(readFileSync(s.path, 'utf8')) } catch { /* gone meanwhile */ } } }
  let ino = -1, read = 0
  const live = join(dir, file)
  let fd: number | undefined
  try {
    if (lstatSync(live).isFile()) {
      fd = openSync(live, 'r')
      ino = fstatSync(fd).ino
      const b = readAll(fd, 0)
      read = b.length
      push(b.toString('utf8'))
    }
  } catch { /* none */ } finally { if (fd !== undefined) try { closeSync(fd) } catch { /* closed */ } }
  for (const s of segmentsOf(dir, file)) {
    if (seen.has(s.name)) continue
    try {
      // the live file just read, closed since: only what was appended after the read
      if (statSync(s.path).ino === ino) { const f = openSync(s.path, 'r'); try { push(readAll(f, read).toString('utf8')) } finally { closeSync(f) } }
      else if (s.bound >= since) push(readFileSync(s.path, 'utf8'))
    } catch { /* gone meanwhile */ }
  }
  return out
}

function readAll(fd: number, from: number): Buffer {
  const chunks: Buffer[] = []
  let pos = from
  for (;;) {
    const b = Buffer.alloc(1 << 20)
    const n = readSync(fd, b, 0, b.length, pos)
    if (n <= 0) break
    chunks.push(b.subarray(0, n))
    pos += n
  }
  return Buffer.concat(chunks)
}

/** Every line from `since` as an object with a numeric `ts` (malformed lines skipped). */
export function readSegmentedRecords(dir: string, file: SegmentedFile, since = 0): Record<string, any>[] {
  return readSegmented(dir, file, since).flatMap((l) => {
    try { const e = JSON.parse(l); return e && typeof e === 'object' && typeof e.ts === 'number' && e.ts >= since ? [e] : [] } catch { return [] }
  })
}
