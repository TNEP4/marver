/**
 * Deck PDFs (spec 31 Part A) - a board printed by the system's own Chrome, one page per slide, exactly what the stage
 * shows, vector where Chrome can print it and certified where it cannot.
 *
 * One job per canvas, one Chrome per job (cdp.ts), four slides at a time. Each slide:
 *   1. renders in a tab of its own, its window sized to the capture (a screenshot of exactly the native view never comes
 *      back tiled - shot.ts #14), at the page size, screen media, without `data-sl-play` (entrances show their end);
 *   2. is ready when `marver shot` calls a frame ready (root children, fonts, images, charts and diagrams, two frames),
 *      10 s at most - past that it prints anyway and is named "unsettled";
 *   3. is frozen deterministically (finite animations finished with `fill: both`, infinite ones paused at time 0, SMIL
 *      paused, videos at their first frame), then staged: `@page` at the stage size, the stage clipped, breaks off;
 *   4. has its effects patched element by element - the glass a backdrop-filter draws becomes the element's own
 *      background, a filtered or blended box, a canvas or a video becomes a picture of itself - and the patched page is
 *      certified against the unpatched screenshot; a wrong patch makes the whole page a 3x raster;
 *   5. is printed to a one-page PDF, which must be one page ("spilled" otherwise, page 1 kept), and, where macOS `sips`
 *      can rasterise it, certified again against the screenshot - a print-only failure makes it a raster too.
 * Then the pages are merged in plan order with pdf-lib, a bookmark per page, the metadata set, written whole.
 *
 * `--notes` prints a handout instead: one document (`/__mv/handout/?job=`), each slide's picture, its title and its
 * notes, paginated by Chrome on Letter or A4 landscape.
 *
 * Not promised (said in docs/pdf.md): a tagged PDF (pdf-lib copies pages, not Chrome's structure tree) and links
 * between slides.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, type PDFRef } from 'pdf-lib'
import { ROUTE } from '../cli/name.ts'
import { Browser } from './cdp.ts'
import { pool } from './shot.ts'
import { staleSurface } from './stale.ts'
import { exportPlan, type Plan, type PlanFrame, type PlanNode, type PlanPage, type Viewports } from '../shared/export-plan.ts'
import { BOARD_NAME } from '../shared/board-tree.ts'
import { COMPARE, CROP, PDF_INSTALL, SETTLED, SVG_IMAGES, TO_JPEG, TWO_FRAMES } from './pdf-page.ts'

// ---- the contract ------------------------------------------------------------------------------------------------

export type Paper = 'letter' | 'a4'
export type Mode = 'auto' | 'raster' | 'vector'
export interface PdfAsk { board: string; theme?: string; notes?: boolean; paper?: Paper; mode?: Mode; keepGoing?: boolean }

/** What the dev server hands a job: where to render, what the canvas is, and how to know its source changed. */
export interface PdfCtx {
  root: string
  origin: string
  viewports: Viewports
  themes: string[]
  canvasName: string
  version: string
  frames: () => (PlanFrame & { file: string; note?: string; scene?: string; variantGroup?: string; variant?: string })[]
  /** no source change in flight (the update-settlement barrier `shot` and bakes use) */
  settled: () => boolean
  /** a frame's document revision, dependency-aware (marks.ts docRev) */
  docRev: (id: string) => string
}

/** Budgets (spec 31 How): refused with a message, never silently. */
export const PDF_BUDGET = { side: 4096, pages: 300, ms: 15 * 60_000, bytes: 500 * 2 ** 20, slideMs: 10_000, keepMs: 60 * 60_000 }
export const PDF_LANES = 4
/** A job id: 128 random bits, base64url. */
export const JOB_ID = /^[A-Za-z0-9_-]{22}$/
/** The share of a patch box allowed to differ (screen certification), and of the page coarsely (print certification). */
export const CERTIFY = { box: 0.01, tol: 24, page: 0.0025 }
/** Measured on the build (a grid of sizes and blurs, rasterised and compared): Chrome prints a drop-shadow-only filter
 *  right at any size - unlike a large blurred box-shadow - so it is no trigger. Any other filter function is. */
export const DROP_SHADOW_PRINTS = true

export type SlideStatus = 'vector' | 'patched' | 'raster' | 'failed'
export interface PageReport {
  page: number
  frame: string
  title: string
  width: number
  height: number
  theme: string
  status: SlideStatus
  /** every effect patched, as `why` (a CSS effect, canvas, video) */
  patches?: string[]
  /** why the page is a raster, when it is one */
  raster?: string
  unsettled?: true
  clipped?: true
  spilled?: true
  changed?: true
  error?: string
  ms: number
  bytes?: number
}
export interface PdfReport {
  board: string
  notes: boolean
  pages: number
  bytes: number
  ms: number
  chrome: string
  /** print-certified (a rasteriser compared every printed page) or screen-certified only */
  certified: 'print' | 'screen'
  skipped: { frame: string; why: string }[]
  slides: PageReport[]
}

// ---- the plan for a board ------------------------------------------------------------------------------------------

/** Does the board play as slides? Its publish policy says `type: slides` or `open: slides` (Play's rule). */
export function playsAsSlides(root: string, board: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'design', 'publish.json'), 'utf8'))
    const p = raw?.boards?.[board]
    return !!p && typeof p === 'object' && (p.type === 'slides' || p.open === 'slides')
  } catch { return false }
}

/** The board file's nodes with the positions the canvas would give them: its own, else its layout's (a board an agent
 *  wrote as a frame list is laid out by the canvas when it opens - the same pure layout). */
export async function boardNodes(root: string, board: string, frames: (PlanFrame & { scene?: string; variantGroup?: string; variant?: string })[], viewports: Viewports, themes: string[]): Promise<{ nodes: PlanNode[]; title?: string } | null> {
  if (!BOARD_NAME.test(board) || board.length > 64) return null
  const { checkBoardsDir, isRegularFile } = await import('./boards.ts')
  const dir = join(root, 'design', 'boards'), file = join(dir, `${board}.json`)
  // the boards writer's rules: never a symlinked design/ or boards/, never a board file that is not a regular file
  if (checkBoardsDir(root, dir) || !isRegularFile(file)) return null
  let b: Record<string, unknown>
  try { b = JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  if (!b || typeof b !== 'object') return null
  const byId = new Map(frames.map((f) => [f.id, f]))
  type Raw = { frame: string; x?: unknown; y?: unknown; w?: unknown; h?: unknown; theme?: unknown; themeUser?: unknown }
  const raw: Raw[] = (Array.isArray(b.nodes) ? b.nodes : []).filter((n): n is Raw => !!n && typeof (n as Raw).frame === 'string')
  // an auto board shows every frame: the ones not on it yet follow, in the manifest's order
  if (b.auto === true) { const on = new Set(raw.map((n) => n.frame)); for (const f of frames) if (!on.has(f.id)) raw.push({ frame: f.id }) }
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const first = themes[0] ?? 'light'
  const themeOf = (n: Raw): string | undefined => {
    if (typeof n.themeUser === 'string' && themes.includes(n.themeUser)) return n.themeUser
    // legacy boards stored a theme on every node: only one that differs from the frame's default was a choice (store.ts)
    const f = byId.get(n.frame)
    return typeof n.theme === 'string' && themes.includes(n.theme) && n.theme !== (f?.theme ?? first) ? n.theme : undefined
  }
  const nodes: PlanNode[] = raw.map((n) => ({ frame: n.frame, x: num(n.x) ? n.x : 0, y: num(n.y) ? n.y : 0, ...(num(n.w) ? { w: n.w } : {}), ...(themeOf(n) ? { theme: themeOf(n) } : {}), ...(byId.has(n.frame) ? {} : { missing: true }) }))
  if (raw.some((n) => !num(n.x) || !num(n.y))) {
    const { tidy } = await import('../client/shell/tidy.ts')
    const { boardLayoutOf } = await import('./boards.ts')
    const { flow } = boardLayoutOf(b)
    const sceneOf = (id: string) => byId.get(id)?.scene ?? id.split('/')[0]
    const size = (n: Raw) => {
      const f = byId.get(n.frame)
      const vp = f?.viewport ? viewports[f.viewport] : undefined
      const d = f?.slide ? (vp ?? { width: 1280, height: 720 }) : (vp ?? viewports.mobile ?? { width: 390, height: 844 })
      return { w: num(n.w) ? n.w : d.width, h: num(n.h) ? n.h : d.height }
    }
    const placed = tidy(raw.map((n, i) => ({ key: String(i), frame: n.frame, scene: sceneOf(n.frame), group: byId.get(n.frame)?.variantGroup, variant: byId.get(n.frame)?.variant, ...size(n) })), flow)
    for (const p of placed) { const n = nodes[Number(p.key)]; if (n) { n.x = p.x; n.y = p.y } }
  }
  const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 200) : undefined
  return { nodes, ...(title ? { title } : {}) }
}

export type PlanAnswer = { ok: true; plan: Plan; title: string } | { ok: false; status: number; error: string }

/** The board's plan with its budgets checked: 404 for a board that is not there, 400 for one that cannot print. */
export async function planFor(ctx: Pick<PdfCtx, 'root' | 'viewports' | 'themes' | 'frames'>, board: string, theme?: string): Promise<PlanAnswer> {
  const frames = ctx.frames()
  const b = await boardNodes(ctx.root, board, frames, ctx.viewports, ctx.themes)
  if (!b) return { ok: false, status: 404, error: `no board "${board}" - boards are in design/boards/` }
  const plan = exportPlan({ slides: playsAsSlides(ctx.root, board), nodes: b.nodes, frames, viewports: ctx.viewports, theme })
  if (!plan.pages.length) return { ok: false, status: 400, error: `nothing to print on "${board}"${plan.skipped.length ? ` (${plan.skipped.length} frame(s) skipped: ${plan.skipped.slice(0, 3).map((s) => `${s.frame} - ${s.why}`).join(', ')})` : ''}` }
  if (plan.pages.length > PDF_BUDGET.pages) return { ok: false, status: 400, error: `"${board}" has ${plan.pages.length} pages - a PDF takes ${PDF_BUDGET.pages} at most` }
  const big = plan.pages.find((p) => p.width > PDF_BUDGET.side || p.height > PDF_BUDGET.side)
  if (big) return { ok: false, status: 400, error: `${big.frame} is ${big.width}x${big.height} - a page side is ${PDF_BUDGET.side} CSS px at most` }
  return { ok: true, plan, title: b.title ?? board.replace(/-/g, ' ') }
}

// ---- one slide ---------------------------------------------------------------------------------------------------

type Rect = { x: number; y: number; w: number; h: number }
type Link = { href: string; rects: Rect[] }
type Hit = { i: number; kind: 'glass' | 'whole' | 'shadow'; why: string; rect: Rect; transformed: boolean; replaced: boolean }

export interface SlideOut {
  status: SlideStatus
  pdf?: Buffer
  raster?: { jpeg: Buffer; dsf: number; links: Link[] }
  /** the handout's picture of the slide, a JPEG at 2x */
  picture?: Buffer
  patches?: string[]
  rasterWhy?: string
  unsettled?: true
  clipped?: true
  spilled?: true
  error?: string
  printDiffers?: true
  /** the printed page was rasterised and compared with the screen */
  printChecked?: true
}

/** Device pixels per CSS px for a page's captures: 3x, lowered (in quarter steps) so one capture stays under 16 MP. */
export const captureScale = (w: number, h: number): number => Math.max(1, Math.min(3, Math.floor(Math.sqrt(16e6 / (w * h)) * 4) / 4))

/** The URL a page renders at: the frame host (or an html frame's own file) with `export=1` - images at full resolution. */
export const exportUrl = (origin: string, page: { frame: string; kind: 'tsx' | 'html'; theme: string }, file?: string): string => page.kind === 'html' && file
  ? `${origin}/${file.split('/').map(encodeURIComponent).join('/')}?theme=${encodeURIComponent(page.theme)}&export=1`
  : `${origin}${ROUTE}/frame/?id=${encodeURIComponent(page.frame)}&theme=${encodeURIComponent(page.theme)}&export=1`

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The job's helper tab: an about:blank page that crops and compares pictures (never a slide's document). */
export class Helper {
  private constructor(private b: Browser, private sid: string, private owner: object) {}
  static async open(b: Browser, owner: object): Promise<Helper> {
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' }, undefined, owner)
    const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true }, undefined, owner)
    return new Helper(b, sessionId, owner)
  }
  private async call<T>(fn: string, args: unknown[]): Promise<T> {
    const r = await this.b.send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true }, this.sid, this.owner)
    if (r.exceptionDetails) throw new Error(`helper: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value as T
  }
  crop(shot: string, dsf: number, boxes: Rect[]) { return this.call<{ png: string; jpeg: string }[]>(CROP, [shot, dsf, boxes]) }
  compare(a: string, b: string, dsf: number, boxes: Rect[], tol: number) { return this.call<{ boxes: number[]; outside: { gt32: number; n: number; blockMax: number }; coarse: number }>(COMPARE, [a, b, dsf, boxes, tol]) }
  jpeg(png: string, quality: number, scale: number) { return this.call<string>(TO_JPEG, [png, quality, scale]) }
}

/** `marver`'s bake rule for "nothing else changed": at most 0.05 % of the pixels beyond 32 levels outside every box, and
 *  no 16x16 block more than a quarter changed. */
const untouched = (o: { gt32: number; n: number; blockMax: number }) => o.gt32 <= o.n * 0.0005 && o.blockMax <= 64

/** Is macOS `sips` here to rasterise a printed page (print certification)? */
let sipsHere: boolean | undefined
export function hasSips(): boolean {
  if (sipsHere === undefined) sipsHere = process.platform === 'darwin' && existsSync('/usr/bin/sips') && existsSync('/System/Library/ColorSync/Profiles/sRGB Profile.icc')
  return sipsHere
}
/** A one-page PDF rasterised by sips at `side` px on its long side, in sRGB (sips renders in the display's profile
 *  otherwise, and Display P3 values read as sRGB look like a colour shift). */
export function sipsRaster(pdfPath: string, side: number): Promise<Buffer | null> {
  const out = `${pdfPath}.sips.png`
  return new Promise((resolve) => {
    execFile('/usr/bin/sips', ['-s', 'format', 'png', '-Z', String(Math.round(side)), '-m', '/System/Library/ColorSync/Profiles/sRGB Profile.icc', pdfPath, '--out', out], { timeout: 20_000 }, (err) => {
      if (err) return resolve(null)
      try { const b = readFileSync(out); rmSync(out, { force: true }); resolve(b) } catch { resolve(null) }
    })
  })
}

/** Render, patch, certify and print one page. Throws only when the browser itself is gone. */
export async function renderSlide(b: Browser, helper: Helper, page: PlanPage, o: { url: string; dir: string; n: number; mode: Mode; notes: boolean; signal: AbortSignal; slideMs?: number }): Promise<SlideOut> {
  const W = page.width, H = page.height
  const dsf = captureScale(W, H)
  const owner = {}
  let targetId: string | undefined
  const send = (m: string, p: Record<string, unknown> = {}, sid?: string) => b.send(m, p, sid, owner)
  const abort = () => b.abort(owner, 'the export was cancelled')
  o.signal.addEventListener('abort', abort)
  try {
    targetId = (await send('Target.createTarget', { url: 'about:blank', newWindow: true })).targetId as string
    const sid = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId as string
    const ev = async <T = unknown>(expression: string, awaitPromise = false): Promise<T> => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sid)
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text)
      return r.result?.value as T
    }
    const bounded = <T>(p: Promise<T>, ms: number): Promise<T | null> => {
      let t: ReturnType<typeof setTimeout> | undefined
      return Promise.race([p.catch(() => null), new Promise<null>((r) => { t = setTimeout(() => r(null), Math.max(1, ms)) })]).finally(() => clearTimeout(t))
    }
    // the window sized to the capture (shot.ts #14): the native view is then exactly what a screenshot copies
    let view: { w: number; h: number } | null = null
    const win = await bounded(send('Browser.getWindowForTarget', { targetId }), 1000) as { windowId?: number; bounds?: { width?: number; height?: number } } | null
    const v0 = (await bounded(ev<number[]>('[innerWidth, innerHeight, devicePixelRatio]'), 1000)) as number[] | null
    if (win?.windowId !== undefined && v0 && typeof win.bounds?.width === 'number' && typeof win.bounds?.height === 'number') {
      const decoW = win.bounds.width - v0[0], decoH = win.bounds.height - v0[1]
      const cw = Math.round((W * dsf) / v0[2]), ch = Math.round((H * dsf) / v0[2])
      if (await bounded(send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { width: cw + decoW, height: ch + decoH } }).then(() => true), 1000)) view = { w: Math.round(cw * v0[2]), h: Math.round(ch * v0[2]) }
    }
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: dsf, mobile: false }, sid)
    // screen media: `@media print` and Tailwind's print: never reshape a slide (#3)
    await send('Emulation.setEmulatedMedia', { media: 'screen' }, sid)
    await send('Page.enable', {}, sid)
    let lastException = ''
    const off = b.on((m) => { if (m.sessionId === sid && m.method === 'Runtime.exceptionThrown') lastException = String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? '').split('\n')[0] })
    await send('Runtime.enable', {}, sid)
    try {
      const nav = await send('Page.navigate', { url: o.url }, sid)
      if (nav?.errorText && nav.errorText !== 'net::ERR_ABORTED') return { status: 'failed', error: `could not load the frame (${nav.errorText})` }
      const by = Date.now() + (o.slideMs ?? PDF_BUDGET.slideMs)
      let mounted = false
      while (Date.now() < by) {
        mounted = (await bounded(ev<boolean>(`(() => { const el = document.getElementById('root') ?? document.body; return !!el && el.childElementCount > 0 && document.readyState !== 'loading' })()`), 1500)) === true
        if (mounted) break
        await wait(100)
      }
      if (!mounted) return { status: 'failed', error: `the frame never rendered${lastException ? ` - the page threw: ${lastException}` : ''}` }
      // settle (shot's readiness): the camera at rest at 1:1, fonts, every image and chart in view, SVG images
      const left = () => Math.max(1, by - Date.now())
      await bounded(ev(`window.postMessage({type:'sh:camera',moving:false,scale:1}, location.origin)`), left())
      await bounded(ev('document.fonts.ready.then(() => true)', true), left())
      let settled = false
      while (Date.now() < by) {
        if ((await bounded(ev<boolean>(SETTLED), left())) === true) { settled = true; break }
        await wait(100)
      }
      await bounded(ev(SVG_IMAGES, true), Math.min(3000, left()))
      await bounded(ev(TWO_FRAMES, true), 1000)
      const frameError = await bounded(ev<string>(`window.__mvFrameError || ''`), 1000)
      if (frameError) return { status: 'failed', error: `the frame rendered an error - ${frameError}` }
      // frozen (#4): twice, two frames apart - an entrance that starts on its first frame is caught by the second pass
      await ev(PDF_INSTALL)
      await ev('window.__mvPdf.freeze()')
      await bounded(ev(TWO_FRAMES, true), 1000)
      await ev('window.__mvPdf.freeze()')
      await bounded(ev(TWO_FRAMES, true), 1000)
      const out: SlideOut = { status: 'vector', ...(settled ? {} : { unsettled: true as const }) }
      if (await ev<boolean>(`window.__mvPdf.clipped(${W}, ${H})`)) out.clipped = true
      await ev(`window.__mvPdf.stage(${W}, ${H}, ${!!out.clipped})`)
      await bounded(ev(TWO_FRAMES, true), 1000)

      // a screenshot of exactly the native view (never a clip): retaken when Chrome hands back its old surface tiled
      const shoot = async (): Promise<string> => {
        for (let k = 0; ; k++) {
          const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sid)
          const png = String(r.data)
          if (!view || k >= 2 || (await staleSurface(Buffer.from(png, 'base64'), view.w, view.h, Date.now() + 2000)) !== 'stale') return png
          await bounded(ev(TWO_FRAMES, true), 1000)
        }
      }
      const ref = await shoot()
      // MARVER_PDF_DEBUG=<dir>: each slide's pictures kept there (the screen, the patched page, the printed page)
      const debug = (name: string, data: string | Buffer) => { const d = process.env.MARVER_PDF_DEBUG; if (d) try { mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${String(o.n + 1).padStart(3, '0')}-${page.frame.replace(/\//g, '__')}.${name}`), typeof data === 'string' ? Buffer.from(data, 'base64') : data) } catch { /* a debug aid */ } }
      debug('screen.png', ref)
      if (o.notes) { out.picture = Buffer.from(await helper.jpeg(ref, 0.9, 2 / dsf), 'base64'); return out }
      const links = await ev<Link[]>('window.__mvPdf.links()')
      const toRaster = async (why: string): Promise<SlideOut> => ({ ...out, status: 'raster', rasterWhy: why, raster: { jpeg: Buffer.from(await helper.jpeg(ref, 0.9, 1), 'base64'), dsf, links } })
      if (o.mode === 'raster') return toRaster('--raster')

      // effects (#7): detected, captured in the unpatched page, applied together, certified
      const hits = o.mode === 'vector' ? [] : await ev<Hit[]>(`window.__mvPdf.detect(${W}, ${H}, ${DROP_SHADOW_PRINTS})`)
      if (hits.some((h) => h.transformed)) return toRaster(`an effect under a transform (${hits.find((h) => h.transformed)!.why})`)
      if (hits.length) {
        const patches: { i: number; kind: 'glass' | 'whole' | 'shadow'; url: string; links: Link[] }[] = []
        for (const h of hits) await ev(`window.__mvPdf.mark(${h.i}, ${JSON.stringify(h.kind)})`)
        for (const h of hits) {
          // a shadow is restyled, not captured
          if (h.kind === 'shadow') { patches.push({ i: h.i, kind: 'shadow', url: '', links: [] }); continue }
          const box = await ev<Rect | null>(`window.__mvPdf.prepare(${h.i})`)
          if (!box) continue
          await bounded(ev(TWO_FRAMES, true), 1000)
          const shot = await shoot()
          await ev('window.__mvPdf.restore()')
          const [c] = await helper.crop(shot, dsf, [box])
          // lossless unless the JPEG is much smaller (a photo, a blur)
          const url = c.png.length <= c.jpeg.length * 1.25 ? c.png : c.jpeg
          patches.push({ i: h.i, kind: h.kind, url, links: h.kind === 'whole' ? await ev<Link[]>(`window.__mvPdf.linksIn(${h.i})`) : [] })
        }
        await ev(`window.__mvPdf.apply(${JSON.stringify(patches)})`)
        await bounded(ev(`Promise.all(Array.from(document.images).map((im) => im.decode().catch(() => 1))).then(() => true)`, true), 3000)
        await bounded(ev(TWO_FRAMES, true), 1000)
        await wait(50)
        const patched = await shoot()
        debug('patched.png', patched)
        const v = await helper.compare(ref, patched, dsf, hits.map((h) => h.rect), CERTIFY.tol)
        const worst = Math.max(0, ...v.boxes)
        if (worst > CERTIFY.box) return toRaster(`a patch differed from the screen (${(worst * 100).toFixed(1)} % of its box)`)
        if (!untouched(v.outside)) return toRaster('a patch changed the slide outside its box')
        out.status = 'patched'
        out.patches = hits.map((h) => h.why)
      }

      // printed (#3): our geometry, one page asserted
      const pr = await send('Page.printToPDF', {
        paperWidth: W / 96, paperHeight: H / 96, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
        printBackground: true, preferCSSPageSize: false, scale: 1, generateTaggedPDF: false, generateDocumentOutline: false, transferMode: 'ReturnAsBase64',
      }, sid)
      let pdf: Buffer = Buffer.from(String(pr.data), 'base64')
      const doc = await PDFDocument.load(pdf, { updateMetadata: false })
      if (doc.getPageCount() > 1) {
        out.spilled = true
        const one = await PDFDocument.create()
        const [p] = await one.copyPages(doc, [0])
        one.addPage(p)
        pdf = Buffer.from(await one.save())
      }
      // print certification: the printed page rasterised and compared with the screen
      if (hasSips()) {
        const file = join(o.dir, `${String(o.n).padStart(3, '0')}.pdf`)
        writeFileSync(file, pdf)
        const png = await sipsRaster(file, Math.max(W, H) * 2)
        rmSync(file, { force: true })
        if (png) {
          debug('print.png', png)
          out.printChecked = true
          const c = await helper.compare(ref, png.toString('base64'), dsf, [], CERTIFY.tol)
          if (c.coarse > CERTIFY.page) {
            if (o.mode === 'vector') out.printDiffers = true
            else return toRaster(`the printed page differed from the screen (${(c.coarse * 100).toFixed(2)} % of it)`)
          }
        }
      }
      return { ...out, pdf }
    } finally { off() }
  } catch (err) {
    if (o.signal.aborted) throw new Error('the export was cancelled')
    if (b.dead) throw err
    return { status: 'failed', error: (err as Error).message }
  } finally {
    o.signal.removeEventListener('abort', abort)
    if (targetId && !b.dead) {
      let t: ReturnType<typeof setTimeout> | undefined
      await Promise.race([b.send('Target.closeTarget', { targetId }).catch(() => {}), new Promise((r) => { t = setTimeout(r, 2000) })])
      clearTimeout(t)
    }
    b.abort(owner, 'the slide finished')
  }
}

// ---- the merge ---------------------------------------------------------------------------------------------------

/** One bookmark per page, named by its title, each pointing at its page (pdf-lib's low-level outline objects). */
export function writeOutline(doc: PDFDocument, titles: string[]): void {
  const pages = doc.getPages()
  const n = Math.min(pages.length, titles.length)
  if (!n) return
  const ctx = doc.context
  const root = ctx.nextRef()
  const refs: PDFRef[] = Array.from({ length: n }, () => ctx.nextRef())
  for (let i = 0; i < n; i++) {
    const item = ctx.obj({}) as PDFDict
    item.set(PDFName.of('Title'), PDFHexString.fromText(titles[i]))
    item.set(PDFName.of('Parent'), root)
    if (i > 0) item.set(PDFName.of('Prev'), refs[i - 1])
    if (i < n - 1) item.set(PDFName.of('Next'), refs[i + 1])
    item.set(PDFName.of('Dest'), ctx.obj([pages[i].ref, PDFName.of('Fit')]))
    ctx.assign(refs[i], item)
  }
  const outlines = ctx.obj({}) as PDFDict
  outlines.set(PDFName.of('Type'), PDFName.of('Outlines'))
  outlines.set(PDFName.of('First'), refs[0])
  outlines.set(PDFName.of('Last'), refs[n - 1])
  outlines.set(PDFName.of('Count'), PDFNumber.of(n))
  ctx.assign(root, outlines)
  doc.catalog.set(PDFName.of('Outlines'), root)
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
}

/** A raster page: the picture filling a page of the slide's size, its links kept as link annotations. */
async function addRaster(doc: PDFDocument, page: PlanPage, r: NonNullable<SlideOut['raster']>): Promise<void> {
  const k = 0.75   // CSS px -> pt
  const p = doc.addPage([page.width * k, page.height * k])
  // a copy: pdf-lib's JPEG reader reads the bytes' whole ArrayBuffer from 0, and a small Buffer sits inside a shared pool
  const img = await doc.embedJpg(new Uint8Array(r.jpeg))
  p.drawImage(img, { x: 0, y: 0, width: page.width * k, height: page.height * k })
  const annots = []
  for (const l of r.links) for (const b of l.rects) {
    const x0 = Math.max(0, b.x) * k, x1 = Math.min(page.width, b.x + b.w) * k
    const y1 = (page.height - Math.max(0, b.y)) * k, y0 = (page.height - Math.min(page.height, b.y + b.h)) * k
    if (x1 - x0 < 0.5 || y1 - y0 < 0.5) continue
    annots.push(doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [x0, y0, x1, y1], Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(l.href) },
    })))
  }
  if (annots.length) p.node.set(PDFName.of('Annots'), doc.context.obj(annots))
}

/** Merge the pages in plan order; failed pages (with --keep-going) blank at their size. */
export async function mergePages(pages: { page: PlanPage; out: SlideOut }[], meta: { title: string; author: string; version: string; chrome: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  for (const { page, out } of pages) {
    if (out.pdf) {
      const src = await PDFDocument.load(out.pdf, { updateMetadata: false })
      const [p] = await doc.copyPages(src, [0])
      doc.addPage(p)
    } else if (out.raster) await addRaster(doc, page, out.raster)
    else doc.addPage([page.width * 0.75, page.height * 0.75])
  }
  writeOutline(doc, pages.map((p) => p.page.title))
  doc.setTitle(meta.title, { showInWindowTitleBar: true })
  doc.setAuthor(meta.author)
  doc.setCreator(`Marver ${meta.version}`)
  doc.setProducer(`Marver ${meta.version} (Chrome ${meta.chrome}, pdf-lib)`)
  const now = new Date()
  doc.setCreationDate(now)
  doc.setModificationDate(now)
  return doc.save()
}

/** Write `bytes` to `file` whole: a temp file beside it, then a rename. */
export function writeWhole(file: string, bytes: Uint8Array): void {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, bytes)
  try { renameSync(tmp, file) } catch (err) { rmSync(tmp, { force: true }); throw err }
}

// ---- jobs --------------------------------------------------------------------------------------------------------

export type JobState = 'running' | 'done' | 'failed' | 'cancelled'
export interface Job {
  id: string
  root: string
  board: string
  ask: PdfAsk
  state: JobState
  /** pages finished, of `pages` */
  page: number
  pages: number
  phase: 'starting' | 'rendering' | 'handout' | 'merging' | 'done'
  created: number
  ended?: number
  report?: PdfReport
  error?: string
  dir: string
  file?: string
  filename: string
  abort: AbortController
}
/** The abort reason of a cancel (a deadline aborts with its Error). */
const CANCELLED = 'cancelled'
const jobs = new Map<string, Job>()
const running = new Map<string, string>()   // root -> the job running on it

export const jobsDir = (root: string) => join(root, 'design', '.local', 'pdf')

/** `marver dev` start: no job survives a server (their browsers did not), so the folder starts empty. */
export function clearPdfJobs(root: string): void {
  try { rmSync(jobsDir(root), { recursive: true, force: true }) } catch { /* best-effort */ }
  for (const [id, j] of jobs) if (j.root === root) jobs.delete(id)
  running.delete(root)
}

/** Jobs past their hour: their folders removed, their ids forgotten. Run at every job request and on a timer. */
export function sweepPdfJobs(root: string, now = Date.now()): void {
  for (const [id, j] of jobs) {
    if (j.root !== root || j.state === 'running') continue
    if (now - (j.ended ?? j.created) > PDF_BUDGET.keepMs) { jobs.delete(id); try { rmSync(j.dir, { recursive: true, force: true }) } catch { /* gone */ } }
  }
  // a folder no job of this server knows (an earlier server's, a crash): past its hour, removed
  try {
    for (const n of readdirSync(jobsDir(root))) {
      if (jobs.has(n)) continue
      const p = join(jobsDir(root), n)
      try { if (now - statSync(p).mtimeMs > PDF_BUDGET.keepMs) rmSync(p, { recursive: true, force: true }) } catch { /* gone */ }
    }
  } catch { /* no folder yet */ }
}
let sweeper: ReturnType<typeof setInterval> | undefined
const roots = new Set<string>()

export const getJob = (id: string): Job | undefined => (JOB_ID.test(id) ? jobs.get(id) : undefined)
export const runningJob = (root: string): Job | undefined => { const id = running.get(root); return id ? jobs.get(id) : undefined }

/** What a status request answers. */
export const jobStatus = (j: Job) => ({
  job: j.id, board: j.board, state: j.state, phase: j.phase, page: j.page, pages: j.pages, notes: !!j.ask.notes, filename: j.filename,
  ...(j.report ? { report: j.report } : {}), ...(j.error ? { error: j.error } : {}),
})

export type StartAnswer = { ok: true; job: Job } | { ok: false; status: number; error: string; job?: string }

/** Validate and start a job: one per canvas (409 with the running one's id), the plan and its budgets checked first. */
export async function startPdfJob(ctx: PdfCtx, ask: PdfAsk, seams: { run?: (j: Job, plan: Plan, title: string) => Promise<void> } = {}): Promise<StartAnswer> {
  sweepPdfJobs(ctx.root)
  const busy = runningJob(ctx.root)
  if (busy) return { ok: false, status: 409, error: `a PDF of "${busy.board}" is being made - wait for it, or cancel it`, job: busy.id }
  if (ask.theme !== undefined && !/^[a-z0-9-]{1,32}$/i.test(ask.theme)) return { ok: false, status: 400, error: 'invalid theme' }
  const p = await planFor(ctx, ask.board, ask.theme)
  if (!p.ok) return p
  // a job may have started while the plan was read
  const again = runningJob(ctx.root)
  if (again) return { ok: false, status: 409, error: `a PDF of "${again.board}" is being made - wait for it, or cancel it`, job: again.id }
  const id = randomBytes(16).toString('base64url')
  const dir = join(jobsDir(ctx.root), id)
  mkdirSync(dir, { recursive: true })
  const job: Job = {
    id, root: ctx.root, board: ask.board, ask, state: 'running', page: 0, pages: p.plan.pages.length, phase: 'starting', created: Date.now(), dir,
    filename: `${ask.board}${ask.notes ? '-notes' : ''}.pdf`, abort: new AbortController(),
  }
  jobs.set(id, job)
  running.set(ctx.root, id)
  roots.add(ctx.root)
  if (!sweeper) { sweeper = setInterval(() => { for (const r of roots) sweepPdfJobs(r) }, 10 * 60_000); sweeper.unref?.() }
  const deadline = setTimeout(() => job.abort.abort(new Error(`the export took longer than ${PDF_BUDGET.ms / 60_000} minutes`)), PDF_BUDGET.ms)
  deadline.unref?.()
  void (seams.run ?? ((j, plan, title) => runJob(ctx, j, plan, title)))(job, p.plan, p.title)
    .then(() => { if (job.state === 'running') { job.state = 'done'; job.phase = 'done' } })
    .catch((err) => {
      if (job.state !== 'running') return
      const reason = job.abort.signal.aborted ? job.abort.signal.reason : undefined
      job.state = reason === CANCELLED ? 'cancelled' : 'failed'
      job.error = reason instanceof Error ? reason.message : (err as Error).message
    })
    .finally(() => {
      clearTimeout(deadline)
      job.ended = Date.now()
      if (running.get(ctx.root) === id) running.delete(ctx.root)
      // done: the folder keeps only the final PDF; otherwise nothing
      try { for (const n of readdirSync(dir)) if (job.state !== 'done' || join(dir, n) !== job.file) rmSync(join(dir, n), { recursive: true, force: true }) } catch { /* gone */ }
      if (job.state === 'cancelled') { jobs.delete(id); try { rmSync(dir, { recursive: true, force: true }) } catch { /* gone */ } }
    })
  return { ok: true, job }
}

/** Cancel a running job (its browser closes; nothing of it stays). */
export function cancelPdfJob(id: string): boolean {
  const j = getJob(id)
  if (!j) return false
  if (j.state === 'running') j.abort.abort(CANCELLED)
  else { jobs.delete(id); try { rmSync(j.dir, { recursive: true, force: true }) } catch { /* gone */ } }
  return true
}

/** The source revisions a job prints against: each frame's document, and the canvas-wide inputs. */
function revisions(ctx: PdfCtx, frames: string[]): { doc: Map<string, string>; global: string } {
  const doc = new Map(frames.map((f) => [f, ctx.docRev(f)]))
  const mt = (p: string) => { try { return String(statSync(join(ctx.root, p)).mtimeMs) } catch { return '-' } }
  return { doc, global: ['design/config.ts', 'design/theme.css', 'design/providers.tsx', 'design/assets'].map(mt).join('|') }
}

async function runJob(ctx: PdfCtx, job: Job, plan: Plan, title: string): Promise<void> {
  const t0 = Date.now()
  const signal = job.abort.signal
  // the update-settlement barrier (shot, bakes): an edit in flight lands before anything is printed
  for (const by = Date.now() + 10_000; !ctx.settled() && Date.now() < by && !signal.aborted;) await wait(100)
  const pages = plan.pages
  const frames = new Map(ctx.frames().map((f) => [f.id, f]))
  let revs = revisions(ctx, pages.map((p) => p.frame))
  if (signal.aborted) throw new Error('the export was cancelled')
  const b = await Browser.launch('mv-shot-')
  const owner = {}
  const kill = () => { void b.close() }
  signal.addEventListener('abort', kill)
  try {
    // cancelled while the browser started: the listener came too late to close it
    if (signal.aborted) throw new Error('the export was cancelled')
    const chrome = String((await b.send('Browser.getVersion')).product ?? '').replace(/^[^/]*\//, '')
    const helper = await Helper.open(b, owner)
    job.phase = 'rendering'
    let bytes = 0
    const outs = await pool(PDF_LANES, pages, async (page, n) => {
      if (signal.aborted) throw new Error('the export was cancelled')
      const t = Date.now()
      const url = exportUrl(ctx.origin, page, frames.get(page.frame)?.file)
      const once = () => renderSlide(b, helper, page, { url, dir: job.dir, n, mode: job.ask.mode ?? 'auto', notes: !!job.ask.notes, signal })
      let out = await once()
      // source changes (spec 31 How): a frame whose document moved while it rendered renders once more; still moving,
      // it is printed and named
      let changed = false
      const moved = () => { const now = revisions(ctx, [page.frame]); return !ctx.settled() || now.doc.get(page.frame) !== revs.doc.get(page.frame) || now.global !== revs.global }
      if (out.status !== 'failed' && moved()) {
        for (const by = Date.now() + 5000; !ctx.settled() && Date.now() < by;) await wait(100)
        revs = { doc: new Map([...revs.doc, [page.frame, ctx.docRev(page.frame)]]), global: revisions(ctx, []).global }
        out = await once()
        changed = moved()
      }
      if (out.status === 'failed' && !job.ask.keepGoing) throw new Error(`${page.frame}: ${out.error}`)
      bytes += out.pdf?.length ?? out.raster?.jpeg.length ?? out.picture?.length ?? 0
      if (bytes > PDF_BUDGET.bytes) throw new Error(`the PDF passed ${PDF_BUDGET.bytes / 2 ** 20} MB - export fewer slides, or with --vector`)
      job.page++
      return { page, out, ms: Date.now() - t, changed }
    })
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('the export was cancelled')
    let pdf: Uint8Array
    if (job.ask.notes) {
      job.phase = 'handout'
      pdf = await printHandout(b, ctx, job, outs.map((o) => ({ page: o.page, picture: o.out.picture, note: frames.get(o.page.frame)?.note })))
    } else {
      job.phase = 'merging'
      pdf = await mergePages(outs, { title, author: ctx.canvasName, version: ctx.version, chrome })
    }
    if (pdf.length > PDF_BUDGET.bytes) throw new Error(`the PDF is ${Math.round(pdf.length / 2 ** 20)} MB - ${PDF_BUDGET.bytes / 2 ** 20} MB at most`)
    const file = join(job.dir, job.filename)
    writeWhole(file, pdf)
    job.file = file
    job.report = {
      board: job.board, notes: !!job.ask.notes, pages: outs.length, bytes: pdf.length, ms: Date.now() - t0, chrome,
      // print-certified only when every printed page was rasterised and compared (a raster page is a picture of the screen)
      certified: !job.ask.notes && outs.every((o) => !o.out.pdf || o.out.printChecked) && outs.some((o) => o.out.printChecked) ? 'print' : 'screen', skipped: plan.skipped,
      slides: outs.map(({ page, out, ms, changed }, i) => ({
        page: i + 1, frame: page.frame, title: page.title, width: page.width, height: page.height, theme: page.theme, status: out.status, ms,
        ...(out.patches?.length ? { patches: out.patches } : {}), ...(out.rasterWhy ? { raster: out.rasterWhy } : {}),
        ...(out.unsettled ? { unsettled: true as const } : {}), ...(out.clipped ? { clipped: true as const } : {}), ...(out.spilled ? { spilled: true as const } : {}),
        ...(changed ? { changed: true as const } : {}), ...(out.error ? { error: out.error } : {}), ...(out.printDiffers ? { error: 'the printed page differs from the screen (--vector kept it)' } : {}),
        bytes: out.pdf?.length ?? out.raster?.jpeg.length ?? out.picture?.length ?? 0,
      })),
    }
  } finally {
    signal.removeEventListener('abort', kill)
    await b.close()
  }
}

// ---- the handout -------------------------------------------------------------------------------------------------

/** What the handout page shows, held for its document (`/__mv/handout/?job=`) while it prints. */
const handouts = new Map<string, { title: string; canvas: string; paper: Paper; slides: { title: string; picture?: string; html: string }[] }>()

const PAPER: Record<Paper, { w: number; h: number }> = { letter: { w: 11, h: 8.5 }, a4: { w: 11.69, h: 8.27 } }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The handout document: per slide its picture, its title as an h2, its notes as Markdown (11 pt at least), or "No
 *  notes". Inert by construction (md.ts escapes raw HTML; the page is served with a CSP that runs no script). */
export function handoutHtml(h: { title: string; canvas: string; paper: Paper; slides: { title: string; picture?: string; html: string }[] }, pictureUrl: (n: number) => string): string {
  const p = PAPER[h.paper]
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(h.title)}</title><style>
@page { size: ${p.w}in ${p.h}in; margin: 0.45in 0.5in 0.6in }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact }
body { margin: 0; font: 11pt/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1d1d1f }
.slide { display: grid; grid-template-columns: 58% 1fr; column-gap: 0.35in; align-items: start }
.slide + .slide { break-before: page }
.slide > .pic { break-inside: avoid; margin: 0 }
.slide > .pic img { display: block; width: 100%; height: auto; border: 0.5pt solid #d2d2d7; border-radius: 4pt }
.slide > .pic .n { margin-top: 6pt; font-size: 9pt; color: #86868b }
.side h2 { margin: 0 0 8pt; font-size: 15pt; line-height: 1.25; font-weight: 600; break-after: avoid }
.notes { font-size: 11pt }
.notes :first-child { margin-top: 0 }
.notes h1, .notes h2, .notes h3, .notes h4 { font-size: 12pt; margin: 10pt 0 4pt; break-after: avoid }
.notes p, .notes ul, .notes ol, .notes blockquote, .notes pre, .notes table { margin: 0 0 7pt }
.notes ul, .notes ol { padding-left: 16pt }
.notes code { font: 10.5pt ui-monospace, SFMono-Regular, Menlo, monospace; background: #f2f2f4; padding: 0 2pt; border-radius: 2pt }
.notes pre { background: #f5f5f7; padding: 6pt 8pt; border-radius: 4pt; white-space: pre-wrap; word-break: break-word; font-size: 11pt }
.notes pre code { background: none; padding: 0; font-size: 11pt }
.notes table { border-collapse: collapse; font-size: 11pt }
.notes th, .notes td { border: 0.5pt solid #d2d2d7; padding: 3pt 6pt; text-align: left; vertical-align: top }
.notes blockquote { border-left: 2pt solid #d2d2d7; padding-left: 8pt; color: #515154 }
.notes img { max-width: 100%; height: auto }
.notes a { color: #0066cc; text-decoration: none }
.none { color: #86868b; font-style: italic }
</style></head><body>
${h.slides.map((s, i) => `<section class="slide"><figure class="pic">${s.picture ? `<img src="${esc(pictureUrl(i))}" alt="${esc(s.title)}">` : ''}<figcaption class="n">${i + 1} / ${h.slides.length}</figcaption></figure><div class="side"><h2>${esc(s.title)}</h2>${s.html ? `<div class="notes">${s.html}</div>` : '<p class="none">No notes</p>'}</div></section>`).join('\n')}
</body></html>`
}

async function printHandout(b: Browser, ctx: PdfCtx, job: Job, slides: { page: PlanPage; picture?: Buffer; note?: string }[]): Promise<Uint8Array> {
  const { renderMarkdown } = await import('../client/content/md.ts')
  slides.forEach((s, i) => { if (s.picture) writeFileSync(join(job.dir, `${i}.jpg`), s.picture) })
  handouts.set(job.id, {
    title: `${job.board.replace(/-/g, ' ')} - notes`, canvas: ctx.canvasName, paper: job.ask.paper ?? 'letter',
    slides: slides.map((s) => ({ title: s.page.title, ...(s.picture ? { picture: `${slides.indexOf(s)}.jpg` } : {}), html: s.note ? renderMarkdown(s.note) : '' })),
  })
  const owner = {}
  let targetId: string | undefined
  try {
    targetId = (await b.send('Target.createTarget', { url: 'about:blank' }, undefined, owner)).targetId
    const sid = (await b.send('Target.attachToTarget', { targetId, flatten: true }, undefined, owner)).sessionId as string
    const send = (m: string, p: Record<string, unknown> = {}) => b.send(m, p, sid, owner)
    await send('Page.enable')
    await send('Page.navigate', { url: `${ctx.origin}${ROUTE}/handout/?job=${job.id}` })
    for (const by = Date.now() + 30_000; Date.now() < by;) {
      const r = await send('Runtime.evaluate', { expression: `document.readyState === 'complete' && Array.from(document.images).every((i) => i.complete)`, returnByValue: true })
      if (r.result?.value === true) break
      await wait(100)
    }
    await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true, returnByValue: true })
    const p = PAPER[job.ask.paper ?? 'letter']
    const pr = await send('Page.printToPDF', {
      paperWidth: p.w, paperHeight: p.h, marginTop: 0.45, marginBottom: 0.6, marginLeft: 0.5, marginRight: 0.5, printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font:8px -apple-system,Helvetica,Arial,sans-serif;color:#86868b;padding:0 0.5in;display:flex;justify-content:space-between"><span>${esc(ctx.canvasName)} · ${esc(job.board)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
      // Chrome builds the outline from the document's structure, which only a tagged print has
      generateDocumentOutline: true, generateTaggedPDF: true, transferMode: 'ReturnAsBase64',
    })
    const doc = await PDFDocument.load(Buffer.from(String(pr.data), 'base64'), { updateMetadata: false })
    doc.setTitle(`${job.board.replace(/-/g, ' ')} - notes`, { showInWindowTitleBar: true })
    doc.setAuthor(ctx.canvasName)
    doc.setCreator(`Marver ${ctx.version}`)
    doc.setProducer(`Marver ${ctx.version} (Chrome, pdf-lib)`)
    return doc.save()
  } finally {
    handouts.delete(job.id)
    if (targetId && !b.dead) await b.send('Target.closeTarget', { targetId }).catch(() => {})
    b.abort(owner, 'the handout finished')
  }
}

/** `/__mv/handout/?job=` and its pictures: served only while that job's handout prints, to its own browser. */
export function handoutMiddleware(): (req: { url?: string; method?: string }, res: { statusCode: number; setHeader(k: string, v: string | number): void; end(b?: string | Buffer): void }, next: () => void) => void {
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (!url.pathname.startsWith(`${ROUTE}/handout/`)) return next()
    const job = url.searchParams.get('job') ?? ''
    const h = JOB_ID.test(job) ? handouts.get(job) : undefined
    const j = h ? jobs.get(job) : undefined
    if (!h || !j || req.method !== 'GET') { res.statusCode = 404; return res.end('not found') }
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    const pic = /^\/handout\/(\d{1,3})\.jpg$/.exec(url.pathname.slice(ROUTE.length))
    if (pic) {
      const n = Number(pic[1])
      if (!h.slides[n]?.picture) { res.statusCode = 404; return res.end('not found') }
      try { const buf = readFileSync(join(j.dir, `${n}.jpg`)); res.setHeader('content-type', 'image/jpeg'); res.setHeader('content-length', buf.length); return res.end(buf) } catch { res.statusCode = 404; return res.end('not found') }
    }
    if (url.pathname !== `${ROUTE}/handout/`) { res.statusCode = 404; return res.end('not found') }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:")
    return res.end(handoutHtml(h, (n) => `${ROUTE}/handout/${n}.jpg?job=${job}`))
  }
}
