import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { makeProject, startDev, stopDev, type Dev } from './project.ts'

/**
 * A frame document holds React's element stacks while the frame's modules load (inplace.ts holdElementStacks, item 9): the
 * elements a module makes as it loads - an icon library's hoisted glyphs - share React's unknown-owner stack, and the
 * elements a render makes get their own stack, whether the load took less than React's one-second reset or more.
 * Skips without Chrome.
 */

const PORT = 9300 + Math.floor(Math.random() * 300)
const ORIGIN = `http://localhost:${PORT}`

// what React prints, kept for the report: the warning about an element made at module scope
const CAPTURE = `const __mvOrig = console.error; (globalThis as any).__mvErrors = []; console.error = (...a: unknown[]) => { (globalThis as any).__mvErrors.push(a.map(String).join(' | ')); __mvOrig(...a) }\n`
const scene = (glyphs: string, extra = '') => `import { glyphs } from '../../components/${glyphs}.tsx'\n${extra}export const meta = { title: 'Home', viewport: 'mobile' }\nexport default function Home() {\n  const a = <b>one</b>, b = <b>two</b>\n  ;(globalThis as any).__mvRendered = [a, b]\n  return <main>{glyphs.slice(0, 3)}{a}{b}</main>\n}\n`

const appGlyphs = (v: number) => `const glyphs = [<i key="a" />, <i key="b" />, <i key="c" />]\nexport function Glyphs() {\n  const r = <b>v${v}</b>, q = <b>w</b>\n  ;(globalThis as any).__mvHot = { v: ${v}, glyphs, rendered: [r, q] }\n  return <>{glyphs}{r}{q}</>\n}\n`

let root = ''
let dev: Dev | null = null
let browser: Browser | null = null

beforeAll(async () => {
  root = makeProject('mv-stacks-', {
    // shared modules making elements at load, as an icon barrel does: a few, and more than React's whole budget (10,000)
    'design/components/few.tsx': `export const glyphs = [<i key="a" />, <i key="b" />, <i key="c" />];\n;(globalThis as any).__mvGlyphs = glyphs\n`,
    'design/components/many.tsx': `export const glyphs = Array.from({ length: 12_000 }, (_, i) => <i key={i} />);\n;(globalThis as any).__mvGlyphs = glyphs\n`,
    'design/components/slow.tsx': `await new Promise((r) => setTimeout(r, 1300))\nexport const glyphs = Array.from({ length: 12_000 }, (_, i) => <i key={i} />);\n;(globalThis as any).__mvGlyphs = glyphs\n`,
    'design/scenes/app/few.tsx': scene('few'),
    'design/scenes/app/many.tsx': scene('many'),
    'design/scenes/app/slow.tsx': scene('slow'),
    // a module-scope list without keys, rendered: React's key warning
    'design/components/unkeyed.tsx': `export const items = [<i>one</i>, <i>two</i>]\n`,
    // an app component, updated in place by Fast Refresh: its module makes elements as it loads, its render makes one
    'src/Glyphs.tsx': appGlyphs(1),
    'design/scenes/app/hot.tsx': `import { Glyphs } from '../../../src/Glyphs.tsx'\nexport default function Hot() { return <main><Glyphs /></main> }\n`,
    'design/scenes/app/keys.tsx': `${CAPTURE}import { items } from '../../components/unkeyed.tsx'\nexport default function Keys() { return <main>{items}</main> }\n`,
  })
  browser = await Browser.launch()
  dev = await startDev(root, PORT)
}, 90_000)

afterAll(async () => {
  browser?.close()
  await stopDev(dev, PORT).catch(() => {})
  rmSync(root, { recursive: true, force: true })
})

const read = `(() => {
  const g = globalThis.__mvGlyphs, d = globalThis.__mvRendered
  return {
    dev: g[0]._debugStack !== undefined,
    glyphsShare: g[0]._debugStack === g[1]._debugStack && g[1]._debugStack === g[2]._debugStack && g[0]._debugTask === g[1]._debugTask,
    renderedOwn: d[0]._debugStack instanceof Error && d[0]._debugStack !== d[1]._debugStack && d[0]._debugStack !== g[0]._debugStack,
    loadMs: Math.round(performance.now()),
  }
})()`

describe('element stacks in a frame document', () => {
  for (const [frame, what] of [['few', 'a few elements'], ['many', '12,000 elements, inside a second'], ['slow', '12,000 elements, past React\'s one-second reset']] as const) {
    it(`elements made as the frame loads share one stack, a render's have their own: ${what}`, async (ctx) => {
      if (!browser) return ctx.skip()
      const s = await browser.tab({ width: 800, height: 900 })
      await browser.go(s, `${ORIGIN}/__mv/frame/?id=app/${frame}&theme=light`)
      await browser.until(s, `!!globalThis.__mvRendered && !!document.querySelector('main b')`, 30_000)
      const r = await browser.eval(s, read)
      expect(r.dev).toBe(true)
      expect(r.glyphsShare).toBe(true)
      expect(r.renderedOwn).toBe(true)
      if (frame === 'slow') expect(r.loadMs).toBeGreaterThan(1000)
      await browser.closeTab(s)
    }, 60_000)
  }

  it('an update applied in place: the module\'s elements share one stack, the refresh render\'s have their own', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await browser.tab({ width: 800, height: 900 })
    await browser.go(s, `${ORIGIN}/__mv/frame/?id=app/hot&theme=light`)
    await browser.until(s, `globalThis.__mvHot?.v === 1 && !!document.querySelector('main b')`, 30_000)
    const boot = await browser.eval(s, `window.__mvBoot`)
    writeFileSync(join(root, 'src/Glyphs.tsx'), appGlyphs(2))
    await browser.until(s, `globalThis.__mvHot?.v === 2 && document.querySelector('main b')?.textContent === 'v2'`, 30_000)
    expect(await browser.eval(s, `window.__mvBoot`)).toBe(boot)   // in place: the same document
    const r = await browser.eval(s, `(() => { const h = globalThis.__mvHot, g = h.glyphs, d = h.rendered
      return { share: g[0]._debugStack === g[1]._debugStack && g[0]._debugTask === g[2]._debugTask, own: d[0]._debugStack instanceof Error && d[0]._debugStack !== d[1]._debugStack && d[0]._debugStack !== g[0]._debugStack } })()`)
    expect(r.share).toBe(true)
    expect(r.own).toBe(true)
    await browser.closeTab(s)
  }, 60_000)

  it('a warning about an element made at module scope still names its render', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await browser.tab({ width: 800, height: 900 })
    await browser.go(s, `${ORIGIN}/__mv/frame/?id=app/keys&theme=light`)
    await browser.until(s, `!!document.querySelector('main i')`, 30_000)
    const errors: string[] = await browser.until(s, `globalThis.__mvErrors.length ? globalThis.__mvErrors : null`, 10_000)
    console.log('[element-stacks] the key warning:\n' + errors.join('\n'))
    expect(errors.some((e) => /unique "key" prop/.test(e))).toBe(true)
    await browser.closeTab(s)
  }, 60_000)
})
