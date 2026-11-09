import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Browser } from './browser.ts'
import { CLI, fixtureRoot, startDev, type Dev } from './dev-server.ts'
import { appendEvents } from '../src/server/comments.ts'

/**
 * `marver show` (spec 31 D3) and the deep link's navigation command (D1), against a REAL `marver dev` (port 5641, this
 * stream's) and a REAL headless Chrome: `POST /__mv/api/show` broadcasts `sh:show`; each open tab switches board,
 * selects (node keys stay node keys: one copy, never every copy), opens the thread and refits even when it is already
 * there; a tab holding unsent words does not move and shows "Your agent wants to show you <title> · Go"; a newer show
 * supersedes an older one; each tab answers, and the CLI says "shown in N tabs" or "no open tab" and prints the link.
 * In the app (a fake `window.marverApp`), a server show asks `front()`, a bridge show (`onShow`) moves the same way and
 * does not. And `GET /__mv/api/update` always answers. Skips without Chrome.
 */

const run = promisify(execFile)
const PORT = 5641
const FRAME = (t: string, bg: string) => `export const meta = { title: '${t}', viewport: 'mobile' }\nexport default () => <main style={{ minHeight: '100vh', background: '${bg}', padding: 24 }}><h1>${t}</h1></main>\n`
let root = ''
let dev: Dev | null = null
let browser: Browser | null = null
const tabs: string[] = []

beforeAll(async () => {
  root = fixtureRoot('mv-show-', {
    'design/config.ts': 'export default { jam: false }\n',
    'design/scenes/demo/one.tsx': FRAME('One', '#0b5'),
    'design/scenes/demo/two.tsx': FRAME('Two', '#05b'),
    'design/scenes/demo/three.tsx': FRAME('Three', '#b50'),
    // far apart, so a camera fitted to one cannot also show another; demo/one twice (two copies)
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
      { key: 'n-one', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 },
      { key: 'n-two', frame: 'demo/two', x: 3000, y: 0, w: 390, h: 844 },
      { key: 'n-one-b', frame: 'demo/one', x: 6000, y: 0, w: 390, h: 844 },
    ] }),
    'design/boards/other.json': JSON.stringify({ version: 1, name: 'other', order: 1, auto: false, nodes: [{ key: 'n-three', frame: 'demo/three', x: 0, y: 0, w: 390, h: 844 }] }),
  })
  dev = await startDev(root, { args: ['--port', String(PORT)] })
  browser = await Browser.launch()
}, 120_000)
afterEach(async () => { for (const s of tabs.splice(0)) await browser?.closeTab(s).catch(() => {}) })
afterAll(async () => {
  browser?.close()
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const token = () => JSON.parse(readFileSync(join(root, 'design', '.local', 'dev.json'), 'utf8')).token as string
const show = async (body: object): Promise<number> => {
  const r = await fetch(`${dev!.origin}/__mv/api/show`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-work': token() }, body: JSON.stringify(body) })
  expect(r.status).toBe(200)
  return ((await r.json()) as { seq: number }).seq
}
const acks = async (seq: number) => (await fetch(`${dev!.origin}/__mv/api/show/acks?seq=${seq}`, { headers: { 'x-mv-work': token() } })).json()

/** One board's GET held until released: a show's board switch caught on its way. */
const GATE = `(() => {
  const realFetch = window.fetch.bind(window)
  window.__gate = { name: null, asked: false, release: null }
  window.__hold = (name) => { const g = window.__gate; g.name = name; g.asked = false; g.held = new Promise((r) => { g.release = () => { g.name = null; r(); return 1 } }); return 1 }
  window.fetch = async (input, init) => {
    const g = window.__gate, url = String(input && input.url ? input.url : input)
    if (g.name && url.split('?')[0].endsWith('/__mv/api/boards/' + g.name) && (!init || !init.method || init.method === 'GET')) { g.asked = true; await g.held }
    return realFetch(input, init)
  }
})()`

/** A fake bridge before any script: `front()` and `onShow` recorded. */
const FAKE_APP = `(() => {
  const shows = new Set()
  window.__app = { fronts: 0, show: (t) => { for (const fn of shows) fn(t); return shows.size } }
  window.marverApp = Object.freeze({ v: 1, topInset: 0, hello() {}, theme() {}, busy() {}, menu() {},
    onAppState: () => () => {}, onMenuClick: () => () => {},
    onShow: (fn) => { shows.add(fn); return () => shows.delete(fn) },
    front: () => { window.__app.fronts++ } })
})()`

async function open(hash = '#/b/main', o: { app?: boolean } = {}) {
  const s = await browser!.tab({ width: 1400, height: 900 })
  tabs.push(s)
  await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: GATE }, s)
  if (o.app) await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_APP }, s)
  await browser!.go(s, `${dev!.origin}/${hash}`)
  await browser!.until(s, `!!window.__mvStore && __mvStore.getState().nodes.length > 0 && __mvStore.getState().nodes.every((n) => n.status === 'ready') && !!window.__mvShow`, 30_000)
  await browser!.send('Page.bringToFront', {}, s)
  return {
    s,
    ev: (js: string) => browser!.eval(s, js),
    until: (js: string, ms = 15_000) => browser!.until(s, js, ms),
  }
}
/** The board, the selection, and which nodes are inside the window. */
const VIEW = `(() => {
  const inside = (el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }
  const nodes = [...document.querySelectorAll('.sh-node[data-node]')]
  return { board: __mvStore.getState().board, sel: [...__mvStore.getState().selection].sort(), visible: nodes.filter(inside).map((n) => n.dataset.node).sort() }
})()`
const settled = (board: string, sel: string[], visible = sel) => `(() => { const v = ${VIEW}; return v.board === '${board}' && v.sel.join() === '${[...sel].sort().join()}' && v.visible.join() === '${[...visible].sort().join()}' && v })()`
/** Words typed and not sent: a field the person typed in (api.ts typedUnsent's own check). */
const TYPE = `(() => { const ta = document.createElement('textarea'); ta.id = 'draft'; document.body.append(ta); ta.focus(); ta.value = 'half a thought'; ta.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`

describe('sh:show in the tab (D3)', () => {
  it('switches board, selects, fits - and answers shown; the server counts it', async () => {
    if (!browser) return
    const t = await open('#/b/main')
    const seq = await show({ board: 'other', f: ['demo/three'] })
    await t.until(settled('other', ['n-three']))
    await t.until(`location.hash === '#/b/other?n=n-three'`)
    await expect.poll(() => acks(seq), { timeout: 5000 }).toEqual({ shown: 1, notice: 0 })
  }, 60_000)

  it('node keys stay node keys: one copy of a frame, never every copy; a frame id selects both', async () => {
    if (!browser) return
    const t = await open('#/b/main')
    await show({ board: 'main', n: ['n-one-b'] })
    await t.until(settled('main', ['n-one-b']))
    await show({ board: 'main', f: ['demo/one'] })
    await t.until(`(() => { const v = ${VIEW}; return v.sel.join() === 'n-one,n-one-b' })()`)
  }, 60_000)

  it('refits on a repeat: already there, the camera panned away by hand, the same show brings it back', async () => {
    if (!browser) return
    const t = await open('#/b/main')
    await show({ board: 'main', n: ['n-two'] })
    await t.until(settled('main', ['n-two']))
    // the person pans away: n-two leaves the window; the selection and the URL stay as they were
    for (let i = 0; i < 6; i++) await browser.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 450, deltaX: 900, deltaY: 0 }, t.s)
    await t.until(`(() => { const v = ${VIEW}; return v.sel.join() === 'n-two' && !v.visible.includes('n-two') })()`)
    const hash = await t.ev('location.hash')
    await show({ board: 'main', n: ['n-two'] })
    await t.until(settled('main', ['n-two']))
    expect(await t.ev('location.hash')).toBe(hash)   // the same place: no hash change would have moved it
  }, 60_000)

  it('a newer show supersedes an older one still on its way; a seq already taken is never taken again', async () => {
    if (!browser) return
    const t = await open('#/b/main')
    // two at once: the board switch of the first is still reading when the second lands
    await Promise.all([show({ board: 'other', f: ['demo/three'] }), show({ board: 'main', n: ['n-two'] })])
    await t.until(settled('main', ['n-two']))
    await new Promise((r) => setTimeout(r, 800))
    expect(await t.ev(VIEW)).toMatchObject({ board: 'main', sel: ['n-two'] })
    // a replayed seq (a reconnect): stale, nothing moves
    const { lastSeq } = await t.ev('__mvShow.state()')
    expect(await t.ev(`__mvShow.showTarget({ seq: ${lastSeq}, board: 'other', f: ['demo/three'] }, 'server')`)).toBe('stale')
    expect(await t.ev(`__mvShow.showTarget({ seq: ${lastSeq + 100}, board: 'main', f: ['../x'] }, 'server')`)).toBe('bad')
    expect(await t.ev(VIEW)).toMatchObject({ board: 'main', sel: ['n-two'] })
  }, 60_000)

  it('with unsent words the tab does not move: the notice says so, answers notice, and Go moves it', async () => {
    if (!browser) return
    const t = await open('#/b/main')
    await t.ev(TYPE)
    const seq = await show({ board: 'other', f: ['demo/three'] })
    await t.until(`document.querySelector('.sh-show-notice')?.textContent.includes('Your agent wants to show you Three')`)
    expect(await t.ev(`({ board: __mvStore.getState().board, words: document.getElementById('draft').value })`)).toEqual({ board: 'main', words: 'half a thought' })
    await expect.poll(() => acks(seq), { timeout: 5000 }).toEqual({ shown: 0, notice: 1 })
    await t.ev(`[...document.querySelectorAll('.sh-show-notice button')].find((b) => b.textContent === 'Go').click()`)
    await t.until(settled('other', ['n-three']))
    expect(await t.ev(`!!document.querySelector('.sh-show-notice')`)).toBe(false)
  }, 60_000)

  it('words typed while the board is on its way: the switch never commits - the notice instead, the draft kept', async () => {
    if (!browser) return
    const t = await open('#/b/main')
    await t.ev(`__hold('other')`)
    const seq = await show({ board: 'other', f: ['demo/three'] })
    await t.until(`__gate.asked`)
    await t.ev(TYPE)
    await t.ev(`__gate.release()`)
    await t.until(`document.querySelector('.sh-show-notice')?.textContent.includes('Three')`)
    await new Promise((r) => setTimeout(r, 500))
    expect(await t.ev(`({ board: __mvStore.getState().board, words: document.getElementById('draft').value })`)).toEqual({ board: 'main', words: 'half a thought' })
    await expect.poll(() => acks(seq), { timeout: 5000 }).toEqual({ shown: 0, notice: 1 })
  }, 60_000)

  it('in Play, with a draft: Play and the draft stay, and the notice shows over Play', async () => {
    if (!browser) return
    const t = await open('#/b/main')
    await browser.press(t.s, 'p')
    await t.until(`!!document.querySelector('.sh-play') && !!__mvStore.getState().play`)
    await t.ev(TYPE)
    await show({ board: 'other' })
    await t.until(`!!document.querySelector('.sh-show-notice')`)
    const r = await t.ev(`(() => { const n = document.querySelector('.sh-show-notice').getBoundingClientRect(); const top = document.elementFromPoint(n.left + n.width / 2, n.top + n.height / 2); return { play: !!__mvStore.getState().play, onTop: !!top?.closest('.sh-show-notice') } })()`)
    expect(r).toEqual({ play: true, onTop: true })
  }, 60_000)

  it('a scene (s) selects every frame of it; a thread (c) opens that thread', async () => {
    if (!browser) return
    appendEvents(join(root, 'design', 'comments'), 'main', [{ id: 'e-show-1', ts: Date.now() - 1000, type: 'create', commentId: 't-show', board: 'main', frame: 'demo/two', nodeKey: 'n-two', author: { name: 'Nic' }, body: 'this one' }])
    const t = await open('#/b/other')
    await show({ board: 'main', s: ['demo'] })
    await t.until(`(() => { const v = ${VIEW}; return v.board === 'main' && v.sel.join() === 'n-one,n-one-b,n-two' })()`)
    await show({ board: 'main', c: 't-show' })
    await t.until(`window.__mvComments?.getState().active === 't-show'`)
  }, 60_000)

  it('a show a newer one overtook is never counted shown: only the newest answers', async () => {
    if (!browser) return
    const t = await open('#/b/main')
    await t.ev(`__hold('other')`)
    const first = await show({ board: 'other', f: ['demo/three'] })
    await t.until(`__gate.asked`)
    const second = await show({ board: 'main', n: ['n-two'] })
    await t.until(settled('main', ['n-two']))
    await t.ev(`__gate.release()`)
    await expect.poll(() => acks(second), { timeout: 5000 }).toEqual({ shown: 1, notice: 0 })
    await new Promise((r) => setTimeout(r, 800))
    expect(await acks(first)).toEqual({ shown: 0, notice: 0 })
    expect(await t.ev(VIEW)).toMatchObject({ board: 'main', sel: ['n-two'] })
  }, 60_000)

  it('the notice\'s × leaves the tab where it is', async () => {
    if (!browser) return
    const t = await open('#/b/main')
    await t.ev(TYPE)
    await show({ board: 'other' })
    await t.until(`document.querySelector('.sh-show-notice')?.textContent.includes('Other')`)
    await t.ev(`document.querySelector('.sh-show-notice .x').click()`)
    await t.until(`!document.querySelector('.sh-show-notice')`)
    expect(await t.ev(`__mvStore.getState().board`)).toBe('main')
  }, 60_000)

  it('a target off the grammar, or a board that does not exist, is refused by the server: nothing is broadcast', async () => {
    if (!browser) return
    const post = (body: unknown, headers: Record<string, string> = { 'x-mv-work': token() }) => fetch(`${dev!.origin}/__mv/api/show`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then((r) => r.status)
    expect(await post({ board: 'main', f: ['../../etc/passwd'] })).toBe(400)
    expect(await post({ board: '#/b/main' })).toBe(400)
    expect(await post({ board: 'nowhere' })).toBe(404)
    expect(await post({ board: 'main' }, {})).toBe(403)
  }, 30_000)
})

describe('marver show (the CLI)', () => {
  const cli = async (...args: string[]) => (await run(process.execPath, [CLI, 'show', ...args, '--root', root], { cwd: root, timeout: 30_000, env: { ...process.env, MARVER_NO_UPDATE_CHECK: '1' } })).stdout.trim().split('\n')

  it('two open tabs: "shown in 2 tabs" and the link; none: "no open tab" and the link', async () => {
    if (!browser) return
    const a = await open('#/b/main'), b = await open('#/b/other')
    const out = await cli('demo/two')
    expect(out).toEqual(['shown in 2 tabs', `http://localhost:${PORT}/#/b/main?f=demo/two`])
    await a.until(settled('main', ['n-two']))
    await b.until(settled('main', ['n-two']))
    for (const s of tabs.splice(0)) await browser.closeTab(s)
    expect(await cli('other')).toEqual(['no open tab', `http://localhost:${PORT}/#/b/other`])
  }, 60_000)
})

describe('in the app (a fake window.marverApp)', () => {
  it('a server show asks front() once it is shown; the app\'s own onShow moves the tab the same way, without front()', async () => {
    if (!browser) return
    const t = await open('#/b/main', { app: true })
    await show({ board: 'other', f: ['demo/three'] })
    await t.until(settled('other', ['n-three']))
    expect(await t.ev('__app.fronts')).toBe(1)
    expect(await t.ev(`__app.show({ board: 'main', n: ['n-two'] })`)).toBe(1)
    await t.until(settled('main', ['n-two']))
    expect(await t.ev('__app.fronts')).toBe(1)
    // a link whose place the app could not take (null): the canvas's own board - the landing one, here main
    await t.ev(`__app.show({ board: 'other' })`)
    await t.until(settled('other', []))
    await t.ev(`__app.show(null)`)
    await t.until(`__mvStore.getState().board === 'main'`)
    // with words unsent the bridge's show is a notice too: a deep link never loses a draft
    await t.ev(TYPE)
    await t.ev(`__app.show({ board: 'other' })`)
    await t.until(`!!document.querySelector('.sh-show-notice')`)
    expect(await t.ev(`__mvStore.getState().board`)).toBe('main')
  }, 60_000)
})

describe('GET /__mv/api/update (E4)', () => {
  it('always answers { current, latest, checkedAt, state } - here disabled, as the suite runs', async () => {
    const u = await (await fetch(`${dev!.origin}/__mv/api/update`)).json()
    expect(u).toEqual({ current: expect.stringMatching(/^\d+\.\d+\.\d+$/), latest: null, checkedAt: null, state: 'disabled' })
  })
})
