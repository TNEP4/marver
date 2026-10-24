import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'
import { Browser } from './browser.ts'

/**
 * Perf mode, the page's half of a headless run (spec 28 A3.8 #17, #18), in a real browser on a real dev canvas: with
 * `?mvperfrun=<id>` the shell refuses every write but its records and its bakes before sending - the network sees
 * none - names the run on every request and in every frame's URL, posts nothing in a warm-up, answers `flush()` by
 * what landed, counts its bake work (the settle timer, a request on its way, a COMPILING retry) and never asks
 * before leaving. The id here is registered nowhere: the server refuses what carries it, and takes no record of it.
 * Skips, never fails, without Chrome.
 */

const ID = '0123456789abcdef'
const GLASS = `export default () => (
  <main style={{ position: 'relative', minHeight: '100vh', margin: 0, background: 'linear-gradient(135deg, #ff7a59, #7b61ff)' }}>
    <div style={{ position: 'absolute', left: 40, top: 40, width: 300, padding: 18, borderRadius: 16, background: 'rgba(255,255,255,.35)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>Past due</div>
  </main>
)
`
const DOC = (n: number) => `import { Doc, Md } from '@marver-design/marver/content'
export default () => <Doc>${Array.from({ length: n }, (_, i) => `<Md>{${JSON.stringify(`## Part ${i + 1}\n\nA paragraph long enough to wrap across a couple of lines, so the height is real.`)}}</Md>`).join('')}</Doc>
`

let root = ''
let dev: Dev | null = null
let browser: Browser | null = null
const tabs: string[] = []
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  browser = await Browser.launch()
  if (!browser) return
  root = fixtureRoot('mv-perfmode-', {
    'design/config.ts': 'export default { jam: false }\n',
    'design/scenes/app/glass.tsx': GLASS,
    'design/scenes/docs/a.tsx': DOC(4),
    'design/scenes/docs/b.tsx': DOC(2),
    'design/scenes/pages/p.html': '<!doctype html><html><body><h1>page</h1></body></html>\n',
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
      { key: 'g', frame: 'app/glass', x: 0, y: 0, w: 600, h: 400 },
      { key: 'a', frame: 'docs/a', x: 700, y: 0 },
      { key: 'b', frame: 'docs/b', x: 1500, y: 0 },
      { key: 'p', frame: 'pages/p', x: 0, y: 500, w: 400, h: 300 },
    ] }),
  })
  dev = await startDev(root)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

type Req = { method: string; url: string; headers: Record<string, string>; body?: string }
/** A tab, with every request it sends to the canvas's API seen on its way out; `answer` may answer one itself
 *  (a status and body) or hold it (`'hold'`, released by `release()`). */
async function open(query: string, answer: (r: Req) => { status: number; body: string } | 'hold' | undefined = () => undefined) {
  for (const t of tabs.splice(0)) await browser!.closeTab(t).catch(() => {})
  const s = await browser!.tab({ width: 1440, height: 900 })
  tabs.push(s)
  const sent: Req[] = []
  const held: string[] = []
  browser!.on((m) => {
    if (m.method !== 'Fetch.requestPaused' || m.sessionId !== s) return
    const { requestId, request } = m.params
    const r: Req = { method: request.method, url: request.url, headers: Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: request.postData }
    sent.push(r)
    const a = answer(r)
    if (a === 'hold') held.push(requestId)
    else if (a) void browser!.send('Fetch.fulfillRequest', { requestId, responseCode: a.status, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(a.body).toString('base64') }, s).catch(() => {})
    else void browser!.send('Fetch.continueRequest', { requestId }, s).catch(() => {})
  })
  await browser!.send('Fetch.enable', { patterns: [{ urlPattern: '*/__mv/api/*', requestStage: 'Request' }] }, s)
  await browser!.go(s, `${dev!.origin}/${query}#/b/main`)
  await browser!.until(s, 'window.__mvPerfRun ? true : (window.__mvRecorder ? "no-probe" : false)', 30_000)
  const release = async () => { for (const id of held.splice(0)) await browser!.send('Fetch.continueRequest', { requestId: id }, s).catch(() => {}) }
  return { s, sent, release }
}
const status = (s: string) => browser!.eval(s, 'window.__mvPerfRun.status()')
const settled = (s: string) => browser!.until(s, '(() => { const l = window.__mvPerfRun.status().load; return l && (l.state === "settled" || l.state === "cut") ? l.state : false })()', 60_000)
const isWrite = (r: Req) => r.method !== 'GET' && r.method !== 'HEAD'
const api = (r: Req) => new URL(r.url).pathname.replace(/^\/__mv\/api\//, '')

describe('perf mode in the page', () => {
  it('refuses each write but its records and bakes before sending - the network sees none - and names the run everywhere', async (ctx) => {
    if (!dev) return ctx.skip()
    const sizesBefore = (() => { try { return readFileSync(join(root, 'design', 'boards', '_sizes.json'), 'utf8') } catch { return 'absent' } })()
    const { s, sent } = await open(`?mvperfrun=${ID}`)
    expect(await settled(s)).toBe('settled')
    const tried = await browser!.eval(s, `(async () => {
      const csrf = (document.cookie.match(/mv_c=([^;]+)/) || [])[1] || ''
      const h = { 'content-type': 'application/json', 'x-mv-c': csrf }
      const asks = [
        ['boards/main', 'PUT', { version: 1, name: 'main', nodes: [] }], ['sizes', 'POST', { heights: { 'docs/a@760': 1234 } }],
        ['marks/seen', 'POST', { epoch: 'x', frames: {} }], ['comments', 'POST', { body: 'hi' }], ['jam/capture', 'POST', {}],
        ['jam/session', 'POST', { on: true }], ['work', 'POST', { frames: ['app/glass'] }], ['poster', 'POST', { src: 'clip.webm' }],
        ['perf/reload', 'POST', { kind: 'x' }], ['perf/jam', 'POST', { kind: 'capture' }], ['boards/main', 'DELETE', null],
      ]
      const out = []
      for (const [path, method, body] of asks) {
        const r = await window.__mvApi.api(path, { method, headers: h, ...(body ? { body: JSON.stringify(body) } : {}) })
        out.push([path, method, r.status, r.headers.get('x-mv-perfrun')])
      }
      return out
    })()`) as [string, string, number, string][]
    for (const [path, method, code, mark] of tried) expect([path, method, code, mark]).toEqual([path, method, 403, 'refused'])
    // its records sent now: flush() says they did not land (the server refused a run it does not know)
    expect(await browser!.eval(s, 'window.__mvPerfRun.flush()')).toBe(false)
    // what left the page: reads, its records, its bakes - nothing else; every request named the run
    const writes = sent.filter(isWrite).map((r) => `${r.method} ${api(r)}`)
    expect(writes.length).toBeGreaterThan(0)
    expect(new Set(writes)).toEqual(new Set(writes.filter((w) => w === 'POST perf/page' || w === 'POST bakes')))
    expect(writes).toContain('POST bakes')
    expect(writes).toContain('POST perf/page')
    expect(sent.every((r) => r.headers['x-mv-perfrun'] === ID), JSON.stringify(sent.filter((r) => r.headers['x-mv-perfrun'] !== ID).map((r) => r.url))).toBe(true)
    const st = await status(s)
    expect(st.refused).toBeGreaterThanOrEqual(tried.length)
    expect(st).toMatchObject({ run: ID, warm: false })
    // frame URLs carry the run: a frame's own write is refused by its Referer, its Video asks no poster
    const srcs = await browser!.eval(s, '[...document.querySelectorAll("iframe")].map((f) => f.src).filter(Boolean)') as string[]
    expect(srcs.length).toBeGreaterThanOrEqual(4)
    for (const src of srcs) expect(new URL(src).searchParams.get('mvperfrun'), src).toBe(ID)
    // the server took nothing: its barrier answered for the unregistered run too
    const sizesAfter = (() => { try { return readFileSync(join(root, 'design', 'boards', '_sizes.json'), 'utf8') } catch { return 'absent' } })()
    expect(sizesAfter).toBe(sizesBefore)
    let page = ''
    try { page = readFileSync(join(root, 'design', '.local', 'perf', 'page.jsonl'), 'utf8') } catch { /* none */ }
    expect(page.includes(ID)).toBe(false)
  }, 120_000)

  it('flush() answers true once the server has taken every record', async (ctx) => {
    if (!dev) return ctx.skip()
    const { s, sent } = await open(`?mvperfrun=${ID}`, (r) => (r.method === 'POST' && api(r) === 'perf/page' ? { status: 200, body: '{"ok":true,"accepted":1}' } : undefined))
    expect(await settled(s)).toBe('settled')
    expect(await browser!.eval(s, 'window.__mvPerfRun.flush()')).toBe(true)
    expect(sent.some((r) => api(r) === 'perf/page')).toBe(true)
  }, 120_000)

  it('a warm-up posts nothing, and still reaches settled', async (ctx) => {
    if (!dev) return ctx.skip()
    const { s, sent } = await open(`?mvperfrun=${ID}&warm=1`)
    expect(await settled(s)).toBe('settled')
    expect((await status(s)).warm).toBe(true)
    expect(await browser!.eval(s, 'window.__mvPerfRun.flush()')).toBe(true)
    await wait(1500)
    expect(sent.filter((r) => api(r) === 'perf/page')).toEqual([])
  }, 120_000)

  it('the page\'s bake work is counted: the settle timer, a bake on its way, a COMPILING answer\'s retry - idle only after', async (ctx) => {
    if (!dev) return ctx.skip()
    // the first bake request held, the next answered COMPILING, the rest let through
    let bakes = 0
    const { s, release } = await open(`?mvperfrun=${ID}`, (r) => {
      if (r.method !== 'POST' || api(r) !== 'bakes') return undefined
      if (++bakes === 1) return 'hold'
      // the server's own word for a compile still running, for each ask as it was asked
      if (bakes === 2) return { status: 200, body: JSON.stringify({ gen: 0, answers: JSON.parse(r.body ?? '{}').asks.map((a: object) => ({ ...a, ok: false, error: 'compiling - ask again' })) }) }
      return undefined
    })
    // the most of each count, sampled every few ms from the page
    await browser!.eval(s, `window.__max = { scheduled: 0, running: 0, queued: 0, inflight: 0 }; setInterval(() => { const b = window.__mvPerfRun.status().bake; for (const k in b) window.__max[k] = Math.max(window.__max[k], b[k]) }, 5)`)
    await browser!.until(s, `window.__mvPerfRun.status().bake.inflight === 1`, 30_000)
    expect((await status(s)).bakeIdle).toBe(false)
    await wait(600)
    expect((await status(s)).bake.inflight, 'held: still on its way').toBe(1)
    await release()
    await browser!.until(s, `(() => { const b = window.__mvPerfRun.status().bake; return b.inflight === 0 })()`, 30_000)
    // the second ask came back COMPILING: a retry waits 4 s, counted
    await browser!.until(s, `window.__mvPerfRun.status().bake.scheduled > 0`, 10_000)
    expect((await status(s)).bakeIdle).toBe(false)
    await browser!.until(s, `window.__mvPerfRun.status().bakeIdle`, 30_000)
    const max = await browser!.eval(s, 'window.__max')
    expect(max.scheduled).toBeGreaterThan(0)
    expect(max.running).toBeGreaterThan(0)
    expect(max.inflight).toBeGreaterThanOrEqual(1)
    // held, then COMPILING (its retry), then the server's own answer - a failure, retried once: idle for good, asking
    // nothing more (a failed frame asked again every 4 s for as long as it rested)
    expect(bakes).toBeGreaterThanOrEqual(3)
    const asked = bakes
    await wait(5000)
    expect(bakes).toBe(asked)
    expect((await status(s)).bakeIdle).toBe(true)
  }, 120_000)

  it('never asks before leaving, even with heights the server never took', async (ctx) => {
    if (!dev) return ctx.skip()
    const dialogs: string[] = []
    const off = browser!.on((m) => { if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.type); void browser!.send('Page.handleJavaScriptDialog', { accept: true }, m.sessionId).catch(() => {}) } })
    try {
      // control: a normal tab whose heights never land asks (it had a click since it loaded)
      const control = await open('', (r) => (r.method === 'POST' && api(r) === 'sizes' ? { status: 500, body: '{}' } : undefined))
      await browser!.until(control.s, `document.querySelectorAll('iframe').length >= 4`, 30_000)
      await wait(3000)
      await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 850, button: 'left', clickCount: 1 }, control.s)
      await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 850, button: 'left', clickCount: 1 }, control.s)
      await browser!.send('Page.navigate', { url: 'about:blank' }, control.s)
      await wait(1000)
      expect(dialogs, 'the control asked').toEqual(['beforeunload'])
      dialogs.length = 0
      // a run's page: its heights are refused in the page, and it goes without a word
      const { s } = await open(`?mvperfrun=${ID}`)
      expect(await settled(s)).toBe('settled')
      await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 850, button: 'left', clickCount: 1 }, s)
      await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 850, button: 'left', clickCount: 1 }, s)
      await browser!.send('Page.navigate', { url: 'about:blank' }, s)
      await browser!.until(s, `location.href === 'about:blank'`, 10_000)
      expect(dialogs).toEqual([])
    } finally { off() }
  }, 120_000)
})
