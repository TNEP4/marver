/**
 * ⌘L's link in its canvas's tab (spec 28 A2.7, A2.14 #24, v1.12 r1 #3, v1.13 r2 #6): the window stream's half of
 * home.ts's `LinkPorts.open` (`openInTab`), with the link already rebuilt on the entry's bound origin. A hash-only
 * link goes with no question; a link that changes the document goes through the guard and answers `refused` when
 * the page holds unsaved work; a starting canvas keeps the link's path for its first load.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'
import { startFakeCanvas, type FakeCanvas } from '../harness/fake-canvas.ts'

let w: WindowRun
beforeAll(async () => { w = await launchWindow('pw') })
afterAll(async () => { await w?.close() })

const entryOf = (f: FakeCanvas) => ({ state: 'ready', origin: f.origin, port: f.port, ws: f.ws, name: 'Tidewell' })

describe('a local link opened in its canvas\'s tab', () => {
  let id: string
  let fake: FakeCanvas

  it('only the hash changes: the same document, no question, the path follows', async () => {
    ;({ id, fake } = await w.canvas({ slot: 1, name: 'Tidewell' }))
    await w.run.call('activate', { id: 'home' })
    await w.run.call('activate', { id })
    await w.until((x) => !!x.tabs.find((t) => t.id === id)?.doc?.lifted, 10_000, 'lifted')
    await w.report(id, { unsaved: false })
    await w.run.call('activate', { id: 'home' })
    const before = (await w.tab(id)).doc!.commits
    const since = (await w.log()).length
    expect(await w.run.call('openInTab', { entry: entryOf(fake), url: `${fake.origin}/#/b/plans`, rest: '/#/b/plans' })).toEqual({ ok: true })
    const s = await w.until((x) => x.tabs.find((t) => t.id === id)!.path === '/#/b/plans', 3000, 'the path')
    expect(s.active).toBe(id)
    expect(s.tabs.find((t) => t.id === id)!.doc!.commits).toBe(before)
    expect((await w.log('guard', since))).toEqual([])
  })

  it('a link that changes the document goes through the guard and opens', async () => {
    const before = (await w.tab(id)).doc!.commits
    expect(await w.run.call('openInTab', { entry: entryOf(fake), url: `${fake.origin}/index.html#/b/checkout`, rest: '/index.html#/b/checkout' })).toEqual({ ok: true })
    const s = await w.until((x) => { const t = x.tabs.find((q) => q.id === id)!; return !!t.doc?.lifted && t.doc.commits > before }, 10_000, 'the new document')
    expect(s.tabs.find((t) => t.id === id)!.doc!.url).toBe(`${fake.origin}/index.html#/b/checkout`)
  })

  it('into a page that holds unsaved work: refused, nothing opened, the tab forward with its pill', async () => {
    await w.report(id, { unsaved: true, why: ['typing'] })
    await w.run.call('activate', { id: 'home' })
    const before = (await w.tab(id)).doc!.commits
    expect(await w.run.call('openInTab', { entry: entryOf(fake), url: `${fake.origin}/?x=1`, rest: '/?x=1' })).toEqual({ ok: false, why: 'refused' })
    await sleep(300)
    const s = await w.state()
    expect(s.tabs.find((t) => t.id === id)!.doc!.commits).toBe(before)
    expect(s.active).toBe(id)
    expect(s.pill).toMatchObject({ kind: 'unsaved', tab: id })
    await w.report(id, { unsaved: false })
  })

  it('a canvas still starting: its tab opens on its starting page and keeps the link\'s path for its first load', async () => {
    const f = await startFakeCanvas({ home: w.env.home, slotBase: w.slotBase, slot: 2, name: 'Later' })
    await f.ready
    try {
      const rec = { ...f.record(), file: f.slotFile }
      await w.run.call('fake:entry', { ...rec, state: 'starting', origin: null })
      const s0 = await w.until((x) => x.tabs.some((t) => t.reg?.instance === f.instance), 5000, 'the starting tab')
      const tab = s0.tabs.find((t) => t.reg?.instance === f.instance)!
      expect(await w.run.call('openInTab', { entry: { state: 'starting', origin: null, port: f.port, ws: f.ws, name: 'Later' }, url: null, rest: '/#/b/later' })).toEqual({ ok: true })
      const s1 = await w.until((x) => x.active === tab.id, 3000, 'the tab forward')
      expect(s1.tabs.find((t) => t.id === tab.id)).toMatchObject({ path: '/#/b/later', state: 'starting', pageView: true })
      expect(await w.run.call('page', { tab: tab.id })).toMatchObject({ body: { page: 'starting', phase: 'starting' } })
      await w.run.call('fake:entry', rec)
      const s2 = await w.until((x) => !!x.tabs.find((t) => t.id === tab.id)?.doc?.lifted, 10_000, 'loaded at ready')
      expect(s2.tabs.find((t) => t.id === tab.id)!.doc!.url).toBe(`${f.origin}/#/b/later`)
    } finally { await f.close() }
  })
})
