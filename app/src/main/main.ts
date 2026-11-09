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
 *      load), the menu, the shutdown coordinator (shutdown.ts: the quit through guardAll); then the Home and Settings
 *      channels (home.ts mountPages); and
 *      last the error policy (errors.ts): from here an uncaught error is recorded and the app goes on, never
 *      Electron's modal box over pages that may hold unsaved work.
 *
 * A3 (app 0.2, A3.8 #53): the bridge answers `mv:doc`'s inset from layout.ts; the recorder starts after the bridge
 * and before the views (its writer, the machine profile, the one sampler); memory.ts (unloading) and the white-out
 * detector start once the views and the tabs exist; the recorder's queue is written at will-quit.
 *
 * A4 (app 0.3, A4.6 #16-#29): once the views and Home's channels exist, the live streams (live.ts) and the notices
 * (notify.ts) start, hearing the registry after the tabs do; the streams end and notices.json is written at will-quit.
 * A4 (app 0.3): live pictures (live-picture.ts, A4.6 #35) take the bridge's `mv:capture` asks once the views exist, as
 * the white-out detector does; the bridge checks each rect against the tab's view (`viewSize`).
 *
 * A5 (app 1.0, A5.1 #13, #23): a build with a feed offers Move to Applications at ready, before the registry, the views
 * and any tab (mover.ts); once the views exist the updater starts (updater.ts), and Restart to Update goes through the
 * shutdown coordinator views.ts starts (shutdown.ts).
 *
 * Who calls what across the streams is app/src/main/ports.ts's table; this file keeps the order and makes the calls.
 */
import './guard.ts'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app, crashReporter, dialog, powerMonitor, protocol, shell } from 'electron'
import { installSpies } from './testing/spies.ts'
import { note, provide, startTesting, testMode } from './testing/index.ts'
import { provideTrustHooks } from './testing/trust.ts'
import { overrideTimings } from './timings.ts'
import { totalmem } from 'node:os'
import { applyTheme, ensureHome, noticesState, noticesWriter, onChange, readFiles, readTabsFile, readUpdateFile, setNoticesState, settingsSet, startFiles, tabsWriter, values, writeUpdateFile } from './config.ts'
import { flushRecent, flushShared, isFirstLaunch, mountPages, noteGone, noteHomeShown, noteShared, noteVerified, startHome } from './home.ts'
import { installNavigationPolicy, localSession, onSameCanvasOpen, remoteTestSwitches, setupAppSession } from './sessions.ts'
import { installBridge } from './bridge.ts'
import { createRegistry, type RegistryEntry } from './registry.ts'
import { fetchLogo, installDispatcher, probeProof } from './proof.ts'
import { attachNav } from './nav.ts'
import { appCmd } from './commands.ts'
import { contentView, focusWindow, mainWindow, onCompose, onFront, pageView, refreshTabs, windowInFront, windowVisible } from './window.ts'
import { activeTab, getTab, liveDoc, openForNotice, setMarksSource, setOpenSender, setShowSender, showForLink, startTabs, type Tab } from './tabs.ts'
import { createLive } from './live.ts'
import { createNotify, type Notify } from './notify.ts'
import { presenter } from './notify-mac.ts'
import { provideNoticeHooks } from './testing/notices.ts'
import { confirm, setCondition, setOfferActions } from './pill.ts'
import { effects } from './effects.ts'
import { savePdf } from './pdf-save.ts'
import { writeWhole } from './fsx.ts'
import { CH } from '../shared/channels.ts'
import { docInset } from './layout.ts'
import { identity, recorder, sampler } from './recorder.ts'
import { launchReady, launchWriter } from './launch.ts'
import { provideRecorderHooks } from './testing/recorder.ts'
import { provideFlashHooks } from './testing/flash.ts'
import { startMemory } from './memory.ts'
import { startWhiteout } from './whiteout.ts'
import { livePictures } from './live-picture.ts'
import { genOf, quitting as presentQuitting } from './present.ts'
import { readAgx } from './machine.ts'
import { openOutside, openSameCanvas, showOutside, startViews, windowPorts, type TrustPort } from './views.ts'
import { bundleOf, startUpdater } from './updater.ts'
import { nodeMoverPorts, offerMove, takeMoveCmd } from './mover.ts'
import type { UpdateBody } from '../../../src/shared/app-perf.ts'
import { fakeTrust } from './testing/fake-trust.ts'
import { installErrorPolicy, setErrorHome } from './errors.ts'
import { createLinkQueue } from './deep-link.ts'
import { DEEP_LINK_SCHEME, deepLinkArg } from '../../../src/shared/deep-link.ts'
import { startAppLive } from './app-live.ts'
import { fetchUpdate } from './canvas-fetch.ts'
import { openDeepLink } from './views.ts'
import { allTabs } from './tabs.ts'
import { realpathSync } from 'node:fs'

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
  // the remote harness's *.test hosts resolved to it, before Chromium's network service starts (A4.6 #50)
  remoteTestSwitches()
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

  // spec 31 D1: `marver://` links - the scheme claimed by the release app alone (a dev build never takes it from the app
  // in use), each link heard (open-url, also before ready at a cold start; a second launch's argv) held until the
  // registry and the tabs are ready, then routed (views.ts openDeepLink)
  const links = createLinkQueue()
  if (__MARVER_RELEASE__) { try { app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME) } catch { /* the Info.plist's claim stands */ } }
  app.on('open-url', (e, url) => { e.preventDefault(); links.push(url) })
  app.on('second-instance', (_e, argv) => {
    const link = deepLinkArg(argv)
    if (link) { links.push(link); return }
    const h = appCmd('relaunch', { via: 'click', in: 'main' }); focusWindow(); h.done()   // spec 30 R12
  })

  // 10. at ready
  void app.whenReady().then(async () => {
    launchReady()   // spec 30 #37: ms from process start
    applyTheme(files)
    startFiles()

    // Move to Applications (A5.1 #23): before the registry, the views or any tab, so nothing editable exists and nothing
    // needs a guard. Only a build with a feed looks. A copy that moved itself, or opened the one already there, ends
    // here - its relaunch waits for this process to go, and no listener of ours holds the quit. Its records wait for
    // the recorder; on those two paths they never land, and the moved copy records the move at its first launch
    const moveRecords: UpdateBody[] = []
    if (__MARVER_FEED__) {
      const bundle = bundleOf(app.getPath('exe'))
      let inApplications = false
      try { inApplications = app.isInApplicationsFolder() } catch { /* outside, as far as anyone can tell */ }
      if (bundle && await offerMove(nodeMoverPorts({
        bundle, version: app.getVersion(), read: readUpdateFile, write: writeUpdateFile, record: (b) => { moveRecords.push(b) },
        ask: async (a) => {
          const r = await dialog.showMessageBox({ type: 'info', message: a.message, detail: a.detail, buttons: a.buttons, defaultId: 0, cancelId: a.buttons.length - 1, noLink: true, ...(a.checkbox ? { checkboxLabel: a.checkbox } : {}) })
          return { button: a.buttons[r.response] ?? a.buttons.at(-1)!, checked: r.checkboxChecked }
        },
        reveal: (paths) => { for (const p of paths) shell.showItemInFolder(p) },
        quit: () => app.quit(),
      }), { feed: __MARVER_FEED__, inApplications }) === 'quit') return
    }

    setupAppSession()
    installNavigationPolicy()

    // the registry: ~/.marver/running/ read, then watched and reconciled every 5 s
    const registry = createRegistry()
    await registry.start()
    // the bridge: the capability map, the canvas admission, the app pages' channels - before any view. `mv:doc`
    // answers each document's inset from its tab's layout (A3.8 #26)
    const bridge = installBridge({
      insetFor: (id) => { const t = getTab(id); return t ? docInset(t) : 0 },
      // the tab's view in CSS px: its bounds over its zoom (mv:capture's rect lies inside it, A4.6 #35)
      viewSize: (id) => {
        const v = contentView(id), wc = v?.webContents
        if (!v || !wc || wc.isDestroyed()) return null
        const b = v.getBounds(), z = wc.getZoomFactor() || 1
        return { width: b.width / z, height: b.height / z }
      },
    })
    if (__MV_TEST__ && testMode()) provideTrustHooks()
    startTabs()
    // the recorder: after the bridge, before the views (A3.8 #53)
    recorder.start({ bridge, home, flavour: __MARVER_RELEASE__ ? 'release' : 'dev', config: () => values().config })
    for (const b of moveRecords) recorder.event('update', null, b)
    launchWriter((b) => recorder.event('launch', null, b))
    takeMoveCmd(readUpdateFile, writeUpdateFile)                     // spec 30's move-to-apps, durable until a recorder exists
    if (__MV_TEST__ && testMode()) { provideRecorderHooks(); provideFlashHooks(home) }
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
      menuClick: (tabId, id, where) => bridge.menuClick(tabId, id, where),
      reopenNext: (tabId) => bridge.reopenNext(tabId),
      reopenCancel: (tabId) => bridge.reopenCancel(tabId),
      present: (tabId, doc, r) => bridge.present(tabId, doc, r),
      onPresented: (fn) => bridge.onPresented(fn),
      probe: async (t) => { const e = entryOf(t); return e ? probeProof(e) : 'silent' },
      fetchLogo: async (t, signal) => { const e = entryOf(t); return e ? ((await fetchLogo(e, signal))?.dataUrl ?? null) : null },
      // spec 31 E4: through the canvas's own partition, no redirect, bounded (canvas-fetch.ts)
      fetchUpdate: async (t, signal) => {
        const e = entryOf(t)
        if (!e || e.state !== 'ready' || !e.origin) return null
        const ses = await localSession(e.ws)
        return fetchUpdate((url, init) => ses.fetch(url, init), e.origin, signal)
      },
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
      notes: { homeShown: noteHomeShown, verified: noteVerified, gone: noteGone, shared: noteShared, quitting: (running) => { flushRecent(running); flushShared() } },
      tabsStore: { read: readTabsFile, set: (f) => tabsWriter().set(f), flushSync: () => tabsWriter().flushSync() },
      // the shutdown's flushAll (A5.1 #15): what will-quit also writes, once more at `done`, before the end - the
      // presentation records first (they are the recorder's lines), the recorder's queue, notices.json
      flushAll: () => {
        presentQuitting(Date.now())
        recorder.flushSync()
        try { noticesWriter().flushSync() } catch { /* a report, never the quit's */ }
      },
    })
    // Home's and Settings' channels and pushes, ⌘L's links into their tabs, the files pill (home.ts, ports.ts)
    mountPages(bridge, windowPorts())
    // the updater, once the views exist - the pill and the menu are there (A5.1 #13): #18's reconciliation, then its
    // gates and setup; the shutdown coordinator gets its update side
    startUpdater({ record: (b) => recorder.event('update', null, b), openExternal: openOutside, reveal: showOutside })
    startNotices(trust, bridge)
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
    // a canvas's live picture of its own view, while the person sees it (A4.6 #35)
    bridge.onCapture(livePictures({
      look: (tabId) => {
        const t = getTab(tabId), v = contentView(tabId), wc = v?.webContents
        if (!t || !v || !wc || wc.isDestroyed()) return null
        return {
          wc, active: activeTab() === t, live: liveDoc(t), trusted: !!t.doc?.trusted, doc: t.doc?.doc, commits: t.doc?.commits ?? 0, gen: genOf(tabId),
          windowShown: windowVisible(), viewShown: v.getVisible() && !pageView(tabId)?.getVisible(),
        }
      },
    }))
    // spec 31 D2: app-live.json, for `marver link` - the release app's state/ folder, every 30 s and soon after a change
    const realOf = (p: string) => { try { return realpathSync(p) } catch { return p } }
    const live = startAppLive({
      dir: () => (home.writable ? home.state : undefined), pid: process.pid, version: app.getVersion(), now: () => Date.now(),
      scheme: () => { try { return __MARVER_RELEASE__ && app.isDefaultProtocolClient(DEEP_LINK_SCHEME) } catch { return false } },
      workspaces: () => allTabs().filter((t) => t.kind === 'local' && t.open && !!t.root && t.reg?.state !== 'gone').map((t) => realOf(t.root!)),
    })
    trust.onRegistry(() => live.changed())
    onCompose(() => live.changed())
    app.on('will-quit', () => live.stop())
    // spec 31 D1: the registry and the tabs exist - the links held since launch go now, and each later one at once
    links.ready((raw) => {
      const h = appCmd('deep-link', { via: 'click', in: 'main' })
      if (openDeepLink(raw) === 'bad') h.noop('bad'); else h.done()
    })
    if (__MV_TEST__ && testMode()) provide('deep-link', (a) => { links.push((a as { url?: unknown } | null)?.url); return true })
    // spec 31: File > Export PDF… and the shell's Export PDF - the finished job fetched from the canvas on the tab's own
    // session, saved where the panel says (pdf-save.ts)
    bridge.onExportPdf((ask, still) => savePdf(ask.job, {
      origin: ask.origin,
      fetch: (url, headers) => ask.wc.session.fetch(url, { headers, redirect: 'error', credentials: 'include' }),
      csrf: async () => (await ask.wc.session.cookies.get({ url: ask.origin, name: 'mv_c' }))[0]?.value ?? null,
      downloads: () => app.getPath('downloads'),
      savePanel: (path) => effects.savePanel(path, windowVisible() ? mainWindow() : null, 'pdf'),
      still,
      write: (file, bytes) => writeWhole(file, bytes, 0o644),
    }))
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

/**
 * A4 (A4.6 #16-#29): one live stream per running canvas that lists `live` (live.ts), and every notices rule on them
 * (notify.ts) - the marks in the tabs' views, the notices through the presenter (notify-mac.ts, or a test build's
 * fake), the badge, the offer in the pill, a click held for its tab's document (tabs.ts) and sent by the bridge.
 */
function startNotices(trust: TrustPort, bridge: ReturnType<typeof installBridge>): void {
  const j = (topic: string, data: unknown) => { if (__MV_TEST__) note(topic, data) }
  let notify: Notify | null = null
  const live = createLive({ changed: (instance, why) => notify?.onLive(instance, why), log: j })
  notify = createNotify({
    now: () => Date.now(),
    presenter,
    held: (instance) => live.held(instance),
    config: () => values().config,
    turnOn: async () => (await settingsSet({ file: 'config', key: 'notifications', value: true })).ok,
    inFront: windowInFront,
    state: noticesState,
    setState: setNoticesState,
    offer: (on) => setCondition('offer', on
      ? { lead: 'Get a notice when a canvas needs you', text: '', short: 'Turn On Notices', button: { label: 'Turn On', style: 'accent' }, dismissible: true }
      : null),
    missed: (name) => confirm('notice-missed', { lead: name, text: 'needs you', short: 'Needs you' }),
    refresh: refreshTabs,
    open: (tabId, item) => { focusWindow(); openForNotice(tabId, item) },
    log: j,
  })
  const n = notify
  setMarksSource((t) => n.marksOf(t))
  setOpenSender((t, item) => bridge.openItem(t.id, item))
  // spec 31 D1, D3: a link's place to an open tab's document; a `marver show` the shell showed brings its tab forward
  setShowSender((t, target) => bridge.showItem(t.id, target))
  bridge.onFront((tabId) => { if (getTab(tabId)?.kind !== 'local') return; focusWindow(); showForLink(tabId, null) })
  setOfferActions({ turnOn: () => { void n.offerTurnOn() }, dismissed: () => n.offerDismissed() })
  bridge.handle(CH.settingsAction, () => effects.openNotificationSettings())
  // after views.ts's listener: the tabs have heard the event first (a stop reads whether its tab is open)
  trust.onRegistry((e) => { live.onRegistry(e); n.onRegistry(e) })
  live.start(trust.entries())
  onChange((f) => { if (f === 'config') n.onConfig() })
  onFront(() => n.onFront())
  onCompose(() => n.onCompose())
  powerMonitor.on('resume', () => live.resume())
  app.on('will-quit', () => {
    live.close()
    n.close()
    try { noticesWriter().flushSync() } catch { /* a report, never the quit's */ }
  })
  if (__MV_TEST__ && testMode()) {
    provideNoticeHooks()
    provide('live', () => live.dump())
    provide('notify', () => n.dump())
  }
}
