/**
 * Headless perf runs, the server's half (spec 28 A3.4, A3.8 #17-#22): the run registry, the barrier, and the
 * driver of script 1 in the canvas's own headless Chrome (cdp.ts's `Browser`, never `shootFrame()`, which makes
 * posters on purpose). Owner: the headless stream. The contract with the page is src/shared/perf-run.ts.
 *
 * - `perfRunBarrier()`, mounted right after the workspace guard (plugin.ts), **refuses and counts** any other
 *   mutating request whose run id it finds: the `x-mv-perfrun` header, else the `Referer`'s query (a frame's own
 *   fetch; best effort). Counts are per run id. `POST /api/poster` is refused for any run id, registered or not.
 * - The server, never the page, stamps `run` on a run's records (perf.ts `logPage(root, raws, { run })`).
 * - `POST /api/perf/run` reads the whole body before it registers a run; from then on the run is cancelled when the
 *   response closes before it finished (`res.on('close')` with `res.writableFinished` false), never `req.on('close')`.
 *
 * FROZEN (A3.8 #53): `RunReg`, `runs`, `runIdOf`, `perfRunBarrier`, `runOnce`'s signature, `RUN_T`. `RunOptions`
 * gained an optional `watch` (the headless stream): the fingerprint needs the dev server's watcher.
 *
 * The driver (script 1, A3.8 #20): one headless Chrome per run. The warm-up in a context of its own, waited for until
 * its load settled (or was cut) and the run is bake-idle, 60 s at most, else `bakes: 'cold'`. The measured load in a
 * fresh context - cache off, 1440 x 900 at scale 2, `--slow`'s 4x CPU throttling set before it loads - and its three
 * gestures only once it is bake-idle (30 s, else invalid `bakes`). In `finally` the throttling reset and the context
 * disposed, the browser closed, the run's queued compiles ended and its running ones awaited, 300 ms for a change
 * event on its way: only then the line (runs.jsonl), and the next repeat.
 *
 * Nothing waits on the page for ever (the review of a3-runs, major #1): a same-origin frame's script that never
 * returns stops the shell's main thread with it, and the page then answers no CDP call. Every call to a page has
 * `callMs` (15 s) to answer; one that does not marks the page `stalled`, settles all of its calls at once (and every
 * later one), and the run ends cut `unresponsive`, its heap sampling stopped. A run that drives past `runMs` (7 min)
 * ends cut `overrun`.
 *
 * The review of a3-runs' fixes: a run's inputs outside the root are the files its own warm-up page loaded (the CDP
 * requests of that page and its frames, perf-inputs.ts), so a normal tab on another board changes nothing of them; its
 * queued compiles end the moment it halts or its script ends, before its pages close; a compile still running 50 s
 * after its end says so in the line (`bakesPending`) and makes the next run `overlapped`; the gestures the line counts
 * are the driver's own three, after a fit come to rest; only a crash - the page's, the browser's, or a browser-level
 * call never answered - is `crash`, any other failure of the driver is cut `driver: <why>`; and the run's records past
 * the collector's bound count as lost (`records`).
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ROUTE } from '../cli/name.ts'
import { allowedInRun, RUN_HEADER, RUN_ID, RUN_PARAM, RUN_SCRIPT, WARM_PARAM, type InvalidReason, type PerfRunStatus, type RunLine, type RunRequest, type RunStreamLine } from '../shared/perf-run.ts'
import type { HostProfile } from '../shared/machine.ts'
import { Browser, launchFlags } from './cdp.ts'
import { endRunBakes, jobsIdle, jobsOf } from './bake.ts'
import { hashInputs, inputPaths, type Inputs, type InputsWatch } from './perf-inputs.ts'
import { basicHost, writeHeadlessProfile } from './machine-host.ts'
import { marverHome } from './slots.ts'
import { appendRun } from './perf.ts'
import { installedVersion } from './update.ts'

export * from '../shared/perf-run.ts'

/** The driver's durations (A3.4, A3.8 #20, #22); overridable only when `MARVER_SLOT_BASE` is set (the tests' marker).
 *  `callMs` and `runMs` were added by the review of a3-runs: a call to a page unanswered for `callMs` ends the run cut
 *  `unresponsive`; a run that drives past `runMs` - more than every deadline above it added up - ends cut `overrun`. */
export const RUN_T = {
  warmMs: 60_000,
  settleMs: 120_000,
  bakeIdleMs: 30_000,
  gestureEndMs: 5000,
  fitIdleMs: 3000,
  eventMs: 16,
  pauseMs: 500,
  heapMs: 1000,
  statusMs: 100,
  watcherLagMs: 300,
  watcherReadyMs: 30_000,
  heartbeatMs: 10_000,
  callMs: 15_000,
  runMs: 420_000,
} as const
/** The page's own bound on `flush()` (recorder.ts): the driver waits that long, and `callMs` more. */
const FLUSH_MS = 15_000

/** A run while it is registered. */
export interface RunReg {
  id: string
  board: string
  startedAt: number
  phase: 'warm' | 'measured' | 'closing'
  /** mutating requests refused for this id, and the first ten of them (`METHOD /path`) */
  forbidden: number
  forbiddenPaths: string[]
  /** the first watched path that changed while registered: sticky, even if the file is restored (A3.8 #21) */
  inputsChanged: string | null
  /** its cleaned page records, as logPage kept them (bounded) */
  records: Record<string, unknown>[]
  /** another run was registered at some moment of this one - or an earlier run's compile was still running when this
   *  one registered (its line said `bakesPending`) */
  overlapped: boolean
  /** the dev server restarted in place while this run was registered (added by the review of a3-runs): its inputs
   *  changed, and the restart closed its stream - the line says `inputs`, never `cancelled` */
  restarted?: true
  /** records the collector refused past its bound (RECORDS_MAX): lost, the run invalid `records` (added by the review
   *  of a3-runs' fixes) */
  overflow?: number
}

const RECORDS_MAX = 20_000
const live = new Map<string, RunReg>()

/** Module state, so Vite's in-place restart keeps it (A3.8 #22). */
export const runs = {
  /** a new run with its own id */
  register(board: string, id: string): RunReg {
    if (!RUN_ID.test(id)) throw new Error('perf-run: a run id is 16 hex')
    const reg: RunReg = { id, board, startedAt: Date.now(), phase: 'warm', forbidden: 0, forbiddenPaths: [], inputsChanged: null, records: [], overlapped: live.size > 0 }
    for (const other of live.values()) other.overlapped = true
    live.set(id, reg)
    return reg
  },
  get: (id: string): RunReg | undefined => live.get(id),
  /** the run ends: unregistered, and handed back for its line */
  end(id: string): RunReg | undefined { const r = live.get(id); live.delete(id); return r },
  /** a mutating request refused for `id` (an unregistered id counts nowhere) */
  forbidden(id: string, what: string): void {
    const r = live.get(id)
    if (!r) return
    r.forbidden += 1
    if (r.forbiddenPaths.length < 10) r.forbiddenPaths.push(what)
  },
  /** a watched file changed: every registered run's sticky flag */
  changed(file: string): void { for (const r of live.values()) r.inputsChanged ??= file },
  /** Vite restarted in place (an .env or config edit, A3.8 #22): every registered run's inputs changed, and the old
   *  server's close is about to end its stream - which must not read as the client going away */
  restarted(): void { for (const r of live.values()) { r.restarted = true; r.inputsChanged ??= '(the dev server restarted)' } },
  /** a run's cleaned records (perf.ts logPage's `kept`) */
  records(id: string, recs: Record<string, unknown>[]): void {
    const r = live.get(id)
    if (!r) return
    for (const x of recs) { if (r.records.length < RECORDS_MAX) r.records.push(x); else r.overflow = (r.overflow ?? 0) + 1 }
  },
  active: (): RunReg[] => [...live.values()],
}

/** A request's run id: the header, else `mvperfrun` in the Referer's query; null when it names none. */
export function runIdOf(req: Pick<IncomingMessage, 'headers'>): string | null {
  const h = req.headers[RUN_HEADER]
  const head = Array.isArray(h) ? h[0] : h
  if (typeof head === 'string' && RUN_ID.test(head)) return head
  const ref = req.headers.referer
  if (typeof ref !== 'string') return null
  try {
    const id = new URL(ref).searchParams.get(RUN_PARAM)
    return id && RUN_ID.test(id) ? id : null
  } catch { return null }
}

type Next = (err?: unknown) => void

/** The server's barrier (A3.8 #17), right after the workspace guard: a run's mutating request outside the allowed list is refused (403) and counted. */
export function perfRunBarrier(): (req: IncomingMessage, res: ServerResponse, next: Next) => void {
  return (req, res, next) => {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
    const id = runIdOf(req)
    if (!id) return next()
    let path = '/'
    try { path = new URL(req.url ?? '/', 'http://x').pathname } catch { /* refused below */ }
    const base = `${ROUTE}/api/`
    const api = path.startsWith(base) ? path.slice(base.length) : null
    if (allowedInRun(method, api)) return next()
    runs.forbidden(id, `${method} ${path}`)
    res.statusCode = 403
    res.setHeader('content-type', 'application/json')
    res.setHeader(RUN_HEADER, 'refused')
    res.end('{"error":"a perf run is read-only"}')
  }
}

/** What one run needs. `progress` writes a stream line; `signal` is the response closing early. `watch` (added by the
 *  headless stream, optional so the frozen shape still reads) is the dev server's watcher, for the fingerprint: none,
 *  and the run's inputs are unknown - invalid (`inputs`). */
export interface RunOptions {
  root: string
  /** the dev server's own origin, as the shell is served */
  origin: string
  board: string
  slow: boolean
  signal: AbortSignal
  progress(l: RunStreamLine): void
  watch?: InputsWatch
}

type Durations = { -readonly [K in keyof typeof RUN_T]: number }
/** In-process test seams: the driver the route runs, durations, every CDP call the driver makes. Never set outside tests. */
export const runSeams: { driver?: (o: RunOptions) => Promise<RunLine>; t?: Partial<Durations>; cdp?: (method: string, params: Record<string, unknown>) => void } = {}
/** RUN_T, with the suite's overrides: `runSeams.t` in-process, `MV_PERF_RUN_T` (JSON) for a dev server a test starts -
 *  both read only with MARVER_SLOT_BASE set (the suite's marker). */
export function runT(): Durations {
  const t: Durations = { ...RUN_T }
  if (!process.env.MARVER_SLOT_BASE) return t
  let env: Record<string, unknown> = {}
  try { env = JSON.parse(process.env.MV_PERF_RUN_T ?? '{}') } catch { /* none */ }
  for (const src of [env, runSeams.t ?? {}]) for (const k of Object.keys(t) as (keyof Durations)[]) { const v = (src as Record<string, unknown>)[k]; if (typeof v === 'number' && v >= 0) t[k] = v }
  return t
}

/** The shell's address for a run's load: its run id, the warm-up's mark, the board. */
export const runUrl = (origin: string, board: string, id: string, warm: boolean): string =>
  `${origin}/?${RUN_PARAM}=${id}${warm ? `&${WARM_PARAM}=1` : ''}#/b/${encodeURIComponent(board)}`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The last runs' own input paths, for `GET /api/perf/inputs?run=<id>` (the review of a3-runs' fixes): a run's set
 *  outside the root is its page's, which no request without the run can rebuild. Module state, the newest 32. */
const RUN_PATHS_MAX = 32
const runPaths = new Map<string, string[]>()
/** The paths run `id` fingerprinted, while this dev server keeps them. */
export const runInputPaths = (id: string): string[] | undefined => runPaths.get(id)
/** Runs whose compiles outlived the wait at their end: a run registered while one of them still compiles is
 *  overlapped (its measurement ran beside that compile). */
const lingering = new Set<string>()
function anyLingering(): boolean {
  for (const r of lingering) { const j = jobsOf(r); if (j.queued + j.running === 0) lingering.delete(r) }
  return lingering.size > 0
}
/** Why the driver stops before its script's end: the client went away (the one cancel), the page stopped answering,
 *  or the run drove past `runMs`. */
export type HaltWhy = 'cancelled' | 'unresponsive' | 'overrun'
export class Halt extends Error { constructor(readonly why: HaltWhy) { super(why) } }
/** A browser-level call that never answered: the browser is gone, a crash. */
class BrowserSilent extends Error {}
/** A promise given `ms` to settle, else rejected with `what` (a browser-level call: one that never answers is a crash). */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new BrowserSilent(`${what}: no answer in ${ms} ms`)), ms) })]).finally(() => clearTimeout(t))
}

/** One page of a run: a browser context of its own (A3.8 #20), its target and session. */
export interface RunPage {
  context: string
  session: string
  slow: boolean
  crashed: boolean
  /** a call went unanswered for `callMs`: the page's main thread stopped. Every call of the page has settled since, and
   *  every later one settles at once (the review of a3-runs, major #1). */
  stalled: boolean
  /** `ms`: how long the call may take to answer (`callMs` by default) */
  send(method: string, params?: Record<string, unknown>, ms?: number): Promise<any>
  eval<T = unknown>(expression: string, awaitPromise?: boolean, ms?: number): Promise<T>
  stop(): void
}
/** What the driver needs of cdp.ts's Browser (a fake in the unit tests). */
export type RunBrowser = Pick<Browser, 'send' | 'on' | 'abort'>

/**
 * A fresh context: 1440 x 900 at scale 2, the cache on or off, and with `slow` the CPU throttled 4x before anything
 * loads. Its calls are its own (one owner, cdp.ts `abort`): each has `callMs` to answer, else the page is `stalled`
 * and every call of it settles; `halt` (the run stopping: cancelled, or past its cap) settles them all too.
 */
export async function openPage(b: RunBrowser, o: { cache: boolean; slow: boolean; halt?: AbortSignal }): Promise<RunPage> {
  const T = runT()
  const own = {}
  const offs: (() => void)[] = []
  const page: RunPage = {
    context: '', session: '', slow: o.slow, crashed: false, stalled: false,
    send: (m, p = {}, ms) => call(m, p, page.session, ms),
    async eval<T>(expression: string, awaitPromise = false, ms?: number): Promise<T> {
      const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, page.session, ms)
      if (r?.exceptionDetails) throw new Error(`the page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'an error'}`)
      return r?.result?.value as T
    },
    stop: () => { for (const off of offs.splice(0)) off() },
  }
  function call(m: string, p: Record<string, unknown> = {}, sid?: string, ms = T.callMs): Promise<any> {
    runSeams.cdp?.(m, p)
    const sent = b.send(m, p, sid, own)
    let t: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      t = setTimeout(() => {
        // the race takes this reason first; then every call still waiting on the page settles, and every later one
        reject(new Halt('unresponsive'))
        page.stalled = true
        b.abort(own, `the page stopped answering (${m}, ${ms} ms)`)
      }, ms)
    })
    return Promise.race([sent, late]).finally(() => clearTimeout(t))
  }
  const halt = o.halt
  if (halt) {
    const onHalt = () => b.abort(own, String(halt.reason ?? 'halted'))
    if (halt.aborted) onHalt()
    else { halt.addEventListener('abort', onHalt, { once: true }); offs.push(() => halt.removeEventListener('abort', onHalt)) }
  }
  try {
    const { browserContextId } = await call('Target.createBrowserContext', { disposeOnDetach: true })
    page.context = browserContextId
    const { targetId } = await call('Target.createTarget', { url: 'about:blank', browserContextId, newWindow: true, width: 1440, height: 900 })
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
    page.session = sessionId
    offs.push(b.on((m) => { if (m.sessionId === sessionId && (m.method === 'Inspector.targetCrashed' || m.method === 'Target.targetCrashed')) page.crashed = true }))
    await page.send('Inspector.enable').catch((e) => { if (page.stalled) throw e })
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Network.enable')
    await page.send('Network.setCacheDisabled', { cacheDisabled: !o.cache })
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })
    if (o.slow) await page.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  } catch (e) { page.stop(); throw e }   // a context made goes with the browser, at the run's end
  return page
}

/** The page's end, outside the run's own calls (they may be aborted): the throttling reset, then its context disposed -
 *  each bounded, never throwing. */
export async function closePage(b: RunBrowser, page: RunPage): Promise<void> {
  page.stop()
  const bounded = async (m: string, p: Record<string, unknown>, sid?: string) => {
    runSeams.cdp?.(m, p)
    let t: ReturnType<typeof setTimeout> | undefined
    await Promise.race([b.send(m, p, sid).catch(() => {}), new Promise((r) => { t = setTimeout(r, 2000) })])
    clearTimeout(t)
  }
  if (page.slow) await bounded('Emulation.setCPUThrottlingRate', { rate: 1 }, page.session)
  await bounded('Target.disposeBrowserContext', { browserContextId: page.context })
}

/** The page's status, or null while it has none (a navigation under way, the probe not installed yet). A page that
 *  stopped answering is no null: the run halts. */
const status = (p: RunPage): Promise<PerfRunStatus | null> => p.eval<PerfRunStatus | null>('window.__mvPerfRun ? window.__mvPerfRun.status() : null')
  .catch((e) => { if (p.stalled) throw e instanceof Halt ? e : new Halt('unresponsive'); return null })
/** The status until `pred` holds (every `statusMs`), or `ms` passed: which, and the last status read. `halt` throws
 *  when the run must stop - checked before every read; each read itself has `callMs` to answer. */
async function until(p: RunPage, pred: (s: PerfRunStatus) => boolean, ms: number, halt: () => void): Promise<{ ok: boolean; status: PerfRunStatus | null }> {
  const T = runT()
  const by = Date.now() + ms
  let s: PerfRunStatus | null = null
  for (;;) {
    halt()
    s = await status(p)
    if (s && pred(s)) return { ok: true, status: s }
    if (Date.now() >= by || p.crashed) return { ok: false, status: s }
    await sleep(T.statusMs)
  }
}
/** The run is bake-idle (A3.8 #18): the page's four counts and the server's jobs for the run, all zero. */
const bakeIdle = (id: string) => (s: PerfRunStatus) => s.bakeIdle && jobsOf(id).queued === 0 && jobsOf(id).running === 0
const loadEnded = (s: PerfRunStatus) => s.load?.state === 'settled' || s.load?.state === 'cut'

/** Wheel events on an absolute schedule (`eventMs` apart, A3.8 #20): never awaiting an ack, at most 8 outstanding.
 *  An event the page never acks settles at `callMs` (the page then stalled), so the window always drains. */
async function wheels(p: RunPage, at: { x: number; y: number }, series: { n: number; deltaX?: number; deltaY?: number; ctrl?: boolean }[], halt: () => void): Promise<void> {
  const T = runT()
  const t0 = performance.now()
  let i = 0, outstanding = 0
  const sent: Promise<unknown>[] = []
  for (const s of series) for (let k = 0; k < s.n; k++) {
    halt()
    const wait = t0 + i++ * T.eventMs - performance.now()
    if (wait > 0) await sleep(wait)
    while (outstanding >= 8) { halt(); await sleep(1) }
    outstanding++
    sent.push(p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: s.deltaX ?? 0, deltaY: s.deltaY ?? 0, modifiers: s.ctrl ? 2 : 0 }).catch(() => {}).finally(() => { outstanding-- }))
  }
  await Promise.all(sent)
  halt()
}

/** `__mvPerf.report()`'s fields the driver reads. */
interface Report { frameP50?: number; frameP95?: number; over33ms?: number; gestureFrames?: number }
/** The intervals `__mvPerf.report()` keeps, the newest (perf.ts MAX). */
export const REPORT_FRAMES_MAX = 1200
/**
 * Did a gesture time its frames (the review of a3-runs, major #2)? rAF ticked in it: two intervals or more, perf.ts's
 * own rule for a gesture it records - `before` and `after` are `report().gestureFrames` around it. A page that reads as
 * hidden while its timers run (Chrome 156's occluded windows, 0.27.0) ends every gesture with none. A report already
 * full counts as timed.
 */
export const timedGesture = (before: number, after: number): boolean => after - before >= 2 || after >= REPORT_FRAMES_MAX

/**
 * Script 1's gestures on a measured page already bake-idle (A3.8 #20): fit, the pointer at the canvas's centre, the
 * frames reset, then zoom in, zoom out and one pan that turns back - each ended by the shell, 5 s at most, and timed.
 * The fit's own motion is a gesture to the page (the review of a3-runs' fixes, minor #4): a fit not at rest within its
 * 3 s gets the gestures' 5 s more before the frames are reset and the first gesture's count is read - else the run is
 * invalid (`gesture`) - and `gestures` counts the driver's own three that the shell ended, never the page's total
 * since its load.
 */
export async function measureGestures(p: RunPage, hp: () => void): Promise<Pick<RunSeen, 'gestures' | 'gesturesOk' | 'stats'>> {
  const T = runT()
  const fitted = await p.eval<boolean>('window.__mvPerfRun.fit()', true, T.fitIdleMs + T.callMs)
  const atRest = fitted === true || (await until(p, (s) => !s.moving, T.gestureEndMs, hp)).ok
  const c = await p.eval<{ x: number; y: number }>('window.__mvPerfRun.centre()')
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y })
  await p.eval('window.__mvPerf && window.__mvPerf.reset()')
  const report = () => p.eval<Report | null>('window.__mvPerf ? window.__mvPerf.report() : null')
  const gesture = async (series: Parameters<typeof wheels>[2]): Promise<{ ended: boolean; timed: boolean }> => {
    const before = (await status(p))?.gestures ?? 0
    const sampled = (await report())?.gestureFrames ?? 0
    await wheels(p, c, series, hp)
    const ended = (await until(p, (s) => s.gestures > before && !s.moving, T.gestureEndMs, hp)).ok
    return { ended, timed: ended && timedGesture(sampled, (await report())?.gestureFrames ?? 0) }
  }
  const three: { ended: boolean; timed: boolean }[] = []
  three.push(await gesture([{ n: 40, deltaY: -100, ctrl: true }]))
  await sleep(T.pauseMs)
  three.push(await gesture([{ n: 40, deltaY: 100, ctrl: true }]))
  await sleep(T.pauseMs)
  three.push(await gesture([{ n: 60, deltaX: 50 }, { n: 60, deltaX: -50 }]))
  const r = await report()
  return {
    gestures: three.filter((g) => g.ended).length,
    gesturesOk: atRest && three.every((g) => g.timed),
    stats: r && r.gestureFrames ? { p50: r.frameP50 ?? null, p95: r.frameP95 ?? null, over33ms: r.over33ms ?? 0 } : null,
  }
}

/**
 * What a driver's failure says in the line (the review of a3-runs' fixes, minor #5): the client gone is `cancelled`;
 * a halt (the page stopped answering, the run past its cap) is cut with its reason; a crash is only the page's, the
 * browser's, or a browser-level call never answered; anything else - a page script that threw (a reload between two
 * reads, the probe gone), a driver bug - is cut `driver: <why>`. Null: no browser ever ran - no run happened, and no
 * line says one did.
 */
export function failureOf(e: unknown, at: { clientGone: boolean; halted: HaltWhy | null; stalled: boolean; browser: 'none' | 'alive' | 'dead'; pageCrashed: boolean }): { cancelled: true } | { cut: string } | { crashed: true } | null {
  const why: HaltWhy | null = at.clientGone ? 'cancelled' : e instanceof Halt ? e.why : at.stalled ? 'unresponsive' : at.halted
  if (why === 'cancelled') return { cancelled: true }
  if (why) return { cut: why }
  if (at.browser === 'none') return null
  if (at.pageCrashed || at.browser === 'dead' || e instanceof BrowserSilent) return { crashed: true }
  return { cut: `driver: ${String((e as Error)?.message ?? e).slice(0, 300)}` }
}

/** What a run saw, for its line. */
export interface RunSeen {
  id: string; board: string; slow: boolean; startedAt: number
  inputs: Inputs | null; inputsEnd: string | null
  chrome: string; renderer: RunLine['renderer']
  machine: string; host: HostProfile; power: RunLine['power']
  bakes: 'warm' | 'cold'
  cancelled: boolean; crashed: boolean
  /** the measured load: never settled or cut in time (its reason - or the driver's, `unresponsive`, `overrun` or
   *  `driver: <why>`), its bake-idle missed, its gestures - the driver's own that the shell ended - and whether the
   *  fit came to rest and each gesture ended in time and was timed */
  cut?: string; bakesMissed: boolean; gestures: number; gesturesOk: boolean
  /** the run's compiles still running when its end stopped waiting for them (50 s) */
  bakesPending?: boolean
  /** the gestures' frame times: null when none was timed */
  stats: { p50: number | null; p95: number | null; over33ms: number } | null
  heapPeakMB: number | null
  landed: boolean
  postersSkipped: number; refusedInPage: number
}

/** The run line (A3.8 #22): what the page's records (the run's collector) and the driver saw; validity the first
 *  reason that holds, in INVALID_REASONS' order - but a run the dev server's in-place restart ended is `inputs`
 *  whatever else held: its stream closed with the old server, which is no client going away. */
export function runLine(reg: RunReg, s: RunSeen): RunLine {
  // each record once (a send retried after its first attempt landed repeats its records)
  const seen = new Set<string>()
  const recs = reg.records.filter((r) => { const k = `${r.ws}/${r.page}/${r.seq}`; if (seen.has(k)) return false; seen.add(k); return true }) as Record<string, any>[]
  const load = recs.find((r) => r.kind === 'load' && r.cause === 'boot')
  const own = load ? recs.filter((r) => r.load === load.request) : []
  const commit = own.find((r) => r.kind === 'commit'), settled = own.find((r) => r.kind === 'settled')
  const moves = own.filter((r) => r.kind === 'move')
  const errors = recs.filter((r) => r.kind === 'error').length
  const badFrames = settled ? (settled.missing ?? 0) + (settled.neverReady ?? 0) : 0
  // records the page lost on its side - its queue's bound, a send that never landed - said by a `dropped` record (the
  // errors past a load's 50 are `errors`' own); the count may undercount moves, frames or errors (review of a3-runs)
  const lost = recs.filter((r) => r.kind === 'dropped' && r.reason !== 'errors').reduce((n, r) => n + (typeof r.n === 'number' && r.n > 0 ? r.n : 1), 0)
    + (reg.overflow ?? 0)   // and the server's: records past the collector's bound
  const reasons: [InvalidReason, boolean][] = [
    ['cancelled', s.cancelled],
    ['crash', s.crashed],
    ['inputs', !s.inputs || s.inputsEnd !== s.inputs.hash || reg.inputsChanged !== null],
    ['writes', reg.forbidden > 0],
    ['cut', s.cut !== undefined],
    ['frames', badFrames > 0],
    ['errors', errors > 0],
    ['bakes', s.bakesMissed],
    // each gesture ended by the shell in time and timed, and the frame times read: no timing is no measurement
    ['gesture', !s.gesturesOk || !s.stats],
    ['records', !s.landed || !settled || lost > 0],
  ]
  const invalid: InvalidReason | undefined = reg.restarted ? 'inputs' : reasons.find(([, holds]) => holds)?.[0]
  return {
    v: 1, script: RUN_SCRIPT, run: s.id, where: 'headless', ts: s.startedAt, board: s.board,
    inputs: s.inputs, inputsEnd: s.inputsEnd,
    frames: typeof commit?.frames === 'number' ? commit.frames : null,
    marver: installedVersion() ?? '0.0.0', chrome: s.chrome, flags: launchFlags(), renderer: s.renderer,
    machine: s.machine, host: s.host, power: s.power, slow: s.slow, bakes: s.bakes, postersMissing: s.postersSkipped,
    saved: commit ? { measuring: commit.measuring ?? 0, savedHeights: commit.savedHeights ?? 0 } : null,
    loadToSettledMs: load && settled && typeof load.sinceNav === 'number' && typeof settled.ms === 'number' ? load.sinceNav + settled.ms : null,
    settledMs: typeof settled?.ms === 'number' ? settled.ms : null,
    moves: moves.filter((m) => !m.late).length, lateMoves: moves.filter((m) => m.late).length,
    gestures: s.gestures, p50: s.stats?.p50 ?? null, p95: s.stats?.p95 ?? null, over33ms: s.stats ? s.stats.over33ms : null,
    heapPeakMB: s.heapPeakMB, errors,
    forbidden: reg.forbidden, refusedInPage: s.refusedInPage, overlapped: reg.overlapped,
    valid: !invalid,
    ...(invalid ? { invalidReason: invalid } : {}),
    ...(s.cut !== undefined ? { cut: s.cut } : {}),
    ...(reg.restarted ? { restarted: true as const } : {}),
    ...(s.bakesPending ? { bakesPending: true as const } : {}),
  }
}

/** One run of script 1: the warm-up, the measured load and its three gestures, the line (A3.8 #20). */
export async function runOnce(o: RunOptions): Promise<RunLine> {
  const T = runT()
  const id = randomBytes(8).toString('hex')
  const reg = runs.register(o.board, id)
  if (anyLingering()) reg.overlapped = true   // an earlier run's compile still running: this one measures beside it
  const me = {}
  const seen: RunSeen = {
    id, board: o.board, slow: o.slow, startedAt: reg.startedAt, inputs: null, inputsEnd: null, chrome: 'unknown', renderer: null,
    machine: 'unknown', host: basicHost(), power: 'unknown', bakes: 'cold', cancelled: false, crashed: false,
    bakesMissed: false, gestures: 0, gesturesOk: false, stats: null, heapPeakMB: null, landed: false, postersSkipped: 0, refusedInPage: 0,
  }
  // the inputs (A3.8 #21): taken at the start (under the root alone), and again once the warm-up has loaded the board -
  // with the watched files outside the root that its page requested (the watcher watches a frame's imports from outside
  // the root only once a page loaded them, and keeps every other page's) - and that second set, hashed again at the
  // end, is the run's; a file the watcher adds later is the sticky flag's
  const set: { paths: string[] | null } = { paths: null }
  const fp = async (urls: readonly string[]): Promise<void> => {
    const paths = o.watch ? await inputPaths(o.root, o.watch, urls) : null
    if (!paths) return
    set.paths = paths
    seen.inputs = await hashInputs(o.root, paths)
  }
  const requested = new Set<string>()   // the warm-up page's requests, its frames' among them
  let offRequests = () => {}
  let b: Browser | null = null
  let page: RunPage | null = null
  // the run stops before its script's end: its client went away ('cancelled', the one cancel), or it drove past its
  // cap ('overrun') - every call of the browser and of its pages settles at once
  const stop = new AbortController()
  const onAbort = () => stop.abort('cancelled')
  if (o.signal.aborted) onAbort(); else o.signal.addEventListener('abort', onAbort, { once: true })
  const cap = setTimeout(() => stop.abort('overrun'), T.runMs)
  // a halt ends the run's compiles not started at once (A3.8 #19), and settles every call of its browser
  stop.signal.addEventListener('abort', () => { endRunBakes(id); b?.abort(me, String(stop.signal.reason)) }, { once: true })
  /** Throws when the run must stop: halted, or (with a page) that page stalled. */
  const halt = (p?: RunPage) => () => {
    if (stop.signal.aborted) throw new Halt(stop.signal.reason as HaltWhy)
    if (p?.stalled) throw new Halt('unresponsive')
  }
  const check = halt()
  try {
    o.progress({ phase: 'warm', run: id })
    const [, profile] = await Promise.all([fp([]), writeHeadlessProfile(marverHome())])
    seen.machine = profile.hash; seen.host = profile.profile.host; seen.power = profile.profile.power
    check()
    b = await Browser.launch()
    if (stop.signal.aborted) b.abort(me, String(stop.signal.reason))
    check()
    const version = await within(b.send('Browser.getVersion', {}, undefined, me), T.callMs, 'Browser.getVersion')
    seen.chrome = String(version?.product ?? 'unknown').replace(/^[^/]*\//, '')
    const sys = await within(b.send('SystemInfo.getInfo', {}, undefined, me), T.callMs, 'SystemInfo.getInfo').catch(() => null)
    const fs = sys?.gpu?.featureStatus as Record<string, string> | undefined, dev = sys?.gpu?.devices?.[0] as { vendorString?: string; deviceString?: string } | undefined
    seen.renderer = sys ? { gpuCompositing: fs?.gpu_compositing, rasterization: fs?.rasterization, vendor: dev?.vendorString, device: dev?.deviceString } : null

    // 1. the warm-up: its own context, cache on, unthrottled - Vite's transforms and the dependency cache warm, and the
    //    bakes compile; the recorder posts nothing
    page = await openPage(b, { cache: true, slow: false, halt: stop.signal })
    const warmSession = page.session
    offRequests = b.on((m) => {
      const url = m.sessionId === warmSession && m.method === 'Network.requestWillBeSent' ? m.params?.request?.url : undefined
      if (typeof url === 'string' && url.startsWith(`${o.origin}/`)) requested.add(url)
    })
    await page.send('Page.navigate', { url: runUrl(o.origin, o.board, id, true) })
    const warm = await until(page, (s) => loadEnded(s) && bakeIdle(id)(s), T.warmMs, halt(page))
    seen.bakes = warm.ok ? 'warm' : 'cold'
    seen.refusedInPage += warm.status?.refused ?? 0
    seen.crashed ||= page.crashed
    await closePage(b, page); page = null
    offRequests()
    check()
    await fp([...requested])
    if (set.paths) { runPaths.set(id, set.paths); while (runPaths.size > RUN_PATHS_MAX) runPaths.delete(runPaths.keys().next().value!) }
    check()

    // 2. the measured load: a fresh context, the cache off, 1440 x 900 at 2, throttled before it loads with --slow
    reg.phase = 'measured'; o.progress({ phase: 'measured', run: id })
    page = await openPage(b, { cache: false, slow: o.slow, halt: stop.signal })
    const p = page
    const hp = halt(p)
    // one sample at a time, none once the page stopped answering or the run halted
    let heap = 0, sampling = false
    const sampleHeap = () => {
      if (sampling || p.stalled || stop.signal.aborted) return
      sampling = true
      void p.send('Runtime.getHeapUsage').then((h) => { if (typeof h?.usedSize === 'number') heap = Math.max(heap, h.usedSize) }, () => {}).finally(() => { sampling = false })
    }
    const heapTimer = setInterval(sampleHeap, T.heapMs)
    try {
      await p.send('Page.navigate', { url: runUrl(o.origin, o.board, id, false) })
      sampleHeap()
      const loaded = await until(p, loadEnded, T.settleMs, hp)
      if (!loaded.ok || loaded.status?.load?.state === 'cut') seen.cut = loaded.status?.load?.reason ?? (p.crashed ? 'crash' : 'timeout')
      else {
        // its gestures start only once it is bake-idle - the warm-up's leftover server jobs included
        const idle = await until(p, bakeIdle(id), T.bakeIdleMs, hp)
        seen.bakesMissed = !idle.ok
        if (idle.ok) Object.assign(seen, await measureGestures(p, hp))
      }
      // the records landed before the context goes (an error late in the load is the line's too)
      seen.landed = (await p.eval<boolean>('window.__mvPerfRun ? window.__mvPerfRun.flush() : false', true, FLUSH_MS + T.callMs).catch((e) => { if (p.stalled) throw e; return false })) === true
      const last = await status(p)
      seen.postersSkipped = last?.postersSkipped ?? 0
      seen.refusedInPage += last?.refused ?? 0
    } finally {
      clearInterval(heapTimer)
      seen.heapPeakMB = heap ? Math.round((heap / 1_048_576) * 10) / 10 : null
    }
  } catch (e) {
    const f = failureOf(e, {
      clientGone: o.signal.aborted, halted: stop.signal.aborted ? (stop.signal.reason as HaltWhy) : null, stalled: !!page?.stalled,
      browser: !b ? 'none' : b.dead ? 'dead' : 'alive', pageCrashed: !!page?.crashed,
    })
    if (!f) { clearTimeout(cap); runs.end(id); throw e }   // no browser at all: no run happened, and no line says one did
    if ('cancelled' in f) seen.cancelled = true
    else if ('cut' in f) seen.cut ??= f.cut   // never settled in time: the page stopped answering, the run past its cap, the driver failed
    else seen.crashed = true
  } finally {
    // the run's compiles not started end now, before its pages close (A3.8 #19): none starts while they do
    endRunBakes(id)
    offRequests()
    clearTimeout(cap)
    o.signal.removeEventListener('abort', onAbort)
    reg.phase = 'closing'
    try { o.progress({ phase: 'closing', run: id }) } catch { /* the stream is gone */ }
    if (page && b) { seen.crashed ||= page.crashed; await closePage(b, page) }
    if (b) await b.close()
  }
  // the run's work outlives its pages: its queued compiles ended above, its running ones are waited for (45 s each at
  // most) - one still running past that is said (`bakesPending`) and makes the next run overlapped - and a change
  // event already on its way still lands: only then is the line written, and the next repeat started. The end
  // fingerprint reads the run's own set again, with no watcher (a restart closed the one it began with)
  if (!(await jobsIdle(id, 50_000))) { seen.bakesPending = true; lingering.add(id) }
  await sleep(T.watcherLagMs)
  seen.inputsEnd = set.paths ? (await hashInputs(o.root, set.paths)).hash : null
  const done = runs.end(id) ?? reg
  seen.cancelled ||= o.signal.aborted
  const line = runLine(done, seen)
  appendRun(o.root, line as unknown as Record<string, unknown>)
  return line
}

// ---- POST /api/perf/run ------------------------------------------------------------------------------------------

/** The whole body, or null: too large, unreadable, or cut short - a request whose body never completes starts nothing. */
export function readWhole(req: IncomingMessage, limit = 4096): Promise<string | null> {
  return new Promise((done) => {
    let size = 0, over = false
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { over = true; done(null); req.destroy() } else chunks.push(c) })
    req.on('end', () => { if (!over) done(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', () => done(null))
    req.on('close', () => { if (!req.complete) done(null) })
  })
}

/** A run request's body, checked: the board must be one of `boards`; `repeat` 1-5 (1); `slow` a boolean. */
export function readRunRequest(raw: string | null, boards: string[]): { ok: true; req: Required<RunRequest> } | { ok: false; error: string } {
  if (raw === null) return { ok: false, error: 'body too large, unreadable or cut short' }
  let b: Record<string, unknown>
  try { b = JSON.parse(raw) } catch { return { ok: false, error: 'malformed JSON' } }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, error: 'expected { board, slow?, repeat? }' }
  if (typeof b.board !== 'string' || !boards.includes(b.board)) return { ok: false, error: `no board "${String(b.board ?? '')}" - the boards: ${boards.join(', ') || 'none'}` }
  if (b.slow !== undefined && typeof b.slow !== 'boolean') return { ok: false, error: 'slow must be true or false' }
  const repeat = b.repeat === undefined ? 1 : b.repeat
  if (!(Number.isInteger(repeat) && (repeat as number) >= 1 && (repeat as number) <= 5)) return { ok: false, error: 'repeat must be 1-5' }
  return { ok: true, req: { board: b.board, slow: b.slow === true, repeat: repeat as number } }
}

/**
 * `POST /api/perf/run` (A3.8 #22), its gate checked by the caller: the body read whole before any run registers, then
 * NDJSON - headers at once, a phase as each starts, a heartbeat every 10 s (Node's fetch cuts a body silent for 300 s),
 * one `{ line }` per run, `{ done }`. **The client going away cancels, and nothing else does** (A3.8 r2 #3): the
 * response closing before it finished, never the request's `close` (which fires once its body is read).
 */
export async function serveRun(req: IncomingMessage, res: ServerResponse, o: { root: string; origin: string; boards: () => string[]; watch?: InputsWatch }): Promise<void> {
  const raw = await readWhole(req)
  const asked = readRunRequest(raw, o.boards())
  if (!asked.ok) {
    if (res.destroyed) return
    res.statusCode = 400
    res.setHeader('content-type', 'application/json')
    return void res.end(JSON.stringify({ error: asked.error }))
  }
  if (res.destroyed) return
  const T = runT()
  const ac = new AbortController()
  res.on('close', () => { if (!res.writableFinished) ac.abort() })
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
  res.flushHeaders()
  const write = (l: RunStreamLine) => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(l) + '\n') }
  const beat = setInterval(() => write({ heartbeat: Date.now() }), T.heartbeatMs)
  try {
    const drive = runSeams.driver ?? runOnce
    for (let i = 0; i < asked.req.repeat && !ac.signal.aborted; i++) {
      const line = await drive({ root: o.root, origin: o.origin, board: asked.req.board, slow: asked.req.slow, signal: ac.signal, progress: write, watch: o.watch })
      write({ line })
    }
    write({ done: true })
  } catch (e) {
    write({ error: (e as Error).message })
  } finally {
    clearInterval(beat)
    if (!res.destroyed) res.end()
  }
}
