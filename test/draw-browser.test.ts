/**
 * Spec 38 - the drawing frame, end to end: a real `marver dev`, a real Chrome, real files.
 * The canvas's drawing mode (bar, panel, view controls around the frame), drawing with the bar, the person's save,
 * an agent's file edit landing live (no reload, ⌘Z still the person's), W, play, a shot, and a published build.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { CLI, fixtureRoot, startDev, type Dev } from './dev-server.ts'

const el = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id, type: 'rectangle', x, y, width: 180, height: 90, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
  strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 }, seed: 1, version: 1,
  versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, ...extra,
})
const DRAWING = {
  type: 'excalidraw', version: 2, source: 'marver', marver: { rev: 0, title: 'Checkout flow', size: { w: 960, h: 640 } },
  elements: [el('cart', 80, 200, { index: 'a0' }), el('pay', 420, 200, { index: 'a1', seed: 2, versionNonce: 2 })],
  appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {},
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('the drawing frame (spec 38), in a real browser', () => {
  let root = '', dev: Dev | undefined, b: Browser | null = null, s = ''
  const file = () => join(root, 'design/scenes/sketches/flow.excalidraw')
  const disk = () => JSON.parse(readFileSync(file(), 'utf8'))
  beforeAll(async () => {
    root = fixtureRoot('mv-draw-browser-', {
      'design/config.ts': 'export default { jam: false }\n',
      'design/scenes/sketches/home.tsx': "export const meta = { title: 'Home', viewport: 'laptop' }\nexport default () => <main style={{ padding: 40 }}>Home</main>\n",
      'design/scenes/sketches/flow.excalidraw': JSON.stringify(DRAWING),
      'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', auto: false, nodes: [
        { key: 'n_flow', frame: 'sketches/flow', x: 0, y: 0, w: 960, h: 640 },
        { key: 'n_home', frame: 'sketches/home', x: 1100, y: 0, w: 1280, h: 800 },
      ] }),
    })
    dev = await startDev(root)
    b = await Browser.launch()
    if (!b) return
    s = await b.tab({ width: 1440, height: 900 })
  }, 120_000)
  afterAll(async () => {
    if (b && s) await b.closeTab(s).catch(() => {})
    await dev?.stop()
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  // a page reload (Vite's first optimisation) can land mid-eval: retried
  const ev = async (x: string): Promise<any> => { for (let i = 0; i < 8; i++) { try { return await b!.eval(s, x) } catch { await sleep(300) } } throw new Error(`eval kept failing: ${x}`) }
  const until = async (x: string, ms = 20_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(x).catch(() => false)) return true; await sleep(150) } throw new Error(`timed out: ${x}`) }
  const inner = (x: string) => ev(`(() => { const f = document.querySelector('iframe[data-kind="draw"]'); const d = f.contentDocument, w = f.contentWindow; return (${x}) })()`)
  const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
    b!.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra }, s)
  const click = async (x: number, y: number, count = 1) => { await mouse('mousePressed', x, y, { clickCount: count }); await mouse('mouseReleased', x, y, { clickCount: count }) }
  const drag = async (x0: number, y0: number, x1: number, y1: number) => {
    await mouse('mousePressed', x0, y0); await sleep(30)
    for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8); await sleep(20) }
    await sleep(30); await mouse('mouseReleased', x1, y1)
  }
  const rectOf = async (sel: string) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null })()`)
  const escape = async () => {
    const base = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
    await b!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, s)
    await b!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, s)
  }
  const press = (sel: string) => rectOf(sel).then((r: any) => click(r.x + r.w / 2, r.y + r.h / 2))

  it('shows the drawing at rest, live, with its chrome hidden', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    await b.go(s, `${dev!.origin}/#/b/main`)
    await until(`(() => { try { return !!document.querySelector('iframe[data-kind="draw"]').contentWindow.__mvDraw } catch { return false } })()`, 60_000)
    expect(await inner(`w.__mvDraw.engine.elements().length`)).toBe(2)
    expect(await inner(`getComputedStyle(d.querySelector('.layer-ui__wrapper') ?? d.body).display`)).toBe('none')
    expect(await inner(`w.__mvDraw.engine.appState().viewModeEnabled`)).toBe(true)
  }, 90_000)

  it('double-click opens drawing mode: the bar above, the panel left, the view controls inside, the purple accent', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    const r = await rectOf('iframe[data-kind="draw"]')
    await click(r.x + r.w / 2, r.y + r.h / 2); await click(r.x + r.w / 2, r.y + r.h / 2, 2)
    await until(`document.querySelector('.sh-app').classList.contains('drawing')`)
    // the bar and the view controls mount a frame apart: wait for both, then measure against the frame as it is now
    await until(`!!document.querySelector('.dk-tools.sh-ctx') && !!document.querySelector('.dk-view')`)
    await sleep(100)
    const f = await rectOf('iframe[data-kind="draw"]')
    const bar = await rectOf('.dk-tools.sh-ctx'), view = await rectOf('.dk-view')
    expect(bar.y + bar.h).toBeLessThanOrEqual(f.y)                           // above the frame
    expect(Math.abs(bar.x + bar.w / 2 - (f.x + f.w / 2))).toBeLessThan(4)  // centred on it
    expect(view.x + view.w).toBeLessThanOrEqual(f.x + f.w + 1)             // inside its corner
    expect(view.y + view.h).toBeLessThanOrEqual(f.y + f.h + 1)
    await until(`document.querySelector('iframe[data-kind="draw"]').contentWindow.__mvDraw.engine.appState().viewModeEnabled === false`, 5000)
  }, 30_000)

  it('draws a rectangle with the bar; it is saved; the panel restyles it', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    await press('.dk-tools button[aria-label="Rectangle"]')
    await until(`document.querySelector('.dk-tools button.on')?.getAttribute('aria-label') === 'Rectangle'`)
    const r = await rectOf('iframe[data-kind="draw"]')
    await drag(r.x + r.w * 0.15, r.y + r.h * 0.7, r.x + r.w * 0.4, r.y + r.h * 0.9)
    await until(`document.querySelector('iframe[data-kind="draw"]').contentWindow.__mvDraw.engine.elements().length === 3`)
    // the panel follows the selection: the new rectangle's sections, with Layers and Actions
    await until(`[...document.querySelectorAll('.dk-props .lb')].some((e) => e.textContent === 'Actions')`)
    // opened beside the open sidebar, the camera made room: the panel sits clear of the sidebar, left of the frame
    const side = await rectOf('.sh-panel:not(.closed)'), props = await rectOf('.dk-props'), fr = await rectOf('iframe[data-kind="draw"]')
    if (side && props.y < side.y + side.h) expect(props.x).toBeGreaterThanOrEqual(side.x + side.w)
    expect(props.x + props.w).toBeLessThanOrEqual(fr.x)
    const t = Date.now()
    while (Date.now() - t < 5000 && disk().elements.length !== 3) await sleep(100)
    expect(disk().elements).toHaveLength(3)
    expect(disk().marver.rev).toBeGreaterThan(0)
    await press('.dk-props button[aria-label="Red"]')
    const t2 = Date.now()
    while (Date.now() - t2 < 5000 && !disk().elements.some((e: any) => e.strokeColor === '#e03131')) await sleep(100)
    expect(disk().elements.filter((e: any) => e.strokeColor === '#e03131')).toHaveLength(1)
  }, 30_000)

  it("an agent's edit of the file lands live: no reload, the person's stroke kept, ⌘Z still the person's", async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    const boot = await inner(`w.__mvBoot`)
    // the agent moves `pay` and adds a label - editing the file as it is on disk (an Edit tool)
    const doc = disk()
    for (const e of doc.elements) if (e.id === 'pay') e.x = 600
    doc.elements.push({ id: 'agent-note', type: 'text', x: 420, y: 120, text: 'skip login?' })
    writeFileSync(file(), JSON.stringify(doc, null, 2))
    await until(`(() => { const e = document.querySelector('iframe[data-kind="draw"]').contentWindow.__mvDraw.engine.elements(); return e.some((x) => x.id === 'agent-note') && e.find((x) => x.id === 'pay').x === 600 })()`, 10_000)
    expect(await inner(`w.__mvBoot`)).toBe(boot)                              // the same document: patched, never reloaded
    expect(await inner(`w.__mvDraw.engine.elements().filter((e) => !e.isDeleted).length`)).toBe(4)
    // the person's undo reverts the person's last change (the red), never the agent's move
    await press('.dk-view button[aria-label="Undo"]')
    await until(`(() => { const e = document.querySelector('iframe[data-kind="draw"]').contentWindow.__mvDraw.engine.elements(); return !e.some((x) => !x.isDeleted && x.strokeColor === '#e03131') })()`, 5000)
    expect(await inner(`w.__mvDraw.engine.elements().find((x) => x.id === 'pay').x`)).toBe(600)
    expect(await inner(`w.__mvDraw.engine.elements().some((x) => x.id === 'agent-note' && !x.isDeleted)`)).toBe(true)
  }, 30_000)

  it('Escape leaves drawing mode; the frame rests in view mode again', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    await escape()
    await until(`!document.querySelector('.sh-app').classList.contains('drawing')`, 5000)
    await until(`document.querySelector('iframe[data-kind="draw"]').contentWindow.__mvDraw.engine.appState().viewModeEnabled === true`, 5000)
    expect(await ev(`!!document.querySelector('.dk-tools.sh-ctx')`)).toBe(false)
  }, 15_000)

  it('opened beside the open sidebar, the camera makes room: the panel clears the sidebar, off the drawing', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    const side = await rectOf('.sh-panel:not(.closed)')
    if (!side) return ctx.skip('no sidebar open')
    // scroll the frame up beside the sidebar, where its panel would land under it
    const r0 = await rectOf('iframe[data-kind="draw"]')
    await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 900, y: 500, deltaX: r0.x - 150, deltaY: r0.y - 120 }, s)
    await sleep(300)
    const r = await rectOf('iframe[data-kind="draw"]')
    expect(r.y).toBeLessThan(side.y + side.h)                                  // the case: beside the sidebar
    expect(r.x - 248).toBeLessThan(side.x + side.w)                            // its panel's place under it
    await click(r.x + r.w / 2, r.y + r.h / 2); await click(r.x + r.w / 2, r.y + r.h / 2, 2)
    await until(`document.querySelector('.sh-app').classList.contains('drawing')`)
    await until(`(() => { const f = document.querySelector('iframe[data-kind="draw"]').getBoundingClientRect(); return f.left - 248 >= ${side.x + side.w} })()`, 3000)
    const after = await rectOf('iframe[data-kind="draw"]')
    expect(after.y).toBeCloseTo(r.y, 0)                                         // a sideways move only
    expect(after.w).toBeCloseTo(r.w, 0)                                         // no zoom
    expect(after.x + after.w).toBeLessThanOrEqual(await ev('innerWidth'))       // never pushed off screen
    await escape()
    await until(`!document.querySelector('.sh-app').classList.contains('drawing')`, 5000)
    // a window too narrow for sidebar + panel + frame: the camera moves only as far as the frame stays on screen
    await b.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false }, s)
    await sleep(300)
    const n0 = await rectOf('iframe[data-kind="draw"]')
    await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 500, deltaX: n0.x - 150, deltaY: n0.y - 120 }, s)
    await sleep(300)
    const n = await rectOf('iframe[data-kind="draw"]')
    expect(side.x + side.w + 10 + 248 + n.w).toBeGreaterThan(800 - 10)            // the case: no room for sidebar, panel and frame
    await click(n.x + n.w / 2, n.y + n.h / 2); await click(n.x + n.w / 2, n.y + n.h / 2, 2)
    await until(`document.querySelector('.sh-app').classList.contains('drawing')`)
    await sleep(500)                                                              // the flight (250 ms) has landed
    const na = await rectOf('iframe[data-kind="draw"]')
    // never pushed (further) off screen: a frame that fit still fits; one already past the edge does not move
    expect(na.x + na.w).toBeLessThanOrEqual(Math.max(800, n.x + n.w) + 1)
    expect(na.x).toBeGreaterThanOrEqual(n.x - 1)                                  // it moved right, or stayed
    await escape()
    await until(`!document.querySelector('.sh-app').classList.contains('drawing')`, 5000)
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s)
    await sleep(300)
  }, 30_000)

  it('plays a selected drawing full-tab: the panel, the tool bar, the view; collapse; Escape back', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    const r = await rectOf('iframe[data-kind="draw"]')
    await click(r.x + r.w / 2, r.y + 8)    // the frame's head selects it
    await sleep(200)
    await b.press(s, 'p')
    await until(`!!document.querySelector('.dk-playhost iframe')`, 10_000)
    await until(`(() => { try { return !!document.querySelector('.dk-playhost iframe').contentWindow.__mvDraw } catch { return false } })()`, 20_000)
    await until(`!!document.querySelector('.dk-playhost .dk-tools') && !!document.querySelector('.dk-playhost .dk-view.lg')`, 10_000)
    await press('.dk-playhost button[aria-label="Collapse toolbar"]')
    await until(`!document.querySelector('.dk-playhost .dk-tools') && !!document.querySelector('.dk-playhost button[aria-label="Expand toolbar"]')`, 5000)
    await press('.dk-playhost button[aria-label="Expand toolbar"]')
    await until(`!!document.querySelector('.dk-playhost .dk-tools')`, 5000)
    // Escape inside the drawing goes back to the canvas
    const pr = await rectOf('.dk-playhost iframe')
    await click(pr.x + pr.w * 0.6, pr.y + pr.h * 0.5)
    await escape()
    await until(`!document.querySelector('.dk-playhost')`, 5000)
  }, 60_000)

  it('W drops a new drawing at the pointer and opens it for drawing', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    await click(1300, 820)                   // empty canvas: nothing selected
    await mouse('mouseMoved', 700, 780, { buttons: 0 })
    await b.press(s, 'w')
    const made = join(root, 'design/scenes/sketches/sketch-01.excalidraw')
    const t = Date.now()
    while (Date.now() - t < 8000 && !existsSync(made)) await sleep(100)
    expect(existsSync(made)).toBe(true)
    await until(`document.querySelector('.sh-app').classList.contains('drawing')`, 15_000)
    expect(await ev(`document.querySelectorAll('iframe[data-kind="draw"]').length`)).toBe(2)
    await escape()
  }, 40_000)

  it('shoots a drawing at its own size', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    const info = JSON.parse(readFileSync(join(root, 'design/.local/dev.json'), 'utf8'))
    const res = await fetch(`${dev!.origin}/__mv/api/shot?frame=sketches%2Fflow&theme=light&scale=1`, { headers: { 'x-mv-work': info.token } })
    const body = await res.json()
    expect(res.ok, JSON.stringify(body)).toBe(true)
    expect([body.width, body.height]).toEqual([960, 640])
    expect(existsSync(join(root, body.path))).toBe(true)
  }, 60_000)

  it('publishes: the drawing ships view-only (no tools), its text and shapes intact', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    writeFileSync(join(root, 'design/publish.json'), JSON.stringify({ boards: { main: { max: 'read' } } }))
    const built = await new Promise<{ code: number; out: string }>((resolve) => execFile(process.execPath, [CLI, 'build', '--root', root], { cwd: root, env: { ...process.env, CI: '1', MARVER_NO_UPDATE_CHECK: '1' }, timeout: 180_000 }, (e, so, se) => resolve({ code: e ? Number(e.code) || 1 : 0, out: so + se })))
    expect(built.code, built.out).toBe(0)
    const dist = join(root, 'design/.dist')
    const out = existsSync(dist) ? dist : join(root, 'dist')
    const data = join(out, '__mv/draw-data/sketches/flow.excalidraw')
    expect(existsSync(data), `${data} missing`).toBe(true)
    const pub = JSON.parse(readFileSync(data, 'utf8'))
    expect(pub.elements.some((e: any) => e.id === 'agent-note')).toBe(true)
    expect(pub.elements.every((e: any) => !e.customData?.mv)).toBe(true)     // who drew what stays local
    expect(existsSync(join(out, '__mv/draw/index.html'))).toBe(true)
  }, 200_000)
})
