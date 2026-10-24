/**
 * The bridge's checks (spec 28 A2.14 #18, #19; app-api.ts's bounds), without Electron: each canvas report within its
 * bounds or refused whole, unknown fields stripped; a busy whose busy or unsaved disagrees with its why refused; the
 * app pages' payloads; who may use which app channel, from where. And the preferences every view is made with.
 */
import { describe, expect, it } from 'vitest'
import { checkBusy, checkHello, checkMenu, checkPagePayload, checkTheme, INVOKES, isPinnedUrl, mayUsePageChannel } from '../../src/main/bridge.ts'
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
    expect(checkMenu([{ ...ok, group: 'file' }])).toBe(null)
    expect(checkMenu([{ ...ok, label: 'x'.repeat(49) }])).toBe(null)
    expect(checkMenu([{ ...ok, label: '' }])).toBe(null)
    expect(checkMenu([{ ...ok, hint: '123456789' }])).toBe(null)
    expect(checkMenu([{ ...ok, checked: 'yes' }])).toBe(null)
    expect(checkMenu([ok, ok])).toBe(null)
    expect(checkMenu({})).toBe(null)
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
    expect(checkPagePayload('tabpage:action', { rev: 2, action: 'export-report' }).ok).toBe(false)
    expect(checkPagePayload('home:action', { action: 'copy', id: 'dev' })).toEqual({ ok: true, value: { action: 'copy', id: 'dev' } })
    expect(checkPagePayload('home:action', { action: 'copy', id: 'rm -rf /' }).ok).toBe(false)
    expect(checkPagePayload('home:action', { action: 'show-files', path: '/etc' })).toEqual({ ok: true, value: { action: 'show-files' } })
    expect(checkPagePayload('settings:set', { file: 'config', key: 'restoreTabs', value: false }).ok).toBe(true)
    expect(checkPagePayload('settings:set', { file: '../x', key: 'k', value: 1 }).ok).toBe(false)
    expect(checkPagePayload('mv:theme', { dark: true }).ok).toBe(false)
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
