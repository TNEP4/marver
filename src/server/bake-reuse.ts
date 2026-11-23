/**
 * Bakes that survive a restart (perf/bakes-persist/SPEC.md v2). The live generation stays what it was - `Date.now()`
 * at a start, `++` on every watched event (plugin.ts) - and this module adds a REUSE RECORD,
 * `design/.local/bakes/reuse.json`: "generation G's bakes were compiled from inputs whose digest is D". A start adopts
 * G only when the inputs it finds hash to D exactly; anything else is a fresh generation, as before. Fail closed: a
 * miss costs seconds, a stale texture shows the wrong design.
 *
 * The digest, sha256 over sorted lines, in two parts:
 *  - W, the watched part: every file the dev server's watcher watches (its own ignores and what never bumps the
 *    generation left out), and the files Vite compiled that it does not watch at a start (`extra`: a monorepo
 *    sibling's source outside the root, a file under an ignored folder such as `dist/`) - the record keeps that list,
 *    so a start hashes the same paths. A change to a watched file during a session moves the generation; a start
 *    sees one made while the server was stopped.
 *  - U, what a session cannot see change: the compiled files the watcher does not watch, the install stamps and the
 *    workspace root's lockfiles, the compiler configs above the root, the config read once at boot (design/config,
 *    Tailwind/PostCSS configs, .env), and the identity - the schema, Marver's own package (dist/ AND the served
 *    src/client, src/shared), the bake browser, the env Vite exposes. U must equal U at the boot for a record to be
 *    written: when it drifted, the running compiler may not match the disk, and the session writes none again.
 *
 * A file's sig is size, mtime, ctime and inode (ns): ctime cannot be set back by a user's tool, so an edit that
 * restores the length and the mtime is still seen.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/** Bump when bake.json, the texture format or the bake key change: every older record misses. */
export const BAKE_SCHEMA = 1
export const RECORD = 'reuse.json'
/** A generation's first quiet moment: this long with no watched event. */
export const QUIET_MS = 2000
/** Past this many files no digest is taken: no record, no adoption. */
export const MAX_FILES = 200_000

export interface ReuseRecord { schema: number; digest: string; gen: number; extra: string[]; at: string }

/** A file's signature; `-` when it is not there, `?` when it is there and cannot be read. A symlink: its target too. */
export function sigOf(p: string): string {
  let l
  try { l = lstatSync(p, { bigint: true }) } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR' ? '-' : '?' }
  let link = ''
  if (l.isSymbolicLink()) { try { link = `->${readlinkSync(p)}|` } catch { return '?' } }
  let s
  try { s = statSync(p, { bigint: true }) } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${link}-` : '?' }
  if (!s.isFile()) return `${link}dir`
  return `${link}${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`
}

export const rel = (root: string, p: string) => { const r = relative(root, p); return r.startsWith('..') || isAbsolute(r) ? p : r.split(sep).join('/') }
const under = (root: string, p: string): boolean => { const r = relative(root, p); return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r) }

/** U's key for a compiled file the watcher does not watch. */
export const extraKey = (root: string, p: string) => `x ${rel(root, p)}`

/** What never moved the generation in a session (plugin.ts bumpGen), so never part of the watched part. */
export function neverBumps(root: string, abs: string): boolean {
  if (abs.includes(`${sep}node_modules${sep}`)) return true
  if (!under(root, abs)) return false
  const r = rel(root, abs)
  return r === 'design/manifest.json' || r.startsWith('design/.local/') || r.startsWith('design/boards/')
}

/** The bake browser's signature: its version (a macOS app's Info.plist) and the binary's size and mtime - never its
 *  ctime, which macOS moves at every launch (a provenance attribute), so a session that baked would always drift. */
export function browserSig(bin: string): string {
  let out = ''
  try { const s = statSync(bin, { bigint: true }); out = `${s.size}:${s.mtimeNs}` } catch { return '?' }
  const i = bin.indexOf('.app/Contents/MacOS/')
  if (i >= 0) {
    try { out += ` plist ${createHash('sha256').update(readFileSync(join(bin.slice(0, i + 4), 'Contents', 'Info.plist'))).digest('hex').slice(0, 16)}` } catch { out += ' plist ?' }
  }
  return out
}

/** Every file under a folder (Marver's own package: a few hundred), `node_modules` left out. */
function walk(dir: string, into: string[], depth = 0): void {
  if (depth > 12) return
  let names: string[]
  try { names = readdirSync(dir) } catch { return }
  for (const n of names) {
    if (n === 'node_modules' || n === '.git') continue
    const p = join(dir, n)
    let s; try { s = lstatSync(p) } catch { continue }
    if (s.isDirectory()) walk(p, into, depth + 1)
    else into.push(p)
  }
}

const INSTALL_STAMPS = ['node_modules/.package-lock.json', 'node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml', 'node_modules/.yarn-state.yml', 'node_modules/.yarn-integrity']
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json', 'pnpm-workspace.yaml', 'package.json']
/** Compiler configs Vite, PostCSS and TypeScript look for upward from the root. */
const UPWARD = /^(postcss\.config\.|\.postcssrc|tailwind\.config\.|tsconfig.*\.json$|jsconfig.*\.json$|package\.json$|\.browserslistrc$|babel\.config\.|\.babelrc)/
/** Read once when the server boots - an edit reaches the compiler only at a restart. */
const BOOT_ROOT = /^(postcss\.config\.|\.postcssrc|tailwind\.config\.|\.env)/
const BOOT_DESIGN = /^config\.(ts|js|mjs|cjs|mts|cts)$/
const BROWSER_ENV = ['MV_CHROME_FLAGS', 'MV_CHROME_HEADED', 'MARVER_CHROME']

export interface DigestInputs {
  root: string
  /** the workspace root (searchForWorkspaceRoot), when it is not the root */
  workspaceRoot?: string
  /** Marver's package folder (the one serving src/client) */
  pkgDir: string
  version: string
  chrome: string | null
  /** the watcher's getWatched() */
  watched: Record<string, string[]>
  /** compiled files outside the watched set: the record's, and those this session compiled */
  extra: readonly string[]
  env?: NodeJS.ProcessEnv
}

export interface Digest {
  digest: string
  /** U, line by line: key -> sig (compared with the boot's) */
  u: Map<string, string>
  /** `extra` as hashed: those still not watched */
  extra: string[]
  files: number
}

/** The digest of the inputs now; null past MAX_FILES. */
export function digestOf(o: DigestInputs): Digest | null {
  const { root } = o
  const env = o.env ?? process.env
  // the root's watched files are W; a watched file outside it (Vite watches one once a page loaded it) is listed by
  // path with the unwatched compiled ones - so a start, whose watcher has not reached it yet, hashes the same line
  const watched = new Set<string>(), watchedOutside = new Set<string>()
  for (const [dir, names] of Object.entries(o.watched)) {
    const d = isAbsolute(dir) ? dir : join(root, dir)
    for (const n of names) { const p = join(d, n); if (neverBumps(root, p)) continue; (under(root, p) ? watched : watchedOutside).add(p) }
    if (watched.size + watchedOutside.size > MAX_FILES) return null
  }
  const lines: string[] = []
  for (const p of watched) { const s = sigOf(p); if (s !== 'dir' && s !== '-') lines.push(`w ${rel(root, p)} ${s}`) }
  const u = new Map<string, string>()
  const extra = [...new Set([...o.extra, ...watchedOutside])].filter((p) => !watched.has(p) && !p.includes(`${sep}node_modules${sep}`)).sort()
  for (const p of extra) {
    const s = sigOf(p)
    if (s === 'dir') continue
    lines.push(`${extraKey(root, p)} ${s}`)
    // only what the watcher does not watch can drift unseen; a watched one's change moves the generation
    if (!watchedOutside.has(p)) u.set(extraKey(root, p), s)
  }
  for (const r of [...new Set([root, o.workspaceRoot].filter((x): x is string => !!x))]) {
    const tag = r === root ? '.' : 'ws'
    for (const s of INSTALL_STAMPS) u.set(`stamp ${tag} ${s}`, sigOf(join(r, s)))
    if (r !== root) for (const l of LOCKFILES) u.set(`lock ws ${l}`, sigOf(join(r, l)))
  }
  // upward from the root's parent, to the home folder (or the filesystem's root when the canvas is outside it)
  const stop = under(homedir(), root) ? dirname(homedir()) : '/'
  for (let d = dirname(root); d !== stop && d !== dirname(d); d = dirname(d)) {
    let names: string[] = []
    try { names = readdirSync(d) } catch { continue }
    for (const n of names.filter((x) => UPWARD.test(x)).sort()) u.set(`up ${d}/${n}`, sigOf(join(d, n)))
  }
  let rootNames: string[] = []
  try { rootNames = readdirSync(root) } catch { /* none */ }
  for (const n of rootNames.filter((x) => BOOT_ROOT.test(x)).sort()) u.set(`boot ${n}`, sigOf(join(root, n)))
  let designNames: string[] = []
  try { designNames = readdirSync(join(root, 'design')) } catch { /* none */ }
  for (const n of designNames.filter((x) => BOOT_DESIGN.test(x)).sort()) u.set(`boot design/${n}`, sigOf(join(root, 'design', n)))
  // the identity
  u.set('schema', String(BAKE_SCHEMA))
  u.set('marver', o.version)
  let pkg = o.pkgDir
  try { pkg = realpathSync(o.pkgDir) } catch { /* as given */ }
  const own: string[] = []
  walk(pkg, own)
  u.set('pkg', `${pkg} ${createHash('sha256').update(own.sort().map((p) => `${relative(pkg, p)} ${sigOf(p)}`).join('\n')).digest('hex')}`)
  u.set('chrome', o.chrome ? `${o.chrome} ${browserSig(o.chrome)}` : '-')
  for (const k of BROWSER_ENV) u.set(`env ${k}`, env[k] ?? '-')
  const exposed = Object.keys(env).filter((k) => k.startsWith('VITE_') || k === 'NODE_ENV').sort()
  u.set('env vite', createHash('sha256').update(exposed.map((k) => `${k}=${env[k]}`).join('\n')).digest('hex'))
  for (const [k, v] of u) if (!k.startsWith('x ')) lines.push(`${k} ${v}`)
  lines.sort()
  return { digest: createHash('sha256').update(lines.join('\n')).digest('hex'), u, extra, files: lines.length }
}

/** Did U drift since the boot? A key both have whose sig differs - a compiled file first seen later counts from the
 *  sig it had when compiled (`seenSig`). */
export function drifted(boot: Map<string, string>, now: Map<string, string>, seenSig: (key: string) => string | undefined): string | null {
  for (const [k, v] of now) {
    const was = boot.get(k) ?? seenSig(k)
    // a config, stamp or folder file that appeared since the boot is a drift; a compiled file first seen now is not
    if (was === undefined) { if (!k.startsWith('x ')) return k; continue }
    if (was !== v) return k
  }
  for (const k of boot.keys()) if (!now.has(k) && !k.startsWith('x ')) return k
  return null
}

const bakesDir = (root: string) => join(root, 'design', '.local', 'bakes')

export function readRecord(root: string): ReuseRecord | null {
  try {
    const r = JSON.parse(readFileSync(join(bakesDir(root), RECORD), 'utf8')) as ReuseRecord
    if (r && r.schema === BAKE_SCHEMA && typeof r.digest === 'string' && Number.isSafeInteger(r.gen) && r.gen > 0 && Array.isArray(r.extra) && r.extra.every((x) => typeof x === 'string')) return r
  } catch { /* none, or unreadable */ }
  return null
}

/** True when written; false when there is nothing to reuse yet (the generation's folder is not there). */
export function writeRecord(root: string, r: Omit<ReuseRecord, 'schema' | 'at'>): boolean {
  const dir = bakesDir(root)
  if (!existsSync(join(dir, String(r.gen)))) return false   // nothing baked in it yet: nothing to reuse
  const tmp = join(dir, `${RECORD}.tmp-${process.pid}`)
  writeFileSync(tmp, JSON.stringify({ schema: BAKE_SCHEMA, ...r, at: new Date().toISOString() }))
  renameSync(tmp, join(dir, RECORD))
  return true
}

export function removeRecord(root: string): void { rmSync(join(bakesDir(root), RECORD), { force: true }) }

/** The generation a start may adopt: the record's, when its digest is the inputs' now and its folder is there. */
export function adoptable(root: string, rec: ReuseRecord | null, now: Digest | null): number | null {
  if (!rec || !now || rec.digest !== now.digest) return null
  try { if (!statSync(join(bakesDir(root), String(rec.gen))).isDirectory()) return null } catch { return null }
  return rec.gen
}
