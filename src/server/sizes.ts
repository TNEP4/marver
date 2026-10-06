/**
 * Content-frame heights - `design/boards/_sizes.json`, committed.
 *
 * A content frame (a Doc: markdown, diagrams, images) is as tall as its content, which only a
 * render can tell. Measured live, every load started from a guess (3/4 of the width) and grew
 * frame by frame, and each growth re-flowed the rows below - the board swam for seconds. The
 * height a frame measured at its own width is a fact about the FRAME at that width, not about a
 * board (one doc sits on several boards) and not something to write into the frame's source: so
 * it lives here, one line per `scene/frame@width`, written by the dev server when the shell
 * reports a settled measurement, read before the first layout - dev, `marver build` and the
 * published canvas alike. A stale entry is still the best first guess; the live measurement
 * corrects it and the file follows. Underscore = infrastructure, never a board (board-tree.ts).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SIZES_FILE = '_sizes.json'
/** `scene/frame@width` - the frame id grammar the focus route accepts, then the width it was measured at. */
export const SIZE_KEY = /^([\w./-]{1,200})@(\d{2,4})$/
/** The shell's own clamp (store.ts measureNode). */
export const SIZE_MIN = 80
export const SIZE_MAX = 40_000
/** One write carries at most this many heights (a board of Docs settles in one or two). */
export const SIZES_BATCH_MAX = 500
const ABOUT = 'Written by marver dev: the height each content frame measured at its width, so boards open at their final size. Commit it; never edit it by hand.'

export const sizesPath = (root: string): string => join(root, 'design', 'boards', SIZES_FILE)

/** A valid entry: a well-formed key whose frame is not a traversal, and a height in the shell's clamp. */
export function validEntry(key: unknown, h: unknown): boolean {
  if (typeof key !== 'string' || typeof h !== 'number' || !Number.isInteger(h) || h < SIZE_MIN || h > SIZE_MAX) return false
  const m = SIZE_KEY.exec(key)
  return !!m && !m[1].split('/').some((p) => p === '..' || p === '.' || p === '')
}

/** Lenient read: absent, malformed (a merge conflict, a hand edit) or off-grammar entries read as
 *  nothing - the next settled measurement rewrites the file clean. Never throws. */
export function readSizes(root: string): Record<string, number> {
  const file = sizesPath(root)
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const heights = raw && typeof raw === 'object' && raw.heights && typeof raw.heights === 'object' ? raw.heights : {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(heights)) if (validEntry(k, v)) out[k] = v as number
    return out
  } catch { return {} }
}

/** The file's text for a set of heights: sorted keys, one entry per line - a changed height is a
 *  one-line diff, and two branches that measured different frames merge without a conflict. */
export function serializeSizes(heights: Record<string, number>): string {
  const sorted: Record<string, number> = {}
  for (const k of Object.keys(heights).sort()) sorted[k] = heights[k]
  return JSON.stringify({ about: ABOUT, heights: sorted }, null, 2) + '\n'
}

/** Which width a frame measures at on its own (its auto size): the declared viewport's width, else
 *  the Doc layout's. null = not a content frame (or not a frame at all) - nothing to keep. */
export type AutoWidth = (frameId: string) => number | null

/** Merge incoming heights into the current ones, keeping only what a board can use: a content frame
 *  that still exists, at the width it measures at on its own. Everything else is pruned - a deleted
 *  frame, a Doc that went from document to wide. Returns the next map and the keys taken. */
export function mergeSizes(current: Record<string, number>, incoming: Record<string, unknown>, autoWidth: AutoWidth): { next: Record<string, number>; accepted: string[] } {
  const keep = (key: string): boolean => {
    const m = SIZE_KEY.exec(key)
    return !!m && autoWidth(m[1]) === Number(m[2])
  }
  const next: Record<string, number> = {}
  for (const [k, v] of Object.entries(current)) if (keep(k)) next[k] = v
  const accepted: string[] = []
  for (const [k, v] of Object.entries(incoming)) {
    if (!validEntry(k, v) || !keep(k)) continue
    next[k] = v as number
    accepted.push(k)
  }
  return { next, accepted }
}

/** The auto width rule over a manifest's frames (the shell's defaultSize, store.ts). */
export function autoWidthOf(frames: { id: string; contentWidth?: number; viewport?: string }[], viewports: Record<string, { width: number }>): AutoWidth {
  const byId = new Map(frames.map((f) => [f.id, f]))
  return (id) => {
    const f = byId.get(id)
    if (!f?.contentWidth) return null
    return viewports[f.viewport ?? '']?.width ?? f.contentWidth
  }
}
