/**
 * The shell's side of a drawing frame (spec 38): the state each open drawing reports (`sh:draw-state`), the commands
 * the bar and panel send it (`sh:draw-cmd`), and what comes back from an export. One store for the canvas's frames
 * (keyed by node key) and play's (keyed `play:<frame>`).
 */
import { toggleCommentMode, toggleLaserComment, togglePins } from '../comment-keys.ts'
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
type Want = { kind: 'png' | 'pdf' | 'clipboard'; key: string; title: string; toast: (t: string) => void; resolve?: (png: Blob) => void; reject?: (e: Error) => void }
/** every export in flight, by its request id (the drawing echoes it): two at once never take each other's answer */
const wants = new Map<string, Want>()
let ridN = 0
const nextRid = (key: string) => `${key}#${++ridN}`
/** the answer's request: exactly its id (and its frame) when it carries one - a late answer to a request that timed
 *  out claims nothing; a drawing that sends no id (older) - the oldest of its frame's */
const wantFor = (key: string, rid: unknown): [string, Want] | undefined => {
  if (typeof rid === 'string') { const w = wants.get(rid); return w && w.key === key ? [rid, w] : undefined }
  for (const e of wants) if (e[1].key === key) return e
  return undefined
}

export function exportDrawing(link: DrawLink, kind: Want['kind'], toast: (t: string) => void, dark: boolean): void {
  const CI = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
  if (kind === 'clipboard' && CI && navigator.clipboard?.write) {
    // written INSIDE the click, the picture a promise the browser waits for (as copyFrameImage does): a write after the
    // round trip to the drawing would have lost the click's activation where it lasts no longer than the click (Safari)
    let want!: Want
    const png = new Promise<Blob>((resolve, reject) => { want = { kind, key: link.key, title: link.title, toast, resolve, reject } })
    const rid = nextRid(link.key)
    const timer = setTimeout(() => { wants.delete(rid); want.reject?.(new Error('timed out')) }, 15_000)
    wants.set(rid, want)
    navigator.clipboard.write([new CI({ 'image/png': png })])
      .then(() => toast('image copied'), () => toast('copy blocked - click the drawing first'))
      .finally(() => clearTimeout(timer))
    drawSend(link, { op: 'export', format: 'png', dark, rid })
    return
  }
  const rid = nextRid(link.key)
  wants.set(rid, { kind, key: link.key, title: link.title, toast })
  // a PDF starts as the drawing's SVG (printed as vectors by the canvas's server); the rest as its picture
  if (kind === 'pdf' && !PUBLISHED) pdfAgain.set(rid, { link, dark })
  drawSend(link, { op: 'export', format: kind === 'pdf' && !PUBLISHED ? 'svg' : kind === 'clipboard' ? 'clipboard' : 'png', dark, rid })
}
/** a PDF export that may fall back to the picture: what to ask the drawing for again */
const pdfAgain = new Map<string, { link: DrawLink; dark: boolean }>()

/** A drawing frame's message the shell acts on. Called by App's dispatcher (canvas frames, already authenticated) and
 *  by play's host (its own iframe). Returns true when the message was a drawing's. */
export function drawMessage(key: string, data: any): boolean {
  if (data?.type === 'sh:draw-state') { useDraw.getState().put(key, data as DrawState); return true }
  // ⌥⇧D inside a drawing on the canvas: the drawing frame's theme (D alone stays the diamond in a drawing - Nic, 26 Nov)
  if (data?.type === 'sh:draw-key' && data.key === 'theme') { toggleDrawingTheme(key, 'key'); return true }
  // C, ⇧C, ⇧L from inside a drawing (spec 39 B4): the shell's comment keys, the same rules as everywhere
  if (data?.type === 'sh:draw-key' && (data.key === 'comments' || data.key === 'pins' || data.key === 'laser-comment')) {
    const how = { via: 'key' as const, in: 'frame' as const, keys: data.key === 'comments' ? 'c' : data.key === 'pins' ? '⇧c' : '⇧l' }
    if (data.key === 'comments') toggleCommentMode(how); else if (data.key === 'pins') togglePins(how); else toggleLaserComment(how)
    return true
  }
  if (data?.type === 'sh:draw-error') {
    useDraw.getState().fail(key, String(data.message ?? 'drawing error'))
    const hit = data.rid ? wantFor(key, data.rid) : undefined
    if (hit) { wants.delete(hit[0]); pdfAgain.delete(hit[0]); if (hit[1].reject) hit[1].reject(new Error(String(data.message ?? 'drawing error'))); else hit[1].toast(String(data.message ?? 'drawing error')) }
    return true
  }
  if (data?.type === 'sh:draw-export') {
    const hit = wantFor(key, data.rid)
    if (!hit) return true
    const [rid, w] = hit
    wants.delete(rid)
    if (data.ok) { w.toast('image copied'); return true }
    if (w.kind === 'pdf' && typeof data.data === 'string') { void vectorPdf(rid, w, data.data); return true }
    const blob: Blob | undefined = data.blob
    if (!blob) return true
    void deliver(w, blob, Number(data.scale) || 3)
    return true
  }
  return false
}

/** The PDF as vectors: the drawing's SVG printed by the canvas's server (Chrome). A canvas that cannot (no Chrome, a
 *  server too old) gets the 3x picture on a page instead - never nothing. */
async function vectorPdf(rid: string, w: Want, svg: string): Promise<void> {
  const name = fileName(w.title)
  const again = pdfAgain.get(rid)
  pdfAgain.delete(rid)
  try {
    const res = await api('draw-pdf', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf() }, body: JSON.stringify({ svg, title: w.title }) })
    if (!res.ok) throw new Error(`print ${res.status}`)
    download(await res.blob(), `${name}.pdf`)
  } catch {
    if (!again) { w.toast('export failed'); return }
    const next = nextRid(w.key)
    wants.set(next, w)
    drawSend(again.link, { op: 'export', format: 'png', dark: again.dark, rid: next })
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
