import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * The recorder's page half (spec 28 A1.7), proven where it happens: a REAL dev server, a REAL browser, and the
 * records it writes to design/.local/perf/page.jsonl. A board load's moves and their causes; settled only when every
 * frame reached its outcome from the document it shows now; a switch mid-load; gestures as they are; errors; nothing
 * at rest; captures first on the way out; and the frame identity rules (A1.10) - a message from an old document never
 * counts, a missing or never-ready frame keeps its outcome, an HTML frame ready before its slow image keeps its.
 * (recorder-browser.test.ts is Jam's capture recorder.) Skips, never fails, without Chrome.
 */

const PORT = 8400 + Math.floor(Math.random() * 300)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
let ORIGIN = `http://localhost:${PORT}`
let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let log = ''

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')
const doc = (paras: number, opts: { extra?: string; layout?: string } = {}) => `import { Doc, Md, Img } from '@marver-design/marver/content'
export default () => (
  <Doc${opts.layout ? ` layout="${opts.layout}"` : ''}>
${opts.extra ?? ''}
${Array.from({ length: paras }, (_, i) => `    <Md>{${JSON.stringify(`## Section ${i + 1}\n\nA paragraph long enough to wrap across a couple of lines in a document-width frame, so the height is real.`)}}</Md>`).join('\n')}
  </Doc>
)
`
const put = (rel: string, body: string | Buffer | object) => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2) + '\n')
}
const board = (name: string, nodes: object[], extra: object = {}) => put(`design/boards/${name}.json`, { version: 1, name, auto: false, ...extra, nodes })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- the log ----------------------------------------------------------------------------------------------------
const pageLog = () => join(root, 'design', '.local', 'perf', 'page.jsonl')
const lines = (): Record<string, any>[] => {
  try { return readFileSync(pageLog(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
type Load = { load: Record<string, any>; recs: Record<string, any>[]; of: (kind: string) => Record<string, any>[]; frame: (node: string) => Record<string, any> | undefined }
/** A page's newest load of a board, and every record it owns (by its request id, which is its load id). */
function loadOf(page: string, board: string): Load | null {
  const all = lines().filter((r) => r.page === page)
  const load = [...all].reverse().find((r) => r.kind === 'load' && r.board === board)
  if (!load) return null
  const recs = all.filter((r) => r.load === load.request).sort((a, b) => a.seq - b.seq)
  const of = (kind: string) => recs.filter((r) => r.kind === kind)
  return { load, recs, of, frame: (node) => of('frame').filter((f) => f.node === node).at(-1) }
}
async function until<T>(fn: () => T | undefined | null | false, ms = 30_000, what = 'a condition'): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const v = fn(); if (v) return v; await wait(100) }
  throw new Error(`timed out waiting for ${what}\nlog tail:\n${lines().slice(-30).map((l) => JSON.stringify(l)).join('\n')}\n${log.slice(-1500)}`)
}
/** The page's load of `board`, once it settled (or was cut) and its records reached the log. */
const ended = (page: string, b: string, ms = 30_000) => until(() => { const l = loadOf(page, b); return l && (l.of('settled').length || l.of('cut').length) ? l : null }, ms, `${b} to settle`)

// ---- the page -----------------------------------------------------------------------------------------------------
// installed in the shell before it loads: the timers and frames scheduled while `__count` is on, with their stacks
const PRE = `(() => {
  if (window.parent !== window) return
  window.__count = false; window.__stacks = []
  for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame']) {
    const orig = window[name]
    window[name] = function (...a) { if (window.__count) window.__stacks.push(name + '\\n' + new Error().stack); return orig.apply(this, a) }
  }
})()`

// the recorder's 120 s deadline, run 80 times faster (1.5 s): its own timers that long, no other
const FAST_DEADLINE = `(() => {
  if (window.parent !== window) return
  const orig = window.setTimeout
  window.setTimeout = function (fn, ms, ...a) { if (ms >= 60000 && /recorder\\.ts/.test(new Error().stack ?? '')) ms = ms / 80; return orig.call(this, fn, ms, ...a) }
})()`

const opened: string[] = []
/** A fresh tab (its page's first load is a `boot`), requests matching `hold` held until released; `pre`, more scripts
 *  to run in it before the page's own. */
async function open(hash: string, hold: string[] = [], pre: string[] = []): Promise<{ s: string; page: string; held: Held }> {
  for (const t of opened.splice(0)) await browser!.go(t, 'about:blank').catch(() => {})
  const s = await browser!.tab({ width: 1440, height: 900 })
  opened.push(s)
  for (const source of [PRE, ...pre]) await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source }, s)
  const held = await holder(s, hold)
  await browser!.go(s, `${ORIGIN}/${hash}`)
  const page = await browser!.until(s, `window.__mvRecorder?.page`, 30_000)
  return { s, page, held }
}
const R = (s: string) => browser!.eval(s, 'window.__mvRecorder.state()')

type Held = { paused: (pattern: string) => number; release: (pattern: string) => Promise<void>; add: (pattern: string) => Promise<void>; stop: () => void }
const glob = (p: string) => new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
/** Hold this tab's requests that match the patterns (Fetch interception) until each pattern is released; `add` holds
 *  one more from then on. */
async function holder(s: string, patterns: string[]): Promise<Held> {
  const all = [...patterns]
  const waiting: { id: string; url: string }[] = []
  const freed = new Set<string>()
  const off = browser!.on((m) => {
    if (m.method !== 'Fetch.requestPaused' || m.sessionId !== s) return
    const { requestId, request } = m.params
    if (!all.some((p) => glob(p).test(request.url))) return   // another interceptor's
    if ([...freed].some((p) => glob(p).test(request.url))) void browser!.send('Fetch.continueRequest', { requestId }, s).catch(() => {})
    else waiting.push({ id: requestId, url: request.url })
  })
  const enable = () => browser!.send('Fetch.enable', { patterns: all.map((urlPattern) => ({ urlPattern, requestStage: 'Request' })) }, s)
  if (all.length) await enable()
  return {
    async add(p) { all.push(p); await enable() },
    paused: (p) => waiting.filter((w) => glob(p).test(w.url)).length,
    async release(p) {
      freed.add(p)
      for (const w of waiting.filter((x) => glob(p).test(x.url))) {
        waiting.splice(waiting.indexOf(w), 1)
        await browser!.send('Fetch.continueRequest', { requestId: w.id }, s).catch(() => {})
      }
    },
    stop: off,
  }
}
/** This tab's record sends (POST /api/perf/page) in order, each answered by `answer(n)` - a status, or undefined to let
 *  it reach the server - with the records it carried; the request cookie's primer (GET /api/work) among them. */
async function sends(s: string, answer: (n: number) => number | undefined) {
  const seen: { url: string; at: number; status?: number; records?: Record<string, any>[] }[] = []
  let n = 0
  const off = browser!.on((m) => {
    if (m.method !== 'Fetch.requestPaused' || m.sessionId !== s) return
    const { requestId, request } = m.params
    const post = /\/api\/perf\/page/.test(request.url)
    if (!post && !/\/api\/work\b/.test(request.url)) return
    const status = post ? answer(n++) : undefined
    seen.push({ url: request.url, at: Date.now(), ...(status ? { status } : {}), ...(post ? { records: JSON.parse(request.postData ?? '{}').records ?? [] } : {}) })
    if (status === undefined) void browser!.send('Fetch.continueRequest', { requestId }, s).catch(() => {})
    else void browser!.send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from('{"error":"not here"}').toString('base64') }, s).catch(() => {})
  })
  await browser!.send('Fetch.enable', { patterns: ['*/api/perf/page*', '*/api/work*'].map((urlPattern) => ({ urlPattern, requestStage: 'Request' })) }, s)
  return { seen, posts: () => seen.filter((x) => x.records), stop: off }
}
/** Nothing waits to be sent, nothing is on its way. */
const drained = (s: string) => browser!.until(s, `(() => { const r = window.__mvRecorder.state(); return r.queued === 0 && !r.sending })()`, 15_000)
const shellError = (s: string, message: string) => browser!.eval(s, `setTimeout(() => { throw new Error(${JSON.stringify(message)}) }), 1`)
/** How many records a batch stood for: one each, a dropped record as many as it says. */
const worth = (records: Record<string, any>[]) => records.reduce((n, r) => n + (r.kind === 'dropped' ? r.n : 1), 0)

/** Run in a frame's own realm (its window), as the document there would. */
const inFrame = (s: string, key: string, code: string) =>
  browser!.eval(s, `document.querySelector('[data-node="${key}"] iframe').contentWindow.eval(${JSON.stringify(code)})`)
const genOf = (s: string, key: string) => browser!.eval(s, `document.querySelector('[data-node="${key}"] iframe').src.match(/[?&]r=(\\d+)/)[1]`)
/** A layout animation at a steady 33 ms per frame (rAF replaced for its length). */
const gesture33 = (s: string) => browser!.eval(s, `(async () => {
  const raf0 = window.requestAnimationFrame
  let t = 0
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(t += 33), 33)
  const w = document.getElementById('sh-world')
  w.classList.add('sh-preset')
  await new Promise((r) => setTimeout(r, 500))
  w.classList.remove('sh-preset')
  await new Promise((r) => setTimeout(r, 50))
  window.requestAnimationFrame = raf0
  return true
})()`)

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-page-rec-'))
  put('package.json', { name: 'page-recorder-fixture', private: true, type: 'module' })
  const repoRoot = join(import.meta.dirname, '..')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(join(repoRoot, 'node_modules'))) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver' && e !== '@marver-design') symlinkSync(join(repoRoot, 'node_modules', e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  put('design/config.ts', 'export default { jam: false }\n')
  put('design/scenes/docs/a.tsx', doc(8))
  put('design/scenes/docs/b.tsx', doc(2))
  put('design/scenes/slowdocs/slow.tsx', doc(2, { extra: '    <Img src="slow.png" caption="slow to arrive" />' }))
  put('design/scenes/widedocs/wide.tsx', doc(2, { layout: 'wide' }))
  put('design/scenes/kit/hifi.tsx', 'export default () => <main><h1>hi-fi</h1></main>\n')
  put('design/scenes/kit/boom.tsx', 'export default function Boom(): never { throw new Error(\'boom in render\') }\n')
  put('design/scenes/kit/hang.tsx', 'export default () => <main><h1>hang</h1></main>\n')
  put('design/scenes/pages/p.html', '<!doctype html><html><body><h1>page</h1><img src="/design/assets/slow2.png" width="64" height="64"></body></html>\n')
  for (const f of ['slow.png', 'slow2.png']) put(`design/assets/${f}`, PNG)
  // a recipe, no positions, no heights known: the shell lays it out, then the Docs report
  board('late', [{ key: 'k-a', frame: 'docs/a' }, { key: 'k-b', frame: 'docs/b' }], { layout: { rows: [['docs']], scenes: { docs: { rows: [['a'], ['b']] } } } })
  // placed by hand: nothing lays it out
  board('still', [{ key: 'k-sb', frame: 'docs/b', x: 0, y: 0 }, { key: 'k-sh', frame: 'kit/hifi', x: 3000, y: 0 }])
  board('slow', [{ key: 'k-slow', frame: 'slowdocs/slow', x: 0, y: 0 }])
  board('wide', [{ key: 'k-w', frame: 'widedocs/wide', x: 0, y: 0, w: 900 }])
  board('hifi', [{ key: 'k-h', frame: 'kit/hifi', x: 0, y: 0 }])
  board('missing', [{ key: 'k-m', frame: 'kit/nope', x: 0, y: 0, w: 390, h: 844 }, { key: 'k-mh', frame: 'kit/hifi', x: 600, y: 0 }])
  board('switch-a', [{ key: 'k-sa', frame: 'slowdocs/slow', x: 0, y: 0 }])
  board('switch-b', [{ key: 'k-sw', frame: 'kit/hifi', x: 0, y: 0 }])
  board('errors', [{ key: 'k-boom', frame: 'kit/boom', x: 0, y: 0 }])
  board('never', [{ key: 'k-hang', frame: 'kit/hang', x: 0, y: 0 }, { key: 'k-nope', frame: 'kit/nope', x: 600, y: 0, w: 390, h: 844 }])
  board('pair', [{ key: 'k-ph', frame: 'kit/hifi', x: 0, y: 0 }, { key: 'k-pg', frame: 'kit/hang', x: 600, y: 0 }])
  board('html', [{ key: 'k-p', frame: 'pages/p', x: 0, y: 0 }])
  board('send', [{ key: 'k-s', frame: 'kit/hifi', x: 0, y: 0 }])
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d; const m = log.match(/→ (http:\/\/localhost:\d+)\//); if (m) ORIGIN = m[1] })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !/→ http:\/\/localhost:\d+\//.test(log)) await wait(100)
  while (Date.now() - t0 < 60_000) { if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break; await wait(200) }
  browser = await Browser.launch()
}, 120_000)

afterAll(async () => {
  browser?.close()
  if (server && server.exitCode === null) {
    const gone = new Promise((r) => server!.once('exit', r))
    try { server.kill('SIGTERM') } catch { /* gone */ }
    await Promise.race([gone, wait(5000)])
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('the page recorder: board loads', () => {
  it('a content frame that reports its height late moves first, and the frames below it follow by reflow - nine in ten moves named', async () => {
    if (!browser) return
    const { s, page } = await open('#/b/late')
    expect(await browser.eval(s, 'document.visibilityState')).toBe('visible')
    const l = await ended(page, 'late')
    expect(l.load).toMatchObject({ cause: 'boot', board: 'late' })
    expect(l.of('commit')[0]).toMatchObject({ request: l.load.request, frames: 2, byKind: { content: 2, hifi: 0, html: 0 }, measuring: 2, savedHeights: 0 })
    expect(l.of('settled')).toHaveLength(1)
    const moves = l.of('move')
    const tall = moves.find((m) => m.node === 'k-a' && m.cause === 'measure-height')
    expect(tall, JSON.stringify(moves)).toBeTruthy()
    expect(moves.some((m) => m.node === 'k-b' && m.cause === 'reflow:measured' && m.seq > tall!.seq), JSON.stringify(moves)).toBe(true)
    expect(moves.filter((m) => m.cause !== 'unknown').length / moves.length).toBeGreaterThanOrEqual(0.9)
    expect(l.of('settled')[0].causes['reflow:measured']).toBeGreaterThan(0)
    // the last move, from the page: no sooner than quiet's (the first second it held still), a second before settled
    const { lastMove, ms } = l.of('settled')[0]
    expect(lastMove).toBeGreaterThanOrEqual(l.of('quiet')[0].ms)
    expect(lastMove).toBeLessThanOrEqual(ms - 1000)
    for (const k of ['k-a', 'k-b']) expect(l.frame(k)).toMatchObject({ outcome: 'settled', frame: k === 'k-a' ? 'docs/a' : 'docs/b' })
    expect(l.of('visible')[0].nodes).toBeGreaterThan(0)
  }, 90_000)

  it('a board whose every height is known records no move: quiet, then settled', async () => {
    if (!browser) return
    await open('#/b/still')   // its Doc's height is committed (if no load did it before)
    await until(() => { try { return JSON.parse(readFileSync(join(root, 'design/boards/_sizes.json'), 'utf8')).heights['docs/b@760'] } catch { return undefined } }, 20_000, 'docs/b@760 committed')
    const { page } = await open('#/b/still')
    const l = await ended(page, 'still')
    expect(l.of('move'), JSON.stringify(l.of('move'))).toEqual([])
    expect(l.of('quiet')).toHaveLength(1)
    expect(l.of('settled')[0]).toMatchObject({ moves: 0, missing: 0, neverReady: 0, errors: 0 })
    expect(l.of('settled')[0].lastMove).toBeUndefined()   // nothing moved: no last move (the commit is none)
    expect(l.of('commit')[0]).toMatchObject({ measuring: 1, savedHeights: 1 })
    expect(l.frame('k-sb')!.outcome).toBe('settled')
    expect(l.frame('k-sh')!.outcome).toBe('ready')
    expect(l.of('settled')[0].weight).toMatchObject({ iframes: 2 })
  }, 90_000)

  it('the board read from disk again keeps its documents: their outcomes carry over, and what moved on disk is no move', async () => {
    if (!browser) return
    const { s, page } = await open('#/b/still')
    const first = await ended(page, 'still')
    // an agent moves a frame in the file: the clean canvas reads the board again (sh:board)
    board('still', [{ key: 'k-sb', frame: 'docs/b', x: 0, y: 0 }, { key: 'k-sh', frame: 'kit/hifi', x: 3500, y: 0 }])
    const l = await until(() => { const x = loadOf(page, 'still'); return x && x.load.cause === 'disk-reload' && x.of('settled').length ? x : null }, 20_000, 'the reload to settle')
    expect(await browser.eval(s, `window.__mvStore.getState().nodes.find((n) => n.key === 'k-sh').x`)).toBe(3500)
    expect(l.of('move'), JSON.stringify(l.recs)).toEqual([])
    expect(lines().filter((r) => r.load === first.load.request && r.kind === 'move' && r.node === 'k-sh'), 'the load that was up saw no move either').toEqual([])
    for (const k of ['k-sb', 'k-sh']) expect(l.frame(k), k).toMatchObject({ kept: true })
    expect(l.frame('k-sb')!.outcome).toBe('settled')
    expect(l.frame('k-sh')!.outcome).toBe('ready')
    expect(l.of('visible')[0]).toMatchObject({ assumed: true })   // no fit: the camera as it was
  }, 60_000)

  it('a frame that measures provisionally for 3 s keeps the load from settling until its settled report', async () => {
    if (!browser) return
    const { page, held } = await open('#/b/slow', ['*slow.png*'])
    await until(() => held.paused('*slow.png*') > 0, 20_000, 'the image to be asked for')
    const since = Date.now()
    await wait(3000)
    expect(loadOf(page, 'slow')?.of('settled') ?? []).toEqual([])
    await held.release('*slow.png*')
    const l = await ended(page, 'slow')
    expect(l.of('settled')[0].ms).toBeGreaterThanOrEqual(3000)
    expect(l.frame('k-slow')).toMatchObject({ outcome: 'settled' })
    expect(l.frame('k-slow')!.settled).toBeGreaterThanOrEqual(3000)
    expect(l.frame('k-slow')!.firstMeasure).toBeLessThan(l.frame('k-slow')!.settled)   // the provisional one came first
    expect(Date.now() - since).toBeGreaterThanOrEqual(3000)
    held.stop()
  }, 90_000)

  it('a settled report that changes the node\'s width needs a second report', async () => {
    if (!browser) return
    const { page } = await open('#/b/wide')
    const l = await ended(page, 'wide')
    expect(l.of('move').some((m) => m.node === 'k-w' && m.cause === 'measure-width' && m.dw > 0), JSON.stringify(l.of('move'))).toBe(true)
    const f = l.frame('k-w')!
    expect(f.outcome).toBe('settled')
    expect(f.firstMeasure).toBeLessThan(f.settled)
  }, 90_000)

  it('a hi-fi frame is done at its ready', async () => {
    if (!browser) return
    const { page } = await open('#/b/hifi')
    const l = await ended(page, 'hifi')
    const f = l.frame('k-h')!
    expect(f).toMatchObject({ outcome: 'ready', frame: 'kit/hifi' })
    expect(f.settled).toBeUndefined()
    expect(f.ready).toBeGreaterThan(0)
    expect(f.boot).toMatch(/^[0-9a-f]{12}$/)
    expect(l.of('commit')[0].byKind).toEqual({ hifi: 1, content: 0, html: 0 })
  }, 90_000)

  it('a frame not in the manifest is missing, and the load settles saying so', async () => {
    if (!browser) return
    const t0 = Date.now()
    const { page } = await open('#/b/missing')
    const l = await ended(page, 'missing', 15_000)
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(l.frame('k-m')!.outcome).toBe('missing')
    expect(l.of('settled')[0]).toMatchObject({ missing: 1 })
  }, 60_000)

  it('a switch mid-load: the load is cut, the old board\'s moves stay with it, the new board commits as its own', async () => {
    if (!browser) return
    const { s, page, held } = await open('#/b/switch-a', ['*slow.png*', '*/api/boards/switch-b*'])
    await browser.until(s, `(() => { const o = window.__mvRecorder.state().owner; return o && o.board === 'switch-a' && o.committed })()`, 20_000)
    const A = (await R(s)).owner.id
    await browser.eval(s, `(() => { const st = window.__mvStore.getState(); void st.switchBoard('switch-b'); st.moveNode('k-sa', 500, 500); return 1 })()`)
    await until(() => held.paused('*/api/boards/switch-b*') > 0, 20_000, 'the switch to ask for its board')
    await held.release('*/api/boards/switch-b*')
    const b = await ended(page, 'switch-b')
    const a = lines().filter((r) => r.page === page && r.load === A)
    expect(a.find((r) => r.kind === 'cut'), JSON.stringify(a)).toMatchObject({ reason: 'switch', lastMove: expect.any(Number) })
    expect(a.find((r) => r.kind === 'move' && r.node === 'k-sa' && r.cause === 'drag')).toMatchObject({ dx: 500, dy: 500 })
    expect(a.filter((r) => r.kind === 'frame' && r.node === 'k-sa').at(-1)).toMatchObject({ outcome: 'cut' })
    expect(b.load.request).not.toBe(A)
    expect(b.of('commit')[0].request).toBe(b.load.request)
    expect(b.load).toMatchObject({ cause: 'switch' })
    held.stop()
  }, 90_000)

  it('a switch that never commits leaves the mounted load as it read the sizes: its Doc settles by its measure, never at ready', async () => {
    if (!browser) return
    const { s, page, held } = await open('#/b/slow', ['*slow.png*'])
    await until(() => held.paused('*slow.png*') > 0, 20_000, 'the image to be asked for')
    await browser.until(s, `__mvStore.getState().nodes.find((n) => n.key === 'k-slow')?.status === 'ready'`, 20_000)
    expect((await R(s)).nodes['k-slow']).toBeNull()
    // the switch's own read of the sizes says the frame measures no more (its source stopped rendering a Doc), and its
    // board never arrives: the request is cut, the slow board stays mounted
    const off = browser.on((m) => {
      if (m.method !== 'Fetch.requestPaused' || m.sessionId !== s) return
      const { requestId, request } = m.params
      const sizes = /\/api\/sizes/.test(request.url)
      if (!sizes && !/\/api\/boards\/still/.test(request.url)) return
      const body = sizes ? { heights: {}, measuring: [] } : { error: 'not today' }
      void browser!.send('Fetch.fulfillRequest', { requestId, responseCode: sizes ? 200 : 500, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') }, s).catch(() => {})
    })
    await browser.send('Fetch.enable', { patterns: ['*slow.png*', '*/api/sizes*', '*/api/boards/still*'].map((urlPattern) => ({ urlPattern, requestStage: 'Request' })) }, s)
    await browser.eval(s, `window.__mvStore.getState().switchBoard('still').then(() => 1)`)
    expect(await browser.eval(s, `window.__mvStore.getState().board`)).toBe('slow')
    await wait(2500)
    expect((await R(s)).nodes['k-slow']).toBeNull()
    expect((await R(s)).owner).toMatchObject({ board: 'slow', done: null })
    // its image lands: it settles, by its measure
    await held.release('*slow.png*')
    const l = await ended(page, 'slow')
    expect(l.of('settled')).toHaveLength(1)
    expect(l.frame('k-slow')).toMatchObject({ outcome: 'settled' })
    expect(lines().find((r) => r.page === page && r.kind === 'cut' && r.reason === 'error')).toBeTruthy()
    off(); held.stop()
  }, 90_000)

  it('a board fetch that never answers is cut at the deadline, counted from the request; if it answers after all, the board owns its geometry with no commit', async () => {
    if (!browser) return
    const { s, page, held } = await open('#/b/hifi', ['*/api/boards/hifi*'], [FAST_DEADLINE])
    const req = await until(() => lines().find((r) => r.page === page && r.kind === 'load' && r.board === 'hifi'), 20_000, 'the request')
    const cut = await until(() => lines().find((r) => r.page === page && r.kind === 'cut' && r.request === req.request), 15_000, 'the request\'s cut')
    expect(cut).toMatchObject({ reason: 'timeout', load: req.request })
    expect(cut.ms).toBeGreaterThanOrEqual(1400)
    expect((await R(s)).pending).toEqual([])
    // the fetch answers at last: the board mounts, owned by that request - late, with no commit
    await held.release('*/api/boards/hifi*')
    await browser.until(s, `(() => { const o = window.__mvRecorder.state().owner; return o && o.board === 'hifi' && o.done === 'cut' })()`, 20_000)
    expect((await R(s)).owner.id).toBe(req.request)
    // the board it mounts stays open: a move now is the cut load's, late - after the load ended
    await browser.eval(s, `window.__mvStore.getState().moveNode('k-h', 120, 80), 1`)
    await drained(s)
    expect(lines().filter((r) => r.page === page && r.kind === 'commit')).toEqual([])
    expect(lines().filter((r) => r.page === page && r.kind === 'move')).toMatchObject([{ load: req.request, node: 'k-h', cause: 'drag', late: true }])
    held.stop()
  }, 60_000)

  it('a request that waits is cut the moment it is superseded, the page hides or goes - never left open', async () => {
    if (!browser) return
    const waiting = async () => {
      const t = await open('#/b/still')
      await ended(t.page, 'still')
      await t.held.add('*/api/boards/switch-b*')
      await browser!.eval(t.s, `void window.__mvStore.getState().switchBoard('switch-b'), 1`)
      await until(() => t.held.paused('*/api/boards/switch-b*') > 0, 20_000, 'the switch to ask for its board')
      const req = await until(() => lines().find((r) => r.page === t.page && r.kind === 'load' && r.board === 'switch-b'), 10_000, 'the request')
      const cutOf = () => lines().find((r) => r.page === t.page && r.kind === 'cut' && r.request === req.request)
      return { ...t, req, cutOf }
    }
    // superseded: another switch - while the first one's board is still on its way
    const a = await waiting()
    await browser.eval(a.s, `void window.__mvStore.getState().switchBoard('hifi'), 1`)
    expect(await until(a.cutOf, 10_000, 'the superseded cut')).toMatchObject({ reason: 'superseded' })
    expect(a.held.paused('*/api/boards/switch-b*')).toBe(1)
    await ended(a.page, 'hifi')
    a.held.stop()
    // hidden: the request is cut; its board arriving later mounts with no commit
    const b = await waiting()
    await browser.eval(b.s, `Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }), document.dispatchEvent(new Event('visibilitychange')), 1`)
    expect(await until(b.cutOf, 10_000, 'the hidden cut')).toMatchObject({ reason: 'hidden' })
    await b.held.release('*/api/boards/switch-b*')
    await browser.until(b.s, `window.__mvStore.getState().board === 'switch-b' && window.__mvRecorder.state().owner?.id === ${JSON.stringify(b.req.request)}`, 20_000)
    await drained(b.s)
    expect(lines().filter((r) => r.page === b.page && r.kind === 'commit' && r.request === b.req.request)).toEqual([])
    b.held.stop()
    // the page goes: its last send carries the cut
    const c = await waiting()
    await drained(c.s)
    await browser.go(c.s, 'about:blank')
    expect(await until(c.cutOf, 10_000, 'the cut on the way out')).toMatchObject({ reason: 'hidden' })
    c.held.stop()
  }, 120_000)

  it('a frame reloaded mid-load reports the new document\'s generation', async () => {
    if (!browser) return
    const { s, page, held } = await open('#/b/slow', ['*slow.png*'])
    await until(() => held.paused('*slow.png*') > 0, 20_000, 'the image to be asked for')
    const first = await genOf(s, 'k-slow')
    await browser.eval(s, `window.__mvStore.getState().reloadFrame('k-slow'), 1`)
    await browser.until(s, `document.querySelector('[data-node="k-slow"] iframe').src.match(/[?&]r=(\\d+)/)[1] !== ${JSON.stringify(first)}`)
    const next = await genOf(s, 'k-slow')
    await wait(500)
    await held.release('*slow.png*')
    const l = await ended(page, 'slow')
    expect(l.frame('k-slow')).toMatchObject({ outcome: 'settled', gen: next })
    expect(next).not.toBe(first)
    held.stop()
  }, 90_000)

  it('a reload that has begun sends its node back to pending while the document it replaces is still there', async () => {
    if (!browser) return
    const { s, page, held } = await open('#/b/pair', ['*kit/hang.tsx*'])   // the other frame keeps the load open
    await browser.until(s, `window.__mvRecorder.state().nodes['k-ph'] === 'ready'`, 20_000)
    const old = await inFrame(s, 'k-ph', 'window.__mvBoot')
    const first = await genOf(s, 'k-ph')
    await held.add('*/frame/?id=kit%2Fhifi*')   // the new document waits until released
    await browser.eval(s, `window.__mvStore.getState().reloadFrame('k-ph'), 1`)
    expect((await R(s)).nodes['k-ph']).toBeNull()
    await until(() => held.paused('*/frame/?id=kit%2Fhifi*') > 0, 10_000, 'the reload to ask for its document')
    const next = await genOf(s, 'k-ph')
    expect(next).not.toBe(first)
    expect(await inFrame(s, 'k-ph', 'window.__mvBoot')).toBe(old)   // still there, and what it said no longer counts
    expect((await R(s)).nodes['k-ph']).toBeNull()
    await held.release('*kit/hang.tsx*')
    await browser.until(s, `window.__mvRecorder.state().nodes['k-pg'] === 'ready'`, 20_000)
    await wait(2000)
    expect((await R(s)).owner.done).toBeNull()
    expect((await R(s)).nodes['k-ph']).toBeNull()
    await held.release('*/frame/?id=kit%2Fhifi*')
    const l = await ended(page, 'pair')
    expect(l.of('settled')).toHaveLength(1)
    expect(l.frame('k-ph')).toMatchObject({ outcome: 'ready', gen: next })
    expect(l.frame('k-ph')!.boot).not.toBe(old)
    held.stop()
  }, 60_000)

  it('one hash navigation is one load and one board fetch - location.hash =, back, forward, a link that names a frame; a hash that selects a frame on the board shown loads nothing', async () => {
    if (!browser) return
    const { s, page } = await open('#/b/hifi')
    await ended(page, 'hifi')
    // every board this tab fetches (GET /api/boards/<name>)
    const fetched: string[] = []
    const off = browser.on((m) => {
      if (m.method !== 'Fetch.requestPaused' || m.sessionId !== s) return
      const { requestId, request } = m.params
      if (request.method === 'GET') fetched.push(new URL(request.url).pathname.replace(/^.*\/api\/boards\//, ''))
      void browser!.send('Fetch.continueRequest', { requestId }, s).catch(() => {})
    })
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/boards/*', requestStage: 'Request' }] }, s)
    const mine = (kind: string) => lines().filter((r) => r.page === page && r.kind === kind)
    // a navigation, its board's load settled, and long enough after for a second event's switch to show
    const go = async (code: string, b: string) => {
      const loads = mine('load').length, fetches = fetched.length
      await browser!.eval(s, `${code}, 1`)
      await until(() => { const l = loadOf(page, b); return l && mine('load').length > loads && l.of('settled').length ? l : null }, 30_000, `${b} to settle`)
      await wait(1000)
      await drained(s)
      return { loads: mine('load').slice(loads).map((r) => r.board), fetched: fetched.slice(fetches) }
    }
    expect(await go(`location.hash = '#/b/switch-b'`, 'switch-b')).toEqual({ loads: ['switch-b'], fetched: ['switch-b'] })
    expect(await go('history.back()', 'hifi')).toEqual({ loads: ['hifi'], fetched: ['hifi'] })
    expect(await go('history.forward()', 'switch-b')).toEqual({ loads: ['switch-b'], fetched: ['switch-b'] })
    // the frame a link names is selected once its board is up: the first event carries the whole hash
    expect(await go(`location.hash = '#/b/hifi?f=kit/hifi'`, 'hifi')).toEqual({ loads: ['hifi'], fetched: ['hifi'] })
    await browser.until(s, `JSON.stringify(window.__mvStore.getState().selection) === '["k-h"]'`, 10_000)
    expect(mine('cut').filter((r) => r.reason === 'superseded'), 'no request superseded by its own navigation').toEqual([])
    // the board shown: a frame selected, nothing loaded
    const loads = mine('load').length, fetches = fetched.length
    await browser.eval(s, `history.back(), 1`)
    await browser.until(s, `window.__mvStore.getState().board === 'switch-b'`, 20_000)
    await browser.eval(s, `location.hash = '#/b/switch-b?n=k-sw', 1`)
    await browser.until(s, `JSON.stringify(window.__mvStore.getState().selection) === '["k-sw"]'`, 10_000)
    await wait(1000)
    await drained(s)
    expect(mine('load').slice(loads).map((r) => r.board)).toEqual(['switch-b'])   // the back, only
    expect(fetched.slice(fetches)).toEqual(['switch-b'])
    off()
  }, 120_000)

  it('a board mounted while the page is hidden is cut at once - with its own frames, not those of the board it replaced', async () => {
    if (!browser) return
    const { s, page } = await open('#/b/still')
    await ended(page, 'still')
    // hidden, as a background tab is (the recorder is the shell's only listener)
    await browser.eval(s, `Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }), document.dispatchEvent(new Event('visibilitychange')), 1`)
    await browser.eval(s, `void window.__mvStore.getState().switchBoard('hifi'), 1`)
    const l = await ended(page, 'hifi')
    expect(l.of('cut')).toMatchObject([{ reason: 'hidden' }])
    expect(l.of('commit')[0]).toMatchObject({ frames: 1 })
    expect(l.of('frame').map((f) => f.node)).toEqual(['k-h'])
    expect(l.of('settled')).toEqual([])
  }, 60_000)
})

describe('the page recorder: gestures, errors, the log', () => {
  it('a layout animation at a steady 33 ms: p50 33, every interval over 17 ms, none over 33', async () => {
    if (!browser) return
    const { s, page } = await open('#/b/hifi')
    await ended(page, 'hifi')
    await gesture33(s)
    const g = await until(() => lines().find((r) => r.page === page && r.kind === 'gesture'), 10_000, 'the gesture record')
    expect(g).toMatchObject({ type: 'layout', p50: 33, max: 33, over33ms: 0 })
    expect(g.frames).toBeGreaterThanOrEqual(5)
    expect(g.over17ms).toBe(g.frames)
  }, 60_000)

  it('a throwing frame and a throwing shell are recorded', async () => {
    if (!browser) return
    const { s, page } = await open('#/b/errors')
    const l = await ended(page, 'errors')
    expect(l.of('error').find((e) => e.source === 'frame'), JSON.stringify(l.recs)).toMatchObject({ frame: 'kit/boom', message: expect.stringContaining('boom in render') })
    expect(l.frame('k-boom')!.outcome).toBe('error')
    expect(l.of('settled')[0].errors).toBe(1)
    await browser.eval(s, `setTimeout(() => { throw new Error('shell boom') }), 1`)
    const e = await until(() => lines().find((r) => r.page === page && r.kind === 'error' && r.source === 'shell'), 10_000, 'the shell error')
    expect(e.message).toContain('shell boom')
    expect(e.stack.length).toBeGreaterThan(0)
    expect(e.stack.length).toBeLessThanOrEqual(3)
  }, 60_000)

  it('past a load\'s 50 errors the rest are counted, not recorded; an error after the load ended is late', async () => {
    if (!browser) return
    const { s, page } = await open('#/b/send')
    const l = await ended(page, 'send')
    await drained(s)
    await browser.eval(s, `(() => { for (let i = 0; i < 55; i++) setTimeout(() => { throw new Error('again ' + i) }); return 1 })()`)
    const mine = () => lines().filter((r) => r.page === page && r.load === l.load.request)
    const errs = () => mine().filter((r) => r.kind === 'error' && /^again \d+$/.test(r.message))
    await until(() => errs().length >= 50 && mine().some((r) => r.kind === 'dropped' && r.reason === 'errors'), 20_000, 'the errors and the count past 50')
    await drained(s)
    expect(errs()).toHaveLength(50)
    expect(errs().every((e) => e.late === true)).toBe(true)
    expect(mine().filter((r) => r.kind === 'dropped' && r.reason === 'errors').reduce((n, r) => n + r.n, 0)).toBe(5)
  }, 60_000)

  it.skipIf(process.platform === 'win32')('the log is the owner\'s alone: page.jsonl 600, perf/ 700', () => {
    if (!browser) return
    expect(statSync(pageLog()).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(pageLog())).mode & 0o777).toBe(0o700)
  })

  it('at rest the recorder and the gesture sampler schedule no timer and no frame', async () => {
    if (!browser) return
    const { s, page } = await open('#/b/hifi')
    await ended(page, 'hifi')
    await browser.until(s, `(() => { const r = window.__mvRecorder.state(); return r.queued === 0 && !r.sending && r.owner?.done })()`, 10_000)
    await browser.eval(s, 'window.__stacks = []; window.__count = true')
    await wait(3000)
    const stacks: string[] = await browser.eval(s, 'window.__count = false, window.__stacks')
    expect(stacks.filter((t) => /client\/shell\/(recorder|perf\.ts)/.test(t))).toEqual([])
  }, 60_000)

  it('a page that goes while a capture waits to be sent sends nothing with keepalive; without one, its last records land', async () => {
    if (!browser) return
    const leave = async (seed: boolean) => {
      const { s, page, held } = await open('#/b/hifi', seed ? ['*/api/jam/capture*'] : [])
      await ended(page, 'hifi')
      if (seed) {
        const ws: string = await browser!.eval(s, 'window.__mvRecorder.ws')
        const rec = { format: 'marver.jam.capture', v: 1, id: 'cap-1790000000000-test', context: { canvas: 'x', board: 'hifi' }, view: {}, timeline: [], pictures: [] }
        await browser!.eval(s, `localStorage.setItem(${JSON.stringify(`mv-jam-sealed:${ws}`)}, ${JSON.stringify(JSON.stringify({ [rec.id]: rec }))}), 1`)
        await browser!.send('Page.reload', {}, s)
        await browser!.until(s, `window.__mvRecorder?.page && window.__mvRecorder.page !== ${JSON.stringify(page)}`, 20_000)
        await until(() => held.paused('*/api/jam/capture*') > 0, 20_000, 'the capture upload')
      }
      const p2: string = await browser!.eval(s, 'window.__mvRecorder.page')
      await ended(p2, 'hifi')
      await browser!.until(s, `(() => { const r = window.__mvRecorder.state(); return r.queued === 0 && !r.sending })()`, 10_000)
      await gesture33(s)
      await browser!.go(s, 'about:blank')
      await wait(3000)
      held.stop()
      // a send cut short by the page going may have landed too: the report counts a record once, by its seq
      return [...new Set(lines().filter((r) => r.page === p2 && r.kind === 'gesture').map((r) => r.seq))]
    }
    expect(await leave(true)).toEqual([])
    expect(await leave(false)).toHaveLength(1)
  }, 120_000)
})

describe('the page recorder: sending', () => {
  it('a send the server fails is tried twice more, 2 s apart; what never landed is counted in the next batch', async () => {
    if (!browser) return
    const { s, page } = await open('#/b/send')
    await ended(page, 'send')
    await drained(s)
    const net = await sends(s, (n) => (n < 3 ? 500 : undefined))
    await shellError(s, 'lost on the way')
    await until(() => net.posts().length >= 3, 20_000, 'three attempts')
    await drained(s)
    const [a, b, c] = net.posts()
    expect([a.status, b.status, c.status]).toEqual([500, 500, 500])
    expect(b.at - a.at).toBeGreaterThanOrEqual(1900)
    expect(c.at - b.at).toBeGreaterThanOrEqual(1900)
    expect(b.records!.map((r) => r.seq)).toEqual(a.records!.map((r) => r.seq))   // the same batch each time
    expect(c.records!.map((r) => r.seq)).toEqual(a.records!.map((r) => r.seq))
    expect(a.records!.some((r) => r.kind === 'error' && r.message === 'lost on the way')).toBe(true)
    const lost = worth(a.records!)
    await shellError(s, 'after the outage')
    const d = await until(() => lines().find((r) => r.page === page && r.kind === 'dropped' && !r.reason), 15_000, 'the dropped record')
    expect(d.n).toBe(lost)
    expect(lines().some((r) => r.page === page && r.kind === 'error' && r.message === 'after the outage')).toBe(true)
    expect(lines().some((r) => r.page === page && r.kind === 'error' && r.message === 'lost on the way')).toBe(false)
    expect(net.posts()).toHaveLength(4)
    net.stop()
  }, 60_000)

  it('a 403 primes the request cookie once and the same batch goes again; a 409 is final', async () => {
    if (!browser) return
    const { s, page } = await open('#/b/send')
    await ended(page, 'send')
    await drained(s)
    const net = await sends(s, (n) => (n === 0 ? 403 : n === 2 ? 409 : undefined))
    await shellError(s, 'primed')
    await until(() => lines().some((r) => r.page === page && r.kind === 'error' && r.message === 'primed'), 15_000, 'the primed batch')
    const [a, b] = net.posts()
    expect(a.status).toBe(403)
    expect(b.status).toBeUndefined()
    expect(b.records!.map((r) => r.seq)).toEqual(a.records!.map((r) => r.seq))
    const at = (x: object) => net.seen.indexOf(x as (typeof net.seen)[number])
    expect(net.seen.some((x) => !x.records && at(x) > at(a) && at(x) < at(b)), 'GET /api/work between the two').toBe(true)
    await shellError(s, 'refused')
    await until(() => net.posts().length >= 3, 15_000, 'the refused send')
    await wait(4500)
    expect(net.posts()).toHaveLength(3)   // never tried again
    const refused = net.posts()[2]
    expect(refused.status).toBe(409)
    await shellError(s, 'next')
    const d = await until(() => lines().find((r) => r.page === page && r.kind === 'dropped' && !r.reason), 15_000, 'the dropped record')
    expect(d.n).toBe(worth(refused.records!))
    expect(lines().some((r) => r.page === page && r.kind === 'error' && r.message === 'refused')).toBe(false)
    net.stop()
  }, 60_000)

  it('past its bound the oldest records go, and a dropped record says how many: none lost unsaid', async () => {
    if (!browser) return
    const { s, page } = await open('#/b/send')
    const l = await ended(page, 'send')
    await drained(s)
    // 2,100 moves of no known cause, at once: more than the queue holds (2,000 records or 256 KB)
    await browser.eval(s, `(() => { const st = window.__mvStore; for (let i = 0; i < 2100; i++) st.setState({ nodes: st.getState().nodes.map((n) => ({ ...n, x: n.x + 1 })) }); return 1 })()`)
    await until(() => lines().some((r) => r.page === page && r.kind === 'dropped'), 20_000, 'the dropped record')
    await drained(s)
    const mine = lines().filter((r) => r.page === page && r.load === l.load.request)
    const moved = new Set(mine.filter((r) => r.kind === 'move' && r.cause === 'unknown' && r.late).map((r) => r.seq)).size
    const dropped = mine.filter((r) => r.kind === 'dropped' && !r.reason).reduce((n, r) => n + r.n, 0)
    expect(dropped).toBeGreaterThan(0)
    expect(moved + dropped).toBe(2100)
  }, 60_000)
})

describe('the page recorder: frame identity', () => {
  it('a delayed ready or error from an old document never counts; the live document\'s does', async () => {
    if (!browser) return
    const { s, page, held } = await open('#/b/pair', ['*kit/hang.tsx*'])
    await browser.until(s, `!!document.querySelector('[data-node="k-pg"] iframe')?.contentWindow?.__mvBoot`, 20_000)
    await browser.until(s, `window.__mvRecorder.state().nodes['k-ph'] === 'ready'`, 20_000)
    const gen = await genOf(s, 'k-pg')
    const post = (type: string, boot: string) => inFrame(s, 'k-pg', `parent.postMessage({ type: '${type}', id: 'kit/hang', gen: '${gen}', boot: ${boot}, message: 'late' }, location.origin), 1`)
    // what the shell itself holds of the node: its status, and whether its admission slot is still taken
    const shell = () => browser!.eval(s, `({ status: __mvStore.getState().nodes.find((n) => n.key === 'k-pg').status, idle: window.__mvRecorder.state().admissionIdle })`)
    expect(await shell()).toEqual({ status: 'loading', idle: false })
    await post('sh:ready', `'old-doc'`)
    await wait(300)
    expect((await R(s)).nodes['k-pg']).toBeNull()
    expect(await shell()).toEqual({ status: 'loading', idle: false })
    await post('sh:error', `'old-doc'`)
    await wait(300)
    expect((await R(s)).nodes['k-pg']).toBeNull()
    expect(await shell()).toEqual({ status: 'loading', idle: false })
    await post('sh:ready', 'window.__mvBoot')
    await browser.until(s, `window.__mvRecorder.state().nodes['k-pg'] === 'ready'`, 5_000)
    expect(await shell()).toEqual({ status: 'ready', idle: true })
    // and the old document's error was never recorded
    await drained(s)
    const l = await ended(page, 'pair')
    expect(l.of('error')).toEqual([])
    held.stop()

    // a measure from an old document moves nothing and keeps nothing
    const b = await open('#/b/still')
    await browser.until(b.s, `window.__mvRecorder.state().nodes['k-sb'] === 'settled'`, 20_000)
    const box = () => browser!.eval(b.s, `(() => { const n = __mvStore.getState().nodes.find((n) => n.key === 'k-sb'); return { w: n.w, h: n.h } })()`)
    const before = await box()
    const g = await genOf(b.s, 'k-sb')
    await inFrame(b.s, 'k-sb', `parent.postMessage({ type: 'sh:measure', frame: 'docs/b', gen: '${g}', boot: 'old-doc', ownWidth: ${before.w}, measuredWidth: ${before.w}, height: 4321, settled: true }, '*'), 1`)
    await wait(2500)   // past the heights' 1.5 s write
    expect(await box()).toEqual(before)
    const sizes = await browser.eval(b.s, `fetch('/__mv/api/sizes').then((r) => r.json())`)
    expect(Object.values(sizes.heights ?? {})).not.toContain(4321)
    // the live document's same report is taken
    await inFrame(b.s, 'k-sb', `parent.postMessage({ type: 'sh:measure', frame: 'docs/b', gen: '${g}', boot: window.__mvBoot, ownWidth: ${before.w}, measuredWidth: ${before.w}, height: 4321, settled: true }, '*'), 1`)
    await browser.until(b.s, `__mvStore.getState().nodes.find((n) => n.key === 'k-sb').h === 4321`, 5_000)
  }, 60_000)

  it('a same-URL reload sends a settled node back to pending as soon as its live document changes, before its load', async () => {
    if (!browser) return
    const { s, page, held } = await open('#/b/pair', ['*kit/hang.tsx*'])
    await browser.until(s, `window.__mvRecorder.state().nodes['k-ph'] === 'ready'`, 20_000)
    await inFrame(s, 'k-ph', `window.__mvBoot = 'next-doc', 1`)   // a new document's bridge, on the same URL
    expect((await R(s)).nodes['k-ph']).toBeNull()
    await held.release('*kit/hang.tsx*')
    await browser.until(s, `window.__mvRecorder.state().nodes['k-pg'] === 'ready'`, 20_000)
    await wait(2000)
    expect((await R(s)).owner.done).toBeNull()
    expect((await R(s)).nodes['k-ph']).toBeNull()
    const gen = await genOf(s, 'k-ph')
    await inFrame(s, 'k-ph', `parent.postMessage({ type: 'sh:ready', id: 'kit/hifi', gen: '${gen}', boot: 'next-doc' }, location.origin), 1`)
    const l = await ended(page, 'pair')
    expect(l.of('settled')).toHaveLength(1)
    expect(l.frame('k-ph')).toMatchObject({ outcome: 'ready', boot: 'next-doc' })
    held.stop()
  }, 60_000)

  it('a missing frame and a never-ready one keep their outcomes, and the load settles without waiting for the cut', async () => {
    if (!browser) return
    const { page, held } = await open('#/b/never', ['*kit/hang.tsx*'])
    const l = await ended(page, 'never', 50_000)
    expect(l.of('cut')).toEqual([])
    expect(l.of('settled')[0]).toMatchObject({ neverReady: 1, missing: 1 })
    expect(l.frame('k-hang')!.outcome).toBe('never-ready')
    expect(l.frame('k-nope')!.outcome).toBe('missing')
    held.stop()
  }, 60_000)

  it('an HTML frame ready at DOMContentLoaded, before a slow image, keeps its outcome and the board settles', async () => {
    if (!browser) return
    const { s, page, held } = await open('#/b/html', ['*slow2.png*'])
    const l = await ended(page, 'html')
    expect(l.frame('k-p')!.outcome).toBe('ready')
    expect(l.of('settled')).toHaveLength(1)
    await held.release('*slow2.png*')
    await browser.until(s, `document.querySelector('[data-node="k-p"] iframe').contentDocument.querySelector('img').complete`, 10_000)
    await wait(2500)
    const after = loadOf(page, 'html')!
    expect(after.of('frame').filter((f) => f.node === 'k-p').map((f) => f.outcome)).toEqual(['ready'])
    expect(after.of('cut')).toEqual([])
    held.stop()
  }, 60_000)
})
