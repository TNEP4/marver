import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Jam V2 (spec 27) inside a frame: the keys the shell owns, the capture recorder, probes, the flush,
 * and safeBundle - in a REAL frame document served by a REAL dev server, driven from its parent the
 * way the shell drives it. The test page loads the frame (and the play stage) in its own iframe and
 * talks postMessage both ways. Skips without Chrome.
 */

const PORT = 7400 + Math.floor(Math.random() * 400)
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

const F1 = `export default () => (
  <main style={{ padding: 20, fontFamily: 'sans-serif' }}>
    <h1>Kit one</h1>
    <button id="go" data-testid="go-btn" onClick={() => { (window as any).__clicks = ((window as any).__clicks || 0) + 1 }}>Go</button>
    <p id="hoverme" style={{ marginTop: 30, padding: 20, background: '#eee' }}>Hover target</p>
    <input id="name" type="text" defaultValue="" />
    <input id="pw" type="password" defaultValue="" />
    <label htmlFor="cc">Card number</label><input id="cc" type="text" defaultValue="" />
    <label htmlFor="otp1">One time code</label><input id="otp1" type="text" defaultValue="" />
    <input id="otp2" type="text" aria-label="One\u2011time code" defaultValue="" />
    <div id="parent" style={{ padding: 10 }}>Parent words
      <textarea defaultValue="SECRET-TEXTAREA" />
      <div id="ed" contentEditable suppressContentEditableWarning>SECRET-EDITABLE<span id="inner">SECRET-SPAN</span></div>
    </div>
    <div id="tokened" contentEditable suppressContentEditableWarning aria-label="token sk_live_SECRET" data-testid="tok_SECRET">x</div>
    <select id="sel" defaultValue="a"><option value="a">A</option><option value="b">B</option></select>
    <p><a data-goto="kit/f2" id="next" style={{ display: 'inline-block', padding: 8 }}>Next</a></p>
  </main>
)
`
const F2 = `export default () => <main style={{ padding: 20 }}><h1>Kit two</h1><button id="back">Back</button></main>\n`

/** The test page: one iframe it owns, every message from it recorded. */
const HARNESS = (src: string) => `(() => {
  document.getElementById('mv-harness')?.remove()
  window.__msgs = []
  window.removeEventListener('message', window.__onmsg || (() => {}))
  window.__onmsg = (e) => { if (window.__f && e.source === window.__f.contentWindow) window.__msgs.push(e.data) }
  window.addEventListener('message', window.__onmsg)
  const f = document.createElement('iframe')
  f.id = 'mv-harness'
  f.src = ${JSON.stringify(src)}
  f.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:800px;z-index:2147483647;border:0;background:#fff'
  document.body.appendChild(f)
  window.__f = f
  window.__send = (m) => f.contentWindow.postMessage(m, location.origin)
  window.__of = (type) => window.__msgs.filter((m) => m && m.type === type)
  window.__fdoc = () => f.contentDocument
  window.__rect = (sel) => { const r = f.contentDocument.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  return 1
})()`

const ev = (expr: string) => browser!.eval(s, expr)
const until = (expr: string, ms = 15_000) => browser!.until(s, expr, ms)
const send = (m: object) => ev(`window.__send(${JSON.stringify(m)}), 1`)
const of = (type: string) => ev(`JSON.parse(JSON.stringify(window.__of(${JSON.stringify(type)})))`)
const clear = () => ev(`(window.__msgs.length = 0), 1`)
const at = (sel: string) => ev(`window.__rect(${JSON.stringify(sel)})`)
const mouse = async (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', p: { x: number; y: number }) =>
  browser!.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) }, s)
const click = async (sel: string) => { const p = await at(sel); await mouse('mouseMoved', p); await mouse('mousePressed', p); await mouse('mouseReleased', p) }
/** a trusted key press into whatever has focus (in the frame, once it is focused) */
const key = async (k: string, opts: { code?: string; vk?: number; text?: string; modifiers?: number } = {}) => {
  const base = { key: k, code: opts.code ?? k, windowsVirtualKeyCode: opts.vk ?? k.toUpperCase().charCodeAt(0), modifiers: opts.modifiers ?? 0 }
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(opts.text ? { text: opts.text } : {}) }, s)
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, s)
}
const focusIn = (sel: string) => ev(`(window.__f.contentWindow.focus(), window.__fdoc().querySelector(${JSON.stringify(sel)}).focus(), 1)`)
/** a synthetic keydown inside the frame - for the guards (a field, an IME composition) */
const synth = (sel: string, init: object) => ev(`(() => { const e = new (window.__f.contentWindow.KeyboardEvent)('keydown', { bubbles: true, cancelable: true, ...${JSON.stringify(init)} }); window.__fdoc().querySelector(${JSON.stringify(sel)}).dispatchEvent(e); return e.defaultPrevented })()`)

const loadFrame = async () => {
  await ev(HARNESS(`/__mv/frame/?id=kit/f1&theme=light&r=${Date.now()}`))
  await until(`window.__of('sh:ready').length > 0`, 30_000)
  await clear()
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-rec-'))
  put('package.json', { name: 'rec-fixture', private: true, type: 'module' })
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  put('design/config.ts', 'export default { jam: false }\n')
  put('design/scenes/kit/f1.tsx', F1)
  put('design/scenes/kit/f2.tsx', F2)
  put('design/boards/main.json', { version: 1, name: 'main', auto: false, order: 0, nodes: [] })
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d; const m = log.match(/→ (http:\/\/localhost:\d+)\//); if (m) ORIGIN = m[1] })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !/→ http:\/\/localhost:\d+\//.test(log)) await sleep(100)
  while (Date.now() - t0 < 60_000) { if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break; await sleep(200) }
  browser = await Browser.launch()
  if (!browser) return
  s = await browser.tab({ width: 1200, height: 900 })
  await browser.go(s, `${ORIGIN}/#/b/main`)
  await until(`!!window.__mvStore`, 30_000)
  await loadFrame()
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

describe('the keys the shell owns (keys.js)', () => {
  skippable('an owned key is consumed in the frame and forwarded with its modifiers; the frame\'s own handlers never see it', async () => {
    await loadFrame()
    await ev(`(window.__fdoc().__appKeys = [], window.__fdoc().addEventListener('keydown', (e) => window.__fdoc().__appKeys.push(e.key)), 1)`)
    await send({ type: 'sh:keys', owned: ['e', 'Shift+Enter', 'Alt+ArrowLeft', 'Meta+Enter'] })
    await sleep(100)
    expect(await synth('h1', { key: 'e', code: 'KeyE' })).toBe(true)
    expect(await synth('h1', { key: 'Enter', code: 'Enter', shiftKey: true })).toBe(true)
    expect(await synth('h1', { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })).toBe(true)
    expect(await synth('h1', { key: 'E', code: 'KeyE', shiftKey: true })).toBe(false)     // Shift+e is not e
    await sleep(100)
    expect((await of('sh:key')).map((k: any) => [k.key, k.shift, k.alt, k.meta])).toEqual([['e', false, false, false], ['Enter', true, false, false], ['ArrowLeft', false, true, false]])
    expect(await ev(`window.__fdoc().__appKeys`)).toEqual(['E'])
  })

  skippable('never from an input, textarea, select, contenteditable or an IME composition', async () => {
    await send({ type: 'sh:keys', owned: ['e'] })
    await clear()
    for (const sel of ['#name', '#parent textarea', '#sel', '#ed', '#inner']) expect(await synth(sel, { key: 'e', code: 'KeyE' })).toBe(false)
    expect(await synth('h1', { key: 'e', code: 'KeyE', isComposing: true })).toBe(false)
    await sleep(100)
    expect(await of('sh:key')).toEqual([])
  })

  skippable('Enter owned never presses the focused button; not owned, it does', async () => {
    await send({ type: 'sh:keys', owned: [] })
    await sleep(50)
    await ev(`(window.__f.contentWindow.__clicks = 0, 1)`)
    await focusIn('#go')
    await key('Enter', { code: 'Enter', vk: 13, text: '\r' })
    await sleep(100)
    expect(await ev(`window.__f.contentWindow.__clicks`)).toBe(1)
    await send({ type: 'sh:keys', owned: ['Enter'] })
    await sleep(50)
    await clear()
    await focusIn('#go')
    await key('Enter', { code: 'Enter', vk: 13, text: '\r' })
    await sleep(100)
    expect(await ev(`window.__f.contentWindow.__clicks`)).toBe(1)
    expect((await of('sh:key')).map((k: any) => k.key)).toEqual(['Enter'])
  })

  skippable('Escape not owned leaves interact mode as today; owned, it goes to the shell as a key', async () => {
    await send({ type: 'sh:keys', owned: [] })
    await sleep(50)
    await clear()
    await synth('h1', { key: 'Escape', code: 'Escape' })
    await sleep(50)
    expect((await of('sh:exit-interact')).length).toBe(1)
    await send({ type: 'sh:keys', owned: ['Escape'] })
    await sleep(50)
    await clear()
    await synth('h1', { key: 'Escape', code: 'Escape' })
    await sleep(50)
    expect((await of('sh:exit-interact')).length).toBe(0)
    expect((await of('sh:key')).map((k: any) => k.key)).toEqual(['Escape'])
    await send({ type: 'sh:keys', owned: [] })
  })
})

describe('the capture recorder (trail.js)', () => {
  skippable('the handshake answers only with its nonce, and a reloaded document has a new captureDoc', async () => {
    await loadFrame()
    await send({ type: 'sh:capture-hello', nonce: 'n-1' })
    await until(`window.__of('sh:capture-hello').length === 1`)
    const [a] = await of('sh:capture-hello')
    expect(a.nonce).toBe('n-1')
    expect(typeof a.captureDoc).toBe('string')
    await ev(`(window.__msgs.length = 0, window.__f.contentWindow.location.reload(), 1)`)
    await until(`window.__of('sh:ready').length > 0`, 30_000)
    await send({ type: 'sh:capture-hello', nonce: 'n-2' })
    await until(`window.__of('sh:capture-hello').length === 1`)
    const [b] = await of('sh:capture-hello')
    expect(b.nonce).toBe('n-2')
    expect(b.captureDoc).not.toBe(a.captureDoc)
  })

  skippable('nothing is recorded while no capture is open; a click in a capture is recorded and still clicks', async () => {
    await loadFrame()
    await ev(`(window.__f.contentWindow.__clicks = 0, 1)`)
    await click('#go')
    await sleep(100)
    expect(await of('sh:trail')).toEqual([])
    await send({ type: 'sh:capture', id: 'cap-1', on: true })
    await sleep(50)
    const t0 = Date.now()
    await click('#go')
    await click('h1')
    await until(`window.__of('sh:trail').length === 2`)
    const [c1, c2] = await of('sh:trail')
    expect(await ev(`window.__f.contentWindow.__clicks`)).toBe(2)   // one before the capture, one recorded in it - which still clicked
    expect(c1).toMatchObject({ id: 'cap-1', event: 'click', frame: 'kit/f1', mode: 'interact' })
    expect(c1.bundle.el.semantics.quote).toBe('Go')
    expect(c1.bundle.el.semantics.testId).toBe('go-btn')
    expect(c2.seq).toBeGreaterThan(c1.seq)
    expect(Math.abs(c1.at - t0)).toBeLessThan(5000)
    await send({ type: 'sh:capture', id: 'cap-1', on: false })
    await until(`window.__of('sh:capture-flushed').length === 1`)
  })

  skippable('a laser pick in a capture is one trail pick (no click, no path copy); outside a capture it is a path copy', async () => {
    await loadFrame()
    await send({ type: 'sh:laser', on: true })
    await send({ type: 'sh:capture', id: 'cap-2', on: true })
    await sleep(100)
    await click('#hoverme')
    await until(`window.__of('sh:trail').length >= 1`)
    await sleep(200)
    const trail = await of('sh:trail')
    expect(trail.map((t: any) => t.event)).toEqual(['pick'])
    expect(trail[0].bundle.el.semantics.quote).toBe('Hover target')
    expect(await of('sh:laser-copy')).toEqual([])
    await send({ type: 'sh:capture', id: 'cap-2', on: false })
    await until(`window.__of('sh:capture-flushed').length === 1`)
    await clear()
    await click('#hoverme')
    await until(`window.__of('sh:laser-copy').length === 1`)
    expect(await of('sh:trail')).toEqual([])
    await send({ type: 'sh:laser', on: false })
  })

  skippable('fields: the value of a plain text field; a password or a card field only "changed (N characters)"; the flush sends a pending field first', async () => {
    await loadFrame()
    await send({ type: 'sh:capture', id: 'cap-3', on: true })
    await sleep(50)
    await focusIn('#name')
    await browser!.send('Input.insertText', { text: 'hello' }, s)
    await focusIn('#pw')
    await browser!.send('Input.insertText', { text: 'hunter2SECRET' }, s)
    await focusIn('#cc')
    await browser!.send('Input.insertText', { text: '4242SECRET' }, s)
    await focusIn('#sel')
    await ev(`(() => { const sel = window.__fdoc().querySelector('#sel'); sel.value = 'b'; sel.dispatchEvent(new Event('change', { bubbles: true })); return 1 })()`)
    // #sel's change is still pending (no blur, under 600 ms) when the capture ends: it goes before the flush
    await send({ type: 'sh:capture', id: 'cap-3', on: false })
    await until(`window.__of('sh:capture-flushed').length === 1`)
    const fields = (await of('sh:trail')).filter((t: any) => t.event === 'field')
    expect(fields.map((f: any) => f.value)).toEqual(['hello', 'changed (13 characters)', 'changed (10 characters)', 'b'])
    const flushed = (await of('sh:capture-flushed'))[0]
    expect(flushed.seq).toBe(Math.max(...(await of('sh:trail')).map((t: any) => t.seq)))
    expect(JSON.stringify(await ev('window.__msgs'))).not.toContain('SECRET')
  })

  skippable('one-time codes stay in the frame however they are spelled: "One time code", "One\u2011time code" (a Unicode hyphen)', async () => {
    await loadFrame()
    await send({ type: 'sh:capture', id: 'cap-3b', on: true })
    await sleep(50)
    await focusIn('#otp1')
    await browser!.send('Input.insertText', { text: '123456' }, s)
    await focusIn('#otp2')
    await browser!.send('Input.insertText', { text: '654321' }, s)
    await focusIn('#name')
    await send({ type: 'sh:capture', id: 'cap-3b', on: false })
    await until(`window.__of('sh:capture-flushed').length === 1`)
    const fields = (await of('sh:trail')).filter((t: any) => t.event === 'field')
    expect(fields.map((f: any) => f.value)).toEqual(['changed (6 characters)', 'changed (6 characters)'])
    const all = JSON.stringify(await ev('window.__msgs'))
    expect(all).not.toContain('123456')
    expect(all).not.toContain('654321')
  })

  skippable('a hover: held still 0.8 s is one hover; at most one per 2 s', async () => {
    await loadFrame()
    await send({ type: 'sh:capture', id: 'cap-4', on: true })
    await sleep(50)
    const p = await at('#hoverme')
    await mouse('mouseMoved', p)
    await sleep(1100)
    const p2 = await at('h1')
    await mouse('mouseMoved', p2)
    await sleep(1100)
    const hovers = (await of('sh:trail')).filter((t: any) => t.event === 'hover')
    expect(hovers.length).toBe(1)
    expect(hovers[0].bundle.el.semantics.quote).toBe('Hover target')
    await send({ type: 'sh:capture', id: 'cap-4', on: false })
    await until(`window.__of('sh:capture-flushed').length === 1`)
  })

  skippable('a probe answers with the element at a point, without clicking it', async () => {
    await loadFrame()
    await ev(`(window.__f.contentWindow.__clicks = 0, 1)`)
    const p = await at('#go')
    await send({ type: 'sh:probe', id: 'cap-5', req: 7, x: p.x, y: p.y })
    await until(`window.__of('sh:probe').length === 1`)
    const [a] = await of('sh:probe')
    expect(a.req).toBe(7)
    expect(typeof a.captureDoc).toBe('string')
    expect(a.bundle.el.semantics.quote).toBe('Go')
    expect(await ev(`window.__f.contentWindow.__clicks`)).toBe(0)
  })

  skippable('nothing secret leaves the frame: a password field, a textarea and an editable inside a picked parent, a span in an editable, a field labelled "Card number", a token in an editable\'s aria-label or test id', async () => {
    await loadFrame()
    await send({ type: 'sh:laser', on: true })
    await send({ type: 'sh:capture', id: 'cap-6', on: true })
    await sleep(100)
    for (const sel of ['#pw', '#parent', '#inner', '#cc', '#tokened']) await click(sel)
    await sleep(300)
    const p = await at('#tokened')
    await send({ type: 'sh:probe', id: 'cap-6', req: 1, x: p.x, y: p.y })
    await until(`window.__of('sh:probe').length === 1`)
    const picks = (await of('sh:trail')).filter((t: any) => t.event === 'pick')
    expect(picks.length).toBe(5)
    for (const pk of picks) expect(pk.bundle.el.semantics.quote).toBe('•••')
    expect(picks[0].bundle.el.cssPath).not.toContain('#')
    const all = JSON.stringify(await ev('window.__msgs'))
    for (const secret of ['SECRET', 'sk_live', 'tok_']) expect(all).not.toContain(secret)
    await send({ type: 'sh:capture', id: 'cap-6', on: false })
    await send({ type: 'sh:laser', on: false })
  })
})

describe('the recorder in the play stage', () => {
  skippable('a click and the screen it moves to, each on the frame it happened in; owned keys go up as sh:key', async () => {
    await ev(HARNESS(`/__mv/stage/?at=kit/f1&theme=light`))
    await until(`window.__of('sh:stage-ready').length > 0`, 30_000)
    await sleep(300)
    await clear()
    await send({ type: 'sh:capture', id: 'cap-7', on: true })
    await sleep(50)
    await click('#next')
    await until(`window.__of('sh:trail').length >= 2`)
    const trail = await of('sh:trail')
    expect(trail.map((t: any) => [t.event, t.frame, t.mode])).toEqual([['click', 'kit/f1', 'play'], ['screen', 'kit/f2', 'play']])
    expect(trail[1].to).toBe('kit/f2')
    await send({ type: 'sh:keys', owned: ['s'] })
    await sleep(50)
    expect(await synth('h1', { key: 's', code: 'KeyS' })).toBe(true)
    await sleep(50)
    expect((await of('sh:key')).map((k: any) => k.key)).toEqual(['s'])
    await send({ type: 'sh:capture', id: 'cap-7', on: false })
    await until(`window.__of('sh:capture-flushed').length === 1`)
  })
})
