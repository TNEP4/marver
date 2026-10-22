import type { Connect } from 'vite'
import type { ServerResponse } from 'node:http'
import { ROUTE } from '../cli/name.ts'

/** A workspace key as marver writes it: 16 hex. A frame's own `ws` query in another shape is the
 *  frame's business, never ours. */
const WS_KEY = /^[0-9a-f]{16}$/
/** Marks the workspace refusal, so the page tells it from every other 409 without reading the body. */
export const ELSEWHERE_HEADER = 'x-mv-elsewhere'

/** What a frame gets when its URL names another workspace: no script, nothing of this project. */
export const ANOTHER_CANVAS_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Another canvas</title><style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;text-align:center;font:500 13px/1.45 -apple-system,system-ui,sans-serif;color:#71717a}</style></head><body><p>This frame belongs to another canvas.<br>Its canvas stopped, and another project answers on this address now.</p></body></html>`

/**
 * The first middleware of every dev server (spec 28 A1.11). A page left open after its canvas
 * stopped may reach whatever listens on that port later; everything it sends names its workspace,
 * and this answers before anything of this project is read, written or served:
 * - `Service-Worker: script` (what the browser sends when it fetches a worker's script): 403 - no
 *   service worker ever runs on a canvas, whatever later takes the port;
 * - `x-mv-ws` present and not ours: 409 `{ error: 'another workspace' }`;
 * - a `ws` query not ours (frame and stage URLs, a Jam picture's <img>): the same 409 under
 *   /__mv/api/, else the "another canvas" page - a retained frame reloading its own URL never boots
 *   this project's frame;
 * - `GET /__mv/api/hello`: `{ ok, ws }` - the stopped page asking "is my canvas back here?".
 * A request naming no workspace (the CLI, a test, an older page) is served as before.
 */
export function guardMiddleware(workspace: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (String(req.headers['service-worker'] ?? '').toLowerCase() === 'script') {
      res.statusCode = 403
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      return res.end('marver canvases run no service workers')
    }
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://x') } catch { return next() }   // not ours to judge: Vite answers it
    const api = url.pathname.startsWith(`${ROUTE}/api/`)
    const said = req.headers['x-mv-ws']
    if (said !== undefined && String(said) !== workspace) return elsewhere(res)
    const q = url.searchParams.get('ws')
    if (q !== null && WS_KEY.test(q) && q !== workspace) {
      if (api) return elsewhere(res)
      res.statusCode = 409
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader(ELSEWHERE_HEADER, '1')
      return res.end(ANOTHER_CANVAS_HTML)
    }
    if (url.pathname === `${ROUTE}/api/hello` && req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      return res.end(JSON.stringify({ ok: true, ws: workspace }))
    }
    next()
  }
}

function elsewhere(res: ServerResponse) {
  res.statusCode = 409
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.setHeader(ELSEWHERE_HEADER, '1')
  res.end(JSON.stringify({ error: 'another workspace' }))
}
