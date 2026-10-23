/**
 * The app's keys (spec 28 A2.4, A2.14 #25), the menu's template (A2.7, v1.10 r1 #3, #10, r2 #1, r3 #3), the
 * window's layout (A2.2, A2.14 #1) - pure, no Electron. (The start command's own cases are the pages stream's
 * test/unit/command.test.ts.)
 */
import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { matchKey, type AppCommand } from '../../src/main/keys.ts'
import { menuTemplate, type MenuActs, type MenuModel } from '../../src/main/menu.ts'
import { GROUND, plan } from '../../src/main/plan.ts'

type K = Parameters<typeof matchKey>[0]
const key = (o: Partial<K>): K => ({ type: 'keyDown', key: '', code: '', isAutoRepeat: false, shift: false, control: false, alt: false, meta: false, ...o })

describe('the app\'s keys: by key or by code, keyDown only, held keys once (A2.14 #25)', () => {
  it('⌘ and a letter by key, so ⌘Q follows the layout', () => {
    const got = (k: string, shift = false) => matchKey(key({ meta: true, shift, key: shift ? k.toUpperCase() : k, code: 'KeyX' }))
    expect(['t', 'w', 'l', 'r', ',', 'q', 'h', 'm'].map((k) => got(k))).toEqual(['home', 'close-tab', 'open-link', 'reload', 'settings', 'quit', 'hide', 'minimize'])
    expect(got('w', true)).toBe('close-window')
    expect(got('r', true)).toBe('force-reload')
  })

  it('digits by code (AZERTY\'s are shifted keys): ⌘1-⌘8 and ⌘9 the last', () => {
    expect(matchKey(key({ meta: true, key: '&', code: 'Digit1' }))).toBe('tab-1')
    expect(matchKey(key({ meta: true, key: '8', code: 'Digit8' }))).toBe('tab-8')
    expect(matchKey(key({ meta: true, key: 'ç', code: 'Digit9' }))).toBe('tab-last')
    expect(matchKey(key({ meta: true, shift: true, key: '!', code: 'Digit1' }))).toBeNull()
  })

  it('⌥ and the shifted brackets by code; ⌃Tab and ⌃⇧Tab; ⌃⌘F; F6 and ⇧F6 alone', () => {
    expect(matchKey(key({ meta: true, alt: true, key: '˙', code: 'KeyH' }))).toBe('hide-others')
    expect(matchKey(key({ meta: true, alt: true, key: 'ˆ', code: 'KeyI' }))).toBe('devtools')
    expect(matchKey(key({ meta: true, shift: true, key: '{', code: 'BracketLeft' }))).toBe('prev-tab')
    expect(matchKey(key({ meta: true, shift: true, key: '}', code: 'BracketRight' }))).toBe('next-tab')
    expect(matchKey(key({ control: true, key: 'Tab', code: 'Tab' }))).toBe('next-tab')
    expect(matchKey(key({ control: true, shift: true, key: 'Tab', code: 'Tab' }))).toBe('prev-tab')
    expect(matchKey(key({ control: true, meta: true, key: 'f', code: 'KeyF' }))).toBe('fullscreen')
    expect(matchKey(key({ key: 'F6', code: 'F6' }))).toBe('focus-strip')
    expect(matchKey(key({ shift: true, key: 'F6', code: 'F6' }))).toBe('focus-strip-back')
  })

  it('⌃⌥F is Mark a Flash, by code (A3.8 #13); ⌥F, ⌘⌥F and ⌃⌥⇧F are not', () => {
    expect(matchKey(key({ control: true, alt: true, key: 'ƒ', code: 'KeyF' }))).toBe('mark-flash')
    expect(matchKey(key({ control: true, alt: true, key: 'f', code: 'KeyF', isAutoRepeat: true }))).toBeNull()
    expect(matchKey(key({ alt: true, key: 'ƒ', code: 'KeyF' }))).toBeNull()
    expect(matchKey(key({ meta: true, alt: true, key: 'ƒ', code: 'KeyF' }))).toBeNull()
    expect(matchKey(key({ control: true, alt: true, shift: true, key: 'Ï', code: 'KeyF' }))).toBeNull()
    expect(matchKey(key({ control: true, alt: true, key: 'g', code: 'KeyG' }))).toBeNull()
  })

  it('never the Edit keys, never a canvas key; keyUp and auto-repeat are nothing', () => {
    for (const k of ['c', 'v', 'x', 'z', 'a']) expect(matchKey(key({ meta: true, key: k, code: `Key${k.toUpperCase()}` }))).toBeNull()
    expect(matchKey(key({ meta: true, shift: true, key: 'Z', code: 'KeyZ' }))).toBeNull()
    expect(matchKey(key({ key: 'j', code: 'KeyJ' }))).toBeNull()
    expect(matchKey(key({ shift: true, key: '!', code: 'Digit1' }))).toBeNull()
    expect(matchKey(key({ type: 'keyUp', meta: true, key: 'w', code: 'KeyW' }))).toBeNull()
    expect(matchKey(key({ meta: true, key: '2', code: 'Digit2', isAutoRepeat: true }))).toBeNull()
  })
})

describe('the menu bar (A2.7)', () => {
  const token = (tab: string) => ({ tab, commit: 3, trusted: true })
  const model = (o: Partial<MenuModel> = {}): MenuModel => ({
    active: { id: 't1', kind: 'local', name: 'Tidewell', token: token('t1'), trusted: true, canClose: true, canReload: true },
    canvas: { token: token('t1'), items: [
      { id: 'fit-all', group: 'view', label: 'Fit All', hint: '⇧1' },
      { id: 'pins', group: 'view', label: 'Pins', hint: '⇧C', checked: true },
      { id: 'notes', group: 'view', label: 'Notes', hint: 'N', checked: false },
      { id: 'session', group: 'jam', label: 'Session', hint: 'J' },
    ] },
    tabs: [
      { id: 'home', name: 'Home', active: false, token: token('home') },
      { id: 't1', name: 'Tidewell', key: 1, active: true, token: token('t1') },
      { id: 't2', name: 'Gen lab', word: 'stopped', key: 9, active: false, token: token('t2') },
    ],
    header: true,
    ...o,
  })
  const acts = (holds = true) => {
    const a = { run: vi.fn(), holds: vi.fn(() => holds), canvasClick: vi.fn(), tab: vi.fn(), help: vi.fn(), perfFiles: vi.fn(), rebuild: vi.fn() }
    return a as typeof a & MenuActs
  }
  const sub = (t: MenuItemConstructorOptions[], label: string) => (t.find((m) => m.label === label || m.role === label)!.submenu as MenuItemConstructorOptions[])
  const item = (items: MenuItemConstructorOptions[], label: string) => items.find((m) => m.label === label || m.id === label)!
  const click = (m: MenuItemConstructorOptions) => (m.click as unknown as () => void)()

  it('canvas items carry their key in their name and no accelerator; checked ones are checkboxes', () => {
    const view = sub(menuTemplate(model(), acts()), 'View')
    const fit = item(view, 'cv:fit-all')
    expect(fit.label).toBe('Fit All (⇧1)')
    expect(fit.accelerator).toBeUndefined()
    expect(item(view, 'cv:pins')).toMatchObject({ type: 'checkbox', checked: true, label: 'Pins (⇧C)' })
    expect(item(view, 'cv:notes')).toMatchObject({ type: 'checkbox', checked: false })
    expect(view[0]).toMatchObject({ type: 'header', label: 'Tidewell' })
  })

  it('a canvas item\'s click sends once while its token holds, and the menu is built again either way', () => {
    const a = acts()
    click(item(sub(menuTemplate(model(), a), 'View'), 'cv:pins'))
    expect(a.canvasClick).toHaveBeenCalledWith(token('t1'), 'pins')
    expect(a.rebuild).toHaveBeenCalledTimes(1)
    const stale = acts(false)
    click(item(sub(menuTemplate(model(), stale), 'View'), 'cv:pins'))
    expect(stale.canvasClick).not.toHaveBeenCalled()
    expect(stale.rebuild).toHaveBeenCalledTimes(1)
  })

  it('Jam only while the canvas sends it; no canvas items for Home, Settings or an untrusted tab', () => {
    expect(sub(menuTemplate(model(), acts()), 'Jam').map((m) => m.label)).toEqual(['Session (J)'])
    const home = menuTemplate(model({ active: { id: 'home', kind: 'home', name: 'Home', token: token('home'), trusted: false, canClose: false, canReload: false }, canvas: null }), acts())
    expect(home.some((m) => m.label === 'Jam')).toBe(false)
    expect(sub(home, 'View')[0]!.label).toBe('Reload Canvas')
    expect(item(sub(home, 'File'), 'Close Tab').enabled).toBe(false)
  })

  it('the app\'s own items carry their accelerators and run their command; Quit is never role quit', () => {
    const a = acts()
    const t = menuTemplate(model(), a)
    const marver = sub(t, 'Marver')
    const quit = item(marver, 'Quit Marver')
    expect(quit).toMatchObject({ accelerator: 'Cmd+Q' })
    expect(quit.role).toBeUndefined()
    click(quit)
    expect(a.run).toHaveBeenCalledWith('quit' satisfies AppCommand)
    expect(item(marver, 'Settings…').accelerator).toBe('Cmd+,')
    const file = sub(t, 'File')
    expect(['Home', 'Open Link…', 'Close Tab', 'Close Window'].map((l) => item(file, l).accelerator)).toEqual(['Cmd+T', 'Cmd+L', 'Cmd+W', 'Shift+Cmd+W'])
    expect(sub(t, 'Edit').map((m) => m.role).filter(Boolean)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'])
  })

  it('Help: Marver Help, then Mark a Flash with ⌃⌥F (A3), then Show Performance Files', () => {
    const a = acts()
    const help = sub(menuTemplate(model(), a), 'help')
    expect(help.filter((m) => m.type !== 'separator').map((m) => m.label)).toEqual(['Marver Help', 'Mark a Flash', 'Show Performance Files'])
    const mark = item(help, 'Mark a Flash')
    expect(mark.accelerator).toBe('Ctrl+Alt+F')
    click(mark)
    expect(a.run).toHaveBeenCalledWith('mark-flash' satisfies AppCommand)
  })

  it('the File menu\'s canvas items run from main, Open in Browser and Copy Local Link only while trusted', () => {
    const untrusted = model({ active: { id: 't1', kind: 'local', name: 'Tidewell', token: { tab: 't1', commit: 3, trusted: false }, trusted: false, canClose: true, canReload: true }, canvas: null })
    const file = sub(menuTemplate(untrusted, acts()), 'File')
    expect(item(file, 'Open in Browser').enabled).toBe(false)
    expect(item(file, 'Copy Local Link').enabled).toBe(false)
    expect(item(file, 'Reveal in Finder').enabled).toBeUndefined()
  })

  it('Reload Canvas and Force Reload are tab items: their keys, and a click reloads the tab the menu was built for only while it holds', () => {
    const a = acts()
    const view = sub(menuTemplate(model(), a), 'View')
    expect(item(view, 'reload')).toMatchObject({ label: 'Reload Canvas', accelerator: 'Cmd+R', enabled: true })
    expect(item(view, 'force-reload')).toMatchObject({ label: 'Force Reload', accelerator: 'Shift+Cmd+R' })
    click(item(view, 'reload'))
    click(item(view, 'force-reload'))
    expect(a.tab.mock.calls).toEqual([[token('t1'), 'reload'], [token('t1'), 'force-reload']])
    expect(a.run).not.toHaveBeenCalled()   // never "whichever tab is active by then"
    const stale = acts(false)
    click(item(sub(menuTemplate(model(), stale), 'View'), 'reload'))
    expect(stale.tab).not.toHaveBeenCalled()
  })

  it('the Window menu lists every tab with its key and state; the active one checked; a stale tab item does nothing', () => {
    const a = acts(false)
    const win = sub(menuTemplate(model(), a), 'Window')
    const t1 = item(win, 'tab:t1')
    expect(t1).toMatchObject({ type: 'checkbox', checked: true, accelerator: 'Cmd+1', label: 'Tidewell' })
    expect(item(win, 'tab:t2')).toMatchObject({ label: 'Gen lab - stopped', accelerator: 'Cmd+9', accessibilityLabel: 'Gen lab, stopped' })
    click(item(win, 'tab:t2'))
    expect(a.tab).not.toHaveBeenCalled()
  })

  it('macOS 13: a disabled item stands in for a header', () => {
    expect(sub(menuTemplate(model({ header: false }), acts()), 'View')[0]).toMatchObject({ label: 'Tidewell', enabled: false })
  })
})

describe('the layout: the opaque strip (A2.14 #1)', () => {
  const tab = (id: string, kind: 'local' | 'home' | 'settings', o: Partial<{ view: boolean; page: boolean; pageView: boolean; dark: boolean }> = {}) =>
    ({ id, kind, view: true, page: false, pageView: false, dark: false, ...o })

  it('every view below the 44 px strip, shown or hidden; the cover always shown in the active tab\'s ground', () => {
    const p = plan({ tabs: [tab('home', 'home'), tab('t1', 'local', { dark: true }), tab('settings', 'settings')], active: 't1', w: 1280, h: 820, appDark: false })
    for (const v of p.views) expect(v.rect).toEqual({ x: 0, y: 44, width: 1280, height: 776 })
    expect(p.views.filter((v) => v.visible).map((v) => v.key)).toEqual(['t1:view'])
    expect(p.cover).toEqual({ rect: { x: 0, y: 0, width: 1280, height: 44 }, visible: true, color: GROUND.dark })
    expect(p.strip).toEqual({ x: 0, y: 0, width: 1280, height: 44 })
  })

  it('a tab page stands over its tab\'s view: the view hidden, the page shown; Home and Settings wear the app\'s ground', () => {
    const p = plan({ tabs: [tab('home', 'home'), tab('t1', 'local', { page: true, pageView: true })], active: 't1', w: 800, h: 600, appDark: true })
    expect(p.views.find((v) => v.key === 't1:view')!.visible).toBe(false)
    expect(p.views.find((v) => v.key === 't1:page')!).toMatchObject({ visible: true, rect: { x: 0, y: 44, width: 800, height: 556 } })
    expect(p.views.find((v) => v.key === 'home:view')!.color).toBe(GROUND.dark)
    expect(plan({ tabs: [tab('home', 'home')], active: 'home', w: 800, h: 600, appDark: false }).cover.color).toBe(GROUND.light)
  })

  it('a hidden tab\'s page view (closing in 30 s) stays hidden', () => {
    const p = plan({ tabs: [tab('home', 'home'), tab('t1', 'local', { page: true, pageView: true })], active: 'home', w: 800, h: 600, appDark: false })
    expect(p.views.filter((v) => v.visible).map((v) => v.key)).toEqual(['home:view'])
  })
})
