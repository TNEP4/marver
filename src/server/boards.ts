/**
 * Reading design/boards/ safely - the one enumerator the dev API, the build and the tests
 * share. Only REGULAR files on the board-name grammar count as boards (a symlink, dangling or
 * live, could read or publish JSON from outside the project - it is skipped, and reported so
 * the build can fail closed). The folder registry is read the same way: absent = no folders,
 * malformed = an error the human must fix, never a silently empty registry.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, sep } from 'node:path'
import { hash } from './hash.ts'   // not manifest.ts: manifest imports this module
import { ALL_SCENES, archiveLast, buildTree, flatten, folderMap, FOLDERS_FILE, framesOn, isBoardFile, isBoardName, parseFolders, readDescription, readTitle, REGISTRY_VERSION_FLAT, REGISTRY_VERSION_NESTED, type FolderRow } from '../shared/board-tree.ts'
import { readCapability, readReason, readStatusWord, readType, resolveType } from '../shared/board-types.ts'

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

export interface BoardFile { name: string; file: string; content: string; sha256: string; json: unknown | null; error?: string }

/** A board file's JSON, or why it is not JSON - the parser's own words, naming the line and column (#6). */
export function parseBoard(content: string): { json: unknown; error?: string } {
  try { return { json: JSON.parse(content) } } catch (e) {
    // V8 names the line and column - except at end of input, where we point at the end ourselves
    const msg = (e as Error).message, lines = content.split('\n')
    return { json: null, error: /end of JSON input$/.test(msg) ? `${msg} (line ${lines.length} column ${lines[lines.length - 1].length + 1})` : msg }
  }
}

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
    // malformed: listed, carries no fields, and says why
    boards.push({ name: f.slice(0, -5), file, content, sha256: hash(content), ...parseBoard(content) })
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

/** Which board shows which frame (spec 26, Part 7): every board in sidebar order with archive boards
 *  last, the live frames each shows (shared/board-tree `framesOn`), and the frames on none. */
export interface Membership { boards: { name: string; frames: string[] }[]; unplaced: string[] }
export function readMembership(root: string, live: readonly string[]): Membership {
  const dir = join(root, 'design', 'boards')
  const files = checkBoardsDir(root, dir) ? [] : listBoardFiles(dir).boards
  const reg = readRegistry(dir)
  const folders = reg.state === 'ok' ? reg.folders : []
  const rows = files.map((b) => ({ name: b.name, ...boardFields(b.json, isBoardName) }))
  const tree = buildTree(rows, folders)
  // a board's type is its own, else its folder's, else that folder's parent's (spec 20)
  const fm = folderMap(tree)
  const byName = new Map(folders.map((f) => [f.name, f]))
  const isArchive = (n: string) => {
    const folder = byName.get(fm.get(n) ?? '')
    return n === 'archive' || resolveType(rows.find((r) => r.name === n)?.type, folder?.type, folder?.parent ? byName.get(folder.parent)?.type : undefined) === 'archive'
  }
  const boards = archiveLast(flatten(tree), isArchive).map((name) => ({ name, frames: framesOn(files.find((b) => b.name === name)?.json, live) }))
  const on = new Set(boards.flatMap((b) => b.frames))
  return { boards, unplaced: live.filter((f) => !on.has(f)) }
}

/** What to say about frames on no board, one line each: the boards holding its scene's other frames,
 *  and the command that pins it - what `work done`, `marver link` and `comments new` print. */
export function unplacedHint(m: Membership, frames: readonly string[]): string[] {
  return frames.map((f) => {
    const scene = f.split('/')[0]
    const homes = m.boards.filter((b) => b.frames.some((x) => x !== f && x.split('/')[0] === scene)).map((b) => b.name)
    return `${f} is on no board${homes.length ? ` (its scene's other frames are on ${homes.join(', ')})` : ''} - pin it where it belongs: npx marver boards pin ${homes[0] ?? '<board>'} ${f}`
  })
}

/** `boards pin`: append frames to a board as nodes - the shell sizes and lays them out, as for any
 *  node an agent appends. A frame the board already shows is skipped (every frame, on an `auto`
 *  board). Never creates a board; a malformed one is the human's to fix. */
export function pinFrames(root: string, board: string, frames: readonly string[], live: readonly string[]): { added: string[]; already: string[] } {
  if (!isBoardName(board) || board === ALL_SCENES) throw new Error(`"${board}" is not a board name - lowercase letters, numbers and dashes`)
  const dir = join(root, 'design', 'boards')
  const de = checkBoardsDir(root, dir)
  if (de) throw new Error(de)
  const file = join(dir, `${board}.json`)
  if (!isRegularFile(file)) throw new Error(`no board "${board}" in design/boards/ - make it first (npx marver boards new ${board})`)
  const content = readFileSync(file, 'utf8')
  const { json, error } = parseBoard(content)
  if (error || !json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`design/boards/${board}.json is not a board object - fix the file${error ? ` (${error})` : ''}`)
  const shown = new Set(framesOn(json, live))
  const already = frames.filter((f) => shown.has(f))
  const added = [...new Set(frames.filter((f) => !shown.has(f)))]
  if (!added.length) return { added, already }
  const obj = json as { nodes?: unknown }
  obj.nodes = [...(Array.isArray(obj.nodes) ? obj.nodes : []), ...added.map((frame) => ({ frame }))]
  // a temp file renamed over the board, and only over the file as read: a write that landed
  // meanwhile (the shell's autosave, another agent) is never overwritten
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { flag: 'wx' })
  if (readFileSync(file, 'utf8') !== content) { rmSync(tmp, { force: true }); throw new Error(`design/boards/${board}.json changed while pinning - try again`) }
  renameSync(tmp, file)
  return { added, already }
}
