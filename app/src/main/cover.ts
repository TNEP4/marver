/**
 * The cover between the canvas views and the transparent strip (spec 28 A2.2, A3.8 #3, #29, #30): what shows under
 * the tabs whenever the active view may not be seen through. Owner: the one-ground stream. **Spike S15 picks it,
 * and nothing of it is built before S15's result** (A3.8 #3): 1 a plain `View` with the ground as its background,
 * 2 an `ImageView` of still dots, 3 a `WebContentsView` on persist:app loading `marver-app://cover/` (its renderer
 * then counts in the app's own memory, A3.8 #48), 4 no view - the strip's own background.
 *
 * This file hides the choice as far as window.ts goes: openWindow makes the strip first and hands it to
 * `makeCover`, the window snapshot's `dots` follows `stripDraws`, and captureWindow asks `bitmap()` before anything
 * else. What else each outcome touches:
 * - 1 or 2: nothing else. `stripDraws` false, so the strip paints controls only (#29).
 * - 3: `pages/cover/` (a page that draws only the dots); sessions.ts (serving `marver-app://cover/` and pinning it on
 *   persist:app, as for the strip); the bridge's registration if the page is to hear the look (else `setLook` sets
 *   its colours itself); the recorder's role `cover` through `contents()` (procs.ts). Its `bitmap()` may return null:
 *   captureWindow then takes the cover's own `capturePage()`.
 * - 4: no view. `setVisible` sets the strip's native background to the ground or to transparent, and `stripDraws`
 *   is true, so the strip's page draws the still dots while covered (pages/strip, as app 0.1's look does today
 *   through `dots`); `bitmap()` returns null and the strip's own capture carries the ground.
 * - none passing: the gate stays shut and app 0.1's look stays for canvases - the plain view covering every canvas,
 *   the strip's dots over it. A2.2's own fallback is the opaque strip; the app's pages at the full height (A3.8 #32)
 *   ship whatever S15 says, unless Nic decides otherwise (window.ts's header).
 *
 * FROZEN (A3.8 #53): the `Cover` interface and `makeCover`, grown additively by the optional `stripDraws` and
 * `makeCover`'s `strip` (review of the one-ground stream: variant 4 needs both). App 0.1's cover - window.ts's plain
 * `View`, `stripDraws` true - stays until then.
 */
import type { BaseWindow, View, WebContents, WebContentsView } from 'electron'
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
  /**
   * the cover as the reconstructed picture draws it (captureApp, A3.8 #14): BGRA at the scale factor, or null - then
   * a web-view cover's own capture, else a fill of the ground
   */
  bitmap(width: number, height: number, scaleFactor: number): Buffer | null
  /** the strip's page draws the still dots while this cover covers (app 0.1's plain view; variant 4): window.ts's `dots` */
  readonly stripDraws?: boolean
}

/**
 * The cover S15 chose, made hidden at openWindow and added between the tab pages and the strip. `strip` is the
 * strip's view, made already and not yet added (variant 4 colours its native background).
 */
export function makeCover(win: BaseWindow, strip?: WebContentsView): Cover {
  void win
  void strip
  throw new Error('cover.ts: spike S15 picks the cover before it is built (spec 28 A3.8 #3)')
}
