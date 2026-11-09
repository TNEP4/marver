/**
 * `<state>/app-live.json` (spec 31 D2): the app's word that it is in use, for `marver link` (src/cli/link.ts
 * `appLive`). Rewritten whole every 30 s and soon after the open tabs change - `{ v: 1, pid, version, scheme?: 1, at,
 * workspaces }`, `scheme` only when this app is the default handler of `marver://`, `workspaces` the real folders of
 * the local canvases open in its tabs - and removed at quit. The CLI trusts it only while its pid runs and it is under
 * 90 s old, so an app that crashed or hangs stops being offered within a minute and a half.
 *
 * The release app writes `state/` - the folder `marver link` reads; Marver Dev writes `state-dev/` and never takes the
 * scheme, so a dev build never turns an agent's links into links only it can open.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { APP_LIVE_EVERY_MS, APP_LIVE_FILE, type AppLiveFile } from '../../../src/shared/deep-link.ts'
import { writeWhole } from './fsx.ts'

export interface AppLivePorts {
  /** the state folder (config.ts `stateDir`), or undefined when ~/.marver cannot be written */
  dir(): string | undefined
  pid: number
  version: string
  /** whether this app takes `marver://` links now (`app.isDefaultProtocolClient`) */
  scheme(): boolean
  /** the real folders of the local canvases open in tabs */
  workspaces(): string[]
  now(): number
  every?: number
}

/** The file's contents (pure). */
export function appLiveFile(p: Pick<AppLivePorts, 'pid' | 'version'> & { scheme: boolean; workspaces: string[]; at: number }): AppLiveFile {
  return { v: 1, pid: p.pid, version: p.version.slice(0, 32), ...(p.scheme ? { scheme: 1 as const } : {}), at: p.at, workspaces: [...new Set(p.workspaces)].sort().slice(0, 256) }
}

export interface AppLive {
  /** write now (the tick, a tabs change after its debounce) */
  write(): Promise<void>
  /** the open tabs changed: written within a second */
  changed(): void
  /** at quit: the file removed, the timers stopped */
  stop(): void
}

export function startAppLive(p: AppLivePorts): AppLive {
  let soon: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let inflight: Promise<void> | null = null
  const file = () => { const d = p.dir(); return d ? join(d, APP_LIVE_FILE) : undefined }
  const write = async () => {
    const f = file()
    if (!f || stopped) return
    const body = appLiveFile({ pid: p.pid, version: p.version, scheme: p.scheme(), workspaces: p.workspaces(), at: p.now() })
    const w = inflight = writeWhole(f, JSON.stringify(body) + '\n').catch(() => { /* the next tick tries again */ })
    await w
    if (inflight === w) inflight = null
  }
  const tick = setInterval(() => { void write() }, p.every ?? APP_LIVE_EVERY_MS)
  ;(tick as { unref?: () => void }).unref?.()
  void write()
  return {
    write,
    changed() {
      if (soon || stopped) return
      soon = setTimeout(() => { soon = undefined; void write() }, 1000)
      ;(soon as { unref?: () => void }).unref?.()
    },
    stop() {
      stopped = true
      clearInterval(tick)
      if (soon) clearTimeout(soon)
      const f = file()
      if (!f) return
      rmSync(f, { force: true })
      // a write already on its way lands after: removed again once it has
      void inflight?.then(() => rmSync(f, { force: true }))
    },
  }
}
