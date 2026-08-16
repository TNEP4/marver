import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetArbiter, getCap, LIVE_CAP, liveCount, leaseFor, releaseLease, requestLease, setCap,
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
})
