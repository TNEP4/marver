/**
 * The tab's own page (spec 28 A2.11, A2.14 #21, #22, v1.13 r2 #3, v1.14 r3 #3, #4): what a canvas tab with no
 * canvas to show shows, and crash recovery with one owner and a latch. Owner: the window stream.
 *
 * Pure (no Electron import): `pageFor(tab, now)` is the page as a function of the record; `recover` is the only
 * thing that reloads a tab after its renderer went; the probe schedule (A2.3's retries, A2.11's 5 s check) decides
 * when to look and when to load. The views, the fetches and the sheets are `views.ts`'s, through the ports.
 */
import { homedir } from 'node:os'
import type { TabPageProbe, TabPageView } from '../shared/channels.ts'
import { startCommand, tilde } from '../shared/command.ts'
import { WHY_WORDS } from '../../../src/shared/app-api.ts'
import { T } from './timings.ts'
import { liveDoc, onDocumentGone, tabName, type Tab } from './tabs.ts'

/** Why a renderer went, as `recover` records it. The app's own endings (A3's unload, a confirmed force reload) count nothing. */
export type RecoverCause =
  | { kind: 'crash'; reason: string; exitCode: number }
  | { kind: 'app' }

/** A tab page's snapshot without its `rev` (the sender fills it): `Omit` over each member of the union. */
export type PageBody = TabPageView extends infer V ? V extends unknown ? Omit<V, 'rev'> : never : never
const NO_PROBE: TabPageProbe = { state: 'none', lastAt: null }

/** A network error code in words the page can say (A2.11); local only in 0.1. */
export function netReason(code: number | undefined): string {
  if (code === undefined) return 'failed'
  if (code === -106) return 'offline'
  if (code === -105 || code === -137) return 'no-host'
  if (code === -102 || code === -324) return 'nothing'
  if (code === -7 || code === -118) return 'timeout'
  if (code <= -200 && code > -300) return 'certificate'
  return 'failed'
}

/**
 * The page a tab shows now, or null when its canvas view shows (A2.11's table). `rev` is filled by the sender.
 * Precedence: a crash not yet recovered; a failed load (with the page it may have left `retained` beneath); a gone
 * canvas with nothing kept; a kept page (none: the pill speaks instead); starting or opening.
 */
export function pageFor(t: Tab, now: number, home: string = homedir()): PageBody | null {
  if (t.kind !== 'local') return null
  const c = t.crash
  const base = {
    name: tabName(t),
    ...(t.logo && t.fail?.why !== 'unverified' ? { logo: t.logo } : {}),
    ...(t.look !== undefined ? { dark: t.look } : {}),
    ...(t.root ? { folder: tilde(t.root, home) } : {}),
  }
  const gone = !t.reg || t.reg.state === 'gone'
  const stopped = (retained: boolean, probe: TabPageProbe): PageBody => ({
    ...base, page: 'stopped', since: t.goneAt ?? t.fail?.at ?? now, retained, probe,
    command: t.root ? startCommand(t.root, home, t.reg?.slot == null ? t.reg?.port : undefined).shown : 'npx marver dev',
    ...(t.reg?.origin ? { origin: t.reg.origin } : t.reg ? { origin: `http://localhost:${t.reg.port}` } : {}),
  })
  const origin = t.reg?.origin ?? (t.reg ? `http://localhost:${t.reg.port}` : '')

  // a crash: the page holds nothing until a reload lifts it
  const crashed = t.view === 'crashed' || (!t.doc?.lifted && (c.latched || !!c.pendingShow || c.inFlight === 'auto' || c.inFlight === 'force'))
  if (crashed && !(gone && !c.latched)) {
    return { ...base, page: 'crashed', latched: c.latched, since: c.times?.at(-1) ?? now,
      ...(c.reason ? { reason: c.reason } : {}), ...(c.count ? { crashes: c.count } : {}) }
  }
  if (t.fail) {
    const probe = t.probe ?? NO_PROBE
    const f = t.fail
    if (f.why === 'unverified' && !gone) return { ...base, page: 'unverified', since: f.at, retained: t.retained, probe, origin }
    if (f.why === 'unreachable' && !gone) return { ...base, page: 'unreachable', since: f.at, retained: t.retained, probe, origin, reason: netReason(f.code) }
    return stopped(t.retained, probe)
  }
  if (liveDoc(t)) return null                       // a page that is kept gets no tab page (A2.11): the pill speaks
  if (gone) return stopped(false, NO_PROBE)
  if (t.doc?.lifted && t.view === 'live') return null
  const starting = t.reg!.state === 'starting'
  return { ...base, page: 'starting', phase: starting ? 'starting' : 'opening', since: starting ? (t.regAt ?? now) : (t.loadAt ?? t.regAt ?? now) }
}

// ---------------------------------------------------------------------------------------------------------------
// Crashes: one owner, a latch (A2.11, v1.10 r1 #7)

export interface TabpagePorts {
  now(): number
  isActive(t: Tab): boolean
  /** the reload after a crash: the tab's path on its bound origin, in its own view (a new renderer) */
  reload(t: Tab): void
  /** "Reloaded after a crash", the 4 s confirmation (A2.2) */
  confirmed(t: Tab): void
  /** look at the tab's address: no answer, an answer with no proof, its own canvas proved (v1.14 r3 #4) */
  probe(t: Tab): Promise<TabPageProbe['state']>
  /** load a failed tab that retains nothing (A2.3's retry, A2.11's check that answers) */
  load(t: Tab): void
  changed(): void
  log?(topic: string, data: unknown): void
}

let ports: TabpagePorts | null = null
export function setTabpagePorts(p: TabpagePorts): void { ports = p }
const P = (): TabpagePorts => {
  if (!ports) throw new Error('tabpage.ts: no ports (views.ts installs them at ready)')
  return ports
}

const latchTimers = new Map<string, ReturnType<typeof setTimeout>>()

const reasonOf = (r: string): 'oom' | 'killed' | 'crashed' => r === 'oom' || r === 'memory-eviction' ? 'oom' : r === 'killed' ? 'killed' : 'crashed'

function startReload(t: Tab, why: 'auto' | 'person' | 'force'): void {
  const p = P()
  const c = t.crash
  c.inFlight = why
  c.counted = false
  if (why === 'auto') c.lastAuto = p.now()
  // the shell restores its saved camera on the app's reload after a crash, even under a selection link (A2.9)
  t.reopen = true
  p.log?.('crash', { tab: t.id, reload: why })
  p.reload(t)
}

/**
 * The only reload after a renderer went: at once for the active tab, on showing for a hidden one; a second
 * unexpected crash within 60 s of an automatic reload latches the tab - no automatic reload any more, until the
 * person presses Reload. While an attempt is in flight, further crashes of the tab count once.
 */
export function recover(t: Tab, cause: RecoverCause): void {
  const p = P()
  const c = t.crash
  onDocumentGone(t, 'crashed')
  if (cause.kind === 'app' || t.appEnding) {
    // a renderer the app ended itself (a confirmed force reload; A3's unload) counts nothing
    t.appEnding = false
    p.log?.('crash', { tab: t.id, app: true, inFlight: c.inFlight ?? false })
    if (c.inFlight === 'force') startReload(t, 'force')
    p.changed()
    return
  }
  if (cause.reason === 'clean-exit') {
    // not a crash (A2.11's `crashed` excludes it): nothing counted; reloaded when it is in front
    p.log?.('crash', { tab: t.id, cleanExit: true })
    if (t.reg?.state === 'ready' && !c.latched) { if (p.isActive(t)) startReload(t, 'person'); else c.pendingShow = true }
    p.changed()
    return
  }
  const now = p.now()
  const cancelClear = () => { const x = latchTimers.get(t.id); if (x) { clearTimeout(x); latchTimers.delete(t.id) } c.personLiftAt = undefined }
  cancelClear()
  if (c.inFlight && c.counted) { p.log?.('crash', { tab: t.id, counted: false, attempt: c.inFlight }); p.changed(); return }
  c.count += 1
  c.times = [...(c.times ?? []), now].slice(-10)
  c.reason = reasonOf(cause.reason)
  c.exitCode = cause.exitCode
  if (c.inFlight) c.counted = true
  const latch = c.latched || (c.lastAuto !== undefined && now - c.lastAuto < T.crashWindowMs)
  p.log?.('crash', { tab: t.id, reason: cause.reason, count: c.count, latched: latch })
  if (latch) {
    c.latched = true
    c.inFlight = false
    c.pendingShow = false
    p.changed()
    return
  }
  if (t.reg?.state !== 'ready') { c.inFlight = false; p.changed(); return }   // nothing to reload into: stopped
  if (p.isActive(t)) startReload(t, 'auto')                                  // the budget: started within 1 s
  else { c.inFlight = false; c.pendingShow = true }                         // dimmed; its one automatic attempt when shown
  p.changed()
}

/** The tab was shown: a hidden tab's one automatic attempt after a crash starts now. */
export function onShown(t: Tab): void {
  const c = t.crash
  if (c.pendingShow && !c.latched && t.reg?.state === 'ready') {
    c.pendingShow = false
    startReload(t, 'auto')
  }
  if (t.fail) checkSoon(t)   // A2.11: a check at once when the tab is activated (a retained page's only probes)
}

/** Reload on a crashed tab's page (latched or not) and ⌘R there: the person's (A2.11). */
export function personReload(t: Tab): void {
  if (t.reg?.state !== 'ready') return
  t.crash.pendingShow = false
  startReload(t, 'person')
}

/** The tab's new document lifted (an attributed commit): the attempt in flight ends. */
export function onLifted(t: Tab): void {
  const p = P()
  const c = t.crash
  const was = c.inFlight
  c.inFlight = false
  c.counted = false
  stopRetries(t)
  if (was === 'auto') p.confirmed(t)
  if (was === 'person' && c.latched) {
    // a latch clears when the person's reload has run 60 s without crashing
    c.personLiftAt = p.now()
    const x = setTimeout(() => {
      latchTimers.delete(t.id)
      if (c.personLiftAt !== undefined && t.view === 'live') { c.latched = false; c.count = 0; c.times = []; c.personLiftAt = undefined; p.log?.('crash', { tab: t.id, latch: 'cleared' }); p.changed() }
    }, T.latchClearMs)
    latchTimers.set(t.id, x)
  }
}

/** The attempt in flight ended without a lift (a failure): the tab page shows the failure. */
export function onAttemptFailed(t: Tab): void {
  t.crash.inFlight = false
  t.crash.counted = false
}

/** The tab went away (closed, dropped): its timers with it. */
export function forgetTab(t: Tab): void {
  const x = latchTimers.get(t.id)
  if (x) clearTimeout(x)
  latchTimers.delete(t.id)
  stopRetries(t)
}

export const isLatched = (t: Tab): boolean => t.crash.latched

// ---------------------------------------------------------------------------------------------------------------
// Coming back from a failure (A2.3's retries, A2.11's 5 s check, v1.13 r2 #3, v1.14 r3 #3, #4)

interface Retry { n: number; timer?: ReturnType<typeof setTimeout>; running: boolean }
const retries = new Map<string, Retry>()

/** The delay before the next look: 5 s while active; else 1, 2, 4, 8 s, then every 30 s. */
export function nextDelay(n: number, active: boolean): number {
  if (active) return T.activeCheckMs
  return T.retryMs[n] ?? T.retryEveryMs
}

/** Arm (or re-arm) the looks for a failed tab. Called at each failure and on activation and hiding. */
export function scheduleRetry(t: Tab, o: { now?: boolean } = {}): void {
  if (!t.fail || t.reg?.state !== 'ready') { stopRetries(t); return }
  const r = retries.get(t.id) ?? { n: 0, running: false }
  retries.set(t.id, r)
  if (r.timer) clearTimeout(r.timer)
  const delay = o.now ? 0 : nextDelay(r.n, P().isActive(t))
  r.timer = setTimeout(() => { void look(t) }, delay)
}

function checkSoon(t: Tab): void { scheduleRetry(t, { now: true }) }

export function stopRetries(t: Tab): void {
  const r = retries.get(t.id)
  if (r?.timer) clearTimeout(r.timer)
  retries.delete(t.id)
}

/** One look: a probe; with nothing retained an answer loads the tab, with a page retained it only changes the line. */
async function look(t: Tab): Promise<void> {
  const p = P()
  const r = retries.get(t.id)
  if (!r || r.running) return
  r.timer = undefined
  if (!t.fail || t.reg?.state !== 'ready') { stopRetries(t); return }
  r.running = true
  let state: TabPageProbe['state'] = 'silent'
  try { state = await p.probe(t) } catch { state = 'silent' } finally { r.running = false }
  if (retries.get(t.id) !== r || !t.fail) return
  const before = t.probe?.state
  t.probe = { state, lastAt: p.now() }
  r.n += 1
  p.log?.('probe', { tab: t.id, state, retained: t.retained, n: r.n })
  if (state !== 'silent' && !t.retained) {
    // nothing kept: a retry loads (a fresh proof); the result arms the next look if it fails again
    p.load(t)
    return
  }
  if (before !== state) p.changed()
  scheduleRetry(t)
}

// ---------------------------------------------------------------------------------------------------------------
// The hang sheet's words (A2.11, frame mac-app/11-moments; main's words only, A2.14 #18)

export function hangSheetText(t: Tab, others: string[]): { message: string; detail: string; buttons: [string, string] } {
  const why = (t.reports.busy?.why ?? []).map((w) => WHY_WORDS[w]).filter((x): x is string => !!x)
  const held = why.length ? `: ${why.length === 1 ? why[0] : `${why.slice(0, -1).join(', ')} and ${why.at(-1)}`}` : ''
  const also = others.map((n) => ` This also reloads ${n}.`).join('')
  return {
    message: `${tabName(t)} isn't responding`,
    detail: `Reloading ends it now and loses what it hasn't saved${held}.${also}`,
    // macOS draws the first button rightmost and default: Keep Waiting (and Esc), Reload Page beside it
    buttons: ['Keep Waiting', 'Reload Page'],
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Copy Details (A2.11): an allowlist - versions, the Mac, the reason, the crashes. No path, name or error text.

export interface DetailsInput {
  app: string; electron: string; chrome: string; marver?: string
  macos: string; model?: string; memGB: number
  pressure?: number
}

const hhmmss = (ms: number) => { const d = new Date(ms); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':') }
const safe = (s: string | undefined, re: RegExp) => s && re.test(s) ? s : 'unknown'

export function copyDetails(t: Tab, i: DetailsInput): string {
  const c = t.crash
  const lines = [
    `Marver app ${safe(i.app, /^[0-9A-Za-z.+-]{1,32}$/)} · Electron ${safe(i.electron, /^[0-9.]{1,16}$/)} · Chromium ${safe(i.chrome, /^[0-9.]{1,24}$/)} · Marver ${safe(i.marver, /^[0-9A-Za-z.+-]{1,32}$/)}`,
    `macOS ${safe(i.macos, /^[0-9.]{1,16}$/)} · ${safe(i.model, /^[A-Za-z0-9,]{1,32}$/)} · ${Math.round(i.memGB)} GB`,
    `reason ${c.reason ?? 'unknown'} · exit ${Number.isInteger(c.exitCode) ? c.exitCode : 'unknown'}`,
    `crashes ${c.count}${c.times?.length ? ` at ${c.times.map(hhmmss).join(', ')}` : ''}`,
  ]
  if (i.pressure !== undefined && Number.isInteger(i.pressure)) lines.push(`memory pressure ${i.pressure}`)
  return lines.join('\n') + '\n'
}
