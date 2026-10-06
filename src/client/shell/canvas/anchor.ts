/**
 * Scroll anchoring for the canvas - the browser's `overflow-anchor`, for a board.
 *
 * A content frame that measures taller re-flows the rows below it (store.ts scheduleReflow). The
 * human did not ask for that, so the camera answers it: before the reflow, remember the node they
 * are looking at - the selected one if it is on screen, else the one nearest the middle of the
 * view - and after it, move the camera by exactly that node's displacement. What they were reading
 * stays put; the rest of the board moves around it. Pure math here; Canvas.tsx owns the camera.
 */

const HEADER = 28   // FrameNode's header: a node's box is h + HEADER tall on the canvas

export interface AnchorNode { key: string; x: number; y: number; w: number; h: number }
export interface Held { key: string; x: number; y: number }
export interface Camera { positionX: number; positionY: number; scale: number }

/** The node to hold still, or null when nothing of the board is on screen. */
export function anchorNode(st: { nodes: readonly AnchorNode[]; selection: readonly string[] }, cam: Camera, vw: number, vh: number): Held | null {
  const { positionX: tx, positionY: ty, scale: s } = cam
  const box = (n: AnchorNode) => ({ l: n.x * s + tx, t: n.y * s + ty, r: (n.x + n.w) * s + tx, b: (n.y + n.h + HEADER) * s + ty })
  const onScreen = (n: AnchorNode) => { const r = box(n); return r.l < vw && r.t < vh && r.r > 0 && r.b > 0 }
  const primary = st.nodes.find((n) => n.key === st.selection[st.selection.length - 1])
  let pick: AnchorNode | undefined = primary && onScreen(primary) ? primary : undefined
  if (!pick) {
    let best = Infinity
    for (const n of st.nodes) {
      if (!onScreen(n)) continue
      const r = box(n)
      // distance from the view's middle to the node's box (0 inside it), then its centre for ties
      const dx = Math.max(r.l - vw / 2, 0, vw / 2 - r.r), dy = Math.max(r.t - vh / 2, 0, vh / 2 - r.b)
      const d = Math.hypot(dx, dy) * 1e6 + Math.hypot((r.l + r.r) / 2 - vw / 2, (r.t + r.b) / 2 - vh / 2)
      if (d < best) { best = d; pick = n }
    }
  }
  return pick ? { key: pick.key, x: pick.x, y: pick.y } : null
}

/** The camera position that puts the held node back where it was on screen, at the same zoom. */
export function anchoredCamera(held: Held, now: { x: number; y: number }, positionX: number, positionY: number, scale: number): [number, number] {
  return [positionX - (now.x - held.x) * scale, positionY - (now.y - held.y) * scale]
}
