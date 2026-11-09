// The shell's PDF export end to end with its server faked (spec 31 Part A): how a finished PDF reaches the person in a
// browser, and in the Mac app 1.0.1 - which has no exportPdf and cancels a download its window did not start while
// focused, so the notice holds the file for a Download click instead of saying "downloaded" (release review).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ app: null as null | Record<string, unknown>, toasts: [] as string[], clicks: [] as string[], deletes: 0, cmds: [] as string[] }))
vi.mock('../src/client/shell/marver-app.ts', () => ({ get APP() { return h.app } }))
vi.mock('../src/client/shell/icons.tsx', () => ({ ExportIcon: () => null, XIcon: () => null }))
vi.mock('../src/client/shell/commands.ts', () => ({ cmd: (name: string) => { h.cmds.push(name); return { done: () => {}, fail: () => {}, noop: () => {} } } }))
vi.mock('../src/client/shell/store.ts', () => ({
  PUBLISHED: false, boardLabel: (b: string) => b,
  useStore: { getState: () => ({ board: 'other', dirty: false, save: async () => true, toast: (t: string) => h.toasts.push(t) }) },
}))
const json = (b: unknown, status = 200) => ({ ok: status < 300, status, json: async () => b, blob: async () => new Blob(['%PDF']) })
vi.mock('../src/client/shell/api.ts', () => ({
  api: async (path: string, o?: { method?: string }) => {
    if (path === 'pdf' && o?.method === 'POST') return json({ job: 'j1', pages: 2 })
    if (path === 'pdf/j1' && o?.method === 'DELETE') { h.deletes++; return json({ ok: true }) }
    if (path === 'pdf/j1') return json({ state: 'done', page: 2, pages: 2, filename: 'deck.pdf', report: { slides: [] } })
    if (path === 'pdf/j1/file') return json({})
    return json({ error: 'no' }, 404)
  },
}))

beforeEach(() => {
  h.toasts = []; h.clicks = []; h.deletes = 0; h.cmds = []
  const g = globalThis as Record<string, unknown>
  g.document = {
    cookie: '',
    createElement: () => { const a = { href: '', download: '', rel: '', click: () => h.clicks.push(a.download), remove: () => {} }; return a },
    body: { appendChild: () => {} },
  }
  URL.createObjectURL = () => 'blob:pdf'
  URL.revokeObjectURL = () => {}
})

describe('a finished PDF in the shell', () => {
  it('a browser downloads it at once and clears the notice', async () => {
    h.app = null
    const m = await import('../src/client/shell/pdf-export.tsx')
    await m.exportPdf('deck', {}, { via: 'click', in: 'shell' })
    expect(h.clicks).toEqual(['deck.pdf'])
    expect(h.toasts).toEqual(['deck.pdf downloaded'])
    expect(m.usePdfExport.getState().state).toBe('idle')
  })
  it('the 1.0.1 app (no exportPdf): the job is kept and offers Download - nothing is downloaded or said downloaded until that click', async () => {
    h.app = { v: 1 }
    const m = await import('../src/client/shell/pdf-export.tsx')
    await m.exportPdf('deck', {}, { via: 'click', in: 'shell' })
    expect(h.clicks).toEqual([])
    expect(h.toasts).toEqual([])
    expect(m.usePdfExport.getState()).toMatchObject({ state: 'ready', job: 'j1', filename: 'deck.pdf' })
    // a second export waits for this one to be downloaded or dismissed
    await m.exportPdf('deck', {}, { via: 'click', in: 'shell' })
    expect(m.usePdfExport.getState().state).toBe('ready')
    m.downloadPdf({ via: 'click', in: 'shell' })
    expect(h.clicks).toEqual(['deck.pdf'])
    expect(h.toasts.at(-1)).toBe('deck.pdf downloaded')
    expect(m.usePdfExport.getState()).toMatchObject({ state: 'idle', job: null })
    expect(h.cmds).toContain('export-pdf-download')
  })
  it('the 1.0.1 app: dismissing the held PDF ends its job without a download', async () => {
    h.app = { v: 1 }
    const m = await import('../src/client/shell/pdf-export.tsx')
    await m.exportPdf('deck', {}, { via: 'click', in: 'shell' })
    await m.cancelPdf({ via: 'click', in: 'shell' })
    expect(h.clicks).toEqual([])
    expect(h.deletes).toBe(1)
    expect(h.toasts).toEqual(['PDF dismissed'])
    expect(m.usePdfExport.getState().state).toBe('idle')
  })
})
