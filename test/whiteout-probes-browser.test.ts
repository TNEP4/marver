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
 * canvas's). Checked at rest, over a board with a frame that is white on purpose, and while the camera pans fast and
 * zooms in and out (A3.7's staged white-out runs during a synthetic zoom): no accepted probe ever lies inside a frame
 * at any animation frame of its bracket - at pick, at each frame between and at verify. In Chrome there is no inset:
 * the whole canvas is usable. Skips without Chrome.
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

  /**
   * The probe loop, in the page, while the test moves the camera: for each tick, pick, then 2 to 6 animation frames
   * (a capture and two asks take 15-50 ms) with every node's rect recorded at each of them, then verify. A point the
   * verify accepted must lie outside every node's rect at every frame of its bracket - at pick, at each frame between
   * and at verify - since the capture reads whichever of them was on the screen.
   */
  const LOOP = `window.__loop = async (ms) => {
    const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
    const out = { ticks: 0, points: 0, valid: 0, frames: 0, bad: [], maxMove: 0, maxRatio: 1, s: [] }
    const end = performance.now() + ms
    for (let k = 1000 + Math.floor(Math.random() * 1e6); performance.now() < end; k++) {
      const b = __probes.pick(k)
      const seen = [__rects()]
      const n = 2 + (k % 5)
      for (let i = 0; i < n; i++) { await raf(); seen.push(__rects()); out.frames++ }
      const a = __probes.verify(k)
      seen.push(__rects())
      if (a.cam && b.cam) {
        out.maxMove = Math.max(out.maxMove, Math.hypot(a.cam.x - b.cam.x, a.cam.y - b.cam.y))
        out.maxRatio = Math.max(out.maxRatio, a.cam.s / b.cam.s, b.cam.s / a.cam.s)
        out.s.push(a.cam.s)
      }
      out.ticks++
      out.points += b.points.length
      b.points.forEach(([x, y], i) => {
        if (!a.valid[i]) return
        out.valid++
        seen.forEach((rs, f) => { const d = __dist(x, y, rs); if (d <= 0) out.bad.push({ k, x, y, frame: f, of: seen.length, d }) })
      })
      await new Promise((r) => setTimeout(r, 10))
    }
    out.sMin = Math.min(...out.s); out.sMax = Math.max(...out.s); delete out.s
    return out
  }; 1`

  it('while the camera pans fast, no accepted probe lies inside a frame at any frame of its bracket', async (ctx) => {
    skip(ctx)
    await ev(HELPERS)
    await ev(LOOP)
    // close in on one frame, so its edges sweep across the probes beside it as the camera pans
    await ev(`__mvJamCanvas.fitNode('n-grey'); 1`)
    await browser!.until(s, `!__mvJamCanvas.cameraBusy()`, 5000)
    await ev(`__mvJamCanvas.zoomTo(0.7); 1`)
    await browser!.until(s, `!__mvJamCanvas.cameraBusy()`, 5000)
    await new Promise((r) => setTimeout(r, 300))
    await ev(`window.__run = __loop(1800); 1`)
    const t0 = Date.now()
    let dx = 240
    while (Date.now() - t0 < 1700) {
      void browser!.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 450, deltaX: dx, deltaY: 0 }, s)
      if (Date.now() - t0 > 850) dx = -240
      await new Promise((r) => setTimeout(r, 16))
    }
    const r = await ev(`window.__run`)
    process.stdout.write(`probes-pan: ${JSON.stringify({ ticks: r.ticks, frames: r.frames, points: r.points, valid: r.valid, bad: r.bad.length, maxMove: r.maxMove })}\n`)
    expect(r.ticks).toBeGreaterThan(10)
    expect(r.maxMove).toBeGreaterThan(48)   // inside some brackets the camera moved more than a probe's least clearance
    expect(r.valid).toBeGreaterThan(0)
    expect(r.valid).toBeLessThan(r.points)   // the bracket dropped the points the camera moved too far
    expect(r.bad).toEqual([])
  })

  it('while the camera zooms in and out about a point near a probe (ctrl-wheel), no accepted probe lies inside a frame at any frame of its bracket', async (ctx) => {
    skip(ctx)
    await ev(HELPERS)
    await ev(LOOP)
    // close in on one frame, so a zoom about a point beside it sweeps its edges across the probes around it
    await ev(`__mvJamCanvas.fitNode('n-grey'); 1`)
    await browser!.until(s, `!__mvJamCanvas.cameraBusy()`, 5000)
    await ev(`__mvJamCanvas.zoomTo(0.7); 1`)
    await browser!.until(s, `!__mvJamCanvas.cameraBusy()`, 5000)
    await new Promise((r) => setTimeout(r, 300))
    // the anchor: just beside a probe the shell picks at rest, so its world point barely moves while node edges do
    const p = await ev(`(() => { const b = __probes.pick(7); __probes.verify(7); return b.points[0] })()`) as [number, number]
    expect(p).toBeTruthy()
    await ev(`window.__run = __loop(2200); 1`)
    const t0 = Date.now()
    let dy = -30
    while (Date.now() - t0 < 2100) {
      void browser!.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p[0] + 24, y: p[1] + 12, deltaX: 0, deltaY: dy, modifiers: 2 }, s)
      if (Date.now() - t0 > 1050) dy = 30
      await new Promise((r) => setTimeout(r, 16))
    }
    const r = await ev(`window.__run`)
    process.stdout.write(`probes-zoom: ${JSON.stringify({ ticks: r.ticks, frames: r.frames, points: r.points, valid: r.valid, bad: r.bad.length, maxRatio: r.maxRatio, sMin: r.sMin, sMax: r.sMax })}\n`)
    expect(r.ticks).toBeGreaterThan(10)
    expect(r.sMax / r.sMin).toBeGreaterThan(1.5)   // the camera did zoom, in and out
    expect(r.maxRatio).toBeGreaterThan(1.02)        // and moved inside brackets
    expect(r.valid).toBeGreaterThan(0)
    expect(r.bad).toEqual([])
  })
})
