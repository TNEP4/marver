import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capture, findChrome } from '../src/server/shot.ts'

// Real-Chrome coverage of the full-height capture path: grow-to-fit, height-stability, DPR
// fallback, truncation, the __mvLodBusy idle poll, and single-flight queue recovery. Gated on
// a browser being installed so CI without Chrome is skipped, not failed.
const hasChrome = !!findChrome()

// Test fixtures. mode:
//  - 'static'    : #root is exactly `h` CSS px (default).
//  - 'late'      : starts at h/2 and grows to `h` only AFTER busyMs, while __mvLodBusy reports
//                  busy until then - so a shot that measured early would UNDER-capture. Proves
//                  the settle (idle poll + two-read stability) waits for the late layout.
//  - 'creep'     : height grows monotonically by a small step forever, staying under the cap - so
//                  it is NEVER stable (never two equal consecutive reads) and never coincidentally
//                  matches, forcing growFit to terminate via its bounds (iteration/deadline), not
//                  via stability. Proves the never-settling frame returns bounded, queue recovers.
const page = (h: number, busyMs: number, mode: string) => {
  const start = mode === 'late' ? Math.round(h / 2) : h
  return `<!doctype html><html><head><meta charset=utf8>
<style>html,body{margin:0}#root{width:100%}</style></head>
<body><div id="root"><div class="mv-doc" style="height:${start}px">tall ${h}</div></div>
<script>
  var doc = document.querySelector('.mv-doc'); var t0 = Date.now();
  window.__mvLodBusy = function(){ return (Date.now()-t0) < ${busyMs} ? 1 : 0 };
  ${mode === 'late' ? `setTimeout(function(){ doc.style.height='${h}px' }, ${busyMs});` : ''}
  ${mode === 'creep' ? `var n=${h};setInterval(function(){n+=25;doc.style.height=n+'px'},100);` : ''}
</script></body></html>`
}

const pngSize = (path: string) => { const b = readFileSync(path); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } }

describe.skipIf(!hasChrome)('shot capture - full-height path against real Chrome', () => {
  let server: Server, base = '', dir = ''
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mv-shotint-'))
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost')
      res.setHeader('content-type', 'text/html')
      res.end(page(Number(u.searchParams.get('h') ?? 1000), Number(u.searchParams.get('busy') ?? 0), u.searchParams.get('mode') ?? 'static'))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }, 30_000)
  afterAll(() => { server?.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })

  const shoot = (name: string, h: number, busy = 0, mode = 'static') =>
    capture({ url: `${base}/?h=${h}&busy=${busy}&mode=${mode}`, width: 1280, height: 960, out: join(dir, `${name}.png`), fullHeight: true })

  it('short content shrinks to its measured height (not padded), DPR 2', async () => {
    const r = await shoot('short', 1200)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.width).toBe(1280); expect(r.scale).toBe(2)
    expect(r.height).toBeGreaterThanOrEqual(1150); expect(r.height).toBeLessThanOrEqual(1300)
    const px = pngSize(join(dir, 'short.png'))
    expect(px).toEqual({ w: r.width * r.scale, h: r.height * r.scale })   // exact IHDR assertion
  }, 30_000)

  it('a LATE layout change (busy until 1200ms, then grows h/2 -> h) is captured, not under-measured', async () => {
    const r = await shoot('late', 1500, 1200, 'late')   // starts 750, grows to 1500 after busy clears
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.height).toBeGreaterThanOrEqual(1450); expect(r.height).toBeLessThanOrEqual(1600)   // full, not the early 750
  }, 30_000)

  it('tall content under 8192 captures full height at DPR 2', async () => {
    const r = await shoot('tall', 6000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scale).toBe(2)
    expect(r.height).toBeGreaterThanOrEqual(5900); expect(r.height).toBeLessThanOrEqual(6100)
    expect(pngSize(join(dir, 'tall.png'))).toEqual({ w: 1280 * 2, h: r.height * 2 })
  }, 30_000)

  it('over 8192 drops to DPR 1 and still captures full height', async () => {
    const r = await shoot('over8192', 10000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scale).toBe(1); expect(r.truncated).toBeUndefined()
    expect(r.height).toBeGreaterThanOrEqual(9800); expect(r.height).toBeLessThanOrEqual(10100)
    expect(pngSize(join(dir, 'over8192.png'))).toEqual({ w: 1280, h: r.height })
  }, 30_000)

  it('over 16384 truncates at the cap, at DPR 1, with an explanatory note', async () => {
    const r = await shoot('over16384', 20000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scale).toBe(1); expect(r.height).toBe(16384); expect(r.truncated).toBe(true)
    expect(r.note).toMatch(/20000px tall.*top 16384px/)
    expect(pngSize(join(dir, 'over16384.png'))).toEqual({ w: 1280, h: 16384 })
  }, 30_000)

  it('a never-settling frame (monotonic creep under the cap) returns bounded AND the queue keeps serving', async () => {
    const t = Date.now()
    const r = await shoot('creep', 1500, 0, 'creep')   // grows +25px/100ms forever: never two equal reads, never hits the cap
    expect(Date.now() - t).toBeLessThan(20_000)     // bounded by growFit's iteration/deadline caps, not the 45s watchdog
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.scale).toBe(2); expect(r.truncated).toBeUndefined() }   // stayed under CAP2, not truncated
    // the single-flight queue must not be wedged - a normal shot right after must run
    const next = await capture({ url: `${base}/?h=900`, width: 390, height: 844, out: join(dir, 'after.png'), fullHeight: false })
    expect(next.ok).toBe(true)
    if (next.ok) { expect(next.width).toBe(390); expect(next.height).toBe(844); expect(next.scale).toBe(2) }
  }, 40_000)
})
