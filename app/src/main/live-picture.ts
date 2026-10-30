/**
 * Live pictures, main's half (spec 28 A4.6 #31-#35, r1 #5). Owner: the live pictures stream.
 *
 * The bridge hands an accepted `mv:capture` here (`onCapture`): the tab and admitted document that asked, the rect in
 * whole CSS px inside the view, and `still()`, the bridge's admission of that sender and document run again. A canvas
 * may read its own view's pixels - never the strip's, another tab's or the screen's, so no Screen Recording - and only
 * while the person sees them: the tab is the active one with a live document, the window visible and not minimised,
 * its content view visible and no tab page over it; else `hidden`. Main notes the document (`doc`, `commits`) and the
 * view's presentation `gen` (A3.8 #27), then reads back `rect x zoom` with `capturePage` - one at a time per
 * webContents (`busy`), `BOUNDS.captureMs` its deadline (`timeout`), the slot held until the readback settles, so
 * captures never pile up (A3.8 #15). After the readback everything is checked again - `still()`, the document's trust
 * (a revoke at a stop or a rebind keeps the document id), the same tab active with a live document, the same document
 * and gen, the window and the view as before; else `stale` - and an empty image is `empty`. No resampling but down to
 * a `BOUNDS.captureLong` long side; Electron 45's `capturePage()` gives device pixels, so `getSize()` is the PNG's size
 * (A4.6 #1: read again at any upgrade). Main writes nothing to disk: the page uploads what it gets.
 *
 * No Electron import: main.ts passes the ports (tabs.ts, window.ts, present.ts), so the rules are unit-tested.
 */
import { BOUNDS, type CaptureAnswer, type CaptureRect, type CaptureWhy } from '../../../src/shared/app-api.ts'
import type { CaptureHandler } from './bridge.ts'
import { note } from './testing/index.ts'

/** A readback, as much of Electron's `NativeImage` as is used here. */
export interface PictureImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(o: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): PictureImage
  toPNG(): Uint8Array
}
/** The canvas view's webContents, as much as is used here. */
export interface PictureContents {
  id: number
  getZoomFactor(): number
  capturePage(rect: CaptureRect): Promise<PictureImage>
}

/** What main knows of a tab now. */
export interface PictureLook {
  wc: PictureContents
  /** it is `activeTab()` */
  active: boolean
  /** `liveDoc(t)`: a local canvas whose live view holds its document */
  live: boolean
  /** `t.doc.trusted` */
  trusted: boolean
  /** `t.doc.doc` and `t.doc.commits`: the document */
  doc?: string
  commits: number
  /** present.ts `genOf(tab)`: what was presented no longer counts once it moves */
  gen: number
  /** the window visible and not minimised */
  windowShown: boolean
  /** its content view visible, and no tab page over it */
  viewShown: boolean
}

export interface LivePicturePorts {
  /** the tab now, or null when it has no content view */
  look(tabId: string): PictureLook | null
  /** the readback's deadline (`BOUNDS.captureMs`; shorter in tests) */
  deadlineMs?: number
}

const shown = (a: PictureLook) => a.active && a.live && a.windowShown && a.viewShown
const j = (data: Record<string, unknown>) => { if (__MV_TEST__) note('live-picture', data) }

/** The webContents with a readback outstanding: one at a time each. */
const reading = new Set<number>()

/** main's `mv:capture` handler, for `bridge.onCapture` (main.ts). */
export function livePictures(p: LivePicturePorts): CaptureHandler {
  return async (tabId, doc, rect, still) => {
    const no = (why: CaptureWhy): CaptureAnswer => { j({ tab: tabId, why }); return { ok: false, why } }
    const a = p.look(tabId)
    if (!a || !shown(a)) return no('hidden')
    if (a.doc !== doc) return no('stale')
    const id = a.wc.id
    if (reading.has(id)) return no('busy')
    const was = { doc: a.doc, commits: a.commits, gen: a.gen }
    // the rect in the view's own px, rounded out: its CSS px times the page's zoom
    const z = a.wc.getZoomFactor() || 1
    const x = Math.floor(rect.x * z), y = Math.floor(rect.y * z)
    const at = { x, y, width: Math.ceil((rect.x + rect.width) * z) - x, height: Math.ceil((rect.y + rect.height) * z) - y }
    reading.add(id)
    // the readback's start and its settling journaled, beside the white-out detector's own (#52's pw case)
    j({ tab: tabId, read: 'start' })
    let read: Promise<PictureImage | null>
    try { read = a.wc.capturePage(at).then((img) => img, () => null) } catch { read = Promise.resolve(null) }
    read = read.finally(() => { reading.delete(id); j({ tab: tabId, read: 'end' }) })
    let timer: ReturnType<typeof setTimeout> | undefined
    const img = await Promise.race([read, new Promise<'late'>((done) => { timer = setTimeout(() => done('late'), p.deadlineMs ?? BOUNDS.captureMs) })])
    clearTimeout(timer)
    if (img === 'late') return no('timeout')
    // after the readback, everything it was taken under, again (A4.6 r1 #5)
    const b = p.look(tabId)
    if (!still() || !b || !b.trusted || !shown(b) || b.doc !== was.doc || b.commits !== was.commits || b.gen !== was.gen) return no('stale')
    if (!img || img.isEmpty()) return no('empty')
    let pic = img
    const size = pic.getSize()
    const long = Math.max(size.width, size.height)
    if (long > BOUNDS.captureLong) {
      const k = BOUNDS.captureLong / long
      pic = pic.resize({ width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)), quality: 'best' })
    }
    const out = pic.getSize()
    const png = new Uint8Array(pic.toPNG())
    j({ tab: tabId, ok: true, rect: at, width: out.width, height: out.height, bytes: png.length })
    return { ok: true, png, width: out.width, height: out.height }
  }
}
