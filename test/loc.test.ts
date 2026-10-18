import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { addSourceLocations, locPlugin } from '../src/server/loc.ts'

/**
 * Every element knows its source (spec 27, Part 6): a dev-only transform adds
 * data-mv-loc="<path>:<line>:<col>" to every host element of a design file - first in the tag, so
 * an explicit one or a spread later wins - and its source map points back to the original column.
 * Columns are 1-based UTF-16 code units (JS string indices, what source maps and editors count).
 */

const F = 'design/scenes/pricing/checkout.tsx'
const locs = (code: string) => [...(addSourceLocations(code, F)?.code ?? code).matchAll(/data-mv-loc=\{"([^"]+)"\}/g)].map((m) => m[1])

/** Decode one VLQ segment list of a v3 source map's `mappings` - enough to map a generated position back. */
function decodeMappings(mappings: string): number[][][] {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const lines: number[][][] = []
  let src = 0, origLine = 0, origCol = 0
  for (const line of mappings.split(';')) {
    const segs: number[][] = []
    let genCol = 0
    for (const seg of line.split(',').filter(Boolean)) {
      const vals: number[] = []
      let shift = 0, value = 0
      for (const ch of seg) {
        const d = B64.indexOf(ch)
        value += (d & 31) << shift
        if (d & 32) shift += 5
        else { vals.push(value & 1 ? -(value >> 1) : value >> 1); shift = 0; value = 0 }
      }
      genCol += vals[0]
      if (vals.length >= 4) { src += vals[1]; origLine += vals[2]; origCol += vals[3]; segs.push([genCol, src, origLine, origCol]) }
    }
    lines.push(segs)
  }
  return lines
}

describe('data-mv-loc: the transform', () => {
  it('host elements only - components and member names are skipped, fragments and maps are fine', () => {
    const code = [
      'export default () => (',
      '  <main>',
      '    <Card><span>a</span></Card>',
      '    <motion.div />',
      '    <>{[1, 2].map((i) => <li key={i}>{i}</li>)}</>',
      '    <my-el />',
      '  </main>',
      ')',
    ].join('\n')
    expect(locs(code)).toEqual([`${F}:2:3`, `${F}:3:11`, `${F}:5:26`, `${F}:6:5`])
  })

  it('goes first in the tag: an explicit data-mv-loc and a spread later in the tag win', () => {
    const out = addSourceLocations('const a = <div {...p} /> ; const b = <span data-mv-loc="mine" />', F)!.code
    expect(out).toContain(`<div data-mv-loc={"${F}:1:11"} {...p} />`)
    expect(out).toContain(`<span data-mv-loc={"${F}:1:38"} data-mv-loc="mine" />`)
  })

  it('counts columns in UTF-16 code units: an emoji and an accent before the tag', () => {
    const code = 'const é = "😀"; export default () => <main />'
    // é is one unit, 😀 two (one code point): the column is the UTF-16 index + 1, one more than code points
    const at = code.indexOf('<main')
    expect([...code.slice(0, at)].length).toBe(at - 1)
    expect(locs(code)).toEqual([`${F}:1:${at + 1}`])
  })

  it('a generic arrow and a > inside strings and template literals are not tags', () => {
    const code = [
      'const id = <T,>(x: T) => x',
      'const s = "<div>" + `<span>${">"}</span>`',
      'export default () => <p>{s}</p>',
    ].join('\n')
    expect(locs(code)).toEqual([`${F}:3:22`])
  })

  it('nothing to add, or a file that does not parse: no change (Vite reports the error itself)', () => {
    expect(addSourceLocations('export const x = 1', F)).toBeNull()
    expect(addSourceLocations('export default () => <Card />', F)).toBeNull()
    expect(addSourceLocations('export default () => <div', F)).toBeNull()
  })

  it('the source map points each element back to its original column', () => {
    const code = 'const é = "😀"\nexport default () => (\n  <main>\n    <b>x</b>\n  </main>\n)'
    const r = addSourceLocations(code, F)!
    const lines = decodeMappings(r.map.mappings)
    const outLines = r.code.split('\n')
    for (const [tag, origLine, origCol] of [['<main', 2, 2], ['<b', 3, 4]] as const) {
      const gl = outLines.findIndex((l) => l.includes(tag))
      const gc = outLines[gl].indexOf(tag)
      const seg = [...lines[gl]].reverse().find((s) => s[0] <= gc)!
      expect([seg[2], seg[3] + (gc - seg[0])]).toEqual([origLine, origCol])
    }
    expect(r.map.sources).toEqual([F])
  })
})

describe('data-mv-loc: the plugin', () => {
  it('takes design/**/*.tsx|jsx only (real or linked root), never node_modules or the build', () => {
    const p = locPlugin('/repo')
    const t = (code: string, id: string) => (p.transform as any).call({}, code, id)
    expect(t('export default () => <div />', '/repo/design/scenes/a/b.tsx')?.code).toContain('design/scenes/a/b.tsx:1:22')
    expect(t('export default () => <div />', '/repo/design/scenes/a/b.jsx?v=3')?.code).toContain('design/scenes/a/b.jsx:1:22')
    expect(t('export default () => <div />', '/repo/src/app.tsx')).toBeNull()
    expect(t('export default () => <div />', '/repo/design/node_modules/x/y.tsx')).toBeNull()
    expect(t('export default () => <div />', '/repo/design/scenes/a/b.ts')).toBeNull()
    expect(p.apply).toBe('serve')
    expect(p.enforce).toBe('pre')
  })
})

describe('data-mv-loc: the dev server serves it, the published build never has it', () => {
  let root = ''
  let server: any = null
  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-loc-')))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host', type: 'module', devDependencies: {} }))
    mkdirSync(join(root, 'design', 'scenes', 'demo'), { recursive: true })
    writeFileSync(join(root, 'design', 'config.ts'), 'export default { jam: false }\n')
    writeFileSync(join(root, 'design', 'scenes', 'demo', 'hero.tsx'), 'export default function Hero() {\n  return <main><h1>Hello</h1></main>\n}\n')
    mkdirSync(join(root, 'design', 'boards'), { recursive: true })
    writeFileSync(join(root, 'design', 'boards', 'main.json'), JSON.stringify({ version: 1, name: 'main', auto: false, nodes: [{ frame: 'demo/hero' }] }))
  }, 60_000)
  afterAll(async () => {
    await server?.close().catch(() => {})
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('a design module from the dev server carries every host element\'s source', async () => {
    const { dev } = await import('../src/server/dev.ts')
    server = await dev(root)
    const addr = server.httpServer.address()
    const body = await fetch(`http://localhost:${addr.port}/design/scenes/demo/hero.tsx`).then((r) => r.text())
    expect(body).toContain('design/scenes/demo/hero.tsx:2:10')   // <main>
    expect(body).toContain('design/scenes/demo/hero.tsx:2:16')   // <h1>
    await server.close(); server = null
  }, 60_000)

  it('`marver build` output has none', async () => {
    // the published build, run the way a person runs it (the built CLI; react resolved from the host,
    // so the repo's node_modules are linked in as the browser suites link them)
    const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules')
    mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
    for (const e of readdirSync(repoNm)) if (e !== '.bin' && e !== '.vite' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e))
    symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
    execFileSync(process.execPath, [join(repoRoot, 'dist', 'cli.mjs'), 'build', '--all-boards', '--no-textures', '--root', root], { stdio: 'pipe', env: { ...process.env, CI: '1' } })
    const dist = join(root, 'design', '.dist')
    expect(existsSync(dist)).toBe(true)
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])
    const js = walk(dist).filter((f) => /\.(m?js|html)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(js).toContain('Hello')
    // the shell's own code names the attribute (it reads it); no frame carries a location value
    expect(js).not.toMatch(/design\/scenes\/demo\/hero\.tsx:\d+:\d+/)
  }, 120_000)
})
