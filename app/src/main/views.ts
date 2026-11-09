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
 *
 * A4 (app 0.3, A4.6 #39-#46) adds the shared canvas, a `remote` tab on `persist:remote` with no preload: its view is
 * wired as a canvas's (keys, focus, crash and hang, HTML full screen, the `canvases` map) with nav.ts's adapter and no
 * trust - registered `remote` with the bridge itself, since there is nothing of trust to fake for it. Its commit lifts
 * at once (`onRemoteCommit`), its failure is `unreachable` whatever the adapter said - a load that ends with no page
 * and nothing lifted too (`onRemoteAbort`) - its probe a `HEAD` of its origin (sessions.ts `probeRemote`), and
 * `net.isOnline()` turning true looks again at once (polled only while one is unreachable). `openRemote` is ⌘L's,
 * Home's and the front door's: one tab per origin, a hash-only change unasked, any other through the guard.
 *
 * Spec 30 (commands, R12) records here: `runCommand` and `tabAct`, one `appCmd` per input with `via` and `in`, each case
 * ending on its work (#49) - a tab's `shown` or `reopen`, the new document's accepted hello, a window event; `by` on
 * `shown` and `reopen`; the page handlers end what the bridge's funnel started (`currentAppCmd`); the Dock and the hang
 * sheet are inputs of their own; the window's own events (#53). Mark All as Seen and a canvas's items are relays (#51):
 * nothing recorded here, `in` passed on with `mv:menu-click`.
 */
import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import { app, dialog, Menu, nativeTheme, net, powerMonitor, shell, WebContentsView, type MenuItemConstructorOptions, type Session, type WebContents, type WebPreferences } from 'electron'
import * as sessions from './sessions.ts'
import { CH, type LinkOpenAnswer, type PageKind, type TabPageAction } from '../shared/channels.ts'
import { startCommand } from '../shared/command.ts'
import { parseLink, remoteFaviconPick, remoteStart, shellDestination } from '../shared/links.ts'
import { LOGO_MAX, LOGO_MIME, sniffLogo } from '../../../src/shared/logo-sniff.ts'
import { effects, provideEffectHooks } from './effects.ts'
import type { AppState, MenuIn, MenuItem, Present, Presented } from '../../../src/shared/app-api.ts'
import { WINDOW_EVENTS, type AppBody, type AppKind, type TabIdent } from '../../../src/shared/app-perf.ts'
import type { CmdIn, CmdVia } from '../../../src/shared/perf-records.ts'
import { docProof } from '../../../src/server/proof.ts'
import { readAtMost } from './proof.ts'
import { values, type Files, type Home } from './config.ts'
import { bridgeNow, type CanvasReports } from './bridge.ts'
import { attachNav, type NavAdapter, type NavEvent } from './nav.ts'
import type { RegistryEntry, RegistryEvent } from './registry.ts'
import { mainFrameOf, safely } from './frames.ts'
import { attachKeys, digitOf, type AppCommand } from './keys.ts'
import { activated, appCmd, askedLoad, askedShown, cmdTabsChanged, cmdWindowGone, currentAppCmd, expectWindow, holdCmd, tabDocument, tabFailed, waitForDoc, windowCause, type AppCmdHandle, type KeyFrom } from './commands.ts'
import { focusOwner, f6, track } from './focus.ts'
import { buildNow, HELP_URL, invalidateMenu, startMenu, type MenuModel, type MenuToken } from './menu.ts'
import { crashReloaded, currentPill, onPillAction, setCondition, setPillPorts } from './pill.ts'
import {
  activate, activeTab, addressOf, allTabs, applyRestore, cameraKept, canLoad, canvasOrder, closeTab, cycleFrom, displayState, forDigit, getTab, guard,
  guardAll, hasBridge, hashOnly, isActive, isCanvasTab, keptDoc, keyOf, linkOpens, liveDoc, onCommit, onDocumentGone, onFail, onInPage, onRegistry, onRemoteAbort, onRemoteCommit, onReport, onUnloaded, openRemoteTab, openSettingsTab,
  ordered, parseTabsFile, remoteLinkPlan, remoteTab, reopenTab, restorePlan, safePath, savedPathIn, setTabsPorts, sheetBox, showForLink, sheetConfirmed, sheetText, snapshotFile, startReopen, stuckUnloads, tabName,
  unloadClosing, viewlessAct, type GuardAction, type GuardAnswer, type Sheet, type Tab, type TabsFile,
} from './tabs.ts'
import {
  copyDetails, forgetTab, hangDecision, hangSheetText, onAttemptFailed, onLifted, onlineTick, onShown, onViewClosed, pageOffers, personReload, recover,
  reloadIsPersons, scheduleRetry, setTabpagePorts, wantsOnline, type ProcessSnapshot,
} from './tabpage.ts'
import { exportReport, type ExportResult } from './report.ts'
import { flushQueued } from './perflog.ts'
import {
  appPrefs, APP_ORIGIN, attachContent, captureWindow, compose, contentView, detachContent, hideWindow, mainWindow, onAppReady, openWindow,
  focusWindow, pageOf, pageView, sendHeld, sendPill, showWindow, stripContents, viewsNow, windowVisible,
} from './window.ts'
import { note, provide, testMode } from './testing/index.ts'
import { T } from './timings.ts'
import { commitLayout } from './layout.ts'
import { answer as presentAnswer, forget as presentForget, gpuGone, noteGpu } from './present.ts'
import { appMetrics, gpuIdentity, recorder, sampler } from './recorder.ts'
import { launchRestored } from './launch.ts'
import { lastPressure } from './pressure.ts'
import { actUnload as unloadAct, forceUnload, takeAct, unloadGone as actGone, type ActPorts } from './unload-act.ts'
import { isQuitting, request as shutdownRequest, shutdownState, startShutdown, type RestartAlert } from './shutdown.ts'
import { updateAct, updateMenu, updaterTabs } from './updater.ts'
import { routeDeepLink } from './deep-link.ts'
import { noteLogo, noteSite, setUpdateRoots, showLinked } from './home.ts'
import { fetchSite } from './canvas-fetch.ts'

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
  /** `mv:menu-click` to the tab's admitted, trusted document, for an item its last `mv:menu` offers; `where` the menu it came from (spec 30 #51) */
  menuClick(tabId: string, id: string, where?: MenuIn): boolean
  /** the tab's next `mv:doc` answers `{ reopen: true }`, once (`recover`'s reload, A2.14 #9) */
  reopenNext(tabId: string): void
  /** A3: that flag taken back, if no document has taken it yet: a link opened into a tab with no live document (A3.8 #42) */
  reopenCancel?(tabId: string): void
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
  /** spec 31 E4: the canvas's update through its own session (canvas-fetch.ts `fetchUpdate`): newer, or null */
  fetchUpdate?(t: Tab, signal: AbortSignal): Promise<{ current: string; latest: string } | null>
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
  /** A4 (A4.6 #47): a shared canvas committed or moved its place - Home's Shared canvases keep it (home.ts noteShared) */
  shared?(c: { url: string; host: string }): void
  /** the quit, once guardAll answered 'done', before app.quit() (shutdown.ts): every canvas still running seen now */
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
  /** what waits, written now (the quit): true when it is on disk (A5.1 #20, fsx.ts `StateWriter.flushSync`) */
  flushSync(): boolean
}

export interface StartInput {
  trust: TrustPort; home: Home; files: Files; firstLaunch?: boolean; notes?: HomeNotes; tabsStore?: TabsStore
  /**
   * A5.1 #15: the shutdown coordinator's `flushAll` port, run once at `done` before the end - the presentation records,
   * the recorder's queue, notices.json (main.ts's, which also run at will-quit; each idempotent)
   */
  flushAll?(): void
}

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
const keys = (wc: WebContents, surface: KeyFrom['in'] = 'shell') => attachKeys(wc, (c, _from, key) => runCommand(c, 'key', key),
  { prevent: !(__MV_TEST__ && testMode() && process.env.MARVER_APP_KEYS_NO_PREVENT === '1'), in: surface })

let trust: TrustPort
let homeDir: Home
let notes: HomeNotes | undefined
/** the instance each tab was last noted verified on: Recently here hears once per instance */
const notedVerified = new Map<string, string>()
const canvases = new Map<string, { view: WebContentsView; nav: NavAdapter; off: () => void }>()
const making = new Map<string, Promise<WebContentsView | null>>()
const unattributedTimers = new Map<string, ReturnType<typeof setTimeout>>()
let macModel: string | undefined

/** The one flag lives in the shutdown coordinator (A5.1 #15); kept here for the readers that took it from views.ts. */
export { isQuitting }

// ---------------------------------------------------------------------------------------------------------------
// Canvas views (A2.4: lazy, kept, never re-added)

async function ensureView(t: Tab): Promise<WebContentsView | null> {
  const have = canvases.get(t.id)
  if (have && !have.view.webContents.isDestroyed()) return have.view
  const pending = making.get(t.id)
  if (pending) return pending
  const p = (async () => {
    if (t.kind === 'remote') return remoteView(t)
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

/**
 * A shared canvas's view (A4.6 #40): `persist:remote` prepared once, no preload, placed `below` under the opaque strip
 * like any canvas, never unloaded. Wired as a canvas's, with no trust.
 */
function remoteView(t: Tab): WebContentsView | null {
  sessions.remoteSession()
  if (!getTab(t.id)) return null
  const view = new WebContentsView({ webPreferences: sessions.remoteWebPreferences() })
  wireCanvas(t, view)
  attachContent(t.id, view, 'remote')
  t.view = 'live'
  return view
}

const NO_DRAG = 'html, html * { app-region: no-drag !important; -webkit-app-region: no-drag !important }'

function wireCanvas(t: Tab, view: WebContentsView): void {
  const wc = view.webContents
  recorder.watchCanvas(t, wc)
  // a shared canvas: recorded with the bridge (kindOf answers its permissions) and nav.ts's own adapter - no proof
  // dispatcher, no admission, nothing of trust (A4.6 #40)
  const remote = t.kind === 'remote'
  if (remote) bridgeNow()?.register(wc, 'remote', t.id)
  else trust.register(wc, 'canvas', t.id)
  const nav = remote ? attachNav(wc) : trust.attach(wc, t)
  const off = nav.on((e) => onNav(t, wc, e))
  canvases.set(t.id, { view, nav, off })
  // the tab's view still: a webContents the unload's backstop took out without its destroyed (unload-act.ts) says
  // nothing more to the tab - no crash counted, no hang, no sound or DevTools on a tab that has none
  const mine = () => canvases.get(t.id)?.view === view
  wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain && mine()) onInPage(t, url) })
  wc.on('render-process-gone', (_e, d) => {
    if (!mine()) return
    // an unload's own end, or a crash while it closes: ours, counting nothing, the tab ends unloaded (A3.8 #39, #44)
    if (unloadGone(t, d)) return
    const app = !!t.appEnding
    j('gone', { tab: t.id, reason: d.reason, app })
    recorder.processGone(t, d, app)
    if (!app) tabFailed(t.id, 'gone')   // a renderer lost under a command (#49); one main ended is that command's own work
    clearHang(t)
    recover(t, app ? { kind: 'app' } : { kind: 'crash', reason: d.reason, exitCode: d.exitCode })
    compose()
  })
  wc.on('unresponsive', () => { if (mine()) onUnresponsive(t, wc) })
  wc.on('responsive', () => { if (!mine()) return; t.hung = false; clearHang(t); j('hang', { tab: t.id, responsive: true }); compose() })
  // HTML fullscreen stays in its view (disableHtmlFullscreenWindowResize); from A3 layout.ts places it below the strip
  wc.on('enter-html-full-screen', () => { if (!mine()) return; j('fullscreen', { tab: t.id, html: true }); commitLayout(t, { kind: 'html-fullscreen', on: true }); compose() })
  wc.on('leave-html-full-screen', () => { if (!mine()) return; j('fullscreen', { tab: t.id, html: false }); commitLayout(t, { kind: 'html-fullscreen', on: false }); compose() })
  // what an unload's admission reads (A3.8 #40): a page playing sound, DevTools open
  wc.on('audio-state-changed', (e) => { if (mine()) t.audible = e.audible })
  wc.on('devtools-opened', () => { if (mine()) t.devtools = true })
  wc.on('devtools-closed', () => { if (mine()) t.devtools = false })
  wc.on('destroyed', () => forgetCanvas(t, view))
  keys(wc)
  track(wc, { part: 'content', tab: t.id })
  if (remote) wc.on('page-favicon-updated', (_e, urls) => { if (mine()) onFavicon(t, wc, urls) })
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
  faviconOf.delete(t.id)
  presentForget(t.id)
  t.audible = false
  t.devtools = false
  t.loading = false
  const act = takeAct(t.id)
  if (getTab(t.id)) {
    // an unload's close ended at destroyed: the tab is unloaded, never crashed nor documentless (A3.8 #39); the
    // crash latch's clearing (onViewClosed) is never reached by an unload (A3.8 #44)
    if (t.unload && (t.unload.phase === 'closing' || t.unload.phase === 'unsure')) {
      // close() need not end the renderer with a render-process-gone: the unload writes its own `gone`, ours, unless
      // the renderer's own went while it closed (A3.8 #9) - one `gone` for each unload, the journal's too
      if (!act?.gone) {
        record('gone', t, { role: 'canvas', pid: act?.pid ?? 0, born: act?.born ?? 0, reason: 'unload', exitCode: 0, ours: true, source: 'unload', pressure: lastPressure()?.level ?? null })
        j('gone', { tab: t.id, reason: 'unload', ours: true, source: 'unload' })
      }
      onUnloaded(t)
    } else { onDocumentGone(t, 'none'); onViewClosed(t) }
  }
  j('view', { tab: t.id, forgot: true })
  compose()
}

/** Load a documentless tab: its path on its bound origin, a shared canvas's place (never guarded: there is nothing to lose). */
function load(t: Tab): void {
  if (!canLoad(t)) return
  beginReopen(t)
  askedLoad()
  t.needsLoad = false
  t.loadAt = Date.now()
  clearUnattributed(t)   // this load replaces the reload an unattributed commit had waiting
  loadInView(t, addressOf(t)!)
}

/** The tab's view, made if needed, loads `url` (checked by its caller). */
function loadInView(t: Tab, url: string): void {
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
  if (t.kind === 'remote') { onRemoteNav(t, wc, e); return }
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
      tabFailed(t.id, 'refused')   // the load a command waits on failed (#49); the tab's own retries are not that command
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

/**
 * A shared canvas's navigation (A4.6 #42): every main-frame commit is attributed for navigation and presentation and
 * lifts its tab page at once - no proof, no admission, never reloaded as unattributed; a failure is `unreachable` with
 * its reason, whatever the adapter said, never `unverified`. The no-drag CSS goes in at every commit.
 */
function onRemoteNav(t: Tab, wc: WebContents, e: NavEvent): void {
  switch (e.kind) {
    case 'start':
      t.loading = true
      if (commitLayout(t, { kind: 'start', gen: e.gen })) compose()
      return
    case 'commit': {
      t.loading = false
      abortLogo(t)
      const href = safely(() => wc.isDestroyed() ? undefined : wc.getURL()) || e.url
      onRemoteCommit(t, { gen: e.gen, href })
      void wc.insertCSS(NO_DRAG, { cssOrigin: 'user' }).catch(() => {})
      clearUnattributed(t)
      onLifted(t)
      tabDocument(t.id, docToken(t))   // a shared canvas says no hello: its commit is the signal (#49)
      faviconAgain(t, wc)
      refreshSite(t, wc)
      pollOnline()
      compose()
      return
    }
    case 'fail': {
      t.loading = false
      let errorPage = false
      try { errorPage = wc.mainFrame?.origin === 'null' } catch { /* the frame went */ }
      abortLogo(t)
      onFail(t, { why: 'unreachable', code: e.code, errorPage, gen: e.gen })
      tabFailed(t.id, 'refused')
      onAttemptFailed(t)
      scheduleRetry(t)
      pollOnline()
      compose()
      return
    }
    case 'abort': {
      t.loading = false
      if (commitLayout(t, { kind: 'abort', gen: e.gen })) compose()
      // a load replaced by a newer one is aborted just before the newer one starts: a turn later, only an attempt
      // still current ended with no page (a refused redirect, a download, a 204) - with no lifted document, a failure
      const nav = canvases.get(t.id)?.nav
      setImmediate(() => {
        if (getTab(t.id) !== t || !nav || canvases.get(t.id)?.nav !== nav || nav.gen() !== e.gen) return
        if (!onRemoteAbort(t, e.gen)) return
        j('abort', { tab: t.id, gen: e.gen, failed: true })
        onAttemptFailed(t)
        scheduleRetry(t)
        pollOnline()
        compose()
      })
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
    // a reopen's: the unattributed document may have taken mv:doc's reopen flag (the bridge answers it trusted or
    // not), so it is armed again for the reload that may lift - the page promised the camera (A3.8 #43)
    if (t.unload?.phase === 'reopening' && cameraKept(t)) trust.reopenNext(t.id)
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
  t.unload = undefined   // an unloaded tab dropped: nothing of it reopens
  forgetTab(t)
}

// ---------------------------------------------------------------------------------------------------------------
// The guard's act and sheet (A2.2, v1.12 r1 #3, v1.13 r2 #4)

const closeLike = (a: GuardAction) => a.kind === 'close' || a.kind === 'quit' || a.kind === 'update'

function act(t: Tab, a: GuardAction): Promise<GuardAnswer> {
  const c = canvases.get(t.id)
  const wc = c?.view.webContents
  if (!c || !wc || wc.isDestroyed()) {
    // no view: nothing to replace. An unload has nothing to close. A close of an unloaded tab ends its unload: it
    // closes as any documentless tab, and nothing reopens. A load makes a view - an action that waited for an
    // unload loads its own URL (a link opens on what it names, never the reopen's saved path); a reload, a force
    // reload or Try Again of an unloaded tab is its reopen, one load (A3.8 #42, r3 #3)
    if (a.kind === 'unload') { j('act', { tab: t.id, action: a.kind, answer: 'refused', why: 'no-view' }); return Promise.resolve('refused') }
    const loads = viewlessAct(t, a)
    j('act', { tab: t.id, action: a.kind, noView: true, loads, path: t.path })
    // a shared canvas's link loads what it names; its place moves only when a shell page commits (A4.6 r1 #9)
    if (loads && t.kind === 'remote' && a.kind === 'load') loadInView(t, a.url)
    else if (loads && canLoad(t)) load(t)
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
      // a refused close leaves its page kept: its destroyed listener goes too, or each refusal adds one more
      if (!wc.isDestroyed()) { wc.off('did-start-navigation', onStart); wc.off('destroyed', onDestroyed) }
      j('act', { tab: t.id, action: a.kind, answer: r, why })
      resolve(r)
    }
    const onDestroyed = () => done('done', 'destroyed')
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
      wc.once('destroyed', onDestroyed)
      wc.close({ waitForBeforeUnload: true })
      return
    }
    wc.on('did-start-navigation', onStart)
    const address = addressOf(t)
    switch (a.kind) {
      case 'reload': wc.reload(); break
      case 'forceReload': wc.reloadIgnoringCache(); break
      case 'tryAgain': if (address) void wc.loadURL(address).catch(() => {}); else done('refused', 'no-origin'); break
      case 'load': void wc.loadURL(a.url).catch(() => {}); break
    }
  })
}

// ---- the unload's act (A2.6, A3.8 #39, #42, #43): unload-act.ts, on this webContents ---------------------------------

/** The unload act's ports: the journal, its unsure record, and its backstop's forgetCanvas. */
const actPorts: ActPorts = {
  log: (topic, data) => j(topic, data),
  unsure: (t, a) => record('unload', t, { phase: 'unsure', reason: a.reason }),
  forget: (t) => { const c = canvases.get(t.id); if (c) forgetCanvas(t, c.view) },
  // Force Quit Tab (code review r2 #1): its renderer ended only when every frame in it is this tab's - a renderer
  // shared with another tab lives on, and the view taken out ends this tab's part
  kill: (t) => {
    const c = canvases.get(t.id)
    const pid = c && safely(() => mainFrameOf(c.view.webContents)?.osProcessId)
    if (!c || !pid) return
    const snap = processOf(pid)
    const alone = snap.tabs.every((x) => x.id === t.id)
    j('unload', { tab: t.id, forcedKill: alone ? pid : null, shared: snap.tabs.filter((x) => x.id !== t.id).map((x) => x.id) })
    if (alone) safely(() => c.view.webContents.forcefullyCrashRenderer())
  },
}

/** `act(t, { kind: 'unload' })` (unload-act.ts): its renderer read first, for the unload's own `gone`. */
function actUnload(t: Tab, wc: WebContents, a: Extract<GuardAction, { kind: 'unload' }>): Promise<GuardAnswer> {
  const pid = safely(() => wc.getOSProcessId())
  const born = pid ? safely(() => appMetrics('identity').find((m) => m.pid === pid)?.creationTime) : undefined
  return unloadAct(t, wc, a, actPorts, { ...(pid ? { pid } : {}), ...(born !== undefined ? { born } : {}) })
}

/**
 * A render-process-gone while an unload closes the tab (A3.8 #39, #44): ours, counting nothing, handed to the
 * recorder as its one `gone` (forgetCanvas writes none of its own then); unload-act.ts finishes the close. True when
 * it was one.
 */
function unloadGone(t: Tab, d: Electron.RenderProcessGoneDetails): boolean {
  if (!actGone(t)) return false
  j('gone', { tab: t.id, reason: d.reason, ours: true, source: 'unload' })
  recorder.processGone(t, d, true)
  clearHang(t)
  compose()
  return true
}

/**
 * load() of an unloaded tab: the reopen (A3.8 #43). Its saved path on its bound origin; the tab page says
 * `reopening` until that document lifts. On the origin it was unloaded on, `mv:doc` answers `{ reopen: true }` so the
 * shell takes its saved camera even under a selection link; on another origin (rebound while unloaded) it is armed
 * for nothing - that origin's stored camera is not the one the tab was left at - and the path's selection holds. A
 * first load like any (A3.8 #24): its start reads the instance's features.
 */
function beginReopen(t: Tab): void {
  const kept = startReopen(t)
  // the command this reopen is for (spec 30 #52): its `reopen` record, written at the hello, names it
  const by = currentAppCmd()?.id
  if (kept && by) reopenBy.set(t.id, by)
  if (kept === 'camera') trust.reopenNext(t.id)
}
/** The command behind each tab's reopen under way, until its `reopen` record. */
const reopenBy = new Map<string, string>()

/** A record through the recorder (app.jsonl only with the recorder on), and the journal's `record` line in test builds (A3.8 #45). */
function record<K extends AppKind>(kind: K, who: Tab | TabIdent | null, body: Omit<AppBody<K>, keyof TabIdent>): void {
  if (__MV_TEST__) j('record', { kind, ...(who ? { tab: 'id' in who ? who.id : who.tab } : {}), ...(body as object) })
  // the reopen ends the activation that asked for it, and names it (spec 30 #49, #52)
  const tab = kind === 'reopen' && who ? ('id' in who ? who.id : who.tab) : undefined
  const by = tab ? reopenBy.get(tab) : undefined
  if (tab) reopenBy.delete(tab)
  recorder.event(kind, who, (by ? { ...body, by } : body) as Omit<AppBody<K>, keyof TabIdent>)
  if (tab) tabDocument(tab)
}

/** The tabs whose guard sheet the person just declined: a guard's `refused` says only that nothing was replaced (spec 30 #49). */
const declined = new Set<string>()
/** A guard's `refused`, on the command that asked: `cancelled` for a sheet the person declined, else the page or its unsaved work refused. */
function endRefused(h: AppCmdHandle | undefined, tabId: string): void {
  if (declined.delete(tabId)) h?.cancel('sheet')
  else h?.fail('refused')
}

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
  if (__MV_TEST__ && seamed()) {
    const ok = await testSheet({ kind: 'guard', action: s.action.kind, tabs: s.tabs.map((x) => x.id), ...words })
    if (!ok) for (const x of s.tabs) declined.add(x.id)
    return ok
  }
  const win = mainWindow()
  if (!win) return false
  const r = await dialog.showMessageBox(win, sheetBox(words))
  const ok = sheetConfirmed(r.response)
  if (!ok) for (const x of s.tabs) declined.add(x.id)
  return ok
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
    // the page answered and main took the sheet away: nobody chose anything (spec 30's hang-reload is the person's answer)
    if (ac.signal.aborted) return
    const hangCmd = appCmd('hang-reload', { via: 'click', in: 'main', tab: t.id })
    if (!reload) { hangCmd.cancel('wait'); return }
    // checked again before ending anything: the same frame, process and documents, still silent
    const now = processOf(h.pid)
    const c = canvases.get(t.id)
    const samePid = !!c && safely(() => mainFrameOf(c.view.webContents)?.osProcessId) === h.pid
    const d = hangDecision({ hung: !!t.hung, current: hangs.get(t.id) === h, samePid, answered: h.answered, commit: t.doc?.commits ?? 0, named, now, before: snap })
    if (d === 'nothing') { j('hang', { tab: t.id, recheck: 'nothing' }); hangCmd.noop('answered'); return }
    if (d === 'again') { j('hang', { tab: t.id, recheck: 'again', tabs: now.tabs }); hangCmd.cancel('again'); continue }   // the sheet again, with the new list
    for (const x of now.tabs) {
      const tab = getTab(x.id)!
      if (x.main) { tab.appEnding = true; tab.crash.inFlight = 'force' }
    }
    j('hang', { tab: t.id, ended: h.pid, tabs: now.tabs })
    waitForDoc(hangCmd, t.id, docToken(t))   // ends at the new document's accepted hello (R12's row)
    c!.view.webContents.forcefullyCrashRenderer()   // once, through the tab whose main frame lives there
    for (const x of now.tabs) if (!x.main) canvases.get(x.id)?.view.webContents.reload()   // only a frame of it lived there
    return
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Probes of a failed tab's address (A2.11, v1.14 r3 #4)

async function probe(t: Tab): Promise<'silent' | 'answers' | 'proved'> {
  if (t.kind === 'remote') return probeRemote(t)
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

/** A shared canvas's probe (A4.6 #44): sessions.ts's, of its origin, 3 s. */
async function probeRemote(t: Tab): Promise<'silent' | 'answers'> {
  return t.remote ? sessions.probeRemote(t.remote.origin, T.headTimeoutMs) : 'silent'
}

/**
 * `net.isOnline()`, once a second only while a shared canvas is unreachable (A4.6 #44): its turn to true looks at once
 * (tabpage.ts `onlineTick`). A test build may answer for it (`remote:online`).
 */
let onlineTimer: ReturnType<typeof setInterval> | undefined
let onlineStub: boolean | null = null
const isOnline = (): boolean => (__MV_TEST__ && onlineStub !== null ? onlineStub : net.isOnline())
function pollOnline(): void {
  if (!wantsOnline()) {
    if (onlineTimer) { clearInterval(onlineTimer); onlineTimer = undefined; onlineTick(null) }
    return
  }
  if (onlineTimer) return
  onlineTick(isOnline())
  onlineTimer = setInterval(() => { if (wantsOnline()) onlineTick(isOnline()); else pollOnline() }, T.onlinePollMs)
  ;(onlineTimer as { unref?: () => void }).unref?.()
}

// ---------------------------------------------------------------------------------------------------------------
// Commands: one path for the keys and the menu (A2.4, A2.7, A2.14 #25)

/** What identifies the tab's document now: only a hello of another one ends a reload that replaces it (spec 30 #49). */
const docToken = (t: Tab): string => `${t.doc?.doc ?? ''}:${t.doc?.commits ?? 0}`

/**
 * ⌘R, ⇧⌘R and the menu's Reload: the person's crash reload on a crashed or latched tab with no live page, else the
 * guard's. It ends on the new document's accepted hello (#49), never on the guard answering: `done` from the guard
 * says only that the navigation began.
 */
function reloadTab(h: AppCmdHandle, t: Tab | undefined, force: boolean): void {
  if (!t || !isCanvasTab(t)) { h.noop('no-tab'); return }
  waitForDoc(h, t.id, docToken(t))
  if (reloadIsPersons(t)) {
    if (!canLoad(t)) { h.fail('refused'); return }
    personReload(t)
    compose()
    return
  }
  void guard(t, { kind: force ? 'forceReload' : 'reload' }).then((a) => { if (a === 'refused') endRefused(h, t.id) }, () => h.fail('refused'))
}

/** ⌘W, a tab's Close, the strip's Delete: it ends on the tab gone or the sheet refused (#49: closeTab returns before them). */
function closing(h: AppCmdHandle | undefined, id: string): void {
  holdCmd(h)
  void closeTab(id).then((r) => { if (r === 'closed') h?.done(); else endRefused(h, id) }, () => h?.fail('refused'))
}

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

/** The tab a key or menu command acts on (spec 30: its identity on the record), read before it acts. */
function targetOf(c: AppCommand): Tab | undefined {
  const d = digitOf(c)
  if (d !== null) return forDigit(d)
  switch (c) {
    case 'home': return getTab('home')
    case 'settings': return getTab('settings')
    case 'next-tab': return cycleFrom(activeTab()?.id ?? 'home', 1)
    case 'prev-tab': return cycleFrom(activeTab()?.id ?? 'home', -1)
    case 'close-tab': case 'reload': case 'force-reload': case 'devtools': return activeTab()
    default: return undefined
  }
}

/** Each case ends on what it did (#49): the keys' and the menu's one path, told apart by `via` and `in` (#50). */
export function runCommand(c: AppCommand, via: 'key' | 'menu', key?: KeyFrom): void {
  j('command', { cmd: c, via })
  const target = targetOf(c)
  const h = appCmd(c, { via, in: via === 'menu' ? 'menu' : key?.in ?? 'shell', ...(via === 'key' && key ? { keys: key.keys } : {}), ...(target ? { tab: target.id } : {}) })
  const win = mainWindow()
  if (digitOf(c) !== null) {
    if (!target) { h.noop('no-tab'); return }
    showWindow(); activate(target.id); activated(h, target.id)
    return
  }
  switch (c) {
    case 'home': showWindow(); activate('home'); activated(h, 'home'); return
    case 'open-link': showWindow(); openLink(); activated(h, 'home'); return
    case 'close-tab': if (target && target.kind !== 'home') closing(h, target.id); else h.noop('no-tab'); return
    case 'close-window': hideWindow(); h.done(); return
    case 'reload': reloadTab(h, target, false); return
    case 'force-reload': reloadTab(h, target, true); return
    case 'settings': showWindow(); activated(h, openSettingsTab().id); return
    case 'quit': if (shutdownRequest('quit')) h.done(); else h.noop('in-flight'); return
    case 'hide': app.hide(); h.done(); return
    case 'hide-others': Menu.sendActionToFirstResponder('hideOtherApplications:'); h.done(); return
    case 'minimize':
      if (!win) { h.noop('no-tab'); return }
      expectWindow(h, ['minimize'])
      win.minimize()
      return
    case 'fullscreen':
      if (!win) { h.noop('no-tab'); return }
      expectWindow(h, [win.isFullScreen() ? 'leave-full-screen' : 'enter-full-screen'])
      win.setFullScreen(!win.isFullScreen())
      return
    case 'next-tab': case 'prev-tab':
      if (!target) { h.noop('no-tab'); return }
      activate(target.id)
      activated(h, target.id)
      return
    case 'devtools': {
      const v = target ? (pageView(target.id) && !keptDoc(target) ? pageView(target.id) : contentView(target.id)) : undefined
      if (!v) { h.noop('no-tab'); return }
      v.webContents.openDevTools({ mode: 'detach' })
      h.done()
      return
    }
    case 'focus-strip': case 'focus-strip-back': f6(); h.done(); return
    case 'mark-flash':
      holdCmd(h)
      void recorder.markFlash(via).then((r) => { if (r === 'written') h.done(); else if (r === 'failed') h.fail('mark-failed'); else h.noop('debounced') })
      return
  }
}

// ---------------------------------------------------------------------------------------------------------------
// ⌘L's link, opened in its canvas's tab (A2.7, A2.14 #24, v1.12 r1 #3, v1.13 r2 #6): the window stream's half of
// home.ts's `LinkPorts.open`. `url` is already rebuilt on the entry's bound origin and checked; null while the
// entry is starting (the path kept, loaded at ready). A link that changes more than the hash replaces the document,
// through the guard.

export interface LinkTarget { state: string; origin: string | null; port: number; ws: string; name: string }
export async function openInTab(e: LinkTarget, url: string | null, rest: string): Promise<LinkOpenAnswer> {
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
    // nothing to replace: the tab goes to the link's board when it loads (at ready for a starting canvas). A link
    // opens on what it names, never under a saved camera (A3.8 #42): an unloaded tab's unload ends here, so its load
    // is a plain one, not its reopen; and mv:doc's one-shot reopen flag is taken back every time - a reopen's already
    // sent, or one a reopen or a crash reload left armed when it failed or closed before a document took it (an
    // error page never asks). Not while a crash reload is in flight: its document, not the link's, is the next one
    linkOpens(t)
    if (!t.crash.inFlight) trust.reopenCancel?.(t.id)
    t.path = path
    if (contentView(t.id)) t.needsLoad = true
    activate(t.id)
    return { ok: true }
  }
  const wc = contentView(t.id)?.webContents
  // a page an unload is closing is never navigated: the link waits for the close through the guard, which then
  // loads it on a tab with no document (A3.8 #42)
  if (wc && !wc.isDestroyed() && !unloadClosing(t) && hashOnly(wc.getURL(), url)) {
    // only the hash changes: the same document, its trust kept - no question asked
    activate(t.id)
    j('link', { tab: t.id, hashOnly: true })
    void wc.loadURL(url).catch(() => {})
    return { ok: true }
  }
  activate(t.id)
  return (await guard(t, { kind: 'load', url })) === 'done' ? { ok: true } : { ok: false, why: 'refused' }
}

// ---------------------------------------------------------------------------------------------------------------
// A `marver://` link (spec 31 D1; deep-link.ts): parsed, bound to a running canvas of that real folder, and opened -
// a tab with no live document loads the place through openInTab; one already open is shown the place over the bridge

const realOf = (p: string): string | null => { try { return realpathSync(p) } catch { return null } }

/** One link, routed (deep-link.ts `routeDeepLink`). Answers what it did (journaled in a test build). */
export function openDeepLink(raw: string): 'bad' | 'home' | 'opened' | 'shown' {
  const r = routeDeepLink<Tab>(raw, {
    entries: () => trust.entries().map((e) => ({ ws: e.ws, root: e.root, port: e.port, slot: e.slot, state: e.state, origin: e.origin ?? null, name: e.name })),
    realpath: realOf,
    focus: focusWindow,
    tabFor: (e) => {
      const locals = allTabs().filter((t) => t.kind === 'local' && t.reg?.ws === e.ws)
      return locals.find((x) => e.origin ? x.reg!.origin === e.origin : x.reg!.port === e.port) ?? locals.find((x) => x.reg!.port === e.port)
    },
    live: (t) => liveDoc(t) && t.fail?.why !== 'unverified',
    // open already: never reloaded, never a hash replaced under it - the shell gets the place and keeps any draft
    show: (t, to) => { j('deep-link', { tab: t.id, show: showForLink(t.id, to) }) },
    open: (e, url, rest) => { void openInTab({ state: e.state, origin: e.origin, port: e.port, ws: e.ws, name: e.name }, url, rest).then((a) => j('deep-link', { opened: a })) },
    home: (root, ws, exists) => {
      activate('home')
      const id = showLinked(root, ws, exists)
      const home = contentView('home')
      if (home && id) sendHeld(home.webContents, CH.homeFocus, { field: 'recent', id })
      j('deep-link', { home: true, card: id ?? null })
    },
  })
  if (r === 'bad') j('deep-link', { refused: 'bad' })
  return r
}

// ---------------------------------------------------------------------------------------------------------------
// A shared canvas's link (A4.6 #39, #41, #43): ⌘L's, Home's and the front door's - home.ts's `LinkPorts.openRemote`

/**
 * An https link (checked again here: parseLink's https, no loopback host) opens its origin's shared tab: a new one,
 * activated and loaded, or the open one, activated - with no question when only the hash changes, and through the
 * guard (its sheet naming the host) when the link would replace the page. `refused` when the guard refused.
 */
export async function openRemote(raw: string): Promise<LinkOpenAnswer> {
  const p = parseLink(raw)
  if (p.kind !== 'https') return { ok: false, why: 'bad' }
  const have = remoteTab(new URL(p.url).origin)
  const url = remoteStart(p.url)
  const wc = have ? contentView(have.id)?.webContents : undefined
  const live = wc && !wc.isDestroyed() ? wc : undefined
  const plan = remoteLinkPlan(have, url, live?.getURL() ?? '')
  j('link', { remote: plan, ...(have ? { tab: have.id } : {}) })
  if (!have) { activate(openRemoteTab(p.url).id); return { ok: true } }   // its view made and its place loaded (tabs.ts activate)
  activate(have.id)
  if (plan === 'same') return { ok: true }
  // only the hash changes: the same document, no question asked
  if (plan === 'hash' && live) { void live.loadURL(url).catch(() => {}); return { ok: true } }
  return (await guard(have, { kind: 'load', url })) === 'done' ? { ok: true } : { ok: false, why: 'refused' }
}

/**
 * A canvas's same-origin `window.open` of its own shell document (sessions.ts `onSameCanvasOpen`, A2.14 #4): that
 * canvas's tab, focused and taken there - with no question when only the hash changes, else through the guard.
 * One local tab per canvas in app 0.1. `url` is already rebuilt on the tab's bound origin and checked.
 */
export function openSameCanvas(webContentsId: number, url: string): void {
  const t = allTabs().find((x) => contentView(x.id)?.webContents?.id === webContentsId)   // a closing view's reads undefined
  if (!t || t.kind !== 'local') return
  activate(t.id)
  const wc = contentView(t.id)?.webContents
  if (wc && !wc.isDestroyed() && !unloadClosing(t) && hashOnly(wc.getURL(), url)) { j('link', { tab: t.id, hashOnly: true }); void wc.loadURL(url).catch(() => {}); return }
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
    if (url && t.reg) noteLogo(t.reg.ws, url)   // spec 31 E2: its Recently here card keeps it once it stops
    if (t.logo !== (url ?? undefined)) { t.logo = url ?? undefined; compose() }
  }, settle)
}

// ---------------------------------------------------------------------------------------------------------------
// Spec 31 E4: a running canvas's update, read through its own session (canvas-fetch.ts) once its entry is ready, then
// every six hours - the server answers under its daily TTL. Applied only to the same tab and instance.

const updateFetch = new Map<string, AbortController>()
const UPDATE_EVERY_MS = 6 * 3600 * 1000
function refreshUpdate(t: Tab): void {
  if (!trust.fetchUpdate || t.kind !== 'local' || t.reg?.state !== 'ready' || t.fail?.why === 'unverified') return
  updateFetch.get(t.id)?.abort()
  const ac = new AbortController()
  updateFetch.set(t.id, ac)
  const instance = t.reg.instance
  void trust.fetchUpdate(t, ac.signal).then((u) => {
    if (updateFetch.get(t.id) !== ac) return
    updateFetch.delete(t.id)
    if (ac.signal.aborted || getTab(t.id) !== t || t.reg?.instance !== instance) return
    const latest = u?.latest
    j('update', { tab: t.id, latest: latest ?? null })
    if (t.update !== latest) { t.update = latest; compose() }
  }, () => { if (updateFetch.get(t.id) === ac) updateFetch.delete(t.id) })
}

// Spec 31 E3: a shared canvas's name and logo, read through its tab's own session (the gate's cookie applies) once its
// commit lands on its origin, once per origin per run while it succeeds; kept by origin only on success (home.ts)
const siteRead = new Map<string, 'reading' | 'done'>()
function refreshSite(t: Tab, wc: WebContents): void {
  const origin = t.remote?.origin
  if (!origin || siteRead.has(origin)) return
  const committed = safely(() => wc.getURL()) ?? ''
  if (!shellDestination(origin, committed)) return
  siteRead.set(origin, 'reading')
  const ses = sessions.remoteSession()
  void fetchSite((url, init) => ses.fetch(url, init), origin).then((m) => {
    j('site', { tab: t.id, name: m?.name ?? null, logo: !!m?.logo })
    if (!m) { siteRead.delete(origin); return }
    siteRead.set(origin, 'done')
    noteSite(origin, m.name, m.logo)
  }, () => { siteRead.delete(origin) })
}

/**
 * A shared canvas's logo (A2.4, A4.6 #46): the current commit's first `page-favicon-updated`, its pick
 * (links.ts `remoteFaviconPick`: the repo's logo, else the first URL that is https with no credentials on the tab's own
 * origin while the committed document is there too - a sign-in host's icon is never the canvas's). Fetched through
 * `persist:remote` with no redirect followed (one to loopback http never reaches it), no cache, 5 s, at most 256 KB
 * actually received, then sniffed as the local logo is; one in flight (`logoFetch`), aborted at a commit or a close,
 * applied only if the tab and its commit are unchanged. Without one: its host's initials.
 * Electron 45 sends the event only when the page's set changes, so a later commit with the same icons hears nothing:
 * `faviconOf` keeps the last set, and a commit of a tab that wears none tries it again (`faviconAgain`).
 */
const faviconOf = new Map<string, { taken: number; urls: string[] }>()
function onFavicon(t: Tab, wc: WebContents, urls: string[]): void {
  if (!t.remote) return
  const commit = t.doc?.commits ?? 0
  const first = faviconOf.get(t.id)?.taken !== commit   // the commit's first only
  faviconOf.set(t.id, { taken: commit, urls: Array.isArray(urls) ? urls : [] })
  if (first) takeFavicon(t, wc, urls, commit, false)
}

/** A shared tab's commit while it wears no favicon: the page's last set again, which Electron does not send twice. */
function faviconAgain(t: Tab, wc: WebContents): void {
  const f = faviconOf.get(t.id)
  if (f && !t.logo && t.remote) takeFavicon(t, wc, f.urls, t.doc?.commits ?? 0, true)
}

/** Fetch the pick of `urls` for this commit; a fetch in flight (a commit's retry, when the page then sent its own) goes. */
function takeFavicon(t: Tab, wc: WebContents, urls: string[], commit: number, again: boolean): void {
  abortLogo(t)
  const url = remoteFaviconPick(urls, t.remote!.origin, safely(() => wc.getURL()) ?? '')
  if (!url) { j('logo', { tab: t.id, favicon: 'refused', again }); return }
  const ac = new AbortController()
  logoFetch.set(t.id, ac)
  j('logo', { tab: t.id, fetch: true, commits: commit, favicon: true, again })
  void fetchFavicon(url, ac.signal).then((dataUrl) => {
    if (ac.signal.aborted || logoFetch.get(t.id) !== ac) return
    logoFetch.delete(t.id)
    if (getTab(t.id) !== t || (t.doc?.commits ?? 0) !== commit) return
    j('logo', { tab: t.id, applied: !!dataUrl, favicon: true })
    if (dataUrl && t.logo !== dataUrl) { t.logo = dataUrl; compose() }
  })
}

/** The favicon's bytes as a checked `data:` URL, or null (an error, a redirect, a status, too big, not an image). */
async function fetchFavicon(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await sessions.remoteSession().fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(T.logoDeadlineMs), signal]) })
    if (res.status !== 200) { await res.body?.cancel().catch(() => {}); return null }
    const bytes = await readAtMost(res, LOGO_MAX)
    const type = bytes && sniffLogo(bytes)
    return type ? `data:${LOGO_MIME[type]};base64,${bytes!.toString('base64')}` : null
  } catch { return null }
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

/** Where a tab action's input came from (#50): the tab's right-click, the File, View and Window menus, the » overflow. */
interface TabFrom { via: CmdVia; in: CmdIn }
const TAB_MENU: TabFrom = { via: 'context', in: 'tab-menu' }
const APP_MENU: TabFrom = { via: 'menu', in: 'menu' }
const OVERFLOW: TabFrom = { via: 'menu', in: 'strip' }

/** Mark All as Seen is a relay (#51): the shell executes it and records it, `in` telling it which menu; nothing here. */
function markAllSeen(k: MenuToken): void {
  const t = getTab(k.tab)
  if (!t || !holds(k)) { j('tab-act', { what: 'mark-all-seen', tab: k.tab, stale: true }); return }
  if (t.doc?.trusted && hasBridge(t)) { const sent = trust.menuClick(t.id, 'mark-all-seen', 'tab-menu'); j('tab-act', { what: 'mark-all-seen', tab: t.id, sent }) }
}

function tabAct(k: MenuToken, what: 'activate' | 'open-browser' | 'reveal' | 'copy-link' | 'close' | 'reload' | 'force-reload', from: TabFrom): void {
  const h = appCmd(what, { ...from, tab: k.tab })
  const t = getTab(k.tab)
  if (!t) { j('tab-act', { what, tab: k.tab, stale: true }); h.noop('no-tab'); return }
  if (!holds(k)) { j('tab-act', { what, tab: k.tab, stale: true }); h.noop('untrusted'); return }
  j('tab-act', { what, tab: t.id })
  // the people link (the slot file's `url`): what a browser opens and a person shares - never the bound origin
  const link = t.reg ? `http://localhost:${t.reg.port}${safePath(t.path)}` : undefined
  // a shared canvas's own place (A4.6 #49): its link to share, opened through sessions.ts's checked openOutside
  const shared = t.kind === 'remote' ? t.remote?.url : undefined
  switch (what) {
    case 'activate':
      if (t.kind === 'local' && !t.open) reopenTab(t.id); else activate(t.id)
      activated(h, t.id)
      return
    case 'open-browser':
      if (shared) { sessions.openOutside(shared); h.done() }
      else if (link && t.doc?.trusted) { openOutside(link); h.done() }
      else h.noop('untrusted')
      return
    case 'reveal':
      if (!t.root) { h.noop('untrusted'); return }
      reveal(t)
      h.done()
      return
    case 'copy-link':
      if (shared) { effects.copy(shared); h.done() }
      else if (link && t.doc?.trusted) { effects.copy(link); h.done() }
      else h.noop('untrusted')
      return
    case 'close': closing(h, t.id); return
    // the menu's Reload Canvas and Force Reload: the tab the menu was built for, its document and trust unchanged
    case 'reload': reloadTab(h, t, false); return
    case 'force-reload': reloadTab(h, t, true); return
  }
}

/**
 * Reveal in Finder and Open in Browser, run in main from the tab's record. A test run never opens a Finder window
 * or a browser on the screen of whoever is at the Mac: recorded instead, as effects.ts records its copies.
 */
const outside: { revealed: string[]; opened: string[]; shown?: string[] } = { revealed: [], opened: [] }
const recordOutside = (): boolean => __MV_TEST__ && testMode() && process.env.MARVER_APP_REAL_EFFECTS !== '1'
function reveal(t: Tab): void {
  if (!t.root) return
  if (__MV_TEST__ && recordOutside()) { outside.revealed.push(t.root); return }
  shell.showItemInFolder(t.root)
}
/** A5.1 #22: the app itself selected in Finder (Updates Need the Applications Folder…'s Show in Finder). */
export function showOutside(path: string): void {
  if (__MV_TEST__ && recordOutside()) { (outside.shown ??= []).push(path); return }
  shell.showItemInFolder(path)
}
export function openOutside(url: string): void {
  if (__MV_TEST__ && recordOutside()) { outside.opened.push(url); return }
  void shell.openExternal(url)
}

/** The last native popup a test run would have shown: kept, never put on the screen (its items clicked by a hook). */
let lastPopup: MenuItemConstructorOptions[] = []

function popup(items: MenuItemConstructorOptions[], x: number, y: number): void {
  const win = mainWindow()
  if (!win || !items.length) { currentAppCmd()?.noop('no-tab'); return }
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
  /** `tab:activate { id }` (a closed canvas's Home card reopens it); ends at its tab's `shown` or `reopen` */
  tabActivate(id: string): void {
    const h = currentAppCmd()
    const t = getTab(id)
    if (!t) { h?.noop('no-tab'); return }
    if (t.kind === 'local' && !t.open) reopenTab(id)
    else activate(id)
    if (h) activated(h, id)
  },
  /** `tab:close { id }` */
  tabClose(id: string): void {
    if (getTab(id)) closing(currentAppCmd(), id)
    else currentAppCmd()?.noop('no-tab')
  },
  /** `tab:menu { id, x, y }`: the tab's right-click menu, built from main's record (A2.4, A2.7) */
  tabMenu(id: string, x: number, y: number): void {
    const t = getTab(id)
    if (!t) { currentAppCmd()?.noop('no-tab'); return }
    const k = tokenOf(t)
    const items: MenuItemConstructorOptions[] = []
    if (t.kind === 'local') {
      items.push(
        { label: 'Open in Browser', enabled: !!t.doc?.trusted, click: () => tabAct(k, 'open-browser', TAB_MENU) },
        { label: 'Reveal in Finder', enabled: !!t.root, click: () => tabAct(k, 'reveal', TAB_MENU) },
        { label: 'Copy Local Link', enabled: !!t.doc?.trusted, click: () => tabAct(k, 'copy-link', TAB_MENU) },
        // main's own mv:menu-click (app-api.ts APP_MENU_IDS): only a canvas with the bridge (0.27.1) hears it
        { label: 'Mark All as Seen', enabled: !!t.doc?.trusted && hasBridge(t), click: () => markAllSeen(k) },
        { type: 'separator' },
      )
    } else if (t.kind === 'remote') {
      // a shared canvas (A4.6 #49): no Reveal in Finder, no Mark All as Seen, no canvas items
      items.push(
        { label: 'Open in Browser', click: () => tabAct(k, 'open-browser', TAB_MENU) },
        { label: 'Copy Link', click: () => tabAct(k, 'copy-link', TAB_MENU) },
        { type: 'separator' },
        { label: 'Reload', click: () => tabAct(k, 'reload', TAB_MENU) },
        { label: 'Force Reload', click: () => tabAct(k, 'force-reload', TAB_MENU) },
        { type: 'separator' },
      )
    }
    if (t.kind !== 'home') items.push({ label: 'Close Tab', click: () => tabAct(k, 'close', TAB_MENU) })
    popup(items, x, y)
  },
  /** `tabs:more { ids, x, y }`: the tabs behind », each with its state, the active one checked (A2.14 #19) */
  tabsMore(ids: string[], x: number, y: number): void {
    const a = activeTab()
    const items = ids.map((id) => getTab(id)).filter((t): t is Tab => !!t).map((t): MenuItemConstructorOptions => {
      const word = STATE_WORD[displayState(t, t === a)]
      const k = tokenOf(t)
      return { label: word ? `${tabName(t)} - ${word}` : tabName(t), type: 'checkbox', checked: t === a, click: () => tabAct(k, 'activate', OVERFLOW) }
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
    if (!pageOffers(b, t.kind === 'remote').includes(action)) { j('tabpage', { refused: action, page: b.page }); return false }
    j('tabpage', { tab: t.id, action })
    // what the funnel started (bridge.ts): undefined for a test hook's direct call. #49: each ends on its work, a copy
    // or a reveal as this turn does it, a retry or a reload on the new document's hello, an export on its file
    const h = currentAppCmd()
    switch (action) {
      case 'retry':
        waitForDoc(h, t.id, docToken(t))
        // a page retained beneath: Try Again is the only way to replace it, through the guard (it asks first)
        if (t.retained && keptDoc(t)) void guard(t, { kind: 'tryAgain' }).then((a) => { if (a === 'refused') endRefused(h, t.id) }, () => h?.fail('refused'))
        else if (canLoad(t)) load(t)
        else h?.fail('refused')   // nothing to load it from: no hello will ever come
        return true
      // a shared canvas's Open in Browser (A2.11's unreachable page, A4.6 #42): its place, through openOutside's checks
      case 'open-browser': if (t.kind === 'remote' && t.remote) sessions.openOutside(t.remote.url); else h?.noop('no-tab'); return true
      case 'reload':
        waitForDoc(h, t.id, docToken(t))
        if (!canLoad(t)) h?.fail('refused')
        personReload(t)
        compose()
        return true
      case 'copy-start': if (t.root) effects.copy(startCommand({ root: t.root, port: t.reg?.slot == null ? t.reg?.port : null })); else h?.noop('no-tab'); return true
      case 'copy-details': effects.copy(details(t)); return true
      // A5.1 #28: the latched page's Export Performance Report…, the menu's own export (the report names no canvas)
      case 'export-report': holdCmd(h); void exportNow('tabpage').then((r) => endExport(h, r)); return true
      case 'reveal': if (t.root) reveal(t); else h?.noop('no-tab'); return true
      case 'close': closing(h, t.id); return true
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

/**
 * The performance report (A5.1 #28): Help > Export Performance Report… and the latched crashed page's button. The
 * save panel a sheet on the window when it shows; the report made from this flavour's log under the home's perf/
 * (report.ts), written whole and shown in Finder; a failure an alert. A test build records the panel, Finder and
 * the alert (effects.ts) and journals each export's `report` line with its result.
 */
function exportNow(via: 'menu' | 'tabpage'): Promise<ExportResult> {
  const parent = () => (windowVisible() ? mainWindow() ?? null : null)
  j('report', { via })
  return exportReport({
    savePanel: (path) => effects.savePanel(path, parent()),
    showItem: (file) => effects.showItem(file),
    alert: (message, detail) => effects.alert(message, detail, parent()),
    flush: () => flushQueued(),
    downloads: () => safely(() => app.getPath('downloads')) ?? join(homedir(), 'Downloads'),
    input: () => ({
      perfDir: join(homeDir.dir, 'perf'), flavour: __MARVER_RELEASE__ ? 'release' : 'dev', keepPerfDays: values().config.keepPerfDays,
      now: Date.now(), version: app.getVersion(), electron: process.versions.electron ?? '', macos: process.getSystemVersion(),
    }),
  }).then((r) => { j('report', { via, ...r }); return r })
}

/** An export's end (#49): saved is the file written; a failure its stage (never the path, or the code's text); cancelled the panel's; one at a time. */
function endExport(h: AppCmdHandle | undefined, r: ExportResult): void {
  if (r.result === 'saved') h?.done()
  else if (r.result === 'cancelled') h?.cancel()
  else if (r.result === 'busy') h?.noop('busy')
  else h?.fail(r.stage)
}

/** `mv:menu-click` for the active canvas's own items, only while its token holds. A relay (#51): the shell records it, told it came from the menu. */
function canvasClick(k: MenuToken, id: string): void {
  const t = getTab(k.tab)
  if (!t || !holds(k) || !t.doc?.trusted || !t.reports.menu?.some((m: MenuItem) => m.id === id)) return
  trust.menuClick(t.id, id, 'menu')
  j('menu', { click: id, tab: t.id })
}

function menuModel(): MenuModel {
  const a = activeTab() ?? getTab('home')!
  const list = allTabs()
  const tabsList = ordered(list).map((t) => {
    const word = isCanvasTab(t) ? STATE_WORD[displayState(t, t === a)] : undefined
    const key = isCanvasTab(t) ? keyOf(t, list) : undefined
    return { id: t.id, name: tabName(t), ...(word ? { word } : {}), ...(key ? { key } : {}), active: t === a, token: tokenOf(t) }
  })
  const trusted = a.kind === 'local' && !!a.doc?.trusted
  return {
    active: { id: a.id, kind: a.kind, name: tabName(a), token: tokenOf(a), trusted, canClose: a.kind !== 'home', canReload: isCanvasTab(a) },
    canvas: trusted && a.reports.menu?.length ? { token: tokenOf(a), items: a.reports.menu } : null,
    tabs: tabsList,
    header: Number(process.getSystemVersion().split('.')[0]) >= 14,
    update: updateMenu(),                                            // A5.1 #22: the updater's item, none before it starts
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
  let lastOk = true
  const write = (): boolean => {
    if (timer) { clearTimeout(timer); timer = undefined }
    const file = waiting
    waiting = undefined
    if (!h.writable) return false
    // nothing waited: as the last write went (A5.1 #20)
    if (!file) return lastOk
    try {
      mkdirSync(h.state, { recursive: true, mode: 0o700 })
      const tmp = `${path()}.${randomBytes(6).toString('hex')}.tmp`
      const fd = openSync(tmp, 'w', 0o600)
      try { writeSync(fd, JSON.stringify(file, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(tmp, path())
      return lastOk = true
    } catch (err) {
      j('tabs.json', { writeFailed: (err as NodeJS.ErrnoException).code })
      setCondition('files', { lead: 'Files not saved', text: '', short: 'Files not saved', tooltip: 'The app could not write ~/.marver/state' })
      return lastOk = false
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
      if (!timer) { timer = setTimeout(() => void write(), T.stateDebounceMs); (timer as { unref?: () => void }).unref?.() }
    },
    flushSync: write,
  }
}

/** The model's snapshot to the store (written debounced 1 s). */
function saveSoon(): void {
  if (isQuitting() || !store) return
  tabsFile = snapshotFile(tabsFile, Date.now())
  store.set(tabsFile)
}

/**
 * The shutdown's snapshot (v1.10 r5; A5.1 #15, #20): handed over and written now. True when it is on disk - the
 * coordinator notes a false and goes on (the files pill already says so).
 */
export function writeTabsNow(): boolean {
  if (!store) return false
  tabsFile = snapshotFile(tabsFile, Date.now())
  store.set(tabsFile)
  return store.flushSync()
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
      // A4.4: the link's origin in its shared tab, new or existing (A4.6 #39-#43)
      openRemote,
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
    // the command behind this switch, if this turn is one (spec 30 #52): the `shown` names it and ends it
    if (s === 'shown' && recorder.shown(t, currentAppCmd()?.id)) askedShown()
  }
  setTabsPorts({
    now: () => Date.now(), home, appDark: () => nativeTheme.shouldUseDarkColors,
    // a waiting update looks at its tab after every change: closed, or its document changed (A5.1 #21)
    changed: (o) => { ensureAppViews(); compose(o); updaterTabs(); cmdTabsChanged(activeTab()?.id) }, load, appState: sendState, act, ask, forget, save: saveSoon,
    shown: (t) => { onShown(t); refreshLogo(t) }, forward,
    recheck: (t) => scheduleRetry(t, { now: true }),
    // Home's Shared canvases (A4.6 #47): the place, never a sign-in URL (tabs.ts moves it only to a shell page)
    shared: (t) => { if (t.remote) notes?.shared?.({ url: t.remote.url, host: t.remote.host }) },
    // a canvas that starts after launch opens on its saved board (A2.14 #23): the file as read at launch, kept
    // whole since (snapshotFile keeps the entries of canvases not running), read only with restoreTabs on
    savedPath: (ws, origin) => i.files.config.restoreTabs ? savedPathIn(tabsFile, ws, origin) : undefined,
    log: j,
    record,
  })
  setTabpagePorts({
    now: () => Date.now(), isActive, changed: () => compose(), log: j, load,
    reload: (t) => {
      // the reload after a crash: rebuilt from the bound origin and the saved path (a shared canvas: its place), in its
      // own view (a new renderer)
      const url = addressOf(t)
      if (!url || !t.open) return
      if (t.kind === 'local') trust.reopenNext(t.id)
      void ensureView(t).then((v) => { if (v && !v.webContents.isDestroyed() && getTab(t.id) && t.open) void v.webContents.loadURL(url).catch(() => {}) })
    },
    confirmed: (t) => crashReloaded(t),
    probe,
  })
  setPillPorts({
    now: () => Date.now(), home, visible: windowVisible, send: sendPill, log: j,
    copyStart: (t) => { if (t.root) effects.copy(startCommand({ root: t.root, port: t.reg?.slot == null ? t.reg?.port : null })) },
    notResponding: (t) => { void notResponding(t) },
    // A3: "Flash marked"'s Show selects that mark's picture in Finder (a file inside the dot folder, which Finder shows)
    showFlash: (ref) => { if (/^flashes\/[0-9a-z-]+\.png$/.test(ref)) effects.showItem(join(homeDir.dir, 'perf', ref)) },
  })

  openWindow({
    register: (wc, kind, tabId) => trust.register(wc, kind, tabId),
    wire: (wc, kind) => keys(wc, kind === 'strip' || kind === 'home' || kind === 'settings' || kind === 'tabpage' ? kind : 'shell'),
    ...(trust.pages ? { send: trust.pages.send } : {}),
    present: (tabId, doc, r) => trust.present?.(tabId, doc, r) ?? false,
    afterCompose: () => recorder.tabsChanged(),
  })
  watchWindowEvents()
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
  const restoreAt = performance.now()   // spec 30 #37: what main spent restoring, and what came back
  tabsFile = store.read() ?? null
  const plan = restorePlan(tabsFile, trust.entries(), { restore: i.files.config.restoreTabs, firstLaunch: !!i.firstLaunch })
  applyRestore(plan)
  ensureAppViews()
  {
    const restored = allTabs().filter((t) => (t.kind === 'local' || t.kind === 'remote') && t.open)
    const front = activeTab()?.kind
    launchRestored({ restored: restored.length, local: restored.filter((t) => t.kind === 'local').length, remote: restored.filter((t) => t.kind === 'remote').length, active: front ?? null }, performance.now() - restoreAt)
  }
  trust.onRegistry((e) => {
    const t = e.kind === 'gone' ? allTabs().find((x) => x.reg?.instance === e.instance) : undefined
    onRegistry(e)
    if (t?.reg) notes?.gone(t.reg.ws)
    if (e.kind === 'entry' && e.entry.state === 'ready') { const x = allTabs().find((y) => y.reg?.instance === e.entry.instance); if (x) { refreshLogo(x); refreshUpdate(x) } }
  })
  for (const entry of trust.entries()) onRegistry({ kind: 'entry', entry })
  // A2.4: a local tab's logo is fetched once its entry is ready - for the canvases running at launch too, so a tab
  // not yet shown wears its logo in the strip and on Home rather than its initials until its first showing
  for (const t of allTabs()) if (t.kind === 'local' && t.reg?.state === 'ready') { refreshLogo(t); refreshUpdate(t) }
  setInterval(() => { for (const t of allTabs()) if (t.kind === 'local' && t.reg?.state === 'ready') refreshUpdate(t) }, UPDATE_EVERY_MS).unref()
  // Home's copy-update: the folder of that tab, from main's own record (spec 31 E4)
  setUpdateRoots((id) => { const t = getTab(id); return t?.kind === 'local' && t.update && t.root ? t.root : undefined })
  trust.onReport((tabId, doc, r) => {
    onReport(tabId, doc, r)
    invalidateMenu()
    updaterTabs(tabId)
    // its document's accepted hello ends what waited on it (spec 30 #49); onReport accepts one per document
    const t = getTab(tabId)
    if (t?.reports.hello) tabDocument(tabId, docToken(t))
  })

  startMenu({
    model: menuModel,
    apply: (t) => Menu.setApplicationMenu(Menu.buildFromTemplate(t)),
    acts: {
      run: (c) => runCommand(c, 'menu'), holds, canvasClick,
      tab: (k, what) => tabAct(k, what, APP_MENU),
      stale: (k, what) => tabAct(k, what, APP_MENU),                   // spec 30 #49: tabAct says its token no longer holds
      help: () => { const h = appCmd('help', APP_MENU); openOutside(HELP_URL); h.done() },
      perfFiles: () => { const h = appCmd('show-perf-files', APP_MENU); effects.openPath(join(homeDir.dir, 'perf')); h.done() },
      update: (t) => {                                                 // A5.1 #22: the pill's entry too; acts only while its token holds
        const h = appCmd('update', { ...APP_MENU, arg: t.act })
        if (updateAct(t)) h.done(); else h.noop('stale')
      },
      exportReport: () => {                                            // A5.1 #28
        const h = appCmd('export-report', APP_MENU)
        void exportNow('menu').then((r) => endExport(h, r))
      },
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

  app.on('activate', () => { const h = appCmd('dock-activate', { via: 'click', in: 'main' }); showWindow(); h.done() })   // the Dock icon
  powerMonitor.on('resume', onResume)
  execFile('/usr/sbin/sysctl', ['-n', 'hw.model'], { timeout: 2000 }, (err, out) => { if (!err) macModel = String(out).trim() })

  // a shared canvas's window.open of an https URL (A4.6 #41): its origin's tab when one is open, or the front door asked
  sessions.onRemoteOpen((url, fromFrontDoor) => {
    if (!fromFrontDoor && !remoteTab(new URL(url).origin)) return false
    j('link', { remote: 'window', fromFrontDoor })
    void openRemote(url)
    return true
  })

  // ⌘Q, the menu, the Dock, a logout, Restart to Update: one coordinator, every canvas tab through guardAll (A2.2,
  // v1.13 r2 #2, v1.14 r3 #1; A5.1 #15-#17)
  startShutdown({
    now: () => Date.now(),
    writeTabsNow,
    guardAll,
    stuck: stuckUnloads,
    ask,
    forceUnload,
    forward,
    notes: () => notes?.quitting?.(runningWorkspaces()),
    flushAll: () => i.flushAll?.(),
    quit: () => app.quit(),
    onBeforeQuit: (fn) => { app.on('before-quit', fn) },
    onWindowAllClosed: (fn) => { app.on('window-all-closed', fn) },
    alert: restartAlertBox,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    log: j,
    record: (b) => record('update', null, b),
  })

  if (__MV_TEST__) testHooks()
}

/**
 * #17's alert (A5.1): app-modal - the window and every view are gone - with one button, Quit. A test build never puts
 * it on the screen: it is kept for the `shutdown:alerts` hook and held until the case answers (`shutdown:alert-answer`),
 * so the case reads it before the quit that follows.
 */
const restartAlerts: RestartAlert[] = []
let alertHeld: (() => void) | null = null
async function restartAlertBox(a: RestartAlert): Promise<void> {
  if (__MV_TEST__ && testMode()) {
    restartAlerts.push(a)
    j('alert', a)
    await new Promise<void>((r) => { alertHeld = r })
    return
  }
  await dialog.showMessageBox({ type: 'warning', message: a.message, detail: a.detail, buttons: [...a.buttons], defaultId: 0, noLink: true })
}

/**
 * What macOS lets main observe of the native roles (#53): each a `window` line, `cause: 'app'` when a command asked for
 * it. Hide and show are not recorded - macOS sends them for occlusion too (present.ts's note) - but a window that hides
 * or minimizes ends the wait of a command on a `shown` it can no longer draw (#49).
 */
function watchWindowEvents(): void {
  const win = mainWindow()
  if (!win) return
  for (const event of WINDOW_EVENTS) win.on(event as 'minimize', () => record('window', null, { event, cause: windowCause(event) }))
  win.on('hide', cmdWindowGone)
  win.on('minimize', cmdWindowGone)
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
    state: displayState(t, t === activeTab()), reg: t.reg ? { state: t.reg.state, instance: t.reg.instance, origin: t.reg.origin, port: t.reg.port, slot: t.reg.slot, ws: t.reg.ws } : null,
    doc: t.doc ? { ...t.doc } : null, reports: { ...t.reports }, crash: { ...t.crash }, fail: t.fail ?? null, probe: t.probe ?? null,
    hung: !!t.hung, held: t.held ?? null, replacing: !!t.replacing, key: keyOf(t), look: t.look ?? null, logo: t.logo ?? null,
    hasView: canvases.has(t.id) || !!contentView(t.id), wcId: contentView(t.id)?.webContents?.id ?? null, pageView: !!pageView(t.id),
    geo: { ...t.geo },
    // A3's unloading (A3.8 #39-#45)
    unload: t.unload ? { ...t.unload } : null, unloadRefused: t.unloadRefused ?? null, hiddenAt: t.hiddenAt ?? null,
    audible: !!t.audible, devtools: !!t.devtools, loading: !!t.loading,
    // A4's shared canvas (A4.6 #39)
    remote: t.remote ? { ...t.remote } : null,
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
    pill: currentPill(), focus: focusOwner(), quitting: isQuitting(),
  }))
  provide('shutdown', () => shutdownState())
  provide('shutdown:alerts', () => ({ shown: [...restartAlerts], held: !!alertHeld }))
  provide('shutdown:alert-answer', () => { const r = alertHeld; alertHeld = null; r?.(); return !!r })
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
  // a webContents whose close never ends (code review r2 #1): every close() of it does nothing from now on, so an
  // unload's close never reaches destroyed - Electron's own teardown at the app's exit is not a close() call
  provide('closeNever', (a) => {
    const wc = wcOf(arg<{ target: string }>(a).target)
    if (!wc || wc.isDestroyed()) return false
    Object.defineProperty(wc, 'close', { value: () => { j('closeNever', { target: arg<{ target: string }>(a).target }) }, configurable: true, writable: true })
    return true
  })
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
      if (contentView(t.id)?.webContents?.isFocused()) out.push(`${t.id}:view`)
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
  // what an unload's admission reads, as Chromium reports it (A3.8 #40): a page playing sound, DevTools opened or
  // closed - emitted on the view's own webContents, so a case neither plays sound nor opens a window on the Mac
  provide('page:event', (a) => {
    const { target, event } = arg<{ target: string; event: 'audible' | 'silent' | 'devtools-opened' | 'devtools-closed' }>(a)
    const wc = wcOf(target)
    if (!wc || wc.isDestroyed()) return false
    if (event === 'audible' || event === 'silent') wc.emit('audio-state-changed', { audible: event === 'audible' })
    else wc.emit(event)
    return true
  })
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
  // an item with no id, by its menu's label and its own (A5: Help > Export Performance Report…), as built now
  provide('menu:clickLabel', (a) => {
    const { menu, label } = arg<{ menu: string; label: string }>(a)
    buildNow()
    const it = Menu.getApplicationMenu()?.items.find((m) => m.label === menu)?.submenu?.items.find((m) => m.label === label)
    if (!it || !it.enabled) return false
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
  // A4: an https link opened as ⌘L and Home open it (home.ts's openLink hands it here); net.isOnline() answered by
  // the case (null: Electron's own again)
  provide('remote:open', async (a) => openRemote(String(arg<{ url: string }>(a).url)))
  provide('remote:online', (a) => { const v = arg<{ online: boolean | null }>(a).online; onlineStub = typeof v === 'boolean' ? v : null; pollOnline(); return true })
}
