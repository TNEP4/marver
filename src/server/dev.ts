import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAME } from '../cli/name.ts'
import { loadConfig } from './config.ts'
import { detectHost } from './detect.ts'
import { showhomePlugin, tailwind3Css, tailwind4Plugin } from './plugin.ts'

/** packageDir = the installed showhome package root (dist/cli.js lives one level down). */
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
    else console.warn('[showhome] tailwindcss v4 detected but @tailwindcss/vite not found in the host - theme classes may be missing.')
  }
  let css: Record<string, unknown> | undefined
  if (host.tailwind === 3) css = (await tailwind3Css(root)) ?? undefined

  plugins.push(showhomePlugin({ root, clientDir, config, detectedThemeCss: host.themeCss }))

  const server = await createServer({
    configFile: false,
    root,
    css: css as any,
    plugins,
    server: {
      port: portFlag ?? config.port,
      strictPort: false,
      fs: { allow: [root, pkgDir] },
      // Spec §5.6: our own writes must never bounce off the watcher - an out-of-graph
      // .json change makes Vite full-reload every client, shell included (measured).
      watch: { ignored: ['**/design/manifest.json', '**/design/boards/**', '**/design/.local/**', '**/design/.dist/**'] },
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      // Vite 8 built-in; harmless no-op warning on older majors.
      tsconfigPaths: true,
    } as any,
    optimizeDeps: {
      exclude: [NAME],
      include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      entries: [join(clientDir, 'frame-host', 'index.html'), 'design/**/*.{tsx,jsx}'],
    },
    logLevel: 'info',
  })

  await server.listen()
  const addr = server.httpServer?.address()
  const port = typeof addr === 'object' && addr ? addr.port : config.port
  console.log(`\n  ${NAME} canvas → http://localhost:${port}/\n`)
  return server
}
