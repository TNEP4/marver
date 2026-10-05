/**
 * `marver boards` - the sidebar as the agent sees it: every folder and board in reading
 * order - sub-folders indented under their parent - from the files (no dev server needed). One
 * call answers "what folders exist, what is in them, what ranks where" before the agent writes `folder` on a board or edits
 * `design/boards/_folders.json`. `--json` gives the tree shape the shell uses.
 */
import { join } from 'node:path'
import { checkBoardsDir, boardFields, listBoardFiles, readRegistry } from '../server/boards.ts'
import { buildTree, flatten, isBoardName, type Folder, type TreeItem } from '../shared/board-tree.ts'

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
  const count = (f: Folder) => {
    const boards = f.items.filter((k) => k.kind === 'board').length, subs = f.items.length - boards
    return `${boards} board${boards === 1 ? '' : 's'}${subs ? `, ${subs} folder${subs === 1 ? '' : 's'}` : ''}`
  }
  const print = (items: TreeItem[], pad: string, parent: string | null) => {
    for (const it of items) {
      if (it.kind === 'board') { console.log(`${pad}${boardLine(it.name)}`); continue }
      const where = parent ? `sub-folder of ${parent}` : 'folder'
      const implied = reg.folders.some((f) => f.name === it.name) ? '' : ', implied by its boards - not in _folders.json'
      console.log(`${pad}${it.name}/${title(it.title)}  (${where}, ${count(it)}${implied})${desc(it.description)}`)
      print(it.items, `${pad}  `, it.name)
      if (!it.items.length) console.log(`${pad}  (empty)`)
    }
  }
  print(tree, '', null)
  if (hasAll) console.log('all-scenes  (auto, always last)')
  const landing = flatten(tree)[0]
  if (landing) console.log(`\nlanding board: ${landing}`)
  console.log(`registry: ${reg.state === 'ok' ? 'design/boards/_folders.json' : 'none (no empty or ranked folders yet)'}`)
  if (skipped.length) console.log(`skipped (not regular files): ${skipped.join(', ')}`)
}
