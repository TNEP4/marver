import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiMiddleware } from '../src/server/api.ts'
import { ROUTE } from '../src/cli/name.ts'
import { autoWidthOf, mergeSizes, readSizes, serializeSizes, validEntry } from '../src/server/sizes.ts'
import { anchorNode, anchoredCamera } from '../src/client/shell/canvas/anchor.ts'

/**
 * Calm loading: content-frame heights committed in design/boards/_sizes.json (sizes.ts) so a board
 * opens at its final geometry, and scroll anchoring (anchor.ts) so a reflow the human did not ask
 * for never moves what they are looking at. The real-browser proof is sizes-browser.test.ts.
 */

const VIEWPORTS = { mobile: { width: 390, height: 844 }, laptop: { width: 1280, height: 800 } }
const FRAMES = [
  { id: 'docs/spec', contentWidth: 760 },
  { id: 'docs/wide', contentWidth: 1280 },
  { id: 'docs/pinned', contentWidth: 760, viewport: 'laptop' },
  { id: 'app/home', viewport: 'mobile' },                       // a UI frame: never measured, never kept
]

describe('the size cache (sizes.ts)', () => {
  it('takes a frame id at a width, and a height in the shell clamp - nothing else', () => {
    expect(validEntry('docs/spec@760', 1200)).toBe(true)
    expect(validEntry('a/b/c@1280', 80)).toBe(true)
    for (const [k, h] of [['docs/../x@760', 900], ['@760', 900], ['docs/spec@7', 900], ['docs/spec', 900], ['docs//spec@760', 900],
      ['docs/spec@760', 79], ['docs/spec@760', 40_001], ['docs/spec@760', 12.5], ['docs/spec@760', '900']] as const)
      expect(validEntry(k, h), `${k} ${h}`).toBe(false)
  })

  it('keeps only a live content frame at the width it measures at on its own - the viewport wins over the Doc', () => {
    const aw = autoWidthOf(FRAMES, VIEWPORTS)
    expect([aw('docs/spec'), aw('docs/wide'), aw('docs/pinned'), aw('app/home'), aw('gone/frame')]).toEqual([760, 1280, 1280, null, null])
    const { next, accepted } = mergeSizes(
      { 'docs/spec@760': 1000, 'gone/frame@760': 500, 'docs/wide@760': 700 },   // a deleted frame; a Doc that went wide
      { 'docs/wide@1280': 900, 'docs/pinned@1280': 2000, 'docs/pinned@760': 1500, 'app/home@390': 844, 'docs/spec@760': 'x' },
      aw)
    expect(next).toEqual({ 'docs/spec@760': 1000, 'docs/wide@1280': 900, 'docs/pinned@1280': 2000 })
    expect(accepted.sort()).toEqual(['docs/pinned@1280', 'docs/wide@1280'])
  })

  it('writes one sorted entry per line, so a changed height is a one-line diff', () => {
    const text = serializeSizes({ 'z/last@760': 300, 'a/first@1280': 1200 })
    const lines = text.split('\n')
    expect(lines[1]).toMatch(/^ {2}"about": "Written by marver dev/)
    expect(lines.slice(3, 5)).toEqual(['    "a/first@1280": 1200,', '    "z/last@760": 300'])
    expect(text.endsWith('}\n')).toBe(true)
  })

  it('reads leniently: absent, malformed (a merge conflict) or off-grammar entries are nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-sizes-read-'))
    try {
      expect(readSizes(root)).toEqual({})
      mkdirSync(join(root, 'design', 'boards'), { recursive: true })
      const file = join(root, 'design', 'boards', '_sizes.json')
      writeFileSync(file, '{\n<<<<<<< HEAD\n  "heights": {}\n')
      expect(readSizes(root)).toEqual({})
      writeFileSync(file, JSON.stringify({ heights: { 'docs/spec@760': 900, '../x@760': 900, 'docs/wide@1280': -4 } }))
      expect(readSizes(root)).toEqual({ 'docs/spec@760': 900 })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ---------------------------------------------------------------------------------------------
// the dev API: GET/POST sizes
let root = ''
function drive(method: string, path: string, body?: unknown, owner = true) {
  const mw = apiMiddleware(root, { viewports: VIEWPORTS })
  const req: any = {
    method, url: `${ROUTE}/api/${path}`,
    headers: { host: 'localhost:5200', ...(owner ? { cookie: 'mv_c=tok', 'x-mv-c': 'tok', origin: 'http://localhost:5200' } : {}) },
    _cbs: {} as Record<string, (arg?: unknown) => void>,
    on(ev: string, cb: (arg?: unknown) => void) { this._cbs[ev] = cb; return this },
    destroy() {},
  }
  const res: any = { statusCode: 0, body: '', setHeader() {}, end(s?: string) { this.body = s ?? ''; this._done?.() } }
  const done = new Promise<{ status: number; json: any }>((resolve) => {
    res._done = () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(res.body) } catch { return null } })() })
    void mw(req, res, () => resolve({ status: 404, json: null }))
  })
  if (method === 'POST') {
    const raw = Buffer.from(JSON.stringify(body ?? {}))
    queueMicrotask(() => { req._cbs.data?.(raw); req._cbs.end?.() })
  }
  return done
}
const file = () => join(root, 'design', 'boards', '_sizes.json')
const manifest = (frames: unknown[]) => writeFileSync(join(root, 'design', 'manifest.json'), JSON.stringify({ frames, scenes: [] }))

describe('the dev API: sizes', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mv-sizes-api-'))
    mkdirSync(join(root, 'design', 'boards'), { recursive: true })
    manifest(FRAMES)
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('owner-gated: a page from another origin cannot write the file', async () => {
    expect((await drive('POST', 'sizes', { heights: { 'docs/spec@760': 900 } }, false)).status).toBe(403)
    expect(existsSync(file())).toBe(false)
  })

  it('takes settled heights of live content frames at their own width, answers what it took, and reads them back', async () => {
    expect((await drive('GET', 'sizes')).json).toEqual({ heights: {} })
    const r = await drive('POST', 'sizes', { heights: { 'docs/spec@760': 1834, 'docs/wide@760': 900, 'app/home@390': 844, 'nope@760': 900 } })
    expect(r).toEqual({ status: 200, json: { accepted: ['docs/spec@760'] } })
    expect(JSON.parse(readFileSync(file(), 'utf8')).heights).toEqual({ 'docs/spec@760': 1834 })
    expect((await drive('GET', 'sizes')).json).toEqual({ heights: { 'docs/spec@760': 1834 } })
  })

  it('a later write prunes what a board can no longer use: a deleted frame, a Doc that changed width', async () => {
    await drive('POST', 'sizes', { heights: { 'docs/spec@760': 1000, 'docs/wide@1280': 700 } })
    manifest([{ id: 'docs/spec', contentWidth: 1280 }, { id: 'docs/new', contentWidth: 760 }])   // spec went wide; wide is gone
    expect((await drive('POST', 'sizes', { heights: { 'docs/new@760': 400 } })).json).toEqual({ accepted: ['docs/new@760'] })
    expect(JSON.parse(readFileSync(file(), 'utf8')).heights).toEqual({ 'docs/new@760': 400 })
  })

  it('an unchanged height is no write, nothing is created for nothing, and the batch is bounded', async () => {
    expect((await drive('POST', 'sizes', { heights: { 'app/home@390': 844 } })).json).toEqual({ accepted: [] })
    expect(existsSync(file())).toBe(false)
    await drive('POST', 'sizes', { heights: { 'docs/spec@760': 1000 } })
    const before = readFileSync(file(), 'utf8')
    writeFileSync(file(), before)   // the same bytes - the mtime is ours, the content the server's
    await drive('POST', 'sizes', { heights: { 'docs/spec@760': 1000 } })
    expect(readFileSync(file(), 'utf8')).toBe(before)
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`docs/f${i}@760`, 900]))
    expect((await drive('POST', 'sizes', { heights: many })).status).toBe(400)
    expect((await drive('POST', 'sizes', { heights: [1, 2] })).status).toBe(400)
  })

  it('refuses to write through a symlinked file', async () => {
    const outside = join(root, 'outside.json')
    writeFileSync(outside, '{}')
    symlinkSync(outside, file())
    expect((await drive('POST', 'sizes', { heights: { 'docs/spec@760': 900 } })).status).toBe(400)
    expect(readFileSync(outside, 'utf8')).toBe('{}')
  })
})

// ---------------------------------------------------------------------------------------------
describe('scroll anchoring (anchor.ts)', () => {
  const nodes = [
    { key: 'a', x: 0, y: 0, w: 760, h: 1000 },
    { key: 'b', x: 900, y: 0, w: 760, h: 600 },
    { key: 'c', x: 0, y: 1200, w: 760, h: 800 },
  ]
  const cam = { positionX: 100, positionY: 50, scale: 0.5 }

  it('holds the selected node when it is on screen', () => {
    expect(anchorNode({ nodes, selection: ['b', 'c'] }, cam, 1440, 900)).toEqual({ key: 'c', x: 0, y: 1200 })
  })

  it('else the node at the middle of the view; an off-screen selection does not count', () => {
    // the view's middle is (720, 450): b's box (550..930 x 50..364) is 86px from it, a's 240px, c's 312px
    expect(anchorNode({ nodes, selection: [] }, cam, 1440, 900)).toEqual({ key: 'b', x: 900, y: 0 })
    const far = { positionX: 100, positionY: -2000, scale: 1 }   // c only: y -800..28 on screen
    expect(anchorNode({ nodes, selection: ['a'] }, far, 1440, 900)).toEqual({ key: 'c', x: 0, y: 1200 })
    expect(anchorNode({ nodes, selection: [] }, { positionX: 0, positionY: 99_999, scale: 1 }, 1440, 900)).toBeNull()
  })

  it('moves the camera by the node displacement times the zoom - it lands where it was on screen', () => {
    const held = { key: 'c', x: 0, y: 1200 }
    const [x, y] = anchoredCamera(held, { x: 0, y: 1900 }, 100, 50, 0.5)
    expect([x, y]).toEqual([100, -300])
    // screen y of c before: 1200*0.5+50 = 650; after: 1900*0.5-300 = 650
    expect(1900 * 0.5 + y).toBe(1200 * 0.5 + 50)
  })
})
