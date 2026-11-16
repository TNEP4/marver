import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Parked bake answers at scale and under odd servers (sleep.ts), on a real dev canvas whose bake endpoint the test
 * answers itself (CDP Fetch): every ask gets the kept "looping animation" refusal under a generation the test picks,
 * and a request of more than 200 asks gets the server's own 400.
 *  - a generation releasing 201 parked frames at once asks in requests of at most 200, and every frame is answered;
 *  - two servers answering alternating generations cost no more than the old 4 s retry;
 *  - answers whose generation is lower than one heard before are asked about once, not in a loop.
 * Everything is read over the wire (the requests' sizes and count), so the parent commits are measured the same way.
 */

const PORT = 5700 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const ORIGIN = `http://localhost:${PORT}`
const LOOPING = 'a looping animation - the frame rests paused, uncompiled'
const MANY = 201

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let tab = ''
/** The generation the fake server answers with: a number, or a function called once per request. */
let fakeGen: number | (() => number) = 9000
/** Called with each request's keys before it is answered (a test's server picks its generation by them). */
let gate: ((keys: string[]) => void) | null = null
/** Every bake POST the page sent: when, how many asks, which keys. */
const posts: { t: number; n: number; keys: string[] }[] = []

const GLASS = `export const meta = { title: 'Glass' }
export default () => (
  <main>
    <style>{\`
      html, body, main { margin: 0; min-height: 100vh }
      main { position: relative; background: linear-gradient(135deg, #ff7a59, #7b61ff) }
      .g { position: absolute; left: 20px; top: 20px; width: 120px; height: 40px; border-radius: 12px; background: rgba(255,255,255,.35); backdrop-filter: blur(8px) }
    \`}</style>
    <div className="g" />
  </main>
)
`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const board = (name: string, order: number, nodes: { key: string; w: number }[]) =>
  JSON.stringify({ version: 1, name, order, auto: false, nodes: nodes.map((n, i) => ({ key: n.key, frame: 'app/glass', x: (i % 15) * 700, y: Math.floor(i / 15) * 260, w: n.w, h: 200 })) })

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-sleep-many-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sleep-many-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..')
  const repoNm = join(repoRoot, 'node_modules')
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver') symlinkSync(join(repoNm, e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  const scenes = join(root, 'design', 'scenes', 'app')
  mkdirSync(scenes, { recursive: true })
  writeFileSync(join(scenes, 'glass.tsx'), GLASS)
  const boards = join(root, 'design', 'boards')
  mkdirSync(boards, { recursive: true })
  writeFileSync(join(boards, 'one.json'), board('one', 0, [{ key: 'z1', w: 400 }]))
  writeFileSync(join(boards, 'two.json'), board('two', 1, [{ key: 'x1', w: 400 }]))
  // 201 frames, each its own sleep key (its own width)
  writeFileSync(join(boards, 'many.json'), board('many', 2, Array.from({ length: MANY }, (_, i) => ({ key: `m${i}`, w: 300 + i }))))
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000) {
    const ok = await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)
    if (ok) break
    await wait(200)
  }
  browser = await Browser.launch()
  if (browser) {
    tab = await browser.tab()
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, tab)
    browser.on((m) => {
      if (m.method !== 'Fetch.requestPaused' || m.sessionId !== tab) return
      const rq = m.params.request
      const raw = rq.postData ?? (rq.postDataEntries ?? []).map((e: { bytes?: string }) => Buffer.from(e.bytes ?? '', 'base64').toString('utf8')).join('')
      let asks: { frame: string; theme: string; w: number; h: number; doc?: string }[] = []
      try { asks = JSON.parse(raw).asks ?? [] } catch { /* none */ }
      posts.push({ t: Date.now(), n: asks.length, keys: asks.map((a) => `${a.frame}|${a.w}`) })
      gate?.(asks.map((a) => `${a.frame}|${a.w}`))
      const refuse = !asks.length || asks.length > 200
      const body = refuse ? { error: 'asks must list 1-200 frames' } : { gen: typeof fakeGen === 'function' ? fakeGen() : fakeGen, answers: asks.map((a) => ({ ...a, ok: false, error: LOOPING, kept: true })) }
      void browser!.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: refuse ? 400 : 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') }, tab).catch(() => {})
    })
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*/__mv/api/bakes*', requestStage: 'Request' }] }, tab)
  }
}, 120_000)

afterAll(() => {
  browser?.close()
  try { server?.kill('SIGTERM') } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true })
})

const skippable = (name: string, fn: () => Promise<void>, ms = 240_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)

const ST = `window.__mvStore.getState()`
const ev = (expr: string) => browser!.eval(tab, expr)
const until = (expr: string, ms = 60_000) => browser!.until(tab, expr, ms)
/** Every frame of the board asleep (its pause installed). */
const ALL_ASLEEP = (n: number) => `(() => { const f = [...document.querySelectorAll('iframe.sh-live')]; return f.length === ${n} && f.every((x) => !!x.contentDocument?.getElementById('mv-sleep')) })()`
async function go(name: string, n: number): Promise<void> {
  await browser!.go(tab, `${ORIGIN}/#/b/${name}`)
  await until(`location.hash === '#/b/${name}' && ${ST}.nodes.length === ${n} && ${ST}.nodes.every((x) => x.status === 'ready')`, 180_000)
  await until(ALL_ASLEEP(n), 120_000)
}
/** Wait until no bake POST for `quiet` ms (or `cap` passes): the page at rest, read from the wire. */
async function quiet(quietMs: number, cap: number): Promise<boolean> {
  const t0 = Date.now()
  for (;;) {
    const last = posts.at(-1)?.t ?? 0
    if (Date.now() - last >= quietMs) return true
    if (Date.now() - t0 > cap) return false
    await wait(250)
  }
}

describe('parked bake answers at scale and under odd servers', () => {
  skippable('answers below a generation heard before are asked about once - never in a loop', async () => {
    fakeGen = 9000
    await go('one', 1)
    expect(await quiet(3000, 30_000)).toBe(true)
    fakeGen = 8000   // a replacement server counting from below
    const from = posts.length
    // the frame asks again (a reload: a new document) and hears the lower generation
    await ev(`(() => { ${ST}.reloadFrame('z1'); const f = document.querySelector('iframe.sh-live'); f.src = f.src; return 1 })()`)
    await until(`${ST}.nodes[0].status === 'ready'`, 30_000)
    for (let i = 0; i < 100 && posts.length === from; i++) await wait(100)
    const first = posts.length
    expect(first).toBeGreaterThan(from)
    await wait(8000)
    expect(posts.length - first, 'asks in the 8 s after the lower answer').toBeLessThanOrEqual(2)
  })

  skippable('two servers answering alternating generations cost no more than the old 4 s retry', async () => {
    fakeGen = 7001
    writeFileSync(join(root, 'design', 'boards', 'two.json'), board('two', 1, [{ key: 'x1', w: 400 }, { key: 'y1', w: 420 }]))
    await go('two', 2)
    expect(await quiet(3000, 30_000)).toBe(true)
    // two servers behind one address: a request for x1 reaches the one at 7001, any other the one at 7002
    let req: string[] = []
    fakeGen = () => (req.includes('app/glass|400') ? 7001 : 7002)
    gate = (keys) => { req = keys }
    // y1 alone asks again (a reload: a new document) and hears 7002 - x1, parked on 7001, then asks alone and hears
    // 7001, which releases y1 again, and so on: each answer releases the other frame
    const from = posts.length
    await ev(`(() => { ${ST}.reloadFrame('y1'); const f = [...document.querySelectorAll('iframe.sh-live')].find((x) => x.closest('[data-node="y1"]')); f.src = f.src; return 1 })()`)
    for (let i = 0; i < 200 && posts.length === from; i++) await wait(100)
    const first = posts.length
    await wait(12_000)
    const n = posts.length - first
    // the old retry: each of the two frames every 4 s - 6 asks in 12 s; unbounded, one every ~290 ms
    expect(n, `asks in 12 s: ${JSON.stringify(posts.slice(first).map((p) => p.keys))}`).toBeLessThanOrEqual(10)
    expect(posts.slice(first).length, 'the loop did start (the frames do hear each other)').toBeGreaterThanOrEqual(2)
    gate = null
  })

  skippable('a generation releasing 201 parked frames asks in requests of at most 200, and every frame is answered', async () => {
    fakeGen = 5000
    await go('many', MANY)
    expect(await quiet(5000, 120_000), 'the board at rest').toBe(true)
    const from = posts.length
    // a source change: the dev server pushes another generation, and all 201 frames ask again together
    writeFileSync(join(root, 'design', 'touch.txt'), String(Date.now()))
    for (let i = 0; i < 100 && posts.length === from; i++) await wait(100)
    const settled = await quiet(6000, 45_000)
    const after = posts.slice(from)
    expect(Math.max(...after.map((p) => p.n)), 'the largest request').toBeLessThanOrEqual(200)
    expect(new Set(after.flatMap((p) => p.keys)).size, 'every frame asked').toBe(MANY)
    expect(settled, 'and then rested (each one answered)').toBe(true)
  })
})
