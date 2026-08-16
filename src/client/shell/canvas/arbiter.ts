/**
 * SPEC-M6 §5 — the Live-Lease Arbiter. THE governing invariant of M6: no live document (a live
 * app <iframe>, a Play stage, a background compiler, a warm pre-mount, or an incompatible-frame
 * fallback) is ever created without a synchronous grant from here. The cap can never be exceeded,
 * because admission is decided BEFORE the iframe is constructed - not cleaned up afterwards.
 *
 * Every running document counts against ONE global cap. When the cap is full, a new request evicts
 * the lowest-priority existing lease *if* the request outranks it (ties break oldest = LRU); if
 * nothing is evictable the request is DENIED and the caller keeps its snapshot/placeholder. Each
 * lease carries an `onEvict` teardown the arbiter calls when it reclaims the slot.
 *
 * Pure and synchronous by design (no Date.now / timers) so it is exhaustively unit-testable and can
 * never race a mount. Ordering/LRU uses the monotonic lease id.
 */

// higher = harder to evict. Mirrors SPEC-M6 §5.2 priority order.
export type LeaseKind =
  | 'active'        // the interactive/prototype/laser-enter target (foreground)
  | 'handoff-out'   // the outgoing live doc mid promote/demote
  | 'incompatible'  // a frame the serializer can't snapshot - must stay live while visible
  | 'hover-warm'    // predicted-next under the pointer
  | 'reachable-warm'// a prototype/goto reachable target, pre-warmed
  | 'compile'       // a one-shot background compile to produce a passive artifact

const PRIORITY: Record<LeaseKind, number> = {
  active: 100, 'handoff-out': 90, incompatible: 80, 'hover-warm': 50, 'reachable-warm': 40, compile: 10,
}

export const LIVE_CAP = 3   // SPEC-M6 §5.1 - fixed. deviceMemory may only REDUCE this, never raise it.

export interface Lease { id: number; nodeKey: string; kind: LeaseKind }
type EvictFn = (nodeKey: string, leaseId: number) => void

let seq = 0
let cap = LIVE_CAP
const leases = new Map<number, Lease>()      // leaseId -> lease (its presence == one live doc exists)
const byNode = new Map<string, number>()     // nodeKey -> its current leaseId (one live doc per node, max)
const evictors = new Map<number, EvictFn>()  // leaseId -> teardown to run when the arbiter reclaims it

/** Constrained devices may lower the cap (never raise). Clamped to [1, LIVE_CAP]. */
export function setCap(n: number): void { cap = Math.max(1, Math.min(LIVE_CAP, Math.floor(n))) }
export function getCap(): number { return cap }
export function liveCount(): number { return leases.size }
export function leaseFor(nodeKey: string): Lease | undefined { const id = byNode.get(nodeKey); return id != null ? leases.get(id) : undefined }
export function leases_(): Lease[] { return [...leases.values()] }   // diag/tests

/** Pick the most-evictable lease: lowest priority, ties broken by oldest (smallest id = LRU). */
function weakest(): Lease | null {
  let w: Lease | null = null
  for (const l of leases.values()) {
    if (!w) { w = l; continue }
    const pl = PRIORITY[l.kind], pw = PRIORITY[w.kind]
    if (pl < pw || (pl === pw && l.id < w.id)) w = l
  }
  return w
}

function evict(id: number): void {
  const l = leases.get(id); if (!l) return
  const fn = evictors.get(id)
  releaseLease(id)
  fn?.(l.nodeKey, id)   // the holder tears its live document down
}

/**
 * Request permission to mount a live document for `nodeKey` as `kind`. SYNCHRONOUS.
 * Returns a leaseId to mount under, or null if denied (caller keeps its snapshot/placeholder).
 * `onEvict(nodeKey, leaseId)` is invoked if the arbiter later reclaims this slot for a higher need.
 *
 * A node already holding a live doc keeps its slot; the kind is upgraded/refreshed in place (e.g.
 * a frame that was `compile` becoming `active`) - it never consumes a second slot.
 */
export function requestLease(nodeKey: string, kind: LeaseKind, onEvict: EvictFn): number | null {
  const existing = byNode.get(nodeKey)
  if (existing != null) {
    const l = leases.get(existing)
    if (l) { l.kind = kind; evictors.set(existing, onEvict); return existing }   // reuse the slot
  }
  if (leases.size >= cap) {
    const w = weakest()
    // evict only if the incoming request is at least as important (>=); LRU handles the tie.
    if (!w || PRIORITY[w.kind] > PRIORITY[kind]) return null
    evict(w.id)
  }
  const id = ++seq
  leases.set(id, { id, nodeKey, kind })
  byNode.set(nodeKey, id)
  evictors.set(id, onEvict)
  return id
}

/** Release a lease when its live doc is torn down (demotion, unmount, compile finished). */
export function releaseLease(id: number): void {
  const l = leases.get(id); if (!l) return
  leases.delete(id)
  if (byNode.get(l.nodeKey) === id) byNode.delete(l.nodeKey)
  evictors.delete(id)
}

/** Test/HMR reset. */
export function __resetArbiter(): void { leases.clear(); byNode.clear(); evictors.clear(); seq = 0; cap = LIVE_CAP }
