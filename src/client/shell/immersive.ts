/**
 * Immersive play (spec 32 C1, C2, C6): in play - prototype, slides or focus - Hide UI takes the whole window in the Mac
 * app: the strip leaves with the shell's pills and the stage grows into the room they gave back. Canvas mode never is.
 *
 * The rule is derived, never latched. The wish:
 *
 *   wants = TOP === 44 && typeof APP?.immersive === 'function' && isHideUI() && !!play && !useLink.shown
 *
 * read from its three sources - `onHideUI`, the store's `play`, and `useLink`'s `shown` (the stopped state, which changes
 * on its own while the connection is probed) - and sent as `APP.immersive({ on })` on every change of it. Main is the
 * authority (app/src/main/immersive-gate.ts): what the shell shows follows main's answer, never the wish. `granted` is
 * true only after main's `{on: true}` for this document; the inset (C3, `setImmersiveTop`) and the recorder (C11) read
 * it from here. `tight` - play's 24 px margins (C4) - is `granted || (isHideUI() && refused)` where the app speaks
 * immersive, `refused` being main's latest answer a `{on: false}` with no `end` to a wish `on`; elsewhere (Chrome, app
 * 1.1) it is `isHideUI()`, as before. So in the app nothing moves between the H press and main's answer, and the answer
 * moves the margins and the inset in one refit. A wish `off` main has not answered within 1 s is taken as answered
 * `{on: false}`.
 *
 * The ways back the shell owns (C6): an answer `{on: false, end: true}` - main took immersive away while the wish stood -
 * restores the inset and turns Hide UI off while play is still on (never a blind toggle); a `hidden` or `untrusted` app
 * state does the same while immersive (`appStateEnds`). Every exit the shell's own wish drops (H, play left, stopped) is
 * answered with no `end`, so Hide UI stays exactly as that exit left it (C1.2).
 */
import { APP } from './marver-app.ts'
import { TOP, setImmersiveTop } from './inset.ts'
import { isHideUI, onHideUI, toggleHideUI } from './Toolbar.tsx'
import { useStore } from './store.ts'
import { useLink } from './api.ts'

/** How long a wish `off` waits for main's answer before it is taken as answered `{on: false}` (C1). */
export const OFF_WAIT_MS = 1000

/** The app speaks immersive play: the inset is the strip's, and the preload has the method (C1.4: no FEATURE name). */
const speaks = (): boolean => TOP === 44 && typeof APP?.immersive === 'function'

let wish = false              // the wish last sent (none is sent before the first `on`)
let granted = false           // main's `{on: true}` for the wish now standing
let refused = false           // main's latest answer a `{on: false}` with no `end` to a wish `on`
let offTimer: ReturnType<typeof setTimeout> | undefined
let started = false
let shown = { granted: false, tight: false }
const listeners = new Set<() => void>()

/** The wish now, from its three sources (C1). */
export function wants(): boolean {
  return speaks() && isHideUI() && !!useStore.getState().play && !useLink.getState().shown
}
/** Main granted immersive play for this document: the strip is hidden, the play inset is 0 (C3). */
export const isGranted = (): boolean => granted
/** Play's 24 px margins (C4): where the app speaks immersive, at main's answer; elsewhere, Hide UI alone. */
export function tight(): boolean {
  return speaks() ? granted || (isHideUI() && refused) : isHideUI()
}

/** The inset follows `granted`, then whoever listens is told once - one refit for one answer. */
function emit(): void {
  setImmersiveTop(granted)
  const now = { granted, tight: tight() }
  if (now.granted === shown.granted && now.tight === shown.tight) return
  shown = now
  for (const f of [...listeners]) { try { f() } catch (err) { console.error(err) } }
}

/** One of the three sources changed: send the wish when it changed, and re-read `tight` (Hide UI alone moves it in Chrome). */
function sync(): void {
  const w = wants()
  if (w !== wish) {
    wish = w
    clearTimeout(offTimer); offTimer = undefined
    try { APP?.immersive?.({ on: w }) } catch { /* the app went away under the page */ }
    // a wish off main never answers is taken as answered: the inset comes back
    if (!w) offTimer = setTimeout(() => answered({ on: false }), OFF_WAIT_MS)
  }
  emit()
}

/** Main's answer to the latest wish (the preload drops one to an older wish and one for another document, C2). */
function answered(s: { on: boolean; end?: boolean }): void {
  if (!s || typeof s.on !== 'boolean') return
  clearTimeout(offTimer); offTimer = undefined
  if (s.on) {
    // an `on` can only answer an `on`; one that outran a newer `off` grants nothing
    if (wish) { granted = true; refused = false }
  } else {
    granted = false
    refused = !s.end && wish
  }
  emit()
  // C6.6: main took it away while the wish stood - and play is still on: Hide UI goes, so the chrome comes back
  if (s.on === false && s.end === true && useStore.getState().play && isHideUI()) toggleHideUI()
}

/** C6.4, C6.5: the tab was hidden or lost its trust - immersive play ends with Hide UI off, so coming back shows the chrome. */
export function appStateEnds(): void {
  if (granted && isHideUI()) toggleHideUI()
}

/** Subscribes to the three sources and to main's answers; idempotent. app-bridge.ts starts it in the app; the first
 *  `onImmersiveChange` listener starts it anywhere else (Chrome needs `tight` to follow Hide UI). */
export function startImmersive(): void {
  if (started) return
  started = true
  onHideUI(sync)
  useStore.subscribe((s, p) => { if (!!s.play !== !!p.play) sync() })
  useLink.subscribe((s, p) => { if (s.shown !== p.shown) sync() })
  if (speaks() && typeof APP?.onImmersive === 'function') {
    try { APP.onImmersive((s) => answered(s)) } catch { /* no answers: nothing is ever granted */ }
  }
  shown = { granted, tight: tight() }
  sync()
}

/** Told when `granted` or `tight` changes (after the inset moved). Returns the unsubscribe. */
export function onImmersiveChange(f: () => void): () => void {
  startImmersive()
  listeners.add(f)
  return () => { listeners.delete(f) }
}

// dev-only inspection hook for tests (never installed in published builds)
if (typeof window !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __mvImmersive: unknown }).__mvImmersive = { wants, tight, granted: isGranted }
}
