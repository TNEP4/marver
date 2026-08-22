// Client-side image Level-Of-Detail, running INSIDE a content frame's iframe.
//
// THE PROBLEM: a 2708x1610 screenshot is ~1.5MB as a PNG but ~17MB once decoded to RGBA. A board with
// 150 of them holds ~2.6GB of decoded bitmaps, and the browser resamples every one each zoom frame =
// jank + memory pressure. File size is a red herring; DECODED size is the killer.
//
// THE FIX: decode each image STRAIGHT to its on-screen size with createImageBitmap(blob,{resizeWidth}) -
// the full-size decode is never retained - and paint it on a <canvas> via a zero-copy bitmaprenderer
// transfer. The bitmap is FROZEN while the canvas is being pan/zoomed (the shell posts sh:camera
// {moving:true}) and only re-picked when the gesture SETTLES (sh:camera {moving:false, scale}), so zoom
// never triggers a decode/resample storm. Crisp at rest, cheap in motion. This mirrors how tldraw does
// LOD (resolution by on-screen size, debounced so it never thrashes mid-zoom).

/** Feature probe: createImageBitmap with resize + a canvas bitmaprenderer that can receive it. */
export const lodSupported = (() => {
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return false
    const ctx = document.createElement('canvas').getContext('bitmaprenderer')
    return !!ctx && typeof ctx.transferFromImageBitmap === 'function'
  } catch { return false }
})()

// Quantized resize widths (device px). A `want` above the top bucket decodes at NATIVE (bucket 0 = no
// resize), reached only when a frame is zoomed in past ~2048 on-screen device px.
const BUCKETS = [256, 640, 1280, 2048]
const DPR = (): number => Math.min(window.devicePixelRatio || 1, 2)   // cap at 2; 3x buys nothing here

// Bounded decode pool: never run more than N createImageBitmap jobs at once (peak decode memory + CPU).
const MAX = 3
let active = 0
const q: Array<() => void> = []
const pump = (): void => { while (active < MAX && q.length) q.shift()!() }
const schedule = (job: () => Promise<void>): void => {
  q.push(() => { active++; void job().finally(() => { active--; pump() }) })
  pump()
}

// Decode-idle signal for the headless shot: 0 means no decode is running or queued. The shot
// (src/server/shot.ts) polls this to know each image's first decode has settled - which pins
// its aspect-ratio and so stabilizes the frame's measured height - before it measures and
// captures. Harmless and 0 when there are no LOD images (nothing ever decodes).
if (typeof window !== 'undefined') (window as { __mvLodBusy?: () => number }).__mvLodBusy = () => active + q.length

interface Item { canvas: HTMLCanvasElement; src: string; bucket: number; token: number }
const items = new Set<Item>()
let scale = 0.2      // overview default until the shell primes the settled scale on frame-ready
let moving = false

function pick(devicePx: number): number {
  for (const b of BUCKETS) if (b >= devicePx) return b
  return 0           // native decode - only past the top bucket
}

async function decode(it: Item, bucket: number): Promise<void> {
  const token = ++it.token
  let bmp: ImageBitmap
  try {
    const blob = await (await fetch(it.src)).blob()
    bmp = bucket
      ? await createImageBitmap(blob, { resizeWidth: bucket, resizeQuality: 'high' })
      : await createImageBitmap(blob)
  } catch { return }                                       // network / decode failure: keep the last frame
  if (it.token !== token || !it.canvas.isConnected) { bmp.close(); return }   // superseded or unmounted
  const ctx = it.canvas.getContext('bitmaprenderer')
  if (!ctx) { bmp.close(); return }
  // PIN the display aspect-ratio on the first decode and never change it. Different buckets round to
  // slightly different integer dims (256x153 = 1.673 vs 1280x761 = 1.682), so if each drove height:auto
  // the layout box would shift a hair on every resolution switch - the doc reflows, the content frame
  // auto-resizes, and the frame "jiggles" as you zoom (and the reflow storm helped starve frames to a
  // ready-timeout). A fixed aspect-ratio makes the box identical across buckets: only pixels sharpen.
  if (!it.canvas.style.aspectRatio) it.canvas.style.aspectRatio = `${bmp.width} / ${bmp.height}`
  it.canvas.width = bmp.width; it.canvas.height = bmp.height
  ctx.transferFromImageBitmap(bmp)                         // zero-copy; consumes + closes the bitmap
  it.bucket = bucket
}

function refresh(it: Item): void {
  const layoutW = it.canvas.getBoundingClientRect().width
  if (!layoutW) return                                     // not laid out yet (or display:none)
  const want = pick(Math.ceil(layoutW * scale * DPR()))
  if (want === it.bucket) return
  // hysteresis: only DOWNgrade once we're comfortably below the current level, so a jittery zoom that
  // hovers a threshold doesn't swap back and forth (upgrades are always taken - sharper is worth it).
  if (it.bucket > 0 && want > 0 && want < it.bucket && Math.ceil(layoutW * scale * DPR()) > it.bucket * 0.6) return
  schedule(() => decode(it, want))
}

/** A content <canvas> registers here; returns an unregister fn. Paints a cheap first frame immediately,
 *  then sharpens to the real zoom on the next prime/settle. */
export function registerLodImage(canvas: HTMLCanvasElement, src: string): () => void {
  const it: Item = { canvas, src, bucket: -1, token: 0 }
  items.add(it)
  schedule(() => decode(it, BUCKETS[0]))                   // low-res first paint (fast, ~1MB); prime sharpens
  return () => { items.delete(it); it.token++ }            // token bump drops any in-flight decode
}

// The shell posts camera transitions ONCE per gesture. Freeze during motion; re-pick every image's
// resolution to the SETTLED zoom - but debounced, and cancelling any queued work from a prior settle, so
// a fast zoom in-out-in doesn't stack decode waves across all frames (which starved the main thread and
// timed frames out). The re-decode only fires once the camera has truly rested.
let settleTimer = 0
if (typeof window !== 'undefined' && lodSupported) {
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return
    const m = (e as MessageEvent).data as { type?: string; moving?: boolean; scale?: number } | null
    if (!m || m.type !== 'sh:camera') return
    if (m.moving) { moving = true; clearTimeout(settleTimer); q.length = 0; return }   // new gesture: drop pending decodes
    moving = false
    if (typeof m.scale === 'number' && m.scale > 0) scale = m.scale
    clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => { if (!moving) for (const it of items) refresh(it) }, 220)
  })
}
