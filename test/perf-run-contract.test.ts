import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROUTE } from '../src/cli/name.ts'
import { appendRun, cleanPageRecord, logPage, pageLog, readRuns } from '../src/server/perf.ts'
import { allowedInRun, perfRunBarrier, RUN_ALLOWED, RUN_HEADER, runIdOf, runs } from '../src/server/perf-run.ts'
import { flightKey, jobsOf } from '../src/server/bake.ts'

/**
 * The perf-run contract between the shell and the server (spec 28 A3.8 #17, #19, #22), frozen before the A3
 * streams split: the allowed list both barriers read, a request's run id (its header, else its Referer's query),
 * the server's barrier refusing and counting per run id, the server stamping `run` on a run's records after A1's
 * cleaner, the runs log, the bake owner's key, and the display rate on gesture records. The driver is the headless
 * stream's (perf-run.test.ts).
 */

const ID = '0123456789abcdef', OTHER = 'fedcba9876543210'
const WS = '0123456789abcdef', PAGE = 'aaaaaaaaaaaa', LOAD = 'bbbbbbbbbbbb'
const env = (kind: string, body: Record<string, unknown> = {}) => ({ v: 1, ws: WS, page: PAGE, load: LOAD, seq: 0, ts: Date.now(), kind, ...body })
const temp = () => { const r = mkdtempSync(join(tmpdir(), 'mv-runcontract-')); mkdirSync(join(r, 'design', '.local'), { recursive: true }); return r }
const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); for (const r of runs.active()) runs.end(r.id) })

describe('what a run may send', () => {
  it('GET and HEAD always; under the api only POST perf/page and POST bakes', () => {
    expect(RUN_ALLOWED).toEqual([{ method: 'POST', path: 'perf/page' }, { method: 'POST', path: 'bakes' }])
    expect(allowedInRun('GET', 'boards/main')).toBe(true)
    expect(allowedInRun('head', null)).toBe(true)
    expect(allowedInRun('POST', 'perf/page')).toBe(true)
    expect(allowedInRun('post', 'bakes')).toBe(true)
    for (const p of ['perf/reload', 'perf/jam', 'sizes', 'marks/seen', 'poster', 'comments', 'boards/main']) expect(allowedInRun('POST', p)).toBe(false)
    expect(allowedInRun('PUT', 'boards/main')).toBe(false)
    expect(allowedInRun('DELETE', 'perf/page')).toBe(false)
    expect(allowedInRun('POST', null)).toBe(false)
  })
  it('a run id comes from the header, else the Referer\'s query; anything else names none', () => {
    expect(runIdOf({ headers: { [RUN_HEADER]: ID } })).toBe(ID)
    expect(runIdOf({ headers: { referer: `http://127.0.0.1:5400/?ws=${WS}&mvperfrun=${OTHER}` } })).toBe(OTHER)
    expect(runIdOf({ headers: { [RUN_HEADER]: ID, referer: `http://x/?mvperfrun=${OTHER}` } })).toBe(ID)
    expect(runIdOf({ headers: { [RUN_HEADER]: 'NOT-HEX' } })).toBe(null)
    expect(runIdOf({ headers: { referer: 'http://x/?mvperfrun=short' } })).toBe(null)
    expect(runIdOf({ headers: {} })).toBe(null)
  })
})

describe('the server\'s barrier', () => {
  type Res = { statusCode: number; headers: Record<string, string>; body: string; setHeader(k: string, v: string): void; end(b: string): void }
  const call = (method: string, url: string, headers: Record<string, string> = {}) => {
    const res: Res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b } }
    let passed = false
    perfRunBarrier()({ method, url, headers } as never, res as never, () => { passed = true })
    return { passed, res }
  }
  it('refuses and counts a run\'s other writes, per run id; lets the rest through', () => {
    const a = runs.register('main', ID)
    const b = runs.register('main', OTHER)
    expect(a.overlapped && b.overlapped).toBe(true)
    expect(call('PUT', `${ROUTE}/api/boards/main`, { [RUN_HEADER]: ID }).res.statusCode).toBe(403)
    expect(call('POST', `${ROUTE}/api/poster`, { referer: `http://x/?mvperfrun=${ID}` }).res.headers[RUN_HEADER]).toBe('refused')
    expect(call('POST', `${ROUTE}/api/perf/page`, { [RUN_HEADER]: ID }).passed).toBe(true)
    expect(call('POST', `${ROUTE}/api/bakes`, { [RUN_HEADER]: ID }).passed).toBe(true)
    expect(call('GET', `${ROUTE}/api/boards/main`, { [RUN_HEADER]: ID }).passed).toBe(true)
    expect(call('POST', `${ROUTE}/api/sizes`).passed).toBe(true)   // no run named: not the barrier's
    expect(runs.get(ID)!.forbidden).toBe(2)
    expect(runs.get(ID)!.forbiddenPaths).toEqual([`PUT ${ROUTE}/api/boards/main`, `POST ${ROUTE}/api/poster`])
    expect(runs.get(OTHER)!.forbidden).toBe(0)
    // an unregistered id is refused all the same, and counts nowhere
    expect(call('POST', `${ROUTE}/api/poster`, { [RUN_HEADER]: '1111111111111111' }).res.statusCode).toBe(403)
  })
  it('a change while registered sticks to every run, even if undone', () => {
    runs.register('main', ID)
    runs.changed('/repo/src/a.tsx')
    runs.changed('/repo/src/b.tsx')
    expect(runs.end(ID)!.inputsChanged).toBe('/repo/src/a.tsx')
    expect(runs.get(ID)).toBeUndefined()
  })
})

describe('the server stamps a run\'s records', () => {
  it('after the cleaner: a run the page sent is gone, the server\'s is there, and the run\'s collector gets them', () => {
    const root = temp(); roots.push(root)
    expect(cleanPageRecord(env('quiet', { ms: 5, run: OTHER }))).not.toHaveProperty('run')
    let kept: Record<string, unknown>[] = []
    expect(logPage(root, [env('quiet', { ms: 5, run: OTHER })], { run: ID, kept: (r) => { kept = r } })).toBe(1)
    expect(logPage(root, [env('quiet', { ms: 6, run: OTHER })])).toBe(1)
    const lines = readFileSync(pageLog(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.run)).toEqual([ID, undefined])
    expect(kept.map((k) => k.run)).toEqual([ID])
  })
  it('the display rate rides on gesture records, 1-1000 Hz', () => {
    const g = (hz: unknown) => cleanPageRecord(env('gesture', { type: 'zoom', ms: 500, frames: 30, p50: 8, p95: 12, max: 20, over17ms: 1, over33ms: 0, longFrames: 0, hz }))
    expect(g(120)).toMatchObject({ hz: 120 })
    expect(g(0)).not.toHaveProperty('hz')
    expect(g(1001)).not.toHaveProperty('hz')
    expect(g('60')).not.toHaveProperty('hz')
  })
  it('runs.jsonl takes whole lines and reads them back', () => {
    const root = temp(); roots.push(root)
    expect(appendRun(root, { v: 1, ts: Date.now(), run: ID, valid: false, invalidReason: 'cancelled' })).toBe(true)
    expect(readRuns(root).map((r) => r.run)).toEqual([ID])
  })
})

describe('bakes are owned (A3.8 #19)', () => {
  it('a run\'s key never meets a normal one', () => {
    const ask = { frame: 'docs/a', theme: 'light', w: 400, h: 300 }
    expect(flightKey('/r', 3, ask)).not.toBe(flightKey('/r', 3, ask, ID))
    expect(flightKey('/r', 3, ask)).toMatch(/\|normal$/)
    expect(jobsOf(ID)).toEqual({ queued: 0, running: 0 })
  })
})
