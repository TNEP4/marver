/**
 * `marver boards` - the sidebar as the agent sees it: every folder and board in reading
 * order - sub-folders indented under their parent - from the files (no dev server needed). One
 * call answers "what folders exist, what is in them, what ranks where" before the agent writes `folder` on a board or edits
 * `design/boards/_folders.json`. `--json` gives the tree shape the shell uses.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NAME } from './name.ts'
import { addFolders, checkBoardsDir, checkRealDirs, boardFields, listBoardFiles, readRegistry } from '../server/boards.ts'
import { annotateBoards } from '../server/board-status.ts'
import { buildTree, flatten, folderMap, humanize, isBoardName, type Folder, type TreeItem } from '../shared/board-tree.ts'
import { BOARD_TYPES, FOLDER_MODULES, knownType, readCapability, resolveType, type BoardType } from '../shared/board-types.ts'
import { PHASE_LABEL, STATUS_LABEL } from '../shared/status.ts'

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
  // spec 20: each board's resolved type, and its status with the evidence that decided it
  const fm = folderMap(tree)
  const notes = annotateBoards(root, boards.filter((b) => b.name !== 'all-scenes'), reg.folders, (n) => fm.get(n) ?? null)
  if (opts.json) {
    const out = rows.filter((r) => r.name !== 'all-scenes').map((r) => ({ ...r, ...(notes.get(r.name) ?? {}) }))
    console.log(JSON.stringify({ tree, boards: out, landing: flatten(tree)[0] ?? (hasAll ? 'all-scenes' : null), registry: reg.state === 'ok' ? 'design/boards/_folders.json' : null }, null, 2))
    return
  }
  if (!tree.length && !hasAll) { console.log('no boards yet - design/boards/ is empty'); return }
  const order = (n: string) => { const o = rows.find((r) => r.name === n)?.order; return o === undefined ? '' : `  order ${o}` }
  const title = (t?: string) => (t ? `  "${t}"` : '')
  const desc = (d?: string) => (d ? `  - ${d}` : '')
  const kind = (n: string) => {
    const a = notes.get(n)
    if (!a) return ''
    const st = a.status ? ` · ${STATUS_LABEL[a.status.status]}${a.status.fill ? ` (${PHASE_LABEL[a.status.fill]})` : ''}${a.status.reason ? `: ${a.status.reason}` : ''}` : ''
    return a.type === 'plain' && !st ? '' : `  [${a.type}${st}]`
  }
  const boardLine = (n: string) => { const r = rows.find((x) => x.name === n); return `${n}${title(r?.title)}${kind(n)}${order(n)}${desc(r?.description)}` }
  const count = (f: Folder) => {
    const boards = f.items.filter((k) => k.kind === 'board').length, subs = f.items.length - boards
    return `${boards} board${boards === 1 ? '' : 's'}${subs ? `, ${subs} folder${subs === 1 ? '' : 's'}` : ''}`
  }
  const print = (items: TreeItem[], pad: string, parent: string | null) => {
    for (const it of items) {
      if (it.kind === 'board') { console.log(`${pad}${boardLine(it.name)}`); continue }
      const where = parent ? `sub-folder of ${parent}` : 'folder'
      const implied = reg.folders.some((f) => f.name === it.name) ? '' : ', implied by its boards - not in _folders.json'
      console.log(`${pad}${it.name}/${title(it.title)}  (${where}${it.type ? `, ${it.type}` : ''}, ${count(it)}${implied})${desc(it.description)}`)
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

/** `marver boards new <name>` - a board in its type's starting layout (spec 20): a feature's three
 *  phase scenes (spec, lo-fi, hi-fi) as three bands, a start board rendering context/INDEX.md and
 *  context/shipped.md, a deck's title slide. The type is `--type`, else the folder's. Never
 *  overwrites a board, a scene brief or a frame that exists. */
export function boardsNew(root: string, name: string, opts: { type?: string; folder?: string; title?: string; description?: string; capability?: string }): string[] {
  if (!isBoardName(name) || name === 'all-scenes') throw new Error(`"${name}" is not a board name - lowercase letters, numbers and dashes`)
  const dir = join(root, 'design', 'boards')
  const de = checkBoardsDir(root, dir)
  if (de) throw new Error(de)
  const file = join(dir, `${name}.json`)
  if (existsSync(file)) throw new Error(`design/boards/${name}.json exists - a board is never overwritten`)
  if (opts.type !== undefined && !knownType(opts.type)) throw new Error(`--type ${opts.type}: use ${BOARD_TYPES.join(', ')}`)
  if (opts.folder !== undefined && !isBoardName(opts.folder)) throw new Error(`--folder ${opts.folder} is not a folder name`)
  if (opts.capability !== undefined && !readCapability(opts.capability)) throw new Error(`--capability ${opts.capability} is not a capability slug`)
  const reg = readRegistry(dir)
  if (reg.state === 'malformed') throw new Error(reg.error)
  const folder = opts.folder ? (reg.state === 'ok' ? reg.folders.find((f) => f.name === opts.folder) : undefined) : undefined
  const parent = folder?.parent && reg.state === 'ok' ? reg.folders.find((f) => f.name === folder.parent) : undefined
  const type: BoardType = resolveType(opts.type, folder?.type, parent?.type)
  const label = opts.title ?? humanize(name)
  const created: string[] = []
  // every write lands inside the project, through real directories, and only where nothing is:
  // exclusive creation, so a file another author wrote a moment ago is never truncated
  const put = (rel: string, body: string) => {
    const f = join(root, rel)
    const scene = rel.split('/')[2]
    const bad = checkRealDirs(root, [[join(root, 'design'), 'design'], [join(root, 'design', 'scenes'), 'design/scenes'], [join(root, 'design', 'scenes', scene), `design/scenes/${scene}`]])
    if (bad) throw new Error(bad)
    mkdirSync(join(f, '..'), { recursive: true })
    try { writeFileSync(f, body, { flag: 'wx' }); created.push(rel) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  }
  const brief = (scene: string, title: string, body: string, phase?: string) =>
    put(`design/scenes/${scene}/_brief.md`, `---\ntitle: ${title}\n${phase ? `phase: ${phase}\n` : ''}---\n${body}\n`)

  let nodes: { frame: string }[] = []
  let layout: unknown
  if (type === 'feature') {
    const cap = opts.capability ?? name
    const [specs, lofi, hifi] = [`${name}-specs`, `${name}-lofi`, name]
    brief(specs, `${label} - spec`, `${label}: what it does, for whom, and its limits - the thinking before the screens. Its contract is context/product/${cap}.md once accepted.`, 'spec')
    brief(lofi, `${label} - lo-fi`, `${label} in throwaway wireframes: structure and copy, no styling.`, 'lofi')
    brief(hifi, label, `${label} in hi-fi, from the product's real components.`, 'hifi')
    layout = { rows: [[specs], { space: 3 }, [lofi], { space: 4 }, [hifi]] }
  } else if (type === 'start') {
    const strip = "(md: string) => md.replace(/^<!--[^\\n]*-->\\n/, '').replace(/^---\\n[\\s\\S]*?\\n---\\n/, '')"
    const frame = (file: string, title: string, src: string, desc: string) => put(`design/scenes/${name}/${file}.tsx`,
      `// Renders ${src} - the file is the truth; this frame only shows it.\nimport { Doc, Md } from '@marver-design/marver/content'\nimport text from '../../../${src}?raw'\n\nexport const meta = { title: '${title}', intent: 'spec', description: '${desc}' }\n\nconst body = ${strip}\n\nexport default () => (\n  <Doc>\n    <Md>{body(text)}</Md>\n  </Doc>\n)\n`)
    brief(name, label, 'The way in: the index and the shipped record, rendered from context/.')
    frame('index', 'The index', 'context/INDEX.md', 'context/INDEX.md, rendered - where every question is answered')
    frame('shipped', 'Shipped', 'context/shipped.md', 'context/shipped.md, rendered - what runs where, with its evidence')
    nodes = [{ frame: `${name}/index` }, { frame: `${name}/shipped` }]
    layout = { rows: [[name]] }
  } else if (type === 'deck') {
    brief(name, label, `${label}: the deck. Read design/instructions/slides.md before the first slide.`)
    put(`design/scenes/${name}/01-title.tsx`, `export const meta = { title: '${label.replace(/'/g, "\\'")}', slide: true }\n\nexport default function Frame() {\n  return (\n    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 96 }}>\n      <h1 style={{ fontSize: 72, margin: 0 }}>${label.replace(/[<>{}]/g, '')}</h1>\n    </main>\n  )\n}\n`)
    nodes = [{ frame: `${name}/01-title` }]
    layout = { rows: [[name]] }
  }
  const board = {
    version: 1, name, auto: false,
    ...(opts.type ? { type: opts.type } : {}),
    ...(opts.folder ? { folder: opts.folder } : {}),
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.capability ? { capability: opts.capability } : {}),
    nodes,
    ...(layout ? { layout } : {}),
  }
  mkdirSync(dir, { recursive: true })
  try { writeFileSync(file, JSON.stringify(board, null, 2) + '\n', { flag: 'wx' }) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`design/boards/${name}.json exists - a board is never overwritten`); throw e }
  created.unshift(`design/boards/${name}.json (${type}${opts.type ? '' : type === 'plain' ? '' : `, from ${opts.folder}`})`)
  return created
}

/** `marver folders add <module...>` - the shared sidebar's typed folders (spec 20): start, features,
 *  surfaces, projects, feedback, context, decks, archive. Appended; never renames or moves one. */
export function foldersAdd(root: string, modules: string[]): { added: string[]; existing: string[] } {
  const unknown = modules.filter((m) => !FOLDER_MODULES[m])
  if (unknown.length) throw new Error(`unknown folder module: ${unknown.join(', ')} - use ${Object.keys(FOLDER_MODULES).join(', ')}`)
  if (!modules.length) throw new Error(`name a module: ${Object.keys(FOLDER_MODULES).join(', ')} (e.g. \`npx ${NAME} folders add decks\`)`)
  return addFolders(root, modules.map((m) => FOLDER_MODULES[m]))
}
