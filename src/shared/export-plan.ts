/**
 * The export plan (spec 31 Part A #2): which frames a board prints, in which order, at which size and theme. One
 * definition, read by the PDF (src/server/pdf.ts) and by Play (src/client/shell/Play.tsx), so a deck's pages and the
 * stage never disagree.
 *
 * - a *slides* board (it plays as slides: its publish policy says `type: slides` or `open: slides`) prints its deck:
 *   slide frames in reading order (y, then x), deduped - `deckOrder`, the order slides mode plays;
 * - any other board prints its nodes in the board's own order (Play's order), deduped, html frames included (Play
 *   cannot mount them on its stage; the PDF prints them from their own document);
 * - a page is the size the stage shows: a `slide: true` frame's stage (`slideSize`) on any board, else the device Play
 *   picks for the node - the viewport whose width is the node's, else the frame's declared viewport, else the first -
 *   at that viewport's height;
 * - its theme: the export's own when one is asked, else the node's, else the frame's, else light;
 * - a node whose frame the manifest does not list is skipped, and named.
 *
 * Pure and dependency-free (beyond the two shared rules it composes), so the server, the shell and the tests import it.
 */
import { deckOrder, type OrderFrame, type OrderNode } from '../client/shell/play-order.ts'
import { slideSize } from '../client/const.ts'

export type Viewports = Record<string, { width: number; height: number }>
export interface PlanFrame extends OrderFrame { viewport?: string; theme?: string; title?: string; file?: string }
export interface PlanNode extends OrderNode {
  /** the node's width on the board, when it has one - names the device Play shows it at */
  w?: number
  /** the node's own theme, as the person pinned it (`themeUser`), when there is one */
  theme?: string
}
export interface PlanPage {
  frame: string
  kind: 'tsx' | 'html'
  width: number
  height: number
  theme: string
  /** the frame's title, else its id's last part made readable - a bookmark's name */
  title: string
  /** the viewport the page is printed at, for a non-slide frame */
  device?: string
}
export interface Plan { pages: PlanPage[]; skipped: { frame: string; why: 'missing' | 'not a slide' }[] }

/** The device Play shows a node at (spec 31 #2): the viewport whose width is the node's, else the frame's declared
 *  viewport, else the first. Undefined only when the project has no viewport at all. */
export function presentDevice(node: { w?: number } | undefined, frame: { viewport?: string } | undefined, viewports: Viewports): string | undefined {
  const names = Object.keys(viewports)
  return (node?.w !== undefined ? names.find((v) => viewports[v].width === node.w) : undefined)
    ?? (frame?.viewport && viewports[frame.viewport] ? frame.viewport : names[0])
}

/** A board's frames in its own order, deduped, its missing ones skipped - Play's list (`html: false`, what its stage can
 *  mount) and the PDF's (`html: true`). */
export function boardOrder<N extends { frame: string; missing?: boolean }>(nodes: N[], frameOf: (n: N) => OrderFrame | undefined, o: { html: boolean }): N[] {
  const seen = new Set<string>()
  const out: N[] = []
  for (const n of nodes) {
    if (n.missing || seen.has(n.frame)) continue
    const f = frameOf(n)
    if (!f || (!o.html && f.kind !== 'tsx')) continue
    seen.add(n.frame)
    out.push(n)
  }
  return out
}

/** A frame's title, else its id's last part with spaces for dashes (as Play's pill names a frame). */
export const titleOf = (f: { id: string; title?: string }): string => f.title?.trim() || (f.id.split('/').pop() ?? f.id).replace(/-/g, ' ')

/** The plan for one board (spec 31 #2). `theme` is the export's own (`--theme`), when one was asked. */
export function exportPlan(o: { slides: boolean; nodes: PlanNode[]; frames: PlanFrame[]; viewports: Viewports; theme?: string }): Plan {
  const byId = new Map(o.frames.map((f) => [f.id, f]))
  const skipped: Plan['skipped'] = []
  const seenMissing = new Set<string>()
  for (const n of o.nodes) if (!byId.has(n.frame) && !seenMissing.has(n.frame)) { seenMissing.add(n.frame); skipped.push({ frame: n.frame, why: 'missing' }) }
  const page = (f: PlanFrame, node: PlanNode | undefined): PlanPage | null => {
    const theme = o.theme ?? node?.theme ?? f.theme ?? 'light'
    const sl = slideSize(f, o.viewports)
    if (sl) return { frame: f.id, kind: f.kind, width: sl.width, height: sl.height, theme, title: titleOf(f) }
    const device = presentDevice(node, f, o.viewports)
    const vp = device ? o.viewports[device] : undefined
    if (!vp) return null
    return { frame: f.id, kind: f.kind, width: vp.width, height: vp.height, theme, title: titleOf(f), device }
  }
  const pages: PlanPage[] = []
  if (o.slides) {
    const { deck, excluded } = deckOrder(o.nodes.map((n) => ({ ...n, missing: n.missing || !byId.has(n.frame) })), byId)
    for (const id of excluded) skipped.push({ frame: id, why: 'not a slide' })
    for (const id of deck) {
      const p = page(byId.get(id)!, o.nodes.find((n) => n.frame === id))
      if (p) pages.push(p)
    }
  } else {
    for (const n of boardOrder(o.nodes, (x) => byId.get(x.frame), { html: true })) {
      const p = page(byId.get(n.frame)!, n)
      if (p) pages.push(p)
    }
  }
  return { pages, skipped }
}
