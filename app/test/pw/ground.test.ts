/**
 * The one ground, main's half (spec 28 A2.2, A2.10's (A3) cases, A3.8 #24-#33): the decisions, from main's journal,
 * on the dev build under Playwright, with the real trust - the bridge, the canvas preload, the proof - and fake
 * canvases speaking 0.27.2's contract (harness/ground-shell.ts). Main's cover is app 0.1's plain view and the ground
 * gate is turned on for this launch (`MARVER_APP_GROUND=1`): S15 has not picked a cover (A3.8 #3), so these cases
 * prove what main decides and when, never what reaches the screen - that is the capture matrix's (A3.8 #35-#37).
 *
 * Checked: an inset canvas runs full height and is uncovered only in the turn its document answers the latest
 * request, after its hello said 44; one without `inset` stays below and covered; a page that applied no inset is
 * moved below in its hello's turn, one that never says hello stays covered, a late one is uncovered only after; a
 * reply of an earlier epoch and one at another size change nothing; a resize covers with its bounds and asks once
 * for the final size; a live resize asks nothing until it ends (resized, or the quiet timer); a reload covers at its
 * commit, a hash change makes no epoch, the canvas stopping covers in the registry's turn with the layout kept; HTML
 * fullscreen goes below and covered, then back full with a fresh epoch; a switch covers in its own turn, Home
 * uncovers it, rapid switches never show a canvas without the cover; the GPU process lost or replaced covers every
 * view until a newer epoch is answered; Home, Settings and a tab page run full height with their content 44 px down.
 * Navigation outcomes from a full, uncovered page, through the real event order of views.ts and the nav adapter: a
 * stop, a superseded navigation and a refused reload change no geometry and keep trust and the cover; a redirect
 * lands full at a fresh epoch; a new instance after the commit (with and without inset) covers in the registry's
 * turn and keeps the layout until the page's own reload; one before the commit drops the pending, so the document
 * lands below, told 0; one after the proof's headers commits unattributed, below, beneath its tab page; a failed
 * proof and an instance mismatch show the tab page in the failure's turn, below only with an error page. HTML
 * fullscreen in play mode (an element), with a resize and a switch during it; the window's own full screen in and
 * out, with HTML fullscreen inside it (a launch of its own). The GPU process killed for real. And with the gate shut
 * (no cover chosen, as in a release before S15): an inset canvas stays below, told 0, under 0.1's still dots.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { proofHeaders } from '../../../src/server/proof.ts'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'
import { pageHtml, startFakeCanvas, type FakeCanvas, type FakeOptions } from '../harness/fake-canvas.ts'
import { GROUND_SHELL } from '../harness/ground-shell.ts'

interface Geo { layout: 'full' | 'below'; pending?: { gen: number; instance: string; layout: string }; inset?: 0 | 44; htmlFullscreen: boolean }
interface GroundState { ground: boolean; resizing: boolean; cover: { visible: boolean; color: string }; tabs: { id: string; geo: Geo; placed: string; seeThrough: boolean; epoch: number | null; gen: number }[] }
interface Change { key: string; op: string; visible?: boolean; rect?: { x: number; y: number; width: number; height: number } }
interface Present { tab: string; op: string; epoch: number; w?: number; h?: number }

let w: WindowRun
const fakes: FakeCanvas[] = []
beforeAll(async () => { w = await launchWindow('pw', { extraEnv: { MARVER_APP_FAKE_TRUST: '0', MARVER_APP_GROUND: '1' } }) })
afterAll(async () => { await w?.close(); for (const f of fakes) await f.close().catch(() => {}) })

const ground = () => w.run.call<GroundState>('ground:state')
const geoOf = async (id: string) => (await ground()).tabs.find((t) => t.id === id)!
const content = async () => (await w.run.call<{ content: { width: number; height: number } }>('window')).content
const FULL = (c: { width: number; height: number }) => ({ x: 0, y: 0, width: c.width, height: c.height })
const BELOW = (c: { width: number; height: number }) => ({ x: 0, y: 44, width: c.width, height: c.height - 44 })
const bounds = async (key: string) => (await w.views()).find((v) => v.key === key)
const exec = <T>(target: string, js: string, gesture = false) => w.run.call<T>('exec', { target, js, gesture })
/** in the main frame now, never waiting for a load in flight */
const execNow = <T>(target: string, js: string) => w.run.call<T>('exec', { target, js, frame: true })
const mark = async () => (await w.log()).length
const lines = async (topic: string, since: number) => w.log(topic, since)
const presents = async (since: number, tab?: string) => (await lines('present', since)).map((l) => ({ ...(l.data as unknown as Present), turn: l.turn })).filter((p) => !tab || p.tab === tab)
const composes = async (since: number) => (await lines('compose', since)).map((l) => ({ turn: l.turn, cover: (l.data.cover as { visible: boolean }).visible, changes: l.data.changes as Change[] }))
const coverChanges = async (since: number) => (await composes(since)).filter((c) => c.changes.some((x) => x.key === 'cover'))
/** the strip draws its still dots now (main's `dots`, applied by the strip's page) */
const stripDots = () => waitFor('the strip settled', async () => {
  const on = await exec<boolean>('strip', `document.body.classList.contains('dots')`)
  return (await ground()).cover.visible === on ? { on } : null
}).then((x) => x.on)

async function waitFor<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(await ground()).slice(0, 1500)}`)
    await sleep(40)
  }
}
/** the active tab see-through and the cover hidden over it */
const uncovered = (id: string, ms?: number) => waitFor(`${id} uncovered`, async () => { const g = await ground(); return !g.cover.visible && g.tabs.find((t) => t.id === id)?.seeThrough ? g : null }, ms)

async function canvas(slot: number, name: string, o: Partial<FakeOptions> = {}): Promise<{ fake: FakeCanvas; id: string }> {
  const fake = await startFakeCanvas({ home: w.env.home, slotBase: w.slotBase, slot, name, features: ['bridge', 'inset'], script: GROUND_SHELL, ...o })
  fakes.push(fake)
  await fake.ready
  const s = await w.until((x) => x.tabs.some((t) => t.reg?.instance === fake.instance && t.reg.state === 'ready'), 10_000, `${name}'s tab`)
  return { fake, id: s.tabs.find((t) => t.reg?.instance === fake.instance)!.id }
}
const lifted = (id: string) => w.until((x) => { const t = x.tabs.find((q) => q.id === id); return !!t?.doc?.lifted && !!t.doc.trusted }, 10_000, `${id} lifted`)
/** reload the tab's page into a mode of the fake shell (harness/ground-shell.ts), and wait for the new document */
async function reloadInto(id: string, cfg: Record<string, unknown> | null): Promise<number> {
  const before = (await w.tab(id)).doc!.commits
  await exec(id, cfg ? `sessionStorage.setItem('mv-ground', ${JSON.stringify(JSON.stringify(cfg))}); 1` : `sessionStorage.removeItem('mv-ground'); 1`)
  const since = await mark()
  await w.run.call('reloadPage', { target: id })
  await w.until((x) => { const t = x.tabs.find((q) => q.id === id)!; return (t.doc?.commits ?? 0) > before && !!t.doc?.lifted }, 10_000, `${id} reloaded`)
  return since
}

/**
 * A fake canvas whose identity and answers a case changes while it runs (A2.10's navigation outcomes): it serves the
 * shell's document itself - signed with the identity it holds now, or with a wrong key (a failed proof), or naming an
 * instance the registry never held (an instance mismatch); `/?redirect` is a 302 to `/index.html`; `?coop` makes it
 * cross-origin isolated (COOP same-origin, COEP require-corp: a browsing-instance swap into a renderer of its own,
 * the old one alive);
 * `?slow`, or every document while `hold` is on, waits until `release()`. `rebind(features)` is a new instance
 * taking the slot: the same server, a new slot file - new instance, new key, its features - as a restarted
 * `marver dev` writes.
 */
interface Mutable {
  fake: FakeCanvas
  id: string
  mode: { hold: boolean; proof: 'valid' | 'wrong-key' | 'other-instance' }
  held(): number
  release(): void
  rebind(features: string[]): Promise<string>
  close(): Promise<void>
}
async function mutable(slot: number, name: string, features: string[] = ['bridge', 'inset']): Promise<Mutable> {
  const ident: { instance: string; key: Buffer; port: number } = { instance: '', key: Buffer.alloc(0), port: w.slotBase + slot }
  const mode: Mutable['mode'] = { hold: false, proof: 'valid' }
  const waiting: (() => void)[] = []
  const html = pageHtml({ name, script: GROUND_SHELL })
  const serve = (req: IncomingMessage, res: ServerResponse): boolean => {
    const u = new URL(req.url ?? '/', 'http://x')
    if ((u.pathname !== '/' && u.pathname !== '/index.html') || req.method !== 'GET') return false
    if (u.searchParams.has('redirect')) { res.writeHead(302, { location: '/index.html?redirected=1', 'cache-control': 'no-store' }); res.end(); return true }
    const answer = () => {
      const p = mode.proof === 'wrong-key' ? { ...ident, key: randomBytes(32) } : mode.proof === 'other-instance' ? { ...ident, instance: randomUUID() } : ident
      const h: Record<string, string> = { 'content-type': 'text/html', 'cache-control': 'no-store', ...proofHeaders(p, req.headers['x-mv-nonce']) }
      // cross-origin isolated: its own browsing instance and a process of its own (a same-site COOP swap alone may
      // keep the renderer)
      if (u.searchParams.has('coop')) { h['cross-origin-opener-policy'] = 'same-origin'; h['cross-origin-embedder-policy'] = 'require-corp' }
      res.writeHead(200, h)
      res.end(html)
    }
    if (mode.hold || u.searchParams.has('slow')) waiting.push(answer)
    else answer()
    return true
  }
  const fake = await startFakeCanvas({ home: w.env.home, slotBase: w.slotBase, slot, name, features, script: GROUND_SHELL, onRequest: serve })
  fakes.push(fake)
  ident.instance = fake.instance
  ident.key = fake.key
  await fake.ready
  const s = await w.until((x) => x.tabs.some((t) => t.reg?.instance === fake.instance && t.reg.state === 'ready'), 10_000, `${name}'s tab`)
  const id = s.tabs.find((t) => t.reg?.instance === fake.instance)!.id
  return {
    fake, id, mode,
    held: () => waiting.length,
    release: () => { for (const go of waiting.splice(0)) go() },
    async rebind(f) {
      const key = randomBytes(32)
      const instance = randomUUID()
      const rec = { ...fake.record(), instance, key: key.toString('base64url'), features: f, startedAt: Date.now() }
      const tmp = `${fake.slotFile}.${randomBytes(4).toString('hex')}.tmp`
      writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, fake.slotFile)
      ident.instance = instance
      ident.key = key
      await w.until((x) => { const t = x.tabs.find((q) => q.id === id); return t?.reg?.instance === instance && t.reg.state === 'ready' }, 10_000, `${name} rebound`)
      return instance
    },
    async close() { rmSync(fake.slotFile, { force: true }); await fake.close() },
  }
}
/** the tab's layout lines since a mark, as (event, layout, pending) */
const layoutOf = async (id: string, since: number) => (await lines('layout', since)).map((l) => ({ turn: l.turn, ...(l.data as { tab: string; event: string; from: Geo; to: Geo }) })).filter((l) => l.tab === id)
/** the adapter's events for the tab's webContents since a mark */
const navOf = async (id: string, since: number) => { const wc = (await w.tab(id)).wcId; return (await lines('nav', since)).filter((l) => l.data.wc === wc).map((l) => l.data.event as string) }

describe('the one ground: the inset, the cover, the epochs (A3.8 #24-#27)', () => {
  let a = ''
  let fa: FakeCanvas

  it('an inset canvas: mv:doc answers 44, its view runs full height, uncovered in the turn its answer is accepted', async () => {
    expect((await ground()).ground).toBe(true)
    ;({ fake: fa, id: a } = await canvas(1, 'Inset'))
    const since = await mark()
    await w.run.call('activate', { id: a })
    await lifted(a)
    const g = await uncovered(a)
    const c = await content()
    expect((await bounds(`${a}:view`))!.bounds).toEqual(FULL(c))
    expect(g.tabs.find((t) => t.id === a)!.geo).toEqual({ layout: 'full', htmlFullscreen: false, inset: 44 })
    expect(await exec(a, 'JSON.stringify([window.marverApp.topInset, window.__ground.applied])')).toBe('[44,44]')
    // the layout: pending full at start (a documentless view pre-sized), full at the commit, then the hello's 44
    const lay = (await lines('layout', since)).map((l) => l.data as { tab: string; event: string; to: Geo }).filter((l) => l.tab === a)
    expect(lay.map((l) => l.event)).toEqual(['start', 'commit', 'hello'])
    expect(lay.map((l) => l.to.layout)).toEqual(['full', 'full', 'full'])
    // one ask, at the view's size; the answer accepted and the cover hidden in the same turn
    const ps = await presents(since, a)
    const ask = ps.find((p) => p.op === 'ask')!
    expect([ask.w, ask.h]).toEqual([c.width, c.height])
    const ok = ps.find((p) => p.op === 'answer' && p.epoch === ask.epoch)!
    const lift = (await coverChanges(since)).find((x) => x.changes.some((ch) => ch.key === 'cover' && ch.visible === false))!
    expect(lift.turn).toBe(ok.turn)
    expect(ps.find((p) => p.op === 'uncover')!.epoch).toBe(ask.epoch)
    // its cover record (the recorder's line, A3.8 #27): made by the hello, uncovered, named by the document that said it
    const rec = (await lines('cover-record', since)).map((l) => l.data).find((d) => d.tab === a && d.epoch === ask.epoch)
    expect(rec).toMatchObject({ tab: a, ws: fa.ws, cause: 'hello', outcome: 'uncovered', frames: 2, uncoverDelayMs: 0 })
    expect(rec!.page).toMatch(/^PAGE_/)
    expect(rec!.uncoveredMs as number).toBeGreaterThanOrEqual(rec!.answeredMs as number)
    // over a see-through canvas the strip draws no still dots: its own scroll edge shows there (A3.8 #29)
    expect(await stripDots()).toBe(false)
    // the lift of its tab page showed the view with the cover up (until then the tab page painted its own ground)
    const shown = (await composes(since)).find((x) => x.changes.some((ch) => ch.key === `${a}:view` && ch.op === 'visible' && ch.visible === true))!
    expect(shown.cover).toBe(true)
    expect(shown.turn).toBeLessThan(ok.turn)
  })

  it('a canvas without inset (0.27.1): below the strip, covered in every turn, told 0, never asked', async () => {
    const { id } = await canvas(2, 'No inset', { features: ['bridge'] })
    await w.run.call('activate', { id })
    await lifted(id)
    const since = await mark()
    await waitFor('its hello', async () => (await geoOf(id)).geo.inset === 0)
    await sleep(300)
    try {
      expect((await bounds(`${id}:view`))!.bounds).toEqual(BELOW(await content()))
      expect(await exec(id, 'JSON.stringify([window.marverApp.topInset, window.__ground.applied, window.__ground.asks.length])')).toBe('[0,0,0]')
      expect((await ground()).cover.visible).toBe(true)
      for (const x of await composes(since)) expect(x.cover).toBe(true)
      expect(await presents(since, id)).toEqual([])
      // app 0.1's cover covers it: the strip draws 0.1's still dots over it (A3.8 #3)
      expect(await stripDots()).toBe(true)
    } finally {
      await w.run.call('activate', { id: a })
      await uncovered(a)
    }
  })

  it('a page that applied no inset is moved below in its hello\'s turn; one that never says hello stays covered; a late hello uncovers only after', async () => {
    let since = await reloadInto(a, { inset: 0 })
    await waitFor('the hello of 0', async () => (await geoOf(a)).geo.inset === 0)
    const hello = (await lines('layout', since)).find((l) => (l.data as { tab: string; event: string }).tab === a && (l.data as { event: string }).event === 'hello')!
    expect((hello.data as { to: Geo }).to.layout).toBe('below')
    const moved = (await composes(since)).find((x) => x.turn === hello.turn && x.changes.some((ch) => ch.key === `${a}:view` && ch.op === 'bounds'))!
    expect(moved.changes.find((ch) => ch.key === `${a}:view`)!.rect!.y).toBe(44)
    expect(moved.cover).toBe(true)
    expect((await ground()).cover.visible).toBe(true)

    since = await reloadInto(a, { hello: 'never' })
    await sleep(1500)
    const g = await geoOf(a)
    expect([g.geo.layout, g.geo.inset, g.seeThrough]).toEqual(['full', undefined, false])
    expect((await ground()).cover.visible).toBe(true)
    expect((await presents(since, a)).filter((p) => p.op === 'ask')).toEqual([])

    since = await reloadInto(a, { hello: 'late', lateMs: 1500 })
    const t0 = Date.now()
    await uncovered(a, 8000)
    expect(Date.now() - t0).toBeGreaterThan(1000)
    const ls = await lines('layout', since)
    const helloAt = ls.find((l) => (l.data as { tab: string; event: string }).tab === a && (l.data as { event: string }).event === 'hello')!
    const up = (await presents(since, a)).find((p) => p.op === 'uncover')!
    expect(BigInt((await w.log('present', since)).find((l) => (l.data as unknown as Present).op === "uncover")!.t)).toBeGreaterThan(BigInt(helloAt.t))
    expect(up).toBeTruthy()
    await reloadInto(a, null)
    await uncovered(a)
  })

  it('a reply of an earlier epoch is stale and a reply at another size a mismatch: neither lifts the cover', async () => {
    let since = await reloadInto(a, { present: 'answer-old' })
    await sleep(600)
    expect((await ground()).cover.visible).toBe(true)
    // a second request (a resize): the page sends the held reply of the first epoch first
    const c = await content()
    await w.run.call('resize', { width: c.width - 40, height: c.height })
    await waitFor('the stale reply', async () => (await presents(since, a)).some((p) => p.op === 'stale'))
    expect((await presents(since, a)).some((p) => p.op === 'answer')).toBe(false)
    expect((await ground()).cover.visible).toBe(true)
    // the page answers normally again: the next epoch lifts it
    await exec(a, `window.__ground.cfg.present = 'normal'; 1`)
    await w.run.call('resize', { width: c.width, height: c.height })
    await uncovered(a)

    since = await reloadInto(a, { present: 'wrong-size' })
    await waitFor('the mismatch', async () => (await presents(since, a)).some((p) => p.op === 'mismatch'))
    await sleep(300)
    expect((await ground()).cover.visible).toBe(true)
    expect((await presents(since, a)).some((p) => p.op === 'answer')).toBe(false)
    await reloadInto(a, null)
    await uncovered(a)
  })

  it('a resize covers in the turn of its bounds, asks once for the final size, and the deferred compose makes no second epoch', async () => {
    const c = await content()
    const since = await mark()
    await w.run.call('resize', { width: c.width - 120, height: c.height - 60 })
    await uncovered(a)
    const now = await content()
    const moved = (await composes(since)).find((x) => x.changes.some((ch) => ch.key === `${a}:view` && ch.op === 'bounds'))!
    expect(moved.cover).toBe(true)
    expect(moved.changes.some((ch) => ch.key === 'cover' && ch.visible === true)).toBe(true)
    const asks = (await presents(since, a)).filter((p) => p.op === 'ask')
    expect(asks.filter((p) => p.w === now.width && p.h === now.height)).toHaveLength(1)
    expect(asks.at(-1)!.turn).toBeGreaterThanOrEqual(moved.turn)
    await w.run.call('resize', { width: c.width, height: c.height })
    await uncovered(a)
  })

  it('a live resize covers from will-resize, asks nothing until resized, then exactly once; with no resized, the quiet timer ends it', async () => {
    const c = await content()
    let since = await mark()
    await w.run.call('ground:emit', { event: 'will-resize' })
    expect((await ground()).cover.visible).toBe(true)
    for (const d of [20, 40, 60]) { await w.run.call('ground:emit', { event: 'will-resize' }); await w.run.call('resize', { width: c.width - d, height: c.height }); await sleep(120) }
    expect((await ground()).resizing).toBe(true)
    expect((await presents(since, a)).filter((p) => p.op === 'ask')).toEqual([])
    expect((await ground()).cover.visible).toBe(true)
    await w.run.call('ground:emit', { event: 'resized' })
    await uncovered(a)
    expect((await presents(since, a)).filter((p) => p.op === 'ask')).toHaveLength(1)
    expect((await lines('resize', since)).map((l) => l.data)).toEqual([{ live: true, via: 'will-resize' }, { live: false, via: 'resized' }])
    // a drag that ends where it began is a new epoch all the same (A3.8 #28)
    since = await mark()
    await w.run.call('ground:emit', { event: 'will-resize' })
    await w.run.call('ground:emit', { event: 'resized' })
    await uncovered(a)
    expect((await presents(since, a)).filter((p) => p.op === 'ask')).toHaveLength(1)
    // no resized: the quiet timer (500 ms after the last resize) ends it
    since = await mark()
    await w.run.call('ground:emit', { event: 'will-resize' })
    await w.run.call('resize', { width: c.width, height: c.height })
    await sleep(900)
    await uncovered(a)
    expect((await lines('resize', since)).map((l) => (l.data as { via: string }).via)).toEqual(['will-resize', 'quiet'])
    expect((await presents(since, a)).filter((p) => p.op === 'ask')).toHaveLength(1)
  })
})

describe('the one ground through navigation, fullscreen, switching and the GPU process (A2.2, A3.8 #24, #25, #27)', () => {
  let a = ''
  let b = ''
  let fa: FakeCanvas

  beforeAll(async () => {
    ;({ fake: fa, id: a } = await canvas(5, 'Alpha'))
    ;({ id: b } = await canvas(6, 'Beta'))
    for (const id of [b, a]) { await w.run.call('activate', { id }); await lifted(id); await uncovered(id) }
  })

  it('a reload covers at its commit and uncovers after its hello and answer; a hash change makes no epoch', async () => {
    const since = await reloadInto(a, null)
    await uncovered(a)
    const commit = (await lines('layout', since)).find((l) => (l.data as { tab: string; event: string }).tab === a && (l.data as { event: string }).event === 'commit')!
    const covered = (await coverChanges(since)).find((x) => x.changes.some((ch) => ch.key === 'cover' && ch.visible === true))!
    expect(covered.turn).toBeLessThanOrEqual(commit.turn)
    const e0 = (await geoOf(a)).epoch
    const s2 = await mark()
    await exec(a, `location.hash = '#/b/elsewhere'; 1`)
    await sleep(400)
    expect((await geoOf(a)).epoch).toBe(e0)
    expect((await coverChanges(s2))).toEqual([])
    expect((await lines('layout', s2))).toEqual([])
  })

  it('HTML fullscreen: below and covered in the event\'s turn, the window untouched; leaving: full, covered, then a fresh epoch', async () => {
    const win = await w.run.call<{ bounds: unknown; fullScreen: boolean }>('window')
    const since = await mark()
    await exec(a, 'document.documentElement.requestFullscreen().then(() => true)', true)
    await waitFor('fullscreen', async () => (await geoOf(a)).geo.htmlFullscreen)
    await sleep(300)
    const c = await content()
    expect((await bounds(`${a}:view`))!.bounds).toEqual(BELOW(c))
    expect((await ground()).cover.visible).toBe(true)
    const enter = (await lines('layout', since)).find((l) => (l.data as { event: string }).event === 'html-fullscreen')!
    const moved = (await composes(since)).find((x) => x.turn === enter.turn && x.changes.some((ch) => ch.key === `${a}:view` && ch.op === 'bounds'))!
    expect(moved.cover).toBe(true)
    expect(await w.run.call('window')).toMatchObject({ bounds: win.bounds, fullScreen: false })
    const e1 = (await geoOf(a)).epoch!
    await exec(a, 'document.exitFullscreen().then(() => true)')
    await uncovered(a)
    expect((await bounds(`${a}:view`))!.bounds).toEqual(FULL(c))
    expect((await geoOf(a)).epoch!).toBeGreaterThan(e1)
  })

  it('a switch covers in its own turn and uncovers on the new view\'s answer; Home uncovers by itself; rapid switches never show a canvas uncovered unasked', async () => {
    let since = await mark()
    await w.run.call('activate', { id: b })
    await uncovered(b)
    const sw = (await composes(since)).find((x) => x.changes.some((ch) => ch.key === `${b}:view` && ch.op === 'visible' && ch.visible === true))!
    expect(sw.cover).toBe(true)
    since = await mark()
    await w.run.call('activate', { id: 'home' })
    await waitFor('the cover hidden over Home', async () => !(await ground()).cover.visible)
    const home = (await composes(since)).find((x) => x.changes.some((ch) => ch.key === 'home:view' && ch.visible === true))!
    expect(home.cover).toBe(false)
    since = await mark()
    for (let i = 0; i < 20; i++) await w.run.call('activate', { id: i % 2 ? a : b })
    await uncovered(a)
    // every turn that showed a canvas view showed the cover with it, and the cover only lifted on an accepted answer
    const ok = new Set((await presents(since)).filter((p) => p.op === 'answer').map((p) => p.turn))
    for (const x of await composes(since)) {
      if (x.changes.some((ch) => (ch.key === `${a}:view` || ch.key === `${b}:view`) && ch.op === 'visible' && ch.visible === true)) expect(x.cover).toBe(true)
      if (x.changes.some((ch) => ch.key === 'cover' && ch.visible === false)) expect(ok.has(x.turn)).toBe(true)
    }
    // the records (A3.8 #27): an epoch whose tab was switched away before it answered ended at the hide, superseded -
    // never "never", which is a page that showed a second with no answer
    const recs = (await lines('cover-record', since)).map((l) => l.data as { tab: string; outcome: string; sentMs: number; hiddenMs?: number })
    expect(recs.filter((r) => r.hiddenMs !== undefined).length).toBeGreaterThan(5)
    for (const r of recs) if (r.outcome === 'never') expect(r.hiddenMs! - r.sentMs).toBeGreaterThanOrEqual(1000)
  })

  it('the GPU process lost, or replaced with no event: every view covered until a newer epoch is answered', async () => {
    const e0 = (await geoOf(a)).epoch!
    let since = await mark()
    await w.run.call('ground:gpu-lost')
    const g = await uncovered(a)
    expect(g.tabs.find((t) => t.id === a)!.epoch!).toBeGreaterThan(e0)
    expect((await coverChanges(since))[0]!.changes.find((ch) => ch.key === 'cover')!.visible).toBe(true)
    // an identity read that changed (a replacement Electron sent nothing for): the same, at a newer epoch again
    const e1 = g.tabs.find((t) => t.id === a)!.epoch!
    since = await mark()
    await w.run.call('ground:gpu', { id: { pid: 1, born: 1 } })
    await w.run.call('ground:gpu', { id: { pid: 2, born: 2 } })
    const g2 = await uncovered(a)
    expect(g2.tabs.find((t) => t.id === a)!.epoch!).toBeGreaterThan(e1)
    expect((await coverChanges(since)).length).toBeGreaterThan(0)
  })

  it('the canvas stopping covers in the registry\'s turn and keeps its layout full; Beta stays as it was', async () => {
    await w.run.call('activate', { id: a })
    await uncovered(a)
    const since = await mark()
    await fa.close()
    await waitFor('Alpha gone', async () => (await w.tab(a)).reg?.state === 'gone')
    await sleep(200)
    const g = await geoOf(a)
    expect([g.geo.layout, g.seeThrough]).toEqual(['full', false])
    expect((await ground()).cover.visible).toBe(true)
    const reg = (await w.log('registry', since)).find((l) => l.data.tab === a)!
    const cov = (await coverChanges(since)).find((x) => x.changes.some((ch) => ch.key === 'cover' && ch.visible === true))!
    expect(cov.turn).toBe(reg.turn)
    expect((await geoOf(b)).geo).toMatchObject({ layout: 'full', inset: 44 })
  })
})

describe('navigation outcomes from a full, uncovered page (A2.10\'s (A3) cases, design-ground §6.3 #7)', () => {
  let m: Mutable
  let id = ''
  beforeAll(async () => {
    m = await mutable(18, 'Nav')
    id = m.id
    await w.run.call('activate', { id })
    await lifted(id)
    await uncovered(id)
  })
  afterAll(async () => { m.release(); await m.close() })
  const trustedNow = async () => { const t = await w.tab(id); return !!t.doc?.trusted && !!t.doc.lifted }

  it('a stop: the navigation\'s pending dropped, the committed document kept - full, trusted, uncovered, its epoch unchanged', async () => {
    const before = await geoOf(id)
    const since = await mark()
    await execNow(id, `location.href = '/?slow=1'; 1`)
    await waitFor('the slow request held', async () => m.held() > 0)
    await execNow(id, `window.stop(); 1`)
    await waitFor('the abort', async () => (await layoutOf(id, since)).some((l) => l.event === 'abort'))
    // the adapter's abort (did-stop-loading, the attempt neither committed nor failed) drops that navigation's pending
    const ls = await layoutOf(id, since)
    expect(ls.map((l) => [l.event, l.to.layout])).toEqual([['start', 'full'], ['abort', 'full']])
    expect(ls[0]!.to.pending).toMatchObject({ layout: 'full' })
    expect(ls[1]!.to.pending).toBeUndefined()
    m.release()
    await sleep(300)
    const g = await geoOf(id)
    expect(g.geo).toEqual(before.geo)
    expect(g.epoch).toBe(before.epoch)
    expect(await trustedNow()).toBe(true)
    expect((await ground()).cover.visible).toBe(false)
    expect(await coverChanges(since)).toEqual([])
    expect((await layoutOf(id, since)).every((l) => l.to.layout === 'full')).toBe(true)
  })

  it('a superseded navigation: the newer one commits full, uncovered on its answer; the older one\'s end never takes the newer\'s pending', async () => {
    const since = await mark()
    const commits = (await w.tab(id)).doc!.commits
    await execNow(id, `location.href = '/?slow=1'; 1`)
    await waitFor('the slow request held', async () => m.held() > 0)
    await execNow(id, `location.href = '/?n=2'; 1`)
    await w.until((x) => { const t = x.tabs.find((q) => q.id === id)!; return (t.doc?.commits ?? 0) > commits && !!t.doc?.lifted }, 10_000, 'the newer commit')
    // the older navigation's end reaches commitLayout before the newer one starts (its did-stop-loading, as the
    // renderer cancels its own navigation), so no abort ever takes the newer one's pending
    const order = await layoutOf(id, since)
    const starts = order.filter((l) => l.event === 'start')
    expect(starts).toHaveLength(2)
    expect(starts[1]!.to.pending!.gen).toBeGreaterThan(starts[0]!.to.pending!.gen)
    expect(order.slice(order.indexOf(starts[1]!)).map((l) => l.event)).toEqual(['start', 'commit', 'hello'])
    expect(order.find((l) => l.event === 'abort')!.from.pending!.gen).toBe(starts[0]!.to.pending!.gen)
    await uncovered(id)
    m.release()
    const ls = await layoutOf(id, since)
    const commit = ls.find((l) => l.event === 'commit')!
    expect(commit.to.layout).toBe('full')
    expect((await geoOf(id)).geo).toEqual({ layout: 'full', htmlFullscreen: false, inset: 44 })
    const cov = (await coverChanges(since)).find((x) => x.changes.some((ch) => ch.key === 'cover' && ch.visible === true))!
    expect(cov.turn).toBeLessThanOrEqual(commit.turn)
  })

  it('a refused reload: the page holds its beforeunload - no geometry change, trust and the cover as they were', async () => {
    // Playwright answers a page's beforeunload itself unless someone listens (and fails: Electron shows none); the
    // refusal is the page's and main's (will-prevent-unload), as test/prod/guard.test.ts's cases have it
    const listen = () => {}
    const pages = w.run.pw!.windows()
    for (const p of pages) p.on('dialog', listen)
    try {
      await exec(id, `addEventListener('beforeunload', (e) => { if (window.__mayLeave) return; e.preventDefault(); e.returnValue = '' }); document.body.click(); 1`, true)
      const before = await geoOf(id)
      const since = await mark()
      expect(await w.run.call('guard', { id, action: { kind: 'reload' } })).toBe('refused')
      await sleep(300)
      // no navigation started: nothing reached commitLayout, the epoch and the cover are the ones before
      expect((await navOf(id, since)).filter((e) => e.startsWith('adapter:'))).toEqual([])
      expect(await layoutOf(id, since)).toEqual([])
      expect(await geoOf(id)).toEqual(before)
      expect(await trustedNow()).toBe(true)
      expect((await ground()).cover.visible).toBe(false)
      expect(await coverChanges(since)).toEqual([])
      // the page lets go: its next reload goes through
      await exec(id, `window.__mayLeave = true; 1`)
      await reloadInto(id, null)
      await uncovered(id)
    } finally { for (const p of pages) p.off('dialog', listen) }
  })

  it('a document navigation through a redirect: covered at its commit, full, a fresh epoch uncovered on its answer', async () => {
    const e0 = (await geoOf(id)).epoch!
    const since = await mark()
    const commits = (await w.tab(id)).doc!.commits
    await execNow(id, `location.href = '/?redirect=1'; 1`)
    await w.until((x) => { const t = x.tabs.find((q) => q.id === id)!; return (t.doc?.commits ?? 0) > commits && !!t.doc?.lifted }, 10_000, 'the redirected commit')
    const g = await uncovered(id)
    expect((await navOf(id, since)).filter((e) => e.startsWith('adapter:'))).toEqual(['adapter:start', 'adapter:redirect', 'adapter:response', 'adapter:commit'])
    expect((await w.tab(id)).doc!.url).toMatch(/\/index\.html\?redirected=1$/)
    const ls = await layoutOf(id, since)
    expect(ls.map((l) => l.event)).toEqual(['start', 'commit', 'hello'])
    expect(ls.map((l) => l.to.layout)).toEqual(['full', 'full', 'full'])
    const commit = ls.find((l) => l.event === 'commit')!
    const cov = (await coverChanges(since)).find((x) => x.changes.some((ch) => ch.key === 'cover' && ch.visible === true))!
    expect(cov.turn).toBeLessThanOrEqual(commit.turn)
    expect(g.tabs.find((t) => t.id === id)!.epoch!).toBeGreaterThan(e0)
  })

  /** the page's own reload (A1's resume reload), waited for: the new document committed and lifted */
  async function ownReload(): Promise<number> {
    const before = (await w.tab(id)).doc!.commits
    const since = await mark()
    await execNow(id, 'location.reload(); 1')
    await w.until((x) => { const t = x.tabs.find((q) => q.id === id)!; return (t.doc?.commits ?? 0) > before && !!t.doc?.lifted }, 10_000, 'its own reload')
    return since
  }
  /** the cover shown in a turn, and the turn: the first such change since a mark */
  const coveredAt = async (since: number) => (await coverChanges(since)).find((x) => x.changes.some((ch) => ch.key === 'cover' && ch.visible === true))
  const registryTurn = async (since: number) => (await w.log('registry', since)).find((l) => l.data.tab === id)

  it('a new instance after the commit, with inset: untrusted and covered in the registry\'s turn, its layout kept full; its own reload lands full and is uncovered', async () => {
    const since = await mark()
    await m.rebind(['bridge', 'inset'])
    await waitFor('untrusted', async () => !(await trustedNow()))
    const g = await geoOf(id)
    expect([g.geo.layout, g.seeThrough]).toEqual(['full', false])
    expect((await ground()).cover.visible).toBe(true)
    const reg = (await registryTurn(since))!
    expect((await coveredAt(since))!.turn).toBe(reg.turn)
    expect((await layoutOf(id, since)).filter((l) => l.to.layout !== 'full')).toEqual([])
    const s2 = await ownReload()
    await uncovered(id)
    expect((await layoutOf(id, s2)).find((l) => l.event === 'commit')!.to.layout).toBe('full')
    expect(await exec(id, 'window.marverApp.topInset')).toBe(44)
  })

  it('a new instance after the commit, without inset (0.27.1): covered, kept full until its own reload, which lands below, told 0', async () => {
    const since = await mark()
    await m.rebind(['bridge'])
    await waitFor('untrusted', async () => !(await trustedNow()))
    expect((await geoOf(id)).geo.layout).toBe('full')
    expect((await coveredAt(since))!.turn).toBe((await registryTurn(since))!.turn)
    const s2 = await ownReload()
    await waitFor('its hello', async () => (await geoOf(id)).geo.inset === 0)
    const ls = await layoutOf(id, s2)
    expect(ls.map((l) => [l.event, l.to.layout])).toEqual([['start', 'full'], ['commit', 'below'], ['hello', 'below']])
    expect(ls[0]!.to.pending!.layout).toBe('below')
    expect(await exec(id, 'JSON.stringify([window.marverApp.topInset, window.__ground.applied])')).toBe('[0,0]')
    expect((await bounds(`${id}:view`))!.bounds).toEqual(BELOW(await content()))
    expect((await ground()).cover.visible).toBe(true)
    // inset again (a 0.27.2 restart), and its own reload: back to full, uncovered
    await m.rebind(['bridge', 'inset'])
    await ownReload()
    await uncovered(id)
  })

  for (const [inset, via] of [[true, 'reload'], [false, 'reload'], [true, 'coop']] as const) {
    const how = via === 'coop' ? 'a cross-process load (COOP: a new renderer, the old frame alive)' : 'a same-process reload'
    it(`a new instance ${inset ? 'with' : 'without'} inset before the commit of ${how}: the pending turned below, the document lands below - never told 44 - and its own reload is ${inset ? 'full again' : 'below too'}`, async () => {
      m.mode.hold = true
      const before = (await w.tab(id)).doc!.commits
      const since = await mark()
      if (via === 'coop') await execNow(id, `location.href = '/?coop=1'; 1`)
      else await w.run.call('reloadPage', { target: id })
      await waitFor('the request held', async () => m.held() > 0)
      m.mode.hold = false
      await m.rebind(inset ? ['bridge', 'inset'] : ['bridge'])
      m.release()
      await w.until((x) => { const t = x.tabs.find((q) => q.id === id)!; return (t.doc?.commits ?? 0) > before && !!t.doc?.lifted }, 10_000, 'the commit under the new instance')
      await waitFor('its hello', async () => (await geoOf(id)).geo.inset !== undefined)
      // the registry's change turns the pending below (the old instance gone, or the tab rebound: whichever main hears
      // first; the other changes nothing), so mv:doc says 0 whether it comes before main has handled the commit or after
      const ls = await layoutOf(id, since)
      expect(ls.map((l) => l.event === 'gone' ? 'rebind' : l.event)).toEqual(['start', 'rebind', 'commit', 'hello'])
      expect(ls[1]!.to.pending).toMatchObject({ gen: ls[0]!.to.pending!.gen, layout: 'below' })
      expect(ls[1]!.to.layout).toBe('full')                 // the retained document's committed layout, kept
      expect(ls.find((l) => l.event === 'commit')!.to.layout).toBe('below')
      // every mv:doc of the tab since the rebind told 0. Which came first, it or main's handling of the commit, is the
      // load's to decide and is reported, not asserted: on this Mac every variant, the cross-process one too, had main
      // handle the commit first (24 Oct), so the order #26 warns about - mv:doc first - is proven by unit ground 6b
      const all = await w.log(undefined, since)
      const at = all.indexOf(all.find((l) => l.topic === 'layout' && l.data.tab === id && l.data.event !== 'start')!)
      const docs = all.slice(at).filter((l) => l.topic === 'bridge' && l.data.event === 'doc' && l.data.tab === id)
      expect(docs.map((l) => l.data.inset)).toEqual([0])
      const commitAt = all.findIndex((l) => l.topic === 'layout' && l.data.tab === id && l.data.event === 'commit')
      process.stdout.write(`before-the-commit (${via}): mv:doc ${all.indexOf(docs[0]!) < commitAt ? 'before' : 'after'} main handled the commit, told ${docs[0]!.data.inset}\n`)
      // trusted under the new instance, below the strip, told 0 (mv:doc answered for where it lands), covered
      expect(await trustedNow()).toBe(true)
      expect(await exec(id, 'JSON.stringify([window.marverApp.topInset, window.__ground.applied])')).toBe('[0,0]')
      expect((await bounds(`${id}:view`))!.bounds).toEqual(BELOW(await content()))
      expect((await ground()).cover.visible).toBe(true)
      const s2 = await ownReload()
      await waitFor('its hello', async () => (await geoOf(id)).geo.inset !== undefined)
      expect((await layoutOf(id, s2)).find((l) => l.event === 'commit')!.to.layout).toBe(inset ? 'full' : 'below')
      if (!inset) {
        expect((await ground()).cover.visible).toBe(true)
        await m.rebind(['bridge', 'inset'])
        await ownReload()
      }
      await uncovered(id)
      expect((await bounds(`${id}:view`))!.bounds).toEqual(FULL(await content()))
      if (via === 'coop') {
        // back to the plain document the next cases start from
        const c = (await w.tab(id)).doc!.commits
        await execNow(id, `location.href = '/'; 1`)
        await w.until((x) => { const t = x.tabs.find((q) => q.id === id)!; return (t.doc?.commits ?? 0) > c && !!t.doc?.lifted }, 10_000, 'back to /')
        await uncovered(id)
      }
    })
  }

  it('a new instance taking the port after the proof\'s headers and before the commit: unattributed, below and untrusted beneath its tab page, then reloaded full', async () => {
    await w.run.call('trust:hold-proved', { on: true })
    const before = (await w.tab(id)).doc!.commits
    const since = await mark()
    try {
      await w.run.call('reloadPage', { target: id })
      await waitFor('the proof held', async () => (await lines('proof', since)).some((l) => l.data.event === 'held'))
      await m.rebind(['bridge', 'inset'])
    } finally { await w.run.call('trust:hold-proved', { on: false }) }
    // the commit under the instance that left: unattributed (nav.ts), so below; the tab reloads it at once (A2.3)
    await waitFor('the unattributed commit', async () => (await navOf(id, since)).includes('adapter:commit'))
    const commit = (await lines('nav', since)).find((l) => l.data.event === 'adapter:commit' && l.data.wc === (0 as unknown) || (l.data.event === 'adapter:commit'))!
    expect(commit.data.attributed).toBe(false)
    const lay = (await layoutOf(id, since)).find((l) => l.event === 'commit')!
    expect(lay.to.layout).toBe('below')
    // in the commit's turn the view is hidden beneath its tab page, or never shown: no compose shows it uncovered
    for (const x of await composes(since)) {
      if (x.turn < lay.turn) continue
      if (x.changes.some((ch) => ch.key === `${id}:view` && ch.op === 'visible' && ch.visible === true)) expect(x.cover).toBe(true)
    }
    // then the reload the tab makes at once: proved under the new instance, full, uncovered
    await w.until((x) => { const t = x.tabs.find((q) => q.id === id)!; return (t.doc?.commits ?? 0) > before + 1 && !!t.doc?.lifted && !!t.doc.trusted }, 10_000, 'the reload under the new instance')
    await uncovered(id)
    expect((await geoOf(id)).geo).toEqual({ layout: 'full', htmlFullscreen: false, inset: 44 })
  })

  for (const kind of ['wrong-key', 'other-instance'] as const) {
    it(`a ${kind === 'wrong-key' ? 'failed proof' : 'instance mismatch'} from a full, uncovered page: the tab page full and the view hidden in the failure's turn; below only with an error page committed`, async () => {
      const since = await mark()
      m.mode.proof = kind
      try {
        await w.run.call('reloadPage', { target: id })
        await waitFor('the failure', async () => (await lines('fail', since)).some((l) => l.data.tab === id))
      } finally { m.mode.proof = 'valid' }
      const fail = (await lines('fail', since)).find((l) => l.data.tab === id)!
      expect(fail.data.why).toBe('unverified')
      const f = (await layoutOf(id, since)).find((l) => l.event === 'fail')!
      expect(f.to.pending).toBeUndefined()
      expect(f.to.layout).toBe(fail.data.errorPage ? 'below' : 'full')
      // the tab page shows, full, the view hidden beneath it, in one turn; the cover hidden over the page
      await waitFor('its tab page', async () => (await bounds(`${id}:page`))?.visible)
      const turn = (await composes(since)).find((x) => x.changes.some((ch) => ch.key === `${id}:view` && ch.op === 'visible' && ch.visible === false))!
      expect(turn.changes.some((ch) => ch.key === `${id}:page` && ch.op === 'visible' && ch.visible === true)).toBe(true)
      expect((await bounds(`${id}:page`))!.bounds).toEqual(FULL(await content()))
      expect(await trustedNow()).toBe(false)
      // Try Again (the tab page's action) proves it again: full, uncovered
      await w.run.call('command', { cmd: 'reload' })
      await waitFor('trusted again', async () => trustedNow())
      await uncovered(id)
      expect((await geoOf(id)).geo).toEqual({ layout: 'full', htmlFullscreen: false, inset: 44 })
    })
  }
})

describe('HTML fullscreen in play mode (A2.10\'s (A3) cases, design-ground §6.3 #8)', () => {
  let a = ''
  let b = ''
  beforeAll(async () => {
    ;({ id: b } = await canvas(19, 'FS other'))
    ;({ id: a } = await canvas(20, 'FS'))
    for (const id of [b, a]) { await w.run.call('activate', { id }); await lifted(id); await uncovered(id) }
  })
  const fsElement = () => exec<string | null>(a, `document.fullscreenElement ? (document.fullscreenElement.id || document.fullscreenElement.tagName) : null`)
  const winNow = () => w.run.call<{ bounds: { x: number; y: number; width: number; height: number }; fullScreen: boolean }>('window')

  it('play mode (an element\'s fullscreen): below and covered; a resize keeps it below; switched away and back, still fullscreen and below; leaving, full, covered, then a fresh epoch', async () => {
    const win0 = await winNow()
    const since = await mark()
    await exec(a, `(() => { const d = document.createElement('div'); d.id = 'stage'; d.style.background = '#123'; document.body.append(d); return d.requestFullscreen().then(() => true) })()`, true)
    await waitFor('fullscreen', async () => (await geoOf(a)).geo.htmlFullscreen)
    expect(await fsElement()).toBe('stage')
    const enter = (await layoutOf(a, since)).find((l) => l.event === 'html-fullscreen')!
    const moved = (await composes(since)).find((x) => x.turn === enter.turn && x.changes.some((ch) => ch.key === `${a}:view` && ch.op === 'bounds'))!
    expect(moved.cover).toBe(true)
    expect(moved.changes.find((ch) => ch.key === `${a}:view`)!.rect!.y).toBe(44)
    // a resize meanwhile: still below, still covered, the window never in full screen
    const c = await content()
    await w.run.call('resize', { width: c.width - 60, height: c.height - 30 })
    await sleep(300)
    expect((await bounds(`${a}:view`))!.bounds).toEqual(BELOW(await content()))
    expect((await ground()).cover.visible).toBe(true)
    expect((await winNow()).fullScreen).toBe(false)
    // away and back: still the element's fullscreen, still below and covered
    await w.run.call('activate', { id: b })
    await uncovered(b)
    await w.run.call('activate', { id: a })
    await sleep(300)
    expect(await fsElement()).toBe('stage')
    expect((await geoOf(a)).geo.htmlFullscreen).toBe(true)
    expect((await bounds(`${a}:view`))!.bounds).toEqual(BELOW(await content()))
    expect((await ground()).cover.visible).toBe(true)
    // leaving: full, covered in its turn, then uncovered by a fresh epoch
    const e1 = (await geoOf(a)).epoch!
    const s2 = await mark()
    await exec(a, 'document.exitFullscreen().then(() => true)')
    await uncovered(a)
    const leave = (await layoutOf(a, s2)).find((l) => l.event === 'html-fullscreen')!
    const back = (await composes(s2)).find((x) => x.turn === leave.turn && x.changes.some((ch) => ch.key === `${a}:view` && ch.op === 'bounds'))!
    expect(back.cover).toBe(true)
    expect((await bounds(`${a}:view`))!.bounds).toEqual(FULL(await content()))
    expect((await geoOf(a)).epoch!).toBeGreaterThan(e1)
    await w.run.call('resize', { width: c.width, height: c.height })
    await uncovered(a)
    expect((await winNow()).bounds.width).toBe(win0.bounds.width)
  })
})

describe('stalled renderers: covering never waits on one, uncovering waits for the canvas (A2.10\'s stalled cases, A3.8 #30)', () => {
  let a = ''
  let below = ''
  beforeAll(async () => {
    ;({ id: a } = await canvas(14, 'Stall see-through'))
    ;({ id: below } = await canvas(15, 'Stall below', { features: ['bridge'] }))
    for (const id of [below, a]) { await w.run.call('activate', { id }); await lifted(id) }
    await uncovered(a)
  })

  it('the strip\'s main thread stalled: rapid switches still cover in the turn of every view change, and lift only on an answer', async () => {
    // the strip busy for good (its renderer ended after), as a hung strip page would be
    await exec('strip', `setTimeout(() => { for (;;) {} }, 0); 1`)
    await sleep(100)
    const since = await mark()
    for (let i = 0; i < 20; i++) { await w.run.call('activate', { id: i % 2 ? a : below }); await sleep(30) }
    await uncovered(a)
    const ok = new Set((await presents(since)).filter((p) => p.op === 'answer').map((p) => p.turn))
    let shows = 0
    for (const x of await composes(since)) {
      if (x.changes.some((ch) => (ch.key === `${a}:view` || ch.key === `${below}:view`) && ch.op === 'visible' && ch.visible === true)) { shows++; expect(x.cover).toBe(true) }
      if (x.changes.some((ch) => ch.key === 'cover' && ch.visible === false)) expect(ok.has(x.turn)).toBe(true)
    }
    expect(shows).toBeGreaterThanOrEqual(19)
    // the strip comes back (window.ts reloads it), and says ready again
    const s2 = await mark()
    await w.run.call('crash', { target: 'strip' })
    await waitFor('the strip back', async () => (await w.log('page', s2)).some((l) => l.data.ready === 'strip'))
  })

  it('the capture matrix\'s heartbeat: a 1 px animation in the strip\'s corner that keeps changing with the strip\'s main thread stalled (its compositor\'s), on and off by its hook', async () => {
    const anim = () => exec<string>('strip', `getComputedStyle(document.documentElement, '::after').animationName`)
    expect(await anim()).toBe('none')
    expect(await w.run.call('ground:heartbeat', { on: true })).toBe(true)
    expect(await anim()).toBe('mv-beat')
    expect(await exec<string>('strip', `(() => { const s = getComputedStyle(document.documentElement, '::after'); return [s.width, s.height, s.position, s.animationTimingFunction].join(' ') })()`)).toBe('1px 1px fixed linear')
    // three reads of the corner as the strip's compositor drew it, 150 ms apart: at least two differ (an alternating
    // ramp can meet itself once across a turn, never three times)
    const beats = async () => { const px: string[] = []; for (let i = 0; i < 3; i++) { px.push(JSON.stringify(await w.run.call('ground:beat-pixel'))); if (i < 2) await sleep(150) } return px }
    const running = await beats()
    expect(new Set(running).size, running.join(' ')).toBeGreaterThan(1)
    // the strip's main thread busy for good: the corner still changes - the animation is the compositor's (A3.8 #29)
    await exec('strip', `setTimeout(() => { for (;;) {} }, 0); 1`)
    await sleep(200)
    const stalled = await beats()
    expect(new Set(stalled).size, stalled.join(' ')).toBeGreaterThan(1)
    expect(await w.run.call('silent', { target: 'strip', ms: 300 })).toBe(true)   // and it was stalled throughout
    // the strip comes back (window.ts reloads it) with no heartbeat: the inserted sheet went with its document
    const s2 = await mark()
    await w.run.call('crash', { target: 'strip' })
    await waitFor('the strip back', async () => (await w.log('page', s2)).some((l) => l.data.ready === 'strip'))
    expect(await anim()).toBe('none')
    expect(await w.run.call('ground:heartbeat', { on: true })).toBe(true)
    expect(await anim()).toBe('mv-beat')
    await w.run.call('ground:heartbeat', { on: false })
    // the sheet goes on the renderer's own time (removeInsertedCSS answers before it is applied)
    await waitFor('the heartbeat gone', async () => (await anim()) === 'none', 3000)
  })

  it('the strip\'s empty part, read from the strip itself (A3.8 #34): right of the tabs, left of the pill, the heartbeat\'s corner', async () => {
    const r = await w.run.call<{ width: number; height: number; tabsRight: number; pillLeft: number; empty: { x: number; y: number; width: number; height: number }[]; heartbeat: { x: number; y: number } }>('ground:strip-regions')
    const c = await content()
    expect([r.width, r.height]).toEqual([c.width, 44])
    const tabs = JSON.parse(await exec<string>('strip', `JSON.stringify([...document.querySelectorAll('#tabs > *')].map((e) => e.getBoundingClientRect().right))`)) as number[]
    expect(tabs.length).toBeGreaterThan(2)
    expect(r.tabsRight).toBeGreaterThanOrEqual(Math.max(...tabs))
    expect(r.empty).toHaveLength(1)
    expect(r.empty[0]).toMatchObject({ y: 0, height: 44 })
    expect(r.empty[0]!.x).toBeGreaterThan(Math.max(...tabs))
    expect(r.empty[0]!.x + r.empty[0]!.width).toBeLessThanOrEqual(r.pillLeft)
    expect(r.heartbeat).toEqual({ x: c.width - 1, y: 43, width: 1, height: 1 })
  })

  it('the canvas stalled: a resize covers at once, and no answer lifts it until the page runs again; shown while stalled, the same', async () => {
    const c = await content()
    let since = await mark()
    await exec(a, `setTimeout(() => { const e = Date.now() + 2000; while (Date.now() < e) {} }, 0); 1`)
    await sleep(100)
    await w.run.call('resize', { width: c.width - 80, height: c.height })
    await sleep(1500)
    expect((await ground()).cover.visible).toBe(true)
    expect((await presents(since, a)).filter((p) => p.op === 'answer')).toEqual([])
    await uncovered(a, 6000)
    expect((await presents(since, a)).filter((p) => p.op === 'answer').length).toBeGreaterThan(0)
    // switched away, the page stalls; shown again while it is: covered until it answers, after the stall
    await w.run.call('activate', { id: below })
    await exec(a, `setTimeout(() => { const e = Date.now() + 1500; while (Date.now() < e) {} }, 0); 1`)
    await sleep(100)
    since = await mark()
    await w.run.call('activate', { id: a })
    await sleep(1000)
    expect((await ground()).cover.visible).toBe(true)
    expect((await presents(since, a)).filter((p) => p.op === 'answer')).toEqual([])
    await uncovered(a, 6000)
    await w.run.call('resize', { width: c.width, height: c.height })
    await uncovered(a)
  })
})

describe('the scroll edge\'s cost switch (A3.8 #51)', () => {
  it('ground:inset-off: the next document is told 0, applies no inset and is moved below; off again, full', async () => {
    const { id } = await canvas(16, 'Switch')
    await w.run.call('activate', { id })
    await lifted(id)
    await uncovered(id)
    await w.run.call('ground:inset-off', { on: true })
    try {
      await reloadInto(id, null)
      await waitFor('its hello', async () => (await geoOf(id)).geo.inset === 0)
      expect(await exec(id, 'JSON.stringify([window.marverApp.topInset, window.__ground.applied])')).toBe('[0,0]')
      expect((await bounds(`${id}:view`))!.bounds).toEqual(BELOW(await content()))
    } finally { await w.run.call('ground:inset-off', { on: false }) }
    await reloadInto(id, null)
    await uncovered(id)
    expect((await bounds(`${id}:view`))!.bounds).toEqual(FULL(await content()))
  })
})

describe('the mv:doc trace (A3.8 #26)', () => {
  it('100 loads - same-process reloads, cross-process loads with the old frame alive, crash reloads - and every document is told 44', { timeout: 240_000 }, async () => {
    // the navigations alternate Cross-Origin-Opener-Policy: same-origin, so each swaps browsing instance: a new
    // renderer process commits while the old frame is still current - the frame swap #26's sender rule is for
    const m = await mutable(12, 'Trace')
    const id = m.id
    await w.run.call('activate', { id })
    await lifted(id)
    await uncovered(id)
    const mainPid = async () => (await w.run.call<{ pid: number; main: boolean }[]>('frames', { target: id })).find((f) => f.main)!.pid
    const told: { i: number; kind: string; inset: number; pid: number; was: number; crashes: number }[] = []
    let navs = 0
    for (let i = 0; i < 100; i++) {
      const kind = i % 5 === 4 ? 'crash' : i % 5 === 2 ? 'navigate' : 'reload'
      const t0 = await w.tab(id)
      const before = t0.doc?.commits ?? 0
      const was = await mainPid()
      if (kind === 'reload') await w.run.call('reloadPage', { target: id })
      else if (kind === 'navigate') await execNow(id, `location.href = '/?n=${i}${navs++ % 2 === 0 ? '&coop=1' : ''}'; 1`)
      else {
        await w.run.call('crash', { target: id })
        // counted first (a latch from an earlier crash is still on), then: the first crash in a minute reloads by
        // itself; a later one latches, and the person's reload brings it back
        await w.until((x) => x.tabs.find((y) => y.id === id)!.crash.count > t0.crash.count, 10_000, 'the crash counted')
        const t = await w.until((x) => { const q = x.tabs.find((y) => y.id === id)!; return (q.crash.latched && q.view === 'crashed') || ((q.doc?.commits ?? 0) > before + 1 && !!q.doc?.lifted) }, 10_000, 'the crash reload')
        if (t.tabs.find((y) => y.id === id)!.view === 'crashed') await w.run.call('command', { cmd: 'reload' })
      }
      await w.until((x) => { const q = x.tabs.find((y) => y.id === id)!; return (q.doc?.commits ?? 0) > before && !!q.doc?.lifted && !!q.doc.trusted }, 10_000, `load ${i} (${kind})`)
      await waitFor(`load ${i}'s script`, async () => (await exec<boolean>(id, '!!window.__ground')))
      const inset = await exec<number>(id, 'window.marverApp.topInset')
      told.push({ i, kind, inset, pid: await mainPid(), was, crashes: (await w.tab(id)).crash.count })
    }
    const wrong = told.filter((x) => x.inset !== 44)
    const pids = new Set(told.map((x) => x.pid))
    const navigations = told.filter((x) => x.kind === 'navigate')
    const swapped = navigations.filter((x) => x.pid !== x.was && x.crashes === told[told.indexOf(x) - 1]!.crashes)
    process.stdout.write(`mv:doc trace: ${told.length} loads (${told.filter((x) => x.kind === 'reload').length} reloads, ${navigations.length} cross-process navigations - ${swapped.length} to a new renderer with no crash -, ${told.filter((x) => x.kind === 'crash').length} crash reloads) in ${pids.size} renderer processes; told 44: ${told.length - wrong.length}\n`)
    expect(wrong).toEqual([])
    // every navigation committed in a renderer other than the one it left, with no crash: the old frame was alive
    expect(swapped).toHaveLength(20)
    // the reloads stayed in their renderer
    for (const x of told.filter((y) => y.kind === 'reload')) expect(x.pid, `reload ${x.i}`).toBe(x.was)
    await m.close()
  })
})

describe('the app\'s own pages at the full height (A3.8 #32)', () => {
  it('Home and Settings: full bounds, the cover hidden, nothing scrolls but the area 44 px down, focus targets below it', async () => {
    for (const page of ['home', 'settings'] as const) {
      if (page === 'settings') await w.run.call('settings:open')
      else await w.run.call('activate', { id: 'home' })
      await waitFor(`${page} shown`, async () => (await bounds(`${page}:view`))?.visible)
      await waitFor('the cover hidden', async () => !(await ground()).cover.visible)
      expect((await bounds(`${page}:view`))!.bounds).toEqual(FULL(await content()))
      const dom = await exec<string>(page, `JSON.stringify((() => {
        const box = document.querySelector('.${page}').getBoundingClientRect()
        const first = [...document.querySelectorAll('button, input, select, a[href], [tabindex]:not([tabindex="-1"])')].find((e) => e.offsetParent !== null)
        return { top: box.top, body: getComputedStyle(document.body).overflow, html: getComputedStyle(document.documentElement).overflow, first: first ? first.getBoundingClientRect().top : null,
          bg: getComputedStyle(document.body).backgroundImage.includes('radial-gradient'), h: innerHeight }
      })())`)
      const d = JSON.parse(dom) as { top: number; body: string; html: string; first: number | null; bg: boolean; h: number }
      expect([d.top, d.body, d.html, d.bg, d.h]).toEqual([44, 'hidden', 'hidden', true, (await content()).height])
      expect(d.first).not.toBeNull()
      expect(d.first!).toBeGreaterThanOrEqual(44)
      expect(await stripDots()).toBe(false)   // the page's own dots show under the strip, never the strip's over them
    }
  })

  it('a tab page: full bounds, the cover hidden, its words centred 44 px down', async () => {
    const { id } = await canvas(9, 'Not a canvas', { proof: 'invalid' })
    await w.run.call('activate', { id })
    await waitFor('its tab page', async () => (await bounds(`${id}:page`))?.visible)
    await waitFor('the cover hidden', async () => !(await ground()).cover.visible)
    expect((await bounds(`${id}:page`))!.bounds).toEqual(FULL(await content()))
    expect(await exec<number>(`${id}:page`, `document.querySelector('.tp').getBoundingClientRect().top`)).toBe(44)
  })
})

describe('the GPU process killed (A2.10, A3.8 #27, r2 #2)', () => {
  it('once, for real: Electron\'s child-process-gone covers every view in its turn, and a newer epoch answered after the replacement lifts it', { timeout: 60_000 }, async () => {
    const { id } = await canvas(17, 'GPU')
    await w.run.call('activate', { id })
    await lifted(id)
    const g0 = await uncovered(id)
    const e0 = g0.tabs.find((t) => t.id === id)!.epoch!
    const since = await mark()
    const was = await w.run.call<{ pid: number; born: number } | null>('ground:gpu-kill')
    expect(was).not.toBeNull()
    // views.ts heard it from Electron (no hook called gpuGone), and covered in that turn
    const gone = await waitFor('child-process-gone', async () => (await lines('gpu', since)).find((l) => 'gone' in l.data))
    expect(gone.data.gone).toBe('killed')
    const cov = (await coverChanges(since)).find((x) => x.changes.some((ch) => ch.key === 'cover' && ch.visible === true))!
    expect(cov.turn).toBe(gone.turn)
    // a replacement GPU process, then the page answers a newer epoch - made after the loss - and the cover lifts
    const g = await uncovered(id, 30_000)
    const e = g.tabs.find((t) => t.id === id)!.epoch!
    expect(e).toBeGreaterThan(e0)
    const rec = (await lines('cover-record', since)).map((l) => l.data).find((d) => d.tab === id && d.epoch === e)
    expect(rec).toMatchObject({ cause: 'gpu', outcome: 'uncovered' })
    // the replacement's first identity read is the loss already counted, not a second one (A3.8 r3 #1)
    expect((await lines('gpu', since)).filter((l) => 'changed' in l.data)).toEqual([])
  })
})

describe('the gate shut: no cover chosen (A3.8 #3)', () => {
  it('an inset canvas stays below the strip, covered, its document told 0', async () => {
    const shut = await launchWindow('pw', { extraEnv: { MARVER_APP_FAKE_TRUST: '0' } })
    try {
      const st = await shut.run.call<GroundState>('ground:state')
      expect(st.ground).toBe(false)
      const fake = await startFakeCanvas({ home: shut.env.home, slotBase: shut.slotBase, slot: 11, name: 'Shut', features: ['bridge', 'inset'], script: GROUND_SHELL })
      fakes.push(fake)
      await fake.ready
      const s = await shut.until((x) => x.tabs.some((t) => t.reg?.instance === fake.instance && t.reg.state === 'ready'), 10_000, 'the tab')
      const id = s.tabs.find((t) => t.reg?.instance === fake.instance)!.id
      await shut.run.call('activate', { id })
      await shut.until((x) => !!x.tabs.find((q) => q.id === id)?.doc?.lifted, 10_000, 'lifted')
      await sleep(500)
      const c = (await shut.run.call<{ content: { width: number; height: number } }>('window')).content
      expect((await shut.views()).find((v) => v.key === `${id}:view`)!.bounds).toEqual(BELOW(c))
      expect((await shut.views()).find((v) => v.key === 'cover')!.visible).toBe(true)
      expect(await shut.run.call('exec', { target: id, js: 'JSON.stringify([window.marverApp.topInset, window.__ground.applied, window.__ground.asks.length])' })).toBe('[0,0,0]')
      // app 0.1's look under the tabs: the plain cover, the strip's still dots over it (A3.8 #3)
      expect(await shut.run.call('exec', { target: 'strip', js: `document.body.classList.contains('dots')` })).toBe(true)
      await shut.run.call('activate', { id: 'home' })
      await shut.until(() => true, 100)
      const off = Date.now() + 5000
      while (await shut.run.call('exec', { target: 'strip', js: `document.body.classList.contains('dots')` }) && Date.now() < off) await sleep(40)
      expect(await shut.run.call('exec', { target: 'strip', js: `document.body.classList.contains('dots')` })).toBe(false)
    } finally { await shut.close() }
  })
})

describe('the window\'s own full screen, and HTML fullscreen inside it (A2.10\'s (A3) cases, design-ground §6.3 #8): a launch of its own', () => {
  // Its own launch, so no page of this window has been in HTML fullscreen before. In the shared one, after other
  // views' HTML fullscreen entered and left in the windowed window, a document's requestFullscreen() in the
  // full-screen window never settled under this launch: Electron still sends enter-html-full-screen, so main keeps
  // the view below and covered (the safe side), but the page is never fullscreen, exitFullscreen() rejects
  // "Document not active", and no leave-html-full-screen comes. Seen on 24 Oct under Playwright's launch only; not
  // narrowed further, nor tried under the production switches.
  let main: WindowRun
  let a = ''
  beforeAll(async () => {
    main = w
    w = await launchWindow('pw', { extraEnv: { MARVER_APP_FAKE_TRUST: '0', MARVER_APP_GROUND: '1' } })
    ;({ id: a } = await canvas(13, 'Full screen'))
    await w.run.call('activate', { id: a })
    await lifted(a)
    await uncovered(a)
  })
  afterAll(async () => { await w?.close(); w = main })
  const winNow = () => w.run.call<{ bounds: { x: number; y: number; width: number; height: number }; fullScreen: boolean }>('window')

  it('the window\'s own full screen, in and out: the view full at each size, covered with its bounds, uncovered on an answer at that size; HTML fullscreen inside it changes neither the window\'s size nor its state', { timeout: 120_000 }, async () => {
    const before = await content()
    let since = await mark()
    await w.run.call('fullscreen', { on: true })
    await waitFor('full screen', async () => (await winNow()).fullScreen, 15_000)
    await sleep(800)   // the transition's last resize
    let g = await uncovered(a, 15_000)
    const fsSize = await content()
    expect((await bounds(`${a}:view`))!.bounds).toEqual(FULL(fsSize))
    const asks = (await presents(since, a)).filter((p) => p.op === 'ask')
    expect(asks.at(-1)).toMatchObject({ w: fsSize.width, h: fsSize.height })
    for (const x of await composes(since)) if (x.changes.some((ch) => ch.key === `${a}:view` && ch.op === 'bounds')) expect(x.cover).toBe(true)
    // HTML fullscreen inside the full-screen window: the window's size and state never change; below and covered
    const win1 = await winNow()
    since = await mark()
    await exec(a, 'window.__fs = "pending"; document.documentElement.requestFullscreen().then(() => { window.__fs = "ok" }, (e) => { window.__fs = String(e) }); true', true)
    await waitFor('HTML fullscreen', async () => (await geoOf(a)).geo.htmlFullscreen)
    await waitFor('the page in fullscreen', async () => (await execNow<string>(a, 'window.__fs')) === 'ok')
    expect(await winNow()).toMatchObject({ bounds: win1.bounds, fullScreen: true })
    expect((await bounds(`${a}:view`))!.bounds).toEqual(BELOW(fsSize))
    expect((await ground()).cover.visible).toBe(true)
    const enter = (await layoutOf(a, since)).find((l) => l.event === 'html-fullscreen')!
    expect((await composes(since)).find((x) => x.turn === enter.turn && x.changes.some((ch) => ch.key === `${a}:view` && ch.op === 'bounds'))!.cover).toBe(true)
    await execNow(a, 'document.exitFullscreen().catch(() => {}); true')
    g = await uncovered(a)
    expect(await winNow()).toMatchObject({ bounds: win1.bounds, fullScreen: true })
    expect((await bounds(`${a}:view`))!.bounds).toEqual(FULL(fsSize))
    // out of full screen: back at the windowed size, covered with its bounds, uncovered on its answer
    since = await mark()
    await w.run.call('fullscreen', { on: false })
    await waitFor('windowed', async () => !(await winNow()).fullScreen, 15_000)
    await sleep(800)
    g = await uncovered(a, 15_000)
    const after = await content()
    expect([after.width, after.height]).toEqual([before.width, before.height])
    expect((await bounds(`${a}:view`))!.bounds).toEqual(FULL(after))
    for (const x of await composes(since)) if (x.changes.some((ch) => ch.key === `${a}:view` && ch.op === 'bounds')) expect(x.cover).toBe(true)
    expect((await presents(since, a)).filter((p) => p.op === 'ask').at(-1)).toMatchObject({ w: after.width, h: after.height })
    void g
  })
})
