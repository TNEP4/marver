import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Browser as Cdp, findChrome } from '../src/server/cdp.ts'
import { COMPILING, LOOPING, bakeBatch, bakeIn, bakeKey, ofTheFrame } from '../src/server/bake.ts'
import { PAGES } from './fixtures/glass-pages.ts'

/**
 * The compiler behind sleep (spec 16), on synthetic glass pages served from memory: what it
 * certifies, what it refuses, and the shape of what it returns. Every case is a property of the
 * result, not of the constants that produced it - a texture is accepted only when the compiler
 * itself found the page pixel-identical inside the glass.
 */

let http: Server | null = null
let origin = ''
/** How many times each page was loaded - one load is one compile. */
const hits: Record<string, number> = {}
let b: Cdp | null = null

beforeAll(async () => {
  http = createServer((req, res) => {
    const name = (req.url ?? '/').slice(1).split('?')[0]
    hits[name] = (hits[name] ?? 0) + 1
    const html = PAGES[name]
    if (!html) { res.statusCode = 404; return res.end() }
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html)
  })
  await new Promise<void>((r) => http!.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  if (findChrome()) b = await Cdp.launch('mv-bake-test-')
}, 60_000)

afterAll(() => { void b?.close(); http?.close() })

const skippable = (name: string, fn: () => Promise<void>, ms = 90_000) =>
  it(name, async (ctx) => { if (!b) return ctx.skip(); await fn() }, ms)

const bake = (name: string) => bakeIn(b!, { url: `${origin}/${name}`, width: 600, height: 400 })
const pngSize = (dataUrl: string) => { const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'); return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } }

describe('the compiler (bake.ts)', () => {
  skippable('a page without backdrop-filter has nothing to compile', async () => {
    const r = await bake('plain')
    expect(r).toMatchObject({ ok: true, targets: [], levels: 0, rejected: 0 })
  })

  skippable('one glass pill: certified, with a texture of exactly its border box', async () => {
    const r = await bake('glass')
    if (!r.ok) throw new Error(r.error)
    expect(r.levels).toBe(1)
    expect(r.rejected).toBe(0)
    expect(r.targets).toHaveLength(1)
    const t = r.targets[0]
    expect(t.sel).toBe('#pill')
    expect(t.rect).toEqual({ x: 100, y: 100, w: 242, h: 62 })   // the border box (1px border)
    expect(t.filter).toBe('blur(12px)')
    expect(t.verified).toBe(true)
    expect(t.maxErr).toBeLessThanOrEqual(32)
    expect(t.texture.startsWith('data:image/png;base64,')).toBe(true)
    expect(pngSize(t.texture)).toEqual({ w: 242, h: 62 })   // TEXTURE_DSF 1: one texel per CSS px
  })

  skippable('glass inside glass stays live, both of them (the inner one reads an unfiltered backdrop)', async () => {
    const r = await bake('nested')
    if (!r.ok) throw new Error(r.error)
    expect(r.targets).toEqual([])
    expect(r.levels).toBe(0)
  })

  skippable('two overlapping siblings: the one painted later reads the earlier one, and both certify', async () => {
    const r = await bake('later')
    if (!r.ok) throw new Error(r.error)
    const byId = Object.fromEntries(r.targets.map((t) => [t.sel, t]))
    expect(byId['#a'].level).toBe(0)
    expect(byId['#b'].level).toBe(1)
    expect(r.rejected).toBe(0)
  })

  skippable('an authored !important opacity survives the hide-and-show and still certifies', async () => {
    const r = await bake('opacity')
    if (!r.ok) throw new Error(r.error)
    expect(r.targets).toHaveLength(1)
    expect(r.targets[0].verified).toBe(true)
  })

  skippable('a mix-blend-mode glass is refused by certification (it stays live)', async () => {
    const r = await bake('blend')
    if (!r.ok) throw new Error(r.error)
    expect(r.targets).toHaveLength(1)
    expect(r.targets[0].verified).toBe(false)
  })

  skippable('a backdrop that never stops changing is refused, not certified', async () => {
    const r = await bake('restless')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/never stopped changing/)
  })

  skippable('the geometry guard: an override that moves any box - even one outside every glass - rejects every texture', async () => {
    const r = await bake('moving')
    if (!r.ok) throw new Error(r.error)
    expect(r.targets).toHaveLength(1)
    expect(r.targets[0].maxErr).toBeLessThanOrEqual(32)   // the pixels inside the glass were fine
    expect(r.targets[0].verified).toBe(false)              // the box that moved was not
    expect(r.rejected).toBe(1)
  })

  skippable('paint that changes outside every glass box - the pill itself fine - ships nothing', async () => {
    const r = await bake('outside')
    if (!r.ok) throw new Error(r.error)
    expect(r.targets).toHaveLength(1)
    expect(r.targets[0].maxErr).toBeLessThanOrEqual(32)   // inside the glass, certified
    expect(r.targets[0].verified).toBe(false)              // the frame around it was not
    expect(r.outside!.blockMax).toBeGreaterThan(64)
  })

  it('pruning spares a generation another live server owns, and drops a dead one', async () => {
    const { pruneBakes } = await import('../src/server/bake.ts')
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { spawn } = await import('node:child_process')
    const root = mkdtempSync(join(tmpdir(), 'mv-prune-'))
    const base = join(root, 'design', '.local', 'bakes')
    const other = spawn('sleep', ['30'])
    try {
      for (const [gen, owner] of [['100', String(other.pid)], ['200', '999999'], ['300', String(process.pid)], ['400', '']]) {
        mkdirSync(join(base, gen), { recursive: true })
        if (owner) writeFileSync(join(base, gen, 'owner'), owner)
      }
      pruneBakes(root, 500)
      expect(existsSync(join(base, '100')), 'a live server\'s generation').toBe(true)
      expect(existsSync(join(base, '200')), 'a dead server\'s generation').toBe(false)
      expect(existsSync(join(base, '300')), 'this server\'s own older generation').toBe(false)
      expect(existsSync(join(base, '400')), 'an ownerless generation').toBe(false)
    } finally { other.kill() }
  })

  skippable('an authored background-clip keeps the tint off a transparent border, and the perimeter certifies', async () => {
    const r = await bake('clip')
    if (!r.ok) throw new Error(r.error)
    expect(r.targets).toHaveLength(1)
    expect(r.targets[0].verified).toBe(true)
  })

  skippable('a looping animation is refused at once: the live sleep freezes it at a phase no texture can promise', async () => {
    const t = Date.now()
    const r = await bake('spinner')
    expect(r).toMatchObject({ ok: false, error: LOOPING })
    expect(Date.now() - t, 'no settle checks, no captures').toBeLessThan(5000)
  })

  it('only a failure of the frame itself is remembered - never one of the browser, the cache or the source', () => {
    for (const e of [LOOPING, 'the frame never stopped changing - nothing to certify against', 'the frame did not settle (2 image(s) or chart(s) still loading)', 'the bake timed out', 'too many effects to compile (90)'])
      expect(ofTheFrame(e), e).toBe(true)
    for (const e of ['devtools pipe error', 'Target closed', 'the source changed during the compile', 'could not load the frame (net::ERR_CONNECTION_REFUSED)', 'ENOSPC: no space left on device, write'])
      expect(ofTheFrame(e), e).toBe(false)
  })

  it('a bake key names the frame, theme and rounded size - nothing else', () => {
    const k = bakeKey({ frame: 'app/home', theme: 'light', w: 390.4, h: 844 })
    expect(k).toMatch(/^[0-9a-f]{16}$/)
    expect(bakeKey({ frame: 'app/home', theme: 'light', w: 390, h: 844.2 })).toBe(k)
    expect(bakeKey({ frame: 'app/home', theme: 'dark', w: 390, h: 844 })).not.toBe(k)
    expect(bakeKey({ frame: 'app/home', theme: 'light', w: 391, h: 844 })).not.toBe(k)
  })
})

/** bakeBatch as the dev server calls it (issue #23): the page's request must never be held by a
 *  compile, and a frame that cannot be certified must not be compiled again on every rest. */
describe('the batch (bakeBatch)', () => {
  let root = ''
  beforeAll(async () => {
    const { mkdtempSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    root = mkdtempSync(join(tmpdir(), 'mv-batch-'))
  })
  const ask = (frame: string) => ({ frame, theme: 'light', w: 600, h: 400 })
  const batch = (frame: string, gen: number, more: { waitMs?: number; live?: () => number } = {}) =>
    bakeBatch({ root, gen, asks: [ask(frame)], urlFor: (a) => `${origin}/${a.frame}`, urlBase: '/bakes', ...more }).then((r) => r[0])

  skippable('a failed compile is answered from memory for its generation, and compiled again in the next', async () => {
    const first = await batch('restless', 1)
    expect(first.ok).toBe(false)
    const loads = hits.restless
    const again = await batch('restless', 1)
    expect(again).toMatchObject({ ok: false, error: (first as { error: string }).error })
    expect(hits.restless, 'no second compile in the same generation').toBe(loads)
    await batch('restless', 2)
    expect(hits.restless, 'an edit (a new generation) tries again').toBe(loads + 1)
  })

  skippable('a failure that says nothing about the frame is not remembered', async () => {
    const outrun = await batch('glass', 10, { live: () => 11 })
    expect(outrun).toMatchObject({ ok: false, error: expect.stringMatching(/source changed/) })
    const r = await batch('glass', 10)
    expect(r.ok).toBe(true)
  })

  skippable('a request that stops waiting gets COMPILING, the compile carries on, and the next ask finds it', async () => {
    const before = hits.later ?? 0
    const t = Date.now()
    const quick = await batch('later', 20, { waitMs: 1 })
    expect(quick).toMatchObject({ ok: false, error: COMPILING })
    expect(Date.now() - t, 'the caller is answered without waiting for the compile').toBeLessThan(500)
    const done = await batch('later', 20)
    expect(done.ok).toBe(true)
    expect(hits.later, 'one compile served both asks').toBe(before + 1)
    const cached = await batch('later', 20, { waitMs: 1 })
    expect(cached.ok, 'from the cache, at once').toBe(true)
  })
})
