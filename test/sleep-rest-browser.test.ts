import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * A frame at rest costs nothing (sleep.ts), on a real dev canvas:
 *  - an SVG animation (SMIL) holds still while its frame sleeps - one left running repainted and committed the whole
 *    page every frame - whatever its author calls meanwhile, and wakes in the state the author last asked for;
 *  - a frame whose bake answer is settled (a refusal the server keeps; a compile none of whose textures certified)
 *    asks no more on a timer; it asks again when the server names another generation (a push, or any answer over HTTP
 *    when the push is lost), and when the server would answer otherwise with the generation unchanged (the backstop),
 *    and an <svg> whose methods its author owns is never broken by the hold. Batching, alternating and lower generations
 * over HTTP: sleep-many-browser.test.ts.
 * Assertions read state (what a node is parked on, the asks' payloads, the timelines' clocks), not wall-clock bounds.
 */

const PORT = 5700 + Math.floor(Math.random() * 400)
const EXT = PORT + 500   // a server outside the canvas: content the dev server does not watch
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const ORIGIN = `http://localhost:${PORT}`

let root = ''
let server: ChildProcess | null = null
let ext: Server | null = null
let look = ''
let browser: Browser | null = null
let log = ''
let tab = ''
/** Every bake POST the page sent: the frames it asked about. */
const posts: string[][] = []

const SMIL = `import { useEffect, useRef } from 'react'
export const meta = { title: 'Smil' }
export default () => {
  const held = useRef(null)
  useEffect(() => { held.current?.pauseAnimations() }, [])
  return (
    <main style={{ margin: 0, padding: 24, font: '16px system-ui' }}>
      <svg id="spin" width="200" height="200">
        <defs>
          <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="200" y2="200">
            <stop offset="0" stopColor="#f60" /><stop offset="1" stopColor="#06f" />
            <animateTransform attributeName="gradientTransform" type="rotate" from="0 100 100" to="360 100 100" dur="3s" repeatCount="indefinite" />
          </linearGradient>
        </defs>
        <rect width="200" height="200" fill="url(#g)" />
      </svg>
      <svg id="held" ref={held} width="100" height="100">
        <circle cx="50" cy="50" r="20" fill="#333"><animate attributeName="r" values="20;40;20" dur="2s" repeatCount="indefinite" /></circle>
      </svg>
    </main>
  )
}
`
// an author who owns the methods: a non-configurable own unpauseAnimations (the sleep cannot shadow it: left unheld,
// it animates on), and a configurable own pauseAnimations wrapper (shadowed while asleep, restored at wake)
const SMIL2 = `import { useEffect, useRef } from 'react'
export const meta = { title: 'Smil2' }
export default () => {
  const locked = useRef(null), wrapped = useRef(null)
  useEffect(() => {
    const unpause = SVGSVGElement.prototype.unpauseAnimations, pause = SVGSVGElement.prototype.pauseAnimations
    Object.defineProperty(locked.current, 'unpauseAnimations', { value: function () { return unpause.call(this) }, configurable: false, writable: false })
    window.__wrapper = function () { window.__wrapperCalls = (window.__wrapperCalls ?? 0) + 1; return pause.call(this) }
    Object.defineProperty(wrapped.current, 'pauseAnimations', { value: window.__wrapper, configurable: true, writable: true })
  }, [])
  return (
    <main style={{ margin: 0, padding: 24 }}>
      <svg id="locked" ref={locked} width="100" height="100"><circle cx="50" cy="50" r="20" fill="#333"><animate attributeName="r" values="20;40;20" dur="2s" repeatCount="indefinite" /></circle></svg>
      <svg id="wrapped" ref={wrapped} width="100" height="100"><circle cx="50" cy="50" r="20" fill="#933"><animate attributeName="r" values="20;40;20" dur="2s" repeatCount="indefinite" /></circle></svg>
    </main>
  )
}
`
// glass over a looping animation: the compiler refuses it at once (bake.ts LOOPING) and keeps the refusal
const LOOP = `export const meta = { title: 'Loop' }
export default () => (
  <main>
    <style>{\`
      html, body, main { margin: 0; min-height: 100vh }
      main { position: relative; background: linear-gradient(135deg, #ff7a59, #7b61ff); font: 600 18px system-ui }
      .g { position: absolute; left: 40px; top: 40px; width: 300px; padding: 18px; border-radius: 16px; background: rgba(255,255,255,.35); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px) }
      .dot { position: absolute; left: 60px; top: 200px; width: 20px; height: 20px; border-radius: 10px; background: #fff; animation: spin 1s linear infinite }
      @keyframes spin { to { transform: translateX(200px) } }
    \`}</style>
    <div className="g">Looping</div>
    <div className="dot" />
  </main>
)
`
// glass whose look comes from outside the canvas: blended at first (certification refuses it - a successful compile
// with no texture), plain once that content settles - with no source change, so no new generation
const EXTF = `export const meta = { title: 'Ext' }
export default () => (
  <main>
    <link rel="stylesheet" href="http://localhost:${EXT}/look.css" />
    <style>{\`
      html, body, main { margin: 0; min-height: 100vh }
      main { position: relative; background: linear-gradient(135deg, #19c2a0, #7b61ff); font: 600 18px system-ui }
      .g { position: absolute; left: 40px; top: 40px; width: 300px; padding: 18px; border-radius: 16px; background: rgba(255,255,255,.35); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px) }
    \`}</style>
    <div className="g">From outside</div>
  </main>
)
`
const BLENDED = `.g { mix-blend-mode: multiply; background: rgba(255,200,120,.7) }`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  look = BLENDED
  ext = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' }); res.end(look) })
  await new Promise<void>((r) => ext!.listen(EXT, r))
  root = mkdtempSync(join(tmpdir(), 'mv-sleep-rest-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sleep-rest-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..')
  const repoNm = join(repoRoot, 'node_modules')
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver') symlinkSync(join(repoNm, e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  const scenes = join(root, 'design', 'scenes', 'app')
  mkdirSync(scenes, { recursive: true })
  writeFileSync(join(scenes, 'smil.tsx'), SMIL)
  writeFileSync(join(scenes, 'smil2.tsx'), SMIL2)
  writeFileSync(join(scenes, 'loop.tsx'), LOOP)
  writeFileSync(join(scenes, 'ext.tsx'), EXTF)
  const boards = join(root, 'design', 'boards')
  mkdirSync(boards, { recursive: true })
  writeFileSync(join(boards, 'main.json'), JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
    { key: 's1', frame: 'app/smil', x: 0, y: 0, w: 500, h: 300 },
    { key: 'l1', frame: 'app/loop', x: 600, y: 0, w: 500, h: 300 },
    { key: 'e1', frame: 'app/ext', x: 0, y: 400, w: 500, h: 300 },
  ] }))
  writeFileSync(join(boards, 'owned.json'), JSON.stringify({ version: 1, name: 'owned', order: 1, auto: false, nodes: [
    { key: 's2', frame: 'app/smil2', x: 0, y: 0, w: 400, h: 200 },
  ] }))
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000) {
    const ok = await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)
    if (ok) break
    await wait(200)
  }
  browser = await Browser.launch()
  if (browser) {
    tab = await browser.tab()
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false }, tab)
    // a lost push, on demand: the shell's socket drops `sh:bake-gen` while `__mvDropBakeGen` is set (Vite's client
    // listens with addEventListener('message'))
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (window.top === window) { const add = WebSocket.prototype.addEventListener; WebSocket.prototype.addEventListener = function (t, fn, o) { if (t !== 'message') return add.call(this, t, fn, o); return add.call(this, t, function (e) { if (window.__mvDropBakeGen && typeof e.data === 'string' && e.data.includes('sh:bake-gen')) return; return fn.call(this, e) }, o) } }` }, tab)
    await browser.send('Network.enable', {}, tab)
    browser.on((m) => {
      if (m.method !== 'Network.requestWillBeSent' || m.sessionId !== tab || !String(m.params?.request?.url).includes('/__mv/api/bakes')) return
      try { posts.push(JSON.parse(m.params.request.postData).asks.map((a: { frame: string }) => a.frame)) } catch { posts.push([]) }
    })
  }
}, 120_000)

afterAll(() => {
  browser?.close()
  try { server?.kill('SIGTERM') } catch { /* gone */ }
  ext?.close()
  rmSync(root, { recursive: true, force: true })
})

const skippable = (name: string, fn: () => Promise<void>, ms = 150_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)

const DOC = (frame: string) => `document.querySelector('iframe.sh-live[title="${frame}"]')?.contentDocument`
const ASLEEP = (frame: string) => `!!${DOC(frame)}?.getElementById('mv-sleep')`
const SVG = (id: string, frame = 'app/smil') => `${DOC(frame)}.getElementById('${id}')`
/** The timeline's own state, under any shadow the sleep put on the element. */
const NATIVE_PAUSED = (id: string, frame = 'app/smil') => `${DOC(frame)}.defaultView.SVGSVGElement.prototype.animationsPaused.call(${SVG(id, frame)})`
const ST = `window.__mvStore.getState()`
const SLEEP = `window.__mvSleep`
const PARKED = (key: string) => `${SLEEP}.parkedOn('${key}')`
const IDLE = `(() => { const w = ${SLEEP}.bakeWork(); return !w.scheduled && !w.running && !w.queued && !w.inflight })()`
const ev = (expr: string) => browser!.eval(tab, expr)
const until = (expr: string, ms = 60_000) => browser!.until(tab, expr, ms)
async function onBoard(): Promise<void> {
  if (await ev(`location.hash === '#/b/main' && !!window.__mvStore`)) return
  await browser!.go(tab, `${ORIGIN}/#/b/main`)
  await until(`${ST}.nodes.length === 3 && ${ST}.nodes.every((n) => n.status === 'ready')`)
}
async function onOwned(): Promise<void> {
  await browser!.go(tab, `${ORIGIN}/#/b/owned`)
  await until(`location.hash === '#/b/owned' && ${ST}.nodes.length === 1 && ${ST}.nodes.every((n) => n.status === 'ready')`)
}
/** A timeline's clock, read twice `ms` apart: did it move? */
const moves = async (id: string, ms = 400, frame = 'app/smil') => { const a = await ev(`${SVG(id, frame)}.getCurrentTime()`); await wait(ms); return (await ev(`${SVG(id, frame)}.getCurrentTime()`)) > a }
/** The server's generation now, from an ask of our own (it changes nothing in the page). */
const serverGen = async (): Promise<number> => (await ev(`fetch('/__mv/api/bakes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': document.cookie.match(/(?:^|; )mv_c=([^;]+)/)?.[1] ?? '' }, body: JSON.stringify({ asks: [{ frame: 'app/loop', theme: 'light', w: 500, h: 300 }] }) }).then((r) => r.json()).then((j) => j.gen)`)) as number
/** The page's bake POSTs since `from` that asked about `frame`. */
const asksFor = (frame: string, from: number) => posts.slice(from).filter((p) => p.includes(frame)).length
const hooked = () => ev(`!!window.__mvSleep`) as Promise<boolean>
/** Wait in the test (not the page) until `ok()`. */
async function poll(ok: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  while (!(await ok())) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await wait(200) }
}
/** A frame parked on a settled answer, the page bake-idle: what it is parked on. A build without the dev hook (the
 *  parent, for the proof) is read from outside: the frame asleep, its answer asked for, the page left a while. */
async function parkedRest(key: string, sig: string, frame: string): Promise<{ gen: number; sig: string }> {
  if (await hooked()) {
    await until(`${PARKED(key)}?.sig?.startsWith(${JSON.stringify(sig)}) && ${IDLE}`, 90_000)
    return ev(PARKED(key))
  }
  await until(ASLEEP(frame), 90_000)
  await poll(() => asksFor(frame, 0) > 0, 90_000, `an ask for ${frame}`)
  await wait(5000)
  return { gen: await serverGen(), sig }
}
const backstopEvery = (ms: number) => ev(`(window.__mvSleep?.backstopEvery(${ms}), 1)`)

describe('a frame at rest costs nothing', () => {
  skippable('an SVG animation holds still asleep whatever its author calls, and wakes in the state the author last asked for', async () => {
    await onBoard()
    await until(ASLEEP('app/smil'))
    expect(await ev(NATIVE_PAUSED('spin')), 'the rotating gradient is held').toBe(true)
    expect(await ev(`${SVG('spin')}.animationsPaused()`), 'its author still sees it running').toBe(false)
    expect(await moves('spin')).toBe(false)
    expect(await ev(`${SVG('held')}.animationsPaused()`), 'the one its author paused reads paused').toBe(true)
    // nothing in the page lays out at rest: the held gradient invalidates no style, no layout - counted once the
    // whole board rests (both settled frames parked, the page bake-idle)
    await parkedRest('l1', 'kept:a looping animation', 'app/loop')
    await parkedRest('e1', 'ok:0', 'app/ext')
    await until(ASLEEP('app/smil'))
    await browser!.send('Performance.enable', {}, tab)
    const layouts = async () => (await browser!.send('Performance.getMetrics', {}, tab)).metrics.find((m: { name: string }) => m.name === 'LayoutCount').value
    const l0 = await layouts(); await wait(1000)
    expect(await layouts() - l0, 'layouts in a second at rest').toBeLessThan(5)
    // the author speaks while it sleeps: pause the running one, unpause the paused one - neither moves yet
    await ev(`${SVG('spin')}.pauseAnimations()`)
    await ev(`${SVG('held')}.unpauseAnimations()`)
    expect(await ev(`${SVG('spin')}.animationsPaused()`)).toBe(true)
    expect(await ev(`${SVG('held')}.animationsPaused()`)).toBe(false)
    expect(await ev(NATIVE_PAUSED('held')), 'unpaused by its author, still held asleep').toBe(true)
    expect(await moves('held')).toBe(false)
    const at = await ev(`({ spin: ${SVG('spin')}.getCurrentTime(), held: ${SVG('held')}.getCurrentTime() })`)
    // wake, and read the clocks the moment the sleep is gone - in the page, so no round trip is counted
    const r = await ev(`(async () => { const t0 = performance.now(); ${ST}.setInteract('s1'); while (${DOC('app/smil')}.getElementById('mv-sleep')) await new Promise((r) => requestAnimationFrame(r)); return { waited: (performance.now() - t0) / 1000, spin: ${SVG('spin')}.getCurrentTime(), held: ${SVG('held')}.getCurrentTime() } })()`)
    // the author's word holds: the one paused during the sleep stays paused, exactly where it stood
    expect(await ev(NATIVE_PAUSED('spin'))).toBe(true)
    expect(r.spin).toBe(at.spin)
    expect(await moves('spin')).toBe(false)
    // the one unpaused during the sleep runs - from where it stood, not ahead by the time it slept
    expect(await ev(NATIVE_PAUSED('held'))).toBe(false)
    expect(r.held - at.held).toBeLessThanOrEqual(r.waited + 0.05)
    expect(await moves('held')).toBe(true)
    // and nothing of the sleep is left on the elements
    expect(await ev(`['spin', 'held'].some((id) => ['pauseAnimations', 'unpauseAnimations', 'animationsPaused'].some((k) => Object.prototype.hasOwnProperty.call(${DOC('app/smil')}.getElementById(id), k)))`)).toBe(false)
    await ev(`${ST}.setInteract(null)`)
  })

  skippable('a refused frame asks no more on a timer, and asks again when the generation changes - the same document', async () => {
    await onBoard()
    await backstopEvery(600000)
    const p0 = await parkedRest('l1', 'kept:a looping animation', 'app/loop')
    expect(p0.gen).toBe(await serverGen())
    const from = posts.length
    await wait(6000)   // a window of the old retries (every 4 s): nothing asks
    expect(asksFor('app/loop', from), 'no ask on a timer at rest').toBe(0)
    await ev(`(() => { const d = ${DOC('app/loop')}; d.defaultView.__same = 1; return 1 })()`)
    writeFileSync(join(root, 'design', 'touch.txt'), String(Date.now()))   // watched, imported by nothing
    await until(`(${PARKED('l1')}?.gen ?? ${p0.gen}) !== ${p0.gen} && ${IDLE}`, 30_000)
    expect((await ev(PARKED('l1'))).gen).toBe(await serverGen())
    expect(await ev(`${DOC('app/loop')}.defaultView.__same`), 'never reloaded').toBe(1)
  })

  skippable('a lost push: the backstop asks over HTTP, learns the other generation, and the frame asks again', async () => {
    await onBoard()
    await backstopEvery(600000)
    const p0 = await parkedRest('l1', 'kept:a looping animation', 'app/loop')
    await ev(`(window.__mvDropBakeGen = true, 1)`)
    writeFileSync(join(root, 'design', 'touch.txt'), String(Date.now()))
    let g = p0.gen
    for (let i = 0; i < 100 && g === p0.gen; i++) { g = await serverGen(); if (g === p0.gen) await wait(100) }
    expect(g, 'the server moved on').not.toBe(p0.gen)
    await wait(1500)   // the push went by, unheard
    if (await hooked()) expect((await ev(PARKED('l1')))?.gen, 'the push was lost').toBe(p0.gen)
    const from = posts.length
    await backstopEvery(500)
    // the frame learns of the new generation over HTTP and asks again (the parent never does: parked for good)
    await poll(() => asksFor('app/loop', from) >= 2, 30_000, 'the backstop look and the frame asking again')   // the backstop's look, then the frame's own ask
    await until(`${PARKED('l1')}?.gen === ${g} && ${IDLE}`, 30_000)
    await ev(`(window.__mvDropBakeGen = false, 1)`)
    await backstopEvery(600000)
  })

  skippable('the server answers otherwise with the generation unchanged (its retained answer gone): the backstop finds it and the frame gets its textures', async () => {
    await onBoard()
    await backstopEvery(600000)
    const p0 = await parkedRest('e1', 'ok:0', 'app/ext')
    expect(await ev(`${DOC('app/ext')}.querySelectorAll('[data-mv-sleep]').length`)).toBe(0)
    // the outside content settles, and the server's retained answer goes (design/.local is not a source: no generation)
    look = '/* settled */'
    rmSync(join(root, 'design', '.local', 'bakes'), { recursive: true, force: true })
    await backstopEvery(500)
    await until(`${DOC('app/ext')}.querySelectorAll('[data-mv-sleep]').length === 1`, 90_000)
    expect(await serverGen(), 'no new generation').toBe(p0.gen)
    if (await hooked()) expect(await ev(PARKED('e1'))).toBe(null)
    await backstopEvery(600000)
  })

  skippable('an <svg> whose methods its author owns: a non-configurable one is left unheld (it animates, the sleep still installs); a configurable own property is restored at wake', async () => {
    await onOwned()
    await until(ASLEEP('app/smil2'))
    expect(await ev(NATIVE_PAUSED('locked', 'app/smil2')), 'left unheld').toBe(false)
    expect(await moves('locked', 400, 'app/smil2'), 'it animates on').toBe(true)
    expect(await ev(`Object.getOwnPropertyDescriptor(${SVG('locked', 'app/smil2')}, 'unpauseAnimations').configurable`)).toBe(false)
    expect(await ev(NATIVE_PAUSED('wrapped', 'app/smil2')), 'the other one is held').toBe(true)
    await ev(`${SVG('wrapped', 'app/smil2')}.pauseAnimations()`)   // asleep: recorded, the author's wrapper not run
    expect(await ev(`${DOC('app/smil2')}.defaultView.__wrapperCalls ?? 0`)).toBe(0)
    await ev(`${SVG('wrapped', 'app/smil2')}.unpauseAnimations()`)
    await ev(`(async () => { ${ST}.setInteract('s2'); while (${DOC('app/smil2')}.getElementById('mv-sleep')) await new Promise((r) => requestAnimationFrame(r)); return 1 })()`)
    expect(await ev(`Object.getOwnPropertyDescriptor(${SVG('wrapped', 'app/smil2')}, 'pauseAnimations').value === ${DOC('app/smil2')}.defaultView.__wrapper`), 'the author\'s own property is back').toBe(true)
    expect(await ev(NATIVE_PAUSED('wrapped', 'app/smil2')), 'its last word was "running"').toBe(false)
    expect(await moves('wrapped', 400, 'app/smil2')).toBe(true)
    expect(await moves('locked', 400, 'app/smil2')).toBe(true)
    await ev(`${ST}.setInteract(null)`)
    await browser!.go(tab, `${ORIGIN}/#/b/main`)
    await until(`location.hash === '#/b/main' && ${ST}.nodes.length === 3 && ${ST}.nodes.every((n) => n.status === 'ready')`)
  })

  skippable('its own document changes: it wakes, sleeps again under the new revision, and asks', async () => {
    await onBoard()
    const p0 = await parkedRest('l1', 'kept:a looping animation', 'app/loop')
    const from = posts.length
    writeFileSync(join(root, 'design', 'scenes', 'app', 'loop.tsx'), LOOP.replace('>Looping<', '>Looping, edited<'))
    await until(`${DOC('app/loop')}?.body?.textContent.includes('Looping, edited')`, 30_000)
    await poll(() => asksFor('app/loop', from) >= 1, 60_000, 'an ask under the new revision')
    if (await hooked()) await until(`${PARKED('l1')}?.sig?.startsWith('kept:') && ${PARKED('l1')}.gen !== ${p0.gen} && ${IDLE}`, 90_000)
    else await until(ASLEEP('app/loop'), 60_000)
    expect(await ev(ASLEEP('app/loop'))).toBe(true)
  })
})
