import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'
import { appendEvents, readLog, replay, type CommentEvent } from '../src/server/comments.ts'

/**
 * Spec 31 B and C where a person sees them: a real `marver dev` (port 5632), headless Chrome. A comment's words
 * selected by a real drag and by ⌘A inside its card; your own message's Edit ("edited") and Delete (asked first; a
 * deleted first comment keeps its replies under "Comment deleted"); Resolve all comments from the board, folder and
 * scene menus and from the app's tab menu (the relay), with Undo; a closed folder's blue dot. Skips without Chrome.
 */

const OWNER = { email: 'nic@local', name: 'Nic' }
const ANA = { email: 'ana@else', name: 'Ana' }
let root = ''
let dev: Dev | null = null
let browser: Browser | null = null
const put = (rel: string, body: string | object) => { const f = join(root, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2)) }
const dir = () => join(root, 'design', 'comments')
const threads = (board: string) => replay(readLog(dir(), board))
const isOpen = (board: string, id: string) => threads(board).some((t) => t.id === id && !t.resolved)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (fn: () => boolean, ms = 10_000) => { const by = Date.now() + ms; while (Date.now() < by) { if (fn()) return; await wait(100) } throw new Error('timed out') }

/** The app's preload, faked (r30-commands-browser.test.ts): its menu clicks reach the shell's runMenuItem. */
const FAKE = `(() => {
  const menuClick = new Set(), appState = new Set()
  const no = () => {}
  window.marverApp = Object.freeze({ v: 1, topInset: 0, reopen: false, hello: no, theme: no, busy: no, menu: no,
    onAppState: (fn) => { appState.add(fn); return () => appState.delete(fn) },
    onMenuClick: (fn) => { menuClick.add(fn); return () => menuClick.delete(fn) } })
  window.__click = (m) => { for (const fn of menuClick) fn(m); return menuClick.size }
})()`

const t0 = Date.now() - 120_000
const ev = (o: Partial<CommentEvent> & { id: string }): CommentEvent => ({ ts: t0 + Number(o.id.replace(/\D/g, '') || 0), board: 'main', ...o } as CommentEvent)

beforeAll(async () => {
  root = fixtureRoot('mv-r31-br-')
  put('design/config.ts', 'export default { jam: false }\n')
  for (const f of ['spec/alpha', 'spec/bravo', 'lofi/delta']) put(`design/scenes/${f}.tsx`, `export default () => <main style={{ padding: 40 }}><h1>${f}</h1></main>\n`)
  put('design/boards/_folders.json', { version: 1, folders: [{ name: 'features', order: 1 }] })
  put('design/boards/main.json', { version: 1, name: 'main', order: 0, nodes: [{ frame: 'spec/alpha' }, { frame: 'spec/bravo' }] })
  put('design/boards/other.json', { version: 1, name: 'other', folder: 'features', nodes: [{ frame: 'lofi/delta' }] })
  put('design/.local/profile.json', OWNER)
  appendEvents(dir(), 'main', [
    ev({ id: 'e1', type: 'create', commentId: 'th-copy', frame: 'spec/alpha', author: OWNER, body: 'Copy these exact words please' }),
    ev({ id: 'e2', type: 'reply', commentId: 'rp-mine', parentId: 'th-copy', author: OWNER, body: 'a reply of mine to edit' }),
    ev({ id: 'e3', type: 'reply', commentId: 'rp-ana', parentId: 'th-copy', author: ANA, body: 'Ana says hello' }),
    ev({ id: 'e4', type: 'create', commentId: 'th-marver', frame: 'spec/bravo', author: OWNER, agent: true, body: 'Marver asks: wallet first?' }),
    ev({ id: 'e5', type: 'create', commentId: 'th-gone', frame: 'spec/bravo', author: OWNER, body: 'a note I will delete' }),
    ev({ id: 'e6', type: 'reply', commentId: 'rp-gone', parentId: 'th-gone', author: ANA, body: 'Ana answered the deleted note' }),
    ev({ id: 'e8', type: 'create', commentId: 'th-cap', frame: 'spec/alpha', author: OWNER, capture: 'cap-test-01', facts: '0:05', body: 'what I said in a capture' }),
  ])
  appendEvents(dir(), 'other', [ev({ id: 'e7', type: 'create', commentId: 'th-delta', board: 'other', frame: 'lofi/delta', author: OWNER, body: 'on delta' })])
  dev = await startDev(root, { args: ['--port', '5632'] })
  browser = await Browser.launch()
}, 120_000)

afterAll(async () => {
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

async function open(hash: string, fake = false): Promise<string> {
  const s = await browser!.tab({ width: 1400, height: 900 })
  if (fake) await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE }, s)
  await browser!.go(s, `${dev!.origin}/${hash}`)
  await browser!.until(s, `window.__mvStore?.getState().nodes.length >= 1 && !!window.__mvStore.getState().marks && !!document.querySelector('.sh-boards [data-board-row]')`, 30_000)
  return s
}
const mouse = (s: string, type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number, clickCount = 1) =>
  browser!.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount }, s)
const rectOf = (s: string, sel: string) => browser!.eval(s, `(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r && { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
const menuOn = async (s: string, sel: string) => {
  await browser!.eval(s, `(() => { const el = typeof ${JSON.stringify(sel)} === 'string' ? document.querySelector(${JSON.stringify(sel)}) : null; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5 })) })()`)
  await browser!.until(s, `!!document.querySelector('.sh-ctxmenu')`)
}
const menuLabels = (s: string) => browser!.eval(s, `Array.from(document.querySelectorAll('.sh-ctxmenu button')).map((b) => b.textContent)`)
const pick = (s: string, label: string) => browser!.eval(s, `Array.from(document.querySelectorAll('.sh-ctxmenu button')).find((x) => x.textContent === ${JSON.stringify(label)}).click()`)
const toast = (s: string) => browser!.eval(s, `Array.from(document.querySelectorAll('.sh-toast')).map((t) => t.textContent).join(' | ')`)

describe('comments you can copy (spec 31 C.1)', () => {
  it('a real drag selects a message\'s words; ⌘A in the card selects its text, never every frame', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await open('#/b/main?c=th-copy')
    await browser.until(s, `!!document.querySelector('.cm-card[data-thread="th-copy"] .cm-body')`, 20_000)
    await wait(600)
    const r = await rectOf(s, '.cm-card[data-thread="th-copy"] .cm-scroll > .cm-body')
    expect(r).toBeTruthy()
    await mouse(s, 'mousePressed', r.x + 34, r.y + r.h / 2)
    for (const k of [0.3, 0.6, 1]) await mouse(s, 'mouseMoved', r.x + 34 + (r.w - 36) * k, r.y + r.h / 2)
    await mouse(s, 'mouseReleased', r.x + r.w - 2, r.y + r.h / 2)
    expect(await browser.eval(s, `getSelection().toString()`)).toMatch(/Copy these exact words/)
    // (the thread's link selects its frame; ⌘A must leave that as it is)
    const frames = await browser.eval(s, `JSON.stringify(__mvStore.getState().selection)`)
    expect(await browser.eval(s, `__mvStore.getState().nodes.length`)).toBe(2)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] }, s)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 }, s)
    await wait(200)
    const sel = await browser.eval(s, `getSelection().toString()`)
    expect(sel).toMatch(/Copy these exact words/)
    expect(sel).toMatch(/Ana says hello/)
    expect(sel).not.toMatch(/spec\/alpha|spec\/bravo/)
    expect(await browser.eval(s, `JSON.stringify(__mvStore.getState().selection)`)).toBe(frames)
    await browser.closeTab(s)
  }, 90_000)
})

describe('your own messages (spec 31 C.2-C.4)', () => {
  it('Edit on yours only; the edit lands as an edit event and shows "edited"; Delete asks, then hides it', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await open('#/b/main?c=th-copy')
    await browser.until(s, `!!document.querySelector('.cm-card [data-edit="rp-mine"]')`, 20_000)
    // the owner's two messages offer Edit; Ana's does not
    expect(await browser.eval(s, `Array.from(document.querySelectorAll('.cm-card [data-edit]')).map((b) => b.dataset.edit).sort()`)).toEqual(['rp-mine', 'th-copy'])
    await browser.eval(s, `document.querySelector('.cm-card [data-edit="rp-mine"]').click()`)
    await browser.until(s, `!!document.querySelector('.cm-editing textarea')`)
    await browser.eval(s, `(() => { const ta = document.querySelector('.cm-editing textarea'); ta.focus(); ta.select() })()`)
    await browser.send('Input.insertText', { text: 'a reply of mine, edited' }, s)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, s)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, s)
    await until(() => threads('main').find((t) => t.id === 'th-copy')!.replies.find((r) => r.id === 'rp-mine')!.body === 'a reply of mine, edited')
    await browser.until(s, `!!document.querySelector('.cm-card [data-msg="rp-mine"] .cm-edited') && !document.querySelector('.cm-editing')`)
    // Delete: asked first
    await browser.eval(s, `document.querySelector('.cm-card [data-delete="rp-mine"]').click()`)
    await browser.until(s, `!!document.querySelector('[data-confirm-delete="rp-mine"]')`)
    expect(readLog(dir(), 'main').some((e) => e.type === 'delete')).toBe(false)
    await browser.eval(s, `document.querySelector('[data-confirm-delete="rp-mine"] .danger').click()`)
    await until(() => readLog(dir(), 'main').some((e) => e.type === 'delete' && e.commentId === 'rp-mine'))
    await browser.until(s, `!document.querySelector('.cm-card [data-msg="rp-mine"]')`)
    await browser.closeTab(s)
  }, 90_000)

  it('a capture\'s own comment is yours to edit and delete too', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await open('#/b/main?c=th-cap')
    await browser.until(s, `!!document.querySelector('.cm-card[data-thread="th-cap"]')`, 20_000)
    await browser.until(s, `!!document.querySelector('.cm-card [data-edit="th-cap"]') && !!document.querySelector('.cm-card [data-delete="th-cap"]')`, 10_000)
    await browser.closeTab(s)
  }, 60_000)

  it('a deleted first comment keeps its replies under "Comment deleted"', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await open('#/b/main?c=th-gone')
    await browser.until(s, `!!document.querySelector('.cm-card [data-delete="th-gone"]')`, 20_000)
    await browser.eval(s, `document.querySelector('.cm-card [data-delete="th-gone"]').click()`)
    await browser.until(s, `!!document.querySelector('[data-confirm-delete="th-gone"] .danger')`)
    await browser.eval(s, `document.querySelector('[data-confirm-delete="th-gone"] .danger').click()`)
    await browser.until(s, `!!document.querySelector('.cm-card[data-thread="th-gone"] [data-deleted]')`)
    const text = await browser.eval(s, `document.querySelector('.cm-card[data-thread="th-gone"] .cm-scroll').textContent`)
    expect(text).toMatch(/Comment deleted/)
    expect(text).toMatch(/Ana answered the deleted note/)
    expect(text).not.toMatch(/a note I will delete/)
    await browser.closeTab(s)
  }, 90_000)
})

describe('Resolve all comments (spec 31 B.1-B.3, B.7)', () => {
  it('the board menu: beside Mark all as seen; resolves what the board shows; Undo reopens', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await open('#/b/main')
    await menuOn(s, '.sh-boards [data-board-row][data-board="main"]')
    const labels = await menuLabels(s)
    expect(labels.indexOf('Resolve all comments')).toBe(labels.indexOf('Mark all as seen') + 1)
    await pick(s, 'Resolve all comments')
    await until(() => !isOpen('main', 'th-copy') && !isOpen('main', 'th-marver'))
    expect(isOpen('other', 'th-delta')).toBe(true)    // another board's thread: out of scope
    await browser.until(s, `!!document.querySelector('.sh-toast-act')`)
    // th-gone's first comment was deleted: its thread stays (Ana's reply) - open, so resolved too
    expect(await toast(s)).toMatch(/Resolved 4 conversations/)
    await browser.eval(s, `document.querySelector('.sh-toast-act').click()`)
    await until(() => isOpen('main', 'th-copy') && isOpen('main', 'th-marver') && isOpen('main', 'th-gone'))
    await browser.until(s, `Array.from(document.querySelectorAll('.sh-toast')).some((t) => /Reopened 4 \\(finished Jam items stay finished\\)/.test(t.textContent))`)
    await browser.closeTab(s)
  }, 90_000)

  it('the folder and scene menus resolve their own scope; a closed folder wears a blue dot, never a count', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await open('#/b/main')
    // close the folder; a frame inside it changes: new, so a dot - its board count is gone
    await browser.eval(s, `document.querySelector('[data-folder-row="features"]').click()`)
    await browser.until(s, `document.querySelector('[data-folder-row="features"]').dataset.open === '0'`)
    const f = join(root, 'design', 'scenes', 'lofi', 'delta.tsx')
    writeFileSync(f, `export default () => <main style={{ padding: 40 }}><h1>lofi/delta, changed</h1></main>\n`)
    utimesSync(f, new Date(), new Date())
    await browser.until(s, `!!document.querySelector('[data-folder-row="features"] .mk-dot')`, 20_000)
    expect(await browser.eval(s, `document.querySelector('[data-folder-row="features"] small')`)).toBeNull()
    expect(await browser.eval(s, `document.querySelector('[data-folder-row="features"]').textContent.trim()`)).toBe('Features')
    await menuOn(s, '[data-folder-row="features"]')
    expect(await menuLabels(s)).toContain('Resolve all comments')
    await pick(s, 'Resolve all comments')
    await until(() => !isOpen('other', 'th-delta'))
    expect(isOpen('main', 'th-copy')).toBe(true)
    // the scene header: spec's frames
    const scene = await browser.eval(s, `(() => { const b = Array.from(document.querySelectorAll('.sh-panel button.it')).find((x) => x.textContent.startsWith('Spec')); if (!b) return false; b.setAttribute('data-test-scene', '1'); return true })()`)
    expect(scene).toBe(true)
    await menuOn(s, '[data-test-scene]')
    const labels = await menuLabels(s)
    expect(labels.indexOf('Resolve all comments')).toBe(labels.indexOf('Mark all as seen') + 1)
    await pick(s, 'Resolve all comments')
    await until(() => !isOpen('main', 'th-copy') && !isOpen('main', 'th-marver'))
    await browser.closeTab(s)
  }, 120_000)

  it('the app\'s tab menu (the relay): every open thread on the canvas, with its notice', async (ctx) => {
    if (!browser) return ctx.skip()
    // reopen everything by hand first
    const now = Date.now()
    for (const [board, id] of [['main', 'th-copy'], ['main', 'th-marver'], ['main', 'th-gone'], ['main', 'th-cap'], ['other', 'th-delta']] as const)
      appendEvents(dir(), board, [{ id: `ro-${id}-${now}`, ts: now, type: 'reopen', commentId: id, board }])
    const s = await open('#/b/main', true)
    await browser.until(s, `!!window.__click`)
    expect(await browser.eval(s, `window.__click({ id: 'resolve-all-comments', in: 'tab-menu' })`)).toBeGreaterThan(0)
    await until(() => !isOpen('main', 'th-copy') && !isOpen('main', 'th-marver') && !isOpen('other', 'th-delta'))
    await browser.until(s, `Array.from(document.querySelectorAll('.sh-toast')).some((t) => /Resolved 5 conversations/.test(t.textContent))`)
    await browser.closeTab(s)
  }, 90_000)
})
