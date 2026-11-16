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
 *  - a node released for a generation asks again no sooner and no later than 4 s after its previous ask, so two servers
 *    answering alternating generations cost what the old 4 s retry did;
 *  - the requests of one batch go out together; the backstop sends each key once and its releases keep the cadence;
 *  - a generation heard over HTTP while a frame's ask is out makes that frame ask once more; the cadence ignores the
 *    wall clock stepping;
 *  - answers whose generation is lower than one heard before are asked about once, not in a loop.
 * Everything is read over the wire (the requests' sizes and count), so the parent commits are measured the same way.
 */

const PORT = 5700 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const ORIGIN = `http://localhost:${PORT}`
const LOOPING = 'a looping animation - the frame rests paused, uncompiled'
const MANY = 201
/** Nodes sharing a key with another (its width): 211 nodes, 201 keys. Their twins sit near the board's middle (they
 *  park early), the duplicates at its far end (they park last). */
const DUPS = 10, TWIN = 105

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let tab = ''
/** The refusal the fake server answers every ask with. */
let fakeError = LOOPING
/** The generation the fake server answers with: a number, or a function called once per request. */
let fakeGen: number | (() => number) = 9000
/** Called with each request's keys before it is answered (a test's server picks its generation by them). */
let gate: ((keys: string[]) => void) | null = null
/** A request this test's server holds unanswered while `holdWhen` says so; `answerHeld()` answers it. */
let holdWhen: ((keys: string[]) => boolean) | null = null
let held: (() => void) | null = null
const answerHeld = () => { const h = held; held = null; h?.() }
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
  writeFileSync(join(boards, 'two.json'), board('two', 1, [{ key: 'x1', w: 410 }, { key: 'y1', w: 420 }]))
  // 201 keys (each frame its width, 600 and up) on 211 nodes: 10 duplicates
  writeFileSync(join(boards, 'many.json'), board('many', 2, [...Array.from({ length: MANY }, (_, i) => ({ key: `m${i}`, w: 600 + i })), ...Array.from({ length: DUPS }, (_, j) => ({ key: `d${j}`, w: 600 + TWIN + j }))]))
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
      const keys = asks.map((a) => `${a.frame}|${a.w}`)
      posts.push({ t: Date.now(), n: asks.length, keys })
      gate?.(keys)
      const refuse = !asks.length || asks.length > 200
      const body = refuse ? { error: 'asks must list 1-200 frames' } : { gen: typeof fakeGen === 'function' ? fakeGen() : fakeGen, answers: asks.map((a) => ({ ...a, ok: false, error: fakeError, kept: true })) }
      const answer = () => void browser!.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: refuse ? 400 : 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') }, tab).catch(() => {})
      if (holdWhen?.(keys)) { holdWhen = null; held = answer } else answer()
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
const SLEEP = `window.__mvSleep`
const IDLE = `(() => { const w = ${SLEEP}.bakeWork(); return !w.scheduled && !w.running && !w.queued && !w.inflight })()`
const ALL_PARKED = `${ST}.nodes.every((n) => !!${SLEEP}.parkedOn(n.key))`
const backstopEvery = (ms: number) => ev(`(${SLEEP}.backstopEvery(${ms}), 1)`)
/** A key of the 211-node board (width 600 and up). */
const manyKey = (k: string) => Number(k.split('|')[1]) >= 600
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

  skippable('a node released for a generation asks again no sooner than 4 s and no later than 4 s after its previous ask', async () => {
    fakeGen = 9000
    await go('one', 1)
    await backstopEvery(600000)
    await until(`${ALL_PARKED} && ${IDLE}`, 30_000)
    await wait(4500)   // a long rest: the first release asks at once
    let from = posts.length
    await ev(`(${SLEEP}.pushed(9001), 1)`)
    for (let i = 0; i < 100 && posts.length === from; i++) await wait(50)
    const t1 = posts[from].t
    await until(`${ALL_PARKED}`, 10_000)
    await wait(Math.max(0, t1 + 2000 - Date.now()))
    from = posts.length
    await ev(`(${SLEEP}.pushed(9002), 1)`)   // invalidated again 2 s after its ask
    for (let i = 0; i < 200 && posts.length === from; i++) await wait(50)
    const t2 = posts[from]?.t ?? Infinity
    expect(t2 - t1, 'second ask after the first, ms').toBeGreaterThanOrEqual(3700)   // never more often than once per 4 s
    expect(t2 - t1, 'second ask after the first, ms').toBeLessThanOrEqual(4400)      // never later than 4 s after it
  })

  skippable('two servers answering alternating generations: each frame asks at most once per 4 s, over a minute', async () => {
    fakeGen = 7001
    await go('two', 2)
    await backstopEvery(600000)
    await until(`${ALL_PARKED} && ${IDLE}`, 30_000)
    // two servers behind one address: a request for x1 reaches the one at 7001, any other the one at 7002
    let req: string[] = []
    fakeGen = () => (req.includes('app/glass|410') ? 7001 : 7002)
    gate = (keys) => { req = keys }
    // y1 alone asks again (a reload: a new document) and hears 7002 - x1, parked on 7001, then asks and hears 7001,
    // which releases y1 again, and so on: each answer releases the other frame
    const from = posts.length
    await ev(`(() => { ${ST}.reloadFrame('y1'); const f = [...document.querySelectorAll('iframe.sh-live')].find((x) => x.closest('[data-node="y1"]')); f.src = f.src; return 1 })()`)
    for (let i = 0; i < 200 && posts.length === from; i++) await wait(100)
    const first = posts.length
    await wait(60_000)
    const win = posts.slice(first)
    const x = win.filter((p) => p.keys.includes('app/glass|410')).length, y = win.filter((p) => p.keys.includes('app/glass|420')).length
    // the old retry: each frame once per 4 s - 15 in a minute (16 counting both ends)
    expect(x, 'x1 asks in 60 s').toBeLessThanOrEqual(16)
    expect(y, 'y1 asks in 60 s').toBeLessThanOrEqual(16)
    expect(x + y, 'the frames do keep hearing each other').toBeGreaterThanOrEqual(16)
    gate = null
  })

  skippable('the backstop asks each key once in a look, whatever the chunk', async () => {
    fakeGen = 5000
    await go('many', MANY + DUPS)
    await until(`${ALL_PARKED} && ${IDLE}`, 120_000)
    const from = posts.length
    await backstopEvery(500)
    for (let i = 0; i < 200 && posts.slice(from).reduce((n, p) => n + p.n, 0) < MANY; i++) await wait(100)
    await backstopEvery(600000)
    const look: string[] = []
    for (const p of posts.slice(from)) { look.push(...p.keys); if (new Set(look).size >= MANY) break }
    expect(new Set(look).size).toBe(MANY)
    expect(look.length, 'keys sent in one look').toBe(MANY)
  })

  skippable('a generation releasing 211 parked frames (201 keys) asks in requests of at most 200, and every frame is answered', async () => {
    fakeGen = 5000
    await go('many', MANY + DUPS)
    await until(`${ALL_PARKED} && ${IDLE}`, 120_000)
    const from = posts.length
    // a source change: the dev server pushes another generation, and every frame asks again together
    writeFileSync(join(root, 'design', 'touch.txt'), String(Date.now()))
    for (let i = 0; i < 100 && posts.length === from; i++) await wait(100)
    await until(`${ALL_PARKED} && ${IDLE}`, 45_000).catch(() => {})
    const after = posts.slice(from)
    expect(Math.max(...after.map((p) => p.n)), 'the largest request').toBeLessThanOrEqual(200)
    expect(new Set(after.flatMap((p) => p.keys)).size, 'every key asked').toBe(MANY)
    // every waiter answered: each of the 211 frames is parked again on an answer, and nothing is left to do
    expect(await ev(`${ST}.nodes.filter((n) => !${SLEEP}.parkedOn(n.key)).map((n) => n.key)`), 'frames left unanswered').toEqual([])
    expect(await ev(IDLE)).toBe(true)
  })

  skippable('the requests of one batch go out together: the second does not wait for the first answer', async () => {
    fakeGen = 5000
    await go('many', MANY + DUPS)
    await until(`${ALL_PARKED} && ${IDLE}`, 120_000)
    await wait(4500)   // a rest longer than the re-ask floor: every frame is released at once, in one batch of 201 keys
    holdWhen = (keys) => keys.length === 200   // its first request, held unanswered
    const from = posts.length
    writeFileSync(join(root, 'design', 'touch.txt'), String(Date.now()))
    for (let i = 0; i < 200 && !held; i++) await wait(100)
    expect(held, 'the first request is out').not.toBe(null)
    let sizes: number[] = []
    try {
      for (let i = 0; i < 30 && !posts.slice(from).some((p) => p.n === 1); i++) await wait(50)
      sizes = posts.slice(from).map((p) => p.n)
    } finally { answerHeld() }   // never leave the page with an unanswered request (the next tests wait for bake-idle)
    expect(sizes, 'requests while the first is unanswered').toEqual([200, 1])
    await until(`${ALL_PARKED} && ${IDLE}`, 30_000)
  })

  skippable('a generation heard over HTTP while a frame\'s ask is out makes that frame ask once more', async () => {
    fakeGen = 1
    await go('two', 2)
    await backstopEvery(600000)
    await until(`${ALL_PARKED} && ${IDLE}`, 30_000)
    await wait(4500)
    // y1's next request reaches a server at generation 2 - once: then y1 is settled there, as a frame that got its
    // textures asks no more, and nothing else will name 2 again; every other request answers 1. x1's ask is held
    let req: string[] = [], once = true
    gate = (keys) => { req = keys }
    fakeGen = () => { if (once && req.includes('app/glass|420')) { once = false; return 2 } return 1 }
    holdWhen = (keys) => keys.includes('app/glass|410')
    const reload = (k: string) => ev(`(() => { ${ST}.reloadFrame('${k}'); const f = [...document.querySelectorAll('iframe.sh-live')].find((x) => x.closest('[data-node="${k}"]')); f.src = f.src; return 1 })()`)
    await reload('x1')
    for (let i = 0; i < 200 && !held; i++) await wait(100)
    if (!held) holdWhen = null
    expect(held, "x1's ask is out").not.toBe(null)
    await reload('y1')   // y1 asks and hears generation 2 - x1 is not parked, so nothing is released
    await until(`${SLEEP}.parkedOn('y1')?.gen === 2`, 30_000)
    const from = posts.length
    answerHeld()   // x1's answer: generation 1 - but 2 was heard since its ask went out
    for (let i = 0; i < 160 && !posts.slice(from).some((p) => p.keys.includes('app/glass|410')); i++) await wait(50)
    expect(posts.slice(from).some((p) => p.keys.includes('app/glass|410')), 'x1 asks once more').toBe(true)
    gate = null
    fakeGen = 1
    await wait(4500)
  })

  skippable('the cadence holds when the wall clock steps back a minute', async () => {
    fakeGen = 9000
    await go('one', 1)
    await backstopEvery(600000)
    await until(`${ALL_PARKED} && ${IDLE}`, 30_000)
    await wait(4500)
    let from = posts.length
    await ev(`(${SLEEP}.pushed(9101), 1)`)
    for (let i = 0; i < 100 && posts.length === from; i++) await wait(50)
    const t1 = posts[from].t
    await until(ALL_PARKED, 10_000)
    await ev(`(() => { window.__realNow = Date.now; Date.now = () => window.__realNow() - 60000; return 1 })()`)
    try {
      from = posts.length
      await ev(`(${SLEEP}.pushed(9102), 1)`)
      for (let i = 0; i < 160 && posts.length === from; i++) await wait(50)
    } finally { await ev(`(() => { Date.now = window.__realNow; return 1 })()`) }
    const t2 = posts[from]?.t ?? Infinity
    expect(t2 - t1, 'second ask after the first, ms').toBeGreaterThanOrEqual(3700)
    expect(t2 - t1, 'second ask after the first, ms').toBeLessThanOrEqual(4400)
  })

  skippable("the backstop's release keeps the cadence: the frame asks again no sooner than 4 s after its last ask", async () => {
    fakeGen = 9000
    await go('one', 1)
    await backstopEvery(600000)
    await until(`${ALL_PARKED} && ${IDLE}`, 30_000)
    await wait(4500)
    let from = posts.length
    await ev(`(${SLEEP}.pushed(9201), 1)`)
    for (let i = 0; i < 100 && posts.length === from; i++) await wait(50)
    const t1 = posts[from].t
    await until(`${ALL_PARKED} && ${IDLE}`, 10_000)
    // the server would now answer otherwise, the generation unchanged: the backstop finds it and releases the frame
    fakeError = 'the frame never stopped changing - nothing to certify against'
    from = posts.length
    await backstopEvery(300)
    for (let i = 0; i < 100 && posts.length === from; i++) await wait(20)
    await backstopEvery(600000)   // that one look only
    const tb = posts[from].t
    from = posts.length
    for (let i = 0; i < 160 && posts.length === from; i++) await wait(50)
    const tn = posts[from]?.t ?? Infinity
    fakeError = LOOPING
    expect(tb - t1, 'the backstop looked within 4 s of the ask').toBeLessThan(3000)
    expect(tn - t1, 'the frame asked again, ms after its last ask').toBeGreaterThanOrEqual(3700)
    expect(tn - t1).toBeLessThanOrEqual(4400)
  })
})
