import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'
import { findChrome } from '../src/server/cdp.ts'

/**
 * A theme that is a module (`theme: 'design/theme.ts'`, which imports the frame's stylesheet): a REAL dev server on a
 * Tailwind v4 canvas, a REAL browser. A file added, deleted, or scanned by Tailwind and imported by no frame re-reads the
 * theme's stylesheet - and only the stylesheet: the theme module's own update reached the frame host's entry (main.tsx,
 * a Fast Refresh boundary), which ran again in every frame document - a second and a third React root on the same
 * container, the frame's tree mounted afresh (its state lost), the old roots left alive. No frame re-runs its entry, every
 * frame keeps its tree, and the new classes still reach the open frames. Skips without Chrome.
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
const FRAMES = ['q/a', 'q/b']
const each = (body: string) => `JSON.stringify(Object.fromEntries((${JSON.stringify(FRAMES)}).map((id) => { const w = ${doc('__ID__').replace('"__ID__"', 'id')}; return [id, ${body}] })))`
/** each frame's document from now on: its tree's first element marked, what it hears and logs cleared */
const mark = () => ev(`(${JSON.stringify(FRAMES)}).forEach((id) => { const w = ${doc('__ID__').replace('"__ID__"', 'id')}; w.document.getElementById('root').firstElementChild.__kept = true; w.__upd.length = 0; w.__err.length = 0 }), 1`)
/** each frame since mark(): the same document, the same tree, the React roots that ever committed in it, the frame
 *  host's entry heard as an update, a console error */
const state = () => ev(each(`({ boot: w.__boot, kept: w.document.getElementById('root').firstElementChild?.__kept === true, roots: w.__roots.size, entry: w.__upd.filter((u) => u.includes('/frame-host/main.tsx')).length, errors: w.__err.slice() })`))
  .then((j) => JSON.parse(j) as Record<string, { boot: number; kept: boolean; roots: number; entry: number; errors: string[] }>)
const width = (id: string) => `(() => { const w = ${doc(id)}; const e = w?.document?.querySelector('#probe'); return e ? w.getComputedStyle(e).width : null })()`

// every document: its id, the React roots that commit in it (a devtools hook, the one React reads), its HMR updates,
// its console errors - from its first line
const HELPERS = `(() => {
  window.__boot = Math.random()
  window.__roots = new Set(); window.__upd = []; window.__err = []
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map(), supportsFiber: true, inject(r) { this.renderers.set(1, r); return 1 },
    onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}, setStrictMode() {},
    onCommitFiberRoot(_id, r) { window.__roots.add(r) } }
  const error = console.error
  console.error = (...a) => { window.__err.push(a.map(String).join(' ').slice(0, 200)); return error.apply(console, a) }
  const W = window.WebSocket
  window.WebSocket = class extends W { constructor(...a) { super(...a); this.addEventListener('message', (e) => { try { const d = JSON.parse(e.data); if (d.type === 'update') window.__upd.push(d.updates.map((u) => u.path).join(',')) } catch {} }) } }
})()`

// a's #probe takes a class no file names yet - built where Tailwind cannot read it - so it is styled only once a new file
// names it and the stylesheet reaches the open frame
const frame = (body: string) => `export const meta = { viewport: 'desktop' }\nexport default function Frame() { return <main>${body}</main> }\n`

const settled = async (what: string) => {
  const st = await state()
  for (const id of FRAMES) {
    expect(st[id].entry, `${what}: ${id} heard its frame host's entry`).toBe(0)
    expect(st[id].kept, `${what}: ${id} kept its tree`).toBe(true)
    expect(st[id].roots, `${what}: ${id}'s React roots`).toBe(1)
    expect(st[id].errors.filter((e) => e.includes('createRoot')), `${what}: ${id}`).toEqual([])
  }
  return st
}

beforeAll(async () => {
  if (!CHROME) return
  root = mkdtempSync(join(tmpdir(), 'mv-theme-mod-'))
  put('package.json', { name: 'theme-module-fixture', private: true, type: 'module', devDependencies: { tailwindcss: '^4.0.0' } })
  put('.gitignore', 'node_modules/\n')
  put('design/.gitignore', '.local/\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  const tw = readdirSync(join(repoNm, '.pnpm')).find((d) => /^tailwindcss@4/.test(d))
  if (tw) symlinkSync(join(repoNm, '.pnpm', tw, 'node_modules', 'tailwindcss'), join(root, 'node_modules', 'tailwindcss'))
  put('design/config.ts', `export default { jam: false, theme: 'design/theme.ts' }\n`)
  put('design/theme.ts', `export default await import('./sheet.css')\n`)
  put('design/sheet.css', '@import "tailwindcss";\n')
  put('design/scenes/q/a.tsx', frame(`<h1>a</h1><div id="probe" className={['w', '[321px]'].join('-')}>probe</div>`))
  put('design/scenes/q/b.tsx', frame('<h1>b</h1>'))
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
  await until(`window.__mvStore?.getState().nodes.filter((n) => n.status === 'ready').length === 2`, 60_000)
  await sleep(3000)   // past the first dependency rebuild, if the optimizer makes one
  await until(`window.__mvStore?.getState().nodes.filter((n) => n.status === 'ready').length === 2`, 60_000)
}, 150_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!CHROME)('a theme module: a file added or deleted re-reads the stylesheet, never the frame host', () => {
  it('a file beside a frame\'s, then a new frame file naming a new class: no frame runs its entry again, and the class reaches the open frame', async () => {
    if (!browser) return
    const before = JSON.parse(await ev(each('w.__boot'))) as Record<string, number>
    expect(await ev(width('q/a'))).not.toBe('321px')
    await mark()
    put('design/scenes/q/a.tsx.backup', 'a copy beside the frame\n')
    await sleep(2500)
    await settled('a file beside a frame')
    put('design/scenes/q/c.tsx', frame('<p className="w-[321px]">c, new</p>'))
    await until(`${width('q/a')} === '321px'`)
    await sleep(1500)
    const st = await settled('a new frame file')
    for (const id of FRAMES) expect(st[id].boot, `${id}: the same document`).toBe(before[id])
  }, 60_000)

  it('a file deleted, and a scanned file no frame imports edited: no frame runs its entry again', async () => {
    if (!browser) return
    put('design/scenes/q/b.tsx.backup', 'a copy beside the frame\n')
    put('design/scenes/q/d.tsx', frame('<p>d, new</p>'))
    await sleep(2500)
    await mark()
    unlinkSync(join(root, 'design/scenes/q/b.tsx.backup'))
    unlinkSync(join(root, 'design/scenes/q/d.tsx'))
    await sleep(2500)
    await settled('two files deleted')
    put('design/scenes/q/_brief.md', '# q\n')
    await sleep(1500)
    appendFileSync(join(root, 'design/scenes/q/_brief.md'), '\nmt-[7px] named in a note\n')
    await sleep(2500)
    await settled('a note edited')
  }, 60_000)
})
