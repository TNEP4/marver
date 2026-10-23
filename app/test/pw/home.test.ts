/**
 * Home (spec 28 A2.7, A2.12, A2.13, A2.14 #3, #5, v1.13 r2 #6): the real page and the real app preload under a fake
 * main (test/harness/pages.ts). First launch and the empty Home, running and recent canvases, the commands named by
 * id, the link field's line and every answer of link:open, ⌘L's focus and Esc, the page's ARIA and the system
 * settings.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { RecentView, TabView } from '../../src/shared/channels.ts'
import { animatedProperties, openPage, type PageRun } from '../harness/pages.ts'

const home: TabView = { id: 'h', kind: 'home', name: 'Home', state: 'live', verified: true, open: true }
const tab = (id: string, name: string, port: number, over: Partial<TabView> = {}): TabView =>
  ({ id, kind: 'local', name, state: 'live', verified: true, open: true, link: `http://localhost:${port}/`, folder: `~/${name.toLowerCase().replace(/ /g, '-')}`, version: '0.27.1', ...over })
const TABS = [home, tab('t1', 'Marver Platform', 4805), tab('t2', 'TMS broker', 4806), tab('t3', 'Tidewell', 4807, { state: 'gone' })]
const RECENT: RecentView[] = [
  { id: 'r:0000000000000001', name: 'OS alignment', folder: '~/os', lastSeen: Date.now() - 2 * 3600_000 },
  { id: 'r:0000000000000002', name: '<b>Gen lab</b>', folder: '~/gen <lab>', lastSeen: Date.now() - 30_000 },
]
let rev = 0

let p: PageRun
const readyCalls: unknown[] = []
beforeAll(async () => {
  p = await openPage('home', { width: 1280, height: 760 })
  readyCalls.push(...await p.calls('app:ready'))
})
afterAll(async () => { await p?.close() })
beforeEach(async () => {
  await p.clear()
  await p.answer('link:open', { ok: true })
  await p.answer('home:action', { ok: true })
})

/** what the eye reads: visible text, logos' initials left out (they are decorative, aria-hidden) */
const text = (sel: string) => p.page.$eval(sel, (e) => {
  const c = e.cloneNode(true) as HTMLElement
  for (const l of c.querySelectorAll('.logo')) l.remove()
  document.body.append(c)
  const t = c.innerText
  c.remove()
  return t.replace(/\s+/g, ' ').trim()
})
const tabs = (list: TabView[]) => p.send('tabs', { rev: ++rev, active: 'h', tabs: list })

describe('first launch and the empty Home (A2.12)', () => {
  it('says app:ready once its script runs', () => { expect(readyCalls).toEqual([null]) })

  it('the very first launch: "Welcome to Marver", how to start one, and the two steps for a repo without Marver', async () => {
    await p.send('home:info', { welcome: true, writable: true })
    await tabs([home])
    await p.send('recent', [])
    expect(await p.page.$$eval('h1', (els) => els.map((e) => e.textContent))).toEqual(['Welcome to Marver'])
    expect(await text('.welcome')).toContain('No canvas is running yet')
    await p.page.click('[aria-label="Copy npx marver dev"]')
    await p.page.click('[aria-label="Copy the two setup commands"]')
    expect(await p.calls('home:action')).toEqual([{ action: 'copy', id: 'dev' }, { action: 'copy', id: 'init' }])
    expect(await text('[aria-label="Copy npx marver dev"]')).toContain('Copied')
  })

  it('afterwards: "On this Mac", "Nothing is running." with its command, no init line', async () => {
    await p.send('home:info', { welcome: false, writable: true })
    await tabs([home])
    expect(await p.page.$$eval('h1', (els) => els.map((e) => e.textContent))).toEqual(['On this Mac'])
    expect(await text('.empty')).toBe('Nothing is running. Start a canvas in its repo; it appears here, with its own tab, a second later. npx marver dev')
    expect(await p.page.$('[aria-label="Copy the two setup commands"]')).toBeNull()
  })

  it('the footer: the update command and Show the Files, named by id', async () => {
    await p.page.click('[aria-label="Copy the update command"]')
    await p.page.click('text=Show the Files')
    expect(await p.calls('home:action')).toEqual([{ action: 'copy', id: 'update' }, { action: 'show-files' }])
    expect(await text('.foot')).toContain('Canvases on Marver 0.26 or older don\'t appear here')
  })

  it('a home that cannot be written says so', async () => {
    await p.send('home:info', { welcome: false, writable: false })
    expect(await text('.foot')).toContain('~/.marver can\'t be written · nothing is kept')
    await p.send('home:info', { welcome: false, writable: true })
  })
})

describe('running and recent canvases (A2.7, A2.12)', () => {
  it('a card per local tab, a button named for what it says; a click activates its tab', async () => {
    await tabs([...TABS, tab('t4', 'Marver site', 4809, { open: false, version: '0.27.0' })])
    const names = await p.page.$$eval('button.card', (els) => els.map((e) => e.getAttribute('aria-label')))
    expect(names).toEqual([
      'Marver Platform, localhost:4805, running', 'TMS broker, localhost:4806, running', 'Tidewell, localhost:4807, stopped',
      'Marver site, localhost:4809, running, tab closed',
    ])
    expect(await text('[data-key="tab:t4"]')).toContain('Update to Marver 0.27.1 for the full unsaved-work guard')
    expect(await text('[data-key="tab:t1"]')).not.toContain('Update to')
    await p.page.click('[data-key="tab:t2"]')
    await p.page.click('[data-key="tab:t4"]')
    expect(await p.calls('tab:activate')).toEqual([{ id: 't2' }, { id: 't4' }])
  })

  it('Recently here: initials, the folder, when it ran, its start command copied through main by id', async () => {
    await p.send('recent', RECENT)
    expect([await text('.card.stopped:nth-child(1)'), await text('.card.stopped:nth-child(2)')])
      .toEqual(['OS alignment ~/os Ran 2 hours ago npx marver dev', '<b>Gen lab</b> ~/gen <lab> Ran just now npx marver dev'])
    expect(await p.page.$$eval('.card.stopped .logo b', (els) => els.map((e) => e.textContent))).toEqual(['OA', 'BL'])
    await p.page.click('[aria-label="Copy the start command for OS alignment"]')
    expect(await p.calls('home:action')).toEqual([{ action: 'copy-start', id: 'r:0000000000000001' }])
    expect(await text('[aria-label="Copy the start command for OS alignment"]')).toContain('Copied')
  })

  it('a copy main refuses shows no "Copied"', async () => {
    await p.answer('home:action', { ok: false })
    await p.page.click('[aria-label="Copy the start command for <b>Gen lab</b>"]')
    expect(await text('[aria-label="Copy the start command for <b>Gen lab</b>"]')).not.toContain('Copied')
  })

  it('names are text, never markup', async () => {
    await tabs([home, tab('t9', '<img src=x onerror=alert(1)>', 4810)])
    expect(await text('[data-key="tab:t9"] .card-hd span')).toBe('<img src=x onerror=alert(1)>')
    expect(await p.page.$$eval('img', (els) => els.length)).toBe(0)
    expect(await p.page.$$eval('b', (els) => els.map((e) => e.textContent))).not.toContain('Gen lab')
  })
})

describe('the link field (A2.7, v1.13 r2 #6)', () => {
  beforeEach(async () => { await tabs(TABS); await p.page.fill('#link', '') })

  it('the line says where Return opens it, named from the tabs, whatever loopback host it wrote', async () => {
    await p.page.fill('#link', 'http://127.0.0.1:4806/#/b/checkout?f=checkout/plans')
    expect(await text('#hint')).toBe('↩ opens in TMS broker\'s tab, on that board')
    await p.page.fill('#link', 'localhost:4805')
    expect(await text('#hint')).toBe('↩ opens in Marver Platform\'s tab')
    await p.page.fill('#link', 'http://localhost:4999/')
    expect(await text('#hint')).toBe('Nothing is running on localhost:4999')
    await p.page.fill('#link', 'https://pilot.example.com/')
    expect(await text('#hint')).toBe('Shared canvases open in a later build')
    await p.page.fill('#link', 'http://example.com/')
    expect(await text('#hint')).toBe('Not a canvas link')
    await p.page.fill('#link', '')
    expect(await text('#hint')).toBe('')
    expect(await p.page.getAttribute('#link', 'aria-describedby')).toBe('hint')
  })

  it('Return sends what was typed; ok empties the field', async () => {
    await p.page.fill('#link', 'http://localhost:4806/#/b/x')
    await p.page.press('#link', 'Enter')
    await p.page.waitForFunction(() => (document.getElementById('link') as HTMLInputElement).value === '')
    expect(await p.calls('link:open')).toEqual([{ url: 'http://localhost:4806/#/b/x' }])
  })

  it('refused: the link stays, selected, and the line says the page stays as it was', async () => {
    await p.answer('link:open', { ok: false, why: 'refused' })
    await p.page.fill('#link', 'http://localhost:4806/?n=1')
    await p.page.press('#link', 'Enter')
    await p.page.waitForFunction(() => document.getElementById('hint')!.textContent!.startsWith('Not opened'))
    expect(await text('#hint')).toBe('Not opened: TMS broker\'s page stays as it was')
    expect(await p.page.$eval('#link', (e) => { const i = e as HTMLInputElement; return [i.value, i.selectionStart, i.selectionEnd] }))
      .toEqual(['http://localhost:4806/?n=1', 0, 'http://localhost:4806/?n=1'.length])
    await p.page.type('#link', 'x')   // typing again: the line goes back to where Return would open it
    expect(await text('#hint')).toBe('Not a canvas link')
  })

  for (const [why, line] of [
    ['nothing', 'Nothing is running on localhost:4806'],
    ['not-canvas', 'Something else answers on localhost:4806: not a Marver canvas'],
    ['bad', 'Not a canvas link'],
  ] as const) {
    it(`${why}: the line says so and nothing else happens`, async () => {
      await p.answer('link:open', { ok: false, why })
      await p.page.fill('#link', 'http://localhost:4806/')
      await p.page.press('#link', 'Enter')
      await p.page.waitForFunction((l) => document.getElementById('hint')!.textContent === l, line)
      expect(await p.page.inputValue('#link')).toBe('http://localhost:4806/')
      expect(await p.calls('tab:activate')).toEqual([])
    })
  }

  it('later: a shared link says it comes in a later build', async () => {
    await p.answer('link:open', { ok: false, why: 'later' })
    await p.page.fill('#link', 'https://pilot.example.com/')
    await p.page.press('#link', 'Enter')
    await p.page.waitForFunction(() => document.getElementById('hint')!.textContent === 'Shared canvases open in a later build')
  })
})

describe('⌘L (A2.7, A2.13)', () => {
  it('home:focus focuses the field with its text selected and names the tab Esc goes back to', async () => {
    await tabs(TABS)
    await p.page.fill('#link', 'abc')
    await p.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await p.send('home:focus', { field: 'link', back: 't1' })
    expect(await p.page.evaluate(() => {
      const i = document.activeElement as HTMLInputElement
      return [i.id, i.selectionStart, i.selectionEnd]
    })).toEqual(['link', 0, 3])
    expect(await text('#back')).toBe('esc back to Marver Platform')
  })

  it('Esc goes back to that tab whatever the field holds, leaving the text', async () => {
    await p.page.press('#link', 'Escape')
    await p.page.fill('#link', '')
    await p.page.press('#link', 'Escape')
    expect(await p.calls('tab:activate')).toEqual([{ id: 't1' }, { id: 't1' }])
  })

  it('if that tab has closed, Esc stays on Home', async () => {
    await p.send('home:focus', { field: 'link', back: 't1' })
    await tabs([home, tab('t2', 'TMS broker', 4806)])
    expect(await text('#back')).toBe('')
    await p.page.press('#link', 'Escape')
    expect(await p.calls('tab:activate')).toEqual([])
  })
})

describe('accessibility and the system settings (A2.13, A2.14 #26)', () => {
  it('one h1, the field labelled, and Tab in reading order', async () => {
    await p.send('home:info', { welcome: false, writable: true })
    await tabs(TABS)
    await p.send('recent', RECENT.slice(0, 1))
    expect(await p.page.$$eval('h1', (els) => els.length)).toBe(1)
    expect(await p.page.locator('#link').getAttribute('placeholder')).toBe('Open a canvas link…')
    expect(await p.page.getByLabel('Open a canvas link').count()).toBe(1)
    await p.page.focus('#link')
    const order: string[] = []
    for (let i = 0; i < 6; i++) {
      await p.page.keyboard.press('Tab')
      order.push(await p.page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? ''))
    }
    expect(order).toEqual([
      'Marver Platform, localhost:4805, running', 'TMS broker, localhost:4806, running', 'Tidewell, localhost:4807, stopped',
      'Copy the start command for OS alignment', 'Copy the update command', 'Show the Files',
    ])
  })

  it('the cards go opaque under Reduce Transparency and Increase Contrast', async () => {
    const bg = () => p.page.$eval('button.card', (e) => getComputedStyle(e).backgroundColor)
    const alpha = (c: string) => { const v = /rgba?\(([^)]+)\)/.exec(c)![1].split(',').map((x) => x.trim()); return v.length === 4 ? Number(v[3]) : 1 }
    expect(alpha(await bg())).toBeLessThan(1)
    for (const f of [{ 'prefers-reduced-transparency': 'reduce' }, { 'prefers-contrast': 'more' }] as Record<string, string>[]) {
      await p.media(f)
      expect(alpha(await bg()), JSON.stringify(f)).toBe(1)
    }
    await p.media({})
  })

  it('Reduce Motion: a starting card\'s spinner pulses, nothing else moves', async () => {
    await tabs([home, tab('t5', 'Starting one', 4811, { state: 'starting' })])
    await p.media({ 'prefers-reduced-motion': 'reduce' })
    const a = await animatedProperties(p.page)
    expect(a.length).toBeGreaterThan(0)
    for (const x of a) expect(x.props).toEqual(['opacity'])
    await p.media({})
  })

  it('follows the app\'s theme (prefers-color-scheme)', async () => {
    await p.media({ 'prefers-color-scheme': 'dark' })
    await p.page.waitForFunction(() => document.documentElement.classList.contains('dark'))
    await p.media({ 'prefers-color-scheme': 'light' })
    await p.page.waitForFunction(() => !document.documentElement.classList.contains('dark'))
    await p.media({})
  })

  it('loads under the CSP with nothing refused', async () => { expect(await p.csp()).toEqual([]) })
})
