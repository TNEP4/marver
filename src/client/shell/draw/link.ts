/**
 * The shell's side of a drawing frame (spec 38): the state each open drawing reports (`sh:draw-state`), the commands
 * the bar and panel send it (`sh:draw-cmd`), and what comes back from an export. One store for the canvas's frames
 * (keyed by node key) and play's (keyed `play:<frame>`).
 */
import { create } from 'zustand'
import type { DrawCmd, DrawState } from '../../../shared/draw-protocol.ts'

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

export function send(link: DrawLink, cmd: Cmd): void {
  try { link.win()?.postMessage({ type: 'sh:draw-cmd', ...cmd }, location.origin) } catch { /* the frame is going away */ }
}

// ---- exports: the host renders, the shell saves or copies ----------------------------------------------------
type Want = { kind: 'png' | 'pdf' | 'clipboard'; title: string; toast: (t: string) => void }
const wants = new Map<string, Want>()

export function exportDrawing(link: DrawLink, kind: Want['kind'], toast: (t: string) => void, dark: boolean): void {
  wants.set(link.key, { kind, title: link.title, toast })
  send(link, { op: 'export', format: kind === 'clipboard' ? 'clipboard' : 'png', dark })
}

/** A drawing frame's message the shell acts on. Called by App's dispatcher (canvas frames, already authenticated) and
 *  by play's host (its own iframe). Returns true when the message was a drawing's. */
export function drawMessage(key: string, data: any): boolean {
  if (data?.type === 'sh:draw-state') { useDraw.getState().put(key, data as DrawState); return true }
  if (data?.type === 'sh:draw-error') { useDraw.getState().fail(key, String(data.message ?? 'drawing error')); wants.get(key)?.toast(String(data.message ?? 'drawing error')); return true }
  if (data?.type === 'sh:draw-export') {
    const w = wants.get(key)
    wants.delete(key)
    if (!w) return true
    if (data.ok) { w.toast('image copied'); return true }
    const blob: Blob | undefined = data.blob
    if (!blob) return true
    void deliver(w, blob)
    return true
  }
  return false
}

async function deliver(w: Want, png: Blob): Promise<void> {
  const name = (w.title || 'drawing').replace(/[^\w .-]+/g, '').trim() || 'drawing'
  try {
    if (w.kind === 'clipboard') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      w.toast('image copied')
      return
    }
    if (w.kind === 'png') { download(png, `${name}.png`); return }
    // a one-page PDF of the drawing: the PNG (2x) placed at its natural size
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    const img = await doc.embedPng(new Uint8Array(await png.arrayBuffer()))
    const wPt = img.width / 2, hPt = img.height / 2
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
