/**
 * Stage 2 shell-side snapshot cache + capture coordinator. Imperative on purpose - the facade
 * <img> is driven by setting .src directly, so no FrameNode subscribes to snapshot state and a
 * pan/zoom tick triggers zero React renders.
 *
 * First slice = snapshot-during-gesture: keep ONE latest snapshot per node (its current
 * width/height/theme/revision), show it over the iframe while #sh-world.sh-gesturing is set
 * (CSS), and crossfade back on settle. Captures run one-at-a-time at idle, requested when a
 * frame is ready/quiet - never during a gesture.
 */

export interface SnapMeta { sourceRevision: string; width: number; height: number; theme: string }

interface Entry { key: string; url: string }
const byNode = new Map<string, Entry>()                 // nodeKey -> current snapshot (object URL)
const imgs = new Map<string, HTMLImageElement>()        // nodeKey -> the facade <img> element

const keyOf = (m: SnapMeta) => `${m.sourceRevision}|${Math.round(m.width)}x${Math.round(m.height)}|${m.theme}`

const setImg = (img: HTMLImageElement, url: string) => {
  delete img.dataset.ready
  img.onload = () => { img.dataset.ready = '1' }   // CSS only shows a snapshot that has decoded
  img.src = url
}

/** FrameNode registers its facade <img> on mount so the coordinator can update it imperatively. */
export function registerSnapshotImg(nodeKey: string, img: HTMLImageElement | null): void {
  if (!img) { imgs.delete(nodeKey); return }
  imgs.set(nodeKey, img)
  const e = byNode.get(nodeKey)
  if (e) setImg(img, e.url)
}

function storeSnapshot(nodeKey: string, meta: SnapMeta, blob: Blob): void {
  const prev = byNode.get(nodeKey)
  if (prev) URL.revokeObjectURL(prev.url)
  const url = URL.createObjectURL(blob)
  byNode.set(nodeKey, { key: keyOf(meta), url })
  const img = imgs.get(nodeKey)
  if (img) setImg(img, url)
}

/** Drop a node's snapshot (node removed, or its content changed and the old picture is now wrong). */
export function dropSnapshot(nodeKey: string): void {
  const e = byNode.get(nodeKey)
  if (e) URL.revokeObjectURL(e.url)
  byNode.delete(nodeKey)
  const img = imgs.get(nodeKey)
  if (img) { delete img.dataset.ready; img.removeAttribute('src') }
}

// ---- capture coordinator: single-in-flight, idle-scheduled ----
let reqSeq = 0
let capturing = false
const inflight = new Map<number, string>()             // requestId -> nodeKey
const pending: Array<{ nodeKey: string; iframe: HTMLIFrameElement; meta: SnapMeta }> = []
const idle = (fn: () => void) =>
  (window as unknown as { requestIdleCallback?: (f: () => void, o?: object) => void }).requestIdleCallback?.(fn, { timeout: 500 }) ?? setTimeout(fn, 60)

/** Request a fresh snapshot for a ready/quiet frame. Coalesces to the latest per node. */
export function scheduleCapture(nodeKey: string, iframe: HTMLIFrameElement, meta: SnapMeta): void {
  // already have this exact snapshot, or it's already queued for this node
  if (byNode.get(nodeKey)?.key === keyOf(meta)) return
  const i = pending.findIndex((p) => p.nodeKey === nodeKey)
  if (i >= 0) pending[i] = { nodeKey, iframe, meta }
  else pending.push({ nodeKey, iframe, meta })
  pump()
}

function pump(): void {
  if (capturing || !pending.length) return
  capturing = true
  const { nodeKey, iframe, meta } = pending.shift()!
  const requestId = ++reqSeq
  inflight.set(requestId, nodeKey)
  const done = () => { inflight.delete(requestId); capturing = false; idle(pump) }
  const timer = setTimeout(done, 6000)   // producer never replied - free the slot
  finishers.set(requestId, () => { clearTimeout(timer); done() })
  iframe.contentWindow?.postMessage({
    type: 'sh:snapshot-request', requestId, nodeKey,
    sourceRevision: meta.sourceRevision, width: meta.width, height: meta.height, theme: meta.theme, dprBucket: 1,
  }, location.origin)
}
const finishers = new Map<number, () => void>()

/** App routes sh:snapshot-result / sh:snapshot-error here (source already validated). */
export function onSnapshotMessage(msg: { type: string; requestId?: number; nodeKey?: string; sourceRevision?: string; width?: number; height?: number; theme?: string; blob?: unknown }): void {
  const fin = typeof msg.requestId === 'number' ? finishers.get(msg.requestId) : undefined
  if (typeof msg.requestId === 'number') finishers.delete(msg.requestId)
  if (msg.type === 'sh:snapshot-result' && msg.nodeKey && msg.blob instanceof Blob) {
    storeSnapshot(msg.nodeKey, { sourceRevision: String(msg.sourceRevision ?? ''), width: Number(msg.width), height: Number(msg.height), theme: String(msg.theme ?? '') }, msg.blob)
  }
  fin?.()   // free the capture slot (result OR error)
}
