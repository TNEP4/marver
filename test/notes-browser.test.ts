import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Sticky notes (spec 18), proven where they live: a REAL dev server, a REAL browser. The column
 * renders left of its frame with prose and a hand-drawn diagram; the dog-ear folds it and the tab
 * brings it back; N hides every note; a comment persisted on a note pins ON the note and follows
 * the fold; comment mode picks a note element; a goto: link navigates; an edit to the note file
 * updates the sticky without touching the iframe. Skips, never fails, without Chrome.
 */

const PORT = 6100 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const ORIGIN = `http://localhost:${PORT}`

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let log = ''

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')   // 1x1

const NOTE = `## Why the jobs list leads

Drivers ask "where am I going first", so the list beats the map.

Compare with the [next screen](goto:app/next): same header, no list.

\`\`\`mermaid
flowchart LR
  Login --> Today --> Jobs
\`\`\`

![the flow](flow.png)
`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-notes-b-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'notes-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..')
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  // .vite stays out: each fixture's dev server keeps its own dependency cache - a shared one is rewritten
  // by a parallel suite's server while this one's page loads a lazy engine (mermaid, echarts) from it
  for (const e of readdirSync(join(repoRoot, 'node_modules'))) { if (e !== '.bin' && e !== '.vite') symlinkSync(join(repoRoot, 'node_modules', e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  const scene = join(root, 'design', 'scenes', 'app')
  mkdirSync(scene, { recursive: true })
  const frame = (title: string, bg: string) => `export const meta = { title: '${title}', viewport: 'mobile' }
export default () => <main style={{ minHeight: '100vh', background: '${bg}' }}><h1 style={{ margin: 0, padding: 24, color: '#fff' }}>${title}</h1></main>
`
  writeFileSync(join(scene, 'home.tsx'), frame('Home', '#0b5'))
  writeFileSync(join(scene, 'next.tsx'), frame('Next', '#05b'))
  writeFileSync(join(scene, 'home.note.md'), NOTE)
  writeFileSync(join(scene, '_note.md'), `# App\n\nThe driver's day, three screens.\n`)
  mkdirSync(join(root, 'design', 'assets'), { recursive: true })
  writeFileSync(join(root, 'design', 'assets', 'flow.png'), PNG)
  const boards = join(root, 'design', 'boards')
  mkdirSync(boards, { recursive: true })
  writeFileSync(join(boards, 'notes.json'), JSON.stringify({ version: 1, name: 'notes', auto: false, nodes: [
    { key: 'n-home', frame: 'app/home', x: 0, y: 0, w: 390, h: 844 },
    { key: 'n-next', frame: 'app/next', x: 600, y: 0, w: 390, h: 844 },
  ] }, null, 2) + '\n')
  // a composed board saved before its notes existed: the frames sit tight, no room for a column
  writeFileSync(join(boards, 'recipe.json'), JSON.stringify({ version: 1, name: 'recipe', auto: false, layout: { rows: [['app']] }, nodes: [
    { key: 'r-home', frame: 'app/home', x: 0, y: 0, w: 390, h: 844 },
    { key: 'r-next', frame: 'app/next', x: 420, y: 0, w: 390, h: 844 },
  ] }, null, 2) + '\n')
  // the same, never opened while the note existed: the load must make the room
  writeFileSync(join(boards, 'closed.json'), JSON.stringify({ version: 1, name: 'closed', auto: false, layout: { rows: [['app']] }, nodes: [
    { key: 'c-home', frame: 'app/home', x: 0, y: 0, w: 390, h: 844 },
    { key: 'c-next', frame: 'app/next', x: 420, y: 0, w: 390, h: 844 },
  ] }, null, 2) + '\n')
  // two rows the cards alone would make, saved tight: `next` above `home` (the scene note hosts on
  // `next`, first in reading order); a note longer than `next` must push `home`'s row down
  writeFileSync(join(boards, 'stack.json'), JSON.stringify({ version: 1, name: 'stack', auto: false, layout: { rows: [['app']], scenes: { app: { rows: [['next'], ['home']] } } }, nodes: [
    { key: 's-next', frame: 'app/next', x: 404, y: 0, w: 390, h: 844 },
    { key: 's-home', frame: 'app/home', x: 284, y: 1012, w: 390, h: 844 },
  ] }, null, 2) + '\n')
  // a thread pinned on the frame note's second paragraph - persisted, as a collaborator left it
  const comments = join(root, 'design', 'comments')
  mkdirSync(comments, { recursive: true })
  const anchor = { el: { semantics: { tag: 'p', quote: 'Compare with the next screen: same header, no list.' }, cssPath: 'p:nth-of-type(2)', note: 'frame', hue: 48 }, pos: { fx: 0.5, fy: 0.5 }, rect: { x: -200, y: 80, w: 200, h: 30 } }
  writeFileSync(join(comments, 'notes.jsonl'), JSON.stringify({ id: 'ev-1', ts: Date.now(), type: 'create', commentId: 'th-1', board: 'notes', nodeKey: 'n-home', frame: 'app/home', anchor, author: { email: 'sam@example.com', name: 'Sam' }, body: 'Is the map really second?' }) + '\n')
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000) {
    const ok = await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)
    if (ok) break
    await new Promise((r) => setTimeout(r, 200))
  }
  browser = await Browser.launch()
}, 120_000)

afterAll(() => {
  browser?.close()
  try { server?.kill('SIGTERM') } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const centre = (b: Browser, s: string, selector: string) => b.eval(s, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, w: r.width, h: r.height } })()`)
async function click(b: Browser, s: string, at: { x: number; y: number }) {
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y }, s)
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
}
async function open(b: Browser): Promise<string> {
  const s = await b.tab({ width: 1500, height: 950 })
  await b.go(s, `${ORIGIN}/#/b/notes`)
  await b.until(s, `document.querySelectorAll('.sh-node').length === 2 && document.querySelectorAll('[data-node="n-home"] .sh-notes .sh-sticky').length === 2`, 30_000)
  await b.until(s, `!!document.querySelector('[data-node="n-home"] .sh-sticky-diagram svg')`, 30_000)
  await b.send('Page.bringToFront', {}, s)
  await wait(500)
  return s
}

describe('sticky notes on the canvas', () => {
  it('renders the scene note above the frame note, left of the frame, with prose, a link and a hand-drawn diagram', async () => {
    if (!browser) return
    const s = await open(browser)
    const state = await browser.eval(s, `(() => {
      const col = document.querySelector('[data-node="n-home"] .sh-notes')
      const [scene, frame] = [...col.querySelectorAll('.sh-sticky')]
      const node = document.querySelector('[data-node="n-home"]').getBoundingClientRect()
      const c = col.getBoundingClientRect(), sr = scene.getBoundingClientRect(), fr = frame.getBoundingClientRect()
      return {
        kinds: [scene.dataset.sticky, frame.dataset.sticky], ids: [scene.dataset.note, frame.dataset.note],
        widths: [scene.offsetWidth, frame.offsetWidth], leftOfFrame: c.right < node.left, topAligned: Math.abs(c.top - node.top) < 2,
        sceneAboveFrame: sr.bottom <= fr.top, rightAligned: Math.abs(sr.right - fr.right) < 1,
        h2: frame.querySelector('h2')?.textContent, goto: frame.querySelector('a[data-goto]')?.dataset.goto,
        paths: frame.querySelectorAll('.sh-sticky-diagram svg path').length, fence: frame.querySelectorAll('pre').length,
        otherColumn: document.querySelectorAll('[data-node="n-next"] .sh-notes').length,
      }
    })()`)
    expect(state).toMatchObject({ kinds: ['scene', 'frame'], ids: ['scene:app', 'frame:app/home'], widths: [380, 260], leftOfFrame: true, topAligned: true, sceneAboveFrame: true, rightAligned: true, h2: 'Why the jobs list leads', goto: 'app/next', fence: 0, otherColumn: 0 })
    expect(state.paths).toBeGreaterThan(3)   // rough.js strokes: the hand-drawn look is many paths, not one rect
  })

  it('the dog-ear folds the column to its tab and unfolds it; the choice is the viewer’s (localStorage)', async () => {
    if (!browser) return
    const s = await open(browser)
    await click(browser, s, await centre(browser, s, '[data-node="n-home"] .sh-notes-fold'))
    await browser.until(s, `document.querySelector('[data-node="n-home"] .sh-notes').classList.contains('off')`)
    await wait(300)
    const folded = await browser.eval(s, `(() => { const st = document.querySelector('[data-node="n-home"] .sh-sticky'); const cs = getComputedStyle(st); return { visibility: cs.visibility, opacity: cs.opacity, stored: localStorage.getItem('mv-notes') } })()`)
    expect(folded.visibility).toBe('hidden')
    expect(Number(folded.opacity)).toBe(0)
    expect(JSON.parse(folded.stored).hidden).toEqual(['scene:app', 'frame:app/home'])
    await click(browser, s, await centre(browser, s, '[data-node="n-home"] .sh-notes-fold'))
    await browser.until(s, `!document.querySelector('[data-node="n-home"] .sh-notes').classList.contains('off')`)
    expect(JSON.parse(await browser.eval(s, `localStorage.getItem('mv-notes')`)).hidden).toEqual([])
  })

  it('N hides every note and brings them back', async () => {
    if (!browser) return
    const s = await open(browser)
    await browser.press(s, 'n')
    await browser.until(s, `document.querySelector('[data-node="n-home"] .sh-notes').classList.contains('off')`)
    expect(JSON.parse(await browser.eval(s, `localStorage.getItem('mv-notes')`)).all).toBe(false)
    await browser.press(s, 'n')
    await browser.until(s, `!document.querySelector('[data-node="n-home"] .sh-notes').classList.contains('off')`)
  })

  it('a thread pinned on the note sits on its paragraph, left of the frame, and moves to the tab when folded', async () => {
    if (!browser) return
    const s = await open(browser)
    await click(browser, s, await centre(browser, s, '[data-node="n-home"] .sh-node-head'))   // select: pins show on the engaged frame
    await browser.until(s, `!!document.querySelector('[data-node="n-home"] .cm-pin')`)
    const onNote = await browser.eval(s, `(() => {
      const pin = document.querySelector('[data-node="n-home"] .cm-pin')
      const p = document.querySelector('[data-node="n-home"] [data-sticky="frame"] .sh-sticky-body p:nth-of-type(2)').getBoundingClientRect()
      const r = pin.getBoundingClientRect()
      return { left: parseFloat(pin.style.left), inside: r.left >= p.left - 4 && r.left <= p.right + 4 && r.bottom >= p.top - 4 && r.bottom <= p.bottom + 40, orphan: pin.classList.contains('orphan') }
    })()`)
    expect(onNote.left).toBeLessThan(0)
    expect(onNote.orphan).toBe(false)
    expect(onNote.inside).toBe(true)
    // opening the thread docks its card beside the column, never over it
    await click(browser, s, await centre(browser, s, '[data-node="n-home"] .cm-pin'))
    await browser.until(s, `!!document.querySelector('[data-node="n-home"] .cm-card.parked')`)
    const card = await browser.eval(s, `(() => {
      const card = document.querySelector('[data-node="n-home"] .cm-card.parked')
      const col = document.querySelector('[data-node="n-home"] .sh-notes').getBoundingClientRect()
      const r = card.getBoundingClientRect()
      const frame = document.querySelector('[data-node="n-home"]').getBoundingClientRect()
      return { flank: card.classList.contains('flank-note'), side: card.classList.contains('dock-l') ? 'l' : 'r', clear: r.right <= col.left + 1 || r.left >= frame.right - 1 }
    })()`)
    expect(card.clear).toBe(true)
    if (card.side === 'l') expect(card.flank).toBe(true)
    await click(browser, s, await centre(browser, s, '[data-node="n-home"] .cm-pin'))   // close the card
    await wait(200)
    await click(browser, s, await centre(browser, s, '[data-node="n-home"] .sh-notes-fold'))
    await wait(600)
    const onTab = await browser.eval(s, `(() => {
      const pin = document.querySelector('[data-node="n-home"] .cm-pin').getBoundingClientRect()
      const tab = document.querySelector('[data-node="n-home"] .sh-notes-fold').getBoundingClientRect()
      return Math.abs(pin.left - tab.left) < tab.width + 6 && Math.abs(pin.bottom - tab.top) < tab.height + 6
    })()`)
    expect(onTab).toBe(true)
    await click(browser, s, await centre(browser, s, '[data-node="n-home"] .sh-notes-fold'))
  })

  it('comment mode picks a note element: the draft stages on the node, the element is locked', async () => {
    if (!browser) return
    const s = await open(browser)
    await browser.press(s, 'c')
    await wait(200)
    await click(browser, s, await centre(browser, s, '[data-node="n-home"] [data-sticky="frame"] .sh-sticky-body h2'))
    await browser.until(s, `!!document.querySelector('[data-node="n-home"] .cm-draft')`)
    const picked = await browser.eval(s, `(() => {
      const h = document.querySelector('[data-node="n-home"] [data-sticky="frame"] .sh-sticky-body h2')
      const d = document.querySelector('[data-node="n-home"] .cm-draft')
      return { locked: h.hasAttribute('data-sh-lock'), left: parseFloat(d.style.left), selected: document.querySelector('.sh-node.sel')?.dataset.node ?? null }
    })()`)
    expect(picked.locked).toBe(true)
    expect(picked.left).toBeLessThan(0)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, s)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, s)
    await browser.until(s, `!document.querySelector('[data-node="n-home"] .cm-draft') && !document.querySelector('[data-sh-lock]')`)
  })

  it('a goto: link in a note selects its target on the board', async () => {
    if (!browser) return
    const s = await open(browser)
    await click(browser, s, await centre(browser, s, '[data-node="n-home"] [data-sticky="frame"] a[data-goto]'))
    await browser.until(s, `document.querySelector('.sh-node.sel')?.dataset.node === 'n-next'`)
  })

  it('editing the note file updates the sticky in place; the iframe is the same element', async () => {
    if (!browser) return
    const s = await open(browser)
    await browser.eval(s, `document.querySelector('[data-node="n-home"] iframe').__mvSame = true`)
    writeFileSync(join(root, 'design', 'scenes', 'app', 'home.note.md'), NOTE.replace('Why the jobs list leads', 'Why the list leads now'))
    await browser.until(s, `document.querySelector('[data-node="n-home"] [data-sticky="frame"] h2')?.textContent === 'Why the list leads now'`, 15_000)
    expect(await browser.eval(s, `document.querySelector('[data-node="n-home"] iframe').__mvSame === true`)).toBe(true)
    // a scene note edit rides sh:scenes; a NEW note file on a frame that had none brings its column
    writeFileSync(join(root, 'design', 'scenes', 'app', '_note.md'), `# App, renamed\n\nStill three screens.\n`)
    await browser.until(s, `document.querySelector('[data-node="n-home"] [data-sticky="scene"] h1')?.textContent === 'App, renamed'`, 15_000)
    writeFileSync(join(root, 'design', 'scenes', 'app', 'next.note.md'), `The second screen.`)
    await browser.until(s, `document.querySelector('[data-node="n-next"] [data-sticky="frame"] p')?.textContent === 'The second screen.'`, 15_000)
    expect(await browser.eval(s, `document.querySelector('[data-node="n-home"] iframe').__mvSame === true`)).toBe(true)
    rmSync(join(root, 'design', 'scenes', 'app', 'next.note.md'))
    await browser.until(s, `document.querySelectorAll('[data-node="n-next"] .sh-notes').length === 0`, 15_000)
    expect(log).not.toMatch(/error/i)
  })

  it('a board with a recipe makes room for a note by itself when a note file lands live; saved positions stay when nothing is cramped', async () => {
    if (!browser) return
    const s = await browser.tab({ width: 1500, height: 950 })
    await browser.go(s, `${ORIGIN}/#/b/recipe`)
    await browser.until(s, `document.querySelectorAll('.sh-node').length === 2 && document.querySelectorAll('[data-node="r-home"] .sh-notes .sh-sticky').length === 2`, 30_000)
    await wait(800)
    const xs = () => browser!.eval(s, `(() => { const at = (k) => +document.querySelector('[data-node="' + k + '"]').style.transform.match(/translate\\((-?[\\d.]+)px/)[1]; return { home: at('r-home'), next: at('r-next') } })()`)
    // home's column faces empty canvas: nothing is cramped, the saved positions are kept as they were
    expect(await xs()).toEqual({ home: 0, next: 420 })
    // a frame note lands on `next` while the board is open: its column would stand on `home` - the recipe re-applies
    writeFileSync(join(root, 'design', 'scenes', 'app', 'next.note.md'), `The second screen.`)
    await browser.until(s, `document.querySelector('[data-node="r-next"] [data-sticky="frame"] p')?.textContent === 'The second screen.'`, 15_000)
    await browser.until(s, `(() => { const col = document.querySelector('[data-node="r-next"] .sh-notes')?.getBoundingClientRect(); const prev = document.querySelector('[data-node="r-home"]').getBoundingClientRect(); return !!col && col.left >= prev.right - 0.5 })()`, 15_000)
    const after = await xs()
    expect(after.next - after.home).toBeGreaterThanOrEqual(390 + 260 + 24)
    // the room is saved with the board, so the next load starts from it
    await wait(1500)
    const saved = JSON.parse(await (await fetch(`${ORIGIN}/__mv/api/boards/recipe`)).text())
    const at = (k: string) => saved.board.nodes.find((n: any) => n.key === k)
    expect(at('r-next').x - at('r-home').x).toBeGreaterThanOrEqual(390 + 260 + 24)
    // a board saved tight and never opened since the note landed: the load makes the room and saves it
    const c = await browser.tab({ width: 1500, height: 950 })
    await browser.go(c, `${ORIGIN}/#/b/closed`)
    await browser.until(c, `document.querySelectorAll('.sh-node').length === 2 && document.querySelectorAll('[data-node="c-next"] .sh-notes .sh-sticky').length === 1`, 30_000)
    await browser.until(c, `(() => { const col = document.querySelector('[data-node="c-next"] .sh-notes').getBoundingClientRect(); const prev = document.querySelector('[data-node="c-home"]').getBoundingClientRect(); return col.left >= prev.right - 0.5 })()`, 15_000)
    await wait(1500)
    const closed = JSON.parse(await (await fetch(`${ORIGIN}/__mv/api/boards/closed`)).text())
    const cat = (k: string) => closed.board.nodes.find((n: any) => n.key === k)
    expect(cat('c-next').x - cat('c-home').x).toBeGreaterThanOrEqual(390 + 260 + 24)
    rmSync(join(root, 'design', 'scenes', 'app', 'next.note.md'))
    await browser.until(s, `document.querySelectorAll('[data-node="r-next"] .sh-notes').length === 0`, 15_000)
    expect(log).not.toMatch(/error/i)
  }, 60_000)

  it('a note longer than its frame gets its room below: the row under it moves down as far as the column runs, and the gutter stays the card\u2019s', async () => {
    if (!browser) return
    const s = await browser.tab({ width: 1500, height: 950 })
    await browser.go(s, `${ORIGIN}/#/b/stack`)
    await browser.until(s, `document.querySelectorAll('.sh-node').length === 2 && document.querySelectorAll('[data-node="s-next"] .sh-notes .sh-sticky').length === 1 && document.querySelectorAll('[data-node="s-home"] .sh-notes .sh-sticky').length === 1`, 30_000)
    await wait(800)
    const pos = () => browser!.eval(s, `(() => { const at = (k) => { const m = document.querySelector('[data-node="' + k + '"]').style.transform.match(/translate\\((-?[\\d.]+)px, (-?[\\d.]+)px/); return { x: +m[1], y: +m[2] } }; return { next: at('s-next'), home: at('s-home') } })()`)
    // the scene note on `next` is short: nothing is cramped, the tight rows stay as saved
    expect(await pos()).toEqual({ next: { x: 404, y: 0 }, home: { x: 284, y: 1012 } })
    // a long frame note lands on `next`: its column runs far below the frame, over `home`'s column and card
    writeFileSync(join(root, 'design', 'scenes', 'app', 'next.note.md'), ['## Every state of the second screen', ...Array.from({ length: 30 }, (_, i) => `${i + 1}. When the list is ${['empty', 'loading', 'stale', 'filtered'][i % 4]} the header keeps its place and the rail folds; the footer action stays reachable on every viewport we ship.`)].join('\n\n'))
    await browser.until(s, `document.querySelectorAll('[data-node="s-next"] .sh-notes .sh-sticky').length === 2`, 15_000)
    // the column's bottom (world px) is what the layout must clear
    const column = () => browser!.eval(s, `(() => { const col = document.querySelector('[data-node="s-next"] .sh-notes'); return col.offsetTop + col.offsetHeight })()`)
    expect(await column()).toBeGreaterThan(844 + 28)
    await browser.until(s, `(() => { const col = document.querySelector('[data-node="s-next"] .sh-notes').getBoundingClientRect(); const home = document.querySelector('[data-node="s-home"]').getBoundingClientRect(); return home.top >= col.bottom - 0.5 })()`, 15_000)
    const after = await pos(), colH = await column()
    expect(after.next).toEqual({ x: 404, y: 0 })
    expect(after.home.y).toBeGreaterThanOrEqual(colH)
    expect(after.home.y - colH).toBeLessThan(400)                                    // the gutter is the card's (~140), never scaled by the note
    // saved with the board, so the next load starts from it
    await wait(1500)
    const saved = JSON.parse(await (await fetch(`${ORIGIN}/__mv/api/boards/stack`)).text())
    expect(Math.abs(saved.board.nodes.find((n: any) => n.key === 's-home').y - after.home.y)).toBeLessThan(1)   // the file rounds
    // folding the column keeps its room: no reflow on a fold
    await browser.eval(s, `document.querySelector('[data-node="s-next"] .sh-notes-fold').click()`)
    await browser.until(s, `document.querySelector('[data-node="s-next"] .sh-notes').classList.contains('off')`)
    await wait(1200)
    expect((await pos()).home.y).toBe(after.home.y)
    await browser.eval(s, `document.querySelector('[data-node="s-next"] .sh-notes-fold').click()`)
    rmSync(join(root, 'design', 'scenes', 'app', 'next.note.md'))
    await browser.until(s, `document.querySelectorAll('[data-node="s-next"] .sh-notes .sh-sticky').length === 1`, 15_000)
    expect(log).not.toMatch(/error/i)
  }, 60_000)

  it('a hostile note is inert in the shell realm: script, handlers and foreign tags never reach the DOM', async () => {
    if (!browser) return
    const s = await open(browser)
    writeFileSync(join(root, 'design', 'scenes', 'app', 'next.note.md'), 'hi <script><img/src=x onerror=window.__pwned=1></script> and <b onclick=x>bold</b> <iframe src=x></iframe>\n\n<img src=x onerror=window.__pwned=2>\n\n![ok](flow.png)')
    await browser.until(s, `!!document.querySelector('[data-node="n-next"] [data-sticky="frame"] .sh-sticky-body')`, 15_000)
    await wait(300)
    const state = await browser.eval(s, `(() => { const b = document.querySelector('[data-node="n-next"] [data-sticky="frame"] .sh-sticky-body'); return { pwned: window.__pwned ?? null, imgs: b.querySelectorAll('img').length, handlers: b.querySelectorAll('[onerror],[onclick]').length, foreign: b.querySelectorAll('script,iframe,b').length, text: b.textContent.includes('<script>') && b.textContent.includes('onclick=x') } })()`)
    expect(state).toEqual({ pwned: null, imgs: 1, handlers: 0, foreign: 0, text: true })
    rmSync(join(root, 'design', 'scenes', 'app', 'next.note.md'))
    await browser.until(s, `document.querySelectorAll('[data-node="n-next"] .sh-notes').length === 0`, 15_000)
  })

  it('every diagram family renders in a note without error, in one look (sketched boxes on non-flowchart types)', async () => {
    if (!browser) return
    const s = await open(browser)
    const gallery = ['sequenceDiagram\n  A->>B: hi\n  Note over A,B: n', 'stateDiagram-v2\n  [*] --> A\n  A --> B', 'classDiagram\n  class A {\n    +x\n  }\n  A --> B', 'erDiagram\n  A ||--o{ B : has', 'pie\n  "a" : 1\n  "b" : 2', 'mindmap\n  root((r))\n    a\n    b', 'gantt\n  dateFormat HH:mm\n  section S\n    t :a1, 06:00, 20m', 'journey\n  section S\n    t: 3: Me', 'timeline\n  title T\n  Day 0 : a : b', 'quadrantChart\n  x-axis L --> R\n  y-axis B --> T\n  P: [0.5, 0.5]', 'gitGraph\n  commit\n  branch b\n  commit', 'flowchart LR\n  A --> B']
    writeFileSync(join(root, 'design', 'scenes', 'app', 'next.note.md'), gallery.map((d) => '```mermaid\n' + d + '\n```').join('\n\n'))
    await browser.until(s, `document.querySelectorAll('[data-node="n-next"] .sh-sticky-diagram svg').length + document.querySelectorAll('[data-node="n-next"] pre.err').length === ${gallery.length}`, 40_000)
    await wait(500)
    // every shape's COMPUTED colour is on the paper: a yellow (r high, g high, b lower), the ink, or the line
    const state = await browser.eval(s, `(() => { const b = document.querySelector('[data-node="n-next"] .sh-sticky-body')
      const onPaper = (c) => { const m = /rgba?\\((\\d+), (\\d+), (\\d+)(?:, ([\\d.]+))?\\)/.exec(c); if (!m) return true; if (m[4] !== undefined && Number(m[4]) === 0) return true; const [r, g, bl] = [m[1], m[2], m[3]].map(Number); return (r >= 200 && g >= 180 && bl <= 230 && bl < g) || (r <= 120 && g <= 100 && bl <= 40) }
      const off = []
      for (const el of b.querySelectorAll('svg :is(path, rect, circle, ellipse, polygon, line)')) { const cs = getComputedStyle(el); if (!onPaper(cs.fill)) off.push(['fill', cs.fill, el.getAttribute('class')]); if (!onPaper(cs.stroke)) off.push(['stroke', cs.stroke, el.getAttribute('class')]) }
      return { errs: [...b.querySelectorAll('pre.err')].map((p) => p.textContent), svgs: b.querySelectorAll('.sh-sticky-diagram svg').length, actorSketched: !!b.querySelector('rect.actor + g path'), off: off.slice(0, 6) } })()`)
    expect(state.errs).toEqual([])
    expect(state.svgs).toBe(gallery.length)
    expect(state.actorSketched).toBe(true)   // the family mermaid leaves plain gets the rough.js boxes
    expect(state.off).toEqual([])            // nothing off the paper's palette
    rmSync(join(root, 'design', 'scenes', 'app', 'next.note.md'))
    await browser.until(s, `document.querySelectorAll('[data-node="n-next"] .sh-notes').length === 0`, 15_000)
  })

  it('a published canvas carries the notes: column, diagram and the note’s image, no dev server', async () => {
    if (!browser) return
    writeFileSync(join(root, 'design', 'scenes', 'app', 'home.note.md'), NOTE.replace('Why the jobs list leads', 'Why the list leads now'))   // order-independent: the text this test expects
    writeFileSync(join(root, 'design', 'scenes', 'app', '_note.md'), `# App\n\nThe driver's day, three screens.\n`)
    writeFileSync(join(root, 'design', 'publish.json'), JSON.stringify({ version: 2, boards: { notes: 'comment' } }))
    const out = execFileSync(process.execPath, [CLI, 'build', '--root', root, '--no-textures'], { stdio: 'pipe', encoding: 'utf8' })
    expect(out).not.toMatch(/error/i)
    expect(out).toMatch(/frames|built|dist/i)   // a real build ran, not a no-op
    const port = PORT + 1
    const served = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], { cwd: root, stdio: 'pipe', env: { ...process.env, MARVER_DATA_DIR: '', MARVER_PASSWORD: '', MARVER_ID_ISSUER: '' } })
    try {
      const t0 = Date.now()
      while (Date.now() - t0 < 30_000) { if (await fetch(`http://localhost:${port}/`).then((r) => r.ok, () => false)) break; await wait(200) }
      const s = await browser.tab({ width: 1500, height: 950 })
      await browser.go(s, `http://localhost:${port}/#/b/notes`)
      await browser.until(s, `document.querySelectorAll('[data-node="n-home"] .sh-notes .sh-sticky').length === 2 && !!document.querySelector('[data-node="n-home"] .sh-sticky-diagram svg')`, 30_000)
      await browser.until(s, `(document.querySelector('[data-node="n-home"] .sh-sticky-body img')?.naturalWidth ?? 0) > 0`, 15_000)
      const state = await browser.eval(s, `(() => ({ src: document.querySelector('[data-node="n-home"] .sh-sticky-body img').getAttribute('src'), h2: document.querySelector('[data-node="n-home"] [data-sticky="frame"] h2').textContent, scene: document.querySelector('[data-node="n-home"] [data-sticky="scene"] h1').textContent }))()`)
      expect(state).toEqual({ src: '/design/assets/flow.png', h2: 'Why the list leads now', scene: 'App' })
    } finally { try { served.kill('SIGTERM') } catch { /* gone */ } }
  }, 120_000)

  it('a reviewer on a GATED published canvas comments on a note: invite claimed, thread created, pin on the note after reload', async () => {
    if (!browser) return
    // the site built by the previous test (design/.dist); served gated with a data dir, like a deploy
    const port = PORT + 2, base = `http://localhost:${port}`
    const dataDir = mkdtempSync(join(tmpdir(), 'mv-notes-data-'))
    let slog = ''
    const served = spawn(process.execPath, [CLI, 'serve'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), MARVER_PASSWORD: 'hunter2', MARVER_DATA_DIR: dataDir, MARVER_OWNER_EMAIL: 'owner@x.test', MARVER_ID_ISSUER: '' } })
    served.stdout?.on('data', (d) => { slog += d }); served.stderr?.on('data', (d) => { slog += d })
    try {
      const t0 = Date.now()
      while (Date.now() - t0 < 30_000) { if (await fetch(base).then((r) => r.ok || r.status === 401 || r.status === 403, () => false)) break; await wait(200) }
      await wait(500)
      const token = /\/#\/i\/([\w-]+)/.exec(slog)?.[1] ?? ''
      expect(token, 'the owner bootstrap link in the serve log').not.toBe('')
      const s = await browser.tab({ width: 1500, height: 950 })
      await browser.go(s, `${base}/#/i/${token}`)
      await browser.until(s, `!!document.querySelector('input[type=password]')`, 20_000)
      await browser.eval(s, `(() => { const i = document.querySelector('input[type=password]'); i.value = 'hunter2'; i.form.submit() })()`)
      // the claim dialog: a password of one's own, a name, join
      await browser.until(s, `!!document.querySelector('input[type=password]') && !document.querySelector('input[type=password]').form`, 20_000)
      await browser.eval(s, `document.querySelector('input[type=password]').focus()`)
      await browser.send('Input.insertText', { text: 'reviewer-pass-1' }, s)
      await browser.eval(s, `(() => { const is = [...document.querySelectorAll('input:not([type=password]):not([type=hidden]):not([type=file])')]; (is.find((x) => /name/i.test(x.placeholder + x.name)) ?? is[is.length - 1]).focus() })()`)
      await browser.send('Input.insertText', { text: 'Reviewer Rae' }, s)
      await wait(200)
      await click(browser, s, await browser.eval(s, `(() => { const b = [...document.querySelectorAll('button')].find((x) => /join/i.test(x.textContent)); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`))
      await browser.until(s, `!document.querySelector('input[type=password]')`, 15_000)
      // the board, the note, a comment on its paragraph
      await browser.go(s, `${base}/#/b/notes?n=n-home`)
      await browser.until(s, `document.querySelectorAll('[data-node="n-home"] .sh-notes .sh-sticky').length === 2 && !!document.querySelector('[data-node="n-home"] .sh-sticky-diagram svg')`, 30_000)
      await wait(600)
      await browser.press(s, 'c'); await wait(200)
      await click(browser, s, await centre(browser, s, '[data-node="n-home"] [data-sticky="frame"] .sh-sticky-body p'))
      await browser.until(s, `!!document.querySelector('[data-node="n-home"] .cm-draft')`, 10_000)
      await browser.send('Input.insertText', { text: 'Reviewer: is the list really first?' }, s)
      await wait(200)
      await click(browser, s, await centre(browser, s, '[data-node="n-home"] .cm-draft button:last-of-type'))
      await browser.until(s, `!!document.querySelector('[data-node="n-home"] .cm-pin')`, 15_000)
      expect(existsSync(join(dataDir, 'comments', 'notes.jsonl')), 'the thread reached the data dir').toBe(true)
      // reload: persisted, and pinned on the note's paragraph, not on the frame
      await browser.go(s, `${base}/#/b/notes?n=n-home`)
      await browser.until(s, `!!document.querySelector('[data-node="n-home"] .sh-sticky-diagram svg')`, 30_000)
      await wait(500)
      await click(browser, s, await centre(browser, s, '[data-node="n-home"] .sh-node-head'))
      await browser.until(s, `!!document.querySelector('[data-node="n-home"] .cm-pin')`, 15_000)
      const pinned = await browser.eval(s, `(() => { const pin = document.querySelector('[data-node="n-home"] .cm-pin'); const r = pin.getBoundingClientRect(); const p = document.querySelector('[data-node="n-home"] [data-sticky="frame"] .sh-sticky-body p').getBoundingClientRect(); return { left: parseFloat(pin.style.left), onNote: r.left >= p.left - 6 && r.left <= p.right + 6 && r.bottom >= p.top - 6 && r.bottom <= p.bottom + 40 } })()`)
      expect(pinned.left).toBeLessThan(0)
      expect(pinned.onNote).toBe(true)
    } finally { try { served.kill('SIGTERM') } catch { /* gone */ } rmSync(dataDir, { recursive: true, force: true }) }
  }, 180_000)
})
