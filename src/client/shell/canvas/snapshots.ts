/**
 * Stage 2 shell-side snapshot cache + capture coordinator. Imperative on purpose - the facade
 * <img> is driven by setting .src directly, so no FrameNode subscribes to snapshot state and a
 * pan/zoom tick triggers zero React renders.
 *
 * First slice = snapshot-during-gesture: keep the most-recent snapshots (bounded by a decoded-byte
 * budget, LRU-evicted), show the one over the iframe while #sh-world is in motion (CSS), and
 * crossfade back on settle. Captures run one-at-a-time at idle, requested when a frame is
 * ready/quiet - NEVER while the canvas is in motion (rasterizing then would jank the very window
 * this protects).
 */

export interface SnapMeta { sourceRevision: string; width: number; height: number; theme: string }

interface Entry { key: string; url: string; bytes: number }
const byNode = new Map<string, Entry>()                 // nodeKey -> current snapshot (Map order = recency)
const imgs = new Map<string, HTMLImageElement>()        // nodeKey -> the facade <img> element

const BUDGET = 96 * 1024 * 1024                          // P1: bound decoded bitmap memory (~96 MiB)
let totalBytes = 0
const bytesOf = (m: SnapMeta) => Math.round(m.width) * Math.round(m.height) * 4 * 1.5 * 1.5   // rgba x dpr^2

const keyOf = (m: SnapMeta) => `${m.sourceRevision}|${Math.round(m.width)}x${Math.round(m.height)}|${m.theme}`

const inMotion = (): boolean => {
  const w = document.getElementById('sh-world')
  return !!w && (w.classList.contains('sh-gesturing') || w.classList.contains('sh-preset'))
}

const setImg = (img: HTMLImageElement, url: string) => {
  delete img.dataset.ready
  img.onload = () => { img.dataset.ready = '1' }   // CSS only shows a snapshot that has decoded
  img.src = url
}
const clearImg = (nodeKey: string) => {
  const img = imgs.get(nodeKey)
  if (img) { delete img.dataset.ready; img.removeAttribute('src') }
}

/** FrameNode registers its facade <img> on mount so the coordinator can update it imperatively. */
export function registerSnapshotImg(nodeKey: string, img: HTMLImageElement | null): void {
  if (!img) { imgs.delete(nodeKey); return }
  imgs.set(nodeKey, img)
  const e = byNode.get(nodeKey)
  if (e) setImg(img, e.url)
}

/** P1: evict least-recently-stored snapshots (revoking their URLs) until under the byte budget. */
function evict(keep: string): void {
  for (const [k, e] of byNode) {
    if (totalBytes <= BUDGET) break
    if (k === keep) continue
    URL.revokeObjectURL(e.url); totalBytes -= e.bytes; byNode.delete(k); clearImg(k)
  }
}

function storeSnapshot(nodeKey: string, meta: SnapMeta, blob: Blob): void {
  const prev = byNode.get(nodeKey)
  if (prev) { URL.revokeObjectURL(prev.url); totalBytes -= prev.bytes; byNode.delete(nodeKey) }
  const url = URL.createObjectURL(blob)
  const bytes = bytesOf(meta)
  byNode.set(nodeKey, { key: keyOf(meta), url, bytes })   // re-inserted at the end = most recent
  totalBytes += bytes
  evict(nodeKey)
  const img = imgs.get(nodeKey)
  if (img) setImg(img, url)
}

/** Drop a node's snapshot (node removed, or its content changed and the old picture is now wrong). */
export function dropSnapshot(nodeKey: string): void {
  const e = byNode.get(nodeKey)
  if (e) { URL.revokeObjectURL(e.url); totalBytes -= e.bytes }
  byNode.delete(nodeKey)
  clearImg(nodeKey)
}

// ---- capture coordinator: single-in-flight, idle-scheduled, never during motion ----
let reqSeq = 0
let capturing = false
const inflight = new Map<number, string>()             // requestId -> nodeKey (the ONLY valid ids)
const finishers = new Map<number, () => void>()
const pending: Array<{ nodeKey: string; iframe: HTMLIFrameElement; meta: SnapMeta }> = []
const idle = (fn: () => void) =>
  (window as unknown as { requestIdleCallback?: (f: () => void, o?: object) => void }).requestIdleCallback?.(fn, { timeout: 600 }) ?? setTimeout(fn, 80)

/** Request a fresh snapshot for a ready/quiet frame. Coalesces to the latest per node. */
export function scheduleCapture(nodeKey: string, iframe: HTMLIFrameElement, meta: SnapMeta): void {
  if (byNode.get(nodeKey)?.key === keyOf(meta)) return   // already have this exact snapshot
  const i = pending.findIndex((p) => p.nodeKey === nodeKey)
  if (i >= 0) pending[i] = { nodeKey, iframe, meta }
  else pending.push({ nodeKey, iframe, meta })
  pump()
}

function pump(): void {
  if (capturing || !pending.length) return
  if (inMotion()) { idle(pump); return }   // P1: never rasterize while the canvas is in motion
  capturing = true
  const { nodeKey, iframe, meta } = pending.shift()!
  const requestId = ++reqSeq
  inflight.set(requestId, nodeKey)
  // idempotent finish: whichever of {result, error, timeout} lands first wins; the rest no-op
  const done = () => {
    if (!inflight.has(requestId)) return
    inflight.delete(requestId); finishers.delete(requestId)
    capturing = false; idle(pump)
  }
  const timer = setTimeout(done, 6000)
  finishers.set(requestId, () => { clearTimeout(timer); done() })
  iframe.contentWindow?.postMessage({
    type: 'sh:snapshot-request', requestId, nodeKey,
    sourceRevision: meta.sourceRevision, width: meta.width, height: meta.height, theme: meta.theme, dprBucket: 1,
  }, location.origin)
}

/** App routes sh:snapshot-result / sh:snapshot-error here (source already validated). */
export function onSnapshotMessage(msg: { type: string; requestId?: number; nodeKey?: string; sourceRevision?: string; width?: number; height?: number; theme?: string; blob?: unknown }): void {
  const requestId = msg.requestId
  if (typeof requestId !== 'number' || !inflight.has(requestId)) return   // P2: expired/unknown -> ignore the late blob
  if (msg.type === 'sh:snapshot-result' && msg.nodeKey && msg.blob instanceof Blob) {
    storeSnapshot(msg.nodeKey, { sourceRevision: String(msg.sourceRevision ?? ''), width: Number(msg.width), height: Number(msg.height), theme: String(msg.theme ?? '') }, msg.blob)
  }
  finishers.get(requestId)?.()   // clear the timer + free the slot (result OR error)
}
