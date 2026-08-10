import type { Plugin, ViteDevServer } from 'vite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
// ROUTE unused here since bridge rides /@fs/
import type { ShConfig } from './config.ts'
import { scanFrames, writeManifest } from './manifest.ts'
import { apiMiddleware } from './api.ts'
import { routesMiddleware } from './routes.ts'

const VIRTUAL_THEME = 'virtual:sh-theme'
const VIRTUAL_CONFIG = 'virtual:sh-config'

export interface PluginCtx {
  root: string
  clientDir: string
  config: ShConfig
  detectedThemeCss: string | null
}

export function showhomePlugin(ctx: PluginCtx): Plugin {
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
    name: 'showhome',

    resolveId(id) {
      if (id === VIRTUAL_THEME) {
        const f = themeFile()
        return f ?? '\0' + VIRTUAL_THEME + '.css'
      }
      if (id === VIRTUAL_CONFIG) return '\0' + VIRTUAL_CONFIG
    },

    load(id) {
      if (id === '\0' + VIRTUAL_THEME + '.css') {
        console.warn('[showhome] no theme detected - frames render unstyled. Set `theme` in design/config.ts.')
        return '/* showhome: no theme configured */'
      }
      if (id === '\0' + VIRTUAL_CONFIG) {
        return `export default ${JSON.stringify({ viewports: config.viewports, themes: config.themes, noTheme: themeFile() == null })}`
      }
    },

    /** HTML frames: inject theme + bridge into any design/**.html Vite serves.
     *  Inline scripts go through vite's html-proxy import-analysis: bare specifiers resolve
     *  through plugins (so `virtual:sh-theme` works); `/@id/` URLs are rejected there. */
    transformIndexHtml: {
      order: 'pre',
      handler(html, hctx) {
        const path = (hctx.originalUrl ?? hctx.path ?? '').split('?')[0]
        if (!path.startsWith('/design/')) return
        const bridge = '/@fs/' + join(clientDir, 'frame-host', 'bridge.js').split('\\').join('/')
        return {
          html,
          tags: [
            { tag: 'script', attrs: { type: 'module' }, children: `import '${VIRTUAL_THEME}'`, injectTo: 'head' },
            { tag: 'script', attrs: { type: 'module', src: bridge }, injectTo: 'body' },
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
        writeManifest(root, manifest)
        server.ws.send('sh:manifest', manifest as any)
      }, 150)

      const watched = [join(root, 'design', 'scenes'), join(root, 'design', 'components')]
      const inScope = (file: string) => watched.some((w) => file.startsWith(w))

      server.watcher.on('add', (f) => inScope(f) && regen())
      server.watcher.on('unlink', (f) => inScope(f) && regen())
      // change: only meta edits matter; scanFrames re-extracts and writeManifest de-dupes writes.
      server.watcher.on('change', (f) => inScope(f) && /\.(tsx|jsx)$/.test(f) && regen())

      writeManifest(root, scanFrames(root))
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
      console.warn(`[showhome] could not extend Tailwind v3 config (${(err as Error).message}). Add './design/**/*.{ts,tsx,html}' to its content globs manually.`)
      return null
    }
  }
  return null
}
