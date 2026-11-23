import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptable, BAKE_SCHEMA, bootFiles, digestOf, drifted, extraKey, ignoredByWatch, readRecord, removeRecord, sigOf, unwatchedAtStart, WATCH_IGNORED, writeRecord, type DigestInputs } from '../src/server/bake-reuse.ts'
import { pruneBakes } from '../src/server/bake.ts'

/**
 * Bakes that survive a restart (bake-reuse.ts): the digest a start compares with the reuse record, the record, and
 * the drift that stops a session from writing one. Every case is a change a bake depends on - each must move the
 * digest - or one it does not - which must not.
 */

let base = '', root = '', pkg = '', ws = ''
const watchedOf = (files: string[]) => {
  const out: Record<string, string[]> = {}
  for (const f of files) { const d = join(f, '..'); (out[d] ??= []).push(f.slice(d.length + 1)) }
  return out
}
let files: string[] = []
const inputs = (over: Partial<DigestInputs> = {}): DigestInputs => ({ root, pkgDir: pkg, version: '9.9.9', chrome: null, watched: watchedOf(files), extra: [], env: {}, ...over })
const digest = (over: Partial<DigestInputs> = {}) => digestOf(inputs(over))!.digest
const write = (p: string, s: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s) }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mv-bake-reuse-'))
  ws = join(base, 'ws')
  root = join(ws, 'canvas')
  pkg = join(base, 'pkg')
  write(join(pkg, 'dist', 'cli.mjs'), 'cli')
  write(join(pkg, 'src', 'client', 'frame-host', 'main.tsx'), 'host')
  write(join(root, 'design', 'scenes', 'app', 'a.tsx'), 'export default () => null')
  write(join(root, 'design', 'components', 'Card.tsx'), 'export const Card = 1')
  write(join(root, 'design', 'boards', 'main.json'), '{}')
  files = [join(root, 'design', 'scenes', 'app', 'a.tsx'), join(root, 'design', 'components', 'Card.tsx'), join(root, 'design', 'boards', 'main.json')]
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('the digest (bake-reuse.ts)', () => {
  it('the same inputs give the same digest', () => {
    expect(digest()).toBe(digest())
  })

  it('a watched file edited - even with its length and mtime put back - moves it', () => {
    const d0 = digest()
    const f = files[1]
    const st = statSync(f)
    writeFileSync(f, 'export const Card = 2')   // same length
    utimesSync(f, st.atime, st.mtime)          // mtime restored: ctime moved
    expect(digest()).not.toBe(d0)
  })

  it('a watched file added or removed moves it; a board file never does', () => {
    const d0 = digest()
    write(join(root, 'design', 'boards', 'main.json'), '{"x":1}')
    expect(digest()).toBe(d0)
    const extra = join(root, 'design', 'scenes', 'app', 'b.tsx')
    write(extra, 'b'); files.push(extra)
    const d1 = digest()
    expect(d1).not.toBe(d0)
    unlinkSync(extra)
    expect(digest()).not.toBe(d1)
  })

  it('a compiled file the watcher does not watch (dist/, outside the root) is in it, by path', () => {
    const lib = join(root, 'dist', 'lib.js'), sib = join(ws, 'packages', 'ui', 'Button.tsx')
    write(lib, 'a'); write(sib, 'b')
    const d0 = digest({ extra: [lib, sib] })
    expect(digest({ extra: [lib, sib] })).toBe(d0)
    expect(digest({ extra: [] })).not.toBe(d0)
    writeFileSync(lib, 'aa')
    const d1 = digest({ extra: [lib, sib] })
    expect(d1).not.toBe(d0)
    writeFileSync(sib, 'bb')
    expect(digest({ extra: [lib, sib] })).not.toBe(d1)
  })

  it("Marver's own package - its served src/client as well as dist/ - and its version move it", () => {
    const d0 = digest()
    write(join(pkg, 'src', 'client', 'frame-host', 'main.tsx'), 'host2')
    const d1 = digest()
    expect(d1).not.toBe(d0)
    write(join(pkg, 'dist', 'cli.mjs'), 'cli2')
    const d2 = digest()
    expect(d2).not.toBe(d1)
    expect(digest({ version: '9.9.10' })).not.toBe(d2)
  })

  it('an install (a stamp at the root or the workspace root), a lockfile of the workspace root move it', () => {
    const d0 = digest({ workspaceRoot: ws })
    write(join(root, 'node_modules', '.package-lock.json'), '{}')
    const d1 = digest({ workspaceRoot: ws })
    expect(d1).not.toBe(d0)
    write(join(ws, 'node_modules', '.modules.yaml'), 'a')
    const d2 = digest({ workspaceRoot: ws })
    expect(d2).not.toBe(d1)
    write(join(ws, 'pnpm-lock.yaml'), 'a')
    expect(digest({ workspaceRoot: ws })).not.toBe(d2)
  })

  it('a compiler config above the root, a config read at boot, .env move it', () => {
    const d0 = digest()
    write(join(ws, 'postcss.config.js'), 'module.exports = {}')
    const d1 = digest()
    expect(d1).not.toBe(d0)
    write(join(root, 'design', 'config.ts'), 'export default {}')
    const d2 = digest()
    expect(d2).not.toBe(d1)
    write(join(root, '.env'), 'VITE_A=1')
    expect(digest()).not.toBe(d2)
  })

  it('the bake browser and the env Vite exposes move it; any other env does not', () => {
    const d0 = digest()
    expect(digest({ env: { MARVER_HOME: '/x', PATH: '/y' } })).toBe(d0)
    expect(digest({ env: { VITE_API: 'a' } })).not.toBe(d0)
    expect(digest({ env: { MV_CHROME_FLAGS: '--x' } })).not.toBe(d0)
    const chrome = join(base, 'chrome'); write(chrome, 'bin')
    expect(digest({ chrome })).not.toBe(d0)
  })

  it('a symlink retargeted moves it', () => {
    const a = join(base, 'ta.tsx'), b = join(base, 'tb.tsx'), l = join(root, 'design', 'components', 'L.tsx')
    write(a, 'same'); write(b, 'same')
    symlinkSync(a, l); files.push(l)
    const d0 = digest()
    unlinkSync(l); symlinkSync(b, l)
    expect(digest()).not.toBe(d0)
  })

  it('a missing file signs as missing; one that cannot be read gives no digest at all', () => {
    expect(sigOf(join(base, 'nope'))).toBe('-')
    expect(sigOf(join(root, 'design', 'components', 'Card.tsx'))).toMatch(/^\d+:\d+:\d+:\d+$/)
    const locked = join(root, 'design', 'locked'), f = join(locked, 'x.tsx')
    write(f, 'x'); files.push(f)
    chmodSync(locked, 0o000)
    try { expect(digestOf(inputs())).toBeNull() } finally { chmodSync(locked, 0o755) }
    expect(digestOf(inputs())).not.toBeNull()
  })

  it('every file of public/ is in it, watched or not', () => {
    const d0 = digest()
    write(join(root, 'public', 'dist', 'bg.png'), 'png')
    const d1 = digest()
    expect(d1).not.toBe(d0)
    write(join(root, 'public', 'dist', 'bg.png'), 'png2')
    expect(digest()).not.toBe(d1)
  })

  it("the env Vite resolved (a .env value expanded from the shell) moves it", () => {
    const d0 = digest({ viteEnv: { VITE_COLOR: 'red', MODE: 'development' } })
    expect(digest({ viteEnv: { VITE_COLOR: 'red', MODE: 'development' } })).toBe(d0)
    expect(digest({ viteEnv: { VITE_COLOR: 'blue', MODE: 'development' } })).not.toBe(d0)
  })

  it('past the budget, no digest (the extras count too)', () => {
    const many = Array.from({ length: 200_001 }, (_, i) => join(root, 'dist', `f${i}.js`))
    expect(digestOf(inputs({ extra: many }))).toBeNull()
  })
})

describe('what the watcher cannot see', () => {
  it('a symlinked folder in the tree or in public/ gives no digest (its files are not followed)', () => {
    write(join(base, 'shared', 'bg.svg'), '<svg/>')
    symlinkSync(join(base, 'shared'), join(root, 'design', 'linked'))
    expect(digestOf(inputs())).toBeNull()
    unlinkSync(join(root, 'design', 'linked'))
    mkdirSync(join(root, 'public'), { recursive: true })
    symlinkSync(join(base, 'shared'), join(root, 'public', 'assets'))
    expect(digestOf(inputs())).toBeNull()
  })

  it('a canvas under a folder the watcher ignores (build/) gives no digest: no edit there is ever heard', () => {
    const deep = join(base, 'build', 'canvas')
    write(join(deep, 'design', 'scenes', 'app', 'a.tsx'), 'a')
    expect(digestOf(inputs({ root: deep }))).toBeNull()
  })

  it("Vite's ignores and chokidar's atomic-save names count as unwatched", () => {
    expect(unwatchedAtStart(root, join(root, 'test-results', 'x.js'))).toBe(true)
    expect(unwatchedAtStart(root, join(root, 'design', 'a.tsx~'))).toBe(true)
    expect(unwatchedAtStart(root, join(root, 'design', '.a.tsx.swp'))).toBe(true)
    expect(unwatchedAtStart(root, join(root, 'design', 'a.tsx'))).toBe(false)
  })

  it("one ignore list: the watcher's globs, read as paths", () => {
    expect(WATCH_IGNORED).toContain('**/dist/**')
    expect(ignoredByWatch('dist/lib.js')).toBe(true)
    expect(ignoredByWatch('packages/ui/dist/lib.js')).toBe(true)
    expect(ignoredByWatch('design/manifest.json')).toBe(true)
    expect(ignoredByWatch('context/map.json')).toBe(true)
    expect(ignoredByWatch('design/scenes/app/a.tsx')).toBe(false)
    expect(ignoredByWatch('distant/a.tsx')).toBe(false)
  })

  it('a compiled file outside the root or under an ignored folder is listed by path; a watched one, a package, never', () => {
    expect(unwatchedAtStart(root, join(root, 'dist', 'lib.js'))).toBe(true)
    expect(unwatchedAtStart(root, join(ws, 'packages', 'ui', 'B.tsx'))).toBe(true)
    expect(unwatchedAtStart(root, join(root, 'design', 'scenes', 'app', 'a.tsx'))).toBe(false)
    expect(unwatchedAtStart(root, join(ws, 'node_modules', 'react', 'index.js'))).toBe(false)
  })

  it('a config whose imports cannot be followed gives no digest (outside the root, resolving nowhere, .mts)', () => {
    write(join(root, 'design', 'config.ts'), "import x from '../../shared/theme'\nexport default x")
    expect(digestOf(inputs())).toBeNull()
    write(join(root, 'design', 'config.ts'), "import x from './missing'\nexport default x")
    expect(digestOf(inputs())).toBeNull()
    write(join(root, 'design', 'config.ts'), "import x from './t.mts'\nexport default x")
    write(join(root, 'design', 't.mts'), 'export default 1')
    expect(digestOf(inputs())).toBeNull()
    write(join(root, 'design', 'config.ts'), "import { defineConfig } from 'marver'\nexport default defineConfig({})")
    expect(digestOf(inputs())).not.toBeNull()   // a package import is the install stamps' to cover
  })

  it('the files read at boot: the configs and what they import', () => {
    write(join(root, 'design', 'config.ts'), "import { themes } from './themes'\nexport default { themes }")
    write(join(root, 'design', 'themes.ts'), 'export const themes = []')
    write(join(root, 'tailwind.config.js'), 'module.exports = {}')
    write(join(root, '.env.local'), 'VITE_A=1')
    expect(bootFiles(root)).toEqual(['.env.local', 'design/config.ts', 'design/themes.ts', 'tailwind.config.js'])
  })
})

describe('the drift (a session that may not write a record)', () => {
  it('a config read at boot edited in the session drifts; one created drifts', () => {
    write(join(root, 'tailwind.config.js'), 'a')
    const boot = digestOf(inputs())!.u
    expect(drifted(boot, digestOf(inputs())!.u, () => undefined)).toBeNull()
    write(join(root, 'tailwind.config.js'), 'ab')
    expect(drifted(boot, digestOf(inputs())!.u, () => undefined)).toBe('boot tailwind.config.js')
    write(join(root, 'tailwind.config.js'), 'a')
    const boot2 = digestOf(inputs())!.u
    write(join(root, 'design', 'config.ts'), 'x')
    expect(drifted(boot2, digestOf(inputs())!.u, () => undefined)).toBe('boot design/config.ts')
  })

  it('an unwatched compiled file: from its sig when first compiled', () => {
    const lib = join(root, 'dist', 'lib.js'); write(lib, 'a')
    const boot = digestOf(inputs())!.u
    const atCompile = sigOf(lib)
    expect(drifted(boot, digestOf(inputs({ extra: [lib] }))!.u, (k) => (k === extraKey(root, lib) ? atCompile : undefined))).toBeNull()
    writeFileSync(lib, 'changed')
    expect(drifted(boot, digestOf(inputs({ extra: [lib] }))!.u, (k) => (k === extraKey(root, lib) ? atCompile : undefined))).toBe(extraKey(root, lib))
  })

  it("a file the config imports edited in the session drifts", () => {
    write(join(root, 'design', 'config.ts'), "import { themes } from './themes'\nexport default { themes }")
    write(join(root, 'design', 'themes.ts'), 'export const themes = []')
    const boot = digestOf(inputs())!.u
    write(join(root, 'design', 'themes.ts'), 'export const themes = ["dark"]')
    expect(drifted(boot, digestOf(inputs())!.u, () => undefined)).toBe('boot design/themes.ts')
  })

  it('an unwatched public/ file edited or removed in the session drifts', () => {
    write(join(root, 'public', 'dist', 'bg.png'), 'a')
    const boot = digestOf(inputs())!.u
    write(join(root, 'public', 'dist', 'bg.png'), 'ab')
    expect(drifted(boot, digestOf(inputs())!.u, () => undefined)).toBe('pub public/dist/bg.png')
    unlinkSync(join(root, 'public', 'dist', 'bg.png'))
    expect(drifted(boot, digestOf(inputs())!.u, () => undefined)).toBe('pub public/dist/bg.png')
  })

  it('a watched file edited is no drift - it moves the generation instead', () => {
    const boot = digestOf(inputs())!.u
    writeFileSync(files[0], 'edited')
    expect(drifted(boot, digestOf(inputs())!.u, () => undefined)).toBeNull()
  })
})

describe('the record and a start', () => {
  const bakes = () => join(root, 'design', '.local', 'bakes')

  it('adopted only on the exact digest, with its folder there', () => {
    mkdirSync(join(bakes(), '123'), { recursive: true })
    const d = digestOf(inputs())!
    writeRecord(root, { digest: d.digest, gen: 123, extra: [] })
    const rec = readRecord(root)
    expect(rec).toMatchObject({ schema: BAKE_SCHEMA, gen: 123, digest: d.digest })
    expect(adoptable(root, rec, d)).toBe(123)
    writeFileSync(files[0], 'edited while stopped')
    expect(adoptable(root, rec, digestOf(inputs())!)).toBeNull()
    expect(adoptable(root, { ...rec!, gen: 456 }, d)).toBeNull()   // its folder is gone
    expect(adoptable(root, null, d)).toBeNull()
  })

  it('a record of another schema, or a torn one, is no record', () => {
    mkdirSync(bakes(), { recursive: true })
    writeFileSync(join(bakes(), 'reuse.json'), JSON.stringify({ schema: BAKE_SCHEMA + 1, digest: 'x', gen: 1, extra: [], at: '' }))
    expect(readRecord(root)).toBeNull()
    writeFileSync(join(bakes(), 'reuse.json'), '{"schema":1,"dig')
    expect(readRecord(root)).toBeNull()
    removeRecord(root)
    expect(readRecord(root)).toBeNull()
  })

  it('no record is written before anything was baked', () => {
    writeRecord(root, { digest: 'x', gen: 1, extra: [] })
    expect(readRecord(root)).toBeNull()
  })

  it('the prune keeps the adopted generation and the record, and drops the rest', () => {
    for (const g of ['1795428254506', '777']) mkdirSync(join(bakes(), g, 'k'), { recursive: true })
    writeRecord(root, { digest: 'x', gen: 777, extra: [] })
    pruneBakes(root, 777)
    expect(statSync(join(bakes(), '777')).isDirectory()).toBe(true)
    expect(() => statSync(join(bakes(), '1795428254506'))).toThrow()
    expect(readRecord(root)?.gen).toBe(777)
  })
})
