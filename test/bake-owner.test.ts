import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome } from '../src/server/cdp.ts'
import { bakeBatch, bakeKey, bakeSeams, bakesEnded, COMPILING, endRunBakes, jobsIdle, jobsOf, NORMAL_OWNER, RUN_ENDED, type BakeAnswer } from '../src/server/bake.ts'
import { PAGES, PILL } from './fixtures/glass-pages.ts'

/**
 * Bakes are owned per run (spec 28 A3.8 #18, #19, r1 #3, #4): a headless run's compiles never meet a normal
 * caller's - in flight, failed or remembered - a compile whose document skipped a missing poster never fills the
 * shared cache, a run's jobs are counted (`jobsOf`) and awaited (`jobsIdle`), and a run that ends answers its queued
 * compiles "the run ended" without rendering. On synthetic glass pages served from memory, in a real headless
 * Chrome; skips without one.
 */

const RUN = '0123456789abcdef', OTHER = 'fedcba9876543210'
let http: Server | null = null
let origin = ''
const hits: Record<string, number> = {}
const pages: Record<string, string> = {
  ...PAGES,
  // what a run's frame URL makes of a Video whose poster is missing (video.tsx): the document says it skipped one
  skipped: PAGES.glass.replace('<html>', '<html data-mv-poster-skipped>'),
  second: PAGES.glass.replace('Past due', 'Second'),
  third: PAGES.glass.replace('Past due', 'Third'),
  fourth: `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:600px;height:400px}body{background:#7b61ff}.glass{backdrop-filter:blur(12px)}</style></head><body><div id="root"><div class="glass" style="${PILL}">fourth</div></div></body></html>`,
}
let root = ''
const CHROME = !!findChrome()

beforeAll(async () => {
  http = createServer((req, res) => {
    const name = (req.url ?? '/').slice(1).split('?')[0]
    hits[name] = (hits[name] ?? 0) + 1
    const html = pages[name]
    if (!html) { res.statusCode = 404; return res.end() }
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html)
  })
  await new Promise<void>((r) => http!.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  root = mkdtempSync(join(tmpdir(), 'mv-bake-owner-'))
})
afterAll(() => { http?.close(); rmSync(root, { recursive: true, force: true }) })
afterEach(() => { bakeSeams.holdMs = undefined; delete process.env.MARVER_SHOT_CONCURRENCY })

const ask = (frame: string) => ({ frame, theme: 'light', w: 600, h: 400 })
const batch = (frames: string[], gen: number, o: { owner?: string; waitMs?: number } = {}) =>
  bakeBatch({ root, gen, asks: frames.map(ask), urlFor: (a) => `${origin}/${a.frame}`, urlBase: '/bakes', ...o })
const one = (frame: string, gen: number, o: { owner?: string; waitMs?: number } = {}) => batch([frame], gen, o).then((r) => r[0])
const cached = (gen: number, frame: string) => existsSync(join(root, 'design', '.local', 'bakes', String(gen), bakeKey(ask(frame)), 'bake.json'))
const skippable = (name: string, fn: () => Promise<void>, ms = 90_000) => it(name, async (ctx) => { if (!CHROME) return ctx.skip(); await fn() }, ms)

describe('bakes owned per run', () => {
  skippable('a run never joins a normal compile in flight, nor a normal caller a run\'s: each has a job of its own', async () => {
    bakeSeams.holdMs = 1500
    const before = hits.glass ?? 0
    const normal = one('glass', 1)
    for (const by = Date.now() + 15_000; jobsOf(NORMAL_OWNER).running === 0 && Date.now() < by;) await new Promise((r) => setTimeout(r, 20))
    const mine = one('glass', 1, { owner: RUN })
    // joined, the run would have no job: it waits for one of its own (the lane is the normal compile's)
    expect(jobsOf(RUN)).toEqual({ queued: 1, running: 0 })
    expect(jobsOf(NORMAL_OWNER)).toEqual({ queued: 0, running: 1 })
    const [n, r] = await Promise.all([normal, mine])
    expect(n.ok && r.ok).toBe(true)
    // its turn came after the normal compile had filled the shared cache, posters and all: a hit, not a join
    expect(hits.glass - before).toBe(1)
    expect(jobsOf(RUN)).toEqual({ queued: 0, running: 0 })
    // the other way: a run's compile in flight, a normal caller waits for a job of its own
    const other = one('plain', 1, { owner: OTHER })
    for (const by = Date.now() + 15_000; jobsOf(OTHER).running === 0 && Date.now() < by;) await new Promise((r) => setTimeout(r, 20))
    const theirs = one('plain', 1)
    expect(jobsOf(NORMAL_OWNER)).toEqual({ queued: 1, running: 0 })
    await Promise.all([other, theirs])
    expect(jobsOf(NORMAL_OWNER)).toEqual({ queued: 0, running: 0 })
  })

  skippable('a run\'s failed compile is the run\'s: a normal request for the frame compiles it', async () => {
    const before = hits.restless ?? 0
    const r = await one('restless', 2, { owner: RUN })
    expect(r.ok).toBe(false)
    expect(hits.restless - before).toBe(1)
    expect((await one('restless', 2, { owner: RUN })).ok, 'the run asks again: its own failure, from memory').toBe(false)
    expect(hits.restless - before).toBe(1)
    const n = await one('restless', 2)
    expect(n.ok).toBe(false)
    expect(hits.restless - before, 'the normal caller compiled it').toBe(2)
  })

  skippable('a compile whose document skipped a poster never fills the shared cache: the run keeps it, nobody else sees it', async () => {
    const before = hits.skipped ?? 0
    const r = await one('skipped', 3, { owner: RUN })
    expect(r).toMatchObject({ ok: true, posterSkipped: true })
    expect((r as Extract<BakeAnswer, { ok: true }>).targets.some((t) => t.verified && t.texture.startsWith('data:image/png'))).toBe(true)
    expect(cached(3, 'skipped')).toBe(false)
    expect((await one('skipped', 3, { owner: RUN })).ok, 'the run\'s next ask: its own answer, in memory').toBe(true)
    expect(hits.skipped - before).toBe(1)
    const n = await one('skipped', 3)
    expect(n.ok).toBe(true)
    expect(hits.skipped - before, 'a normal caller is never answered with it').toBe(2)
    expect(cached(3, 'skipped')).toBe(false)
    // and when the run ends its answers go: it compiles nothing more
    endRunBakes(RUN)
    expect(bakesEnded(RUN)).toBe(true)
    expect(await one('skipped', 3, { owner: RUN })).toMatchObject({ ok: false, error: RUN_ENDED })
    expect(hits.skipped - before).toBe(2)
  })

  skippable('a run\'s jobs are counted while they wait and render, and it is idle only once they end; a page answered COMPILING meanwhile', async () => {
    bakeSeams.holdMs = 1200
    const quick = await one('second', 4, { owner: OTHER, waitMs: 1 })
    expect(quick).toMatchObject({ ok: false, error: COMPILING })
    const busy = jobsOf(OTHER)
    expect(busy.queued + busy.running, 'the page is idle; the server is not').toBe(1)
    expect(await jobsIdle(OTHER, 100), 'still compiling').toBe(false)
    expect(await jobsIdle(OTHER, 30_000)).toBe(true)
    expect(jobsOf(OTHER)).toEqual({ queued: 0, running: 0 })
    expect(cached(4, 'second')).toBe(true)
    expect(jobsOf(NORMAL_OWNER)).toEqual({ queued: 0, running: 0 })
  })

  skippable('a run that ends while its compiles wait: the queued one answers "the run ended" without rendering, the running one finishes', async () => {
    process.env.MARVER_SHOT_CONCURRENCY = '1'
    bakeSeams.holdMs = 1500
    const id = '00000000000000aa'
    const before = { third: hits.third ?? 0, fourth: hits.fourth ?? 0 }
    const answers = batch(['third', 'fourth'], 5, { owner: id })
    for (const by = Date.now() + 15_000; jobsOf(id).running === 0 && Date.now() < by;) await new Promise((r) => setTimeout(r, 20))
    expect(jobsOf(id)).toEqual({ queued: 1, running: 1 })
    endRunBakes(id)
    const [a, b] = await answers
    expect(a.ok, 'the one rendering finished').toBe(true)
    expect(b).toMatchObject({ ok: false, error: RUN_ENDED })
    expect(hits.third - before.third).toBe(1)
    expect((hits.fourth ?? 0) - before.fourth, 'never rendered').toBe(0)
    expect(jobsOf(id)).toEqual({ queued: 0, running: 0 })
    expect(readdirSync(join(root, 'design', '.local', 'bakes', '5'))).not.toContain(bakeKey(ask('fourth')))
  })
})
