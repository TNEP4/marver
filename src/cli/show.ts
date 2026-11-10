/**
 * `marver show <scene/frame ... | board>` (spec 31 D3): put a place in front of the human, in every tab where the
 * canvas is open - for when they ask to be shown. Otherwise an agent gives the link (`marver link`).
 *
 * The target resolves as `link` does, on one board: frames and scenes on the first board that shows them all (or
 * `--board`), or a board name alone (the board, fitted). `--thread <id>` opens a comment thread there too. The dev
 * server broadcasts the command; each open tab moves to it, refits even when it is already there, or - holding words
 * not yet sent - puts up a notice and stays. The CLI waits up to 3 s for the tabs' answers and says what came of it,
 * then prints the link (what `marver link` prints).
 */
import { findDev, linkFor, NOT_RUNNING, resolveLink, unreachable } from './link.ts'
import { readDevInfo } from '../server/work.ts'
import { listBoardFiles, checkBoardsDir } from '../server/boards.ts'
import { isBoardName } from '../shared/board-tree.ts'
import { hashOfTarget, type ShowTarget } from '../shared/deep-link.ts'
import { join } from 'node:path'

/** How long the CLI listens for the tabs' answers: all of it, every time. */
export const SHOW_WAIT_MS = 3000

/** What to show (pure of the network): one board's target, or why not. */
export function showPlan(root: string, targets: string[], opts: { board?: string; thread?: string } = {}): { target: ShowTarget; hints: string[] } {
  if (!targets.length) throw new Error(`name what to show: show <scene/frame | scene ... | board>${opts.board ? ` - a whole board is its name alone (show ${opts.board}); when a scene has that name too, name the scenes it shows with --board ${opts.board}` : ''}`)
  if (opts.thread !== undefined && !/^[\w-]{1,128}$/.test(opts.thread)) throw new Error(`"${opts.thread}" is not a thread id`)
  const thread = opts.thread ? { c: opts.thread } : {}
  // a board name alone: that board, fitted - when no frame or scene answers to it
  if (targets.length === 1 && isBoardName(targets[0]!) && !opts.board) {
    let frameLike = true
    try { resolveLink(root, targets) } catch { frameLike = false }
    const dir = join(root, 'design', 'boards')
    if (!frameLike && !checkBoardsDir(root, dir) && listBoardFiles(dir).boards.some((b) => b.name === targets[0])) return { target: { board: targets[0]!, ...thread }, hints: [] }
  }
  const r = resolveLink(root, targets, opts.board)
  if (!r.links.length) throw new Error(r.hints.join('\n'))
  if (r.links.length > 1) {
    throw new Error(`these are on ${r.links.length} boards - show one board at a time (or pin them together):\n${r.links.map((l) => `  ${l.board}: ${l.hash}`).join('\n')}`)
  }
  const target: ShowTarget = { board: r.links[0]!.board, ...(r.frames.length ? { f: r.frames } : {}), ...(r.scenes.length ? { s: r.scenes } : {}), ...thread }
  return { target, hints: r.hints }
}

/** The words for the tabs' answers (pure). */
export function showWords(a: { shown: number; notice: number } | null): string {
  if (!a || (a.shown === 0 && a.notice === 0)) return 'not shown - no open tab took it (none is open, the person moved first, or the place is not on that board)'
  const tabs = (n: number) => `${n} tab${n === 1 ? '' : 's'}`
  const parts: string[] = []
  if (a.shown) parts.push(`shown in ${tabs(a.shown)}`)
  if (a.notice) parts.push(`${tabs(a.notice)} ${a.notice === 1 ? 'holds' : 'hold'} words not yet sent - ${a.notice === 1 ? 'it shows' : 'they show'} a notice to go there instead`)
  return parts.join('; ')
}

export async function showCommand(root: string, targets: string[], opts: { board?: string; thread?: string; web?: boolean }): Promise<void> {
  const { target, hints } = showPlan(root, targets, opts)
  const found = await findDev(root)
  if (!found) throw new Error(NOT_RUNNING)
  const hash = hashOfTarget(target)
  if ('unreachable' in found) {
    // nothing to broadcast through from here: the link is all this side can give
    console.log(`not shown: ${unreachable(found.unreachable.pid)}`)
    console.log(linkFor(root, `http://localhost:${found.unreachable.port}/`, hash, { web: opts.web }))
    return
  }
  const info = readDevInfo(root)
  const headers = { 'content-type': 'application/json', 'x-mv-work': info?.token ?? '' }
  const res = await fetch(`${found.origin}__mv/api/show`, { method: 'POST', headers, body: JSON.stringify(target), signal: AbortSignal.timeout(5000) })
  const body = await res.json().catch(() => null) as { seq?: number; error?: string } | null
  if (!res.ok || typeof body?.seq !== 'number') throw new Error(`the canvas did not take it: ${body?.error ?? res.status}`)
  const seq = body.seq
  const until = Date.now() + SHOW_WAIT_MS
  // the whole window: the server cannot know how many tabs are open, so a quiet spell is no "every tab answered"
  let last: { shown: number; notice: number } | null = null
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250))
    const a = await fetch(`${found.origin}__mv/api/show/acks?seq=${seq}`, { headers, signal: AbortSignal.timeout(1000) })
      .then((r) => (r.ok ? r.json() : null), () => null) as { shown: number; notice: number } | null
    if (a) last = a
  }
  console.log(showWords(last))
  console.log(linkFor(root, found.origin, hash, { web: opts.web }))
  for (const h of hints) console.error(`  ${h}`)
}
