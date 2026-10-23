/**
 * The guard against Chromium's own beforeunload (spec 28 A2.2, A2.10, A2.14 #16, v1.12 r1 #3, v1.13 r2 #1, #4, v1.14
 * r3 #1), in the production-switch harness - Playwright's loader turns a beforeunload check off - with the fake
 * trust handing the app fake canvases. Main's own record decides first; the page's beforeunload is a best-effort
 * extra veto; a record not fresh asks one sheet (answered here through the test seam); the quit is one guarded
 * operation per canvas tab.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hits, launchWindow, MAY_LEAVE, REFUSE_UNLOAD, sleep, type WindowRun } from '../harness/window.ts'

let w: WindowRun
beforeAll(async () => { w = await launchWindow('prod') })
afterAll(async () => { await w?.close() })

async function shown(o: Parameters<WindowRun['canvas']>[0] = {}) {
  const c = await w.canvas(o)
  await w.run.call('activate', { id: c.id })
  await w.until((x) => !!x.tabs.find((t) => t.id === c.id)?.doc?.lifted && x.tabs.find((t) => t.id === c.id)!.retained, 10_000, `${c.id} lifted`)
  return c
}
const gesture = (id: string) => w.run.call('exec', { target: id, js: 'document.body.click(); 1', gesture: true })
const commits = async (id: string) => (await w.tab(id)).doc!.commits

describe('main\'s own record first: a fresh unsaved page is refused at once, asked nothing', () => {
  it('⌘W, ⌘R and ⇧⌘R on a page that said unsaved with no gesture since load: refused, its beforeunload never run', async () => {
    const { id, fake } = await shown({ slot: 1, script: REFUSE_UNLOAD })
    await w.report(id, { unsaved: true, why: ['capture-unsent'] })
    const wcId = (await w.tab(id)).wcId
    for (const cmd of ['close-tab', 'reload', 'force-reload']) {
      await w.run.call('command', { cmd })
      await sleep(300)
    }
    const t = await w.tab(id)
    expect(t.open).toBe(true)
    expect(t.wcId).toBe(wcId)
    expect(t.held?.action).toBe('forceReload')
    expect(hits(fake, '/__mv/test/beforeunload')).toBe(0)
    expect((await w.state()).pill).toMatchObject({ kind: 'unsaved', tab: id })
    await w.report(id, { unsaved: false })
    expect((await w.state()).pill).toBeNull()
  })
})

describe('a fresh, clean record: the act, the page\'s beforeunload a best-effort extra veto (r2 #4)', () => {
  it('close: a page that refuses keeps its tab - with a gesture since load, and with none (a close gives the page activation)', async () => {
    const { id, fake } = await shown({ slot: 2, script: REFUSE_UNLOAD })
    await w.report(id, { unsaved: false })
    expect(await w.run.call('close', { id })).toBe('refused')
    expect((await w.tab(id)).open).toBe(true)
    for (let i = 0; i < 20 && hits(fake, '/__mv/test/beforeunload') < 1; i++) await sleep(50)
    expect(hits(fake, '/__mv/test/beforeunload')).toBe(1)
    await gesture(id)
    expect(await w.run.call('close', { id })).toBe('refused')
    for (let i = 0; i < 20 && hits(fake, '/__mv/test/beforeunload') < 2; i++) await sleep(50)
    expect(hits(fake, '/__mv/test/beforeunload')).toBe(2)
    expect((await w.tab(id)).hasView).toBe(true)
    expect((await w.state()).pill).toMatchObject({ kind: 'unsaved', tab: id })   // the page refused: it holds work
  })

  it('reload: the refusal holds only after a gesture since load; without one Chromium goes on', async () => {
    const { id } = await shown({ slot: 3, script: REFUSE_UNLOAD })
    await w.report(id, { unsaved: false })
    const before = await commits(id)
    expect(await w.run.call('guard', { id, action: { kind: 'reload' } })).toBe('done')
    await w.until((x) => (x.tabs.find((t) => t.id === id)!.doc?.commits ?? 0) > before && !!x.tabs.find((t) => t.id === id)!.doc?.lifted, 10_000, 'the reload')
    await w.report(id, { unsaved: false })
    await gesture(id)
    const mid = await commits(id)
    expect(await w.run.call('guard', { id, action: { kind: 'reload' } })).toBe('refused')
    await sleep(500)
    expect(await commits(id)).toBe(mid)
  })

  it('a page that closes: its view removed only once destroyed, the tab closed for its run, Home lists it', async () => {
    const { id } = await shown({ slot: 4 })
    await w.report(id, { unsaved: false })
    expect(await w.run.call('close', { id })).toBe('closed')
    const t = await w.tab(id)
    expect(t).toMatchObject({ open: false, hasView: false, view: 'none' })
    expect((await w.state()).order).not.toContain(id)
  })
})

describe('a record not fresh asks one sheet first, Cancel the default (r1 #2, r2 #1, #15)', () => {
  it('a page not yet heard since its commit: Cancel keeps it; "Close it anyway" closes it', async () => {
    const { id } = await shown({ slot: 5 })
    await w.run.call('sheet', { mode: 'cancel' })
    expect(await w.run.call('close', { id })).toBe('refused')
    const sheets = await w.run.call<{ shown: { message: string; detail: string; buttons: string[] }[] }>('sheets')
    expect(sheets.shown.at(-1)).toMatchObject({ message: expect.stringMatching(/^Close .* anyway\?$/), buttons: ['Cancel', 'Close'] })
    expect(sheets.shown.at(-1)!.detail).toMatch(/hasn't told the app yet whether it holds unsaved work\.\n\nWhat it hasn't saved is lost\.$/)
    expect((await w.tab(id)).hasView).toBe(true)
    await w.run.call('sheet', { mode: 'confirm' })
    expect(await w.run.call('close', { id })).toBe('closed')
  })

  it('a page that reports unsaved and hangs before its admission: its close and its reload ask first, and Cancel keeps it', async () => {
    const { id } = await shown({ slot: 6 })
    // the page holds work it never got to report: a busy loop before any report reaches main
    await w.run.call('exec', { target: id, js: 'setTimeout(function () { var e = Date.now() + 6000; while (Date.now() < e) {} }, 20); 1' })
    await sleep(100)
    await w.run.call('sheet', { mode: 'cancel' })
    const n = (await w.run.call<{ shown: unknown[] }>('sheets')).shown.length
    expect(await w.run.call('close', { id })).toBe('refused')
    expect(await w.run.call('guard', { id, action: { kind: 'reload' } })).toBe('refused')
    expect((await w.run.call<{ shown: unknown[] }>('sheets')).shown.length).toBe(n + 2)
    expect((await w.tab(id)).hasView).toBe(true)
    await sleep(6000)
  })

  it('while the sheet is open, a second ⌘W is refused with no second sheet; the page reloading itself makes "Close it anyway" close nothing', async () => {
    const { id } = await shown({ slot: 7 })
    await w.run.call('sheet', { mode: 'hold' })
    const n = (await w.run.call<{ shown: unknown[] }>('sheets')).shown.length
    const first = w.run.call('close', { id })
    await sleep(100)
    expect(await w.run.call('close', { id })).toBe('refused')
    expect((await w.run.call<{ shown: unknown[]; held: number }>('sheets'))).toMatchObject({ held: 1 })
    expect((await w.run.call<{ shown: unknown[] }>('sheets')).shown.length).toBe(n + 1)
    const before = await commits(id)
    await w.run.call('reloadPage', { target: id })
    await w.until((x) => (x.tabs.find((t) => t.id === id)!.doc?.commits ?? 0) > before, 10_000, 'the page\'s own reload')
    await w.run.call('sheet:answer', { ok: true })
    expect(await first).toBe('refused')
    expect((await w.tab(id)).hasView).toBe(true)
    await w.run.call('sheet', { mode: 'cancel' })
  })
})

describe('the quit (A2.2: guardAll, one operation per canvas tab)', () => {
  it('quitting with unsaved work brings that tab forward with the pill, closes nothing, and the app stays', async () => {
    const s0 = await w.state()
    for (const t of s0.tabs.filter((x) => x.kind === 'local' && x.hasView)) await w.report(t.id, { unsaved: false }).catch(() => {})
    const a = await shown({ slot: 8 })
    await w.report(a.id, { unsaved: false })
    const b = await shown({ slot: 9 })
    await w.report(b.id, { unsaved: true, why: ['capture-recording'] })
    await w.run.call('activate', { id: a.id })
    const wcs = (await w.state()).tabs.filter((t) => t.hasView).map((t) => t.wcId)
    await w.run.call('quit')
    await sleep(800)
    const s = await w.state()
    expect(s.quitting).toBe(false)
    expect(s.active).toBe(b.id)
    expect(s.pill).toMatchObject({ kind: 'unsaved', tab: b.id })
    expect(s.tabs.filter((t) => t.hasView).map((t) => t.wcId)).toEqual(wcs)
    expect((await w.log('quit')).map((l) => l.data.answer).filter(Boolean)).toEqual(['refused'])
    // once its page says it is saved, the next quit goes through
    await w.report(b.id, { unsaved: false })
    for (const t of s.tabs.filter((x) => x.kind === 'local' && x.hasView && x.id !== b.id)) {
      const tab = await w.tab(t.id)
      if (tab.retained && tab.reports.safety !== 'fresh') await w.report(t.id, { unsaved: false })
    }
  })

  it('a quit whose page refuses its close is cancelled; that tab comes forward, the tabs closed before it reload when shown', async () => {
    for (const t of (await w.state()).tabs.filter((x) => x.kind === 'local' && x.hasView)) await w.run.call('exec', { target: t.id, js: MAY_LEAVE })
    const once = `var refused = false; addEventListener('beforeunload', function (e) { if (refused) return; refused = true; e.preventDefault(); e.returnValue = '' });`
    const r = await shown({ slot: 10, script: once })
    await w.report(r.id, { unsaved: false })
    await w.run.call('sheet', { mode: 'confirm' })
    await w.run.call('activate', { id: 'home' })
    expect(await w.run.call('guardAll', { action: { kind: 'quit' } })).toBe('refused')
    const s = await w.state()
    expect(s.active).toBe(r.id)
    expect((await w.tab(r.id)).hasView).toBe(true)
    const closedBefore = s.tabs.filter((t) => t.kind === 'local' && t.open && !t.hasView && t.reg?.state === 'ready' && t.id < r.id)
    expect(closedBefore.length).toBeGreaterThan(0)
    await w.run.call('activate', { id: closedBefore[0]!.id })
    await w.until((x) => x.tabs.find((t) => t.id === closedBefore[0]!.id)!.hasView, 5000, 'a tab closed by the quit to load again when shown')
  })

  it('the next quit goes through: every guarded page closed, and the app exits 0', async () => {
    for (const t of (await w.state()).tabs.filter((x) => x.kind === 'local' && x.hasView)) await w.report(t.id, { unsaved: false })
    expect(await w.close()).toBe(0)
  })
})
