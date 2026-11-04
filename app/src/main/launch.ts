/**
 * One `launch` line per launch (spec 30 R7 #37). Owner: the app-store stream. Times are ms from process start
 * (`Date.now() - process.uptime() * 1000`): when main was ready (main.ts), the first `showWindow` (window.ts), the first
 * uncovered `cover` of a local tab (window.ts), what the launch restored and how long that took (views.ts). The line is
 * written at the first local canvas uncovered, or 30 s after ready with `why` the reason there was none: `none-restored`
 * (no tab came back), `home` (some did, and Home or Settings was in front), `timeout` (a canvas was in front and never
 * uncovered in time). A quit before then writes what it has (recorder.ts `flushSync`). It goes through the recorder
 * whatever `recorder` says (#6). `firstCanvas.page` is null for a canvas that sent no page in its hello (older than
 * 0.27.2, #54), and it joins the page's boot `load` (`sinceNav`, `visible`, `settled`).
 *
 * Plain state and one timer, no Electron: the callers pass what they saw, and the unit test passes the same.
 */
import type { AppBody, LaunchBody } from '../../../src/shared/app-perf.ts'
import { T } from './timings.ts'

/** The process's start on the wall clock: the same whenever it is asked. */
export const processStart = (): number => Date.now() - process.uptime() * 1000

interface Facts { start: number; readyMs?: number; windowShownMs?: number; tabs?: LaunchBody['tabs']; restoreTabs?: number; firstCanvas?: LaunchBody['firstCanvas'] }
let facts: Facts = { start: processStart() }
let write: ((b: AppBody<'launch'>) => void) | null = null
let written = false
let timer: ReturnType<typeof setTimeout> | null = null

const ms = (at: number) => Math.round(Math.max(0, at - facts.start))

function finish(): void {
  if (written || !write) return
  const f = facts
  if (f.readyMs === undefined) return
  written = true
  if (timer) clearTimeout(timer)
  timer = null
  const tabs = f.tabs ?? { restored: 0, local: 0, remote: 0, active: null }
  write({
    readyMs: f.readyMs,
    ...(f.windowShownMs !== undefined ? { windowShownMs: f.windowShownMs } : {}),
    ...(f.firstCanvas ? { firstCanvas: f.firstCanvas } : { why: tabs.restored === 0 ? 'none-restored' as const : tabs.active === 'local' || tabs.active === 'remote' ? 'timeout' as const : 'home' as const }),
    tabs,
    ...(f.restoreTabs !== undefined ? { restoreTabs: f.restoreTabs } : {}),
  })
}

/** main.ts, at ready. The line's deadline runs from here: 30 s. `start`: the unit tests' process start. */
export function launchReady(at = Date.now(), start?: number): void {
  if (facts.readyMs !== undefined) return
  if (start !== undefined) facts.start = start
  facts.readyMs = ms(at)
  timer = setTimeout(finish, T.launchLineMs)
  timer.unref?.()
}

/** main.ts, once the recorder is up: where the line goes. Written now if its moment already came. */
export function launchWriter(fn: (b: AppBody<'launch'>) => void): void {
  write = fn
  if (facts.firstCanvas) finish()
}

/** window.ts `showWindow`: the first counts. */
export function launchWindowShown(at = Date.now()): void { if (facts.windowShownMs === undefined) facts.windowShownMs = ms(at) }

/** views.ts, the saved tabs applied: what came back, what is in front, and how long main spent on it. */
export function launchRestored(tabs: LaunchBody['tabs'], tookMs: number): void {
  if (!facts.tabs) { facts.tabs = tabs; facts.restoreTabs = Math.round(tookMs) }
}

/** window.ts, the first uncovered `cover` of a local tab: the line's moment. */
export function launchFirstCanvas(c: { tab: string; ws?: string; page?: string; commit?: number; cause: NonNullable<LaunchBody['firstCanvas']>['cause'] }, at = Date.now()): void {
  if (facts.firstCanvas || written) return
  facts.firstCanvas = { tab: c.tab, ...(c.ws ? { ws: c.ws } : {}), page: c.page ?? null, ...(c.commit !== undefined ? { commit: c.commit } : {}), uncoveredMs: ms(at), cause: c.cause }
  finish()
}

/** recorder.ts `flushSync`, at will-quit: the line, with what it has, if its moment never came. */
export function launchQuit(): void { finish() }

/** Unit tests: forget everything. */
export function resetLaunch(): void {
  if (timer) clearTimeout(timer)
  timer = null; written = false; write = null; facts = { start: processStart() }
}
