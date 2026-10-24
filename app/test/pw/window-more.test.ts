/**
 * The window stream's smaller paths, end to end with the fake trust (spec 28 A2.4, A2.7, A2.11, A2.14 #19, #21, #24):
 * a hidden tab's own page closed after its delay and made again when shown; the strip's right-click menu and `»`
 * menu built from main's record (their native popups recorded, never put on the screen); the logo - at most one
 * fetch in flight per tab, the older aborted by a newer one or a navigation, applied to the document it was
 * fetched for; and the checks a failed tab makes at once when the Mac wakes. Durations shortened only where the
 * rule, not the duration, is under test (a hidden tab page's close; the retries kept long so only the wake looks).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'

let w: WindowRun
beforeAll(async () => {
  w = await launchWindow('pw', {
    extraEnv: { MARVER_APP_TIMINGS: JSON.stringify({ tabPageCloseMs: 1500, retryMs: [60_000], retryEveryMs: 60_000, activeCheckMs: 60_000 }) },
  })
})
afterAll(async () => { await w?.close() })

interface PopupItem { label: string; enabled: boolean; checked?: boolean }
const lastPopup = async () => ((await w.log('popup')).at(-1)?.data.items ?? []) as PopupItem[]
const effects = () => w.run.call<{ copies: string[]; opened: string[] }>('effects')

describe('a hidden tab\'s own page (A2.14 #21)', () => {
  it('closes its delay after the tab was hidden, and is made again when the tab is shown', async () => {
    const { fake, id } = await w.canvas({ slot: 1, name: 'Stopped one' })
    await w.run.call('fake:gone', { instance: fake.instance })
    await w.run.call('activate', { id })
    let s = await w.until((x) => x.tabs.find((t) => t.id === id)!.pageView, 5000, 'its stopped page')
    expect(await w.run.call('page', { tab: id })).toMatchObject({ body: { page: 'stopped' } })
    await w.run.call('activate', { id: 'home' })
    await sleep(300)
    expect((await w.tab(id)).pageView).toBe(true)   // kept a while: a quick switch back finds it
    s = await w.until((x) => !x.tabs.find((t) => t.id === id)!.pageView, 5000, 'the hidden page closed')
    expect((await w.log('view')).some((l) => l.data.op === 'remove' && l.data.key === `${id}:page`)).toBe(true)
    await w.run.call('activate', { id })
    s = await w.until((x) => x.tabs.find((t) => t.id === id)!.pageView, 5000, 'its page again')
    expect(s.active).toBe(id)
    expect(await w.run.call('page', { tab: id })).toMatchObject({ body: { page: 'stopped' } })
    await w.run.call('activate', { id: 'home' })
  })
})

describe('the strip\'s menus, from main\'s record (A2.4, A2.7, A2.14 #19, #24)', () => {
  let id: string
  let port: number

  it('a trusted canvas\'s right-click menu: Open in Browser, Reveal in Finder, Copy Local Link, Mark All as Seen, Close Tab', async () => {
    const c = await w.canvas({ slot: 2, name: 'Tidewell' })
    id = c.id
    port = c.fake.port
    await w.run.call('activate', { id })
    await w.until((x) => !!x.tabs.find((t) => t.id === id)?.doc?.lifted, 10_000, 'lifted')
    await w.report(id, { unsaved: false })
    await w.run.call('tabMenu', { id })
    expect(await lastPopup()).toEqual([
      { label: 'Open in Browser', enabled: true }, { label: 'Reveal in Finder', enabled: true },
      { label: 'Copy Local Link', enabled: true }, { label: 'Mark All as Seen', enabled: true }, { label: 'Close Tab', enabled: true },
    ])
    const before = (await effects()).copies.length
    expect(await w.run.call('popup:click', { label: 'Copy Local Link' })).toBe(true)
    const copies = (await effects()).copies
    expect(copies.length).toBe(before + 1)
    expect(copies.at(-1)).toBe(`http://localhost:${port}/`)   // the people link, never the bound origin
    // Mark All as Seen: main's own mv:menu-click to the canvas - not an item the page's mv:menu offers
    await w.run.call('tabMenu', { id })
    const since = (await w.log()).length
    expect(await w.run.call('popup:click', { label: 'Mark All as Seen' })).toBe(true)
    expect((await w.log('fake-trust', since)).map((l) => l.data)).toContainEqual({ menuClick: 'mark-all-seen', tab: id })
    expect((await w.log('tab-act', since)).map((l) => l.data)).toContainEqual({ what: 'mark-all-seen', tab: id, sent: true })
  })

  it('a canvas without the bridge (0.27.0) cannot hear Mark All as Seen: the item is disabled', async () => {
    const c = await w.canvas({ slot: 5, name: 'Older', version: '0.27.0', features: [] })
    await w.run.call('activate', { id: c.id })
    await w.until((x) => !!x.tabs.find((t) => t.id === c.id)?.doc?.lifted, 10_000, 'lifted')
    await w.run.call('tabMenu', { id: c.id })
    const items = await lastPopup()
    expect(items.find((i) => i.label === 'Copy Local Link')!.enabled).toBe(true)
    expect(items.find((i) => i.label === 'Mark All as Seen')!.enabled).toBe(false)
    await w.run.call('activate', { id })
  })

  it('once the bridge says the document went stale, the items that would hand on its address are disabled', async () => {
    await w.report(id, null, { safety: 'stale' })
    await sleep(100)
    const t = await w.tab(id)
    expect(t.doc!.trusted).toBe(false)
    expect(t.reports.safety).toBe('stale')
    await w.run.call('tabMenu', { id })
    const items = await lastPopup()
    expect(items.find((i) => i.label === 'Open in Browser')!.enabled).toBe(false)
    expect(items.find((i) => i.label === 'Copy Local Link')!.enabled).toBe(false)
    expect(await w.run.call('popup:click', { label: 'Copy Local Link' })).toBe(false)
  })

  it('the » menu names each tab behind it with its state, the active one checked; choosing one activates it', async () => {
    const s = await w.state()
    const stopped = s.tabs.find((t) => t.name === 'Stopped one')!
    await w.run.call('tabsMore', { ids: [stopped.id, id] })
    const items = await lastPopup()
    expect(items).toEqual([
      { label: 'Stopped one - stopped', enabled: true, checked: false },
      { label: 'Tidewell', enabled: true, checked: true },
    ])
    expect(await w.run.call('popup:click', { label: 'Stopped one - stopped' })).toBe(true)
    await w.until((x) => x.active === stopped.id, 3000, 'the tab chosen from »')
    await w.run.call('activate', { id: 'home' })
  })
})

describe('the logo (A2.4)', () => {
  it('at most one fetch in flight per tab: a newer one or a navigation aborts the older; the result applied to its own document', async () => {
    const url = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='
    await w.run.call('fake:logo', { on: true, delayMs: 700, url, started: 0, aborted: 0, answered: 0, inFlight: 0, maxInFlight: 0 })
    const c = await w.canvas({ slot: 3, name: 'Logo canvas' })
    // fetched once its entry is ready; shown, a newer fetch aborts that one; the load's navigation aborts that, and
    // the lift fetches again for the new document
    await w.run.call('activate', { id: c.id })
    const s = await w.until((x) => x.tabs.find((t) => t.id === c.id)!.logo === url, 10_000, 'the logo applied')
    expect(s.tabs.find((t) => t.id === c.id)!.doc!.lifted).toBe(true)
    const stats = await w.run.call<{ started: number; aborted: number; answered: number; inFlight: number; maxInFlight: number }>('fake:logo')
    expect(stats.maxInFlight).toBe(1)
    expect(stats.aborted).toBeGreaterThanOrEqual(1)
    expect(stats.answered).toBeGreaterThanOrEqual(1)
    const lines = (await w.log('logo')).filter((l) => l.data.tab === c.id)
    expect(lines.some((l) => l.data.aborted)).toBe(true)
    expect(lines.filter((l) => l.data.applied).length).toBe(1)
    // closing the tab aborts a fetch in flight
    await w.run.call('fake:logo', { delayMs: 5000 })
    await w.run.call('activate', { id: 'home' })
    await w.run.call('activate', { id: c.id })   // shown again: a fetch starts
    await w.report(c.id, { unsaved: false })
    const aborted = (await w.run.call<{ aborted: number }>('fake:logo')).aborted
    const since = (await w.log()).length
    expect(await w.run.call('close', { id: c.id })).toBe('closed')
    expect((await w.run.call<{ aborted: number }>('fake:logo')).aborted).toBeGreaterThanOrEqual(aborted + 1)
    expect((await w.log('logo', since)).filter((l) => l.data.tab === c.id).map((l) => l.data.aborted ? 'aborted' : l.data.fetch ? 'fetch' : 'applied')).toEqual(['aborted'])
    await w.run.call('fake:logo', { on: false })
  })
})

describe('a failed tab when the Mac wakes (A2.11)', () => {
  it('looks again at once on powerMonitor resume, long before its next retry', async () => {
    const c = await w.canvas({ slot: 4, name: 'Asleep' })
    await w.run.call('activate', { id: c.id })
    await w.until((x) => !!x.tabs.find((t) => t.id === c.id)?.doc?.lifted, 10_000, 'lifted')
    await w.report(c.id, { unsaved: false })
    await c.fake.close()
    expect(await w.run.call('guard', { id: c.id, action: { kind: 'reload' } })).toBe('done')
    await w.until((x) => x.tabs.find((t) => t.id === c.id)!.fail?.why === 'unreachable', 10_000, 'unreachable')
    await w.run.call('activate', { id: 'home' })
    await sleep(500)
    const since = (await w.log()).length
    expect((await w.log('probe', since)).filter((l) => l.data.tab === c.id)).toEqual([])
    await w.run.call('resume')
    for (let i = 0; i < 30 && !(await w.log('probe', since)).some((l) => l.data.tab === c.id); i++) await sleep(100)
    expect((await w.log('probe', since)).filter((l) => l.data.tab === c.id).map((l) => l.data.state)).toEqual(['silent'])
  })
})

describe('a tab closed while its first view is made (A2.4)', () => {
  it('gets no view and loads nothing hidden; reopened, it loads as any documentless tab', async () => {
    await w.run.call('fake:session', { hold: true })
    try {
      const c = await w.canvas({ slot: 6, name: 'Closed early' })
      await w.run.call('activate', { id: c.id })
      // the view waits on its partition's preparation (the real one awaits the service-worker sweep): ⌘W now
      for (let i = 0; i < 40 && !(await w.log('fake-trust')).some((l) => l.data.session === 'held'); i++) await sleep(25)
      expect(await w.run.call('close', { id: c.id })).toBe('closed')
      const since = (await w.log()).length
      await w.run.call('fake:session', { hold: false })
      await sleep(800)
      const t = await w.tab(c.id)
      expect(t.open).toBe(false)
      expect(t.hasView).toBe(false)
      expect(t.view).toBe('none')
      expect((await w.log('load', since)).filter((l) => l.data.tab === c.id)).toEqual([])
      expect(c.fake.requests.filter((r) => r.path === '/')).toEqual([])
      expect((await w.log('view', since)).map((l) => l.data)).toContainEqual({ tab: c.id, abandoned: true })
      // reopened from Home: its first view now, and its load
      await w.run.call('activate', { id: c.id })
      await w.until((x) => !!x.tabs.find((q) => q.id === c.id)?.doc?.lifted, 10_000, 'loaded once reopened')
      expect((await w.tab(c.id)).open).toBe(true)
    } finally { await w.run.call('fake:session', { hold: false }) }
    await w.run.call('activate', { id: 'home' })
  })
})
