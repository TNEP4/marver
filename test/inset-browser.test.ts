import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'

/**
 * The shell under the Mac app's transparent strip (marver 0.27.2; spec 28 A2.9, A3.8 #27, #31), against a REAL
 * `marver dev` and a REAL Chrome whose page gets a fake `window.marverApp` before any script runs - the canvas
 * preload's contract as app 0.2 gives it: `topInset: 44` with `onPresent` and `presented`. Checked: `--mv-top` is
 * 44 px on :root; the sidebar and the toolbar sit at 44 px; a fit leaves the top clear with the toolbar shown and
 * with Hide UI; focus centres a small frame in the view below the strip; the selection bar clamps at 52 px, and a
 * tooltip and a context menu near the top stay at or below it; the scroll edge is opaque ground through 44 px and
 * clear from 60 px, a frame panned under it shown nowhere there; a frame under it is not in Jam's view, and not
 * seen; `mv:hello` says 44; a request is answered after its frames, only at its size, a newer one cancelling an older,
 * and after 500 ms at the size the page has. The other screens (#31's "every screen"): play's stage centred below the
 * strip, its toolbar and brand pills and its chip at 44 px, its ground under the strip, Fill window filling the view
 * below it and the thread card docked no higher than TOP + 12; a Jam session's edge ring below the strip and the focus
 * panel's and the sheet's rules; the stopped banner on the toolbar's line; the identity modal's veil from 44 px. With
 * `topInset: 0`, with 44 but half the contract (no `onPresent`), and with no bridge at all (Chrome): no band, nothing
 * moves, hello says 0. Skips without Chrome.
 */

const FRAME = (t: string, bg: string) => `export const meta = { title: '${t}', viewport: 'mobile' }\nexport default () => <main style={{ background: '${bg}', width: '100%', height: '100vh', margin: 0 }} />\n`
const W = 1400, H = 900

let root = ''
let dev: Dev | null = null
let browser: Browser | null = null
const tabs: string[] = []

beforeAll(async () => {
  root = fixtureRoot('mv-inset-', {
    'design/config.ts': `export default { share: { name: 'Inset canvas' } }\n`,
    'design/scenes/demo/red.tsx': FRAME('Red', '#ff0000'),
    'design/scenes/demo/small.tsx': FRAME('Small', '#2244ff'),
    'design/scenes/demo/far.tsx': FRAME('Far', '#22aa44'),
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
      { key: 'n-red', frame: 'demo/red', x: 0, y: 0, w: 900, h: 600 },
      { key: 'n-small', frame: 'demo/small', x: 1200, y: 0, w: 300, h: 200 },
      { key: 'n-far', frame: 'demo/far', x: 0, y: 1400, w: 390, h: 400 },
    ] }),
  })
  dev = await startDev(root)
  browser = await Browser.launch()
}, 120_000)
afterEach(async () => { for (const s of tabs.splice(0)) await browser?.closeTab(s).catch(() => {}) })
afterAll(async () => {
  browser?.close()
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The fake bridge, at document start. `inset`: what mv:doc answered; `present`: the presentation methods given. */
type Fake = { on: boolean; inset?: 0 | 44; present?: boolean }
const FAKE = (cfg: Fake) => `(() => {
  const cfg = ${JSON.stringify(cfg)}
  // a frame counter of the page's own, for "answered after its frames"
  window.__frames = 0
  const tick = () => { window.__frames++; requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  if (!cfg.on) return
  const log = [], answers = [], presentFns = new Set()
  const say = (ch) => (p) => { log.push([ch, JSON.parse(JSON.stringify(p))]) }
  const api = { v: 1, topInset: cfg.inset ?? 0, reopen: false, hello: say('hello'), theme: say('theme'), busy: say('busy'), menu: say('menu'),
    onAppState: () => () => {}, onMenuClick: () => () => {} }
  if (cfg.present) {
    api.onPresent = (fn) => { presentFns.add(fn); return () => presentFns.delete(fn) }
    api.presented = (p) => { answers.push({ ...JSON.parse(JSON.stringify(p)), at: window.__frames }) }
  }
  window.marverApp = Object.freeze(api)
  window.__fake = {
    log, answers,
    present(r) { const at = window.__frames; for (const fn of presentFns) fn(r); return at },
    listeners: () => presentFns.size,
    last: (ch) => { for (let i = log.length - 1; i >= 0; i--) if (log[i][0] === ch) return log[i][1]; return null },
  }
})()`

async function open(cfg: Fake): Promise<string> {
  const s = await browser!.tab({ width: W, height: H })
  tabs.push(s)
  await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE(cfg) }, s)
  await browser!.go(s, `${dev!.origin}/#/b/main`)
  await browser!.until(s, `!!window.__mvStore && __mvStore.getState().nodes.length === 3 && __mvStore.getState().nodes.every((n) => n.status === 'ready')`, 30_000)
  await browser!.send('Page.bringToFront', {}, s)
  await browser!.until(s, `!__mvJamCanvas.cameraBusy()`, 5000)
  return s
}
const ev = (s: string, js: string) => browser!.eval(s, js)
const until = (s: string, js: string, ms = 10_000) => browser!.until(s, js, ms)
const skip = (ctx: { skip: () => void }) => { if (!browser) ctx.skip() }
const rect = (s: string, sel: string) => ev(s, `(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height } : null })()`)
const nodeRect = (s: string, key: string) => rect(s, `.sh-node[data-node="${key}"]`)
/** pan the camera by screen px (a plain wheel pans by its negative delta) and let it settle */
const pan = async (s: string, dx: number, dy: number) => {
  await ev(s, `__mvJamCanvas.wheel({ deltaX: ${-dx}, deltaY: ${-dy}, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 700, clientY: 450 }), 1`)
  await wait(250)
}
/** move the camera so a node's top-left lands at this screen point */
const place = async (s: string, key: string, x: number, y: number) => {
  const r = await nodeRect(s, key)
  await pan(s, x - r!.left, y - r!.top)
}

/** The viewport's pixels (RGB), decoded from a CDP screenshot at scale 1. */
async function pixels(s: string): Promise<{ w: number; h: number; at(x: number, y: number): [number, number, number] }> {
  const { data } = await browser!.send('Page.captureScreenshot', { format: 'png' }, s)
  const b = Buffer.from(data, 'base64')
  if (process.env.MV_INSET_SHOT) writeFileSync(process.env.MV_INSET_SHOT, b)
  let o = 8, w = 0, h = 0, type = 6
  const idat: Buffer[] = []
  while (o < b.length) {
    const len = b.readUInt32BE(o), t = b.toString('latin1', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len)
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); type = d[9] }
    if (t === 'IDAT') idat.push(d)
    o += 12 + len
  }
  const bpp = type === 6 ? 4 : 3, stride = w * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(h * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, u = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      if (f === 1) line[i] = (line[i] + a) & 255
      else if (f === 2) line[i] = (line[i] + u) & 255
      else if (f === 3) line[i] = (line[i] + ((a + u) >> 1)) & 255
      else if (f === 4) { const p = a + u - c, pa = Math.abs(p - a), pb = Math.abs(p - u), pc = Math.abs(p - c); line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c)) & 255 }
    }
    line.copy(out, y * stride)
    prev = line
  }
  return { w, h, at: (x, y) => { const i = y * stride + x * bpp; return [out[i], out[i + 1], out[i + 2]] } }
}
const red = ([r, g, b]: [number, number, number]) => r > 200 && g < 80 && b < 80

describe('with the whole contract: topInset 44, onPresent and presented (A3.8 #31)', () => {
  it('--mv-top is 44 px on :root; hello says 44; the sidebar and the toolbar sit at 44 px; the scroll edge is there', async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, inset: 44, present: true })
    expect(await ev(s, `[document.documentElement.style.getPropertyValue('--mv-top'), document.documentElement.classList.contains('mv-inset')]`)).toEqual(['44px', true])
    expect((await ev(s, `__fake.last('hello')`)).inset).toBe(44)
    expect((await rect(s, '.sh-panel'))!.top).toBe(44)
    expect((await rect(s, 'nav.sh-pill'))!.top).toBe(44)
    expect(await rect(s, '.sh-edge')).toMatchObject({ top: 0, height: 60 })
    // collapsed, their buttons too
    await ev(s, `window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', code: 'Backslash', metaKey: true, bubbles: true })), 1`)
    await until(s, `!!document.querySelector('.sh-panel.closed')`)
    expect(await ev(s, `getComputedStyle(document.querySelector('.sh-fab')).top`)).toBe('44px')   // (its rect morphs as it grows in)
  })

  it('a fit leaves the top clear with the toolbar shown and with Hide UI; focus centres a small frame below the strip', async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, inset: 44, present: true })
    const top = async () => Math.min(...await Promise.all(['n-red', 'n-small', 'n-far'].map(async (k) => (await nodeRect(s, k))!.top)))
    await ev(s, `__mvJamCanvas.fitAll(), 1`)
    await until(s, `!__mvJamCanvas.cameraBusy()`)
    await wait(100)
    expect(await top()).toBeGreaterThanOrEqual(44 + 44 + 12)        // the toolbar's foot, then the gap and the bar's room
    await ev(s, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', bubbles: true })), 1`)
    await until(s, `document.body.classList.contains('sh-hide-ui')`)
    await ev(s, `__mvJamCanvas.fitAll(), 1`)
    await until(s, `!__mvJamCanvas.cameraBusy()`)
    await wait(100)
    expect(await top()).toBeGreaterThanOrEqual(44 + 12 + 56)        // Hide UI still reserves the strip
    await ev(s, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', bubbles: true })), 1`)
    await ev(s, `__mvJamCanvas.fitNode('n-small'), 1`)
    await until(s, `!__mvJamCanvas.cameraBusy()`)
    await wait(100)
    const r = (await nodeRect(s, 'n-small'))!
    expect(Math.abs((r.top + r.bottom) / 2 - (44 + (H - 44) / 2))).toBeLessThanOrEqual(2)
  })

  it('the selection bar clamps at 52 px; a tooltip and a context menu near the top stay at or below it', async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, inset: 44, present: true })
    await ev(s, `__mvStore.getState().select('n-red'), 1`)
    await until(s, `!!document.querySelector('.sh-ctx')`)
    await place(s, 'n-red', 300, -200)
    await wait(100)
    expect(Math.round((await rect(s, '.sh-ctx'))!.top)).toBe(52)
    // a tip of the bar's (side top, above it): clamped down to 52, never under the strip
    const b = (await rect(s, '.sh-ctx button'))!
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round((b.left + b.right) / 2), y: Math.round((b.top + b.bottom) / 2) }, s)
    await until(s, `!!document.querySelector('.sh-tip')`, 3000)
    await wait(250)
    expect((await rect(s, '.sh-tip'))!.top).toBeGreaterThanOrEqual(52)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 600 }, s)
    // a right-click as near the top as it can come
    await ev(s, `(() => { const row = document.querySelector('.sh-boards'); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 10 })); return 1 })()`)
    await until(s, `!!document.querySelector('.sh-ctxmenu')`, 3000)
    expect(await ev(s, `parseFloat(document.querySelector('.sh-ctxmenu').style.top)`)).toBeGreaterThanOrEqual(52)   // where it is placed (its rect zooms in)
  })

  it('the scroll edge: ground through 44 px, clear from 60 px - a frame panned under it shows nowhere above the band\'s foot', async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, inset: 44, present: true })
    await ev(s, `__mvStore.getState().select(null), __mvJamCanvas.zoomTo(1), 1`)
    await until(s, `!__mvJamCanvas.cameraBusy()`)
    await place(s, 'n-red', 300, -200)            // the red frame runs from above the window down to about 400 px
    await wait(300)
    expect((await nodeRect(s, 'n-red'))!.bottom).toBeGreaterThan(300)
    const p = await pixels(s)
    const row = (y: number) => Array.from({ length: 40 }, (_, i) => p.at(500 + i * 5, y))
    for (const y of [2, 20, 40, 43]) expect(row(y).filter(red), `y ${y}`).toEqual([])
    for (const y of [62, 80, 200]) expect(row(y).every(red), `y ${y}`).toBe(true)
    // the ground under the band is the canvas's own, the band's dots on the canvas's grid
    expect(await ev(s, `getComputedStyle(document.querySelector('.sh-edge')).backgroundColor === getComputedStyle(document.querySelector('.sh-canvas')).backgroundColor`)).toBe(true)
    expect(await ev(s, `getComputedStyle(document.querySelector('.sh-edge'), '::before').backgroundPosition === getComputedStyle(document.querySelector('.sh-canvas'), '::before').backgroundPosition`)).toBe(true)
  })

  it('a frame under the band is not in view: inset.ts\'s onScreen, Jam\'s visible frames', async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, inset: 44, present: true })
    expect(await ev(s, `[__mvInset.TOP, __mvInset.VISIBLE_TOP, __mvInset.usable().top, __mvInset.usable().height]`)).toEqual([44, 60, 44, H - 44])
    expect(await ev(s, `__mvInset.onScreen(new DOMRect(10, 0, 100, 59))`)).toBe(null)
    expect(await ev(s, `(() => { const r = __mvInset.onScreen(new DOMRect(10, 0, 100, 100)); return [r.top, r.height] })()`)).toEqual([60, 40])
    // the small frame panned wholly under the band: not among the frames in view; just below it, it is
    const r = (await nodeRect(s, 'n-small'))!
    await place(s, 'n-small', 600, -(r.bottom - r.top) + 50)
    expect(((await nodeRect(s, 'n-small'))!.bottom)).toBeLessThan(60)
    expect(await ev(s, `__mvJamVisible().map((n) => n.key).includes('n-small')`)).toBe(false)
    await pan(s, 0, 40)
    expect(await ev(s, `__mvJamVisible().map((n) => n.key).includes('n-small')`)).toBe(true)
  })

  it('a frame changed under the band is not seen there; brought below it, it is (the two-second rule)', { timeout: 45_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, inset: 44, present: true })
    await ev(s, `window.__looked = []; (() => { const real = __mvStore.getState().look; __mvStore.setState({ look: (keys) => { window.__looked.push(...keys); return real(keys) } }) })(), 1`)
    await ev(s, `__mvJamCanvas.zoomTo(1), 1`)                // the two-second rule counts at 50 % and closer
    await until(s, `!__mvJamCanvas.cameraBusy() && __mvStore.getState().scale >= 0.5`)
    const r = (await nodeRect(s, 'n-small'))!
    await place(s, 'n-small', 600, -(r.bottom - r.top) + 55)   // its foot 55 px down: under the band's fade
    writeFileSync(join(root, 'design/scenes/demo/small.tsx'), FRAME('Small', '#2244fe'))
    await until(s, `!!__mvStore.getState().marks && Object.keys(__mvStore.getState().marks.changed).includes('demo/small')`, 15_000)
    await until(s, `__mvStore.getState().nodes.find((n) => n.key === 'n-small').status === 'ready'`, 15_000)
    await wait(3000)
    expect(await ev(s, `window.__looked`)).not.toContain('n-small')
    await pan(s, 0, 200)
    await until(s, `window.__looked.includes('n-small')`, 6000)
  })

  it('a request is answered after its frames at the asked size; a newer one cancels an older; a size the page never reaches is answered at its own after 500 ms', async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, inset: 44, present: true })
    expect(await ev(s, `__fake.listeners()`)).toBe(1)
    const at = await ev(s, `__fake.present({ epoch: 7, w: innerWidth, h: innerHeight, frames: 3 })`)
    expect(await ev(s, `__fake.answers.length`)).toBe(0)
    await until(s, `__fake.answers.length === 1`)
    const a = (await ev(s, `__fake.answers[0]`))
    expect([a.epoch, a.w, a.h]).toEqual([7, W, H])
    expect(a.at - at).toBeGreaterThanOrEqual(3)
    // a newer request before the older answers: only the newer is ever answered
    await ev(s, `__fake.present({ epoch: 8, w: innerWidth, h: innerHeight, frames: 8 }), __fake.present({ epoch: 9, w: innerWidth, h: innerHeight, frames: 1 })`)
    await until(s, `__fake.answers.length === 2`)
    await wait(400)
    expect((await ev(s, `__fake.answers.map((x) => x.epoch)`))).toEqual([7, 9])
    // a size the viewport has not reached: it waits, and answers once it has
    await ev(s, `__fake.present({ epoch: 10, w: ${W - 200}, h: ${H}, frames: 2 })`)
    await wait(150)
    expect(await ev(s, `__fake.answers.length`)).toBe(2)
    await browser!.send('Emulation.setDeviceMetricsOverride', { width: W - 200, height: H, deviceScaleFactor: 1, mobile: false }, s)
    await until(s, `__fake.answers.length === 3`)
    expect(await ev(s, `[__fake.answers[2].epoch, __fake.answers[2].w]`)).toEqual([10, W - 200])
    // one it never reaches: after 500 ms, answered at the size the page has (main refuses it, and stays covered)
    const t0 = Date.now()
    await ev(s, `__fake.present({ epoch: 11, w: 333, h: 222, frames: 1 })`)
    await until(s, `__fake.answers.length === 4`)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450)
    expect(await ev(s, `[__fake.answers[3].epoch, __fake.answers[3].w, __fake.answers[3].h]`)).toEqual([11, W - 200, H])
  })
})

/** a layer's own rule at this TOP, without its component: an element of that class where the shell mounts it */
const probeTop = (s: string, cls: string, parent = '.sh-app') => ev(s, `(() => { const d = document.createElement('div'); d.className = ${JSON.stringify(cls)}; document.querySelector(${JSON.stringify(parent)}).appendChild(d); const t = getComputedStyle(d).top; d.remove(); return t })()`)
const dark = ([r, g, b]: [number, number, number]) => r < 30 && g < 30 && b < 30

/** play mode on the red frame, opened from its URL; the fade-in waited for */
async function openPlay(cfg: Fake): Promise<string> {
  const s = await browser!.tab({ width: W, height: H })
  tabs.push(s)
  await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE(cfg) }, s)
  await browser!.go(s, `${dev!.origin}/#/p/main?at=demo/red`)
  await browser!.until(s, `!!window.__mvStore && !!__mvStore.getState().play && !!document.querySelector('.sh-play-stage .dev iframe')`, 30_000)
  await browser!.send('Page.bringToFront', {}, s)
  await wait(600)   // its fade-in
  return s
}

describe('every other screen of the shell at TOP 44 (A3.8 #31: "the builder checks every screen of the shell")', () => {
  it('play: the stage centred below the strip; the toolbar pill, the brand pill and the collapsed chip at 44 px; the play ground under the strip', { timeout: 45_000 }, async (ctx) => {
    skip(ctx)
    const s = await openPlay({ on: true, inset: 44, present: true })
    const st = (await rect(s, '.sh-play-stage'))!
    expect(st.top).toBeGreaterThanOrEqual(44)
    expect(Math.abs((st.top + st.bottom) / 2 - (44 + (H - 44) / 2))).toBeLessThanOrEqual(2)
    // play's chrome is the shared pill (Play.tsx: nav.sh-pill.sh-play-pill, the brand one on the left; .sh-pill-fab)
    expect((await rect(s, '.sh-play > nav.sh-play-pill:not(.sh-play-brand)'))!.top).toBe(44)
    expect((await rect(s, '.sh-play > nav.sh-play-brand'))!.top).toBe(44)
    expect(await ev(s, `getComputedStyle(document.querySelector('.sh-play > .sh-pill-fab')).top`)).toBe('44px')
    const p = await pixels(s)
    for (const y of [2, 20, 40, 43]) expect(Array.from({ length: 40 }, (_, i) => p.at(100 + i * 30, y)).every(dark), `y ${y}`).toBe(true)
  })

  it('play filling the window fills the view below the strip; its thread card docks below the strip, clamped at TOP + 12 px for a pin at the stage\'s top', { timeout: 45_000 }, async (ctx) => {
    skip(ctx)
    const log = join(root, 'design', 'comments', 'main.jsonl')
    mkdirSync(join(root, 'design', 'comments'), { recursive: true })
    const anchor = { el: { semantics: { tag: 'main' }, cssPath: 'main', hue: 200 }, pos: { fx: 0.5, fy: 0 } }
    writeFileSync(log, JSON.stringify({ id: 'inset-e1', ts: Date.now(), type: 'create', commentId: 'inset-c1', board: 'main', frame: 'demo/red', author: { email: 'nic@example.com', name: 'Nic' }, body: 'at the top', anchor }) + '\n')
    try {
      const s = await openPlay({ on: true, inset: 44, present: true })
      // Fill window (the device preset 'fill'): the stage is the view below the strip, edge to edge
      await ev(s, `__mvStore.getState().setPlay({ ...__mvStore.getState().play, device: 'fill' }), 1`)
      await until(s, `!!document.querySelector('.sh-play.fill')`, 5000)
      await wait(300)
      const stage = (await rect(s, '.sh-play-stage'))!
      expect([stage.top, stage.bottom, stage.left, stage.right]).toEqual([44, H, 0, W])
      await until(s, `!!document.querySelector('.sh-play-comments [data-thread="inset-c1"]')`, 20_000)
      await ev(s, `__mvComments.getState().setActive('inset-c1'), 1`)
      await until(s, `!!document.querySelector('.cm-card.stage-dock')`, 5000)
      await wait(100)
      const card = (await rect(s, '.cm-card.stage-dock'))!
      // its top is clamp(the stage's top + the pin's y - 36, TOP + 12, ...): for a pin at the stage's top that is TOP + 12
      // (with no inset it would be 12 px, on the strip's controls)
      expect(Math.abs(card.top - (44 + 12))).toBeLessThanOrEqual(1)
      expect(card.bottom).toBeLessThanOrEqual(H - 12 + 1)
      await ev(s, `__mvComments.getState().setActive(null), 1`)
    } finally { rmSync(log, { force: true }) }
  })

  it('a Jam session\'s edge ring starts below the strip; the focus panel at 44 px; the sheet at 98 px', async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, inset: 44, present: true })
    await ev(s, `__mvJamQueue.setState({ session: { id: 'ses-inset', since: Date.now() } }), 1`)
    await until(s, `!!document.querySelector('.jm-edge')`)
    expect(await rect(s, '.jm-edge')).toMatchObject({ top: 44, bottom: H })
    await ev(s, `__mvJamQueue.setState({ session: null }), 1`)
    // the focus panel and the sheet's anchor, as their rules place them inside the app (each needs a Jam with
    // frames to render; the rule is what the inset changes)
    expect(await probeTop(s, 'jm-focus')).toBe('44px')
    expect(await probeTop(s, 'jm-sheet-at')).toBe('98px')
  })

  it('the stopped banner sits on the toolbar\'s line below the strip, and its fallback before it measures does too', { timeout: 30_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, inset: 44, present: true })
    expect(await probeTop(s, 'sh-banner sh-stopped')).toBe('50px')   // the fallback: 6 px below the strip (the strip's padding is the gap, not the edge)
    await ev(s, `__mvLink.setState({ link: 'down', shown: true }), 1`)
    await until(s, `!!document.querySelector('.sh-stopped')`, 5000)
    await wait(200)
    const b = (await rect(s, '.sh-stopped'))!
    const t = (await rect(s, '.sh-app > nav.sh-pill'))!
    expect(b.top).toBeGreaterThanOrEqual(44)
    expect(Math.abs((b.top + b.bottom) / 2 - (t.top + t.bottom) / 2)).toBeLessThanOrEqual(1)
    await ev(s, `__mvLink.setState({ link: 'live', shown: false }), 1`)
  })

  it('the identity modal\'s veil starts below the strip, leaving the strip\'s controls to it', { timeout: 30_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, inset: 44, present: true })
    await ev(s, `__mvComments.setState({ needsIdentity: true }), 1`)
    await until(s, `!!document.querySelector('.cm-modal-wrap')`, 5000)
    expect(await rect(s, '.cm-modal-wrap')).toMatchObject({ top: 44, bottom: H })
    await ev(s, `__mvComments.getState().dismissIdentity(), 1`)
  })
})

describe('half a contract, or none: nothing moves (A3.8 #31)', () => {
  for (const [name, cfg] of [
    ['topInset 0 (app 0.2 placing it below)', { on: true, inset: 0, present: true }],
    ['topInset 44 with no onPresent (a shell never trusts half a contract)', { on: true, inset: 44, present: false }],
    ['no bridge at all (Chrome)', { on: false }],
  ] as const) {
    it(`${name}: no --mv-top, no band, the chrome at 10 px, hello says 0`, async (ctx) => {
      skip(ctx)
      const s = await open(cfg as Fake)
      expect(await ev(s, `[document.documentElement.style.getPropertyValue('--mv-top'), document.documentElement.classList.contains('mv-inset'), !!document.querySelector('.sh-edge')]`)).toEqual(['', false, false])
      expect((await rect(s, '.sh-panel'))!.top).toBe(10)
      expect((await rect(s, 'nav.sh-pill'))!.top).toBe(10)
      expect(await ev(s, `[__mvInset.TOP, __mvInset.VISIBLE_TOP]`)).toEqual([0, 0])
      if (cfg.on) {
        expect((await ev(s, `__fake.last('hello')`)).inset).toBe(0)
        expect(await ev(s, `__fake.listeners()`)).toBe(0)   // not listening for requests it would never get
      }
      // and every other screen's layer where 0.27.1 had it
      expect([await probeTop(s, 'jm-focus'), await probeTop(s, 'jm-sheet-at'), await probeTop(s, 'sh-banner sh-stopped'), await probeTop(s, 'cm-modal-wrap', 'body')]).toEqual(['10px', '64px', '16px', '0px'])
      expect(await ev(s, `[__mvInset.usable().top, __mvInset.usable().height]`)).toEqual([0, H])
    })
  }
})
