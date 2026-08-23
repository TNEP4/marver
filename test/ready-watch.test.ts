import { describe, expect, it } from 'vitest'
import { canAutoReload, shouldArmReadyWatch, type ReadyNode } from '../src/client/shell/canvas/ready-watch.ts'

// The readiness watchdog turns a SILENT frame (slow dev server) into one automatic retry, never a
// failure. These cover the two invariants the store + FrameNode lean on: arm only for a present,
// still-loading, not-yet-retried frame; auto-reload at most once and only while still silent.

const n = (over: Partial<ReadyNode> = {}): ReadyNode => ({ status: 'loading', ...over })

describe('shouldArmReadyWatch - when the 10s watchdog may run', () => {
  it('arms for a present, still-loading, not-yet-retried frame', () => {
    expect(shouldArmReadyWatch(n(), true)).toBe(true)
  })
  it('does NOT arm once the frame is ready or errored (silence is over)', () => {
    expect(shouldArmReadyWatch(n({ status: 'ready' }), true)).toBe(false)
    expect(shouldArmReadyWatch(n({ status: 'error' }), true)).toBe(false)
  })
  it('does NOT re-arm after the one retry is spent (bounds it to a single retry)', () => {
    expect(shouldArmReadyWatch(n({ readyRetried: true }), true)).toBe(false)
  })
  it('does NOT arm for a MISSING frame - it must not burn its retry before the file arrives', () => {
    expect(shouldArmReadyWatch(n({ missing: true }), true)).toBe(false)
  })
  it('does NOT arm when the frame is absent from the manifest (no live iframe to watch)', () => {
    expect(shouldArmReadyWatch(n(), false)).toBe(false)
  })
})

describe('canAutoReload - whether a watchdog-driven reload still applies', () => {
  it('allows the automatic reload for a still-silent loading frame', () => {
    expect(canAutoReload(n())).toBe(true)
  })
  it('refuses a SECOND automatic reload once one was spent', () => {
    expect(canAutoReload(n({ readyRetried: true }))).toBe(false)
  })
  it('refuses once the frame has gone ready or error (a late resolution won the race)', () => {
    expect(canAutoReload(n({ status: 'ready' }))).toBe(false)
    expect(canAutoReload(n({ status: 'error' }))).toBe(false)
  })
})
