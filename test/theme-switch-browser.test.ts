import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'

/**
 * A theme switch on a small board, in a REAL Chrome on a REAL `marver dev`: every frame ends in the new theme with its
 * ack taken (`themeOn`, one store update an animation frame for the burst) and asleep again; two quick toggles end in
 * the last; a frame's document reloaded mid-switch, and a board left and come back to mid-switch, end right - an ack of
 * a document since replaced never lands on the one there now: k2's frame replaced (a same-board reload) between its ack
 * and the flush. The board holds an HTML frame and one whose meta.theme fixes it. Skips without Chrome.
 */

const PLAIN = `export const meta = { title: 'Plain' }
export default () => <main style={{ margin: 0, padding: 24, font: '16px system-ui', minHeight: '100vh' }}><style>{'[data-theme="dark"] main { background: #111; color: #eee }'}</style><h1 style={{ margin: 0 }}>Plain</h1></main>
`
const FIXED = `export const meta = { title: 'Fixed', theme: 'dark' }
export default () => <main style={{ margin: 0, padding: 24, minHeight: '100vh' }}><h1>Fixed dark</h1></main>
`
const LIGHT = `export const meta = { title: 'Light', theme: 'light' }
export default () => <main style={{ margin: 0, padding: 24, minHeight: '100vh' }}><h1>Fixed light</h1></main>
`
const HTML = '<!doctype html><html><head><style>[data-theme="dark"] body { background: #111; color: #eee }</style></head><body><h1>page</h1></body></html>\n'
const KEYS = Array.from({ length: 6 }, (_, i) => `k${i}`)
/** k4 shows a frame whose meta.theme is dark (it never follows the view), k5 an HTML frame. */
const FRAME = (i: number) => (i === 4 ? 'app/fixed' : i === 5 ? 'app/page' : 'app/plain')

let root = ''
let dev: Dev | null = null
let browser: Browser | null = null
let s = ''

beforeAll(async () => {
  root = fixtureRoot('mv-theme-switch-', {
    'design/scenes/app/plain.tsx': PLAIN,
    'design/scenes/app/fixed.tsx': FIXED,
    'design/scenes/app/light.tsx': LIGHT,
    'design/scenes/app/page.html': HTML,
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: KEYS.map((key, i) => ({ key, frame: FRAME(i), x: (i % 3) * 500, y: Math.floor(i / 3) * 400, w: 400, h: 300 })) }),
    'design/boards/other.json': JSON.stringify({ version: 1, name: 'other', order: 1, auto: false, nodes: [{ key: 'o1', frame: 'app/plain', x: 0, y: 0, w: 400, h: 300 }] }),
  })
  dev = await startDev(root)
  browser = await Browser.launch()
  if (!browser) return
  s = await browser.tab({ width: 1400, height: 900 })
  await browser.send('Page.bringToFront', {}, s)
  await browser.go(s, `${dev.origin}/#/b/main`)
}, 120_000)
afterAll(async () => {
  browser?.close()
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

const ev = (js: string) => browser!.eval(s, js)
const until = (js: string, ms = 30_000) => browser!.until(s, js, ms)
const skippable = (name: string, fn: () => Promise<void>, ms = 120_000) => it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)
const ST = `__mvStore.getState()`
const DOC = (k: string) => `document.querySelector('.sh-node[data-node="${k}"] iframe')?.contentDocument`
/** Every frame of the board in its theme - `theme`, k4 its own dark - its document shows it, its ack taken, ready and
 *  asleep again. `k2` overrides k2's (its frame replaced). */
const ENDED = (theme: string, k2 = theme) => `${ST}.board === 'main' && ${ST}.nodes.length === ${KEYS.length} && ${KEYS.map((k, i) => { const t = i === 4 ? 'dark' : k === 'k2' ? k2 : theme; return `${DOC(k)}?.documentElement.dataset.theme === '${t}' && !!${DOC(k)}?.getElementById('mv-sleep') && ${ST}.nodes.find((n) => n.key === '${k}').themeOn === '${t}' && ${ST}.nodes.find((n) => n.key === '${k}').status === 'ready'` }).join(' && ')}`
async function inLight(): Promise<void> {
  await until(`!!window.__mvStore && ${ST}.board === 'main' && ${ST}.nodes.length === ${KEYS.length} && ${ST}.nodes.every((n) => n.status === 'ready')`)
  if (await ev(`${ST}.viewTheme !== 'light'`)) await ev(`${ST}.setTheme('light')`)
  await until(ENDED('light'), 60_000)
}

describe('a theme switch on a small board', () => {
  skippable('every frame ends in the new theme, its ack taken, asleep again - and back', async () => {
    await inLight()
    await ev(`${ST}.setTheme('dark')`)
    await until(ENDED('dark'), 60_000)
    await ev(`${ST}.setTheme('light')`)
    await until(ENDED('light'), 60_000)
  })
  skippable('two quick toggles end in the last: at once, and a frame apart', async () => {
    await inLight()
    await ev(`(() => { ${ST}.setTheme('dark'); ${ST}.setTheme('light'); return 1 })()`)
    await until(ENDED('light'), 60_000)
    await ev(`new Promise((r) => { ${ST}.setTheme('dark'); requestAnimationFrame(() => { ${ST}.setTheme('light'); r(1) }) })`)
    await until(ENDED('light'), 60_000)
    await new Promise((r) => setTimeout(r, 500))
    expect(await ev(ENDED('light'))).toBe(true)   // and stays so: no late ack of the dark one lands
  })
  skippable('a frame\'s document reloaded mid-switch ends in the new theme with its own ack', async () => {
    await inLight()
    // the switch, and k2's document replaced before any ack is flushed (the reload's URL carries the new theme)
    await ev(`(() => { ${ST}.setTheme('dark'); ${ST}.reloadFrame('k2'); const f = document.querySelector('.sh-node[data-node="k2"] iframe'); f.src = f.src; return 1 })()`)
    await until(ENDED('dark'), 60_000)
  })
  skippable('a board left and come back to mid-switch ends in the new theme', async () => {
    await inLight()
    await ev(`${ST}.setTheme('dark')`)
    await new Promise((r) => setTimeout(r, 0))
    await ev(`location.hash = '#/b/other'; 1`)
    await until(`${ST}.board === 'other' && ${ST}.nodes.length === 1 && ${ST}.nodes[0].status === 'ready'`)
    await ev(`location.hash = '#/b/main'; 1`)
    await until(ENDED('dark'), 60_000)
  })
  // last: it leaves k2 on another frame
  skippable('a frame whose frame is replaced (a same-board reload) between its ack and the flush never takes that ack: it ends in its own theme with its own', async () => {
    await inLight()
    // the switch to dark; the moment k2's dark ack is queued, the board's k2 shows another frame - one fixed to light -
    // through keepDocuments, before the batch lands. The replacement's document is held at the network for 600 ms, so
    // the iframe still holds the old one (and its boot) when the batch lands. Watched: does dark ever land on it?
    await browser!.send('Fetch.enable', { patterns: [{ urlPattern: '*id=app%2Flight*', requestStage: 'Request' }] }, s)
    const off = browser!.on((m) => { if (m.method === 'Fetch.requestPaused' && m.sessionId === s) setTimeout(() => { void browser!.send('Fetch.continueRequest', { requestId: m.params.requestId }, s).catch(() => {}) }, 600) })
    // the board file as the server has it, with k2 on the light frame: what a same-board reload reads. boot() - the
    // real reload, keepDocuments applied - is answered from memory so it commits inside the batch's window
    await ev(`(async () => {
      const get = (u) => fetch(u, { headers: { 'x-mv-c': document.cookie.match(/(?:^|; )mv_c=([^;]+)/)?.[1] ?? '' } }).then((r) => r.json())
      const board = await get('/__mv/api/boards/main'), manifest = await get('/design/manifest.json'), sizes = await get('/__mv/api/sizes')
      board.board.nodes = board.board.nodes.map((n) => (n.key === 'k2' ? { ...n, frame: 'app/light' } : n)); board.sha256 = 'replaced'
      const answer = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      const st = __mvStore, orig = st.getState().setThemeOn
      let done = false
      window.__stale = false
      st.subscribe((s) => { const n = s.nodes.find((x) => x.key === 'k2'); if (n && n.frame === 'app/light' && n.themeOn === 'dark') window.__stale = true })
      st.setState({ setThemeOn: (k, t, live) => {
        orig(k, t, live)
        if (k !== 'k2' || t !== 'dark' || done) return
        done = true
        const real = window.fetch
        window.fetch = (u, o) => { const s = String(u); if (s.includes('/api/boards/main')) return Promise.resolve(answer(board)); if (s.includes('manifest.json')) return Promise.resolve(answer(manifest)); if (s.includes('/api/sizes')) return Promise.resolve(answer(sizes)); return real(u, o) }
        void st.getState().boot().finally(() => { window.fetch = real })
      } })
      st.getState().setTheme('dark')
      return 1
    })()`)
    try { await until(ENDED('dark', 'light'), 60_000) } finally { off(); await browser!.send('Fetch.disable', {}, s).catch(() => {}) }
    expect(await ev(`window.__stale`)).toBe(false)
    expect(await ev(`${ST}.nodes.find((n) => n.key === 'k2').frame`)).toBe('app/light')
  })
})
