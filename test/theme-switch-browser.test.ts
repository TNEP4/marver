import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'

/**
 * A theme switch on a small board, in a REAL Chrome on a REAL `marver dev`: every frame ends in the new theme with its
 * ack taken (`themeOn`, one store update an animation frame for the burst) and asleep again; two quick toggles end in
 * the last; a frame's document reloaded mid-switch, and a board left and come back to mid-switch, end right - an ack of
 * a document since replaced never lands on the one there now. Skips without Chrome.
 */

const PLAIN = `export const meta = { title: 'Plain' }
export default () => <main style={{ margin: 0, padding: 24, font: '16px system-ui', minHeight: '100vh' }}><style>{'[data-theme="dark"] main { background: #111; color: #eee }'}</style><h1 style={{ margin: 0 }}>Plain</h1></main>
`
const KEYS = Array.from({ length: 6 }, (_, i) => `k${i}`)

let root = ''
let dev: Dev | null = null
let browser: Browser | null = null
let s = ''

beforeAll(async () => {
  root = fixtureRoot('mv-theme-switch-', {
    'design/scenes/app/plain.tsx': PLAIN,
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: KEYS.map((key, i) => ({ key, frame: 'app/plain', x: (i % 3) * 500, y: Math.floor(i / 3) * 400, w: 400, h: 300 })) }),
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
/** Every frame of the board in `theme`: its document shows it, its ack taken, ready and asleep again. */
const ENDED = (theme: string) => `${ST}.board === 'main' && ${ST}.nodes.length === ${KEYS.length} && ${KEYS.map((k) => `${DOC(k)}?.documentElement.dataset.theme === '${theme}' && !!${DOC(k)}?.getElementById('mv-sleep') && ${ST}.nodes.find((n) => n.key === '${k}').themeOn === '${theme}' && ${ST}.nodes.find((n) => n.key === '${k}').status === 'ready'`).join(' && ')}`
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
})
