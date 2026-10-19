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
  /** the review: Before | After, the frame tab, the More work composer */
  view: 'after' | 'before'
  tab: number
  moreOpen: boolean
  /** bumps when the lane should come back to its right end (a new capture or draft) */
  followEnd: number
  open(panel: Panel): void
  close(): void
  setLaneKeys(on: boolean): void
  select(id: string | null): void
  flip(): void
  setTab(i: number): void
  setMoreOpen(on: boolean): void
  follow(): void
}

export const useJamUi = create<JamUi>((set, get) => ({
  panel: null, selected: null, laneKeys: false, view: 'after', tab: 0, moreOpen: false, followEnd: 0,
  // the next card opens on After, its first frame
  open(panel) { set({ panel, selected: panel?.id ?? get().selected, view: 'after', tab: 0, moreOpen: false }) },
  close() { set({ panel: null, moreOpen: false }) },
  setLaneKeys(on) { set({ laneKeys: on }) },
  select(id) { set({ selected: id }) },
  flip() { set((s) => ({ view: s.view === 'after' ? 'before' : 'after' })) },
  setTab(i) { set({ tab: i }) },
  setMoreOpen(on) { set({ moreOpen: on }) },
  follow() { set((s) => ({ followEnd: s.followEnd + 1 })) },
}))

/** A click somewhere else - the canvas, a frame, inside an interactive frame: a lane tile selected with
 *  nothing open for it lets go, and the lane gives the keys back. A tile whose read-back or review is
 *  open stays selected with its panel. */
export function letGoOfTile() {
  const s = useJamUi.getState()
  if (!s.panel && (s.selected || s.laneKeys)) useJamUi.setState({ selected: null, laneKeys: false })
}

if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) (window as any).__mvJamUi = useJamUi
