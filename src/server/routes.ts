import type { Connect, ViteDevServer } from 'vite'
import { readFileSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { ROUTE } from '../cli/name.ts'

/** dev cache root for M7 persisted lean artifacts, under the project's watcher-ignored .local */
export const ARTIFACTS_URL = `${ROUTE}/artifacts`
export const artifactsRoot = (projectRoot: string): string => join(projectRoot, 'design', '.local', 'artifacts')

/**
 * Serves the package's own pages. transformIndexHtml does not map URLs - we do (spec §3).
 * Entry html files carry an {{ENTRY}} placeholder replaced with an /@fs/ absolute path,
 * because a relative ./main.tsx would resolve against the URL, not the package dir.
 */
export function routesMiddleware(server: ViteDevServer, clientDir: string, projectRoot = ''): Connect.NextHandleFunction {
  const artRoot = projectRoot ? artifactsRoot(projectRoot) : ''
  const ART_TYPES: Record<string, string> = { html: 'text/html', json: 'application/json', css: 'text/css' }
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

    // M7: serve persisted lean artifacts (immutable content-addressed objects + the manifest)
    if (artRoot && path.startsWith(`${ARTIFACTS_URL}/`)) {
      const rel = decodeURIComponent(path.slice(`${ARTIFACTS_URL}/`.length))
      const abs = normalize(join(artRoot, rel))
      if (!abs.startsWith(artRoot + sep)) { res.statusCode = 403; return res.end('forbidden') }   // traversal guard
      const type = ART_TYPES[rel.split('.').pop() ?? '']
      if (!type) return next()
      try {
        const body = readFileSync(abs)
        res.setHeader('content-type', type)
        // objects are content-addressed -> immutable forever; the manifest must never cache
        res.setHeader('cache-control', rel.split('/').includes('objects') ? 'public, max-age=31536000, immutable' : 'no-store')
        return res.end(body)
      } catch { res.statusCode = 404; return res.end('artifact not found') }
    }

    let dir: string | null = null
    if (path === '/' || path === '/index.html') dir = 'shell'
    else if (path === `${ROUTE}/frame/` || path === `${ROUTE}/frame/index.html`) dir = 'frame-host'
    else if (path === `${ROUTE}/stage/` || path === `${ROUTE}/stage/index.html`) dir = 'stage'
    else if (path === `${ROUTE}/compile/` || path === `${ROUTE}/compile/index.html`) dir = 'compile'
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
      // never cache the host pages: a stale frame-host document pins an outdated module
      // graph inside an iframe, which no reload of the PARENT can flush (friction log #20)
      res.setHeader('cache-control', 'no-store')
      res.end(html)
    } catch (err) {
      res.statusCode = 500
      res.end(`marver route error: ${(err as Error).message}`)
    }
  }
}
