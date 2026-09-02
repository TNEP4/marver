import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AREA, capture, findChrome } from '../src/server/shot.ts'

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

/** Decode one pixel of a non-interlaced 8-bit RGB/RGBA PNG (what Chrome writes) - enough to ask
 *  "did the late image paint?" without an image dependency. */
function pngPixel(path: string, x: number, y: number): [number, number, number] {
  const b = readFileSync(path)
  const w = b.readUInt32BE(16), ct = b[25]
  const bpp = ct === 6 ? 4 : 3
  let pos = 8; const idat: Buffer[] = []
  while (pos < b.length) {
    const len = b.readUInt32BE(pos), type = b.toString('ascii', pos + 4, pos + 8)
    if (type === 'IDAT') idat.push(b.subarray(pos + 8, pos + 8 + len))
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  let prev = Buffer.alloc(stride)
  for (let row = 0; row <= y; row++) {
    const f = raw[row * (stride + 1)]
    const line = Buffer.from(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      if (f === 1) line[i] = (line[i] + a) & 255
      else if (f === 2) line[i] = (line[i] + up) & 255
      else if (f === 3) line[i] = (line[i] + ((a + up) >> 1)) & 255
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c)) & 255 }
    }
    prev = line
  }
  return [prev[x * bpp], prev[x * bpp + 1], prev[x * bpp + 2]]
}
// a 1x1 red PNG, served late to prove the settle waits for in-viewport images
const RED_PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')

describe.skipIf(!hasChrome)('shot capture - full-height path against real Chrome', () => {
  let server: Server, base = '', dir = ''
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mv-shotint-'))
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost')
      if (u.pathname === '/slow.png') {   // the late image: bytes after `d` ms
        setTimeout(() => { res.setHeader('content-type', 'image/png'); res.end(RED_PX) }, Number(u.searchParams.get('d') ?? 900))
        return
      }
      if (u.pathname === '/late-mount') {   // #root stays empty until `m` ms, then shows a 10s-late image
        res.setHeader('content-type', 'text/html')
        res.end(`<!doctype html><html><body style="margin:0;background:#fff"><div id="root"></div><script>setTimeout(function(){document.getElementById('root').innerHTML='<img src="/slow.png?d=10000" width="300" height="300">'}, ${u.searchParams.get('m') ?? 3500})</script></body></html>`)
        return
      }
      if (u.pathname === '/late-image') {
        res.setHeader('content-type', 'text/html')
        res.end(`<!doctype html><html><body style="margin:0;background:#fff"><div id="root"><img src="/slow.png?d=${u.searchParams.get('d') ?? 900}" width="300" height="300" style="display:block"></div></body></html>`)
        return
      }
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

  // ---- settle: a fixed-viewport frame whose image arrives late must still show it
  it('an in-viewport image that arrives 900ms late IS in the capture (the settle waits for it)', async () => {
    const r = await capture({ url: `${base}/late-image?d=900`, width: 400, height: 400, out: join(dir, 'late-img.png'), fullHeight: false, scale: 1 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(pngPixel(join(dir, 'late-img.png'), 150, 150)).toEqual([255, 0, 0])
  }, 30_000)

  it('an image slower than the settle budget (5s) does not hang the shot - it captures without it, bounded', async () => {
    const t = Date.now()
    const r = await capture({ url: `${base}/late-image?d=5000`, width: 400, height: 400, out: join(dir, 'never-img.png'), fullHeight: false, scale: 1 })
    expect(r.ok).toBe(true)
    expect(Date.now() - t).toBeLessThan(12_000)
    if (r.ok) expect(pngPixel(join(dir, 'never-img.png'), 150, 150)).toEqual([255, 255, 255])
  }, 30_000)

  it('a frame that mounts just before its readiness timeout gets NO settle budget and still captures inside the watchdog', async () => {
    // timeoutMs 4s -> watchdog at 19s; the 21s reserve leaves nothing discretionary after a 3.5s
    // mount, so the settle must be skipped (not wait 3s for the 10s image) and the shot returns
    const t = Date.now()
    const r = await capture({ url: `${base}/late-mount?m=3500`, width: 400, height: 400, out: join(dir, 'late-mount.png'), fullHeight: false, scale: 1, timeoutMs: 4000 })
    expect(r.ok).toBe(true)
    expect(Date.now() - t).toBeLessThan(8_000)
  }, 30_000)

  // ---- scale (copy-as-image 4x, `marver shot --scale`)
  it('scale 4 on a fixed frame: 1280×720 -> a 5120×2880 PNG, no note', async () => {
    const r = await capture({ url: `${base}/?h=720`, width: 1280, height: 720, out: join(dir, 'fixed4.png'), fullHeight: false, scale: 4 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r).toEqual({ ok: true, width: 1280, height: 720, scale: 4 })
    expect(pngSize(join(dir, 'fixed4.png'))).toEqual({ w: 5120, h: 2880 })
  }, 30_000)

  it('scale 4 on short content: full height at 4x', async () => {
    const r = await capture({ url: `${base}/?h=1200`, width: 1280, height: 960, out: join(dir, 'short4.png'), fullHeight: true, scale: 4 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scale).toBe(4); expect(r.note).toBeUndefined()
    expect(pngSize(join(dir, 'short4.png'))).toEqual({ w: 1280 * 4, h: r.height * 4 })
  }, 30_000)

  it('scale 4 on content taller than 4096 steps DOWN to 2x (not truncated) and says so', async () => {
    const r = await capture({ url: `${base}/?h=5000`, width: 1280, height: 960, out: join(dir, 'tall4.png'), fullHeight: true, scale: 4 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scale).toBe(2); expect(r.truncated).toBeUndefined()
    expect(r.note).toMatch(/too tall for 4x, captured at 2x/)
    expect(r.height).toBeGreaterThanOrEqual(4900); expect(r.height).toBeLessThanOrEqual(5100)
    expect(pngSize(join(dir, 'tall4.png'))).toEqual({ w: 1280 * 2, h: r.height * 2 })
  }, 40_000)

  it('scale 1 is honoured on the fixed path', async () => {
    const r = await capture({ url: `${base}/?h=844`, width: 390, height: 844, out: join(dir, 'fixed1.png'), fullHeight: false, scale: 1 })
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.scale).toBe(1); expect(pngSize(join(dir, 'fixed1.png'))).toEqual({ w: 390, h: 844 }) }
  }, 30_000)
})

describe.skipIf(!hasChrome)('shot capture - the area budget on fixed frames', () => {
  let server: Server, base = '', dir = ''
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mv-shotarea-'))
    server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(page(500, 0, 'static')) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }, 30_000)
  afterAll(() => { server?.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('3840×2160 @4 (133M px) steps down to the largest scale inside the budget: 2 (33M px)', async () => {
    expect(3840 * 2160 * 16).toBeGreaterThan(AREA); expect(3840 * 2160 * 4).toBeLessThanOrEqual(AREA)
    const r = await capture({ url: `${base}/`, width: 3840, height: 2160, out: join(dir, 'uhd.png'), fullHeight: false, scale: 4 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scale).toBe(2)
    expect(pngSize(join(dir, 'uhd.png'))).toEqual({ w: 7680, h: 4320 })
  }, 40_000)
})
