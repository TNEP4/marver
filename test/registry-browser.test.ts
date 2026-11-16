import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'
import { findChrome } from '../src/server/cdp.ts'

/**
 * No document hears the frame host's registry: a REAL dev server on a Tailwind v4
 * canvas, a REAL browser. The registry takes every design update and changes nothing in a document - the frames an edit
 * touched reload from the shell - so the frames an edit does not reach neither fetch it nor hear its update: a frame's
 * edit, a kit's, a syntax error and its fix, a new frame file. What does reach them still does. Skips without Chrome.
 */

const CHROME = !!findChrome()   // without one the suite says it skipped
const PORT = 7500 + Math.floor(Math.random() * 300)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
let ORIGIN = `http://localhost:${PORT}`

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let s = ''
let log = ''

const put = (rel: string, body: string | object) => {
  const f = join(root, rel)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ev = (expr: string) => browser!.eval(s, expr)
const until = (expr: string, ms = 20_000) => browser!.until(s, expr, ms)
const doc = (id: string) => `(() => { const k = window.__mvStore.getState().nodes.find((n) => n.frame === ${JSON.stringify(id)})?.key; return document.querySelector('.sh-node[data-node="' + k + '"] iframe')?.contentWindow })()`
const node = (id: string) => `window.__mvStore.getState().nodes.find((n) => n.frame === ${JSON.stringify(id)})`
const text = (id: string) => `(${doc(id)}?.document?.body?.innerText ?? '')`
const width = (id: string, sel: string) => `(() => { const w = ${doc(id)}; const e = w?.document?.querySelector(${JSON.stringify(sel)}); return e ? w.getComputedStyle(e).width : null })()`
const FRAMES = ['q/a', 'q/b', 'q/c', 'q/d']
/** what each frame's document fetched and heard since `mark()`: resources (an observer, never the 250-entry buffer) and
 *  the HMR socket's `update` messages */
const mark = () => ev(`(${JSON.stringify(FRAMES)}).forEach((id) => { const w = ${doc('__ID__').replace('"__ID__"', 'id')}; w.__res.length = 0; w.__upd.length = 0 }), 1`)
/** what each frame fetched and heard of the frame host's registry since mark() */
const heard = () => ev(`JSON.stringify(Object.fromEntries((${JSON.stringify(FRAMES)}).map((id) => { const w = ${doc('__ID__').replace('"__ID__"', 'id')}; return [id, { res: w.__res.filter((u) => u.includes('/frame-host/registry.ts')), upd: w.__upd.filter((u) => u.includes('/frame-host/registry.ts')) }] })))`).then((j) => JSON.parse(j) as Record<string, { res: string[]; upd: string[] }>)
const navs = () => ev(`JSON.stringify(Object.fromEntries(window.__mvStore.getState().nodes.map((n) => [n.frame, n.nav ?? 0])))`).then((j) => JSON.parse(j) as Record<string, number>)

// every document (the canvas page and each frame): what it fetches and what its HMR socket says, from its first line
const HELPERS = `(() => {
  window.__boot = Math.random()
  window.__res = []; window.__upd = []
  if (window.top === window) addEventListener('message', (e) => { if (e.data?.type === 'sh:ready') window.__readies = (window.__readies ?? 0) + 1 }, true)
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__res.push(e.name) }).observe({ type: 'resource' }) } catch {}
  const W = window.WebSocket
  window.WebSocket = class extends W { constructor(...a) { super(...a); this.addEventListener('message', (e) => { try { const d = JSON.parse(e.data); if (d.type === 'update') window.__upd.push(d.updates.map((u) => u.path).join(',')) } catch {} }) } }
})()`

const frame = (name: string, body: string, head = '') => `${head}export const meta = { viewport: 'desktop' }\nexport default function Frame() { return <main>${body}</main> }\n`

beforeAll(async () => {
  if (!CHROME) return
  root = mkdtempSync(join(tmpdir(), 'mv-quiet-'))
  put('package.json', { name: 'quiet-fixture', private: true, type: 'module', devDependencies: { tailwindcss: '^4.0.0' } })
  // a canvas as `marver init` leaves it: a repository whose design/.local (the logs Marver writes as the page loads) Tailwind
  // does not scan - a log line naming a class would change the stylesheet, rightly pushed to every frame
  put('.gitignore', 'node_modules/\n')
  put('design/.gitignore', '.local/\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  const tw = readdirSync(join(repoNm, '.pnpm')).find((d) => /^tailwindcss@4/.test(d))
  if (tw) symlinkSync(join(repoNm, '.pnpm', tw, 'node_modules', 'tailwindcss'), join(root, 'node_modules', 'tailwindcss'))
  put('design/config.ts', 'export default { jam: false }\n')
  put('design/theme.css', '@import "tailwindcss";\n')
  put('plan.md', 'a file Tailwind scans and no frame imports\n')
  put('design/scenes/q/_kit.tsx', 'export const Kit = () => <p>kit v1</p>\n')
  put('design/scenes/q/a.tsx', frame('a', '<h1>a</h1><Kit />', `import { Kit } from './_kit.tsx'\n`))
  put('design/scenes/q/b.tsx', frame('b', '<h1>b</h1><Kit />', `import { Kit } from './_kit.tsx'\n`))
  put('design/scenes/q/c.tsx', frame('c', '<h1>c</h1>'))
  put('design/scenes/q/d.tsx', frame('d', '<h1>d</h1>'))
  put('design/boards/main.json', { version: 1, name: 'main', auto: false, order: 0, nodes: FRAMES.map((frame, i) => ({ frame, x: i * 1500, y: 0, w: 1440, h: 900 })) })
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d; const m = log.match(/→ (http:\/\/localhost:\d+)\//); if (m) ORIGIN = m[1] })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !/→ http:\/\/localhost:\d+\//.test(log)) await sleep(100)
  while (Date.now() - t0 < 60_000) { if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break; await sleep(200) }
  browser = await Browser.launch()
  if (!browser) return
  s = await browser.tab({ width: 1400, height: 900 })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS }, s)
  await browser.go(s, `${ORIGIN}/#/b/main?f=${FRAMES.join(',')}`)
  await until(`window.__mvStore?.getState().nodes.filter((n) => n.status === 'ready').length === 4`, 60_000)
  await sleep(3000)   // past the first dependency rebuild, if the optimizer makes one
  await until(`window.__mvStore?.getState().nodes.filter((n) => n.status === 'ready').length === 4`, 60_000)
}, 150_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!CHROME)('no document hears the registry', () => {
  it('a frame\'s edit: it reloads; the other frames neither fetch the registry nor hear its update', async () => {
    if (!browser) return
    const boot = await ev('window.__boot'), before = await navs()
    await mark()
    appendFileSync(join(root, 'design/scenes/q/a.tsx'), `\n// an edit ${Date.now()}\n`)
    await until(`${node('q/a')}?.nav === ${before['q/a'] + 1} && ${node('q/a')}?.status === 'ready'`)
    await sleep(1500)
    const h = await heard()
    for (const id of ['q/b', 'q/c', 'q/d']) expect(h[id], id).toEqual({ res: [], upd: [] })
    const after = await navs()
    for (const id of ['q/b', 'q/c', 'q/d']) expect(after[id]).toBe(before[id])
    expect(await ev('window.__boot')).toBe(boot)
  }, 60_000)

  it('a shared module\'s edit: the frames that import it show it; the others neither fetch the registry nor hear its update', async () => {
    if (!browser) return
    await mark()
    put('design/scenes/q/_kit.tsx', 'export const Kit = () => <p>kit v2</p>\n')
    await until(`${text('q/a')}.includes('kit v2') && ${text('q/b')}.includes('kit v2')`)
    await sleep(1500)
    const h = await heard()
    for (const id of ['q/c', 'q/d']) expect(h[id], id).toEqual({ res: [], upd: [] })
  }, 60_000)

  it('a syntax error shows in its frame alone, and its fix brings the frame back', async () => {
    if (!browser) return
    const good = readFileSync(join(root, 'design/scenes/q/d.tsx'), 'utf8')
    await mark()
    put('design/scenes/q/d.tsx', good.replace('<h1>d</h1>', '<h1>d</h1'))
    await until(`${node('q/d')}?.status === 'error'`)
    put('design/scenes/q/d.tsx', good.replace('<h1>d</h1>', '<h1>d, mended</h1>'))   // no word Tailwind knows: 'fixed' would be a class
    await until(`${node('q/d')}?.status === 'ready' && ${text('q/d')}.includes('d, mended')`)
    await sleep(1000)
    const h = await heard()
    for (const id of ['q/a', 'q/b', 'q/c']) expect(h[id].upd, id).toEqual([])
    expect(await ev(`window.__mvStore.getState().nodes.filter((n) => n.status !== 'ready').length`)).toBe(0)
  }, 60_000)

  it('a new frame file opens on the board, and the others hear nothing of the registry', async () => {
    if (!browser) return
    await mark()
    put('design/scenes/q/e.tsx', frame('e', '<h1>e, new</h1>'))
    await sleep(1200)
    put('design/boards/main.json', { version: 1, name: 'main', auto: false, order: 0, nodes: [...FRAMES, 'q/e'].map((frame, i) => ({ frame, x: i * 1500, y: 0, w: 1440, h: 900 })) })
    await until(`${node('q/e')}?.status === 'ready' && ${text('q/e')}.includes('e, new')`, 30_000)
    const h = await heard()
    for (const id of FRAMES) expect(h[id].upd, id).toEqual([])
  }, 60_000)
})
