/**
 * The app half of the recorder, on disk and in memory (spec 28 A3.1, A3.8 #4-#9, #13, #16, #45, #48, #49): the
 * one schema the Mac app writes into `~/.marver/perf/app.jsonl` (Marver Dev: `app-dev.jsonl`) and the CLI reads
 * (`marver perf --crashes`, `--flashes`, `--machine`), and the sampler's shapes `memory.ts` and the budgets read.
 * Types, constants and one pure reader only - no imports - so the app's main bundle, the CLI and the test harness
 * all take it as it is.
 *
 * FROZEN before the A3 streams split (A3.8 #53). Owners: the recorder stream writes the envelope and most kinds;
 * the unloading stream writes `pressure`, `unload`, `unload-skip`, `unload-effect` and `reopen` through
 * `recorder.event`; the one-ground stream writes `cover`; the flash stream writes `flash` and
 * `whiteout-candidate`. A kind's body grows only by optional fields; a field's meaning never changes.
 *
 * Units, said once: every `...MB` is MiB (KB / 1024 once per process, A3.8 #4); `cpu` is cores (Δ
 * `cumulativeCPUUsage` / Δ monotonic seconds, never `percentCPUUsage`); times are epoch ms (`ts`, `at`) or
 * monotonic ms (`mono`); a process is `(pid, born)`, `born` its `creationTime` - a reused pid is a new process.
 * `gpuProcessRssMB` is the GPU process's working set, never "GPU memory" (Codex r1 #19); the app never reads a
 * footprint about itself (A3.8 #2) - the budgets read footprint from outside.
 */

// ---- the line --------------------------------------------------------------------------------------------------

/** Which build wrote a line: the release (`app.jsonl`) or Marver Dev (`app-dev.jsonl`). One writer per file (A3.8 #12). */
export type Flavour = 'release' | 'dev'
/** The file each flavour writes, under `<MARVER_HOME>/perf/`. */
export const APP_LOG: Record<Flavour, string> = { release: 'app.jsonl', dev: 'app-dev.jsonl' }

/**
 * The record kinds (A3.8 #8). `main-error` is app 0.1's (errors.ts), kept so a 0.1 line still parses once the
 * recorder stamps it with the envelope.
 */
export const APP_KINDS = [
  'start', 'sample', 'agx', 'gone', 'child-gone', 'gpu-restart', 'unresponsive', 'responsive', 'gpu', 'power',
  'tab', 'shown', 'pressure', 'unload', 'unload-skip', 'unload-effect', 'reopen', 'cover', 'flash',
  'whiteout-candidate', 'dropped', 'main-error',
] as const
export type AppKind = (typeof APP_KINDS)[number]

/** Every line (A3.8 #8). `app`: a random id per launch (12 hex); `seq`: counted per launch from 0, contiguous; `machine`: the profile hash in force, null only when none could be made in 3 s. */
export interface AppEnvelope {
  v: 1
  ts: number
  kind: AppKind
  app: string
  seq: number
  flavour: Flavour
  machine: string | null
}

/**
 * A record about a tab carries its identity, captured in the event's turn before any await (A3.8 #8). `page` is the
 * one the admitted document's accepted `mv:hello` sent; a document that has not said hello has none, and never gets
 * the next document's. `commit` is the tab's commit count (tabs.ts `doc.commits`).
 */
export interface TabIdent { tab: string; ws?: string; commit?: number; page?: string }

/** A process, as the budgets and `--crashes` name it. */
export interface ProcId { pid: number; born: number }

// ---- the sampler (A3.8 #4-#6): what memory.ts, a flash and the budgets read -----------------------------------

export type ProcType = 'browser' | 'gpu' | 'utility' | 'renderer' | 'other'
/** A renderer's role: the page kind it hosts ('mixed': two app-page kinds; 'cover': S15's variant 3); every other process 'none'. */
export type Role = 'canvas' | 'strip' | 'home' | 'settings' | 'tabpage' | 'cover' | 'mixed' | 'none' | 'unknown'
/** Electron's `powerMonitor.getCurrentThermalState()`. */
export type ThermalState = 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical'

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export type PressureLevel = 1 | 2 | 4
/** One pressure read (A3.8 #6): `level` null is unknown (a failed, timed-out or other answer) - never normal, never acted on. */
export interface PressureReading {
  level: PressureLevel | null
  /** `kern.memorystatus_level`, 0-100: recorded, not acted on */
  availablePct: number | null
  /** epoch ms of the read */
  at: number
}

export interface ProcSample {
  pid: number
  /** creationTime; with pid, the key */
  born: number
  type: ProcType
  /** Electron's `name` (utility processes) */
  name?: string
  role: Role
  /** the tabs with any frame in it (a canvas renderer shared by two tabs lists both; its out-of-process iframes count for their tab) */
  tabs: string[]
  /** cores; null on a process's first sample and the first after a resume */
  cpu: number | null
  rssMB: number
  /** canvas renderers: the preload's footprint (`private`), at most 10 s old (A3.8 #5); else null - RSS stands in */
  footprintMB: number | null
}

export interface Sample {
  /** epoch ms */
  ts: number
  /** monotonic ms (performance.now()) */
  mono: number
  /** monotonic s since the previous sample; null for the first and after a resume */
  dt: number | null
  /** every unique process; a process is counted once in any sum */
  procs: ProcSample[]
  gpu: { pid: number; born: number; cpu: number | null; gpuProcessRssMB: number } | null
  /** read only while recording or while a hidden tab could be unloaded (A3.8 #6); null when not read */
  pressure: PressureReading | null
  thermal: ThermalState
  /** process.getSystemMemoryInfo(), KB to MB */
  sys: { freeMB: number; purgeableMB: number } | null
  /** the visible tab's last `mem` answer, at most 10 s old */
  visible: (TabIdent & { privateMB: number; heapMB: number; at: number }) | null
}

/**
 * The one sampler, two consumers (A3.8 #4): `recorder.ts` owns the only `getAppMetrics()` loop, every 5 s, while
 * recording or while `wantPressure()` says an unload is possible; with the recorder off it runs only for
 * `memory.ts` and writes nothing.
 */
export interface Sampler {
  /** every sample, as it is published (after its pressure read ended) */
  onSample(fn: (s: Sample) => void): () => void
  /** memory.ts: asked at every tick - true while some hidden tab could be unloaded (A3.8 #6); it also keeps the tick alive with the recorder off */
  wantPressure(fn: () => boolean): void
  /** one extra sample now, on the same baselines (an unload's "after", A3.8 #45) */
  requestSample(): Promise<Sample>
  /** the last sample published, or null */
  last(): Sample | null
}

/** The GPU process's identity: `getAppMetrics()`'s `GPU` entry (A3.8 #27, r3 #1). A change, or none, is a loss. */
export type GpuIdentity = ProcId

// ---- bodies -----------------------------------------------------------------------------------------------------

/** mean, max and last over a window; null when nothing was read */
export interface Agg { mean: number | null; max: number | null; last: number | null }

/** One minute of 5 s samples (A3.8 #7): CPU exact over the minute (Δ cumulative / Δ monotonic), memory as mean, max and last. */
export interface SampleBody {
  /** ms covered, and the samples folded in */
  span: number
  n: number
  pressure: { last: PressureLevel | null; max: PressureLevel | null }
  thermal: ThermalState
  /** every unique process seen in the minute (the CPU budget joins by pid and a start time within 1 s of `born`, A3.8 #49) */
  procs: { pid: number; born: number; type: ProcType; role: Role; name?: string; tabs: string[]; cpu: Agg; rssMB: Agg; footprintMB: Agg }[]
  gpu: { pid: number; born: number; cpu: Agg; gpuProcessRssMB: Agg } | null
  /** canvas memory (A3.8 #41): Σ over unique canvas processes of footprintMB, else rssMB */
  canvases: { memMB: Agg; byTab: Record<string, { memMB: Agg; cpu: Agg }> }
  visible: Sample['visible']
  sys: Sample['sys']
  /** wall ms of this minute's sysctl / ioreg spawns: the recorder's own cost */
  spawnMs: number
}

/** `ioreg -rc AGXAccelerator -d1`, machine-wide (A3.1, A3.8 #9): a missing key is 'unknown'. */
export interface AgxReading {
  gpuSystemMemoryMB: number | 'unknown'
  allocMB: number | 'unknown'
  utilPct: number | 'unknown'
  rendererPct: number | 'unknown'
  tilerPct: number | 'unknown'
  recoveryCount: number | 'unknown'
  machineWide: true
}

export type UnloadReason = 'warn' | 'critical' | 'half-ram'
/** An unload's before and after figures (A3.8 #45). */
export interface UnloadFigures {
  level: PressureLevel | null
  availablePct: number | null
  /** Σ canvas memory (A3.8 #41) */
  canvasMB: number | null
  /** the tab's own processes, unique */
  tab: { pids: number[]; memMB: number | null }
  gpuProcessRssMB: number | null
}

/** Why a flash's picture is missing (A3.8 #13). */
export type PictureWhy = 'window hidden' | 'timeout' | 'empty' | 'write failed' | 'quit' | 'no window'

/** A record held in the ring, as a flash quotes it: its kind, its time and its body. */
export type RingEvent = { kind: AppKind; ts: number } & Record<string, unknown>

export interface AppBodies {
  start: { version: string; electron: string; chrome: string; recorder: boolean; pid: number }
  sample: SampleBody
  agx: AgxReading
  /** a renderer ended (A3.8 #9): `ours` when main was ending it (an unload, Reload Page); an unload writes its own at `destroyed`, `source: 'unload'` */
  gone: Partial<TabIdent> & { role: Role; pid: number; born: number; reason: string; exitCode: number; ours: boolean; source?: 'unload' | 'reload-page'; pressure: PressureLevel | null }
  /** the GPU or a utility process ended; never ours */
  'child-gone': { type: string; name?: string; reason: string; exitCode: number; ours: false; machineWide: false }
  /** a new GPU process with no child-gone within 2 s (A3.8 #9) */
  'gpu-restart': { pid: number; born: number; was: ProcId | null }
  unresponsive: Partial<TabIdent> & { role: Role; pid: number; born: number }
  responsive: Partial<TabIdent> & { role: Role; pid: number; born: number }
  /** gpu-info-update whose getGPUFeatureStatus() changed */
  gpu: { featureStatus: Record<string, string> }
  power: { event: 'on-ac' | 'on-battery' | 'suspend' | 'resume' | 'thermal-state-change' | 'speed-limit-change'; thermal?: ThermalState; limit?: number }
  /**
   * a change of the tab's display state, active flag, view state, document commit count or main frame (A3.8 #9,
   * r4 #1), diffed after each compose. `state` is tabs.ts's DisplayState, `view` its TabViewState.
   */
  tab: TabIdent & { state: string; active: boolean; view: string; main: ProcId | null }
  /** main's show to the preload's second animation-frame callback, on tab switches only (A3.8 #9) */
  shown: TabIdent & { ms: number }
  /** memory.ts: a change of level (A3.8 #45) */
  pressure: { level: PressureLevel | null; availablePct: number | null; was: PressureLevel | null }
  unload: TabIdent & { phase: 'start' | 'unsure' | 'done' | 'refused'; reason: UnloadReason; why?: string; before?: UnloadFigures }
  /** once per tab and reason in each pressure episode (A3.8 #45); `why` an UnloadRefusal */
  'unload-skip': TabIdent & { reason: UnloadReason; why: string }
  /** 5 s after an unload (A3.8 #45) */
  'unload-effect': TabIdent & { reason: UnloadReason; before: UnloadFigures; after: UnloadFigures; pidGone: boolean }
  /** written at the reopened document's accepted hello, or its next document or 30 s after its lift with no page (A3.8 #45) */
  reopen: TabIdent & { activateToLiftMs: number; unloadedForMs: number }
  /** a presentation epoch's outcome (A3.8 #27; the one-ground stream's tuning record) */
  cover: TabIdent & {
    epoch: number
    cause: 'doc' | 'size' | 'show' | 'fullscreen' | 'hello' | 'resize' | 'gpu'
    outcome: 'uncovered' | 'mismatch' | 'superseded' | 'never'
    /** ms from the epoch's start: sent, answered, uncovered */
    sentMs?: number
    answeredMs?: number
    uncoveredMs?: number
    frames: number
    uncoverDelayMs: number
  }
  /** Mark a Flash (A3.3, A3.8 #13, #14): written once the picture settled, the AGX read ended and the +1 s GPU window closed */
  flash: Partial<TabIdent> & {
    id: string
    via: 'key' | 'menu'
    recorder: boolean
    /** the ring, only with the recorder on: the last 12 samples and 60 s of events */
    ring: { samples: Sample[]; events: RingEvent[] } | null
    /** the state at the mark: one getAppMetrics() */
    now: Sample
    /** GPU process events from 1 s before the mark to 1 s after it */
    gpuEvents: RingEvent[]
    thermal: ThermalState
    pressure: PressureReading | null
    featureStatus: Record<string, string>
    agx: AgxReading
    /** `flashes/<id>.png` under perf/, or null with `pictureWhy` */
    picture: string | null
    pictureWhy?: PictureWhy
  }
  /** two completed white samples at consecutive ticks (A3.8 #16): white at `observedAt` only, nothing between them */
  'whiteout-candidate': TabIdent & {
    gesture: number
    observedAt: number[]
    rateHz: 4 | 2
    samples: number
    skipped: number
    inconclusive: number
    gpuEvents: RingEvent[]
    agx: AgxReading
  }
  /** the writer's queue overflowed (2,000 lines): how many went */
  dropped: { n: number }
  /** app 0.1's error policy (errors.ts) */
  'main-error': { what: 'exception' | 'rejection'; name: string; message: string; stack: string[] }
}

/** A kind's body alone (what `recorder.event` and the writer take; the writer adds the envelope). */
export type AppBody<K extends AppKind> = AppBodies[K]
/** One line of app.jsonl. */
export type AppRecord = { [K in AppKind]: AppEnvelope & { kind: K } & AppBodies[K] }[AppKind]

// ---- the reader -------------------------------------------------------------------------------------------------

const KINDS = new Set<string>(APP_KINDS)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

/**
 * One line of app.jsonl, or null (A3.5): the envelope checked - `v: 1`, a finite `ts`, a known `kind`, an `app` id,
 * a whole `seq`, a `flavour`, a `machine` hash or null. The body is the writer's and is passed on as it is: a
 * reader takes the fields it knows. A line without the envelope (app 0.1's main-error lines) is null.
 */
export function parseAppLine(line: string): AppRecord | null {
  let r: unknown
  try { r = JSON.parse(line) } catch { return null }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const o = r as Record<string, unknown>
  if (o.v !== 1 || typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return null
  if (typeof o.kind !== 'string' || !KINDS.has(o.kind)) return null
  if (typeof o.app !== 'string' || !/^[0-9a-f]{12}$/.test(o.app) || !isInt(o.seq)) return null
  if (o.flavour !== 'release' && o.flavour !== 'dev') return null
  if (o.machine !== null && (typeof o.machine !== 'string' || !/^[0-9a-f]{16}$/.test(o.machine))) return null
  return o as unknown as AppRecord
}
