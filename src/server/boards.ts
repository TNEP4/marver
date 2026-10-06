/**
 * Reading design/boards/ safely - the one enumerator the dev API, the build and the tests
 * share. Only REGULAR files on the board-name grammar count as boards (a symlink, dangling or
 * live, could read or publish JSON from outside the project - it is skipped, and reported so
 * the build can fail closed). The folder registry is read the same way: absent = no folders,
 * malformed = an error the human must fix, never a silently empty registry.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { hash } from './hash.ts'   // not manifest.ts: manifest imports this module
import { FOLDERS_FILE, isBoardFile, parseFolders, readDescription, readTitle, REGISTRY_VERSION_FLAT, REGISTRY_VERSION_NESTED, type FolderRow } from '../shared/board-tree.ts'
import { readCapability, readReason, readStatusWord, readType } from '../shared/board-types.ts'

/** Does realpath(dir) stay inside realpath(root)? A symlinked design/boards can't escape. */
export function underRoot(root: string, dir: string): boolean {
  try {
    const rr = realpathSync(root); const rd = realpathSync(dir)
    return rd === rr || rd.startsWith(rr + sep)
  } catch { return false }
}

/** Is design/boards a directory we may read and write? It must not be a symlink at all (a
 *  link to the repo root would list package.json as a board and let a tree write rewrite
 *  it; a link outside would publish foreign JSON) and must resolve inside the root. Absent
 *  is fine (no boards yet). Returns the error, or null. */
export function checkBoardsDir(root: string, boardsDir: string): string | null {
  return checkRealDirs(root, [[join(boardsDir, '..'), 'design'], [boardsDir, 'design/boards']])
}

/** Every EXISTING path in `dirs` (root-down order) must be a real directory inside the root -
 *  a symlinked `design` with no boards dir yet would otherwise be followed by the mkdir that
 *  creates it; a symlinked `design/scenes` would let a brief write land outside the project.
 *  An absent one ends the walk (nothing beneath it exists either). Returns the error, or null. */
export function checkRealDirs(root: string, dirs: readonly (readonly [string, string])[]): string | null {
  for (const [p, label] of dirs) {
    try { if (lstatSync(p).isSymbolicLink()) return `${label} must be a real directory, not a symlink` } catch { return null }
    if (!underRoot(root, p)) return `${label} escapes the project`
  }
  return null
}

/** A regular file (lstat: a symlink is never followed, a dangling one is not "absent"). */
export const isRegularFile = (p: string): boolean => { try { return lstatSync(p).isFile() } catch { return false } }
/** Is there ANY node at p (a dangling symlink counts)? */
export const nodeExists = (p: string): boolean => { try { lstatSync(p); return true } catch { return false } }

export interface BoardFile { name: string; file: string; content: string; sha256: string; json: unknown | null }

/** Every board file: name, raw content, hash, and its JSON (null when malformed). `skipped`
 *  names the entries that looked like boards but were not regular files. */
export function listBoardFiles(boardsDir: string): { boards: BoardFile[]; skipped: string[] } {
  const boards: BoardFile[] = [], skipped: string[] = []
  if (!existsSync(boardsDir)) return { boards, skipped }
  for (const f of readdirSync(boardsDir)) {
    if (!isBoardFile(f)) continue
    const file = join(boardsDir, f)
    if (!isRegularFile(file)) { skipped.push(f); continue }
    const content = readFileSync(file, 'utf8')
    let json: unknown = null
    try { json = JSON.parse(content) } catch { /* malformed: listed, but carries no fields */ }
    boards.push({ name: f.slice(0, -5), file, content, sha256: hash(content), json })
  }
  return { boards, skipped }
}

/** The author-owned sidebar fields off a board's JSON, leniently: rank, folder, the title
 *  humans see, the sentence agents read, and what spec 20 adds - the board's type, the
 *  capability it shows, and a decision on its status (with its reason). */
export interface BoardFields { order?: number; folder?: string; title?: string; description?: string; type?: string; capability?: string; status?: string; reason?: string }
export function boardFields(json: unknown, validName: (n: unknown) => n is string): BoardFields {
  const o = json as { order?: unknown; folder?: unknown; title?: unknown; description?: unknown; type?: unknown; capability?: unknown; status?: unknown; reason?: unknown } | null
  const title = readTitle(o?.title)
  const description = readDescription(o?.description)
  const type = readType(o?.type), capability = readCapability(o?.capability), status = readStatusWord(o?.status), reason = readReason(o?.reason)
  return {
    ...(typeof o?.order === 'number' && Number.isFinite(o.order) ? { order: o.order } : {}),
    ...(validName(o?.folder) ? { folder: o.folder } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(type ? { type } : {}),
    ...(capability ? { capability } : {}),
    ...(status ? { status } : {}),
    ...(reason ? { reason } : {}),
  }
}

/** The fields a board's file owns that the shell's save shape never carries: an autosave keeps
 *  each one from disk when the incoming board omits it (spec 20 - the fields survive every write). */
export const AUTHOR_FIELDS = ['order', 'folder', 'title', 'description', 'type', 'capability', 'status', 'reason'] as const

export type Registry =
  | { state: 'absent'; folders: []; sha256: null }
  | { state: 'ok'; folders: FolderRow[]; sha256: string }
  | { state: 'malformed'; error: string; sha256: string | null }

/** The folder registry. `sha256` is the CAS token a tree write must echo (null = "there was
 *  no file"), so a write can never silently replace a registry it never saw. */
export function readRegistry(boardsDir: string): Registry {
  const p = join(boardsDir, FOLDERS_FILE)
  if (!nodeExists(p)) return { state: 'absent', folders: [], sha256: null }
  if (!isRegularFile(p)) return { state: 'malformed', error: `design/boards/${FOLDERS_FILE} must be a regular file, not a symlink`, sha256: null }
  const content = readFileSync(p, 'utf8')
  let raw: unknown
  try { raw = JSON.parse(content) } catch { return { state: 'malformed', error: `design/boards/${FOLDERS_FILE} is not valid JSON - fix the file`, sha256: hash(content) } }
  const parsed = parseFolders(raw)
  if (typeof parsed === 'string') return { state: 'malformed', error: `design/boards/${FOLDERS_FILE}: ${parsed}`, sha256: hash(content) }
  return { state: 'ok', folders: parsed, sha256: hash(content) }
}

/** The registry's write lock - one writer at a time across processes (the dev server's tree write,
 *  `folders add`, `init --kind`), so a read-modify-write of `_folders.json` is atomic among Marver's
 *  writers. A lock older than 10 s is a crashed writer's and is taken over. `wait` = how long to
 *  try (the CLI waits; the dev server never blocks its event loop - it answers 409 instead). */
export const REGISTRY_LOCK = '.folders.lock'
export function withRegistryLock<T>(dir: string, wait: number, fn: () => T): T | null {
  const lock = join(dir, REGISTRY_LOCK)
  const t0 = Date.now()
  for (;;) {
    try { writeFileSync(lock, `${process.pid} ${Date.now()}\n`, { flag: 'wx' }); break }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try { if (Date.now() - lstatSync(lock).mtimeMs > 10_000) { rmSync(lock, { force: true }); continue } } catch { continue }
      if (Date.now() - t0 >= wait) return null
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  try { return fn() } finally { rmSync(lock, { force: true }) }
}

/** Append typed folders to the registry (spec 20: `init --kind`, `folders add`). Never renames,
 *  moves or retypes a folder that exists - a name already registered is skipped and reported - and
 *  never drops a field of an existing entry it does not manage. New folders rank after everything
 *  already at the root. The write is compare-and-swap: the registry is re-read just before the
 *  atomic rename, and a change since the first read (the shell's drag, another agent) starts the
 *  append over from the new file. A malformed registry is an error, never overwritten. */
export function addFolders(root: string, folders: { name: string; title?: string; type?: string }[]): { added: string[]; existing: string[] } {
  const dir = join(root, 'design', 'boards')
  const de = checkBoardsDir(root, dir)
  if (de) throw new Error(de)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, FOLDERS_FILE)
  const done = withRegistryLock(dir, 5_000, () => appendFolders(dir, file, folders))
  if (!done) throw new Error(`design/boards/${FOLDERS_FILE} is being written by another process - try again`)
  return done
}

function appendFolders(dir: string, file: string, folders: { name: string; title?: string; type?: string }[]): { added: string[]; existing: string[] } {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = nodeExists(file) ? readFileSync(file, 'utf8') : null
    const reg = readRegistry(dir)
    if (reg.state === 'malformed') throw new Error(reg.error)
    let raw: Record<string, unknown>[] = []
    if (before !== null) {
      const j = JSON.parse(before) as { folders?: unknown }
      raw = Array.isArray(j.folders) ? (j.folders as Record<string, unknown>[]) : []
    }
    const have = new Set(raw.map((f) => f.name))
    const rootRanks = [
      ...raw.filter((f) => f.parent === undefined).map((f) => f.order),
      ...listBoardFiles(dir).boards.map((b) => { const o = b.json as { folder?: unknown; order?: unknown } | null; return o?.folder ? undefined : o?.order }),
    ].filter((o): o is number => typeof o === 'number' && Number.isFinite(o))
    let next = rootRanks.length ? Math.max(...rootRanks) + 1 : 0
    const added: string[] = [], existing: string[] = []
    const rows = [...raw]
    for (const f of folders) {
      if (have.has(f.name)) { existing.push(f.name); continue }
      rows.push({ name: f.name, order: next++, ...(f.title ? { title: f.title } : {}), ...(f.type ? { type: f.type } : {}) })
      have.add(f.name)
      added.push(f.name)
    }
    if (!added.length) return { added, existing }
    const version = rows.some((f) => f.parent !== undefined) ? REGISTRY_VERSION_NESTED : REGISTRY_VERSION_FLAT
    const tmp = `${file}.${process.pid}.${Date.now()}.${attempt}.tmp`
    writeFileSync(tmp, JSON.stringify({ version, folders: rows }, null, 2) + '\n', { flag: 'wx' })
    const now = nodeExists(file) ? readFileSync(file, 'utf8') : null
    if (now !== before) { rmSync(tmp, { force: true }); continue }   // someone wrote it meanwhile: start over from theirs
    renameSync(tmp, file)
    return { added, existing }
  }
  throw new Error(`design/boards/${FOLDERS_FILE} kept changing while folders were added - try again`)
}
