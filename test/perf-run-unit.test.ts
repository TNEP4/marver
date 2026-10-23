import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { closePage, openPage, readRunRequest, runLine, runs, runSeams, runT, RUN_T, serveRun, type RunBrowser, type RunOptions } from '../src/server/perf-run.ts'
import { boardInputs, fingerprint, type InputsWatch } from '../src/server/perf-inputs.ts'
import { basicHost, parseHostSysctl, parseOs, parsePower, profileHash, writeHeadlessProfile } from '../src/server/machine-host.ts'
import { canonical } from '../src/shared/machine.ts'
import { INVALID_REASONS, type RunLine, type RunStreamLine } from '../src/shared/perf-run.ts'
import { cohortOf, runsSummary, within } from '../src/cli/perf-app.ts'
import { ownLoads } from '../src/cli/perf.ts'

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
    const p = await openPage(b, {}, { cache: false, slow: true })
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
    await closePage(b, await openPage(b, {}, { cache: true, slow: false }))
    expect(calls.filter((c) => c.startsWith('Emulation.setCPUThrottlingRate'))).toEqual([])
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
  it('is null before the watcher is ready, and never reads outside the root', async () => {
    const root = temp('mv-inputs-'), other = temp('mv-elsewhere-')
    put(root, 'a.ts', 'a')
    put(other, 'b.ts', 'b')
    expect(await fingerprint(root, watchOf(root, ['a.ts'], false))).toBeNull()
    const w: InputsWatch = { ready: async () => true, watched: () => ({ [root]: ['a.ts'], [other]: ['b.ts'] }) }
    expect((await fingerprint(root, w))?.files).toBe(1)
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
    expect(within(L('x', 1, { loadToSettledMs: 1000, p95: 16 }), L('y', 2, { loadToSettledMs: 1100, p95: 17.5 }))).toBe(true)
    expect(within(L('x', 1, { loadToSettledMs: 1000, p95: 16 }), L('y', 2, { loadToSettledMs: 1101, p95: 16 }))).toBe(false)
  })
  it('--loads keeps a run\'s records out of a person\'s loads, and says how many', () => {
    const r = (o: Record<string, unknown>) => ({ v: 1, ws: 'w', seq: 1, ts: 1, ...o })
    const { records, runLoads } = ownLoads([r({ page: 'p1', load: 'a', kind: 'load' }), r({ page: 'p2', load: 'b', kind: 'load', run: 'x' }), r({ page: 'p2', load: 'b', kind: 'settled', run: 'x' })])
    expect(records.map((x) => x.load)).toEqual(['a'])
    expect(runLoads).toBe(1)
  })
})
