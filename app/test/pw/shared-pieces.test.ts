/**
 * Spec 32's shared pieces (G4; E1-E7), windowless: the real dom.ts and menu.ts bundled as a page bundles them, on the
 * page harness's proof route (test/proofs/kit-*.html, the real tokens.css, base.css, menu.css and each page's own
 * style.css, under the pages' CSP). The menu component (E2: B6's look, B7's placing, B8-B11's keys and pointer), the
 * page token blocks (E1), the focus looks (E7), the logo trim (E4) and the app mark (E6).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { MenuOptions, MenuRow } from '../../src/pages/menu.ts'
import { openProof, type PageRun } from '../harness/pages.ts'

type Kit = {
  log: { on: string; id?: string; via?: string; keys?: string; why?: string; el?: string }[]
  menu(o: Omit<MenuOptions, 'onPick' | 'onClose' | 'onSecondary'> & { keep?: string[]; secondary?: boolean; openerSel?: string }): void
  m: { el: HTMLElement; show(): Promise<void>; update(rows: MenuRow[]): void; close(): void; open: boolean } | null
  rowsOf(n: number, dim?: boolean): MenuRow[]
  setLook(dark?: boolean): void
  [k: string]: unknown
}
declare global { interface Window { kit: Kit } }

const ready = (p: PageRun) => p.page.waitForFunction(() => 'kit' in window && document.documentElement.classList.contains('mv-ready'))
type Opts = Parameters<Kit['menu']>[0]
const open = (p: PageRun, o: Opts) => p.page.evaluate((x: unknown) => { window.kit.log.length = 0; window.kit.menu(x as Opts) }, o as unknown)
const log = (p: PageRun) => p.page.evaluate(() => window.kit.log.map((e) => ({ ...e })))
const isOpen = (p: PageRun) => p.page.evaluate(() => !!window.kit.m?.open && document.querySelector('.mv-menu') !== null)
const rect = (p: PageRun, sel: string) => p.page.evaluate(async (s) => {
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null)))   // the pop's transform settled
  const r = document.querySelector(s)!.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }, sel)
const focused = (p: PageRun) => p.page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a?.dataset.id ?? a?.className ?? null })
const css = (p: PageRun, sel: string, props: string[], pseudo?: string) => p.page.evaluate(([s, ps, pe]) => {
  const cs = getComputedStyle(document.querySelector(s as string)!, (pe as string) || null)
  return Object.fromEntries((ps as string[]).map((k) => [k, cs.getPropertyValue(k).trim()]))
}, [sel, props, pseudo ?? ''] as const)
const tokens = (p: PageRun, names: string[]) => p.page.evaluate((ns) => { const cs = getComputedStyle(document.documentElement); return Object.fromEntries(ns.map((n) => [n, cs.getPropertyValue(n).trim()])) }, names)
const look = (p: PageRun, dark: boolean) => p.page.evaluate((d) => window.kit.setLook(d), dark)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ROWS: MenuRow[] = [
  { kind: 'sep' },
  { kind: 'item', id: 'open-browser', label: 'Open in browser', icon: 'arrow-square-out', enabled: true },
  { kind: 'sep' }, { kind: 'sep' },
  { kind: 'item', id: 'reveal', label: 'Reveal in Finder', icon: 'folder-open', enabled: false },
  { kind: 'item', id: 'copy-link', label: 'Copy local link', icon: 'link', enabled: true },
  { kind: 'sep' },
  { kind: 'item', id: 'close', label: 'Close tab', icon: 'x', enabled: true },
  { kind: 'sep' },
]

describe('the Marver menu on the strip (E2, B6-B11)', () => {
  let p: PageRun
  beforeAll(async () => {
    p = await openProof('kit-strip.html', { bundle: 'kit.ts', width: 1280, height: 800 })
    await ready(p)
    // two tabs and » in the strip's row: openers for B11's hand-back
    await p.page.evaluate(() => {
      const f = document.getElementById('fixture')!
      for (const id of ['t1', 't2']) { const t = document.createElement('div'); t.className = 'tab'; t.dataset.id = id; t.tabIndex = 0; const face = document.createElement('span'); face.className = 'face'; face.textContent = id; t.append(face); f.append(t) }
      const more = document.createElement('button'); more.id = 'more'; more.textContent = '»'; f.append(more)
      ;(window as unknown as { ctx: number }).ctx = 0
      document.addEventListener('contextmenu', () => { (window as unknown as { ctx: number }).ctx++ })
    })
  })
  afterAll(async () => { await p?.close() })
  beforeEach(async () => { await p.page.evaluate(() => { window.kit.m?.close(); window.kit.setLook(false) }); await p.media({}) })

  it('draws rows, icons, a check by class and separators edge to edge; drops leading, trailing and double separators (B6, B9)', async () => {
    await open(p, { rows: [...ROWS, { kind: 'header', label: 'View' }, { kind: 'item', id: 'grid', label: 'Grid', icon: 'grid', enabled: true, checked: true }, { kind: 'item', id: 'board', label: 'Board', icon: 'board', enabled: true, checked: false }, { kind: 'item', id: 'plain', label: 'No icon', enabled: true, checked: true }], at: { x: 100, y: 60 }, top: 44, solid: true })
    const shape = await p.page.$$eval('.mv-menu-rows > *', (els) => els.map((e) => [e.className.replace('mv-row', 'row').trim(), e.getAttribute('role'), e.getAttribute('aria-disabled'), e.getAttribute('aria-checked'), e.querySelector('svg.mv-ic') ? 'ic' : '', e.querySelector('svg.mv-check') ? 'check' : '']))
    expect(shape).toEqual([
      ['row', 'menuitem', null, null, 'ic', ''],
      ['mv-sep', 'separator', null, null, '', ''],
      ['row', 'menuitem', 'true', null, 'ic', ''],
      ['row', 'menuitem', null, null, 'ic', ''],
      ['mv-sep', 'separator', null, null, '', ''],
      ['row', 'menuitem', null, null, 'ic', ''],
      ['mv-sep', 'separator', null, null, '', ''],
      ['mv-menu-h', 'presentation', null, null, '', ''],
      ['row', 'menuitemradio', null, 'true', 'ic', 'check'],
      ['row', 'menuitemradio', null, 'false', 'ic', ''],
      ['row', 'menuitemradio', null, 'true', '', 'check'],
    ])
    expect(await p.page.getAttribute('.mv-menu', 'role')).toBe('menu')
    // the check is trailing (margin-left auto), never the leading icon, even on a row with no icon
    const plain = await p.page.evaluate(() => { const r = document.querySelector('[data-id="plain"]')!; const c = r.querySelector('.mv-check')!.getBoundingClientRect(); return { right: r.getBoundingClientRect().right - c.right, ml: getComputedStyle(r.querySelector('.mv-check')!).marginLeft } })
    expect(plain.right).toBeCloseTo(10, 0)
    // a separator runs from the menu's inner left edge to its inner right edge
    const m = await rect(p, '.mv-menu'), s = await rect(p, '.mv-sep')
    expect(s.left).toBeCloseTo(m.left + 1, 0)
    expect(s.right).toBeCloseTo(m.right - 1, 0)
    expect(s.height).toBe(1)
  })

  it('wears B6\'s look in the strip: opaque panel fill, no blur, Home\'s metrics, light and dark', async () => {
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true })
    const box = ['min-width', 'max-width', 'border-top-left-radius', 'background-color', 'backdrop-filter', 'border-top-color', 'border-top-width', 'box-shadow', 'z-index', 'animation-name', 'animation-duration']
    expect(await css(p, '.mv-menu', box)).toEqual({
      'min-width': '200px', 'max-width': '320px', 'border-top-left-radius': '16px', 'background-color': 'rgb(246, 247, 249)', 'backdrop-filter': 'none',
      'border-top-color': 'rgba(24, 24, 27, 0.1)', 'border-top-width': '1px',
      'box-shadow': 'rgba(255, 255, 255, 0.65) 0px 1px 0px 0px inset, rgba(24, 24, 27, 0.05) 0px 1px 2px 0px, rgba(24, 24, 27, 0.22) 0px 12px 32px -12px',
      'z-index': '30', 'animation-name': 'mv-pop', 'animation-duration': '0.14s',
    })
    expect((await css(p, '.mv-menu', ['background-image'], '::after'))['background-image']).toContain('linear-gradient(155deg, rgba(255, 255, 255, 0.95)')
    expect(await css(p, '.mv-menu-rows', ['padding-top', 'padding-left', 'overflow-y'])).toEqual({ 'padding-top': '5px', 'padding-left': '5px', 'overflow-y': 'auto' })
    expect(await css(p, '[data-id="open-browser"]', ['height', 'column-gap', 'padding-left', 'padding-right', 'border-top-left-radius', 'font-size', 'font-weight', 'color', 'cursor'])).toEqual({
      height: '30px', 'column-gap': '10px', 'padding-left': '10px', 'padding-right': '10px', 'border-top-left-radius': '12px', 'font-size': '13px', 'font-weight': '500', color: 'rgb(24, 24, 27)', cursor: 'pointer',
    })
    expect(await css(p, '[data-id="open-browser"] .mv-ic', ['width', 'height'])).toEqual({ width: '15px', height: '15px' })
    expect(await css(p, '[data-id="reveal"]', ['opacity', 'cursor'])).toEqual({ opacity: '0.4', cursor: 'default' })
    expect(await css(p, '.mv-sep', ['background-color', 'margin-top', 'margin-left'])).toEqual({ 'background-color': 'rgba(24, 24, 27, 0.12)', 'margin-top': '5px', 'margin-left': '-5px' })
    // hover and keyboard focus are the same fill; a focused row has no outline and no ring (E7)
    await p.page.hover('[data-id="copy-link"]')
    expect(await css(p, '[data-id="copy-link"]', ['background-color', 'outline-style', 'box-shadow'])).toEqual({ 'background-color': 'rgba(24, 24, 27, 0.05)', 'outline-style': 'none', 'box-shadow': 'none' })
    await p.page.mouse.move(5, 790)
    await look(p, true)
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true, focusFirst: true })
    expect(await css(p, '.mv-menu', ['background-color', 'border-top-color', 'box-shadow'])).toEqual({
      'background-color': 'rgb(16, 17, 22)', 'border-top-color': 'rgba(255, 255, 255, 0.16)',
      'box-shadow': 'rgba(255, 255, 255, 0.09) 0px 1px 0px 0px inset, rgba(10, 10, 16, 0.2) 0px 1px 2px 0px, rgba(0, 0, 0, 0.5) 0px 12px 32px -12px',
    })
    expect((await css(p, '.mv-menu', ['background-image'], '::after'))['background-image']).toContain('linear-gradient(155deg, rgba(255, 255, 255, 0.46)')
    expect(await css(p, '[data-id="open-browser"]', ['background-color', 'outline-style', 'box-shadow', 'color'])).toEqual({ 'background-color': 'rgba(255, 255, 255, 0.1)', 'outline-style': 'none', 'box-shadow': 'none', color: 'rgb(245, 245, 247)' })
    expect(await css(p, '.mv-sep', ['background-color'])).toEqual({ 'background-color': 'rgba(255, 255, 255, 0.14)' })
  })

  it('under Reduce Transparency is solid with no ring, and under Reduce Motion does not pop', async () => {
    await p.media({ 'prefers-reduced-transparency': 'reduce' })
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true })
    expect(await css(p, '.mv-menu', ['background-color', 'border-top-color'])).toEqual({ 'background-color': 'rgb(255, 255, 255)', 'border-top-color': 'rgb(221, 222, 229)' })
    expect((await css(p, '.mv-menu', ['display'], '::after')).display).toBe('none')
    await p.media({ 'prefers-reduced-motion': 'reduce' })
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true })
    expect((await css(p, '.mv-menu', ['animation-name']))['animation-name']).toBe('none')
  })

  it('by key: the first enabled row is focused; arrows skip disabled rows and wrap; Home and End; Enter and Space pick with the key (B10)', async () => {
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true, focusFirst: true })
    expect(await focused(p)).toBe('open-browser')
    await p.page.keyboard.press('ArrowDown')
    expect(await focused(p)).toBe('copy-link')   // 'reveal' is disabled: skipped
    await p.page.keyboard.press('ArrowDown')
    expect(await focused(p)).toBe('close')
    await p.page.keyboard.press('ArrowDown')
    expect(await focused(p)).toBe('open-browser')   // wraps
    await p.page.keyboard.press('ArrowUp')
    expect(await focused(p)).toBe('close')
    await p.page.keyboard.press('Home')
    expect(await focused(p)).toBe('open-browser')
    await p.page.keyboard.press('End')
    expect(await focused(p)).toBe('close')
    await p.page.keyboard.press('ArrowUp')
    await p.page.keyboard.press('Enter')
    expect(await log(p)).toEqual([{ on: 'pick', id: 'copy-link', via: 'key', keys: 'Enter' }])
    expect(await isOpen(p)).toBe(false)
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true, focusFirst: true })
    await p.page.keyboard.press(' ')
    expect(await log(p)).toEqual([{ on: 'pick', id: 'open-browser', via: 'key', keys: 'Space' }])
  })

  it('Escape and Tab close with no pick (B10, B12)', async () => {
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true, focusFirst: true })
    await p.page.keyboard.press('Escape')
    expect(await log(p)).toEqual([{ on: 'close', why: 'escape' }])
    expect(await isOpen(p)).toBe(false)
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true, focusFirst: true })
    await p.page.keyboard.press('Tab')
    expect(await log(p)).toEqual([{ on: 'close', why: 'tab' }])
    expect(await p.page.locator('.mv-menu, .mv-catcher').count()).toBe(0)
  })

  it('by pointer: the menu itself takes focus with no row highlighted; a key then starts at the first or last row (B3.4)', async () => {
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true })
    expect(await p.page.evaluate(() => document.activeElement?.classList.contains('mv-menu'))).toBe(true)
    expect(await p.page.locator('.mv-row:focus').count()).toBe(0)
    await p.page.keyboard.press('ArrowDown')
    expect(await focused(p)).toBe('open-browser')
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true })
    await p.page.keyboard.press('ArrowUp')
    expect(await focused(p)).toBe('close')
  })

  it('a mouseup before any pointermove over the menu, or within 250 ms of it showing, picks nothing; then a click picks (B11)', async () => {
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true })
    const r = await rect(p, '[data-id="copy-link"]')
    // the release of the press that opened it: no pointermove since the menu showed
    await p.page.evaluate(() => { window.kit.m?.close() })
    await p.page.mouse.move(r.left + 20, r.top + 10)
    await p.page.mouse.down({ button: 'right' })
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true })
    await p.page.mouse.up({ button: 'right' })
    expect(await log(p)).toEqual([])
    expect(await isOpen(p)).toBe(true)
    // moved, but within 250 ms of showing
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true })
    await p.page.mouse.move(r.left + 24, r.top + 12)
    await p.page.mouse.down()
    await p.page.mouse.up()
    expect(await log(p)).toEqual([])
    await sleep(300)
    await p.page.mouse.move(r.left + 26, r.top + 12)
    await p.page.mouse.down()
    await p.page.mouse.up()
    expect(await log(p)).toEqual([{ on: 'pick', id: 'copy-link', via: 'click' }])
    expect(await isOpen(p)).toBe(false)
  })

  it('a disabled row is skipped by the pointer too: a click on it does nothing and keeps the menu open (B8)', async () => {
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true })
    await sleep(300)
    const r = await rect(p, '[data-id="reveal"]')
    await p.page.mouse.move(r.left + 20, r.top + 10)
    await p.page.mouse.down()
    await p.page.mouse.up()
    expect(await log(p)).toEqual([])
    expect(await isOpen(p)).toBe(true)
    expect(await p.page.locator('.mv-row:focus').count()).toBe(0)
  })

  it('a pick may keep the menu open (Home\'s Copied rows, D8.3); update() keeps the node and the focused id (D11.1)', async () => {
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true, focusFirst: true, keep: ['copy-link'] })
    await p.page.keyboard.press('ArrowDown')
    await p.page.keyboard.press('Enter')
    expect(await log(p)).toEqual([{ on: 'pick', id: 'copy-link', via: 'key', keys: 'Enter' }])
    expect(await isOpen(p)).toBe(true)
    const same = await p.page.evaluate((rows) => { const before = document.querySelector('[data-id="copy-link"]'); window.kit.m!.update(rows); return document.querySelector('[data-id="copy-link"]') === before }, ROWS)
    expect(same).toBe(true)
    const next = ROWS.map((r) => (r.kind === 'item' && r.id === 'copy-link' ? { ...r, label: 'Copied', icon: 'check' as const, done: true } : r))
    await p.page.evaluate((rows) => window.kit.m!.update(rows), next)
    expect(await focused(p)).toBe('copy-link')
    expect(await p.page.textContent('[data-id="copy-link"]')).toBe('Copied')
    expect(await css(p, '[data-id="copy-link"]', ['color', 'background-color'])).toEqual({ color: 'rgb(31, 157, 85)', 'background-color': 'rgba(52, 199, 89, 0.16)' })
    // a row that goes away: focus falls to the first enabled row of a key-opened menu
    await p.page.evaluate((rows) => window.kit.m!.update(rows), ROWS.filter((r) => !(r.kind === 'item' && r.id === 'copy-link')))
    expect(await focused(p)).toBe('open-browser')
  })

  it('an outside press closes with no pick and is swallowed whole, its contextmenu included (B11)', async () => {
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true })
    await p.page.mouse.click(900, 600)
    expect(await log(p)).toEqual([{ on: 'close', why: 'outside' }])
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true })
    const before = await p.page.evaluate(() => (window as unknown as { ctx: number }).ctx)
    await p.page.mouse.click(900, 600, { button: 'right' })
    expect(await log(p)).toEqual([{ on: 'close', why: 'outside' }])
    expect(await p.page.evaluate(() => (window as unknown as { ctx: number }).ctx)).toBe(before)
  })

  it('a secondary press on another opener hands its contextmenu back with no close; on the opener itself it closes (B11)', async () => {
    const opts = { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true, secondary: true, openers: '.tab, #more', openerSel: '.tab[data-id="t1"]' }
    await open(p, opts)
    const t2 = await rect(p, '.tab[data-id="t2"]')
    // the whole sequence through the harness mouse: pointerdown (button 2), pointerup, contextmenu
    await p.page.mouse.move(t2.left + 30, t2.top + 16)
    await p.page.mouse.down({ button: 'right' })
    await p.page.mouse.up({ button: 'right' })
    await sleep(350)
    expect(await log(p)).toEqual([{ on: 'secondary', el: 't2' }])
    expect(await isOpen(p)).toBe(true)
    // » too
    const more = await rect(p, '#more')
    await p.page.mouse.move(more.left + 5, more.top + 5)
    await p.page.mouse.down({ button: 'right' })
    await p.page.mouse.up({ button: 'right' })
    await sleep(50)
    expect((await log(p)).at(-1)).toEqual({ on: 'secondary', el: 'more' })
    // the opener: closes as any outside press
    const t1 = await rect(p, '.tab[data-id="t1"]')
    await p.page.mouse.move(t1.left + 30, t1.top + 16)
    await p.page.mouse.down({ button: 'right' })
    await p.page.mouse.up({ button: 'right' })
    expect((await log(p)).at(-1)).toEqual({ on: 'close', why: 'outside' })
    expect(await isOpen(p)).toBe(false)
  })

  it('a secondary press on another opener with no contextmenu after it closes after 300 ms; no onSecondary, it closes at once (B11)', async () => {
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true, secondary: true, openers: '.tab, #more', openerSel: '.tab[data-id="t1"]' })
    const t2 = await rect(p, '.tab[data-id="t2"]')
    // a press with no contextmenu after it cannot come from the mouse: the catcher gets the pointerdown alone
    await p.page.evaluate(([x, y]) => { document.querySelector('.mv-catcher')!.dispatchEvent(new PointerEvent('pointerdown', { button: 2, clientX: x, clientY: y, bubbles: true })) }, [t2.left + 30, t2.top + 16])
    await sleep(100)
    expect(await isOpen(p)).toBe(true)
    await sleep(300)
    expect(await log(p)).toEqual([{ on: 'close', why: 'outside' }])
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true, openerSel: '.tab[data-id="t1"]' })
    await p.page.mouse.move(t2.left + 30, t2.top + 16)
    await p.page.mouse.down({ button: 'right' })
    await p.page.mouse.up({ button: 'right' })
    expect(await log(p)).toEqual([{ on: 'close', why: 'outside' }])
  })

  it('a Control-click on another opener counts as a secondary press (B11)', async () => {
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true, secondary: true, openers: '.tab, #more', openerSel: '.tab[data-id="t1"]' })
    const t2 = await rect(p, '.tab[data-id="t2"]')
    await p.page.mouse.move(t2.left + 30, t2.top + 16)
    await p.page.keyboard.down('Control')
    await p.page.mouse.down()
    await p.page.mouse.up()
    await p.page.keyboard.up('Control')
    await sleep(50)
    // the catcher read the press as secondary and held the menu for its contextmenu, where a primary press closes
    expect((await log(p)).filter((e) => e.on === 'close')).toEqual([])
    expect(await isOpen(p)).toBe(true)
    await sleep(350)
  })

  it('places by B7: never above 44, clamped 14 px from both edges by its measured width, upward near the foot, right-aligned by origin', async () => {
    for (const y of [4, 20, 40]) {
      await open(p, { rows: ROWS, at: { x: 100, y }, top: 44, solid: true })
      expect((await rect(p, '.mv-menu')).top).toBe(44)
    }
    await open(p, { rows: ROWS, at: { x: -50, y: 60 }, top: 44, solid: true })
    expect((await rect(p, '.mv-menu')).left).toBe(14)
    await open(p, { rows: [{ kind: 'item', id: 'long', label: 'A long, long canvas name - Not responding', enabled: true }], at: { x: 1270, y: 60 }, top: 44, solid: true })
    const wide = await rect(p, '.mv-menu')
    expect(wide.right).toBeCloseTo(1280 - 14, 0)
    expect(wide.width).toBeGreaterThan(200)
    await open(p, { rows: ROWS, at: { x: 100, y: 780 }, top: 44 })
    const up = await rect(p, '.mv-menu')
    expect(await p.page.getAttribute('.mv-menu', 'data-side')).toBe('up')
    expect(up.bottom).toBeCloseTo(780, 0)
    expect((await css(p, '.mv-menu', ['transform-origin']))['transform-origin']).toBe(`0px ${up.height}px`)
    await open(p, { rows: ROWS, at: { x: 600, y: 100, origin: 'top right' }, top: 44 })
    const right = await rect(p, '.mv-menu')
    expect(right.right).toBeCloseTo(600, 0)
    expect((await css(p, '.mv-menu', ['transform-origin']))['transform-origin']).toBe(`${right.width}px 0px`)
    // `up` prefers upward: the bottom at the anchor
    await open(p, { rows: ROWS, at: { x: 300, y: 500, up: true }, top: 44 })
    expect((await rect(p, '.mv-menu')).bottom).toBeCloseTo(500, 0)
  })

  it('at 720 x 480 a 30-row menu is capped, its rows scroll, and arrowing to the last row scrolls it into view (B7.3, B7.4)', async () => {
    await p.resize(720, 480)
    try {
      await open(p, { rows: Array.from({ length: 30 }, (_, i) => ({ kind: 'item' as const, id: `tab:t${i}`, label: `Canvas ${i} - Stopped`, enabled: true })), at: { x: 680, y: 30 }, top: 44, solid: true, focusFirst: true })
      const m = await rect(p, '.mv-menu')
      expect(m.top).toBe(44)
      expect(m.bottom).toBeLessThanOrEqual(480 - 14 + 0.5)
      expect(m.right).toBeLessThanOrEqual(720 - 14 + 0.5)
      expect(await p.page.evaluate(() => { const r = document.querySelector('.mv-menu-rows')!; return r.scrollHeight > r.clientHeight })).toBe(true)
      await p.page.keyboard.press('ArrowUp')
      expect(await focused(p)).toBe('tab:t29')
      const last = await rect(p, '[data-id="tab:t29"]'), list = await rect(p, '.mv-menu-rows')
      expect(last.bottom).toBeLessThanOrEqual(list.bottom + 0.5)
      expect(last.top).toBeGreaterThanOrEqual(list.top - 0.5)
    } finally {
      await p.resize(1280, 800)
    }
  })

  it('deferred: rendered hidden until show(), then placed for the viewport it shows in, after one frame (B3.3)', async () => {
    await open(p, { rows: ROWS, at: { x: 100, y: 700 }, top: 44, solid: true, defer: true, focusFirst: true })
    expect(await css(p, '.mv-menu', ['visibility'])).toEqual({ visibility: 'hidden' })
    expect(await p.page.locator('.mv-row:focus').count()).toBe(0)
    await p.page.evaluate(() => window.kit.m!.show())
    expect(await css(p, '.mv-menu', ['visibility'])).toEqual({ visibility: 'visible' })
    expect(await focused(p)).toBe('open-browser')
    expect((await rect(p, '.mv-menu')).bottom).toBeLessThanOrEqual(786.5)
  })

  it('every frame wait is rAF or 50 ms, whichever first (B16)', async () => {
    // a page whose rAF never fires (an unfocused window's): show() still lands within the timer
    const ms = await p.page.evaluate(async () => {
      const raf = window.requestAnimationFrame
      window.requestAnimationFrame = () => 0
      try {
        window.kit.menu({ rows: window.kit.rowsOf(3), at: { x: 10, y: 60 }, top: 44, defer: true })
        const t = performance.now()
        await window.kit.m!.show()
        return performance.now() - t
      } finally { window.requestAnimationFrame = raf }
    })
    expect(ms).toBeGreaterThanOrEqual(45)
    expect(ms).toBeLessThan(400)
    expect(await css(p, '.mv-menu', ['visibility'])).toEqual({ visibility: 'visible' })
  })

  it('the harness: resize() resolves once both axes have landed, a height-only resize included (F4)', async () => {
    for (const [w, hh] of [[1280, 44], [1280, 800], [1280, 44], [1280, 800]] as const) {
      await p.resize(w, hh)
      expect(await p.page.evaluate(() => [innerWidth, innerHeight])).toEqual([w, hh])
    }
  })

  it('needs no inline style: no CSP refusal on the page', async () => {
    expect(await p.csp()).toEqual([])
  })
})

describe('the strip\'s token block and focus looks (E1, E7)', () => {
  let p: PageRun
  beforeAll(async () => {
    p = await openProof('kit-strip.html', { bundle: 'kit.ts', width: 900, height: 300 })
    await ready(p)
    await p.page.evaluate(() => {
      const f = document.getElementById('fixture')!
      for (const [id, on] of [['t1', false], ['t2', true]] as const) {
        const t = document.createElement('div'); t.className = `tab${on ? ' on' : ''}`; t.dataset.id = id; t.tabIndex = 0; t.setAttribute('role', 'tab')
        const face = document.createElement('span'); face.className = 'face'; face.textContent = id; t.append(face); f.append(t)
      }
    })
  })
  afterAll(async () => { await p?.close() })

  it('E1: the --ts-* tokens and the menu interface, light and dark', async () => {
    const names = ['--ts-panel-look', '--ts-face-hover', '--ts-kbd-bg', '--mv-menu-fill', '--mv-menu-blur', '--mv-menu-accent', '--mv-menu-hover']
    await look(p, false)
    expect(await tokens(p, names)).toEqual({ '--ts-panel-look': '#f6f7f9', '--ts-face-hover': 'rgba(231, 233, 239, .9)', '--ts-kbd-bg': 'rgba(24, 24, 27, .06)', '--mv-menu-fill': '#f6f7f9', '--mv-menu-blur': 'none', '--mv-menu-accent': '#0088ff', '--mv-menu-hover': 'rgba(24, 24, 27, .05)' })
    expect((await tokens(p, ['--ts-shadow-lit']))['--ts-shadow-lit']).toBe('inset 0 1px 0 rgba(255, 255, 255, .7), 0 1px 1.5px rgba(24, 24, 27, .05), 0 3px 8px -4px rgba(24, 24, 27, .1)')
    await look(p, true)
    expect(await tokens(p, names)).toEqual({ '--ts-panel-look': '#101116', '--ts-face-hover': '#26272d', '--ts-kbd-bg': 'rgba(255, 255, 255, .1)', '--mv-menu-fill': '#101116', '--mv-menu-blur': 'none', '--mv-menu-accent': '#0088ff', '--mv-menu-hover': 'rgba(255, 255, 255, .1)' })
    expect((await tokens(p, ['--ts-shadow-lit', '--ts-edge-dark']))).toEqual({
      '--ts-shadow-lit': 'inset 0 1px 0 rgba(255, 255, 255, .1), 0 1px 2px rgba(0, 0, 0, .35), 0 4px 12px -6px rgba(0, 0, 0, .5)',
      '--ts-edge-dark': 'linear-gradient(155deg, rgba(255, 255, 255, .46), rgba(255, 255, 255, .1) 30%, rgba(255, 255, 255, .04) 65%, rgba(255, 255, 255, .24))',
    })
  })

  it('E7: keyboard focus on a tab rings its face (radius 999, over its state shadow), never the tab; light and dark', async () => {
    for (const dark of [false, true]) {
      await look(p, dark)
      // a mouse focus draws no ring; Shift+Tab from it is a keyboard focus
      await p.page.click('.tab[data-id="t2"]')
      expect((await css(p, '.tab[data-id="t2"] .face', ['outline-style']))['outline-style']).toBe('none')
      await p.page.keyboard.press('Shift+Tab')
      expect(await focused(p)).toBe('t1')
      expect(await css(p, '.tab[data-id="t1"]', ['outline-style', 'box-shadow'])).toEqual({ 'outline-style': 'none', 'box-shadow': 'none' })
      const face = await css(p, '.tab[data-id="t1"] .face', ['outline-style', 'outline-width', 'outline-color', 'outline-offset', 'border-top-left-radius', 'box-shadow', 'background-color'])
      expect(face).toMatchObject({ 'outline-style': 'solid', 'outline-width': '1px', 'outline-color': 'rgb(0, 136, 255)', 'outline-offset': '1px', 'border-top-left-radius': '999px' })
      expect(face['box-shadow'].startsWith(dark ? 'rgba(0, 136, 255, 0.32) 0px 0px 0px 4px, ' : 'rgba(0, 136, 255, 0.2) 0px 0px 0px 4px, ')).toBe(true)
      expect(face['box-shadow']).toContain(dark ? 'rgba(0, 0, 0, 0.35) 0px 1px 2px 0px' : 'rgba(24, 24, 27, 0.05) 0px 1px 1.5px 0px')
      // and its hover look
      expect(face['background-color']).toBe(dark ? 'rgb(38, 39, 45)' : 'rgba(231, 233, 239, 0.9)')
    }
  })

  it('E7: a keyboard-focused menu row has no outline and no ring: its fill is its focus', async () => {
    await look(p, false)
    await p.page.keyboard.press('Tab')
    await open(p, { rows: ROWS, at: { x: 100, y: 60 }, top: 44, solid: true, focusFirst: true })
    await p.page.keyboard.press('ArrowDown')
    expect(await p.page.evaluate(() => document.activeElement?.matches(':focus-visible'))).toBe(true)
    expect(await css(p, '.mv-row:focus', ['outline-style', 'box-shadow', 'background-color'])).toEqual({ 'outline-style': 'none', 'box-shadow': 'none', 'background-color': 'rgba(24, 24, 27, 0.05)' })
    await p.page.keyboard.press('Escape')
  })
})

describe('Home\'s token block, menu glass and focus looks (E1, E2, E7)', () => {
  let p: PageRun
  beforeAll(async () => {
    p = await openProof('kit-home.html', { bundle: 'kit.ts', width: 1280, height: 800 })
    await ready(p)
    await p.page.evaluate(() => {
      const f = document.getElementById('fixture')!
      const link = document.createElement('div'); link.className = 'hm-link'; const input = document.createElement('input'); input.dataset.id = 'field'; link.append(input); f.append(link)
      for (const [id, board] of [['c1', false], ['c2', true]] as const) {
        const wrap = document.createElement('div'); if (board) wrap.className = 'hm-col'
        const card = document.createElement('div'); card.className = 'hm-card'; card.dataset.id = id; card.tabIndex = 0
        const more = document.createElement('button'); more.className = 'hm-more-btn'; more.dataset.id = `${id}-more`; card.append(more); wrap.append(card); f.append(wrap)
      }
    })
  })
  afterAll(async () => { await p?.close() })

  it('E1: the --hm-* tokens, light and dark (the accent stays #0088ff; the focused field\'s is #5cb3ff in dark)', async () => {
    const names = ['--hm-ground', '--hm-ink', '--hm-ink-3', '--hm-card', '--hm-hair-2', '--hm-ask', '--hm-new', '--hm-live', '--hm-off', '--hm-accent', '--hm-field-accent', '--hm-accent-ring']
    await look(p, false)
    expect(await tokens(p, names)).toEqual({
      '--hm-ground': '#eceef3', '--hm-ink': '#18181b', '--hm-ink-3': 'rgba(24, 24, 27, .4)', '--hm-card': 'rgba(255, 255, 255, .5)', '--hm-hair-2': 'rgba(24, 24, 27, .12)',
      '--hm-ask': '#f08a00', '--hm-new': '#0077e6', '--hm-live': '#8b5cf6', '--hm-off': 'rgba(24, 24, 27, .28)', '--hm-accent': '#0088ff', '--hm-field-accent': '#0088ff', '--hm-accent-ring': 'rgba(0, 136, 255, .16)',
    })
    await look(p, true)
    expect(await tokens(p, names)).toEqual({
      '--hm-ground': '#131418', '--hm-ink': '#f5f5f7', '--hm-ink-3': 'rgba(245, 245, 247, .38)', '--hm-card': 'rgba(255, 255, 255, .045)', '--hm-hair-2': 'rgba(255, 255, 255, .14)',
      '--hm-ask': '#ff9f0a', '--hm-new': '#5cb3ff', '--hm-live': '#a78bfa', '--hm-off': 'rgba(255, 255, 255, .3)', '--hm-accent': '#0088ff', '--hm-field-accent': '#5cb3ff', '--hm-accent-ring': 'rgba(92, 179, 255, .18)',
    })
    expect((await tokens(p, ['--hm-glow']))['--hm-glow']).toContain('rgba(40, 90, 200, .26)')
  })

  it('B6: Home\'s menus wear its glass (blurred, see-through), the check #0088ff in light and dark, the Update row in --hm-new', async () => {
    const rows: MenuRow[] = [
      { kind: 'header', label: 'View' },
      { kind: 'item', id: 'grid', label: 'Grid', icon: 'grid', enabled: true, checked: true },
      { kind: 'item', id: 'update', label: 'Update to 0.32.0', icon: 'arrow-up', enabled: true, update: true },
    ]
    await look(p, false)
    await open(p, { rows, at: { x: 1000, y: 100, origin: 'top right' }, top: 44 })
    expect(await css(p, '.mv-menu', ['background-color', 'backdrop-filter', 'border-top-color'])).toEqual({ 'background-color': 'rgba(255, 255, 255, 0.7)', 'backdrop-filter': 'blur(20px) saturate(1.5)', 'border-top-color': 'rgba(24, 24, 27, 0.1)' })
    expect((await css(p, '.mv-check', ['color'])).color).toBe('rgb(0, 136, 255)')
    expect((await css(p, '[data-id="update"]', ['color'])).color).toBe('rgb(0, 119, 230)')
    expect(await css(p, '.mv-menu-h', ['font-size', 'font-weight', 'padding-top', 'padding-left', 'color'])).toEqual({ 'font-size': '11px', 'font-weight': '600', 'padding-top': '7px', 'padding-left': '10px', color: 'rgba(24, 24, 27, 0.4)' })
    expect((await css(p, '.mv-menu', ['background-image'], '::after'))['background-image']).toContain('rgba(24, 24, 27, 0.05) 65%')
    await look(p, true)
    await open(p, { rows, at: { x: 1000, y: 100, origin: 'top right' }, top: 44 })
    expect(await css(p, '.mv-menu', ['background-color', 'backdrop-filter', 'border-top-color'])).toEqual({ 'background-color': 'rgba(22, 22, 28, 0.86)', 'backdrop-filter': 'blur(20px) saturate(1.5)', 'border-top-color': 'rgba(255, 255, 255, 0.16)' })
    expect((await css(p, '.mv-check', ['color'])).color).toBe('rgb(0, 136, 255)')
    expect((await css(p, '[data-id="update"]', ['color'])).color).toBe('rgb(92, 179, 255)')
    await p.page.evaluate(() => window.kit.m?.close())
  })

  it('E7: the link input draws no ring; a focused card rings in the field accent over its state shadow and shows its more button; light and dark', async () => {
    for (const dark of [false, true]) {
      await look(p, dark)
      await p.page.click('.hm-link input')
      expect(await focused(p)).toBe('field')
      expect(await css(p, '.hm-link input', ['outline-style', 'box-shadow'])).toEqual({ 'outline-style': 'none', 'box-shadow': 'none' })
      await p.page.keyboard.press('Tab')
      expect(await focused(p)).toBe('c1')
      const accent = dark ? 'rgb(92, 179, 255)' : 'rgb(0, 136, 255)'
      const ring = dark ? 'rgba(92, 179, 255, 0.18) 0px 0px 0px 4px' : 'rgba(0, 136, 255, 0.16) 0px 0px 0px 4px'
      const card = await css(p, '[data-id="c1"]', ['outline-color', 'outline-style', 'outline-offset', 'box-shadow'])
      expect(card).toMatchObject({ 'outline-color': accent, 'outline-style': 'solid', 'outline-offset': '1px' })
      expect(card['box-shadow'].startsWith(`${ring}, `)).toBe(true)   // the ring, then the grid card's lift
      expect((await css(p, '[data-id="c1-more"]', ['opacity'])).opacity).toBe('1')
      expect((await css(p, '[data-id="c2-more"]', ['opacity'])).opacity).toBe('0')
      await p.page.keyboard.press('Tab')
      expect(await focused(p)).toBe('c1-more')
      expect(await css(p, '[data-id="c1-more"]', ['outline-color', 'box-shadow', 'opacity'])).toEqual({ 'outline-color': accent, 'box-shadow': ring, opacity: '1' })
      await p.page.keyboard.press('Tab')
      expect(await focused(p)).toBe('c2')
      // a board card has no lift: its ring alone
      expect((await css(p, '[data-id="c2"]', ['box-shadow']))['box-shadow']).toBe(ring)
    }
  })
})

describe('logos trimmed in the renderer, and the app mark (E4, E6)', () => {
  let p: PageRun
  beforeAll(async () => {
    p = await openProof('kit-home.html', { bundle: 'kit.ts', width: 800, height: 400 })
    await ready(p)
  })
  afterAll(async () => { await p?.close() })

  type Box = { w: number; h: number; x0: number; y0: number; width: number; height: number }
  const trim = (name: string) => p.page.evaluate(async (n) => {
    const kit = window.kit as unknown as { fixtures(): Record<string, string>; trimLogo(s: string): Promise<{ src: string; cover: boolean }>; inkBox(s: string): Promise<Box> }
    const src = kit.fixtures()[n]
    const r = await kit.trimLogo(src)
    return { cover: r.cover, same: r.src === src, box: r.src === src ? null : await kit.inkBox(r.src) }
  }, name)

  it('trims a transparent margin, a favicon\'s white square and an SVG to their mark, squared to fill the 96 px raster', async () => {
    for (const n of ['margin', 'whiteSquare', 'svg']) {
      const r = await trim(n)
      expect(r.same, n).toBe(false)
      expect(r.box!.width, n).toBe(96)
      expect(r.box!.height, n).toBe(96)
      // the mark fills the raster (square marks: both sides), so the plate's 91 / 88 % holds the mark itself
      expect(Math.max(r.box!.w, r.box!.h), n).toBeGreaterThanOrEqual(95)
    }
    // the favicon: its white ground is not ink, so the red mark (16 x 24) fills the height, keeping its aspect
    const fav = await trim('whiteSquare')
    expect(fav.box!.h).toBeGreaterThanOrEqual(95)
    expect(Math.abs(fav.box!.w - 64)).toBeLessThanOrEqual(2)   // the 2x resample blends one edge pixel each side
    expect(fav.cover).toBe(true)   // a filled rectangle covers its own bbox
    expect((await trim('margin')).cover).toBe(false)   // a circle fills ~.785 of its bbox
  })

  it('keeps a 3:1 image undistorted (contained, not stretched), and reads a 3:1 white ground as ground, never as cover', async () => {
    const wide = await trim('wide')
    // the ink band is 240 x 80 (3:1): inside the square 96 px output it stays 3:1, within a pixel
    expect(wide.box!.w).toBeGreaterThanOrEqual(95)
    expect(Math.abs(wide.box!.h - 32)).toBeLessThanOrEqual(1)
    const white = await trim('wideWhite')
    // the white ground was sampled inside the drawn rect (its dy is fractional): only the 40 x 40 mark is ink
    expect(white.cover).toBe(false)
    expect(Math.abs(white.box!.w - white.box!.h)).toBeLessThanOrEqual(1)
  })

  it('an app icon is full bleed: logo() draws it with no plate, covering the circle', async () => {
    const r = await trim('appIcon')
    expect(r.cover).toBe(true)
    const cls = await p.page.evaluate(async () => {
      const kit = window.kit as unknown as { fixtures(): Record<string, string>; draw(v: object, s: number, o: object): HTMLElement }
      const el = kit.draw({ name: 'App', logo: kit.fixtures().appIcon }, 24, { round: true, plate: 0.91 })
      const img = el.querySelector('img')!
      return { cls: el.className, fit: getComputedStyle(img).objectFit, w: img.getBoundingClientRect().width, bg: getComputedStyle(el).backgroundColor }
    })
    expect(cls).toEqual({ cls: 'logo round plate bleed', fit: 'cover', w: 24, bg: 'rgba(0, 0, 0, 0)' })
  })

  it('a tainting SVG and a viewBox-only SVG each settle: no plate is left empty', async () => {
    const out = await p.page.evaluate(async () => {
      const kit = window.kit as unknown as { fixtures(): Record<string, string>; trimLogo(s: string): Promise<{ src: string; cover: boolean }>; draw(v: object, s: number, o: object): HTMLElement }
      const f = kit.fixtures()
      const els = [kit.draw({ name: 'Taint', logo: f.tainting }, 36, { round: true, plate: 0.88 }), kit.draw({ name: 'Box', logo: f.viewBoxOnly }, 36, { round: true, plate: 0.88 })]
      const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000))
      const settled = await Promise.race([Promise.all([kit.trimLogo(f.tainting), kit.trimLogo(f.viewBoxOnly)]), timeout])
      await new Promise((r) => setTimeout(r, 20))
      return { settled: settled === 'timeout' ? 'timeout' : settled.length, srcs: els.map((e) => !!e.querySelector('img')!.getAttribute('src')) }
    })
    expect(out).toEqual({ settled: 2, srcs: [true, true] })
  })

  it('a repaint while the trim is pending, then the trim landing: every img drawn since takes the trimmed src; a later repaint draws it at once', async () => {
    const out = await p.page.evaluate(async () => {
      const kit = window.kit as unknown as { draw(v: object, s: number, o: object): HTMLElement; trimLogo(s: string): Promise<{ src: string }> }
      // a fresh image, never trimmed yet
      const c = document.createElement('canvas'); c.width = c.height = 50
      const g = c.getContext('2d')!; g.fillStyle = '#e53e3e'; g.fillRect(10, 20, 30, 10)
      const src = c.toDataURL()
      const v = { name: 'Fresh', logo: src }
      const a = kit.draw(v, 24, { round: true, plate: 0.91 })
      const pendingA = a.querySelector('img')!.getAttribute('src')
      a.remove()                                      // a repaint rebuilt the node
      const b = kit.draw(v, 24, { round: true, plate: 0.91 })
      const r = await kit.trimLogo(src)
      await new Promise((res) => setTimeout(res, 0))
      const later = kit.draw(v, 24, { round: true, plate: 0.91 })
      const all = [...document.querySelectorAll(`img[data-trim="${b.querySelector('img')!.dataset.trim}"]`)].map((i) => i.getAttribute('src') === r.src)
      return { pendingA, b: b.querySelector('img')!.getAttribute('src') === r.src, later: later.querySelector('img')!.getAttribute('src') === r.src, raw: later.querySelector('img')!.getAttribute('src') === src, all, trimmed: r.src !== src }
    })
    expect(out).toEqual({ pendingA: null, b: true, later: true, raw: false, all: [true, true], trimmed: true })
  })

  it('logo()\'s string form renders as today (tab pages); the options form is round, plated at its share, initials sized per E4.3', async () => {
    const out = await p.page.evaluate(() => {
      const kit = window.kit as unknown as { fixtures(): Record<string, string>; draw(v: object, s: number, o?: unknown): HTMLElement }
      const f = kit.fixtures()
      const old = kit.draw({ name: 'Old', logo: f.margin }, 18, 'grey')
      const img = old.querySelector('img')!
      const plated = kit.draw({ name: 'Plate', logo: f.margin }, 24, { round: true, plate: 0.91 })
      const sizes = [24, 26, 30, 36].map((s) => getComputedStyle(kit.draw({ name: 'Ab', hue: 2 }, s, { round: true }).querySelector('b')!).fontSize)
      const initialsOld = getComputedStyle(kit.draw({ name: 'Ab', hue: 2 }, 18).querySelector('b')!).fontSize
      return {
        old: { cls: old.className, radius: getComputedStyle(old).borderTopLeftRadius, raw: img.getAttribute('src') === f.margin, trim: img.hasAttribute('data-trim') },
        plated: { cls: plated.className.replace(' bleed', ''), radius: getComputedStyle(plated).borderTopLeftRadius, imgW: Math.round(parseFloat(getComputedStyle(plated.querySelector('img')!).width) * 100) / 100, bg: getComputedStyle(plated).backgroundColor },
        sizes, initialsOld,
      }
    })
    expect(out).toEqual({
      old: { cls: 'logo grey', radius: '5px', raw: true, trim: false },
      plated: { cls: 'logo round plate', radius: '50%', imgW: 21.84, bg: 'rgb(255, 255, 255)' },
      sizes: ['10px', '10px', '11px', '13px'], initialsOld: '8px',
    })
  })

  it('E6: the app mark is served from pages/shared as a 256 px PNG and drawn as the design does', async () => {
    const out = await p.page.evaluate(async () => {
      const kit = window.kit as unknown as { appMark(s: number): HTMLElement }
      const el = kit.appMark(28)
      document.getElementById('fixture')!.append(el)
      const img = el.querySelector('img')!
      await img.decode()
      const r = el.getBoundingClientRect(), i = img.getBoundingClientRect()
      return { w: r.width, h: r.height, radius: getComputedStyle(el).borderTopLeftRadius, overflow: getComputedStyle(el).overflow, natural: img.naturalWidth, iw: i.width, dx: i.left - r.left }
    })
    expect(out.natural).toBe(256)
    expect(out).toMatchObject({ w: 28, h: 28, radius: '6.3px', overflow: 'hidden' })
    expect(out.iw).toBeCloseTo(28 * 1024 / 824, 1)
    expect(out.dx).toBeCloseTo(-28 * 100 / 824, 1)
    expect(await p.csp()).toEqual([])
  })
})
