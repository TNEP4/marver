/** The drawing part of a packet is rebuilt from the file, outside the frozen brief. */
import { isDrawAnchor } from '../../shared/anchor.ts'
import type { Thread } from '../comments.ts'
import { ownsMessage } from '../own.ts'
import { drawingThreads, elementWords, readDrawing } from '../draw/comments.ts'
import type { DrawElement } from '../../shared/draw-protocol.ts'
import { sanitize } from './packet.ts'
import type { PacketDraw, PacketMember } from './types.ts'

export function drawingContext(root: string, board: string, thread?: Thread): Pick<PacketMember, 'anchor' | 'draw'> {
  if (!thread) return {}
  const a = thread.anchor
  // The copied anchor of someone else's thread carries identifiers only, including for screens.
  const mine = ownsMessage(root, board, thread.id)
  const anchor = a === undefined ? {} : { anchor: mine ? a : isDrawAnchor(a) ? { el: { draw: 'id' in a.el.draw ? { id: a.el.draw.id } : {} } } : {} }
  if (!thread.frame) return anchor
  let drawing: ReturnType<typeof readDrawing>
  try { drawing = readDrawing(root, thread.frame) } catch { return anchor }
  if (!drawing) return anchor
  const { doc, file } = drawing
  const d = isDrawAnchor(a) ? a.el.draw : undefined
  const e = d && 'id' in d ? doc.elements.get(d.id) : undefined
  const n = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0
  const describe = (e: DrawElement) => ({ id: sanitize(e.id, 256), type: sanitize(e.type, 80), words: sanitize(elementWords(doc, e), 200), box: { x: n(e.x), y: n(e.y), w: n(e.width), h: n(e.height) } })
  const all = [...doc.elements.values()]
  const binding = (x: DrawElement, side: 'startBinding' | 'endBinding') => (x[side] as { elementId?: string } | undefined)?.elementId
  const point = e ? { x: n(e.x) + n(e.width) / 2, y: n(e.y) + n(e.height) / 2 } : d && 'at' in d ? d.at : undefined
  const near = point ? all.filter((x) => x.id !== e?.id).map((x) => ({ x, distance: Math.hypot(n(x.x) + n(x.width) / 2 - point.x, n(x.y) + n(x.height) / 2 - point.y) })).sort((a, b) => a.distance - b.distance).slice(0, 12).map(({ x }) => describe(x)) : []
  const open = drawingThreads(root, thread.frame).flatMap((t) => isDrawAnchor(t.anchor) && 'id' in t.anchor.el.draw ? [{ element: sanitize(t.anchor.el.draw.id, 256), thread: sanitize(t.id, 256), board: sanitize(t.board, 64) }] : [])
  const now = { rev: doc.header.rev, ...(doc.header.epoch ? { epoch: sanitize(doc.header.epoch, 32) } : {}) }
  const draw: PacketDraw = { frame: sanitize(thread.frame, 256), file: sanitize(file, 1024), now, near, open,
    ...(e ? { element: describe(e), neighbours: { incoming: all.filter((x) => x.type === 'arrow' && binding(x, 'endBinding') === e.id).slice(0, 24).map(describe), outgoing: all.filter((x) => x.type === 'arrow' && binding(x, 'startBinding') === e.id).slice(0, 24).map(describe), ...(typeof e.containerId === 'string' && doc.elements.has(e.containerId) ? { shape: describe(doc.elements.get(e.containerId)!) } : {}) } } : d && 'id' in d ? { gone: sanitize(d.id, 256) } : {}),
    ...(d && 'at' in d ? { paper: [d.at.x, d.at.y] as [number, number] } : {}),
    ...(d?.rev !== undefined ? { comment: { rev: d.rev, ...(d.epoch ? { epoch: sanitize(d.epoch, 32) } : {}) } } : {}),
    ...(d?.epoch && d.epoch === doc.header.epoch && d.rev !== undefined && d.rev <= doc.header.rev ? { since: d.rev } : {}),
  }
  return { ...anchor, draw }
}
export function drawingSubject(d: PacketDraw): string {
  const e = d.element
  return `${e ? `element ${e.id} (${e.type}${e.words ? ` ${JSON.stringify(e.words)}` : ''})` : d.gone ? `element gone (${d.gone})` : d.paper ? `paper ${d.paper.join(',')}` : 'the elements'} of drawing ${d.frame}`
}
