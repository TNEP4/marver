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
import { codeOnly } from './manifest.ts'

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
 *  the Doc layout's. null = nothing to keep: not a content frame, not a frame at all, or a content
 *  frame that does not render a Doc - only a Doc measures, so only a Doc's height is a fact (a
 *  frame that went from a Doc to a bare Md keeps the size its board gives it, never an old one). */
export type AutoWidth = (frameId: string) => number | null

const keeps = (key: string, autoWidth: AutoWidth): boolean => {
  const m = SIZE_KEY.exec(key)
  return !!m && autoWidth(m[1]) === Number(m[2])
}

/** The entries a board can use - what the GET and the build hand the shell. */
export const keptSizes = (heights: Record<string, number>, autoWidth: AutoWidth): Record<string, number> =>
  Object.fromEntries(Object.entries(heights).filter(([k]) => keeps(k, autoWidth)))

/** Merge incoming heights into the current ones, keeping only what a board can use: a Doc that
 *  still exists, at the width it measures at on its own. Everything else is pruned - a deleted
 *  frame, a Doc that went from document to wide. Returns the next map and the keys taken. */
export function mergeSizes(current: Record<string, number>, incoming: Record<string, unknown>, autoWidth: AutoWidth): { next: Record<string, number>; accepted: string[] } {
  const next = keptSizes(current, autoWidth)
  const accepted: string[] = []
  for (const [k, v] of Object.entries(incoming)) {
    if (!validEntry(k, v) || !keeps(k, autoWidth)) continue
    next[k] = v as number
    accepted.push(k)
  }
  return { next, accepted }
}

/** Does this frame source render a `<Doc>` - the one primitive that measures (content/index.tsx)?
 *  Lexical on the code (comments and strings blanked), like the content scan. */
export const rendersDoc = (src: string): boolean => /<Doc[\s>/]/.test(codeOnly(src))

/** The auto width rule over a manifest's frames (the shell's defaultSize, store.ts), restricted to
 *  frames that render a Doc. `file` is the frame's path from the root (manifest.ts); each source is
 *  read once, on first ask. */
export function autoWidthOf(root: string, frames: { id: string; file?: string; kind?: string; contentWidth?: number; viewport?: string }[], viewports: Record<string, { width: number }>): AutoWidth {
  const byId = new Map(frames.map((f) => [f.id, f]))
  const docs = new Map<string, boolean>()
  const isDoc = (f: { id: string; file?: string; kind?: string }): boolean => {
    let d = docs.get(f.id)
    if (d === undefined) {
      try { d = f.kind !== 'html' && !!f.file && !f.file.split('/').includes('..') && rendersDoc(readFileSync(join(root, f.file), 'utf8')) } catch { d = false }
      docs.set(f.id, d)
    }
    return d
  }
  return (id) => {
    const f = byId.get(id)
    if (!f?.contentWidth || !isDoc(f)) return null
    return viewports[f.viewport ?? '']?.width ?? f.contentWidth
  }
}
