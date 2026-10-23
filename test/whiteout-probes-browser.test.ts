import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'

/**
 * The white-out detector's probes, the shell's half (spec 28 A3.3, A3.7, A3.8 #16), in a REAL Chrome on a REAL
 * `marver dev`: `pick` takes grid points of empty canvas background - at least 48 px from every frame's screen rect,
 * the canvas surface under them - and `verify` keeps only those the camera moved by less than their clearance. Run
 * on the shell's own module instance (the page imports whiteout-probes.ts by its dev URL, so canvasCtl is the
 * canvas's). Checked at rest, over a board with a frame that is white on purpose, and while the camera pans fast:
 * no accepted probe ever lies inside a frame at either side of its bracket. In Chrome there is no inset: the whole
 * canvas is usable. Skips without Chrome.
 */

const FRAME = (t: string, bg: string) => `export const meta = { title: '${t}', viewport: 'mobile' }\nexport default () => <main style={{ padding: 24, background: '${bg}', minHeight: '100vh' }}><h1 style={{ margin: 0, color: '${bg}' }}>${t}</h1></main>\n`
const PROBES = join(import.meta.dirname, '..', 'src', 'client', 'shell', 'whiteout-probes.ts')

let root = ''
let dev: Dev | null = null
let browser: Browser | null = null
let s = ''

beforeAll(async () => {
  root = fixtureRoot('mv-probes-', {
    'design/scenes/demo/white.tsx': FRAME('White', '#ffffff'),
    'design/scenes/demo/grey.tsx': FRAME('Grey', '#d0d4dc'),
    'design/scenes/demo/blue.tsx': FRAME('Blue', '#3050a0'),
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
      { key: 'n-white', frame: 'demo/white', x: 0, y: 0, w: 390, h: 844 },
      { key: 'n-grey', frame: 'demo/grey', x: 900, y: 200, w: 390, h: 844 },
      { key: 'n-blue', frame: 'demo/blue', x: 1800, y: -100, w: 390, h: 844 },
    ] }),
  })
  dev = await startDev(root)
  browser = await Browser.launch()
  if (!browser) return
  s = await browser.tab({ width: 1400, height: 900 })
  await browser.go(s, `${dev.origin}/#/b/main`)
  await browser.until(s, `!!window.__mvStore && __mvStore.getState().nodes.length === 3 && __mvStore.getState().nodes.every((n) => n.status === 'ready')`, 30_000)
  await browser.send('Page.bringToFront', {}, s)
  await browser.eval(s, `import(${JSON.stringify(`/@fs${PROBES}`)}).then((m) => { window.__probes = m; return true })`)
}, 120_000)
afterAll(async () => {
  browser?.close()
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

const ev = (js: string) => browser!.eval(s, js)
const skip = (ctx: { skip: () => void }) => { if (!browser) ctx.skip() }
/** in the page: every node's rect now, and whether (x, y) is clear of them by at least d */
const HELPERS = `
  window.__rects = () => [...document.querySelectorAll('.sh-node')].map((e) => e.getBoundingClientRect())
  window.__dist = (x, y, rs) => Math.min(Infinity, ...rs.map((r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom))))
  1`

describe('the probes (A3.8 #16)', () => {
  it('at rest: 4 to 16 points of empty background, each 48 px or more from every frame, the surface under it, all still valid after', async (ctx) => {
    skip(ctx)
    await ev(HELPERS)
    await ev(`__mvJamCanvas.fitAll(); 1`)
    await browser!.until(s, `!__mvJamCanvas.cameraBusy()`, 5000)
    await new Promise((r) => setTimeout(r, 300))
    const r = await ev(`(() => {
      const b = __probes.pick(1)
      const rs = __rects()
      const a = __probes.verify(1)
      return { n: b.points.length, near: b.points.filter(([x, y]) => __dist(x, y, rs) < 48).length,
        surface: b.points.every(([x, y]) => __probes.isSurface(document.elementFromPoint(x, y))), valid: a.valid, cam: b.cam, nodes: rs.length,
        view: b.view, at: b.at, after: a.at }
    })()`)
    expect(r.nodes).toBe(3)
    expect(r.n).toBeGreaterThanOrEqual(4)
    expect(r.n).toBeLessThanOrEqual(16)
    expect(r.near).toBe(0)
    expect(r.surface).toBe(true)
    expect(r.valid).toEqual(Array(r.n).fill(true))
    expect(r.cam).toMatchObject({ s: expect.any(Number) })
    expect(r.view).toEqual({ w: 1400, h: 900 })
  })

  it('a frame white on purpose holds no probe: it is excluded by its rect', async (ctx) => {
    skip(ctx)
    const r = await ev(`(() => {
      const el = document.querySelector('[data-node-key="n-white"]') || [...document.querySelectorAll('.sh-node')].find((e) => e.textContent.includes('White'))
      const w = el.getBoundingClientRect()
      const b = __probes.pick(2); __probes.verify(2)
      return { inside: b.points.filter(([x, y]) => x >= w.left && x <= w.right && y >= w.top && y <= w.bottom).length, n: b.points.length, w: [w.width, w.height] }
    })()`)
    expect(r.w[0]).toBeGreaterThan(50)
    expect(r.n).toBeGreaterThan(0)
    expect(r.inside).toBe(0)
  })

  it('while the camera pans fast, no accepted probe lies inside a frame at either side of its bracket', async (ctx) => {
    skip(ctx)
    // the probe loop runs in the page while real wheel events pan the canvas
    await ev(`window.__run = (async () => {
      const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
      const out = { ticks: 0, points: 0, valid: 0, bad: [], maxMove: 0, cam0: __mvJamCanvas.transform(), cam1: null }
      const end = performance.now() + 1800
      for (let k = 100; performance.now() < end; k++) {
        const b = __probes.pick(k)
        const r0 = __rects()
        await raf(); await raf()
        const a = __probes.verify(k)
        out.maxMove = Math.max(out.maxMove, Math.hypot(a.cam.x - b.cam.x, a.cam.y - b.cam.y))
        const r1 = __rects()
        out.ticks++
        out.points += b.points.length
        b.points.forEach(([x, y], i) => {
          if (!a.valid[i]) return
          out.valid++
          const d0 = __dist(x, y, r0), d1 = __dist(x, y, r1)
          if (d0 <= 0 || d1 <= 0) out.bad.push({ k, x, y, d0, d1 })
        })
        await new Promise((r) => setTimeout(r, 30))
      }
      out.cam1 = __mvJamCanvas.transform()
      return out
    })(); 1`)
    const t0 = Date.now()
    let dx = 240
    while (Date.now() - t0 < 1700) {
      void browser!.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 450, deltaX: dx, deltaY: 0 }, s)
      if (Date.now() - t0 > 850) dx = -240
      await new Promise((r) => setTimeout(r, 16))
    }
    const r = await ev(`window.__run`)
    process.stdout.write(`probes-pan: ${JSON.stringify({ ticks: r.ticks, points: r.points, valid: r.valid, maxMove: r.maxMove })}\n`)
    expect(r.ticks).toBeGreaterThan(10)
    expect(r.maxMove).toBeGreaterThan(48)   // inside some brackets the camera moved more than a probe's least clearance
    expect(r.valid).toBeGreaterThan(0)
    expect(r.valid).toBeLessThan(r.points)   // the bracket dropped the points the camera moved too far
    expect(r.bad).toEqual([])
  })
})
