import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Sidebar marks (spec 25, variant B), proven where a person sees them: a REAL dev server, a REAL
 * browser, files and comments changing underneath. New is blue with a dot; a question is the
 * orange numbered bubble, hollow once answered; one slot per row; roll-ups on folded rows and on
 * boards you are not on; U; the two-second rule; one notice per round. Skips without Chrome.
 */

const PORT = 6500 + Math.floor(Math.random() * 400)
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
const frame = (name: string) => `export default () => <main><h1>${name}</h1></main>\n`
const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8', env: { ...process.env, CI: '1' } })
const threadOn = (board: string, frameId: string): string =>
  JSON.parse(cli('comments', 'list', '--board', board, '--json')).filter((t: any) => t.frame === frameId && !t.resolved).pop().id

// page-side helpers, installed before the shell loads
const HELPERS = `(() => {
  window.__row = (name) => Array.from(document.querySelectorAll('.sh-panel .sub')).find((r) => r.querySelector('.nm')?.textContent === name)
  window.__mark = (name) => { const r = window.__row(name); if (!r) return 'no-row'
    const b = r.querySelector('.mk-bubble'); return b ? (b.classList.contains('hollow') ? 'answered:' : 'ask:') + b.textContent : r.querySelector('.mk-dot') ? 'new' : 'none' }
  window.__key = (id) => window.__mvStore.getState().nodes.find((n) => n.frame === id)?.key
  window.__head = (id) => { const h = document.querySelector('.sh-node[data-node="' + window.__key(id) + '"] .sh-node-head'); if (!h) return 'no-head'
    const b = h.querySelector('.mk-bubble'); return b ? (b.classList.contains('hollow') ? 'answered:' : 'ask:') + b.textContent : h.classList.contains('mk-new') && h.querySelector('.mk-dot') ? 'new' : 'none' }
  // a test can make the board arrive after the marks, once (the order a slow board load takes)
  const f0 = window.fetch
  window.fetch = async (u, o) => { if (sessionStorage.getItem('mvSlowBoard') && /\\/api\\/boards\\/main/.test(String(u))) { sessionStorage.removeItem('mvSlowBoard'); await new Promise((r) => setTimeout(r, 1200)) } return f0(u, o) }
})()`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const seenOnDisk = (): Record<string, number> => { try { return JSON.parse(readFileSync(join(root, 'design', '.local', 'seen.json'), 'utf8')).frames } catch { return {} } }
/** the revision a frame last changed at, as the dev server recorded it (spec 26) */
const changedOnDisk = (id: string): number => { try { return JSON.parse(readFileSync(join(root, 'design', '.local', 'changes.json'), 'utf8')).frames[id]?.[0] ?? 0 } catch { return 0 } }
const mark = (name: string) => browser!.eval(s, `window.__mark(${JSON.stringify(name)})`)
const until = (expr: string, ms = 15_000) => browser!.until(s, expr, ms)
/** keep the two-second rule out of a step: at this zoom nothing counts as looked at */
const farAway = () => browser!.eval(s, `window.__mvStore.setState({ scale: 0.2 }), 1`)

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-marks-'))
  put('package.json', { name: 'marks-fixture', private: true, type: 'module' })
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  put('design/config.ts', 'export default { jam: false }\n')      // a human reply in a Marver note must not start a real agent
  for (const f of ['alpha', 'bravo', 'charlie']) put(`design/scenes/spec/${f}.tsx`, frame(f))
  put('design/scenes/lofi/delta.tsx', frame('delta'))
  put('design/boards/_folders.json', { version: 1, folders: [{ name: 'features', type: 'feature', order: 1 }] })
  put('design/boards/main.json', { version: 1, name: 'main', auto: false, order: 0, nodes: [{ frame: 'spec/alpha' }, { frame: 'spec/bravo' }, { frame: 'spec/charlie' }] })
  put('design/boards/other.json', { version: 1, name: 'other', auto: false, folder: 'features', status: 'blocked', reason: 'waiting', nodes: [{ frame: 'lofi/delta' }] })
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d; const m = log.match(/→ (http:\/\/localhost:\d+)\//); if (m) ORIGIN = m[1] })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !/→ http:\/\/localhost:\d+\//.test(log)) await new Promise((r) => setTimeout(r, 100))
  while (Date.now() - t0 < 60_000) { if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 200)) }
  browser = await Browser.launch()
  if (!browser) return
  s = await browser.tab({ width: 1400, height: 900 })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS }, s)
  await browser.go(s, `${ORIGIN}/#/b/main`)
  await until(`window.__mvStore?.getState().nodes.length === 3 && !!window.__mvStore.getState().marks && !!window.__row('Alpha')`, 30_000)
  await farAway()
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

describe('sidebar marks (spec 25)', () => {
  skippable('a canvas starts with nothing marked: what was there the day marks arrived counts as seen', async () => {
    expect(await browser!.eval(s, `document.querySelectorAll('.mk-dot, .mk-bubble, .mk-new, .mk-ask').length`)).toBe(0)
    const seen = JSON.parse(readFileSync(join(root, 'design', '.local', 'seen.json'), 'utf8'))
    expect(seen.version).toBe(2)                                              // revisions since spec 26, started with marver dev
    expect(typeof seen.epoch).toBe('string')
  })

  skippable('an edit lights the frame - blue row with a dot, blue header with a dot - and selecting it clears both, on disk too', async () => {
    put('design/scenes/spec/alpha.tsx', frame('alpha, edited'))
    await until(`window.__mark('Alpha') === 'new' && window.__head('spec/alpha') === 'new'`)
    expect(await browser!.eval(s, `window.__row('Alpha').classList.contains('mk-new')`)).toBe(true)
    await browser!.eval(s, `window.__mvStore.getState().select(window.__key('spec/alpha')), 1`)
    await until(`window.__mark('Alpha') === 'none' && window.__head('spec/alpha') === 'none'`)
    for (let i = 0; i < 50 && !seenOnDisk()['spec/alpha']; i++) await sleep(100)
    expect(seenOnDisk()['spec/alpha']).toBeGreaterThan(0)
    await browser!.eval(s, `window.__mvStore.getState().select(null), 1`)
  })

  skippable('a frame link opened in the tab, and a click on one frame of a group selection, each count as looking', async () => {
    put('design/scenes/spec/alpha.tsx', frame('alpha, edited again'))
    await until(`window.__mark('Alpha') === 'new'`)
    await browser!.eval(s, `(location.hash = '#/b/main?f=spec/alpha'), 1`)
    await until(`window.__mark('Alpha') === 'none'`, 1500)                       // before any 2 s dwell could
    put('design/scenes/spec/alpha.tsx', frame('alpha, edited before a fresh load'))
    await until(`window.__mark('Alpha') === 'new'`)
    await browser!.eval(s, `sessionStorage.setItem('mvSlowBoard', '1'), 1`)      // the marks land first, the board after
    await browser!.go(s, 'about:blank')                                         // a link opened in a new page
    await browser!.go(s, `${ORIGIN}/#/b/main?f=spec/alpha`)
    for (let i = 0; i < 60 && !(seenOnDisk()['spec/alpha'] >= changedOnDisk('spec/alpha')); i++) await sleep(50)
    expect(seenOnDisk()['spec/alpha']).toBeGreaterThanOrEqual(changedOnDisk('spec/alpha'))
    await browser!.go(s, `${ORIGIN}/#/b/main`)
    await until(`window.__mvStore?.getState().nodes.length === 3 && !!window.__mvStore.getState().marks && !!window.__row('Alpha')`, 30_000)
    await sleep(300); await farAway()
    await browser!.eval(s, `window.__mvStore.getState().selectMany([window.__key('spec/alpha'), window.__key('spec/charlie')]), 1`)
    put('design/scenes/spec/alpha.tsx', frame('alpha, edited a third time'))
    await until(`window.__mark('Alpha') === 'new'`)
    await browser!.eval(s, `(() => { const h = document.querySelector('.sh-node[data-node="' + window.__key('spec/alpha') + '"] .sh-node-head'); const r = h.getBoundingClientRect()
      h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: r.left + 4, clientY: r.top + 4 }))
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, clientX: r.left + 4, clientY: r.top + 4 })); return 1 })()`)
    await until(`window.__mark('Alpha') === 'none'`, 1500)
    expect(await browser!.eval(s, `window.__mvStore.getState().selection.length`)).toBe(2)   // the group stays selected
    await browser!.eval(s, `window.__mvStore.getState().select(null), 1`)
  })

  skippable("a question's life: filled bubble, hollow once you answer, filled at Marver's follow-up, gone when resolved", async () => {
    cli('comments', 'new', 'spec/bravo', '--board', 'main', '--at', 'h1', '--body', 'Which layout - the first or the second?')
    await until(`window.__mark('Bravo') === 'ask:1' && window.__head('spec/bravo') === 'ask:1'`)
    expect(await browser!.eval(s, `window.__row('Bravo').classList.contains('mk-ask')`)).toBe(true)
    const id = threadOn('main', 'spec/bravo')
    await browser!.eval(s, `window.__mvComments.getState().reply(${JSON.stringify(id)}, 'The second one.').then(() => 1)`)
    await until(`window.__mark('Bravo') === 'answered:1'`)
    cli('comments', 'reply', id, '--body', 'And the header - keep it?', '--ask')
    await until(`window.__mark('Bravo') === 'ask:1'`)
    cli('comments', 'resolve', id)
    await until(`window.__mark('Bravo') === 'none' && window.__head('spec/bravo') === 'none'`)
  })

  skippable('a board you are not on: its question takes the status glyph\'s place; a closed folder rolls it up', async () => {
    cli('comments', 'new', 'lofi/delta', '--board', 'other', '--at', 'h1', '--body', 'Is delta still needed?')
    await until(`!!document.querySelector('[data-board="other"] .mk-bubble') && !document.querySelector('[data-board="other"] [data-status-icon]')`)
    expect(await browser!.eval(s, `document.querySelector('[data-board="other"]').classList.contains('mk-ask')`)).toBe(true)
    await browser!.eval(s, `document.querySelector('[data-folder-row="features"]').click(), 1`)   // close the folder
    await until(`!document.querySelector('[data-board="other"]') && document.querySelector('[data-folder-row="features"] .mk-bubble')?.textContent === '1'`)
    await browser!.eval(s, `document.querySelector('[data-folder-row="features"]').click(), 1`)
    cli('comments', 'resolve', threadOn('other', 'lofi/delta'))
    await until(`!!document.querySelector('[data-board="other"] [data-status-icon]') && !document.querySelector('[data-board="other"] .mk-bubble')`)
  })

  skippable('a folded scene rolls its frames up into a blue count; U goes to what needs you first, then what is new', async () => {
    put('design/scenes/spec/charlie.tsx', frame('charlie, edited'))
    await until(`window.__mark('Charlie') === 'new'`)
    const scene = `Array.from(document.querySelectorAll('.sh-panel .it')).find((b) => b.textContent.startsWith('Spec'))`
    await browser!.eval(s, `${scene}.click(), 1`)                                    // fold the scene
    await until(`${scene}.querySelector('small.mk-fresh')?.textContent === '3' && !window.__row('Charlie')`)
    await browser!.eval(s, `${scene}.click(), 1`)
    await until(`!!window.__row('Charlie')`)
    cli('comments', 'new', 'spec/bravo', '--board', 'main', '--at', 'h1', '--body', 'One more question')
    await until(`window.__mark('Bravo') === 'ask:1'`)
    await browser!.press(s, 'u')
    await until(`window.__mvStore.getState().selection[0] === window.__key('spec/bravo')`)
    await browser!.eval(s, `window.__mvComments.getState().reply(${JSON.stringify(threadOn('main', 'spec/bravo'))}, 'answered').then(() => 1)`)
    await until(`window.__mark('Bravo') === 'answered:1'`)
    await browser!.eval(s, `window.__mvStore.getState().select(window.__key('spec/alpha')), 1`)
    await browser!.press(s, 'u')                                                      // nothing needs you now: the next new one
    await until(`window.__mvStore.getState().selection[0] === window.__key('spec/charlie') && window.__mark('Charlie') === 'none'`)
    await browser!.eval(s, `window.__mvStore.getState().select(null), 1`)
  })

  skippable('two seconds on screen at a readable zoom counts as looking; far away it does not', async () => {
    await browser!.eval(s, `window.dispatchEvent(new KeyboardEvent('keydown', { key: '!', code: 'Digit1', shiftKey: true })), 1`)   // ⇧1: fit the board
    await sleep(600)
    await farAway()                                                                  // every frame in view, but too small to read
    put('design/scenes/spec/alpha.tsx', frame('alpha, edited again'))
    await until(`window.__mark('Alpha') === 'new'`)
    await sleep(3500)                                                                // far away: still new
    expect(await mark('Alpha')).toBe('new')
    await browser!.eval(s, `window.__mvStore.setState({ scale: 1 }), 1`)
    await until(`window.__mark('Alpha') === 'none'`, 8000)
    await farAway()
  })

  skippable('in focus, an edit held behind Update is not seen; once applied, two seconds on stage are', async () => {
    await browser!.eval(s, `window.__mvStore.getState().setPlay({ at: 'spec/charlie', device: 'fill', theme: 'light', focus: true }), 1`)
    put('design/scenes/spec/charlie.tsx', frame('charlie, edited in focus'))
    await until(`!!window.__mvStore.getState().playUpdateRevision && window.__mvStore.getState().marks.changed['spec/charlie'] > window.__mvStore.getState().marks.seen['spec/charlie']`)
    await browser!.eval(s, `window.__mvStore.getState().setPlay({ ...window.__mvStore.getState().play, at: 'spec/alpha' }), 1`)
    await sleep(300)
    await browser!.eval(s, `window.__mvStore.getState().setPlay({ ...window.__mvStore.getState().play, at: 'spec/charlie' }), 1`)   // and back: the old version still
    await sleep(3500)                                                                  // held behind Update: not on stage yet
    expect(await browser!.eval(s, `(() => { const m = window.__mvStore.getState().marks; return m.changed['spec/charlie'] > (m.seen['spec/charlie'] ?? 0) })()`)).toBe(true)
    await browser!.eval(s, `window.__mvStore.getState().applyPlayUpdate(), 1`)
    await until(`(() => { const m = window.__mvStore.getState().marks; return m.changed['spec/charlie'] <= (m.seen['spec/charlie'] ?? 0) })()`, 6000)
    expect(await browser!.eval(s, `(() => { const f = [...document.querySelectorAll('iframe')].find((i) => i.src.includes('/stage/')); return f?.contentDocument?.body?.innerText ?? '' })()`)).toMatch(/edited in focus/)
    await browser!.eval(s, `window.__mvStore.getState().setPlay(null), 1`)
    await sleep(300); await farAway()
  })

  skippable("Marver's replies on a board fold into one notice per round; a new question keeps its own", async () => {
    cli('comments', 'new', 'spec/alpha', '--board', 'main', '--at', 'h1', '--body', 'First note')
    cli('comments', 'new', 'spec/charlie', '--board', 'main', '--at', 'h1', '--body', 'Second note')
    await until(`window.__mark('Alpha') === 'ask:1' && window.__mark('Charlie') === 'ask:1'`)
    await browser!.eval(s, `window.__mvStore.getState().clearJamToasts(), 1`)
    cli('comments', 'reply', threadOn('main', 'spec/alpha'), '--body', 'Done on alpha')
    cli('comments', 'reply', threadOn('main', 'spec/charlie'), '--body', 'Done on charlie')
    await until(`(() => { const r = window.__mvStore.getState().toasts.filter((t) => t.jam?.round); return r.length === 1 && r[0].jam.stack?.length === 1 })()`)
    expect(await browser!.eval(s, `document.querySelector('.sh-jam-frame')?.textContent`)).toMatch(/2 replies/)
    // View on the round's notice walks to its earlier reply instead of dropping it
    await browser!.eval(s, `(() => { const st = window.__mvStore.getState(); st.advanceToast(st.toasts.find((t) => t.jam?.round).id); return 1 })()`)
    await until(`(() => { const r = window.__mvStore.getState().toasts.filter((t) => t.jam?.round); return r.length === 1 && !r[0].jam.stack?.length && r[0].jam.frame === 'spec/alpha' })()`)
    // a reply that asks keeps its own notice, and takes its thread out of the round
    cli('comments', 'reply', threadOn('main', 'spec/charlie'), '--body', 'Should charlie keep its header?', '--ask')
    await until(`window.__mvStore.getState().toasts.some((t) => t.jam && !t.jam.round && t.jam.frame === 'spec/charlie')`)
    expect(await browser!.eval(s, `window.__mvStore.getState().toasts.filter((t) => t.jam?.round).map((t) => t.jam.frame).join()`)).toBe('spec/alpha')
  })
})
