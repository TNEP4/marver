import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'

/**
 * Spec 30 R14 #55, R16's first compatibility case: a 0.30 page in app 1.0.0. A REAL `marver dev` and a REAL Chrome, whose
 * page gets `window.marverApp` shaped as app 1.0.0's preload exposed it (70f365a0, app/src/preload/canvas.ts): every
 * method it has, none it has not, and a `perfInfo()` with no `watch`. The page says hello as ever, never sends `mv:perf
 * watch` (1.0.0 would refuse it and spend the tab's bucket), and its page and reload records are whole - the dev server
 * writes them, whatever the app is. A relay from it says `in: app`. The same steps under 1.0.1's `perfInfo()` are the
 * control: they do send `watch`, so its absence here means something. The window's own half needs the app's binary:
 * app/test/prod/recorder.test.ts. Skips, never fails, without Chrome.
 */

const FRAME = (t: string) => `export const meta = { title: '${t}', viewport: 'mobile' }\nexport default () => <main style={{ padding: 24 }}><h1>${t}</h1></main>\n`
/** What app 1.0.0 takes on `mv:perf`: its `PerfMsg` kinds (70f365a0, src/shared/app-api.ts). */
const APP_100_PERF = ['gesture', 'probes', 'mem', 'shown', 'board']

/** The preload's `window.marverApp`, as a page sees it: `perfInfo` as given, what the page says kept for the case. */
const PRELOAD = (perfInfo: string) => `(() => {
  const copy = (p) => JSON.parse(JSON.stringify(p))
  const log = { hello: [], perf: [] }
  const menuClick = new Set()
  const none = () => () => {}
  window.marverApp = Object.freeze({
    v: 1, topInset: 0, reopen: false,
    hello: (p) => { log.hello.push(copy(p)) }, theme() {}, busy() {}, menu() {},
    onAppState: none,
    onMenuClick: (fn) => { menuClick.add(fn); return () => menuClick.delete(fn) },
    onPresent: none, presented() {},
    perf: (p) => { log.perf.push(copy(p)) },
    onPerfAsk: none,
    perfInfo: () => (${perfInfo}),
    onOpen: none,
    capture: async () => ({ ok: false, why: 'untrusted' }),
  })
  window.__fake = { log, click: (id) => { for (const fn of menuClick) fn({ id }); return menuClick.size } }
})()`
const APP_100 = '{ hz: 120 }', APP_101 = '{ hz: 120, watch: true }'

let root = ''
let dev: Dev | null = null
let browser: Browser | null = null
const tabs: string[] = []

beforeAll(async () => {
  root = fixtureRoot('mv-r30-compat-', {
    'design/config.ts': `export default { share: { name: 'Compat canvas' }, jam: false }\n`,
    'design/scenes/demo/one.tsx': FRAME('One'),
    'design/scenes/demo/two.tsx': FRAME('Two'),
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
      { key: 'n-one', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 },
      { key: 'n-two', frame: 'demo/two', x: 500, y: 0, w: 390, h: 844 },
    ] }),
  })
  dev = await startDev(root)
  browser = await Browser.launch()
}, 120_000)
afterEach(async () => { for (const s of tabs.splice(0)) await browser?.closeTab(s).catch(() => {}) })
afterAll(async () => {
  browser?.close()
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const read = (name: string): Record<string, any>[] => {
  try { return readFileSync(join(root, 'design', '.local', 'perf', name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
async function until<T>(fn: () => T | undefined | null | false, ms = 20_000, what = 'a condition'): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const v = fn(); if (v) return v; await wait(100) }
  throw new Error(`timed out: ${what}`)
}
const edit = (name: string, title: string) => writeFileSync(join(root, 'design', 'scenes', 'demo', `${name}.tsx`), FRAME(title))

/** The steps every shell makes a window of: a load, a theme switch, the laser on and off, an edit to a frame. */
async function underPreload(perfInfo: string, title: string) {
  const s = await browser!.tab({ width: 1400, height: 900 })
  tabs.push(s)
  await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: PRELOAD(perfInfo) }, s)
  await browser!.go(s, `${dev!.origin}/#/b/main`)
  const ready = `!!window.__mvRecorder && __mvStore.getState().nodes.length === 2 && __mvStore.getState().nodes.every((n) => n.status === 'ready')`
  await browser!.until(s, ready, 60_000)
  const page: string = await browser!.eval(s, 'window.__mvRecorder.page')
  const key = async (k: string) => {
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: `Key${k.toUpperCase()}`, text: k, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) }, s)
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) }, s)
  }
  const flush = () => browser!.eval(s, 'window.__mvRecorder.send(), 1').catch(() => 0)
  await key('d')
  await until(() => { void flush(); return read('page.jsonl').some((r) => r.page === page && r.kind === 'theme') }, 20_000, 'the theme record')
  await key('l')
  await until(() => { void flush(); return read('page.jsonl').some((r) => r.page === page && r.kind === 'mode' && r.mode === 'laser' && r.phase === 'enter') }, 20_000, 'the laser\'s enter')
  await key('l')
  edit('one', title)
  await browser!.until(s, `document.querySelector('[data-node="n-one"] iframe').contentDocument.querySelector('h1')?.textContent === ${JSON.stringify(title)}`, 30_000)
  return { s, page, flush, perf: () => browser!.eval(s, 'window.__fake.log.perf') as Promise<{ kind: string; why?: string }[]> }
}

describe('a 0.30 page in app 1.0.0 (#55)', () => {
  it('no `watch` reaches a preload that does not offer it, nothing 1.0.0 would refuse; the same steps under 1.0.1 do send it', async (ctx) => {
    if (!browser) return ctx.skip()
    const old = await underPreload(APP_100, 'One, under 1.0.0')
    const sent = await old.perf()
    expect(sent.filter((m) => m.kind === 'watch')).toEqual([])
    expect([...new Set(sent.map((m) => m.kind))].filter((k) => !APP_100_PERF.includes(k))).toEqual([])
    const now = await underPreload(APP_101, 'One, under 1.0.1')
    const whys = (await now.perf()).filter((m) => m.kind === 'watch').map((m) => m.why)
    expect(new Set(whys).has('theme'), 'the control: 1.0.1 hears of the same theme switch').toBe(true)
  }, 180_000)

  it('its hello, and its page and reload records whole: the dev server writes them, whatever the app is', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await underPreload(APP_100, 'One, whole')
    const hello = await browser.eval(t.s, 'window.__fake.log.hello')
    expect(hello[0]).toMatchObject({ page: t.page })
    expect(hello[0].version).toMatch(/^\d+\.\d+\.\d+/)

    const page = () => read('page.jsonl').filter((r) => r.page === t.page)
    await until(() => { void t.flush(); return page().some((r) => r.kind === 'settled') && page().some((r) => r.kind === 'cmd' && r.cmd === 'laser' && r.phase === 'end') }, 30_000, 'its records')
    const kinds = new Set(page().map((r) => r.kind))
    for (const k of ['load', 'commit', 'visible', 'frame', 'settled', 'theme', 'mode', 'cmd']) expect(kinds, `page.jsonl: ${k}`).toContain(k)
    expect(page().filter((r) => r.kind === 'cmd').map((r) => r.cmd)).toEqual(expect.arrayContaining(['theme', 'laser']))

    const shell = () => read('reloads.jsonl').filter((r) => r.page === t.page)
    const boot = await until(() => shell().find((r) => r.kind === 'shell-boot'), 20_000, 'its shell-boot')
    expect(boot.page).toBe(t.page)
    await until(() => shell().some((r) => r.kind === 'ready'), 20_000, 'its ready lines')
    // the edit's path, from the watcher to this canvas
    const change = await until(() => read('reloads.jsonl').find((r) => r.kind === 'change' && r.file === 'design/scenes/demo/one.tsx'), 20_000, 'the change line')
    expect(typeof change.at).toBe('number')
    await until(() => read('reloads.jsonl').some((r) => r.kind === 'update' && r.change === change.change), 20_000, 'its update line')
  }, 120_000)

  it('a relay from a menu that does not say which: one `cmd`, `via: relay`, `in: app`', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await underPreload(APP_100, 'One, relayed')
    const of = () => read('page.jsonl').filter((r) => r.page === t.page && r.kind === 'cmd' && r.cmd === 'comments')
    expect(await browser.eval(t.s, `window.__fake.click('comments')`)).toBe(1)
    const rs = await until(() => { void t.flush(); const x = of(); return x.some((r) => r.phase === 'end') ? x : null }, 20_000, 'the relayed command')
    expect(rs.map((r) => r.phase)).toEqual(['start', 'end'])
    expect(rs[0]).toMatchObject({ via: 'relay', in: 'app', keys: 'c' })
    expect(await browser.eval(t.s, `__mvComments.getState().commentMode`)).toBe(true)
  }, 90_000)
})
