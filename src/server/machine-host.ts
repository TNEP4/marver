/**
 * A headless run's host profile (spec 28 A3.2, A3.8 #11): what this Mac is, as a run can know it without Electron -
 * chip, cores, model, memory, macOS, power - written as its own profile to `~/.marver/perf/machine/<hash>.json`
 * (700/600, content-addressed, as the app writes its own) and carried inline in each run line. Its `hostHash` is the
 * one the app's profile shares (src/shared/machine.ts), so runs and app records of one Mac meet. Owner: the headless
 * stream.
 *
 * FROZEN signatures (A3.8 #53). Every spawn is `execFile` with an absolute path and a 2 s timeout; a failure is
 * 'unknown'; off macOS every field is 'unknown' but `arch`, `memGB` and `chip`.
 */
import { createHash } from 'node:crypto'
import { arch, cpus, totalmem } from 'node:os'
import { canonical, PROFILE_HASH_HEX, type HeadlessProfile, type HostProfile } from '../shared/machine.ts'

/** The profile's hash: the same function the app uses for its own (A3.8 #11). */
export const profileHash = (p: unknown): string => createHash('sha256').update(canonical(p)).digest('hex').slice(0, PROFILE_HASH_HEX)

/** What Node knows with no spawn: the floor every profile starts from. */
export function basicHost(): HostProfile {
  const c = cpus()
  return { chip: c[0]?.model?.trim() || 'unknown', cores: { total: c.length, p: 'unknown', e: 'unknown' }, model: 'unknown', memGB: Math.round(totalmem() / 2 ** 30), os: 'unknown', arch: arch() }
}

/** The host, read: `sysctl -n hw.perflevel0.physicalcpu hw.perflevel1.physicalcpu hw.model`, `sw_vers -productVersion`. */
export async function hostProfile(): Promise<HostProfile> {
  return basicHost()   // A3 headless stream: the spawns
}

/** The run's profile, written to `<MARVER_HOME>/perf/machine/<hash>.json` (or touched when it exists): its hash. */
export async function writeHeadlessProfile(home: string): Promise<{ hash: string; profile: HeadlessProfile }> {
  void home
  const host = await hostProfile()
  const profile: HeadlessProfile = { v: 1, kind: 'headless', host, hostHash: profileHash(host), power: 'unknown' }
  return { hash: profileHash(profile), profile }   // A3 headless stream: `pmset -g ps`, and the write
}
