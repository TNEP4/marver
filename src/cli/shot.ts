/**
 * `marver shot <scene/frame>` - render one frame headless and print the PNG path.
 *
 * The shell-ful agents' door into the same verify loop jam teaches: build, shoot, LOOK.
 * Thin wrapper over the dev server's /api/shot (shot.ts has the capture story).
 */
import { readDevInfo } from '../server/work.ts'
import { NAME } from './name.ts'

export async function shotCommand(root: string, frame: string, opts: { theme?: string }): Promise<void> {
  if (!frame) throw new Error(`name the frame: ${NAME} shot <scene/frame> [--theme <name>]`)
  const info = readDevInfo(root)
  if (!info) throw new Error(`\`${NAME} dev\` is not running in this repo (design/.local/dev.json not found) - start it first.`)
  const qs = new URLSearchParams({ frame, ...(opts.theme ? { theme: opts.theme } : {}) })
  let res: Response
  try {
    res = await fetch(`http://localhost:${info.port}/__mv/api/shot?${qs}`, { headers: { 'x-mv-work': info.token } })
  } catch {
    throw new Error(`could not reach \`${NAME} dev\` on port ${info.port} - is it still running?`)
  }
  const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string; width?: number; height?: number }
  if (!res.ok || !data.path) throw new Error(data.error ?? `shot failed (${res.status})`)
  console.log(data.path)
}
