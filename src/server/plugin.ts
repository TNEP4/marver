import type { Plugin, ViteDevServer } from 'vite'
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs'
import { basename, join } from 'node:path'
import { hash } from './manifest.ts'
import { NAME, PKG, ROUTE } from '../cli/name.ts'
import type { ShConfig } from './config.ts'
import { scanFrames, writeManifest, affectedFrameIds, type Manifest } from './manifest.ts'
import { apiMiddleware } from './api.ts'
import { routesMiddleware, artifactsRoot } from './routes.ts'
import { ArtifactStore, variantKey, type FrameArtifacts } from './artifacts.ts'
import { Compiler, type CompileJob } from './compiler.ts'
import { checkUpdate, installedVersion } from './update.ts'

const VIRTUAL_THEME = 'virtual:sh-theme'
const VIRTUAL_CONFIG = 'virtual:sh-config'
const VIRTUAL_DATA = 'virtual:sh-data'

export interface PluginCtx {
  root: string
  clientDir: string
  config: ShConfig
  detectedThemeCss: string | null
}

export function marverPlugin(ctx: PluginCtx): Plugin {
  const { root, clientDir, config } = ctx

  // A7 controlled HMR: a design/** frame EDIT is applied by the SHELL (a rev-stamped iframe
  // reload gated on interaction leases), not by Vite's default React Fast Refresh which fires
  // immediately regardless of what the user is doing. handleHotUpdate suppresses the default
  // and queues sh:frame-invalidated; the shell decides when to reload each affected frame.
  let manifest: Manifest = scanFrames(root)
  let devServer: ViteDevServer | null = null
  const bootId = String(process.hrtime.bigint())   // opaque, boot-scoped: a restart never mints a "lower" rev
  let invRev = 0
  const pendingInv = new Set<string>()
  // M7: set by configureServer to recompile the board's lean artifacts (edited frames cache-miss on
  // their new source hash and re-serialize; unchanged ones cache-hit instantly). Kept at plugin scope
  // so the frame-invalidation flush below can fire it - a file edit auto-rebuilds the durable file.
  let recompileArtifacts: (() => void) | null = null
  const flushInv = debounce(() => {
    if (!devServer || !pendingInv.size) return
    const frameIds = [...pendingInv]; pendingInv.clear()
    devServer.ws.send('sh:frame-invalidated', { frameIds, revision: `${bootId}:${++invRev}` })
    recompileArtifacts?.()   // rebuild the affected artifacts; ws 'sh:artifact' pushes the new file href
  }, 120)

  /** Theme resolution: design/theme.css wrapper > configured > detected > empty (spec §5.4). */
  const themeFile = (): string | null => {
    const wrapper = join(root, 'design', 'theme.css')
    if (existsSync(wrapper)) return wrapper
    if (config.theme && existsSync(join(root, config.theme))) return join(root, config.theme)
    if (ctx.detectedThemeCss && existsSync(join(root, ctx.detectedThemeCss))) return join(root, ctx.detectedThemeCss)
    return null
  }

  return {
    name: 'marver',
    // A7: run our handleHotUpdate BEFORE @vitejs/plugin-react's. A marver frame exports `meta`
    // (a non-component) alongside its component, so React Fast Refresh refuses to hot-update it
    // and broadcasts a GLOBAL full-reload (the shell "white zap") as a side effect. By emptying
    // ctx.modules first for a controlled frame, react's hook then sees nothing to refresh and
    // never fires that reload - the shell drives a lease-aware rev-stamped iframe reload instead.
    enforce: 'pre',

    resolveId(id) {
      if (id === VIRTUAL_THEME) {
        const f = themeFile()
        return f ?? '\0' + VIRTUAL_THEME + '.css'
      }
      if (id === VIRTUAL_CONFIG) return '\0' + VIRTUAL_CONFIG
      if (id === VIRTUAL_DATA) return '\0' + VIRTUAL_DATA
    },

    load(id) {
      if (id === '\0' + VIRTUAL_THEME + '.css') {
        console.warn('[marver] no theme detected - frames render unstyled. Create design/theme.css importing your app\'s stylesheet (or set `theme` in design/config.ts).')
        return '/* marver: no theme configured */'
      }
      if (id === '\0' + VIRTUAL_CONFIG) {
        // setup: design/instructions/setup.md is the "no app yet" presence file (init
        // owns it) - the shell shows a banner while it exists, so the state is visible
        // in the thing the human is actually looking at
        // ownership check, not bare existence: a foreign setup.md must not lock the
        // canvas into the no-app banner
        const setupPending = (() => {
          try {
            const s = readFileSync(join(root, 'design', 'instructions', 'setup.md'), 'utf8')
            return s.startsWith('# Setup required') && s.includes('marver init')
          } catch { return false }
        })()
        return `export default ${JSON.stringify({ viewports: config.viewports, themes: config.themes, zoomSpeed: config.zoomSpeed, noTheme: themeFile() == null, setup: setupPending, projectName: basename(root) })}`
      }
      // null in dev - the shell fetches live. Builds provide the real module (build.ts).
      if (id === '\0' + VIRTUAL_DATA) return 'export default null'
    },

    /** HTML frames: inject theme + bridge into any design/**.html Vite serves.
     *  Inline scripts go through vite's html-proxy import-analysis: bare specifiers resolve
     *  through plugins (so `virtual:sh-theme` works); `/@id/` URLs are rejected there. */
    transformIndexHtml: {
      order: 'pre',
      handler(html, hctx) {
        const path = (hctx.originalUrl ?? hctx.path ?? '').split('?')[0]
        if (!path.startsWith('/design/')) return
        const bridge = '/@fs/' + join(clientDir, 'frame-host', 'bridge.js').split('\\').join('/') + '?html=1'
        // head-prepend: module scripts run in DOM order, so the bridge's error listener
        // and theme init beat any authored script in the frame.
        return {
          html,
          tags: [
            // SYNCHRONOUS closed-shadow shim: the bridge is a deferred module, so an authored classic
            // script could attachShadow({mode:'closed'}) before it runs. This classic inline script
            // runs during parse, before authored content, so the serializer can degrade such a frame.
            { tag: 'script', children: `(function(){var a=Element.prototype.attachShadow;if(a)Element.prototype.attachShadow=function(i){if(i&&i.mode==='closed')window.__mvClosedShadow=1;return a.call(this,i)};})();`, injectTo: 'head-prepend' },
            { tag: 'script', attrs: { type: 'module' }, children: `import '${VIRTUAL_THEME}'`, injectTo: 'head-prepend' },
            { tag: 'script', attrs: { type: 'module', src: bridge }, injectTo: 'head-prepend' },
          ],
        }
      },
    },

    /**
     * Frame add/unlink is OUR event (sh:manifest → shell appends/flags nodes); Vite's default for
     * an out-of-graph file is a full-reload broadcast to every client, shell included. Suppress it.
     * Edits to loaded frames keep normal HMR (modules present + file exists → pass through).
     */
    handleHotUpdate(hctx) {
      const affected = affectedFrameIds(hctx.file, root, manifest)
      if (affected === null) {
        // uncontrolled (src/** deps, theme.css, config, a helper we don't map): default HMR.
        // A frame ADD/UNLINK is topology - the sh:manifest path handles it; suppress the default
        // full-reload for an in-scope unlink so an open canvas doesn't hard-refresh.
        const inScope = [join(root, 'design', 'scenes'), join(root, 'design', 'components')].some((w) => hctx.file.startsWith(w))
        if (inScope && !existsSync(hctx.file)) return []
        return
      }
      // controlled edit (or a layout/provider/fixture fanout): the shell drives a lease-aware,
      // rev-stamped reload of exactly these frames. Suppress Vite's default React update.
      if (affected.length) { for (const id of affected) pendingInv.add(id); flushInv() }
      return []
    },

    configureServer(server: ViteDevServer) {
      // THE #20 FIX. registry.ts lives in node_modules, so Vite stamps its import URL
      // with ?v=<hash> and serves it `max-age=31536000,immutable` - correct for static
      // package code, poison for this one module: its TRANSFORM is dynamic (the glob
      // map tracks the host's design/ tree). A restart re-globs server-side while every
      // open tab trusts its year-long cache, and each canvas bricks with "unknown frame
      // id" - unfixable by hard reload (iframe subresources never revalidate immutable
      // entries). Forcing no-cache keeps the ETag dance honest: 304 while unchanged,
      // fresh 200 the moment the map differs.
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.includes('/frame-host/registry.ts')) {
          const orig = res.setHeader.bind(res)
          res.setHeader = ((name: string, value: unknown) =>
            orig(name, String(name).toLowerCase() === 'cache-control' ? 'no-cache' : value as any)) as any
        }
        next()
      })

      // Update discovery (dev only): one cached registry check per day (update.ts has
      // the privacy story). Two surfaces from the same result - a stdout line for the
      // terminal, and /__mv/api/update for the shell's pill. Must be registered BEFORE
      // apiMiddleware, whose unknown-endpoint 404 would eat the path.
      const update = checkUpdate(root).catch(() => null)
      update.then((latest) => {
        if (latest) console.log(`\n  update: ${PKG} ${latest} is out (installed ${installedVersion() ?? '?'}) → npm i -D ${PKG}@latest && npx ${NAME} init\n`)
      })
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x')
        if (url.pathname !== `${ROUTE}/api/update`) return next()
        update.then((latest) => {
          res.setHeader('content-type', 'application/json')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({ latest, current: installedVersion() }))
        })
      })

      // M7: the artifact compiler. GET /__mv/api/artifacts returns the current manifest and kicks off a
      // background compile of any un-built frames (playwright-core + system Chrome); each completion pings
      // the shell over the ws so it can swap a placeholder for the prebuilt file. Lazy: no Chrome until asked.
      // MUST be registered BEFORE apiMiddleware, whose unknown-endpoint 404 hard-ends the response (no next()).
      const store = new ArtifactStore(join(artifactsRoot(root), 'v1'), `${ROUTE}/artifacts/v1`)
      let compiler: Compiler | null = null
      let baseUrl = ''
      let compiling = false
      const jobsFor = (f: { id: string; kind: 'tsx' | 'html'; viewport?: string; theme?: string; file: string }): CompileJob[] => {
        if (f.kind !== 'tsx') return []                          // html frames are their own static file (later)
        const vp = config.viewports[f.viewport ?? ''] ?? config.viewports.mobile ?? { width: 390, height: 844 }
        let src = ''
        try { src = readFileSync(join(root, f.file), 'utf8') } catch { /* deleted */ }
        const depRevision = hash(src || f.id)
        // Precompile EVERY configured theme (not just the default): a global theme flip then swaps one
        // prebuilt file for another with zero recompile - instant, no blip. A meta.theme-pinned frame
        // usually renders one theme, but a user pin can still flip it, so build them all (cheap: cache-hit).
        const themes = config.themes.length ? config.themes : [f.theme ?? 'light']
        return themes.map((theme) => ({ frameId: f.id, theme, width: vp.width, height: vp.height, kind: f.kind, depRevision }))
      }
      let dirty = false   // an edit landed mid-compile: re-run once the current pass drains (don't drop it)
      async function compileBoard(): Promise<void> {
        if (!baseUrl) return
        if (compiling) { dirty = true; return }
        compiling = true
        try {
          compiler ??= new Compiler(baseUrl, store, { concurrency: 4, globalEnvRevision: bootId, serializerVersion: 'v4' })
          const jobs = manifest.frames.flatMap(jobsFor)
          await compiler.compileMany(jobs, (v, j) => {
            devServer?.ws.send('sh:artifact', { frameId: j.frameId, variant: variantKey(j.theme, String(j.width)), href: v.href, status: v.status })
          })
        } catch (e) { console.error('[marver] artifact compile failed:', (e as Error).message) }
        finally { compiling = false; if (dirty) { dirty = false; void compileBoard() } }
      }
      recompileArtifacts = () => { void compileBoard() }
      server.middlewares.use((req, res, next) => {
        const u = new URL(req.url ?? '/', 'http://x')
        if (u.pathname !== `${ROUTE}/api/artifacts`) return next()
        if (!baseUrl) baseUrl = `http://${req.headers.host ?? `localhost:${server.config.server.port ?? 5173}`}`
        void compileBoard()                                      // fire-and-forget background compile
        res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ frames: store.getManifest().frames as Record<string, FrameArtifacts> }))
      })

      // Pre-middlewares: our routes + api run before Vite's html fallback.
      server.middlewares.use(apiMiddleware(root))
      server.middlewares.use(routesMiddleware(server, clientDir, root))

      devServer = server   // A7: handleHotUpdate needs ws.send to emit sh:frame-invalidated
      // Boot manifest + watcher (scenes/components only; boards, .local, manifest.json excluded by scope).
      const regen = debounce(() => {
        manifest = scanFrames(root)   // keep the cached manifest fresh for affectedFrameIds
        // Broadcast only real changes - plain content edits ride HMR alone (spec §5.6).
        if (writeManifest(root, manifest)) server.ws.send('sh:manifest', manifest as any)
      }, 150)

      const watched = [join(root, 'design', 'scenes'), join(root, 'design', 'components')]
      const inScope = (file: string) => watched.some((w) => file.startsWith(w))

      // Tailwind's scan set is computed when the theme CSS compiles; a NEW frame file's
      // classes silently miss until that CSS rebuilds (friction log #22 - the canvas
      // renders a confident wrong design). Two phases per add/unlink:
      //   1. invalidate the theme module chain SYNCHRONOUSLY - an iframe mounting off
      //      the manifest event can then never fetch the pre-change compiled CSS;
      //   2. reloadModule (debounced) pushes the recompiled CSS to already-open frames.
      const themeModules = (): any[] => {
        const f = themeFile()
        if (!f) return []
        const out: any[] = []
        const seen = new Set<any>()
        const walk = (mod: any) => {
          if (!mod || seen.has(mod)) return
          seen.add(mod)
          out.push(mod)
          for (const im of mod.clientImportedModules ?? mod.importedModules ?? [])
            if (String(im.id ?? '').split('?')[0].endsWith('.css')) walk(im)
        }
        for (const mod of server.moduleGraph.getModulesByFile(f) ?? []) walk(mod)
        return out
      }
      const pushTheme = debounce(() => {
        for (const mod of themeModules()) server.reloadModule(mod).catch(() => { /* gone mid-reload */ })
      }, 150)
      const rescanTheme = () => {
        for (const mod of themeModules()) server.moduleGraph.invalidateModule(mod)
        pushTheme()
      }

      server.watcher.on('add', (f) => { if (inScope(f)) { regen(); rescanTheme() } })
      server.watcher.on('unlink', (f) => { if (inScope(f)) { regen(); rescanTheme() } })
      // change: only meta edits matter; scanFrames re-extracts and writeManifest de-dupes writes.
      server.watcher.on('change', (f) => inScope(f) && /\.(tsx|jsx)$/.test(f) && regen())

      writeManifest(root, scanFrames(root))

      // Multi-viewer board sync: Vite's watcher deliberately ignores boards/ (write-loop
      // guard, spec §5.6), so a plain fs.watch broadcasts saves instead. Every viewer
      // whose board is CLEAN re-boots on a foreign sha; the dirty one keeps its edits and
      // converges through the 409 path on its next save. Self-echo is filtered client-side
      // (own save already advanced boardHash to the broadcast sha).
      const boardsDir = join(root, 'design', 'boards')
      try {
        mkdirSync(boardsDir, { recursive: true })   // watch needs it to exist; the API creates it lazily
        const timers = new Map<string, ReturnType<typeof setTimeout>>()
        const watcher = watch(boardsDir, (_event, file) => {
          if (!file || !file.endsWith('.json')) return
          clearTimeout(timers.get(file))
          timers.set(file, setTimeout(() => {
            timers.delete(file)
            try {
              const content = readFileSync(join(boardsDir, file), 'utf8')
              JSON.parse(content)                   // a mid-write partial must not broadcast - viewers would reload onto garbage
              server.ws.send('sh:board', { name: file.replace(/\.json$/, ''), sha256: hash(content) })
            } catch { /* deleted, partial, or invalid; the next settled write broadcasts */ }
          }, 120))
        })
        server.httpServer?.once('close', () => watcher.close())
      } catch { /* watch unsupported here - sync degrades to the 409 path */ }
    },
  }
}

function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout>
  return ((...a: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }) as T
}

/** Extra vite plugin when the host runs Tailwind v4. The host's own @tailwindcss/vite
 *  wins (version-matched to their tailwindcss); the fallback is marver's bundled copy -
 *  Next.js hosts use @tailwindcss/postcss and never have the vite plugin (the blessed
 *  stack would otherwise render every frame without its utility classes). */
export async function tailwind4Plugin(root: string): Promise<Plugin[] | null> {
  const factories: (() => Promise<any>)[] = [
    () => import(join(root, 'node_modules', '@tailwindcss', 'vite', 'dist', 'index.mjs')),
    () => import('@tailwindcss/vite'),
  ]
  for (const load of factories) {
    try {
      const mod = await load()
      const factory = mod.default ?? mod
      const result = factory()
      return Array.isArray(result) ? result : [result]
    } catch { /* try the next source */ }
  }
  return null
}

/** Tailwind v3: inline PostCSS config extending the host's tailwind config with design/ globs. Host files untouched. */
export async function tailwind3Css(root: string): Promise<Record<string, unknown> | null> {
  for (const name of ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs', 'tailwind.config.cjs']) {
    const file = join(root, name)
    if (!existsSync(file)) continue
    try {
      const { pathToFileURL } = await import('node:url')
      const twConfig = (await import(pathToFileURL(file).href)).default
      const tailwindcss = (await import(join(root, 'node_modules', 'tailwindcss', 'lib', 'index.js').replace(/\\/g, '/'))).default
      const content = Array.isArray(twConfig.content) ? twConfig.content : twConfig.content?.files ?? []
      return {
        postcss: {
          plugins: [tailwindcss({ ...twConfig, content: [...content, './design/**/*.{ts,tsx,html}'] })],
        },
      }
    } catch (err) {
      console.warn(`[marver] could not extend Tailwind v3 config (${(err as Error).message}). Add './design/**/*.{ts,tsx,html}' to its content globs manually.`)
      return null
    }
  }
  return null
}
