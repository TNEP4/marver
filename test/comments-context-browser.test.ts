import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Comments in context (spec 26, Part 6), where the human meets them: a REAL dev server, a REAL
 * browser. An agent's note names its element and the dev server checks it in the rendered frame;
 * markers attach at the end of their element's first line, never overlap, stay put, and line up in
 * a column when they have no element - on the canvas and on the stage. Skips, never fails, without
 * Chrome.
 */

const PORT = 7300 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
let ORIGIN = `http://localhost:${PORT}`

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null

const DECIDE = `export const meta = { title: 'Decide', viewport: 'laptop' }
export default () => <main style={{ padding: 32, fontFamily: 'sans-serif', fontSize: 16, lineHeight: '22px', background: '#fff' }}>
  <h1 style={{ margin: '0 0 12px' }}>Decisions</h1>
  <p style={{ margin: 0 }}>D1 light every frame</p>
  <p style={{ margin: 0 }}>D2 done replies count</p>
  <p style={{ margin: 0 }}>D3 the agent view</p>
  <p style={{ margin: 0 }}>D4 the two second look</p>
  <p style={{ margin: 0 }}>D5 one release</p>
  <p style={{ width: 230, margin: '24px 0' }}>Lead in <b>a bold run that wraps over two lines here</b> after.</p>
  <button data-testid="gear" aria-label="Settings"><svg width="16" height="16"><circle cx="8" cy="8" r="6" /></svg></button>
  <button>Buy</button> <button>Buy</button>
  <span style={{ display: 'none' }}>Hidden twin</span> <span>Hidden twin</span>
  <p style={{ marginTop: 300 }}>Footer line</p>
</main>
`
const PHONE = `export const meta = { title: 'Phone', viewport: 'mobile' }
export default () => <main style={{ padding: 24 }}>
  <style>{'.wide { display: none } @media (min-width: 700px) { .wide { display: block } } .night { display: none } [data-theme=dark] .night { display: block }'}</style>
  <h2>Account</h2>
  <p>Keep it<span style={{ display: 'none' }}>Keep it</span></p>
  <div className="wide">Wide only</div>
  <div className="night">Night only</div>
</main>
`
const LEGACY = `export const meta = { title: 'Legacy', viewport: 'mobile' }
export default () => <main style={{ padding: 24 }}><h2>Old notes</h2></main>
`
const BROKEN = `export const meta = { title: 'Broken', viewport: 'mobile' }
export default () => { throw new Error('boom') }
`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-ctx-b-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ctx-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..')
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(join(repoRoot, 'node_modules'))) { if (e !== '.bin' && e !== '.vite') symlinkSync(join(repoRoot, 'node_modules', e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  const scene = join(root, 'design', 'scenes', 'ctx')
  mkdirSync(scene, { recursive: true })
  for (const [f, src] of Object.entries({ decide: DECIDE, phone: PHONE, legacy: LEGACY, broken: BROKEN })) writeFileSync(join(scene, `${f}.tsx`), src)
  const boards = join(root, 'design', 'boards')
  mkdirSync(boards, { recursive: true })
  writeFileSync(join(boards, 'ctx.json'), JSON.stringify({ version: 1, name: 'ctx', order: 1, auto: false, nodes: [
    { key: 'n-decide', frame: 'ctx/decide', x: 0, y: 0, w: 1280, h: 800 },
    { key: 'n-legacy', frame: 'ctx/legacy', x: 1500, y: 0, w: 390, h: 844 },
    { key: 'n-phone', frame: 'ctx/phone', x: 2100, y: 0, w: 390, h: 844 },
    { key: 'n-broken', frame: 'ctx/broken', x: 2700, y: 0, w: 390, h: 844 },
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
  // a dev server that has served its frames once, as one in use has: a cold first compile is not
  // what the 20 s check deadline is about
  if (browser) {
    const s = await browser.tab({ width: 1600, height: 1000 })
    await browser.go(s, `${ORIGIN}/#/b/ctx`)
    await browser.until(s, `[...document.querySelectorAll('.sh-node iframe')].filter((f) => f.contentDocument?.querySelector('h1, h2, .mv-frame-error, button')).length >= 3`, 60_000).catch(() => {})
  }
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
/** Run the CLI; a refusal is an answer here, not a crash. */
const cli = (...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { cwd: root, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const note = (frame: string, on: string, ...rest: string[]) => {
  const r = cli('comments', 'new', frame, '--on', on, '--body', `About ${on}`, ...rest)
  expect(r.code, r.err).toBe(0)
  return r.out.match(/\?c=([\w-]+)/)![1]
}
const events = (board: string) => readFileSync(join(root, 'design', 'comments', `${board}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const anchorOf = (id: string) => events('ctx').filter((e) => e.commentId === id && (e.type === 'create' || e.type === 'reanchor')).at(-1).anchor

async function click(b: Browser, s: string, at: { x: number; y: number }) {
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y }, s)
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
}
async function open(b: Browser, hash = '#/b/ctx'): Promise<string> {
  const s = await b.tab({ width: 1600, height: 1000 })
  await b.go(s, `${ORIGIN}/${hash}`)
  await b.until(s, `document.querySelectorAll('.sh-node').length === 4`, 30_000)
  await b.send('Page.bringToFront', {}, s)
  return s
}
/** Select a node (its pins show only then) and wait for `n` of them, resolved and settled. */
async function engage(b: Browser, s: string, key: string, n: number) {
  await b.eval(s, `window.__mvStore.getState().select(${JSON.stringify(key)})`)
  await b.until(s, `document.querySelectorAll('[data-node="${key}"] .cm-pin').length === ${n}`, 20_000)
  await wait(900)
}
/** Every marker of a node: its screen box, whether the element under its centre is itself, and its
 *  offset from the node's top-left (what "did not move" compares). */
const PINS = (key: string) => `(() => {
  const node = document.querySelector('[data-node="${key}"]'), nr = node.getBoundingClientRect()
  return [...node.querySelectorAll('.cm-pin')].map((p) => {
    const r = p.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2
    return { id: p.dataset.thread, l: r.left, t: r.top, r: r.right, b: r.bottom, dx: Math.round(r.left - nr.left), dy: Math.round(r.top - nr.top),
      own: document.elementFromPoint(cx, cy)?.closest('.cm-pin') === p, orphan: p.classList.contains('orphan') }
  })
})()`
const overlaps = (pins: { l: number; t: number; r: number; b: number }[]) => {
  const bad: string[] = []
  for (let i = 0; i < pins.length; i++) for (let j = i + 1; j < pins.length; j++) {
    const a = pins[i], c = pins[j]
    if (a.l < c.r + 2 && c.l < a.r + 2 && a.t < c.b + 2 && c.t < a.b + 2) bad.push(`${i}/${j}`)
  }
  return bad
}
/** Where a thread's element's first line ends, in shell screen px (the frame's own text range). */
const LINE_END = (key: string, selector: string) => `(() => {
  const ifr = document.querySelector('[data-node="${key}"] iframe'), doc = ifr.contentDocument, el = doc.querySelector(${JSON.stringify(selector)})
  const range = doc.createRange(); range.selectNodeContents([...el.childNodes].find((n) => n.nodeType === 3 && n.data.trim()) ?? el)
  const q = range.getClientRects()[0], ir = ifr.getBoundingClientRect(), k = ir.width / ifr.contentWindow.innerWidth
  const box = el.getBoundingClientRect()
  return { x: ir.left + q.right * k, y: ir.top + (q.top + q.bottom) / 2 * k, top: ir.top + box.top * k, bottom: ir.top + box.bottom * k, lines: range.getClientRects().length }
})()`

const ids: Record<string, string> = {}

describe('an agent note names its element, checked in the rendered frame', () => {
  it('words the frame does not show are refused with what it does show; repeated labels need --nth', () => {
    if (!browser) return
    const none = cli('comments', 'new', 'ctx/decide', '--on', 'Nowhere words', '--body', 'x')
    expect(none.code).toBe(1)
    expect(none.err).toContain('no visible element on ctx/decide matches "Nowhere words" (checked at laptop, light theme)')
    expect(none.err).toMatch(/Decisions[\s\S]*Buy/)
    const several = cli('comments', 'new', 'ctx/decide', '--on', 'Buy', '--body', 'x')
    expect(several.code).toBe(1)
    expect(several.err).toMatch(/matches 2 visible elements[\s\S]*1\. button "Buy"[\s\S]*2\. button "Buy"[\s\S]*--nth/)
    ids.buy = note('ctx/decide', 'Buy', '--nth', '2', '--fyi')
    expect(anchorOf(ids.buy).el).toMatchObject({ semantics: { tag: 'button', quote: 'Buy' }, nth: 2 })
    expect(events('ctx').find((e) => e.commentId === ids.buy).asks).toBe(false)
  }, 60_000)

  it('a hidden duplicate is never chosen; an icon takes --at', () => {
    if (!browser) return
    ids.twin = note('ctx/decide', 'Hidden twin')
    expect(anchorOf(ids.twin).el.cssPath).toMatch(/main > span:nth-of-type\(2\)$/)   // the visible one
    // a hidden copy INSIDE the visible words never hides them
    const keep = cli('comments', 'new', 'ctx/phone', '--on', 'Keep it', '--body', 'x', '--fyi')
    expect(keep.code, keep.err).toBe(0)
    expect(anchorOf(keep.out.match(/\?c=([\w-]+)/)![1]).el.semantics.tag).toBe('p')
    const r = cli('comments', 'new', 'ctx/decide', '--at', 'gear', '--body', 'The gear is new')
    expect(r.code, r.err).toBe(0)
    ids.gear = r.out.match(/\?c=([\w-]+)/)![1]
    expect(anchorOf(ids.gear).el.semantics).toMatchObject({ tag: 'button', testId: 'gear', ariaLabel: 'Settings' })
  }, 60_000)

  it('a target only another viewport or theme shows needs --viewport or --theme', () => {
    if (!browser) return
    expect(cli('comments', 'new', 'ctx/phone', '--on', 'Wide only', '--body', 'x').err).toContain('checked at mobile, light theme')
    const wide = cli('comments', 'new', 'ctx/phone', '--on', 'Wide only', '--body', 'x', '--viewport', 'laptop')
    expect(wide.code, wide.err).toBe(0)
    expect(wide.out).toContain('found it on ctx/phone at laptop, light theme')
    expect(cli('comments', 'new', 'ctx/phone', '--on', 'Night only', '--body', 'x').code).toBe(1)
    const night = cli('comments', 'new', 'ctx/phone', '--on', 'Night only', '--body', 'x', '--theme', 'dark')
    expect(night.code, night.err).toBe(0)
    expect(cli('comments', 'new', 'ctx/phone', '--on', 'x', '--body', 'x', '--viewport', 'nope').err).toContain('unknown viewport "nope"')
  }, 60_000)

  it('a frame that errors: the note is written, flagged unchecked', () => {
    if (!browser) return
    const r = cli('comments', 'new', 'ctx/broken', '--on', 'Anything', '--body', 'It throws')
    expect(r.code, r.err).toBe(0)
    expect(r.err).toMatch(/not checked - the frame (threw|never rendered)/)
    expect(r.out).toContain('pinned a note on ctx/broken')
  }, 60_000)
})

describe('markers: attached at the first line, never overlapping, stationary', () => {
  it('a heading, five lines and a wrapped bold run: each marker after its first line, every one clickable', async () => {
    if (!browser) return
    ids.h1 = note('ctx/decide', 'Decisions')
    for (const d of ['D1 light every frame', 'D2 done replies count', 'D3 the agent view', 'D4 the two second look', 'D5 one release']) ids[d.slice(0, 2)] = note('ctx/decide', d)
    ids.bold = note('ctx/decide', 'a bold run that wraps')
    const s = await open(browser)
    await engage(browser, s, 'n-decide', 10)
    const pins = await browser.eval(s, PINS('n-decide'))
    expect(pins.filter((p: any) => !p.own).map((p: any) => p.id)).toEqual([])        // the element under each centre is that marker
    expect(overlaps(pins)).toEqual([])
    // the attach point: the marker's tail, or - when an earlier marker sat there - its line's top
    const attached = (id: string) => browser!.eval(s, `(() => {
      const lead = document.querySelector('[data-lead="${id}"]')
      if (lead) { const r = lead.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top } }
      const r = document.querySelector('[data-thread="${id}"]').getBoundingClientRect(); return { x: r.left + 2, y: r.bottom }
    })()`)
    for (const [id, sel] of [[ids.h1, 'h1'], [ids.D1, 'p'], [ids.bold, 'b']] as const) {
      const want = await browser.eval(s, LINE_END('n-decide', sel))
      const got = await attached(id)
      expect(Math.abs(got.x - want.x), `${sel} x`).toBeLessThan(4)
      expect(Math.abs(got.y - want.y), `${sel} y`).toBeLessThan(4)
    }
    // the bold run wraps over two lines: the marker takes the first one, never the middle of the box
    const bold = await browser.eval(s, LINE_END('n-decide', 'b'))
    expect(bold.lines).toBe(2)
    expect(bold.y).toBeLessThan((bold.top + bold.bottom) / 2)
    // D2..D5 sat under D1's marker: moved down, each keeps a line to its point
    expect(await browser.eval(s, `document.querySelectorAll('[data-node="n-decide"] .cm-lead').length`)).toBeGreaterThan(0)
  }, 90_000)

  it('markers do not move on selection, on a card opening, on a reply or after a reload', async () => {
    if (!browser) return
    const s = await open(browser)
    await engage(browser, s, 'n-decide', 10)
    const at = async () => Object.fromEntries((await browser!.eval(s, PINS('n-decide'))).map((p: any) => [p.id, [p.dx, p.dy]]))
    const before = await at()
    // a card opens
    await click(browser, s, await browser.eval(s, `(() => { const r = document.querySelector('[data-thread="${ids.D3}"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`))
    await browser.until(s, `!!document.querySelector('[data-node="n-decide"] .cm-card')`)
    await wait(400)
    expect(await at()).toEqual(before)
    // a reply, and a new participant on it
    expect(cli('comments', 'reply', ids.D3, '--body', 'Still thinking').code).toBe(0)
    await browser.until(s, `[...document.querySelectorAll('[data-node="n-decide"] .cm-card .cm-body')].some((b) => b.textContent.includes('Still thinking'))`, 10_000)
    await wait(400)
    expect(await at()).toEqual(before)
    // selection moves away and back
    await browser.eval(s, `window.__mvStore.getState().select('n-legacy')`)
    await wait(300)
    await engage(browser, s, 'n-decide', 10)
    expect(await at()).toEqual(before)
    // the frame reloads (its file changed)
    appendFileSync(join(root, 'design', 'scenes', 'ctx', 'decide.tsx'), '\n// touched\n')
    await wait(5000)
    await browser.until(s, `document.querySelectorAll('[data-node="n-decide"] .cm-pin').length === 10`, 20_000)
    expect(await at()).toEqual(before)
  }, 90_000)

  it('no two markers overlap at three zoom levels', async () => {
    if (!browser) return
    const s = await open(browser)
    await engage(browser, s, 'n-decide', 10)
    for (const z of ['50%', '100%', '200%']) {
      await browser.eval(s, `document.querySelector('.sh-pill-btn.pct').click()`)
      await wait(150)
      await browser.eval(s, `[...document.querySelectorAll('button')].find((b) => b.querySelector('span')?.textContent === ${JSON.stringify(z)}).click()`)
      await browser.eval(s, `window.__mvStore.getState().select('n-decide')`)
      await wait(1200)
      const pins = await browser.eval(s, PINS('n-decide'))
      expect(pins.length, z).toBe(10)
      expect(overlaps(pins), z).toEqual([])
      const h = pins.map((p: any) => Math.round(p.b - p.t))
      expect(new Set(h).size, `${z}: one marker size on screen`).toBe(1)
    }
  }, 90_000)

  it('legacy frame-level threads and an orphan form a column down from the top-right corner', async () => {
    if (!browser) return
    const now = Date.now()
    const me = { email: 'nic@example.com', name: 'Nic' }
    const lines = [0, 1, 2, 3, 4].map((i) => ({ id: `legacy-${i}`, ts: now + i, type: 'create', commentId: `legacy-c${i}`, board: 'ctx', frame: 'ctx/legacy', author: me, agent: true, body: `old note ${i}` }))
    lines.push({ id: 'legacy-orphan', ts: now + 9, type: 'create', commentId: 'legacy-orphan-c', board: 'ctx', frame: 'ctx/legacy', author: me, agent: true, body: 'gone',
      anchor: { el: { semantics: { quote: 'Words that left the frame' } } } } as any)
    appendFileSync(join(root, 'design', 'comments', 'ctx.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const s = await open(browser)
    await engage(browser, s, 'n-legacy', 6)
    const pins = await browser.eval(s, PINS('n-legacy'))
    const node = await browser.eval(s, `(() => { const r = document.querySelector('[data-node="n-legacy"]').getBoundingClientRect(); return { r: r.right, t: r.top } })()`)
    expect(new Set(pins.map((p: any) => Math.round(p.l))).size).toBe(1)                    // one column
    const tops = pins.map((p: any) => p.t).sort((a: number, b: number) => a - b)
    for (let i = 1; i < tops.length; i++) expect(tops[i] - tops[i - 1]).toBeGreaterThan(30)  // one under the other
    expect(pins.every((p: any) => p.l > node.r - 120 && p.r <= node.r + 1 && p.own)).toBe(true)
    expect(pins.find((p: any) => p.id === 'legacy-orphan-c').orphan).toBe(true)
    expect(overlaps(pins)).toEqual([])
  }, 60_000)

  it('two people clicking the same spot: both pins stay clickable', async () => {
    if (!browser) return
    const now = Date.now()
    const anchor = { el: { semantics: { tag: 'h1', quote: 'Decisions' }, cssPath: 'main > h1', hue: 120 }, pos: { fx: 0.3, fy: 0.5 } }
    appendFileSync(join(root, 'design', 'comments', 'ctx.jsonl'), [
      { id: 'human-1', ts: now, type: 'create', commentId: 'human-c1', board: 'ctx', frame: 'ctx/decide', author: { email: 'nic@example.com', name: 'Nic' }, body: 'this word', anchor },
      { id: 'human-2', ts: now + 1, type: 'create', commentId: 'human-c2', board: 'ctx', frame: 'ctx/decide', author: { email: 'sam@example.com', name: 'Sam' }, body: 'same word', anchor },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')
    const s = await open(browser)
    await engage(browser, s, 'n-decide', 12)
    const pins = await browser.eval(s, PINS('n-decide'))
    const two = pins.filter((p: any) => p.id === 'human-c1' || p.id === 'human-c2')
    expect(two.map((p: any) => p.own)).toEqual([true, true])
    expect(overlaps(two)).toEqual([])
  }, 60_000)

  it('a re-pin resolves at once - no wait for the next poll', async () => {
    if (!browser) return
    const s = await open(browser)
    await engage(browser, s, 'n-decide', 12)
    const where = () => browser!.eval(s, `(() => { const r = document.querySelector('[data-thread="${ids.gear}"]').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)] })()`)
    const before = await where()
    // the same reanchor event a Live Jam re-pin writes, in the same format
    expect(cli('comments', 'move', ids.gear, '--on', 'Footer line').code).toBe(0)
    const t0 = Date.now()
    await browser.until(s, `(() => { const r = document.querySelector('[data-thread="${ids.gear}"]').getBoundingClientRect(); return Math.round(r.top) !== ${before[1]} })()`, 10_000)
    expect(Date.now() - t0).toBeLessThan(3000)   // the poll alone would take up to 4 s
    const want = await browser.eval(s, LINE_END('n-decide', 'p:last-of-type'))
    const r = await browser.eval(s, `(() => { const r = document.querySelector('[data-thread="${ids.gear}"]').getBoundingClientRect(); return { x: r.left, y: r.bottom } })()`)
    expect(Math.abs(r.y - want.y)).toBeLessThan(4)
  }, 60_000)

  it('the stage places markers the same way: none overlapping, every one clickable', async () => {
    if (!browser) return
    const s = await open(browser, '#/p/ctx?at=ctx/decide')
    await browser.until(s, `document.querySelectorAll('.sh-play-comments .cm-pin').length === 12`, 30_000)
    await wait(1500)
    const pins = await browser.eval(s, `[...document.querySelectorAll('.sh-play-comments .cm-pin')].map((p) => { const r = p.getBoundingClientRect(); return { id: p.dataset.thread, l: r.left, t: r.top, r: r.right, b: r.bottom, own: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.cm-pin') === p } })`)
    expect(overlaps(pins)).toEqual([])
    expect(pins.filter((p: any) => !p.own).map((p: any) => p.id)).toEqual([])
  }, 60_000)
})
