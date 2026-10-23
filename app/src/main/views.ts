/**
 * The window stream's Electron side (spec 28 A2.2, A2.4, A2.11, A2.13, A2.14 #8, #16, #19, #21, #22, #25, v1.12
 * r1 #3, v1.13 r2 #1-#4, v1.14 r3 #1-#4): the views a tab owns and what happens to them. tabs.ts, tabpage.ts,
 * pill.ts and menu.ts are pure; this file installs their ports.
 *
 * - Lazy views (A2.4): a canvas view is made when its tab is first shown (never re-added: hidden, kept), on its
 *   repo's partition with the canvas preload, `focusOnNavigation: false`, `disableHtmlFullscreenWindowResize`
 *   (HTML fullscreen stays in its view, below the strip) and `disableDialogs` (A2.14 #14).
 * - The adapter's events (nav.ts, the trust stream's) move the model: an attributed commit is admitted and lifts
 *   the tab page in one compose; an unattributed one is reloaded by main, at once then on A2.3's schedule; a
 *   failure hides the view beneath its tab page and arms the retries.
 * - The guard's act and sheet: `close({ waitForBeforeUnload: true })`, `reload()`, `reloadIgnoringCache()`,
 *   `loadURL()`; `will-prevent-unload` is never prevented, so the page's refusal stands. Cancel is the sheet's default.
 * - Crashes go to `recover`; the app's own endings are marked before they happen.
 * - Not responding (A2.11, A2.14 #22, v1.12 r1 #4): the main frame's own `executeJavaScript('0')` under a 1 s
 *   deadline; silent, the pill's Reload opens the sheet, which is checked again before it ends anything.
 * - The app's keys on every view, the commands they and the menu run, the app pages' messages (`pageHandlers`,
 *   which the bridge calls once it has checked the sender and every field), tabs.json.
 */
import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import { app, clipboard, dialog, Menu, nativeTheme, powerMonitor, shell, WebContentsView, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron'
import type { PageKind, TabPageAction } from '../shared/channels.ts'
import { startCommand } from '../shared/command.ts'
import type { AppState, MenuItem } from '../../../src/shared/app-api.ts'
import { docProof } from '../../../src/server/proof.ts'
import type { Files, Home } from './config.ts'
import type { CanvasReports } from './bridge.ts'
import type { NavAdapter, NavEvent } from './nav.ts'
import type { RegistryEntry, RegistryEvent } from './registry.ts'
import { attachKeys, digitOf, type AppCommand } from './keys.ts'
import { focusOwner, f6, track } from './focus.ts'
import { buildNow, HELP_URL, invalidateMenu, startMenu, type MenuModel, type MenuToken } from './menu.ts'
import { crashReloaded, currentPill, onPillAction, setCondition, setPillPorts } from './pill.ts'
import {
  activate, activeTab, allTabs, applyRestore, canvasOrder, closeTab, cycleFrom, displayState, forDigit, getTab, guard,
  guardAll, isActive, keyOf, liveDoc, onCommit, onDocumentGone, onFail, onInPage, onRegistry, onReport, openSettingsTab,
  ordered, parseTabsFile, reopenTab, restorePlan, safePath, setTabsPorts, sheetText, snapshotFile, tabName,
  type GuardAction, type GuardAnswer, type Sheet, type Tab, type TabsFile,
} from './tabs.ts'
import {
  copyDetails, forgetTab, hangSheetText, onAttemptFailed, onLifted, onShown, personReload, recover, scheduleRetry, setTabpagePorts,
} from './tabpage.ts'
import {
  appPrefs, APP_ORIGIN, attachContent, compose, contentView, detachContent, hideWindow, mainWindow, onAppReady, openWindow,
  pageOf, pageView, sendPill, showWindow, stripContents, viewsNow, windowVisible,
} from './window.ts'
import { note, provide, testMode } from './testing/index.ts'
import { T } from './timings.ts'

export const PRELOAD_CANVAS = join(__dirname, 'preload-canvas.cjs')

/**
 * What the window stream needs from the trust stream (registry.ts, proof.ts, sessions.ts, bridge.ts, nav.ts), as
 * main.ts builds it from their frozen interfaces. A test build can stand a fake in (testing/fake-trust.ts).
 */
export interface TrustPort {
  /** the local partition, prepared (the dispatcher installed, service workers cleared) before its first navigation */
  session(ws: string): Promise<Session>
  /** the navigation adapter of a canvas webContents, its proof dispatcher attached */
  attach(wc: WebContents, tab: Tab): NavAdapter
  /** admit the tab's document at its trusted commit (v1.12 r1 #1): the `doc`, or null */
  admit(tabId: string): string | null
  register(wc: WebContents, kind: PageKind, tabId?: string): void
  entries(): RegistryEntry[]
  entryFor(t: Tab): RegistryEntry | undefined
  onRegistry(fn: (e: RegistryEvent) => void): () => void
  onReport(fn: (tabId: string, doc: string, r: CanvasReports) => void): () => void
}

export interface StartInput { trust: TrustPort; home: Home; files: Files; firstLaunch?: boolean }

const j = (topic: string, data: unknown) => { if (__MV_TEST__) note(topic, data) }

/** The app's keys on one view; the key harness's control case (test builds only) leaves the menu its key equivalents. */
const keys = (wc: WebContents) => attachKeys(wc, (c) => runCommand(c, 'key'),
  { prevent: !(__MV_TEST__ && testMode() && process.env.MARVER_APP_KEYS_NO_PREVENT === '1') })

let trust: TrustPort
let homeDir: Home
let quitting = false
const canvases = new Map<string, { view: WebContentsView; nav: NavAdapter; off: () => void }>()
const making = new Map<string, Promise<WebContentsView | null>>()
const unattributedTimers = new Map<string, ReturnType<typeof setTimeout>>()
let macModel: string | undefined

export const isQuitting = (): boolean => quitting

// ---------------------------------------------------------------------------------------------------------------
// Canvas views (A2.4: lazy, kept, never re-added)

async function ensureView(t: Tab): Promise<WebContentsView | null> {
  const have = canvases.get(t.id)
  if (have && !have.view.webContents.isDestroyed()) return have.view
  const pending = making.get(t.id)
  if (pending) return pending
  const p = (async () => {
    if (!t.reg) return null
    const ses = await trust.session(t.reg.ws)
    if (!getTab(t.id) || !t.reg) return null
    const view = new WebContentsView({ webPreferences: {
      session: ses, preload: PRELOAD_CANVAS, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false,
      spellcheck: false, focusOnNavigation: false, disableHtmlFullscreenWindowResize: true, disableDialogs: true,
    } })
    wireCanvas(t, view)
    attachContent(t.id, view, 'canvas')
    t.view = 'live'
    return view
  })().finally(() => making.delete(t.id))
  making.set(t.id, p)
  return p
}

const NO_DRAG = 'html, html * { app-region: no-drag !important; -webkit-app-region: no-drag !important }'

function wireCanvas(t: Tab, view: WebContentsView): void {
  const wc = view.webContents
  trust.register(wc, 'canvas', t.id)
  const nav = trust.attach(wc, t)
  const off = nav.on((e) => onNav(t, wc, e))
  canvases.set(t.id, { view, nav, off })
  wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) onInPage(t, url) })
  wc.on('render-process-gone', (_e, d) => {
    const app = !!t.appEnding
    j('gone', { tab: t.id, reason: d.reason, app })
    clearHang(t)
    recover(t, app ? { kind: 'app' } : { kind: 'crash', reason: d.reason, exitCode: d.exitCode })
    compose()
  })
  wc.on('unresponsive', () => onUnresponsive(t, wc))
  wc.on('responsive', () => { t.hung = false; clearHang(t); j('hang', { tab: t.id, responsive: true }); compose() })
  // HTML fullscreen stays in its view (disableHtmlFullscreenWindowResize): already below the strip in 0.1, nothing moves
  wc.on('enter-html-full-screen', () => { j('fullscreen', { tab: t.id, html: true }); compose() })
  wc.on('leave-html-full-screen', () => { j('fullscreen', { tab: t.id, html: false }); compose() })
  wc.on('destroyed', () => forgetCanvas(t, view))
  keys(wc)
  track(wc, { part: 'content', tab: t.id })
}

/** The view is gone (closed by the guard, or destroyed): out of the window, the tab documentless. */
function forgetCanvas(t: Tab, view: WebContentsView): void {
  const c = canvases.get(t.id)
  if (!c || c.view !== view) return
  canvases.delete(t.id)
  c.off()
  c.nav.dispose()
  detachContent(t.id)
  clearHang(t)
  if (getTab(t.id)) onDocumentGone(t, 'none')
  j('view', { tab: t.id, forgot: true })
  compose()
}

/** Load a documentless tab: its path on its bound origin (never guarded: there is nothing to lose). */
function load(t: Tab): void {
  if (!t.reg?.origin || t.reg.state !== 'ready') return
  t.needsLoad = false
  t.loadAt = Date.now()
  const url = t.reg.origin + safePath(t.path)
  void ensureView(t).then((v) => {
    if (!v || v.webContents.isDestroyed() || !getTab(t.id)) return
    j('load', { tab: t.id, url })
    void v.webContents.loadURL(url).catch(() => { /* the adapter's events carry the outcome */ })
    compose()
  })
  compose()
}

function onNav(t: Tab, wc: WebContents, e: NavEvent): void {
  if (!getTab(t.id)) return
  switch (e.kind) {
    case 'commit': {
      const admitted = e.attributed && t.reg?.state === 'ready' ? trust.admit(t.id) : null
      onCommit(t, { gen: e.gen, url: e.url, attributed: e.attributed, admitted })
      void wc.insertCSS(NO_DRAG, { cssOrigin: 'user' }).catch(() => {})
      if (t.doc?.lifted) { clearUnattributed(t); onLifted(t) }
      else scheduleUnattributed(t, wc)
      compose()
      return
    }
    case 'fail': {
      let errorPage = false
      try { errorPage = wc.mainFrame?.origin === 'null' } catch { /* the frame went */ }
      onFail(t, { why: e.why, code: e.code, errorPage })
      onAttemptFailed(t)
      scheduleRetry(t)
      compose()
      return
    }
    case 'abort': j('abort', { tab: t.id, gen: e.gen }); return
    default: return
  }
}

/** An unattributed commit: untrusted, beneath its tab page, never shown - reloaded at once, then on A2.3's schedule. */
function scheduleUnattributed(t: Tab, wc: WebContents): void {
  clearUnattributed(t)
  const n = t.unattributed ?? 1
  const delay = n <= 1 ? 0 : (T.retryMs[n - 2] ?? T.retryEveryMs)
  const commits = t.doc?.commits
  const x = setTimeout(() => {
    unattributedTimers.delete(t.id)
    if (!getTab(t.id) || wc.isDestroyed() || t.doc?.lifted || t.doc?.commits !== commits || !t.reg?.origin || t.reg.state !== 'ready') return
    j('load', { tab: t.id, unattributed: n })
    void wc.loadURL(t.reg.origin + safePath(t.path)).catch(() => {})
  }, delay)
  unattributedTimers.set(t.id, x)
}
function clearUnattributed(t: Tab): void { const x = unattributedTimers.get(t.id); if (x) clearTimeout(x); unattributedTimers.delete(t.id) }

// ---------------------------------------------------------------------------------------------------------------
// App views: Home, Settings

function makeAppView(t: Tab, page: 'home' | 'settings'): WebContentsView {
  const have = contentView(t.id)
  if (have && !have.webContents.isDestroyed()) return have
  const view = new WebContentsView({ webPreferences: appPrefs() })
  attachContent(t.id, view, page)   // registered with the bridge and wired (keys) by window.ts, as every app page
  track(view.webContents, { part: 'content', tab: t.id })
  t.view = 'live'
  void view.webContents.loadURL(`${APP_ORIGIN}${page}/`).catch(() => { /* served by sessions.ts */ })
  return view
}

/** Close a view that holds nothing to guard (Settings; a documentless canvas): no beforeunload asked. */
function forget(t: Tab): void {
  const c = canvases.get(t.id)
  if (c) { if (!c.view.webContents.isDestroyed()) c.view.webContents.close(); forgetCanvas(t, c.view); return }
  const v = contentView(t.id)
  if (v) { detachContent(t.id); if (!v.webContents.isDestroyed()) v.webContents.close() }
  t.view = 'none'
  forgetTab(t)
}

// ---------------------------------------------------------------------------------------------------------------
// The guard's act and sheet (A2.2, v1.12 r1 #3, v1.13 r2 #4)

const closeLike = (a: GuardAction) => a.kind === 'close' || a.kind === 'quit' || a.kind === 'update'

function act(t: Tab, a: GuardAction): Promise<GuardAnswer> {
  const c = canvases.get(t.id)
  const wc = c?.view.webContents
  if (!c || !wc || wc.isDestroyed()) {
    // no view: nothing to replace; a load makes one
    if (!closeLike(a) && t.reg?.origin) load(t)
    return Promise.resolve('done')
  }
  j('act', { tab: t.id, action: a.kind })
  return new Promise<GuardAnswer>((resolve) => {
    let settled = false
    const done = (r: GuardAnswer, why: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      wc.off('will-prevent-unload', onPrevent)
      if (!wc.isDestroyed()) wc.off('did-start-navigation', onStart)
      j('act', { tab: t.id, action: a.kind, answer: r, why })
      resolve(r)
    }
    // never preventDefault: the page's refusal stands (r2 #4: a best-effort extra veto)
    const onPrevent = () => done('refused', 'will-prevent-unload')
    const onStart = (d: { isMainFrame: boolean; isSameDocument: boolean }) => { if (d.isMainFrame) done('done', d.isSameDocument ? 'same-document' : 'navigation') }
    wc.on('will-prevent-unload', onPrevent)
    // Chromium goes on past a renderer that does not answer in time: the outcome comes as one of these events
    const timer = setTimeout(() => done('refused', 'timeout'), T.guardActMs)
    if (closeLike(a)) {
      wc.once('destroyed', () => done('done', 'destroyed'))
      wc.close({ waitForBeforeUnload: true })
      return
    }
    wc.on('did-start-navigation', onStart)
    const origin = t.reg?.origin
    switch (a.kind) {
      case 'reload': wc.reload(); break
      case 'forceReload': wc.reloadIgnoringCache(); break
      case 'tryAgain': if (origin) void wc.loadURL(origin + safePath(t.path)).catch(() => {}); else done('refused', 'no-origin'); break
      case 'load': void wc.loadURL(a.url).catch(() => {}); break
    }
  })
}

/** Sheets for test builds: answered by a hook (no automation presses a native sheet; A2.14 #22's `ask()` seam). */
type SheetMode = 'confirm' | 'cancel' | 'hold'
let sheetMode: SheetMode | null = null
const heldSheets: { sheet: unknown; answer: (ok: boolean) => void }[] = []
const sheetsShown: unknown[] = []

async function testSheet(sheet: unknown): Promise<boolean> {
  sheetsShown.push(sheet)
  j('sheet', sheet)
  if (sheetMode === 'confirm' || sheetMode === null) return true
  if (sheetMode === 'cancel') return false
  return new Promise<boolean>((answer) => heldSheets.push({ sheet, answer }))
}

/** A test build never puts a native sheet on the screen: its sheets are answered by the seam ('confirm' unless a case says). */
const seamed = (): boolean => __MV_TEST__ && (sheetMode !== null || testMode())

async function ask(s: Sheet): Promise<boolean> {
  const words = sheetText(s)
  if (__MV_TEST__ && seamed()) return testSheet({ kind: 'guard', action: s.action.kind, tabs: s.tabs.map((x) => x.id), ...words })
  const win = mainWindow()
  if (!win) return false
  const r = await dialog.showMessageBox(win, { type: 'warning', message: words.message, detail: words.detail, buttons: words.buttons, defaultId: 0, cancelId: 0, noLink: true })
  return r.response === 1
}

// ---------------------------------------------------------------------------------------------------------------
// Not responding (A2.11, A2.14 #22, v1.12 r1 #4)

interface Hang { commit: number; pid: number; since: number; answered: boolean; abort?: AbortController }
const hangs = new Map<string, Hang>()
let hangSheetOpen = false

function clearHang(t: Tab): void {
  const h = hangs.get(t.id)
  if (h) { h.abort?.abort(); hangs.delete(t.id) }
}

function onUnresponsive(t: Tab, wc: WebContents): void {
  if (wc.isDestroyed()) return
  t.hung = true
  const frame = wc.mainFrame
  const h: Hang = { commit: t.doc?.commits ?? 0, pid: frame.osProcessId, since: Date.now(), answered: false }
  hangs.set(t.id, h)
  j('hang', { tab: t.id, unresponsive: true, pid: h.pid })
  // the frame's own executeJavaScript does not wait for a load; it has no deadline of its own - main keeps one, 1 s
  void frame.executeJavaScript('0').then(() => {
    h.answered = true
    j('hang', { tab: t.id, answered: true })
    h.abort?.abort()
  }, () => {})
  compose()
}

interface ProcessSnapshot { pid: number; tabs: { id: string; commit: number; main: boolean }[] }

/** Every tab with any frame in the process (A2.11: another tab's iframe counts as much as its page). */
function processOf(pid: number): ProcessSnapshot {
  const tabs: ProcessSnapshot['tabs'] = []
  for (const [id, c] of canvases) {
    const wc = c.view.webContents
    if (wc.isDestroyed()) continue
    const t = getTab(id)
    if (!t) continue
    let frames: { osProcessId: number }[] = []
    try { frames = wc.mainFrame.framesInSubtree } catch { continue }
    if (!frames.some((f) => f.osProcessId === pid)) continue
    tabs.push({ id, commit: t.doc?.commits ?? 0, main: wc.mainFrame.osProcessId === pid })
  }
  return { pid, tabs }
}
const sameProcess = (a: ProcessSnapshot, b: ProcessSnapshot) => a.pid === b.pid && JSON.stringify(a.tabs) === JSON.stringify(b.tabs)

/** The pill's Reload on a page not responding: asks first, since it ends the page (frame 11). */
async function notResponding(t: Tab): Promise<void> {
  const h = hangs.get(t.id)
  if (!h || !t.hung) return
  const wait = h.since + T.hangProbeMs - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  if (h.answered || hangs.get(t.id) !== h) {
    // the main frame answered: the hang is in a frame of another process - nothing is ended; the guarded reload
    void guard(t, { kind: 'reload' })
    return
  }
  if (hangSheetOpen) return
  const snap = processOf(h.pid)
  const others = snap.tabs.filter((x) => x.id !== t.id).map((x) => tabName(getTab(x.id)!))
  const words = hangSheetText(t, others)
  hangSheetOpen = true
  const ac = new AbortController()
  h.abort = ac
  let reload = false
  try {
    if (__MV_TEST__ && seamed()) reload = await testSheet({ kind: 'hang', tab: t.id, others: snap.tabs.map((x) => x.id), ...words })
    else {
      const win = mainWindow()
      if (!win) return
      const r = await dialog.showMessageBox(win, { type: 'warning', message: words.message, detail: words.detail, buttons: words.buttons, defaultId: 0, cancelId: 0, noLink: true, signal: ac.signal })
      reload = r.response === 1 && !ac.signal.aborted
    }
  } finally { hangSheetOpen = false; h.abort = undefined }
  if (!reload) return
  // checked again before ending anything: the same frame, process and documents, still silent
  const now = processOf(h.pid)
  const c = canvases.get(t.id)
  const still = c && !c.view.webContents.isDestroyed() && c.view.webContents.mainFrame.osProcessId === h.pid
  if (!t.hung || h.answered || hangs.get(t.id) !== h || !still || t.doc?.commits !== h.commit || !sameProcess(now, snap)) {
    j('hang', { tab: t.id, recheck: 'changed' })
    if (t.hung && !h.answered && hangs.get(t.id) === h && still) return notResponding(t)   // the sheet again, with the new list
    return
  }
  for (const x of now.tabs) {
    const tab = getTab(x.id)!
    if (x.main) { tab.appEnding = true; tab.crash.inFlight = 'force' }
  }
  j('hang', { tab: t.id, ended: h.pid, tabs: now.tabs })
  c!.view.webContents.forcefullyCrashRenderer()   // once, through the tab whose main frame lives there
  for (const x of now.tabs) if (!x.main) canvases.get(x.id)?.view.webContents.reload()   // only a frame of it lived there
}

// ---------------------------------------------------------------------------------------------------------------
// Probes of a failed tab's address (A2.11, v1.14 r3 #4)

async function probe(t: Tab): Promise<'silent' | 'answers' | 'proved'> {
  if (!t.reg?.origin) return 'silent'
  const ses = await trust.session(t.reg.ws)
  const origin = t.reg.origin
  try {
    const r = await ses.fetch(`${origin}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(T.headTimeoutMs) })
    void r.body?.cancel().catch(() => {})
  } catch { return 'silent' }
  const e = trust.entryFor(t)
  if (!e) return 'answers'
  try {
    const nonce = randomBytes(24).toString('base64url')
    const r = await ses.fetch(`${origin}/`, { method: 'GET', redirect: 'manual', headers: { 'x-mv-nonce': nonce, 'x-mv-ws': e.ws }, signal: AbortSignal.timeout(T.headTimeoutMs) })
    void r.body?.cancel().catch(() => {})
    const want = Buffer.from(docProof(e.key, nonce, e.port))
    const got = Buffer.from(r.headers.get('x-mv-proof') ?? '')
    const ok = r.headers.get('x-mv-instance') === e.instance && got.length === want.length && timingSafeEqual(got, want)
    return ok ? 'proved' : 'answers'
  } catch { return 'answers' }
}

// ---------------------------------------------------------------------------------------------------------------
// Commands: one path for the keys and the menu (A2.4, A2.7, A2.14 #25)

function reloadActive(force: boolean): void {
  const t = activeTab()
  if (!t || t.kind !== 'local') return
  if (t.view === 'crashed' || t.crash.latched) { personReload(t); compose(); return }
  void guard(t, { kind: force ? 'forceReload' : 'reload' })
}

/** ⌘L: Home with its link field, `back` the tab it came from (A2.7). The home stream's page does the rest. */
let linkBack: string | undefined
function openLink(): void {
  const a = activeTab()
  if (a && a.kind !== 'home') linkBack = a.id
  else if (linkBack && !getTab(linkBack)) linkBack = undefined
  activate('home')
  const home = contentView('home')
  if (home) home.webContents.send('home:focus', { field: 'link', ...(linkBack ? { back: linkBack } : {}) })
}

export function runCommand(c: AppCommand, via: 'key' | 'menu'): void {
  j('command', { cmd: c, via })
  const win = mainWindow()
  const d = digitOf(c)
  if (d !== null) { const t = forDigit(d); if (t) { showWindow(); activate(t.id) } return }
  switch (c) {
    case 'home': showWindow(); activate('home'); return
    case 'open-link': showWindow(); openLink(); return
    case 'close-tab': { const t = activeTab(); if (t && t.kind !== 'home') void closeTab(t.id); return }
    case 'close-window': hideWindow(); return
    case 'reload': reloadActive(false); return
    case 'force-reload': reloadActive(true); return
    case 'settings': showWindow(); openSettingsTab(); return
    case 'quit': app.quit(); return
    case 'hide': app.hide(); return
    case 'hide-others': Menu.sendActionToFirstResponder('hideOtherApplications:'); return
    case 'minimize': win?.minimize(); return
    case 'fullscreen': win?.setFullScreen(!win.isFullScreen()); return
    case 'next-tab': case 'prev-tab': { const t = cycleFrom(activeTab()?.id ?? 'home', c === 'next-tab' ? 1 : -1); if (t) activate(t.id); return }
    case 'devtools': {
      const t = activeTab()
      const v = t ? (pageView(t.id) && !liveDoc(t) ? pageView(t.id) : contentView(t.id)) : undefined
      v?.webContents.openDevTools({ mode: 'detach' })
      return
    }
    case 'focus-strip': case 'focus-strip-back': f6(); return
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The app pages' messages: the bridge calls these once it has checked the sender (kind, main frame, own URL) and
// every field (channels.ts SENDERS). Each acts on main's own records alone.

const STATE_WORD: Record<string, string | undefined> = { starting: 'starting', gone: 'stopped', unverified: 'not a Marver canvas', unreachable: "can't reach", crashed: 'crashed' }

function tokenOf(t: Tab): MenuToken { return { tab: t.id, commit: t.doc?.commits ?? 0, trusted: !!t.doc?.trusted } }
function holds(k: MenuToken): boolean {
  const t = getTab(k.tab)
  return !!t && (t.doc?.commits ?? 0) === k.commit && !!t.doc?.trusted === k.trusted
}

function tabAct(k: MenuToken, what: 'activate' | 'open-browser' | 'reveal' | 'copy-link' | 'close' | 'mark-all-seen'): void {
  const t = getTab(k.tab)
  if (!t || !holds(k)) return
  // the people link (the slot file's `url`): what a browser opens and a person shares - never the bound origin
  const link = t.reg ? `http://localhost:${t.reg.port}${safePath(t.path)}` : undefined
  switch (what) {
    case 'activate': if (t.kind === 'local' && !t.open) reopenTab(t.id); else activate(t.id); return
    case 'open-browser': if (link && t.doc?.trusted) void shell.openExternal(link); return
    case 'reveal': if (t.root) shell.showItemInFolder(t.root); return
    case 'copy-link': if (link && t.doc?.trusted) clipboard.writeText(link); return
    case 'close': void closeTab(t.id); return
    case 'mark-all-seen': if (t.doc?.trusted) contentView(t.id)?.webContents.send('mv:menu-click', { id: 'mark-all-seen' }); return
  }
}

function popup(items: MenuItemConstructorOptions[], x: number, y: number): void {
  const win = mainWindow()
  if (!win || !items.length) return
  Menu.buildFromTemplate(items).popup({ window: win, x: Math.round(x), y: Math.round(y) })
}

export const pageHandlers = {
  /** `app:ready` */
  ready(wc: WebContents): void { onAppReady(wc) },
  /** `tab:activate { id }` (a closed canvas's Home card reopens it) */
  tabActivate(id: string): void {
    const t = getTab(id)
    if (!t) return
    if (t.kind === 'local' && !t.open) reopenTab(id)
    else activate(id)
  },
  /** `tab:close { id }` */
  tabClose(id: string): void { if (getTab(id)) void closeTab(id) },
  /** `tab:menu { id, x, y }`: the tab's right-click menu, built from main's record (A2.4, A2.7) */
  tabMenu(id: string, x: number, y: number): void {
    const t = getTab(id)
    if (!t) return
    const k = tokenOf(t)
    const items: MenuItemConstructorOptions[] = []
    if (t.kind === 'local') {
      items.push(
        { label: 'Open in Browser', enabled: !!t.doc?.trusted, click: () => tabAct(k, 'open-browser') },
        { label: 'Reveal in Finder', enabled: !!t.root, click: () => tabAct(k, 'reveal') },
        { label: 'Copy Local Link', enabled: !!t.doc?.trusted, click: () => tabAct(k, 'copy-link') },
        { label: 'Mark All as Seen', enabled: !!t.doc?.trusted, click: () => tabAct(k, 'mark-all-seen') },
        { type: 'separator' },
      )
    }
    if (t.kind !== 'home') items.push({ label: 'Close Tab', click: () => tabAct(k, 'close') })
    popup(items, x, y)
  },
  /** `tabs:more { ids, x, y }`: the tabs behind », each with its state, the active one checked (A2.14 #19) */
  tabsMore(ids: string[], x: number, y: number): void {
    const a = activeTab()
    const items = ids.map((id) => getTab(id)).filter((t): t is Tab => !!t).map((t): MenuItemConstructorOptions => {
      const word = STATE_WORD[displayState(t, t === a)]
      const k = tokenOf(t)
      return { label: word ? `${tabName(t)} - ${word}` : tabName(t), type: 'checkbox', checked: t === a, click: () => tabAct(k, 'activate') }
    })
    popup(items, x, y)
  },
  /** `pill:action { rev, act }` */
  pillAction(rev: number, act: 'button' | 'dismiss'): boolean { return onPillAction(rev, act) },
  /** `tabpage:action { rev, action }`: the view's own tab in main's map, never named by the page */
  tabpageAction(wc: WebContents, rev: number, action: TabPageAction): boolean {
    const pg = pageOf(wc)
    const t = pg ? getTab(pg.tab) : undefined
    if (!pg || !t || !pg.body || rev !== pg.rev) { j('tabpage', { refused: action, rev, latest: pg?.rev }); compose(); return false }
    const b = pg.body
    const offers: TabPageAction[] = b.page === 'stopped' ? (b.retained ? ['retry', 'copy-start', 'reveal', 'close'] : ['copy-start', 'reveal', 'close'])
      : b.page === 'unverified' ? ['retry', 'close']
        : b.page === 'unreachable' ? ['retry', 'close']
          : b.page === 'crashed' && b.latched ? ['reload', 'copy-details'] : []
    if (!offers.includes(action)) { j('tabpage', { refused: action, page: b.page }); return false }
    j('tabpage', { tab: t.id, action })
    switch (action) {
      case 'retry':
        // a page retained beneath: Try Again is the only way to replace it, through the guard (it asks first)
        if (t.retained && liveDoc(t)) void guard(t, { kind: 'tryAgain' })
        else load(t)
        return true
      case 'reload': personReload(t); compose(); return true
      case 'copy-start': if (t.root) clipboard.writeText(startCommand(t.root, homedir(), t.reg?.slot == null ? t.reg?.port : undefined).copy); return true
      case 'copy-details': clipboard.writeText(details(t)); return true
      case 'reveal': if (t.root) shell.showItemInFolder(t.root); return true
      case 'close': void closeTab(t.id); return true
      default: return false
    }
  },
}

function details(t: Tab): string {
  return copyDetails(t, {
    app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, marver: t.reg?.version,
    macos: process.getSystemVersion(), model: macModel, memGB: totalmem() / 2 ** 30,
  })
}

/** `mv:menu-click` for the active canvas's own items, only while its token holds. */
function canvasClick(k: MenuToken, id: string): void {
  const t = getTab(k.tab)
  if (!t || !holds(k) || !t.doc?.trusted || !t.reports.menu?.some((m: MenuItem) => m.id === id)) return
  contentView(t.id)?.webContents.send('mv:menu-click', { id })
  j('menu', { click: id, tab: t.id })
}

function menuModel(): MenuModel {
  const a = activeTab() ?? getTab('home')!
  const list = allTabs()
  const tabsList = ordered(list).map((t) => {
    const word = t.kind === 'local' ? STATE_WORD[displayState(t, t === a)] : undefined
    const key = t.kind === 'local' ? keyOf(t, list) : undefined
    return { id: t.id, name: tabName(t), ...(word ? { word } : {}), ...(key ? { key } : {}), active: t === a, token: tokenOf(t) }
  })
  const trusted = a.kind === 'local' && !!a.doc?.trusted
  return {
    active: { id: a.id, kind: a.kind, name: tabName(a), token: tokenOf(a), trusted, canClose: a.kind !== 'home', canReload: a.kind === 'local' },
    canvas: trusted && a.reports.menu?.length ? { token: tokenOf(a), items: a.reports.menu } : null,
    tabs: tabsList,
    header: Number(process.getSystemVersion().split('.')[0]) >= 14,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// tabs.json (v1.12 r1 #5): read once, written whole on change, debounced 1 s

let tabsFile: TabsFile | null = null
let saveTimer: ReturnType<typeof setTimeout> | undefined

function tabsPath(): string { return join(homeDir.state, 'tabs.json') }

function readTabsFile(): TabsFile | null {
  if (!homeDir.writable && !existsSync(tabsPath())) return null
  let raw: string
  try { raw = readFileSync(tabsPath(), 'utf8') } catch { return null }
  let parsed: TabsFile | null = null
  try { parsed = parseTabsFile(JSON.parse(raw)) } catch { parsed = null }
  if (!parsed) {
    // the last bad one kept aside; the app goes on as if it were empty (A2.12)
    try { renameSync(tabsPath(), `${tabsPath()}.bad`) } catch { /* unwritable: nothing to keep */ }
    j('tabs.json', { bad: true })
  }
  return parsed
}

export function writeTabsNow(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined }
  if (!homeDir?.writable) return
  const file = snapshotFile(tabsFile, Date.now())
  tabsFile = file
  try {
    mkdirSync(homeDir.state, { recursive: true, mode: 0o700 })
    const tmp = `${tabsPath()}.${randomBytes(6).toString('hex')}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try { writeSync(fd, JSON.stringify(file, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, tabsPath())
  } catch (err) {
    j('tabs.json', { writeFailed: (err as NodeJS.ErrnoException).code })
    setCondition('files', { lead: 'Files not saved', text: '', short: 'Files not saved', tooltip: 'The app could not write ~/.marver/state' })
  }
}

function saveSoon(): void {
  if (saveTimer || quitting) return
  saveTimer = setTimeout(() => { saveTimer = undefined; writeTabsNow() }, T.stateDebounceMs)
  ;(saveTimer as { unref?: () => void }).unref?.()
}

// ---------------------------------------------------------------------------------------------------------------
// Start, and the quit

export function startViews(i: StartInput): void {
  trust = i.trust
  homeDir = i.home
  const home = homedir()
  const sendState = (t: Tab, s: AppState) => {
    const wc = contentView(t.id)?.webContents
    if (wc && !wc.isDestroyed() && canvases.has(t.id)) wc.send('mv:app-state', s)
  }
  setTabsPorts({
    now: () => Date.now(), home, appDark: () => nativeTheme.shouldUseDarkColors,
    changed: (o) => { ensureAppViews(); compose(o) }, load, appState: sendState, act, ask, forget, save: saveSoon,
    shown: (t) => onShown(t), log: j,
  })
  setTabpagePorts({
    now: () => Date.now(), isActive, changed: () => compose(), log: j, load,
    reload: (t) => {
      // the reload after a crash: rebuilt from the bound origin and the saved path, in its own view (a new renderer)
      if (!t.reg?.origin) return
      const url = t.reg.origin + safePath(t.path)
      void ensureView(t).then((v) => { if (v && !v.webContents.isDestroyed()) void v.webContents.loadURL(url).catch(() => {}) })
    },
    confirmed: (t) => crashReloaded(t),
    probe,
  })
  setPillPorts({
    now: () => Date.now(), home, visible: windowVisible, send: sendPill, log: j,
    copyStart: (t) => { if (t.root) clipboard.writeText(startCommand(t.root, home, t.reg?.slot == null ? t.reg?.port : undefined).copy) },
    notResponding: (t) => { void notResponding(t) },
  })

  openWindow({
    register: (wc, kind, tabId) => trust.register(wc, kind, tabId),
    wire: (wc) => keys(wc),
    quitting: () => quitting,
  })

  // restore (v1.12 r1 #5): only the active tab loads; the others when first shown
  tabsFile = i.files.config.restoreTabs ? readTabsFile() : null
  const plan = restorePlan(tabsFile, trust.entries(), { restore: i.files.config.restoreTabs, firstLaunch: !!i.firstLaunch })
  applyRestore(plan)
  ensureAppViews()
  trust.onRegistry((e) => onRegistry(e))
  for (const entry of trust.entries()) onRegistry({ kind: 'entry', entry })
  trust.onReport((tabId, doc, r) => { onReport(tabId, doc, { busy: r.busy, theme: r.theme, menu: r.menu }); invalidateMenu() })

  startMenu({
    model: menuModel,
    apply: (t) => Menu.setApplicationMenu(Menu.buildFromTemplate(t)),
    acts: {
      run: (c) => runCommand(c, 'menu'), holds, canvasClick,
      tab: (k, what) => tabAct(k, what),
      help: () => { void shell.openExternal(HELP_URL) },
      perfFiles: () => { void shell.openPath(join(homeDir.dir, 'perf')) },
      rebuild: () => buildNow(true),
    },
  })

  activate(activeTab()?.id ?? 'home')

  // the window shows when the strip has loaded, or after 300 ms - its ground is there either way, never white
  const strip = stripContents()
  let shown = false
  const show = () => {
    if (shown) return
    shown = true
    const inactive = __MV_TEST__ && process.env.MARVER_APP_TEST === '1' && process.env.MARVER_APP_SHOW !== 'focus'
    showWindow({ focus: !inactive })
    compose({ focus: 'shown' })
  }
  strip?.once('did-finish-load', show)
  strip?.once('did-fail-load', show)
  setTimeout(show, 300)

  app.on('activate', () => showWindow())   // the Dock icon
  powerMonitor.on('resume', () => { for (const t of allTabs()) if (t.fail) scheduleRetry(t, { now: true }) })
  execFile('/usr/sbin/sysctl', ['-n', 'hw.model'], { timeout: 2000 }, (err, out) => { if (!err) macModel = String(out).trim() })

  // ⌘Q, the menu, the Dock: every canvas tab through guardAll (A2.2, v1.13 r2 #2, v1.14 r3 #1)
  let quitInFlight = false
  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    if (quitInFlight) return
    quitInFlight = true
    writeTabsNow()   // the session as the quit starts
    j('quit', { asked: true })
    void guardAll({ kind: 'quit' }).then((r) => {
      quitInFlight = false
      j('quit', { answer: r })
      if (r !== 'done') return   // the quit is cancelled; a refused quit is never retried by itself
      quitting = true
      writeTabsNow()
      app.quit()
    })
  })

  if (__MV_TEST__) testHooks()
}

/** Home's view always, Settings' while its tab is open (⌘, makes the tab; this its view). */
function ensureAppViews(): void {
  for (const page of ['home', 'settings'] as const) {
    const t = getTab(page)
    if (t && !contentView(page)) makeAppView(t, page)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Test hooks (dev builds, MARVER_APP_TEST=1)

function tabDump(t: Tab) {
  return {
    id: t.id, kind: t.kind, name: tabName(t), open: t.open, view: t.view, retained: t.retained, path: t.path,
    state: displayState(t, t === activeTab()), reg: t.reg ? { state: t.reg.state, instance: t.reg.instance, origin: t.reg.origin, port: t.reg.port, slot: t.reg.slot } : null,
    doc: t.doc ? { ...t.doc } : null, reports: { ...t.reports }, crash: { ...t.crash }, fail: t.fail ?? null, probe: t.probe ?? null,
    hung: !!t.hung, held: t.held ?? null, replacing: !!t.replacing, key: keyOf(t), look: t.look ?? null,
    hasView: canvases.has(t.id) || !!contentView(t.id), wcId: contentView(t.id)?.webContents.id ?? null, pageView: !!pageView(t.id),
  }
}

function wcOf(target: string): WebContents | undefined {
  if (target === 'strip') return stripContents()
  const [id, part] = target.split(':')
  return part === 'page' ? pageView(id!)?.webContents : contentView(id!)?.webContents
}

function testHooks(): void {
  const arg = <T>(a: unknown) => (a ?? {}) as T
  provide('state', () => ({
    active: activeTab()?.id, tabs: allTabs().map(tabDump), order: ordered().map((t) => t.id), canvases: canvasOrder().map((t) => t.id),
    pill: currentPill(), focus: focusOwner(), quitting,
  }))
  provide('views', () => viewsNow())
  provide('window', () => {
    const w = mainWindow()
    return w ? { bounds: w.getBounds(), content: w.getContentBounds(), fullScreen: w.isFullScreen(), visible: w.isVisible(), focused: w.isFocused(), minimized: w.isMinimized() } : null
  })
  provide('activate', (a) => { activate(arg<{ id: string }>(a).id); return true })
  provide('command', (a) => { runCommand(arg<{ cmd: AppCommand }>(a).cmd, 'menu'); return true })
  provide('close', async (a) => closeTab(arg<{ id: string }>(a).id))
  provide('guard', async (a) => { const { id, action } = arg<{ id: string; action: GuardAction }>(a); const t = getTab(id); return t ? guard(t, action) : 'no-tab' })
  provide('guardAll', async (a) => guardAll(arg<{ action: { kind: 'quit' | 'update' } }>(a).action))
  provide('sheet', (a) => { sheetMode = arg<{ mode: SheetMode | null }>(a).mode; return true })
  provide('sheet:answer', (a) => { const h = heldSheets.shift(); if (!h) return false; h.answer(arg<{ ok: boolean }>(a).ok); return true })
  provide('sheets', () => ({ shown: [...sheetsShown], held: heldSheets.length }))
  // the page reloading itself (A1's resume reload): main's own reload, around the guard - as the page's would be
  provide('reloadPage', (a) => { const wc = wcOf(arg<{ target: string }>(a).target); if (!wc) return false; wc.reload(); return true })
  provide('crash', (a) => { const wc = wcOf(arg<{ target: string }>(a).target); if (!wc) return false; wc.forcefullyCrashRenderer(); return true })
  provide('exec', async (a) => { const { target, js, gesture } = arg<{ target: string; js: string; gesture?: boolean }>(a); const wc = wcOf(target); return wc ? wc.executeJavaScript(js, !!gesture) : null })
  provide('focused', () => {
    const out: string[] = []
    const s = stripContents()
    if (s?.isFocused()) out.push('strip')
    for (const t of allTabs()) {
      if (contentView(t.id)?.webContents.isFocused()) out.push(`${t.id}:view`)
      if (pageView(t.id)?.webContents.isFocused()) out.push(`${t.id}:page`)
    }
    return { focused: out, owner: focusOwner() }
  })
  provide('key', (a) => {
    const { target, keyCode, modifiers } = arg<{ target: string; keyCode: string; modifiers?: ('meta' | 'shift' | 'alt' | 'control')[] }>(a)
    const wc = wcOf(target)
    if (!wc) return false
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: modifiers ?? [] })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: modifiers ?? [] })
    return true
  })
  provide('click', (a) => {
    const { target, x, y } = arg<{ target: string; x?: number; y?: number }>(a)
    const wc = wcOf(target)
    if (!wc) return false
    const at = { x: x ?? 40, y: y ?? 40 }
    wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
    return true
  })
  provide('pageReady', (a) => { const wc = wcOf(arg<{ target: string }>(a).target); if (!wc) return false; onAppReady(wc); return true })
  provide('pill:raise', (a) => { const { kind, ...c } = arg<{ kind: 'files' | 'test'; text: string; short: string; lead?: string; dismissible?: boolean }>(a); setCondition(kind, c.text ? c : null); return currentPill() })
  provide('pill:action', (a) => { const { rev, act } = arg<{ rev: number; act: 'button' | 'dismiss' }>(a); return onPillAction(rev, act) })
  provide('tabpage:action', (a) => {
    const { tab, rev, action } = arg<{ tab: string; rev?: number; action: TabPageAction }>(a)
    const wc = pageView(tab)?.webContents
    if (!wc) return false
    return pageHandlers.tabpageAction(wc, rev ?? pageOf(wc)!.rev, action)
  })
  provide('page', (a) => { const wc = pageView(arg<{ tab: string }>(a).tab)?.webContents; return wc ? pageOf(wc) : null })
  provide('show', (a) => { showWindow({ focus: arg<{ focus?: boolean }>(a).focus }); return true })
  provide('hide', () => { hideWindow(); return true })
  // kept above other windows without taking the keyboard: Chromium tells an occluded page nothing (its hang
  // monitor's 'unresponsive' needs the contents visible)
  provide('onTop', (a) => { const win = mainWindow(); if (!win) return false; const on = !!arg<{ on: boolean }>(a).on; win.setAlwaysOnTop(on, 'floating'); if (on) win.showInactive(); return true })
  provide('resize', (a) => { const { width, height } = arg<{ width: number; height: number }>(a); mainWindow()?.setContentSize(width, height); return true })
  provide('fullscreen', (a) => { mainWindow()?.setFullScreen(!!arg<{ on: boolean }>(a).on); return true })
  provide('menu', () => menuModel())
  // the application menu as built: each item's id, label, type, checked, enabled and accelerator
  const dump = (m: Electron.Menu | null): unknown[] => (m?.items ?? []).map((i) => ({
    id: i.id || undefined, label: i.label, type: i.type, checked: i.checked, enabled: i.enabled, accelerator: i.accelerator ?? undefined,
    ...(i.submenu ? { submenu: dump(i.submenu) } : {}),
  }))
  const held = new Map<string, Electron.MenuItem>()
  provide('menu:items', () => { buildNow(); return dump(Menu.getApplicationMenu()) })
  // keep an item as built now, to click it later (a stale callback, v1.10 r1 #10)
  provide('menu:hold', (a) => { const id = arg<{ id: string }>(a).id; const it = Menu.getApplicationMenu()?.getMenuItemById(id); if (it) held.set(id, it); return !!it })
  provide('menu:click', (a) => {
    const { id, stale } = arg<{ id: string; stale?: boolean }>(a)
    const it = stale ? held.get(id) : Menu.getApplicationMenu()?.getMenuItemById(id)
    if (!it) return false
    it.click()
    return true
  })
  provide('writeTabs', () => { writeTabsNow(); return tabsFile })
  provide('settings:open', () => { openSettingsTab(); return true })
}
