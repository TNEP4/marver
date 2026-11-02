/**
 * The performance report (spec 28 A5.1 #26, #27; r1 #9, r2 #4, r3 #5): `PerfReport` v1, the one file Help > Export
 * Performance Report… and the crashed tab page's latched state write (`app/src/main/report.ts`). Pure: the types, each
 * record kind's projection, each value's rule and every aggregation, so the app's main bundle and the tests take it
 * as it is. It imports only `app-perf.ts`'s constants and types.
 *
 * **An allowlist, never a filter.** A record is never exported whole: each kind lists the fields it may carry
 * (nested objects field by field, `PROJECTIONS`), each with its rule. Anything unlisted is dropped. A string that
 * fails its rule becomes `other` (a featureStatus value `unknown`, its key dropped); a number that is not finite is
 * dropped, and so is any value of the wrong type; `null` stays where the record's schema has it (an unknown reading).
 * A line of an unknown kind is counted, never exported; `tab` lines are counted, never listed; `sample` and `shown`
 * lines are folded (below). Every string that leaves is one of the sets below, a pattern of at most 32 characters, or
 * a version. **Never**: `ws`, `page` or `origin`; file paths, board or canvas names, hosts or URLs; error messages or
 * stacks; process names, pids or creation times; pictures or their paths; flash ids, the ring, traces or dumps; the
 * envelope's launch id, `seq` and profile hash.
 *
 * **Sources and bounds** (#26): `~/.marver/perf/` only - this flavour's log, the machine profiles its lines name and
 * `crashpad/` as counts - over the last 7 days, or fewer if `keepPerfDays` keeps fewer. Lines outside the window are
 * skipped by their envelope's `ts`. Out: one JSON file of at most 2 MB (`REPORT_MAX_BYTES`), events newest first and
 * at most 2,000 of them, samples folded to one row per UTC hour. Each section says `ok`, `missing`, `unreadable` or
 * `partial`, with the count of lines that did not parse (attributed by the kind a torn line still names, else to the
 * events); a section is never silently empty: `partial` also when a bound cut something, with the count it cut.
 *
 * **What it cannot hold: the app's own memory footprint** (r1 #9). The recorder keeps a footprint only for canvas
 * renderers and the budgets read the app's from outside (A3.8 #2); the report gives the app's own processes' resident
 * memory, `ownRssMB`, never called a footprint.
 *
 * Units: MiB to one decimal place, cores to three, seconds to one decimal place; times are epoch ms; hours and days
 * are UTC, named by their first ms.
 *
 * FROZEN (A5.1 #41): `PerfReport` v1, `PROJECTIONS` and the value sets. A kind's projection grows only by optional
 * fields in a new version; a value set grows when the recorder's own set does (an unlisted value is `other` meanwhile).
 */
import { APP_KINDS, UPDATE_MOVE_WHY, type AppKind, type Flavour, type PressureLevel, type Role, type ThermalState, type UpdateBody } from './app-perf.ts'

// ---- bounds -------------------------------------------------------------------------------------------------------

export const REPORT_V = 1
/** the window: the last 7 days, or fewer if `keepPerfDays` keeps fewer (#26) */
export const REPORT_DAYS = 7
/** the file, whole (#26): past it the oldest events go first, counted in `events.cut` */
export const REPORT_MAX_BYTES = 2 * 1024 * 1024
/** events, newest first (#26) */
export const REPORT_EVENTS_MAX = 2000
/** the distinct profiles read, the most recently named first; past it counted in `mac.cut` */
export const REPORT_PROFILES_MAX = 20
/** a profile's displays kept */
export const REPORT_DISPLAYS_MAX = 16
/** the longest string a pattern admits */
export const REPORT_STRING_MAX = 32
const HOUR = 3_600_000
const DAY = 86_400_000

/** The window's days for a `keepPerfDays` (perflog.ts's rule: 1-90, else 14), at most REPORT_DAYS. */
export function reportDays(keepPerfDays: unknown): number {
  const d = Number(keepPerfDays)
  const kept = Number.isFinite(d) && d >= 1 ? Math.min(90, Math.round(d)) : 14
  return Math.min(REPORT_DAYS, kept)
}

// ---- PerfReport v1 ------------------------------------------------------------------------------------------------

export type SectionStatus = 'ok' | 'missing' | 'unreadable' | 'partial'

/** The Mac (#27), from a profile's `host` and `displays` only: never the GPU's renderer string, a display's id or colour space. */
export interface MacRow {
  /** the first and the last line in the window naming a profile this row came from (two profiles alike give one row) */
  from: number
  to: number
  chip?: string
  cores?: { total?: number; p?: number | 'unknown' | 'other'; e?: number | 'unknown' | 'other' }
  memGB?: number
  model?: string
  macos?: string
  /** Electron's `scaleFactor` and `displayFrequency` (the profile's `hz`); a headless profile has none */
  displays: { scaleFactor?: number; displayFrequency?: number }[]
}
export interface MacSection {
  status: SectionStatus
  /** named profiles that could not be read or parsed */
  unparsed: number
  /** named profiles with no file */
  absent: number
  /** named profiles past REPORT_PROFILES_MAX, not read */
  cut: number
  /** the most recently named first */
  rows: MacRow[]
}

/**
 * One UTC hour of `sample` lines (r2 #4, r3 #5), each a minute the recorder folded with `SampleBody.own`. `ownCpu` is
 * observed CPU, in cores, over the seconds fully measured (Σ s / (Σ ms / 1000)); `ownCpuMaxMinute` the highest
 * minute's s over its ms; `measuredS` and `unmeasuredS` say how much was measured, so an unmeasured stretch is
 * unknown, never idle. `ownRssMB`: the minutes' `mean` weighted by their `n`, and the max of their `max`. A line from
 * before `own` gives neither figure and counts in `minutesMissing`. `canvasMemMB`: the max of `canvases.memMB.max`;
 * `gpuRssMB`: the max of `gpu.gpuProcessRssMB.max`; `pressureMax`: the highest level; `thermalWorst`: the worst
 * state (`unknown` with none known); `minutes`: the lines.
 */
export interface HourRow {
  hour: number
  minutes: number
  minutesMissing: number
  ownCpu: number | null
  ownCpuMaxMinute: number | null
  measuredS: number
  unmeasuredS: number
  ownRssMB: { mean: number | null; max: number | null }
  canvasMemMB: number | null
  gpuRssMB: number | null
  pressureMax: PressureLevel | null
  thermalWorst: ThermalState
}
export interface SamplesSection { status: SectionStatus; unparsed: number; lines: number; rows: HourRow[] }

/** `shown` folded to each UTC day (#27): how many, and the 50th and 95th percentiles by nearest rank. */
export interface ShownDay { day: number; n: number; p50Ms: number; p95Ms: number }
export interface ShownSection { status: SectionStatus; unparsed: number; lines: number; days: ShownDay[] }

/** An exported event: its time, its kind and its projection (`PROJECTIONS`), in that order. */
export type ReportEvent = { ts: number; kind: ExportedKind } & Record<string, unknown>
export interface EventsSection {
  status: SectionStatus
  unparsed: number
  /** lines of a kind this app does not know: counted, never exported */
  unknown: number
  /** events past REPORT_EVENTS_MAX or the 2 MB bound, the oldest */
  cut: number
  /** lines in the window by kind (`sample`, `shown` and `tab` included), in APP_KINDS order */
  counts: Partial<Record<AppKind, number>>
  /** newest first */
  list: ReportEvent[]
}

/** Crashpad's reports in the window, by their file's time (#26): counts only, never a name, a path or a dump. */
export interface CrashpadSection { status: SectionStatus; completed: number; pending: number }

export interface PerfReport {
  v: 1
  /** when it was made */
  made: number
  /** the running app's version, Electron's and macOS's (ruled as the records' are) */
  version: string
  electron: string
  macos: string
  flavour: Flavour
  /** the window */
  start: number
  end: number
  mac: MacSection
  samples: SamplesSection
  shown: ShownSection
  events: EventsSection
  crashpad: CrashpadSection
}

// ---- value rules (#27) --------------------------------------------------------------------------------------------

/** A rule: the value as it may leave, or undefined to drop it. */
export type Rule = (v: unknown) => unknown
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** a string: kept when `ok`, else `other`; any other type dropped */
const str = (ok: (s: string) => boolean): Rule => (v) => (typeof v === 'string' ? (ok(v) ? v : 'other') : undefined)
/** one of a set */
export const oneOf = (list: readonly string[]): Rule => { const s = new Set(list); return str((v) => s.has(v)) }
/** a pattern, at most REPORT_STRING_MAX characters */
export const matches = (re: RegExp): Rule => str((v) => v.length <= REPORT_STRING_MAX && re.test(v))
/** a finite number; null kept (the record's unknown) */
export const num: Rule = (v) => (v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined)
export const bool: Rule = (v) => (typeof v === 'boolean' ? v : undefined)
/** a pressure level: 1, 2 or 4, null kept */
export const level: Rule = (v) => (v === 1 || v === 2 || v === 4 || v === null ? v : undefined)
/** a number or the record's own word `unknown` (AGX readings, a profile's cores) */
export const numOrUnknown: Rule = (v) => (typeof v === 'string' ? (v === 'unknown' ? v : 'other') : num(v))
/** a rule that also admits the profile's `unknown` */
const orUnknown = (r: Rule): Rule => (v) => (v === 'unknown' ? v : r(v))

/** A3's renderer roles (`Role`). */
export const ROLES = ['canvas', 'strip', 'home', 'settings', 'tabpage', 'cover', 'mixed', 'none', 'unknown'] as const
const rolesExact: Exact<(typeof ROLES)[number], Role> = true
/** `ThermalState`, best to worst after `unknown`. */
export const THERMAL = ['unknown', 'nominal', 'fair', 'serious', 'critical'] as const
const thermalExact: Exact<(typeof THERMAL)[number], ThermalState> = true
/** Electron 45's `RenderProcessGoneDetails.reason`, also `child-process-gone`'s. */
export const GONE_REASONS = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'] as const
/** Electron 45's `child-process-gone` `type`. */
export const CHILD_TYPES = ['Utility', 'Zygote', 'Sandbox helper', 'GPU', 'Pepper Plugin', 'Pepper Plugin Broker', 'Unknown'] as const
/** `main-error.name` (errors.ts keeps any text up to 100 characters): JavaScript's own error names only. */
export const ERROR_NAMES = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError'] as const
/**
 * `getGPUFeatureStatus()`'s keys in Electron 45 (`gpu.featureStatus`): its typings' (`GPUFeatureStatus`) and the
 * names Chromium 142's `compositor_util.cc` sets, read from Electron 45.0.0's framework binary (2 Nov 2026). Any other
 * key is dropped.
 */
export const GPU_FEATURES = [
  '2d_canvas', 'direct_rendering_display_compositor', 'flash_3d', 'flash_stage3d', 'flash_stage3d_baseline', 'gpu_compositing',
  'multiple_raster_threads', 'native_gpu_memory_buffers', 'opengl', 'rasterization', 'raw_draw', 'skia_graphite', 'trees_in_viz',
  'video_decode', 'video_encode', 'vpx_decode', 'vulkan', 'webgl', 'webgl2', 'webgpu', 'webnn',
] as const
/** Electron's documented status words (`gpu-feature-status`); any other value is `unknown`. */
export const GPU_STATUS = [
  'disabled_software', 'disabled_off', 'disabled_off_ok', 'unavailable_software', 'unavailable_off', 'unavailable_off_ok',
  'enabled_readback', 'enabled_force', 'enabled', 'enabled_on', 'enabled_force_on',
] as const
/** tabs.ts's `UnloadRefusal` (an app type: unit `report.test` holds the two equal). */
export const UNLOAD_REFUSALS = ['not-canvas', 'active', 'no-document', 'replacing', 'sweeping', 'no-bridge', 'unknown'] as const
export const UNLOAD_REASONS = ['warn', 'critical', 'half-ram'] as const
export const UNLOAD_PHASES = ['start', 'unsure', 'done', 'forced', 'refused'] as const
export const POWER_EVENTS = ['on-ac', 'on-battery', 'suspend', 'resume', 'thermal-state-change', 'speed-limit-change'] as const
export const COVER_CAUSES = ['doc', 'size', 'show', 'fullscreen', 'hello', 'resize', 'gpu'] as const
export const COVER_OUTCOMES = ['uncovered', 'mismatch', 'superseded', 'never'] as const
export const UPDATE_PHASES = ['blocked', 'check', 'current', 'downloading', 'downloaded', 'error', 'late', 'slow', 'restart',
  'restart-failed', 'installed', 'install-failed', 'move'] as const
const phasesExact: Exact<(typeof UPDATE_PHASES)[number], UpdateBody['phase']> = true
/**
 * `update.why` (#25): a block's (update-model.ts `BlockedWhy`), a late event's (the updater's event names and
 * `throw`) and a move's (UPDATE_MOVE_WHY). A why the restart stream adds is `other` until it is listed here.
 */
export const UPDATE_WHY = ['feed', 'location', 'write', 'setup', 'throw', 'error', 'checking-for-update', 'update-available',
  'update-not-available', 'update-downloaded', ...UPDATE_MOVE_WHY] as const
void rolesExact; void thermalExact; void phasesExact

/** A Mac's chip (#27). */
export const CHIP = /^Apple M\d+( Pro| Max| Ultra)?$/
/** A Mac's model identifier, e.g. `Mac15,9`. */
export const MODEL = /^[A-Za-z]+\d+,\d+$/
export const MACOS = /^\d+(\.\d+){0,2}$/
export const APP_VERSION = /^\d+\.\d+\.\d+$/
/** Electron's and Chrome's versions */
export const CHROMIUM_VERSION = /^\d+(\.\d+){1,3}$/
/** main's opaque tab id (tabs.ts: `t` and a base-36 counter), or Home's and Settings' own */
export const TAB = /^(t[0-9a-z]{1,12}|home|settings)$/

const role = oneOf(ROLES)
const thermal = oneOf(THERMAL)
const goneReason = oneOf(GONE_REASONS)
const tab = matches(TAB)
const appVersion = matches(APP_VERSION)
const chromium = matches(CHROMIUM_VERSION)
const unloadReason = oneOf(UNLOAD_REASONS)

/** `gpu.featureStatus` (#27): only Electron 45's keys, each value a documented word or `unknown`. */
const STATUS = new Set<string>(GPU_STATUS)
export const featureStatus: Rule = (v) => {
  if (!isObj(v)) return undefined
  const out: Record<string, string> = {}
  for (const k of GPU_FEATURES) if (Object.hasOwn(v, k)) out[k] = typeof v[k] === 'string' && STATUS.has(v[k] as string) ? (v[k] as string) : 'unknown'
  return out
}

// ---- projections (#27) --------------------------------------------------------------------------------------------

/** A field of a projection: its name out, and how it is read from the record's body. */
export type Field = readonly [string, (body: Record<string, unknown>) => unknown]
/** a field read from the body's own field of that name, through `rule` */
const f = (key: string, rule: Rule): Field => [key, (b) => rule(b[key])]
/** a nested object, field by field */
const nested = (fields: readonly Field[]): Rule => (v) => (isObj(v) ? project(fields, v) : undefined)
/** Every record about a tab keeps only `tab` (#27). */
const TAB_FIELD = f('tab', tab)

/** An AGX reading's numbers (`agx`, and a flash's and a white-out candidate's), never `machineWide`. */
const AGX: readonly Field[] = ['gpuSystemMemoryMB', 'allocMB', 'utilPct', 'rendererPct', 'tilerPct', 'recoveryCount'].map((k) => f(k, numOrUnknown))
/** An unload's before and after: the level, availablePct, the canvases' memory, the tab's memMB (never its pids), the GPU process's RSS. */
const FIGURES: readonly Field[] = [f('level', level), f('availablePct', num), f('canvasMB', num), f('tab', nested([f('memMB', num)])), f('gpuProcessRssMB', num)]

/** The kinds exported one by one; `sample` and `shown` are folded, `tab` counted. */
export type ExportedKind = Exclude<AppKind, 'sample' | 'shown' | 'tab'>
export const FOLDED_KINDS = ['sample', 'shown'] as const
export const COUNTED_KINDS = ['tab'] as const

/** Each kind's projection, field by field (#27): what a record may carry out, in this order after `ts` and `kind`. */
export const PROJECTIONS: { readonly [K in ExportedKind]: readonly Field[] } = {
  start: [f('version', appVersion), f('electron', chromium), f('recorder', bool)],
  agx: AGX,
  gone: [TAB_FIELD, f('role', role), f('reason', goneReason), f('exitCode', num), f('ours', bool), f('source', oneOf(['unload', 'reload-page'])), f('pressure', level)],
  'child-gone': [f('type', oneOf(CHILD_TYPES)), f('reason', goneReason), f('exitCode', num)],
  // its time alone
  'gpu-restart': [],
  unresponsive: [TAB_FIELD, f('role', role)],
  responsive: [TAB_FIELD, f('role', role)],
  gpu: [f('featureStatus', featureStatus)],
  power: [f('event', oneOf(POWER_EVENTS)), f('thermal', thermal)],
  pressure: [f('level', level), f('availablePct', num)],
  unload: [TAB_FIELD, f('phase', oneOf(UNLOAD_PHASES)), f('reason', unloadReason)],
  'unload-skip': [TAB_FIELD, f('reason', unloadReason), f('why', oneOf(UNLOAD_REFUSALS))],
  'unload-effect': [TAB_FIELD, f('reason', unloadReason), f('before', nested(FIGURES)), f('after', nested(FIGURES)), f('pidGone', bool)],
  reopen: [TAB_FIELD, f('activateToLiftMs', num), f('unloadedForMs', num)],
  cover: [TAB_FIELD, f('cause', oneOf(COVER_CAUSES)), f('outcome', oneOf(COVER_OUTCOMES)), f('sentMs', num), f('answeredMs', num),
    f('uncoveredMs', num), f('hiddenMs', num), f('uncoverDelayMs', num), f('frames', num)],
  // the pressure's level alone; whether a picture exists, never its path (nor `pictureWhy`, the ring, `now` or the id)
  flash: [TAB_FIELD, f('via', oneOf(['key', 'menu'])), f('recorder', bool), f('thermal', thermal),
    ['pressure', (b) => (b.pressure === null ? null : isObj(b.pressure) ? level(b.pressure.level) : undefined)],
    f('agx', nested(AGX)),
    ['picture', (b) => (typeof b.picture === 'string' ? true : b.picture === null ? false : undefined)]],
  'whiteout-candidate': [TAB_FIELD, f('rateHz', num), f('samples', num), f('skipped', num), f('inconclusive', num), f('agx', nested(AGX))],
  dropped: [f('n', num)],
  'main-error': [f('what', oneOf(['exception', 'rejection'])), f('name', oneOf(ERROR_NAMES))],
  // never `message` (the updater's error text) nor `attempt`
  update: [f('phase', oneOf(UPDATE_PHASES)), f('version', appVersion), f('from', appVersion), f('to', appVersion), f('why', oneOf(UPDATE_WHY)), f('manual', bool)],
}

/** A body through its fields: only what they give (undefined dropped), in their order. */
export function project(fields: readonly Field[], body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, read] of fields) {
    const v = read(body)
    if (v !== undefined) out[k] = v
  }
  return out
}

/** One record as it may leave (#27): `ts`, `kind`, its projection; null for a kind that is folded, counted or unknown. */
export function projectRecord(kind: string, ts: number, body: Record<string, unknown>): ReportEvent | null {
  if (!Object.hasOwn(PROJECTIONS, kind)) return null
  const k = kind as ExportedKind
  return { ts, kind: k, ...project(PROJECTIONS[k], body) }
}

/** The Mac (#27): a profile's host and displays through their rules; null for something that is no profile. */
export function projectMac(p: unknown): Omit<MacRow, 'from' | 'to'> | null {
  if (!isObj(p) || p.v !== 1 || (p.kind !== 'app' && p.kind !== 'headless') || !isObj(p.host)) return null
  const host = p.host
  const out = project([
    f('chip', orUnknown(matches(CHIP))),
    f('cores', nested([f('total', num), f('p', numOrUnknown), f('e', numOrUnknown)])),
    f('memGB', num),
    f('model', orUnknown(matches(MODEL))),
    ['macos', (h) => orUnknown(matches(MACOS))(h.os)],
  ], host)
  const displays = p.kind === 'app' && Array.isArray(p.displays)
    ? p.displays.filter(isObj).slice(0, REPORT_DISPLAYS_MAX).map((d) => project([f('scaleFactor', num), ['displayFrequency', (x) => num(x.hz)]], d))
    : []
  return { ...out, displays } as Omit<MacRow, 'from' | 'to'>
}

// ---- the line -----------------------------------------------------------------------------------------------------

const KNOWN = new Set<string>(APP_KINDS)
const TS = /^\{"v":1,"ts":(\d{10,16})[,}]/
const KIND = /"kind":"([a-z-]{1,32})"/
const isSeq = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0

/**
 * One line's envelope (parseAppLine's checks, A3.5), telling an unknown kind from a line that does not parse: `skip`
 * for a line outside the window, `bad` for one that does not parse, `unknown` for a well-formed line of a kind this
 * app does not know.
 */
export function readEnvelope(line: string, start: number, end: number):
  | { at: 'skip' } | { at: 'bad'; kind: string | null } | { at: 'unknown' }
  | { at: 'ok'; ts: number; kind: AppKind; machine: string | null; body: Record<string, unknown> } {
  // the envelope comes first in every line the writer makes: a line outside the window is skipped unparsed
  const m = TS.exec(line)
  if (m) { const ts = Number(m[1]); if (ts < start || ts > end) return { at: 'skip' } }
  const bad = () => ({ at: 'bad' as const, kind: KIND.exec(line)?.[1] ?? null })
  let o: unknown
  try { o = JSON.parse(line) } catch { return bad() }
  if (!isObj(o) || o.v !== 1 || typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return bad()
  if (typeof o.app !== 'string' || !/^[0-9a-f]{12}$/.test(o.app) || !isSeq(o.seq)) return bad()
  if (o.flavour !== 'release' && o.flavour !== 'dev') return bad()
  if (o.machine !== null && (typeof o.machine !== 'string' || !/^[0-9a-f]{16}$/.test(o.machine))) return bad()
  if (typeof o.kind !== 'string') return bad()
  if (o.ts < start || o.ts > end) return { at: 'skip' }
  if (!KNOWN.has(o.kind)) return { at: 'unknown' }
  return { at: 'ok', ts: o.ts, kind: o.kind as AppKind, machine: o.machine as string | null, body: o }
}

// ---- the aggregations (#27) ---------------------------------------------------------------------------------------

const r1 = (v: number): number => Math.round(v * 10) / 10
const r3 = (v: number): number => Math.round(v * 1000) / 1000
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const finNonNeg = (v: unknown): v is number => fin(v) && v >= 0
const maxOf = (a: number | null, b: number): number => (a === null ? b : Math.max(a, b))
const THERMAL_RANK: Record<string, number> = { nominal: 1, fair: 2, serious: 3, critical: 4 }

interface HourAcc {
  minutes: number; missing: number; s: number; ms: number; unmeasuredMs: number; maxMinute: number | null
  rssSum: number; rssN: number; rssMax: number | null; canvas: number | null; gpu: number | null; pressure: PressureLevel | null; thermal: number
}
const newHour = (): HourAcc => ({ minutes: 0, missing: 0, s: 0, ms: 0, unmeasuredMs: 0, maxMinute: null, rssSum: 0, rssN: 0, rssMax: null, canvas: null, gpu: null, pressure: null, thermal: 0 })

/** `own.cpu` as the recorder folds it: three finite figures, none negative, or none at all. */
function ownCpuOf(own: unknown): { s: number; ms: number; unmeasuredMs: number } | null {
  if (!isObj(own) || !isObj(own.cpu)) return null
  const { s, ms, unmeasuredMs } = own.cpu
  return finNonNeg(s) && finNonNeg(ms) && finNonNeg(unmeasuredMs) ? { s, ms, unmeasuredMs } : null
}
const aggMax = (v: unknown): number | null => (isObj(v) && finNonNeg(v.max) ? v.max : null)

/** One `sample` line into its hour (r2 #4, r3 #5): never ownership from the per-process list. */
function foldSample(h: HourAcc, b: Record<string, unknown>): void {
  h.minutes += 1
  const cpu = ownCpuOf(b.own)
  if (!cpu) h.missing += 1
  else {
    h.s += cpu.s
    h.ms += cpu.ms
    h.unmeasuredMs += cpu.unmeasuredMs
    if (cpu.ms > 0) h.maxMinute = maxOf(h.maxMinute, cpu.s / (cpu.ms / 1000))
    const rss = (b.own as { rssMB?: unknown }).rssMB
    if (isObj(rss)) {
      if (finNonNeg(rss.mean) && fin(b.n) && Number.isInteger(b.n) && b.n > 0) { h.rssSum += rss.mean * b.n; h.rssN += b.n }
      if (finNonNeg(rss.max)) h.rssMax = maxOf(h.rssMax, rss.max)
    }
  }
  const canvas = isObj(b.canvases) ? aggMax(b.canvases.memMB) : null
  if (canvas !== null) h.canvas = maxOf(h.canvas, canvas)
  const gpu = isObj(b.gpu) ? aggMax(b.gpu.gpuProcessRssMB) : null
  if (gpu !== null) h.gpu = maxOf(h.gpu, gpu)
  const p = isObj(b.pressure) ? b.pressure.max : null
  if (p === 1 || p === 2 || p === 4) h.pressure = h.pressure === null ? p : (Math.max(h.pressure, p) as PressureLevel)
  const t = typeof b.thermal === 'string' ? THERMAL_RANK[b.thermal] ?? 0 : 0
  if (t > h.thermal) h.thermal = t
}

function hourRow(hour: number, h: HourAcc): HourRow {
  return {
    hour,
    minutes: h.minutes,
    minutesMissing: h.missing,
    ownCpu: h.ms > 0 ? r3(h.s / (h.ms / 1000)) : null,
    ownCpuMaxMinute: h.maxMinute === null ? null : r3(h.maxMinute),
    measuredS: r1(h.ms / 1000),
    unmeasuredS: r1(h.unmeasuredMs / 1000),
    ownRssMB: { mean: h.rssN > 0 ? r1(h.rssSum / h.rssN) : null, max: h.rssMax === null ? null : r1(h.rssMax) },
    canvasMemMB: h.canvas === null ? null : r1(h.canvas),
    gpuRssMB: h.gpu === null ? null : r1(h.gpu),
    pressureMax: h.pressure,
    thermalWorst: (['unknown', 'nominal', 'fair', 'serious', 'critical'] as const)[h.thermal]!,
  }
}

/** The nearest-rank percentile of sorted values. */
export const nearestRank = (sorted: readonly number[], p: number): number => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!

/** How the log read: whole, missing, unreadable, or stopped by an error after some lines. */
export type LogRead = 'ok' | 'missing' | 'unreadable' | 'stopped'
/** A named profile as read: its parsed JSON, absent (no file), or unreadable (it could not be read or parsed as JSON). */
export type ProfileRead = { json: unknown } | 'absent' | 'unreadable'

interface Held { ts: number; i: number; ev: ReportEvent }
/** newest first; the later line first at a tie */
const newestFirst = (a: Held, b: Held): number => b.ts - a.ts || b.i - a.i

/**
 * The report folded line by line (#26): bounded whatever the log holds - at most 2 x REPORT_EVENTS_MAX events held,
 * one accumulator per hour and a list of `shown` times per day in the window, the profiles named.
 */
export class ReportFold {
  private i = 0
  private held: Held[] = []
  private cut = 0
  private counts = new Map<AppKind, number>()
  private unknown = 0
  private unparsed = { samples: 0, shown: 0, events: 0 }
  private hours = new Map<number, HourAcc>()
  private shownDays = new Map<number, number[]>()
  private named = new Map<string, { from: number; to: number }>()
  private namedCut = 0
  private profiles = new Map<string, ProfileRead>()

  constructor(readonly start: number, readonly end: number) {}

  /** One line of the log. */
  line(text: string): void {
    if (!text) return
    const e = readEnvelope(text, this.start, this.end)
    if (e.at === 'skip') return
    if (e.at === 'bad') { this.unparsed[e.kind === 'sample' ? 'samples' : e.kind === 'shown' ? 'shown' : 'events'] += 1; return }
    if (e.at === 'unknown') { this.unknown += 1; return }
    this.counts.set(e.kind, (this.counts.get(e.kind) ?? 0) + 1)
    if (e.machine) this.name(e.machine, e.ts)
    if (e.kind === 'sample') {
      const hour = Math.floor(e.ts / HOUR) * HOUR
      let h = this.hours.get(hour)
      if (!h) this.hours.set(hour, h = newHour())
      foldSample(h, e.body)
      return
    }
    if (e.kind === 'shown') {
      if (!finNonNeg(e.body.ms)) return
      const day = Math.floor(e.ts / DAY) * DAY
      let d = this.shownDays.get(day)
      if (!d) this.shownDays.set(day, d = [])
      d.push(e.body.ms)
      return
    }
    const ev = projectRecord(e.kind, e.ts, e.body)
    if (!ev) return
    this.held.push({ ts: e.ts, i: this.i++, ev })
    if (this.held.length > 2 * REPORT_EVENTS_MAX) this.trim()
  }

  private trim(): void {
    this.held.sort(newestFirst)
    this.cut += Math.max(0, this.held.length - REPORT_EVENTS_MAX)
    this.held.length = Math.min(this.held.length, REPORT_EVENTS_MAX)
  }

  private name(hash: string, ts: number): void {
    const n = this.named.get(hash)
    if (n) { n.from = Math.min(n.from, ts); n.to = Math.max(n.to, ts); return }
    // bounded: a log naming more profiles than any Mac makes keeps the first thousand
    if (this.named.size >= 1000) { this.namedCut += 1; return }
    this.named.set(hash, { from: ts, to: ts })
  }

  /** The profiles to read: those the window's lines name, the most recently named first, at most REPORT_PROFILES_MAX. */
  wanted(): string[] {
    return [...this.named].sort((a, b) => b[1].to - a[1].to || (a[0] < b[0] ? -1 : 1)).slice(0, REPORT_PROFILES_MAX).map(([h]) => h)
  }

  /** A named profile, as report.ts read it. */
  profile(hash: string, p: ProfileRead): void { if (this.named.has(hash)) this.profiles.set(hash, p) }

  /** The report, and its bytes (pretty-printed, at most REPORT_MAX_BYTES). Throws only if no cut can bring it under. */
  finish(h: { made: number; version: unknown; electron: unknown; macos: unknown; flavour: Flavour; log: LogRead; crashpad: CrashpadSection }): { report: PerfReport; json: string } {
    const word = (r: Rule, v: unknown): string => { const x = r(v); return typeof x === 'string' ? x : 'other' }
    const head = {
      v: 1 as const, made: h.made,
      version: word(appVersion, h.version), electron: word(chromium, h.electron), macos: word(matches(MACOS), h.macos),
      flavour: h.flavour, start: this.start, end: this.end,
    }
    const status = (unparsed: number, cut = 0): SectionStatus => h.log === 'missing' ? 'missing' : h.log === 'unreadable' ? 'unreadable'
      : h.log === 'stopped' || unparsed > 0 || cut > 0 ? 'partial' : 'ok'

    // the Mac: each named profile read, projected, alike ones joined
    const rows = new Map<string, MacRow>()
    let absent = 0, badProfiles = 0
    const wanted = this.wanted()
    for (const hash of wanted) {
      const p = this.profiles.get(hash) ?? 'absent'
      const span = this.named.get(hash)!
      if (p === 'absent') { absent += 1; continue }
      const mac = p === 'unreadable' ? null : projectMac(p.json)
      if (!mac) { badProfiles += 1; continue }
      const key = JSON.stringify(mac)
      const row = rows.get(key)
      if (row) { row.from = Math.min(row.from, span.from); row.to = Math.max(row.to, span.to) } else rows.set(key, { from: span.from, to: span.to, ...mac })
    }
    const macCut = this.named.size - wanted.length + this.namedCut
    const macRows = [...rows.values()].sort((a, b) => b.to - a.to || a.from - b.from)
    const macStatus: SectionStatus = this.named.size === 0 && this.namedCut === 0 ? (h.log === 'unreadable' ? 'unreadable' : 'missing')
      : macRows.length === 0 ? (badProfiles > 0 ? 'unreadable' : 'missing')
        : badProfiles + absent + macCut > 0 || h.log !== 'ok' ? 'partial' : 'ok'

    const hourRows = [...this.hours].sort((a, b) => b[0] - a[0]).map(([hour, acc]) => hourRow(hour, acc))
    const days = [...this.shownDays].sort((a, b) => b[0] - a[0]).map(([day, ms]): ShownDay => {
      const s = [...ms].sort((a, b) => a - b)
      return { day, n: s.length, p50Ms: r1(nearestRank(s, 50)), p95Ms: r1(nearestRank(s, 95)) }
    })
    const counts: Partial<Record<AppKind, number>> = {}
    for (const k of APP_KINDS) { const n = this.counts.get(k); if (n) counts[k] = n }

    this.trim()
    let list = this.held.map((x) => x.ev)
    let cut = this.cut
    const build = (): PerfReport => ({
      ...head,
      mac: { status: macStatus, unparsed: badProfiles, absent, cut: macCut, rows: macRows },
      samples: { status: status(this.unparsed.samples), unparsed: this.unparsed.samples, lines: this.counts.get('sample') ?? 0, rows: hourRows },
      shown: { status: status(this.unparsed.shown), unparsed: this.unparsed.shown, lines: this.counts.get('shown') ?? 0, days },
      events: { status: status(this.unparsed.events, cut + this.unknown), unparsed: this.unparsed.events, unknown: this.unknown, cut, counts, list },
      crashpad: h.crashpad,
    })
    let report = build()
    let json = JSON.stringify(report, null, 2) + '\n'
    // the 2 MB bound: the oldest events go, a tenth at a time, counted
    while (Buffer.byteLength(json) > REPORT_MAX_BYTES) {
      if (!list.length) throw new Error('the report is over its bound with no event left to cut')
      const n = Math.max(1, Math.ceil(list.length / 10))
      list = list.slice(0, list.length - n)
      cut += n
      report = build()
      json = JSON.stringify(report, null, 2) + '\n'
    }
    return { report, json }
  }
}
