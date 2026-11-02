/**
 * The strip's one pill (spec 28 A2.2, A2.14 #33): its order, its lifetimes and its revs, with a fake clock. A5.1 #21:
 * the update's pill, tier 5, on update-model.ts's model and testing/updater.ts's fakes, wired as updater.ts wires it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTab, getTab, onCommit, onDocumentGone, onRegistry, onReport, tabName, type Tab } from '../../src/main/tabs.ts'
import {
  clockOf, confirm, crashReloaded, currentPill, flashMarked, onPillAction, onVisibility, recompute, setCondition, setOfferActions, setPillPorts, setUpdatePill, waitingEnds,
} from '../../src/main/pill.ts'
import { FakeClock, FakeUpdater } from '../../src/main/testing/updater.ts'
import { pillOf, startUpdates, type UpdateModel } from '../../src/main/update-model.ts'
import { T } from '../../src/main/timings.ts'
import { liveTab, report, show, world, type World } from './window-fakes.ts'

let w: World
beforeEach(() => { vi.useFakeTimers(); w = world() })
afterEach(() => { vi.useRealTimers() })

const tick = (ms: number) => { w.clock.now += ms; vi.advanceTimersByTime(ms) }
const gone = (t: Tab) => onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
const held = (t: Tab) => { t.held = { at: w.clock.now, action: 'close' }; recompute() }

describe('the order: the active tab\'s own state, a confirmation, the files, an offer', () => {
  it('not responding, then unsaved work, then stopped - each with a short form (a hung page outranks its own hold)', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    t.hung = true
    gone(t)
    held(t)
    // the hung page cannot save anyway: its Reload, which asks first, shows over "Unsaved work here"
    expect(currentPill()).toMatchObject({ kind: 'not-responding', short: 'Not responding', button: { label: 'Reload' } })
    t.hung = false; recompute()
    expect(currentPill()).toMatchObject({ kind: 'unsaved', lead: 'Unsaved work here', short: 'Unsaved work' })
    t.held = undefined; recompute()
    expect(currentPill()).toMatchObject({ kind: 'stopped', lead: 'Stopped', short: 'Stopped', button: { label: 'npx marver dev', style: 'cmd' } })
    expect(currentPill()!.tooltip).toMatch(/^cd ~\/repo-\d+ && npx marver dev$/)
    t.hung = true; recompute()
    expect(currentPill()).toMatchObject({ kind: 'not-responding' })
    t.hung = false
    onRegistry({ kind: 'entry', entry: { ...{ file: t.reg!.file, key: Buffer.alloc(32), pid: 1, slot: t.reg!.slot, port: t.reg!.port, origin: t.reg!.origin, url: '', root: t.root!, name: t.name, version: '0.27.1', features: ['bridge'], ws: t.reg!.ws, startedAt: 1 }, state: 'ready', instance: 'back' } })
    expect(currentPill()).toBeNull()
  })

  it('⌘R refused on a hung page with fresh unsaved work: the pill stays Not responding with its Reload, no switch needed', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    t.hung = true; recompute()
    const r = currentPill()!.rev
    expect(currentPill()).toMatchObject({ kind: 'not-responding' })
    held(t)   // the guard refused the reload: main's own fresh record says unsaved
    expect(currentPill()).toMatchObject({ kind: 'not-responding', rev: r })
  })

  it('a confirmation below tier 1, the files below that, a dismissible offer last', () => {
    show('home')
    setCondition('test', { text: 'Get a notice when a canvas needs you', short: 'Turn On Notices', dismissible: true })
    expect(currentPill()?.kind).toBe('test')
    setCondition('files', { lead: 'Settings not applied', text: 'config.json', short: 'Settings not applied' })
    expect(currentPill()?.kind).toBe('files')
    const t = liveTab(w)
    crashReloaded(t)
    expect(currentPill()).toMatchObject({ kind: 'confirmation', text: 'Reloaded after a crash', short: 'Reloaded', icon: 'check' })
  })

  it('every pill has a short form - never an empty capsule below 960 px', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    const seen: string[] = []
    held(t); seen.push(currentPill()!.short)
    t.held = undefined; t.hung = true; recompute(); seen.push(currentPill()!.short)
    t.hung = false; crashReloaded(t); seen.push(currentPill()!.short)
    setCondition('files', { lead: 'Files not saved', text: '', short: 'Files not saved' })
    for (const s of seen) expect(s.length).toBeGreaterThan(0)
  })
})

describe('lifetimes (v1.10 r1 #16, A2.14 #33)', () => {
  it('the unsaved pill lasts while the page says unsaved; a record not fresh, 10 s; its tab no longer active ends it', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    held(t)
    tick(60_000)
    expect(currentPill()?.kind).toBe('unsaved')
    report(t, false)
    recompute()
    expect(currentPill()).toBeNull()
    const s = liveTab(w, { busy: null })
    held(s)
    tick(9_000)
    expect(currentPill()?.kind).toBe('unsaved')
    tick(1_100)
    expect(currentPill()).toBeNull()
    held(s)
    show('home')
    expect(currentPill()).toBeNull()
    show(s.id)
    expect(currentPill()).toBeNull()
  })

  it('a confirmation shown under an unsaved pill waits, then shows its full 4 s', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    held(t)
    crashReloaded(t)
    tick(10_000)
    expect(currentPill()?.kind).toBe('unsaved')
    report(t, false); recompute()
    expect(currentPill()?.kind).toBe('confirmation')
    tick(3_900)
    expect(currentPill()?.kind).toBe('confirmation')
    tick(200)
    expect(currentPill()).toBeNull()
  })

  it('pushed off part-way, it keeps what it has left', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    crashReloaded(t)
    tick(3_000)
    held(t)
    tick(5_000)
    report(t, false); recompute()
    expect(currentPill()?.kind).toBe('confirmation')
    tick(900)
    expect(currentPill()?.kind).toBe('confirmation')
    tick(200)
    expect(currentPill()).toBeNull()
  })

  it('one not shown within 30 s is dropped; its record stays', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    held(t)
    t.crash.count = 1
    crashReloaded(t)
    tick(31_000)
    report(t, false); recompute()
    expect(currentPill()).toBeNull()
    expect(t.crash.count).toBe(1)
  })

  it('counts down only while the window is seen', () => {
    const t = liveTab(w)
    crashReloaded(t)
    w.visible = false; onVisibility()
    tick(20_000)
    w.visible = true; onVisibility()
    expect(currentPill()?.kind).toBe('confirmation')
    tick(4_100)
    expect(currentPill()).toBeNull()
  })

  it('a newer confirmation of the same kind replaces the waiting one', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    held(t)
    crashReloaded(t)
    tick(1000)
    crashReloaded(t)
    report(t, false); recompute()
    tick(4_100)
    expect(currentPill()).toBeNull()
  })
})

describe('revs: a click acts on main\'s own record of that rev (v1.10 r1 #10)', () => {
  it('the Stopped button copies the pill\'s own tab\'s command; after a switch the old rev is refused', () => {
    const a = liveTab(w)
    gone(a)
    const rev = currentPill()!.rev
    expect(onPillAction(rev, 'button')).toBe(true)
    expect(w.copies).toEqual([a.id])
    const b = liveTab(w)
    gone(b)
    expect(onPillAction(rev, 'button')).toBe(false)
    expect(w.copies).toEqual([a.id])
  })

  it('the same pill keeps its rev; a different one gets a new rev', () => {
    const a = liveTab(w)
    gone(a)
    const r1 = currentPill()!.rev
    recompute(); recompute()
    expect(currentPill()!.rev).toBe(r1)
    a.hung = true; a.held = { at: w.clock.now, action: 'close' }; recompute()
    expect(currentPill()!.rev).toBeGreaterThan(r1)
  })

  it('a dismissible pill closes with its × (or Esc) and stays closed; a pill that is not dismissible ignores it', () => {
    show('home')
    setCondition('files', { lead: 'Settings not applied', text: '', short: 'Settings not applied' })
    expect(onPillAction(currentPill()!.rev, 'dismiss')).toBe(false)
    setCondition('files', null)
    setCondition('test', { text: 'Offer', short: 'Offer', dismissible: true })
    expect(onPillAction(currentPill()!.rev, 'dismiss')).toBe(true)
    expect(currentPill()).toBeNull()
    setCondition('test', { text: 'Offer', short: 'Offer', dismissible: true })
    expect(currentPill()).toBeNull()
  })
})

describe('Flash marked (A3.3, A3.8 #13; frame mac-app/11-moments)', () => {
  const showing = (): string[] => {
    const shown: string[] = []
    setPillPorts({
      now: () => w.clock.now, home: '/Users/nic', visible: () => w.visible, send: (v) => { w.pills.push(v) },
      copyStart: (t) => { w.copies.push(t.id) }, notResponding: () => {}, showFlash: (ref) => { shown.push(ref) },
    })
    return shown
  }

  it('says the mark\'s time for 4 s; its Show reveals that mark\'s picture, also after a switch to another tab', () => {
    const shown = showing()
    const a = liveTab(w)
    show(a.id)
    flashMarked({ at: w.clock.now, recorder: true, picture: 'flashes/20261023-205103-412-ab12.png' })
    const p = currentPill()!
    expect(p).toMatchObject({ kind: 'confirmation', lead: 'Flash marked', text: clockOf(w.clock.now), short: 'Flash marked', icon: 'check', button: { label: 'Show', style: 'plain' } })
    const b = liveTab(w)
    show(b.id)
    expect(currentPill()!.rev).toBe(p.rev)
    expect(onPillAction(p.rev, 'button')).toBe(true)
    expect(shown).toEqual(['flashes/20261023-205103-412-ab12.png'])
    tick(4_100)
    expect(currentPill()).toBeNull()
    expect(onPillAction(p.rev, 'button')).toBe(false)
    expect(shown).toHaveLength(1)
  })

  it('no picture, no button; with the recorder off it says there are no samples before it', () => {
    showing()
    flashMarked({ at: w.clock.now, recorder: false, picture: null })
    const p = currentPill()!
    expect(p.button).toBeUndefined()
    expect(p.text).toBe(`${clockOf(w.clock.now)} · no samples before it: the recorder is off`)
    expect(onPillAction(p.rev, 'button')).toBe(false)
  })

  it('a newer mark replaces the waiting one; the old rev is refused', () => {
    const shown = showing()
    flashMarked({ at: w.clock.now, recorder: true, picture: 'flashes/a.png' })
    const r1 = currentPill()!.rev
    tick(2500)
    flashMarked({ at: w.clock.now, recorder: true, picture: 'flashes/b.png' })
    const r2 = currentPill()!.rev
    expect(r2).toBeGreaterThan(r1)
    expect(onPillAction(r1, 'button')).toBe(false)
    expect(onPillAction(r2, 'button')).toBe(true)
    expect(shown).toEqual(['flashes/b.png'])
  })

  it('pushed off by the active tab\'s own state, it waits and then shows its full 4 s', () => {
    showing()
    const a = liveTab(w, { busy: { unsaved: true } })
    show(a.id)
    flashMarked({ at: w.clock.now, recorder: true, picture: null })
    tick(1000)
    held(a)
    expect(currentPill()!.kind).toBe('unsaved')
    tick(5000)
    a.held = undefined; recompute()
    expect(currentPill()).toMatchObject({ kind: 'confirmation', lead: 'Flash marked' })
    tick(2900)
    expect(currentPill()).not.toBeNull()
    tick(200)
    expect(currentPill()).toBeNull()
  })
})

describe('the notices offer (A4.6 #26)', () => {
  const OFFER = { lead: 'Get a notice when a canvas needs you', text: '', short: 'Turn On Notices', button: { label: 'Turn On', style: 'accent' as const }, dismissible: true }
  let acts: string[]
  beforeEach(() => { acts = []; setOfferActions({ turnOn: () => acts.push('turnOn'), dismissed: () => acts.push('dismissed') }) })
  afterEach(() => setOfferActions(null))

  it('tier 4: under the files and every pill above them, over the test kind; Turn On is its button, a short form below 960 px', () => {
    show('home')
    setCondition('test', { text: 'a test offer', short: 'Test', dismissible: true })
    setCondition('offer', OFFER)
    expect(currentPill()).toMatchObject({ kind: 'offer', lead: OFFER.lead, short: 'Turn On Notices', button: { label: 'Turn On', style: 'accent' }, dismissible: true })
    setCondition('files', { lead: 'config.json', text: 'did not apply', short: 'Settings not applied' })
    expect(currentPill()?.kind).toBe('files')
    setCondition('files', null)
    expect(currentPill()?.kind).toBe('offer')
  })

  it('Turn On calls notify\'s turnOn; an old rev is refused; Not now (dismiss, the x or Esc) tells notify and never comes back this run', () => {
    show('home')
    setCondition('offer', OFFER)
    const r = currentPill()!.rev
    expect(onPillAction(r - 1, 'button')).toBe(false)
    expect(acts).toEqual([])
    expect(onPillAction(r, 'button')).toBe(true)
    expect(acts).toEqual(['turnOn'])
    expect(onPillAction(r, 'dismiss')).toBe(true)
    expect(acts).toEqual(['turnOn', 'dismissed'])
    expect(currentPill()).toBeNull()
    setCondition('offer', OFFER)
    expect(currentPill()).toBeNull()
  })

  it('taken down when notify says so', () => {
    show('home')
    setCondition('offer', OFFER)
    setCondition('offer', null)
    expect(currentPill()).toBeNull()
  })

  it('a missed notice is a 4 s confirmation leading with the canvas\'s name, no button', () => {
    show('home')
    confirm('notice-missed', { lead: 'Pilot', text: 'needs you', short: 'Needs you' })
    expect(currentPill()).toMatchObject({ kind: 'confirmation', lead: 'Pilot', text: 'needs you', short: 'Needs you', icon: 'check' })
    expect(currentPill()!.button).toBeUndefined()
    tick(T.pillConfirmMs + 10)
    expect(currentPill()).toBeNull()
  })
})

describe('the update, tier 5 (A5.1 #21)', () => {
  const OFFER = { lead: 'Get a notice when a canvas needs you', text: '', short: 'Turn On Notices', button: { label: 'Turn On', style: 'accent' as const }, dismissible: true }
  /** update-model.ts's model on the fakes, wired as updater.ts wires it: each change chooses the pill again */
  function updater() {
    const u = new FakeUpdater()
    const uc = new FakeClock()
    const requests: string[] = []
    let downloads = 0
    const box: { m?: UpdateModel } = {}
    const m = startUpdates({
      adapter: u, clock: uc, feed: 'https://example.invalid/releases.json', version: '0.99.1',
      record: () => {}, answer: () => {}, online: () => true,
      changed: (st) => setUpdatePill(pillOf(st, (id) => { const t = getTab(id); return t ? tabName(t) : 'a closed tab' }), (t) => box.m!.act(t)),
      request: (kind, t) => { requests.push(`${kind}:${t.version}`) }, openDownload: () => { downloads += 1 }, explain: () => {},
      restartFailed: () => {}, beforeQuitForUpdate: () => {},
    }, { inApplications: true, writable: true })
    box.m = m
    uc.tick()
    const ready = (version = '0.99.2') => { uc.advance(T.updateFirstMs); u.emit('update-available'); u.downloaded(version, 'Boards open faster\nAnd more') }
    /** updater.ts's updaterTabs, as views.ts calls it after a report and after every tab change */
    const tabs = (reportTab?: string) => { const p = m.state().phase; if (p.kind === 'waiting' && waitingEnds(p, reportTab)) m.unhold(p.tab) }
    return { u, uc, m, requests, ready, tabs, downloads: () => downloads }
  }
  const press = () => onPillAction(currentPill()!.rev, 'button')

  it('after the offer: every other tier first, then "1.0.1 is ready" with Restart to Update, its notes\' first line its tooltip', () => {
    show('home')
    const x = updater()
    x.ready()
    expect(currentPill()).toMatchObject({ kind: 'update', lead: '0.99.2 is ready', short: 'Restart to Update', button: { label: 'Restart to Update', style: 'accent' }, tooltip: 'Boards open faster' })
    setCondition('test', { text: 'a test offer', short: 'Test', dismissible: true })
    expect(currentPill()?.kind).toBe('test')
    setCondition('offer', OFFER)
    expect(currentPill()?.kind).toBe('offer')
    setCondition('offer', null)
    setCondition('test', null)
    expect(currentPill()?.kind).toBe('update')
    confirm('update', { text: 'Marver 0.99.1 is up to date', short: 'Up to date' })
    expect(currentPill()?.kind).toBe('confirmation')
  })

  it('waiting: "1.0.1 waits for <the tab>", Try Again - bound to that tab and its document; Try Again asks request(update)', () => {
    const x = updater()
    x.ready()
    const t = liveTab(w, { busy: { unsaved: true } })
    show('home')
    expect(x.m.hold(t.id, t.doc!.commits)).toBe(true)
    expect(currentPill()).toMatchObject({ kind: 'update', lead: `0.99.2 waits for ${tabName(t)}`, short: 'Update waits', button: { label: 'Try Again', style: 'plain' }, tab: t.id })
    expect(press()).toBe(true)
    expect(x.requests).toEqual(['update:0.99.2'])
  })

  it('waiting back to ready on its tab\'s unsaved turning false, its close and its new document - never on a tab switch or a stale report', async () => {
    const x = updater()
    x.ready()
    const t = liveTab(w, { busy: { unsaved: true } })
    const other = liveTab(w)
    const wait = () => { x.m.hold(t.id, t.doc!.commits); expect(x.m.state().phase.kind).toBe('waiting') }
    const kind = () => x.m.state().phase.kind

    // a tab switch, a report of another tab, a report still unsaved: nothing
    wait()
    show(other.id); x.tabs()
    report(other, false); x.tabs(other.id)
    report(t, true); x.tabs(t.id)
    expect(kind()).toBe('waiting')
    // a stale report (the bridge says the document went stale): nothing, even saying clean
    onReport(t.id, t.doc!.doc!, { safety: 'stale' }); x.tabs(t.id)
    expect(kind()).toBe('waiting')
    // fresh and clean: ready (a new document first, to be fresh again)
    onCommit(t, { gen: 2, url: `${t.reg!.origin}/#/b/main`, attributed: true, admitted: `doc-${t.id}-2` })
    x.tabs()
    expect(kind()).toBe('ready')                                   // its document changed
    wait()
    report(t, false); x.tabs(t.id)
    expect(kind()).toBe('ready')                                   // its unsaved turned false
    // its close
    wait()
    w.actWith = (tab) => { onDocumentGone(tab, 'none'); return 'done' }
    expect(await closeTab(t.id)).toBe('closed')
    x.tabs()
    expect(kind()).toBe('ready')
    // leaving waiting asks for nothing: the person presses again
    expect(x.requests).toEqual([])
  })

  it('failed: "1.0.1 couldn\'t be installed", Download, dismissible - shown whatever the phase when neither ready nor waiting is', () => {
    show('home')
    const x = updater()
    x.m.failed({ from: '0.99.1', to: '0.99.2', at: 1 })
    expect(currentPill()).toMatchObject({ kind: 'update', lead: "0.99.2 couldn't be installed", short: 'Update failed', button: { label: 'Download', style: 'plain' }, dismissible: true })
    // a check runs while it is shown, and one that finds nothing keeps it
    x.uc.advance(T.updateFirstMs)
    expect(x.m.state().phase.kind).toBe('checking')
    expect(currentPill()?.kind).toBe('update')
    x.u.emit('update-not-available')
    expect(currentPill()).toMatchObject({ kind: 'update', lead: "0.99.2 couldn't be installed" })
  })

  it('each action against its requirement: Download right after the reconciliation acts, after Dismiss nothing; after a later ready Download nothing and Restart to Update acts', () => {
    show('home')
    const x = updater()
    x.m.failed({ from: '0.99.1', to: '0.99.2', at: 1 })
    const failed = currentPill()!
    expect(press()).toBe(true)
    expect(x.downloads()).toBe(1)
    // Dismiss clears the failure in the model: the pill goes, and the old rev's Download does nothing
    expect(onPillAction(failed.rev, 'dismiss')).toBe(true)
    expect(x.m.state().failure).toBeNull()
    expect(currentPill()).toBeNull()
    expect(onPillAction(failed.rev, 'button')).toBe(false)
    expect(x.downloads()).toBe(1)
    // failed again, then a check that ends ready: the failure is superseded
    x.m.failed({ from: '0.99.1', to: '0.99.2', at: 2 })
    const again = currentPill()!
    x.ready('0.99.3')
    expect(onPillAction(again.rev, 'button')).toBe(false)
    expect(x.downloads()).toBe(1)
    expect(currentPill()).toMatchObject({ lead: '0.99.3 is ready' })
    expect(press()).toBe(true)
    expect(x.requests).toEqual(['update:0.99.3'])
  })

  it('a click whose requirement no longer holds does nothing, and the pill is chosen again; a waiting pill\'s tab whose document moved is stale', () => {
    show('home')
    const x = updater()
    x.ready()
    const t = liveTab(w, { busy: { unsaved: true } })
    show('home')
    x.m.hold(t.id, t.doc!.commits)
    const waiting = currentPill()!
    // its document moves on before the click: refused here, as any pill's with a tab
    t.doc!.commits += 1
    expect(onPillAction(waiting.rev, 'button')).toBe(false)
    expect(x.requests).toEqual([])
    t.doc!.commits -= 1
    // restarting: neither Restart to Update nor Try Again holds
    x.m.unhold()
    const ready = currentPill()!
    expect(x.m.restarting('0.99.2')).toBe(true)
    expect(currentPill()).toBeNull()
    expect(onPillAction(ready.rev, 'button')).toBe(false)
    expect(x.requests).toEqual([])
  })

  it('checking has no pill', () => {
    show('home')
    const x = updater()
    x.uc.advance(T.updateFirstMs)
    expect(x.m.state().phase.kind).toBe('checking')
    expect(currentPill()).toBeNull()
  })
})
