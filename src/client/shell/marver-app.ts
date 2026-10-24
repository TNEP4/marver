/**
 * `window.marverApp` - there only when this page is a verified local canvas in the Mac app (spec 28 A2.9; the app's
 * canvas preload exposes it). Everywhere else - Chrome, Safari, a published canvas, `marver shot` - it is null, and
 * nothing that reads it does anything. Kept apart from app-bridge.ts, so the canvas can read `reopen` without
 * importing the bridge.
 */
import type { MarverAppV1 } from '../../shared/app-api.ts'

/** The app's bridge, when it speaks this version of the contract and has every method this shell calls. */
export const APP: MarverAppV1 | null = (() => {
  try {
    const a = (globalThis as { marverApp?: Partial<MarverAppV1> }).marverApp
    if (!a || a.v !== 1) return null
    const calls = ['hello', 'theme', 'busy', 'menu', 'onAppState', 'onMenuClick'] as const
    return calls.every((k) => typeof a[k] === 'function') ? a as MarverAppV1 : null
  } catch { return null }
})()

/** The app reloaded this tab after a crash: the canvas opens on its saved camera, even when the link names a
 *  selection (A2.14 #9). */
export const APP_REOPEN = APP?.reopen === true
