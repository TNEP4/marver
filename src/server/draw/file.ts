/**
 * The `.excalidraw` file (spec 38): standard Excalidraw JSON with a `marver` header, written byte-stable so git shows
 * only real changes - 2 spaces, a fixed key order, live elements only, in fractional `index` order, freedraw points
 * rounded to 0.1 px, `appState` reduced to two keys. Pure: no fs.
 */
import { generateKeyBetween } from 'fractional-indexing'
import type { DrawElement, DrawHeader } from '../../shared/draw-protocol.ts'

export interface DrawDoc {
  header: DrawHeader
  /** live elements, keyed by id */
  elements: Map<string, DrawElement>
  files: Record<string, unknown>
  background: string
  /** the file had no `marver.rev` (a round trip through excalidraw.com): merged two-way */
  foreign: boolean
}

export const DEFAULT_SIZE = { w: 960, h: 640 }

export class DrawFileError extends Error {}

export function emptyDoc(header: Partial<DrawHeader> = {}): DrawDoc {
  return { header: { rev: 0, size: { ...DEFAULT_SIZE }, ...header }, elements: new Map(), files: {}, background: '#ffffff', foreign: false }
}

/** Read a file's text. Throws DrawFileError on JSON that is not an Excalidraw scene. */
export function parseDrawFile(text: string): DrawDoc {
  let raw: any
  try { raw = JSON.parse(text) } catch (e) { throw new DrawFileError(`not JSON: ${(e as Error).message}`) }
  if (!raw || typeof raw !== 'object' || (raw.type !== undefined && raw.type !== 'excalidraw') || (raw.elements !== undefined && !Array.isArray(raw.elements))) {
    throw new DrawFileError('not an Excalidraw scene (needs "type": "excalidraw" and an "elements" array)')
  }
  const mv = raw.marver && typeof raw.marver === 'object' ? raw.marver : null
  const header: DrawHeader = { rev: Number.isInteger(mv?.rev) && mv.rev >= 0 ? mv.rev : 0 }
  if (typeof mv?.epoch === 'string' && /^[\w-]{1,64}$/.test(mv.epoch)) header.epoch = mv.epoch
  if (typeof mv?.title === 'string') header.title = mv.title
  if (typeof mv?.description === 'string') header.description = mv.description
  const w = Number(mv?.size?.w), h = Number(mv?.size?.h)
  header.size = Number.isFinite(w) && Number.isFinite(h) && w >= 120 && h >= 80 ? { w: Math.round(w), h: Math.round(h) } : { ...DEFAULT_SIZE }
  const vx = Number(mv?.view?.x), vy = Number(mv?.view?.y), vz = Number(mv?.view?.zoom)
  if (Number.isFinite(vx) && Number.isFinite(vy) && Number.isFinite(vz) && vz > 0) header.view = { x: vx, y: vy, zoom: vz }
  const elements = new Map<string, DrawElement>()
  for (const e of (raw.elements ?? []) as any[]) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || typeof e.type !== 'string') continue
    if (e.isDeleted) continue
    elements.set(e.id, e as DrawElement)
  }
  return {
    header, elements,
    files: raw.files && typeof raw.files === 'object' ? raw.files : {},
    background: typeof raw.appState?.viewBackgroundColor === 'string' ? raw.appState.viewBackgroundColor : '#ffffff',
    foreign: !mv || !Number.isInteger(mv.rev),
  }
}

/** Elements in Excalidraw's own order: fractional `index`, then id (a stable tie-break). */
export function ordered(elements: Iterable<DrawElement>): DrawElement[] {
  return [...elements].sort((a, b) => {
    const ia = a.index ?? '', ib = b.index ?? ''
    return ia < ib ? -1 : ia > ib ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

// the keys Excalidraw writes first, in its own order; anything else follows, sorted
const KEY_ORDER = ['id', 'type', 'x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth',
  'strokeStyle', 'roughness', 'opacity', 'groupIds', 'frameId', 'index', 'roundness', 'seed', 'version', 'versionNonce', 'isDeleted',
  'boundElements', 'updated', 'link', 'locked']

function orderKeys(el: DrawElement): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of KEY_ORDER) if (k in el) out[k] = el[k]
  for (const k of Object.keys(el).filter((k) => !KEY_ORDER.includes(k)).sort()) out[k] = el[k]
  if (el.type === 'freedraw' && Array.isArray(el.points)) out.points = (el.points as number[][]).map((p) => [r1(p[0]), r1(p[1])])
  return out
}
const r1 = (n: number) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : 0)

/** The file's text - byte-stable for the same document. */
export function serializeDrawFile(doc: DrawDoc): string {
  const h: Record<string, unknown> = { rev: doc.header.rev }
  if (doc.header.epoch) h.epoch = doc.header.epoch
  if (doc.header.title) h.title = doc.header.title
  if (doc.header.description) h.description = doc.header.description
  h.size = doc.header.size ?? DEFAULT_SIZE
  if (doc.header.view) h.view = { x: r1(doc.header.view.x), y: r1(doc.header.view.y), zoom: Math.round(doc.header.view.zoom * 1000) / 1000 }
  const file = {
    type: 'excalidraw', version: 2, source: 'marver',
    marver: h,
    elements: ordered(doc.elements.values()).map(orderKeys),
    appState: { viewBackgroundColor: doc.background || '#ffffff', gridSize: null },
    files: doc.files ?? {},
  }
  return JSON.stringify(file, null, 2) + '\n'
}

// ---- elements an agent wrote by hand: made whole ------------------------------------------------------------------

const rand = () => Math.floor(Math.random() * 2 ** 31)
const BASE: Record<string, unknown> = {
  angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
  roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, boundElements: null, link: null, locked: false,
}

/** A text's box from its words, a little generous: the hand-drawn fonts run ~0.5-0.55 em a glyph, and a box too wide
 *  only pads the selection where one too narrow cuts the words off. The draw host measures exactly when it loads. */
export function textBox(text: string, fontSize: number, lineHeight = 1.25): { w: number; h: number } {
  const lines = text.split('\n')
  const longest = Math.max(1, ...lines.map((l) => [...l].length))
  return { w: Math.ceil(longest * fontSize * 0.62), h: Math.ceil(lines.length * fontSize * lineHeight) }
}

/** An element as an agent may write it (id, type, x, y, width, height, text…) made whole: Excalidraw's defaults, a seed,
 *  a version. `index` is given by `assignIndexes`. Elements already whole keep every field. */
export function wholeElement(raw: Record<string, unknown>, by: string, now = Date.now()): DrawElement {
  const type = String(raw.type ?? 'rectangle')
  const el: Record<string, unknown> = { ...BASE, ...raw, type }
  if (typeof el.id !== 'string' || !el.id) el.id = `mv-${Math.random().toString(36).slice(2, 12)}`
  for (const k of ['x', 'y']) el[k] = Number.isFinite(Number(el[k])) ? Number(el[k]) : 0
  if (type === 'text') {
    // an agent's text with no box: sized from its words (Excalidraw clips a text to its box when it loads a file)
    const est = textBox(String(raw.text ?? raw.originalText ?? ''), Number(raw.fontSize) || 20, Number(raw.lineHeight) || 1.25)
    if (!Number.isFinite(Number(el.width))) el.width = est.w
    if (!Number.isFinite(Number(el.height))) el.height = est.h
  }
  if (!Number.isFinite(Number(el.width))) el.width = 160
  if (!Number.isFinite(Number(el.height))) el.height = 80
  el.width = Number(el.width); el.height = Number(el.height)
  if (!Number.isInteger(el.seed)) el.seed = rand()
  if (!Number.isInteger(el.version) || (el.version as number) < 1) el.version = 1
  if (!Number.isInteger(el.versionNonce)) el.versionNonce = rand()
  el.isDeleted = false
  el.updated = now
  if (type === 'rectangle' || type === 'diamond') { if (raw.roundness === undefined) el.roundness = { type: 3 } }
  if (type === 'arrow' || type === 'line') {
    if (!Array.isArray(el.points)) el.points = [[0, 0], [el.width, el.height]]
    if (type === 'arrow') {
      if (el.startArrowhead === undefined) el.startArrowhead = null
      if (el.endArrowhead === undefined) el.endArrowhead = 'arrow'
      if (raw.roundness === undefined) el.roundness = { type: 2 }
      if (el.elbowed === undefined) el.elbowed = false
    }
    if (el.lastCommittedPoint === undefined) el.lastCommittedPoint = null
    for (const k of ['startBinding', 'endBinding']) if (el[k] === undefined) el[k] = null
  }
  if (type === 'freedraw') {
    if (!Array.isArray(el.points)) el.points = []
    if (!Array.isArray(el.pressures)) el.pressures = []
    if (el.simulatePressure === undefined) el.simulatePressure = true
    if (el.lastCommittedPoint === undefined) el.lastCommittedPoint = null
  }
  if (type === 'text') {
    const text = String(el.text ?? el.originalText ?? '')
    el.text = text
    if (typeof el.originalText !== 'string') el.originalText = text
    if (!Number.isFinite(Number(el.fontSize))) el.fontSize = 20
    if (!Number.isFinite(Number(el.fontFamily))) el.fontFamily = 5
    // a label inside a shape (containerId) sits in its middle, as Excalidraw puts one - a free text at its top left
    const inShape = typeof el.containerId === 'string' && !!el.containerId
    if (typeof el.textAlign !== 'string') el.textAlign = inShape ? 'center' : 'left'
    if (typeof el.verticalAlign !== 'string') el.verticalAlign = inShape ? 'middle' : 'top'
    if (el.containerId === undefined) el.containerId = null
    if (el.autoResize === undefined) el.autoResize = true
    if (!Number.isFinite(Number(el.lineHeight))) el.lineHeight = 1.25
  }
  const cd = (el.customData && typeof el.customData === 'object' ? el.customData : {}) as Record<string, unknown>
  el.customData = { ...cd, mv: { by, at: now } }
  return el as DrawElement
}

/** Give every element without a valid index one, after the highest index in use - Excalidraw's own scheme. */
export function assignIndexes(all: Map<string, DrawElement>, fresh: DrawElement[]): void {
  // indexes in use: every element already there, and every fresh one that keeps its own (valid and not taken)
  const used = new Set<string>()
  for (const e of all.values()) if (!fresh.includes(e) && typeof e.index === 'string' && validIndex(e.index)) used.add(e.index)
  const keep = new Set<DrawElement>()
  for (const e of fresh) if (typeof e.index === 'string' && validIndex(e.index) && !used.has(e.index)) { used.add(e.index); keep.add(e) }
  let last: string | null = null
  for (const i of used) if (last === null || i > last) last = i
  for (const e of fresh) {
    if (keep.has(e)) continue
    last = generateKeyBetween(last, null)
    e.index = last
  }
}
const validIndex = (s: string) => /^[a-zA-Z][0-9a-zA-Z]*$/.test(s)

/** Two element versions with the same content (ignoring the bookkeeping fields a merge rewrites). */
export function sameContent(a: DrawElement | undefined, b: DrawElement | undefined): boolean {
  if (!a || !b) return a === b
  return contentKey(a) === contentKey(b)
}
const SKIP = new Set(['version', 'versionNonce', 'updated', 'isDeleted'])
export function contentKey(e: DrawElement): string {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(e).sort()) {
    if (SKIP.has(k)) continue
    if (k === 'customData') {
      const { mv: _mv, ...rest } = (e.customData ?? {}) as Record<string, unknown>
      if (Object.keys(rest).length) out.customData = rest
      continue
    }
    out[k] = e.type === 'freedraw' && k === 'points' && Array.isArray(e.points) ? (e.points as number[][]).map((p) => [r1(p[0]), r1(p[1])]) : e[k]
  }
  return JSON.stringify(out)
}
