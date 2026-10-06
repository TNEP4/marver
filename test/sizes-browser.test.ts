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
  if (window.parent !== window) return
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

async function open(hash: string): Promise<string> {
  const s = await browser!.tab({ width: 1440, height: 900 })
  await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER }, s)
  await browser!.go(s, `${ORIGIN}/${hash}`)
  await browser!.until(s, `document.querySelectorAll('.sh-node').length > 0`, 30_000)
  return s
}
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
