/**
 * Settings v2 (spec 33 A, C, D; spec 28 A2.7, A2.12, A2.13), windowless: the real page and the real app preload under a
 * fake main (test/harness/pages.ts). The column and its groups, the rows `view.shown` allows, the real controls - switch,
 * segmented, the days select on the Marver menu - each change one settings:set, every refusal reverting its control
 * with the reason, a file that does not apply, Notices, the Updates row in each state and its button's token, D.
 * Main's side runs in test/unit (config, updater, bridge, r30-commands) and against the real app in test/pw/files.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FileState, SettingsView, UpdateRow } from '../../src/shared/channels.ts'
import { shownKeys } from '../../src/shared/settings-keys.ts'
import { openPage, type PageRun } from '../harness/pages.ts'

const fs = (ok = true, values: Record<string, unknown> = {}): FileState => ({ present: true, ok, sha256: 'x', applied: { sha256: 'x', values } })
interface V {
  config?: Record<string, unknown>; mode?: string; theme?: Partial<SettingsView['theme']>; writable?: boolean; write?: SettingsView['status']['write']
  shown?: string[]; outcome?: SettingsView['notices']['outcome']; update?: Partial<UpdateRow>
}
function view(o: V = {}): SettingsView {
  const theme = { ...fs(), values: { mode: o.mode ?? 'system' }, ...o.theme }
  return {
    dir: '~/.marver', statusFile: '~/.marver/state-dev/status.json', shown: o.shown ?? shownKeys('a4'),
    config: { ...fs(), values: { restoreTabs: true, unloadUnderPressure: true, recorder: true, keepPerfDays: 14, notifications: true, dockBadge: true, autoUpdate: true, ...o.config } },
    theme,
    status: { v: 1, app: '1.2.1', at: 1, writable: o.writable ?? true, files: { 'config.json': fs(), 'theme.json': theme }, ...(o.write ? { write: o.write } : {}) },
    notices: { outcome: o.outcome ?? 'unknown' },
    update: { show: 'current', version: '1.2.1', checkedAt: Date.now() - 4 * 60_000, token: { act: 'check' }, ...o.update },
  }
}

let p: PageRun
/** draws this view: answered, then a status push (the page asks again) */
async function draw(v: SettingsView): Promise<void> {
  await p.answer('settings:get', v)
  await p.send('status', v.status)
  await p.page.waitForTimeout(40)
}
beforeAll(async () => {
  p = await openPage('settings', { width: 1280, height: 800 })
  p.page.setDefaultTimeout(5000)
  await draw(view())
  await p.page.waitForSelector('[role="switch"]')
})
afterAll(async () => { await p?.close() })
beforeEach(async () => {
  // a menu a case left open closes as an outside press closes it
  await p.page.evaluate(() => document.querySelector('.mv-catcher')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
  await p.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  await p.page.keyboard.press('Escape')
  await p.media({})
  await p.answer('settings:set', { ok: true })
  await draw(view())
  await p.clear()
})

const ctl = (id: string) => p.page.locator(`[data-ctl="${id}"]`)
const descOf = (id: string) => p.page.$eval(`[data-ctl="${id}"]`, (e) => e.closest('.st-row')!.querySelector('.st-desc')!.textContent)
const style = (sel: string, props: string[], pseudo?: string) => p.page.$eval(sel, (e, [ps, pse]) => {
  const cs = getComputedStyle(e, pse as string | undefined)
  return Object.fromEntries((ps as string[]).map((k) => [k, cs.getPropertyValue(k)]))
}, [props, pseudo] as const)

describe('the page (A1, A2, A3)', () => {
  it('the heading, the five groups in order, each row with its key\'s name, the footer\'s Show the files', async () => {
    expect(await p.page.locator('main').ariaSnapshot()).toBe([
      '- main:',
      '  - heading "Settings" [level=1]',
      '  - paragraph:',
      '    - text: Saved as plain files in',
      '    - code: ~/.marver/',
      '    - text: "- your agents read the same ones."',
      '  - region "Updates":',
      '    - heading "Updates" [level=3]',
      '    - text: Marver 1.2.1 Marver is up to date',
      '    - button "Check for updates"',
      '    - text: Last checked 4 minutes ago Download updates automatically Marver checks every few hours and gets an update ready; it asks before restarting',
      '    - code: autoUpdate',
      '    - switch "Download updates automatically" [checked]',
      '  - region "Appearance":',
      '    - heading "Appearance" [level=3]',
      '    - text: Theme Canvases keep their own · switch with D',
      '    - radiogroup "Theme":',
      '      - radio "System" [checked]',
      '      - radio "Light"',
      '      - radio "Dark"',
      '  - region "Tabs":',
      '    - heading "Tabs" [level=3]',
      '    - text: Reopen tabs at launch The canvases you had open come back',
      '    - code: restoreTabs',
      '    - switch "Reopen tabs at launch" [checked]',
      '    - text: Unload hidden tabs when memory runs short Never one that is busy; it reloads when you come back',
      '    - code: unloadUnderPressure',
      '    - switch "Unload hidden tabs when memory runs short" [checked]',
      '  - region "Notices":',
      '    - heading "Notices" [level=3]',
      '    - text: "Notices When a canvas needs you: a question, a review, a run that failed"',
      '    - code: notifications',
      '    - switch "Notices" [checked]',
      '    - text: macOS decides whether notices show. With Marver set to Don\'t Allow, or a Focus that silences it, they don\'t appear, and Marver can\'t tell.',
      '    - button "Open System Settings"',
      '    - text: Dock badge The number of canvases that need you',
      '    - code: dockBadge',
      '    - switch "Dock badge" [checked]',
      '  - region "Performance":',
      '    - heading "Performance" [level=3]',
      '    - text: Performance recorder What loads slowly, what flashes white - for you and your agent',
      '    - code: recorder',
      '    - switch "Performance recorder" [checked]',
      '    - text: Keep performance files Older days are deleted whole',
      '    - code: keepPerfDays',
      '    - button "Keep performance files 14 days": 14 days',
      '  - code: config.json',
      '  - text: and',
      '  - code: theme.json',
      '  - text: in',
      '  - code: ~/.marver/',
      '  - button "Show the files"',
    ].join('\n'))
  })

  it('the column is 680 px, centred at 1280, on Home\'s ground', async () => {
    const r = await p.page.$eval('.st-col', (e) => { const b = e.getBoundingClientRect(); return [b.width, Math.round(b.left), Math.round(window.innerWidth - b.right)] })
    expect(r[0]).toBe(680)
    expect(r[1]).toBe(r[2])
    expect((await style('body', ['background-image']))['background-image']).toContain('radial-gradient')
  })

  it('the rows follow view.shown: app 0.1\'s two keys alone; no Dock badge until notices are on', async () => {
    await draw(view({ shown: shownKeys('a2') }))
    expect(await p.page.$$eval('.st-group h3', (els) => els.map((e) => e.textContent))).toEqual(['Updates', 'Appearance', 'Tabs'])
    expect(await p.page.$$eval('[data-ctl]', (els) => els.map((e) => (e as HTMLElement).dataset.ctl))).toEqual(['theme.mode.system', 'theme.mode.light', 'theme.mode.dark', 'config.restoreTabs'])
    await draw(view({ config: { notifications: false } }))
    expect(await ctl('config.dockBadge').count()).toBe(0)
    expect(await ctl('config.notifications').getAttribute('aria-checked')).toBe('false')
  })
})

describe('the controls (A4)', () => {
  it('a switch: the accent and the knob across when on, the chip when off; a click is one settings:set', async () => {
    const on = await style('[data-ctl="config.restoreTabs"]', ['background-image', 'width', 'height'])
    expect(on).toMatchObject({ width: '38px', height: '22px' })
    expect(on['background-image']).toMatch(/^linear-gradient/)
    expect((await style('[data-ctl="config.restoreTabs"] i', ['transform'])).transform).toBe('matrix(1, 0, 0, 1, 16, 0)')
    await p.answer('settings:get', view({ config: { restoreTabs: false } }))
    await ctl('config.restoreTabs').click()
    await p.page.waitForFunction(() => document.querySelector('[data-ctl="config.restoreTabs"]')!.getAttribute('aria-checked') === 'false')
    expect(await p.calls('settings:set')).toEqual([{ file: 'config', key: 'restoreTabs', value: false }])
    const off = await style('[data-ctl="config.restoreTabs"]', ['background-image', 'background-color'])
    expect(off['background-image']).toBe('none')
    expect(off['background-color']).toBe('rgba(24, 24, 27, 0.05)')
    expect((await style('[data-ctl="config.restoreTabs"] i', ['transform'])).transform).toBe('none')
  })

  it('the segmented control: Dark sends theme mode dark, the chosen one follows the view', async () => {
    await p.answer('settings:get', view({ mode: 'dark' }))
    await ctl('theme.mode.dark').click()
    await p.page.waitForFunction(() => document.querySelector('[data-ctl="theme.mode.dark"]')!.getAttribute('aria-checked') === 'true')
    expect(await p.calls('settings:set')).toEqual([{ file: 'theme', key: 'mode', value: 'dark' }])
    expect(await ctl('theme.mode.system').getAttribute('aria-checked')).toBe('false')
  })

  it('the days select: a menu of 7, 14, 30, 90 with 14 checked; 30 sends keepPerfDays 30; a file\'s 21 is listed in order; a window blur closes it', async () => {
    const rows = () => p.page.$$eval('.mv-menu [role="menuitemradio"]', (els) => els.map((e) => [e.textContent, e.getAttribute('aria-checked')]))
    await ctl('config.keepPerfDays').click()
    await p.page.waitForSelector('.mv-menu')
    expect(await rows()).toEqual([['7 days', 'false'], ['14 days', 'true'], ['30 days', 'false'], ['90 days', 'false']])
    expect(await ctl('config.keepPerfDays').getAttribute('aria-expanded')).toBe('true')
    // right-aligned on the button (near the window's foot it opens upward, menu.ts B7)
    const [b, m] = await p.page.evaluate(() => [document.querySelector('.st-select-btn')!.getBoundingClientRect().toJSON(), document.querySelector('.mv-menu')!.getBoundingClientRect().toJSON()])
    expect(Math.round(m.right)).toBe(Math.round(b.right))
    await p.answer('settings:get', view({ config: { keepPerfDays: 30 } }))
    const row30 = p.page.locator('.mv-menu [data-id="30"]')
    await row30.hover()
    await p.page.waitForTimeout(300)
    await row30.click()
    await p.page.waitForFunction(() => document.getElementById('keep-now')!.textContent === '30 days')
    expect(await p.calls('settings:set')).toEqual([{ file: 'config', key: 'keepPerfDays', value: 30 }])
    expect(await p.page.locator('.mv-menu').count()).toBe(0)

    await draw(view({ config: { keepPerfDays: 21 } }))
    await ctl('config.keepPerfDays').click()
    await p.page.waitForSelector('.mv-menu')
    expect(await rows()).toEqual([['7 days', 'false'], ['14 days', 'false'], ['21 days', 'true'], ['30 days', 'false'], ['90 days', 'false']])
    await p.page.evaluate(() => window.dispatchEvent(new Event('blur')))
    expect(await p.page.locator('.mv-menu').count()).toBe(0)
    expect(await ctl('config.keepPerfDays').getAttribute('aria-expanded')).toBe('false')
  })

  it('Reduce Transparency: the cards lose the blur and take the solid fill', async () => {
    expect((await style('.st-card', ['backdrop-filter']))['backdrop-filter']).toContain('blur(24px)')
    await p.media({ 'prefers-reduced-transparency': 'reduce' })
    expect((await style('.st-card', ['backdrop-filter']))['backdrop-filter']).toBe('none')
    expect((await style('.st-seg', ['backdrop-filter']))['backdrop-filter']).toBe('none')
  })

  it('Reduce Motion: the switch does not slide', async () => {
    await p.media({ 'prefers-reduced-motion': 'reduce' })
    expect(await p.page.$eval('[role="switch"]', (e) => [getComputedStyle(e).transitionDuration, getComputedStyle(e.querySelector('i')!).transitionDuration])).toEqual(['0s', '0s'])
  })
})

describe('refused, the control goes back and the row says why (A5)', () => {
  for (const [answer, words] of [
    [{ ok: false, why: 'write-failed', code: 'ENOSPC' }, 'Couldn\'t save config.json: the disk is full'],
    [{ ok: false, why: 'unwritable' }, '~/.marver can\'t be written'],
    [{ ok: false, why: 'bad-value' }, 'That value isn\'t one this setting takes'],
  ] as const) {
    it(answer.why, async () => {
      await p.answer('settings:set', answer)
      await ctl('config.restoreTabs').click()
      await p.page.waitForFunction((w) => [...document.querySelectorAll('.st-desc.err')].some((e) => e.textContent!.startsWith(w)), words)
      expect(await ctl('config.restoreTabs').getAttribute('aria-checked')).toBe('true')
      expect(await descOf('config.restoreTabs')).toBe(`${words}restoreTabs`)
      await p.page.waitForFunction((w) => document.getElementById('live')!.textContent === w, words)
    })
  }

  it('a set main never answers: the control goes back; the reason stays through a push and goes with the next good change', async () => {
    await p.reject('settings:set')
    await ctl('config.restoreTabs').click()
    await p.page.waitForFunction(() => document.querySelector('.st-desc.err')?.textContent?.startsWith('Couldn\'t save config.json: the write failed'))
    await p.send('status', view().status)
    await p.page.waitForTimeout(50)
    expect(await descOf('config.restoreTabs')).toBe('Couldn\'t save config.json: the write failedrestoreTabs')
    await p.answer('settings:set', { ok: true })
    await ctl('config.restoreTabs').click()
    await p.page.waitForFunction(() => !document.querySelector('.st-desc.err'))
  })
})

describe('the files (A2, A5)', () => {
  it('a file that does not apply: its card first, each problem, its text as text, the status file', async () => {
    await draw(view({ theme: { ok: false, problems: [{ key: 'mode', message: 'mode must be "system", "light" or "dark"' }], text: '{ "mode": "<script>alert(1)</script>" }' } }))
    await p.page.waitForSelector('.st-bad')
    expect(await p.page.$$eval('.st-col > *, .st-bads > *, .st-groups > *', (els) => els.filter((e) => getComputedStyle(e).display !== 'contents').map((e) => e.className)).then((c) => c.slice(0, 3)))
      .toEqual(['st-head', 'st-bad', 'st-group'])
    expect(await p.page.$eval('.st-bad-h', (e) => e.textContent)).toBe('theme.json did not apply · using the last good one')
    expect(await p.page.$$eval('.st-bad li', (els) => els.map((e) => e.textContent))).toEqual(['mode must be "system", "light" or "dark"'])
    expect(await p.page.$eval('.st-bad pre', (e) => e.textContent)).toBe('{ "mode": "<script>alert(1)</script>" }')
    expect(await p.page.$$eval('script', (els) => els.length)).toBe(1)
    expect(await p.page.$eval('.st-bad code', (e) => e.textContent)).toBe('~/.marver/state-dev/status.json')
  })

  it('a home that cannot be written, and a write that failed, are said under the heading', async () => {
    await draw(view({ writable: false }))
    await p.page.waitForFunction(() => document.getElementById('note')!.textContent === '~/.marver can\'t be written · nothing is kept')
    await draw(view({ write: { file: '~/.marver/state-dev/recent.json', code: 'ENOSPC', at: 1 } }))
    await p.page.waitForFunction(() => document.getElementById('note')!.textContent === 'Couldn\'t save ~/.marver/state-dev/recent.json: the disk is full')
  })

  it('a status push draws again, keeping focus on the same control', async () => {
    await ctl('config.restoreTabs').focus()
    await draw(view({ config: { restoreTabs: false } }))
    await p.page.waitForFunction(() => document.querySelector('[data-ctl="config.restoreTabs"]')!.getAttribute('aria-checked') === 'false')
    expect(await p.page.evaluate(() => (document.activeElement as HTMLElement).dataset.ctl)).toBe('config.restoreTabs')
  })

  it('Show the files asks main to open the folder; the preload exposes Settings\' own methods alone', async () => {
    await p.page.click('#reveal')
    expect(await p.calls('settings:reveal')).toEqual([null])
    expect(await p.page.evaluate(() => Object.keys((window as unknown as { marverPage: object }).marverPage).sort()))
      .toEqual(['action', 'get', 'kind', 'onStatus', 'onWindow', 'ready', 'reveal', 'set'])
  })

  it('loads under the CSP with nothing refused', async () => { expect(await p.csp()).toEqual([]) })
})

describe('Notices (A4.6 #25, #27)', () => {
  it('macOS decides: the line, Open System Settings sends its action; after a failed post, that line too', async () => {
    expect(await p.page.locator('#notices-failed').count()).toBe(0)
    await p.page.click('#notice-settings')
    await p.page.waitForTimeout(30)
    expect(await p.calls('settings:action')).toEqual([{ action: 'open-notification-settings' }])
    await draw(view({ outcome: 'failed' }))
    expect(await p.page.$eval('#notices-failed', (e) => e.textContent)).toBe('macOS couldn\'t post Marver\'s last notice')
  })

  it('turned on: one settings:set, then the Dock badge row', async () => {
    await draw(view({ config: { notifications: false } }))
    await p.answer('settings:get', view())
    await ctl('config.notifications').click()
    await p.page.waitForSelector('[data-ctl="config.dockBadge"]')
    expect(await p.calls('settings:set')).toEqual([{ file: 'config', key: 'notifications', value: true }])
  })
})

describe('Updates (C3-C5)', () => {
  const read = () => p.page.evaluate(() => {
    const q = (s: string) => document.querySelector(s) as HTMLElement | null
    const b = q('#update-btn') as HTMLButtonElement | null
    return {
      state: q('#update-state')?.textContent ?? null, mark: q('#update-state svg, #update-state .st-spin') ? (q('#update-state .st-spin') ? 'spin' : 'icon') : null,
      button: b ? [b.textContent, b.disabled, b.classList.contains('primary')] : null, small: q('#checked')?.textContent ?? null,
      bar: !!q('.st-bar'), notes: q('.st-notes') ? [q('.st-notes .st-label')!.textContent, [...document.querySelectorAll('.st-notes li')].map((l) => l.textContent)] : null,
    }
  })
  const T = { act: 'check' } as const
  const R = { act: 'restart', version: '1.3.0' } as const
  for (const [u, want] of [
    [{ show: 'current', token: T }, { state: 'Marver is up to date', mark: 'icon', button: ['Check for updates', false, false], small: 'Last checked 4 minutes ago', bar: false, notes: null }],
    [{ show: 'checking', token: null }, { state: 'Checking for updates…', mark: 'spin', button: ['Checking…', true, false], small: 'Last checked 4 minutes ago', bar: false, notes: null }],
    [{ show: 'downloading', token: null, checkedAt: null }, { state: 'Downloading the update…', mark: 'spin', button: ['Downloading…', true, false], small: null, bar: true, notes: null }],
    [{ show: 'ready', next: '1.3.0', notes: ['Settings in glass', 'D switches light and dark'], token: R }, { state: 'Marver 1.3.0 is ready to install', mark: 'icon', button: ['Restart to update', false, true], small: 'Your canvases keep running', bar: false, notes: ['What\'s new in 1.3.0', ['Settings in glass', 'D switches light and dark']] }],
    [{ show: 'waiting', next: '1.3.0', notes: [], tab: 'Checkout', token: { act: 'try-again', version: '1.3.0' } }, { state: 'Marver 1.3.0 waits for Checkout', mark: 'icon', button: ['Try again', false, true], small: 'It has unsaved work', bar: false, notes: ['What\'s new in 1.3.0', []] }],
    [{ show: 'restarting', next: '1.3.0', token: null }, { state: 'Restarting to install Marver 1.3.0', mark: 'spin', button: ['Restarting…', true, false], small: null, bar: false, notes: null }],
    [{ show: 'error', token: T }, { state: 'Couldn\'t check - you\'re offline, or GitHub didn\'t answer', mark: 'icon', button: ['Try again', false, false], small: null, bar: false, notes: null }],
    [{ show: 'failed', next: '1.3.0', token: { act: 'download', version: '1.3.0' } }, { state: 'Marver 1.3.0 couldn\'t be installed', mark: 'icon', button: ['Download', false, false], small: 'Install it again from the disk image', bar: false, notes: null }],
    [{ show: 'idle', checkedAt: null, token: T }, { state: null, mark: null, button: ['Check for updates', false, false], small: 'Not checked yet', bar: false, notes: null }],
    [{ show: 'idle', checkedAt: null, token: null }, { state: null, mark: null, button: ['Check for updates', true, false], small: 'Not checked yet', bar: false, notes: null }],
    [{ show: 'blocked', why: 'location', token: { act: 'explain', why: 'location' } }, { state: 'Marver updates itself only from the Applications folder', mark: 'icon', button: ['Learn more', false, false], small: null, bar: false, notes: null }],
    [{ show: 'off', token: null }, { state: 'This build doesn\'t update itself', mark: null, button: null, small: null, bar: false, notes: null }],
  ] as [Partial<UpdateRow>, Awaited<ReturnType<typeof read>>][]) {
    it(`${u.show}${u.token === null ? ' (no token)' : ''}`, async () => {
      await draw(view({ update: u }))
      expect(await read()).toEqual(want)
    })
  }

  it('the button sends its row\'s token; Release notes sends its own action, no link', async () => {
    await draw(view({ update: { show: 'ready', next: '1.3.0', notes: ['A'], token: R } }))
    await p.page.click('#update-btn')
    await p.page.click('#release-notes')
    await p.page.waitForTimeout(30)
    expect(await p.calls('settings:action')).toEqual([{ action: 'update', token: R }, { action: 'release-notes' }])
  })

  it('"Last checked" is rewritten in place each minute: an open menu stays', async () => {
    await draw(view({ update: { checkedAt: Date.now() - 3 * 3600_000 } }))
    await ctl('config.keepPerfDays').click()
    await p.page.waitForSelector('.mv-menu')
    const menu = await p.page.$('.mv-menu')
    await p.page.evaluate(() => { document.getElementById('checked')!.dataset.at = String(Date.now() - 2 * 60_000) })
    // the page's minute tick (a real minute: the interval was set at load)
    await p.page.waitForFunction(() => document.getElementById('checked')!.textContent === 'Last checked 2 minutes ago', null, { timeout: 65_000 })
    expect(await menu!.evaluate((e) => e.isConnected)).toBe(true)
  }, 70_000)
})

describe('D (spec 33 D)', () => {
  it('d sends the opposite of what shows, by key; Meta+d, d in the days menu send nothing', async () => {
    await p.media({ 'prefers-color-scheme': 'light' })
    await p.page.keyboard.press('d')
    await p.page.waitForTimeout(40)
    expect(await p.calls('settings:set')).toEqual([{ file: 'theme', key: 'mode', value: 'dark', via: 'key' }])
    await p.clear()
    await p.media({ 'prefers-color-scheme': 'dark' })
    await p.page.waitForFunction(() => document.documentElement.classList.contains('dark'))
    await p.page.keyboard.press('d')
    await p.page.waitForTimeout(40)
    expect(await p.calls('settings:set')).toEqual([{ file: 'theme', key: 'mode', value: 'light', via: 'key' }])
    await p.clear()
    await p.page.keyboard.press('Meta+d')
    await ctl('config.keepPerfDays').click()
    await p.page.waitForSelector('.mv-menu')
    await p.page.keyboard.press('d')
    await p.page.waitForTimeout(40)
    expect(await p.calls('settings:set')).toEqual([])
    await p.media({ 'prefers-color-scheme': 'light' })
  })
})
