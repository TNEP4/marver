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
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ROUTE } from '../cli/name.ts'
import { allowedInRun, RUN_HEADER, RUN_ID, RUN_PARAM, RUN_SCRIPT, WARM_PARAM, type InvalidReason, type PerfRunStatus, type RunLine, type RunRequest, type RunStreamLine } from '../shared/perf-run.ts'
import type { HostProfile } from '../shared/machine.ts'
import { Browser, launchFlags } from './cdp.ts'
import { endRunBakes, jobsIdle, jobsOf } from './bake.ts'
import { fingerprint, type Inputs, type InputsWatch } from './perf-inputs.ts'
import { basicHost, writeHeadlessProfile } from './machine-host.ts'
import { marverHome } from './slots.ts'
import { appendRun } from './perf.ts'
import { installedVersion } from './update.ts'

export * from '../shared/perf-run.ts'

/** The driver's durations (A3.4, A3.8 #20, #22); overridable only when `MARVER_SLOT_BASE` is set (the tests' marker). */
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
} as const

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
  /** another run was registered at some moment of this one */
  overlapped: boolean
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
  /** a run's cleaned records (perf.ts logPage's `kept`) */
  records(id: string, recs: Record<string, unknown>[]): void {
    const r = live.get(id)
    if (!r) return
    for (const x of recs) { if (r.records.length >= RECORDS_MAX) break; r.records.push(x) }
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
class Cancelled extends Error { constructor() { super('cancelled') } }

/** One page of a run: a browser context of its own (A3.8 #20), its target and session. */
export interface RunPage {
  context: string
  session: string
  slow: boolean
  crashed: boolean
  send(method: string, params?: Record<string, unknown>): Promise<any>
  eval<T = unknown>(expression: string, awaitPromise?: boolean): Promise<T>
  stop(): void
}
/** What the driver needs of cdp.ts's Browser (a fake in the unit tests). */
export type RunBrowser = Pick<Browser, 'send' | 'on' | 'abort'>

/** A fresh context: 1440 x 900 at scale 2, the cache on or off, and with `slow` the CPU throttled 4x before anything loads. */
export async function openPage(b: RunBrowser, me: object, o: { cache: boolean; slow: boolean }): Promise<RunPage> {
  const call = (m: string, p: Record<string, unknown> = {}, sid?: string) => { runSeams.cdp?.(m, p); return b.send(m, p, sid, me) }
  const { browserContextId } = await call('Target.createBrowserContext', { disposeOnDetach: true })
  const { targetId } = await call('Target.createTarget', { url: 'about:blank', browserContextId, newWindow: true, width: 1440, height: 900 })
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
  const page: RunPage = {
    context: browserContextId, session: sessionId, slow: o.slow, crashed: false,
    send: (m, p = {}) => call(m, p, sessionId),
    async eval<T>(expression: string, awaitPromise = false): Promise<T> {
      const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId)
      if (r?.exceptionDetails) throw new Error(`the page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'an error'}`)
      return r?.result?.value as T
    },
    stop: () => {},
  }
  const off = b.on((m) => { if (m.sessionId === sessionId && (m.method === 'Inspector.targetCrashed' || m.method === 'Target.targetCrashed')) page.crashed = true })
  page.stop = off
  await page.send('Inspector.enable').catch(() => {})
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Network.enable')
  await page.send('Network.setCacheDisabled', { cacheDisabled: !o.cache })
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })
  if (o.slow) await page.send('Emulation.setCPUThrottlingRate', { rate: 4 })
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

const status = (p: RunPage): Promise<PerfRunStatus | null> => p.eval<PerfRunStatus | null>('window.__mvPerfRun ? window.__mvPerfRun.status() : null').catch(() => null)
/** The status until `pred` holds (every `statusMs`), or `ms` passed: which, and the last status read. */
async function until(p: RunPage, pred: (s: PerfRunStatus) => boolean, ms: number, signal: AbortSignal): Promise<{ ok: boolean; status: PerfRunStatus | null }> {
  const T = runT()
  const by = Date.now() + ms
  let s: PerfRunStatus | null = null
  for (;;) {
    if (signal.aborted) throw new Cancelled()
    s = await status(p)
    if (s && pred(s)) return { ok: true, status: s }
    if (Date.now() >= by || p.crashed) return { ok: false, status: s }
    await sleep(T.statusMs)
  }
}
/** The run is bake-idle (A3.8 #18): the page's four counts and the server's jobs for the run, all zero. */
const bakeIdle = (id: string) => (s: PerfRunStatus) => s.bakeIdle && jobsOf(id).queued === 0 && jobsOf(id).running === 0
const loadEnded = (s: PerfRunStatus) => s.load?.state === 'settled' || s.load?.state === 'cut'

/** Wheel events on an absolute schedule (`eventMs` apart, A3.8 #20): never awaiting an ack, at most 8 outstanding. */
async function wheels(p: RunPage, at: { x: number; y: number }, series: { n: number; deltaX?: number; deltaY?: number; ctrl?: boolean }[], signal: AbortSignal): Promise<void> {
  const T = runT()
  const t0 = performance.now()
  let i = 0, outstanding = 0
  const sent: Promise<unknown>[] = []
  for (const s of series) for (let k = 0; k < s.n; k++) {
    if (signal.aborted) throw new Cancelled()
    const wait = t0 + i++ * T.eventMs - performance.now()
    if (wait > 0) await sleep(wait)
    while (outstanding >= 8) await sleep(1)
    outstanding++
    sent.push(p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: s.deltaX ?? 0, deltaY: s.deltaY ?? 0, modifiers: s.ctrl ? 2 : 0 }).catch(() => {}).finally(() => { outstanding-- }))
  }
  await Promise.all(sent)
}

/** What a run saw, for its line. */
export interface RunSeen {
  id: string; board: string; slow: boolean; startedAt: number
  inputs: Inputs | null; inputsEnd: string | null
  chrome: string; renderer: RunLine['renderer']
  machine: string; host: HostProfile; power: RunLine['power']
  bakes: 'warm' | 'cold'
  cancelled: boolean; crashed: boolean
  /** the measured load: never settled or cut in time (its reason), its bake-idle missed, its gestures' ends */
  cut?: string; bakesMissed: boolean; gestures: number; gesturesOk: boolean
  stats: { p50: number | null; p95: number | null; over33ms: number } | null
  heapPeakMB: number | null
  landed: boolean
  postersSkipped: number; refusedInPage: number
}

/** The run line (A3.8 #22): what the page's records (the run's collector) and the driver saw; validity the first
 *  reason that holds, in INVALID_REASONS' order. */
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
  const reasons: [InvalidReason, boolean][] = [
    ['cancelled', s.cancelled],
    ['crash', s.crashed],
    ['inputs', !s.inputs || s.inputsEnd !== s.inputs.hash || reg.inputsChanged !== null],
    ['writes', reg.forbidden > 0],
    ['cut', s.cut !== undefined],
    ['frames', badFrames > 0],
    ['errors', errors > 0],
    ['bakes', s.bakesMissed],
    ['gesture', !s.gesturesOk],
    ['records', !s.landed || !settled],
  ]
  const invalid = reasons.find(([, holds]) => holds)?.[0]
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
    gestures: s.gestures, p50: s.stats?.p50 ?? null, p95: s.stats?.p95 ?? null, over33ms: s.stats?.over33ms ?? 0,
    heapPeakMB: s.heapPeakMB, errors,
    forbidden: reg.forbidden, refusedInPage: s.refusedInPage, overlapped: reg.overlapped,
    valid: !invalid,
    ...(invalid ? { invalidReason: invalid } : {}),
    ...(s.cut !== undefined ? { cut: s.cut } : {}),
  }
}

/** One run of script 1: the warm-up, the measured load and its three gestures, the line (A3.8 #20). */
export async function runOnce(o: RunOptions): Promise<RunLine> {
  const T = runT()
  const id = randomBytes(8).toString('hex')
  const reg = runs.register(o.board, id)
  const me = {}
  const seen: RunSeen = {
    id, board: o.board, slow: o.slow, startedAt: reg.startedAt, inputs: null, inputsEnd: null, chrome: 'unknown', renderer: null,
    machine: 'unknown', host: basicHost(), power: 'unknown', bakes: 'cold', cancelled: false, crashed: false,
    bakesMissed: false, gestures: 0, gesturesOk: false, stats: null, heapPeakMB: null, landed: false, postersSkipped: 0, refusedInPage: 0,
  }
  const fp = () => (o.watch ? fingerprint(o.root, o.watch) : Promise.resolve(null))
  let b: Browser | null = null
  let page: RunPage | null = null
  const onAbort = () => { b?.abort(me, 'cancelled') }
  o.signal.addEventListener('abort', onAbort, { once: true })
  const check = () => { if (o.signal.aborted) throw new Cancelled() }
  try {
    o.progress({ phase: 'warm', run: id })
    const [inputs, profile] = await Promise.all([fp(), writeHeadlessProfile(marverHome())])
    seen.inputs = inputs
    seen.machine = profile.hash; seen.host = profile.profile.host; seen.power = profile.profile.power
    check()
    b = await Browser.launch()
    check()
    const version = await b.send('Browser.getVersion', {}, undefined, me)
    seen.chrome = String(version?.product ?? 'unknown').replace(/^[^/]*\//, '')
    const sys = await b.send('SystemInfo.getInfo', {}, undefined, me).catch(() => null)
    const fs = sys?.gpu?.featureStatus as Record<string, string> | undefined, dev = sys?.gpu?.devices?.[0] as { vendorString?: string; deviceString?: string } | undefined
    seen.renderer = sys ? { gpuCompositing: fs?.gpu_compositing, rasterization: fs?.rasterization, vendor: dev?.vendorString, device: dev?.deviceString } : null

    // 1. the warm-up: its own context, cache on, unthrottled - Vite's transforms and the dependency cache warm, and the
    //    bakes compile; the recorder posts nothing
    page = await openPage(b, me, { cache: true, slow: false })
    await page.send('Page.navigate', { url: runUrl(o.origin, o.board, id, true) })
    const warm = await until(page, (s) => loadEnded(s) && bakeIdle(id)(s), T.warmMs, o.signal)
    seen.bakes = warm.ok ? 'warm' : 'cold'
    seen.refusedInPage += warm.status?.refused ?? 0
    seen.crashed ||= page.crashed
    await closePage(b, page); page = null
    check()

    // 2. the measured load: a fresh context, the cache off, 1440 x 900 at 2, throttled before it loads with --slow
    reg.phase = 'measured'; o.progress({ phase: 'measured', run: id })
    page = await openPage(b, me, { cache: false, slow: o.slow })
    const p = page
    let heap = 0
    const sampleHeap = () => { void p.send('Runtime.getHeapUsage').then((h) => { if (typeof h?.usedSize === 'number') heap = Math.max(heap, h.usedSize) }, () => {}) }
    const heapTimer = setInterval(sampleHeap, T.heapMs)
    try {
      await p.send('Page.navigate', { url: runUrl(o.origin, o.board, id, false) })
      sampleHeap()
      const loaded = await until(p, loadEnded, T.settleMs, o.signal)
      if (!loaded.ok || loaded.status?.load?.state === 'cut') seen.cut = loaded.status?.load?.reason ?? (p.crashed ? 'crash' : 'timeout')
      else {
        // its gestures start only once it is bake-idle - the warm-up's leftover server jobs included
        const idle = await until(p, bakeIdle(id), T.bakeIdleMs, o.signal)
        seen.bakesMissed = !idle.ok
        if (idle.ok) {
          await p.eval('window.__mvPerfRun.fit()', true)
          const c = await p.eval<{ x: number; y: number }>('window.__mvPerfRun.centre()')
          await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y })
          await p.eval('window.__mvPerf && window.__mvPerf.reset()')
          // three gestures: zoom in, zoom out, one pan that turns back - each ended by the shell, 5 s at most
          const gesture = async (series: Parameters<typeof wheels>[2]) => {
            const before = (await status(p))?.gestures ?? 0
            await wheels(p, c, series, o.signal)
            return (await until(p, (s) => s.gestures > before && !s.moving, T.gestureEndMs, o.signal)).ok
          }
          const ok: boolean[] = []
          ok.push(await gesture([{ n: 40, deltaY: -100, ctrl: true }]))
          await sleep(T.pauseMs)
          ok.push(await gesture([{ n: 40, deltaY: 100, ctrl: true }]))
          await sleep(T.pauseMs)
          ok.push(await gesture([{ n: 60, deltaX: 50 }, { n: 60, deltaX: -50 }]))
          seen.gesturesOk = ok.every(Boolean)
          const r = await p.eval<{ frameP50?: number; frameP95?: number; over33ms?: number; gestureFrames?: number } | null>('window.__mvPerf ? window.__mvPerf.report() : null')
          seen.stats = r && r.gestureFrames ? { p50: r.frameP50 ?? null, p95: r.frameP95 ?? null, over33ms: r.over33ms ?? 0 } : null
        }
      }
      // the records landed before the context goes (an error late in the load is the line's too)
      seen.landed = (await p.eval<boolean>('window.__mvPerfRun ? window.__mvPerfRun.flush() : false', true).catch(() => false)) === true
      const last = await status(p)
      seen.gestures = last?.gestures ?? 0
      seen.postersSkipped = last?.postersSkipped ?? 0
      seen.refusedInPage += last?.refused ?? 0
    } finally {
      clearInterval(heapTimer)
      seen.heapPeakMB = heap ? Math.round((heap / 1_048_576) * 10) / 10 : null
    }
  } catch (e) {
    if (o.signal.aborted || e instanceof Cancelled) seen.cancelled = true
    else if (!b) { runs.end(id); throw e }   // no browser at all: no run happened, and no line says one did
    else seen.crashed = true
  } finally {
    o.signal.removeEventListener('abort', onAbort)
    reg.phase = 'closing'
    try { o.progress({ phase: 'closing', run: id }) } catch { /* the stream is gone */ }
    if (page && b) { seen.crashed ||= page.crashed; await closePage(b, page) }
    if (b) await b.close()
  }
  // the run's work outlives its pages: its queued compiles end now, its running ones are waited for (45 s each at most),
  // and a change event already on its way still lands - only then is the line written, and the next repeat started
  endRunBakes(id)
  await jobsIdle(id, 50_000)
  await sleep(T.watcherLagMs)
  seen.inputsEnd = (await fp())?.hash ?? null
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
