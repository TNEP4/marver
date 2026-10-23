/**
 * The Marver Mac app's main process (spec 28 A2.1, A2.14 #30). The startup order is pinned:
 *
 *   1. the debugging guard (the first import, synchronous; release flavour)
 *   2. test spies (dev builds, MARVER_APP_TEST=1 and MARVER_APP_SPY=1)
 *   3. Marver Dev's name and userData (dev builds)
 *   4. MARVER_APP_USER_DATA, when set (every build; v1.12 r1 #9) - it moves Chromium's profile and the lock
 *   5. the single-instance lock
 *   6. ensureHome()
 *   7. crashDumps and crashReporter.start
 *   8. the marver-app:// scheme
 *   9. the files' first read
 *  10. at ready: the theme, persist:app and its protocol, the web-contents-created hook (before any view),
 *      the bridge, the registry, then views.ts: the window, the tabs (restored from tabs.json; only the active
 *      one loads), the menu, the guarded quit.
 *
 * Every module below is a skeleton its stream fills (see each file's header); this file keeps the order.
 */
import './guard.ts'
import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app, crashReporter, protocol } from 'electron'
import { installSpies } from './testing/spies.ts'
import { note, startTesting, testMode } from './testing/index.ts'
import { overrideTimings } from './timings.ts'
import { applyTheme, ensureHome, readFiles } from './config.ts'
import { installNavigationPolicy, localSession, setupAppSession } from './sessions.ts'
import { installBridge } from './bridge.ts'
import { createRegistry } from './registry.ts'
import { installDispatcher, type Dispatcher } from './proof.ts'
import { attachNav } from './nav.ts'
import { focusWindow } from './window.ts'
import { startTabs } from './tabs.ts'
import { buildMenu } from './menu.ts'
import { startViews, type TrustPort } from './views.ts'
import { fakeTrust } from './testing/fake-trust.ts'

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

  // 9. the files, read once before ready
  const files = readFiles(home)

  app.on('second-instance', () => focusWindow())

  // 10. at ready
  void app.whenReady().then(async () => {
    applyTheme(files)
    setupAppSession()
    installNavigationPolicy()
    const bridge = installBridge()
    const registry = createRegistry()
    await registry.start()
    buildMenu()
    startTabs()
    // the window, the tabs (restored), the menu: views.ts, against the trust stream's frozen interfaces
    const dispatchers = new Map<string, Dispatcher>()
    const real: TrustPort = {
      async session(ws) {
        const ses = await localSession(ws)
        if (!dispatchers.has(ws)) dispatchers.set(ws, installDispatcher(ses))
        return ses
      },
      attach(wc, tab) {
        const nav = attachNav(wc)
        const entry = () => registry.entries().find((e) => e.instance === tab.reg?.instance)
        if (tab.reg) dispatchers.get(tab.reg.ws)?.attach(wc.id, () => { const e = entry(); return e ? { entry: e, gen: () => nav.stamp() } : undefined })
        wc.once('destroyed', () => { if (tab.reg) dispatchers.get(tab.reg.ws)?.detach(wc.id) })
        return nav
      },
      admit: (tabId) => bridge.admit(tabId),
      register: (wc, kind, tabId) => bridge.register(wc, kind, tabId),
      entries: () => registry.entries(),
      entryFor: (t) => registry.entries().find((e) => e.instance === t.reg?.instance),
      onRegistry: (fn) => registry.on(fn),
      onReport: (fn) => bridge.onReport(fn),
    }
    const trust = __MV_TEST__ && testMode() && process.env.MARVER_APP_FAKE_TRUST === '1' ? fakeTrust() : real
    startViews({ trust, home, files, firstLaunch: !existsSync(join(home.state, 'launched')) })
    if (__MV_TEST__) note('startup', { step: 'ready' })
  })
}
