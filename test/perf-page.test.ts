import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiMiddleware } from '../src/server/api.ts'
import { ROUTE } from '../src/cli/name.ts'
import { cleanPageRecord, logPage, logReload, pageLog, perfDir, readPage, reloadLog, tidyPerfDir } from '../src/server/perf.ts'

/**
 * The recorder's page half, its server side (spec 28 A1.7): every record rebuilt from its kind's allowlist, the log
 * the owner's alone (700/600 from creation, existing files tightened at start), aged out after 14 days and held
 * under 8 MB (the other logs 2 MB), and the owner-gated route that takes a page's batch. The page's own half is page-recorder-browser.test.ts.
 */

const SENTINEL = 'PURPLE-ELEPHANT-SECRET'
const WS = '0123456789abcdef', PAGE = 'aaaaaaaaaaaa', LOAD = 'bbbbbbbbbbbb'
const env = (kind: string, body: Record<string, unknown> = {}, seq = 0) => ({ v: 1, ws: WS, page: PAGE, load: LOAD, seq, ts: Date.now(), kind, ...body })
const temp = () => { const r = mkdtempSync(join(tmpdir(), 'mv-perfpage-')); mkdirSync(join(r, 'design', '.local'), { recursive: true }); return r }
const mode = (p: string) => statSync(p).mode & 0o777
const posix = process.platform !== 'win32'

/** One valid record per kind, as the page sends them. */
const VALID: Record<string, Record<string, unknown>> = {
  load: { board: 'start-here', cause: 'boot', request: LOAD, sinceNav: 412.6 },
  commit: { request: LOAD, ms: 380, frames: 12, byKind: { hifi: 3, content: 8, html: 1, image: 0 }, measuring: 8, savedHeights: 6 },
  visible: { nodes: 5, ms: 420, assumed: true },
  frame: { node: 'k-a', frame: 'docs/a', gen: '7', boot: 'c0ffee000001', admitted: 400, ready: 900, firstMeasure: 950, settled: 1600, outcome: 'settled', kept: true },
  move: { node: 'k-b', dx: 0, dy: 812.4, dw: 0, dh: 0, cause: 'reflow:cramped+measured', late: true },
  quiet: { ms: 2100 },
  settled: { ms: 3200, moves: 7, distance: 1840, causes: { 'reflow:measured': 4, 'measure-height': 3 }, lastMove: 2150.6, visibleReadyMs: 900, allReadyMs: 1800, missing: 1, neverReady: 1, errors: 1, weight: { domNodes: 4000, iframes: 12, awake: 4, asleep: 8, heapMB: 81.27 } },
  cut: { reason: 'timeout', request: LOAD, ms: 120_000, lastMove: 118_400 },
  gesture: { type: 'layout', ms: 500, frames: 15, p50: 33, p95: 33.04, max: 33, over17ms: 15, over33ms: 0, longFrames: 0 },
  error: { source: 'frame', frame: 'kit/boom', message: 'boom', stack: ['at Boom (x.tsx:1:2)', 'at y', 'at z', 'at w'], late: true },
  dropped: { n: 4, reason: 'errors' },
}

describe('a page record', () => {
  it('each kind round-trips through its allowlist; what is not on it never gets in', () => {
    for (const [kind, body] of Object.entries(VALID)) {
      const c = cleanPageRecord(env(kind, { ...body, extra: SENTINEL, note: SENTINEL }))
      expect(c, kind).not.toBeNull()
      expect(JSON.stringify(c), kind).not.toContain(SENTINEL)
      expect(c).toMatchObject({ v: 1, ws: WS, page: PAGE, load: LOAD, seq: 0, kind })
    }
    expect(cleanPageRecord(env('load', VALID.load))).toMatchObject({ sinceNav: 413 })
    expect(cleanPageRecord(env('settled', VALID.settled))).toMatchObject({ weight: { heapMB: 81.3 }, causes: { 'reflow:measured': 4 }, lastMove: 2151 })
    expect(cleanPageRecord(env('cut', VALID.cut))).toMatchObject({ reason: 'timeout', ms: 120_000, lastMove: 118_400 })
    expect(cleanPageRecord(env('error', VALID.error))!.stack).toHaveLength(3)
    expect(cleanPageRecord(env('error', VALID.error))).toMatchObject({ late: true })
    expect(cleanPageRecord(env('dropped', VALID.dropped))).toMatchObject({ n: 4, reason: 'errors' })
    expect(cleanPageRecord(env('commit', VALID.commit))!.byKind).toEqual({ hifi: 3, content: 8, html: 1, image: 0 })
  })

  it('the envelope must hold: a version, a kind, a workspace, a page, a load and a seq in their own formats', () => {
    expect(cleanPageRecord({ ...env('quiet', VALID.quiet), v: 2 })).toBeNull()
    expect(cleanPageRecord(env('transcript', { text: SENTINEL }))).toBeNull()
    expect(cleanPageRecord({ ...env('quiet', VALID.quiet), ws: SENTINEL })).toBeNull()
    expect(cleanPageRecord({ ...env('quiet', VALID.quiet), page: 'nic@example.com' })).toBeNull()
    expect(cleanPageRecord({ ...env('quiet', VALID.quiet), load: SENTINEL })).toBeNull()
    expect(cleanPageRecord({ ...env('quiet', VALID.quiet), seq: undefined })).toBeNull()
    expect(cleanPageRecord({ ...env('quiet', VALID.quiet), seq: -1 })).toBeNull()
    // before any board committed, a record belongs to no load
    expect(cleanPageRecord({ ...env('gesture', VALID.gesture), load: '-' })).toMatchObject({ load: '-' })
  })

  it('a record missing what it is about is dropped; a value that cannot be known is left out, never 0', () => {
    expect(cleanPageRecord(env('load', { ...VALID.load, board: '../etc' }))).toBeNull()
    expect(cleanPageRecord(env('load', { ...VALID.load, cause: 'magic' }))).toBeNull()
    expect(cleanPageRecord(env('frame', { ...VALID.frame, outcome: 'fine' }))).toBeNull()
    expect(cleanPageRecord(env('move', { ...VALID.move, cause: 'Not A Cause!' }))).toBeNull()
    expect(cleanPageRecord(env('error', { source: 'shell' }))).toBeNull()
    expect(cleanPageRecord(env('cut', { reason: 'bored' }))).toBeNull()
    // a reason that is not one is left out: the count stays
    expect(cleanPageRecord(env('dropped', { n: 3, reason: SENTINEL }))).toMatchObject({ n: 3 })
    expect(cleanPageRecord(env('dropped', { n: 3, reason: SENTINEL }))).not.toHaveProperty('reason')
    expect(cleanPageRecord(env('load', { ...VALID.load, board: '~unplaced' }))).toMatchObject({ board: '~unplaced' })
    const f = cleanPageRecord(env('frame', { node: 'k', outcome: 'ready', ready: -5, admitted: Number.NaN }))!
    expect('ready' in f || 'admitted' in f).toBe(false)
    // a cause key that is not a cause is left out of the counts
    expect(cleanPageRecord(env('settled', { ms: 1, causes: { [SENTINEL]: 2, drag: 1 } }))!.causes).toEqual({ drag: 1 })
  })

  it('strings are cut to 200 characters; a clock far off becomes the server\'s', () => {
    const c = cleanPageRecord(env('error', { source: 'shell', message: 'x'.repeat(5000), stack: ['y'.repeat(900)] }))!
    expect((c.message as string).length).toBe(200)
    expect((c.stack as string[])[0].length).toBe(200)
    const now = Date.now()
    expect(cleanPageRecord({ ...env('quiet', VALID.quiet), ts: now - 7 * 86_400_000 }, now)!.ts).toBe(now)
    expect(cleanPageRecord({ ...env('quiet', VALID.quiet), ts: now - 5000 }, now)!.ts).toBe(now - 5000)
  })
})

describe('the page log', () => {
  let root = ''
  beforeEach(() => { root = temp() })
  afterEach(() => { try { chmodSync(perfDir(root), 0o700) } catch { /* none */ } rmSync(root, { recursive: true, force: true }) })

  it('one line per record it keeps; the directory 700 and the file 600 from their creation', () => {
    expect(logPage(root, [env('quiet', VALID.quiet, 0), env('nope'), 'not a record', env('dropped', VALID.dropped, 1)])).toBe(2)
    expect(readPage(root).map((r) => r.kind)).toEqual(['quiet', 'dropped'])
    if (posix) {
      expect(mode(perfDir(root))).toBe(0o700)
      expect(mode(pageLog(root))).toBe(0o600)
    }
    logReload(root, { kind: 'shell-boot' })
    if (posix) expect(mode(reloadLog(root))).toBe(0o600)
  })

  it('the page log holds 8 MB before its oldest half goes; the reload log 2 MB', () => {
    mkdirSync(perfDir(root), { recursive: true })
    const line = JSON.stringify(cleanPageRecord(env('quiet', VALID.quiet))) + '\n'
    // past 2 MB, under 8: a heavy board's loads are kept whole
    writeFileSync(pageLog(root), line.repeat(Math.ceil(2_100_000 / line.length)))
    logPage(root, [env('dropped', VALID.dropped, 9)])
    expect(statSync(pageLog(root)).size).toBeGreaterThan(2_100_000)
    // past 8 MB: the oldest half goes
    writeFileSync(pageLog(root), line.repeat(Math.ceil(8_100_000 / line.length)))
    logPage(root, [env('dropped', VALID.dropped, 9)])
    const size = statSync(pageLog(root)).size
    expect(size).toBeGreaterThan(3_900_000)
    expect(size).toBeLessThan(4_200_000)
    expect(readPage(root).at(-1)!.kind).toBe('dropped')
    // the reload log keeps its 2 MB
    const reload = JSON.stringify({ ts: Date.now(), kind: 'ready', frame: 'kit/a' }) + '\n'
    writeFileSync(reloadLog(root), reload.repeat(Math.ceil(2_100_000 / reload.length)))
    logReload(root, { kind: 'shell-boot' })
    expect(statSync(reloadLog(root)).size).toBeLessThan(1_200_000)
  })

  it('never writes through a linked design/.local', () => {
    const other = mkdtempSync(join(tmpdir(), 'mv-perfpage-elsewhere-'))
    rmSync(join(root, 'design', '.local'), { recursive: true })
    symlinkSync(other, join(root, 'design', '.local'))
    expect(logPage(root, [env('quiet', VALID.quiet)])).toBe(0)
    expect(existsSync(join(other, 'perf'))).toBe(false)
    rmSync(other, { recursive: true, force: true })
  })

  it.skipIf(!posix)('a log that cannot be written never throws', () => {
    mkdirSync(perfDir(root), { recursive: true })
    chmodSync(perfDir(root), 0o500)
    expect(() => logPage(root, [env('quiet', VALID.quiet)])).not.toThrow()
    expect(logPage(root, [env('quiet', VALID.quiet)])).toBe(0)
  })
})

describe('the perf directory at start', () => {
  let root = ''
  beforeEach(() => { root = temp() })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it.skipIf(!posix)('tightens what earlier versions left open: the directory 700, every file 600', () => {
    mkdirSync(perfDir(root), { recursive: true, mode: 0o755 })
    chmodSync(perfDir(root), 0o755)
    for (const f of ['reloads.jsonl', 'jam.jsonl', 'notes.txt']) { writeFileSync(join(perfDir(root), f), ''); chmodSync(join(perfDir(root), f), 0o644) }
    tidyPerfDir(root)
    expect(mode(perfDir(root))).toBe(0o700)
    for (const f of ['reloads.jsonl', 'jam.jsonl', 'notes.txt']) expect(mode(join(perfDir(root), f)), f).toBe(0o600)
  })

  it('lines older than 14 days go from every log that ages out - the reload, page and Jam logs alike', () => {
    mkdirSync(perfDir(root), { recursive: true })
    const now = Date.now(), old = now - 15 * 86_400_000, fresh = now - 86_400_000
    for (const f of ['reloads.jsonl', 'page.jsonl', 'jam.jsonl']) writeFileSync(join(perfDir(root), f), [JSON.stringify({ ts: old, kind: 'old' }), JSON.stringify({ ts: fresh, kind: 'fresh' }), 'garbage', ''].join('\n'))
    writeFileSync(join(perfDir(root), 'keep.json'), JSON.stringify({ ts: old }))
    tidyPerfDir(root, now)
    for (const f of ['reloads.jsonl', 'page.jsonl', 'jam.jsonl']) expect(readFileSync(join(perfDir(root), f), 'utf8'), f).toBe(JSON.stringify({ ts: fresh, kind: 'fresh' }) + '\n')
    expect(readFileSync(join(perfDir(root), 'keep.json'), 'utf8')).toBe(JSON.stringify({ ts: old }))   // not a log of lines
  })

  it('a log still past its cap loses its oldest half: 2 MB, and 8 MB for the page log', () => {
    mkdirSync(perfDir(root), { recursive: true })
    const line = JSON.stringify({ ts: Date.now(), kind: 'x', pad: 'p'.repeat(200) })
    const fill = (f: string, bytes: number) => writeFileSync(join(perfDir(root), f), (line + '\n').repeat(Math.ceil(bytes / line.length)))
    const size = (f: string) => statSync(join(perfDir(root), f)).size
    fill('reloads.jsonl', 2_500_000)
    fill('jam.jsonl', 2_500_000)
    fill('page.jsonl', 2_500_000)
    tidyPerfDir(root)
    for (const f of ['reloads.jsonl', 'jam.jsonl']) {
      expect(size(f), f).toBeGreaterThan(1_100_000)
      expect(size(f), f).toBeLessThan(1_400_000)
    }
    expect(size('page.jsonl')).toBeGreaterThan(2_400_000)   // under its 8 MB: whole
    fill('page.jsonl', 8_500_000)
    tidyPerfDir(root)
    expect(size('page.jsonl')).toBeGreaterThan(4_000_000)
    expect(size('page.jsonl')).toBeLessThan(4_500_000)
  })

  it.skipIf(!posix)('a link inside perf/ is neither followed nor changed; no perf/ yet - nothing is made', () => {
    tidyPerfDir(root)
    expect(existsSync(perfDir(root))).toBe(false)
    mkdirSync(perfDir(root), { recursive: true })
    const target = join(root, 'target.jsonl')
    writeFileSync(target, JSON.stringify({ ts: 1 }) + '\n')
    chmodSync(target, 0o644)
    symlinkSync(target, join(perfDir(root), 'page.jsonl'))
    tidyPerfDir(root)
    expect(mode(target)).toBe(0o644)
    expect(readFileSync(target, 'utf8')).toBe(JSON.stringify({ ts: 1 }) + '\n')
  })
})

// ---------------------------------------------------------------------------------------------
// the route, through the dev API (the sizes.test.ts request shape)
let root = ''
function drive(body: unknown, owner = true, raw?: Buffer) {
  const mw = apiMiddleware(root, {})
  const req: any = {
    method: 'POST', url: `${ROUTE}/api/perf/page`,
    headers: { host: 'localhost:5200', ...(owner ? { cookie: 'mv_c=tok', 'x-mv-c': 'tok', origin: 'http://localhost:5200' } : {}) },
    _cbs: {} as Record<string, (arg?: unknown) => void>,
    on(ev: string, cb: (arg?: unknown) => void) { this._cbs[ev] = cb; return this },
    destroy() {},
  }
  const res: any = { statusCode: 0, body: '', setHeader() {}, end(s?: string) { this.body = s ?? ''; this._done?.() } }
  const done = new Promise<{ status: number; json: any }>((resolve) => {
    res._done = () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(res.body) } catch { return null } })() })
    void mw(req, res, () => resolve({ status: 404, json: null }))
  })
  const bytes = raw ?? Buffer.from(JSON.stringify(body ?? {}))
  queueMicrotask(() => { req._cbs.data?.(bytes); req._cbs.end?.() })
  return done
}

describe('POST /api/perf/page', () => {
  beforeEach(() => { root = temp() })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('owner-gated: a page from another origin writes nothing', async () => {
    expect((await drive({ records: [env('quiet', VALID.quiet)] }, false)).status).toBe(403)
    expect(existsSync(pageLog(root))).toBe(false)
  })

  it('takes 512 KB at most, and only { records: [...] }', async () => {
    expect((await drive(null, true, Buffer.alloc(513 * 1024, 32))).status).toBe(400)
    expect((await drive({})).status).toBe(400)
    expect((await drive(null, true, Buffer.from('{nope'))).status).toBe(400)
  })

  it('answers how many it kept, and writes those', async () => {
    const r = await drive({ records: [env('quiet', VALID.quiet, 0), env('quiet', { ms: -1 }, 1), env('dropped', VALID.dropped, 2)] })
    expect(r).toEqual({ status: 200, json: { ok: true, accepted: 2 } })
    expect(readFileSync(pageLog(root), 'utf8').trim().split('\n')).toHaveLength(2)
  })
})
