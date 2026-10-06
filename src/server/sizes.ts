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
import { layoutDocSource, rendersDoc } from './manifest.ts'

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

/** The file as it stands: absent, ok (off-grammar entries dropped), or INVALID - a merge conflict
 *  or a hand edit. An invalid file is never rewritten from a partial view: the API refuses to write
 *  until it is resolved (either side is fine), so no committed height is lost to one measurement. */
export type SizesRead = { state: 'absent' | 'ok' | 'invalid'; heights: Record<string, number> }
export function readSizesFile(root: string): SizesRead {
  const file = sizesPath(root)
  if (!existsSync(file)) return { state: 'absent', heights: {} }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || !raw.heights || typeof raw.heights !== 'object' || Array.isArray(raw.heights)) return { state: 'invalid', heights: {} }
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw.heights)) if (validEntry(k, v)) out[k] = v as number
    return { state: 'ok', heights: out }
  } catch { return { state: 'invalid', heights: {} } }
}

/** Lenient read for the readers (the shell's first layout, the build): an absent or invalid file is
 *  no heights - every frame opens at its placeholder, as before. Never throws. */
export const readSizes = (root: string): Record<string, number> => readSizesFile(root).heights

/** The file's text for a set of heights: sorted keys, one entry per line - a changed height is a
 *  one-line diff, and two branches that measured different frames merge without a conflict. */
export function serializeSizes(heights: Record<string, number>): string {
  const sorted: Record<string, number> = {}
  for (const k of Object.keys(heights).sort()) sorted[k] = heights[k]
  return JSON.stringify({ about: ABOUT, heights: sorted }, null, 2) + '\n'
}

/** Which width a frame measures at on its own (its auto size): the declared viewport's width, else
 *  the Doc layout's. null = not a content frame, or not a frame at all - nothing to keep. */
export type AutoWidth = (frameId: string) => number | null

const keeps = (key: string, autoWidth: AutoWidth): boolean => {
  const m = SIZE_KEY.exec(key)
  return !!m && autoWidth(m[1]) === Number(m[2])
}

/** Merge incoming heights into the current ones, keeping only what a board can use: a content frame
 *  that still exists, at the width it measures at on its own. Everything else is pruned - a deleted
 *  frame, a Doc that went from document to wide. Returns the next map and the keys taken. Pruning
 *  reads only the manifest: whether a frame still renders a Doc is asked on READ (keptSizes), so a
 *  source caught mid-write can hide an entry for one load, never delete it. */
export function mergeSizes(current: Record<string, number>, incoming: Record<string, unknown>, autoWidth: AutoWidth): { next: Record<string, number>; accepted: string[] } {
  const next = Object.fromEntries(Object.entries(current).filter(([k]) => keeps(k, autoWidth)))
  const accepted: string[] = []
  for (const [k, v] of Object.entries(incoming)) {
    if (!validEntry(k, v) || !keeps(k, autoWidth)) continue
    next[k] = v as number
    accepted.push(k)
  }
  return { next, accepted }
}

/** The entries a board can use - what the GET and the build hand the shell: a content frame at its
 *  own width that MEASURES (renders a Doc). A frame that went from a Doc to a bare Md keeps the size
 *  its board gives it, never an old measurement. */
export const keptSizes = (heights: Record<string, number>, autoWidth: AutoWidth, measuring: ReadonlySet<string>): Record<string, number> =>
  Object.fromEntries(Object.entries(heights).filter(([k]) => keeps(k, autoWidth) && measuring.has(k.slice(0, k.lastIndexOf('@')))))

/** The auto width rule over a manifest's frames (the shell's defaultSize, store.ts). */
export function autoWidthOf(frames: { id: string; contentWidth?: number; viewport?: string }[], viewports: Record<string, { width: number }>): AutoWidth {
  const byId = new Map(frames.map((f) => [f.id, f]))
  return (id) => {
    const f = byId.get(id)
    if (!f?.contentWidth) return null
    return viewports[f.viewport ?? '']?.width ?? f.contentWidth
  }
}

export { rendersDoc }

/** The content frames that measure: the frame renders a Doc, or a `_layout` it renders inside does
 *  (manifest.ts layoutDocSource - the same rule the manifest's width follows). A source that cannot
 *  be read, or reads empty (an editor mid-write), gets the benefit of the doubt - this only decides
 *  what a load is handed, never what the file keeps. */
export function measuringFrames(root: string, frames: { id: string; file?: string; kind?: string; contentWidth?: number }[]): Set<string> {
  const out = new Set<string>()
  const memo = new Map<string, string | null>()
  for (const f of frames) {
    if (!f.contentWidth || f.kind === 'html' || !f.file || f.file.split('/').includes('..')) continue
    let src = ''
    try { src = readFileSync(join(root, f.file), 'utf8') } catch { /* unreadable: benefit of the doubt */ }
    if (!src.trim() || rendersDoc(src) || layoutDocSource(root, f.file, memo) !== null) out.add(f.id)
  }
  return out
}
