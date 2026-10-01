/**
 * Slide - an OPTIONAL wrapper, nothing more. A slide is any frame with `slide: true` in its
 * meta: it renders at its stage size (its declared viewport, else 1280×720) and slides mode
 * scales the whole stage to the screen, so the frame never scales itself. Everything inside
 * is the author's own code - layout, type, colour, imagery, motion.
 *
 * The wrapper fills the frame and tells the content primitives they sit on a stage (Img,
 * Chart); decks written against the earlier Slide root import it, so it stays.
 *
 * The playback contract lives with the player (src/client/stage/main.tsx): while a deck
 * plays, <html> carries `data-sl-play`, plus `data-sl-entered` once each slide has arrived -
 * authors key their own CSS and JS motion off them. useSlidePlay() is the same flag for React.
 */
import { createContext, useContext, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { SLIDE_INTRINSIC } from '../const.ts'

/** The default stage. A deck may declare another size through its frames' viewport. */
export const SLIDE_W = SLIDE_INTRINSIC.width
export const SLIDE_H = SLIDE_INTRINSIC.height

/** Img (and anything else that cares) asks: am I inside a <Slide>? */
export const SlideCtx = createContext(false)
export const useInSlide = () => useContext(SlideCtx)

/**
 * Is a deck playing? The STAGE owns the answer: it stamps `data-sl-play` on <html> (boot:
 * the `slides` URL param). CSS reacts to the attribute natively; React components (Chart's
 * entrance, Video's player mount) subscribe here - a MutationObserver over the
 * documentElement attribute, so the contract is one attribute, one owner, observable by anyone.
 */
const subscribePlay = (cb: () => void) => {
  if (typeof document === 'undefined') return () => {}
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sl-play', 'data-sl-entered'] })
  return () => mo.disconnect()
}
const readPlay = () => typeof document !== 'undefined' && document.documentElement.hasAttribute('data-sl-play')
export const useSlidePlay = (): boolean => useSyncExternalStore(subscribePlay, readPlay, () => false)

/* the frame document must not pad the stage: a stage-wide root in a margined body overflows */
const SLIDE_CSS = `
body:has(.sl-root) { margin: 0 }
.sl-root { position: relative; box-sizing: border-box; width: 100%; min-height: 100vh }
`

function ensureSlideStyles() {
  // keyed by the DOCUMENT, not a module boolean - HMR reloads and multiple
  // roots must not double- or under-inject
  if (typeof document === 'undefined' || document.querySelector('style[data-mv-slide-css]')) return
  const el = document.createElement('style')
  el.setAttribute('data-mv-slide-css', '')
  el.textContent = SLIDE_CSS
  document.head.appendChild(el)
}

export function Slide({ children, className, style }: { children?: ReactNode; className?: string; style?: CSSProperties }) {
  ensureSlideStyles()
  return (
    <SlideCtx.Provider value={true}>
      <div className={className ? `sl-root ${className}` : 'sl-root'} style={style}>{children}</div>
    </SlideCtx.Provider>
  )
}
