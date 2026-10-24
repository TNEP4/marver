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
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
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

  // ---- A3 (spec 28 A3.8 #34, #47-#50): FROZEN names, served by the native stream ----
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

/** Ground mode's document tags (A3.8 #34): saturated, unlike the ground, the dots, the glass, white and each other. */
export const DOC_TAGS = ['ff0080', '00c0ff', 'ffb000', '8000ff', '00e060', 'ff4000', '0040ff', 'c0ff00', 'ff00ff', '00ffc0'] as const
/** The size tag's colour, and where it sits: `innerWidth - SIZE_TAG_X` (so a frame of an older width shows it elsewhere). */
export const SIZE_TAG = '202020'
export const SIZE_TAG_X = 260
/** The ground the fixtures paint under the tabs: the shell's light ground. */
export const FIXTURE_GROUND = 'e7e9ef'

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
  /**
   * ground mode: each document load's tag, in order (a `?mvtag=<hex>` in the URL chooses it; else the next of
   * DOC_TAGS). Every load gets a tag of its own: one equal to the load before it (a reload of a `?mvtag=` URL, or the
   * cycle coming round) takes the next of DOC_TAGS. Only document loads count - a navigation (`sec-fetch-dest:
   * document`) or a plain GET with no proof nonce; the app's proof probes (`x-mv-nonce`, no fetch metadata) never
   * display and are not loads (review of a3-native, major #6)
   */
  tags: { t: number; tag: string }[]
  close(): Promise<void>
}

const ROUTE = '/__mv'

function writeWhole(file: string, body: string) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, file)
}

export interface PageOptions {
  name: string
  cookie?: boolean
  script?: string
  /** ground mode: this load's document tag (hex, no #) */
  tag?: string
  ballastMB?: number
  gpuBallast?: number
  cpuBallast?: boolean
  sentinel?: string
}

/** Half a colour's luminance: ground mode's content. */
const half = (hex: string) => hex.match(/../g)!.map((c) => Math.round(parseInt(c, 16) / 2).toString(16).padStart(2, '0')).join('')

export function pageHtml(o: PageOptions): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
  const hex = (h: string | undefined) => (h && /^[0-9a-f]{6}$/i.test(h) ? h.toLowerCase() : null)
  const tag = hex(o.tag)
  const sentinel = hex(o.sentinel)
  const bodyBg = sentinel ? `#${sentinel}` : tag ? `#${half(tag)}` : '#e7e9ef'
  // ground mode (A3.8 #34): the top 44 px the shell's ground, a 60 x 20 document tag at the centre and a 12 x 20
  // size tag at innerWidth - 260; the content the document tag at half luminance. Fixed elements: they stay put
  // whatever the page scrolls, so what the capture sees under the tabs is only these.
  const ground = tag ? `<div id="mv-band" style="position:fixed;left:0;top:0;right:0;height:44px;background:#${FIXTURE_GROUND}"></div>
<div id="mv-doc-tag" style="position:fixed;top:12px;left:calc(50% - 30px);width:60px;height:20px;background:#${tag}"></div>
<div id="mv-size-tag" style="position:fixed;top:12px;left:calc(100% - ${SIZE_TAG_X}px);width:12px;height:20px;background:#${SIZE_TAG}"></div>` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.name)}</title></head>
<body style="margin:0;background:${bodyBg};font:13px -apple-system,sans-serif;min-height:100vh">${ground}<div id="app" style="padding:${tag ? 60 : 24}px 24px 24px;${tag || sentinel ? `color:${bodyBg}` : ''}">${esc(o.name)}</div>
<script>
(function () {
  var say = function (what) { try { fetch('${ROUTE}/test/' + what, { method: 'POST', keepalive: true }) } catch (e) {} };
  requestAnimationFrame(function () { say('raf') });
  ${o.cookie ? "document.cookie = 'mvfake=1; max-age=3600; path=/; samesite=strict';" : ''}
  ${tag ? GROUND_SCRIPT : ''}
  ${o.ballastMB ? `window.__mvBallast = new Uint8Array(${Math.round(o.ballastMB)} * 1048576); for (var i = 0; i < window.__mvBallast.length; i += 4096) window.__mvBallast[i] = 1 + (i & 127); say('ballast');` : ''}
  ${o.gpuBallast ? GPU_SCRIPT(Math.round(o.gpuBallast)) : ''}
  ${o.cpuBallast ? CPU_SCRIPT : ''}
  ${o.script ?? ''}
})();
</script></body></html>`
}

/**
 * Ground mode speaks the 0.27.2 contract the way a shell does (A3.8 #26, #27, #31): it says hello with the inset main
 * answered (44 only with the whole presentation contract, as inset.ts reads it), and answers each `mv:present` once
 * its viewport is the size asked (500 ms at most) and `frames` animation frames have run, a newer request cancelling
 * an older wait. `window.__mvPresented` lists what it answered; `window.__mvGesture(on)` sends a recorder gesture.
 */
const GROUND_SCRIPT = `
  var A = window.marverApp;
  var inset = A && A.topInset === 44 && typeof A.onPresent === 'function' && typeof A.presented === 'function' ? 44 : 0;
  window.__mvPresented = [];
  if (A) {
    try { A.hello({ version: '0.27.2-fake', board: null, page: 'ground-' + Math.random().toString(36).slice(2, 12), inset: inset }); A.busy({ busy: false, unsaved: false, why: [] }) } catch (e) {}
    var waiting = 0;
    if (A.onPresent) A.onPresent(function (r) {
      var mine = ++waiting, start = performance.now();
      var sized = function () {
        if (mine !== waiting) return;
        if ((innerWidth !== r.w || innerHeight !== r.h) && performance.now() - start < 500) return requestAnimationFrame(sized);
        var n = r.frames;
        var tick = function () { if (mine !== waiting) return; if (--n > 0) return requestAnimationFrame(tick); var p = { epoch: r.epoch, w: innerWidth, h: innerHeight }; window.__mvPresented.push(p); try { A.presented(p) } catch (e) {} };
        requestAnimationFrame(tick);
      };
      sized();
    });
    var gseq = 0;
    window.__mvGesture = function (on) { if (on) gseq++; try { A.perf && A.perf({ kind: 'gesture', on: !!on, seq: gseq, type: 'zoom' }) } catch (e) {} return gseq };
    // the white-out probes as a shell answers them (A3.8 #16): up to 16 grid points of the content area at least 48 px
    // from every .mv-node (a frame), the page itself under them; the camera never moves here, so every one stays valid
    var kept = {};
    window.__mvPick = function () {
      var rs = [].slice.call(document.querySelectorAll('.mv-node')).map(function (e) { return e.getBoundingClientRect() });
      var pts = [], top = 60;
      for (var j = 0; j < 10; j++) for (var i = 0; i < 12; i++) {
        var x = Math.round((i + .5) * innerWidth / 12), y = Math.round(top + (j + .5) * (innerHeight - top) / 10);
        var near = rs.some(function (r) { return Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom)) < 48 });
        var el = document.elementFromPoint(x, y);
        if (!near && el && !el.closest('.mv-node')) pts.push([x, y]);
      }
      return pts.slice(0, 16);
    };
    if (A.onPerfAsk) A.onPerfAsk(function (a) {
      if (a.kind !== 'probes') return;
      var view = { w: innerWidth, h: innerHeight }, cam = { x: 0, y: 0, s: 1 };
      if (a.at === 'before') { var p = window.__mvPick(); kept[a.tick] = p; A.perf({ kind: 'probes', tick: a.tick, at: 'before', points: p, cam: cam, view: view }) }
      else { var q = kept[a.tick] || []; delete kept[a.tick]; A.perf({ kind: 'probes', tick: a.tick, at: 'after', valid: q.map(function () { return true }), cam: cam, view: view }) }
    });
  }
  // a staged white-out: a white overlay over everything, taking no pointer events (as a compositor flash would not)
  window.__mvOverlay = function (ms) {
    var o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;background:#fff;pointer-events:none;z-index:2147483647';
    document.body.appendChild(o); setTimeout(function () { o.remove() }, ms); return 1;
  };
  // a frame that is white on purpose: a white .mv-node over the top 88 % of the view (the view is then white, the probes below it are not)
  window.__mvWhiteFrame = function (on) {
    var f = document.getElementById('mv-white-frame');
    if (!on) { if (f) f.remove(); return 0 }
    if (!f) { f = document.createElement('div'); f.id = 'mv-white-frame'; f.className = 'mv-node'; f.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:88%;background:#fff;z-index:5'; document.body.appendChild(f) }
    return 1;
  };`

/** GPU ballast: n WebGL canvases, each drawn once and held in the page (A3.8 #45's report case). */
const GPU_SCRIPT = (n: number) => `
  var box = document.createElement('div'); box.style.cssText = 'position:fixed;left:0;bottom:0;width:4px;height:4px;overflow:hidden;opacity:.02';
  document.body.appendChild(box); window.__mvGpu = [];
  for (var g = 0; g < ${n}; g++) { var c = document.createElement('canvas'); c.width = 1024; c.height = 1024; var gl = c.getContext('webgl');
    if (gl) { gl.clearColor(g / ${n}, .5, .5, 1); gl.clear(gl.COLOR_BUFFER_BIT) } box.appendChild(c); window.__mvGpu.push(gl) }
  say('gpu-ballast');`

/** CPU ballast: once hidden, about a third of a core (300 ms of a 1 s timer, which survives a hidden page's throttling). */
const CPU_SCRIPT = `
  var burning = null;
  var burn = function () { var e = performance.now() + 300; while (performance.now() < e) {} };
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && !burning) { burning = setInterval(burn, 1000); say('cpu-ballast') }
    else if (document.visibilityState === 'visible' && burning) { clearInterval(burning); burning = null }
  });`

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
    features: opts.features ?? (opts.ground ? ['bridge', 'inset'] : ['bridge']), ws, startedAt: Date.now(), key: key.toString('base64url'),
  }
  writeWhole(slotFile, JSON.stringify(rec, null, 2) + '\n')

  const tags: { t: number; tag: string }[] = []
  const isLoad = (h: IncomingHttpHeaders) => { const dest = h['sec-fetch-dest']; return dest === 'document' || (dest === undefined && h['x-mv-nonce'] === undefined) }
  const html = (url: string, load: boolean) => {
    let tag: string | undefined
    if (opts.ground) {
      const was = tags.at(-1)?.tag
      if (!load) tag = was ?? DOC_TAGS[0]   // a probe's body: never shown, never counted
      else {
        tag = (/[?&]mvtag=([0-9a-fA-F]{6})/.exec(url)?.[1] ?? DOC_TAGS[tags.length % DOC_TAGS.length]).toLowerCase()
        if (tag === was) tag = DOC_TAGS[(DOC_TAGS.indexOf(was as typeof DOC_TAGS[number]) + 1) % DOC_TAGS.length]!
        tags.push({ t: Date.now(), tag })
      }
    }
    return pageHtml({ name, cookie: opts.cookie, script: opts.script, tag, ballastMB: opts.ballastMB, gpuBallast: opts.gpuBallast, cpuBallast: opts.cpuBallast, sentinel: opts.sentinel })
  }
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
      return res.end(req.method === 'HEAD' ? undefined : html(req.url ?? '/', isLoad(req.headers)))
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
    port, origin, url, slotFile, instance, key, ws, requests, ready, tags,
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
