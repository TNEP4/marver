/**
 * `marver ls` (spec 28 A1.5): the canvases running on this Mac, read from the registry
 * (~/.marver/running/) - slot, link, name, version, state, uptime, folder. Dead holders are hidden.
 * No repo needed. `--json` for agents prints the public fields only: never a canvas's key or instance.
 */
import { formatRunning, readRunning } from '../server/slots.ts'
import { NAME } from './name.ts'

export function lsCommand(opts: { json?: boolean }): void {
  const list = readRunning()
  const now = Date.now()
  if (opts.json) {
    const canvases = list.map((r) => ({
      slot: r.slot, port: r.port, url: r.url, origin: r.origin, name: r.name, folder: r.root, version: r.version,
      state: r.state, pid: r.pid, startedAt: r.startedAt, uptimeMs: Math.max(0, now - r.startedAt),
    }))
    console.log(JSON.stringify({ canvases }, null, 2))
    return
  }
  if (!list.length) { console.log(`\n  no canvas runs on this Mac - npx ${NAME} dev starts one\n`); return }
  console.log('')
  for (const line of formatRunning(list, now)) console.log(`  ${line}`)
  console.log('')
}
