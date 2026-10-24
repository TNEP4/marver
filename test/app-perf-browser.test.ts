import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'

/**
 * The shell's side of `mv:perf` (spec 28 A3.8 #9, #10, #16; marver 0.27.2), against a REAL `marver dev` and a REAL
 * Chrome whose page gets a fake `window.marverApp` before any script runs - app 0.2's preload as the contract freezes
 * it (`perf`, `onPerfAsk`, `perfInfo`), recorded: a gesture's start and end with one `seq` (the white-out detector's
 * window), the board's frame count at its commit, a probe ask answered for its tick, and the display's rate on the
 * page half's gesture record (A1.7's "60 Hz display, p50 33 ms"). With app 0.1's preload (no `perf`) the shell keeps
 * `marverApp` and sends nothing of this; in Chrome nothing of it runs. Skips without Chrome.
 */

const FRAME = (t: string) => `export const meta = { title: '${t}', viewport: 'mobile' }\nexport default () => <main style={{ padding: 24 }}><h1>${t}</h1></main>\n`

let root = ''
let dev: Dev | null = null
let browser: Browser | null = null
const tabs: string[] = []

beforeAll(async () => {
  root = fixtureRoot('mv-app-perf-', {
    'design/scenes/demo/one.tsx': FRAME('One'),
    'design/scenes/demo/two.tsx': FRAME('Two'),
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
      { key: 'n-one', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 },
      { key: 'n-two', frame: 'demo/two', x: 900, y: 0, w: 390, h: 844 },
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

/** app 0.2's preload, faked and recorded (`perf: false`: app 0.1's, which has none of A3's methods). */
const FAKE = (o: { perf: boolean; hz?: number | null }) => `(() => {
  const o = ${JSON.stringify(o)}
  const log = [], perf = [], asks = new Set()
  const say = (ch) => (p) => { log.push([ch, JSON.parse(JSON.stringify(p))]) }
  const api = { v: 1, topInset: 0, reopen: false, hello: say('hello'), theme: say('theme'), busy: say('busy'), menu: say('menu'),
    onAppState: () => () => {}, onMenuClick: () => () => {} }
  if (o.perf) {
    api.perf = (p) => { perf.push(JSON.parse(JSON.stringify(p))) }
    api.onPerfAsk = (fn) => { asks.add(fn); return () => asks.delete(fn) }
    api.perfInfo = () => ({ hz: o.hz ?? null })
  }
  window.marverApp = Object.freeze(api)
  window.__fake = { log, perf, ask: (a) => { for (const fn of asks) fn(a); return asks.size } }
})()`

async function open(o: { perf: boolean; hz?: number | null } | null): Promise<string> {
  const s = await browser!.tab({ width: 1400, height: 900 })
  tabs.push(s)
  if (o) await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE(o) }, s)
  await browser!.go(s, `${dev!.origin}/#/b/main`)
  await browser!.until(s, `!!window.__mvStore && __mvStore.getState().nodes.length === 2 && __mvStore.getState().nodes.every((n) => n.status === 'ready')`, 30_000)
  await browser!.send('Page.bringToFront', {}, s)
  return s
}
const ev = (s: string, js: string) => browser!.eval(s, js)
/** A layout animation at 33 ms a frame (rAF replaced for its length): one gesture, as page-recorder-browser drives it. */
const gesture = (s: string) => ev(s, `(async () => {
  const raf0 = window.requestAnimationFrame
  let t = 0
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(t += 33), 33)
  const w = document.getElementById('sh-world')
  w.classList.add('sh-preset')
  await new Promise((r) => setTimeout(r, 400))
  w.classList.remove('sh-preset')
  await new Promise((r) => setTimeout(r, 50))
  window.requestAnimationFrame = raf0
  return true
})()`)
const pageLines = (): Record<string, any>[] => {
  try { return readFileSync(join(root, 'design', '.local', 'perf', 'page.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
const skip = (ctx: { skip: () => void }) => { if (!browser) ctx.skip() }

describe('the shell\'s mv:perf, in app 0.2 (A3.8 #9, #10, #16)', () => {
  it('the board\'s frames at its commit; a gesture\'s start and end with one seq; a probe ask answered for its tick', async (ctx) => {
    skip(ctx)
    const s = await open({ perf: true, hz: 120 })
    await browser!.until(s, `window.__fake.perf.some((p) => p.kind === 'board')`, 10_000)
    const board = await ev(s, `window.__fake.perf.filter((p) => p.kind === 'board')`)
    expect(board.at(-1)).toMatchObject({ kind: 'board', frames: 2 })
    expect(new Set(board.map((b: { frames: number; asleep: number }) => `${b.frames}/${b.asleep}`)).size).toBe(board.length)   // never the same twice in a row
    await gesture(s)
    const g = await browser!.until(s, `(() => { const g = window.__fake.perf.filter((p) => p.kind === 'gesture'); return g.length >= 2 ? g : null })()`, 10_000)
    expect(g[0]).toMatchObject({ kind: 'gesture', on: true, type: 'layout' })
    expect(g[1]).toEqual({ kind: 'gesture', on: false, seq: g[0].seq })
    expect(await ev(s, `window.__fake.ask({ kind: 'probes', tick: 41, at: 'before' })`)).toBe(1)
    expect(await ev(s, `window.__fake.ask({ kind: 'probes', tick: 41, at: 'after' })`)).toBe(1)
    const probes = await ev(s, `window.__fake.perf.filter((p) => p.kind === 'probes')`)
    expect(probes.map((p: { tick: number; at: string }) => [p.tick, p.at])).toEqual([[41, 'before'], [41, 'after']])
    // the page half's gesture record carries the display's rate main said
    await ev(s, `window.__mvRecorder.send()`)
    const page = await ev(s, `window.__mvRecorder.page`)
    let rec: Record<string, any> | undefined
    for (let i = 0; i < 100 && !rec; i++) { rec = pageLines().find((r) => r.page === page && r.kind === 'gesture'); if (!rec) await new Promise((r) => setTimeout(r, 100)) }
    expect(rec).toMatchObject({ type: 'layout', hz: 120 })
  }, 90_000)

  it('app 0.1\'s preload (no perf): the shell keeps marverApp and sends nothing of A3\'s; its gesture record has no rate', async (ctx) => {
    skip(ctx)
    const s = await open({ perf: false })
    await browser!.until(s, `window.__fake.log.some((x) => x[0] === 'hello')`, 10_000)
    await gesture(s)
    await ev(s, `window.__mvRecorder.send()`)
    const page = await ev(s, `window.__mvRecorder.page`)
    let rec: Record<string, any> | undefined
    for (let i = 0; i < 100 && !rec; i++) { rec = pageLines().find((r) => r.page === page && r.kind === 'gesture'); if (!rec) await new Promise((r) => setTimeout(r, 100)) }
    expect(rec).toBeDefined()
    expect(rec!.hz).toBeUndefined()
    expect(await ev(s, `window.__fake.perf.length`)).toBe(0)
  }, 90_000)
})
