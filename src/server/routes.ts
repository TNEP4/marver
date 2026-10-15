import type { Connect, ViteDevServer } from 'vite'
import { readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { ROUTE } from '../cli/name.ts'

/**
 * Serves the package's own pages. transformIndexHtml does not map URLs - we do (spec §3).
 * Entry html files carry an {{ENTRY}} placeholder replaced with an /@fs/ absolute path,
 * because a relative ./main.tsx would resolve against the URL, not the package dir.
 */
/** The revision a document is served with (spec 26): a frame's `doc` revision, and for the stage
 *  every frame's - stamps may lag the code a document runs, never lead it. */
export interface Stamps { doc(id: string): string; docs(): { epoch: string; doc: Record<string, number> } | null }

export function routesMiddleware(server: ViteDevServer, clientDir: string, stamps?: Stamps): Connect.NextHandleFunction {
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
    else if (path === `${ROUTE}/stage/` || path === `${ROUTE}/stage/index.html`) dir = 'stage'
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
    else if (path.startsWith(`${ROUTE}/bakes/`)) {
      // compiled textures: design/.local/bakes/<gen>/<key>/<n>.png - the generation is in the path,
      // so a texture URL is immutable and the browser may cache it for ever
      const m = /^\/(\d+)\/([a-f0-9]{16})\/(\d+)\.png$/.exec(path.slice(`${ROUTE}/bakes`.length))
      if (!m) { res.statusCode = 404; return res.end() }
      try {
        // real paths: a symlink planted inside the cache must not reach out of it
        const base = realpathSync(join(server.config.root, 'design', '.local', 'bakes'))
        const file = realpathSync(join(base, m[1], m[2], `${m[3]}.png`))
        if (!file.startsWith(base + sep)) throw new Error('outside the cache')
        const png = readFileSync(file)
        res.setHeader('content-type', 'image/png'); res.setHeader('cache-control', 'public, max-age=31536000, immutable')
        return res.end(png)
      } catch { res.statusCode = 404; return res.end() }
    }
    else if (path === `${ROUTE}/bridge.js`) {
      res.setHeader('content-type', 'text/javascript')
      return res.end(readFileSync(join(clientDir, 'frame-host', 'bridge.js'), 'utf8'))
    }
    if (!dir) return next()

    try {
      // stamped before the transform: any module the page fetches after this is at least as new
      const stamp = dir === 'frame-host' ? stamps?.doc(url.searchParams.get('id') ?? '') : dir === 'stage' ? JSON.stringify(stamps?.docs() ?? null) : undefined
      let html = await server.transformIndexHtml(req.url ?? '/', page(dir))
      if (stamp) html = html.replace('<head>', `<head><meta name="mv-doc" content="${stamp.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}">`)
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
