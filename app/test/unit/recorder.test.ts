/**
 * The recorder's main side (spec 28 A3.7, A3.8 #4-#9, r4 #1) against fakes of Electron, the window and the bridge:
 * the one sampler stops (no getAppMetrics, no sysctl) while nothing needs it and writes nothing with the recorder off;
 * a minute on disk from its samples; identity taken in the event's turn (no hello, no page); a `mem` answer counts
 * only for its tick and document within 1 s; `shown`'s time; `gone` with its identity and `ours`; a `tab` line for a
 * new commit and for a new main-frame process with nothing else changed; gpu-restart only without a child-gone; a
 * flash held in the ring by its kind, time and identity only; the visible tab's answer only while it is visible; the
 * window moved to a display of another rate; every getAppMetrics() through the one counted wrapper.
 */
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PerfAsk, PerfMsg } from '../../../src/shared/app-api.ts'

// ---- fakes ---------------------------------------------------------------------------------------------------------

const H = '0123456789abcdef'
type Listener = (...a: unknown[]) => void
const appOn = new Map<string, Listener[]>()
const fx = {
  metrics: [] as { pid: number; type: string; creationTime: number; cum: number; kb: number }[],
  metricsCalls: 0,
  feature: { gpu_compositing: 'enabled' } as Record<string, string>,
}
const emit = (m: Map<string, Listener[]>, ev: string, ...a: unknown[]) => { for (const f of m.get(ev) ?? []) f(...a) }
vi.mock('electron', () => {
  const on = (m: Map<string, Listener[]>) => (ev: string, f: Listener) => { m.set(ev, [...(m.get(ev) ?? []), f]) }
  return {
    app: {
      on: on(appOn), getVersion: () => '0.2.0',
      getAppMetrics: () => { fx.metricsCalls++; return fx.metrics.map((m) => ({ pid: m.pid, type: m.type, creationTime: m.creationTime, cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0, cumulativeCPUUsage: m.cum }, memory: { workingSetSize: m.kb, peakWorkingSetSize: m.kb } })) },
      getGPUFeatureStatus: () => ({ ...fx.feature }),
    },
    powerMonitor: { on: () => {}, getCurrentThermalState: () => 'nominal' },
    // a window right of x 2000 is on the second display, at 60 Hz
    screen: { on: () => {}, getDisplayMatching: (b: { x: number }) => (b.x >= 2000 ? { id: 2, displayFrequency: 60 } : { id: 1, displayFrequency: 120 }), getPrimaryDisplay: () => ({ id: 1, displayFrequency: 120 }) },
    webContents: { getAllWebContents: () => [] },
  }
})

class FakeWc {
  static n = 100
  id = FakeWc.n++
  pid: number
  frames: number[] = []
  handlers = new Map<string, Listener[]>()
  constructor(pid: number) { this.pid = pid }
  isDestroyed() { return false }
  getOSProcessId() { return this.pid }
  get mainFrame() {
    const self = this
    return { isDestroyed: () => false, get processId() { return 1 }, get osProcessId() { return self.pid }, get framesInSubtree() { return [{ osProcessId: self.pid }, ...self.frames.map((p) => ({ osProcessId: p }))] } }
  }
  on(ev: string, f: Listener) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), f]); return this }
  once(ev: string, f: Listener) { return this.on(ev, f) }
}
const views = new Map<string, FakeWc>()
const strip = new FakeWc(50)
const win = {
  bounds: { x: 0, y: 0, width: 1280, height: 820 },
  handlers: new Map<string, Listener[]>(),
  isDestroyed: () => false,
  getBounds() { return { ...this.bounds } },
  on(ev: string, f: Listener) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), f]); return this },
}
const machineFx = { displayChanged: 0 }
vi.mock('../../src/main/window.ts', () => ({
  stripContents: () => strip,
  contentView: (id: string) => (views.has(id) ? { webContents: views.get(id) } : undefined),
  pageView: () => undefined,
  mainWindow: () => win,
  windowVisible: () => true,
  captureApp: async () => { throw new Error('no window') },
}))
vi.mock('../../src/main/bridge.ts', () => ({ kindOf: () => undefined, tabOf: () => undefined }))
vi.mock('../../src/main/machine.ts', () => ({
  currentHash: () => H, stampHash: () => H, onProfile: () => () => {}, startMachine: () => {},
  windowDisplayChanged: () => { machineFx.displayChanged++ },
  readAgx: async () => ({ gpuSystemMemoryMB: 1, allocMB: 2, utilPct: 3, rendererPct: 4, tilerPct: 5, recoveryCount: 0, machineWide: true }),
}))

const { recorder, recorderTesting, sampler, identity } = await import('../../src/main/recorder.ts')
const { setPressureSpawner, pressureSpawns, resetPressure } = await import('../../src/main/pressure.ts')
const { flushNow, idle } = await import('../../src/main/perflog.ts')
const { T } = await import('../../src/main/timings.ts')
const tabsMod = await import('../../src/main/tabs.ts')
const { world, liveTab } = await import('./window-fakes.ts')

// ---- the run -------------------------------------------------------------------------------------------------------

let base: string
let recording = false
const asks: { tab: string; ask: PerfAsk }[] = []
let perfFn: ((tabId: string, doc: string, msg: PerfMsg) => void) | null = null
const file = () => join(base, 'home', 'perf', 'app-dev.jsonl')
const lines = () => { flushNow(); return existsSync(file()) ? readFileSync(file(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>) : [] }
const kinds = () => lines().map((l) => l.kind)

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-rec-')))
  setPressureSpawner(async () => ({ code: 0, stdout: '1\n55\n' }))
  recorder.start({
    bridge: {
      onPerf: (fn: typeof perfFn) => { perfFn = fn; return () => {} },
      onReport: () => () => {},
      perfAsk: (tab: string, ask: PerfAsk) => { asks.push({ tab, ask }); return true },
    } as never,
    home: { dir: join(base, 'home'), writable: true, state: '', crashpad: '', ms: 0 },
    flavour: 'dev',
    config: () => ({ restoreTabs: true, unloadUnderPressure: true, recorder: recording, dockBadge: false, keepPerfDays: 14 }),
  })
})
afterAll(async () => { await idle(); resetPressure(); rmSync(base, { recursive: true, force: true }) })
beforeEach(() => {
  recording = false
  recorderTesting.need(false)
  recorderTesting.reset()
  asks.length = 0
  views.clear()
  fx.metrics = [{ pid: 1, type: 'Browser', creationTime: 10, cum: 1, kb: 100 * 1024 }, { pid: 2, type: 'GPU', creationTime: 20, cum: 1, kb: 200 * 1024 }, { pid: 50, type: 'Tab', creationTime: 50, cum: 1, kb: 40 * 1024 }]
})

const canvas = (w: ReturnType<typeof world>, pid: number, show = true) => {
  const t = liveTab(w, { show })
  views.set(t.id, new FakeWc(pid))
  fx.metrics.push({ pid, type: 'Tab', creationTime: pid * 10, cum: 0, kb: 300 * 1024 })
  return t
}

describe('the one sampler (A3.8 #4, #6, #7)', () => {
  it('nothing needs it: a tick calls neither getAppMetrics nor sysctl, and nothing is written', async () => {
    const m0 = fx.metricsCalls, s0 = pressureSpawns()
    expect(await recorderTesting.tick()).toBe(null)
    expect(fx.metricsCalls).toBe(m0)
    expect(pressureSpawns()).toBe(s0)
  })

  it('memory.ts wants it with the recorder off: samples published to it, none on disk', async () => {
    let wanted = true
    sampler.wantPressure(() => wanted)
    const got: number[] = []
    const off = sampler.onSample((s) => got.push(s.procs.length))
    const before = lines().length
    const s = (await recorderTesting.tick())!
    expect(s.pressure).toMatchObject({ level: 1, availablePct: 55 })
    expect(got).toEqual([3])
    expect(sampler.last()).toBe(s)
    expect(lines().length).toBe(before)
    wanted = false
    off()
  })

  it('recording: the first sample\'s CPU null; a minute of samples is one `sample` line, CPU exact over it', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date'] })
    try {
      recording = true
      expect((await recorderTesting.tick())!.procs.every((p) => p.cpu === null)).toBe(true)
      for (let i = 1; i <= 12; i++) {
        vi.advanceTimersByTime(5000)
        fx.metrics[0]!.cum += 0.05   // the browser: 0.01 cores
        await recorderTesting.tick()
      }
      const samples = lines().filter((l) => l.kind === 'sample')
      expect(samples).toHaveLength(1)
      const browser = samples[0]!.procs.find((p: { pid: number }) => p.pid === 1)
      expect(browser.cpu.mean).toBeCloseTo(0.01, 6)
      expect(browser.cpuTime).toEqual({ s: 0.6, ms: 60_000 })
      expect(samples[0]!.span).toBe(60_000)
      expect(samples[0]!.gpu).toMatchObject({ pid: 2, born: 20 })
      expect(samples[0]!.procs.find((p: { pid: number }) => p.pid === 50).role).toBe('strip')
      expect(samples[0]!.machine).toBe(H)
      // the launch that records begins with its start line
      expect(kinds()).toContain('start')
    } finally { vi.useRealTimers() }
  })

  it('a resume\'s first sample has CPU null again; a sampler that stops forgets its baselines', async () => {
    recording = true
    await recorderTesting.tick()
    expect((await recorderTesting.tick())!.procs.some((p) => p.cpu !== null)).toBe(true)
    recording = false
    expect(await recorderTesting.tick()).toBe(null)
    recording = true
    expect((await recorderTesting.tick())!.procs.every((p) => p.cpu === null)).toBe(true)
  })
})

describe('identity and the canvas\'s answers (A3.8 #5, #8, #9)', () => {
  it('no hello, no page; the hello\'s page once said', () => {
    const w = world()
    const t = canvas(w, 300)
    expect(identity(t)).toEqual({ tab: t.id, ws: t.reg!.ws, commit: 1 })
    tabsMod.onReport(t.id, t.doc!.doc!, { hello: { version: '0.27.2', board: 'main', page: 'aaaaaaaaaaaa' } })
    expect(identity(t)).toEqual({ tab: t.id, ws: t.reg!.ws, commit: 1, page: 'aaaaaaaaaaaa' })
  })

  it('a mem answer counts only for its tick and document within 1 s: the canvas\'s footprint, and the visible tab\'s', async () => {
    const w = world()
    const t = canvas(w, 301)
    recording = true
    await recorderTesting.tick()
    const ask = asks.find((a) => a.tab === t.id && a.ask.kind === 'mem')!.ask as { tick: number }
    perfFn!(t.id, 'another-doc', { kind: 'mem', tick: ask.tick, privateKB: 999 * 1024, heapUsedKB: 1, heapTotalKB: 1 })
    perfFn!(t.id, t.doc!.doc!, { kind: 'mem', tick: ask.tick + 99, privateKB: 999 * 1024, heapUsedKB: 1, heapTotalKB: 1 })
    let s = (await recorderTesting.tick())!
    expect(s.procs.find((p) => p.pid === 301)!.footprintMB).toBe(null)
    expect(s.visible).toBe(null)
    const ask2 = asks.filter((a) => a.tab === t.id && a.ask.kind === 'mem').at(-1)!.ask as { tick: number }
    perfFn!(t.id, t.doc!.doc!, { kind: 'mem', tick: ask2.tick, privateKB: 400 * 1024, heapUsedKB: 50 * 1024, heapTotalKB: 80 * 1024 })
    perfFn!(t.id, t.doc!.doc!, { kind: 'mem', tick: ask2.tick, privateKB: 1 * 1024, heapUsedKB: 1, heapTotalKB: 1 })   // a second answer is no answer
    s = (await recorderTesting.tick())!
    const p = s.procs.find((x) => x.pid === 301)!
    expect([p.role, p.tabs, p.footprintMB]).toEqual(['canvas', [t.id], 400])
    expect(s.visible).toMatchObject({ tab: t.id, commit: 1, privateMB: 400, heapMB: 50 })
  })

  it('a hidden canvas is asked only while an unload is possible; an out-of-process iframe counts for its tab', async () => {
    const w = world()
    const hidden = canvas(w, 302)
    views.get(hidden.id)!.frames = [303]
    fx.metrics.push({ pid: 303, type: 'Tab', creationTime: 3030, cum: 0, kb: 20 * 1024 })
    canvas(w, 304)   // shown last: the visible one
    recording = true
    await recorderTesting.tick()
    expect(asks.filter((a) => a.tab === hidden.id)).toHaveLength(0)
    recorderTesting.need(true)
    const s = (await recorderTesting.tick())!
    expect(asks.filter((a) => a.tab === hidden.id && a.ask.kind === 'mem')).toHaveLength(1)
    expect(s.procs.find((p) => p.pid === 303)).toMatchObject({ role: 'canvas', tabs: [hidden.id] })
  })

  it('shown: main\'s show to the preload\'s second frame, for that document', async () => {
    const w = world()
    const t = canvas(w, 305)
    recording = true
    recorder.shown(t)
    const ask = asks.find((a) => a.ask.kind === 'shown')!.ask as { tick: number }
    perfFn!(t.id, 'old-doc', { kind: 'shown', tick: ask.tick })
    perfFn!(t.id, t.doc!.doc!, { kind: 'shown', tick: ask.tick })
    const shown = lines().filter((l) => l.kind === 'shown')
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ tab: t.id, commit: 1 })
    expect(shown[0]!.ms).toBeGreaterThanOrEqual(0)
    expect(shown[0]!.ms).toBeLessThan(1000)
  })

  it('board: the last for the current document only', () => {
    const w = world()
    const t = canvas(w, 306)
    perfFn!(t.id, t.doc!.doc!, { kind: 'board', frames: 120, asleep: 80 })
    expect(recorder.boardOf(t.id)).toEqual({ frames: 120, asleep: 80 })
    perfFn!(t.id, 'gone-doc', { kind: 'board', frames: 1, asleep: 1 })
    expect(recorder.boardOf(t.id)).toBe(null)
  })
})

describe('events (A3.8 #9, r4 #1)', () => {
  it('gone: the identity taken before recover(), the process, ours only when main was ending it', async () => {
    const w = world()
    const t = canvas(w, 307)
    tabsMod.onReport(t.id, t.doc!.doc!, { hello: { version: '0.27.2', board: 'main', page: 'bbbbbbbbbbbb' } })
    recording = true
    await recorderTesting.tick()
    recorder.processGone(t, { reason: 'killed', exitCode: 9 } as never, false)
    recorder.processGone(t, { reason: 'killed', exitCode: 9 } as never, true)
    const gone = lines().filter((l) => l.kind === 'gone').slice(-2)
    expect(gone[0]).toMatchObject({ tab: t.id, ws: t.reg!.ws, commit: 1, page: 'bbbbbbbbbbbb', role: 'canvas', pid: 307, born: 3070, reason: 'killed', exitCode: 9, ours: false, pressure: 1 })
    expect(gone[0]!.source).toBeUndefined()
    expect(gone[1]).toMatchObject({ ours: true, source: 'reload-page' })
  })

  it('a tab line for a change, none for no change, one for a new commit and one for a new main-frame process alone', () => {
    const w = world()
    const t = canvas(w, 308)
    recording = true
    const tabLines = () => lines().filter((l) => l.kind === 'tab' && l.tab === t.id)
    recorder.tabsChanged()
    expect(tabLines()).toHaveLength(1)
    expect(tabLines()[0]).toMatchObject({ state: 'live', active: true, view: 'live', commit: 1, main: { pid: 308, born: 3080 } })
    recorder.tabsChanged()
    expect(tabLines()).toHaveLength(1)
    tabsMod.onCommit(t, { gen: 2, url: `${t.reg!.origin}/`, attributed: true, admitted: 'doc-2' })
    recorder.tabsChanged()
    expect(tabLines()).toHaveLength(2)
    expect(tabLines()[1]!.commit).toBe(2)
    views.get(t.id)!.pid = 309
    fx.metrics.push({ pid: 309, type: 'Tab', creationTime: 3090, cum: 0, kb: 1024 })
    recorder.tabsChanged()
    expect(tabLines()).toHaveLength(3)
    expect(tabLines()[2]).toMatchObject({ commit: 2, main: { pid: 309, born: 3090 } })
  })

  it('a record of another stream\'s kind: in the ring always, on disk only with the recorder on', () => {
    const w = world()
    const t = canvas(w, 310)
    const n = lines().length
    recorder.event('unload', t, { phase: 'start', reason: 'warn' })
    expect(lines().length).toBe(n)
    expect(recorderTesting.ring().events.at(-1)).toMatchObject({ kind: 'unload', tab: t.id, phase: 'start' })
    recording = true
    recorder.event('reopen', { tab: t.id, page: 'cccccccccccc' }, { activateToLiftMs: 300, unloadedForMs: 0 })
    expect(lines().at(-1)).toMatchObject({ kind: 'reopen', tab: t.id, page: 'cccccccccccc', activateToLiftMs: 300 })
  })

  it('a new GPU process with no child-gone writes gpu-restart; after a child-gone it writes none', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date', 'performance'] })
    try {
      recording = true
      await recorderTesting.tick()   // the GPU process 2, born 20: the first, no restart
      fx.metrics[1] = { pid: 3, type: 'GPU', creationTime: Date.now(), cum: 0, kb: 1024 }
      await recorderTesting.tick()
      await vi.advanceTimersByTimeAsync(T.gpuRestartMs + 10)
      expect(lines().filter((l) => l.kind === 'gpu-restart').at(-1)).toMatchObject({ pid: 3, was: { pid: 2, born: 20 } })
      const n = lines().filter((l) => l.kind === 'gpu-restart').length
      emit(appOn, 'child-process-gone', {}, { type: 'GPU', reason: 'killed', exitCode: 9 })
      fx.metrics[1] = { pid: 4, type: 'GPU', creationTime: Date.now() + 300, cum: 0, kb: 1024 }
      await recorderTesting.tick()
      await vi.advanceTimersByTimeAsync(T.gpuRestartMs + 10)
      expect(lines().filter((l) => l.kind === 'gpu-restart')).toHaveLength(n)
      expect(lines().filter((l) => l.kind === 'child-gone').at(-1)).toMatchObject({ type: 'GPU', reason: 'killed', ours: false, machineWide: false })
      expect(recorder.gpuEvents(0, Date.now()).map((e) => e.kind)).toEqual(expect.arrayContaining(['gpu-restart', 'child-gone']))
    } finally { vi.useRealTimers() }
  })

  it('a gpu line only when the feature status changed', () => {
    recording = true
    const n = lines().filter((l) => l.kind === 'gpu').length
    emit(appOn, 'gpu-info-update')
    expect(lines().filter((l) => l.kind === 'gpu').length).toBe(n)
    fx.feature = { gpu_compositing: 'disabled_software' }
    emit(appOn, 'gpu-info-update')
    emit(appOn, 'gpu-info-update')
    expect(lines().filter((l) => l.kind === 'gpu').length).toBe(n + 1)
    expect(lines().filter((l) => l.kind === 'gpu').at(-1)!.featureStatus).toEqual({ gpu_compositing: 'disabled_software' })
  })

  it('will-quit: the minute so far written, then every queued line', async () => {
    recording = true
    await recorderTesting.tick()
    await recorderTesting.tick()
    const n = lines().filter((l) => l.kind === 'sample').length
    recorder.flushSync()
    expect(lines().filter((l) => l.kind === 'sample').length).toBe(n + 1)
  })
})

describe('the review of a3-recorder', () => {
  it('a flash is held in the ring by its kind, time and identity only: marks a minute apart never carry the one before', () => {
    const w = world()
    const t = canvas(w, 320)
    const ident = identity(t)
    const big = { samples: Array.from({ length: 12 }, () => ({ procs: Array.from({ length: 10 }, (_, i) => ({ pid: i, pad: 'x'.repeat(200) })) })), events: [] }
    for (let i = 0; i < 8; i++) {
      // each mark quotes the ring as it is (the flash stream's body), and is then recorded
      const quoted = { samples: big.samples, events: recorderTesting.ring().events }
      recorderTesting.event('flash', ident, { id: `m${i}`, via: 'key', recorder: true, ring: quoted, now: { ts: Date.now(), procs: big.samples[0]!.procs }, gpuEvents: [], picture: null })
    }
    const flashes = recorderTesting.ring().events.filter((e) => e.kind === 'flash')
    expect(flashes).toHaveLength(8)
    expect(flashes.at(-1)).toEqual({ kind: 'flash', ts: expect.any(Number), tab: t.id, ws: t.reg!.ws, commit: 1, id: 'm7', via: 'key' })
    // the ring a ninth mark would quote stays small: no earlier mark's ring or state in it (with them, each mark's line
    // held every earlier one's, nested: this ring was megabytes)
    expect(JSON.stringify(recorderTesting.ring().events).length).toBeLessThan(5000)
    recorderTesting.event('whiteout-candidate', ident, { gesture: 7, observedAt: [1, 2], rateHz: 4, samples: 6, skipped: 0, inconclusive: 0, gpuEvents: [{ kind: 'gone', ts: 1 }], agx: {} })
    expect(recorderTesting.ring().events.at(-1)).toEqual({ kind: 'whiteout-candidate', ts: expect.any(Number), tab: t.id, ws: t.reg!.ws, commit: 1, gesture: 7 })
    // other kinds keep their body
    recorderTesting.event('unload', ident, { phase: 'start', reason: 'warn' })
    expect(recorderTesting.ring().events.at(-1)).toMatchObject({ kind: 'unload', phase: 'start', reason: 'warn' })
  })

  it('the visible tab\'s answer serves only while that tab is still the visible one', async () => {
    const w = world()
    const a = canvas(w, 321)
    recording = true
    await recorderTesting.tick()
    const ask = asks.filter((x) => x.tab === a.id && x.ask.kind === 'mem').at(-1)!.ask as { tick: number }
    perfFn!(a.id, a.doc!.doc!, { kind: 'mem', tick: ask.tick, privateKB: 300 * 1024, heapUsedKB: 10 * 1024, heapTotalKB: 20 * 1024 })
    expect(sampler.last()).not.toBe(null)
    const s1 = (await recorderTesting.tick())!
    expect(s1.visible).toMatchObject({ tab: a.id, privateMB: 300 })
    // another tab shown: the answer about the first is no longer the visible tab's, though it is under 10 s old
    const b = canvas(w, 322)
    expect(tabsMod.activeTab()?.id).toBe(b.id)
    const s2 = (await recorderTesting.tick())!
    expect(s2.visible).toBe(null)
  })

  it('the window moved to a display of another rate: the canvases hear the rate, the profile is collected again', () => {
    const w = world()
    const t = canvas(w, 323)
    recorder.tabsChanged()   // the window watched; its display read
    const before = machineFx.displayChanged
    asks.length = 0
    win.bounds = { ...win.bounds, x: 2500 }
    for (const f of win.handlers.get('moved') ?? []) f()
    expect(asks).toEqual(expect.arrayContaining([{ tab: t.id, ask: { kind: 'display', hz: 60 } }]))
    expect(machineFx.displayChanged).toBe(before + 1)
    // moved within that display: nothing again
    win.bounds = { ...win.bounds, x: 2600 }
    for (const f of win.handlers.get('moved') ?? []) f()
    expect(machineFx.displayChanged).toBe(before + 1)
    win.bounds = { ...win.bounds, x: 0 }
    recorder.tabsChanged()
    expect(machineFx.displayChanged).toBe(before + 2)
  })

  it('every getAppMetrics() in main goes through the one counted wrapper', () => {
    const src = join(import.meta.dirname, '..', '..', 'src')
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []))
    const calls = walk(src).flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => ({ f, i, l })))
      .filter(({ l }) => /\.getAppMetrics\(/.test(l) && !/^\s*(\*|\/\/)/.test(l))
    expect(calls.map(({ f, l }) => `${f.slice(src.length)}: ${l.trim()}`)).toEqual(['/main/recorder.ts: return safely(() => app.getAppMetrics()) ?? []'])
    const n = recorderTesting.stats()
    expect(n.metricsCalls).toBe(n.metrics.tick + n.metrics.mark + n.metrics.identity)
  })
})
