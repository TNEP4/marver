// Tells every content frame when the canvas camera starts and stops moving, so each frame's image-LOD
// (content/img-lod.ts) can freeze its bitmaps during motion and sharpen to the settled zoom afterwards.
//
// Fires ONCE per gesture, never per animation frame - it watches the single #sh-world.sh-camera class
// that EVERY camera path (rzpp zoom/pan, wheel, pinch, programmatic setTransform) toggles, so one hook
// covers them all. Posting a message to 150 frames every tick would be its own jank; two posts per
// gesture (start, settle) is free.

let lastScale = 1
/** Fed live from onTransformed so `settle` always broadcasts the final zoom. Cheap (a number write). */
export function setCameraScale(s: number): void { if (s > 0) lastScale = s }

function frameWindows(): Window[] {
  const out: Window[] = []
  for (const f of document.querySelectorAll<HTMLIFrameElement>('#sh-world iframe'))
    if (f.contentWindow) out.push(f.contentWindow)
  return out
}

function broadcast(moving: boolean): void {
  const msg = moving ? { type: 'sh:camera', moving: true } : { type: 'sh:camera', moving: false, scale: lastScale }
  for (const w of frameWindows()) { try { w.postMessage(msg, location.origin) } catch { /* cross-doc timing */ } }
  if (!moving) crispDrawings()
}

/** Drawings (spec 38, decision 23) re-render at the camera's scale only while on screen - at most 6 at a time, the
 *  largest first; every other drawing goes back to its native pixel ratio (its canvas memory with it). */
export const CRISP_MAX = 6
function crispDrawings(): void {
  const vw = innerWidth, vh = innerHeight
  const draws = [...document.querySelectorAll<HTMLIFrameElement>('#sh-world iframe[data-kind="draw"]')].map((f) => {
    const r = f.getBoundingClientRect()
    const vis = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
    return { f, vis }
  })
  const sharp = new Set(draws.filter((d) => d.vis > 0).sort((a, b) => b.vis - a.vis).slice(0, CRISP_MAX).map((d) => d.f))
  for (const { f } of draws) {
    try { f.contentWindow?.postMessage({ type: 'sh:draw-crisp', scale: sharp.has(f) ? lastScale : 1 }, location.origin) } catch { /* timing */ }
  }
}

/** What is moving on the canvas: the camera (a pan or zoom, `sh-camera`) and the layout (a preset or tidy animation,
 *  `sh-preset`). The same one observer tells the shell's own listeners - the gesture sampler (perf.ts) and the
 *  recorder's camera idle (spec 28 A1.7) - on every change of either, so nothing polls. */
export interface Motion { camera: boolean; preset: boolean }
let motion: Motion = { camera: false, preset: false }
const motionListeners = new Set<(m: Motion) => void>()
/** Called with the new motion at each change; returns the unsubscribe. */
export function onMotion(fn: (m: Motion) => void): () => void { motionListeners.add(fn); return () => { motionListeners.delete(fn) } }

let started = false
export function startCameraBroadcast(): void {
  if (started) return
  const world = document.getElementById('sh-world'); if (!world) return
  started = true
  new MutationObserver(() => {
    const now = { camera: world.classList.contains('sh-camera'), preset: world.classList.contains('sh-preset') }
    if (now.camera === motion.camera && now.preset === motion.preset) return
    const cameraChanged = now.camera !== motion.camera
    motion = now
    if (cameraChanged) broadcast(now.camera)   // +sh-camera -> freeze; -sh-camera -> sharpen to the settled scale
    for (const fn of motionListeners) { try { fn(now) } catch { /* a listener never stops the broadcast */ } }
  }).observe(world, { attributes: true, attributeFilter: ['class'] })
}

/** Prime ONE freshly-ready frame with the current settled scale, so a static board that is never zoomed
 *  still sharpens from its cheap low-res first paint to the right resolution. */
export function primeCameraFor(win: Window | null | undefined): void {
  if (!win) return
  try { win.postMessage({ type: 'sh:camera', moving: false, scale: lastScale }, location.origin) } catch { /* timing */ }
  crispDrawings()
}
