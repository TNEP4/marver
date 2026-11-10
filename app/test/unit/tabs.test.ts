/**
 * The tab model (spec 28 A2.3, A2.4, A2.14 #8, #10, #20, #23, v1.12 r1 #1, #5, v1.13 r2 #3, #5): the display
 * state, the order and the keys, tabs.json's shape and restore, the registry's rebind rules and the document's
 * commits - pure, with fake ports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenItem } from '../../../src/shared/app-api.ts'
import { T } from '../../src/main/timings.ts'
import {
  activate, activeTab, addressOf, allTabs, applyRestore, canLoad, canvasOrder, closeTab, cycleFrom, displayState, forDigit, getTab, guard, guardAll, guarded, hashOnly, keptDoc, keyOf, onCommit,
  onDocumentGone, onFail, onInPage, onRegistry, onRemoteCommit, onReport, onUnloaded, openForNotice, openRemoteTab, openSettingsTab, ordered, parseTabsFile, remoteLinkPlan, remoteTab,
  restorePlan, safePath, setOpenSender, snapshotFile, tabIdent, unloadRefusal, viewOf, wantsLoad,
  type GuardAnswer, type Tab, type TabsFile,
} from '../../src/main/tabs.ts'
import { hueOf } from '../../src/shared/hue.ts'
import { deferred, entry, flush, liveTab, sharedTab, show, world, type Deferred, type World } from './window-fakes.ts'

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

  it('a TabView says whether the slot file offers the bridge, as the guard reads it - not from the version', () => {
    // 0.27.1's code before its release still reads 0.27.0, and a 0.27.0 slot file lists no features
    expect(viewOf(add({ version: '0.27.0', features: ['bridge'] }).t, true, '/Users/nic').bridge).toBe(true)
    expect(viewOf(add({ version: '0.27.0', features: [] }).t, true, '/Users/nic').bridge).toBe(false)
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

  it('a canvas not running at launch gets no tab; when it starts, its tab opens on its saved board (A2.14 #23)', () => {
    const later = entry({ ws: WS_A })
    w.saved = file({ canvases: [{ ws: WS_A, origin: 'http://[::1]:40805', path: '/#/b/older', shownAt: 30 }, { ws: WS_A, origin: later.origin!, path: '/#/b/mine', shownAt: 10 }] })
    applyRestore(restorePlan(w.saved, [], { restore: true, firstLaunch: false }))
    expect(allTabs().filter((x) => x.kind === 'local')).toHaveLength(0)
    onRegistry({ kind: 'entry', entry: later })
    const t = allTabs().find((x) => x.reg?.instance === later.instance)!
    expect(t.path).toBe('/#/b/mine')   // its own (ws, origin) entry, not the latest of its workspace
    // one that moved slot takes the latest shown entry of its workspace
    const moved = entry({ ws: 'bbbbbbbbbbbbbbbb' })
    w.saved = file({ canvases: [{ ws: 'bbbbbbbbbbbbbbbb', origin: 'http://[::1]:40805', path: '/#/b/a', shownAt: 5 }, { ws: 'bbbbbbbbbbbbbbbb', origin: 'http://[::1]:40806', path: '/#/b/b', shownAt: 9 }] })
    onRegistry({ kind: 'entry', entry: moved })
    expect(allTabs().find((x) => x.reg?.instance === moved.instance)!.path).toBe('/#/b/b')
    // restoreTabs off (nothing read): at /
    w.saved = null
    const off = entry({ ws: 'cccccccccccccccc' })
    onRegistry({ kind: 'entry', entry: off })
    expect(allTabs().find((x) => x.reg?.instance === off.instance)!.path).toBe('/')
  })

  it('one that starts after launch, still starting: its workspace\'s latest entry, then its own at ready; a link\'s path is kept', () => {
    const s = entry({ ws: WS_A, state: 'starting', origin: null })
    const origin = `http://[::1]:${s.port}`
    w.saved = file({ canvases: [{ ws: WS_A, origin: 'http://[::1]:40805', path: '/#/b/latest', shownAt: 30 }, { ws: WS_A, origin, path: '/#/b/own', shownAt: 10 }] })
    onRegistry({ kind: 'entry', entry: s })
    const t = allTabs().find((x) => x.reg?.instance === s.instance)!
    expect(t.path).toBe('/#/b/latest')
    onRegistry({ kind: 'entry', entry: { ...s, state: 'ready', origin } })
    expect(t.path).toBe('/#/b/own')
    const s2 = entry({ ws: 'dddddddddddddddd', state: 'starting', origin: null })
    w.saved = file({ canvases: [{ ws: 'dddddddddddddddd', origin: `http://[::1]:${s2.port}`, path: '/#/b/saved', shownAt: 1 }] })
    onRegistry({ kind: 'entry', entry: s2 })
    const t2 = allTabs().find((x) => x.reg?.instance === s2.instance)!
    t2.path = '/#/b/from-a-link'   // ⌘L to a canvas still starting keeps the link's path (A2.14 #24)
    onRegistry({ kind: 'entry', entry: { ...s2, state: 'ready', origin: `http://[::1]:${s2.port}` } })
    expect(t2.path).toBe('/#/b/from-a-link')
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

  it('a quit\'s or an update\'s sweep is never the person\'s closes: no closed run added, the snapshot after done the one before (A5.1 #20)', async () => {
    for (const kind of ['quit', 'update'] as const) {
      w = world()
      const a = liveTab(w)
      liveTab(w, { entry: { ws: 'ab'.repeat(8) } })
      const c = liveTab(w)
      // the act as views.ts's closes a view (the person's close, a quit's, an update's): the page closes, its document gone
      w.actWith = (t) => { onDocumentGone(t, 'none'); return 'done' }
      expect(await closeTab(c.id)).toBe('closed')                  // the person's close: a closed run
      show(a.id)
      a.path = '/#/b/kept'
      const before = snapshotFile(null, 77)
      expect(before.closed).toHaveLength(1)
      w.acts.length = 0
      expect(await guardAll({ kind })).toBe('done')
      expect(w.acts.map((x) => x.action.kind)).toEqual([kind, kind])
      expect(allTabs().filter((t) => t.kind === 'local').every((t) => t.open || t.id === c.id)).toBe(true)
      expect(snapshotFile(null, 77)).toEqual(before)
    }
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

  it('a second instance of a running canvas\'s workspace (another slot, or --port) gets its own tab; the first keeps its own', () => {
    const a = liveTab(w)
    const never = add({ ws: 'abcdefabcdefabcd' }).t   // a running canvas whose tab was never shown: no live document
    const b = entry({ ws: a.reg!.ws })
    onRegistry({ kind: 'entry', entry: b })
    const c = entry({ ws: 'abcdefabcdefabcd', slot: null, port: 41999, origin: 'http://[::1]:41999' })
    onRegistry({ kind: 'entry', entry: c })
    expect(allTabs().filter((x) => x.kind === 'local')).toHaveLength(4)
    expect(a.reg!.instance).not.toBe(b.instance)
    expect(never.reg!.instance).not.toBe(c.instance)
    expect(never.reg!.state).toBe('ready')
    // each is still reachable, and a later stop finds its own tab
    onRegistry({ kind: 'gone', file: never.reg!.file, instance: never.reg!.instance, why: 'pid' })
    expect(never.reg!.state).toBe('gone')
    expect(allTabs().find((x) => x.reg?.instance === c.instance)!.reg!.state).toBe('ready')
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

  it('the path keeps the committed hash: the adapter\'s URL has none, the href of the same document does', () => {
    // a restored tab loads /#/b/plans; the real adapter reports the commit without its fragment (nav.ts noHash)
    const t = add().t
    t.path = '/#/b/plans'
    onCommit(t, { gen: 1, url: `${t.reg!.origin}/`, href: `${t.reg!.origin}/#/b/plans`, attributed: true, admitted: 'doc-1' })
    expect(t.path).toBe('/#/b/plans')
    // an href of another document (not this commit's URL without its hash) is never taken
    onCommit(t, { gen: 2, url: `${t.reg!.origin}/`, href: `${t.reg!.origin}/other#/b/x`, attributed: true, admitted: 'doc-2' })
    expect(t.path).toBe('/')
  })

  it('an unattributed commit is untrusted, never admitted, not retained', () => {
    const t = add().t
    onCommit(t, { gen: 1, url: `${t.reg!.origin}/`, attributed: false, admitted: null })
    expect(t.doc).toMatchObject({ trusted: false, lifted: false })
    expect(t.doc!.doc).toBeUndefined()
    expect(t.retained).toBe(false)
    expect(t.unattributed).toBe(1)
  })

  it('an attributed commit the bridge would not admit (its isTrusted said no) is untrusted: not lifted, its reports never accepted', () => {
    const t = add().t
    onCommit(t, { gen: 1, url: `${t.reg!.origin}/`, attributed: true, admitted: null })
    expect(t.doc).toMatchObject({ trusted: false, lifted: false })
    expect(t.doc!.doc).toBeUndefined()
    expect(t.retained).toBe(false)
    expect(t.unattributed).toBe(1)
  })

  it('the bridge says a document went stale: its trust goes with it - the items gated on it disabled (A2.14 #24)', () => {
    const t = liveTab(w)
    onReport(t.id, t.doc!.doc!, { menu: [{ id: 'fit-all', group: 'view', label: 'Fit All' }] })
    expect(viewOf(t, true, '/Users/nic').verified).toBe(true)
    onReport(t.id, t.doc!.doc!, { safety: 'stale' })
    expect(t.doc!.trusted).toBe(false)
    expect(t.reports).toMatchObject({ safety: 'stale', menu: undefined })
    expect(viewOf(t, true, '/Users/nic').verified).toBe(false)
    // nothing it says after counts
    onReport(t.id, t.doc!.doc!, { busy: { busy: false, unsaved: false, why: [] } })
    expect(t.reports.safety).toBe('stale')
  })

  it('spec 32 C2: the immersive wish is stored by onReport, the latest whole, from the admitted trusted document alone; the grant and the answer reset with the reports at a commit', () => {
    const t = liveTab(w)
    onReport(t.id, 'doc-other', { immersive: { on: true, n: 1 } })
    expect(t.reports.immersive).toBeUndefined()
    onReport(t.id, t.doc!.doc!, { immersive: { on: true, n: 1 } })
    expect(t.reports.immersive).toEqual({ on: true, n: 1 })
    onReport(t.id, t.doc!.doc!, { theme: { dark: false } })                      // another report keeps the wish
    expect(t.reports.immersive).toEqual({ on: true, n: 1 })
    onReport(t.id, t.doc!.doc!, { immersive: { on: false, n: 2 } })
    expect(t.reports.immersive).toEqual({ on: false, n: 2 })
    // what the gate writes (views.ts, W2) lives on the reports, so a new document - a reload while ended - starts at none
    t.reports.immersiveGrant = 'ended'
    t.reports.immersiveAnswered = 2
    onCommit(t, { gen: 2, url: `${t.reg!.origin}/`, attributed: true, admitted: `doc-${t.id}-2` })
    expect([t.reports.immersive, t.reports.immersiveGrant, t.reports.immersiveAnswered]).toEqual([undefined, undefined, undefined])
    // an untrusted document's wish is not kept
    onReport(t.id, t.doc!.doc!, { safety: 'stale' })
    onReport(t.id, t.doc!.doc!, { immersive: { on: true, n: 3 } })
    expect(t.reports.immersive).toBeUndefined()
  })

  it('spec 32 F1: a hung tab says so in its view (Home\'s "Not responding"); absent otherwise', () => {
    const t = liveTab(w)
    expect(viewOf(t, true, '/Users/nic').hung).toBeUndefined()
    t.hung = true
    expect(viewOf(t, false, '/Users/nic').hung).toBe(true)
    t.hung = false
    expect('hung' in viewOf(t, true, '/Users/nic')).toBe(false)
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

  it('a link changes only the hash when it names one and the page\'s current URL is the same without it', () => {
    const at = 'http://[::1]:40100/#/b/x'
    expect(hashOnly(at, 'http://[::1]:40100/#/b/y')).toBe(true)
    expect(hashOnly(at, at)).toBe(true)
    expect(hashOnly('http://[::1]:40100/', 'http://[::1]:40100/#/b/y')).toBe(true)
    // no hash: Electron 45 loads it as a new document - the guard's
    expect(hashOnly(at, 'http://[::1]:40100/')).toBe(false)
    expect(hashOnly(at, 'http://[::1]:40100/#')).toBe(false)
    expect(hashOnly(at, 'http://[::1]:40100/index.html#/b/x')).toBe(false)
    expect(hashOnly(at, 'http://[::1]:40100/?q=1#/b/x')).toBe(false)
    expect(hashOnly('', 'http://[::1]:40100/#/b/x')).toBe(false)
  })

})

describe('a notice\'s click, held for its tab\'s document (A4.6 #29)', () => {
  const OPEN = ['bridge', 'inset', 'live', 'open']
  const item = (n = 1): OpenItem => ({ id: `ask:${String(n).padStart(20, '0')}`, kind: 'ask', board: 'main', thread: `t${n}`, msg: `m${n}` })
  const hello = (t: Tab) => onReport(t.id, t.doc!.doc!, { hello: { version: '0.29.0', board: 'main', page: 'PAGE_0123456789' } })
  let sent: { tab: string; doc?: string; id: string }[]
  beforeEach(() => { sent = []; setOpenSender((t, it) => { sent.push({ tab: t.id, doc: t.doc?.doc, id: it.id }); return true }) })
  afterEach(() => { setOpenSender(null); vi.useRealTimers() })

  it('a document that has said hello takes it at once, once', () => {
    const t = liveTab(w, { entry: { features: OPEN } })
    hello(t)
    show('home')
    openForNotice(t.id, item())
    expect(activeTab()).toBe(t)
    expect(sent).toEqual([{ tab: t.id, doc: t.doc!.doc, id: item().id }])
    expect(t.pendingOpen).toBeUndefined()
    hello(t)   // its hello again (accepted once): nothing more
    expect(sent).toHaveLength(1)
  })

  it('a never-shown tab loads first; the click goes after its document\'s hello, to that document alone', () => {
    const { t } = add({ features: OPEN })
    openForNotice(t.id, item())
    expect(w.loads).toEqual([t.id])
    expect(sent).toEqual([])
    t.view = 'live'
    onCommit(t, { gen: 1, url: `${t.reg!.origin}/`, attributed: true, admitted: 'doc-new' })
    expect(sent).toEqual([])   // admitted, no hello yet
    hello(t)
    expect(sent).toEqual([{ tab: t.id, doc: 'doc-new', id: item().id }])
  })

  it('an unloaded tab reopens, then its reopened document takes it', () => {
    const t = liveTab(w, { entry: { features: OPEN } })
    show('home')
    t.view = 'unloaded'
    t.unload = { phase: 'unloaded', reason: 'warn', at: 1, commit: t.doc!.commits, origin: t.reg!.origin!, unloadedAt: 1 }
    t.doc!.trusted = false
    openForNotice(t.id, item())
    expect(w.reopens).toEqual([t.id])
    expect(sent).toEqual([])
    t.view = 'live'
    onCommit(t, { gen: 2, url: `${t.reg!.origin}/`, attributed: true, admitted: 'doc-reopened' })
    hello(t)
    expect(sent).toEqual([{ tab: t.id, doc: 'doc-reopened', id: item().id }])
  })

  describe('clicked while an unload closes its document', () => {
    /** a hidden canvas past unloadMinHiddenMs, its unload held at closing: the act answers when the case says */
    async function closing(): Promise<{ t: Tab; gate: Deferred<GuardAnswer>; u: Promise<GuardAnswer> }> {
      const t = liveTab(w, { entry: { features: OPEN } })
      hello(t)
      show('home')
      w.clock.now += T.unloadMinHiddenMs
      let gate!: Deferred<GuardAnswer>
      w.actWith = (_t, a) => { if (a.kind !== 'unload') return 'done'; gate = deferred<GuardAnswer>(); return gate.promise }
      const u = guard(t, { kind: 'unload', reason: 'warn' })
      await flush()
      expect(t.unload?.phase).toBe('closing')
      return { t, gate, u }
    }

    it('held from the closing document; the reopened document takes it at its hello', async () => {
      const { t, gate, u } = await closing()
      const old = t.doc!.doc
      openForNotice(t.id, item())
      expect(sent).toEqual([])   // never to a document about to be destroyed
      expect(t.pendingOpen).toBeDefined()
      onUnloaded(t)
      gate.resolve('done')
      expect(await u).toBe('done')
      await flush()
      expect(w.reopens).toEqual([t.id])
      t.view = 'live'
      onCommit(t, { gen: 2, url: `${t.reg!.origin}/`, attributed: true, admitted: 'doc-reopened' })
      hello(t)
      expect(sent).toEqual([{ tab: t.id, doc: 'doc-reopened', id: item().id }])
      expect(sent.some((s) => s.doc === old)).toBe(false)
    })

    it('the page refuses the unload: the kept document takes it with its shown', async () => {
      const { t, gate, u } = await closing()
      openForNotice(t.id, item())
      expect(sent).toEqual([])
      gate.resolve('refused')
      expect(await u).toBe('refused')
      expect(w.states.filter((s) => s.tab === t.id && s.s === 'shown')).toHaveLength(1)
      expect(sent).toEqual([{ tab: t.id, doc: t.doc!.doc, id: item().id }])
      expect(t.pendingOpen).toBeUndefined()
    })
  })

  it('dropped after openWaitMs, and when another tab is activated', () => {
    vi.useFakeTimers()
    const a = add({ features: OPEN }).t
    openForNotice(a.id, item())
    vi.advanceTimersByTime(T.openWaitMs)
    expect(a.pendingOpen).toBeUndefined()
    a.view = 'live'
    onCommit(a, { gen: 1, url: `${a.reg!.origin}/`, attributed: true, admitted: 'doc-late' })
    hello(a)
    expect(sent).toEqual([])
    const b = add({ features: OPEN }).t
    openForNotice(b.id, item(2))
    expect(b.pendingOpen).toBeDefined()
    show(a.id)
    expect(b.pendingOpen).toBeUndefined()
    expect(w.logs.filter((l) => l.topic === 'open' && l.data.dropped).map((l) => l.data.dropped)).toEqual(['wait', 'another tab'])
  })

  it('a later click replaces an earlier one; a canvas without open, and a stop\'s click, are only shown', () => {
    const { t } = add({ features: OPEN })
    openForNotice(t.id, item(1))
    openForNotice(t.id, item(2))
    t.view = 'live'
    onCommit(t, { gen: 1, url: `${t.reg!.origin}/`, attributed: true, admitted: 'doc-1' })
    hello(t)
    expect(sent.map((s) => s.id)).toEqual([item(2).id])
    const old = liveTab(w, { entry: { features: ['bridge', 'inset', 'live'] } })   // a 0.29 canvas without open: never
    hello(old)
    show('home')
    openForNotice(old.id, item(3))
    expect(activeTab()).toBe(old)
    expect(old.pendingOpen).toBeUndefined()
    show('home')
    openForNotice(old.id, null)
    expect(activeTab()).toBe(old)
    expect(sent).toHaveLength(1)
  })

  it('a stop\'s click after an item\'s, before the document\'s hello: the item is superseded, never delivered (code review r2 P2)', () => {
    const { t } = add({ features: OPEN })
    openForNotice(t.id, item(1))
    expect(t.pendingOpen).toBeDefined()
    openForNotice(t.id, null)
    expect(t.pendingOpen).toBeUndefined()
    t.view = 'live'
    onCommit(t, { gen: 1, url: `${t.reg!.origin}/`, attributed: true, admitted: 'doc-1' })
    hello(t)
    expect(sent).toEqual([])
    expect(w.logs.filter((l) => l.topic === 'open' && l.data.dropped).map((l) => [l.data.id, l.data.dropped])).toEqual([[item(1).id, 'superseded']])
  })

  it('a tab closed since is reopened for this run; an untrusted document never takes the click', async () => {
    const t = liveTab(w, { entry: { features: OPEN } })
    t.retained = false
    await closeTab(t.id)
    expect(t.open).toBe(false)
    openForNotice(t.id, item())
    expect(t.open).toBe(true)
    expect(activeTab()).toBe(t)
    t.doc!.trusted = false
    hello(t)
    expect(sent).toEqual([])
  })
})

describe('shared canvases (A4.6 #39, #42, #47-#49, r1 #9)', () => {
  it('one tab per origin, named by its host, after the local canvases in the order opened; ⌘1-⌘9, ⌃Tab and » reach them', () => {
    const a = add({ slot: 2 }).t
    const r1 = sharedTab(w, 'https://pilot.example.com/#/b/main')
    const r2 = sharedTab(w, 'https://other.example.org:8443/')
    const b = add({ slot: 1 }).t
    openSettingsTab(false)
    expect(ordered().map((t) => t.id)).toEqual(['home', b.id, a.id, r1.id, r2.id, 'settings'])
    expect(canvasOrder().map((t) => t.id)).toEqual([b.id, a.id, r1.id, r2.id])
    expect(forDigit(9)?.id).toBe(r2.id)
    expect([r1, r2].map((t) => keyOf(t))).toEqual([3, 4])
    expect(cycleFrom(r2.id, 1)?.id).toBe('settings')
    expect(remoteTab('https://pilot.example.com')).toBe(r1)
    expect(remoteTab('https://pilot.example.com:8443')).toBeUndefined()
    expect([r1.name, r2.name]).toEqual(['pilot.example.com', 'other.example.org:8443'])
  })

  it('its TabView: the host, never verified, its place as the link, initials on the host\'s hue - no marks, folder, version or bridge', () => {
    const r = sharedTab(w, 'https://pilot.example.com/#/b/main')
    expect(viewOf(r, true, '/Users/nic')).toEqual({
      id: r.id, kind: 'remote', name: 'pilot.example.com', state: 'live', verified: false, open: true, key: 1,
      link: 'https://pilot.example.com/#/b/main', hue: hueOf('pilot.example.com'),
    })
    r.logo = 'data:image/png;base64,AAAA'
    expect(viewOf(r, false, '/Users/nic')).toMatchObject({ state: 'hidden', logo: 'data:image/png;base64,AAAA' })
  })

  it('its state: starting until its first lift, unreachable after a failed load, crashed; never stopped or unverified', () => {
    const r = openRemoteTab('https://pilot.example.com/')
    expect(displayState(r, true)).toBe('none')
    activate(r.id)
    expect(w.loads).toEqual([r.id])   // a shared canvas with no view loads when shown
    r.view = 'live'
    expect(displayState(r, true)).toBe('starting')
    onFail(r, { why: 'unverified', code: -106, errorPage: true })
    expect(displayState(r, true)).toBe('unreachable')
    onRemoteCommit(r, { gen: 2, href: 'https://pilot.example.com/' })
    expect(displayState(r, true)).toBe('live')
    expect(r.fail).toBeUndefined()
    onDocumentGone(r, 'crashed')
    expect(displayState(r, true)).toBe('crashed')
  })

  it('a commit lifts at once and is never trusted, admitted or reloaded as unattributed; it may hold work from then on', () => {
    const r = sharedTab(w)
    expect(r.doc).toMatchObject({ trusted: false, lifted: true, commits: 1 })
    expect(r.doc!.doc).toBeUndefined()
    expect(r.unattributed).toBeUndefined()
    expect(r.retained).toBe(true)
    expect(r.reports.safety).toBe('unknown')
    expect(keptDoc(r) && guarded(r)).toBe(true)
    expect(canLoad(r)).toBe(true)
    expect(addressOf(r)).toBe('https://pilot.example.com/#/b/main')
  })

  it('its place moves only to a shell page of its origin: a sign-in through other hosts and its routes leaves it, cut short or not (r1 #9)', () => {
    const r = sharedTab(w, 'https://pilot.example.com/#/b/plans?f=checkout')
    w.shared.length = 0
    for (const href of [
      'https://pilot.example.com/__mv/id/start?next=%2F%23%2Fb%2Fplans', 'https://id.marver.design/login?c=1', 'https://accounts.google.com/o/oauth2/auth',
      'https://pilot.example.com/__mv/id/finish#code=secret', 'https://pilot.example.com/about', 'https://elsewhere.example.com/#/b/x',
    ]) {
      onRemoteCommit(r, { gen: (r.doc?.gen ?? 0) + 1, href })
      expect(r.remote!.url, href).toBe('https://pilot.example.com/#/b/plans?f=checkout')
    }
    // a sign-in cut short at finish keeps the board opened; the shell page after it moves the place
    onRemoteCommit(r, { gen: 9, href: 'https://pilot.example.com/#/b/flow' })
    expect(r.remote!.url).toBe('https://pilot.example.com/#/b/flow')
    // a board changed by its hash moves it too, before any trust test - a shared canvas is never trusted
    onInPage(r, 'https://pilot.example.com/#/b/other')
    expect(r.remote!.url).toBe('https://pilot.example.com/#/b/other')
    onInPage(r, 'https://pilot.example.com/__mv/id/finish#code=x')
    expect(r.remote!.url).toBe('https://pilot.example.com/#/b/other')
    expect(r.remote!.origin).toBe('https://pilot.example.com')
    // Home heard each commit (lastSeen) and each move, never a URL its place does not hold
    expect(w.shared.map((x) => x.url).every((u) => !u.includes('__mv') && u.startsWith('https://pilot.example.com/'))).toBe(true)
    expect(w.shared.at(-1)).toEqual({ tab: r.id, url: 'https://pilot.example.com/#/b/other' })
  })

  it('a link to an origin with a tab: nothing where it already is, its hash alone unasked, anything else the guard; no tab, a new one (#39, #43)', () => {
    const r = sharedTab(w, 'https://pilot.example.com/#/b/main')
    const at = 'https://pilot.example.com/#/b/main'
    expect(remoteLinkPlan(undefined, 'https://other.example.com/', '')).toBe('new')
    expect(remoteLinkPlan(r, at, at)).toBe('same')
    expect(remoteLinkPlan(r, 'https://pilot.example.com/#/b/other', at)).toBe('hash')
    for (const url of ['https://pilot.example.com/', 'https://pilot.example.com/?view=2#/b/main', 'https://pilot.example.com/about#/b/main']) expect(remoteLinkPlan(r, url, at), url).toBe('guard')
    // mid sign-in on another host: the board's link replaces that page, through the guard
    expect(remoteLinkPlan(r, at, 'https://id.marver.design/login')).toBe('guard')
    // no document shown yet (a view still loading): never "only the hash"
    expect(remoteLinkPlan(r, at, '')).toBe('guard')
  })

  it('an opening link under /__mv/ starts at the origin and /: the tab never holds a sign-in URL (r1 #9)', () => {
    const r = openRemoteTab('https://pilot.example.com/__mv/id/finish#code=secret')
    expect(r.remote).toEqual({ origin: 'https://pilot.example.com', url: 'https://pilot.example.com/', host: 'pilot.example.com' })
  })

  it('not restored: tabs.json is unchanged, an active shared canvas saving as Home (A4.6 #47)', () => {
    const t = liveTab(w)
    const r = sharedTab(w)
    expect(activeTab()).toBe(r)
    const f = snapshotFile(null, 5)
    expect(f.active).toEqual({ kind: 'home' })
    expect(f.canvases.map((c) => c.ws)).toEqual([t.reg!.ws])
    expect(JSON.stringify(f)).not.toContain('pilot.example.com')
  })

  it('its identity: the tab, its origin and commit - never a path, query, hash or workspace (A4.6 #48)', () => {
    const r = sharedTab(w, 'https://pilot.example.com/?token=abc#/b/main')
    expect(tabIdent(r)).toEqual({ tab: r.id, origin: 'https://pilot.example.com', commit: 1 })
  })

  it('never unloaded; closing it asks (its record is never fresh), then drops the tab: no run of it to keep', async () => {
    const r = sharedTab(w)
    expect(unloadRefusal(r, Date.now() + 1e9)).toBe('not-canvas')
    w.askWith = () => true
    expect(await closeTab(r.id)).toBe('closed')
    expect(w.sheets).toHaveLength(1)
    expect(getTab(r.id)).toBeUndefined()
    expect(activeTab()?.id).toBe('home')
  })
})
