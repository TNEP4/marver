/**
 * The start command of a canvas (spec 28 A2.11, A2.14 #24): one `startCommand()` for the tab page, the strip's
 * "Stopped" pill and Home's Recently here. Shown with `~`; copied with the full real path quoted for the shell -
 * `~` inside quotes would not expand, so the copy never uses it. `--port <p>` for a canvas that ran on a port of
 * its own (`port-<p>.json`, A1.3). No Electron or file-system imports: the pages may import it too.
 */

/** Single-quoted for a POSIX shell: `'` becomes `'\''`. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Only what a shell would split or expand needs quotes in the shown form. */
const plain = (s: string) => /^[A-Za-z0-9_@%+=:,./-]*$/.test(s)

/** A path shown with `~` for the home folder; anything else as it is. */
export function tilde(path: string, home: string): string {
  if (!home) return path
  const h = home.endsWith('/') ? home.slice(0, -1) : home
  if (path === h) return '~'
  return path.startsWith(h + '/') ? `~${path.slice(h.length)}` : path
}

export interface StartCommand {
  /** what the page and the pill's tooltip show: `cd ~/tms-broker && npx marver dev` (still a valid command) */
  shown: string
  /** what the clipboard gets: `cd '/Users/nic/tms-broker' && npx marver dev` */
  copy: string
}

export function startCommand(root: string, home: string, port?: number): StartCommand {
  const tail = `npx marver dev${port ? ` --port ${port}` : ''}`
  const t = tilde(root, home)
  // `~/` stays outside the quotes so the shown form still expands when someone types it
  const shown = t.startsWith('~/') ? `~/${plain(t.slice(2)) ? t.slice(2) : shellQuote(t.slice(2))}` : plain(t) ? t : shellQuote(t)
  return { shown: `cd ${shown} && ${tail}`, copy: `cd ${shellQuote(root)} && ${tail}` }
}
