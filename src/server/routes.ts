import type { Connect, ViteDevServer } from 'vite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROUTE } from '../cli/name.ts'

/**
 * Serves the package's own pages. transformIndexHtml does not map URLs - we do (spec §3).
 * Entry html files carry an {{ENTRY}} placeholder replaced with an /@fs/ absolute path,
 * because a relative ./main.tsx would resolve against the URL, not the package dir.
 */
export function routesMiddleware(server: ViteDevServer, clientDir: string): Connect.NextHandleFunction {
  const page = (dir: string) => {
    const html = readFileSync(join(clientDir, dir, 'index.html'), 'utf8')
    const entry = '/@fs/' + join(clientDir, dir, 'main.tsx').split('\\').join('/')
    return html.replaceAll('{{ENTRY}}', entry).replaceAll('{{ROUTE}}', ROUTE)
  }

  const ICON_TYPES: Record<string, string> = {
    png: 'image/png', ico: 'image/x-icon', webmanifest: 'application/manifest+json',
  }

  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname

    let dir: string | null = null
    if (path === '/' || path === '/index.html') dir = 'shell'
    else if (path === `${ROUTE}/frame/` || path === `${ROUTE}/frame/index.html`) dir = 'frame-host'
    else if (path.startsWith(`${ROUTE}/favicon/`)) {
      // static icon pack from the shell dir; basename-only lookup, no traversal
      const name = path.slice(`${ROUTE}/favicon/`.length)
      const type = ICON_TYPES[name.split('.').pop() ?? '']
      if (!/^[\w@-]+(\.[\w]+)+$/.test(name) || !type) return next()
      try {
        res.setHeader('content-type', type)
        res.setHeader('cache-control', 'public, max-age=3600')
        return res.end(readFileSync(join(clientDir, 'shell', 'favicon', name)))
      } catch { return next() }
    }
    else if (path === `${ROUTE}/bridge.js`) {
      res.setHeader('content-type', 'text/javascript')
      return res.end(readFileSync(join(clientDir, 'frame-host', 'bridge.js'), 'utf8'))
    }
    if (!dir) return next()

    try {
      const html = await server.transformIndexHtml(req.url ?? '/', page(dir))
      res.setHeader('content-type', 'text/html')
      res.end(html)
    } catch (err) {
      res.statusCode = 500
      res.end(`marver route error: ${(err as Error).message}`)
    }
  }
}
