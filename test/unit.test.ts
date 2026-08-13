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

  it('a recipe whose every lane dropped still forms ONE leftover row (scene scope)', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const placed = tidy(
      [N('a', 'shop/a', 'shop'), N('b', 'shop/b', 'shop')],
      { scenes: { shop: { rows: [['ghost']] } } },
    )
    const p = Object.fromEntries(placed.map((q) => [q.key, q]))
    expect(p.a).toMatchObject({ x: 0, y: 0 })
    expect(p.b).toMatchObject({ x: 240, y: 0 })    // same row, not scattered into lanes
  })

  it('member-then-group: the group atom skips instead of tearing the run', async () => {
    const { tidy } = await import('../src/client/shell/tidy.ts')
    const warnings: string[] = []
    const placed = tidy(
      [
        N('va', 'shop/dir/a-x', 'shop', 100, 100, { group: 'shop/dir', variant: 'a' }),
        N('vb', 'shop/dir/b-y', 'shop', 100, 100, { group: 'shop/dir', variant: 'b' }),
        N('z', 'shop/z', 'shop'),
      ],
      { scenes: { shop: { rows: [['dir/a-x', { space: 3 }, 'dir', 'z']] } } },
      (m) => warnings.push(m),
    )
    const p = Object.fromEntries(placed.map((q) => [q.key, q]))
    expect(warnings.join(' ')).toMatch(/partially placed/)
    expect(p.va.x).toBe(0)                         // the explicit member placement stands
    expect(p.z.x).toBe(100 + 140 * 3)              // group atom skipped; z follows the spacer
    expect(p.vb.x).toBeGreaterThan(p.z.x)          // remainder appends as unlisted
  })

  it('parseLayout: junk warns, never silently vanishes; empty rows IS a layout', async () => {
    const { parseLayout } = await import('../src/client/shell/tidy.ts')
    const w1: string[] = []
    expect(parseLayout({ scenes: { shop: 7, ok: { rows: [] } } }, (m) => w1.push(m))?.scenes)
      .toEqual({ ok: { rows: [] } })
    expect(w1.join(' ')).toMatch(/scenes\["shop"\]/)
    const w2: string[] = []
    expect(parseLayout({ scenes: [] }, (m) => w2.push(m))).toBeNull()
    expect(w2.join(' ')).toMatch(/scenes must be an object map/)
    const w3: string[] = []
    const p3 = parseLayout({ rows: [[42], ['alpha']] }, (m) => w3.push(m))
    expect(p3?.rows).toEqual([[], ['alpha']])
    expect(w3.join(' ')).toMatch(/invalid layout atom 42/)
    expect(parseLayout({ rows: [] }, () => {})).toEqual({ rows: [] })
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

describe('content frames (SPEC-026)', () => {
  const CONTENT = `import { Doc, Row, Md, Diagram, Img } from '@marver-design/marver/content'\n`

  it('contentScan: UI frame with "<Diagram" in a string never misbadges', async () => {
    const { contentScan } = await import('../src/server/manifest.ts')
    expect(contentScan(`export default () => <pre>{'<Diagram title="x">'}</pre>`)).toBeNull()
  })
  it('contentScan: diagram usage wins the heuristic; wide sets 1280', async () => {
    const { contentScan } = await import('../src/server/manifest.ts')
    const r = contentScan(`${CONTENT}export default () => <Doc layout="wide"><Diagram>{'flowchart'}</Diagram><Md>{'x'}</Md></Doc>`)
    expect(r).toEqual({ intent: 'diagram', width: 1280 })
  })
  it('contentScan: image-majority -> moodboard; document default 760', async () => {
    const { contentScan } = await import('../src/server/manifest.ts')
    const r = contentScan(`${CONTENT}export default () => <Doc><Img src="a.png" /><Img src="b.png" /><Md>{'x'}</Md></Doc>`)
    expect(r).toEqual({ intent: 'moodboard', width: 760 })
  })
  it('contentScan: text-only -> spec', async () => {
    const { contentScan } = await import('../src/server/manifest.ts')
    expect(contentScan(`${CONTENT}export default () => <Doc><Md>{'# spec'}</Md></Doc>`)?.intent).toBe('spec')
  })
  it('declared meta.intent wins over the heuristic (scanFrames)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { scanFrames } = await import('../src/server/manifest.ts')
    const root = mkdtempSync(join(tmpdir(), 'sh-intent-'))
    mkdirSync(join(root, 'design/scenes/plan'), { recursive: true })
    writeFileSync(join(root, 'design/scenes/plan/story.tsx'),
      `${CONTENT}export const meta = { intent: 'diagram' }\nexport default () => <Doc><Md>{'mostly text'}</Md></Doc>`)
    writeFileSync(join(root, 'design/scenes/plan/ui.tsx'),
      `export const meta = { intent: 'diagram' }\nexport default () => <div />`)
    const m = scanFrames(root)
    const story = m.frames.find((f) => f.id === 'plan/story')!
    expect(story.intent).toBe('diagram')
    expect(story.contentWidth).toBe(760)
    // declaring meta.intent DECLARES a content frame - the taught path works even
    // when the import scan can't see the primitives (barrels; codex impl #10)
    const declared = m.frames.find((f) => f.id === 'plan/ui')!
    expect(declared.intent).toBe('diagram')
    expect(declared.contentWidth).toBe(760)
    rmSync(root, { recursive: true, force: true })
  })

  it('assetUrl: local relative only, fail closed on tricks', async () => {
    const { assetUrl } = await import('../src/client/content/md.ts')
    expect(assetUrl('shot.png')).toBe('/design/assets/shot.png')
    expect(assetUrl('sub/dir/shot.png')).toBe('/design/assets/sub/dir/shot.png')
    expect(assetUrl('https://x.com/a.png')).toBeNull()
    expect(assetUrl('/etc/passwd')).toBeNull()
    expect(assetUrl('../secret.png')).toBeNull()
    expect(assetUrl('data:image/png;base64,x')).toBeNull()
  })
  it('renderMarkdown: raw HTML inert, goto links, image policy', async () => {
    const { renderMarkdown } = await import('../src/client/content/md.ts')
    expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script>')
    expect(renderMarkdown('[cart](goto:checkout/cart)')).toContain('data-goto="checkout/cart"')
    const ext = renderMarkdown('[docs](https://mermaid.js.org)')
    expect(ext).toContain('target="_blank"')
    expect(ext).toContain('rel="noopener')
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('javascript:')
    expect(renderMarkdown('![shot](https://evil.com/a.png)')).not.toContain('evil.com')
    expect(renderMarkdown('![shot](local.png)')).toContain('/design/assets/local.png')
  })
  it('cleanSource strips frontmatter and init directives', async () => {
    const { cleanSource } = await import('../src/client/content/diagram.tsx')
    expect(cleanSource(`---\ntheme: forest\n---\nflowchart LR\n A-->B`)).toBe('flowchart LR\n A-->B')
    expect(cleanSource(`%%{init: {"theme":"dark"}}%%\nflowchart LR\n A-->B`)).toBe('flowchart LR\n A-->B')
  })

  it('scanAssetRefs: literals collected, computed src fails closed', async () => {
    const { scanAssetRefs, isLocalAssetRef } = await import('../src/server/build.ts')
    expect(scanAssetRefs(`<Img src="a.png" caption="x" /> and \`![shot](sub/b.png)\``, 'm')).toEqual(['a.png', 'sub/b.png'])
    expect(() => scanAssetRefs(`<Img src={dynamic} />`, 'design/scenes/x.tsx')).toThrow(/computed/)
    expect(isLocalAssetRef('a.png')).toBe(true)
    expect(isLocalAssetRef('../a.png')).toBe(false)
    expect(isLocalAssetRef('https://x/a.png')).toBe(false)
    expect(isLocalAssetRef('/abs.png')).toBe(false)
  })
})

describe('resolvePublish (SPEC-M3 §4 - default-closed)', async () => {
  const { resolvePublish } = await import('../src/server/build.ts')
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const boards = { review: {}, archive: {} }

  const withPolicy = (policy: unknown, fn: (root: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), 'sh-pub-'))
    try {
      mkdirSync(join(root, 'design'), { recursive: true })
      if (policy !== undefined) writeFileSync(join(root, 'design', 'publish.json'), typeof policy === 'string' ? policy : JSON.stringify(policy))
      fn(root)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  it('no policy, no flags → fails closed', () =>
    withPolicy(undefined, (root) => {
      expect(() => resolvePublish(root, boards)).toThrow(/default-closed/)
    }))
  it('policy names boards with rights', () =>
    withPolicy({ boards: { review: 'comment', archive: 'read' } }, (root) => {
      expect(resolvePublish(root, boards)).toEqual({ review: 'comment', archive: 'read' })
    }))
  it('policy with unknown board fails', () =>
    withPolicy({ boards: { ghost: 'read' } }, (root) => {
      expect(() => resolvePublish(root, boards)).toThrow(/unknown board: ghost/)
    }))
  it('policy with bad level fails', () =>
    withPolicy({ boards: { review: 'write' } }, (root) => {
      expect(() => resolvePublish(root, boards)).toThrow(/"read" or "comment"/)
    }))
  it('policy with no entries fails closed', () =>
    withPolicy({ boards: {} }, (root) => {
      expect(() => resolvePublish(root, boards)).toThrow(/name what ships/)
    }))
  it('invalid JSON fails loudly', () =>
    withPolicy('{oops', (root) => {
      expect(() => resolvePublish(root, boards)).toThrow(/not valid JSON/)
    }))
  it('--boards overrides the policy and grants comment', () =>
    withPolicy({ boards: { archive: 'read' } }, (root) => {
      expect(resolvePublish(root, boards, 'review')).toEqual({ review: 'comment' })
    }))
  it('empty --boards still fails closed', () =>
    withPolicy(undefined, (root) => {
      expect(() => resolvePublish(root, boards, '')).toThrow(/named no boards/)
    }))
  it('--boards with unknown name fails', () =>
    withPolicy(undefined, (root) => {
      expect(() => resolvePublish(root, boards, 'review,ghost')).toThrow(/ghost/)
    }))
  it('--all-boards publishes everything, all-scenes first', () =>
    withPolicy(undefined, (root) => {
      expect(resolvePublish(root, boards, undefined, true)).toEqual(
        { 'all-scenes': 'comment', review: 'comment', archive: 'comment' })
    }))
})

describe('comment event store (SPEC-M3 §1 - set-union merge, deterministic replay)', async () => {
  const { appendEvents, readLog, replay, diffEvents, listBoards } = await import('../src/server/comments.ts')
  const { mkdtempSync, rmSync, appendFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const ev = (id: string, type: string, extra: object = {}) =>
    ({ id, ts: Number(id.replace(/\D/g, '') || 0), type, ...extra }) as any
  const store = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-cmt-'))
    try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('append is idempotent - re-sending events writes nothing', () =>
    store((dir) => {
      const events = [ev('e1', 'create', { commentId: 'c1', body: 'hi' })]
      expect(appendEvents(dir, 'review', events)).toHaveLength(1)
      expect(appendEvents(dir, 'review', events)).toHaveLength(0)
      expect(readLog(dir, 'review')).toHaveLength(1)
    }))
  it('merge is set union - interleaved appends from two sides converge', () =>
    store((dir) => {
      appendEvents(dir, 'review', [ev('e1', 'create', { commentId: 'c1', body: 'a' })])
      appendEvents(dir, 'review', [ev('e1', 'create', { commentId: 'c1', body: 'a' }), ev('e2', 'reply', { commentId: 'c2', parentId: 'c1', body: 'b' })])
      const log = readLog(dir, 'review')
      expect(log.map((e) => e.id)).toEqual(['e1', 'e2'])
    }))
  it('replay derives threads: create, reply, resolve with addressedIn', () => {
    const threads = replay([
      ev('e1', 'create', { commentId: 'c1', body: 'too cramped', frame: 'checkout/cart' }),
      ev('e2', 'reply', { commentId: 'c2', parentId: 'c1', body: 'on it' }),
      ev('e3', 'resolve', { commentId: 'c1', addressedIn: 'checkout/cart/b-airy' }),
    ])
    expect(threads).toHaveLength(1)
    expect(threads[0].resolved).toBe(true)
    expect(threads[0].addressedIn).toBe('checkout/cart/b-airy')
    expect(threads[0].replies.map((r) => r.body)).toEqual(['on it'])
  })
  it('replay is order-independent - same set, any arrival order, same state', () => {
    const events = [
      ev('e1', 'create', { commentId: 'c1', body: 'v1' }),
      ev('e2', 'edit', { commentId: 'c1', body: 'v2' }),
      ev('e3', 'resolve', { commentId: 'c1' }),
      ev('e4', 'reopen', { commentId: 'c1' }),
    ]
    const a = replay(events)
    const b = replay([...events].reverse())
    expect(a).toEqual(b)
    expect(a[0].body).toBe('v2')
    expect(a[0].resolved).toBe(false)
  })
  it('react toggles per author+emoji', () => {
    const me = { email: 'nic@x.com' }
    const on = replay([
      ev('e1', 'create', { commentId: 'c1' }),
      ev('e2', 'react', { commentId: 'c1', emoji: '👍', author: me }),
    ])
    expect(on[0].reactions['👍']).toEqual(['nic@x.com'])
    const off = replay([
      ev('e1', 'create', { commentId: 'c1' }),
      ev('e2', 'react', { commentId: 'c1', emoji: '👍', author: me }),
      ev('e3', 'react', { commentId: 'c1', emoji: '👍', author: me }),
    ])
    expect(off[0].reactions['👍']).toBeUndefined()
  })
  it('a torn trailing line is skipped, the rest of the log survives', () =>
    store((dir) => {
      appendEvents(dir, 'review', [ev('e1', 'create', { commentId: 'c1' })])
      appendFileSync(join(dir, 'review.jsonl'), '{"id":"e2","type":"cre')
      expect(readLog(dir, 'review').map((e) => e.id)).toEqual(['e1'])
      // and the merge rule heals it: the torn event re-arrives complete via sync
      appendEvents(dir, 'review', [ev('e2', 'reply', { commentId: 'c2', parentId: 'c1' })])
      expect(readLog(dir, 'review').map((e) => e.id)).toEqual(['e1', 'e2'])
    }))
  it('diffEvents yields exactly what the other side lacks', () => {
    const mine = [ev('e1', 'create', { commentId: 'c1' }), ev('e2', 'reply', { commentId: 'c2', parentId: 'c1' })]
    expect(diffEvents(mine, ['e1']).map((e) => e.id)).toEqual(['e2'])
    expect(diffEvents(mine, ['e1', 'e2'])).toHaveLength(0)
  })
  it('board names are validated, logs listed sorted', () =>
    store((dir) => {
      appendEvents(dir, 'zeta', [ev('e1', 'create', { commentId: 'c1' })])
      appendEvents(dir, 'alpha', [ev('e2', 'create', { commentId: 'c2' })])
      expect(listBoards(dir)).toEqual(['alpha', 'zeta'])
      expect(() => readLog(dir, '../escape')).toThrow(/bad board name/)
    }))
})
