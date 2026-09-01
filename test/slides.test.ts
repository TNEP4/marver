import { describe, expect, it } from 'vitest'
import { extractMeta } from '../src/server/manifest.ts'
import { planShot } from '../src/server/shot.ts'

/** v1.5 slides - slice 1: the frame type. Literal-boolean meta, and the
 *  sizing precedence chain (authored viewport → slide intrinsic → content
 *  sizing → default) at the shot planner, which mirrors the canvas. */

const VPS = { mobile: { width: 390, height: 844 }, laptop: { width: 1280, height: 832 } }

describe('extractMeta - literal booleans (slide)', () => {
  it('parses true/false and ignores everything non-literal', () => {
    expect(extractMeta(`export const meta = { title: "Cover", slide: true }`)).toEqual({ title: 'Cover', slide: true })
    expect(extractMeta(`export const meta = { slide: false }`)).toEqual({ slide: false })
    expect(extractMeta(`export const meta = { slide: isDeck }`)).toEqual({})
    expect(extractMeta(`export const meta = { slideshow: true }`)).toEqual({})   // boundary holds
    expect(extractMeta(`export const meta = { title: "x" }`)).toEqual({ title: 'x' })
  })
})

describe('planShot - the slide precedence chain', () => {
  it('slide intrinsic wins over content sizing; authored viewport wins over both', () => {
    expect(planShot({ slide: true }, VPS)).toEqual({ width: 1280, initialHeight: 720, fullHeight: false })
    expect(planShot({ slide: true, contentWidth: 760 }, VPS)).toEqual({ width: 1280, initialHeight: 720, fullHeight: false })
    expect(planShot({ slide: true, viewport: 'mobile' }, VPS)).toEqual({ width: 390, initialHeight: 844, fullHeight: false })
    expect(planShot({ contentWidth: 760 }, VPS).fullHeight).toBe(true)
    expect(planShot({}, VPS)).toEqual({ width: 390, initialHeight: 844, fullHeight: false })
  })
})
