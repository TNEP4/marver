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
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAME, ROUTE } from '../cli/name.ts'
import { loadConfig } from './config.ts'
import { detectHost } from './detect.ts'
import { scanFrames, type Manifest } from './manifest.ts'
import { marverPlugin, tailwind3Css, tailwind4Plugin } from './plugin.ts'

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
  if (/<Img\b[^>]*\bsrc\s*=\s*\{/.test(stripped))
    throw new Error(`${moduleId}: <Img src={...}> is computed - published builds copy only statically referenced assets. Use a string literal.`)
  const out: string[] = []
  for (const m of stripped.matchAll(/<Img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g)) out.push(m[1])
  for (const tpl of templates)
    for (const m of tpl.matchAll(/!\[[^\]]*\]\(([^)\s"']+)\)/g)) out.push(m[1])
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

export interface BoardPolicy { max: 'read' | 'comment'; type: ArtifactType; open?: ViewMode; lock?: boolean }
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
  const row = (max: 'read' | 'comment'): BoardPolicy => ({ max, type: 'mix' })
  if (boardsFlag !== undefined) {
    const names = boardsFlag.split(',').map((s) => s.trim()).filter(Boolean)
    // an empty filter fails CLOSED - `--boards "$UNSET_VAR"` must never publish everything
    if (!names.length) throw new Error('--boards was given but named no boards')
    const missing = names.filter((n) => !known(n))
    if (missing.length) throw new Error(`--boards names not found in design/boards/: ${missing.join(', ')}`)
    return { boards: Object.fromEntries(names.map((n) => [n, row('comment')])), reveal }
  }
  if (allBoardsFlag)
    return {
      boards: Object.fromEntries(
        ['all-scenes', ...Object.keys(allBoards).filter((n) => n !== 'all-scenes')].map((n) => [n, row('comment')])),
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
    if (level === 'read' || level === 'comment') { out[n] = row(level); continue }   // v1 row
    if (typeof level !== 'object' || level === null)
      throw new Error(`design/publish.json: board "${n}" has level "${level}" - use "read" or "comment", or a v2 object`)
    const p = level as Record<string, unknown>
    if (p.max !== 'read' && p.max !== 'comment')
      throw new Error(`design/publish.json: board "${n}" needs "max": "read" | "comment"`)
    const type = p.type ?? 'mix'
    if (!ARTIFACT_TYPES.includes(type as ArtifactType))
      throw new Error(`design/publish.json: board "${n}" has type "${type}" - use ${ARTIFACT_TYPES.join(' | ')}`)
    if (p.open !== undefined && !VIEW_MODES.includes(p.open as ViewMode))
      throw new Error(`design/publish.json: board "${n}" has open "${p.open}" - use ${VIEW_MODES.join(' | ')}`)
    // freezing an unspecified mode is meaningless - the lock caps disclosure,
    // and what it caps to must be a decision, never a default
    if (p.lock && p.open === undefined)
      throw new Error(`design/publish.json: board "${n}" sets "lock" without "open" - name the mode the lock freezes`)
    out[n] = { max: p.max, type: type as ArtifactType, ...(p.open ? { open: p.open as ViewMode } : {}), ...(p.lock ? { lock: true } : {}) }
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

/** Read every board file; returns name -> parsed json. Bad JSON fails the build loudly. */
function readBoards(root: string): Record<string, any> {
  const dir = join(root, 'design', 'boards')
  const out: Record<string, any> = {}
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const name = f.replace(/\.json$/, '')
    try { out[name] = JSON.parse(readFileSync(join(dir, f), 'utf8')) }
    catch { throw new Error(`design/boards/${f} is not valid JSON`) }
  }
  return out
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
function registrySourceOpaque(root: string, frames: { id: string; file: string }[]): string {
  const bases = ['/design/scenes', '/design/components']
  const opaque = (s: string) => 'k' + createHash('sha256').update(s).digest('hex').slice(0, 10)
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

export async function buildSite(root: string, boardsFlag?: string, allBoardsFlag?: boolean, embedSeeds?: boolean) {
  const config = await loadConfig(root)
  const host = detectHost(root)
  const pkgDir = packageDir()
  const clientDir = join(pkgDir, 'src', 'client')
  const outDir = join(root, 'design', '.dist')

  // ---- data: manifest + boards, gated by the publish policy (the privacy boundary) ----
  const manifest = scanFrames(root)
  const allBoards = readBoards(root)
  const policy = resolvePolicy(root, allBoards, boardsFlag, allBoardsFlag)
  const rights = Object.fromEntries(Object.entries(policy.boards).map(([n, p]) => [n, p.max])) as Record<string, 'read' | 'comment'>
  // the source strip (01-sharing §6.2): with reveal.source off - the published
  // default - no repo path reaches the bundle. Manifest `file` fields, registry
  // keys, HTML frame paths and chunk names all go opaque; laser's copy degrades.
  const strip = !policy.reveal.source
  const opaquePath = (id: string, ext: string) => `__mv/f/mv${createHash('sha256').update(id).digest('hex').slice(0, 12)}${ext}`
  // switcher order: curated boards ranked by each board's `order` (then name); all-scenes always LAST
  // (it is the expensive everything-board, never the landing). `default` (where `/` opens) is the first.
  const boardOrder = (n: string): number => {
    const o = (allBoards[n] as { order?: unknown } | undefined)?.order
    return typeof o === 'number' && Number.isFinite(o) ? o : Infinity
  }
  const publishedNames = Object.keys(rights).sort((a, b) =>
    a === 'all-scenes' ? 1 : b === 'all-scenes' ? -1 : (boardOrder(a) - boardOrder(b)) || a.localeCompare(b))
  const includeAll = publishedNames.includes('all-scenes')
  const boards: Record<string, any> = {}
  for (const n of publishedNames) if (allBoards[n]) boards[n] = allBoards[n]

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
  const pubManifest: Manifest = {
    frames: pubFrames,
    scenes: [...new Set(pubFrames.map((f) => f.scene))].sort()
      .map((name) => ({ name, frames: pubFrames.filter((f) => f.scene === name).length })),
  }
  // per-board artifact metadata rides beside rights: the type picks the landing
  // view, open/lock are the owner's explicit calls (04-solution §2.35)
  const boardsMeta = Object.fromEntries(publishedNames
    .filter((n) => policy.boards[n])
    .map((n) => {
      const p = policy.boards[n]
      return [n, { type: p.type, ...(p.open ? { open: p.open } : {}), ...(p.lock ? { lock: true } : {}) }]
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
  const data = {
    manifest: pubManifest, boards, names: publishedNames,
    default: publishedNames.find((n) => n !== 'all-scenes') ?? publishedNames[0],
    rights, policy: { boards: boardsMeta, reveal: policy.reveal, ...(lockedShell ? { lockedShell: true } : {}) },
  }

  // ---- build overrides: real sh-data + the generated registry ----
  // The registry is generated whenever boards are filtered (explicit imports
  // only - excluded frames never enter the bundle) AND whenever the source
  // strip is on (opaque keys - repo paths never enter it either).
  const registryFile = posix(join(clientDir, 'frame-host', 'registry.ts'))
  const tsxFrames = frames.filter((f) => f.kind === 'tsx')
  const overrides: Plugin = {
    name: 'marver-build',
    enforce: 'pre',
    resolveId(id) { if (id === 'virtual:sh-data') return '\0sh-data-build' },
    load(id) {
      if (id === '\0sh-data-build') return `export default ${JSON.stringify(data)}`
      if (posix(id) === registryFile) {
        if (strip) return registrySourceOpaque(root, tsxFrames.map((f) => ({ id: f.id, file: posix(f.file) })))
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
  plugins.push(marverPlugin({ root, clientDir, config, detectedThemeCss: host.themeCss }))

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
    mkdirSync(dirname(join(outDir, outPath)), { recursive: true })
    writeFileSync(join(outDir, outPath), html)
  }
  page('shell', 'shell', 'index.html')
  page('frame-host', 'frame', `${ROUTE.slice(1)}/frame/index.html`)
  page('stage', 'stage', `${ROUTE.slice(1)}/stage/index.html`)

  // favicon pack + the shared bridge (plain module, ships verbatim)
  cpSync(join(clientDir, 'shell', 'favicon'), join(outDir, ROUTE.slice(1), 'favicon'), { recursive: true })
  cpSync(join(clientDir, 'frame-host', 'bridge.js'), join(outDir, 'assets', 'bridge.js'))

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
  let copiedAssets = 0
  const realAssets = existsSync(assetsDir) ? realpathSync(assetsDir) : null
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
  }))

  console.log(`\n  ${NAME} build → design/.dist`)
  console.log(`  boards: ${publishedNames.map((n) => `${n} (${rights[n]})`).join(', ')}`)
  console.log(`  frames: ${frames.length}${includeAll ? '' : ` of ${manifest.frames.length} (build-time filter)`}`)
  if (copiedAssets) console.log(`  assets: ${copiedAssets} referenced file${copiedAssets === 1 ? '' : 's'} from design/assets/ (unreferenced assets never ship)`)
  if (!includeAll && existsSync(join(root, 'public')))
    console.log(`  note: the host public/ directory ships in full - the --boards filter covers frames, not public assets`)
  console.log(`\n  serve it:  npx ${NAME} serve   (set MARVER_PASSWORD to gate it)\n`)
}
