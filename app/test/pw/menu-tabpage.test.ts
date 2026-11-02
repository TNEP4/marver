/**
 * The menu bar as built (spec 28 A2.7, v1.10 r1 #3, #10, r2 #1, r3 #3) and the tab's own page coming back from a
 * canvas that stopped answering (A2.3, A2.11, v1.13 r2 #3), with the fake trust. A5 (A5.1 #28, #34): Export
 * Performance Report… in Help and on a latched crashed page - the save panel stubbed (effects:save, a path in the
 * run's own folder, never ~/Downloads), the file written whole and shown in Finder, a failure's alert, nothing of a
 * canvas in the file.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'
import { startFakeCanvas } from '../harness/fake-canvas.ts'
import type { PerfReport } from '../../../src/shared/app-report.ts'

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
    await w.run.call('menu:hold', { id: 'reload' })
    await w.run.call('menu:hold', { id: 'force-reload' })
    const since = (await w.log()).length
    await w.run.call('reloadPage', { target: id })
    await w.until((x) => { const t = x.tabs.find((q) => q.id === id)!; return !!t.doc?.lifted && t.doc.commits >= 2 }, 10_000, 'the reload')
    expect(await w.run.call('menu:click', { id: 'cv:fit-all', stale: true })).toBe(true)
    // Reload Canvas and Force Reload held from before the page's reload: its document changed, they reload nothing
    const commits = (await w.tab(id)).doc!.commits
    const mid = (await w.log()).length
    expect(await w.run.call('menu:click', { id: 'reload', stale: true })).toBe(true)
    expect(await w.run.call('menu:click', { id: 'force-reload', stale: true })).toBe(true)
    await w.run.call('activate', { id: 'home' })
    expect(await w.run.call('menu:click', { id: `tab:${id}`, stale: true })).toBe(true)
    await sleep(150)
    expect(await w.log('menu', since)).toEqual([])
    expect((await w.state()).active).toBe('home')
    expect((await w.log('guard', mid)).concat(await w.log('act', mid))).toEqual([])
    expect((await w.tab(id)).doc!.commits).toBe(commits)
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

describe('Export Performance Report… (A5.1 #28)', () => {
  const LABEL = 'Export Performance Report…'
  interface Fx { shown?: string[]; saves?: string[]; alerts?: { message: string; detail: string }[] }
  const effects = () => w.run.call<Fx>('effects')
  /** the export's end, as views.ts journals it */
  const exported = async (since: number): Promise<Record<string, unknown>> => {
    const end = Date.now() + 20_000
    for (;;) {
      const l = (await w.log('report', since)).find((x) => 'result' in x.data)
      if (l) return l.data
      if (Date.now() > end) throw new Error('no export result')
      await sleep(50)
    }
  }
  const fromMenu = async (path: string | null) => {
    await w.run.call('effects', { clear: true })
    await w.run.call('effects:save', { path })
    const since = (await w.log()).length
    expect(await w.run.call('menu:clickLabel', { menu: 'Help', label: LABEL })).toBe(true)
    return exported(since)
  }
  const tmps = () => readdirSync(w.env.dir).filter((n) => n.endsWith('.tmp'))
  let canvas: { id: string; ws: string; origin: string }

  it('in Help, right after Show Performance Files; the save panel on ~/Downloads/Marver-report-<date>.json; cancelled, nothing written', async () => {
    const help = (await menu('Help')).map((m) => m.label)
    expect(help.indexOf(LABEL)).toBe(help.indexOf('Show Performance Files') + 1)
    expect(await fromMenu(null)).toMatchObject({ via: 'menu', result: 'cancelled' })
    const fx = await effects()
    expect(fx.saves).toHaveLength(1)
    const d = new Date()
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(basename(fx.saves![0]!)).toBe(`Marver-report-${day}.json`)
    expect(basename(dirname(fx.saves![0]!))).toBe('Downloads')
    expect(fx.shown).toBeUndefined()
    expect(fx.alerts).toBeUndefined()
  })

  it('a path chosen: the report written whole, then shown in Finder; this flavour\'s 7 days, nothing of a canvas', async () => {
    const c = await w.canvas({ slot: 3, name: 'Report canvas' })
    canvas = { id: c.id, ws: c.fake.ws, origin: c.fake.origin }
    await w.run.call('activate', { id: c.id })
    await w.until((x) => !!x.tabs.find((t) => t.id === c.id)?.doc?.lifted, 10_000, 'lifted')
    const file = join(w.env.dir, 'report-menu.json')
    const r = await fromMenu(file)
    const text = readFileSync(file, 'utf8')
    expect(r).toMatchObject({ via: 'menu', result: 'saved', file, bytes: Buffer.byteLength(text) })
    expect((await effects()).shown).toEqual([file])
    expect(tmps()).toEqual([])
    const rep = JSON.parse(text) as PerfReport
    expect(rep).toMatchObject({ v: 1, flavour: 'dev' })
    expect(rep.end - rep.start).toBe(7 * 86_400_000)
    // the recorder is on: this launch's own lines (its start, the tab records, which the report counts and never lists)
    expect(rep.events.counts.start).toBeGreaterThan(0)
    expect(rep.events.counts.tab).toBeGreaterThan(0)
    expect(rep.events.list.some((e) => (e.kind as string) === 'tab')).toBe(false)
    expect(['ok', 'partial']).toContain(rep.mac.status)
    expect(rep.mac.rows.length).toBeGreaterThan(0)
    // nothing of the canvases this file opened, nor of the home: names, workspaces, origins, paths
    for (const secret of [w.env.home, w.env.dir, 'Report canvas', 'Tidewell', 'Gen lab', canvas.ws, canvas.origin]) expect(text).not.toContain(secret)
    expect(text).not.toMatch(/"(ws|page|origin|pid|born|commit|message|stack|ring|gpuEvents)":/)
  })

  it('a folder that is not there: an alert says why, and no file, half-written or whole', async () => {
    const file = join(w.env.dir, 'no-such-folder', 'r.json')
    expect(await fromMenu(file)).toMatchObject({ result: 'failed', stage: 'write', code: 'ENOENT' })
    const fx = await effects()
    expect(fx.alerts).toEqual([{ message: 'The performance report wasn\'t saved', detail: 'That folder isn\'t there any more. Choose another one.' }])
    expect(fx.shown).toBeUndefined()
    expect(existsSync(file)).toBe(false)
    expect(tmps()).toEqual([])
  })

  it('a latched crashed page offers it beside Copy Details: the same export, its crashes in it by the tab\'s opaque id', async () => {
    const lifted = (n: number) => (s: Awaited<ReturnType<WindowRun['state']>>) => { const t = s.tabs.find((x) => x.id === canvas.id)!; return !!t.doc?.lifted && t.doc.commits > n && t.view === 'live' }
    // a live canvas shows no page: nothing to act on
    expect(await w.run.call('tabpage:action', { tab: canvas.id, action: 'export-report' })).toBe(false)
    const before = (await w.tab(canvas.id)).doc!.commits
    await w.run.call('crash', { target: canvas.id })
    await w.until(lifted(before), 10_000, 'the reload after the first crash')
    await w.run.call('crash', { target: canvas.id })
    await w.until((x) => x.tabs.find((t) => t.id === canvas.id)!.crash.latched, 5000, 'the latch')
    expect(await w.run.call('page', { tab: canvas.id })).toMatchObject({ body: { page: 'crashed', latched: true } })
    // the live page draws the button beside Copy Details (polled: its snapshot may still be on its way)
    const js = 'Array.from(document.querySelectorAll("#content button")).map(function (b) { return b.textContent })'
    let labels: string[] = []
    for (const end = Date.now() + 3000; Date.now() < end; await sleep(50)) {
      labels = (await w.run.call<string[] | null>('exec', { target: `${canvas.id}:page`, js })) ?? []
      if (labels.length >= 3) break
    }
    expect(labels).toEqual(['Reload', 'Copy Details', LABEL])

    const file = join(w.env.dir, 'report-page.json')
    await w.run.call('effects', { clear: true })
    await w.run.call('effects:save', { path: file })
    const since = (await w.log()).length
    expect(await w.run.call('tabpage:action', { tab: canvas.id, action: 'export-report' })).toBe(true)
    expect(await exported(since)).toMatchObject({ via: 'tabpage', result: 'saved', file })
    expect((await effects()).shown).toEqual([file])
    const text = readFileSync(file, 'utf8')
    const rep = JSON.parse(text) as PerfReport
    // the two crashes, flushed before the report was made: the tab by its id, never its workspace or page
    const gone = rep.events.list.filter((e) => e.kind === 'gone' && e.tab === canvas.id)
    expect(gone.length).toBeGreaterThanOrEqual(2)
    for (const e of gone) expect(Object.keys(e).every((k) => ['ts', 'kind', 'tab', 'role', 'reason', 'exitCode', 'ours', 'source', 'pressure'].includes(k))).toBe(true)
    expect(text).not.toContain(canvas.ws)
    expect(text).not.toContain('Report canvas')
  })

  it('refused on any page but the latched crashed one: a stopped canvas\'s page', async () => {
    const inst = (await w.tab(canvas.id)).reg!.instance
    await w.run.call('fake:gone', { instance: inst })
    await sleep(200)
    expect(await w.run.call('page', { tab: canvas.id })).toMatchObject({ body: { page: 'stopped' } })
    const since = (await w.log()).length
    expect(await w.run.call('tabpage:action', { tab: canvas.id, action: 'export-report' })).toBe(false)
    expect((await w.log('tabpage', since)).map((l) => l.data)).toContainEqual({ refused: 'export-report', page: 'stopped' })
    expect(await w.log('report', since)).toEqual([])
  })
})
