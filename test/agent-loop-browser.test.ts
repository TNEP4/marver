import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * The agent loop, where the human meets it: a REAL dev server, a REAL browser. A link written with
 * frame ids lands on the frame (selected, in view - not the focus view), follows a frame its board
 * does not show, and `marver link` prints it; a note an agent pins from the CLI shows up at once,
 * raises Marver's pill and sits on the element its words name; a focus link opened in dev has its
 * way back to the canvas. Skips, never fails, without Chrome.
 */

const PORT = 6500 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
// the port asked for - `marver dev` moves to the next free one when it is taken (another suite's
// server, in a parallel run), so the origin is the one the server PRINTS
let ORIGIN = `http://localhost:${PORT}`

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-loop-b-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'loop-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..')
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(join(repoRoot, 'node_modules'))) { if (e !== '.bin' && e !== '.vite') symlinkSync(join(repoRoot, 'node_modules', e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  const frame = (title: string, bg: string) => `export const meta = { title: '${title}', viewport: 'mobile' }
export default () => <main style={{ minHeight: '100vh', background: '${bg}', color: '#fff', padding: 24 }}><h1 style={{ margin: '0 0 400px' }}>${title}</h1><p style={{ margin: 0 }}>Pay now with card</p></main>
`
  for (const [scene, files] of Object.entries({ shop: { cart: '#0b5', pay: '#05b' }, other: { far: '#b50' } })) {
    mkdirSync(join(root, 'design', 'scenes', scene), { recursive: true })
    for (const [f, bg] of Object.entries(files)) writeFileSync(join(root, 'design', 'scenes', scene, `${f}.tsx`), frame(f, bg))
  }
  const boards = join(root, 'design', 'boards')
  mkdirSync(boards, { recursive: true })
  // far apart, so a camera fitted to one frame cannot also be showing the other
  writeFileSync(join(boards, 'flow.json'), JSON.stringify({ version: 1, name: 'flow', order: 1, auto: false, nodes: [
    { key: 'f-cart', frame: 'shop/cart', x: 0, y: 0, w: 390, h: 844 },
    { key: 'f-pay', frame: 'shop/pay', x: 3000, y: 0, w: 390, h: 844 },
  ] }, null, 2) + '\n')
  // a Doc above a frame, on a board that lays itself out: the Doc can grow and push the frame down
  mkdirSync(join(root, 'design', 'scenes', 'docs'), { recursive: true })
  writeFileSync(join(root, 'design', 'scenes', 'docs', 'tall.tsx'), docFrame(6))
  writeFileSync(join(boards, 'stack.json'), JSON.stringify({ version: 1, name: 'stack', order: 4, auto: false, layout: { rows: [['docs'], ['shop']] }, nodes: [
    { frame: 'docs/tall' }, { key: 's-cart', frame: 'shop/cart' },
  ] }, null, 2) + '\n')
  writeFileSync(join(boards, 'empty.json'), JSON.stringify({ version: 1, name: 'empty', order: 3, auto: false, nodes: [] }, null, 2) + '\n')
  writeFileSync(join(boards, 'big.json'), JSON.stringify({ version: 1, name: 'big', order: 2, auto: false, nodes: [
    { key: 'b-far', frame: 'other/far', x: 0, y: 0, w: 390, h: 844 },
  ] }, null, 2) + '\n')
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify({ name: 'Nic', email: 'nic@example.com' }))
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  let out = ''
  server.stdout?.on('data', (d) => { out += d; const m = out.match(/→ (http:\/\/localhost:\d+)\//); if (m) ORIGIN = m[1] })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !/→ http:\/\/localhost:\d+\//.test(out)) await new Promise((r) => setTimeout(r, 100))
  while (Date.now() - t0 < 60_000) {
    const ok = await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)
    if (ok) break
    await new Promise((r) => setTimeout(r, 200))
  }
  browser = await Browser.launch()
}, 120_000)

afterAll(async () => {
  browser?.close()
  if (server && server.exitCode === null) {
    const gone = new Promise((r) => server!.once('exit', r))
    try { server.kill('SIGTERM') } catch { /* gone */ }
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))])
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
function docFrame(paras: number) {
  return `import { Doc, Md } from '@marver-design/marver/content'
export const meta = { title: 'Tall', intent: 'spec' }
export default () => <Doc><Md>{\`${Array.from({ length: paras }, (_, i) => `Paragraph ${i + 1}: the spec keeps going so the frame keeps growing.`).join('\n\n')}\`}</Md></Doc>
`
}
const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args, '--root', root], { cwd: root, encoding: 'utf8' })
async function open(b: Browser, hash: string, nodes = 2): Promise<string> {
  const s = await b.tab({ width: 1500, height: 950 })
  await b.go(s, `${ORIGIN}/${hash}`)
  await b.until(s, `document.querySelectorAll('.sh-node').length === ${nodes}`, 30_000)
  await b.send('Page.bringToFront', {}, s)
  return s
}
/** Selection, and whether each node is inside the window - once the camera has settled. */
const VIEW = `(() => {
  const inside = (el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }
  const nodes = [...document.querySelectorAll('[data-node]')].filter((n) => n.classList.contains('sh-node'))
  return { hash: location.hash, sel: nodes.filter((n) => n.classList.contains('sel')).map((n) => n.dataset.node), visible: nodes.filter(inside).map((n) => n.dataset.node) }
})()`

describe('a link that lands on the work', () => {
  it('#/b/<board>?f=<frame> opens the canvas on that frame: selected, in view, the URL back to the shell\'s own form', async () => {
    if (!browser) return
    const s = await open(browser, '#/b/flow?f=shop/pay')
    // the fit animates (320ms, longer on a loaded machine): wait for the settled view, not a clock
    const v = await browser.until(s, `(() => { const v = ${VIEW}; return v.sel.join() === 'f-pay' && v.visible.join() === 'f-pay' && v })()`, 15_000)
    expect(v).toEqual({ hash: '#/b/flow?n=f-pay', sel: ['f-pay'], visible: ['f-pay'] })
    expect(await browser.eval(s, `!!document.querySelector('.sh-play')`)).toBe(false)   // canvas mode, never focus
    // the tab says the board, then the canvas - the name the sidebar heads it with, never "Marver"
    const tab = await browser.eval(s, `({ title: document.title, name: document.querySelector('.sh-panel .name')?.textContent })`)
    expect(tab.name).toBeTruthy()
    expect(tab.title).toBe(`Flow - ${tab.name}`)
  })

  it('?s=<scene> selects every frame of the scene', async () => {
    if (!browser) return
    const s = await open(browser, '#/b/flow?s=shop')
    const v = await browser.until(s, `(() => { const v = ${VIEW}; return v.sel.length === 2 && v.visible.length === 2 && v })()`, 15_000)
    expect(v.visible.sort()).toEqual(['f-cart', 'f-pay'])
  })

  it('a frame the board does not show is followed to the board that does', async () => {
    if (!browser) return
    const s = await open(browser, '#/b/flow?f=other/far', 1)   // it leaves the 2-frame board for the 1-frame one
    await browser.until(s, `location.hash === '#/b/big?n=b-far'`, 20_000)
    await browser.until(s, `(() => { const v = ${VIEW}; return v.sel.join() === 'b-far' && v.visible.join() === 'b-far' })()`, 15_000)
  }, 30_000)

  it('...even from a board with no frames at all', async () => {
    if (!browser) return
    const s = await open(browser, '#/b/empty?f=other/far', 1)
    await browser.until(s, `location.hash === '#/b/big?n=b-far'`, 20_000)
  }, 30_000)

  it('a newer link wins over a reveal still on its way to another board', async () => {
    if (!browser) return
    const s = await open(browser, '#/b/flow')
    // follow a frame that lives on another board, then - before that lands - a link on this board
    await browser.eval(s, `(() => { location.hash = '#/b/flow?f=other/far'; setTimeout(() => { location.hash = '#/b/flow?f=shop/pay' }, 5) })()`)
    await wait(2500)               // long past any board load: whatever was going to land has landed
    expect(await browser.eval(s, VIEW)).toMatchObject({ hash: '#/b/flow?n=f-pay', sel: ['f-pay'] })
  }, 30_000)

  it('a link followed while a Doc above its frame is still growing lands on the frame - the rows move after the camera does', async () => {
    if (!browser) return
    const s = await open(browser, '#/b/stack')
    const DOC = `[...document.querySelectorAll('.sh-node')].find((x) => x.querySelector('iframe')?.src.includes('tall'))`
    await browser.until(s, `(() => { const n = ${DOC}; return n && n.offsetHeight > 200 })()`, 20_000)
    await wait(1500)                                  // settled: measured, laid out
    // In the page: the instant the Doc's new height lands (its reflow is then due in 400 ms), wait 200 ms
    // and follow a link to the frame below - so the link's 320 ms fit is certainly in flight when the
    // reflow comes due, every run.
    const armed = browser.eval(s, `new Promise((done) => {
      const n = ${DOC}, h0 = n.offsetHeight
      const tick = () => n.offsetHeight > h0 + 2000 ? setTimeout(() => { location.hash = '#/b/stack?f=shop/cart'; done(true) }, 200) : requestAnimationFrame(tick)
      tick()
    })`)
    writeFileSync(join(root, 'design', 'scenes', 'docs', 'tall.tsx'), docFrame(400))   // the agent makes the doc far taller
    await armed
    // a node's place on the board is its translate (world px), not its offsetTop
    const Y = `((n) => +/translate\\([-\\d.]+px, ([-\\d.]+)px\\)/.exec(n.style.transform)[1])`
    const CART = `(() => { const n = document.querySelector('[data-node="s-cart"]'), d = ${DOC}, r = n.getBoundingClientRect()
      return { sel: n.classList.contains('sel'), below: ${Y}(n) > ${Y}(d) + d.offsetHeight, top: Math.round(r.top), h: innerHeight } })()`
    // the reflow ran - the row moved below the taller Doc - and the frame the link named is on screen
    const v = await browser.until(s, `(() => { const v = ${CART}; return v.below && v }) ()`, 10_000)
    await wait(600)
    const after = await browser.eval(s, CART)
    expect(after).toMatchObject({ sel: true, below: true })
    expect(after.top).toBeGreaterThanOrEqual(0)
    expect(after.top).toBeLessThan(after.h)
    expect(v.below).toBe(true)

    // a camera that never stops - a fit every 250 ms, kept up until the rows have moved - still lets them
    // move, and within the wait's bound: timed from the instant the Doc's new height lands
    const moved = browser.eval(s, `new Promise((done) => {
      let i = 0
      const spam = setInterval(() => { location.hash = i++ % 2 ? '#/b/stack?f=shop/cart' : '#/b/stack?f=docs/tall' }, 250)
      const d = ${DOC}, h0 = d.offsetHeight
      const grown = () => {
        if (d.offsetHeight <= h0 + 2000) return requestAnimationFrame(grown)
        const t0 = performance.now()
        const watch = () => {
          const n = document.querySelector('[data-node="s-cart"]')
          if (${Y}(n) > ${Y}(d) + d.offsetHeight) { clearInterval(spam); return done(Math.round(performance.now() - t0)) }
          if (performance.now() - t0 > 8000) { clearInterval(spam); return done(-1) }
          requestAnimationFrame(watch)
        }
        watch()
      }
      grown()
    })`)
    writeFileSync(join(root, 'design', 'scenes', 'docs', 'tall.tsx'), docFrame(700))
    const ms = await moved
    expect(ms).toBeGreaterThan(0)                     // -1: the rows never moved while the camera kept moving
    expect(ms).toBeLessThan(2600)                     // the 400 ms debounce + the 1.5 s bound, and room for a slow machine
  }, 60_000)

  it('marver link prints that link with the running port; work done prints it for what it cleared', () => {
    if (!browser) return
    expect(cli('link', 'shop/pay').trim()).toBe(`${ORIGIN}/#/b/flow?f=shop/pay`)
    expect(cli('link', 'shop').trim()).toBe(`${ORIGIN}/#/b/flow?s=shop`)
    cli('work', 'start', 'shop/cart')
    expect(cli('work', 'done', 'shop/cart')).toContain(`on the canvas: ${ORIGIN}/#/b/flow?f=shop/cart`)
    cli('work', 'start', 'shop/cart', 'shop/pay')
    expect(cli('work', 'done', '--all')).toMatch(new RegExp(`on the canvas: ${ORIGIN}/#/b/flow\\?f=shop/(cart,shop/pay|pay,shop/cart)`))
  })
})

describe('a note from the agent', () => {
  it('lands at once, raises Marver\'s pill, and pins on the element its words name', async () => {
    if (!browser) return
    const s = await open(browser, '#/b/flow')
    await wait(1500)   // the board's comments baseline - what follows is news
    const out = cli('comments', 'new', 'shop/cart', '--on', 'Pay now', '--body', 'Card first, wallet below - right call?')
    const thread = out.match(/\?c=([\w-]+)/)?.[1]
    expect(out).toContain(`pinned a note on shop/cart (board flow): ${ORIGIN}/#/b/flow?c=`)
    // well inside the 30s poll: the dev server's watch on design/comments/ pokes the page
    const pill = await browser.until(s, `(() => { const t = document.querySelector('.sh-toast.jam'); return t && t.textContent })()`, 8000)
    expect(pill).toContain('Card first, wallet below - right call?')
    // View: the frame selected, the thread open, the pin on the paragraph that reads "Pay now..."
    await browser.eval(s, `document.querySelector('.sh-toast.jam .sh-jam-view').click()`)
    await browser.until(s, `!!document.querySelector('[data-node="f-cart"].sel') && !!document.querySelector('[data-node="f-cart"] .cm-card')`, 10_000)
    const pin = await browser.until(s, `(() => {
      const node = document.querySelector('[data-node="f-cart"]')
      const pin = node.querySelector('.cm-pin'); const ifr = node.querySelector('iframe')
      const p = ifr?.contentDocument?.querySelector('p')
      if (!pin || !p || pin.classList.contains('orphan')) return null
      const ir = ifr.getBoundingClientRect(), k = ir.width / ifr.contentWindow.innerWidth, pr = p.getBoundingClientRect(), r = pin.getBoundingClientRect()
      const top = ir.top + pr.top * k, bottom = ir.top + pr.bottom * k
      return { onRow: r.bottom >= top - 6 && r.top <= bottom + 6, rightHalf: r.left > ir.left + ir.width / 2 }
    })()`, 15_000)
    expect(pin).toEqual({ onRow: true, rightHalf: true })
    expect(await browser.eval(s, `document.querySelector('[data-node="f-cart"] .cm-card .cm-marver-name')?.textContent`)).toBe('Marver')
    expect(thread).toBeTruthy()
  })
})

describe('a focus link in dev', () => {
  it('keeps its way back: Esc returns to the canvas on that frame, on the board that shows it', async () => {
    if (!browser) return
    const s = await open(browser, '#/f/other/far')
    await browser.until(s, `!!document.querySelector('.sh-play')`)
    expect(await browser.eval(s, `document.querySelectorAll('.sh-play-pill .sh-pill-btn').length`)).toBeGreaterThan(0)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, s)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, s)
    await browser.until(s, `!document.querySelector('.sh-play') && location.hash === '#/b/big?n=b-far'`, 20_000)
  })
})
