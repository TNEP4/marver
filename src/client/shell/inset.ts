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
 *
 * Amended in writing for spec 32 (C3, F3; Nic, gaps.md 3, 29): `TOP`, `VISIBLE_TOP`, `onScreen()` and `applyInset()`
 * keep their contract, and so does `--mv-top`. Only `usable()` is dynamic, and only in immersive play: once main grants
 * it, `setImmersiveTop(true)` drops the play inset to 0, which `usable()`, `onTopChange` listeners and `--mv-play-top`
 * (read by `.sh-play` alone) follow; every other `var(--mv-top)` consumer keeps 44. Until immersive play is wired
 * (spec 32 W4) nothing calls it, so `usable()` answers `TOP` as before.
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
  // spec 32 C3: the play inset, `TOP` until immersive play drops it (`setImmersiveTop`)
  document.documentElement.style.setProperty('--mv-play-top', `${TOP}px`)
  document.documentElement.classList.add('mv-inset')
}

/** spec 32 C3: the play inset now - `TOP`, or 0 while main has granted immersive play. */
let topNow: Inset = TOP
const topListeners = new Set<() => void>()
/**
 * spec 32 C3: immersive play (granted by main) drops the play inset to 0; only `usable()` and `--mv-play-top` follow it.
 * A no-op without the inset (`TOP` 0: Chrome, a published canvas, app 0.1): both values are then 0.
 */
export function setImmersiveTop(on: boolean): void {
  const next: Inset = on ? 0 : TOP
  if (next === topNow) return
  topNow = next
  document.documentElement.style.setProperty('--mv-play-top', `${next}px`)
  document.documentElement.classList.toggle('mv-immersive', on)
  for (const f of [...topListeners]) { try { f() } catch (err) { console.error(err) } }
}
/** spec 32 C3: told when `setImmersiveTop` changes the play inset; answers what unsubscribes. */
export const onTopChange = (f: () => void): (() => void) => { topListeners.add(f); return () => { topListeners.delete(f) } }

/** The view below the strip, in client px: below `TOP`, or the whole view while immersive (spec 32 C3). */
export function usable(): { top: number; left: number; width: number; height: number } {
  return { top: topNow, left: 0, width: innerWidth, height: Math.max(0, innerHeight - topNow) }
}

/** The part of a client rect on screen below the scroll edge, or null when none is. */
export function onScreen(r: DOMRectReadOnly): DOMRect | null {
  const top = Math.max(r.top, VISIBLE_TOP)
  const bottom = Math.min(r.bottom, innerHeight)
  const left = Math.max(r.left, 0)
  const right = Math.min(r.right, innerWidth)
  return bottom > top && right > left ? new DOMRect(left, top, right - left, bottom - top) : null
}

// dev-only inspection hook for tests (never installed in published builds)
if (typeof window !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) (window as unknown as { __mvInset: unknown }).__mvInset = { TOP, VISIBLE_TOP, usable, onScreen, setImmersiveTop, onTopChange }
