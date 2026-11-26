/**
 * The shell's side of a drawing frame (spec 38): the state each open drawing reports (`sh:draw-state`), the commands
 * the bar and panel send it (`sh:draw-cmd`), and what comes back from an export. One store for the canvas's frames
 * (keyed by node key) and play's (keyed `play:<frame>`).
 */
import { create } from 'zustand'
import type { DrawCmd, DrawState } from '../../../shared/draw-protocol.ts'
import { cmd } from '../commands.ts'
import { useStore, PUBLISHED } from '../store.ts'
import { api } from '../api.ts'

type Cmd = DrawCmd extends infer C ? C extends { type: 'sh:draw-cmd' } ? Omit<C, 'type'> : never : never

interface DrawStore {
  states: Record<string, DrawState>
  errors: Record<string, string>
  put(key: string, s: DrawState): void
  fail(key: string, msg: string): void
  drop(key: string): void
}
export const useDraw = create<DrawStore>((set) => ({
  states: {},
  errors: {},
  put: (key, s) => set((st) => ({ states: { ...st.states, [key]: s } })),
  fail: (key, msg) => set((st) => ({ errors: { ...st.errors, [key]: msg } })),
  drop: (key) => set((st) => { const states = { ...st.states }; delete states[key]; return { states } }),
}))

/** Where a drawing's commands go: its iframe's window, found when sent (an iframe can be replaced). */
export interface DrawLink { key: string; title: string; frame: string; win: () => Window | null | undefined }

/** A command the person gave from the bar, the panel or the view controls - recorded (spec 30's discipline), then sent. */
export function drawSend(link: DrawLink, c: Cmd): void {
  cmd('draw-cmd', { via: 'click', in: 'shell', arg: c.op === 'action' ? c.name : c.op === 'tool' ? c.tool : c.op === 'view' ? c.v : c.op })
  sendQuiet(link, c)
}
/** The same, when it is no input of the person's (a flush on leaving, the UI's hidden state). */
export function sendQuiet(link: DrawLink, c: Cmd): void {
  try { link.win()?.postMessage({ type: 'sh:draw-cmd', ...c }, location.origin) } catch { /* the frame is going away */ }
}

// ---- exports: the host renders, the shell saves or copies ----------------------------------------------------
type Want = { kind: 'png' | 'pdf' | 'clipboard'; title: string; toast: (t: string) => void; resolve?: (png: Blob) => void; reject?: (e: Error) => void }
const wants = new Map<string, Want>()

export function exportDrawing(link: DrawLink, kind: Want['kind'], toast: (t: string) => void, dark: boolean): void {
  const CI = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
  if (kind === 'clipboard' && CI && navigator.clipboard?.write) {
    // written INSIDE the click, the picture a promise the browser waits for (as copyFrameImage does): a write after the
    // round trip to the drawing would have lost the click's activation where it lasts no longer than the click (Safari)
    let want!: Want
    const png = new Promise<Blob>((resolve, reject) => { want = { kind, title: link.title, toast, resolve, reject } })
    const timer = setTimeout(() => want.reject?.(new Error('timed out')), 15_000)
    wants.set(link.key, want)
    navigator.clipboard.write([new CI({ 'image/png': png })])
      .then(() => toast('image copied'), () => toast('copy blocked - click the drawing first'))
      .finally(() => clearTimeout(timer))
    drawSend(link, { op: 'export', format: 'png', dark })
    return
  }
  wants.set(link.key, { kind, title: link.title, toast })
  // a PDF starts as the drawing's SVG (printed as vectors by the canvas's server); the rest as its picture
  drawSend(link, { op: 'export', format: kind === 'pdf' && !PUBLISHED ? 'svg' : kind === 'clipboard' ? 'clipboard' : 'png', dark })
  if (kind === 'pdf' && !PUBLISHED) pdfAgain.set(link.key, { link, dark })
}
/** a PDF export that may fall back to the picture: what to ask the drawing for again */
const pdfAgain = new Map<string, { link: DrawLink; dark: boolean }>()

/** A drawing frame's message the shell acts on. Called by App's dispatcher (canvas frames, already authenticated) and
 *  by play's host (its own iframe). Returns true when the message was a drawing's. */
export function drawMessage(key: string, data: any): boolean {
  if (data?.type === 'sh:draw-state') { useDraw.getState().put(key, data as DrawState); return true }
  // ⌥⇧D inside a drawing on the canvas: the drawing frame's theme (D alone stays the diamond in a drawing - Nic, 26 Nov)
  if (data?.type === 'sh:draw-key' && data.key === 'theme') { toggleDrawingTheme(key, 'key'); return true }
  if (data?.type === 'sh:draw-error') {
    useDraw.getState().fail(key, String(data.message ?? 'drawing error'))
    const w = wants.get(key)
    if (w?.reject) { wants.delete(key); w.reject(new Error(String(data.message ?? 'drawing error'))) } else w?.toast(String(data.message ?? 'drawing error'))
    return true
  }
  if (data?.type === 'sh:draw-export') {
    const w = wants.get(key)
    wants.delete(key)
    if (!w) return true
    if (data.ok) { w.toast('image copied'); return true }
    if (w.kind === 'pdf' && typeof data.data === 'string') { void vectorPdf(key, w, data.data); return true }
    const blob: Blob | undefined = data.blob
    if (!blob) return true
    void deliver(w, blob, Number(data.scale) || 3)
    return true
  }
  return false
}

/** The PDF as vectors: the drawing's SVG printed by the canvas's server (Chrome). A canvas that cannot (no Chrome, a
 *  server too old) gets the 3x picture on a page instead - never nothing. */
async function vectorPdf(key: string, w: Want, svg: string): Promise<void> {
  const name = fileName(w.title)
  const again = pdfAgain.get(key)
  pdfAgain.delete(key)
  try {
    const res = await api('draw-pdf', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf() }, body: JSON.stringify({ svg, title: w.title }) })
    if (!res.ok) throw new Error(`print ${res.status}`)
    download(await res.blob(), `${name}.pdf`)
  } catch {
    if (!again) { w.toast('export failed'); return }
    wants.set(key, w)
    drawSend(again.link, { op: 'export', format: 'png', dark: again.dark })
  }
}

const fileName = (title: string) => (title || 'drawing').replace(/[^\w .-]+/g, '').trim() || 'drawing'
const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''

async function deliver(w: Want, png: Blob, scale = 3): Promise<void> {
  const name = fileName(w.title)
  if (w.resolve) { w.resolve(png); return }   // the clipboard write already waits for it (exportDrawing)
  try {
    if (w.kind === 'clipboard') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      w.toast('image copied')
      return
    }
    if (w.kind === 'png') { download(png, `${name}.png`); return }
    // the fallback PDF (a published canvas, a canvas without Chrome): the 3x picture placed at the drawing's own size
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    const img = await doc.embedPng(new Uint8Array(await png.arrayBuffer()))
    const wPt = (img.width / scale) * 0.75, hPt = (img.height / scale) * 0.75   // CSS px to points, as Chrome prints
    doc.addPage([wPt, hPt]).drawImage(img, { x: 0, y: 0, width: wPt, height: hPt })
    download(new Blob([(await doc.save()) as unknown as BlobPart], { type: 'application/pdf' }), `${name}.pdf`)
  } catch (err) {
    w.toast(w.kind === 'clipboard' ? 'copy blocked - click the drawing first' : `export failed: ${(err as Error).message}`)
  }
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** A drawing frame's theme on the canvas, light and dark: its ⋯ menu and ⌥⇧D (play turns the canvas's theme instead). */
export function toggleDrawingTheme(key: string, via: 'click' | 'key'): void {
  const st = useStore.getState()
  const n = st.nodes.find((x) => x.key === key)
  if (!n) return
  cmd('theme', { via, in: 'shell', frames: 1 })
  st.setNodeTheme(key, n.theme === 'dark' ? 'light' : 'dark')
}
