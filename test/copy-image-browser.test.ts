import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Copy-as-image, proven where it matters: a REAL dev server, a REAL browser, the clipboard
 * itself. Select a frame on the canvas, press I (2x) / Shift+I (4x), then read the clipboard
 * back and decode the bitmap - width must be scale × the node's width. Everything between
 * (the owner-gated /api/shot with format=png, the headless render, the promise-valued
 * ClipboardItem keeping the gesture alive across the render) is exercised end to end.
 * Skips, never fails, without Chrome - the same rule as every browser suite here.
 */

const PORT = 5297 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
// the dev server binds `localhost` (::1 on this OS), so the origin must be localhost too
const ORIGIN = `http://localhost:${PORT}`

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let log = ''

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-copyimg-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'copy-image-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..')
  const repoNm = join(repoRoot, 'node_modules')
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(repoNm)) { if (e !== '.bin') symlinkSync(join(repoNm, e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  const scenes = join(root, 'design', 'scenes', 'app')
  mkdirSync(scenes, { recursive: true })
  // a fixed UI frame (mobile) and a slide - the two sizing rules the copy must honour
  writeFileSync(join(scenes, 'home.tsx'), `export const meta = { title: 'Home', viewport: 'mobile' }
export default () => <main style={{ minHeight: '100vh', background: '#0b5' }}><h1 style={{ margin: 0, padding: 24, color: '#fff' }}>Home</h1></main>
`)
  writeFileSync(join(scenes, 'slide.tsx'), `import { Slide } from '@marver-design/marver/content'
export const meta = { title: 'Slide', slide: true }
export default () => <Slide><h1 className="sl-display" style={{ margin: 0 }}>Hello</h1></Slide>
`)
  // a chart slide: echarts is a lazy chunk that draws AFTER mount - the render must wait for it
  writeFileSync(join(scenes, 'chart.tsx'), `import { Slide, Chart } from '@marver-design/marver/content'
export const meta = { title: 'Chart', slide: true }
export default () => <Slide><Chart h={520} option={{ xAxis: { type: 'category', data: ['a', 'b', 'c', 'd'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [40, 80, 60, 95], itemStyle: { color: '#ff3b30' } }] }} /></Slide>
`)
  // a DARK UI screen with a chart in a responsive grid: the chart must inherit the screen's
  // ink and typeface, the frame must stay a UI frame (device height, no document measuring)
  writeFileSync(join(scenes, 'dash.tsx'), `import { Chart } from '@marver-design/marver/content'
export const meta = { title: 'Dash', viewport: 'mobile', theme: 'dark' }
export default () => (
  <main style={{ fontFamily: 'Georgia, serif', background: '#0f1115', color: 'rgb(230, 230, 230)', minHeight: '100vh', padding: 16 }}>
    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
      <section><Chart h={200} option={{ xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [1, 2] }] }} /></section>
      <section><Chart h={200} option={{ series: [{ type: 'pie', radius: '60%', label: { position: 'inside' }, data: [{ value: 1, name: 'X' }, { value: 2, name: 'Y' }] }] }} /></section>
    </div>
  </main>
)
`)
  const boards = join(root, 'design', 'boards')
  mkdirSync(boards, { recursive: true })
  writeFileSync(join(boards, 'main.json'), JSON.stringify({
    version: 1, name: 'main', order: 1,
    nodes: [
      { key: 'home', frame: 'app/home', x: 0, y: 0, w: 390, h: 844 },
      { key: 'slide', frame: 'app/slide', x: 500, y: 0, w: 640, h: 360 },
      { key: 'chart', frame: 'app/chart', x: 500, y: 500, w: 640, h: 360 },
      { key: 'dash', frame: 'app/dash', x: 0, y: 1000, w: 390, h: 844 },
    ],
  }))
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000) {
    const ok = await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)
    if (ok) break
    await new Promise((r) => setTimeout(r, 200))
  }
  browser = await Browser.launch()
  // Warm the dev server: the first frame to import echarts makes Vite optimize the dep and
  // RELOAD every open page ("optimized dependencies changed. reloading") - a one-time boot
  // event in any fresh project, which would wipe a copy in flight. Take it here, once, so the
  // tests below are order-independent.
  if (browser) {
    const s = await browser.tab({ width: 1400, height: 900 })
    await browser.go(s, `${ORIGIN}/`)
    const t1 = Date.now()
    while (Date.now() - t1 < 20_000 && !/optimized dependencies changed|dependencies optimized/.test(log)) await new Promise((r) => setTimeout(r, 200))
    await new Promise((r) => setTimeout(r, 1_000))   // let the reload start
    await browser.until(s, `(() => { const st = window.__mvStore?.getState(); return !!st && st.nodes.length === 4 && st.nodes.every((n) => n.status === 'ready') })()`, 60_000).catch(() => {})
    await browser.send('Target.closeTarget', { targetId: (await browser.send('Target.getTargetInfo', {}, s)).targetInfo.targetId })
  }
}, 120_000)

afterAll(() => {
  browser?.close()
  try { server?.kill('SIGTERM') } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true })
})

/** Open the canvas, wait for both frames to be ready, and select one node by key. */
async function openAndSelect(b: Browser, key: string): Promise<string> {
  const s = await b.tab({ width: 1400, height: 900 })
  // NOTHING is granted before the gesture: the write must ride on the key/click's own user
  // activation (kept alive across the render by the promise-valued ClipboardItem). Read-back
  // permission is granted only afterwards, in clipboardImage().
  await b.go(s, `${ORIGIN}/`)
  await b.until(s, `(() => { const st = window.__mvStore?.getState(); return !!st && st.nodes.length === 4 && st.nodes.every((n) => n.status === 'ready') })()`, 60_000)
  await b.eval(s, `window.__mvStore.getState().select(${JSON.stringify(key)})`)
  await b.send('Page.bringToFront', {}, s)
  await b.send('Emulation.setFocusEmulationEnabled', { enabled: true }, s)
  return s
}

/** What the clipboard holds, decoded: the PNG's pixel size, plus how many pixels in the lower
 *  band are strongly red (the chart fixture's bar colour) - the proof a chart actually drew. */
const clipboardImage = async (b: Browser, s: string) => {
  await b.grant(s, ORIGIN, ['clipboardReadWrite'])
  return b.eval(s, `(async () => {
    const items = await navigator.clipboard.read()
    const it = items.find((i) => i.types.includes('image/png'))
    if (!it) return { types: items.map((i) => i.types) }
    const blob = await it.getType('image/png')
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0)
    const y0 = Math.floor(bmp.height * 0.3), d = g.getImageData(0, y0, bmp.width, bmp.height - y0).data
    let red = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90) red++
    return { w: bmp.width, h: bmp.height, bytes: blob.size, red }
  })()`)
}

const skippable = (name: string, fn: () => Promise<void>, ms = 90_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)

describe('copy frame as image - real dev server, real browser, real clipboard', () => {
  skippable('I copies the selected fixed frame at 2x, sized to the node; the button flashes a check', async () => {
    const s = await openAndSelect(browser!, 'home')
    await browser!.until(s, `!!document.querySelector('.sh-ctx button[aria-label="Copy as image"]')`)
    await browser!.press(s, 'i')
    await browser!.until(s, `window.__mvStore.getState().imageBusy === true`, 5_000)
    await browser!.until(s, `window.__mvStore.getState().imagePulse === 1`, 40_000)
    expect(await browser!.eval(s, `document.querySelector('.sh-ctx button[aria-label="Copy as image"]').dataset.state`)).toBe('copied')
    const img = await clipboardImage(browser!, s)
    expect(img).toMatchObject({ w: 390 * 2, h: 844 * 2 })
    // the same PNG landed on disk for the agent, under the 2x (default) name
    expect(readdirSync(join(root, 'design', '.local', 'shots'))).toContain('app--home--light.png')
  })

  skippable('control: an UNGESTURED image write is refused in a fresh context - so the copies above ride the key\'s activation', async () => {
    const s = await openAndSelect(browser!, 'home')
    const r = await browser!.eval(s, `navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array([137,80,78,71])], { type: 'image/png' }) })]).then(() => 'wrote', (e) => e.name)`)
    expect(r).toBe('NotAllowedError')
  })

  skippable('Shift+I copies a slide at 4x - 5120×2880 whatever size the node has on the canvas', async () => {
    const s = await openAndSelect(browser!, 'slide')
    await browser!.press(s, 'I', { shift: true })
    await browser!.until(s, `window.__mvStore.getState().imagePulse === 1`, 40_000)
    const img = await clipboardImage(browser!, s)
    expect(img).toMatchObject({ w: 5120, h: 2880 })
    expect(readdirSync(join(root, 'design', '.local', 'shots'))).toContain('app--slide--light@4x.png')
  })

  skippable('a slide with a chart copies with the chart DRAWN - the render waits for the lazy engine', async () => {
    const s = await openAndSelect(browser!, 'chart')
    await browser!.press(s, 'i')
    await browser!.until(s, `window.__mvStore.getState().imagePulse === 1`, 40_000).catch(async (e) => {
      const dbg = await browser!.eval(s, `JSON.stringify({ toast: document.querySelector('.sh-toast')?.textContent, busy: window.__mvStore.getState().imageBusy, sel: window.__mvStore.getState().selection })`)
      throw new Error(`${e.message}\n${dbg}\n${log.slice(-1500)}`)
    })
    const img = await clipboardImage(browser!, s)
    expect(img).toMatchObject({ w: 2560, h: 1440 })
    // four bars of a 1104px-wide plot at 2x: well over 100k red pixels; a blank slide has zero
    expect(img.red).toBeGreaterThan(100_000)
  })

  skippable('the button click copies too, and a multi-selection disables it', async () => {
    const s = await openAndSelect(browser!, 'home')
    // a trusted click: CDP mouse events at the button's centre. The bar re-anchors as the
    // selection settles (measured width, viewport clamp), so under load a click can land on
    // the old position: re-read and click again if the store did not go busy.
    const click = async () => {
      const box = await browser!.eval(s, `(() => { const r = document.querySelector('.sh-ctx button[aria-label="Copy as image"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
      await browser!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }, s)
      await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, s)
      await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, s)
      return browser!.until(s, `window.__mvStore.getState().imageBusy === true || window.__mvStore.getState().imagePulse === 1`, 2_000).then(() => true, () => false)
    }
    if (!(await click())) { await new Promise((r) => setTimeout(r, 500)); expect(await click()).toBe(true) }
    await browser!.until(s, `window.__mvStore.getState().imagePulse === 1`, 40_000)
    expect(await clipboardImage(browser!, s)).toMatchObject({ w: 780, h: 1688 })
    await browser!.eval(s, `window.__mvStore.getState().select('slide', true)`)
    await browser!.until(s, `document.querySelector('.sh-ctx button[aria-label="Copy as image"]')?.disabled === true`)
    // the shortcut is inert on a multi-selection: no busy, no pulse
    await browser!.press(s, 'i')
    await new Promise((r) => setTimeout(r, 400))
    expect(await browser!.eval(s, `[window.__mvStore.getState().imageBusy, window.__mvStore.getState().imagePulse]`)).toEqual([false, 1])
  })

  skippable('a chart in a DARK UI screen inherits the screen\'s ink + typeface, keeps the frame a UI frame, and follows a resize', async () => {
    // classification: importing Chart did not turn the screen into a document
    const manifest = JSON.parse(readFileSync(join(root, 'design', 'manifest.json'), 'utf8'))
    const dash = manifest.frames.find((f: { id: string }) => f.id === 'app/dash')
    expect(dash).toMatchObject({ viewport: 'mobile', theme: 'dark' })
    expect(dash.contentWidth).toBeUndefined(); expect(dash.intent).toBeUndefined()
    // the rendered chart, in the frame host: labels painted in the screen's ink and family
    const s = await browser!.tab({ width: 390, height: 844 })
    await browser!.go(s, `${ORIGIN}/__mv/frame/?id=app/dash&theme=dark`)
    await browser!.until(s, `document.querySelectorAll('.mv-chart svg').length === 2`, 30_000)
    const label = await browser!.eval(s, `(() => { const t = document.querySelector('.mv-chart svg text'); const c = getComputedStyle(t); return { fill: t.getAttribute('fill'), stroke: t.getAttribute('stroke'), font: c.fontFamily, size: t.getAttribute('font-size') ?? c.fontSize } })()`)
    expect(label.fill).toBe('rgb(230, 230, 230)'); expect(label.stroke).toBeNull()
    expect(label.font).toMatch(/Georgia/)
    expect(String(label.size)).toMatch(/^12/)   // UI scale, not the 18px slide scale
    // the pie's inside labels all rendered (no #333-on-dark, no clipped outside label)
    expect(await browser!.eval(s, `[...document.querySelectorAll('.mv-chart')[1].querySelectorAll('text')].map((t) => t.textContent).sort().join()`)).toBe('X,Y')
    // resize: the 2fr column narrows with the viewport, and the SVG follows it
    const w1 = await browser!.eval(s, `Number(document.querySelector('.mv-chart svg').getAttribute('width'))`)
    await browser!.send('Emulation.setDeviceMetricsOverride', { width: 300, height: 844, deviceScaleFactor: 1, mobile: true }, s)
    await browser!.until(s, `Number(document.querySelector('.mv-chart svg').getAttribute('width')) < ${w1} - 40`, 5_000)
    const box = await browser!.eval(s, `Math.round(document.querySelector('.mv-chart').getBoundingClientRect().width)`)
    expect(await browser!.eval(s, `Number(document.querySelector('.mv-chart svg').getAttribute('width'))`)).toBe(box)
  })

  skippable('the endpoint refuses a bad scale and streams PNG bytes with the summary header on format=png', async () => {
    // owner-gated: mint the cookie the shell gets on its first GET, echo it as x-mv-c
    const first = await fetch(`${ORIGIN}/__mv/api/boards`)
    const cookie = /mv_c=([\w-]+)/.exec(first.headers.get('set-cookie') ?? '')?.[1] ?? ''
    expect(cookie).not.toBe('')
    const h = { cookie: `mv_c=${cookie}`, 'x-mv-c': cookie }
    const bad = await fetch(`${ORIGIN}/__mv/api/shot?frame=app/home&scale=7`, { headers: h })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe('invalid scale')
    const png = await fetch(`${ORIGIN}/__mv/api/shot?frame=app/home&scale=1&w=320&h=200&format=png`, { headers: h })
    expect(png.status).toBe(200)
    expect(png.headers.get('content-type')).toBe('image/png')
    expect(JSON.parse(Buffer.from(png.headers.get('x-mv-shot') ?? '', 'base64url').toString())).toMatchObject({ frame: 'app/home', width: 320, height: 200, scale: 1 })
    const buf = Buffer.from(await png.arrayBuffer())
    expect(buf.subarray(1, 4).toString()).toBe('PNG')
    expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([320, 200])
  }, 60_000)
})
