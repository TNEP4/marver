import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'

/**
 * The heap gate in a REAL canvas (admission.ts; the suite there tests the helpers, this the wiring around them):
 * performance.memory faked in the page past the line (exact: it moves at every read), six frames by the boot view, two
 * parked far off. A parked frame stays unbooted over a look; selecting it boots it at once - FrameNode's selection
 * override and Canvas's selection subscription, not the 3 s look; the camera brought to the other boots that one.
 */
const FRAME = (t: string) => `export const meta = { title: '${t}', viewport: 'mobile' }\nexport default () => <main style={{ padding: 24 }}><h2>${t}</h2></main>\n`
const NEAR = [1, 2, 3, 4, 5, 6]
let root = '', dev: Dev | null = null, browser: Browser | null = null

beforeAll(async () => {
  const files: Record<string, string> = { 'design/scenes/demo/far.tsx': FRAME('Far'), 'design/scenes/demo/other.tsx': FRAME('Other') }
  for (const i of NEAR) files[`design/scenes/demo/n${i}.tsx`] = FRAME(`N${i}`)
  files['design/boards/main.json'] = JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
    // two rows of three: at the boot fit each is over 256 px tall, readable on its own (not only because the link selects it)
    ...NEAR.map((i) => ({ key: `n-${i}`, frame: `demo/n${i}`, x: ((i - 1) % 3) * 450, y: Math.floor((i - 1) / 3) * 700, w: 390, h: 600 })),
    { key: 'n-far', frame: 'demo/far', x: 20_000, y: 0, w: 390, h: 600 },
    { key: 'n-other', frame: 'demo/other', x: -20_000, y: 0, w: 390, h: 600 },
  ] })
  root = fixtureRoot('mv-heapgate-', files)
  dev = await startDev(root)
  browser = await Browser.launch()
}, 120_000)
afterAll(async () => { browser?.close(); await dev?.stop(); if (root) rmSync(root, { recursive: true, force: true }) })

describe('the heap gate past its line', () => {
  it('a parked frame waits over a look; selected, it boots at once; the camera brought to another boots that one', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await browser.tab({ width: 1400, height: 900 })
    // 90% of a 4 GB limit, moving at every read (an exact counter); reads counted, so the test knows when a look ran
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (window.top === window) { window.__reads = 0
      Object.defineProperty(performance, 'memory', { configurable: true, get: () => ({ usedJSHeapSize: 0.9 * 4294967296 + (++window.__reads) * 4096, jsHeapSizeLimit: 4294967296, totalJSHeapSize: 0 }) }) }` }, s)
    const ev = (js: string) => browser!.eval(s, js)
    const booted = (k: string) => `!!document.querySelector('[data-node="${k}"] iframe')?.getAttribute('src')`
    await browser.go(s, `${dev!.origin}/#/b/main?n=${NEAR.map((i) => `n-${i}`).join(',')}`)
    await browser.until(s, `!!window.__mvStore && ${NEAR.map((i) => `__mvStore.getState().nodes.find((n) => n.key === 'n-${i}')?.status === 'ready'`).join(' && ')}`, 30_000)
    await ev(`__mvStore.getState().select('n-1'), 1`)   // the link's selection let go of: the near frames booted on their own
    // (1) parked: over a whole look (3 s) the far frames get no document
    const reads0 = await ev('window.__reads')
    await new Promise((r) => setTimeout(r, 3500))
    expect(await ev('window.__reads'), 'a look ran').toBeGreaterThan(reads0)
    expect(await ev(booted('n-far'))).toBe(false)
    expect(await ev(booted('n-other'))).toBe(false)
    // (2) just after a look (the next is 3 s away), selecting it boots it at once
    const r1 = await ev('window.__reads')
    await browser.until(s, `window.__reads > ${r1}`, 5000)
    await ev(`__mvStore.getState().select('n-far'), 1`)
    const t0 = Date.now()
    await browser.until(s, booted('n-far'), 2500)
    expect(Date.now() - t0, 'started by the selection, not the next look').toBeLessThan(1000)
    // (3) the camera brought to the other parked frame boots it
    await ev(`__mvJamCanvas.fitNode('n-other'), 1`)
    await browser.until(s, `__mvStore.getState().nodes.find((n) => n.key === 'n-other')?.status === 'ready'`, 10_000)
    await browser.closeTab(s)
  }, 120_000)
})
