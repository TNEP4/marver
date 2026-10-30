import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Live pictures in the shell (spec 28 A4.6 #33-#36, #52, r1 #5): a REAL dev server with jam on and a REAL browser whose
 * page carries a fake `window.marverApp` with `capture` - it answers the ask with a PNG of the rect's size, or refuses,
 * throws or holds as a case says. In play on a device preset, I takes one picture: the app's, uploaded raw and stored
 * with `source: 'live'`, and no render asked for. Every other shot - fill and doc presets, a stage under the scroll edge
 * or the Jam ring, an overlay on it (the live caption and a tip, which take no pointer, found by their boxes), the first
 * second on a frame - takes the server's render; so does every failure of
 * the live path within its one shot, which the seal waits for. A reload, A -> B -> A, a resize or an overlay during the
 * ask drops its bytes. Without `marverApp` the record is 0.28's. The app's own half (the readback) is the app's suite.
 * Skips without Chrome.
 */

const PORT = 7400 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
let ORIGIN = `http://localhost:${PORT}`

let root = ''
let bin = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let s = ''
let log = ''

const put = (rel: string, body: string | object) => {
  const f = join(root, rel)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}
const frame = (name: string, meta = '') => `${meta}export default () => <main style={{ padding: 40 }}><h1>${name}</h1></main>\n`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = (expr: string, ms = 20_000) => browser!.until(s, expr, ms)
const ev = (expr: string) => browser!.eval(s, expr)

/** No agent runs here: every capture is stopped to review (⇧E) and dropped. */
const FAKE_CLAUDE = `#!/usr/bin/env node
process.exit(1)
`

/** The Mac app, as far as the shell can see it: the six 0.1 methods and A4's `capture`, in the top document only. The
 *  tab's sessionStorage chooses: `mvtest-noapp` installs nothing, `mvtest-inset` takes the 44 px inset (with the
 *  presentation methods it needs). `__live.mode` is how the next capture answers; `__live.gate` holds it. */
const FAKE_APP = `(() => {
  if (window.top !== window) return
  let noapp = false, inset = false
  try { noapp = sessionStorage.getItem('mvtest-noapp') === '1'; inset = sessionStorage.getItem('mvtest-inset') === '1' } catch {}
  window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message)))
  if (noapp) return
  const L = window.__live = { mode: 'ok', calls: [], answered: 0, gate: null }
  const png = async (w, h) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h
    const g = c.getContext('2d'); g.fillStyle = '#d33'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.fillRect(4, 4, Math.max(1, w / 3), Math.max(1, h / 5))
    const b = await new Promise((r) => c.toBlob(r, 'image/png'))
    return new Uint8Array(await b.arrayBuffer())
  }
  const no = () => () => {}
  window.marverApp = {
    v: 1, topInset: inset ? 44 : 0, reopen: false,
    hello() {}, theme() {}, busy() {}, menu() {}, onAppState: no, onMenuClick: no,
    ...(inset ? { onPresent: no, presented() {} } : {}),
    async capture(a) {
      L.calls.push({ ...a.rect })
      if (L.gate) await L.gate
      L.answered++
      if (L.mode === 'refuse') return { ok: false, why: 'hidden' }
      if (L.mode === 'throw') throw new Error('the app threw')
      const w = Math.ceil(a.rect.width), h = Math.ceil(a.rect.height)
      const bytes = await png(w, h)
      L.last = Array.from(bytes.slice(0, 64))
      L.lastLength = bytes.length
      return { ok: true, png: bytes, width: w, height: h }
    },
  }
})()`

/** The page's fetch, watched: the renders and the live uploads it posts; a live upload made to fail, or held. */
const WATCH = `(() => {
  if (!window.__baseFetch) window.__baseFetch = window.fetch
  const base = window.__baseFetch
  const W = window.__net = { renders: 0, uploads: 0, liveFail: 0, liveDelay: 0, liveHold: null }
  if (window.__live) Object.assign(window.__live, { calls: [], answered: 0, mode: 'ok', gate: null })
  window.fetch = (u, o) => {
    const url = String(u)
    if (o && o.method === 'POST' && url.includes('/api/jam/picture/live')) {
      W.uploads++
      if (W.liveFail) return Promise.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: W.liveFail }))
      const go = () => base(u, o)
      if (W.liveHold) return W.liveHold.then(go)
      if (W.liveDelay) return new Promise((r) => setTimeout(r, W.liveDelay)).then(go)
      return go()
    }
    if (o && o.method === 'POST' && /\\/api\\/jam\\/picture(\\?|$)/.test(url)) W.renders++
    return base(u, o)
  }
  return 1
})()`

/** The stage has shown `at` for at least `ms` (its own record, src/client/stage/main.tsx). */
const settled = (at: string, ms = 1100) => until(`(() => { try { const r = document.querySelector('.sh-play-stage iframe').contentWindow.__mvStage; return !!r && r.at === ${JSON.stringify(at)} && Date.now() - r.t > ${ms} } catch { return false } })()`, 20_000)
const play = async (o: Record<string, unknown>) => {
  await ev(`window.__mvStore.getState().setPlay(${JSON.stringify(o)}), 1`)
  await until(`!!document.querySelector('.sh-play-stage iframe')`, 10_000)
}
const start = async () => {
  await ev(`window.__mvJamCapture.getState().start(), 1`)
  await until(`!!window.__mvJamCapture.getState().current`, 5000)
  return ev(`window.__mvJamCapture.getState().current`) as Promise<string>
}
/** ← or →: play steps the stage itself (a store change alone moves only the shell's record of it) */
const arrow = async (dir: 'ArrowLeft' | 'ArrowRight') => {
  const base = { key: dir, code: dir, windowsVirtualKeyCode: dir === 'ArrowLeft' ? 37 : 39 }
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, s)
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, s)
}
const stageAt = (at: string) => until(`(() => { try { return document.querySelector('.sh-play-stage iframe').contentWindow.__mvStage.at === ${JSON.stringify(at)} } catch { return false } })()`, 10_000)
/** an element moved over the middle of the stage, proved to be what is there */
const over = async (sel: string) => {
  await ev(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); const r = document.querySelector('.sh-play-stage .dev').getBoundingClientRect(); Object.assign(n.style, { position: 'fixed', left: (r.x + r.width / 2 - 100) + 'px', top: (r.y + r.height / 2 - 60) + 'px', zIndex: 99 }); return 1 })()`)
  expect(await ev(`(() => { const r = document.querySelector('.sh-play-stage .dev').getBoundingClientRect(); return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(${JSON.stringify(sel)}) })()`)).toBe(true)
}
/** I, in the page's own turn as soon as the stage shows `at` - inside its first second whatever the machine's load; how
 *  long it had shown it */
const shotOnShown = (at: string) => ev(`new Promise((done) => { const f = () => { let r = null; try { r = document.querySelector('.sh-play-stage iframe').contentWindow.__mvStage } catch {} if (r && r.at === ${JSON.stringify(at)}) { window.__mvJamCapture.getState().picture(); done(Date.now() - r.t) } else setTimeout(f, 5) }; f() })`) as Promise<number>
/** I, as its key does it */
const shot = async () => { if (process.env.MV_DEBUG) console.log('shot:', await why(), JSON.stringify(await ev(`window.__mvStore.getState().play`))); return ev(`window.__mvJamCapture.getState().picture(), 1`) }
const shots = (id: string) => ev(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.shots ?? -1`)
/** ⇧E, its record sealed and taken as a draft; then the record as the server keeps it */
async function sealed(id: string): Promise<any> {
  await ev(`window.__mvJamCapture.getState().end(true), 1`)
  await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
  return (await ev(`fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)).record
}
const drop = (id: string) => ev(`(async () => { const q = window.__mvJamQueue.getState(); const c = (q.cards ?? []).find((x) => x.id === ${JSON.stringify(id)}); if (c) await q.act(c, 'drop'); window.__mvJamUi.getState().close(); return 1 })()`)
const pics = (rec: any) => rec.timeline.filter((x: any) => x.event === 'picture')
const index = () => { try { return JSON.parse(readFileSync(join(root, 'design', '.local', 'jam', 'pictures.json'), 'utf8')) } catch { return {} } }
const net = () => ev(`({ ...window.__net })`)
const live = () => ev(`({ calls: window.__live.calls.length, answered: window.__live.answered })`)
/** a fresh capture in play on `at`, settled - its id */
async function inPlay(at: string, o: Record<string, unknown> = {}) {
  await play({ at, device: 'mobile', theme: 'light', ...o })
  await settled(at)
  return start()
}
const leave = async (id?: string) => {
  if (id && await ev(`window.__mvJamCapture.getState().current === ${JSON.stringify(id)}`)) await ev(`window.__mvJamCapture.getState().drop(), 1`)
  await ev(`window.__mvStore.getState().setPlay(null), 1`)
  await ev(`(() => { const L = window.__live; if (L) { L.mode = 'ok'; L.gate = null } return 1 })()`)
}

async function boot(o: { noapp?: boolean; inset?: boolean } = {}) {
  await ev(`(() => { sessionStorage.setItem('mvtest-noapp', ${o.noapp ? "'1'" : "'0'"}); sessionStorage.setItem('mvtest-inset', ${o.inset ? "'1'" : "'0'"}); return 1 })()`)
  // a new document every time (the same URL with its hash would only move the hash)
  await browser!.go(s, 'about:blank')
  await browser!.go(s, `${ORIGIN}/#/b/main`)
  await until(`window.__mvStore?.getState().nodes.length >= 4 && !!window.__mvJamCapture && window.__mvStore.getState().nodes.every((n) => n.status === 'ready')`, 45_000)
  // no microphone: its question would sit over a wide stage (and take the render, as any overlay does)
  await ev(`window.__mvJamVoice.getState().setChoice('no'), 1`)
  await ev(WATCH)
}

beforeEach(async () => { if (browser && s) await ev(WATCH).catch(() => null) })

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-live-pic-'))
  bin = mkdtempSync(join(tmpdir(), 'mv-live-pic-bin-'))
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  put('package.json', { name: 'live-fixture', private: true, type: 'module' })
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  put('design/config.ts', "export default { jam: { agent: 'claude', concurrency: 1 } }\n")
  for (const f of ['alpha', 'bravo']) put(`design/scenes/spec/${f}.tsx`, frame(f))
  for (const f of ['one', 'two']) put(`design/scenes/deck/${f}.tsx`, frame(f, `export const meta = { title: '${f}', slide: true }\n`))
  put('design/scenes/docs/page.tsx', frame('page'))
  put('design/boards/main.json', { version: 1, name: 'main', auto: false, order: 0, nodes: [{ frame: 'spec/alpha' }, { frame: 'spec/bravo' }, { frame: 'deck/one' }, { frame: 'deck/two' }] })
  put('design/boards/docs.json', { version: 1, name: 'docs', auto: false, order: 1, nodes: [{ frame: 'docs/page' }] })
  put('design/publish.json', { boards: { docs: { type: 'doc' } } })
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d; const m = log.match(/→ (http:\/\/localhost:\d+)\//); if (m) ORIGIN = m[1] })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !/→ http:\/\/localhost:\d+\//.test(log)) await sleep(100)
  while (Date.now() - t0 < 60_000) { if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break; await sleep(200) }
  browser = await Browser.launch()
  if (!browser) return
  s = await browser.tab({ width: 1400, height: 900 })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_APP }, s)
  await browser.go(s, `${ORIGIN}/#/b/main`)
  await boot()
}, 120_000)

afterAll(async () => {
  browser?.close()
  if (server && server.exitCode === null) {
    const gone = new Promise((r) => server!.once('exit', r))
    try { server.kill('SIGTERM') } catch { /* gone */ }
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))])
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(bin, { recursive: true, force: true })
})

/** Why the stage is not eligible now, by liveAsk's own rules (a failing case says which) */
const why = () => ev(`(() => {
  const st = document.querySelector('.sh-play-stage'); const dev = st?.querySelector('.dev'); if (!dev) return 'no stage'
  const rec = st.querySelector('iframe').contentWindow.__mvStage; const p = window.__mvStore.getState().play
  const r = dev.getBoundingClientRect(); const bad = []
  if (!p) bad.push('no play'); if (!rec || rec.at !== p?.at) bad.push('record ' + JSON.stringify(rec) + ' at ' + p?.at); else if (Date.now() - rec.t < 1000) bad.push('not settled')
  const on = window.__mvInset.onScreen(r); if (!on || Math.abs(on.top - r.top) > .01 || Math.abs(on.left - r.left) > .01 || Math.abs(on.bottom - r.bottom) > .01 || Math.abs(on.right - r.right) > .01) bad.push('off screen')
  if (r.left < 6 || r.top < 6 || r.right > innerWidth - 6 || r.bottom > innerHeight - 6) bad.push('ring ' + JSON.stringify([r.left, r.top, r.right, r.bottom, innerWidth, innerHeight]))
  for (const fy of [1/6, 1/2, 5/6]) for (const fx of [1/6, 1/2, 5/6]) { const el = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy); if (!el || !st.contains(el)) bad.push('covered at ' + fx.toFixed(2) + ',' + fy.toFixed(2) + ' by ' + (el ? (el.className || el.tagName) + ' in ' + [...Array(4)].reduce((a) => { a.n = a.n?.parentElement; if (a.n) a.p.push(a.n.className || a.n.tagName); return a }, { n: el, p: [] }).p.join(' < ') : 'nothing')) }
  for (const el of document.querySelectorAll('.jm-caption, .jm-over, .jm-lane-in > *, .sh-toasts > *, .sh-tip, .sh-menu, .jm-focus > *, .jm-sheet-at > *')) { const b = el.getBoundingClientRect(); if (!st.contains(el) && b.width > 0 && b.height > 0 && b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom) bad.push('under ' + el.className) }
  return bad.join('; ') || 'eligible'
})()`)

const skippable = (name: string, fn: () => Promise<void>, ms = 90_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)

describe('live pictures in play (A4.6 #33-#36)', () => {
  skippable('a device preset: I takes one live picture - the stage\'s rect asked, its PNG stored with source live, no render; captioned "as you saw it"', async () => {
    const id = await inPlay('spec/alpha')
    const rect = await ev(`(() => { const r = document.querySelector('.sh-play-stage .dev').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    await shot()
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length === 1`, 10_000)
    expect((await ev(`window.__live.calls`))).toEqual([rect])
    const rec = await sealed(id)
    const p = pics(rec)
    // one logical picture for the shot: the live one (E pictured nothing more - the frame was pictured)
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ frame: 'spec/alpha', why: 'key', source: 'live' })
    expect(rec.pictures).toEqual([p[0].id])
    expect(await net()).toMatchObject({ renders: 0, uploads: 1 })
    // stored as the app gave it, 600, its entry live
    const e = index()[p[0].id]
    expect(e).toMatchObject({ frame: 'spec/alpha', capture: id, source: 'live' })
    const bytes = readFileSync(join(root, 'design', '.local', 'jam', e.file))
    expect(Array.from(bytes.subarray(0, 64))).toEqual(await ev(`window.__live.last`))
    expect(bytes.readUInt32BE(16)).toBe(Math.ceil(rect.width))
    // the read-back captions it
    await until(`[...document.querySelectorAll('.jm-thumbs *')].some((x) => /picture 1 · as you saw it/.test(x.textContent))`, 10_000)
    await drop(id); await leave()
  })

  skippable('fill and doc presets run edge to edge, a stage under the Jam ring, and an overlay on it: each takes the render, the app never asked', async () => {
    // fill
    let id = await inPlay('spec/alpha', { device: 'fill' })
    await shot()
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length === 1`, 25_000)
    // under the ring: the stage moved to 2 px from the top
    await ev(`window.__mvStore.getState().setPlay({ ...window.__mvStore.getState().play, device: 'mobile' }), 1`)
    await sleep(300)
    await ev(`(() => { const st = document.querySelector('.sh-play-stage'); const r = st.getBoundingClientRect(); st.style.transform = 'translateY(' + (2 - r.top) + 'px)'; return 1 })()`)
    await shot()
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length === 2`, 25_000)
    await ev(`document.querySelector('.sh-play-stage').style.transform = '', 1`)
    // the notes card over the stage (moved onto its middle, wherever the lane puts it)
    await ev(`window.__mvJamCapture.getState().setNoteOpen(true), 1`)
    await until(`!!document.querySelector('.jm-notes')`, 5000)
    await over('.jm-notes')
    await shot()
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length === 3`, 25_000)
    await ev(`window.__mvJamCapture.getState().setNoteOpen(false), 1`)
    const rec = await sealed(id)
    expect(pics(rec)).toHaveLength(3)
    expect(pics(rec).every((x: any) => !('source' in x))).toBe(true)
    expect(await live()).toEqual({ calls: 0, answered: 0 })
    expect((await net()).renders).toBe(3)
    await drop(id); await leave()

    // the doc preset: a doc board's frame in focus, at its reading width and the window's height
    await ev(`location.hash = '#/b/docs', 1`)
    await until(`window.__mvStore.getState().board === 'docs' && window.__mvStore.getState().nodes.some((n) => n.frame === 'docs/page' && n.status === 'ready')`, 20_000)
    await play({ at: 'docs/page', device: 'mobile', theme: 'light', focus: true })
    await until(`!!document.querySelector('.sh-play.doc')`, 5000)
    await settled('docs/page')
    id = await start()
    await shot()
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length === 1`, 25_000)
    expect(await live()).toEqual({ calls: 0, answered: 0 })
    await leave(id)
    await ev(`location.hash = '#/b/main', 1`)
    await until(`window.__mvStore.getState().board === 'main' && window.__mvStore.getState().nodes.every((n) => n.status === 'ready')`, 20_000)
  }, 150_000)

  skippable('a wide stage (the laptop preset) under the live caption, or a tip, takes the render, the app never asked - they take no pointer, so only their boxes tell', async () => {
    const id = await inPlay('spec/alpha', { device: 'laptop' })
    const n = (k: number) => until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length === ${k}`, 25_000)
    // clear, it is live: the recording tile below it never touches it
    await shot(); await n(1)
    expect((await live()).calls).toBe(1)
    // the words heard so far, over the capture tile: a band across the stage's lower left, below the grid's last row
    const words = 'make the header calmer and move the call to action up so it reads first on a laptop and the footer quieter too'
    await ev(`window.__mvJamVoice.setState((st) => ({ heard: { ...st.heard, [${JSON.stringify(id)}]: ${JSON.stringify(words)}.split(' ').map((w, i) => ({ w, at: i * 100 })) } })), 1`)
    await until(`!!document.querySelector('.jm-caption')`, 5000)
    const lap = (sel: string) => ev(`(() => { const c = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(), d = document.querySelector('.sh-play-stage .dev').getBoundingClientRect()
      const l = Math.max(c.left, d.left), r = Math.min(c.right, d.right), t = Math.max(c.top, d.top), b = Math.min(c.bottom, d.bottom)
      const el = document.elementFromPoint((l + r) / 2, (t + b) / 2)
      return { w: Math.round(r - l), h: Math.round(b - t), through: !!el && document.querySelector('.sh-play-stage').contains(el) } })()`)
    // over the stage, drawn on top, and hit-testing goes through it to the frame
    const cap = await lap('.jm-caption')
    expect(cap.w).toBeGreaterThan(100); expect(cap.h).toBeGreaterThan(10); expect(cap.through).toBe(true)
    await shot(); await n(2)
    expect((await live()).calls).toBe(1)
    await ev(`window.__mvJamVoice.setState((st) => { const heard = { ...st.heard }; delete heard[${JSON.stringify(id)}]; return { heard } }), 1`)
    await until(`!document.querySelector('.jm-caption')`, 5000)
    // a tip, where the shell puts it (its root), over the stage's top right corner, between the grid's points
    await ev(`(() => { const d = document.querySelector('.sh-play-stage .dev').getBoundingClientRect(); const t = document.createElement('div'); t.className = 'sh-tip below'; t.id = 'mvtest-tip'; t.textContent = 'Comments need the canvas running'; Object.assign(t.style, { left: (d.right - 60) + 'px', top: (d.top + 8) + 'px' }); (document.querySelector('.sh-app') ?? document.body).appendChild(t); return 1 })()`)
    const tip = await lap('#mvtest-tip')
    expect(tip.w).toBeGreaterThan(10); expect(tip.h).toBeGreaterThan(10); expect(tip.through).toBe(true)
    await shot(); await n(3)
    expect((await live()).calls).toBe(1)
    await ev(`document.getElementById('mvtest-tip').remove(), 1`)
    // all gone: live again
    await shot(); await n(4)
    const rec = await sealed(id)
    expect(pics(rec).map((x: any) => x.source ?? 'render')).toEqual(['live', 'render', 'render', 'live'])
    expect((await live()).calls).toBe(2)
    expect((await net()).renders).toBe(2)
    await drop(id); await leave()
  }, 150_000)

  skippable('every failure of the live path falls back to the render within its one shot, and the seal waits for it: ok false, a throw, an upload 500, an upload past 5 s', async () => {
    const id = await inPlay('spec/alpha')
    const cases: [string, string][] = [
      ['refused', `window.__live.mode = 'refuse'`],
      ['threw', `window.__live.mode = 'throw'`],
      ['500', `window.__live.mode = 'ok'; window.__net.liveFail = 500`],
      ['6 s', `window.__net.liveFail = 0; window.__net.liveDelay = 6000`],
    ]
    let n = 0
    for (const [name, how] of cases) {
      await ev(`(() => { ${how}; return 1 })()`)
      await shot()
      n++
      // one shot under way, never two: the live attempt, then its render
      expect(await shots(id), name).toBe(1)
      await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length === ${n}`, 30_000)
      expect(await shots(id), name).toBe(0)
    }
    expect((await net()).renders).toBe(4)
    // the last one again, then E while its live upload is still out: the seal waits for the render that follows
    await shot()
    await ev(`window.__mvJamCapture.getState().end(true), 1`)
    await sleep(1000)
    expect(await ev(`!!window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]`)).toBe(true)   // still sealing
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 40_000)
    const rec = (await ev(`fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)).record
    expect(pics(rec)).toHaveLength(5)
    expect(pics(rec).every((x: any) => !('source' in x))).toBe(true)
    expect(rec.timeline.some((x: any) => x.event === 'missing' && /picture/.test(x.what))).toBe(false)
    expect((await live()).calls).toBe(5)
    await ev(`window.__net.liveDelay = 0, 1`)
    await drop(id); await leave()
  }, 150_000)

  skippable('the capture races: a navigation, a resize, A -> B -> A, a stage reloaded at the same frame and the notes card opened, each during the ask - the bytes dropped, the render taken', async () => {
    const id = await inPlay('spec/alpha')
    const hold = `window.__live.gate = new Promise((r) => { window.__live.open = r }), 1`
    const release = `window.__live.open(), window.__live.gate = null, 1`
    let n = 0
    const race = async (name: string, during: () => Promise<void>, after: () => Promise<void> = async () => {}, kept = false) => {
      const uploads = (await net()).uploads
      await ev(hold)
      await shot()
      await until(`window.__live.calls.length === ${n + 1}`, 5000)
      await during()
      await ev(release)
      n++
      await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length === ${n}`, 30_000)
      expect((await net()).uploads - uploads, name).toBe(kept ? 1 : 0)
      await after()
      await settled('spec/alpha')
    }
    // held with nothing in between: the answer still holds, and the picture is live
    await race('nothing', async () => { await sleep(300) }, undefined, true)
    // the shot was decided for alpha: a move to bravo during the ask
    await race('navigation', async () => { await arrow('ArrowRight'); await stageAt('spec/bravo') }, async () => { await arrow('ArrowLeft'); await stageAt('spec/alpha') })
    await race('resize', async () => { await browser!.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 860, deviceScaleFactor: 1, mobile: false }, s); await sleep(300) })
    await race('A -> B -> A', async () => {
      await arrow('ArrowRight'); await stageAt('spec/bravo')
      await arrow('ArrowLeft')
      await settled('spec/alpha')   // back, and settled again: only its showing has changed
    })
    await race('reloaded', async () => {
      const boot = await ev(`document.querySelector('.sh-play-stage iframe').contentWindow.__mvStage.boot`)
      await ev(`document.querySelector('.sh-play-stage iframe').contentWindow.location.reload(), 1`)
      await until(`(() => { try { const r = document.querySelector('.sh-play-stage iframe').contentWindow.__mvStage; return r.boot !== ${JSON.stringify(boot)} && r.at === 'spec/alpha' } catch { return false } })()`, 15_000)
      await settled('spec/alpha')
    })
    await race('notes card', async () => {
      await ev(`window.__mvJamCapture.getState().setNoteOpen(true), 1`)
      await until(`!!document.querySelector('.jm-notes')`, 5000)
      await over('.jm-notes')
    }, async () => { await ev(`window.__mvJamCapture.getState().setNoteOpen(false), 1`) })
    const rec = await sealed(id)
    expect(pics(rec).map((x: any) => x.source ?? 'render')).toEqual(['live', 'render', 'render', 'render', 'render', 'render'])
    expect(pics(rec).every((x: any) => x.frame === 'spec/alpha')).toBe(true)
    expect((await net()).renders).toBe(5)
    await browser!.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, s)
    await drop(id); await leave()
  }, 180_000)

  skippable('the first second on a frame, and a slide\'s transition, take the render; a slide fitted to the window, settled, a live one', async () => {
    const id = await inPlay('spec/alpha')
    await arrow('ArrowRight')
    expect(await shotOnShown('spec/bravo')).toBeLessThan(1000)         // within a second of the move
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length === 1`, 25_000)
    expect(await live()).toEqual({ calls: 0, answered: 0 })
    await leave(id)
    // slides: the deck fitted to the window
    await play({ at: 'deck/one', device: 'slide', theme: 'light', slides: true })
    await settled('deck/one')
    const id2 = await start()
    await arrow('ArrowRight')
    await until(`window.__mvStore.getState().play.at === 'deck/two'`, 5000)
    await sleep(120)                                                  // inside the 350 ms transition
    await shot()
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id2)}]?.pictures.length === 1`, 25_000)
    expect(await live()).toEqual({ calls: 0, answered: 0 })
    await settled('deck/two')
    await shot()
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id2)}]?.pictures.length === 2`, 25_000)
    const rec = await sealed(id2)
    expect(pics(rec).map((x: any) => x.source ?? 'render')).toEqual(['render', 'live'])
    expect((await live()).calls).toBe(1)
    await drop(id2); await leave()
  }, 150_000)

  skippable('the same frame committed again (a restart on it) is a new showing: the render within its first second, never stuck unshown - a live one after', async () => {
    const id = await inPlay('spec/alpha')
    const seq = await ev(`document.querySelector('.sh-play-stage iframe').contentWindow.__mvStage.seq`)
    // the shell steps the stage to the frame it already shows, as Restart on the first frame does
    await ev(`(() => { const f = document.querySelector('.sh-play-stage iframe'); f.contentWindow.postMessage({ type: 'sh:stage-set', at: 'spec/alpha' }, location.origin); return 1 })()`)
    await until(`document.querySelector('.sh-play-stage iframe').contentWindow.__mvStage.seq > ${seq}`, 5000)
    expect(await shotOnShown('spec/alpha')).toBeLessThan(1000)
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length === 1`, 25_000)
    expect(await live()).toEqual({ calls: 0, answered: 0 })
    await settled('spec/alpha')
    await shot()
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length === 2`, 25_000)
    const rec = await sealed(id)
    expect(pics(rec).map((x: any) => x.source ?? 'render')).toEqual(['render', 'live'])
    await drop(id); await leave()
  })

  skippable('a stage under the scroll edge (the app\'s 44 px inset) takes the render', async () => {
    await boot({ inset: true })
    expect(await ev(`window.__mvInset.VISIBLE_TOP`)).toBe(60)
    const id = await inPlay('spec/alpha')
    // its top between the strip and the scroll edge
    await ev(`(() => { const st = document.querySelector('.sh-play-stage'); const r = st.getBoundingClientRect(); st.style.transform = 'translateY(' + (50 - r.top) + 'px)'; return 1 })()`)
    await shot()
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length === 1`, 25_000)
    expect(await live()).toEqual({ calls: 0, answered: 0 })
    await ev(`document.querySelector('.sh-play-stage').style.transform = '', 1`)
    await sleep(100)
    await shot()                                                      // in place again: a live one
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length === 2`, 25_000)
    const rec = await sealed(id)
    expect(pics(rec).map((x: any) => x.source ?? 'render')).toEqual(['render', 'live'])
    await drop(id); await leave()
    await boot()
  }, 150_000)

  skippable('the page leaving with a live upload in flight seals at once; the late result changes nothing', async () => {
    const id = await inPlay('spec/alpha')
    await ev(`window.__net.liveHold = new Promise((r) => { window.__net.letGo = r }), 1`)
    await shot()
    await until(`window.__net.uploads === 1`, 10_000)
    await ev(`window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })), 1`)
    // sealed as it stood, at once: no picture in it, the page's capture gone
    expect(await ev(`Object.keys(window.__mvJamCapture.getState().caps).length`)).toBe(0)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)})`, 20_000)
    const before = (await ev(`fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)).record
    expect(before.pictures).toEqual([])
    expect(before.timeline.some((x: any) => x.event === 'missing' && /closed/.test(x.what))).toBe(true)
    await ev(`window.__net.letGo(), 1`)
    await sleep(1500)
    const after = (await ev(`fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)).record
    expect(after).toEqual(before)
    expect(await ev(`Object.keys(window.__mvJamCapture.getState().caps).length`)).toBe(0)
    expect((await net()).renders).toBe(0)
    // the late upload reached a sealed capture: refused, nothing stored
    expect(Object.values(index()).filter((e: any) => e.capture === id)).toEqual([])
    await drop(id)
    await boot()
  }, 120_000)

  skippable('without marverApp the record is 0.28\'s: the render, no source, nothing new in it', async () => {
    await boot({ noapp: true })
    expect(await ev(`typeof window.marverApp`)).toBe('undefined')
    const id = await inPlay('spec/alpha')
    await shot()
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length === 1`, 25_000)
    const rec = await sealed(id)
    expect(Object.keys(pics(rec)[0]).sort()).toEqual(['at', 'event', 'frame', 'id', 'why'])
    expect(Object.keys(rec).sort()).toEqual(['context', 'format', 'id', 'pictures', 'sizes', 'timeline', 'v', 'view'])
    expect(JSON.stringify(rec)).not.toContain('live')
    expect(index()[pics(rec)[0].id].source).toBeUndefined()
    expect(await net()).toMatchObject({ renders: 1, uploads: 0 })
    await drop(id); await leave()
    await boot()
    expect(existsSync(join(root, 'design', '.local', 'jam'))).toBe(true)
  }, 120_000)
})
