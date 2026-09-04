/**
 * `marver shot <scene/frame> [...]`, `--scene <name>`, `--all` - render frames headless and
 * print the PNG paths, one per line, in the order asked.
 *
 * The shell-ful agents' door into the same verify loop jam teaches: build, shoot, LOOK. One
 * frame goes through /api/shot; several, a scene or everything go through /api/shots as ONE
 * operation (one browser, several frames at a time), so shooting a scene costs about what
 * shooting a frame did. shot.ts (server) has the capture story.
 */
import { readDevInfo } from '../server/work.ts'
import { NAME } from './name.ts'

type Entry = { frame: string; ok: true; path: string; width: number; height: number; scale: number; truncated?: boolean; unsettled?: boolean; note?: string } | { frame: string; ok: false; error: string }

export async function shotCommand(root: string, frames: string[], opts: { scene?: string; all?: boolean; theme?: string; scale?: string | number; json?: boolean }): Promise<void> {
  const usage = `${NAME} shot <scene/frame ...> | --scene <name> | --all  [--theme <name>] [--scale 1-4] [--json]`
  const asks = [frames.length > 0, !!opts.scene, !!opts.all].filter(Boolean).length
  if (asks !== 1) throw new Error(`name the frames, one way: ${usage}`)
  const info = readDevInfo(root)
  if (!info) throw new Error(`\`${NAME} dev\` is not running in this repo (design/.local/dev.json not found) - start it first.`)
  const scale = opts.scale != null ? Number(opts.scale) : undefined
  const theme = opts.theme
  const single = frames.length === 1 && !opts.scene && !opts.all
  let res: Response
  try {
    if (single) {
      const qs = new URLSearchParams({ frame: frames[0], ...(theme ? { theme } : {}), ...(scale != null ? { scale: String(scale) } : {}) })
      res = await fetch(`http://localhost:${info.port}/__mv/api/shot?${qs}`, { headers: { 'x-mv-work': info.token } })
    } else {
      const sel = opts.all ? { all: true } : opts.scene ? { scene: opts.scene } : { frames }
      res = await fetch(`http://localhost:${info.port}/__mv/api/shots`, {
        method: 'POST', headers: { 'x-mv-work': info.token, 'content-type': 'application/json' },
        body: JSON.stringify({ ...sel, ...(theme ? { theme } : {}), ...(scale != null ? { scale } : {}) }),
      })
    }
  } catch {
    throw new Error(`could not reach \`${NAME} dev\` on port ${info.port} - is it still running?`)
  }
  const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string; results?: Entry[] } & Record<string, unknown>
  if (!res.ok) throw new Error(data.error ?? `shot failed (${res.status})`)
  // one shape for both doors: the single answer becomes a one-entry batch
  const results: Entry[] = single
    ? [data.path ? { frame: frames[0], ...(data as unknown as Omit<Extract<Entry, { ok: true }>, 'frame'>), ok: true } : { frame: frames[0], ok: false, error: data.error ?? 'shot failed' }]
    : data.results ?? []
  if (opts.json) { console.log(JSON.stringify({ results }, null, 2)); if (results.some((r) => !r.ok)) process.exitCode = 1; return }
  let failed = false
  for (const r of results) {
    if (r.ok) { console.log(r.path); if (r.note) console.error(`${r.frame}: ${r.note}`) }
    else { failed = true; console.error(`${r.frame}: ${r.error}`) }
  }
  if (failed) process.exitCode = 1
}
