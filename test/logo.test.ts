import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LOGO_MAX, sniffLogo } from '../src/shared/logo-sniff.ts'
import { findLogo, LOGO_LADDER, logoRoute, logoTag, publishLogo } from '../src/server/logo.ts'
import { portInUse } from '../src/server/exclusive.ts'
import { png } from './png-fixture.ts'

/**
 * The canvas's logo (spec 28 A2.4, A2.9, A2.14 #24): one sniff for both sides, by the bytes; the ladder and every
 * check `findLogo` runs (a regular file inside the repo, never a symlink, at most 256 KB, an image by its bytes); the
 * dev route the Mac app fetches, with its ETag and its proof on a 200 and a 304; what `marver build` publishes; and a
 * gated `marver serve` showing a `.ico` logo before sign-in.
 */

const PNG = png(2, 2, () => [0, 136, 255, 255])
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), randomBytes(32)])
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n'
const enc = (s: string) => Buffer.from(s, 'utf8')

const dirs: string[] = []
const repo = (files: Record<string, string | Buffer> = {}): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-logo-')))
  dirs.push(root)
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('sniffLogo - by the bytes, never the name', () => {
  it('a PNG by its signature, an ICO by its header', () => {
    expect(sniffLogo(PNG)).toBe('png')
    expect(sniffLogo(ICO)).toBe('ico')
    expect(sniffLogo(PNG.subarray(0, 7))).toBeNull()
    expect(sniffLogo(Buffer.from([0, 0, 2, 0]))).toBeNull()   // a cursor file, not an icon
  })

  it('an SVG: UTF-8 text whose root element is <svg, after a BOM, an XML declaration, comments and a DOCTYPE without a subset', () => {
    for (const s of [
      SVG,
      '﻿' + SVG,
      `  \n\t${SVG}`,
      `<?xml version="1.0" encoding="UTF-8"?>\n${SVG}`,
      `<?xml version="1.0"?><!-- Generator: Adobe Illustrator 27 --><!-- two --> ${SVG}`,
      `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${SVG}`,
      `<!-- Created with Inkscape (http://www.inkscape.org/) -->\n<!DOCTYPE svg PUBLIC "a>b" 'c'>${SVG}`,
      '<svg>x</svg>', '<svg/>',
    ]) expect(sniffLogo(enc(s)), s).toBe('svg')
  })

  it('refuses everything else: an internal subset, another root, html, a processing instruction, two doctypes, not UTF-8', () => {
    for (const s of [
      `<!DOCTYPE svg [ <!ENTITY x "y"> ]>${SVG}`,              // an internal subset: entities live there
      `<!DOCTYPE svg PUBLIC "x" "y" [<!ENTITY a "b">]>${SVG}`,
      `<!DOCTYPE html><html><body>${SVG}</body></html>`,
      '<html><svg></svg></html>',
      `<?xml-stylesheet href="x.css"?>${SVG}`,
      `<!DOCTYPE svg><!DOCTYPE svg>${SVG}`,
      `<!-- never closed ${SVG}`,
      '<?xml version="1.0"',
      '<svgx></svgx>', '<svg', 'hello', '', '<!DOCTYPE svg',
      '<g><svg/></g>',
    ]) expect(sniffLogo(enc(s)), s).toBeNull()
    expect(sniffLogo(Buffer.concat([enc('<svg>'), Buffer.from([0xff, 0xfe]), enc('</svg>')]))).toBeNull()   // not UTF-8
    expect(sniffLogo(Buffer.from('﻿<svg/>', 'utf16le'))).toBeNull()
  })
})

describe('findLogo - the ladder and its checks (A2.9)', () => {
  it('takes the first that counts, in the ladder\'s order - share.logo first', () => {
    expect([...LOGO_LADDER]).toEqual(['design/logo.svg', 'design/logo.png', 'public/logo.svg', 'public/logo.png', 'public/favicon.svg', 'public/favicon.png', 'public/favicon.ico'])
    const root = repo(Object.fromEntries(LOGO_LADDER.map((p) => [p, p.endsWith('.png') ? PNG : p.endsWith('.ico') ? ICO : SVG])))
    writeFileSync(join(root, 'brand.png'), PNG)
    expect(findLogo(root, 'brand.png')).toMatchObject({ from: 'brand.png', type: 'png' })
    for (const [i, p] of LOGO_LADDER.entries()) {
      const got = findLogo(root)
      expect(got?.from, `step ${i}`).toBe(p)
      expect(got?.type).toBe(p.split('.').pop() === 'svg' ? 'svg' : p.split('.').pop())
      expect(Buffer.compare(got!.bytes, readFileSync(join(root, p)))).toBe(0)
      rmSync(join(root, p))
    }
    expect(findLogo(root)).toBeNull()
    expect(findLogo(root, '')).toBeNull()
  })

  it('a share.logo that fails is ignored with one warning naming why, and the ladder goes on', () => {
    const outside = repo({ 'x.svg': SVG })
    const root = repo({ 'design/logo.svg': SVG, 'a.gif': PNG, 'big.png': Buffer.concat([PNG, Buffer.alloc(LOGO_MAX)]), 'page.svg': '<!doctype html><title>x</title>', 'dir.svg/x': 'x' })
    const cases: [string, RegExp][] = [
      ['../' + outside.split('/').pop() + '/x.svg', /outside the repo/],
      [join(outside, 'x.svg'), /outside the repo/],
      ['missing.svg', /no such file/],
      ['a.gif', /not \.svg, \.png or \.ico/],
      ['big.png', /over 256 KB/],
      ['page.svg', /not an image/],
      ['dir.svg', /not a file/],
    ]
    for (const [logo, why] of cases) {
      const warned: string[] = []
      const got = findLogo(root, logo, (m) => warned.push(m))
      expect(got?.from, logo).toBe('design/logo.svg')
      expect(warned, logo).toHaveLength(1)
      expect(warned[0], logo).toMatch(new RegExp(`^share\\.logo .* is ignored: ${why.source}`))
    }
    // the ladder's own misses are quiet
    const warned: string[] = []
    findLogo(repo({ 'design/logo.svg': '<p>not svg</p>' }), undefined, (m) => warned.push(m))
    expect(warned).toEqual([])
  })

  it('a symlink never counts: pointing out of the repo, or in it at a non-image (design/logo.svg -> ../.env)', () => {
    const outside = repo({ 'logo.svg': SVG })
    const root = repo({ '.env': 'SECRET=hunter2\n', 'public/logo.png': PNG, 'real.svg': SVG })
    mkdirSync(join(root, 'design'))
    symlinkSync('../.env', join(root, 'design', 'logo.svg'))
    expect(findLogo(root)?.from).toBe('public/logo.png')
    rmSync(join(root, 'design', 'logo.svg'))
    symlinkSync(join(outside, 'logo.svg'), join(root, 'design', 'logo.svg'))
    expect(findLogo(root)?.from).toBe('public/logo.png')
    // even one pointing at a real image inside the repo
    rmSync(join(root, 'design', 'logo.svg'))
    symlinkSync('../real.svg', join(root, 'design', 'logo.svg'))
    expect(findLogo(root)?.from).toBe('public/logo.png')
    const warned: string[] = []
    expect(findLogo(root, 'design/logo.svg', (m) => warned.push(m))?.from).toBe('public/logo.png')
    expect(warned).toEqual(['share.logo design/logo.svg is ignored: a symlink'])
  })

  it('a symlinked folder on the way out is caught by the real path', () => {
    const outside = repo({ 'logo.svg': SVG })
    const root = repo({ 'public/favicon.ico': ICO })
    symlinkSync(outside, join(root, 'design'))
    expect(findLogo(root)).toMatchObject({ from: 'public/favicon.ico', type: 'ico' })
  })

  it('an oversized file is skipped; one at exactly 256 KB counts', () => {
    const svgOf = (n: number) => { const head = '<svg>'; return head + ' '.repeat(n - head.length - 6) + '</svg>' }
    expect(Buffer.byteLength(svgOf(LOGO_MAX))).toBe(LOGO_MAX)
    const root = repo({ 'design/logo.svg': svgOf(LOGO_MAX + 1), 'design/logo.png': PNG })
    expect(findLogo(root)?.from).toBe('design/logo.png')
    writeFileSync(join(root, 'design/logo.svg'), svgOf(LOGO_MAX))
    expect(findLogo(root)?.from).toBe('design/logo.svg')
  })

  it('the type is the bytes\': an HTML file named logo.svg is refused, a PNG named .svg is a PNG, an ICO named .png an ICO', () => {
    expect(findLogo(repo({ 'design/logo.svg': '<html><body><script>alert(1)</script></body></html>' }))).toBeNull()
    expect(findLogo(repo({ 'design/logo.svg': PNG }))).toMatchObject({ from: 'design/logo.svg', type: 'png' })
    expect(findLogo(repo({ 'public/logo.png': ICO }))).toMatchObject({ from: 'public/logo.png', type: 'ico' })
    expect(findLogo(repo({ 'public/favicon.svg': `<?xml version="1.0"?>\n<!DOCTYPE svg [<!ENTITY a "b">]>${SVG}` }))).toBeNull()
  })
})

describe('marver build publishes the logo by its bytes (A2.9)', () => {
  const pub = (files: Record<string, string | Buffer>, share?: string) => {
    const root = repo(files)
    const out = join(root, 'design', '.dist')
    const warned: string[] = []
    const at = publishLogo(root, share, out, (m) => warned.push(m))
    const dir = join(out, '__mv')
    let names: string[] = []
    try { names = readdirSync(dir) } catch { /* none written */ }
    return { at, names, file: (n: string) => readFileSync(join(dir, n)), warned }
  }
  it('a real svg and png as before; an ico as logo.ico; a PNG named .svg as logo.png; none: nothing', () => {
    let r = pub({ 'design/logo.svg': SVG })
    expect([r.at, r.names, r.file('logo.svg').toString()]).toEqual(['/__mv/logo.svg', ['logo.svg'], SVG])
    r = pub({ 'design/logo.png': PNG })
    expect([r.at, r.names]).toEqual(['/__mv/logo.png', ['logo.png']])
    expect(Buffer.compare(r.file('logo.png'), PNG)).toBe(0)
    r = pub({ 'public/favicon.ico': ICO })
    expect([r.at, r.names]).toEqual(['/__mv/logo.ico', ['logo.ico']])
    r = pub({ 'design/logo.svg': PNG })
    expect([r.at, r.names]).toEqual(['/__mv/logo.png', ['logo.png']])
    r = pub({})
    expect([r.at, r.names]).toEqual([undefined, []])
  })
  it('never copies through a link, nor a share.logo from outside the repo', () => {
    const outside = repo({ 'brand.svg': SVG })
    const root = repo({})
    mkdirSync(join(root, 'design'))
    symlinkSync(join(outside, 'brand.svg'), join(root, 'design', 'logo.svg'))
    const out = join(root, 'design', '.dist')
    const warned: string[] = []
    expect(publishLogo(root, join(outside, 'brand.svg'), out, (m) => warned.push(m))).toBeUndefined()
    expect(warned).toEqual([`share.logo ${join(outside, 'brand.svg')} is ignored: outside the repo`])
  })
})

describe('GET /__mv/logo (A2.4, A2.9)', () => {
  const key = randomBytes(32)
  const proof = { instance: 'inst-1234', key, port: 4321 }
  let shareLogo: string | undefined
  let root = ''
  let server: Server
  let base = ''
  beforeAll(async () => {
    root = repo({ 'design/logo.svg': SVG })
    const mw = logoRoute(root, () => shareLogo, proof)
    server = createServer((req, res) => mw(req as never, res, () => { res.statusCode = 418; res.end('next') }))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))
  const sig = (nonce: string) => createHmac('sha256', key).update(`logo|${nonce}|4321`, 'utf8').digest('base64url')

  it('answers with the sniffed type, an ETag, no-cache, nosniff and a CSP that runs nothing - unproved without a nonce', async () => {
    const r = await fetch(`${base}/__mv/logo`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe(SVG)
    expect(Object.fromEntries(['content-type', 'etag', 'cache-control', 'x-content-type-options', 'content-security-policy', 'x-mv-instance', 'x-mv-proof'].map((h) => [h, r.headers.get(h)]))).toEqual({
      'content-type': 'image/svg+xml', etag: logoTag(enc(SVG)), 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-mv-instance': null, 'x-mv-proof': null,
    })
    expect(r.headers.get('etag')).toMatch(/^"[A-Za-z0-9_-]{22}"$/)
  })

  it('a well-formed nonce gets the logo proof - over logo|nonce|port, never the document\'s; a malformed one gets none', async () => {
    const nonce = randomBytes(24).toString('base64url')
    const r = await fetch(`${base}/__mv/logo`, { headers: { 'x-mv-nonce': nonce } })
    expect([r.status, r.headers.get('x-mv-instance'), r.headers.get('x-mv-proof')]).toEqual([200, 'inst-1234', sig(nonce)])
    expect(r.headers.get('x-mv-proof')).not.toBe(createHmac('sha256', key).update(`doc|${nonce}|4321`).digest('base64url'))
    for (const bad of ['short', 'x'.repeat(65), 'has space in it here', 'a/b+c=d0123456789']) {
      const b = await fetch(`${base}/__mv/logo`, { headers: { 'x-mv-nonce': bad } })
      expect([b.status, b.headers.get('x-mv-proof')], bad).toEqual([200, null])
    }
  })

  it('304 on a matching If-None-Match, proved like the 200; a stale tag gets the bytes', async () => {
    const tag = logoTag(enc(SVG))
    const nonce = randomBytes(24).toString('base64url')
    for (const inm of [tag, `W/${tag}`, `"other", ${tag}`, '*']) {
      const r = await fetch(`${base}/__mv/logo`, { headers: { 'if-none-match': inm, 'x-mv-nonce': nonce } })
      expect([r.status, await r.text(), r.headers.get('etag'), r.headers.get('x-mv-proof')], inm).toEqual([304, '', tag, sig(nonce)])
    }
    const stale = await fetch(`${base}/__mv/logo`, { headers: { 'if-none-match': '"old"' } })
    expect([stale.status, await stale.text()]).toEqual([200, SVG])
  })

  it('HEAD has the headers and no body; other methods 405; other paths pass on', async () => {
    const h = await fetch(`${base}/__mv/logo`, { method: 'HEAD' })
    expect([h.status, h.headers.get('content-type'), h.headers.get('content-length'), await h.text()]).toEqual([200, 'image/svg+xml', String(SVG.length), ''])
    const p = await fetch(`${base}/__mv/logo`, { method: 'POST', body: 'x' })
    expect([p.status, p.headers.get('allow')]).toEqual([405, 'GET, HEAD'])
    for (const path of ['/__mv/logo/', '/__mv/logo.svg', '/__mv/logos', '/logo']) expect((await fetch(`${base}${path}`)).status, path).toBe(418)
    expect((await fetch(`${base}/__mv/logo?r=1`)).status).toBe(200)
  })

  it('follows the repo as it is now: a new logo at once, a PNG named .svg as image/png, none a 404 with no proof', async () => {
    writeFileSync(join(root, 'design', 'logo.svg'), PNG)
    let r = await fetch(`${base}/__mv/logo`)
    expect([r.status, r.headers.get('content-type'), r.headers.get('etag')]).toEqual([200, 'image/png', logoTag(PNG)])
    expect(Buffer.compare(Buffer.from(await r.arrayBuffer()), PNG)).toBe(0)
    shareLogo = 'design/logo.svg'
    expect((await fetch(`${base}/__mv/logo`)).headers.get('content-type')).toBe('image/png')
    shareLogo = undefined
    rmSync(join(root, 'design', 'logo.svg'))
    symlinkSync('/etc/hosts', join(root, 'design', 'logo.svg'))
    const nonce = randomBytes(24).toString('base64url')
    r = await fetch(`${base}/__mv/logo`, { headers: { 'x-mv-nonce': nonce } })
    expect([r.status, r.headers.get('cache-control'), r.headers.get('x-mv-proof'), await r.text()]).toEqual([404, 'no-store', null, ''])
  })
})

describe('a gated marver serve shows the logo before sign-in (v1.7 review #5)', () => {
  const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
  let proc: ChildProcess | null = null
  let port = 0
  let root = ''
  beforeAll(async () => {
    root = repo({
      'design/.dist/index.html': '<!doctype html><title>bundle</title><script>window.__BUNDLE__=1</script>',
      'design/.dist/meta.json': JSON.stringify({ name: 'Fixture', branding: true, logo: '/__mv/logo.ico' }),
      'design/.dist/__mv/logo.ico': ICO,
    })
    port = 7100 + Math.floor(Math.random() * 300)
    while (await portInUse(port)) port++
    const data = mkdtempSync(join(tmpdir(), 'mv-logo-data-'))
    dirs.push(data)
    proc = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], { cwd: root, stdio: 'pipe', env: { ...process.env, MARVER_PASSWORD: 'hunter2', MARVER_DATA_DIR: data, MARVER_ID_ISSUER: '' } })
    const by = Date.now() + 20_000
    while (Date.now() < by && !(await fetch(`http://localhost:${port}/__mv/logo.ico`).then(() => true, () => false))) await new Promise((r) => setTimeout(r, 100))
  }, 30_000)
  afterAll(() => { proc?.kill('SIGKILL') })

  it('/__mv/logo.ico answers before sign-in when it exists, and 404 - never the bundle - when it does not', async () => {
    const r = await fetch(`http://localhost:${port}/__mv/logo.ico`)
    expect([r.status, r.headers.get('content-type')]).toEqual([200, 'image/x-icon'])
    expect(Buffer.compare(Buffer.from(await r.arrayBuffer()), ICO)).toBe(0)
    rmSync(join(root, 'design', '.dist', '__mv', 'logo.ico'))
    const gone = await fetch(`http://localhost:${port}/__mv/logo.ico`)
    const body = await gone.text()
    expect(gone.status).toBe(404)
    expect(body).not.toContain('__BUNDLE__')
    // the gate still holds everything else
    const page = await fetch(`http://localhost:${port}/`)
    expect(await page.text()).not.toContain('__BUNDLE__')
  })
})
