import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')

/**
 * The build-time source strip (01-sharing §6.2), proven against a REAL build.
 *
 * `reveal.source: false` is the published default, and it is tier-one hiding:
 * the repo's paths must not exist in the emitted bundle at all - not in the
 * inlined manifest, not in the registry keys, not in chunk filenames, not as
 * the address an HTML frame is served at. One fixture, one build, then greps.
 */

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

let root = ''
const SECRET_DIR = 'internal-codename'

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-strip-'))
  const scenes = join(root, 'design', 'scenes', SECRET_DIR)
  mkdirSync(scenes, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'strip-fixture', private: true, type: 'module' }))
  // react resolves through the repo's own store - the fixture has no install step
  symlinkSync(join(import.meta.dirname, '..', 'node_modules'), join(root, 'node_modules'))
  writeFileSync(join(scenes, 'hello.tsx'), `export default function Hello() { return <div>hello-frame</div> }\n`)
  writeFileSync(join(scenes, 'static.html'), `<!doctype html><html><head></head><body>html-frame</body></html>\n`)
  mkdirSync(join(root, 'design', 'boards'), { recursive: true })
  writeFileSync(join(root, 'design', 'boards', 'main.json'), JSON.stringify({
    version: 1, name: 'main',
    nodes: [
      { key: 'n1', frame: `${SECRET_DIR}/hello`, x: 0, y: 0, w: 400, h: 300 },
      { key: 'n2', frame: `${SECRET_DIR}/static`, x: 500, y: 0, w: 400, h: 300 },
    ],
  }))
  writeFileSync(join(root, 'design', 'publish.json'), JSON.stringify({ boards: { main: 'comment' } }))
  // the built CLI, not the source module: packageDir() resolves the client
  // sources relative to the built file, exactly as a real `marver build` does
  execFileSync(process.execPath, [CLI, 'build', '--root', root], { stdio: 'pipe' })
}, 180_000)

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('reveal.source off (the default) strips every repo path from the bundle', () => {
  // The frame ID (`<scene>/<name>`) is the product language - the switcher,
  // deep links and comments key on it, and `reveal.structure` governs it, not
  // `source`. What must vanish is the repo PATH: `design/scenes/...` strings
  // and source filenames with their extensions.
  it('no emitted file contains a repo source path or source filename', () => {
    const dist = join(root, 'design', '.dist')
    for (const f of walk(dist)) {
      if (!/\.(js|html|json|css)$/.test(f)) continue
      const text = readFileSync(f, 'utf8')
      expect(text, `${f} leaks a scenes path`).not.toContain(`design/scenes/${SECRET_DIR}`)
      expect(text, `${f} leaks a frame filename`).not.toContain('hello.tsx')
      expect(text, `${f} leaks the html frame filename`).not.toContain('static.html')
    }
  })

  it('no emitted filename carries a frame basename; the html frame lives at an opaque path', () => {
    const dist = join(root, 'design', '.dist')
    const files = walk(dist).map((f) => f.slice(dist.length))
    expect(files.some((f) => f.includes(SECRET_DIR))).toBe(false)
    expect(files.some((f) => /hello/.test(f))).toBe(false)
    // the html frame is still served - at its opaque address
    expect(files.some((f) => /^\/__mv\/f\/mv[0-9a-f]{12}\.html$/.test(f))).toBe(true)
  })

  it('the inlined manifest keeps ids but its file fields are opaque', () => {
    const dist = join(root, 'design', '.dist')
    const shell = walk(dist).filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('')
    expect(shell).toContain(`${SECRET_DIR}/hello`)              // the id survives
    expect(shell).toMatch(/__mv\/f\/mv[0-9a-f]{12}/)            // opaque file fields
  })
})
