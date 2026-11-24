import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Search (spec 35) on a real dev canvas: ⌘K opens the lens; every word must match; the selected frame renders live in
 * the preview as a preview (never a canvas frame: its own role, inert, sandboxed, no canvas node); arrowing shows the
 * next frame; Enter lands the canvas on another board's frame through the show path; the kind filter narrows and is
 * remembered; Esc closes.
 */

const PORT = 6700 + Math.floor(Math.random() * 300)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const ORIGIN = `http://localhost:${PORT}`
let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let tab = ''
let log = ''
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ST = 'window.__mvStore.getState()'
const ev = (expr: string) => browser!.eval(tab, expr)
const until = (expr: string, ms = 30_000) => browser!.until(tab, expr, ms)

const page = (title: string, body: string, extra = '') => `export const meta = { title: '${title}'${extra} }
export default () => <main style={{ padding: 40, font: '24px system-ui' }}><h1>${title}</h1><p>${body}</p></main>
`
async function key(k: string, mods: { meta?: boolean } = {}) {
  const base = { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : ({ ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27, Tab: 9 } as Record<string, number>)[k], modifiers: mods.meta ? 4 : 0 }
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(k.length === 1 && !mods.meta ? { text: k } : {}) }, tab)
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, tab)
}
async function type(text: string) { for (const ch of text) await browser!.send('Input.insertText', { text: ch }, tab) }

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-search-browser-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'search-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..')
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(join(repoRoot, 'node_modules'))) if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver') symlinkSync(join(repoRoot, 'node_modules', e), join(nm, e))
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  const scenes = join(root, 'design', 'scenes')
  mkdirSync(join(scenes, 'feed'), { recursive: true }); mkdirSync(join(scenes, 'mail'), { recursive: true })
  writeFileSync(join(scenes, 'feed', 'filter.tsx'), page('Filter the feed', 'Two ready filters', ", description: 'A page, never a pop-over'"))
  writeFileSync(join(scenes, 'feed', 'filter-night.tsx'), page('Filter the feed · Night', 'White on black'))
  writeFileSync(join(scenes, 'feed', 'today.tsx'), page('Feed - today', 'What Delos picked'))
  writeFileSync(join(scenes, 'mail', 'compose.tsx'), page('Compose a reply', 'To Josh, about staging'))
  // not on a board: a frame that makes a sound off the page and unmutes it - the preview must keep it muted
  writeFileSync(join(scenes, 'mail', 'chime.tsx'), `export const meta = { title: 'Chime check' }
const a = new Audio(); a.muted = false; const b = document.createElement('video'); b.muted = false\nconst c = new Audio(); c.autoplay = true\nclass Tone extends Audio { ping() { return 'ping' } }\nconst d = new Tone()\n;(window as any).__media = [a, b, c, d]
export default () => <main><h1>Chime check</h1><p data-muted={String(a.muted && b.muted && c.muted && c instanceof HTMLAudioElement && d instanceof Tone && d.ping() === 'ping')}>chime</p></main>
`)
  writeFileSync(join(scenes, 'feed', 'filter.note.md'), 'Keep the chips at the same weight as day')
  const boards = join(root, 'design', 'boards')
  mkdirSync(boards, { recursive: true })
  writeFileSync(join(boards, 'feed.json'), JSON.stringify({ version: 1, name: 'feed', title: 'Feed', order: 0, auto: false, nodes: [
    { key: 'a', frame: 'feed/today', x: 0, y: 0, w: 600, h: 400 }, { key: 'b', frame: 'feed/filter', x: 700, y: 0, w: 600, h: 400 }, { key: 'c', frame: 'feed/filter-night', x: 1400, y: 0, w: 600, h: 400 },
  ] }))
  writeFileSync(join(boards, '_folders.json'), JSON.stringify({ version: 2, folders: [{ name: 'inbox-work', order: 0, title: 'Inbox work' }, { name: 'drafts', order: 1, title: 'Drafts', parent: 'inbox-work' }] }))
  writeFileSync(join(boards, 'later.json'), JSON.stringify({ version: 1, name: 'later', title: 'Later', folder: 'drafts', order: 2, auto: false, nodes: [] }))
  writeFileSync(join(boards, 'mail.json'), JSON.stringify({ version: 1, name: 'mail', title: 'Mail', folder: 'inbox-work', order: 1, auto: false, nodes: [{ key: 'm', frame: 'mail/compose', x: 0, y: 0, w: 600, h: 400 }] }))
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d }); server.stderr?.on('data', (d) => { log += d })
  for (let t0 = Date.now(); Date.now() - t0 < 60_000; await wait(200)) if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break
  browser = await Browser.launch()
  if (browser) {
    tab = await browser.tab({ width: 1440, height: 900 })
    await browser.go(tab, `${ORIGIN}/#/b/feed`)
    await until(`!!window.__mvStore && ${ST}.board === 'feed' && ${ST}.nodes.length === 3 && ${ST}.nodes.every((n) => n.status === 'ready')`, 60_000)
  }
}, 120_000)

afterAll(async () => {
  try { if (browser) await browser.close() } catch { /* gone */ }
  server?.kill('SIGTERM')
  rmSync(root, { recursive: true, force: true })
})

const maybe = it
describe('search on a real canvas (spec 35)', () => {
  maybe('⌘K opens the lens; every word must match; the selected frame renders live as a preview, never a canvas frame', async (ctx) => {
    if (!browser) return ctx.skip()
    await key('k', { meta: true })
    await until(`!!document.querySelector('.sr-lens input') && document.activeElement === document.querySelector('.sr-lens input')`)
    await type('feed filter')
    await until(`[...document.querySelectorAll('.sr-row .t')].map((e) => e.textContent).includes('Filter the feed')`)
    const titles: string[] = await ev(`[...document.querySelectorAll('.sr-row .t')].map((e) => e.textContent)`)
    expect(titles).toContain('Filter the feed · Night')
    expect(titles).not.toContain('Compose a reply')
    // the preview: the real frame host, as a preview - its role in the URL, inert, sandboxed, and no canvas node for it
    await until(`!!document.querySelector('.sr-stage.on iframe')`)
    const ifr = await ev(`(() => { const f = document.querySelector('.sr-stage.on iframe'); return { src: f.getAttribute('src'), inert: f.hasAttribute('inert'), sandbox: f.getAttribute('sandbox'), drawn: f.contentDocument.querySelector('h1')?.textContent } })()`)
    expect(ifr.src).toContain('purpose=search-preview')
    expect(ifr.inert).toBe(true)
    expect(ifr.sandbox).toBe('allow-scripts allow-same-origin')
    expect(ifr.drawn).toBeTruthy()   // a scene's preview draws its first frame (its caption names the scene)
    expect(await ev(`${ST}.nodes.length`)).toBe(3)
    expect(await ev(`document.querySelector('.sr-stage.on iframe').contentWindow.__mvPreview`)).toBe(true)
  }, 60_000)

  maybe('arrowing shows the next frame (prefetched), the caption always naming what is drawn', async (ctx) => {
    if (!browser) return ctx.skip()
    const first = await ev(`document.querySelector('.sr-cap b').textContent`)
    await key('ArrowDown')
    await until(`document.querySelector('.sr-cap b')?.textContent !== ${JSON.stringify(first)} && !!document.querySelector('.sr-stage.on iframe')?.contentDocument?.querySelector('h1')`)
    const pair = await ev(`({ cap: document.querySelector('.sr-cap b').textContent, drawn: document.querySelector('.sr-stage.on iframe').contentDocument.querySelector('h1').textContent })`)
    expect(pair.drawn).toBe(pair.cap)
  }, 60_000)

  maybe('Enter lands the canvas on a frame of another board, selected, and closes the lens', async (ctx) => {
    if (!browser) return ctx.skip()
    await ev(`(() => { const i = document.querySelector('.sr-lens input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await type('compose reply')
    await until(`document.querySelector('.sr-row.sel .t')?.textContent === 'Compose a reply'`)
    await key('Enter')
    await until(`!document.querySelector('.sr-lens') && ${ST}.board === 'mail' && ${ST}.selection.includes('m')`, 30_000)
  }, 60_000)

  maybe('the kind filter narrows to notes, and is remembered on the next open; Esc closes', async (ctx) => {
    if (!browser) return ctx.skip()
    await key('k', { meta: true })
    await until(`!!document.querySelector('.sr-lens input')`)
    await ev(`document.querySelector('.sr-kinds').click()`)
    await until(`!!document.querySelector('.sr-menu')`)
    // only Notes: "All" is on, so ticking Notes makes it the only kind
    await ev(`[...document.querySelectorAll('.sr-menu button')].find((b) => b.textContent.includes('Notes')).click()`)
    await until(`document.querySelector('.sr-kinds').textContent.startsWith('Notes')`)
    await type('chips')
    await until(`[...document.querySelectorAll('.sr-group')].map((g) => g.textContent).join() === 'Notes'`).catch(async (e) => { console.log('DBG', await ev(`JSON.stringify({ q: document.querySelector('.sr-lens input')?.value, groups: [...document.querySelectorAll('.sr-group')].map((g) => g.textContent), rows: [...document.querySelectorAll('.sr-row .t')].map((e) => e.textContent), active: document.activeElement?.tagName })`)); throw e })
    await key('Escape'); await key('Escape')
    await until(`!document.querySelector('.sr-lens')`)
    await key('k', { meta: true })
    await until(`document.querySelector('.sr-kinds')?.textContent.startsWith('Notes')`)
    await key('Escape')
  }, 60_000)

  maybe('arrowing fast: at most one frame drawn, always the one the caption names; a prefetched frame shows, never stuck behind its skeleton', async (ctx) => {
    if (!browser) return ctx.skip()
    await key('k', { meta: true })
    await until(`!!document.querySelector('.sr-lens input')`)
    // all kinds again, then the frames of the feed
    await ev(`localStorage.clear()`)
    await ev(`document.querySelector('.sr-kinds').click()`); await until(`!!document.querySelector('.sr-menu')`)
    await ev(`[...document.querySelectorAll('.sr-menu button')].find((b) => b.textContent.includes('All')).click()`)
    await ev(`[...document.querySelectorAll('.sr-menu button')].find((b) => b.textContent.includes('Frames')).click()`)
    await key('Escape')
    expect(await ev(`!!document.querySelector('.sr-lens') && !document.querySelector('.sr-menu')`)).toBe(true)   // Esc closed the menu, not the lens
    await type('feed')
    await until(`document.querySelectorAll('.sr-row').length >= 3 && !!document.querySelector('.sr-stage.on')`)
    const sample = `(() => { const on = [...document.querySelectorAll('.sr-stage.on iframe')]; return { n: on.length, drawn: on[0]?.dataset.frame ?? null, cap: document.querySelector('.sr-cap')?.dataset.frame ?? null } })()`
    const bad: unknown[] = []
    for (let k = 0; k < 6; k++) {
      await key(k % 3 === 2 ? 'ArrowUp' : 'ArrowDown')
      for (let t = 0; t < 8; t++) { const x = await ev(sample); if (x.n > 1 || (x.n === 1 && x.drawn !== x.cap)) bad.push(x); await wait(30) }
    }
    if (bad.length) console.log("BAD", JSON.stringify(bad.slice(0, 4)))
    expect(bad).toEqual([])
    // resting on a result whose frame was prefetched: it shows, and the skeleton goes
    await until(`!!document.querySelector('.sr-stage.on') && !document.querySelector('.sr-skel')`, 10_000)
    expect(await ev(`document.querySelectorAll('.sr-live iframe').length`)).toBeLessThanOrEqual(2)
    // Tab stays in the dialog; Esc from the pill closes the lens
    for (let k = 0; k < 3; k++) await key('Tab')
    expect(await ev(`!!document.activeElement?.closest('.sr-lens')`)).toBe(true)
    await ev(`document.querySelector('.sr-kinds').focus()`)
    await key('Escape')
    await until(`!document.querySelector('.sr-lens')`)
    await ev(`localStorage.clear()`)
  }, 90_000)

  maybe('keys typed the instant after ⌘K land in the field and replace the last query (no frame of delay)', async (ctx) => {
    if (!browser) return ctx.skip()
    await key('k', { meta: true })
    await type('compose')
    await until(`document.querySelector('.sr-lens input')?.value === 'compose'`, 10_000)
    await key('Escape')
    await until(`!document.querySelector('.sr-lens')`)
  }, 60_000)

  maybe('a preview plays no sound: media made off the page stays muted when the frame unmutes it', async (ctx) => {
    if (!browser) return ctx.skip()
    await key('k', { meta: true })
    await until(`!!document.querySelector('.sr-lens input')`)
    await type('chime check')
    await until(`document.querySelector('.sr-cap')?.dataset.frame === 'mail/chime' && !!document.querySelector('.sr-stage.on iframe')?.contentDocument?.querySelector('[data-muted]')`)
    expect(await ev(`document.querySelector('.sr-stage.on iframe').contentDocument.querySelector('[data-muted]').dataset.muted`)).toBe('true')
    // the real mute state, read with the shell's own (unpatched) getter - not the preview's override, which always says true
    expect(await ev(`(() => { const get = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted').get; return document.querySelector('.sr-stage.on iframe').contentWindow.__media.map((m) => get.call(m)) })()`)).toEqual([true, true, true, true])
    await key('Escape')
    await until(`!document.querySelector('.sr-lens')`)
  }, 60_000)

  maybe('every row has its icon - an untyped board too (Nic, rc.10: "Quarry Brain, mapped" drew an empty tile)', async (ctx) => {
    if (!browser) return ctx.skip()
    await key('k', { meta: true })
    await until(`!!document.querySelector('.sr-lens input')`)
    // the earlier case left "Frames" picked (remembered); back to All
    await ev(`document.querySelector('.sr-kinds').click()`); await until(`!!document.querySelector('.sr-menu')`)
    await ev(`[...document.querySelectorAll('.sr-menu button')].find((b) => b.textContent.includes('All')).click()`)
    await until(`document.querySelector('.sr-kinds').textContent.startsWith('All')`)
    await key('Escape')
    await type('mail')
    await until(`[...document.querySelectorAll('.sr-row .t')].some((t) => t.textContent === 'Mail')`).catch(async (e) => { console.log('DBG', await ev(`JSON.stringify({ kinds: document.querySelector('.sr-kinds')?.textContent, groups: [...document.querySelectorAll('.sr-group')].map((g) => g.textContent), rows: [...document.querySelectorAll('.sr-row .t')].map((e) => e.textContent) })`)); throw e })
    const empty = await ev(`[...document.querySelectorAll('.sr-row')].filter((r) => !r.querySelector('.ic svg')).map((r) => r.querySelector('.t')?.textContent)`)
    expect(empty).toEqual([])
    // a folder's preview is its boards, listed (spec 35) - not an empty pane
    await ev(`(() => { const i = document.querySelector('.sr-lens input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await type('inbox work')
    await until(`document.querySelector('.sr-row.sel .t')?.textContent === 'Inbox work'`)
    await until(`[...document.querySelectorAll('.sr-folder .b .t')].map((e) => e.textContent).sort().join() === 'Later,Mail'`)
    // a board in a sub-folder names it (Codex, final review)
    expect(await ev(`[...document.querySelectorAll('.sr-folder .b')].find((b) => b.querySelector('.t').textContent === 'Later').querySelector('.w').textContent`)).toBe('Drafts · 0 frames')
    await key('Escape')
    await until(`!document.querySelector('.sr-lens')`)
  }, 60_000)
})
