import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetArbiter, getCap, leases_, LIVE_CAP, liveCount, leaseFor, releaseLease, requestLease,
  revoke, revokeAll, setCap, touchLease,
} from '../src/client/shell/canvas/arbiter.ts'

const noop = () => {}

describe('Live-Lease Arbiter (SPEC-M6 §5)', () => {
  beforeEach(() => __resetArbiter())

  it('grants up to the cap and then applies eviction rules', () => {
    expect(requestLease('a', 'active', noop)).not.toBeNull()
    expect(requestLease('b', 'hover-warm', noop)).not.toBeNull()
    expect(requestLease('c', 'reachable-warm', noop)).not.toBeNull()
    expect(liveCount()).toBe(LIVE_CAP)
    // a 4th, lower-priority request when the weakest is equal/higher -> DENIED, cap unchanged
    expect(requestLease('d', 'compile', noop)).toBeNull()
    expect(liveCount()).toBe(LIVE_CAP)
  })

  it('NEVER exceeds the cap across a long random workload (the core invariant)', () => {
    const kinds = ['active', 'handoff-out', 'incompatible', 'hover-warm', 'reachable-warm', 'compile'] as const
    let live = new Set<string>()
    // deterministic pseudo-random
    const rnd = (i: number) => { const x = Math.sin(i * 12.9898) * 43758.5453; return (x % 1 + 1) % 1 }
    for (let i = 0; i < 2000; i++) {
      const key = 'n' + Math.floor(rnd(i) * 12)
      if (rnd(i + 1) < 0.7) {
        const kind = kinds[Math.floor(rnd(i + 2) * kinds.length)]
        const id = requestLease(key, kind, () => { live.delete(key) })
        if (id != null) live.add(key)
      } else {
        const l = leaseFor(key)
        if (l) { releaseLease(l.id); live.delete(key) }
      }
      expect(liveCount()).toBeLessThanOrEqual(getCap())   // asserted after EVERY op
    }
  })

  it('a higher-priority request evicts the weakest and fires its onEvict', () => {
    let evicted: string | null = null
    requestLease('a', 'reachable-warm', (k) => { evicted = k })
    requestLease('b', 'hover-warm', noop)
    requestLease('c', 'incompatible', noop)
    expect(liveCount()).toBe(3)
    // 'active' (100) outranks the weakest 'reachable-warm' (40) -> evicts 'a'
    const id = requestLease('d', 'active', noop)
    expect(id).not.toBeNull()
    expect(evicted).toBe('a')
    expect(liveCount()).toBe(3)
    expect(leaseFor('a')).toBeUndefined()
    expect(leaseFor('d')).toBeDefined()
  })

  it('among equal priority, evicts the OLDEST (LRU)', () => {
    requestLease('a', 'hover-warm', noop)   // oldest
    requestLease('b', 'hover-warm', noop)
    requestLease('c', 'hover-warm', noop)
    // a 4th equal-priority request: incoming == weakest priority, LRU evicts the oldest ('a')
    const id = requestLease('d', 'hover-warm', noop)
    expect(id).not.toBeNull()
    expect(leaseFor('a')).toBeUndefined()
    expect(leaseFor('b')).toBeDefined()
    expect(liveCount()).toBe(3)
  })

  it('denies when nothing is evictable (all slots outrank the request)', () => {
    requestLease('a', 'active', noop)
    requestLease('b', 'active', noop)
    requestLease('c', 'handoff-out', noop)
    // a low-priority compile cannot displace any of these
    expect(requestLease('d', 'compile', noop)).toBeNull()
    expect(liveCount()).toBe(3)
  })

  it('one live doc per node: a re-request reuses the slot and upgrades the kind', () => {
    const first = requestLease('a', 'compile', noop)
    const second = requestLease('a', 'active', noop)   // same node, now active
    expect(second).toBe(first)                          // same lease id, not a second slot
    expect(liveCount()).toBe(1)
    expect(leaseFor('a')!.kind).toBe('active')
  })

  it('a node that already holds a slot is never denied even at full cap', () => {
    requestLease('a', 'active', noop)
    requestLease('b', 'active', noop)
    const c = requestLease('c', 'incompatible', noop)
    expect(liveCount()).toBe(3)
    // 'c' asking again (full cap) reuses its own slot rather than being denied
    expect(requestLease('c', 'active', noop)).toBe(c)
    expect(liveCount()).toBe(3)
  })

  it('releasing frees a slot', () => {
    const a = requestLease('a', 'active', noop)!
    requestLease('b', 'active', noop)
    requestLease('c', 'active', noop)
    expect(requestLease('d', 'active', noop)).not.toBeNull()   // evicts an equal (LRU 'a'... actually reuse)
    releaseLease(a)
    expect(liveCount()).toBeLessThanOrEqual(getCap())
    // after releasing, a fresh grant certainly fits
    __resetArbiter()
    const x = requestLease('x', 'active', noop)!
    releaseLease(x)
    expect(liveCount()).toBe(0)
    expect(requestLease('y', 'compile', noop)).not.toBeNull()
  })

  it('setCap can only lower the cap (clamped to [1, LIVE_CAP])', () => {
    setCap(2)
    expect(getCap()).toBe(2)
    requestLease('a', 'active', noop); requestLease('b', 'active', noop)
    expect(requestLease('c', 'compile', noop)).toBeNull()      // cap is 2 now
    expect(liveCount()).toBe(2)
    setCap(99)                                                 // clamped up to LIVE_CAP
    expect(getCap()).toBe(LIVE_CAP)
    setCap(0)                                                  // clamped down to 1
    expect(getCap()).toBe(1)
  })

  // --- codex-review P1 regressions ---

  it('lowering the cap while FULL evicts down to compliance immediately (P1)', () => {
    const gone: string[] = []
    requestLease('a', 'active', (k) => gone.push(k))
    requestLease('b', 'active', (k) => gone.push(k))
    requestLease('c', 'active', (k) => gone.push(k))
    expect(liveCount()).toBe(3)
    setCap(1)
    expect(getCap()).toBe(1)
    expect(liveCount()).toBe(1)          // was the bug: stayed at 3
    expect(gone.length).toBe(2)          // the two weakest were torn down
  })

  it('rejects a non-finite cap (NaN must not disable the cap) (P1)', () => {
    setCap(NaN)
    expect(Number.isFinite(getCap())).toBe(true)
    requestLease('a', 'active', noop); requestLease('b', 'active', noop); requestLease('c', 'active', noop)
    expect(requestLease('d', 'compile', noop)).toBeNull()
    expect(liveCount()).toBeLessThanOrEqual(getCap())
  })

  it('a re-entrant requestLease inside onEvict cannot exceed the cap (P1)', () => {
    // 'a' will be evicted; its teardown synchronously requests a NEW node while the outer grant runs
    requestLease('a', 'reachable-warm', () => { requestLease('reentrant', 'compile', noop) })
    requestLease('b', 'hover-warm', noop)
    requestLease('c', 'incompatible', noop)
    const id = requestLease('d', 'active', noop)   // evicts 'a' -> its onEvict fires re-entrantly
    expect(id).not.toBeNull()
    expect(liveCount()).toBeLessThanOrEqual(getCap())   // was the bug: 4
    // byNode <-> leases bijection intact (no orphan/duplicate)
    const nodes = leases_().map((l) => l.nodeKey)
    expect(new Set(nodes).size).toBe(nodes.length)
  })

  it('re-entrant onEvict re-requesting the OUTER node does not create two slots for it (P1)', () => {
    requestLease('a', 'reachable-warm', () => { requestLease('d', 'compile', noop) })  // teardown grabs 'd'
    requestLease('b', 'hover-warm', noop)
    requestLease('c', 'incompatible', noop)
    const id = requestLease('d', 'active', noop)  // 'd' is the outer node; onEvict also asks for 'd'
    expect(id).not.toBeNull()
    expect(leases_().filter((l) => l.nodeKey === 'd').length).toBe(1)   // exactly one slot for 'd'
    expect(liveCount()).toBeLessThanOrEqual(getCap())
  })

  it('touchLease refreshes recency so a touched lease is not the LRU victim', () => {
    requestLease('a', 'hover-warm', noop)   // oldest by grant
    const b = requestLease('b', 'hover-warm', noop)!
    requestLease('c', 'hover-warm', noop)
    touchLease(b)                            // b now most-recently-used; a is the LRU
    requestLease('d', 'hover-warm', noop)    // evicts the LRU = 'a', not 'b'
    expect(leaseFor('a')).toBeUndefined()
    expect(leaseFor('b')).toBeDefined()
  })

  it('transition ranks between active and handoff-out', () => {
    requestLease('a', 'handoff-out', noop)
    requestLease('b', 'incompatible', noop)
    requestLease('c', 'hover-warm', noop)
    // a 'transition' (95) outranks the weakest 'hover-warm' (50) -> admitted
    expect(requestLease('d', 'transition', noop)).not.toBeNull()
    // but a 'transition' cannot displace an 'active' when that's all there is
    __resetArbiter()
    requestLease('x', 'active', noop); requestLease('y', 'active', noop); requestLease('z', 'active', noop)
    expect(requestLease('t', 'transition', noop)).toBeNull()
  })

  it('revoke tears a lease down; revokeAll parks the canvas except kept nodes (Play)', () => {
    const gone: string[] = []
    requestLease('a', 'active', (k) => gone.push(k))
    requestLease('b', 'hover-warm', (k) => gone.push(k))
    revoke(leaseFor('a')!.id)
    expect(gone).toContain('a')
    expect(leaseFor('a')).toBeUndefined()
    // Play opens: park everything except the stage node
    requestLease('stage', 'active', noop)
    requestLease('c', 'hover-warm', (k) => gone.push(k))
    revokeAll(['stage'])
    expect(liveCount()).toBe(1)
    expect(leaseFor('stage')).toBeDefined()
  })

  it('leaseFor / leases_ return copies (external mutation cannot corrupt state)', () => {
    requestLease('a', 'active', noop)
    const snap = leaseFor('a')!
    ;(snap as { kind: string }).kind = 'compile'   // mutate the copy
    expect(leaseFor('a')!.kind).toBe('active')     // internal state unchanged
  })
})
