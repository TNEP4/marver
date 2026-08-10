import { describe, expect, it } from 'vitest'
import { extractMeta, toFrameId } from '../src/server/manifest.ts'
import { tidy } from '../src/client/shell/tidy.ts'

describe('extractMeta (literal-only regex, spec §6)', () => {
  it('extracts literal strings', () => {
    expect(extractMeta(`export const meta = { title: "Checkout - filled", viewport: 'mobile' }`))
      .toEqual({ title: 'Checkout - filled', viewport: 'mobile' })
  })
  it('handles backticks and extra keys', () => {
    expect(extractMeta('export const meta = { viewport: `desktop`, other: 3 }')).toEqual({ viewport: 'desktop' })
  })
  it('silently omits non-literal values', () => {
    expect(extractMeta(`export const meta = { title: someVar, viewport: getVp() }`)).toEqual({})
  })
  it('no meta export → empty', () => {
    expect(extractMeta(`export default () => null`)).toEqual({})
  })
})

describe('toFrameId (spec §6)', () => {
  it('drops scenes/ prefix and extension', () => {
    expect(toFrameId('scenes/checkout/filled.tsx')).toBe('checkout/filled')
  })
  it('keeps components/ prefix', () => {
    expect(toFrameId('components/button/variants.tsx')).toBe('components/button/variants')
  })
  it('html frames', () => {
    expect(toFrameId('scenes/demo/empty.html')).toBe('demo/empty')
  })
})

describe('tidy (pure, spec §7)', () => {
  it('rows per scene, scenes alphabetical, gutters applied', () => {
    const placed = tidy([
      { key: 'b1', scene: 'beta', w: 100, h: 200 },
      { key: 'a1', scene: 'alpha', w: 100, h: 100 },
      { key: 'a2', scene: 'alpha', w: 100, h: 150 },
    ])
    const byKey = Object.fromEntries(placed.map((p) => [p.key, p]))
    expect(byKey.a1).toEqual({ key: 'a1', x: 0, y: 0 })
    expect(byKey.a2).toEqual({ key: 'a2', x: 148, y: 0 })
    expect(byKey.b1.y).toBe(150 + 96) // tallest alpha + scene gap
    expect(byKey.b1.x).toBe(0)
  })
  it('preserves in-scene order (append-only respect)', () => {
    const placed = tidy([
      { key: 'x2', scene: 's', w: 50, h: 50 },
      { key: 'x1', scene: 's', w: 50, h: 50 },
    ])
    expect(placed[0].key).toBe('x2')
    expect(placed[0].x).toBeLessThan(placed[1].x)
  })
})
