/**
 * The tab's own page (spec 28 A2.11, A2.13, A2.14 #19, v1.13 r2 #3, v1.14 r3 #3, #4): the real page and the real app
 * preload under a fake main (test/harness/pages.ts). Every state's words and buttons as frame mac-app/09 draws them,
 * the 400 ms and 15 s timers the page runs from `since`, the retained page and the probe's lines (a canvas named only
 * once proved), actions carrying the snapshot's own rev, focus on the heading, and the look.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TabPageView } from '../../src/shared/channels.ts'
import { openPage, type PageRun } from '../harness/pages.ts'

let p: PageRun
let rev = 0
beforeAll(async () => { p = await openPage('tabpage', { width: 760, height: 520 }) })
afterAll(async () => { await p?.close() })
beforeEach(async () => { await p.clear() })

type Body<T> = T extends unknown ? Omit<T, 'rev'> : never
const show = async (v: Body<TabPageView>) => { const r = ++rev; await p.send('tabpage', { ...v, rev: r }); return r }
const words = () => p.page.$eval('#content', (e) => {
  const c = e.cloneNode(true) as HTMLElement
  for (const l of c.querySelectorAll('.logo')) l.remove()
  document.body.append(c)
  const t = c.innerText
  c.remove()
  return t.replace(/\s+/g, ' ').trim()
})
const buttons = () => p.page.$$eval('#content button', (els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent))
const none = { state: 'none', lastAt: null } as const
const at = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

describe('starting (A2.11)', () => {
  it('only ground and dots for the first 400 ms, then the words', async () => {
    await show({ page: 'starting', phase: 'starting', name: 'TMS broker', folder: '~/tms-broker', since: Date.now() })
    expect(await words()).toBe('')
    expect(await p.page.$('#content .logo')).toBeNull()
    await p.page.waitForFunction(() => document.getElementById('content')!.textContent!.includes('Starting'), null, { timeout: 2000 })
    expect(await words()).toBe('Starting TMS broker The tab opens it as soon as it is ready. ~/tms-broker')
    expect(await p.page.$('#content .spin')).not.toBeNull()
  })

  it('"Opening" for a canvas already ready; "Still starting" after 15 s of starting', async () => {
    await show({ page: 'starting', phase: 'opening', name: 'TMS broker', since: Date.now() - 1000 })
    expect(await words()).toBe('Opening TMS broker The tab opens it as soon as it is ready.')
    await show({ page: 'starting', phase: 'starting', name: 'TMS broker', since: Date.now() - 16_000 })
    expect(await words()).toBe('Starting TMS broker Still starting - the terminal running marver dev says why.')
  })
})

describe('stopped (A2.11, v1.13 r2 #3, v1.14 r3 #4)', () => {
  const since = Date.now() - 5000
  const base = { page: 'stopped', name: 'TMS broker', folder: '~/tms-broker', since, command: 'cd ~/tms-broker && npx marver dev', origin: 'http://[::1]:4806' } as const

  it('the logo greyed, the command that copies, Reveal and Close; it comes back by itself', async () => {
    const r = await show({ ...base, retained: false, probe: none })
    expect(await words()).toBe(`TMS broker stopped Start it again in its folder and this tab comes back by itself. cd ~/tms-broker && npx marver dev Reveal in Finder Close Tab Stopped at ${at(since)} · was localhost:4806`)
    expect(await p.page.$('#content .logo.grey')).not.toBeNull()
    expect(await buttons()).toEqual(['Copy the start command for TMS broker', 'Reveal in Finder', 'Close Tab'])
    for (const b of await p.page.$$('#content button')) await b.click()
    expect(await p.calls('tabpage:action')).toEqual([{ rev: r, action: 'copy-start' }, { rev: r, action: 'reveal' }, { rev: r, action: 'close' }])
  })

  it('a page retained beneath: Try Again in place of "comes back by itself"; the probe\'s line names the canvas only once proved', async () => {
    const r = await show({ ...base, retained: true, probe: none })
    expect(await words()).toContain('The page you had is still open. Try Again reloads it.')
    expect(await words()).not.toContain('comes back by itself')
    expect(await buttons()).toEqual(['Copy the start command for TMS broker', 'Try Again', 'Reveal in Finder', 'Close Tab'])
    await p.page.getByRole('button', { name: 'Try Again' }).click()
    expect(await p.calls('tabpage:action')).toEqual([{ rev: r, action: 'retry' }])
    await show({ ...base, retained: true, probe: { state: 'silent', lastAt: Date.now() } })
    expect(await p.page.$('.tp-line')).toBeNull()
    await show({ ...base, retained: true, probe: { state: 'answers', lastAt: Date.now() } })
    expect(await p.page.$eval('.tp-line', (e) => e.textContent)).toBe('The address answers again')
    await show({ ...base, retained: true, probe: { state: 'proved', lastAt: Date.now() } })
    expect(await p.page.$eval('.tp-line', (e) => e.textContent)).toBe('TMS broker answers again')
  })
})

describe('not a Marver canvas (A2.11, A2.14 #11)', () => {
  it('the warning, never a logo; Try Again and Close Tab; who registered the port', async () => {
    // main may send the slot file's name: the page names no canvas until it proves itself
    const r = await show({ page: 'unverified', name: 'Hertz dealer', folder: '~/hertz-dealer', since: Date.now(), origin: 'http://[::1]:4808', retained: false, probe: none })
    expect(await p.page.$('#content .logo')).toBeNull()
    expect(await p.page.$('#content .warn')).not.toBeNull()
    expect(await words()).toBe('Not a Marver canvas Something else answers on this port: a canvas that stopped without cleaning up, or another program, or the canvas failed to render - its terminal says why. The app shows nothing it serves. Try Again Close Tab Registered by ~/hertz-dealer · localhost:4808')
    expect(await p.page.title()).toBe('Not a Marver canvas')
    await p.page.getByRole('button', { name: 'Try Again' }).click()
    expect(await p.calls('tabpage:action')).toEqual([{ rev: r, action: 'retry' }])
  })

  it('it already says something answers: no line for an answer, a line once the canvas proves itself', async () => {
    await show({ page: 'unverified', name: 'TMS broker', since: Date.now(), origin: 'http://[::1]:4806', retained: true, probe: { state: 'answers', lastAt: 1 } })
    expect(await p.page.$('.tp-line')).toBeNull()
    await show({ page: 'unverified', name: 'TMS broker', since: Date.now(), origin: 'http://[::1]:4806', retained: true, probe: { state: 'proved', lastAt: 2 } })
    expect(await p.page.$eval('.tp-line', (e) => e.textContent)).toBe('TMS broker answers again')
  })
})

describe('can\'t be reached (A2.11)', () => {
  it('trying again by itself, Try Now; with a page retained, Try Again and no "trying again"', async () => {
    await show({ page: 'unreachable', name: 'TMS broker', since: Date.now(), origin: 'http://[::1]:4806', reason: 'The server didn\'t answer', retained: false, probe: none })
    expect(await words()).toBe('Can\'t reach TMS broker The server didn\'t answer Try Now Close Tab Trying again every few seconds')
    await show({ page: 'unreachable', name: 'TMS broker', since: Date.now(), origin: 'http://[::1]:4806', retained: true, probe: none })
    expect(await words()).toBe('Can\'t reach TMS broker Its address doesn\'t answer. The page you had is still open. Try Again reloads it. Try Again Close Tab')
  })
})

describe('crashed (A2.11)', () => {
  it('the first time: ground for 400 ms, then "Reloading after a crash", no buttons', async () => {
    await show({ page: 'crashed', name: 'Tidewell', since: Date.now(), latched: false })
    expect(await words()).toBe('')
    await p.page.waitForFunction(() => document.querySelector('#content h1')?.textContent === 'Reloading after a crash', null, { timeout: 2000 })
    expect(await buttons()).toEqual([])
  })

  it('latched: the reason in words, the count; Reload and Copy Details, on the snapshot\'s own rev', async () => {
    const since = Date.now() - 60_000
    const r = await show({ page: 'crashed', name: 'Tidewell', since, latched: true, reason: 'oom', crashes: 2, dark: true })
    expect(await words()).toBe(`Tidewell's page keeps crashing The canvas itself is fine. Reload brings back its board and camera; the details hold versions and this Mac, never your files. Reload Copy Details Out of memory · 2 crashes since ${at(since)}`)
    expect(await p.page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)
    await p.page.getByRole('button', { name: 'Reload' }).click()
    await p.page.getByRole('button', { name: 'Copy Details' }).click()
    expect(await p.calls('tabpage:action')).toEqual([{ rev: r, action: 'reload' }, { rev: r, action: 'copy-details' }])
    // a send has no answer, and main refuses an old rev: no button claims it copied
    expect(await buttons()).toEqual(['Reload', 'Copy Details'])
  })
})

describe('revisions, names, focus (A2.13, A2.14 #19)', () => {
  it('an older snapshot is ignored; buttons carry the newest rev', async () => {
    const r = await show({ page: 'unverified', name: 'Newer', since: Date.now(), origin: 'http://[::1]:4806', retained: false, probe: none })
    await p.send('tabpage', { page: 'stopped', name: 'Older', since: Date.now(), command: 'x', retained: false, probe: none, rev: r - 1 })
    expect(await words()).toContain('Not a Marver canvas')
    await p.page.getByRole('button', { name: 'Close Tab' }).click()
    expect(await p.calls('tabpage:action')).toEqual([{ rev: r, action: 'close' }])
  })

  it('a name is text, never markup; the view is named for what it shows', async () => {
    await show({ page: 'stopped', name: '<img src=x onerror=alert(1)>', since: Date.now(), command: 'cd ~/x && npx marver dev', retained: false, probe: none })
    expect(await p.page.$eval('h1', (e) => e.textContent)).toBe('<img src=x onerror=alert(1)> stopped')
    expect(await p.page.$$eval('img', (els) => els.length)).toBe(0)
    expect(await p.page.title()).toBe('<img src=x onerror=alert(1)> stopped')
  })

  it('page:focus heading focuses the page\'s heading region, which is named by its title', async () => {
    await show({ page: 'stopped', name: 'TMS broker', since: Date.now(), command: 'x', retained: false, probe: none })
    await p.send('page:focus', { target: 'heading' })
    expect(await p.page.evaluate(() => [document.activeElement?.id, document.activeElement?.getAttribute('role')])).toEqual(['content', 'region'])
    expect(await p.page.locator('#content').ariaSnapshot()).toMatch(/^- region "TMS broker stopped":/)
  })

  it('a new snapshot keeps focus on the same action: a probe\'s update never sends VoiceOver back to the heading', async () => {
    const base = { page: 'stopped', name: 'TMS broker', since: Date.now(), command: 'cd ~/tms-broker && npx marver dev', retained: true } as const
    await show({ ...base, probe: none })
    await p.page.getByRole('button', { name: 'Try Again' }).focus()
    await show({ ...base, probe: { state: 'answers', lastAt: Date.now() } })
    expect(await p.page.$eval('.tp-line', (e) => e.textContent)).toBe('The address answers again')
    expect(await p.page.evaluate(() => [document.activeElement?.textContent, (document.activeElement as HTMLElement).dataset.act])).toEqual(['Try Again', 'retry'])
    await p.page.getByRole('button', { name: 'Copy the start command for TMS broker' }).focus()
    const r = await show({ ...base, probe: { state: 'proved', lastAt: Date.now() } })
    expect(await p.page.evaluate(() => (document.activeElement as HTMLElement).dataset.act)).toBe('copy-start')
    await p.page.keyboard.press('Enter')
    expect(await p.calls('tabpage:action')).toEqual([{ rev: r, action: 'copy-start' }])
    expect(await p.page.locator('#content .cmd').innerText()).not.toContain('Copied')
    // the focused action gone (no page retained: no Try Again), focus goes to the heading region, never nothing
    await p.page.getByRole('button', { name: 'Try Again' }).focus()
    await show({ ...base, retained: false, probe: none })
    expect(await p.page.evaluate(() => document.activeElement?.id)).toBe('content')
  })

  it('loads under the CSP with nothing refused', async () => { expect(await p.csp()).toEqual([]) })
})
