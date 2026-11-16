import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { makeProject, startDev, stopDev, type Dev } from './project.ts'

/**
 * A frame document holds React's element stacks while the frame's modules load (inplace.ts holdElementStacks, item 9):
 * the elements a module makes as it loads - an icon library's hoisted glyphs - share React's unknown-owner stack, and
 * the elements a render makes get their own stack: the first render and every later one, whether the load took less
 * than React's one-second reset or more, and through updates applied in place (never held). Skips without Chrome.
 */

const PORT = 9300 + Math.floor(Math.random() * 300)
const ORIGIN = `http://localhost:${PORT}`

// what React prints, kept for the report: the warning about an element made at module scope
const CAPTURE = `const __mvOrig = console.error; (globalThis as any).__mvErrors = []; console.error = (...a: unknown[]) => { (globalThis as any).__mvErrors.push(a.map(String).join(' | ')); __mvOrig(...a) }\n`
// a frame whose render can be asked again (__mvBump): each render's two elements are kept
const scene = (glyphs: string) => `import { useState } from 'react'\nimport { glyphs } from '../../components/${glyphs}.tsx'\nexport const meta = { title: 'Home', viewport: 'mobile' }\nexport default function Home() {\n  const [n, setN] = useState(0)\n  ;(globalThis as any).__mvBump = () => setN((x) => x + 1)\n  const a = <b>one {n}</b>, b = <b>two</b>\n  ;(globalThis as any).__mvRendered = { n, els: [a, b] }\n  return <main>{glyphs.slice(0, 3)}{a}{b}</main>\n}\n`
// an app component updated in place by Fast Refresh. It renders every 20 ms (until __mvNoTick) and keeps each render's
// element; version 2 takes 400 ms to load (renders go on meanwhile) and its dispose throws when version 3 replaces it
const appGlyphs = (v: number) => `${v === 2 ? 'await new Promise((r) => setTimeout(r, 400))\n' : ''}import * as React from 'react'
import { useEffect, useState } from 'react'
;(globalThis as any).__mvReact = React
const glyphs = [<i key="a" />, <i key="b" />, <i key="c" />]
${v === 2 ? `;(globalThis as any).__mvV2Loaded = performance.now()\nif (import.meta.hot) import.meta.hot.dispose(() => { ;(globalThis as any).__mvDisposed = performance.now(); throw new Error('a dispose that throws') })\n` : ''}export function Glyphs() {
  const [n, setN] = useState(0)
  useEffect(() => { const t = setInterval(() => { if (!(globalThis as any).__mvNoTick) setN((x) => x + 1) }, 20); return () => clearInterval(t) }, [])
  ;(globalThis as any).__mvBumpHot = () => setN((x) => x + 1)
  const r = <b>v${v}</b>, q = <b>{n}</b>
  ;((globalThis as any).__mvTicks ??= []).push({ v: ${v}, at: performance.now(), els: [r, q] })
  ;(globalThis as any).__mvHot = { v: ${v}, glyphs }
  return <>{glyphs}{r}{q}</>
}
`

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
    'src/Glyphs.tsx': appGlyphs(1),
    'design/scenes/app/hot.tsx': `import { Glyphs } from '../../../src/Glyphs.tsx'\nexport default function Hot() { return <main><Glyphs /></main> }\n`,
    // a module-scope list without keys, rendered: React's key warning
    'design/components/unkeyed.tsx': `export const items = [<i>one</i>, <i>two</i>]\n`,
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

/** the glyphs share one stack; the last render's elements each have their own, made in Home */
const read = `(() => {
  const g = globalThis.__mvGlyphs, d = globalThis.__mvRendered.els
  return {
    dev: g[0]._debugStack !== undefined,
    glyphsShare: g[0]._debugStack === g[1]._debugStack && g[1]._debugStack === g[2]._debugStack && g[0]._debugTask === g[1]._debugTask,
    renderedOwn: d[0]._debugStack instanceof Error && d[0]._debugStack !== d[1]._debugStack && d[0]._debugStack !== g[0]._debugStack && /Home/.test(d[0]._debugStack.stack),
    n: globalThis.__mvRendered.n,
    loadMs: Math.round(performance.now()),
  }
})()`

describe('element stacks in a frame document', () => {
  for (const [frame, what] of [['few', 'a few elements'], ['many', '12,000 elements, inside a second'], ['slow', '12,000 elements, past React\'s one-second reset']] as const) {
    it(`elements made as the frame loads share one stack; a render's have their own, the first and a later one: ${what}`, async (ctx) => {
      if (!browser) return ctx.skip()
      const s = await browser.tab({ width: 800, height: 900 })
      await browser.go(s, `${ORIGIN}/__mv/frame/?id=app/${frame}&theme=light`)
      await browser.until(s, `!!globalThis.__mvRendered && !!document.querySelector('main b')`, 30_000)
      const first = await browser.eval(s, read)
      expect(first.dev).toBe(true)
      expect(first.glyphsShare).toBe(true)
      expect(first.renderedOwn).toBe(true)
      if (frame === 'many') expect(first.loadMs).toBeLessThan(1000)   // the budget a heavy load used to spend: no reset yet
      if (frame === 'slow') expect(first.loadMs).toBeGreaterThan(1000)
      // a render after boot, right away
      await browser.eval(s, `(globalThis.__mvBump(), 1)`)
      await browser.until(s, `globalThis.__mvRendered.n === 1`, 10_000)
      expect((await browser.eval(s, read)).renderedOwn).toBe(true)
      await browser.closeTab(s)
    }, 60_000)
  }

  it('through updates applied in place, a render\'s elements keep their own stacks, and the count is never left spent - also when a dispose throws', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await browser.tab({ width: 800, height: 900 })
    await browser.go(s, `${ORIGIN}/__mv/frame/?id=app/hot&theme=light`)
    await browser.until(s, `globalThis.__mvHot?.v === 1 && (globalThis.__mvTicks?.length ?? 0) > 5`, 30_000)
    const boot = await browser.eval(s, `window.__mvBoot`)
    const t0 = await browser.eval(s, `performance.now()`)
    // version 2 loads for 400 ms while version 1 goes on rendering
    writeFileSync(join(root, 'src/Glyphs.tsx'), appGlyphs(2))
    await browser.until(s, `globalThis.__mvHot?.v === 2 && !!globalThis.__mvV2Loaded`, 30_000)
    expect(await browser.eval(s, `window.__mvBoot`)).toBe(boot)   // in place: the same document
    const during = await browser.eval(s, `(() => {
      const ticks = globalThis.__mvTicks.filter((t) => t.at > ${t0} && t.at < globalThis.__mvV2Loaded)
      const stacks = ticks.flatMap((t) => t.els.map((e) => e._debugStack))
      return { n: ticks.length, own: stacks.every((x) => x instanceof Error && /Glyphs/.test(x.stack)), distinct: new Set(stacks).size === stacks.length }
    })()`)
    expect(during.n).toBeGreaterThan(5)
    expect(during.own).toBe(true)
    expect(during.distinct).toBe(true)
    // the first render Fast Refresh made of version 2
    await browser.until(s, `globalThis.__mvTicks.some((t) => t.v === 2)`, 10_000)
    const refreshed = await browser.eval(s, `(() => { const e = globalThis.__mvTicks.find((t) => t.v === 2).els; return e[0]._debugStack instanceof Error && e[0]._debugStack !== e[1]._debugStack && e[0]._debugStack !== globalThis.__mvHot.glyphs[0]._debugStack && /Glyphs/.test(e[0]._debugStack.stack) })()`)
    expect(refreshed).toBe(true)
    // version 3: version 2's dispose throws, and Vite sends no vite:afterUpdate. Nothing renders meanwhile
    await browser.eval(s, `(globalThis.__mvNoTick = true, 1)`)
    const ticksBefore = await browser.eval(s, `globalThis.__mvTicks.length`)
    writeFileSync(join(root, 'src/Glyphs.tsx'), appGlyphs(3))
    // version 3 arrived: version 2's dispose ran (and threw) - fails the test if it never does
    await browser.until(s, `!!globalThis.__mvDisposed`, 20_000)
    await new Promise((r) => setTimeout(r, 300))   // what Vite does after the throw, settled
    const count = await browser.eval(s, `globalThis.__mvReact.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.recentlyCreatedOwnerStacks`)
    expect(count).toBeLessThan(10_000)
    // and the next render's elements have stacks of their own
    await browser.eval(s, `(globalThis.__mvBumpHot(), 1)`)
    await browser.until(s, `globalThis.__mvTicks.length > ${ticksBefore}`, 10_000)
    const last = await browser.eval(s, `(() => { const e = globalThis.__mvTicks.at(-1).els; return e[0]._debugStack instanceof Error && e[0]._debugStack !== e[1]._debugStack && /Glyphs/.test(e[0]._debugStack.stack) })()`)
    expect(last).toBe(true)
    await browser.closeTab(s)
  }, 90_000)

  it('a warning about an element made at module scope still names its render', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await browser.tab({ width: 800, height: 900 })
    await browser.go(s, `${ORIGIN}/__mv/frame/?id=app/keys&theme=light`)
    await browser.until(s, `!!document.querySelector('main i')`, 30_000)
    const errors: string[] = await browser.until(s, `globalThis.__mvErrors.length ? globalThis.__mvErrors : null`, 10_000)
    console.log('[element-stacks] the key warning:\n' + errors.join('\n'))
    expect(errors.some((e) => /unique "key" prop/.test(e) && /Check the render method of `Keys`/.test(e))).toBe(true)
    await browser.closeTab(s)
  }, 60_000)
})
