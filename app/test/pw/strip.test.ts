/**
 * The strip (spec 28 A2.2, A2.4, A2.13, A2.14 #19, #26; spec 32 Part A, B's strip side, C10): the real page and the real
 * app preload under a fake main (test/harness/pages.ts), windowless. The tab list's ARIA and keyboard model, option D's
 * markup, geometry, widths, compact tabs and `»`, its looks in light and dark, the key, the marks, the logos and the
 * states, the strip on Home; the Marver menu as the strip draws it (the case plays main: it answers an ask with a
 * `tab-menu` view and grows the view with `resize()`); the one pill and its short form, the live region, revisions,
 * immersive play's class and the system settings followed live.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MOTION } from '../../../src/shared/immersive.ts'
import type { PillView, TabMenuView, TabsSnapshot, TabView } from '../../src/shared/channels.ts'
import { animatedProperties, openPage, type PageRun } from '../harness/pages.ts'

const home: TabView = { id: 'h', kind: 'home', name: 'Home', state: 'live', verified: true, open: true }
const tab = (id: string, name: string, over: Partial<TabView> = {}): TabView =>
  ({ id, kind: 'local', name, state: 'live', verified: true, open: true, link: `http://localhost:${4900 + Number(id.slice(1))}/`, ...over })
let rev = 0
const snap = (active: string, tabs: TabView[]): TabsSnapshot => ({ rev: ++rev, active, tabs })

// t3's slot file names a canvas, but its proof failed: the strip names it by its address, never that name (A2.13)
const FOUR = [home, tab('t1', 'Marver Platform', { key: 1 }), tab('t2', 'TMS broker', { key: 2, state: 'gone' }), tab('t3', 'Hertz dealer', { key: 3, state: 'unverified', link: 'http://localhost:4808/' }), tab('t4', 'Tidewell', { key: 9, state: 'starting' })]

let p: PageRun
const readyCalls: unknown[] = []
beforeAll(async () => {
  p = await openPage('strip', { width: 1280, height: 44 })
  readyCalls.push(...await p.calls('app:ready'))
})
afterAll(async () => { await p?.close() })
// every case starts with no menu (main's close, or a refusal: the marks go), a 44 px view, the pointer off the tabs
beforeEach(async () => {
  await p.send('tab-menu', null)
  await p.resize(1280, 44)
  await p.page.mouse.move(2, 40)
  await p.clear()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** every running CSS transition and finite animation finished (the widths, the fades, the menu's pop): what the eye
 *  reads once it settles. The spinner's and the sweep's infinite animations are not waited on */
const settle = (q: PageRun = p) => q.page.evaluate(async () => {
  for (let i = 0; i < 3; i++) {
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  }
})
const show = async (s: TabsSnapshot) => { await p.send('tabs', s); await settle() }
async function poll<T>(what: string, f: () => Promise<T>, ms = 3000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}
const box = async (sel: string) => { await settle(); return (await p.page.locator(sel).boundingBox())! }
/** a computed value of `value` for `prop` here (a token resolved as the page resolves it) */
const resolved = (prop: string, value: string, sel = '#tabs') => p.page.evaluate(([pr, v, s]) => {
  const d = document.createElement('i')
  document.querySelector(s)!.append(d)
  d.style.setProperty(pr, v)
  const out = getComputedStyle(d).getPropertyValue(pr)
  d.remove()
  return out
}, [prop, value, sel] as const)

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
      'activate', 'close', 'kind', 'menuPick', 'menuShown', 'more', 'onPageFocus', 'onPill', 'onTabMenu', 'onTabs', 'onWindow', 'openLink', 'pillAction', 'ready', 'tabMenu',
    ])
  })

  it('the window: dimmed in the background, no traffic-light room in full screen', async () => {
    await p.send('window', { rev: 1, focused: false, fullScreen: true })
    expect(await p.page.evaluate(() => [...document.body.classList].sort())).toEqual(['fullscreen', 'inactive'])
    expect(await p.page.$eval('.strip', (e) => getComputedStyle(e).paddingLeft)).toBe('10px')
    await p.send('window', { rev: 2, focused: true, fullScreen: false })
    expect(await p.page.$eval('.strip', (e) => getComputedStyle(e).paddingLeft)).toBe('82px')
  })

  it('the still dots only while main says app 0.1\'s cover covers (A3.8 #3, #29): controls alone otherwise', async () => {
    const bg = () => p.page.$eval('.strip', (e) => getComputedStyle(e).backgroundImage)
    expect(await bg()).toBe('none')
    await p.send('window', { rev: 3, focused: true, fullScreen: false, dots: true })
    expect(await bg()).toMatch(/^radial-gradient/)
    expect(await p.page.$eval('.strip', (e) => [getComputedStyle(e).backgroundSize, getComputedStyle(e).backgroundPosition, getComputedStyle(e).backgroundColor])).toEqual(['20px 20px', '0px 0px', 'rgba(0, 0, 0, 0)'])
    await p.send('window', { rev: 4, focused: true, fullScreen: false, dots: false })
    expect(await bg()).toBe('none')
    await p.send('window', { rev: 5, focused: true, fullScreen: false })   // absent reads false
    expect(await bg()).toBe('none')
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
    expect(await p.calls('tab:activate')).toEqual([{ id: 't1', via: 'key' }, { id: 't2', via: 'key' }])
  })

  it('Delete and Backspace close the focused tab, never Home; ⇧F10 and the context-menu key open its menu at the tab', async () => {
    await show(snap('t1', FOUR))
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
    const b = await p.page.locator('[data-id="t3"]').boundingBox()
    // A14, B3.1: at the tab's left and bottom, by key, the strip holding focus
    const at = { id: 't3', x: Math.round(b!.x), y: Math.round(b!.y + b!.height), key: true, hadFocus: true }
    expect(menus).toEqual([at, at])
  })

  it('a click activates; a right-click opens the tab\'s menu where it was made', async () => {
    await show(snap('t1', FOUR))
    const before = await p.page.locator('[data-id="t4"]').boundingBox()
    await p.page.click('[data-id="t2"]')
    await p.page.click('[data-id="t4"]', { button: 'right', position: { x: 10, y: 10 } })
    await settle()
    expect(await p.calls('tab:activate')).toEqual([{ id: 't2' }])
    const box = await p.page.locator('[data-id="t4"]').boundingBox()
    expect(box).toEqual(before)   // hovering a tab shows its key in its badge's place: nothing moves
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

describe('fitting (A2.2, A2.14 #19; spec 32 A3, A4)', () => {
  const twenty = () => [home, ...Array.from({ length: 20 }, (_, i) => tab(`t${i + 1}`, `Canvas number ${i + 1}`, { key: i < 8 ? i + 1 : i === 19 ? 9 : undefined }))]

  it('every tab at most 176 px while they fit: no »', async () => {
    await show(snap('t1', FOUR))
    expect(await p.page.isHidden('#more')).toBe(true)
    const w = await p.page.$$eval('.tab', (els) => els.map((e) => e.getBoundingClientRect().width))
    for (const x of w) expect(x).toBeLessThanOrEqual(176)
  })

  it('twenty canvases at 720 px: the active one shown, none under 84 px, the others behind » named for what it holds', async () => {
    await p.resize(720, 44)
    await show(snap('t17', twenty()))
    const shown = await p.page.$$eval('.tab:not([hidden])', (els) => els.map((e) => ({ id: (e as HTMLElement).dataset.id, w: e.getBoundingClientRect().width, right: e.getBoundingClientRect().right })))
    expect(shown.map((s) => s.id)).toContain('t17')
    for (const s of shown) expect(s.w).toBeGreaterThanOrEqual(83.5)
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
    await p.resize(720, 44)
    await show(snap('t17', twenty()))
    const [first] = await p.page.$$eval('.tab[hidden]', (els) => els.map((e) => (e as HTMLElement).dataset.id))
    await show(snap(first!, twenty()))
    expect(await p.page.isVisible(`[data-id="${first}"]`)).toBe(true)
  })

  it('shared canvases behind » count as canvases; each is named "<host>, shared canvas" (A4.6 #39, #51)', async () => {
    const remote = (id: string, host: string): TabView => ({ id, kind: 'remote', name: host, state: 'live', verified: false, open: true, link: `https://${host}/`, hue: 3 })
    await p.resize(720, 44)
    await show(snap('t1', [...twenty(), remote('t21', 'pilot.example.com'), { ...remote('t22', 'other.example.org'), state: 'unreachable' }]))
    const hidden = await p.page.$$eval('.tab[hidden]', (els) => els.map((e) => (e as HTMLElement).dataset.id))
    expect(hidden).toEqual(expect.arrayContaining(['t21', 't22']))
    expect(await p.page.getAttribute('#more', 'aria-label')).toBe(`${hidden.length} more canvases`)
    expect(await p.page.getAttribute('[data-id="t21"]', 'aria-label')).toBe('pilot.example.com, shared canvas')
    expect(await p.page.getAttribute('[data-id="t22"]', 'aria-label')).toBe('other.example.org, shared canvas, can\'t be reached')
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

  it('a command button, named for the active tab, copies through main (pill:action button) and never claims "Copied"', async () => {
    await p.send('tabs', snap('t1', FOUR))
    await p.send('pill', { ...stopped, rev: 4 })
    expect(await p.page.locator('#pill .cmd').getAttribute('aria-label')).toBe('Copy the start command for Marver Platform')
    await p.page.click('#pill .cmd')
    expect(await p.calls('pill:action')).toEqual([{ rev: 4, act: 'button' }])
    // a send has no answer, and main refuses an old rev: the button cannot know it copied
    await p.page.waitForTimeout(50)
    expect(await p.page.locator('#pill .cmd').innerText()).not.toContain('Copied')
  })

  it('a dismissible pill closes with its × ("Not now") and with Esc when focused', async () => {
    await p.send('pill', { ...test, rev: 5 })
    await p.page.click('#pill [aria-label="Not now"]')
    await p.page.focus('#pill .pill-btn')
    await p.page.keyboard.press('Escape')
    expect(await p.calls('pill:action')).toEqual([{ rev: 5, act: 'dismiss' }, { rev: 5, act: 'dismiss', via: 'key' }])
  })

  it('below 960 px each pill shows its short form, never an empty capsule; it never covers a tab', async () => {
    await p.resize(900, 44)
    await p.send('pill', { ...files, rev: 6 })
    expect(await p.page.locator('#pill').innerText()).toBe('Settings not applied')
    await p.send('pill', { ...stopped, rev: 7 })
    await settle()
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

describe('the live region: only what a sighted person would notice (A2.13)', () => {
  const live = (q: PageRun) => q.page.$eval('#live', (e) => e.textContent)

  it('a closed tab\'s stop says nothing (the strip does not show it); a shown one\'s does', async () => {
    const q = await openPage('strip', { width: 1280, height: 44 })
    try {
      await q.send('tabs', { rev: 1, active: 't1', tabs: [home, tab('t1', 'One'), tab('t2', 'Closed one', { open: false })] })
      await q.send('pill', null)
      await q.send('tabs', { rev: 2, active: 't1', tabs: [home, tab('t1', 'One'), tab('t2', 'Closed one', { open: false, state: 'gone' })] })
      await q.page.waitForTimeout(100)
      expect(await live(q)).toBe('')
      await q.send('tabs', { rev: 3, active: 't1', tabs: [home, tab('t1', 'One', { state: 'crashed' }), tab('t2', 'Closed one', { open: false, state: 'gone' })] })
      await q.page.waitForFunction(() => document.getElementById('live')!.textContent === 'One crashed')
    } finally { await q.close() }
  })

  it('a stop and a pill that arrive together are both said, in order', async () => {
    const q = await openPage('strip', { width: 1280, height: 44 })
    try {
      await q.send('tabs', { rev: 1, active: 't1', tabs: [home, tab('t1', 'One')] })
      await q.send('pill', null)
      await q.page.evaluate(() => new Promise((r) => setTimeout(r, 50)))
      await q.app.evaluate(() => {
        const g = (globalThis as unknown as { __pages: { send(c: string, p: unknown): void } }).__pages
        g.send('tabs', { rev: 2, active: 't1', tabs: [{ id: 'h', kind: 'home', name: 'Home', state: 'live', verified: true, open: true }, { id: 't1', kind: 'local', name: 'One', state: 'gone', verified: true, open: true, link: 'http://localhost:4901/' }] })
        g.send('pill', { rev: 1, kind: 'stopped', lead: 'Stopped', text: '', short: 'Stopped', button: { label: 'npx marver dev', style: 'cmd' } })
      })
      await q.page.waitForFunction(() => document.getElementById('live')!.textContent === 'One stopped. Stopped')
    } finally { await q.close() }
  })

  it('with no null pill at ready: one with the first snapshot is the launch state, a later first pill is said', async () => {
    const q = await openPage('strip', { width: 1280, height: 44 })
    try {
      await q.send('tabs', { rev: 1, active: 't1', tabs: [home, tab('t1', 'One')] })
      await q.page.waitForTimeout(1100)
      await q.send('pill', { rev: 1, kind: 'files', lead: 'config.json', text: 'did not apply · using the last good one', short: 'Settings not applied' })
      await q.page.waitForFunction(() => document.getElementById('live')!.textContent === 'config.json did not apply · using the last good one')
    } finally { await q.close() }
    const r = await openPage('strip', { width: 1280, height: 44 })
    try {
      await r.send('tabs', { rev: 1, active: 't1', tabs: [home, tab('t1', 'One')] })
      await r.send('pill', { rev: 1, kind: 'files', lead: 'config.json', text: 'did not apply · using the last good one', short: 'Settings not applied' })
      await r.page.waitForTimeout(150)
      expect(await live(r)).toBe('')
    } finally { await r.close() }
  })
})

describe('the look and the system settings (A2.2, A2.13, A2.14 #26)', () => {
  it('follows the active tab\'s own look', async () => {
    await p.send('tabs', snap('t1', [home, tab('t1', 'Dark one', { dark: true }), tab('t2', 'Light one', { dark: false })]))
    expect(await p.page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)
    await p.send('tabs', snap('t2', [home, tab('t1', 'Dark one', { dark: true }), tab('t2', 'Light one', { dark: false })]))
    expect(await p.page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false)
  })

  it('Reduce Transparency and Increase Contrast (A13): the active face and the pill opaque, their borders solid, no rim', async () => {
    await show(snap('t1', FOUR))
    await p.send('pill', { rev: 20, kind: 'files', text: 'x', short: 'x' })
    const look = () => p.page.evaluate(() => ['.tab.on .face', '#pill'].map((s) => {
      const cs = getComputedStyle(document.querySelector(s)!)
      return [cs.backgroundColor, cs.borderTopColor]
    }))
    const alpha = (c: string) => { const m = /rgba?\(([^)]+)\)/.exec(c)!; const v = m[1].split(',').map((x) => x.trim()); return v.length === 4 ? Number(v[3]) : 1 }
    const plain = await look()
    expect(alpha(plain[1][0])).toBeLessThan(1)   // the pill's glass; D's active face is the opaque panel look already
    for (const features of [{ 'prefers-reduced-transparency': 'reduce' }, { 'prefers-contrast': 'more' }] as Record<string, string>[]) {
      await p.media(features)
      await settle()
      for (const [bg, brd] of await look()) { expect(alpha(bg), JSON.stringify(features)).toBe(1); expect(alpha(brd)).toBe(1) }
      expect(await p.page.$eval('.tab.on .face', (e) => getComputedStyle(e, '::after').display)).toBe('none')
      expect(await p.page.$eval('.tab.on .face', (e) => getComputedStyle(e).backgroundColor)).toBe(await resolved('background-color', 'var(--solid)'))
    }
    await p.media({})
    await p.send('pill', null)
  })

  it('A13 in dark: the active face takes --solid and --node-brd there too (the dark .2 hairline does not win), no rim', async () => {
    await show(snap('t1', [home, tab('t1', 'Dark one', { dark: true }), tab('t2', 'Other')]))
    expect(await p.page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)
    for (const features of [{ 'prefers-reduced-transparency': 'reduce' }, { 'prefers-contrast': 'more' }] as Record<string, string>[]) {
      await p.media(features)
      await settle()
      expect(await p.page.$eval('.tab.on .face', (e) => { const cs = getComputedStyle(e); return [cs.backgroundColor, cs.borderTopColor, getComputedStyle(e, '::after').display] }), JSON.stringify(features))
        .toEqual([await resolved('background-color', 'var(--solid)'), await resolved('border-top-color', 'var(--node-brd)'), 'none'])
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

  it('E7: a keyboard-focused tab always shows a ring: on its face when it has one, else base.css\'s on the tab; light and dark', async () => {
    const ring = () => p.page.evaluate(() => {
      const t = document.activeElement as HTMLElement
      const face = t.querySelector<HTMLElement>(':scope > .face')
      const read = (e: Element) => { const cs = getComputedStyle(e); return { outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, shadow: cs.boxShadow } }
      return { id: t.dataset.id, visible: t.matches(':focus-visible'), tab: read(t), face: face ? read(face) : null }
    })
    for (const dark of [false, true]) {
      await p.send('tabs', snap('t1', [home, tab('t1', 'Marver Platform', { key: 1, dark }), tab('t2', 'TMS broker', { key: 2 })]))
      await p.page.focus('[data-id="t1"]')
      await p.page.keyboard.press('ArrowRight')
      await settle()
      const r = await ring()
      expect(r).toMatchObject({ id: 't2', visible: true })
      const holder = r.face ?? r.tab
      expect(holder.outline).toBe('solid 1px rgb(0, 136, 255)')
      expect(holder.shadow.startsWith(dark ? 'rgba(0, 136, 255, 0.32) 0px 0px 0px 4px' : 'rgba(0, 136, 255, 0.2) 0px 0px 0px 4px')).toBe(true)
      if (r.face) expect(r.tab).toEqual({ outline: expect.stringMatching(/^none /), shadow: 'none' })
    }
  })

  it('loads under the app pages\' CSP with nothing refused', async () => {
    expect(await p.csp()).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Spec 32 Part A: option D

/** a tab's face and what it holds, measured: the face's content box, each child's rect, the logo's and badge's insets */
const faceOf = (id: string) => p.page.$eval(`[data-id="${id}"]`, (t) => {
  const face = t.querySelector<HTMLElement>(':scope > .face')!
  const f = face.getBoundingClientRect()
  const cs = getComputedStyle(face)
  const content = { left: f.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), right: f.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) }
  const kids = [...face.querySelectorAll<HTMLElement>('.slot, .name, .end, .end > *')].filter((k) => getComputedStyle(k).display !== 'none' && k.getBoundingClientRect().width > 0)
  const slot = t.querySelector('.slot')!.getBoundingClientRect()
  const badge = t.querySelector<HTMLElement>('.end > .mk.ask')
  const name = t.querySelector<HTMLElement>('.name')!
  const text = document.createRange()
  text.selectNodeContents(name)
  return {
    width: t.getBoundingClientRect().width, faceH: f.height, compact: t.classList.contains('compact'), on: t.classList.contains('on'),
    nameShown: getComputedStyle(name).display !== 'none', nameCut: text.getBoundingClientRect().width > name.getBoundingClientRect().width + 0.5,
    logoLeft: slot.left - f.left, badgeRight: badge ? f.right - badge.getBoundingClientRect().right : null,
    outside: kids.filter((k) => { const r = k.getBoundingClientRect(); return r.left < content.left - 0.5 || r.right > content.right + 0.5 }).map((k) => k.className),
  }
})
const shownIds = () => p.page.$$eval('#tabs .tab:not([hidden])', (els) => els.map((e) => (e as HTMLElement).dataset.id!))

describe('option D: markup and geometry (spec 32 A1, A2, A12)', () => {
  it('a tab holds its width; its face holds the slot, the name and the end cell (the badge, then the key only with a key)', async () => {
    await show(snap('t1', [home, tab('t1', 'Pilot', { key: 1, marks: { needs: 3, unseen: 0, working: false, session: false } }), tab('t2', 'No key', { marks: { needs: 0, unseen: 2, working: false, session: false } }), tab('t3', 'Plain', { key: 3 })]))
    const kids = (id: string) => p.page.$eval(`[data-id="${id}"]`, (e) => ({
      tab: [...e.children].map((c) => c.className), face: [...e.querySelector('.face')!.children].map((c) => c.className),
      end: [...e.querySelector('.end')!.children].map((c) => `${c.tagName.toLowerCase()}.${c.className}`), slot: [...e.querySelector('.slot')!.children].map((c) => c.className),
    }))
    expect(await kids('t1')).toEqual({ tab: ['face'], face: ['slot', 'name', 'end'], end: ['span.mk ask', 'kbd.key'], slot: ['logo round'] })
    expect((await kids('t2')).end).toEqual(['span.mk new dot'])
    expect((await kids('t3')).end).toEqual(['kbd.key'])
    expect(await p.page.$eval('[data-id="t1"] kbd.key', (e) => e.textContent)).toBe('⌘1')
    // the ids main's capture hooks and the native click tests read
    expect(await p.page.evaluate(() => ['strip', 'tabs', 'more', 'pill'].every((id) => !!document.getElementById(id)))).toBe(true)
    // sizes and widths through CSSOM only (style-src 'self'): no style attribute is ever parsed, so nothing is refused
    expect(await p.csp()).toEqual([])
  })

  it('A2: the 32 px face, the 24 px round slot, the 18 px badge, gap 4, Home 30 px with margin 6 (10 px to the first tab)', async () => {
    await show(snap('t1', [home, tab('t1', 'Pilot', { key: 1, marks: { needs: 3, unseen: 0, working: false, session: false } }), tab('t2', 'Tidewell', { key: 2 })]))
    const g = await p.page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect()
      const cs = (s: string) => getComputedStyle(document.querySelector(s)!)
      return {
        gap: cs('#tabs').columnGap, homeMargin: cs('.home').marginRight, home: [r('.home').width, r('.home').height, cs('.home').borderRadius],
        toFirst: r('[data-id="t1"]').left - r('.home').right, between: r('[data-id="t2"]').left - r('[data-id="t1"]').right,
        tab: r('[data-id="t1"]').height, face: [r('[data-id="t1"] .face').height, cs('[data-id="t1"] .face').borderRadius, cs('[data-id="t1"] .face').paddingLeft, cs('[data-id="t1"] .face').paddingRight],
        slot: [r('[data-id="t1"] .slot').width, r('[data-id="t1"] .slot').height], logo: [r('[data-id="t1"] .logo').width, cs('[data-id="t1"] .logo').borderRadius],
        initials: [cs('[data-id="t1"] .logo b').fontSize, cs('[data-id="t1"] .logo b').fontWeight, cs('[data-id="t1"] .logo b').color],
        badge: [r('[data-id="t1"] .mk').height, cs('[data-id="t1"] .mk').minWidth, cs('[data-id="t1"] .mk').fontSize],
        key: [r('[data-id="t1"] .key').height / 0.92, cs('[data-id="t1"] .key').opacity],
        font: [cs('[data-id="t1"]').fontSize, cs('[data-id="t1"]').fontWeight],
      }
    })
    expect(g).toMatchObject({ gap: '4px', homeMargin: '6px', home: [30, 30, '50%'], tab: 32, face: [32, '999px', '3px', '6px'], slot: [24, 24], logo: [24, '50%'],
      initials: ['10px', '700', 'rgb(255, 255, 255)'], font: ['12.5px', '500'] })
    expect(g.toFirst).toBeCloseTo(10, 1)
    expect(g.between).toBeCloseTo(4, 1)
    expect(g.badge).toEqual([18, '18px', '10.5px'])
    expect(g.key[0]).toBeCloseTo(18, 1)
    expect(g.key[1]).toBe('0')
    // the concentric rule (06:15): the logo 4 px from the face's left, the badge 7 px from its right
    const f = await faceOf('t1')
    expect(f.logoLeft).toBeCloseTo(4, 1)
    expect(f.badgeRight!).toBeCloseTo(7, 1)
    // the new-frames dot: 12 px from the face's end
    await show(snap('t1', [home, tab('t1', 'Pilot', { marks: { needs: 0, unseen: 2, working: false, session: false } })]))
    expect(await p.page.evaluate(() => { const f = document.querySelector('[data-id="t1"] .face')!.getBoundingClientRect(); const d = document.querySelector('[data-id="t1"] .mk')!.getBoundingClientRect(); return [d.width, d.height, f.right - d.right] })).toEqual([8, 8, 12])
  })

  it('A12: a pointer on a tab and everything in it, on Home and on »; tabs, Home and » are no-drag, the body the drag region', async () => {
    await p.resize(720, 44)
    await show(snap('t1', [home, ...Array.from({ length: 12 }, (_, i) => tab(`t${i + 1}`, `Canvas ${i + 1}`, { key: i < 8 ? i + 1 : undefined, marks: { needs: 2, unseen: 0, working: false, session: false } }))]))
    const cur = await p.page.evaluate(() => ['.tab', '.tab .face', '.tab .name', '.tab .slot', '.tab .logo b', '.tab .mk', '.home', '.home svg', '#more', '#more span'].map((s) => [s, getComputedStyle(document.querySelector(s)!).cursor]))
    for (const [s, c] of cur) expect(c, s).toBe('pointer')
    const region = await p.page.evaluate(() => ['body', '.tab', '.home', '#more'].map((s) => getComputedStyle(document.querySelector(s)!).getPropertyValue('-webkit-app-region')))
    expect(region).toEqual(['drag', 'no-drag', 'no-drag', 'no-drag'])
  })
})

describe('option D: widths, compact tabs and » (spec 32 A2, A3, A4)', () => {
  const names = ['Marver Platform', 'TMS broker', 'Tidewell launch deck review', 'Hertz dealer', 'Gen lab', 'Asteria notes', 'Field study', 'Pricing page', 'Onboarding flow', 'Brand refresh', 'Weekly review', 'Studio site']
  const many = (n: number, over: (i: number) => Partial<TabView> = () => ({})) => [home, ...Array.from({ length: n }, (_, i) => tab(`t${i + 1}`, names[i % names.length], {
    key: i < 8 ? i + 1 : i === n - 1 ? 9 : undefined, marks: { needs: i % 3 === 0 ? 120 : 0, unseen: i % 3 === 1 ? 2 : 0, working: false, session: false }, ...over(i),
  }))]

  for (const w of [1280, 720]) {
    for (const n of [1, 3, 7, 12]) {
      it(`${n} tab${n > 1 ? 's' : ''} at ${w}: one width for the inactive ones, 84-176, the active one's only when its name is cut (up to 260), compact exactly under 104, every child inside its face`, async () => {
        await p.resize(w, 44)
        for (const active of ['t2', 't3']) {   // t2's name fits; t3's ("Tidewell launch deck review") is cut at 176
          const a = n === 1 ? 't1' : n < 3 ? 't2' : active
          await show(snap(a, many(n)))
          const ids = await shownIds()
          const geo = await Promise.all(ids.map(faceOf))
          const others = geo.filter((g) => !g.on)
          const on = geo.find((g) => g.on)!
          const tw = others.length ? others[0].width : on.width
          for (const g of others) { expect(g.width).toBeCloseTo(tw, 1); expect(g.width).toBeLessThanOrEqual(176.01); expect(g.width).toBeGreaterThanOrEqual(83.99) }
          expect(on.width).toBeLessThanOrEqual(260.01)
          // widened for a cut name: to its whole name, unless 260 or the room the others' 84 px leave stops it first
          const room = await p.page.evaluate((k) => document.getElementById('tabs')!.clientWidth - (document.querySelector('.home') as HTMLElement).offsetWidth - 10 - 4 * (k - 1), geo.length)
          if (on.width > tw + 0.5 && on.nameCut) expect(on.width, `${a} stopped by a cap`).toBeCloseTo(Math.min(260, room - (geo.length - 1) * 84), 0)
          for (const g of geo) {
            expect(g.faceH).toBe(32)
            expect(g.compact, `compact at ${g.width}`).toBe(g.width < 104)
            expect(g.nameShown).toBe(!g.compact)
            expect(g.logoLeft).toBeCloseTo(4, 1)
            if (g.badgeRight !== null) expect(g.badgeRight).toBeCloseTo(7, 1)
            expect(g.outside, 'every child inside the face').toEqual([])
          }
          // stable: a second snapshot of the same tabs gives the same widths (no measure drift)
          await show(snap(a, many(n)))
          expect(await Promise.all((await shownIds()).map(async (id) => (await faceOf(id)).width))).toEqual(geo.map((g) => g.width))
        }
        // with the key shown (a hover), the 99+ badge's tab and a keyed tab still hold every child inside the face
        const first = (await shownIds())[0]
        await p.page.hover(`[data-id="${first}"]`)
        await settle()
        expect(await p.page.$eval(`[data-id="${first}"] .key`, (e) => getComputedStyle(e).opacity)).toBe('1')
        expect((await faceOf(first)).outside).toEqual([])
        await p.page.mouse.move(2, 40)
      })
    }
  }

  it('the active tab widens for a cut name, to its whole name; a name that fits keeps the shared width', async () => {
    await p.resize(1280, 44)
    await show(snap('t1', [home, tab('t1', 'A canvas with a name far longer than the shared width'), tab('t2', 'Short'), tab('t3', 'Also short')]))
    const on = await faceOf('t1')
    expect(on.width).toBe(260)
    expect((await faceOf('t2')).width).toBe(176)
    await show(snap('t1', [home, tab('t1', 'Tidewell launch deck review'), tab('t2', 'Short'), tab('t3', 'Also short')]))
    const g = await faceOf('t1')
    expect(g.width).toBeGreaterThan(176)
    expect(g.width).toBeLessThan(260)
    expect(g.nameCut).toBe(false)
    await show(snap('t2', [home, tab('t1', 'Tidewell launch deck review'), tab('t2', 'Short'), tab('t3', 'Also short')]))
    expect((await faceOf('t2')).width).toBe(176)
    expect((await faceOf('t1')).nameCut).toBe(true)   // inactive: cut at the shared width
  })

  it('compact under 104 px at 1280 with 12 tabs: no name, the logo 4 px from the left and the badge 7 px from the right, never centred; the name still read', async () => {
    await p.resize(1280, 44)
    await show(snap('t1', many(12)))
    const geo = await Promise.all((await shownIds()).map(faceOf))
    expect(geo.filter((g) => !g.on).every((g) => g.compact)).toBe(true)
    for (const g of geo.filter((x) => x.compact)) { expect(g.logoLeft).toBeCloseTo(4, 1); if (g.badgeRight !== null) expect(g.badgeRight).toBeCloseTo(7, 1) }
    expect(await p.page.getAttribute('[data-id="t4"]', 'aria-label')).toBe('Hertz dealer, 120 need you')
  })

  it('a resize of the height alone (44 to 800 and back) refits nothing and keeps a focused pill button; the width refits', async () => {
    await p.resize(1280, 44)
    await show(snap('t1', many(7)))
    await p.send('pill', { rev: 40, kind: 'test', text: 'A pill with a button', short: 'Pill', dismissible: true, button: { label: 'Do it', style: 'accent' } })
    await settle()
    await p.page.focus('#pill .pill-btn')
    await p.page.evaluate(() => {
      const w = window as unknown as { muts: number }
      w.muts = 0
      new MutationObserver((r) => { w.muts += r.length }).observe(document.getElementById('strip')!, { subtree: true, attributes: true, childList: true })
    })
    const muts = () => p.page.evaluate(() => (window as unknown as { muts: number }).muts)
    await p.resize(1280, 800)
    await settle()
    await p.resize(1280, 44)
    await settle()
    expect(await muts()).toBe(0)
    expect(await p.page.evaluate(() => document.activeElement?.className)).toBe('pill-btn')
    await p.resize(1100, 44)
    await settle()
    expect(await muts()).toBeGreaterThan(0)
    await p.resize(1280, 44)
    await p.send('pill', null)
  })

  it('A4: 20 tabs at 720: » shows with its count; a canvas tab active is never hidden and the first m - 1 others stay; with Home active the first m', async () => {
    const twenty = many(20)
    await p.resize(720, 44)
    const m = async () => {
      const r = await p.page.evaluate(() => ({ W: document.getElementById('tabs')!.clientWidth, home: (document.querySelector('.home') as HTMLElement).offsetWidth }))
      return Math.max(1, Math.floor((r.W - r.home - 10 + 4) / 88))
    }
    await show(snap('t17', twenty))
    const k = await m()
    const ids = await shownIds()
    expect(ids).toHaveLength(k)
    expect(ids).toEqual([...Array.from({ length: k - 1 }, (_, i) => `t${i + 1}`), 't17'])
    expect(await p.page.$eval('#more', (e) => [e.childNodes[0].textContent, e.querySelector('span')!.textContent])).toEqual(['»', String(20 - k)])
    expect(await p.page.getAttribute('#more', 'aria-label')).toBe(`${20 - k} more canvases`)
    for (const g of await Promise.all(ids.map(faceOf))) expect(g.width).toBeGreaterThanOrEqual(83.99)
    const more = await p.page.$eval('#more', (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return [r.width, r.height, cs.borderRadius, cs.backgroundColor, cs.fontSize, cs.columnGap, getComputedStyle(e.querySelector('span')!).fontSize] })
    expect(more).toEqual([30, 30, '50%', 'rgba(0, 0, 0, 0)', '12px', '2px', '11px'])
    const moreBox = await box('#more')
    for (const id of ids) expect((await box(`[data-id="${id}"]`)).x + (await box(`[data-id="${id}"]`)).width).toBeLessThanOrEqual(moreBox.x)
    // Home active (the strip on Home): the first m
    await show(snap('h', twenty))
    expect(await shownIds()).toEqual(Array.from({ length: k }, (_, i) => `t${i + 1}`))
    // the hover look: Home's
    await p.page.hover('#more')
    await settle()
    expect(await p.page.$eval('#more', (e) => getComputedStyle(e).backgroundColor)).toBe(await resolved('background-color', 'var(--glass-hover)'))
    await p.page.mouse.move(2, 40)
    await p.resize(1280, 44)
  })
})

describe('option D: the looks (spec 32 A5, A10, A13)', () => {
  const look = (sel: string) => p.page.$eval(sel, (e) => {
    const cs = getComputedStyle(e)
    const ring = getComputedStyle(e, '::after')
    return { bg: cs.backgroundColor, border: cs.borderTopColor, shadow: cs.boxShadow, color: cs.color, ring: ring.opacity, rim: ring.backgroundImage, rimShown: ring.content !== 'none' && ring.display !== 'none' }
  })
  const three = (dark: boolean) => snap('t1', [home, tab('t1', 'Active one', { key: 1, dark, marks: { needs: 2, unseen: 0, working: false, session: false } }), tab('t2', 'Hovered one', { key: 2, marks: { needs: 3, unseen: 0, working: false, session: false } }), tab('t3', 'Resting one', { key: 3 })])

  for (const dark of [false, true]) {
    it(`rest, hover, active and an open menu's opener, ${dark ? 'dark' : 'light'}: no backdrop filter anywhere`, async () => {
      await show(three(dark))
      const lit = await resolved('box-shadow', 'var(--ts-shadow-lit)')
      const rim = await resolved('background-image', dark ? 'var(--ts-edge-dark)' : 'var(--edge-light)')
      const brd = await resolved('border-top-color', 'var(--glass-brd)')
      const ink = await resolved('color', 'var(--glass-ink)')
      const ink2 = await resolved('color', 'var(--glass-ink-2)')
      // rest
      expect(await look('[data-id="t3"] .face')).toMatchObject({ bg: 'rgba(0, 0, 0, 0)', border: 'rgba(0, 0, 0, 0)', shadow: 'none', color: ink2, ring: '0' })
      // hover: the face lit (fill, hairline - .1 in dark -, the lift, the rim)
      await p.page.hover('[data-id="t2"]')
      await settle()
      const hover = { bg: dark ? 'rgb(38, 39, 45)' : 'rgba(231, 233, 239, 0.9)', border: dark ? 'rgba(255, 255, 255, 0.1)' : brd, shadow: lit, color: ink, ring: '1', rim }
      expect(await look('[data-id="t2"] .face')).toMatchObject(hover)
      // active, hovered or not: the panel look
      const active = { bg: dark ? 'rgb(16, 17, 22)' : 'rgb(246, 247, 249)', border: dark ? 'rgba(255, 255, 255, 0.2)' : brd, shadow: lit, color: ink, ring: '1', rim }
      expect(await look('[data-id="t1"] .face')).toMatchObject(active)
      await p.page.hover('[data-id="t1"]')
      await settle()
      expect(await look('[data-id="t1"] .face')).toMatchObject(active)
      await p.page.mouse.move(2, 40)
      // A5.5: a menu open on an inactive tab wears the hover face, its badge stays and no key shows; on the active one the panel look
      for (const [id, want] of [['t3', hover], ['t1', active]] as const) {
        const b = await box(`[data-id="${id}"]`)
        await p.send('tab-menu', { rev: ++mrev, x: Math.round(b.x), y: Math.round(b.y + b.height), kind: 'tab', rows: [{ kind: 'item', id: 'close', label: 'Close tab', icon: 'x', enabled: true }] } satisfies TabMenuView)
        await settle()
        expect(await p.page.$eval(`[data-id="${id}"]`, (e) => e.classList.contains('menu-open'))).toBe(true)
        expect(await look(`[data-id="${id}"] .face`)).toMatchObject(want)
        if (id === 't1') expect(await p.page.$eval('[data-id="t1"]', (e) => [getComputedStyle(e.querySelector('.mk')!).opacity, getComputedStyle(e.querySelector('.key')!).opacity])).toEqual(['1', '0'])
        await p.send('tab-menu', null)
        expect(await p.page.$eval(`[data-id="${id}"]`, (e) => e.classList.contains('menu-open'))).toBe(false)
      }
      expect(await p.page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => { const cs = getComputedStyle(e); return cs.backdropFilter !== 'none' && cs.backdropFilter !== '' }).length)).toBe(0)
    })

    it(`Home: rest, hover and on (the panel look, no rim; hover keeps it), and » open wears it, ${dark ? 'dark' : 'light'}`, async () => {
      await p.media({ 'prefers-color-scheme': dark ? 'dark' : 'light' })
      await show(snap('h', [home, tab('t1', 'One')]))
      const panel = dark ? 'rgb(16, 17, 22)' : 'rgb(246, 247, 249)'
      const on = { bg: panel, shadow: await resolved('box-shadow', '0 0 0 1px var(--glass-brd), var(--ts-shadow-lit)'), color: await resolved('color', 'var(--glass-ink)'), rimShown: false }
      expect(await look('.home')).toMatchObject(on)
      await p.page.hover('.home')
      await settle()
      expect(await look('.home')).toMatchObject(on)
      await show(snap('t1', [home, tab('t1', 'One')]))
      await p.page.hover('.home')
      await settle()
      expect(await look('.home')).toMatchObject({ bg: await resolved('background-color', 'var(--glass-hover)'), shadow: 'none' })
      await p.page.mouse.move(2, 40)
      await settle()
      expect(await look('.home')).toMatchObject({ bg: 'rgba(0, 0, 0, 0)', color: await resolved('color', 'var(--glass-ink-2)') })
      await p.send('tab-menu', { rev: ++mrev, x: 600, y: 40, kind: 'more', rows: [{ kind: 'item', id: 'tab:t9', label: 'Nine', enabled: true }] } satisfies TabMenuView)
      await settle()
      expect(await look('#more')).toMatchObject({ bg: panel, shadow: on.shadow })
      await p.send('tab-menu', null)
      await p.media({})
    })
  }

  it('the window in the background: tabs and Home .55, the active one .8 with no lift and its rim at .5', async () => {
    await show(three(false))
    await p.send('window', { rev: 60, focused: false, fullScreen: false })
    await settle()
    const r = await p.page.evaluate(() => ({
      tab: getComputedStyle(document.querySelector('[data-id="t2"]')!).opacity, home: getComputedStyle(document.querySelector('.home')!).opacity,
      on: getComputedStyle(document.querySelector('[data-id="t1"]')!).opacity, shadow: getComputedStyle(document.querySelector('[data-id="t1"] .face')!).boxShadow,
      ring: getComputedStyle(document.querySelector('[data-id="t1"] .face')!, '::after').opacity,
    }))
    expect(r).toEqual({ tab: '0.55', home: '0.55', on: '0.8', shadow: 'none', ring: '0.5' })
    await p.send('window', { rev: 61, focused: true, fullScreen: false })
  })

  it('A13: Home on solid under Reduce Transparency and Increase Contrast; Increase Contrast reads ink-2 and ink-3 as ink', async () => {
    await show(snap('h', [home, tab('t1', 'One', { key: 1 }), tab('t2', 'Stopped one', { state: 'gone' })]))
    for (const features of [{ 'prefers-reduced-transparency': 'reduce' }, { 'prefers-contrast': 'more' }] as Record<string, string>[]) {
      await p.media(features)
      await settle()
      expect(await look('.home'), JSON.stringify(features)).toMatchObject({ bg: await resolved('background-color', 'var(--solid)'), shadow: await resolved('box-shadow', '0 0 0 1px var(--node-brd), var(--ts-shadow-lit)') })
    }
    const ink = await resolved('color', 'var(--glass-ink)')
    expect(await p.page.evaluate(() => ['[data-id="t1"] .face', '[data-id="t1"] .key', '[data-id="t2"] .name', '.home'].map((s) => getComputedStyle(document.querySelector(s)!).color))).toEqual([ink, ink, ink, ink])
    await p.media({})
  })
})

describe('option D: the key, the marks, the logos and the states (spec 32 A6, A7, A8, A9, A11)', () => {
  const mk = (o: Partial<NonNullable<TabView['marks']>>) => ({ needs: 0, unseen: 0, working: false, session: false, ...o })
  const opacity = (sel: string) => p.page.$eval(sel, (e) => getComputedStyle(e).opacity)

  it('A6: hovering a keyed tab gives its badge\'s place to ⌘N, never both; a tab with no key (the tenth, Settings) draws none and keeps its badge; nothing moves', async () => {
    const ten = [home, ...Array.from({ length: 10 }, (_, i) => tab(`t${i + 1}`, `Canvas ${i + 1}`, { key: i < 8 ? i + 1 : i === 9 ? 9 : undefined, marks: mk({ needs: i + 1 }) })),
      { id: 'settings', kind: 'settings', name: 'Settings', state: 'hidden', verified: false, open: true } as TabView]
    await show(snap('t1', ten))
    const before = await box('[data-id="t2"]')
    await p.page.hover('[data-id="t2"]')
    await settle()
    expect([await opacity('[data-id="t2"] .mk'), await opacity('[data-id="t2"] .key'), await p.page.$eval('[data-id="t2"] .mk', (e) => getComputedStyle(e).transform)]).toEqual(['0', '1', 'matrix(0.85, 0, 0, 0.85, 0, 0)'])
    expect(await box('[data-id="t2"]')).toEqual(before)
    expect(await p.page.$('[data-id="t9"] .key')).toBeNull()
    expect(await p.page.$('[data-id="settings"] .key')).toBeNull()
    await p.page.hover('[data-id="t9"]')
    await settle()
    expect(await opacity('[data-id="t9"] .mk')).toBe('1')
    expect(await p.page.$eval('[data-id="t10"] .key', (e) => e.textContent)).toBe('⌘9')   // the last canvas
    await p.page.mouse.move(2, 40)
    await settle()
    expect([await opacity('[data-id="t2"] .mk'), await opacity('[data-id="t2"] .key')]).toEqual(['1', '0'])
  })

  it('A7: 120 needs read "99+"; new frames a dot; the active tab keeps its badge', async () => {
    await show(snap('t1', [home, tab('t1', 'Active', { marks: mk({ needs: 120 }) }), tab('t2', 'New', { marks: mk({ unseen: 4 }) })]))
    expect(await p.page.$eval('[data-id="t1"] .mk', (e) => [e.className, e.textContent, getComputedStyle(e).opacity])).toEqual(['mk ask', '99+', '1'])
    expect(await p.page.$eval('[data-id="t2"] .mk', (e) => [e.className, e.textContent])).toEqual(['mk new dot', ''])
    expect(await p.page.$eval('[data-id="t1"] .mk', (e) => getComputedStyle(e).backgroundColor)).toBe(await resolved('background-color', 'var(--mk-ask)'))
    expect(await p.page.$eval('[data-id="t2"] .mk', (e) => getComputedStyle(e).backgroundColor)).toBe(await resolved('background-color', 'var(--mk-new)'))
  })

  it('A8: a shaped mark trimmed onto a white plate at 91%; a full-bleed mark covers the circle with no plate; no logo, initials on the hue', async () => {
    const pngs = await p.page.evaluate(() => {
      const draw = (w: number, hgt: number, f: (g: CanvasRenderingContext2D) => void) => { const c = document.createElement('canvas'); c.width = w; c.height = hgt; f(c.getContext('2d')!); return c.toDataURL('image/png') }
      return {
        mark: draw(128, 128, (g) => { g.fillStyle = '#2b6cb0'; g.beginPath(); g.arc(64, 64, 26, 0, Math.PI * 2); g.fill() }),
        bleed: draw(128, 128, (g) => { g.fillStyle = '#c53030'; g.fillRect(0, 0, 128, 128) }),
      }
    })
    await show(snap('t1', [home, tab('t1', 'Mark', { logo: pngs.mark }), tab('t2', 'Bleed', { logo: pngs.bleed }), tab('t3', 'Initials here', { hue: 4 })]))
    await poll('both trims', () => p.page.evaluate(([a, b]) => {
      const one = document.querySelector<HTMLImageElement>('[data-id="t1"] .logo img'), two = document.querySelector<HTMLImageElement>('[data-id="t2"] .logo img')
      return !!one?.src && one.src !== a && one.complete && !!two?.src && two.src !== b && two.parentElement!.classList.contains('bleed')
    }, [pngs.mark, pngs.bleed]))
    const read = (id: string) => p.page.$eval(`[data-id="${id}"] .logo`, (e) => {
      const img = e.querySelector('img'); const cs = getComputedStyle(e)
      return { cls: e.className, radius: cs.borderRadius, bg: cs.backgroundColor, img: img ? img.getBoundingClientRect().width : null }
    })
    const mark = await read('t1')
    expect(mark).toMatchObject({ cls: 'logo round plate', radius: '50%', bg: 'rgb(255, 255, 255)' })
    expect(mark.img!).toBeCloseTo(24 * 0.91, 1)
    expect(await read('t2')).toMatchObject({ cls: 'logo round plate bleed', radius: '50%', bg: 'rgba(0, 0, 0, 0)', img: 24 })
    expect(await p.page.$eval('[data-id="t3"] .logo b', (e) => [e.textContent, getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)'])).toEqual(['IH', true])
    // a repaint draws the landed trim at once, never the raw URL
    await p.send('tabs', snap('t1', [home, tab('t1', 'Mark', { logo: pngs.mark }), tab('t2', 'Bleed', { logo: pngs.bleed })]))
    expect(await p.page.$eval('[data-id="t1"] .logo img', (e, a) => (e as HTMLImageElement).src !== a && !!(e as HTMLImageElement).src, pngs.mark)).toBe(true)
  })

  it('A9: the states the design never drew, fitted into the 24 px slot', async () => {
    const settings = { id: 'settings', kind: 'settings', name: 'Settings', state: 'hidden', verified: false, open: true } as TabView
    await show(snap('t1', [home, tab('t1', 'Session on', { dark: false, marks: mk({ session: true }) }), settings, tab('t2', 'Starting', { state: 'starting' }), tab('t3', 'Not proven', { state: 'unverified', link: 'http://localhost:4808/' }),
      tab('t4', 'Gone', { state: 'gone', marks: mk({ session: true }) }), tab('t5', 'Unreachable', { state: 'unreachable' }), tab('t6', 'Crashed', { state: 'crashed' }), tab('t7', 'Unloaded', { state: 'unloaded' }),
      tab('t8', 'Working', { marks: mk({ working: true, stale: true, needs: 0 }) }), tab('t9', 'Stale', { marks: mk({ needs: 2, stale: true, session: true }) })]))
    const centred = (id: string, sel: string) => p.page.$eval(`[data-id="${id}"]`, (t, s) => {
      const slot = t.querySelector('.slot')!.getBoundingClientRect(); const e = t.querySelector(s)!; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e)
      return { w: (e as HTMLElement).offsetWidth ?? Math.round(r.width), dx: Math.round((r.left + r.width / 2) - (slot.left + slot.width / 2)), dy: Math.round((r.top + r.height / 2) - (slot.top + slot.height / 2)), color: cs.color, plate: !!t.querySelector('.logo') }
    }, sel)
    expect(await centred('settings', 'svg.gear')).toMatchObject({ w: 15, dx: 0, dy: 0, color: await resolved('color', 'var(--glass-ink-2)'), plate: false })
    expect(await centred('t2', '.spin')).toMatchObject({ w: 14, dx: 0, dy: 0, plate: false })
    expect(await centred('t3', 'svg.warn')).toMatchObject({ w: 16, dx: 0, dy: 0, color: 'rgb(217, 119, 6)', plate: false })
    const dim = (id: string) => p.page.$eval(`[data-id="${id}"]`, (t) => ({ logo: [getComputedStyle(t.querySelector('.logo')!).filter, getComputedStyle(t.querySelector('.logo')!).opacity], name: [getComputedStyle(t.querySelector('.name')!).color, getComputedStyle(t.querySelector('.name')!).fontStyle] }))
    const ink3 = await resolved('color', 'var(--glass-ink-3)')
    expect(await dim('t4')).toEqual({ logo: ['grayscale(1)', '0.45'], name: [ink3, 'italic'] })
    expect(await dim('t5')).toEqual({ logo: ['grayscale(1)', '0.45'], name: [ink3, 'italic'] })
    expect(await dim('t6')).toMatchObject({ logo: ['none', '0.55'], name: [ink3, 'normal'] })
    expect((await dim('t7')).logo).toEqual(['none', '0.55'])
    // the session dot: 6 px teal on the logo's corner, ringed in the face's fill - the ground at rest, the panel look active
    const sess = (id: string) => p.page.$eval(`[data-id="${id}"]`, (t) => {
      const slot = t.querySelector('.slot')!.getBoundingClientRect(); const d = t.querySelector('.sess')!; const r = d.getBoundingClientRect(); const cs = getComputedStyle(d)
      return { size: [r.width, r.height], off: [r.right - slot.right, r.bottom - slot.bottom], bg: cs.backgroundColor, ring: cs.boxShadow, opacity: cs.opacity }
    })
    expect(await sess('t4')).toEqual({ size: [6, 6], off: [2, 2], bg: 'rgb(0, 195, 208)', ring: `${await resolved('color', 'var(--ground)')} 0px 0px 0px 1.5px`, opacity: '1' })
    expect((await sess('t1')).ring).toBe('rgb(246, 247, 249) 0px 0px 0px 1.5px')
    await p.page.hover('[data-id="t4"]')
    await settle()
    expect((await sess('t4')).ring).toBe('rgba(231, 233, 239, 0.9) 0px 0px 0px 1.5px')
    await p.page.mouse.move(2, 40)
    // the agent's sweep on the face; a stale mark and its dot dimmed
    expect(await p.page.$eval('[data-id="t8"] .face', (e) => [getComputedStyle(e, '::before').animationName, getComputedStyle(e, '::before').opacity])).toEqual(['mv-sweep', '0.45'])
    expect(await p.page.$eval('[data-id="t8"]', (e) => getComputedStyle(e, '::before').content)).toBe('none')
    expect([await opacity('[data-id="t9"] .mk'), await opacity('[data-id="t9"] .sess')]).toEqual(['0.45', '0.45'])
  })

  it('A11: on Home the strip hides every badge, dot and sweep, no tab is on; hovering a tab brings its key back', async () => {
    await show(snap('h', [home, tab('t1', 'Pilot', { key: 1, marks: mk({ needs: 3, session: true }) }), tab('t2', 'Worker', { key: 2, marks: mk({ working: true }) }), tab('t3', 'New', { marks: mk({ unseen: 2 }) })]))
    const seen = () => p.page.evaluate(() => ({
      home: document.body.classList.contains('home-on'), on: document.querySelectorAll('.tab.on').length,
      shown: [...document.querySelectorAll('.mk, .end, .sess')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => `${(e.closest('.tab') as HTMLElement).dataset.id} ${e.className}`),
      sweep: document.querySelector('[data-id="t2"] .face') ? getComputedStyle(document.querySelector('[data-id="t2"] .face')!, '::before').display : null,
    }))
    expect(await seen()).toEqual({ home: true, on: 0, shown: [], sweep: 'none' })
    await p.page.hover('[data-id="t1"]')
    await settle()
    expect((await seen()).shown).toEqual(['t1 end'])
    expect(await opacity('[data-id="t1"] .key')).toBe('1')
    await p.page.mouse.move(2, 40)
    await show(snap('t1', [home, tab('t1', 'Pilot', { key: 1, marks: mk({ needs: 3, session: true }) })]))
    expect((await seen()).home).toBe(false)
    expect((await seen()).shown).toEqual(['t1 sess', 't1 end', 't1 mk ask'])
  })
})

describe('immersive play (spec 32 C10)', () => {
  const norm = (s: string) => s.replace(/\s+/g, '').replace(/(^|[(,])\./g, '$10.')
  it('WindowView.immersive: body.immersive, no drag, the strip runs out by MOTION.out and back by MOTION.back', async () => {
    await show(snap('t1', FOUR))
    await p.send('window', { rev: 70, focused: true, fullScreen: false, immersive: true })
    await settle()
    const read = () => p.page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.strip')!)
      return { cls: document.body.classList.contains('immersive'), region: getComputedStyle(document.body).getPropertyValue('-webkit-app-region'), transform: cs.transform, opacity: cs.opacity, events: cs.pointerEvents, duration: cs.transitionDuration, ease: cs.transitionTimingFunction, props: cs.transitionProperty }
    })
    const out = await read()
    expect(out).toMatchObject({ cls: true, region: 'no-drag', transform: 'matrix(1, 0, 0, 1, 0, -48)', opacity: '0', events: 'none', props: 'transform, opacity' })
    expect(out.duration).toBe(`${MOTION.out.strip / 1000}s, ${MOTION.out.strip / 1000}s`)
    expect(norm(out.ease)).toBe(norm(`${MOTION.out.ease}, ${MOTION.out.ease}`))
    await p.send('window', { rev: 71, focused: true, fullScreen: false })
    await settle()
    const back = await read()
    expect(back).toMatchObject({ cls: false, region: 'drag', transform: 'none', opacity: '1', events: 'auto' })
    expect(back.duration).toBe(`${MOTION.back.strip / 1000}s, ${MOTION.back.strip / 1000}s`)
    expect(norm(back.ease)).toBe(norm(`${MOTION.back.ease}, ${MOTION.back.ease}`))
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Spec 32 Part B, the strip's side: the case plays main

const ROWS: TabMenuView['rows'] = [
  { kind: 'item', id: 'open-browser', label: 'Open in browser', icon: 'arrow-square-out', enabled: true },
  { kind: 'item', id: 'reveal', label: 'Reveal in Finder', icon: 'folder-open', enabled: false },
  { kind: 'item', id: 'copy-link', label: 'Copy local link', icon: 'link', enabled: true },
  { kind: 'item', id: 'mark-all-seen', label: 'Mark all as seen', icon: 'check', enabled: true },
  { kind: 'item', id: 'resolve-all-comments', label: 'Resolve all comments', icon: 'check-square-offset', enabled: false },
  { kind: 'sep' },
  { kind: 'item', id: 'close', label: 'Close tab', icon: 'x', enabled: true },
]
let mrev = 1000
type Ask = { id?: string; ids?: string[]; x: number; y: number; key?: boolean; hadFocus?: boolean }
const lastAsk = async (): Promise<Ask> => ([...await p.calls('tab:menu'), ...await p.calls('tabs:more')] as Ask[]).at(-1)!
const shownRevs = async () => (await p.calls('tab:menu-shown') as { rev: number }[]).map((s) => s.rev)
const picks = () => p.calls('tab:menu-pick') as Promise<{ rev: number; id: string | null }[]>
/** main's side of an open: a view for the last ask, the strip grown, then the strip's word that it shows */
async function answer(o: Partial<TabMenuView> = {}, grow: [number, number] = [1280, 800]): Promise<TabMenuView> {
  const a = await lastAsk()
  const v: TabMenuView = { rev: ++mrev, x: a.x, y: a.y, kind: a.ids ? 'more' : 'tab', rows: ROWS, ...o }
  await p.send('tab-menu', v)
  await p.resize(...grow)
  await poll(`tab:menu-shown ${v.rev}`, async () => (await shownRevs()).includes(v.rev))
  return v
}
const state = () => p.page.evaluate(() => {
  const m = document.querySelector<HTMLElement>('.mv-menu')
  return {
    body: document.body.classList.contains('menu-open'),
    openers: [...document.querySelectorAll('#strip .menu-open')].map((e) => (e as HTMLElement).dataset.id ?? e.id),
    menu: !!m, visible: !!m && getComputedStyle(m).visibility !== 'hidden',
  }
})
const focused = () => p.page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a?.dataset.id ?? a?.id ?? a?.className ?? null })
const rightClick = async (sel: string, dx = 20, dy = 16) => { const b = await box(sel); await p.page.mouse.click(b.x + dx, b.y + dy, { button: 'right' }); return b }
const blurAll = () => p.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
const FIVE = [home, tab('t1', 'Marver Platform', { key: 1, dark: false }), tab('t2', 'TMS broker', { key: 2 }), tab('t3', 'Hertz dealer', { key: 3 }), tab('t4', 'Tidewell', { key: 4 })]

describe('the Marver menu, the strip\'s side (spec 32 B3, B6-B11, B14)', () => {
  it('B3: body.menu-open and the opener\'s look from the ask, before any resize; the view renders hidden until the view has grown, then shows and says so; no drag until it is 44 px again', async () => {
    await show(snap('t1', FIVE))
    await blurAll()
    const b = await rightClick('[data-id="t2"]')
    expect(await p.calls('tab:menu')).toEqual([{ id: 't2', x: Math.round(b.x + 20), y: Math.round(b.y + 16), key: false, hadFocus: false }])
    expect(await state()).toEqual({ body: true, openers: ['t2'], menu: false, visible: false })
    expect(await p.page.evaluate(() => getComputedStyle(document.body).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
    const a = await lastAsk()
    const v: TabMenuView = { rev: ++mrev, x: a.x, y: a.y, kind: 'tab', rows: ROWS }
    await p.send('tab-menu', v)
    await sleep(150)
    expect(await state()).toMatchObject({ body: true, menu: true, visible: false })
    expect(await shownRevs()).toEqual([])
    await p.resize(1280, 800)
    await poll('shown', async () => (await shownRevs()).includes(v.rev))
    expect(await state()).toMatchObject({ visible: true, openers: ['t2'] })
    const r = await box('.mv-menu')
    expect(r.y).toBeGreaterThanOrEqual(44)
    // opened by pointer: the menu itself holds focus, no row highlighted (B3.4)
    expect(await p.page.evaluate(() => document.activeElement?.classList.contains('mv-menu'))).toBe(true)
    await p.page.keyboard.press('Escape')
    expect(await picks()).toEqual([{ rev: v.rev, id: null }])
    // hidden at once; the opener's look gone with the pick; no drag stays until the view is back to 44
    expect(await state()).toEqual({ body: true, openers: [], menu: false, visible: false })
    await p.resize(1280, 44)
    await poll('no body.menu-open', async () => !(await state()).body)
    // the canvas had focus (the strip held none before the press): the strip keeps none (main gives it back)
    expect(await p.page.evaluate(() => document.activeElement === document.body)).toBe(true)
  })

  it('B6, B8, B9: the rows, their icons by name, a separator edge to edge (none leading, trailing or doubled), disabled rows dimmed; the strip\'s opaque fill', async () => {
    await show(snap('t1', FIVE))
    await rightClick('[data-id="t2"]')
    await answer({ rows: [{ kind: 'sep' }, ...ROWS.slice(0, 5), { kind: 'sep' }, { kind: 'sep' }, ...ROWS.slice(6), { kind: 'sep' }, { kind: 'item', id: 'evil', label: 'No such icon', icon: 'nope' as never, enabled: true }] })
    const rows = await p.page.$$eval('.mv-menu .mv-menu-rows > *', (els) => els.map((e) => ({
      role: e.getAttribute('role'), label: e.querySelector('.mv-label')?.textContent ?? null, icon: !!e.querySelector('svg.mv-ic'), dim: e.getAttribute('aria-disabled') === 'true', opacity: getComputedStyle(e).opacity, cursor: getComputedStyle(e).cursor,
    })))
    expect(rows.map((r) => r.role)).toEqual(['menuitem', 'menuitem', 'menuitem', 'menuitem', 'menuitem', 'separator', 'menuitem', 'separator', 'menuitem'])
    expect(rows.filter((r) => r.label).map((r) => [r.label, r.icon, r.dim])).toEqual([
      ['Open in browser', true, false], ['Reveal in Finder', true, true], ['Copy local link', true, false], ['Mark all as seen', true, false],
      ['Resolve all comments', true, true], ['Close tab', true, false], ['No such icon', false, false],
    ])
    expect(rows.filter((r) => r.dim).every((r) => r.opacity === '0.4' && r.cursor === 'default')).toBe(true)
    expect(rows.filter((r) => r.label && !r.dim).every((r) => r.opacity === '1' && r.cursor === 'pointer')).toBe(true)
    const edge = await p.page.evaluate(() => { const m = document.querySelector('.mv-menu')!.getBoundingClientRect(); const s = document.querySelector('.mv-sep')!.getBoundingClientRect(); return [s.left - m.left, m.right - s.right] })
    expect(edge[0]).toBeCloseTo(1, 1)   // inside the 1 px border, edge to edge
    expect(edge[1]).toBeCloseTo(1, 1)
    expect(await p.page.$eval('.mv-menu', (e) => [e.classList.contains('solid'), getComputedStyle(e).backgroundColor, getComputedStyle(e).backdropFilter])).toEqual([true, 'rgb(246, 247, 249)', 'none'])
    // a click on a disabled row does nothing and keeps the menu open
    await sleep(260)
    const dis = await box('.mv-row[data-id="reveal"]')
    await p.page.mouse.move(dis.x + 30, dis.y + 10)
    await p.page.mouse.move(dis.x + 32, dis.y + 12)
    await p.page.mouse.down(); await p.page.mouse.up()
    expect(await picks()).toEqual([])
    expect((await state()).visible).toBe(true)
  })

  it('B10, B14.1, A14: ⇧F10 asks by key with the strip\'s focus; the first enabled row focused; arrows skip disabled rows and wrap; Home and End; Enter picks; focus back to the opener', async () => {
    await show(snap('t1', FIVE))
    await p.page.focus('[data-id="t2"]')
    await p.page.keyboard.press('Shift+F10')
    const b = await box('[data-id="t2"]')
    expect(await p.calls('tab:menu')).toEqual([{ id: 't2', x: Math.round(b.x), y: Math.round(b.y + b.height), key: true, hadFocus: true }])
    const v = await answer()
    expect(await focused()).toBe('open-browser')
    const keys: [string, string][] = [['ArrowDown', 'copy-link'], ['ArrowDown', 'mark-all-seen'], ['ArrowDown', 'close'], ['ArrowDown', 'open-browser'], ['ArrowUp', 'close'], ['Home', 'open-browser'], ['End', 'close'], ['ArrowUp', 'mark-all-seen']]
    for (const [k, want] of keys) { await p.page.keyboard.press(k); expect(await focused(), k).toBe(want) }
    // main's page:focus is not answered while the menu is open (B14)
    await p.send('page:focus', { target: 'active-tab' })
    expect(await focused()).toBe('mark-all-seen')
    await p.page.keyboard.press('Enter')
    expect(await picks()).toEqual([{ rev: v.rev, id: 'mark-all-seen' }])
    expect(await focused()).toBe('t2')
    await p.resize(1280, 44)
    await poll('no body.menu-open', async () => !(await state()).body)
    // the context-menu key too; Escape returns focus to the opener as well
    await p.page.keyboard.press('ContextMenu')
    expect((await lastAsk())).toMatchObject({ id: 't2', key: true, hadFocus: true })
    const w = await answer()
    await p.page.keyboard.press('Escape')
    expect((await picks()).at(-1)).toEqual({ rev: w.rev, id: null })
    expect(await focused()).toBe('t2')
  })

  it('B11: an outside press closes with no pick and is swallowed; a mouseup before any pointermove over the menu picks nothing; then a click picks', async () => {
    await show(snap('t1', FIVE))
    await rightClick('[data-id="t2"]')
    const v = await answer()
    await p.page.mouse.click(700, 500)
    expect(await picks()).toEqual([{ rev: v.rev, id: null }])
    expect(await p.calls('tab:activate')).toEqual([])
    await p.resize(1280, 44)
    // the pointer already over where a row will be, before the menu shows: its release picks nothing
    const b = await rightClick('[data-id="t3"]')
    const a = await lastAsk()
    const w: TabMenuView = { rev: ++mrev, x: a.x, y: a.y, kind: 'tab', rows: ROWS }
    await p.send('tab-menu', w)
    await p.page.mouse.move(b.x + 40, 44 + 1 + 5 + 15)   // the first row's middle, while the menu is still hidden
    await p.resize(1280, 800)
    await poll('shown', async () => (await shownRevs()).includes(w.rev))
    await sleep(300)
    await p.page.mouse.down(); await p.page.mouse.up()
    expect(await picks()).toEqual([{ rev: v.rev, id: null }])
    expect((await state()).visible).toBe(true)
    await p.page.mouse.move(b.x + 44, 44 + 1 + 5 + 16)
    await p.page.mouse.down(); await p.page.mouse.up()
    expect((await picks()).at(-1)).toEqual({ rev: w.rev, id: 'open-browser' })
  })

  it('B3.1, B4: a right-click on Home asks nothing; a refusal (tab-menu: null) drops the marks at once; an ask with no answer gives them up after 1 s', async () => {
    await show(snap('t1', FIVE))
    await rightClick('.home', 10, 10)
    await p.page.focus('.home')
    await p.page.keyboard.press('Shift+F10')
    await sleep(50)
    expect(await p.calls('tab:menu')).toEqual([])
    expect((await state()).body).toBe(false)
    await rightClick('[data-id="t3"]')
    expect(await state()).toMatchObject({ body: true, openers: ['t3'] })
    await p.send('tab-menu', null)
    expect(await state()).toEqual({ body: false, openers: [], menu: false, visible: false })
    expect(await picks()).toEqual([])
    await rightClick('[data-id="t4"]')
    await sleep(600)
    expect(await state()).toMatchObject({ body: true, openers: ['t4'] })
    await sleep(550)
    expect(await state()).toMatchObject({ body: false, openers: [] })
  })

  it('B11: a right-click on another tab through the catcher - a secondary press, then a Control-click - asks for it with no null pick, and its menu shows with no resize between; a right-click on the opener closes', async () => {
    await show(snap('t1', FIVE))
    await rightClick('[data-id="t2"]')
    const v1 = await answer()
    const t3 = await box('[data-id="t3"]')
    await p.page.mouse.move(t3.x + 30, t3.y + 16)
    await p.page.mouse.down({ button: 'right' })
    await p.page.mouse.up({ button: 'right' })
    await poll('the ask for t3', async () => (await lastAsk()).id === 't3')
    expect(await lastAsk()).toEqual({ id: 't3', x: Math.round(t3.x + 30), y: Math.round(t3.y + 16), key: false, hadFocus: true })
    expect(await picks()).toEqual([])
    expect((await state()).openers).toEqual(['t2', 't3'])
    const v2: TabMenuView = { rev: ++mrev, x: Math.round(t3.x + 30), y: Math.round(t3.y + 16), kind: 'tab', rows: ROWS }
    await p.send('tab-menu', v2)   // main replaces it: the view stays grown, so no resize comes
    await poll('v2 shown', async () => (await shownRevs()).includes(v2.rev))
    expect(await state()).toMatchObject({ body: true, openers: ['t3'], visible: true })
    expect(await p.page.$$eval('.mv-menu', (els) => els.length)).toBe(1)
    // macOS's Control-click is a secondary press too
    const t4 = await box('[data-id="t4"]')
    await p.page.mouse.move(t4.x + 30, t4.y + 16)
    await p.page.keyboard.down('Control')
    await p.page.mouse.down(); await p.page.mouse.up()
    await p.page.keyboard.up('Control')
    await poll('the ask for t4', async () => (await lastAsk()).id === 't4')
    expect(await picks()).toEqual([])
    const v3: TabMenuView = { rev: ++mrev, x: Math.round(t4.x + 30), y: Math.round(t4.y + 16), kind: 'tab', rows: ROWS }
    await p.send('tab-menu', v3)
    await poll('v3 shown', async () => (await shownRevs()).includes(v3.rev))
    // the opener itself: closes as any press outside
    await p.page.mouse.click(t4.x + 30, t4.y + 16, { button: 'right' })
    expect(await picks()).toEqual([{ rev: v3.rev, id: null }])
    expect((await p.calls('tab:menu')).length).toBe(3)
    void v1
  })

  it('B5, B11: a right-click on » opens the » menu, with no menu open and through the catcher with a tab menu open; Enter or Space on » asks by key', async () => {
    await show(snap('t1', [home, ...Array.from({ length: 20 }, (_, i) => tab(`t${i + 1}`, `Canvas number ${i + 1}`))]))
    expect(await p.page.isVisible('#more')).toBe(true)
    await blurAll()
    await rightClick('#more', 8, 8)
    const m = await p.calls('tabs:more') as Ask[]
    const r = await box('#more')
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ x: Math.round(r.x), y: Math.round(r.y + r.height), key: false, hadFocus: false })
    expect(m[0].ids!.length).toBeGreaterThan(0)
    expect(await state()).toMatchObject({ body: true, openers: ['more'] })
    const rows = m[0].ids!.map((id) => ({ kind: 'item' as const, id: `tab:${id}`, label: `Canvas number ${id.slice(1)}`, enabled: true }))
    const v = await answer({ kind: 'more', rows })
    expect(await p.page.$$eval('.mv-row', (els) => els.map((e) => [e.querySelector('.mv-label')!.textContent, !!e.querySelector('svg')]))).toEqual(rows.map((x) => [x.label, false]))
    await p.page.keyboard.press('Escape')
    expect(await picks()).toEqual([{ rev: v.rev, id: null }])
    await p.resize(1280, 44)
    // with a tab menu open, a right-click on » hands back through the catcher: the » menu replaces it, no null pick
    await rightClick('[data-id="t1"]')
    await answer()
    await p.page.mouse.move(r.x + 8, r.y + 8)
    await p.page.mouse.down({ button: 'right' })
    await p.page.mouse.up({ button: 'right' })
    await poll('the » ask', async () => (await p.calls('tabs:more')).length === 2)
    expect((await p.calls('tabs:more') as Ask[])[1]).toMatchObject({ key: false, hadFocus: true })
    expect(await picks()).toEqual([{ rev: v.rev, id: null }])
    await p.send('tab-menu', null)
    await p.resize(1280, 44)
    // by key: Enter and Space on a focused »
    await p.clear()
    for (const k of ['Enter', ' ']) {
      await p.page.focus('#more')
      await p.page.keyboard.press(k)
      expect((await p.calls('tabs:more') as Ask[]).at(-1)).toMatchObject({ key: true, hadFocus: true })
      await p.send('tab-menu', null)
    }
    // a key-opened » menu: its first row focused, and focus back on » when it closes
    await p.page.focus('#more')
    await p.page.keyboard.press('Enter')
    await answer({ kind: 'more', rows })
    expect(await focused()).toBe(rows[0].id)
    await p.page.keyboard.press('Escape')
    expect(await focused()).toBe('more')
  })

  it('B7: right-clicks at y 4, 20 and 40 open below the strip (top 44 at least); clamped by its measured width 14 px from both edges', async () => {
    await show(snap('t1', FIVE))
    for (const y of [4, 20, 40]) {
      await p.page.mouse.click(400, y, { button: 'right' })
      const asks = await p.calls('tab:menu') as Ask[]
      if (!asks.length || asks.at(-1)!.y !== y) {   // y 4 and 40 may fall outside the tab's 32 px: ask at its row instead
        await p.send('tab-menu', null)
        await rightClick('[data-id="t2"]', 20, Math.min(30, Math.max(2, y - 6)))
      }
      await answer({ y })
      expect((await box('.mv-menu')).y, `y ${y}`).toBeGreaterThanOrEqual(44)
      await p.page.keyboard.press('Escape')
      await p.resize(1280, 44)
    }
    await rightClick('[data-id="t2"]')
    await answer({ x: 1275 })
    const right = await box('.mv-menu')
    expect(right.x + right.width).toBeCloseTo(1280 - 14, 0)
    await p.page.keyboard.press('Escape')
    await p.resize(1280, 44)
    await rightClick('[data-id="t2"]')
    await answer({ x: 2 })
    expect((await box('.mv-menu')).x).toBe(14)
    await p.page.keyboard.press('Escape')
  })

  it('B7.3, B7.4: at 720 x 480 a » menu of 30 hidden tabs is capped and its rows scroll; arrowing to the last row scrolls it into view; Enter picks its id', async () => {
    await p.resize(720, 44)
    await show(snap('t1', [home, ...Array.from({ length: 36 }, (_, i) => tab(`t${i + 1}`, `Canvas number ${i + 1}`))]))
    await p.page.focus('#more')
    await p.page.keyboard.press('Enter')
    const ids = (await lastAsk()).ids!
    expect(ids.length).toBe(30)
    const rows = ids.map((id) => ({ kind: 'item' as const, id: `tab:${id}`, label: `Canvas number ${id.slice(1)} - stopped`, enabled: true }))
    const v = await answer({ kind: 'more', rows }, [720, 480])
    await settle()
    const g = await p.page.evaluate(() => { const m = document.querySelector('.mv-menu')!; const l = document.querySelector('.mv-menu-rows')!; const r = m.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, scroll: l.scrollHeight > l.clientHeight } })
    expect(g.top).toBeGreaterThanOrEqual(44)
    expect(g.bottom).toBeLessThanOrEqual(480 - 14 + 0.5)
    expect(g.scroll).toBe(true)
    await p.page.keyboard.press('End')
    expect(await focused()).toBe(rows.at(-1)!.id)
    const inView = await p.page.evaluate(() => { const l = document.querySelector('.mv-menu-rows')!.getBoundingClientRect(); const r = document.activeElement!.getBoundingClientRect(); return r.top >= l.top - 0.5 && r.bottom <= l.bottom + 0.5 })
    expect(inView).toBe(true)
    await p.page.keyboard.press('Enter')
    expect(await picks()).toEqual([{ rev: v.rev, id: rows.at(-1)!.id }])
    await p.resize(1280, 44)
  })

  it('B3.1, B14.2: the focus reading is taken before the press moves it - a canvas focused reads false, » or a pill button focused reads true, and that dismissal returns focus to the strip', async () => {
    await show(snap('t1', [home, ...Array.from({ length: 20 }, (_, i) => tab(`t${i + 1}`, `Canvas number ${i + 1}`))]))
    await blurAll()
    await rightClick('[data-id="t2"]')
    // the right mousedown focused the tab (focusin set its roving focus) before contextmenu: the reading is still false
    expect(await lastAsk()).toMatchObject({ id: 't2', hadFocus: false })
    await p.send('tab-menu', null)
    await p.page.focus('#more')
    await rightClick('[data-id="t3"]')
    expect(await lastAsk()).toMatchObject({ id: 't3', hadFocus: true })
    await answer()
    await p.page.keyboard.press('Escape')
    expect(await focused()).toBe('t3')
    await p.resize(1280, 44)
    await p.send('pill', { rev: 41, kind: 'test', text: 'A pill with a button', short: 'Pill', dismissible: true, button: { label: 'Do it', style: 'accent' } })
    await settle()
    await p.page.focus('#pill .pill-btn')
    await rightClick('[data-id="t2"]')
    expect(await lastAsk()).toMatchObject({ id: 't2', hadFocus: true })
    await p.send('tab-menu', null)
    await p.send('pill', null)
  })

  it('B11, B12, B15: a view the strip never asked for (a test hook) sets body.menu-open and its opener; main\'s close hides it at once and gets the null pick; no drag until the view is 44 px', async () => {
    await show(snap('t1', FIVE))
    const b = await box('[data-id="t3"]')
    const v: TabMenuView = { rev: ++mrev, x: Math.round(b.x), y: Math.round(b.y + b.height), kind: 'tab', rows: ROWS }
    await p.send('tab-menu', v)
    expect(await state()).toMatchObject({ body: true, openers: ['t3'], menu: true, visible: false })
    await p.resize(1280, 800)
    await poll('shown', async () => (await shownRevs()).includes(v.rev))
    await p.send('tab-menu', null)
    expect(await picks()).toEqual([{ rev: v.rev, id: null }])
    expect(await state()).toEqual({ body: true, openers: [], menu: false, visible: false })
    await p.resize(1280, 44)
    await poll('no body.menu-open', async () => !(await state()).body)
  })
  it('B7.1-B7.3: a menu open while the window is resized is placed again - clamped 14 px inside the new right edge and capped by the new foot', async () => {
    await show(snap('t1', FIVE))
    await rightClick('[data-id="t2"]')
    await answer({ x: 1066 })
    expect((await box('.mv-menu')).x).toBe(1066)
    await p.resize(720, 480)
    const r = (await poll('placed again', async () => { const b = await box('.mv-menu'); return b.x + b.width <= 720 - 14 + 0.5 ? b : null }, 1500))!
    expect(r.x + r.width).toBeCloseTo(720 - 14, 0)
    expect(r.y).toBeGreaterThanOrEqual(44)
    expect(r.y + r.height).toBeLessThanOrEqual(480 - 14 + 0.5)
    expect(await state()).toMatchObject({ visible: true, openers: ['t2'] })
    await p.page.keyboard.press('Escape')
    await p.resize(1280, 44)
  })

  it('B2, B3.1, B11: a refusal (tab-menu: null) of a replacement asked through the catcher closes the open menu and drops the pending ask too - its look, its timer; no drag only until the view is 44 px; page:focus answered then', async () => {
    await show(snap('t1', FIVE))
    await rightClick('[data-id="t2"]')
    const v = await answer()
    const t3 = await box('[data-id="t3"]')
    await p.page.mouse.move(t3.x + 30, t3.y + 16)
    await p.page.mouse.down({ button: 'right' })
    await p.page.mouse.up({ button: 'right' })
    await poll('the ask for t3', async () => (await lastAsk()).id === 't3')
    expect((await state()).openers).toEqual(['t2', 't3'])
    await p.send('tab-menu', null)
    expect(await picks()).toEqual([{ rev: v.rev, id: null }])
    expect(await state()).toEqual({ body: true, openers: [], menu: false, visible: false })
    await p.resize(1280, 44)
    // well inside the 1 s fallback: the refusal answered the ask, nothing waits on it
    await poll('no body.menu-open', async () => !(await state()).body, 300)
    await p.send('page:focus', { target: 'active-tab' })
    expect(await focused()).toBe('t1')
  })
})
