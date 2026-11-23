/**
 * Bakes that survive a restart (perf/bakes-persist/SPEC.md v2). The live generation stays what it was - `Date.now()`
 * at a start, `++` on every watched event (plugin.ts) - and this module adds a REUSE RECORD,
 * `design/.local/bakes/reuse.json`: "generation G's bakes were compiled from inputs whose digest is D". A start adopts
 * G only when the inputs it finds hash to D exactly; anything else is a fresh generation, as before. Fail closed: a
 * miss costs seconds, a stale texture shows the wrong design - so an input that cannot be read, a walk cut short or
 * a budget passed gives no digest at all.
 *
 * The digest, sha256 over sorted lines:
 *  - the root's watched files (the dev server's watcher: its ignores and what never bumps the generation left out);
 *  - by path, the files outside them a frame used: compiled files the watcher does not watch at a start (a monorepo
 *    sibling's source outside the root - Vite watches it only once a page loaded it -, a file under an ignored folder
 *    such as `dist/`) - the record keeps that list, so a start hashes the same lines - and every file of `public/`
 *    (served as it is, never compiled);
 *  - the install stamps and the workspace root's lockfiles, the compiler configs above the root;
 *  - the config read once at boot (design/config and what it imports, Tailwind/PostCSS configs, .env);
 *  - the identity: the schema, Marver's own package (dist/ AND the served src/client, src/shared), the bake browser,
 *    the env Vite resolved.
 * What a session cannot see change (all but the watched files) is also kept apart, `u`: it must equal the boot's for
 * a record to be written - when it drifted, the running compiler may not match the disk, and the session writes none
 * again.
 *
 * A file's sig is size, mtime, ctime and inode (ns): ctime cannot be set back by a user's tool, so an edit that
 * restores the length and the mtime is still seen.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { CODE, imports } from './imports.ts'

/** Bump when bake.json, the texture format or the bake key change: every older record misses. */
export const BAKE_SCHEMA = 1
export const RECORD = 'reuse.json'
/** A generation's first quiet moment: this long with no watched event. */
export const QUIET_MS = 2000
/** How late a watcher event may come (FSEvents' latency and then some): a record waits this long after its digest,
 *  so an edit the walk already read is heard - it moves the generation - before the record is written. */
export const WATCH_LATENCY_MS = 3000
/** Past this many files in all no digest is taken: no record, no adoption. */
export const MAX_FILES = 200_000

export interface ReuseRecord { schema: number; digest: string; gen: number; extra: string[]; at: string }

/** The folders and files the dev server's watcher ignores (dev.ts server.watch.ignored - one list, used by both). */
export const WATCH_IGNORED = [
  '**/design/manifest.json', '**/design/boards/**', '**/design/.local/**', '**/design/.dist/**', '**/design/comments/**',
  '**/.next/**', '**/.turbo/**', '**/.vercel/**', '**/.output/**', '**/dist/**', '**/build/**', '**/out/**', '**/coverage/**',
  // tool-output dirs written into the project must never reload the canvas
  '**/.gstack/**', '**/.git/**', '**/.playwright-mcp/**',
  // context/'s JSON (the map, sync state): read by the check and the status pass, never by a frame
  '**/context/map.json', '**/context/sync/**',
]
const IGNORED_RE = WATCH_IGNORED.map((g) => {
  const body = g.replace(/^\*\*\//, '')
  const folder = body.endsWith('/**')
  const esc = (folder ? body.slice(0, -3) : body).replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|/)${esc}${folder ? '/' : '$'}`)
})
/** Does the watcher ignore this path (relative to the root, `/`-separated)? */
export const ignoredByWatch = (relPath: string): boolean => IGNORED_RE.some((r) => r.test(relPath))
/** Vite's own ignores, and chokidar's atomic-save names (an editor's swap and backup files). */
const VITE_IGNORED = /(^|\/)(node_modules|\.git|test-results)\//
// chokidar 3's own (nodefs-handler / index.js, `atomic`): matched on the whole path, unanchored
const ATOMIC = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/
/** Does the dev server's watcher ignore this ABSOLUTE path - as chokidar matches it, the globs against the whole path,
 *  so a canvas under a folder named `build` is ignored whole? */
export const watcherIgnores = (abs: string): boolean => { const p = abs.split(sep).join('/'); return ignoredByWatch(p) || VITE_IGNORED.test(p) || ATOMIC.test(p) }

class Incomplete extends Error {}

/** A file's signature; `-` when it is not there; Incomplete when it is there and cannot be read. A symlink: its target too. */
export function sigOf(p: string): string {
  let l
  try { l = lstatSync(p, { bigint: true }) } catch (e) { const c = (e as NodeJS.ErrnoException).code; if (c === 'ENOENT' || c === 'ENOTDIR') return '-'; throw new Incomplete(p) }
  let link = ''
  if (l.isSymbolicLink()) { try { link = `->${readlinkSync(p)}|` } catch { throw new Incomplete(p) } }
  let s
  try { s = statSync(p, { bigint: true }) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return `${link}-`; throw new Incomplete(p) }
  if (!s.isFile()) return `${link}dir`
  return `${link}${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`
}
/** sigOf, or null when it cannot be read (the plugin's first sight: never throws). */
export const trySig = (p: string): string | null => { try { return sigOf(p) } catch { return null } }

export const rel = (root: string, p: string) => { const r = relative(root, p); return r.startsWith('..') || isAbsolute(r) ? p : r.split(sep).join('/') }
export const under = (root: string, p: string): boolean => { const r = relative(root, p); return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r) }

/** The key for a file a frame used outside the root's watched files. */
export const extraKey = (root: string, p: string) => `x ${rel(root, p)}`

/** What never moved the generation in a session (plugin.ts bumpGen), so never part of the watched part. */
export function neverBumps(root: string, abs: string): boolean {
  if (abs.includes(`${sep}node_modules${sep}`)) return true
  if (!under(root, abs)) return false
  const r = rel(root, abs)
  return r === 'design/manifest.json' || r.startsWith('design/.local/') || r.startsWith('design/boards/')
}

/** Marver's own data under the root (its writes, the layout, comments, context state): never a bake's input - Tailwind
 *  lists such files as a stylesheet's dependency only because it scans them for class names. */
export function marverData(root: string, abs: string): boolean {
  if (!under(root, abs)) return false
  const r = rel(root, abs)
  return r === 'design/manifest.json' || r === 'context/map.json' || /^(design\/(\.local|boards|comments|\.dist)|context\/sync)\//.test(r)
}

/** Is this compiled file one the watcher does not watch at a start - so one the digest must list by path? */
export function unwatchedAtStart(root: string, abs: string): boolean {
  if (abs.includes(`${sep}node_modules${sep}`)) return false
  return !under(root, abs) || watcherIgnores(abs)
}

/** Every file under a folder, `node_modules` and `.git` left out; Incomplete when a folder cannot be read or is too deep. */
function walk(dir: string, into: string[], budget: { left: number }, depth = 0): void {
  if (depth > 24) throw new Incomplete(dir)
  let names: string[]
  try { names = readdirSync(dir) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Incomplete(dir) }
  for (const n of names) {
    if (n === 'node_modules' || n === '.git') continue
    const p = join(dir, n)
    let s; try { s = lstatSync(p) } catch { throw new Incomplete(p) }
    if (s.isSymbolicLink() && isDir(p)) throw new Incomplete(p)   // a linked folder: its files are not followed
    if (s.isDirectory()) walk(p, into, budget, depth + 1)
    else { if (--budget.left < 0) throw new Incomplete('budget'); into.push(p) }
  }
}

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory() } catch { return false } }

/** The root's files the watcher watches: everything but its ignores, Vite's own (node_modules, .git, test-results)
 *  and chokidar's atomic-save names, matched on the absolute path as chokidar does. A symlinked folder: Incomplete
 *  (its files would be the link's, not followed here). */
function walkRoot(root: string, dir: string, into: string[], budget: { left: number }, depth = 0): void {
  if (depth > 40) throw new Incomplete(dir)
  let names: string[]
  try { names = readdirSync(dir) } catch (e) { if (dir !== root && (e as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Incomplete(dir) }
  for (const n of names) {
    if (n === 'node_modules' || n === '.git' || n === 'test-results') continue
    const p = join(dir, n)
    let s; try { s = lstatSync(p) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new Incomplete(p) }
    if (s.isDirectory()) { if (!watcherIgnores(`${p}${sep}`)) walkRoot(root, p, into, budget, depth + 1) }
    else if (s.isSymbolicLink() && isDir(p)) { if (!watcherIgnores(`${p}${sep}`)) throw new Incomplete(p) }
    else if (!watcherIgnores(p)) { if (--budget.left < 0) throw new Incomplete('budget'); into.push(p) }
  }
}

/** The folders of Marver's own package a bake depends on (package.json `files`, less docs and templates). */
const PKG_SERVED = ['dist', join('src', 'client'), join('src', 'shared')]

const INSTALL_STAMPS = ['node_modules/.package-lock.json', 'node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml', 'node_modules/.yarn-state.yml', 'node_modules/.yarn-integrity']
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json', 'pnpm-workspace.yaml', 'package.json']
/** Compiler configs Vite, PostCSS and TypeScript look for upward from the root. */
const UPWARD = /^(postcss\.config\.|\.postcssrc|tailwind\.config\.|tsconfig.*\.json$|jsconfig.*\.json$|package\.json$|\.browserslistrc$|babel\.config\.|\.babelrc)/
/** Read once when the server boots - an edit reaches the compiler only at a restart. */
const BOOT_ROOT = /^(postcss\.config\.|\.postcssrc|tailwind\.config\.|\.env)/
const BOOT_DESIGN = /^config\.(ts|js|mjs|cjs|mts|cts)$/
const BROWSER_ENV = ['MV_CHROME_FLAGS', 'MV_CHROME_HEADED', 'MARVER_CHROME']

/** At most this many files read at boot (the configs and their imports). */
const MAX_BOOT = 2000

/** The files read once at boot, relative to the root: the configs and every local file they import (a theme list
 *  design/config.ts imports is as boot-bound as the config). Incomplete when one cannot be followed: unreadable, an
 *  import that resolves nowhere or outside the root, a module kind the follower does not read (.mts, .cts). */
export function bootFiles(root: string): string[] {
  let names: string[] = [], design: string[] = []
  try { names = readdirSync(root) } catch { throw new Incomplete(root) }
  try { design = readdirSync(join(root, 'design')) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Incomplete('design') }
  const start = [...names.filter((n) => BOOT_ROOT.test(n)), ...design.filter((n) => BOOT_DESIGN.test(n)).map((n) => `design/${n}`)]
  const im = imports(root)
  const out = new Set<string>(), queue = [...start]
  while (queue.length) {
    const f = queue.shift()!
    if (out.has(f)) continue
    out.add(f)
    if (out.size > MAX_BOOT) throw new Incomplete('boot budget')
    if (/\.(mts|cts)$/.test(f)) throw new Incomplete(f)
    if (!CODE.test(f)) continue   // .env, a JSON config: no imports
    try { readFileSync(join(root, f)) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new Incomplete(f) }
    const of = im.of(f)
    if (of.unresolved.length) throw new Incomplete(f)
    for (const r of of.resolved) queue.push(r)
  }
  return [...out].sort()
}
/** The boot files' sigs - taken by the dev server before it loads the config (dev.ts), compared at the start. */
export function bootSnapshot(root: string): Map<string, string> {
  const m = new Map<string, string>()
  try { for (const f of bootFiles(root)) m.set(`boot ${f}`, sigOf(join(root, f))) } catch { m.set('boot ?', String(Date.now())) }
  return m
}

/** The bake browser's signature: its version (a macOS app's Info.plist) and the binary's size and mtime - never its
 *  ctime, which macOS moves at every launch (a provenance attribute), so a session that baked would always drift. */
export function browserSig(bin: string): string {
  let s
  try { s = statSync(bin, { bigint: true }) } catch { throw new Incomplete(bin) }
  let out = `${s.size}:${s.mtimeNs}`
  const i = bin.indexOf('.app/Contents/MacOS/')
  if (i >= 0) {
    try { out += ` plist ${createHash('sha256').update(readFileSync(join(bin.slice(0, i + 4), 'Contents', 'Info.plist'))).digest('hex').slice(0, 16)}` } catch { throw new Incomplete(bin) }
  }
  return out
}

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
  /** files a frame used outside the root's watched files: the record's, and those this session compiled */
  extra: readonly string[]
  /** the env Vite resolved (server.config.env: .env files expanded, the shell's VITE_*) */
  viteEnv?: Record<string, unknown>
  env?: NodeJS.ProcessEnv
  /** Vite's public folder (served as it is); default `<root>/public` */
  publicDir?: string | false
}

export interface Digest {
  digest: string
  /** what a session cannot see change, key -> sig (compared with the boot's) */
  u: Map<string, string>
  /** the files listed by path, as hashed */
  extra: string[]
  files: number
  /** keys of `u` the watcher watches now (public/ files): their change is an event, not a drift */
  live: Set<string>
}

/** The digest of the inputs now; null when any input cannot be read, a walk is cut short, or past MAX_FILES. */
export function digestOf(o: DigestInputs): Digest | null {
  try { return digest(o) } catch (e) { if (e instanceof Incomplete) return null; throw e }
}

function digest(o: DigestInputs): Digest {
  const { root } = o
  const env = o.env ?? process.env
  const budget = { left: MAX_FILES }
  const take = (n = 1) => { budget.left -= n; if (budget.left < 0) throw new Incomplete('budget') }
  // the root's watched files; a watched file outside it (Vite watches one once a page loaded it) is listed by path
  // with the unwatched compiled ones - so a start, whose watcher has not reached it yet, hashes the same line
  // The root's files by a walk of our own with the watcher's own ignores - never the watcher's list, which says
  // 'ready' before it has reached every folder (seen on Calepin: 17 of 7,303 files at the start), so the same tree
  // must give the same lines whenever it is read. The watcher's list gives only what it took from outside the root.
  const watched = new Set<string>(), watchedOutside = new Set<string>()
  // a root the watcher ignores whole (under a folder named build, out, dist...): no edit is ever heard
  if (watcherIgnores(`${root}${sep}`)) throw new Incomplete(root)
  const mine: string[] = []
  walkRoot(root, root, mine, budget)
  for (const p of mine) if (!neverBumps(root, p)) watched.add(p)
  for (const [dir, names] of Object.entries(o.watched)) {
    const d = isAbsolute(dir) ? dir : join(root, dir)
    if (under(root, d) || d === root) continue
    take(names.length)
    for (const n of names) { const p = join(d, n); if (!neverBumps(root, p)) watchedOutside.add(p) }
  }
  // public/ is listed whole below - never as watched files: Vite adds it to its watcher on its own schedule, and a
  // line must not depend on when
  const pub = o.publicDir === false ? null : (o.publicDir ?? join(root, 'public'))
  const inPub = (p: string) => !!pub && (p === pub || under(pub, p))
  const lines: string[] = []
  for (const p of watched) { if (inPub(p)) continue; const s = sigOf(p); if (s !== 'dir' && s !== '-') lines.push(`w ${rel(root, p)} ${s}`) }
  const u = new Map<string, string>()
  const extra = [...new Set([...o.extra, ...watchedOutside])].filter((p) => !watched.has(p) && !p.includes(`${sep}node_modules${sep}`)).sort()
  take(extra.length)
  for (const p of extra) {
    const s = sigOf(p)
    if (s === 'dir') continue
    lines.push(`${extraKey(root, p)} ${s}`)
    // only what the watcher does not watch can drift unseen; a watched one's change moves the generation
    if (!watchedOutside.has(p)) u.set(extraKey(root, p), s)
  }
  // public/: served as it is, never compiled - every file of it, by path; one the watcher watches now is not drift-
  // checked (its change is an event)
  const live = new Set<string>()
  if (pub) {
    const files: string[] = []
    walk(pub, files, budget)
    for (const p of files) {
      const k = `pub ${rel(root, p)}`
      u.set(k, sigOf(p))
      if (watched.has(p)) live.add(k)
    }
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
    try { names = readdirSync(d) } catch { throw new Incomplete(d) }   // a folder above that cannot be read: its configs are unknown
    for (const n of names.filter((x) => UPWARD.test(x)).sort()) u.set(`up ${d}/${n}`, sigOf(join(d, n)))
  }
  for (const f of bootFiles(root)) u.set(`boot ${f}`, sigOf(join(root, f)))
  // the identity
  u.set('schema', String(BAKE_SCHEMA))
  u.set('marver', o.version)
  let pkg = o.pkgDir
  try { pkg = realpathSync(o.pkgDir) } catch { throw new Incomplete(o.pkgDir) }
  const own: string[] = []
  // what the package ships and serves (its `files`: the built CLI and server, the frame host and content it serves,
  // their shared code) - never the whole folder: a canvas linked to a Marver checkout would walk its tests, its app
  // and whatever else sits there (past the budget: no digest at all)
  for (const d of PKG_SERVED) walk(join(pkg, d), own, budget)
  own.push(join(pkg, 'package.json'))
  u.set('pkg', `${pkg} ${createHash('sha256').update(own.sort().map((p) => `${relative(pkg, p)} ${sigOf(p)}`).join('\n')).digest('hex')}`)
  u.set('chrome', o.chrome ? `${o.chrome} ${browserSig(o.chrome)}` : '-')
  for (const k of BROWSER_ENV) u.set(`env ${k}`, env[k] ?? '-')
  const exposed = o.viteEnv ?? Object.fromEntries(Object.keys(env).filter((k) => k.startsWith('VITE_') || k === 'NODE_ENV').map((k) => [k, env[k]]))
  u.set('env vite', createHash('sha256').update(JSON.stringify(Object.keys(exposed).sort().map((k) => [k, exposed[k]]))).digest('hex'))
  for (const [k, v] of u) if (!k.startsWith('x ')) lines.push(`${k} ${v}`)
  lines.sort()
  return { digest: createHash('sha256').update(lines.join('\n')).digest('hex'), u, extra, files: lines.length, live }
}

/** Did what a session cannot see drift since the boot? The first key that did, or null. A key both have whose sig
 *  differs; a key only one has, except a compiled file first seen later - it counts from the sig it had when
 *  compiled (`seenSig`) - and one the watcher took over since (it is a watched file now). */
export function drifted(boot: Map<string, string>, now: Map<string, string>, seenSig: (key: string) => string | undefined, live: ReadonlySet<string> = new Set()): string | null {
  for (const [k, v] of now) {
    if (live.has(k) && boot.has(k)) continue
    const was = boot.get(k) ?? seenSig(k)
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
