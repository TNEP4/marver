/**
 * `marver build` - the static adapter.
 *
 * Same Vite pipeline as dev (theme wrapper, tailwind, virtuals) with three JS entries
 * (shell / frame-host / stage); the html pages are generated from the build output, so
 * the routes middleware has no static counterpart to maintain. `virtual:sh-data` inlines
 * manifest + boards - a published canvas fetches nothing and writes nothing.
 *
 * `--boards a,b` is the privacy boundary and it is enforced at BUILD time: the manifest
 * is filtered to the frames those boards reference, and the frame-host registry module
 * is replaced by a generated one whose only imports are the published frames - excluded
 * frame modules never enter the bundle. Runtime hiding would not be security.
 */
import { build as viteBuild } from 'vite'
import type { Plugin, Rollup } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash, randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAME, ROUTE } from '../cli/name.ts'
import { loadConfig } from './config.ts'
import { detectHost } from './detect.ts'
import { scanFrames, type FrameEntry, type Manifest } from './manifest.ts'
import { Marked } from 'marked'
import { marverPlugin, tailwind3Css, tailwind4Plugin } from './plugin.ts'
import { cssFixPlugin } from './css-fix.ts'
import { buildTree, flatten, isBoardName, type FolderRow, type TreeItem } from '../shared/board-tree.ts'
import { PROPOSED_PUBLISH, type BoardType } from '../shared/board-types.ts'
import { PUBLISHABLE, publishableStatus } from '../shared/status.ts'
import { boardFields, checkBoardsDir, listBoardFiles, readRegistry } from './boards.ts'

const posix = (p: string) => p.split(sep).join('/')

function packageDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/** Static asset references in one module's source: <Img src="..."> string
 *  literals plus markdown image literals INSIDE TEMPLATE STRINGS (where Md content
 *  lives - prose in comments never counts). Comments are stripped first so a commented
 *  example cannot fail the build. A computed <Img src={...}> fails CLOSED - the build
 *  cannot know what it resolves to, so it must not publish. */
export function scanAssetRefs(src: string, moduleId: string): string[] {
  // template literals come out of the RAW source first: Md prose keeps any /*...*/
  // it legitimately contains, and removing the spans makes the comment strip safe
  const templates: string[] = []
  const code = src.replace(/`(?:[^`\\]|\\[\s\S])*`/g, (t) => { templates.push(t); return '``' })
  // conservative comment strip on the remaining code: block comments, and //-to-EOL
  // when preceded by line start or whitespace ("https://" in a string survives -
  // its // follows a colon)
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
  for (const tag of ['Img', 'Video'] as const) {
    const computed = new RegExp(`<${tag}\\b[^>]*\\b(?:src|poster)\\s*=\\s*\\{`)
    if (computed.test(stripped))
      throw new Error(`${moduleId}: <${tag}> has a computed src/poster - published builds copy only statically referenced assets. Use a string literal.`)
  }
  const out: string[] = []
  for (const m of stripped.matchAll(/<Img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g)) out.push(m[1])
  // Video: src AND poster ride the pipeline; remote https sources stay remote
  // (isLocalAssetRef filters them downstream exactly like markdown images).
  // A LOCAL Video src without a poster references the GENERATED one by
  // convention (`<clip>.poster.png`, server/poster.ts) - the build renders it
  // before assets are copied, so the poster IS there at rest.
  for (const m of stripped.matchAll(/<Video\b[^>]*>|<Video\b[^>]*\/>/g)) {
    const tag = m[0]
    const srcM = /\bsrc\s*=\s*["']([^"']+)["']/.exec(tag)
    const posterM = /\bposter\s*=\s*["']([^"']+)["']/.exec(tag)
    if (srcM) {
      const remote = /^https:\/\//.test(srcM[1])
      out.push(srcM[1])
      if (!remote && !posterM) out.push(`${srcM[1]}.poster.png`)
    }
    if (posterM) out.push(posterM[1])
  }
  for (const tpl of templates) out.push(...markdownImageRefs(tpl.slice(1, -1)))   // the literal's content, not its backticks (a backtick-wrapped string is a code span to the parser)
  return out
}

/** Markdown images in prose, through the parser: inline and reference-style, titles and
 *  parentheses in paths handled, code never counted. Decoded the way the client's assetUrl
 *  decodes (one pass; a path still carrying `%` is refused there and skipped here). Md content
 *  inside frames and sticky notes alike. */
export function markdownImageRefs(md: string): string[] {
  const out: string[] = []
  const walk = (tokens: any[]) => {
    for (const t of tokens) {
      if (t.type === 'image' && typeof t.href === 'string') {
        let p = t.href.trim()
        try { p = decodeURIComponent(p) } catch { continue }
        if (!p.includes('%')) out.push(p)
      }
      if (t.type !== 'code' && t.type !== 'codespan') {
        if (Array.isArray(t.tokens)) walk(t.tokens)
        if (Array.isArray(t.items)) walk(t.items)
        if (Array.isArray(t.rows)) for (const row of t.rows) walk(row.map((c: any) => ({ tokens: c.tokens })))
        if (Array.isArray(t.header)) walk(t.header.map((c: any) => ({ tokens: c.tokens })))
      }
    }
  }
  try { walk(new Marked({ gfm: true }).lexer(md)) } catch { /* unparseable prose has no images */ }
  return out
}

/** Same shape the client's assetUrl accepts: relative, inside design/assets/, no tricks. */
export const isLocalAssetRef = (p: string): boolean =>
  !!p && !p.includes(':') && !p.startsWith('/') && !p.startsWith('\\') && !p.split('/').some((s) => s === '..' || s === '')

// ---- the publish policy, v2 (01-sharing §5.1) ----
// Per board: `max` (the ceiling), optional artifact `type`, optional `open`
// (the landing view) and `lock`. A bare string value is a v1 row - every 0.11
// canvas parses unchanged. `reveal.source` defaults OFF on published canvases:
// the inlined manifest carries every frame's repo path, and for anything
// shared beyond the repo's own audience that is a disclosure, not a feature.

export const ARTIFACT_TYPES = ['doc', 'slides', 'design', 'sketch', 'refs', 'mix'] as const
export type ArtifactType = typeof ARTIFACT_TYPES[number]
export const VIEW_MODES = ['canvas', 'board', 'present', 'focus', 'slides'] as const
export type ViewMode = typeof VIEW_MODES[number]

export const DECK_TRANSITIONS = ['fade', 'none'] as const
export const DECK_CHROME = ['full', 'minimal', 'none'] as const   // full (default) = the standard prototype chrome
export interface BoardPolicy {
  max: 'read' | 'comment'; type: ArtifactType; open?: ViewMode; lock?: boolean
  /** spec 20: show this board's status on the published canvas - rows 5-9 only, never a reason */
  showStatus?: boolean
  /** Slides mode (v1.5): the deck's one transition and its chrome level. */
  transition?: typeof DECK_TRANSITIONS[number]
  chrome?: typeof DECK_CHROME[number]
}
export interface PublishPolicy {
  boards: Record<string, BoardPolicy>
  reveal: { structure: boolean; source: boolean }
}

/** Publishing is default-CLOSED - no policy and no explicit flag = no build.
 *  Boards absent from the result do not ship. */
export function resolvePolicy(
  root: string, allBoards: Record<string, any>, boardsFlag?: string, allBoardsFlag?: boolean,
): PublishPolicy {
  const known = (n: string) => n === 'all-scenes' || !!allBoards[n]
  const reveal = { structure: true, source: false }
  const row = (max: 'read' | 'comment', _n: string): BoardPolicy => ({ max, type: 'mix' })
  if (boardsFlag !== undefined) {
    const names = boardsFlag.split(',').map((s) => s.trim()).filter(Boolean)
    // an empty filter fails CLOSED - `--boards "$UNSET_VAR"` must never publish everything
    if (!names.length) throw new Error('--boards was given but named no boards')
    const missing = names.filter((n) => !known(n))
    if (missing.length) throw new Error(`--boards names not found in design/boards/: ${missing.join(', ')}`)
    return { boards: Object.fromEntries(names.map((n) => [n, row('comment', n)])), reveal }
  }
  if (allBoardsFlag)
    return {
      boards: Object.fromEntries(
        ['all-scenes', ...Object.keys(allBoards).filter((n) => n !== 'all-scenes')].map((n) => [n, row('comment', n)])),
      reveal,
    }
  const policyFile = join(root, 'design', 'publish.json')
  if (!existsSync(policyFile))
    throw new Error(
      'publishing is default-closed and no publish policy exists.\n' +
      `  Either declare one in design/publish.json:  { "boards": { "<board>": "read" | "comment" } }\n` +
      `  or be explicit:  --boards a,b  (publish just those)  ·  --all-boards  (publish everything)`)
  let policy: any
  try { policy = JSON.parse(readFileSync(policyFile, 'utf8')) }
  catch { throw new Error('design/publish.json is not valid JSON') }
  const entries = Object.entries(policy?.boards ?? {})
  if (!entries.length)
    throw new Error('design/publish.json has no "boards" entries - publishing is default-closed, name what ships')
  const out: Record<string, BoardPolicy> = {}
  for (const [n, level] of entries) {
    if (!known(n)) throw new Error(`design/publish.json names an unknown board: ${n}`)
    if (level === 'read' || level === 'comment') { out[n] = row(level, n); continue }   // v1 row
    if (typeof level !== 'object' || level === null)
      throw new Error(`design/publish.json: board "${n}" has level "${level}" - use "read" or "comment", or a v2 object`)
    const p = level as Record<string, unknown>
    if (p.max !== 'read' && p.max !== 'comment')
      throw new Error(`design/publish.json: board "${n}" needs "max": "read" | "comment"`)
    const type = p.type ?? 'mix'
    if (p.showStatus !== undefined && typeof p.showStatus !== 'boolean')
      throw new Error(`design/publish.json: board "${n}" has showStatus "${p.showStatus}" - use true or false`)
    if (!ARTIFACT_TYPES.includes(type as ArtifactType))
      throw new Error(`design/publish.json: board "${n}" has type "${type}" - use ${ARTIFACT_TYPES.join(' | ')}`)
    if (p.open !== undefined && !VIEW_MODES.includes(p.open as ViewMode))
      throw new Error(`design/publish.json: board "${n}" has open "${p.open}" - use ${VIEW_MODES.join(' | ')}`)
    if (p.transition !== undefined && !DECK_TRANSITIONS.includes(p.transition as any))
      throw new Error(`design/publish.json: board "${n}" has transition "${p.transition}" - use ${DECK_TRANSITIONS.join(' | ')}`)
    if (p.chrome !== undefined && !DECK_CHROME.includes(p.chrome as any))
      throw new Error(`design/publish.json: board "${n}" has chrome "${p.chrome}" - use ${DECK_CHROME.join(' | ')}`)
    // the deck fields are inert off a deck - a typo'd board type would otherwise
    // carry them silently
    if ((p.transition !== undefined || p.chrome !== undefined) && type !== 'slides' && p.open !== 'slides')
      throw new Error(`design/publish.json: board "${n}" sets transition/chrome but is not a slides board - set "type": "slides" or "open": "slides", or drop them`)
    // freezing an unspecified mode is meaningless - the lock caps disclosure,
    // and what it caps to must be a decision, never a default
    if (p.lock && p.open === undefined)
      throw new Error(`design/publish.json: board "${n}" sets "lock" without "open" - name the mode the lock freezes`)
    out[n] = {
      max: p.max, type: type as ArtifactType,
      ...(p.showStatus === true ? { showStatus: true } : {}),
      ...(p.open ? { open: p.open as ViewMode } : {}), ...(p.lock ? { lock: true } : {}),
      ...(p.transition ? { transition: p.transition as any } : {}), ...(p.chrome ? { chrome: p.chrome as any } : {}),
    }
  }
  if (policy.reveal !== undefined) {
    if (typeof policy.reveal !== 'object' || policy.reveal === null) throw new Error('design/publish.json: "reveal" must be an object')
    if (policy.reveal.structure !== undefined) reveal.structure = policy.reveal.structure === true
    if (policy.reveal.source !== undefined) reveal.source = policy.reveal.source === true
  }
  return { boards: out, reveal }
}

/** The v1 shape - name -> ceiling. Kept because serve/collab enforce from it. */
export function resolvePublish(
  root: string, allBoards: Record<string, any>, boardsFlag?: string, allBoardsFlag?: boolean,
): Record<string, 'read' | 'comment'> {
  const policy = resolvePolicy(root, allBoards, boardsFlag, allBoardsFlag)
  return Object.fromEntries(Object.entries(policy.boards).map(([n, p]) => [n, p.max]))
}

/** Read every board file; returns name -> parsed json. Bad JSON fails the build loudly, and so
 *  does a board-named entry that is not a regular file (a symlink could publish JSON from
 *  outside the project - the build fails closed rather than skipping it quietly). */
export function readBoards(root: string): Record<string, any> {
  const dir = join(root, 'design', 'boards')
  const de = checkBoardsDir(root, dir)
  if (de) throw new Error(de)
  const { boards, skipped } = listBoardFiles(dir)
  if (skipped.length) throw new Error(`design/boards/${skipped[0]} is not a regular file (a symlinked board cannot be published)`)
  const out: Record<string, any> = {}
  for (const b of boards) {
    if (b.json === null) throw new Error(`design/boards/${b.name}.json is not valid JSON`)
    out[b.name] = b.json
  }
  return out
}

/** Switcher order = the sidebar's reading order: the folder tree over the PUBLISHED boards only
 *  (a folder left with no published board at any depth drops out - its name never reaches the bundle),
 *  flattened depth-first; all-scenes always LAST (it is the expensive everything-board, never
 *  the landing). `names[0]` is where `/` opens. Folder names of published boards are structure,
 *  like board names: they ship. */
export function publishedTree(published: string[], allBoards: Record<string, any>, folders: FolderRow[]): { tree: TreeItem[]; names: string[] } {
  const built = buildTree(
    published.filter((n) => n !== 'all-scenes').map((n) => ({ name: n, ...boardFields(allBoards[n], isBoardName) })),
    folders,
  )
  const prune = (items: TreeItem[]): TreeItem[] => items.flatMap((it): TreeItem[] => {
    if (it.kind === 'board') return [it]
    const kids = prune(it.items)
    return kids.length ? [{ ...it, items: kids }] : []
  })
  const tree = prune(built)
  return { tree, names: [...flatten(tree), ...(published.includes('all-scenes') ? ['all-scenes'] : [])] }
}

/** The bundle's manifest: the published frames, and descriptions of published things ONLY -
 *  the project's, the published scenes' (their brief path only when source is revealed),
 *  the published boards' and the folders those sit in. No unpublished name or sentence. */
export function publishedManifest(manifest: Manifest, pubFrames: FrameEntry[], publishedNames: string[], strip: boolean, showStatus: ReadonlySet<string> = new Set()): Manifest {
  const pubScenes = new Set(pubFrames.map((f) => f.scene))
  const pubBoardSet = new Set(publishedNames)
  // spec 20's publication projection: a board's status ships only where its publish row opts in,
  // only the statuses that say nothing private (rows 5-9), and never its reason
  const pubBoards = (manifest.boards ?? []).filter((b) => pubBoardSet.has(b.name)).map(({ status, ...b }) => {
    const shown = showStatus.has(b.name) ? publishableStatus(status) : null
    return shown ? { ...b, status: shown } : b
  })
  // the folders published boards sit in, and the parents of those - structure, like board names
  const pubFolderSet = new Set(pubBoards.map((b) => b.folder).filter(Boolean))
  for (const f of manifest.folders ?? []) if (f.parent && pubFolderSet.has(f.name)) pubFolderSet.add(f.parent)
  const pubFolders = (manifest.folders ?? []).filter((f) => pubFolderSet.has(f.name))
  return {
    ...(manifest.project ? { project: manifest.project } : {}),
    ...(pubFolders.length ? { folders: pubFolders } : {}),
    ...(pubBoards.length ? { boards: pubBoards } : {}),
    scenes: manifest.scenes.filter((s) => pubScenes.has(s.name))
      // the note is viewer-facing canvas content (spec 18): it survives the source strip, the brief path does not
      .map(({ name, title, description, brief, note }) => ({ name, frames: pubFrames.filter((f) => f.scene === name).length, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(brief && !strip ? { brief } : {}), ...(note ? { note } : {}) })),
    frames: pubFrames,
  }
}

/** What a published status may carry, and a published board's meta - nothing else (spec 20). */
const STATUS_KEYS: ReadonlySet<string> = new Set(['status', 'fill'])
const META_KEYS: ReadonlySet<string> = new Set(['type', 'status'])
/** The fields of a board file that point into context/ - stripped from every published board. */
export const EVIDENCE_FIELDS = ['status', 'reason', 'capability'] as const
export function withoutEvidence(board: any): any {
  if (!board || typeof board !== 'object' || Array.isArray(board)) return board
  const out = { ...board }
  for (const k of EVIDENCE_FIELDS) delete out[k]
  return out
}
/** The build's own check of the projection: if a stripped field survives into the bundle, the
 *  build fails - a later edit to the assembly must never quietly ship the evidence trail. */
export function assertProjected(data: { boards: Record<string, any>; manifest: Manifest; meta?: Record<string, Record<string, unknown>> }, showStatus: ReadonlySet<string>) {
  const statusOk = (n: string, st: unknown): boolean => {
    if (!st || typeof st !== 'object' || Array.isArray(st)) return false
    const o = st as Record<string, unknown>
    return showStatus.has(n) && PUBLISHABLE.has(o.status as never) && Object.keys(o).every((k) => STATUS_KEYS.has(k))
  }
  for (const [n, b] of Object.entries(data.boards)) for (const k of EVIDENCE_FIELDS)
    if (b && typeof b === 'object' && k in b) throw new Error(`build: board "${n}" would ship its "${k}" - the publication projection failed`)
  for (const b of data.manifest.boards ?? []) {
    const st = (b as { status?: unknown }).status
    if (st !== undefined && !statusOk(b.name, st)) throw new Error(`build: board "${b.name}" would ship a status its publish row did not allow`)
  }
  for (const [n, m] of Object.entries(data.meta ?? {})) {
    if (Object.keys(m).some((k) => !META_KEYS.has(k))) throw new Error(`build: board "${n}" would ship meta beyond its type and status`)
    if (m.status !== undefined && !statusOk(n, m.status)) throw new Error(`build: board "${n}" would ship a status its publish row did not allow`)
  }
}

/** The folder registry: absent = no folders (boards still imply theirs); malformed fails the build. */
function readFolders(root: string): FolderRow[] {
  const reg = readRegistry(join(root, 'design', 'boards'))
  if (reg.state === 'malformed') throw new Error(reg.error)
  return reg.folders
}

/**
 * The generated registry with OPAQUE keys - the source strip's half of the
 * bundle (01-sharing §6.2). Object keys are string literals that survive
 * bundling verbatim, so with `reveal.source` off they must not be repo paths.
 * The real paths appear only inside import() arguments, which rollup rewrites
 * to chunk imports - they never reach the output. Layout chains are
 * precomputed per key, because the path-walking logic needs the very strings
 * being hidden.
 */
function registrySourceOpaque(root: string, frames: { id: string; file: string }[], salt: string): string {
  const bases = ['/design/scenes', '/design/components']
  const opaque = (s: string) => 'k' + createHash('sha256').update(salt).update(s).digest('hex').slice(0, 10)
  const layoutFiles = new Set<string>()
  const chainFor = (key: string): string[] => {
    const base = bases.find((b) => key.startsWith(b + '/')) ?? bases[0]
    const chain: string[] = []
    let dir = key.slice(0, key.lastIndexOf('/'))
    while (dir.length >= base.length) {
      for (const ext of ['tsx', 'jsx']) {
        const lk = `${dir}/_layout.${ext}`
        if (existsSync(join(root, lk.slice(1)))) { chain.unshift(lk); layoutFiles.add(lk); break }
      }
      if (dir === base) break
      dir = dir.slice(0, dir.lastIndexOf('/'))
    }
    return chain
  }
  const rows = frames.map((f) => {
    const key = '/' + posix(f.file)
    return { id: f.id, key, ok: opaque(key), chain: [] as string[] }
  })
  for (const r of rows) r.chain = chainFor(r.key).map(opaque)
  const providers = ['tsx', 'jsx'].map((e) => `/design/providers.${e}`).filter((p) => existsSync(join(root, p.slice(1))))
  return `// generated by \`${NAME} build\` - source paths are opaque (reveal.source is off)
export const frames = { ${rows.map((r) => `'${r.ok}': () => import('${r.key}')`).join(', ')} }
export const layouts = { ${[...layoutFiles].map((lk) => `'${opaque(lk)}': () => import('${lk}')`).join(', ')} }
export const providers = { ${providers.map((p, i) => `'p${i}': () => import('${p}')`).join(', ')} }
const idToKey = { ${rows.map((r) => `'${r.id}': '${r.ok}'`).join(', ')} }
export function frameFile(frameId) { return idToKey[frameId] ?? null }
const chains = { ${rows.map((r) => `'${r.ok}': ${JSON.stringify(r.chain)}`).join(', ')} }
export function layoutChain(fileKey) { return chains[fileKey] ?? [] }
`
}

/** The generated registry for filtered builds: explicit imports only, same exports. */
function registrySource(root: string, frameKeys: string[]): string {
  const bases = ['/design/scenes', '/design/components']
  const layouts = new Set<string>()
  for (const key of frameKeys) {
    const base = bases.find((b) => key.startsWith(b + '/')) ?? bases[0]
    let dir = key.slice(0, key.lastIndexOf('/'))
    while (dir.length >= base.length) {
      for (const ext of ['tsx', 'jsx']) {
        if (existsSync(join(root, `${dir}/_layout.${ext}`.slice(1)))) layouts.add(`${dir}/_layout.${ext}`)
      }
      if (dir === base) break
      dir = dir.slice(0, dir.lastIndexOf('/'))
    }
  }
  const providers = ['tsx', 'jsx'].map((e) => `/design/providers.${e}`).filter((p) => existsSync(join(root, p.slice(1))))
  const map = (keys: Iterable<string>) => `{ ${[...keys].map((k) => `'${k}': () => import('${k}')`).join(', ')} }`
  return `// generated by \`${NAME} build --boards\` - only published frames are imported
export const frames = ${map(frameKeys)}
export const layouts = ${map(layouts)}
export const providers = ${map(providers)}
export function frameFile(frameId) {
  for (const ext of ['tsx', 'jsx']) {
    for (const prefix of ['/design/scenes/', '/design/']) {
      const key = prefix + frameId + '.' + ext
      if (key in frames) return key
    }
  }
  return null
}
export function layoutChain(fileKey) {
  const dir = fileKey.slice(0, fileKey.lastIndexOf('/'))
  const chain = []
  const base = fileKey.startsWith('/design/scenes/') ? '/design/scenes' : '/design/components'
  let cur = dir
  while (cur.length >= base.length) {
    for (const ext of ['tsx', 'jsx']) {
      const key = cur + '/_layout.' + ext
      if (key in layouts) { chain.unshift(key); break }
    }
    if (cur === base) break
    cur = cur.slice(0, cur.lastIndexOf('/'))
  }
  return chain
}
`
}

export async function buildSite(root: string, boardsFlag?: string, allBoardsFlag?: boolean, embedSeeds?: boolean, textures = true) {
  const config = await loadConfig(root)
  const host = detectHost(root)
  const pkgDir = packageDir()
  const clientDir = join(pkgDir, 'src', 'client')
  const outDir = join(root, 'design', '.dist')

  // ---- data: manifest + boards, gated by the publish policy (the privacy boundary) ----
  const manifest = scanFrames(root, { name: config.share.name || basename(root), description: config.description })
  const allBoards = readBoards(root)
  const policy = resolvePolicy(root, allBoards, boardsFlag, allBoardsFlag)
  // spec 20: a board's type suggests how it presents when its row names no type - said once per
  // build, never applied: an existing row keeps presenting the way it always has
  let named: Record<string, unknown> = {}
  try { named = JSON.parse(readFileSync(join(root, 'design', 'publish.json'), 'utf8')).boards ?? {} } catch { /* --boards / --all-boards */ }
  for (const [n, pb] of Object.entries(policy.boards)) {
    const row = named[n]
    if (row && typeof row === 'object' && (row as { type?: unknown }).type !== undefined) continue
    const bt = manifest.boards?.find((b) => b.name === n)?.type as BoardType | undefined
    const suggested = bt ? PROPOSED_PUBLISH[bt] : undefined
    if (suggested && suggested !== pb.type) console.log(`  note: board "${n}" is a ${bt} board - its publish row could say "type": "${suggested}" (it publishes as "${pb.type}" until it does)`)
  }
  const rights = Object.fromEntries(Object.entries(policy.boards).map(([n, p]) => [n, p.max])) as Record<string, 'read' | 'comment'>
  // the source strip (01-sharing §6.2): with reveal.source off - the published
  // default - no repo path reaches the bundle. Manifest `file` fields, registry
  // keys, HTML frame paths and chunk names all go opaque; laser's copy degrades.
  // Every opaque token is KEYED by a per-build random salt: an unkeyed hash of a
  // path is an offline confirmation oracle (guess the path, hash it, compare) -
  // the salt never ships, so the published tokens confirm nothing.
  const strip = !policy.reveal.source
  const buildSalt = randomBytes(16).toString('hex')
  const opaquePath = (id: string, ext: string) => `__mv/f/mv${createHash('sha256').update(buildSalt).update(id).digest('hex').slice(0, 12)}${ext}`
  const { tree, names: publishedNames } = publishedTree(Object.keys(rights), allBoards, readFolders(root))
  const includeAll = publishedNames.includes('all-scenes')
  const boards: Record<string, any> = {}
  // spec 20's projection: a published board keeps its layout and frames; its status, reason and
  // capability - the evidence trail into context/ - never ship
  for (const n of publishedNames) if (allBoards[n]) boards[n] = withoutEvidence(allBoards[n])

  let frames = manifest.frames
  if (!includeAll) {
    const wanted = new Set<string>()
    for (const b of Object.values(boards))
      for (const node of Array.isArray(b?.nodes) ? b.nodes : [])
        if (typeof node?.frame === 'string') wanted.add(node.frame)
    frames = manifest.frames.filter((f) => wanted.has(f.id))
  }
  // the published manifest: with the strip on, `file` goes opaque - html frames
  // keep a real (opaque) servable path, tsx frames an inert token the client's
  // shape check accepts and laser shows as-is
  const pubFrames = strip
    ? frames.map((f) => ({ ...f, file: opaquePath(f.id, f.kind === 'html' ? '.html' : '') }))
    : frames
  const showStatus = new Set(publishedNames.filter((n) => policy.boards[n]?.showStatus))
  const pubManifest = publishedManifest(manifest, pubFrames, publishedNames, strip, showStatus)
  // per-board artifact metadata rides beside rights: the type picks the landing
  // view, open/lock are the owner's explicit calls (04-solution §2.35)
  // a slides board (type OR open) plays only its slide: true frames. Non-slide
  // frames on it are a warning; a board with NO slides at all is an error -
  // 0.13.0 let `slides` alias present, so an upgraded project could otherwise
  // publish an empty deck in silence (frames silently vanishing from play
  // was the old failure shape)
  for (const n of publishedNames) {
    const pb = policy.boards[n]
    if (pb?.type !== 'slides' && pb?.open !== 'slides') continue
    const ids = new Set((boards[n]?.nodes ?? []).map((x: { frame: string }) => x.frame))
    const on = pubManifest.frames.filter((f) => ids.has(f.id))
    const off = on.filter((f) => !(f.kind === 'tsx' && f.slide))
    if (off.length === on.length)     // zero slides - including an EMPTY board, which is a deck of nothing
      throw new Error(`design/publish.json: board "${n}" plays as slides but none of its ${on.length} frame(s) carry \`slide: true\` - add it to the frames' meta, or set "type"/"open" to "present" (0.13.0 let slides alias present; 0.14.0 plays only slide frames)`)
    if (off.length)
      console.warn(`  warning: board "${n}" plays as slides but ${off.length} frame(s) are not slides (${off.slice(0, 4).map((f) => f.id).join(', ')}${off.length > 4 ? ', …' : ''}) - they will not play`)
  }
  const boardsMeta = Object.fromEntries(publishedNames
    .filter((n) => policy.boards[n])
    .map((n) => {
      const p = policy.boards[n]
      return [n, {
        type: p.type, ...(p.open ? { open: p.open } : {}), ...(p.lock ? { lock: true } : {}),
        ...(p.transition ? { transition: p.transition } : {}), ...(p.chrome ? { chrome: p.chrome } : {}),
      }]
    }))
  // when EVERY published board is locked to a stage mode, the canvas shell is
  // never offered - the bundle boots straight into the locked surface (§5.1's
  // all-boards rule; the Publish-to-web shape)
  const lockedShell = publishedNames.length > 0 && publishedNames.every((n) => {
    const p = policy.boards[n]
    return !!p?.lock && !!p.open && ['present', 'focus', 'slides'].includes(p.open)
  })
  // names drives the published board switcher (all-scenes only when actually published);
  // default is where `/` opens - the first published board, never a synthesized aggregate
  // titles: what the published switcher labels boards by (folder titles ride on the tree)
  const titles = Object.fromEntries(publishedNames.flatMap((n) => { const t = boardFields(allBoards[n], isBoardName).title; return t ? [[n, t]] : [] }))
  // types and opted-in statuses for the published sidebar (spec 20), off the projected manifest
  const meta = Object.fromEntries((pubManifest.boards ?? []).flatMap((b) =>
    b.type || b.status ? [[b.name, { ...(b.type ? { type: b.type } : {}), ...(b.status ? { status: b.status } : {}) }]] : []))
  // the textures' generation is minted BEFORE the bundle so the shell can name the index this build shipped
  const bakeGen = textures ? Date.now() : undefined
  const data = {
    bakes: bakeGen,
    manifest: pubManifest, boards, names: publishedNames, tree, ...(Object.keys(titles).length ? { titles } : {}), ...(Object.keys(meta).length ? { meta } : {}),
    // a published status is a snapshot: the tooltip says when it was read
    ...(Object.values(meta).some((m) => (m as { status?: unknown }).status) ? { statusAsOf: new Date().toISOString() } : {}),
    default: publishedNames.find((n) => n !== 'all-scenes') ?? publishedNames[0],
    rights, policy: { boards: boardsMeta, reveal: policy.reveal, ...(lockedShell ? { lockedShell: true } : {}) },
  }
  assertProjected(data, showStatus)

  // ---- build overrides: real sh-data + the generated registry ----
  // The registry is generated whenever boards are filtered (explicit imports
  // only - excluded frames never enter the bundle) AND whenever the source
  // strip is on (opaque keys - repo paths never enter it either).
  const registryFile = posix(join(clientDir, 'frame-host', 'registry.ts'))
  const lockedFile = posix(join(clientDir, 'shell', 'LockedApp.tsx'))
  const tsxFrames = frames.filter((f) => f.kind === 'tsx')
  const overrides: Plugin = {
    name: 'marver-build',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id === 'virtual:sh-data') return '\0sh-data-build'
      // all-boards-locked: the canvas shell is ABSENT, not hidden - main.tsx's
      // App import resolves to the locked entry and App.tsx (sidebar, canvas,
      // toolbar) never enters the bundle (01-sharing §5.1)
      if (lockedShell && (id === './App.tsx' || id.endsWith('/shell/App.tsx')) && importer && posix(importer).endsWith('/shell/main.tsx')) return lockedFile
    },
    load(id) {
      if (id === '\0sh-data-build') return `export default ${JSON.stringify(data)}`
      if (posix(id) === registryFile) {
        if (strip) return registrySourceOpaque(root, tsxFrames.map((f) => ({ id: f.id, file: posix(f.file) })), buildSalt)
        if (!includeAll) return registrySource(root, tsxFrames.map((f) => '/' + posix(f.file)))
      }
    },
  }

  const plugins: any[] = [overrides, react()]
  if (host.tailwind === 4) {
    const tw = await tailwind4Plugin(root)
    if (tw) plugins.push(...tw)
  }
  let css: Record<string, unknown> | undefined
  if (host.tailwind === 3) css = (await tailwind3Css(root)) ?? undefined
  plugins.push(marverPlugin({ root, clientDir, config, detectedThemeCss: host.themeCss }), cssFixPlugin())

  // Production mode, EXPLICITLY - never inherited from the shell. A build run
  // with NODE_ENV=development/test makes plugin-react emit jsxDEV calls whose
  // `fileName` bakes the absolute repo path of every frame into its chunk,
  // which defeats the source strip from the outside. Publishing is production
  // by definition; the ambient variable has no vote.
  process.env.NODE_ENV = 'production'
  const result = await viteBuild({
    configFile: false,
    mode: 'production',
    root,
    css: css as any,
    plugins,
    resolve: { dedupe: ['react', 'react-dom'], tsconfigPaths: true } as any,
    build: {
      outDir,
      emptyOutDir: true,
      cssCodeSplit: true,
      // CSS ships unminified: lightningcss (even with modern cssTarget) strips the
      // standard backdrop-filter keeping only -webkit-, which Chromium computes to
      // none with a var() value - the whole glass language goes flat. esbuild minify
      // is not an option either (vite 8/rolldown does not ship esbuild, CI lacks it).
      // The stylesheet is ~30KB; correctness beats the few KB.
      cssMinify: false,
      rollupOptions: {
        input: {
          shell: join(clientDir, 'shell', 'main.tsx'),
          frame: join(clientDir, 'frame-host', 'main.tsx'),
          stage: join(clientDir, 'stage', 'main.tsx'),
        },
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          // chunk names derive from source FILENAMES - with the strip on they
          // would leak every frame's basename, so chunks go anonymous
          chunkFileNames: strip ? 'assets/c-[hash].js' : 'assets/[name]-[hash].js',
          assetFileNames: strip ? 'assets/a-[hash][extname]' : 'assets/[name]-[hash][extname]',
        },
      },
    },
    logLevel: 'warn',
  })
  const output = (Array.isArray(result) ? result[0] : (result as Rollup.RollupOutput)).output

  // ---- generate the pages from the build output (dev's routes middleware, statically) ----
  const chunks = output.filter((o): o is Rollup.OutputChunk => o.type === 'chunk')
  const byFile = new Map(chunks.map((c) => [c.fileName, c]))
  const cssFor = (entryName: string): string[] => {
    const entry = chunks.find((c) => c.isEntry && c.name === entryName)
    const seen = new Set<string>(), css = new Set<string>()
    const walk = (c?: Rollup.OutputChunk) => {
      if (!c || seen.has(c.fileName)) return
      seen.add(c.fileName)
      for (const f of c.viteMetadata?.importedCss ?? []) css.add(f)
      for (const imp of c.imports) walk(byFile.get(imp))
    }
    walk(entry)
    return [...css]
  }
  const page = (srcDir: string, entryName: string, outPath: string) => {
    const entry = chunks.find((c) => c.isEntry && c.name === entryName)!
    const links = cssFor(entryName).map((f) => `<link rel="stylesheet" href="/${f}" />`).join('\n    ')
    const html = readFileSync(join(clientDir, srcDir, 'index.html'), 'utf8')
      .replaceAll('{{ROUTE}}', ROUTE)
      .replace('<script type="module" src="{{ENTRY}}"></script>', `${links}\n    <script type="module" src="/${entry.fileName}"></script>`)
      // the frame document names the textures' generation it was published with: the shell installs
      // textures on a document of the same build only (an old shell must not dress a republished frame)
      .replace(/<head([^>]*)>/, (m) => entryName === 'frame' && bakeGen ? `${m}\n    <meta name="mv-bakes" content="${bakeGen}">` : m)
    mkdirSync(dirname(join(outDir, outPath)), { recursive: true })
    writeFileSync(join(outDir, outPath), html)
  }
  page('shell', 'shell', 'index.html')
  page('frame-host', 'frame', `${ROUTE.slice(1)}/frame/index.html`)
  page('stage', 'stage', `${ROUTE.slice(1)}/stage/index.html`)

  // favicon pack + the shared bridge (plain module, ships verbatim)
  cpSync(join(clientDir, 'shell', 'favicon'), join(outDir, ROUTE.slice(1), 'favicon'), { recursive: true })
  // the bridge and the module it imports: without inspect.js beside it the bridge never ran in a
  // published html frame (no ready, no sleep, no laser, no comments there)
  for (const f of ['bridge.js', 'inspect.js']) cpSync(join(clientDir, 'frame-host', f), join(outDir, 'assets', f))

  // html frames: copied with the theme stylesheet + bridge statically injected
  const frameCss = cssFor('frame').map((f) => `<link rel="stylesheet" href="/${f}" />`).join('\n')
  for (const f of frames.filter((x) => x.kind === 'html')) {
    const src = readFileSync(join(root, f.file), 'utf8')
    const inject = `${frameCss}\n<script type="module" src="/assets/bridge.js?html=1"></script>\n`
    let html = src.includes('</head>') ? src.replace('</head>', `${inject}</head>`) : inject + src
    // SYNCHRONOUS closed-shadow shim, at head-START so it beats any authored classic script that
    // could attachShadow({mode:'closed'}) before the deferred bridge module runs (else the serializer
    // would miss it and ship a lean without the shadow content).
    const shim = `<script>(function(){var a=Element.prototype.attachShadow;if(a)Element.prototype.attachShadow=function(i){if(i&&i.mode==='closed')window.__mvClosedShadow=1;return a.call(this,i)};})();</script>`
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + shim) : shim + html
    // the textures' generation, as on the tsx frame document (the shell dresses this build only)
    if (bakeGen) html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}<meta name="mv-bakes" content="${bakeGen}">`) : `<meta name="mv-bakes" content="${bakeGen}">` + html
    // with the strip on, html frames are served AT an opaque path - the source
    // path (which is the address the manifest hands out) never reaches dist
    const dest = strip ? opaquePath(f.id, '.html') : f.file
    mkdirSync(dirname(join(outDir, dest)), { recursive: true })
    writeFileSync(join(outDir, dest), html)
  }

  // ---- referenced assets: copied BY REFERENCE from the modules that actually
  // entered the bundle - the filtered registry already excluded unpublished frames, so
  // walking chunk moduleIds IS the reachable-module-graph scan (shared components and
  // variant bodies included, hand-rolled import resolution excluded by construction).
  // An unreferenced screenshot in design/assets/ never ships.
  const assetsDir = join(root, 'design', 'assets')
  const rootP = posix(root)
  const moduleIds = new Set<string>()
  for (const c of chunks) for (const id of (c as any).moduleIds ?? Object.keys((c as any).modules ?? {})) moduleIds.add(String(id))
  const refs = new Set<string>()
  for (const id of moduleIds) {
    const file = posix(String(id)).split('?')[0]
    // every bundled first-party module is scanned - including monorepo siblings
    // OUTSIDE the project root (pnpm workspaces resolve through to real paths);
    // only third-party node_modules code is skipped
    if (file.startsWith('\0') || !file.startsWith('/') || file.includes('/node_modules/')) continue
    if (!/\.(tsx|jsx|ts|js|mjs)$/.test(file)) continue
    let src: string
    try { src = readFileSync(file, 'utf8') } catch { continue }
    const rel = file.startsWith(rootP + '/') ? file.slice(rootP.length + 1) : file
    for (const r of scanAssetRefs(src, rel)) refs.add(r)
  }
  // sticky notes (spec 18) are prose outside any module: their images ride the same copy
  for (const note of [...pubManifest.frames.map((f) => f.note), ...pubManifest.scenes.map((s) => s.note)])
    if (note) for (const r of markdownImageRefs(note)) refs.add(r)
  let copiedAssets = 0
  const realAssets = existsSync(assetsDir) ? realpathSync(assetsDir) : null
  // generated posters first: a `<clip>.poster.png` ref whose file is missing is rendered
  // from the clip now (Chrome; ensurePoster realpath-contains both the clip it reads and the
  // folder it writes), so the copy below finds it - or the build says exactly why not
  for (const r of refs) {
    if (!isLocalAssetRef(r) || !r.endsWith('.poster.png') || existsSync(join(assetsDir, r))) continue
    const { ensurePoster } = await import('./poster.ts')
    const g = await ensurePoster(assetsDir, r.slice(0, -'.poster.png'.length))
    if (!g.ok) throw new Error(`design/assets/${r}: ${g.error}`)
    console.log(`  poster: rendered design/assets/${r} (${g.width}×${g.height})`)
  }
  for (const r of refs) {
    if (!isLocalAssetRef(r)) continue          // external md refs render as "unavailable" at runtime
    const srcFile = join(assetsDir, r)
    if (!existsSync(srcFile)) throw new Error(`design/assets/${r} is referenced by a published frame but does not exist`)
    // realpath containment: a symlink inside design/assets/ must not publish an outside file
    const real = posix(realpathSync(srcFile))
    if (!realAssets || !(real === posix(realAssets) || real.startsWith(posix(realAssets) + '/')))
      throw new Error(`design/assets/${r} resolves outside design/assets/ (symlink) - refusing to publish it`)
    const dest = join(outDir, 'design', 'assets', r)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(srcFile, dest)
    copiedAssets++
  }

  // comment logs for published boards ride along as the SEED: serve
  // unions them into its live store on boot - a republish adds, never clobbers.
  // Seeds live OUTSIDE the web root (design/.dist-seeds): every event carries its
  // author's email, and anything under .dist is statically served to any
  // gate-passer. --embed-seeds restores the old in-root copy for static-only
  // hosts that will never run `marver serve` - a loud, identifying opt-in.
  const commentsDir = join(root, 'design', 'comments')
  const seedOut = embedSeeds ? join(outDir, 'design', 'comments') : join(root, 'design', '.dist-seeds')
  if (!embedSeeds) rmSync(seedOut, { recursive: true, force: true })   // no stale boards from a previous publish
  if (existsSync(commentsDir)) {
    let seeded = 0
    for (const n of publishedNames) {
      const f = join(commentsDir, `${n}.jsonl`)
      if (!existsSync(f)) continue
      mkdirSync(seedOut, { recursive: true })
      cpSync(f, join(seedOut, `${n}.jsonl`))
      seeded++
    }
    if (seeded) console.log(`  comments: ${seeded} board log${seeded === 1 ? '' : 's'} seeded${embedSeeds ? '' : ' (design/.dist-seeds, outside the web root)'}`)
    if (seeded && embedSeeds) console.log(
      `  WARNING: --embed-seeds put comment history in the web root - every event carries\n` +
      `  its author's email, readable by anyone who can reach the deployed files.`)
  }

  // serve reads this: gate page title, branding footer, and the app's own logo when one
  // exists (agent-native convention: design/logo.svg|png; host public/ as fallback)
  let name = basename(root)
  try { name = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name ?? name } catch { /* keep basename */ }
  if (config.share.name) name = config.share.name
  let logo: string | undefined
  const logoLadder = [
    ...(config.share.logo ? [config.share.logo] : []),
    'design/logo.svg', 'design/logo.png', 'public/logo.svg', 'public/logo.png', 'public/favicon.svg',
  ]
  for (const cand of logoLadder) {
    if (!existsSync(join(root, cand))) continue
    const ext = cand.endsWith('.png') ? 'png' : 'svg'
    cpSync(join(root, cand), join(outDir, ROUTE.slice(1), `logo.${ext}`))
    logo = `${ROUTE}/logo.${ext}`
    break
  }
  // rights ride in meta.json so serve can enforce the policy on comment APIs without parsing the bundle - hiding UI controls is not authorization
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify({
    name, branding: config.share.branding, logo, rights,
    boards: boardsMeta, reveal: policy.reveal,
    ...(config.share.frontDoor === false ? { frontDoor: false } : {}),
    ...(config.share.notify === false ? { notify: false } : {}),
  }))

  // textures for the published hi-fi frames (publish-bakes.ts): compiled against THIS site, shipped with it
  let textureLine = '  textures: skipped (--no-textures)'
  if (textures && bakeGen) {
    const { bakePublished } = await import('./publish-bakes.ts')
    const pubFrameFile = new Map(pubFrames.map((f) => [f.id, f]))
    const r = await bakePublished({
      root, outDir, gen: bakeGen, boards, themes: config.themes, log: (l) => console.log(l),
      frames: pubFrames, viewports: config.viewports, allScenes: includeAll,
      // the frame's PUBLISHED url (an html frame's opaque path when the source is stripped)
      urlFor: (id, theme) => { const f = pubFrameFile.get(id); if (!f) return null; return f.kind === 'html' ? `/${f.file}?theme=${encodeURIComponent(theme)}&r=${bakeGen}` : `/__mv/frame/?id=${encodeURIComponent(id)}&theme=${encodeURIComponent(theme)}&r=${bakeGen}` },
    })
    textureLine = r === null
      ? `  textures: none - no Chrome on this machine; frames with glass will rest live (install Chrome, or ship as is)`
      : r.asked === 0 ? '  textures: nothing to compile'
      : `  textures: ${r.asleep} frame view${r.asleep === 1 ? '' : 's'} asleep under certified glass, ${r.live} with live glass, ${r.plain} without effects (${r.asked} asked: every published node x ${config.themes.length || 1} theme${config.themes.length === 1 ? '' : 's'}; ${(r.bytes / 1024).toFixed(0)} KB, ${(r.ms / 1000).toFixed(1)} s)`
  }

  console.log(`\n  ${NAME} build → design/.dist`)
  console.log(`  boards: ${publishedNames.map((n) => `${n} (${rights[n]})`).join(', ')}`)
  console.log(textureLine)
  console.log(`  frames: ${frames.length}${includeAll ? '' : ` of ${manifest.frames.length} (build-time filter)`}`)
  if (copiedAssets) console.log(`  assets: ${copiedAssets} referenced file${copiedAssets === 1 ? '' : 's'} from design/assets/ (unreferenced assets never ship)`)
  if (!includeAll && existsSync(join(root, 'public')))
    console.log(`  note: the host public/ directory ships in full - the --boards filter covers frames, not public assets`)
  console.log(`\n  serve it:  npx ${NAME} serve   (set MARVER_PASSWORD to gate it)\n`)
}
