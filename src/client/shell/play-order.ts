/** The deck order (v1.5), pure: slide tsx frames in the board's reading
 *  order - (y, then x, then original index), deduped by frame id. Excluded
 *  frames come back for a ONE-TIME warning at entry; this file stays
 *  dependency-free so unit tests import it without React or virtual modules. */
export interface OrderNode { frame: string; x: number; y: number; missing?: boolean }
export interface OrderFrame { id: string; kind: 'tsx' | 'html'; slide?: boolean }

export function deckOrder(
  nodes: OrderNode[], frames: Map<string, OrderFrame>,
): { deck: string[]; excluded: string[] } {
  const rows = nodes
    .map((n, i) => ({ n, i, f: frames.get(n.frame) }))
    .filter(({ n, f }) => !n.missing && !!f)
  const excluded = rows.filter(({ f }) => f!.kind !== 'tsx' || !f!.slide).map(({ f }) => f!.id)
  const seen = new Set<string>()
  const deck = rows
    .filter(({ f }) => f!.kind === 'tsx' && !!f!.slide)
    .sort((a, b) => a.n.y - b.n.y || a.n.x - b.n.x || a.i - b.i)
    .filter(({ n }) => !seen.has(n.frame) && (seen.add(n.frame), true))
    .map(({ n }) => n.frame)
  return { deck, excluded: [...new Set(excluded)] }
}
