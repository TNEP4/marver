/**
 * Reading design/boards/ safely - the one enumerator the dev API, the build and the tests
 * share. Only REGULAR files on the board-name grammar count as boards (a symlink, dangling or
 * live, could read or publish JSON from outside the project - it is skipped, and reported so
 * the build can fail closed). The folder registry is read the same way: absent = no folders,
 * malformed = an error the human must fix, never a silently empty registry.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { hash } from './manifest.ts'
import { FOLDERS_FILE, isBoardFile, parseFolders, type FolderRow } from '../shared/board-tree.ts'

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
  // every EXISTING component from the root down (design, design/boards) must be a real
  // directory - a symlinked `design` with no boards dir yet would otherwise be followed by
  // the mkdir that creates it
  const design = join(boardsDir, '..')
  for (const [p, label] of [[design, 'design'], [boardsDir, 'design/boards']] as const) {
    try { if (lstatSync(p).isSymbolicLink()) return `${label} must be a real directory, not a symlink` } catch { return null }   // absent = fine, nothing beneath it exists either
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

/** The author-owned sidebar fields off a board's JSON, leniently. */
export function boardFields(json: unknown, validName: (n: unknown) => n is string): { order?: number; folder?: string } {
  const o = json as { order?: unknown; folder?: unknown } | null
  return {
    ...(typeof o?.order === 'number' && Number.isFinite(o.order) ? { order: o.order } : {}),
    ...(validName(o?.folder) ? { folder: o.folder } : {}),
  }
}

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
