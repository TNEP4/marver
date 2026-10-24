import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { closePage, failureOf, Halt, measureGestures, openPage, readRunRequest, REPORT_FRAMES_MAX, runLine, runs, runSeams, runT, RUN_T, serveRun, timedGesture, type RunBrowser, type RunOptions, type RunPage } from '../src/server/perf-run.ts'
import { boardInputs, fileOfUrl, fingerprint, hashInputs, inputPaths, loadedFiles, type InputsWatch, type ModuleFiles } from '../src/server/perf-inputs.ts'
import { appendRun } from '../src/server/perf.ts'
import { basicHost, hostProfile, parseHostSysctl, parseOs, parsePower, profileHash, spawnOut, writeHeadlessProfile } from '../src/server/machine-host.ts'
import { canonical, readHost, type HostProfile } from '../src/shared/machine.ts'
import { INVALID_REASONS, type RunLine, type RunStreamLine } from '../src/shared/perf-run.ts'
import { cohortOf, runsSummary, within } from '../src/cli/perf-app.ts'
import { ownLoads, perfRunCommand } from '../src/cli/perf.ts'

/**
 * Headless runs' parts that need no browser (spec 28 A3.8 #11, #20-#22, r2 #3): the run request and its stream - the
 * body read whole before a run starts, the client going away the one thing that cancels, a heartbeat, the repeats -
 * the inputs' fingerprint, the host profile, the line's validity in its order, the page's context (--slow throttled
 * before it loads, reset at its end), `--runs`' cohorts and `--loads` keeping run loads out.
 */

const temps: string[] = []
const temp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d }
const put = (root: string, rel: string, body: string) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); return p }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
let server: Server | null = null
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
  runSeams.driver = undefined; runSeams.t = undefined; runSeams.cdp = undefined
  server?.close(); server = null
  for (const r of runs.active()) runs.end(r.id)
})

// ---- the run request and its stream ----------------------------------------------------------------------------

const LINE = (over: Partial<RunLine> = {}): RunLine => ({
  v: 1, script: 1, run: '0123456789abcdef', where: 'headless', ts: 1, board: 'main', inputs: { hash: 'aaaa', files: 3 }, inputsEnd: 'aaaa', frames: 3,
  marver: '0.27.2', chrome: '156.0.1.2', flags: ['--headless=new'], renderer: null, machine: 'm', host: basicHost(), power: 'ac', slow: false, bakes: 'warm',
  postersMissing: 0, saved: null, loadToSettledMs: 1000, settledMs: 900, moves: 0, lateMoves: 0, gestures: 3, p50: 16.7, p95: 16.8, over33ms: 0,
  heapPeakMB: 20, errors: 0, forbidden: 0, refusedInPage: 0, overlapped: false, valid: true, ...over,
})

/** A server whose one route is serveRun, the driver a fake: `drive` sees each run's options. */
async function routeServer(drive: (o: RunOptions) => Promise<RunLine>): Promise<string> {
  runSeams.driver = drive
  server = createServer((req, res) => { void serveRun(req, res, { root: '/nowhere', origin: 'http://x', boards: () => ['main', 'other'] }) })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
const ndjson = (text: string): RunStreamLine[] => text.split('\n').filter(Boolean).map((l) => JSON.parse(l))

describe('POST /api/perf/run', () => {
  it('a request that completes runs to its line - never cancelled by its request\'s close (the body read)', async () => {
    const signals: AbortSignal[] = []
    const url = await routeServer(async (o) => { signals.push(o.signal); o.progress({ phase: 'warm', run: 'r' }); await wait(300); return LINE({ board: o.board, slow: o.slow }) })
    const res = await fetch(`${url}/`, { method: 'POST', body: JSON.stringify({ board: 'main', slow: true }) })
    expect(res.headers.get('content-type')).toBe('application/x-ndjson')
    const lines = ndjson(await res.text())
    expect(lines).toEqual([{ phase: 'warm', run: 'r' }, { line: LINE({ board: 'main', slow: true }) }, { done: true }])
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(false)
  })

  it('a client that drops the connection while the run streams cancels it', async () => {
    let seen: AbortSignal | null = null
    const ended = new Promise<number>((resolve) => {
      void routeServer(async (o) => {
        seen = o.signal
        o.progress({ phase: 'warm', run: 'r' })
        const t0 = Date.now()
        await new Promise((r) => o.signal.addEventListener('abort', r, { once: true }))
        resolve(Date.now() - t0)
        return LINE({ valid: false, invalidReason: 'cancelled' })
      }).then((url) => {
        const req = request(`${url}/`, { method: 'POST' }, (res) => { res.once('data', () => { req.destroy() }) })
        req.end(JSON.stringify({ board: 'main' }))
      })
    })
    expect(await ended).toBeLessThan(2000)
    expect(seen!.aborted).toBe(true)
  })

  it('a body cut short starts no run', async () => {
    let started = 0
    const url = await routeServer(async () => { started++; return LINE() })
    await new Promise<void>((resolve) => {
      const req = request(`${url}/`, { method: 'POST', headers: { 'content-length': '200', 'content-type': 'application/json' } })
      req.on('error', () => resolve())
      req.write('{"board":"ma')
      setTimeout(() => { req.destroy(); setTimeout(resolve, 300) }, 200)
    })
    expect(started).toBe(0)
  })

  it('names a board that exists, repeat 1-5, slow a boolean - else 400, and nothing runs', async () => {
    expect(readRunRequest(JSON.stringify({ board: 'main' }), ['main'])).toEqual({ ok: true, req: { board: 'main', slow: false, repeat: 1 } })
    expect(readRunRequest(JSON.stringify({ board: 'nope' }), ['main', 'b'])).toEqual({ ok: false, error: 'no board "nope" - the boards: main, b' })
    for (const repeat of [0, 6, 1.5, '2']) expect(readRunRequest(JSON.stringify({ board: 'main', repeat }), ['main']).ok).toBe(false)
    expect(readRunRequest(JSON.stringify({ board: 'main', slow: 'yes' }), ['main']).ok).toBe(false)
    expect(readRunRequest('{', ['main']).ok).toBe(false)
    expect(readRunRequest(null, ['main']).ok).toBe(false)
    let started = 0
    const url = await routeServer(async () => { started++; return LINE() })
    const res = await fetch(`${url}/`, { method: 'POST', body: JSON.stringify({ board: 'nope' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/the boards: main, other/)
    expect(started).toBe(0)
  })

  it('a heartbeat keeps a long run\'s stream alive; --repeat runs one after another, each its line', async () => {
    process.env.MARVER_SLOT_BASE ??= '1'
    runSeams.t = { heartbeatMs: 40 }
    let n = 0
    const url = await routeServer(async () => { await wait(150); return LINE({ run: `000000000000000${++n}` }) })
    const lines = ndjson(await (await fetch(`${url}/`, { method: 'POST', body: JSON.stringify({ board: 'main', repeat: 3 }) })).text())
    expect(lines.filter((l) => 'heartbeat' in l).length).toBeGreaterThanOrEqual(3)
    expect(lines.flatMap((l) => ('line' in l ? [l.line.run] : []))).toEqual(['0000000000000001', '0000000000000002', '0000000000000003'])
    expect(lines.at(-1)).toEqual({ done: true })
  })

  it('the suite alone may shorten the driver\'s waits', () => {
    const was = process.env.MARVER_SLOT_BASE
    runSeams.t = { warmMs: 5 }
    try {
      delete process.env.MARVER_SLOT_BASE
      expect(runT().warmMs).toBe(RUN_T.warmMs)
      process.env.MARVER_SLOT_BASE = '6000'
      expect(runT().warmMs).toBe(5)
    } finally { if (was === undefined) delete process.env.MARVER_SLOT_BASE; else process.env.MARVER_SLOT_BASE = was }
  })
})

// ---- `marver perf run`, the CLI's half of the stream ---------------------------------------------------------------

describe('marver perf run (the CLI)', () => {
  const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb'
  /** A dev server whose perf/run streams `lines` as serveRun writes them and ends; its other answers 200 (it stays up).
   *  The repo's dev.json points at it. */
  async function stubDev(lines: RunStreamLine[]): Promise<string> {
    server = createServer((req, res) => {
      if (!req.url?.startsWith('/__mv/api/perf/run')) return void res.end('up')
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      for (const l of lines) res.write(JSON.stringify(l) + '\n')
      res.end()
    })
    await new Promise<void>((r) => server!.listen(0, r))   // both families: the CLI asks for localhost
    const root = temp('mv-perfcli-')
    put(root, 'design/.local/dev.json', JSON.stringify({ port: (server.address() as { port: number }).port, token: 't' }))
    return root
  }
  /** The command, its console.log lines kept. */
  async function cli(root: string, opts: { json?: boolean; repeat?: number } = {}): Promise<{ code?: number; error?: Error; out: string[]; ms: number }> {
    const out: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
    const t0 = Date.now()
    try { return { code: await perfRunCommand(root, 'main', opts), out, ms: Date.now() - t0 } }
    catch (e) { return { error: e as Error, out, ms: Date.now() - t0 } }
    finally { log.mockRestore() }
  }
  const NO_CHROME = 'no Chrome/Chromium found - install one or set MARVER_CHROME to a browser binary'

  it('a run the server failed before it had a line (no Chrome) ends the command at once, with the server\'s reason - never 90 s waiting for a line, never "did marver dev stop?"', async () => {
    // exactly what serveRun writes when runOnce throws before a browser exists: the warm phase, the closing phase, the error
    const root = await stubDev([{ phase: 'warm', run: A }, { phase: 'closing', run: A }, { error: NO_CHROME }])
    const r = await cli(root)
    expect(r.error?.message).toBe(`the run failed in the dev server: ${NO_CHROME}`)
    expect(r.ms).toBeLessThan(2000)
    expect(r.out.join('\n')).not.toMatch(/dropped/)
  })

  it('--json: the runs before the failure and the server\'s reason, on stdout, exit 1 - a repeat that failed loses nothing before it', async () => {
    const root = await stubDev([{ phase: 'warm', run: A }, { phase: 'measured', run: A }, { phase: 'closing', run: A }, { line: LINE({ run: A }) }, { phase: 'warm', run: B }, { phase: 'closing', run: B }, { error: NO_CHROME }])
    const r = await cli(root, { json: true, repeat: 2 })
    expect(r.code).toBe(1)
    expect(r.ms).toBeLessThan(2000)
    expect(JSON.parse(r.out.join('\n'))).toEqual({ runs: [LINE({ run: A })], error: `the run failed in the dev server: ${NO_CHROME}` })
  })

  it('a stream that ends quietly before its done, under a run, waits for that run\'s line in runs.jsonl', async () => {
    const root = await stubDev([{ phase: 'warm', run: A }, { phase: 'measured', run: A }])
    setTimeout(() => appendRun(root, LINE({ run: A, ts: Date.now() }) as unknown as Record<string, unknown>), 400)
    const r = await cli(root)
    expect(r.error).toBeUndefined()
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toMatch(/the connection to the dev server dropped - waiting for the run's line/)
    expect(r.out.join('\n')).toMatch(new RegExp(`run ${A} .* bakes warm`))
  })
})

// ---- the page's context ------------------------------------------------------------------------------------------

describe('a run\'s page', () => {
  it('--slow throttles the CPU before anything loads, and the end resets it before the context goes', async () => {
    const calls: string[] = []
    let seq = 0
    const b: RunBrowser = {
      send: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push(method === 'Emulation.setCPUThrottlingRate' ? `${method} ${params.rate}` : method)
        if (method === 'Target.createBrowserContext') return { browserContextId: 'ctx' }
        if (method === 'Target.createTarget') return { targetId: `t${++seq}` }
        if (method === 'Target.attachToTarget') return { sessionId: 's1' }
        return {}
      },
      on: () => () => {},
      abort: () => {},
    } as unknown as RunBrowser
    const p = await openPage(b, { cache: false, slow: true })
    await p.send('Page.navigate', { url: 'http://x/' })
    await closePage(b, p)
    const at = (m: string) => calls.indexOf(m)
    expect(at('Emulation.setCPUThrottlingRate 4')).toBeGreaterThan(-1)
    expect(at('Emulation.setCPUThrottlingRate 4')).toBeLessThan(at('Page.navigate'))
    expect(at('Emulation.setDeviceMetricsOverride')).toBeLessThan(at('Page.navigate'))
    expect(at('Emulation.setCPUThrottlingRate 1')).toBeGreaterThan(at('Page.navigate'))
    expect(at('Emulation.setCPUThrottlingRate 1')).toBeLessThan(at('Target.disposeBrowserContext'))
    expect(calls).toContain('Network.setCacheDisabled')
    // without --slow nothing is throttled, and nothing reset
    calls.length = 0
    await closePage(b, await openPage(b, { cache: true, slow: false }))
    expect(calls.filter((c) => c.startsWith('Emulation.setCPUThrottlingRate'))).toEqual([])
  })

  /** A browser as cdp.ts's: calls settle with their answer, or never - and `abort(owner)` settles that owner's calls
   *  waiting and every later one. `hang(method)` decides which never answer. */
  function fakeBrowser(hang: (method: string) => boolean) {
    const pending = new Map<number, { owner?: object; reject: (e: Error) => void }>()
    const aborted = new WeakMap<object, string>()
    let seq = 0
    const b = {
      send: (method: string, _params: Record<string, unknown> = {}, _sid?: string, owner?: object) => new Promise<any>((resolve, reject) => {
        const gone = owner && aborted.get(owner)
        if (gone) return reject(new Error(`${method}: ${gone}`))
        if (method === 'Target.createBrowserContext') return resolve({ browserContextId: 'ctx' })
        if (method === 'Target.createTarget') return resolve({ targetId: 't' })
        if (method === 'Target.attachToTarget') return resolve({ sessionId: 's' })
        if (!hang(method)) return resolve(method === 'Runtime.evaluate' ? { result: { value: 'answered' } } : {})
        pending.set(++seq, { owner, reject })
      }),
      on: () => () => {},
      abort: (owner: object, why: string) => { aborted.set(owner, why); for (const [k, p] of pending) if (p.owner === owner) { pending.delete(k); p.reject(new Error(why)) } },
    }
    return { b: b as unknown as RunBrowser, waiting: () => pending.size }
  }

  it('a call the page never answers settles at callMs: the page is stalled, its calls waiting settle, and every later one at once', async () => {
    process.env.MARVER_SLOT_BASE ??= '1'
    runSeams.t = { callMs: 150 }
    let hung = false
    const { b, waiting } = fakeBrowser((m) => hung && m !== 'Target.disposeBrowserContext' && m !== 'Emulation.setCPUThrottlingRate')
    const p = await openPage(b, { cache: false, slow: false })
    expect(await p.eval('1')).toBe('answered')
    // the main thread stops (a frame's endless loop): a status read, three wheel events and a heap sample wait
    hung = true
    const t0 = Date.now()
    const status = p.eval('status()').then(() => 'answered', (e) => e)
    const others = [p.send('Input.dispatchMouseEvent'), p.send('Input.dispatchMouseEvent'), p.send('Runtime.getHeapUsage')].map((x) => x.then(() => 'answered', (e: Error) => e.message))
    const e = await status
    expect(e).toBeInstanceOf(Halt)
    expect((e as Halt).why).toBe('unresponsive')
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(p.stalled).toBe(true)
    expect((await Promise.all(others)).every((m) => m !== 'answered')).toBe(true)
    expect(waiting()).toBe(0)
    // a later call does not wait for its own callMs
    const t1 = Date.now()
    await expect(p.send('Runtime.getHeapUsage')).rejects.toThrow(/stopped answering/)
    expect(Date.now() - t1).toBeLessThan(50)
    await closePage(b, p)   // bounded, never throws
  })

  it('the run halting (a cancel, its cap) settles every call of its pages at once - a page being opened too', async () => {
    const { b } = fakeBrowser((m) => m === 'Runtime.evaluate')
    const halt = new AbortController()
    const p = await openPage(b, { cache: true, slow: false, halt: halt.signal })
    const t0 = Date.now()
    const waiting = p.eval('status()').then(() => 'answered', (e: Error) => e.message)
    halt.abort('cancelled')
    expect(await waiting).toBe('cancelled')
    expect(Date.now() - t0).toBeLessThan(100)
    expect(p.stalled).toBe(false)
    // a page opened after the halt: its first call settles at once
    await expect(openPage(b, { cache: true, slow: false, halt: halt.signal })).rejects.toThrow(/cancelled/)
  })
})

// ---- the driver's gestures and its failures ----------------------------------------------------------------------

describe('the driver', () => {
  /**
   * A measured page as the shell answers the driver, after perf.ts: one gesture runs while the camera moves - the
   * fit's motion (`fitMs`, for ever with Infinity) or a wheel series (ended 60 ms after its last event) - and ends when
   * it stops, its frames pushed then (the fit's 100 ms each, a wheel's 16 ms), even after a reset(). fit() answers
   * `fitAnswer` at once, as the shell's does after its own 3 s.
   */
  function fakePage(o: { fitAnswer: boolean; fitMs: number }) {
    let fitMoving = false, wheelMoving = false, gestures = 0
    let g: { fit: boolean; wheel: boolean } | null = null
    let frames: number[] = []
    let wheelEnd: ReturnType<typeof setTimeout> | undefined
    const moving = () => fitMoving || wheelMoving
    const update = () => {
      if (moving()) { g ??= { fit: false, wheel: false }; g.fit ||= fitMoving; g.wheel ||= wheelMoving; return }
      if (!g) return
      if (g.fit) frames.push(...Array(5).fill(100))
      if (g.wheel) frames.push(...Array(10).fill(16))
      g = null; gestures++
    }
    const pct = (q: number) => { const s = [...frames].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0 }
    const evaluate = (x: string): unknown => {
      if (x.includes('status()')) return { gestures, moving: moving() }
      if (x.includes('fit()')) {
        fitMoving = true; update()
        if (Number.isFinite(o.fitMs)) setTimeout(() => { fitMoving = false; update() }, o.fitMs)
        return o.fitAnswer
      }
      if (x.includes('centre()')) return { x: 720, y: 450 }
      if (x.includes('reset()')) { frames = []; return undefined }
      if (x.includes('report()')) return { gestureFrames: frames.length, frameP50: pct(0.5), frameP95: pct(0.95), over33ms: frames.filter((f) => f > 33).length }
      return undefined
    }
    const page: RunPage = {
      context: 'c', session: 's', slow: false, crashed: false, stalled: false, stop: () => {},
      send: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseWheel') {
          wheelMoving = true; update()
          clearTimeout(wheelEnd)
          wheelEnd = setTimeout(() => { wheelMoving = false; update() }, 60)
        }
        return {}
      },
      eval: async <T,>(x: string) => evaluate(x) as T,
    }
    return { page, pageGestures: () => gestures }
  }
  const quick = () => { process.env.MARVER_SLOT_BASE ??= '1'; runSeams.t = { eventMs: 1, pauseMs: 5, gestureEndMs: 1000, statusMs: 5 } }

  it('a fit not at rest when it answers is waited for before the frames are reset: its motion is in neither the frames nor the gestures, which are the driver\'s three', async () => {
    quick()
    const { page, pageGestures } = fakePage({ fitAnswer: false, fitMs: 400 })
    const m = await measureGestures(page, () => {})
    expect(m.gesturesOk).toBe(true)
    expect(m.gestures).toBe(3)
    expect(pageGestures(), 'the page counted the fit\'s own').toBe(4)
    // only the three wheel gestures' frames: none of the fit's 100 ms ones
    expect(m.stats).toEqual({ p50: 16, p95: 16, over33ms: 0 })
  })

  it('a fit that never comes to rest makes the run invalid (gesture): no gesture ends, none is counted', async () => {
    quick()
    const { page } = fakePage({ fitAnswer: false, fitMs: Infinity })
    const m = await measureGestures(page, () => {})
    expect(m.gesturesOk).toBe(false)
    expect(m.gestures).toBe(0)
  })

  it('only a crash is crash: a page script that threw is cut by the driver, its reason said; a halt is its own cut; a client gone is cancelled', () => {
    const at = { clientGone: false, halted: null, stalled: false, browser: 'alive' as const, pageCrashed: false }
    expect(failureOf(new Error('the page threw: TypeError: Cannot read properties of undefined (reading \'status\')'), at))
      .toEqual({ cut: 'driver: the page threw: TypeError: Cannot read properties of undefined (reading \'status\')' })
    expect(failureOf(new TypeError('c is undefined'), at)).toEqual({ cut: 'driver: c is undefined' })
    expect(failureOf(new Error('x'), { ...at, pageCrashed: true })).toEqual({ crashed: true })
    expect(failureOf(new Error('Target.createTarget: the browser exited (SIGSEGV)'), { ...at, browser: 'dead' })).toEqual({ crashed: true })
    expect(failureOf(new Error('no Chrome/Chromium found'), { ...at, browser: 'none' })).toBeNull()
    expect(failureOf(new Halt('unresponsive'), { ...at, pageCrashed: true })).toEqual({ cut: 'unresponsive' })
    expect(failureOf(new Error('x'), { ...at, stalled: true })).toEqual({ cut: 'unresponsive' })
    expect(failureOf(new Error('x'), { ...at, halted: 'overrun' })).toEqual({ cut: 'overrun' })
    expect(failureOf(new Error('x'), { ...at, clientGone: true, pageCrashed: true })).toEqual({ cancelled: true })
    expect((failureOf(new Error('y'.repeat(1000)), at) as { cut: string }).cut).toHaveLength('driver: '.length + 300)
  })
})

// ---- the line --------------------------------------------------------------------------------------------------

describe('the run line', () => {
  const reg = (over: Partial<ReturnType<typeof runs.register>> = {}) => ({ ...runs.register('main', 'abcdefabcdefabcd'), ...over })
  const rec = (kind: string, body: Record<string, unknown> = {}, load = 'L1') => ({ v: 1, ws: 'w', page: 'p', load, seq: Math.random(), ts: 1, kind, ...body })
  const good = () => [rec('load', { cause: 'boot', request: 'L1', sinceNav: 140 }), rec('commit', { frames: 3, measuring: 1, savedHeights: 1 }), rec('move', {}), rec('move', { late: true }), rec('settled', { ms: 860, missing: 0, neverReady: 0 })]
  const seen = (over: Record<string, unknown> = {}) => ({
    id: 'abcdefabcdefabcd', board: 'main', slow: false, startedAt: 5, inputs: { hash: 'h', files: 2 }, inputsEnd: 'h', chrome: '156', renderer: null,
    machine: 'm', host: basicHost(), power: 'ac' as const, bakes: 'warm' as const, cancelled: false, crashed: false, bakesMissed: false, gestures: 3,
    gesturesOk: true, stats: { p50: 16.7, p95: 16.8, over33ms: 0 }, heapPeakMB: 12, landed: true, postersSkipped: 0, refusedInPage: 4, ...over,
  })
  it('takes the boot load\'s numbers: from navigation start to settled, the commit\'s frames and saved heights, moves and late moves', () => {
    const l = runLine(reg({ records: good() }), seen())
    expect(l).toMatchObject({ valid: true, loadToSettledMs: 1000, settledMs: 860, frames: 3, saved: { measuring: 1, savedHeights: 1 }, moves: 1, lateMoves: 1, gestures: 3, p95: 16.8, refusedInPage: 4, ts: 5 })
    expect(l.invalidReason).toBeUndefined()
  })
  it('is invalid for the first reason that holds, in their order', () => {
    expect(INVALID_REASONS).toEqual(['cancelled', 'crash', 'inputs', 'writes', 'cut', 'frames', 'errors', 'bakes', 'gesture', 'records'])
    const all = { cancelled: true, crashed: true, inputsEnd: 'other', cut: 'timeout', bakesMissed: true, gesturesOk: false, landed: false }
    const records = [...good().slice(0, 4), rec('settled', { ms: 860, missing: 1, neverReady: 0 }), rec('error', { message: 'x' })]
    const order: [string, Record<string, unknown>, Partial<ReturnType<typeof runs.register>>][] = []
    let s: Record<string, unknown> = { ...all }, r: Partial<ReturnType<typeof runs.register>> = { forbidden: 1, records }
    order.push(['cancelled', s, r])
    s = { ...s, cancelled: false }; order.push(['crash', s, r])
    s = { ...s, crashed: false }; order.push(['inputs', s, r])
    s = { ...s, inputsEnd: 'h' }; order.push(['writes', s, r])
    r = { ...r, forbidden: 0 }; order.push(['cut', s, r])
    s = { ...s, cut: undefined }; order.push(['frames', s, r])
    r = { ...r, records: [...good().slice(0, 4), rec('settled', { ms: 860, missing: 0, neverReady: 0 }), rec('error', { message: 'x' })] }; order.push(['errors', s, r])
    r = { ...r, records: good() }; order.push(['bakes', s, r])
    s = { ...s, bakesMissed: false }; order.push(['gesture', s, r])
    s = { ...s, gesturesOk: true }; order.push(['records', s, r])
    for (const [why, sv, rv] of order) {
      const l = runLine(reg(rv), seen(sv))
      expect([why, l.valid, l.invalidReason]).toEqual([why, false, why])
      runs.end('abcdefabcdefabcd')
    }
    // a sticky change, an unknown fingerprint, no settled record: each invalid
    expect(runLine(reg({ records: good(), inputsChanged: '/r/a.tsx' }), seen()).invalidReason).toBe('inputs'); runs.end('abcdefabcdefabcd')
    expect(runLine(reg({ records: good() }), seen({ inputs: null })).invalidReason).toBe('inputs'); runs.end('abcdefabcdefabcd')
    expect(runLine(reg({ records: good().slice(0, 4) }), seen()).invalidReason).toBe('records')
  })
  it('a run without frame times is no measurement: invalid (gesture), its over33ms null - never "no slow frames"', () => {
    const l = runLine(reg({ records: good() }), seen({ stats: null }))
    expect(l).toMatchObject({ valid: false, invalidReason: 'gesture', p50: null, p95: null, over33ms: null })
    runs.end('abcdefabcdefabcd')
    expect(runLine(reg({ records: good() }), seen()).over33ms).toBe(0)
    runs.end('abcdefabcdefabcd')
    // a gesture is timed with two intervals or more (perf.ts's own rule for a gesture it records)
    expect(timedGesture(10, 11)).toBe(false)
    expect(timedGesture(10, 12)).toBe(true)
    expect(timedGesture(0, 0)).toBe(false)
    expect(timedGesture(REPORT_FRAMES_MAX, REPORT_FRAMES_MAX)).toBe(true)   // a full report: rAF ran plenty
  })
  it('records the page lost (its queue\'s bound, a send that never landed) make it invalid (records); the errors past 50 are errors\'', () => {
    expect(runLine(reg({ records: [...good(), rec('dropped', { n: 3 })] }), seen())).toMatchObject({ valid: false, invalidReason: 'records' })
    runs.end('abcdefabcdefabcd')
    expect(runLine(reg({ records: [...good(), rec('dropped', { n: 1, reason: 'errors' })] }), seen()).valid).toBe(true)
    runs.end('abcdefabcdefabcd')
  })
  it('records the collector refused past its bound count as lost: invalid (records) - never a valid line with moves or errors missing', () => {
    const r = runs.register('main', 'abcdefabcdefabcd')
    runs.records(r.id, good())
    runs.records(r.id, Array.from({ length: 20_000 }, () => rec('move', {})))
    expect(r.records).toHaveLength(20_000)
    expect(r.overflow).toBe(good().length)
    expect(runLine(r, seen())).toMatchObject({ valid: false, invalidReason: 'records' })
    runs.end('abcdefabcdefabcd')
    expect(runLine(reg({ records: good() }), seen()).valid).toBe(true)
    runs.end('abcdefabcdefabcd')
  })
  it('a compile of the run still running past its end\'s wait is said, the run itself still valid', () => {
    const l = runLine(reg({ records: good() }), seen({ bakesPending: true }))
    expect(l).toMatchObject({ valid: true, bakesPending: true })
    runs.end('abcdefabcdefabcd')
    expect(runLine(reg({ records: good() }), seen()).bakesPending).toBeUndefined()
    runs.end('abcdefabcdefabcd')
  })
  it('a run the dev server\'s in-place restart ended says inputs, never cancelled, and says it restarted', () => {
    const r = runs.register('main', 'abcdefabcdefabcd')   // the registered object itself: the restart marks it
    r.records.push(...good())
    runs.restarted()
    expect(r.restarted).toBe(true)
    expect(r.inputsChanged).toBe('(the dev server restarted)')
    const l = runLine(r, seen({ cancelled: true, inputsEnd: 'other' }))
    expect(l).toMatchObject({ valid: false, invalidReason: 'inputs', restarted: true })
    runs.end('abcdefabcdefabcd')
    // a client that went away is still a cancel
    expect(runLine(reg({ records: good() }), seen({ cancelled: true }))).toMatchObject({ invalidReason: 'cancelled' })
    expect(runLine(reg({ records: good() }), seen({ cancelled: true })).restarted).toBeUndefined()
  })
})

// ---- the inputs --------------------------------------------------------------------------------------------------

describe('the inputs\' fingerprint', () => {
  const watchOf = (root: string, files: string[], ready = true): InputsWatch => ({
    ready: async () => ready,
    watched: () => { const w: Record<string, string[]> = {}; for (const f of files) { const p = join(root, f); (w[dirname(p)] ??= []).push(p.slice(dirname(p).length + 1)) } return w },
  })
  it('hashes every watched file under the root by path, size and mtime - with the board files and _sizes.json the watcher ignores', async () => {
    const root = temp('mv-inputs-')
    put(root, 'design/scenes/a.tsx', 'a')
    put(root, 'design/components/c.tsx', 'c')
    put(root, 'src/generated/tone.ts', 'x')   // git-ignored: still an input
    put(root, 'design/boards/main.json', '{}')
    put(root, 'design/boards/_sizes.json', '{}')
    mkdirSync(join(root, 'design', 'scenes', 'sub'))
    const files = ['design/scenes/a.tsx', 'design/components/c.tsx', 'src/generated/tone.ts', 'design/scenes/sub']
    const w = watchOf(root, files)
    const a = await fingerprint(root, w)
    expect(a?.files).toBe(5)   // the directory is no input; the two board files are
    expect(boardInputs(root).map((p) => p.slice(root.length + 1)).sort()).toEqual(['design/boards/_sizes.json', 'design/boards/main.json'])
    expect((await fingerprint(root, w))?.hash).toBe(a!.hash)
    // an edit, a layout, a saved height, an ignored import: each changes it - and an edit undone still shows, by its mtime
    const step = async (change: () => void) => { const before = (await fingerprint(root, w))!.hash; change(); const after = (await fingerprint(root, w))!.hash; expect(after).not.toBe(before) }
    await step(() => put(root, 'design/components/c.tsx', 'cc'))
    await step(() => put(root, 'design/boards/main.json', '{"nodes":[]}'))
    await step(() => put(root, 'design/boards/_sizes.json', '{"h":1}'))
    await step(() => put(root, 'src/generated/tone.ts', 'y'))
    const p = join(root, 'design', 'scenes', 'a.tsx')
    const st = statSync(p)
    await step(() => { writeFileSync(p, 'a'); utimesSync(p, st.atime, new Date(st.mtimeMs + 5000)) })
  })
  it('is null before the watcher is ready; reads a watched file outside the root (a sibling package a frame imports) by its path from the root', async () => {
    const root = temp('mv-inputs-'), other = temp('mv-elsewhere-')
    put(root, 'a.ts', 'a')
    put(other, 'b.ts', 'b')
    expect(await fingerprint(root, watchOf(root, ['a.ts'], false))).toBeNull()
    expect(await inputPaths(root, watchOf(root, ['a.ts'], false))).toBeNull()
    const w: InputsWatch = { ready: async () => true, watched: () => ({ [root]: ['a.ts'], [other]: ['b.ts'] }) }
    const a = (await fingerprint(root, w))!
    expect(a.files).toBe(2)
    // an edit there changes it, as the sticky flag hears it (the same watcher)
    put(other, 'b.ts', 'bb')
    expect((await fingerprint(root, w))!.hash).not.toBe(a.hash)
  })
  it('a run hashes its own set again at its end: a file the watcher adds later (a frame\'s import loaded) changes nothing; an edit, or a file gone, does', async () => {
    const root = temp('mv-inputs-'), other = temp('mv-elsewhere-')
    put(root, 'a.ts', 'a')
    put(other, 'b.ts', 'b')
    const watched: Record<string, string[]> = { [root]: ['a.ts'] }
    const w: InputsWatch = { ready: async () => true, watched: () => watched }
    const set = (await inputPaths(root, w))!
    const start = await hashInputs(root, set)
    watched[other] = ['b.ts']   // the page loaded it: the watcher watches it from now on
    expect((await hashInputs(root, set)).hash).toBe(start.hash)
    expect((await fingerprint(root, w))!.hash).not.toBe(start.hash)   // the next run's set has it
    put(root, 'a.ts', 'aa')
    expect((await hashInputs(root, set)).hash).not.toBe(start.hash)
    rmSync(join(root, 'a.ts'))
    expect(await hashInputs(root, set)).toMatchObject({ files: 0 })
  })
})

describe('a run\'s own inputs', () => {
  it('outside the root are its page\'s: another page\'s sibling files - watched since it loaded them - stay out, so two runs of a board with nothing changed agree', async () => {
    const root = temp('mv-inputs-'), sib = temp('mv-sibling-')
    put(root, 'design/scenes/a.tsx', 'a')
    put(root, 'design/boards/main.json', '{}')
    for (const [f, body] of [['a/ui.ts', 'ui-a'], ['a/ui.css', 'css'], ['a/base.css', 'base'], ['b/ui.ts', 'ui-b'], ['tsconfig.json', '{}'], ['b/tsconfig.json', '{}']]) put(sib, f, body)
    const watched: Record<string, string[]> = { [join(root, 'design', 'scenes')]: ['a.tsx'], [join(sib, 'a')]: ['ui.ts', 'ui.css', 'base.css'], [sib]: ['tsconfig.json'] }
    // Vite's module graph: a's stylesheet inlines base.css - an imported module there, never a request of the page
    const graph: ModuleFiles = { getModulesByFile: (f) => (f === join(sib, 'a', 'ui.css') ? [{ importedModules: [{ file: join(sib, 'a', 'base.css') }] }] : undefined) }
    const w: InputsWatch = { ready: async () => true, watched: () => watched, loaded: (urls) => loadedFiles(urls, root, graph) }
    // the warm-up page's requests: the shell, a frame's module, a's source and stylesheet by /@fs/, Vite's own client
    const urls = ['/', '/design/scenes/a.tsx?t=1', `/@fs${join(sib, 'a', 'ui.ts')}?v=3`, `/@fs${join(sib, 'a', 'ui.css')}?direct`, '/@vite/client'].map((u) => `http://localhost:5300${u}`)
    const set = async () => hashInputs(root, (await inputPaths(root, w, urls))!)
    const first = await set()
    // a.tsx and the board; a's source, stylesheet and its inlined @import; the tsconfig in a folder above them
    expect(first.files).toBe(6)
    // a normal tab opens board b: the watcher watches its sibling files - and their tsconfig - from now on
    watched[join(sib, 'b')] = ['ui.ts', 'tsconfig.json']
    expect(await set()).toEqual(first)
    // every watched file, as GET /api/perf/inputs reads without a run: b's are in it
    expect((await fingerprint(root, w))!.files).toBe(8)
    // an edit to the inlined stylesheet, or to the tsconfig above a's files, still changes the run's
    put(sib, 'a/base.css', 'base2')
    const edited = await set()
    expect(edited.hash).not.toBe(first.hash)
    put(sib, 'tsconfig.json', '{"compilerOptions":{}}')
    expect((await set()).hash).not.toBe(edited.hash)
    // and with no requests at all (the start's fingerprint) nothing outside the root is in it
    expect((await hashInputs(root, (await inputPaths(root, w, []))!)).files).toBe(2)
  })
  it('reads a request URL as the dev server does: /@fs/ outside the root, a path under Vite\'s root, never Vite\'s own ids', () => {
    expect(fileOfUrl('http://localhost:5300/@fs/Users/me/ui/a.ts?v=1', '/r')).toBe('/Users/me/ui/a.ts')
    expect(fileOfUrl('http://localhost:5300/@fs/Users/me/a%20b.ts', '/r')).toBe('/Users/me/a b.ts')
    expect(fileOfUrl('http://localhost:5300/design/scenes/a.tsx?t=5&import', '/r')).toBe('/r/design/scenes/a.tsx')
    expect(fileOfUrl('http://localhost:5300/base/x.ts', '/r', '/base/')).toBe('/r/x.ts')
    expect(fileOfUrl('http://localhost:5300/@vite/client', '/r')).toBeNull()
    expect(fileOfUrl('http://localhost:5300/@id/react', '/r')).toBeNull()
  })
})

// ---- the host ----------------------------------------------------------------------------------------------------

describe('the host profile', () => {
  it('reads sysctl\'s three lines, or nothing of them; sw_vers; pmset\'s source', () => {
    expect(parseHostSysctl('6\n12\nMac17,8\n')).toEqual({ p: 6, e: 12, model: 'Mac17,8' })
    expect(parseHostSysctl('Mac14,2\n')).toEqual({ p: 'unknown', e: 'unknown', model: 'unknown' })   // an Intel Mac: the perflevels missing shift the lines
    expect(parseHostSysctl(null)).toEqual({ p: 'unknown', e: 'unknown', model: 'unknown' })
    expect(parseOs('26.6.2\n')).toBe('26.6.2')
    expect(parseOs('')).toBe('unknown')
    expect(parsePower("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged")).toBe('ac')
    expect(parsePower("Now drawing from 'Battery Power'")).toBe('battery')
    expect(parsePower('something else')).toBe('unknown')
  })
  it('reads a host through the one reader the app reads its own with (src/shared/machine.ts readHost): one vector both suites can check', async () => {
    const base: HostProfile = { chip: 'Apple M5 Pro', cores: { total: 18, p: 'unknown', e: 'unknown' }, model: 'unknown', memGB: 48, os: 'unknown', arch: 'arm64' }
    const answers: Record<string, (string | null)[]> = { '/usr/sbin/sysctl': [null, '6\n12\nMac17,8\n'], '/usr/bin/sw_vers': ['26.6.2\n'] }
    const asked: string[] = []
    const host = await readHost(base, async (file, args) => { asked.push(`${file} ${args.join(' ')}`); const a = answers[file]; return a.length > 1 ? a.shift()! : a[0] })
    expect(host).toEqual({ ...base, cores: { total: 18, p: 6, e: 12 }, model: 'Mac17,8', os: '26.6.2' })
    // sha256 of the canonical JSON, computed apart from this code: {"arch":"arm64","chip":"Apple M5 Pro","cores":{"e":12,"p":6,"total":18},"memGB":48,"model":"Mac17,8","os":"26.6.2"}
    expect(profileHash(host)).toBe('b86295f46845ddd3')
    // the sysctl that failed once was asked again: one busy moment never gives a host a hash of its own
    expect(asked.filter((a) => a.startsWith('/usr/sbin/sysctl -n hw.perflevel0.physicalcpu hw.perflevel1.physicalcpu hw.model'))).toHaveLength(2)
    // and this Mac's host, read by a run, is that reader's with this module's spawns
    if (process.platform === 'darwin') expect(await hostProfile()).toEqual(await readHost(basicHost(), (f, a) => spawnOut(f, a)))
  })
  it('is written once per distinct profile, 700/600, under the hash the app computes alike; written again it is touched', async () => {
    const home = temp('mv-home-')
    const a = await writeHeadlessProfile(home)
    const file = join(home, 'perf', 'machine', `${a.hash}.json`)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved).toEqual(a.profile)
    expect(a.profile).toMatchObject({ v: 1, kind: 'headless' })
    expect(a.hash).toBe(profileHash(a.profile))
    expect(a.profile.hostHash).toBe(profileHash(a.profile.host))
    expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, 'perf', 'machine')).mode & 0o777).toBe(0o700)
    if (process.platform === 'darwin') expect(a.profile.host.os).toMatch(/^\d+/)
    const past = new Date(Date.now() - 60_000)
    utimesSync(file, past, past)
    const b = await writeHeadlessProfile(home)
    expect(b.hash).toBe(a.hash)
    expect(statSync(file).mtimeMs).toBeGreaterThan(past.getTime() + 1000)
  })
})

// ---- `--runs` and `--loads` -----------------------------------------------------------------------------------

describe('marver perf --runs', () => {
  const L = (run: string, ts: number, over: Partial<RunLine> = {}) => LINE({ run, ts, ...over })
  it('compares inside a cohort only: the latest against the one before with its inputs (within 10 %), and against the last with other inputs', () => {
    const runs = [
      L('a', 1, { inputs: { hash: 'h1', files: 1 }, loadToSettledMs: 1000, p95: 16.8 }),
      L('b', 2, { inputs: { hash: 'h2', files: 1 }, loadToSettledMs: 1400, p95: 20 }),
      L('c', 3, { inputs: { hash: 'h2', files: 1 }, loadToSettledMs: 1450, p95: 20.5 }),
      L('d', 4, { slow: true }),                                      // another cohort
      L('e', 5, { overlapped: true }),                                 // never compared
      L('f', 6, { valid: false, invalidReason: 'inputs' }),            // listed apart
      L('g', 7, { chrome: '157.0.0.1' }),                              // another Chrome: another cohort
    ]
    const s = runsSummary(runs)
    const main = s.boards.find((b) => b.board === 'main' && b.cohort.slow === false && b.cohort.chrome === '156.0.1.2')!
    expect(main.latest.run).toBe('c')
    expect(main.runs).toBe(3)
    expect(main.sameInputs).toMatchObject({ from: { run: 'b' }, within10: true })
    expect(main.afterChange).toMatchObject({ from: { run: 'a' }, deltas: { loadToSettledMs: 450, p95: 3.7 } })
    expect(s.boards).toHaveLength(3)
    expect(s.overlapped.map((r) => r.run)).toEqual(['e'])
    expect(s.invalid.map((r) => r.run)).toEqual(['f'])
    expect(cohortOf(runs[0])).toEqual({ script: 1, board: 'main', chrome: '156.0.1.2', flags: ['--headless=new'], machine: 'm', power: 'ac', slow: false, bakes: 'warm' })
    // --against: the latest of its cohort against it, whatever their inputs
    expect(runsSummary(runs, { against: 'a' }).against).toMatchObject({ run: 'a', to: { run: 'c' }, within10: false })
    expect(runsSummary(runs, { against: 'e' }).against).toMatchObject({ error: expect.stringMatching(/overlapped/) })
    expect(runsSummary(runs, { against: 'zz' }).against).toMatchObject({ error: 'no such run in the window' })
    // always from the earlier run to a later one: the latest itself has none later - never the deltas reversed
    expect(runsSummary(runs, { against: 'b' }).against).toMatchObject({ run: 'b', from: { run: 'b' }, to: { run: 'c' }, deltas: { loadToSettledMs: 50 } })
    expect(runsSummary(runs, { against: 'c' }).against).toMatchObject({ run: 'c', error: expect.stringMatching(/^no later valid run of its cohort/) })
    expect(within(L('x', 1, { loadToSettledMs: 1000, p95: 16 }), L('y', 2, { loadToSettledMs: 1100, p95: 17.5 }))).toBe(true)
    expect(within(L('x', 1, { loadToSettledMs: 1000, p95: 16 }), L('y', 2, { loadToSettledMs: 1101, p95: 16 }))).toBe(false)
    // an over33ms not measured (an older invalid line) compares as unknown, never as 0
    const nulls = runsSummary([L('a', 1, { inputs: { hash: 'h1', files: 1 }, over33ms: null }), L('b', 2, { inputs: { hash: 'h2', files: 1 }, over33ms: 2 })])
    expect(nulls.boards[0].afterChange?.deltas.over33ms).toBeNull()
  })
  it('--loads keeps a run\'s records out of a person\'s loads, and says how many', () => {
    const r = (o: Record<string, unknown>) => ({ v: 1, ws: 'w', seq: 1, ts: 1, ...o })
    const { records, runLoads } = ownLoads([r({ page: 'p1', load: 'a', kind: 'load' }), r({ page: 'p2', load: 'b', kind: 'load', run: 'x' }), r({ page: 'p2', load: 'b', kind: 'settled', run: 'x' })])
    expect(records.map((x) => x.load)).toEqual(['a'])
    expect(runLoads).toBe(1)
  })
})
