/**
 * Live pictures in sRGB pixels (spec 31 H.4). `capturePage()` reads a view back in the display's colour space and its
 * PNG carries that display's ICC profile (an `iCCP` chunk): a colour-managed viewer shows it right, but an agent
 * reading the raw pixels sees the display's numbers - #0088ff read back as (59,134,247) on a P3 display (Nic's #53
 * check, 31 Oct). So the pixels are CONVERTED here, not merely re-labelled: each one through its profile's tone curves
 * and primaries to the profile connection space (XYZ, D50), then to sRGB's primaries and curve (relative colorimetric,
 * clipped), and the PNG written again tagged `sRGB`, its `iCCP` gone.
 *
 * Pure (node:zlib only, no Electron): a PNG in, a PNG out. What it cannot read it leaves exactly as it came - an
 * untagged or `sRGB` PNG, a 16-bit or palette or interlaced one, a profile that is not matrix/TRC (every display
 * profile macOS writes is) - and says so in `converted`. A profile that already is sRGB leaves the pixels as they are.
 */
import { deflateSync, inflateSync } from 'node:zlib'

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** sRGB's primaries in the PCS (D50, Bradford-adapted - the ICC sRGB profile's rXYZ/gXYZ/bXYZ), as columns. */
const SRGB_D50 = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
]

type M3 = number[][]
const inv3 = (m: M3): M3 => {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ]
}
const mul3 = (x: M3, y: M3): M3 => x.map((row) => [0, 1, 2].map((j) => row[0] * y[0][j] + row[1] * y[1][j] + row[2] * y[2][j]))
const SRGB_FROM_PCS = inv3(SRGB_D50)

/** A tone curve: an encoded value in [0,1] to linear light. */
type Curve = (v: number) => number

const s15 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset + o, 4).getInt32(0) / 65536
const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset + o, 4).getUint32(0)
const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset + o, 2).getUint16(0)
const sig = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])

function readCurve(p: Uint8Array, o: number, len: number): Curve | null {
  if (len < 12) return null
  const type = sig(p, o)
  if (type === 'curv') {
    const n = u32(p, o + 8)
    if (len < 12 + 2 * n) return null
    if (n === 0) return (v) => v
    if (n === 1) { const g = u16(p, o + 12) / 256; return (v) => Math.pow(v, g) }
    const t = Array.from({ length: n }, (_, k) => u16(p, o + 12 + 2 * k) / 65535)
    return (v) => {
      const x = Math.min(1, Math.max(0, v)) * (n - 1)
      const k = Math.min(n - 2, Math.floor(x))
      return t[k] + (t[k + 1] - t[k]) * (x - k)
    }
  }
  if (type === 'para') {
    const fn = u16(p, o + 8)
    const count = [1, 3, 4, 5, 7][fn]
    if (count === undefined || len < 12 + 4 * count) return null
    const [g, a = 1, b = 0, c = 0, d = 0, e = 0, f = 0] = Array.from({ length: count }, (_, k) => s15(p, o + 12 + 4 * k))
    const pw = (x: number) => (x > 0 ? Math.pow(x, g) : 0)
    switch (fn) {
      case 0: return (v) => pw(v)
      case 1: return (v) => (v >= -b / a ? pw(a * v + b) : 0)
      case 2: return (v) => (v >= -b / a ? pw(a * v + b) + c : c)
      case 3: return (v) => (v >= d ? pw(a * v + b) : c * v)
      case 4: return (v) => (v >= d ? pw(a * v + b) + e : c * v + f)
    }
  }
  return null
}

/** A matrix/TRC RGB profile: its three curves and its primaries (columns, in the PCS) - or null. */
export function readProfile(p: Uint8Array): { curves: [Curve, Curve, Curve]; primaries: M3 } | null {
  if (p.length < 132 || sig(p, 16) !== 'RGB ' || sig(p, 20) !== 'XYZ ') return null
  const n = u32(p, 128)
  if (n > 200 || p.length < 132 + 12 * n) return null
  const tags = new Map<string, { o: number; len: number }>()
  for (let k = 0; k < n; k++) {
    const at = 132 + 12 * k
    const o = u32(p, at + 4), len = u32(p, at + 8)
    if (o + len > p.length) return null
    tags.set(sig(p, at), { o, len })
  }
  const xyz = (t: string): number[] | null => {
    const e = tags.get(t)
    return e && e.len >= 20 && sig(p, e.o) === 'XYZ ' ? [s15(p, e.o + 8), s15(p, e.o + 12), s15(p, e.o + 16)] : null
  }
  const r = xyz('rXYZ'), g = xyz('gXYZ'), b = xyz('bXYZ')
  const curve = (t: string) => { const e = tags.get(t); return e ? readCurve(p, e.o, e.len) : null }
  const rc = curve('rTRC'), gc = curve('gTRC'), bc = curve('bTRC')
  if (!r || !g || !b || !rc || !gc || !bc) return null
  return { curves: [rc, gc, bc], primaries: [[r[0], g[0], b[0]], [r[1], g[1], b[1]], [r[2], g[2], b[2]]] }
}

const srgbEncode = (l: number) => (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055)
const srgbDecode = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))

// ---- PNG ----------------------------------------------------------------------------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff
  for (const b of parts) for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  const t = new TextEncoder().encode(type)
  out.set(t, 4); out.set(data, 8)
  dv.setUint32(8 + data.length, crc32([t, data]))
  return out
}

interface Png { width: number; height: number; depth: number; color: number; interlace: number; idat: Uint8Array[]; iccp?: Uint8Array }
function readPng(b: Uint8Array): Png | null {
  if (b.length < 8 || SIG.some((x, i) => b[i] !== x)) return null
  let o = 8
  const png: Partial<Png> & { idat: Uint8Array[] } = { idat: [] }
  while (o + 12 <= b.length) {
    const len = u32(b, o), type = sig(b, o + 4)
    if (o + 12 + len > b.length) return null
    const data = b.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') Object.assign(png, { width: u32(data, 0), height: u32(data, 4), depth: data[8], color: data[9], interlace: data[12] })
    else if (type === 'IDAT') png.idat.push(data)
    else if (type === 'iCCP') {
      const z = data.indexOf(0)
      if (z > 0 && z < 80 && data[z + 1] === 0) { try { png.iccp = new Uint8Array(inflateSync(data.subarray(z + 2))) } catch { /* unreadable: leave it */ } }
    } else if (type === 'IEND') break
    o += 12 + len
  }
  return png.width ? png as Png : null
}

/** Rows of `bpp`-byte pixels with their PNG filters undone, into one buffer (each row's filter chosen once, outside its
 *  loop - this runs over every byte of a 4096 px capture). */
function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array | null {
  const stride = width * bpp
  if (raw.length < (stride + 1) * height) return null
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride
    if (f === 0 || (f === 2 && !y)) { out.set(raw.subarray(src, src + stride), dst); continue }
    if (f === 1) {
      for (let x = 0; x < stride; x++) out[dst + x] = (raw[src + x] + (x >= bpp ? out[dst + x - bpp] : 0)) & 0xff
    } else if (f === 2) {
      for (let x = 0; x < stride; x++) out[dst + x] = (raw[src + x] + out[up + x]) & 0xff
    } else if (f === 3) {
      for (let x = 0; x < stride; x++) out[dst + x] = (raw[src + x] + (((x >= bpp ? out[dst + x - bpp] : 0) + (y ? out[up + x] : 0)) >> 1)) & 0xff
    } else if (f === 4) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[up + x] : 0, c = y && x >= bpp ? out[up + x - bpp] : 0
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - c - c)
        out[dst + x] = (raw[src + x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
    } else return null
  }
  return out
}

/** Every row filtered `Up` (the first `None`): cheap, and a UI's flat fields compress well with it. */
function filterUp(px: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp
  const out = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1), s = y * stride
    out[o] = y ? 2 : 0
    if (!y) out.set(px.subarray(0, stride), 1)
    else for (let x = 0; x < stride; x++) out[o + 1 + x] = (px[s + x] - px[s - stride + x]) & 0xff
  }
  return out
}

const near = (a: number, b: number, e: number) => Math.abs(a - b) <= e

/** The PNG with sRGB pixels, and whether anything was converted. */
export function toSrgb(png: Uint8Array): { png: Uint8Array; converted: boolean } {
  const same = { png, converted: false }
  const p = readPng(png)
  if (!p || !p.iccp || p.depth !== 8 || (p.color !== 6 && p.color !== 2) || p.interlace !== 0) return same
  const prof = readProfile(p.iccp)
  if (!prof) return same
  const M = mul3(SRGB_FROM_PCS, prof.primaries)
  const lin = prof.curves.map((c) => Float64Array.from({ length: 256 }, (_, v) => c(v / 255)))
  // already sRGB (the primaries and the curves within a hair): the pixels are right as they are
  const ident = M.every((row, i) => row.every((v, j) => near(v, i === j ? 1 : 0, 2e-3)))
  if (ident && lin.every((t) => t.every((v, k) => near(v, srgbDecode(k / 255), 2e-3)))) return same
  const bpp = p.color === 6 ? 4 : 3
  let raw: Uint8Array
  try { raw = new Uint8Array(inflateSync(Buffer.concat(p.idat))) } catch { return same }
  const px = unfilter(raw, p.width, p.height, bpp)
  if (!px) return same
  // linear light to an 8-bit sRGB value, finely enough that the steep start of the curve keeps +-1
  const STEPS = 1 << 14
  const enc = Uint8Array.from({ length: STEPS + 1 }, (_, k) => Math.round(srgbEncode(k / STEPS) * 255))
  const [lr, lg, lb] = lin
  const [m0, m1, m2] = M
  let pr = -1, pg = -1, pb = -1, or = 0, og = 0, ob = 0
  for (let i = 0; i < px.length; i += bpp) {
    const r = px[i], g = px[i + 1], b = px[i + 2]
    if (r !== pr || g !== pg || b !== pb) {
      pr = r; pg = g; pb = b
      const R = lr[r], G = lg[g], B = lb[b]
      const x = m0[0] * R + m0[1] * G + m0[2] * B, y = m1[0] * R + m1[1] * G + m1[2] * B, z = m2[0] * R + m2[1] * G + m2[2] * B
      or = enc[Math.round((x <= 0 ? 0 : x >= 1 ? 1 : x) * STEPS)]
      og = enc[Math.round((y <= 0 ? 0 : y >= 1 ? 1 : y) * STEPS)]
      ob = enc[Math.round((z <= 0 ? 0 : z >= 1 ? 1 : z) * STEPS)]
    }
    px[i] = or; px[i + 1] = og; px[i + 2] = ob
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, p.width); dv.setUint32(4, p.height)
  ihdr.set([8, p.color, 0, 0, 0], 8)
  const idat = deflateSync(filterUp(px, p.width, p.height, bpp), { level: 4 })
  const parts = [Uint8Array.from(SIG), chunk('IHDR', ihdr), chunk('sRGB', Uint8Array.of(0)), chunk('IDAT', new Uint8Array(idat)), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0))
  let o = 0
  for (const x of parts) { out.set(x, o); o += x.length }
  return { png: out, converted: true }
}
