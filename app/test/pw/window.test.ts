/**
 * The window (spec 28 A2.2, A2.4, A2.10, A2.13, A2.14 #1, #21, #25, A3.8 #24, #32), under Playwright's driver with
 * the fake trust: every canvas without the one ground below the strip with the cover shown in every turn the journal
 * records while one is active; Home, Settings and the tab pages at the window's full height with the cover hidden
 * over them; lazy views and hidden tabs kept; HTML fullscreen staying in its view; closing the window keeping the
 * views; the app's keys over a page that swallows every key; the one focus rule and F6.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWindow, sleep, SWALLOW_KEYS, hits, type WindowRun } from '../harness/window.ts'
import type { FakeCanvas } from '../harness/fake-canvas.ts'

let w: WindowRun
let betaFake: FakeCanvas
beforeAll(async () => { w = await launchWindow('pw', { extraEnv: { MARVER_APP_SHOW: 'focus' } }) })
afterAll(async () => { await w?.close() })

const BELOW = (width: number, height: number) => ({ x: 0, y: 44, width, height: height - 44 })
const FULL = (width: number, height: number) => ({ x: 0, y: 0, width, height })
/** the app's own pages: Home, Settings, a tab page */
const appPage = (key: string) => key === 'home:view' || key === 'settings:view' || key.endsWith(':page')

async function contentSize() {
  const win = await w.run.call<{ content: { width: number; height: number } }>('window')
  return win.content
}

/** Every canvas below the strip (these offer no inset), every app page full height; the cover over a canvas, never over an app page. */
async function expectPlaced() {
  const { width, height } = await contentSize()
  const views = await w.views()
  for (const v of views.filter((x) => x.key !== 'cover' && x.key !== 'strip')) expect(v.bounds, v.key).toEqual(appPage(v.key) ? FULL(width, height) : BELOW(width, height))
  const shownPage = views.some((v) => v.visible && appPage(v.key))
  expect(views.find((v) => v.key === 'cover')).toMatchObject({ visible: !shownPage, bounds: { x: 0, y: 0, width, height: 44 } })
  expect(views.find((v) => v.key === 'strip')).toMatchObject({ visible: true, bounds: { x: 0, y: 0, width, height: 44 } })
}
const expectAllBelow = expectPlaced

describe('the window (A2.10\'s "the window in app 0.1")', () => {
  let a: string
  let b: string

  it('opens on Home: Home\'s view at the full height under the strip, the cover hidden over it', async () => {
    const s = await w.until((x) => x.active === 'home')
    expect(s.tabs.find((t) => t.id === 'home')!.hasView).toBe(true)
    await expectAllBelow()
  })

  it('a canvas tab gets no view until it is first shown (lazy), then loads and lifts', async () => {
    a = (await w.canvas({ slot: 1, name: 'Alpha' })).id
    const beta = await w.canvas({ slot: 2, name: 'Beta', script: SWALLOW_KEYS })
    b = beta.id
    betaFake = beta.fake
    let s = await w.state()
    expect(s.tabs.find((t) => t.id === a)!.hasView).toBe(false)
    expect(s.tabs.find((t) => t.id === b)!.hasView).toBe(false)
    await w.run.call('activate', { id: a })
    s = await w.until((x) => !!x.tabs.find((t) => t.id === a)?.doc?.lifted, 10_000, 'Alpha lifted')
    expect(s.tabs.find((t) => t.id === b)!.hasView).toBe(false)
    const views = await w.views()
    expect(views.find((v) => v.key === `${a}:view`)!.visible).toBe(true)
    expect(views.find((v) => v.key === 'home:view')!.visible).toBe(false)
    await expectAllBelow()
  })

  it('switching keeps the hidden tab\'s webContents and document', async () => {
    const before = await w.tab(a)
    await w.run.call('activate', { id: b })
    await w.until((x) => !!x.tabs.find((t) => t.id === b)?.doc?.lifted, 10_000, 'Beta lifted')
    await sleep(300)
    const after = await w.tab(a)
    expect(after.wcId).toBe(before.wcId)
    expect(after.doc!.commits).toBe(before.doc!.commits)
    expect(after.doc!.trusted).toBe(true)
  })

  it('every view, shown or hidden, in its place after resizes and a switch; the cover in every journal turn over a canvas', async () => {
    const since = (await w.log()).length
    for (const [width, height] of [[900, 600], [1300, 860], [720, 480]] as const) {
      await w.run.call('resize', { width, height })
      await sleep(120)
      await expectAllBelow()
    }
    await w.run.call('activate', { id: a })
    await sleep(100)
    await expectAllBelow()
    const composes = await w.log('compose', since)
    expect(composes.length).toBeGreaterThan(2)
    for (const c of composes) {
      expect((c.data.cover as { visible: boolean }).visible).toBe(true)   // a canvas is active throughout
      for (const ch of c.data.changes as { key: string; op: string; rect?: { y: number } }[]) if (ch.op === 'bounds') expect(ch.rect!.y, ch.key).toBe(appPage(ch.key) ? 0 : 44)
    }
  })

  it('full screen and back: every view below the strip each time', async () => {
    await w.run.call('fullscreen', { on: true })
    for (let i = 0; i < 50 && !(await w.run.call<{ fullScreen: boolean }>('window')).fullScreen; i++) await sleep(100)
    await sleep(800)
    await expectAllBelow()
    await w.run.call('fullscreen', { on: false })
    for (let i = 0; i < 50 && (await w.run.call<{ fullScreen: boolean }>('window')).fullScreen; i++) await sleep(100)
    await sleep(800)
    await expectAllBelow()
  })

  it('HTML fullscreen stays in its view: the window\'s size and full-screen state never change', async () => {
    await w.run.call('activate', { id: a })
    await sleep(200)
    const win = await w.run.call<{ bounds: unknown; fullScreen: boolean }>('window')
    const view = (await w.views()).find((v) => v.key === `${a}:view`)!
    const since = (await w.log()).length
    await w.run.call('exec', { target: a, js: 'document.documentElement.requestFullscreen().then(() => true)', gesture: true })
    for (let i = 0; i < 30 && !(await w.log('fullscreen', since)).length; i++) await sleep(100)
    expect((await w.log('fullscreen', since)).map((l) => l.data.html)).toEqual([true])
    await sleep(600)
    expect(await w.run.call('exec', { target: a, js: '!!document.fullscreenElement' })).toBe(true)
    const win2 = await w.run.call<{ bounds: unknown; fullScreen: boolean }>('window')
    expect(win2.fullScreen).toBe(false)
    expect(win2.bounds).toEqual(win.bounds)
    expect((await w.views()).find((v) => v.key === `${a}:view`)!.bounds).toEqual(view.bounds)
    // switching away leaves it in its fullscreen; back, it still is
    await w.run.call('activate', { id: b })
    await sleep(150)
    await w.run.call('activate', { id: a })
    await sleep(150)
    expect(await w.run.call('exec', { target: a, js: '!!document.fullscreenElement' })).toBe(true)
    await w.run.call('exec', { target: a, js: 'document.exitFullscreen().then(() => true)' })
    for (let i = 0; i < 30 && (await w.log('fullscreen', since)).length < 2; i++) await sleep(100)
    expect((await w.log('fullscreen', since)).map((l) => l.data.html)).toEqual([true, false])
    expect((await w.run.call<{ bounds: unknown }>('window')).bounds).toEqual(win.bounds)
    await expectAllBelow()
  })

  it('closing the window hides it and keeps every view; showing it again finds the same pages', async () => {
    const before = await w.state()
    await w.run.call('command', { cmd: 'close-window' })
    await sleep(200)
    expect((await w.run.call<{ visible: boolean }>('window')).visible).toBe(false)
    await w.run.call('show', { focus: true })
    await sleep(200)
    const after = await w.state()
    expect((await w.run.call<{ visible: boolean }>('window')).visible).toBe(true)
    for (const t of before.tabs) expect(after.tabs.find((x) => x.id === t.id)!.wcId).toBe(t.wcId)
  })
})

describe('the app\'s keys over a page that swallows every key (A2.4, A2.14 #25)', () => {
  it('⌘1 and ⌘2 switch from inside such a page; a held key switches once; J reaches the page', async () => {
    const s = await w.state()
    const [a, b] = s.canvases
    await w.run.call('activate', { id: b })
    await sleep(150)
    const since = (await w.log()).length
    await w.run.call('key', { target: b, keyCode: '1', modifiers: ['meta'] })
    await w.until((x) => x.active === a, 3000, '⌘1 to switch')
    await w.run.call('key', { target: a, keyCode: '2', modifiers: ['meta'] })
    await w.until((x) => x.active === b, 3000, '⌘2 to switch')
    // held: the repeats are not the app's
    await w.run.call('key', { target: b, keyCode: '1', modifiers: ['meta', 'isAutoRepeat'] })
    await sleep(200)
    expect((await w.state()).active).toBe(b)
    const cmds = (await w.log('command', since)).map((l) => l.data.cmd)
    expect(cmds).toEqual(['tab-1', 'tab-2'])
  })

  it('a key that is not the app\'s reaches the page; the app\'s never do', async () => {
    const s = await w.state()
    const b = s.canvases[1]!
    await w.run.call('activate', { id: b })
    await sleep(150)
    const before = { j: hits(betaFake, '/__mv/test/key-j'), two: hits(betaFake, '/__mv/test/key-2') }
    await w.run.call('key', { target: b, keyCode: 'j' })
    await w.run.call('key', { target: b, keyCode: '2', modifiers: ['meta'] })
    for (let i = 0; i < 20 && hits(betaFake, '/__mv/test/key-j') === before.j; i++) await sleep(100)
    expect(hits(betaFake, '/__mv/test/key-j')).toBe(before.j + 1)
    expect(hits(betaFake, '/__mv/test/key-2')).toBe(before.two)
    expect(hits(betaFake, '/__mv/test/key-1')).toBe(0)
  })
})

/**
 * What holds focus, as Electron reports it - only while the window is the key window. macOS gives a window focus
 * only while its app is in front, and the person at the Mac may be using another app: then nothing here can see
 * focus, and the case is inconclusive (skipped, and says so). Main's own record of the rule's decisions is no
 * stand-in: the rule writes it itself.
 */
async function focused(): Promise<string[] | null> {
  const f = await w.run.call<{ focused: string[] }>('focused')
  const key = (await w.run.call<{ focused: boolean }>('window')).focused
  return key ? f.focused : null
}
const INCONCLUSIVE = 'INCONCLUSIVE: the window was not the key window (another app in front), so focus could not be read'
/** focus as Electron reports it is `want`; the case skipped, saying so, the moment the window is not key */
async function expectFocus(ctx: { skip: () => void }, want: string[], what: string): Promise<void> {
  const f = await focused()
  if (!f) { process.stdout.write(`${what}: ${INCONCLUSIVE}\n`); ctx.skip(); return }
  expect(f, what).toEqual(want)
}

describe('one focus rule, and F6 (A2.13)', () => {
  beforeAll(async () => { await w.run.call('focusApp') })

  it('activating a tab focuses its view; F6 moves to the strip and back; ⇧F6 is the same toggle', async (ctx) => {
    const s = await w.state()
    const a = s.canvases[0]!
    await w.run.call('focusApp')
    await w.run.call('activate', { id: a })
    await sleep(200)
    await expectFocus(ctx, [`${a}:view`], 'activating focuses the view')
    await w.run.call('key', { target: a, keyCode: 'F6' })
    await sleep(150)
    await expectFocus(ctx, ['strip'], 'F6 to the strip')
    await w.run.call('key', { target: 'strip', keyCode: 'F6', modifiers: ['shift'] })
    await sleep(150)
    await expectFocus(ctx, [`${a}:view`], '⇧F6 back to the view')
  })

  it('a crash of the focused view moves focus to its tab page, then to the canvas when it lifts', async (ctx) => {
    // a canvas whose document answers slowly once asked to, so the tab page stays a while
    let slow = false
    const c = await w.canvas({ slot: 3, name: 'Gamma', onRequest: (req, res) => {
      if (!slow || !(req.url === '/' || req.url?.startsWith('/#') || req.url?.startsWith('/?'))) return false
      slow = false
      setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end('<!doctype html><title>Gamma</title><p>Gamma') }, 1500)
      return true
    } })
    const g = c.id
    await w.run.call('focusApp')
    await w.run.call('activate', { id: g })
    await w.until((x) => !!x.tabs.find((t) => t.id === g)?.doc?.lifted, 10_000, 'Gamma lifted')
    await sleep(200)
    await expectFocus(ctx, [`${g}:view`], 'the canvas focused')
    const since = (await w.log()).length
    slow = true
    await w.run.call('crash', { target: g })
    await w.until((x) => x.tabs.find((t) => t.id === g)!.pageView, 5000, 'the tab page')
    await sleep(300)
    await expectFocus(ctx, [`${g}:page`], 'focus on the tab page after the crash')
    await w.until((x) => !!x.tabs.find((t) => t.id === g)?.doc?.lifted && !x.tabs.find((t) => t.id === g)!.pageView, 10_000, 'the reload to lift')
    await sleep(200)
    await expectFocus(ctx, [`${g}:view`], 'focus on the canvas at the lift')
    const moves = (await w.log('focus', since)).map((l) => l.data.to).filter(Boolean)
    expect(moves[0]).toEqual({ part: 'page', tab: g })
    expect(moves.at(-1)).toEqual({ part: 'content', tab: g })
    expect(moves.slice(0, -1).every((m) => (m as { part: string }).part === 'page')).toBe(true)
  })
})
