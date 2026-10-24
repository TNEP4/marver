/**
 * This Mac's profile (spec 28 A3.2, A3.8 #11) and the machine-wide GPU figures (A3.1). Owner: the recorder stream.
 *
 * At launch and on display, power or GPU feature changes (debounced 1 s) - and when the window moves to another
 * display (its tile budget is that display's) - the app's profile is collected - under 50 ms of main-thread work (a
 * test), every spawn `execFile` with an absolute path - and written to `<MARVER_HOME>/perf/machine/<hash>.json`
 * (700/600, a `wx` temp file renamed; an existing one only touched, and written again if it went meanwhile).
 * `getGPUInfo('complete')` is waited for 2 s at most, then the profile is written with 'unknown' where it lacks; a
 * late answer makes a new profile and hash, the stamp from then on. Lines at launch wait for the first hash 3 s at
 * most, then say `machine: null`; a hash stamps lines (`stampHash`) only once its file is written, or its write
 * failed and said so, so no line names a file that is not there. The host part and its hash are the headless run's
 * too (src/shared/machine.ts).
 *
 * The host is read through `readHost` (src/shared/machine.ts), the one function a headless run reads it with
 * (machine-host.ts `hostProfile`): its floor (`basicHost()`, os.cpus() and os.totalmem()) and its two spawns
 * (`sysctl -n hw.perflevel0.physicalcpu hw.perflevel1.physicalcpu hw.model`, `sw_vers -productVersion`), each tried
 * once more when it fails, so the two meet by `hostHash` (test/unit/host-meets.test.ts): the model is `hw.model`, not
 * Electron's machineModelName (design §3.3 had it the other way round; one source keeps the hashes equal).
 *
 * "Under 50 ms of main-thread work" counts every step a collection runs on main, not the profile's build alone: the
 * host's floor, each spawn's start and its answer's callback, the GPU asks and the build (`machineStats().parts`).
 *
 * FROZEN signatures (A3.8 #53).
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, stat, utimes } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { app, powerMonitor, screen, type BaseWindow, type Display } from 'electron'
import type { AgxReading } from '../../../src/shared/app-perf.ts'
import { canonical, PROFILE_HASH_HEX, readHost, type AppProfile, type DisplayProfile, type HostProfile } from '../../../src/shared/machine.ts'
import { basicHost } from '../../../src/server/machine-host.ts'
import type { Home } from './config.ts'
import { writeWhole } from './fsx.ts'
import { note } from './testing/index.ts'
import { T } from './timings.ts'

/** A profile's hash: the same function machine-host.ts uses, so the two kinds meet by `hostHash`. */
export const profileHash = (p: unknown): string => createHash('sha256').update(canonical(p)).digest('hex').slice(0, PROFILE_HASH_HEX)

/** No figure read: what a failed or missing ioreg gives. */
export const AGX_UNKNOWN: AgxReading = { gpuSystemMemoryMB: 'unknown', allocMB: 'unknown', utilPct: 'unknown', rendererPct: 'unknown', tilerPct: 'unknown', recoveryCount: 'unknown', machineWide: true }

export const IOREG = '/usr/sbin/ioreg'
export const IOREG_ARGS = ['-rc', 'AGXAccelerator', '-d1'] as const

// ---- the parsers (pure) -----------------------------------------------------------------------------------------

const MB = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10
/** `"key"=<integer>` inside ioreg's dictionaries; the key matched exactly, so `"In use system memory (driver)"` is not `"In use system memory"`. */
const intOf = (text: string, key: string): number | null => {
  const esc = key.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')
  const m = new RegExp(`"${esc}"\\s*=\\s*(\\d+)`).exec(text)
  if (!m) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) ? n : null
}

/** `ioreg -rc AGXAccelerator -d1`'s text: `"In use system memory"=` matched exactly (the line also holds a `(driver)` key); a missing key 'unknown'. */
export function parseAgx(text: string): AgxReading {
  if (typeof text !== 'string' || !text) return { ...AGX_UNKNOWN }
  const v = (key: string, f: (n: number) => number = (n) => n): number | 'unknown' => { const n = intOf(text, key); return n === null ? 'unknown' : f(n) }
  return {
    gpuSystemMemoryMB: v('In use system memory', MB),
    allocMB: v('Alloc system memory', MB),
    utilPct: v('Device Utilization %'),
    rendererPct: v('Renderer Utilization %'),
    tilerPct: v('Tiler Utilization %'),
    recoveryCount: v('recoveryCount'),
    machineWide: true,
  }
}

/** The GPU's core count from the same text (`"gpu-core-count" = 20`), or 'unknown'. */
export function parseGpuCores(text: string): number | 'unknown' {
  const n = typeof text === 'string' ? intOf(text, 'gpu-core-count') : null
  return n === null || n <= 0 || n > 4096 ? 'unknown' : n
}

/** research b §1: the per-renderer tile budget for the window's display, clamp(1152 x px / (2056 x 1329 x 4), 512, RAM / 4) MB. */
export function tileBudgetMB(pixels: [number, number] | null, totalMemBytes: number): number | 'unknown' {
  if (!pixels || !(pixels[0] > 0) || !(pixels[1] > 0) || !(totalMemBytes > 0)) return 'unknown'
  const raw = (1152 * pixels[0] * pixels[1]) / (2056 * 1329 * 4)
  return Math.round(Math.min(Math.max(raw, 512), totalMemBytes / 2 ** 20 / 4))
}

/** A display as the profile keeps it. */
export function displayProfile(d: Pick<Display, 'internal' | 'size' | 'scaleFactor' | 'displayFrequency' | 'colorSpace'>): DisplayProfile {
  const sf = Number.isFinite(d.scaleFactor) && d.scaleFactor > 0 ? d.scaleFactor : 1
  return {
    internal: !!d.internal,
    sizeDip: [d.size.width, d.size.height],
    scaleFactor: sf,
    pixels: [Math.round(d.size.width * sf), Math.round(d.size.height * sf)],
    hz: Number.isFinite(d.displayFrequency) ? Math.round(d.displayFrequency) : 0,
    colorSpace: typeof d.colorSpace === 'string' ? d.colorSpace : '',
  }
}

export interface ProfileInputs {
  host: HostProfile
  electron: string
  chrome: string
  /** getGPUInfo's answer ('complete' when it came, else 'basic'), or null */
  gpuInfo: unknown
  gpuCores: number | 'unknown'
  featureStatus: Record<string, string> | null
  displays: (Pick<Display, 'id' | 'internal' | 'size' | 'scaleFactor' | 'displayFrequency' | 'colorSpace'>)[]
  /** the display the window is on (its id), or null for the primary one's place (the first) */
  windowDisplay: number | null
  totalMemBytes: number
  onBattery: boolean
}

const str = (v: unknown): string | 'unknown' => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : 'unknown')
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** The app's profile from what was read (pure): every field filled or 'unknown'. */
export function makeProfile(i: ProfileInputs): AppProfile {
  const info = rec(i.gpuInfo)
  const aux = rec(info.auxAttributes)
  const dev0 = rec(Array.isArray(info.gpuDevice) ? info.gpuDevice.find((d) => rec(d).active) ?? info.gpuDevice[0] : undefined)
  const vendor = dev0.vendorId
  const sorted = [...i.displays].sort((a, b) => a.id - b.id)
  const win = sorted.find((d) => d.id === i.windowDisplay) ?? sorted[0]
  const winProfile = win ? displayProfile(win) : null
  const fs = i.featureStatus && Object.keys(i.featureStatus).length
    ? Object.fromEntries(Object.entries(i.featureStatus).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v)]))
    : 'unknown' as const
  return {
    v: 1, kind: 'app',
    host: i.host,
    hostHash: profileHash(i.host),
    electron: i.electron || 'unknown',
    chrome: i.chrome || 'unknown',
    gpu: {
      renderer: str(aux.glRenderer ?? info.glRenderer),
      backend: str(aux.skiaBackendType ?? info.skiaBackendType),
      vendorId: typeof vendor === 'number' && Number.isInteger(vendor) ? vendor : 'unknown',
      gpuCores: i.gpuCores,
      featureStatus: fs,
    },
    displays: sorted.map(displayProfile),
    tileBudgetMB: tileBudgetMB(winProfile?.pixels ?? null, i.totalMemBytes),
    power: { source: i.onBattery ? 'battery' : 'ac', lowPowerMode: 'unknown' },
  }
}

// ---- main-thread work, counted (A3.8 #11) ---------------------------------------------------------------------

/** The main-thread ms of the collection under way, by part, since the last one ended. */
let work: Record<string, number> = {}
/** Runs `f` on main and counts its time against the collection under way. */
function onMain<T>(part: string, f: () => T): T {
  const t0 = performance.now()
  try { return f() } finally { work[part] = (work[part] ?? 0) + performance.now() - t0 }
}

// ---- the spawns ---------------------------------------------------------------------------------------------------

/** One spawn's stdout, or null. With `part`, its start and its answer's callback count as the collection's work. */
function run(file: string, args: readonly string[], timeoutMs: number, maxBuffer = 64 * 1024, part?: string): Promise<string | null> {
  const timed = <T>(f: () => T): T => (part ? onMain(part, f) : f())
  return new Promise((resolve) => {
    try {
      timed(() => execFile(file, [...args], { timeout: timeoutMs, encoding: 'utf8', maxBuffer }, (err, stdout) => timed(() => resolve(err ? null : String(stdout)))))
    } catch { resolve(null) }
  })
}

let gpuCores: number | 'unknown' = 'unknown'

/** One ioreg read, `timeoutMs` at most; best effort. With `part`, counted as the collection's work. */
export async function readAgx(timeoutMs: number, part?: string): Promise<AgxReading> {
  const text = await run(IOREG, IOREG_ARGS, timeoutMs, 4 * 1024 * 1024, part)
  if (text === null) return { ...AGX_UNKNOWN }
  const parse = () => {
    const cores = parseGpuCores(text)
    if (cores !== 'unknown') gpuCores = cores
    return parseAgx(text)
  }
  return part ? onMain(part, parse) : parse()
}

/** The host as the app reads it: `readHost` - a headless run's own function - with this file's spawns (counted). */
export function readAppHost(): Promise<HostProfile> {
  return readHost(onMain('host', () => basicHost()), (file, args) => run(file, args, T.spawnTimeoutMs, 64 * 1024, 'spawns'))
}

// ---- the profile in force -----------------------------------------------------------------------------------------

let current: { hash: string; profile: AppProfile } | null = null
let dir: string | null = null
let host: HostProfile | null = null
let gpuInfo: unknown = null
let complete = false
let started = false
let timer: NodeJS.Timeout | null = null
let windowOf: () => BaseWindow | null = () => null
/** the collections so far: why, main-thread ms in all, by part */
let collections: { why: string; ms: number; parts: Record<string, number> }[] = []
/** the hash lines are stamped with, and the collection it came from */
let stamp: string | null = null
let stampGen = 0
let collectGen = 0
const firstWaiters = new Set<(h: string) => void>()
const profileFns = new Set<(hash: string, p: AppProfile) => void>()

/** The profile hash in force now, or null before the first. */
export function currentHash(): string | null { return current?.hash ?? null }

/** The current profile, or null before the first. */
export function currentProfile(): AppProfile | null { return current?.profile ?? null }

/** The file the current profile is in, or null (retention touches it first). */
export function currentFile(): string | null { return current && dir ? join(dir, `${current.hash}.json`) : null }

/** The first hash, waited for `ms` at most (lines at launch, A3.8 #11). */
export function firstHash(ms: number): Promise<string | null> {
  if (current) return Promise.resolve(current.hash)
  return new Promise((resolve) => {
    let done = false
    const fn = (h: string) => { if (!done) { done = true; firstWaiters.delete(fn); clearTimeout(t); resolve(h) } }
    const t = setTimeout(() => { if (!done) { done = true; firstWaiters.delete(fn); resolve(current?.hash ?? null) } }, Math.max(0, ms))
    t.unref?.()
    firstWaiters.add(fn)
  })
}

/** A new profile in force (the recorder's start line waits for the first). */
export function onProfile(fn: (hash: string, p: AppProfile) => void): () => void { profileFns.add(fn); return () => { profileFns.delete(fn) } }

/**
 * The hash lines are stamped with (perflog.ts's hold at launch waits for it): the newest profile whose file is written,
 * or whose write failed and said so on stderr - never one whose file is still being written. Null before the first.
 */
export function stampHash(): string | null { return stamp }

/**
 * Test builds (A3.8 #11: under 50 ms): every collection's main-thread ms - the last (`collectMs`), the launch's
 * (`launchMs`, the host's floor, the spawns' starts and callbacks, the GPU asks and the build), the most any took -
 * and the last one's parts.
 */
export function machineStats(): { collectMs: number; launchMs: number | null; maxMs: number; parts: Record<string, number>; collections: number; complete: boolean; hash: string | null; stamp: string | null } {
  const last = collections.at(-1)
  return {
    collectMs: last?.ms ?? 0,
    launchMs: collections.find((c) => c.why === 'launch')?.ms ?? null,
    maxMs: collections.reduce((n, c) => Math.max(n, c.ms), 0),
    parts: { ...(last?.parts ?? {}) },
    collections: collections.length,
    complete, hash: currentHash(), stamp,
  }
}

/**
 * The profile file: written whole (a temp file, then renamed) when new, else touched - content-addressed, so the two
 * flavours and headless runs may all write it. One that went between the check and the touch (a prune) is written.
 */
export async function writeProfile(machineDir: string, hash: string, profile: unknown): Promise<string> {
  await mkdir(machineDir, { recursive: true, mode: 0o700 })
  if (((await stat(machineDir)).mode & 0o777) !== 0o700) await chmod(machineDir, 0o700)
  const file = join(machineDir, `${hash}.json`)
  const write = () => writeWhole(file, JSON.stringify(profile, null, 2) + '\n', 0o600)
  if (existsSync(file)) {
    const now = new Date()
    await utimes(file, now, now).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return write(); throw err })
  } else {
    await write()
  }
  return file
}

/** A collection's hash stamps lines once its file has settled (written, or failed and said); a newer one wins. */
function settle(gen: number, hash: string): void {
  if (gen <= stampGen) return
  stampGen = gen
  stamp = hash
}

/** One collection: its main-thread work counted, the profile in force if its hash is new. */
function collect(why: string): void {
  const t0 = performance.now()
  let profile: AppProfile
  try {
    const win = windowOf()
    const displays = screen.getAllDisplays()
    let windowDisplay: number | null = null
    try { if (win && !win.isDestroyed()) windowDisplay = screen.getDisplayMatching(win.getBounds()).id } catch { /* the primary's place */ }
    let featureStatus: Record<string, string> | null = null
    try { featureStatus = app.getGPUFeatureStatus() as unknown as Record<string, string> } catch { /* unknown */ }
    profile = makeProfile({
      host: host ?? basicHost(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      gpuInfo, gpuCores, featureStatus, displays, windowDisplay,
      totalMemBytes: totalmem(),
      onBattery: powerMonitor.isOnBatteryPower(),
    })
  } catch (err) {
    process.stderr.write(`marver-app: the machine profile could not be made (${(err as Error).message})\n`)
    return
  }
  const hash = profileHash(profile)
  work.build = (work.build ?? 0) + performance.now() - t0
  const parts = work
  work = {}
  const ms = Object.values(parts).reduce((n, v) => n + v, 0)
  collections.push({ why, ms, parts })
  if (collections.length > 50) collections.splice(1, 1)   // the launch's stays first
  if (__MV_TEST__) note('machine', { why, hash, collectMs: ms, parts, complete })
  if (current?.hash === hash) return
  current = { hash, profile }
  const gen = ++collectGen
  if (dir) {
    void writeProfile(dir, hash, profile).then(() => settle(gen, hash), (err) => {
      process.stderr.write(`marver-app: the machine profile was not written (${(err as Error).message})\n`)
      settle(gen, hash)
    })
  } else settle(gen, hash)
  for (const fn of [...firstWaiters]) fn(hash)
  for (const fn of [...profileFns]) { try { fn(hash, profile) } catch { /* a listener's own */ } }
}

const soon = (why: string) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; collect(why) }, T.profileDebounceMs)
  timer.unref?.()
}

/** getGPUInfo('complete'), and the profile again once it answers. */
function askGpu(): Promise<boolean> {
  let answered = false
  const p = onMain('gpu', () => app.getGPUInfo('complete')).then((info) => onMain('gpu', () => {
    gpuInfo = info
    complete = true
    answered = true
    return true
  }), () => false)
  return Promise.race([p, new Promise<boolean>((r) => { const t = setTimeout(() => r(answered), T.profileGpuWaitMs); t.unref?.() })]).then((inTime) => {
    // a late answer makes a new profile and hash, the stamp from then on (A3.8 #11)
    if (!inTime) void p.then((ok) => { if (ok) collect('gpu-late') })
    return inTime
  })
}

/** At ready, after ensureHome: the first profile, then its watch. */
export function startMachine(o: { home: Home; window(): BaseWindow | null }): void {
  if (started) return
  started = true
  windowOf = o.window
  dir = o.home.writable ? join(o.home.dir, 'perf', 'machine') : null
  // the floor first (main thread), then the spawns and the GPU's answer off it - each step's main-thread part counted
  host = onMain('host', () => basicHost())
  void onMain('gpu', () => app.getGPUInfo('basic')).then((i) => { if (!complete) gpuInfo = i }, () => {})
  const spawns = Promise.all([readAppHost(), readAgx(T.spawnTimeoutMs, 'spawns')]).then(([h]) => { host = h })
  void Promise.all([spawns, askGpu()]).then(() => collect('launch'), () => collect('launch'))

  screen.on('display-added', () => soon('display-added'))
  screen.on('display-removed', () => soon('display-removed'))
  screen.on('display-metrics-changed', (_e, _d, changed) => { if (!changed.every((c) => c === 'workArea')) soon('display-metrics-changed') })
  powerMonitor.on('on-ac', () => soon('on-ac'))
  powerMonitor.on('on-battery', () => soon('on-battery'))
  let asking = false
  app.on('gpu-info-update', () => {
    if (!current || asking) return
    let fs: unknown = null
    try { fs = app.getGPUFeatureStatus() } catch { return }
    if (canonical(fs) === canonical(current.profile.gpu.featureStatus)) return
    // the GPU changed (a software fallback): its answer again, then the profile
    asking = true
    void askGpu().then(() => { asking = false; soon('gpu') })
  })
}

/** The window went to another display (recorder.ts, at its move): a new profile, its tile budget that display's. */
export function windowDisplayChanged(): void { if (started) soon('window-display') }

/** Unit tests: forget the state. */
export function resetMachine(): void {
  current = null; dir = null; host = null; gpuInfo = null; complete = false; started = false; gpuCores = 'unknown'
  collections = []; work = {}; stamp = null; stampGen = 0; collectGen = 0
  if (timer) clearTimeout(timer)
  timer = null
  firstWaiters.clear(); profileFns.clear()
}
