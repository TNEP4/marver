import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { apiMiddleware } from '../src/server/api.ts'
import { ROUTE } from '../src/cli/name.ts'
import { addPicture, addPictureBytes, checkPng, isPng, picturePath, storeCapture, sweepPictures } from '../src/server/jam/capture.ts'
import type { CaptureRecord } from '../src/server/jam/types.ts'
import { Browser } from './browser.ts'

/**
 * Live pictures on the server (spec 28 A4.6 #36, #37, r1 #10): `POST /api/jam/picture/live` - owner-gated, a raw PNG
 * body of 8 MB at most counted as it arrives, the capture and frame named, every refusal in its order - and `checkPng`,
 * which walks every chunk and inflates `IDAT` to exactly its raw size, against a real Chromium capture and against
 * PNGs cut, corrupted or of a kind Chromium's `toPNG()` never writes. And the sweep that removes a picture its sealed
 * capture's record does not list.
 */

// ---- PNGs made here, chunk by chunk ---------------------------------------------------------------------------

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const chunk = (type: string, data: Buffer = Buffer.alloc(0), badCrc = false) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE((crc32(body) + (badCrc ? 1 : 0)) >>> 0)
  return Buffer.concat([len, body, crc])
}
const ihdr = (w: number, h: number, o: { depth?: number; colour?: number; interlace?: number } = {}) => {
  const d = Buffer.alloc(13)
  d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = o.depth ?? 8; d[9] = o.colour ?? 6; d[12] = o.interlace ?? 0
  return chunk('IHDR', d)
}
/** rows of `w` pixels, each row its filter byte then its channels */
const raw = (w: number, h: number, ch = 4, filter = 0) => {
  const b = Buffer.alloc(h * (1 + w * ch), 0x5a)
  for (let y = 0; y < h; y++) b[y * (1 + w * ch)] = filter
  return b
}
/** A whole PNG: IHDR, the IDAT (or the chunks given), IEND. */
const png = (o: { w?: number; h?: number; colour?: number; depth?: number; interlace?: number; data?: Buffer; middle?: Buffer[]; tail?: Buffer } = {}) => {
  const w = o.w ?? 6, h = o.h ?? 4, colour = o.colour ?? 6
  const data = o.data ?? deflateSync(raw(w, h, colour === 2 ? 3 : 4))
  return Buffer.concat([SIG, ihdr(w, h, { colour, depth: o.depth, interlace: o.interlace }), ...(o.middle ?? [chunk('IDAT', data)]), chunk('IEND'), o.tail ?? Buffer.alloc(0)])
}

describe('checkPng: the whole PNG, not its header (A4.6 #37, r1 #10)', () => {
  it('8-bit RGBA and RGB pass with their size, split IDAT and ancillary chunks too', async () => {
    expect(await checkPng(png())).toEqual({ width: 6, height: 4 })
    expect(await checkPng(png({ colour: 2 }))).toEqual({ width: 6, height: 4 })
    const z = deflateSync(raw(6, 4))
    expect(await checkPng(png({ middle: [chunk('sRGB', Buffer.from([0])), chunk('IDAT', z.subarray(0, 5)), chunk('IDAT', z.subarray(5)), chunk('tEXt', Buffer.from('k\0v'))] }))).toEqual({ width: 6, height: 4 })
    // every row's filter 0-4 is something a decoder can undo
    expect(await checkPng(png({ data: deflateSync(raw(6, 4, 4, 4)) }))).toEqual({ width: 6, height: 4 })
  })

  it('cut, corrupted or unsupported: each refused, with why', async () => {
    const whole = png()
    const afterIhdr = whole.subarray(0, 8 + 25)
    const insideIdat = whole.subarray(0, whole.length - 20)
    const cases: [string, Buffer][] = [
      ['not a PNG', Buffer.from('GIF89a........')],
      ['cut after IHDR', afterIhdr],
      ['cut inside IDAT', insideIdat],
      ['a bad CRC', png({ middle: [chunk('IDAT', deflateSync(raw(6, 4)), true)] })],
      ['IDAT inflating short', png({ data: deflateSync(raw(6, 3)) })],
      ['IDAT inflating long', png({ data: deflateSync(raw(6, 5)) })],
      ['IDAT not zlib', png({ data: Buffer.from('not deflate at all') })],
      ['a filter byte past 4', png({ data: deflateSync(raw(6, 4, 4, 5)) })],
      ['data after IEND', png({ tail: Buffer.from('trailing') })],
      ['a chunk after IEND', png({ tail: chunk('tEXt', Buffer.from('k\0v')) })],
      ['an unknown critical chunk', png({ middle: [chunk('IDAT', deflateSync(raw(6, 4))), chunk('XYZW', Buffer.from('x'))] })],
      ['a palette', png({ middle: [chunk('PLTE', Buffer.alloc(3)), chunk('IDAT', deflateSync(raw(6, 4)))] })],
      ['IDAT apart', (() => { const z = deflateSync(raw(6, 4)); return png({ middle: [chunk('IDAT', z.subarray(0, 4)), chunk('tEXt', Buffer.from('k\0v')), chunk('IDAT', z.subarray(4))] }) })()],
      ['no IDAT', png({ middle: [] })],
      ['interlaced', png({ interlace: 1 })],
      ['16-bit', png({ depth: 16 })],
      ['palette colour type', png({ colour: 3 })],
      ['grey with alpha', png({ colour: 4 })],
      ['past 4096 a side', png({ w: 4097, h: 1, data: deflateSync(raw(4097, 1)) })],
      ['IHDR not first', Buffer.concat([SIG, chunk('tEXt', Buffer.from('k\0v')), ihdr(6, 4), chunk('IDAT', deflateSync(raw(6, 4))), chunk('IEND')])],
      ['IEND not empty', Buffer.concat([SIG, ihdr(6, 4), chunk('IDAT', deflateSync(raw(6, 4))), chunk('IEND', Buffer.from('x'))])],
      ['no IEND', Buffer.concat([SIG, ihdr(6, 4), chunk('IDAT', deflateSync(raw(6, 4)))])],
    ]
    for (const [name, b] of cases) expect(typeof await checkPng(b), name).toBe('string')
    expect(isPng(png())).toBe(true)
    expect(isPng(Buffer.from('GIF89a'))).toBe(false)
  })

  it('checks run one at a time and each answers its own bytes', async () => {
    const [a, b, c] = await Promise.all([checkPng(png({ w: 300, h: 200, data: deflateSync(raw(300, 200)) })), checkPng(png({ data: deflateSync(raw(6, 3)) })), checkPng(png({ w: 2, h: 2, colour: 2, data: deflateSync(raw(2, 2, 3)) }))])
    expect(a).toEqual({ width: 300, height: 200 })
    expect(typeof b).toBe('string')
    expect(c).toEqual({ width: 2, height: 2 })
  })

  describe('a real capture passes (Chromium, as `page.screenshot` takes it)', () => {
    let browser: Browser | null = null
    beforeAll(async () => { browser = await Browser.launch() }, 60_000)
    afterAll(() => browser?.close())
    it('an opaque page and a transparent one, at 1x and at 2x', async () => {
      if (!browser) return   // no Chrome here: skipped, as the shot suites skip
      for (const scale of [1, 2]) {
        const s = await browser.tab({ width: 320, height: 200 })
        await browser.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 200, deviceScaleFactor: scale, mobile: false }, s)
        await browser.go(s, 'data:text/html,<body style="margin:0;background:%23e33"><div style="width:120px;height:80px;background:%2327c">menu</div></body>')
        for (const transparent of [false, true]) {
          if (transparent) await browser.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, s)
          if (transparent) await browser.go(s, 'data:text/html,<body style="margin:0"><div style="width:120px;height:80px;background:%2327c">menu</div></body>')
          const shot = Buffer.from((await browser.send('Page.captureScreenshot', { format: 'png' }, s)).data, 'base64')
          expect(shot[25], 'the colour type Chromium writes').toSatisfy((t: number) => t === 6 || t === 2)
          expect(await checkPng(shot)).toEqual({ width: 320 * scale, height: 200 * scale })
          // and that capture, cut or corrupted, is refused
          expect(typeof await checkPng(shot.subarray(0, shot.length - 30))).toBe('string')
          const bad = Buffer.from(shot); bad[bad.length - 20] ^= 0xff
          expect(typeof await checkPng(bad)).toBe('string')
        }
        await browser.closeTab(s)
      }
    }, 60_000)
  })
})

// ---- the route, through the dev API (perf-page.test.ts's request shape, its body pushed as the test says) ----------

let root = ''
const CAP = 'cap-1730000000000-abcdef'
const record = (id = CAP, pictures: string[] = []): CaptureRecord => ({ format: 'marver.jam.capture', v: 1, id, context: { canvas: 'x', board: 'main' }, view: {}, timeline: [], pictures })
const manifest = () => ({ frames: [{ id: 'spec/alpha', file: 'design/scenes/spec/alpha.tsx', kind: 'tsx' as const, scene: 'spec' }], scenes: [] }) as any

interface Driven { push(b: Buffer): void; end(): void; result: Promise<{ status: number; json: any; close: boolean }> }
function drive(q: { capture?: string; frame?: string; type?: string; owner?: boolean; ms?: number } = {}): Driven {
  const mw = apiMiddleware(root, { manifest, livePictureMs: q.ms ?? 10_000 })
  const params = new URLSearchParams({ capture: q.capture ?? CAP, frame: q.frame ?? 'spec/alpha' })
  const cbs: Record<string, ((arg?: unknown) => void)[]> = {}
  const req: any = {
    method: 'POST', url: `${ROUTE}/api/jam/picture/live?${params}`,
    headers: { host: 'localhost:5200', 'content-type': q.type ?? 'image/png', ...(q.owner === false ? {} : { cookie: 'mv_c=tok', 'x-mv-c': 'tok', origin: 'http://localhost:5200' }) },
    on(ev: string, cb: (arg?: unknown) => void) { (cbs[ev] ??= []).push(cb); return this },
    read: 0,
  }
  const headers: Record<string, string> = {}
  const res: any = { statusCode: 0, body: '', setHeader(k: string, v: string) { headers[k.toLowerCase()] = v }, end(s?: string) { this.body = s ?? ''; this._done?.() } }
  const result = new Promise<{ status: number; json: any; close: boolean }>((resolve) => {
    res._done = () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(res.body) } catch { return null } })(), close: headers.connection === 'close' })
    void mw(req, res, () => resolve({ status: 404, json: null, close: false }))
  })
  return {
    push: (b) => { req.read += b.length; for (const f of cbs.data ?? []) f(b) },
    end: () => { for (const f of cbs.end ?? []) f() },
    result,
  }
}
/** One whole upload: the body in 64 KB pieces, then its end. */
async function upload(body: Buffer, q: Parameters<typeof drive>[0] = {}) {
  const d = drive(q)
  await new Promise((r) => setImmediate(r))
  for (let i = 0; i < body.length; i += 65_536) d.push(body.subarray(i, i + 65_536))
  d.end()
  return d.result
}
const index = () => { try { return JSON.parse(readFileSync(join(root, 'design', '.local', 'jam', 'pictures.json'), 'utf8')) } catch { return {} } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('POST /api/jam/picture/live (A4.6 #37)', () => {
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mv-live-pic-')); mkdirSync(join(root, 'design', '.local'), { recursive: true }) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('takes a whole PNG of an unsealed capture: { id }, stored 600 with source live, served by its id', async () => {
    const r = await upload(png())
    expect(r.status).toBe(200)
    expect(r.json.id).toMatch(/^p-[0-9a-f]{16}$/)
    const p = picturePath(root, r.json.id)!
    expect(p.entry).toMatchObject({ frame: 'spec/alpha', capture: CAP, source: 'live' })
    expect(readFileSync(p.path).equals(png())).toBe(true)
    if (process.platform !== 'win32') expect(statSync(p.path).mode & 0o777).toBe(0o600)
  })

  it('every refusal, in its order, stores nothing: 403, 415, 400, 404, 409, 413, 415, 400', async () => {
    const owner = drive({ owner: false })
    expect((await owner.result).status).toBe(403)
    expect((await upload(png(), { type: 'application/json' })).status).toBe(415)
    expect((await upload(png(), { capture: 'cap-../../x' })).status).toBe(400)
    expect((await upload(png(), { frame: 'spec/nowhere' })).status).toBe(404)
    // a refusal before the body is read answers at once, never waiting for a body that may not come
    const early = drive({ frame: 'spec/nowhere' })
    expect((await early.result).status).toBe(404)
    // past 8 MB, counted as it arrives: refused before the rest comes, and the socket closed after the answer
    const big = drive()
    await new Promise((r) => setImmediate(r))
    for (let i = 0; i < 129; i++) big.push(Buffer.alloc(65_536, 1))
    const b = await big.result
    expect([b.status, b.close]).toEqual([413, true])
    expect((await upload(Buffer.from('GIF89a-and-so-on'))).status).toBe(415)
    expect((await upload(png({ data: deflateSync(raw(6, 3)) }))).status).toBe(400)
    expect((await upload(png().subarray(0, 40))).status).toBe(400)
    expect((await upload(png({ interlace: 1 }))).status).toBe(400)
    expect(storeCapture(root, record())).toMatchObject({ existed: false })
    expect((await upload(png())).status).toBe(409)
    expect(index()).toEqual({})
  })

  it('a capture sealed while the bytes came in: 409, nothing stored', async () => {
    const body = png({ w: 200, h: 100, data: deflateSync(raw(200, 100)) })
    const d = drive()
    await new Promise((r) => setImmediate(r))
    d.push(body.subarray(0, 100))
    storeCapture(root, record())            // the page sealed it meanwhile
    d.push(body.subarray(100)); d.end()
    expect((await d.result).status).toBe(409)
    expect(index()).toEqual({})
  })

  it('past its deadline: 408 with the socket closed, and a body that lands after stores nothing', async () => {
    const d = drive({ ms: 150 })
    await new Promise((r) => setImmediate(r))
    d.push(png().subarray(0, 20))
    const r = await d.result
    expect([r.status, r.close]).toEqual([408, true])
    d.push(png().subarray(20)); d.end()
    await sleep(50)
    expect(index()).toEqual({})
  })
})

describe('sweepPictures: a picture no record keeps (A4.6 #36)', () => {
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mv-live-sweep-')); mkdirSync(join(root, 'design', '.local', 'shots'), { recursive: true }) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('after an hour an unlisted picture of a sealed capture goes - a live one and a render alike; a listed one stays, marked; a run\'s stay', () => {
    writeFileSync(join(root, 'design', '.local', 'shots', 'x.png'), 'png')
    const listed = addPictureBytes(root, png(), { frame: 'spec/alpha', capture: CAP, source: 'live' })
    const late = addPictureBytes(root, png(), { frame: 'spec/alpha', capture: CAP, source: 'live' })        // landed after its shot gave up
    const render = addPicture(root, 'design/.local/shots/x.png', { frame: 'spec/alpha', capture: CAP })       // a render that ended after the seal
    const run = addPicture(root, 'design/.local/shots/x.png', { frame: 'spec/alpha', batch: 'b-1' })           // a run's before or after
    const unsealed = addPictureBytes(root, png(), { frame: 'spec/alpha', capture: 'cap-1730000000001-abcdef', source: 'live' })
    storeCapture(root, record(CAP, [listed]))
    // younger than an hour: nothing goes
    sweepPictures(root)
    expect(Object.keys(index()).sort()).toEqual([listed, late, render, run, unsealed].sort())
    sweepPictures(root, Date.now() + 3_600_001)
    const ix = index()
    // (a capture that never sealed loses its pictures as in 0.28)
    expect(Object.keys(ix).sort()).toEqual([listed, run].sort())
    expect(ix[listed].listed).toBe(true)
    for (const gone of [late, render]) expect(existsSync(join(root, 'design', '.local', 'jam', 'pictures', `${gone}.png`))).toBe(false)
    expect(existsSync(join(root, 'design', '.local', 'jam', 'pictures', `${listed}.png`))).toBe(true)
  })

  it('a sealed record that cannot be read keeps every picture of its capture', () => {
    const p = addPictureBytes(root, png(), { frame: 'spec/alpha', capture: CAP, source: 'live' })
    mkdirSync(join(root, 'design', '.local', 'jam', 'captures'), { recursive: true })
    writeFileSync(join(root, 'design', '.local', 'jam', 'captures', `${CAP}.json`), '{not json')
    sweepPictures(root, Date.now() + 3_600_001)
    expect(Object.keys(index())).toEqual([p])
  })
})
