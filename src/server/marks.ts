/**
 * Sidebar marks, the dev server's half (spec 25, made exact by spec 26): which frames changed, and
 * which change you have seen. Local only - `design/.local/` is never committed and never published.
 *
 * Marks count REVISIONS, never clock times. One counter; every recorded change takes the next
 * number. Per frame, `changed` is the last revision that touched it in any way and `doc` the last
 * one that needs a new document to be seen (its file, or anything it reads); a sticky note or an
 * agent's `work done` raises `changed` alone. `seen` is the revision you last acknowledged: a frame
 * is new when changed > seen. An `epoch`, made with the state and kept across restarts, changes on
 * a reset, so an acknowledgement from before it is refused.
 *
 * The clock starts when `marver dev` starts (initMarks): everything on the canvas then counts as
 * seen, and every frame's dependency fingerprint is kept (deps.json), so a later boot sees what
 * changed while dev was off. The dev server is the only writer; the state lives in memory and is
 * written through. `projectMarks` is the read-only view the CLI prints.
 *
 *   changes.json  { version: 2, epoch, rev, frames: { id: [changed, doc] } }
 *   seen.json     { version: 2, epoch, frames: { id: rev } }
 *   deps.json     { version: 2, fp: { id: [doc, note, app fingerprints] } }
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { noteFileFor, type FrameEntry, type Manifest } from './manifest.ts'
import { checkBoardsDir, checkRealDirs, listBoardFiles } from './boards.ts'
import { fingerprints } from './deps.ts'
import type { Marks } from '../shared/marks.ts'

type Frames = readonly Pick<FrameEntry, 'id' | 'file' | 'kind'>[]
interface State { epoch: string; rev: number; changed: Record<string, number>; doc: Record<string, number>; seen: Record<string, number>; fp: Record<string, string[]> | null }

const dir = (root: string) => join(root, 'design', '.local')
/** Writes stay inside the project: a symlinked design/ or .local is refused (as boards.ts refuses). */
const write = (root: string, name: string, data: unknown) => {
  if (checkRealDirs(root, [[join(root, 'design'), 'design'], [dir(root), 'design/.local']])) return
  mkdirSync(dir(root), { recursive: true })
  const file = join(dir(root), name), tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(data) + '\n')
  renameSync(tmp, file)
}

/** A file's JSON: `undefined` when it does not exist, `null` when it is not valid, and a throw when
 *  the disk refuses the read - which is no reason to reset anything. */
const readJson = (root: string, name: string): unknown => {
  let text: string
  try { text = readFileSync(join(dir(root), name), 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  try { return JSON.parse(text) } catch { return null }
}
const rev = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const newEpoch = () => randomBytes(6).toString('hex')
const fresh = (): State => ({ epoch: newEpoch(), rev: 0, changed: {}, doc: {}, seen: {}, fp: null })

const states = new Map<string, State | 'off'>()

/** Loads the state from disk: the v2 files; a 0.24 state converted (what was new stays new); or a
 *  fresh one. `null` = invalid (a reset is due). Never writes. */
function load(root: string, frames: Frames): State | null {
  const c = readJson(root, 'changes.json'), s = readJson(root, 'seen.json'), d = readJson(root, 'deps.json')
  const fp = obj(d) && d.version === 2 && obj(d.fp) && Object.values(d.fp).every((v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'string')) ? d.fp as Record<string, string[]> : null
  if (c === undefined && s === undefined) return fresh()
  if (obj(s) && s.version === 1) return convert(root, frames, c, s)
  if (!obj(c) || !obj(s) || c.version !== 2 || s.version !== 2 || typeof c.epoch !== 'string' || c.epoch !== s.epoch || !rev(c.rev) || !obj(c.frames) || !obj(s.frames)) return null
  const st: State = { epoch: c.epoch, rev: c.rev, changed: {}, doc: {}, seen: {}, fp }
  for (const [id, v] of Object.entries(c.frames)) {
    if (!Array.isArray(v) || !rev(v[0]) || !rev(v[1]) || v[0] > c.rev || v[1] > v[0]) return null
    st.changed[id] = v[0]; st.doc[id] = v[1]
  }
  for (const [id, v] of Object.entries(s.frames)) { if (!rev(v) || v > c.rev) return null; st.seen[id] = v }
  return st
}

/** 0.24 kept clock stamps (spec 25): a frame new under that rule becomes `changed 1, doc 0` - new,
 *  and acknowledged by any look; everything else starts seen. */
function convert(root: string, frames: Frames, c: unknown, s: Record<string, unknown>): State {
  const st = fresh()
  const num = (o: unknown, id: string) => (obj(o) && typeof o[id] === 'number' && Number.isFinite(o[id]) ? o[id] as number : 0)
  const mtime = (rel: string) => { try { return statSync(join(root, rel)).mtimeMs } catch { return 0 } }
  const baseline = typeof s.baseline === 'number' && Number.isFinite(s.baseline) ? s.baseline : Infinity
  const done = obj(c) ? c.frames : undefined
  for (const f of frames) {
    const changed = Math.max(mtime(f.file), mtime(noteFileFor(f.file)), num(done, f.id))
    if (changed > Math.max(num(s.frames, f.id), baseline)) { st.changed[f.id] = 1; st.doc[f.id] = 0; st.rev = 1 }
  }
  return st
}

function persist(root: string, st: State, deps = false) {
  write(root, 'changes.json', { version: 2, epoch: st.epoch, rev: st.rev, frames: Object.fromEntries(Object.keys(st.changed).map((id) => [id, [st.changed[id], st.doc[id] ?? 0]])) })
  write(root, 'seen.json', { version: 2, epoch: st.epoch, frames: st.seen })
  if (deps && st.fp) write(root, 'deps.json', { version: 2, fp: st.fp })
}

/** The live state, loaded on first use. A state the disk refuses to read turns marks off for this
 *  session (nothing is reset); an invalid one starts over, said once. */
function state(root: string, frames: Frames): State | null {
  const have = states.get(root)
  if (have) return have === 'off' ? null : have
  let st: State | null
  try { st = load(root, frames) } catch (e) {
    console.warn(`[marver] marks are off for this session - design/.local could not be read (${(e as Error).message})`)
    states.set(root, 'off')
    return null
  }
  if (!st) {
    console.warn('[marver] the sidebar marks in design/.local were unreadable - starting over: everything on the canvas counts as seen')
    st = fresh()
  }
  states.set(root, st)
  observe(root, frames)
  return st
}

/** Records a change to these frames: one new revision for the batch. `doc` = it needs a new document
 *  to be seen (an edit to the frame or to what it reads); a note or `work done` does not. */
export function recordChanged(root: string, frames: Frames, ids: readonly string[], opts: { doc: boolean }): number | null {
  const st = state(root, frames)
  const known = new Set(frames.map((f) => f.id))
  const hit = [...new Set(ids)].filter((id) => known.has(id))
  if (!st || !hit.length) return null
  st.rev++
  for (const id of hit) { st.changed[id] = st.rev; if (opts.doc) st.doc[id] = st.rev }
  persist(root, st)
  return st.rev
}

/** Looks at the frames as they are on disk now and records what moved since the last look: a frame
 *  added (a new id - a rename too), its file or anything it reads (doc), its sticky note (note
 *  only). The first look of a canvas only remembers. Returns the frames it recorded. */
export function observe(root: string, frames: Frames): { doc: string[]; note: string[] } {
  const st = states.get(root)
  const out = { doc: [] as string[], note: [] as string[] }
  if (!st || st === 'off') return out
  const now = fingerprints(root, frames)
  const was = st.fp
  if (was) for (const f of frames) {
    const a = was[f.id], b = now[f.id]
    if (!a || a[0] !== b[0]) out.doc.push(f.id)
    else if (a[1] !== b[1] || a[2] !== b[2]) out.note.push(f.id)   // a note, or app code Fast Refresh applies in place
  }
  const known = new Set(frames.map((f) => f.id))
  const pruned = [st.changed, st.doc, st.seen].some((m) => Object.keys(m).some((id) => !known.has(id)))
  for (const m of [st.changed, st.doc, st.seen]) for (const id of Object.keys(m)) if (!known.has(id)) delete m[id]
  const moved = !was || out.doc.length || out.note.length || Object.keys(was).length !== frames.length
  st.fp = now
  if (out.doc.length || out.note.length) {
    st.rev++
    for (const id of out.doc) st.changed[id] = st.doc[id] = st.rev
    for (const id of out.note) st.changed[id] = st.rev
  }
  if (moved || pruned) persist(root, st, true)
  return out
}

/** The clock starts here, when `marver dev` starts - before any page asks. */
export function initMarks(root: string, frames: Frames): void {
  states.delete(root)
  try { state(root, frames) } catch (e) { console.warn(`[marver] sidebar marks could not start: ${(e as Error).message}`) }
}

/** You saw these frames at these revisions. Refused (false) from another epoch; never lowers. */
export function markSeen(root: string, frames: Frames, epoch: unknown, seen: Record<string, unknown>): boolean {
  const st = state(root, frames)
  if (!st || epoch !== st.epoch) return false
  const known = new Set(frames.map((f) => f.id))
  for (const [id, v] of Object.entries(seen)) if (known.has(id) && rev(v)) st.seen[id] = Math.max(st.seen[id] ?? 0, Math.min(v, st.rev))
  persist(root, st)
  return true
}

/** A frame's `doc` revision: the stamp a document of it is served with. */
export function docRev(root: string, frames: Frames, id: string): string {
  const st = state(root, frames)
  return st ? `${st.epoch}:${st.doc[id] ?? 0}` : ''
}
export function docRevs(root: string, frames: Frames): { epoch: string; doc: Record<string, number> } | null {
  const st = state(root, frames)
  return st ? { epoch: st.epoch, doc: { ...st.doc } } : null
}

const snapshot = (root: string, manifest: Manifest, st: State): Marks => {
  const all = manifest.frames.map((f) => f.id)
  const known = new Set(all)
  const pick = (m: Record<string, number>) => Object.fromEntries(all.filter((id) => m[id]).map((id) => [id, m[id]]))
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
  return { epoch: st.epoch, changed: pick(st.changed), doc: pick(st.doc), seen: pick(st.seen), boards }
}

export function readMarks(root: string, manifest: Manifest): Marks | null {
  const st = state(root, manifest.frames)
  return st && snapshot(root, manifest, st)
}

/** The marks as the next `marver dev` would see them, from the files alone - nothing is written, so
 *  looking never starts the clock. `null` before the first `marver dev` on 0.25. */
export function projectMarks(root: string, manifest: Manifest): Marks | null {
  const c = readJson(root, 'changes.json'), s = readJson(root, 'seen.json')
  if (c === undefined && s === undefined) return null
  const st = load(root, manifest.frames)
  if (!st) return null
  if (st.fp) {
    const now = fingerprints(root, manifest.frames)
    const was = st.fp
    const doc = manifest.frames.filter((f) => !was[f.id] || was[f.id][0] !== now[f.id][0]).map((f) => f.id)
    const note = manifest.frames.filter((f) => was[f.id] && was[f.id][0] === now[f.id][0] && (was[f.id][1] !== now[f.id][1] || was[f.id][2] !== now[f.id][2])).map((f) => f.id)
    if (doc.length || note.length) { st.rev++; for (const id of doc) st.changed[id] = st.doc[id] = st.rev; for (const id of note) st.changed[id] = st.rev }
  }
  return snapshot(root, manifest, st)
}

/** Tests only: forget the in-memory state, as a restart would. */
export function resetMarksMemory(root?: string): void { if (root) states.delete(root); else states.clear() }
