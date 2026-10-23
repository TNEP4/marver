/**
 * The strip (spec 28 A2.2, A2.4, A2.13, A2.14 #19, #26): the real page and the real app preload under a fake main
 * (test/harness/pages.ts). The tab list's ARIA and keyboard model, fitting into `»`, the one pill and its short form,
 * the live region, revisions, and the system settings followed live.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PillView, TabsSnapshot, TabView } from '../../src/shared/channels.ts'
import { animatedProperties, openPage, type PageRun } from '../harness/pages.ts'

const home: TabView = { id: 'h', kind: 'home', name: 'Home', state: 'live', verified: true, open: true }
const tab = (id: string, name: string, over: Partial<TabView> = {}): TabView =>
  ({ id, kind: 'local', name, state: 'live', verified: true, open: true, link: `http://localhost:${4900 + Number(id.slice(1))}/`, ...over })
let rev = 0
const snap = (active: string, tabs: TabView[]): TabsSnapshot => ({ rev: ++rev, active, tabs })

const FOUR = [home, tab('t1', 'Marver Platform', { key: 1 }), tab('t2', 'TMS broker', { key: 2, state: 'gone' }), tab('t3', 'localhost:4808', { key: 3, state: 'unverified' }), tab('t4', 'Tidewell', { key: 9, state: 'starting' })]

let p: PageRun
const readyCalls: unknown[] = []
beforeAll(async () => {
  p = await openPage('strip', { width: 1280, height: 44 })
  readyCalls.push(...await p.calls('app:ready'))
})
afterAll(async () => { await p?.close() })
beforeEach(async () => { await p.clear() })

const focusedId = () => p.page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.id ?? null)
const tabindexes = () => p.page.$$eval('[role="tab"]', (els) => els.map((e) => [(e as HTMLElement).dataset.id, (e as HTMLElement).tabIndex] as const))

describe('the tab list (A2.13)', () => {
  it('says app:ready once, then draws the snapshot', async () => {
    expect(readyCalls).toEqual([null])
    await p.send('tabs', snap('t1', FOUR))
    expect(await p.page.locator('[role="tab"]').count()).toBe(5)
    expect(await p.calls('app:ready')).toEqual([])
  })

  it('the preload exposes the strip\'s own methods alone, and no channel', async () => {
    expect(await p.page.evaluate(() => Object.keys((window as unknown as { marverPage: object }).marverPage).sort())).toEqual([
      'activate', 'close', 'kind', 'more', 'onPageFocus', 'onPill', 'onTabs', 'onWindow', 'openLink', 'pillAction', 'ready', 'tabMenu',
    ])
  })

  it('the window: dimmed in the background, no traffic-light room in full screen', async () => {
    await p.send('window', { rev: 1, focused: false, fullScreen: true })
    expect(await p.page.evaluate(() => [...document.body.classList].sort())).toEqual(['fullscreen', 'inactive'])
    expect(await p.page.$eval('.strip', (e) => getComputedStyle(e).paddingLeft)).toBe('10px')
    await p.send('window', { rev: 2, focused: true, fullScreen: false })
    expect(await p.page.$eval('.strip', (e) => getComputedStyle(e).paddingLeft)).toBe('82px')
  })

  it('is a tablist "Canvases" whose tabs carry their names, states and keys', async () => {
    await p.send('tabs', snap('t1', FOUR))
    // a tab's children are presentational (WAI-ARIA): its name is what is read; Playwright also shows the visible text
    expect(await p.page.locator('#tabs').ariaSnapshot()).toBe([
      '- tablist "Canvases":',
      '  - tab "Home"',
      '  - tab "Marver Platform" [selected]',
      '  - tab "TMS broker, stopped": TMS broker',
      '  - tab "localhost:4808, not a Marver canvas": localhost:4808',
      '  - tab "Tidewell, starting": Tidewell',
    ].join('\n'))
    expect(await p.page.$$eval('[role="tab"]', (els) => els.map((e) => e.getAttribute('aria-selected')))).toEqual(['false', 'true', 'false', 'false', 'false'])
    expect(await p.page.$$eval('[role="tab"]', (els) => els.map((e) => e.getAttribute('aria-keyshortcuts'))))
      .toEqual(['Meta+T', 'Meta+1', 'Meta+2', 'Meta+3', 'Meta+9'])
    expect(await p.page.$$eval('[role="tab"] img', (els) => els.map((e) => e.getAttribute('alt')))).toEqual([])
  })

  it('wears no logo for a canvas not proven, a spinner while starting, initials otherwise', async () => {
    await p.send('tabs', snap('t1', FOUR))
    const slot = (id: string) => p.page.$eval(`[data-id="${id}"] .slot`, (e) => ({ warn: !!e.querySelector('.warn'), spin: !!e.querySelector('.spin'), initials: e.querySelector('.logo b')?.textContent ?? null }))
    expect(await slot('t3')).toEqual({ warn: true, spin: false, initials: null })
    expect(await slot('t4')).toEqual({ warn: false, spin: true, initials: null })
    expect(await slot('t1')).toEqual({ warn: false, spin: false, initials: 'MP' })
  })

  it('a logo main checked is an <img alt=""> of its data: URL', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    await p.send('tabs', snap('t1', [home, tab('t1', 'Logo canvas', { logo: png }), tab('t2', 'Not data', { logo: 'https://evil.example/x.png' })]))
    expect(await p.page.$eval('[data-id="t1"] img', (e) => [e.getAttribute('src')?.slice(0, 22), e.getAttribute('alt')])).toEqual(['data:image/png;base64,', ''])
    expect(await p.page.$('[data-id="t2"] img')).toBeNull()
  })

  it('a name is text, never markup', async () => {
    await p.send('tabs', snap('t1', [home, tab('t1', '<img src=x onerror=alert(1)>')]))
    expect(await p.page.$eval('[data-id="t1"] .name', (e) => e.textContent)).toBe('<img src=x onerror=alert(1)>')
    expect(await p.page.$$eval('#tabs img', (els) => els.length)).toBe(0)
  })

  it('exactly one tab holds tabindex 0: the active one when focus arrives', async () => {
    await p.send('tabs', snap('t2', FOUR))
    expect((await tabindexes()).filter(([, i]) => i === 0)).toEqual([['t2', 0]])
  })

  it('arrows, Home and End move focus without switching; Return and Space switch', async () => {
    await p.send('tabs', snap('t1', FOUR))
    await p.page.focus('[data-id="t1"]')
    await p.page.keyboard.press('ArrowRight')
    expect(await focusedId()).toBe('t2')
    expect((await tabindexes()).filter(([, i]) => i === 0)).toEqual([['t2', 0]])
    await p.page.keyboard.press('End')
    expect(await focusedId()).toBe('t4')
    await p.page.keyboard.press('ArrowRight')   // wraps
    expect(await focusedId()).toBe('h')
    await p.page.keyboard.press('ArrowLeft')
    expect(await focusedId()).toBe('t4')
    await p.page.keyboard.press('Home')
    expect(await focusedId()).toBe('h')
    expect(await p.calls('tab:activate')).toEqual([])
    await p.page.keyboard.press('ArrowRight')
    await p.page.keyboard.press('Enter')
    await p.page.keyboard.press('ArrowRight')
    await p.page.keyboard.press(' ')
    expect(await p.calls('tab:activate')).toEqual([{ id: 't1' }, { id: 't2' }])
  })

  it('Delete and Backspace close the focused tab, never Home; ⇧F10 and the context-menu key open its menu at the tab', async () => {
    await p.send('tabs', snap('t1', FOUR))
    await p.page.focus('[data-id="t2"]')
    await p.page.keyboard.press('Delete')
    await p.page.keyboard.press('Backspace')
    await p.page.focus('[data-id="h"]')
    await p.page.keyboard.press('Delete')
    expect(await p.calls('tab:close')).toEqual([{ id: 't2' }, { id: 't2' }])
    await p.page.focus('[data-id="t3"]')
    await p.page.keyboard.press('Shift+F10')
    await p.page.keyboard.press('ContextMenu')
    const menus = await p.calls('tab:menu') as { id: string; x: number; y: number }[]
    const box = await p.page.locator('[data-id="t3"]').boundingBox()
    expect(menus).toEqual([{ id: 't3', x: Math.round(box!.x), y: Math.round(box!.y + box!.height) }, { id: 't3', x: Math.round(box!.x), y: Math.round(box!.y + box!.height) }])
  })

  it('a click activates; a right-click opens the tab\'s menu where it was made', async () => {
    await p.send('tabs', snap('t1', FOUR))
    const before = await p.page.locator('[data-id="t4"]').boundingBox()
    await p.page.click('[data-id="t2"]')
    await p.page.click('[data-id="t4"]', { button: 'right', position: { x: 10, y: 10 } })
    expect(await p.calls('tab:activate')).toEqual([{ id: 't2' }])
    const box = await p.page.locator('[data-id="t4"]').boundingBox()
    expect(box).toEqual(before)   // hovering a tab shows its key over its name: nothing moves
    const [m] = await p.calls('tab:menu') as { id: string; x: number; y: number }[]
    expect(m.id).toBe('t4')
    expect(Math.abs(m.x - (box!.x + 10))).toBeLessThanOrEqual(1)
    expect(Math.abs(m.y - (box!.y + 10))).toBeLessThanOrEqual(1)
  })

  it('page:focus active-tab focuses the active tab', async () => {
    await p.send('tabs', snap('t3', FOUR))
    await p.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await p.send('page:focus', { target: 'active-tab' })
    expect(await focusedId()).toBe('t3')
  })

  it('a closed tab is not in the strip (Home lists it)', async () => {
    await p.send('tabs', snap('t1', [home, tab('t1', 'One'), tab('t2', 'Closed', { open: false })]))
    expect(await p.page.$$eval('[role="tab"]', (els) => els.map((e) => (e as HTMLElement).dataset.id))).toEqual(['h', 't1'])
  })

  it('applies only a newer rev', async () => {
    await p.send('tabs', { rev: 1000, active: 't1', tabs: [home, tab('t1', 'Newer')] })
    await p.send('tabs', { rev: 999, active: 't1', tabs: [home, tab('t1', 'Older')] })
    expect(await p.page.$eval('[data-id="t1"] .name', (e) => e.textContent)).toBe('Newer')
    rev = 1000
  })
})

describe('fitting (A2.2, A2.14 #19)', () => {
  const twenty = () => [home, ...Array.from({ length: 20 }, (_, i) => tab(`t${i + 1}`, `Canvas number ${i + 1}`, { key: i < 8 ? i + 1 : i === 19 ? 9 : undefined }))]

  it('every tab at its own width while they fit: no »', async () => {
    await p.send('tabs', snap('t1', FOUR))
    expect(await p.page.isHidden('#more')).toBe(true)
    const w = await p.page.$$eval('.tab', (els) => els.map((e) => e.getBoundingClientRect().width))
    for (const x of w) expect(x).toBeLessThanOrEqual(176)
  })

  it('twenty canvases at 720 px: the active one whole, the rest from 58 px, the others behind » named for what it holds', async () => {
    await p.resize(720, 44)
    await p.send('tabs', snap('t17', twenty()))
    const shown = await p.page.$$eval('.tab:not([hidden])', (els) => els.map((e) => ({ id: (e as HTMLElement).dataset.id, w: e.getBoundingClientRect().width, right: e.getBoundingClientRect().right })))
    expect(shown.map((s) => s.id)).toContain('t17')
    const active = shown.find((s) => s.id === 't17')!
    expect(active.w).toBeGreaterThan(100)
    for (const s of shown) expect(s.w).toBeGreaterThanOrEqual(57.5)
    const more = await p.page.locator('#more')
    expect(await more.isVisible()).toBe(true)
    const hidden = 20 - shown.length
    expect(await more.getAttribute('aria-label')).toBe(`${hidden} more canvases`)
    expect(await more.getAttribute('aria-haspopup')).toBe('menu')
    const moreBox = (await more.boundingBox())!
    for (const s of shown) expect(s.right).toBeLessThanOrEqual(moreBox.x)
    await more.click()
    const [m] = await p.calls('tabs:more') as { ids: string[] }[]
    expect(m.ids).toHaveLength(hidden)
    expect(m.ids).not.toContain('t17')
    expect(await p.page.locator('#tabs').ariaSnapshot()).not.toContain(`Canvas number ${m.ids[0].slice(1)}"`)
  })

  it('a tab chosen from » becomes visible once main makes it active', async () => {
    await p.send('tabs', snap('t17', twenty()))
    const [first] = await p.page.$$eval('.tab[hidden]', (els) => els.map((e) => (e as HTMLElement).dataset.id))
    await p.send('tabs', snap(first!, twenty()))
    expect(await p.page.isVisible(`[data-id="${first}"]`)).toBe(true)
    await p.resize(1280, 44)
  })
})

describe('the one pill (A2.2)', () => {
  const stopped: PillView = { rev: 1, kind: 'stopped', lead: 'Stopped', text: '', short: 'Stopped', button: { label: 'npx marver dev', style: 'cmd' } }
  const files: PillView = { rev: 2, kind: 'files', lead: 'config.json', text: 'did not apply · using the last good one', short: 'Settings not applied', tooltip: 'config.json: restoreTabs must be true or false' }
  const test: PillView = { rev: 3, kind: 'test', text: 'A pill that can be dismissed', short: 'Dismissible', dismissible: true, button: { label: 'Do it', style: 'accent' } }

  it('draws words, one button and the tooltip, and acts on its own rev', async () => {
    await p.send('tabs', snap('t1', FOUR))
    await p.send('pill', files)
    expect(await p.page.locator('#pill').getAttribute('aria-label')).toBe('config.json did not apply · using the last good one')
    expect(await p.page.locator('#pill').getAttribute('title')).toBe('config.json: restoreTabs must be true or false')
    await p.send('pill', test)
    await p.page.click('#pill .pill-btn')
    expect(await p.calls('pill:action')).toEqual([{ rev: 3, act: 'button' }])
  })

  it('a command button copies through main (pill:action button)', async () => {
    await p.send('pill', { ...stopped, rev: 4 })
    expect(await p.page.locator('#pill .cmd').getAttribute('aria-label')).toBe('Copy the start command')
    await p.page.click('#pill .cmd')
    expect(await p.calls('pill:action')).toEqual([{ rev: 4, act: 'button' }])
  })

  it('a dismissible pill closes with its × ("Not now") and with Esc when focused', async () => {
    await p.send('pill', { ...test, rev: 5 })
    await p.page.click('#pill [aria-label="Not now"]')
    await p.page.focus('#pill .pill-btn')
    await p.page.keyboard.press('Escape')
    expect(await p.calls('pill:action')).toEqual([{ rev: 5, act: 'dismiss' }, { rev: 5, act: 'dismiss' }])
  })

  it('below 960 px each pill shows its short form, never an empty capsule; it never covers a tab', async () => {
    await p.resize(900, 44)
    await p.send('pill', { ...files, rev: 6 })
    expect(await p.page.locator('#pill').innerText()).toBe('Settings not applied')
    await p.send('pill', { ...stopped, rev: 7 })
    expect((await p.page.locator('#pill').innerText()).replace(/\s+/g, ' ').trim()).toBe('Stopped npx marver dev')
    const pill = (await p.page.locator('#pill').boundingBox())!
    for (const r of await p.page.$$eval('.tab:not([hidden])', (els) => els.map((e) => e.getBoundingClientRect().right))) expect(r).toBeLessThanOrEqual(pill.x)
    await p.resize(1280, 44)
    await p.send('pill', null)
    expect(await p.page.isHidden('#pill')).toBe(true)
  })
})

describe('the live region (A2.13)', () => {
  it('says a stop once - nothing for the state found at first - and a new pill', async () => {
    const q = await openPage('strip', { width: 1280, height: 44 })
    try {
      await q.send('tabs', { rev: 1, active: 't1', tabs: [home, tab('t1', 'One'), tab('t2', 'TMS broker', { state: 'gone' })] })
      await q.page.waitForTimeout(100)
      expect(await q.page.$eval('#live', (e) => e.textContent)).toBe('')
      await q.send('pill', null)
      await q.send('tabs', { rev: 2, active: 't1', tabs: [home, tab('t1', 'One', { state: 'gone' }), tab('t2', 'TMS broker', { state: 'gone' })] })
      await q.page.waitForFunction(() => document.getElementById('live')!.textContent === 'One stopped')
      await q.send('tabs', { rev: 3, active: 't1', tabs: [home, tab('t1', 'One'), tab('t2', 'TMS broker', { state: 'gone' })] })
      await q.send('tabs', { rev: 4, active: 't1', tabs: [home, tab('t1', 'One', { state: 'gone' }), tab('t2', 'TMS broker', { state: 'gone' })] })
      await q.page.waitForTimeout(100)
      expect(await q.page.$eval('#live', (e) => e.textContent)).toBe('One stopped')   // once per tab per minute
      await q.send('pill', { rev: 9, kind: 'confirmation', icon: 'check', text: 'Reloaded after a crash', short: 'Reloaded' })
      await q.page.waitForFunction(() => document.getElementById('live')!.textContent === 'Reloaded after a crash')
    } finally { await q.close() }
  })
})

describe('the look and the system settings (A2.2, A2.13, A2.14 #26)', () => {
  it('follows the active tab\'s own look', async () => {
    await p.send('tabs', snap('t1', [home, tab('t1', 'Dark one', { dark: true }), tab('t2', 'Light one', { dark: false })]))
    expect(await p.page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)
    await p.send('tabs', snap('t2', [home, tab('t1', 'Dark one', { dark: true }), tab('t2', 'Light one', { dark: false })]))
    expect(await p.page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false)
  })

  it('Reduce Transparency and Increase Contrast: the active tab and the pill opaque, their borders solid', async () => {
    await p.send('tabs', snap('t1', FOUR))
    await p.send('pill', { rev: 20, kind: 'files', text: 'x', short: 'x' })
    const look = () => p.page.evaluate(() => ['.tab.on', '#pill'].map((s) => {
      const cs = getComputedStyle(document.querySelector(s)!)
      return [cs.backgroundColor, cs.borderTopColor]
    }))
    const alpha = (c: string) => { const m = /rgba?\(([^)]+)\)/.exec(c)!; const v = m[1].split(',').map((x) => x.trim()); return v.length === 4 ? Number(v[3]) : 1 }
    const plain = await look()
    expect(alpha(plain[0][0])).toBeLessThan(1)
    for (const features of [{ 'prefers-reduced-transparency': 'reduce' }, { 'prefers-contrast': 'more' }] as Record<string, string>[]) {
      await p.media(features)
      for (const [bg, brd] of await look()) { expect(alpha(bg), JSON.stringify(features)).toBe(1); expect(alpha(brd)).toBe(1) }
    }
    await p.media({})
  })

  it('Reduce Motion: every running animation animates opacity only (the spinner pulses)', async () => {
    await p.send('tabs', snap('t1', FOUR))   // Tidewell starting: a spinner
    const before = await animatedProperties(p.page)
    expect(before.some((a) => a.props.includes('transform'))).toBe(true)
    await p.media({ 'prefers-reduced-motion': 'reduce' })
    await p.page.waitForTimeout(50)
    const after = await animatedProperties(p.page)
    expect(after.length).toBeGreaterThan(0)
    for (const a of after) expect(a.props, a.name).toEqual(['opacity'])
    await p.media({})
  })

  it('loads under the app pages\' CSP with nothing refused', async () => {
    expect(await p.csp()).toEqual([])
  })
})
