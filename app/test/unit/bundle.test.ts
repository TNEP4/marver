/**
 * The bundles (spec 28 A2.14 #27, #29): main one CJS file that takes from outside only electron and Node's
 * built-ins (no vite: A2.14 #12); each preload on its own, requiring electron alone (a sandboxed preload can
 * require nothing else) with no chunk beside it; every page built and listed; and the release flavour free of
 * every test hook.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TEST_SENTINELS } from '../../scripts/build.mjs'

const APP = resolve(import.meta.dirname, '..', '..')
const DIST = join(APP, 'dist')
const read = (f: string, dir = DIST) => readFileSync(join(dir, f), 'utf8')
const requires = (code: string) => [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
const isBuiltin = (m: string) => m.startsWith('node:') || builtinModules.includes(m)

describe('the dev build (dist/)', () => {
  it('main is one CJS bundle taking only electron and Node built-ins, and no vite', () => {
    const main = read('main.cjs')
    const outside = requires(main).filter((m) => m !== 'electron' && !isBuiltin(m))
    expect(outside).toEqual([])
    expect(main).toContain('require("electron")')
    expect(main).not.toMatch(/\bvite\b/)
  })

  it('each preload stands alone: no chunk beside it, and electron the only require', () => {
    const top = readdirSync(DIST).filter((f) => f !== 'pages' && !f.endsWith('.map')).sort()
    expect(top).toEqual(['main.cjs', 'preload-app.cjs', 'preload-canvas.cjs'])
    for (const f of ['preload-canvas.cjs', 'preload-app.cjs']) {
      const code = read(f)
      expect(requires(code).filter((m) => m !== 'electron'), f).toEqual([])
      expect(code, f).not.toMatch(/\bimport\(/)
    }
  })

  it('every page is built and its manifest lists only files that exist', () => {
    const manifest = JSON.parse(read('pages/manifest.json')) as Record<string, Record<string, string>>
    const pages = readdirSync(join(APP, 'pages'), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'shared').map((d) => d.name).sort()
    expect(Object.keys(manifest).sort()).toEqual(pages)
    for (const [page, files] of Object.entries(manifest)) {
      for (const k of ['/', '/index.html', '/main.js', '/tokens.css']) expect(files[k], `${page} ${k}`).toBeTruthy()
      for (const [url, file] of Object.entries(files)) {
        expect(url.startsWith('/') && !url.includes('..'), url).toBe(true)
        expect(existsSync(join(DIST, 'pages', file)), `${page}: ${file}`).toBe(true)
        expect(file.endsWith('.map'), file).toBe(false)
      }
    }
  })

  it('carries the test hooks (switched on only by MARVER_APP_TEST=1)', () => {
    expect(read('main.cjs')).toContain('mv-test-hook')
  })
})

describe('the release flavour', () => {
  const out = mkdtempSync(join(tmpdir(), 'mv-release-'))
  afterAll(() => rmSync(out, { recursive: true, force: true }))

  it('holds no test hook, keeps the guard, and drops Marver Dev', () => {
    const tsdown = join(resolve(createRequire(join(APP, 'package.json')).resolve('tsdown/package.json'), '..'), 'dist', 'run.mjs')
    const r = spawnSync(process.execPath, [tsdown, '--config', 'tsdown.config.ts'], {
      cwd: APP, encoding: 'utf8', env: { ...process.env, MV_FLAVOUR: 'release', MV_OUT: out },
    })
    expect(r.status, r.stderr).toBe(0)
    for (const f of ['main.cjs', 'preload-canvas.cjs', 'preload-app.cjs']) {
      const code = read(f, out)
      for (const s of TEST_SENTINELS) expect(code.includes(s), `${f} holds ${s}`).toBe(false)
    }
    const main = read('main.cjs', out)
    expect(main).toContain('remote-debugging-port')
    expect(main).toContain('remote-debugging-pipe')
    expect(main).not.toContain('Marver Dev')
    expect(readdirSync(out).some((f) => f.endsWith('.map'))).toBe(false)
  })
})
