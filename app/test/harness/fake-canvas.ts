/**
 * The fake canvas (spec 28 A2.14 #27): a protocol-level Marver canvas, as far as the app can tell. It writes
 * its own slot file (`starting`, then `ready` with its bound origin) into `<home>/running/`, and serves a
 * shell-like page at `/` and `/index.html` whose response carries the document proof - signed with A1's own
 * `proofHeaders` (src/server/proof.ts), so the app and the canvas compute one formula - or a wrong one, or none.
 *
 * It answers like A1's guard (src/server/guard.ts): `Service-Worker: script` 403, an `x-mv-ws` naming another
 * workspace 409 with `x-mv-elsewhere`, `GET /__mv/api/hello`. Every request is logged (method, path, headers),
 * for "the server never saw ..." assertions. The page reports its first animation-frame callback
 * (`POST /__mv/test/raf`, the launch budget's proxy, A2.14 #28) and can set a persistent cookie (the smoke's
 * cookie-encryption check). Cases that need more - hang, swallow keys, refuse to unload, raise a dialog,
 * misbehave on `/__mv/logo` - add a `script` or an `onRequest`.
 *
 * In-process: `startFakeCanvas(opts)`. As a child (for `kill -9`), with Node's type stripping:
 *   node app/test/harness/fake-canvas.ts '<json options>'
 * prints one line `{"ready":{...}}` on stdout, logs requests as JSON lines to `opts.log`, and removes its slot
 * file on SIGTERM or SIGINT - never on SIGKILL, which leaves the stale file a case may want.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { proofHeaders, type DocProof } from '../../../src/server/proof.ts'
import type { SlotFile } from '../../../src/server/slots.ts'

export interface FakeOptions {
  /** MARVER_HOME of the run: the slot file goes in `<home>/running/` */
  home: string
  /** MARVER_SLOT_BASE of the run: slot n listens on `slotBase + n` */
  slotBase: number
  /** 1-20 (default 1); or `port` for an explicit port outside the range (`port-<p>.json`) */
  slot?: number
  port?: number
  /** what `localhost` resolves to on the Mac (`::1`, Vite's default) or an IPv4 bind (default `::1`) */
  bind?: '::1' | '127.0.0.1'
  /** the document proof on `/`: valid, signed with another key, or absent (default valid) */
  proof?: 'valid' | 'invalid' | 'none'
  /** stay `starting` this long before `ready` (default 0) */
  startingMs?: number
  root?: string
  name?: string
  version?: string
  /** what the shell offers the app (0.27.1: ['bridge']) */
  features?: string[]
  /** the workspace, 16 hex (default random) */
  ws?: string
  /** the page sets a persistent cookie `mvfake=1` */
  cookie?: boolean
  /** extra inline script for the page */
  script?: string
  /** a JSON-lines request log (the child's way to tell its parent) */
  log?: string
  /** take a request first; return true when it was answered */
  onRequest?: (req: IncomingMessage, res: ServerResponse) => boolean

  // ---- A3 (spec 28 A3.8 #34, #47-#50): FROZEN names, served once the native stream builds them ----
  /**
   * ground mode (the capture matrix, A3.8 #34): the top 44 px painted the shell's ground with two tags - a document
   * tag (a saturated colour unique to the load, chosen through its URL) and a size tag at `innerWidth - 260` - and
   * the content the document tag at half luminance; the page also speaks the 0.27.2 contract (inset, present)
   */
  ground?: boolean
  /** the page holds this much memory (MB) once loaded: the unloading and budget cases */
  ballastMB?: number
  /** the page draws this many GPU canvases (WebGL), held: GPU-side ballast */
  gpuBallast?: number
  /** the page burns CPU while hidden: the hidden-tab CPU case's canvas renderer (reported, never gated) */
  cpuBallast?: boolean
  /** the body painted this colour (hex), unlike its view's ground: the painted-launch budget's sentinel (A3.8 #50) */
  sentinel?: string
}

export interface LoggedRequest { t: number; method: string; path: string; headers: Record<string, string | string[] | undefined> }

export interface FakeCanvas {
  port: number
  origin: string
  url: string
  slotFile: string
  instance: string
  key: Buffer
  ws: string
  record(): SlotFile
  requests: LoggedRequest[]
  /** resolves once the slot file says `ready` */
  ready: Promise<void>
  close(): Promise<void>
}

const ROUTE = '/__mv'

function writeWhole(file: string, body: string) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, file)
}

export function pageHtml(o: { name: string; cookie?: boolean; script?: string }): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.name)}</title></head>
<body style="margin:0;background:#e7e9ef;font:13px -apple-system,sans-serif"><div id="app" style="padding:24px">${esc(o.name)}</div>
<script>
(function () {
  var say = function (what) { try { fetch('${ROUTE}/test/' + what, { method: 'POST', keepalive: true }) } catch (e) {} };
  requestAnimationFrame(function () { say('raf') });
  ${o.cookie ? "document.cookie = 'mvfake=1; max-age=3600; path=/; samesite=strict';" : ''}
  ${o.script ?? ''}
})();
</script></body></html>`
}

export async function startFakeCanvas(opts: FakeOptions): Promise<FakeCanvas> {
  const slot = opts.port ? null : (opts.slot ?? 1)
  const port = opts.port ?? opts.slotBase + (slot as number)
  if (port >= 4805 && port <= 4824) throw new Error(`fake canvas: port ${port} is a real slot (4805-4824)`)
  const bind = opts.bind ?? '::1'
  const origin = bind === '::1' ? `http://[::1]:${port}` : `http://127.0.0.1:${port}`
  const url = `http://localhost:${port}/`
  const key = randomBytes(32)
  const instance = randomUUID()
  const ws = opts.ws ?? randomBytes(8).toString('hex')
  const name = opts.name ?? 'Fake canvas'
  const running = join(opts.home, 'running')
  mkdirSync(running, { recursive: true, mode: 0o700 })
  chmodSync(running, 0o700)
  const slotFile = join(running, slot ? `slot-${slot}.json` : `port-${port}.json`)
  const proof: DocProof = { instance, key, port }
  const wrong: DocProof = { instance, key: randomBytes(32), port }
  const requests: LoggedRequest[] = []

  let rec: SlotFile = {
    v: 1, state: 'starting', pid: process.pid, instance, slot, port, origin: null, url,
    root: opts.root ?? resolve(opts.home, '..', 'fake-repo'), name, version: opts.version ?? '0.27.1-fake',
    features: opts.features ?? ['bridge'], ws, startedAt: Date.now(), key: key.toString('base64url'),
  }
  writeWhole(slotFile, JSON.stringify(rec, null, 2) + '\n')

  const html = pageHtml({ name, cookie: opts.cookie, script: opts.script })
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const entry = { t: Date.now(), method: req.method ?? 'GET', path, headers: { ...req.headers } }
    requests.push(entry)
    if (opts.log) try { appendFileSync(opts.log, JSON.stringify(entry) + '\n') } catch { /* the log went away */ }
    if (opts.onRequest?.(req, res)) return
    if (String(req.headers['service-worker'] ?? '').toLowerCase() === 'script') { res.statusCode = 403; return res.end() }
    const said = req.headers['x-mv-ws']
    if (said !== undefined && String(said) !== ws) {
      res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-mv-elsewhere': '1' })
      return res.end(JSON.stringify({ error: 'another workspace' }))
    }
    if (path === `${ROUTE}/api/hello` && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ ok: true, ws }))
    }
    if (path.startsWith(`${ROUTE}/test/`)) { res.writeHead(204); return res.end() }
    if ((path === '/' || path === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
      const headers: Record<string, string> = { 'content-type': 'text/html', 'cache-control': 'no-store' }
      const p = opts.proof ?? 'valid'
      const signed = p === 'none' ? null : proofHeaders(p === 'valid' ? proof : wrong, req.headers['x-mv-nonce'])
      if (signed) Object.assign(headers, signed)
      res.writeHead(200, headers)
      return res.end(req.method === 'HEAD' ? undefined : html)
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, bind, () => ok()) })

  const ready = (async () => {
    if (opts.startingMs) await new Promise((r) => setTimeout(r, opts.startingMs))
    rec = { ...rec, state: 'ready', origin }
    writeWhole(slotFile, JSON.stringify(rec, null, 2) + '\n')
  })()

  let closed = false
  return {
    port, origin, url, slotFile, instance, key, ws, requests, ready,
    record: () => rec,
    async close() {
      if (closed) return
      closed = true
      try {
        const now = JSON.parse(readFileSync(slotFile, 'utf8')) as { instance?: string }
        if (now.instance === instance) rmSync(slotFile, { force: true })
      } catch { /* gone already */ }
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

// As a child process: node fake-canvas.ts '<json options>'
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fake = await startFakeCanvas(JSON.parse(process.argv[2] ?? '{}') as FakeOptions)
  await fake.ready
  process.stdout.write(JSON.stringify({ ready: { pid: process.pid, port: fake.port, origin: fake.origin, slotFile: fake.slotFile, instance: fake.instance, ws: fake.ws } }) + '\n')
  const stop = () => { void fake.close().then(() => process.exit(0)) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
