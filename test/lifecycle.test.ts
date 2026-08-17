import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getCap, liveCount, setCap, __resetArbiter } from '../src/client/shell/canvas/arbiter.ts'
import {
  __resetLifecycle, __setTimers, artifactState, liveMode, onSnapshotAdmitted, registerLC, setFileReady, setInteractLC,
  setVisible, showPlaceholder, unregisterLC,
} from '../src/client/shell/canvas/lifecycle.ts'

// controllable watchdog timer for the compile/demote timeout paths
let pending: Array<{ h: number; ms: number; fn: () => void }> = []
let th = 0
const fakeSet = (ms: number, fn: () => void) => { const h = ++th; pending.push({ h, ms, fn }); return h }
const fakeClr = (h: number) => { pending = pending.filter((p) => p.h !== h) }
const fireTimers = () => { const due = pending; pending = []; due.forEach((p) => p.fn()) }

const noop = () => {}

/** which node the coordinator has chosen to compile right now (its live is 'hidden'). */
const compilingKey = (keys: string[]) => keys.find((k) => liveMode(k) === 'hidden') ?? null

describe('Passive-Artifact Lifecycle (SPEC-M6 §4/§5, pool mode)', () => {
  beforeEach(() => { __resetArbiter(); __resetLifecycle(); pending = []; th = 0; __setTimers(fakeSet, fakeClr) })
  afterEach(() => { __resetLifecycle(); __resetArbiter() })

  it('a cold visible frame shows a placeholder and enters compiling', () => {
    registerLC('a', noop)
    setVisible('a', true)
    expect(liveMode('a')).toBe('hidden')          // live booting to be serialized
    expect(artifactState('a')).toBe('compiling')
    expect(showPlaceholder('a')).toBe(true)       // placeholder covers the hidden compile boot
    expect(liveCount()).toBe(1)
  })

  it('20 cold visible frames compile ONE at a time and never exceed the cap', () => {
    const keys = Array.from({ length: 20 }, (_, i) => 'n' + i)
    keys.forEach((k) => registerLC(k, noop))
    keys.forEach((k) => setVisible(k, true))
    // exactly one is compiling; the arbiter cap is never exceeded
    expect(keys.filter((k) => liveMode(k) === 'hidden').length).toBe(1)
    expect(liveCount()).toBeLessThanOrEqual(getCap())
    // drive every compile to completion; still only ever one at a time
    for (let i = 0; i < 20; i++) {
      const c = compilingKey(keys)
      expect(c).not.toBeNull()
      expect(liveCount()).toBeLessThanOrEqual(getCap())
      onSnapshotAdmitted(c!, true)
    }
    // all ready, nothing compiling, no live docs left
    expect(keys.every((k) => artifactState(k) === 'ready')).toBe(true)
    expect(keys.filter((k) => liveMode(k) === 'hidden').length).toBe(0)
    expect(liveCount()).toBe(0)
  })

  it('a ready passive frame mounts no live doc; interact promotes it to a shown live app', () => {
    registerLC('a', noop)
    setVisible('a', true)
    onSnapshotAdmitted('a', true)                 // compiled
    expect(artifactState('a')).toBe('ready')
    expect(liveMode('a')).toBeNull()              // snapshot is the view, no live doc
    expect(liveCount()).toBe(0)
    setInteractLC('a', true)                      // enter the real app
    expect(liveMode('a')).toBe('shown')
    expect(liveCount()).toBe(1)
    setInteractLC('a', false)                     // leave -> TWO-PHASE demote: live still up until recapture admits
    expect(liveMode('a')).toBe('shown')           // not blank - live held through the handoff
    onSnapshotAdmitted('a', true)                 // fresh snapshot admitted -> now release the live doc
    expect(liveMode('a')).toBeNull()
    expect(liveCount()).toBe(0)
  })

  // SPEC-M7: a durable FILE artifact backs the frame - the passive view is always on disk, so no
  // in-browser compile, and demote drops the live doc AT ONCE (no two-phase recapture handoff).
  it('a file-backed frame shows the crisp file: no compile, no placeholder, no live', () => {
    registerLC('a', noop)
    setFileReady('a', true)
    setVisible('a', true)
    expect(artifactState('a')).toBe('ready')
    expect(liveMode('a')).toBeNull()              // the file is the view, no live doc mounted
    expect(showPlaceholder('a')).toBe(false)      // never a placeholder - the file is ready
    expect(liveCount()).toBe(0)
  })

  it('interacting a file-backed frame promotes to live, then leaving demotes IMMEDIATELY (no watchdog)', () => {
    registerLC('a', noop)
    setFileReady('a', true)
    setVisible('a', true)
    setInteractLC('a', true)                      // enter the real app
    expect(liveMode('a')).toBe('shown')
    expect(liveCount()).toBe(1)
    setInteractLC('a', false)                     // leave -> drop the live doc at once, back to the file
    expect(liveMode('a')).toBeNull()
    expect(liveCount()).toBe(0)
    expect(pending.length).toBe(0)                // NO two-phase recapture watchdog armed (unlike the snapshot path)
    expect(showPlaceholder('a')).toBe(false)      // the crisp file is the view again - no blip
  })

  it('setFileReady(false) drops a frame back to the in-browser compile path', () => {
    registerLC('a', noop)
    setFileReady('a', true)
    setVisible('a', true)
    expect(liveMode('a')).toBeNull()              // file view, no compile
    setFileReady('a', false)                      // the file vanished (deleted / theme with no artifact)
    expect(artifactState('a')).toBe('compiling')  // falls back to a background compile boot
    expect(liveMode('a')).toBe('hidden')
  })

  it('an incompatible frame holds a counted live lease while visible', () => {
    registerLC('a', noop)
    setVisible('a', true)
    onSnapshotAdmitted('a', false)                // serializer degraded it
    expect(artifactState('a')).toBe('incompatible')
    expect(liveMode('a')).toBe('shown')           // stays live
    expect(liveCount()).toBe(1)
    setVisible('a', false)                        // off-screen -> release the live doc
    expect(liveMode('a')).toBeNull()
    expect(liveCount()).toBe(0)
  })

  it('interact wins even while cold: it takes an active slot, not a compile slot', () => {
    registerLC('a', noop); registerLC('b', noop)
    setVisible('a', true)                          // a starts compiling
    setInteractLC('b', true)                       // b is interacted while cold
    expect(liveMode('b')).toBe('shown')
    expect(liveCount()).toBeLessThanOrEqual(getCap())
  })

  it('unregister releases the lease and lets the compiler advance', () => {
    registerLC('a', noop); registerLC('b', noop)
    setVisible('a', true); setVisible('b', true)
    expect(compilingKey(['a', 'b'])).toBe('a')     // a compiles first
    unregisterLC('a')                              // a leaves mid-compile
    expect(compilingKey(['a', 'b'])).toBe('b')     // compiler advances to b
    expect(liveCount()).toBeLessThanOrEqual(getCap())
  })

  it('random churn: liveCount never exceeds the cap and at most one compiler runs', () => {
    const keys = Array.from({ length: 15 }, (_, i) => 'k' + i)
    keys.forEach((k) => registerLC(k, noop))
    const rnd = (i: number) => { const x = Math.sin(i * 7.117) * 43758.5453; return (x % 1 + 1) % 1 }
    for (let i = 0; i < 1500; i++) {
      const k = keys[Math.floor(rnd(i) * keys.length)]
      const r = rnd(i + 1)
      if (r < 0.4) setVisible(k, true)
      else if (r < 0.55) setVisible(k, false)
      else if (r < 0.7) setInteractLC(k, true)
      else if (r < 0.8) setInteractLC(k, false)
      else { const c = compilingKey(keys); if (c) onSnapshotAdmitted(c, rnd(i + 2) > 0.2) }
      expect(liveCount()).toBeLessThanOrEqual(getCap())
      expect(keys.filter((x) => liveMode(x) === 'hidden').length).toBeLessThanOrEqual(1)
    }
  })

  // --- codex slice-review P1 regressions ---

  it('culling a frame MID-COMPILE releases its slot and the compiler advances (P1.1)', () => {
    registerLC('a', noop); registerLC('b', noop)
    setVisible('a', true); setVisible('b', true)
    expect(liveMode('a')).toBe('hidden')          // a is compiling
    expect(liveMode('b')).toBeNull()              // b waits
    setVisible('a', false)                        // a culled mid-compile
    expect(liveCount()).toBeLessThanOrEqual(getCap())
    expect(compilingKey(['a', 'b'])).toBe('b')    // the compiler ADVANCED (was the stuck bug)
    expect(artifactState('a')).toBe('missing')    // a is requeued, not wedged
  })

  it('a compile that never admits is watchdog-aborted; after MAX_ATTEMPTS -> incompatible, never stuck (P1.2)', () => {
    registerLC('a', noop); registerLC('b', noop)
    setVisible('a', true)
    expect(liveMode('a')).toBe('hidden')
    fireTimers()                                  // watchdog fires: attempt 1 -> requeue as missing
    expect(compilingKey(['a', 'b'])).toBe('a')    // still visible+missing -> recompiles
    fireTimers()                                  // attempt 2 -> MAX_ATTEMPTS -> incompatible (stays live)
    expect(artifactState('a')).toBe('incompatible')
    expect(compiling(['a', 'b'])).toBe(false)     // compiler slot is free, not wedged
    expect(liveCount()).toBeLessThanOrEqual(getCap())
  })

  it('interact during a compile of ANOTHER frame stays within cap; leaving is two-phase (never blank) (P1.3)', () => {
    registerLC('a', noop); registerLC('b', noop)
    setVisible('a', true)                          // a compiling
    setVisible('b', true)
    onSnapshotAdmitted('b', true)                  // b already has a snapshot (pretend), then interact it
    setInteractLC('b', true)
    expect(liveMode('b')).toBe('shown')
    expect(liveCount()).toBeLessThanOrEqual(getCap())
    setInteractLC('b', false)                      // leave -> demote, live held (not blank)
    expect(liveMode('b')).toBe('shown')
    expect(showPlaceholder('b')).toBe(false)       // never a blank during the handoff (artifact ready)
    onSnapshotAdmitted('b', true)                  // recapture admitted -> release
    expect(liveMode('b')).toBeNull()
  })

  it('an incompatible frame evicted at cap-1 is RE-COVERED and retried when capacity frees (P1.6)', () => {
    setCap(1)
    registerLC('inc', noop); registerLC('act', noop)
    setVisible('inc', true)
    onSnapshotAdmitted('inc', false)               // incompatible -> takes the single live slot
    expect(liveMode('inc')).toBe('shown')
    setInteractLC('act', true)                     // active evicts the incompatible (cap 1)
    expect(liveMode('inc')).toBeNull()
    expect(showPlaceholder('inc')).toBe(true)      // evicted incompatible shows a placeholder, NOT blank (was the bug)
    setInteractLC('act', false)                    // capacity frees
    onSnapshotAdmitted('act', true)                // demote of act completes
    expect(liveMode('inc')).toBe('shown')          // incompatible retried and re-covered
    setCap(3)
  })

  it('unregister of a compiling frame frees the compiler (no leaked lease)', () => {
    registerLC('a', noop); registerLC('b', noop)
    setVisible('a', true); setVisible('b', true)
    unregisterLC('a')                              // a leaves mid-compile
    expect(compilingKey(['b'])).toBe('b')
    expect(liveCount()).toBeLessThanOrEqual(getCap())
  })
})

// live count > 0 iff some node is compiling/shown; helper for the watchdog test
const compiling = (keys: string[]) => keys.some((k) => liveMode(k) === 'hidden')
