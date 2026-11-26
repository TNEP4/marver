/**
 * Spec 39 - comments on a drawing's elements and paper, end to end: a real `marver dev`, a real Chrome, real files.
 * Comment mode names the element under the pointer, a click anchors the comment to it (or to the paper), the pin sits on
 * the element and follows it when an agent moves it, parks when it is out of the drawing's view or gone; Escape closes
 * comments before it leaves drawing mode; C works inside a drawing; drawing play has the same pins and picks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'

const el = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id, type: 'rectangle', x, y, width: 180, height: 90, angle: 0, strokeColor: '#1971c2', backgroundColor: 'transparent', fillStyle: 'solid',
  strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 }, seed: 1, version: 1,
  versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, ...extra,
})
const DRAWING = {
  type: 'excalidraw', version: 2, source: 'marver', marver: { rev: 0, epoch: 'e1', title: 'Checkout flow', size: { w: 960, h: 640 }, view: { x: 0, y: 0, zoom: 1 } },
  elements: [el('cart', 80, 200, { index: 'a0' }), el('pay', 420, 200, { index: 'a1', seed: 2, versionNonce: 2, strokeColor: '#1e1e1e' }),
    // an arrow drawn leftwards: its points run back from x,y (its box is not x,y,width,height - review r1 #2)
    el('back', 860, 110, { index: 'a2', type: 'arrow', width: 240, height: 0, points: [[0, 0], [-240, 0]], roundness: null, seed: 4, versionNonce: 4, startArrowhead: null, endArrowhead: 'arrow', lastCommittedPoint: null, startBinding: null, endBinding: null })],
  appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {},
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('comments on a drawing (spec 39), in a real browser', () => {
  let root = '', dev: Dev | undefined, b: Browser | null = null, s = ''
  const file = () => join(root, 'design/scenes/sketches/flow.excalidraw')
  const log = () => { try { return readFileSync(join(root, 'design/comments/main.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
  beforeAll(async () => {
    root = fixtureRoot('mv-draw-comments-', {
      'design/config.ts': 'export default { jam: false }\n',
      'design/scenes/sketches/flow.excalidraw': JSON.stringify(DRAWING),
      'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', auto: false, nodes: [{ key: 'n_flow', frame: 'sketches/flow', x: 0, y: 0, w: 960, h: 640 }] }),
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

  const ev = async (x: string): Promise<any> => { for (let i = 0; i < 8; i++) { try { return await b!.eval(s, x) } catch { await sleep(300) } } throw new Error(`eval kept failing: ${x}`) }
  const until = async (x: string, ms = 20_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(x).catch(() => false)) return true; await sleep(150) } throw new Error(`timed out: ${x}`) }
  const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
    b!.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, ...extra }, s)
  const click = async (x: number, y: number, count = 1) => { await mouse('mouseMoved', x, y); await sleep(40); await mouse('mousePressed', x, y, { clickCount: count }); await mouse('mouseReleased', x, y, { clickCount: count }) }
  const key = async (k: string, code: string, vk: number, shift = false) => {
    const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 }
    await b!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, s)
    if (k.length === 1) await b!.send('Input.dispatchKeyEvent', { type: 'char', text: k, ...base }, s)
    await b!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, s)
  }
  const escape = () => key('Escape', 'Escape', 27)
  /** where a drawing point is on the page (the iframe's rect plus the drawing's own camera) */
  const page = (frameSel: string, x: number, y: number) => ev(`(() => { const f = document.querySelector(${JSON.stringify(frameSel)}); const r = f.getBoundingClientRect(); const p = f.contentWindow.__mvDraw.engine.toView(${x}, ${y}); const k = r.width / f.offsetWidth; return { x: r.x + p.x * k, y: r.y + p.y * k } })()`)
  const CANVAS = 'iframe[data-kind="draw"]'
  const pinOf = (id: string) => ev(`(() => { const p = document.querySelector('.cm-pin[data-thread="${id}"]'); if (!p) return null; const r = p.getBoundingClientRect(); return { x: r.x, y: r.bottom, cls: p.className } })()`)
  const comment = async (words: string) => {
    await until(`!!document.querySelector('.cm-draft textarea, .cm-draft [contenteditable]')`)
    await b!.send('Input.insertText', { text: words }, s)
    await key('Enter', 'Enter', 13)
    await until(`!document.querySelector('.cm-draft')`)
  }
  const threadWith = async (words: string) => { await until(`window.__mvComments.getState().threads.some((t) => t.messages?.[0]?.body === ${JSON.stringify(words)} || t.body === ${JSON.stringify(words)})`); return ev(`(() => { const t = window.__mvComments.getState().threads.find((t) => t.messages?.[0]?.body === ${JSON.stringify(words)} || t.body === ${JSON.stringify(words)}); return { id: t.id, anchor: t.anchor, nodeKey: t.nodeKey, frame: t.frame } })()`) }

  it('comment mode names the element under the pointer, a click anchors to it, and its pin sits on it', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    await b.go(s, `${dev!.origin}/#/b/main`)
    await until(`(() => { try { return !!document.querySelector('${CANVAS}').contentWindow.__mvDraw?.ready } catch { return false } })()`, 60_000)
    await ev(`window.__mvComments.getState().setMode(true)`)
    await until(`document.querySelector('${CANVAS}').contentWindow.__mvAnchorProvider?.ready()`)
    const at = await page(CANVAS, 80 + 150, 200 + 20)
    await mouse('mouseMoved', at.x, at.y); await sleep(80); await mouse('mouseMoved', at.x + 2, at.y + 1)
    // the inspector's chip names the element, not "canvas · Drawing canvas"
    await until(`(document.querySelector('${CANVAS}').contentDocument.getElementById('mv-laser-label')?.textContent ?? '').startsWith('rectangle')`, 5000)
    expect(await ev(`document.querySelector('${CANVAS}').contentDocument.getElementById('mv-draw-hl').style.display`)).toBe('block')
    await click(at.x + 2, at.y + 1)
    await comment('make the cart box friendlier')
    const t = await threadWith('make the cart box friendlier')
    expect(t.anchor.el.draw).toMatchObject({ id: 'cart', type: 'rectangle', epoch: 'e1' })
    expect(t.anchor.el.cssPath).toBeUndefined()
    expect(t.anchor.el.hue).not.toBe(210)          // the cart's blue stroke tints the pin
    expect(t.anchor.pos.fx).toBeGreaterThan(0.7)
    // the pin sits where it was clicked, on the element
    await until(`!!document.querySelector('.cm-pin[data-thread="${t.id}"]')`)
    await sleep(400)
    const pin = await pinOf(t.id)
    expect(Math.abs(pin.x - (at.x + 2))).toBeLessThan(8)
    expect(Math.abs(pin.y - (at.y + 1))).toBeLessThan(8)
  }, 120_000)

  it('a pin on a leftward arrow sits where it was clicked', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    await ev(`window.__mvComments.getState().setMode(true)`)
    const at = await page(CANVAS, 700, 110)
    await click(at.x, at.y)
    await comment('this arrow goes back')
    const t = await threadWith('this arrow goes back')
    expect(t.anchor.el.draw.id).toBe('back')
    await until(`!!document.querySelector('.cm-pin[data-thread="${t.id}"]')`)
    await sleep(400)
    const pin = await pinOf(t.id)
    expect(Math.abs(pin.x - at.x)).toBeLessThan(8)
    expect(Math.abs(pin.y - at.y)).toBeLessThan(8)
  }, 60_000)

  it('the pin follows its element when an agent moves it', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    const t = await threadWith('make the cart box friendlier')
    const before = await pinOf(t.id)
    const info = JSON.parse(readFileSync(join(root, 'design/.local/dev.json'), 'utf8'))
    const r = await fetch(`${dev!.origin}/__mv/api/draw/sketches%2Fflow`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-work': info.token }, body: JSON.stringify({ op: { kind: 'move', ids: ['cart'], dx: 0, dy: 120 }, opId: 'test-move-1' }) }).catch(() => null)
    if (!r?.ok) {
      // the CLI's own path when the API differs: a raw file edit, merged by the canvas
      const f = JSON.parse(readFileSync(file(), 'utf8'))
      const c = f.elements.find((e: any) => e.id === 'cart'); c.y += 120; c.version += 1; c.versionNonce += 7
      writeFileSync(file(), JSON.stringify(f))
    }
    await until(`(() => { const p = document.querySelector('.cm-pin[data-thread="${t.id}"]'); return !!p && Math.abs(p.getBoundingClientRect().bottom - ${before.y} - 120) < 10 })()`, 15_000)
  }, 60_000)

  it('a click on empty paper anchors a comment to that point of the drawing', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    // a comment sent ends comment mode (as on every frame): back on for the next one
    await ev(`window.__mvComments.getState().setMode(true)`)
    const at = await page(CANVAS, 700, 520)
    await click(at.x, at.y)
    await until(`!!document.querySelector('.cm-draft [placeholder="Comment here…"]')`, 5000)
    await comment('a legend goes here')
    const t = await threadWith('a legend goes here')
    expect(t.anchor.el.draw.at).toEqual({ x: 700, y: 520 })
    expect(t.anchor.el.draw.id).toBeUndefined()
  }, 60_000)

  it('while the drawing pans, pins move by translation only (no React placement per frame) and land once it stops', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    const t = await threadWith('a legend goes here')
    await ev(`window.__mvComments.getState().setActive(null)`)
    await ev(`window.__mvStore.getState().setInteract('n_flow')`)
    await until(`document.querySelector('.sh-app').classList.contains('drawing')`)
    await sleep(500)
    const pin = `document.querySelector('.cm-pin[data-thread="${t.id}"]')`
    await until(`!!${pin}`)
    const top0 = await ev(`${pin}.style.top`)
    // a wheel pan inside the drawing (its own camera), sampled while it moves
    const r = await ev(`(() => { const q = document.querySelector('${CANVAS}').getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 } })()`)
    const seen: { top: string; tr: string }[] = []
    for (let i = 0; i < 10; i++) {
      await b!.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: 40 }, s)
      await sleep(30)
      seen.push(await ev(`({ top: ${pin}.style.top, tr: ${pin}.style.translate })`))
    }
    // mid-gesture: React's placement holds still, the pin moves by translation
    expect(seen.some((x) => x.tr && x.tr !== '0px 0px')).toBe(true)
    expect(seen.every((x) => x.top === top0)).toBe(true)
    // once it stops (the drawing's 700 ms settle): placed again by React, the translation gone
    await until(`${pin}.style.top !== ${JSON.stringify(top0)} && !${pin}.style.translate`, 5000)
    await ev(`document.querySelector('${CANVAS}').contentWindow.__mvDraw.engine.view('frame', { x: 0, y: 0, zoom: 1 })`)
    await ev(`window.__mvStore.getState().setInteract(null)`)
    await until(`!document.querySelector('.sh-app').classList.contains('drawing')`)
  }, 60_000)

  it('in drawing mode C is the comment key, and Escape closes comments before it leaves the drawing', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    await ev(`window.__mvComments.getState().setMode(false)`)
    await ev(`window.__mvStore.getState().setInteract('n_flow')`)
    await until(`document.querySelector('.sh-app').classList.contains('drawing')`)
    await ev(`document.querySelector('${CANVAS}').contentWindow.focus()`)
    await key('c', 'KeyC', 67)
    await until(`window.__mvComments.getState().commentMode === true`, 5000)
    // the drawing paused its tool (picking), never left drawing mode
    await until(`document.querySelector('${CANVAS}').contentWindow.__mvDraw.engine.appState().viewModeEnabled === true`)
    await ev(`document.querySelector('${CANVAS}').contentWindow.focus()`)
    await escape()
    await until(`window.__mvComments.getState().commentMode === false`, 5000)
    expect(await ev(`window.__mvStore.getState().interact`)).toBe('n_flow')
    await ev(`document.querySelector('${CANVAS}').contentWindow.focus()`)
    await escape()
    await until(`window.__mvStore.getState().interact === null`, 5000)
  }, 60_000)

  it('a pin whose element is out of the drawing view parks in the column; a deleted element parks as gone', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    const t = await threadWith('make the cart box friendlier')
    // pan the drawing far away (its own camera)
    await ev(`document.querySelector('${CANVAS}').contentWindow.__mvDraw.engine.reveal({ x: 5000, y: 5000, w: 50, h: 50 })`)
    await until(`/\\boff\\b/.test(document.querySelector('.cm-pin[data-thread="${t.id}"]')?.className ?? '')`, 8000)
    await ev(`document.querySelector('${CANVAS}').contentWindow.__mvDraw.engine.view('frame', { x: 0, y: 0, zoom: 1 })`)
    await until(`!/\\boff\\b/.test(document.querySelector('.cm-pin[data-thread="${t.id}"]')?.className ?? 'off')`, 8000)
    // the element deleted (a file edit): the pin parks as gone - never on another element
    const f = JSON.parse(readFileSync(file(), 'utf8'))
    f.elements = f.elements.filter((e: any) => e.id !== 'cart')
    writeFileSync(file(), JSON.stringify(f))
    await until(`/\\borphan\\b/.test(document.querySelector('.cm-pin[data-thread="${t.id}"]')?.className ?? '')`, 15_000)
  }, 60_000)

  it('the elements Marver works on shimmer over the drawing, and stop when their lease ends', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    await ev(`window.__mvStore.getState().setWorkingFrom({ frames: ['sketches/flow'], boards: ['main'], drawings: { 'sketches/flow': { ids: ['pay'], lease: Date.now() + 2500 } } })`)
    await until(`!!document.querySelector('.dk-work-layer .dk-work')`, 8000)
    // over the pay box (its screen box, a few px of air around it)
    const box = await ev(`(() => { const r = document.querySelector('.dk-work').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
    const at = await page(CANVAS, 420, 200)
    expect(Math.abs(box.x + 4 - at.x)).toBeLessThan(6)
    expect(Math.abs(box.y + 4 - at.y)).toBeLessThan(6)
    expect(box.w).toBeGreaterThan(170)
    // never on Excalidraw's canvas: the shell's own layer
    expect(await ev(`document.querySelector('.dk-work').closest('.cm-layer') !== null`)).toBe(true)
    await until(`!document.querySelector('.dk-work-layer .dk-work')`, 6000)
  }, 60_000)

  it('drawing play: the same pins, a comment button, and a pick goes on the played node', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    await ev(`(() => { window.__mvStore.getState().select('n_flow'); return true })()`)
    await ev(`document.querySelector('.sh-app').focus()`)
    await key('p', 'KeyP', 80)
    await until(`(() => { try { return !!document.querySelector('.dk-playhost iframe').contentWindow.__mvDraw?.ready } catch { return false } })()`, 20_000)
    const paper = await threadWith('a legend goes here')
    await until(`!!document.querySelector('.dk-playhost .cm-pin[data-thread="${paper.id}"]')`, 10_000)
    // no second set of pins under play
    expect(await ev(`document.querySelectorAll('.cm-pin[data-thread="${paper.id}"]').length`)).toBe(1)
    expect(await ev(`!!document.querySelector('.dk-playhost button[aria-label="Comment"]')`)).toBe(true)
    await ev(`document.querySelector('.dk-playhost button[aria-label="Comment"]').click()`)
    await until(`window.__mvComments.getState().commentMode === true`)
    await until(`document.querySelector('.dk-playhost iframe').contentWindow.__mvAnchorProvider?.ready()`)
    const at = await page('.dk-playhost iframe', 420 + 90, 200 + 45)
    await click(at.x, at.y)
    await comment('pay in play')
    const t = await threadWith('pay in play')
    expect(t.anchor.el.draw.id).toBe('pay')
    expect(t.nodeKey).toBe('n_flow')
    expect(t.anchor.el.hue).toBe(210)               // a black stroke: Marver's blue
    // Escape closes comments first (the new thread's card is open), and only then leaves play
    await until(`window.__mvComments.getState().active !== null`)
    await ev(`document.querySelector('.dk-playhost iframe').contentWindow.focus()`)
    await escape()
    await until(`window.__mvComments.getState().active === null`, 5000)
    expect(await ev(`!!document.querySelector('.dk-playhost')`)).toBe(true)
    await ev(`document.querySelector('.dk-playhost iframe').contentWindow.focus()`)
    await escape()
    await until(`!document.querySelector('.dk-playhost')`, 8000)
    // the comments are in the board's log, on the drawing's frame and node
    expect(log().filter((e: any) => e.type === 'create' && e.frame === 'sketches/flow').length).toBeGreaterThanOrEqual(3)
  }, 90_000)
})
