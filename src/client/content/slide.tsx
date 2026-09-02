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
/** Stage margins: wide at the sides, tight top and bottom (content 1104x632). */
const PAD_X = 88
const PAD_Y = 44

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
  --sl-font: var(--marver-slide-font, ${FONT_STACK});
  /* THE STAGE MARGINS, in px and ASYMMETRIC - the shape every well-made deck
     uses. Generous at the sides, tighter top and bottom, so the title sits
     high, the footnote sits low, and the middle band is the tallest thing on
     the slide. Percentages are wrong here twice over: they would resolve
     against this absolutely positioned box's containing block (the viewport,
     not the stage), and one value for all four sides squeezes the middle. */
  --sl-pad-x: var(--marver-slide-pad-x, ${PAD_X}px);
  --sl-pad-y: var(--marver-slide-pad-y, ${PAD_Y}px);
  --sl-margin: var(--sl-pad-x);          /* the side margin, for author math */
  /* THE FIT: authored at exactly ${SLIDE_W}x${SLIDE_H}, then scaled and
     centered to the largest box the viewport gives it - fill window, any
     device, a canvas node resized to a phone, any published viewer's screen.
     One coordinate system, so the author's px, Tailwind classes, and charts
     all scale together. Pure CSS (tan(atan2(a, b)) is the unitless ratio
     a / b), so a lean cover - which runs no JS - reflows to the right scale
     the moment its node is resized. 1 wherever the viewport IS the stage.
     Declared under @supports below: an engine without CSS trig would keep
     the invalid tokens, defeat the var() fallback, and invalidate the whole
     transform - unscaled AND uncentered. */
  --sl-fit: 1;
  /* translate-center, not inset+margin:auto - an overconstrained absolute
     box (1280px stage in a 390px viewport) resolves margins to 0 and the
     scaled slide drifts off-center; translate(-50%,-50%) centers at ANY size */
  position: absolute; left: 50%; top: 50%;
  width: ${SLIDE_W}px; height: ${SLIDE_H}px; overflow: hidden;
  transform: translate(-50%, -50%) scale(var(--sl-fit, 1)); transform-origin: center center;
  background: var(--sl-ground); color: var(--sl-ink);
  font-family: var(--sl-font);
  padding: var(--sl-pad-y) var(--sl-pad-x); box-sizing: border-box;
  display: flex; flex-direction: column; justify-content: center; gap: 28px;
}
@supports (width: calc(1px * tan(atan2(1px, 1px)))) {
  .sl-root { --sl-fit: min(tan(atan2(100vw, ${SLIDE_W}px)), tan(atan2(100vh, ${SLIDE_H}px))) }
}
.dark .sl-root, [data-theme="dark"] .sl-root {
  --sl-ink: var(--marver-slide-ink-dark, #f5f5f7);
  --sl-ground: var(--marver-slide-ground-dark, #101014);
  --sl-muted: var(--marver-slide-muted-dark, rgba(245, 245, 247, .55));
}
/* type roles - fixed values, one coordinate system with the 1280x720 stage.
   sl-display is the ONE sanctioned oversize: the big-number stat, a section
   numeral, the manifesto line - never running text. */
.sl-display { font-size: 160px; line-height: 1; font-weight: 800; letter-spacing: -.03em; margin: 0; font-variant-numeric: tabular-nums }
/* sl-stat is the ROW size: three or four figures side by side, where one
   sl-display would not fit and sl-assertion would not read as a number. */
.sl-stat { font-size: 88px; line-height: 1.02; font-weight: 700; letter-spacing: -.03em; margin: 0; font-variant-numeric: tabular-nums }
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
/* ONE tempo per deck: the token times the entrances AND the view-transition
   morphs between slides (the stage document is this document). */
::view-transition-group(*), ::view-transition-old(root), ::view-transition-new(root) {
  animation-duration: var(--marver-slide-tempo, 350ms);
}
[data-sl-play][data-sl-entered] .sl-root [data-animate] {
  opacity: 1; animation-duration: var(--sl-tempo); animation-timing-function: cubic-bezier(.2, .7, .2, 1);
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
  // DEV overflow marker: a slide that outgrows its stage is a VISIBLE defect
  // (outline + console + data-sl-over), never a silent clip decision left to
  // chance. Development only - a published deck paints no diagnostics.
  // Two tests, both in the stage's LAYOUT space (rects are post-transform,
  // the fit scales the stage, so rect offsets are divided by the scale):
  //  1. escape - a box leaving the 1280x720 stage. Measured against the
  //     STAGE, not the padded content box: full-bleed images and clipped
  //     photos break the margins on purpose.
  //  2. collision - a flex/grid child outgrowing its parent's content box.
  //     Inside a flex column a body at flex:1 keeps its own box while ITS
  //     children spill over the neighbouring bands, all still inside the
  //     stage, which test 1 never sees.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let last: boolean | null = null
    let raf = 0
    const check = () => {
      raf = 0
      const r = el.getBoundingClientRect()
      const k = el.offsetWidth ? r.width / el.offsetWidth : 1
      const pad = (v: string) => parseFloat(v) || 0
      const W = el.offsetWidth, H = el.offsetHeight
      let over = el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1
      let culprit: Element | null = null
      const all = el.querySelectorAll('*')
      const n = Math.min(all.length, 600)
      for (let i = 0; !over && i < n; i++) {
        const c = all[i]
        const b = c.getBoundingClientRect()
        if (!b.width && !b.height) continue
        const y0 = (b.top - r.top) / k, y1 = (b.bottom - r.top) / k
        const x0 = (b.left - r.left) / k, x1 = (b.right - r.left) / k
        if (y1 > H + 1.5 || y0 < -1.5 || x1 > W + 1.5 || x0 < -1.5) { over = true; culprit = c; break }
        const par = c.parentElement
        if (!par || !par.clientHeight) continue
        const ps = getComputedStyle(par)
        if (!/flex|grid/.test(ps.display) || ps.overflowY !== 'visible' || ps.overflowX !== 'visible') continue
        if (/absolute|fixed/.test(getComputedStyle(c).position)) continue
        const pr = par.getBoundingClientRect()
        const lo = (pr.top - b.top) / k + pad(ps.paddingTop)
        const hi = (b.bottom - pr.bottom) / k + pad(ps.paddingBottom)
        if (lo > 2 || hi > 2) { over = true; culprit = c; break }
      }
      if (over === last) return                       // idempotent: never write the same state twice
      last = over
      el.style.outline = over ? '3px solid #ff4d4f' : ''
      el.dataset.slOver = over ? '1' : ''
      if (over) console.warn('[marver slide] content overflows the 1280×720 stage - split the slide, never shrink the type', culprit ?? el)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(check) }
    // observe every descendant (bounded): a flex child keeps its box while its
    // content grows, and a root-only observer never hears about that. Nodes
    // added later are picked up by the childList observer - childList ONLY,
    // so our own outline/data writes (attribute mutations) cannot re-trigger.
    const ro = new ResizeObserver(schedule)
    const seen = new WeakSet<Element>()
    const observeAll = () => {
      const all = el.querySelectorAll('*')
      for (let i = 0; i < all.length && i < 600; i++) { if (!seen.has(all[i])) { seen.add(all[i]); ro.observe(all[i]) } }
    }
    ro.observe(el)
    observeAll()
    const mo = new MutationObserver(() => { observeAll(); schedule() })
    mo.observe(el, { childList: true, subtree: true })
    schedule()
    return () => { cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect() }
  }, [])
  return (
    <SlideCtx.Provider value={true}>
      <div ref={ref} className="sl-root" style={style}>{children}</div>
    </SlideCtx.Provider>
  )
}
