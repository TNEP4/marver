/**
 * `marver link <scene/frame | scene ...>` - the canvas link that lands ON the work: the board the
 * frames sit on, opened in canvas mode with them selected and the camera fitted (never past 100%) -
 * not the full-screen focus view. An agent knows frame ids and scene names; it does not know the
 * shell's node keys or which port `marver dev` took, so it asks here and pastes what comes back.
 * `work done` prints the same link for the frames it clears; `comments new` prints its thread's.
 *
 * The board: `--board` when given; else the first board in sidebar order that shows EVERY frame
 * asked for (archive boards last - history is not where a change is reviewed); else `all-scenes`,
 * which holds every frame.
 */
import { join } from 'node:path'
import { NAME } from './name.ts'
import { checkBoardsDir, listBoardFiles, boardFields, readRegistry } from '../server/boards.ts'
import { scanFrames } from '../server/manifest.ts'
import { readDevInfo } from '../server/work.ts'
import { buildTree, flatten, folderMap, isBoardName } from '../shared/board-tree.ts'
import { resolveType } from '../shared/board-types.ts'

export interface Resolved {
  board: string
  /** Frame ids asked for by id, and scenes asked for whole. */
  frames: string[]
  /** The frames named EXACTLY (not reached through a folder) - what `comments new` may pin on. */
  exact: string[]
  scenes: string[]
  /** Every frame the link selects (scenes expanded) - what the board must show. */
  all: string[]
  /** The hash: `#/b/<board>?f=...&s=...` */
  hash: string
  /** Set when no curated board shows every frame and the link falls back to all-scenes. */
  fellBack?: boolean
  /** Each board's nodes, for callers that need a node key (comments new). */
  nodesOf: (board: string) => { frame: string; key?: string }[]
}

export function resolveLink(root: string, targets: string[], board?: string): Resolved {
  if (!targets.length) throw new Error('name what to link: link <scene/frame | scene ...>')
  const known = scanFrames(root).frames.map((f) => f.id)
  const ids = new Set(known)
  const frames: string[] = [], scenes: string[] = [], all: string[] = [], exact: string[] = []
  for (const raw of targets) {
    const t = raw.replace(/^design\/scenes\//, '').replace(/\.(tsx|jsx|html)$/, '').replace(/\/+$/, '')
    if (ids.has(t)) { if (!frames.includes(t)) frames.push(t); if (!all.includes(t)) all.push(t); if (!exact.includes(t)) exact.push(t); continue }
    const members = known.filter((id) => id.startsWith(`${t}/`))
    if (members.length) {
      // a scene is a top-level folder (`?s=`); a folder inside one (a variant scope, checkout/payment)
      // travels as its frames - the link grammar names scenes, not paths
      if (t.includes('/')) { for (const m of members) { if (!frames.includes(m)) frames.push(m); if (!all.includes(m)) all.push(m) } }
      else { if (!scenes.includes(t)) scenes.push(t); for (const m of members) if (!all.includes(m)) all.push(m) }
      continue
    }
    throw new Error(`no frame or scene "${raw}" in design/scenes/ - a frame is <scene>/<name>, a scene is its folder`)
  }

  const dir = join(root, 'design', 'boards')
  const de = checkBoardsDir(root, dir)
  const files = de ? [] : listBoardFiles(dir).boards
  const nodesOf = (name: string): { frame: string; key?: string }[] => {
    const json = files.find((b) => b.name === name)?.json as { nodes?: unknown } | null | undefined
    return Array.isArray(json?.nodes)
      ? json.nodes.filter((n): n is { frame: string; key?: string } => !!n && typeof (n as { frame?: unknown }).frame === 'string')
      : []
  }
  const shows = (name: string) => { const pins = new Set(nodesOf(name).map((n) => n.frame)); return all.every((f) => pins.has(f)) }

  let pick = board
  let fellBack = false
  if (pick) {
    if (!isBoardName(pick)) throw new Error(`"${pick}" is not a board name`)
    if (pick !== 'all-scenes' && !files.some((b) => b.name === pick)) throw new Error(`no board "${pick}" in design/boards/`)
    if (pick !== 'all-scenes' && !shows(pick)) {
      const missing = all.filter((f) => !nodesOf(pick!).some((n) => n.frame === f))
      throw new Error(`board "${pick}" does not show ${missing.join(', ')} - pin ${missing.length === 1 ? 'it' : 'them'} there first, or leave --board out`)
    }
  } else {
    const reg = readRegistry(dir)
    const folders = reg.state === 'ok' ? reg.folders : []
    const rows = files.filter((b) => b.name !== 'all-scenes').map((b) => ({ name: b.name, ...boardFields(b.json, isBoardName) }))
    const tree = buildTree(rows, folders)
    const order = flatten(tree)
    // a board's type is its own, else its folder's, else that folder's parent's (spec 20)
    const fm = folderMap(tree)
    const byName = new Map(folders.map((f) => [f.name, f]))
    const typeOf = (n: string) => {
      const folder = byName.get(fm.get(n) ?? '')
      return resolveType(rows.find((r) => r.name === n)?.type, folder?.type, folder?.parent ? byName.get(folder.parent)?.type : undefined)
    }
    const isArchive = (n: string) => n === 'archive' || typeOf(n) === 'archive'
    const ranked = [...order.filter((n) => !isArchive(n)), ...order.filter(isArchive)]
    pick = ranked.find(shows)
    if (!pick) { pick = 'all-scenes'; fellBack = true }
  }

  const q = [frames.length ? `f=${frames.join(',')}` : '', scenes.length ? `s=${scenes.join(',')}` : ''].filter(Boolean).join('&')
  return { board: pick, frames, exact, scenes, all, hash: `#/b/${pick}?${q}`, ...(fellBack ? { fellBack } : {}), nodesOf }
}

/** The dev server's origin when it is running in this repo and answers like `marver dev` - else null. */
export async function devOrigin(root: string): Promise<string | null> {
  const info = readDevInfo(root)
  if (!info) return null
  try {
    const res = await fetch(`http://localhost:${info.port}/__mv/api/work`, { headers: { 'x-mv-work': info.token }, signal: AbortSignal.timeout(1500) })
    const data = await res.json().catch(() => null) as { frames?: unknown } | null
    return res.ok && Array.isArray(data?.frames) ? `http://localhost:${info.port}/` : null
  } catch { return null }
}

const NOT_RUNNING = `\`${NAME} dev\` is not running in this repo - start it (\`npx ${NAME} dev\`), then run this again: the link carries its port`

export async function linkCommand(root: string, targets: string[], opts: { board?: string }): Promise<void> {
  const r = resolveLink(root, targets, opts.board)
  const origin = await devOrigin(root)
  if (!origin) throw new Error(NOT_RUNNING)
  if (r.fellBack) console.error(`  (no curated board shows ${r.all.length === 1 ? 'it' : 'all of them'} - the link opens on all-scenes; pin ${r.all.length === 1 ? 'it' : 'them'} on a board for a tighter view)`)
  console.log(`${origin}${r.hash}`)
}

/** The link line other commands print after their own output - never fails them. */
export async function linkLine(root: string, targets: string[]): Promise<string | null> {
  try {
    const r = resolveLink(root, targets)
    const origin = await devOrigin(root)
    return origin ? `${origin}${r.hash}` : null
  } catch { return null }
}
