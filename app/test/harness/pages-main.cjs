/**
 * The pages harness's Electron main (spec 28 A2.10, A2.13; test/harness/pages.ts launches it). Not the app: a fake
 * main for one app page, so the pages stream's cases run the REAL page bundle and the REAL app preload
 * (dist/preload-app.cjs) together, as the app will - served on `marver-app://<page>/` from dist/pages/manifest.json
 * with A2.5's CSP, sandboxed, context-isolated - while the test plays main: it sends the page its snapshots
 * (`__pages.send`), reads what the page sent (`__pages.calls`) and sets what each invoke answers (`__pages.answers`,
 * a value or a function). Nothing here reads or writes ~/.marver; the profile is MARVER_APP_USER_DATA (a temp folder,
 * required). The window is never shown: the cases need the DOM, not the screen.
 */
'use strict'
const { app, BrowserWindow, ipcMain, protocol, session } = require('electron')
const { readFileSync } = require('node:fs')
const { extname, join } = require('node:path')

const DIST = process.env.MVPAGES_DIST
const PAGE = process.env.MVPAGES_PAGE
const W = Number(process.env.MVPAGES_W || 1100)
const H = Number(process.env.MVPAGES_H || 720)
if (!DIST || !PAGE || !process.env.MARVER_APP_USER_DATA) {
  process.stderr.write('pages-main: MVPAGES_DIST, MVPAGES_PAGE and MARVER_APP_USER_DATA are required\n')
  app.exit(2)
}
app.setPath('userData', process.env.MARVER_APP_USER_DATA)
app.setName('Marver pages test')
protocol.registerSchemesAsPrivileged([{ scheme: 'marver-app', privileges: { standard: true, secure: true } }])

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
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
  resize(w, h) { win.setContentSize(w, h) },
  wc: () => win.webContents,
}

const SENDS = ['app:ready', 'tab:activate', 'tab:close', 'tab:menu', 'tabs:more', 'pill:action', 'tabpage:action', 'settings:reveal']
const INVOKES = ['link:open', 'home:action', 'settings:get', 'settings:set']

app.whenReady().then(() => {
  const manifest = JSON.parse(readFileSync(join(DIST, 'pages', 'manifest.json'), 'utf8'))
  const ses = session.fromPartition(PARTITION)
  ses.protocol.handle('marver-app', (req) => {
    const u = new URL(req.url)
    const file = manifest[u.host] && manifest[u.host][u.pathname]
    if (!file) return new Response('not found', { status: 404 })
    return new Response(readFileSync(join(DIST, 'pages', file)), {
      headers: { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' },
    })
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
      preload: join(DIST, 'preload-app.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      partition: PARTITION, backgroundThrottling: false, disableDialogs: true,
    },
  })
  win.webContents.on('console-message', (e) => {
    const m = e.message || ''
    if (/Content Security Policy|Refused to/.test(m)) csp.push(m)
  })
  void win.loadURL(`marver-app://${PAGE}/`)
})
