import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { affectedFrameIds, extractMeta, toFrameId, type Manifest } from '../src/server/manifest.ts'
import { tidy } from '../src/client/shell/tidy.ts'
import { humanize } from '../src/client/shell/labels.ts'
import { renderMarkdown } from '../src/client/content/md.ts'
import { withFamilies, withLabelHierarchy } from '../src/client/content/diagram.tsx'

describe('withFamilies (D2 diagram family colors)', () => {
  it('appends family classDefs to a flowchart', () => {
    const out = withFamilies('flowchart TB\n  A-->B')
    expect(out).toContain('classDef blue fill:#0088FF')
    expect(out).toContain('classDef orange')
    expect(out).toContain('classDef gray')
  })
  it('leaves a non-flowchart diagram untouched', () => {
    const seq = 'sequenceDiagram\n  A->>B: hi'
    expect(withFamilies(seq)).toBe(seq)
  })
})

describe('withLabelHierarchy (D1 head/gloss auto-format)', () => {
  it('expands "Head :: gloss" into a bold-head markdown string', () => {
    const out = withLabelHierarchy('flowchart TB\n  A["Shipper :: needs freight moved"]')
    expect(out).toContain('A["`**Shipper**\n\nneeds freight moved`"]')
  })
  it('leaves a plain label (no :: token) untouched', () => {
    const src = 'flowchart TB\n  A["Shipper"]'
    expect(withLabelHierarchy(src)).toBe(src)
  })
  it('does not double-wrap a label already authored as a markdown string', () => {
    const src = 'flowchart TB\n  A["`**Shipper** :: x`"]'
    expect(withLabelHierarchy(src)).toBe(src)
  })
  it('does not add ** when the head is already emphasized', () => {
    const out = withLabelHierarchy('flowchart TB\n  A["*Shipper* :: gloss"]')
    expect(out).toContain('"`*Shipper*\n\ngloss`"')
  })
  it('composes with families and preserves an edge after the label', () => {
    const out = withFamilies(withLabelHierarchy('flowchart LR\n  A["Shipper :: needs freight"] --> B["Carrier :: hauls it"]:::orange'))
    expect(out).toContain('A["`**Shipper**\n\nneeds freight`"] --> B["`**Carrier**\n\nhauls it`"]:::orange')
    expect(out).toContain('classDef orange')
  })
  it('does not touch a :::family class tag (three colons, no spaces)', () => {
    const src = 'flowchart TB\n  A["Shipper"]:::blue'
    expect(withLabelHierarchy(src)).toBe(src)
  })
  it('leaves non-flowchart diagrams untouched', () => {
    const seq = 'sequenceDiagram\n  A->>B: "x :: y"'
    expect(withLabelHierarchy(seq)).toBe(seq)
  })
})

describe('renderMarkdown color families (D3)', () => {
  it('renders :family[text] as a colored span', () => {
    expect(renderMarkdown(':blue[shipper]')).toContain('<span class="mv-c-blue">shipper</span>')
  })
  it('parses inline markdown inside the color span', () => {
    expect(renderMarkdown(':orange[**bold**]')).toContain('<span class="mv-c-orange"><strong>bold</strong></span>')
  })
  it('an unknown family stays literal text', () => {
    expect(renderMarkdown(':pink[x]')).not.toContain('mv-c-pink')
  })
})

describe('humanize (D5 sidebar labels)', () => {
  it('de-hyphenates and Title-Cases', () => {
    expect(humanize('tms-high-level')).toBe('Tms High Level')
    expect(humanize('all-scenes')).toBe('All Scenes')
    expect(humanize('tms-specs')).toBe('Tms Specs')
  })
  it('leaves a single word Title-Cased', () => expect(humanize('structure')).toBe('Structure'))
  it('empty stays empty', () => expect(humanize('')).toBe(''))
})

describe('affectedFrameIds (A7 controlled-HMR fanout, manifest + conventions)', () => {
  const ROOT = '/proj'
  const f = (id: string, file: string, kind: 'tsx' | 'html' = 'tsx') => ({ id, file, kind, scene: id.includes('/') ? id.split('/')[0] : '' })
  const m: Manifest = { frames: [
    f('tms-specs/structure', 'design/scenes/tms-specs/structure.tsx'),
    f('tms-specs/intent', 'design/scenes/tms-specs/intent.tsx'),
    f('landing/hero', 'design/scenes/landing/hero.tsx'),
    f('widget', 'design/components/widget.tsx'),
  ], scenes: [] as any }
  const at = (p: string) => affectedFrameIds(join(ROOT, p), ROOT, m)

  it('a direct frame edit -> that exact id', () => expect(at('design/scenes/tms-specs/structure.tsx')).toEqual(['tms-specs/structure']))
  it('providers -> every tsx frame', () => expect(at('design/providers.tsx')).toEqual(['tms-specs/structure', 'tms-specs/intent', 'landing/hero', 'widget']))
  it('a scene _layout -> tsx frames under that dir', () => expect(at('design/scenes/tms-specs/_layout.tsx')).toEqual(['tms-specs/structure', 'tms-specs/intent']))
  it('the root scenes _layout -> all scene tsx frames', () => expect(at('design/scenes/_layout.tsx')).toEqual(['tms-specs/structure', 'tms-specs/intent', 'landing/hero']))
  it('_fixtures -> tsx frames under its dir', () => expect(at('design/scenes/landing/_fixtures.ts')).toEqual(['landing/hero']))
  it('theme.css -> null (CSS HMR owns it)', () => expect(at('design/theme.css')).toBeNull())
  it('config.ts -> null (not a frame)', () => expect(at('design/config.ts')).toBeNull())
  it('a src/** dep -> null (default HMR)', () => expect(at('src/components/Button.tsx')).toBeNull())
})

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

describe('Live Jam M3: parseMentions (@marver rendering, SPEC-live-jam §1)', async () => {
  const { parseMentions } = await import('../src/client/shell/mentions.ts')
  it('splits a body into text + @marver mention segments (case-insensitive)', () => {
    expect(parseMentions('hey @marver fix this')).toEqual([
      { text: 'hey ', mention: false }, { text: '@marver', mention: true }, { text: ' fix this', mention: false },
    ])
    expect(parseMentions('@Marver at the start').filter((s) => s.mention).map((s) => s.text)).toEqual(['@Marver'])
  })
  it('a body with no mention is one plain segment', () => {
    expect(parseMentions('just a note')).toEqual([{ text: 'just a note', mention: false }])
  })
  it('does not match @marvers or @marvel (word boundary)', () => {
    expect(parseMentions('@marvel movie').some((s) => s.mention)).toBe(false)
    expect(parseMentions('email @marver.design').some((s) => s.mention)).toBe(true)   // @marver then .design
  })
})

describe('Live Jam M0: config.jam (SPEC-live-jam §M0)', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { loadConfig } = await import('../src/server/config.ts')
  const load = async (src: string) => {
    const root = mkdtempSync(join(tmpdir(), 'sh-jam-'))
    mkdirSync(join(root, 'design'))
    writeFileSync(join(root, 'design/config.ts'), src)
    const c = await loadConfig(root)
    rmSync(root, { recursive: true, force: true })
    return c
  }
  it('no jam block → Live Jam stays off (undefined)', async () => {
    expect((await load(`export default { port: 6001 }\n`)).jam).toBeUndefined()
  })
  it('jam without an agent → off (a stray jam:{} never arms the daemon)', async () => {
    expect((await load(`export default { jam: {} }\n`)).jam).toBeUndefined()
  })
  it('bad agent → off', async () => {
    expect((await load(`export default { jam: { agent: 'gpt' } }\n`)).jam).toBeUndefined()
  })
  it('agent set → armed with lean defaults', async () => {
    expect((await load(`export default { jam: { agent: 'claude' } }\n`)).jam)
      .toEqual({ agent: 'claude', concurrency: 3, subagents: true, proactive: false })
  })
  it('explicit fields respected; out-of-range concurrency falls back; proactive opt-in', async () => {
    expect((await load(`export default { jam: { agent: 'codex', concurrency: 99, subagents: false, proactive: true } }\n`)).jam)
      .toEqual({ agent: 'codex', concurrency: 3, subagents: false, proactive: true })
  })
})

describe('Live Jam M0: authorization ledger (SPEC-live-jam §1)', async () => {
  const { mkdtempSync, rmSync, statSync, appendFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { has, record } = await import('../src/server/jam/ledger.ts')

  it('record then has → true; an unrecorded (e.g. synced-in) id → false', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-ledger-'))
    record(root, 'evt-owner-1')
    expect(has(root, 'evt-owner-1')).toBe(true)
    expect(has(root, 'evt-synced-remote')).toBe(false)   // the anti-spoof invariant
    expect(has(root, '')).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })
  it('has() on a fresh repo (no ledger file) → false, never throws', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-ledger-'))
    expect(has(root, 'anything')).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })
  it('ledger file is 0600 (owner-only)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-ledger-'))
    record(root, 'evt-1')
    const mode = statSync(join(root, 'design', '.local', 'jam-ledger')).mode & 0o777
    expect(mode).toBe(0o600)
    rmSync(root, { recursive: true, force: true })
  })
  it('a torn final line (interrupted append) is tolerated, real ids still match', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-ledger-'))
    record(root, 'evt-1')
    appendFileSync(join(root, 'design', '.local', 'jam-ledger'), 'evt-2-torn-no-newline')  // no trailing \n
    expect(has(root, 'evt-1')).toBe(true)
    expect(has(root, 'evt-2-torn-no-newline')).toBe(true)   // last line, no newline, still exact-matches
    rmSync(root, { recursive: true, force: true })
  })
})

describe('Live Jam M0: owner gate (SPEC-live-jam §1, CSRF double-submit + Origin)', async () => {
  const { ownerGated } = await import('../src/server/api.ts')
  const req = (headers: Record<string, string>) => ({ headers })
  it('cookie mv_c echoed as x-mv-c, same-origin (host:port matches) → allowed', () => {
    expect(ownerGated(req({ cookie: 'mv_c=tok123', 'x-mv-c': 'tok123', origin: 'http://localhost:5200', host: 'localhost:5200' }))).toBe(true)
  })
  it('no cookie → rejected (the drive-by that never got mv_c)', () => {
    expect(ownerGated(req({ 'x-mv-c': 'tok123', origin: 'http://localhost:5200', host: 'localhost:5200' }))).toBe(false)
  })
  it('header does not match cookie → rejected (cannot forge without reading the cookie)', () => {
    expect(ownerGated(req({ cookie: 'mv_c=real', 'x-mv-c': 'guess', origin: 'http://localhost:5200', host: 'localhost:5200' }))).toBe(false)
  })
  it('foreign Origin → rejected even with a matching double-submit', () => {
    expect(ownerGated(req({ cookie: 'mv_c=tok', 'x-mv-c': 'tok', origin: 'https://evil.example.com', host: 'localhost:5200' }))).toBe(false)
  })
  it('another localhost PORT → rejected (cookies are not port-scoped; the same-origin host:port check catches it)', () => {
    expect(ownerGated(req({ cookie: 'mv_c=tok', 'x-mv-c': 'tok', origin: 'http://localhost:9999', host: 'localhost:5200' }))).toBe(false)
  })
  it('absent Origin falls back to the cookie proof (same-origin requests may omit Origin)', () => {
    expect(ownerGated(req({ cookie: 'mv_c=tok', 'x-mv-c': 'tok', host: 'localhost:5200' }))).toBe(true)
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
  it('Live Jam: agent + agentMeta flow onto the root and replies', () => {
    const meta = { devUser: 'Nic', harness: 'Claude Code', model: 'claude-opus-5', effort: 'xhigh' }
    const threads = replay([
      ev('e1', 'create', { commentId: 'c1', body: '@marver bolden this' }),
      ev('e2', 'reply', { commentId: 'c2', parentId: 'c1', body: 'Done.', agent: true, agentMeta: meta }),
    ])
    expect(threads[0].agent).toBeFalsy()               // human root
    expect(threads[0].replies[0].agent).toBe(true)     // agent reply
    expect(threads[0].replies[0].agentMeta).toEqual(meta)
  })
  it('Live Jam: reanchor re-pins the whole thread to the new element', () => {
    const oldA = { el: { cssPath: 'button#a' } }
    const newA = { el: { cssPath: 'button#b', semantics: { testId: 'cta' } } }
    const threads = replay([
      ev('e1', 'create', { commentId: 'c1', anchor: oldA }),
      ev('e2', 'reply', { commentId: 'c2', parentId: 'c1', body: 'moved it' }),
      ev('e3', 'reanchor', { commentId: 'c1', anchor: newA }),
    ])
    expect(threads[0].anchor).toEqual(newA)            // thread (and all its comments) now on the new element
    expect(threads[0].replies).toHaveLength(1)         // reanchor doesn't disturb replies
  })
  it('Live Jam: a null-anchor reanchor is ignored (never un-pins)', () => {
    const a0 = { el: { cssPath: 'button#a' } }
    const threads = replay([
      ev('e1', 'create', { commentId: 'c1', anchor: a0 }),
      ev('e2', 'reanchor', { commentId: 'c1', anchor: null }),
    ])
    expect(threads[0].anchor).toEqual(a0)              // still pinned to the original
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

describe('auth - invites, accounts, sessions (SPEC-M3 §3)', async () => {
  const auth = await import('../src/server/auth.ts')
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const store = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-auth-'))
    try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('invite → claim → session: the whole identity bootstrap, no email infra', () =>
    store((dir) => {
      const { token } = auth.createInvite(dir, 'Nic@Example.com')
      const { user, session } = auth.claimInvite(dir, token, { password: 'hunter22plus', name: 'Nic' })
      expect(user.email).toBe('nic@example.com')      // normalized
      expect(user.role).toBe('owner')                 // first account owns the canvas
      expect(auth.sessionUser(dir, session)?.name).toBe('Nic')
    }))
  it('invites are single-use and unknown tokens fail', () =>
    store((dir) => {
      const { token } = auth.createInvite(dir, 'a@x.com')
      auth.claimInvite(dir, token, { password: 'longenough1', name: 'A' })
      expect(() => auth.claimInvite(dir, token, { password: 'longenough1', name: 'B' })).toThrow(/invalid, expired/)
      expect(() => auth.claimInvite(dir, 'not-a-token', { password: 'longenough1', name: 'B' })).toThrow(/invalid, expired/)
    }))
  it('a stale auth lock is stolen, never deadlocks (release-gate P1)', async () => {
    const { writeFileSync, utimesSync } = await import('node:fs')
    store((dir) => {
      // a crashed holder left .auth.lock behind, mtime 30s ago
      writeFileSync(join(dir, '.auth.lock'), '')
      const old = Date.now() / 1000 - 30
      utimesSync(join(dir, '.auth.lock'), old, old)
      // the next write must steal it and succeed, not hang
      const { token } = auth.createInvite(dir, 'a@x.com')
      expect(auth.inviteInfo(dir, token)?.email).toBe('a@x.com')
    })
  })
  it('validAvatar checks magic bytes, not the declared MIME (gate v2 P2)', async () => {
    const { validAvatar } = await import('../src/server/collab.ts')
    const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString('base64')
    const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')
    const svgAsPng = 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64')
    expect(validAvatar(png)).toBe(true)
    expect(validAvatar(jpeg)).toBe(true)
    expect(validAvatar(svgAsPng)).toBe(false)       // real bytes betray the lie
    expect(validAvatar('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
    expect(validAvatar('data:image/png;base64,not valid base64!!')).toBe(false)
    expect(validAvatar('x'.repeat(70000))).toBe(false)   // over the cap
    expect(validAvatar(123)).toBe(false)
  })
  it('inviteInfo peeks a live invite, goes dark after claim; ownerName is public-safe (gate v2)', () =>
    store((dir) => {
      expect(auth.ownerName(dir)).toBeNull()             // pre-claim: no owner yet
      const { token } = auth.createInvite(dir, 'Colleague@X.com')
      expect(auth.inviteInfo(dir, token)?.email).toBe('colleague@x.com')
      expect(auth.inviteInfo(dir, 'wrong-token')).toBeNull()
      auth.claimInvite(dir, token, { password: 'longenough1', name: 'Col' })
      expect(auth.inviteInfo(dir, token)).toBeNull()     // burned with the claim
      expect(auth.ownerName(dir)).toBe('Col')            // first account owns the canvas
    }))
  it('sign-in verifies scrypt and is generic on failure; second account is member', () =>
    store((dir) => {
      const a = auth.createInvite(dir, 'a@x.com')
      auth.claimInvite(dir, a.token, { password: 'correct-horse', name: 'A' })
      const b = auth.createInvite(dir, 'b@x.com')
      expect(auth.claimInvite(dir, b.token, { password: 'battery-staple', name: 'B' }).user.role).toBe('member')
      expect(auth.signIn(dir, 'a@x.com', 'correct-horse')?.user.name).toBe('A')
      expect(auth.signIn(dir, 'a@x.com', 'wrong')).toBeNull()
      expect(auth.signIn(dir, 'ghost@x.com', 'whatever')).toBeNull()
    }))
  it('raw tokens never touch disk - only hashes', () =>
    store((dir) => {
      const { token } = auth.createInvite(dir, 'a@x.com')
      const { session } = auth.claimInvite(dir, token, { password: 'longenough1', name: 'A' })
      const raw = readFileSync(join(dir, 'auth.json'), 'utf8')
      expect(raw).not.toContain(token)
      expect(raw).not.toContain(session)
      expect(raw).not.toContain('longenough1')
    }))
  it('sessions survive a restart (fresh read of the same dir) and sign-out revokes', () =>
    store((dir) => {
      const { token } = auth.createInvite(dir, 'a@x.com')
      const { session } = auth.claimInvite(dir, token, { password: 'longenough1', name: 'A' })
      expect(auth.sessionUser(dir, session)).not.toBeNull()   // loadStore reads disk every call = restart-equivalent
      auth.signOut(dir, session)
      expect(auth.sessionUser(dir, session)).toBeNull()
    }))
  it('revokeUser removes a member; the last owner is protected', () =>
    store((dir) => {
      const a = auth.createInvite(dir, 'a@x.com')
      auth.claimInvite(dir, a.token, { password: 'longenough1', name: 'Owner' })
      const b = auth.createInvite(dir, 'b@x.com')
      const { session } = auth.claimInvite(dir, b.token, { password: 'longenough2', name: 'B' })
      auth.revokeUser(dir, 'B@X.COM')
      expect(auth.sessionUser(dir, session)).toBeNull()
      expect(auth.signIn(dir, 'b@x.com', 'longenough2')).toBeNull()
      expect(() => auth.revokeUser(dir, 'a@x.com')).toThrow(/last owner/)
    }))
  it('weak passwords and blank names are rejected at claim', () =>
    store((dir) => {
      const { token } = auth.createInvite(dir, 'a@x.com')
      expect(() => auth.claimInvite(dir, token, { password: 'short', name: 'A' })).toThrow(/at least 8/)
      expect(() => auth.claimInvite(dir, token, { password: 'longenough1', name: '  ' })).toThrow(/display name/)
    }))
})

describe('validateEvents (SPEC-M3 - acceptance is forever, validate hard)', async () => {
  const { validateEvents } = await import('../src/server/collab.ts')
  const me = { email: 'nic@x.com', name: 'Nic', role: 'member', salt: '', hash: '', params: {} as any, createdAt: 0 } as any
  const mine = { email: 'nic@x.com', name: 'Nic' }
  const now = () => Date.now()
  const log = [
    { id: 'L1', ts: 1755000000000, type: 'create' as const, commentId: 'c-exists', author: { email: 'other@x.com', name: 'Other' }, body: 'hi' },
  ]

  it('accepts a well-formed create + reply chain', () => {
    expect(validateEvents([
      { id: 'e-aaaaaaaa', ts: now(), type: 'create', commentId: 'c-new00001', author: mine, body: 'x' },
      { id: 'e-bbbbbbbb', ts: now(), type: 'reply', commentId: 'c-new00002', parentId: 'c-new00001', author: mine, body: 'y' },
    ], log, me, 'review')).toBeNull()
  })
  it('rejects hijacking an existing thread id', () => {
    expect(validateEvents([
      { id: 'e-aaaaaaaa', ts: 1600000000000, type: 'create', commentId: 'c-exists', author: mine, body: 'mine now' },
    ], log, me, 'review')).toMatch(/already exists/)
  })
  it('rejects author impersonation', () => {
    expect(validateEvents([
      { id: 'e-aaaaaaaa', ts: now(), type: 'create', commentId: 'c-n1000000', author: { email: 'other@x.com' }, body: 'x' },
    ], log, me, 'review')).toMatch(/signed-in account/)
  })
  it('rejects future-dated events', () => {
    expect(validateEvents([
      { id: 'e-aaaaaaaa', ts: now() + 3600_000, type: 'create', commentId: 'c-n1000000', author: mine, body: 'x' },
    ], log, me, 'review')).toMatch(/timestamp/)
  })
  it("rejects editing someone else's comment, allows editing your own", () => {
    expect(validateEvents([
      { id: 'e-aaaaaaaa', ts: now(), type: 'edit', commentId: 'c-exists', author: mine, body: 'rewritten' },
    ], log, me, 'review')).toMatch(/only the author/)
    const ownLog = [...log, { id: 'L2', ts: 1755000001000, type: 'create' as const, commentId: 'c-mine0001', author: mine, body: 'v1' }]
    expect(validateEvents([
      { id: 'e-aaaaaaaa', ts: now(), type: 'edit', commentId: 'c-mine0001', author: mine, body: 'v2' },
    ], ownLog, me, 'review')).toBeNull()
  })
  it('rejects replies to ghosts and cross-board events', () => {
    expect(validateEvents([
      { id: 'e-aaaaaaaa', ts: now(), type: 'reply', commentId: 'c-n1000000', parentId: 'c-ghost000', author: mine, body: 'x' },
    ], log, me, 'review')).toMatch(/parent/)
    expect(validateEvents([
      { id: 'e-aaaaaaaa', ts: now(), type: 'create', commentId: 'c-n1000000', author: mine, body: 'x', board: 'other-board' },
    ], log, me, 'review')).toMatch(/board/)
  })
})
