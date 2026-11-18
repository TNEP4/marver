import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'
import { stableNodeKey } from '../src/client/shell/keys.ts'

/**
 * No more All Scenes (spec 26, Part 7), where a person meets it: a REAL dev server, a REAL browser.
 * A canvas with no board yet shows its empty state and lands on the frames it has; the Not on a board
 * view shows them as any board would - a TSX frame, an HTML frame, a sticky note, an old thread -
 * takes no new comment and puts a frame on a board; and every old All Scenes link lands on a real
 * board, back and forward included. Skips, never fails, without Chrome.
 */

const PORT = 6900 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
let ORIGIN = `http://localhost:${PORT}`

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let log = ''

const put = (rel: string, body: string | object) => {
  const f = join(root, rel)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}
const frame = (title: string, bg: string) => `export const meta = { title: '${title}', viewport: 'mobile' }
export default () => <main style={{ minHeight: '100vh', background: '${bg}', color: '#fff', padding: 24 }}><h1>${title}</h1></main>
`
const thread = (id: string, frameId: string) => JSON.stringify({ id: `ev-${id}`, ts: Date.now() - 60_000, type: 'create', commentId: id, board: 'all-scenes', frame: frameId, author: { name: 'Dana', email: 'dana@x.test' }, body: `about ${frameId}` })

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-unplaced-'))
  put('package.json', { name: 'unplaced-fixture', private: true, type: 'module' })
  const repoRoot = join(import.meta.dirname, '..')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(join(repoRoot, 'node_modules'))) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver' && e !== '@marver-design') symlinkSync(join(repoRoot, 'node_modules', e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  put('design/scenes/shop/cart.tsx', frame('Cart', '#0b5'))
  put('design/scenes/shop/pay.tsx', frame('Pay', '#05b'))
  put('design/scenes/other/far.tsx', frame('Far', '#b50'))
  put('design/scenes/loose/idea.tsx', frame('Idea', '#509'))
  put('design/scenes/loose/idea.note.md', 'A sticky note on the idea.')
  put('design/scenes/loose/page.html', '<!doctype html><html><body style="background:#333;color:#fff"><h1>A page</h1></body></html>\n')
  // no board yet - and what 0.24 left behind: a leftover all-scenes.json that is not even JSON, and its comment log
  put('design/boards/all-scenes.json', '{ "version": 1, "nodes": [')
  put('design/boards/_folders.json', { version: 1, folders: [{ name: 'features', order: 0 }] })   // init's empty folders: still no board
  put('design/comments/all-scenes.jsonl', [thread('t-idea-000', 'loose/idea'), thread('t-pay-0000', 'shop/pay')].join('\n') + '\n')
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d; const m = log.match(/→ (http:\/\/localhost:\d+)\//); if (m) ORIGIN = m[1] })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !/→ http:\/\/localhost:\d+\//.test(log)) await new Promise((r) => setTimeout(r, 100))
  while (Date.now() - t0 < 60_000) {
    if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break
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

const skippable = (name: string, fn: () => Promise<void>, ms = 60_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)
async function open(hash: string, early?: string): Promise<string> {
  const s = await browser!.tab({ width: 1500, height: 950 })
  if (early) await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: early }, s)
  await browser!.go(s, `${ORIGIN}/${hash}`)
  await browser!.until(s, `!!window.__mvStore && !!window.__mvStore.getState().manifest`, 30_000)
  await browser!.send('Page.bringToFront', {}, s)
  return s
}
/** The board on screen, its frames, what is selected, and the URL. */
const STATE = `(() => { const st = window.__mvStore.getState(); return { board: st.board, frames: st.nodes.map((n) => n.frame).sort(), sel: st.nodes.filter((n) => st.selection.includes(n.key)).map((n) => n.frame).sort(), hash: location.hash, toasts: st.toasts.map((t) => t.text) } })()`
const state = (s: string) => browser!.eval(s, STATE)
const settled = (s: string, cond: string, ms = 20_000) => browser!.until(s, `(() => { const v = ${STATE}; return (${cond}) && v })()`, ms)
  .catch(async (e) => { throw new Error(`${(e as Error).message.slice(0, 80)}... - the page: ${JSON.stringify(await state(s))}`) })

describe('a canvas with no board yet', () => {
  skippable('shows its empty state and lands on the frames it has; a malformed leftover all-scenes.json changes nothing but one dev log line', async () => {
    const s = await open('')
    const v = await settled(s, `v.board === '~unplaced' && v.frames.length === 5 && v.hash === '#/b/~unplaced'`)
    expect(v.frames).toEqual(['loose/idea', 'loose/page', 'other/far', 'shop/cart', 'shop/pay'])
    expect(v.hash).toBe('#/b/~unplaced')
    await browser!.until(s, `!!document.querySelector('[data-no-boards]') && !!document.querySelector('[data-unplaced]')`)
    expect(await browser!.eval(s, `document.querySelector('[data-no-boards]').textContent`)).toBe('No boards yet - ask your agent to make one')
    expect(await browser!.eval(s, `document.querySelector('[data-unplaced]').textContent`)).toBe('Not on a board5')
    expect(await browser!.eval(s, `document.querySelectorAll('.sh-boards [data-board-row]').length`)).toBe(0)   // no All Scenes row, ever
    expect(log.match(/all-scenes\.json is left over/g)).toHaveLength(1)
    expect(log).not.toMatch(/all-scenes\.json is not valid JSON/)
    expect(log).toMatch(/not on a board \(5\): loose\/idea, loose\/page, other\/far, shop\/cart, shop\/pay - every frame goes on the board it belongs to: npx marver boards pin <board> <scene\/frame \.\.\.>/)
  })
})

describe('the Not on a board view', () => {
  skippable('shows a TSX frame, an HTML frame, a sticky note and an old thread; takes no new comment; Add to board puts a frame on one', async () => {
    // the agent makes boards: the archive ranks first, and every board but the archive shows a frame of the shop
    put('design/boards/archive.json', { version: 1, name: 'archive', order: 0, type: 'archive', nodes: [{ frame: 'shop/pay' }] })
    put('design/boards/flow.json', { version: 1, name: 'flow', order: 1, nodes: [{ frame: 'shop/cart' }, { frame: 'shop/pay' }] })
    put('design/boards/big.json', { version: 1, name: 'big', order: 2, nodes: [{ frame: 'other/far' }] })
    const s = await open('#/b/~unplaced')
    const v = await settled(s, `v.frames.join() === 'loose/idea,loose/page'`)
    expect(v.board).toBe('~unplaced')
    // laid out like a composed board - one band of their scenes - so a frame that grows reflows the rest
    expect(await browser!.eval(s, `JSON.stringify(window.__mvStore.getState().layoutRaw)`)).toBe('{"rows":[["loose"]]}')
    await browser!.until(s, `document.querySelector('[data-unplaced]')?.textContent === 'Not on a board2' && !document.querySelector('[data-no-boards]')`)
    // as on any board: the HTML frame renders, the sticky note shows, the old thread's pin is there
    await browser!.until(s, `[...document.querySelectorAll('.sh-node iframe')].some((f) => /page\\.html/.test(f.src) && f.contentDocument?.querySelector('h1')?.textContent === 'A page')`, 20_000)
    await browser!.until(s, `!!document.querySelector('.sh-sticky[data-sticky]')`)
    await browser!.until(s, `!!document.querySelector('.sh-node .cm-pin, .sh-node .cm-stack')`, 15_000)
    // a new comment needs a board to live on
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, text: 'c' }, s)
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 }, s)
    await settled(s, `v.toasts.includes('pin it on a board to comment')`)
    expect(await browser!.eval(s, `window.__mvComments.getState().commentMode`)).toBe(false)
    // Add to board: the frame's menu in the sidebar, then the board
    const row = await browser!.until(s, `(() => { const el = [...document.querySelectorAll('.sh-panel .sub')].find((x) => x.textContent.includes('Page')); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + 30, y: r.top + r.height / 2 } })()`)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: row.x, y: row.y, button: 'right', clickCount: 1 }, s)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row.x, y: row.y, button: 'right', clickCount: 1 }, s)
    await browser!.until(s, `!![...document.querySelectorAll('.sh-ctxmenu button')].find((b) => b.textContent === 'Add to board…')`)
    await browser!.eval(s, `[...document.querySelectorAll('.sh-ctxmenu button')].find((b) => b.textContent === 'Add to board…').click()`)
    await browser!.until(s, `!!document.querySelector('[data-add-to="big"]')`)
    expect(await browser!.eval(s, `[...document.querySelectorAll('[data-add-to]')].map((b) => b.dataset.addTo).join()`)).toBe('archive,flow,big')
    await browser!.eval(s, `document.querySelector('[data-add-to="big"]').click()`)
    await settled(s, `v.frames.join() === 'loose/idea'`)                                  // it left the view
    expect(JSON.parse(readFileSync(join(root, 'design', 'boards', 'big.json'), 'utf8')).nodes).toEqual([{ frame: 'other/far' }, { frame: 'loose/page' }])
    await browser!.until(s, `document.querySelector('[data-unplaced]')?.textContent === 'Not on a board1'`)
  })

  skippable('focus leaving a frame no board shows lands in the Not on a board view', async () => {
    const s = await open('#/f/loose/idea')
    await browser!.until(s, `!!document.querySelector('.sh-play')`, 20_000)
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, s)
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, s)
    await settled(s, `v.board === '~unplaced' && v.sel.join() === 'loose/idea'`)
  })
})

describe('every old All Scenes link lands on a real board', () => {
  skippable('a thread: the first board that shows its frame, archive boards last, the thread open', async () => {
    const s = await open('#/b/all-scenes?c=t-pay-0000')
    const v = await settled(s, `v.board === 'flow'`)
    expect(v.hash).toMatch(/^#\/b\/flow/)
    await browser!.until(s, `window.__mvComments.getState().active === 't-pay-0000' && !!document.querySelector('.cm-card')`, 15_000)
  })

  skippable('frames on two boards: the board showing most of them, those selected, a notice naming where the rest are', async () => {
    const s = await open('#/b/all-scenes?f=shop/cart,shop/pay,other/far')
    const v = await settled(s, `v.board === 'flow' && v.sel.length === 2`)
    expect(v.sel).toEqual(['shop/cart', 'shop/pay'])
    expect(v.toasts).toContain('2 of 3 here - other/far is on Big')
    // a scene works the same; frames on no board at all open the Not on a board view
    await settled(await open('#/b/all-scenes?s=shop'), `v.board === 'flow' && v.sel.join() === 'shop/cart,shop/pay'`)
    await settled(await open('#/b/all-scenes?f=loose/idea'), `v.board === '~unplaced' && v.sel.join() === 'loose/idea'`)
  })

  skippable('node keys: from a leftover all-scenes.json, else the keys the old board gave each frame; none recovered: the landing board and a notice', async () => {
    const s = await open(`#/b/all-scenes?n=${stableNodeKey('all-scenes', 'other/far', 0)}`)
    await settled(s, `v.board === 'big' && v.sel.join() === 'other/far'`)
    put('design/boards/all-scenes.json', { version: 1, name: 'all-scenes', auto: true, nodes: [{ key: 'n_kept', frame: 'shop/cart' }] })
    const s2 = await open('#/b/all-scenes?n=n_kept')
    await settled(s2, `v.board === 'flow' && v.sel.join() === 'shop/cart'`)
    const s3 = await open('#/b/all-scenes?n=n_nowhere')
    const v = await settled(s3, `v.board === 'archive'`)                                // the landing board: first in the sidebar
    expect(v.toasts).toContain('the frames that link named could not be found - opened the first board')
  })

  skippable('play keeps its device, theme and mode; the bare link and #/ open the landing board', async () => {
    const s = await open('#/p/all-scenes?at=other/far&device=laptop&theme=dark')
    await settled(s, `v.board === 'big' && /^#\\/p\\/big\\?at=other%2Ffar&device=laptop&theme=dark$/.test(v.hash)`)
    expect(await browser!.eval(s, `window.__mvStore.getState().play`)).toMatchObject({ at: 'other/far', device: 'laptop', theme: 'dark' })
    await settled(await open('#/b/all-scenes'), `v.board === 'archive' && v.hash.startsWith('#/b/archive')`)
    await settled(await open('#/'), `v.board === 'archive'`)
    // and #/ in a tab already open on another board
    const s2 = await open('#/b/big')
    await settled(s2, `v.board === 'big'`)
    await browser!.eval(s2, `location.hash = '#/'`)
    await settled(s2, `v.board === 'archive'`)
  })

  skippable('back and forward: a pasted old link lands, back returns, forward lands again', async () => {
    const s = await open('#/b/big')
    await settled(s, `v.board === 'big'`)
    await browser!.eval(s, `location.hash = '#/b/all-scenes?f=shop/pay'`)
    await settled(s, `v.board === 'flow' && v.sel.join() === 'shop/pay' && v.hash.startsWith('#/b/flow')`)
    await browser!.eval(s, `history.back()`)
    await settled(s, `v.board === 'big' && v.hash.startsWith('#/b/big')`)
    await browser!.eval(s, `history.forward()`)
    await settled(s, `v.board === 'flow' && v.sel.join() === 'shop/pay'`)
  })

  // A link followed while the board's frames are still acknowledging their theme: the router's first store read applies
  // the pending acks, the shell renders, and its projection writes the board on screen over the URL before the
  // hashchange arrives - which read location.hash and found nothing to do, and the first event gave way to it. Forced,
  // not left to timing: an ack queued as the link is followed, or as back/forward's popstate arrives (a listener the
  // page installs before the shell's); and, theme acks aside, any update the shell renders in that moment (a toast).
  skippable('a link, back and forward land while a theme ack or any update lands in the same moment', async () => {
    const ack = `(() => { const st = window.__mvStore.getState(), n = st.nodes[0]; st.setThemeOn(n.key, n.themeOn === 'dark' ? 'light' : 'dark') })()`
    const s = await open('#/b/big')
    await settled(s, `v.board === 'big' && v.frames.length > 0`)
    await browser!.eval(s, `${ack}; location.hash = '#/'`)
    await settled(s, `v.board === 'archive' && v.hash.startsWith('#/b/archive')`)
    const s2 = await open('#/b/big')
    await settled(s2, `v.board === 'big' && v.frames.length > 0`)
    await browser!.eval(s2, `location.hash = '#/'; window.__mvStore.getState().toast('unrelated')`)
    await settled(s2, `v.board === 'archive' && v.hash.startsWith('#/b/archive')`)
    const s3 = await open('#/b/big', `addEventListener('popstate', () => { if (window.__ackOnPop) { window.__ackOnPop = false; ${ack} } })`)
    await settled(s3, `v.board === 'big' && v.frames.length > 0`)
    await browser!.eval(s3, `${ack}; location.hash = '#/b/all-scenes?f=shop/pay'`)
    await settled(s3, `v.board === 'flow' && v.sel.join() === 'shop/pay' && v.hash.startsWith('#/b/flow')`)
    await browser!.eval(s3, `window.__ackOnPop = true; history.back()`)
    await settled(s3, `v.board === 'big' && v.hash.startsWith('#/b/big')`)
    await browser!.eval(s3, `window.__ackOnPop = true; history.forward()`)
    await settled(s3, `v.board === 'flow' && v.sel.join() === 'shop/pay' && v.hash.startsWith('#/b/flow')`)
  })

  // A popstate routes its navigation; its hashchange, queued behind it, is the same navigation and is never routed
  // again - whatever came between (a goto, a click, a second link) is newer than it.
  skippable('the hashchange that follows a popstate is that navigation, not a newer one: a second link, nine in one task, a goto and back stand', async () => {
    const hashes = (n: number) => `new Promise((r) => { let k = 0; addEventListener('hashchange', () => { if (++k === ${n}) setTimeout(r, 50) }) })`
    const s = await open('#/b/flow')
    await settled(s, `v.board === 'flow' && v.frames.length === 2`)
    // two links before the first one's hashchange (popstate A, popstate B, hashchange A, hashchange B): the second
    // lands; the first's board is read once, by its popstate - its hashchange, routed again, read it a second time
    // (and the second link's hashchange then cancelled that) - and never commits
    await browser!.eval(s, `window.__boards = []; window.__mvStore.subscribe((x) => window.__boards.push(x.board)); window.__reads = []; const f = window.fetch; window.fetch = function (u, ...r) { const m = String(u).match(/\\/api\\/boards\\/([^/?]+)$/); if (m) window.__reads.push(m[1]); return f.call(this, u, ...r) }`)
    await browser!.eval(s, `(() => { const done = ${hashes(2)}; location.hash = '#/b/big'; location.hash = '#/b/flow?f=shop/cart'; return done })()`)
    await new Promise((r) => setTimeout(r, 1500))   // the first link's board would have loaded by now
    let v = await settled(s, `v.board === 'flow' && v.sel.join() === 'shop/cart' && v.hash.startsWith('#/b/flow?n=')`)
    expect(await browser!.eval(s, `window.__boards.includes('big')`)).toBe(false)
    expect(await browser!.eval(s, `window.__reads.filter((b) => b === 'big').length`)).toBe(1)
    // nine links in one task: nine popstates, then nine hashchanges - the first one's, still owed, is never routed again
    await browser!.eval(s, `window.__reads.length = 0`)
    const nine = ['#/b/big', ...[2, 3, 4, 5, 6, 7, 8].map((k) => `#/b/flow?f=shop/cart&v=${k}`), '#/b/flow?f=shop/pay']
    await browser!.eval(s, `(() => { const done = ${hashes(9)}; for (const h of ${JSON.stringify(nine)}) location.hash = h; return done })()`)
    await new Promise((r) => setTimeout(r, 1500))
    v = await settled(s, `v.board === 'flow' && v.sel.join() === 'shop/pay' && v.hash.startsWith('#/b/flow?n=')`)
    expect(await browser!.eval(s, `window.__boards.includes('big')`)).toBe(false)
    expect(await browser!.eval(s, `window.__reads.filter((b) => b === 'big').length`)).toBe(1)
    // a link to Cart, then - before its hashchange - a goto (a frame's, a click) selects Pay: Pay stands
    await browser!.eval(s, `(() => { const done = ${hashes(1)}; location.hash = '#/b/flow?f=shop/cart'; const st = window.__mvStore.getState(); st.select(st.nodes.find((n) => n.frame === 'shop/pay').key); return done })()`)
    v = await state(s)
    expect(v.sel).toEqual(['shop/pay'])
    expect(v.hash).toMatch(/^#\/b\/flow\?n=/)
    // a URL pasted in the address bar (a same-document navigation the browser makes); back returns
    await browser!.send('Page.navigate', { url: `${ORIGIN}/#/b/archive` }, s)
    await settled(s, `v.board === 'archive' && v.hash.startsWith('#/b/archive')`)
    await browser!.eval(s, `history.back()`)
    await settled(s, `v.board === 'flow' && v.sel.join() === 'shop/pay'`)
    // a hashchange with no popstate before it (a browser that fires only that) is routed from the URL it carries; a
    // synthetic one with none, from the URL
    await browser!.eval(s, `history.replaceState(null, '', '#/b/big'); dispatchEvent(new HashChangeEvent('hashchange', { oldURL: location.href, newURL: location.href }))`)
    await settled(s, `v.board === 'big' && v.hash === '#/b/big'`)
    await browser!.eval(s, `history.replaceState(null, '', '#/b/archive'); dispatchEvent(new Event('hashchange'))`)
    await settled(s, `v.board === 'archive' && v.hash.startsWith('#/b/archive')`)
  })

  // A play link to another board, followed in play: the stage closes while that board loads (a render that wrote the
  // canvas over the link before its hashchange, which then read that and undid the link) - it lands in play there.
  // Where its landing leaves the history (it pushes an entry) is not settled here.
  skippable('a play link to another board, followed in play, lands in play there', async () => {
    const PLAY = `(() => { const st = window.__mvStore.getState(); return { board: st.board, at: st.play?.at, hash: location.hash } })()`
    const playing = (s: string, cond: string) => browser!.until(s, `(() => { const v = ${PLAY}; return (${cond}) && v })()`, 20_000)
      .catch(async (e) => { throw new Error(`${(e as Error).message.slice(0, 60)}... - the page: ${JSON.stringify(await browser!.eval(s, PLAY))}`) })
    const s = await open('#/p/flow?at=shop/cart')
    await playing(s, `v.board === 'flow' && v.at === 'shop/cart' && v.hash.startsWith('#/p/flow?at=shop%2Fcart')`)
    await browser!.eval(s, `location.hash = '#/p/big?at=other/far'`)
    await playing(s, `v.board === 'big' && v.at === 'other/far' && v.hash.startsWith('#/p/big?at=other%2Ffar')`)
  })
})
