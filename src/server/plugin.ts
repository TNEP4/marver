import type { Plugin, ViteDevServer } from 'vite'
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import { hash } from './manifest.ts'
// ROUTE unused here since bridge rides /@fs/
import type { ShConfig } from './config.ts'
import { scanFrames, writeManifest } from './manifest.ts'
import { apiMiddleware } from './api.ts'
import { routesMiddleware } from './routes.ts'

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
        console.warn('[marver] no theme detected - frames render unstyled. Set `theme` in design/config.ts.')
        return '/* marver: no theme configured */'
      }
      if (id === '\0' + VIRTUAL_CONFIG) {
        return `export default ${JSON.stringify({ viewports: config.viewports, themes: config.themes, zoomSpeed: config.zoomSpeed, noTheme: themeFile() == null })}`
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
      const scoped = [join(root, 'design', 'scenes'), join(root, 'design', 'components')]
        .some((w) => hctx.file.startsWith(w))
      if (!scoped) return
      if (!existsSync(hctx.file)) return []                    // unlink: shell shows the deleted card
      if (hctx.modules.length === 0) return []                 // add: not in any graph yet; new iframes fetch fresh
    },

    configureServer(server: ViteDevServer) {
      // Pre-middlewares: our routes + api run before Vite's html fallback.
      server.middlewares.use(apiMiddleware(root))
      server.middlewares.use(routesMiddleware(server, clientDir))

      // Boot manifest + watcher (scenes/components only; boards, .local, manifest.json excluded by scope).
      const regen = debounce(() => {
        const manifest = scanFrames(root)
        // Broadcast only real changes - plain content edits ride HMR alone (spec §5.6).
        if (writeManifest(root, manifest)) server.ws.send('sh:manifest', manifest as any)
      }, 150)

      const watched = [join(root, 'design', 'scenes'), join(root, 'design', 'components')]
      const inScope = (file: string) => watched.some((w) => file.startsWith(w))

      server.watcher.on('add', (f) => inScope(f) && regen())
      server.watcher.on('unlink', (f) => inScope(f) && regen())
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

/** Extra vite plugin when the host runs Tailwind v4: use their own @tailwindcss/vite. */
export async function tailwind4Plugin(root: string): Promise<Plugin[] | null> {
  try {
    const mod = await import(join(root, 'node_modules', '@tailwindcss', 'vite', 'dist', 'index.mjs'))
    const factory = mod.default ?? mod
    const result = factory()
    return Array.isArray(result) ? result : [result]
  } catch {
    return null
  }
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
