import { createLogger, createServer, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAME, PKG } from '../cli/name.ts'
import { loadConfig } from './config.ts'
import { detectHost } from './detect.ts'
import { marverPlugin, tailwind3Css, tailwind4Plugin } from './plugin.ts'

/** packageDir = the installed marver package root (dist/cli.js lives one level down). */
function packageDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

export async function dev(root: string, portFlag?: number) {
  const config = await loadConfig(root)
  const host = detectHost(root)
  const pkgDir = packageDir()
  const clientDir = join(pkgDir, 'src', 'client')

  const plugins: any[] = [react()]
  if (host.tailwind === 4) {
    const tw = await tailwind4Plugin(root)
    if (tw) plugins.push(...tw)
    else console.warn(`[marver] tailwindcss v4 detected but @tailwindcss/vite could not be loaded - utility classes WILL be missing from frames. Fix: npm i -D @tailwindcss/vite (used only by the canvas, never by your app's build).`)
  }
  let css: Record<string, unknown> | undefined
  if (host.tailwind === 3) css = (await tailwind3Css(root)) ?? undefined

  plugins.push(marverPlugin({ root, clientDir, config, detectedThemeCss: host.themeCss }))

  // ~35 lines of "Sourcemap for react-zoom-pan-pinch points to missing sources" per boot
  // (their published map is broken, not actionable here) were burying the warnings that
  // matter. Filter exactly that noise; everything else passes through.
  const logger = createLogger('info')
  const noise = (msg: string) => /Sourcemap for .*node_modules.*points to/.test(msg)
  const warnBase = logger.warn.bind(logger)
  const warnOnceBase = logger.warnOnce.bind(logger)
  logger.warn = (msg, opts) => { if (!noise(msg)) warnBase(msg, opts) }
  logger.warnOnce = (msg, opts) => { if (!noise(msg)) warnOnceBase(msg, opts) }

  const server = await createServer({
    configFile: false,
    root,
    css: css as any,
    customLogger: logger,
    plugins,
    server: {
      port: portFlag ?? config.port,
      strictPort: false,
      // keep Vite's workspace-root allowance: monorepo hosts import sibling packages
      fs: { allow: [...new Set([root, pkgDir, searchForWorkspaceRoot(root)])] },
      // Spec §5.6: our own writes must never bounce off the watcher - an out-of-graph
      // .json change makes Vite full-reload every client, shell included (measured).
      // Host build output is ignored too: `next build` (etc.) writing .next/ was firing
      // a storm of full page reloads at the open canvas (friction log #21).
      watch: {
        ignored: [
          '**/design/manifest.json', '**/design/boards/**', '**/design/.local/**', '**/design/.dist/**', '**/design/comments/**',
          '**/.next/**', '**/.turbo/**', '**/.vercel/**', '**/.output/**', '**/dist/**', '**/build/**', '**/out/**', '**/coverage/**',
        ],
      },
      // A8: pre-transform the frame boot chain at server start so the FIRST frame load never
      // races Vite's on-demand transform/optimize (the cold-boot "frame never reported ready"
      // race - every content frame statically pulls the content primitives). optimizeDeps
      // already pre-bundles marked/mermaid; this warms the source modules around them.
      warmup: {
        clientFiles: [
          join(clientDir, 'frame-host', 'main.tsx'),
          join(clientDir, 'frame-host', 'bridge.js'),
          join(clientDir, 'content', 'index.tsx'),
          join(clientDir, 'content', 'diagram.tsx'),
          join(clientDir, 'content', 'md.ts'),
          'design/**/*.{tsx,jsx}',
        ],
      },
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      // Vite 8 built-in; harmless no-op warning on older majors.
      tsconfigPaths: true,
    } as any,
    optimizeDeps: {
      exclude: [PKG],
      // marked/mermaid: content-frame deps (SPEC-026). Pre-bundling avoids the 504
      // Outdated-Optimize-Dep white-frame on the FIRST Diagram/Md mount (friction
      // 0.2.2 #1). Nested "PKG > dep" form: Vite resolves them through marver's own
      // node_modules, so non-hoisted pnpm hosts resolve correctly too.
      include: [
        'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime',
        `${PKG} > marked`, `${PKG} > mermaid`,
      ],
      entries: [join(clientDir, 'frame-host', 'index.html'), 'design/**/*.{tsx,jsx}'],
    },
    logLevel: 'info',
  })

  await server.listen()
  const addr = server.httpServer?.address()
  const port = typeof addr === 'object' && addr ? addr.port : config.port
  console.log(`\n  ${NAME} canvas → http://localhost:${port}/\n`)

  // comment sync loop (SPEC-M3 §2): ~30s exchanges with the publish target. The
  // ticker ALWAYS runs and re-reads credentials each pass, so `comments connect`
  // issued while dev is already open starts syncing on the next tick - no restart.
  // Single-flight; quiet on failure - the exchange is idempotent, the next one heals.
  const { loadCollab, syncOnce } = await import('./sync.ts')
  if (loadCollab(root)) console.log(`  comments: syncing with the published canvas (design/.local/collab.json)\n`)
  let syncing = false
  const tick = async () => {
    if (syncing) return
    syncing = true
    try {
      const collab = loadCollab(root)
      if (collab) await syncOnce(root, collab).catch(() => { /* next tick heals */ })
    } finally { syncing = false }
  }
  void tick()
  setInterval(tick, 30_000).unref()
  return server
}
