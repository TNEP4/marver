/**
 * `marver shot <scene/frame> [...]`, `--scene <name>`, `--all` - render frames headless and
 * print the PNG paths, one per line, in the order asked.
 *
 * The shell-ful agents' door into the same verify loop jam teaches: build, shoot, LOOK. One
 * frame goes through /api/shot; several, a scene or everything go through /api/shots as ONE
 * operation (one browser, several frames at a time), so shooting a scene costs about what
 * shooting a frame did. shot.ts (server) has the capture story.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { readDevInfo } from '../server/work.ts'
import { NAME } from './name.ts'

/** The fetch never reached the server: refused, unreachable, or forbidden by a sandbox (Codex's blocks the network,
 *  localhost included). Only these move a shot to the file inbox - never an HTTP answer, never a failure after the
 *  request went out. */
const CONNECT = new Set(['ECONNREFUSED', 'EPERM', 'EACCES', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'])
export function cannotConnect(err: unknown): boolean {
  const cause = (err as { cause?: unknown })?.cause as { code?: string; errors?: { code?: string }[] } | undefined
  if (!cause) return false
  if (Array.isArray(cause.errors) && cause.errors.length) return cause.errors.every((e) => !!e?.code && CONNECT.has(e.code))
  return !!cause.code && CONNECT.has(cause.code)
}

/** The same request through the file inbox the dev server watches (design/.local/shots): a name of its own, written
 *  whole, its own result read and both files removed. Waiting stops at `ms` - it does not cancel; a request still
 *  unclaimed then is removed, so it never runs later. */
async function viaInbox(root: string, spec: Record<string, unknown>, ms: number): Promise<Record<string, unknown>> {
  const inbox = join(root, 'design', '.local', 'shots')
  const name = `cli-${randomBytes(8).toString('hex')}`
  const request = join(inbox, `${name}.request.json`), result = join(inbox, `${name}.result.json`)
  try {
    const tmp = join(inbox, `.${name}.tmp`)
    writeFileSync(tmp, JSON.stringify(spec))
    renameSync(tmp, request)
  } catch (err) {
    throw new Error(`could not reach \`${NAME} dev\` (the network is blocked here) and could not write to design/.local/shots - ${(err as Error).message}`)
  }
  for (const by = Date.now() + ms; Date.now() < by;) {
    if (existsSync(result)) {
      try {
        const data = JSON.parse(readFileSync(result, 'utf8')) as Record<string, unknown>
        rmSync(result, { force: true })
        return data
      } catch { /* written whole by a rename: a read that fails is a race with nothing - read again */ }
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  rmSync(request, { force: true })
  throw new Error(`stopped waiting for \`${NAME} dev\` after ${Math.round(ms / 1000)} s (asked through design/.local/shots - the network is blocked here)`)
}

type Entry = { frame: string; ok: true; path: string; width: number; height: number; scale: number; truncated?: boolean; unsettled?: boolean; note?: string; recaptures?: number } | { frame: string; ok: false; error: string }

export async function shotCommand(root: string, frames: string[], opts: { scene?: string; all?: boolean; theme?: string; scale?: string | number; json?: boolean }): Promise<void> {
  const usage = `${NAME} shot <scene/frame ...> | --scene <name> | --all  [--theme <name>] [--scale 1-4] [--json]`
  const asks = [frames.length > 0, !!opts.scene, !!opts.all].filter(Boolean).length
  if (asks !== 1) throw new Error(`name the frames, one way: ${usage}`)
  const info = readDevInfo(root)
  if (!info) throw new Error(`\`${NAME} dev\` is not running in this repo (design/.local/dev.json not found) - start it first.`)
  const scale = opts.scale != null ? Number(opts.scale) : undefined
  const theme = opts.theme
  const single = frames.length === 1 && !opts.scene && !opts.all
  const sel = single ? { frame: frames[0] } : opts.all ? { all: true } : opts.scene ? { scene: opts.scene } : { frames }
  let data: { path?: string; error?: string; results?: Entry[] } & Record<string, unknown>
  try {
    let res: Response
    if (single) {
      const qs = new URLSearchParams({ frame: frames[0], ...(theme ? { theme } : {}), ...(scale != null ? { scale: String(scale) } : {}) })
      res = await fetch(`http://localhost:${info.port}/__mv/api/shot?${qs}`, { headers: { 'x-mv-work': info.token } })
    } else {
      res = await fetch(`http://localhost:${info.port}/__mv/api/shots`, {
        method: 'POST', headers: { 'x-mv-work': info.token, 'content-type': 'application/json' },
        body: JSON.stringify({ ...sel, ...(theme ? { theme } : {}), ...(scale != null ? { scale } : {}) }),
      })
    }
    data = (await res.json().catch(() => ({}))) as typeof data
    if (!res.ok) throw Object.assign(new Error(data.error ?? `shot failed (${res.status})`), { answered: true })
  } catch (err) {
    if ((err as { answered?: boolean }).answered) throw err
    if (!cannotConnect(err)) throw new Error(`could not reach \`${NAME} dev\` on port ${info.port} - is it still running?`)
    // a sandbox that blocks the network blocks localhost too: the same request through the file inbox
    const waitMs = Number(process.env.MARVER_SHOT_INBOX_WAIT_MS) > 0 ? Number(process.env.MARVER_SHOT_INBOX_WAIT_MS) : single ? 120_000 : 600_000
    data = await viaInbox(root, { ...sel, ...(theme ? { theme } : {}), ...(scale != null ? { scale } : {}) }, waitMs) as typeof data
    if (data.ok === false) throw new Error(String(data.error ?? 'shot failed'))
  }
  // one shape for both doors: the single answer becomes a one-entry batch
  const one = data as { path?: string; width?: number; height?: number; scale?: number; truncated?: boolean; unsettled?: boolean; note?: string; recaptures?: number; error?: string }
  const results: Entry[] = single
    ? [one.path
      ? { frame: frames[0], ok: true, path: one.path, width: one.width!, height: one.height!, scale: one.scale!, ...(one.truncated ? { truncated: true } : {}), ...(one.unsettled ? { unsettled: true } : {}), ...(one.note ? { note: one.note } : {}), recaptures: one.recaptures ?? 0 }
      : { frame: frames[0], ok: false, error: one.error ?? 'shot failed' }]
    : data.results ?? []
  if (opts.json) { console.log(JSON.stringify({ results }, null, 2)); if (results.some((r) => !r.ok)) process.exitCode = 1; return }
  let failed = false
  for (const r of results) {
    if (r.ok) { console.log(r.path); if (r.note) console.error(`${r.frame}: ${r.note}`) }
    else { failed = true; console.error(`${r.frame}: ${r.error}`) }
  }
  if (failed) process.exitCode = 1
}
