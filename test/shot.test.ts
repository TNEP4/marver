import { describe, expect, it } from 'vitest'
import { AREA, SURFACE, planShot } from '../src/server/shot.ts'

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

describe('planShot - node-size override ("capture what the node shows", copy-as-image)', () => {
  it('slide ignores the override entirely - the fit only scales the fixed 1280×720 root', () => {
    expect(planShot({ slide: true }, VP, { w: 640, h: 360 })).toEqual({ width: 1280, initialHeight: 720, fullHeight: false })
  })
  it('content frame takes the node WIDTH only, stays full height, clamps 320..1600', () => {
    expect(planShot({ contentWidth: 760 }, VP, { w: 1440, h: 5000 })).toEqual({ width: 1440, initialHeight: 1080, fullHeight: true })
    expect(planShot({ contentWidth: 760, viewport: 'laptop' }, VP, { w: 834 }).width).toBe(834)   // node beats meta.viewport
    expect(planShot({ contentWidth: 760 }, VP, { w: 100 }).width).toBe(320)
    expect(planShot({ contentWidth: 760 }, VP, { w: 9000 }).width).toBe(1600)
  })
  it('fixed frame takes both, clamped to 120..3840 × 80..2160; a missing side falls back to the viewport', () => {
    expect(planShot({ viewport: 'laptop' }, VP, { w: 834, h: 1112 })).toEqual({ width: 834, initialHeight: 1112, fullHeight: false })
    expect(planShot({ viewport: 'laptop' }, VP, { w: 9000, h: 9000 })).toEqual({ width: 3840, initialHeight: 2160, fullHeight: false })
    expect(planShot({ viewport: 'laptop' }, VP, { h: 40 })).toEqual({ width: 1440, initialHeight: 80, fullHeight: false })
  })
  it('invalid override values (NaN / 0 / negative) are ignored, not clamped', () => {
    for (const bad of [Number.NaN, 0, -20, Number.POSITIVE_INFINITY]) {
      expect(planShot({ viewport: 'laptop' }, VP, { w: bad, h: bad })).toEqual({ width: 1440, initialHeight: 900, fullHeight: false })
    }
  })
})

describe('capture budget constants', () => {
  it('every content ladder rung fits the area budget at the width clamp (1600) - so 2x/1x caps are the surface caps the suite asserts', () => {
    expect(1600 * 2 * 8192 * 2).toBeLessThanOrEqual(AREA)   // 2x cap 8192 holds at max content width
    expect(1600 * 16384).toBeLessThanOrEqual(AREA)          // 1x cap 16384 holds too
    expect(SURFACE).toBe(16384)
  })
})
