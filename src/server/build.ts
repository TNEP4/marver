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

/** The publish policy: design/publish.json names what ships and with what
 *  rights. Publishing is default-CLOSED - no policy and no explicit flag = no build.
 *  Returns name -> 'read' | 'comment'. Boards absent from the result do not ship. */
export function resolvePublish(
  root: string, allBoards: Record<string, any>, boardsFlag?: string, allBoardsFlag?: boolean,
): Record<string, 'read' | 'comment'> {
  const known = (n: string) => n === 'all-scenes' || !!allBoards[n]
  if (boardsFlag !== undefined) {
    const names = boardsFlag.split(',').map((s) => s.trim()).filter(Boolean)
    // an empty filter fails CLOSED - `--boards "$UNSET_VAR"` must never publish everything
    if (!names.length) throw new Error('--boards was given but named no boards')
    const missing = names.filter((n) => !known(n))
    if (missing.length) throw new Error(`--boards names not found in design/boards/: ${missing.join(', ')}`)
    return Object.fromEntries(names.map((n) => [n, 'comment' as const]))
  }
  if (allBoardsFlag)
    return Object.fromEntries(
      ['all-scenes', ...Object.keys(allBoards).filter((n) => n !== 'all-scenes')].map((n) => [n, 'comment' as const]))
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
  const out: Record<string, 'read' | 'comment'> = {}
  for (const [n, level] of entries) {
    if (!known(n)) throw new Error(`design/publish.json names an unknown board: ${n}`)
    if (level !== 'read' && level !== 'comment')
      throw new Error(`design/publish.json: board "${n}" has level "${level}" - use "read" or "comment"`)
    out[n] = level
  }
  return out
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
  const rights = resolvePublish(root, allBoards, boardsFlag, allBoardsFlag)
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
  const pubManifest: Manifest = {
    frames,
    scenes: [...new Set(frames.map((f) => f.scene))].sort()
      .map((name) => ({ name, frames: frames.filter((f) => f.scene === name).length })),
  }
  // names drives the published board switcher (all-scenes only when actually published);
  // default is where `/` opens - the first published board, never a synthesized aggregate
  const data = { manifest: pubManifest, boards, names: publishedNames, default: publishedNames.find((n) => n !== 'all-scenes') ?? publishedNames[0], rights }

  // ---- build overrides: real sh-data + (when filtering) the generated registry ----
  const registryFile = posix(join(clientDir, 'frame-host', 'registry.ts'))
  const overrides: Plugin = {
    name: 'marver-build',
    enforce: 'pre',
    resolveId(id) { if (id === 'virtual:sh-data') return '\0sh-data-build' },
    load(id) {
      if (id === '\0sh-data-build') return `export default ${JSON.stringify(data)}`
      if (!includeAll && posix(id) === registryFile)
        return registrySource(root, frames.filter((f) => f.kind === 'tsx').map((f) => '/' + posix(f.file)))
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

  const result = await viteBuild({
    configFile: false,
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
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
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
    mkdirSync(dirname(join(outDir, f.file)), { recursive: true })
    writeFileSync(join(outDir, f.file), html)
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
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify({ name, branding: config.share.branding, logo, rights }))

  console.log(`\n  ${NAME} build → design/.dist`)
  console.log(`  boards: ${publishedNames.map((n) => `${n} (${rights[n]})`).join(', ')}`)
  console.log(`  frames: ${frames.length}${includeAll ? '' : ` of ${manifest.frames.length} (build-time filter)`}`)
  if (copiedAssets) console.log(`  assets: ${copiedAssets} referenced file${copiedAssets === 1 ? '' : 's'} from design/assets/ (unreferenced assets never ship)`)
  if (!includeAll && existsSync(join(root, 'public')))
    console.log(`  note: the host public/ directory ships in full - the --boards filter covers frames, not public assets`)
  console.log(`\n  serve it:  npx ${NAME} serve   (set MARVER_PASSWORD to gate it)\n`)
}
