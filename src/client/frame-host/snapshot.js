// Stage 2: frame-side snapshot producer. Dynamically imported by the bridge ONLY when the shell
// asks for a capture, so html-to-image never sits in a frame's boot path. Runs INSIDE the frame
// document, where the fonts, CSSOM, images, canvas, and scroll all live. DOM reconstruction (not a
// real screenshot) - it must fail soft; the caller turns a null/throw into sh:snapshot-error and
// keeps live pixels.
import { toBlob } from 'html-to-image'

const rafSettle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
const withDeadline = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))])

/** Capture the frame's visible box (width x height CSS px) to a Blob, or null on failure. */
export async function capture({ width, height }) {
  // paint-settle: fonts + a couple of stable frames, each bounded so a slow frame can't hang capture
  await withDeadline(document.fonts?.ready ?? Promise.resolve(), 400).catch(() => {})
  await rafSettle()
  const node = document.body || document.documentElement
  return toBlob(node, {
    width: Math.round(width),
    height: Math.round(height),
    pixelRatio: Math.min(1.5, window.devicePixelRatio || 1),   // dev DPR cap (memory budget)
    cacheBust: false,                                          // same-origin; no bust needed
    skipFonts: false,
  })
}
