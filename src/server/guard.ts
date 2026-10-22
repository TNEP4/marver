import type { Connect } from 'vite'
import type { ServerResponse } from 'node:http'
import { ROUTE } from '../cli/name.ts'

/** A workspace key as marver writes it: 16 hex. A frame's own `ws` query in another shape is the
 *  frame's business, never ours. */
const WS_KEY = /^[0-9a-f]{16}$/
/** Marks the workspace refusal, so the page tells it from every other 409 without reading the body. */
export const ELSEWHERE_HEADER = 'x-mv-elsewhere'

/** What a frame gets when its URL names another workspace: no script, nothing of this project. The
 *  `mv-elsewhere` meta is how the shell, back on its own canvas, finds the frames to reload, and draws its own
 *  quiet placeholder over them meanwhile (shell/api.ts) - so this page is read on its own: a frame's address
 *  opened in a tab. It wears the frame's own theme (its URL's `theme`; a name with "dark" in it is dark), never
 *  the system's: a light frame stays light on a Mac in dark mode. */
export function anotherCanvasPage(theme: string | null): string {
  const dark = /dark/i.test(theme ?? '')
  // text >= 4.5:1 on its ground in both: #52525b on #fff is 7.7:1, #a1a1aa on #0f1015 is 7.4:1
  const [bg, ink, dim, code] = dark ? ['#0f1015', '#ececf1', '#a1a1aa', '#1d1e26'] : ['#ffffff', '#18181b', '#52525b', '#f0f0f2']
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="mv-elsewhere" content="1"><meta name="color-scheme" content="${dark ? 'dark' : 'light'}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Another canvas</title><style>html,body{height:100%;margin:0;background:${bg}}body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font:400 13px/1.5 -apple-system,system-ui,sans-serif;color:${dim}}main{max-width:340px}h1{margin:0 0 6px;font-size:15px;font-weight:600;line-height:1.35;color:${ink}}p{margin:0}code{font:500 12px ui-monospace,SFMono-Regular,Menlo,monospace;color:${ink};background:${code};padding:1px 5px;border-radius:5px;white-space:nowrap}</style></head><body><main><h1>This frame's canvas stopped</h1><p>Another project runs on this address now. To bring this frame back, stop that project, run <code>npx marver dev</code> in this frame's own project, then reload.</p></main></body></html>`
}

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
      return res.end(anotherCanvasPage(url.searchParams.get('theme')))
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
