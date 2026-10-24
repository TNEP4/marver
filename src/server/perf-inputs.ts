/**
 * A run's inputs (spec 28 A3.4, A3.8 #21): the fingerprint that says two runs measured the same thing, and the
 * sticky flag that says the inputs changed during one. One set by construction: every file the dev server's own
 * watcher watches (`getWatched()`) - outside the root too: Vite watches a file a frame imports from outside the root
 * (a monorepo sibling package's source) once a page has loaded it - plus the board files and `_sizes.json` (which
 * that watcher ignores but which shape the layout and heights), git status playing no part. Owner: the headless
 * stream.
 *
 * FROZEN signatures (A3.8 #53). A fingerprint taken before the watcher is ready (30 s at most) is null, and the run
 * is invalid (`inputs`). Narrows, stated: a frame importing from a folder the watcher ignores (a sibling package's
 * `dist/`) is not in it. `inputPaths` and `hashInputs` (added by the review of a3-runs): a run fingerprints once its
 * warm-up has loaded the board, and its end hashes the same paths again - a file the watcher adds later is the sticky
 * flag's, so loading a frame's imports never changes a run's inputs.
 *
 * A run's set is the board's own (the review of a3-runs' fixes, minor #2): the watcher keeps every file outside the
 * root that any page ever loaded until the dev server restarts, so in a monorepo a run after a normal tab opened
 * another board hashed that board's sibling imports too, and two runs with nothing changed differed. Under the root
 * the set is still every watched file; outside it, only the watched files the run's own warm-up page requested and
 * the files those modules import directly (`InputsWatch.loaded`, from Vite's module graph: a stylesheet's inlined
 * `@import`s and a plugin's watched files are imported modules there), and the watched `tsconfig`/`jsconfig` files in
 * a folder above one of them (Vite watches the tsconfig that compiles a module; it is no import). Narrows, stated: a
 * tsconfig outside the root reached only by another's `extends`, from a folder above none of the run's files, is not
 * in a run's set. `fingerprint()` without a run - and `GET /api/perf/inputs` without `?run=` - still reads every
 * watched file.
 *
 * The sticky flag is the run registry's (`runs.changed`, perf-run.ts): plugin.ts tells it every event of the same
 * watcher, every change of a board file or `_sizes.json` its own boards watcher sees, and a Vite restart.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/** What the fingerprint reads of the dev server's watcher (plugin.ts supplies it). */
export interface InputsWatch {
  /** the watcher's 'ready', waited for at most RUN_T.watcherReadyMs: false when it never came */
  ready(): Promise<boolean>
  /** chokidar's getWatched(): directory -> names */
  watched(): Record<string, string[]>
  /** the files these request URLs loaded (a run's own page requested them), each with the files its modules import
   *  directly - `loadedFiles` over the dev server's module graph. Optional (added by the review of a3-runs' fixes):
   *  without it a run's set outside the root is every watched file there */
  loaded?(urls: readonly string[]): string[]
}

/** What `loadedFiles` reads of Vite's module graph (the client environment's). */
export interface ModuleFiles {
  getModulesByFile(file: string): Iterable<{ importedModules: Iterable<{ file: string | null }> }> | undefined
}

/** The file a request URL names in the dev server: `/@fs/<absolute>` one outside the root, else a path under Vite's
 *  root; null for Vite's own ids (`/@vite/client`, `/@id/...`) and a URL that is no path. Its query is dropped. */
export function fileOfUrl(url: string, viteRoot: string, base = '/'): string | null {
  let path: string
  try { path = decodeURIComponent(new URL(url, 'http://x').pathname) } catch { return null }
  if (base !== '/' && path.startsWith(base)) path = `/${path.slice(base.length)}`
  if (path.startsWith('/@fs/')) { const abs = path.slice('/@fs'.length); return /^\/[A-Za-z]:\//.test(abs) ? abs.slice(1) : abs }
  if (path.startsWith('/@')) return null
  return join(viteRoot, path)
}

/** The files a page's requests loaded, each with the files its modules import directly (Vite records a stylesheet's
 *  inlined `@import`s and a plugin's `addWatchFile` as imported modules) - one level: every module the page ran is
 *  itself a request. */
export function loadedFiles(urls: readonly string[], viteRoot: string, graph: ModuleFiles | null, base = '/'): string[] {
  const out = new Set<string>()
  for (const u of urls) {
    const f = fileOfUrl(u, viteRoot, base)
    if (!f) continue
    out.add(f)
    for (const m of graph?.getModulesByFile(f) ?? []) for (const d of m.importedModules) if (d.file) out.add(d.file)
  }
  return [...out]
}

/** Is `p` under `root`? */
const under = (root: string, p: string): boolean => { const r = relative(root, p); return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r) }
/** A compiler config Vite watches for the modules below it. */
const CONFIG_FILE = /^[jt]sconfig(\..*)?\.json$/
/** Every folder above these files. */
function above(files: Iterable<string>): Set<string> {
  const dirs = new Set<string>()
  for (const f of files) for (let d = dirname(f); !dirs.has(d); d = dirname(d)) { dirs.add(d); if (dirname(d) === d) break }
  return dirs
}

export interface Inputs {
  /** sha256 of the sorted `path\0size\0mtimeMs` lines, 16 hex */
  hash: string
  files: number
}

/** The board files the watcher never sees: every `design/boards/*.json`, `_sizes.json` among them - regular files only. */
export function boardInputs(root: string): string[] {
  const dir = join(root, 'design', 'boards')
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return [] }
  return names.filter((n) => n.endsWith('.json')).map((n) => join(dir, n)).filter((p) => { try { return lstatSync(p).isFile() } catch { return false } })
}

/** Every path the fingerprint reads now: each the watcher watches under the root, and the board files - and outside
 *  the root each watched one, or with `urls` (a run's own page's requests, and `w.loaded`) only those the page loaded;
 *  null before the watcher is ready. Directories among them are dropped when hashed. */
export async function inputPaths(root: string, w: InputsWatch, urls?: readonly string[]): Promise<string[] | null> {
  if (!(await w.ready())) return null
  const own = urls && w.loaded ? new Set(w.loaded(urls)) : null
  const dirs = own ? above(own) : null
  const paths = new Set<string>()
  for (const [dir, names] of Object.entries(w.watched())) {
    const base = isAbsolute(dir) ? dir : join(root, dir)
    for (const n of names) {
      const p = join(base, n)
      if (!own || under(root, p) || own.has(p) || (CONFIG_FILE.test(n) && dirs!.has(base))) paths.add(p)
    }
  }
  for (const p of boardInputs(root)) paths.add(p)
  return [...paths]
}

/** These paths' fingerprint: each file's path from the root (`../` for one outside it), size and mtime. A path that
 *  is gone or no file counts for nothing - so one deleted since changes it. */
export async function hashInputs(root: string, paths: readonly string[]): Promise<Inputs> {
  const lines: string[] = []
  // a few at a time: a large repo watches thousands of files
  for (let i = 0; i < paths.length; i += 64) {
    const got = await Promise.all(paths.slice(i, i + 64).map(async (p) => {
      const st = await stat(p).catch(() => null)   // follows a symlink, as the watcher does; a directory is no input
      return st?.isFile() ? `${relative(root, p).split(sep).join('/')}\0${st.size}\0${st.mtimeMs}` : null
    }))
    for (const l of got) if (l) lines.push(l)
  }
  lines.sort()
  return { hash: createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16), files: lines.length }
}

/** The fingerprint of every watched file, plus the board files and `_sizes.json`; null before the watcher is ready. */
export async function fingerprint(root: string, w: InputsWatch): Promise<Inputs | null> {
  const paths = await inputPaths(root, w)
  return paths ? hashInputs(root, paths) : null
}
