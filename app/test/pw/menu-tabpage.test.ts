/**
 * The menu bar as built (spec 28 A2.7, v1.10 r1 #3, #10, r2 #1, r3 #3) and the tab's own page coming back from a
 * canvas that stopped answering (A2.3, A2.11, v1.13 r2 #3), with the fake trust.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'
import { startFakeCanvas } from '../harness/fake-canvas.ts'

let w: WindowRun
beforeAll(async () => { w = await launchWindow('pw') })
afterAll(async () => { await w?.close() })

interface Item { id?: string; label: string; type: string; checked: boolean; enabled: boolean; accelerator?: string; submenu?: Item[] }
const items = () => w.run.call<Item[]>('menu:items')
const menu = async (label: string) => (await items()).find((m) => m.label === label)?.submenu ?? []
const find = (list: Item[], id: string) => list.find((m) => m.id === id)

const MENU = [
  { id: 'fit-all', group: 'view', label: 'Fit All', hint: '⇧1' },
  { id: 'pins', group: 'view', label: 'Pins', hint: '⇧C', checked: true },
  { id: 'session', group: 'jam', label: 'Session', hint: 'J' },
]

describe('the menu bar (A2.7)', () => {
  let id: string

  it('on Home: no canvas items, no Jam, Close Tab disabled; the app\'s own items with their keys', async () => {
    expect((await items()).map((m) => m.label)).toEqual(['Marver', 'File', 'Edit', 'View', 'Window', 'Help'])
    const file = await menu('File')
    expect(file.find((m) => m.label === 'Close Tab')).toMatchObject({ enabled: false, accelerator: 'Cmd+W' })
    expect((await menu('Marver')).find((m) => m.label === 'Quit Marver')!.accelerator).toBe('Cmd+Q')
  })

  it('a trusted canvas\'s items: their keys in their names, never accelerators; checked ones are checkboxes; Jam while it sends it', async () => {
    id = (await w.canvas({ slot: 1, name: 'Tidewell' })).id
    await w.run.call('activate', { id })
    await w.until((x) => !!x.tabs.find((t) => t.id === id)?.doc?.lifted, 10_000, 'lifted')
    await w.report(id, { unsaved: false }, { menu: MENU })
    await sleep(200)
    const view = await menu('View')
    expect(find(view, 'cv:fit-all')).toMatchObject({ label: 'Fit All (⇧1)', type: 'normal' })
    expect(find(view, 'cv:fit-all')!.accelerator).toBeFalsy()
    expect(find(view, 'cv:pins')).toMatchObject({ type: 'checkbox', checked: true })
    expect((await menu('Jam')).map((m) => m.label)).toEqual(['Session (J)'])
    const win = await menu('Window')
    expect(find(win, `tab:${id}`)).toMatchObject({ type: 'checkbox', checked: true, accelerator: 'Cmd+1' })
  })

  it('choosing a checkbox item sends the click once; its mark stays the page\'s until the page says otherwise', async () => {
    const since = (await w.log()).length
    expect(await w.run.call('menu:click', { id: 'cv:pins' })).toBe(true)
    await sleep(150)
    expect((await w.log('menu', since)).map((l) => l.data.click)).toEqual(['pins'])
    expect(find(await menu('View'), 'cv:pins')!.checked).toBe(true)
    await w.report(id, null, { menu: MENU.map((m) => m.id === 'pins' ? { ...m, checked: false } : m) })
    await sleep(200)
    expect(find(await menu('View'), 'cv:pins')!.checked).toBe(false)
  })

  it('a canvas item or a tab item chosen after a reload, a switch or a loss of trust does nothing', async () => {
    await w.run.call('menu:hold', { id: 'cv:fit-all' })
    await w.run.call('menu:hold', { id: `tab:${id}` })
    const since = (await w.log()).length
    await w.run.call('reloadPage', { target: id })
    await w.until((x) => { const t = x.tabs.find((q) => q.id === id)!; return !!t.doc?.lifted && t.doc.commits >= 2 }, 10_000, 'the reload')
    expect(await w.run.call('menu:click', { id: 'cv:fit-all', stale: true })).toBe(true)
    await w.run.call('activate', { id: 'home' })
    expect(await w.run.call('menu:click', { id: `tab:${id}`, stale: true })).toBe(true)
    await sleep(150)
    expect(await w.log('menu', since)).toEqual([])
    expect((await w.state()).active).toBe('home')
    // after the reload the page has said nothing yet: no canvas items
    await w.run.call('activate', { id })
    await sleep(200)
    expect(find(await menu('View'), 'cv:fit-all')).toBeUndefined()
  })

  it('a stopped canvas: no canvas items; Open in Browser and Copy Local Link disabled', async () => {
    await w.report(id, { unsaved: false }, { menu: MENU })
    await sleep(150)
    expect(find(await menu('View'), 'cv:fit-all')).toBeTruthy()
    const inst = (await w.tab(id)).reg!.instance
    await w.run.call('fake:gone', { instance: inst })
    await sleep(200)
    expect(find(await menu('View'), 'cv:fit-all')).toBeUndefined()
    const file = await menu('File')
    expect(file.find((m) => m.label === 'Open in Browser')!.enabled).toBe(false)
    expect(file.find((m) => m.label === 'Copy Local Link')!.enabled).toBe(false)
    expect(find(await menu('Window'), `tab:${id}`)!.label).toMatch(/ - stopped$/)
  })
})

describe('coming back from a canvas that stopped answering (A2.3, A2.11)', () => {
  it('a reload that fails commits an error page: unreachable, and the active tab\'s check loads it once it answers', async () => {
    const c = await w.canvas({ slot: 2, name: 'Gen lab' })
    await w.run.call('activate', { id: c.id })
    await w.until((x) => !!x.tabs.find((t) => t.id === c.id)?.doc?.lifted, 10_000, 'lifted')
    await w.report(c.id, { unsaved: false })
    await c.fake.close()
    expect(await w.run.call('guard', { id: c.id, action: { kind: 'reload' } })).toBe('done')
    let s = await w.until((x) => x.tabs.find((t) => t.id === c.id)!.fail?.why === 'unreachable', 10_000, 'unreachable')
    const t = s.tabs.find((x) => x.id === c.id)!
    expect(t.retained).toBe(false)
    expect(t.state).toBe('unreachable')
    expect(await w.run.call('page', { tab: c.id })).toMatchObject({ body: { page: 'unreachable', retained: false, reason: 'nothing' } })
    // the canvas answers again on its port: the 5 s check finds it and loads the tab, which lifts
    const since = (await w.log()).length
    const back = await startFakeCanvas({ home: w.env.home, slotBase: w.slotBase, slot: 2, name: 'Gen lab', ws: c.fake.ws })
    await back.ready
    try {
      s = await w.until((x) => { const y = x.tabs.find((q) => q.id === c.id)!; return !!y.doc?.lifted && !y.fail }, 12_000, 'the check to load it')
      expect((await w.log('probe', since)).some((l) => l.data.tab === c.id && l.data.state !== 'silent')).toBe(true)
      // the lift: the canvas view shown and its tab page hidden in one compose (A2.11)
      const lift = (await w.log('compose', since)).find((l) => (l.data.changes as { key: string; op: string; visible?: boolean }[]).some((ch) => ch.key === `${c.id}:view` && ch.op === 'visible' && ch.visible))
      expect(lift).toBeTruthy()
      expect((lift!.data.changes as { key: string; op: string; visible?: boolean }[]).some((ch) => ch.key === `${c.id}:page` && ch.visible === false)).toBe(true)
    } finally { await back.close() }
  })
})
