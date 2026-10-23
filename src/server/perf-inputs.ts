/**
 * A run's inputs (spec 28 A3.4, A3.8 #21): the fingerprint that says two runs measured the same thing, and the
 * sticky flag that says the inputs changed during one. One set by construction: the dev server's own watcher's
 * `getWatched()`, plus the board files and `_sizes.json` (which that watcher ignores but which shape the layout and
 * heights) - git status playing no part. Owner: the headless stream.
 *
 * FROZEN signatures (A3.8 #53). A fingerprint taken before the watcher is ready (30 s at most) is null, and the run
 * is invalid (`inputs`). Narrows, stated: a frame importing from a folder the watcher ignores (a sibling package's
 * `dist/`) is not in it.
 *
 * The sticky flag is the run registry's (`runs.changed`, perf-run.ts): plugin.ts tells it every event of the same
 * watcher, and every change of a board file or `_sizes.json` its own boards watcher sees.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

/** What the fingerprint reads of the dev server's watcher (plugin.ts supplies it). */
export interface InputsWatch {
  /** the watcher's 'ready', waited for at most RUN_T.watcherReadyMs: false when it never came */
  ready(): Promise<boolean>
  /** chokidar's getWatched(): directory -> names */
  watched(): Record<string, string[]>
}

export interface Inputs {
  /** sha256 of the sorted `path\0size\0mtimeMs` lines, 16 hex */
  hash: string
  files: number
}

const inside = (root: string, p: string) => { const r = relative(root, p); return r !== '' && !r.startsWith('..') && !isAbsolute(r) }
/** The board files the watcher never sees: every `design/boards/*.json`, `_sizes.json` among them - regular files only. */
export function boardInputs(root: string): string[] {
  const dir = join(root, 'design', 'boards')
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return [] }
  return names.filter((n) => n.endsWith('.json')).map((n) => join(dir, n)).filter((p) => { try { return lstatSync(p).isFile() } catch { return false } })
}

/** The fingerprint of every watched file under `root`, plus the board files and `_sizes.json`; null before the watcher is ready. */
export async function fingerprint(root: string, w: InputsWatch): Promise<Inputs | null> {
  if (!(await w.ready())) return null
  const paths = new Set<string>()
  for (const [dir, names] of Object.entries(w.watched())) {
    const base = isAbsolute(dir) ? dir : join(root, dir)
    for (const n of names) { const p = join(base, n); if (inside(root, p)) paths.add(p) }
  }
  for (const p of boardInputs(root)) paths.add(p)
  const lines: string[] = []
  const all = [...paths]
  // a few at a time: a large repo watches thousands of files
  for (let i = 0; i < all.length; i += 64) {
    const got = await Promise.all(all.slice(i, i + 64).map(async (p) => {
      const st = await stat(p).catch(() => null)   // follows a symlink, as the watcher does; a directory is no input
      return st?.isFile() ? `${relative(root, p).split(sep).join('/')}\0${st.size}\0${st.mtimeMs}` : null
    }))
    for (const l of got) if (l) lines.push(l)
  }
  lines.sort()
  return { hash: createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16), files: lines.length }
}
