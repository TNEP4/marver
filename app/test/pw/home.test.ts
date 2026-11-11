/**
 * Home v2 (spec 32 Part D), windowless: the real page and the real app preload under a fake main (test/harness/
 * pages.ts). The page's values as computed, light and dark (D1-D10); its menus - where they open, their rows, what
 * a pick sends and records, what closes them (D8); its UI state kept across renders (D11); the link field (D3) and
 * the empty state (D10). The rules of what each card says are model.ts's unit test (home-model.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { RecentView, SharedLink, TabMarks, TabView } from '../../src/shared/channels.ts'
import { animatedProperties, openPage, type PageRun } from '../harness/pages.ts'

const home: TabView = { id: 'h', kind: 'home', name: 'Home', state: 'live', verified: true, open: true }
const tab = (id: string, name: string, port: number, over: Partial<TabView> = {}): TabView =>
  ({ id, kind: 'local', name, state: 'live', verified: true, open: true, link: `http://localhost:${port}/`, folder: `~/${id}`, version: '0.31.0', ...over })
const marks = (o: Partial<TabMarks> = {}): TabMarks => ({ needs: 0, unseen: 0, working: false, session: false, ...o })
const asks = (n: number, board?: string): Partial<TabView> => ({ marks: marks({ needs: n, kinds: { ask: n, review: 0, failed: 0, stalled: 0 }, top: { kind: 'ask', ...(board ? { board } : {}) } }) })
const remote = (id: string, host: string, over: Partial<TabView> = {}): TabView => ({ id, kind: 'remote', name: host, state: 'live', verified: false, open: true, link: `https://${host}/`, hue: 2, ...over })

const BUSY: TabView[] = [
  home,
  tab('asteria', 'Asteria', 4805, asks(2, 'Vault feed')),
  tab('calepin', 'Calepin', 4806, { ...asks(6, 'Filter v3'), update: '0.32.0' }),
  tab('ambient', 'Ambient agent', 4807, { marks: marks({ working: true, work: { board: 'Onboarding', since: Date.now() - 4 * 60_000 } }) }),
  tab('aperture', 'Aperture', 4808, { marks: marks({ unseen: 12 }) }),
  tab('os', 'OS', 4809),
  tab('gone', 'Grindr creative swap', 4810, { state: 'gone' }),
  remote('deck', 'deck.example.com'),
]
const RECENT: RecentView[] = [
  { id: 'r_0000000000000001', name: 'Newsletter', folder: '~/newsletter', lastSeen: Date.now() - 19 * 3600_000 },
  { id: 'r_0000000000000002', name: 'Fauna Robotics', folder: '~/robotics', lastSeen: Date.now() - 5 * 86_400_000 },
]
const SHARED: SharedLink[] = [{ id: 's_00000000000000aa', url: 'https://hertz.example.com/#/b/flow', host: 'hertz.example.com', lastSeen: Date.now() - 3 * 86_400_000 }]

let p: PageRun
let rev = 0
const readyCalls: unknown[] = []
beforeAll(async () => {
  p = await openPage('home', { width: 1280, height: 800 })
  p.page.setDefaultTimeout(5000)
  readyCalls.push(...await p.calls('app:ready'))
})
afterAll(async () => { await p?.close() })
beforeEach(async () => {
  await p.clear()
  await p.answer('link:open', { ok: true })
  await p.answer('home:action', { ok: true })
})

const tabs = (list: TabView[], active = 'h') => p.send('tabs', { rev: ++rev, active, tabs: list })
async function world(o: { tabs?: TabView[]; recent?: RecentView[]; shared?: SharedLink[]; view?: 'grid' | 'board'; dark?: boolean; size?: [number, number] } = {}) {
  await closeAll()
  if (o.size) await p.resize(...o.size)
  await look(!!o.dark)
  await p.send('recent', o.recent ?? [])
  await p.send('shared', o.shared ?? [])
  await tabs(o.tabs ?? [home])
  if (o.view) await setView(o.view)
}
async function closeAll() {
  await p.page.evaluate(() => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    document.querySelector<HTMLElement>('.mv-catcher')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  })
  await p.page.keyboard.press('Escape')
  await p.page.mouse.move(1, 470)
}
const look = async (dark: boolean) => {
  await p.media({ 'prefers-color-scheme': dark ? 'dark' : 'light' })
  await p.page.waitForFunction((d) => document.documentElement.classList.contains('dark') === d, dark)
}
async function setView(v: 'grid' | 'board') {
  if (await p.page.$(`.hm-body.${v}`)) return
  await p.page.click('[data-key="view"]')
  await pickByPointer(v)
  await p.page.waitForSelector(`.hm-body.${v}`, { timeout: 3000 })
  await p.page.mouse.move(1, 470)
}
const css = (sel: string, props: string[], pseudo?: string) => p.page.evaluate(([s, ps, pe]) => {
  const el = document.querySelector(s as string)
  if (!el) throw new Error(`no ${s as string}`)
  const cs = getComputedStyle(el, (pe as string) || null)
  return Object.fromEntries((ps as string[]).map((k) => [k, cs.getPropertyValue(k).trim()]))
}, [sel, props, pseudo ?? ''] as const)
const rect = (sel: string) => p.page.evaluate(async (s) => {
  // the pops and transitions settled; never an infinite one (the working dot's pulse)
  await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)))
  const el = document.querySelector(s)
  if (!el) throw new Error(`no ${s}`)
  const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
}, sel)
const text = (sel: string) => p.page.$eval(sel, (e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim())
const texts = (sel: string) => p.page.$$eval(sel, (els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()))
const menuRows = () => p.page.$$eval('.mv-menu .mv-row, .mv-menu .mv-sep, .mv-menu .mv-menu-h', (els) => els.map((e) => (e.classList.contains('mv-sep') ? '-' : (e as HTMLElement).innerText.trim())))
const menuOpen = () => p.page.evaluate(() => !!document.querySelector('.mv-menu'))
const focusedRow = () => p.page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id ?? null)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** a right-click as the pointer makes it (pointerdown, up, then contextmenu), at a point */
const rightClick = async (x: number, y: number) => { await p.page.mouse.move(x, y); await p.page.mouse.down({ button: 'right' }); await p.page.mouse.up({ button: 'right' }) }
/** a pick by pointer: menu.ts picks a mouseup only after a pointermove over the menu, 250 ms after it showed */
const pickByPointer = async (id: string) => {
  await sleep(280)
  const r = await rect(`.mv-row[data-id="${id}"]`)
  await p.page.mouse.move(r.left + 20, r.top + 10, { steps: 2 })
  await p.page.mouse.down(); await p.page.mouse.up()
}

describe('D1, D2, D10: the page, its header, the empty state', () => {
  it('says app:ready once its script runs; loads under the CSP with nothing refused', async () => {
    expect(readyCalls).toEqual([null])
    expect(await p.csp()).toEqual([])
  })

  it('D10: the empty state is the welcome - the mark, its words, three ways in, "?" at the foot; no header', async () => {
    await world()
    expect(await p.page.$('.hm-head')).toBeNull()
    expect(await text('.hm-empty-in h2')).toBe('No canvas running yet')
    expect(await text('.hm-empty-in > p')).toBe('Start one from its repo and it opens here, in its own tab.')
    expect(await texts('.hm-empty-steps .hm-name')).toEqual(['In a repo with Marver', 'A repo without Marver yet', 'A canvas someone shared with you'])
    expect(await texts('.hm-cmd > span')).toEqual(['npx marver dev', 'npm i -D @marver-design/marver && npx marver init'])
    expect(await p.page.$('.hm-empty-link .hm-link input#link')).not.toBeNull()
    expect(await css('.hm-empty-in .mv-mark', ['width', 'border-radius'])).toEqual({ width: '64px', 'border-radius': '14.4px' })
    expect(await css('.hm-empty-in h2', ['font-size', 'font-weight', 'letter-spacing', 'margin-top'])).toEqual({ 'font-size': '26px', 'font-weight': '680', 'letter-spacing': '-0.52px', 'margin-top': '6px' })
    expect(await css('.hm-empty', ['padding-bottom', 'overflow-y', 'place-items'])).toEqual({ 'padding-bottom': '76px', 'overflow-y': 'auto', 'place-items': 'safe center' })
    const q = await rect('.hm-float')
    expect([q.width, 1280 - q.right, 800 - q.bottom]).toEqual([34, 14, 14])
    // no welcome card, whatever home:info says (D10: the empty state is the welcome)
    await p.send('home:info', { welcome: true, writable: true })
    expect(await p.page.$('.welcome')).toBeNull()
  })

  it('D10.5: the CopyLabel copies through main by id and reads Copied (in its done colours) for 2 s', async () => {
    await world()
    await p.page.click('[data-key="cp:dev"]')
    await p.page.click('[data-key="cp:init"]')
    expect(await p.calls('home:action')).toEqual([{ action: 'copy', id: 'dev' }, { action: 'copy', id: 'init' }])
    await p.page.waitForSelector('[data-key="cp:dev"].done')
    await p.page.waitForFunction(() => getComputedStyle(document.querySelector('[data-key="cp:dev"] .b')!).opacity === '1')
    expect(await css('[data-key="cp:dev"]', ['color', 'background-color', 'cursor'])).toEqual({ color: 'rgb(31, 157, 85)', 'background-color': 'rgba(52, 199, 89, 0.16)', cursor: 'pointer' })
    await p.page.waitForSelector('[data-key="cp:dev"]:not(.done)', { timeout: 3000 })
    // a copy main refuses never reads Copied
    await p.answer('home:action', { ok: false })
    await p.page.click('[data-key="cp:dev"]')
    await sleep(80)
    expect(await p.page.$('[data-key="cp:dev"].done')).toBeNull()
  })

  it('D2: the brand, the field, View and Help, in order; the icon buttons as rendered (34 round, transparent, ink-3, pointer, "?" 400 16 px)', async () => {
    await world({ tabs: BUSY, view: 'grid' })
    expect(await p.page.$$eval('.hm-head > *', (els) => els.map((e) => e.className))).toEqual(['hm-brand', 'hm-sp', 'hm-slot', 'hm-icon', 'hm-icon hm-q'])
    expect(await text('h1.hm-brand')).toBe('Marver')
    expect(await css('.hm-brand', ['font-size', 'font-weight', 'gap'])).toEqual({ 'font-size': '19px', 'font-weight': '680', gap: '9px' })
    expect(await css('.hm-brand .mv-mark', ['width'])).toEqual({ width: '28px' })
    expect(await css('[data-key="view"]', ['width', 'height', 'border-radius', 'background-color', 'border-top-width', 'color', 'cursor'])).toEqual({
      width: '34px', height: '34px', 'border-radius': '50%', 'background-color': 'rgba(0, 0, 0, 0)', 'border-top-width': '0px', color: 'rgba(24, 24, 27, 0.4)', cursor: 'pointer',
    })
    expect(await p.page.getAttribute('[data-key="view"]', 'aria-haspopup')).toBe('menu')
    expect(await css('[data-key="help"]', ['font-weight', 'font-size', 'cursor'])).toEqual({ 'font-weight': '400', 'font-size': '16px', cursor: 'pointer' })
    expect(await p.page.getAttribute('[data-key="help"]', 'title')).toBe('How Marver runs')
    // hover: glass, ink (light); dark its own fill and highlight
    await p.page.hover('[data-key="view"]')
    await sleep(250)
    expect(await css('[data-key="view"]', ['background-image', 'box-shadow', 'color', 'backdrop-filter'])).toEqual({
      'background-image': 'linear-gradient(155deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.55) 50%, rgba(255, 255, 255, 0.3))',
      'box-shadow': 'rgba(255, 255, 255, 0.95) 0px 1px 0px 0px inset', color: 'rgb(24, 24, 27)', 'backdrop-filter': 'blur(16px) saturate(1.5)',
    })
    await look(true)
    await sleep(250)
    expect(await css('[data-key="view"]', ['background-color', 'box-shadow', 'color'])).toEqual({ 'background-color': 'rgba(255, 255, 255, 0.08)', 'box-shadow': 'rgba(255, 255, 255, 0.08) 0px 1px 0px 0px inset', color: 'rgb(245, 245, 247)' })
    await look(false)
  })

  it('D1: the ground and its glow, no dots; the body 14 px from the edges, 22 px under the strip; the grid scrolls, the board does not', async () => {
    await world({ tabs: BUSY, view: 'grid' })
    const bg = await css('body', ['background-image', 'background-color'])
    expect(bg['background-color']).toBe('rgb(236, 238, 243)')
    expect(bg['background-image']).toContain('rgba(120, 165, 255, 0.2)')
    expect(bg['background-image']).not.toContain('1px, transparent 1px')
    expect(await css('.hm-body', ['top', 'padding-top', 'padding-left', 'padding-right', 'overflow-y'])).toEqual({ top: '44px', 'padding-top': '22px', 'padding-left': '14px', 'padding-right': '14px', 'overflow-y': 'auto' })
    await setView('board')
    expect((await css('.hm-body', ['overflow-y']))['overflow-y']).toBe('hidden')
    expect((await css('.hm-head', ['padding-left']))['padding-left']).toBe('15px')
    await look(true)
    expect((await css('body', ['background-color']))['background-color']).toBe('rgb(19, 20, 24)')
    await look(false)
  })
})

describe('D4, D5, D7: the grid, the card and the board', () => {
  it('D4: sections "Running N", "Not running N", "Shared with you"; four across; an empty section is left out', async () => {
    await world({ tabs: BUSY, recent: RECENT, shared: SHARED, view: 'grid' })
    expect(await texts('.hm-sec')).toEqual(['Running 5', 'Not running 3', 'Shared with you'])
    expect(await css('.hm-sec', ['font-size', 'font-weight', 'letter-spacing', 'margin-bottom'])).toEqual({ 'font-size': '11.5px', 'font-weight': '600', 'letter-spacing': '0.23px', 'margin-bottom': '10px' })
    expect((await css('.hm-grid', ['grid-template-columns']))['grid-template-columns'].split(' ')).toHaveLength(4)
    expect(await css('.hm-grid', ['column-gap', 'margin-bottom'])).toEqual({ 'column-gap': '12px', 'margin-bottom': '26px' })
    // the order inside Running: column priority, then strip order
    expect(await p.page.$$eval('.hm-grid', (els) => [...els[0]!.querySelectorAll('.hm-name')].map((e) => e.textContent))).toEqual(['Asteria', 'Calepin', 'Ambient agent', 'Aperture', 'OS'])
    await world({ tabs: [home, tab('os', 'OS', 4809)], view: 'grid' })
    expect(await texts('.hm-sec')).toEqual(['Running 1'])
  })

  it('D5: a card as drawn - its lines, counts leading in their colour, dots purple and grey; names "<name>, <line>"', async () => {
    await world({ tabs: BUSY, recent: RECENT, shared: SHARED, view: 'grid' })
    const line = (id: string) => text(`[data-card="${id}"] .hm-line`)
    expect(await line('asteria')).toBe('2 questions on Vault feed')
    expect(await line('ambient')).toBe('Agent working on Onboarding · 4 min')
    expect(await line('aperture')).toBe('12 new frames to look at')
    expect(await line('os')).toBe('Running')
    expect(await line('gone')).toBe('Stopped')
    expect(await line('r_0000000000000001')).toBe('Ran 19 hours ago')
    expect(await line('deck')).toBe('Open')
    expect(await line('s_00000000000000aa')).toBe('Opened 3 days ago')
    expect(await p.page.getAttribute('[data-card="asteria"]', 'aria-label')).toBe('Asteria, 2 questions on Vault feed')
    expect(await p.page.getAttribute('[data-card="asteria"]', 'role')).toBe('button')
    expect(await p.page.getAttribute('[data-more="asteria"]', 'aria-label')).toBe('More for Asteria')
    expect(await css('[data-card="asteria"] .hm-num', ['color', 'font-weight'])).toEqual({ color: 'rgb(240, 138, 0)', 'font-weight': '700' })
    expect((await css('[data-card="aperture"] .hm-num', ['color'])).color).toBe('rgb(0, 119, 230)')
    expect(await p.page.$('[data-card="asteria"] .hm-dot')).toBeNull()                // the count leads: no dot
    expect((await css('[data-card="os"] .hm-dot', ['background-color']))['background-color']).toBe('rgb(139, 92, 246)')
    expect((await css('[data-card="gone"] .hm-dot', ['background-color']))['background-color']).toBe('rgba(24, 24, 27, 0.28)')
    expect(await p.page.$('[data-card="deck"] .hm-dot')).toBeNull()                    // shared canvases: no dot
    expect(await css('[data-card="os"]', ['border-radius', 'padding-top', 'padding-left', 'background-color', 'border-top-color', 'backdrop-filter', 'box-shadow', 'cursor'])).toEqual({
      'border-radius': '18px', 'padding-top': '12px', 'padding-left': '12px', 'background-color': 'rgba(255, 255, 255, 0.5)', 'border-top-color': 'rgba(24, 24, 27, 0.07)',
      'backdrop-filter': 'blur(24px) saturate(1.6)', 'box-shadow': 'none', cursor: 'pointer',
    })
    expect(await css('[data-card="os"] .hm-name', ['font-size', 'font-weight'])).toEqual({ 'font-size': '14px', 'font-weight': '600' })
    expect(await css('[data-card="os"] .hm-line', ['font-size', 'color'])).toEqual({ 'font-size': '12.5px', color: 'rgba(24, 24, 27, 0.62)' })
    expect((await css('[data-card="os"] .logo', ['width']))).toEqual({ width: '36px' })
    // the more button: hidden at rest, transparent and ink as rendered; shown on hover, pressed while its menu is open
    expect(await css('[data-more="os"]', ['opacity', 'width', 'background-color', 'color', 'cursor'])).toEqual({ opacity: '0', width: '24px', 'background-color': 'rgba(0, 0, 0, 0)', color: 'rgb(24, 24, 27)', cursor: 'pointer' })
    // not running: the logo greyed, back to colour on hover
    expect(await css('[data-card="r_0000000000000001"] .logo', ['filter', 'opacity'])).toEqual({ filter: 'grayscale(0.85)', opacity: '0.55' })
    await p.page.hover('[data-card="r_0000000000000001"]')
    expect(await css('[data-card="r_0000000000000001"] .logo', ['filter', 'opacity'])).toEqual({ filter: 'none', opacity: '1' })   // no transition
    await sleep(250)
    expect((await css('[data-more="r_0000000000000001"]', ['opacity'])).opacity).toBe('1')
  })

  it('D5: hover never changes a card\'s size; light gradient and ink rim, dark lit glass and the white rim (.6 when not running)', async () => {
    await world({ tabs: BUSY, recent: RECENT, view: 'grid' })
    const before = await rect('[data-card="os"]')
    await p.page.hover('[data-card="os"]')
    await p.page.waitForTimeout(200)
    expect(await rect('[data-card="os"]')).toEqual(before)
    expect(await css('[data-card="os"]', ['background-image', 'border-top-color', 'box-shadow'])).toEqual({
      'background-image': 'linear-gradient(155deg, rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.7) 45%, rgba(255, 255, 255, 0.38))',
      'border-top-color': 'rgba(24, 24, 27, 0.05)', 'box-shadow': 'rgba(255, 255, 255, 0.95) 0px 1px 0px 0px inset',
    })
    expect(await css('[data-card="os"]', ['opacity', 'background-image'], '::after')).toEqual({ opacity: '1', 'background-image': 'linear-gradient(155deg, rgba(24, 24, 27, 0.15), rgba(24, 24, 27, 0.05) 30%, rgba(24, 24, 27, 0.03) 65%, rgba(24, 24, 27, 0.1))' })
    await look(true)
    await p.page.waitForTimeout(200)
    expect(await css('[data-card="os"]', ['background-color', 'border-top-color'])).toEqual({ 'background-color': 'rgba(255, 255, 255, 0.086)', 'border-top-color': 'rgba(255, 255, 255, 0.18)' })
    await p.page.hover('[data-card="r_0000000000000001"]')
    await p.page.waitForTimeout(200)
    expect((await css('[data-card="r_0000000000000001"]', ['opacity'], '::after')).opacity).toBe('0.6')
    await look(false)
  })

  it('D7: five columns with their dots and empty texts; the board\'s height its calc; cards 15 radius, 30 logos, no dots on lines; chips below', async () => {
    await world({ tabs: [home, tab('os', 'OS', 4809)], recent: RECENT, shared: SHARED, view: 'board' })
    expect(await texts('.hm-col-h')).toEqual(['Needs you 0', 'Agent working 0', 'Ready to review 0', 'Running 1', 'Not running 2'])
    expect(await texts('.hm-col-empty')).toEqual(['Nothing waits on you.', 'No agent at work.', 'Nothing new since you looked.'])
    const body = await rect('.hm-body')
    const board = await rect('.hm-board')
    expect(board.height).toBeCloseTo(body.height - 22 - 14 - 62 - 58, 0)
    expect(await css('.hm-col', ['border-radius', 'padding-top', 'isolation', 'background-color', 'min-height'])).toEqual({ 'border-radius': '20px', 'padding-top': '10px', isolation: 'isolate', 'background-color': 'rgba(0, 0, 0, 0)', 'min-height': '0px' })
    expect(await css('.hm-col', ['background-color', 'backdrop-filter', 'z-index'], '::before')).toEqual({ 'background-color': 'rgba(255, 255, 255, 0.56)', 'backdrop-filter': 'blur(32px) saturate(1.4)', 'z-index': '-1' })
    expect(await css('[data-card="os"]', ['border-radius', 'padding-top'])).toEqual({ 'border-radius': '15px', 'padding-top': '11px' })
    expect(await css('[data-card="os"] .logo', ['width'])).toEqual({ width: '30px' })
    expect(await css('[data-card="os"] .hm-line', ['font-size', 'line-height'])).toEqual({ 'font-size': '12px', 'line-height': '15.6px' })
    expect((await css('[data-card="os"] .hm-dot', ['display'])).display).toBe('none')
    expect((await css('.hm-col[data-col="live"] .hm-col-h .hm-dot', ['background-color']))['background-color']).toBe('rgb(139, 92, 246)')
    expect((await css('.hm-col[data-col="off"] .hm-col-h .hm-dot', ['background-color']))['background-color']).toBe('rgba(24, 24, 27, 0.28)')
    // the shared row: its label, the chips never greyed, 34 tall with a 26 logo
    expect(await text('.hm-shared .hm-sec')).toBe('Shared with you')
    expect(await css('[data-card="s_00000000000000aa"]', ['height', 'border-radius', 'cursor'])).toEqual({ height: '34px', 'border-radius': '999px', cursor: 'pointer' })
    expect(await css('[data-card="s_00000000000000aa"] .logo', ['width', 'filter'])).toEqual({ width: '26px', filter: 'none' })
    await look(true)
    expect((await css('.hm-col', ['background-color'], '::before'))['background-color']).toBe('rgba(255, 255, 255, 0.03)')
    // dark: the work dot is the accent #0088ff, the new dot #5cb3ff - they differ (04-states)
    expect((await css('.hm-col[data-col="work"] .hm-col-h .hm-dot', ['background-color']))['background-color']).toBe('rgb(0, 136, 255)')
    expect((await css('.hm-col[data-col="review"] .hm-col-h .hm-dot', ['background-color']))['background-color']).toBe('rgb(92, 179, 255)')
    await look(false)
  })

  it('D7.3: at 720 x 480 a column of 12 scrolls under its header; 8 px between cards, each as tall as alone; the last comes fully into view', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => tab(`c${i}`, `Canvas ${i}`, 4900 + i))
    await world({ tabs: [home, twelve[0]!], view: 'board', size: [720, 480] })
    const alone = (await rect('[data-card="c0"]')).height
    await tabs([home, ...twelve])
    const list = '.hm-col[data-col="live"] .hm-col-list'
    expect(await p.page.$eval(list, (e) => e.scrollHeight > e.clientHeight)).toBe(true)
    const hs = await p.page.$$eval(`${list} .hm-card`, (els) => els.map((e) => e.getBoundingClientRect().height))
    expect(new Set(hs)).toEqual(new Set([alone]))
    const [a, b] = [await rect('[data-card="c0"]'), await rect('[data-card="c1"]')]
    expect(b.top - a.bottom).toBeCloseTo(8, 1)
    await p.page.$eval(list, (e) => { e.scrollTop = e.scrollHeight })
    const last = await rect('[data-card="c11"]')
    const box = await rect(list)
    expect(last.bottom).toBeLessThanOrEqual(box.bottom)
    // the first card sits where the design draws it: 8 px under the header, the column's 10 px padding to its side
    await p.page.$eval(list, (e) => { e.scrollTop = 0 })
    const col = await rect('.hm-col[data-col="live"]')
    const first = await rect('[data-card="c0"]')
    expect(first.left - col.left).toBeCloseTo(11, 0)
    expect(first.top - (await rect('.hm-col[data-col="live"] .hm-col-h')).bottom).toBeCloseTo(8, 0)
    // its focus ring is whole on all four sides inside the scroller (5 px of room)
    await p.page.focus('[data-card="c0"]')
    await p.page.keyboard.press('Shift+Tab'); await p.page.keyboard.press('Tab')
    expect(await p.page.evaluate(() => (document.activeElement as HTMLElement).dataset.card)).toBe('c0')
    expect(first.left - 5).toBeGreaterThanOrEqual(box.left - 0.5)
    expect(first.top - 5).toBeGreaterThanOrEqual(box.top - 0.5)
    expect(box.right - first.right).toBeGreaterThanOrEqual(5 - 0.5)
    // a hovered first card wears its ring (inset -1px), inside the scroller's box with the 5 px of room
    await p.page.mouse.move(first.left + 20, first.top + 10)
    await p.page.waitForFunction(() => getComputedStyle(document.querySelector('[data-card="c0"]')!, '::after').opacity === '1')
    // the last card, scrolled to the end and focused by key: its ring is whole on all four sides too
    await p.page.$eval(list, (e) => { e.scrollTop = e.scrollHeight })
    await p.page.focus('[data-card="c11"]')
    await p.page.keyboard.press('Shift+Tab'); await p.page.keyboard.press('Tab')
    expect(await p.page.evaluate(() => (document.activeElement as HTMLElement).dataset.card)).toBe('c11')
    expect(await p.page.$eval('[data-card="c11"]', (e) => e.matches(':focus-visible'))).toBe(true)
    const end = await rect('[data-card="c11"]'), box2 = await rect(list)
    expect(box2.bottom - end.bottom).toBeGreaterThanOrEqual(5 - 0.5)
    expect(end.left - box2.left).toBeGreaterThanOrEqual(5 - 0.5)
    expect(box2.right - end.right).toBeGreaterThanOrEqual(5 - 0.5)
    await p.resize(1280, 800)
  })
})

describe('D3: the link field', () => {
  it('its states: rest, hover, focus, light and dark (the dark focused icon and key chip #5cb3ff)', async () => {
    await world({ tabs: BUSY, view: 'grid' })
    expect(await css('.hm-link', ['width', 'height', 'border-radius', 'background-color', 'border-top-color', 'backdrop-filter', 'cursor'])).toEqual({
      width: '300px', height: '34px', 'border-radius': '999px', 'background-color': 'rgba(255, 255, 255, 0.5)', 'border-top-color': 'rgba(24, 24, 27, 0.07)', 'backdrop-filter': 'blur(20px) saturate(1.5)', cursor: 'text',
    })
    expect((await css('.hm-kbd', ['opacity'])).opacity).toBe('0')
    expect(await p.page.getAttribute('#link', 'placeholder')).toBe('Open a canvas link')
    await p.page.hover('.hm-link')
    await p.page.waitForTimeout(200)
    expect(await css('.hm-link', ['background-color', 'border-top-color'])).toEqual({ 'background-color': 'rgba(255, 255, 255, 0.6)', 'border-top-color': 'rgba(24, 24, 27, 0.1)' })
    expect((await css('.hm-link', ['opacity'], '::after')).opacity).toBe('0.5')
    expect((await css('.hm-kbd', ['opacity'])).opacity).toBe('1')
    await p.page.focus('#link')
    await p.page.waitForTimeout(200)
    expect(await css('.hm-link', ['background-color', 'border-top-color', 'color', 'box-shadow'])).toEqual({
      'background-color': 'rgba(255, 255, 255, 0.92)', 'border-top-color': 'rgba(0, 136, 255, 0.55)', color: 'rgb(0, 136, 255)',
      'box-shadow': 'rgba(0, 136, 255, 0.16) 0px 0px 0px 3.5px, rgba(255, 255, 255, 0.9) 0px 1px 0px 0px inset, rgba(0, 100, 220, 0.3) 0px 6px 18px -8px',
    })
    expect(await css('#link', ['outline-style', 'box-shadow'])).toEqual({ 'outline-style': 'none', 'box-shadow': 'none' })
    await look(true)
    await p.page.waitForTimeout(200)
    expect(await css('.hm-link', ['background-color', 'border-top-color', 'color'])).toEqual({ 'background-color': 'rgba(30, 32, 42, 0.9)', 'border-top-color': 'rgba(92, 179, 255, 0.6)', color: 'rgb(92, 179, 255)' })
    expect(await css('.hm-kbd', ['color', 'background-color'])).toEqual({ color: 'rgb(92, 179, 255)', 'background-color': 'rgba(0, 136, 255, 0.1)' })
    await look(false)
    // the key chip: ⌘L, or ↵ while the field holds text
    await p.page.fill('#link', 'x')
    expect(await text('.hm-kbd')).toBe('↵')
    await p.page.fill('#link', '')
    expect(await text('.hm-kbd')).toBe('⌘L')
  })

  it('a marver:// link reads "↩ opens <folder>" (no localhost words), and Return sends it to main as typed; a malformed one is "Not a canvas link"', async () => {
    await world({ tabs: BUSY, view: 'grid' })
    const url = 'marver://open?ws=%2FUsers%2Fnic%2Fabs&port=4806'
    await p.page.fill('#link', url)
    expect(await text('#hint')).toBe('↩ opens abs')
    expect(await text('#hint')).not.toContain('localhost')
    await p.page.press('#link', 'Enter')
    await p.page.waitForFunction(() => (document.getElementById('link') as HTMLInputElement).value === '')
    expect(await p.calls('link:open')).toEqual([{ url }])
    await p.page.fill('#link', 'marver://open?ws=relative')
    expect(await text('#hint')).toBe('Not a canvas link')
    await p.answer('link:open', { ok: false, why: 'bad' })
    await p.page.fill('#link', url)
    await p.page.press('#link', 'Enter')
    await p.page.waitForFunction(() => document.getElementById('hint')!.textContent === 'Not a canvas link')
    await p.page.fill('#link', '')
  })

  it('the line under the field says where Return opens it; a refusal keeps the link selected (today\'s behaviour)', async () => {
    await world({ tabs: BUSY, view: 'grid' })
    await p.page.fill('#link', 'http://127.0.0.1:4806/#/b/checkout')
    expect(await text('#hint')).toBe('↩ opens in Calepin\'s tab, on that board')
    await p.page.fill('#link', 'http://localhost:4999/')
    expect(await text('#hint')).toBe('Nothing is running on localhost:4999')
    expect(await p.page.getAttribute('#link', 'aria-describedby')).toBe('hint')
    // floating under the field, right-aligned, 6 px below: the header never grows
    const f = await rect('.hm-link'), l = await rect('.hm-hint')
    expect([Math.round(l.right), Math.round(l.top - f.bottom)]).toEqual([Math.round(f.right), 6])
    expect((await rect('.hm-head')).height).toBe(40)
    await p.answer('link:open', { ok: false, why: 'refused' })
    await p.page.fill('#link', 'http://localhost:4806/?n=1')
    await p.page.press('#link', 'Enter')
    await p.page.waitForFunction(() => document.getElementById('hint')!.textContent!.startsWith('Not opened'))
    expect(await p.page.$eval('#link', (e) => { const i = e as HTMLInputElement; return [i.selectionStart, i.selectionEnd] })).toEqual([0, 'http://localhost:4806/?n=1'.length])
    await p.page.fill('#link', '')
  })

  it('⌘L focuses and selects; Escape goes back to that tab, said as cancel (D8.8)', async () => {
    await world({ tabs: BUSY, view: 'grid' })
    await p.page.fill('#link', 'abc')
    await p.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await p.send('home:focus', { field: 'link', back: 'os' })
    expect(await p.page.evaluate(() => { const i = document.activeElement as HTMLInputElement; return [i.id, i.selectionStart, i.selectionEnd] })).toEqual(['link', 0, 3])
    expect(await text('.hm-back')).toBe('esc back to OS')
    await p.page.press('#link', 'Escape')
    expect(await p.calls('tab:activate')).toEqual([{ id: 'os', via: 'key', cancel: true }])
    await p.page.fill('#link', '')
  })
})

describe('D8: menus and clicks on Home', () => {
  it('D8.2: a running card opens its tab; a shared one too (a past link through link:open); a not-running card opens its menu at its more button', async () => {
    await world({ tabs: BUSY, recent: RECENT, shared: SHARED, view: 'grid' })
    await p.page.click('[data-card="os"]')
    await p.page.click('[data-card="deck"]')
    await p.page.click('[data-card="s_00000000000000aa"]')
    await sleep(60)
    expect(await p.calls('tab:activate')).toEqual([{ id: 'os' }, { id: 'deck' }])
    expect(await p.calls('link:open')).toEqual([{ url: 'https://hertz.example.com/#/b/flow', via: 'click' }])
    await p.page.click('[data-card="r_0000000000000001"]')
    expect(await menuRows()).toEqual(['Copy start command', '-', 'Copy link', 'Copy path', 'Reveal in Finder'])
    expect(await p.calls('home:action')).toEqual([])
  })

  it('D8.4: the more button\'s menu: below it, right-aligned 8 px in from the card, top at the card\'s bottom - 4; the card .hov and menu-open, the button .on', async () => {
    await world({ tabs: BUSY, view: 'grid' })
    await p.page.hover('[data-card="calepin"]')
    await p.page.click('[data-more="calepin"]')
    expect(await menuRows()).toEqual(['Open', 'Update to 0.32.0', '-', 'Copy link', 'Copy path', 'Reveal in Finder'])
    const c = await rect('[data-card="calepin"]'), m = await rect('.mv-menu')
    // menu.ts places on whole pixels
    expect(Math.abs(m.right - (c.right - 8))).toBeLessThanOrEqual(1)
    expect(Math.abs(m.top - (c.bottom - 4))).toBeLessThanOrEqual(1)
    expect(await p.page.$eval('[data-card="calepin"]', (e) => [e.classList.contains('hov'), e.classList.contains('menu-open')])).toEqual([true, true])
    expect(await p.page.$eval('[data-more="calepin"]', (e) => [e.classList.contains('on'), e.getAttribute('aria-expanded')])).toEqual([true, 'true'])
    expect(await css('[data-more="calepin"]', ['opacity', 'background-color'])).toEqual({ opacity: '1', 'background-color': 'rgba(24, 24, 27, 0.12)' })
    // Home's glass (B6), the Update row in --hm-new, a row's pointer
    expect((await css('.mv-menu', ['backdrop-filter']))['backdrop-filter']).toBe('blur(20px) saturate(1.5)')
    expect((await css('.mv-row[data-id="copy-update"]', ['color'])).color).toBe('rgb(0, 119, 230)')
    expect((await css('.mv-row[data-id="open"]', ['cursor'])).cursor).toBe('pointer')
    // drawn in the top layer, never inside a card
    expect(await p.page.evaluate(() => document.querySelector('.mv-menu')!.parentElement!.id)).toBe('hm-layer')
  })

  it('D8.4: a right-click opens at the pointer, clamped by its measured width 14 px from both edges; near the foot upward; a chip\'s prefers upward', async () => {
    await world({ tabs: BUSY, recent: RECENT, shared: SHARED, view: 'grid' })
    const os = await rect('[data-card="os"]')
    await rightClick(os.left + 30, os.top + 20)
    let m = await rect('.mv-menu')
    expect(Math.abs(m.left - (os.left + 30))).toBeLessThanOrEqual(1)
    expect(Math.abs(m.top - (os.top + 22))).toBeLessThanOrEqual(1)
    await closeAll()
    // the rightmost card, right-clicked at its far edge: the menu's right edge stays 14 px in
    const last = await p.page.$$eval('.hm-grid .hm-card', (els) => { const r = els[3]!.getBoundingClientRect(); return { x: r.right - 3, y: r.top + 20, id: (els[3] as HTMLElement).dataset.card } })
    await rightClick(last.x, last.y)
    m = await rect('.mv-menu')
    expect(Math.abs(m.right - (1280 - 14))).toBeLessThanOrEqual(1)
    await closeAll()
    // near the window's foot it opens upward, never above 44 + 14
    await p.resize(1280, 480)
    await world({ tabs: BUSY, recent: RECENT, shared: SHARED, view: 'board' })
    const chip = await rect('[data-card="s_00000000000000aa"]')
    await rightClick(chip.left + 10, chip.top + 10)
    expect(await menuRows()).toEqual(['Open', '-', 'Copy link'])
    m = await rect('.mv-menu')
    expect(Math.abs(m.bottom - (chip.top + 10 - 2))).toBeLessThanOrEqual(1)
    expect(await p.page.$eval('.mv-menu', (e) => (e as HTMLElement).dataset.side)).toBe('up')
    await closeAll()
    await rightClick(20, 470)
    expect(await menuOpen()).toBe(false)   // not on a card: nothing
    const low = await p.page.$$eval('.hm-col[data-col="off"] .hm-card', (els) => { const r = els.at(-1)!.getBoundingClientRect(); return { x: r.left + 10, y: r.bottom - 4 } })
    await rightClick(low.x, low.y)
    m = await rect('.mv-menu')
    expect(m.top).toBeGreaterThanOrEqual(44 + 14 - 0.5)
    expect(m.bottom).toBeLessThanOrEqual(480 - 14 + 0.5)
    await closeAll()
    await p.resize(1280, 800)
  })

  it('D8.3: copy rows answer "Copied" with a check in the done colours for 900 ms, then close; refused: closes and says "Not found"', async () => {
    await world({ tabs: BUSY, view: 'grid' })
    await p.page.hover('[data-card="os"]')
    await p.page.click('[data-more="os"]')
    await pickByPointer('copy-path')
    await p.page.waitForFunction(() => document.querySelector('.mv-row[data-id="copy-path"]')?.textContent === 'Copied')
    expect(await p.calls('home:action')).toEqual([{ action: 'copy-path', id: 'os' }])
    expect(await css('.mv-row[data-id="copy-path"]', ['color', 'background-color'])).toEqual({ color: 'rgb(31, 157, 85)', 'background-color': 'rgba(52, 199, 89, 0.16)' })
    expect(await p.page.$eval('.mv-row[data-id="copy-path"] .mv-ic path', (e) => e.getAttribute('d')!.startsWith('M229.66,77.66'))).toBe(true)   // the check
    await sleep(600)
    expect(await menuOpen()).toBe(true)
    await p.page.waitForFunction(() => !document.querySelector('.mv-menu'), undefined, { timeout: 1500 })
    await p.answer('home:action', { ok: false, why: 'missing' })
    await p.page.hover('[data-card="os"]')
    await p.page.click('[data-more="os"]')
    await pickByPointer('copy-link')
    await p.page.waitForFunction(() => !document.querySelector('.mv-menu'))
    await p.page.waitForFunction(() => document.getElementById('live')!.textContent!.includes('Not found'))
  })

  it('D8.5: the View menu - header, Grid and Board with a check on the current, 200 wide, right-aligned under its button; the choice kept', async () => {
    await world({ tabs: BUSY, view: 'board' })
    await p.page.click('[data-key="view"]')
    expect(await menuRows()).toEqual(['View', 'Grid', 'Board'])
    expect(await p.page.$$eval('.mv-row[role="menuitemradio"]', (els) => els.map((e) => [e.getAttribute('data-id'), e.getAttribute('aria-checked')]))).toEqual([['grid', 'false'], ['board', 'true']])
    expect((await css('.mv-row[data-id="board"] .mv-check', ['color'])).color).toBe('rgb(0, 136, 255)')
    const b = await rect('[data-key="view"]'), m = await rect('.mv-menu')
    expect([Math.round(m.width), Math.round(m.right), Math.round(m.top)]).toEqual([200, Math.round(b.right), Math.round(b.top + 42)])
    expect(await p.page.$eval('[data-key="view"]', (e) => e.classList.contains('on'))).toBe(true)
    await pickByPointer('grid')
    await p.page.waitForSelector('.hm-body.grid')
    expect(await p.page.evaluate(() => localStorage.getItem('mv.home.view'))).toBe('grid')
    expect(await p.calls('home:action')).toEqual([])   // a local choice: nothing to main
    await setView('board')
    expect(await p.page.evaluate(() => localStorage.getItem('mv.home.view'))).toBe('board')
  })

  it('D8.6: one open at a time; Escape, an outside press, a tab switch close them; a scroll the person made closes a card and the View menu, Help stays', async () => {
    await world({ tabs: BUSY, recent: RECENT, view: 'grid' })
    await p.page.click('[data-key="help"]')
    expect(await p.page.$('.hm-help2')).not.toBeNull()
    await p.page.click('[data-key="view"]')
    expect(await p.page.$('.hm-help2')).toBeNull()   // the View menu closed Help
    expect(await menuRows()).toEqual(['View', 'Grid', 'Board'])
    await p.page.keyboard.press('Escape')
    expect(await menuOpen()).toBe(false)
    // a tab switch (a strip click, ⌘1-9) closes any open menu and Help
    await p.page.hover('[data-card="os"]')
    await p.page.click('[data-more="os"]')
    await tabs(BUSY, 'os')
    expect(await menuOpen()).toBe(false)
    await tabs(BUSY)
    await p.page.click('[data-key="help"]')
    await tabs(BUSY, 'os')
    expect(await p.page.$('.hm-help2')).toBeNull()
    await tabs(BUSY)
    // a wheel over the grid closes a card menu; Help survives a scroll
    await p.resize(1280, 400)
    await p.page.hover('[data-card="os"]')
    await p.page.click('[data-more="os"]')
    await p.page.evaluate(() => { const b = document.querySelector('.hm-body')!; b.scrollTop = 40 })
    await p.page.waitForFunction(() => !document.querySelector('.mv-menu'))
    await p.page.click('[data-key="help"]')
    await p.page.evaluate(() => { document.querySelector('.hm-body')!.scrollTop = 0 })
    await sleep(120)
    expect(await p.page.$('.hm-help2')).not.toBeNull()
    await p.page.mouse.click(300, 300)   // an outside press closes Help
    expect(await p.page.$('.hm-help2')).toBeNull()
    // the View menu too: its button moved with the body
    await p.page.click('[data-key="view"]')
    expect(await menuOpen()).toBe(true)
    await p.page.evaluate(() => { document.querySelector('.hm-body')!.scrollTop = 30 })
    await p.page.waitForFunction(() => !document.querySelector('.mv-menu'))
    await p.page.evaluate(() => { document.querySelector('.hm-body')!.scrollTop = 0 })
    // the wheel over a full column (the menus' catcher on top of it), with a card menu open in another column: the
    // column scrolls and the menu closes (a scroll the person made)
    const twelve = Array.from({ length: 12 }, (_, i) => tab(`c${i}`, `Canvas ${i}`, 4900 + i))
    await world({ tabs: [home, tab('asteria', 'Asteria', 4805, asks(2, 'Vault feed')), ...twelve], view: 'board', size: [720, 480] })
    const list = '.hm-col[data-col="live"] .hm-col-list'
    await p.page.hover('[data-card="asteria"]')
    await p.page.click('[data-more="asteria"]')
    expect(await menuOpen()).toBe(true)
    const lr = await rect(list)
    expect(await p.page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.className, [lr.left + 20, lr.top + 150])).toBe('mv-catcher')
    await p.page.mouse.move(lr.left + 20, lr.top + 150)
    await p.page.mouse.wheel(0, 200)
    await p.page.waitForFunction(() => !document.querySelector('.mv-menu'))
    expect(await p.page.$eval(list, (e) => e.scrollTop)).toBeGreaterThan(0)
    await p.page.$eval(list, (e) => { e.scrollTop = 0 })
    await p.resize(1280, 800)
  })

  it('D8.8: what Home sends - Enter and Space on a card, on a past link\'s card, a row by key, an Open row by key, the field\'s Escape', async () => {
    await world({ tabs: BUSY, shared: SHARED, view: 'grid' })
    await p.page.focus('[data-card="os"]')
    await p.page.keyboard.press('Enter')
    await p.page.keyboard.press('Space')
    await p.page.focus('[data-card="s_00000000000000aa"]')
    await p.page.keyboard.press('Enter')
    await sleep(50)
    await p.page.keyboard.press('Space')
    await sleep(50)
    expect(await p.calls('tab:activate')).toEqual([{ id: 'os', via: 'key', keys: 'Enter' }, { id: 'os', via: 'key', keys: 'Space' }])
    expect(await p.calls('link:open')).toEqual([{ url: 'https://hertz.example.com/#/b/flow', via: 'key', keys: 'Enter' }, { url: 'https://hertz.example.com/#/b/flow', via: 'key', keys: 'Space' }])
    await p.clear()
    // ContextMenu opens the card's menu at its more button, its first row focused; Down, then Enter
    await p.page.focus('[data-card="os"]')
    await p.page.keyboard.press('ContextMenu')
    expect(await focusedRow()).toBe('open')
    await p.page.keyboard.press('ArrowDown')
    expect(await focusedRow()).toBe('copy-link')
    await p.page.keyboard.press('Enter')
    await p.page.waitForFunction(() => document.querySelector('.mv-row[data-id="copy-link"]')?.textContent === 'Copied')
    await p.page.waitForFunction(() => !document.querySelector('.mv-menu'), undefined, { timeout: 1500 })
    // the menu closed by itself: focus back on the card's more button
    expect(await p.page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe('more:os')
    await p.page.focus('[data-card="os"]')
    await p.page.keyboard.press('Shift+F10')
    await p.page.keyboard.press('End')
    await p.page.keyboard.press('ArrowUp')
    await p.page.keyboard.press('Space')   // Copy path, by Space
    await p.page.waitForFunction(() => document.querySelector('.mv-row[data-id="copy-path"]')?.textContent === 'Copied')
    await p.page.waitForFunction(() => !document.querySelector('.mv-menu'), undefined, { timeout: 1500 })
    expect(await p.calls('home:action')).toEqual([{ action: 'copy-link', id: 'os', via: 'key', keys: 'Enter' }, { action: 'copy-path', id: 'os', via: 'key', keys: 'Space' }])
    // an Open row by key sends the card's activation, never home:action
    await p.page.focus('[data-card="os"]')
    await p.page.keyboard.press('ContextMenu')
    await p.page.keyboard.press('Enter')
    expect(await p.calls('tab:activate')).toEqual([{ id: 'os', via: 'key', keys: 'Enter' }])
    expect(await p.calls('home:action')).toHaveLength(2)
    // and by pointer, a click
    await p.page.hover('[data-card="os"]')
    await p.page.click('[data-more="os"]')
    await pickByPointer('open')
    expect((await p.calls('tab:activate')).at(-1)).toEqual({ id: 'os' })
  })

  it('D8.7: home:focus recent - the card highlighted, scrolled into view, its menu at its more button\'s final rect with Copy start command focused', async () => {
    const many: RecentView[] = Array.from({ length: 16 }, (_, i) => ({ id: `r_${String(i).padStart(16, '0')}`, name: `Old ${i}`, folder: `~/old${i}`, lastSeen: Date.now() - (i + 1) * 3600_000 }))
    await world({ tabs: [home, tab('os', 'OS', 4809)], recent: many, view: 'board', size: [1280, 600] })
    const id = many[15]!.id
    await p.send('home:focus', { field: 'recent', id })
    await p.page.waitForSelector('.mv-menu')
    await sleep(150)
    expect(await focusedRow()).toBe('copy-start')
    const list = await rect('.hm-col[data-col="off"] .hm-col-list')
    const card = await rect(`[data-card="${id}"]`)
    expect(card.bottom).toBeLessThanOrEqual(list.bottom + 0.5)
    expect(await p.page.$eval(`[data-card="${id}"]`, (e) => e.classList.contains('hov'))).toBe(true)
    const m = await rect('.mv-menu')
    expect(Math.abs(m.right - (card.right - 8))).toBeLessThanOrEqual(1)
    expect(await menuOpen()).toBe(true)
    await closeAll()
    await p.resize(1280, 800)
  })
})

describe('D9: Help', () => {
  it('its card: right 14, top 108, 420 wide, radius 18; its words and commands exactly; Copy by id and its done look; Show the files', async () => {
    await world({ tabs: BUSY, view: 'grid' })
    await p.page.click('[data-key="help"]')
    const r = await rect('.hm-help2')
    expect([Math.round(1280 - r.right), Math.round(r.top), Math.round(r.width)]).toEqual([14, 108, 420])
    expect(await css('.hm-help2', ['border-radius', 'background-color', 'backdrop-filter'])).toEqual({ 'border-radius': '18px', 'background-color': 'rgba(255, 255, 255, 0.82)', 'backdrop-filter': 'blur(24px) saturate(1.5)' })
    expect(await text('.hm-help2 header h4')).toBe('How Marver runs')
    expect(await text('.hm-help2 header p')).toBe('Every canvas lives in its repo; this app opens them.')
    expect(await css('.hm-help2 header h4', ['margin-top', 'font-size', 'font-weight'])).toEqual({ 'margin-top': '0px', 'font-size': '14px', 'font-weight': '650' })
    expect(await texts('.hm-hs h5')).toEqual(['Open a canvas', 'Add Marver to a repo', 'Update a canvas'])
    expect(await p.page.$$eval('.hm-cmd2 code', (els) => els.map((e) => [...e.children].map((s) => s.textContent)))).toEqual([
      ['npx marver dev'], ['npm i -D @marver-design/marver &&', 'npx marver init'], ['npm i -D @marver-design/marver@latest'],
    ])
    // the two-line command shows two lines
    expect(await p.page.$$eval('.hm-cmd2.two code span', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))).toHaveLength(2)
    const tops = await p.page.$$eval('.hm-cmd2.two code span', (els) => els.map((e) => e.getBoundingClientRect().top))
    expect(tops[1]! - tops[0]!).toBeGreaterThan(10)
    expect(await text('.hm-help-in > footer h5')).toBe('Settings and agent notes')
    expect(await text('.hm-help-in > footer p')).toBe('~/.marver/')
    await p.page.click('.hm-cmd2 >> nth=1 >> button')
    await p.page.click('.hm-foot-btn')
    expect(await p.calls('home:action')).toEqual([{ action: 'copy', id: 'init' }, { action: 'show-files' }])
    await p.page.waitForSelector('.hm-cmd2 >> nth=1 >> button.done')
    await sleep(300)
    expect((await css('.hm-cmd2 button.done', ['background-color']))['background-color']).toBe('rgba(52, 199, 89, 0.22)')
    for (const sel of ['.hm-cmd2 button', '.hm-foot-btn']) expect((await css(sel, ['cursor'])).cursor, sel).toBe('pointer')
    // the edge ring is not clipped: the clip lives on the inner wrapper
    expect((await css('.hm-help2', ['overflow'])).overflow).toBe('visible')
    await p.page.click('[data-key="help"]')   // the "?" toggles it
    expect(await p.page.$('.hm-help2')).toBeNull()
  })

  it('at 720 x 480 it is capped to the window and scrolls under its pinned header; in the empty state it opens upward, capped too', async () => {
    await world({ tabs: BUSY, view: 'grid', size: [720, 480] })
    await p.page.click('[data-key="help"]')
    const r = await rect('.hm-help2')
    expect(r.bottom).toBeLessThanOrEqual(480 - 14 + 0.5)
    expect(await p.page.$eval('.hm-help-in', (e) => e.scrollHeight > e.clientHeight)).toBe(true)
    const head = await rect('.hm-help2 header')
    await p.page.$eval('.hm-help-in', (e) => { e.scrollTop = e.scrollHeight })
    expect(await rect('.hm-help2 header')).toEqual(head)
    const btn = await rect('.hm-foot-btn')
    expect(btn.bottom).toBeLessThanOrEqual(r.bottom)
    await p.page.click('[data-key="help"]')
    await world({ size: [720, 480] })
    await p.page.click('.hm-float')
    const u = await rect('.hm-help2')
    expect(await p.page.$eval('.hm-help2', (e) => e.classList.contains('up'))).toBe(true)
    expect(Math.round(480 - u.bottom)).toBe(58)
    expect(u.top).toBeGreaterThanOrEqual(44 + 8 - 0.5)
    await p.page.click('.hm-float')
    // at 720 x 480 the empty state's mark stays below the strip and the page scrolls
    expect((await rect('.hm-empty-in .mv-mark')).top).toBeGreaterThanOrEqual(44)
    expect(await p.page.$eval('.hm-empty', (e) => e.scrollHeight > e.clientHeight)).toBe(true)
    await p.resize(1280, 800)
  })
})

describe('D11: Home\'s UI state lives outside the DOM', () => {
  it('an open card menu, the View menu and Help survive three pushes (the timer's repaint: the last describe)', async () => {
    await world({ tabs: BUSY, view: 'grid' })
    await p.page.hover('[data-card="os"]')
    await p.page.click('[data-more="os"]')
    const el = await p.page.evaluateHandle(() => document.querySelector('.mv-menu'))
    for (let i = 0; i < 3; i++) await tabs(BUSY)
    await p.send('recent', [])
    expect(await p.page.evaluate((m) => m === document.querySelector('.mv-menu'), el)).toBe(true)
    expect(await p.page.$eval('[data-card="os"]', (e) => e.classList.contains('menu-open'))).toBe(true)
    await closeAll()
    await p.page.click('[data-key="view"]')
    for (let i = 0; i < 3; i++) await tabs(BUSY)
    expect(await menuRows()).toEqual(['View', 'Grid', 'Board'])
    await closeAll()
    await p.page.click('[data-key="help"]')
    for (let i = 0; i < 3; i++) await tabs(BUSY)
    expect(await p.page.$('.hm-help2')).not.toBeNull()
    expect(await p.page.$eval('[data-key="help"]', (e) => e.classList.contains('on'))).toBe(true)
    await p.page.click('[data-key="help"]')
  })

  it('a card that stops keeps its menu, rebuilt (Copy start command in, Open out), focus by action id; one removed closes it', async () => {
    await world({ tabs: BUSY, view: 'board' })
    await p.page.focus('[data-card="os"]')
    await p.page.keyboard.press('ContextMenu')
    await p.page.keyboard.press('ArrowDown')
    expect(await focusedRow()).toBe('copy-link')
    await tabs(BUSY.map((t) => (t.id === 'os' ? { ...t, state: 'gone' as const } : t)))
    expect(await menuRows()).toEqual(['Copy start command', '-', 'Copy link', 'Copy path', 'Reveal in Finder'])
    expect(await focusedRow()).toBe('copy-link')
    // the card moved column (Running to Not running): the menu re-anchored to its more button's new rect
    const c = await rect('[data-card="os"]'), m = await rect('.mv-menu')
    expect(Math.abs(m.right - (Math.min(c.right - 8, 1280 - 14)))).toBeLessThanOrEqual(1)
    // an unverified card that verifies gains Copy link
    await closeAll()
    await tabs([...BUSY, tab('u', 'U', 4820, { state: 'unverified' })])
    await p.page.focus('[data-card="u"]')
    await p.page.keyboard.press('ContextMenu')
    expect(await menuRows()).toEqual(['Open'])
    await tabs([...BUSY, tab('u', 'U', 4820)])
    expect(await menuRows()).toEqual(['Open', '-', 'Copy link', 'Copy path', 'Reveal in Finder'])
    // its card gone from the model: the menu closes
    await tabs(BUSY)
    expect(await menuOpen()).toBe(false)
    // a remote tab closed with no past link left: its card goes, and its menu with it
    await p.page.focus('[data-card="deck"]')
    await p.page.keyboard.press('ContextMenu')
    expect(await menuRows()).toEqual(['Open', '-', 'Copy link'])
    await tabs(BUSY.filter((t) => t.id !== 'deck'))
    expect(await menuOpen()).toBe(false)
    // a gone tab closed: its recent card, another id, takes its place; the gone card's menu closes
    await p.page.focus('[data-card="gone"]')
    await p.page.keyboard.press('ContextMenu')
    expect(await menuRows()).toEqual(['Copy start command', '-', 'Copy link', 'Copy path', 'Reveal in Finder'])
    await tabs(BUSY.filter((t) => t.id !== 'gone'))
    await p.send('recent', [{ id: 'r_00000000000000ff', name: 'Grindr creative swap', folder: '~/gone', lastSeen: Date.now() - 1000 }])
    expect(await p.page.$('[data-card="r_00000000000000ff"]')).not.toBeNull()
    expect(await menuOpen()).toBe(false)
  })

  it('typing in the field keeps the draft, the focus and the selection through pushes and empty to populated and back (the timer: the last describe)', async () => {
    await world({ tabs: BUSY, view: 'grid' })
    await p.page.click('#link')
    await p.page.keyboard.type('http://localhost:4806/x')
    await p.page.evaluate(() => (document.getElementById('link') as HTMLInputElement).setSelectionRange(5, 9))
    const sel = () => p.page.evaluate(() => { const i = document.getElementById('link') as HTMLInputElement; return [document.activeElement === i, i.value, i.selectionStart, i.selectionEnd] })
    const want = [true, 'http://localhost:4806/x', 5, 9]
    await tabs(BUSY)
    expect(await sel()).toEqual(want)
    await tabs([home])   // empty: the field moves into the third step
    expect(await p.page.$('.hm-empty-link #link')).not.toBeNull()
    expect(await sel()).toEqual(want)
    await tabs(BUSY)
    expect(await p.page.$('.hm-head #link')).not.toBeNull()
    expect(await sel()).toEqual(want)
    await p.page.fill('#link', '')
  })

  it('a scrolled grid, column and shared row keep their offsets through a push; a menu in a scrolled column survives a push, re-anchored', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => tab(`c${i}`, `Canvas ${i}`, 4900 + i))
    const shared: SharedLink[] = Array.from({ length: 14 }, (_, i) => ({ id: `s_${String(i).padStart(16, '0')}`, url: `https://s${i}.example.com/`, host: `s${i}.example.com`, lastSeen: Date.now() - i }))
    await world({ tabs: [home, ...twelve], shared, view: 'board', size: [720, 480] })
    const list = '.hm-col[data-col="live"] .hm-col-list'
    await p.page.$eval(list, (e) => { e.scrollTop = 120 })
    await p.page.$eval('.hm-shared', (e) => { e.scrollLeft = 90 })
    await tabs([home, ...twelve])
    expect(await p.page.$eval(list, (e) => e.scrollTop)).toBe(120)
    expect(await p.page.$eval('.hm-shared', (e) => e.scrollLeft)).toBe(90)
    const id = await p.page.$eval(list, (e) => { const r = e.getBoundingClientRect(); const c = [...e.querySelectorAll<HTMLElement>('.hm-card')].find((x) => x.getBoundingClientRect().top > r.top + 10)!; return c.dataset.card! })
    await p.page.hover(`[data-card="${id}"]`)
    await p.page.click(`[data-more="${id}"]`)
    await tabs([home, ...twelve])
    await sleep(150)
    await tabs([home, ...twelve])
    await sleep(150)
    expect(await menuOpen()).toBe(true)
    const c = await rect(`[data-card="${id}"]`), m = await rect('.mv-menu')
    expect(Math.abs(m.right - (c.right - 8))).toBeLessThanOrEqual(1)
    await closeAll()
    await world({ tabs: BUSY, recent: RECENT, view: 'grid', size: [720, 480] })
    await p.page.$eval('.hm-body', (e) => { e.scrollTop = 60 })
    await tabs(BUSY)
    expect(await p.page.$eval('.hm-body', (e) => e.scrollTop)).toBe(60)
    await p.resize(1280, 800)
  })
})

describe('E7 and the system settings', () => {
  it('a card focused by key rings in the field accent and shows its more button', async () => {
    await world({ tabs: BUSY, view: 'grid' })
    await p.page.focus('#link')
    await p.page.keyboard.press('Tab'); await p.page.keyboard.press('Tab'); await p.page.keyboard.press('Tab')
    expect(await p.page.evaluate(() => (document.activeElement as HTMLElement).dataset.card)).toBe('asteria')
    expect(await css('[data-card="asteria"]', ['outline-color', 'outline-style'])).toEqual({ 'outline-color': 'rgb(0, 136, 255)', 'outline-style': 'solid' })
    await sleep(250)
    expect((await css('[data-more="asteria"]', ['opacity'])).opacity).toBe('1')
  })

  it('Reduce Transparency and Increase Contrast: no blur, solid fills; Reduce Motion: the work dot does not pulse', async () => {
    await world({ tabs: BUSY, view: 'grid' })
    for (const f of [{ 'prefers-reduced-transparency': 'reduce' }, { 'prefers-contrast': 'more' }] as Record<string, string>[]) {
      await p.media(f)
      await sleep(250)   // the fill's own transition
      const c = await css('[data-card="os"]', ['backdrop-filter', 'background-color'])
      expect(c['backdrop-filter'], JSON.stringify(f)).toBe('none')
      expect(c['background-color']).toMatch(/^rgb\(/)
    }
    await p.media({ 'prefers-reduced-motion': 'reduce' })
    for (const a of await animatedProperties(p.page)) expect(a.name).not.toBe('hm-pulse')
    await p.media({})
  })
})

describe('D6.2, D11: the 60 s timer repaints through the render path', () => {
  // last in the file: the page reloads under Playwright's clock, so the 60 s interval is the fake one
  it('moves the working minutes, and keeps an open card menu in a scrolled column, the View menu, Help, the draft and the offsets', async () => {
    await closeAll()
    await p.page.clock.install()
    await p.page.reload()
    await p.page.waitForFunction(() => document.readyState === 'complete')
    const twelve = Array.from({ length: 12 }, (_, i) => tab(`c${i}`, `Canvas ${i}`, 4900 + i))
    const agent = tab('ambient', 'Ambient agent', 4807, { marks: marks({ working: true, work: { board: 'Onboarding', since: await p.page.evaluate(() => Date.now()) - 4.5 * 60_000 } }) })
    const list = [home, agent, ...twelve]
    await world({ tabs: list, recent: RECENT, view: 'board', size: [720, 480] })
    const line = () => text('[data-card="ambient"] .hm-line')
    expect(await line()).toBe('Agent working on Onboarding · 4 min')
    const tick = async () => { await p.page.clock.runFor(60_000); await sleep(50) }
    // a card menu open in a column scrolled to a nonzero offset
    const col = '.hm-col[data-col="live"] .hm-col-list'
    await p.page.$eval(col, (e) => { e.scrollTop = 120 })
    await sleep(50)
    const id = await p.page.$eval(col, (e) => { const r = e.getBoundingClientRect(); return [...e.querySelectorAll<HTMLElement>('.hm-card')].find((x) => x.getBoundingClientRect().top > r.top + 10)!.dataset.card! })
    await p.page.hover(`[data-card="${id}"]`)
    await p.page.click(`[data-more="${id}"]`)
    const el = await p.page.evaluateHandle(() => document.querySelector('.mv-menu'))
    await tick()
    expect(await line()).toBe('Agent working on Onboarding · 5 min')
    expect(await text('[data-card="r_0000000000000001"] .hm-line')).toBe('Ran 19 hours ago')
    expect(await p.page.evaluate((m) => m === document.querySelector('.mv-menu'), el)).toBe(true)
    expect(await p.page.$eval(col, (e) => e.scrollTop)).toBe(120)
    const c = await rect(`[data-card="${id}"]`), m = await rect('.mv-menu')
    expect(Math.abs(m.right - (c.right - 8))).toBeLessThanOrEqual(1)
    await closeAll()
    // the View menu and Help
    await p.page.click('[data-key="view"]')
    await tick()
    expect(await menuRows()).toEqual(['View', 'Grid', 'Board'])
    await closeAll()
    await p.page.click('[data-key="help"]')
    await tick()
    expect(await p.page.$('.hm-help2')).not.toBeNull()
    await p.page.click('[data-key="help"]')
    // the field's draft, focus and selection
    await p.page.click('#link')
    await p.page.keyboard.type('http://localhost:4806/x')
    await p.page.evaluate(() => (document.getElementById('link') as HTMLInputElement).setSelectionRange(3, 8))
    await tick()
    expect(await p.page.evaluate(() => { const i = document.getElementById('link') as HTMLInputElement; return [document.activeElement === i, i.value, i.selectionStart, i.selectionEnd] })).toEqual([true, 'http://localhost:4806/x', 3, 8])
    await p.page.fill('#link', '')
    await p.resize(1280, 800)
  })
})
