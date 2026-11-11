/**
 * Spec 32's shared pieces without Electron (G4): E5's dates, E3's icon paths, E2's row rules, and the files every
 * page now serves (E2's menu.css, E6's mark). The DOM behaviour is test/pw/shared-pieces.test.ts's.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// dom.ts reads the colour scheme at load: a page's module, here in node
vi.hoisted(() => { (globalThis as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
import { ago, agoDate, ICON_NAMES } from '../../src/pages/dom.ts'
import { normalRows, type MenuRow } from '../../src/pages/menu.ts'

const APP = resolve(import.meta.dirname, '..', '..')
const at = (y: number, m: number, d: number) => new Date(y, m, d, 12).getTime()

describe('"Ran Oct 27" (E5)', () => {
  const now = at(2026, 10, 20)

  it('past 13 days: day and month inside the current year, with the year otherwise (en-US)', () => {
    expect(ago(at(2026, 9, 27), now, 'en-US')).toBe('Oct 27')
    expect(ago(at(2025, 9, 27), now, 'en-US')).toBe('Oct 27, 2025')
    // the words before it are unchanged
    expect(ago(now - 3 * 86_400_000, now, 'en-US')).toBe('3 days ago')
    expect(ago(now - 13 * 86_400_000, now, 'en-US')).toBe('13 days ago')
  })

  it('the year by its parts, in en-US, ar-EG and ja: none for this year\'s date, one for last year\'s', () => {
    for (const locale of ['en-US', 'ar-EG', 'ja']) {
      const parts = (t: number) => new Intl.DateTimeFormat(locale, agoDate(t, now)).formatToParts(t).map((p) => p.type)
      expect(parts(at(2026, 9, 27)), locale).not.toContain('year')
      expect(parts(at(2025, 9, 27)), locale).toContain('year')
      // and ago() writes exactly those options
      for (const t of [at(2026, 9, 27), at(2025, 9, 27)]) expect(ago(t, now, locale), locale).toBe(new Date(t).toLocaleDateString(locale, agoDate(t, now)))
    }
  })
})

describe('the icons (E3)', () => {
  it('every name draws a Phosphor path in the 256 box, and the path sources match the shell\'s icons', () => {
    const dom = readFileSync(join(APP, 'src', 'pages', 'dom.ts'), 'utf8')
    const shell = readFileSync(join(APP, '..', 'src', 'client', 'shell', 'icons.tsx'), 'utf8')
    const pathOf = (name: string) => new RegExp(`(?:'${name}'|\\b${name}): '([^']+)'`).exec(dom)?.[1]
    for (const n of ICON_NAMES) expect(pathOf(n), n).toMatch(/^M[\d.,\s\-A-Za-z]+$/)
    // the ones the spec takes from the shell's icons.tsx, path for path
    for (const [n, comp] of [['folder-open', 'FolderOpenIcon'], ['check-square-offset', 'CheckSquareOffsetIcon'], ['arrow-clockwise', 'ReloadIcon'], ['arrow-right', 'ArrowRightIcon'], ['arrow-up', 'ArrowUpIcon'], ['signpost', 'SignpostIcon'], ['grid', 'GridIcon']]) {
      const src = new RegExp(`export const ${comp} = icon\\(<path d="([^"]+)"`).exec(shell)?.[1]
      expect(pathOf(n), n).toBe(src)
    }
  })
})

describe('the menu\'s rows (E2, B9)', () => {
  const item = (id: string): MenuRow => ({ kind: 'item', id, label: id, enabled: true })
  const sep: MenuRow = { kind: 'sep' }
  it('drops a separator that leads, trails or doubles, and a trailing header', () => {
    const kinds = (rows: MenuRow[]) => normalRows(rows).map((r) => (r.kind === 'item' ? r.id : r.kind))
    expect(kinds([sep, item('a'), sep, sep, item('b'), sep])).toEqual(['a', 'sep', 'b'])
    expect(kinds([sep, sep])).toEqual([])
    expect(kinds([item('a'), sep, { kind: 'header', label: 'View' }, item('b'), { kind: 'header', label: 'Last' }])).toEqual(['a', 'sep', 'header', 'b'])
  })
})

describe('the files every page serves (E2, E6)', () => {
  it('menu.css and the app mark are in pages/shared, so every page lists them; strip and Home link menu.css before their own style', () => {
    const manifest = JSON.parse(readFileSync(join(APP, 'dist', 'pages', 'manifest.json'), 'utf8')) as Record<string, Record<string, string>>
    for (const page of ['strip', 'home', 'settings', 'tabpage']) {
      expect(manifest[page]['/menu.css'], page).toBe('shared/menu.css')
      expect(manifest[page]['/app-mark.png'], page).toBe('shared/app-mark.png')
    }
    // spec 33 A1: Home and Settings share Home's glass (glass.css) before the menu
    for (const [page, want] of [['strip', ['tokens.css', 'base.css', 'menu.css', 'style.css']], ['home', ['tokens.css', 'base.css', 'glass.css', 'menu.css', 'style.css']], ['settings', ['tokens.css', 'base.css', 'glass.css', 'menu.css', 'style.css']]] as const) {
      const html = readFileSync(join(APP, 'pages', page, 'index.html'), 'utf8')
      const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1])
      expect(links, page).toEqual(want)
    }
    // a 256 x 256 PNG (its IHDR)
    const png = readFileSync(join(APP, 'pages', 'shared', 'app-mark.png'))
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([256, 256])
  })

  it('menu.css names no page token: only its own interface and the shell\'s', () => {
    const css = readFileSync(join(APP, 'pages', 'shared', 'menu.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const vars = [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))]
    expect(vars.filter((v) => !v.startsWith('--mv-menu-') && !['--solid', '--node-brd'].includes(v))).toEqual([])
    expect(css).not.toMatch(/--(ts|hm)-/)
  })
})
