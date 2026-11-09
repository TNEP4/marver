import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'

/**
 * Your own breakpoints in the shell (spec 31 F.1, F.3) and the canvas's identity (G.1), against a REAL `marver dev`
 * and a REAL headless Chrome: a device with its own SVG - a hostile one, with a script, an onload, a foreignObject and
 * an external image - wears it as a CSS mask in the ink, which draws the shape and runs nothing (no global set, no
 * `<script>`/`<foreignObject>` in the page, the decoded mask free of them); the others show their name's label and
 * glyph ("iPad landscape" turned a quarter) or the config's ("Lobby kiosk"); the device menu, the frame toolbar and
 * Play's device menu all say the labels; the sidebar wears config `name` and `/__mv/logo` serves config `logo`.
 * Skips without Chrome.
 */

const HOSTILE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="window.top.__pwned = 'onload'">
<script>window.top.__pwned = 'script'</script>
<foreignObject width="24" height="24"><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="window.top.__pwned = 'fo'" /></body></foreignObject>
<image href="https://evil.example/track.png" width="24" height="24" />
<rect x="2" y="2" width="20" height="20" fill="none" stroke="#000" stroke-width="3" style="display:none" />
</svg>`
const FRAME = `export const meta = { title: 'Reader', viewport: 'boox-full' }\nexport default () => <main style={{ background: '#fff', height: '100vh' }}><h1>Reader</h1></main>\n`
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>\n'

let root = ''
let dev: Dev | null = null
let browser: Browser | null = null

beforeAll(async () => {
  root = fixtureRoot('mv-r31-devices-', {
    'design/config.ts': `export default {
  name: 'Tidewell Reader',
  logo: 'brand/mark.svg',
  viewports: {
    'boox-full': { width: 1240, height: 1860, icon: 'design/icons/boox.svg' },
    'ipad-landscape': { width: 1180, height: 820 },
    kiosk: { width: 1080, height: 1920, label: 'Lobby kiosk', icon: 'monitor' },
  },
}\n`,
    'design/icons/boox.svg': HOSTILE,
    'brand/mark.svg': LOGO,
    'design/scenes/demo/reader.tsx': FRAME,
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [{ key: 'n-reader', frame: 'demo/reader', x: 0, y: 0, w: 1240, h: 900 }] }),
  })
  dev = await startDev(root)
  browser = await Browser.launch()
}, 120_000)
afterAll(async () => {
  browser?.close()
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

const ev = (s: string, x: string) => browser!.eval(s, x)
/** a menu button's words (its mask span, when it has one, says none) */
const WORDS = `const words = (b) => [...b.querySelectorAll('span')].map((x) => x.textContent).join('');`
const menuLabels = `(() => { ${WORDS} return [...document.querySelectorAll('button')].filter((b) => b.querySelector('kbd')).map(words).filter(Boolean) })()`
const byLabel = (l: string) => `[...document.querySelectorAll('button')].find((b) => b.querySelector('kbd') && words(b) === ${JSON.stringify(l)})`

async function open(): Promise<string> {
  const s = await browser!.tab({ width: 1400, height: 900 })
  await browser!.go(s, `${dev!.origin}/#/main`)
  await browser!.until(s, `!!window.__mvStore && __mvStore.getState().nodes.length > 0`, 30_000)
  return s
}

/** The red pixels in a clip of the page (scale 1). */
async function redIn(s: string, r: { x: number; y: number; width: number; height: number }): Promise<{ red: number; all: number }> {
  const { data } = await browser!.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } }, s)
  const b = Buffer.from(data, 'base64')
  let o = 8, w = 0, h = 0, type = 6
  const idat: Buffer[] = []
  while (o < b.length) {
    const len = b.readUInt32BE(o), t = b.toString('latin1', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len)
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); type = d[9] }
    if (t === 'IDAT') idat.push(d)
    o += 12 + len
  }
  const bpp = type === 6 ? 4 : 3, stride = w * bpp
  const raw = inflateSync(Buffer.concat(idat))
  let prev = Buffer.alloc(stride), red = 0
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, u = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      if (f === 1) line[i] = (line[i] + a) & 255
      else if (f === 2) line[i] = (line[i] + u) & 255
      else if (f === 3) line[i] = (line[i] + ((a + u) >> 1)) & 255
      else if (f === 4) { const p = a + u - c, pa = Math.abs(p - a), pb = Math.abs(p - u), pc = Math.abs(p - c); line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c)) & 255 }
    }
    for (let x = 0; x < w; x++) { const k = x * bpp; if (line[k] > 180 && line[k + 1] < 90 && line[k + 2] < 90) red++ }
    prev = line
  }
  return { red, all: w * h }
}

describe('your own breakpoints in the shell (spec 31 F)', () => {
  it('the device menu: each label, a hostile SVG drawn as a mask that runs nothing, the name\'s glyph turned for landscape', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await open()
    // the canvas's device menu (the toolbar's Devices pill)
    await ev(s, `[...document.querySelectorAll('.sh-theme > span > button.sh-pill-btn, .sh-theme button.sh-pill-btn')].find((b) => b.closest('.sh-theme') && !b.closest('.sh-play-pill'))?.click(), 1`)
    await browser.until(s, `[...document.querySelectorAll('button span')].some((x) => x.textContent === 'Lobby kiosk')`, 10_000)
    const labels = await ev(s, menuLabels)
    expect(labels).toEqual(expect.arrayContaining(['Boox full', 'iPad landscape', 'Lobby kiosk']))
    // ...shown as written: the menu's capitalising is for theme names, never "IPad Landscape"
    expect(await ev(s, `[...document.querySelectorAll('span.dev-label')].map((x) => getComputedStyle(x).textTransform)`)).toEqual(['none', 'none', 'none'])
    // the boox's own icon: a mask span, a base64 SVG data URI, in the ink
    const mask = await ev(s, `(() => { ${WORDS} const b = ${byLabel('Boox full')}; const m = b?.querySelector('.sh-dev-mask'); if (!m) return null; const cs = getComputedStyle(m); return { img: cs.maskImage || cs.webkitMaskImage, bg: cs.backgroundColor, color: getComputedStyle(b).color, w: m.offsetWidth, h: m.offsetHeight } })()`)
    expect(mask).not.toBeNull()
    expect(mask.img).toMatch(/^url\("data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*"\)$/)
    expect(mask.bg).toBe(mask.color)
    expect([mask.w, mask.h]).toEqual([14, 14])
    const svg = Buffer.from(/base64,([^"]+)/.exec(mask.img)![1], 'base64').toString('utf8')
    expect(svg).not.toMatch(/script|onload|foreignObject|image|href|style|evil/i)
    expect(svg).toContain('<rect x="2" y="2" width="20" height="20" fill="none" stroke="#000" stroke-width="3"/>')
    // nothing ran, nothing was injected
    expect(await ev(s, `window.__pwned ?? null`)).toBeNull()
    expect(await ev(s, `document.querySelectorAll('script:not([type="module"]):not([src]), foreignObject').length`)).toBe(0)
    // the iPad's glyph is the tablet's, turned a quarter; the kiosk's the monitor's
    const turned = await ev(s, `(() => { ${WORDS} const b = ${byLabel('iPad landscape')}; return b?.querySelector('svg')?.style.transform ?? null })()`)
    expect(turned).toBe('rotate(90deg)')
    // and the mask DRAWS its shape: in red, an outline - red pixels, and a clear middle
    await ev(s, `(() => { const st = document.createElement('style'); st.textContent = '.sh-dev-mask { background-color: rgb(255, 0, 0) !important; width: 48px !important; height: 48px !important }'; document.head.appendChild(st); return 1 })()`)
    await new Promise((r) => setTimeout(r, 300))
    const r = await ev(s, `(() => { const m = [...document.querySelectorAll('.sh-dev-mask')].pop(); const b = m.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } })()`)
    const whole = await redIn(s, r)
    const middle = await redIn(s, { x: r.x + r.width * 0.3, y: r.y + r.height * 0.3, width: r.width * 0.4, height: r.height * 0.4 })
    expect(whole.red).toBeGreaterThan(40)
    expect(whole.red).toBeLessThan(whole.all * 0.8)
    expect(middle.red).toBe(0)
    await browser.closeTab(s)
  }, 120_000)

  it('the frame toolbar and Play say the labels; the sidebar wears config name; /__mv/logo serves config logo', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await open()
    await ev(s, `__mvStore.getState().select('n-reader'), 1`)
    await browser.until(s, `document.querySelectorAll('button[aria-label="Lobby kiosk"]').length > 0`, 10_000)
    expect(await ev(s, `['Boox full', 'iPad landscape', 'Lobby kiosk'].map((l) => !!document.querySelector('button[aria-label="' + l + '"]'))`)).toEqual([true, true, true])
    // the frame wears the boox's width: its button says its label beside the mask
    expect(await ev(s, `document.querySelector('button.on[aria-label="Boox full"]')?.textContent`)).toBe('Boox full')
    expect(await ev(s, `!!document.querySelector('button.on[aria-label="Boox full"] .sh-dev-mask')`)).toBe(true)
    expect(await ev(s, `document.querySelector('.sh-panel .name')?.textContent`)).toBe('Tidewell Reader')
    const logo = await fetch(`${dev!.origin}/__mv/logo`)
    expect([logo.status, logo.headers.get('content-type'), await logo.text()]).toEqual([200, 'image/svg+xml', LOGO])
    // Play: its device menu says the labels too
    await ev(s, `__mvStore.getState().setPlay({ at: 'demo/reader', device: 'kiosk', theme: 'light' }), 1`)
    await browser.until(s, `!!document.querySelector('.sh-play-pill')`, 10_000)
    await ev(s, `[...document.querySelectorAll('.sh-play-pill:not(.sh-play-brand) .sh-theme button.sh-pill-btn')][0]?.click(), 1`)
    await browser.until(s, `[...document.querySelectorAll('button span')].some((x) => x.textContent === 'iPad landscape')`, 10_000)
    expect(await ev(s, menuLabels)).toEqual(expect.arrayContaining(['Boox full', 'iPad landscape', 'Lobby kiosk', 'Fill window']))
    await browser.closeTab(s)
  }, 120_000)

  it('marver dev\'s boot line: quiet for a canvas with a name and a logo, a note for one on its folder\'s name and the Marver mark (G.2)', async () => {
    expect(dev!.out()).not.toContain('this canvas still shows')
    const bare = fixtureRoot('mv-r31-bare-', { 'design/scenes/demo/a.tsx': FRAME.replace("viewport: 'boox-full'", "viewport: 'mobile'") })
    const d = await startDev(bare)
    try {
      expect(d.out()).toMatch(/this canvas still shows its folder's name \("mv-r31-bare-[^"]+"\) and the Marver mark - give it name: "Your Product" in design\/config.ts and your product's logo at design\/logo.svg/)
    } finally {
      await d.stop()
      rmSync(bare, { recursive: true, force: true })
    }
  }, 120_000)

  it('the Jam panel\'s lines say a device as it reads, with its icon - a device step and a view step (F.3)', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await open()
    const html = await ev(s, `(async () => {
      const res = performance.getEntriesByType('resource').map((e) => e.name)
      const mod = (re) => res.find((n) => re.test(n))
      const R = await import(mod(/\\/deps\\/react\\.js/)), D = await import(mod(/\\/deps\\/react-dom_client\\.js/))
      const createElement = R.createElement ?? R.default.createElement, createRoot = D.createRoot ?? D.default.createRoot
      const shell = mod(/\\/shell\\/store\\.ts/).replace(/store\\.ts.*$/, '')
      const { Lines } = await import(shell + 'jam-panel.tsx')
      const div = document.createElement('div'); document.body.appendChild(div)
      const lines = [
        { t: '0:01', kind: 'device', text: 'Reader · boox-full 1240', device: 'boox-full' },
        { t: '0:02', kind: 'view', text: 'main / Reader · ipad-landscape 1180×820 · light', device: 'ipad-landscape' },
      ]
      createRoot(div).render(createElement(Lines, { lines }))
      await new Promise((r) => setTimeout(r, 200))
      return div.innerHTML
    })()`)
    expect(html).toContain('viewed at <b class="ui">Boox full 1240</b>')
    expect(html).toMatch(/<span class="jm-dev"><svg[^>]*style="transform: rotate\(90deg\);"[^>]*>.*?<\/svg>iPad landscape 1180×820<\/span>/)
    expect(html).toContain('data-mv-device-mask')
    await browser.closeTab(s)
  }, 120_000)
})
