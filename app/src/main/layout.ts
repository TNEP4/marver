/**
 * The tab's geometry, its one writer (spec 28 A2.2, A3.8 #24, #25, #26). Owner: the one-ground stream. Pure: no
 * Electron import.
 *
 * `commitLayout(tab, event)` is the only writer of `Tab.geo`; `compose()` stays the one writer of native bounds and
 * visibility and places every view from `placed(tab)`. Events come from tabs.ts (the registry's gone and rebind, a
 * commit, a failure, the document gone, the accepted hello) and views.ts (a main-frame navigation's start and abort,
 * HTML fullscreen in and out). The rules, in A3.8 #24-#26:
 * - start: `pending = { gen, instance, layout }`, `full` only for a `ready` instance whose features include
 *   `inset`; a view holding no shown document takes `pending.layout` at once (pre-sized);
 * - commit: `full` only for the pending generation, attributed, on the instance it was meant for and still the
 *   tab's; `pending` and `inset` cleared;
 * - fail: `pending` dropped; `below` only when main positively knows an error page committed (`errorPage`);
 * - abort: that generation's `pending` dropped; rebind, gone: `pending` dropped, the committed layout kept;
 * - hello: `inset`; a `full` layout with inset 0 becomes `below` for the rest of that document;
 * - html-fullscreen: the override `placed()` reads first; renderer-gone, view-gone: `below`, all cleared.
 *
 * FROZEN (A3.8 #53): `LayoutEvent`, `commitLayout`, `placed`, `docInset`, `seeThrough`, `rectFor`. Until the
 * one-ground stream fills `commitLayout`, every tab stays `below` (app 0.1's opaque strip) and `mv:doc` answers 0.
 */
import type { Inset } from '../../../src/shared/app-api.ts'
import { below, type Rect } from './plan.ts'
import type { Layout, Tab } from './tabs.ts'

export type LayoutEvent =
  /** a main-frame, cross-document navigation started (the adapter's `start`) */
  | { kind: 'start'; gen: number }
  | { kind: 'commit'; gen: number; attributed: boolean; instance?: string }
  /** `errorPage`: the main frame's origin read 'null' at did-fail-load (A2.14 v1.13 r2 #3) */
  | { kind: 'fail'; gen: number; errorPage: boolean }
  /** a stop, a superseded or denied navigation, a 204, a download */
  | { kind: 'abort'; gen: number }
  | { kind: 'rebind' }
  | { kind: 'gone' }
  /** the admitted document's accepted hello */
  | { kind: 'hello'; inset: Inset }
  | { kind: 'html-fullscreen'; on: boolean }
  /** a crash; the view closed or unloaded */
  | { kind: 'renderer-gone' }
  | { kind: 'view-gone' }

/** Apply one event to `t.geo`: true when anything changed (the caller composes). */
export function commitLayout(t: Tab, e: LayoutEvent): boolean {
  void t; void e
  return false   // A3 one-ground stream: the rules above
}

/** Where compose places the tab's content view: HTML fullscreen first, then the committed layout. */
export const placed = (t: Tab): Layout => (t.geo.htmlFullscreen ? 'below' : t.geo.layout)

/** `mv:doc`'s inset for the document now committing: 44 when it is placed `full` (its pending, else the committed layout). */
export const docInset = (t: Tab): Inset => ((t.geo.pending?.layout ?? t.geo.layout) === 'full' ? 44 : 0)

/** The cover may lift over the tab's view (decided in main, the exact half): a trusted, lifted, full document that applied the inset. */
export const seeThrough = (t: Tab): boolean => t.kind === 'local' && placed(t) === 'full' && !!t.doc?.trusted && !!t.doc.lifted && t.geo.inset === 44

/** A view's rect in a content area of `w x h`: full `{0, 0, w, h}` or below `{0, 44, w, h - 44}`. */
export function rectFor(t: Tab | 'app-page', w: number, h: number): Rect {
  void t
  return below(w, h)   // A3 one-ground stream: app pages and full layouts at full height
}
