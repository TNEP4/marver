import { describe, expect, it } from 'vitest'
import { extractMeta } from '../src/server/manifest.ts'
import { planShot } from '../src/server/shot.ts'

/** v1.5 slides - slice 1: the frame type. Literal-boolean meta, and the
 *  sizing precedence chain (slide intrinsic → authored viewport → content
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
  it('the slide intrinsic wins over content sizing AND authored viewport - the Slide root is fixed', () => {
    expect(planShot({ slide: true }, VPS)).toEqual({ width: 1280, initialHeight: 720, fullHeight: false })
    expect(planShot({ slide: true, contentWidth: 760 }, VPS)).toEqual({ width: 1280, initialHeight: 720, fullHeight: false })
    expect(planShot({ slide: true, viewport: 'mobile' }, VPS)).toEqual({ width: 1280, initialHeight: 720, fullHeight: false })
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
  it('collects src + poster literals; remote src may skip poster; computed fails closed; a posterless local clip references its generated poster', () => {
    expect(scanAssetRefs(`<Video src="intro.mp4" poster="intro.jpg" />`, 'm')).toEqual(['intro.mp4', 'intro.jpg'])
    expect(scanAssetRefs(`<Video src="https://cdn.x/v.mp4" />`, 'm')).toEqual(['https://cdn.x/v.mp4'])
    expect(() => scanAssetRefs(`<Video src={dyn} poster="p.jpg" />`, 'm')).toThrow(/computed/)
    expect(scanAssetRefs(`<Video src="intro.mp4" />`, 'm')).toEqual(['intro.mp4', 'intro.mp4.poster.png'])
    // Img behavior unchanged
    expect(scanAssetRefs(`<Img src="a.png" />`, 'm')).toEqual(['a.png'])
    expect(() => scanAssetRefs(`<Img src={x} />`, 'm')).toThrow(/computed/)
  })
})

describe('deckOrder - the board is the sorter (pure)', async () => {
  const { deckOrder } = await import('../src/client/shell/play-order.ts')
  const frames = new Map([
    ['d/one', { id: 'd/one', kind: 'tsx' as const, slide: true }],
    ['d/two', { id: 'd/two', kind: 'tsx' as const, slide: true }],
    ['d/three', { id: 'd/three', kind: 'tsx' as const, slide: true }],
    ['d/ui', { id: 'd/ui', kind: 'tsx' as const }],
    ['d/page', { id: 'd/page', kind: 'html' as const, slide: true }],
  ])
  it('orders by (y, x, index), dedupes, excludes non-slides with names', () => {
    const nodes = [
      { frame: 'd/two', x: 800, y: 0 },
      { frame: 'd/ui', x: 0, y: 0 },
      { frame: 'd/three', x: 0, y: 900 },
      { frame: 'd/one', x: 0, y: 0 },
      { frame: 'd/page', x: 400, y: 0 },
      { frame: 'd/two', x: 1600, y: 0 },              // dup node - first position wins
      { frame: 'd/gone', x: 0, y: 0, missing: true },
    ]
    const { deck, excluded } = deckOrder(nodes, frames)
    expect(deck).toEqual(['d/one', 'd/two', 'd/three'])
    expect(excluded.sort()).toEqual(['d/page', 'd/ui'])
  })
  it('same (y,x) falls back to node order', () => {
    const { deck } = deckOrder([
      { frame: 'd/two', x: 0, y: 0 }, { frame: 'd/one', x: 0, y: 0 },
    ], frames)
    expect(deck).toEqual(['d/two', 'd/one'])
  })
})

describe('slideSize - one rule, shared by canvas and shot', async () => {
  const { slideSize, SLIDE_INTRINSIC } = await import('../src/client/const.ts')
  it('slide: true IS the size - the fixed Slide root would only be clipped by a viewport', () => {
    expect(slideSize({ slide: true })).toEqual(SLIDE_INTRINSIC)
    expect(slideSize({ slide: true, viewport: 'mobile' } as never)).toEqual(SLIDE_INTRINSIC)
    expect(slideSize({})).toBeNull()
  })
})

describe('chartTheme - the house look outside a slide', () => {
  it('slide scale is 18px labels, document/UI scale is 12px; ink and font are the frame\'s', async () => {
    const { chartTheme } = await import('../src/client/content/chart.tsx')
    const base = { ink: 'rgb(230, 230, 230)', font: 'Georgia, serif', accent: '#0091FF', ground: '#1a1d24', grid: 'rgba(242,242,247,.12)', dark: true }
    const slide = chartTheme({ ...base, inSlide: true }) as any
    const ui = chartTheme({ ...base, inSlide: false }) as any
    expect(slide.categoryAxis.axisLabel.fontSize).toBe(18)
    expect(ui.categoryAxis.axisLabel.fontSize).toBe(12)
    expect(ui.textStyle).toEqual({ fontFamily: 'Georgia, serif', color: 'rgb(230, 230, 230)' })
    expect(ui.label).toEqual({ color: 'rgb(230, 230, 230)', fontSize: 12, textBorderWidth: 0 })   // no #333 + white halo
    expect(ui.color[0]).toBe('#0091FF')
    expect(ui.tooltip.backgroundColor).toBe('#1a1d24')
  })
})
