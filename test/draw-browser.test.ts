/**
 * Spec 38 - the drawing frame, end to end: a real `marver dev`, a real Chrome, real files.
 * The canvas's drawing mode (bar, panel, view controls around the frame), drawing with the bar, the person's save,
 * an agent's file edit landing live (no reload, ⌘Z still the person's), W, play, a shot, and a published build.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile, spawn } from 'node:child_process'
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
    // the head's pen nib follows the FRAME's theme, as the head does: a dark drawing on a light board wears the light ink
    const nib = `getComputedStyle(document.querySelector('.sh-node.dk-draw .sh-node-head .dk-kind')).color`
    expect(await ev(nib)).toBe('rgb(91, 87, 209)')
    await ev(`(() => { const st = window.__mvStore.getState(); st.select('n_flow'); window.__mvStore.getState().setSelectedTheme('dark') })()`)
    await until(`document.querySelector('.sh-node.dk-draw').dataset.theme === 'dark'`)
    expect(await ev(nib)).toBe('rgb(168, 165, 255)')
    await ev(`(() => { const st = window.__mvStore.getState(); window.__mvStore.getState().setSelectedTheme('light'); st.select(null) })()`)
    await until(`document.querySelector('.sh-node.dk-draw').dataset.theme === 'light'`)
  }, 90_000)

  it('double-click opens drawing mode: the bar above, the panel left, the view controls inside, the purple accent', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    const r = await rectOf('iframe[data-kind="draw"]')
    // one click selects it in the shell's blue, as every frame (purple is for drawing mode only - Nic, 26 Nov)
    const border = `getComputedStyle(document.querySelector('.sh-node.dk-draw')).borderTopColor`
    const favicon = `[...document.querySelectorAll('link[rel="icon"]')].map((l) => l.getAttribute('href')).join(' ')`
    await click(r.x + r.w / 2, r.y + r.h / 2)
    await until(`document.querySelector('.sh-node.dk-draw').classList.contains('sel')`)
    expect(await ev(border)).not.toBe('rgb(105, 101, 219)')
    expect(await ev(favicon)).not.toMatch(/-drawing/)
    // the frame bar's gap above the frame - drawing mode's bar keeps the same air (Nic, 26 Nov)
    const gap = (sel: string) => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(), n = document.querySelector('.sh-node.dk-draw').getBoundingClientRect(); return Math.round(n.top - b.bottom) })()`)
    await until(`!!document.querySelector('.sh-ctx')`)
    const gapOnce = await gap('.sh-ctx')
    await click(r.x + r.w / 2, r.y + r.h / 2, 2)
    await until(`document.querySelector('.sh-app').classList.contains('drawing')`)
    // drawing mode: the purple ring and the purple favicon, as interact wears magenta
    await until(`${border} === 'rgb(105, 101, 219)'`, 3000)
    await until(`/favicon-32x32-drawing/.test(${favicon})`, 3000)
    await until(`!!document.querySelector('.dk-tools.sh-ctx')`)
    expect(await gap('.dk-tools.sh-ctx')).toBe(gapOnce)
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

  it('Copy as image puts the drawing on the clipboard - riding the click, nothing granted before it', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    await b.send('Page.bringToFront', {}, s)
    await b.send('Emulation.setFocusEmulationEnabled', { enabled: true }, s)
    await press('.dk-tools button[aria-label="Copy as image"]')
    await until(`[...document.querySelectorAll('.sh-toast')].some((t) => /image copied|copy blocked/.test(t.textContent))`, 15_000)
    expect(await ev(`[...document.querySelectorAll('.sh-toast')].map((t) => t.textContent).join(' | ')`)).toMatch(/image copied/)
    await b.grant(s, dev!.origin, ['clipboardReadWrite'])
    const got = await ev(`(async () => { const items = await navigator.clipboard.read(); const it = items.find((i) => i.types.includes('image/png')); if (!it) return { types: items.map((i) => i.types) }; const bmp = await createImageBitmap(await it.getType('image/png')); return { w: bmp.width, h: bmp.height } })()`)
    expect(got.w, JSON.stringify(got)).toBeGreaterThan(100)
    expect(got.h).toBeGreaterThan(50)
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
    expect(await ev(`[...document.querySelectorAll('link[rel="icon"]')].map((l) => l.getAttribute('href')).join(' ')`)).not.toMatch(/-drawing/)
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
    // the frame's top off screen: the bar pins under the shell's toolbar pill, never over it
    const t0 = await rectOf('iframe[data-kind="draw"]')
    await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 900, y: 500, deltaX: t0.x - 500, deltaY: t0.y + 60 }, s)
    await sleep(300)
    const t = await rectOf('iframe[data-kind="draw"]')
    expect(t.y).toBeLessThan(0)
    await click(t.x + t.w / 2, t.y + t.h / 2); await click(t.x + t.w / 2, t.y + t.h / 2, 2)
    await until(`!!document.querySelector('.dk-tools.sh-ctx')`)
    await sleep(400)
    const pill = await rectOf('nav.sh-pill'), tb = await rectOf('.dk-tools.sh-ctx')
    expect(tb.y).toBeGreaterThanOrEqual(pill.y + pill.h + 8)
    await escape()
    await until(`!document.querySelector('.sh-app').classList.contains('drawing')`, 5000)
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
    // the drawing's own paper fills the whole tab - in the Mac app the strip behind its tabs sits on it (the play note)
    await until(`getComputedStyle(document.querySelector('.dk-playhost')).backgroundColor === 'rgb(255, 255, 255)'`, 5000)
    await ev(`window.__mvStore.getState().setTheme('dark')`)
    await until(`getComputedStyle(document.querySelector('.dk-playhost')).backgroundColor === 'rgb(18, 18, 18)'`, 5000)   // Excalidraw's dark paper
    await ev(`window.__mvStore.getState().setTheme('light')`)
    await until(`getComputedStyle(document.querySelector('.dk-playhost')).backgroundColor === 'rgb(255, 255, 255)'`, 5000)
    await press('.dk-playhost button[aria-label="Collapse toolbar"]')
    await until(`!document.querySelector('.dk-playhost .dk-tools') && !!document.querySelector('.dk-playhost button[aria-label="Expand toolbar"]')`, 5000)
    await press('.dk-playhost button[aria-label="Expand toolbar"]')
    await until(`!!document.querySelector('.dk-playhost .dk-tools')`, 5000)
    // Escape inside the drawing goes back to the canvas
    const pr = await rectOf('.dk-playhost iframe')
    await click(pr.x + pr.w * 0.6, pr.y + pr.h * 0.5)
    // H is Hide all UI in play, as its menus say - and H again brings it back (never Excalidraw's hand there)
    await b.press(s, 'h')
    await until(`document.querySelector('.dk-playhost').classList.contains('hidden-ui')`, 3000)
    await b.press(s, 'h')
    await until(`!document.querySelector('.dk-playhost').classList.contains('hidden-ui')`, 3000)
    expect(await ev(`document.querySelector('.dk-playhost iframe').contentWindow.__mvDraw.engine.appState().activeTool.type`)).not.toBe('hand')
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
    // served as a published canvas (no dev server, no API): play the drawing and export it - a real PDF and PNG come out
    const port = 4790 + Math.floor(Math.random() * 7)
    const server = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], { cwd: root, stdio: 'pipe', env: { ...process.env, MARVER_DATA_DIR: '', MARVER_PASSWORD: '', MARVER_ID_ISSUER: '' } })
    const t2 = await b.tab({ width: 1440, height: 900 })
    try {
      const pev = async (x: string): Promise<any> => { for (let i = 0; i < 8; i++) { try { return await b!.eval(t2, x) } catch { await sleep(300) } } throw new Error(`eval: ${x}`) }
      const puntil = async (x: string, ms = 30_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await pev(x).catch(() => false)) return; await sleep(200) } throw new Error(`timed out: ${x}`) }
      for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://localhost:${port}/`)).ok) break } catch { /* not yet */ } await sleep(250) }
      await b.go(t2, `http://localhost:${port}/#/b/main`)
      await puntil(`(() => { try { return !!document.querySelector('iframe[data-kind="draw"]').contentWindow.__mvDraw } catch { return false } })()`, 60_000)
      // every download the page starts, kept: its name and its bytes' first four characters and size
      await pev(`(() => { window.__dl = []; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { const name = this.download; fetch(this.href).then((r) => r.arrayBuffer()).then((ab) => { const u = new Uint8Array(ab); window.__dl.push({ name, size: u.length, head: String.fromCharCode(...u.slice(0, 4)) }) }); return } return click.call(this) }; return true })()`)
      // a click on the frame's head selects it (a published build has no store handle), then P
      const fr = await pev(`(() => { const r = document.querySelector('iframe[data-kind="draw"]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width } })()`)
      for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x: fr.x + fr.w / 2, y: fr.y - 10, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, t2)
      await sleep(300)
      await b.press(t2, 'p')
      await puntil(`(() => { try { return !!document.querySelector('.dk-playhost iframe').contentWindow.__mvDraw } catch { return false } })()`)
      expect(await pev(`!!document.querySelector('.dk-playhost .dk-tools')`)).toBe(false)          // view-only: no tools
      for (const item of ['Export as PDF', 'Export as PNG']) {
        await pev(`document.querySelector('.dk-playhost button[aria-label="Drawing menu"]').click()`)
        await sleep(300)
        await pev(`[...document.querySelectorAll('.dk-playhost .dk-menu button')].find((x) => x.textContent.includes(${JSON.stringify(item)})).click()`)
        await sleep(200)
      }
      await puntil(`window.__dl.length === 2`, 20_000)
      const dl = await pev(`window.__dl`)
      const pdf = dl.find((d: any) => d.name.endsWith('.pdf')), png = dl.find((d: any) => d.name.endsWith('.png'))
      expect(pdf?.head).toBe('%PDF')
      expect(pdf.size).toBeGreaterThan(5_000)
      expect(png?.head.slice(1)).toBe('PNG')
    } finally {
      await b.closeTab(t2).catch(() => {})
      server.kill('SIGTERM')
    }
  }, 240_000)

  it('a text whose stored box is too small shows whole once the drawing loads - measured in its own font (seen in the Mac app)', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    const doc = disk()
    doc.elements.push({ id: 'tight-label', type: 'text', x: 60, y: 40, width: 40, height: 25, text: 'agent: is login needed?', fontSize: 28 })
    writeFileSync(file(), JSON.stringify(doc, null, 2))
    await until(`(() => { const e = document.querySelector('iframe[data-kind="draw"]').contentWindow.__mvDraw.engine.elements(); return e.some((x) => x.id === 'tight-label') })()`, 10_000)
    // a fresh load with the fonts held back 1.5 s (a slow network, a cold cache): the first measure runs on a fallback
    // font, so the box must be measured again once the hand-drawn face is in
    await b.send('Network.enable', {}, s)
    await b.send('Network.setCacheDisabled', { cacheDisabled: true }, s)                // the earlier steps cached the fonts
    await b.send('Fetch.enable', { patterns: [{ urlPattern: '*draw-assets/fonts*' }] }, s)
    const off = b.on((m: any) => {
      if (m.method === 'Fetch.requestPaused' && m.sessionId === s) setTimeout(() => { b!.send('Fetch.continueRequest', { requestId: m.params.requestId }, s).catch(() => {}) }, 1500)
    })
    await b.send('Page.reload', { ignoreCache: true }, s)                                 // a real reload (a hash change is none)
    await sleep(300)
    await until(`(() => { try { const w = document.querySelector('iframe[data-kind="draw"]').contentWindow; return !!w.__mvDraw && w.__mvDraw.engine.elements().some((x) => x.id === 'tight-label') } catch { return false } })()`, 60_000)
    const words = `(() => { const d = document.querySelector('iframe[data-kind="draw"]').contentDocument; const c = d.createElement('canvas').getContext('2d'); c.font = '28px Excalifont'; return c.measureText('agent: is login needed?').width })()`
    await until(`(() => { const w = document.querySelector('iframe[data-kind="draw"]').contentWindow; const t = w.__mvDraw.engine.elements().find((x) => x.id === 'tight-label'); return w.document.fonts.check('28px Excalifont') && t && t.width >= ${words} - 1 })()`, 10_000)
    off()
    await b.send('Fetch.disable', {}, s)
    await b.send('Network.setCacheDisabled', { cacheDisabled: false }, s)
  }, 90_000)

  it("typing in a shape keeps the text's panel up, and the panel acts on the text being typed (Nic, 26 Nov)", async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    // the checkout drawing (W made a second one); in view first - the reload before may have left the camera anywhere
    const F = '[data-node="n_flow"] iframe[data-kind="draw"]'
    await until(`(() => { try { return !!document.querySelector('${F}').contentWindow.__mvDraw } catch { return false } })()`, 30_000)
    await ev(`window.__mvStore.getState().select('n_flow')`)
    await sleep(200)
    await b.press(s, 'f')
    await sleep(800)
    const r = await rectOf(F)
    await click(r.x + r.w / 2, r.y + r.h / 2); await click(r.x + r.w / 2, r.y + r.h / 2, 2)
    await until(`document.querySelector('.sh-app').classList.contains('drawing')`)
    // the cart box selected, then Enter: Excalidraw opens its label for typing (and clears the selection)
    const fin = (x: string) => ev(`(() => { const f = document.querySelector('${F}'); const d = f.contentDocument, w = f.contentWindow; return (${x}) })()`)
    await fin(`(w.__mvApp.setState({ selectedElementIds: { cart: true } }), w.focus(), d.querySelector(".excalidraw")?.focus(), true)`)
    await sleep(300)
    const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...enter }, s); await b.send('Input.dispatchKeyEvent', { type: 'char', ...enter, text: '\r' }, s); await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter }, s)
    await until(`!!document.querySelector('${F}').contentWindow.__mvApp.state.editingTextElement`, 5000)
    await b.send('Input.insertText', { text: 'Cart' }, s)
    await sleep(300)
    const labels = `[...document.querySelectorAll('.dk-props .lb')].map((e) => e.textContent).join('|')`
    await until(`/Font/.test(${labels}) && /Vertical/.test(${labels})`, 3000)
    expect(await ev(labels)).not.toMatch(/Actions/)
    // Size XL from the panel while typing: the label being typed takes it, and the typing goes on
    await press('.dk-props button[aria-label="Extra large"]')
    await until(`(() => { const w = document.querySelector('${F}').contentWindow; const t = w.__mvApp.state.editingTextElement; const e = t && w.__mvDraw.engine.elements().find((x) => x.id === t.id); return !!e && e.fontSize === 36 })()`, 3000)
    expect(await fin(`!!w.__mvApp.state.editingTextElement`)).toBe(true)
    // the opacity slider dragged while typing: the label takes it, the typing goes on, the panel stays (Nic, 26 Nov)
    const sl = await rectOf('.dk-props input[aria-label="Opacity"]')
    await mouse('mousePressed', sl.x + sl.w * 0.9, sl.y + sl.h / 2)
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', sl.x + sl.w * (0.9 - i * 0.065), sl.y + sl.h / 2); await sleep(20) }
    await mouse('mouseReleased', sl.x + sl.w * 0.5, sl.y + sl.h / 2)
    await until(`(() => { const w = document.querySelector('${F}').contentWindow; const t = w.__mvApp.state.editingTextElement; const e = t && w.__mvDraw.engine.elements().find((x) => x.id === t.id); return !!e && e.opacity === 50 })()`, 3000)
    expect(await fin(`!!w.__mvApp.state.editingTextElement`)).toBe(true)
    expect(await ev(`!!document.querySelector('.dk-props')`)).toBe(true)
    await escape(); await sleep(200); await escape()
    await until(`!document.querySelector('.sh-app').classList.contains('drawing')`, 5000)
  }, 40_000)

  it('inside a drawing D is the diamond and ⌥⇧D the theme - the frame\'s on the canvas, the view\'s in play; ⋯ has the switch (Nic, 26 Nov)', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    const F = '[data-node="n_flow"] iframe[data-kind="draw"]'
    const fin = (x: string) => ev(`(() => { const f = document.querySelector('${F}'); const d = f.contentDocument, w = f.contentWindow; return (${x}) })()`)
    const keyIn = async (code: string, key: string, modifiers = 0) => {
      // the drawing holds the focus (as after a click in it)
      await ev(`(() => { const f = document.querySelector('.dk-playhost iframe') ?? document.querySelector('${F}'); f.contentWindow.focus(); f.contentDocument.querySelector('.excalidraw')?.focus(); return true })()`)
      const k = { code, key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers }
      await b!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k }, s); await b!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k }, s); await sleep(250)
    }
    await ev(`window.__mvStore.getState().select('n_flow')`)
    await b.press(s, 'f'); await sleep(800)
    const r = await rectOf(F)
    await click(r.x + r.w / 2, r.y + r.h / 2); await click(r.x + r.w / 2, r.y + r.h / 2, 2)
    await until(`document.querySelector('.sh-app').classList.contains('drawing')`)
    await fin(`(w.__mvApp.setState({ selectedElementIds: {} }), w.focus(), d.querySelector('.excalidraw')?.focus(), true)`)
    const theme = () => ev(`window.__mvStore.getState().nodes.find((n) => n.key === 'n_flow').theme`)
    const before = await theme()
    await keyIn('KeyD', 'd')
    expect(await fin(`w.__mvApp.state.activeTool.type`)).toBe('diamond')
    expect(await theme()).toBe(before)                                  // D never touched the theme here
    await keyIn('KeyD', 'D', 9)                                         // ⌥⇧D (Alt 1 + Shift 8)
    await until(`window.__mvStore.getState().nodes.find((n) => n.key === 'n_flow').theme !== ${JSON.stringify(before)}`, 3000)
    await keyIn('KeyD', 'D', 9)
    await until(`window.__mvStore.getState().nodes.find((n) => n.key === 'n_flow').theme === ${JSON.stringify(before)}`, 3000)
    await press('.dk-tools button[aria-label="More"]')
    expect(await ev(`[...document.querySelectorAll('.dk-menu button')].some((x) => /Dark mode|Light mode/.test(x.textContent) && /⌥⇧D/.test(x.textContent))`)).toBe(true)
    await press('.dk-tools button[aria-label="More"]')
    await escape(); await sleep(200)
    if (await ev(`document.querySelector('.sh-app').classList.contains('drawing')`)) await escape()
    await until(`!document.querySelector('.sh-app').classList.contains('drawing')`, 5000)
    // play: ⌥⇧D turns the theme the drawing plays in (the canvas's)
    await ev(`window.__mvStore.getState().select('n_flow')`)
    await b.press(s, 'p')
    await until(`(() => { try { return !!document.querySelector('.dk-playhost iframe').contentWindow.__mvDraw } catch { return false } })()`, 20_000)
    await ev(`(() => { const f = document.querySelector('.dk-playhost iframe'); f.contentWindow.focus(); f.contentDocument.querySelector('.excalidraw')?.focus(); return true })()`)
    const view = await ev(`window.__mvStore.getState().viewTheme`)
    await keyIn('KeyD', 'D', 9)
    await until(`window.__mvStore.getState().viewTheme !== ${JSON.stringify(view)}`, 3000)
    await keyIn('KeyD', 'D', 9)
    await until(`window.__mvStore.getState().viewTheme === ${JSON.stringify(view)}`, 3000)
    await escape()
    await until(`!document.querySelector('.dk-playhost')`, 5000)
  }, 60_000)

  it('exports: the PNG at 3x, the PDF as vectors and real text - one page, its fonts embedded, no picture, light (Nic, 26 Nov)', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    const F = '[data-node="n_flow"] iframe[data-kind="draw"]'
    const png = await ev(`(async () => { const w = document.querySelector('${F}').contentWindow; const { blob, scale } = await w.__mvDraw.engine.exportPng(false); const bmp = await createImageBitmap(blob); const box = w.__mvDraw.engine.contentBox(); return { scale, w: bmp.width, h: bmp.height, cw: box.w } })()`)
    expect(png.scale).toBe(3)
    expect(png.w).toBeGreaterThan(png.cw * 3 - 1)                       // the content (+ padding) at 3x
    const svg: string = await ev(`document.querySelector('${F}').contentWindow.__mvDraw.engine.exportSvg(false)`)
    expect(svg).toMatch(/@font-face/)                                    // Excalidraw inlines the fonts it uses
    const info = JSON.parse(readFileSync(join(root, 'design/.local/dev.json'), 'utf8'))
    const res = await fetch(`${dev!.origin}/__mv/api/draw-pdf`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-work': info.token }, body: JSON.stringify({ svg, title: 'Checkout flow' }) })
    expect(res.status, await res.clone().text().catch(() => '')).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    const bytes = Buffer.from(await res.arrayBuffer())
    const text = bytes.toString('latin1')
    expect(text.startsWith('%PDF')).toBe(true)
    expect(text).toMatch(/\/FontFile2|\/FontFile3|\/FontFile\b/)            // real text, its font embedded
    expect(text).not.toMatch(/\/Subtype\s*\/Image/)                          // no picture of the drawing
    expect(bytes.length).toBeLessThan(400_000)
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getTitle()).toBe('Checkout flow')
    // a canvas page can ask too (the owner), and anything else is refused
    expect((await fetch(`${dev!.origin}/__mv/api/draw-pdf`, { method: 'POST', body: JSON.stringify({ svg }) })).status).toBe(403)
  }, 60_000)
})
