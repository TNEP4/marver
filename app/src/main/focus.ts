/**
 * One focus rule, and F6 (spec 28 A2.13, A2.14 #25, #33). Owner: the window stream.
 *
 * - Activating a tab (a click, its key, Return in the strip, a notice) focuses what it shows: the canvas view,
 *   Home or Settings, or its tab page's content (its heading region, so VoiceOver reads the state first).
 * - When the focused view goes away - a crash, a closed tab, a view hidden beneath a tab page, a tab page lifting -
 *   focus moves to what now shows for the active tab: its tab page when one appeared, its canvas view when the tab
 *   page lifted, else the strip's active tab. Never to nothing.
 * - F6 moves focus from the active tab's page to the strip's tab and back; ⇧F6 the same toggle (two stops). Caught
 *   in before-input-event (keys.ts), so no page can keep it.
 *
 * No Electron import: the webContents come from window.ts's view registry through the ports.
 */
import type { WebContents } from 'electron'
import type { PageFocus } from '../shared/channels.ts'

/** Who holds focus, from each webContents' own `focus` event. */
export type Owner = { part: 'strip' } | { part: 'content' | 'page'; tab: string }

export interface FocusPorts {
  active(): string | undefined
  strip(): WebContents | undefined
  /** the active tab's visible content view (canvas, Home, Settings), if it shows */
  content(tab: string): WebContents | undefined
  /** the tab's page view, if it shows */
  page(tab: string): WebContents | undefined
  /** `page:focus` to an app page, held until it says ready */
  pageFocus(wc: WebContents, f: PageFocus): void
  log?(topic: string, data: unknown): void
}

let ports: FocusPorts | null = null
let owner: Owner | null = null
/**
 * Spec 32 B14.2: the last owner that was not the strip, kept just before a strip focus replaces it - a right mousedown
 * makes the strip first responder before its `tab:menu` arrives, so main reads here who had focus before the press.
 */
let before: Owner | null = null
export function setFocusPorts(p: FocusPorts): void { ports = p }
export const focusOwner = (): Owner | null => owner
/** Spec 32 B14.2: the last owner that was not the strip (null when none). */
export const beforeStrip = (): Owner | null => before
/** Spec 32 B14: `owner`, set as a webContents' own `focus` event would - keeping `beforeStrip` as `track()` does. */
function own(o: Owner): void {
  if (o.part === 'strip' && owner && owner.part !== 'strip') before = owner
  owner = o
}

/** A view that holds focus while it does not show (beneath a tab page, a hidden tab): never allowed to keep it. */
function misplaced(o: Owner): boolean {
  const p = ports
  if (!p || o.part === 'strip') return false
  return o.tab !== p.active() || (o.part === 'content' ? !p.content(o.tab) : !p.page(o.tab))
}

let moving = false
/**
 * Record each webContents' focus as it happens. Chromium can hand focus back to a view the app has hidden - a
 * crashed canvas's renderer coming back beneath its tab page takes it - so a view that takes focus while it does
 * not show gives it at once to what the active tab shows (A2.11: nothing beneath a tab page).
 */
export function track(wc: WebContents, o: Owner): void {
  wc.on('focus', () => {
    own(o)
    ports?.log?.('focus', o)
    if (!moving && misplaced(o)) {
      moving = true
      try { ports?.log?.('focus', { misplaced: o }); focusShown() } finally { moving = false }
    }
  })
  wc.on('destroyed', () => {
    if (owner && sameOwner(owner, o)) owner = null
    if (before && sameOwner(before, o)) before = null
  })
}

const sameOwner = (a: Owner, b: Owner) => a.part === b.part && (a.part === 'strip' || (b.part !== 'strip' && a.tab === b.tab))

function focusStrip(): void {
  const s = ports?.strip()
  if (!s || s.isDestroyed()) return
  s.focus()
  own({ part: 'strip' })
  ports!.pageFocus(s, { target: 'active-tab' })
  ports!.log?.('focus', { to: owner })
}

/**
 * Spec 32 B14: the strip focused for its Marver menu, with no `page:focus` - which the strip answers by focusing its
 * active tab (pages/strip/main.ts), and so would take focus back from the menu's first row.
 */
export function focusStripQuiet(): void {
  const s = ports?.strip()
  if (!s || s.isDestroyed()) return
  s.focus()
  own({ part: 'strip' })
  ports!.log?.('focus', { to: owner, quiet: true })
}

/** Focus what the active tab shows: its tab page's heading, else its view, else the strip's active tab. */
export function focusShown(): void {
  const p = ports
  if (!p) return
  const id = p.active()
  if (!id) return focusStrip()
  const page = p.page(id)
  if (page && !page.isDestroyed()) {
    page.focus()
    own({ part: 'page', tab: id })
    p.pageFocus(page, { target: 'heading' })
    p.log?.('focus', { to: owner })
    return
  }
  const content = p.content(id)
  if (content && !content.isDestroyed()) { content.focus(); own({ part: 'content', tab: id }); p.log?.('focus', { to: owner }); return }
  focusStrip()
}

/** Step 4 of compose (after the shows, before the hides): the rule, or a directive from an activation. */
export function afterShow(directive?: 'shown'): void {
  const p = ports
  if (!p) return
  if (directive === 'shown') return focusShown()
  if (!owner) return
  if (owner.part === 'strip') return
  const id = p.active()
  const o = owner
  const lost = o.tab !== id
    || (o.part === 'content' && !p.content(o.tab))
    || (o.part === 'page' && !p.page(o.tab))
  if (lost) { p.log?.('focus', { lost: o }); focusShown() }
}

/** F6 and ⇧F6: the strip and the page, one toggle with two stops. */
export function f6(): void {
  if (owner?.part === 'strip') focusShown()
  else focusStrip()
}

/** Test seam. */
export function resetFocus(): void { owner = null; before = null }
