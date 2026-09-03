/**
 * `marver boards` - the sidebar as the agent sees it: every folder and board in reading
 * order, from the files (no dev server needed). One call answers "what folders exist, what
 * is in them, what ranks where" before the agent writes `folder` on a board or edits
 * `design/boards/_folders.json`. `--json` gives the tree shape the shell uses.
 */
import { join } from 'node:path'
import { checkBoardsDir, boardFields, listBoardFiles, readRegistry } from '../server/boards.ts'
import { buildTree, flatten, isBoardName } from '../shared/board-tree.ts'

export function boardsCommand(root: string, opts: { json?: boolean }): void {
  const dir = join(root, 'design', 'boards')
  const de = checkBoardsDir(root, dir)
  if (de) throw new Error(de)
  const { boards, skipped } = listBoardFiles(dir)
  const reg = readRegistry(dir)
  if (reg.state === 'malformed') throw new Error(reg.error)
  const rows = boards.map((b) => ({ name: b.name, ...boardFields(b.json, isBoardName) }))
  const tree = buildTree(rows, reg.folders)
  const hasAll = boards.some((b) => b.name === 'all-scenes')
  if (opts.json) {
    console.log(JSON.stringify({ tree, boards: rows.filter((r) => r.name !== 'all-scenes'), landing: flatten(tree)[0] ?? (hasAll ? 'all-scenes' : null), registry: reg.state === 'ok' ? 'design/boards/_folders.json' : null }, null, 2))
    return
  }
  if (!tree.length && !hasAll) { console.log('no boards yet - design/boards/ is empty'); return }
  const order = (n: string) => { const o = rows.find((r) => r.name === n)?.order; return o === undefined ? '' : `  order ${o}` }
  const title = (t?: string) => (t ? `  "${t}"` : '')
  const desc = (d?: string) => (d ? `  - ${d}` : '')
  const boardLine = (n: string) => { const r = rows.find((x) => x.name === n); return `${n}${title(r?.title)}${order(n)}${desc(r?.description)}` }
  for (const it of tree) {
    if (it.kind === 'board') { console.log(boardLine(it.name)); continue }
    console.log(`${it.name}/${title(it.title)}  (folder, ${it.boards.length} board${it.boards.length === 1 ? '' : 's'}${reg.folders.some((f) => f.name === it.name) ? '' : ', implied by its boards - not in _folders.json'})${desc(it.description)}`)
    for (const b of it.boards) console.log(`  ${boardLine(b)}`)
    if (!it.boards.length) console.log('  (empty)')
  }
  if (hasAll) console.log('all-scenes  (auto, always last)')
  const landing = flatten(tree)[0]
  if (landing) console.log(`\nlanding board: ${landing}`)
  console.log(`registry: ${reg.state === 'ok' ? 'design/boards/_folders.json' : 'none (no empty or ranked folders yet)'}`)
  if (skipped.length) console.log(`skipped (not regular files): ${skipped.join(', ')}`)
}
