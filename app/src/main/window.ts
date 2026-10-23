/**
 * The window (spec 28 A2.2, A2.14 #1, #20, #33). Owner: the window stream.
 *
 * SKELETON (ship stream): a blank `BaseWindow` with the strip's geometry, so the first integration step - "a
 * signed blank window with the guard" (A2.14 #32) - runs. To build: the strip view (transparent, 44 px, the
 * only drag region, always on top), the cover (main's plain view, always shown in app 0.1), every other view
 * below the strip at `{ x: 0, y: 44, width, height: h - 44 }`, `compose()` as the one writer of bounds and
 * visibility, layout on resize (and again after a setTimeout(0)) and full screen, focus dimming, window place
 * (`name: 'main'`), close hides the window, quit through `guardAll({ kind: 'quit' })`.
 *
 * The skeleton shows its window without taking focus (`showInactive`), so the packaged smoke's launches never
 * steal the keyboard from whoever is at the Mac. How the real window shows and focuses is the window stream's.
 */
import { BaseWindow } from 'electron'

export const STRIP_HEIGHT = 44
/** the traffic lights centred in the strip (research c S1) */
const LIGHTS = { x: 14, y: 14 }

let win: BaseWindow | null = null

export function openWindow(): BaseWindow {
  win = new BaseWindow({
    width: 1280, height: 820, minWidth: 720, minHeight: 480,
    titleBarStyle: 'hidden', trafficLightPosition: LIGHTS,
    backgroundColor: '#e7e9ef', show: false, title: 'Marver',
  })
  win.on('closed', () => { win = null })
  win.showInactive()
  return win
}

export const mainWindow = (): BaseWindow | null => win

/** A second launch focuses the window (A2.1). */
export function focusWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** The one writer of bounds and visibility (A2.14 #20): every handler changes the model, then calls it. */
export function compose(): void { /* the window stream */ }
