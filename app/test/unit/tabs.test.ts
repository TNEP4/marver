/**
 * The tab model (spec 28 A2.3, A2.4, A2.14 #8, #10, #20, #23, v1.12 r1 #1, #5, v1.13 r2 #3, #5): the display
 * state, the order and the keys, tabs.json's shape and restore, the registry's rebind rules and the document's
 * commits - pure, with fake ports.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  activeTab, allTabs, applyRestore, canvasOrder, cycleFrom, displayState, forDigit, getTab, keyOf, onCommit, onFail, onRegistry,
  onReport, openSettingsTab, ordered, parseTabsFile, restorePlan, safePath, snapshotFile, takeReopen, viewOf, wantsLoad, type TabsFile,
} from '../../src/main/tabs.ts'
import { entry, liveTab, show, world, type World } from './window-fakes.ts'

let w: World
beforeEach(() => { w = world() })

const add = (o: Parameters<typeof entry>[0] = {}) => { const e = entry(o); onRegistry({ kind: 'entry', entry: e }); return { e, t: allTabs().find((x) => x.reg?.instance === e.instance)! } }

describe('the order and the keys (A2.4, A2.14 #23)', () => {
  it('Home, canvases by slot, explicit ports by port, a grey tab after a live one on its slot, Settings last', () => {
    const p = add({ slot: null, port: 41000 })
    const s3 = add({ slot: 3 })
    const s1 = add({ slot: 1 })
    const grey = add({ slot: 3 })
    onRegistry({ kind: 'gone', file: grey.e.file, instance: grey.e.instance, why: 'pid' })
    grey.t.retained = true; grey.t.view = 'live'   // a kept page keeps its grey tab
    openSettingsTab(false)
    expect(ordered().map((t) => t.id)).toEqual(['home', s1.t.id, s3.t.id, grey.t.id, p.t.id, 'settings'])
  })

  it('⌘1-⌘8 are the first eight canvas tabs, ⌘9 the last; keys follow', () => {
    const tabs = Array.from({ length: 11 }, (_, i) => add({ slot: i + 1 }).t)
    expect(forDigit(1)?.id).toBe(tabs[0]!.id)
    expect(forDigit(8)?.id).toBe(tabs[7]!.id)
    expect(forDigit(9)?.id).toBe(tabs[10]!.id)
    expect(tabs.map((t) => keyOf(t))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, undefined, undefined, 9])
  })

  it('with three canvases ⌘9 is the third; Settings and Home have no key', () => {
    const tabs = [add().t, add().t, add().t]
    openSettingsTab(false)
    expect(forDigit(9)?.id).toBe(tabs[2]!.id)
    expect(keyOf(getTab('settings')!)).toBeUndefined()
    expect(canvasOrder().length).toBe(3)
  })

  it('⌃Tab cycles every open tab, Home and Settings included, wrapping', () => {
    const a = add().t
    openSettingsTab(false)
    expect(cycleFrom('home', 1)?.id).toBe(a.id)
    expect(cycleFrom(a.id, 1)?.id).toBe('settings')
    expect(cycleFrom('settings', 1)?.id).toBe('home')
    expect(cycleFrom('home', -1)?.id).toBe('settings')
  })

  it('a tab closed for its run is out of the order but stays in the model (Home lists it)', async () => {
    const t = liveTab(w)
    t.retained = false
    const { closeTab } = await import('../../src/main/tabs.ts')
    await closeTab(t.id)
    expect(ordered().some((x) => x.id === t.id)).toBe(false)
    expect(viewOf(t, false, '/Users/nic').open).toBe(false)
  })
})

describe('the display state (A2.4, a pure function of the record)', () => {
  it('starting, none, live and hidden, gone, unverified, unreachable, crashed', () => {
    const s = add({ state: 'starting', origin: null }).t
    expect(displayState(s, true)).toBe('starting')
    const t = add().t
    expect(displayState(t, true)).toBe('none')
    t.view = 'live'
    expect(displayState(t, true)).toBe('live')
    expect(displayState(t, false)).toBe('hidden')
    t.fail = { why: 'unverified', at: 1 }
    expect(displayState(t, true)).toBe('unverified')
    t.fail = { why: 'unreachable', at: 1 }
    expect(displayState(t, true)).toBe('unreachable')
    t.fail = undefined
    t.view = 'crashed'
    expect(displayState(t, true)).toBe('crashed')
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
    expect(displayState(t, true)).toBe('gone')
  })

  it('an unverified tab is named by its address and wears no logo (frame 05)', () => {
    const t = add({ port: 40808, name: 'Hertz' }).t
    t.logo = 'data:image/png;base64,AAAA'
    t.fail = { why: 'unverified', at: 1 }
    const v = viewOf(t, true, '/Users/nic')
    expect(v.name).toBe('localhost:40808')
    expect(v.logo).toBeUndefined()
    expect(v.folder).toMatch(/^\/Users\/nic|^~/)
  })

  it('a TabView carries no instance, ws, origin or key, and the folder with ~', () => {
    const t = add({ root: '/Users/nic/tms broker' }).t
    const v = viewOf(t, true, '/Users/nic')
    expect(v.folder).toBe('~/tms broker')
    const s = JSON.stringify(v)
    expect(s).not.toContain(t.reg!.instance)
    expect(s).not.toContain(t.reg!.ws)
    expect(s).not.toContain('[::1]')
  })
})

describe('tabs.json (v1.12 r1 #5)', () => {
  const WS_A = 'aaaaaaaaaaaaaaaa'
  const file = (o: Partial<TabsFile> = {}): TabsFile => ({ v: 1, active: { kind: 'home' }, canvases: [], settings: false, closed: [], ...o })

  it('checks its shape: another v, a bad active, a bad entry, a long path are refused or cleaned', () => {
    expect(parseTabsFile(file())).toEqual(file())
    expect(parseTabsFile({ ...file(), v: 2 })).toBeNull()
    expect(parseTabsFile({ ...file(), active: { kind: 'canvas', ws: 'nope', origin: 'http://[::1]:1' } })).toBeNull()
    expect(parseTabsFile({ ...file(), canvases: [{ ws: WS_A, origin: 'http://evil.example', path: '/', shownAt: 1 }] })).toBeNull()
    expect(parseTabsFile(file({ canvases: [{ ws: WS_A, origin: 'http://[::1]:4806', path: '/../x', shownAt: 1 }] }))!.canvases[0]!.path).toBe('/')
    expect(parseTabsFile('[]')).toBeNull()
    expect(safePath('/index.html?x=1#/b/a')).toBe('/index.html?x=1#/b/a')
    expect(safePath('/other')).toBe('/')
    expect(safePath(`/#${'x'.repeat(2100)}`)).toBe('/')
  })

  it('a grey old-origin active tab beside a live new-origin tab of the same workspace: Home active, the live tab on its own saved path', () => {
    const live = entry({ ws: WS_A, port: 40806, origin: 'http://[::1]:40806' })
    const f = file({
      active: { kind: 'canvas', ws: WS_A, origin: 'http://[::1]:40805' },
      canvases: [
        { ws: WS_A, origin: 'http://[::1]:40805', path: '/#/b/old', shownAt: 20 },
        { ws: WS_A, origin: 'http://[::1]:40806', path: '/#/b/new', shownAt: 10 },
      ],
    })
    const p = restorePlan(f, [live], { restore: true, firstLaunch: false })
    expect(p.active).toEqual({ kind: 'home' })
    expect(p.canvases.map((c) => c.path)).toEqual(['/#/b/new'])
  })

  it('a canvas that moved slot takes the latest shown entry of its workspace', () => {
    const moved = entry({ ws: WS_A, port: 40809, origin: 'http://[::1]:40809' })
    const f = file({ canvases: [{ ws: WS_A, origin: 'http://[::1]:40805', path: '/#/b/a', shownAt: 5 }, { ws: WS_A, origin: 'http://[::1]:40807', path: '/#/b/b', shownAt: 9 }] })
    expect(restorePlan(f, [moved], { restore: true, firstLaunch: false }).canvases[0]!.path).toBe('/#/b/b')
  })

  it('Home and Settings restore as active; the exact running canvas too; a closed run stays closed', () => {
    const e = entry({ ws: WS_A })
    expect(restorePlan(file({ active: { kind: 'settings' } }), [e], { restore: true, firstLaunch: false }).active).toEqual({ kind: 'settings' })
    expect(restorePlan(file({ active: { kind: 'canvas', ws: WS_A, origin: e.origin! } }), [e], { restore: true, firstLaunch: false }).active).toEqual({ kind: 'canvas', instance: e.instance })
    const closed = restorePlan(file({ closed: [{ ws: WS_A, instance: e.instance }] }), [e], { restore: true, firstLaunch: false })
    expect(closed.canvases[0]!.open).toBe(false)
    expect(closed.closed).toEqual([{ ws: WS_A, instance: e.instance }])
  })

  it('restoreTabs false: nothing read, every running canvas at /, a closed one included, Home active; the first launch is Home', () => {
    const e = entry({ ws: WS_A })
    const f = file({ active: { kind: 'canvas', ws: WS_A, origin: e.origin! }, closed: [{ ws: WS_A, instance: e.instance }], canvases: [{ ws: WS_A, origin: e.origin!, path: '/#/b/x', shownAt: 1 }] })
    const off = restorePlan(f, [e], { restore: false, firstLaunch: false })
    expect(off).toMatchObject({ active: { kind: 'home' }, canvases: [{ path: '/', open: true }] })
    expect(restorePlan(f, [e], { restore: true, firstLaunch: true }).active).toEqual({ kind: 'home' })
  })

  it('applied, then written back: the active canvas by (ws, origin), its path, the closes of runs still known', () => {
    const e = entry({ ws: WS_A })
    applyRestore(restorePlan(file({ active: { kind: 'canvas', ws: WS_A, origin: e.origin! }, canvases: [{ ws: WS_A, origin: e.origin!, path: '/#/b/x', shownAt: 1 }] }), [e], { restore: true, firstLaunch: false }))
    expect(activeTab()?.reg?.instance).toBe(e.instance)
    const out = snapshotFile(null, 5)
    expect(out.active).toEqual({ kind: 'canvas', ws: WS_A, origin: e.origin })
    expect(out.canvases[0]).toMatchObject({ ws: WS_A, origin: e.origin, path: '/#/b/x' })
    expect(parseTabsFile(JSON.parse(JSON.stringify(out)))).toEqual(out)
  })
})

describe('the registry (A2.3, A2.14 #10, v1.12 r1 #3, v1.13 r2 #5)', () => {
  it('a starting entry binds by workspace and port, and loads at ready when it is the active tab', () => {
    const e = entry({ state: 'starting', origin: null })
    onRegistry({ kind: 'entry', entry: e })
    const t = allTabs().find((x) => x.reg?.instance === e.instance)!
    show(t.id)
    expect(w.loads).toEqual([])
    onRegistry({ kind: 'entry', entry: { ...e, state: 'ready', origin: `http://[::1]:${e.port}` } })
    expect(w.loads).toEqual([t.id])
    expect(allTabs().filter((x) => x.kind === 'local')).toHaveLength(1)
  })

  it('a canvas that stops goes grey, keeps its tab and its page, and loses its trust at once', () => {
    const t = liveTab(w)
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
    expect(getTab(t.id)).toBe(t)
    expect(t.reg!.state).toBe('gone')
    expect(t.doc!.trusted).toBe(false)
    expect(t.reports.safety).toBe('stale')
    expect(w.states).toEqual([{ tab: t.id, s: 'untrusted' }])
  })

  it('a new instance on the same origin rebinds the tab; a live page is left to its own reload', () => {
    const t = liveTab(w)
    const next = { ...entry({ ws: t.reg!.ws, port: t.reg!.port, origin: t.reg!.origin!, slot: t.reg!.slot }), instance: 'new-inst' }
    onRegistry({ kind: 'entry', entry: next })
    expect(allTabs().filter((x) => x.kind === 'local')).toEqual([t])
    expect(t.reg!.instance).toBe('new-inst')
    expect(t.doc!.trusted).toBe(false)
    expect(w.loads).toEqual([])
  })

  it('a server restart: a never-shown tab gets no load and no view until shown; the active documentless tab loads at once; a latched tab stays latched', () => {
    const never = add().t
    const active = add().t
    show(active.id)
    w.loads.length = 0
    const latched = add().t
    latched.view = 'crashed'; latched.crash.latched = true
    for (const t of [never, active, latched]) {
      onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
      onRegistry({ kind: 'entry', entry: { ...entry({ ws: t.reg!.ws, port: t.reg!.port, origin: t.reg!.origin!, slot: t.reg!.slot }), instance: `${t.id}-2` } })
    }
    expect(w.loads).toEqual([active.id])
    expect(never.view).toBe('none')
    expect(latched.crash.latched).toBe(true)
    expect(wantsLoad(latched)).toBe(false)
    show(latched.id)
    expect(w.loads).toEqual([active.id])
  })

  it('a grey tab with no live document is rebound by a new instance of its workspace on another origin', () => {
    const t = add().t
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
    const other = entry({ ws: t.reg!.ws })
    onRegistry({ kind: 'entry', entry: other })
    expect(allTabs().filter((x) => x.kind === 'local')).toEqual([t])
    expect(t.reg!.origin).toBe(other.origin)
  })

  it('a grey tab with a live page stays grey; a new instance on another origin gets its own tab', () => {
    const t = liveTab(w)
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
    onRegistry({ kind: 'entry', entry: entry({ ws: t.reg!.ws }) })
    expect(allTabs().filter((x) => x.kind === 'local')).toHaveLength(2)
    expect(t.reg!.state).toBe('gone')
  })

  it('another workspace on the same origin is another tab', () => {
    const t = liveTab(w)
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
    onRegistry({ kind: 'entry', entry: entry({ ws: 'ffffffffffffffff', port: t.reg!.port, origin: t.reg!.origin! }) })
    expect(allTabs().filter((x) => x.kind === 'local')).toHaveLength(2)
  })

  it('a closed tab stays closed for its canvas\'s run; a new instance opens it again; one whose canvas stops is dropped', async () => {
    const t = liveTab(w)
    t.retained = false
    const { closeTab } = await import('../../src/main/tabs.ts')
    await closeTab(t.id)
    expect(t.open).toBe(false)
    onRegistry({ kind: 'entry', entry: { ...entry({ ws: t.reg!.ws, port: t.reg!.port, origin: t.reg!.origin!, slot: t.reg!.slot }), instance: 'again' } })
    expect(t.open).toBe(true)
    await closeTab(t.id)
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: 'again', why: 'removed' })
    expect(getTab(t.id)).toBeUndefined()
  })
})

describe('the document (A2.14 #8, v1.12 r1 #1, v1.13 r2 #3)', () => {
  it('an attributed commit lifts: trusted, admitted, retained, the failure gone, the path from the URL', () => {
    const t = add().t
    t.fail = { why: 'unreachable', at: 1 }
    onCommit(t, { gen: 2, url: `${t.reg!.origin}/index.html?x=1#/b/plans`, attributed: true, admitted: 'doc-1' })
    expect(t.doc).toMatchObject({ trusted: true, doc: 'doc-1', lifted: true, commits: 1 })
    expect(t.retained).toBe(true)
    expect(t.fail).toBeUndefined()
    expect(t.path).toBe('/index.html?x=1#/b/plans')
    expect(t.reports.safety).toBe('unknown')
  })

  it('an unattributed commit is untrusted, never admitted, not retained', () => {
    const t = add().t
    onCommit(t, { gen: 1, url: `${t.reg!.origin}/`, attributed: false, admitted: null })
    expect(t.doc).toMatchObject({ trusted: false, lifted: false })
    expect(t.doc!.doc).toBeUndefined()
    expect(t.retained).toBe(false)
    expect(t.unattributed).toBe(1)
  })

  it('reports: only from the admitted document; incoherent busy refused; the first busy makes it fresh', () => {
    const t = liveTab(w, { busy: null })
    onReport(t.id, 'doc-other', { busy: { busy: true, unsaved: true, why: ['typing'] } })
    expect(t.reports.safety).toBe('unknown')
    onReport(t.id, t.doc!.doc!, { busy: { busy: true, unsaved: false, why: ['typing'] } })
    expect(t.reports.safety).toBe('unknown')
    onReport(t.id, t.doc!.doc!, { busy: { busy: true, unsaved: false, why: ['jam-session'] } })
    expect(t.reports).toMatchObject({ safety: 'fresh', busy: { unsaved: false } })
    onReport(t.id, t.doc!.doc!, { theme: { dark: true } })
    expect(t.look).toBe(true)
  })

  it('a failure revokes the committed document\'s trust; an error page committed ends retained', () => {
    const t = liveTab(w)
    const before = t.doc!.commits
    onFail(t, { why: 'unverified', code: -20, errorPage: false })
    expect(t.doc!.commits).toBe(before + 1)
    expect(t.retained).toBe(true)
    expect(t.probe).toEqual({ state: 'none', lastAt: null })
    onFail(t, { why: 'unverified', code: -20, errorPage: true })
    expect(t.retained).toBe(false)
  })

  it('mv:doc\'s reopen is one-shot', () => {
    const t = add().t
    t.reopen = true
    expect(takeReopen(t.id)).toBe(true)
    expect(takeReopen(t.id)).toBe(false)
  })
})
