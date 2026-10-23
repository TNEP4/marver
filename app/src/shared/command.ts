/**
 * The start command (spec 28 A2.11, A2.12, A2.14 #24): one function for the tab page, the strip's Stopped pill and
 * Recently here. Copied with the root's full real path quoted for the shell - `cd '/Users/nic/tms broker' && npx
 * marver dev` - since `~` inside quotes would not expand; shown with `~`, written so that it still runs as shown
 * (`cd ~/'tms broker' && ...`). `--port <p>` for a canvas that ran on a port of its own (`port-<p>.json`, A1.3).
 * Pure: the home folder is a parameter.
 */

/** Quoted for a POSIX shell: single quotes, a quote inside as '\''. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Quoted only when the shell would read it otherwise. */
const shqIfNeeded = (s: string): string => (/^[A-Za-z0-9_./@%+=:,-]+$/.test(s) ? s : shq(s))

/** A path under the home folder written with `~` (for the eye only). */
export function tilde(path: string, home: string): string {
  if (!home || home === '/') return path
  const h = home.endsWith('/') ? home.slice(0, -1) : home
  if (path === h) return '~'
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path
}

export interface StartTarget { root: string; port?: number | null }

const tail = (t: StartTarget) => `npx marver dev${t.port ? ` --port ${t.port}` : ''}`

/** What the clipboard gets: the full real path, quoted. */
export function startCommand(t: StartTarget): string {
  return `cd ${shq(t.root)} && ${tail(t)}`
}

/** What the page shows: `~` for the home folder, outside the quotes, so it still runs as shown. */
export function startCommandShown(t: StartTarget, home: string): string {
  const shown = tilde(t.root, home)
  const dir = shown === '~' ? '~' : shown.startsWith('~/') ? `~/${shqIfNeeded(shown.slice(2))}` : shqIfNeeded(shown)
  return `cd ${dir} && ${tail(t)}`
}

/** The three fixed commands Home copies (A2.12), named by id: Home never sends a command's text. */
export const FIXED_COMMANDS = {
  dev: 'npx marver dev',
  init: 'npm i -D @marver-design/marver && npx marver init',
  update: 'npm i -D @marver-design/marver@latest',
} as const
