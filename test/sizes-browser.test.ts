import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Calm loading, proven where it happens: a REAL dev server, a REAL browser. A Doc reports its
 * height once it is done (fonts, images) - never the half-loaded one first; the dev shell commits
 * settled heights to design/boards/_sizes.json; the next load opens every frame at that height,
 * so nothing moves from the first paint; a provisional height never shrinks a known one; a reflow
 * the human did not ask for leaves the frame they are looking at where it was on screen; and the
 * published bundle carries the heights of its own frames only. Skips, never fails, without Chrome.
 */

const PORT = 6500 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const ORIGIN = `http://localhost:${PORT}`

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let log = ''

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')   // 1x1: a square
const doc = (paras: number, extra = '') => `import { Doc, Md, Img } from '@marver-design/marver/content'
export default () => (
  <Doc>
${extra}
${Array.from({ length: paras }, (_, i) => `    <Md>{${JSON.stringify(`## Section ${i + 1}\n\nA paragraph long enough to wrap across a couple of lines in a document-width frame, so the height is real.`)}}</Md>`).join('\n')}
  </Doc>
)
`
const sizesFile = () => join(root, 'design', 'boards', '_sizes.json')
const heights = (): Record<string, number> => { try { return JSON.parse(readFileSync(sizesFile(), 'utf8')).heights } catch { return {} } }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => T | undefined | false, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const v = fn(); if (v) return v; await wait(100) }
  throw new Error(`timed out (sizes: ${JSON.stringify(heights())})\n${log.slice(-2000)}`)
}

// installed in the shell BEFORE it loads: every sh:measure the frames post, and every distinct layout
const RECORDER = `(() => {
  if (window.parent !== window) { window.__lod = 0; document.addEventListener('mv-lod-settled', () => { window.__lod++ }, true); return }
  window.__measures = []; window.__layout = []
  addEventListener('message', (e) => { const d = e.data; if (d && d.type === 'sh:measure') window.__measures.push({ frame: d.frame, h: d.height, settled: d.settled }) }, true)
  let last = ''
  const poll = () => {
    try {
      const st = window.__mvStore && window.__mvStore.getState()
      if (st && st.nodes.length) { const k = JSON.stringify(st.nodes.map((n) => [n.key, n.x, n.y, n.w, n.h])); if (k !== last) { last = k; window.__layout.push(k) } }
    } catch {}
    requestAnimationFrame(poll)
  }
  poll()
})()`

const opened: string[] = []
async function open(hash: string): Promise<string> {
  const s = await browser!.tab({ width: 1440, height: 900 })
  opened.push(s)
  await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER }, s)
  await browser!.go(s, `${ORIGIN}/${hash}`)
  await browser!.until(s, `document.querySelectorAll('.sh-node').length > 0`, 30_000)
  return s
}
/** Every canvas this suite opened goes blank - an open board would re-measure and re-save on HMR. */
async function closeAll() { for (const s of opened.splice(0)) await browser!.go(s, 'about:blank').catch(() => {}) }
const node = (s: string, key: string) => browser!.eval(s, `(() => { const n = window.__mvStore.getState().nodes.find((n) => n.key === ${JSON.stringify(key)}); return n && { x: n.x, y: n.y, w: n.w, h: n.h } })()`)

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-sizes-b-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sizes-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..')
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  // .vite stays out: each fixture's dev server keeps its own dependency cache
  for (const e of readdirSync(join(repoRoot, 'node_modules'))) { if (e !== '.bin' && e !== '.vite') symlinkSync(join(repoRoot, 'node_modules', e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  const docs = join(root, 'design', 'scenes', 'docs')
  mkdirSync(docs, { recursive: true })
  writeFileSync(join(docs, 'a.tsx'), doc(8))
  writeFileSync(join(docs, 'b.tsx'), doc(2))
  // an image: its first decode pins the aspect (img-lod.ts) - before it, the canvas is 2:1, after it 1:1
  writeFileSync(join(docs, 'c.tsx'), doc(2, `    <Img src="sq.png" caption="a square" />`))
  mkdirSync(join(root, 'design', 'scenes', 'secret'), { recursive: true })
  writeFileSync(join(root, 'design', 'scenes', 'secret', 's.tsx'), doc(3))
  mkdirSync(join(root, 'design', 'assets'), { recursive: true })
  writeFileSync(join(root, 'design', 'assets', 'sq.png'), PNG)
  const boards = join(root, 'design', 'boards')
  mkdirSync(boards, { recursive: true })
  // agent-authored: a recipe and a frame list, no positions, no sizes - the shell tidies at load
  writeFileSync(join(boards, 'docs.json'), JSON.stringify({ version: 1, name: 'docs', auto: false,
    layout: { rows: [['docs']], scenes: { docs: { rows: [['a', 'b'], ['c']] } } },
    nodes: [{ key: 'k-a', frame: 'docs/a' }, { key: 'k-b', frame: 'docs/b' }, { key: 'k-c', frame: 'docs/c' }] }, null, 2) + '\n')
  writeFileSync(join(boards, 'private.json'), JSON.stringify({ version: 1, name: 'private', auto: false, nodes: [{ key: 'k-s', frame: 'secret/s', x: 0, y: 0 }] }, null, 2) + '\n')
  // the same Doc on a second, hand-placed board - and on a third that gives it a size of its own
  writeFileSync(join(boards, 'other.json'), JSON.stringify({ version: 1, name: 'other', auto: false, nodes: [{ key: 'k-oa', frame: 'docs/a', x: 0, y: 0 }] }, null, 2) + '\n')
  writeFileSync(join(boards, 'authored.json'), JSON.stringify({ version: 1, name: 'authored', auto: false, nodes: [{ key: 'k-aa', frame: 'docs/a', x: 0, y: 0, w: 500, h: 444 }] }, null, 2) + '\n')
  // one frame in view, one 30 000px below it - far out of any lazy-load margin
  mkdirSync(join(root, 'design', 'scenes', 'lazy'), { recursive: true })
  writeFileSync(join(root, 'design', 'scenes', 'lazy', 'near.tsx'), doc(1))
  writeFileSync(join(root, 'design', 'scenes', 'lazy', 'far.tsx'), doc(1))
  writeFileSync(join(boards, 'far.json'), JSON.stringify({ version: 1, name: 'far', auto: false, nodes: [
    { key: 'k-near', frame: 'lazy/near', x: 0, y: 0 }, { key: 'k-far', frame: 'lazy/far', x: 0, y: 30_000 }] }, null, 2) + '\n')
  writeFileSync(join(root, 'design', 'publish.json'), JSON.stringify({ boards: { docs: 'comment' } }))
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
}, 120_000)

afterAll(async () => {
  browser?.close()
  if (server && server.exitCode === null) {
    const gone = new Promise((r) => server!.once('exit', r))
    try { server.kill('SIGTERM') } catch { /* gone */ }
    await Promise.race([gone, wait(5000)])
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('calm loading', () => {
  it('a Doc reports once it is done - its first height is its last - and the dev shell commits it', async () => {
    if (!browser) return
    const s = await open('#/b/docs')
    const want = ['docs/a@760', 'docs/b@760', 'docs/c@760']
    const got = await until(() => { const h = heights(); return want.every((k) => h[k]) && h })
    const measures: { frame: string; h: number; settled: boolean }[] = await browser.eval(s, 'window.__measures')
    for (const f of ['docs/a', 'docs/b', 'docs/c']) {
      const mine = measures.filter((m) => m.frame === f)
      expect(mine.length, f).toBeGreaterThan(0)
      expect(mine[0].settled, f).toBe(true)
      expect(mine[0].h, `${f}: the first report is the finished doc`).toBe(mine[mine.length - 1].h)
      expect(got[`${f}@760`]).toBe(mine[0].h)
    }
    // the image is IN the first report: a square at the column's width, not the 2:1 blank canvas
    const img = await browser.eval(s, `(() => { const f = document.querySelector('[data-node="k-c"] iframe'); const c = f.contentDocument.querySelector('canvas.mv-img-el'); return { w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height, aspect: c.style.aspectRatio } })()`)
    expect(img.aspect).toBe('256 / 256')
    expect(await browser.eval(s, `document.querySelector('[data-node="k-c"] iframe').contentWindow.__lod`), 'a canvas image says when its first decode is done').toBe(1)
    expect(Math.abs(img.w - img.h)).toBeLessThan(2)
    expect(got['docs/c@760']).toBeGreaterThan(got['docs/b@760'] + img.h - 2)
  }, 90_000)

  it('the next load opens every frame at its committed height: nothing moves from the first paint', async () => {
    if (!browser) return
    const s = await open('#/b/docs')
    await wait(3500)   // every frame admitted, settled and reported
    const layouts: string[] = await browser.eval(s, 'window.__layout')
    expect(layouts.length, `layouts:\n${layouts.join('\n')}`).toBe(1)
    const h = heights()
    for (const k of ['a', 'b', 'c']) expect((await node(s, `k-${k}`)).h).toBe(h[`docs/${k}@760`])
  }, 90_000)

  it('a provisional height never shrinks a known one; a settled one does, and is committed', async () => {
    if (!browser) return
    const s = await open('#/b/docs')
    await wait(2500)
    const H = heights()['docs/a@760']
    const measure = (h: number, settled: boolean) => browser!.eval(s, `window.__mvStore.getState().measureNode('k-a', 'docs/a', 760, 760, ${h}, ${settled})`)
    await measure(H - 300, false)
    expect((await node(s, 'k-a')).h).toBe(H)
    await measure(H + 40, false)                                       // provisional may GROW
    expect((await node(s, 'k-a')).h).toBe(H + 40)
    expect(heights()['docs/a@760']).toBe(H)                            // ... but is never committed
    await measure(H - 300, true)
    expect((await node(s, 'k-a')).h).toBe(H - 300)
    await until(() => heights()['docs/a@760'] === H - 300)
    await measure(H, true)
    await until(() => heights()['docs/a@760'] === H)
  }, 90_000)

  it('a reflow the human did not ask for leaves the frame they look at where it was on screen', async () => {
    if (!browser) return
    const s = await open('#/b/docs?n=k-c')                            // zoomed onto c, the second row
    await wait(2500)
    const top = () => browser!.eval(s, `document.querySelector('[data-node="k-c"]').getBoundingClientRect().top`)
    const before = { y: (await node(s, 'k-c')).y, top: await top() }
    writeFileSync(join(root, 'design', 'scenes', 'docs', 'a.tsx'), doc(16))   // an agent makes the first row much taller
    await browser.until(s, `window.__mvStore.getState().nodes.find((n) => n.key === 'k-c').y > ${before.y + 200}`, 30_000)
    await wait(200)
    expect(Math.abs((await top()) - before.top)).toBeLessThan(2)
  }, 90_000)

  it('a board whose Doc grew while it was closed opens with its rows re-laid, never overlapping', async () => {
    if (!browser) return
    await closeAll()
    const s1 = await open('#/b/other')                                 // the Doc grows on ANOTHER board
    const before = heights()['docs/a@760']
    writeFileSync(join(root, 'design', 'scenes', 'docs', 'a.tsx'), doc(26))
    await until(() => heights()['docs/a@760'] > before + 300)
    await browser.go(s1, 'about:blank')
    const s = await open('#/b/docs')
    const a = await node(s, 'k-a')
    expect(a.h).toBe(heights()['docs/a@760'])                          // it opens at the new height...
    await browser.until(s, `(() => { const ns = window.__mvStore.getState().nodes; const a = ns.find((n) => n.key === 'k-a'), c = ns.find((n) => n.key === 'k-c'); return c.y > a.y + a.h + 28 })()`, 10_000)
    await browser.until(s, `!window.__mvStore.getState().dirty`, 10_000)   // ... and the re-laid rows are saved
  }, 90_000)

  it('... and one whose Doc SHRANK closes the gap: its rows were laid out around other heights', async () => {
    if (!browser) return
    await closeAll()
    const s0 = await open('#/b/docs')
    await wait(2000)
    const cBefore = (await node(s0, 'k-c')).y
    await browser.go(s0, 'about:blank')
    const s1 = await open('#/b/other')
    const before = heights()['docs/a@760']
    writeFileSync(join(root, 'design', 'scenes', 'docs', 'a.tsx'), doc(6))
    await until(() => heights()['docs/a@760'] < before - 300)
    await browser.go(s1, 'about:blank')
    const s = await open('#/b/docs')
    await browser.until(s, `window.__mvStore.getState().nodes.find((n) => n.key === 'k-c').y < ${cBefore - 300}`, 10_000)
    const a = await node(s, 'k-a'), c = await node(s, 'k-c')
    expect(c.y).toBeGreaterThan(a.y + a.h + 28)
  }, 90_000)

  it('a frame the human dragged on a recipe board stays where they put it when its heights did not change', async () => {
    if (!browser) return
    await closeAll()
    const s1 = await open('#/b/docs')
    await wait(2500)
    await browser.eval(s1, `window.__mvStore.getState().moveNode('k-b', 4000, 300)`)
    await browser.until(s1, `!window.__mvStore.getState().dirty`, 10_000)
    await browser.go(s1, 'about:blank')
    const s = await open('#/b/docs')
    await wait(2500)
    expect(await node(s, 'k-b')).toMatchObject({ x: 4000, y: 300 })
  }, 90_000)

  it('a device view and back to Default keeps the dragged frame where it was, through a reload', async () => {
    if (!browser) return
    await closeAll()
    const s1 = await open('#/b/docs')
    await wait(2500)
    expect(await node(s1, 'k-b')).toMatchObject({ x: 4000, y: 300 })        // the drag from the test above
    await browser.eval(s1, `window.__mvStore.getState().setDeviceView('laptop')`)
    await wait(300)
    await browser.eval(s1, `window.__mvStore.getState().setDeviceView(null)`)
    await browser.until(s1, `!window.__mvStore.getState().dirty`, 10_000)
    expect(await node(s1, 'k-b')).toMatchObject({ x: 4000, y: 300 })
    await browser.go(s1, 'about:blank')
    const s = await open('#/b/docs')
    await wait(2500)
    expect(await node(s, 'k-b')).toMatchObject({ x: 4000, y: 300 })
  }, 90_000)

  it('a reflow pending on the board being left never tidies the board being opened', async () => {
    if (!browser) return
    await closeAll()
    const s = await open('#/b/far')
    await wait(2500)
    const h = (await node(s, 'k-near')).h
    // a provisional growth on `far` arms an unconditional reflow there; the switch lands before it fires
    await browser.eval(s, `(() => { const st = window.__mvStore.getState(); st.measureNode('k-near', 'lazy/near', 760, 760, ${h + 50}, false); void st.switchBoard('docs') })()`)
    await browser.until(s, `window.__mvStore.getState().board === 'docs'`, 10_000)
    await wait(1500)
    expect(await node(s, 'k-b')).toMatchObject({ x: 4000, y: 300 })
  }, 90_000)

  it('a write whose answer was lost leaves nothing deduplicated against it - the next height still lands', async () => {
    if (!browser) return
    await closeAll()
    const s = await open('#/b/docs')
    await wait(2500)
    const H = heights()['docs/b@760']
    // the first write to the size cache lands, but its answer never comes back
    await browser.eval(s, `(() => { const f = window.fetch; let lost = false; window.fetch = (u, o) => String(u).includes('/api/sizes') && o && o.method === 'POST' && !lost ? (lost = true, f(u, o).then(() => { throw new Error('lost') })) : f(u, o) })()`)
    const measure = (h: number) => browser!.eval(s, `window.__mvStore.getState().measureNode('k-b', 'docs/b', 760, 760, ${h}, true)`)
    await measure(H + 100)
    await until(() => heights()['docs/b@760'] === H + 100)              // it landed; the shell never heard
    await wait(300)
    await measure(H)
    await until(() => heights()['docs/b@760'] === H)
  }, 90_000)

  it('a Doc turned bare Md in an open page opens at the size its next board gives it, not its old height', async () => {
    if (!browser) return
    await closeAll()
    const s = await open('#/b/docs')
    await wait(2500)
    const src = readFileSync(join(root, 'design', 'scenes', 'docs', 'a.tsx'), 'utf8')
    writeFileSync(join(root, 'design', 'scenes', 'docs', 'a.tsx'), `import { Md } from '@marver-design/marver/content'\nexport default () => <Md>{'# bare now'}</Md>\n`)
    await wait(1500)
    await browser.eval(s, `window.__mvStore.getState().switchBoard('authored')`)
    await browser.until(s, `window.__mvStore.getState().board === 'authored'`, 10_000)
    expect(await node(s, 'k-aa')).toMatchObject({ w: 500, h: 444 })
    writeFileSync(join(root, 'design', 'scenes', 'docs', 'a.tsx'), src)
  }, 90_000)

  it('a height that changes while its write is in flight is the one the file ends with', async () => {
    if (!browser) return
    await closeAll()
    const s = await open('#/b/docs')
    await wait(2500)
    const H = heights()['docs/b@760']
    // every write to the size cache answers a second late
    await browser.eval(s, `(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/api/sizes') && o && o.method === 'POST' ? new Promise((r) => setTimeout(r, 1000)).then(() => f(u, o)) : f(u, o) })()`)
    const measure = (h: number) => browser!.eval(s, `window.__mvStore.getState().measureNode('k-b', 'docs/b', 760, 760, ${h}, true)`)
    await measure(H + 100)
    await wait(1800)                                                     // the throttle fired: H+100 is in flight
    await measure(H)                                                     // ... and the doc is back to H
    await wait(3500)
    expect(heights()['docs/b@760']).toBe(H)
  }, 90_000)

  it('a later provisional report is followed by a settled one, even when finishing changes no geometry', async () => {
    if (!browser) return
    await closeAll()
    const s = await open('#/b/far?n=k-near')
    await browser.until(s, `window.__measures.some((m) => m.frame === 'lazy/far' && m.settled)`, 30_000)
    // an edit brings a lazy image with its size already given: off-screen it does not load - and when
    // it does, nothing moves, so only the Doc's own check can say it is done
    writeFileSync(join(root, 'design', 'scenes', 'lazy', 'far.tsx'), doc(1, `    <img src="/design/assets/sq.png" width={200} height={400} loading="lazy" alt="" />`))
    const prov = await browser.until(s, `(() => { const ms = window.__measures.filter((m) => m.frame === 'lazy/far'); const i = ms.findIndex((m, j) => j > 0 && !m.settled); return i > 0 && { i, h: ms[i].h } })()`, 30_000)
    await browser.eval(s, `location.hash = '#/b/far?n=k-far'`)             // bring it into view: the image loads
    const done = await browser.until(s, `(() => { const ms = window.__measures.filter((m) => m.frame === 'lazy/far'); return ms.slice(${prov.i} + 1).find((m) => m.settled) })()`, 30_000)
    expect(done.h).toBe(prov.h)
    await until(() => heights()['lazy/far@760'] === prov.h)
  }, 90_000)

  it('the published bundle carries the committed heights of its own frames only', async () => {
    if (!browser) return
    const s = await open('#/b/private')
    await until(() => heights()['secret/s@760'])
    await browser.eval(s, '1')
    execFileSync(process.execPath, [CLI, 'build', '--root', root, '--no-textures'], { stdio: 'pipe' })
    const dist = join(root, 'design', '.dist', 'assets')
    const js = readdirSync(dist).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dist, f), 'utf8')).join('')
    expect(js).toMatch(/"docs\/a@760":\d+/)
    expect(js).not.toContain('secret/s@760')
    expect(existsSync(sizesFile())).toBe(true)
  }, 180_000)
})
