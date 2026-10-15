import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Calm updates and sharper marks (spec 26), where a person sees them: a REAL dev server on a Tailwind
 * v4 canvas, a REAL browser, files changing underneath. An edit reloads only the frames that read it,
 * on screen first and at most four at once, never the page; off screen waits for a scroll; a frame
 * in use waits for the end of its use; heights hold while a batch reloads; the marks start with
 * marver dev and a look counts only the version on screen. Skips without Chrome.
 */

const PORT = 7100 + Math.floor(Math.random() * 400)
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
const kitFrame = (n: number) => `import { Kit } from './_kit.tsx'\nexport const meta = { viewport: 'desktop' }\nexport default () => <main><h1>f${n}</h1><Kit /></main>\n`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ev = (expr: string) => browser!.eval(s, expr)
const until = (expr: string, ms = 20_000) => browser!.until(s, expr, ms)
const docText = (id: string) => `(() => { const k = window.__mvStore.getState().nodes.find((n) => n.frame === ${JSON.stringify(id)})?.key; return document.querySelector('.sh-node[data-node="' + k + '"] iframe')?.contentDocument?.body?.innerText ?? '' })()`
const node = (id: string) => `window.__mvStore.getState().nodes.find((n) => n.frame === ${JSON.stringify(id)})`
const isNewExpr = (id: string) => `(() => { const m = window.__mvStore.getState().marks; return !!m && (m.changed[${JSON.stringify(id)}] ?? 0) > (m.seen[${JSON.stringify(id)}] ?? 0) })()`

// page-side: a marker the canvas page keeps only while it never reloads, and a sampler of how many
// frames load at once
const HELPERS = `(() => {
  window.__boot = Math.random()
  window.__maxLoading = 0
  setInterval(() => { const st = window.__mvStore?.getState(); if (st) window.__maxLoading = Math.max(window.__maxLoading, st.nodes.filter((n) => n.status === 'loading').length) }, 25)
})()`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-calm-'))
  put('package.json', { name: 'calm-fixture', private: true, type: 'module', devDependencies: { tailwindcss: '^4.0.0' } })
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  const tw = readdirSync(join(repoNm, '.pnpm')).find((d) => /^tailwindcss@4/.test(d))
  if (tw) symlinkSync(join(repoNm, '.pnpm', tw, 'node_modules', 'tailwindcss'), join(root, 'node_modules', 'tailwindcss'))
  put('design/config.ts', 'export default { jam: false }\n')
  put('design/theme.css', '@import "tailwindcss";\n')
  put('design/scenes/kit/_kit.tsx', 'export const Kit = () => <p>kit v1</p>\n')
  for (let n = 1; n <= 8; n++) put(`design/scenes/kit/f${n}.tsx`, kitFrame(n))
  put('design/scenes/kit/solo.tsx', `export const meta = { viewport: 'desktop' }\nexport default () => <main><h1>solo</h1></main>\n`)
  put('design/scenes/far/page.html', '<!doctype html><html><body><h1>page v1</h1></body></html>\n')   // an HTML frame no page loads
  // four on the first row, four very far below it: off screen at any zoom a fit on the first row takes
  const at = (n: number) => ({ frame: `kit/f${n}`, x: ((n - 1) % 4) * 1500, y: n <= 4 ? 0 : 200_000, w: 1440, h: 900 })
  put('design/boards/main.json', { version: 1, name: 'main', auto: false, order: 0, nodes: [...[1, 2, 3, 4, 5, 6, 7, 8].map(at), { frame: 'kit/solo', x: 6000, y: 0, w: 1440, h: 900 },
    { key: 'dup3', frame: 'kit/f3', x: 9000, y: 200_000, w: 1440, h: 900 }] })   // f3 placed a second time, far away
  // six content frames reading one markdown file, in two rows the shell lays out (heights hold)
  put('notes.md', 'one paragraph\n')
  for (let n = 1; n <= 6; n++) put(`design/scenes/docs/d${n}.tsx`, `import { Doc, Md } from '@marver-design/marver/content'\nimport text from '../../../notes.md?raw'\nexport default () => <Doc><Md>{'# d${n}\\n\\n' + text}</Md></Doc>\n`)
  put('design/boards/docs.json', { version: 1, name: 'docs', auto: false, order: 1, layout: { rows: [['docs']], scenes: { docs: { rows: [['d1', { space: 1 }, 'd2', { space: 1 }, 'd3'], { space: 1 }, ['d4', { space: 1 }, 'd5', { space: 1 }, 'd6']] } } }, nodes: [1, 2, 3, 4, 5, 6].map((n) => ({ frame: `docs/d${n}` })) })
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d; const m = log.match(/→ (http:\/\/localhost:\d+)\//); if (m) ORIGIN = m[1] })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !/→ http:\/\/localhost:\d+\//.test(log)) await sleep(100)
  while (Date.now() - t0 < 60_000) { if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break; await sleep(200) }
  browser = await Browser.launch()
}, 120_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('calm updates (spec 26)', () => {
  it('the marks start with marver dev: what an agent does before the page opens is new when it does', async () => {
    if (!browser) return
    // the agent works before anyone opens the canvas: an edit, and a new frame with an old mtime
    put('design/scenes/kit/solo.tsx', `export const meta = { viewport: 'desktop' }\nexport default () => <main><h1>solo, edited</h1></main>\n`)
    put('design/scenes/kit/late.tsx', 'export default () => <main>late</main>\n')
    utimesSync(join(root, 'design/scenes/kit/late.tsx'), 1_000, 1_000)
    await sleep(1500)                                                         // the watcher's look
    s = await browser.tab({ width: 1400, height: 900 })
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS }, s)
    await browser.go(s, `${ORIGIN}/#/b/main?f=kit/f1,kit/f2,kit/f3,kit/f4`)
    await until(`window.__mvStore?.getState().nodes.filter((n) => n.status === 'ready').length >= 4 && !!window.__mvStore.getState().marks`, 30_000)
    expect(await ev(isNewExpr('kit/solo'))).toBe(true)
    expect(await ev(isNewExpr('kit/late'))).toBe(true)
    expect(await ev(isNewExpr('kit/f1'))).toBe(false)                          // there at the first start: seen
  }, 60_000)

  it('a kit edit reloads only the frames on screen, at most four at once, never the page; the rest when scrolled to - all marked new', async () => {
    if (!browser) return
    await until(`${[1, 2, 3, 4].map((n) => `${node(`kit/f${n}`)}?.status === 'ready'`).join(' && ')}`)
    await sleep(800)
    const boot = await ev('window.__boot')
    const navs = await ev(`JSON.stringify(Object.fromEntries(window.__mvStore.getState().nodes.filter((n) => n.key !== 'dup3').map((n) => [n.frame, n.nav ?? 0])))`)
    await ev('window.__maxLoading = 0, 1')
    put('design/scenes/kit/_kit.tsx', 'export const Kit = () => <p>kit v2</p>\n')
    for (let n = 1; n <= 4; n++) await until(`${docText(`kit/f${n}`)}.includes('kit v2')`)
    const before = JSON.parse(navs)
    const after = JSON.parse(await ev(`JSON.stringify(Object.fromEntries(window.__mvStore.getState().nodes.filter((n) => n.key !== 'dup3').map((n) => [n.frame, n.nav ?? 0])))`))
    for (let n = 1; n <= 4; n++) expect(after[`kit/f${n}`]).toBe(before[`kit/f${n}`] + 1)       // reloaded once
    for (let n = 5; n <= 8; n++) {
      expect(after[`kit/f${n}`]).toBe(before[`kit/f${n}`])                                       // off screen: not yet
      expect(await ev(`${node(`kit/f${n}`)}?.stale === true || ${node(`kit/f${n}`)}?.status === 'loading'`)).toBe(true)
    }
    expect(await ev('window.__maxLoading')).toBeLessThanOrEqual(4)
    expect(await ev('window.__boot')).toBe(boot)                                                  // the page never reloaded
    for (let n = 1; n <= 8; n++) expect(await ev(isNewExpr(`kit/f${n}`))).toBe(true)             // every reader is new
    expect(await ev(isNewExpr('kit/solo'))).toBe(true)                                            // (still, from the first test)
    // scroll to the second row: its frames reload now, with the new kit
    await ev(`location.hash = '#/b/main?f=kit/f5,kit/f6,kit/f7,kit/f8', 1`)
    for (let n = 5; n <= 8; n++) await until(`${docText(`kit/f${n}`)}.includes('kit v2')`)
    expect(await ev('window.__boot')).toBe(boot)
  }, 90_000)

  it('a new Tailwind class in an edited frame renders, and the page still never reloads', async () => {
    if (!browser) return
    const boot = await ev('window.__boot')
    await ev(`location.hash = '#/b/main?f=kit/f1', 1`)
    await sleep(800)
    put('design/scenes/kit/f1.tsx', kitFrame(1).replace('<h1>f1</h1>', '<h1 className="w-[123px]">f1</h1>'))
    await until(`(() => { const k = ${node('kit/f1')}?.key; const h = document.querySelector('.sh-node[data-node="' + k + '"] iframe')?.contentDocument?.querySelector('h1'); return !!h && getComputedStyle(h).width === '123px' })()`)
    expect(await ev('window.__boot')).toBe(boot)
  }, 60_000)

  it('a frame in use waits; a look at it then counts nothing - and completes once its new version is up', async () => {
    if (!browser) return
    await ev(`location.hash = '#/b/main?f=kit/f2', 1`)
    await until(`${node('kit/f2')}?.status === 'ready'`)
    await sleep(500)
    // seen first, then held: interact on it is a lease
    await ev(`(() => { const st = window.__mvStore.getState(); st.markSeen(['kit/f2'], true); st.setInteract(${node('kit/f2')}.key); return 1 })()`)
    await until(`!${isNewExpr('kit/f2')}`)
    await ev(`window.__mvStore.setState({ scale: 0.2 }), 1`)                                     // keep the two-second look out
    put('design/scenes/kit/f2.tsx', kitFrame(2).replace('<h1>f2</h1>', '<h1>f2, edited</h1>'))
    await until(`${node('kit/f2')}?.stale === true`)
    await until(isNewExpr('kit/f2'))
    await ev(`window.__mvStore.getState().select(${node('kit/f2')}.key), 1`)                     // looking while it waits
    await sleep(400)
    expect(await ev(isNewExpr('kit/f2'))).toBe(true)                                              // not on screen yet: still new
    expect(await ev(`${docText('kit/f2')}.includes('edited')`)).toBe(false)
    await ev(`window.__mvStore.getState().setInteract(null), 1`)                                 // the lease ends
    await until(`${docText('kit/f2')}.includes('edited')`)
    await until(`!${isNewExpr('kit/f2')}`)                                                        // the look completes now
  }, 60_000)

  it('a look counts only what that copy shows: a stale copy of a frame placed twice does not clear it', async () => {
    if (!browser) return
    await ev(`location.hash = '#/b/main?f=kit/f3', 1`)
    await until(`${node('kit/f3')}?.status === 'ready'`)
    await sleep(500)
    await ev(`window.__mvStore.setState({ scale: 0.2 }), 1`)
    put('design/scenes/kit/f3.tsx', kitFrame(3).replace('<h1>f3</h1>', '<h1>f3, edited</h1>'))
    await until(isNewExpr('kit/f3'))
    await until(`window.__mvStore.getState().nodes.find((n) => n.key === 'dup3')?.stale === true`)   // far away: it waits
    await ev(`window.__mvStore.getState().select('dup3'), 1`)                                           // a look at the stale copy
    await sleep(400)
    expect(await ev(isNewExpr('kit/f3'))).toBe(true)
    const near = await ev(`${node('kit/f3')}.key`)
    await until(`window.__mvStore.getState().nodes.find((n) => n.key === ${JSON.stringify(near)})?.shown?.endsWith(':' + window.__mvStore.getState().marks.doc['kit/f3'])`)
    await ev(`window.__mvStore.getState().select(${JSON.stringify(near)}), 1`)                         // the copy that shows it
    await until(`!${isNewExpr('kit/f3')}`)
  }, 60_000)

  it('the stage reports the frame it shows, each step: A, B, A', async () => {
    if (!browser) return
    await ev(`window.__mvStore.getState().setPlay({ at: 'kit/f1', device: 'desktop', theme: 'light', focus: true }), 1`)
    await until(`window.__mvStore.getState().stageShown?.at === 'kit/f1'`)
    for (const at of ['kit/f4', 'kit/f1']) {
      // a step, the way Play takes one: the stage swaps, the shell follows
      await ev(`(document.querySelector('iframe[src*="/stage/"]').contentWindow.postMessage({ type: 'sh:stage-set', at: ${JSON.stringify(at)} }, location.origin), window.__mvStore.getState().setPlay({ ...window.__mvStore.getState().play, at: ${JSON.stringify(at)} }), 1)`)
      await until(`window.__mvStore.getState().stageShown?.at === ${JSON.stringify(at)}`)
    }
    await ev(`window.__mvStore.getState().setPlay(null), 1`)
  }, 60_000)

  it('heights hold while a batch of content frames reloads: the second row moves at most once', async () => {
    if (!browser) return
    await ev(`location.hash = '#/b/docs', 1`)
    await until(`window.__mvStore.getState().board === 'docs' && window.__mvStore.getState().nodes.length === 6 && window.__mvStore.getState().nodes.every((n) => n.status === 'ready')`, 30_000)
    await sleep(2500)                                                                             // first heights settled
    await ev(`(() => { window.__ys = []; window.__ysTimer = setInterval(() => { const n = window.__mvStore.getState().nodes.find((x) => x.frame === 'docs/d4'); window.__ys.push(n ? Math.round(n.y) : -1) }, 20); return 1 })()`)
    put('notes.md', Array.from({ length: 30 }, (_, i) => `paragraph ${i} - long enough to wrap and push the row below it down the page`).join('\n\n') + '\n')
    for (let n = 1; n <= 3; n++) await until(`${docText(`docs/d${n}`)}.includes('paragraph 29')`)
    await sleep(2500)                                                                             // past the reflow
    const ys: number[] = await ev(`(clearInterval(window.__ysTimer), window.__ys)`)
    const moves = ys.filter((y, i) => i > 0 && y !== ys[i - 1]).length
    expect(ys[ys.length - 1]).toBeGreaterThan(ys[0])                                              // the row did move down
    expect(moves).toBeLessThanOrEqual(1)                                                          // once
  }, 90_000)

  it('the Not on a board view follows its list in place: a frame that stays keeps its document', async () => {
    if (!browser) return
    await ev(`location.hash = '#/b/~unplaced', 1`)
    await until(`window.__mvStore.getState().board === '~unplaced' && ${node('kit/late')}?.status === 'ready'`, 30_000)
    const key = await ev(`${node('kit/late')}.key`)
    await ev(`(() => { const k = ${JSON.stringify(key)}; document.querySelector('.sh-node[data-node="' + k + '"] iframe').contentWindow.__kept = 1; return 1 })()`)
    put('design/scenes/kit/later.tsx', 'export default () => <main>later</main>\n')     // another frame on no board
    await until(`${node('kit/later')}?.status === 'ready'`, 30_000)
    expect(await ev(`${node('kit/late')}.key`)).toBe(key)
    expect(await ev(`document.querySelector('.sh-node[data-node="' + ${JSON.stringify(key)} + '"] iframe').contentWindow.__kept`)).toBe(1)   // not reloaded
    await ev(`location.hash = '#/b/main', 1`)
  }, 60_000)

  it('an edit to an HTML frame no page has loaded marks that frame alone, not the whole canvas', async () => {
    if (!browser) return
    await ev(`window.__mvStore.setState({ scale: 0.2 }), 1`)
    await sleep(500)
    const before = await ev(`JSON.stringify(window.__mvStore.getState().marks.changed)`)
    put('design/scenes/far/page.html', '<!doctype html><html><body><h1>page v2</h1></body></html>\n')
    await until(`(window.__mvStore.getState().marks.changed['far/page'] ?? 0) > (${before}['far/page'] ?? 0)`)
    await sleep(800)
    const was = JSON.parse(before), now = JSON.parse(await ev(`JSON.stringify(window.__mvStore.getState().marks.changed)`))
    const moved = Object.keys(now).filter((id) => (now[id] ?? 0) !== (was[id] ?? 0))
    expect(moved).toEqual(['far/page'])
  }, 60_000)

  it('the reload log says what happened, and the CLI reads it', async () => {
    if (!browser) return
    const lines = readFileSync(join(root, 'design/.local/perf/reloads.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const kit = lines.find((l) => l.kind === 'update' && l.file === 'design/scenes/kit/_kit.tsx')
    expect(kit?.reload?.sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `kit/f${n}`))
    expect(lines.some((l) => l.kind === 'ready' && l.frame === 'kit/f1')).toBe(true)
    expect(lines.filter((l) => l.kind === 'shell-boot').length).toBe(1)                          // one page load, the first
    expect(lines.filter((l) => l.kind === 'full-reload' && l.passed).length).toBeLessThanOrEqual(1)   // at most the first dependency rebuild
  })
})
