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

type Listener = (...a: unknown[]) => void

const m = vi.hoisted(() => ({
  ipcOn: new Map<string, (e: unknown, msg: unknown) => void>(),
  ipcHandle: new Map<string, (e: unknown, msg: unknown) => unknown>(),
  dialogResponse: 0,
  views: [] as unknown[],
  appOn: new Map<string, ((...a: unknown[]) => void)[]>(),
  popup: null as unknown,
  menu: null as unknown,
  winHandlers: new Map<string, ((...a: unknown[]) => void)[]>(),
  fullScreen: false,
  visible: true,
  minimized: 0,
  hidden: 0,
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
    Menu: { setApplicationMenu: (x: { template: unknown }) => { m.menu = x.template }, buildFromTemplate: (t: unknown) => ({ template: t, popup: () => { m.popup = t } }), sendActionToFirstResponder: () => {} },
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
  compose: () => {},
  contentView: (id: string) => content.get(id),
  coverContents: () => null,
  hideWindow: () => { m.hidden += 1; emitWin('hide') },
  mainWindow: () => win,
  onAppReady: () => {},
  openWindow: () => win,
  pageOf: () => undefined,
  pageView: () => undefined,
  sendHeld: () => {},
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
const { checkPagePayload } = await import('../../src/main/bridge.ts')

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
const navFns = new Map<string, (e: unknown) => void>()
let docN = 0
const docs = new Map<string, string>()
const entries: ReturnType<typeof makeEntry>[] = []
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
  onRegistry: () => () => {},
  onReport: (fn: typeof reportFn) => { reportFn = fn; return () => {} },
  appState: () => true,
  menuClick: (...a: unknown[]) => { menuClicks.push(a); return true },
  reopenNext: () => {},
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
async function canvas(): Promise<ReturnType<typeof tabs.getTab> & object> {
  const e = makeEntry(++n)
  entries.push(e)
  tabs.onRegistry({ kind: 'entry', entry: e as never })
  const t = tabs.allTabs().find((x) => x.reg?.instance === e.instance)!
  tabs.activate(t.id)
  await tick()
  await commit(t.id, e.origin)
  return t
}
async function commit(id: string, origin?: string): Promise<void> {
  const t = tabs.getTab(id)!
  navFns.get(id)!({ kind: 'commit', gen: 1, url: `${origin ?? t.reg!.origin}/`, attributed: true, instance: t.reg!.instance })
  reportFn!(id, docs.get(id)!, { hello: { version: '0.30.0', board: null, page: `PAGE_${docs.get(id)}` }, safety: 'fresh', busy: { busy: false, unsaved: false, why: [] } })
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
  /** The tab's own right-click, as main builds it: the items' clicks are the input. */
  const menuOf = (id: string): Item[] => { pageHandlers.tabMenu(id, 1, 1); return m.popup as Item[] }
  it('the right-click: via context, in tab-menu; its work\'s end', async () => {
    const t = await canvas()
    flushNow(); writeFileSync(file(), '')
    menuOf(t.id).find((i) => i.label === 'Copy Local Link')!.click!()
    await tick()
    expect(cmdLines()).toEqual([
      expect.objectContaining({ phase: 'start', cmd: 'copy-link', via: 'context', in: 'tab-menu', tab: t.id }),
      expect.objectContaining({ phase: 'end', cmd: 'copy-link', outcome: 'done' }),
    ])
  })
  it('Mark All as Seen is a relay: nothing written here, `in: tab-menu` passed on', async () => {
    const t = await canvas()
    flushNow(); writeFileSync(file(), '')
    menuOf(t.id).find((i) => i.label === 'Mark All as Seen')!.click!()
    await tick()
    expect(cmdLines()).toEqual([])
    expect(menuClicks).toEqual([[t.id, 'mark-all-seen', 'tab-menu']])
  })
  it('a stale token: noop untrusted', async () => {
    const t = await canvas()
    const items = menuOf(t.id)
    await commit(t.id)     // another document: the token no longer holds
    flushNow(); writeFileSync(file(), '')
    items.find((i) => i.label === 'Copy Local Link')!.click!()
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
  it('Esc in Home\'s link field: link-cancel; with no tab to go back to, noop no-tab and nothing else', async () => {
    const a = await canvas()
    tabs.activate('home')
    await tick()
    flushNow(); writeFileSync(file(), '')
    const on = m.ipcOn.get(CH.tabActivate)!
    on(page('home'), { id: 'home', via: 'key' })
    await tick()
    expect(cmdLines()).toEqual([expect.objectContaining({ phase: 'once', cmd: 'link-cancel', via: 'key', keys: 'Escape', in: 'home', outcome: 'noop', why: 'no-tab' })])
    expect(tabs.activeTab()?.id).toBe('home')
    flushNow(); writeFileSync(file(), '')
    on(page('home'), { id: a.id, via: 'key' })
    await tick()
    answerShown(a.id)
    expect(tabs.activeTab()?.id).toBe(a.id)
    expect(cmdLines().find((l) => l.phase === 'start')).toMatchObject({ cmd: 'link-cancel', tab: a.id })
    expect(cmdLines().find((l) => l.phase === 'end')).toMatchObject({ outcome: 'done' })
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
