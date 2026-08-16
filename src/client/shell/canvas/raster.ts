/**
 * LOD raster layer (level-of-detail during motion). The lean/live tiers are real DOM/iframes, which
 * Chromium RE-RASTERISES at the zoom scale on every camera tick - on a rich or image-heavy frame
 * that starves the GPU tile budget and the frame goes blank/laggy at high zoom (the residual after
 * viewport culling). A flat <img> instead rides Chrome's cheap directly-composited-image path: it
 * scales an existing bitmap, no re-raster. So WHILE the camera moves (body.sh-cam) we show a raster
 * snapshot of each visible frame and stop rendering its heavy DOM (CSS in styles.css); the instant
 * motion settles, the crisp live/lean DOM returns. Fidelity is untouched where the user judges it
 * (at rest) - the raster only ever shows mid-motion, where the eye can't resolve the detail.
 *
 * The frame captures ITSELF (bridge.js -> html-to-image), where its fonts/images/CSSOM live, and
 * posts the dataURL back; App.tsx routes the result here. Fail-soft everywhere: no raster yet, or a
 * capture error, just means that frame shows its DOM during motion (today's behaviour).
 */
const imgs = new Map<string, HTMLImageElement>()          // nodeKey -> the <img class="sh-raster">
const rev = new Map<string, number>()                     // nodeKey -> latest requested revision
const pending = new Map<string, HTMLIFrameElement>()      // nodeKey -> live iframe awaiting an idle request
let inflight = 0
const MAX_CONCURRENT = 2                                   // html-to-image inlines images - don't storm the CPU

const busy = (): boolean => {
  const w = document.getElementById('sh-world')
  return document.body.classList.contains('sh-cam') ||
    (!!w && (w.classList.contains('sh-gesturing') || w.classList.contains('sh-preset'))) ||
    document.body.classList.contains('sh-laser') || document.body.classList.contains('sh-commenting')
}
const idle = (fn: () => void) =>
  (window as unknown as { requestIdleCallback?: (f: () => void, o?: object) => void }).requestIdleCallback?.(fn, { timeout: 1200 }) ?? setTimeout(fn, 120)

/** FrameNode registers its <img> so the coordinator can drive its src imperatively. */
export function registerRasterImg(nodeKey: string, img: HTMLImageElement | null): void {
  if (!img) { imgs.delete(nodeKey); return }
  imgs.set(nodeKey, img)
}

/** Request a fresh raster for a ready frame. Coalesces per node; a new request supersedes any older
 *  in-flight result via the revision guard. Deferred while the camera moves (never capture mid-zoom). */
export function scheduleRaster(nodeKey: string, live: HTMLIFrameElement): void {
  rev.set(nodeKey, (rev.get(nodeKey) ?? 0) + 1)
  // drop the OLD bitmap's ready flag now: a re-capture means the current one is stale (theme flip,
  // nav), and a stale bitmap must never be the motion view. Until the fresh one lands, motion falls
  // back to the live/lean DOM for this frame (the :has(.sh-raster[data-ready]) guard fails).
  imgs.get(nodeKey)?.removeAttribute('data-ready')
  pending.set(nodeKey, live)
  pump()
}

function pump(): void {
  if (busy()) { if (pending.size) idle(pump); return }
  while (inflight < MAX_CONCURRENT) {
    const nodeKey = pickNext()
    if (!nodeKey) break
    const live = pending.get(nodeKey)!
    pending.delete(nodeKey)
    inflight++
    // fire-and-forget: the frame answers with sh:snapshot-result / -error (App.tsx -> resolve()).
    // a 6s watchdog frees the slot if a frame never replies, so the queue can't wedge.
    const r = rev.get(nodeKey) ?? 0
    settle.set(nodeKey, window.setTimeout(() => resolve(nodeKey, r, null), 6000))
    live.contentWindow?.postMessage({ type: 'sh:snapshot-request', rev: r }, location.origin)
  }
}

// on-screen frames first (that's what a camera move will show); registration order otherwise.
function pickNext(): string | null {
  let best: string | null = null, bestScore = Infinity
  const vw = window.innerWidth, vh = window.innerHeight
  for (const [k, live] of pending) {
    const r = live.getBoundingClientRect()
    const off = r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw
    const dx = r.left + r.width / 2 - vw / 2, dy = r.top + r.height / 2 - vh / 2
    const score = (off ? 1e7 : 0) + Math.hypot(dx, dy)
    if (score < bestScore) { bestScore = score; best = k }
  }
  return best
}

const settle = new Map<string, number>()   // nodeKey -> watchdog timer for an outstanding request

/** App.tsx routes sh:snapshot-result / -error here. Stale revisions (a newer request already went
 *  out) are dropped so an out-of-order reply can't paint an old bitmap. */
export function resolve(nodeKey: string, r: number, dataUrl: string | null): void {
  if ((rev.get(nodeKey) ?? -1) !== r) { if (inflight > 0) inflight--; idle(pump); return }
  clearTimeout(settle.get(nodeKey)); settle.delete(nodeKey)
  if (inflight > 0) inflight--
  if (dataUrl) {
    const img = imgs.get(nodeKey)
    if (img) { img.onload = () => img.setAttribute('data-ready', '1'); img.src = dataUrl }
  }
  idle(pump)
}

/** Drop a node's raster (unmount / content changed): clear the img + cancel any pending work. */
export function dropRaster(nodeKey: string): void {
  rev.set(nodeKey, (rev.get(nodeKey) ?? 0) + 1)   // invalidate any in-flight reply
  pending.delete(nodeKey)
  clearTimeout(settle.get(nodeKey)); settle.delete(nodeKey)
  const img = imgs.get(nodeKey)
  if (img) { img.onload = null; img.removeAttribute('data-ready'); img.removeAttribute('src') }
}
