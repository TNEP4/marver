/**
 * The Marver menu's update item (spec 28 A5.1 #22), on menu.ts's template and update-model.ts's model on
 * testing/updater.ts's fakes: each state's label and enablement, right after About Marver; a state change rebuilding
 * the menu (the model is part of the menu's key, `invalidateMenu` on every change); a stale token's click doing nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { buildNow, invalidateMenu, menuTemplate, startMenu, type MenuActs, type MenuModel } from '../../src/main/menu.ts'
import { FakeClock, FakeUpdater } from '../../src/main/testing/updater.ts'
import { T } from '../../src/main/timings.ts'
import { menuItem, startUpdates, type UpdateGates, type UpdateModel } from '../../src/main/update-model.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const FEED = 'https://example.invalid/releases.json'
const OPEN: UpdateGates = { inApplications: true, writable: true }

function rig(o: { feed?: string; gates?: UpdateGates } = {}) {
  const u = new FakeUpdater()
  const clock = new FakeClock()
  const requests: string[] = []
  const explained: string[] = []
  let built: MenuItemConstructorOptions[][] = []
  const box: { m?: UpdateModel } = {}
  const acts: MenuActs = {
    run() {}, holds: () => true, canvasClick() {}, tab() {}, help() {}, perfFiles() {}, exportReport() {}, rebuild() {},
    update: (t) => { box.m!.act(t) },
  }
  const model = (): MenuModel => ({
    active: { id: 'home', kind: 'home', name: 'Home', token: { tab: 'home', commit: 0, trusted: false }, trusted: false, canClose: false, canReload: false },
    canvas: null, tabs: [], header: true, update: box.m ? menuItem(box.m.state()) : null,
  })
  box.m = startUpdates({
    adapter: u, clock, feed: o.feed ?? FEED, version: '0.99.1',
    record: () => {}, answer: () => {}, online: () => true,
    // as updater.ts: every change of phase or failure rebuilds the menu
    changed: () => invalidateMenu(),
    request: (kind, t) => { requests.push(`${kind}:${t.version}`) }, openDownload: () => {}, explain: (why) => { explained.push(why) },
    restartFailed: () => {}, beforeQuitForUpdate: () => {},
  }, o.gates ?? OPEN)
  startMenu({ model, acts, apply: (t) => { built.push(t) } })
  const item = () => (built.at(-1)![0]!.submenu as MenuItemConstructorOptions[])
  /** the menu's update item as last built, or undefined (after About Marver: index 1, else none) */
  const update = () => item().find((m) => m.id === 'update')
  const settle = () => vi.advanceTimersByTime(T.menuDebounceMs + 1)
  return { u, clock, m: box.m, requests, explained, update, item, settle, built: () => built, clear: () => { built = [] }, acts }
}
const click = (m: MenuItemConstructorOptions | undefined) => (m!.click as unknown as () => void)()

describe('each state\'s label and enablement (#22)', () => {
  it('after About Marver: setup, idle, checking, downloading, ready, waiting, restarting', () => {
    const x = rig()
    expect(x.item()[0]).toMatchObject({ role: 'about' })
    expect(x.item()[1]).toMatchObject({ id: 'update', label: 'Check for Updates…', enabled: false })     // setup, while it lasts
    x.clock.tick(); x.settle()
    expect(x.update()).toMatchObject({ label: 'Check for Updates…', enabled: true })
    x.clock.advance(T.updateFirstMs); x.settle()
    expect(x.update()).toMatchObject({ label: 'Checking for Updates…', enabled: false })
    x.u.emit('update-available'); x.settle()
    expect(x.update()).toMatchObject({ label: 'Downloading Update…', enabled: false })
    x.u.downloaded('0.99.2'); x.settle()
    expect(x.update()).toMatchObject({ label: 'Restart to Install Update', enabled: true })
    x.m.hold('t1', 3); x.settle()
    expect(x.update()).toMatchObject({ label: 'Restart to Install Update', enabled: true })
    x.m.restarting('0.99.2'); x.settle()
    expect(x.update()).toMatchObject({ label: 'Restarting…', enabled: false })
  })

  it('idle with a failure: Check for Updates…', () => {
    const x = rig()
    x.clock.tick()
    x.m.failed({ from: '0.99.1', to: '0.99.2', at: 1 }); x.settle()
    expect(x.update()).toMatchObject({ label: 'Check for Updates…', enabled: true })
  })

  it('blocked: no item for the feed; the Applications folder; Updates Unavailable… for write and setup - each explaining', () => {
    expect(rig({ feed: '' }).update()).toBeUndefined()
    const loc = rig({ gates: { inApplications: false, writable: true } })
    expect(loc.update()).toMatchObject({ label: 'Updates Need the Applications Folder…', enabled: true })
    click(loc.update())
    expect(loc.explained).toEqual(['location'])
    const write = rig({ gates: { inApplications: true, writable: false } })
    expect(write.update()).toMatchObject({ label: 'Updates Unavailable…', enabled: true })
    click(write.update())
    expect(write.explained).toEqual(['write'])
    const u = new FakeUpdater()
    u.duringFeed = (f) => f.fail('unreadable code signature')
    const m = startUpdates({
      adapter: u, clock: new FakeClock(), feed: FEED, version: '0.99.1', record: () => {}, changed: () => {}, answer: () => {}, online: () => true,
      request: () => {}, openDownload: () => {}, explain: () => {}, restartFailed: () => {}, beforeQuitForUpdate: () => {},
    }, OPEN)
    expect(menuItem(m.state())).toMatchObject({ label: 'Updates Unavailable…', enabled: true, token: { act: 'explain', why: 'setup' } })
  })
})

describe('a state change rebuilds the menu; a stale click does nothing', () => {
  it('every change is a new build within 100 ms; nothing changed, no build', () => {
    const x = rig()
    x.clock.tick(); x.settle()
    const n = x.built().length
    x.clock.advance(T.updateFirstMs)
    expect(x.built().length).toBe(n)                // debounced
    x.settle()
    expect(x.built().length).toBe(n + 1)
    invalidateMenu(); x.settle()
    expect(x.built().length).toBe(n + 1)            // the same model: the same key
    buildNow()
    expect(x.built().length).toBe(n + 1)
  })

  it('Check for Updates… kept from before a check started does nothing; Restart to Install Update kept from before the restart does nothing', () => {
    const x = rig()
    x.clock.tick(); x.settle()
    const check = x.update()
    expect(x.u.count('checkForUpdates')).toBe(0)
    click(check)
    expect(x.u.count('checkForUpdates')).toBe(1)
    click(check)                                      // checking now: the token no longer holds
    expect(x.u.count('checkForUpdates')).toBe(1)
    x.u.emit('update-available'); x.u.downloaded('0.99.2'); x.settle()
    const restart = x.update()
    x.m.restarting('0.99.2')
    click(restart)
    expect(x.requests).toEqual([])
    // a fresh one, from a ready state, acts
    const y = rig()
    y.clock.tick(); y.clock.advance(T.updateFirstMs); y.u.downloaded('0.99.3'); y.settle()
    click(y.update())
    expect(y.requests).toEqual(['update:0.99.3'])
  })
})
