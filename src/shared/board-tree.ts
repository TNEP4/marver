/**
 * Board folders - the pure tree shared by the sidebar, the dev API, the build and the
 * tests. Files are the truth: a board says which folder it sits in (`folder` on the
 * board file - one slug, the folder it sits in directly), ranked among its siblings by
 * `order`, and `design/boards/_folders.json` says which folders exist, where they rank, and
 * which folder holds which (`parent`). Two levels: a folder holds boards and folders, a
 * folder inside a folder (a sub-folder) holds boards only. `all-scenes` never enters the
 * tree - callers pin it last.
 */

import { readType } from './board-types.ts'

/** The on-disk name grammar shared by boards and folders (a board name is a filename). */
export const BOARD_NAME = /^[a-z0-9][a-z0-9-]*$/
export const NAME_MAX = 64
export const isBoardName = (n: unknown): n is string => typeof n === 'string' && n.length >= 1 && n.length <= NAME_MAX && BOARD_NAME.test(n)

/** The folder registry beside the boards - underscore = infrastructure, never a board. */
export const FOLDERS_FILE = '_folders.json'
/** Is this basename in design/boards/ a board file? `_folders.json`, temp files and any
 *  off-grammar name are not - every lister (dev API, build, watcher) shares this rule. */
export const isBoardFile = (f: string): boolean => f.endsWith('.json') && isBoardName(f.slice(0, -5))

/** A folder and what it holds, in order: boards, and - in a top-level folder only - sub-folders. */
export type Folder = { kind: 'folder'; name: string; items: TreeItem[]; title?: string; description?: string; type?: string }
export type TreeItem = { kind: 'board'; name: string } | Folder

export interface BoardRow { name: string; order?: number; folder?: string; title?: string }
export interface FolderRow { name: string; order?: number; parent?: string; title?: string; description?: string; type?: string }

/** A description off a file: one sentence, trimmed, capped - absent when empty or not a string. */
export const DESCRIPTION_MAX = 300
export const readDescription = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const s = v.trim().replace(/\s+/g, ' ').slice(0, DESCRIPTION_MAX)
  return s || undefined
}

/** A title off a file - what humans see, free text: any casing, punctuation, emoji. Control
 *  characters dropped, whitespace collapsed, capped in code points (never half a surrogate
 *  pair). Absent when empty or not a string; the display then falls back to the slug. */
export const TITLE_MAX = 120
export const readTitle = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const s = Array.from(v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ')).slice(0, TITLE_MAX).join('').trim()
  return s || undefined
}
/** Title Case off a slug - the display when no title is set ("old-stuff" → "Old Stuff"). */
export const humanize = (s: string): string => s.replace(/-/g, ' ').replace(/(^|\s)\S/g, (c) => c.toUpperCase())
/** What a board, folder or scene is called on screen: its title, else its humanized slug. */
export const labelOf = (name: string, title?: string): string => title ?? humanize(name)

const rank = (o: number | undefined) => (typeof o === 'number' && Number.isFinite(o) ? o : Infinity)
/** A folder's title, description and type, present only when set. */
const folderExtras = (it: { title?: string; description?: string; type?: string }) => ({
  ...(it.title ? { title: it.title } : {}),
  ...(it.description ? { description: it.description } : {}),
  ...(readType(it.type) ? { type: it.type } : {}),
})

/** The registry versions this code reads. Version 2 is written only when a folder has a
 *  `parent`, so a flat registry stays readable by every Marver; an older Marver refuses a
 *  version-2 file as malformed instead of rewriting it without its nesting. */
export const REGISTRY_VERSION_FLAT = 1
export const REGISTRY_VERSION_NESTED = 2
/** The tree-write protocol a shell speaks. A shell that predates nesting reads a nested
 *  registry flat (it ignores `parent`) and would post that flat tree back with a perfectly
 *  current hash - the hash proves freshness, not understanding - so the server refuses a write
 *  without this marker whenever the registry on disk nests. */
export const TREE_PROTOCOL = 2

/** The registry file's shape. Returns the rows, or a string naming what is wrong - a
 *  malformed registry is an ERROR the human must fix (silently reading it as empty, or
 *  flattening a broken nesting, would let the next drag overwrite their folders), while a
 *  missing file is simply no folders. */
export function parseFolders(raw: unknown): FolderRow[] | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'expected an object'
  const { version, folders } = raw as { version?: unknown; folders?: unknown }
  if (version !== undefined && version !== REGISTRY_VERSION_FLAT && version !== REGISTRY_VERSION_NESTED) return `unsupported version ${String(version)}`
  if (!Array.isArray(folders)) return 'expected a "folders" array'
  const out: FolderRow[] = []
  const seen = new Set<string>()
  for (const f of folders) {
    const name = (f as { name?: unknown })?.name
    if (!isBoardName(name)) return 'a folder needs a name - lowercase letters, numbers and dashes'
    if (seen.has(name)) return `folder "${name}" is listed twice`
    seen.add(name)
    const o = (f as { order?: unknown }).order
    const p = (f as { parent?: unknown }).parent
    if (p !== undefined && !isBoardName(p)) return `folder "${name}" has an invalid parent - a folder name`
    const t = readTitle((f as { title?: unknown }).title)
    const d = readDescription((f as { description?: unknown }).description)
    const ty = readType((f as { type?: unknown }).type)
    out.push({ name, ...(typeof o === 'number' && Number.isFinite(o) ? { order: o } : {}), ...(p !== undefined ? { parent: p } : {}), ...(t ? { title: t } : {}), ...(d ? { description: d } : {}), ...(ty ? { type: ty } : {}) })
  }
  const byName = new Map(out.map((f) => [f.name, f]))
  for (const f of out) {
    if (f.parent === undefined) continue
    if (version !== REGISTRY_VERSION_NESTED) return `folder "${f.name}" names a parent - nested folders need "version": 2`
    if (f.parent === f.name) return `folder "${f.name}" cannot be its own parent`
    const p = byName.get(f.parent)
    if (!p) return `folder "${f.name}" names an unknown parent "${f.parent}"`
    if (p.parent !== undefined) return `folder "${f.name}" would sit three levels deep - folders nest one level only`
  }
  return out
}

/** Sidebar order from the files. At every level the boards and folders there share one
 *  sequence, ranked by `order`, then kind (board before folder), then name; unranked sorts
 *  after ranked. The root holds root boards and top-level folders (registered without a
 *  parent, or implied by a board that names an unregistered folder); a top-level folder holds
 *  its boards and its sub-folders; a sub-folder holds its boards. A folder's title and
 *  description and type ride on its item (they live in the registry a tree write rewrites); a board's
 *  title stays with its row - it lives in the board's own file. */
export function buildTree(boards: BoardRow[], folders: FolderRow[]): TreeItem[] {
  const reg = new Map<string, FolderRow>()
  for (const f of folders) if (isBoardName(f.name) && !reg.has(f.name)) reg.set(f.name, f)
  // a parent the registry does not hold as a top-level folder leaves the child top-level -
  // parseFolders refuses such files; this keeps buildTree total for any rows it is handed
  const parentOf = (n: string): string | undefined => {
    const p = reg.get(n)?.parent
    return p !== undefined && p !== n && reg.has(p) && reg.get(p)!.parent === undefined ? p : undefined
  }
  const members = new Map<string, BoardRow[]>()
  const implied: string[] = []
  const rootBoards: BoardRow[] = []
  for (const b of boards) {
    if (!isBoardName(b.name) || b.name === 'all-scenes') continue
    const folder = isBoardName(b.folder) ? b.folder : undefined
    if (!folder) { rootBoards.push(b); continue }
    if (!reg.has(folder) && !implied.includes(folder)) implied.push(folder)   // implied by the board alone: always top-level
    const list = members.get(folder) ?? []
    list.push(b)
    members.set(folder, list)
  }
  type Ranked = { item: TreeItem; order: number | undefined }
  const sorted = (xs: Ranked[]): TreeItem[] =>
    xs.sort((a, b) => rank(a.order) - rank(b.order) || (a.item.kind === b.item.kind ? 0 : a.item.kind === 'board' ? -1 : 1) || a.item.name.localeCompare(b.item.name)).map((r) => r.item)
  const boardsHere = (name: string | null): Ranked[] =>
    (name === null ? rootBoards : members.get(name) ?? []).map((b) => ({ item: { kind: 'board', name: b.name }, order: b.order }))
  const folder = (name: string, kids: Ranked[]): Ranked =>
    ({ item: { kind: 'folder', name, items: sorted(kids), ...folderExtras(reg.get(name) ?? {}) }, order: reg.get(name)?.order })
  const subsOf = (top: string) => [...reg.keys()].filter((n) => parentOf(n) === top)
  const tops = [...[...reg.keys()].filter((n) => !parentOf(n)), ...implied]
  return sorted([
    ...boardsHere(null),
    ...tops.map((t) => folder(t, [...boardsHere(t), ...subsOf(t).map((s) => folder(s, boardsHere(s)))])),
  ])
}

/** Every board in reading order, depth-first - the order the switchers and the landing pick use. */
export function flatten(tree: TreeItem[]): string[] {
  const out: string[] = []
  const walk = (items: TreeItem[]) => { for (const it of items) { if (it.kind === 'board') out.push(it.name); else walk(it.items) } }
  walk(tree)
  return out
}

/** The wire shape of a tree write (`POST boards/reorder`): plain strings for boards,
 *  `{ folder, items }` for folders, `items` holding boards and - one level down - folders.
 *  What the sidebar posts and the server validates. A folder's title, description and type ride
 *  with it (they live in the registry the write rewrites); a board's title lives in its own
 *  file and never rides the tree. A one-level `{ folder, boards }` item (an older shell) is
 *  still read. */
export type WireItem = string | { folder: string; items: WireItem[]; title?: string; description?: string; type?: string }
type WireIn = string | { folder: string; items?: WireIn[]; boards?: string[]; title?: string; description?: string; type?: string }
export const toWire = (tree: TreeItem[]): WireItem[] =>
  tree.map((it) => (it.kind === 'board' ? it.name : { folder: it.name, items: toWire(it.items), ...folderExtras(it) }))
export const wireKids = (w: Exclude<WireIn, string>): WireIn[] => w.items ?? w.boards ?? []
export const fromWire = (wire: WireIn[]): TreeItem[] =>
  wire.map((w) => (typeof w === 'string' ? { kind: 'board', name: w } : { kind: 'folder', name: w.folder, items: fromWire(wireKids(w)), ...folderExtras(w) }))

/** Validate a wire tree off the network. Returns the error, or null when it is sound:
 *  every name on-grammar, `all-scenes` nowhere, no board twice, no folder twice, folders
 *  two levels deep at most, bounded. */
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
  const walk = (list: unknown[], depth: number): string | null => {
    for (const w of list) {
      if (typeof w === 'string') { const e = board(w); if (e) return e; continue }
      if (!w || typeof w !== 'object' || Array.isArray(w)) return 'invalid tree item'
      if (depth >= 2) return 'folders nest one level only'
      const { folder, items, boards: legacy, title, description, type } = w as { folder?: unknown; items?: unknown; boards?: unknown; title?: unknown; description?: unknown; type?: unknown }
      if (!isBoardName(folder)) return 'invalid folder name in tree'
      if (title !== undefined && (typeof title !== 'string' || Array.from(title).length > TITLE_MAX)) return 'invalid folder title'
      if (description !== undefined && (typeof description !== 'string' || description.length > DESCRIPTION_MAX)) return 'invalid folder description'
      if (type !== undefined && !readType(type)) return 'invalid folder type'
      if (folders.has(folder)) return `folder "${folder}" appears twice`
      folders.add(folder)
      const kids = items ?? legacy
      if (!Array.isArray(kids)) return 'invalid folder in tree'
      if (items === undefined && kids.some((k) => typeof k !== 'string')) return 'invalid folder in tree'   // a one-level item holds boards only
      const e = walk(kids, depth + 1)
      if (e) return e
    }
    return null
  }
  const e = walk(wire, 0)
  if (e) return e
  if (boards.size > TREE_MAX_BOARDS || folders.size > TREE_MAX_FOLDERS) return 'tree too large'
  return null
}

/** What the human types becomes a slug: "Old stuff" → "old-stuff". Empty when nothing
 *  survives - the caller keeps the input open and says so. Always on-grammar or empty. */
export function slugify(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, NAME_MAX).replace(/-+$/g, '')
  return isBoardName(s) ? s : ''
}

// ---- reading the tree ----

/** A deep copy: mutations work on it and the caller's tree stays as it was (a folder's
 *  title, description and type ride along). */
export const cloneTree = (t: TreeItem[]): TreeItem[] => t.map((it) => (it.kind === 'board' ? { ...it } : { ...it, items: cloneTree(it.items) }))
/** Every folder with the folder it sits in (null = the root), top-level folders first in
 *  reading order, each followed by its sub-folders. */
export function folderEntries(t: TreeItem[]): { folder: Folder; parent: string | null }[] {
  const out: { folder: Folder; parent: string | null }[] = []
  for (const it of t) {
    if (it.kind !== 'folder') continue
    out.push({ folder: it, parent: null })
    for (const k of it.items) if (k.kind === 'folder') out.push({ folder: k, parent: it.name })
  }
  return out
}
/** A folder anywhere in the tree. */
export const folderIn = (t: TreeItem[], name: string): Folder | undefined => folderEntries(t).find((e) => e.folder.name === name)?.folder
/** The folder a folder sits in - null for a top-level folder (or one that is not there). */
export const parentOf = (t: TreeItem[], name: string): string | null => folderEntries(t).find((e) => e.folder.name === name)?.parent ?? null
/** Every board's folder, in one pass - for callers that ask for many boards (folderOf walks the tree). */
export function folderMap(t: TreeItem[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const { folder } of folderEntries(t)) for (const k of folder.items) if (k.kind === 'board') out.set(k.name, folder.name)
  return out
}
/** The folder a board sits in directly, at either level - null at the root. */
export function folderOf(t: TreeItem[], board: string): string | null {
  for (const { folder } of folderEntries(t)) if (folder.items.some((k) => k.kind === 'board' && k.name === board)) return folder.name
  return null
}
export const boardsIn = (t: TreeItem[]): string[] => flatten(t)
export const foldersIn = (t: TreeItem[]): string[] => folderEntries(t).map((e) => e.folder.name)
/** Does this folder hold folders? Such a folder can only ever sit at the root. */
export const hasSubfolders = (f: Folder): boolean => f.items.some((k) => k.kind === 'folder')
/** The list a slot lives in: the root (null) or a folder's items. */
export const listIn = (t: TreeItem[], list: string | null): TreeItem[] | undefined => (list === null ? t : folderIn(t, list)?.items)
/** Where an item sits in a list, or -1. */
export const indexIn = (t: TreeItem[], list: string | null, kind: TreeItem['kind'], name: string): number =>
  listIn(t, list)?.findIndex((it) => it.kind === kind && it.name === name) ?? -1
export const rootIndex = (t: TreeItem[], kind: TreeItem['kind'], name: string) => indexIn(t, null, kind, name)
/** How deep a list sits: the root 0, a top-level folder's items 1, a sub-folder's items 2. */
export const depthOf = (t: TreeItem[], list: string | null): number => (list === null ? 0 : parentOf(t, list) === null ? 1 : 2)

/** Remove an item wherever it sits; returns the list it left (root = null), its index there
 *  and the item itself. */
export function takeItem(t: TreeItem[], kind: TreeItem['kind'], name: string): { list: string | null; index: number; item: TreeItem } | null {
  const lists: (string | null)[] = [null, ...foldersIn(t)]
  for (const list of lists) {
    const items = listIn(t, list)!
    const i = items.findIndex((it) => it.kind === kind && it.name === name)
    if (i >= 0) { const [item] = items.splice(i, 1); return { list, index: i, item: item! } }
  }
  return null
}
/** Remove a board wherever it sits; returns the list it left (root = null) and its index there. */
export function takeBoard(t: TreeItem[], board: string): { list: string | null; index: number } | null {
  const r = takeItem(t, 'board', board)
  return r ? { list: r.list, index: r.index } : null
}

// ---- drag and drop ----

/** What is being dragged, and where it may land: a slot in a list (root = null) or the
 *  inside of a folder (appended at its end). */
export type Drag = { kind: TreeItem['kind']; name: string }
export type Drop = { list: string | null; index: number } | { into: string }

/** A row the sidebar rendered, measured - the list as the human sees it, top to bottom,
 *  the pinned `all-scenes` row included (it is the root's end). `parent` is the folder the
 *  row sits in (null = the root) and `depth` that list's depth (0 root, 1 a top-level
 *  folder's items, 2 a sub-folder's). `open` is a folder's disclosure; `left` is the row's
 *  left edge, from which the indent of each level is measured. */
export interface Row { kind: TreeItem['kind']; name: string; parent: string | null; depth: number; open?: boolean; top: number; bottom: number; left: number }
/** Px each level of nesting indents its rows; the seams inside draw from there too. */
export const INDENT = 28

/** How deep the dragged item may land: a board anywhere (2), a folder without sub-folders
 *  inside a top-level folder (1), a folder holding sub-folders at the root only (0). */
function landingDepth(t: TreeItem[], d: Drag): number {
  if (d.kind === 'board') return 2
  const f = folderIn(t, d.name)
  return f && !hasSubfolders(f) ? 1 : 0
}

/** The drop target for a pointer at (x, y) over the rendered rows - never null inside the
 *  list (the ends clamp), so a release anywhere over the sidebar lands somewhere the seam
 *  showed. INTO: the middle band of a folder header (a closed one: its lower band too), when
 *  what is dragged may sit inside it. Otherwise the nearest gap by row midlines. A gap inside
 *  a list belongs to it. A gap where lists END - after the last row of a folder, or under an
 *  open empty folder - is shared by every level that ends there, down to the level of the row
 *  below; the row under the pointer decides: still over the row above, the deepest level whose
 *  indent the pointer reaches; over the row below (or past it), that row's own level. A folder
 *  never lands inside itself; one that holds sub-folders moves between root items only, each
 *  root item one block. */
export function resolveDrop(t: TreeItem[], d: Drag, rows: Row[], x: number, y: number): Drop | null {
  const mid = (r: { top: number; bottom: number }) => (r.top + r.bottom) / 2
  const deepest = landingDepth(t, d)
  if (deepest === 0) {
    const blocks: { top: number; bottom: number }[] = []
    for (const r of rows) {
      if (r.depth > 0 && blocks.length) { blocks[blocks.length - 1]!.bottom = r.bottom; continue }
      blocks.push({ top: r.top, bottom: r.bottom })
    }
    let g = 0
    for (const b of blocks) if (y >= mid(b)) g++
    return { list: null, index: Math.min(g, t.length) }
  }
  // what a dragged folder holds is never a place to land; its own header stays in the
  // geometry, so a wobble over it resolves to its own slot - a no-op, never an eviction
  const rs = d.kind === 'folder' ? rows.filter((r) => r.parent !== d.name && !(r.parent && parentOf(t, r.parent) === d.name)) : rows
  for (const r of rs) {
    if (r.kind !== 'folder' || (d.kind === 'folder' && r.name === d.name) || y < r.top || y >= r.bottom || r.depth + 1 > deepest) continue
    const f = (y - r.top) / (r.bottom - r.top)
    if (f >= 0.25 && (f < 0.75 || !r.open)) return { into: r.name }
  }
  let g = 0
  for (const r of rs) if (y >= mid(r)) g++
  const above = rs[g - 1], below = rs[g]
  if (!above) return { list: null, index: 0 }
  if (above.name === 'all-scenes') return { list: null, index: t.length }
  type Slot = { list: string | null; index: number; depth: number }
  // the deepest slot the gap can mean: inside an open folder, under its header - or right after the row above, in its own list
  let first: Slot
  if (above.kind === 'folder' && above.open && !(d.kind === 'folder' && above.name === d.name)) first = { list: above.name, index: 0, depth: above.depth + 1 }
  else {
    const i = indexIn(t, above.parent, above.kind, above.name)
    if (i < 0) return null
    first = { list: above.parent, index: i + 1, depth: above.depth }
  }
  // then, level by level up to the root: right after the folder that holds the slot before
  const chain: Slot[] = [first]
  for (let s = first; s.list !== null;) {
    const up = parentOf(t, s.list)
    const i = indexIn(t, up, 'folder', s.list)
    if (i < 0) return null
    s = { list: up, index: i + 1, depth: s.depth - 1 }
    chain.push(s)
  }
  const floor = below ? below.depth : 0
  const slots = chain.filter((s) => s.depth >= floor && s.depth <= deepest)
  const strip = (s: Slot): Drop => ({ list: s.list, index: s.index })
  if (!slots.length) { const s = chain.find((c) => c.depth <= deepest); return s ? strip(s) : null }
  if (slots.length === 1) return strip(slots[0]!)
  if (y < above.bottom) for (const s of slots) if (x >= above.left + s.depth * INDENT) return strip(s)
  return strip(slots[slots.length - 1]!)
}

/** A target that would leave the item where it is: nothing to show, nothing to drop. Into
 *  the folder an item already sits in means "to its end" - a no-op only when it is last. */
export function isOwnSlot(t: TreeItem[], d: Drag, target: Drop): boolean {
  if ('into' in target) {
    const f = folderIn(t, target.into)
    const last = f?.items[f.items.length - 1]
    return !!last && last.kind === d.kind && last.name === d.name
  }
  const from = indexIn(t, target.list, d.kind, d.name)
  return from >= 0 && (target.index === from || target.index === from + 1)
}

/** The tree after a drop, or null when the drop is impossible on this tree: a folder into
 *  itself, into a sub-folder, or - when it holds sub-folders - into any folder. */
export function applyDrop(tree: TreeItem[], d: Drag, target: Drop): TreeItem[] | null {
  const next = cloneTree(tree)
  const dest = 'into' in target ? target.into : target.list
  if (d.kind === 'folder') {
    const f = folderIn(next, d.name)
    if (!f) return null
    if (dest !== null && (dest === d.name || hasSubfolders(f) || !folderIn(next, dest) || parentOf(next, dest) !== null)) return null
  }
  const src = takeItem(next, d.kind, d.name)
  if (!src) return null
  const list = listIn(next, dest)
  if (!list) return null
  const to = 'into' in target ? list.length : src.list === dest && target.index > src.index ? target.index - 1 : target.index   // removing the item shifts later slots left
  list.splice(Math.min(to, list.length), 0, src.item)
  return next
}

// ---- tree mutations (pure; the sidebar shows the result at once and persists it) ----

/** Move a board into a folder at either level (at its end), or to the root at `atRoot`
 *  (default: the end). */
export function moveBoard(tree: TreeItem[], board: string, folder: string | null, atRoot?: number): TreeItem[] | null {
  const next = cloneTree(tree)
  if (!takeBoard(next, board)) return null
  if (folder === null) { next.splice(Math.min(atRoot ?? next.length, next.length), 0, { kind: 'board', name: board }); return next }
  const f = folderIn(next, folder)
  if (!f) return null
  f.items.push({ kind: 'board', name: board })
  return next
}

/** Move a folder to the root at `atRoot` (default: the end) - "Move to top level" for a sub-folder. */
export function moveFolderToRoot(tree: TreeItem[], name: string, atRoot?: number): TreeItem[] | null {
  const next = cloneTree(tree)
  const src = takeItem(next, 'folder', name)
  if (!src) return null
  // an explicit slot was measured before the folder left the root; the default end was not
  const at = atRoot === undefined ? next.length : src.list === null && atRoot > src.index ? atRoot - 1 : atRoot
  next.splice(Math.min(at, next.length), 0, src.item)
  return next
}

/** Can this list hold a folder? The root and a top-level folder can; a sub-folder, or a
 *  folder that is not there, cannot. */
export const holdsFolders = (t: TreeItem[], parent: string | null): boolean => parent === null || (!!folderIn(t, parent) && parentOf(t, parent) === null)

/** A new folder at `index` in `parent`'s items (null = the root), holding `board` (pulled
 *  from wherever it sat) when given. Only the root and top-level folders hold folders. */
export function createFolder(tree: TreeItem[], name: string, index: number, board?: string, title?: string, parent: string | null = null): TreeItem[] | null {
  if (foldersIn(tree).includes(name)) return null
  const next = cloneTree(tree)
  if (!holdsFolders(next, parent)) return null
  const items: TreeItem[] = []
  if (board) {
    const src = takeItem(next, 'board', board)
    if (!src) return null
    items.push(src.item)
    if (src.list === parent && src.index < index) index--                       // the board left a slot before the new one
  }
  const list = listIn(next, parent)!
  list.splice(Math.min(index, list.length), 0, { kind: 'folder', name, items, ...(title ? { title } : {}) })
  return next
}

/** Retitle a folder: what humans see (''= clear, back to the Title-Cased slug). The slug is
 *  its identity - `folder:` on every member board, the registry key - and never changes here. */
export function retitleFolder(tree: TreeItem[], name: string, title: string): TreeItem[] | null {
  const next = cloneTree(tree)
  const f = folderIn(next, name)
  if (!f) return null
  if (title) f.title = title; else delete f.title
  return next
}

/** The slug a NEW folder gets from the title the human typed: `slugify(title)`, then `-2`,
 *  `-3`, ... past a taken one; `fallback` (and `fallback-2`, ...) when nothing survives
 *  slugifying ("🚀"). Slugs are minted once - a rename changes the title, never the slug. */
export function slugFor(title: string, taken: string[], fallback = 'folder'): string {
  const s = slugify(title)
  if (s && !taken.includes(s)) return s
  const base = s || fallback
  if (!s && !taken.includes(base)) return base
  for (let i = 2; ; i++) { const c = `${base.slice(0, NAME_MAX - 1 - String(i).length)}-${i}`; if (!taken.includes(c)) return c }
}

/** Folders organise, never own: deleting one moves what it holds up one level, into its
 *  place, in order - a top-level folder's boards and sub-folders to the root, a
 *  sub-folder's boards into its parent. */
export function deleteFolder(tree: TreeItem[], name: string): TreeItem[] | null {
  const next = cloneTree(tree)
  const src = takeItem(next, 'folder', name)
  if (!src) return null
  listIn(next, src.list)!.splice(src.index, 0, ...(src.item as Folder).items)
  return next
}

/** Where "Move to new folder" puts the folder: in the board's own slot, at its own level - the
 *  root, or a sub-folder inside the top-level folder the board sits in; a board in a
 *  sub-folder gets the new folder right after that sub-folder (that level holds no folders). */
export function newFolderSlot(tree: TreeItem[], board: string): { parent: string | null; index: number } {
  const home = folderOf(tree, board)
  if (home === null) return { parent: null, index: Math.max(0, rootIndex(tree, 'board', board)) }
  const up = parentOf(tree, home)
  if (up === null) return { parent: home, index: Math.max(0, indexIn(tree, home, 'board', board)) }
  return { parent: up, index: indexIn(tree, up, 'folder', home) + 1 }
}
