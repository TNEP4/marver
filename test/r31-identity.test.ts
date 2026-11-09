import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { canvasIdentity, identityNudge } from '../src/server/identity.ts'
import { loadConfig } from '../src/server/config.ts'
import { findLogo, publishLogo } from '../src/server/logo.ts'
import { init, initialName } from '../src/cli/init.ts'
import { png } from './png-fixture.ts'

/**
 * A canvas that looks right in the app (spec 31 Part G): one identity resolver with the spec's precedence - local
 * name config `name` > `share.name` > folder; published name `name` > `share.name` > package.json > folder; logo
 * config `logo` > `share.logo` > the ladder - that changes nothing for a canvas setting neither; `marver dev`'s
 * boot-line note for a canvas still on its folder's name or the Marver mark; `init` writes a human `name`.
 */

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n'
const PNG = png(2, 2, () => [0, 136, 255, 255])
const dirs: string[] = []
const repo = (files: Record<string, string | Buffer> = {}, name = 'mv-r31-id-'): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), name)))
  dirs.push(root)
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const cfg = (o: { name?: string; logo?: string; share?: { name?: string; logo?: string } } = {}) => ({ name: o.name, logo: o.logo, share: { name: o.share?.name, logo: o.share?.logo } })

describe('canvasIdentity: one resolver (G.1)', () => {
  const pkg = JSON.stringify({ name: '@acme/tms-broker' })

  it('the precedence, local and published', () => {
    const root = repo({ 'package.json': pkg })
    const folder = basename(root)
    const at = (o: Parameters<typeof cfg>[0]) => { const i = canvasIdentity(root, cfg(o)); return [i.local, i.published, i.nameFrom] }
    expect(at({})).toEqual([folder, '@acme/tms-broker', 'folder'])
    expect(at({ share: { name: 'TMS (share)' } })).toEqual(['TMS (share)', 'TMS (share)', 'share.name'])
    expect(at({ name: 'TMS Broker', share: { name: 'TMS (share)' } })).toEqual(['TMS Broker', 'TMS Broker', 'name'])
    expect(at({ name: 'TMS Broker' })).toEqual(['TMS Broker', 'TMS Broker', 'name'])
    const bare = repo()
    expect(canvasIdentity(bare, cfg()).published).toBe(basename(bare))
  })

  it('a canvas setting neither: today\'s rules exactly - runtime share.name || folder, build share.name || package.json || folder', () => {
    for (const files of [{}, { 'package.json': pkg }, { 'package.json': JSON.stringify({ private: true }) }] as Record<string, string>[]) {
      for (const share of [undefined, 'Shared Name']) {
        const root = repo(files)
        const i = canvasIdentity(root, cfg({ share: { name: share } }))
        // the rules as 0.30 wrote them (plugin.ts/dev.ts; build.ts)
        let built = basename(root)
        try { built = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name ?? built } catch { /* basename */ }
        if (share) built = share
        expect([i.local, i.published]).toEqual([share || basename(root), built])
      }
    }
  })

  it('the logo: config logo > share.logo > the ladder; a bad one said once under its own key', () => {
    const root = repo({ 'brand/mark.svg': SVG, 'brand/old.png': PNG, 'design/logo.svg': SVG, 'brand/not.svg': 'hello' })
    const warn = vi.fn()
    const pick = (o: Parameters<typeof cfg>[0]) => findLogo(root, canvasIdentity(root, cfg(o)).logos, warn)?.from
    expect(pick({ logo: 'brand/mark.svg', share: { logo: 'brand/old.png' } })).toBe('brand/mark.svg')
    expect(pick({ share: { logo: 'brand/old.png' } })).toBe('brand/old.png')
    expect(pick({})).toBe('design/logo.svg')
    expect(warn).not.toHaveBeenCalled()
    expect(pick({ logo: 'brand/not.svg', share: { logo: 'brand/old.png' } })).toBe('brand/old.png')
    expect(warn).toHaveBeenCalledWith('logo brand/not.svg is ignored: not an image (PNG, ICO or SVG)')
    // and a build publishes the one picked
    const out = repo()
    expect(publishLogo(root, canvasIdentity(root, cfg({ logo: 'brand/old.png' })).logos, out)).toBe('/__mv/logo.png')
    // a share.logo alone, as a string, is warned about as before
    const w2 = vi.fn()
    findLogo(root, 'brand/not.svg', w2)
    expect(w2).toHaveBeenCalledWith('share.logo brand/not.svg is ignored: not an image (PNG, ICO or SVG)')
  })

  it('loadConfig reads name and logo: trimmed, a bad one ignored with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const a = await loadConfig(repo({ 'design/config.ts': `export default { name: '  TMS Broker ', logo: 'brand/mark.svg', share: { name: 'old' } }\n` }))
      expect([a.name, a.logo, a.share.name]).toEqual(['TMS Broker', 'brand/mark.svg', 'old'])
      const b = await loadConfig(repo({ 'design/config.ts': `export default { name: 42, logo: '   ' }\n` }))
      expect([b.name, b.logo]).toEqual([undefined, undefined])
      expect(warn.mock.calls.some((c) => String(c[0]).includes('design/config.ts: name must be text'))).toBe(true)
      const c = await loadConfig(repo({ 'design/config.ts': `export default { name: '${'x'.repeat(81)}' }\n` }))
      expect(c.name).toBeUndefined()
    } finally { warn.mockRestore() }
  })
})

describe('marver dev\'s boot-line note (G.2)', () => {
  it('a canvas on its folder\'s name and the Marver mark hears both; one with a name and a logo hears nothing', () => {
    const bare = repo()
    expect(identityNudge(bare, cfg())).toBe(`this canvas still shows its folder's name ("${basename(bare)}") and the Marver mark - give it name: "Your Product" in design/config.ts and your product's logo at design/logo.svg`)
    expect(identityNudge(bare, cfg({ name: 'Tidewell' }))).toBe('this canvas still shows the Marver mark - give it your product\'s logo at design/logo.svg')
    const logo = repo({ 'design/logo.svg': SVG })
    expect(identityNudge(logo, cfg())).toBe(`this canvas still shows its folder's name ("${basename(logo)}") - give it name: "Your Product" in design/config.ts`)
    expect(identityNudge(logo, cfg({ share: { name: 'Tidewell' } }))).toBeNull()
    expect(identityNudge(repo({ 'brand/m.png': PNG }), cfg({ name: 'Tidewell', logo: 'brand/m.png' }))).toBeNull()
  })
})

describe('init writes a name (G.2)', () => {
  let root = ''
  beforeEach(() => {
    root = repo({ 'package.json': JSON.stringify({ name: '@acme/tms-broker', devDependencies: {} }) })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('the package\'s name, its scope dropped, written for people - and the config loads with it', async () => {
    expect(initialName(root)).toBe('Tms broker')
    init(root, { mode: 'studio', demo: false })
    const text = readFileSync(join(root, 'design', 'config.ts'), 'utf8')
    expect(text).toContain('  name: "Tms broker",\n')
    expect((await loadConfig(root)).name).toBe('Tms broker')
    expect(canvasIdentity(root, await loadConfig(root)).nameFrom).toBe('name')
  })

  it('no package name: the folder\'s, with brand casing', () => {
    const r = repo({}, 'ipad-')
    expect(initialName(r)).toMatch(/^iPad /)
  })
})
