import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Board folders, proven where they live: a REAL dev server, a REAL browser, real mouse gestures on
 * the sidebar, and the FILES afterwards - `folder` on the board, `_folders.json` beside it. The
 * pure tree (test/board-tree.test.ts) is mandatory; this suite skips, never fails, without Chrome -
 * the same rule as every browser suite here.
 */

const PORT = 5700 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const ORIGIN = `http://localhost:${PORT}`   // the dev server binds `localhost` (::1 on this OS)

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let log = ''

const boardsDir = () => join(root, 'design', 'boards')
const readBoard = (n: string) => JSON.parse(readFileSync(join(boardsDir(), `${n}.json`), 'utf8'))
const registry = () => (existsSync(join(boardsDir(), '_folders.json')) ? JSON.parse(readFileSync(join(boardsDir(), '_folders.json'), 'utf8')) : null)
const writeBoard = (name: string, extra: Record<string, unknown> = {}) =>
  writeFileSync(join(boardsDir(), `${name}.json`), JSON.stringify({ version: 1, name, auto: false, nodes: [{ key: `${name}-home`, frame: 'app/home', x: 0, y: 0, w: 390, h: 844 }], ...extra }, null, 2) + '\n')
/** Reset the fixture's boards between tests: four boards at the root, no folders. */
const reset = () => {
  for (const f of readdirSync(boardsDir())) rmSync(join(boardsDir(), f), { force: true })
  writeBoard('overview', { order: 0 }); writeBoard('flow', { order: 1 }); writeBoard('specs', { order: 2 }); writeBoard('archive', { order: 3 })
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-folders-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'folders-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..')
  const repoNm = join(repoRoot, 'node_modules')
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(repoNm)) { if (e !== '.bin') symlinkSync(join(repoNm, e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  const scenes = join(root, 'design', 'scenes', 'app')
  mkdirSync(scenes, { recursive: true })
  writeFileSync(join(scenes, 'home.tsx'), `export const meta = { title: 'Home', viewport: 'mobile' }
export default () => <main style={{ minHeight: '100vh', background: '#0b5' }}><h1 style={{ margin: 0, padding: 24, color: '#fff' }}>Home</h1></main>
`)
  mkdirSync(boardsDir(), { recursive: true })
  reset()
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

/** The sidebar's rows, top to bottom, as the human reads them: `name` or `folder:name(open|closed)`, with in-folder rows prefixed by two spaces. */
const ROWS = `Array.from(document.querySelectorAll('.sh-boards [data-board-row], .sh-boards [data-folder-row]')).map((el) => el.hasAttribute('data-folder-row') ? 'folder:' + el.dataset.folderRow : (el.dataset.folder ? '  ' : '') + el.dataset.board)`
const rows = (b: Browser, s: string): Promise<string[]> => b.eval(s, ROWS)
const centre = (b: Browser, s: string, selector: string) => b.eval(s, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom, left: r.left } })()`)

/** Open the canvas and wait for the sidebar to list the boards. */
async function open(b: Browser): Promise<string> {
  const s = await b.tab({ width: 1400, height: 900 })
  await b.go(s, `${ORIGIN}/`)
  await b.until(s, `document.querySelectorAll('.sh-boards [data-board-row]').length >= 5`, 30_000)
  await b.send('Page.bringToFront', {}, s)
  return s
}
const mouse = async (b: Browser, s: string, type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number) =>
  b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, s)
/** A real drag: press, a few moves (past the 5px threshold), release - what a person's hand does. */
async function drag(b: Browser, s: string, from: { x: number; y: number }, to: { x: number; y: number }) {
  await mouse(b, s, 'mousePressed', from.x, from.y)
  for (const t of [0.2, 0.5, 0.8, 1]) await mouse(b, s, 'mouseMoved', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)
  await new Promise((r) => setTimeout(r, 50))
  await mouse(b, s, 'mouseReleased', to.x, to.y)
}
const rightClick = async (b: Browser, s: string, x: number, y: number) => {
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 }, s)
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 }, s)
}
const pickMenu = async (b: Browser, s: string, label: string) => {
  await b.until(s, `!!Array.from(document.querySelectorAll('.sh-ctxmenu button')).find((x) => x.textContent === ${JSON.stringify(label)})`)
  await b.eval(s, `Array.from(document.querySelectorAll('.sh-ctxmenu button')).find((x) => x.textContent === ${JSON.stringify(label)}).click()`)
}
const type = async (b: Browser, s: string, text: string) => { await b.send('Input.insertText', { text }, s) }
const enter = (b: Browser, s: string) => b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, s).then(() => b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, s))
const settle = () => new Promise((r) => setTimeout(r, 400))   // the optimistic write + the re-read

const skippable = (name: string, fn: () => Promise<void>, ms = 60_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); reset(); await fn() }, ms)

describe('board folders - real dev server, real browser, real files', () => {
  skippable('right-click the Boards header → New folder → type "Old stuff" → Enter: a slug in the registry, a Title Case row', async () => {
    const s = await open(browser!)
    const hd = await centre(browser!, s, '.sh-boards .hd')
    await rightClick(browser!, s, hd.x, hd.y)
    await pickMenu(browser!, s, 'New folder')
    await browser!.until(s, `document.activeElement?.placeholder === 'Folder name'`)
    await type(browser!, s, 'Old stuff')
    await enter(browser!, s)
    await browser!.until(s, `${ROWS}.includes('folder:old-stuff')`)
    await settle()
    expect(registry()).toEqual({ version: 1, folders: [{ name: 'old-stuff', order: 4 }] })
    expect(await browser!.eval(s, `document.querySelector('[data-folder-row="old-stuff"] span').textContent`)).toBe('Old Stuff')
    expect(await rows(browser!, s)).toEqual(['overview', 'flow', 'specs', 'archive', 'folder:old-stuff', 'all-scenes'])
  })

  skippable('right-click a board → Move to new folder: the folder takes its slot, the input has focus, the file gets `folder`', async () => {
    const s = await open(browser!)
    const c = await centre(browser!, s, '[data-board="specs"]')
    await rightClick(browser!, s, c.x, c.y)
    await pickMenu(browser!, s, 'Move to new folder')
    await browser!.until(s, `document.activeElement?.placeholder === 'Folder name'`)
    // the board already shows inside the draft, in its own slot
    expect(await browser!.eval(s, `Array.from(document.querySelectorAll('.sh-boards .it')).map((e) => e.textContent).join('|')`)).toContain('Flow||Specs|Archive')   // the empty input, then the board under it
    await type(browser!, s, 'Research')
    await enter(browser!, s)
    await browser!.until(s, `${ROWS}.join() === 'overview,flow,folder:research,  specs,archive,all-scenes'`)
    await settle()
    expect(readBoard('specs')).toMatchObject({ folder: 'research', order: 0 })
    expect(readBoard('archive').order).toBe(3)
    expect(readBoard('archive').folder).toBeUndefined()
    expect(registry()).toEqual({ version: 1, folders: [{ name: 'research', order: 2 }] })
  })

  skippable('DRAG a board onto a folder row → it moves inside (file + registry); drag it back out to a root seam → `folder` gone', async () => {
    writeBoard('specs', { order: 2, folder: 'research' })
    writeFileSync(join(boardsDir(), '_folders.json'), JSON.stringify({ version: 1, folders: [{ name: 'research', order: 2 }] }))
    const s = await open(browser!)
    await browser!.until(s, `${ROWS}.includes('folder:research')`)
    // drag `flow` onto the folder row's middle (past its top edge)
    const from = await centre(browser!, s, '[data-board="flow"]')
    const f = await centre(browser!, s, '[data-folder-row="research"]')
    await drag(browser!, s, from, { x: f.x, y: f.y + 4 })
    await browser!.until(s, `${ROWS}.join() === 'overview,folder:research,  specs,  flow,archive,all-scenes'`)
    await settle()
    expect(readBoard('flow')).toMatchObject({ folder: 'research', order: 1 })
    expect(readBoard('specs')).toMatchObject({ folder: 'research', order: 0 })
    // and out again: drop `flow` on the top half of `archive` (a root seam)
    const flow = await centre(browser!, s, '[data-board="flow"][data-folder="research"]')
    const archive = await centre(browser!, s, '[data-board="archive"]')
    await drag(browser!, s, flow, { x: archive.x, y: archive.top + 4 })
    await browser!.until(s, `${ROWS}.join() === 'overview,folder:research,  specs,flow,archive,all-scenes'`)
    await settle()
    expect(readBoard('flow').folder).toBeUndefined()
    expect(readBoard('flow').order).toBe(2)
    expect(readBoard('archive').order).toBe(3)
  })

  skippable('DRAG a folder above the first board: the registry ranks it 0 and every root order renumbers', async () => {
    writeBoard('specs', { order: 2, folder: 'research' })
    writeFileSync(join(boardsDir(), '_folders.json'), JSON.stringify({ version: 1, folders: [{ name: 'research', order: 2 }] }))
    const s = await open(browser!)
    await browser!.until(s, `${ROWS}.includes('folder:research')`)
    const f = await centre(browser!, s, '[data-folder-row="research"]')
    const first = await centre(browser!, s, '[data-board="overview"]')
    await drag(browser!, s, f, { x: first.x, y: first.top + 3 })
    await browser!.until(s, `${ROWS}.join() === 'folder:research,  specs,overview,flow,archive,all-scenes'`)
    await settle()
    expect(registry()).toEqual({ version: 1, folders: [{ name: 'research', order: 0 }] })
    expect(readBoard('overview').order).toBe(1)
    expect(readBoard('archive').order).toBe(3)
  })

  skippable('Delete folder puts its boards back at the root in its slot; the registry file goes away', async () => {
    writeBoard('flow', { order: 0, folder: 'research' }); writeBoard('specs', { order: 1, folder: 'research' })
    writeFileSync(join(boardsDir(), '_folders.json'), JSON.stringify({ version: 1, folders: [{ name: 'research', order: 1 }] }))
    const s = await open(browser!)
    await browser!.until(s, `${ROWS}.join() === 'overview,folder:research,  flow,  specs,archive,all-scenes'`)
    const f = await centre(browser!, s, '[data-folder-row="research"]')
    await rightClick(browser!, s, f.x, f.y)
    await pickMenu(browser!, s, 'Delete folder')
    await browser!.until(s, `${ROWS}.join() === 'overview,flow,specs,archive,all-scenes'`)
    await settle()
    expect(registry()).toBeNull()
    expect(readBoard('flow')).toMatchObject({ order: 1 }); expect(readBoard('flow').folder).toBeUndefined()
    expect(readBoard('specs')).toMatchObject({ order: 2 })
  })

  skippable('a click collapses a folder and the choice survives a reload; the active board keeps its folder lit', async () => {
    writeBoard('flow', { order: 0, folder: 'research' }); writeBoard('overview', { order: 1 })
    writeFileSync(join(boardsDir(), '_folders.json'), JSON.stringify({ version: 1, folders: [{ name: 'research', order: 0 }] }))
    const s = await open(browser!)
    await browser!.until(s, `${ROWS}.includes('  flow')`)
    // the landing board is the first board of the sidebar order - inside the folder ranked first
    expect(await browser!.eval(s, `window.__mvStore.getState().board`)).toBe('flow')
    const f = await centre(browser!, s, '[data-folder-row="research"]')
    await mouse(browser!, s, 'mousePressed', f.x, f.y); await mouse(browser!, s, 'mouseReleased', f.x, f.y)
    await browser!.until(s, `!${ROWS}.includes('  flow')`)
    expect(await browser!.eval(s, `document.querySelector('[data-folder-row="research"]').classList.contains('held')`)).toBe(true)
    await browser!.go(s, `${ORIGIN}/`)
    await browser!.until(s, `document.querySelectorAll('.sh-boards [data-folder-row]').length === 1`, 30_000)
    expect(await rows(browser!, s)).not.toContain('  flow')
  })

  skippable('an agent writing `folder` into a board file shows in the sidebar without a reload', async () => {
    const s = await open(browser!)
    writeBoard('archive', { order: 3, folder: 'history' })
    await browser!.until(s, `${ROWS}.join() === 'overview,flow,specs,folder:history,  archive,all-scenes'`, 10_000)
  })

  skippable('a tree write on the ACTIVE board never fights its autosave: the edit lands, the file gains `order`, no reload toast', async () => {
    const s = await open(browser!)
    expect(await browser!.eval(s, `window.__mvStore.getState().board`)).toBe('overview')
    // an unsaved canvas edit (a node moved), then at once a folder move that rewrites overview.json
    await browser!.until(s, `window.__mvStore.getState().nodes.length === 1`)
    await browser!.eval(s, `(() => { const st = window.__mvStore.getState(); const n = st.nodes[0]; st.moveSelectedBy(120, 80, { [n.key]: { x: n.x, y: n.y } }) })()`)
    const c = await centre(browser!, s, '[data-board="overview"]')
    await rightClick(browser!, s, c.x, c.y)
    await pickMenu(browser!, s, 'Move to new folder')
    await browser!.until(s, `document.activeElement?.placeholder === 'Folder name'`)
    await type(browser!, s, 'Live')
    await enter(browser!, s)
    await browser!.until(s, `${ROWS}.join() === 'folder:live,  overview,flow,specs,archive,all-scenes'`)
    await settle(); await settle()
    const file = readBoard('overview')
    expect(file).toMatchObject({ folder: 'live', order: 0 })
    expect(file.nodes[0]).toMatchObject({ x: 120, y: 80 })                       // the edit reached the disk, not the old layout
    const st = await browser!.eval(s, `(() => { const st = window.__mvStore.getState(); return { dirty: st.dirty, toasts: st.toasts.map((t) => t.text), hash: st.boardHash } })()`)
    expect(st.dirty).toBe(false)
    expect(st.toasts.some((t: string) => /changed on disk|could not save/.test(t))).toBe(false)
    const { hash } = await import('../src/server/manifest.ts')
    expect(st.hash).toBe(hash(readFileSync(join(boardsDir(), 'overview.json'), 'utf8')))   // the CAS token is the file's
  })

  skippable('a drag on a stale sidebar replays on what is there now - the agent\'s concurrent edit survives', async () => {
    const s = await open(browser!)
    // Hold the sidebar STALE on purpose: until its first tree write leaves, every re-read answers
    // what it saw at load (the refresh the file write triggers changes nothing). Deterministic,
    // where "write the file quickly before the drag" would race the watcher.
    await browser!.eval(s, `(() => {
      const orig = window.fetch.bind(window); const frozen = {}; window.__mvFrozen = true
      window.fetch = async (u, o) => {
        const url = String(u)
        if (o?.method === 'POST' && url.endsWith('/api/boards/reorder')) window.__mvFrozen = false
        const r = await orig(u, o)
        if (window.__mvFrozen && /\\/api\\/(boards|folders)$/.test(url)) {
          if (!frozen[url]) frozen[url] = { status: r.status, body: await r.clone().text() }
          return new Response(frozen[url].body, { status: frozen[url].status, headers: { 'content-type': 'application/json' } })
        }
        return r
      }
    })()`)
    await browser!.eval(s, `Promise.all([fetch('/__mv/api/boards'), fetch('/__mv/api/folders')])`)   // prime the frozen answers
    // the agent files `specs` while the sidebar still shows it at the root; the human then drags `archive` up
    writeBoard('specs', { order: 2, folder: 'research' })
    await new Promise((r) => setTimeout(r, 600))   // the watcher fires, the sidebar re-reads - and sees the frozen (stale) tree
    expect(await rows(browser!, s)).not.toContain('folder:research')
    const from = await centre(browser!, s, '[data-board="archive"]')
    const to = await centre(browser!, s, '[data-board="overview"]')
    await drag(browser!, s, from, { x: to.x, y: to.top + 3 })
    await browser!.until(s, `${ROWS}[0] === 'archive'`, 10_000).catch(async (e) => {
      const dbg = await browser!.eval(s, `JSON.stringify({ rows: ${ROWS}, toasts: window.__mvStore.getState().toasts.map((t) => t.text) })`)
      throw new Error(`${e.message}\n${dbg}\n${log.slice(-1200)}`)
    })
    await settle(); await settle()
    expect(readBoard('archive').order).toBe(0)
    expect(readBoard('specs').folder).toBe('research')   // never un-foldered by the human's drag
    expect(await rows(browser!, s)).toContain('folder:research')
    // the proof it went through the 409: TWO tree writes left the page (the refused one, then the replay)
    expect(await browser!.eval(s, `performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/api/boards/reorder')).length`)).toBe(2)
  })
})
