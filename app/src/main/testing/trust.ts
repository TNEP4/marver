/**
 * The trust stream's test hooks (dev builds, MARVER_APP_TEST=1; spec 28 A2.10, A2.14 #27). They stand in for the
 * window stream's tabs as the frozen interfaces wire a canvas view - `localSession(ws)`, `canvasWebPreferences`,
 * `attachNav`, the dispatcher's `attach(wcId, target)`, `bridge.register(wc, 'canvas', tabId)` - so the trust cases
 * run on the real modules before tabs.ts exists: a test tab binds to a registry entry by port, follows a new
 * instance of its workspace on that port or origin (a rebind), and keeps its last entry while gone (proof.ts's
 * ProofTarget contract). Nothing here reloads or loads a tab on a registry change: loads happen only when a case
 * asks. Every hook answers with plain data - never a key.
 */
import { BaseWindow, ipcMain, session, WebContentsView, webContents, type WebContents } from 'electron'
import { installBridge, kindOf, type CanvasReports } from '../bridge.ts'
import { attachNav, type NavAdapter, type NavEvent } from '../nav.ts'
import { fetchLogo, installDispatcher, isTrusted, probeProof } from '../proof.ts'
import { appRegistry, publicEntry, type RegistryEntry } from '../registry.ts'
import { APP_PARTITION, appWebPreferences, canvasWebPreferences, localSession, onSameCanvasOpen, pinnedUrl, type AppPage } from '../sessions.ts'
import { mainWindow } from '../window.ts'
import { provide } from './index.ts'

interface TestTab {
  id: string
  ws: string
  port: number
  entry: RegistryEntry
  view: WebContentsView
  wc: WebContents
  nav: NavAdapter
  events: { t: number; e: NavEvent; trusted: boolean }[]
  reports: { t: number; doc: string; r: CanvasReports }[]
}

const tabs = new Map<string, TestTab>()
const sameCanvas: { wc: number; url: string }[] = []
let n = 0
let win: BaseWindow | null = null

const arg = <T>(a: unknown, k: string): T => (a as Record<string, T> | null)?.[k] as T
function tab(a: unknown): TestTab {
  const t = tabs.get(arg<string>(a, 'id'))
  if (!t || t.wc.isDestroyed()) throw new Error('no such test tab')
  return t
}
function host(): BaseWindow {
  const w = mainWindow()
  if (w && !w.isDestroyed()) return w
  if (!win || win.isDestroyed()) win = new BaseWindow({ width: 1000, height: 700, show: false })
  return win
}

export function provideTrustHooks(): void {
  const bridge = installBridge()
  provideBridgeHooks()
  let followed = false
  bridge.onReport((tabId, doc, r) => { tabs.get(tabId)?.reports.push({ t: Date.now(), doc, r }) })

  provide('trust:registry', () => (appRegistry()?.entries() ?? []).map(publicEntry))
  provide('trust:reread', async () => { await appRegistry()?.reread(); return (appRegistry()?.entries() ?? []).map(publicEntry) })

  provide('trust:open', async (a) => {
    const reg = appRegistry()
    if (!reg) throw new Error('no registry')
    if (!followed) {
      followed = true
      onSameCanvasOpen((wc, url) => { sameCanvas.push({ wc, url }) })
      reg.on((e) => {
        if (e.kind !== 'entry') return
        for (const t of tabs.values()) {
          const x = e.entry
          if (x.ws !== t.ws) continue
          if (x.state === 'starting' ? x.port === t.port : x.origin === t.entry.origin || x.port === t.port) { t.entry = x; t.port = x.port }
        }
      })
    }
    const port = arg<number>(a, 'port')
    const entry = reg.byPort(port)
    if (!entry) throw new Error(`no canvas on port ${port}`)
    await localSession(entry.ws)
    const view = new WebContentsView({ webPreferences: canvasWebPreferences(entry.ws) })
    const wc = view.webContents
    const id = `t${(++n).toString(36)}`
    const t: TestTab = { id, ws: entry.ws, port, entry, view, wc, nav: attachNav(wc), events: [], reports: [] }
    tabs.set(id, t)
    t.nav.on((e) => { t.events.push({ t: Date.now(), e, trusted: isTrusted(wc.id) }) })
    const ses = await localSession(entry.ws)
    installDispatcher(ses).attach(wc.id, () => ({ entry: t.entry, gen: () => t.nav.stamp() }))
    bridge.register(wc, 'canvas', id)
    const w = host()
    const [width, height] = w.getContentSize()
    view.setBounds({ x: 0, y: 44, width, height: height - 44 })
    w.contentView.addChildView(view)
    const path = arg<string | undefined>(a, 'path') ?? '/'
    if (arg<boolean | undefined>(a, 'load') !== false && entry.origin) void wc.loadURL(entry.origin + path).catch(() => {})
    return { id, wc: wc.id }
  })

  provide('trust:tab', (a) => {
    const t = tab(a)
    return {
      id: t.id, wc: t.wc.id, trusted: isTrusted(t.wc.id), url: t.wc.getURL(), origin: t.wc.mainFrame.origin,
      commits: t.nav.commits(), committed: t.nav.committed(), gen: t.nav.gen(), entry: publicEntry(t.entry),
      events: t.events, reports: t.reports, current: bridge.reports(t.id), kind: kindOf(t.wc.id),
    }
  })
  provide('trust:eval', async (a) => {
    const t = tab(a)
    return await t.wc.mainFrame.executeJavaScript(arg<string>(a, 'js'), arg<boolean | undefined>(a, 'gesture') ?? false)
  })
  provide('trust:frame-eval', async (a) => {
    const t = tab(a)
    const f = t.wc.mainFrame.frames[arg<number>(a, 'index') ?? 0]
    if (!f) throw new Error('no such frame')
    return await f.executeJavaScript(arg<string>(a, 'js'), arg<boolean | undefined>(a, 'gesture') ?? false)
  })
  provide('trust:load', (a) => { const t = tab(a); void t.wc.loadURL(arg<string>(a, 'url')).catch(() => {}); return true })
  provide('trust:reload', (a) => { tab(a).wc.reload(); return true })
  provide('trust:stop', (a) => { tab(a).wc.stop(); return true })
  provide('trust:close', (a) => {
    const t = tab(a)
    host().contentView.removeChildView(t.view)
    t.wc.close()
    tabs.delete(t.id)
    return true
  })
  /** `close({ waitForBeforeUnload: true })`, as the guard's act does: true when the page actually closed within 1.5 s */
  provide('trust:close-guarded', async (a) => {
    const t = tab(a)
    const gone = new Promise<boolean>((r) => { t.wc.once('destroyed', () => r(true)); setTimeout(() => r(false), 1500) })
    t.wc.close({ waitForBeforeUnload: true })
    const closed = await gone
    if (closed) { host().contentView.removeChildView(t.view); tabs.delete(t.id) }
    return closed
  })
  provide('trust:admit', (a) => bridge.admit(arg<string>(a, 'id')))
  provide('trust:app-state', (a) => bridge.appState(arg<string>(a, 'id'), arg<'shown' | 'hidden'>(a, 's')))
  provide('trust:menu-click', (a) => bridge.menuClick(arg<string>(a, 'id'), arg<string>(a, 'item')))
  provide('trust:reopen-next', (a) => { bridge.reopenNext(arg<string>(a, 'id')); return true })
  provide('trust:same-canvas', () => [...sameCanvas])
  provide('trust:web-contents', () => webContents.getAllWebContents().filter((w) => !w.isDestroyed()).map((w) => ({ id: w.id, kind: kindOf(w.id) ?? null, url: w.getURL() })))
  provide('trust:logo', async (a) => {
    const e = appRegistry()?.byPort(arg<number>(a, 'port'))
    const l = e ? await fetchLogo(e) : null
    return l ? { type: l.type, size: l.bytes.length } : null
  })
  provide('trust:probe', async (a) => {
    const e = appRegistry()?.byPort(arg<number>(a, 'port'))
    return e ? await probeProof(e) : 'silent'
  })

  provide('trust:open-app', (a) => {
    const page = arg<AppPage>(a, 'page')
    const view = new WebContentsView({ webPreferences: appWebPreferences() })
    bridge.register(view.webContents, page)
    const w = host()
    view.setBounds({ x: 0, y: 0, width: 400, height: 300 })
    w.contentView.addChildView(view)
    const url = arg<string | undefined>(a, 'url') ?? pinnedUrl(page)
    void view.webContents.loadURL(url).catch(() => {})
    const id = `a${(++n).toString(36)}`
    apps.set(id, view)
    return { id, wc: view.webContents.id }
  })
  provide('trust:app-eval', async (a) => {
    const v = apps.get(arg<string>(a, 'id'))
    if (!v || v.webContents.isDestroyed()) throw new Error('no such app page')
    return await v.webContents.mainFrame.executeJavaScript(arg<string>(a, 'js'), arg<boolean | undefined>(a, 'gesture') ?? false)
  })
  provide('trust:app-url', (a) => {
    const v = apps.get(arg<string>(a, 'id'))
    return v && !v.webContents.isDestroyed() ? v.webContents.getURL() : null
  })
  provide('trust:app-load', (a) => {
    const v = apps.get(arg<string>(a, 'id'))
    if (v && !v.webContents.isDestroyed()) void v.webContents.loadURL(arg<string>(a, 'url')).catch(() => {})
    return true
  })
}
const apps = new Map<string, WebContentsView>()
const handled: { channel: string; kind: string; payload: unknown }[] = []

/** Hooks that reach the bridge as a message would, from a sender a case picks: what a sandboxed page cannot forge. */
export function provideBridgeHooks(): void {
  const bridge = installBridge()
  provide('trust:handle', (a) => {
    const channel = arg<string>(a, 'channel')
    bridge.handle(channel, (ctx, payload) => { handled.push({ channel, kind: ctx.kind, payload }); return null })
    return true
  })
  provide('trust:handled', () => [...handled])
  provide('trust:ipc', (a) => {
    const id = arg<string>(a, 'id')
    const wc = tabs.get(id)?.wc ?? apps.get(id)?.webContents
    if (!wc || wc.isDestroyed()) throw new Error('no such view')
    const frame = arg<string | undefined>(a, 'frame') === 'none' ? null : arg<string | undefined>(a, 'frame') === 'child' ? wc.mainFrame.frames[0] ?? null : wc.mainFrame
    const e = { sender: wc, senderFrame: frame, returnValue: undefined as unknown, reply() {} }
    ipcMain.emit(arg<string>(a, 'channel'), e, arg<unknown>(a, 'msg'))
    return e.returnValue ?? null
  })
  provide('trust:app-fetch', async (a) => {
    try {
      const r = await session.fromPartition(APP_PARTITION).fetch(arg<string>(a, 'url'))
      return { status: r.status, csp: r.headers.get('content-security-policy'), type: r.headers.get('content-type'), nosniff: r.headers.get('x-content-type-options') }
    } catch (err) { return { error: (err as Error).message } }
  })
}
