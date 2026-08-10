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
    expect(byKey.a2).toEqual({ key: 'a2', x: 172, y: 0 })
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

describe('scanFrames on a real tree (spec §6, §9)', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { scanFrames } = await import('../src/server/manifest.ts')

  it('ids, kinds, meta, underscore rule, reserved scenes', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-scan-'))
    const mk = (p: string, c = 'export default () => null\n') => {
      mkdirSync(join(root, p, '..'), { recursive: true })
      writeFileSync(join(root, p), c)
    }
    mk('design/scenes/checkout/filled.tsx', `export const meta = { title: "Filled", viewport: "mobile" }\nexport default () => null\n`)
    mk('design/scenes/checkout/_fixtures.ts')
    mk('design/scenes/checkout/_layout.tsx')
    mk('design/scenes/demo/plain.html', '<html></html>')
    mk('design/scenes/screens/nope.tsx')          // reserved scene → skipped
    mk('design/components/button/variants.tsx')
    const m = scanFrames(root)
    expect(m.frames.map((f) => f.id)).toEqual(['checkout/filled', 'components/button/variants', 'demo/plain'])
    expect(m.frames.find((f) => f.id === 'checkout/filled')).toMatchObject({ kind: 'tsx', title: 'Filled', viewport: 'mobile', scene: 'checkout' })
    expect(m.frames.find((f) => f.id === 'demo/plain')?.kind).toBe('html')
    expect(m.boards).toContain('everything')
    rmSync(root, { recursive: true, force: true })
  })
})

describe('loadConfig (spec §4)', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { loadConfig, DEFAULTS } = await import('../src/server/config.ts')

  it('missing file → defaults', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-cfg-'))
    expect(await loadConfig(root)).toEqual(DEFAULTS)
    rmSync(root, { recursive: true, force: true })
  })
  it('partial config merges over defaults; bad fields fall back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-cfg-'))
    mkdirSync(join(root, 'design'))
    writeFileSync(join(root, 'design/config.ts'), `export default { port: 6001, themes: [], viewports: { m: { width: 'x' } } }\n`)
    const c = await loadConfig(root)
    expect(c.port).toBe(6001)
    expect(c.themes).toEqual(DEFAULTS.themes)        // empty → fallback
    expect(c.viewports).toEqual(DEFAULTS.viewports)  // invalid → fallback
    rmSync(root, { recursive: true, force: true })
  })
})
