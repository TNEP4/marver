/**
 * The one ground's pure half (spec 28 A2.2, A3.8 #24-#28, #30, #32, r2 #2, r3 #1), without Electron: layout.ts's
 * rules, a case per rule (the geometry's one writer, the ground gate S15 holds shut until a cover is chosen);
 * present.ts's epochs (keys not events, the gen's four events, the GPU process lost or replaced, the size check, the
 * lift's delay); plan.ts's placement and cover; and the rules as tabs.ts hands them the model's events.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitLayout, docInset, onLayoutChange, placed, rectFor, seeThrough, setGround, setInsetOff, type LayoutEvent } from '../../src/main/layout.ts'
import {
  answer, bumpAll, bumpGen, epochOf, flush, forget, genOf, gpuGone, liftAt, noteGpu, observe, onCoverRecord, quitting, resetPresent, showing, uncovered,
  windowHidden, windowShown, type PresentKey,
} from '../../src/main/present.ts'
import { GROUND, plan, type PlanTab } from '../../src/main/plan.ts'
import { allTabs, blankTab, onCommit, onDocumentGone, onFail, onRegistry, onReport, type Tab } from '../../src/main/tabs.ts'
import { T } from '../../src/main/timings.ts'
import type { Present } from '../../../src/shared/app-api.ts'
import { entry, show, world } from './window-fakes.ts'

const reg = (o: Partial<NonNullable<Tab['reg']>> = {}): NonNullable<Tab['reg']> => ({
  state: 'ready', file: '/f', instance: 'i1', ws: 'ws', origin: 'http://[::1]:5301', port: 5301, slot: 1, features: ['bridge', 'inset'], ...o,
})
const canvas = (o: Partial<Tab> = {}): Tab => blankTab('t1', 'local', 'Canvas', { reg: reg(), ...o })
const run = (t: Tab, ...es: LayoutEvent[]) => es.map((e) => commitLayout(t, e))
/** a trusted, lifted document, as tabs.ts leaves it at an attributed commit */
const trusted = (t: Tab) => { t.doc = { gen: 1, url: 'u', trusted: true, doc: 'd1', commits: 1, shown: true, lifted: true }; t.retained = true }

describe('layout.ts: the rules (A3.8 #24-#26)', () => {
  beforeEach(() => setGround(true))
  afterEach(() => setGround(false))

  it('1. start pends full on a ready instance listing inset, below on 0.27.1 (bridge only) and on a starting entry', () => {
    const t = canvas()
    run(t, { kind: 'start', gen: 1 })
    expect(t.geo.pending).toEqual({ gen: 1, instance: 'i1', layout: 'full' })
    const old = canvas({ reg: reg({ features: ['bridge'] }) })
    run(old, { kind: 'start', gen: 1 })
    expect(old.geo.pending).toEqual({ gen: 1, instance: 'i1', layout: 'below' })
    const starting = canvas({ reg: reg({ state: 'starting' }) })
    run(starting, { kind: 'start', gen: 1 })
    expect(starting.geo.pending?.layout).toBe('below')
    const home = blankTab('home', 'home', 'Home')
    run(home, { kind: 'start', gen: 1 })
    expect(home.geo.pending?.layout).toBe('below')
  })

  it('the ground gate: until a cover can sit over a full-height view (S15), every start pends below and mv:doc answers 0', () => {
    setGround(false)
    const t = canvas()
    run(t, { kind: 'start', gen: 1 })
    expect(t.geo).toMatchObject({ layout: 'below', pending: { layout: 'below' } })
    expect(docInset(t)).toBe(0)
    run(t, { kind: 'commit', gen: 1, attributed: true, instance: 'i1' })
    expect(placed(t)).toBe('below')
  })

  it('2. a documentless view takes the pending layout at start (pre-sized); a retained document keeps its own until commit', () => {
    const t = canvas()
    run(t, { kind: 'start', gen: 1 })
    expect(t.geo.layout).toBe('full')
    expect(docInset(t)).toBe(44)
    const kept = canvas({ retained: true, geo: { layout: 'below', htmlFullscreen: false } })
    run(kept, { kind: 'start', gen: 4 })
    expect(kept.geo.layout).toBe('below')
    expect(docInset(kept)).toBe(44)   // the document now committing is the pending one's
    run(kept, { kind: 'commit', gen: 4, attributed: true, instance: 'i1' })
    expect(kept.geo.layout).toBe('full')
  })

  it('3. a commit lands full only for the pending generation, attributed, on its instance; every commit clears the inset', () => {
    const go = (e: Partial<Extract<LayoutEvent, { kind: 'commit' }>>, pre: LayoutEvent[] = [{ kind: 'start', gen: 1 }], o: Partial<Tab> = {}) => {
      const t = canvas({ retained: true, geo: { layout: 'full', htmlFullscreen: false, inset: 44 }, ...o })
      run(t, ...pre, { kind: 'commit', gen: 1, attributed: true, instance: 'i1', ...e })
      return t.geo
    }
    expect(go({})).toEqual({ layout: 'full', htmlFullscreen: false })
    expect(go({ instance: 'i2' }).layout).toBe('below')                                     // another instance
    expect(go({}, [{ kind: 'start', gen: 1 }], { reg: reg({ instance: 'i9' }) }).layout).toBe('below')   // not the tab's own
    expect(go({ attributed: false }).layout).toBe('below')                                  // unattributed: below, reloaded beneath its page
    expect(go({ instance: undefined }).layout).toBe('below')
    expect(go({}, []).layout).toBe('below')                                                  // no pending (dropped by a rebind)
    expect(go({ gen: 2 }, [{ kind: 'start', gen: 1 }]).layout).toBe('below')               // another generation
    expect(go({}).inset).toBeUndefined()
  })

  it('4. a failure keeps the committed layout and drops pending; an error page committed goes below, its inset cleared (A3.8 #25)', () => {
    const t = canvas({ retained: true, geo: { layout: 'full', htmlFullscreen: false, inset: 44 } })
    run(t, { kind: 'start', gen: 2 }, { kind: 'fail', gen: 2, errorPage: false })
    expect(t.geo).toEqual({ layout: 'full', htmlFullscreen: false, inset: 44 })
    run(t, { kind: 'start', gen: 3 }, { kind: 'fail', gen: 3, errorPage: true })
    expect(t.geo).toEqual({ layout: 'below', htmlFullscreen: false })
  })

  it('5. an abort of the pending generation drops it, the layout unchanged; an older generation\'s abort changes nothing', () => {
    const t = canvas({ retained: true, geo: { layout: 'full', htmlFullscreen: false, inset: 44 } })
    run(t, { kind: 'start', gen: 5 })
    expect(commitLayout(t, { kind: 'abort', gen: 4 })).toBe(false)
    expect(t.geo.pending?.gen).toBe(5)
    expect(commitLayout(t, { kind: 'abort', gen: 5 })).toBe(true)
    expect(t.geo).toEqual({ layout: 'full', htmlFullscreen: false, inset: 44 })
  })

  it('6. a rebind and gone drop pending at once, the committed layout kept; a commit after them lands below', () => {
    for (const kind of ['rebind', 'gone'] as const) {
      const t = canvas({ retained: true, geo: { layout: 'full', htmlFullscreen: false, inset: 44 } })
      run(t, { kind: 'start', gen: 1 }, { kind })
      expect(t.geo).toEqual({ layout: 'full', htmlFullscreen: false, inset: 44 })
      run(t, { kind: 'commit', gen: 1, attributed: true, instance: 'i1' })
      expect(t.geo.layout).toBe('below')
    }
  })

  it('7. hello: inset 0 moves a full layout below; 44 keeps it; it never moves below to full, nor back after a 0', () => {
    const t = canvas({ geo: { layout: 'full', htmlFullscreen: false } })
    run(t, { kind: 'hello', inset: 44 })
    expect(t.geo).toEqual({ layout: 'full', htmlFullscreen: false, inset: 44 })
    run(t, { kind: 'hello', inset: 0 })
    expect(t.geo).toEqual({ layout: 'below', htmlFullscreen: false, inset: 0 })
    run(t, { kind: 'hello', inset: 44 })
    expect(t.geo.layout).toBe('below')
    const b = canvas()
    run(b, { kind: 'hello', inset: 44 })
    expect(b.geo.layout).toBe('below')
  })

  it('8. HTML fullscreen places the view below whatever its layout; leaving gives the layout back', () => {
    const t = canvas({ geo: { layout: 'full', htmlFullscreen: false, inset: 44 } })
    trusted(t)
    expect([placed(t), seeThrough(t)]).toEqual(['full', true])
    run(t, { kind: 'html-fullscreen', on: true })
    expect([placed(t), seeThrough(t), t.geo.layout]).toEqual(['below', false, 'full'])
    run(t, { kind: 'html-fullscreen', on: false })
    expect([placed(t), seeThrough(t)]).toEqual(['full', true])
  })

  it('9. a renderer gone and a view gone reset everything to below', () => {
    for (const kind of ['renderer-gone', 'view-gone'] as const) {
      const t = canvas({ geo: { layout: 'full', htmlFullscreen: true, inset: 44, pending: { gen: 3, instance: 'i1', layout: 'full' } } })
      run(t, { kind })
      expect(t.geo).toEqual({ layout: 'below', htmlFullscreen: false })
    }
  })

  it('10. docInset: 44 from a full pending, else from a full committed layout, else 0', () => {
    expect(docInset(canvas({ geo: { layout: 'below', htmlFullscreen: false, pending: { gen: 1, instance: 'i1', layout: 'full' } } }))).toBe(44)
    expect(docInset(canvas({ geo: { layout: 'full', htmlFullscreen: false } }))).toBe(44)
    expect(docInset(canvas({ geo: { layout: 'full', htmlFullscreen: false, pending: { gen: 1, instance: 'i1', layout: 'below' } } }))).toBe(0)
    expect(docInset(canvas())).toBe(0)
  })

  it('the test build\'s inset switch (A3.8 #51): every document told 0 while it is on; a hello of 0 then moves it below', () => {
    const t = canvas({ geo: { layout: 'full', htmlFullscreen: false } })
    setInsetOff(true)
    try {
      expect(docInset(t)).toBe(0)
      run(t, { kind: 'hello', inset: 0 })
      expect(placed(t)).toBe('below')
    } finally { setInsetOff(false) }
    expect(docInset(canvas({ geo: { layout: 'full', htmlFullscreen: false } }))).toBe(44)
  })

  it('seeThrough needs all of it: local, placed full, trusted, lifted, and a hello that said 44', () => {
    const t = canvas({ geo: { layout: 'full', htmlFullscreen: false, inset: 44 } })
    expect(seeThrough(t)).toBe(false)   // no document
    trusted(t)
    expect(seeThrough(t)).toBe(true)
    t.doc!.trusted = false
    expect(seeThrough(t)).toBe(false)   // its canvas gone: covered, still full height
    t.doc!.trusted = true
    t.geo.inset = undefined
    expect(seeThrough(t)).toBe(false)   // it has not said hello
  })

  it('rectFor: the app\'s pages always full; a canvas where placed() says', () => {
    expect(rectFor('app-page', 1280, 820)).toEqual({ x: 0, y: 0, width: 1280, height: 820 })
    expect(rectFor(blankTab('home', 'home', 'Home'), 1280, 820)).toEqual({ x: 0, y: 0, width: 1280, height: 820 })
    expect(rectFor(blankTab('settings', 'settings', 'Settings'), 1280, 820)).toEqual({ x: 0, y: 0, width: 1280, height: 820 })
    expect(rectFor(canvas(), 1280, 820)).toEqual({ x: 0, y: 44, width: 1280, height: 776 })
    expect(rectFor(canvas({ geo: { layout: 'full', htmlFullscreen: false } }), 1280, 820)).toEqual({ x: 0, y: 0, width: 1280, height: 820 })
    expect(rectFor(canvas({ geo: { layout: 'full', htmlFullscreen: true } }), 1280, 820)).toEqual({ x: 0, y: 44, width: 1280, height: 776 })
  })

  it('commitLayout says whether anything changed, and journals only changes', () => {
    const lines: string[] = []
    onLayoutChange((d) => lines.push(`${d.event}:${d.from.layout}->${d.to.layout}`))
    try {
      const t = canvas()
      expect(commitLayout(t, { kind: 'abort', gen: 1 })).toBe(false)
      expect(commitLayout(t, { kind: 'start', gen: 1 })).toBe(true)
      expect(commitLayout(t, { kind: 'start', gen: 1 })).toBe(false)
      expect(lines).toEqual(['start:below->full'])
    } finally { onLayoutChange(null) }
  })
})

describe('layout.ts as tabs.ts hands it the model\'s events', () => {
  beforeEach(() => setGround(true))
  afterEach(() => setGround(false))

  it('an attributed commit on an inset canvas lands full; its accepted hello says 44; a crash resets it; the registry\'s gone keeps it', () => {
    world()
    const e = entry({ features: ['bridge', 'inset'] })
    onRegistry({ kind: 'entry', entry: e })
    const t = allTabs().find((x) => x.reg?.instance === e.instance)!
    show(t.id)
    commitLayout(t, { kind: 'start', gen: 1 })
    expect(t.geo.layout).toBe('full')   // pre-sized: nothing shown yet
    onCommit(t, { gen: 1, url: `${e.origin}/`, attributed: true, admitted: 'doc-1', instance: e.instance })
    expect(t.geo).toEqual({ layout: 'full', htmlFullscreen: false })
    const g0 = genOf(t.id)
    onReport(t.id, 'doc-1', { hello: { version: '0.27.2', board: null, page: 'PAGE_0123456789', inset: 44 } })
    expect(t.geo.inset).toBe(44)
    expect(seeThrough(t)).toBe(true)
    expect(genOf(t.id)).toBe(g0 + 1)   // the accepted hello advanced the view's gen
    // a second hello of the same document is not accepted again: it cannot move the layout
    onReport(t.id, 'doc-1', { hello: { version: '0.27.2', board: null, page: 'PAGE_0123456789', inset: 0 } })
    expect(t.geo.layout).toBe('full')
    onRegistry({ kind: 'gone', file: e.file, instance: e.instance, why: 'pid' })
    expect([t.geo.layout, seeThrough(t)]).toEqual(['full', false])   // kept full height, covered
    onDocumentGone(t, 'crashed')
    expect(t.geo).toEqual({ layout: 'below', htmlFullscreen: false })
  })

  it('a 0.27.2 page that said inset 0 is moved below; a failure without an error page keeps the layout', () => {
    world()
    const e = entry({ features: ['bridge', 'inset'] })
    onRegistry({ kind: 'entry', entry: e })
    const t = allTabs().find((x) => x.reg?.instance === e.instance)!
    show(t.id)
    commitLayout(t, { kind: 'start', gen: 1 })
    onCommit(t, { gen: 1, url: `${e.origin}/`, attributed: true, admitted: 'doc-1', instance: e.instance })
    onFail(t, { why: 'unreachable', code: -102, errorPage: false, gen: 1 })
    expect(t.geo.layout).toBe('full')
    onFail(t, { why: 'unreachable', code: -102, errorPage: true, gen: 1 })
    expect(t.geo.layout).toBe('below')
    const f = entry({ features: ['bridge', 'inset'] })
    onRegistry({ kind: 'entry', entry: f })
    const u = allTabs().find((x) => x.reg?.instance === f.instance)!
    commitLayout(u, { kind: 'start', gen: 1 })
    onCommit(u, { gen: 1, url: `${f.origin}/`, attributed: true, admitted: 'doc-2', instance: f.instance })
    onReport(u.id, 'doc-2', { hello: { version: '0.27.2', board: null, page: 'PAGE_0123456789', inset: 0 } })
    expect([u.geo.layout, u.geo.inset]).toEqual(['below', 0])
  })
})

describe('present.ts: epochs (A3.8 #27, #28, r2 #2, r3 #1)', () => {
  beforeEach(() => resetPresent())
  const K = (o: Partial<PresentKey> = {}): PresentKey => ({ doc: 'd1', w: 1280, h: 820, fs: false, gen: 0, ...o })
  const sent: Present[] = []
  const send = (ok = true) => (_doc: string, r: Present) => { sent.push(r); return ok }
  const GPU = { pid: 10, born: 100 }
  beforeEach(() => { sent.length = 0 })

  it('1. a new key makes a new epoch, unanswered; the same key twice makes none (resize + setTimeout(0))', () => {
    expect(observe('t1', K(), 0)).toBe(false)
    const e = epochOf('t1')
    expect(observe('t1', K(), 1)).toBe(false)
    expect(epochOf('t1')).toBe(e)
    observe('t1', K({ w: 1000 }), 2)
    expect(epochOf('t1')).toBe(e! + 1)
    observe('t1', K({ doc: 'd2', w: 1000 }), 3)
    observe('t1', K({ doc: 'd2', w: 1000, fs: true }), 3)
    observe('t1', K({ doc: 'd2', w: 1000, fs: true, gen: 1 }), 3)
    expect(epochOf('t1')).toBe(e! + 4)
  })

  it('2. the current epoch at its size is ok; an older one, another doc, or a size off by more than 1 px is not, and leaves it covered', () => {
    observe('t1', K(), 0)
    flush('t1', send(), 2)
    const e = epochOf('t1')!
    expect(answer('t1', 'd1', { epoch: e - 1, w: 1280, h: 820 }, 1, GPU)).toBe('stale')
    expect(answer('t1', 'd9', { epoch: e, w: 1280, h: 820 }, 1, GPU)).toBe('stale')
    expect(answer('t1', 'd1', { epoch: e, w: 1278, h: 820 }, 1, GPU)).toBe('mismatch')
    expect(observe('t1', K(), 2)).toBe(false)
    expect(answer('t1', 'd1', { epoch: e, w: 1280.6, h: 819 }, 3, GPU)).toBe('ok')
    expect(observe('t1', K(), 3)).toBe(true)
    expect(answer('t2', 'd1', { epoch: e, w: 1280, h: 820 }, 3, GPU)).toBe('refused')   // nothing was asked of t2
  })

  it('3. flush sends once per epoch, with its size and frames clamped 1-8; a failed send is retried by the next flush', () => {
    observe('t1', K(), 0)
    flush('t1', send(false), 2)
    flush('t1', send(), 2)
    flush('t1', send(), 2)
    expect(sent.map((r) => [r.epoch, r.w, r.h, r.frames])).toEqual([[1, 1280, 820, 2], [1, 1280, 820, 2]])
    observe('t1', K({ h: 700 }), 1)
    flush('t1', send(), 99)
    expect(sent.at(-1)).toEqual({ epoch: 2, w: 1280, h: 700, frames: 8 })
    observe('t1', K({ h: 600 }), 1)
    flush('t1', send(), 0)
    expect(sent.at(-1)!.frames).toBe(1)
  })

  it('4. uncoverDelayMs: answered but before its delay, observe is false; after it, true', () => {
    const was = T.uncoverDelayMs
    T.uncoverDelayMs = 33
    try {
      observe('t1', K(), 0)
      flush('t1', send(), 2)
      expect(answer('t1', 'd1', { epoch: epochOf('t1')!, w: 1280, h: 820 }, 100, GPU)).toBe('ok')
      expect(liftAt('t1')).toBe(133)
      expect(observe('t1', K(), 120)).toBe(false)
      expect(observe('t1', K(), 133)).toBe(true)
    } finally { T.uncoverDelayMs = was }
  })

  it('5. forget, and every gen event, make the next observe a fresh epoch', () => {
    observe('t1', K(), 0)
    flush('t1', send(), 2)
    answer('t1', 'd1', { epoch: epochOf('t1')!, w: 1280, h: 820 }, 1, GPU)
    expect(observe('t1', K(), 1)).toBe(true)
    bumpGen('t1')
    expect(observe('t1', K({ gen: genOf('t1') }), 2)).toBe(false)
    forget('t1')
    expect([epochOf('t1'), genOf('t1')]).toEqual([null, 0])
    expect(observe('t1', K(), 3)).toBe(false)
  })

  it('6. epochs never repeat across tabs and documents', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 20; i++) {
      for (const tab of ['t1', 't2', 't3']) { observe(tab, K({ doc: `d${i}`, w: 800 + i }), i); seen.add(epochOf(tab)!) }
      forget('t2')
    }
    expect(seen.size).toBe(60)
  })

  it('r2 #2: a live resize that ends at the size it started from makes a new epoch; a compose with no event makes none', () => {
    observe('t1', K(), 0)
    const e = epochOf('t1')!
    observe('t1', K(), 1)
    expect(epochOf('t1')).toBe(e)
    bumpAll()                                    // the live resize ended (window.ts), same w x h
    observe('t1', K({ gen: genOf('t1') }), 2)
    expect(epochOf('t1')).toBe(e + 1)
  })

  it('r2 #2: the GPU process gone at an unchanged document and size covers every view; a reply of the epoch before the loss changes nothing', () => {
    expect(noteGpu(GPU)).toBe(false)             // the first read is a baseline, not a loss
    for (const tab of ['t1', 't2']) { observe(tab, K({ doc: tab }), 0); flush(tab, send(), 2); answer(tab, tab, { epoch: epochOf(tab)!, w: 1280, h: 820 }, 1, GPU) }
    expect(observe('t1', K({ doc: 't1' }), 1)).toBe(true)
    const before = epochOf('t1')!
    gpuGone()
    expect(observe('t2', K({ doc: 't2', gen: genOf('t2') }), 2)).toBe(false)
    expect(observe('t1', K({ doc: 't1', gen: genOf('t1') }), 2)).toBe(false)
    expect(answer('t1', 't1', { epoch: before, w: 1280, h: 820 }, 3, { pid: 11, born: 200 })).toBe('stale')
    flush('t1', send(), 2)
    expect(answer('t1', 't1', { epoch: epochOf('t1')!, w: 1280, h: 820 }, 4, { pid: 11, born: 200 })).toBe('ok')   // the replacement is a fresh baseline
    expect(observe('t1', K({ doc: 't1', gen: genOf('t1') }), 4)).toBe(true)
  })

  it('r3 #1: a GPU process replaced with no child-process-gone (an identity changed at a read, or missing) covers every view at a new epoch', () => {
    noteGpu(GPU)
    observe('t1', K(), 0); flush('t1', send(), 2); answer('t1', 'd1', { epoch: epochOf('t1')!, w: 1280, h: 820 }, 1, GPU)
    expect(noteGpu(GPU)).toBe(false)
    expect(noteGpu({ pid: 10, born: 101 })).toBe(true)   // a reused pid is another process
    expect(observe('t1', K({ gen: genOf('t1') }), 2)).toBe(false)
    expect(noteGpu(null)).toBe(true)                      // missing is a loss too
  })

  it('A3.8 #27: only the active, shown view\'s reply counts - one from a tab switched away before it answered is refused, and lifts nothing when shown again', () => {
    observe('t1', K(), 0)
    flush('t1', send(), 2)
    const e = epochOf('t1')!
    observe('t2', K({ doc: 'd2' }), 10)                    // switched to t2 before t1 answered
    expect(answer('t1', 'd1', { epoch: e, w: 1280, h: 820 }, 20, GPU)).toBe('refused')
    showing(null, 30)                                     // Home: no view shown
    expect(answer('t2', 'd2', { epoch: epochOf('t2')!, w: 1280, h: 820 }, 40, GPU)).toBe('refused')
    // shown again with the gen window.ts bumps at a show after hidden: a fresh epoch; the old acceptance never existed
    bumpGen('t1')
    expect(observe('t1', K({ gen: genOf('t1') }), 50)).toBe(false)
    expect(epochOf('t1')).not.toBe(e)
    expect(answer('t1', 'd1', { epoch: e, w: 1280, h: 820 }, 60, GPU)).toBe('stale')
    flush('t1', send(), 2)
    expect(answer('t1', 'd1', { epoch: epochOf('t1')!, w: 1280, h: 820 }, 70, GPU)).toBe('ok')
    // forgotten while shown: nothing is shown, so a reply is refused
    forget('t1')
    expect(answer('t1', 'd1', { epoch: 1, w: 1280, h: 820 }, 80, GPU)).toBe('refused')
  })

  it('r3 #1: a reply that arrives after a replacement main has not yet read is refused - the identity is read in the turn of acceptance', () => {
    noteGpu(GPU)
    observe('t1', K(), 0)
    flush('t1', send(), 2)
    const e = epochOf('t1')!
    expect(answer('t1', 'd1', { epoch: e, w: 1280, h: 820 }, 1, { pid: 12, born: 300 })).toBe('lost')
    expect(observe('t1', K(), 1)).toBe(false)              // and its key's gen moved: a fresh epoch is due
    expect(observe('t1', K({ gen: genOf('t1') }), 1)).toBe(false)
    expect(epochOf('t1')).toBe(e + 1)
  })
})

describe('present.ts: the cover record, one per sent epoch (A3.8 #27; app-perf.ts `cover`)', () => {
  const K = (o: Partial<PresentKey> = {}): PresentKey => ({ doc: 'd1', w: 1280, h: 820, fs: false, gen: 0, ...o })
  const GPU = { pid: 10, born: 100 }
  const recs: { tab: string; epoch: number; r: Record<string, unknown> }[] = []
  const send = () => true
  beforeEach(() => { resetPresent(); recs.length = 0; onCoverRecord((tab, epoch, r) => recs.push({ tab, epoch, r: r as unknown as Record<string, unknown> })) })
  afterEach(() => onCoverRecord(null))

  it('uncovered: its cause, the frames it asked for, and its times from its start - sent, answered, uncovered', () => {
    observe('t1', K(), 1000)
    flush('t1', send, 2, 1010)
    answer('t1', 'd1', { epoch: epochOf('t1')!, w: 1280, h: 820 }, 1050, GPU)
    uncovered('t1', 1052)
    uncovered('t1', 1060)                                   // once only
    expect(recs).toEqual([{ tab: 't1', epoch: 1, r: { epoch: 1, cause: 'doc', outcome: 'uncovered', sentMs: 10, answeredMs: 50, uncoveredMs: 52, frames: 2, uncoverDelayMs: 0 } }])
  })

  it('superseded inside a second; never past a second unanswered; a mismatch once; an epoch never sent records nothing', () => {
    observe('t1', K(), 0)                                   // never sent: no record when superseded
    observe('t1', K({ w: 1000 }), 10)
    flush('t1', send, 2, 20)
    observe('t1', K({ w: 900 }), 500)                       // superseded at 480 ms after its send
    flush('t1', send, 2, 510)
    observe('t1', K({ w: 800 }), 1600)                      // unanswered 1090 ms after its send: never
    flush('t1', send, 2, 1600)
    answer('t1', 'd1', { epoch: epochOf('t1')!, w: 700, h: 820 }, 1700, GPU)
    answer('t1', 'd1', { epoch: epochOf('t1')!, w: 700, h: 820 }, 1710, GPU)
    expect(recs.map((x) => [x.r.cause, x.r.outcome])).toEqual([['size', 'superseded'], ['size', 'never'], ['size', 'mismatch']])
    expect(recs[2]!.r).toMatchObject({ answeredMs: 100 })
    forget('t1', 9000)                                      // already recorded: nothing more
    expect(recs).toHaveLength(3)
  })

  it('a tab switched away before it answered: superseded at the hide, with hiddenMs - never "never" for time it spent hidden', () => {
    observe('t1', K(), 0)
    flush('t1', send, 2, 0)                                 // sent at 0
    observe('t2', K({ doc: 'd2' }), 50)                      // hidden at +50 ms
    bumpGen('t1')
    observe('t1', K({ gen: genOf('t1') }), 5050)             // shown again 5 s later: a fresh epoch
    expect(recs).toEqual([{ tab: 't1', epoch: 1, r: { epoch: 1, cause: 'doc', outcome: 'superseded', sentMs: 0, hiddenMs: 50, frames: 2, uncoverDelayMs: 0 } }])
    // shown a second and more with no answer before it was hidden: never, with the time it was hidden
    flush('t1', send, 2, 5050)
    showing(null, 6200)
    expect(recs.at(-1)!.r).toMatchObject({ cause: 'show', outcome: 'never', sentMs: 0, hiddenMs: 1150 })
    // a reply that comes back after it is refused, and records nothing more
    expect(answer('t1', 'd1', { epoch: epochOf('t1')!, w: 1280, h: 820 }, 6300, GPU)).toBe('refused')
    expect(recs).toHaveLength(2)
  })

  it('the window hidden (⇧⌘W): the open epoch\'s record ends at the hide; its reply after the window shows still lifts the cover, recording nothing more', () => {
    observe('t1', K(), 0)
    flush('t1', send, 2, 10)
    windowHidden(40)
    expect(recs.map((x) => x.r)).toEqual([{ epoch: 1, cause: 'doc', outcome: 'superseded', sentMs: 10, hiddenMs: 40, frames: 2, uncoverDelayMs: 0 }])
    // shown again an hour later: the same key (A3.8 #27's residual), the same epoch; its answer is accepted
    expect(observe('t1', K(), 3_600_000)).toBe(false)
    expect(answer('t1', 'd1', { epoch: 1, w: 1280, h: 820 }, 3_600_020, GPU)).toBe('ok')
    expect(observe('t1', K(), 3_600_020)).toBe(true)
    uncovered('t1', 3_600_020)
    expect(recs).toHaveLength(1)
  })

  it('the window hidden, the page reloading meanwhile: nothing is asked until it shows, and no record says never or counts the time hidden', () => {
    const asks: number[] = []
    const ask = (_doc: string, r: Present) => { asks.push(r.epoch); return true }
    observe('t1', K(), 0); flush('t1', ask, 2, 0)
    answer('t1', 'd1', { epoch: epochOf('t1')!, w: 1280, h: 820 }, 30, GPU)
    expect(observe('t1', K(), 30)).toBe(true)
    uncovered('t1', 30)
    windowHidden(100)                                       // ⇧⌘W, or another window over it
    observe('t1', K({ doc: 'd2' }), 5_000)                  // the page's own resume reload, while hidden: held
    flush('t1', ask, 2, 5_000)
    observe('t1', K({ doc: 'd3' }), 8_000)                  // a hello after a `marver dev` restart, 3 s later: held too
    flush('t1', ask, 2, 8_000)
    expect(asks).toEqual([1])                               // nothing went to a page whose frames had stopped
    expect(windowShown(3_608_000)).toBe(true)               // shown an hour later
    expect(windowShown(3_608_001)).toBe(false)              // the minimise's restore and the occlusion's show: once
    observe('t1', K({ doc: 'd3' }), 3_608_000)
    flush('t1', ask, 2, 3_608_000)
    expect(asks).toEqual([1, 3])                            // the held epoch, now; the one it superseded never sent
    answer('t1', 'd3', { epoch: 3, w: 1280, h: 820 }, 3_608_040, GPU)
    expect(observe('t1', K({ doc: 'd3' }), 3_608_040)).toBe(true)
    uncovered('t1', 3_608_040)
    expect(recs.map((x) => x.r)).toEqual([
      { epoch: 1, cause: 'doc', outcome: 'uncovered', sentMs: 0, answeredMs: 30, uncoveredMs: 30, frames: 2, uncoverDelayMs: 0 },
      { epoch: 3, cause: 'doc', outcome: 'uncovered', sentMs: 0, answeredMs: 40, uncoveredMs: 40, frames: 2, uncoverDelayMs: 0 },
    ])
  })

  it('made hidden, the window asks nothing before its first show; minimised and restored, the same', () => {
    const asks: number[] = []
    const ask = (_doc: string, r: Present) => { asks.push(r.epoch); return true }
    windowHidden(0)                                         // openWindow: show: false
    observe('t1', K(), 10); flush('t1', ask, 2, 10)
    expect(asks).toEqual([])
    windowShown(250); flush('t1', ask, 2, 250)
    expect(asks).toEqual([1])
    answer('t1', 'd1', { epoch: 1, w: 1280, h: 820 }, 290, GPU); uncovered('t1', 290)
    expect(recs.at(-1)!.r).toMatchObject({ outcome: 'uncovered', sentMs: 0, answeredMs: 40 })
    windowHidden(1000)                                      // minimised
    bumpGen('t1', 'hello'); observe('t1', K({ gen: genOf('t1') }), 1500); flush('t1', ask, 2, 1500)
    expect(asks).toEqual([1])
    windowShown(9000); flush('t1', ask, 2, 9000)
    expect(asks).toEqual([1, 2])
    answer('t1', 'd1', { epoch: 2, w: 1280, h: 820 }, 9030, GPU); uncovered('t1', 9030)
    expect(recs.at(-1)!.r).toMatchObject({ cause: 'hello', outcome: 'uncovered', sentMs: 0, answeredMs: 30 })
  })

  it('quitting: every sent epoch still open is recorded at the quit; one recorded already, or never sent, is not', () => {
    observe('t1', K(), 0); flush('t1', send, 2, 0)
    observe('t2', K({ doc: 'd2' }), 100); flush('t2', send, 2, 100)   // t1 hidden at 100: recorded then
    observe('t3', K({ doc: 'd3' }), 200)                              // t2 hidden at 200; t3 never sent
    quitting(300)
    expect(recs.map((x) => [x.tab, x.r.outcome, x.r.hiddenMs])).toEqual([['t1', 'superseded', 100], ['t2', 'superseded', 100]])
  })

  it('each gen event names itself: shown, hello, a live resize\'s end, the GPU process; HTML fullscreen and a new document too', () => {
    const next = (k: PresentKey, at: number) => { observe('t1', k, at); flush('t1', send, 2, at) }
    next(K(), 0)
    bumpGen('t1', 'hello'); next(K({ gen: genOf('t1') }), 10)
    bumpGen('t1'); next(K({ gen: genOf('t1') }), 20)
    bumpAll(); next(K({ gen: genOf('t1') }), 30)
    gpuGone(); next(K({ gen: genOf('t1') }), 40)
    next(K({ gen: genOf('t1'), fs: true }), 50)
    next(K({ gen: genOf('t1'), fs: true, doc: 'd2' }), 60)
    forget('t1', 70)
    expect(recs.map((x) => x.r.cause)).toEqual(['doc', 'hello', 'show', 'resize', 'gpu', 'fullscreen', 'doc'])
    expect(recs.every((x) => x.r.outcome === 'superseded')).toBe(true)
  })
})

describe('plan.ts: the one ground\'s placement and cover (A3.8 #24, #30, #32)', () => {
  const tab = (id: string, kind: PlanTab['kind'], o: Partial<PlanTab> = {}): PlanTab => ({ id, kind, view: true, page: false, pageView: false, dark: false, ...o })
  const FULL = { x: 0, y: 0, width: 1280, height: 820 }
  const BELOW = { x: 0, y: 44, width: 1280, height: 776 }
  const P = (tabs: PlanTab[], active: string, o: { resizing?: boolean } = {}) => plan({ tabs, active, w: 1280, h: 820, appDark: false, ...o })
  const see = { placed: 'full' as const, seeThrough: true, presented: true }

  it('the active see-through canvas, presented: full, the cover hidden; not yet presented, or resizing: covered', () => {
    let p = P([tab('home', 'home'), tab('t1', 'local', see)], 't1')
    expect(p.views.find((v) => v.key === 't1:view')).toMatchObject({ rect: FULL, visible: true })
    expect(p.cover.visible).toBe(false)
    expect(P([tab('home', 'home'), tab('t1', 'local', { ...see, presented: false })], 't1').cover.visible).toBe(true)
    expect(P([tab('home', 'home'), tab('t1', 'local', see)], 't1', { resizing: true }).cover.visible).toBe(true)
    p = P([tab('home', 'home'), tab('t1', 'local', { ...see, seeThrough: false })], 't1')
    expect(p.views.find((v) => v.key === 't1:view')!.rect).toEqual(FULL)       // an untrusted full document: full, covered
    expect(p.cover.visible).toBe(true)
  })

  it('a below canvas: {0, 44, w, h - 44}, covered; HTML fullscreen is below (placed() says so), covered', () => {
    const p = P([tab('home', 'home'), tab('t1', 'local', { placed: 'below' })], 't1')
    expect(p.views.find((v) => v.key === 't1:view')!.rect).toEqual(BELOW)
    expect(p.cover).toMatchObject({ visible: true, rect: { x: 0, y: 0, width: 1280, height: 44 } })
    expect(P([tab('home', 'home'), tab('t1', 'local', { placed: 'below', seeThrough: false, presented: false })], 't1').cover.visible).toBe(true)
  })

  it('a tab page showing: the page full, the view hidden beneath it, the cover hidden (the page paints its own ground)', () => {
    const p = P([tab('home', 'home'), tab('t1', 'local', { ...see, page: true, pageView: true })], 't1')
    expect(p.views.find((v) => v.key === 't1:page')).toMatchObject({ rect: FULL, visible: true })
    expect(p.views.find((v) => v.key === 't1:view')!.visible).toBe(false)
    expect(p.cover.visible).toBe(false)
  })

  it('Home and Settings full and the cover hidden over them; every view keeps its own placement, shown or hidden', () => {
    const tabs = [tab('home', 'home'), tab('t1', 'local', see), tab('t2', 'local', { placed: 'below' }), tab('settings', 'settings')]
    for (const active of ['home', 'settings']) {
      const p = P(tabs, active)
      expect(p.cover.visible).toBe(false)
      expect(p.views.find((v) => v.key === `${active}:view`)).toMatchObject({ rect: FULL, visible: true })
      expect(p.views.find((v) => v.key === 't1:view')).toMatchObject({ rect: FULL, visible: false })
      expect(p.views.find((v) => v.key === 't2:view')).toMatchObject({ rect: BELOW, visible: false })
    }
    // Home with no view yet (the first turns of a launch): covered, never a hole
    expect(P([tab('home', 'home', { view: false })], 'home').cover.visible).toBe(true)
  })

  it('a kind the plan does not know (remote, A4) is below and never see-through; a canvas with no view yet is covered', () => {
    const p = P([tab('home', 'home'), tab('r1', 'remote', see)], 'r1')
    expect(p.views.find((v) => v.key === 'r1:view')!.rect).toEqual(BELOW)
    expect(p.cover.visible).toBe(true)
    expect(P([tab('home', 'home'), tab('t1', 'local', { ...see, view: false })], 't1').cover.visible).toBe(true)
  })

  it('the cover wears the ground of the active tab\'s look; Home and Settings the app\'s', () => {
    expect(P([tab('home', 'home'), tab('t1', 'local', { dark: true })], 't1').cover).toMatchObject({ color: GROUND.dark, dark: true })
    expect(plan({ tabs: [tab('home', 'home'), tab('t1', 'local', { dark: true })], active: 'home', w: 800, h: 600, appDark: false }).cover).toMatchObject({ color: GROUND.light, dark: false })
  })
})
