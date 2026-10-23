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
import { app, crashReporter, protocol, type WebContents } from 'electron'
import { installSpies } from './testing/spies.ts'
import { note, startTesting, testMode } from './testing/index.ts'
import { provideTrustHooks } from './testing/trust.ts'
import { overrideTimings } from './timings.ts'
import { applyTheme, ensureHome, readFiles } from './config.ts'
import * as sessions from './sessions.ts'
import { installNavigationPolicy, localSession, setupAppSession } from './sessions.ts'
import { installBridge, type Bridge } from './bridge.ts'
import { createRegistry } from './registry.ts'
import * as proof from './proof.ts'
import { installDispatcher } from './proof.ts'
import { attachNav } from './nav.ts'
import type { AppState } from '../../../src/shared/app-api.ts'
import type { PageKind } from '../shared/channels.ts'
import { focusWindow } from './window.ts'
import { startTabs } from './tabs.ts'
import { buildMenu } from './menu.ts'
import { openSameCanvas, startViews, type TrustPort } from './views.ts'
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
    if (__MV_TEST__ && testMode()) provideTrustHooks()
    buildMenu()
    startTabs()
    // the window, the tabs (restored), the menu: views.ts, against the trust stream's interfaces. What the frozen
    // stubs did not name yet (the bridge's appState / menuClick / reopenNext / page plumbing, proof's probeProof and
    // fetchLogo, sessions' onSameCanvasOpen) is reached when the trust stream's modules provide it.
    type FullBridge = Bridge & Partial<{
      appState(tabId: string, s: Exclude<AppState, 'untrusted'>): boolean
      menuClick(tabId: string, id: string): boolean
      reopenNext(tabId: string): void
      onReady(fn: (ctx: { wc: WebContents; kind: PageKind; tabId?: string }) => void): () => void
      handle(channel: string, fn: (ctx: { wc: WebContents; kind: PageKind; tabId?: string }, payload: unknown) => unknown): void
      send(target: PageKind | WebContents, channel: string, payload: unknown): boolean
    }>
    const b = bridge as FullBridge
    const p2 = proof as typeof proof & Partial<{
      probeProof(e: ReturnType<typeof registry.entries>[number]): Promise<'proved' | 'answers' | 'silent'>
      fetchLogo(e: ReturnType<typeof registry.entries>[number], signal?: AbortSignal): Promise<{ dataUrl: string } | null>
    }>
    const entryOf = (t: { reg?: { instance: string } }) => registry.entries().find((e) => e.instance === t.reg?.instance)
    const real: TrustPort = {
      async session(ws) {
        const ses = await localSession(ws)
        installDispatcher(ses)   // the session's one dispatcher (a second call gives the same one)
        return ses
      },
      attach(wc, tab) {
        const nav = attachNav(wc)   // one adapter per webContents, shared with the bridge
        if (tab.reg) {
          void localSession(tab.reg.ws).then((ses) => installDispatcher(ses).attach(wc.id, () => { const e = entryOf(tab); return e ? { entry: e, gen: () => nav.stamp() } : undefined }))
          wc.once('destroyed', () => { if (tab.reg) void localSession(tab.reg.ws).then((ses) => installDispatcher(ses).detach(wc.id)) })
        }
        return nav
      },
      admit: (tabId) => bridge.admit(tabId),
      register: (wc, kind, tabId) => bridge.register(wc, kind, tabId),
      entries: () => registry.entries(),
      entryFor: (t) => entryOf(t),
      onRegistry: (fn) => registry.on(fn),
      onReport: (fn) => bridge.onReport(fn),
      appState: (tabId, s) => s === 'untrusted' ? false : (b.appState?.(tabId, s) ?? false),   // untrusted: the bridge sends it itself
      menuClick: (tabId, id) => b.menuClick?.(tabId, id) ?? false,
      reopenNext: (tabId) => b.reopenNext?.(tabId),
      ...(p2.probeProof ? { probe: async (t: Parameters<NonNullable<TrustPort['probe']>>[0]) => { const e = entryOf(t); return e ? p2.probeProof!(e) : 'silent' } } : {}),
      ...(p2.fetchLogo ? { fetchLogo: async (t: Parameters<NonNullable<TrustPort['fetchLogo']>>[0], signal: AbortSignal) => { const e = entryOf(t); return e ? ((await p2.fetchLogo!(e, signal))?.dataUrl ?? null) : null } } : {}),
      ...(['onReady', 'handle', 'send'].every((k) => typeof (b as unknown as Record<string, unknown>)[k] === 'function') ? {
        pages: {
          onReady: (fn: (wc: WebContents) => void) => { b.onReady!((ctx) => fn(ctx.wc)) },
          handle: (ch: string, fn: (wc: WebContents, payload: unknown) => unknown) => b.handle!(ch, (ctx, p) => fn(ctx.wc, p)),
          send: (wc: WebContents, ch: string, payload: unknown) => b.send!(wc, ch, payload),
        },
      } : {}),
    }
    ;(sessions as typeof sessions & Partial<{ onSameCanvasOpen(fn: (wcId: number, url: string) => void): void }>).onSameCanvasOpen?.(openSameCanvas)
    const trust = __MV_TEST__ && testMode() && process.env.MARVER_APP_FAKE_TRUST === '1' ? fakeTrust() : real
    startViews({ trust, home, files, firstLaunch: !existsSync(join(home.state, 'launched')) })
    if (__MV_TEST__) note('startup', { step: 'ready' })
  })
}
