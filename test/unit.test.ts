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
      { key: 'b1', frame: 'beta/x', scene: 'beta', w: 100, h: 200 },
      { key: 'a1', frame: 'alpha/one', scene: 'alpha', w: 100, h: 100 },
      { key: 'a2', frame: 'alpha/two', scene: 'alpha', w: 100, h: 150 },
    ])
    const byKey = Object.fromEntries(placed.map((p) => [p.key, p]))
    expect(byKey.a1).toEqual({ key: 'a1', x: 0, y: 0 })
    expect(byKey.a2).toEqual({ key: 'a2', x: 240, y: 0 })
    expect(byKey.b1.y).toBe(150 + 96) // tallest alpha + scene gap
    expect(byKey.b1.x).toBe(0)
  })
  it('preserves in-scene order (append-only respect)', () => {
    const placed = tidy([
      { key: 'x2', frame: 's/two', scene: 's', w: 50, h: 50 },
      { key: 'x1', frame: 's/one', scene: 's', w: 50, h: 50 },
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

describe('variant groups (SPEC-023 §1)', () => {
  const mk = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, file: `design/scenes/${id}.tsx`, kind: 'tsx', scene: id.split('/')[0], ...extra }) as any

  it('infers groups from letter-prefixed siblings; states and loners never group', async () => {
    const { scanFrames } = await import('../src/server/manifest.ts')
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'mv-vg-'))
    const w = (rel: string, body = 'export default () => null') => {
      mkdirSync(join(root, 'design', 'scenes', ...rel.split('/').slice(0, -1)), { recursive: true })
      writeFileSync(join(root, 'design', 'scenes', rel), body)
    }
    w('landing/a-terminal.tsx'); w('landing/b-editorial.tsx')
    w('landing/empty.tsx')                                 // state: never groups
    w('checkout/cart.tsx')
    w('checkout/payment/a-card.tsx'); w('checkout/payment/b-wallet.tsx')   // nested scope
    w('docs/a-only.tsx')                                   // lone letter-prefix: no group
    w('hero/x.tsx', 'export const meta = { of: "hero", variant: "z" }\nexport default () => null')
    w('hero/a-one.tsx')                                    // meta.of joins the letter frame
    const byId = Object.fromEntries(scanFrames(root).frames.map((f) => [f.id, f]))
    rmSync(root, { recursive: true, force: true })
    expect(byId['landing/a-terminal'].variantGroup).toBe('landing')
    expect(byId['landing/b-editorial'].variant).toBe('b')
    expect(byId['landing/empty'].variantGroup).toBeUndefined()
    expect(byId['checkout/payment/a-card'].variantGroup).toBe('checkout/payment')
    expect(byId['checkout/cart'].variantGroup).toBeUndefined()
    expect(byId['docs/a-only'].variantGroup).toBeUndefined()
    expect(byId['hero/x'].variantGroup).toBe('hero')
    expect(byId['hero/x'].variant).toBe('z')
    expect(byId['hero/a-one'].variantGroup).toBe('hero')
  })

  it('tidy keeps a variant group contiguous and ordered, without reordering nodes', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const placed = tidy([
      { key: 'k1', frame: 'landing/b-two', scene: 'landing', group: 'landing', variant: 'b', w: 100, h: 100 },
      { key: 'k2', frame: 'landing/thanks', scene: 'landing', w: 100, h: 100 },
      { key: 'k3', frame: 'landing/a-one', scene: 'landing', group: 'landing', variant: 'a', w: 100, h: 100 },
    ])
    const x = Object.fromEntries(placed.map((p) => [p.key, p.x]))
    // group run starts at first member's slot, ordered a then b, k2 after the run
    expect(x.k3).toBeLessThan(x.k1)
    expect(x.k1).toBeLessThan(x.k2)
  })

  it('tidy honors row lanes: side-by-side scenes share a row, unlisted append below', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const placed = tidy([
      { key: 'a', frame: 'landing/x', scene: 'landing', w: 100, h: 100 },
      { key: 'b', frame: 'docs/x', scene: 'docs', w: 100, h: 100 },
      { key: 'c', frame: 'pricing/x', scene: 'pricing', w: 100, h: 100 },
    ], { rows: [['landing', 'docs']] })
    const p = Object.fromEntries(placed.map((q) => [q.key, q]))
    expect(p.a.y).toBe(p.b.y)            // same row
    expect(p.b.x).toBeGreaterThan(p.a.x) // docs to the right
    expect(p.c.y).toBeGreaterThan(p.a.y) // pricing below
  })
})

describe('lane flow (SPEC-024)', () => {
  const N = (key: string, frame: string, scene: string, w = 100, h = 100, extra: object = {}) =>
    ({ key, frame, scene, w, h, ...extra })

  it('column lanes share an X origin; lane spacers multiply the horizontal unit', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const placed = tidy(
      [N('h', 'hero/main', 'hero'), N('a', 'archive/old', 'archive', 80, 80), N('v', 'variants/x', 'variants', 50, 50)],
      { columns: [['hero', { space: 2 }, 'archive'], { space: 4 }, ['variants']] },
    )
    const p = Object.fromEntries(placed.map((q) => [q.key, q]))
    expect(p.h.x).toBe(0)
    expect(p.a.x).toBe(0)                          // the column alignment
    expect(p.a.y).toBe(100 + 96 * 2)               // 2 vertical units below hero
    expect(p.v.x).toBe(100 + 280 * 4)              // lane extent + 4 horizontal units
    expect(p.v.y).toBe(0)                          // lanes share the top
  })

  it('scene recipe: frames, a big gap, then the variant run - indivisible and ordered', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const placed = tidy(
      [
        N('one', 'shop/one', 'shop'),
        N('two', 'shop/two', 'shop'),
        N('pb', 'shop/pay/b-y', 'shop', 60, 60, { group: 'shop/pay', variant: 'b' }),
        N('pa', 'shop/pay/a-x', 'shop', 60, 60, { group: 'shop/pay', variant: 'a' }),
      ],
      { scenes: { shop: { rows: [['one', 'two', { space: 3 }, 'pay']] } } },
    )
    const p = Object.fromEntries(placed.map((q) => [q.key, q]))
    expect(p.two.x).toBe(240)                      // 100 + one frame unit (140)
    expect(p.pa.x).toBe(240 + 100 + 140 * 3)       // 3 units before the run
    expect(p.pb.x).toBe(p.pa.x + 60 + 140)         // a before b, standard gap inside the run
  })

  it('guards: unknown atoms skip, invalid space = 1 unit', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const warnings: string[] = []
    const placed = tidy(
      [N('a', 'alpha/x', 'alpha'), N('b', 'beta/x', 'beta')],
      { rows: [['alpha', { space: 0 }, 'ghost', 'beta']] },
      (m) => warnings.push(m),
    )
    const p = Object.fromEntries(placed.map((q) => [q.key, q]))
    expect(p.b.x).toBe(100 + 280)                  // ghost skipped, space 0 degraded to 1 unit
    expect(p.b.y).toBe(0)
    expect(warnings.join(' ')).toMatch(/unknown scene "ghost"/)
    expect(warnings.join(' ')).toMatch(/invalid space/)
  })

  it('rows AND columns is invalid: plain tidy, not a silent pick', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const warnings: string[] = []
    const placed = tidy(
      [N('b', 'beta/x', 'beta'), N('a', 'alpha/x', 'alpha')],
      { rows: [['beta']], columns: [['alpha']] },
      (m) => warnings.push(m),
    )
    const p = Object.fromEntries(placed.map((q) => [q.key, q]))
    expect(p.a.y).toBe(0)                          // plain tidy: alphabetical
    expect(p.b.y).toBe(196)
    expect(warnings.join(' ')).toMatch(/rows AND columns/)
  })

  it('skipped duplicates and unknown-only lanes consume no track', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const placed1 = tidy(
      [N('a', 'alpha/x', 'alpha'), N('b', 'beta/x', 'beta')],
      { rows: [['alpha'], ['alpha'], ['beta']] },
    )
    const p1 = Object.fromEntries(placed1.map((q) => [q.key, q]))
    expect(p1.b.y).toBe(196)                       // one boundary, not two
    const placed2 = tidy(
      [N('a', 'alpha/x', 'alpha')],
      { rows: [['ghost'], ['alpha']] },
    )
    expect(placed2.find((q) => q.key === 'a')!.y).toBe(0)
  })

  it('frame/group name collision: frame wins the atom, the run appends intact', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const warnings: string[] = []
    const placed = tidy(
      [
        N('f', 'shop/pay', 'shop'),
        N('gb', 'shop/pay/b-y', 'shop', 100, 100, { group: 'shop/pay', variant: 'b' }),
        N('ga', 'shop/pay/a-x', 'shop', 100, 100, { group: 'shop/pay', variant: 'a' }),
      ],
      { scenes: { shop: { rows: [['pay']] } } },
      (m) => warnings.push(m),
    )
    const p = Object.fromEntries(placed.map((q) => [q.key, q]))
    expect(p.f.x).toBe(0)
    expect(p.ga.x).toBeGreaterThan(p.f.x)          // run appended, not swallowed
    expect(p.gb.x).toBe(p.ga.x + 240)              // contiguous and sorted
    expect(warnings.join(' ')).toMatch(/frame AND a variant group/)
  })

  it('unlisted leftovers keep variant runs indivisible and sorted', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const placed = tidy(
      [
        N('hero', 'shop/hero', 'shop'),
        N('vb', 'shop/dir/b-y', 'shop', 100, 100, { group: 'shop/dir', variant: 'b' }),
        N('other', 'shop/other', 'shop'),
        N('va', 'shop/dir/a-x', 'shop', 100, 100, { group: 'shop/dir', variant: 'a' }),
      ],
      { scenes: { shop: { rows: [['hero']] } } },
    )
    const p = Object.fromEntries(placed.map((q) => [q.key, q]))
    expect(p.va.x).toBe(240)                       // run at the first leftover slot, a first
    expect(p.vb.x).toBe(480)
    expect(p.other.x).toBe(720)                    // after the intact run
  })

  it('re-listing a member of an already-placed run is a duplicate, not a tear', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const warnings: string[] = []
    const placed = tidy(
      [
        N('va', 'shop/dir/a-x', 'shop', 100, 100, { group: 'shop/dir', variant: 'a' }),
        N('vb', 'shop/dir/b-y', 'shop', 100, 100, { group: 'shop/dir', variant: 'b' }),
      ],
      { scenes: { shop: { rows: [['dir', 'dir/a-x']] } } },
      (m) => warnings.push(m),
    )
    const p = Object.fromEntries(placed.map((q) => [q.key, q]))
    expect(p.va.x).toBe(0)                         // run intact, a before b
    expect(p.vb.x).toBe(240)
    expect(warnings.join(' ')).toMatch(/repeats already-placed/)
  })

  it('consecutive spacers degrade to ONE ordinary gap', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const warnings: string[] = []
    const placed = tidy(
      [N('a', 'alpha/x', 'alpha'), N('b', 'beta/x', 'beta')],
      { rows: [['alpha', { space: 2 }, { space: 4 }, 'beta']] },
      (m) => warnings.push(m),
    )
    const p = Object.fromEntries(placed.map((q) => [q.key, q]))
    expect(p.b.x).toBe(100 + 280)                  // one unit, not 2 and not 4
    expect(warnings.join(' ')).toMatch(/consecutive spacers/)
  })

  it('lane boundaries size from BOTH neighbors', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const placed = tidy(
      [N('s', 'small/x', 'small', 100, 100), N('l', 'large/x', 'large', 2000, 100)],
      { columns: [['small'], ['large']] },
    )
    const p = Object.fromEntries(placed.map((q) => [q.key, q]))
    expect(p.l.x).toBe(100 + 400)                  // max(280, 2000 * 0.2), not the 100px side
  })

  it('unlisted frames in a recipe scene append after the recipe atoms', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const placed = tidy(
      [N('one', 'shop/one', 'shop'), N('extra', 'shop/extra', 'shop')],
      { scenes: { shop: { rows: [['one']] } } },
    )
    const p = Object.fromEntries(placed.map((q) => [q.key, q]))
    expect(p.extra.x).toBeGreaterThan(p.one.x)
  })
})
