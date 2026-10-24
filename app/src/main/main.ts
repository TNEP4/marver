/**
 * The Marver Mac app's main process (spec 28 A2.1, A2.14 #30, #32). The startup order is pinned:
 *
 *   1. the debugging guard (the first import, synchronous; release flavour)
 *   2. test spies (dev builds, MARVER_APP_TEST=1 and MARVER_APP_SPY=1)
 *   3. Marver Dev's name and userData (dev builds)
 *   4. MARVER_APP_USER_DATA, when set (every build; v1.12 r1 #9) - it moves Chromium's profile and the lock
 *   5. the single-instance lock
 *   6. ensureHome()
 *   7. crashDumps and crashReporter.start
 *   8. the marver-app:// scheme
 *   9. the files' first read, and Home's state (first launch, Recently here)
 *  10. at ready: the theme and the files' watch, persist:app and its protocol, the web-contents-created hook
 *      (before any view), the registry, the bridge, the tabs' record, then views.ts: the window with the opaque
 *      strip and its pages (strip, Home, Settings, the tab pages), the tabs restored from tabs.json (only the
 *      active one loads; each canvas view on its repo's partition, its proof dispatcher attached before its first
 *      load), the menu, the quit through guardAll; then the Home and Settings channels (home.ts mountPages); and
 *      last the error policy (errors.ts): from here an uncaught error is recorded and the app goes on, never
 *      Electron's modal box over pages that may hold unsaved work.
 *
 * A3 (app 0.2, A3.8 #53): the bridge answers `mv:doc`'s inset from layout.ts; the recorder starts after the bridge
 * and before the views (its writer, the machine profile, the one sampler); memory.ts (unloading) and the white-out
 * detector start once the views and the tabs exist; the recorder's queue is written at will-quit.
 *
 * Who calls what across the streams is app/src/main/ports.ts's table; this file keeps the order and makes the calls.
 */
import './guard.ts'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app, crashReporter, protocol } from 'electron'
import { installSpies } from './testing/spies.ts'
import { note, provide, startTesting, testMode } from './testing/index.ts'
import { provideTrustHooks } from './testing/trust.ts'
import { overrideTimings } from './timings.ts'
import { totalmem } from 'node:os'
import { applyTheme, ensureHome, readFiles, readTabsFile, startFiles, tabsWriter, values } from './config.ts'
import { flushRecent, isFirstLaunch, mountPages, noteGone, noteHomeShown, noteVerified, startHome } from './home.ts'
import { installNavigationPolicy, localSession, onSameCanvasOpen, setupAppSession } from './sessions.ts'
import { installBridge } from './bridge.ts'
import { createRegistry, type RegistryEntry } from './registry.ts'
import { fetchLogo, installDispatcher, probeProof } from './proof.ts'
import { attachNav } from './nav.ts'
import { contentView, focusWindow, windowVisible } from './window.ts'
import { activeTab, getTab, startTabs, type Tab } from './tabs.ts'
import { docInset } from './layout.ts'
import { identity, recorder, sampler } from './recorder.ts'
import { provideRecorderHooks } from './testing/recorder.ts'
import { startMemory } from './memory.ts'
import { startWhiteout } from './whiteout.ts'
import { readAgx } from './machine.ts'
import { openSameCanvas, startViews, windowPorts, type TrustPort } from './views.ts'
import { fakeTrust } from './testing/fake-trust.ts'
import { installErrorPolicy, setErrorHome } from './errors.ts'

/** The app's own scheme for its pages (A2.5). */
export const APP_SCHEME = 'marver-app'
/** Exit codes: 3 is the guard's (guard.ts), so a smoke can tell it from any other end. */
export const EXIT_BAD_ENV = 2

function refuse(why: string): never {
  process.stderr.write(`marver-app: ${why}\n`)
  app.exit(EXIT_BAD_ENV)
  throw new Error(why)   // not reached: app.exit before ready ends the process at once (X7)
}

// 2. test spies, before any other line of the app touches Electron's APIs
if (__MV_TEST__ && testMode()) {
  installSpies()
  const missing = ['MARVER_HOME', 'MARVER_SLOT_BASE', 'MARVER_APP_USER_DATA'].filter((k) => !process.env[k])
  if (missing.length) refuse(`a test run needs ${missing.join(', ')} (spec 28 A2.14 #23)`)
  if (process.env.MARVER_APP_TIMINGS) overrideTimings(process.env.MARVER_APP_TIMINGS)
}

// 3. Marver Dev keeps apart: its own name, data, lock and partitions (A2.14 #23)
if (!__MARVER_RELEASE__) {
  app.setName('Marver Dev')
  app.setPath('userData', join(app.getPath('appData'), 'Marver Dev'))
}

// 4. a profile of its own, for tests and the smoke (every build: it moves only where Chromium keeps its
//    profile, and the lock with it; it turns nothing on)
const userData = process.env.MARVER_APP_USER_DATA
if (userData) {
  if (!isAbsolute(userData)) refuse('MARVER_APP_USER_DATA must be an absolute path')
  mkdirSync(userData, { recursive: true, mode: 0o700 })
  app.setPath('userData', userData)
}

// 5. one app per profile: a second launch focuses the window and quits
if (!app.requestSingleInstanceLock()) app.quit()
else start()

function start(): void {
  if (__MV_TEST__) startTesting()

  // 6. ~/.marver (MARVER_HOME honoured), before the crash reporter that writes into it
  const home = ensureHome()
  if (__MV_TEST__) note('startup', { step: 'home', home })

  // 7. crash dumps under ~/.marver/perf/crashpad, never uploaded
  if (home.writable) {
    app.setPath('crashDumps', home.crashpad)
    crashReporter.start({ uploadToServer: false })
  }

  // 8. the app pages' scheme (served on persist:app only, sessions.ts)
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }])

  // 9. the files, read once before ready; Home's state (first launch, Recently here)
  const files = readFiles(home)
  startHome()

  app.on('second-instance', () => focusWindow())

  // 10. at ready
  void app.whenReady().then(async () => {
    applyTheme(files)
    startFiles()
    setupAppSession()
    installNavigationPolicy()

    // the registry: ~/.marver/running/ read, then watched and reconciled every 5 s
    const registry = createRegistry()
    await registry.start()
    // the bridge: the capability map, the canvas admission, the app pages' channels - before any view. `mv:doc`
    // answers each document's inset from its tab's layout (A3.8 #26)
    const bridge = installBridge({ insetFor: (id) => { const t = getTab(id); return t ? docInset(t) : 0 } })
    if (__MV_TEST__ && testMode()) provideTrustHooks()
    startTabs()
    // the recorder: after the bridge, before the views (A3.8 #53)
    recorder.start({ bridge, home, flavour: __MARVER_RELEASE__ ? 'release' : 'dev', config: () => values().config })
    if (__MV_TEST__ && testMode()) provideRecorderHooks()
    app.on('will-quit', () => recorder.flushSync())

    // what the window stream needs of the trust stream (views.ts TrustPort), from their interfaces as built
    const entryOf = (t: Pick<Tab, 'reg'>): RegistryEntry | undefined => t.reg ? registry.entries().find((e) => e.instance === t.reg!.instance) : undefined
    const real: TrustPort = {
      // the repo's partition, its service workers cleared, and its one proof dispatcher, before its first navigation
      async session(ws) {
        const ses = await localSession(ws)
        installDispatcher(ses)
        return ses
      },
      // per canvas view, before its first loadURL: the adapter, then the dispatcher's target - the tab's bound entry,
      // read at each request (tabs.ts rebinds `reg` synchronously in the registry's listener, so a restarted canvas's
      // own reload is attributed to its new instance; the dispatcher keeps the last target while there is none)
      attach(wc, tab) {
        const nav = attachNav(wc)
        const ses = wc.session
        installDispatcher(ses).attach(wc.id, () => { const e = entryOf(tab); return e ? { entry: e, gen: () => nav.stamp() } : undefined })
        const id = wc.id
        wc.once('destroyed', () => installDispatcher(ses).detach(id))
        return nav
      },
      admit: (tabId) => bridge.admit(tabId),
      register: (wc, kind, tabId) => bridge.register(wc, kind, tabId),
      entries: () => registry.entries(),
      entryFor: (t) => entryOf(t),
      onRegistry: (fn) => registry.on(fn),
      onReport: (fn) => bridge.onReport(fn),
      appState: (tabId, s) => s === 'untrusted' ? false : bridge.appState(tabId, s),   // untrusted: the bridge sends it itself
      menuClick: (tabId, id) => bridge.menuClick(tabId, id),
      reopenNext: (tabId) => bridge.reopenNext(tabId),
      reopenCancel: (tabId) => bridge.reopenCancel(tabId),
      present: (tabId, doc, r) => bridge.present(tabId, doc, r),
      onPresented: (fn) => bridge.onPresented(fn),
      probe: async (t) => { const e = entryOf(t); return e ? probeProof(e) : 'silent' },
      fetchLogo: async (t, signal) => { const e = entryOf(t); return e ? ((await fetchLogo(e, signal))?.dataUrl ?? null) : null },
      pages: {
        onReady: (fn) => { bridge.onReady((ctx) => fn(ctx.wc)) },
        handle: (ch, fn) => bridge.handle(ch, (ctx, p) => fn(ctx.wc, p)),
        send: (wc, ch, payload) => bridge.send(wc, ch, payload),
      },
    }
    // a canvas's same-origin window.open of its own document: its tab, through the guard (A2.14 #4)
    onSameCanvasOpen(openSameCanvas)
    const trust = __MV_TEST__ && testMode() && process.env.MARVER_APP_FAKE_TRUST === '1' ? fakeTrust() : real

    // the window, its pages, the tabs restored, the menu, the guarded quit (views.ts); tabs.json and Recently here
    // are config.ts's and home.ts's files (ports.ts)
    startViews({
      trust, home, files,
      firstLaunch: isFirstLaunch(),
      notes: { homeShown: noteHomeShown, verified: noteVerified, gone: noteGone, quitting: flushRecent },
      tabsStore: { read: readTabsFile, set: (f) => tabsWriter().set(f), flushSync: () => tabsWriter().flushSync() },
    })
    // Home's and Settings' channels and pushes, ⌘L's links into their tabs, the files pill (home.ts, ports.ts)
    mountPages(bridge, windowPorts())
    // unloading under pressure, on the one sampler's samples (A3.8 #41), and the white-out detector (A3.8 #15)
    startMemory({
      config: () => values().config, sampler, totalMB: () => totalmem() / 2 ** 20,
      event: (kind, who, body) => recorder.event(kind, who, body), now: () => Date.now(),
    })
    startWhiteout({
      recorderOn: () => values().config.recorder,
      target: () => {
        const t = activeTab()
        const wc = t?.kind === 'local' ? contentView(t.id)?.webContents : undefined
        return t && wc && !wc.isDestroyed() && windowVisible() ? { tabId: t.id, wc, ident: identity(t) } : null
      },
      onPerf: (fn) => bridge.onPerf(fn),
      ask: (tabId, a) => bridge.perfAsk(tabId, a),
      gpuEvents: (from, to) => recorder.gpuEvents(from, to),
      readAgx: (ms) => readAgx(ms),
      record: (ident, body) => recorder.event('whiteout-candidate', ident, body),
      now: () => Date.now(),
    })
    // the pages exist: an uncaught error is recorded (perf/app.jsonl) and the app goes on (errors.ts)
    setErrorHome(home)
    installErrorPolicy()
    if (__MV_TEST__ && testMode()) {
      // an error nothing catches, thrown in a later turn as an event handler's would be (the error policy's cases)
      provide('throw', (a) => {
        const what = (a as { what?: unknown } | null)?.what === 'rejection' ? 'rejection' : 'exception'
        setTimeout(() => {
          if (what === 'rejection') void Promise.reject(new Error('mv-test: a rejection nothing caught'))
          else throw new Error('mv-test: an exception nothing caught')
        }, 0)
        return true
      })
    }
    if (__MV_TEST__) note('startup', { step: 'ready' })
  })
}
