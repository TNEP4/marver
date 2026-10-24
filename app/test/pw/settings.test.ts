/**
 * Settings, a view of the files (spec 28 A2.7, A2.12, A2.13): the real page and the real app preload under a fake
 * main (test/harness/pages.ts). The keys app 0.1 shows, a change as one settings:set, every refusal reverting its
 * control with the reason, a file that does not apply, the status push keeping focus, Show the Files, ARIA. Main's
 * side of the same round trip runs in test/unit/config.test.ts and against the real app in test/pw/files.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FileState, SettingsView } from '../../src/shared/channels.ts'
import { openPage, type PageRun } from '../harness/pages.ts'
import { shownKeys } from '../../src/shared/settings-keys.ts'

const fs = (ok = true, values: Record<string, unknown> = {}): FileState => ({ present: true, ok, sha256: 'x', applied: { sha256: 'x', values } })
function view(o: { restoreTabs?: boolean; mode?: string; theme?: Partial<SettingsView['theme']>; writable?: boolean; write?: SettingsView['status']['write'] } = {}): SettingsView {
  const theme = { ...fs(), values: { mode: o.mode ?? 'system' }, ...o.theme }
  return {
    dir: '~/.marver', statusFile: '~/.marver/state-dev/status.json', shown: ['config.restoreTabs', 'theme.mode'],
    config: { ...fs(), values: { restoreTabs: o.restoreTabs ?? true, unloadUnderPressure: true, recorder: true, keepPerfDays: 14, dockBadge: true } },
    theme,
    status: { v: 1, app: '0.1.0', at: 1, writable: o.writable ?? true, files: { 'config.json': fs(), 'theme.json': theme }, ...(o.write ? { write: o.write } : {}) },
  }
}

let p: PageRun
beforeAll(async () => {
  p = await openPage('settings', { width: 1100, height: 720 })
  await p.answer('settings:get', view())
  await p.send('status', view().status)
  await p.page.waitForSelector('[role="switch"]')
})
afterAll(async () => { await p?.close() })
beforeEach(async () => {
  await p.answer('settings:get', view())
  await p.answer('settings:set', { ok: true })
  await p.send('status', view().status)
  await p.page.waitForTimeout(30)
  await p.clear()
})

const sw = () => p.page.locator('[role="switch"]')
const rowErr = (key: string) => p.page.$eval(`[data-ctl="${key}"]`, (e) => e.closest('.row-wrap')!.querySelector('.row-err')!.textContent)

describe('the keys (A2.7, A2.14 #23)', () => {
  it('app 0.1 shows Reopen tabs at launch and Appearance, each under its file, the key\'s name under its label', async () => {
    expect(await p.page.locator('main').ariaSnapshot()).toBe([
      '- main:',
      '  - heading "Settings" [level=1]',
      '  - region "~/.marver/config.json":',
      '    - heading "~/.marver/config.json" [level=2]',
      '    - text: Reopen tabs at launch restoreTabs',
      '    - switch "Reopen tabs at launch" [checked]',
      '  - region "~/.marver/theme.json":',
      '    - heading "~/.marver/theme.json" [level=2]',
      '    - text: Appearance mode - system, light or dark',
      '    - combobox "Appearance":',
      '      - option "System" [selected]',
      '      - option "Light"',
      '      - option "Dark"',
      '  - button "Show the Files"',
    ].join('\n'))
  })

  it('a switch is one settings:set of that key; the page draws main\'s answer', async () => {
    await p.answer('settings:get', view({ restoreTabs: false }))
    await sw().click()
    await p.page.waitForFunction(() => document.querySelector('[role="switch"]')!.getAttribute('aria-checked') === 'false')
    expect(await p.calls('settings:set')).toEqual([{ file: 'config', key: 'restoreTabs', value: false }])
    expect((await p.calls('settings:get')).length).toBeGreaterThanOrEqual(1)
  })

  it('the menu sets mode', async () => {
    await p.answer('settings:get', view({ mode: 'dark' }))
    await p.page.selectOption('select', 'dark')
    await p.page.waitForFunction(() => (document.querySelector('select') as HTMLSelectElement).value === 'dark')
    expect(await p.calls('settings:set')).toEqual([{ file: 'theme', key: 'mode', value: 'dark' }])
  })
})

describe('A3\'s rows, as main sends them once STAGE is a3 (A3.8 #46)', () => {
  // this branch's build is STAGE a2 until the streams meet (settings-keys.ts): main sends shownKeys('a3') then
  const a3 = (unload = true): SettingsView => { const v = view(); return { ...v, shown: shownKeys('a3'), config: { ...v.config, values: { ...v.config.values, unloadUnderPressure: unload } } } }

  it('Unload hidden tabs when memory runs short: on by default, its key and note under it; a switch is one settings:set of it', async () => {
    await p.answer('settings:get', a3())
    await p.send('status', a3().status)
    await p.page.waitForSelector('[data-ctl="config.unloadUnderPressure"]')
    const config = await p.page.locator('section[aria-labelledby="h-config"]').ariaSnapshot()
    expect(config).toContain('- text: Unload hidden tabs when memory runs short unloadUnderPressure - never a busy one')
    expect(config).toContain('- switch "Unload hidden tabs when memory runs short" [checked]')
    await p.answer('settings:get', a3(false))
    await p.page.click('[data-ctl="config.unloadUnderPressure"]')
    await p.page.waitForFunction(() => document.querySelector('[data-ctl="config.unloadUnderPressure"]')!.getAttribute('aria-checked') === 'false')
    expect(await p.calls('settings:set')).toEqual([{ file: 'config', key: 'unloadUnderPressure', value: false }])
  })
})

describe('refused, the control goes back and the row says why', () => {
  for (const [answer, words] of [
    [{ ok: false, why: 'write-failed', code: 'ENOSPC' }, 'Couldn\'t save config.json: the disk is full'],
    [{ ok: false, why: 'unwritable' }, '~/.marver can\'t be written'],
    [{ ok: false, why: 'bad-value' }, 'That value isn\'t one this setting takes'],
  ] as const) {
    it(answer.why, async () => {
      await p.answer('settings:set', answer)
      await sw().click()
      await p.page.waitForFunction((w) => [...document.querySelectorAll('.row-err')].some((e) => e.textContent === w), words)
      expect(await sw().getAttribute('aria-checked')).toBe('true')
      expect(await rowErr('config.restoreTabs')).toBe(words)
    })
  }

  it('a set main never answers (no handler, or it threw): the control goes back, the row says why', async () => {
    await p.reject('settings:set')
    await sw().click()
    await p.page.waitForFunction(() => document.querySelector('.row-err')!.textContent!.startsWith('Couldn\'t save config.json'))
    expect(await sw().getAttribute('aria-checked')).toBe('true')
    expect(await rowErr('config.restoreTabs')).toBe('Couldn\'t save config.json: the write failed')
    await p.answer('settings:set', { ok: true })
    await sw().click()
    await p.page.waitForFunction(() => document.querySelector('.row-err')!.textContent === '')
  })

  it('the reason stays through a status push, and goes with the next good change', async () => {
    await p.answer('settings:set', { ok: false, why: 'write-failed', code: 'EACCES' })
    await sw().click()
    await p.page.waitForFunction(() => document.querySelector('.row-err')!.textContent!.includes('no permission'))
    await p.send('status', view().status)
    await p.page.waitForTimeout(50)
    expect(await rowErr('config.restoreTabs')).toBe('Couldn\'t save config.json: no permission')
    await p.answer('settings:set', { ok: true })
    await sw().click()
    await p.page.waitForFunction(() => document.querySelector('.row-err')!.textContent === '')
  })
})

describe('the files (A2.7, A2.12)', () => {
  it('a file that does not apply: said under its heading, each problem, its text beside as text', async () => {
    const bad = view({ theme: { ok: false, problems: [{ key: 'mode', message: 'mode must be "system", "light" or "dark"' }], text: '{ "mode": "<script>alert(1)</script>" }' } })
    await p.answer('settings:get', bad)
    await p.send('status', bad.status)
    await p.page.waitForSelector('.problem')
    expect(await p.page.$eval('.problem', (e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()))
      .toBe('theme.json did not apply · using the last good one mode must be "system", "light" or "dark"')
    expect(await p.page.$eval('.side pre', (e) => e.textContent)).toBe('{ "mode": "<script>alert(1)</script>" }')
    expect(await p.page.$$eval('script', (els) => els.length)).toBe(1)
    // the status file main names: state-dev/ in the development build, where an agent must look
    expect(await p.page.$eval('.side code', (e) => e.textContent)).toBe('~/.marver/state-dev/status.json')
  })

  it('a home that cannot be written, and a write that failed, are said at the top', async () => {
    await p.answer('settings:get', view({ writable: false }))
    await p.send('status', view({ writable: false }).status)
    await p.page.waitForFunction(() => document.getElementById('note')!.textContent === '~/.marver can\'t be written · nothing is kept')
    const w = view({ write: { file: '~/.marver/state-dev/recent.json', code: 'ENOSPC', at: 1 } })
    await p.answer('settings:get', w)
    await p.send('status', w.status)
    await p.page.waitForFunction(() => document.getElementById('note')!.textContent === 'Couldn\'t save ~/.marver/state-dev/recent.json: the disk is full')
  })

  it('a status push draws again, keeping focus on the same control', async () => {
    await sw().focus()
    await p.answer('settings:get', view({ restoreTabs: false }))
    await p.send('status', view().status)
    await p.page.waitForFunction(() => document.querySelector('[role="switch"]')!.getAttribute('aria-checked') === 'false')
    expect(await p.page.evaluate(() => (document.activeElement as HTMLElement).dataset.ctl)).toBe('config.restoreTabs')
  })

  it('Show the Files asks main to open the folder', async () => {
    await p.page.click('#reveal')
    expect(await p.calls('settings:reveal')).toEqual([null])
  })

  it('the preload exposes Settings\' own methods alone, and no channel', async () => {
    expect(await p.page.evaluate(() => Object.keys((window as unknown as { marverPage: object }).marverPage).sort()))
      .toEqual(['get', 'kind', 'onStatus', 'onWindow', 'ready', 'reveal', 'set'])
  })

  it('Reduce Motion: the switch does not slide', async () => {
    await p.media({ 'prefers-reduced-motion': 'reduce' })
    expect(await p.page.$eval('[role="switch"]', (e) => [getComputedStyle(e).transitionDuration, getComputedStyle(e, '::after').transitionDuration])).toEqual(['0s', '0s'])
    await p.media({})
  })

  it('loads under the CSP with nothing refused', async () => { expect(await p.csp()).toEqual([]) })
})
