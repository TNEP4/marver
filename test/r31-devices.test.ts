import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { glyphFromName, isLandscape, labelFromName, lookFromName, parseGlyph } from '../src/shared/devices.ts'
import { DEVICE_ICON_MAX, readDeviceIcon, resolveDevices, sanitizeSvg } from '../src/server/device-icons.ts'
import { loadConfig } from '../src/server/config.ts'
import { lineText, timelineLines } from '../src/client/shell/jam-lines.ts'

/**
 * Your own breakpoints (spec 31 Part F): a device's glyph and label from its name - the brand casing ("ipad-landscape"
 * -> "iPad landscape", "boox-full" -> "Boox full") and the name rules for the glyph; `icon` as a built-in glyph (a
 * `-landscape` suffix turning it) or a repo SVG read inside the repo only and REBUILT from the allowlist - each
 * malicious fixture (script, event handlers, foreignObject, style, href/xlink, use, image, external and data URLs,
 * entities, CSS in attributes) leaves nothing that can run or restyle the page, or is refused; a bad icon falls back to
 * the glyph with a warning; and `loadConfig` carries the looks beside sizes that stay two numbers.
 */

const dirs: string[] = []
const repo = (files: Record<string, string | Buffer> = {}): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-r31-dev-')))
  dirs.push(root)
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="3" y="2" width="18" height="20" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 6h8M8 10h8"/></svg>'
const decode = (uri: string) => Buffer.from(uri.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8')

describe('a device from its name (F.2)', () => {
  it('the glyph: phones, tablets, laptops, monitors, TVs - class words before brands', () => {
    const cases: Record<string, string | null> = {
      mobile: 'mobile', 'iphone-15-pro': 'mobile', iphone: 'mobile', phone: 'mobile', android: 'mobile', 'pixel-8': 'mobile', 'iphone-landscape': 'mobile',
      tablet: 'tablet', ipad: 'tablet', 'ipad-landscape': 'tablet', ipadpro: 'tablet', 'boox-full': 'tablet', kindle: 'tablet', 'pixel-tablet': 'tablet',
      laptop: 'laptop', macbook: 'laptop', 'macbook-air': 'laptop',
      monitor: 'monitor', imac: 'monitor', desktop: 'monitor', 'studio-display': 'monitor',
      tv: 'tv', 'apple-tv': 'tv', 'hero-wide': null, 'xl': null, 'tvos-ish': null,
    }
    for (const [name, glyph] of Object.entries(cases)) expect(glyphFromName(name), name).toBe(glyph)
  })

  it('-landscape turns it', () => {
    expect(isLandscape('ipad-landscape')).toBe(true)
    expect(isLandscape('iphone-landscape')).toBe(true)
    expect(isLandscape('ipad')).toBe(false)
    expect(isLandscape('landscaper')).toBe(false)
    expect(lookFromName('ipad-landscape')).toEqual({ label: 'iPad landscape', glyph: 'tablet', rotate: true })
  })

  it('the label: humanized with brand casing', () => {
    const cases: Record<string, string> = {
      'ipad-landscape': 'iPad landscape', 'boox-full': 'Boox full', 'iphone-landscape': 'iPhone landscape', ipad: 'iPad', iphone: 'iPhone',
      'iphone-15-pro-max': 'iPhone 15 Pro Max', 'macbook-air': 'MacBook Air', imac: 'iMac', tv: 'TV', 'apple-tv': 'Apple TV',
      mobile: 'Mobile', tablet: 'Tablet', laptop: 'Laptop', monitor: 'Monitor', 'hero_wide': 'Hero wide', 'studio-display': 'Studio Display',
      'ipad13': 'iPad13', '4k-tv': '4K TV', myDevice: 'myDevice', 'kindle-paperwhite': 'Kindle paperwhite',
    }
    for (const [name, label] of Object.entries(cases)) expect(labelFromName(name), name).toBe(label)
  })

  it('a built-in glyph as `icon` names it, with its turn', () => {
    expect(parseGlyph('tablet')).toEqual({ glyph: 'tablet', rotate: false })
    expect(parseGlyph('mobile-landscape')).toEqual({ glyph: 'mobile', rotate: true })
    for (const g of ['watch', 'desktop', 'ereader', 'tv', 'laptop', 'monitor']) expect(parseGlyph(g)?.glyph).toBe(g)
    for (const bad of ['phone', 'Tablet', 'tablet-portrait', 'icons/x.svg', '']) expect(parseGlyph(bad)).toBeNull()
  })
})

describe('a device\'s own SVG: the strict allowlist (F.1)', () => {
  const clean = (src: string) => { const r = sanitizeSvg(src); if ('error' in r) throw new Error(r.error); return r.svg }

  it('a plain icon survives, rebuilt: shapes and their geometry and paint, nothing else', () => {
    const out = clean(ICON)
    expect(out).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="3" y="2" width="18" height="20" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 6h8M8 10h8"/></svg>')
  })

  it('an editor\'s export: title, desc, metadata, defs and comments dropped; a size without a viewBox becomes one', () => {
    const out = clean(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by hand -->\n<svg width="32" height="32" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><title>Boox</title><desc>an e-reader</desc><metadata><x/></metadata><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><g fill="#000" transform="translate(2 2) scale(1.5)"><circle cx="8" cy="8" r="6"/></g></svg>`)
    expect(out).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><g fill="#000" transform="translate(2 2) scale(1.5)"><circle cx="8" cy="8" r="6"/></g></svg>')
  })

  // every one of these must come out with nothing that can run, fetch or restyle anything
  const HOSTILE: Record<string, string> = {
    script: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>`,
    'script in CDATA': `<svg xmlns="http://www.w3.org/2000/svg"><script><![CDATA[alert(1)]]></script><rect width="10" height="10"/></svg>`,
    'event handlers': `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 10 10"><rect onclick="alert(2)" onmouseover='alert(3)' width="10" height="10"/></svg>`,
    foreignObject: `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="10" height="10"><body xmlns="http://www.w3.org/1999/xhtml"><iframe src="javascript:alert(1)"></iframe><rect width="1" height="1"/></body></foreignObject><rect width="10" height="10"/></svg>`,
    'style element and attribute': `<svg xmlns="http://www.w3.org/2000/svg"><style>body{display:none}@import url(https://evil.example/x.css)</style><rect style="fill:url(https://evil.example/p)" class="c" id="i" width="10" height="10"/></svg>`,
    'href and xlink:href': `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a href="javascript:alert(1)"><rect width="10" height="10"/></a><use xlink:href="https://evil.example/s.svg#x"/><use href="#r"/><rect width="10" height="10"/></svg>`,
    image: `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/track.png" width="1" height="1"/><image xlink:href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" /><rect width="10" height="10"/></svg>`,
    'url() paint and filters': `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/p#g)" stroke="url(#g)" filter="url(#f)" mask="url(#m)" clip-path="url(#c)" width="10" height="10"/></svg>`,
    'expressions and schemes in values': `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="javascript:alert(1)" stroke="expression(alert(1))" width="10;background:red" height="10" transform="url(x)"/><path d="M0 0L10 10" fill="rgb(0,0,0)"/><rect width="10" height="10"/></svg>`,
    'set and animate': `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"><set attributeName="onmouseover" to="alert(1)"/><animate attributeName="href" values="javascript:alert(1)"/></rect></svg>`,
    'namespaced elements': `<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml"><h:script>alert(1)</h:script><svg:path xmlns:svg="http://www.w3.org/2000/svg" d="M0 0"/><rect width="10" height="10"/></svg>`,
    'a nested svg': `<svg xmlns="http://www.w3.org/2000/svg"><svg onload="alert(1)"><rect width="1" height="1"/></svg><rect width="10" height="10"/></svg>`,
    'quotes and angle brackets in values': `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10&quot; onload=&quot;alert(1)" height='10"><script>alert(1)</script>' fill="&#34;&#62;"/><rect width="10" height="10"/></svg>`,
  }
  for (const [name, src] of Object.entries(HOSTILE)) {
    it(`hostile: ${name} - nothing that runs, fetches or restyles survives`, () => {
      const r = sanitizeSvg(src)
      if ('error' in r) return   // refused outright is as safe as stripped
      const out = r.svg
      expect(out).not.toMatch(/script|on[a-z]+=|foreignObject|style|class=|id=|href|<use|<image|url\(|javascript|expression|<set|<animate|<a[\s>]|data:|&/i)
      // every attribute is name="plain value" - nothing broke out of its quotes
      for (const m of out.matchAll(/<[a-z]+((?:\s[^>]*?)?)\/?>/g)) expect(m[1].replace(/\s[a-zA-Z-]+="[-+.,%#\s0-9A-Za-z()/:]*"/g, '')).toBe('')
      // only allowlisted elements are left, and exactly one svg
      for (const m of out.matchAll(/<([A-Za-z:]+)/g)) expect(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']).toContain(m[1])
      expect(out.match(/<svg/g)?.length).toBe(1)
      expect(out).toMatch(/<rect width="10" height="10"(\/>|><\/rect>)/)
    })
  }

  it('refused: a DOCTYPE or entities (the billion laughs), a malformed document, a root that is not svg, nothing drawn', () => {
    const refused = [
      `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg"><rect width="&b;" height="1"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width=1 height=1/></svg>`,
      `<html><svg><rect width="1" height="1"/></svg></html>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><g><title>empty</title></g></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg><svg><rect width="1" height="1"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg><`,
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="&custom;"/></svg>`.replace('/>', '/><rect width="1"'),
      'not an svg at all',
    ]
    for (const src of refused) expect('error' in sanitizeSvg(src), src).toBe(true)
  })
})

describe('reading a device\'s icon: inside the repo only (F.1)', () => {
  it('a repo SVG becomes a base64 data URI of the sanitized text', () => {
    const root = repo({ 'design/icons/boox.svg': ICON.replace('<path', '<script>x</script><path') })
    const r = readDeviceIcon(root, 'design/icons/boox.svg')
    expect('mask' in r && r.mask).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/)
    if (!('mask' in r)) return
    expect(decode(r.mask)).not.toContain('script')
    expect(decode(r.mask)).toContain('<path d="M8 6h8M8 10h8"/>')
  })

  it('never a symlink, never outside the repo, never over 32 KB, never an absolute path, never a non-SVG name', () => {
    const outside = repo({ 'secret.svg': ICON })
    const root = repo({ 'design/icons/ok.svg': ICON, 'design/icons/big.svg': `<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="1" height="1"/>'.repeat(Math.ceil(DEVICE_ICON_MAX / 28) + 1)}</svg>`, 'design/icons/ok.png': ICON })
    symlinkSync(join(outside, 'secret.svg'), join(root, 'design/icons/link.svg'))
    symlinkSync(outside, join(root, 'design/out'))
    const why = (rel: string) => { const r = readDeviceIcon(root, rel); return 'error' in r ? r.error : 'read' }
    expect(why('design/icons/ok.svg')).toBe('read')
    expect(why('design/icons/link.svg')).toBe('a symlink')
    expect(why('design/out/secret.svg')).toBe('outside the repo')
    expect(why('../' + outside.split('/').pop() + '/secret.svg')).toBe('outside the repo')
    expect(why(join(outside, 'secret.svg'))).toBe('it is not a repo-relative path')
    expect(why('design/icons/big.svg')).toBe('over 32 KB')
    expect(why('design/icons/ok.png')).toBe('not an .svg')
    expect(why('design/icons/none.svg')).toBe('no such file')
  })
})

describe('each device\'s look, resolved (F.1-F.2)', () => {
  it('label and icon as given; a bad one falls back to the name\'s with a warning; the rest from the name', () => {
    const root = repo({ 'design/icons/boox.svg': ICON, 'design/icons/evil.svg': '<!DOCTYPE x><svg/>' })
    const warn = vi.fn()
    const looks = resolveDevices(root, {
      'boox-full': { width: 1, height: 1, icon: 'design/icons/boox.svg' },
      ipad: { width: 1, height: 1, label: 'iPad Pro 13"', icon: 'tablet-landscape' },
      iphone: { width: 1, height: 1 },
      'ipad-landscape': { width: 1, height: 1, icon: 'design/icons/evil.svg', label: 'x'.repeat(41) },
      kiosk: { width: 1, height: 1, icon: 'kiosk' },
      watchy: { width: 1, height: 1, icon: 42 },
    }, ['boox-full', 'ipad', 'iphone', 'ipad-landscape', 'kiosk', 'watchy'], warn)
    expect(looks['boox-full'].label).toBe('Boox full')
    expect(looks['boox-full'].mask).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(looks.ipad).toEqual({ label: 'iPad Pro 13"', glyph: 'tablet', rotate: true })
    expect(looks.iphone).toEqual({ label: 'iPhone', glyph: 'mobile', rotate: false })
    expect(looks['ipad-landscape']).toEqual({ label: 'iPad landscape', glyph: 'tablet', rotate: true })
    expect(looks.kiosk).toEqual({ label: 'Kiosk', glyph: null, rotate: false })
    const said = warn.mock.calls.map((c) => c[0] as string)
    expect(said.some((m) => m.includes('viewports.ipad-landscape.icon design/icons/evil.svg is ignored: it declares a DOCTYPE or entities - showing the tablet glyph'))).toBe(true)
    expect(said.some((m) => m.includes('viewports.ipad-landscape.label must be text of 1 to 40 characters'))).toBe(true)
    expect(said.some((m) => m.includes('viewports.kiosk.icon must be a built-in glyph'))).toBe(true)
    expect(said.some((m) => m.includes('viewports.watchy.icon must be a built-in glyph'))).toBe(true)
    expect(said).toHaveLength(4)
  })

  it('loadConfig: the sizes stay two numbers, the looks ride beside them; defaults have looks too', async () => {
    const root = repo({
      'design/icons/boox.svg': ICON,
      'design/config.ts': `export default { viewports: { 'boox-full': { width: 1240, height: 1860, icon: 'design/icons/boox.svg' }, 'ipad-landscape': { width: 1180, height: 820 }, bad: { width: 0, height: 1, label: 'gone' } } }\n`,
    })
    const c = await loadConfig(root)
    expect(c.viewports).toEqual({ 'boox-full': { width: 1240, height: 1860 }, 'ipad-landscape': { width: 1180, height: 820 } })
    expect(Object.keys(c.devices)).toEqual(['boox-full', 'ipad-landscape'])
    expect(c.devices['boox-full'].mask).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(c.devices['ipad-landscape']).toEqual({ label: 'iPad landscape', glyph: 'tablet', rotate: true })
    const d = await loadConfig(repo())
    expect(d.devices.mobile).toEqual({ label: 'Mobile', glyph: 'mobile', rotate: false })
    expect(Object.keys(d.devices)).toEqual(Object.keys(d.viewports))
  })
})

describe('a Jam device step names its viewport for the panel (F.3)', () => {
  it('the line carries the configured name - the panel shows its label and icon - and its text for the agent stays the name', () => {
    const r = { timeline: [{ at: 0, event: 'device', frame: 'demo/reader', viewport: 'ipad-landscape', width: 1180, height: 820 }] } as unknown as Parameters<typeof timelineLines>[0]
    const [l] = timelineLines(r)
    expect(l).toMatchObject({ kind: 'device', device: 'ipad-landscape', text: 'Reader · ipad-landscape 1180' })
    expect(lineText(l)).toBe('[0:00] (device) Reader · ipad-landscape 1180')
  })
})
