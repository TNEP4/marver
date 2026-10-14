/**
 * Sidebar marks, the dev server's half (spec 25): when each frame last changed, and which change
 * you have seen. Local only - `design/.local/` is never committed and never published.
 *
 * Changed = the latest of the frame file's mtime, its sticky note's, and `changes.json` - an agent
 * naming the frame in `work done` (an edit to a shared kit it imports), or the frame first appearing
 * under a new id (a rename keeps the file's old mtime). A git pull moves mtimes too.
 * Seen = `seen.json`: { version, baseline, ids, frames: { id: the change stamp you saw } }. Its first
 * read sets the baseline to now, so everything already on the canvas that day counts as seen.
 * A "seen" is the stamp the page displayed, never a clock: an edit landing after you looked is new.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { noteFileFor, type Manifest } from './manifest.ts'
import { checkBoardsDir, checkRealDirs, listBoardFiles } from './boards.ts'
import type { Marks } from '../shared/marks.ts'

/** `ids`: the frames the canvas had at the last read - null before the first, when nothing counts as
 *  added; `notes`: those that had a sticky note then (a note gone since, even while dev was off, is a change). */
interface Seen { version: 1; baseline: number; ids: string[] | null; notes?: string[]; frames: Record<string, number> }

const dir = (root: string) => join(root, 'design', '.local')
const read = (file: string): any => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
/** Writes stay inside the project: a symlinked design/ or .local is refused (as boards.ts refuses). */
const write = (root: string, name: string, data: unknown) => {
  if (checkRealDirs(root, [[join(root, 'design'), 'design'], [dir(root), 'design/.local']])) return
  mkdirSync(dir(root), { recursive: true })
  const file = join(dir(root), name), tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(data) + '\n')
  renameSync(tmp, file)
}
const stamps = (o: any): Record<string, number> =>
  o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) as Record<string, number> : {}

export function readSeen(root: string): Seen {
  const f = read(join(dir(root), 'seen.json'))
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((i: unknown): i is string => typeof i === 'string') : null)
  if (f && typeof f.baseline === 'number') return { version: 1, baseline: f.baseline, ids: strs(f.ids), notes: strs(f.notes) ?? [], frames: stamps(f.frames) }
  const fresh: Seen = { version: 1, baseline: Date.now(), ids: null, frames: {} }
  write(root, 'seen.json', fresh)
  return fresh
}

/** You saw these frames at these change stamps. Never lowers a stamp; drops ids the canvas no longer has. */
export function markSeen(root: string, seen: Record<string, number>, known: ReadonlySet<string>): void {
  const s = readSeen(root)
  for (const [id, at] of Object.entries(stamps(seen))) if (known.has(id)) s.frames[id] = Math.max(s.frames[id] ?? 0, at)
  for (const id of Object.keys(s.frames)) if (!known.has(id)) delete s.frames[id]
  write(root, 'seen.json', s)
}

const readChanges = (root: string) => stamps(read(join(dir(root), 'changes.json'))?.frames)
/** These frames changed now, whatever their files say (`work done`, or a frame new under its id). */
export function recordChanged(root: string, ids: readonly string[], known?: ReadonlySet<string>): void {
  const c = readChanges(root), now = Date.now()
  for (const id of ids) c[id] = now
  if (known) for (const id of Object.keys(c)) if (!known.has(id)) delete c[id]
  write(root, 'changes.json', { version: 1, frames: c })
}

const mtime = (abs: string): number => { try { return statSync(abs).mtimeMs } catch { return 0 } }

export function readMarks(root: string, manifest: Manifest): Marks {
  const all = manifest.frames.map((f) => f.id)
  const known = new Set(all)
  // a frame under an id this canvas has not had before (added, or renamed - which keeps its mtime)
  // changed now; the very first read has no list yet, and everything then counts as seen
  const seen = readSeen(root)
  const noteAt: Record<string, number> = {}
  for (const f of manifest.frames) noteAt[f.id] = mtime(noteFileFor(join(root, f.file)))
  const notes = all.filter((id) => noteAt[id] > 0)
  const had = seen.ids ? new Set(seen.ids) : null
  const added = had ? all.filter((id) => !had.has(id)) : []
  const noteGone = had ? (seen.notes ?? []).filter((id) => known.has(id) && !noteAt[id]) : []
  const removed = had ? [...had].some((id) => !known.has(id)) : false
  if (added.length || noteGone.length || removed) recordChanged(root, [...added, ...noteGone], known)   // prunes the gone too
  if (!had || had.size !== all.length || added.length || noteGone.length || notes.length !== (seen.notes ?? []).length) {
    const frames = Object.fromEntries(Object.entries(seen.frames).filter(([id]) => known.has(id)))
    write(root, 'seen.json', { ...seen, ids: all, notes, frames })
    seen.frames = frames
  }
  const done = readChanges(root)
  const changed: Record<string, number> = {}
  for (const f of manifest.frames) changed[f.id] = Math.max(mtime(join(root, f.file)), noteAt[f.id], done[f.id] ?? 0)
  // each board's live frames: an auto board (All Scenes) holds them all; a curated one, the frames
  // it pins that still exist
  const boards: Record<string, string[]> = { 'all-scenes': all }
  const boardsDir = join(root, 'design', 'boards')
  if (existsSync(boardsDir) && !checkBoardsDir(root, boardsDir)) for (const b of listBoardFiles(boardsDir).boards) {
    const j = b.json as { auto?: unknown; nodes?: unknown } | null
    if (!j || b.name === 'all-scenes') continue
    boards[b.name] = j.auto === true ? all
      : Array.isArray(j.nodes) ? j.nodes.map((n) => (n as { frame?: unknown })?.frame).filter((f): f is string => typeof f === 'string' && known.has(f)) : []
  }
  return { changed, seen: seen.frames, baseline: seen.baseline, boards }
}
