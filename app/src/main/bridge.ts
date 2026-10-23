/**
 * Channel handlers and the capability map (spec 28 "Channels and who may use them", A2.14 #19, v1.12 r1 #1).
 * Owner: the trust stream.
 *
 * SKELETON (ship stream): the interface. Each webContents main creates is recorded with its kind; a channel
 * is accepted only from the kinds `SENDERS` lists (src/shared/channels.ts), only from that webContents' main
 * frame, for an app page only while its frame's URL is the page's own, with every field checked again here.
 * Canvas messages (src/shared/app-api.ts) are accepted only when stamped with the committed, trusted
 * document's `doc`; `mv:doc` alone answers while untrusted.
 */
import type { WebContents } from 'electron'
import type { PageKind } from '../shared/channels.ts'
import type { Busy, Hello, MenuItem, Theme } from '../../../src/shared/app-api.ts'

/** What the bridge hands the tabs: a canvas document's accepted reports, the latest of each. */
export interface CanvasReports {
  hello?: Hello
  theme?: Theme
  busy?: Busy
  menu?: MenuItem[]
}

export interface Bridge {
  /** record a webContents main created, with its kind (and its tab, for a canvas or a tab page) */
  register(wc: WebContents, kind: PageKind, tabId?: string): void
  /** admit a canvas document at its trusted commit: mints its `doc` and sends `mv:admit` (v1.12 r1 #1) */
  admit(tabId: string): string | null
  /** a new report from a canvas document */
  onReport(fn: (tabId: string, doc: string, r: CanvasReports) => void): () => void
}

/** Installs the IPC handlers, at ready, before any view. */
export function installBridge(): Bridge {
  return {
    register() { /* trust stream */ },
    admit: () => null,
    onReport: () => () => {},
  }
}
