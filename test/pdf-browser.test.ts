import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { findChrome } from '../src/server/shot.ts'
import { Browser } from '../src/server/cdp.ts'
import { COMPARE, PDF_EARLY, PDF_INSTALL } from '../src/server/pdf-page.ts'
import { CLI, fixtureRoot, startDev, type Dev } from './dev-server.ts'

/**
 * Spec 31 Part A against a real `marver dev` and real Chrome, the PDF read back with pdfjs-dist: a fixture deck with a
 * vector slide (Unicode text, inline SVG, an https link, a 2400 px image), a glass slide, a filter slide with a link
 * inside, the five motion cases, an `@media print { display: none }` slide, an overflowing slide, a large soft shadow and
 * a mask; a present board at 1280x800 with an html frame; the handout with long notes, a table, code, an image and a
 * slide with none. Page count and sizes, text, link annotations, bookmarks and their pages, image resolution, the
 * report's patched/clipped slides, 409, cancel, the CLI.
 */

const hasChrome = !!findChrome()
const PORT = 5626

/** A 2400x1200 RGB PNG: a left-to-right ramp (so a down-scaled copy is not the same image). */
function bigPng(w = 2400, h = 1200): Buffer {
  const row = Buffer.alloc(1 + w * 3)
  for (let x = 0; x < w; x++) { row[1 + x * 3] = Math.round((x / w) * 255); row[2 + x * 3] = 90; row[3 + x * 3] = 200 }
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
function crc32(b: Buffer): number {
  let c = ~0
  for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
  return ~c >>> 0
}

const slide = (title: string, body: string, extra = '') => `${extra}
export const meta = { title: ${JSON.stringify(title)}, slide: true }
export default function F() {
  return (<main style={{ width: 1280, height: 720, margin: 0, position: 'relative', overflow: 'hidden', background: '#f4f1ea', fontFamily: 'Helvetica, Arial, sans-serif' }}>${body}</main>)
}
`
const FILES: Record<string, string> = {
  'design/scenes/deck/01-vector.tsx': slide('Vector café ✓', `
    <h1 style={{ position: 'absolute', left: 64, top: 48, fontSize: 56, margin: 0 }}>Vector — café naïve ✓ 日本</h1>
    <svg width="200" height="200" style={{ position: 'absolute', left: 64, top: 180 }}><circle cx="100" cy="100" r="90" fill="#e8501f" /></svg>
    <a href="https://example.com/deck" style={{ position: 'absolute', left: 300, top: 200, fontSize: 28 }}>example.com link</a>
    <div style={{ position: 'absolute', left: 300, top: 300, width: 600 }}><Img src="big.png" /></div>`, `import { Img } from '@marver-design/marver/content'`),
  'design/scenes/deck/01-vector.note.md': Array.from({ length: 70 }, (_, i) => `Paragraph ${i + 1} of the long notes: what to say on this slide, and why it matters to the room.`).join('\n\n'),
  'design/scenes/deck/02-glass.tsx': slide('Glass', `
    <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(120deg, #ff5a1f, #3b82f6 50%, #22c55e)' }} />
    <div style={{ position: 'absolute', left: 80, top: 120, width: 360, height: 260, background: '#ffd400', borderRadius: 40 }} />
    <div style={{ position: 'absolute', left: 240, top: 200, width: 620, height: 320, borderRadius: 28, background: 'rgba(255,255,255,0.35)', backdropFilter: 'blur(24px) saturate(1.6)', border: '1px solid rgba(255,255,255,0.5)', padding: 32, boxSizing: 'border-box', fontSize: 34 }}>Frosted glass panel</div>`),
  'design/scenes/deck/02-glass.note.md': 'Back to [the vector slide](goto:deck/01-vector), or [the site](https://example.com/notes).\n\n| Metric | Value |\n|---|---|\n| Pages | 8 |\n| Glass | yes |\n\n```\nconst deck = await marver.pdf()\n```\n\n![the ramp](big.png)\n',
  'design/scenes/deck/03-filter.tsx': slide('Filter', `
    <div style={{ position: 'absolute', left: 120, top: 120, width: 700, height: 420, filter: 'saturate(1.8) contrast(1.2) drop-shadow(0 8px 16px rgba(0,0,0,.3))', background: '#9db4c0', borderRadius: 24, padding: 40, boxSizing: 'border-box' }}>
      <div style={{ width: 200, height: 200, background: '#c84', borderRadius: 100 }} />
      <a href="https://example.org/inside" style={{ display: 'block', marginTop: 20, fontSize: 30, color: '#123' }}>a link inside the filter</a>
      <svg width="240" height="40"><a href="https://example.net/svg"><text x="0" y="28" fontSize="24">an svg link</text></a></svg>
    </div>`),
  'design/scenes/deck/04-motion.tsx': `import { useEffect, useRef } from 'react'
export const meta = { title: 'Motion', slide: true }
const css = \`
@keyframes mv-in { from { opacity: 0; transform: translateY(60px) } to { opacity: 1; transform: none } }
@keyframes mv-grow { from { width: 10px } to { width: 300px } }
@keyframes mv-spin { from { transform: rotate(45deg) } to { transform: rotate(405deg) } }
#entrance { animation: mv-in 1s ease 4s both }
#nofill { animation: mv-grow 20s linear }
#spinner { animation: mv-spin 1.5s linear infinite }
@keyframes mv-short { from { width: 10px } to { width: 200px } }
#short { animation: mv-short 150ms linear }
\`
export default function F() {
  const w = useRef<HTMLDivElement>(null)
  useEffect(() => { w.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 30000 }) }, [])
  return (<main style={{ width: 1280, height: 720, margin: 0, position: 'relative', background: '#fff' }}>
    <style>{css}</style>
    <div id="entrance" style={{ position: 'absolute', left: 60, top: 60, fontSize: 40 }}>Delayed entrance</div>
    <div id="nofill" style={{ position: 'absolute', left: 60, top: 160, height: 40, background: '#e8501f' }} />
    <div id="spinner" style={{ position: 'absolute', left: 60, top: 260, width: 80, height: 80, background: '#222' }} />
    <div id="short" style={{ position: 'absolute', left: 60, top: 360, height: 20, width: 10, background: '#0a7' }} />
    <div id="waapi" ref={w} style={{ position: 'absolute', left: 60, top: 400, fontSize: 40 }}>WAAPI fade</div>
    <video id="clip" src="/design/assets/clip.webm" autoPlay muted loop playsInline style={{ position: 'absolute', left: 600, top: 60, width: 480, height: 270 }} />
  </main>)
}
`,
  'design/scenes/deck/05-print-hidden.tsx': slide('Print rules ignored', `
    <style>{'@media print { .gone { display: none !important } }'}</style>
    <h1 className="gone" style={{ position: 'absolute', left: 64, top: 64, fontSize: 60 }}>Shown on screen</h1>`),
  'design/scenes/deck/06-overflow.tsx': slide('Overflow', `
    <div style={{ position: 'absolute', left: 0, top: 0, width: 1280, height: 2400, background: 'linear-gradient(#fff, #ccc)' }}><h1 style={{ margin: 64 }}>Taller than its stage</h1></div>`).replace("overflow: 'hidden', ", ''),
  'design/scenes/deck/07-shadow.tsx': slide('Soft shadow', `
    <div style={{ position: 'absolute', left: 240, top: 120, width: 760, height: 460, background: '#fff', borderRadius: 24, boxShadow: '0 40px 90px -30px oklch(0.3 0.05 40 / 0.45), 0 0 0 1px rgba(0,0,0,.06)' }}><h2 style={{ margin: 48 }}>A card with a big soft shadow</h2></div>`),
  'design/scenes/deck/08-mask.tsx': slide('Mask', `
    <div style={{ position: 'absolute', left: 200, top: 120, width: 600, height: 400, background: 'linear-gradient(90deg, #0a7, #07a)', WebkitMaskImage: 'radial-gradient(circle at 50% 50%, black 40%, transparent 70%)', maskImage: 'radial-gradient(circle at 50% 50%, black 40%, transparent 70%)' }} />`),
  'design/scenes/deck/09-drop.tsx': slide('Drop shadow', `
    <div style={{ position: 'absolute', left: 240, top: 120, width: 760, height: 420, background: '#fff', borderRadius: 24, filter: 'drop-shadow(0 30px 50px rgba(0,0,0,.4))' }}><h2 style={{ margin: 48 }}>A drop-shadow prints as it is</h2></div>`),
  // the present board: a page at the laptop viewport and an html frame
  'design/scenes/pitch/a-intro.tsx': `import { Img } from '@marver-design/marver/content'
export const meta = { title: 'Intro page', viewport: 'laptop' }
export default () => <main style={{ minHeight: '100vh', margin: 0, background: '#102030', color: '#fff', fontFamily: 'Helvetica' }}><h1 style={{ margin: 0, padding: 48 }}>Present page at laptop</h1><div style={{ width: 400 }}><Img src="big.png" /></div></main>
`,
  'design/scenes/pitch/b-doc.html': '<!doctype html><html><head><meta charset="utf-8"><title>Doc</title></head><body style="margin:0;background:#fffbe6;font-family:Helvetica"><h1 style="padding:48px;margin:0">An html frame printed from its own document</h1></body></html>',
  'design/boards/deck.json': JSON.stringify({ version: 1, name: 'deck', nodes: ['01-vector', '02-glass', '03-filter', '04-motion', '05-print-hidden', '06-overflow', '07-shadow', '08-mask', '09-drop'].map((n, i) => ({ key: `n${i}`, frame: `deck/${n}`, x: i * 1400, y: 0, w: 1280, h: 720 })) }),
  'design/boards/pitch.json': JSON.stringify({ version: 1, name: 'pitch', nodes: [{ key: 'p2', frame: 'pitch/b-doc', x: 0, y: 900, w: 1280, h: 800 }, { key: 'p1', frame: 'pitch/a-intro', x: 0, y: 0, w: 1280, h: 800 }] }),
  'design/boards/notes.json': JSON.stringify({ version: 1, name: 'notes', nodes: ['01-vector', '02-glass', '03-filter'].map((n, i) => ({ key: `m${i}`, frame: `deck/${n}`, x: i * 1400, y: 0, w: 1280, h: 720 })) }),
  'design/scenes/broken/01-ok.tsx': slide('Fine', `<h1>Fine</h1>`),
  'design/scenes/broken/02-throws.tsx': `export const meta = { title: 'Throws', slide: true }\nexport default function F(): never { throw new Error('this slide is broken') }\n`,
  'design/boards/broken.json': JSON.stringify({ version: 1, name: 'broken', nodes: [{ key: 'b1', frame: 'broken/01-ok', x: 0, y: 0 }, { key: 'b2', frame: 'broken/02-throws', x: 1400, y: 0 }] }),
  'design/scenes/tall/01-centered.tsx': `export const meta = { title: 'Centred in a tall body', slide: true }
export default function F() {
  return (<><style>{'body { height: 1200px; margin: 0; display: flex; align-items: center; justify-content: center; font-family: Helvetica }'}</style><h1 style={{ margin: 0, fontSize: 48 }}>Centred in 1200</h1></>)
}
`,
  'design/boards/tall.json': JSON.stringify({ version: 1, name: 'tall', nodes: [{ key: 't1', frame: 'tall/01-centered', x: 0, y: 0 }] }),
  'design/publish.json': JSON.stringify({ boards: { deck: { max: 'read', type: 'slides' }, notes: { max: 'read', type: 'slides' } } }),
}

let root = ''
let dev: Dev | null = null
let token = ''
const api = (path: string, init: RequestInit = {}) => fetch(`${dev!.origin}/__mv/api/${path}`, { ...init, headers: { 'x-mv-work': token, 'content-type': 'application/json', ...(init.headers as Record<string, string> ?? {}) } })

type Report = { pages: number; certified: string; slides: { frame: string; status: string; patches?: string[]; raster?: string; clipped?: true; spilled?: true; unsettled?: true; error?: string }[] }
async function runJob(body: Record<string, unknown>): Promise<{ pdf: Buffer; report: Report }> {
  const r = await api('pdf', { method: 'POST', body: JSON.stringify(body) })
  const s0 = await r.json() as { job: string; error?: string }
  if (r.status !== 202) throw new Error(`start: ${r.status} ${s0.error}`)
  for (let i = 0; i < 600; i++) {
    const st = await (await api(`pdf/${s0.job}`)).json() as { state: string; error?: string; report?: Report }
    if (st.state === 'done') return { pdf: Buffer.from(await (await api(`pdf/${s0.job}/file`)).arrayBuffer()), report: st.report! }
    if (st.state !== 'running') throw new Error(`${st.state}: ${st.error}`)
    await new Promise((res) => setTimeout(res, 300))
  }
  throw new Error('the job did not finish')
}
const open = (pdf: Buffer) => getDocument({ data: new Uint8Array(pdf), isEvalSupported: false, disableFontFace: true }).promise
/** a page's text, compatibility-normalised (a CJK glyph can map to its Kangxi radical) and without spaces (pdf.js reads a
 *  system font's runs as separate glyphs) */
const text = async (doc: Awaited<ReturnType<typeof open>>, n: number) => ((await (await doc.getPage(n)).getTextContent()).items as { str?: string }[]).map((i) => i.str ?? '').join('').normalize('NFKC').replace(/\s+/g, '')
const squash = (t: string) => t.normalize('NFKC').replace(/\s+/g, '')
/** the largest image a page draws, walking its XObjects (Chrome nests images in forms) */
async function largestImage(pdf: Buffer, page: number): Promise<number> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false })
  let best = 0
  const seen = new Set<string>()
  const walk = (res: PDFDict | undefined) => {
    const xo = res?.lookup(PDFName.of('XObject'))
    if (!(xo instanceof PDFDict)) return
    for (const [, ref] of xo.entries()) {
      const key = ref instanceof PDFRef ? ref.toString() : ''
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      const s = doc.context.lookup(ref)
      if (!(s instanceof PDFStream || s instanceof PDFRawStream)) continue
      const sub = s.dict.get(PDFName.of('Subtype'))?.toString()
      if (sub === '/Image') best = Math.max(best, Number(s.dict.get(PDFName.of('Width'))?.toString() ?? 0))
      else if (sub === '/Form') walk(s.dict.lookup(PDFName.of('Resources')) as PDFDict | undefined)
    }
  }
  walk(doc.getPage(page - 1).node.Resources())
  return best
}

beforeAll(async () => {
  if (!hasChrome) return
  root = fixtureRoot('mv-pdfbrowser-', FILES)
  const fs = await import('node:fs')
  fs.mkdirSync(join(root, 'design', 'assets'), { recursive: true })
  fs.writeFileSync(join(root, 'design', 'assets', 'big.png'), bigPng())
  fs.copyFileSync(join(import.meta.dirname, 'fixtures', 'clip.webm'), join(root, 'design', 'assets', 'clip.webm'))
  dev = await startDev(root, { args: ['--port', String(PORT)] })
  token = JSON.parse(readFileSync(join(root, 'design', '.local', 'dev.json'), 'utf8')).token
}, 120_000)
afterAll(async () => {
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!hasChrome)('deck PDFs in real Chrome (spec 31 Part A)', () => {
  let deck: { pdf: Buffer; report: Report }
  it('a slides board: one page per slide at its stage, vector Unicode text, links, bookmarks pointing at their pages', async () => {
    deck = await runJob({ board: 'deck' })
    const doc = await open(deck.pdf)
    expect(doc.numPages).toBe(9)
    for (let n = 1; n <= 9; n++) expect((await doc.getPage(n)).view.slice(2)).toEqual([960, 540])
    expect(await text(doc, 1)).toContain(squash('Vector — café naïve ✓ 日本'))
    const links = (await (await doc.getPage(1)).getAnnotations()).filter((a: { subtype: string }) => a.subtype === 'Link').map((a: { url?: string }) => a.url)
    expect(links).toContain('https://example.com/deck')
    const outline = await doc.getOutline()
    expect(outline.map((o) => o.title)).toEqual(['Vector café ✓', 'Glass', 'Filter', 'Motion', 'Print rules ignored', 'Overflow', 'Soft shadow', 'Mask', 'Drop shadow'])
    expect(await Promise.all(outline.map((o) => doc.getPageIndex((o.dest as unknown[])[0] as never)))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    await doc.destroy()
  }, 240_000)
  it('images at full resolution: the 2400 px original, never an LOD bucket (#5)', async () => {
    expect(await largestImage(deck.pdf, 1)).toBeGreaterThanOrEqual(2400)
  })
  it('effects are patched and certified, not rasterised: glass, a filter (its link kept), a large soft shadow, a mask', async () => {
    const by = Object.fromEntries(deck.report.slides.map((s) => [s.frame.split('/')[1], s]))
    expect(by['02-glass']).toMatchObject({ status: 'patched', patches: expect.arrayContaining(['backdrop-filter']) })
    expect(by['03-filter'].status).toBe('patched')
    expect(by['03-filter'].patches!.join(' ')).toMatch(/^filter: /)
    expect(by['07-shadow']).toMatchObject({ status: 'patched', patches: ['box-shadow'] })
    expect(by['08-mask']).toMatchObject({ status: 'patched', patches: ['mask-image'] })
    const doc = await open(deck.pdf)
    const inside = (await (await doc.getPage(3)).getAnnotations()).map((a: { url?: string }) => a.url)
    expect(inside).toContain('https://example.org/inside')
    expect(inside).toContain('https://example.net/svg')
    await doc.destroy()
    expect(deck.report.slides.filter((s) => s.status === 'raster' || s.status === 'failed')).toEqual([])
    // a drop-shadow-only filter is left to Chrome, which prints it right (print-certified like every page)
    expect(by['09-drop'].status).toBe('vector')
    expect(deck.report.certified).toBe(process.platform === 'darwin' ? 'print' : 'screen')
  })
  it('screen media: a slide whose print rules would hide its heading prints it (#3)', async () => {
    const doc = await open(deck.pdf)
    expect(await text(doc, 5)).toContain(squash('Shown on screen'))
    await doc.destroy()
  })
  it('an overflowing slide is one page, clipped as its stage clips it, and named clipped (#3)', () => {
    const s = deck.report.slides.find((x) => x.frame === 'deck/06-overflow')!
    expect(s.clipped).toBe(true)
    expect(s.spilled).toBeUndefined()
  })
  it('staging never lays a slide out again: a tall flex-centred body prints where the screen shows it, clipped (#3)', async () => {
    const r = await runJob({ board: 'tall' })
    const doc = await open(r.pdf)
    expect(doc.numPages).toBe(1)
    const page = await doc.getPage(1)
    const items = ((await page.getTextContent()).items as { str: string; transform: number[] }[]).filter((i) => i.str.trim())
    expect(items.length).toBeGreaterThan(0)
    // centred in a 1200 px body: about 600 px down a 720 px stage - the bottom fifth of the 540 pt page, not its middle
    expect(Math.max(...items.map((i) => i.transform[5]))).toBeLessThan(110)
    expect(r.report.slides[0]).toMatchObject({ status: 'vector', clipped: true })
    expect(r.report.slides[0].spilled).toBeUndefined()
    await doc.destroy()
  }, 120_000)
  it('a present board: its order, html frames printed from their own document, pages at the device Play picks (1280x800)', async () => {
    const r = await runJob({ board: 'pitch' })
    const doc = await open(r.pdf)
    expect(doc.numPages).toBe(2)
    expect((await doc.getPage(1)).view.slice(2)).toEqual([960, 600])
    expect(await text(doc, 1)).toContain(squash('An html frame printed from its own document'))
    expect(await text(doc, 2)).toContain(squash('Present page at laptop'))
    // a non-slide frame with export=1: the original image too
    expect(await largestImage(r.pdf, 2)).toBeGreaterThanOrEqual(2400)
    await doc.destroy()
  }, 240_000)
  it('the handout: picture, title, notes - long notes continue, a table, code, an image, "No notes"; page numbers; bookmarks from the titles (#9)', async () => {
    const r = await runJob({ board: 'notes', notes: true, paper: 'a4' })
    const doc = await open(r.pdf)
    expect(doc.numPages).toBeGreaterThan(3)
    const all = (await Promise.all(Array.from({ length: doc.numPages }, (_, i) => text(doc, i + 1)))).join('\n')
    expect(all).toContain(squash('Paragraph 70 of the long notes'))
    expect(all).toContain('Pages8')
    expect(all).toContain(squash('const deck = await marver.pdf()'))
    expect(all).toContain('Nonotes')
    expect(all).toContain(`1/${doc.numPages}`)
    expect((await doc.getPage(1)).view.slice(2).map(Math.round)).toEqual([842, 595])
    const outline = await doc.getOutline()
    expect(outline.map((o) => o.title)).toEqual(['Vector café ✓', 'Glass', 'Filter'])
    // its report counts the pages it printed; a goto link is text, an https link stays one
    expect(r.report.pages).toBe(doc.numPages)
    const urls = (await Promise.all(Array.from({ length: doc.numPages }, async (_, i) => (await (await doc.getPage(i + 1)).getAnnotations()).map((a: { url?: string }) => a.url ?? '')))).flat()
    expect(urls).toContain('https://example.com/notes')
    expect(urls.filter((u) => u.includes('/__mv/') || u.endsWith('#'))).toEqual([])
    expect(all).toContain(squash('Back to the vector slide'))
    // the notes' image, beside the slides' pictures
    expect(await largestImage(r.pdf, doc.numPages)).toBeGreaterThan(0)
    await doc.destroy()
  }, 240_000)
  it('a slide that fails fails the export, naming it; --keep-going prints the rest with that page blank and named (#10)', async () => {
    await expect(runJob({ board: 'broken' })).rejects.toThrow(/failed: broken\/02-throws: the frame rendered an error - this slide is broken/)
    const r = await runJob({ board: 'broken', keepGoing: true })
    const doc = await open(r.pdf)
    expect(doc.numPages).toBe(2)
    expect(await text(doc, 1)).toContain('Fine')
    expect(await text(doc, 2)).toBe('')
    expect(r.report.slides.map((x) => x.status)).toEqual(['vector', 'failed'])
    expect(r.report.slides[1].error).toMatch(/this slide is broken/)
    await doc.destroy()
  }, 120_000)
  it('one job per canvas (409 with its id), and a cancel ends it', async () => {
    const a = await api('pdf', { method: 'POST', body: JSON.stringify({ board: 'deck' }) })
    const ja = await a.json() as { job: string }
    const b = await api('pdf', { method: 'POST', body: JSON.stringify({ board: 'pitch' }) })
    expect(b.status).toBe(409)
    expect(await b.json()).toMatchObject({ job: ja.job })
    expect((await api(`pdf/${ja.job}`, { method: 'DELETE' })).status).toBe(200)
    for (let i = 0; i < 50 && (await api(`pdf/${ja.job}`)).status === 200; i++) await new Promise((r) => setTimeout(r, 100))
    expect((await api(`pdf/${ja.job}`)).status).toBe(404)
    // no token, no cookie: forbidden on every route
    expect((await fetch(`${dev!.origin}/__mv/api/pdf`, { method: 'POST', body: '{}' })).status).toBe(403)
    expect((await fetch(`${dev!.origin}/__mv/api/pdf/${ja.job}/file`)).status).toBe(403)
  }, 60_000)
  it('the CLI writes design/exports/<board>.pdf and prints its report', () => {
    const out = execFileSync(process.execPath, [CLI, 'pdf', 'pitch', '--root', root], { encoding: 'utf8', timeout: 180_000 })
    expect(out.split('\n')[0]).toMatch(/^design\/exports\/pitch\.pdf - 2 pages, .+, [\d.]+ s$|exports\/pitch\.pdf - 2 pages/)
    expect(existsSync(join(root, 'design', 'exports', 'pitch.pdf'))).toBe(true)
    expect(readFileSync(join(root, 'design', 'exports', 'pitch.pdf')).subarray(0, 5).toString()).toBe('%PDF-')
  }, 200_000)
})

describe.skipIf(!hasChrome)('the finished slide, frozen deterministically (#4)', () => {
  it('a delayed entrance at its end, an animation without fill at its end, an infinite spinner at its first pose, a WAAPI animation finished, a video paused at its start', async () => {
    const b = await Browser.launch()
    try {
      const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId: s } = await b.send('Target.attachToTarget', { targetId, flatten: true })
      const ev = async (e: string) => (await b.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, s)).result?.value
      await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, s)
      await b.send('Page.enable', {}, s)
      await b.send('Page.addScriptToEvaluateOnNewDocument', { source: PDF_EARLY }, s)
      await b.send('Page.navigate', { url: `${dev!.origin}/__mv/frame/?id=deck%2F04-motion&theme=light&export=1` }, s)
      for (let i = 0; i < 200 && !(await ev(`!!document.getElementById('clip') && document.getElementById('clip').readyState >= 2`)); i++) await new Promise((r) => setTimeout(r, 100))
      await new Promise((r) => setTimeout(r, 600))
      await ev(PDF_INSTALL)
      await ev('window.__mvPdf.freeze()')
      const got = await ev(`(() => { const cs = (id) => getComputedStyle(document.getElementById(id)); const v = document.getElementById('clip'); return {
        entrance: [cs('entrance').opacity, cs('entrance').transform], nofill: cs('nofill').width, short: cs('short').width, spinner: cs('spinner').transform, waapi: cs('waapi').opacity, video: [v.paused, v.currentTime] } })()`)
      expect(got).toEqual({
        entrance: ['1', 'matrix(1, 0, 0, 1, 0, 0)'],   // its end pose: transform none, held by its fill
        nofill: '300px',                               // kept by fill: both, though authored without one
        short: '200px',                                // ended long before the freeze, without a fill: held from its start
        spinner: 'matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)',   // its first pose: rotate(45deg)
        waapi: '1',
        video: [true, 0],
      })
    } finally { await b.close() }
  }, 60_000)
  it('the patch trigger (#7): outermost only, glass walked into, a pseudo-element through its host, nothing hidden, off-stage or clipped away; a rotation named; large soft shadows; masks; an svg as a whole', async () => {
    const page = `<!doctype html><html><head><style>
      #pseudo::after { content: ''; position: absolute; inset: 0; mix-blend-mode: multiply; background: red }
      .a { position: absolute }
    </style></head><body style="margin:0">
      <div id="glass" class="a" style="left:10px;top:10px;width:300px;height:200px;backdrop-filter:blur(8px)"><div id="inner" style="width:100px;height:50px;filter:blur(2px)">x</div></div>
      <div id="outer" class="a" style="left:400px;top:10px;width:200px;height:200px;filter:grayscale(1)"><div id="nested" style="filter:blur(1px);width:50px;height:50px"></div></div>
      <div id="pseudo" class="a" style="left:10px;top:300px;width:100px;height:100px"></div>
      <div id="hidden" class="a" style="left:10px;top:500px;width:100px;height:100px;filter:blur(2px);opacity:0"></div>
      <div id="offstage" class="a" style="left:2000px;top:10px;width:100px;height:100px;filter:blur(2px)"></div>
      <div class="a" style="left:700px;top:300px;width:100px;height:100px;overflow:hidden"><div id="clipped" style="position:relative;left:200px;width:50px;height:50px;filter:blur(1px)"></div></div>
      <canvas id="cv" class="a" width="50" height="50" style="left:300px;top:300px"></canvas>
      <div id="shadow" class="a" style="left:400px;top:400px;width:400px;height:200px;box-shadow:0 30px 60px oklch(0.2 0.02 40 / 0.4)"></div>
      <div id="small" class="a" style="left:900px;top:400px;width:20px;height:20px;box-shadow:0 1px 2px rgba(0,0,0,.4)"></div>
      <div class="a" style="left:900px;top:10px;transform:rotate(10deg)"><div id="rotated" style="width:80px;height:80px;backdrop-filter:blur(4px)"></div></div>
      <div class="a" style="left:1050px;top:10px;transform:scale(0.5)"><div id="scaled" style="width:80px;height:80px;backdrop-filter:blur(4px)"></div></div>
      <div id="masked" class="a" style="left:1100px;top:300px;width:100px;height:100px;background:#08f;mask-image:linear-gradient(black,transparent)"></div>
      <div id="droponly" class="a" style="left:700px;top:500px;width:100px;height:60px;background:#fff;filter:drop-shadow(0 10px 20px rgba(0,0,0,.4))"></div>
      <svg id="svgf" class="a" style="left:1100px;top:500px" width="100" height="100"><defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><g filter="url(#f)"><rect id="r" width="80" height="80" fill="#c00"/></g></svg>
    </body></html>`
    const b = await Browser.launch()
    try {
      const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId: s } = await b.send('Target.attachToTarget', { targetId, flatten: true })
      const ev = async (e: string) => (await b.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, s)).result?.value
      await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, s)
      await b.send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(page).toString('base64') }, s)
      for (let i = 0; i < 50 && !(await ev(`!!document.getElementById('svgf')`)); i++) await new Promise((r) => setTimeout(r, 50))
      await ev(PDF_INSTALL)
      const got = await ev(`window.__mvPdf.detect(1280, 720, true).map((h) => ({ id: (document.querySelector('[data-mv-pdf="' + h.i + '"]') || document.querySelector('[data-mv-pdf-sh="' + h.i + '"]')).id, kind: h.kind, why: h.why, ...(h.transformed ? { transformed: true } : {}) }))`)
      expect(got).toEqual([
        { id: 'glass', kind: 'glass', why: 'backdrop-filter' },
        { id: 'inner', kind: 'whole', why: 'filter: blur(2px)' },
        { id: 'outer', kind: 'whole', why: 'filter: grayscale(1)' },
        { id: 'pseudo', kind: 'whole', why: '::after mix-blend-mode: multiply' },
        { id: 'cv', kind: 'whole', why: 'canvas' },
        { id: 'rotated', kind: 'glass', why: 'backdrop-filter', transformed: true },
        { id: 'scaled', kind: 'glass', why: 'backdrop-filter' },
        { id: 'masked', kind: 'whole', why: 'mask-image' },
        { id: 'svgf', kind: 'whole', why: 'filter: url("#f")' },
        { id: 'shadow', kind: 'shadow', why: 'box-shadow' },
      ])
    } finally { await b.close() }
  }, 60_000)
  it('print certification sees a changed pattern, not only a changed average: stripes swapped fail, antialiasing passes (#7)', async () => {
    const b = await Browser.launch()
    try {
      const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId: s } = await b.send('Target.attachToTarget', { targetId, flatten: true })
      const ev = async (e: string) => (await b.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, s)).result?.value
      const got = await ev(`(async () => {
        // at 2x, as a printed page is rasterised
        const pic = (draw) => { const c = document.createElement('canvas'); c.width = 800; c.height = 400; const g = c.getContext('2d'); g.scale(2, 2); g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 200); draw(g); return c.toDataURL('image/png').slice(22) }
        const stripes = (o) => (g) => { g.fillStyle = '#000'; for (let x = o; x < 400; x += 8) g.fillRect(x, 0, 4, 200) }
        const text = (dx) => (g) => { g.fillStyle = '#111'; g.font = '28px Helvetica'; for (let y = 40; y < 200; y += 40) g.fillText('Quarterly numbers, the room', 10 + dx, y) }
        const cmp = ${COMPARE}
        const a = await cmp(pic(stripes(0)), pic(stripes(4)), 2, [], 24, true)
        // thin lines added to a white page: each white screen pixel has white beside it in the print, so only the match
        // from the print's side sees them
        const lines = (g) => { g.fillStyle = '#000'; for (let x = 0; x < 400; x += 4) g.fillRect(x, 0, 0.5, 200) }
        const l = await cmp(pic(() => {}), pic(lines), 2, [], 24, true)
        const t = await cmp(pic(text(0)), pic(text(0.5)), 2, [], 24, true)
        return { stripes: [a.coarse, a.fine], text: [t.coarse, t.fine], lines: l.fine }
      })()`)
      expect(got.stripes[0]).toBe(0)                 // the average cannot see it...
      expect(got.stripes[1]).toBeGreaterThan(0.4)    // ...the pixel check does
      expect(got.text).toEqual([0, 0])               // text a device pixel apart (another rasteriser's snapping) is the same picture
      expect(got.lines).toBeGreaterThan(0.05)        // lines added where the screen has none
    } finally { await b.close() }
  }, 60_000)
  it('export=1 turns Img\'s LOD canvas off on a frame that is not a slide: a plain <img> of the original (#5)', async () => {
    const b = await Browser.launch()
    try {
      const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId: s } = await b.send('Target.attachToTarget', { targetId, flatten: true })
      const ev = async (e: string) => (await b.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, s)).result?.value
      const look = async (q: string) => {
        await b.send('Page.navigate', { url: `${dev!.origin}/__mv/frame/?id=pitch%2Fa-intro&theme=light${q}` }, s)
        for (let i = 0; i < 100 && !(await ev(`!!document.querySelector('.mv-img')`)); i++) await new Promise((r) => setTimeout(r, 100))
        return ev(`[!!document.querySelector('.mv-img img.mv-img-el'), !!document.querySelector('.mv-img canvas.mv-img-el'), document.querySelector('.mv-img img')?.loading ?? '']`)
      }
      expect(await look('&export=1')).toEqual([true, false, 'eager'])
      expect(await look('')).toEqual([false, true, ''])
    } finally { await b.close() }
  }, 60_000)
})
