import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apiMiddleware } from '../src/server/api.ts'
import { ROUTE } from '../src/cli/name.ts'
import { autoWidthOf, keptSizes, measuringFrames, mergeSizes, readSizes, readSizesFile, rendersDoc, serializeSizes, validEntry } from '../src/server/sizes.ts'
import { anchorNode, anchoredCamera } from '../src/client/shell/canvas/anchor.ts'
import { contentWidthOf, scanFrames } from '../src/server/manifest.ts'

/**
 * Calm loading: content-frame heights committed in design/boards/_sizes.json (sizes.ts) so a board
 * opens at its final geometry, and scroll anchoring (anchor.ts) so a reflow the human did not ask
 * for never moves what they are looking at. The real-browser proof is sizes-browser.test.ts.
 */

const VIEWPORTS = { mobile: { width: 390, height: 844 }, laptop: { width: 1280, height: 800 } }
const DOC = `import { Doc, Md } from '@marver-design/marver/content'\nexport default () => <Doc><Md>{'# Hi'}</Md></Doc>\n`
const WIDE = `import { Doc, Md } from '@marver-design/marver/content'\nexport default () => <Doc layout="wide"><Md>{'# Hi'}</Md></Doc>\n`
const BARE = `import { Md } from '@marver-design/marver/content'\n// no <Doc> here - it never measures\nexport default () => <Md>{'# Hi'}</Md>\n`
const FRAMES = [
  { id: 'docs/spec', file: 'design/scenes/docs/spec.tsx', kind: 'tsx', contentWidth: 760, src: DOC },
  { id: 'docs/wide', file: 'design/scenes/docs/wide.tsx', kind: 'tsx', contentWidth: 1280, src: WIDE },
  { id: 'docs/pinned', file: 'design/scenes/docs/pinned.tsx', kind: 'tsx', contentWidth: 760, viewport: 'laptop', src: DOC },
  { id: 'docs/bare', file: 'design/scenes/docs/bare.tsx', kind: 'tsx', contentWidth: 760, src: BARE },   // content, but no Doc
  { id: 'app/home', file: 'design/scenes/app/home.tsx', kind: 'tsx', viewport: 'mobile', src: 'export default () => <main />\n' },
]
const project = (root: string, frames = FRAMES) => {
  for (const f of frames) { mkdirSync(dirname(join(root, f.file)), { recursive: true }); writeFileSync(join(root, f.file), f.src) }
  mkdirSync(join(root, 'design', 'boards'), { recursive: true })
  writeFileSync(join(root, 'design', 'manifest.json'), JSON.stringify({ frames: frames.map(({ src: _src, ...f }) => f), scenes: [] }))
}

describe('the size cache (sizes.ts)', () => {
  it('takes a frame id at a width, and a height in the shell clamp - nothing else', () => {
    expect(validEntry('docs/spec@760', 1200)).toBe(true)
    expect(validEntry('a/b/c@1280', 80)).toBe(true)
    for (const [k, h] of [['docs/../x@760', 900], ['@760', 900], ['docs/spec@7', 900], ['docs/spec', 900], ['docs//spec@760', 900],
      ['docs/spec@760', 79], ['docs/spec@760', 40_001], ['docs/spec@760', 12.5], ['docs/spec@760', '900']] as const)
      expect(validEntry(k, h), `${k} ${h}`).toBe(false)
  })

  it('only a Doc measures: a <Doc> in a comment or a string is no Doc; an aliased import still is', () => {
    expect(rendersDoc(DOC)).toBe(true)
    expect(rendersDoc(WIDE)).toBe(true)
    expect(rendersDoc(BARE)).toBe(false)
    expect(rendersDoc(`const s = '<Doc>'\nexport default () => <Md>{s}</Md>\n`)).toBe(false)
    expect(rendersDoc(`import { Doc as Page, Md } from '@marver-design/marver/content'\nexport default () => <Page><Md>{'x'}</Md></Page>\n`)).toBe(true)
    expect(rendersDoc(`import * as C from '@marver-design/marver/content'\nexport default () => <C.Doc><C.Md>{'x'}</C.Md></C.Doc>\n`)).toBe(true)
  })

  it('the file keeps a live content frame at its own width; a load is handed only the frames that measure', () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-sizes-aw-'))
    try {
      project(root)
      const aw = autoWidthOf(FRAMES, VIEWPORTS)
      expect(['docs/spec', 'docs/wide', 'docs/pinned', 'docs/bare', 'app/home', 'gone/frame'].map(aw)).toEqual([760, 1280, 1280, 760, null, null])
      const { next, accepted } = mergeSizes(
        { 'docs/spec@760': 1000, 'gone/frame@760': 500, 'docs/wide@760': 700 },   // deleted; went wide
        { 'docs/wide@1280': 900, 'docs/pinned@1280': 2000, 'docs/pinned@760': 1500, 'app/home@390': 844, 'docs/spec@760': 'x' },
        aw)
      expect(next).toEqual({ 'docs/spec@760': 1000, 'docs/wide@1280': 900, 'docs/pinned@1280': 2000 })
      expect(accepted.sort()).toEqual(['docs/pinned@1280', 'docs/wide@1280'])
      // a frame that stopped rendering a Doc (bare) keeps its line in the file, and is handed nothing
      const measuring = measuringFrames(root, FRAMES)
      expect([...measuring].sort()).toEqual(['docs/pinned', 'docs/spec', 'docs/wide'])
      expect(keptSizes({ 'docs/bare@760': 2000, 'docs/spec@760': 1000 }, aw, measuring)).toEqual({ 'docs/spec@760': 1000 })
      // a source caught mid-write (empty) gets the benefit of the doubt
      writeFileSync(join(root, 'design/scenes/docs/spec.tsx'), '')
      expect(measuringFrames(root, FRAMES).has('docs/spec')).toBe(true)
      // a bare Md inside a _layout that renders the Doc measures - at any level of the chain
      writeFileSync(join(root, 'design/scenes/_layout.tsx'), `import { Doc } from '@marver-design/marver/content'\nexport default ({ children }) => <Doc>{children}</Doc>\n`)
      expect(measuringFrames(root, FRAMES).has('docs/bare')).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('a frame measuring inside a _layout\'s wide Doc is that wide in the manifest (manifest.ts)', () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-sizes-layout-'))
    try {
      mkdirSync(join(root, 'design', 'scenes', 'specs'), { recursive: true })
      writeFileSync(join(root, 'design', 'scenes', 'specs', '_layout.tsx'), `import { Doc } from '@marver-design/marver/content'\nexport default ({ children }) => <Doc layout="wide">{children}</Doc>\n`)
      writeFileSync(join(root, 'design', 'scenes', 'specs', 'one.tsx'), BARE)
      writeFileSync(join(root, 'design', 'scenes', 'specs', 'own.tsx'), DOC)                 // its own Doc wins
      const m = scanFrames(root)
      expect(m.frames.find((f) => f.id === 'specs/one')?.contentWidth).toBe(1280)
      expect(m.frames.find((f) => f.id === 'specs/own')?.contentWidth).toBe(760)
      expect([...measuringFrames(root, m.frames)].sort()).toEqual(['specs/one', 'specs/own'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('the width a Doc measures at follows an aliased import too (manifest.ts)', () => {
    expect(contentWidthOf(`import { Doc as Page } from '@marver-design/marver/content'\nexport default () => <Page layout="wide" />\n`)).toBe(1280)
    expect(contentWidthOf(`import * as C from '@marver-design/marver/content'\nexport default () => <C.Doc layout="wide" />\n`)).toBe(1280)
    expect(contentWidthOf(`import { Doc } from '@marver-design/marver/content'\nexport default () => <Doc layout="wide" />\n`)).toBe(1280)
    expect(contentWidthOf(`import { Doc } from '@marver-design/marver/content'\nexport default () => <Doc />\n`)).toBe(760)
  })

  it('writes one sorted entry per line, so a changed height is a one-line diff', () => {
    const text = serializeSizes({ 'z/last@760': 300, 'a/first@1280': 1200 })
    const lines = text.split('\n')
    expect(lines[1]).toMatch(/^ {2}"about": "Written by marver dev/)
    expect(lines.slice(3, 5)).toEqual(['    "a/first@1280": 1200,', '    "z/last@760": 300'])
    expect(text.endsWith('}\n')).toBe(true)
  })

  it('tells absent, ok and invalid (a merge conflict) apart; readers see an invalid file as no heights', () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-sizes-read-'))
    try {
      expect(readSizesFile(root)).toEqual({ state: 'absent', heights: {} })
      mkdirSync(join(root, 'design', 'boards'), { recursive: true })
      const file = join(root, 'design', 'boards', '_sizes.json')
      writeFileSync(file, '{\n<<<<<<< HEAD\n  "heights": {}\n')
      expect(readSizesFile(root).state).toBe('invalid')
      expect(readSizes(root)).toEqual({})
      writeFileSync(file, JSON.stringify({ heights: [1] }))
      expect(readSizesFile(root).state).toBe('invalid')
      writeFileSync(file, JSON.stringify({ heights: { 'docs/spec@760': 900, '../x@760': 900, 'docs/wide@1280': -4 } }))
      expect(readSizesFile(root)).toEqual({ state: 'ok', heights: { 'docs/spec@760': 900 } })
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

describe('the dev API: sizes', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mv-sizes-api-'))
    project(root)
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('owner-gated: a page from another origin cannot write the file', async () => {
    expect((await drive('POST', 'sizes', { heights: { 'docs/spec@760': 900 } }, false)).status).toBe(403)
    expect(existsSync(file())).toBe(false)
  })

  it('takes settled heights of live content frames at their own width, answers what it took, and hands out what measures', async () => {
    const MEASURING = ['docs/pinned', 'docs/spec', 'docs/wide']
    expect((await drive('GET', 'sizes')).json).toEqual({ heights: {}, measuring: MEASURING })
    const r = await drive('POST', 'sizes', { heights: { 'docs/spec@760': 1834, 'docs/wide@760': 900, 'app/home@390': 844, 'docs/bare@760': 400, 'nope@760': 900 } })
    expect(r).toEqual({ status: 200, json: { accepted: ['docs/spec@760', 'docs/bare@760'] } })
    expect(JSON.parse(readFileSync(file(), 'utf8')).heights).toEqual({ 'docs/bare@760': 400, 'docs/spec@760': 1834 })
    expect((await drive('GET', 'sizes')).json).toEqual({ heights: { 'docs/spec@760': 1834 }, measuring: MEASURING })
  })

  it('a frame that stopped rendering a Doc is handed no height - and its line survives, a source mid-write deletes nothing', async () => {
    await drive('POST', 'sizes', { heights: { 'docs/spec@760': 2000 } })
    writeFileSync(join(root, 'design/scenes/docs/spec.tsx'), BARE)   // the Doc became a bare Md: nothing measures it any more
    expect((await drive('GET', 'sizes')).json).toEqual({ heights: {}, measuring: ['docs/pinned', 'docs/wide'] })
    await drive('POST', 'sizes', { heights: { 'docs/wide@1280': 900 } })
    expect(JSON.parse(readFileSync(file(), 'utf8')).heights).toEqual({ 'docs/spec@760': 2000, 'docs/wide@1280': 900 })
  })

  it('a later write prunes what a board can no longer use: a deleted frame, a Doc that changed width', async () => {
    await drive('POST', 'sizes', { heights: { 'docs/spec@760': 1000, 'docs/wide@1280': 700 } })
    project(root, [{ ...FRAMES[0], contentWidth: 1280, src: WIDE }, { ...FRAMES[0], id: 'docs/new', file: 'design/scenes/docs/new.tsx' }])   // spec went wide; wide is gone
    expect((await drive('POST', 'sizes', { heights: { 'docs/new@760': 400 } })).json).toEqual({ accepted: ['docs/new@760'] })
    expect(JSON.parse(readFileSync(file(), 'utf8')).heights).toEqual({ 'docs/new@760': 400 })
  })

  it('never rewrites from a bad read: a conflicted file or an unreadable manifest refuses, and both stay as they were', async () => {
    await drive('POST', 'sizes', { heights: { 'docs/spec@760': 1000, 'docs/wide@1280': 700 } })
    const conflicted = readFileSync(file(), 'utf8').replace('  "heights": {', '<<<<<<< HEAD\n  "heights": {')
    writeFileSync(file(), conflicted)
    expect((await drive('POST', 'sizes', { heights: { 'docs/pinned@1280': 900 } })).status).toBe(409)
    expect(readFileSync(file(), 'utf8')).toBe(conflicted)
    writeFileSync(file(), serializeSizes({ 'docs/spec@760': 1000, 'docs/wide@1280': 700 }))
    writeFileSync(join(root, 'design', 'manifest.json'), '{"frames": [')                                // mid-rewrite
    expect((await drive('POST', 'sizes', { heights: { 'docs/pinned@1280': 900 } })).status).toBe(409)
    expect(JSON.parse(readFileSync(file(), 'utf8')).heights).toEqual({ 'docs/spec@760': 1000, 'docs/wide@1280': 700 })
  })

  it('an unchanged height is no write, nothing is created for nothing, and the batch is bounded', async () => {
    expect((await drive('POST', 'sizes', { heights: { 'app/home@390': 844 } })).json).toEqual({ accepted: [] })
    expect(existsSync(file())).toBe(false)
    await drive('POST', 'sizes', { heights: { 'docs/spec@760': 1000 } })
    const before = readFileSync(file(), 'utf8')
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
