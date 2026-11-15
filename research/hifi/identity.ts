/**
 * Pixel identity of SLEEP vs AWAKE at rest: the same board, the same camera, one screenshot with the
 * frames live (real backdrop-filters) and one with them asleep (baked). Diffed per pixel at DPR 2 at
 * two zooms. The number that matters for "pixel-perfect".
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { Browser } from '../../test/browser.ts'
const [origin = 'http://localhost:5250', board = 'shipper-high-fi'] = process.argv.slice(2)
const OUT = `research/hifi/out/identity-${board}`; mkdirSync(OUT, { recursive: true })
const W = 1440, H = 900
const b = (await Browser.launch())!
const s = await b.tab()
await b.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false }, s)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ready = () => b.until(s, `(() => { const st = window.__mvStore?.getState(); return !!st && st.nodes.length > 0 && st.nodes.every((n) => n.status === 'ready') })()`, 90_000)
const shot = async () => Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' }, s)).data, 'base64')
const setCam = (scale: number) => b.eval(s, `(() => { const a = document.querySelector('.sh-app'); return true })()`)
const diff = async (a: Buffer, bb: Buffer) => b.eval(s, `(async () => {
  const load = (d) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = 'data:image/png;base64,' + d })
  const [ia, ib] = await Promise.all([load(${JSON.stringify(a.toString('base64'))}), load(${JSON.stringify(bb.toString('base64'))})])
  const px = (im) => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0); return g.getImageData(0, 0, c.width, c.height).data }
  const da = px(ia), db = px(ib)
  let diff = 0, gt2 = 0, gt8 = 0, gt32 = 0, maxd = 0, sum = 0
  for (let i = 0; i < da.length; i += 4) { const d = Math.max(Math.abs(da[i]-db[i]), Math.abs(da[i+1]-db[i+1]), Math.abs(da[i+2]-db[i+2])); if (d) diff++; if (d > 2) gt2++; if (d > 8) gt8++; if (d > 32) gt32++; if (d > maxd) maxd = d; sum += d }
  const n = da.length / 4
  return { pixels: n, diff, gt2, gt8, gt32, maxd, mean: (sum / n).toFixed(3) }
})()`)
// the same camera both times: fit all, then zoom to 1 about the centre via the shell's own control
const capture = async (q: string, zoom: number) => {
  await b.go(s, `${origin}/?${q}#/b/${board}`); await ready()
  await b.eval(s, `document.querySelectorAll('.sh-node').length`)
  await wait(1500)
  if (!q.includes('awake')) await b.until(s, `Array.from(document.querySelectorAll('iframe.sh-live')).every((f) => f.contentDocument?.getElementById('mv-sleep'))`, 300_000).catch(() => console.log('(not every frame slept)'))
  else await wait(2000)
  await b.eval(s, `window.__mvStore.getState().selection.length ? window.__mvStore.getState().select(null) : 0`)
  // zoom via the shell control so both runs land on the identical transform
  await b.eval(s, `(() => { const w = document.getElementById('sh-world'); return true })()`)
  // zoom in with a FIXED wheel sequence at a fixed point: both runs start from the same fit, so
  // they land on the same transform
  for (let i = 0; i < zoom; i++) { await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 620, y: 470, deltaX: 0, deltaY: -60, modifiers: 2 }, s); await wait(25) }
  await wait(2500)
  console.log('scale', await b.eval(s, `getComputedStyle(document.querySelector('.sh-canvas'), '::before').getPropertyValue('--sh-s')`))
  return shot()
}
const VARIANT = process.argv[5] ?? ''
for (const zoom of [Number(process.argv[4] ?? 0)]) {
  // the control first: two LIVE loads of the same board, the noise floor of the page itself
  const liveA = await capture('awake=1', zoom)
  const live = await capture('awake=1', zoom)
  const baked = await capture('', zoom)
  writeFileSync(`${OUT}/liveA-z${zoom}.png`, liveA); writeFileSync(`${OUT}/live-z${zoom}.png`, live); writeFileSync(`${OUT}/baked-z${zoom}.png`, baked)
  console.log('control  live vs live (two loads):', JSON.stringify(await diff(liveA, live)))
  console.log('measure  live vs asleep:          ', JSON.stringify(await diff(live, baked)))
  const asleep = await b.eval(s, `Array.from(document.querySelectorAll('iframe.sh-live')).map((f) => f.contentDocument?.querySelectorAll('[data-mv-sleep]').length ?? 0)`)
  console.log('baked elements per frame:', JSON.stringify(asleep))
  const heat = await b.eval(s, `(async () => {
    const load = (d) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = 'data:image/png;base64,' + d })
    const [ia, ib] = await Promise.all([load(${JSON.stringify(live.toString('base64'))}), load(${JSON.stringify(baked.toString('base64'))})])
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height; const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(ia, 0, 0); const A = g.getImageData(0, 0, c.width, c.height); g.drawImage(ib, 0, 0); const B = g.getImageData(0, 0, c.width, c.height)
    const o = g.createImageData(c.width, c.height)
    for (let i = 0; i < A.data.length; i += 4) { const d = Math.max(Math.abs(A.data[i]-B.data[i]), Math.abs(A.data[i+1]-B.data[i+1]), Math.abs(A.data[i+2]-B.data[i+2])); o.data[i] = Math.min(255, d * 6); o.data[i+1] = d > 8 ? 255 : 0; o.data[i+2] = d > 32 ? 255 : 0; o.data[i+3] = 255 }
    g.putImageData(o, 0, 0); return c.toDataURL('image/png').split(',')[1]
  })()`)
  writeFileSync(`${OUT}/heat-z${zoom}.png`, Buffer.from(heat, 'base64'))
}
b.close()
