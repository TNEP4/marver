/**
 * Unloading hidden tabs under pressure (spec 28 A2.6, A3.8 #39-#45; A3.7's production-switch cases), against real
 * webContents with Chromium's own beforeunload, with the fake trust handing the app fake canvases. The pressure is a
 * sample the case describes (`memory:tick`): the rule is under test here, not the sampler - its own samples join on
 * the recorder's branch (`memory:tick { real: true }`). Timings shortened where only the rule is under test
 * (A2.14 #27): 300 ms hidden, a 2 s cooldown, a 1.5 s act.
 *
 * A page playing sound and DevTools opened are Chromium's events emitted on the view's own webContents
 * (`page:event`): a case never plays a sound or opens a window on the Mac it runs on.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { hits, launchWindow, MAY_LEAVE, REFUSE_UNLOAD, scripted, sleep, type LogLine, type State, type TabDump, type WindowRun } from '../harness/window.ts'
import type { FakeOptions } from '../harness/fake-canvas.ts'

const TIMINGS = { unloadMinHiddenMs: 300, unloadCooldownMs: 2000, unloadActMs: 1500, unloadEffectMs: 200 }
const HIDDEN = TIMINGS.unloadMinHiddenMs + 150
const extraEnv = { MARVER_APP_TIMINGS: JSON.stringify(TIMINGS) }

/** A page whose beforeunload works for `ms` and lets it go (no refusal): a close that takes that long. */
const SLOW_UNLOAD = (ms: number) => `addEventListener('beforeunload', function () { try { navigator.sendBeacon('/__mv/test/bu') } catch (x) {} var e = Date.now() + ${ms}; while (Date.now() < e) {} }); say('script');`

let w: WindowRun
beforeAll(async () => { w = await launchWindow('prod', { extraEnv }) })
afterAll(async () => { await w?.close() })

let port = 0
/** A fake canvas shown once (so its document lifted and is kept), and idle and clean unless `idle` is false. */
async function shown(run: WindowRun, o: Partial<FakeOptions> = {}, idle = true) {
  port += 1
  const c = await run.canvas({ port: run.slotBase + 40 + port, name: `Canvas ${port}`, ...o })
  await run.run.call('activate', { id: c.id })
  await run.until((x) => { const t = x.tabs.find((q) => q.id === c.id)!; return !!t.doc?.lifted && t.retained }, 10_000, `${c.id} lifted`)
  if (o.script?.includes("say('script')")) await scripted(c.fake)
  if (idle) await run.report(c.id, { unsaved: false })
  return c
}
const tab = (s: State, id: string): TabDump => s.tabs.find((t) => t.id === id)!
const tick = (o: Record<string, unknown>, run = w) => run.run.call<{ candidates: { id: string }[]; unload: { id: string; reason: string }[] }>('memory:tick', o)
const mark = async (run = w) => (await run.run.call<unknown[]>('log')).length
const since = (n: number, topic?: string, run = w): Promise<LogLine[]> => run.log(topic, n)
const records = async (n: number, kind: string, tabId?: string) => (await since(n, 'record')).filter((l) => l.data.kind === kind && (!tabId || l.data.tab === tabId)).map((l) => l.data)
const unloaded = (id: string, run = w) => run.until((s) => tab(s, id).view === 'unloaded' && !tab(s, id).hasView, 10_000, `${id} unloaded`)
const why = async (id: string) => (await w.run.call<{ tabs: { id: string; why: string | null }[] }>('memory:state')).tabs.find((t) => t.id === id)?.why

/** What the person would see move: nothing may, from an unload (A3.8 #39). */
async function still() {
  const s = await w.state()
  const win = await w.run.call<{ visible: boolean; focused: boolean }>('window')
  const sheets = (await w.run.call<{ shown: unknown[] }>('sheets')).shown.length
  return { active: s.active, pill: s.pill, visible: win.visible, sheets, focus: JSON.stringify(s.focus) }
}

/** Every canvas tab closed, Home active, the pressure episode over: each case starts from the same place. */
afterEach(async () => {
  await w.run.call('memory:totalmem', { mb: null })
  await w.run.call('files.set', { file: 'config', key: 'unloadUnderPressure', value: true })
  await tick({ level: 1 })
  await w.run.call('activate', { id: 'home' })
  for (const t of (await w.state()).tabs.filter((x) => x.kind === 'local' && x.open)) {
    if (t.hasView) await w.run.call('exec', { target: t.id, js: MAY_LEAVE }).catch(() => {})
    if (t.doc?.trusted) await w.report(t.id, { unsaved: false })
    await w.run.call('close', { id: t.id })
  }
})

describe('the policy on a real window (A3.8 #41)', () => {
  it('warn: the least recently shown idle hidden tab only, then the next after the cooldown - nothing asks and nothing moves', async () => {
    const a = await shown(w)
    const b = await shown(w)
    const c = await shown(w)
    await sleep(HIDDEN)
    const n = await mark()
    const before = await still()
    const kept = { b: (await w.tab(b.id)).wcId, c: (await w.tab(c.id)).wcId }
    expect((await tick({ level: 2 })).unload).toEqual([{ id: a.id, reason: 'warn' }])
    const s = await unloaded(a.id)
    expect(tab(s, a.id)).toMatchObject({ view: 'unloaded', state: 'unloaded', wcId: null, retained: false })
    expect(tab(s, a.id).unload).toMatchObject({ phase: 'unloaded', reason: 'warn' })
    expect(tab(s, b.id).wcId).toBe(kept.b)
    expect(tab(s, c.id).wcId).toBe(kept.c)
    // within the cooldown: nothing
    expect((await tick({ level: 2 })).unload).toEqual([])
    await sleep(TIMINGS.unloadCooldownMs + 100)
    expect((await tick({ level: 2 })).unload).toEqual([{ id: b.id, reason: 'warn' }])
    await unloaded(b.id)
    expect((await w.tab(c.id)).wcId).toBe(kept.c)
    expect(await still()).toEqual(before)
    // the records: the act's start with its figures, its own gone (ours), done
    expect((await records(n, 'unload', a.id)).map((r) => r.phase)).toEqual(['start', 'done'])
    expect(await records(n, 'gone', a.id)).toEqual([expect.objectContaining({ ours: true, source: 'unload', reason: 'unload' })])
    const acts = (await since(n, 'act')).filter((l) => l.data.tab === a.id && l.data.answer)
    expect(acts.map((l) => [l.data.action, l.data.answer, l.data.why])).toEqual([['unload', 'done', 'destroyed']])
  })

  it('critical: every hidden tab but the active one, in one tick - and the active one kept with the window hidden too', async () => {
    const a = await shown(w)
    const b = await shown(w)
    const c = await shown(w)
    await sleep(HIDDEN)
    expect((await tick({ level: 4 })).unload.map((u) => u.id)).toEqual([a.id, b.id])
    await unloaded(a.id)
    await unloaded(b.id)
    await w.run.call('hide')
    try {
      await sleep(HIDDEN)
      expect((await tick({ level: 4 })).unload).toEqual([])
      expect(await why(c.id)).toBe('active')
      expect((await w.tab(c.id)).view).toBe('live')
    } finally { await w.run.call('show', { focus: false }) }
  })

  it('half of RAM: canvas renderers strictly past half of the Mac\'s memory unload one, as warn', async () => {
    await sleep(TIMINGS.unloadCooldownMs)   // the cooldown of an earlier case's soft unload
    const a = await shown(w)
    await shown(w)
    await sleep(HIDDEN)
    await w.run.call('memory:totalmem', { mb: 1000 })
    const n = await mark()
    expect((await tick({ level: 1, canvasMB: 500 })).unload).toEqual([])
    expect((await tick({ level: 1, canvasMB: 501 })).unload).toEqual([{ id: a.id, reason: 'half-ram' }])
    await unloaded(a.id)
    expect((await since(n, 'memory')).at(-1)?.data).toMatchObject({ canvasMB: 501, totalMB: 1000, reason: 'half-ram' })
  })

  it('off: nothing unloads at critical; turned on again, the next tick does', async () => {
    expect(await w.run.call('files.set', { file: 'config', key: 'unloadUnderPressure', value: false })).toMatchObject({ ok: true })
    const a = await shown(w)
    await shown(w)
    await sleep(HIDDEN)
    expect(await tick({ level: 4 })).toMatchObject({ candidates: [], unload: [] })
    await sleep(300)
    expect((await w.tab(a.id)).view).toBe('live')
    await w.run.call('files.set', { file: 'config', key: 'unloadUnderPressure', value: true })
    expect((await tick({ level: 4 })).unload.map((u) => u.id)).toEqual([a.id])
    await unloaded(a.id)
  })
})

describe('who is never unloaded (A3.8 #40)', () => {
  it('a busy one - a Jam session, the microphone, an agent - and one with unsaved work: never, each skip said once in the episode', async () => {
    const b = await shown(w)
    await shown(w)
    await sleep(HIDDEN)
    const n = await mark()
    for (const x of ['jam-session', 'microphone', 'agent']) {
      await w.report(b.id, { unsaved: false, why: [x] })
      expect((await tick({ level: 4 })).unload).toEqual([])
    }
    for (const x of ['capture-recording', 'capture-unsent', 'board-unsaved', 'heights', 'typing']) {
      await w.report(b.id, { unsaved: true, why: [x] })
      expect((await tick({ level: 4 })).unload).toEqual([])
    }
    await sleep(300)
    expect((await w.tab(b.id)).view).toBe('live')
    expect((await records(n, 'unload-skip', b.id)).map((r) => [r.reason, r.why])).toEqual([['critical', 'busy'], ['critical', 'unsaved']])
    expect((await since(n, 'act')).filter((l) => l.data.tab === b.id)).toEqual([])
  })

  it('an unknown or a stale one: a page that never reports, a 0.27.0 canvas, a canvas stopped with its page kept', async () => {
    const quiet = await shown(w, {}, false)
    const old = await shown(w, { features: [], version: '0.27.0' }, false)
    const stale = await shown(w)
    await w.run.call('fake:gone', { instance: stale.fake.instance })
    await shown(w)
    await sleep(HIDDEN)
    expect((await tick({ level: 4 })).unload).toEqual([])
    expect([await why(quiet.id), await why(old.id), await why(stale.id)]).toEqual(['unknown', 'no-bridge', 'stale'])
    await sleep(300)
    for (const id of [quiet.id, old.id, stale.id]) expect((await w.tab(id)).view).toBe('live')
  })

  it('one playing sound, and one with DevTools open: kept until each ends', async () => {
    const a = await shown(w)
    const d = await shown(w)
    await shown(w)
    await sleep(HIDDEN)
    await w.run.call('page:event', { target: a.id, event: 'audible' })
    await w.run.call('page:event', { target: d.id, event: 'devtools-opened' })
    expect((await tick({ level: 4 })).unload).toEqual([])
    expect([await why(a.id), await why(d.id)]).toEqual(['audible', 'devtools'])
    await w.run.call('page:event', { target: a.id, event: 'silent' })
    await w.run.call('page:event', { target: d.id, event: 'devtools-closed' })
    expect((await tick({ level: 4 })).unload.map((u) => u.id).sort()).toEqual([a.id, d.id].sort())
    await unloaded(a.id)
    await unloaded(d.id)
  })

  it('a page that refuses its beforeunload: kept as it was, never asked again for that document - its next document is asked', async () => {
    const r = await shown(w, { script: REFUSE_UNLOAD })
    await shown(w)
    await sleep(HIDDEN)
    const n = await mark()
    const wcId = (await w.tab(r.id)).wcId
    const before = await still()
    expect((await tick({ level: 4 })).unload).toEqual([{ id: r.id, reason: 'critical' }])
    await w.until((s) => tab(s, r.id).unloadRefused != null, 10_000, 'the refusal')
    const t = await w.tab(r.id)
    expect(t).toMatchObject({ view: 'live', wcId, unload: null, unloadRefused: t.doc!.commits })
    expect(hits(r.fake, '/__mv/test/beforeunload')).toBe(1)
    const acts = (await since(n, 'act')).filter((l) => l.data.tab === r.id && l.data.answer)
    expect(acts.map((l) => [l.data.answer, l.data.why])).toEqual([['refused', 'will-prevent-unload']])
    expect(await why(r.id)).toBe('refused-before')
    expect((await tick({ level: 4 })).unload).toEqual([])
    expect(await still()).toEqual(before)
    // the page reloads itself: a new document, heard again, is asked again
    const commits = t.doc!.commits
    await w.run.call('exec', { target: r.id, js: MAY_LEAVE })
    await w.run.call('reloadPage', { target: r.id })
    await w.until((s) => (tab(s, r.id).doc?.commits ?? 0) > commits && !!tab(s, r.id).doc?.lifted, 10_000, 'the page\'s own reload')
    await scripted(r.fake, 2)
    await w.report(r.id, { unsaved: false })
    expect(await why(r.id)).toBe(null)
    expect((await tick({ level: 4 })).unload).toEqual([{ id: r.id, reason: 'critical' }])
    await w.until((s) => tab(s, r.id).unloadRefused === tab(s, r.id).doc?.commits, 10_000, 'the second refusal')
    expect(hits(r.fake, '/__mv/test/beforeunload')).toBe(2)
  })
})

describe('while it closes, and after (A3.8 #42-#44, r1 #2, r2 #4, r3 #3)', () => {
  it('activated while it closes: queued under the reopening page, no shown, its view never shown; at destroyed one reopen', async () => {
    const s = await shown(w, { script: SLOW_UNLOAD(800) })
    await shown(w)
    await sleep(HIDDEN)
    const n = await mark()
    expect((await tick({ level: 4 })).unload).toEqual([{ id: s.id, reason: 'critical' }])
    await w.run.call('activate', { id: s.id })
    const mid = await w.tab(s.id)
    expect(mid.unload).toMatchObject({ phase: 'closing' })
    expect(mid.unload!.activatedAt).toBeGreaterThan(0)
    expect((await w.run.call<{ body: { page: string; cameraKept: boolean } }>('page', { tab: s.id })).body).toMatchObject({ page: 'reopening', cameraKept: true })
    await w.until((x) => tab(x, s.id).unload == null && !!tab(x, s.id).doc?.lifted && tab(x, s.id).hasView, 10_000, 'the reopen lifted')
    const log = await since(n)
    const gone = log.findIndex((l) => l.topic === 'gone' && l.data.tab === s.id)
    expect(gone).toBeGreaterThan(-1)
    // no shown while it closed; the view never visible before it was destroyed
    expect(log.slice(0, gone).filter((l) => l.topic === 'fake-trust' && l.data.tab === s.id && l.data.appState === 'shown')).toEqual([])
    expect(log.slice(0, gone).some((l) => l.topic === 'compose' && (l.data.changes as { key: string; visible?: boolean }[]).some((c) => c.key === `${s.id}:view` && c.visible === true))).toBe(false)
    expect(log.filter((l) => l.topic === 'unload' && l.data.tab === s.id && l.data.reopen === 'queued')).toHaveLength(1)
    expect(log.filter((l) => l.topic === 'load' && l.data.tab === s.id)).toHaveLength(1)
    expect(log.some((l) => l.topic === 'fake-trust' && l.data.reopenNext === s.id)).toBe(true)
    // its reopen record, at its hello: the wait for destroyed in it, no time unloaded
    await w.report(s.id, null, { hello: { version: '0.27.2', board: null, page: 'PAGE_reopen0001' } })
    const [rec] = await records(n, 'reopen', s.id)
    expect(rec).toMatchObject({ unloadedForMs: 0 })
    expect(rec!.activateToLiftMs as number).toBeGreaterThan(400)
  })

  it('the reopen: its saved board, mv:doc\'s reopen armed, the reopening page and its words, its record at the hello', async () => {
    const a = await shown(w, { name: 'Tidewell' })
    await w.run.call('exec', { target: a.id, js: `location.hash = '#/b/x'; 1` })
    await w.until((s) => tab(s, a.id).path === '/#/b/x', 5000, 'the board in the path')
    await shown(w)
    await sleep(HIDDEN)
    expect((await tick({ level: 4 })).unload.map((u) => u.id)).toEqual([a.id])
    await unloaded(a.id)
    const n = await mark()
    await w.run.call('fake:session', { hold: true })   // the reopen waits on its partition: the page shows meanwhile
    try {
      await w.run.call('activate', { id: a.id })
      await sleep(120)
      expect((await w.run.call<{ body: { page: string; cameraKept: boolean } }>('page', { tab: a.id })).body).toMatchObject({ page: 'reopening', cameraKept: true })
      // the fake trust registers no app page with the bridge: its app:ready is the hook's, once the page has loaded
      // (the 400 ms before its words are the page's own: test/pw/tabpage.test.ts)
      const loaded = Date.now() + 5000
      while (Date.now() < loaded && !(await w.run.call('exec', { target: `${a.id}:page`, js: `!!document.getElementById('content') && document.readyState === 'complete'` }).catch(() => false))) await sleep(50)
      await w.run.call('pageReady', { target: `${a.id}:page` })
      const title = () => w.run.call<string | null>('exec', { target: `${a.id}:page`, js: `document.getElementById('tp-title')?.textContent ?? null` })
      const end = Date.now() + 3000
      let words: string | null = null
      while (Date.now() < end && !(words = await title())) await sleep(50)
      expect(words).toBe('Reopening Tidewell')
      expect(await w.run.call('exec', { target: `${a.id}:page`, js: `document.querySelector('.tp-body')?.textContent` })).toMatch(/^Unloaded at \d\d:\d\d to free memory\. Its board and camera come back as you left them\.$/)
    } finally { await w.run.call('fake:session', { hold: false }) }
    await w.until((s) => !!tab(s, a.id).doc?.lifted && tab(s, a.id).unload == null, 10_000, 'the reopen lifted')
    expect((await w.tab(a.id)).path).toBe('/#/b/x')
    const log = await since(n)
    expect(log.filter((l) => l.topic === 'load' && l.data.tab === a.id).map((l) => l.data.url)).toEqual([`${a.fake.origin}/#/b/x`])
    expect(log.some((l) => l.topic === 'fake-trust' && l.data.reopenNext === a.id)).toBe(true)
    await w.report(a.id, null, { hello: { version: '0.27.2', board: 'x', page: 'PAGE_reopen0002' } })
    const [rec] = await records(n, 'reopen', a.id)
    expect(rec!.activateToLiftMs as number).toBeGreaterThanOrEqual(400)
    expect(rec!.unloadedForMs as number).toBeGreaterThan(0)
  })

  it('a renderer its unload ends counts nothing; reopened, a crash is its first, reloaded at once; a second within 60 s latches', async () => {
    const a = await shown(w)
    await shown(w)
    await sleep(HIDDEN)
    const n = await mark()
    await tick({ level: 4 })
    await unloaded(a.id)
    expect((await w.tab(a.id)).crash).toMatchObject({ count: 0, latched: false })
    expect((await since(n, 'gone')).filter((l) => l.data.tab === a.id).every((l) => l.data.ours === true)).toBe(true)
    await w.run.call('activate', { id: a.id })
    await w.until((s) => !!tab(s, a.id).doc?.lifted, 10_000, 'reopened')
    await w.run.call('crash', { target: a.id })
    await w.until((s) => tab(s, a.id).crash.count === 1 && !!tab(s, a.id).doc?.lifted, 10_000, 'the automatic reload')
    expect((await w.tab(a.id)).crash.latched).toBe(false)
    await w.run.call('crash', { target: a.id })
    await w.until((s) => tab(s, a.id).crash.latched, 10_000, 'latched')
  })

  it('stopped while it closes: unloaded, its page stopped when shown; a new instance of its canvas elsewhere reopens it there, board only', async () => {
    const a = await shown(w, { script: SLOW_UNLOAD(800) })
    await shown(w)
    await sleep(HIDDEN)
    await tick({ level: 4 })
    await w.until((s) => tab(s, a.id).unload?.phase === 'closing', 5000, 'closing')
    await w.run.call('fake:gone', { instance: a.fake.instance })
    const s = await unloaded(a.id)
    expect(tab(s, a.id).reg?.state).toBe('gone')
    await w.run.call('activate', { id: a.id })
    await w.until((x) => tab(x, a.id).pageView, 5000, 'its tab page')
    expect((await w.run.call<{ body: { page: string; retained: boolean } }>('page', { tab: a.id })).body).toMatchObject({ page: 'stopped', retained: false })
    await w.run.call('fake:session', { hold: true })
    let again: Awaited<ReturnType<WindowRun['canvas']>>
    try {
      port += 1
      again = await w.canvas({ port: w.slotBase + 40 + port, name: 'Canvas again', ws: a.fake.ws })
      expect(again.id).toBe(a.id)   // the same tab, rebound
      await w.until((x) => tab(x, a.id).unload?.phase === 'reopening', 5000, 'reopening')
      expect((await w.run.call<{ body: { page: string; cameraKept: boolean } }>('page', { tab: a.id })).body).toMatchObject({ page: 'reopening', cameraKept: false })
    } finally { await w.run.call('fake:session', { hold: false }) }
    await w.until((x) => !!tab(x, a.id).doc?.lifted && tab(x, a.id).reg?.origin === again!.fake.origin, 10_000, 'reopened on the new origin')
  })
})

describe('a close that outlives unloadActMs (A3.8 #39, r1 #2)', () => {
  // unloadActMs under Chromium's own beforeunload timeout (about 1 s here, which ends such a close by itself - A3.8
  // #40's veto, said plainly), so main's own end is what this case sees
  it('unsure: main ends it itself, the tab unloaded; a load queued behind it runs only after destroyed, on its own URL', async () => {
    const u = await launchWindow('prod', { extraEnv: { MARVER_APP_TIMINGS: JSON.stringify({ ...TIMINGS, unloadActMs: 300 }) } })
    try {
      const s = await shown(u, { script: SLOW_UNLOAD(5000) })
      await shown(u)
      await sleep(HIDDEN)
      const n = await mark(u)
      await tick({ level: 4 }, u)
      const queued = u.run.call('guard', { id: s.id, action: { kind: 'load', url: `${s.fake.origin}/#/b/q` } })
      const at = Date.now()
      // answered only once the unload's close has ended - main ended it, the page still in its 5 s beforeunload
      expect(await queued).toBe('done')
      expect(Date.now() - at).toBeLessThan(3000)
      const lines = (await since(n, 'record', u)).filter((l) => l.data.kind === 'unload' && l.data.tab === s.id)
      expect(lines.map((l) => l.data.phase)).toEqual(['start', 'unsure', 'done'])
      const ms = Number(BigInt(lines[1]!.t) - BigInt(lines[0]!.t)) / 1e6
      expect(ms).toBeGreaterThanOrEqual(250)   // unsure at unloadActMs from the act
      const log = await since(n, undefined, u)
      const gone = log.findIndex((l) => l.topic === 'gone' && l.data.tab === s.id)
      const load = log.findIndex((l) => l.topic === 'act' && l.data.tab === s.id && l.data.action === 'load')
      expect(gone).toBeGreaterThan(-1)
      expect(load).toBeGreaterThan(gone)
      expect(log[load]!.data).toMatchObject({ noView: true, loads: true, path: '/#/b/q' })
      await u.until((x) => !!tab(x, s.id).doc?.lifted && tab(x, s.id).path === '/#/b/q', 10_000, 'the link loaded')
      expect((await u.tab(s.id)).unload).toBe(null)   // a link, not the reopen
    } finally { await u.close() }
  })
})

describe('a quit during an unload (A3.8 #42)', () => {
  it('waits for it and goes on: the app exits 0, never refused as busy', async () => {
    const q = await launchWindow('prod', { extraEnv })
    try {
      const s = await shown(q, { script: SLOW_UNLOAD(800) })
      await shown(q)
      await sleep(HIDDEN)
      await tick({ level: 4 }, q)
      await q.until((x) => tab(x, s.id).unload?.phase === 'closing', 5000, 'closing')
      expect(await q.run.call('guardAll', { action: { kind: 'quit' } })).toBe('done')
      expect((await q.tab(s.id)).view).toBe('unloaded')
      expect((await q.log('guard')).filter((l) => l.data.busy)).toEqual([])
      expect((await q.log('guard')).find((l) => l.data.all === 'quit')?.data.tabs).not.toContain(s.id)
      await q.run.call('command', { cmd: 'quit' })
    } finally {
      expect(await q.close()).toBe(0)
    }
  })
})
