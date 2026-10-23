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
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { arch, cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { canonical, PROFILE_HASH_HEX, type HeadlessProfile, type HostProfile } from '../shared/machine.ts'

/** The profile's hash: the same function the app uses for its own (A3.8 #11). */
export const profileHash = (p: unknown): string => createHash('sha256').update(canonical(p)).digest('hex').slice(0, PROFILE_HASH_HEX)

/** What Node knows with no spawn: the floor every profile starts from. */
export function basicHost(): HostProfile {
  const c = cpus()
  return { chip: c[0]?.model?.trim() || 'unknown', cores: { total: c.length, p: 'unknown', e: 'unknown' }, model: 'unknown', memGB: Math.round(totalmem() / 2 ** 30), os: 'unknown', arch: arch() }
}

const SYSCTL = '/usr/sbin/sysctl', SW_VERS = '/usr/bin/sw_vers', PMSET = '/usr/bin/pmset'
const SPAWN_MS = 2000
/** One spawn's standard output, or null: it could not start, exited non-zero or ran past 2 s. */
export const spawnOut = (bin: string, args: string[], ms = SPAWN_MS): Promise<string | null> => new Promise((resolve) => {
  try { execFile(bin, args, { timeout: ms, encoding: 'utf8', maxBuffer: 64 * 1024 }, (err, out) => resolve(err ? null : String(out))) } catch { resolve(null) }
})

/** `sysctl -n hw.perflevel0.physicalcpu hw.perflevel1.physicalcpu hw.model`'s three lines: performance cores,
 *  efficiency cores, the model. Anything else - an Intel Mac with no perflevels, an error - is unknown, all three:
 *  a missing oid shifts the lines, so none of them can be trusted. */
export function parseHostSysctl(out: string | null): { p: number | 'unknown'; e: number | 'unknown'; model: string | 'unknown' } {
  const lines = (out ?? '').trim().split('\n').map((l) => l.trim())
  const n = (s: string) => (/^\d{1,4}$/.test(s) ? Number(s) : null)
  if (lines.length !== 3) return { p: 'unknown', e: 'unknown', model: 'unknown' }
  const p = n(lines[0]), e = n(lines[1]), model = /^[\w,. -]{1,64}$/.test(lines[2]) ? lines[2] : null
  return p === null || e === null || model === null ? { p: 'unknown', e: 'unknown', model: 'unknown' } : { p, e, model }
}
/** `sw_vers -productVersion`: "26.6.2", else unknown. */
export const parseOs = (out: string | null): string | 'unknown' => { const v = (out ?? '').trim(); return /^\d+(\.\d+){0,3}$/.test(v) ? v : 'unknown' }
/** `pmset -g ps`'s first line names the source: "Now drawing from 'AC Power'" or "'Battery Power'". */
export function parsePower(out: string | null): 'ac' | 'battery' | 'unknown' {
  const m = /drawing from '([^']+)'/.exec(out ?? '')
  return m?.[1] === 'AC Power' ? 'ac' : m?.[1] === 'Battery Power' ? 'battery' : 'unknown'
}

/** The host, read: `sysctl -n hw.perflevel0.physicalcpu hw.perflevel1.physicalcpu hw.model`, `sw_vers -productVersion`. */
export async function hostProfile(): Promise<HostProfile> {
  const base = basicHost()
  if (process.platform !== 'darwin') return base
  const [sys, os] = await Promise.all([spawnOut(SYSCTL, ['-n', 'hw.perflevel0.physicalcpu', 'hw.perflevel1.physicalcpu', 'hw.model']), spawnOut(SW_VERS, ['-productVersion'])])
  const s = parseHostSysctl(sys)
  return { ...base, cores: { total: base.cores.total, p: s.p, e: s.e }, model: s.model, os: parseOs(os) }
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
