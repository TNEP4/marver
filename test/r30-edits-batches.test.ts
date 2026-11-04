import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiMiddleware } from '../src/server/api.ts'
import { ROUTE } from '../src/cli/name.ts'
import { cleanPageRecord, cleanReloadRecord, failedWrites, pageLog, perfDir, readReloads, reloadLog, takePageBatch, takeReloadBatch } from '../src/server/perf.ts'
import { loadsSummary } from '../src/cli/perf.ts'
import { DEDUPE, SHELL_RELOAD_KINDS } from '../src/shared/perf-records.ts'

/**
 * Delivery is acknowledged (spec 30 #7, #16): the reload batch's route and allowlist, an answer only after the append
 * returned, a 503 when it failed, and the `(page, seq)` window - best effort, so a retry past it is written twice and every
 * reader dedupes. Plus `load`'s and `cut`'s new fields (#17-#19). The page's half is r30-edits-reloads-browser.test.ts.
 */

const SENTINEL = 'PURPLE-ELEPHANT-SECRET'
const PAGE = 'aaaaaaaaaaaa', OTHER = 'bbbbbbbbbbbb', WS = '0123456789abcdef', LOAD = 'cccccccccccc', CMD = 'dddddddddddd', REV = '123456789012345:7'
const line = (kind: string, body: Record<string, unknown> = {}, seq = 0, page = PAGE) => ({ kind, tab: 'abc123', page, seq, ts: Date.now(), ...body })
const temp = () => { const r = mkdtempSync(join(tmpdir(), 'mv-batches-')); mkdirSync(join(r, 'design', '.local'), { recursive: true }); return r }

/** One valid line per kind, as the shell sends them. */
const VALID: Record<string, Record<string, unknown>> = {
  'shell-boot': { nav: 'reload', resumed: true, prev: 'bbbbbbbbbbbb' },
  ready: { cause: 'job', node: 'k-a', frame: 's/a', shown: 'e:3', ms: 412.4, revisions: [REV, '123456789012345:8'], queuedMs: 12.2, bootMs: 301.7, heldBy: 'offscreen', asleep: true },
  settled: { node: 'k-a', frame: 's/a', ms: 88.4 },
  invalidated: { revision: REV, asked: 3, offBoard: 1, onBoard: 4, awake: 3, asleep: 1, held: { offscreen: 2, leased: 1 }, parts: 1 },
  'invalidated-nodes': { revision: REV, part: 1, parts: 1, nodes: ['k-a', 'k-b'] },
  inplace: { node: 'k-a', frame: 's/a', hmrTs: 1_777_000_000_000, fetched: true, applyMs: 5.2, nextObservedCommitMs: 31.9, applied: 'unknown' },
  watchdog: { node: 'k-a', frame: 's/a', nav: 2, action: 'retry' },
  dropped: { n: 4 },
}

describe('a shell reload line', () => {
  it('`shell-boot` keeps the page its tab showed before, only as a page id', () => {
    expect(cleanReloadRecord(line('shell-boot', { prev: OTHER }))).toMatchObject({ prev: OTHER })
    expect(cleanReloadRecord(line('shell-boot', { prev: SENTINEL }))).not.toHaveProperty('prev')
    expect(cleanReloadRecord(line('shell-boot', {}))).not.toHaveProperty('prev')
  })
  it('each kind round-trips through its allowlist; what is not on it never gets in', () => {
    for (const kind of [...SHELL_RELOAD_KINDS, 'dropped']) {
      const c = cleanReloadRecord(line(kind, { ...VALID[kind], extra: SENTINEL, note: SENTINEL }))
      expect(c, kind).not.toBeNull()
      expect(JSON.stringify(c), kind).not.toContain(SENTINEL)
      expect(c).toMatchObject({ kind, tab: 'abc123', page: PAGE, seq: 0 })
    }
    expect(cleanReloadRecord(line('ready', VALID.ready))).toMatchObject({ revisions: [REV, '123456789012345:8'], queuedMs: 12, bootMs: 302, ms: 412, heldBy: 'offscreen', asleep: true })
    expect(cleanReloadRecord(line('invalidated', VALID.invalidated))).toMatchObject({ held: { offscreen: 2, leased: 1 } })
  })

  it('the envelope must hold, and a kind that is not a shell line is dropped - a server line cannot be forged', () => {
    expect(cleanReloadRecord(line('quiet'))).toBeNull()
    for (const kind of ['change', 'update', 'update-ids', 'full-reload', 'invalidate', 'invalidate-ids']) expect(cleanReloadRecord(line(kind, { change: 'x' })), kind).toBeNull()
    expect(cleanReloadRecord({ ...line('settled', VALID.settled), page: 'nic@example.com' })).toBeNull()
    expect(cleanReloadRecord({ ...line('settled', VALID.settled), seq: -1 })).toBeNull()
    expect(cleanReloadRecord({ ...line('settled', VALID.settled), seq: undefined })).toBeNull()
    expect(cleanReloadRecord('not a record')).toBeNull()
  })

  it('a line missing what it is about is dropped; a value that cannot be known is left out', () => {
    expect(cleanReloadRecord(line('ready', { frame: 's/a' }))).toBeNull()
    expect(cleanReloadRecord(line('invalidated', { revision: SENTINEL }))).toBeNull()
    expect(cleanReloadRecord(line('watchdog', { node: 'k', action: 'panic' }))).toBeNull()
    const r = cleanReloadRecord(line('ready', { node: 'k', queuedMs: -5, bootMs: Number.NaN, heldBy: 'bored', revisions: [SENTINEL, REV] }))!
    expect(r).not.toHaveProperty('queuedMs')
    expect(r).not.toHaveProperty('bootMs')
    expect(r).not.toHaveProperty('heldBy')
    expect(r.revisions).toEqual([REV])
  })

  it('#15: what was seen, no more - `applied` is never true, and a line that fetched nothing is no line', () => {
    expect(cleanReloadRecord(line('inplace', { ...VALID.inplace, applied: true }))).toBeNull()
    expect(cleanReloadRecord(line('inplace', { ...VALID.inplace, fetched: false }))).toBeNull()
    expect(cleanReloadRecord(line('inplace', { ...VALID.inplace, fetched: undefined }))).toBeNull()
    expect(cleanReloadRecord(line('inplace', { ...VALID.inplace, applied: false }))).toMatchObject({ applied: false, fetched: true })
    expect(cleanReloadRecord(line('inplace', { ...VALID.inplace, hmrTs: 'soon' }))).toBeNull()
  })

  it('at most 256 ids per line', () => {
    const c = cleanReloadRecord(line('invalidated-nodes', { revision: REV, part: 1, parts: 2, nodes: Array.from({ length: 400 }, (_, i) => `k${i}`) }))!
    expect(c.nodes).toHaveLength(256)
  })
})

describe('`load` and `cut` gain their fields (#17-#19)', () => {
  const env = (kind: string, body: Record<string, unknown>) => ({ v: 1, ws: WS, page: PAGE, load: LOAD, seq: 0, ts: Date.now(), kind, ...body })
  const load = { board: 'main', cause: 'disk-reload', request: LOAD }

  it('trigger, writer, candidates and by', () => {
    const c = cleanPageRecord(env('load', { ...load, trigger: 'disk', writer: 'candidate', candidates: [{ page: OTHER, cmds: [CMD], n: 3, extra: SENTINEL }], by: CMD }))
    expect(c).toMatchObject({ trigger: 'disk', writer: 'candidate', candidates: [{ page: OTHER, cmds: [CMD], n: 3 }], by: CMD })
    expect(JSON.stringify(c)).not.toContain(SENTINEL)
  })
  it('a trigger or writer that is not one is left out; the load stays', () => {
    const c = cleanPageRecord(env('load', { ...load, trigger: 'magic', writer: 'proven', candidates: 'x', by: SENTINEL }))!
    for (const k of ['trigger', 'writer', 'candidates', 'by']) expect(c).not.toHaveProperty(k)
    expect(c).toMatchObject({ board: 'main' })
  })
  it('a candidate needs a page in its format; at most 8; its count never below its ids', () => {
    const c = cleanPageRecord(env('load', { ...load, writer: 'ambiguous', candidates: [{ page: SENTINEL, cmds: [] }, { page: OTHER, cmds: [CMD, SENTINEL], n: 0 }] }))!
    expect(c.candidates).toEqual([{ page: OTHER, cmds: [CMD], n: 1 }])
    const many = cleanPageRecord(env('load', { ...load, writer: 'ambiguous', candidates: Array.from({ length: 20 }, () => ({ page: OTHER, cmds: [], n: 0 })) }))!
    expect(many.candidates).toHaveLength(8)
  })
  it('a cut keeps its partial times', () => {
    expect(cleanPageRecord(env('cut', { reason: 'switch', ms: 900, frames: 2, ready: 1, visibleReadyMs: 400.4, allReadyMs: 410.6, visibleReady: 1 }))).toMatchObject({ visibleReadyMs: 400, allReadyMs: 411, visibleReady: 1 })
    const none = cleanPageRecord(env('cut', { reason: 'switch', visibleReadyMs: -1, visibleReady: 'x' }))!
    expect(none).not.toHaveProperty('visibleReadyMs')
    expect(none).not.toHaveProperty('visibleReady')
  })
})

let root = ''
function drive(route: string, body: unknown, owner = true, raw?: Buffer) {
  const mw = apiMiddleware(root, {})
  const req: any = {
    method: 'POST', url: `${ROUTE}/api/${route}`,
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
const written = (file: string) => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
/** An append that must throw: the log's own name taken by a directory. */
const breakLog = (file: string) => mkdirSync(file, { recursive: true })
const page = (body: Record<string, unknown>, seq: number, p = PAGE) => ({ v: 1, ws: WS, page: p, load: LOAD, seq, ts: Date.now(), kind: 'quiet', ...body })

describe('POST perf/reload', () => {
  beforeEach(() => { root = temp() })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('owner-gated: a page from another origin writes nothing', async () => {
    expect((await drive('perf/reload', { records: [line('settled', VALID.settled)] }, false)).status).toBe(403)
    expect(existsSync(reloadLog(root))).toBe(false)
  })
  it('takes only { records: [...] }, 512 KB at most - not the old single line', async () => {
    expect((await drive('perf/reload', { kind: 'ready', node: 'k' })).status).toBe(400)
    expect((await drive('perf/reload', null, true, Buffer.from('{nope'))).status).toBe(400)
    expect((await drive('perf/reload', null, true, Buffer.alloc(513 * 1024, 32))).status).toBe(400)
  })
  it('a batch: each line rebuilt, the bad ones left out, the answer counting what landed', async () => {
    const r = await drive('perf/reload', { records: [line('settled', VALID.settled, 0), line('nope', {}, 1), line('watchdog', VALID.watchdog, 2), 'junk'] })
    expect(r).toEqual({ status: 200, json: { ok: true, accepted: 2, duplicates: 0 } })
    expect(written(reloadLog(root)).map((l) => l.kind)).toEqual(['settled', 'watchdog'])
    expect(readReloads(root)).toHaveLength(2)
  })
  it('a failed append answers 503 and is counted - and is not acknowledged, so the retry still writes', async () => {
    breakLog(reloadLog(root))
    const before = failedWrites(root)
    const r = await drive('perf/reload', { records: [line('settled', VALID.settled, 0)] })
    expect(r.status).toBe(503)
    expect(r.json).toMatchObject({ failedWrites: before + 1 })
    expect(typeof r.json.error).toBe('string')
    rmSync(reloadLog(root), { recursive: true })
    // the failure remembered nothing: the same seq goes in now
    expect(await drive('perf/reload', { records: [line('settled', VALID.settled, 0)] })).toEqual({ status: 200, json: { ok: true, accepted: 1, duplicates: 0 } })
    expect(written(reloadLog(root))).toHaveLength(1)
  })
  it('a retry within the window is written once', async () => {
    const batch = { records: [line('settled', VALID.settled, 0), line('settled', VALID.settled, 1)] }
    expect((await drive('perf/reload', batch)).json).toEqual({ ok: true, accepted: 2, duplicates: 0 })
    expect((await drive('perf/reload', batch)).json).toEqual({ ok: true, accepted: 0, duplicates: 2 })
    expect(written(reloadLog(root))).toHaveLength(2)
  })
})

describe('POST perf/page answers the same way', () => {
  beforeEach(() => { root = temp() })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('a failed append answers 503, counted', async () => {
    mkdirSync(perfDir(root), { recursive: true })
    breakLog(pageLog(root))
    const before = failedWrites(root)
    const r = await drive('perf/page', { records: [page({ ms: 5 }, 0)] })
    expect(r.status).toBe(503)
    expect(r.json).toMatchObject({ failedWrites: before + 1 })
  })
  it('a retry within the window is written once', async () => {
    const batch = { records: [page({ ms: 5 }, 0)] }
    expect((await drive('perf/page', batch)).json).toEqual({ ok: true, accepted: 1, duplicates: 0 })
    expect((await drive('perf/page', batch)).json).toEqual({ ok: true, accepted: 0, duplicates: 1 })
    expect(written(pageLog(root))).toHaveLength(1)
  })
  it('a whole batch of bad records is 200 with none accepted: refused, not failed', async () => {
    expect(await drive('perf/page', { records: [page({ ms: -1 }, 0)] })).toEqual({ status: 200, json: { ok: true, accepted: 0, duplicates: 0 } })
  })
  it('a run\'s records stay stamped by the server, and only what was written reaches its collector', () => {
    let kept: Record<string, unknown>[] = []
    takePageBatch(root, [page({ ms: 5, run: SENTINEL }, 0)], { run: 'r1', kept: (r) => { kept = r } })
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ run: 'r1' })
    expect(JSON.stringify(written(pageLog(root)))).not.toContain(SENTINEL)
    kept = []
    takePageBatch(root, [page({ ms: 5 }, 0)], { run: 'r1', kept: (r) => { kept = r } })
    expect(kept).toEqual([])   // a duplicate is no record for the run
  })
})

describe('the (page, seq) window: best effort, so every reader dedupes (#7)', () => {
  beforeEach(() => { root = temp() })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  const T0 = Date.now()
  const settled = (seq: number, p = PAGE) => ({ ...line('settled', VALID.settled, seq, p), ts: T0 })

  it('one seq per page across both logs: a page record and a reload line never share one', () => {
    expect(takeReloadBatch(root, [settled(5)], T0)).toMatchObject({ accepted: 1 })
    expect(takePageBatch(root, [{ ...page({ ms: 5 }, 5), ts: T0 }], {}, T0)).toMatchObject({ accepted: 0, duplicates: 1 })
    expect(takeReloadBatch(root, [settled(5, OTHER)], T0)).toMatchObject({ accepted: 1 })   // another page's seq is its own
  })
  it('a batch that repeats itself writes the line once', () => {
    expect(takeReloadBatch(root, [settled(1), settled(1)], T0)).toEqual({ ok: true, accepted: 1, duplicates: 1 })
  })
  it('past 10 minutes a retry is written twice: no exactly-once promise', () => {
    expect(takeReloadBatch(root, [settled(1)], T0)).toMatchObject({ accepted: 1 })
    expect(takeReloadBatch(root, [settled(1)], T0 + DEDUPE.windowMs - 1)).toMatchObject({ accepted: 0, duplicates: 1 })
    expect(takeReloadBatch(root, [settled(1)], T0 + DEDUPE.windowMs)).toMatchObject({ accepted: 1, duplicates: 0 })
    expect(written(reloadLog(root))).toHaveLength(2)
  })
  it('past 4,096 of a page the oldest is forgotten, and written again', () => {
    expect(takeReloadBatch(root, Array.from({ length: DEDUPE.perPage + 1 }, (_, i) => settled(i)), T0)).toMatchObject({ accepted: DEDUPE.perPage + 1 })
    expect(takeReloadBatch(root, [settled(1)], T0)).toMatchObject({ accepted: 0 })   // still within
    expect(takeReloadBatch(root, [settled(0)], T0)).toMatchObject({ accepted: 1 })   // evicted
  })
  it('past 64 pages the longest idle is forgotten', () => {
    const pageAt = (i: number) => i.toString(16).padStart(12, '0')
    for (let i = 0; i <= DEDUPE.pages; i++) takeReloadBatch(root, [settled(0, pageAt(i))], T0)
    expect(takeReloadBatch(root, [settled(0, pageAt(DEDUPE.pages))], T0)).toMatchObject({ accepted: 0 })
    expect(takeReloadBatch(root, [settled(0, pageAt(0))], T0)).toMatchObject({ accepted: 1 })
  })
  it('one project\'s window is not another\'s', () => {
    const other = temp()
    try {
      expect(takeReloadBatch(root, [settled(1)], T0)).toMatchObject({ accepted: 1 })
      expect(takeReloadBatch(other, [settled(1)], T0)).toMatchObject({ accepted: 1 })
    } finally { rmSync(other, { recursive: true, force: true }) }
  })
  it('a page record written twice past the window is counted once by the loads reader', () => {
    const base = { v: 1, ws: WS, page: PAGE, load: LOAD, ts: T0 }
    const recs = [{ ...base, seq: 0, kind: 'load', board: 'main', cause: 'boot', request: LOAD }, { ...base, seq: 1, kind: 'commit', request: LOAD, ms: 5, frames: 1, byKind: {} }, { ...base, seq: 2, kind: 'error', source: 'shell', message: 'boom' }]
    expect(takePageBatch(root, recs, {}, T0)).toMatchObject({ accepted: 3 })
    expect(takePageBatch(root, recs, {}, T0 + DEDUPE.windowMs)).toMatchObject({ accepted: 3 })
    const lines = written(pageLog(root))
    expect(lines).toHaveLength(6)
    const [one] = loadsSummary(lines)
    expect(one.errors).toHaveLength(1)
  })
})
