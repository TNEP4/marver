import { afterEach, describe, expect, it } from 'vitest'
import { extractMeta } from '../src/server/manifest.ts'
import { marverIdHandler } from '../src/server/marver-id-gate.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Spec 31 H.1-H.2: a frame's `meta` reads escaped quotes in each quote style (`'Nic\'s board'` was dropped from the
 * manifest), unescaped; the Marver ID finish page wears the canvas's logo - its tab icon and its card's mark - and
 * Marver's own favicon only when the build found none.
 */

describe('extractMeta reads escaped quotes (H.1)', () => {
  it('each quote style, its own quote escaped, read unescaped', () => {
    expect(extractMeta(`export const meta = { title: 'Nic\\'s board', viewport: 'mobile' }`)).toEqual({ title: "Nic's board", viewport: 'mobile' })
    expect(extractMeta(`export const meta = { title: "A \\"quoted\\" word" }`)).toEqual({ title: 'A "quoted" word' })
    expect(extractMeta('export const meta = { title: `tick \\` tock` }')).toEqual({ title: 'tick ` tock' })
    expect(extractMeta(`export const meta = { title: 'C:\\\\path and a tab\\there' }`)).toEqual({ title: 'C:\\path and a tab\there' })
    expect(extractMeta(`export const meta = { title: 'caf\\u00e9 \\u{1F600} \\x41' }`)).toEqual({ title: 'café 😀 A' })
  })

  it('still literal only: a computed value is omitted, an apostrophe in double quotes is prose', () => {
    expect(extractMeta(`export const meta = { title: 'Nic\\'s ' + name }`)).toEqual({})
    expect(extractMeta(`export const meta = { title: "it's fine", viewport: 'laptop' }`)).toEqual({ title: "it's fine", viewport: 'laptop' })
  })

  it('the meta block ends at its own brace: past quotes in comments, multiline templates and their holes (round 1 P2)', () => {
    expect(extractMeta(`export const meta = { title: "Welcome", viewport: "tablet", slide: true /* author's note */ }`)).toEqual({ title: 'Welcome', viewport: 'tablet', slide: true })
    expect(extractMeta(`export const meta = {\n  // the owner's pick\n  title: 'Home',\n  viewport: 'mobile',\n}`)).toEqual({ title: 'Home', viewport: 'mobile' })
    expect(extractMeta('export const meta = {\n  description: `two\nlines {x}`,\n  title: "After",\n  viewport: "laptop" }')).toEqual({ title: 'After', viewport: 'laptop' })
    expect(extractMeta('export const meta = { note: `a ${ { b: 1 }.b } c`, title: "Held", theme: "dark" }')).toEqual({ title: 'Held', theme: 'dark' })
  })
})

describe('the Marver ID finish page wears the canvas\'s logo (H.2)', () => {
  const was = process.env.MARVER_PUBLIC_ORIGIN
  let dir = ''
  afterEach(() => {
    if (was === undefined) delete process.env.MARVER_PUBLIC_ORIGIN; else process.env.MARVER_PUBLIC_ORIGIN = was
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const finish = async (logo?: string): Promise<string> => {
    process.env.MARVER_PUBLIC_ORIGIN = 'http://localhost:5651'
    dir = mkdtempSync(join(tmpdir(), 'mv-r31-id-'))
    const handle = marverIdHandler(dir, 'https://id.example', 'Tidewell', true, {}, logo)
    let body = ''
    const res = { statusCode: 0, setHeader() {}, end(b?: string) { body = b ?? '' } }
    expect(await handle({ method: 'GET', headers: {} }, res, new URL('http://localhost:5651/__mv/id/finish'))).toBe(true)
    return body
  }

  it('with a logo: its tab icon and its mark, never Marver\'s favicon', async () => {
    const html = await finish('/__mv/logo.svg')
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/__mv/logo.svg" />')
    expect(html).toContain('<header><img src="/__mv/logo.svg" alt="" width="24" height="24" /><h1 id="t">Tidewell</h1></header>')
    expect(html).not.toContain('/__mv/favicon/favicon.ico')
  })

  it('without one, or with anything but the build\'s own path: Marver\'s', async () => {
    for (const logo of [undefined, '', 'https://evil.example/x.svg', '/__mv/logo.svg" onload="x']) {
      const html = await finish(logo)
      expect(html).toContain('<link rel="icon" href="/__mv/favicon/favicon.ico" sizes="48x48" />')
      expect(html).not.toContain('<img')
      expect(html).not.toContain('evil.example')
      rmSync(dir, { recursive: true, force: true }); dir = ''
    }
  })
})
