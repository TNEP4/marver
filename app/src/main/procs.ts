/**
 * Process ownership and CPU math for the one sampler (spec 28 A3.1, A3.8 #4, #48, #49). Owner: the recorder stream.
 * Pure: no Electron at run time (its types only), unit-tested without it.
 *
 * A process is keyed by `(pid, creationTime)`: a reused pid is a new process. CPU is Δ`cumulativeCPUUsage` over Δ
 * monotonic time - `null` on a process's first sample and after a resume, never `percentCPUUsage`, whose interval
 * every caller shares. `rssMB` is `workingSetSize / 1024` (KB), once per process. Ownership comes from the tick's own
 * turn (recorder.ts reads each webContents' `getOSProcessId()` and, for a canvas, every `framesInSubtree` frame's
 * `osProcessId` through frames.ts's `safely()`), so out-of-process iframes count for their tab and a renderer of two
 * tabs is counted once. The budgets' process sets come from roles through `inOwnSet`, the one function.
 *
 * FROZEN (A3.8 #53): `procKey`, `Owners`, `Baseline`, `build`'s signature, `inOwnSet`. `canvasMem` and `foldMinute`
 * (the minute on disk, A3.8 #7) are the recorder stream's, pure like the rest.
 */
import type { ProcessMetric } from 'electron'
import type { Agg, PressureLevel, ProcSample, ProcType, Role, Sample, SampleBody } from '../../../src/shared/app-perf.ts'

export type { ProcSample, ProcType, Role }

/** A process's key: pid and creation time. */
export const procKey = (pid: number, born: number): string => `${pid}:${born}`

/** What hosts a renderer, read in the tick's turn: the page kinds (a role each) and the tabs with any frame in it. */
export interface Owner { roles: Set<Exclude<Role, 'mixed' | 'none' | 'unknown'>>; tabs: Set<string> }
export type Owners = Map<number, Owner>

/** The last cumulative CPU seen of a process, on the monotonic clock. */
export interface Baseline { mono: number; cum: number | undefined }

export interface Built {
  procs: ProcSample[]
  gpu: Sample['gpu']
  /** the next tick's baselines: the processes alive now */
  baselines: Map<string, Baseline>
}

const TYPES: Record<string, ProcType> = { Browser: 'browser', GPU: 'gpu', Utility: 'utility', Tab: 'renderer' }
/** Electron's process type, as the sampler names it. */
export const typeOf = (t: string): ProcType => TYPES[t] ?? 'other'

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * One tick's processes from `getAppMetrics()`: types, roles, tabs, CPU against `prev`, RSS, and the canvas
 * renderers' footprints the preload answered (`footprints`: pid -> MB, each at most 10 s old, A3.8 #5).
 *
 * - CPU: Δ`cumulativeCPUUsage` over Δ monotonic seconds against the process's own baseline - none (a first sample, a
 *   reused pid, the first after a resume, whose baselines are cleared), a missing cumulative, or no time passed is
 *   null; never negative.
 * - Roles: a renderer hosting one page kind has it; two or more kinds `mixed`; none read `unknown` (a spare renderer):
 *   it stays in the app's own sets (inOwnSet). Every other process `none`.
 * - A metric listed twice (the same pid and creation time) counts once.
 */
export function build(metrics: readonly ProcessMetric[], owners: Owners, prev: ReadonlyMap<string, Baseline>, mono: number, footprints: ReadonlyMap<number, number>): Built {
  const procs: ProcSample[] = []
  const baselines = new Map<string, Baseline>()
  let gpu: Sample['gpu'] = null
  for (const m of metrics) {
    if (!m || !num(m.pid) || !num(m.creationTime)) continue
    const key = procKey(m.pid, m.creationTime)
    if (baselines.has(key)) continue
    const cum = num(m.cpu?.cumulativeCPUUsage) ? m.cpu.cumulativeCPUUsage : undefined
    baselines.set(key, { mono, cum })
    const p = prev.get(key)
    const cpu = p && cum !== undefined && p.cum !== undefined && mono > p.mono ? Math.max(0, (cum - p.cum) / ((mono - p.mono) / 1000)) : null
    const rssMB = num(m.memory?.workingSetSize) ? m.memory.workingSetSize / 1024 : 0
    const type = typeOf(m.type)
    const o = type === 'renderer' ? owners.get(m.pid) : undefined
    const roles = o ? [...o.roles] : []
    const role: Role = type !== 'renderer' ? 'none' : roles.length === 0 ? 'unknown' : roles.length === 1 ? roles[0]! : 'mixed'
    const tabs = o ? [...o.tabs].sort() : []
    const fp = footprints.get(m.pid)
    const footprintMB = role === 'canvas' && num(fp) ? fp : null
    procs.push({ pid: m.pid, born: m.creationTime, type, ...(m.name ? { name: m.name } : {}), role, tabs, cpu, rssMB, footprintMB })
    if (type === 'gpu' && !gpu) gpu = { pid: m.pid, born: m.creationTime, cpu, gpuProcessRssMB: rssMB }
  }
  return { procs, gpu, baselines }
}

/** A canvas process's memory (A3.8 #41): its preload's footprint, else RSS. */
export const memOf = (p: Pick<ProcSample, 'footprintMB' | 'rssMB'>): number => p.footprintMB ?? p.rssMB

/**
 * Canvas memory in one sample (A3.8 #41): the sum over unique canvas processes, and per tab the sum of its own (a
 * renderer shared by two tabs counts once in the sum, and in each tab's own figure); null with no canvas process.
 */
export function canvasMem(procs: readonly ProcSample[]): { memMB: number; byTab: Record<string, { memMB: number; cpu: number | null; pids: number[]; shared: boolean }> } | null {
  const canvases = procs.filter((p) => p.role === 'canvas')
  if (!canvases.length) return null
  const byTab: Record<string, { memMB: number; cpu: number | null; pids: number[]; shared: boolean }> = {}
  let memMB = 0
  for (const p of canvases) {
    memMB += memOf(p)
    for (const t of p.tabs) {
      const b = byTab[t] ??= { memMB: 0, cpu: null, pids: [], shared: false }
      b.memMB += memOf(p)
      if (p.cpu !== null) b.cpu = (b.cpu ?? 0) + p.cpu
      b.pids.push(p.pid)
      if (p.tabs.length > 1) b.shared = true
    }
  }
  return { memMB, byTab }
}

// ---- the minute on disk (A3.8 #7) -------------------------------------------------------------------------------

/** An aggregate being folded: a plain mean of what was read, or - with a weight (CPU: its interval) - a weighted one. */
class Fold {
  private sum = 0
  private w = 0
  max: number | null = null
  last: number | null = null
  add(v: number | null, weight = 1): void {
    this.last = v
    if (v === null || !Number.isFinite(v)) return
    this.max = this.max === null ? v : Math.max(this.max, v)
    if (weight <= 0) return
    this.sum += v * weight
    this.w += weight
  }
  /** Σ value x weight: for CPU, the core-seconds used */
  get total(): number { return this.sum }
  get weight(): number { return this.w }
  agg(): Agg { return { mean: this.w > 0 ? round(this.sum / this.w) : null, max: this.max === null ? null : round(this.max), last: this.last === null ? null : round(this.last) } }
}
const round = (v: number): number => Math.round(v * 1e4) / 1e4

/**
 * One minute of samples folded into its `sample` line (A3.8 #7). CPU is exact over the minute: each sample's CPU
 * covers the interval since the one before it (`dt`), so the minute's mean is Σ(cpu x dt) / Σ dt - Δ cumulative over
 * Δ monotonic time - never a mean of the 5 s means; `cpuTime` gives the core-seconds and the ms they cover, so the
 * budget can add minutes up. A CPU figure with no interval (none, after a resume) is a last and a max, never in the
 * mean. Memory is mean, max and last per process and for the canvases. A process is listed once per `(pid, born)`,
 * with what it was last seen as (its role, its tabs).
 */
export function foldMinute(samples: readonly Sample[], spawnMs: number): SampleBody | null {
  if (!samples.length) return null
  interface P { pid: number; born: number; type: ProcType; role: Role; name?: string; tabs: string[]; cpu: Fold; rssMB: Fold; footprintMB: Fold; cpuMs: number }
  const procs = new Map<string, P>()
  const gpus = new Map<string, { pid: number; born: number; cpu: Fold; gpuProcessRssMB: Fold }>()
  const canvas = new Fold()
  const byTab = new Map<string, { memMB: Fold; cpu: Fold; shared: boolean }>()
  let lastLevel: PressureLevel | null = null
  let maxLevel: PressureLevel | null = null
  let span = 0
  let gpuLast = ''
  for (const s of samples) {
    const dt = s.dt !== null && Number.isFinite(s.dt) && s.dt > 0 ? s.dt : null
    if (dt !== null) span += dt * 1000
    lastLevel = s.pressure?.level ?? null
    if (lastLevel !== null) maxLevel = maxLevel === null ? lastLevel : (Math.max(maxLevel, lastLevel) as PressureLevel)
    for (const p of s.procs) {
      const k = procKey(p.pid, p.born)
      let f = procs.get(k)
      if (!f) procs.set(k, f = { pid: p.pid, born: p.born, type: p.type, role: p.role, tabs: [], cpu: new Fold(), rssMB: new Fold(), footprintMB: new Fold(), cpuMs: 0 })
      f.role = p.role
      f.tabs = p.tabs
      if (p.name) f.name = p.name
      f.cpu.add(p.cpu, p.cpu !== null && dt !== null ? dt : 0)
      if (p.cpu !== null && dt !== null) f.cpuMs += dt * 1000
      f.rssMB.add(p.rssMB)
      if (p.footprintMB !== null) f.footprintMB.add(p.footprintMB)
    }
    if (s.gpu) {
      const k = procKey(s.gpu.pid, s.gpu.born)
      gpuLast = k
      let g = gpus.get(k)
      if (!g) gpus.set(k, g = { pid: s.gpu.pid, born: s.gpu.born, cpu: new Fold(), gpuProcessRssMB: new Fold() })
      g.cpu.add(s.gpu.cpu, s.gpu.cpu !== null && dt !== null ? dt : 0)
      g.gpuProcessRssMB.add(s.gpu.gpuProcessRssMB)
    }
    const c = canvasMem(s.procs)
    if (c) {
      canvas.add(c.memMB)
      for (const [tab, v] of Object.entries(c.byTab)) {
        let b = byTab.get(tab)
        if (!b) byTab.set(tab, b = { memMB: new Fold(), cpu: new Fold(), shared: false })
        if (v.shared) b.shared = true
        b.memMB.add(v.memMB)
        b.cpu.add(v.cpu, v.cpu !== null && dt !== null ? dt : 0)
      }
    }
  }
  const last = samples[samples.length - 1]!
  const g = gpus.get(gpuLast)
  return {
    span: Math.round(span), n: samples.length,
    pressure: { last: lastLevel, max: maxLevel },
    thermal: last.thermal,
    procs: [...procs.values()].map((p) => ({
      pid: p.pid, born: p.born, type: p.type, role: p.role, ...(p.name ? { name: p.name } : {}), tabs: p.tabs,
      cpu: p.cpu.agg(), rssMB: p.rssMB.agg(), footprintMB: p.footprintMB.agg(),
      ...(p.cpu.weight > 0 ? { cpuTime: { s: round(p.cpu.total), ms: Math.round(p.cpuMs) } } : {}),
    })),
    gpu: g ? { pid: g.pid, born: g.born, cpu: g.cpu.agg(), gpuProcessRssMB: g.gpuProcessRssMB.agg() } : null,
    // a tab whose renderer another tab shared (any sample of the minute) says so: that renderer is whole in each tab's
    // figure, and `memMB` above counts it once - never add byTab up
    canvases: { memMB: canvas.agg(), byTab: Object.fromEntries([...byTab].map(([t, b]) => [t, { memMB: b.memMB.agg(), cpu: b.cpu.agg(), ...(b.shared ? { shared: true as const } : {}) }])) },
    visible: last.visible,
    sys: last.sys,
    spawnMs: Math.round(spawnMs),
  }
}

/**
 * The budgets' sets (A3.8 #4, #48, #49): is this process the app's own?
 * - `cpu`: the browser, the GPU process, every utility process and every app-page renderer (Crashpad's handler is
 *   read from outside); a canvas renderer never - it is reported, not gated;
 * - `memory-no-canvas`: the same (the GPU process counted only on a run with no canvas open, Nic, 23 Oct);
 * - `memory-canvases`: the same without the GPU process, which is reported beside it.
 * A renderer whose role is unknown (a spare one) stays in the app's figure: it can fail a run, never pass one.
 */
export type OwnGate = 'cpu' | 'memory-no-canvas' | 'memory-canvases'
export function inOwnSet(p: Pick<ProcSample, 'type' | 'role'>, gate: OwnGate): boolean {
  if (p.type === 'gpu') return gate !== 'memory-canvases'
  if (p.type === 'renderer') return p.role !== 'canvas'
  return true
}
