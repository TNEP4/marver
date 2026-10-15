/**
 * Where comment markers sit (spec 26, Part 6): no two overlap, and they stay put.
 *
 * Each thread has a fixed attach point (its element's first line end, or where a person clicked);
 * the marker is placed near it. Placement uses ONE marker size in screen space - the face (avatars,
 * a count) draws inside it - so a reply or a new participant never moves anything. One pass in
 * thread creation order moves a marker that would touch an earlier one down by its height plus
 * 6 px; a moved marker keeps a thin line to its point. Threads with no point - legacy frame-level
 * pins, orphans whose element is gone - line up in a column down from the frame's top-right corner.
 *
 * Pure: the canvas (node px, `inv` = world px per screen px) and the stage (screen px, inv 1) call
 * the same function, and the tests read it directly.
 */

/** The marker's box in screen px (CSS `.cm-pin` keeps its face inside it) and the gap between two. */
export const MARKER = { w: 80, h: 34, gap: 6 }

/** A placed marker: its tail (bottom-left, where `.cm-pin` hangs from) and, when it was moved off
 *  its point, the point the leader line runs up to. */
export interface Placed { x: number; y: number; lead?: { x: number; y: number }; column: boolean }

export function placeMarkers(items: readonly { id: string; point: { x: number; y: number } | null }[], frameW: number, inv: number): Map<string, Placed> {
  const w = MARKER.w * inv, h = MARKER.h * inv, gap = MARKER.gap * inv, tail = 2 * inv
  const boxes: { l: number; r: number; t: number; b: number }[] = []
  const out = new Map<string, Placed>()
  let slot = 0
  for (const it of items) {
    // a column slot hangs its box from the frame's top-right corner, 8 px in
    const x = it.point ? it.point.x : frameW - 8 * inv - w + tail
    let y = it.point ? it.point.y : 8 * inv + h + slot++ * (h + gap)
    const touches = () => boxes.some((o) => x - tail < o.r + gap && o.l < x - tail + w + gap && y - h < o.b + gap && o.t < y + gap)
    for (let i = 0; i < 500 && touches(); i++) y += h + gap
    boxes.push({ l: x - tail, r: x - tail + w, t: y - h, b: y })
    out.set(it.id, { x, y, column: !it.point, ...(it.point && y !== it.point.y ? { lead: it.point } : {}) })
  }
  return out
}
