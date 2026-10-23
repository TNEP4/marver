/**
 * The one usable-rectangle helper (spec 28 A2.9 v1.8 #6, A3.8 #31): where the shell may place what a person must
 * see, under the Mac app's transparent strip. Owner: the one-ground stream (marver 0.27.2).
 *
 * `TOP` is 44 only when the app says this document must apply it (`topInset`, from `mv:doc`'s answer) **and** the
 * presentation contract is whole (`onPresent` and `presented`): a shell never trusts half a contract, so in Chrome,
 * on a published canvas, under `marver shot` and inside app 0.1 it is 0 and nothing moves. `--mv-top` goes on
 * `:root` (some portals mount outside `.sh-app`), and every rule reads `var(--mv-top, 0px)`.
 *
 * FROZEN before the A3 streams split (A3.8 #53): `TOP`, `VISIBLE_TOP`, `usable()`, `onScreen()` and `applyInset()`.
 * Consumers: the top-anchored layers, the selection bar, tips and menus (`TOP + 8`), insets(), focus, play sizes
 * and Jam's fill use `usable()`; seen marks, visibleNodes(), A3.3's probes and A4.3's full-view test use `onScreen()`.
 */
import { EDGE_FADE, TOP_INSET, type Inset } from '../../shared/app-api.ts'
import { APP } from './marver-app.ts'

/** 44 in app 0.2+ for a document main placed full height, with the presentation channel to match; else 0. */
export const TOP: Inset = APP?.topInset === TOP_INSET && typeof APP.onPresent === 'function' && typeof APP.presented === 'function' ? TOP_INSET : 0
/** Below the scroll edge: what counts as seen. 0 with no inset (Chrome is unchanged). */
export const VISIBLE_TOP = TOP ? TOP + EDGE_FADE : 0

/** main.tsx, before the first render: the variable every placement reads, on :root. Nothing without the inset. */
export function applyInset(): void {
  if (!TOP) return
  document.documentElement.style.setProperty('--mv-top', `${TOP}px`)
  document.documentElement.classList.add('mv-inset')
}

/** The view below the strip, in client px. */
export function usable(): { top: number; left: number; width: number; height: number } {
  return { top: TOP, left: 0, width: innerWidth, height: Math.max(0, innerHeight - TOP) }
}

/** The part of a client rect on screen below the scroll edge, or null when none is. */
export function onScreen(r: DOMRectReadOnly): DOMRect | null {
  const top = Math.max(r.top, VISIBLE_TOP)
  const bottom = Math.min(r.bottom, innerHeight)
  const left = Math.max(r.left, 0)
  const right = Math.min(r.right, innerWidth)
  return bottom > top && right > left ? new DOMRect(left, top, right - left, bottom - top) : null
}
