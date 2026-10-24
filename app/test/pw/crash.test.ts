/**
 * Crashes, with one owner and a latch (spec 28 A2.11, the budget "a reload starts within 1 s", A2.14 #28), against
 * real renderers: the test hook ends a canvas's renderer without marking it the app's, as a crash would.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWindow, sleep, type LogLine, type WindowRun } from '../harness/window.ts'

let w: WindowRun
beforeAll(async () => { w = await launchWindow('pw') })
afterAll(async () => { await w?.close() })

const ns = (l: LogLine) => BigInt(l.t)
const lifted = (id: string, commitsOver: number) => (s: Awaited<ReturnType<WindowRun['state']>>) => {
  const t = s.tabs.find((x) => x.id === id)!
  return !!t.doc?.lifted && t.doc.commits > commitsOver && t.view === 'live'
}

describe('a crash of the active tab (A2.11)', () => {
  let id: string

  it('starts its reload within 1 s, in the turn of the crash; the lift shows "Reloaded after a crash"', async () => {
    id = (await w.canvas({ slot: 1, name: 'Tidewell' })).id
    await w.run.call('activate', { id })
    const s0 = await w.until(lifted(id, 0), 10_000, 'lifted')
    const before = s0.tabs.find((t) => t.id === id)!.doc!.commits
    const since = (await w.log()).length
    await w.run.call('crash', { target: id })
    await w.until(lifted(id, before), 10_000, 'the reload to lift')
    const log = await w.log(undefined, since)
    const gone = log.find((l) => l.topic === 'gone')!
    const started = log.find((l) => l.topic === 'crash' && l.data.reload === 'auto')!
    expect(gone.data).toMatchObject({ tab: id, app: false })
    expect(started.turn).toBe(gone.turn)
    expect(Number(ns(started) - ns(gone)) / 1e6).toBeLessThan(1000)
    const s = await w.until((x) => x.pill?.kind === 'confirmation', 3000, 'the confirmation')
    expect(s.pill).toMatchObject({ kind: 'confirmation', short: 'Reloaded' })
    expect(s.tabs.find((t) => t.id === id)!.crash).toMatchObject({ count: 1, latched: false })
  })

  it('a second crash within 60 s latches it: no further load, also after switching away and back', async () => {
    const since = (await w.log()).length
    await w.run.call('crash', { target: id })
    const s = await w.until((x) => x.tabs.find((t) => t.id === id)!.crash.latched, 5000, 'the latch')
    expect(s.tabs.find((t) => t.id === id)!.crash.count).toBe(2)
    await w.run.call('activate', { id: 'home' })
    await sleep(200)
    await w.run.call('activate', { id })
    await sleep(500)
    const log = await w.log(undefined, since)
    expect(log.filter((l) => l.topic === 'crash' && l.data.reload)).toEqual([])
    expect(log.filter((l) => l.topic === 'load' && l.data.tab === id)).toEqual([])
    const t = await w.tab(id)
    expect(t.state).toBe('crashed')
    expect(t.pageView).toBe(true)
    expect(await w.run.call('page', { tab: id })).toMatchObject({ body: { page: 'crashed', latched: true, crashes: 2 } })
  })

  it('Reload on its page is the person\'s: the canvas comes back; ⌘R on a latched tab is the same', async () => {
    const before = (await w.tab(id)).doc!.commits
    expect(await w.run.call('tabpage:action', { tab: id, action: 'reload' })).toBe(true)
    await w.until(lifted(id, before), 10_000, 'the person\'s reload to lift')
    expect((await w.tab(id)).crash.latched).toBe(true)   // clears after 60 s without a crash
    // that page is live and may hold work: ⌘R and ⇧⌘R are the guard's now, though the latch stays its 60 s
    await w.report(id, { unsaved: true, why: ['board-unsaved'] })
    const held = (await w.tab(id)).doc!.commits
    const since = (await w.log()).length
    await w.run.call('command', { cmd: 'reload' })
    await w.run.call('command', { cmd: 'force-reload' })
    await sleep(300)
    const kept = await w.tab(id)
    expect(kept.doc!.commits).toBe(held)
    expect(kept.held?.action).toBe('forceReload')
    expect((await w.log('crash', since)).filter((l) => l.data.reload)).toEqual([])
    expect((await w.state()).pill).toMatchObject({ kind: 'unsaved', tab: id })
    await w.report(id, { unsaved: false })
    // an old rev is refused
    await w.run.call('crash', { target: id })
    await w.until((x) => x.tabs.find((t) => t.id === id)!.pageView, 5000, 'the page again')
    const page = await w.run.call<{ rev: number }>('page', { tab: id })
    expect(await w.run.call('tabpage:action', { tab: id, rev: page.rev - 1, action: 'reload' })).toBe(false)
    const mid = (await w.tab(id)).doc!.commits
    await w.run.call('command', { cmd: 'reload' })
    await w.until(lifted(id, mid), 10_000, '⌘R to reload the latched tab')
  })
})

describe('a hidden tab that crashed (A2.11)', () => {
  it('loads only when shown - its one automatic attempt - and crashing again there latches it', async () => {
    const h = (await w.canvas({ slot: 2, name: 'Hidden' })).id
    await w.run.call('activate', { id: h })
    const s0 = await w.until(lifted(h, 0), 10_000, 'lifted')
    await w.run.call('activate', { id: 'home' })
    const since = (await w.log()).length
    await w.run.call('crash', { target: h })
    await w.until((x) => x.tabs.find((t) => t.id === h)!.crash.pendingShow === true, 5000, 'the pending attempt')
    await sleep(500)
    expect((await w.log(undefined, since)).filter((l) => l.topic === 'crash' && l.data.reload)).toEqual([])
    await w.run.call('activate', { id: h })
    const before = s0.tabs.find((t) => t.id === h)!.doc!.commits
    await w.until(lifted(h, before + 1), 10_000, 'the attempt on showing to lift')
    await w.run.call('crash', { target: h })
    await w.until((x) => x.tabs.find((t) => t.id === h)!.crash.latched, 5000, 'the latch')
  })
})
