/**
 * Sessions, permissions, navigation (spec 28 A2.5, A2.14 #4, #11, #13, #14). Owner: the trust stream.
 *
 * - `persist:app` serves `marver-app://` - only the files `pages/manifest.json` lists for each page, by exact path
 *   (no join on request input, no `..`, no listing), GET only, with A2.5's CSP, `nosniff` and `no-store` - and
 *   grants nothing.
 * - `persist:local:<record.ws>`, one per canvas workspace (A2.14 #10), prepared once before its first navigation:
 *   deny-by-default permissions, the proof dispatcher (proof.ts), then `clearStorageData({ storages:
 *   ['serviceworkers'] })` awaited, so a worker planted earlier never serves a page (A2.3).
 * - Permissions: a local canvas with current trust may have `media` with audio alone from its main frame on its own
 *   origin, `clipboard-sanitized-write` and `fullscreen`; everything else, and everything for an untrusted document
 *   or an app page, is refused. Each request is answered at once, so none is left waiting when trust goes (A2.14 #13).
 * - The one `web-contents-created` hook (`installNavigationPolicy`), the webContents' kind read at event time from
 *   the bridge: a canvas's main frame stays on its bound origin and the shell's own document; a same-origin
 *   `window.open` of that document goes to the window stream's handler (`onSameCanvasOpen`: that canvas's tab focused
 *   and taken there through the guard - one tab per canvas, A2.14 #4); a same-origin path the policy refuses opens
 *   the canvas's people link outside; anything else is refused and goes to `openOutside` (https, http, mailto; no
 *   credentials; under 2 KB; one a second). Only a canvas whose committed document is trusted sends anything on: a
 *   refused navigation or a window from any other document - a page that lost its trust, one committed unattributed
 *   beneath its tab page - opens nothing and asks for nothing. A canvas's own shell document never leaves the app,
 *   on whatever loopback host it is written; another running canvas leaves as its people link. Subframes navigate
 *   freely; `devtools://` is exempt. App pages are pinned: every navigation, redirect and window refused. No
 *   `<webview>` attaches.
 * - Every view is made with `disableDialogs: true` (A2.14 #14): `canvasWebPreferences` and `appWebPreferences` are
 *   the one place their preferences are written. `disableDialogs` covers `alert`, `confirm` and `prompt` (which
 *   Electron 45 does not implement: it throws). A download is the other sheet a page can raise: a local session
 *   cancels every download but one from a canvas whose committed document is trusted, whose view has focus (the
 *   shown tab the person is using: a hidden view, or one beneath its tab page, never has it) and whose URL is not
 *   the canvas's own document - only a listener on its port could answer the app's document request so;
 *   `persist:app` cancels every download. `print()` is not covered: Electron 45 has no hook for it, Marver's shell
 *   never calls it, and a frame's own `print()` shows the print panel as it would in a browser (a narrowing of
 *   A2.14 #14, for the spec).
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { app, session, shell, type MediaAccessPermissionRequest, type PermissionCheckHandlerHandlerDetails, type PermissionRequest, type Session, type WebContents, type WebPreferences } from 'electron'
import { kindOf } from './bridge.ts'
import { canvasAddress, installDispatcher, isTrusted, SHELL_DOC, shellDocUrl, targetOf } from './proof.ts'
import type { RegistryEntry } from './registry.ts'
import { note, provide, testMode } from './testing/index.ts'

export const APP_PARTITION = 'persist:app'
export const localPartition = (ws: string): string => `persist:local:${ws}`
export const APP_SCHEME = 'marver-app'
export type AppPage = 'strip' | 'home' | 'settings' | 'tabpage'
/** A2.5's policy for every app page. */
export const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
/** The one URL each app page loads. */
export const pinnedUrl = (page: AppPage): string => `${APP_SCHEME}://${page}/`
/** The cover's one URL (S15's variant 3, cover.ts): an app page of the scheme, pinned like the others, never a bridge page. */
export const COVER_URL = `${APP_SCHEME}://cover/`
const WS = /^[0-9a-f]{16}$/

/** The bundles' folder: dist/, beside main.cjs (in the packaged app, inside app.asar). */
const dist = (): string => __dirname
export const preloadPath = (which: 'canvas' | 'app'): string => join(dist(), `preload-${which}.cjs`)

/** A canvas view's preferences: its workspace's partition, the canvas preload, sandboxed, no dialogs. */
export function canvasWebPreferences(ws: string): WebPreferences {
  if (!WS.test(ws)) throw new Error('not a workspace')
  return {
    partition: localPartition(ws), preload: preloadPath('canvas'), sandbox: true, contextIsolation: true,
    nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false,
    disableDialogs: true, disableHtmlFullscreenWindowResize: true, focusOnNavigation: false, navigateOnDragDrop: false,
    safeDialogs: true, webSecurity: true, allowRunningInsecureContent: false,
  }
}
/** An app page's preferences (the strip, Home, Settings, a tab page): `persist:app`, the app preload, no dialogs. */
export function appWebPreferences(): WebPreferences {
  return {
    partition: APP_PARTITION, preload: preloadPath('app'), sandbox: true, contextIsolation: true,
    nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false,
    disableDialogs: true, navigateOnDragDrop: false, safeDialogs: true, webSecurity: true,
  }
}

/**
 * The cover's preferences (S15's variant 3, A3.8 #3): `persist:app` like the app pages, but no preload - its page
 * draws the still dots and nothing else, and hears nothing (cover.ts sets its look). Never throttled, as on S15's
 * bench: it is ready only once its renderer has made a frame, which a hidden or occluded window must not withhold.
 */
export function coverWebPreferences(): WebPreferences {
  return {
    partition: APP_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false, webviewTag: false, disableDialogs: true, navigateOnDragDrop: false, safeDialogs: true,
    webSecurity: true, spellcheck: false, backgroundThrottling: false,
  }
}

// ---- permissions ---------------------------------------------------------------------------------------------

const originOf = (raw: string | undefined): string | null => {
  if (!raw) return null
  try { const o = new URL(raw).origin; return o === 'null' ? null : o } catch { return null }
}
/** The trusted canvas a webContents shows, or null. */
function trustedCanvas(wc: WebContents | null | undefined): RegistryEntry | null {
  if (!wc || wc.isDestroyed() || kindOf(wc.id) !== 'canvas' || !isTrusted(wc.id)) return null
  const e = targetOf(wc.id)?.entry
  return e?.origin ? e : null
}
export function allowRequest(wc: WebContents | null, permission: string, details: PermissionRequest): boolean {
  const e = trustedCanvas(wc)
  if (!e) return false
  if (permission === 'media') {
    const m = (details as MediaAccessPermissionRequest).mediaTypes ?? []
    return details.isMainFrame && m.length > 0 && m.every((t) => t === 'audio') && originOf(details.requestingUrl) === e.origin
  }
  return permission === 'clipboard-sanitized-write' || permission === 'fullscreen'
}
export function allowCheck(wc: WebContents | null, permission: string, requestingOrigin: string, details: PermissionCheckHandlerHandlerDetails): boolean {
  const e = trustedCanvas(wc)
  if (!e) return false
  if (permission === 'media') return details.isMainFrame && details.mediaType === 'audio' && originOf(details.securityOrigin ?? requestingOrigin) === e.origin
  return permission === 'clipboard-sanitized-write' || permission === 'fullscreen'
}

function harden(ses: Session, kind: 'app' | 'local'): void {
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ok = kind === 'local' && allowRequest(wc, permission, details)
    if (__MV_TEST__) note('permission', { wc: wc?.id, permission, ok, how: 'request', media: (details as MediaAccessPermissionRequest).mediaTypes, main: details.isMainFrame })
    cb(ok)
  })
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    const ok = kind === 'local' && allowCheck(wc, permission, origin, details)
    if (__MV_TEST__) note('permission', { wc: wc?.id, permission, ok, how: 'check' })
    return ok
  })
  ses.setDevicePermissionHandler(() => false)
}

// ---- marver-app:// ------------------------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.ico': 'image/x-icon',
}
let manifest: Record<string, Record<string, string>> | null = null
function pages(): Record<string, Record<string, string>> {
  if (manifest) return manifest
  try { manifest = JSON.parse(readFileSync(join(dist(), 'pages', 'manifest.json'), 'utf8')) as Record<string, Record<string, string>> } catch { manifest = {} }
  return manifest
}
/** The file the manifest lists for a marver-app:// URL, or null (pure but for the manifest it reads). */
export function pageFile(raw: string, method = 'GET'): string | null {
  if (method !== 'GET') return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== `${APP_SCHEME}:` || u.username || u.password) return null
  const m = pages()
  const page = Object.hasOwn(m, u.host) ? m[u.host] : undefined
  const file = page && Object.hasOwn(page, u.pathname) ? page[u.pathname] : undefined
  return typeof file === 'string' && !file.includes('..') ? file : null
}
async function serveApp(req: Request): Promise<Response> {
  const file = pageFile(req.url, req.method)
  if (!file) return new Response('', { status: 404, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })
  try {
    const body = await readFile(join(dist(), 'pages', file))
    return new Response(body, { status: 200, headers: {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-security-policy': APP_CSP,
      'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
    } })
  } catch { return new Response('', { status: 404 }) }
}

/** `persist:app`, its `marver-app://` protocol and its deny-by-default handlers. Called once, at ready. */
export function setupAppSession(): Session {
  const ses = session.fromPartition(APP_PARTITION)
  harden(ses, 'app')
  ses.on('will-download', (e) => e.preventDefault())   // an app page downloads nothing: no save sheet
  if (!ses.protocol.isProtocolHandled(APP_SCHEME)) ses.protocol.handle(APP_SCHEME, serveApp)
  if (__MV_TEST__) provideTrustHooks()
  return ses
}

// ---- local sessions -----------------------------------------------------------------------------------------

/**
 * Why a download from this webContents is cancelled, or null when Electron may ask where to save it: only a trusted
 * canvas whose view has focus - the tab shown and in use, never a hidden one or a page beneath its tab page - and
 * never the canvas's own document (only a listener on its port could answer the app's document request so).
 */
export function refuseDownload(wc: WebContents | null | undefined, url: string): string | null {
  if (!wc || wc.isDestroyed() || kindOf(wc.id) !== 'canvas') return 'not a canvas'
  const t = targetOf(wc.id)
  if (t && shellDocUrl(url, t.entry)) return 'the canvas\'s own document'
  if (!isTrusted(wc.id)) return 'untrusted'
  if (!wc.isFocused()) return 'not in use'
  return null
}

const locals = new Map<string, Promise<Session>>()

/** A local canvas's partition, prepared once before its first navigation (A2.3). */
export function localSession(ws: string): Promise<Session> {
  if (!WS.test(ws)) return Promise.reject(new Error('not a workspace'))
  let p = locals.get(ws)
  if (!p) {
    p = (async () => {
      const ses = session.fromPartition(localPartition(ws))
      // test builds only: a run that plants a service worker in this workspace's storage, for the next launch's sweep
      const plant = __MV_TEST__ && testMode() && process.env.MARVER_APP_TEST_ALLOW_SW === ws
      harden(ses, 'local')
      installDispatcher(ses, { allowServiceWorkers: plant })
      ses.on('will-download', (e, item, wc) => {
        const why = refuseDownload(wc, item.getURL())
        if (__MV_TEST__ && testMode()) note('download', { url: item.getURL(), wc: wc?.id, saved: why === null, why })
        // a test build records the decision and never shows the save sheet
        if (why !== null || (__MV_TEST__ && testMode())) e.preventDefault()
      })
      if (!plant) {
        await ses.clearStorageData({ storages: ['serviceworkers'] }).catch((err: Error) => {
          process.stderr.write(`marver-app: the service-worker sweep of a canvas's storage failed: ${err.message}\n`)
        })
      }
      if (__MV_TEST__) note('session', { ws, swept: !plant })
      return ses
    })()
    locals.set(ws, p)
  }
  return p
}

// ---- navigation -----------------------------------------------------------------------------------------------

let last = 0
const opened: string[] = []

/** The one way a URL leaves the app: https, http or mailto, no credentials, under 2 KB, one a second. */
export function openOutside(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length > 2048) return false
  let u: URL
  try { u = new URL(raw) } catch { return false }
  if (!['https:', 'http:', 'mailto:'].includes(u.protocol) || u.username || u.password) return false
  const now = Date.now()
  if (now - last < 1000) return false
  last = now
  if (__MV_TEST__ && testMode()) { opened.push(u.href); note('open-outside', { url: u.href }); return true }   // tests never open a browser
  void shell.openExternal(u.href).catch(() => {})
  return true
}

let sameCanvas: ((webContentsId: number, url: string) => void) | null = null
/**
 * The window stream's handler for a canvas's same-origin `window.open` of its own shell document: focus that tab
 * and go there through the guard, `{ kind: 'load', url }` (A2.14 #4, v1.14 r3 #2). `url` is already rebuilt on the
 * tab's bound origin and checked.
 */
export function onSameCanvasOpen(fn: (webContentsId: number, url: string) => void): void { sameCanvas = fn }

/** The canvas's link for people - `http://localhost:<port>/` and the path - for a same-origin path refused here. */
export const peopleLink = (e: Pick<RegistryEntry, 'url'>, u: URL): string => e.url + u.pathname.slice(1) + u.search + u.hash

/** Whether a webContents may navigate a frame to `url` (renderer-started navigations and redirects). */
export function allowNav(wc: WebContents, url: string, isMainFrame: boolean): boolean {
  if (url.startsWith('devtools://')) return true
  const kind = kindOf(wc.id)
  if (kind !== 'canvas') return false   // app pages are pinned; a webContents main never made navigates nowhere
  if (!isMainFrame) return true
  const t = targetOf(wc.id)
  return !!t && shellDocUrl(url, t.entry) !== null
}

/**
 * Where a refused navigation or a window of a canvas goes: nowhere unless its committed document is trusted; its
 * own shell document on its bound origin to the canvas's tab (a window only), and nowhere on another loopback host;
 * a running canvas's address - a loopback host on a port the registry or the tab names - as that canvas's people
 * link; anything else through openOutside's checks.
 */
function sendOn(wc: WebContents, url: string, how: 'navigation' | 'window'): void {
  const quiet = (why: string) => { if (__MV_TEST__) note('policy', { wc: wc.id, event: 'not-sent', how, why, url }) }
  if (kindOf(wc.id) !== 'canvas') return quiet('not a canvas')
  if (!isTrusted(wc.id)) return quiet('untrusted')
  const t = targetOf(wc.id)
  let u: URL
  try { u = new URL(url) } catch { return quiet('not a URL') }
  if (u.username || u.password) return quiet('credentials')
  if (how === 'window' && t?.entry.origin && u.origin === t.entry.origin && SHELL_DOC.test(u.pathname)) {
    const target = t.entry.origin + u.pathname + u.search + u.hash
    if (__MV_TEST__) note('policy', { wc: wc.id, event: 'same-canvas-open', url: target })
    if (target.length <= 2048) sameCanvas?.(wc.id, target)
    return
  }
  const canvas = canvasAddress(u, t)
  if (canvas) {
    if (canvas.port === t?.entry.port && SHELL_DOC.test(u.pathname)) return quiet('the canvas\'s own document')
    openOutside(peopleLink(canvas, u))
    return
  }
  openOutside(u.href)
}

function policy(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (kindOf(wc.id) === 'canvas') sendOn(wc, url, 'window')
    else if (__MV_TEST__) note('policy', { wc: wc.id, event: 'window-refused', url })
    return { action: 'deny' }
  })
  wc.on('will-frame-navigate', (e) => {
    if (allowNav(wc, e.url, e.isMainFrame)) return
    e.preventDefault()
    if (__MV_TEST__) note('policy', { wc: wc.id, event: 'navigation-refused', url: e.url, main: e.isMainFrame })
    if (e.isMainFrame && kindOf(wc.id) === 'canvas') sendOn(wc, e.url, 'navigation')
  })
  wc.on('will-navigate', (e) => { if (!allowNav(wc, e.url, true)) e.preventDefault() })
  wc.on('will-redirect', (e) => {
    if (allowNav(wc, e.url, e.isMainFrame)) return
    e.preventDefault()
    if (__MV_TEST__) note('policy', { wc: wc.id, event: 'redirect-refused', url: e.url, main: e.isMainFrame })
  })
  wc.on('will-attach-webview', (e) => e.preventDefault())
}

let hooked = false
/** The one `web-contents-created` hook, installed at ready before any view exists. */
export function installNavigationPolicy(): void {
  if (hooked) return
  hooked = true
  app.on('web-contents-created', (_e, wc) => policy(wc))
}

/** Test builds: what left the app through `openOutside`. */
function provideTrustHooks(): void {
  provide('trust:opened', () => [...opened])
}
