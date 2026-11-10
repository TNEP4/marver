/**
 * Spec 30 R12's app half at work (#48-#53), with Electron and the window faked and everything else real: `views.ts`,
 * `tabs.ts`, the bridge's page funnel and the recorder, whose lines are read back from a temporary home's app-dev.jsonl.
 * `runCommand`, `tabAct` and the funnel write `start` and `end` with `via` and `in`; a noop in its turn is one `once`;
 * a deadline writes `unobserved` and a later completion a `late` end; a tab page's export ends on its file; ⌘2's `shown`
 * carries `by` and ends it; another tab chosen first, the window hidden, a renderer gone and a refused sheet each end
 * their command by the rules; Mark All as Seen writes nothing here and tells the shell `tab-menu`; `window` events' cause;
 * the mover's handoff, written once by the next recorder; the rate bound's `dropped`; and the privacy sentinel: a value
 * set in Settings and a link typed never reach a line.
 */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PerfAsk, PerfMsg } from '../../../src/shared/app-api.ts'
import type { TabMenuView } from '../../src/shared/channels.ts'

type Listener = (...a: unknown[]) => void

const m = vi.hoisted(() => ({
  ipcOn: new Map<string, (e: unknown, msg: unknown) => void>(),
  ipcHandle: new Map<string, (e: unknown, msg: unknown) => unknown>(),
  dialogResponse: 0,
  views: [] as unknown[],
  appOn: new Map<string, ((...a: unknown[]) => void)[]>(),
  menu: null as unknown,
  winHandlers: new Map<string, ((...a: unknown[]) => void)[]>(),
  fullScreen: false,
  visible: true,
  minimized: 0,
  hidden: 0,
  // spec 32 B1.4, C8: window.ts's ports views.ts sets, the strip's readiness and trouble, what main sent the strip
  composePorts: null as null | { immersive(tab: unknown, facts: unknown): boolean; menuOpen(): boolean },
  composes: 0,
  menuOpen: false,
  /** the view facts a case sets per tab id: the mock's compose() calls `immersive(tab, facts)` for each */
  facts: new Map<string, Record<string, unknown>>(),
  stripShown: new Map<string, boolean>(),
  stripReady: true,
  trouble: null as null | ((why: 'gone' | 'unresponsive') => void),
  toStrip: [] as [string, unknown][],
  held: [] as [string, unknown][],
  getTab: null as null | ((id: string) => unknown),
}))

class FakeWc {
  static n = 500
  id = FakeWc.n++
  url = ''
  handlers = new Map<string, Listener[]>()
  session = {}
  mainFrame: Record<string, unknown>
  destroyed = false
  constructor(url = '') {
    this.url = url
    const self = this
    this.mainFrame = { processId: 1, routingId: this.id, isDestroyed: () => false, detached: false, parent: null, get url() { return self.url }, get origin() { return 'x' }, osProcessId: this.id, framesInSubtree: [{ osProcessId: this.id }], send: () => {}, executeJavaScript: async () => 0 }
  }
  isDestroyed() { return this.destroyed }
  getOSProcessId() { return this.id }
  getURL() { return this.url }
  on(ev: string, f: Listener) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), f]); return this }
  once(ev: string, f: Listener) { return this.on(ev, f) }
  off(ev: string, f: Listener) { this.handlers.set(ev, (this.handlers.get(ev) ?? []).filter((x) => x !== f)); return this }
  emit(ev: string, ...a: unknown[]) { for (const f of [...(this.handlers.get(ev) ?? [])]) f(...a) }
  loadURL = async (u: string) => { this.url = u }
  reload() {}
  reloadIgnoringCache() {}
  close() { this.destroyed = true; this.emit('destroyed') }
  insertCSS = async () => ''
  openDevTools() {}
  forcefullyCrashRenderer() {}
  send() {}
  focused = 0
  focus() { this.focused++; this.emit('focus') }
}

vi.mock('electron', () => {
  class WebContentsView { webContents = new FakeWc(); getVisible() { return true } getBounds() { return { x: 0, y: 0, width: 1, height: 1 } } setVisible() {} setBounds() {} setBackgroundColor() {} }
  const appOn = (ev: string, f: (...a: unknown[]) => void) => { m.appOn.set(ev, [...(m.appOn.get(ev) ?? []), f]) }
  return {
    WebContentsView,
    ipcMain: { on: (ch: string, f: (e: unknown, msg: unknown) => void) => { m.ipcOn.set(ch, f) }, handle: (ch: string, f: (e: unknown, msg: unknown) => unknown) => { m.ipcHandle.set(ch, f) } },
    webFrameMain: { fromId: () => undefined },
    app: {
      on: appOn, prependListener: appOn, hide: () => {}, quit: () => {}, getVersion: () => '1.0.1', getName: () => 'Marver Dev', getPath: () => '/nowhere', isReady: () => true,
      getAppMetrics: () => [], getGPUFeatureStatus: () => ({}), commandLine: { hasSwitch: () => false },
    },
    dialog: { showMessageBox: async () => ({ response: m.dialogResponse, checkboxChecked: false }), showSaveDialog: async () => ({ canceled: true }) },
    Menu: { setApplicationMenu: (x: { template: unknown }) => { m.menu = x.template }, buildFromTemplate: (t: unknown) => ({ template: t }), sendActionToFirstResponder: () => {} },
    nativeTheme: { shouldUseDarkColors: false, on: () => {} },
    net: { isOnline: () => true },
    powerMonitor: { on: () => {}, getCurrentThermalState: () => 'nominal' },
    shell: { showItemInFolder: () => {}, openExternal: async () => {}, openPath: async () => '' },
    clipboard: { writeText: () => {} },
    screen: { on: () => {}, getDisplayMatching: () => ({ id: 1, displayFrequency: 120 }), getPrimaryDisplay: () => ({ id: 1, displayFrequency: 120 }) },
    webContents: { getAllWebContents: () => [] },
    session: { fromPartition: () => ({}) },
    autoUpdater: { on: () => {} },
    BaseWindow: class {},
    View: class {},
    nativeImage: {},
    protocol: {},
    crashReporter: {},
  }
})

const content = new Map<string, { webContents: FakeWc }>()
const win = {
  isFullScreen: () => m.fullScreen,
  setFullScreen: (on: boolean) => { m.fullScreen = on },
  minimize: () => { m.minimized += 1 },
  isDestroyed: () => false,
  isFocused: () => true,
  getBounds: () => ({ x: 0, y: 0, width: 1280, height: 820 }),
  on: (ev: string, f: Listener) => { m.winHandlers.set(ev, [...(m.winHandlers.get(ev) ?? []), f]); return win },
}
const emitWin = (ev: string) => { for (const f of m.winHandlers.get(ev) ?? []) f() }
vi.mock('../../src/main/window.ts', () => ({
  APP_ORIGIN: 'marver-app://',
  appPrefs: () => ({}),
  attachContent: (id: string, view: { webContents: FakeWc }) => { content.set(id, view) },
  detachContent: (id: string) => { content.delete(id) },
  captureWindow: async () => null,
  // spec 32 C8.2: the ports views.ts set, called as composeOnce calls them - the gate for each tab a case gave facts
  // for, then the menu's state
  compose: () => {
    m.composes++
    const p = m.composePorts
    if (!p) return
    for (const [id, f] of m.facts) { const t = m.getTab?.(id); if (t) m.stripShown.set(id, p.immersive(t, f)) }
    m.menuOpen = p.menuOpen()
  },
  setComposePorts: (p: typeof m.composePorts) => { m.composePorts = p },
  stripReady: () => m.stripReady,
  onStripTrouble: (fn: (why: 'gone' | 'unresponsive') => void) => { m.trouble = fn; return () => {} },
  sendToStrip: (ch: string, p: unknown) => { m.toStrip.push([ch, p]) },
  contentView: (id: string) => content.get(id),
  coverContents: () => null,
  hideWindow: () => { m.hidden += 1; emitWin('hide') },
  mainWindow: () => win,
  onAppReady: () => {},
  openWindow: () => win,
  pageOf: () => undefined,
  pageView: () => undefined,
  sendHeld: (_wc: unknown, ch: string, p: unknown) => { m.held.push([ch, p]) },
  sendPill: () => {},
  showWindow: () => {},
  stripContents: () => undefined,
  viewsNow: () => [],
  windowVisible: () => m.visible,
  focusWindow: () => {},
  refreshTabs: () => {},
  windowInFront: () => true,
  captureApp: async () => { throw new Error('no window') },
  sendPageFocus: () => {},
  inFrontOf: () => true,
}))
vi.mock('../../src/main/machine.ts', () => ({
  currentHash: () => '0123456789abcdef', stampHash: () => '0123456789abcdef', onProfile: () => () => {}, startMachine: () => {}, windowDisplayChanged: () => {},
  readAgx: async () => ({ gpuSystemMemoryMB: 1, allocMB: 2, utilPct: 3, rendererPct: 4, tilerPct: 5, recoveryCount: 0, machineWide: true }),
}))
const flashAppended: unknown[] = []
vi.mock('../../src/main/flash-ports.ts', () => ({
  perfDirOf: (d: string) => d,
  flashPorts: (r: { append(b: unknown): void; flavour: string }) => ({
    now: () => Date.now(), mono: () => performance.now(), flavour: r.flavour, recorderOn: () => true, identity: () => null, ring: () => null,
    stateNow: () => ({ ts: 0, mono: 0, dt: null, procs: [], gpu: null, pressure: null, thermal: 'nominal', sys: null, visible: null }),
    thermal: () => 'nominal', pressure: () => null, featureStatus: () => ({}), readAgx: async () => ({ gpuSystemMemoryMB: 1, allocMB: 2, utilPct: 3, rendererPct: 4, tilerPct: 5, recoveryCount: 0, machineWide: true }),
    gpuEvents: () => [], capture: async () => { throw Object.assign(new Error('no window'), { why: 'no window' }) }, writePicture: async () => ({ why: 'write failed' }), confirm: () => {},
    append: (b: unknown) => { flashAppended.push(b); r.append(b) },
  }),
}))
vi.mock('../../src/main/nav.ts', () => ({
  attachNav: () => ({ on: () => () => {}, dispose: () => {}, gen: () => 1, stamp: () => 1, commits: () => 1, frame: () => null }),
  adapterFor: () => null,
}))
vi.mock('../../src/main/proof.ts', () => ({
  isTrusted: () => true, targetOf: () => null, unsafePrefs: () => null, readAtMost: async () => null,
}))
vi.mock('../../src/main/registry.ts', () => ({ appRegistry: () => null }))

const { recorder } = await import('../../src/main/recorder.ts')
const { flushNow, idle } = await import('../../src/main/perflog.ts')
const { installBridge } = await import('../../src/main/bridge.ts')
const { runCommand, startViews, pageHandlers } = await import('../../src/main/views.ts')
const tabs = await import('../../src/main/tabs.ts')
const cmds = await import('../../src/main/commands.ts')
const { keyCombo, attachKeys } = await import('../../src/main/keys.ts')
const { offerMove, takeMoveCmd } = await import('../../src/main/mover.ts')
const { CH } = await import('../../src/shared/channels.ts')
const { checkHello, checkPagePayload } = await import('../../src/main/bridge.ts')
const { identity } = await import('../../src/main/recorder.ts')
const { launchFirstCanvas, launchReady, launchWriter, resetLaunch } = await import('../../src/main/launch.ts')
const views = await import('../../src/main/views.ts')
const { compose } = await import('../../src/main/window.ts')
const { workspaceOf } = await import('../../src/main/deep-link.ts')
const { buildDeepLink } = await import('../../../src/shared/deep-link.ts')
m.getTab = (id) => tabs.getTab(id)

// ---- the run -----------------------------------------------------------------------------------------------------------

let base: string
let recording = true
const file = () => join(base, 'home', 'perf', 'app-dev.jsonl')
const lines = () => { flushNow(); return existsSync(file()) ? readFileSync(file(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>) : [] }
const cmdLines = () => lines().filter((l) => l.kind === 'cmd')
const tick = () => new Promise<void>((r) => setImmediate(r))

let perfFn: ((tabId: string, doc: string, msg: PerfMsg) => void) | null = null
let reportFn: ((tabId: string, doc: string, r: Record<string, unknown>) => void) | null = null
const asks: { tab: string; ask: PerfAsk }[] = []
const menuClicks: unknown[][] = []
const immersiveSent: Record<string, unknown>[] = []
let immersiveSends = true
const navFns = new Map<string, (e: unknown) => void>()
let docN = 0
const docs = new Map<string, string>()
const entries: ReturnType<typeof makeEntry>[] = []
/** what subscribed to the faked trust stream's registry, so a test can play a registry change */
const registryFns: ((e: unknown) => void)[] = []
const makeEntry = (n: number) => ({
  file: `/home/running/slot-${n}.json`, key: Buffer.alloc(32), state: 'ready', pid: 1000 + n, instance: `inst-${n}`,
  slot: n, port: 40100 + n, origin: `http://[::1]:${40100 + n}`, url: `http://localhost:${40100 + n}/`, root: `/Users/nic/repo-${n}`, name: `Canvas ${n}`,
  version: '0.30.0', features: ['bridge', 'open'], ws: `${n}`.repeat(16).slice(0, 16), startedAt: 1,
})

/** The trust stream, faked at its port: an admitted doc per commit, and the channels of a real bridge. */
const bridge = installBridge()
const trust = {
  session: async () => ({}),
  attach: (_wc: unknown, tab: { id: string }) => ({ on: (fn: (e: unknown) => void) => { navFns.set(tab.id, fn); return () => {} }, dispose: () => {}, gen: () => 1, stamp: () => 1 }),
  admit: (tabId: string) => { const d = `doc-${tabId}-${++docN}`; docs.set(tabId, d); return d },
  register: () => {},
  entries: () => entries,
  entryFor: () => undefined,
  onRegistry: (fn: (e: unknown) => void) => { registryFns.push(fn); return () => {} },
  onReport: (fn: typeof reportFn) => { reportFn = fn; return () => {} },
  appState: () => true,
  menuClick: (...a: unknown[]) => { menuClicks.push(a); return true },
  reopenNext: () => {},
  // spec 32 C2: the one sender of `mv:immersive-state` (bridge.ts's own is unit-tested in bridge-immersive)
  immersiveState: (tab: string, doc: string, s: Record<string, unknown>) => { immersiveSent.push({ tab, doc, ...s }); return immersiveSends },
  pages: {
    onReady: () => {},
    handle: (ch: string, fn: (wc: unknown, p: unknown) => unknown) => bridge.handle(ch, (ctx, p) => fn(ctx.wc, p)),
    send: () => true,
  },
}

beforeAll(async () => {
  ;(process as unknown as { getSystemVersion(): string }).getSystemVersion = () => '26.0'
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-r30-')))
  recorder.start({
    bridge: {
      onPerf: (fn: typeof perfFn) => { perfFn = fn; return () => {} },
      onReport: () => () => {},
      perfAsk: (tab: string, ask: PerfAsk) => { asks.push({ tab, ask }); return true },
    } as never,
    home: { dir: join(base, 'home'), writable: true, state: join(base, 'home', 'state'), crashpad: '', ms: 0 },
    flavour: 'dev',
    config: () => ({ restoreTabs: true, unloadUnderPressure: true, recorder: recording, dockBadge: false, keepPerfDays: 14 }),
  })
  startViews({ trust: trust as never, home: { dir: join(base, 'home'), writable: true, state: join(base, 'home', 'state'), crashpad: '', ms: 0 } as never, files: { config: { restoreTabs: false } } as never })
  await tick()
})
afterAll(async () => { await idle(); rmSync(base, { recursive: true, force: true }) })
beforeEach(() => { cmds.resetCmds(); asks.length = 0; menuClicks.length = 0; recording = true; m.fullScreen = false; flushNow(); writeFileSync(file(), '') })

/** A canvas tab on its first document: registered, shown, committed, said hello. */
let n = 0
async function canvas(hello?: Record<string, unknown>): Promise<ReturnType<typeof tabs.getTab> & object> {
  const e = makeEntry(++n)
  entries.push(e)
  tabs.onRegistry({ kind: 'entry', entry: e as never })
  const t = tabs.allTabs().find((x) => x.reg?.instance === e.instance)!
  tabs.activate(t.id)
  await tick()
  await commit(t.id, e.origin, hello)
  return t
}
async function commit(id: string, origin?: string, hello?: Record<string, unknown>): Promise<void> {
  const t = tabs.getTab(id)!
  navFns.get(id)!({ kind: 'commit', gen: 1, url: `${origin ?? t.reg!.origin}/`, attributed: true, instance: t.reg!.instance })
  reportFn!(id, docs.get(id)!, { hello: hello ?? { version: '0.30.0', board: null, page: `PAGE_${docs.get(id)}` }, safety: 'fresh', busy: { busy: false, unsaved: false, why: [] } })
  await tick()
}
const answerShown = (tab: string) => {
  const a = asks.filter((x) => x.tab === tab && x.ask.kind === 'shown').at(-1)!
  perfFn!(tab, docs.get(tab)!, { kind: 'shown', tick: (a.ask as { tick: number }).tick })
}
const page = (kind: 'strip' | 'home' | 'settings' | 'tabpage', tabId?: string) => {
  const wc = new FakeWc(`marver-app://${kind}/`)
  bridge.register(wc as never, kind, tabId)
  return { sender: wc, senderFrame: wc.mainFrame }
}
/** spec 32 B: main's last `tab-menu` to the strip (a view, or null) */
const lastMenuView = () => m.toStrip.filter(([ch]) => ch === CH.tabMenuView).at(-1)?.[1] as TabMenuView | null | undefined
/** the strip's `tab:menu` and `tabs:more`, through the funnel, and the view main answered */
const openTabMenu = (id: string, ask: { key?: boolean; hadFocus?: boolean } = {}) => { m.toStrip.length = 0; m.ipcOn.get(CH.tabMenu)!(page('strip'), { id, x: 10, y: 40, ...ask }); return lastMenuView() }
const openMore = (ids: string[], ask: { key?: boolean; hadFocus?: boolean } = {}) => { m.toStrip.length = 0; m.ipcOn.get(CH.tabsMore)!(page('strip'), { ids, x: 600, y: 40, ...ask }); return lastMenuView() }
const menuShownAck = (rev: number) => m.ipcOn.get(CH.tabMenuShown)!(page('strip'), { rev })
const menuPickSend = (rev: number, id: string | null) => m.ipcOn.get(CH.tabMenuPick)!(page('strip'), { rev, id })

describe('appCmd: the lifecycle (#48, #49)', () => {
  const O = { via: 'key', in: 'shell', keys: 'Meta+1' } as const
  it('a start at the input and an end with the same 12-hex id, ms from the input, steps', async () => {
    const h = cmds.appCmd('home', O)
    expect(cmds.currentAppCmd()?.id).toBe(h.id)
    expect(h.id).toMatch(/^[0-9a-f]{12}$/)
    await tick()
    h.step('half')
    h.done()
    const [a, b] = cmdLines()
    expect(a).toMatchObject({ phase: 'start', id: h.id, cmd: 'home', via: 'key', in: 'shell', keys: 'Meta+1' })
    expect(b).toMatchObject({ phase: 'end', id: h.id, cmd: 'home', outcome: 'done', steps: [{ name: 'half' }] })
    expect(typeof b!.ms).toBe('number')
  })
  it('a noop decided in its input\'s turn is one `once` record, even through a microtask', async () => {
    const h = cmds.appCmd('tab-3', O)
    await Promise.resolve()
    h.noop('no-tab')
    await tick()
    expect(cmdLines()).toEqual([expect.objectContaining({ phase: 'once', id: h.id, cmd: 'tab-3', via: 'key', outcome: 'noop', why: 'no-tab' })])
  })
  it('a noop after its turn is an end, its start written first', async () => {
    const h = cmds.appCmd('tab-3', O)
    await tick()
    h.noop('no-tab')
    expect(cmdLines().map((l) => l.phase)).toEqual(['start', 'end'])
  })
  it('first end wins', async () => {
    const h = cmds.appCmd('home', O)
    h.done(); h.fail('refused'); h.cancel(); h.noop('no-tab')
    await tick()
    expect(cmdLines().map((l) => [l.phase, l.outcome])).toEqual([['start', undefined], ['end', 'done']])
  })
  describe('the deadline', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'performance'] }) })
    afterEach(() => { vi.useRealTimers() })
    it('passing with no signal writes unobserved; a completion after it is a second end, late', () => {
      const h = cmds.appCmd('home', O)
      vi.advanceTimersByTime(10_000)
      h.done()
      h.done()
      const ls = cmdLines()
      expect(ls.map((l) => [l.phase, l.outcome, l.why])).toEqual([['start', undefined, undefined], ['end', 'unobserved', 'deadline'], ['end', 'done', undefined]])
      expect(ls[1]!.ms).toBeGreaterThanOrEqual(10_000)
      expect(ls[1]!.late).toBeUndefined()
      expect(ls[2]!.late).toBe(true)
    })
    it('the table\'s deadlines: reload 30 s, export 120 s', () => {
      const r = cmds.appCmd('reload', O)
      const e = cmds.appCmd('export-report', O)
      vi.advanceTimersByTime(29_999)
      expect(cmdLines().filter((l) => l.phase === 'end')).toEqual([])
      vi.advanceTimersByTime(1)
      expect(cmdLines().filter((l) => l.phase === 'end').map((l) => l.id)).toEqual([r.id])
      vi.advanceTimersByTime(90_000)
      expect(cmdLines().filter((l) => l.phase === 'end').map((l) => l.id)).toEqual([r.id, e.id])
    })
    it('the rate bound: a burst of 20, then 10 a second; what goes past is counted in one coalesced dropped', () => {
      const hs = Array.from({ length: 25 }, () => cmds.appCmd('home', O))
      expect(hs.filter((h) => h.id).length).toBe(20)
      expect(cmds.currentAppCmd()?.id).toBe(hs[19]!.id)   // past the bound names nothing
      vi.advanceTimersByTime(1000)
      expect(lines().filter((l) => l.kind === 'dropped')).toEqual([expect.objectContaining({ n: 5, reason: 'cmd' })])
      // refilled at 10 a second
      expect(Array.from({ length: 11 }, () => cmds.appCmd('home', O)).filter((h) => h.id).length).toBe(10)
    })
  })
  it('obeys the recorder: nothing on disk with `recorder` off', async () => {
    recording = false
    cmds.appCmd('home', O).done()
    await tick()
    expect(cmdLines()).toEqual([])
  })
})

describe('keys (#50)', () => {
  const k = (o: Partial<Parameters<typeof keyCombo>[0]>) => ({ type: 'keyDown' as const, key: '', code: '', isAutoRepeat: false, shift: false, control: false, alt: false, meta: false, ...o })
  it('the combination as descriptor() writes it, from the code where the key lies', () => {
    expect(keyCombo(k({ meta: true, key: '2', code: 'Digit2' }))).toBe('Meta+2')
    expect(keyCombo(k({ meta: true, key: 'é', code: 'Digit2' }))).toBe('Meta+2')   // AZERTY
    expect(keyCombo(k({ meta: true, shift: true, key: '}', code: 'BracketRight' }))).toBe('Meta+Shift+]')
    expect(keyCombo(k({ meta: true, shift: true, key: '{', code: 'BracketLeft' }))).toBe('Meta+Shift+[')
    expect(keyCombo(k({ control: true, key: 'Tab', code: 'Tab' }))).toBe('Ctrl+Tab')
    expect(keyCombo(k({ control: true, shift: true, key: 'Tab', code: 'Tab' }))).toBe('Ctrl+Shift+Tab')
    expect(keyCombo(k({ key: 'F6', code: 'F6' }))).toBe('F6')
    expect(keyCombo(k({ shift: true, key: 'F6', code: 'F6' }))).toBe('Shift+F6')
    expect(keyCombo(k({ meta: true, key: 'q', code: 'KeyA' }))).toBe('Meta+q')           // ⌘Q follows the layout
    expect(keyCombo(k({ meta: true, shift: true, key: 'W', code: 'KeyW' }))).toBe('Meta+Shift+w')
    expect(keyCombo(k({ meta: true, alt: true, key: 'ˆ', code: 'KeyI' }))).toBe('Meta+Alt+i')
    expect(keyCombo(k({ control: true, alt: true, key: 'ƒ', code: 'KeyF' }))).toBe('Ctrl+Alt+f')
    expect(keyCombo(k({ meta: true, key: ',', code: 'Comma' }))).toBe('Meta+,')
  })
  it('attachKeys tells run() what arrived and where; a repeat is swallowed, unrecorded', () => {
    const wc = new FakeWc()
    const got: unknown[][] = []
    attachKeys(wc as never, (c, _f, key) => { got.push([c, key]) }, { in: 'strip' })
    const press = (o: object) => wc.emit('before-input-event', { preventDefault() {} }, k({ meta: true, ...o }))
    press({ key: '2', code: 'Digit2' })
    press({ key: '2', code: 'Digit2', isAutoRepeat: true })
    expect(got).toEqual([['tab-2', { keys: 'Meta+2', in: 'strip' }]])
  })
})

describe('runCommand (#49, #50, #52)', () => {
  it('⌘2: its `shown` carries `by` and ends it done; the record names the tab and its page', async () => {
    const a = await canvas()
    const b = await canvas()
    tabs.activate(a.id)
    await tick()
    flushNow(); writeFileSync(file(), '')
    const d = tabs.keyOf(b)!
    const name = d === 9 ? 'tab-last' : `tab-${d}`
    runCommand(name as never, 'key', { keys: `Meta+${d}`, in: 'shell' })
    await tick()
    const start = cmdLines()[0]!
    expect(start).toMatchObject({ phase: 'start', cmd: name, via: 'key', keys: `Meta+${d}`, in: 'shell', tab: b.id, page: `PAGE_${docs.get(b.id)}` })
    expect(lines().some((l) => l.kind === 'shown')).toBe(false)
    answerShown(b.id)
    const all = lines()
    expect(all.find((l) => l.kind === 'shown')).toMatchObject({ tab: b.id, by: start.id })
    expect(cmdLines()[1]).toMatchObject({ phase: 'end', id: start.id, outcome: 'done' })
  })
  it('no tab for that digit: one once, noop no-tab', async () => {
    runCommand('tab-8', 'key', { keys: 'Meta+8', in: 'home' })
    await tick()
    expect(cmdLines()).toEqual([expect.objectContaining({ phase: 'once', cmd: 'tab-8', in: 'home', outcome: 'noop', why: 'no-tab' })])
  })
  it('a menu cmd() item: via menu, in menu, no keys', async () => {
    const before = tabs.activeTab()?.id
    runCommand('home', 'menu')
    await tick()
    expect(cmdLines()).toEqual([
      expect.objectContaining({ phase: 'start', cmd: 'home', via: 'menu', in: 'menu', tab: 'home' }),
      expect.objectContaining({ phase: 'end', outcome: 'done' }),
    ])
    expect(cmdLines()[0]!.keys).toBeUndefined()
    if (before) tabs.activate(before)
  })
  it('another tab chosen before its `shown`: cancelled', async () => {
    const a = await canvas()
    const b = await canvas()
    tabs.activate('home')
    await tick()
    flushNow(); writeFileSync(file(), '')
    const d = tabs.keyOf(a)!
    runCommand((d === 9 ? 'tab-last' : `tab-${d}`) as never, 'key', { keys: `Meta+${d}`, in: 'shell' })
    const first = cmdLines()
    tabs.activate(b.id)
    await tick()
    expect(first).toEqual([])
    expect(cmdLines().filter((l) => l.phase === 'end')).toEqual([expect.objectContaining({ outcome: 'cancelled', why: 'another-tab' })])
  })
  it('the window hidden before its `shown`: unobserved; the `shown` arriving after is a late done', async () => {
    const a = await canvas()
    tabs.activate('home')
    await tick()
    flushNow(); writeFileSync(file(), '')
    const d = tabs.keyOf(a)!
    runCommand((d === 9 ? 'tab-last' : `tab-${d}`) as never, 'key', { keys: `Meta+${d}`, in: 'shell' })
    emitWin('hide')
    answerShown(a.id)
    await tick()
    expect(cmdLines().filter((l) => l.phase === 'end').map((l) => [l.outcome, l.why, l.late])).toEqual([['unobserved', 'hidden', undefined], ['done', undefined, true]])
  })
  it('the renderer gone before its `shown`: failed gone', async () => {
    const a = await canvas()
    tabs.activate('home')
    await tick()
    flushNow(); writeFileSync(file(), '')
    const d = tabs.keyOf(a)!
    runCommand((d === 9 ? 'tab-last' : `tab-${d}`) as never, 'key', { keys: `Meta+${d}`, in: 'shell' })
    content.get(a.id)!.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    await tick()
    expect(cmdLines().filter((l) => l.phase === 'end')).toEqual([expect.objectContaining({ outcome: 'failed', why: 'gone' })])
  })
  it('⌘R ends on the new document\'s accepted hello, not on the guard answering; the old document\'s reports do not end it', async () => {
    const t = await canvas()
    flushNow(); writeFileSync(file(), '')
    runCommand('reload', 'key', { keys: 'Meta+r', in: 'shell' })
    await tick()
    // a report of the same document: the reload is still on its way
    reportFn!(t.id, docs.get(t.id)!, { hello: { version: '0.30.0', board: null, page: `PAGE_${docs.get(t.id)}` }, busy: { busy: false, unsaved: false, why: [] } })
    expect(cmdLines().filter((l) => l.phase === 'end')).toEqual([])
    await commit(t.id)
    expect(cmdLines().filter((l) => l.phase === 'end')).toEqual([expect.objectContaining({ cmd: 'reload', outcome: 'done', tab: t.id, page: `PAGE_${docs.get(t.id)}` })])
  })
  it('⌘W: ends on the tab gone; a sheet the person declined is cancelled, unsaved work refusing is failed refused', async () => {
    const t = await canvas()
    tabs.activate(t.id)
    await tick()
    t.reports.busy = { busy: true, unsaved: true, why: ['board-unsaved'] }
    t.reports.safety = 'fresh'
    flushNow(); writeFileSync(file(), '')
    runCommand('close-tab', 'key', { keys: 'Meta+w', in: 'shell' })
    await tick(); await tick()
    expect(cmdLines().filter((l) => l.phase === 'end')).toEqual([expect.objectContaining({ cmd: 'close-tab', outcome: 'failed', why: 'refused' })])
    // the document's safety unknown: the sheet asks, and the person says no
    t.reports.busy = undefined
    t.reports.safety = 'unknown'
    m.dialogResponse = 0                                              // the sheet's Cancel, its default
    flushNow(); writeFileSync(file(), '')
    runCommand('close-tab', 'key', { keys: 'Meta+w', in: 'shell' })
    await tick(); await tick(); await tick()
    expect(cmdLines().filter((l) => l.phase === 'end')).toEqual([expect.objectContaining({ outcome: 'cancelled', why: 'sheet' })])
    // nothing in the way: the tab goes
    t.reports.safety = 'fresh'
    t.reports.busy = { busy: false, unsaved: false, why: [] }
    flushNow(); writeFileSync(file(), '')
    runCommand('close-tab', 'key', { keys: 'Meta+w', in: 'shell' })
    await tick(); await tick(); await tick()
    expect(cmdLines().filter((l) => l.phase === 'end')).toEqual([expect.objectContaining({ cmd: 'close-tab', outcome: 'done' })])
  })
  it('⌘W on Home: noop no-tab', async () => {
    tabs.activate('home')
    runCommand('close-tab', 'key', { keys: 'Meta+w', in: 'home' })
    await tick()
    expect(cmdLines()).toEqual([expect.objectContaining({ phase: 'once', outcome: 'noop', why: 'no-tab', in: 'home' })])
  })
  it('⌃⌥F ends on the `flash` line; one inside the debounce is a noop', async () => {
    runCommand('mark-flash', 'key', { keys: 'Ctrl+Alt+f', in: 'shell' })
    await tick()
    // a second press within the debounce marks nothing: decided in its own turn
    runCommand('mark-flash', 'key', { keys: 'Ctrl+Alt+f', in: 'shell' })
    await tick()
    expect(cmdLines().find((l) => l.phase === 'once')).toMatchObject({ cmd: 'mark-flash', outcome: 'noop', why: 'debounced' })
    expect(cmdLines().filter((l) => l.phase === 'end')).toEqual([])
    await vi.waitFor(() => { expect(cmdLines().at(-1)).toMatchObject({ phase: 'end', cmd: 'mark-flash', outcome: 'done' }) }, { timeout: 5000 })
    expect(lines().filter((l) => l.kind === 'flash').length).toBe(1)
  })
  it('⌃⌘F ends on its window event, whose cause is the app; the green button\'s says unknown', async () => {
    runCommand('fullscreen', 'key', { keys: 'Ctrl+Meta+f', in: 'shell' })
    await tick()
    expect(cmdLines().filter((l) => l.phase === 'end')).toEqual([])
    emitWin('enter-full-screen')
    expect(lines().filter((l) => l.kind === 'window')).toEqual([expect.objectContaining({ event: 'enter-full-screen', cause: 'app' })])
    expect(cmdLines().at(-1)).toMatchObject({ phase: 'end', cmd: 'fullscreen', outcome: 'done' })
    emitWin('leave-full-screen')
    emitWin('minimize')
    emitWin('restore')
    emitWin('maximize')
    emitWin('unmaximize')
    expect(lines().filter((l) => l.kind === 'window').slice(1).map((l) => [l.event, l.cause])).toEqual([
      ['leave-full-screen', 'unknown'], ['minimize', 'unknown'], ['restore', 'unknown'], ['maximize', 'unknown'], ['unmaximize', 'unknown'],
    ])
    emitWin('hide')                                                  // hide and show are not recorded (#53)
    expect(lines().filter((l) => l.kind === 'window').map((l) => l.event)).not.toContain('hide')
  })
  it('a window event in a command\'s own turn is the app\'s', async () => {
    const h = cmds.appCmd('close-window', { via: 'key', in: 'shell' })
    cmds.withAppCmd(h, () => emitWin('minimize'))
    h.done()
    expect(lines().find((l) => l.kind === 'window')).toMatchObject({ event: 'minimize', cause: 'app' })
  })
})

describe('tabAct (#49, #50, #51)', () => {
  type Item = { label?: string; click?: () => void; submenu?: Item[] }
  /** spec 32 B15: the tab's Marver menu through the funnel, as the strip sends it - opened and shown; its rows main's */
  const shownMenu = async (id: string) => { const v = openTabMenu(id)!; menuShownAck(v.rev); await tick(); flushNow(); writeFileSync(file(), ''); return v }
  /** a row picked through the record (`tab:menu-pick`): the input is the pick, its one command the one tabAct opens */
  const pickRow = async (id: string, row: string) => { const v = await shownMenu(id); menuPickSend(v.rev, row); await tick(); return v }
  it('the right-click: via context, in tab-menu; its work\'s end - exactly one command for the pick', async () => {
    const t = await canvas()
    await pickRow(t.id, 'copy-link')
    expect(cmdLines()).toEqual([
      expect.objectContaining({ phase: 'start', cmd: 'copy-link', via: 'context', in: 'tab-menu', tab: t.id }),
      expect.objectContaining({ phase: 'end', cmd: 'copy-link', outcome: 'done' }),
    ])
  })
  it('Mark all as seen is a relay: nothing written here, `in: tab-menu` passed on', async () => {
    const t = await canvas()
    await pickRow(t.id, 'mark-all-seen')
    expect(cmdLines()).toEqual([])
    expect(menuClicks).toEqual([[t.id, 'mark-all-seen', 'tab-menu']])
  })
  it('Resolve all comments (spec 31 B.1) sits beside Mark all as seen: a relay too, `in: tab-menu`, for a canvas that says `resolve-all`', async () => {
    const t = await canvas()
    ;(t.reg!.features as string[]).push('resolve-all')
    const v = await shownMenu(t.id)
    const at = v.rows.findIndex((r) => r.kind === 'item' && r.id === 'mark-all-seen')
    expect(v.rows[at + 1]).toMatchObject({ kind: 'item', id: 'resolve-all-comments', label: 'Resolve all comments', enabled: true })
    menuPickSend(v.rev, 'resolve-all-comments')
    await tick()
    expect(cmdLines()).toEqual([])
    expect(menuClicks).toEqual([[t.id, 'resolve-all-comments', 'tab-menu']])
  })
  it('an older canvas (no `resolve-all`): Resolve all comments is there, dimmed, and a pick of it does nothing (B8, B13)', async () => {
    const t = await canvas()
    const v = await shownMenu(t.id)
    expect(v.rows.find((r) => r.kind === 'item' && r.id === 'resolve-all-comments')).toMatchObject({ enabled: false })
    menuPickSend(v.rev, 'resolve-all-comments')
    await tick()
    expect(menuClicks).toEqual([])
    expect(cmdLines()).toEqual([])
  })
  it('a stale token: noop untrusted, as today (B13)', async () => {
    const t = await canvas()
    const v = openTabMenu(t.id)!
    menuShownAck(v.rev)
    await commit(t.id)     // another document: the token no longer holds
    flushNow(); writeFileSync(file(), '')
    menuPickSend(v.rev, 'copy-link')
    await tick()
    expect(cmdLines()).toEqual([expect.objectContaining({ phase: 'once', cmd: 'copy-link', outcome: 'noop', why: 'untrusted' })])
  })
  it('the File menu\'s tab items: via menu, in menu; a stale one still records', async () => {
    const t = await canvas()
    const menu = await import('../../src/main/menu.ts')
    tabs.activate(t.id)
    menu.buildNow(true)
    const file_ = (m.menu as Item[]).find((x) => x.label === 'File')!
    const link = file_.submenu!.find((i) => i.label === 'Copy Local Link')!
    flushNow(); writeFileSync(file(), '')
    link.click!()
    await tick()
    expect(cmdLines()).toEqual([
      expect.objectContaining({ phase: 'start', cmd: 'copy-link', via: 'menu', in: 'menu', tab: t.id }),
      expect.objectContaining({ phase: 'end', outcome: 'done' }),
    ])
    await commit(t.id)
    flushNow(); writeFileSync(file(), '')
    link.click!()
    await tick()
    expect(cmdLines()).toEqual([expect.objectContaining({ phase: 'once', cmd: 'copy-link', via: 'menu', outcome: 'noop', why: 'untrusted' })])
  })
  it('the Help menu\'s items record their own names', async () => {
    const menu = await import('../../src/main/menu.ts')
    menu.buildNow(true)
    const help = (m.menu as (Item & { role?: string })[]).find((x) => x.role === 'help')!
    flushNow(); writeFileSync(file(), '')
    help.submenu!.find((i) => i.label === 'Marver Help')!.click!()
    help.submenu!.find((i) => i.label === 'Show Performance Files')!.click!()
    await tick()
    expect(cmdLines().filter((l) => l.phase === 'start').map((l) => [l.cmd, l.via, l.in])).toEqual([['help', 'menu', 'menu'], ['show-perf-files', 'menu', 'menu']])
    expect(cmdLines().filter((l) => l.phase === 'end').map((l) => l.outcome)).toEqual(['done', 'done'])
  })
})

describe('spec 32 F1, D8.1: the tab facts views.ts gives home.ts (setTabFacts)', () => {
  it('a local tab: its ws, root, port and its people link while trusted; --port only for an explicit-port start; once gone, its marver:// link', async () => {
    const { tabFacts } = await import('../../src/main/home.ts')
    const a = await canvas()
    const port = a.reg!.port
    expect(a.doc?.trusted).toBe(true)
    expect(tabFacts(a.id)).toEqual({ ws: a.reg!.ws, root: a.root, port, link: `http://localhost:${port}/` })
    // untrusted: no link
    a.doc!.trusted = false
    expect(tabFacts(a.id)).toEqual({ ws: a.reg!.ws, root: a.root, port })
    a.doc!.trusted = true
    // an explicit-port start (no slot): Copy start command's --port
    a.reg!.slot = null
    expect(tabFacts(a.id)).toMatchObject({ startPort: port })
    // gone: its marver:// link names its root and the port it ran on, either way
    a.reg!.state = 'gone'
    expect(tabFacts(a.id)).toEqual({ ws: a.reg!.ws, root: a.root, port, startPort: port, gone: true, link: `marver://open?ws=${encodeURIComponent(a.root!)}&port=${port}` })
    a.reg!.state = 'ready'; a.reg!.slot = n
    // Home, Settings and an unknown id have none
    expect([tabFacts('home'), tabFacts('no-such')]).toEqual([undefined, undefined])
  })
  it('the amended window ports (F3b #2) keep today\'s behaviour: homeExcluded is the running set, deep is the open-url handler', async () => {
    const v = await import('../../src/main/views.ts')
    await canvas()
    const w = v.windowPorts()
    expect(w.homeExcluded().sort()).toEqual(w.running().sort())
    expect(w.homeExcluded().length).toBeGreaterThan(0)
    expect(w.linkPorts.deep).toBe(v.openDeepLink)
    expect(w.linkPorts.deep('not a link')).toBe('bad')
    const off = w.onHomeExcludedChange(() => {})
    expect(off).toBeTypeOf('function')
    off()
  })
  it('F3b #2: onHomeExcludedChange is told when the excluded set changes, not when it stays; one callback on both ports is told by each and unsubscribed from each alone', async () => {
    const v = await import('../../src/main/views.ts')
    await canvas()
    const before = registryFns.length
    const w = v.windowPorts()
    const mine = registryFns.slice(before)
    expect(mine.length).toBe(1)
    const fire = () => { for (const f of mine) f({ kind: 'entry', entry: entries.at(-1) }) }
    fire()                                   // the first look: the set it starts from
    let excluded = 0, running = 0, both = 0
    const offEx = w.onHomeExcludedChange(() => { excluded++ })
    w.onRunningChange(() => { running++ })
    const shared = () => { both++ }
    const offSharedEx = w.onHomeExcludedChange(shared)
    const offSharedRun = w.onRunningChange(shared)
    fire()                                   // nothing changed: nothing sent
    expect([excluded, running, both]).toEqual([0, 0, 0])
    // a workspace of its own joins the running set, then leaves it (only this port's listener is played)
    const extra = { ...makeEntry(900), ws: 'f3b2-excluded-ws', instance: 'inst-f3b2' }
    const add = () => { entries.push(extra) }
    const drop = () => { entries.splice(entries.indexOf(extra), 1) }
    add(); fire()                            // the set changes
    expect([excluded, running, both]).toEqual([1, 1, 2])
    expect(w.homeExcluded()).toContain('f3b2-excluded-ws')
    offSharedEx()                            // off the excluded port alone: still told by the running one
    drop(); fire()
    expect([excluded, running, both]).toEqual([2, 2, 3])
    offSharedRun()
    offEx()
    add(); fire()
    expect([excluded, running, both]).toEqual([2, 3, 3])
    drop(); fire()
  })
})

describe('spec 32 Part B: the strip\'s Marver menu, main\'s side (the real views.ts, window.ts mocked)', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const nulls = () => m.toStrip.filter(([ch, p]) => ch === CH.tabMenuView && p === null).length
  const menuCmds = () => cmdLines().filter((l) => l.cmd === 'tab-menu' || l.cmd === 'tabs-more')
  const closeLive = async () => { const n = views.menuNow(); if (n) { menuPickSend(n.rev, null); await tick() } }
  beforeEach(async () => { await closeLive(); m.stripReady = true; m.toStrip.length = 0 })
  afterEach(async () => { await closeLive(); m.stripReady = true })

  it('B1.2, B3.2: the record, then the menu set and a compose (the strip grows), then main\'s view; every compose reads it open', async () => {
    const t = await canvas()
    const before = m.composes
    const v = openTabMenu(t.id)!
    expect(m.composes).toBeGreaterThan(before)
    expect(m.menuOpen).toBe(true)
    expect(v).toMatchObject({ rev: expect.any(Number), x: 10, y: 40, kind: 'tab' })
    // B4: the rows, sentence case, the sidebar's icons, a separator before Close tab
    expect(v.rows).toEqual([
      { kind: 'item', id: 'open-browser', label: 'Open in browser', icon: 'arrow-square-out', enabled: true },
      { kind: 'item', id: 'reveal', label: 'Reveal in Finder', icon: 'folder-open', enabled: true },
      { kind: 'item', id: 'copy-link', label: 'Copy local link', icon: 'link', enabled: true },
      { kind: 'item', id: 'mark-all-seen', label: 'Mark all as seen', icon: 'check', enabled: true },
      { kind: 'item', id: 'resolve-all-comments', label: 'Resolve all comments', icon: 'check-square-offset', enabled: false },
      { kind: 'sep' },
      { kind: 'item', id: 'close', label: 'Close tab', icon: 'x', enabled: true },
    ])
    // a mark, a pill, a resize - any compose - never shrinks it
    compose()
    expect(m.menuOpen).toBe(true)
    menuShownAck(v.rev)
    compose()
    expect(m.menuOpen).toBe(true)
    // the strip's null pick for the current rev: closed, shrunk
    menuPickSend(v.rev, null)
    expect(m.menuOpen).toBe(false)
    expect(views.menuNow()).toBeNull()
  })

  it('B15: the journal `popup` record (labels and `enabled`, no `checked`) and lastPopup, kept after the menu goes', async () => {
    const t = await canvas()
    const v = openTabMenu(t.id)!
    expect(views.popupNow()).toEqual({ rev: v.rev, x: 10, y: 40, items: [
      { label: 'Open in browser', enabled: true }, { label: 'Reveal in Finder', enabled: true }, { label: 'Copy local link', enabled: true },
      { label: 'Mark all as seen', enabled: true }, { label: 'Resolve all comments', enabled: false }, { label: 'Close tab', enabled: true },
    ] })
    menuPickSend(v.rev, null)
    expect(views.popupNow()?.rev).toBe(v.rev)
  })

  it('B2: the open command is held until `tab:menu-shown`, then done; a pick records exactly one more command, the one tabAct opens', async () => {
    const t = await canvas()
    await tick()
    flushNow(); writeFileSync(file(), '')
    const v = openTabMenu(t.id)!
    await tick()
    expect(menuCmds().map((l) => l.phase)).toEqual(['start'])
    menuShownAck(v.rev)
    await tick()
    expect(menuCmds()).toEqual([expect.objectContaining({ phase: 'start', cmd: 'tab-menu', via: 'context', in: 'strip', tab: t.id }), expect.objectContaining({ phase: 'end', cmd: 'tab-menu', outcome: 'done' })])
    flushNow(); writeFileSync(file(), '')
    menuPickSend(v.rev, 'copy-link')
    await tick()
    expect(cmdLines().filter((l) => l.phase !== 'end').map((l) => [l.cmd, l.via, l.in])).toEqual([['copy-link', 'context', 'tab-menu']])
  })

  it('B2: replaced by a newer open (no shrink in between: no null sent), closed before it showed, refused as not ready', async () => {
    const a = await canvas()
    const b = await canvas()
    await tick()
    flushNow(); writeFileSync(file(), '')
    const v1 = openTabMenu(b.id)!
    m.toStrip.length = 0
    const v2 = openTabMenu(a.id, { key: false, hadFocus: true })!
    expect(v2.rev).toBeGreaterThan(v1.rev)
    expect(nulls()).toBe(0)
    expect(m.menuOpen).toBe(true)
    // the old rev's picks are refused: nothing closes, nothing runs
    menuPickSend(v1.rev, 'close')
    await tick()
    expect(views.menuNow()?.rev).toBe(v2.rev)
    expect(tabs.getTab(b.id)?.open).toBe(true)
    // closed before it showed
    menuPickSend(v2.rev, null)
    await tick()
    const ends = menuCmds().filter((l) => l.phase === 'end' || l.phase === 'once').map((l) => [l.outcome, l.why])
    expect(ends).toEqual([['noop', 'replaced'], ['noop', 'closed']])
    // not ready: refused, `tab-menu: null`, the record written all the same
    flushNow(); writeFileSync(file(), '')
    m.stripReady = false
    m.toStrip.length = 0
    m.ipcOn.get(CH.tabMenu)!(page('strip'), { id: a.id, x: 3, y: 4 })
    await tick()
    expect(m.toStrip).toEqual([[CH.tabMenuView, null]])
    expect(views.menuNow()).toBeNull()
    expect(views.popupNow()).toMatchObject({ x: 3, y: 4 })
    expect(menuCmds().filter((l) => l.outcome).map((l) => [l.outcome, l.why])).toEqual([['noop', 'not-ready']])
  })

  it('B2: every refusal answers `tab-menu: null` - no tab, Home, an empty » list, a stale id', async () => {
    await canvas()
    for (const send of [
      () => m.ipcOn.get(CH.tabMenu)!(page('strip'), { id: 'no-such', x: 1, y: 1 }),
      () => m.ipcOn.get(CH.tabMenu)!(page('strip'), { id: 'home', x: 1, y: 1 }),
      () => m.ipcOn.get(CH.tabsMore)!(page('strip'), { ids: [], x: 1, y: 1 }),
      () => m.ipcOn.get(CH.tabsMore)!(page('strip'), { ids: ['gone-1', 'gone-2'], x: 1, y: 1 }),
    ]) {
      m.toStrip.length = 0
      flushNow(); writeFileSync(file(), '')
      send()
      await tick()
      expect(m.toStrip).toEqual([[CH.tabMenuView, null]])
      expect(views.menuNow()).toBeNull()
      expect(menuCmds().map((l) => [l.outcome, l.why])).toEqual([['noop', 'no-tab']])
    }
  })

  it('B3.6: no `tab:menu-shown` within 500 ms - the menu cleared, the strip shrunk, `tab-menu: null`, the command noop no-show', async () => {
    const t = await canvas()
    await tick()
    flushNow(); writeFileSync(file(), '')
    openTabMenu(t.id)
    await sleep(450)
    expect(m.menuOpen).toBe(true)
    await sleep(100)
    expect(views.menuNow()).toBeNull()
    expect(m.menuOpen).toBe(false)
    expect(nulls()).toBe(1)
    expect(menuCmds().filter((l) => l.outcome).map((l) => [l.outcome, l.why])).toEqual([['noop', 'no-show']])
  })

  it('B3.6, B12.6: the strip\'s `unresponsive` and `render-process-gone` take the grown view back at once', async () => {
    const t = await canvas()
    for (const why of ['unresponsive', 'gone'] as const) {
      const v = openTabMenu(t.id)!
      menuShownAck(v.rev)
      expect(m.menuOpen).toBe(true)
      m.trouble!(why)
      expect(m.menuOpen).toBe(false)
      expect(views.menuNow()).toBeNull()
    }
  })

  it('B12: main\'s close sends `tab-menu: null` and keeps the strip grown until the strip\'s null pick for that rev, or 150 ms', async () => {
    const t = await canvas()
    let v = openTabMenu(t.id)!
    menuShownAck(v.rev)
    m.toStrip.length = 0
    expect(views.closeMenu()).toBe(true)
    expect(m.toStrip).toEqual([[CH.tabMenuView, null]])
    expect(m.menuOpen).toBe(true)
    compose()
    expect(m.menuOpen).toBe(true)
    menuPickSend(v.rev, null)             // the strip's ack
    expect(m.menuOpen).toBe(false)
    // no ack: 150 ms
    v = openTabMenu(t.id)!
    menuShownAck(v.rev)
    views.closeMenu()
    await sleep(100)
    expect(views.menuNow()).not.toBeNull()
    await sleep(80)
    expect(views.menuNow()).toBeNull()
    expect(m.menuOpen).toBe(false)
  })

  it('B12.3, B12.4, B12.5: a window blur, any app command, the active tab changing - each closes the menu', async () => {
    const a = await canvas()
    const b = await canvas()
    const cases: [string, () => void][] = [
      ['blur', () => emitWin('blur')],
      ['app command', () => runCommand('settings', 'menu')],
      ['active tab', () => { tabs.activate(a.id) }],
    ]
    for (const [name, act] of cases) {
      tabs.activate(b.id)
      await tick()
      const v = openTabMenu(b.id)!
      menuShownAck(v.rev)
      m.toStrip.length = 0
      act()
      if (!views.menuNow()?.closing) throw new Error(`${name}: not closed`)
      expect(nulls()).toBe(1)
      menuPickSend(v.rev, null)
      expect(m.menuOpen).toBe(false)
    }
  })

  it('B12.5: the tab it belongs to closing closes it; its own open request does not (B3.2)', async () => {
    const a = await canvas()
    const b = await canvas()
    tabs.activate(b.id)
    await tick()
    const v = openTabMenu(a.id)!
    menuShownAck(v.rev)
    m.toStrip.length = 0
    await tabs.closeTab(a.id)
    await tick()
    expect(views.menuNow()?.closing).toBe(true)
    menuPickSend(v.rev, null)
  })

  it('B13: an unknown id or a disabled row does nothing (the menu shrinks all the same); the strip never names a label', async () => {
    const t = await canvas()
    t.doc!.trusted = false
    let v = openTabMenu(t.id)!
    expect(v.rows.find((r) => r.kind === 'item' && r.id === 'open-browser')).toMatchObject({ enabled: false })
    menuShownAck(v.rev)
    await tick()
    flushNow(); writeFileSync(file(), '')
    menuPickSend(v.rev, 'open-browser')    // disabled
    await tick()
    expect(cmdLines()).toEqual([])
    expect(m.menuOpen).toBe(false)
    t.doc!.trusted = true
    v = openTabMenu(t.id)!
    menuShownAck(v.rev)
    await tick()
    flushNow(); writeFileSync(file(), '')
    menuPickSend(v.rev, 'reload')          // a row id a local tab's menu never has
    await tick()
    expect(cmdLines()).toEqual([])
    expect(m.menuOpen).toBe(false)
    // a label is refused by the bridge's check: nothing reaches main
    expect(checkPagePayload(CH.tabMenuPick, { rev: 1, id: 'Close tab' }).ok).toBe(false)
  })

  it('B5: the » menu - one row per hidden tab, `tab:<id>`, its state word, no icon and no check; a pick activates it via the overflow', async () => {
    const a = await canvas()
    const b = await canvas()
    tabs.activate(b.id)
    a.reg!.state = 'starting'
    const v = openMore([a.id, 'no-such'])!
    a.reg!.state = 'ready'
    expect(v.kind).toBe('more')
    expect(v.rows).toEqual([{ kind: 'item', id: `tab:${a.id}`, label: `${tabs.tabName(a)} - starting`, enabled: true }])
    expect(views.popupNow()!.items).toEqual([{ label: `${tabs.tabName(a)} - starting`, enabled: true }])
    menuShownAck(v.rev)
    await tick()
    flushNow(); writeFileSync(file(), '')
    menuPickSend(v.rev, `tab:${a.id}`)
    await tick()
    expect(tabs.activeTab()?.id).toBe(a.id)
    expect(cmdLines().find((l) => l.phase === 'start')).toMatchObject({ cmd: 'activate', via: 'menu', in: 'strip', tab: a.id })
  })

  it('B15: popup:click acts from main\'s record and closes the live menu; after the live menu\'s deadline it still acts from lastPopup; popup:close closes with no pick', async () => {
    const t = await canvas()
    const { effects } = await import('../../src/main/effects.ts')
    const copies: string[] = []
    const was = effects.copy
    effects.copy = (s: string) => { copies.push(s) }
    try {
      let v = openTabMenu(t.id)!
      menuShownAck(v.rev)
      expect(views.popupClick('Copy local link')).toBe(true)
      expect(copies).toEqual([`http://localhost:${t.reg!.port}/`])
      expect(views.menuNow()).toBeNull()
      expect(m.menuOpen).toBe(false)
      // the deadline passed with no show (an occluded test window): the record still acts
      openTabMenu(t.id)
      await sleep(560)
      expect(views.menuNow()).toBeNull()
      expect(views.popupClick('Copy local link')).toBe(true)
      expect(copies.length).toBe(2)
      expect(views.popupClick('Resolve all comments')).toBe(false)   // disabled
      // popup:close: the live menu closed with no pick, the strip shrunk at its ack
      v = openTabMenu(t.id)!
      menuShownAck(v.rev)
      expect(views.closeMenu()).toBe(true)
      menuPickSend(v.rev, null)
      expect(m.menuOpen).toBe(false)
      expect(copies.length).toBe(2)
    } finally { effects.copy = was }
  })

  describe('B14: focus', () => {
    const focus = () => import('../../src/main/focus.ts')
    let stripWc: FakeWc
    const pageFocus: unknown[] = []
    beforeEach(async () => {
      const f = await focus()
      stripWc = new FakeWc('marver-app://strip/')
      f.resetFocus()
      f.setFocusPorts({
        active: () => tabs.activeTab()?.id, strip: () => stripWc as never,
        content: (id) => content.get(id)?.webContents as never, page: () => undefined,
        pageFocus: (_wc, p) => { pageFocus.push(p) },
      })
      f.track(stripWc as never, { part: 'strip' })
      pageFocus.length = 0
    })
    afterEach(async () => { const f = await focus(); f.setFocusPorts(null as never); f.resetFocus() })

    it('a canvas focused, a right mousedown focuses the strip, then `tab:menu {hadFocus: false}`: prevOwner the canvas; a dismissal gives it focus back', async () => {
      const t = await canvas()
      const cv = content.get(t.id)!.webContents
      cv.emit('focus')
      stripWc.emit('focus')               // the right mousedown made the strip first responder
      const strip0 = stripWc.focused
      const v = openTabMenu(t.id, { key: false, hadFocus: false })!
      expect(views.menuNow()?.prevOwner).toEqual({ part: 'content', tab: t.id })
      // focusStripQuiet: the strip focused, no page:focus (it would take focus back from the menu's first row)
      expect(stripWc.focused).toBe(strip0 + 1)
      expect(pageFocus).toEqual([])
      menuShownAck(v.rev)
      const cv0 = cv.focused
      menuPickSend(v.rev, null)
      expect(cv.focused).toBe(cv0 + 1)
    })

    it('with `hadFocus: true` prevOwner is the strip and a dismissal leaves focus to the strip; a key open says so', async () => {
      const t = await canvas()
      const cv = content.get(t.id)!.webContents
      cv.emit('focus')
      stripWc.emit('focus')
      const v = openTabMenu(t.id, { key: true, hadFocus: true })!
      expect(views.menuNow()).toMatchObject({ key: true, hadFocus: true, prevOwner: { part: 'strip' } })
      menuShownAck(v.rev)
      const cv0 = cv.focused
      menuPickSend(v.rev, null)
      expect(cv.focused).toBe(cv0)
    })

    it('a pick that moves focus itself (an activate from ») restores nothing; one that does not (a copy) restores it', async () => {
      const a = await canvas()
      const b = await canvas()
      const cb = content.get(b.id)!.webContents
      cb.emit('focus')
      stripWc.emit('focus')
      let v = openMore([a.id])!
      menuShownAck(v.rev)
      const b0 = cb.focused
      menuPickSend(v.rev, `tab:${a.id}`)
      expect(cb.focused).toBe(b0)
      tabs.activate(b.id)
      cb.emit('focus')
      stripWc.emit('focus')
      v = openTabMenu(b.id)!
      menuShownAck(v.rev)
      const b1 = cb.focused
      menuPickSend(v.rev, 'copy-link')
      expect(cb.focused).toBe(b1 + 1)
    })
  })
})

describe('spec 32 C8: main\'s immersive gate, the views.ts glue (through the mock\'s compose)', () => {
  const FULL = { active: true, view: true, page: false, placed: 'full', seeThrough: true }
  const wish = (t: { id: string }, on: boolean, n: number) => reportFn!(t.id, docs.get(t.id)!, { immersive: { on, n } })
  afterEach(() => { m.facts.clear(); immersiveSent.length = 0; immersiveSends = true })

  it('a report composes through onReport\'s changed() (no second compose); the answer carries the wish\'s n and is sent once', async () => {
    const t = await canvas()
    m.facts.set(t.id, FULL)
    immersiveSent.length = 0
    const before = m.composes
    wish(t, true, 1)
    expect(m.composes - before).toBe(1)
    expect(immersiveSent).toEqual([{ tab: t.id, doc: docs.get(t.id), n: 1, on: true }])
    expect(t.reports.immersiveGrant).toBe('on')
    expect(m.stripShown.get(t.id)).toBe(false)
    compose(); compose()
    expect(immersiveSent.length).toBe(1)
  })

  it('H on, H off, H on: on, then `{on: false}` with no end (the shell\'s own off: grant none), then on again', async () => {
    const t = await canvas()
    m.facts.set(t.id, FULL)
    wish(t, true, 1)
    wish(t, false, 2)
    expect(t.reports.immersiveGrant).toBeUndefined()
    expect(m.stripShown.get(t.id)).toBe(true)
    wish(t, true, 3)
    expect(immersiveSent.map((x) => [x.n, x.on, x.end])).toEqual([[1, true, undefined], [2, false, undefined], [3, true, undefined]])
    expect(m.stripShown.get(t.id)).toBe(false)
  })

  it('main takes it away (a hang): `{on: false, end: true}` once; the shell\'s off then is answered; the next wish meets the gate', async () => {
    const t = await canvas()
    m.facts.set(t.id, FULL)
    wish(t, true, 1)
    t.hung = true
    compose()
    compose()
    expect(immersiveSent.slice(1)).toEqual([{ tab: t.id, doc: docs.get(t.id), n: 1, on: false, end: true }])
    expect(t.reports.immersiveGrant).toBe('ended')
    expect(m.stripShown.get(t.id)).toBe(true)
    wish(t, false, 2)
    expect(t.reports.immersiveGrant).toBeUndefined()
    t.hung = false
    wish(t, true, 3)
    expect(immersiveSent.at(-1)).toMatchObject({ n: 3, on: true })
  })

  it('ended, then a reload (a commit): the reports reset clears the grant, and a wish on is granted', async () => {
    const t = await canvas()
    m.facts.set(t.id, FULL)
    wish(t, true, 1)
    t.reg!.state = 'gone'
    compose()
    expect(t.reports.immersiveGrant).toBe('ended')
    t.reg!.state = 'ready'
    wish(t, true, 2)
    expect(immersiveSent.at(-1)).toMatchObject({ n: 2, on: false })
    expect(immersiveSent.at(-1)!.end).toBeUndefined()
    await commit(t.id)
    expect(t.reports.immersiveGrant).toBeUndefined()
    wish(t, true, 1)                       // a new document's preload counts from 1
    expect(immersiveSent.at(-1)).toEqual({ tab: t.id, doc: docs.get(t.id), n: 1, on: true })
    expect(t.reports.immersiveGrant).toBe('on')
  })

  it('a send that could not go out is made again by the next compose (answered only when sent)', async () => {
    const t = await canvas()
    m.facts.set(t.id, { ...FULL, placed: 'below' })
    immersiveSends = false
    wish(t, true, 1)
    expect(t.reports.immersiveAnswered).toBeUndefined()
    immersiveSends = true
    compose()
    expect(t.reports.immersiveAnswered).toBe(1)
    expect(immersiveSent.map((x) => [x.n, x.on])).toEqual([[1, false], [1, false]])
    compose()
    expect(immersiveSent.length).toBe(2)
  })

  it('a tab that is not the active one is refused; a tab switch ends a granted one', async () => {
    const t = await canvas()
    m.facts.set(t.id, { ...FULL, active: false })
    wish(t, true, 1)
    expect(immersiveSent.at(-1)).toMatchObject({ n: 1, on: false })
    m.facts.set(t.id, FULL)
    compose()
    expect(immersiveSent.at(-1)).toMatchObject({ n: 1, on: true })
    m.facts.set(t.id, { ...FULL, active: false })
    compose()
    expect(immersiveSent.at(-1)).toMatchObject({ n: 1, on: false, end: true })
  })

  it('C8.1: F6 while immersive - main ends it (the strip back first), then focuses the strip; the grant then reads ended', async () => {
    const t = await canvas()
    m.facts.set(t.id, FULL)
    wish(t, true, 1)
    expect(m.stripShown.get(t.id)).toBe(false)
    runCommand('focus-strip', 'key', { keys: 'F6', in: 'shell' })
    expect(m.stripShown.get(t.id)).toBe(true)
    expect(immersiveSent.at(-1)).toMatchObject({ n: 1, on: false, end: true })
    expect(t.reports.immersiveGrant).toBe('ended')
    // the shell turns Hide UI off, then on again: the gate decides again (main's end does not latch)
    wish(t, false, 2)
    wish(t, true, 3)
    expect(immersiveSent.at(-1)).toMatchObject({ n: 3, on: true })
  })

  it('B12.8: turning immersive on closes the strip\'s menu first', async () => {
    const t = await canvas()
    const v = openTabMenu(t.id)!
    menuShownAck(v.rev)
    m.facts.set(t.id, FULL)
    m.toStrip.length = 0
    wish(t, true, 1)
    expect(views.menuNow()?.closing).toBe(true)
    expect(m.toStrip).toEqual([[CH.tabMenuView, null]])
    menuPickSend(v.rev, null)
  })
})

describe('spec 32 D6.4, D6.5: Home\'s excluded workspaces and a marver:// link to a gone tab\'s canvas (views.ts)', () => {
  const real = () => realpathSync(mkdtempSync(join(base, 'ws-')))
  /** a canvas of a real folder (its ws as the app derives it), shown and committed; `slot` another instance's */
  async function folderCanvas(root: string, slot?: number) {
    const e = { ...makeEntry(++n), root, ws: workspaceOf(root), ...(slot !== undefined ? { slot, port: 40100 + slot, origin: `http://[::1]:${40100 + slot}` } : {}) }
    entries.push(e)
    tabs.onRegistry({ kind: 'entry', entry: e as never })
    const t = tabs.allTabs().find((x) => x.reg?.instance === e.instance)!
    tabs.activate(t.id)
    await tick()
    return { t, e }
  }
  const stop = (e: { file: string; instance: string }) => {
    entries.splice(entries.indexOf(e as never), 1)
    tabs.onRegistry({ kind: 'gone', file: e.file, instance: e.instance, why: 'pid' })
  }
  const lastFocus = () => m.held.filter(([ch]) => ch === CH.homeFocus).at(-1)?.[1]

  it('homeExcluded: the running set and every open gone tab\'s workspace; running() (the quit\'s flushRecent) never a gone one; closing the gone tab tells the listener at once', async () => {
    const w = views.windowPorts()
    const { t, e } = await folderCanvas(real())
    let told = 0
    const off = w.onHomeExcludedChange(() => { told++ })
    stop(e)
    expect(tabs.getTab(t.id)?.open).toBe(true)
    expect(w.running()).not.toContain(e.ws)
    expect(w.homeExcluded()).toContain(e.ws)
    const after = told
    await tabs.closeTab(t.id)
    await tick()
    expect(tabs.getTab(t.id)).toBeUndefined()
    expect(w.homeExcluded()).not.toContain(e.ws)
    expect(told).toBeGreaterThan(after)
    off()
  })

  it('a link to a canvas whose gone tab is open focuses that tab\'s card; with two gone instances the first in strip order, or the one on the link\'s port', async () => {
    const root = real()
    const one = await folderCanvas(root, 70)
    const two = await folderCanvas(root, 71)
    expect(one.t.id).not.toBe(two.t.id)
    stop(one.e); stop(two.e)
    m.held.length = 0
    expect(views.openDeepLink(buildDeepLink({ ws: root })!)).toBe('home')
    const order = tabs.ordered().map((x) => x.id)
    const first = order.indexOf(one.t.id) < order.indexOf(two.t.id) ? one.t : two.t
    expect(lastFocus()).toEqual({ field: 'recent', id: first.id })
    const other = first === one.t ? two : one
    views.openDeepLink(buildDeepLink({ ws: root, port: other.e.port })!)
    expect(lastFocus()).toEqual({ field: 'recent', id: other.t.id })
    // a port no gone tab is on: the first again
    views.openDeepLink(buildDeepLink({ ws: root, port: 40999 })!)
    expect(lastFocus()).toEqual({ field: 'recent', id: first.id })
    await tabs.closeTab(one.t.id); await tabs.closeTab(two.t.id)
    // none left open: the recent card's id (showLinked), never a closed tab's
    m.held.length = 0
    views.openDeepLink(buildDeepLink({ ws: root })!)
    expect(lastFocus()).not.toEqual({ field: 'recent', id: first.id })
  })
})

describe('the page funnel (bridge.ts:625-650)', () => {
  it('tab:activate carries via; the strip by key, by click, and the `shown` ends it', async () => {
    const a = await canvas()
    tabs.activate('home')
    await tick()
    flushNow(); writeFileSync(file(), '')
    const on = m.ipcOn.get(CH.tabActivate)!
    on(page('strip'), { id: a.id, via: 'key' })
    await tick()
    answerShown(a.id)
    expect(cmdLines().find((l) => l.phase === 'start')).toMatchObject({ cmd: 'tab-activate', via: 'key', in: 'strip', tab: a.id })
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ outcome: 'done' })
    tabs.activate('home')
    flushNow(); writeFileSync(file(), '')
    on(page('home'), { id: a.id })
    await tick()
    expect(cmdLines().find((l) => l.phase === 'start')).toMatchObject({ cmd: 'tab-activate', via: 'click', in: 'home' })
  })
  it('the allowlist: `via` kept when it is one of the two, a wrong one refuses the message, nothing else passes', () => {
    expect(checkPagePayload(CH.tabActivate, { id: 't1', via: 'key', x: 1 })).toEqual({ ok: true, value: { id: 't1', via: 'key' } })
    expect(checkPagePayload(CH.tabActivate, { id: 't1', via: 'click' })).toEqual({ ok: true, value: { id: 't1', via: 'click' } })
    expect(checkPagePayload(CH.tabActivate, { id: 't1' })).toEqual({ ok: true, value: { id: 't1' } })
    expect(checkPagePayload(CH.tabActivate, { id: 't1', via: 'drag' }).ok).toBe(false)
    expect(checkPagePayload(CH.linkOpen, { url: 'x', via: 'click' })).toEqual({ ok: true, value: { url: 'x', via: 'click' } })
    expect(checkPagePayload(CH.linkOpen, { url: 'x', via: 'key' }).ok).toBe(false)
    expect(checkPagePayload(CH.pillAction, { rev: 1, act: 'dismiss', via: 'key' })).toEqual({ ok: true, value: { rev: 1, act: 'dismiss', via: 'key' } })
    expect(checkPagePayload(CH.pillAction, { rev: 1, act: 'dismiss', via: 'click' }).ok).toBe(false)
  })
  it('spec 32 D8.8: Home\'s own fields - cancel and keys on tab:activate, link:open by key - kept from Home alone', () => {
    const both = { id: 't1', via: 'key', cancel: true, keys: 'Enter' }
    expect(checkPagePayload(CH.tabActivate, both, 'home')).toEqual({ ok: true, value: both })
    expect(checkPagePayload(CH.tabActivate, both, 'strip')).toEqual({ ok: true, value: { id: 't1', via: 'key' } })
    expect(checkPagePayload(CH.tabActivate, both)).toEqual({ ok: true, value: { id: 't1', via: 'key' } })   // absent reads not Home
    expect(checkPagePayload(CH.tabActivate, { id: 't1', via: 'key', keys: 'Space' }, 'home')).toEqual({ ok: true, value: { id: 't1', via: 'key', keys: 'Space' } })
    for (const bad of [{ cancel: false }, { cancel: 'yes' }, { keys: 'Escape' }, { keys: 1 }]) expect(checkPagePayload(CH.tabActivate, { id: 't1', via: 'key', ...bad }, 'home').ok, JSON.stringify(bad)).toBe(false)
    expect(checkPagePayload(CH.linkOpen, { url: 'x', via: 'key', keys: 'Enter' }, 'home')).toEqual({ ok: true, value: { url: 'x', via: 'key', keys: 'Enter' } })
    expect(checkPagePayload(CH.linkOpen, { url: 'x', via: 'key', keys: 'Space' }, 'home')).toEqual({ ok: true, value: { url: 'x', via: 'key', keys: 'Space' } })
    expect(checkPagePayload(CH.linkOpen, { url: 'x', via: 'key' }, 'home').ok).toBe(false)                    // no keys
    expect(checkPagePayload(CH.linkOpen, { url: 'x', via: 'key', keys: 'Escape' }, 'home').ok).toBe(false)
    expect(checkPagePayload(CH.linkOpen, { url: 'x', via: 'key', keys: 'Enter' }, 'strip').ok).toBe(false)    // not from Home
    expect(checkPagePayload(CH.linkOpen, { url: 'x', via: 'key', keys: 'Enter' }).ok).toBe(false)
    expect(checkPagePayload(CH.linkOpen, { url: 'x', keys: 'Enter' }, 'home')).toEqual({ ok: true, value: { url: 'x' } })   // no via: Return, keys stripped
  })
  it('Esc in Home\'s link field (`cancel`): link-cancel; with no tab to go back to, noop no-tab and nothing else', async () => {
    const a = await canvas()
    tabs.activate('home')
    await tick()
    flushNow(); writeFileSync(file(), '')
    const on = m.ipcOn.get(CH.tabActivate)!
    on(page('home'), { id: 'home', via: 'key', cancel: true })
    await tick()
    expect(cmdLines()).toEqual([expect.objectContaining({ phase: 'once', cmd: 'link-cancel', via: 'key', keys: 'Escape', in: 'home', outcome: 'noop', why: 'no-tab' })])
    expect(tabs.activeTab()?.id).toBe('home')
    flushNow(); writeFileSync(file(), '')
    on(page('home'), { id: a.id, via: 'key', cancel: true })
    await tick()
    answerShown(a.id)
    expect(tabs.activeTab()?.id).toBe(a.id)
    expect(cmdLines().find((l) => l.phase === 'start')).toMatchObject({ cmd: 'link-cancel', tab: a.id })
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ outcome: 'done' })
  })
  it('spec 32 D8.8: a Home card by Enter or Space is tab-activate with its key, never link-cancel; the strip\'s `cancel` is stripped', async () => {
    const a = await canvas()
    tabs.activate('home')
    await tick()
    const on = m.ipcOn.get(CH.tabActivate)!
    for (const keys of ['Enter', 'Space'] as const) {
      tabs.activate('home')
      await tick()
      flushNow(); writeFileSync(file(), '')
      on(page('home'), { id: a.id, via: 'key', keys })
      await tick()
      answerShown(a.id)
      expect(cmdLines().find((l) => l.phase === 'start'), keys).toMatchObject({ cmd: 'tab-activate', via: 'key', keys, in: 'home', tab: a.id })
      expect(cmdLines().some((l) => l.cmd === 'link-cancel')).toBe(false)
    }
    // by key with no key named (an older page): still tab-activate, no keys
    tabs.activate('home')
    await tick()
    flushNow(); writeFileSync(file(), '')
    on(page('home'), { id: a.id, via: 'key' })
    await tick()
    answerShown(a.id)
    const start = cmdLines().find((l) => l.phase === 'start')
    expect(start).toMatchObject({ cmd: 'tab-activate', via: 'key', in: 'home' })
    expect(start?.keys).toBeUndefined()
    // the strip cannot say `cancel`: the bridge strips it, and the strip's key reads tab-activate
    tabs.activate('home')
    await tick()
    flushNow(); writeFileSync(file(), '')
    on(page('strip'), { id: a.id, via: 'key', cancel: true, keys: 'Enter' })
    await tick()
    answerShown(a.id)
    const s2 = cmdLines().find((l) => l.phase === 'start')
    expect(s2).toMatchObject({ cmd: 'tab-activate', via: 'key', in: 'strip' })
    expect(s2?.keys).toBeUndefined()
  })
  it('tab:close ends on the tab gone; an unknown tab is a noop', async () => {
    const a = await canvas()
    flushNow(); writeFileSync(file(), '')
    const on = m.ipcOn.get(CH.tabClose)!
    on(page('strip'), { id: a.id })
    await tick(); await tick(); await tick()
    expect(cmdLines().find((l) => l.phase === 'start')).toMatchObject({ cmd: 'tab-close', via: 'key', in: 'strip', tab: a.id })
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ outcome: 'done' })
    flushNow(); writeFileSync(file(), '')
    on(page('strip'), { id: 'no-such' })
    await tick()
    expect(cmdLines()).toEqual([expect.objectContaining({ phase: 'once', cmd: 'tab-close', outcome: 'noop', why: 'no-tab' })])
  })
  it('link:open: failed with its code; a card says click, Return says key', async () => {
    const answers: unknown[] = []
    bridge.handle(CH.linkOpen, async () => ({ ok: false, why: 'nothing' }))
    const ask = m.ipcHandle.get(CH.linkOpen)!
    answers.push(await ask(page('home'), { url: 'http://localhost:4806/' }))
    expect(answers).toEqual([{ ok: false, why: 'nothing' }])
    await tick()
    expect(cmdLines().map((l) => [l.phase, l.cmd, l.via, l.keys, l.outcome, l.why].filter((x) => x !== undefined))).toEqual([['start', 'link-open', 'key', 'Enter'], ['end', 'link-open', 'failed', 'nothing']])
    flushNow(); writeFileSync(file(), '')
    bridge.handle(CH.linkOpen, async () => ({ ok: true }))
    await ask(page('home'), { url: 'https://x.example/', via: 'click' })
    await tick()
    expect(cmdLines().map((l) => [l.phase, l.via, l.outcome].filter(Boolean))).toEqual([['start', 'click'], ['end', 'done']])
    // spec 32 D8.8: a past shared link's card by Enter or Space
    for (const keys of ['Enter', 'Space']) {
      flushNow(); writeFileSync(file(), '')
      await ask(page('home'), { url: 'https://x.example/', via: 'key', keys })
      await tick()
      expect(cmdLines().find((l) => l.phase === 'start'), keys).toMatchObject({ cmd: 'link-open', via: 'key', keys, in: 'home' })
    }
    // from the strip, `via: 'key'` is refused: no command, the channel's own no
    flushNow(); writeFileSync(file(), '')
    expect(await ask(page('strip'), { url: 'https://x.example/', via: 'key', keys: 'Enter' })).toEqual({ ok: false, why: 'bad' })
    await tick()
    expect(cmdLines()).toEqual([])
  })
  it('home:action: copy names which, copy-start missing fails', async () => {
    let answer = { ok: true }
    bridge.handle(CH.homeAction, async () => answer)
    const ask = m.ipcHandle.get(CH.homeAction)!
    await ask(page('home'), { action: 'copy', id: 'init' })
    await tick()
    expect(cmdLines().find((l) => l.phase === 'start')).toMatchObject({ cmd: 'copy', arg: 'init', in: 'home' })
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ outcome: 'done' })
    flushNow(); writeFileSync(file(), '')
    answer = { ok: false }
    await ask(page('home'), { action: 'copy-start', id: 'r_x' })
    await tick()
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ cmd: 'copy-start', outcome: 'failed', why: 'missing' })
    flushNow(); writeFileSync(file(), '')
    answer = { ok: true }
    await ask(page('home'), { action: 'show-files' })
    await tick()
    expect(cmdLines().find((l) => l.phase === 'start')).toMatchObject({ cmd: 'show-files', in: 'home' })
  })
  it('spec 32 D8.1, D8.8: a card\'s copy-link, copy-path and reveal, by click or by key; main\'s `{ ok: false }` ends failed missing', async () => {
    let answer: { ok: boolean; why?: string } = { ok: true }
    bridge.handle(CH.homeAction, async () => answer)
    const ask = m.ipcHandle.get(CH.homeAction)!
    for (const action of ['copy-link', 'copy-path', 'reveal']) {
      flushNow(); writeFileSync(file(), '')
      answer = { ok: true }
      await ask(page('home'), { action, id: 't1' })
      await tick()
      expect(cmdLines().find((l) => l.phase === 'start'), action).toMatchObject({ cmd: action, via: 'click', in: 'home' })
      expect(cmdLines().find((l) => l.phase === 'end'), action).toMatchObject({ outcome: 'done' })
      flushNow(); writeFileSync(file(), '')
      answer = { ok: false, why: 'missing' }
      await ask(page('home'), { action, id: 's_0123456789abcdef', via: 'key', keys: 'Space' })
      await tick()
      expect(cmdLines().find((l) => l.phase === 'start'), action).toMatchObject({ cmd: action, via: 'key', keys: 'Space', in: 'home' })
      expect(cmdLines().find((l) => l.phase === 'end'), action).toMatchObject({ outcome: 'failed', why: 'missing' })
    }
    // a copy row by Enter records it; a bad key refuses the message (no command, `{ ok: false }`)
    flushNow(); writeFileSync(file(), '')
    answer = { ok: true }
    await ask(page('home'), { action: 'copy-start', id: 'r_x', via: 'key', keys: 'Enter' })
    await tick()
    expect(cmdLines().find((l) => l.phase === 'start')).toMatchObject({ cmd: 'copy-start', via: 'key', keys: 'Enter', in: 'home' })
    flushNow(); writeFileSync(file(), '')
    expect(await ask(page('home'), { action: 'copy-path', id: 't1', via: 'key', keys: 'Tab' })).toEqual({ ok: false })
    expect(await ask(page('home'), { action: 'copy-path', id: 't1', via: 'drag' })).toEqual({ ok: false })
    await tick()
    expect(cmdLines()).toEqual([])
  })
  it('settings: `setting`\'s arg is the key, never the value; failed with its code; the reveal and the notification pane', async () => {
    let answer: unknown = { ok: true }
    bridge.handle(CH.settingsSet, async () => answer)
    bridge.handle(CH.settingsReveal, () => {})
    bridge.handle(CH.settingsAction, () => {})
    const ask = m.ipcHandle.get(CH.settingsSet)!
    await ask(page('settings'), { file: 'config', key: 'restoreTabs', value: false })
    await tick()
    expect(cmdLines().find((l) => l.phase === 'start')).toMatchObject({ cmd: 'setting', arg: 'restoreTabs', in: 'settings', via: 'click' })
    flushNow(); writeFileSync(file(), '')
    answer = { ok: false, why: 'unwritable' }
    await ask(page('settings'), { file: 'theme', key: 'mode', value: 'dark' })
    await tick()
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ outcome: 'failed', why: 'unwritable' })
    flushNow(); writeFileSync(file(), '')
    m.ipcOn.get(CH.settingsReveal)!(page('settings'), undefined)
    m.ipcOn.get(CH.settingsAction)!(page('settings'), { action: 'open-notification-settings' })
    await tick()
    expect(cmdLines().filter((l) => l.phase === 'start').map((l) => l.cmd)).toEqual(['settings-reveal', 'notification-settings'])
  })
  it('settings:get and app:ready are no input', async () => {
    bridge.handle(CH.settingsGet, async () => ({ dir: '~' }))
    await m.ipcHandle.get(CH.settingsGet)!(page('settings'), undefined)
    await tick()
    expect(cmdLines()).toEqual([])
  })
  it('the pill: a stale rev is a noop, Esc says key, in pill', async () => {
    m.ipcOn.get(CH.pillAction)!(page('strip'), { rev: 999, act: 'dismiss', via: 'key' })
    await tick()
    expect(cmdLines()).toEqual([expect.objectContaining({ phase: 'once', cmd: 'pill-dismiss', via: 'key', keys: 'Escape', in: 'pill', outcome: 'noop', why: 'stale' })])
  })
  it('a tab page: a stale rev is a noop; export ends on its file (saved, cancelled, failed), retry on the new document\'s hello', async () => {
    const w = await import('../../src/main/window.ts')
    const t = await canvas()
    const on = m.ipcOn.get(CH.tabpageAction)!
    const sender = page('tabpage', t.id)
    on(sender, { rev: 1, action: 'export-report' })
    await tick()
    expect(cmdLines()).toEqual([expect.objectContaining({ phase: 'once', cmd: 'export-report', in: 'tabpage', tab: t.id, outcome: 'noop', why: 'stale' })])
    // the tab page's record: the bridge asks the window which page this is
    const body = { page: 'crashed', latched: true, name: 'x', since: 0, rev: 7 }
    vi.spyOn(w, 'pageOf').mockImplementation(() => ({ tab: t.id, rev: 7, body: body as never }))
    flushNow(); writeFileSync(file(), '')
    const { dialog } = await import('electron')
    // Save Report: to a real file under the temporary home, written by report.ts
    const out = join(base, 'report.json')
    vi.spyOn(dialog, 'showSaveDialog').mockResolvedValue({ canceled: false, filePath: out } as never)
    on(sender, { rev: 7, action: 'export-report' })
    await tick()
    expect(cmdLines().map((l) => l.phase)).toEqual(['start'])     // the dispatch returned; the work goes on
    await vi.waitFor(() => { expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ cmd: 'export-report', outcome: 'done' }) })
    expect(existsSync(out)).toBe(true)
    flushNow(); writeFileSync(file(), '')
    vi.spyOn(dialog, 'showSaveDialog').mockResolvedValue({ canceled: true } as never)
    on(sender, { rev: 7, action: 'export-report' })
    await vi.waitFor(() => { expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ outcome: 'cancelled' }) })
    flushNow(); writeFileSync(file(), '')
    vi.spyOn(dialog, 'showSaveDialog').mockRejectedValue(Object.assign(new Error('nope'), { code: 'EPERM' }))
    on(sender, { rev: 7, action: 'export-report' })
    await vi.waitFor(() => { expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ outcome: 'failed', why: 'panel' }) })
    // Try Again ends on the new document's hello, never on the dispatch returning
    flushNow(); writeFileSync(file(), '')
    body.page = 'unverified'
    t.retained = false
    on(sender, { rev: 7, action: 'retry' })
    await tick()
    expect(cmdLines().map((l) => [l.phase, l.cmd, l.in])).toEqual([['start', 'retry', 'tabpage']])
    await commit(t.id)
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ cmd: 'retry', outcome: 'done', tab: t.id })
    vi.mocked(w.pageOf).mockRestore()
  })
})

describe('other inputs (the R12 rows)', () => {
  it('the Dock icon: dock-activate, in main, done with the window shown', async () => {
    for (const f of m.appOn.get('activate') ?? []) f()
    await tick()
    expect(cmdLines().map((l) => [l.phase, l.cmd, l.via, l.in, l.outcome].filter(Boolean))).toEqual([['start', 'dock-activate', 'click', 'main'], ['end', 'dock-activate', 'done']])
  })
  it('the "not responding" sheet: Wait is cancelled; Reload ends on the new document\'s hello', async () => {
    const t = await canvas()
    tabs.activate(t.id)
    await tick()
    const wc = content.get(t.id)!.webContents
    ;(wc.mainFrame as { executeJavaScript: unknown }).executeJavaScript = () => new Promise(() => {})
    const { currentPill, recompute } = await import('../../src/main/pill.ts')
    wc.emit('unresponsive')
    recompute()                                                       // compose's, in the real window
    flushNow(); writeFileSync(file(), '')
    m.dialogResponse = 0                                              // Wait
    expect(pageHandlers.pillAction(currentPill()!.rev, 'button')).toBe(true)
    await vi.waitFor(() => { expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ cmd: 'hang-reload', outcome: 'cancelled', why: 'wait', tab: t.id }) }, { timeout: 3000 })
    flushNow(); writeFileSync(file(), '')
    m.dialogResponse = 1                                              // Reload Page
    expect(pageHandlers.pillAction(currentPill()!.rev, 'button')).toBe(true)
    await vi.waitFor(() => { expect(cmdLines().find((l) => l.phase === 'start')).toMatchObject({ cmd: 'hang-reload', via: 'click', in: 'main' }) }, { timeout: 3000 })
    expect(cmdLines().find((l) => l.phase === 'end')).toBe(undefined)
    // the renderer main ended is that command's own work, no failure of it
    wc.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 })
    await tick()
    expect(cmdLines().find((l) => l.phase === 'end')).toBe(undefined)
    await commit(t.id)
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ cmd: 'hang-reload', outcome: 'done' })
    m.dialogResponse = 0
  })
  it('the updater\'s alert: a fixed button name; OK backs out, anything else is its work', async () => {
    const upd = await import('../../src/main/updater.ts')
    const { FakeClock, FakeUpdater } = await import('../../src/main/testing/updater.ts')
    let answer = 'Download'
    const opened: string[] = []
    upd.startUpdater({
      record: () => {}, openExternal: (x) => { opened.push(x) }, reveal: () => {}, ask: async () => answer,
      adapter: new FakeUpdater(), clock: new FakeClock(), gates: { inApplications: false, writable: true }, feed: 'https://example.invalid/f.json', version: '0.99.1',
    })
    const act = () => upd.updateAct({ act: 'explain', why: 'location' })
    expect(act()).toBe(true)
    await tick()
    expect(opened.length).toBe(1)
    expect(cmdLines().map((l) => [l.phase, l.cmd, l.arg, l.outcome].filter(Boolean))).toEqual([['start', 'update-alert', 'Download'], ['end', 'update-alert', 'done']])
    flushNow(); writeFileSync(file(), '')
    answer = 'OK'
    expect(act()).toBe(true)
    await tick()
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ cmd: 'update-alert', outcome: 'cancelled' })
    upd.resetUpdater()
  })
})

describe('reopen (R13: `by`)', () => {
  it('an unloaded tab\'s activation: the `reopen` record names its command and ends it, at the document\'s hello', async () => {
    const t = await canvas()
    tabs.activate('home')
    await tick()
    t.unload = { phase: 'closing', reason: 'pressure', at: Date.now(), origin: t.reg!.origin } as never
    tabs.onUnloaded(t)
    await tick()
    flushNow(); writeFileSync(file(), '')
    const d = tabs.keyOf(t)!
    runCommand((d === 9 ? 'tab-last' : `tab-${d}`) as never, 'key', { keys: `Meta+${d}`, in: 'home' })
    await tick()
    const start = cmdLines().find((l) => l.phase === 'start')!
    expect(start).toMatchObject({ via: 'key', in: 'home', tab: t.id })
    expect(lines().find((l) => l.kind === 'reopen')).toBe(undefined)
    await commit(t.id)
    expect(lines().find((l) => l.kind === 'reopen')).toMatchObject({ tab: t.id, by: start.id })
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ id: start.id, outcome: 'done' })
  })
})

describe('notice-open (the row at R12)', () => {
  beforeEach(() => { tabs.setOpenSender(() => true) })
  afterEach(() => { tabs.setOpenSender(null) })
  /** What notify.ts does at the click, the bridge at `mv:opened`, tabs.ts at a drop. */
  const click = (tab: string, item: { id: string; kind: string; board: string; thread: string; msg: string } | null) => {
    const h = cmds.appCmd('notice-open', { via: 'click', in: 'main', tab })
    if (item) cmds.waitNotice(h, item.id)
    cmds.withAppCmd(h, () => { tabs.openForNotice(tab, item as never); if (!item) cmds.activated(h, tab) })
    return h
  }
  const ITEM = (n: number) => ({ id: `ask:${String(n).padStart(20, '0')}`, kind: 'ask', board: 'main', thread: 't', msg: 'm' })
  it('with an item: mv:opened decides - handled done, stale and missing failed, busy noop, dropped unobserved', async () => {
    const t = await canvas()
    for (const [i, [result, want]] of ([['handled', { outcome: 'done' }], ['stale', { outcome: 'failed', why: 'stale' }], ['missing', { outcome: 'failed', why: 'missing' }], ['busy', { outcome: 'noop', why: 'busy' }], ['dropped', { outcome: 'unobserved', why: 'dropped' }]] as const).entries()) {
      flushNow(); writeFileSync(file(), '')
      const it = ITEM(100 + i)
      click(t.id, it)
      await tick()
      cmds.noticeAnswered(it.id, result)
      expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject(want)
    }
  })
  it('dropped in main: another tab, superseded cancelled; wait unobserved; a canvas that takes no items failed unsupported', async () => {
    const t = await canvas()
    const it = ITEM(201)
    flushNow(); writeFileSync(file(), '')
    t.reports.hello = undefined                                       // held until a hello
    click(t.id, it)
    await tick()
    tabs.activate('home')
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ outcome: 'cancelled', why: 'another tab' })
    flushNow(); writeFileSync(file(), '')
    const a = ITEM(202), b = ITEM(203)
    click(t.id, a)
    await tick()
    click(t.id, b)
    await tick()
    expect(cmdLines().filter((l) => l.phase === 'end')).toEqual([expect.objectContaining({ outcome: 'cancelled', why: 'superseded' })])
    flushNow(); writeFileSync(file(), '')
    cmds.noticeDropped(b.id, 'wait')
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ outcome: 'unobserved', why: 'wait' })
    flushNow(); writeFileSync(file(), '')
    t.reg!.features = ['bridge']
    click(t.id, ITEM(204))
    await tick()
    expect(cmdLines().filter((l) => l.phase === 'end').at(-1)).toMatchObject({ outcome: 'failed', why: 'unsupported' })
    t.reg!.features = ['bridge', 'open']
  })
  it('a send that did not go: failed not-sent', async () => {
    const t = await canvas()
    tabs.setOpenSender(() => false)
    flushNow(); writeFileSync(file(), '')
    click(t.id, ITEM(301))
    await tick()
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ outcome: 'failed', why: 'not-sent' })
  })
  it('without an item (a stopped canvas\'s notice): the tab shown', async () => {
    const t = await canvas()
    tabs.activate('home')
    await tick()
    flushNow(); writeFileSync(file(), '')
    click(t.id, null)
    await tick()
    expect(cmdLines().filter((l) => l.phase === 'end')).toEqual([])
    answerShown(t.id)
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ cmd: 'notice-open', outcome: 'done' })
  })
})

describe('move-to-apps: the durable handoff (the row at R12)', () => {
  /** A rig enough for the Finder route: an older Marver in Applications, an in-memory update.json. */
  const rig = (button: string) => {
    const apps = mkdtempSync(join(base, 'apps-'))
    mkdirSync(join(apps, 'Marver.app', 'Contents'), { recursive: true })
    const f: { v: 1; intent: null; move: unknown; staging: null } = { v: 1, intent: null, move: null, staging: null }
    const states: unknown[] = []
    const ports = {
      bundle: '/Applications-not/Marver.app', version: '1.0.1', apps, pid: 1, now: () => Date.now(),
      read: () => structuredClone(f) as never, write: (x: { move: unknown }) => { f.move = x.move; states.push(structuredClone(x.move)); return true },
      record: () => {}, run: () => ({ code: 0, out: '' }), plist: () => ({ CFBundleIdentifier: 'design.marver.app', CFBundleShortVersionString: '0.3.0' }),
      writable: () => true, from: () => '', ask: async () => ({ button, checked: false }), reveal: () => {}, relaunch: () => {}, quit: () => {},
    }
    return { ports: ports as never, f, states }
  }
  it('Show Both: pending before it acts, the result after; the next recorder writes it once and clears it', async () => {
    const r = rig('Show Both')
    expect(await offerMove(r.ports, { feed: 'f', inApplications: false })).toBe('go-on')
    expect(r.states.map((s) => (s as { cmd: { state: string; answer: string } }).cmd.state)).toEqual(['pending', 'revealed'])
    expect((r.states[0] as { cmd: { answer: string } }).cmd.answer).toBe('Show Both')
    const read = () => structuredClone(r.f) as never
    const write = (x: { move: unknown }) => { r.f.move = x.move; return true }
    expect(takeMoveCmd(read, write as never)).toMatchObject({ state: 'revealed' })
    expect(r.f.move).toBe(null)
    expect(cmdLines().map((l) => [l.phase, l.cmd, l.via, l.in, l.arg, l.outcome, l.why].filter((x) => x !== undefined))).toEqual([
      ['start', 'move-to-apps', 'click', 'main', 'Show Both'], ['end', 'move-to-apps', 'done', 'revealed'],
    ])
    expect(takeMoveCmd(read, write as never)).toBe(null)            // once
    expect(cmdLines().length).toBe(2)
  })
  it('Cancel: cancelled, declined', async () => {
    const r = rig('Cancel')
    await offerMove(r.ports, { feed: 'f', inApplications: false })
    takeMoveCmd(() => structuredClone(r.f) as never, ((x: { move: unknown }) => { r.f.move = x.move; return true }) as never)
    expect(cmdLines().at(-1)).toMatchObject({ phase: 'end', outcome: 'cancelled', why: 'declined' })
  })
  it('still pending at the next recorder (the process ended mid-move): unobserved, why unknown', () => {
    const f = { v: 1, intent: null, move: { cmd: { id: '0123456789ab', at: Date.now() - 500, answer: 'Open It', state: 'pending' } }, staging: null }
    takeMoveCmd(() => f as never, ((x: { move: unknown }) => { f.move = x.move as never; return true }) as never)
    expect(cmdLines().at(-1)).toMatchObject({ phase: 'end', id: '0123456789ab', outcome: 'unobserved', why: 'unknown' })
    expect(cmdLines().at(-1)!.ms).toBeGreaterThanOrEqual(500)
    expect(f.move).toBe(null)
  })
  it('beside a moved note: the note stays for the updater; a clear that does not land writes nothing, and waits', () => {
    const f = { v: 1, intent: null, move: { moved: true, at: 1, from: 'dmg', cmd: { id: '0123456789ab', at: 1, answer: 'Move', state: 'moved', doneAt: 41 } }, staging: null }
    takeMoveCmd(() => f as never, () => false)
    expect(cmdLines()).toEqual([])
    takeMoveCmd(() => f as never, ((x: { move: unknown }) => { f.move = x.move as never; return true }) as never)
    expect(f.move).toEqual({ moved: true, at: 1, from: 'dmg' })
    expect(cmdLines().at(-1)).toMatchObject({ outcome: 'done', why: 'moved', ms: 40 })
  })
  it('update.json keeps its shape: a bad cmd is a bad file, a good one reads', async () => {
    const { checkUpdateFile } = await import('../../src/main/config.ts')
    const cmd = { id: '0123456789ab', at: 1, answer: 'Show Both', state: 'revealed', doneAt: 2 }
    expect(checkUpdateFile({ v: 1, intent: null, move: { cmd }, staging: null })).toBe(true)
    expect(checkUpdateFile({ v: 1, intent: null, move: { moved: true, at: 1, from: 'dmg', cmd }, staging: null })).toBe(true)
    expect(checkUpdateFile({ v: 1, intent: null, move: { declined: true, at: 1, cmd }, staging: null })).toBe(true)
    expect(checkUpdateFile({ v: 1, intent: null, move: { cmd: { ...cmd, id: 'nope' } }, staging: null })).toBe(false)
    expect(checkUpdateFile({ v: 1, intent: null, move: { cmd: { ...cmd, state: 'gone' } }, staging: null })).toBe(false)
    expect(checkUpdateFile({ v: 1, intent: null, move: {}, staging: null })).toBe(false)
  })
})

describe('privacy (#4)', () => {
  const SENTINEL = 'SENTINEL-do-not-record-a1b2c3'
  it('a value set in Settings and a link typed never reach a line, in any kind', async () => {
    let lastValue: unknown
    bridge.handle(CH.settingsSet, async (_c, p) => { lastValue = (p as { value: unknown }).value; return { ok: false, why: 'write-failed' } })
    bridge.handle(CH.linkOpen, async () => ({ ok: false, why: 'bad' }))
    await m.ipcHandle.get(CH.settingsSet)!(page('settings'), { file: 'config', key: 'someKey', value: SENTINEL.slice(0, 32) })
    expect(lastValue).toBe(SENTINEL.slice(0, 32))
    await m.ipcHandle.get(CH.linkOpen)!(page('home'), { url: `https://x.example/#/b/${SENTINEL}` })
    await tick()
    const text = readFileSync(file(), 'utf8') + JSON.stringify(lines())
    expect(cmdLines().length).toBeGreaterThan(0)
    expect(text).not.toContain(SENTINEL)
    expect(text).not.toContain('x.example')
    expect(cmdLines().find((l) => l.cmd === 'setting')).toMatchObject({ arg: 'someKey' })
  })
})

/**
 * R14 #54, R16's second compatibility case: a 0.29 canvas in app 1.0.1. A 0.29 shell says what `helloNow()` said in 0.29.0
 * (91a12283), asks for no window, knows nothing of a relay's `in`. window.ts is faked here, so the launch's one line of
 * it (`launchFirstCanvas` from `identity`, at the first uncovered `cover`) is repeated; the real one, with a real window:
 * app/test/prod/recorder.test.ts, VM only.
 */
describe('a 0.29.0 canvas in app 1.0.1 (#54)', () => {
  const PAGE = '90879e227f04'
  const HELLO_029 = { version: '0.29.0', board: 'main', page: PAGE, inset: 0 }

  it('its hello passes the bridge\'s own check whole, and the tab knows its page', async () => {
    expect(checkHello(HELLO_029)).toEqual(HELLO_029)
    const t = await canvas({ ...checkHello(HELLO_029)! })
    expect(identity(tabs.getTab(t.id)!)).toMatchObject({ tab: t.id, page: PAGE })
  })

  it('the launch line names the page its hello gave: what joins its boot `load` in page.jsonl', async () => {
    resetLaunch()
    const at = Date.now()
    try {
      launchReady(at, at - 500)
      launchWriter((b) => recorder.event('launch', null, b))
      const t = await canvas(HELLO_029)
      const now = identity(tabs.getTab(t.id)!)
      launchFirstCanvas({ tab: t.id, ws: now.ws, page: now.page, commit: now.commit, cause: 'doc' }, at + 900)
      const launches = lines().filter((l) => l.kind === 'launch')
      expect(launches).toHaveLength(1)
      expect(launches[0]).toMatchObject({ readyMs: 500, firstCanvas: { tab: t.id, page: PAGE, uncoveredMs: 1400, cause: 'doc' } })
    } finally { resetLaunch() }
  })

  it('the app\'s commands are recorded, and name its page: ⌘2\'s `shown` ends one, ⌘R ends on its next hello', async () => {
    const a = await canvas(HELLO_029)
    const b = await canvas({ ...HELLO_029, page: '90879e227f05' })
    tabs.activate(a.id)
    await tick()
    flushNow(); writeFileSync(file(), '')
    const d = tabs.keyOf(b)!
    const name = d === 9 ? 'tab-last' : `tab-${d}`
    runCommand(name as never, 'key', { keys: `Meta+${d}`, in: 'shell' })
    await tick()
    answerShown(b.id)
    const [start, end] = cmdLines()
    expect(start).toMatchObject({ phase: 'start', cmd: name, via: 'key', tab: b.id, page: '90879e227f05' })
    expect(end).toMatchObject({ phase: 'end', id: start!.id, outcome: 'done' })
    expect(lines().find((l) => l.kind === 'shown')).toMatchObject({ tab: b.id, page: '90879e227f05', by: start!.id })
    flushNow(); writeFileSync(file(), '')
    runCommand('reload', 'key', { keys: 'Meta+r', in: 'shell' })
    await tick()
    await commit(b.id, undefined, { ...HELLO_029, page: '90879e227f06' })
    expect(cmdLines().filter((l) => l.phase === 'end')).toEqual([expect.objectContaining({ cmd: 'reload', outcome: 'done', tab: b.id, page: '90879e227f06' })])
  })

  it('a relay to it is not recorded: no owner here, and a 0.29 shell does not record it either (#51)', async () => {
    const t = await canvas(HELLO_029)
    flushNow(); writeFileSync(file(), '')
    const v = openTabMenu(t.id)!
    menuShownAck(v.rev)
    await tick()
    flushNow(); writeFileSync(file(), '')
    menuPickSend(v.rev, 'mark-all-seen')
    await tick()
    expect(cmdLines()).toEqual([])
    expect(menuClicks.at(-1)).toEqual([t.id, 'mark-all-seen', 'tab-menu'])
  })
})
