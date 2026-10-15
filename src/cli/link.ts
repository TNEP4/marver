/**
 * `marver link <scene/frame | scene ...>` - the canvas link that lands ON the work: the board the
 * frames sit on, opened in canvas mode with them selected and the camera fitted (never past 100%) -
 * not the full-screen focus view. An agent knows frame ids and scene names; it does not know the
 * shell's node keys or which port `marver dev` took, so it asks here and pastes what comes back.
 * `work done` prints the same links for the frames it clears; `comments new` prints its thread's.
 *
 * The board: `--board` when given; else the first board in sidebar order that shows EVERY frame
 * asked for (archive boards last - history is not where a change is reviewed); else one link per
 * board, each frame on the first board that shows it. A frame on no board gets a hint instead of a
 * link (spec 26, Part 7): every frame goes on the board it belongs to.
 */
import { join } from 'node:path'
import { NAME } from './name.ts'
import { checkBoardsDir, listBoardFiles, readMembership, unplacedHint, type Membership } from '../server/boards.ts'
import { scanFrames } from '../server/manifest.ts'
import { readDevInfo } from '../server/work.ts'
import { isBoardName } from '../shared/board-tree.ts'

export interface Resolved {
  /** The first link's board - the one a single frame opens on; absent when no board shows any. */
  board?: string
  /** Frame ids asked for by id, and scenes asked for whole. */
  frames: string[]
  /** The frames named EXACTLY (not reached through a folder) - what `comments new` may pin on. */
  exact: string[]
  scenes: string[]
  /** Every frame the link selects (scenes expanded). */
  all: string[]
  /** One link per board, in sidebar order: `#/b/<board>?f=...&s=...` */
  links: { board: string; hash: string }[]
  /** The first link's hash. */
  hash?: string
  /** The frames no board shows - each gets a hint (`hints`), never a link. */
  unplaced: string[]
  hints: string[]
  /** Each board's nodes, for callers that need a node key (comments new). */
  nodesOf: (board: string) => { frame: string; key?: string }[]
}

/** Frame ids and scene names, as an agent writes them, against the frames on disk. */
export function resolveTargets(known: readonly string[], targets: string[]): Pick<Resolved, 'frames' | 'exact' | 'scenes' | 'all'> {
  const ids = new Set(known)
  const frames: string[] = [], scenes: string[] = [], all: string[] = [], exact: string[] = []
  const add = (list: string[], v: string) => { if (!list.includes(v)) list.push(v) }
  for (const raw of targets) {
    const t = raw.replace(/^design\/scenes\//, '').replace(/\.(tsx|jsx|html)$/, '').replace(/\/+$/, '')
    if (ids.has(t)) { add(frames, t); add(all, t); add(exact, t); continue }
    const members = known.filter((id) => id.startsWith(`${t}/`))
    if (members.length) {
      // a scene is a top-level folder (`?s=`); a folder inside one (a variant scope, checkout/payment)
      // travels as its frames - the link grammar names scenes, not paths
      if (t.includes('/')) for (const m of members) { add(frames, m); add(all, m) }
      else { add(scenes, t); for (const m of members) add(all, m) }
      continue
    }
    throw new Error(`no frame or scene "${raw}" in design/scenes/ - a frame is <scene>/<name>, a scene is its folder`)
  }
  return { frames, exact, scenes, all }
}

export function resolveLink(root: string, targets: string[], board?: string): Resolved {
  if (!targets.length) throw new Error('name what to link: link <scene/frame | scene ...>')
  const known = scanFrames(root).frames.map((f) => f.id)
  const t = resolveTargets(known, targets)
  const dir = join(root, 'design', 'boards')
  const files = checkBoardsDir(root, dir) ? [] : listBoardFiles(dir).boards
  const nodesOf = (name: string): { frame: string; key?: string }[] => {
    const json = files.find((b) => b.name === name)?.json as { nodes?: unknown } | null | undefined
    return Array.isArray(json?.nodes)
      ? json.nodes.filter((n): n is { frame: string; key?: string } => !!n && typeof (n as { frame?: unknown }).frame === 'string')
      : []
  }
  const m: Membership = readMembership(root, known)
  const showsAll = (b: { frames: string[] }) => t.all.every((f) => b.frames.includes(f))
  const q = (frames: string[], scenes: string[]) => [frames.length ? `f=${frames.join(',')}` : '', scenes.length ? `s=${scenes.join(',')}` : ''].filter(Boolean).join('&')

  let links: Resolved['links']
  let unplaced: string[] = []
  if (board) {
    if (!isBoardName(board)) throw new Error(`"${board}" is not a board name`)
    const b = m.boards.find((x) => x.name === board)
    if (!b) throw new Error(`no board "${board}" in design/boards/`)
    const missing = t.all.filter((f) => !b.frames.includes(f))
    if (missing.length) throw new Error(`board "${board}" does not show ${missing.join(', ')} - pin ${missing.length === 1 ? 'it' : 'them'} there first (npx ${NAME} boards pin ${board} ${missing.join(' ')}), or leave --board out`)
    links = [{ board, hash: `#/b/${board}?${q(t.frames, t.scenes)}` }]
  } else {
    const one = m.boards.find(showsAll)
    if (one) links = [{ board: one.name, hash: `#/b/${one.name}?${q(t.frames, t.scenes)}` }]
    else {
      // each frame on the first board that shows it: one link per board, in sidebar order
      const left = new Set(t.all)
      links = []
      for (const b of m.boards) {
        const here = t.all.filter((f) => left.has(f) && b.frames.includes(f))
        if (!here.length) continue
        for (const f of here) left.delete(f)
        links.push({ board: b.name, hash: `#/b/${b.name}?${q(here, [])}` })
      }
      unplaced = [...left]
    }
  }
  return { ...t, board: links[0]?.board, links, hash: links[0]?.hash, unplaced, hints: unplacedHint(m, unplaced), nodesOf }
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
  if (!r.links.length) throw new Error(r.hints.join('\n'))
  const origin = await devOrigin(root)
  if (!origin) throw new Error(NOT_RUNNING)
  for (const l of r.links) console.log(`${origin}${l.hash}`)
  for (const h of r.hints) console.error(`  ${h}`)
}

/** The hand-back other commands print after their own output - a link per board when `dev` runs,
 *  and the hint for each frame on no board. Never fails them. */
export async function handBack(root: string, targets: string[]): Promise<{ links: string[]; hints: string[] }> {
  // a frame finished and then deleted (merged into another, renamed) has nothing to link: the rest still do
  const live = new Set(scanFrames(root).frames.map((f) => f.id))
  targets = targets.filter((t) => live.has(t))
  if (!targets.length) return { links: [], hints: [] }
  try {
    const r = resolveLink(root, targets)
    const origin = await devOrigin(root)
    return { links: origin ? r.links.map((l) => `${origin}${l.hash}`) : [], hints: r.hints }
  } catch { return { links: [], hints: [] } }
}
