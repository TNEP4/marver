/**
 * Marver's mark: the Mac app's two glass shapes without the tile - the front ring solid, the
 * rear piece at 45% - painting in currentColor. The one definition the shell (icons.tsx
 * MarverMark) and the server's own pages (the password gate, the Marver ID sign-in pages)
 * draw from.
 *
 * Copied, never redrawn: the paths and the box are the `mark` variant of marver.design's
 * src/components/site/marver-logo.tsx (FRONT, REAR, MARK_BOX), which in turn are the app's
 * a-mark.svg with its slant matrix baked into the coordinates. The favicons in
 * src/client/shell/favicon/ are renders of this same mark.
 */

/** The front ring (fill-rule evenodd): a slanted rounded frame - the mark proper. */
export const MARK_FRONT =
  'M360.42 248.01L657.09 248.01C691.50 248.01 719.14 274.05 716.51 311.25C716.21 327.99 712.76 347.52 708.93 365.19L643.82 665.58C637.62 694.41 615.38 713.01 584.69 713.01L283.37 713.01C242.45 713.01 214.81 686.97 220.04 648.84C220.57 642.33 222.03 635.82 223.49 629.31L296.30 302.88C302.67 270.33 326.01 248.01 360.42 248.01ZM402.80 327.99C384.20 327.99 372.34 338.22 369.25 354.96L311.72 601.41C306.79 622.80 318.20 637.68 338.66 637.68L532.10 637.68C549.77 637.68 562.37 626.52 565.46 609.78L620.03 367.05C626.44 343.80 612.05 327.99 590.66 327.99Z'

/** The rear piece: the second frame showing behind, offset down and right. Drawn at MARK_REAR_OPACITY. */
export const MARK_REAR =
  'M625.05 323.34C633.38 314.04 644.14 307.53 662.74 307.53L749.23 307.53C784.57 307.53 808.49 333.57 806.22 367.98C806.07 376.35 804.25 385.65 802.43 394.95L737.25 722.31C732.53 749.28 718.09 765.09 689.26 765.09L355.39 765.09C319.12 765.09 292.62 744.63 290.81 713.01L584.69 713.01C615.38 713.01 637.62 694.41 643.82 665.58L708.93 365.19C711.66 351.24 714.94 335.43 716.93 322.41Z'

export const MARK_REAR_OPACITY = 0.45

/** The artwork's own bounds (no padding), so the mark sits on a text baseline like a glyph. */
export const MARK_VIEWBOX = '219 248 588 518'

/** Width over height: the mark is a little wider than tall, so it is sized by its height. */
export const MARK_ASPECT = 588 / 518

/** The width that goes with a height, to the hundredth of a pixel. */
export const markWidth = (height: number): number => Math.round(height * MARK_ASPECT * 100) / 100

/**
 * The mark as an SVG string for a server-rendered page, `height` px tall. Paints in
 * currentColor; `cls` adds a class attribute (the caller's own constant, never user input).
 */
export function markSvg(height: number, opts: { cls?: string } = {}): string {
  const cls = opts.cls ? ` class="${opts.cls}"` : ''
  return `<svg${cls} viewBox="${MARK_VIEWBOX}" width="${markWidth(height)}" height="${height}" fill="none" aria-hidden><path d="${MARK_REAR}" fill="currentColor" fill-opacity="${MARK_REAR_OPACITY}"/><path d="${MARK_FRONT}" fill-rule="evenodd" fill="currentColor"/></svg>`
}
