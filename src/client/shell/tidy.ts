export interface TidyNode { key: string; scene: string; group?: string; variant?: string; w: number; h: number }
export interface Placed { key: string; x: number; y: number }

// Gaps are PROPORTIONAL to frame size (floored at the classic values): monitor-scale
// frames dwarf fixed gaps, and the zoom-clamped variant text needs its lane to grow
// with the frames it annotates.
const gutter = (w: number) => Math.max(72, w * 0.06)
const badgePad = (w: number) => Math.max(110, w * 0.1)     // grouped frame's badge column
const sceneGap = (h: number) => Math.max(96, h * 0.16)     // vertical: caption line lives here
const sceneRowGap = (w: number) => Math.max(192, w * 0.14) // between scenes sharing a row

/**
 * Pure layout (spec §7 + SPEC-023 §2/§3). Returns positions only - the nodes array is
 * never reordered (iframe law G-1).
 * - Scene order: `sceneRows` rows first (scenes in one row sit side by side);
 *   unlisted scenes append as their own rows, alphabetical.
 * - Within a scene: node order preserved, EXCEPT variant groups, which are placed as
 *   one indivisible run ordered by variant key at the first member's position.
 */
export function tidy(nodes: TidyNode[], sceneRows?: string[][]): Placed[] {
  const present = [...new Set(nodes.map((n) => n.scene))]
  const listed = new Set((sceneRows ?? []).flat())
  const consumed = new Set<string>()                  // a scene listed twice places once
  const rows: string[][] = [
    ...(sceneRows ?? [])
      .map((r) => r.filter((s) => present.includes(s) && !consumed.has(s) && (consumed.add(s), true)))
      .filter((r) => r.length),
    ...present.filter((s) => !listed.has(s)).sort().map((s) => [s]),
  ]

  const out: Placed[] = []
  let y = 0
  for (const row of rows) {
    let x = 0
    let rowH = 0
    for (const scene of row) {
      const members = nodes.filter((n) => n.scene === scene)
      let lastW = 0
      for (const n of orderWithinScene(members)) {
        if (n.group) x += badgePad(n.w)         // the badge floats left of the frame
        out.push({ key: n.key, x, y })
        x += n.w + gutter(n.w)
        lastW = n.w
        rowH = Math.max(rowH, n.h)
      }
      x += sceneRowGap(lastW) - gutter(lastW)   // scene boundary reads wider than a frame gap
    }
    y += rowH + sceneGap(rowH)
  }
  return out
}

/** Scene placement order: appearance order, but a variant group is one contiguous run
 *  (sorted by variant key) at its first member's slot. */
function orderWithinScene(members: TidyNode[]): TidyNode[] {
  const consumed = new Set<string>()
  const ordered: TidyNode[] = []
  for (const n of members) {
    if (consumed.has(n.key)) continue
    if (!n.group) { ordered.push(n); continue }
    const run = members.filter((m) => m.group === n.group)
      .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''))
    for (const m of run) { ordered.push(m); consumed.add(m.key) }
  }
  return ordered
}
