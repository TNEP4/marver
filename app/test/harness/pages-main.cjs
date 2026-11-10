/**
 * The pages harness's Electron main (spec 28 A2.10, A2.13; test/harness/pages.ts launches it). Not the app: a fake
 * main for one app page, so the pages stream's cases run the REAL page bundle and the REAL app preload
 * (dist/preload-app.cjs) together, as the app will - served on `marver-app://<page>/` from dist/pages/manifest.json
 * with A2.5's CSP, sandboxed, context-isolated - while the test plays main: it sends the page its snapshots
 * (`__pages.send`), reads what the page sent (`__pages.calls`) and sets what each invoke answers (`__pages.answers`,
 * a value or a function). Nothing here reads or writes ~/.marver; the profile is MARVER_APP_USER_DATA (a temp folder,
 * required). The window is never shown: the cases need the DOM, not the screen.
 *
 * Spec 32 (G4): MVPAGES_DPR (1 or 2) forces the device scale factor (H2.1's proofs). MVPAGES_PAGE 'proof' serves
 * the proof route instead of a page: `/` is MVPAGES_PROOF (an .html in MVPAGES_PROOF_DIR, test/proofs/), `/proof.js`
 * is MVPAGES_PROOF_JS when given, `/<name>` a file of the proof folder, then a file of dist/pages/shared, and
 * `/pages/<page>/<path>` what that page's manifest serves - all under the pages' CSP, with no preload.
 */
'use strict'
const { app, BrowserWindow, ipcMain, protocol, session } = require('electron')
const { existsSync, readFileSync } = require('node:fs')
const { extname, join } = require('node:path')

const DIST = process.env.MVPAGES_DIST
const PAGE = process.env.MVPAGES_PAGE
const W = Number(process.env.MVPAGES_W || 1100)
const H = Number(process.env.MVPAGES_H || 720)
if (!DIST || !PAGE || !process.env.MARVER_APP_USER_DATA) {
  process.stderr.write('pages-main: MVPAGES_DIST, MVPAGES_PAGE and MARVER_APP_USER_DATA are required\n')
  app.exit(2)
}
const DPR = process.env.MVPAGES_DPR
if (DPR === '1' || DPR === '2') app.commandLine.appendSwitch('force-device-scale-factor', DPR)
const PROOF = PAGE === 'proof' ? { file: process.env.MVPAGES_PROOF, dir: process.env.MVPAGES_PROOF_DIR, js: process.env.MVPAGES_PROOF_JS || '' } : null
if (PROOF && (!PROOF.file || !PROOF.dir)) {
  process.stderr.write('pages-main: the proof route needs MVPAGES_PROOF and MVPAGES_PROOF_DIR\n')
  app.exit(2)
}
app.setPath('userData', process.env.MARVER_APP_USER_DATA)
app.setName('Marver pages test')
protocol.registerSchemesAsPrivileged([{ scheme: 'marver-app', privileges: { standard: true, secure: true } }])

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
}
const PARTITION = 'persist:pages-test'

const calls = []
const answers = {
  'link:open': { ok: true },
  'home:action': { ok: true },
  'settings:get': null,
  'settings:set': { ok: true },
}
const csp = []
let win = null

globalThis.__pages = {
  calls,
  answers,
  csp,
  send(ch, payload) { win.webContents.send(ch, payload) },
  /** the invoke rejects, as it does when main has no handler for it or its handler throws */
  reject(ch) { answers[ch] = () => { throw new Error(`refused: ${ch}`) } },
  /** the invoke answers `value` after `ms` */
  later(ch, value, ms) { answers[ch] = () => new Promise((r) => setTimeout(() => r(value), ms)) },
  resize(w, h) { win.setContentSize(w, h) },
  wc: () => win.webContents,
}

// which channels are invokes and which sends is channels.ts's (INVOKES, SENDERS), handed over by pages.ts: the fake
// main mounts each the way the real bridge must, so a page calling a send as an invoke (or the reverse) fails here
const INVOKES = JSON.parse(process.env.MVPAGES_INVOKES || '[]')
const SENDS = JSON.parse(process.env.MVPAGES_SENDS || '[]')
if (!INVOKES.length || !SENDS.length) {
  process.stderr.write('pages-main: MVPAGES_INVOKES and MVPAGES_SENDS are required (test/harness/pages.ts)\n')
  app.exit(2)
}

app.whenReady().then(() => {
  const manifest = JSON.parse(readFileSync(join(DIST, 'pages', 'manifest.json'), 'utf8'))
  const ses = session.fromPartition(PARTITION)
  const serve = (path) => new Response(readFileSync(path), {
    headers: { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' },
  })
  ses.protocol.handle('marver-app', (req) => {
    const u = new URL(req.url)
    if (PROOF) return proofFile(u, manifest, serve)
    const file = manifest[u.host] && manifest[u.host][u.pathname]
    if (!file) return new Response('not found', { status: 404 })
    return serve(join(DIST, 'pages', file))
  })
  for (const ch of SENDS) ipcMain.on(ch, (_e, p) => calls.push({ ch, p: p === undefined ? null : p, t: Date.now() }))
  for (const ch of INVOKES) {
    ipcMain.handle(ch, async (_e, p) => {
      calls.push({ ch, p: p === undefined ? null : p, t: Date.now() })
      const a = answers[ch]
      return typeof a === 'function' ? await a(p) : a
    })
  }
  win = new BrowserWindow({
    width: W, height: H, useContentSize: true, show: false,
    webPreferences: {
      preload: PROOF ? undefined : join(DIST, 'preload-app.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      partition: PARTITION, backgroundThrottling: false, disableDialogs: true,
    },
  })
  win.webContents.on('console-message', (e) => {
    const m = e.message || ''
    if (/Content Security Policy|Refused to/.test(m)) csp.push(m)
  })
  void win.loadURL(`marver-app://${PAGE}/`)
})

/** The proof route (G4): the named page, its bundle, the proof folder's files, the shared files, any page's files. */
function proofFile(u, manifest, serve) {
  const notFound = () => new Response('not found', { status: 404 })
  if (u.host !== 'proof') return notFound()
  const path = decodeURIComponent(u.pathname)
  if (path === '/' || path === '/index.html') return serve(join(PROOF.dir, PROOF.file))
  if (path === '/proof.js') return PROOF.js ? serve(PROOF.js) : notFound()
  const page = /^\/pages\/([a-z]+)(\/.*)$/.exec(path)
  if (page) {
    const file = manifest[page[1]] && manifest[page[1]][page[2]]
    return file ? serve(join(DIST, 'pages', file)) : notFound()
  }
  const name = /^\/([\w.-]+)$/.exec(path)
  if (!name || name[1].startsWith('.')) return notFound()
  if (TYPES[extname(name[1])] && existsSync(join(PROOF.dir, name[1]))) return serve(join(PROOF.dir, name[1]))
  if (existsSync(join(DIST, 'pages', 'shared', name[1]))) return serve(join(DIST, 'pages', 'shared', name[1]))
  return notFound()
}
