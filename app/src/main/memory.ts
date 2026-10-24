/**
 * Unloading hidden tabs under pressure: the policy (spec 28 A2.6, A3.8 #40, #41, #45). Owner: the unloading stream.
 * `decide` is pure; the tick around it runs on the one sampler's samples (recorder.ts), also with the recorder off.
 *
 * At each sample: at critical (4), every candidate, least recently shown first; at warn (2), or when canvas
 * renderers together are strictly above half of `os.totalmem()`, only the least recently shown one, then
 * `unloadCooldownMs` before the next such unload, one at a time - the kernel's level lags the freeing. An unknown
 * level never triggers; the half-RAM rule rests on the sampler alone. "Least recently shown" is the smallest
 * `hiddenAt`, a tie to the lower tab id. Canvas memory is the sum over unique canvas processes of `footprintMB`,
 * else `rssMB`: footprint first, RSS the backstop (RSS leaves out compressed and GPU memory). A candidate is a tab
 * whose `unloadRefusal(tab, now)` is null (tabs.ts); the act is `guard(tab, { kind: 'unload', reason })`. Records go
 * through `event`: `pressure` on a change of level, `unload { phase: 'start', before }` as an unload is admitted (the
 * guard and views.ts write its end), `unload-skip` once per tab and reason in each pressure episode, `unload-effect`
 * `unloadEffectMs` after an unload. No adaptive algorithm: the numbers are timings.ts's, retuned from these records.
 *
 * The sampler asks `wantPressure` at every tick: true while unloading is on and some hidden tab could be unloaded
 * now or once it has been hidden long enough - with the recorder off and nothing that could be unloaded, a tick
 * reads neither the metrics nor the pressure (A3.8 #6).
 *
 * Test builds (`MARVER_APP_TEST=1`): `memory:tick` (one tick now on a sample the case describes - a pressure level,
 * canvas memory, processes - or, with `real`, the sampler's own `requestSample()`), `memory:state`,
 * `memory:totalmem { mb }` (null restores `os.totalmem()`). startMemory provides them, not testing/recorder.ts's
 * provideRecorderHooks, whose frozen comment names them; `pressure:inject` (named there too) is not built on this
 * stream - it sets pressure.ts's reading, which the recorder stream builds. A hook provided twice is said by the
 * first case that calls it, naming both places (testing/index.ts `provide`).
 *
 * FROZEN (A3.8 #53): `Candidate`, `DecideInput`, `Decision`, `decide`, `canvasMemory`, `MemoryDeps`, `startMemory`.
 */
import type { AppBody, AppKind, PressureLevel, ProcSample, Sample, Sampler, TabIdent, UnloadFigures, UnloadReason } from '../../../src/shared/app-perf.ts'
import { procKey } from './procs.ts'
import { allTabs, couldUnload, getTab, guard, isSweeping, tabIdent, unloadRefusal, type Tab, type UnloadRefusal } from './tabs.ts'
import { note, provide } from './testing/index.ts'
import { T } from './timings.ts'

export interface Candidate { id: string; hiddenAt: number }

export interface DecideInput {
  /** config.unloadUnderPressure */
  on: boolean
  level: PressureLevel | null
  /** canvasMemory(sample); null with no sample */
  canvasMB: number | null
  /** os.totalmem() in MB (a test may set it) */
  totalMB: number
  candidates: Candidate[]
  /** a warn or half-RAM unload not yet ended */
  softInFlight: boolean
  lastSoftAt: number | null
  now: number
}

export interface Decision { unload: { id: string; reason: UnloadReason }[] }

/** A tab id's counter (`t` and base 36), for the tie-break: the lower id is the older tab. */
const idNum = (id: string): number => { const n = Number.parseInt(id.slice(1), 36); return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER }
const byLru = (a: Candidate, b: Candidate): number => a.hiddenAt - b.hiddenAt || idNum(a.id) - idNum(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The policy (A3.8 #41): pure. */
export function decide(i: DecideInput): Decision {
  if (!i.on || !i.candidates.length) return { unload: [] }
  const lru = [...i.candidates].sort(byLru)
  if (i.level === 4) return { unload: lru.map((c) => ({ id: c.id, reason: 'critical' as const })) }
  const half = i.canvasMB !== null && i.canvasMB > i.totalMB / 2   // strictly past half (A2.6)
  const soft: UnloadReason | null = i.level === 2 ? 'warn' : half ? 'half-ram' : null
  if (!soft || i.softInFlight) return { unload: [] }
  if (i.lastSoftAt !== null && i.now - i.lastSoftAt < T.unloadCooldownMs) return { unload: [] }
  return { unload: [{ id: lru[0]!.id, reason: soft }] }   // then the next samples measure again
}

/** Each process once, by `(pid, born)`: a renderer of two tabs counted once, a reused pid a new process. */
function unique(procs: readonly ProcSample[]): ProcSample[] {
  const seen = new Set<string>()
  const out: ProcSample[] = []
  for (const p of procs) {
    const k = procKey(p.pid, p.born)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return out
}

const memOf = (p: ProcSample): number => p.footprintMB ?? p.rssMB
const round1 = (n: number): number => Math.round(n * 10) / 10

/** Σ over unique canvas processes of footprintMB, else rssMB (A3.8 #41); null when the sample has no canvas process. */
export function canvasMemory(s: Sample): number | null {
  const canvas = unique(s.procs.filter((p) => p.role === 'canvas'))
  if (!canvas.length) return null
  return round1(canvas.reduce((n, p) => n + memOf(p), 0))
}

/** An unload's figures from one sample (A3.8 #45): the pressure, canvas memory, the tab's own processes, the GPU process. */
export function figures(s: Sample, tabId: string): UnloadFigures {
  const mine = unique(s.procs.filter((p) => p.tabs.includes(tabId)))
  return {
    level: s.pressure?.level ?? null,
    availablePct: s.pressure?.availablePct ?? null,
    canvasMB: canvasMemory(s),
    tab: { pids: mine.map((p) => p.pid), memMB: mine.length ? round1(mine.reduce((n, p) => n + memOf(p), 0)) : null },
    gpuProcessRssMB: s.gpu?.gpuProcessRssMB ?? null,
  }
}

export interface MemoryDeps {
  config(): { unloadUnderPressure: boolean }
  sampler: Sampler
  totalMB(): number
  /** recorder.event */
  event<K extends AppKind>(kind: K, who: Tab | TabIdent | null, body: Omit<AppBody<K>, keyof TabIdent>): void
  now(): number
}

/** Refusals that are no news: nothing there to unload. Every other one is an `unload-skip` once per episode. */
const NOT_NEWS: ReadonlySet<UnloadRefusal> = new Set(['not-canvas', 'active', 'no-document'])

interface Tick {
  at: number
  level: PressureLevel | null
  canvasMB: number | null
  totalMB: number
  reason: UnloadReason | null
  candidates: Candidate[]
  refused: { id: string; why: UnloadRefusal }[]
  unload: Decision['unload']
}

let deps: MemoryDeps | null = null
const st = {
  lastSoftAt: null as number | null,
  softInFlight: false,
  /** the last level read: `pressure` is written on a change */
  level: undefined as PressureLevel | null | undefined,
  /** from a sample past warn, critical or half of RAM until one that is not: each tab's skip reasons said once */
  episode: null as { since: number; said: Set<string> } | null,
  last: null as Tick | null,
  /** a test's os.totalmem(), MB */
  totalMB: null as number | null,
}

const totalMB = (): number => st.totalMB ?? deps!.totalMB()
const journal = (data: Record<string, unknown>) => { if (__MV_TEST__) note('memory', data) }
const wait = (ms: number) => new Promise<void>((r) => { const x = setTimeout(r, ms); (x as { unref?: () => void }).unref?.() })

/** A record through the recorder (app.jsonl only with the recorder on); the journal's `record` line in test builds, as views.ts's. */
function record<K extends AppKind>(kind: K, who: Tab | TabIdent | null, body: Omit<AppBody<K>, keyof TabIdent>): void {
  if (__MV_TEST__) note('record', { kind, ...(who ? { tab: 'id' in who ? who.id : who.tab } : {}), ...(body as object) })
  deps!.event(kind, who, body)
}

/** `pressure` on a change of the level read (A3.8 #45); a tick that read none says nothing. */
function notePressure(s: Sample): void {
  if (!s.pressure) return
  const level = s.pressure.level
  if (level === st.level) return
  const was = st.level ?? null
  st.level = level
  record('pressure', null, { level, availablePct: s.pressure.availablePct, was })
}

/** One sample's decision, and its acts (A3.8 #41). */
export function tick(s: Sample): Tick {
  const d = deps!
  const now = d.now()
  const on = d.config().unloadUnderPressure
  const level = s.pressure?.level ?? null
  const canvasMB = canvasMemory(s)
  const total = totalMB()
  notePressure(s)
  const half = canvasMB !== null && canvasMB > total / 2
  const reason: UnloadReason | null = level === 4 ? 'critical' : level === 2 ? 'warn' : half ? 'half-ram' : null
  if (!reason) st.episode = null
  else if (!st.episode) st.episode = { since: now, said: new Set() }
  const candidates: Candidate[] = []
  const refused: Tick['refused'] = []
  // a quit or an update under way: no unload is admitted, and nothing is news
  const live = on && !isSweeping()
  if (live) {
    for (const t of allTabs()) {
      if (t.kind !== 'local') continue
      const why = unloadRefusal(t, now)
      if (why === null) { candidates.push({ id: t.id, hiddenAt: t.hiddenAt ?? now }); continue }
      refused.push({ id: t.id, why })
      if (reason && st.episode && !NOT_NEWS.has(why)) {
        const key = `${t.id}|${why}`
        if (!st.episode.said.has(key)) { st.episode.said.add(key); record('unload-skip', t, { reason, why }) }
      }
    }
  }
  const dec = decide({ on: live, level, canvasMB, totalMB: total, candidates, softInFlight: st.softInFlight, lastSoftAt: st.lastSoftAt, now })
  st.last = { at: now, level, canvasMB, totalMB: total, reason, candidates, refused, unload: dec.unload }
  if (reason || dec.unload.length) journal({ tick: now, level, canvasMB, totalMB: total, reason, candidates: candidates.map((c) => c.id), unload: dec.unload })
  for (const u of dec.unload) { const t = getTab(u.id); if (t) start(t, u.reason, s, now) }
  return st.last
}

/** One unload, through the guard; its effect measured `unloadEffectMs` after it (A3.8 #45). */
function start(t: Tab, reason: UnloadReason, s: Sample, now: number): void {
  const d = deps!
  const ident = tabIdent(t)   // the document it closes, taken now
  const before = figures(s, t.id)
  const keys = new Set(unique(s.procs.filter((p) => p.tabs.includes(t.id))).map((p) => procKey(p.pid, p.born)))
  const soft = reason !== 'critical'
  const wasSoftAt = st.lastSoftAt
  if (soft) { st.softInFlight = true; st.lastSoftAt = now }
  const op = guard(t, { kind: 'unload', reason })
  // admitted: the guard's recheck and the act's close ran in this same turn, before guard() returned (a candidate
  // has no unload; an admitted one has one, whatever its phase now)
  if (t.unload) record('unload', ident, { phase: 'start', reason, before })
  void op.then(async (r) => {
    if (soft) {
      st.softInFlight = false
      // nothing was unloaded (refused at the recheck, or by the page): no cooldown for it
      if (r !== 'done' && st.lastSoftAt === now) st.lastSoftAt = wasSoftAt
    }
    if (r !== 'done') return
    await wait(T.unloadEffectMs)
    let after: Sample | null = null
    try { after = await d.sampler.requestSample() } catch { after = d.sampler.last() }
    if (!after || after === s) { journal({ effect: t.id, after: 'no sample' }); return }
    const pidGone = keys.size > 0 && !after.procs.some((p) => keys.has(procKey(p.pid, p.born)))
    record('unload-effect', ident, { reason, before, after: figures(after, t.id), pidGone })
  }, (err: unknown) => {
    if (soft) { st.softInFlight = false; if (st.lastSoftAt === now) st.lastSoftAt = wasSoftAt }
    journal({ error: String((err as Error)?.message ?? err), tab: t.id })
  })
}

/** What memory.ts holds now (test builds; Copy Details' pressure line reads pressure.ts's last reading). */
export function memoryState() {
  const now = deps?.now() ?? Date.now()
  return {
    lastSoftAt: st.lastSoftAt, softInFlight: st.softInFlight, level: st.level ?? null,
    episode: st.episode ? { since: st.episode.since, said: [...st.episode.said] } : null,
    last: st.last, totalMB: deps ? totalMB() : null,
    tabs: allTabs().filter((t) => t.kind === 'local').map((t) => ({ id: t.id, why: unloadRefusal(t, now), hiddenAt: t.hiddenAt ?? null })),
  }
}

/** Test seam: the policy's state forgotten (unit tests). */
export function resetMemory(): void {
  st.lastSoftAt = null; st.softInFlight = false; st.level = undefined; st.episode = null; st.last = null; st.totalMB = null
}

/** A sample a test describes (`memory:tick`): a level, canvas memory as one canvas process, or processes of its own. */
interface FakeTick { level?: PressureLevel | null; availablePct?: number | null; canvasMB?: number; procs?: ProcSample[]; real?: boolean }
function fakeSample(x: FakeTick, now: number): Sample {
  const procs: ProcSample[] = [...(x.procs ?? [])]
  if (typeof x.canvasMB === 'number') procs.push({ pid: 1, born: 1, type: 'renderer', role: 'canvas', tabs: [], cpu: null, rssMB: x.canvasMB, footprintMB: null })
  return {
    ts: now, mono: now, dt: null, procs, gpu: null,
    pressure: 'level' in x ? { level: x.level ?? null, availablePct: x.availablePct ?? null, at: now } : null,
    thermal: 'unknown', sys: null, visible: null,
  }
}

/** At ready, after the views (tabs.ts holds the model): the sampler's subscriber and `wantPressure`. */
export function startMemory(d: MemoryDeps): void {
  deps = d
  d.sampler.wantPressure(() => d.config().unloadUnderPressure && !isSweeping() && allTabs().some((t) => couldUnload(t, d.now())))
  d.sampler.onSample((s) => { tick(s) })
  if (__MV_TEST__) {
    provide('memory:tick', async (a) => {
      const x = (a ?? {}) as FakeTick
      let s: Sample
      if (x.real) {
        s = await d.sampler.requestSample()
        if ('level' in x) s = { ...s, pressure: { level: x.level ?? null, availablePct: x.availablePct ?? null, at: d.now() } }
      } else s = fakeSample(x, d.now())
      return tick(s)
    })
    provide('memory:state', () => memoryState())
    provide('memory:totalmem', (a) => {
      const mb = (a as { mb?: unknown } | null)?.mb
      st.totalMB = typeof mb === 'number' && mb > 0 ? mb : null
      return totalMB()
    })
  }
}
