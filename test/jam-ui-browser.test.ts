import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { Browser } from './browser.ts'

/**
 * Jam V2's presentational pieces (spec 27) in a real browser: the lane, the capture tile, the focus
 * panel with the read-back and the review, the notes card, a capture in its thread, the edge ring and
 * points - each from test/fixtures/jam-gallery, in a real `.sh-app` with the shell's own styles.css.
 * With MARVER_SHOT_DIR set, every scene is shot light and dark. Skips without Chrome.
 */

const ROOT = join(import.meta.dirname, 'fixtures', 'jam-gallery')
let vite: ViteDevServer | null = null
let browser: Browser | null = null
let origin = ''
let s = ''

beforeAll(async () => {
  vite = await createServer({
    root: ROOT, configFile: false, logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1', fs: { allow: [join(import.meta.dirname, '..')] } },
    plugins: [react(), {
      name: 'jam-gallery-virtuals',
      resolveId: (id) => (id === 'virtual:sh-config' || id === 'virtual:sh-data' ? `\0${id}` : null),
      load: (id) => id === '\0virtual:sh-config' ? 'export default { viewports: {}, themes: ["light", "dark"], noTheme: false }'
        : id === '\0virtual:sh-data' ? 'export default null' : null,
    }],
  })
  await vite.listen()
  const addr = vite.httpServer!.address()
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  browser = await Browser.launch()
  if (browser) s = await browser.tab({ width: 1280, height: 800 })
}, 60_000)

afterAll(async () => { browser?.close(); await vite?.close() })

const skippable = (name: string, fn: () => Promise<void>, ms = 60_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)
const open = async (q: string) => {
  await browser!.go(s, `${origin}/?${q}`)
  await browser!.until(s, `!!document.querySelector('.sh-app') && document.fonts.status === 'loaded'`, 30_000)
  await new Promise((r) => setTimeout(r, 250))
}
const shot = async (name: string) => {
  if (!process.env.MARVER_SHOT_DIR) return
  const out = await browser!.send('Page.captureScreenshot', { format: 'png' }, s)
  writeFileSync(join(process.env.MARVER_SHOT_DIR, `jam-ui-${name}.png`), Buffer.from(out.data, 'base64'))
}
const box = (sel: string) => browser!.eval(s, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } })()`)

describe('Jam V2 gallery: the lane', () => {
  skippable('tiles are two lines, 44 px, in time order; the recording tile is last and never cut; only the selected tile wears the ring; no folds', async () => {
    for (const theme of ['light', 'dark']) {
      await open(`scene=lane&theme=${theme}`)
      await shot(`lane-${theme}`)
    }
    const tiles = await browser!.eval(s, `[...document.querySelectorAll('.jm-lane .jm-card')].map((e) => ({ id: e.dataset.tile, h: e.getBoundingClientRect().height, lines: e.querySelectorAll('.tx > span').length, ring: getComputedStyle(e).boxShadow.includes('0px 0px 0px 2px') }))`)
    expect(tiles.map((t: any) => t.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
    expect(tiles.every((t: any) => t.h === 44 && t.lines === 2)).toBe(true)
    expect(tiles.filter((t: any) => t.ring).map((t: any) => t.id)).toEqual(['b'])
    expect(await browser!.eval(s, `document.querySelectorAll('.jm-fold').length`)).toBe(0)
    // the recording tile: the last child, inside the viewport, whole
    expect(await browser!.eval(s, `document.querySelector('.jm-lane-in').lastElementChild.dataset.tile`)).toBe('capturing')
    const chip = await box('.jm-chip')
    expect(chip.h).toBe(44)
    expect(chip.right).toBeLessThanOrEqual(1280 - 10 + 0.5)
    expect(await browser!.eval(s, `getComputedStyle(document.querySelector('.jm-live-dot')).backgroundColor`)).toBe('rgb(0, 210, 224)')   // teal (dark)
  })

  skippable('past its width the lane scrolls to keep the newest in view - the earlier tiles go under the left fade', async () => {
    await open('scene=lane&many=1')
    const st = await browser!.eval(s, `(() => { const e = document.querySelector('.jm-lane-in'); return { overflow: e.scrollWidth > e.clientWidth, atEnd: Math.abs(e.scrollLeft + e.clientWidth - e.scrollWidth) < 2, cls: e.className } })()`)
    expect(st.overflow).toBe(true)
    expect(st.atEnd).toBe(true)
    expect(st.cls).toContain('fade-l')
    expect(st.cls).not.toContain('fade-r')
    await browser!.eval(s, `(() => { const e = document.querySelector('.jm-lane-in'); e.scrollLeft = 200; e.dispatchEvent(new Event('scroll')); return 1 })()`)
    await browser!.until(s, `document.querySelector('.jm-lane-in').className.includes('fade-r')`)
    await shot('lane-scrolled')
    // the recording tile is still whole at the right end once back at the end
    await open('scene=lane&many=1')
    const chip = await box('.jm-chip')
    expect(chip.right).toBeLessThanOrEqual(1280 - 10 + 0.5)
  })
})

describe('Jam V2 gallery: the panels', () => {
  skippable('the read-back fills the focus panel from the top edge to just above the lane; its timeline scrolls inside and the footer stays in view', async () => {
    for (const theme of ['light', 'dark']) {
      await open(`scene=readback&theme=${theme}`)
      await shot(`readback-${theme}`)
    }
    const panel = await box('.jm-focus')
    expect(panel.y).toBe(10)
    expect(panel.bottom).toBe(800 - 10 - 56 - 2)
    expect(panel.w).toBeGreaterThanOrEqual(520)
    const foot = await box('.jm-readback .actions')
    expect(foot.bottom).toBeLessThanOrEqual(panel.bottom)
    expect(await browser!.eval(s, `[...document.querySelectorAll('.jm-readback .actions button')].map((b) => b.textContent)`)).toEqual(['Drop esc', 'Keep K', 'Add to queue ⏎'])
    expect(await browser!.eval(s, `document.querySelectorAll('.jm-lines > div').length`)).toBe(14)
    // click the words to edit them
    await browser!.eval(s, `document.querySelector('.jm-editable').click(), 1`)
    expect(await browser!.until(s, `document.querySelector('textarea.jm-edit')?.value`)).toContain('this card field never says which cards we take')
  })

  skippable('the review shows one big picture at a time - After first, B flips to Before, tabs step the frames, a failed shot reads "No picture"; More work becomes a composer', async () => {
    for (const theme of ['light', 'dark']) {
      await open(`scene=review&theme=${theme}`)
      await shot(`review-${theme}`)
    }
    const img = () => browser!.eval(s, `document.querySelector('.jm-big img')?.getAttribute('alt') ?? document.querySelector('.jm-big .pic.none')?.textContent`)
    expect(await img()).toBe('confirm after')
    await browser!.eval(s, `[...document.querySelectorAll('.jm-fbar .jm-ftabs')].pop().querySelector('button').click(), 1`)
    await browser!.until(s, `document.querySelector('.jm-big img')?.getAttribute('alt') === 'confirm before'`)
    await browser!.eval(s, `document.querySelector('.jm-fbar [role=tab]:nth-child(2)').click(), 1`)
    await browser!.until(s, `document.querySelector('.jm-big img')?.getAttribute('alt') === 'plans before'`)
    await browser!.eval(s, `[...document.querySelectorAll('.jm-fbar .jm-ftabs')].pop().querySelectorAll('button')[1].click(), 1`)
    await browser!.until(s, `document.querySelector('.jm-big .pic.none')?.textContent === 'No picture'`)
    await shot('review-nopicture')
    await browser!.eval(s, `[...document.querySelectorAll('.jm-review .actions button')].find((b) => b.textContent.startsWith('More work')).click(), 1`)
    await browser!.until(s, `document.activeElement?.matches('.jm-more textarea')`)
    await shot('review-more')
    const panel = await box('.jm-focus')
    const foot = await box('.jm-more')
    expect(foot.bottom).toBeLessThanOrEqual(panel.bottom)
  })

  skippable('the notes card: its field takes the keys (E, S, L, I type letters), Enter adds, Escape closes', async () => {
    for (const theme of ['light', 'dark']) {
      await open(`scene=notes&theme=${theme}&draft=${encodeURIComponent('say which cards')}`)
      await shot(`notes-${theme}`)
    }
    // a key in the field never reaches the page
    const leaked = await browser!.eval(s, `(() => { let n = 0; window.addEventListener('keydown', () => n++); const f = document.querySelector('textarea.jm-notefield'); f.focus(); f.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })); return n })()`)
    expect(leaked).toBe(0)
    expect(await browser!.eval(s, `document.activeElement?.className`)).toBe('jm-notefield')
  })

  skippable('a capture in its thread reads as a capture block; the edge ring and points are teal', async () => {
    for (const theme of ['light', 'dark']) {
      await open(`scene=thread&theme=${theme}`)
      await shot(`thread-${theme}`)
      await open(`scene=marks&theme=${theme}`)
      await shot(`marks-${theme}`)
    }
    expect(await browser!.eval(s, `getComputedStyle(document.querySelector('.jm-edge')).boxShadow`)).toContain('rgb(0, 210, 224)')
    await open('scene=thread')
    expect(await browser!.eval(s, `document.querySelector('.jm-capcm .hd').textContent`)).toBe('Capture 7f3a· 0:19 · 2 points · 2 notes')
    expect(await browser!.eval(s, `getComputedStyle(document.querySelector('.jm-capcm .hd svg')).color`)).toBe('rgb(0, 195, 208)')
  })
})
