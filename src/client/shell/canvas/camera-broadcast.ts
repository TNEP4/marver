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
}

let started = false
export function startCameraBroadcast(): void {
  if (started) return
  const world = document.getElementById('sh-world'); if (!world) return
  started = true
  let moving = false
  new MutationObserver(() => {
    const now = world.classList.contains('sh-camera')
    if (now === moving) return
    moving = now
    broadcast(now)   // +sh-camera -> freeze; -sh-camera -> sharpen to the settled scale
  }).observe(world, { attributes: true, attributeFilter: ['class'] })
}

/** Prime ONE freshly-ready frame with the current settled scale, so a static board that is never zoomed
 *  still sharpens from its cheap low-res first paint to the right resolution. */
export function primeCameraFor(win: Window | null | undefined): void {
  if (!win) return
  try { win.postMessage({ type: 'sh:camera', moving: false, scale: lastScale }, location.origin) } catch { /* timing */ }
}
