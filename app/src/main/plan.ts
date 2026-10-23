/**
 * The window's layout as a pure function of the model (spec 28 A2.2, A2.11, A2.14 #1, #20, #33, A3.8 #24, #27, #30,
 * #32). `compose()` in window.ts derives it and applies only what changed, in one turn, so the cover, the views
 * beneath and the tab pages always change together. Pure: unit-tested without Electron.
 *
 * The one ground (app 0.2): a canvas whose document applied the top inset runs the window's full height,
 * `{ x: 0, y: 0, width, height: h }`, under the transparent strip; any other canvas sits below it, `{ x: 0, y: 44,
 * width, height: h - 44 }` - shown or hidden alike, so showing a view never resizes it. Home, Settings and every tab
 * page are always full: they paint the ground and still dots under the strip themselves. The cover sits between the
 * views and the strip, over the strip's rect, in the ground of the active tab's look (A2.14 #26), and is:
 * - hidden over Home and Settings with their view, and over a tab page that shows (their own ground is there);
 * - hidden over the active canvas only when it is see-through (layout.ts `seeThrough`), has answered its latest
 *   presentation request (present.ts) and no live resize runs;
 * - shown otherwise: no view yet, a canvas below, a canvas mid-navigation, a document that has not said hello, a
 *   resize, an earlier epoch.
 * "In the same turn" is exact (compose applies the cover with the views beneath); "on the same displayed frame" is
 * promised by nothing (A3.8 #30).
 */
import type { Layout } from './tabs.ts'

export const STRIP_HEIGHT = 44

/** The shell's two grounds (styles.css `--ground`): the cover, the window and every view's background. */
export const GROUND = { light: '#e7e9ef', dark: '#1b1c23' } as const
export const ground = (dark: boolean): string => dark ? GROUND.dark : GROUND.light

export interface Rect { x: number; y: number; width: number; height: number }

export interface PlanTab {
  id: string
  /** a kind the plan does not know (remote, A4) is below and never see-through */
  kind: 'local' | 'home' | 'settings' | (string & {})
  /** a content view exists (a canvas, Home or Settings) */
  view: boolean
  /** the tab's own page shows over it (A2.11) */
  page: boolean
  /** a tab page view exists (it may be closing) */
  pageView: boolean
  dark: boolean
  /** layout.ts `placed()` for a canvas (HTML fullscreen first); Home and Settings are full whatever it says */
  placed?: Layout
  /** layout.ts `seeThrough()`: the cover may lift over this tab's view */
  seeThrough?: boolean
  /** present.ts `observe()` for the active view: its latest epoch answered at its size; false for every other */
  presented?: boolean
}

export interface PlanInput {
  tabs: PlanTab[]
  active: string
  w: number
  h: number
  appDark: boolean
  /** a person's live resize (will-resize .. resized): covered throughout, no request (A3.8 #28) */
  resizing?: boolean
}

export interface PlanView { key: string; tab: string; part: 'view' | 'page'; rect: Rect; visible: boolean; color: string }

export interface Plan {
  active: string
  views: PlanView[]
  strip: Rect
  cover: { rect: Rect; visible: boolean; color: string; dark: boolean }
}

export const below = (w: number, h: number): Rect => ({ x: 0, y: STRIP_HEIGHT, width: Math.max(0, w), height: Math.max(0, h - STRIP_HEIGHT) })
export const full = (w: number, h: number): Rect => ({ x: 0, y: 0, width: Math.max(0, w), height: Math.max(0, h) })

const appPage = (t: PlanTab) => t.kind === 'home' || t.kind === 'settings'

export function plan(i: PlanInput): Plan {
  const views: PlanView[] = []
  let activeDark = i.appDark
  let covered = true
  const whole = full(i.w, i.h)
  for (const t of i.tabs) {
    const on = t.id === i.active
    const local = t.kind === 'local'
    const color = ground(local ? t.dark : i.appDark)
    if (on && local) activeDark = t.dark
    // a canvas where its layout says, shown or hidden alike; Home and Settings full; anything else below
    const rect = appPage(t) || (local && t.placed === 'full') ? whole : below(i.w, i.h)
    // a tab page stands over its tab's view: the view is hidden beneath it, off the screen and out of the AX tree
    const viewShown = on && !t.page
    if (t.view) views.push({ key: `${t.id}:view`, tab: t.id, part: 'view', rect, visible: viewShown, color })
    if (t.pageView) views.push({ key: `${t.id}:page`, tab: t.id, part: 'page', rect: whole, visible: on && t.page, color })
    if (!on) continue
    if (t.page && t.pageView) covered = false                                  // the tab page paints its own ground there
    else if (appPage(t) && t.view) covered = false                             // so do Home and Settings
    else if (local && t.view && t.placed === 'full' && t.seeThrough && t.presented && !i.resizing) covered = false
  }
  const strip = { x: 0, y: 0, width: Math.max(0, i.w), height: STRIP_HEIGHT }
  return { active: i.active, views, strip, cover: { rect: strip, visible: covered, color: ground(activeDark), dark: activeDark } }
}
