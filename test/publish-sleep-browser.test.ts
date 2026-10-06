import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { findChrome } from '../src/server/cdp.ts'

/**
 * Textures at publish time (spec 16, published canvases): `marver build` compiles the published
 * frames' glass against the built site and ships the textures; the static shell reads one index and
 * sleeps its frames under them - pixel-identical to the same frames live, measured in a real browser
 * against a real `marver serve`. A frame the compiler refuses rests with the pause alone.
 */

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const PORT = 4798
const ORIGIN = `http://localhost:${PORT}`
let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let tab = ''

const GLASS = `export const meta = { title: 'Glass' }
export default () => (
  <main>
    <style>{\`
      html, body, main { margin: 0; min-height: 100vh }
      main { position: relative; background: linear-gradient(135deg, #ff7a59 0%, #7b61ff 45%, #19c2a0 100%); font: 600 18px system-ui }
      .g { position: absolute; padding: 18px; border-radius: 16px; color: #123; background: rgba(255,255,255,.35); border: 1px solid rgba(255,255,255,.5);
           backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px) }
      [data-theme="dark"] main { background: linear-gradient(135deg, #1b1f3a 0%, #3a1b4d 50%, #0d3b3b 100%) }
      [data-theme="dark"] .g { background: rgba(0,0,0,.35); color: #eee; border-color: rgba(255,255,255,.2) }
    \`}</style>
    <div className="g glass" style={{ left: 40, top: 40, width: 300 }}>Past due</div>
    <div className="g" style={{ left: 40, top: 160, width: 420 }}>Lane first</div>
    <div className="g" style={{ left: 380, top: 90, width: 260 }}>Chase dispatch</div>
    <div className="g" style={{ left: 60, top: 380, width: 300, mixBlendMode: 'multiply' }}>Blended: stays live</div>
  </main>
)
`
const PLAIN = `export const meta = { title: 'Plain' }
export default () => <main style={{ margin: 0, padding: 24, font: '16px system-ui' }}><h1 style={{ margin: 0 }}>Plain</h1><p>no glass here</p></main>
`

beforeAll(async () => {
  if (!findChrome()) return
  root = mkdtempSync(join(tmpdir(), 'mv-pubsleep-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pubsleep-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules'), nm = join(root, 'node_modules')
  mkdirSync(nm)
  // .vite stays out: each fixture's dev server keeps its own dependency cache - a shared one is rewritten
  // by a parallel suite's server while this one's page loads a lazy engine (mermaid, echarts) from it
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite') symlinkSync(join(repoNm, e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  const scenes = join(root, 'design', 'scenes', 'app')
  mkdirSync(scenes, { recursive: true })
  writeFileSync(join(scenes, 'glass.tsx'), GLASS)
  writeFileSync(join(scenes, 'plain.tsx'), PLAIN)
  // an html frame with glass: published at an opaque path, stamped with the generation like the tsx host
  writeFileSync(join(scenes, 'page.html'), `<!doctype html><html><head><meta name="viewport" content="width=400"><style>html,body{margin:0;height:300px;background:linear-gradient(135deg,#f80,#08f)}.g{position:absolute;left:40px;top:40px;width:200px;height:60px;border-radius:12px;background:rgba(255,255,255,.35);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}</style></head><body><div class="g"></div></body></html>`)
  // the host stylesheet declares both forms, the way shadcn/Tailwind projects do: the published
  // stylesheet must keep the standard one (css-fix.ts) - this rule wins over the inline .g one
  writeFileSync(join(root, 'design', 'theme.css'), `.g.glass { backdrop-filter: blur(6px) saturate(1.3); -webkit-backdrop-filter: blur(6px) saturate(1.3); }\n`)
  const boards = join(root, 'design', 'boards')
  mkdirSync(boards, { recursive: true })
  writeFileSync(join(boards, 'main.json'), JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
    { key: 'g1', frame: 'app/glass', x: 0, y: 0, w: 800, h: 500 },
    { key: 'p1', frame: 'app/plain', x: 900, y: 0, w: 400, h: 300 },
    { key: 'h1', frame: 'app/page', x: 0, y: 600, w: 400, h: 300 },
  ] }))
  writeFileSync(join(root, 'design', 'publish.json'), JSON.stringify({ version: 2, boards: { main: 'comment' } }))
  const out = execFileSync(process.execPath, [CLI, 'build', '--root', root], { stdio: 'pipe', encoding: 'utf8' })
  ;(globalThis as { __buildOut?: string }).__buildOut = out
  server = spawn(process.execPath, [CLI, 'serve', '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, MARVER_DATA_DIR: '', MARVER_PASSWORD: '', MARVER_ID_ISSUER: '' } })
  server.stderr?.on('data', (d) => { (globalThis as { __serverErr?: string }).__serverErr = ((globalThis as { __serverErr?: string }).__serverErr ?? '') + d })
  server.stdout?.on('data', (d) => { (globalThis as { __serverErr?: string }).__serverErr = ((globalThis as { __serverErr?: string }).__serverErr ?? '') + d })
  await new Promise((r) => setTimeout(r, 800))
  browser = await Browser.launch()
  tab = await browser!.tab()
  await browser!.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }, tab)
}, 300_000)

afterAll(() => {
  browser?.close()
  try { server?.kill('SIGTERM') } catch { /* gone */ }
  if (root) rmSync(root, { recursive: true, force: true })
})

const skippable = (name: string, fn: () => Promise<void>, ms = 120_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)
const ev = (expr: string) => browser!.eval(tab, expr)
const until = (expr: string, ms = 60_000) => browser!.until(tab, expr, ms)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const DOC = `document.querySelector('iframe.sh-live[title="app/glass"]')?.contentDocument`
const ASLEEP = `!!${DOC}?.getElementById('mv-sleep')`
const TEXTURES = `(${DOC}?.querySelectorAll('[data-mv-sleep]').length ?? -1)`
const LIVE_FILTERS = `[...(${DOC}?.querySelectorAll('*') ?? [])].filter((e) => { const v = getComputedStyle(e).backdropFilter; return v && v !== 'none' }).length`

/** Open the board and wait for both frames to rest: asleep (a style in each), or, awake, simply ready. */
async function open(q = ''): Promise<void> {
  await browser!.go(tab, `${ORIGIN}/${q}#/b/main`)
  const rested = q.includes('awake')
    ? `[...document.querySelectorAll('iframe.sh-live')].length === 3 && [...document.querySelectorAll('iframe.sh-live')].every((f) => f.contentDocument?.body?.children.length) && !document.querySelector('.sh-loading')`
    : `[...document.querySelectorAll('iframe.sh-live')].length === 3 && [...document.querySelectorAll('iframe.sh-live')].every((f) => f.contentDocument?.getElementById('mv-sleep'))`
  try {
    await until(rested, 45_000)
  } catch (e) {
    console.log('DBG', await ev(`JSON.stringify({ nodes: [...document.querySelectorAll('.sh-node')].map((el) => el.className + ' | ' + (el.querySelector('.sh-loading')?.textContent ?? '') + ' | ' + (el.querySelector('.sh-node-head')?.textContent ?? '')), iframes: [...document.querySelectorAll('iframe.sh-live')].map((f) => [f.getAttribute('src'), !!f.contentDocument?.getElementById('mv-sleep'), f.contentDocument?.querySelectorAll('[data-mv-sleep]').length]) })`))
    throw e
  }
  await wait(1500)
}
/** The glass frame's screen pixels (its node, inset from the ring), as PNG base64. */
async function shot(): Promise<string> {
  const r = await ev(`(() => { const r = document.querySelector('iframe.sh-live[title="app/glass"]').getBoundingClientRect(); return { x: r.x + 4, y: r.y + 4, width: r.width - 8, height: r.height - 8 } })()`)
  return (await browser!.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } }, tab)).data
}
async function diff(a: string, b: string): Promise<{ pixels: number; gt8: number; maxd: number }> {
  return ev(`(async () => {
    const load = (d) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = 'data:image/png;base64,' + d })
    const [ia, ib] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})])
    const px = (im) => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0); return g.getImageData(0, 0, c.width, c.height).data }
    const A = px(ia), B = px(ib); let gt8 = 0, maxd = 0
    for (let i = 0; i < A.length; i += 4) { const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i+1] - B[i+1]), Math.abs(A[i+2] - B[i+2])); if (d > 8) gt8++; if (d > maxd) maxd = d }
    return { pixels: A.length / 4, gt8, maxd }
  })()`)
}

describe('textures at publish time, in a real published browser', () => {
  skippable('the build compiles every published node in every theme and ships an index of what certified', async () => {
    const out = (globalThis as { __buildOut?: string }).__buildOut ?? ''
    expect(out).toMatch(/textures: 4 frame views asleep under certified glass, 0 with live glass, 2 without effects \(6 asked/)
    const bakes = join(root, 'design', '.dist', '__mv', 'bakes')
    const gens = readdirSync(bakes)
    expect(gens).toHaveLength(1)
    const index = JSON.parse(readFileSync(join(bakes, gens[0], 'index.json'), 'utf8'))
    expect(String(index.gen)).toBe(gens[0])
    expect(Object.keys(index.answers).sort()).toEqual(['app/glass|dark|800|500', 'app/glass|light|800|500', 'app/page|dark|400|300', 'app/page|light|400|300'])
    const light = index.answers['app/glass|light|800|500'].targets
    expect(light).toHaveLength(3)   // the certified ones only: the blended one ships nothing, not even its selector
    expect(light.every((t: { verified: boolean }) => t.verified)).toBe(true)
    for (const t of light) expect(existsSync(join(root, 'design', '.dist', t.texture))).toBe(true)
    const shipped = readdirSync(join(bakes, gens[0]), { recursive: true }) as string[]
    expect(shipped.filter((f) => !f.endsWith('.png') && !f.endsWith('index.json') && f.includes('.')), 'only textures and the index ship').toEqual([])
    expect(shipped.filter((f) => f.endsWith('.png'))).toHaveLength(8)
    // the html frame, copied to its opaque path, carries the generation too
    const opaque = readdirSync(join(root, 'design', '.dist', '__mv', 'f')).filter((f) => f.endsWith('.html'))
    expect(opaque).toHaveLength(1)
    expect(readFileSync(join(root, 'design', '.dist', '__mv', 'f', opaque[0]), 'utf8')).toContain(`<meta name="mv-bakes" content="${gens[0]}">`)
    expect(existsSync(join(root, 'design', '.local', 'bakes', gens[0])), 'the build cleans its own cache generation').toBe(false)
    // the published stylesheet kept its glass: both declarations, in the extracted asset
    const css = readdirSync(join(root, 'design', '.dist', 'assets')).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(root, 'design', '.dist', 'assets', f), 'utf8')).join('\n')
    expect(css).toMatch(/-webkit-backdrop-filter:\s*blur\(6px\) saturate\(1\.3\)/)
    expect(css).toMatch(/(^|[^-])backdrop-filter:\s*blur\(6px\) saturate\(1\.3\)/)
    // and the frame document names the generation it was built with
    const frameHtml = readFileSync(join(root, 'design', '.dist', '__mv', 'frame', 'index.html'), 'utf8')
    expect(frameHtml).toContain(`<meta name="mv-bakes" content="${gens[0]}">`)
  })
  skippable('the published frame sleeps under its three textures, its blended glass live; ?awake=1 keeps everything live', async () => {
    await open()
    expect(await ev(ASLEEP)).toBe(true)
    expect(await ev(TEXTURES)).toBe(3)
    expect(await ev(LIVE_FILTERS)).toBe(1)
    // the html frame too: one texture, under a document that names the generation
    expect(await ev(`document.querySelector('iframe.sh-live[title="app/page"]').contentDocument.querySelectorAll('[data-mv-sleep]').length`)).toBe(1)
    expect(await ev(`document.querySelector('iframe.sh-live[title="app/page"]').contentDocument.querySelector('meta[name="mv-bakes"]')?.content`)).toBeTruthy()
    // the host stylesheet's glass rule applies in the published frame (its standard declaration survived the build)
    await open('?awake=1')
    expect(await ev(`getComputedStyle(${DOC}.querySelector('.glass')).backdropFilter`)).toBe('blur(6px) saturate(1.3)')
    await open('?awake=1')
    expect(await ev(TEXTURES)).toBe(0)
    expect(await ev(LIVE_FILTERS)).toBe(4)
  })
  /** 100 % on the pixel grid, the same camera for both loads: a live effect layer snaps to the device
   *  grid and the sleeping paint does not, so at a fractional camera an element's edge rows differ
   *  (the dev suite measures that residual apart); the identity is read on the grid. */
  async function grid(): Promise<void> {
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 500, deltaX: 0, deltaY: -1, modifiers: 2 }, tab)
    await wait(200)
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit0', key: ')', shiftKey: true, bubbles: true }))`)
    await wait(700)
    const [tx, ty] = (await ev(`(() => { const cs = getComputedStyle(document.querySelector('.sh-app')); return [parseFloat(cs.getPropertyValue('--sh-tx')), parseFloat(cs.getPropertyValue('--sh-ty'))] })()`)) as number[]
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 500, deltaX: tx - Math.round(tx), deltaY: ty - Math.round(ty) }, tab)
    await wait(700)
    expect(await ev(`getComputedStyle(document.querySelector('.sh-app')).getPropertyValue('--sh-s')`)).toBe('1')
  }
  skippable('identity: the published frame asleep and live are the same pixels', async () => {
    await open('?awake=1')
    await grid()
    const live = await shot()
    await open()
    await grid()
    await until(`${ASLEEP} && ${TEXTURES} === 3`, 30_000)   // the zoom is a camera move: the frame sleeps on, but wait for it in any case
    await wait(700)
    const asleep = await shot()
    const d = await diff(live, asleep)
    expect(d.pixels).toBeGreaterThan(400_000)
    expect(d.maxd, JSON.stringify(d)).toBeLessThanOrEqual(32)
    expect(d.gt8, JSON.stringify(d)).toBeLessThanOrEqual(d.pixels * 0.0001)   // one pixel in ten thousand, as the dev suite
  })
  skippable("a theme flip sleeps the frame again under the other theme's textures", async () => {
    await open()
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }))`)
    await until(`${DOC}?.documentElement.getAttribute('data-theme') === 'dark' && ${ASLEEP} && ${TEXTURES} === 3`, 30_000)
    expect(await ev(`${DOC}.getElementById('mv-sleep').textContent.includes('/__mv/bakes/')`)).toBe(true)
  })
})
