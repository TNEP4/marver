/**
 * Spike S15's bench (spec 28 A3.8 #3): can a cover sit over a full-height web view? Like S13's: a BaseWindow
 * 1100 x 700 (titleBarStyle 'hidden', kept on top, shown inactive), two full-window canvas views A and B each
 * painting a saturated pattern into their top 44 px, a transparent 44 px strip view on top (a capsule standing for
 * the tabs, and a 2 px compositor heartbeat in its right corner so every refresh has a frame), and between them one
 * of the four covers:
 *   1 a plain View with the ground as its background;
 *   2 an ImageView holding a still-dots bitmap (its background the ground);
 *   3 a WebContentsView whose page draws only the dots, its ground its native background (setBackgroundColor) - on a
 *     persist: partition of its own, its page served by a privileged standard scheme (`mvbench://cover/`), as cover.ts
 *     will serve `marver-app://cover/` on persist:app (the 23 Oct run used a data: URL in the default session:
 *     `coverFrom: 'data'` repeats it);
 *   4 no extra view: the strip's own background, the ground to cover, transparent to uncover.
 * For variant 3 the cover can also be crashed (`crash-cover`: its renderer gone, not reloaded) or replaced by one that
 * has never painted (`fresh-cover`: its page's request never answered), so a run shows whether covering waits on its
 * renderer at all. A 24 x 24 marker view (a WebContentsView holding a red page), on top of everything in the
 * bottom-left corner, is shown and hidden by `marker`, stamped like every change: the clock control (A3.8 #36) - its
 * first frame must reach the screen 0 to 3 refreshes after the stamp.
 * Driven by run.ts over stdin, one JSON command a line; every reply a JSON line on stdout, stamped with
 * process.hrtime.bigint() (mach_continuous_time in ns, the clock the capture helper writes) right after main made the change.
 * No port is bound, no file is written but the temporary profile the driver names.
 *
 * Run by the app's pinned Electron:  <electron> app/test/bench/s15/bench.cjs   (env S15_USER_DATA, a temp folder)
 */
const { app, BaseWindow, ImageView, View, WebContentsView, nativeImage, protocol, screen, session } = require('electron')
const readline = require('node:readline')

const W = 1100
const H = 700
const STRIP = 44
/** the clock control's marker: its rect in window points */
const MARKER = { x: 24, y: H - 28, width: 24, height: 24 }
const GROUND = '#e7e9ef'
const DOT = '#c9cbd5'

if (!process.env.S15_USER_DATA) { process.stderr.write('S15_USER_DATA must name a temporary folder\n'); process.exit(2) }
app.setPath('userData', process.env.S15_USER_DATA)
app.setName('S15 bench')
// the cover's page as cover.ts will serve its own: a privileged standard scheme on a persist: partition
protocol.registerSchemesAsPrivileged([{ scheme: 'mvbench', privileges: { standard: true, secure: true } }])
const COVER_PARTITION = 'persist:bench-cover'

const say = (o) => process.stdout.write(JSON.stringify({ ns: process.hrtime.bigint().toString(), ...o }) + '\n')
const page = (body, css = '') => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><style>
html,body{margin:0;height:100%;overflow:hidden}${css}</style></head><body>${body}</body></html>`)}`

const canvasPage = (a, b) => page(
  `<div id="tag"></div><div id="hb"></div>`,
  `body{background:#808080}
   #tag{position:fixed;left:0;top:0;right:0;height:${STRIP}px;background:repeating-linear-gradient(90deg,${a} 0 20px,${b} 20px 40px)}
   #hb{position:fixed;left:4px;bottom:4px;width:2px;height:2px;background:#000;animation:hb 1s linear infinite alternate}
   @keyframes hb{from{opacity:.2}to{opacity:.8}}`)
const STRIP_PAGE = page(
  `<div class="cap"></div><div class="hb"></div>`,
  `html,body{background:transparent}
   .cap{position:fixed;left:82px;top:7px;width:140px;height:30px;border-radius:15px;background:#2b2d36}
   .hb{position:fixed;right:3px;top:3px;width:2px;height:2px;background:#000;animation:hb 1s linear infinite alternate}
   @keyframes hb{from{opacity:.15}to{opacity:.85}}`)
const COVER_PAGE = page('', `html,body{background:transparent}
   body{background-image:radial-gradient(${DOT} 1px,transparent 1px);background-size:20px 20px}`)

/** Still dots on the ground, BGRA at the scale factor: 20 px tiles, a 1 px-radius dot at each tile's corner. */
function dotsBitmap(w, h, sf) {
  const pw = Math.round(w * sf), ph = Math.round(h * sf)
  const buf = Buffer.alloc(pw * ph * 4)
  const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]
  const [gr, gg, gb] = hex(GROUND), [dr, dg, db] = hex(DOT)
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const i = (y * pw + x) * 4
    const tx = (x / sf) % 20, ty = (y / sf) % 20
    const dx = Math.min(tx, 20 - tx), dy = Math.min(ty, 20 - ty)
    const dot = dx * dx + dy * dy <= 1
    buf[i] = dot ? db : gb; buf[i + 1] = dot ? dg : gg; buf[i + 2] = dot ? dr : gr; buf[i + 3] = 255
  }
  return nativeImage.createFromBitmap(buf, { width: pw, height: ph, scaleFactor: sf })
}

let win, a, b, strip, cover, marker, variant, coverFrom
const coverPrefs = (prefs) => coverFrom === 'data' ? prefs : { ...prefs, partition: COVER_PARTITION }
const coverUrl = (path = 'cover/') => coverFrom === 'data' ? COVER_PAGE : `mvbench://${path}`
let schemeReady = false
function serveScheme() {
  if (schemeReady) return
  schemeReady = true
  // cover/: the dots page; hang/: never answered, so a view loading it never paints a frame of its own
  session.fromPartition(COVER_PARTITION).protocol.handle('mvbench', (req) => {
    const u = new URL(req.url)
    if (u.host === 'hang') return new Promise(() => {})
    const html = decodeURIComponent(COVER_PAGE.slice(COVER_PAGE.indexOf(',') + 1))
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  })
}
const loaded = (wc) => new Promise((r) => { if (!wc.isLoading()) r(); else wc.once('did-finish-load', () => r()) })

async function setup(v, from) {
  variant = v
  coverFrom = from === 'data' ? 'data' : 'scheme'
  if (coverFrom === 'scheme') serveScheme()
  win = new BaseWindow({ width: W, height: H, titleBarStyle: 'hidden', show: false, resizable: false, title: 'S15 bench', backgroundColor: '#000000' })
  win.setAlwaysOnTop(true, 'floating')
  const prefs = { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  a = new WebContentsView({ webPreferences: prefs })
  b = new WebContentsView({ webPreferences: prefs })
  for (const [view, colours] of [[a, ['#ff00ff', '#00ff00']], [b, ['#0000ff', '#ff8000']]]) {
    view.setBounds({ x: 0, y: 0, width: W, height: H })
    view.setBackgroundColor('#808080')
    win.contentView.addChildView(view)
    void view.webContents.loadURL(canvasPage(...colours))
  }
  b.setVisible(false)
  if (v === 1) { cover = new View(); cover.setBackgroundColor(GROUND) }
  else if (v === 2) { cover = new ImageView(); cover.setBackgroundColor(GROUND); cover.setImage(dotsBitmap(W, STRIP, screen.getPrimaryDisplay().scaleFactor)) }
  else if (v === 3) { cover = new WebContentsView({ webPreferences: coverPrefs(prefs) }); cover.setBackgroundColor(GROUND); void cover.webContents.loadURL(coverUrl()) }
  else cover = null
  if (cover) { cover.setBounds({ x: 0, y: 0, width: W, height: STRIP }); cover.setVisible(false); win.contentView.addChildView(cover) }
  strip = new WebContentsView({ webPreferences: prefs })
  strip.setBackgroundColor('#00000000')
  strip.setBounds({ x: 0, y: 0, width: W, height: STRIP })
  win.contentView.addChildView(strip)
  void strip.webContents.loadURL(STRIP_PAGE)
  // the clock control's marker, on top of everything: a red page, loaded before the window shows - a WebContentsView
  // paints nothing, its native background included, until its renderer has presented a frame (S15, 24 Oct)
  marker = new WebContentsView({ webPreferences: prefs })
  marker.setBackgroundColor('#ff0000')
  marker.setBounds(MARKER)
  marker.setVisible(false)
  win.contentView.addChildView(marker)
  void marker.webContents.loadURL(page('', 'html,body{background:#ff0000}'))
  await Promise.all([a, b, strip, marker, ...(v === 3 ? [cover] : [])].map((x) => loaded(x.webContents)))
  win.showInactive()
  const id = /^window:(\d+):/.exec(win.getMediaSourceId())?.[1]
  say({ ev: 'window', id: Number(id), w: W, h: H, variant: v, sf: screen.getDisplayMatching(win.getBounds()).scaleFactor })
}

function setCover(on) {
  if (variant === 4) strip.setBackgroundColor(on ? GROUND : '#00000000')
  else cover.setVisible(on)
}

/** One turn: the canvas view shown and the cover set together, as compose() does. */
function state(o) {
  if (o.canvas) { const [show, hide] = o.canvas === 'a' ? [a, b] : [b, a]; show.setVisible(true); hide.setVisible(false) }
  if (typeof o.cover === 'boolean') setCover(o.cover)
  say({ ev: 'state', canvas: o.canvas ?? null, cover: o.cover ?? null })
}

const target = (t) => t === 'strip' ? strip.webContents : t === 'cover' && variant === 3 ? cover.webContents : t === 'a' ? a.webContents : null

/** The clock control: the marker shown or hidden, stamped right after the change. */
function setMarker(on) {
  marker.setVisible(on)
  say({ ev: 'marker', on })
}

/** Variant 3's cover with its renderer gone, never reloaded: does covering still reach the screen? */
async function crashCover() {
  if (variant !== 3) return say({ ev: 'crashed', skipped: true })
  const wc = cover.webContents
  const gone = new Promise((r) => wc.once('render-process-gone', (_e, d) => r(d.reason)))
  wc.forcefullyCrashRenderer()
  const reason = await Promise.race([gone, new Promise((r) => setTimeout(() => r('no event in 2 s'), 2000))])
  say({ ev: 'crashed', reason, crashed: wc.isCrashed() })
}

/** Variant 3's cover replaced by a new one whose page is never answered: a cover that has not painted yet. */
async function freshCover() {
  if (variant !== 3) return say({ ev: 'fresh', skipped: true })
  const was = cover
  const prefs = { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  cover = new WebContentsView({ webPreferences: coverPrefs(prefs) })
  cover.setBackgroundColor(GROUND)
  cover.setBounds({ x: 0, y: 0, width: W, height: STRIP })
  cover.setVisible(false)
  // in was's place in the stack: beneath the strip and the marker
  win.contentView.addChildView(cover, win.contentView.children.indexOf(was))
  win.contentView.removeChildView(was)
  try { was.webContents.close() } catch { /* gone */ }
  void cover.webContents.loadURL(coverFrom === 'data' ? 'data:text/html,' : coverUrl('hang/')).catch(() => {})
  await new Promise((r) => setTimeout(r, 200))
  say({ ev: 'fresh', loading: cover.webContents.isLoading(), url: cover.webContents.getURL() })
}

/** Calibration: canvas A paints its top 44 px the ground and its dots (as the cover would), or its pattern again. */
async function calib(on) {
  await a.webContents.executeJavaScript(`document.getElementById('tag').style.background = ${JSON.stringify(on
    ? `radial-gradient(${DOT} 1px, transparent 1px) 0 0 / 20px 20px, ${GROUND}` : '')}; 1`)
  say({ ev: 'calib', on })
}

async function stall(t) {
  const wc = target(t)
  if (!wc) return say({ ev: 'stalled', target: t, skipped: true })
  // a busy loop on the renderer's main thread, after this answer: nothing it would paint, paints
  await wc.executeJavaScript('setTimeout(() => { for (;;) {} }, 0); 1')
  say({ ev: 'stalled', target: t })
}

async function unstall(t) {
  const wc = target(t)
  if (!wc) return say({ ev: 'unstalled', target: t, skipped: true })
  wc.forcefullyCrashRenderer()
  await new Promise((r) => setTimeout(r, 100))
  const url = t === 'strip' ? STRIP_PAGE : t === 'cover' ? coverUrl() : canvasPage('#ff00ff', '#00ff00')
  await wc.loadURL(url).catch(() => {})
  say({ ev: 'unstalled', target: t })
}

app.dock?.hide()
app.whenReady().then(() => {
  say({ ev: 'ready', electron: process.versions.electron })
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (l) => {
    let c
    try { c = JSON.parse(l) } catch { return }
    Promise.resolve().then(async () => {
      if (c.op === 'setup') await setup(c.variant, c.coverFrom)
      else if (c.op === 'state') state(c)
      else if (c.op === 'calib') await calib(c.on)
      else if (c.op === 'stall') await stall(c.target)
      else if (c.op === 'unstall') await unstall(c.target)
      else if (c.op === 'marker') setMarker(!!c.on)
      else if (c.op === 'crash-cover') await crashCover()
      else if (c.op === 'fresh-cover') await freshCover()
      else if (c.op === 'quit') { say({ ev: 'bye' }); app.exit(0) }
    }).catch((e) => say({ ev: 'error', op: c.op, message: String(e && e.message || e) }))
  })
  rl.on('close', () => app.exit(0))
})
app.on('window-all-closed', () => {})
