import { describe, expect, it } from 'vitest'
import { planShot } from '../src/server/shot.ts'

// mirrors design/config.ts default viewports
const VP = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  laptop: { width: 1440, height: 900 },
  monitor: { width: 1920, height: 1080 },
}

describe('planShot - shot sizing matches the settled canvas (store.ts measureNode)', () => {
  it('wide content, no viewport -> contentWidth 1280, full height', () => {
    expect(planShot({ contentWidth: 1280 }, VP)).toEqual({ width: 1280, initialHeight: 960, fullHeight: true })
  })
  it('document content, no viewport -> contentWidth 760, full height', () => {
    expect(planShot({ contentWidth: 760 }, VP)).toEqual({ width: 760, initialHeight: 570, fullHeight: true })
  })
  it('content WITH a valid meta.viewport -> viewport width, STILL full height (viewport sets width only)', () => {
    expect(planShot({ contentWidth: 760, viewport: 'laptop' }, VP)).toEqual({ width: 1440, initialHeight: 1080, fullHeight: true })
  })
  it('content WITH an UNKNOWN viewport name -> still content: clamp(contentWidth), full height', () => {
    expect(planShot({ contentWidth: 1280, viewport: 'nope' }, VP)).toEqual({ width: 1280, initialHeight: 960, fullHeight: true })
  })
  it('non-content laptop frame -> fixed viewport, NOT full height', () => {
    expect(planShot({ viewport: 'laptop' }, VP)).toEqual({ width: 1440, initialHeight: 900, fullHeight: false })
  })
  it('non-content, unknown viewport name -> mobile fallback, not full height', () => {
    expect(planShot({ viewport: 'nope' }, VP)).toEqual({ width: 390, initialHeight: 844, fullHeight: false })
  })
  it('non-content, no viewport -> mobile default, not full height', () => {
    expect(planShot({}, VP)).toEqual({ width: 390, initialHeight: 844, fullHeight: false })
  })
  it('content width clamps to 320..1600', () => {
    expect(planShot({ contentWidth: 200 }, VP).width).toBe(320)
    expect(planShot({ contentWidth: 3000 }, VP).width).toBe(1600)
  })
  it('invalid contentWidth (0 / negative / NaN) is treated as NON-content', () => {
    for (const cw of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planShot({ contentWidth: cw }, VP).fullHeight).toBe(false)
    }
  })
  it('empty viewports map still resolves (hard mobile fallback)', () => {
    expect(planShot({}, {})).toEqual({ width: 390, initialHeight: 844, fullHeight: false })
  })
})
