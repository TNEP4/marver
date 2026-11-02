/**
 * updater.ts, the updater's Electron side (spec 28 A5.1 #4, #13, #14, #21, #22, #24), in node with Electron mocked and
 * testing/updater.ts's fake adapter and clock. update-model.test.ts holds the attempt model's own cases (#32's list: the
 * gates, setup, one attempt at a time, errors by phase, late events, the boundaries, `ready` for good, a manual check's
 * answers); these hold what updater.ts adds around it: where the gates come from, the ports to the pill, the menu, the
 * coordinator and the browser, a blocked item's alerts, and a waiting update's release by its tab.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

const env = vi.hoisted(() => ({ exe: '', online: true }))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.99.1', getName: () => 'Marver Dev', getPath: () => env.exe, commandLine: { hasSwitch: () => false }, isReady: () => true, on: () => {}, isInApplicationsFolder: () => false },
  autoUpdater: {}, BaseWindow: { getAllWindows: () => [] }, dialog: {}, net: { isOnline: () => env.online }, powerMonitor: { on: () => {} },
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false, on: () => {} },
  shell: { openPath: async () => '', openExternal: async () => {}, showItemInFolder: () => {} }, clipboard: { writeText: () => {} },
}))

type Upd = typeof import('../../src/main/updater.ts')
let upd: Upd
let base: string

beforeEach(async () => {
  vi.resetModules()
  upd = await import('../../src/main/updater.ts')
  const cfg = await import('../../src/main/config.ts')
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-updater-')))
  process.env.MARVER_HOME = join(base, 'home')
  cfg.ensureHome({ version: '0.99.1', dev: true })
  env.online = true
  env.exe = join(homedir(), 'Downloads', 'Marver.app', 'Contents', 'MacOS', 'Marver')
})
afterEach(() => {
  upd.resetUpdater()
  rmSync(base, { recursive: true, force: true })
  delete process.env.MARVER_HOME
})

const FEED = 'https://example.invalid/releases.json'

async function rig(o: { feed?: string; gates?: { inApplications: boolean; writable: boolean }; answer?: string } = {}) {
  const { FakeClock, FakeUpdater } = await import('../../src/main/testing/updater.ts')
  const { world, liveTab, report, show } = await import('./window-fakes.ts')
  const pill = await import('../../src/main/pill.ts')
  const menu = await import('../../src/main/menu.ts')
  const shutdown = await import('../../src/main/shutdown.ts')
  const { T } = await import('../../src/main/timings.ts')
  const w = world()
  const u = new FakeUpdater()
  const clock = new FakeClock()
  const r = { records: [] as unknown[], opened: [] as string[], revealed: [] as string[], asked: [] as import('../../src/main/updater.ts').ExplainAlert[] }
  const m = upd.startUpdater({
    record: (b) => { r.records.push(b) }, openExternal: (url) => { r.opened.push(url) }, reveal: (p) => { r.revealed.push(p) },
    ask: async (a) => { r.asked.push(a); return o.answer ?? a.buttons[0]! },
    adapter: u, clock, gates: o.gates ?? { inApplications: true, writable: true }, feed: o.feed ?? FEED, version: '0.99.1',
  })
  clock.tick()
  const ready = () => { clock.advance(T.updateFirstMs); u.emit('update-available'); u.downloaded('0.99.2', 'Boards open faster') }
  return { w, u, clock, m, r, pill, menu, shutdown, T, ready, liveTab, report, show }
}

const flush = () => new Promise((r) => setImmediate(r))

describe('the gates, as updater.ts reads them (#13, #24)', () => {
  it('the bundle is the last X.app before Contents/MacOS', () => {
    expect(upd.bundleOf('/Applications/Marver.app/Contents/MacOS/Marver')).toBe('/Applications/Marver.app')
    expect(upd.bundleOf('/Volumes/Marver 1.0.1/Marver.app/Contents/MacOS/Marver')).toBe('/Volumes/Marver 1.0.1/Marver.app')
    expect(upd.bundleOf('/usr/local/bin/node')).toBeNull()
  })

  it('W_OK on the bundle and its folder; a read-only volume is a location problem, never a write one', () => {
    const fail = (code: string, at: string) => (p: string) => { if (p === at) throw Object.assign(new Error(code), { code }) }
    const b = '/Applications/Marver.app'
    expect(upd.gatesOf(true, b, () => {})).toEqual({ inApplications: true, writable: true })
    expect(upd.gatesOf(true, b, fail('EACCES', b))).toEqual({ inApplications: true, writable: false })
    expect(upd.gatesOf(true, b, fail('EACCES', '/Applications'))).toEqual({ inApplications: true, writable: false })
    expect(upd.gatesOf(true, b, fail('EROFS', b))).toEqual({ inApplications: false, writable: false })
    expect(upd.gatesOf(true, null, () => {})).toEqual({ inApplications: true, writable: false })
  })

  it('no feed: blocked, one record, no adapter call, and no menu item', async () => {
    const x = await rig({ feed: '' })
    expect(x.m.state().phase).toEqual({ kind: 'blocked', why: 'feed' })
    expect(x.r.records).toEqual([{ phase: 'blocked', why: 'feed' }])
    expect(x.u.calls).toEqual([])
    expect(upd.updateMenu()).toBeNull()
    expect(x.pill.currentPill()).toBeNull()
  })
})

describe('the ports', () => {
  it('every change chooses the pill and rebuilds the menu; Restart to Update reaches the coordinator, then quitAndInstall', async () => {
    const x = await rig()
    let applied = 0
    x.menu.startMenu({ model: () => ({ active: { id: 'home', kind: 'home', name: 'Home', token: { tab: 'home', commit: 0, trusted: false }, trusted: false, canClose: false, canReload: false }, canvas: null, tabs: [], header: true, update: upd.updateMenu() }), acts: { run() {}, holds: () => true, canvasClick() {}, tab() {}, help() {}, perfFiles() {}, update: (t) => { upd.updateAct(t) }, exportReport() {}, rebuild() {} }, apply: () => { applied += 1 } })
    expect(upd.updateMenu()).toEqual({ label: 'Check for Updates…', enabled: true, token: { act: 'check' } })
    x.ready()
    expect(upd.updateMenu()).toMatchObject({ label: 'Restart to Install Update', enabled: true })
    x.menu.buildNow()
    expect(applied).toBe(2)
    expect(x.pill.currentPill()).toMatchObject({ kind: 'update', lead: '0.99.2 is ready' })
    // the coordinator, on fake ports: its update side is the one updater.ts set
    const calls: string[] = []
    x.shutdown.startShutdown({
      now: () => 1, writeTabsNow: () => true, guardAll: async () => 'done', stuck: () => [], ask: async () => false, forceUnload: () => false, forward: () => {},
      notes: () => {}, flushAll: () => calls.push('flushAll'), quit: () => calls.push('quit'), onBeforeQuit: () => {}, onWindowAllClosed: () => {},
      alert: async () => {}, setTimeout: () => null, clearTimeout: () => {},
    })
    expect(x.pill.onPillAction(x.pill.currentPill()!.rev, 'button')).toBe(true)
    await flush()
    expect(x.u.count('quitAndInstall')).toBe(1)
    expect(x.m.state().phase).toEqual({ kind: 'restarting', version: '0.99.2' })
    expect(upd.updateMenu()).toEqual({ label: 'Restarting…', enabled: false, token: null })
    expect(JSON.parse(readFileSync(join(process.env.MARVER_HOME!, 'state-dev', 'update.json'), 'utf8')).intent).toMatchObject({ from: '0.99.1', to: '0.99.2', via: 'restart' })
  })

  it('a manual check answers in the pill, its short forms below 960 px; offline when net.isOnline() says so', async () => {
    const x = await rig()
    x.show('home')
    expect(upd.updateAct({ act: 'check' })).toBe(true)
    x.u.emit('update-not-available')
    expect(x.pill.currentPill()).toMatchObject({ kind: 'confirmation', text: 'Marver 0.99.1 is up to date', short: 'Up to date' })
    x.clock.advance(x.T.updateEveryMs)            // the automatic one, silent
    x.u.fail('offline')
    env.online = false
    x.w.clock.now += 1000                          // a later confirmation is another pill
    expect(upd.updateAct({ act: 'check' })).toBe(true)
    x.u.fail('The Internet connection appears to be offline.')
    expect(x.pill.currentPill()).toMatchObject({ kind: 'confirmation', text: "Couldn't check for updates · You're offline", short: "You're offline" })
    env.online = true
    x.w.clock.now += 1000
    expect(upd.updateAct({ act: 'check' })).toBe(true)
    x.u.fail('a 404 page')
    expect(x.pill.currentPill()).toMatchObject({ kind: 'confirmation', text: "Couldn't check for updates · Try again later", short: "Couldn't check" })
  })

  it('Download opens the DMG\'s link (#18, #29)', async () => {
    const x = await rig()
    x.m.failed({ from: '0.99.1', to: '0.99.2', at: 1 })
    x.show('home')
    expect(x.pill.onPillAction(x.pill.currentPill()!.rev, 'button')).toBe(true)
    expect(x.r.opened).toEqual(['https://github.com/TNEP4/marver-app/releases/latest/download/Marver-arm64.dmg'])
    expect(upd.DOWNLOAD_URL).toBe(x.r.opened[0])
  })

  it('a waiting update looks at its tab after a report and after a change: ready when its fresh unsaved turns false', async () => {
    const x = await rig()
    x.ready()
    const t = x.liveTab(x.w, { busy: { unsaved: true } })
    x.m.hold(t.id, t.doc!.commits)
    expect(x.pill.currentPill()).toMatchObject({ lead: `0.99.2 waits for ${t.name}` })
    upd.updaterTabs()
    upd.updaterTabs(t.id)
    expect(x.m.state().phase.kind).toBe('waiting')
    x.report(t, false)
    upd.updaterTabs(t.id)
    expect(x.m.state().phase.kind).toBe('ready')
  })
})

describe('a blocked item\'s alert (#22)', () => {
  it('Updates Need the Applications Folder…: why, where it runs, Show in Finder selects this copy', async () => {
    const x = await rig({ gates: { inApplications: false, writable: true }, answer: 'Show in Finder' })
    expect(upd.updateMenu()).toEqual({ label: 'Updates Need the Applications Folder…', enabled: true, token: { act: 'explain', why: 'location' } })
    expect(upd.updateAct({ act: 'explain', why: 'location' })).toBe(true)
    await flush()
    expect(x.r.asked).toEqual([{
      message: 'Marver updates itself only from the Applications folder',
      detail: 'This Marver runs from ~/Downloads. Quit it, move it to Applications, and open it from there: it then checks for updates on its own.',
      buttons: ['OK', 'Show in Finder'],
    }])
    expect(x.r.revealed).toEqual([join(homedir(), 'Downloads', 'Marver.app')])
    // a stale token (another block) does nothing
    expect(upd.updateAct({ act: 'explain', why: 'write' })).toBe(false)
  })

  it('with a declined move it says so, and Move at Next Launch clears it - the one way back (#23)', async () => {
    const cfg = await import('../../src/main/config.ts')
    cfg.writeUpdateFile({ v: 1, intent: null, move: { declined: true, at: 1 }, staging: null })
    const x = await rig({ gates: { inApplications: false, writable: true }, answer: 'Move at Next Launch' })
    upd.updateAct({ act: 'explain', why: 'location' })
    await flush()
    expect(x.r.asked[0]!.buttons).toEqual(['OK', 'Show in Finder', 'Move at Next Launch'])
    expect(x.r.asked[0]!.detail).toContain('Move at Next Launch lets it')
    expect(cfg.readUpdateFile().move).toBeNull()
  })

  it('Updates Unavailable… (write, setup): why, and Download opens the link', async () => {
    const x = await rig({ gates: { inApplications: true, writable: false }, answer: 'Download' })
    expect(upd.updateMenu()).toMatchObject({ label: 'Updates Unavailable…', enabled: true })
    upd.updateAct({ act: 'explain', why: 'write' })
    await flush()
    expect(x.r.asked[0]).toEqual({
      message: "Marver can't update itself here",
      detail: "Updating replaces Marver where it is, and this account can't change ~/Downloads. Download the latest Marver and install it again to update.",
      buttons: ['OK', 'Download'],
    })
    expect(x.r.opened).toEqual([upd.DOWNLOAD_URL])
    expect(upd.explainAlert('setup', { folder: '/Applications', declined: false })).toEqual({
      message: "Marver can't check for updates", detail: "Its updater couldn't start on this Mac. Download the latest Marver to update by hand.", buttons: ['OK', 'Download'],
    })
  })
})

describe('the menu template carries the item after About Marver', () => {
  it('its click calls acts.update with its token', async () => {
    const x = await rig()
    const calls: unknown[] = []
    const model = { active: { id: 'home', kind: 'home' as const, name: 'Home', token: { tab: 'home', commit: 0, trusted: false }, trusted: false, canClose: false, canReload: false }, canvas: null, tabs: [], header: true, update: upd.updateMenu() }
    const t = x.menu.menuTemplate(model, { run() {}, holds: () => true, canvasClick() {}, tab() {}, help() {}, perfFiles() {}, update: (k) => { calls.push(k) }, exportReport() {}, rebuild() {} })
    const marver = t[0]!.submenu as MenuItemConstructorOptions[]
    expect(marver[0]).toMatchObject({ role: 'about' })
    expect(marver[1]).toMatchObject({ id: 'update', label: 'Check for Updates…', enabled: true })
    ;(marver[1]!.click as unknown as () => void)()
    expect(calls).toEqual([{ act: 'check' }])
  })
})
