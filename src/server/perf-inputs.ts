/**
 * A run's inputs (spec 28 A3.4, A3.8 #21): the fingerprint that says two runs measured the same thing, and the
 * sticky flag that says the inputs changed during one. One set by construction: the dev server's own watcher's
 * `getWatched()`, plus the board files and `_sizes.json` (which that watcher ignores but which shape the layout and
 * heights) - git status playing no part. Owner: the headless stream.
 *
 * FROZEN signatures (A3.8 #53). A fingerprint taken before the watcher is ready (30 s at most) is null, and the run
 * is invalid (`inputs`). Narrows, stated: a frame importing from a folder the watcher ignores (a sibling package's
 * `dist/`) is not in it.
 */

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

/** The fingerprint of every watched file under `root`, plus the board files and `_sizes.json`; null before the watcher is ready. */
export async function fingerprint(root: string, w: InputsWatch): Promise<Inputs | null> {
  void root; void w
  return null   // A3 headless stream: hash path, size and mtime of every watched file (a null makes the run invalid, never a false match)
}
