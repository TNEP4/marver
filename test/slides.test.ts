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

describe('Chart sanitizeOption - nothing moves at rest', async () => {
  const { sanitizeOption } = await import('../src/client/content/chart.tsx')
  it('kills animation everywhere at rest, enables it once in play', () => {
    const option = {
      animation: true, graphic: [{ type: 'circle', keyframeAnimation: {} }],
      series: [
        { type: 'bar', animation: true, animationDuration: 900, animationDelay: 100, data: [1] },
        { type: 'line', data: [2] },
      ],
    }
    const rest = sanitizeOption(option, false) as any
    expect(rest.animation).toBe(false)
    expect(rest.graphic).toBeUndefined()
    expect(rest.series[0].animation).toBe(false)
    expect(rest.series[0].animationDuration).toBeUndefined()
    expect(rest.series[1].animation).toBe(false)
    expect(rest.series[1].data).toEqual([2])
    const play = sanitizeOption(option, true) as any
    expect(play.animation).toBe(true)
    expect(play.series[0].animation).toBe(true)
    // the input is never mutated
    expect((option.series[0] as any).animationDuration).toBe(900)
  })
})

describe('scanAssetRefs - Video joins the pipeline', async () => {
  const { scanAssetRefs } = await import('../src/server/build.ts')
  it('collects src + poster literals; remote src may skip poster; computed and posterless-local fail closed', () => {
    expect(scanAssetRefs(`<Video src="intro.mp4" poster="intro.jpg" />`, 'm')).toEqual(['intro.mp4', 'intro.jpg'])
    expect(scanAssetRefs(`<Video src="https://cdn.x/v.mp4" />`, 'm')).toEqual(['https://cdn.x/v.mp4'])
    expect(() => scanAssetRefs(`<Video src={dyn} poster="p.jpg" />`, 'm')).toThrow(/computed/)
    expect(() => scanAssetRefs(`<Video src="intro.mp4" />`, 'm')).toThrow(/poster/)
    // Img behavior unchanged
    expect(scanAssetRefs(`<Img src="a.png" />`, 'm')).toEqual(['a.png'])
    expect(() => scanAssetRefs(`<Img src={x} />`, 'm')).toThrow(/computed/)
  })
})
