/**
 * Unloading hidden tabs under pressure (spec 28 A2.6, A3.8 #39-#45; A3.7's production-switch cases), against real
 * webContents with Chromium's own beforeunload, with the fake trust handing the app fake canvases. The pressure is a
 * sample the case describes (`memory:tick`): the rule is under test here, not the sampler - its own samples join on
 * the recorder's branch (`memory:tick { real: true }`). Timings shortened where only the rule is under test
 * (A2.14 #27): 300 ms hidden, a 2 s cooldown, a 1.5 s act.
 *
 * A page playing sound and DevTools opened are Chromium's events emitted on the view's own webContents
 * (`page:event`): a case never plays a sound or opens a window on the Mac it runs on. `mv:doc`'s reopen flag is the
 * fake trust's model of the bridge's: `fake-trust { doc, reopen }` is what each document on the tab's origin took.
 */
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { hits, launchWindow, MAY_LEAVE, REFUSE_UNLOAD, scripted, sleep, type LogLine, type State, type TabDump, type WindowRun } from '../harness/window.ts'
import type { FakeCanvas, FakeOptions } from '../harness/fake-canvas.ts'

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
/** the time between two journal lines, ms (their `t` is process.hrtime) */
const msBetween = (a: LogLine, b: LogLine) => Number(BigInt(b.t) - BigInt(a.t)) / 1e6
/** Home's link field, as home.ts hands a checked link to the tabs (`LinkPorts.open`) */
const openLink = (f: FakeCanvas, rest: string, run = w) => run.run.call('openInTab', { entry: { state: 'ready', origin: f.origin, port: f.port, ws: f.ws, name: 'Linked' }, url: `${f.origin}${rest}`, rest })
/**
 * config.json's unloadUnderPressure, as a person or an agent writes the file. Settings shows its row from the build
 * whose STAGE is A3, which the integration sets once the recorder's sampler is in.
 */
async function unloading(on: boolean, run = w) {
  const p = join(run.env.home, 'config.json')
  writeFileSync(`${p}.tmp`, JSON.stringify({ unloadUnderPressure: on }))
  renameSync(`${p}.tmp`, p)
  await run.run.call('files.reread')
  expect((await run.run.call<{ config: { unloadUnderPressure: boolean } }>('files.values')).config.unloadUnderPressure).toBe(on)
}
const tick = (o: Record<string, unknown>, run = w) => run.run.call<{ candidates: { id: string }[]; unload: { id: string; reason: string }[] }>('memory:tick', o)
const mark = async (run = w) => (await run.run.call<unknown[]>('log')).length
const since = (n: number, topic?: string, run = w): Promise<LogLine[]> => run.log(topic, n)
const records = async (n: number, kind: string, tabId?: string) => (await since(n, 'record')).filter((l) => l.data.kind === kind && (!tabId || l.data.tab === tabId)).map((l) => l.data)
const unloaded = (id: string, run = w) => run.until((s) => tab(s, id).view === 'unloaded' && !tab(s, id).hasView, 10_000, `${id} unloaded`)
const why = async (id: string) => (await w.run.call<{ tabs: { id: string; why: string | null }[] }>('memory:state')).tabs.find((t) => t.id === id)?.why
/** what each document committed on the tab's origin since `n` took of mv:doc's reopen flag, in order (the fake trust's model) */
const docReopens = async (n: number, id: string, run = w) => (await since(n, 'fake-trust', run)).filter((l) => l.data.doc === id).map((l) => l.data.reopen)
const flags = async (n: number, id: string, key: 'reopenNext' | 'reopenCancel') => (await since(n, 'fake-trust')).filter((l) => l.data[key] === id)

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
  await unloading(true)
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

  it('critical: every hidden tab but the active one, in one tick - nothing asks and nothing moves - and the active one kept with the window hidden too', async () => {
    const a = await shown(w)
    const b = await shown(w)
    const c = await shown(w)
    await sleep(HIDDEN)
    const before = await still()
    expect((await tick({ level: 4 })).unload.map((u) => u.id)).toEqual([a.id, b.id])
    await unloaded(a.id)
    await unloaded(b.id)
    expect(await still()).toEqual(before)
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
    await unloading(false)
    const a = await shown(w)
    await shown(w)
    await sleep(HIDDEN)
    expect(await tick({ level: 4 })).toMatchObject({ candidates: [], unload: [] })
    await sleep(300)
    expect((await w.tab(a.id)).view).toBe('live')
    await unloading(true)
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
    const before = await still()
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
    expect(await still()).toEqual(before)
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
    expect(await docReopens(n, a.id)).toEqual([true])   // the reopened document took the camera
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
    // the unload's own gone, one: close() ends the renderer with no render-process-gone of its own
    expect((await since(n, 'gone')).filter((l) => l.data.tab === a.id).map((l) => l.data)).toEqual([expect.objectContaining({ ours: true, source: 'unload', reason: 'unload' })])
    await w.run.call('activate', { id: a.id })
    await w.until((s) => !!tab(s, a.id).doc?.lifted, 10_000, 'reopened')
    await w.run.call('crash', { target: a.id })
    await w.until((s) => tab(s, a.id).crash.count === 1 && !!tab(s, a.id).doc?.lifted, 10_000, 'the automatic reload')
    expect((await w.tab(a.id)).crash.latched).toBe(false)
    await w.run.call('crash', { target: a.id })
    await w.until((s) => tab(s, a.id).crash.latched, 10_000, 'latched')
  })

  it('its renderer gone while it closes: ours, counting nothing - one gone, never crashed, unloaded; the reopen works', async () => {
    const a = await shown(w, { script: SLOW_UNLOAD(800) })
    await shown(w)
    await sleep(HIDDEN)
    const n = await mark()
    expect((await tick({ level: 4 })).unload.map((u) => u.id)).toEqual([a.id])
    await w.until((s) => tab(s, a.id).unload?.phase === 'closing', 5000, 'closing')
    expect(await w.run.call('crash', { target: a.id })).toBe(true)
    await unloaded(a.id)
    const t = await w.tab(a.id)
    expect(t.crash).toMatchObject({ count: 0, latched: false })
    expect(t.state).toBe('unloaded')
    const log = await since(n)
    const mine = (topic: string) => log.filter((l) => l.topic === topic && l.data.tab === a.id)
    // the renderer's own gone is the unload's, handed to the recorder as ours; forgetCanvas writes none beside it
    expect(mine('gone').map((l) => l.data)).toEqual([expect.objectContaining({ ours: true, source: 'unload' })])
    expect(mine('gone')[0]!.data.reason).not.toBe('unload')
    expect((await records(n, 'gone', a.id))).toEqual([])
    expect(mine('crash')).toEqual([])
    expect(mine('layout').some((l) => l.data.event === 'renderer-gone')).toBe(false)
    expect(mine('unload').some((l) => l.data.endClose === 'gone')).toBe(true)
    expect((await records(n, 'unload', a.id)).map((r) => r.phase)).toEqual(['start', 'done'])
    await w.run.call('activate', { id: a.id })
    await w.until((s) => !!tab(s, a.id).doc?.lifted && tab(s, a.id).unload == null, 10_000, 'reopened')
    expect((await w.tab(a.id)).crash).toMatchObject({ count: 0, latched: false })
  })

  it('stopped while it closes: shown meanwhile, its stopped page stands over the view being closed; unloaded; a new instance of its canvas elsewhere reopens it there, board only', async () => {
    const a = await shown(w, { script: SLOW_UNLOAD(800) })
    await shown(w)
    await sleep(HIDDEN)
    const n = await mark()
    await tick({ level: 4 })
    await w.until((s) => tab(s, a.id).unload?.phase === 'closing', 5000, 'closing')
    await w.run.call('fake:gone', { instance: a.fake.instance })
    await w.run.call('activate', { id: a.id })
    const mid = await w.tab(a.id)
    expect(mid.unload?.phase).toBe('closing')
    expect((await w.run.call<{ body: { page: string; retained: boolean } }>('page', { tab: a.id })).body).toMatchObject({ page: 'stopped', retained: false })
    const s = await unloaded(a.id)
    expect(tab(s, a.id).reg?.state).toBe('gone')
    // the view being closed was never shown, the canvas gone or not
    const log = await since(n)
    const gone = log.findIndex((l) => l.topic === 'gone' && l.data.tab === a.id)
    expect(gone).toBeGreaterThan(-1)
    expect(log.slice(0, gone).some((l) => l.topic === 'compose' && (l.data.changes as { key: string; visible?: boolean }[]).some((c) => c.key === `${a.id}:view` && c.visible === true))).toBe(false)
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
    // camera storage is per origin: no mv:doc reopen there, so no camera that origin once kept overrides the path
    expect(await flags(n, a.id, 'reopenNext')).toEqual([])
    expect(await docReopens(n, a.id)).toEqual([false])
  })

  it('a new instance of its canvas elsewhere while it closes: no tab beside it - at destroyed the same tab is unloaded on the new instance, and reopens there, board only', async () => {
    const a = await shown(w, { script: SLOW_UNLOAD(800) })
    await w.run.call('exec', { target: a.id, js: `location.hash = '#/b/x'; 1` })
    await w.until((s) => tab(s, a.id).path === '/#/b/x', 5000, 'the board in the path')
    await shown(w)
    await sleep(HIDDEN)
    const n = await mark()
    await tick({ level: 4 })
    await w.until((s) => tab(s, a.id).unload?.phase === 'closing', 5000, 'closing')
    await w.run.call('fake:gone', { instance: a.fake.instance })
    port += 1
    const again = await w.canvas({ port: w.slotBase + 40 + port, name: 'Canvas moved', ws: a.fake.ws })
    expect(again.id).toBe(a.id)   // the same tab: it waited for the close, then rebound
    const log = await since(n)
    const waits = log.findIndex((l) => l.topic === 'registry' && l.data.tab === a.id && l.data.waits === again.fake.instance)
    const gone = log.findIndex((l) => l.topic === 'gone' && l.data.tab === a.id)
    expect(waits).toBeGreaterThan(-1)
    expect(gone).toBeGreaterThan(waits)   // it arrived while the close was outstanding
    const s = await unloaded(a.id)
    expect(tab(s, a.id).reg).toMatchObject({ instance: again.fake.instance, origin: again.fake.origin, state: 'ready' })
    expect(s.tabs.filter((t) => t.kind === 'local' && t.reg?.port === again.fake.port)).toHaveLength(1)
    await w.run.call('fake:session', { hold: true })
    try {
      await w.run.call('activate', { id: a.id })
      await w.until((x) => tab(x, a.id).unload?.phase === 'reopening', 5000, 'reopening')
      expect((await w.run.call<{ body: { page: string; cameraKept: boolean } }>('page', { tab: a.id })).body).toMatchObject({ page: 'reopening', cameraKept: false })
    } finally { await w.run.call('fake:session', { hold: false }) }
    await w.until((x) => !!tab(x, a.id).doc?.lifted && tab(x, a.id).path === '/#/b/x', 10_000, 'reopened on the new origin on its board')
    expect(await flags(n, a.id, 'reopenNext')).toEqual([])
    expect(await docReopens(n, a.id)).toEqual([false])
    // still the reopen: its record at the hello
    await w.report(a.id, null, { hello: { version: '0.27.2', board: 'x', page: 'PAGE_moved00002' } })
    expect(await records(n, 'reopen', a.id)).toHaveLength(1)
  })
})

describe('a link into an unloaded tab (A3.8 #42, r3 #3)', () => {
  it('opens on what it names: a plain load of the link - no reopen flag, no reopening page, no reopen record', async () => {
    const a = await shown(w)
    await w.run.call('exec', { target: a.id, js: `location.hash = '#/b/x'; 1` })
    await w.until((s) => tab(s, a.id).path === '/#/b/x', 5000, 'the board in the path')
    await shown(w)
    await sleep(HIDDEN)
    await tick({ level: 4 })
    await unloaded(a.id)
    const n = await mark()
    await w.run.call('fake:session', { hold: true })   // the load waits on its partition: the tab page shows meanwhile
    try {
      expect(await openLink(a.fake, '/#/b/y?n=f1')).toEqual({ ok: true })
      await sleep(120)
      expect((await w.tab(a.id)).unload).toBe(null)
      expect((await w.run.call<{ body: { page: string } } | null>('page', { tab: a.id }))?.body.page).toBe('starting')
    } finally { await w.run.call('fake:session', { hold: false }) }
    await w.until((s) => !!tab(s, a.id).doc?.lifted, 10_000, 'the link loaded')
    expect((await w.tab(a.id)).path).toBe('/#/b/y?n=f1')
    await w.report(a.id, null, { hello: { version: '0.27.2', board: 'y', page: 'PAGE_link000001' } })
    const log = await since(n)
    expect(log.filter((l) => l.topic === 'load' && l.data.tab === a.id).map((l) => l.data.url)).toEqual([`${a.fake.origin}/#/b/y?n=f1`])
    expect(await flags(n, a.id, 'reopenNext')).toEqual([])
    expect(await docReopens(n, a.id)).toEqual([false])
    expect(await records(n, 'reopen', a.id)).toEqual([])
  })

  it('a reopen that failed leaves mv:doc\'s flag armed (an error page never asks); a link then takes it back - its document gets no reopen', async () => {
    const down = { on: false }
    // unreachable on demand: the shell document's request dropped, as a canvas that stopped answering
    const a = await shown(w, { onRequest: (req) => { if (!down.on || !/^\/(index\.html)?(\?|$)/.test(req.url ?? '/')) return false; req.socket.destroy(); return true } })
    await shown(w)
    await sleep(HIDDEN)
    await tick({ level: 4 })
    await unloaded(a.id)
    const n = await mark()
    down.on = true
    try {
      await w.run.call('activate', { id: a.id })
      await w.until((s) => tab(s, a.id).fail?.why === 'unreachable', 10_000, 'the reopen failed')
      expect((await w.tab(a.id)).unload).toBe(null)   // a reopen that fails ends there, writing no reopen
      expect(await flags(n, a.id, 'reopenNext')).toHaveLength(1)
      // the link, its canvas still not answering: the flag goes with it, whatever loads next
      expect(await openLink(a.fake, '/#/b/y?n=f9')).toEqual({ ok: true })
    } finally { down.on = false }
    await w.until((s) => !!tab(s, a.id).doc?.lifted && tab(s, a.id).path === '/#/b/y?n=f9', 20_000, 'the link loaded')
    expect(await flags(n, a.id, 'reopenCancel')).toHaveLength(1)
    const docs = await docReopens(n, a.id)
    expect(docs.length).toBeGreaterThan(0)
    expect(docs.every((r) => r === false)).toBe(true)   // never the saved camera over the frame the link names
    expect(await records(n, 'reopen', a.id)).toEqual([])
  })

  it('a reopen whose first document is unattributed: mv:doc\'s flag is armed again for the reload, so the document that lifts has the camera', async () => {
    const a = await shown(w)
    await shown(w)
    await sleep(HIDDEN)
    await tick({ level: 4 })
    await unloaded(a.id)
    const n = await mark()
    await w.run.call('fake:mode', { tab: a.id, mode: 'unattributed' })
    try {
      await w.run.call('activate', { id: a.id })
      const end = Date.now() + 10_000
      while (!(await since(n, 'commit')).some((l) => l.data.tab === a.id && l.data.trusted === false)) {
        if (Date.now() > end) throw new Error('no unattributed commit')
        await sleep(50)
      }
    } finally { await w.run.call('fake:mode', { tab: a.id, mode: 'prove' }) }
    await w.until((s) => !!tab(s, a.id).doc?.lifted && tab(s, a.id).unload == null, 15_000, 'the reopen lifted')
    const docs = await docReopens(n, a.id)
    expect(docs.length).toBeGreaterThan(1)
    expect(docs.every((r) => r === true)).toBe(true)   // the unattributed one took the first; each reload had it again
  })

  it('a hash-only link while its close is outstanding waits for the close: never sent to the page being closed, loaded on its own URL after destroyed', async () => {
    const a = await shown(w, { script: SLOW_UNLOAD(800) })
    await shown(w)
    await sleep(HIDDEN)
    await tick({ level: 4 })
    await w.until((s) => tab(s, a.id).unload?.phase === 'closing', 5000, 'closing')
    const n = await mark()
    expect(await openLink(a.fake, '/#/b/z')).toEqual({ ok: true })
    await w.until((s) => !!tab(s, a.id).doc?.lifted && tab(s, a.id).hasView, 10_000, 'the link loaded')
    const log = await since(n)
    expect(log.filter((l) => l.topic === 'link' && l.data.tab === a.id)).toEqual([])
    const gone = log.findIndex((l) => l.topic === 'gone' && l.data.tab === a.id)
    const act = log.findIndex((l) => l.topic === 'act' && l.data.tab === a.id && l.data.action === 'load')
    expect(gone).toBeGreaterThan(-1)
    expect(act).toBeGreaterThan(gone)
    expect(log[act]!.data).toMatchObject({ noView: true, loads: true, path: '/#/b/z' })
    expect(log.filter((l) => l.topic === 'load' && l.data.tab === a.id).map((l) => l.data.url)).toEqual([`${a.fake.origin}/#/b/z`])
    expect(log.filter((l) => l.topic === 'fake-trust' && l.data.reopenNext === a.id)).toEqual([])
    const t = await w.tab(a.id)
    expect(t.unload).toBe(null)
    expect(t.path).toBe('/#/b/z')
  })
})

describe('a close that outlives unloadActMs (A3.8 #39, r1 #2)', () => {
  // unloadActMs (200 ms here) well under Chromium's own end of such a close (1.0 s after the act, measured by the
  // case below: A3.8 #40's veto), so main's own end is what this case sees, with room either side
  it('unsure: main ends it itself, the tab unloaded; a load queued behind it runs only after destroyed, on its own URL', async () => {
    const u = await launchWindow('prod', { extraEnv: { MARVER_APP_TIMINGS: JSON.stringify({ ...TIMINGS, unloadActMs: 200 }) } })
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
      const [start, unsure, done] = lines as [LogLine, LogLine, LogLine]
      expect(msBetween(start, unsure)).toBeGreaterThanOrEqual(150)   // unsure at unloadActMs from the act
      // main's own end, not Chromium's: destroyed follows main's plain close within a few tasks (about 210 ms from
      // the act), long before Chromium's own end at 1.0 s would have come - 400 ms of room either side of the bound
      expect(msBetween(unsure, done)).toBeLessThan(300)
      expect(msBetween(start, done)).toBeLessThan(600)
      const log = await since(n, undefined, u)
      const end = log.findIndex((l) => l.topic === 'unload' && l.data.tab === s.id && l.data.endClose === 'unsure')
      const destroyed = log.findIndex((l) => l.topic === 'act' && l.data.tab === s.id && l.data.action === 'unload' && l.data.why === 'destroyed')
      expect(end).toBeGreaterThan(-1)
      expect(destroyed).toBeGreaterThan(end)
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

describe('Chromium\'s own end of a close (A3.8 #40\'s veto)', () => {
  // the figure for "A3 as built": Chromium ends a close whose page has not answered its beforeunload 1.0 s after the
  // act (1002-1005 ms over six closes in two runs, 24 Oct, Electron 45) - a hidden page busy that long in its beforeunload is
  // closed without asking. With the shipped unloadActMs of 10 s, main's unsure only comes if Chromium never does
  it('main\'s unsure far off: a page busy in its beforeunload is closed by Chromium itself, asking nothing, within its own timeout', async () => {
    const c = await launchWindow('prod', { extraEnv: { MARVER_APP_TIMINGS: JSON.stringify({ ...TIMINGS, unloadActMs: 60_000 }) } })
    try {
      const ms: number[] = []
      for (let i = 0; i < 3; i++) {
        const s = await shown(c, { script: SLOW_UNLOAD(5000) })
        await c.run.call('activate', { id: 'home' })
        await sleep(HIDDEN)
        const n = await mark(c)
        expect((await tick({ level: 4 }, c)).unload.map((u) => u.id)).toEqual([s.id])
        await unloaded(s.id, c)
        const lines = (await since(n, 'record', c)).filter((l) => l.data.kind === 'unload' && l.data.tab === s.id)
        expect(lines.map((l) => l.data.phase)).toEqual(['start', 'done'])
        expect((await since(n, 'unload', c)).filter((l) => l.data.tab === s.id && (l.data.endClose || l.data.phase === 'unsure'))).toEqual([])
        expect(hits(s.fake, '/__mv/test/bu')).toBe(1)   // its beforeunload ran: Chromium asked, then ended the close itself
        ms.push(Math.round(msBetween(lines[0]!, lines[1]!)))
      }
      console.log(`Chromium ended each close ${ms.join(', ')} ms after the act`)
      // past the unsure case's 600 ms bound, so that case sees main's end and never this one
      for (const x of ms) { expect(x).toBeGreaterThanOrEqual(700); expect(x).toBeLessThan(3000) }
    } finally { await c.close() }
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

describe('a quit over a close that never ends (code review r2 #1)', () => {
  /** the sheet the app holds now, once there are `n` held */
  async function held(run: WindowRun, n = 1) {
    const end = Date.now() + 10_000
    for (;;) {
      const s = await run.run.call<{ shown: Record<string, unknown>[]; held: number }>('sheets')
      if (s.held >= n) return s.shown.at(-1)!
      if (Date.now() > end) throw new Error(`no held sheet: ${JSON.stringify(s).slice(0, 500)}`)
      await sleep(50)
    }
  }
  const quitLines = async (n: number, run: WindowRun) => (await since(n, 'quit', run)).map((l) => l.data)
  const phases = async (n: number, id: string, run: WindowRun) => (await since(n, 'record', run)).filter((l) => l.data.kind === 'unload' && l.data.tab === id).map((l) => l.data.phase)

  it('stuck at quitWaitMs, the tab named on a sheet: Keep Waiting keeps it owned and a later quit is heard; Force Quit Tab ends it - recorded forced, never done - and the quit goes on: exits 0', async () => {
    const q = await launchWindow('prod', { extraEnv: { MARVER_APP_TIMINGS: JSON.stringify({ ...TIMINGS, unloadActMs: 200, quitWaitMs: 1500 }) } })
    let code: number | null = null
    try {
      const s = await shown(q)
      // the active one never reports: the quit after the force asks about it, which holds the app while the case reads
      const o = await shown(q, {}, false)
      await sleep(HIDDEN)
      expect(await q.run.call('closeNever', { target: s.id })).toBe(true)
      await q.run.call('sheet', { mode: 'hold' })
      const n = await mark(q)
      expect((await tick({ level: 4 }, q)).unload.map((u) => u.id)).toEqual([s.id])
      await q.until((x) => tab(x, s.id).unload?.phase === 'unsure', 5000, 'unsure')

      // the quit: bounded on its own, stuck - the sheet names the tab, Keep Waiting the default
      const at = Date.now()
      await q.run.call('command', { cmd: 'quit' })
      const sheet = await held(q)
      expect(Date.now() - at).toBeGreaterThanOrEqual(1300)
      expect(sheet).toMatchObject({ kind: 'guard', action: 'quit', tabs: [s.id], message: expect.stringMatching(/^Canvas \d+ isn't closing$/), buttons: ['Keep Waiting', 'Force Quit Tab'] })
      expect(await quitLines(n, q)).toEqual([{ asked: true }, { answer: 'stuck' }])
      // the unload still owns the tab: its view, unsure, no unload recorded done, closed again and again
      const t = await q.tab(s.id)
      expect(t.unload?.phase).toBe('unsure')
      expect(t.hasView).toBe(true)
      expect((await q.state()).quitting).toBe(false)
      expect(await phases(n, s.id, q)).toEqual(['start', 'unsure'])
      expect((await since(n, 'closeNever', q)).length).toBeGreaterThan(3)

      // Keep Waiting: nothing changes
      await q.run.call('sheet:answer', { ok: false })
      await sleep(100)
      expect(await quitLines(n, q)).toContainEqual({ stuck: 'keep-waiting', tabs: [s.id] })
      expect((await q.tab(s.id)).hasView).toBe(true)

      // a later quit is heard: asked again, stuck again, the sheet again
      await q.run.call('command', { cmd: 'quit' })
      await held(q)
      expect((await quitLines(n, q)).filter((l) => l.asked)).toHaveLength(2)

      // Force Quit Tab: its own outcome, then the quit goes on - and asks about the canvas that never reported
      await q.run.call('sheet:answer', { ok: true })
      const third = await held(q)
      expect(third).toMatchObject({ kind: 'guard', action: 'quit', tabs: [o.id] })
      expect(await phases(n, s.id, q)).toEqual(['start', 'unsure', 'forced'])
      expect((await since(n, 'act', q)).find((l) => l.data.tab === s.id && l.data.answer)?.data).toMatchObject({ answer: 'done', why: 'forced' })
      expect((await since(n, 'unload', q)).find((l) => l.data.tab === s.id && l.data.forced)?.data).toMatchObject({ forced: true, destroyed: false })
      // its renderer ended: no other tab's frame lived in it
      expect((await since(n, 'unload', q)).find((l) => l.data.tab === s.id && 'forcedKill' in l.data)?.data).toMatchObject({ shared: [] })
      expect(await quitLines(n, q)).toContainEqual({ stuck: 'forced', tabs: [s.id] })
      const after = await q.tab(s.id)
      expect(after.view).toBe('unloaded')
      expect(after.hasView).toBe(false)
      await q.run.call('sheet:answer', { ok: true })
    } finally {
      code = await q.close()
    }
    expect(code).toBe(0)
  })
})
