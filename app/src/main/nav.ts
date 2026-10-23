/**
 * The navigation adapter (spec 28 A2.14 #8): Electron 45's navigation events carry no navigation id, so main
 * keeps its own correlation per canvas webContents - a generation bumped at `did-start-navigation` (main
 * frame, cross-document), one attempt per generation, commits attributed to the current generation only.
 * Owner: the trust stream (proof.ts feeds it responses; tabs.ts reads its commits).
 *
 * SKELETON (ship stream): the events and the adapter's interface. The first build proves the event order
 * with traces before any page work (A2.14 #31): overlapping loads of one URL, a redirect, a late failure, a
 * denied link, a refused reload, a stop, a 204, a download.
 */
import type { WebContents } from 'electron'

/** Why an attempt failed, and the tab page it leads to (A2.11): unverified, stopped (elsewhere, gone), unreachable. */
export type FailWhy = 'unverified' | 'elsewhere' | 'gone' | 'unreachable'

/** A final response's outcome, kept only while its stamped generation is current. */
export type Outcome = { kind: 'proved'; url: string; instance: string } | { kind: 'failed'; why: FailWhy }

export interface Attempt {
  gen: number
  /** without the hash; moved by did-redirect-navigation */
  url: string
  outcome?: Outcome
}

export type NavEvent =
  | { kind: 'start'; gen: number; url: string }
  | { kind: 'redirect'; gen: number; url: string }
  | { kind: 'response'; gen: number; outcome: Outcome }
  /** `attributed`: the current attempt proved this URL under the tab's live instance, its proof unused */
  | { kind: 'commit'; gen: number; url: string; attributed: boolean; instance?: string }
  | { kind: 'fail'; gen: number; url: string; why: FailWhy; code: number }
  | { kind: 'abort'; gen: number }

export interface NavAdapter {
  gen(): number
  attempt(): Attempt | undefined
  /** the dispatcher's stamp for a main-frame request (`none` before any start: never counts) */
  stamp(): number | null
  response(gen: number, outcome: Outcome): void
  on(fn: (e: NavEvent) => void): () => void
  dispose(): void
}

export function attachNav(_wc: WebContents): NavAdapter {
  throw new Error('nav.ts: the navigation adapter is the trust stream\'s (spec 28 A2.14 #8)')
}
