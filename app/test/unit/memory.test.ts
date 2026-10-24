/**
 * Unloading's admission and policy (spec 28 A2.6, A3.8 #40, #41, #45), without Electron: every refusal reason of
 * `unloadRefusal` in its order; `decide` (least recently shown, the cooldown, one soft unload at a time, critical,
 * half of RAM strictly past half, an unknown level never); `canvasMemory` (unique processes, footprint first, RSS
 * the backstop); and the tick on a fake sampler - `wantPressure`, the records (`pressure`, `unload` start,
 * `unload-skip` once per tab and reason in an episode, `unload-effect`), off, and a sweep.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { blankTab, guard, guardAll, onCommit, onUnloaded, onReport, unloadRefusal, type GuardAnswer, type Tab } from '../../src/main/tabs.ts'
import { canvasMemory, decide, figures, resetMemory, startMemory, type Candidate, type DecideInput } from '../../src/main/memory.ts'
import { T } from '../../src/main/timings.ts'
import type { PressureLevel, ProcSample, Sample, Sampler } from '../../../src/shared/app-perf.ts'
import { deferred, flush, liveTab, report, show, world, type Deferred, type World } from './window-fakes.ts'

let w: World
beforeEach(() => { w = world(); resetMemory() })

/** A canvas tab shown once, then hidden (Home shown) long enough: a candidate. */
function candidate(o: Parameters<typeof liveTab>[1] = {}): Tab {
  const t = liveTab(w, o)
  show('home')
  w.clock.now += T.unloadMinHiddenMs
  return t
}

describe('who can be unloaded: each refusal, in its order (A3.8 #40)', () => {
  it('a candidate: a local canvas, hidden 10 s, lifted, trusted, fresh, and exactly idle and clean', () => {
    const t = candidate()
    expect(unloadRefusal(t, w.clock.now)).toBe(null)
  })

  it('not-canvas, active (the window hidden too), no-document', () => {
    expect(unloadRefusal(blankTab('home', 'home', 'Home'), w.clock.now)).toBe('not-canvas')
    expect(unloadRefusal(blankTab('settings', 'settings', 'Settings'), w.clock.now)).toBe('not-canvas')
    const a = liveTab(w)
    w.clock.now += 60_000
    w.visible = false
    expect(unloadRefusal(a, w.clock.now)).toBe('active')
    // never shown, crashed, documentless, already unloading or unloaded
    const never = liveTab(w, { show: false })
    never.retained = false
    expect(unloadRefusal(never, w.clock.now)).toBe('no-document')
    const t = candidate()
    t.view = 'crashed'
    expect(unloadRefusal(t, w.clock.now)).toBe('no-document')
    t.view = 'live'
    t.doc!.lifted = false
    expect(unloadRefusal(t, w.clock.now)).toBe('no-document')
    t.doc!.lifted = true
    t.unload = { phase: 'unloaded', reason: 'warn', at: 0, commit: 1, origin: t.reg!.origin! }
    expect(unloadRefusal(t, w.clock.now)).toBe('no-document')
  })

  it('replacing (any operation but its own), sweeping', async () => {
    const t = candidate()
    const gate = deferred<GuardAnswer>()
    w.actWith = () => gate.promise
    const r = guard(t, { kind: 'reload' })
    expect(unloadRefusal(t, w.clock.now)).toBe('replacing')
    expect(unloadRefusal(t, w.clock.now, t.replacing)).not.toBe('replacing')
    gate.resolve('done')
    await r
  })

  it('no-bridge (0.27.0 never reports), unknown (not heard since its commit), stale (trust gone, or the canvas gone with its page kept)', () => {
    const old = candidate({ entry: { features: [], version: '0.27.0' }, busy: null })
    expect(unloadRefusal(old, w.clock.now)).toBe('no-bridge')
    const quiet = candidate({ busy: null })
    expect(unloadRefusal(quiet, w.clock.now)).toBe('unknown')
    const t = candidate()
    t.doc!.trusted = false
    expect(unloadRefusal(t, w.clock.now)).toBe('stale')
    const s = candidate()
    s.reports.safety = 'stale'
    expect(unloadRefusal(s, w.clock.now)).toBe('stale')
    const gone = candidate()
    gone.reg!.state = 'gone'
    expect(unloadRefusal(gone, w.clock.now)).toBe('stale')
  })

  it('unsaved: each of the five reasons; busy: a Jam session, the microphone and an agent at work, each alone', () => {
    for (const why of ['capture-recording', 'capture-unsent', 'board-unsaved', 'heights', 'typing']) {
      const t = candidate()
      report(t, true, [why])
      expect(unloadRefusal(t, w.clock.now), why).toBe('unsaved')
    }
    for (const why of ['jam-session', 'microphone', 'agent']) {
      const t = candidate()
      report(t, false, [why])
      expect(unloadRefusal(t, w.clock.now), why).toBe('busy')
    }
  })

  it('crash (latched, a reload in flight, one waiting to be shown), hung, audible, devtools, loading', () => {
    const t = candidate()
    for (const c of [{ latched: true }, { inFlight: 'auto' as const }, { inFlight: 'person' as const }, { pendingShow: true }]) {
      t.crash = { count: 1, latched: false, ...c }
      expect(unloadRefusal(t, w.clock.now)).toBe('crash')
    }
    t.crash = { count: 1, latched: false }
    for (const k of ['hung', 'audible', 'devtools', 'loading'] as const) {
      t[k] = true
      expect(unloadRefusal(t, w.clock.now)).toBe(k)
      t[k] = false
    }
    expect(unloadRefusal(t, w.clock.now)).toBe(null)
  })

  it('refused-before: this commit refused once - a new commit is a candidate again; recent: hidden 9.9 s, and 10 s is enough', () => {
    const t = candidate()
    t.unloadRefused = t.doc!.commits
    expect(unloadRefusal(t, w.clock.now)).toBe('refused-before')
    onCommit(t, { gen: 2, url: `${t.reg!.origin}/`, attributed: true, admitted: 'doc-2' })
    report(t, false)
    expect(unloadRefusal(t, w.clock.now)).toBe(null)
    const h = liveTab(w)
    show('home')
    const at = w.clock.now
    expect(unloadRefusal(h, at + 9_900)).toBe('recent')
    expect(unloadRefusal(h, at + 10_000)).toBe(null)
  })

  it('the order holds where several are true: the first wins', () => {
    const t = candidate({ entry: { features: [] }, busy: null })
    t.hung = true
    t.audible = true
    expect(unloadRefusal(t, w.clock.now)).toBe('no-bridge')
    const u = candidate()
    report(u, true, ['typing', 'agent'])
    u.audible = true
    expect(unloadRefusal(u, w.clock.now)).toBe('unsaved')
  })
})

describe('decide (A3.8 #41)', () => {
  const base: DecideInput = { on: true, level: 1, canvasMB: 100, totalMB: 16_384, candidates: [], softInFlight: false, lastSoftAt: null, now: 1_000_000 }
  const c = (id: string, hiddenAt: number): Candidate => ({ id, hiddenAt })
  const three = [c('t3', 300), c('t1', 100), c('t2', 200)]

  it('normal or unknown: nothing', () => {
    expect(decide({ ...base, candidates: three })).toEqual({ unload: [] })
    expect(decide({ ...base, level: null, candidates: three })).toEqual({ unload: [] })
  })

  it('warn: the least recently shown only (a tie to the lower id, by its counter), then the cooldown, then the next', () => {
    expect(decide({ ...base, level: 2, candidates: three })).toEqual({ unload: [{ id: 't1', reason: 'warn' }] })
    expect(decide({ ...base, level: 2, candidates: [c('ta', 5), c('t9', 5), c('t10', 5)] })).toEqual({ unload: [{ id: 't9', reason: 'warn' }] })
    const after = { ...base, level: 2 as PressureLevel, candidates: [c('t3', 300), c('t2', 200)], lastSoftAt: base.now }
    expect(decide({ ...after, now: base.now + T.unloadCooldownMs - 1 })).toEqual({ unload: [] })
    expect(decide({ ...after, now: base.now + T.unloadCooldownMs })).toEqual({ unload: [{ id: 't2', reason: 'warn' }] })
    expect(decide({ ...base, level: 2, candidates: three, softInFlight: true })).toEqual({ unload: [] })
  })

  it('critical: every candidate, least recently shown first, cooldown or a soft one in flight notwithstanding', () => {
    expect(decide({ ...base, level: 4, candidates: three, softInFlight: true, lastSoftAt: base.now })).toEqual({ unload: [
      { id: 't1', reason: 'critical' }, { id: 't2', reason: 'critical' }, { id: 't3', reason: 'critical' },
    ] })
  })

  it('half of RAM: strictly past half, as warn; exactly half is not; no sample is not', () => {
    expect(decide({ ...base, canvasMB: 8193, totalMB: 16_384, candidates: three })).toEqual({ unload: [{ id: 't1', reason: 'half-ram' }] })
    expect(decide({ ...base, canvasMB: 8192, totalMB: 16_384, candidates: three })).toEqual({ unload: [] })
    expect(decide({ ...base, canvasMB: null, candidates: three })).toEqual({ unload: [] })
    expect(decide({ ...base, canvasMB: 8193, totalMB: 16_384, candidates: three, lastSoftAt: base.now - 1 })).toEqual({ unload: [] })
  })

  it('off, or no candidate: nothing, even at critical', () => {
    expect(decide({ ...base, on: false, level: 4, candidates: three })).toEqual({ unload: [] })
    expect(decide({ ...base, level: 4 })).toEqual({ unload: [] })
  })
})

const proc = (o: Partial<ProcSample> = {}): ProcSample => ({ pid: 100, born: 1, type: 'renderer', role: 'canvas', tabs: [], cpu: null, rssMB: 100, footprintMB: null, ...o })
function sample(o: { level?: PressureLevel | null; procs?: ProcSample[]; gpuMB?: number } = {}): Sample {
  return {
    ts: 0, mono: 0, dt: null, procs: o.procs ?? [],
    gpu: o.gpuMB === undefined ? null : { pid: 9, born: 9, cpu: null, gpuProcessRssMB: o.gpuMB },
    pressure: 'level' in o ? { level: o.level ?? null, availablePct: 40, at: 0 } : null,
    thermal: 'nominal', sys: null, visible: null,
  }
}

describe('canvas memory (A3.8 #5, #41)', () => {
  it('each process once: a renderer two tabs list is counted once; a reused pid is a new process', () => {
    expect(canvasMemory(sample({ procs: [proc({ tabs: ['t1', 't2'] }), proc({ tabs: ['t1', 't2'] })] }))).toBe(100)
    expect(canvasMemory(sample({ procs: [proc(), proc({ born: 2, rssMB: 50 })] }))).toBe(150)
  })
  it('footprint first, RSS the backstop; only canvas renderers; none is null', () => {
    expect(canvasMemory(sample({ procs: [proc({ rssMB: 152, footprintMB: 539 }), proc({ pid: 101, rssMB: 40 })] }))).toBe(579)
    expect(canvasMemory(sample({ procs: [proc({ role: 'strip', rssMB: 80 }), proc({ type: 'gpu', role: 'none', rssMB: 300 }), proc({ pid: 102 })] }))).toBe(100)
    expect(canvasMemory(sample({ procs: [proc({ role: 'home' })] }))).toBe(null)
    expect(canvasMemory(sample())).toBe(null)
  })
  it('an unload\'s figures: the pressure, canvas memory, the tab\'s own processes (its iframes\' too), the GPU process', () => {
    const s = sample({ level: 2, gpuMB: 61, procs: [proc({ tabs: ['t1'], footprintMB: 300 }), proc({ pid: 101, tabs: ['t1'], rssMB: 30 }), proc({ pid: 102, tabs: ['t2'] })] })
    expect(figures(s, 't1')).toEqual({ level: 2, availablePct: 40, canvasMB: 430, tab: { pids: [100, 101], memMB: 330 }, gpuProcessRssMB: 61 })
    expect(figures(sample(), 't1')).toEqual({ level: null, availablePct: null, canvasMB: null, tab: { pids: [], memMB: null }, gpuProcessRssMB: null })
  })
})

describe('the tick, on the one sampler (A3.8 #6, #41, #45)', () => {
  let on: boolean
  let total: number
  let emit: (s: Sample) => void
  let want: () => boolean
  // each case's own sampler and its own next sample: an effect a case left waiting never reads the next case's
  let next: { s: Sample | null }
  let events: { kind: string; who: unknown; body: Record<string, unknown> }[]
  let gates: Map<string, Deferred<GuardAnswer>>
  const savedEffect = T.unloadEffectMs

  beforeEach(() => {
    on = true
    total = 16_384
    next = { s: null }
    const mine = next
    events = []
    gates = new Map()
    const sampler: Sampler = {
      onSample(fn) { emit = fn; return () => {} },
      wantPressure(fn) { want = fn },
      requestSample: async () => { if (!mine.s) throw new Error('no sample'); return mine.s },
      last: () => null,
    }
    startMemory({
      config: () => ({ unloadUnderPressure: on }), sampler, totalMB: () => total, now: () => w.clock.now,
      event: (kind, who, body) => { events.push({ kind, who: who && 'id' in who ? who.id : who, body: { ...(body as object) } }) },
    })
    // views.ts's unload act: a close the case ends
    w.actWith = (t, a) => { if (a.kind !== 'unload') return 'done'; const g = deferred<GuardAnswer>(); gates.set(t.id, g); return g.promise }
    ;(T as { unloadEffectMs: number }).unloadEffectMs = 0
  })
  afterEach(() => { (T as { unloadEffectMs: number }).unloadEffectMs = savedEffect })

  const destroyed = (t: Tab) => { onUnloaded(t); gates.get(t.id)!.resolve('done') }
  const kinds = (k: string) => events.filter((e) => e.kind === k)

  it('wantPressure: false off, false with only busy, unknown or active tabs; true with one candidate or one hidden only just now', () => {
    const a = liveTab(w)
    expect(want()).toBe(false)   // only the active tab
    const b = liveTab(w)         // a hidden now (recent)
    expect(want()).toBe(true)
    report(a, false, ['agent'])
    expect(want()).toBe(false)
    report(a, false)
    on = false
    expect(want()).toBe(false)
    on = true
    void b
    expect(want()).toBe(true)
  })

  it('critical: every eligible hidden tab, least recently shown first; the active one kept; a start record with its figures', () => {
    const a = candidate()
    const b = candidate()
    const busy = candidate()
    report(busy, false, ['jam-session'])
    const active = liveTab(w)
    w.clock.now += T.unloadMinHiddenMs
    emit(sample({ level: 4, gpuMB: 70, procs: [proc({ pid: 1, tabs: [a.id], footprintMB: 400 }), proc({ pid: 2, tabs: [b.id] }), proc({ pid: 3, tabs: [active.id] })] }))
    expect(w.acts.map((x) => x.tab)).toEqual([a.id, b.id])
    expect(w.acts.every((x) => x.action.kind === 'unload' && x.action.reason === 'critical')).toBe(true)
    expect(kinds('unload').map((e) => e.who)).toEqual([expect.objectContaining({ tab: a.id }), expect.objectContaining({ tab: b.id })])
    expect(kinds('unload')[0]!.body).toEqual({ phase: 'start', reason: 'critical', before: { level: 4, availablePct: 40, canvasMB: 600, tab: { pids: [1], memMB: 400 }, gpuProcessRssMB: 70 } })
    expect(kinds('unload-skip').map((e) => e.body)).toEqual([{ reason: 'critical', why: 'busy' }])
    expect(kinds('pressure').map((e) => e.body)).toEqual([{ level: 4, availablePct: 40, was: null }])
  })

  it('warn: one at a time, then the cooldown before the next; a refused one leaves no cooldown', async () => {
    const a = candidate()
    const b = candidate()
    const c = candidate()
    emit(sample({ level: 2 }))
    expect(w.acts.map((x) => x.tab)).toEqual([a.id])
    emit(sample({ level: 2 }))
    expect(w.acts).toHaveLength(1)   // one soft unload in flight
    destroyed(a)
    await flush()
    emit(sample({ level: 2 }))
    expect(w.acts).toHaveLength(1)   // the cooldown
    w.clock.now += T.unloadCooldownMs
    emit(sample({ level: 2 }))
    expect(w.acts.map((x) => x.tab)).toEqual([a.id, b.id])
    gates.get(b.id)!.resolve('refused')   // the page refused: nothing freed, no cooldown
    await flush()
    emit(sample({ level: 2 }))
    expect(w.acts.map((x) => x.tab)).toEqual([a.id, b.id, c.id])
  })

  it('half of RAM, measured on footprint first: one half-ram unload with the level unknown; an unknown level with canvas memory at half or below, or none read, never', () => {
    total = 1000
    // the level unknown each time: canvas memory alone decides
    const b = candidate()
    emit(sample({ level: null, procs: [proc({ tabs: [b.id], rssMB: 900, footprintMB: 500 })] }))   // footprint at half: not past it
    emit(sample({ level: null, procs: [] }))                                                      // no canvas process read
    emit(sample({ level: null }))
    expect(w.acts).toEqual([])
    emit(sample({ level: null, procs: [proc({ tabs: [b.id], rssMB: 100, footprintMB: 501 })] }))   // footprint past half, RSS not
    expect(w.acts.map((x) => x.action)).toEqual([{ kind: 'unload', reason: 'half-ram' }])
  })

  it('unload-skip: once per tab and reason in an episode, said again in the next', () => {
    const t = candidate()
    report(t, false, ['microphone'])
    emit(sample({ level: 4 }))
    emit(sample({ level: 4 }))
    emit(sample({ level: 2 }))
    expect(kinds('unload-skip').map((e) => e.body)).toEqual([{ reason: 'critical', why: 'busy' }])
    report(t, true, ['typing'])
    emit(sample({ level: 2 }))
    expect(kinds('unload-skip').map((e) => e.body.why)).toEqual(['busy', 'unsaved'])
    emit(sample({ level: 1 }))   // the episode ends
    emit(sample({ level: 4 }))
    expect(kinds('unload-skip').map((e) => e.body.why)).toEqual(['busy', 'unsaved', 'unsaved'])
    expect(kinds('pressure').map((e) => e.body.level)).toEqual([4, 2, 1, 4])
  })

  it('unload-effect: unloadEffectMs after the unload, the after sample\'s figures and whether its process went', async () => {
    const t = candidate()
    emit(sample({ level: 4, procs: [proc({ pid: 7, born: 70, tabs: [t.id], rssMB: 200 })] }))
    next.s = sample({ level: 2, gpuMB: 50, procs: [proc({ pid: 7, born: 71, tabs: [] })] })   // pid 7 reused: a new process
    destroyed(t)
    await new Promise((r) => setTimeout(r, 30))   // the effect's wait (0 here), then its sample
    expect(kinds('unload-effect')).toEqual([expect.objectContaining({ body: {
      reason: 'critical', pidGone: true,
      before: { level: 4, availablePct: 40, canvasMB: 200, tab: { pids: [7], memMB: 200 }, gpuProcessRssMB: null },
      after: { level: 2, availablePct: 40, canvasMB: 100, tab: { pids: [], memMB: null }, gpuProcessRssMB: 50 },
    } })])
  })

  it('off: nothing unloaded, nothing skipped, at critical; on again, the next tick acts', () => {
    const t = candidate()
    on = false
    emit(sample({ level: 4 }))
    expect(w.acts).toEqual([])
    expect(kinds('unload-skip')).toEqual([])
    on = true
    emit(sample({ level: 4 }))
    expect(w.acts.map((x) => x.tab)).toEqual([t.id])
  })

  it('a quit or an update under way: nothing admitted, nothing said', async () => {
    const t = candidate()
    const holder = candidate()
    report(holder, true, ['typing'])
    const busy = candidate()
    report(busy, false, ['agent'])
    // the sweep is set at once, then refused for the unsaved tab; until then no tick acts
    const q = guardAll({ kind: 'quit' })
    emit(sample({ level: 4 }))
    expect(w.acts).toEqual([])
    expect(kinds('unload-skip')).toEqual([])
    await q
    emit(sample({ level: 4 }))
    expect(w.acts.map((x) => x.tab)).toEqual([t.id])
  })

  it('a hidden page that reports while unknown is never unloaded until it says idle, then is', () => {
    const t = candidate({ busy: null })
    emit(sample({ level: 4 }))
    expect(w.acts).toEqual([])
    onReport(t.id, t.doc!.doc!, { busy: { busy: false, unsaved: false, why: [] } })
    emit(sample({ level: 4 }))
    expect(w.acts.map((x) => x.tab)).toEqual([t.id])
  })
})
