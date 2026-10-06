import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Sleep in place (spec 16) on a real dev canvas: a glass frame sleeps under certified textures, a
 * plain frame sleeps without ever asking the server, and the one document per frame is the same
 * document awake and asleep - measured as pixels, at DPR 2, through every transition the canvas
 * has: interact, laser, theme, resize, an edit (HMR), a board switch.
 */

const PORT = 5700 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const ORIGIN = `http://localhost:${PORT}`

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let log = ''
let tab = ''

const GLASS = (label: string) => `export const meta = { title: 'Glass' }
export default () => (
  <main>
    <style>{\`
      html, body, main { margin: 0; min-height: 100vh }
      main { position: relative; background: linear-gradient(135deg, #ff7a59 0%, #7b61ff 45%, #19c2a0 100%); font: 600 18px system-ui }
      .g { position: absolute; padding: 18px; border-radius: 16px; color: #123; background: rgba(255,255,255,.35); border: 1px solid rgba(255,255,255,.5);
           backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px) }
      [data-theme="dark"] main { background: linear-gradient(135deg, #1b1f3a 0%, #3a1b4d 50%, #0d3b3b 100%) }
      [data-theme="dark"] .g { background: rgba(0,0,0,.35); color: #eee; border-color: rgba(255,255,255,.2) }
      .g.imp { transition: backdrop-filter .6s, background-color .6s !important }
    \`}</style>
    <div className="g" style={{ left: 40, top: 40, width: 300 }}>${label}</div>
    <div className="g" style={{ left: 40, top: 160, width: 420 }}>Lane first</div>
    <div className="g" style={{ left: 380, top: 90, width: 260 }}>Chase dispatch</div>
    <div className="g" id="longhand" style={{ left: 480, top: 300, width: 260, transitionProperty: 'backdrop-filter, background-color, filter', transitionDuration: '.6s' }}>Dispatch now</div>
    <div className="g imp" style={{ left: 60, top: 380, width: 300 }}>Important motion</div>
  </main>
)
`
const PLAIN = `export const meta = { title: 'Plain' }
export default () => <main style={{ margin: 0, padding: 24, font: '16px system-ui' }}><h1 style={{ margin: 0 }}>Plain</h1><p>no glass here</p></main>
`

const glassFile = () => join(root, 'design', 'scenes', 'app', 'glass.tsx')
const bakeLines = () => log.split('\n').filter((l) => l.includes('bake:'))
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-sleep-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sleep-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..')
  const repoNm = join(repoRoot, 'node_modules')
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  // .vite stays out: each fixture's dev server keeps its own dependency cache - a shared one is rewritten
  // by a parallel suite's server while this one's page loads a lazy engine (mermaid, echarts) from it
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite') symlinkSync(join(repoNm, e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  const scenes = join(root, 'design', 'scenes', 'app')
  mkdirSync(scenes, { recursive: true })
  writeFileSync(glassFile(), GLASS('Past due'))
  writeFileSync(join(scenes, 'plain.tsx'), PLAIN)
  const boards = join(root, 'design', 'boards')
  mkdirSync(boards, { recursive: true })
  writeFileSync(join(boards, 'main.json'), JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
    { key: 'g1', frame: 'app/glass', x: 0, y: 0, w: 800, h: 500 },
    { key: 'p1', frame: 'app/plain', x: 900, y: 0, w: 400, h: 300 },
  ] }))
  writeFileSync(join(boards, 'other.json'), JSON.stringify({ version: 1, name: 'other', order: 1, auto: false, nodes: [
    { key: 'p2', frame: 'app/plain', x: 0, y: 0, w: 400, h: 300 },
  ] }))
  // a board of many frames: admission boots a few at a time, nearest the viewport centre first
  writeFileSync(join(boards, 'many.json'), JSON.stringify({ version: 1, name: 'many', order: 2, auto: false, nodes:
    Array.from({ length: 12 }, (_, i) => ({ key: `m${i}`, frame: 'app/plain', x: (i % 4) * 500, y: Math.floor(i / 4) * 400, w: 400, h: 300 })) }))
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000) {
    const ok = await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)
    if (ok) break
    await wait(200)
  }
  browser = await Browser.launch()
  if (browser) {
    tab = await browser.tab()
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false }, tab)
  }
}, 120_000)

afterAll(() => {
  browser?.close()
  try { server?.kill('SIGTERM') } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true })
})

const skippable = (name: string, fn: () => Promise<void>, ms = 120_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)

// ---- page-side helpers (strings evaluated in the shell)
const DOC = (frame: string) => `document.querySelector('iframe.sh-live[title="${frame}"]')?.contentDocument`
const ASLEEP = (frame: string) => `!!${DOC(frame)}?.getElementById('mv-sleep')`
const TEXTURES = (frame: string) => `(${DOC(frame)}?.querySelectorAll('[data-mv-sleep]').length ?? -1)`
const TEXTURE_URLS = (frame: string) => `Array.from((${DOC(frame)}?.getElementById('mv-sleep')?.textContent ?? '').matchAll(/url\\("([^"]+)"\\)/g)).map((m) => m[1])`
const NODE = (key: string) => `window.__mvStore.getState().nodes.find((n) => n.key === '${key}')`
const ST = `window.__mvStore.getState()`
const ev = (expr: string) => browser!.eval(tab, expr)
const until = (expr: string, ms = 60_000) => browser!.until(tab, expr, ms)
/** The main board, loaded and ready (each test can run alone). */
async function onBoard(): Promise<void> {
  if (await ev(`location.hash === '#/b/main' && !!window.__mvStore`)) return
  await browser!.go(tab, `${ORIGIN}/#/b/main`)
  await until(`${ST}.nodes.length === 2 && ${ST}.nodes.every((n) => n.status === 'ready')`)
}
/** A reload: a fresh, pristine document (an interacted frame is dirty until then). */
async function reloadGlass(): Promise<void> {
  await ev(`(() => { ${ST}.reloadFrame('g1'); const f = document.querySelector('iframe.sh-live[title="app/glass"]'); f.src = f.src; return 1 })()`)
  await until(`${NODE('g1')}.status === 'ready'`)
}
/** At rest on the main board: both frames asleep (a frame left dirty by an earlier test is reloaded). */
async function rested(): Promise<void> {
  await onBoard()
  const whole = `${ASLEEP('app/glass')} && ${TEXTURES('app/glass')} === 5`
  if (!(await ev(whole))) { await wait(1500); if (!(await ev(whole))) await reloadGlass() }
  await bothAsleep()
}
const bothAsleep = () => until(`${ASLEEP('app/glass')} && ${TEXTURES('app/glass')} === 5 && ${ASLEEP('app/plain')} && ${TEXTURES('app/plain')} === 0`, 90_000)

/** A screenshot of the glass frame's own box - inset 24 px so no ring, outline or handle of the
 *  node's own chrome takes part, right of the side panel and below the toolbar - at DPR 2. */
async function shotGlass(): Promise<string> {
  const r = await ev(`(() => { const r = document.querySelector('iframe.sh-live[title="app/glass"]').getBoundingClientRect(); const p = document.querySelector('.sh-panel')?.getBoundingClientRect(); const x = Math.max(r.x + 24, (p?.right ?? 0) + 12), y = Math.max(r.y + 24, 70); return { x, y, width: r.right - 24 - x, height: r.bottom - 24 - y } })()`)
  return (await browser!.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } }, tab)).data
}
/** Per-pixel comparison of two PNGs, in the page (a canvas), the way research/hifi/identity.ts does. */
async function diff(a: string, b: string): Promise<{ pixels: number; diff: number; gt2: number; gt8: number; gt32: number; maxd: number; box: number[] }> {
  return ev(`(async () => {
    const load = (d) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = 'data:image/png;base64,' + d })
    const [ia, ib] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})])
    const px = (im) => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0); return g.getImageData(0, 0, c.width, c.height).data }
    const da = px(ia), db = px(ib)
    let diff = 0, gt2 = 0, gt8 = 0, gt32 = 0, maxd = 0
    const box = [1e9, 1e9, -1, -1]
    for (let i = 0; i < da.length; i += 4) { const d = Math.max(Math.abs(da[i]-db[i]), Math.abs(da[i+1]-db[i+1]), Math.abs(da[i+2]-db[i+2])); if (d) { diff++; const p = i / 4, x = p % ia.width, y = (p - x) / ia.width; box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y) } if (d > 2) gt2++; if (d > 8) gt8++; if (d > 32) gt32++; if (d > maxd) maxd = d }
    return { pixels: da.length / 4, diff, gt2, gt8, gt32, maxd, box }
  })()`)
}
/** A plain wheel over the canvas pans by (dx, dy) CSS px. */
const wheel = (dx: number, dy: number) => browser!.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 500, deltaX: dx, deltaY: dy }, tab)
/** Pin the camera to whole CSS pixels. A live effect layer snaps to the device grid; the sleeping
 *  paint sits at its true position - at a fractional camera the two differ on an element's edge
 *  rows (measured below), so the identity of the pixels inside is read on the grid. */
async function pinCamera(): Promise<void> {
  const [tx, ty] = (await ev(`(() => { const cs = getComputedStyle(document.querySelector('.sh-app')); return [parseFloat(cs.getPropertyValue('--sh-tx')), parseFloat(cs.getPropertyValue('--sh-ty'))] })()`)) as number[]
  await wheel(tx - Math.round(tx), ty - Math.round(ty))
  await wait(400)
}
const key = async (code: string, modifiers = 0) => {
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code.replace('Digit', ''), modifiers }, tab)
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Digit', ''), modifiers }, tab)
}

describe('sleep in place, on a real dev canvas', () => {
  skippable('a glass frame sleeps under three certified textures; a plain frame sleeps without asking the server', async () => {
    await browser!.go(tab, `${ORIGIN}/#/b/main`)
    await until(`${ST}.nodes.length === 2 && ${ST}.nodes.every((n) => n.status === 'ready')`)
    await bothAsleep()
    const lines = bakeLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/bake: app\/glass light 800x500 - 5 effects, 0 stay live/)
    const urls: string[] = await ev(TEXTURE_URLS('app/glass'))
    expect(urls).toHaveLength(5)
    for (const u of urls) expect(u).toMatch(/^\/__mv\/bakes\/\d+\/[0-9a-f]{16}\/\d+\.png$/)
    // the sleeping document is the live one: the pause rule and the overrides are one <style>, nothing else changed
    expect(await ev(`${DOC('app/glass')}.querySelectorAll('#mv-sleep').length`)).toBe(1)
    expect(await ev(`${DOC('app/glass')}.body.querySelectorAll('.g').length`)).toBe(5)
  })

  skippable('the compile endpoint: owner-gated, validated, cached, and its textures are immutable files', async () => {
    const post = (body: unknown, withToken = true) => ev(`fetch('/__mv/api/bakes', { method: 'POST', headers: { 'content-type': 'application/json', ...(${withToken} ? { 'x-mv-c': document.cookie.match(/(?:^|; )mv_c=([^;]+)/)?.[1] ?? '' } : {}) }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`)
    expect((await post({ asks: [{ frame: 'app/glass', theme: 'light', w: 800, h: 500 }] }, false)).status).toBe(403)
    expect((await post({ asks: [{ frame: 'nope/none', theme: 'light', w: 800, h: 500 }] })).status).toBe(400)
    expect((await post({ asks: [{ frame: 'app/glass', theme: '../x', w: 800, h: 500 }] })).status).toBe(400)
    expect((await post({ asks: [{ frame: 'app/glass', theme: 'light', w: 20, h: 500 }] })).status).toBe(400)
    expect((await post({ asks: [] })).status).toBe(400)
    expect((await post(null)).status).toBe(400)
    expect((await post({ asks: [{ frame: 'app/glass', theme: 'light', w: 3840, h: 16384 }] })).status).toBe(400)   // beyond the bitmap budget
    const r = await post({ asks: [{ frame: 'app/glass', theme: 'light', w: 800, h: 500 }] })
    expect(r.status).toBe(200)
    const a = r.body.answers[0]
    expect(a).toMatchObject({ frame: 'app/glass', theme: 'light', w: 800, h: 500, ok: true, ms: 0 })   // ms 0: the cache answered
    expect(a.targets.filter((t: { verified: boolean }) => t.verified)).toHaveLength(5)
    const tex = await ev(`fetch(${JSON.stringify(a.targets[0].texture)}).then((r) => ({ status: r.status, cc: r.headers.get('cache-control'), type: r.headers.get('content-type') }))`)
    expect(tex).toMatchObject({ status: 200, type: 'image/png' })
    expect(tex.cc).toMatch(/immutable/)
    expect(await ev(`fetch('/__mv/bakes/${r.body.gen}/deadbeefdeadbeef/0.png').then((r) => r.status)`)).toBe(404)
    expect(await ev(`fetch('/__mv/bakes/${r.body.gen}/../../manifest.json').then((r) => r.status)`)).toBe(404)
  })

  skippable('identical asks compile once: duplicates inside a request and two requests in flight share the compile', async () => {
    const post = (body: unknown) => ev(`fetch('/__mv/api/bakes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': document.cookie.match(/(?:^|; )mv_c=([^;]+)/)?.[1] ?? '' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`)
    const a = { frame: 'app/glass', theme: 'light', w: 640, h: 400 }
    const [r1, r2] = await Promise.all([post({ asks: [a, a] }), post({ asks: [a] })])
    for (const r of [r1, r2]) { expect(r.status).toBe(200); for (const x of r.body.answers) expect(x.ok).toBe(true) }
    expect(r1.body.answers).toHaveLength(2)
    expect(bakeLines().filter((l) => l.includes('app/glass light 640x400'))).toHaveLength(1)
  })

  skippable('neither the sleep nor the wake starts an authored transition, and inline transition longhands survive both', async () => {
    await onBoard()
    await reloadGlass()
    await bothAsleep()   // polled every 100 ms: an authored .6s transition would still be running
    const running = `[...${DOC('app/glass')}.querySelectorAll('.g')].reduce((n, e) => n + e.getAnimations().length, 0)`
    const longhand = `(() => { const st = ${DOC('app/glass')}.getElementById('longhand').style; return st.transitionDuration + ' | ' + st.transitionProperty })()`
    expect(await ev(running), 'a transition ran into the sleep').toBe(0)
    expect(await ev(longhand)).toBe('0.6s | backdrop-filter, background-color, filter')
    await ev(`${ST}.setInteract('g1')`)
    await until(`!${ASLEEP('app/glass')}`, 5_000)
    expect(await ev(running), 'a transition ran out of the sleep').toBe(0)
    expect(await ev(longhand)).toBe('0.6s | backdrop-filter, background-color, filter')
    expect(await ev(`${DOC('app/glass')}.querySelectorAll('[style*="transition-property: none"]').length`)).toBe(0)
    await ev(`${ST}.setInteract(null)`)
    await reloadGlass()   // interacted = dirty; the next test wants the board at rest
    await bothAsleep()
  })

  skippable('identity: the frame asleep, awake in interact, still awake after leaving interact, and asleep again after a reload - the same pixels', async () => {
    await onBoard()
    // shift+0 = 100 %, dispatched in the shell document (the browser's keyboard focus stays inside
    // a frame an earlier interact entered), after one wheel tick: the camera library ignores an
    // animated setTransform while it still holds an earlier animation's state
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 500, deltaX: 0, deltaY: -1, modifiers: 2 }, tab)
    await wait(200)
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit0', key: ')', shiftKey: true, bubbles: true }))`)
    await wait(700)
    expect(await ev(`getComputedStyle(document.querySelector('.sh-app')).getPropertyValue('--sh-s')`)).toBe('1')
    await pinCamera()
    await bothAsleep()
    const asleep = await shotGlass()
    await ev(`${ST}.setInteract('g1')`)
    await until(`!${ASLEEP('app/glass')}`, 5_000)
    const awakeEarly = await shotGlass()   // within the first frames of the wake
    await wait(700)                          // longer than the authored .6s transitions (one of them !important)
    const awake = await shotGlass()
    expect((await diff(awakeEarly, awake)).gt2, 'the wake ran an authored transition').toBe(0)   // gt2: GPU dither is 1 level
    await ev(`${ST}.setInteract(null)`)
    await wait(1500)
    expect(await ev(ASLEEP('app/glass'))).toBe(false)   // interacted = dirty: stays awake until reloaded
    const stillAwake = await shotGlass()
    const control = await diff(awake, stillAwake)
    expect(control, 'awake vs still awake ' + JSON.stringify(control)).toMatchObject({ gt2: 0 })
    const d = await diff(awake, asleep)
    if (process.env.MV_TEST_DUMP) { mkdirSync(process.env.MV_TEST_DUMP, { recursive: true }); writeFileSync(join(process.env.MV_TEST_DUMP, 'awake.png'), Buffer.from(awake, 'base64')); writeFileSync(join(process.env.MV_TEST_DUMP, 'asleep.png'), Buffer.from(asleep, 'base64')) }
    expect(d.pixels).toBeGreaterThan(500_000)   // DPR 2 over the clip
    expect(d.maxd).toBeLessThanOrEqual(32)
    expect(d.gt8, 'awake vs asleep ' + JSON.stringify(d)).toBeLessThanOrEqual(d.pixels * 0.0001)   // one pixel in ten thousand
    // a reload is a fresh, pristine document: it sleeps again
    await reloadGlass()
    await bothAsleep()
    const again = await shotGlass()
    expect((await diff(asleep, again)).gt2).toBe(0)
    // the residual, at a fractional camera: the wake moves an element's edge rows by the fraction
    // Chrome's layer snapping took away - never a pixel inside, never more than 32 levels
    await wheel(0.5, 0.5)
    await wait(700)
    const asleepFrac = await shotGlass()
    await ev(`${ST}.setInteract('g1')`)
    await until(`!${ASLEEP('app/glass')}`, 5_000)
    await wait(700)
    const awakeFrac = await shotGlass()
    await ev(`${ST}.setInteract(null)`)
    const f = await diff(awakeFrac, asleepFrac)
    expect(f.maxd, 'fractional camera ' + JSON.stringify(f)).toBeLessThanOrEqual(32)
    expect(f.gt8, 'fractional camera ' + JSON.stringify(f)).toBeLessThanOrEqual(f.pixels * 0.005)
  })

  skippable('a document that reloads itself (same iframe, same window) is pristine again and sleeps', async () => {
    await rested()
    await ev(`${ST}.setInteract('g1')`)
    await until(`!${ASLEEP('app/glass')}`, 5_000)
    await ev(`${ST}.setInteract(null)`)
    await wait(1200)
    expect(await ev(ASLEEP('app/glass'))).toBe(false)   // dirty
    await ev(`document.querySelector('iframe.sh-live[title="app/glass"]').contentWindow.location.reload()`)
    await until(`${ASLEEP('app/glass')} && ${TEXTURES('app/glass')} === 5`, 60_000)
  })

  skippable('laser mode and selection act on the sleeping document; they never wake it', async () => {
    await rested()
    await ev(`${ST}.setLaser(true)`)
    await ev(`${ST}.select('g1')`)
    await wait(1000)
    expect(await ev(ASLEEP('app/glass'))).toBe(true)
    await ev(`${ST}.setLaser(false)`)
    await ev(`${ST}.select(null)`)
  })

  skippable('a theme flip wakes, compiles the other theme once the frame has painted it, and sleeps again; flipping back is a cache hit', async () => {
    await rested()
    const light: string[] = await ev(TEXTURE_URLS('app/glass'))
    await ev(`${ST}.setTheme('dark')`)
    await until(`${NODE('g1')}.themeOn === 'dark' && ${ASLEEP('app/glass')} && ${TEXTURES('app/glass')} === 5`, 90_000)
    expect(await ev(`${DOC('app/glass')}.documentElement.dataset.theme`)).toBe('dark')
    const dark: string[] = await ev(TEXTURE_URLS('app/glass'))
    expect(dark).toHaveLength(5)
    expect(dark[0]).not.toBe(light[0])
    expect(bakeLines().filter((l) => l.includes('app/glass dark 800x500'))).toHaveLength(1)
    await ev(`${ST}.setTheme('light')`)
    await until(`${NODE('g1')}.themeOn === 'light' && ${ASLEEP('app/glass')} && ${TEXTURES('app/glass')} === 5`)
    expect(await ev(TEXTURE_URLS('app/glass'))).toEqual(light)
    expect(bakeLines().filter((l) => l.includes('app/glass light 800x500'))).toHaveLength(1)   // still the one compile
  })

  skippable('a resize drag keeps the frame awake for the whole drag and sleeps it again at the new size', async () => {
    await rested()
    await ev(`${ST}.select('g1')`)
    const h = await ev(`(() => { const r = document.querySelector('.sh-node[data-node="g1"] .sh-handle.se').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    const mouse = (type: string, x: number, y: number) => browser!.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1 }, tab)
    await mouse('mousePressed', h.x, h.y)
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', h.x + i * 10, h.y + i * 6); await wait(40) }
    await wait(400)
    expect(await ev(ASLEEP('app/glass'))).toBe(false)
    await mouse('mouseReleased', h.x + 60, h.y + 36)
    await until(`${NODE('g1')}.w > 800 && ${ASLEEP('app/glass')} && ${TEXTURES('app/glass')} === 5`, 90_000)
    const w = await ev(`Math.round(${NODE('g1')}.w)`), hh = await ev(`Math.round(${NODE('g1')}.h)`)
    expect(bakeLines().filter((l) => l.includes(`app/glass light ${w}x${hh}`))).toHaveLength(1)
    await ev(`${ST}.select(null)`)
  })

  skippable('a texture that does not decode leaves the glass live under the pause alone (never an effect stripped of its texture)', async () => {
    await rested()
    const urls: string[] = await ev(TEXTURE_URLS('app/glass'))
    const [, , , gen, key] = urls[0].split('/')
    // the server's cache now names a texture that does not exist (a fresh URL: the browser's own
    // cache would otherwise still hold the old file for a year)
    const meta = join(root, 'design', '.local', 'bakes', gen, key, 'bake.json')
    const bake = JSON.parse(readFileSync(meta, 'utf8'))
    const original = readFileSync(meta, 'utf8')
    bake.targets[0].texture = 'gone.png'
    writeFileSync(meta, JSON.stringify(bake))
    await reloadGlass()
    await until(ASLEEP('app/glass'))                                       // the pause
    expect(await ev(TEXTURES('app/glass'))).toBe(0)                        // no glass overridden
    expect(await ev(`${DOC('app/glass')}.getElementById('mv-sleep').textContent.includes('url(')`)).toBe(false)
    await wait(1500)
    expect(await ev(TEXTURES('app/glass'))).toBe(0)                        // and it stays that way
    writeFileSync(meta, original)
  })

  skippable('an edit (HMR) wakes the frame and compiles the new source under a new generation', async () => {
    await rested()
    const before: string[] = await ev(TEXTURE_URLS('app/glass'))
    const genBefore = before[0].split('/')[3]
    writeFileSync(glassFile(), GLASS('Past due!'))
    await until(`${DOC('app/glass')}?.body.textContent.includes('Past due!') && ${ASLEEP('app/glass')} && ${TEXTURES('app/glass')} === 5`, 90_000)
    const after: string[] = await ev(TEXTURE_URLS('app/glass'))
    expect(after[0].split('/')[3]).not.toBe(genBefore)   // the old generation can never be served again
    expect(await ev(`fetch(${JSON.stringify(before[0])}, { cache: 'no-store' }).then((r) => r.status)`)).toBe(404)   // pruned on the server; the browser cache is beside the point
  })

  skippable('a reload navigates the frame exactly once, and a deleted frame comes back admitted, booted and asleep', async () => {
    await rested()
    const loads = `(() => { const f = document.querySelector('iframe.sh-live[title="app/glass"]'); return f.__loads ?? -1 })()`
    await ev(`(() => { const f = document.querySelector('iframe.sh-live[title="app/glass"]'); f.__loads = 0; f.addEventListener('load', () => f.__loads++); return 1 })()`)
    await ev(`${ST}.reloadFrame('g1', false)`)
    await until(`${NODE('g1')}.status === 'ready' && ${DOC('app/glass')}?.body?.textContent.includes('Past due')`)
    await wait(1500)
    expect(await ev(loads), 'loads after one reload').toBe(1)
    // the file goes: the node shows a card (no iframe); it returns: a new document, admitted, ready, asleep
    const { renameSync } = await import('node:fs')
    renameSync(glassFile(), glassFile() + '.away')
    await until(`${NODE('g1')}.missing === true && !document.querySelector('iframe.sh-live[title="app/glass"]')`, 30_000)
    renameSync(glassFile() + '.away', glassFile())
    await until(`${NODE('g1')}.missing !== true && ${NODE('g1')}.status === 'ready'`, 60_000)
    await bothAsleep()
    expect(await ev(`${ST}.nodes.filter((n) => n.readyRetried).length`)).toBe(0)
  })

  skippable('a board of many frames boots a few at a time, nearest the centre first, every frame navigating once', async () => {
    await onBoard()
    await ev(`window.__mvAdmitted = []; location.hash = '#/b/many'`)
    await until(`${ST}.nodes.length === 12`)
    // while loading, at most SLOTS iframes carry a src (the rest wait, silent by design)
    const withSrc = `[...document.querySelectorAll('iframe.sh-live')].filter((f) => f.getAttribute('src')).length`
    const loading = `${ST}.nodes.filter((n) => n.status === 'loading').length`
    let peak = 0, polls = 0
    const cam: string[] = []
    const t0 = Date.now()
    while (Date.now() - t0 < 4000 && (await ev(loading)) > 0) {
      polls++
      peak = Math.max(peak, (await ev(withSrc)) - (12 - (await ev(loading))))   // iframes with a src that are not ready yet
      if (process.env.MV_TEST_DUMP) cam.push(await ev(`(() => { const cs = getComputedStyle(document.querySelector('.sh-app')); const f = document.querySelector('.sh-node').getBoundingClientRect(); return [performance.now() | 0, ${ST}.nodes.filter((n) => n.status === 'ready').length, cs.getPropertyValue('--sh-tx'), cs.getPropertyValue('--sh-ty'), cs.getPropertyValue('--sh-s'), Math.round(f.x), Math.round(f.y), Math.round(f.width)].join(' ') })()`))
      await wait(40)
    }
    if (process.env.MV_TEST_DUMP) console.log('CAM polls', polls, cam.join(' | '))
    expect(polls, 'the load was observed while in progress').toBeGreaterThan(3)
    expect(peak, 'frames booting at once').toBeLessThanOrEqual(4)
    await until(`${ST}.nodes.every((n) => n.status === 'ready')`, 60_000)
    expect(await ev(`${ST}.nodes.filter((n) => n.readyRetried).length`), 'a queued frame was mistaken for a stalled one').toBe(0)
    expect(await ev(withSrc)).toBe(12)
    // the first frames admitted were the ones nearest the viewport centre (the fit view centres the board)
    const order = JSON.parse(await ev(`JSON.stringify(window.__mvAdmitted)`)) as string[]
    expect(order, 'admitted in order of distance to the centre: ' + order.join(' ')).toHaveLength(12)
    // from the second admission on (the first is ranked while the board's fit still settles), frames
    // went in by distance to the canvas centre, which has not moved since
    const dist = JSON.parse(await ev(`(() => { const c = document.querySelector('.sh-canvas').getBoundingClientRect(); const st = ${ST}
      return JSON.stringify(Object.fromEntries([...document.querySelectorAll('.sh-node')].map((el, i) => { const r = el.getBoundingClientRect(); return [st.nodes[i].key, Math.hypot(r.x + r.width / 2 - c.x - c.width / 2, r.y + r.height / 2 - c.y - c.height / 2)] }))) })()`)) as Record<string, number>
    const seq = order.slice(1).map((k) => dist[k])
    expect(seq.every((d, i) => i === 0 || d >= seq[i - 1] - 1), 'admitted by distance: ' + order.map((k) => k + ':' + Math.round(dist[k])).join(' ')).toBe(true)
    await onBoard()
  })

  skippable('a board switch unmounts cleanly and the frames sleep again on return', async () => {
    await onBoard()
    await ev(`location.hash = '#/b/other'`)
    await until(`${ST}.nodes.length === 1 && ${ASLEEP('app/plain')}`)
    await ev(`location.hash = '#/b/main'`)
    await until(`${ST}.nodes.length === 2 && ${ST}.nodes.every((n) => n.status === 'ready')`)
    await bothAsleep()
  })
})
