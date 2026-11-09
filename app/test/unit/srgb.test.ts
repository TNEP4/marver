/**
 * Live pictures in sRGB pixels (spec 31 H.4; app/src/main/srgb.ts, live-picture.ts): a readback tagged with a P3
 * display's profile is converted, not re-labelled - #0088ff seen on a P3 display (read back as 59,134,247, Nic's #53
 * check) reads (0,136,255) +-2 - through a synthesized Display P3 profile and, on a Mac, the system's own; the PNG
 * comes back tagged sRGB with no iCCP; an untagged PNG, an sRGB-profiled one and a PNG it cannot read stay exactly as
 * they came; and main's capture handler answers with the converted bytes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { toSrgb } from '../../src/main/srgb.ts'
import { livePictures, type PictureImage } from '../../src/main/live-picture.ts'

vi.mock('electron', () => ({ app: {} }))
vi.mock('../../src/main/testing/index.ts', () => ({ note: vi.fn() }))

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}

/** A w x h RGBA PNG of one colour, with the profile (if any) as its iCCP. */
function png(rgb: [number, number, number], icc?: Buffer, w = 5, h = 3): Uint8Array {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  const rows: number[] = []
  // filters of every kind, so the decoder's unfiltering is exercised: row y uses filter y % 5 over raw bytes
  // computed back from the pixels
  const px = Array.from({ length: h }, () => Array.from({ length: w }, () => [...rgb, 255]).flat())
  for (let y = 0; y < h; y++) {
    const f = y % 5
    rows.push(f)
    for (let x = 0; x < w * 4; x++) {
      const v = px[y][x], a = x >= 4 ? px[y][x - 4] : 0, b = y ? px[y - 1][x] : 0, c = y && x >= 4 ? px[y - 1][x - 4] : 0
      const pa = Math.abs(a + b - c - a), pb = Math.abs(a + b - c - b), pc = Math.abs(a + b - c - c)
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      rows.push((v - pred) & 0xff)
    }
  }
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)]
  if (icc) parts.push(chunk('iCCP', Buffer.concat([Buffer.from('Display\0\0', 'latin1'), deflateSync(icc)])))
  parts.push(chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0)))
  return new Uint8Array(Buffer.concat(parts))
}

/** The PNG's chunk types, and its first pixel. */
function read(b: Uint8Array): { chunks: string[]; first: number[] } {
  const buf = Buffer.from(b)
  const chunks: string[] = []
  const idat: Buffer[] = []
  let w = 0
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8)
    chunks.push(type)
    if (type === 'IHDR') w = buf.readUInt32BE(o + 8)
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len))
    o += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  expect(raw[0]).toBe(0)   // the first row is unfiltered (None): its first pixel is its bytes
  void w
  return { chunks, first: [raw[1], raw[2], raw[3]] }
}

/** A matrix/TRC display profile: these primaries (D50, columns) and the sRGB curve as a `para` type 3. */
function profile(prim: [number, number, number][]): Buffer {
  const fx = (v: number) => { const b = Buffer.alloc(4); b.writeInt32BE(Math.round(v * 65536)); return b }
  const xyz = (v: [number, number, number]) => Buffer.concat([Buffer.from('XYZ \0\0\0\0', 'latin1'), ...v.map(fx)])
  const para = Buffer.concat([Buffer.from('para\0\0\0\0', 'latin1'), Buffer.from([0, 3, 0, 0]), ...[2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045].map(fx)])
  const tags: [string, Buffer][] = [['rXYZ', xyz(prim[0])], ['gXYZ', xyz(prim[1])], ['bXYZ', xyz(prim[2])], ['rTRC', para], ['gTRC', para], ['bTRC', para]]
  const head = Buffer.alloc(128)
  head.write('mntr', 12, 'latin1'); head.write('RGB ', 16, 'latin1'); head.write('XYZ ', 20, 'latin1'); head.write('acsp', 36, 'latin1')
  head.writeUInt32BE(0x04300000, 8)
  const table = Buffer.alloc(4 + 12 * tags.length)
  table.writeUInt32BE(tags.length)
  let off = 128 + table.length
  const bodies: Buffer[] = []
  tags.forEach(([s, body], k) => {
    table.write(s, 4 + 12 * k, 'latin1'); table.writeUInt32BE(off, 8 + 12 * k); table.writeUInt32BE(body.length, 12 + 12 * k)
    bodies.push(body); off += body.length
  })
  const out = Buffer.concat([head, table, ...bodies])
  out.writeUInt32BE(out.length, 0)
  return out
}
const P3 = profile([[0.5151, 0.2412, -0.0011], [0.2920, 0.6922, 0.0419], [0.1571, 0.0666, 0.7841]])
const SRGB = profile([[0.4360747, 0.2225045, 0.0139322], [0.3850649, 0.7168786, 0.0971045], [0.1430804, 0.0606169, 0.7141733]])
const SYSTEM_P3 = '/System/Library/ColorSync/Profiles/Display P3.icc'

const near = (got: number[], want: number[]) => got.forEach((v, i) => expect(Math.abs(v - want[i]), `${got} vs ${want}`).toBeLessThanOrEqual(2))

describe('live pictures in sRGB (spec 31 H.4)', () => {
  it('#0088ff seen on a P3 display reads back (0,136,255) +-2, tagged sRGB, the profile gone', () => {
    const r = toSrgb(png([59, 134, 247], P3))
    expect(r.converted).toBe(true)
    const o = read(r.png)
    near(o.first, [0, 136, 255])
    expect(o.chunks).toContain('sRGB')
    expect(o.chunks).not.toContain('iCCP')
  })

  it.skipIf(!existsSync(SYSTEM_P3))('...and through the system\'s own Display P3 profile', () => {
    const r = toSrgb(png([59, 134, 247], readFileSync(SYSTEM_P3)))
    expect(r.converted).toBe(true)
    near(read(r.png).first, [0, 136, 255])
  })

  it('white and black stay white and black; a grey keeps its value', () => {
    near(read(toSrgb(png([255, 255, 255], P3)).png).first, [255, 255, 255])
    near(read(toSrgb(png([0, 0, 0], P3)).png).first, [0, 0, 0])
    near(read(toSrgb(png([128, 128, 128], P3)).png).first, [128, 128, 128])
  })

  it('an untagged PNG, an sRGB-profiled one and bytes that are no PNG stay exactly as they came', () => {
    for (const b of [png([59, 134, 247]), png([59, 134, 247], SRGB), Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])]) {
      const r = toSrgb(b)
      expect(r.converted).toBe(false)
      expect(r.png).toBe(b)
    }
  })

  it('main\'s capture answers with the converted bytes', async () => {
    const tagged = png([59, 134, 247], P3, 4, 4)
    const img: PictureImage = { isEmpty: () => false, getSize: () => ({ width: 4, height: 4 }), resize: () => img, toPNG: () => tagged }
    const look = { wc: { id: 9001, getZoomFactor: () => 1, capturePage: async () => img }, active: true, live: true, trusted: true, doc: 'D1', commits: 1, gen: 1, windowShown: true, viewShown: true }
    const a = await livePictures({ look: () => look })('t1', 'D1', { x: 0, y: 0, width: 4, height: 4 }, () => true)
    expect(a.ok).toBe(true)
    if (!a.ok) return
    near(read(a.png).first, [0, 136, 255])
  })
})
