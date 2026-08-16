import { beforeEach, describe, expect, it } from 'vitest'
import { getCap, liveCount, __resetArbiter } from '../src/client/shell/canvas/arbiter.ts'
import {
  __resetLifecycle, artifactState, liveMode, onSnapshotAdmitted, registerLC, setInteractLC,
  setVisible, showPlaceholder, unregisterLC,
} from '../src/client/shell/canvas/lifecycle.ts'

const noop = () => {}

/** which node the coordinator has chosen to compile right now (its live is 'hidden'). */
const compilingKey = (keys: string[]) => keys.find((k) => liveMode(k) === 'hidden') ?? null

describe('Passive-Artifact Lifecycle (SPEC-M6 §4/§5, pool mode)', () => {
  beforeEach(() => { __resetArbiter(); __resetLifecycle() })

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
    setInteractLC('a', false)                     // leave -> back to snapshot, live released
    expect(liveMode('a')).toBeNull()
    expect(liveCount()).toBe(0)
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
})
