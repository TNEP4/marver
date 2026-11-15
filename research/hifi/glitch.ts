/**
 * The glitch instrument: what the compositor actually SHOWS during a gesture (Page.screencast
 * frames are the presented frames, checkerboard included), unlike Page.captureScreenshot, which
 * waits for every tile to raster and therefore never sees a missing tile.
 *
 *   MV_CHROME_HEADED=1 MV_CHROME_FLAGS='--window-size=2000,1300' npx tsx research/hifi/glitch.ts \
 *     http://localhost:5260 shipper-high-fi '' '' asleep
 *
 * args: origin board query(js|css) tag. Per phase it reports the number of uniform 20x20 blocks
 * (a missing tile is a flat rectangle) in every presented frame against the settled frame, and
 * writes the worst frames to research/hifi/out/glitch-<tag>-<phase>-*.png.
 */
import { writeFileSync } from 'node:fs'
import { Browser } from '../../test/browser.ts'
const [origin = 'http://localhost:5260', board = 'shipper-high-fi', q = '', css = '', tag = 'x'] = process.argv.slice(2)
const W = 2000, H = 1200
const b = (await Browser.launch())!
const s = await b.tab()
await b.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false }, s)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
await b.go(s, `${origin}/?${q}#/b/${board}`)
await b.until(s, `(() => { const st = window.__mvStore?.getState(); if (st) return st.nodes.length > 0 && st.nodes.every((n) => n.status === 'ready'); const fr = [...document.querySelectorAll('iframe.sh-live')]; return fr.length > 0 && fr.every((f) => f.contentDocument?.getElementById('mv-sleep')) })()`, 90_000)   // a published shell has no store hook: every frame asleep is every frame ready
await wait(5000)
if (css.startsWith('js:')) console.log('js:', await b.eval(s, css.slice(3)))
else if (css) await b.eval(s, `(() => { const st = document.createElement('style'); st.textContent = ${JSON.stringify(css)}; document.head.appendChild(st); return 1 })()`)
await wait(500)
const state = () => b.eval(s, `(() => { const fr = [...document.querySelectorAll('iframe')]; return fr.map((f) => { const d = f.contentDocument; if (!d) return 'no-doc'; const st = d.getElementById('mv-sleep'); const n = d.querySelectorAll('[data-mv-sleep]').length; const bf = [...d.querySelectorAll('*')].filter((e) => { const v = getComputedStyle(e).backdropFilter; return v && v !== 'none' && !/blur\\(0px\\)/.test(v) }).length; return (st ? 'asleep' : 'live') + ':' + n + ' textures, ' + bf + ' live filters' }) })()`)
console.log('frames:', JSON.stringify(await state()))
console.log('scale:', await b.eval(s, `getComputedStyle(document.querySelector('.sh-canvas'), '::before').getPropertyValue('--sh-s')`))

// ---- screencast: the presented frames
const frames: { phase: string; t: number; data: string }[] = []
let phase = 'idle'
const t0 = Date.now()
const off = b['cdp'].on((m: any) => {
  if (m.sessionId !== s || m.method !== 'Page.screencastFrame') return
  frames.push({ phase, t: Date.now() - t0, data: m.params.data })
  void b.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }, s)
})
await b.send('Page.startScreencast', { format: 'png', maxWidth: 1000, maxHeight: 600, everyNthFrame: 1 }, s)
const wheel = (x: number, y: number, dx: number, dy: number, ctrl = false) => b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy, modifiers: ctrl ? 2 : 0 }, s)
const run = async (name: string, n: number, dx: number, dy: number, ctrl: boolean, x = 700, y = 650) => {
  phase = name
  for (let i = 0; i < n; i++) { await wheel(x, y, dx, dy, ctrl); await wait(8) }
  phase = name + '.settle'
  await wait(1500)
}
await run('zoom-in', 75, 0, -2, true)
console.log('scale after zoom-in:', await b.eval(s, `getComputedStyle(document.querySelector('.sh-canvas'), '::before').getPropertyValue('--sh-s')`))
await run('pan', 150, -10, -6, false)
await run('pan-back', 150, 10, 6, false)
await run('zoom-out', 75, 0, 2, true)
await b.send('Page.stopScreencast', {}, s)
off()
console.log('frames captured:', frames.length, 'in', Date.now() - t0, 'ms;', JSON.stringify(await state()))

// ---- analysis, in a scratch tab: uniform 20x20 blocks per presented frame
const a = await b.tab()
await b.go(a, 'about:blank')
const measure = (data: string) => b.eval(a, `(async () => { const im = new Image(); await new Promise((r) => { im.onload = r; im.src = 'data:image/png;base64,${data}' })
  const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0)
  const d = g.getImageData(0, 0, c.width, c.height).data, B = 20; let uni = 0
  for (let by = 0; by + B <= c.height; by += B) for (let bx = 0; bx + B <= c.width; bx += B) {
    const o = (by * c.width + bx) * 4, r = d[o], gg = d[o + 1], bb = d[o + 2]; let ok = true
    for (let y = 0; y < B && ok; y++) for (let x = 0; x < B; x++) { const p = ((by + y) * c.width + bx + x) * 4; if (d[p] !== r || d[p + 1] !== gg || d[p + 2] !== bb) { ok = false; break } }
    if (ok) uni++ }
  return uni })()`)
const byPhase = new Map<string, { t: number; uni: number; data: string }[]>()
for (const f of frames) { const u = await measure(f.data); const l = byPhase.get(f.phase) ?? []; l.push({ t: f.t, uni: u, data: f.data }); byPhase.set(f.phase, l) }
for (const name of ['zoom-in', 'pan', 'pan-back', 'zoom-out']) {
  const g = byPhase.get(name) ?? [], st = byPhase.get(name + '.settle') ?? []
  const settled = st.at(-1)?.uni ?? -1
  const sorted = [...g].sort((x, y) => y.uni - x.uni)
  const excess = g.filter((f) => f.uni > settled + 15).length
  console.log(`${name}: ${g.length} frames, settled ${settled} uniform blocks, gesture max ${sorted[0]?.uni ?? -1}, mean ${Math.round(g.reduce((z, f) => z + f.uni, 0) / Math.max(1, g.length))}, frames > settled+15: ${excess}`)
  sorted.slice(0, 2).forEach((f, i) => writeFileSync(`research/hifi/out/glitch-${tag}-${name}-worst${i}.png`, Buffer.from(f.data, 'base64')))
  if (st.at(-1)) writeFileSync(`research/hifi/out/glitch-${tag}-${name}-settled.png`, Buffer.from(st.at(-1)!.data, 'base64'))
}
b.close()
