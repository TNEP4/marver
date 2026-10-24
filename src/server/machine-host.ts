/**
 * A headless run's host profile (spec 28 A3.2, A3.8 #11): what this Mac is, as a run can know it without Electron -
 * chip, cores, model, memory, macOS, power - written as its own profile to `~/.marver/perf/machine/<hash>.json`
 * (700/600, content-addressed, as the app writes its own) and carried inline in each run line. Its `hostHash` is the
 * one the app's profile shares (src/shared/machine.ts), so runs and app records of one Mac meet. Owner: the headless
 * stream.
 *
 * FROZEN signatures (A3.8 #53). Every spawn is `execFile` with an absolute path and a 2 s timeout; a failure is
 * 'unknown'; off macOS every field is 'unknown' but `arch`, `memGB` and `chip`.
 *
 * One reader for both writers (the review of a3-runs, minor #8): the host is `readHost(basicHost(), spawn)` from
 * src/shared/machine.ts - the floor here, the two spawns and their rules there (`withHostSpawns`) - which the app's
 * machine.ts reads its host with too, so the two hash a host alike by construction, not by two copies kept equal.
 * `parseHostSysctl` and `parseOs` read through `withHostSpawns`.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { arch, cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { canonical, PROFILE_HASH_HEX, readHost, withHostSpawns, type HeadlessProfile, type HostProfile } from '../shared/machine.ts'

/** The profile's hash: the same function the app uses for its own (A3.8 #11). */
export const profileHash = (p: unknown): string => createHash('sha256').update(canonical(p)).digest('hex').slice(0, PROFILE_HASH_HEX)

/** What Node knows with no spawn: the floor every profile starts from. */
export function basicHost(): HostProfile {
  const c = cpus()
  return { chip: c[0]?.model?.trim() || 'unknown', cores: { total: c.length, p: 'unknown', e: 'unknown' }, model: 'unknown', memGB: Math.round(totalmem() / 2 ** 30), os: 'unknown', arch: arch() }
}

const PMSET = '/usr/bin/pmset'
const SPAWN_MS = 2000
/** One spawn's standard output, or null: it could not start, exited non-zero or ran past 2 s. */
export const spawnOut = (bin: string, args: readonly string[], ms = SPAWN_MS): Promise<string | null> => new Promise((resolve) => {
  try { execFile(bin, [...args], { timeout: ms, encoding: 'utf8', maxBuffer: 64 * 1024 }, (err, out) => resolve(err ? null : String(out))) } catch { resolve(null) }
})

/** A host with nothing known: what the two parsers below read against. */
const NOTHING: HostProfile = { chip: 'unknown', cores: { total: 0, p: 'unknown', e: 'unknown' }, model: 'unknown', memGB: 0, os: 'unknown', arch: 'unknown' }
/** `sysctl -n hw.perflevel0.physicalcpu hw.perflevel1.physicalcpu hw.model`'s three lines, as `withHostSpawns` reads
 *  them: performance cores, efficiency cores, the model - or unknown, all three (an Intel Mac has no perflevels: a
 *  missing oid shifts the lines, so none of them can be trusted). */
export function parseHostSysctl(out: string | null): { p: number | 'unknown'; e: number | 'unknown'; model: string | 'unknown' } {
  const h = withHostSpawns(NOTHING, out, null)
  return { p: h.cores.p, e: h.cores.e, model: h.model }
}
/** `sw_vers -productVersion`, as `withHostSpawns` reads it: "26.6.2", else unknown. */
export const parseOs = (out: string | null): string | 'unknown' => withHostSpawns(NOTHING, null, out).os
/** `pmset -g ps`'s first line names the source: "Now drawing from 'AC Power'" or "'Battery Power'". */
export function parsePower(out: string | null): 'ac' | 'battery' | 'unknown' {
  const m = /drawing from '([^']+)'/.exec(out ?? '')
  return m?.[1] === 'AC Power' ? 'ac' : m?.[1] === 'Battery Power' ? 'battery' : 'unknown'
}

/** The host, read as the app reads its own (`readHost`, src/shared/machine.ts): this floor, then `sysctl -n
 *  hw.perflevel0.physicalcpu hw.perflevel1.physicalcpu hw.model` and `sw_vers -productVersion`, each tried once more
 *  when it fails. */
export async function hostProfile(): Promise<HostProfile> {
  return process.platform === 'darwin' ? readHost(basicHost(), (file, args) => spawnOut(file, args)) : basicHost()
}

/** Where the power comes from now (`pmset -g ps`); unknown off macOS. */
export const powerSource = async (): Promise<'ac' | 'battery' | 'unknown'> => (process.platform === 'darwin' ? parsePower(await spawnOut(PMSET, ['-g', 'ps'])) : 'unknown')

/** The run's profile, written to `<MARVER_HOME>/perf/machine/<hash>.json` (or touched when it exists): its hash. The
 *  write is best effort - a run never fails for its profile - and a file is never rewritten: a profile is immutable,
 *  its name its content's hash. */
export async function writeHeadlessProfile(home: string): Promise<{ hash: string; profile: HeadlessProfile }> {
  const [host, power] = await Promise.all([hostProfile(), powerSource()])
  const profile: HeadlessProfile = { v: 1, kind: 'headless', host, hostHash: profileHash(host), power }
  const hash = profileHash(profile)
  try {
    const dir = join(home, 'perf', 'machine')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${hash}.json`)
    if (existsSync(file)) { const now = new Date(); utimesSync(file, now, now) }
    else {
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try { writeFileSync(tmp, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(tmp, file) } catch { rmSync(tmp, { force: true }) }
    }
  } catch { /* the line carries the profile inline: the file is for the app's records to meet it */ }
  return { hash, profile }
}
