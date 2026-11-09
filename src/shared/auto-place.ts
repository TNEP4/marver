/**
 * Where an auto board puts the frames it has not placed yet (friction log #15), one rule for the canvas (store.ts, as it
 * loads a board) and the deck PDF's plan (pdf.ts), so a PDF's reading order is the one Play walks (spec 31 #2).
 *
 * Saved positions are kept. A grouped newcomer lands right of its variant group's rightmost node, on its row; any other
 * goes past the board's right edge, on the top row - never at (0, 0) over a frame already there (the old published
 * everything-board bug). Pure: the caller says each frame's size and builds its node.
 */
export interface PlacedNode { frame: string; x: number; y: number; w: number }
export interface NewcomerFrame { id: string; variantGroup?: string }

/** Append a node for every frame in `frames` not on `nodes` yet, in `frames`' order. Mutates and returns `nodes`. */
export function placeNewcomers<N extends PlacedNode, F extends NewcomerFrame>(
  nodes: N[], frames: readonly F[], size: (f: F) => { w: number; h: number }, make: (f: F, x: number, y: number, w: number, h: number) => N,
): N[] {
  const placed = new Set(nodes.map((n) => n.frame))
  const groupOf = new Map(frames.map((f) => [f.id, f.variantGroup]))
  let maxX = nodes.reduce((a, n) => Math.max(a, n.x + n.w), 0)
  for (const f of frames) {
    if (placed.has(f.id)) continue
    placed.add(f.id)
    const { w, h } = size(f)
    const sibling = f.variantGroup
      ? nodes.filter((n) => groupOf.get(n.frame) === f.variantGroup).reduce<N | null>((a, n) => (!a || n.x + n.w > a.x + a.w ? n : a), null)
      : null
    const x = sibling ? sibling.x + sibling.w + Math.max(140, sibling.w * 0.12) : nodes.length ? maxX + 96 : 0
    const y = sibling ? sibling.y : 0
    nodes.push(make(f, x, y, w, h))
    maxX = Math.max(maxX, x + w)
  }
  return nodes
}
