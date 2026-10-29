/**
 * A shared canvas's session, view and navigation (spec 28 A4.6 #40, #41, #50, r1 #8), in node with Electron mocked:
 * its preferences (no preload), the bridge recording its view so `kindOf` answers `remote` (and its clipboard and
 * full screen pass) and wiring nothing else, `persist:remote`'s permissions, downloads and test certificate, the main
 * frame's https-only, no-loopback rule, `window.open` to its origin's tab or the browser, the front door, and no client
 * certificate offered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Fn = (...a: any[]) => any
const fx = vi.hoisted(() => ({
  appOn: new Map<string, Fn>(),
  sessions: new Map<string, any>(),
  switches: [] as [string, string][],
  external: [] as string[],
}))

vi.mock('electron', () => {
  const fakeSession = (name: string) => {
    const s = {
      name, handlers: {} as Record<string, Fn>, listeners: new Map<string, Fn>(), verify: null as Fn | null,
      setPermissionRequestHandler(f: Fn) { s.handlers.request = f },
      setPermissionCheckHandler(f: Fn) { s.handlers.check = f },
      setDevicePermissionHandler(f: Fn) { s.handlers.device = f },
      setCertificateVerifyProc(f: Fn) { s.verify = f },
      on(ev: string, f: Fn) { s.listeners.set(ev, f) },
    }
    return s
  }
  return {
    app: {
      on: (ev: string, f: Fn) => { fx.appOn.set(ev, f) },
      commandLine: { appendSwitch: (k: string, v: string) => { fx.switches.push([k, v]) } },
    },
    session: { fromPartition: (p: string) => { if (!fx.sessions.has(p)) fx.sessions.set(p, fakeSession(p)); return fx.sessions.get(p) } },
    shell: { openExternal: async (u: string) => { fx.external.push(u) } },
    ipcMain: { on: () => {}, handle: () => {} },
    webFrameMain: { fromId: () => undefined },
  }
})

const REMOTE_PREFS = {
  partition: 'persist:remote', sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false, webviewTag: false, disableDialogs: true, disableHtmlFullscreenWindowResize: true,
  focusOnNavigation: false, navigateOnDragDrop: false, spellcheck: false, safeDialogs: true, webSecurity: true, allowRunningInsecureContent: false,
}

let nextId = 500
class FakeWc {
  id = nextId++
  url = 'https://pilot.example.com/#/b/main'
  destroyed = false
  listeners = new Map<string, Fn[]>()
  openHandler: Fn | null = null
  constructor(private prefs: Record<string, unknown> = REMOTE_PREFS) {}
  getLastWebPreferences() { return this.prefs }
  isDestroyed() { return this.destroyed }
  getURL() { return this.url }
  on(ev: string, f: Fn) { this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), f]); return this }
  once(ev: string, f: Fn) { return this.on(ev, f) }
  emit(ev: string, ...a: unknown[]) { for (const f of this.listeners.get(ev) ?? []) f(...a) }
  setWindowOpenHandler(f: Fn) { this.openHandler = f }
}

/** the fake session as the cases read it */
interface FakeSes { handlers: Record<string, Fn>; listeners: Map<string, Fn>; verify: Fn | null }
const ses = (): FakeSes => s.remoteSession() as unknown as FakeSes

type S = typeof import('../../src/main/sessions.ts')
type B = typeof import('../../src/main/bridge.ts')
let s: S
let b: B

beforeEach(async () => {
  vi.resetModules()
  fx.appOn.clear(); fx.sessions.clear(); fx.switches.length = 0; fx.external.length = 0
  delete process.env.MARVER_APP_TEST
  s = await import('../../src/main/sessions.ts')
  b = await import('../../src/main/bridge.ts')
  b.installBridge()
})

/** A remote view as views.ts makes it: registered with the bridge, the navigation policy on it. */
function remoteView(): FakeWc {
  const wc = new FakeWc()
  b.bridgeNow()!.register(wc as never, 'remote', 't9')
  s.installNavigationPolicy()
  fx.appOn.get('web-contents-created')!({}, wc)
  return wc
}
const navigate = (wc: FakeWc, url: string, isMainFrame = true) => {
  let prevented = false
  wc.emit('will-frame-navigate', { url, isMainFrame, preventDefault: () => { prevented = true } })
  return !prevented
}

describe('the view and its record (A4.6 #40, r1 #8)', () => {
  it('no preload, persist:remote, sandboxed and isolated, no dialogs, no Node, no webview - the preferences every view keeps', () => {
    const p = s.remoteWebPreferences()
    expect(p).toEqual(REMOTE_PREFS)
    expect('preload' in p).toBe(false)
  })

  it('the bridge records it as remote with its tab, wires nothing else, and forgets it at destroyed', () => {
    const wc = new FakeWc()
    b.bridgeNow()!.register(wc as never, 'remote', 't9')
    expect(b.kindOf(wc.id)).toBe('remote')
    expect(b.tabOf(wc.id)).toBe('t9')
    // no app-page readiness, no canvas document, no admission: destroyed is its one listener
    expect([...wc.listeners.keys()]).toEqual(['destroyed'])
    wc.emit('destroyed')
    expect(b.kindOf(wc.id)).toBeUndefined()
  })

  it('its clipboard and full screen pass from https - and only for a view the bridge recorded (unrecorded, refused even the clipboard)', () => {
    const wc = new FakeWc()
    expect(s.allowRemote(wc as never, 'clipboard-sanitized-write', 'https://pilot.example.com/')).toBe(false)
    b.bridgeNow()!.register(wc as never, 'remote', 't9')
    expect(s.allowRemote(wc as never, 'clipboard-sanitized-write', 'https://pilot.example.com/')).toBe(true)
    expect(s.allowRemote(wc as never, 'fullscreen', 'https://pilot.example.com/x')).toBe(true)
    expect(s.allowRemote(wc as never, 'clipboard-sanitized-write', 'http://pilot.example.com/')).toBe(false)
    for (const p of ['media', 'notifications', 'geolocation', 'openExternal', 'storage-access', 'top-level-storage-access', 'local-network-access', 'display-capture', 'clipboard-read', 'pointerLock']) {
      expect(s.allowRemote(wc as never, p, 'https://pilot.example.com/'), p).toBe(false)
    }
    const canvas = new FakeWc({ ...REMOTE_PREFS, partition: 'persist:local:0123456789abcdef' })
    b.bridgeNow()!.register(canvas as never, 'canvas', 't1')
    expect(s.allowRemote(canvas as never, 'clipboard-sanitized-write', 'https://pilot.example.com/')).toBe(false)
  })
})

describe('persist:remote (A4.6 #40, #50)', () => {
  it('its handlers answer for a recorded remote view alone; the device handler false; every download cancelled', () => {
    const r = ses()
    expect(ses()).toBe(r)
    const wc = new FakeWc()
    b.bridgeNow()!.register(wc as never, 'remote', 't9')
    const answers: boolean[] = []
    r.handlers.request!(wc, 'clipboard-sanitized-write', (ok: boolean) => answers.push(ok), { requestingUrl: 'https://pilot.example.com/', isMainFrame: true })
    r.handlers.request!(wc, 'media', (ok: boolean) => answers.push(ok), { requestingUrl: 'https://pilot.example.com/', isMainFrame: true, mediaTypes: ['audio'] })
    r.handlers.request!(new FakeWc(), 'fullscreen', (ok: boolean) => answers.push(ok), { requestingUrl: 'https://pilot.example.com/', isMainFrame: true })
    expect(answers).toEqual([true, false, false])
    expect(r.handlers.check!(wc, 'fullscreen', 'https://pilot.example.com', { isMainFrame: true })).toBe(true)
    expect(r.handlers.check!(wc, 'notifications', 'https://pilot.example.com', { isMainFrame: true })).toBe(false)
    expect(r.handlers.device!()).toBe(false)
    let cancelled = false
    r.listeners.get('will-download')!({ preventDefault: () => { cancelled = true } }, { getURL: () => 'https://pilot.example.com/a.zip' }, wc)
    expect(cancelled).toBe(true)
  })

  it('no test certificate outside a test run; in one, exactly that fingerprint passes and any other gets Chromium\'s own verdict', async () => {
    process.env.MARVER_APP_TEST_REMOTE_CERT = 'sha256/abc='
    expect(ses().verify).toBeNull()
    vi.resetModules()
    fx.sessions.clear()
    process.env.MARVER_APP_TEST = '1'
    s = await import('../../src/main/sessions.ts')
    const got: number[] = []
    ses().verify!({ certificate: { fingerprint: 'sha256/abc=' } }, (n: number) => got.push(n))
    ses().verify!({ certificate: { fingerprint: 'sha256/other=' } }, (n: number) => got.push(n))
    expect(got).toEqual([0, -3])
    delete process.env.MARVER_APP_TEST_REMOTE_CERT
  })

  it('the test host rules only in a test run, and only mapping .test hosts to 127.0.0.1', async () => {
    process.env.MARVER_APP_TEST_HOSTS = 'MAP *.canvas.test 127.0.0.1'
    s.remoteTestSwitches()
    expect(fx.switches).toEqual([])
    process.env.MARVER_APP_TEST = '1'
    vi.resetModules()
    s = await import('../../src/main/sessions.ts')
    s.remoteTestSwitches()
    expect(fx.switches).toEqual([['host-resolver-rules', 'MAP *.canvas.test 127.0.0.1']])
    for (const bad of ['MAP * 127.0.0.1', 'MAP *.canvas.test 10.0.0.1', 'MAP id.marver.design 127.0.0.1', 'EXCLUDE *.test']) {
      fx.switches.length = 0
      process.env.MARVER_APP_TEST_HOSTS = bad
      s.remoteTestSwitches()
      expect(fx.switches, bad).toEqual([])
    }
    delete process.env.MARVER_APP_TEST_HOSTS
  })
})

describe('its navigation and windows (A4.6 #41)', () => {
  it('the main frame goes to any https origin with no credentials and no loopback host; subframes freely; devtools exempt', () => {
    const wc = remoteView()
    for (const u of ['https://pilot.example.com/#/b/x', 'https://id.marver.design/login', 'https://accounts.google.com/o/oauth2/auth']) expect(navigate(wc, u), u).toBe(true)
    for (const u of [
      'http://pilot.example.com/', 'about:blank', 'blob:https://pilot.example.com/x', 'javascript:alert(1)', 'marver-app://home/', 'file:///etc/passwd',
      'https://localhost/', 'https://127.0.0.1:4806/', 'https://[::1]/', 'https://0.0.0.0/', 'https://a.localhost/', 'https://u:p@pilot.example.com/',
    ]) expect(navigate(wc, u), u).toBe(false)
    expect(navigate(wc, 'http://anything.example.com/', false)).toBe(true)
    expect(s.allowNav(wc as never, 'devtools://devtools/x', true)).toBe(true)
  })

  it('a refused navigation to http or mailto goes to the browser through openOutside; anything else nowhere', async () => {
    const wc = remoteView()
    navigate(wc, 'http://pilot.example.com/plain')
    await Promise.resolve()
    expect(fx.external).toEqual(['http://pilot.example.com/plain'])
    await new Promise((r) => setTimeout(r, 1010))   // openOutside's one a second
    navigate(wc, 'mailto:nic@example.com')
    await new Promise((r) => setTimeout(r, 1010))
    navigate(wc, 'javascript:alert(1)')
    navigate(wc, 'https://localhost/')
    await Promise.resolve()
    expect(fx.external).toEqual(['http://pilot.example.com/plain', 'mailto:nic@example.com'])
  })

  it('window.open always denies: an https URL on an open shared tab\'s origin, or one the front door opened, to its tab; any other to the browser', async () => {
    const wc = remoteView()
    const taken: [string, boolean][] = []
    let open = new Set(['https://pilot.example.com'])
    s.onRemoteOpen((url, fromFrontDoor) => { taken.push([url, fromFrontDoor]); return fromFrontDoor || open.has(new URL(url).origin) })
    expect(wc.openHandler!({ url: 'https://pilot.example.com/#/b/other' })).toEqual({ action: 'deny' })
    expect(taken).toEqual([['https://pilot.example.com/#/b/other', false]])
    expect(fx.external).toEqual([])
    expect(wc.openHandler!({ url: 'https://docs.example.com/page' })).toEqual({ action: 'deny' })
    await Promise.resolve()
    expect(fx.external).toEqual(['https://docs.example.com/page'])
    // the front door's window.open of a canvas: its origin's tab, new or existing
    wc.url = 'https://app.marver.design/canvases'
    open = new Set()
    await new Promise((r) => setTimeout(r, 1010))
    expect(wc.openHandler!({ url: 'https://tidewell.example.com/' })).toEqual({ action: 'deny' })
    expect(taken.at(-1)).toEqual(['https://tidewell.example.com/', true])
    // never a loopback page, never with credentials: the browser's checks, or nothing
    taken.length = 0
    wc.openHandler!({ url: 'https://localhost:4806/' })
    wc.openHandler!({ url: 'https://u:p@pilot.example.com/' })
    expect(taken).toEqual([])
  })

  it('the front door is app.marver.design; a test run may name another https origin, nothing else', async () => {
    expect(s.frontDoor()).toBe('https://app.marver.design')
    process.env.MARVER_APP_TEST_FRONT_DOOR = 'https://door.canvas.test:4433'
    expect(s.frontDoor()).toBe('https://app.marver.design')
    process.env.MARVER_APP_TEST = '1'
    vi.resetModules()
    s = await import('../../src/main/sessions.ts')
    expect(s.frontDoor()).toBe('https://door.canvas.test:4433')
    process.env.MARVER_APP_TEST_FRONT_DOOR = 'http://door.canvas.test'
    expect(s.frontDoor()).toBe('https://app.marver.design')
    delete process.env.MARVER_APP_TEST_FRONT_DOOR
  })

  it('no client certificate is ever offered: the request is answered with none', () => {
    s.installNavigationPolicy()
    let prevented = false
    const given: unknown[][] = []
    fx.appOn.get('select-client-certificate')!({ preventDefault: () => { prevented = true } }, {}, 'https://pilot.example.com', [{ subjectName: 'me' }], (...a: unknown[]) => given.push(a))
    expect(prevented).toBe(true)
    expect(given).toEqual([[]])
  })
})
