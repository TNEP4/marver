/**
 * The unload's guard, its reopen and the crash latch held apart (spec 28 A2.6, A3.8 #39-#45, r1 #1, #2, #8, #9, r2
 * #4, r3 #3), on the pure model with fake ports. The act stands in for views.ts's: a close the case ends at
 * `destroyed` (forgetCanvas's `onUnloaded`, then the act's answer) or with the page's refusal; on a tab with no view
 * it does what views.ts's does (`viewlessAct`, then a load).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activate, activeTab, allTabs, closeTab, closeView, displayState, guard, guardAll, isActive, linkOpens, onCommit, onFail, onRegistry, onReport, onUnloaded, ordered,
  snapshotFile, startReopen, unloadRefusal, viewlessAct, wantsLoad, type GuardAction, type GuardAnswer, type Tab,
} from '../../src/main/tabs.ts'
import { onLifted, pageFor, recover } from '../../src/main/tabpage.ts'
import { T } from '../../src/main/timings.ts'
import { deferred, entry, flush, liveTab, report, show, world, type Deferred, type World } from './window-fakes.ts'

let w: World
beforeEach(() => { w = world() })
afterEach(() => { vi.useRealTimers() })

const warn: GuardAction = { kind: 'unload', reason: 'warn' }
const critical: GuardAction = { kind: 'unload', reason: 'critical' }

/** A canvas tab shown once, then hidden (Home shown) long enough: a candidate. */
function candidate(o: Parameters<typeof liveTab>[1] = {}): Tab {
  const t = liveTab(w, o)
  show('home')
  w.clock.now += T.unloadMinHiddenMs
  return t
}

/** The act as views.ts makes it: an unload's close the case ends; on a tab with no view, viewlessAct then a load. */
function closer(): { gate: () => Deferred<GuardAnswer> | undefined; destroyed(t: Tab): void; refuse(): void } {
  let gate: Deferred<GuardAnswer> | undefined
  w.actWith = (t, a) => {
    if (a.kind === 'unload') { gate = deferred<GuardAnswer>(); return gate.promise }
    if (t.view !== 'live') {
      if (viewlessAct(t, a) && t.reg?.origin) { w.loads.push(t.id); if (startReopen(t)) w.reopens.push(t.id) }
      return 'done'
    }
    return 'done'
  }
  return {
    gate: () => gate,
    // forgetCanvas's onUnloaded runs first (registered first), then the act's own destroyed answers
    destroyed(t) { onUnloaded(t); gate!.resolve('done') },
    refuse() { gate!.resolve('refused') },
  }
}

/** views.ts's attributed commit of the tab's next document, lifted (onCommit, then onLifted). */
function lift(t: Tab, admitted = `doc-${t.id}-${(t.doc?.commits ?? 0) + 1}`): void {
  t.view = 'live'
  onCommit(t, { gen: (t.doc?.gen ?? 0) + 1, url: `${t.reg!.origin}/`, href: `${t.reg!.origin}${t.path}`, attributed: true, admitted })
  onLifted(t)
}

const recs = (kind: string) => w.records.filter((r) => r.kind === kind)

describe('the unload is its own guard action, with a silent refusal (A3.8 #39, #40)', () => {
  it('refused at admission: nothing asked, acted, held, activated or brought forward - only the journal and the recorder hear', async () => {
    const t = liveTab(w)
    show('home')   // hidden just now: recent
    const pills = w.pills.length
    expect(await guard(t, warn)).toBe('refused')
    expect(w.sheets).toHaveLength(0)
    expect(w.acts).toHaveLength(0)
    expect(w.forwards).toBe(0)
    expect(t.held).toBeUndefined()
    expect(activeTab()?.id).toBe('home')
    expect(w.pills.slice(pills).every((p) => p === null)).toBe(true)
    expect(t.replacing).toBeUndefined()
    expect(recs('unload')).toEqual([expect.objectContaining({ tab: t.id, body: { phase: 'refused', reason: 'warn', why: 'recent' } })])
  })

  it('admitted: one act with the action copied, reason and all; the recheck admits its own operation, never another\'s', async () => {
    const t = candidate()
    const c = closer()
    const action = { kind: 'unload', reason: 'warn' } as GuardAction
    const p = guard(t, action)
    ;(action as { reason: string }).reason = 'critical'   // the caller's object changing later changes nothing
    expect(w.acts).toEqual([{ tab: t.id, action: { kind: 'unload', reason: 'warn' } }])
    expect(t.unload).toMatchObject({ phase: 'closing', reason: 'warn', at: w.clock.now, commit: t.doc!.commits, origin: t.reg!.origin })
    const own = t.replacing!
    expect(unloadRefusal(t, w.clock.now, own)).toBe('no-document')   // an unload under way is no candidate
    t.unload = undefined
    expect(unloadRefusal(t, w.clock.now, own)).toBe(null)
    expect(unloadRefusal(t, w.clock.now)).toBe('replacing')
    expect(unloadRefusal(t, w.clock.now, { ...own })).toBe('replacing')
    t.unload = { phase: 'closing', reason: 'warn', at: w.clock.now, commit: own.commit, origin: t.reg!.origin! }
    c.destroyed(t)
    expect(await p).toBe('done')
  })

  it('the page refuses: kept as it was, never asked again for that document, a candidate again after a new commit', async () => {
    const t = candidate()
    const c = closer()
    const commit = t.doc!.commits
    const p = guard(t, critical)
    c.refuse()
    expect(await p).toBe('refused')
    expect(t.unload).toBeUndefined()
    expect(t.unloadRefused).toBe(commit)
    expect(t.view).toBe('live')
    expect(t.retained).toBe(true)
    expect(unloadRefusal(t, w.clock.now)).toBe('refused-before')
    expect(recs('unload').map((r) => r.body)).toEqual([{ phase: 'refused', reason: 'critical', why: 'page' }])
    // the page reloads itself: a new document, heard again - a candidate
    lift(t)
    report(t, false)
    expect(unloadRefusal(t, w.clock.now)).toBe(null)
    expect(w.sheets).toHaveLength(0)
    expect(w.forwards).toBe(0)
  })

  it('destroyed: the tab unloaded - its id, path, look, logo and place kept, its document gone, the crash record as it was', async () => {
    const t = candidate()
    t.look = true
    t.logo = 'data:image/svg+xml;base64,PHN2Zy8+'
    t.path = '/#/b/b?n=k'
    t.crash = { count: 1, latched: false, lastAuto: 5, times: [5], epoch: 3 }
    const crash = structuredClone(t.crash)
    const order = ordered().map((x) => x.id)
    const commit = t.doc!.commits
    const c = closer()
    const p = guard(t, warn)
    c.destroyed(t)
    expect(await p).toBe('done')
    expect(t.view).toBe('unloaded')
    expect(t.unload).toMatchObject({ phase: 'unloaded', unloadedAt: w.clock.now })
    expect(t).toMatchObject({ retained: false, look: true, path: '/#/b/b?n=k', logo: 'data:image/svg+xml;base64,PHN2Zy8+' })
    expect(t.reports).toEqual({ safety: 'unknown' })
    expect(t.doc).toMatchObject({ trusted: false, lifted: false })
    expect(t.crash).toEqual(crash)
    expect(ordered().map((x) => x.id)).toEqual(order)
    expect(displayState(t, false)).toBe('unloaded')
    expect(wantsLoad(t)).toBe(true)
    expect(snapshotFile(null, w.clock.now).canvases).toContainEqual(expect.objectContaining({ ws: t.reg!.ws, origin: t.reg!.origin, path: '/#/b/b?n=k' }))
    // the record names the document it closed
    expect(recs('unload')).toEqual([expect.objectContaining({ who: expect.objectContaining({ tab: t.id, commit }), body: { phase: 'done', reason: 'warn' } })])
    await flush()
    expect(w.loads).toEqual([])   // hidden: nothing reopens until it is shown
  })
})

describe('what else happens to a tab while it unloads (A3.8 #42, r1 #2, r3 #3)', () => {
  it('a close waits for the unload: ended at destroyed, the close goes unguarded - no sheet, no load, nothing reopens', async () => {
    const t = candidate()
    const c = closer()
    const u = guard(t, warn)
    activate(t.id)   // shown, then closed, while it closes
    const close = closeTab(t.id)
    await flush()
    expect(w.acts.map((a) => a.action.kind)).toEqual(['unload'])   // nothing runs while the close is outstanding
    c.destroyed(t)
    expect(await u).toBe('done')
    expect(await close).toBe('closed')
    expect(t).toMatchObject({ open: false, view: 'none', unload: undefined })
    await flush()
    expect(w.sheets).toHaveLength(0)
    expect(w.loads).toEqual([])
  })

  it('a close that waited for an unload the page refused takes the ordinary steps: a fresh unsaved record refuses with the pill', async () => {
    const t = candidate()
    const c = closer()
    const u = guard(t, warn)
    const close = closeView(t)
    report(t, true, ['capture-unsent'])   // the page held work meanwhile (it was idle at admission)
    c.refuse()
    expect(await u).toBe('refused')
    expect(await close).toBe('refused')
    expect(t.held?.action).toBe('close')
    expect(w.sheets).toHaveLength(0)
  })

  it('a stale record after the refusal: the waiting close asks its sheet', async () => {
    const t = candidate()
    const c = closer()
    const u = guard(t, warn)
    const close = closeView(t)
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })   // trust gone: stale
    c.refuse()
    await u
    w.askWith = () => false
    expect(await close).toBe('refused')
    expect(w.sheets.map((s) => s.tabs[0]!.why.kind)).toEqual(['stale'])
  })

  it('a load that waited beside an activation loads its own URL, once; the reopen is dropped', async () => {
    const t = candidate()
    const c = closer()
    const u = guard(t, warn)
    const l = guard(t, { kind: 'load', url: `${t.reg!.origin}/#/b/other?n=k1` })
    activate(t.id)   // shown meanwhile: the reopen it queued is the last thing decided, and the link has taken its place
    c.destroyed(t)
    await u
    expect(await l).toBe('done')
    expect(t.path).toBe('/#/b/other?n=k1')
    expect(t.unload).toBeUndefined()
    expect(w.loads).toEqual([t.id])
    expect(w.reopens).toEqual([])   // a link opens on what it names: no reopen, so no saved camera over its selection
    await flush()
    expect(w.loads).toEqual([t.id])
  })

  it('a reload, force reload or Try Again that waited is the reopen itself: one load, never two', async () => {
    for (const kind of ['reload', 'forceReload', 'tryAgain'] as const) {
      w = world()
      const t = candidate()
      const c = closer()
      const u = guard(t, warn)
      const r = guard(t, { kind })
      show(t.id)   // and shown meanwhile: a queued activation too
      c.destroyed(t)
      await u
      expect(await r).toBe('done')
      await flush()
      expect(w.loads).toEqual([t.id])
      expect(w.reopens).toEqual([t.id])
    }
  })

  // the model's wait is the same in both phases of the close; views.ts's timer, main's own close and their order
  // against destroyed are unload-act.test.ts's and test/prod/unload.test.ts's
  it('a load queued behind an unload still closing past unloadActMs (unsure) waits for destroyed, then loads its own URL', async () => {
    const t = candidate()
    const c = closer()
    const u = guard(t, warn)
    const l = guard(t, { kind: 'load', url: `${t.reg!.origin}/#/b/x` })
    w.clock.now += T.unloadActMs + 1
    t.unload!.phase = 'unsure'   // views.ts at unloadActMs: unsure, then a plain close()
    await flush()
    expect(w.acts.map((a) => a.action.kind)).toEqual(['unload'])
    expect(w.loads).toEqual([])
    c.destroyed(t)
    expect(await u).toBe('done')
    expect(t.view).toBe('unloaded')
    expect(await l).toBe('done')
    expect(w.loads).toEqual([t.id])
  })

  it('a quit during an unload waits for it and goes on: never refused as busy, the unloaded tab not named, nothing brought forward', async () => {
    const t = candidate()
    const other = candidate()
    const c = closer()
    const u = guard(t, warn)
    const q = guardAll({ kind: 'quit' })
    await flush()
    expect(w.acts.map((a) => `${a.tab}:${a.action.kind}`)).toEqual([`${t.id}:unload`])
    c.destroyed(t)
    await u
    expect(await q).toBe('done')
    expect(w.acts.map((a) => `${a.tab}:${a.action.kind}`)).toEqual([`${t.id}:unload`, `${other.id}:quit`])
    expect(w.logs.filter((l) => l.topic === 'guard' && l.data.busy)).toEqual([])
    expect(w.forwards).toBe(0)
    expect(w.logs.find((l) => l.topic === 'guard' && l.data.all === 'quit' && l.data.answer === 'done')?.data.tabs).toEqual([other.id])
  })

  it('no unload is admitted while a quit or an update is under way; a refused one clears the sweep', async () => {
    for (const kind of ['quit', 'update'] as const) {
      w = world()
      const a = candidate()
      const b = candidate()
      candidate({ busy: { unsaved: true } })   // refuses the sweep when it comes
      const c = closer()
      const u = guard(a, warn)
      const q = guardAll({ kind })
      await flush()
      // the sweep waits for a's unload: b, with no operation yet, is refused for the sweep itself
      expect(unloadRefusal(b, w.clock.now)).toBe('sweeping')
      expect(await guard(b, critical)).toBe('refused')
      expect(w.acts.filter((x) => x.tab === b.id)).toEqual([])
      c.destroyed(a)
      await u
      expect(await q).toBe('refused')
      expect(unloadRefusal(b, w.clock.now)).toBe(null)
    }
  })
})

describe('activation while the close is outstanding (A3.8 #42, #45, r2 #4, r3 #3)', () => {
  it('queued under the reopening page, no shown sent; at destroyed one reopen; its record keeps the activation\'s time', async () => {
    const t = candidate()
    const c = closer()
    const u = guard(t, warn)
    const at = w.clock.now
    activate(t.id)
    expect(w.states.filter((s) => s.tab === t.id && s.s === 'shown')).toEqual([])
    expect(pageFor(t, w.clock.now)).toMatchObject({ page: 'reopening', since: at, unloadedAt: at, cameraKept: true })
    expect(w.loads).toEqual([])
    w.clock.now += 800
    c.destroyed(t)
    await u
    expect(w.loads).toEqual([])   // decided last, in a task after every waiter
    await flush()
    expect(w.reopens).toEqual([t.id])
    expect(pageFor(t, w.clock.now)).toMatchObject({ page: 'reopening', since: at, unloadedAt: w.clock.now })
    w.clock.now += 300
    lift(t)
    expect(t.unload).toBeUndefined()
    expect(pageFor(t, w.clock.now)).toBe(null)
    onReport(t.id, t.doc!.doc!, { hello: { version: '0.27.2', board: 'main', page: 'PAGE_reopened01' } })
    expect(recs('reopen')).toEqual([expect.objectContaining({ who: expect.objectContaining({ tab: t.id, page: 'PAGE_reopened01' }), body: { activateToLiftMs: 1100, unloadedForMs: 0 } })])
  })

  it('the page refuses instead: the tab page goes, the kept page shows, its shown sent then', async () => {
    const t = candidate()
    const c = closer()
    const u = guard(t, warn)
    activate(t.id)
    expect(w.states.filter((s) => s.tab === t.id && s.s === 'shown')).toEqual([])
    c.refuse()
    expect(await u).toBe('refused')
    expect(pageFor(t, w.clock.now)).toBe(null)
    expect(w.states.filter((s) => s.tab === t.id && s.s === 'shown')).toHaveLength(1)
    await flush()
    expect(w.loads).toEqual([])
  })

  it('then a quit: at destroyed it stays unloaded, nothing loads, and the quit goes on with no newcomer refusal', async () => {
    const t = candidate()
    const c = closer()
    const u = guard(t, warn)
    activate(t.id)
    const q = guardAll({ kind: 'quit' })
    c.destroyed(t)
    await u
    expect(await q).toBe('done')
    await flush()
    expect(t.view).toBe('unloaded')
    expect(w.loads).toEqual([])
  })

  it('then a quit another tab refuses at its sheet: the active unloaded tab reopens then, once', async () => {
    const t = candidate()
    const stale = candidate()
    stale.reports.safety = 'stale'   // not fresh: the quit asks, and Cancel refuses it
    w.askWith = () => false
    const c = closer()
    const u = guard(t, warn)
    activate(t.id)
    const q = guardAll({ kind: 'quit' })
    c.destroyed(t)
    await u
    expect(await q).toBe('refused')
    expect(w.sheets.map((s) => s.tabs.map((x) => x.id))).toEqual([[stale.id]])
    await flush()
    expect(w.reopens).toEqual([t.id])
    expect(w.loads).toEqual([t.id])
  })

  it('a quit refused for another tab\'s unsaved work brings that tab forward: the unloaded one stays unloaded until shown', async () => {
    const t = candidate()
    const holder = candidate({ busy: { unsaved: true } })
    const c = closer()
    const u = guard(t, warn)
    activate(t.id)
    const q = guardAll({ kind: 'quit' })
    c.destroyed(t)
    await u
    expect(await q).toBe('refused')
    expect(activeTab()?.id).toBe(holder.id)
    await flush()
    expect(t.view).toBe('unloaded')
    expect(w.loads).toEqual([])
  })

  it('switched away before destroyed: nothing reopens; shown later, it reopens, unloadedForMs from destroyed to that activation', async () => {
    const t = candidate()
    const c = closer()
    const u = guard(t, warn)
    activate(t.id)
    show('home')
    c.destroyed(t)
    await u
    const gone = w.clock.now
    await flush()
    expect(w.loads).toEqual([])
    w.clock.now += 5000
    activate(t.id)
    expect(w.reopens).toEqual([t.id])
    w.clock.now += 200
    lift(t)
    onReport(t.id, t.doc!.doc!, { hello: { version: '0.27.2', board: 'main', page: 'PAGE_reopened02' } })
    expect(recs('reopen')[0]!.body).toEqual({ activateToLiftMs: 200, unloadedForMs: w.clock.now - 200 - gone })
  })
})

describe('the reopen keeps board and camera (A3.8 #43, #45)', () => {
  async function unloaded(): Promise<Tab> {
    const t = candidate()
    t.path = '/#/b/b?n=k'
    const c = closer()
    const u = guard(t, critical)
    c.destroyed(t)
    await u
    return t
  }

  it('shown again: its saved path, reopening until the document lifts; the record at its hello, with its page', async () => {
    const t = await unloaded()
    const gone = w.clock.now
    w.clock.now += 60_000
    activate(t.id)
    expect(w.loads).toEqual([t.id])
    expect(w.reopens).toEqual([t.id])
    expect(t.path).toBe('/#/b/b?n=k')
    expect(pageFor(t, w.clock.now)).toMatchObject({ page: 'reopening', since: w.clock.now, unloadedAt: gone, cameraKept: true })
    // an unattributed commit leaves it reopening
    t.view = 'live'
    onCommit(t, { gen: 1, url: `${t.reg!.origin}/`, attributed: false, admitted: null })
    expect(t.unload?.phase).toBe('reopening')
    expect(pageFor(t, w.clock.now)?.page).toBe('reopening')
    w.clock.now += 400
    lift(t)
    expect(t.path).toBe('/#/b/b?n=k')
    expect(pageFor(t, w.clock.now)).toBe(null)
    expect(recs('reopen')).toEqual([])
    onReport(t.id, t.doc!.doc!, { hello: { version: '0.27.2', board: 'b', page: 'PAGE_reopened03' } })
    expect(recs('reopen')).toEqual([expect.objectContaining({ who: expect.objectContaining({ page: 'PAGE_reopened03', commit: t.doc!.commits }), body: { activateToLiftMs: 400, unloadedForMs: 60_000 } })])
    // a second hello of the same document writes nothing more
    onReport(t.id, t.doc!.doc!, { hello: { version: '0.27.2', board: 'b', page: 'PAGE_reopened03' } })
    expect(recs('reopen')).toHaveLength(1)
  })

  it('a reopened document that never says hello: its record at its next document, with no page', async () => {
    const t = await unloaded()
    activate(t.id)
    lift(t)
    const commit = t.doc!.commits
    lift(t)
    expect(recs('reopen')).toEqual([expect.objectContaining({ who: { tab: t.id, ws: t.reg!.ws, commit } })])
  })

  it('and 30 s after its lift when nothing follows', async () => {
    const t = await unloaded()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    activate(t.id)
    lift(t)
    vi.advanceTimersByTime(T.reopenHelloMs - 1)
    expect(recs('reopen')).toEqual([])
    vi.advanceTimersByTime(1)
    expect(recs('reopen')).toHaveLength(1)
    expect((recs('reopen')[0]!.who as { page?: string }).page).toBeUndefined()
  })

  it('a reopen that fails shows the failure and writes no reopen, even once a later load lifts', async () => {
    const t = await unloaded()
    activate(t.id)
    onFail(t, { why: 'unreachable', code: -102, errorPage: false })
    expect(pageFor(t, w.clock.now)?.page).toBe('unreachable')
    expect(t.unload).toBeUndefined()
    lift(t)
    onReport(t.id, t.doc!.doc!, { hello: { version: '0.27.2', board: 'b', page: 'PAGE_reopened04' } })
    expect(recs('reopen')).toEqual([])
  })

  it('a canvas stopped while unloaded shows stopped; rebound to another origin, it reopens with its board only', async () => {
    const t = await unloaded()
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
    activate(t.id)
    expect(pageFor(t, w.clock.now)).toMatchObject({ page: 'stopped', retained: false })
    expect(w.loads).toEqual([])
    onRegistry({ kind: 'entry', entry: { file: '/h/running/slot-9.json', key: Buffer.alloc(32), state: 'ready', pid: 9, instance: 'inst-new', slot: 9, port: 40999, origin: 'http://[::1]:40999', url: 'http://localhost:40999/', root: t.root!, name: t.name, version: '0.27.2', features: ['bridge'], ws: t.reg!.ws, startedAt: 2 } })
    expect(t.reg!.origin).toBe('http://[::1]:40999')
    expect(w.reopens).toEqual([t.id])   // the active tab, at ready
    expect(pageFor(t, w.clock.now)).toMatchObject({ page: 'reopening', cameraKept: false })
  })

  it('closed while unloaded: it closes as a documentless tab, and opened from Home again it is a plain open', async () => {
    const t = await unloaded()
    expect(await closeTab(t.id)).toBe('closed')
    expect(t).toMatchObject({ open: false, view: 'none', unload: undefined })
    activate(t.id)
    expect(w.loads).toEqual([t.id])
    expect(w.reopens).toEqual([])
    expect(pageFor(t, w.clock.now)?.page).toBe('starting')
  })
})

describe('the crash latch is held apart (A3.8 #44, r1 #8)', () => {
  const crash = (t: Tab) => recover(t, { kind: 'crash', reason: 'crashed', exitCode: 1 })

  async function unloadAndReopen(t: Tab): Promise<void> {
    show('home')
    w.clock.now += T.unloadMinHiddenMs
    const c = closer()
    const u = guard(t, critical)
    c.destroyed(t)
    expect(await u).toBe('done')
    activate(t.id)
    lift(t)
    report(t, false)
  }

  // a renderer gone during the close is unload-act.test.ts's (the act) and test/prod/unload.test.ts's (the window)
  it('a latched or recovering tab is never a candidate', () => {
    const t = candidate()
    for (const c of [{ latched: true }, { inFlight: 'auto' as const }, { pendingShow: true }]) {
      t.crash = { count: 1, latched: false, ...c }
      expect(unloadRefusal(t, w.clock.now)).toBe('crash')
    }
  })

  it('reopened, then crashed: its first crash, reloaded at once; again within 60 s of that reload, latched', async () => {
    const t = liveTab(w)
    await unloadAndReopen(t)
    expect(t.crash.count).toBe(0)
    crash(t)
    expect(t.crash).toMatchObject({ count: 1, latched: false, inFlight: 'auto' })
    expect(w.reloads).toEqual([t.id])
    lift(t)
    w.clock.now += 10_000
    crash(t)
    expect(t.crash.latched).toBe(true)
    expect(w.reloads).toEqual([t.id])
  })

  it('crash, its automatic reload, 10 s hidden, an unload and the reopen: a crash within 60 s of that reload latches', async () => {
    const t = liveTab(w)
    crash(t)
    lift(t)
    report(t, false)
    expect(t.crash.lastAuto).toBe(w.clock.now)
    await unloadAndReopen(t)
    expect(t.crash).toMatchObject({ count: 1, latched: false })
    w.clock.now += 20_000
    crash(t)
    expect(t.crash.latched).toBe(true)
  })

  it('the same past 60 s: one automatic reload, not latched', async () => {
    const t = liveTab(w)
    crash(t)
    lift(t)
    report(t, false)
    await unloadAndReopen(t)
    w.clock.now += T.crashWindowMs + 1
    const before = w.reloads.length
    crash(t)
    expect(t.crash).toMatchObject({ count: 2, latched: false, inFlight: 'auto' })
    expect(w.reloads.length).toBe(before + 1)
  })
})

describe('the act owns the tab until its close ends (A3.8 r1 #2)', () => {
  it('nothing queued runs while the close is outstanding, however long', async () => {
    const t = candidate()
    const c = closer()
    void guard(t, warn)
    const r = guard(t, { kind: 'reload' })
    for (let i = 0; i < 5; i++) { w.clock.now += 60_000; await flush() }
    expect(w.acts.map((a) => a.action.kind)).toEqual(['unload'])
    expect(isActive(t)).toBe(false)
    c.destroyed(t)
    expect(await r).toBe('done')
  })
})

describe('a link into an unloaded tab opens on what it names, never as the reopen (A3.8 #42, r3 #3)', () => {
  async function unloadedTab(): Promise<Tab> {
    const t = candidate()
    t.path = '/#/b/b?n=k'
    const c = closer()
    const u = guard(t, critical)
    c.destroyed(t)
    await u
    await flush()
    return t
  }

  // views.ts openInTab's documentless branch, as the model sees it
  function openLink(t: Tab, path: string): boolean {
    const armed = linkOpens(t)
    t.path = path
    activate(t.id)
    return armed
  }

  it('unloaded: the unload ends, the load is a plain one - no reopen, no reopening page, no reopen record', async () => {
    const t = await unloadedTab()
    expect(openLink(t, '/#/b/a?n=f1')).toBe(false)
    expect(t.unload).toBeUndefined()
    expect(w.loads).toEqual([t.id])
    expect(w.reopens).toEqual([])
    expect(pageFor(t, w.clock.now)?.page).toBe('starting')
    lift(t)
    expect(t.path).toBe('/#/b/a?n=f1')
    onReport(t.id, t.doc!.doc!, { hello: { version: '0.27.2', board: 'a', page: 'PAGE_link00001' } })
    expect(recs('reopen')).toEqual([])
  })

  it('its canvas still starting: the link\'s path waits for ready, and ready loads it plainly', async () => {
    const t = await unloadedTab()
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
    const e = entry({ ws: t.reg!.ws, state: 'starting', origin: undefined, port: 40777, instance: 'inst-later' })
    onRegistry({ kind: 'entry', entry: e })
    expect(t.reg!.instance).toBe('inst-later')
    expect(openLink(t, '/#/b/a?n=f2')).toBe(false)
    expect(w.loads).toEqual([])
    onRegistry({ kind: 'entry', entry: { ...e, state: 'ready', origin: 'http://[::1]:40777' } })
    expect(w.loads).toEqual([t.id])
    expect(w.reopens).toEqual([])
    expect(t.path).toBe('/#/b/a?n=f2')
  })

  it('a reopen already under way: the unload ends, and the caller is told to take its mv:doc flag back', async () => {
    const t = await unloadedTab()
    activate(t.id)
    expect(w.reopens).toEqual([t.id])
    t.view = 'live'   // its view made, its document not yet lifted
    expect(openLink(t, '/#/b/a?n=f3')).toBe(true)
    expect(t.unload).toBeUndefined()
    expect(pageFor(t, w.clock.now)?.page).not.toBe('reopening')
  })

  it('while its close is outstanding the link is not this: the unload stays, and the link waits through the guard', async () => {
    const t = candidate()
    closer()
    void guard(t, warn)
    expect(linkOpens(t)).toBe(false)
    expect(t.unload?.phase).toBe('closing')
  })
})

describe('the tab page while the close is outstanding (A3.8 #42)', () => {
  it('its canvas stopped meanwhile: the stopped page over the view (nothing kept), never the page being closed', async () => {
    const t = candidate()
    const c = closer()
    const u = guard(t, warn)
    activate(t.id)
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
    expect(pageFor(t, w.clock.now)).toMatchObject({ page: 'stopped', retained: false })
    c.destroyed(t)
    await u
    expect(pageFor(t, w.clock.now)).toMatchObject({ page: 'stopped', retained: false })
  })

  it('rebound to a starting instance on its port meanwhile: the reopening page, the camera not promised', () => {
    const t = candidate()
    closer()
    void guard(t, warn)
    activate(t.id)
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
    onRegistry({ kind: 'entry', entry: entry({ ws: t.reg!.ws, state: 'starting', origin: undefined, port: t.reg!.port, instance: 'inst-restart' }) })
    expect(t.reg!.state).toBe('starting')
    expect(pageFor(t, w.clock.now)).toMatchObject({ page: 'reopening', cameraKept: false })
  })
})

describe('a quit or an update under way holds the reopen (A3.8 #42)', () => {
  it('activated while the quit waits on its sheet: no load; the quit refused, it reopens once', async () => {
    const t = candidate()
    const stale = candidate()
    stale.reports.safety = 'stale'
    const c = closer()
    const u = guard(t, warn)
    c.destroyed(t)
    await u
    await flush()
    const sheet = deferred<boolean>()
    w.askWith = () => sheet.promise
    const q = guardAll({ kind: 'quit' })
    await flush()
    expect(w.sheets).toHaveLength(1)
    activate(t.id)
    expect(w.loads).toEqual([])
    expect(pageFor(t, w.clock.now)?.page).toBe('reopening')
    sheet.resolve(false)
    expect(await q).toBe('refused')
    await flush()
    expect(w.loads).toEqual([t.id])
    expect(w.reopens).toEqual([t.id])
  })
})

describe('a new instance of its canvas on another origin while it closes (A2.14 #10, A3.8 #42)', () => {
  const other = (t: Tab, instance = 'inst-moved') => entry({ ws: t.reg!.ws, port: 40888, origin: 'http://[::1]:40888', instance })

  it('waits for the close: at destroyed the same tab rebinds, unloaded on the new instance; shown, it reopens there, board only', async () => {
    const t = candidate()
    const c = closer()
    const u = guard(t, warn)
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
    onRegistry({ kind: 'entry', entry: other(t) })
    expect(allTabs().filter((x) => x.kind === 'local' && x.reg?.ws === t.reg!.ws)).toEqual([t])   // no tab beside it
    c.destroyed(t)
    await u
    await flush()
    expect(t.reg).toMatchObject({ instance: 'inst-moved', origin: 'http://[::1]:40888', state: 'ready' })
    expect(t.view).toBe('unloaded')
    expect(allTabs().filter((x) => x.kind === 'local' && x.reg?.ws === t.reg!.ws)).toEqual([t])
    activate(t.id)
    expect(w.reopens).toEqual([t.id])
    expect(pageFor(t, w.clock.now)).toMatchObject({ page: 'reopening', cameraKept: false })
  })

  it('the page refuses instead: its kept page stays grey, the instance gets its own tab', async () => {
    const t = candidate()
    const c = closer()
    const u = guard(t, warn)
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
    onRegistry({ kind: 'entry', entry: other(t) })
    c.refuse()
    expect(await u).toBe('refused')
    const mine = allTabs().filter((x) => x.kind === 'local' && x.reg?.ws === t.reg!.ws)
    expect(mine).toHaveLength(2)
    expect(t.reg!.state).toBe('gone')
    expect(mine.find((x) => x !== t)!.reg!.instance).toBe('inst-moved')
  })

  it('an instance gone before the close ended binds nothing; a queued close leaves the next one a tab of its own', async () => {
    const t = candidate()
    const c = closer()
    const u = guard(t, warn)
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
    onRegistry({ kind: 'entry', entry: other(t) })
    onRegistry({ kind: 'gone', file: '/x', instance: 'inst-moved', why: 'pid' })
    onRegistry({ kind: 'entry', entry: other(t, 'inst-third') })
    const close = closeTab(t.id)
    c.destroyed(t)
    await u
    expect(await close).toBe('closed')
    await flush()
    const mine = allTabs().filter((x) => x.kind === 'local' && x.reg?.ws === other(t).ws)
    expect(mine.map((x) => x.reg!.instance)).toEqual(['inst-third'])
    expect(mine[0]).not.toBe(t)
  })
})
