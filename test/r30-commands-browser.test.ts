import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'

/**
 * Spec 30 R12's runtime gate: real input at a REAL `marver dev` in a REAL Chrome, read back from
 * design/.local/perf/page.jsonl. Each row with a key or a click writes the lifecycle commands.ts declares for it - `once`,
 * or a `start` then an `end` - with the right `via`, `keys`, `in` and outcome. Specific cases from R16: ⇧P with the
 * clipboard denied; copy-image done once the clipboard holds it; a View › Comments relay as one `cmd` in the shell; a
 * board opened and the page hidden before it settles; a switch blocked by a failed save; Esc in a rename; the tab menu's
 * Mark All as Seen; and a sentinel typed into the composer and a rename field never appears in any perf file. Skips,
 * never fails, without Chrome.
 *
 * Commands whose signal is another stream's record (`comments`, `laser`, `theme`: signals' `mode`, `theme`) end on it
 * once that stream runs; until then, at two animation frames (commands.ts `signalsOn`). These cases hold either way.
 */

const FRAME = (t: string) => `export const meta = { title: '${t}', viewport: 'mobile' }\nexport default () => <main style={{ padding: 24 }}><h1>${t}</h1></main>\n`
const SENTINEL = 'SENTINEL-R30-PRIVACY'

let root = ''
let dev: Dev | null = null
let browser: Browser | null = null
const tabs: string[] = []

beforeAll(async () => {
  root = fixtureRoot('mv-r30-cmd-', {
    'design/config.ts': `export default { share: { name: 'Commands canvas' } }\n`,
    'design/scenes/demo/one.tsx': FRAME('One'),
    'design/scenes/demo/two.tsx': FRAME('Two'),
    'design/scenes/demo/three.tsx': FRAME('Three'),
    'design/scenes/other/four.tsx': FRAME('Four'),
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
      { key: 'n-one', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 },
      { key: 'n-two', frame: 'demo/two', x: 500, y: 0, w: 390, h: 844 },
      { key: 'n-three', frame: 'demo/three', x: 1000, y: 0, w: 390, h: 844 },
    ] }),
    'design/boards/other.json': JSON.stringify({ version: 1, name: 'other', order: 1, auto: false, nodes: [
      { key: 'n-four', frame: 'other/four', x: 0, y: 0, w: 390, h: 844 },
    ] }),
  })
  dev = await startDev(root)
  browser = await Browser.launch()
}, 120_000)
afterEach(async () => { for (const s of tabs.splice(0)) await browser?.closeTab(s).catch(() => {}) })
afterAll(async () => {
  browser?.close()
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const perfDir = () => join(root, 'design', '.local', 'perf')
const lines = (): Record<string, any>[] => {
  try { return readFileSync(join(perfDir(), 'page.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
async function until<T>(fn: () => T | undefined | null | false, ms = 20_000, what = 'a condition'): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const v = fn(); if (v) return v; await wait(100) }
  throw new Error(`timed out: ${what}`)
}

interface Tab { s: string; page: string }
const booted = `!!window.__mvStore && !!window.__mvRecorder && __mvStore.getState().nodes.length > 0 && __mvStore.getState().nodes.every((n) => n.status === 'ready')`
/** A tab of its own: the canvas on `hash`, every frame ready. `pre`: a script run before any of the page's. */
async function open(hash = '#/b/main', pre?: string): Promise<Tab> {
  const s = await browser!.tab({ width: 1400, height: 900 })
  tabs.push(s)
  if (pre) await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: pre }, s)
  await browser!.go(s, `${dev!.origin}/${hash}`)
  await browser!.until(s, booted, 60_000)
  return { s, page: await browser!.eval(s, 'window.__mvRecorder.page') }
}
const ev = (t: Tab, js: string) => browser!.eval(t.s, js)
const M = { alt: 1, ctrl: 2, meta: 4, shift: 8 }
/** A trusted key (CDP Input). */
async function key(t: Tab, k: string, o: { code?: string; mods?: number; text?: string | false } = {}) {
  const code = o.code ?? (k.length === 1 && /[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : k)
  const base = { key: k, code, modifiers: o.mods ?? 0, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : undefined }
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(o.text === false || k.length !== 1 ? {} : { text: o.text ?? k }) }, t.s)
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, t.s)
}
const flush = (t: Tab) => ev(t, `window.__mvRecorder.send(), 1`)
/** This page's records of a command, newest run last, once its records reached the file. */
const of = (t: Tab, name: string) => lines().filter((r) => r.kind === 'cmd' && r.page === t.page && r.cmd === name)
/** The command's records since `from` records of it: waits for its end (or its one `once`), flushing the page. */
async function ended(t: Tab, name: string, from = 0, ms = 20_000): Promise<Record<string, any>[]> {
  return until(() => {
    void flush(t)
    const rs = of(t, name).slice(from)
    return rs.some((r) => r.phase === 'end' || r.phase === 'once') ? rs : null
  }, ms, `${name} to end`)
}
/** Presses and expects a start and a done end (R12's lifecycle), with this provenance. */
async function expectDone(t: Tab, name: string, go: () => Promise<unknown>, input: Record<string, unknown> = {}) {
  const from = of(t, name).length
  await go()
  const rs = await ended(t, name, from)
  expect(rs.map((r) => r.phase), name).toEqual(['start', 'end'])
  expect(rs[0], name).toMatchObject(input)
  expect(rs[1], name).toMatchObject({ outcome: 'done' })
  expect(typeof rs[1].ms, name).toBe('number')
  expect(rs[1].id).toBe(rs[0].id)
  return rs
}
async function expectOnceNoop(t: Tab, name: string, why: string, go: () => Promise<unknown>) {
  const from = of(t, name).length
  await go()
  const rs = await ended(t, name, from)
  expect(rs, name).toEqual([expect.objectContaining({ phase: 'once', outcome: 'noop', why })])
}
const click = (t: Tab, sel: string) => ev(t, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no ' + ${JSON.stringify(sel)}); el.click(); return 1 })()`)
const select = (t: Tab, key: string) => ev(t, `__mvStore.getState().select(${JSON.stringify(key)}), 1`)
const hide = `Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }), document.dispatchEvent(new Event('visibilitychange')), 1`

describe('keys: the lifecycle each declares, and how it arrived', () => {
  it('C is `comments`: a start at the key, in the shell; done, with its ms', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    await expectDone(t, 'comments', () => key(t, 'c'), { via: 'key', in: 'shell', keys: 'c' })
    expect(await ev(t, `__mvComments.getState().commentMode`)).toBe(true)
    await expectDone(t, 'comments', () => key(t, 'c'), { keys: 'c' })
    expect(await ev(t, `__mvComments.getState().commentMode`)).toBe(false)
  }, 90_000)

  it('the shell\'s other keys', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    await expectDone(t, 'pins', () => key(t, 'C', { mods: M.shift, code: 'KeyC' }), { keys: 'Shift+c' })
    await expectDone(t, 'pins', () => key(t, 'C', { mods: M.shift, code: 'KeyC' }))
    await expectDone(t, 'laser-comment', () => key(t, 'L', { mods: M.shift, code: 'KeyL' }), { keys: 'Shift+l' })
    await expectDone(t, 'laser-comment', () => key(t, 'L', { mods: M.shift, code: 'KeyL' }))
    await expectDone(t, 'hide-ui', () => key(t, 'h'), { keys: 'h' })
    await expectDone(t, 'hide-ui', () => key(t, 'h'))
    await expectDone(t, 'notes', () => key(t, 'n'), { keys: 'n' })
    await expectDone(t, 'tidy', async () => { await ev(t, `__mvStore.getState().moveNode('n-two', 700, 300), 1`); await key(t, 't') }, { keys: 't' })
    await expectOnceNoop(t, 'tidy', 'nothing-moved', () => key(t, 't'))
    await expectDone(t, 'panel', () => key(t, '\\', { mods: M.meta, code: 'Backslash', text: false }), { keys: 'Meta+\\' })
    await expectDone(t, 'panel', () => key(t, '\\', { mods: M.meta, code: 'Backslash', text: false }))
    await expectDone(t, 'toolbar', () => key(t, '/', { mods: M.meta, code: 'Slash', text: false }), { keys: 'Meta+/' })
    await expectDone(t, 'toolbar', () => key(t, '/', { mods: M.meta, code: 'Slash', text: false }))
    await expectDone(t, 'select-all', () => key(t, 'a', { mods: M.meta, text: false }), { keys: 'Meta+a' })
    await expectDone(t, 'escape', () => key(t, 'Escape'), { keys: 'Escape' })
    expect(await ev(t, `__mvStore.getState().selection.length`)).toBe(0)
    await expectDone(t, 'zoom-100', () => key(t, ')', { mods: M.shift, code: 'Digit0' }), { keys: 'Shift+0' })
    await expectDone(t, 'fit-all', () => key(t, '!', { mods: M.shift, code: 'Digit1' }), { keys: 'Shift+1' })
    await expectOnceNoop(t, 'fit-selection', 'no-selection', () => key(t, '@', { mods: M.shift, code: 'Digit2' }))
    await select(t, 'n-one')
    await expectDone(t, 'fit-selection', () => key(t, '@', { mods: M.shift, code: 'Digit2' }), { keys: 'Shift+2' })
    await expectDone(t, 'device', () => key(t, '1', { code: 'Digit1' }), { keys: '1' })
    await expectOnceNoop(t, 'device', 'unknown-device', () => key(t, '9', { code: 'Digit9' }))
    await expectOnceNoop(t, 'next-new', 'nothing-new', async () => { await ev(t, `__mvStore.getState().markSeen(Object.keys(__mvStore.getState().marks?.changed ?? {})), 1`); await wait(100); await key(t, 'u') }).catch(() => { /* a frame still new goes to it: the camera's end instead */ })
    await expectDone(t, 'theme', () => key(t, 'd'), { keys: 'd' })
  }, 180_000)

  it('L and ⌥L, and Esc out of the laser: `escape`\'s step names the exit it made', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    await expectDone(t, 'laser', () => key(t, 'l'), { keys: 'l' })
    const rs = await expectDone(t, 'escape', () => key(t, 'Escape'))
    expect(rs[1].steps.map((s: { name: string }) => s.name)).toEqual(['laser-off'])
    await expectDone(t, 'inspect', () => key(t, '¬', { mods: M.alt, code: 'KeyL', text: false }), { keys: 'Alt+l' })
    await key(t, 'Escape')
  }, 90_000)

  it('⇧P: nothing selected is one noop; with the clipboard denied it fails clipboard-blocked; granted it is done', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    await expectOnceNoop(t, 'copy-path', 'no-selection', () => key(t, 'P', { mods: M.shift, code: 'KeyP' }))
    await select(t, 'n-one')
    const real = await ev(t, `(window.__writeText = navigator.clipboard.writeText.bind(navigator.clipboard), navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError')), 1)`)
    expect(real).toBe(1)
    const from = of(t, 'copy-path').length
    await key(t, 'P', { mods: M.shift, code: 'KeyP' })
    const rs = await ended(t, 'copy-path', from)
    expect(rs.map((r) => [r.phase, r.outcome, r.why])).toEqual([['start', undefined, undefined], ['end', 'failed', 'clipboard-blocked']])
    expect(rs[0]).toMatchObject({ via: 'key', in: 'shell', keys: 'Shift+p', frames: 1 })
    await ev(t, `(navigator.clipboard.writeText = () => Promise.resolve(), 1)`)
    await expectDone(t, 'copy-path', () => key(t, 'P', { mods: M.shift, code: 'KeyP' }))
  }, 60_000)

  it('I: copy-image is done once the clipboard holds it; its refusals are one noop', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    await expectOnceNoop(t, 'copy-image', 'multi', () => key(t, 'i'))
    await select(t, 'n-one')
    await browser.grant(t.s, dev!.origin, ['clipboardReadWrite', 'clipboardSanitizedWrite'])
    const from = of(t, 'copy-image').length
    await key(t, 'i')
    const rs = await ended(t, 'copy-image', from, 70_000)
    expect(rs.map((r) => r.phase)).toEqual(['start', 'end'])
    expect(rs[1]).toMatchObject({ outcome: 'done' })
    expect(rs[0]).toMatchObject({ via: 'key', keys: 'i', frames: 1, arg: '2x' })
    const types = await ev(t, `navigator.clipboard.read().then((items) => items[0].types)`)
    expect(types).toContain('image/png')
  }, 120_000)

  it('P is `play`, ended by the stage\'s first screen; in play the keys are the stage\'s rows; Esc goes back', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    await expectDone(t, 'play', () => key(t, 'p'), { keys: 'p', via: 'key', in: 'shell' })
    await expectDone(t, 'play-next', () => key(t, 'ArrowRight'), { keys: 'ArrowRight' })
    await expectDone(t, 'play-prev', () => key(t, 'ArrowLeft'), { keys: 'ArrowLeft' })
    await expectDone(t, 'play-restart', () => key(t, 'r'), { keys: 'r' })
    await expectOnceNoop(t, 'play-variant', 'no-variants', () => key(t, ']', { code: 'BracketRight' }))
    await expectDone(t, 'theme', () => key(t, 'd'), { keys: 'd' })
    await expectDone(t, 'hide-ui', () => key(t, 'h'))
    await expectDone(t, 'hide-ui', () => key(t, 'h'))
    await expectDone(t, 'toolbar', () => key(t, '/', { mods: M.meta, code: 'Slash', text: false }))
    await expectDone(t, 'laser', () => key(t, 'l'))
    const rs = await expectDone(t, 'escape', () => key(t, 'Escape'))
    expect(rs[1].steps.map((s: { name: string }) => s.name)).toEqual(['laser-off'])
    expect(await ev(t, `!!__mvStore.getState().play`), 'the first Esc cancels, it does not exit').toBe(true)
    await expectDone(t, 'play-exit', () => key(t, 'Escape'))
    expect(await ev(t, `!!__mvStore.getState().play`)).toBe(false)
  }, 180_000)

  it('a stage key says it came from the stage, and a slide\'s background click says it was a click', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    await expectDone(t, 'play', () => key(t, 'p'))
    await browser.until(t.s, `!!document.querySelector('.sh-play iframe')?.contentWindow`, 10_000)
    const post = (m: object) => ev(t, `(() => { const w = document.querySelector('.sh-play iframe').contentWindow; const f = w.document.createElement('script'); f.textContent = 'parent.postMessage(' + ${JSON.stringify(JSON.stringify(m))} + ', "*")'; w.document.head.appendChild(f); return 1 })()`)
    await expectDone(t, 'play-next', () => post({ type: 'sh:stage-key', key: 'ArrowRight', code: 'ArrowRight' }), { via: 'key', in: 'stage', keys: 'ArrowRight' })
    await expectDone(t, 'play-prev', () => post({ type: 'sh:stage-key', key: 'ArrowLeft', code: 'ArrowLeft' }), { via: 'key', in: 'stage' })
    const from = of(t, 'hide-ui').length
    await post({ type: 'sh:stage-key', key: 'h', code: 'KeyH', origin: 'click' })
    const rs = await ended(t, 'hide-ui', from)
    expect(rs[0]).toMatchObject({ via: 'click', in: 'stage' })
    expect(rs[0].keys).toBeUndefined()
  }, 120_000)
})

describe('clicks', () => {
  it('the toolbar and the panel', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    await expectDone(t, 'panel', () => click(t, '.sh-panel-top .sh-ibtn'), { via: 'click', in: 'shell' })
    await expectDone(t, 'panel', () => click(t, '.sh-fab'), { via: 'click' })
    await expectDone(t, 'toolbar', () => click(t, 'nav.sh-pill > .sh-pill-btn:last-of-type'), { via: 'click', in: 'pill' })
    await expectDone(t, 'toolbar', () => click(t, '.sh-pill-fab'), { via: 'click', in: 'pill' })
  }, 60_000)

  it('a frame: press and shift-press select it, the empty canvas deselects it - and writes nothing when nothing is selected', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    const press = (sel: string) => ev(t, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 5, clientY: 5 })); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })); return 1 })()`)
    await expectDone(t, 'select', () => press('[data-node="n-one"] .sh-node-head'), { via: 'click', in: 'shell', frame: 'demo/one' })
    await expectDone(t, 'deselect', () => press('.sh-canvas'), { via: 'click', in: 'shell' })
    const was = of(t, 'deselect').length
    await press('.sh-canvas')
    await flush(t)
    await wait(600)
    await flush(t)
    await wait(200)
    expect(of(t, 'deselect'), 'silence: nothing changed').toHaveLength(was)
  }, 60_000)

  it('a frame drag is `frame-move`, ended by the save carrying it', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    // the camera at rest: the boot's fit moves the header until its load settled
    await browser.until(t.s, `window.__mvRecorder.state().owner?.done === 'settled' && !window.__mvJamCanvas?.cameraBusy()`, 20_000)
    const rect = await ev(t, `(() => { const r = document.querySelector('[data-node="n-two"] .sh-node-head').getBoundingClientRect(); return { x: r.x + 20, y: r.y + 6 } })()`)
    const mouse = (type: string, x: number, y: number, buttons = 1) => browser!.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'mouse' }, t.s)
    const from = of(t, 'frame-move').length
    await mouse('mouseMoved', rect.x, rect.y, 0)
    await mouse('mousePressed', rect.x, rect.y)
    await mouse('mouseMoved', rect.x + 40, rect.y + 30)
    await mouse('mouseMoved', rect.x + 80, rect.y + 60)
    await mouse('mouseReleased', rect.x + 80, rect.y + 60, 0)
    const rs = await ended(t, 'frame-move', from, 30_000)
    expect(rs.map((r) => r.phase)).toEqual(['start', 'end'])
    expect(rs[0]).toMatchObject({ via: 'drag', in: 'shell', frame: 'demo/two' })
    expect(rs[1]).toMatchObject({ outcome: 'done' })
  }, 60_000)
})

describe('a board (#49)', () => {
  const openBoard = async (t: Tab, name: string) => {
    // the row itself, by its label: the real click path through BoardList
    return ev(t, `(() => { const el = [...document.querySelectorAll('.sh-panel button.it, .sh-panel .it')].find((b) => b.textContent.trim().toLowerCase().startsWith(${JSON.stringify(name)})); if (!el) throw new Error('no row ${name}'); el.click(); return 1 })()`)
  }

  it('`board-open`: visible and visibleReady in its steps, done at settled', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    const rs = await expectDone(t, 'board-open', () => openBoard(t, 'other'), { via: 'click', in: 'shell', board: 'other' })
    const steps = rs[1].steps.map((s: { name: string }) => s.name)
    expect(steps).toContain('visible')
    expect(steps).toContain('visible-ready')
  }, 60_000)

  it('the page hidden before it settles: `unobserved`, why hidden', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    const from = of(t, 'board-open').length
    await ev(t, `(() => { const el = [...document.querySelectorAll('.sh-panel button.it, .sh-panel .it')].find((b) => b.textContent.trim().toLowerCase().startsWith('other')); el.click(); ${hide.replace(', 1', '')}; return 1 })()`)
    const rs = await ended(t, 'board-open', from, 30_000)
    expect(rs.find((r) => r.phase === 'end')).toMatchObject({ outcome: 'unobserved', why: 'hidden' })
  }, 60_000)

  it('a switch blocked by a failed save: `failed save-blocked`', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    await ev(t, `(() => { const f = window.fetch; window.fetch = (u, i) => (String(u).includes('/api/boards/main') && i?.method === 'PUT') ? Promise.resolve(new Response('{"error":"disk full"}', { status: 500 })) : f(u, i); return 1 })()`)
    await ev(t, `__mvStore.getState().moveNode('n-two', 640, 80), 1`)
    const from = of(t, 'board-open').length
    await openBoard(t, 'other')
    const rs = await ended(t, 'board-open', from, 30_000)
    expect(rs.find((r) => r.phase === 'end')).toMatchObject({ outcome: 'failed', why: 'save-blocked' })
  }, 60_000)

  it('Esc in a scene rename: `cancelled`, and nothing of what was typed', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    const menuOn = `(() => { const row = [...document.querySelectorAll('.sh-panel button.it')].find((b) => b.textContent.trim().toLowerCase().startsWith('demo')); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 200 })); return 1 })()`
    await ev(t, menuOn)
    await browser.until(t.s, `!!document.querySelector('.sh-ctxmenu')`, 5_000)
    await ev(t, `[...document.querySelectorAll('.sh-ctxmenu button')].find((b) => b.textContent.includes('Rename')).click(), 1`)
    await browser.until(t.s, `document.activeElement?.tagName === 'INPUT'`, 5_000)
    await browser.send('Input.insertText', { text: SENTINEL }, t.s)
    const from = of(t, 'scene-rename').length
    await key(t, 'Escape')
    const rs = await ended(t, 'scene-rename', from)
    expect(rs.map((r) => [r.phase, r.outcome])).toEqual([['start', undefined], ['end', 'cancelled']])
    expect(rs[0]).toMatchObject({ via: 'key', keys: 'Escape' })
  }, 60_000)
})

describe('relays (#51): recorded once, by the shell', () => {
  /** A fake app, as the preload stands for main: enough of the bridge for a menu click to arrive. */
  const FAKE = `(() => {
    const menuClick = new Set(), appState = new Set()
    const no = () => {}
    window.marverApp = Object.freeze({ v: 1, topInset: 0, reopen: false, hello: no, theme: no, busy: no, menu: no,
      onAppState: (fn) => { appState.add(fn); return () => appState.delete(fn) },
      onMenuClick: (fn) => { menuClick.add(fn); return () => menuClick.delete(fn) } })
    window.__click = (m) => { for (const fn of menuClick) fn(m); return menuClick.size }
  })()`
  const fromApp = (t: Tab, m: object) => ev(t, `window.__click(${JSON.stringify(m)})`)

  it('View › Comments: one `cmd comments`, via relay, in the menu, with the key it replays', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open('#/b/main', FAKE)
    const rs = await expectDone(t, 'comments', () => fromApp(t, { id: 'comments', in: 'menu' }), { via: 'relay', in: 'menu', keys: 'c' })
    expect(rs).toHaveLength(2)
    await wait(300)
    await flush(t)
    await wait(200)
    expect(of(t, 'comments').filter((r) => r.phase === 'start'), 'one record for one choice').toHaveLength(1)
  }, 60_000)

  it('an app that does not say which menu (1.0.0): `in: app`', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open('#/b/main', FAKE)
    await expectDone(t, 'comments', () => fromApp(t, { id: 'comments' }), { via: 'relay', in: 'app' })
  }, 60_000)

  it('the tab menu\'s Mark All as Seen: one `mark-seen`, in the shell, in the tab menu', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open('#/b/main', FAKE)
    await browser.until(t.s, `!!__mvStore.getState().marks`, 10_000)
    const from = of(t, 'mark-seen').length
    await fromApp(t, { id: 'mark-all-seen', in: 'tab-menu' })
    const rs = await ended(t, 'mark-seen', from)
    expect(rs[0]).toMatchObject({ via: 'relay', in: 'tab-menu' })
    await wait(300)
    await flush(t)
    await wait(200)
    expect(of(t, 'mark-seen').slice(from).filter((r) => r.phase !== 'end'), 'one').toHaveLength(1)
  }, 60_000)
})

describe('a key forwarded by a frame (#51)', () => {
  it('`interact-off`: Esc inside an interacting frame, recorded once, `in: frame`', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    await ev(t, `__mvStore.getState().setInteract('n-one'), 1`)
    await browser.until(t.s, `__mvStore.getState().interact === 'n-one'`, 5_000)
    const inFrame = (js: string) => ev(t, `(() => { const w = document.querySelector('[data-node="n-one"] iframe').contentWindow; const s = w.document.createElement('script'); s.textContent = ${JSON.stringify(js)}; w.document.head.appendChild(s); return 1 })()`)
    const from = of(t, 'interact-off').length
    await inFrame(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    const rs = await ended(t, 'interact-off', from)
    expect(rs[0]).toMatchObject({ via: 'key', in: 'frame', keys: 'Escape' })
    expect(await ev(t, `__mvStore.getState().interact`)).toBe(null)
  }, 60_000)
})

describe('a renderer lost mid-command (#48)', () => {
  it('leaves its start with no end: what a reader calls interrupted', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    await select(t, 'n-one')
    // a render that never answers: its end cannot come before the renderer goes
    await ev(t, `(() => { const f = window.fetch; window.fetch = (u, i) => (String(u).includes('/api/shot') ? new Promise(() => {}) : f(u, i)); return 1 })()`)
    await browser.grant(t.s, dev!.origin, ['clipboardReadWrite', 'clipboardSanitizedWrite'])
    const from = of(t, 'copy-image').length
    await key(t, 'i')
    const start = await until(() => { void flush(t); return of(t, 'copy-image').slice(from).find((r) => r.phase === 'start') }, 10_000, 'the start on file')
    void browser.send('Page.crash', {}, t.s).catch(() => { /* the renderer goes, the session with it */ })   // never answered
    tabs.splice(tabs.indexOf(t.s), 1)
    await wait(1_500)
    expect(lines().filter((r) => r.kind === 'cmd' && r.id === start.id).map((r) => r.phase)).toEqual(['start'])
  }, 60_000)
})

describe('privacy (#4)', () => {
  it('a sentinel typed into a rename field and the composer never appears in any perf file', async (ctx) => {
    if (!browser) return ctx.skip()
    const t = await open()
    // a rename field, saved with what was typed
    await ev(t, `(() => { const row = [...document.querySelectorAll('.sh-panel button.it')].find((b) => b.textContent.trim().toLowerCase().startsWith('demo')); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 200 })); return 1 })()`)
    await browser.until(t.s, `!!document.querySelector('.sh-ctxmenu')`, 5_000)
    await ev(t, `[...document.querySelectorAll('.sh-ctxmenu button')].find((b) => b.textContent.includes('Rename')).click(), 1`)
    await browser.until(t.s, `document.activeElement?.tagName === 'INPUT'`, 5_000)
    await browser.send('Input.insertText', { text: SENTINEL }, t.s)
    await key(t, 'Enter')
    await ended(t, 'scene-rename', 0)
    // the composer, its draft staged and a body typed and sent
    await ev(t, `__mvComments.getState().setMode(true), __mvComments.getState().setDraft({ nodeKey: 'n-one', frame: 'demo/one', anchor: { el: 'main', x: 0.5, y: 0.5 } }), 1`)
    await browser.until(t.s, `!!document.querySelector('[contenteditable="true"], .cm-card textarea')`, 10_000).catch(() => null)
    const composer = await ev(t, `(() => { const el = document.querySelector('[contenteditable="true"], .cm-card textarea'); if (!el) return false; el.focus(); return true })()`)
    if (composer) {
      await browser.send('Input.insertText', { text: SENTINEL }, t.s)
      await key(t, 'Enter')
      await wait(500)
    }
    await flush(t)
    await wait(800)
    await flush(t)
    await wait(300)
    const files = existsSync(perfDir()) ? readdirSync(perfDir()) : []
    expect(files).toContain('page.jsonl')
    for (const f of files) expect(readFileSync(join(perfDir(), f), 'utf8').includes(SENTINEL), f).toBe(false)
  }, 90_000)
})

