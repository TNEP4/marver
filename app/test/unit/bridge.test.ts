/**
 * The bridge's checks (spec 28 A2.14 #18, #19; app-api.ts's bounds), without Electron: each canvas report within its
 * bounds or refused whole, unknown fields stripped; a busy whose busy or unsaved disagrees with its why refused; the
 * app pages' payloads; who may use which app channel, from where. And the preferences every view is made with.
 */
import { describe, expect, it } from 'vitest'
import { checkBusy, checkCaptureRect, checkHello, checkMenu, checkPagePayload, checkTheme, INVOKES, isPinnedUrl, mayUsePageChannel } from '../../src/main/bridge.ts'
import { appWebPreferences, canvasWebPreferences, peopleLink, refuseDownload } from '../../src/main/sessions.ts'
import { SENDERS } from '../../src/shared/channels.ts'

describe('canvas reports', () => {
  it('hello: version, board, page within bounds (and A3\'s inset, a3-contracts.test.ts); unknown fields stripped', () => {
    expect(checkHello({ version: '0.27.1', board: 'main', page: 'PAGE_0123456789', top: 44 })).toEqual({ version: '0.27.1', board: 'main', page: 'PAGE_0123456789' })
    expect(checkHello({ version: '0.27.1', board: null, page: 'abcdefgh' })).toEqual({ version: '0.27.1', board: null, page: 'abcdefgh' })
    expect(checkHello({ version: '0.27.1 beta', board: null, page: 'abcdefgh' })).toBe(null)
    expect(checkHello({ version: 'x'.repeat(33), board: null, page: 'abcdefgh' })).toBe(null)
    expect(checkHello({ version: '1', board: 'b'.repeat(129), page: 'abcdefgh' })).toBe(null)
    expect(checkHello({ version: '1', board: null, page: 'short' })).toBe(null)
    expect(checkHello({ version: '1', board: 'a\nb', page: 'abcdefgh' })).toBe(null)
    expect(checkHello('hello')).toBe(null)
  })
  it('theme: a boolean dark, nothing else', () => {
    expect(checkTheme({ dark: true, extra: 1 })).toEqual({ dark: true })
    expect(checkTheme({ dark: 'yes' })).toBe(null)
    expect(checkTheme(null)).toBe(null)
  })
  it('busy: the enum, no repeats, in the contract\'s order; busy and unsaved must agree with why', () => {
    expect(checkBusy({ busy: false, unsaved: false, why: [] })).toEqual({ busy: false, unsaved: false, why: [] })
    expect(checkBusy({ busy: true, unsaved: true, why: ['typing', 'board-unsaved'] })).toEqual({ busy: true, unsaved: true, why: ['board-unsaved', 'typing'] })
    expect(checkBusy({ busy: true, unsaved: false, why: ['microphone', 'agent'] })).toEqual({ busy: true, unsaved: false, why: ['microphone', 'agent'] })
    expect(checkBusy({ busy: true, unsaved: false, why: ['typing'] })).toBe(null)
    expect(checkBusy({ busy: false, unsaved: false, why: ['agent'] })).toBe(null)
    expect(checkBusy({ busy: true, unsaved: true, why: [] })).toBe(null)
    expect(checkBusy({ busy: true, unsaved: false, why: ['agent', 'agent'] })).toBe(null)
    expect(checkBusy({ busy: true, unsaved: false, why: ['coffee'] })).toBe(null)
    expect(checkBusy({ busy: 1, unsaved: false, why: [] })).toBe(null)
  })
  it('menu: at most 40, ids by the contract, labels up to 48, hints up to 8, checked a boolean, no repeated id', () => {
    const ok = { id: 'fit-all', group: 'view', label: 'Fit All', hint: '⇧1' }
    expect(checkMenu([ok, { id: 'session', group: 'jam', label: 'Session', checked: true, role: 'quit' }])).toEqual([ok, { id: 'session', group: 'jam', label: 'Session', checked: true }])
    expect(checkMenu(Array.from({ length: 41 }, (_, i) => ({ ...ok, id: `i${i}` })))).toBe(null)
    expect(checkMenu([{ ...ok, id: 'Fit' }])).toBe(null)
    // spec 31 (app 1.1): a canvas's File items (Export PDF…); any other group is still refused
    expect(checkMenu([{ id: 'export-pdf', group: 'file', label: 'Export PDF…' }])).toEqual([{ id: 'export-pdf', group: 'file', label: 'Export PDF…' }])
    expect(checkMenu([{ ...ok, group: 'edit' }])).toBe(null)
    expect(checkMenu([{ ...ok, label: 'x'.repeat(49) }])).toBe(null)
    expect(checkMenu([{ ...ok, label: '' }])).toBe(null)
    expect(checkMenu([{ ...ok, hint: '123456789' }])).toBe(null)
    expect(checkMenu([{ ...ok, checked: 'yes' }])).toBe(null)
    expect(checkMenu([ok, ok])).toBe(null)
    expect(checkMenu({})).toBe(null)
  })
})

describe('mv:capture\'s rect (A4.6 #35)', () => {
  const VIEW = { width: 1280, height: 800 }
  it('finite, x and y at least 0, a side at least 1, inside the view - rounded out to whole px', () => {
    expect(checkCaptureRect({ rect: { x: 10, y: 20, width: 300, height: 200 }, more: 1 }, VIEW)).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    // 10.4 -> 10, 20.7 -> 20; right 110.5 -> 111, bottom 71.2 -> 72
    expect(checkCaptureRect({ rect: { x: 10.4, y: 20.7, width: 100.1, height: 50.5 } }, VIEW)).toEqual({ x: 10, y: 20, width: 101, height: 52 })
    expect(checkCaptureRect({ rect: { x: 0, y: 0, width: 1280, height: 800 } }, VIEW)).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
    // a zoomed view's fractional size: its last partial px is inside
    expect(checkCaptureRect({ rect: { x: 0, y: 0, width: 1163.6, height: 727.3 } }, { width: 1163.6, height: 727.3 })).toEqual({ x: 0, y: 0, width: 1164, height: 728 })
  })
  it('anything else is bounds (null): outside the view, negative, empty, not a number, no rect, no view', () => {
    const bad = [
      { x: 1000, y: 0, width: 281, height: 10 }, { x: 0, y: 700, width: 10, height: 100.5 }, { x: -1, y: 0, width: 10, height: 10 }, { x: 0, y: -0.5, width: 10, height: 10 },
      { x: 0, y: 0, width: 0.5, height: 10 }, { x: 0, y: 0, width: 10, height: 0 }, { x: NaN, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: Infinity, height: 10 },
      { x: '0', y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10 },
    ]
    for (const rect of bad) expect(checkCaptureRect({ rect }, VIEW), JSON.stringify(rect)).toBe(null)
    expect(checkCaptureRect({}, VIEW)).toBe(null)
    expect(checkCaptureRect(null, VIEW)).toBe(null)
    expect(checkCaptureRect({ rect: { x: 0, y: 0, width: 10, height: 10 } }, null)).toBe(null)
  })
})

describe('app pages', () => {
  it('payloads are checked and stripped per channel', () => {
    expect(checkPagePayload('tab:activate', { id: 't1', x: 1 })).toEqual({ ok: true, value: { id: 't1' } })
    expect(checkPagePayload('tab:activate', { id: '../x' }).ok).toBe(false)
    expect(checkPagePayload('tab:menu', { id: 't1', x: 10, y: 20 })).toEqual({ ok: true, value: { id: 't1', x: 10, y: 20 } })
    expect(checkPagePayload('tab:menu', { id: 't1', x: Infinity, y: 0 }).ok).toBe(false)
    expect(checkPagePayload('tabs:more', { ids: ['t1', 't2'], x: 1, y: 2 }).ok).toBe(true)
    expect(checkPagePayload('link:open', { url: 'x'.repeat(2049) }).ok).toBe(false)
    expect(checkPagePayload('pill:action', { rev: 3, act: 'button' }).ok).toBe(true)
    expect(checkPagePayload('pill:action', { rev: -1, act: 'button' }).ok).toBe(false)
    // A5.1 #28: the latched crashed page's Export Performance Report… (main still refuses it on any other state)
    expect(checkPagePayload('tabpage:action', { rev: 2, action: 'export-report', path: '/etc' })).toEqual({ ok: true, value: { rev: 2, action: 'export-report' } })
    expect(checkPagePayload('tabpage:action', { rev: 2, action: 'export' }).ok).toBe(false)
    expect(checkPagePayload('home:action', { action: 'copy', id: 'dev' })).toEqual({ ok: true, value: { action: 'copy', id: 'dev' } })
    expect(checkPagePayload('home:action', { action: 'copy', id: 'rm -rf /' }).ok).toBe(false)
    expect(checkPagePayload('home:action', { action: 'show-files', path: '/etc' })).toEqual({ ok: true, value: { action: 'show-files' } })
    expect(checkPagePayload('settings:set', { file: 'config', key: 'restoreTabs', value: false }).ok).toBe(true)
    expect(checkPagePayload('settings:set', { file: '../x', key: 'k', value: 1 }).ok).toBe(false)
    // A4.6 #27: Settings' one action, nothing else - notices-on and notices-off are not built
    expect(checkPagePayload('settings:action', { action: 'open-notification-settings', url: 'x' })).toEqual({ ok: true, value: { action: 'open-notification-settings' } })
    for (const action of ['notices-on', 'notices-off', 'open-browser', undefined]) expect(checkPagePayload('settings:action', { action }).ok).toBe(false)
    expect(checkPagePayload('settings:action', null).ok).toBe(false)
    expect(checkPagePayload('mv:theme', { dark: true }).ok).toBe(false)
  })
  it('spec 32 B2: the strip\'s menu - the asks\' booleans, a pick by row id or null (never a label), the shown ack', () => {
    expect(checkPagePayload('tab:menu', { id: 't1', x: 10, y: 20, key: true, hadFocus: false, label: 'x' })).toEqual({ ok: true, value: { id: 't1', x: 10, y: 20, key: true, hadFocus: false } })
    expect(checkPagePayload('tab:menu', { id: 't1', x: 10, y: 20, hadFocus: true })).toEqual({ ok: true, value: { id: 't1', x: 10, y: 20, hadFocus: true } })
    for (const bad of [{ key: 'yes' }, { hadFocus: 1 }, { key: null }]) expect(checkPagePayload('tab:menu', { id: 't1', x: 1, y: 1, ...bad }).ok, JSON.stringify(bad)).toBe(false)
    expect(checkPagePayload('tabs:more', { ids: ['t1'], x: 1, y: 2, key: false, hadFocus: true })).toEqual({ ok: true, value: { ids: ['t1'], x: 1, y: 2, key: false, hadFocus: true } })
    expect(checkPagePayload('tabs:more', { ids: ['t1'], x: 1, y: 2, key: 'no' }).ok).toBe(false)
    for (const id of ['open-browser', 'reveal', 'copy-link', 'mark-all-seen', 'resolve-all-comments', 'reload', 'force-reload', 'close', 'tab:t_1-x', null]) {
      expect(checkPagePayload('tab:menu-pick', { rev: 3, id, label: 'Close tab' }), String(id)).toEqual({ ok: true, value: { rev: 3, id } })
    }
    for (const bad of [{ rev: 3, id: 'Close tab' }, { rev: 3, id: 'activate' }, { rev: 3, id: 'tab:' }, { rev: 3, id: `tab:${'a'.repeat(33)}` }, { rev: 3, id: 'tab:../x' }, { rev: 3 }, { rev: -1, id: null }, { rev: 1.5, id: null }, { id: null }]) {
      expect(checkPagePayload('tab:menu-pick', bad).ok, JSON.stringify(bad)).toBe(false)
    }
    expect(checkPagePayload('tab:menu-shown', { rev: 4, x: 1 })).toEqual({ ok: true, value: { rev: 4 } })
    expect(checkPagePayload('tab:menu-shown', { rev: 'a' }).ok).toBe(false)
  })
  it('spec 32 D8.1, D8.8: home:action\'s card actions by id, and how a row was picked (via key, its key)', () => {
    for (const action of ['copy-link', 'copy-path', 'reveal']) {
      expect(checkPagePayload('home:action', { action, id: 's_0123456789abcdef', url: 'x' }), action).toEqual({ ok: true, value: { action, id: 's_0123456789abcdef' } })
      expect(checkPagePayload('home:action', { action, id: 'r_0123456789abcdef', via: 'key', keys: 'Space' }), action).toEqual({ ok: true, value: { action, id: 'r_0123456789abcdef', via: 'key', keys: 'Space' } })
      expect(checkPagePayload('home:action', { action, id: '/Users/x' }).ok, action).toBe(false)
      expect(checkPagePayload('home:action', { action }).ok, action).toBe(false)
    }
    expect(checkPagePayload('home:action', { action: 'copy', id: 'dev', via: 'key', keys: 'Enter' })).toEqual({ ok: true, value: { action: 'copy', id: 'dev', via: 'key', keys: 'Enter' } })
    expect(checkPagePayload('home:action', { action: 'copy-start', id: 't1', via: 'key' })).toEqual({ ok: true, value: { action: 'copy-start', id: 't1', via: 'key' } })
    // a key with no `via` is not kept; a wrong via or key refuses
    expect(checkPagePayload('home:action', { action: 'show-files', keys: 'Enter' })).toEqual({ ok: true, value: { action: 'show-files' } })
    for (const bad of [{ via: 'click' }, { via: 'key', keys: 'Escape' }, { keys: 'Tab' }]) expect(checkPagePayload('home:action', { action: 'reveal', id: 't1', ...bad }).ok, JSON.stringify(bad)).toBe(false)
  })
  it('spec 32 D8.8: the sender\'s kind - tab:activate\'s cancel and keys kept from Home, stripped from the strip', () => {
    const p = { id: 't1', cancel: true, keys: 'Enter' }
    expect(checkPagePayload('tab:activate', p, 'home')).toEqual({ ok: true, value: { id: 't1', cancel: true, keys: 'Enter' } })
    expect(checkPagePayload('tab:activate', p, 'strip')).toEqual({ ok: true, value: { id: 't1' } })
    expect(checkPagePayload('link:open', { url: 'x', via: 'key', keys: 'Space' }, 'home').ok).toBe(true)
    expect(checkPagePayload('link:open', { url: 'x', via: 'key', keys: 'Space' }, 'strip').ok).toBe(false)
  })
  it('a pinned page is exactly marver-app://<kind>/', () => {
    expect(isPinnedUrl('marver-app://home/', 'home')).toBe(true)
    expect(isPinnedUrl('marver-app://home/index.html#x', 'home')).toBe(true)
    expect(isPinnedUrl('marver-app://home/?x', 'home')).toBe(false)
    expect(isPinnedUrl('marver-app://settings/', 'home')).toBe(false)
    expect(isPinnedUrl('marver-app://home/other.html', 'home')).toBe(false)
    expect(isPinnedUrl('data:text/html,x', 'home')).toBe(false)
    expect(isPinnedUrl('marver-app://canvas/', 'canvas')).toBe(false)
  })
  it('the invokes are the app preload\'s - link:open, home:action, settings:get, settings:set - each a page channel', () => {
    expect([...INVOKES].sort()).toEqual(['home:action', 'link:open', 'settings:get', 'settings:set'])
    expect([...INVOKES].every((c) => !!SENDERS[c])).toBe(true)
  })
  it('a download from anything but a canvas main made is cancelled', () => {
    expect(refuseDownload(null, 'http://x/')).toBe('not a canvas')
    expect(refuseDownload({ id: 424242, isDestroyed: () => false } as unknown as Parameters<typeof refuseDownload>[0], 'http://x/')).toBe('not a canvas')
  })
  it('who may send what, from where: the kinds SENDERS lists, the main frame, the pinned page', () => {
    expect(mayUsePageChannel('tab:activate', 'strip', true, 'marver-app://strip/')).toBe(true)
    expect(mayUsePageChannel('tab:activate', 'canvas', true, 'http://[::1]:4806/')).toBe(false)
    expect(mayUsePageChannel('tab:activate', 'settings', true, 'marver-app://settings/')).toBe(false)
    expect(mayUsePageChannel('tab:activate', 'strip', false, 'marver-app://strip/')).toBe(false)
    expect(mayUsePageChannel('tab:activate', 'strip', true, 'marver-app://home/')).toBe(false)
    expect(mayUsePageChannel('tab:activate', undefined, true, 'marver-app://strip/')).toBe(false)
    expect(mayUsePageChannel('no-such-channel', 'strip', true, 'marver-app://strip/')).toBe(false)
    // A4.6 #27: settings:action from Settings alone; #40: a remote view sends nothing and has no pinned page
    expect(mayUsePageChannel('settings:action', 'settings', true, 'marver-app://settings/')).toBe(true)
    expect(mayUsePageChannel('settings:action', 'home', true, 'marver-app://home/')).toBe(false)
    // spec 32 B2: the tab menu's channels from the strip alone - Home's menus are its own DOM now
    for (const ch of ['tab:menu', 'tabs:more', 'tab:menu-pick', 'tab:menu-shown']) {
      expect(mayUsePageChannel(ch, 'strip', true, 'marver-app://strip/'), ch).toBe(true)
      expect(mayUsePageChannel(ch, 'home', true, 'marver-app://home/'), ch).toBe(false)
    }
    for (const url of ['https://pilot.example.com/', 'marver-app://remote/']) {
      for (const ch of Object.keys(SENDERS)) expect(mayUsePageChannel(ch, 'remote', true, url), `${ch} ${url}`).toBe(false)
      expect(isPinnedUrl(url, 'remote')).toBe(false)
    }
  })
})

describe('preferences', () => {
  it('every view is sandboxed, isolated, without Node, webviews or dialogs; a canvas on its workspace\'s partition', () => {
    const c = canvasWebPreferences('0123456789abcdef')
    expect(c).toMatchObject({ partition: 'persist:local:0123456789abcdef', sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, disableDialogs: true, disableHtmlFullscreenWindowResize: true, focusOnNavigation: false })
    expect(c.preload).toMatch(/preload-canvas\.cjs$/)
    expect('backgroundThrottling' in c).toBe(false)
    expect(appWebPreferences()).toMatchObject({ partition: 'persist:app', sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, disableDialogs: true })
    expect(() => canvasWebPreferences('../../x')).toThrow()
  })
  it('the people link is the canvas\'s localhost address with the path', () => {
    expect(peopleLink({ url: 'http://localhost:4806/' }, new URL('http://[::1]:4806/__mv/frame/?id=x#k'))).toBe('http://localhost:4806/__mv/frame/?id=x#k')
  })
})
