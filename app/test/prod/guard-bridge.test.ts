/**
 * Safety is unknown until the document's first report (spec 28 A2.10, v1.13 r2 #1), against the real bridge and
 * canvas preload - the trust stream's, no fake: a page tells its preload it holds unsaved work, then hangs before
 * its admission lands. The preload holds what the page said until an admit comes (v1.12 r1 #1), so main has heard
 * nothing: its record stays `unknown`, and the page's close and its reload ask first, Cancel keeping it. Once the
 * page runs again, the admit lands, the held report arrives, and main's own record refuses at once with no sheet.
 *
 * Needs the trust stream's modules built in (its `trust:admit-delay` hook holds each admit, as a slow one would
 * be): on a branch without them the case is skipped and says it is inconclusive.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hits, launchWindow, sleep, type WindowRun } from '../harness/window.ts'
import { startFakeCanvas, type FakeCanvas } from '../harness/fake-canvas.ts'

let w: WindowRun
let real = false
let fake: FakeCanvas | undefined
beforeAll(async () => {
  w = await launchWindow('prod', { extraEnv: { MARVER_APP_FAKE_TRUST: '0' } })
  real = (await w.run.call<string[]>('hooks')).includes('trust:admit-delay')
  if (!real) process.stdout.write('guard-bridge: INCONCLUSIVE - the trust stream\'s bridge and preload are not built in here; the case is skipped\n')
})
afterAll(async () => {
  await fake?.close().catch(() => {})
  await w?.close()
})

// the page: hello and an unsaved busy straight away (held by the preload: no admit yet), then 6 s busy
const SPEAK_THEN_HANG = `
  var ma = window.marverApp;
  if (ma) {
    ma.hello({ version: '0.27.1', board: null, page: 'pageid-0001' });
    ma.busy({ busy: true, unsaved: true, why: ['capture-unsent'] });
    say('spoke');
    setTimeout(function () { var e = Date.now() + 6000; while (Date.now() < e) {} say('free') }, 50);
  }
  window.__clean = function () { ma.busy({ busy: false, unsaved: false, why: [] }); return 1 };`

describe('a page that reports unsaved work and hangs before its admission (r2 #1)', () => {
  it('its close and its reload ask first, and Cancel keeps it; once it runs, main\'s own record refuses at once', async (ctx) => {
    if (!real) { ctx.skip(); return }
    await w.run.call('trust:admit-delay', { ms: 2000 })
    fake = await startFakeCanvas({ home: w.env.home, slotBase: w.slotBase, slot: 1, name: 'Tidewell', script: SPEAK_THEN_HANG })
    await fake.ready
    const s0 = await w.until((x) => x.tabs.some((t) => t.reg?.instance === fake!.instance && t.reg.state === 'ready'), 10_000, 'the canvas from the registry')
    const id = s0.tabs.find((t) => t.reg?.instance === fake!.instance)!.id
    await w.run.call('activate', { id })
    await w.until((x) => { const t = x.tabs.find((q) => q.id === id)!; return !!t.doc?.lifted && t.doc.trusted }, 10_000, 'a trusted commit')
    for (let i = 0; i < 100 && hits(fake, '/__mv/test/spoke') < 1; i++) await sleep(20)
    expect(hits(fake, '/__mv/test/spoke'), 'the page told its preload before it hung').toBe(1)
    expect(hits(fake, '/__mv/test/free')).toBe(0)
    // main has heard nothing: unknown, so the sheet first - Cancel keeps the page
    expect((await w.tab(id)).reports.safety).toBe('unknown')
    await w.run.call('sheet', { mode: 'cancel' })
    const n = (await w.run.call<{ shown: unknown[] }>('sheets')).shown.length
    expect(await w.run.call('close', { id })).toBe('refused')
    expect(await w.run.call('guard', { id, action: { kind: 'reload' } })).toBe('refused')
    const sheets = (await w.run.call<{ shown: { action: string; detail: string }[] }>('sheets')).shown.slice(n)
    expect(sheets.map((x) => x.action)).toEqual(['close', 'reload'])
    for (const x of sheets) expect(x.detail).toMatch(/hasn't told the app yet whether it holds unsaved work/)
    expect(hits(fake, '/__mv/test/free'), 'all of it while the page was still busy').toBe(0)
    const t = await w.tab(id)
    expect(t).toMatchObject({ hasView: true, retained: true })
    // the page runs again: the admit lands, the held report with it - fresh, unsaved - and main refuses by itself
    await w.until((x) => { const q = x.tabs.find((y) => y.id === id)!; return q.reports.safety === 'fresh' && !!q.reports.busy?.unsaved }, 15_000, 'the held report')
    expect(hits(fake, '/__mv/test/free')).toBe(1)
    const m = (await w.run.call<{ shown: unknown[] }>('sheets')).shown.length
    expect(await w.run.call('close', { id })).toBe('refused')
    expect((await w.run.call<{ shown: unknown[] }>('sheets')).shown.length).toBe(m)   // no sheet: main's own record
    expect((await w.tab(id)).held?.action).toBe('close')
    // the page saves: its close goes through
    await w.run.call('exec', { target: id, js: 'window.__clean()' })
    await w.until((x) => x.tabs.find((y) => y.id === id)!.reports.busy?.unsaved === false, 5000, 'saved')
    await w.run.call('sheet', { mode: 'confirm' })
    expect(await w.run.call('close', { id })).toBe('closed')
  }, 60_000)
})
