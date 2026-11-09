/**
 * Spec 31 Part A in the app: File > Export PDF… and the shell's Export PDF. Only a job id crosses from the canvas; main
 * (pdf-save.ts) asks the canvas for the finished job on the tab's own session, opens the save panel, checks the
 * document again, fetches the file (a PDF, 200 MB at most) and writes it. And the File menu shows a canvas's file items.
 * No window: the ports are fakes, the menu is menu.ts's pure template.
 */
import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { pdfName, readCapped, savePdf, type PdfSavePorts } from '../../src/main/pdf-save.ts'
import { menuTemplate, type MenuActs, type MenuModel } from '../../src/main/menu.ts'
import { PDF_MAX } from '../../../src/shared/app-api.ts'

const JOB = 'AbCdEfGhIjKlMnOpQrStUv'
const PDF = Buffer.from('%PDF-1.7\n%fake\n')
const ORIGIN = 'http://localhost:5621'

function ports(o: { status?: Record<string, unknown> | number; file?: Response | (() => Response); csrf?: string | null; panel?: string | null; still?: () => boolean; write?: () => Promise<void> } = {}) {
  const asked: { url: string; headers: Record<string, string> }[] = []
  const written: { file: string; bytes: Buffer }[] = []
  const panels: string[] = []
  const p: PdfSavePorts = {
    origin: ORIGIN,
    fetch: async (url, headers) => {
      asked.push({ url, headers })
      if (url.endsWith('/file')) return typeof o.file === 'function' ? o.file() : o.file ?? new Response(PDF, { headers: { 'content-type': 'application/pdf' } })
      if (typeof o.status === 'number') return new Response('{}', { status: o.status })
      return new Response(JSON.stringify(o.status ?? { state: 'done', filename: 'mark-ii.pdf' }), { headers: { 'content-type': 'application/json' } })
    },
    csrf: async () => (o.csrf === undefined ? 'c0ffee' : o.csrf),
    downloads: () => '/Users/me/Downloads',
    savePanel: async (d) => { panels.push(d); return o.panel === undefined ? '/Users/me/Desktop/deck.pdf' : o.panel },
    still: o.still ?? (() => true),
    write: async (file, bytes) => { if (o.write) await o.write(); written.push({ file, bytes }) },
  }
  return { p, asked, written, panels }
}

describe('savePdf: only a job id crosses, and main checks everything', () => {
  it('saves a finished job: the job asked on the canvas origin with the owner cookie echoed, the panel on ~/Downloads/<its name>, the bytes written', async () => {
    const r = ports()
    expect(await savePdf(JOB, r.p)).toEqual({ ok: true })
    expect(r.asked.map((a) => a.url)).toEqual([`${ORIGIN}/__mv/api/pdf/${JOB}`, `${ORIGIN}/__mv/api/pdf/${JOB}/file`])
    expect(r.asked.every((a) => a.headers['x-mv-c'] === 'c0ffee')).toBe(true)
    expect(r.panels).toEqual(['/Users/me/Downloads/mark-ii.pdf'])
    expect(r.written).toEqual([{ file: '/Users/me/Desktop/deck.pdf', bytes: PDF }])
  })
  it('refuses anything but a job id before asking anything (no path, no URL ever built from it)', async () => {
    for (const bad of ['../../etc/passwd', 'x', `${JOB}/../a`, `${JOB}x`, 42, null, { job: JOB }]) {
      const r = ports()
      expect(await savePdf(bad, r.p)).toEqual({ ok: false, why: 'bad-job' })
      expect(r.asked).toEqual([])
    }
  })
  it('a job that is not finished, or unknown, opens no panel', async () => {
    for (const status of [{ state: 'running' }, { state: 'failed' }, 404]) {
      const r = ports({ status })
      expect(await savePdf(JOB, r.p)).toEqual({ ok: false, why: 'bad-job' })
      expect(r.panels).toEqual([])
    }
  })
  it('no owner cookie in the tab\'s session: untrusted, nothing asked', async () => {
    const r = ports({ csrf: null })
    expect(await savePdf(JOB, r.p)).toEqual({ ok: false, why: 'untrusted' })
    expect(r.asked).toEqual([])
  })
  it('the panel closed: cancelled, the file never fetched', async () => {
    const r = ports({ panel: null })
    expect(await savePdf(JOB, r.p)).toEqual({ ok: false, why: 'cancelled' })
    expect(r.asked.some((a) => a.url.endsWith('/file'))).toBe(false)
  })
  it('the document checked again after the panel: another one now (a reload, lost trust) gets nothing', async () => {
    let n = 0
    const r = ports({ still: () => ++n < 1 })
    expect(await savePdf(JOB, r.p)).toEqual({ ok: false, why: 'untrusted' })
    expect(r.panels.length).toBe(1)
    expect(r.asked.some((a) => a.url.endsWith('/file'))).toBe(false)
    expect(r.written).toEqual([])
  })
  it('and checked once more right before the write: a document gone while the file came gets nothing written', async () => {
    let n = 0
    const r = ports({ still: () => ++n < 2 })   // true after the panel, false before the write
    expect(await savePdf(JOB, r.p)).toEqual({ ok: false, why: 'untrusted' })
    expect(r.asked.some((a) => a.url.endsWith('/file'))).toBe(true)
    expect(r.written).toEqual([])
  })
  it('200 MB at most - by its length header, and as it arrives when the header lies or is absent', async () => {
    const big = new Response(new ReadableStream({ start(c) { const chunk = new Uint8Array(8 * 2 ** 20); for (let i = 0; i <= PDF_MAX / chunk.length; i++) c.enqueue(chunk); c.close() } }), { headers: { 'content-type': 'application/pdf' } })
    const r1 = ports({ file: big })
    expect(await savePdf(JOB, r1.p)).toEqual({ ok: false, why: 'too-large' })
    const r2 = ports({ file: new Response(PDF, { headers: { 'content-type': 'application/pdf', 'content-length': String(PDF_MAX + 1) } }) })
    expect(await savePdf(JOB, r2.p)).toEqual({ ok: false, why: 'too-large' })
    expect([...r1.written, ...r2.written]).toEqual([])
  })
  it('the file must be a PDF: its type and its first bytes', async () => {
    const r1 = ports({ file: new Response('<html>', { headers: { 'content-type': 'text/html' } }) })
    expect(await savePdf(JOB, r1.p)).toEqual({ ok: false, why: 'failed' })
    const r2 = ports({ file: new Response('not a pdf', { headers: { 'content-type': 'application/pdf' } }) })
    expect(await savePdf(JOB, r2.p)).toEqual({ ok: false, why: 'failed' })
    expect([...r1.written, ...r2.written]).toEqual([])
  })
  it('a write that fails says so', async () => {
    const r = ports({ write: async () => { throw new Error('EACCES') } })
    expect(await savePdf(JOB, r.p)).toEqual({ ok: false, why: 'failed' })
  })
  it('the name the canvas offers is used only when it is a plain .pdf name', () => {
    expect(pdfName('mark-ii.pdf')).toBe('mark-ii.pdf')
    expect(pdfName('cto-brief-notes.pdf')).toBe('cto-brief-notes.pdf')
    for (const bad of ['../x.pdf', '/etc/x.pdf', 'x.pdf.app', '.pdf', 'a b.pdf', 'x..pdf', 42]) expect(pdfName(bad)).toBe('deck.pdf')
  })
  it('readCapped reads a small body whole', async () => {
    expect(await readCapped(new Response('hello'), 10)).toEqual(Buffer.from('hello'))
  })
})

describe('the File menu carries a canvas\'s file items (spec 31)', () => {
  const acts: MenuActs = { run() {}, holds: () => true, canvasClick() {}, tab() {}, help() {}, perfFiles() {}, update() {}, exportReport() {}, rebuild() {} }
  const token = { tab: 't1', commit: 1, trusted: true }
  const model = (kind: 'local' | 'remote'): MenuModel => ({
    active: { id: 't1', kind, name: 'Aperture', token, trusted: true, canClose: true, canReload: true },
    canvas: kind === 'local' ? { token, items: [{ id: 'export-pdf', group: 'file', label: 'Export PDF…' }, { id: 'tidy', group: 'view', label: 'Tidy', hint: 'T' }] } : null,
    tabs: [], header: true, update: null,
  })
  const file = (m: MenuModel) => (menuTemplate(m, acts).find((x) => x.label === 'File')!.submenu as MenuItemConstructorOptions[])
  it('a local canvas: Export PDF… under its name, sending the canvas its click', () => {
    let clicked = ''
    const items = file(model('local'))
    const it = items.find((x) => x.id === 'cv:export-pdf')!
    expect(it.label).toBe('Export PDF…')
    expect(it.accelerator).toBeUndefined()
    const a = { ...acts, canvasClick: (_t: unknown, id: string) => { clicked = id } }
    ;(menuTemplate(model('local'), a).find((x) => x.label === 'File')!.submenu as MenuItemConstructorOptions[]).find((x) => x.id === 'cv:export-pdf')!.click!({} as never, undefined, {} as never)
    expect(clicked).toBe('export-pdf')
    // a view item stays in View
    expect(items.some((x) => x.id === 'cv:tidy')).toBe(false)
  })
  it('a shared canvas has none', () => {
    expect(file(model('remote')).some((x) => String(x.id ?? '').startsWith('cv:'))).toBe(false)
  })
})
