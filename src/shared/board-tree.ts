/**
 * Board folders - the pure tree shared by the sidebar, the dev API, the build and the
 * tests. Files are the truth: a board says which folder it sits in (`folder` on the
 * board file, ranked among its siblings by `order`), and `design/boards/_folders.json`
 * says which folders exist and where they rank at the root. One level only: folders
 * hold boards, never folders. `all-scenes` never enters the tree - callers pin it last.
 */

/** The on-disk name grammar shared by boards and folders (a board name is a filename). */
export const BOARD_NAME = /^[a-z0-9][a-z0-9-]*$/
export const NAME_MAX = 64
export const isBoardName = (n: unknown): n is string => typeof n === 'string' && n.length >= 1 && n.length <= NAME_MAX && BOARD_NAME.test(n)

/** The folder registry beside the boards - underscore = infrastructure, never a board. */
export const FOLDERS_FILE = '_folders.json'
/** Is this basename in design/boards/ a board file? `_folders.json`, temp files and any
 *  off-grammar name are not - every lister (dev API, build, watcher) shares this rule. */
export const isBoardFile = (f: string): boolean => f.endsWith('.json') && isBoardName(f.slice(0, -5))

export type Folder = { kind: 'folder'; name: string; boards: string[] }
export type TreeItem = { kind: 'board'; name: string } | Folder

export interface BoardRow { name: string; order?: number; folder?: string }
export interface FolderRow { name: string; order?: number }

const rank = (o: number | undefined) => (typeof o === 'number' && Number.isFinite(o) ? o : Infinity)

/** The registry file's shape. Returns the rows, or a string naming what is wrong - a
 *  malformed registry is an ERROR the human must fix (silently reading it as empty would
 *  let the next drag overwrite their folders), while a missing file is simply no folders. */
export function parseFolders(raw: unknown): FolderRow[] | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'expected an object'
  const { version, folders } = raw as { version?: unknown; folders?: unknown }
  if (version !== undefined && version !== 1) return `unsupported version ${String(version)}`
  if (!Array.isArray(folders)) return 'expected a "folders" array'
  const out: FolderRow[] = []
  const seen = new Set<string>()
  for (const f of folders) {
    const name = (f as { name?: unknown })?.name
    if (!isBoardName(name)) return 'a folder needs a name - lowercase letters, numbers and dashes'
    if (seen.has(name)) return `folder "${name}" is listed twice`
    seen.add(name)
    const o = (f as { order?: unknown }).order
    out.push({ name, ...(typeof o === 'number' && Number.isFinite(o) ? { order: o } : {}) })
  }
  return out
}

/** Sidebar order from the files. Root: boards with no folder + every folder (registered
 *  or implied by a board), ranked by `order` then kind (board before folder) then name.
 *  Inside a folder: its boards by `order` then name. Unranked sorts after ranked. */
export function buildTree(boards: BoardRow[], folders: FolderRow[]): TreeItem[] {
  const folderOrder = new Map<string, number | undefined>()
  for (const f of folders) if (isBoardName(f.name) && !folderOrder.has(f.name)) folderOrder.set(f.name, f.order)
  const members = new Map<string, BoardRow[]>()
  const rootBoards: BoardRow[] = []
  for (const b of boards) {
    if (!isBoardName(b.name) || b.name === 'all-scenes') continue
    const folder = isBoardName(b.folder) ? b.folder : undefined
    if (!folder) { rootBoards.push(b); continue }
    if (!folderOrder.has(folder)) folderOrder.set(folder, undefined)   // implied by the board alone
    const list = members.get(folder) ?? []
    list.push(b)
    members.set(folder, list)
  }
  const byRank = (a: BoardRow, b: BoardRow) => rank(a.order) - rank(b.order) || a.name.localeCompare(b.name)
  type Root = { item: TreeItem; order: number | undefined }
  const root: Root[] = [
    ...rootBoards.map((b) => ({ item: { kind: 'board', name: b.name } as TreeItem, order: b.order })),
    ...[...folderOrder].map(([name, order]) => ({
      item: { kind: 'folder', name, boards: (members.get(name) ?? []).sort(byRank).map((b) => b.name) } as TreeItem,
      order,
    })),
  ]
  root.sort((a, b) => rank(a.order) - rank(b.order) || (a.item.kind === b.item.kind ? 0 : a.item.kind === 'board' ? -1 : 1) || a.item.name.localeCompare(b.item.name))
  return root.map((r) => r.item)
}

/** Every board in reading order - the order the switchers and the landing pick use. */
export function flatten(tree: TreeItem[]): string[] {
  const out: string[] = []
  for (const it of tree) { if (it.kind === 'board') out.push(it.name); else out.push(...it.boards) }
  return out
}

/** The wire shape of a tree write (`POST boards/reorder`): plain strings for root boards,
 *  `{ folder, boards }` for folders - what the sidebar posts and what the server validates. */
export type WireItem = string | { folder: string; boards: string[] }
export const toWire = (tree: TreeItem[]): WireItem[] =>
  tree.map((it) => (it.kind === 'board' ? it.name : { folder: it.name, boards: [...it.boards] }))
export const fromWire = (wire: WireItem[]): TreeItem[] =>
  wire.map((w) => (typeof w === 'string' ? { kind: 'board', name: w } : { kind: 'folder', name: w.folder, boards: [...w.boards] }))

/** Validate a wire tree off the network. Returns the error, or null when it is sound:
 *  every name on-grammar, `all-scenes` nowhere, no board twice, no folder twice, no
 *  nesting (a folder's boards are strings), bounded. */
export const TREE_MAX_BOARDS = 200
export const TREE_MAX_FOLDERS = 50
export function validateWire(wire: unknown): string | null {
  if (!Array.isArray(wire)) return 'invalid tree'
  const boards = new Set<string>(), folders = new Set<string>()
  const board = (n: unknown): string | null => {
    if (!isBoardName(n) || n === 'all-scenes') return 'invalid board name in tree'
    if (boards.has(n)) return `board "${n}" appears twice`
    boards.add(n)
    return null
  }
  for (const w of wire) {
    if (typeof w === 'string') { const e = board(w); if (e) return e; continue }
    if (!w || typeof w !== 'object' || Array.isArray(w)) return 'invalid tree item'
    const { folder, boards: kids } = w as { folder?: unknown; boards?: unknown }
    if (!isBoardName(folder)) return 'invalid folder name in tree'
    if (folders.has(folder)) return `folder "${folder}" appears twice`
    folders.add(folder)
    if (!Array.isArray(kids)) return 'invalid folder in tree'
    for (const k of kids) { const e = board(k); if (e) return e }
  }
  if (boards.size > TREE_MAX_BOARDS || folders.size > TREE_MAX_FOLDERS) return 'tree too large'
  return null
}

/** What the human types becomes a slug: "Old stuff" → "old-stuff". Empty when nothing
 *  survives - the caller keeps the input open and says so. Always on-grammar or empty. */
export function slugify(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, NAME_MAX).replace(/-+$/g, '')
  return isBoardName(s) ? s : ''
}

// ---- tree mutations (pure; the sidebar shows the result at once and persists it) ----

export const cloneTree = (t: TreeItem[]): TreeItem[] => t.map((it) => (it.kind === 'board' ? { ...it } : { ...it, boards: [...it.boards] }))
export const rootIndex = (t: TreeItem[], kind: TreeItem['kind'], name: string) => t.findIndex((it) => it.kind === kind && it.name === name)
export const folderIn = (t: TreeItem[], name: string): Folder | undefined => t.find((it): it is Folder => it.kind === 'folder' && it.name === name)
export const folderOf = (t: TreeItem[], board: string): string | null => t.find((it): it is Folder => it.kind === 'folder' && it.boards.includes(board))?.name ?? null
export const boardsIn = (t: TreeItem[]): string[] => flatten(t)
export const foldersIn = (t: TreeItem[]): string[] => t.filter((it) => it.kind === 'folder').map((it) => it.name)

/** Remove a board wherever it sits; returns the list it left (root = null) and its index there. */
export function takeBoard(t: TreeItem[], board: string): { list: string | null; index: number } | null {
  const ri = rootIndex(t, 'board', board)
  if (ri >= 0) { t.splice(ri, 1); return { list: null, index: ri } }
  for (const it of t) {
    if (it.kind !== 'folder') continue
    const i = it.boards.indexOf(board)
    if (i >= 0) { it.boards.splice(i, 1); return { list: it.name, index: i } }
  }
  return null
}

/** What is being dragged, and where it may land: a slot in a list (root = null) or the
 *  inside of a folder (appended at its end). */
export type Drag = { kind: TreeItem['kind']; name: string }
export type Drop = { list: string | null; index: number } | { into: string }

/** The row under the pointer, measured by the DOM and handed here as plain facts. */
export interface Hit {
  kind: TreeItem['kind']; name: string
  parent: string | null      // the folder a board row lives in
  below: boolean             // pointer in the lower half of the row
  topEdge: boolean           // pointer in the top 30% of the row (folder rows: "before me")
  gutter: boolean            // pointer left of a child row's indent (the root gutter = outdent)
}

/** The drop target for a drag over a row, or null. Boards land in any slot - root or inside
 *  a folder - or INTO a folder; folders land in root slots only. Over a folder's child row the
 *  root gutter means "after that folder" (the natural outdent). `all-scenes` = root end. */
export function resolveDrop(t: TreeItem[], d: Drag, hit: Hit): Drop | null {
  if (hit.kind === 'folder') {
    const fi = rootIndex(t, 'folder', hit.name)
    if (fi < 0) return null
    if (d.kind === 'folder') return { list: null, index: hit.below ? fi + 1 : fi }
    return hit.topEdge ? { list: null, index: fi } : { into: hit.name }   // top edge = before; the rest = inside
  }
  if (hit.name === 'all-scenes') return { list: null, index: t.length }   // over the pinned last row = root end slot
  if (hit.parent) {
    const pi = rootIndex(t, 'folder', hit.parent)
    if (pi < 0) return null
    if (d.kind === 'folder' || hit.gutter) return { list: null, index: pi + 1 }   // after that folder
    const i = folderIn(t, hit.parent)?.boards.indexOf(hit.name) ?? -1
    return i < 0 ? null : { list: hit.parent, index: hit.below ? i + 1 : i }
  }
  const i = rootIndex(t, 'board', hit.name)
  return i < 0 ? null : { list: null, index: hit.below ? i + 1 : i }
}

/** A target that would leave the item where it is: nothing to show, nothing to drop. Into
 *  the folder a board already sits in means "to its end" - a no-op only when it is last. */
export function isOwnSlot(t: TreeItem[], d: Drag, target: Drop): boolean {
  if ('into' in target) {
    if (d.kind !== 'board') return true
    const f = folderIn(t, target.into)
    return !!f && f.boards[f.boards.length - 1] === d.name
  }
  let from = -1
  if (d.kind === 'folder') from = target.list === null ? rootIndex(t, 'folder', d.name) : -1
  else if (target.list === null) from = rootIndex(t, 'board', d.name)
  else from = folderIn(t, target.list)?.boards.indexOf(d.name) ?? -1
  return from >= 0 && (target.index === from || target.index === from + 1)
}

/** The tree after a drop, or null when the drop is impossible on this tree. */
export function applyDrop(tree: TreeItem[], d: Drag, target: Drop): TreeItem[] | null {
  const next = cloneTree(tree)
  if (d.kind === 'folder') {
    if ('into' in target || target.list !== null) return null
    const from = rootIndex(next, 'folder', d.name)
    if (from < 0) return null
    const [it] = next.splice(from, 1)
    next.splice(target.index > from ? target.index - 1 : target.index, 0, it!)   // removing `from` shifts later slots left
    return next
  }
  const src = takeBoard(next, d.name)
  if (!src) return null
  if ('into' in target) {
    const f = folderIn(next, target.into)
    if (!f) return null
    f.boards.push(d.name)
    return next
  }
  const to = src.list === target.list && target.index > src.index ? target.index - 1 : target.index
  if (target.list === null) { next.splice(Math.min(to, next.length), 0, { kind: 'board', name: d.name }); return next }
  const f = folderIn(next, target.list)
  if (!f) return null
  f.boards.splice(Math.min(to, f.boards.length), 0, d.name)
  return next
}

/** Move a board into a folder (at its end) or to the root at `atRoot` (default: the end). */
export function moveBoard(tree: TreeItem[], board: string, folder: string | null, atRoot?: number): TreeItem[] | null {
  const next = cloneTree(tree)
  if (!takeBoard(next, board)) return null
  if (folder === null) { next.splice(Math.min(atRoot ?? next.length, next.length), 0, { kind: 'board', name: board }); return next }
  const f = folderIn(next, folder)
  if (!f) return null
  f.boards.push(board)
  return next
}

/** A new folder at root `index`, holding `board` (pulled from wherever it sat) when given. */
export function createFolder(tree: TreeItem[], name: string, index: number, board?: string): TreeItem[] | null {
  if (foldersIn(tree).includes(name)) return null
  const next = cloneTree(tree)
  const boards: string[] = []
  if (board) { if (!takeBoard(next, board)) return null; boards.push(board) }
  next.splice(Math.min(index, next.length), 0, { kind: 'folder', name, boards })
  return next
}

export function renameFolder(tree: TreeItem[], from: string, to: string): TreeItem[] | null {
  if (from === to) return cloneTree(tree)
  if (foldersIn(tree).includes(to)) return null
  const next = cloneTree(tree)
  const f = folderIn(next, from)
  if (!f) return null
  f.name = to
  return next
}

/** Folders organise, never own: deleting one puts its boards back at the root, in its slot, in order. */
export function deleteFolder(tree: TreeItem[], name: string): TreeItem[] | null {
  const next = cloneTree(tree)
  const i = rootIndex(next, 'folder', name)
  if (i < 0) return null
  const f = next[i] as Folder
  next.splice(i, 1, ...f.boards.map((b): TreeItem => ({ kind: 'board', name: b })))
  return next
}

/** Where "Move to new folder" puts the folder: the board's own root slot, or right after the
 *  folder it sits in. */
export const newFolderSlot = (tree: TreeItem[], board: string): number => {
  const parent = folderOf(tree, board)
  return parent ? rootIndex(tree, 'folder', parent) + 1 : Math.max(0, rootIndex(tree, 'board', board))
}
