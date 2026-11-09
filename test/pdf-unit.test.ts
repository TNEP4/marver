import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { boardOrder, exportPlan, presentDevice, titleOf, type PlanFrame } from '../src/shared/export-plan.ts'
import {
  assetsChanged, boardNodes, cancelPdfJob, captureScale, handoutAllowed, clearPdfJobs, exportUrl, getJob, handoutHtml, jobsDir, jobStatus, JOB_ID, mergePages, PDF_BUDGET, planFor, playsAsSlides,
  startPdfJob, sweepPdfJobs, unlinkGotos, writeOutline, writeWhole, type PdfCtx,
} from '../src/server/pdf.ts'
import { reportLines } from '../src/cli/pdf.ts'
import { knownType, resolveType } from '../src/shared/board-types.ts'
import { placeNewcomers } from '../src/shared/auto-place.ts'

/**
 * Spec 31 Part A, the parts that need no browser: the export plan (both board kinds, duplicates, missing frames, sizes,
 * themes), the board's positions when it has none, the budgets, the job lifecycle (409, cancel, cleanup, the atomic
 * write), the merge's bookmarks and metadata and a raster page's links (read back with pdfjs-dist), the report, the
 * handout's escaping, and the `slides` type alias.
 */

const VP = { mobile: { width: 390, height: 844 }, laptop: { width: 1280, height: 800 }, monitor: { width: 1920, height: 1080 } }
const f = (id: string, o: Partial<PlanFrame> = {}): PlanFrame => ({ id, kind: 'tsx', ...o })

describe('the export plan (#2)', () => {
  const frames = [
    f('d/01', { slide: true, title: 'Opening' }), f('d/02', { slide: true, viewport: 'laptop' }), f('d/03', { slide: true, theme: 'dark' }),
    f('d/page'), f('d/doc', { kind: 'html', viewport: 'monitor' }), f('d/wide', { viewport: 'monitor' }),
  ]
  it('a slides board: slide frames in reading order (y, then x), deduped; a non-slide frame skipped and named; a missing one too', () => {
    const p = exportPlan({ slides: true, frames, viewports: VP, nodes: [
      { frame: 'd/02', x: 900, y: 0 }, { frame: 'd/01', x: 0, y: 0 }, { frame: 'd/03', x: 0, y: 500 }, { frame: 'd/01', x: 0, y: 900 },
      { frame: 'd/page', x: 1800, y: 0 }, { frame: 'd/gone', x: 0, y: 0 },
    ] })
    expect(p.pages.map((x) => x.frame)).toEqual(['d/01', 'd/02', 'd/03'])
    expect(p.skipped).toEqual([{ frame: 'd/gone', why: 'missing' }, { frame: 'd/page', why: 'not a slide' }])
    // sizes: the slide stage - its declared viewport, else 1280x720
    expect(p.pages.map((x) => [x.width, x.height])).toEqual([[1280, 720], [1280, 800], [1280, 720]])
    expect(p.pages[0].title).toBe('Opening')
    expect(p.pages[1].title).toBe('02')
  })
  it('a present board: the board\'s own order, html frames included, deduped; sizes by the device Play picks', () => {
    const p = exportPlan({ slides: false, frames, viewports: VP, nodes: [
      { frame: 'd/page', x: 5000, y: 0, w: 1280 }, { frame: 'd/doc', x: 0, y: 0, w: 777 }, { frame: 'd/01', x: 0, y: 0, w: 640 },
      { frame: 'd/wide', x: 0, y: 0, w: 333 }, { frame: 'd/page', x: 0, y: 0, w: 390 }, { frame: 'd/nope', x: 0, y: 0 },
    ] })
    expect(p.pages.map((x) => x.frame)).toEqual(['d/page', 'd/doc', 'd/01', 'd/wide'])
    // the node's width names the device (laptop); else the frame's viewport (monitor); a slide is its stage on any board
    expect(p.pages.map((x) => [x.width, x.height, x.device])).toEqual([[1280, 800, 'laptop'], [1920, 1080, 'monitor'], [1280, 720, undefined], [1920, 1080, 'monitor']])
    expect(p.pages[1].kind).toBe('html')
    expect(p.skipped).toEqual([{ frame: 'd/nope', why: 'missing' }])
  })
  it('no width match and no viewport: the first viewport, at its height', () => {
    const p = exportPlan({ slides: false, frames: [f('x/a')], viewports: VP, nodes: [{ frame: 'x/a', x: 0, y: 0, w: 1 }] })
    expect([p.pages[0].width, p.pages[0].height, p.pages[0].device]).toEqual([390, 844, 'mobile'])
  })
  it('theme: the export\'s own, else the node\'s, else the frame\'s, else light', () => {
    const nodes = [{ frame: 'd/01', x: 0, y: 0, theme: 'sepia' }, { frame: 'd/03', x: 0, y: 1 }, { frame: 'd/02', x: 0, y: 2 }]
    expect(exportPlan({ slides: true, frames, viewports: VP, nodes }).pages.map((x) => x.theme)).toEqual(['sepia', 'dark', 'light'])
    expect(exportPlan({ slides: true, frames, viewports: VP, nodes, theme: 'dark' }).pages.map((x) => x.theme)).toEqual(['dark', 'dark', 'dark'])
  })
  it('Play reads the same rules: its list is the board order without html, its device the plan\'s', () => {
    const nodes = [{ frame: 'd/doc', w: 1 }, { frame: 'd/page', w: 1280 }, { frame: 'd/page', w: 390 }, { frame: 'd/01', missing: true }]
    const byId = new Map(frames.map((x) => [x.id, x]))
    expect(boardOrder(nodes, (n) => byId.get(n.frame), { html: false }).map((n) => n.frame)).toEqual(['d/page'])
    expect(boardOrder(nodes, (n) => byId.get(n.frame), { html: true }).map((n) => n.frame)).toEqual(['d/doc', 'd/page'])
    expect(presentDevice({ w: 1920 }, { viewport: 'laptop' }, VP)).toBe('monitor')
    expect(presentDevice({ w: 1 }, { viewport: 'laptop' }, VP)).toBe('laptop')
    expect(presentDevice(undefined, undefined, VP)).toBe('mobile')
    expect(titleOf({ id: 'mark-ii/12-chat' })).toBe('12 chat')
  })
})

describe('the board a job reads', () => {
  let root = ''
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = '' })
  const canvas = (board: Record<string, unknown>, publish?: Record<string, unknown>) => {
    root = mkdtempSync(join(tmpdir(), 'mv-pdfunit-'))
    mkdirSync(join(root, 'design', 'boards'), { recursive: true })
    writeFileSync(join(root, 'design', 'boards', 'deck.json'), JSON.stringify(board))
    if (publish) writeFileSync(join(root, 'design', 'publish.json'), JSON.stringify(publish))
    return root
  }
  const frames = ['a', 'b', 'c'].map((n) => ({ ...f(`s/${n}`, { slide: true }), scene: 's', file: `design/scenes/s/${n}.tsx` }))
  it('plays as slides only when its publish policy says so (type or open: slides)', () => {
    canvas({ nodes: [] }, { boards: { deck: { type: 'slides' }, other: { open: 'slides' }, third: { type: 'design', open: 'present' } } })
    expect([playsAsSlides(root, 'deck'), playsAsSlides(root, 'other'), playsAsSlides(root, 'third'), playsAsSlides(root, 'none')]).toEqual([true, true, false, false])
  })
  it('a board written as a frame list is laid out as the canvas would: its recipe\'s order', async () => {
    canvas({ nodes: [{ frame: 's/a' }, { frame: 's/b' }, { frame: 's/c' }], layout: { rows: [['s']], scenes: { s: { rows: [['c', 'a', 'b']] } } } }, { boards: { deck: { type: 'slides' } } })
    const b = await boardNodes(root, 'deck', frames, VP, ['light', 'dark'])
    const plan = exportPlan({ slides: true, nodes: b!.nodes, frames, viewports: VP })
    expect(plan.pages.map((p) => p.frame)).toEqual(['s/c', 's/a', 's/b'])
  })
  it('the shared placement rule: an empty board starts at 0, a grouped frame lands right of its group\'s rightmost node on its row', () => {
    const make = (fr: { id: string }, x: number, y: number, w: number) => ({ frame: fr.id, x, y, w })
    expect(placeNewcomers([], [{ id: 'a' }], () => ({ w: 100, h: 50 }), make)).toEqual([{ frame: 'a', x: 0, y: 0, w: 100 }])
    const out = placeNewcomers([{ frame: 'g1', x: 0, y: 900, w: 1000 }, { frame: 'z', x: 3000, y: 0, w: 100 }],
      [{ id: 'g1', variantGroup: 'g' }, { id: 'z' }, { id: 'g2', variantGroup: 'g' }, { id: 'n' }], () => ({ w: 100, h: 50 }), make)
    expect(out.slice(2)).toEqual([{ frame: 'g2', x: 1000 + 140, y: 900, w: 100 }, { frame: 'n', x: 3100 + 96, y: 0, w: 100 }])
  })
  it('an auto board keeps its saved positions and places a frame it gains as the canvas does: B above A + newcomer C plays B, C, A', async () => {
    canvas({ auto: true, nodes: [{ frame: 's/a', x: 0, y: 1000, w: 1280, h: 720 }, { frame: 's/b', x: 0, y: 0, w: 1280, h: 720 }, { frame: 's/gone', x: 0, y: 500 }] }, { boards: { deck: { type: 'slides' } } })
    const b = await boardNodes(root, 'deck', frames, VP, ['light'])
    // the saved nodes stay where they were, the frame gone from the manifest is shed, the newcomer goes past the right edge
    expect(b!.nodes.map((n) => [n.frame, n.x, n.y])).toEqual([['s/a', 0, 1000], ['s/b', 0, 0], ['s/c', 1280 + 96, 0]])
    const plan = exportPlan({ slides: true, nodes: b!.nodes, frames, viewports: VP })
    expect(plan.pages.map((p) => p.frame)).toEqual(['s/b', 's/c', 's/a'])
  })
  it('an auto board whose file has a node with no position is laid out again, as the canvas does - a gone frame\'s node counts, though it is shed', async () => {
    canvas({ auto: true, nodes: [{ frame: 's/a', x: 0, y: 1000, w: 1280, h: 720 }, { frame: 's/b', x: 0, y: 0, w: 1280, h: 720 }, { frame: 's/gone' }] })
    const b = await boardNodes(root, 'deck', frames, VP, ['light'])
    expect(b!.nodes.map((n) => n.frame)).toEqual(['s/a', 's/b', 's/c'])
    expect(b!.nodes.find((n) => n.frame === 's/a')!.y).not.toBe(1000)
  })
  it('an auto board whose newcomer\'s note has no room is laid out again, as the canvas does (store.ts cramped): B above A + noted C plays A, B, C', async () => {
    canvas({ auto: true, nodes: [{ frame: 's/a', x: 0, y: 1000, w: 1280, h: 720 }, { frame: 's/b', x: 0, y: 0, w: 1280, h: 720 }] }, { boards: { deck: { type: 'slides' } } })
    const noted = frames.map((fr) => (fr.id === 's/c' ? { ...fr, note: 'why this slide' } : fr))
    const b = await boardNodes(root, 'deck', noted, VP, ['light'], [{ name: 's' }])
    expect(exportPlan({ slides: true, nodes: b!.nodes, frames: noted, viewports: VP }).pages.map((p) => p.frame)).toEqual(['s/a', 's/b', 's/c'])
    // the same board with C's note out of anyone's way keeps its saved positions
    const far = await boardNodes(root, 'deck', frames, VP, ['light'], [{ name: 's' }])
    expect(far!.nodes.map((n) => [n.frame, n.y])).toEqual([['s/a', 1000], ['s/b', 0], ['s/c', 0]])
  })
  it('a Doc\'s committed height is the one the cramped rule sees, as the canvas hydrates it: no phantom overlap, saved positions kept', async () => {
    const fr = [
      { ...f('s/a', { slide: true }), scene: 's', file: 'design/scenes/s/a.tsx', note: 'why' },
      { ...f('s/b', { slide: true }), scene: 's', file: 'design/scenes/s/b.tsx' },
      { ...f('s/doc', { viewport: undefined }), scene: 's', file: 'design/scenes/s/doc.tsx', contentWidth: 1500 },
    ]
    // the Doc's saved h is a stale guess; at its placeholder (1500 x 0.75) its card would run into A's note
    canvas({ auto: true, nodes: [{ frame: 's/doc', x: 1500, y: -1100, w: 1500, h: 1125 }, { frame: 's/a', x: 1700, y: 0, w: 1280, h: 720 }, { frame: 's/b', x: 0, y: 2000, w: 1280, h: 720 }] }, { boards: { deck: { type: 'slides' } } })
    writeFileSync(join(root, 'design', 'boards', '_sizes.json'), JSON.stringify({ heights: { 's/doc@1500': 100 } }))
    const b = await boardNodes(root, 'deck', fr, VP, ['light'], [{ name: 's' }])
    expect(b!.nodes.map((n) => [n.frame, n.x, n.y])).toEqual([['s/doc', 1500, -1100], ['s/a', 1700, 0], ['s/b', 0, 2000]])
    // no committed height: the placeholder does run into the note, and the board is laid out again, as the canvas does
    rmSync(join(root, 'design', 'boards', '_sizes.json'))
    const placeholder = await boardNodes(root, 'deck', fr, VP, ['light'], [{ name: 's' }])
    expect(placeholder!.nodes.find((n) => n.frame === 's/b')!.y).not.toBe(2000)
  })
  it('a node\'s theme: its own pin, else a legacy stored theme that differs from the frame\'s default', async () => {
    canvas({ nodes: [{ frame: 's/a', x: 0, y: 0, themeUser: 'dark' }, { frame: 's/b', x: 1, y: 0, theme: 'light' }, { frame: 's/c', x: 2, y: 0, theme: 'dark' }] })
    const b = await boardNodes(root, 'deck', frames, VP, ['light', 'dark'])
    expect(b!.nodes.map((n) => n.theme)).toEqual(['dark', undefined, 'dark'])
  })
  it('a node with no saved size is planned at the size the canvas gives it: a wide Doc at its width (laptop), not the first viewport', async () => {
    const docs = [{ ...f('w/doc', { viewport: undefined }), scene: 'w', contentWidth: 1280, file: 'design/scenes/w/doc.tsx' }, { ...f('w/screen'), scene: 'w', file: 'design/scenes/w/screen.tsx' }]
    canvas({ nodes: [{ frame: 'w/doc', x: 0, y: 0 }, { frame: 'w/screen', x: 2000, y: 0 }] })
    const b = await boardNodes(root, 'deck', docs, VP, ['light'])
    const plan = exportPlan({ slides: false, nodes: b!.nodes, frames: docs, viewports: VP })
    expect(plan.pages.map((p) => [p.frame, p.width, p.height, p.device])).toEqual([['w/doc', 1280, 800, 'laptop'], ['w/screen', 390, 844, 'mobile']])
  })
  it('budgets: a missing board is a 404, an empty one, past 300 pages or a side past 4096 px a 400 with the reason', async () => {
    canvas({ nodes: [] })
    const ctx = { root, viewports: VP, themes: ['light'], frames: () => frames }
    expect(await planFor(ctx, 'nope')).toMatchObject({ ok: false, status: 404 })
    expect(await planFor(ctx, 'deck')).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('nothing to print') })
    const many = Array.from({ length: PDF_BUDGET.pages + 1 }, (_, i) => ({ ...f(`m/${i}`, { slide: true }), scene: 'm', file: `design/scenes/m/${i}.tsx` }))
    writeFileSync(join(root, 'design', 'boards', 'deck.json'), JSON.stringify({ nodes: many.map((m, i) => ({ frame: m.id, x: i, y: 0 })) }))
    expect(await planFor({ ...ctx, frames: () => many }, 'deck')).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('300 at most') })
    const huge = [{ ...f('h/x', { slide: true, viewport: 'huge' }), scene: 'h', file: 'design/scenes/h/x.tsx' }]
    writeFileSync(join(root, 'design', 'boards', 'deck.json'), JSON.stringify({ nodes: [{ frame: 'h/x', x: 0, y: 0 }] }))
    expect(await planFor({ ...ctx, viewports: { huge: { width: 5000, height: 800 } }, frames: () => huge }, 'deck')).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('4096') })
  })
})

describe('jobs (spec 31 How)', () => {
  let root = ''
  afterEach(() => { if (root) { clearPdfJobs(root); rmSync(root, { recursive: true, force: true }) } root = '' })
  const ctxFor = (): PdfCtx => {
    root = mkdtempSync(join(tmpdir(), 'mv-pdfjobs-'))
    mkdirSync(join(root, 'design', 'boards'), { recursive: true })
    writeFileSync(join(root, 'design', 'boards', 'deck.json'), JSON.stringify({ nodes: [{ frame: 's/a', x: 0, y: 0 }] }))
    return { root, origin: 'http://localhost:1', viewports: VP, themes: ['light'], canvasName: 'Canvas', version: '0.31.0', frames: () => [{ ...f('s/a', { slide: true }), file: 'design/scenes/s/a.tsx' }], settled: () => true, docRev: () => '1' }
  }
  it('one job per canvas: a second gets 409 with the running one\'s id; a finished job keeps only its PDF', async () => {
    const ctx = ctxFor()
    let release!: () => void
    const run = (j: { dir: string; file?: string; filename: string }) => new Promise<void>((res) => { release = () => { writeFileSync(join(j.dir, 'scratch.pdf'), 'x'); j.file = join(j.dir, j.filename); writeFileSync(j.file, '%PDF-1.7'); res() } })
    const a = await startPdfJob(ctx, { board: 'deck' }, { run })
    expect(a.ok).toBe(true)
    const id = (a as { job: { id: string } }).job.id
    expect(JOB_ID.test(id)).toBe(true)
    const b = await startPdfJob(ctx, { board: 'deck' }, { run })
    expect(b).toMatchObject({ ok: false, status: 409, job: id })
    release()
    await new Promise((r) => setTimeout(r, 20))
    const j = getJob(id)!
    expect(jobStatus(j)).toMatchObject({ job: id, board: 'deck', state: 'done', filename: 'deck.pdf' })
    expect(readdirSync(j.dir)).toEqual(['deck.pdf'])
    // done: the canvas takes a new job
    expect((await startPdfJob(ctx, { board: 'deck' }, { run: async () => {} })).ok).toBe(true)
  })
  it('cancel: the job ends cancelled, its folder and id gone; an invalid theme is refused', async () => {
    const ctx = ctxFor()
    const a = await startPdfJob(ctx, { board: 'deck' }, { run: (j) => new Promise((_, rej) => j.abort.signal.addEventListener('abort', () => rej(new Error('stopped')))) })
    const j = (a as { job: { id: string; dir: string } }).job
    expect(existsSync(j.dir)).toBe(true)
    expect(cancelPdfJob(j.id)).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(getJob(j.id)).toBeUndefined()
    expect(existsSync(j.dir)).toBe(false)
    expect(await startPdfJob(ctx, { board: 'deck', theme: '../x' })).toMatchObject({ ok: false, status: 400 })
    expect(getJob('../../etc')).toBeUndefined()
  })
  it('a cancel that lands while the last step finishes still wins: the job ends cancelled, never done', async () => {
    const ctx = ctxFor()
    let finish!: () => void
    const a = await startPdfJob(ctx, { board: 'deck' }, { run: (j) => new Promise<void>((res) => { finish = () => { j.file = join(j.dir, j.filename); writeFileSync(j.file, '%PDF'); res() } }) })
    const id = (a as { job: { id: string } }).job.id
    cancelPdfJob(id)
    finish()   // the run ends normally after the cancel (a merge that does not look at the signal)
    await new Promise((r) => setTimeout(r, 20))
    expect(getJob(id)).toBeUndefined()
  })
  it('a failure is reported with its reason (and the deadline\'s reason when it fires)', async () => {
    const ctx = ctxFor()
    const a = await startPdfJob(ctx, { board: 'deck' }, { run: async () => { throw new Error('s/a: the frame never rendered') } })
    await new Promise((r) => setTimeout(r, 20))
    expect(jobStatus(getJob((a as { job: { id: string } }).job.id)!)).toMatchObject({ state: 'failed', error: 's/a: the frame never rendered' })
  })
  it('a dev server restart in this process cancels the running job and frees the canvas for the next one', async () => {
    const ctx = ctxFor()
    const a = await startPdfJob(ctx, { board: 'deck' }, { run: (j) => new Promise((_, rej) => j.abort.signal.addEventListener('abort', () => rej(new Error('stopped')))) })
    const j = (a as { job: { id: string; abort: AbortController } }).job
    const { resetPdf } = await import('../src/server/pdf-reset.ts')
    resetPdf(root)
    expect(j.abort.signal.aborted).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(getJob(j.id)).toBeUndefined()
    expect((await startPdfJob(ctx, { board: 'deck' }, { run: async () => {} })).ok).toBe(true)
  })
  it('an asset overwritten while a slide rendered is seen (its folder keeps its time; the file does not)', () => {
    const ctx = ctxFor()
    mkdirSync(join(root, 'design', 'assets'), { recursive: true })
    writeFileSync(join(root, 'design', 'assets', 'photo.png'), 'a')
    const since = Date.now() + 5000
    expect(assetsChanged(root, ['design/assets/photo.png'], since)).toBe(false)
    const later = since / 1000 + 1
    utimesSync(join(root, 'design', 'assets', 'photo.png'), later, later)
    expect(assetsChanged(root, ['design/assets/photo.png'], since)).toBe(true)
    expect(assetsChanged(root, ['design/assets/../../etc/passwd', 'design/x'], 0)).toBe(false)
    // an asset deleted under a loaded slide is a change too
    expect(assetsChanged(root, ['design/assets/gone.png'], since)).toBe(true)
    void ctx
  })
  it('the handout page is gated like the CLI\'s routes: the canvas\'s dev token, or nothing', () => {
    const ctx = ctxFor()
    mkdirSync(join(root, 'design', '.local'), { recursive: true })
    writeFileSync(join(root, 'design', '.local', 'dev.json'), JSON.stringify({ port: 1, token: 'tok-123', pid: process.pid }))
    expect(handoutAllowed({ 'x-mv-work': 'tok-123' }, root)).toBe(true)
    expect(handoutAllowed({}, root)).toBe(false)
    expect(handoutAllowed({ 'x-mv-work': 'other' }, root)).toBe(false)
    rmSync(join(root, 'design', '.local', 'dev.json'))
    expect(handoutAllowed({ 'x-mv-work': 'tok-123' }, root)).toBe(false)
    void ctx
  })
  it('the job folder is never reached through a link out of the project: dev start and cleanup leave it, a job is refused', async () => {
    const ctx = ctxFor()
    const outside = mkdtempSync(join(tmpdir(), 'mv-pdf-outside-'))
    try {
      mkdirSync(join(outside, 'pdf'), { recursive: true })
      writeFileSync(join(outside, 'pdf', 'keep.txt'), 'theirs')
      const { symlinkSync } = await import('node:fs')
      symlinkSync(outside, join(root, 'design', '.local'))
      clearPdfJobs(root)
      sweepPdfJobs(root, Date.now() + 10 * PDF_BUDGET.keepMs)
      expect(readFileSync(join(outside, 'pdf', 'keep.txt'), 'utf8')).toBe('theirs')
      expect(await startPdfJob(ctx, { board: 'deck' }, { run: async () => {} })).toMatchObject({ ok: false, status: 422 })
    } finally { rmSync(outside, { recursive: true, force: true }) }
  })
  it('a job folder swapped for a link while it ran: nothing behind the link is enumerated or removed, now or on DELETE', async () => {
    const ctx = ctxFor()
    const outside = mkdtempSync(join(tmpdir(), 'mv-pdf-outside-'))
    try {
      writeFileSync(join(outside, 'precious.txt'), 'theirs')
      const { symlinkSync } = await import('node:fs')
      const a = await startPdfJob(ctx, { board: 'deck' }, { run: async (j) => { rmSync(j.dir, { recursive: true, force: true }); symlinkSync(outside, j.dir) } })
      const id = (a as { job: { id: string } }).job.id
      await new Promise((r) => setTimeout(r, 20))
      expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('theirs')
      cancelPdfJob(id)
      expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('theirs')
      sweepPdfJobs(root, Date.now() + 10 * PDF_BUDGET.keepMs)
      expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('theirs')
    } finally { rmSync(outside, { recursive: true, force: true }) }
  })
  it('cleanup: past its hour a job and its folder go; a folder no job knows goes too; dev start clears them all', async () => {
    const ctx = ctxFor()
    const a = await startPdfJob(ctx, { board: 'deck' }, { run: async (j) => { j.file = join(j.dir, j.filename); writeFileSync(j.file, '%PDF') } })
    const j = (a as { job: { id: string; dir: string } }).job
    await new Promise((r) => setTimeout(r, 20))
    const stray = join(jobsDir(root), 'stray-folder')
    mkdirSync(stray)
    const old = (Date.now() - 2 * PDF_BUDGET.keepMs) / 1000
    utimesSync(stray, old, old)
    sweepPdfJobs(root)
    expect([existsSync(j.dir), existsSync(stray)]).toEqual([true, false])
    sweepPdfJobs(root, Date.now() + PDF_BUDGET.keepMs + 1000)
    expect([existsSync(j.dir), getJob(j.id)]).toEqual([false, undefined])
    const b = await startPdfJob(ctx, { board: 'deck' }, { run: async () => {} })
    await new Promise((r) => setTimeout(r, 20))
    clearPdfJobs(root)
    expect([existsSync(jobsDir(root)), getJob((b as { job: { id: string } }).job.id)]).toEqual([false, undefined])
  })
  it('the file is written whole: a temp beside it, then a rename over the old one; nothing left behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-pdfwhole-'))
    try {
      const file = join(dir, 'deck.pdf')
      writeFileSync(file, 'old')
      writeWhole(file, Buffer.from('%PDF-new'))
      expect(readFileSync(file, 'utf8')).toBe('%PDF-new')
      expect(readdirSync(dir)).toEqual(['deck.pdf'])
      expect(() => writeWhole(join(dir, 'missing', 'deck.pdf'), Buffer.from('x'))).toThrow()
      expect(readdirSync(dir)).toEqual(['deck.pdf'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the merge: bookmarks, metadata, raster pages (#8)', () => {
  // a red 1x1 JPEG
  const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64')
  it('one bookmark per page titled by its frame, each pointing at its page; Title, Author, Creator; a raster page keeps its links', async () => {
    const one = async (w: number, h: number) => { const d = await PDFDocument.create(); d.addPage([w * 0.75, h * 0.75]); return Buffer.from(await d.save()) }
    const pages = [
      { page: { frame: 'd/01', kind: 'tsx' as const, width: 1280, height: 720, theme: 'light', title: 'Café ✓ opening' }, out: { status: 'vector' as const, pdf: await one(1280, 720) } },
      { page: { frame: 'd/02', kind: 'tsx' as const, width: 1280, height: 800, theme: 'light', title: 'Glass' }, out: { status: 'raster' as const, raster: { jpeg: JPEG, dsf: 3, links: [{ href: 'https://example.com/x', rects: [{ x: 100, y: 50, w: 200, h: 40 }] }] } } },
      { page: { frame: 'd/03', kind: 'tsx' as const, width: 1280, height: 720, theme: 'light', title: 'Failed' }, out: { status: 'failed' as const, error: 'boom' } },
    ]
    const bytes = await mergePages(pages, { title: 'Mark II', author: 'Aperture', version: '0.31.0', chrome: '142.0' })
    const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true }).promise
    expect(doc.numPages).toBe(3)
    const sizes = await Promise.all([1, 2, 3].map(async (n) => (await doc.getPage(n)).view.slice(2)))
    expect(sizes).toEqual([[960, 540], [960, 600], [960, 540]])
    const outline = await doc.getOutline()
    expect(outline.map((o) => o.title)).toEqual(['Café ✓ opening', 'Glass', 'Failed'])
    const idx = await Promise.all(outline.map(async (o) => doc.getPageIndex((o.dest as unknown[])[0] as never)))
    expect(idx).toEqual([0, 1, 2])
    const meta = await doc.getMetadata()
    expect(meta.info).toMatchObject({ Title: 'Mark II', Author: 'Aperture', Creator: 'Marver 0.31.0' })
    const annots = await (await doc.getPage(2)).getAnnotations()
    expect(annots).toEqual([expect.objectContaining({ subtype: 'Link', url: 'https://example.com/x' })])
    // the link's box in PDF space: x 100-300 px, y 50-90 px from the top of an 800 px page
    expect(annots[0].rect.map((v: number) => Math.round(v))).toEqual([75, 533, 225, 563])
    await doc.destroy()
  })
  it('writeOutline on a document with no pages writes nothing', async () => {
    const d = await PDFDocument.create()
    writeOutline(d, ['x'])
    expect(d.catalog.get(d.context.obj('Outlines') as never)).toBeUndefined()
  })
})

describe('the report, the handout, the URLs', () => {
  it('reportLines names every slide that needs a look, and the certification', () => {
    const lines = reportLines({ board: 'deck', notes: false, pages: 3, bytes: 3_300_000, ms: 12_345, chrome: '142', certified: 'print', skipped: [{ frame: 'd/x', why: 'not a slide' }], slides: [
      { page: 1, frame: 'd/01', title: 'a', width: 1280, height: 720, theme: 'light', status: 'patched', patches: ['backdrop-filter', 'backdrop-filter', 'box-shadow'], ms: 1, clipped: true },
      { page: 2, frame: 'd/02', title: 'b', width: 1280, height: 720, theme: 'light', status: 'raster', raster: 'a patch differed', ms: 1, unsettled: true, changed: true },
      { page: 3, frame: 'd/03', title: 'c', width: 1280, height: 720, theme: 'light', status: 'failed', error: 'boom', ms: 1, spilled: true },
    ] }, 'design/exports/deck.pdf')
    expect(lines).toEqual([
      'design/exports/deck.pdf - 3 pages, 3.1 MB, 12.3 s',
      '  skipped: d/x (not a slide)', '  failed: d/03 (boom)', '  patched: d/01 (backdrop-filter; box-shadow)', '  raster: d/02 (a patch differed)',
      '  unsettled: d/02', '  clipped: d/01', '  spilled: d/03', '  changed while printing: d/02',
      '  every page print-certified (rasterised and compared with the screen)',
    ])
  })
  it('--vector: a page that prints differently is named, and the PDF is not called print-certified', () => {
    const lines = reportLines({ board: 'deck', notes: false, pages: 1, bytes: 1000, ms: 1000, chrome: '1', certified: 'screen', skipped: [], slides: [
      { page: 1, frame: 'd/01', title: 'a', width: 1280, height: 720, theme: 'light', status: 'vector', printDiffers: true, ms: 1 },
    ] }, 'x.pdf')
    expect(lines.slice(1)).toEqual(['  printed differently from the screen (kept: --vector): d/01', '  not print-certified: the pages above differ in print'])
  })
  it('the handout escapes titles and keeps notes as given (md.ts renders them inert), "No notes" where there are none', () => {
    const html = handoutHtml({ title: '<b>x</b>', canvas: 'c', paper: 'a4', slides: [{ title: '<script>alert(1)</script>', picture: '0.jpg', html: '<p>ok</p>' }, { title: 't', html: '' }] }, (n) => `/p/${n}.jpg?job=x"`)
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&#60;script&#62;')
    expect(html).toContain('src="/p/0.jpg?job=x&#34;"')
    expect(html).toContain('<div class="notes"><p>ok</p></div>')
    expect(html).toContain('<p class="none">No notes</p>')
    expect(html).toContain('size: 11.69in 8.27in')
  })
  it('a link to another slide in the notes prints as its text - never a link to the local handout page', () => {
    expect(unlinkGotos('<p>see <a href="#" data-goto="d/02">slide <em>2</em></a> and <a href="https://x.com/" target="_blank" rel="noopener noreferrer">x</a></p>'))
      .toBe('<p>see <span class="goto">slide <em>2</em></span> and <a href="https://x.com/" target="_blank" rel="noopener noreferrer">x</a></p>')
  })
  it('a page renders with export=1 - its frame host or its html file', () => {
    expect(exportUrl('http://o', { frame: 'd/a b', kind: 'tsx', theme: 'dark' })).toBe('http://o/__mv/frame/?id=d%2Fa%20b&theme=dark&export=1')
    expect(exportUrl('http://o', { frame: 'd/p', kind: 'html', theme: 'light' }, 'design/scenes/d/p q.html')).toBe('http://o/design/scenes/d/p%20q.html?theme=light&export=1')
  })
  it('captures at 3x, lowered in quarter steps under 16 MP', () => {
    expect(captureScale(1280, 720)).toBe(3)
    expect(captureScale(1920, 1080)).toBe(2.75)
    expect(1920 * 1080 * captureScale(1920, 1080) ** 2).toBeLessThan(16e6)
    expect(captureScale(4096, 4096)).toBe(1)
  })
})

describe('the notice\'s summary of a report (the shell)', () => {
  it('names what needs a look in a few words, nothing when all is well', async () => {
    const { reportNotes } = await import('../src/client/shell/pdf-notes.ts')
    expect(reportNotes({ skipped: [], slides: [{ status: 'vector' }, { status: 'patched' }] })).toBe('')
    expect(reportNotes({ skipped: [1], slides: [{ status: 'raster', clipped: true }, { status: 'raster', unsettled: true }] }))
      .toBe(' · 1 skipped, 2 as pictures, 1 unsettled, 1 clipped (npx marver pdf says which)')
    expect(reportNotes(undefined)).toBe('')
  })
})

describe('the board type `slides` (spec 31 How)', () => {
  it('reads as a deck for the type only; a stored word stays as written, and the CLI still names the known types', () => {
    expect(resolveType('slides')).toBe('deck')
    expect(resolveType(undefined, 'slides')).toBe('deck')
    expect(resolveType('constructor')).toBe('plain')
    expect(knownType('slides')).toBeUndefined()
  })
})

describe('init keeps design/exports/ out of git (spec 31 How)', () => {
  it('a fresh canvas ignores it, an older .gitignore gains it once, never rewritten', async () => {
    const { init } = await import('../src/cli/init.ts')
    const fresh = mkdtempSync(join(tmpdir(), 'mv-pdf-init-'))
    const old = mkdtempSync(join(tmpdir(), 'mv-pdf-init-'))
    try {
      init(fresh, { mode: 'studio', demo: false })
      expect(readFileSync(join(fresh, 'design', '.gitignore'), 'utf8').split('\n')).toContain('exports/')
      mkdirSync(join(old, 'design'), { recursive: true })
      writeFileSync(join(old, 'design', '.gitignore'), '.local/\n# mine\nsecret.env\n')
      init(old, { mode: 'studio', demo: false })
      const gi = readFileSync(join(old, 'design', '.gitignore'), 'utf8')
      expect(gi.startsWith('.local/\n# mine\nsecret.env\n')).toBe(true)
      expect(gi.split('\n').filter((l) => l === 'exports/').length).toBe(1)
      init(old, { mode: 'studio', demo: false })
      expect(readFileSync(join(old, 'design', '.gitignore'), 'utf8')).toBe(gi)
    } finally { rmSync(fresh, { recursive: true, force: true }); rmSync(old, { recursive: true, force: true }) }
  })
})
