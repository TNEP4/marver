/**
 * Shared canvases for the app's cases (spec 28 A4.6 #50, #51): several `*.canvas.test` hosts over https on one port of
 * the run's own (the OS picks it: never 4805-4824 or 5298), told apart by their `Host`, with the checked-in test
 * certificate (`remote-cert/`, test-only: `*.canvas.test`, never trusted by anything but a test build that names its
 * fingerprint). Its key is EC P-256 named by its OID: Chromium refuses a key that spells out its curve's parameters
 * (-107 at the handshake), which is what macOS's LibreSSL `openssl` writes unless told, so it was made with `openssl
 * req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve`, SAN `*.canvas.test,
 * canvas.test`, server auth, 20 years (`bad-cert.pem` the same, another key). The app reaches them through its test
 * switches (`env`): `MARVER_APP_TEST_HOSTS` maps `*.canvas.test` to 127.0.0.1, `MARVER_APP_TEST_REMOTE_CERT` accepts
 * exactly this certificate, `MARVER_APP_TEST_FRONT_DOOR` names `door.canvas.test` as the front door. Each run has its
 * own `userData` (env.ts), so HSTS and certificate caches never leak between runs.
 *
 * What it serves, per host (`page(host, o)` sets a host's shell page; `route` adds anything else):
 * - `/` and `/index.html`: a shell-like page - a title, `<link rel="icon">` (`favicon`, default `/favicon.png`; or
 *   `icons`, several in their order), the page's `script` - that beacons `/__mv/test/script` once its script ran;
 * - `/favicon.png`: a PNG; `/favicon-redirect.png`: a 302 to the plain http server on 127.0.0.1 (`plain`, whose
 *   requests are kept, for "that port sees no request"); `/favicon-slow.png`: the PNG after `slowMs`;
 *   `/favicon-flaky.png`: a 500 at its first request on each host, the PNG after;
 * - a published canvas's icons: `/__mv/logo.svg` (the repo's logo, `LOGO_SVG`) and Marver's `/__mv/favicon/*` (the PNG);
 * - the sign-in chain as Marver ID's: `/__mv/id/start?next=<path>` 302s to `id.canvas.test`'s `/login`, which 302s
 *   back to `/__mv/id/finish#code=…&next=<path>`, whose page sets the session cookie (`Path=/`: without it the cookie
 *   would be `/__mv/id`'s alone, and the canvas, never seeing it, would sign in again for good) and replaces itself
 *   with `next`
 *   - unless `finishStalls`, when it stays there (a sign-in cut short); with `loginStalls` the login is a page of its
 *   own, wearing `id.canvas.test`'s favicon;
 * - `/download`: an attachment; `/to-http`: a 302 to http; `/no-content`: a 204; `/about`: a page that is not the shell;
 * - `door.canvas.test`: a page whose `window.open(url)` the case drives (`openFromDoor`).
 * `bad` is a second https server whose certificate the app does not accept. `pause()` stops answering on the port,
 * `resume()` answers again on the same one. Every request is kept (`requests`, `hits`).
 */
import { createServer as createHttps, type Server as HttpsServer } from 'node:https'
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo, Socket } from 'node:net'

export const CERT_DIR = join(import.meta.dirname, 'remote-cert')
const CERT = readFileSync(join(CERT_DIR, 'cert.pem'))
const KEY = readFileSync(join(CERT_DIR, 'key.pem'))
const BAD_CERT = readFileSync(join(CERT_DIR, 'bad-cert.pem'))
const BAD_KEY = readFileSync(join(CERT_DIR, 'bad-key.pem'))

/** The test certificate as Electron's `Certificate.fingerprint` names it: `sha256/` and the base64 of its DER's SHA-256. */
export const fingerprintOf = (pem: Buffer | string): string => `sha256/${createHash('sha256').update(new X509Certificate(pem).raw).digest('base64')}`
export const CERT_PEM = CERT
export const TEST_FINGERPRINT = fingerprintOf(CERT)

/** A 1 px PNG (the favicon's bytes). */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
/** The repo's logo a published canvas serves at `/__mv/logo.svg`. */
export const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#e5484d"/></svg>'
/** A published shell's icons in the order `marver build` writes them: the repo's logo first, then Marver's set. */
export const PUBLISHED_ICONS = ['/__mv/logo.svg', '/__mv/favicon/favicon.ico', '/__mv/favicon/favicon-32x32.png', '/__mv/favicon/favicon-16x16.png']

export interface Req { host: string; method: string; path: string; headers: IncomingMessage['headers'] }
export interface PageOpts {
  title?: string
  /** the `<link rel="icon">` href; null for none (default `/favicon.png`) */
  favicon?: string | null
  /** several `<link rel="icon">`s, in this order (in place of `favicon`) */
  icons?: string[]
  /** inline script, run before it beacons `/__mv/test/script` */
  script?: string
}
type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void

export interface RemoteCanvas {
  port: number
  /** `https://<name>.canvas.test:<port>` */
  origin(name: string): string
  url(name: string, path?: string): string
  /** the app's test switches for this harness */
  env: Record<string, string>
  requests: Req[]
  hits(name: string, path: string): number
  page(name: string, o: PageOpts): void
  route(name: string, path: string, fn: Handler): void
  /** the sign-in chain stops at its finish page (a sign-in cut short) */
  finishStalls: boolean
  /** the identity host's login answers a page of its own (with its favicon) rather than moving on */
  loginStalls: boolean
  /** `/favicon-slow.png`'s delay */
  slowMs: number
  /** the plain http server a favicon redirects to, and every request it saw */
  plain: { port: number; requests: Req[] }
  /** a second https server whose certificate the app does not accept */
  bad: { port: number; origin(name: string): string }
  /** stop answering on the port (the listener closed, every socket ended); `resume` listens on it again */
  pause(): Promise<void>
  resume(): Promise<void>
  close(): Promise<void>
}

const NAME = /^([a-z0-9-]+)\.canvas\.test(?::\d+)?$/

function shellPage(name: string, o: PageOpts): string {
  const icon = o.icons ? o.icons.map((href) => `<link rel="icon" href="${href}">`).join('')
    : o.favicon === null ? '' : `<link rel="icon" href="${o.favicon ?? '/favicon.png'}">`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${o.title ?? `${name} shared`}</title>${icon}</head>
<body><h1>${name}</h1><textarea id="words"></textarea>
<script>
function say(what) { try { navigator.sendBeacon('/__mv/test/' + what) } catch (e) {} }
${o.script ?? ''}
say('script');
</script></body></html>`
}

export async function startRemoteCanvas(): Promise<RemoteCanvas> {
  const requests: Req[] = []
  const pages = new Map<string, PageOpts>()
  const routes = new Map<string, Handler>()
  const sockets = new Set<Socket>()
  const plainReqs: Req[] = []
  const flaked = new Set<string>()

  const plain: Server = createHttp((req, res) => {
    plainReqs.push({ host: req.headers.host ?? '', method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers })
    res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)
  })
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r))
  const plainPort = (plain.address() as AddressInfo).port

  let port = 0
  const h: RemoteCanvas = {
    port: 0,
    origin: (name) => `https://${name}.canvas.test:${port}`,
    url: (name, path = '/') => `https://${name}.canvas.test:${port}${path}`,
    env: {},
    requests,
    hits: (name, path) => requests.filter((r) => r.host === name && r.path === path).length,
    page: (name, o) => { pages.set(name, o) },
    route: (name, path, fn) => { routes.set(`${name} ${path}`, fn) },
    finishStalls: false,
    loginStalls: false,
    slowMs: 3000,
    plain: { port: plainPort, requests: plainReqs },
    bad: { port: 0, origin: (name) => `https://${name}.canvas.test:${h.bad.port}` },
    pause: async () => {
      const closed = new Promise<void>((r) => server.close(() => r()))
      for (const s of sockets) s.destroy()
      await closed
    },
    resume: async () => { await new Promise<void>((r) => server.listen(port, '127.0.0.1', r)) },
    close: async () => {
      const closed = [server, badServer, plain].map((x) => new Promise<void>((r) => { if (!x.listening) r(); else x.close(() => r()) }))
      for (const s of sockets) s.destroy()
      for (const x of [server, badServer, plain]) (x as Server).closeAllConnections?.()
      await Promise.all(closed)
    },
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const m = NAME.exec(req.headers.host ?? '')
    const name = m?.[1] ?? ''
    const url = new URL(req.url ?? '/', `https://${req.headers.host ?? 'x'}`)
    requests.push({ host: name, method: req.method ?? 'GET', path: url.pathname, headers: req.headers })
    const html = (body: string, extra: Record<string, string> = {}) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra }).end(body)
    const go = (to: string): void => { res.writeHead(302, { location: to, 'cache-control': 'no-store' }).end() }
    const own = routes.get(`${name} ${url.pathname}`)
    if (own) return own(req, res, url)
    if (url.pathname.startsWith('/__mv/test/')) return void res.writeHead(204).end()
    if (url.pathname.startsWith('/__mv/favicon/')) return void res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(PNG)
    switch (url.pathname) {
      case '/': case '/index.html': return void html(shellPage(name, pages.get(name) ?? {}))
      case '/favicon.png': return void res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(PNG)
      case '/favicon-redirect.png': return go(`http://127.0.0.1:${plainPort}/x.png`)
      case '/favicon-slow.png': { const t = setTimeout(() => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG), h.slowMs); res.on('close', () => clearTimeout(t)); return }
      case '/favicon-flaky.png':
        if (!flaked.has(name)) { flaked.add(name); return void res.writeHead(500, { 'content-type': 'text/plain' }).end('not yet') }
        return void res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(PNG)
      case '/__mv/logo.svg': return void res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' }).end(LOGO_SVG)
      case '/about': return void html('<!doctype html><title>about</title><p>about')
      case '/download': return void res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="board.zip"' }).end('zip')
      case '/to-http': return go(`http://${name}.canvas.test:${port}/`)
      case '/no-content': return void res.writeHead(204).end()
      // Marver ID's chain: the canvas's start, the identity host's login, the canvas's finish with its code in the hash
      case '/__mv/id/start': return go(`${h.origin('id')}/login?return=${encodeURIComponent(`${h.origin(name)}/__mv/id/finish`)}&next=${encodeURIComponent(url.searchParams.get('next') ?? '/')}`)
      case '/login': {
        if (name !== 'id') break
        const back = url.searchParams.get('return') ?? ''
        if (h.loginStalls) return void html(`<!doctype html><title>Sign in</title><link rel="icon" href="/favicon.png"><a id="go" href="${back}#code=abc&next=${encodeURIComponent(url.searchParams.get('next') ?? '/')}">Continue</a>`)
        return go(`${back}#code=abc&next=${encodeURIComponent(url.searchParams.get('next') ?? '/')}`)
      }
      case '/__mv/id/finish':
        return void html(`<!doctype html><title>Signing in</title><script>
var p = new URLSearchParams(location.hash.slice(1)); document.cookie = 'mvsession=' + p.get('code') + '; Path=/; Max-Age=31536000; Secure; SameSite=Lax';
${h.finishStalls ? '' : "location.replace(p.get('next') || '/')"}
</script>`)
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
  }

  const server: HttpsServer = createHttps({ cert: CERT, key: KEY }, handle)
  server.on('connection', (s: Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  h.port = port

  const badServer: HttpsServer = createHttps({ cert: BAD_CERT, key: BAD_KEY }, (req, res) => {
    requests.push({ host: `bad:${NAME.exec(req.headers.host ?? '')?.[1] ?? ''}`, method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>impostor</title>')
  })
  await new Promise<void>((r) => badServer.listen(0, '127.0.0.1', r))
  h.bad.port = (badServer.address() as AddressInfo).port

  h.env = {
    MARVER_APP_TEST_HOSTS: 'MAP *.canvas.test 127.0.0.1',
    MARVER_APP_TEST_REMOTE_CERT: TEST_FINGERPRINT,
    MARVER_APP_TEST_FRONT_DOOR: h.origin('door'),
  }
  return h
}
