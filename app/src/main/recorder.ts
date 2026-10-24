/**
 * The app half of the recorder (spec 28 A3.1, A3.8 #4-#9, #12, #13): the one sampler, the events, identity, the
 * `mv:perf` traffic and the minute aggregate on disk. Owner: the recorder stream.
 *
 * **One sampler, two consumers** (A3.8 #4): this file owns the only `getAppMetrics()` loop, every 5 s, while
 * recording or while `memory.ts`'s `wantPressure()` says an unload is possible; nothing else samples. With the
 * recorder off it runs only for memory.ts and writes nothing; with nothing that could be unloaded either, a tick
 * calls neither `getAppMetrics()` nor `sysctl`. The tick stops at `suspend` and starts again at `resume`. Every
 * `getAppMetrics()` the app makes goes through `appMetrics(why)`, counted by why: the tick's; a flash's state at its
 * mark; and identity reads made in an event's turn - a renderer the samples have not met yet when the tabs change, the
 * GPU process's at `gpu-info-update` and at a presentation's answer (views.ts) - which are reads, not samples.
 *
 * **Identity is taken in the event's turn** (A3.8 #8): `identity(tab)` before any await - `page` the one its
 * admitted document's accepted hello sent (tabs.ts keeps it in `reports.hello`), none before it says hello.
 *
 * The ports other streams call, FROZEN (A3.8 #53), wired by main.ts (`start`, after the bridge and before the
 * views; `flushSync` at will-quit) and views.ts (`watchCanvas` first in wireCanvas; `processGone` before recover();
 * `shown` with `mv:app-state shown`; `tabsChanged` after each compose; `markFlash` from runCommand); `event` is how
 * memory.ts, the one ground and the flash stream write their kinds.
 *
 * As built:
 * - A tick: one `getAppMetrics()`, the ownership read in the same turn (every webContents main made, by what it is:
 *   the strip, each tab's content view and tab page; a canvas's main frame and every `framesInSubtree` frame's
 *   process, so out-of-process iframes count for their tab), `procs.build` against the last baselines, the `mem`
 *   asks (the visible tab at every recorded tick; every canvas, one per process, while `wantPressure()`), then the
 *   pressure read; the sample is published when that read ends. A sampler that stops (nothing needs it) forgets its
 *   baselines: its next sample is a first one, CPU null.
 * - The ring holds the last 12 samples and 60 s of events at full resolution, whatever `recorder` says (memory.ts and
 *   a flash read it; a flash quotes the samples only with the recorder on). A flash and a white-out candidate are held
 *   in it as their kind, time and identity only: each quotes the ring, so a whole one in it would carry the one
 *   before it, and a minute of marks would grow each line with every mark. Disk gets one `sample` line a minute
 *   (procs.ts `foldMinute`) and every event, only with the recorder on; a flash and main's errors are written whatever
 *   it says. The `start` line is the first line of a launch that records.
 * - `shown.ms` is main's show to main's receipt of the preload's answer from its second animation-frame callback: the
 *   answer's way back to main is in it (a busy main makes it longer).
 * - `Sample.visible` is the visible tab's last `mem` answer while that tab and its document are still the visible
 *   ones; after a switch it is null until the new one answers.
 * - The display's rate goes again to the canvases when the window moves to a display of another rate (no display
 *   event says so), and the machine profile is collected again (its tile budget is the window's display's).
 * - A process's `born` that the recorder never saw (a renderer that went before any sample read it) is 0.
 * - The GPU process events a flash and a white-out candidate quote (`gpuEvents`) are the GPU process's alone: its
 *   `child-gone` (type GPU), `gpu-restart` and `gpu` - never a renderer's `gone` (a crash, an unload's own) nor a
 *   utility process's end (A3.3, A3.8 #13).
 * - The pressure a record quotes outside a sample (a flash's, a `gone`'s) is the last reading only while it is at
 *   most two ticks old (`freshPressure`); older - the recorder off and nothing to unload, so nothing reads it - it is
 *   unknown, never hours stale.
 */
import { app, powerMonitor, screen, webContents as allContents, type BaseWindow, type ProcessMetric, type RenderProcessGoneDetails, type WebContents } from 'electron'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { AppBody, AppKind, Flavour, GpuIdentity, PressureReading, ProcId, RingEvent, Role, Sample, Sampler, TabIdent, ThermalState } from '../../../src/shared/app-perf.ts'
import type { Bridge } from './bridge.ts'
import { kindOf, tabOf } from './bridge.ts'
import type { Config, Home } from './config.ts'
import { allTabs, activeTab, displayState, getTab, isActive, type Tab } from './tabs.ts'
import { build, foldMinute, type Baseline, type Owner, type Owners } from './procs.ts'
import { lastPressure, readPressure } from './pressure.ts'
import { onProfile, readAgx, stampHash, startMachine, windowDisplayChanged } from './machine.ts'
import { append, flushSync as flushLog, prunePictures, startPerflog } from './perflog.ts'
import { markFlash as flashTransaction, quitFlashes, type FlashPorts } from './flashes.ts'
import { captureApp, contentView, mainWindow, pageView, stripContents, windowVisible } from './window.ts'
import { confirm } from './pill.ts'
import { writeWhole } from './fsx.ts'
import { mainFrameOf, safely } from './frames.ts'
import { note } from './testing/index.ts'
import { T } from './timings.ts'
import type { PerfMsg } from '../../../src/shared/app-api.ts'

export type { ProcSample, ProcType, Role, Sample, Sampler, TabIdent } from '../../../src/shared/app-perf.ts'

/** A tab's identity now (A3.8 #8), before any await. */
export function identity(t: Tab): TabIdent {
  return {
    tab: t.id,
    ...(t.reg?.ws ? { ws: t.reg.ws } : {}),
    ...(t.doc ? { commit: t.doc.commits } : {}),
    ...(t.reports.hello?.page ? { page: t.reports.hello.page } : {}),
  }
}

/** Why the app called `getAppMetrics()`: the sampler's tick, a flash's state at its mark, an identity read in an event's turn, a test hook. */
export type MetricsWhy = 'tick' | 'mark' | 'identity' | 'test'
const metricsBy: Record<MetricsWhy, number> = { tick: 0, mark: 0, identity: 0, test: 0 }

/** Test builds: what `getAppMetrics()` said, per process, at the tick a sample was built from (the RSS case compares the two). */
export interface RawMetric { pid: number; born: number; type: string; workingSetKB: number }
let lastTickRaw: RawMetric[] | null = null

/** Every `getAppMetrics()` the app makes, counted by why (A3.8 #4: only the tick samples; test builds read the counts). */
export function appMetrics(why: MetricsWhy): ProcessMetric[] {
  metricsBy[why] += 1
  const m = safely(() => app.getAppMetrics()) ?? []
  // test builds: the tick's answer as Electron gave it, before the sampler's wiring reads it
  if (__MV_TEST__ && why === 'tick') lastTickRaw = m.map((x) => ({ pid: x.pid, born: x.creationTime, type: x.type, workingSetKB: x.memory.workingSetSize }))
  return m
}

/** The GPU process's identity now (A3.8 #27, r3 #1): `getAppMetrics()`'s GPU entry, or null when there is none. */
export function gpuIdentity(): GpuIdentity | null {
  const m = appMetrics('identity').find((x) => x.type === 'GPU')
  return m ? { pid: m.pid, born: m.creationTime } : null
}

// ---- state ------------------------------------------------------------------------------------------------------

/** The ring (A3.8 #7): the last 12 samples, 60 s of events. */
const RING_SAMPLES = 12
const RING_EVENTS_MS = 60_000
const RING_EVENTS_MAX = 2000
/** The GPU process's own events, which a flash and a candidate quote (A3.3, A3.8 #13): never a renderer's `gone`, nor a utility process's end. */
export const isGpuProcessEvent = (e: RingEvent): boolean => e.kind === 'gpu-restart' || e.kind === 'gpu' || (e.kind === 'child-gone' && e.type === 'GPU')

const sampleFns = new Set<(s: Sample) => void>()
const wants: (() => boolean)[] = []

let P: RecorderStart | null = null
let samples: Sample[] = []
let events: RingEvent[] = []
let baselines: ReadonlyMap<string, Baseline> = new Map()
let lastMono: number | null = null
let lastSample: Sample | null = null
let suspended = false
let ticking: Promise<Sample> | null = null
let tickN = 0
let minute: Sample[] = []
let spawnMs = 0
let startWritten = false
let tickTimer: NodeJS.Timeout | null = null
let agxTimer: NodeJS.Timeout | null = null
let ticksRun = 0
/** a pid's creation time, from the samples (a process gone before any read it has none: 0) */
const bornOf = new Map<number, number>()
/** a webContents' renderer pid, last seen (a crashed one no longer says) */
const wcPid = new Map<number, number>()
/** test builds: the raw metrics each published sample was built from */
const rawOfSample = new WeakMap<Sample, RawMetric[]>()
/** the preload's `mem` answers: a process's footprint (MB) and when */
const footprints = new Map<number, { mb: number; at: number }>()
let visibleAnswer: (TabIdent & { privateMB: number; heapMB: number; at: number }) | null = null
/** the document the visible answer is about */
let visibleDoc = ''
interface MemAsk { tick: number; tabId: string; doc: string; pid: number | undefined; ident: TabIdent; at: number; visible: boolean }
const memAsks = new Map<string, MemAsk>()
interface ShownAsk { tabId: string; doc: string; ident: TabIdent; mono: number }
const shownAsks = new Map<number, ShownAsk>()
const boards = new Map<string, { doc: string; frames: number; asleep: number }>()
const tabSeen = new Map<string, string>()
const lastDoc = new Map<string, string>()
let gpuWas: ProcId | null = null
const gpuGoneAt: number[] = []
let featureWas = ''
/** test builds: `recorder:need` keeps the sampler on as memory.ts would */
let forcedNeed = false

const recorderOn = (): boolean => { try { return !!P?.config().recorder } catch { return false } }
const flavour = (): Flavour => P?.flavour ?? 'dev'
const want = (): boolean => forcedNeed || wants.some((f) => { try { return !!f() } catch { return false } })
const need = (): boolean => recorderOn() || want()

// ---- who hosts what -----------------------------------------------------------------------------------------------

type PageRole = Exclude<Role, 'mixed' | 'none' | 'unknown'>
interface Page { wc: WebContents; role: PageRole; tab?: string }

/** Every webContents main made, by what it is: the strip, each tab's content view and its tab page, then any other the bridge registered (a cover's page). */
function pagesNow(): Page[] {
  const out: Page[] = []
  const seen = new Set<number>()
  const add = (wc: WebContents | undefined, role: PageRole, tab?: string) => {
    if (!wc || seen.has(wc.id) || safely(() => wc.isDestroyed()) !== false) return
    seen.add(wc.id)
    out.push({ wc, role, ...(tab ? { tab } : {}) })
  }
  add(stripContents(), 'strip')
  for (const t of allTabs()) {
    const v = contentView(t.id)?.webContents
    if (v) add(v, t.kind === 'local' ? 'canvas' : t.kind === 'home' ? 'home' : 'settings', t.kind === 'local' ? t.id : undefined)
    add(pageView(t.id)?.webContents, 'tabpage')
  }
  for (const wc of safely(() => allContents.getAllWebContents()) ?? []) {
    if (seen.has(wc.id)) continue
    const k = kindOf(wc.id)
    if (k) add(wc, k, k === 'canvas' ? tabOf(wc.id) : undefined)
  }
  return out
}

/** The page a webContents is, or undefined (one main did not make: DevTools, a spare). */
function pageOf(wc: WebContents): Page | undefined { return pagesNow().find((p) => p.wc.id === wc.id) }

/** The renderer processes and what each hosts, read now (A3.8 #4). */
function ownersNow(): Owners {
  const owners: Owners = new Map()
  const own = (pid: number | undefined, role: PageRole, tab?: string) => {
    if (typeof pid !== 'number' || !(pid > 0)) return
    let o = owners.get(pid)
    if (!o) owners.set(pid, o = { roles: new Set(), tabs: new Set() } satisfies Owner)
    o.roles.add(role)
    if (tab) o.tabs.add(tab)
  }
  for (const p of pagesNow()) {
    const pid = safely(() => p.wc.getOSProcessId())
    if (typeof pid === 'number' && pid > 0) wcPid.set(p.wc.id, pid)
    own(pid, p.role, p.tab)
    if (p.role !== 'canvas') continue
    // a canvas's frames: an out-of-process iframe's process counts for its tab
    const frames = safely(() => mainFrameOf(p.wc)?.framesInSubtree) ?? []
    for (const f of frames) own(safely(() => f.osProcessId), 'canvas', p.tab)
  }
  return owners
}

const thermalNow = (): ThermalState => (safely(() => powerMonitor.getCurrentThermalState()) as ThermalState | undefined) ?? 'unknown'
const sysNow = (): Sample['sys'] => {
  const m = safely(() => process.getSystemMemoryInfo())
  return m && typeof m.free === 'number' ? { freeMB: Math.round(m.free / 1024), purgeableMB: typeof (m as { purgeable?: number }).purgeable === 'number' ? Math.round((m as { purgeable: number }).purgeable / 1024) : 0 } : null
}
const footprintsNow = (now = Date.now()): Map<number, number> => {
  const out = new Map<number, number>()
  for (const [pid, f] of footprints) { if (now - f.at <= T.memServesMs) out.set(pid, f.mb); else footprints.delete(pid) }
  return out
}
/** The visible tab's last answer, at most 10 s old, while that tab and its document are still the visible ones. */
function visibleNow(now = Date.now()): Sample['visible'] {
  if (!visibleAnswer || now - visibleAnswer.at > T.memServesMs) return null
  const t = visibleTab()
  return t && t.id === visibleAnswer.tab && t.doc?.doc === visibleDoc ? { ...visibleAnswer } : null
}

/** The active local tab with its document shown and the window visible, or undefined. */
function visibleTab(): Tab | undefined {
  const t = activeTab()
  return t && t.kind === 'local' && t.view === 'live' && t.doc?.doc && t.doc.lifted && windowVisible() ? t : undefined
}

// ---- the sampler ------------------------------------------------------------------------------------------------

/** The `mem` asks of a tick (A3.8 #5): the visible tab while recording; every canvas (one per process) while an unload is possible. */
function askMem(k: number, recording: boolean, unloadable: boolean): void {
  if (!P) return
  const now = performance.now()
  const ask = (t: Tab, visible: boolean) => {
    const doc = t.doc?.doc
    if (!doc) return
    const wc = contentView(t.id)?.webContents
    const pid = wc ? safely(() => mainFrameOf(wc)?.osProcessId) : undefined
    const a: MemAsk = { tick: k, tabId: t.id, doc, pid, ident: identity(t), at: now, visible }
    memAsks.set(`${k}:${t.id}`, a)
    if (!P!.bridge.perfAsk(t.id, { kind: 'mem', tick: k })) memAsks.delete(`${k}:${t.id}`)
  }
  const vis = recording ? visibleTab() : undefined
  if (vis) ask(vis, true)
  if (unloadable) {
    const pids = new Set<number>()
    for (const t of allTabs()) {
      if (t.kind !== 'local' || t === vis || !t.doc?.doc || t.view !== 'live') continue
      const wc = contentView(t.id)?.webContents
      const pid = wc ? safely(() => mainFrameOf(wc)?.osProcessId) : undefined
      if (pid !== undefined && pids.has(pid)) continue
      if (pid !== undefined) pids.add(pid)
      ask(t, false)
    }
  }
  // the asks of ticks gone by can no longer count
  for (const [key, a] of memAsks) if (now - a.at > T.memAnswerMs) memAsks.delete(key)
}

/** One sample now: the metrics and the ownership in this turn, then the pressure read. */
async function sampleNow(): Promise<Sample> {
  const ts = Date.now()
  const mono = performance.now()
  const metrics = appMetrics('tick')
  const raw = __MV_TEST__ ? lastTickRaw : null
  const owners = ownersNow()
  const b = build(metrics, owners, baselines, mono, footprintsNow(ts))
  baselines = b.baselines
  const dt = lastMono !== null && mono > lastMono ? (mono - lastMono) / 1000 : null
  lastMono = mono
  for (const p of b.procs) bornOf.set(p.pid, p.born)
  if (bornOf.size > 500) for (const pid of [...bornOf.keys()].slice(0, bornOf.size - 500)) bornOf.delete(pid)
  noteGpuIdentity(b.gpu ? { pid: b.gpu.pid, born: b.gpu.born } : null)
  const k = ++tickN
  askMem(k, recorderOn(), want())
  const t0 = performance.now()
  const pressure: PressureReading = await readPressure()
  spawnMs += performance.now() - t0
  const s: Sample = { ts, mono, dt, procs: b.procs, gpu: b.gpu, pressure, thermal: thermalNow(), sys: sysNow(), visible: visibleNow() }
  if (__MV_TEST__ && raw) rawOfSample.set(s, raw)
  publish(s)
  return s
}

function publish(s: Sample): void {
  lastSample = s
  samples.push(s)
  if (samples.length > RING_SAMPLES) samples.splice(0, samples.length - RING_SAMPLES)
  if (__MV_TEST__) note('recorder', { sample: { ts: s.ts, dt: s.dt, procs: s.procs.length, pressure: s.pressure?.level ?? null, visible: !!s.visible } })
  for (const fn of [...sampleFns]) { try { fn(s) } catch (err) { process.stderr.write(`marver-app: a sample listener threw: ${(err as Error).message}\n`) } }
  if (!recorderOn()) { minute = []; spawnMs = 0; return }
  minute.push(s)
  const span = minute.reduce((n, x) => n + (x.dt ?? 0) * 1000, 0)
  if (span >= T.sampleDiskMs - T.sampleMs / 2) writeMinute()
}

/** The minute on disk; what it folded (its body, and in test builds the last sample's raw metrics) for the test hook. */
function writeMinute(): { body: ReturnType<typeof foldMinute>; last: Sample | null } {
  const body = minuteBody()
  const last = minute.at(-1) ?? null
  minute = []
  spawnMs = 0
  if (body) record('sample', null, body as unknown as Record<string, unknown>)
  return { body, last }
}
const minuteBody = () => (minute.length ? foldMinuteSafe() : null)
function foldMinuteSafe() {
  try { return foldMinute(minute, spawnMs) } catch (err) { process.stderr.write(`marver-app: the minute could not be folded (${(err as Error).message})\n`); return null }
}

function tick(): Promise<Sample> | undefined {
  if (suspended || ticking) return undefined
  if (!need()) {
    // stopped: nothing samples; the next sample is a first one (its CPU null), and an unwritten minute goes
    baselines = new Map()
    lastMono = null
    minute = []
    spawnMs = 0
    return undefined
  }
  ticksRun += 1
  const p = sampleNow().finally(() => { if (ticking === p) ticking = null })
  ticking = p
  return p
}

/** One sample now, on the same baselines (an unload's "after", A3.8 #45); a tick running is that sample. */
function requestSample(): Promise<Sample> {
  if (ticking) return ticking
  const p = sampleNow().finally(() => { if (ticking === p) ticking = null })
  ticking = p
  return p
}

/**
 * The last pressure reading while it says something about now: at most two ticks old (A3.8 #13's "pressure at the
 * mark"). With the recorder off and nothing to unload no tick reads it (A3.8 #6), and a reading hours old is not the
 * pressure at a mark: unknown then.
 */
export function freshPressure(now = Date.now()): PressureReading | null {
  const p = lastPressure()
  return p && now - p.at <= 2 * T.sampleMs ? p : null
}

/** The state at a mark (a flash): one getAppMetrics() on the sampler's baselines, which it leaves as they are. */
function stateNow(): Sample {
  const ts = Date.now()
  const mono = performance.now()
  const b = build(appMetrics('mark'), ownersNow(), baselines, mono, footprintsNow(ts))
  return { ts, mono, dt: lastMono !== null && mono > lastMono ? (mono - lastMono) / 1000 : null, procs: b.procs, gpu: b.gpu, pressure: freshPressure(ts), thermal: thermalNow(), sys: sysNow(), visible: visibleNow() }
}

/** The one sampler (A3.8 #4). */
export const sampler: Sampler = {
  onSample(fn) { sampleFns.add(fn); return () => { sampleFns.delete(fn) } },
  wantPressure(fn) { wants.push(fn) },
  requestSample,
  last: () => lastSample,
}

// ---- records ------------------------------------------------------------------------------------------------------

/** The kinds that quote the ring (a flash, a candidate): held in it by kind, time and identity only. */
const QUOTING = new Set<AppKind>(['flash', 'whiteout-candidate'])
/** What the ring holds of a record: the record, or for a kind that quotes the ring its scalars that name it. */
function ringOf(kind: AppKind, ts: number, full: Record<string, unknown>): RingEvent {
  if (!QUOTING.has(kind)) return { kind, ts, ...full }
  const e: RingEvent = { kind, ts }
  for (const k of ['tab', 'ws', 'commit', 'page', 'id', 'via', 'gesture'] as const) if (k in full && (typeof full[k] === 'string' || typeof full[k] === 'number')) e[k] = full[k]
  return e
}

/** A record: in the ring (always), the journal (test builds), app.jsonl with the recorder on (or `always`). */
function record<K extends AppKind>(kind: K, ident: TabIdent | null, body: Record<string, unknown>, always = false): void {
  const ts = Date.now()
  const full = { ...(ident ?? {}), ...body }
  if (kind !== 'sample') {
    events.push(ringOf(kind, ts, full))
    const old = ts - RING_EVENTS_MS
    let drop = 0
    while (drop < events.length && events[drop]!.ts < old) drop++
    if (drop || events.length > RING_EVENTS_MAX) events.splice(0, Math.max(drop, events.length - RING_EVENTS_MAX))
  }
  if (__MV_TEST__) note('recorder', kind === 'sample' ? { kind, n: (body as { n?: number }).n } : { kind, ...full })
  if (!always && !recorderOn()) return
  if (!startWritten && recorderOn()) writeStart()
  append(kind, full as unknown as AppBody<K>)
}

function writeStart(): void {
  startWritten = true
  append('start', { version: safely(() => app.getVersion()) ?? '0.0.0', electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '', recorder: recorderOn(), pid: process.pid })
}

/** The ring's GPU process events between two times: the GPU process's child-gone, gpu-restart and gpu (`isGpuProcessEvent`). */
function gpuEvents(from: number, to: number): RingEvent[] {
  return events.filter((e) => isGpuProcessEvent(e) && e.ts >= from && e.ts <= to).map((e) => ({ ...e }))
}

/** A process's pid and creation time, as far as the recorder knows (a crashed renderer no longer says its pid). */
function procOf(wc: WebContents | undefined): { pid: number; born: number } {
  const now = wc ? safely(() => wc.getOSProcessId()) : undefined
  const pid = typeof now === 'number' && now > 0 ? now : wc ? wcPid.get(wc.id) ?? 0 : 0
  return { pid, born: bornOf.get(pid) ?? 0 }
}

/** A new GPU process with no child-gone within 2 s of its start writes gpu-restart (A3.8 #9): a clean exit sends no event. */
function noteGpuIdentity(id: ProcId | null): void {
  if (!id) return
  if (!gpuWas) { gpuWas = id; return }
  if (gpuWas.pid === id.pid && gpuWas.born === id.born) return
  const was = gpuWas
  gpuWas = id
  const t = setTimeout(() => {
    const said = gpuGoneAt.some((at) => at >= id.born - T.gpuRestartMs && at <= Math.max(id.born, Date.now()) + T.gpuRestartMs)
    if (!said) record('gpu-restart', null, { pid: id.pid, born: id.born, was })
  }, T.gpuRestartMs)
  t.unref?.()
}

function onGpuInfo(): void {
  let fs = ''
  try { fs = JSON.stringify(app.getGPUFeatureStatus()) } catch { return }
  if (featureWas && fs !== featureWas) {
    let featureStatus: Record<string, string> = {}
    try { featureStatus = Object.fromEntries(Object.entries(JSON.parse(fs) as Record<string, unknown>).map(([k, v]) => [k, String(v)])) } catch { /* none */ }
    record('gpu', null, { featureStatus })
  }
  featureWas = fs
  noteGpuIdentity(gpuIdentity())
}

/** An app page's own events, for any webContents main makes (canvases are watchCanvas's). */
function watchAppPage(wc: WebContents): void {
  const ev = (kind: 'unresponsive' | 'responsive') => () => {
    const p = pageOf(wc)
    if (p?.role === 'canvas') return
    record(kind, null, { role: p?.role ?? 'unknown', ...procOf(wc) })
  }
  wc.on('unresponsive', ev('unresponsive'))
  wc.on('responsive', ev('responsive'))
}

// ---- mv:perf --------------------------------------------------------------------------------------------------------

function onPerf(tabId: string, doc: string, msg: PerfMsg): void {
  const now = Date.now()
  switch (msg.kind) {
    case 'mem': {
      const a = memAsks.get(`${msg.tick}:${tabId}`)
      memAsks.delete(`${msg.tick}:${tabId}`)
      // only for the tick and document it was asked for, within 1 s (A3.8 #5)
      if (!a || a.doc !== doc || performance.now() - a.at > T.memAnswerMs) return
      const mb = msg.privateKB / 1024
      if (a.pid !== undefined) footprints.set(a.pid, { mb, at: now })
      if (a.visible) { visibleAnswer = { ...a.ident, privateMB: round1(mb), heapMB: round1(msg.heapUsedKB / 1024), at: now }; visibleDoc = a.doc }
      return
    }
    case 'shown': {
      const a = shownAsks.get(msg.tick)
      if (!a || a.tabId !== tabId || a.doc !== doc) return
      shownAsks.delete(msg.tick)
      // to main's receipt of the answer: the answer's IPC back to main is in it
      const ms = performance.now() - a.mono
      if (ms > T.shownAnswerMs) return
      record('shown', a.ident, { ms: Math.round(ms * 10) / 10 })
      return
    }
    case 'board':
      boards.set(tabId, { doc, frames: msg.frames, asleep: msg.asleep })
      return
    default:
      return   // gestures and probes: the white-out detector's (whiteout.ts, on the bridge itself)
  }
}
const round1 = (v: number) => Math.round(v * 10) / 10

/** The display's rate (A3.8 #9): to a tab's admitted document, at its admission and when the displays change. */
function displayHz(): number | null {
  const win = mainWindow()
  const d = safely(() => (win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()))
  const hz = d?.displayFrequency
  return typeof hz === 'number' && Number.isFinite(hz) && hz >= 1 && hz <= 1000 ? hz : null
}
let hzSent: number | null = null
function sendDisplay(tabId: string): void {
  const hz = displayHz()
  if (hz !== null && P) P.bridge.perfAsk(tabId, { kind: 'display', hz })
}
function sendDisplayAll(): void {
  const hz = displayHz()
  if (hz === null || hz === hzSent) return
  hzSent = hz
  for (const t of allTabs()) if (t.kind === 'local' && t.doc?.doc) sendDisplay(t.id)
}

/**
 * The window's display (A3.8 #9, #11): moving the window to another display sends no display event, so its move (and
 * every compose: a resize, full screen) is checked here - a display of another rate goes to the canvases, and the
 * profile is collected again for that display's tile budget.
 */
let windowWatched: BaseWindow | null = null
let displayWas: number | null = null
function watchWindowDisplay(): void {
  const win = mainWindow()
  if (!win || win === windowWatched || safely(() => win.isDestroyed()) !== false) return
  windowWatched = win
  win.on('moved', () => checkWindowDisplay())
}
function checkWindowDisplay(): void {
  const win = mainWindow()
  const id = safely(() => (win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()).id : undefined))
  if (typeof id !== 'number' || id === displayWas) return
  const first = displayWas === null
  displayWas = id
  if (first) return
  sendDisplayAll()
  windowDisplayChanged()
}

// ---- the flash's ports (flashes.ts, the flash stream's transaction) ------------------------------------------------

const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function flashPorts(): FlashPorts {
  const home = P!.home
  return {
    now: () => Date.now(),
    flavour: flavour(),
    recorderOn,
    identity: () => { const t = activeTab(); return t?.kind === 'local' ? identity(t) : null },
    ring: () => (recorderOn() ? { samples: samples.map((s) => ({ ...s })), events: events.filter((e) => e.ts >= Date.now() - RING_EVENTS_MS).map((e) => ({ ...e })) } : null),
    stateNow,
    gpuEvents,
    thermal: thermalNow,
    pressure: () => freshPressure(),
    featureStatus: () => (safely(() => app.getGPUFeatureStatus()) as unknown as Record<string, string> | undefined) ?? {},
    readAgx,
    capture: (o) => captureApp(o),
    async writePicture(name, png) {
      if (!home.writable || !/^[0-9A-Za-z._-]{1,80}\.png$/.test(name)) return { why: 'write failed' }
      const dir = join(home.dir, 'perf', 'flashes')
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await writeWhole(join(dir, name), png, 0o600)
      } catch { return { why: 'write failed' } }
      void prunePictures()
      return { path: `flashes/${name}` }
    },
    confirm: (c) => confirm('flash', { lead: 'Flash marked', text: timeOf(c.at) + (c.recorder ? '' : ' · no samples before it: the recorder is off'), short: 'Flash marked' }),
    append: (body) => { record('flash', null, body as unknown as Record<string, unknown>, true) },
  }
}

// ---- the ports ----------------------------------------------------------------------------------------------------

export interface RecorderStart {
  bridge: Bridge
  home: Home
  flavour: Flavour
  config(): Config
}

const isTab = (w: Tab | TabIdent): w is Tab => 'reports' in w && 'kind' in w

export const recorder = {
  /** main.ts at ready, after the bridge and before the views: the writer, the machine profile, the sampler, the app-wide events */
  start(p: RecorderStart): void {
    if (P) return
    P = p
    // lines are stamped with a profile's hash once its file is on disk (or its write failed and said so)
    startPerflog({ home: p.home, flavour: p.flavour, config: p.config, machine: stampHash })
    startMachine({ home: p.home, window: mainWindow })
    if (recorderOn()) writeStart()
    // a new profile is the stamp from then on; the displays' rate goes to the canvases when it changes
    onProfile(() => sendDisplayAll())
    p.bridge.onPerf(onPerf)
    p.bridge.onReport((tabId, doc) => {
      if (!doc || lastDoc.get(tabId) === doc) return
      lastDoc.set(tabId, doc)
      sendDisplay(tabId)
    })
    app.on('render-process-gone', (_e, wc, d) => {
      const pg = pageOf(wc)
      if (pg?.role === 'canvas' || (!pg && kindOf(wc.id) === 'canvas')) return   // views.ts's processGone
      record('gone', null, { role: pg?.role ?? 'unknown', ...procOf(wc), reason: d.reason, exitCode: d.exitCode, ours: false, pressure: freshPressure()?.level ?? null })
    })
    app.on('child-process-gone', (_e, d) => {
      if (d.type === 'GPU') { gpuGoneAt.push(Date.now()); if (gpuGoneAt.length > 20) gpuGoneAt.shift() }
      record('child-gone', null, { type: d.type, ...(d.name ? { name: d.name } : {}), reason: d.reason, exitCode: d.exitCode, ours: false, machineWide: false })
    })
    app.on('web-contents-created', (_e, wc) => watchAppPage(wc))
    for (const wc of safely(() => allContents.getAllWebContents()) ?? []) watchAppPage(wc)
    try { featureWas = JSON.stringify(app.getGPUFeatureStatus()) } catch { /* the first update sets it */ }
    app.on('gpu-info-update', onGpuInfo)
    powerMonitor.on('on-ac', () => record('power', null, { event: 'on-ac' }))
    powerMonitor.on('on-battery', () => record('power', null, { event: 'on-battery' }))
    powerMonitor.on('thermal-state-change', (e) => record('power', null, { event: 'thermal-state-change', thermal: (e as unknown as { state?: ThermalState }).state ?? thermalNow() }))
    powerMonitor.on('speed-limit-change', (e) => record('power', null, { event: 'speed-limit-change', limit: (e as unknown as { limit?: number }).limit }))
    powerMonitor.on('suspend', () => { suspended = true; record('power', null, { event: 'suspend' }) })
    powerMonitor.on('resume', () => {
      // the first sample after a resume is a first one: its CPU null (A3.8 #4)
      suspended = false
      baselines = new Map()
      lastMono = null
      record('power', null, { event: 'resume' })
    })
    screen.on('display-metrics-changed', () => sendDisplayAll())
    screen.on('display-added', () => sendDisplayAll())
    screen.on('display-removed', () => sendDisplayAll())
    tickTimer = setInterval(() => { void tick() }, T.sampleMs)
    tickTimer.unref?.()
    agxTimer = setInterval(() => {
      if (!recorderOn() || !windowVisible()) return
      const t0 = performance.now()
      void readAgx(T.spawnTimeoutMs).then((a) => { spawnMs += performance.now() - t0; record('agx', null, a as unknown as Record<string, unknown>) })
    }, T.agxMs)
    agxTimer.unref?.()
  },
  /** views.ts wireCanvas, first: the canvas's own events (unresponsive, responsive) and its `mv:perf` */
  watchCanvas(t: Tab, wc: WebContents): void {
    const pid = () => { const n = safely(() => wc.getOSProcessId()); if (typeof n === 'number' && n > 0) wcPid.set(wc.id, n) }
    wc.on('did-navigate', pid)
    wc.on('dom-ready', pid)
    wc.on('unresponsive', () => record('unresponsive', identity(t), { role: 'canvas', ...procOf(wc) }))
    wc.on('responsive', () => record('responsive', identity(t), { role: 'canvas', ...procOf(wc) }))
    wc.once('destroyed', () => { wcPid.delete(wc.id) })
  },
  /** views.ts's render-process-gone, before recover(): `ours` when main was ending that renderer (A3.8 #9) */
  processGone(t: Tab, d: RenderProcessGoneDetails, ours: boolean): void {
    const ident = identity(t)
    record('gone', ident, {
      role: 'canvas', ...procOf(contentView(t.id)?.webContents), reason: d.reason, exitCode: d.exitCode, ours,
      ...(ours ? { source: t.unload ? 'unload' : 'reload-page' } : {}), pressure: freshPressure()?.level ?? null,
    })
  },
  /** views.ts, in the turn `mv:app-state shown` is sent (tab switches only): the `shown` ask */
  shown(t: Tab): void {
    const doc = t.doc?.doc
    if (!P || !doc || t.kind !== 'local') return
    const k = ++tickN
    shownAsks.set(k, { tabId: t.id, doc, ident: identity(t), mono: performance.now() })
    if (!P.bridge.perfAsk(t.id, { kind: 'shown', tick: k })) { shownAsks.delete(k); return }
    const c = setTimeout(() => shownAsks.delete(k), T.shownAnswerMs + 100)
    c.unref?.()
  },
  /** after each compose: `tab` lines for what changed (A3.8 #9, r4 #1); the window's display checked */
  tabsChanged(): void {
    watchWindowDisplay()
    checkWindowDisplay()
    const live = new Set<string>()
    for (const t of allTabs()) {
      live.add(t.id)
      const active = isActive(t)
      const wc = t.kind === 'local' ? contentView(t.id)?.webContents : undefined
      const pid = wc ? safely(() => mainFrameOf(wc)?.osProcessId) : undefined
      const state = displayState(t, active)
      const key = `${state}|${active}|${t.view}|${t.doc?.commits ?? ''}|${pid ?? ''}`
      if (tabSeen.get(t.id) === key) continue
      tabSeen.set(t.id, key)
      let main: ProcId | null = null
      if (typeof pid === 'number' && pid > 0) {
        let born = bornOf.get(pid)
        // a renderer no sample has read yet: its creation time read now (an identity read, as gpuIdentity's)
        if (born === undefined) { const m = appMetrics('identity').find((x) => x.pid === pid); if (m) { born = m.creationTime; bornOf.set(pid, born) } }
        main = { pid, born: born ?? 0 }
      }
      record('tab', identity(t), { state, active, view: t.view, main })
    }
    for (const id of [...tabSeen.keys()]) if (!live.has(id)) { tabSeen.delete(id); boards.delete(id); lastDoc.delete(id) }
  },
  /**
   * a record of another stream's kind (app.jsonl only with the recorder on; the journal always in tests): `who` a tab,
   * its identity taken now, or an identity a caller took in its event's turn (a flash, a candidate, a reopen)
   */
  event<K extends AppKind>(kind: K, who: Tab | TabIdent | null, body: Omit<AppBody<K>, keyof TabIdent>): void {
    const ident = who === null ? null : isTab(who) ? identity(who) : { ...who }
    record(kind, ident, body as unknown as Record<string, unknown>)
  },
  /** the shell's last `board` for the tab's current document (Copy Details' frame count, A3.8 #9), or null */
  boardOf(tabId: string): { frames: number; asleep: number } | null {
    const b = boards.get(tabId)
    return b && getTab(tabId)?.doc?.doc === b.doc ? { frames: b.frames, asleep: b.asleep } : null
  },
  /** the ring's GPU process events (the GPU process's child-gone, gpu-restart, gpu) between two times: a flash's and a candidate's */
  gpuEvents,
  /** runCommand('mark-flash'): flashes.ts's transaction, with this file's ports */
  markFlash(via: 'key' | 'menu'): void {
    if (!P) return
    void flashTransaction(via, flashPorts()).catch((err) => process.stderr.write(`marver-app: a flash mark failed (${(err as Error).message})\n`))
  },
  /** will-quit: unfinished marks and every queued line, written now */
  flushSync(): void {
    try { quitFlashes() } catch { /* the flash stream's */ }
    if (recorderOn() && minute.length) writeMinute()
    flushLog()
  },
}

// ---- test builds ---------------------------------------------------------------------------------------------------

/** The recorder's state for its test hooks (testing/recorder.ts). */
export const recorderTesting = {
  ring: () => ({ samples: samples.map((s) => ({ ...s })), events: events.map((e) => ({ ...e })) }),
  /** `metricsCalls`: every getAppMetrics() the app made (the test hooks' own apart, in `metrics.test`) */
  stats: () => ({ metricsCalls: metricsBy.tick + metricsBy.mark + metricsBy.identity, metrics: { ...metricsBy }, ticks: ticksRun, minute: minute.length, startWritten, recorder: recorderOn(), need: need(), suspended }),
  /** one tick now, as the timer would run it (null when nothing needs the sampler) */
  tick: async () => (await tick()) ?? null,
  /** the flash's ports as the flash stream receives them */
  flashPorts: () => flashPorts(),
  /** what getAppMetrics() said at the tick a sample was built from (null for one not sampled here: an injected one) */
  rawOf: (s: Sample): RawMetric[] | null => rawOfSample.get(s) ?? null,
  /** the unwritten minute written now (with the recorder on): its body, and the raw metrics of the last tick it folded */
  writeMinute: (): { body: ReturnType<typeof foldMinute>; lastTs: number; lastRaw: RawMetric[] | null } | null => {
    if (!recorderOn() || !minute.length) return null
    const w = writeMinute()
    return { body: w.body, lastTs: w.last?.ts ?? 0, lastRaw: w.last ? rawOfSample.get(w.last) ?? null : null }
  },
  need: (on: boolean) => { forcedNeed = on },
  /** a sample handed to the consumers as if sampled (memory.ts's cases); never written to disk */
  inject: (s: Sample) => { lastSample = s; for (const fn of [...sampleFns]) { try { fn(s) } catch { /* the consumer's */ } } },
  event: (kind: AppKind, ident: TabIdent | null, body: Record<string, unknown>) => record(kind, ident, body),
  reset: () => {
    samples = []; events = []; baselines = new Map(); lastMono = null; lastSample = null; minute = []; spawnMs = 0
    footprints.clear(); memAsks.clear(); shownAsks.clear(); visibleAnswer = null; visibleDoc = ''
  },
}

