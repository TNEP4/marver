/** Drawing comment context always comes from the document by exact id, never the anchor's words. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanFrames } from '../manifest.ts'
import { listBoards, readLog, replay, type Thread } from '../comments.ts'
import { isDrawAnchor, validDrawAnchor, type Anchor, type AnchorCheck, type AnchorLook, type AnchorTarget } from '../../shared/anchor.ts'
import type { DrawElement } from '../../shared/draw-protocol.ts'
import { drawHash, drawLogKey } from './history.ts'
import { parseDrawFile, type DrawDoc } from './file.ts'

export function drawingFile(root: string, frame: string): string | undefined {
  return scanFrames(root).frames.find((f) => f.id === frame && f.kind === 'draw')?.file
}
export function readDrawing(root: string, frame: string): { file: string; doc: DrawDoc } | undefined {
  const file = drawingFile(root, frame)
  if (!file) return undefined
  const text = readFileSync(join(root, file), 'utf8'), doc = parseDrawFile(text)
  // Raw edits may keep their exact bytes so an agent's next Edit still applies. The service's
  // hash-checked disk mapping names the revision those bytes represent, including its epoch.
  try {
    const disk = JSON.parse(readFileSync(join(root, 'design/.local/draw', `${drawLogKey(frame)}.disk.json`), 'utf8'))
    if (disk.hash === drawHash(text) && Number.isSafeInteger(disk.rev) && disk.rev >= doc.header.rev && typeof disk.epoch === 'string') doc.header = { ...doc.header, rev: disk.rev, epoch: disk.epoch }
  } catch { /* not yet registered, or no retained raw edit */ }
  return { file, doc }
}
export function drawingThreads(root: string, frame: string): (Thread & { board: string })[] {
  const dir = join(root, 'design', 'comments')
  return listBoards(dir).flatMap((board) => replay(readLog(dir, board)).filter((t) => !t.resolved && t.frame === frame && isDrawAnchor(t.anchor)).map((t) => ({ ...t, board })))
}
export function elementWords(doc: DrawDoc, e: DrawElement): string {
  if (e.type === 'text') return String(e.text ?? '')
  const label = (e.boundElements as { id: string; type: string }[] | undefined)?.find((b) => b.type === 'text')
  const text = label ? doc.elements.get(label.id) : [...doc.elements.values()].find((t) => t.containerId === e.id && t.type === 'text')
  return text ? String(text.text ?? '') : ''
}
export function targetOnFrame(draw: boolean, target: AnchorTarget, look: AnchorLook = {}): void {
  if (draw && (target.on !== undefined || target.at !== undefined || target.nth !== undefined || look.viewport !== undefined || look.theme !== undefined)) throw new Error('On a drawing use --element <id> or --paper x,y; --on, --at, --nth, --viewport and --theme are for screens.')
  if (!draw && (target.element !== undefined || target.paper !== undefined)) throw new Error('A screen cannot take --element or --paper; use --on or --at.')
}
export function checkDrawingAnchor(doc: DrawDoc, target: AnchorTarget, others: { key: string; anchor: unknown }[] = []): AnchorCheck {
  const d = target.paper ? { at: { x: target.paper[0], y: target.paper[1] } } : undefined
  const e = target.element === undefined ? undefined : doc.elements.get(target.element)
  if (!d && !e) return { ok: false, refused: 'none', visible: [...doc.elements.keys()].slice(0, 30), viewport: 'drawing', theme: 'drawing' }
  const rev = { rev: doc.header.rev, ...(doc.header.epoch ? { epoch: doc.header.epoch } : {}) }
  const words = e ? elementWords(doc, e).slice(0, 200) : ''
  const anchor: Anchor = { el: { draw: d ? { ...d, ...rev } : { id: e!.id, type: e!.type as any, ...(words ? { label: words } : {}), ...rev }, semantics: { tag: `excalidraw:${e?.type ?? 'paper'}`, ...(words ? { quote: words } : {}) }, hue: 210 } }
  if (!validDrawAnchor(anchor)) throw new Error('--element: this element has an unusual id or type; ids must be non-empty, at most 256 characters, with no control characters')
  const holders = others.filter(({ anchor: a }) => {
    if (!isDrawAnchor(a)) return false
    const at = a.el.draw
    return e ? 'id' in at && at.id === e.id : 'at' in at && at.at.x === d!.at.x && at.at.y === d!.at.y
  }).map((a) => a.key)
  return { ok: true, anchor, holders, viewport: 'drawing', theme: 'drawing' }
}
export function anchorDescription(root: string, frame: string | undefined, anchor: unknown): string {
  if (!anchor) return ''
  if (isDrawAnchor(anchor)) {
    const d = anchor.el.draw
    if ('at' in d) return `paper ${d.at.x},${d.at.y}`
    let doc: DrawDoc | undefined
    try { doc = frame ? readDrawing(root, frame)?.doc : undefined } catch { /* missing or invalid file */ }
    const e = doc?.elements.get(d.id)
    if (!e) return `element gone (${d.id})`
    const words = elementWords(doc!, e).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 200)
    return `element ${e.id} (${e.type}${words ? ` ${JSON.stringify(words)}` : ''})`
  }
  const a = anchor as Anchor
  const s = a.el?.semantics
  return [s?.tag, s?.quote ? JSON.stringify(s.quote) : '', s?.testId ? `[data-testid=${JSON.stringify(s.testId)}]` : '', a.el?.at || a.el?.cssPath || ''].filter(Boolean).join(' · ') || 'frame anchor'
}

/** JSON listings retain attachment/revision data, but never present an anchor's stale or supplied label as document text. */
export function listedAnchor(root: string, frame: string | undefined, anchor: unknown): unknown {
  if (!isDrawAnchor(anchor)) return anchor
  const d = anchor.el.draw
  const { rev, epoch } = d
  const revision = { ...(rev !== undefined ? { rev } : {}), ...(epoch !== undefined ? { epoch } : {}) }
  if ('at' in d) return { ...anchor, el: { draw: { at: d.at, ...revision }, semantics: { tag: 'excalidraw:paper' } } }
  let doc: DrawDoc | undefined
  try { doc = frame ? readDrawing(root, frame)?.doc : undefined } catch { /* missing file */ }
  const e = doc?.elements.get(d.id)
  const words = e ? elementWords(doc!, e).slice(0, 200) : 'element gone'
  return { ...anchor, el: { draw: { id: d.id, ...(e ? { type: e.type, label: words } : {}), ...revision }, semantics: { ...(e ? { tag: `excalidraw:${e.type}` } : {}), quote: words } } }
}
