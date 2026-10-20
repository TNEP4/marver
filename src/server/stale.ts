/**
 * A guard for one known corruption of headless Chrome's screenshots (#14, #24) - not a proof that a picture is right.
 *
 * `Page.captureScreenshot` with a clip resizes the tab's native view to clip x scale, asks for a redraw and copies the
 * view's surface; when the copy wins the race against the resize it gets the old surface, smaller than asked, and
 * Chrome fills the request by tiling it (page_handler.cc: ScreenshotCaptured -> SkBitmapOperations::CreateTiledBitmap).
 * So every pixel (x, y) of a stale picture equals pixel (x mod w0, y mod h0), w0 x h0 being the native view in device px.
 *
 * The image is streamed row by row - inflated, unfiltered, the last h0 rows kept - and the check stops at the first row
 * that breaks the repeat: a real picture costs its first row or two, and only a true repeat is read to the end (two
 * identical panels over different content are clean). What it reads is what Chrome writes: 8-bit RGB/RGBA, not
 * interlaced, filters 0-4, alpha compared too; anything else, or a deadline passed, is 'unknown' - never 'clean'.
 */
import { createInflate } from 'node:zlib'

export type Staleness = 'stale' | 'clean' | 'unknown'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Is this PNG the native view's old surface (w0 x h0 device px) tiled to the requested size? `deadline` (epoch ms):
 *  past it the check gives up ('unknown'). */
export async function staleSurface(png: Buffer, w0: number, h0: number, deadline = Infinity): Promise<Staleness> {
  if (!(w0 > 0 && h0 > 0) || png.length < 33 || !png.subarray(0, 8).equals(SIG)) return 'unknown'
  // chunks, bounded: IHDR first, then the IDAT data in order
  let pos = 8
  let w = 0, h = 0, channels = 0
  const idat: Buffer[] = []
  while (pos + 12 <= png.length) {
    const len = png.readUInt32BE(pos)
    const type = png.toString('latin1', pos + 4, pos + 8)
    if (pos + 12 + len > png.length) return 'unknown'
    const data = png.subarray(pos + 8, pos + 8 + len)
    if (pos === 8) {
      if (type !== 'IHDR' || len !== 13) return 'unknown'
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      const depth = data[8], colour = data[9], interlace = data[12]
      if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0 || !w || !h) return 'unknown'
      channels = colour === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (!channels || !idat.length) return 'unknown'
  // no bigger than the view in either direction: nothing was tiled
  if (w <= w0 && h <= h0) return 'clean'
  const stride = w * channels
  const wide = w > w0, tall = h > h0
  const th = Math.min(h, h0), tw = Math.min(w, w0), shift = w0 * channels, n = (w - w0) * channels
  const ring = tall ? Array.from({ length: h0 }, () => Buffer.alloc(stride)) : []
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride)
  const first = Buffer.alloc(channels)
  let varied = false

  /** One unfiltered row: true to go on, a verdict to stop. */
  const check = (y: number, row: Buffer): Staleness | true => {
    if (y === 0) row.copy(first, 0, 0, channels)
    if (y < th && !varied) for (let x = 0; x < tw; x++) if (row.compare(first, 0, channels, x * channels, (x + 1) * channels) !== 0) { varied = true; break }
    if (wide && row.compare(row, 0, n, shift, shift + n) !== 0) return 'clean'
    if (tall) {
      const slot = ring[y % h0]
      if (y >= h0 && !row.equals(slot)) return 'clean'
      row.copy(slot)
    }
    // the first tile a single colour (every pixel compared): a repeat proves nothing
    if (y === th - 1 && !varied) return 'clean'
    return y === h - 1 ? 'stale' : true
  }

  return new Promise<Staleness>((resolve) => {
    const z = createInflate()
    let done = false
    const finish = (v: Staleness) => { if (done) return; done = true; z.removeAllListeners(); z.on('error', () => {}); z.destroy(); resolve(v) }
    // the filtered row being assembled: its filter byte, then `stride` bytes
    const raw = Buffer.alloc(stride + 1)
    let fill = 0, y = 0
    z.on('data', (c: Buffer) => {
      if (done) return
      if (Date.now() > deadline) return finish('unknown')
      let i = 0
      while (i < c.length && !done) {
        const take = Math.min(stride + 1 - fill, c.length - i)
        c.copy(raw, fill, i, i + take)
        fill += take; i += take
        if (fill < stride + 1) break
        fill = 0
        if (!unfilterRow(raw, prev, cur, channels)) return finish('unknown')
        const v = check(y, cur)
        if (v !== true) return finish(v)
        const t = prev; prev = cur; cur = t
        y++
      }
    })
    // the data ran out before the last row: not something to judge
    z.on('end', () => finish('unknown'))
    z.on('error', () => finish('unknown'))
    // fed one chunk at a time, so a verdict leaves the rest unread
    let k = 0
    const feed = () => {
      while (!done && k < idat.length) { if (!z.write(idat[k++])) { z.once('drain', feed); return } }
      if (!done && k >= idat.length) z.end()
    }
    feed()
  })
}

/** One row of PNG filter 0-4 (`raw[0]` the filter byte) into `out`, given the row above; false on any other filter. */
function unfilterRow(raw: Buffer, up: Buffer, out: Buffer, bpp: number): boolean {
  const f = raw[0]
  if (f > 4) return false
  const len = out.length
  for (let i = 0; i < len; i++) {
    const x = raw[i + 1]
    const a = i >= bpp ? out[i - bpp] : 0
    const b = up[i]
    const c = i >= bpp ? up[i - bpp] : 0
    let v: number
    if (f === 0) v = x
    else if (f === 1) v = x + a
    else if (f === 2) v = x + b
    else if (f === 3) v = x + ((a + b) >> 1)
    else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) }
    out[i] = v & 255
  }
  return true
}
