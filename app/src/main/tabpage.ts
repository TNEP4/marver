/**
 * The tab's own page (spec 28 A2.11, A2.14 #21, #22): an app view over a canvas tab with nothing to show,
 * and crash recovery with one owner and a latch. Owner: the window stream.
 *
 * SKELETON (ship stream): the interface. `pageFor(tab)` is a pure function of the record (unit-tested
 * without Electron); `recover` is the only thing that reloads a tab after its renderer went.
 */
import type { TabPageView } from '../shared/channels.ts'
import type { Tab } from './tabs.ts'

/** Why a renderer went, as `recover` records it. The app's own endings (A3's unload, a confirmed force reload) count nothing. */
export type RecoverCause =
  | { kind: 'crash'; reason: string; exitCode: number }
  | { kind: 'app' }

/** The page a tab shows now, or null when its canvas view shows (A2.11's table). `rev` is filled by the sender. */
export function pageFor(_tab: Tab, _now: number): Omit<TabPageView, 'rev'> | null {
  throw new Error('tabpage.ts: pageFor is the window stream\'s (spec 28 A2.11)')
}

/** The only reload after a renderer went: at once for the active tab, on showing for a hidden one; a second crash within 60 s latches. */
export function recover(_tab: Tab, _cause: RecoverCause): void {
  throw new Error('tabpage.ts: recover is the window stream\'s (spec 28 A2.11)')
}
