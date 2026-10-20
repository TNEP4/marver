/** A PNG built in tests, independently of the code under test: `px` gives each pixel's channels; `filter(y)` the row
 *  filter (0-4); the data split into `parts` IDAT chunks. */
import { deflateSync } from 'node:zlib'

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
export type Px = (x: number, y: number) => number[]
/** A PNG: `px` gives each pixel's channels; `filter(y)` the row filter (0-4); the data split into `parts` IDATs. */
export function png(w: number, h: number, px: Px, { channels = 4, filter = (_y: number) => 0, parts = 1, depth = 8, colour }: { channels?: number; filter?: (y: number) => number; parts?: number; depth?: number; colour?: number } = {}): Buffer {
  const stride = w * channels
  const rows: Buffer[] = []
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < w; x++) px(x, y).slice(0, channels).forEach((v, i) => { cur[x * channels + i] = v })
    const f = filter(y)
    const out = Buffer.alloc(stride + 1)
    out[0] = f
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0, b = y ? prev[i] : 0, c = i >= channels && y ? prev[i - channels] : 0
      let p: number
      if (f === 0) p = 0
      else if (f === 1) p = a
      else if (f === 2) p = b
      else if (f === 3) p = (a + b) >> 1
      else { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      out[i + 1] = (cur[i] - p) & 255
    }
    rows.push(out)
    prev = cur
  }
  const z = deflateSync(Buffer.concat(rows))
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = colour ?? (channels === 4 ? 6 : 2); ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const size = Math.ceil(z.length / parts)
  const idats = Array.from({ length: parts }, (_, i) => chunk('IDAT', z.subarray(i * size, (i + 1) * size)))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...idats, chunk('IEND', Buffer.alloc(0))])
}

