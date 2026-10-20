import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capture, captureIn, findChrome, pool, shotEvent, shotSeams, withBrowser } from '../src/server/shot.ts'
import { staleSurface } from '../src/server/stale.ts'
import { png } from './png-fixture.ts'

/**
 * #14, #24 against real Chrome: Chrome copies the tab's view before it has resized it for the screenshot and tiles
 * that old surface over the picture. A capture now sizes its own window to the capture (fixed frames, slides), and
 * every capture is checked: a tiled picture is taken again - twice at most, with time left - a full-height frame tries
 * 1x, and a picture that stays tiled fails rather than shipping. The stale surface is injected at the capture
 * boundary (Chrome's own race is too rare to drive a test); the pictures it is injected over are real.
 */
const hasChrome = !!findChrome()

// varied content, so a repeat in a picture is never an accident
const page = (h: number, doc: boolean) => `<!doctype html><html><head><meta charset=utf8>
<style>html,body{margin:0}#root{width:100%}.b{height:37px;border-bottom:3px solid}</style></head>
<body><div id="root"><div class="${doc ? 'mv-doc' : ''}" style="height:${h}px;overflow:hidden">
${Array.from({ length: Math.ceil(h / 40) }, (_, i) => `<div class="b" style="background:hsl(${(i * 47) % 360} 70% ${30 + (i * 13) % 50}%);margin-left:${(i * 29) % 300}px">row ${i}</div>`).join('')}
</div></div></body></html>`

const size = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) })
const tiledLike = (real: Buffer, view: { w: number; h: number }) => {
  const { w, h } = size(real)
  return png(w, h, (x, y) => { const a = x % view.w, b = y % view.h; return [(a * 7 + b * 3) & 255, (a * 13 + b * 29) & 255, (a ^ b) & 255, 255] })
}

describe.skipIf(!hasChrome)('a stale surface never ships as the frame (#14, #24)', () => {
  let server: Server, base = '', dir = ''
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mv-stale-'))
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost')
      res.setHeader('content-type', 'text/html')
      res.end(page(Number(u.searchParams.get('h') ?? 1200), u.searchParams.get('doc') === '1'))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }, 30_000)
  afterAll(() => { server?.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })
  afterEach(() => { for (const k of Object.keys(shotSeams)) delete (shotSeams as any)[k] })

  const doc = (name: string, extra: Partial<Parameters<typeof capture>[0]> = {}) =>
    capture({ url: `${base}/?h=1200&doc=1`, width: 1280, height: 960, out: join(dir, `${name}.png`), fullHeight: true, ...extra })

  it('a picture that came back tiled is taken again, and the clean one ships', async () => {
    const seen: number[] = []
    shotSeams.capture = (real, at) => { seen.push(at.attempt); return at.attempt === 0 && at.view ? tiledLike(real, at.view) : real }
    const r = await doc('once')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.recaptures).toBe(1)
    expect(seen).toEqual([0, 1])
    const shipped = readFileSync(join(dir, 'once.png'))
    expect(size(shipped)).toEqual({ w: r.width * r.scale, h: r.height * r.scale })
    expect(await staleSurface(shipped, 756, 469)).not.toBe('stale')
  }, 60_000)

  it('a full-height frame still tiled at 2x after two retakes is taken at 1x - checked too, and named for it', async () => {
    shotSeams.capture = (real, at) => (at.attempt < 3 && at.view ? tiledLike(real, at.view) : real)
    const r = await doc('onex')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scale).toBe(1)
    expect(r.recaptures).toBe(3)
    expect(r.note).toMatch(/came back tiled at 2x - captured at 1x/)
    expect(size(readFileSync(join(dir, 'onex.png')))).toEqual({ w: r.width, h: r.height })
  }, 60_000)

  it('a picture that stays tiled fails - "stale surface" - and writes nothing: a full-height frame after its 1x attempt', async () => {
    const seen: number[] = []
    shotSeams.capture = (real, at) => { seen.push(at.attempt); return at.view ? tiledLike(real, at.view) : real }
    const r = await doc('never')
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/stale surface/) })
    expect(seen).toEqual([0, 1, 2, 3])
    expect(existsSync(join(dir, 'never.png'))).toBe(false)
  }, 60_000)

  it('a fixed frame whose window could not be sized and stays tiled: two retakes, no 1x, it fails and writes nothing', async () => {
    shotSeams.resize = false
    const seen: { attempt: number; view: { w: number; h: number } | null }[] = []
    shotSeams.capture = (real, at) => { seen.push({ attempt: at.attempt, view: at.view }); return at.view ? tiledLike(real, at.view) : real }
    const r = await capture({ url: `${base}/?h=800`, width: 1280, height: 800, out: join(dir, 'fixed-never.png'), scale: 2 })
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/stale surface/) })
    expect(seen.map((x) => x.attempt)).toEqual([0, 1, 2])
    // its timing line keeps the retakes it took, with the outcome
    expect(shotEvent('spec/fixed', 2, r)).toMatchObject({ kind: 'shot', frame: 'spec/fixed', outcome: 'stale', recaptures: 2 })
    // never resized: the view is still the window's own, smaller than the picture
    expect(seen.every((x) => x.view && (x.view.w < 2560 || x.view.h < 1600))).toBe(true)
    expect(existsSync(join(dir, 'fixed-never.png'))).toBe(false)
  }, 60_000)

  it('a retake starts only with enough of the deadline left - on either side of it', async () => {
    let calls = 0
    shotSeams.capture = (real, at) => { calls++; return at.attempt === 0 && at.view ? tiledLike(real, at.view) : real }
    // the boundary past the whole watchdog: no time is ever enough - it fails at once
    shotSeams.retryLeftMs = 60 * 60_000
    const tight = await doc('tight')
    expect(tight.ok).toBe(false)
    expect(calls).toBe(1)
    calls = 0
    // the real boundary (3 s): there is time - it retakes
    delete shotSeams.retryLeftMs
    const room = await doc('room')
    expect(room.ok && room.recaptures).toBe(1)
    expect(calls).toBe(2)
  }, 60_000)

  it('a batch of mixed sizes: each capture in its own window, each fixed frame\'s view sized to its picture, every picture clean', async () => {
    const seen: { name: string; view: { w: number; h: number } | null; windowId?: number }[] = []
    const reqs = [
      { name: 'laptop', width: 1280, height: 800, fullHeight: false },
      { name: 'phone', width: 390, height: 844, fullHeight: false },
      { name: 'slide', width: 1280, height: 720, fullHeight: false },
      { name: 'doc', width: 1280, height: 960, fullHeight: true },
    ]
    const views = new Map<string, { w: number; h: number } | null>()
    shotSeams.capture = (real, at) => { seen.push({ name: String(at.windowId), view: at.view, windowId: at.windowId }); const { w, h } = size(real); views.set(`${w}x${h}`, at.view); return real }
    const results = await withBrowser('shot', (b) => pool(4, reqs, (q) =>
      captureIn({ url: `${base}/?h=${q.fullHeight ? 1200 : q.height}${q.fullHeight ? '&doc=1' : ''}`, width: q.width, height: q.height, out: join(dir, `mix-${q.name}.png`), fullHeight: q.fullHeight, scale: 2 }, b)))
    expect(results.every((r) => r.ok)).toBe(true)
    expect(new Set(seen.map((s) => s.windowId)).size).toBe(reqs.length)
    for (const [i, q] of reqs.entries()) {
      const r = results[i]
      if (!r.ok) continue
      const shipped = readFileSync(join(dir, `mix-${q.name}.png`))
      expect(size(shipped)).toEqual({ w: r.width * r.scale, h: r.height * r.scale })
      expect(r.recaptures).toBe(0)
      // judged against the view it was taken with: clean, not merely "not stale"
      const v = views.get(`${r.width * r.scale}x${r.height * r.scale}`)
      expect(v).toBeTruthy()
      expect(await staleSurface(shipped, v!.w, v!.h)).toBe('clean')
      // a fixed frame's view was its picture's size when it was taken
      if (!q.fullHeight) expect(seen.some((s) => s.view?.w === q.width * 2 && s.view?.h === q.height * 2)).toBe(true)
    }
  }, 120_000)

  it('captures sharing a window (no window of their own) never resize it from under each other', async () => {
    shotSeams.newWindow = false
    const resized: number[] = []
    const held: (number | undefined)[] = []
    shotSeams.onResize = (w) => resized.push(w)
    shotSeams.capture = (real, at) => { held.push(at.windowId); return real }
    const reqs = [{ w: 1280, h: 800 }, { w: 390, h: 844 }]
    const results = await withBrowser('shot', (b) => pool(2, reqs, (q, i) => captureIn({ url: `${base}/?h=${q.h}`, width: q.w, height: q.h, out: join(dir, `shared-${i}.png`), scale: 2 }, b)))
    expect(results.every((r) => r.ok)).toBe(true)
    // a window two captures were in was resized at most once (by the first, while it was alone in it)
    for (const w of new Set(held)) if (held.filter((x) => x === w).length > 1) expect(resized.filter((x) => x === w).length).toBeLessThanOrEqual(1)
  }, 60_000)

  it('a capture whose window cannot be named: nothing is resized, and its picture says it was not checked', async () => {
    shotSeams.resize = undefined
    const resized: number[] = []
    shotSeams.onResize = (w) => resized.push(w)
    // the window lookup made to fail: the capture registers as unknown
    shotSeams.newWindow = true
    shotSeams.noWindow = true
    const r = await capture({ url: `${base}/?h=800`, width: 1280, height: 800, out: join(dir, 'nowin.png'), scale: 2 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(resized).toEqual([])
    expect(r.note).toMatch(/not checked for a stale surface/)
  }, 60_000)
})
