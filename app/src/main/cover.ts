/**
 * The cover between the canvas views and the transparent strip (spec 28 A2.2, A3.8 #3, #29, #30): what shows under
 * the tabs whenever the active view may not be seen through. Owner: the one-ground stream. **Spike S15 picks it,
 * and nothing of it is built before S15's result** (A3.8 #3): 1 a plain `View` with the ground as its background,
 * 2 an `ImageView` of still dots, 3 a `WebContentsView` on persist:app loading `marver-app://cover/` (its renderer
 * then counts in the app's own memory, A3.8 #48), 4 no view - the strip's own background. This file hides the
 * choice, so it is a one-file change.
 *
 * FROZEN (A3.8 #53): the `Cover` interface and `makeCover`. App 0.1's cover - window.ts's plain `View`, always shown
 * under the opaque strip - stays until then.
 */
import type { BaseWindow, View, WebContents } from 'electron'
import type { Rect } from './plan.ts'

export interface Cover {
  /** whatever S15 chose (none for variant 4); always second from the top of the window's stack */
  readonly view: View | null
  /** variant 3's renderer, for the recorder's role `cover`; else null */
  contents(): WebContents | null
  /** the strip's rect */
  setRect(r: Rect): void
  /** in compose's turn, with the views beneath (A3.8 #30) */
  setVisible(v: boolean): void
  /** the ground of the active tab's look, and its dots */
  setLook(dark: boolean): void
  /** the cover as the reconstructed picture draws it (captureApp, A3.8 #14): BGRA at the scale factor, or null to fill with the ground */
  bitmap(width: number, height: number, scaleFactor: number): Buffer | null
}

/** The cover S15 chose, made hidden at openWindow and added between the tab pages and the strip. */
export function makeCover(win: BaseWindow): Cover {
  void win
  throw new Error('cover.ts: spike S15 picks the cover before it is built (spec 28 A3.8 #3)')
}
