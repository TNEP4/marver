import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'

/**
 * The camera's variables reach every element that reads them, live (camera-readers.test.ts is the cheap text check).
 * A REAL `marver dev`, a REAL Chrome: one frame selected, working and in interact (its pins, handles, note fold and
 * shimmer), beside it a variant pair in no state at all (badges, a caption, a comment stack - readers no selected
 * frame covers). At three cameras every element that reads a camera variable - matched by a rule of the page's
 * stylesheets that reads one, or reading one in its inline style - computes the camera's value (the content
 * transform's), never its var() default. Play's pins, outside the world, keep 1. Skips without Chrome.
 */

const FRAME = (t: string, extra = '') => `export const meta = { title: '${t}', viewport: 'mobile'${extra} }\nexport default () => <main style={{ padding: 24 }}><h2>${t}</h2></main>\n`
const me = { email: 'nic@example.com', name: 'Nic' }
const thread = (i: number, frame: string) => JSON.stringify({ id: `t-${i}`, ts: 1_700_000_000_000 + i, type: 'create', commentId: `c-${i}`, board: 'main', frame, author: me, agent: true, body: `note ${i}` })

let root = ''
let dev: Dev | null = null
let browser: Browser | null = null

beforeAll(async () => {
  root = fixtureRoot('mv-camera-', {
    'design/scenes/demo/hero/a-one.tsx': FRAME('One'),
    'design/scenes/demo/hero/b-two.tsx': FRAME('Two'),
    'design/scenes/demo/plain.tsx': FRAME('Plain'),
    'design/scenes/demo/plain.note.md': 'Why this frame exists.\n',
    'design/comments/main.jsonl': [thread(1, 'demo/plain'), thread(2, 'demo/plain'), thread(3, 'demo/hero/a-one')].join('\n') + '\n',
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
      { key: 'n-a', frame: 'demo/hero/a-one', x: 0, y: 0, w: 390, h: 600 },
      { key: 'n-b', frame: 'demo/hero/b-two', x: 500, y: 0, w: 390, h: 600 },
      { key: 'n-plain', frame: 'demo/plain', x: 1300, y: 0, w: 390, h: 600 },
    ] }),
  })
  dev = await startDev(root)
  browser = await Browser.launch()
}, 120_000)
afterAll(async () => {
  browser?.close()
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

/** Every live reader of a camera variable whose computed value is not the camera's, and the readers counted. */
const CHECK = `(() => {
  const READS = /var\\(\\s*(--(?:sh-inv|sh-s|sh-tx|sh-ty|grid-size|grid-pos|grid-alpha))\\b/g
  const content = document.querySelector('.sh-content'), canvas = document.querySelector('.sh-canvas')
  const { a: s, e: tx, f: ty } = new DOMMatrix(content ? getComputedStyle(content).transform : 'none')
  const want = { '--sh-s': s, '--sh-inv': 1 / s, '--sh-tx': tx, '--sh-ty': ty }
  const grid = canvas && getComputedStyle(canvas, '::before')
  const reads = [], wrong = [], play = []   // reads: [element, pseudo, variable]
  const parts = (sel) => { const out = []; let d = 0, at = 0; for (let i = 0; i < sel.length; i++) { const c = sel[i]; if (c === '(') d++; else if (c === ')') d--; else if (c === ',' && !d) { out.push(sel.slice(at, i)); at = i + 1 } } return [...out, sel.slice(at)] }
  const walk = (rules) => { for (const r of rules) {
    if (r instanceof CSSStyleRule) {
      const vars = [...r.style.cssText.matchAll(READS)].map((m) => m[1])
      if (vars.length) for (const part of parts(r.selectorText)) {
        const pseudo = /::?(before|after)\\s*$/.exec(part)?.[0].replace(/^:+/, '::') ?? null
        let els = []
        try { els = document.querySelectorAll(part.replace(/::?(before|after)\\s*$/, '') || '*') } catch { wrong.push('unmatched selector ' + part) }
        for (const el of els) for (const v of vars) reads.push([el, pseudo, v])
      }
    }
    if (r.cssRules) walk(r.cssRules)
  } }
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules) } catch { /* a cross-origin sheet: no camera reader of ours */ } }
  for (const el of document.querySelectorAll('[style]')) for (const m of el.getAttribute('style').matchAll(READS)) reads.push([el, null, m[1]])
  let n = 0
  for (const [el, pseudo, v] of reads) {
    const got = getComputedStyle(el, pseudo).getPropertyValue(v).trim()
    const name = el.getAttribute('class') + (pseudo ?? '') + ' ' + v + '=' + JSON.stringify(got)
    if (el.closest('.sh-play')) { if (v === '--sh-inv') play.push(got); continue }
    n++
    const ok = v.startsWith('--grid-') ? got !== '' && got === grid?.getPropertyValue(v).trim() : got !== '' && Math.abs(parseFloat(got) - want[v]) <= 1e-3 * Math.max(1, Math.abs(want[v]))
    if (!ok) wrong.push(name)
  }
  return { n, wrong, play, s, classes: [...new Set(reads.filter(([el]) => !el.closest('.sh-play')).flatMap(([el]) => [...el.classList]))] }
})()`

describe('the camera reaches its readers', () => {
  it('every reader computes the camera, at three cameras, and play keeps 1', async (ctx) => {
    if (!browser) return ctx.skip()
    const s = await browser.tab({ width: 1400, height: 900 })
    const ev = (js: string) => browser!.eval(s, js)
    await browser.go(s, `${dev!.origin}/#/b/main`)
    await browser.until(s, `!!window.__mvStore && __mvStore.getState().nodes.length === 3 && __mvStore.getState().nodes.every((n) => n.status === 'ready')`, 30_000)
    await ev(`__mvStore.getState().select('n-plain'), __mvStore.setState({ working: ['demo/plain'] }), __mvStore.getState().setInteract('n-plain'), 1`)
    await browser.until(s, `document.querySelectorAll('.sh-ctx, .sh-handle, .sh-vbadge, .sh-gcaption, .sh-notes-fold, .cm-pin, .cm-stack, .sh-work-ind, .sh-node.interact').length >= 9`, 15_000)
    const seen = new Set<string>()
    for (const zoom of [0.4, 1.7, 0]) {
      await ev(zoom ? `__mvJamCanvas.zoomTo(${zoom}), 1` : `__mvJamCanvas.fitAll(), 1`)
      await browser.until(s, `!__mvJamCanvas.cameraBusy()`, 5000)
      await new Promise((r) => setTimeout(r, 300))
      const r = await ev(CHECK)
      expect(r.s, 'a camera other than 1, or a default would pass').not.toBeCloseTo(1, 2)
      expect(r.wrong, `scale ${r.s}`).toEqual([])
      for (const c of r.classes) seen.add(c)
    }
    // the fixture showed what it set out to: rule readers in the world and on the grid, inline readers on screen
    for (const c of ['sh-canvas', 'sh-ctx', 'sh-node', 'sh-handle', 'sh-vbadge', 'sh-gcaption', 'sh-notes-fold', 'cm-pin', 'cm-stack', 'sh-work-ind']) expect([...seen], c).toContain(c)

    await browser.go(s, `${dev!.origin}/#/p/main?at=demo/plain`)
    await browser.until(s, `document.querySelectorAll('.sh-play-comments .cm-pin').length === 2`, 30_000)
    const r = await ev(CHECK)
    expect(r.play.length).toBeGreaterThan(0)
    expect(new Set(r.play)).toEqual(new Set(['1']))
    await browser.closeTab(s)
  }, 120_000)
})
