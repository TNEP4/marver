/** spec 39 B2: where the drawing's own chrome covers the comment layer - a pin there is out of view (parked). */
/** Is this page point under the drawing's chrome - its panel, its bar, its view controls? (spec 39 B2) */
export function underChrome(x: number, y: number): boolean {
  for (const el of document.querySelectorAll('.dk-anchor, .dk-view')) {
    const r = el.getBoundingClientRect()
    if (r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true
  }
  return false
}
