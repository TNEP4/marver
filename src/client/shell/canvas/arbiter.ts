/**
 * SPEC-M6 §5 — the Live-Lease Arbiter. THE governing invariant of M6: no live document (a live
 * app <iframe>, a Play stage, a background compiler, a warm pre-mount, or an incompatible-frame
 * fallback) is ever created without a synchronous grant from here. The cap can never be exceeded,
 * because admission is decided BEFORE the iframe is constructed - not cleaned up afterwards.
 *
 * Every running document counts against ONE global cap. When the cap is full, a new request evicts
 * the weakest existing lease *if* the request outranks it (ties break by least-recently-used); if
 * nothing is evictable the request is DENIED and the caller keeps its snapshot/placeholder. Each
 * lease carries an `onEvict` teardown the arbiter calls when it reclaims the slot.
 *
 * Re-entrancy is safe: eviction RESERVES the freed slot for the incoming lease BEFORE running the
 * victim's teardown, so a nested `requestLease()` inside an `onEvict` callback sees a full cap and
 * cannot over-grant. Pure + synchronous (no Date.now / timers) so it is exhaustively testable.
 */

// higher = harder to evict. Mirrors SPEC-M6 §5.2 priority order.
export type LeaseKind =
  | 'active'        // the interactive/prototype/laser-enter target (foreground)
  | 'transition'    // the incoming target during a promote (destination of a handoff)
  | 'handoff-out'   // the outgoing live doc mid promote/demote
  | 'incompatible'  // a frame the serializer can't snapshot - must stay live while visible
  | 'hover-warm'    // predicted-next under the pointer
  | 'reachable-warm'// a prototype/goto reachable target, pre-warmed
  | 'compile'       // a one-shot background compile to produce a passive artifact

const PRIORITY: Record<LeaseKind, number> = {
  active: 100, transition: 95, 'handoff-out': 90, incompatible: 80,
  'hover-warm': 50, 'reachable-warm': 40, compile: 10,
}

export const LIVE_CAP = 3   // SPEC-M6 §5.1 - fixed. deviceMemory may only REDUCE this, never raise it.

export interface Lease { id: number; nodeKey: string; kind: LeaseKind }
type EvictFn = (nodeKey: string, leaseId: number) => void
interface Slot { id: number; nodeKey: string; kind: LeaseKind; used: number; onEvict: EvictFn }

let seq = 0        // monotonic lease id
let clock = 0      // monotonic recency counter (LRU): bumped on grant AND reuse/touch
let cap = LIVE_CAP
const leases = new Map<number, Slot>()       // leaseId -> slot (presence == one live doc exists)
const byNode = new Map<string, number>()     // nodeKey -> its current leaseId (one live doc per node, max)

const copy = (s: Slot): Lease => ({ id: s.id, nodeKey: s.nodeKey, kind: s.kind })   // never expose the mutable slot

/** Constrained devices may lower the cap (never raise). Non-finite is rejected. Lowering the cap
 *  synchronously evicts weakest leases (with teardown) until compliant - the invariant holds at once. */
export function setCap(n: number): void {
  if (!Number.isFinite(n)) return
  cap = Math.max(1, Math.min(LIVE_CAP, Math.floor(n)))
  while (leases.size > cap) { const w = weakest(); if (!w) break; evictWithTeardown(w.id) }
}
export function getCap(): number { return cap }
export function liveCount(): number { return leases.size }
export function leaseFor(nodeKey: string): Lease | undefined { const id = byNode.get(nodeKey); const s = id != null ? leases.get(id) : undefined; return s ? copy(s) : undefined }
export function leases_(): Lease[] { return [...leases.values()].map(copy) }   // read-only copies (diag/tests)

/** Weakest = lowest priority; ties broken by least-recently-used (lowest `used`). */
function weakest(): Slot | null {
  let w: Slot | null = null
  for (const s of leases.values()) {
    if (!w) { w = s; continue }
    const ps = PRIORITY[s.kind], pw = PRIORITY[w.kind]
    if (ps < pw || (ps === pw && s.used < w.used)) w = s
  }
  return w
}

/** Internal: drop a lease from accounting WITHOUT running its teardown (caller runs it if needed). */
function drop(id: number): Slot | undefined {
  const s = leases.get(id); if (!s) return undefined
  leases.delete(id)
  if (byNode.get(s.nodeKey) === id) byNode.delete(s.nodeKey)
  return s
}

/** Public: reclaim a lease AND run its teardown (used by Play parking, and internally). */
function evictWithTeardown(id: number): void { const s = drop(id); s?.onEvict(s.nodeKey, s.id) }

/**
 * Request permission to mount a live document for `nodeKey` as `kind`. SYNCHRONOUS.
 * Returns a leaseId to mount under, or null if denied (caller keeps its snapshot/placeholder).
 * `onEvict(nodeKey, leaseId)` is invoked if the arbiter later reclaims this slot.
 *
 * A node already holding a live doc keeps its slot; the kind + evictor are refreshed and recency is
 * touched - it never consumes a second slot (one-per-node).
 */
export function requestLease(nodeKey: string, kind: LeaseKind, onEvict: EvictFn): number | null {
  const existing = byNode.get(nodeKey)
  if (existing != null) {
    const s = leases.get(existing)
    if (s) { s.kind = kind; s.onEvict = onEvict; s.used = ++clock; return existing }   // reuse the slot
  }
  if (leases.size >= cap) {
    const w = weakest()
    if (!w || PRIORITY[w.kind] > PRIORITY[kind]) return null   // nothing evictable -> deny, never exceed cap
    // RESERVE the slot before teardown: drop the victim from accounting, install the new lease, THEN
    // run the victim's teardown. A nested requestLease inside onEvict now sees a full cap.
    const victim = drop(w.id)!
    const id = ++seq
    leases.set(id, { id, nodeKey, kind, used: ++clock, onEvict })
    byNode.set(nodeKey, id)
    victim.onEvict(victim.nodeKey, victim.id)
    return id
  }
  const id = ++seq
  leases.set(id, { id, nodeKey, kind, used: ++clock, onEvict })
  byNode.set(nodeKey, id)
  return id
}

/** Bump a lease's recency (so it isn't the LRU eviction target). No-op if the id is stale. */
export function touchLease(id: number): void { const s = leases.get(id); if (s) s.used = ++clock }

/** Release a lease when its live doc is torn down (demotion, unmount, compile finished).
 *  Accounting only - does NOT run the evictor (the holder is already tearing itself down). */
export function releaseLease(id: number): void { drop(id) }

/** Reclaim a lease AND run its teardown - for Play parking a specific canvas runtime. */
export function revoke(id: number): void { evictWithTeardown(id) }

/** Park every live doc (running each teardown), except the given node keys. Used when Play opens:
 *  the stage takes its own lease and every canvas runtime must be released, not left live. */
export function revokeAll(exceptNodeKeys: string[] = []): void {
  const keep = new Set(exceptNodeKeys)
  for (const id of [...leases.keys()]) { const s = leases.get(id); if (s && !keep.has(s.nodeKey)) evictWithTeardown(id) }
}

/** Test/HMR reset. */
export function __resetArbiter(): void { leases.clear(); byNode.clear(); seq = 0; clock = 0; cap = LIVE_CAP }
