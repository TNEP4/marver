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
 * And with the gate shut (no cover chosen, as in a release before S15): an inset canvas stays below, told 0.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'
import { startFakeCanvas, type FakeCanvas, type FakeOptions } from '../harness/fake-canvas.ts'
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
const mark = async () => (await w.log()).length
const lines = async (topic: string, since: number) => w.log(topic, since)
const presents = async (since: number, tab?: string) => (await lines('present', since)).map((l) => ({ ...(l.data as unknown as Present), turn: l.turn })).filter((p) => !tab || p.tab === tab)
const composes = async (since: number) => (await lines('compose', since)).map((l) => ({ turn: l.turn, cover: (l.data.cover as { visible: boolean }).visible, changes: l.data.changes as Change[] }))
const coverChanges = async (since: number) => (await composes(since)).filter((c) => c.changes.some((x) => x.key === 'cover'))

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

  it('the capture matrix\'s heartbeat: a 1 px compositor animation in the strip\'s corner, on and off by its hook', async () => {
    const anim = () => exec<string>('strip', `getComputedStyle(document.documentElement, '::after').animationName`)
    expect(await anim()).toBe('none')
    expect(await w.run.call('ground:heartbeat', { on: true })).toBe(true)
    expect(await anim()).toBe('mv-beat')
    expect(await exec<string>('strip', `(() => { const s = getComputedStyle(document.documentElement, '::after'); return [s.width, s.height, s.position, s.animationTimingFunction].join(' ') })()`)).toBe('1px 1px fixed linear')
    await w.run.call('ground:heartbeat', { on: false })
    // the sheet goes on the renderer's own time (removeInsertedCSS answers before it is applied)
    await waitFor('the heartbeat gone', async () => (await anim()) === 'none', 3000)
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
  it('100 loads - reloads, navigations the page starts, crash reloads in a new renderer - and every document is told 44', { timeout: 240_000 }, async () => {
    const { fake, id } = await canvas(12, 'Trace')
    await w.run.call('activate', { id })
    await lifted(id)
    await uncovered(id)
    const told: { i: number; kind: string; inset: number; pid: number }[] = []
    for (let i = 0; i < 100; i++) {
      const kind = i % 5 === 4 ? 'crash' : i % 5 === 2 ? 'navigate' : 'reload'
      const before = (await w.tab(id)).doc?.commits ?? 0
      if (kind === 'reload') await w.run.call('reloadPage', { target: id })
      else if (kind === 'navigate') await exec(id, `location.href = '/?n=${i}'; 1`)
      else {
        await w.run.call('crash', { target: id })
        // the first crash in a minute reloads by itself; a later one latches, and the person's reload brings it back
        const t = await w.until((x) => { const q = x.tabs.find((y) => y.id === id)!; return q.crash.latched || ((q.doc?.commits ?? 0) > before + 1 && !!q.doc?.lifted) }, 10_000, 'the crash reload')
        if (t.tabs.find((y) => y.id === id)!.crash.latched) await w.run.call('command', { cmd: 'reload' })
      }
      await w.until((x) => { const q = x.tabs.find((y) => y.id === id)!; return (q.doc?.commits ?? 0) > before && !!q.doc?.lifted && !!q.doc.trusted }, 10_000, `load ${i} (${kind})`)
      await waitFor(`load ${i}'s script`, async () => (await exec<boolean>(id, '!!window.__ground')))
      const inset = await exec<number>(id, 'window.marverApp.topInset')
      const frames = await w.run.call<{ pid: number; main: boolean }[]>('frames', { target: id })
      told.push({ i, kind, inset, pid: frames.find((f) => f.main)!.pid })
    }
    const wrong = told.filter((x) => x.inset !== 44)
    const pids = new Set(told.map((x) => x.pid))
    process.stdout.write(`mv:doc trace: ${told.length} loads (${told.filter((x) => x.kind === 'reload').length} reloads, ${told.filter((x) => x.kind === 'navigate').length} page navigations, ${told.filter((x) => x.kind === 'crash').length} crash reloads) in ${pids.size} renderer processes; told 44: ${told.length - wrong.length}\n`)
    expect(wrong).toEqual([])
    expect(pids.size).toBeGreaterThan(10)   // the crash reloads each came up in a renderer of their own
    await fake.close()
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
    } finally { await shut.close() }
  })
})
