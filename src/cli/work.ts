/**
 * `marver work` - the coding agent's hand on the canvas working state.
 *
 *   work start <scene/frame ...> [--ttl <minutes>]   mark frames actively working
 *   work done  <scene/frame ...> | --all             clear the glow
 *   work list                                        what is glowing right now
 *
 * The intended choreography (taught in design/AGENTS.md): on accepting a request,
 * create the frame FILES first (name, meta, a minimal skeleton), pin them on the
 * right board, `work start` them - the human sees the request land on the canvas
 * within seconds - build (independent frames in parallel, one subagent each), then
 * `work done`. Marks self-expire (default 10 min, max 30) so a crashed agent can
 * never leave a frame glowing forever.
 */
import { readDevInfo, WORK_TTL_DEFAULT, WORK_TTL_MAX } from '../server/work.ts'
import { NAME } from './name.ts'

interface WorkOpts { ttl?: string; all?: boolean }

export async function workCommand(root: string, action: string, frames: string[], opts: WorkOpts): Promise<void> {
  const info = readDevInfo(root)
  if (!info) throw new Error(`\`${NAME} dev\` is not running in this repo (design/.local/dev.json not found) - start it first.`)
  const call = async (method: 'GET' | 'POST', body?: unknown) => {
    let res: Response
    try {
      res = await fetch(`http://localhost:${info.port}/__mv/api/work`, {
        method,
        headers: { 'content-type': 'application/json', 'x-mv-work': info.token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new Error(`could not reach \`${NAME} dev\` on port ${info.port} - is it still running?`)
    }
    const data = await res.json().catch(() => ({}))
    if (res.status === 403) throw new Error(`the dev server refused the token - it likely restarted; try again (design/.local/dev.json is re-read each run)`)
    if (!res.ok) throw new Error(String((data as any)?.error ?? `work ${action} failed (${res.status})`))
    // the port may have been reused by something else entirely - never trust the shape
    if (!Array.isArray((data as any)?.frames)) throw new Error(`port ${info.port} did not answer like \`${NAME} dev\` - is it still running?`)
    return data as { frames: string[] }
  }

  switch (action) {
    case 'start': {
      if (!frames.length) throw new Error('name the frames: work start <scene/frame ...>')
      const min = Number(opts.ttl)
      // same clamp as the server (10s..30min), so what we report is what applies
      const ttlMs = Number.isFinite(min) && min > 0
        ? Math.min(Math.max(min * 60_000, 10_000), WORK_TTL_MAX)
        : WORK_TTL_DEFAULT
      const { frames: active } = await call('POST', { frames, on: true, ttlMs })
      const pretty = ttlMs >= 60_000 ? `${Math.round(ttlMs / 60_000)} min` : `${Math.round(ttlMs / 1000)} s`
      console.log(`working: ${active.join(', ')}   (auto-expires in ${pretty} - re-run to extend, \`work done\` to clear)`)
      return
    }
    case 'done': {
      if (!frames.length && !opts.all) throw new Error('name the frames (or --all): work done <scene/frame ...>')
      const { frames: active } = await call('POST', opts.all ? { on: false, all: true } : { frames, on: false })
      console.log(active.length ? `still working: ${active.join(', ')}` : 'nothing working - all clear')
      return
    }
    case 'list': {
      const { frames: active } = await call('GET')
      console.log(active.length ? active.join('\n') : 'nothing working')
      return
    }
    default:
      throw new Error(`unknown action "${action}" - use start · done · list`)
  }
}
