/**
 * The Slide root (v1.5) - the ONE slide primitive. Owns the 1280×720 stage,
 * the tokens, the type roles, and the rest-state motion reset. Recipes are
 * prose in instructions/slides.md; markup composes INSIDE <Slide> with the
 * project's own classes - nothing else is an API.
 *
 * Tokens read documented host variables (--marver-slide-*) from the frame's
 * theme when the host defines them, and fall back to the palette - an
 * unthemed repo still gets a coherent deck.
 *
 * Motion law: at rest (canvas), everything inside a slide is STILL - CSS
 * animations and transitions are suspended. Slides mode lifts the reset by
 * setting `data-sl-play` on <html> (the stage owns that flag), which also
 * arms the entrance presets (`data-animate`, run once after the swap
 * settles - the stage adds `data-sl-entered`).
 */
import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { FONT_STACK } from './palette.ts'

export const SLIDE_W = 1280
export const SLIDE_H = 720

/** Img (and anything else that cares) asks: am I inside a slide? */
export const SlideCtx = createContext(false)
export const useInSlide = () => useContext(SlideCtx)

/**
 * Is slides mode live? The STAGE owns the answer: it stamps `data-sl-play`
 * on <html> (boot: the `slides` URL param; thereafter its own messages).
 * CSS reacts to the attribute natively; React components (Chart's entrance,
 * Video's player mount) subscribe here - a MutationObserver over the
 * documentElement attribute, so the contract is one attribute, one owner,
 * observable by anyone.
 */
const subscribePlay = (cb: () => void) => {
  if (typeof document === 'undefined') return () => {}
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sl-play', 'data-sl-entered'] })
  return () => mo.disconnect()
}
const readPlay = () => typeof document !== 'undefined' && document.documentElement.hasAttribute('data-sl-play')
export const useSlidePlay = (): boolean => useSyncExternalStore(subscribePlay, readPlay, () => false)

const SLIDE_CSS = `
/* the frame document must not pad the stage: a 1280px root in a margined
   body overflows the intrinsic by 16px - reset where a slide lives. The body
   also paints the slide ground, so the letterbox around a scaled stage is
   seamless instead of a default-white halo. */
body:has(.sl-root) { margin: 0; background: var(--marver-slide-ground, #ffffff) }
.dark body:has(.sl-root), [data-theme="dark"] body:has(.sl-root) { background: var(--marver-slide-ground-dark, #101014) }
.sl-root, .sl-root * { box-sizing: border-box }
.sl-root {
  --sl-ink: var(--marver-slide-ink, #18181b);
  --sl-ground: var(--marver-slide-ground, #ffffff);
  --sl-accent: var(--marver-slide-accent, #0088ff);
  --sl-muted: var(--marver-slide-muted, rgba(24, 24, 27, .55));
  --sl-tempo: var(--marver-slide-tempo, 350ms);
  --sl-margin: 7%;
  /* THE FIT: authored at exactly ${SLIDE_W}x${SLIDE_H}, then scaled and
     centered to the largest box the viewport gives it - fill window, any
     device, any published viewer's screen. One coordinate system, so the
     author's px, Tailwind classes, and charts all scale together (--sl-fit
     is set inline by the component; 1 on the canvas, where the frame IS
     ${SLIDE_W}x${SLIDE_H}). */
  /* translate-center, not inset+margin:auto - an overconstrained absolute
     box (1280px stage in a 390px viewport) resolves margins to 0 and the
     scaled slide drifts off-center; translate(-50%,-50%) centers at ANY size */
  position: absolute; left: 50%; top: 50%;
  width: ${SLIDE_W}px; height: ${SLIDE_H}px; overflow: hidden;
  transform: translate(-50%, -50%) scale(var(--sl-fit, 1)); transform-origin: center center;
  background: var(--sl-ground); color: var(--sl-ink);
  font-family: ${FONT_STACK};
  padding: var(--sl-margin); box-sizing: border-box;
  display: flex; flex-direction: column; justify-content: center; gap: 20px;
}
.dark .sl-root, [data-theme="dark"] .sl-root {
  --sl-ink: var(--marver-slide-ink-dark, #f5f5f7);
  --sl-ground: var(--marver-slide-ground-dark, #101014);
  --sl-muted: var(--marver-slide-muted-dark, rgba(245, 245, 247, .55));
}
.sl-assertion { font-size: 56px; line-height: 1.08; font-weight: 750; letter-spacing: -.02em; margin: 0 }
.sl-support { font-size: 30px; line-height: 1.25; font-weight: 500; margin: 0 }
.sl-body { font-size: 24px; line-height: 1.45; margin: 0 }
.sl-caption { font-size: 18px; line-height: 1.4; color: var(--sl-muted); margin: 0 }

/* THE MOTION RESET - at rest, a slide is still: animation NONE (not paused -
   none is deterministic; paused can freeze mid-keyframe) and no transitions.
   Slides mode (the stage sets data-sl-play on <html>) lifts it. This governs
   EVERY descendant - spinners and loaders included - and that is the Slide
   contract, documented in instructions/slides.md. */
:root:not([data-sl-play]) .sl-root, :root:not([data-sl-play]) .sl-root *,
:root:not([data-sl-play]) .sl-root *::before, :root:not([data-sl-play]) .sl-root *::after {
  animation: none !important;
  transition: none !important;
}

/* Entrance presets: inert until the stage marks the swap settled. An element
   carrying a morph name must not carry data-animate (one transform owner) -
   the doctrine says so; the selector below cannot check it, the review gate does. */
[data-sl-play] .sl-root [data-animate] { opacity: 0 }
[data-sl-play][data-sl-entered] .sl-root [data-animate] {
  opacity: 1; animation-duration: 400ms; animation-timing-function: cubic-bezier(.2, .7, .2, 1);
  animation-fill-mode: both;
}
[data-sl-play][data-sl-entered] .sl-root [data-animate="fade-up"] { animation-name: sl-fade-up }
[data-sl-play][data-sl-entered] .sl-root [data-animate="fade"] { animation-name: sl-fade }
[data-sl-play][data-sl-entered] .sl-root [data-animate="scale-in"] { animation-name: sl-scale-in }
[data-sl-play][data-sl-entered] .sl-root [data-animate-delay="1"] { animation-delay: 80ms }
[data-sl-play][data-sl-entered] .sl-root [data-animate-delay="2"] { animation-delay: 160ms }
[data-sl-play][data-sl-entered] .sl-root [data-animate-delay="3"] { animation-delay: 240ms }
@keyframes sl-fade-up { from { opacity: 0; transform: translateY(18px) } to { opacity: 1; transform: none } }
@keyframes sl-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes sl-scale-in { from { opacity: 0; transform: scale(.94) } to { opacity: 1; transform: none } }
@media (prefers-reduced-motion: reduce) {
  [data-sl-play] .sl-root [data-animate] { opacity: 1; animation: none !important }
}
`

function ensureSlideStyles() {
  // keyed by the DOCUMENT, not a module boolean - HMR reloads and multiple
  // roots must not double- or under-inject
  if (typeof document === 'undefined' || document.querySelector('style[data-mv-slide]')) return
  const el = document.createElement('style')
  el.setAttribute('data-mv-slide', '')
  el.textContent = SLIDE_CSS
  document.head.appendChild(el)
}

export function Slide({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  ensureSlideStyles()
  const ref = useRef<HTMLDivElement>(null)
  // THE FIT: scale the authored stage to the viewport (up AND down - a fill
  // window grows the slide, a phone shrinks it). Inline on the element so the
  // lean serializer captures the correct scale (the lean doc runs no JS).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      const s = Math.min(window.innerWidth / SLIDE_W, window.innerHeight / SLIDE_H)
      el.style.setProperty('--sl-fit', String(Math.max(0.05, Math.round(s * 10000) / 10000)))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  // dev overflow marker: a slide that outgrows its stage is a VISIBLE defect
  // (outline + console), never a silent clip decision left to chance
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const check = () => {
      const over = el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1
      el.style.outline = over ? '3px solid #ff4d4f' : ''
      if (over) console.warn('[marver slide] content overflows the 1280×720 stage - split the slide, never shrink the type')
    }
    const ro = new ResizeObserver(check)
    ro.observe(el)
    for (const child of el.children) ro.observe(child)
    check()
    return () => ro.disconnect()
  }, [])
  return (
    <SlideCtx.Provider value={true}>
      <div ref={ref} className="sl-root" style={style}>{children}</div>
    </SlideCtx.Provider>
  )
}
