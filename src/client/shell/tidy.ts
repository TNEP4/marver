export interface TidyNode { key: string; scene: string; w: number; h: number }
export interface Placed { key: string; x: number; y: number }

const GUTTER = 72
const SCENE_GAP = 96

/** Pure: rows per scene (scenes alphabetical, node order preserved within a scene). Spec §7. */
export function tidy(nodes: TidyNode[]): Placed[] {
  const scenes = [...new Set(nodes.map((n) => n.scene))].sort()
  const out: Placed[] = []
  let y = 0
  for (const scene of scenes) {
    const row = nodes.filter((n) => n.scene === scene)
    let x = 0
    let rowH = 0
    for (const n of row) {
      out.push({ key: n.key, x, y })
      x += n.w + GUTTER
      rowH = Math.max(rowH, n.h)
    }
    y += rowH + SCENE_GAP
  }
  return out
}
