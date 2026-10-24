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
 *
 * A3 (app 0.2, A3.8 #53) is wired here, each stream filling its own modules: the recorder's ports (recorder.ts:
 * `watchCanvas` first in wireCanvas, `processGone` before recover(), `shown` with `mv:app-state shown`,
 * `tabsChanged` after each compose, `markFlash` from runCommand); the layout's events (layout.ts: a main-frame
 * navigation's start and abort, HTML fullscreen); the presentation (present.ts: its answers from the bridge, its
 * requests through window.ts, the GPU process lost); the unload's act (`act(t, { kind: 'unload' })`, its renderer
 * gone and its `destroyed` in forgetCanvas, the reopen's load) and the fields its admission reads (audible, DevTools
 * open, a navigation under way).
 */
import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import { app, dialog, Menu, nativeTheme, powerMonitor, shell, WebContentsView, type MenuItemConstructorOptions, type Session, type WebContents, type WebPreferences } from 'electron'
import * as sessions from './sessions.ts'
import { CH, type PageKind, type TabPageAction } from '../shared/channels.ts'
import { startCommand } from '../shared/command.ts'
import { effects, provideEffectHooks } from './effects.ts'
import type { AppState, MenuItem, Present, Presented } from '../../../src/shared/app-api.ts'
import { docProof } from '../../../src/server/proof.ts'
import type { Files, Home } from './config.ts'
import type { CanvasReports } from './bridge.ts'
import type { NavAdapter, NavEvent } from './nav.ts'
import type { RegistryEntry, RegistryEvent } from './registry.ts'
import { mainFrameOf, safely } from './frames.ts'
import { attachKeys, digitOf, type AppCommand } from './keys.ts'
import { focusOwner, f6, track } from './focus.ts'
import { buildNow, HELP_URL, invalidateMenu, startMenu, type MenuModel, type MenuToken } from './menu.ts'
import { crashReloaded, currentPill, onPillAction, setCondition, setPillPorts } from './pill.ts'
import {
  activate, activeTab, allTabs, applyRestore, canvasOrder, closeTab, cycleFrom, displayState, forDigit, getTab, guard,
  guardAll, hasBridge, hashOnly, isActive, keyOf, liveDoc, onCommit, onDocumentGone, onFail, onInPage, onRegistry, onReport, onUnloaded, openSettingsTab,
  ordered, parseTabsFile, reopenTab, restorePlan, safePath, savedPathIn, setTabsPorts, sheetBox, sheetConfirmed, sheetText, snapshotFile, tabName,
  type GuardAction, type GuardAnswer, type Sheet, type Tab, type TabsFile,
} from './tabs.ts'
import {
  copyDetails, forgetTab, hangDecision, hangSheetText, onAttemptFailed, onLifted, onShown, onViewClosed, personReload, recover,
  reloadIsPersons, scheduleRetry, setTabpagePorts, type ProcessSnapshot,
} from './tabpage.ts'
import {
  appPrefs, APP_ORIGIN, attachContent, captureWindow, compose, contentView, detachContent, hideWindow, mainWindow, onAppReady, openWindow,
  pageOf, pageView, sendHeld, sendPill, showWindow, stripContents, viewsNow, windowVisible,
} from './window.ts'
import { note, provide, testMode } from './testing/index.ts'
import { T } from './timings.ts'
import { commitLayout } from './layout.ts'
import { answer as presentAnswer, forget as presentForget, gpuGone, noteGpu } from './present.ts'
import { gpuIdentity, recorder, sampler } from './recorder.ts'
import { lastPressure } from './pressure.ts'

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
  /** `mv:app-state` to the tab's admitted, trusted document (stamped with its `doc`); `untrusted` is the bridge's own */
  appState(tabId: string, s: AppState): boolean
  /** `mv:menu-click` to the tab's admitted, trusted document, for an item its last `mv:menu` offers */
  menuClick(tabId: string, id: string): boolean
  /** the tab's next `mv:doc` answers `{ reopen: true }`, once (`recover`'s reload, A2.14 #9) */
  reopenNext(tabId: string): void
  /** what answers on a failed tab's address (v1.14 r3 #4); views.ts probes by itself without it */
  probe?(t: Tab): Promise<'silent' | 'answers' | 'proved'>
  /**
   * the tab's logo, proved like the document (A2.4): a checked `data:` URL, or null. `signal` aborts it when a newer
   * fetch starts or the tab navigates or closes (proof.ts `fetchLogo(entry, signal)`)
   */
  fetchLogo?(t: Tab, signal: AbortSignal): Promise<string | null>
  /** the bridge's app-page plumbing (A2.14 #19): when present, the window stream's handlers are mounted on it */
  pages?: {
    onReady(fn: (wc: WebContents) => void): void
    handle(channel: string, fn: (wc: WebContents, payload: unknown) => unknown): void
    send(wc: WebContents, channel: string, payload: unknown): boolean
  }
  /** A3: `mv:present` to the tab's document `doc` while admitted and trusted (bridge.ts `present`; A3.8 #27) */
  present?(tabId: string, doc: string, r: Present): boolean
  /** A3: accepted `mv:presented` answers (bridge.ts `onPresented`) */
  onPresented?(fn: (tabId: string, doc: string, r: Presented) => void): () => void
}

/**
 * What the window stream tells Home's main side (the home-and-files stream's home.ts, its `HomePorts` in ports.ts):
 * Home's first load while it is the active tab (the first-launch marker), a canvas verified - its first trusted
 * commit on an instance, for Recently here (ports.ts lists it as the trust stream's; calling it twice is harmless) -
 * a canvas gone, and the quit once it is sure. main.ts wires these to noteHomeShown, noteVerified, noteGone and
 * flushRecent once the streams meet.
 */
export interface HomeNotes {
  homeShown(): void
  verified(c: { ws: string; root: string; name: string; origin: string; slot: number | null; port: number }): void
  gone(ws: string): void
  /** the quit, once guardAll answered 'done', before app.quit(): every canvas still running seen now */
  quitting?(running: string[]): void
}

/**
 * tabs.json's one reader and one writer. ports.ts makes it config.ts's (`readTabsFile`, `tabsWriter`): tabs.ts decides
 * what goes in it and writes nothing itself. Until the streams meet, views.ts's own store stands in (a whole write,
 * debounced 1 s, a bad file set aside as tabs.json.bad).
 */
export interface TabsStore {
  /** undefined when absent; a bad one is set aside */
  read(): TabsFile | undefined
  /** the latest state, written debounced */
  set(file: TabsFile): void
  /** what waits, written now (the quit) */
  flushSync(): void
}

export interface StartInput { trust: TrustPort; home: Home; files: Files; firstLaunch?: boolean; notes?: HomeNotes; tabsStore?: TabsStore }

const j = (topic: string, data: unknown) => { if (__MV_TEST__) note(topic, data) }

/**
 * The window shown and in front: a refused quit's tab, a sheet. A test run shows it without taking the keyboard
 * from whoever is at the Mac (as at launch), unless the case asks for focus.
 */
function forward(): void {
  const inactive = __MV_TEST__ && testMode() && process.env.MARVER_APP_SHOW !== 'focus'
  if (windowVisible() && (inactive || mainWindow()?.isFocused())) return
  showWindow({ focus: !inactive })
}

/** The app's keys on one view; the key harness's control case (test builds only) leaves the menu its key equivalents. */
const keys = (wc: WebContents) => attachKeys(wc, (c) => runCommand(c, 'key'),
  { prevent: !(__MV_TEST__ && testMode() && process.env.MARVER_APP_KEYS_NO_PREVENT === '1') })

let trust: TrustPort
let homeDir: Home
let notes: HomeNotes | undefined
/** the instance each tab was last noted verified on: Recently here hears once per instance */
const notedVerified = new Map<string, string>()
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
    // closed (⌘W) or gone while its partition was prepared: no view - the close saw none to guard, so one made now
    // would load hidden and keep a document nobody asked for
    if (!getTab(t.id) || !t.reg || !t.open) { j('view', { tab: t.id, abandoned: true }); return null }
    // sessions.ts's canvasWebPreferences(ws) when the trust stream provides it (the one place it writes them; its
    // partition is the session just prepared), else the same rules written here
    const fromTrust = (sessions as { canvasWebPreferences?: (ws: string) => WebPreferences }).canvasWebPreferences
    const prefs: WebPreferences = fromTrust
      ? { ...fromTrust(t.reg.ws), spellcheck: false, focusOnNavigation: false, disableHtmlFullscreenWindowResize: true, disableDialogs: true }
      : { session: ses, preload: PRELOAD_CANVAS, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false,
          spellcheck: false, focusOnNavigation: false, disableHtmlFullscreenWindowResize: true, disableDialogs: true }
    const view = new WebContentsView({ webPreferences: prefs })
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
  recorder.watchCanvas(t, wc)
  trust.register(wc, 'canvas', t.id)
  const nav = trust.attach(wc, t)
  const off = nav.on((e) => onNav(t, wc, e))
  canvases.set(t.id, { view, nav, off })
  wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) onInPage(t, url) })
  wc.on('render-process-gone', (_e, d) => {
    // an unload's own end, or a crash while it closes: ours, counting nothing, the tab ends unloaded (A3.8 #39, #44)
    if (unloadGone(t, wc, d)) return
    const app = !!t.appEnding
    j('gone', { tab: t.id, reason: d.reason, app })
    recorder.processGone(t, d, app)
    clearHang(t)
    recover(t, app ? { kind: 'app' } : { kind: 'crash', reason: d.reason, exitCode: d.exitCode })
    compose()
  })
  wc.on('unresponsive', () => onUnresponsive(t, wc))
  wc.on('responsive', () => { t.hung = false; clearHang(t); j('hang', { tab: t.id, responsive: true }); compose() })
  // HTML fullscreen stays in its view (disableHtmlFullscreenWindowResize); from A3 layout.ts places it below the strip
  wc.on('enter-html-full-screen', () => { j('fullscreen', { tab: t.id, html: true }); commitLayout(t, { kind: 'html-fullscreen', on: true }); compose() })
  wc.on('leave-html-full-screen', () => { j('fullscreen', { tab: t.id, html: false }); commitLayout(t, { kind: 'html-fullscreen', on: false }); compose() })
  // what an unload's admission reads (A3.8 #40): a page playing sound, DevTools open
  wc.on('audio-state-changed', (e) => { t.audible = e.audible })
  wc.on('devtools-opened', () => { t.devtools = true })
  wc.on('devtools-closed', () => { t.devtools = false })
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
  abortLogo(t)
  presentForget(t.id)
  t.audible = false
  t.devtools = false
  t.loading = false
  if (getTab(t.id)) {
    // an unload's close ended at destroyed: the tab is unloaded, never crashed nor documentless (A3.8 #39)
    if (t.unload && (t.unload.phase === 'closing' || t.unload.phase === 'unsure')) onUnloaded(t)
    else { onDocumentGone(t, 'none'); onViewClosed(t) }
  }
  j('view', { tab: t.id, forgot: true })
  compose()
}

/** Load a documentless tab: its path on its bound origin (never guarded: there is nothing to lose). */
function load(t: Tab): void {
  if (!t.reg?.origin || t.reg.state !== 'ready') return
  beginReopen(t)
  t.needsLoad = false
  t.loadAt = Date.now()
  clearUnattributed(t)   // this load replaces the reload an unattributed commit had waiting
  const url = t.reg.origin + safePath(t.path)
  void ensureView(t).then((v) => {
    if (!v || v.webContents.isDestroyed() || !getTab(t.id) || !t.open) return
    j('load', { tab: t.id, url })
    void v.webContents.loadURL(url).catch(() => { /* the adapter's events carry the outcome */ })
    compose()
  })
  compose()
}

function onNav(t: Tab, wc: WebContents, e: NavEvent): void {
  if (!getTab(t.id)) return
  switch (e.kind) {
    case 'start': {
      // a main-frame, cross-document navigation: under way until it commits, fails or aborts (A3.8 #40); its
      // layout pending, a documentless view pre-sized (A3.8 #24)
      t.loading = true
      if (commitLayout(t, { kind: 'start', gen: e.gen })) compose()
      return
    }
    case 'commit': {
      t.loading = false
      const admitted = e.attributed && t.reg?.state === 'ready' ? trust.admit(t.id) : null
      // the tab navigated: a logo fetch in flight is aborted (A2.4); one the lift starts again for the new document
      const logoWas = abortLogo(t)
      // the committed URL with its hash (the adapter's has none): the tab's path keeps the board a restore opened
      const href = safely(() => wc.isDestroyed() ? undefined : wc.getURL())
      onCommit(t, { gen: e.gen, url: e.url, ...(href ? { href } : {}), attributed: e.attributed, admitted, ...(e.instance ? { instance: e.instance } : {}) })
      void wc.insertCSS(NO_DRAG, { cssOrigin: 'user' }).catch(() => {})
      if (t.doc?.lifted) {
        clearUnattributed(t)
        onLifted(t)
        if (logoWas) refreshLogo(t)
        const r = t.reg
        if (r?.origin && t.root && notedVerified.get(t.id) !== r.instance) {
          notedVerified.set(t.id, r.instance)
          notes?.verified({ ws: r.ws, root: t.root, name: t.name, origin: r.origin, slot: r.slot, port: r.port })
        }
      } else scheduleUnattributed(t, wc)
      compose()
      return
    }
    case 'fail': {
      t.loading = false
      let errorPage = false
      try { errorPage = wc.mainFrame?.origin === 'null' } catch { /* the frame went */ }
      abortLogo(t)
      onFail(t, { why: e.why, code: e.code, errorPage, gen: e.gen })
      onAttemptFailed(t)
      scheduleRetry(t)
      compose()
      return
    }
    case 'abort': {
      t.loading = false
      j('abort', { tab: t.id, gen: e.gen })
      if (commitLayout(t, { kind: 'abort', gen: e.gen })) compose()
      return
    }
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
  if (page === 'home') view.webContents.once('did-finish-load', () => { homeLoaded = true; noteHome() })
  // its renderer went (memory pressure, a crash): the page comes back, as the strip does (window.ts) - it says
  // app:ready again and is sent everything
  view.webContents.on('render-process-gone', (_e, d) => {
    j('app-page', { page, gone: d.reason })
    setTimeout(() => { if (!view.webContents.isDestroyed() && contentView(t.id) === view) void view.webContents.loadURL(`${APP_ORIGIN}${page}/`).catch(() => {}) }, 0)
  })
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
    // no view: nothing to replace; a load makes one (an unload has nothing to close)
    if (!closeLike(a) && a.kind !== 'unload' && t.reg?.origin) load(t)
    return Promise.resolve('done')
  }
  if (a.kind === 'unload') return actUnload(t, wc, a)
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
    // the act happened when the new document's navigation starts. A same-document start is the page's own hash or
    // history.replaceState (the shell writes the camera so) while beforeunload is still being asked - not the act -
    // except a load whose own URL turned out to be the same document
    const onStart = (d: { isMainFrame: boolean; isSameDocument: boolean; url: string }) => {
      if (!d.isMainFrame) return
      if (!d.isSameDocument) done('done', 'navigation')
      else if (a.kind === 'load' && d.url === a.url) done('done', 'same-document')
    }
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

// ---- the unload's act (A2.6, A3.8 #39, #42, #43): the unloading stream's to fill -----------------------------------

/**
 * `act(t, { kind: 'unload' })`: `close({ waitForBeforeUnload: true })`, owning the tab until `destroyed` (the tab
 * unloaded, forgetCanvas -> onUnloaded) or the page's refusal (`will-prevent-unload`, never prevented: kept). Past
 * `unloadActMs` with neither, `unsure`: main ends the close with a plain `close()`, and then only `destroyed` ends it.
 * Never `forcefullyCrashRenderer()`: a renderer shared with another tab lives on.
 */
function actUnload(t: Tab, wc: WebContents, a: Extract<GuardAction, { kind: 'unload' }>): Promise<GuardAnswer> {
  void wc
  j('act', { tab: t.id, action: a.kind, answer: 'refused', why: 'not built' })
  return Promise.resolve('refused')   // A3 unloading stream
}

/** A render-process-gone while an unload closes the tab: ours, counted nothing, the close finished (A3.8 #39, #44); true when it was. */
function unloadGone(t: Tab, wc: WebContents, d: Electron.RenderProcessGoneDetails): boolean {
  void t; void wc; void d
  return false   // A3 unloading stream
}

/** load() of an unloaded tab: the reopen - `mv:doc` answers `reopen: true`, the tab page says `reopening` (A3.8 #43). */
function beginReopen(t: Tab): void { void t }   // A3 unloading stream

/** Sheets for test builds: answered by a hook (no automation presses a native sheet; A2.14 #22's `ask()` seam). */
type SheetMode = 'confirm' | 'cancel' | 'hold' | 'throw'
let sheetMode: SheetMode | null = null
const heldSheets: { sheet: unknown; answer: (ok: boolean) => void }[] = []
const sheetsShown: unknown[] = []

async function testSheet(sheet: unknown, signal?: AbortSignal): Promise<boolean> {
  sheetsShown.push(sheet)
  j('sheet', sheet)
  if (sheetMode === 'confirm' || sheetMode === null) return true
  if (sheetMode === 'cancel') return false
  // a sheet that throws (the quit's error case): what an exception in the guard's wait does to its caller
  if (sheetMode === 'throw') throw new Error('mv-test: the sheet threw')
  // held until the case answers - or closed by its signal, as showMessageBox closes a native sheet (the hang sheet)
  return new Promise<boolean>((answer) => {
    const h = { sheet, answer: (ok: boolean) => { signal?.removeEventListener('abort', onAbort); answer(ok) } }
    const onAbort = () => {
      const i = heldSheets.indexOf(h)
      if (i >= 0) heldSheets.splice(i, 1)
      j('sheet', { closed: 'signal' })
      answer(false)
    }
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    heldSheets.push(h)
  })
}

/** A test build never puts a native sheet on the screen: its sheets are answered by the seam ('confirm' unless a case says). */
const seamed = (): boolean => __MV_TEST__ && (sheetMode !== null || testMode())

async function ask(s: Sheet): Promise<boolean> {
  const words = sheetText(s)
  // a sheet on a hidden window is a question nobody sees (a quit from the Dock, the menu's Close Tab after ⇧⌘W)
  forward()
  if (__MV_TEST__ && seamed()) return testSheet({ kind: 'guard', action: s.action.kind, tabs: s.tabs.map((x) => x.id), ...words })
  const win = mainWindow()
  if (!win) return false
  const r = await dialog.showMessageBox(win, sheetBox(words))
  return sheetConfirmed(r.response)
}

// ---------------------------------------------------------------------------------------------------------------
// Not responding (A2.11, A2.14 #22, v1.12 r1 #4)

interface Hang { pid: number; since: number; answered: boolean; abort?: AbortController }
const hangs = new Map<string, Hang>()
let hangSheetOpen = false

function clearHang(t: Tab): void {
  const h = hangs.get(t.id)
  if (h) { h.abort?.abort(); hangs.delete(t.id) }
}

function onUnresponsive(t: Tab, wc: WebContents): void {
  const frame = mainFrameOf(wc)
  const pid = frame && safely(() => frame.osProcessId)
  if (!frame || pid === undefined) return
  t.hung = true
  const h: Hang = { pid, since: Date.now(), answered: false }
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

/** Every tab with any frame in the process (A2.11: another tab's iframe counts as much as its page). */
function processOf(pid: number): ProcessSnapshot {
  const tabs: ProcessSnapshot['tabs'] = []
  for (const [id, c] of canvases) {
    const wc = c.view.webContents
    if (wc.isDestroyed()) continue
    const t = getTab(id)
    if (!t) continue
    const seen = safely(() => { const m = mainFrameOf(wc); return m ? { frames: m.framesInSubtree.map((f) => f.osProcessId), main: m.osProcessId } : undefined })
    if (!seen || !seen.frames.includes(pid)) continue
    tabs.push({ id, commit: t.doc?.commits ?? 0, main: seen.main === pid })
  }
  return { pid, tabs }
}

/**
 * The pill's Reload on a page not responding: asks first, since it ends the page (frame 11). Each sheet names the
 * tabs of the process and their documents as they are when it opens; Reload Page is checked against what that
 * sheet named (tabpage.ts hangDecision) - a tab that navigated or joined meanwhile opens the sheet again with the
 * new list, which is then what counts.
 */
async function notResponding(t: Tab): Promise<void> {
  const h = hangs.get(t.id)
  if (!h || !t.hung) return
  const wait = h.since + T.hangProbeMs - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  if (h.answered || hangs.get(t.id) !== h) {
    // the main frame answered: the hang is in a frame of another process - nothing is ended; the guarded reload
    j('hang', { tab: t.id, answeredBeforeSheet: true })
    void guard(t, { kind: 'reload' })
    return
  }
  for (;;) {
    if (hangSheetOpen) return
    const snap = processOf(h.pid)
    const named = t.doc?.commits ?? 0
    const others = snap.tabs.filter((x) => x.id !== t.id).map((x) => tabName(getTab(x.id)!))
    const words = hangSheetText(t, others)
    hangSheetOpen = true
    const ac = new AbortController()
    h.abort = ac
    let reload = false
    try {
      if (__MV_TEST__ && seamed()) reload = (await testSheet({ kind: 'hang', tab: t.id, others: snap.tabs.map((x) => x.id), ...words }, ac.signal)) && !ac.signal.aborted
      else {
        const win = mainWindow()
        if (!win) return
        const r = await dialog.showMessageBox(win, { ...sheetBox(words), signal: ac.signal })
        reload = sheetConfirmed(r.response) && !ac.signal.aborted
      }
    } finally { hangSheetOpen = false; h.abort = undefined }
    if (!reload) return
    // checked again before ending anything: the same frame, process and documents, still silent
    const now = processOf(h.pid)
    const c = canvases.get(t.id)
    const samePid = !!c && safely(() => mainFrameOf(c.view.webContents)?.osProcessId) === h.pid
    const d = hangDecision({ hung: !!t.hung, current: hangs.get(t.id) === h, samePid, answered: h.answered, commit: t.doc?.commits ?? 0, named, now, before: snap })
    if (d === 'nothing') { j('hang', { tab: t.id, recheck: 'nothing' }); return }
    if (d === 'again') { j('hang', { tab: t.id, recheck: 'again', tabs: now.tabs }); continue }   // the sheet again, with the new list
    for (const x of now.tabs) {
      const tab = getTab(x.id)!
      if (x.main) { tab.appEnding = true; tab.crash.inFlight = 'force' }
    }
    j('hang', { tab: t.id, ended: h.pid, tabs: now.tabs })
    c!.view.webContents.forcefullyCrashRenderer()   // once, through the tab whose main frame lives there
    for (const x of now.tabs) if (!x.main) canvases.get(x.id)?.view.webContents.reload()   // only a frame of it lived there
    return
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Probes of a failed tab's address (A2.11, v1.14 r3 #4)

async function probe(t: Tab): Promise<'silent' | 'answers' | 'proved'> {
  if (!t.reg?.origin) return 'silent'
  if (trust.probe) return trust.probe(t)
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

/** ⌘R, ⇧⌘R and the menu's Reload: the person's crash reload on a crashed or latched tab with no live page, else the guard's. */
function reloadTab(t: Tab | undefined, force: boolean): void {
  if (!t || t.kind !== 'local') return
  if (reloadIsPersons(t)) { personReload(t); compose(); return }
  void guard(t, { kind: force ? 'forceReload' : 'reload' })
}
const reloadActive = (force: boolean): void => reloadTab(activeTab(), force)

/** ⌘L: Home with its link field, `back` the tab it came from (A2.7). The home stream's page does the rest. */
let linkBack: string | undefined
function openLink(): void {
  const a = activeTab()
  if (a && a.kind !== 'home') linkBack = a.id
  else if (linkBack && !getTab(linkBack)) linkBack = undefined
  activate('home')
  const home = contentView('home')
  if (home) sendHeld(home.webContents, CH.homeFocus, { field: 'link', ...(linkBack ? { back: linkBack } : {}) })
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
    case 'mark-flash': recorder.markFlash(via); return
  }
}

// ---------------------------------------------------------------------------------------------------------------
// ⌘L's link, opened in its canvas's tab (A2.7, A2.14 #24, v1.12 r1 #3, v1.13 r2 #6): the window stream's half of
// home.ts's `LinkPorts.open`. `url` is already rebuilt on the entry's bound origin and checked; null while the
// entry is starting (the path kept, loaded at ready). A link that changes more than the hash replaces the document,
// through the guard.

export interface LinkTarget { state: string; origin: string | null; port: number; ws: string; name: string }
type LinkAnswer = { ok: true } | { ok: false; why: 'bad' | 'nothing' | 'not-canvas' | 'later' | 'refused' }

export async function openInTab(e: LinkTarget, url: string | null, rest: string): Promise<LinkAnswer> {
  const locals = allTabs().filter((t) => t.kind === 'local' && t.reg?.ws === e.ws)
  const t = locals.find((x) => e.origin ? x.reg!.origin === e.origin : x.reg!.port === e.port) ?? locals.find((x) => x.reg!.port === e.port)
  if (!t) return { ok: false, why: 'nothing' }
  if (t.fail?.why === 'unverified') return { ok: false, why: 'not-canvas' }
  const path = safePath(url ? (() => { const u = new URL(url); return u.pathname + u.search + u.hash })() : rest)
  if (!url && liveDoc(t)) {
    // still starting, and its tab keeps a page: the link would replace that page, which only the guard may do -
    // and the guard's load needs the canvas ready. Nothing is opened: "Not opened: <name>'s page stays as it was"
    // (Home keeps the link selected; Return opens it once the canvas is ready). Never a path kept for a load that
    // cannot come: the kept page's own reload would overwrite it
    j('link', { tab: t.id, refused: 'starting-kept' })
    return { ok: false, why: 'refused' }
  }
  if (!t.open) reopenTab(t.id)
  if (!url || !liveDoc(t)) {
    // nothing to replace: the tab goes to the link's board when it loads (at ready for a starting canvas)
    t.path = path
    if (contentView(t.id)) t.needsLoad = true
    activate(t.id)
    return { ok: true }
  }
  const wc = contentView(t.id)?.webContents
  if (wc && !wc.isDestroyed() && hashOnly(wc.getURL(), url)) {
    // only the hash changes: the same document, its trust kept - no question asked
    activate(t.id)
    j('link', { tab: t.id, hashOnly: true })
    void wc.loadURL(url).catch(() => {})
    return { ok: true }
  }
  activate(t.id)
  return (await guard(t, { kind: 'load', url })) === 'done' ? { ok: true } : { ok: false, why: 'refused' }
}

/**
 * A canvas's same-origin `window.open` of its own shell document (sessions.ts `onSameCanvasOpen`, A2.14 #4): that
 * canvas's tab, focused and taken there - with no question when only the hash changes, else through the guard.
 * One local tab per canvas in app 0.1. `url` is already rebuilt on the tab's bound origin and checked.
 */
export function openSameCanvas(webContentsId: number, url: string): void {
  const t = allTabs().find((x) => contentView(x.id)?.webContents.id === webContentsId)
  if (!t || t.kind !== 'local') return
  activate(t.id)
  const wc = contentView(t.id)?.webContents
  if (wc && !wc.isDestroyed() && hashOnly(wc.getURL(), url)) { j('link', { tab: t.id, hashOnly: true }); void wc.loadURL(url).catch(() => {}); return }
  void guard(t, { kind: 'load', url })
}

// ---------------------------------------------------------------------------------------------------------------
// The logo (A2.4): fetched once the entry is ready, on each new instance and when the tab is shown; proved like the
// document by the trust stream's fetchLogo. At most one in flight per tab; applied only if the tab, its instance and
// its document are unchanged; never for an unverified tab.

const logoFetch = new Map<string, AbortController>()

/** Abort the tab's logo fetch in flight (a newer one, a navigation, a close): true when there was one. */
function abortLogo(t: Tab): boolean {
  const ac = logoFetch.get(t.id)
  if (!ac) return false
  logoFetch.delete(t.id)
  ac.abort()
  j('logo', { tab: t.id, aborted: true })
  return true
}

function refreshLogo(t: Tab): void {
  if (!trust.fetchLogo || t.kind !== 'local' || t.reg?.state !== 'ready' || t.fail?.why === 'unverified') return
  abortLogo(t)
  const ac = new AbortController()
  logoFetch.set(t.id, ac)
  const at = { instance: t.reg.instance, commits: t.doc?.commits ?? 0 }
  j('logo', { tab: t.id, fetch: true, commits: at.commits })
  const settle = () => { if (logoFetch.get(t.id) === ac) logoFetch.delete(t.id) }
  void trust.fetchLogo(t, ac.signal).then((url) => {
    if (ac.signal.aborted || logoFetch.get(t.id) !== ac) return
    settle()
    if (!getTab(t.id) || t.reg?.instance !== at.instance || (t.doc?.commits ?? 0) !== at.commits || t.fail?.why === 'unverified') return
    j('logo', { tab: t.id, applied: !!url })
    if (t.logo !== (url ?? undefined)) { t.logo = url ?? undefined; compose() }
  }, settle)
}

// ---------------------------------------------------------------------------------------------------------------
// The app pages' messages: the bridge calls these once it has checked the sender (kind, main frame, own URL) and
// every field (channels.ts SENDERS). Each acts on main's own records alone.

const STATE_WORD: Record<string, string | undefined> = { starting: 'starting', gone: 'stopped', unverified: 'not a Marver canvas', unreachable: "can't reach", crashed: 'crashed', unloaded: 'unloaded' }

function tokenOf(t: Tab): MenuToken { return { tab: t.id, commit: t.doc?.commits ?? 0, trusted: !!t.doc?.trusted } }
function holds(k: MenuToken): boolean {
  const t = getTab(k.tab)
  return !!t && (t.doc?.commits ?? 0) === k.commit && !!t.doc?.trusted === k.trusted
}

function tabAct(k: MenuToken, what: 'activate' | 'open-browser' | 'reveal' | 'copy-link' | 'close' | 'mark-all-seen' | 'reload' | 'force-reload'): void {
  const t = getTab(k.tab)
  if (!t || !holds(k)) { j('tab-act', { what, tab: k.tab, stale: true }); return }
  j('tab-act', { what, tab: t.id })
  // the people link (the slot file's `url`): what a browser opens and a person shares - never the bound origin
  const link = t.reg ? `http://localhost:${t.reg.port}${safePath(t.path)}` : undefined
  switch (what) {
    case 'activate': if (t.kind === 'local' && !t.open) reopenTab(t.id); else activate(t.id); return
    case 'open-browser': if (link && t.doc?.trusted) openOutside(link); return
    case 'reveal': reveal(t); return
    case 'copy-link': if (link && t.doc?.trusted) effects.copy(link); return
    case 'close': void closeTab(t.id); return
    case 'mark-all-seen': if (t.doc?.trusted && hasBridge(t)) { const sent = trust.menuClick(t.id, 'mark-all-seen'); j('tab-act', { what, tab: t.id, sent }) } return
    // the menu's Reload Canvas and Force Reload: the tab the menu was built for, its document and trust unchanged
    case 'reload': reloadTab(t, false); return
    case 'force-reload': reloadTab(t, true); return
  }
}

/**
 * Reveal in Finder and Open in Browser, run in main from the tab's record. A test run never opens a Finder window
 * or a browser on the screen of whoever is at the Mac: recorded instead, as effects.ts records its copies.
 */
const outside: { revealed: string[]; opened: string[] } = { revealed: [], opened: [] }
const recordOutside = (): boolean => __MV_TEST__ && testMode() && process.env.MARVER_APP_REAL_EFFECTS !== '1'
function reveal(t: Tab): void {
  if (!t.root) return
  if (__MV_TEST__ && recordOutside()) { outside.revealed.push(t.root); return }
  shell.showItemInFolder(t.root)
}
function openOutside(url: string): void {
  if (__MV_TEST__ && recordOutside()) { outside.opened.push(url); return }
  void shell.openExternal(url)
}

/** The last native popup a test run would have shown: kept, never put on the screen (its items clicked by a hook). */
let lastPopup: MenuItemConstructorOptions[] = []

function popup(items: MenuItemConstructorOptions[], x: number, y: number): void {
  const win = mainWindow()
  if (!win || !items.length) return
  if (__MV_TEST__ && testMode()) {
    lastPopup = items
    j('popup', { x: Math.round(x), y: Math.round(y), items: items.filter((i) => i.type !== 'separator').map((i) => ({ label: i.label, enabled: i.enabled !== false, ...(i.type === 'checkbox' ? { checked: !!i.checked } : {}) })) })
    return
  }
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
        // main's own mv:menu-click (app-api.ts APP_MENU_IDS): only a canvas with the bridge (0.27.1) hears it
        { label: 'Mark All as Seen', enabled: !!t.doc?.trusted && hasBridge(t), click: () => tabAct(k, 'mark-all-seen') },
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
      case 'copy-start': if (t.root) effects.copy(startCommand({ root: t.root, port: t.reg?.slot == null ? t.reg?.port : null })); return true
      case 'copy-details': effects.copy(details(t)); return true
      case 'reveal': reveal(t); return true
      case 'close': void closeTab(t.id); return true
      default: return false
    }
  },
}

/** The bridge checked the sender (kind, main frame, its pinned URL) and every field; these act on main's records. */
function mountPages(pages: NonNullable<TrustPort['pages']>): void {
  const o = (p: unknown) => (p ?? {}) as Record<string, unknown>
  pages.onReady((wc) => onAppReady(wc))
  pages.handle(CH.tabActivate, (_wc, p) => pageHandlers.tabActivate(String(o(p).id)))
  pages.handle(CH.tabClose, (_wc, p) => pageHandlers.tabClose(String(o(p).id)))
  pages.handle(CH.tabMenu, (_wc, p) => pageHandlers.tabMenu(String(o(p).id), Number(o(p).x), Number(o(p).y)))
  pages.handle(CH.tabsMore, (_wc, p) => pageHandlers.tabsMore(((o(p).ids as unknown[]) ?? []).map(String), Number(o(p).x), Number(o(p).y)))
  pages.handle(CH.pillAction, (_wc, p) => pageHandlers.pillAction(Number(o(p).rev), o(p).act === 'dismiss' ? 'dismiss' : 'button'))
  pages.handle(CH.tabpageAction, (wc, p) => pageHandlers.tabpageAction(wc, Number(o(p).rev), String(o(p).action) as TabPageAction))
}

function details(t: Tab): string {
  const level = lastPressure()?.level
  const board = recorder.boardOf(t.id)
  return copyDetails(t, {
    app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, marver: t.reg?.version,
    macos: process.getSystemVersion(), model: macModel, memGB: totalmem() / 2 ** 30,
    // A3: the last pressure reading and the board's frame count (A3.8 #9, #46)
    ...(level != null ? { pressure: level } : {}), ...(board ? { board } : {}),
  })
}

/** `mv:menu-click` for the active canvas's own items, only while its token holds. */
function canvasClick(k: MenuToken, id: string): void {
  const t = getTab(k.tab)
  if (!t || !holds(k) || !t.doc?.trusted || !t.reports.menu?.some((m: MenuItem) => m.id === id)) return
  trust.menuClick(t.id, id)
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
// tabs.json (v1.12 r1 #5): the model's snapshot handed to the store on every change; the store writes it whole

let tabsFile: TabsFile | null = null
let store: TabsStore

/** views.ts's own store, until config.ts's (ports.ts `readTabsFile` / `tabsWriter`) is passed in. */
function ownStore(h: Home): TabsStore {
  const path = () => join(h.state, 'tabs.json')
  let waiting: TabsFile | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const write = () => {
    if (timer) { clearTimeout(timer); timer = undefined }
    const file = waiting
    waiting = undefined
    if (!file || !h.writable) return
    try {
      mkdirSync(h.state, { recursive: true, mode: 0o700 })
      const tmp = `${path()}.${randomBytes(6).toString('hex')}.tmp`
      const fd = openSync(tmp, 'w', 0o600)
      try { writeSync(fd, JSON.stringify(file, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(tmp, path())
    } catch (err) {
      j('tabs.json', { writeFailed: (err as NodeJS.ErrnoException).code })
      setCondition('files', { lead: 'Files not saved', text: '', short: 'Files not saved', tooltip: 'The app could not write ~/.marver/state' })
    }
  }
  return {
    read() {
      let raw: string
      try { raw = readFileSync(path(), 'utf8') } catch { return undefined }
      let parsed: TabsFile | null = null
      try { parsed = parseTabsFile(JSON.parse(raw)) } catch { parsed = null }
      if (!parsed) {
        // the last bad one kept aside; the app goes on as if it were empty (A2.12)
        try { renameSync(path(), `${path()}.bad`) } catch { /* unwritable: nothing to keep */ }
        j('tabs.json', { bad: true })
        return undefined
      }
      return parsed
    },
    set(file) {
      waiting = file
      if (!timer) { timer = setTimeout(write, T.stateDebounceMs); (timer as { unref?: () => void }).unref?.() }
    },
    flushSync: write,
  }
}

/** The model's snapshot to the store (written debounced 1 s). */
function saveSoon(): void {
  if (quitting || !store) return
  tabsFile = snapshotFile(tabsFile, Date.now())
  store.set(tabsFile)
}

/** The quit's snapshot (v1.10 r5): handed over and written now. */
export function writeTabsNow(): void {
  if (!store) return
  tabsFile = snapshotFile(tabsFile, Date.now())
  store.set(tabsFile)
  store.flushSync()
}

/** The workspaces of the canvases running now (the registry's starting and ready entries). */
const runningWorkspaces = (): string[] => [...new Set(trust.entries().filter((e) => e.state === 'ready' || e.state === 'starting').map((e) => e.ws))]

/**
 * What home.ts's `mountPages(bridge, w)` needs of the window stream (ports.ts `WindowPorts`): the canvases running,
 * told when that set changes; ⌘L's link opened in its tab (`LinkPorts`: the registry's live entry on a port, and
 * openInTab); the files pill (tier 3).
 */
export function windowPorts() {
  const fns = new Set<() => void>()
  let last = ''
  trust.onRegistry(() => {
    const now = runningWorkspaces().sort().join(',')
    if (now !== last) { last = now; for (const fn of [...fns]) fn() }
  })
  return {
    running: runningWorkspaces,
    onRunningChange(fn: () => void) { fns.add(fn); return () => { fns.delete(fn) } },
    linkPorts: {
      byPort(port: number): LinkTarget | undefined {
        const e = trust.entries().find((x) => x.port === port && (x.state === 'ready' || x.state === 'starting'))
        return e ? { state: e.state, origin: e.origin ?? null, port: e.port, ws: e.ws, name: e.name } : undefined
      },
      open: openInTab,
    },
    setFilesPill(p: { lead?: string; text: string; short: string; tooltip?: string } | null) {
      setCondition('files', p ? { text: p.text, short: p.short, ...(p.lead ? { lead: p.lead } : {}), ...(p.tooltip ? { tooltip: p.tooltip } : {}) } : null)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Start, and the quit

export function startViews(i: StartInput): void {
  trust = i.trust
  homeDir = i.home
  notes = i.notes
  store = i.tabsStore ?? ownStore(i.home)
  const home = homedir()
  const sendState = (t: Tab, s: AppState) => {
    if (!canvases.has(t.id)) return
    trust.appState(t.id, s)
    if (s === 'shown') recorder.shown(t)
  }
  setTabsPorts({
    now: () => Date.now(), home, appDark: () => nativeTheme.shouldUseDarkColors,
    changed: (o) => { ensureAppViews(); compose(o) }, load, appState: sendState, act, ask, forget, save: saveSoon,
    shown: (t) => { onShown(t); refreshLogo(t) }, forward,
    recheck: (t) => scheduleRetry(t, { now: true }),
    // a canvas that starts after launch opens on its saved board (A2.14 #23): the file as read at launch, kept
    // whole since (snapshotFile keeps the entries of canvases not running), read only with restoreTabs on
    savedPath: (ws, origin) => i.files.config.restoreTabs ? savedPathIn(tabsFile, ws, origin) : undefined,
    log: j,
    record: (kind, t, body) => recorder.event(kind, t, body),
  })
  setTabpagePorts({
    now: () => Date.now(), isActive, changed: () => compose(), log: j, load,
    reload: (t) => {
      // the reload after a crash: rebuilt from the bound origin and the saved path, in its own view (a new renderer)
      if (!t.reg?.origin || !t.open) return
      trust.reopenNext(t.id)
      const url = t.reg.origin + safePath(t.path)
      void ensureView(t).then((v) => { if (v && !v.webContents.isDestroyed() && getTab(t.id) && t.open) void v.webContents.loadURL(url).catch(() => {}) })
    },
    confirmed: (t) => crashReloaded(t),
    probe,
  })
  setPillPorts({
    now: () => Date.now(), home, visible: windowVisible, send: sendPill, log: j,
    copyStart: (t) => { if (t.root) effects.copy(startCommand({ root: t.root, port: t.reg?.slot == null ? t.reg?.port : null })) },
    notResponding: (t) => { void notResponding(t) },
  })

  openWindow({
    register: (wc, kind, tabId) => trust.register(wc, kind, tabId),
    wire: (wc) => keys(wc),
    quitting: () => quitting,
    ...(trust.pages ? { send: trust.pages.send } : {}),
    present: (tabId, doc, r) => trust.present?.(tabId, doc, r) ?? false,
    afterCompose: () => recorder.tabsChanged(),
  })
  // the presentation (A3.8 #27): an accepted answer, judged with the GPU identity read in its turn; the GPU
  // process gone or replaced covers every view until each presents again
  trust.onPresented?.((tabId, doc, r) => { const v = presentAnswer(tabId, doc, r, Date.now(), gpuIdentity()); if (v === 'ok' || v === 'lost') compose() })
  app.on('child-process-gone', (_e, d) => { if (d.type === 'GPU') { j('gpu', { gone: d.reason }); gpuGone(); compose() } })
  app.on('gpu-info-update', () => { const id = gpuIdentity(); if (noteGpu(id)) { j('gpu', { changed: id }); compose() } })
  sampler.onSample((x) => { if (noteGpu(x.gpu ? { pid: x.gpu.pid, born: x.gpu.born } : null)) compose() })
  if (trust.pages) mountPages(trust.pages)

  // restore (v1.12 r1 #5): only the active tab loads; the others when first shown. The file is read whatever
  // restoreTabs says, but restores only with it on: off, it is still written - keeping the saved boards of the
  // canvases not running (snapshotFile) - so turning it back on restores (A2.14 #23)
  tabsFile = store.read() ?? null
  const plan = restorePlan(tabsFile, trust.entries(), { restore: i.files.config.restoreTabs, firstLaunch: !!i.firstLaunch })
  applyRestore(plan)
  ensureAppViews()
  trust.onRegistry((e) => {
    const t = e.kind === 'gone' ? allTabs().find((x) => x.reg?.instance === e.instance) : undefined
    onRegistry(e)
    if (t?.reg) notes?.gone(t.reg.ws)
    if (e.kind === 'entry' && e.entry.state === 'ready') { const x = allTabs().find((y) => y.reg?.instance === e.entry.instance); if (x) refreshLogo(x) }
  })
  for (const entry of trust.entries()) onRegistry({ kind: 'entry', entry })
  // A2.4: a local tab's logo is fetched once its entry is ready - for the canvases running at launch too, so a tab
  // not yet shown wears its logo in the strip and on Home rather than its initials until its first showing
  for (const t of allTabs()) if (t.kind === 'local' && t.reg?.state === 'ready') refreshLogo(t)
  trust.onReport((tabId, doc, r) => { onReport(tabId, doc, r); invalidateMenu() })

  startMenu({
    model: menuModel,
    apply: (t) => Menu.setApplicationMenu(Menu.buildFromTemplate(t)),
    acts: {
      run: (c) => runCommand(c, 'menu'), holds, canvasClick,
      tab: (k, what) => tabAct(k, what),
      help: () => openOutside(HELP_URL),
      perfFiles: () => effects.openPath(join(homeDir.dir, 'perf')),
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
    noteHome()
  }
  strip?.once('did-finish-load', show)
  strip?.once('did-fail-load', show)
  setTimeout(show, 300)

  app.on('activate', () => showWindow())   // the Dock icon
  powerMonitor.on('resume', onResume)
  execFile('/usr/sbin/sysctl', ['-n', 'hw.model'], { timeout: 2000 }, (err, out) => { if (!err) macModel = String(out).trim() })

  // ⌘Q, the menu, the Dock: every canvas tab through guardAll (A2.2, v1.13 r2 #2, v1.14 r3 #1)
  let quitInFlight = false
  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    if (quitInFlight) return
    quitInFlight = true
    try { writeTabsNow() } catch (err) { j('quit', { tabsJson: String((err as Error)?.message ?? err) }) }   // the session as the quit starts
    j('quit', { asked: true })
    void guardAll({ kind: 'quit' }).catch((err: unknown) => {
      // a throw in the guard (its sheet, an act, a compose): this quit is refused, never the next one - a quit left
      // in flight would swallow every later ⌘Q, Dock quit and logout until Force Quit
      j('quit', { error: String((err as Error)?.message ?? err) })
      return 'refused' as const
    }).then((r) => {
      quitInFlight = false
      j('quit', { answer: r })
      // the quit is cancelled, and says so where the person can see it: a quit from the Dock or a logout may start
      // with the window hidden (tabs.ts refuse() brought its tab forward); never retried by itself
      if (r !== 'done') { try { forward() } catch { /* the window went */ } return }
      // what is saved on the way out never holds the quit
      try { writeTabsNow() } catch (err) { j('quit', { tabsJson: String((err as Error)?.message ?? err) }) }
      try { notes?.quitting?.(runningWorkspaces()) } catch (err) { j('quit', { recent: String((err as Error)?.message ?? err) }) }
      quitting = true
      app.quit()
    })
  })

  if (__MV_TEST__) testHooks()
}

/** The Mac woke: every failed tab looks again at once (A2.11: a check on `powerMonitor` `resume`). */
function onResume(): void {
  j('resume', { failed: allTabs().filter((t) => t.fail).map((t) => t.id) })
  for (const t of allTabs()) if (t.fail) scheduleRetry(t, { now: true })
}

/** Home's first load while it is the active tab, the window shown: Home has shown (ports.ts `noteHomeShown`). */
let homeNoted = false
let homeLoaded = false
function noteHome(): void {
  if (homeNoted || !homeLoaded || activeTab()?.kind !== 'home' || !windowVisible()) return
  homeNoted = true
  notes?.homeShown()
}

/** Home's view always, Settings' while its tab is open (⌘, makes the tab; this its view). */

function ensureAppViews(): void {
  noteHome()
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
    hung: !!t.hung, held: t.held ?? null, replacing: !!t.replacing, key: keyOf(t), look: t.look ?? null, logo: t.logo ?? null,
    hasView: canvases.has(t.id) || !!contentView(t.id), wcId: contentView(t.id)?.webContents.id ?? null, pageView: !!pageView(t.id),
    geo: { ...t.geo },
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
  // a picture of the window (window.ts captureWindow), written to an absolute path the case names
  provide('capture', async (x) => {
    const { path } = arg<{ path: string }>(x)
    if (typeof path !== 'string' || !path.startsWith('/') || !path.endsWith('.png')) throw new Error('capture: an absolute .png path')
    const c = await captureWindow()
    writeFileSync(path, c.png)
    return { path, width: c.width, height: c.height, scale: c.scale, layers: c.layers }
  })
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
  // `frame`: the main frame's own executeJavaScript, which does not wait for a load in flight (a page navigating)
  provide('exec', async (a) => { const { target, js, gesture, frame } = arg<{ target: string; js: string; gesture?: boolean; frame?: boolean }>(a); const wc = wcOf(target); return wc ? (frame ? wc.mainFrame.executeJavaScript(js, !!gesture) : wc.executeJavaScript(js, !!gesture)) : null })
  // whether the main frame stays silent for `ms` (its own executeJavaScript, which does not wait for a load): a
  // case that hangs a page knows its busy loop runs before it acts
  provide('silent', async (a) => {
    const { target, ms } = arg<{ target: string; ms?: number }>(a)
    const wc = wcOf(target)
    if (!wc || wc.isDestroyed()) return null
    return Promise.race([
      wc.mainFrame.executeJavaScript('0').then(() => false, () => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), ms ?? 300)),
    ])
  })
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
  // a drag, as a hand makes it: down, moves with the button held (one a frame), up - a real edit for the shell
  provide('drag', async (a) => {
    const { target, from, to, steps } = arg<{ target: string; from: { x: number; y: number }; to: { x: number; y: number }; steps?: number }>(a)
    const wc = wcOf(target)
    if (!wc || wc.isDestroyed()) return false
    const n = Math.max(1, steps ?? 8)
    wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= n; i++) {
      await new Promise((r) => setTimeout(r, 16))
      wc.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + (to.x - from.x) * i / n), y: Math.round(from.y + (to.y - from.y) * i / n), button: 'left', modifiers: ['leftbuttondown'] })
    }
    wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 })
    return true
  })
  // a click routed as a real one is - hit-tested by the browser, so it reaches a cross-process iframe, which
  // sendInputEvent (straight to the main frame's widget) never does: CDP's Input.dispatchMouseEvent on the view's
  // own debugger (no port). Not awaited: a hung frame acknowledges nothing
  provide('cdpClick', (a) => {
    const { target, x, y } = arg<{ target: string; x?: number; y?: number }>(a)
    const wc = wcOf(target)
    if (!wc || wc.isDestroyed()) return false
    try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3') } catch { return false }
    const at = { x: x ?? 40, y: y ?? 40, button: 'left', clickCount: 1 }
    void wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...at }).catch(() => {})
    void wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at }).catch(() => {})
    return true
  })
  // Chromium's hang monitor's report for a view, made by hand: Electron 45 raises none for a cross-process iframe
  // that never answers its input (hang.test.ts), so the app's own half of that case - the main frame asked, its
  // answer, the guarded reload - is driven so, against a frame that really is hung
  provide('hang:report', (a) => { const wc = wcOf(arg<{ target: string }>(a).target); if (!wc || wc.isDestroyed()) return false; wc.emit('unresponsive'); return true })
  // the view's frames and the renderer process of each
  provide('frames', (a) => {
    const wc = wcOf(arg<{ target: string }>(a).target)
    if (!wc || wc.isDestroyed()) return null
    return wc.mainFrame.framesInSubtree.map((f) => ({ url: f.url, pid: f.osProcessId, main: f === wc.mainFrame }))
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
  // the focus cases need the key window: take it (for a moment) from whatever app is in front
  provide('focusApp', () => { app.focus({ steal: true }); mainWindow()?.focus(); return mainWindow()?.isFocused() ?? false })
  provide('hide', () => { hideWindow(); return true })
  // kept above other windows without taking the keyboard: Chromium tells an occluded page nothing (its hang
  // monitor's 'unresponsive' needs the contents visible)
  provide('onTop', (a) => { const win = mainWindow(); if (!win) return false; const on = !!arg<{ on: boolean }>(a).on; win.setAlwaysOnTop(on, 'floating'); if (on) win.showInactive(); return true })
  provide('resize', (a) => { const { width, height } = arg<{ width: number; height: number }>(a); mainWindow()?.setContentSize(width, height); return true })
  provide('fullscreen', (a) => { mainWindow()?.setFullScreen(!!arg<{ on: boolean }>(a).on); return true })
  provide('menu', () => menuModel())
  provide('outside', () => ({ ...outside }))
  provide('openInTab', async (a) => { const { entry, url, rest } = arg<{ entry: LinkTarget; url: string | null; rest: string }>(a); return openInTab(entry, url, rest) })
  // sessions.ts onSameCanvasOpen's call, as the trust stream's policy makes it for a canvas's same-origin window.open
  provide('openSameCanvas', (a) => {
    const { tab, url } = arg<{ tab: string; url: string }>(a)
    const wc = contentView(tab)?.webContents
    if (!wc) return false
    openSameCanvas(wc.id, url)
    return true
  })
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
  provide('notes', () => ({ homeNoted }))
  provide('settings:open', () => { openSettingsTab(); return true })
  // the strip's tab:menu and tabs:more, as the bridge hands them on; their popup recorded, never shown
  provide('tabMenu', (a) => { const { id, x, y } = arg<{ id: string; x?: number; y?: number }>(a); pageHandlers.tabMenu(id, x ?? 10, y ?? 40); return true })
  provide('tabsMore', (a) => { const { ids, x, y } = arg<{ ids: string[]; x?: number; y?: number }>(a); pageHandlers.tabsMore(ids, x ?? 10, y ?? 40); return true })
  provide('popup:click', (a) => {
    const it = lastPopup.find((i) => i.label === arg<{ label: string }>(a).label)
    if (!it?.click || it.enabled === false) return false
    ;(it.click as unknown as () => void)()
    return true
  })
  provideEffectHooks()   // `effects`: the copies and folders recorded (home.ts provides it too once the streams meet)
  provide('resume', () => { onResume(); return true })
}
