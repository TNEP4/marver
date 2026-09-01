import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * The slides hard invariants (spec 09, slice 8), proven in a real browser
 * against a real published build - not against the constants that produced it.
 *
 * (1) A resting slide serializes to the LEAN path: the facade admits
 *     (`data-ready`) for every slide - Chart (SVG) and Video (poster-only)
 *     included - and the lean doc holds zero <canvas>/<video> elements.
 * (2) Deck order is the board's frozen reading order and stepping walks it.
 * (3) Slides mode survives a refresh via the hash (`slides=1`).
 * (4) The stage stamps the play contract (`data-sl-play`/`data-sl-entered`)
 *     so entrance presets and player mounts have their signal.
 */

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const PORT = 4767
const base = `http://localhost:${PORT}`

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null

const slide = (title: string, body: string) => `
import { Slide } from '@marver-design/marver/content'
export const meta = { title: ${JSON.stringify(title)}, slide: true }
export default function F() {
  return (
    <Slide>
      <h1 className="sl-assertion" style={{ viewTransitionName: 'headline' }} data-animate="fade-up">${title}</h1>
      ${body}
    </Slide>
  )
}
`

const chartSlide = `
import { Slide, Chart } from '@marver-design/marver/content'
export const meta = { title: 'Numbers', slide: true }
export default function F() {
  return (
    <Slide>
      <h1 className="sl-assertion">Numbers</h1>
      <Chart h={360} option={{
        xAxis: { type: 'category', data: ['a', 'b', 'c'] },
        yAxis: { type: 'value' },
        series: [{ type: 'bar', data: [3, 7, 5] }],
      }} />
    </Slide>
  )
}
`

const videoSlide = `
import { Slide, Video } from '@marver-design/marver/content'
export const meta = { title: 'Motion', slide: true }
export default function F() {
  return (
    <Slide>
      <h1 className="sl-assertion" style={{ viewTransitionName: 'headline' }} data-animate="fade-up">Motion</h1>
      <Video src="clip.mp4" poster="clip.png" />
    </Slide>
  )
}
`

// 1x1 transparent PNG - the poster only needs to be a real decodable image
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-slidesbrowser-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'slides-fixture', private: true, type: 'module' }))
  // fixture node_modules: every repo dep, PLUS the repo itself as the
  // published package name - the frames import '@marver-design/marver/content'
  const repoRoot = join(import.meta.dirname, '..')
  const repoNm = join(repoRoot, 'node_modules')
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(repoNm)) {
    if (e === '.bin') continue
    symlinkSync(join(repoNm, e), join(nm, e))
  }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  const deck = join(root, 'design', 'scenes', 'deck')
  mkdirSync(deck, { recursive: true })
  writeFileSync(join(deck, '01-open.tsx'), slide('The opening', '<p className="sl-support" data-animate="fade" data-animate-delay="1">still at rest</p>'))
  writeFileSync(join(deck, '02-chart.tsx'), chartSlide)
  writeFileSync(join(deck, '03-video.tsx'), videoSlide)
  const assets = join(root, 'design', 'assets')
  mkdirSync(assets, { recursive: true })
  writeFileSync(join(assets, 'clip.png'), PNG_1PX)
  writeFileSync(join(assets, 'clip.mp4'), Buffer.from('stub - never fetched at rest'))
  const boards = join(root, 'design', 'boards')
  mkdirSync(boards, { recursive: true })
  // reading order is (y, x): 02-chart sits on the second ROW, so it comes
  // last - the deck must follow the board, not the filenames
  const nodes = [
    { key: 'n1', frame: 'deck/01-open', x: 0, y: 0, w: 640, h: 360 },
    { key: 'n3', frame: 'deck/03-video', x: 700, y: 0, w: 640, h: 360 },
    { key: 'n2', frame: 'deck/02-chart', x: 0, y: 500, w: 640, h: 360 },
  ]
  writeFileSync(join(boards, 'show.json'), JSON.stringify({ version: 1, name: 'show', order: 1, nodes }))
  writeFileSync(join(boards, 'rest.json'), JSON.stringify({ version: 1, name: 'rest', order: 2, nodes }))
  writeFileSync(join(boards, 'trim.json'), JSON.stringify({ version: 1, name: 'trim', order: 3, nodes }))
  writeFileSync(join(boards, 'share.json'), JSON.stringify({ version: 1, name: 'share', order: 4, nodes }))
  writeFileSync(join(root, 'design', 'publish.json'), JSON.stringify({
    version: 2,
    boards: {
      show: { max: 'read', type: 'slides' },                    // lands in slides, FULL chrome (default)
      rest: { max: 'read', type: 'slides', open: 'canvas' },    // the board surface - the resting state
      trim: { max: 'read', type: 'slides', chrome: 'minimal' }, // the publish-time trim
      share: { max: 'read', type: 'slides', open: 'slides', lock: true },  // the deck-only share link
    },
  }))
  execFileSync(process.execPath, [CLI, 'build', '--root', root], { stdio: 'pipe' })
  server = spawn(process.execPath, [CLI, 'serve', '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, MARVER_DATA_DIR: '', MARVER_PASSWORD: '', MARVER_ID_ISSUER: '' } })
  await new Promise((r) => setTimeout(r, 800))
  browser = await Browser.launch()
}, 240_000)

afterAll(() => {
  browser?.close()
  try { server?.kill('SIGTERM') } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true })
})

const skippable = (name: string, fn: () => Promise<void>, ms = 90_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)

// full chrome: the bottom-left walker carries the position ("1/3")
const POS = `document.querySelector('.sh-play-nav .pos')?.textContent`

const key = (k: string) => async (tab: string) => {
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k === ' ' ? 'Space' : k }, tab)
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k === ' ' ? 'Space' : k }, tab)
}

describe('slides in a real published browser', () => {
  skippable('every resting slide - chart and video included - admits a lean cover with no canvas/video', async () => {
    const tab = await browser!.tab({ width: 1600, height: 1000 })
    await browser!.go(tab, `${base}/#/b/rest`)
    await browser!.until(tab, `!!document.querySelector('.sh-panel')`)
    // all three facades must ADMIT - a degraded slide never gets data-ready,
    // so readiness itself is the serializability assertion
    await browser!.until(tab, `document.querySelectorAll('.sh-lean[data-ready]').length === 3`, 45_000)
    const audit = await browser!.eval(tab, `
      [...document.querySelectorAll('.sh-lean[data-ready]')].map((f) => {
        const d = f.contentDocument
        return {
          canvases: d.querySelectorAll('canvas').length,
          videos: d.querySelectorAll('video').length,
          svgs: d.querySelectorAll('svg').length,
        }
      })
    `)
    for (const a of audit) {
      expect(a.canvases).toBe(0)
      expect(a.videos).toBe(0)
    }
    // the chart really rendered (as SVG) rather than silently not mounting
    expect(audit.some((a: { svgs: number }) => a.svgs > 0)).toBe(true)
    // the board JSON deliberately stores 640×360 on these nodes: slides are
    // PINNED to the intrinsic on load - a stored size must never clip the root
    const widths = await browser!.eval(tab, `[...document.querySelectorAll('.sh-node')].map((n) => n.offsetWidth)`)
    expect(widths).toEqual([1280, 1280, 1280])
  })

  skippable('a slides board lands in slides mode, steps the frozen (y,x) order, and the stage wears the play contract', async () => {
    const tab = await browser!.tab({ width: 1600, height: 1000 })
    await browser!.go(tab, `${base}/#/b/show`)
    await browser!.until(tab, `!!document.querySelector('.sh-play-nav')`)
    expect(await browser!.eval(tab, `location.hash.includes('slides=1')`)).toBe(true)
    expect(await browser!.eval(tab, POS)).toBe('1/3')
    // the live stage carries the contract attributes the primitives react to
    await browser!.until(tab, `document.querySelector('.sh-play iframe')?.contentDocument?.documentElement?.hasAttribute('data-sl-play')`)
    await browser!.until(tab, `document.querySelector('.sh-play iframe')?.contentDocument?.documentElement?.hasAttribute('data-sl-entered')`)
    // one transform owner, on entry too: the morph-named h1 loses data-animate,
    // while the plain entrance <p> keeps it and lands fully visible
    const doc = `document.querySelector('.sh-play iframe').contentDocument`
    expect(await browser!.eval(tab, `${doc}.querySelector('h1').hasAttribute('data-animate')`)).toBe(false)
    await browser!.until(tab, `${doc}.defaultView.getComputedStyle(${doc}.querySelector('p[data-animate]')).opacity === '1'`)
    // frozen order is (y, x): 01-open → 03-video (same row) → 02-chart (row 2)
    await key('ArrowRight')(tab)
    await browser!.until(tab, `${POS} === '2/3'`)
    expect(await browser!.eval(tab, `location.hash`)).toContain(encodeURIComponent('deck/03-video'))
    // the morphed headline arrived with data-animate stripped BEFORE the new
    // capture - it must be fully visible once the swap settles, never
    // transparent-then-popping (the codex P1: capture-timing regression)
    await browser!.until(tab, `document.querySelector('.sh-play iframe')?.contentDocument?.documentElement?.hasAttribute('data-sl-entered')`)
    expect(await browser!.eval(tab, `${doc}.querySelector('h1').hasAttribute('data-animate')`)).toBe(false)
    await browser!.until(tab, `${doc}.defaultView.getComputedStyle(${doc}.querySelector('h1')).opacity === '1'`)
    await key(' ')(tab)
    await browser!.until(tab, `${POS} === '3/3'`)
    expect(await browser!.eval(tab, `location.hash`)).toContain(encodeURIComponent('deck/02-chart'))
    // no wrap: the deck ends, it does not loop
    await key('ArrowRight')(tab)
    await new Promise((r) => setTimeout(r, 300))
    expect(await browser!.eval(tab, POS)).toBe('3/3')
  })

  skippable('back/forward walks the deck in place, and crossing canvas↔slides re-enters the mode', async () => {
    const tab = await browser!.tab({ width: 1600, height: 1000 })
    // P on a canvas-landing slides board plays it AS slides - the deck is what
    // the board is; `open: canvas` only says where viewers arrive
    await browser!.go(tab, `${base}/#/b/rest`)
    await browser!.until(tab, `!!document.querySelector('.sh-panel')`)
    await key('p')(tab)
    await browser!.until(tab, `!!document.querySelector('.sh-play-nav')`)
    expect(await browser!.eval(tab, `location.hash.includes('slides=1')`)).toBe(true)
    // same-mode back: the MOUNTED stage walks (no remount, position restored)
    await key('ArrowRight')(tab)
    await browser!.until(tab, `${POS} === '2/3'`)
    await browser!.eval(tab, `history.back()`)
    await browser!.until(tab, `${POS} === '1/3'`)
    // cross-mode back: the canvas surface returns; forward re-enters slides
    await browser!.eval(tab, `history.back()`)
    await browser!.until(tab, `!!document.querySelector('.sh-panel') && !document.querySelector('.sh-play')`)
    await browser!.eval(tab, `history.forward()`)
    await browser!.until(tab, `${POS} === '1/3'`)
  })

  skippable('slides wears the FULL prototype chrome: toolbars + walker, no duplicate strip', async () => {
    const tab = await browser!.tab({ width: 1600, height: 1000 })
    await browser!.go(tab, `${base}/#/b/show`)
    await browser!.until(tab, `!!document.querySelector('.sh-play-nav')`)
    // the classic top-right pill (device+theme pickers, .sh-theme wraps both)
    // AND the classic bottom-left walker - slides use the actual play UI;
    // the strip belongs to the minimal trim, the brand pill to the share
    expect(await browser!.eval(tab, `document.querySelectorAll('.sh-play-pill .sh-theme').length`)).toBe(2)
    expect(await browser!.eval(tab, `!!document.querySelector('a[aria-label="Open in app"]')`)).toBe(true)
    expect(await browser!.eval(tab, `!!document.querySelector('.sh-slides-strip')`)).toBe(false)
    expect(await browser!.eval(tab, `!!document.querySelector('.sh-play-brand')`)).toBe(false)  // toolbars name the place
    // the brand pill belongs to the LOCKED deck-only share, where no canvas door exists
    const share = await browser!.tab({ width: 1600, height: 1000 })
    await browser!.go(share, `${base}/#/b/share`)
    await browser!.until(share, `!!document.querySelector('.sh-play-nav')`)
    expect(await browser!.eval(share, `!!document.querySelector('.sh-play-brand')`)).toBe(true)
    // D flips the theme live (the hash follows), digit 5 = fill window
    await key('d')(tab)
    await browser!.until(tab, `location.hash.includes('theme=dark')`)
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '5', code: 'Digit5' }, tab)
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '5', code: 'Digit5' }, tab)
    await browser!.until(tab, `location.hash.includes('device=fill')`)
    const w = await browser!.eval(tab, `document.querySelector('.sh-play .dev iframe')?.getBoundingClientRect().width`)
    expect(w).toBe(1600)
    // THE FIT: in fill, the 1280×720 stage scales up and centers - the slide
    // root's rendered box must span the window's width (1600 = 1280 × 1.25)
    const doc = `document.querySelector('.sh-play iframe').contentDocument`
    await browser!.until(tab, `Math.round(${doc}.querySelector('.sl-root')?.getBoundingClientRect().width ?? 0) === 1600`)
    const box = await browser!.eval(tab, `(() => { const r = ${doc}.querySelector('.sl-root').getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top) } })()`)
    expect(box.l).toBe(0)                                     // width-limited: flush horizontally...
    expect(box.t).toBeGreaterThan(0)                          // ...and centered vertically
  })

  skippable('chrome: "minimal" trims to the strip + comments; the default board is its control', async () => {
    const tab = await browser!.tab({ width: 1600, height: 1000 })
    await browser!.go(tab, `${base}/#/b/trim`)
    await browser!.until(tab, `!!document.querySelector('.sh-slides-strip')`)
    expect(await browser!.eval(tab, `!!document.querySelector('.sh-play-pill .sh-theme')`)).toBe(false)
    expect(await browser!.eval(tab, `!!document.querySelector('.sh-play-nav')`)).toBe(false)
    expect(await browser!.eval(tab, `!!document.querySelector('a[aria-label="Open in app"]')`)).toBe(false)
    expect(await browser!.eval(tab, `!!document.querySelector('.sh-play-brand')`)).toBe(false)
  })

  skippable('slides mode survives a refresh mid-deck via the hash', async () => {
    const tab = await browser!.tab({ width: 1600, height: 1000 })
    await browser!.go(tab, `${base}/#/b/show`)
    await browser!.until(tab, `!!document.querySelector('.sh-play-nav')`)
    await key('ArrowRight')(tab)
    await browser!.until(tab, `${POS} === '2/3'`)
    const href = await browser!.eval(tab, `location.href`)
    await browser!.go(tab, href)
    await browser!.until(tab, `${POS} === '2/3'`)
    expect(await browser!.eval(tab, `location.hash.includes('slides=1')`)).toBe(true)
  })
})
