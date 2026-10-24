/**
 * Whether the cover covers now (spec 28 A3.8 #3; S15, 24 Oct): variant 3's cover covers only while its renderer is
 * alive and has presented, so `Cover` may say `ready()`; a cover that never waits on a renderer leaves it out.
 */
import { describe, expect, it } from 'vitest'
import { coverReady } from '../../src/main/cover.ts'

describe('coverReady', () => {
  it('a cover with no ready() covers always; one with it covers only while ready; no cover is app 0.1\'s plain view', () => {
    expect(coverReady({})).toBe(true)
    expect(coverReady(null)).toBe(true)
    let ready = false
    const c = { ready: () => ready }
    expect(coverReady(c)).toBe(false)
    ready = true
    expect(coverReady(c)).toBe(true)
  })
})
