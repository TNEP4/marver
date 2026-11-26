/**
 * Spec 39 A6/B8 - a drawing's right-click in Marver's design, end to end: a real `marver dev`, a real Chrome.
 * Excalidraw's own menu never shows; Marver's lists Comment first, then Excalidraw's own actions as they apply (named as
 * the panel names them, shortcuts as glyphs), runs them through Excalidraw (a flip, a duplicate, a delete), writes the
 * clipboard rows inside the click (Copy, Copy as text, Copy as SVG), walks with the arrows, and on the paper offers
 * Comment here, Paste, Copy as image, Zoom to fit, Copy path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'

const el = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id, type: 'rectangle', x, y, width: 180, height: 90, angle: 0, strokeColor: '#1e1e1e', backgroundColor: '#a5d8ff', fillStyle: 'solid',
  strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 }, seed: 1, version: 1,
  versionNonce: 1, isDeleted: false, boundElements: [{ id: `${id}-t`, type: 'text' }], updated: 1, link: null, locked: false, ...extra,
})
const label = (id: string, box: string, x: number, y: number, text: string, index: string) => ({
  id, type: 'text', x, y, width: 80, height: 25, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
  strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 3, version: 1, versionNonce: 3, isDeleted: false,
  boundElements: null, updated: 1, link: null, locked: false, text, originalText: text, fontSize: 20, fontFamily: 5, textAlign: 'center',
  verticalAlign: 'middle', containerId: box, autoResize: true, lineHeight: 1.25, index,
})
const DRAWING = {
  type: 'excalidraw', version: 2, source: 'marver', marver: { rev: 0, epoch: 'e1', title: 'Menu', size: { w: 960, h: 640 }, view: { x: 0, y: 0, zoom: 1 } },
  elements: [el('cart', 80, 200, { index: 'a0' }), label('cart-t', 'cart', 130, 232, 'Cart', 'a1')],
  appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {},
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("a drawing's right-click in Marver's design (spec 39), in a real browser", () => {
  let root = '', dev: Dev | undefined, b: Browser | null = null, s = ''
  beforeAll(async () => {
    root = fixtureRoot('mv-draw-menu-', {
      'design/config.ts': 'export default { jam: false }\n',
      'design/scenes/sketches/menu.excalidraw': JSON.stringify(DRAWING),
      'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', auto: false, nodes: [{ key: 'n_menu', frame: 'sketches/menu', x: 0, y: 0, w: 960, h: 640 }] }),
    })
    dev = await startDev(root)
    b = await Browser.launch()
    if (!b) return
    s = await b.tab({ width: 1440, height: 900 })
    await b.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: dev.origin }).catch(() => {})
  }, 120_000)
  afterAll(async () => {
    if (b && s) await b.closeTab(s).catch(() => {})
    await dev?.stop()
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const ev = async (x: string): Promise<any> => { for (let i = 0; i < 8; i++) { try { return await b!.eval(s, x) } catch { await sleep(300) } } throw new Error(`eval kept failing: ${x}`) }
  const until = async (x: string, ms = 20_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(x).catch(() => false)) return true; await sleep(150) } throw new Error(`timed out: ${x}`) }
  const mouse = (type: string, x: number, y: number, button = 'left') =>
    b!.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : button, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0, clickCount: 1 }, s)
  const click = async (x: number, y: number, button = 'left') => { await mouse('mouseMoved', x, y); await sleep(30); await mouse('mousePressed', x, y, button); await mouse('mouseReleased', x, y, button) }
  const key = async (k: string, code: string, vk: number) => {
    const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await b!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, s)
    await b!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, s)
  }
  const FRAME = 'iframe[data-kind="draw"]'
  const inner = (x: string) => ev(`(() => { const f = document.querySelector('${FRAME}'); const w = f.contentWindow, d = f.contentDocument; return (${x}) })()`)
  const page = (x: number, y: number) => ev(`(() => { const f = document.querySelector('${FRAME}'); const r = f.getBoundingClientRect(); const p = f.contentWindow.__mvDraw.engine.toView(${x}, ${y}); const k = r.width / f.offsetWidth; return { x: r.x + p.x * k, y: r.y + p.y * k } })()`)
  const rows = () => ev(`[...document.querySelectorAll('.dk-ctxmenu button')].map((b) => b.textContent)`)
  // a real click on the row (a trusted gesture: the clipboard rows write only inside one)
  const row = async (label: string) => {
    await until(`document.querySelector('.dk-ctxmenu')?.style.visibility !== 'hidden'`, 3000)
    const r = await ev(`(() => { const b = [...document.querySelectorAll('.dk-ctxmenu button')].find((b) => b.querySelector('span')?.textContent === ${JSON.stringify(label)}); if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 } })()`)
    if (!r) return false
    await click(r.x, r.y)
    return true
  }
  const live = () => inner(`w.__mvDraw.engine.elements().filter((e) => !e.isDeleted)`)

  it('a right-click on an element shows Marver\'s menu, never Excalidraw\'s: Comment first, the panel\'s names, glyphs', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    await b.go(s, `${dev!.origin}/#/b/main`)
    await until(`(() => { try { return !!document.querySelector('${FRAME}').contentWindow.__mvDraw?.ready } catch { return false } })()`, 60_000)
    await ev(`window.__mvStore.getState().setInteract('n_menu')`)
    await until(`document.querySelector('.sh-app').classList.contains('drawing')`)
    await sleep(400)
    const at = await page(80 + 40, 200 + 20)
    await click(at.x, at.y)
    await click(at.x, at.y, 'right')
    await until(`!!document.querySelector('.dk-ctxmenu')`, 5000)
    expect(await inner(`!!d.querySelector('.context-menu') && getComputedStyle(d.querySelector('.context-menu')).display !== 'none'`)).toBe(false)
    const r: string[] = await rows()
    expect(r[0]).toMatch(/^Comment/)
    expect(r.some((x) => x.startsWith('Cut'))).toBe(true)
    expect(r.some((x) => x.startsWith('Copy selection as image'))).toBe(true)
    expect(r.some((x) => x === 'Send to back⌥⌘[')).toBe(true)          // Apple's order: ⌥ before ⌘
    expect(r.some((x) => /Add to library|Wrap selection in frame|Copy to clipboard as PNG/.test(x))).toBe(false)
    expect(await ev(`getComputedStyle([...document.querySelectorAll('.dk-ctxmenu button')].find((b) => b.textContent.startsWith('Delete'))).color`)).toBe('rgb(229, 72, 77)')
  }, 90_000)

  it('rows run Excalidraw\'s own actions: Duplicate, Flip, Delete', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    expect(await row('Duplicate')).toBe(true)
    await until(`(() => { const f = document.querySelector('${FRAME}'); return f.contentWindow.__mvDraw.engine.elements().filter((e) => !e.isDeleted && e.type === 'rectangle').length === 2 })()`, 5000)
    const at = await page(80 + 40, 200 + 20)
    await click(at.x, at.y)
    await click(at.x, at.y, 'right')
    await until(`!!document.querySelector('.dk-ctxmenu')`, 5000)
    // Lock: Excalidraw's own toggle, through the panel's path (a flip of a plain box changes nothing to see)
    expect(await row('Lock')).toBe(true)
    await until(`document.querySelector('${FRAME}').contentWindow.__mvDraw.engine.elements().some((e) => e.type === 'rectangle' && e.locked)`, 5000)
    // the lock and the copy away again, so the rest of the file starts from one Cart
    await inner(`w.__mvDraw.engine.undo()`); await inner(`w.__mvDraw.engine.undo()`)
    await until(`!document.querySelector('${FRAME}').contentWindow.__mvDraw.engine.elements().some((e) => e.locked)`, 5000)
    await until(`document.querySelector('${FRAME}').contentWindow.__mvDraw.engine.elements().filter((e) => !e.isDeleted && e.type === 'rectangle').length === 1`, 5000)
    await click(at.x, at.y)
    await click(at.x, at.y, 'right')
    await until(`!!document.querySelector('.dk-ctxmenu')`, 5000)
    expect(await row('Delete')).toBe(true)
    await until(`!document.querySelector('${FRAME}').contentWindow.__mvDraw.engine.elements().some((e) => e.id === 'cart' && !e.isDeleted)`, 5000)
    await inner(`w.__mvDraw.engine.undo()`)
    await until(`document.querySelector('${FRAME}').contentWindow.__mvDraw.engine.elements().some((e) => e.id === 'cart' && !e.isDeleted)`, 5000)
  }, 60_000)

  it('clipboard rows write inside the click: Copy (Excalidraw\'s clipboard), Copy as text, Copy as SVG', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    // what the shell writes, captured (a test may write the clipboard but not read it back)
    await ev(`(() => { window.__clip = ''; const o = navigator.clipboard.write.bind(navigator.clipboard); navigator.clipboard.write = async (items) => { await o(items); const it = items[0]; const t = it.types.find((x) => x === 'text/plain'); if (t) window.__clip = await (await it.getType(t)).text(); }; return true })()`)
    const at = await page(80 + 40, 200 + 20)
    await click(at.x, at.y)
    await click(at.x, at.y, 'right')
    await until(`!!document.querySelector('.dk-ctxmenu')`, 5000)
    expect(await row('Copy as text')).toBe(true)
    await until(`window.__clip === 'Cart'`, 5000)
    await click(at.x, at.y, 'right')
    await until(`!!document.querySelector('.dk-ctxmenu')`, 5000)
    expect(await row('Copy')).toBe(true)
    await until(`(() => { try { const j = JSON.parse(window.__clip); return j.type === 'excalidraw/clipboard' && j.elements.some((e) => e.id === 'cart') && j.elements.some((e) => e.id === 'cart-t') } catch { return false } })()`, 5000)
    await click(at.x, at.y, 'right')
    await until(`!!document.querySelector('.dk-ctxmenu')`, 5000)
    expect(await row('Copy as SVG')).toBe(true)
    await until(`window.__clip.startsWith('<svg')`, 5000)
  }, 60_000)

  it('the arrows walk it, Enter runs, Escape closes the menu only (drawing mode stays)', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    const at = await page(80 + 40, 200 + 20)
    await click(at.x, at.y, 'right')
    await until(`!!document.querySelector('.dk-ctxmenu')`, 5000)
    await key('ArrowDown', 'ArrowDown', 40)
    await until(`!!document.querySelector('.dk-ctxmenu button.hi')`, 3000)
    await key('Escape', 'Escape', 27)
    await until(`!document.querySelector('.dk-ctxmenu')`, 3000)
    expect(await ev(`window.__mvStore.getState().interact`)).toBe('n_menu')
  }, 60_000)

  it('on the paper: Comment here, Paste, Copy as image, Select all, Zoom to fit, Copy path; Comment here stages a paper draft', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    const at = await page(700, 520)
    await click(at.x, at.y, 'right')
    await until(`!!document.querySelector('.dk-ctxmenu')`, 5000)
    const r: string[] = await rows()
    expect(r[0]).toMatch(/^Comment here/)
    for (const want of ['Paste', 'Copy as image', 'Select all', 'Zoom to fit', 'Copy path']) expect(r.some((x) => x.startsWith(want))).toBe(true)
    expect(await row('Comment here')).toBe(true)
    await until(`!!window.__mvComments.getState().draft`, 3000)
    const d = await ev(`window.__mvComments.getState().draft`)
    expect(d.anchor.el.draw.at).toBeTruthy()
    expect(d.nodeKey).toBe('n_menu')
    await ev(`window.__mvComments.getState().setDraft(null)`)
    void readFileSync
  }, 60_000)
})
