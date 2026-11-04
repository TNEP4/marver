import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'

/**
 * Spec 30 R8 #38, the shell's half, and #58's `self`, against a REAL `marver dev` and a REAL Chrome whose page gets a fake
 * `window.marverApp`: `watch` is sent only with `perfInfo().watch` (app 1.0.0 would refuse it and spend the tab's
 * bucket); `load` opens at the request, before the board's answer can come, and closes at settled or cut, one seq per
 * window; a covering play stage says so in its probe answer; `?mvrecorder=core` sends none of it, and neither does a
 * frame's URL lose the level. Skips without Chrome.
 */

const FRAME = (t: string) => `export const meta = { title: '${t}', viewport: 'mobile' }\nexport default () => <main style={{ padding: 24 }}><h1>${t}</h1></main>\n`

let root = ''
let dev: Dev | null = null
let browser: Browser | null = null
const tabs: string[] = []

beforeAll(async () => {
  root = fixtureRoot('mv-r30-watch-', {
    'design/scenes/demo/one.tsx': FRAME('One'),
    'design/scenes/demo/two.tsx': FRAME('Two'),
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
      { key: 'n-one', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 },
      { key: 'n-two', frame: 'demo/two', x: 900, y: 0, w: 390, h: 844 },
    ] }),
    'design/boards/other.json': JSON.stringify({ version: 1, name: 'other', order: 1, auto: false, nodes: [
      { key: 'n-three', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 },
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

/** app 1.0.1's preload (`watch: true`) or 1.0.0's (no `watch`), faked and recorded. */
const FAKE = (watch: boolean) => `(() => {
  const perf = [], asks = new Set()
  const say = () => () => {}
  const api = { v: 1, topInset: 0, reopen: false, hello: say(), theme: say(), busy: say(), menu: say(), onAppState: () => () => {}, onMenuClick: () => () => {},
    perf: (p) => { perf.push({ ...JSON.parse(JSON.stringify(p)), at: performance.now() }) },
    onPerfAsk: (fn) => { asks.add(fn); return () => asks.delete(fn) },
    perfInfo: () => (${watch} ? { hz: 120, watch: true } : { hz: 120 }) }
  window.marverApp = Object.freeze(api)
  window.__fake = { perf, ask: (a) => { for (const fn of asks) fn(a); return asks.size } }
})()`

const skip = (ctx: { skip: () => void }) => { if (!browser) ctx.skip() }
async function open(watch: boolean, q = '', board = 'main'): Promise<string> {
  const s = await browser!.tab({ width: 1400, height: 900 })
  tabs.push(s)
  await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE(watch) }, s)
  await browser!.go(s, `${dev!.origin}/${q}#/b/${board}`)
  await browser!.until(s, `!!window.__mvStore && __mvStore.getState().board === ${JSON.stringify(board)} && __mvStore.getState().nodes.length > 0`, 30_000)
  return s
}
const ev = <T>(s: string, js: string) => browser!.eval(s, js) as Promise<T>
const watches = (s: string) => ev<{ kind: string; on: boolean; seq: number; why: string; at: number }[]>(s, `__fake.perf.filter((p) => p.kind === 'watch')`)
const settled = (s: string) => browser!.until(s, `window.__mvRecorder && window.__mvRecorder.state().owner && window.__mvRecorder.state().owner.done === 'settled'`, 60_000)
const pageRecords = () => { try { return readFileSync(join(root, 'design', '.local', 'perf', 'page.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>) } catch { return [] } }

describe('the shell\'s `watch` (#38)', () => {
  it('app 1.0.1: `load` opens at the request and closes at settled, one seq per window', async (ctx) => {
    skip(ctx)
    const s = await open(true)
    await settled(s)
    const w = await watches(s)
    expect(w.map((x) => [x.why, x.on])).toEqual([['load', true], ['load', false]])
    expect(w[0]!.seq).toBe(w[1]!.seq)
    // at the request: before the board's first frame was ready, on the page's own clock
    const boot = await ev<{ commit: number }>(s, `(() => { const n = performance.getEntriesByType('resource').find((e) => /\\/api\\/boards?\\//.test(e.name)); return { commit: n ? n.responseEnd : Infinity } })()`)
    expect(w[0]!.at).toBeLessThan(boot.commit)
    // the next load: another window
    await ev(s, `location.hash = '#/b/other'; 1`)
    await browser!.until(s, `__mvStore.getState().board === 'other' && window.__mvRecorder.state().owner.done === 'settled'`, 60_000)
    const w2 = await watches(s)
    expect(w2.map((x) => [x.why, x.on])).toEqual([['load', true], ['load', false], ['load', true], ['load', false]])
    expect(w2[2]!.seq).not.toBe(w2[0]!.seq)
    expect(w2[3]!.seq).toBe(w2[2]!.seq)
  }, 120_000)

  it('a load cut by another closes its own window', async (ctx) => {
    skip(ctx)
    const s = await open(true)
    await ev(s, `location.hash = '#/b/other'; location.hash = '#/b/main'; 1`)
    await browser!.until(s, `__mvStore.getState().board === 'main' && window.__mvRecorder.state().owner && window.__mvRecorder.state().owner.done === 'settled' && window.__mvRecorder.state().pending.length === 0`, 60_000)
    await new Promise((r) => setTimeout(r, 300))
    const w = await watches(s)
    const opened = w.filter((x) => x.on).map((x) => x.seq).sort(), closed = w.filter((x) => !x.on).map((x) => x.seq).sort()
    expect(opened.length).toBeGreaterThanOrEqual(2)
    expect(closed).toEqual(opened)
  }, 120_000)

  it('app 1.0.0: no `perfInfo().watch`, and nothing is sent', async (ctx) => {
    skip(ctx)
    const s = await open(false)
    await settled(s)
    expect(await watches(s)).toEqual([])
    expect(await ev<number>(s, `__fake.perf.filter((p) => p.kind === 'board').length`)).toBeGreaterThan(0)   // the rest as ever
  }, 120_000)

  it('at the `core` level: nothing of this, on an app that takes it; frames keep the level on their URLs', async (ctx) => {
    skip(ctx)
    const s = await open(true, '?mvrecorder=core')
    await settled(s)
    expect(await watches(s)).toEqual([])
    const srcs = await ev<string[]>(s, `[...document.querySelectorAll('iframe')].map((f) => f.src)`)
    expect(srcs.length).toBeGreaterThan(0)
    for (const src of srcs) expect(src).toContain('mvrecorder=core')
  }, 120_000)

  it('a covering play stage says so in its probe answer: no points, `stage`', async (ctx) => {
    skip(ctx)
    const s = await open(true)
    await settled(s)
    const clear = await ev<{ stage?: boolean; points: unknown[] }>(s, `(async () => { __fake.ask({ kind: 'probes', tick: 5, at: 'before' }); return __fake.perf.filter((p) => p.kind === 'probes').at(-1) })()`)
    expect(clear.stage).toBeUndefined()
    await ev(s, `__mvStore.getState().enterPlay?.(); document.body.insertAdjacentHTML('beforeend', '<div class="sh-play"></div>'); 1`)
    await browser!.until(s, `!!document.querySelector('.sh-play')`, 10_000)
    const covered = await ev<{ stage?: boolean; points: unknown[] }>(s, `(async () => { __fake.ask({ kind: 'probes', tick: 6, at: 'before' }); return __fake.perf.filter((p) => p.kind === 'probes').at(-1) })()`)
    expect(covered.stage).toBe(true)
    expect(covered.points).toEqual([])
  }, 120_000)
})

describe('`self` (#58)', () => {
  it('the page writes one when asked, with what it recorded; at `core` none', async (ctx) => {
    skip(ctx)
    const s = await open(false)
    await settled(s)
    // a batch sent, so the period has bytes; then its record
    await ev(s, `window.__mvRecorder.send()`)
    await browser!.until(s, `window.__mvRecorder.state().queued === 0 && !window.__mvRecorder.state().sending`, 10_000)
    await ev(s, `import('/@fs${join(import.meta.dirname, '..', 'src', 'client', 'shell', 'recorder-self.ts')}').then((m) => { m.writeSelf(); return true })`)
    await ev(s, `window.__mvRecorder.send()`)
    await browser!.until(s, `window.__mvRecorder.state().queued === 0`, 10_000)
    const page = await ev<string>(s, `window.__mvRecorder.page`)
    const by = Date.now() + 15_000
    let self: Record<string, any> | undefined
    while (!self && Date.now() < by) { self = pageRecords().find((r) => r.kind === 'self' && r.page === page); if (!self) await new Promise((r) => setTimeout(r, 100)) }
    expect(self, 'a self record').toBeTruthy()
    expect(self!.records).toBeGreaterThan(3)
    expect(self!.cpuMs).toBeGreaterThanOrEqual(0)
    expect(self!.bytes).toBeGreaterThan(100)
    expect(self!.dropped).toBe(0)
    expect(self!.hookMs.send).toBeGreaterThanOrEqual(0)      // the send's own work, charged
    expect(Object.keys(self!.hookMs).every((k) => ['console', 'theme', 'mode', 'cmd', 'renders', 'send'].includes(k))).toBe(true)
    // a page at `core` records 0.29's, and no self
    const c = await open(false, '?mvrecorder=core')
    await settled(c)
    await ev(c, `import('/@fs${join(import.meta.dirname, '..', 'src', 'client', 'shell', 'recorder-self.ts')}').then((m) => { m.writeSelf(); return true })`)
    await ev(c, `window.__mvRecorder.send()`)
    await new Promise((r) => setTimeout(r, 500))
    const corePage = await ev<string>(c, `window.__mvRecorder.page`)
    expect(pageRecords().filter((r) => r.page === corePage && r.kind === 'self')).toEqual([])
    expect(pageRecords().filter((r) => r.page === corePage && r.kind === 'load').length).toBeGreaterThan(0)
  }, 180_000)
})
