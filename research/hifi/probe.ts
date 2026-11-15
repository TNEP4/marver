/**
 * Reproduce + measure the hi-fi canvas glitch on a LIVE marver dev server, in real Chrome
 * (GPU on), over CDP. No repo is changed: the counterfactual (`--no-backdrop`) injects
 * `backdrop-filter: none` into every frame document from the outside.
 *
 *   node --experimental-strip-types research/hifi/probe.ts <origin> <board> [--no-backdrop] [--dsf 2] [--out dir]
 *
 * Measures, per phase (rest → zoom to ~0.5 → 30 pan ticks → 30 more at ~0.25):
 *   - trace: main-thread frame durations + dropped frames (devtools.timeline.frame), raster task
 *     time, GPU task time, "checkerboard" tiles (cc: tiles without content when drawn)
 *   - LayerTree: layer count and estimated GPU memory (w*h*4 summed over drawn layers)
 *   - Memory.getDOMCounters, Performance.getMetrics
 *   - screenshots at several ticks so the eye can judge white / grey boxes
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from '../../test/browser.ts'

const [origin = 'http://localhost:5242', board = 'shipper-high-fi', ...rest] = process.argv.slice(2)
const flag = (n: string) => rest.includes(n)
const opt = (n: string, d: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d }
const NOBACK = flag('--no-backdrop')
const NOMASK = flag('--no-mask')
const NOFIXED = flag('--no-fixed')
const DSF = Number(opt('--dsf', '2'))
const Q = opt('--q', '')
const OUT = opt('--out', `research/hifi/out/${board}${NOBACK ? '-noback' : ''}-dsf${DSF}`)
mkdirSync(OUT, { recursive: true })
const W = 1440, H = 900

const b = (await Browser.launch())!
const s = await b.tab()
await b.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DSF, mobile: false }, s)
await b.send('Page.enable', {}, s)
await b.send('Performance.enable', {}, s)
await b.send('LayerTree.enable', {}, s)
let layers: any[] = []
const off = b['cdp'].on((m: any) => { if (m.sessionId === s && m.method === 'LayerTree.layerTreeDidChange') layers = m.params.layers ?? [] })

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const shot = async (name: string) => {
  const r = await b.send('Page.captureScreenshot', { format: 'png' }, s)
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
}
const layerStats = () => {
  const drawn = layers.filter((l) => l.drawsContent)
  const bytes = drawn.reduce((a, l) => a + l.width * l.height * 4 * DSF * DSF, 0)
  return { layers: layers.length, drawn: drawn.length, gpuMB: Math.round(bytes / 1048576) }
}
const metrics = async () => {
  const m = await b.send('Performance.getMetrics', {}, s)
  const pick = (n: string) => m.metrics.find((x: any) => x.name === n)?.value
  const dom = await b.send('Memory.getDOMCounters', {}, s)
  return { nodes: pick('Nodes'), jsHeapMB: Math.round(pick('JSHeapUsedSize') / 1048576), layoutCount: pick('LayoutCount'), recalcCount: pick('RecalcStyleCount'), documents: dom.documents, domNodes: dom.nodes }
}
// wheel with modifiers=2 (ctrl) zooms in the shell; plain wheel pans
const wheel = (dx: number, dy: number, ctrl = false) =>
  b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: W / 2 + 120, y: H / 2 + 40, deltaX: dx, deltaY: dy, modifiers: ctrl ? 2 : 0 }, s)
const scale = () => b.eval(s, `Number(getComputedStyle(document.querySelector('.sh-canvas'), '::before').getPropertyValue('--sh-s'))`)

// ---- tracing helpers: collect the trace into memory, summarise frames/raster/checkerboard
async function traced<T>(label: string, fn: () => Promise<T>): Promise<T> {
  await b.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: ['disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'cc', 'disabled-by-default-cc.debug', 'gpu', 'viz', 'blink'], excludedCategories: [] } }, s)
  const r = await fn()
  const done = new Promise<string>((res) => { const h = b['cdp'].on((m: any) => { if (m.sessionId === s && m.method === 'Tracing.tracingComplete') { h(); res(m.params.stream) } }) })
  await b.send('Tracing.end', {}, s)
  const stream = await done
  let text = ''
  for (;;) { const c = await b.send('IO.read', { handle: stream, size: 4 * 1024 * 1024 }, s); text += c.base64Encoded ? Buffer.from(c.data, 'base64').toString('utf8') : c.data; if (c.eof) break }
  await b.send('IO.close', { handle: stream }, s)
  const ev = (JSON.parse(text).traceEvents ?? []) as any[]
  const by = (name: string) => ev.filter((e) => e.name === name)
  const sum = (name: string) => by(name).reduce((a, e) => a + (e.dur ?? 0), 0) / 1000
  const frames = by('DrawFrame').length
  const dropped = by('DroppedFrame').length
  const partial = ev.filter((e) => e.name === 'PipelineReporter' && e.args?.data?.state === 'STATE_DROPPED').length
  const raster = sum('RasterTask') + sum('RasterizerTaskImpl')
  const gpu = sum('GPUTask')
  const paint = sum('Paint')
  const layout = sum('Layout')
  const checker = ev.filter((e) => /checkerboard/i.test(e.name)).length
  const longTasks = ev.filter((e) => e.name === 'RunTask' && (e.dur ?? 0) > 50_000).length
  const summary = { label, frames, dropped, droppedPipeline: partial, rasterMs: Math.round(raster), gpuMs: Math.round(gpu), paintMs: Math.round(paint), layoutMs: Math.round(layout), checkerboardEvents: checker, longTasks, ...layerStats(), ...(await metrics()), scale: await scale() }
  console.log(JSON.stringify(summary))
  return r
}

console.log(`probe ${origin}/${Q ? '?' + Q : ''}#/b/${board} noBackdrop=${NOBACK} dsf=${DSF}`)
await b.go(s, `${origin}/${Q ? '?' + Q : ''}#/b/${board}`)
await b.until(s, `(() => { const st = window.__mvStore?.getState(); return !!st && st.nodes.length > 0 && st.nodes.every((n) => n.status === 'ready') })()`, 90_000)
await wait(2000)
if (!Q.includes('awake')) await b.until(s, `Array.from(document.querySelectorAll('iframe.sh-live')).every((f) => f.contentDocument?.getElementById('mv-sleep'))`, 300_000).catch(() => console.log('(not every frame went to sleep)'))
console.log('asleep:', await b.eval(s, `Array.from(document.querySelectorAll('iframe.sh-live')).filter((f) => f.contentDocument?.getElementById('mv-sleep')).length + '/' + document.querySelectorAll('iframe.sh-live').length + ' textures ' + Array.from(document.querySelectorAll('iframe.sh-live')).reduce((a, f) => a + (f.contentDocument?.querySelectorAll('[data-mv-sleep]').length ?? 0), 0)`))
if (NOBACK) {
  const n = await b.eval(s, `(() => { let n = 0; for (const f of document.querySelectorAll('iframe')) { const d = f.contentDocument; if (!d) continue; const st = d.createElement('style'); st.textContent = '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}'; d.head?.appendChild(st); n++ } return n })()`)
  console.log('backdrop-filter disabled in', n, 'documents')
  await wait(800)
}
if (NOMASK || NOFIXED) {
  const css = (NOMASK ? '*{mask:none!important;-webkit-mask:none!important;mask-image:none!important;-webkit-mask-image:none!important;clip-path:none!important}' : '') + (NOFIXED ? '*{position:static}[style*="position: fixed"],.fixed{position:absolute!important}' : '')
  const n = await b.eval(s, `(() => { let n = 0; for (const f of document.querySelectorAll('iframe.sh-live')) { const d = f.contentDocument; if (!d) continue; const st = d.createElement('style'); st.textContent = ${JSON.stringify(css)}; d.head?.appendChild(st); n++ } return n })()`)
  console.log('neutralised mask/fixed in', n, 'documents')
  await wait(800)
}
// idle: how much main-thread work do the sleeping documents do at rest? (5 s window)
{
  const m0 = await b.send('Performance.getMetrics', {}, s); await wait(5000); const m1 = await b.send('Performance.getMetrics', {}, s)
  const g = (m: any, n: string) => m.metrics.find((x: any) => x.name === n)?.value ?? 0
  console.log(JSON.stringify({ label: 'idle-5s', taskMs: Math.round((g(m1, 'TaskDuration') - g(m0, 'TaskDuration')) * 1000), scriptMs: Math.round((g(m1, 'ScriptDuration') - g(m0, 'ScriptDuration')) * 1000), layoutMs: Math.round((g(m1, 'LayoutDuration') - g(m0, 'LayoutDuration')) * 1000), styleMs: Math.round((g(m1, 'RecalcStyleDuration') - g(m0, 'RecalcStyleDuration')) * 1000) }))
}
await wait(1000)
await shot('0-rest')
console.log(JSON.stringify({ label: 'rest', ...layerStats(), ...(await metrics()), scale: await scale() }))

// the honest "many frames on screen" phases: a pan at the FIT scale (every frame visible), then at ~0.2
await traced('pan-at-fit', async () => { for (let i = 0; i < 30; i++) { await wheel(40, 30); await wait(16) } })
await wait(2500)
await traced('pan-at-fit-2', async () => { for (let i = 0; i < 30; i++) { await wheel(-40, -30); await wait(16) } })
await wait(1000)
await traced('pan-at-fit-3', async () => { for (let i = 0; i < 30; i++) { await wheel(40, 30); await wait(16) } })
await traced('zoom-to-0.2', async () => { for (let i = 0; i < 40 && (await scale()) < 0.2; i++) { await wheel(0, -30, true); await wait(30) } })
await wait(500)
await traced('pan-at-0.2', async () => { for (let i = 0; i < 30; i++) { await wheel(60, 40); await wait(16) } })
await traced('zoom-to-0.5', async () => { for (let i = 0; i < 40 && (await scale()) < 0.5; i++) { await wheel(0, -60, true); await wait(30) } })
await wait(500); await shot('1-zoomed')
await traced('pan-at-0.5', async () => { for (let i = 0; i < 30; i++) { await wheel(0, 60); await wait(16); if (i === 10) await shot('2-pan-a'); if (i === 20) await shot('2-pan-b') } })
await wait(500); await shot('2-pan-end')
await traced('pan-back-fast', async () => { for (let i = 0; i < 30; i++) { await wheel(0, -120); await wait(16) } })
await traced('zoom-to-1', async () => { for (let i = 0; i < 60 && (await scale()) < 1; i++) { await wheel(0, -60, true); await wait(30) } })
await wait(500); await shot('3-zoom1')
await traced('pan-at-1', async () => { for (let i = 0; i < 30; i++) { await wheel(80, 60); await wait(16); if (i === 15) await shot('4-pan1') } })
await wait(800); await shot('5-end')
console.log(JSON.stringify({ label: 'end', ...layerStats(), ...(await metrics()), scale: await scale() }))
off()
b.close()
