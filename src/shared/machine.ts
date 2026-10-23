/**
 * The machine profiles (spec 28 A3.2, A3.8 #11): what this Mac is, written once per distinct profile to
 * `~/.marver/perf/machine/<hash>.json`, so old records keep pointing at the profile they were taken on. Two kinds
 * share one host part and its hash: the app's (`app/src/main/machine.ts`, the recorder stream) and a headless
 * run's (`src/server/machine-host.ts`, the headless stream), so runs and app records of one Mac meet by `hostHash`.
 *
 * FROZEN before the A3 streams split (A3.8 #53). Types and the canonical form only - no imports: each writer hashes
 * with its own `node:crypto` as `sha256(canonical(profile)).slice(0, 16)` (16 hex). Profiles are immutable,
 * content-addressed (a temp file written with `wx`, then renamed; an existing one only touched). Thermal state and
 * the speed limit are not in a profile (they go in samples); `lowPowerMode` is 'unknown' until spike S2.2.
 */

export type Unknown = 'unknown'

/** The host: what a headless run can know too. */
export interface HostProfile {
  /** os.cpus()[0].model, e.g. "Apple M3 Max" */
  chip: string | Unknown
  cores: { total: number; p: number | Unknown; e: number | Unknown }
  /** e.g. "Mac15,9" */
  model: string | Unknown
  /** os.totalmem() in GiB, rounded */
  memGB: number
  /** sw_vers -productVersion, e.g. "26.6.2" */
  os: string | Unknown
  arch: string
}

export interface DisplayProfile {
  internal: boolean
  sizeDip: [number, number]
  scaleFactor: number
  pixels: [number, number]
  hz: number
  colorSpace: string
}

/** The app's profile (A3.2): the host, plus Electron's view of the GPU and the displays. */
export interface AppProfile {
  v: 1
  kind: 'app'
  host: HostProfile
  hostHash: string
  electron: string
  chrome: string
  gpu: {
    renderer: string | Unknown
    backend: string | Unknown
    vendorId: number | Unknown
    gpuCores: number | Unknown
    /** getGPUFeatureStatus(), as reported */
    featureStatus: Record<string, string> | Unknown
  }
  /** sorted by display id */
  displays: DisplayProfile[]
  /** research b §1's formula, for the window's display */
  tileBudgetMB: number | Unknown
  power: { source: 'ac' | 'battery'; lowPowerMode: Unknown }
}

/** A headless run's host profile (machine-host.ts): its own file, sharing `hostHash` with the app's. */
export interface HeadlessProfile {
  v: 1
  kind: 'headless'
  host: HostProfile
  hostHash: string
  power: 'ac' | 'battery' | Unknown
}

export type MachineProfile = AppProfile | HeadlessProfile

/** The hash's length in hex. */
export const PROFILE_HASH_HEX = 16

/**
 * Canonical JSON: object keys sorted at every depth, arrays in order, no whitespace; `undefined` members dropped as
 * JSON.stringify drops them. Two equal profiles give the same text whatever order their fields were built in.
 */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    const s = JSON.stringify(v)
    return s === undefined ? 'null' : s
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined || typeof x === 'function' ? 'null' : canonical(x))).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== 'function').sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}
