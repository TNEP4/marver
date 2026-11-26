/** spec 39 B2: where the drawing's own chrome covers the comment layer - a pin there is out of view (parked). Chrome that
 *  is hidden (Hide all UI fades it) covers nothing (review r3 #3). */
export function underChrome(x: number, y: number): boolean {
  for (const el of document.querySelectorAll('.dk-anchor, .dk-view')) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05 || cs.pointerEvents === 'none') continue
    const r = el.getBoundingClientRect()
    if (r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true
  }
  return false
}
