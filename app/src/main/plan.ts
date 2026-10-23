/**
 * The window's layout as a pure function of the model (spec 28 A2.2, A2.11, A2.14 #1, #20, #33). `compose()` in
 * window.ts derives it and applies only what changed, in one turn, so the cover, the views beneath and the tab
 * pages always change together. Pure: unit-tested without Electron.
 *
 * App 0.1 has the opaque strip (A2.14 #1): every view - a canvas, Home, Settings, a tab page - sits below the 44 px
 * strip at `{ x: 0, y: 44, width, height: h - 44 }`, and the cover (main's plain view, in the ground of the active
 * tab's look) is always shown under the strip. The one ground - full-height canvases, insets, presentation epochs,
 * the live-resize rule - is A3's.
 */
export const STRIP_HEIGHT = 44

/** The shell's two grounds (styles.css `--ground`): the cover, the window and every view's background. */
export const GROUND = { light: '#e7e9ef', dark: '#1b1c23' } as const
export const ground = (dark: boolean): string => dark ? GROUND.dark : GROUND.light

export interface Rect { x: number; y: number; width: number; height: number }

export interface PlanTab {
  id: string
  kind: 'local' | 'home' | 'settings'
  /** a content view exists (a canvas, Home or Settings) */
  view: boolean
  /** the tab's own page shows over it (A2.11) */
  page: boolean
  /** a tab page view exists (it may be closing) */
  pageView: boolean
  dark: boolean
}

export interface PlanInput { tabs: PlanTab[]; active: string; w: number; h: number; appDark: boolean }

export interface PlanView { key: string; tab: string; part: 'view' | 'page'; rect: Rect; visible: boolean; color: string }

export interface Plan {
  active: string
  views: PlanView[]
  strip: Rect
  cover: { rect: Rect; visible: boolean; color: string }
}

export const below = (w: number, h: number): Rect => ({ x: 0, y: STRIP_HEIGHT, width: Math.max(0, w), height: Math.max(0, h - STRIP_HEIGHT) })

export function plan(i: PlanInput): Plan {
  const rect = below(i.w, i.h)
  const views: PlanView[] = []
  let activeDark = i.appDark
  for (const t of i.tabs) {
    const on = t.id === i.active
    const color = ground(t.kind === 'local' ? t.dark : i.appDark)
    if (on && t.kind === 'local') activeDark = t.dark
    // a tab page stands over its tab's view: the view is hidden beneath it, off the screen and out of the AX tree
    if (t.view) views.push({ key: `${t.id}:view`, tab: t.id, part: 'view', rect, visible: on && !t.page, color })
    if (t.pageView) views.push({ key: `${t.id}:page`, tab: t.id, part: 'page', rect, visible: on && t.page, color })
  }
  const strip = { x: 0, y: 0, width: Math.max(0, i.w), height: STRIP_HEIGHT }
  return { active: i.active, views, strip, cover: { rect: strip, visible: true, color: ground(activeDark) } }
}
