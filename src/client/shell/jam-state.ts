/**
 * Where Jam's surfaces stand in the shell (spec 27): the one focus panel (a capture's detail, a
 * review, a wrap-up), the lane's selection and its keyboard (`Q`), the review's picture view.
 */
import { create } from 'zustand'

export type Panel = { kind: 'capture' | 'review' | 'wrapup'; id: string } | null

interface JamUi {
  panel: Panel
  /** the tile that opened the panel (or Q's focus) wears the accent ring */
  selected: string | null
  /** the lane has the keyboard (Q) */
  laneKeys: boolean
  /** the review: Both (before and after at once - 0.26.1) | Before | After, the frame tab, the More work composer */
  view: 'both' | 'before' | 'after'
  tab: number
  moreOpen: boolean
  /** bumps when the lane should come back to its right end (a new capture or draft) */
  followEnd: number
  /** the lane's done tiles shown (the Done group opened) - folded into one tile by default (0.26.1) */
  doneOpen: boolean
  /** folding hands a selected done tile's selection to the group (`doneIds`: the tiles it folds) */
  setDoneOpen(open: boolean, doneIds?: string[]): void
  /** the session's sheets (Part 5): the start sheet (J at rest), the wrap-up (J in a session) - or
   *  'wrap-pending': J pressed while a capture recorded, the wrap-up waits for its read-back to close */
  sheet: 'start' | 'wrap' | 'wrap-pending' | null
  setSheet(s: JamUi['sheet']): void
  open(panel: Panel): void
  close(): void
  setLaneKeys(on: boolean): void
  select(id: string | null): void
  flip(): void
  /** a choice in the review's switch: Both, Before or After */
  setView(view: JamUi['view']): void
  setTab(i: number): void
  setMoreOpen(on: boolean): void
  follow(): void
}

export const useJamUi = create<JamUi>((set, get) => ({
  panel: null, selected: null, laneKeys: false, view: 'both', tab: 0, moreOpen: false, followEnd: 0, sheet: null, doneOpen: false,
  setSheet(s) { set({ sheet: s }) },
  // the next card opens on Both, its first frame
  open(panel) { set({ panel, selected: panel?.id ?? get().selected, view: 'both', tab: 0, moreOpen: false }) },
  close() { set({ panel: null, moreOpen: false }) },
  setLaneKeys(on) { set({ laneKeys: on }) },
  // folding: a done tile that was selected hands its selection to the group
  // the selection follows the fold: folding, a selected done tile or the collapse tile hands it to the group; opening,
  // a selected group hands it to the first done tile
  setDoneOpen(open, doneIds = []) {
    set((s) => ({
      doneOpen: open,
      ...(!open && s.selected && (s.selected === DONE_CLOSE || doneIds.includes(s.selected)) ? { selected: DONE_GROUP } : {}),
      ...(open && s.selected === DONE_GROUP ? { selected: doneIds[0] ?? DONE_CLOSE } : {}),
    }))
  },
  select(id) { set({ selected: id }) },
  // B: Both -> Before -> After -> Both
  flip() { set((s) => ({ view: s.view === 'both' ? 'before' : s.view === 'before' ? 'after' : 'both' })) },
  setTab(i) { set({ tab: i }) },
  setView(view) { set({ view }) },
  setMoreOpen(on) { set({ moreOpen: on }) },
  follow() { set((s) => ({ followEnd: s.followEnd + 1 })) },
}))

/** A click somewhere else - the canvas, a frame, inside an interactive frame: the read-back or review open
 *  closes, its tile lets go, and the lane gives the keys back (trial 1: "anywhere on the canvas should
 *  close the review card and deselect the capture card"). Words being edited in the read-back save first:
 *  the field is left before the panel goes. */
export function letGoOfTile() {
  const s = useJamUi.getState()
  if (!s.panel && !s.selected && !s.laneKeys) return
  const a = document.activeElement
  if (a instanceof HTMLElement && a.closest('.jm-focus')) a.blur()
  useJamUi.setState({ panel: null, moreOpen: false, selected: null, laneKeys: false })
}

if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) (window as any).__mvJamUi = useJamUi

// ---- the Done fold (0.26.1): two or more done tiles fold into one, at the lane's left end ------------------

/** The folded group's stop, and the collapse tile's when it is open. */
export const DONE_GROUP = 'jam-done-group'
export const DONE_CLOSE = 'jam-done-close'

/** How the lane shows `items` (oldest first): two or more done ones fold into one group; open, they lead, behind a
 *  collapse tile. `stops`: the lane's keyboard stops in that order. */
export function doneFold<T extends { id: string; state: string }>(items: T[], open: boolean): { fold: boolean; done: T[]; rest: T[]; stops: string[] } {
  const done = items.filter((t) => t.state === 'done')
  const rest = items.filter((t) => t.state !== 'done')
  const fold = done.length >= 2
  const stops = !fold ? items.map((t) => t.id) : open ? [DONE_CLOSE, ...done.map((t) => t.id), ...rest.map((t) => t.id)] : [DONE_GROUP, ...rest.map((t) => t.id)]
  return { fold, done, rest, stops }
}

/** What the Done group holds: "3 captures", "2 captures · 1 record", and "· 4 frames changed" when known. */
export function doneLine(done: { record?: boolean }[], frames: number): string {
  const records = done.filter((t) => t.record).length, captures = done.length - records
  const parts = [captures ? `${captures} capture${captures === 1 ? '' : 's'}` : '', records ? `${records} record${records === 1 ? '' : 's'}` : '', frames ? `${frames} frame${frames === 1 ? '' : 's'} changed` : ''].filter(Boolean)
  return parts.join(' · ')
}

