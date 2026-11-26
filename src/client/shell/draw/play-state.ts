/**
 * Which drawing is in play (spec 38) - and, since spec 39 B5, which node of the board it was played from: comments
 * support several nodes showing one frame, and a comment made in play belongs to that node on the current board (so a
 * published write goes to a board the viewer may comment on). Its own module so the comment layer can read it without
 * importing drawing play.
 */
import { create } from 'zustand'

export const useDrawPlay = create<{ at: string | null; node: string | null; open(id: string, node?: string | null): void; close(): void }>((set) => ({
  at: null,
  node: null,
  open: (id, node = null) => set({ at: id, node }),
  close: () => set({ at: null, node: null }),
}))
