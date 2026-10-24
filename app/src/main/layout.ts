/**
 * The tab's geometry, its one writer (spec 28 A2.2, A3.8 #24, #25, #26). Owner: the one-ground stream. Pure: no
 * Electron import.
 *
 * `commitLayout(tab, event)` is the only writer of `Tab.geo`; `compose()` stays the one writer of native bounds and
 * visibility and places every view from `placed(tab)`. Events come from tabs.ts (the registry's gone and rebind, a
 * commit, a failure, the document gone, the accepted hello) and views.ts (a main-frame navigation's start and abort,
 * HTML fullscreen in and out). The rules, in A3.8 #24-#26:
 * - start: `pending = { gen, instance, layout }`, `full` only for a `ready` instance whose features include
 *   `inset` (and only while the window has a cover that can cover a full-height view: `setGround`, below); a view
 *   holding no shown document takes `pending.layout` at once (pre-sized, so its first layout has its final size);
 * - commit: `full` only for the pending generation, attributed, on the instance it was meant for and still the
 *   tab's; `pending` and `inset` cleared (the new document has not spoken), and `htmlFullscreen` too: a document
 *   just committed holds no fullscreen element, and Electron can send `enter-html-full-screen` for a request that
 *   never became fullscreen and no leave after it - kept, it held the view below and covered through every reload
 *   until a crash or a close (a late leave event clears nothing more);
 * - fail: `pending` dropped; `below` only when main positively knows an error page committed (`errorPage`), which
 *   clears `inset` and `htmlFullscreen` as a commit does; otherwise the committed geometry stays (A3.8 #25: a
 *   failure alone proves no error page);
 * - abort: that generation's `pending` dropped, nothing else;
 * - rebind, gone: the pending generation kept, but `below` (a documentless view pre-sized to it), the committed layout
 *   of a shown or retained document kept (trust is revoked elsewhere, so the page is covered). Kept, not dropped:
 *   `mv:doc` reads `pending` first, and after a cross-process load or a crash reload the new document can ask before
 *   main has handled its commit - a dropped pending fell back to the old document's `full` and told it 44, then the
 *   commit (which needs a `full` pending) placed it below with the inset applied. Below it is told 0 and lands below.
 *   Not closed: a rebind between the document's `mv:doc` and main's handling of its commit - it was told 44 for the
 *   instance it started on, and the commit lands below (a document told is never told again);
 * - hello: `inset`; a `full` layout with inset 0 becomes `below` for the rest of that document (a late hello is the
 *   same rule; a hello never moves a document back to `full`);
 * - html-fullscreen: the override `placed()` reads first; renderer-gone, view-gone: `below`, all cleared.
 *
 * **The ground gate** (A3.8 #3): a canvas runs at full height only over a cover that spike S15 showed can sit over
 * a full-height web view, and only while that cover covers (`setCoverReady`: S15's variant 3 waits on its renderer). Until window.ts has one (`setGround(true)`, from cover.ts's `makeCover`), every start
 * pends `below`, so `mv:doc` answers 0, a 0.27.2 shell applies no inset, and app 0.2 keeps app 0.1's look for
 * canvases while every other rule here runs as written. A test build may turn it on to drive main's half.
 *
 * FROZEN (A3.8 #53): `LayoutEvent`, `commitLayout`, `placed`, `docInset`, `seeThrough`, `rectFor`.
 */
import type { Inset } from '../../../src/shared/app-api.ts'
import { below, full, type Rect } from './plan.ts'
import type { Geometry, Layout, Tab } from './tabs.ts'

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

// ---- the gate and the journal ------------------------------------------------------------------------------

let ground = false
/** window.ts, once it knows whether its cover can cover a full-height view (S15's, A3.8 #3). */
export function setGround(on: boolean): void { ground = on }
/** A canvas may be placed full height now. */
export const groundOn = (): boolean => ground

/**
 * Whether the cover covers now (cover.ts `coverReady`; S15, 24 Oct): variant 3 covers only once its renderer has
 * presented, and again only after it presents following its renderer's loss or the GPU process's. While it does not,
 * every canvas is placed below the strip (app 0.1's opaque layout) whatever its committed layout: a document told 44
 * keeps its inset and shows the band of its own ground under the strip's line, never a canvas under the tabs with
 * nothing over it. window.ts sets it from the cover's `onReady`; true where no cover waits on a renderer.
 */
let covering = true
export function setCoverReady(on: boolean): void { covering = on }
export const coverCovers = (): boolean => covering

let insetOff = false
/**
 * A test build's switch (A3.8 #51, the scroll edge's cost): `mv:doc` answers 0 to every document, so the same board pans
 * with the inset and without it. Never set in a release (window.ts's `ground:inset-off` hook, test mode only). A
 * confound for the recorder stream: a document told 0 says hello 0 and is moved below, so the run without the band
 * also paints a viewport 44 px shorter - the A/B compares TOP 44 at full height with TOP 0 at h - 44, a bias that can
 * only make the band look dearer than it is.
 */
export function setInsetOff(on: boolean): void { insetOff = on }

type LayoutLog = (d: { tab: string; event: string; from: Geometry; to: Geometry }) => void
let log: LayoutLog | null = null
/** The journal's `layout` topic (test builds): every commitLayout that changed something. */
export function onLayoutChange(fn: LayoutLog | null): void { log = fn }

// ---- the rules ---------------------------------------------------------------------------------------------

const BLANK: Geometry = { layout: 'below', htmlFullscreen: false }
/** The geometry without its optional parts named. */
function without(g: Geometry, ...keys: ('pending' | 'inset')[]): Geometry {
  const o = { ...g }
  for (const k of keys) delete o[k]
  return o
}

/** What the tab's canvas offers for the document a navigation starts now. */
function startLayout(t: Tab): Layout {
  return ground && t.kind === 'local' && t.reg?.state === 'ready' && t.reg.features.includes('inset') ? 'full' : 'below'
}

function next(t: Tab, e: LayoutEvent): Geometry {
  const g = t.geo
  switch (e.kind) {
    case 'start': {
      const pending = { gen: e.gen, instance: t.reg?.instance ?? '', layout: startLayout(t) }
      // a view holding no shown document (never shown, beneath its tab page, after a crash): its first document
      // lays out at its final size. A shown or retained document's geometry still changes only at its commit
      return t.retained ? { ...g, pending } : { ...g, pending, layout: pending.layout }
    }
    case 'commit': {
      const p = g.pending
      const ok = !!p && p.gen === e.gen && p.layout === 'full' && e.attributed && !!e.instance
        && e.instance === p.instance && e.instance === t.reg?.instance
      return { ...without(g, 'pending', 'inset'), layout: ok ? 'full' : 'below', htmlFullscreen: false }
    }
    case 'fail': {
      return e.errorPage ? { ...without(g, 'pending', 'inset'), layout: 'below', htmlFullscreen: false } : without(g, 'pending')
    }
    case 'abort': {
      return g.pending?.gen === e.gen ? without(g, 'pending') : g
    }
    case 'rebind':
    case 'gone': {
      if (!g.pending) return g
      const pending = { ...g.pending, layout: 'below' as const }
      return t.retained ? { ...g, pending } : { ...g, pending, layout: 'below' }
    }
    case 'hello':
      return { ...g, inset: e.inset, layout: g.layout === 'full' && e.inset === 0 ? 'below' : g.layout }
    case 'html-fullscreen':
      return { ...g, htmlFullscreen: e.on }
    case 'renderer-gone':
    case 'view-gone':
      return { ...BLANK }
  }
}

const same = (a: Geometry, b: Geometry): boolean => a.layout === b.layout && a.inset === b.inset && a.htmlFullscreen === b.htmlFullscreen
  && a.pending?.gen === b.pending?.gen && a.pending?.instance === b.pending?.instance && a.pending?.layout === b.pending?.layout

/** Apply one event to `t.geo`: true when anything changed (the caller composes). */
export function commitLayout(t: Tab, e: LayoutEvent): boolean {
  const from = t.geo ?? { ...BLANK }
  if (!t.geo) t.geo = from
  const to = next(t, e)
  if (same(from, to)) return false
  t.geo = to
  log?.({ tab: t.id, event: e.kind, from, to })
  return true
}

/** Where compose places the tab's content view: HTML fullscreen first, then a cover that does not cover yet, then the committed layout. */
export const placed = (t: Tab): Layout => (t.geo.htmlFullscreen || !covering ? 'below' : t.geo.layout)

/** `mv:doc`'s inset for the document now committing: 44 when it is placed `full` (its pending, else the committed layout). */
export const docInset = (t: Tab): Inset => (!insetOff && (t.geo.pending?.layout ?? t.geo.layout) === 'full' ? 44 : 0)

/** The cover may lift over the tab's view (decided in main, the exact half): a trusted, lifted, full document that applied the inset. */
export const seeThrough = (t: Tab): boolean => t.kind === 'local' && placed(t) === 'full' && !!t.doc?.trusted && !!t.doc.lifted && t.geo.inset === 44

/**
 * A view's rect in a content area of `w x h`: full `{0, 0, w, h}` or below `{0, 44, w, h - 44}`. The app's own pages
 * (Home, Settings, a tab page) are always full: they paint the ground and still dots under the strip themselves, and
 * keep everything to read or click 44 px down (A3.8 #32). A canvas is where `placed()` says; a kind the plan does not
 * know (remote, A4) is below.
 */
export function rectFor(t: Tab | 'app-page', w: number, h: number): Rect {
  if (t === 'app-page' || t.kind === 'home' || t.kind === 'settings') return full(w, h)
  return t.kind === 'local' && placed(t) === 'full' ? full(w, h) : below(w, h)
}
