import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { Browser } from './browser.ts'
import { makeProject, startDev, stopDev, workspaceOf, type Dev } from './project.ts'

/**
 * Two canvases on one address share no viewer preferences (spec 28 A1.6): project A, then project B
 * on the same port, in the same tab - one origin, one localStorage. Each keeps its notes, its folded
 * folders and its theme under its own workspace key; the bare keys an older canvas wrote are never
 * adopted and never written. Skips without Chrome.
 */

const PORT = 9000 + Math.floor(Math.random() * 300)
const ORIGIN = `http://localhost:${PORT}`

const project = (who: string) => makeProject(`mv-store-${who}-`, {
  'design/scenes/app/home.tsx': `export const meta = { title: 'Home', viewport: 'mobile' }\nexport default () => <main style={{ minHeight: '100vh', background: '#0b5' }}><h1>${who}</h1></main>\n`,
  'design/scenes/app/_note.md': `# App\n\nThe scene, in ${who}.\n`,
  'design/boards/_folders.json': JSON.stringify({ version: 1, folders: [{ name: 'f', order: 1 }] }, null, 2) + '\n',
  'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', auto: false, order: 0, nodes: [{ key: 'm-home', frame: 'app/home', x: 0, y: 0, w: 390, h: 844 }] }, null, 2) + '\n',
  'design/boards/inner.json': JSON.stringify({ version: 1, name: 'inner', auto: false, order: 0, folder: 'f', nodes: [{ key: 'i-home', frame: 'app/home', x: 0, y: 0, w: 390, h: 844 }] }, null, 2) + '\n',
})

let rootA = '', rootB = ''
let dev: Dev | null = null
let browser: Browser | null = null

beforeAll(async () => {
  rootA = project('a')
  rootB = project('b')
  browser = await Browser.launch()
}, 60_000)

afterAll(async () => {
  browser?.close()
  await stopDev(dev, PORT).catch(() => {})
  rmSync(rootA, { recursive: true, force: true })
  rmSync(rootB, { recursive: true, force: true })
})

const SEEDED = { 'mv-notes': '{"all":false,"hidden":[]}', 'mv-folders-closed': '{"f":true}', 'mv-view-theme': 'dark' }
const keys = (b: Browser, s: string): Promise<Record<string, string>> => b.eval(s, `Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('mv-')).map((k) => [k, localStorage.getItem(k)]))`)
async function click(b: Browser, s: string, selector: string) {
  const at = await b.eval(s, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y }, s)
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
}
async function openCanvas(b: Browser, s: string) {
  await b.go(s, `${ORIGIN}/#/b/main`)
  await b.until(s, `document.querySelectorAll('[data-node="m-home"] .sh-notes .sh-sticky').length === 1 && !!document.querySelector('.sh-boards [data-folder-row="f"]')`, 30_000)
  await b.send('Page.bringToFront', {}, s)
}
const notesOff = `document.querySelector('[data-node="m-home"] .sh-notes').classList.contains('off')`
const folderOpen = `document.querySelector('.sh-boards [data-folder-row="f"]').dataset.open === '1'`

describe('viewer preferences, per canvas', () => {
  it('two workspaces on one origin share no notes, folded folders or theme; the bare keys are neither adopted nor written', async (ctx) => {
    if (!browser) return ctx.skip()
    const wsA = workspaceOf(rootA), wsB = workspaceOf(rootB)
    expect(wsA).not.toBe(wsB)
    dev = await startDev(rootA, PORT)
    const s = await browser.tab({ width: 1400, height: 900 })
    // what a 0.26 canvas left on this origin
    await browser.go(s, `${ORIGIN}/__mv/api/hello`)
    await browser.eval(s, `(() => { const seed = ${JSON.stringify(SEEDED)}; for (const k in seed) localStorage.setItem(k, seed[k]); return 1 })()`)

    // ---- A: the old keys are not its own - notes shown, the folder open, the first theme ----------
    await openCanvas(browser, s)
    expect(await browser.eval(s, notesOff)).toBe(false)
    expect(await browser.eval(s, folderOpen)).toBe(true)
    expect(await browser.eval(s, `__mvStore.getState().viewTheme`)).toBe('light')
    await browser.press(s, 'n')
    await browser.until(s, notesOff)
    await click(browser, s, '.sh-boards [data-folder-row="f"]')
    await browser.until(s, `!(${folderOpen})`)
    await browser.eval(s, `__mvStore.getState().setTheme('dark')`)
    await browser.until(s, `!__mvStore.getState().dirty`, 10_000)
    const inA = await keys(browser, s)
    expect(JSON.parse(inA[`mv-notes:${wsA}`]).all).toBe(false)
    expect(JSON.parse(inA[`mv-folders-closed:${wsA}`])).toEqual({ f: true })
    expect(inA[`mv-view-theme:${wsA}`]).toBe('dark')
    for (const [k, v] of Object.entries(SEEDED)) expect(inA[k], k).toBe(v)   // the bare keys: exactly as seeded

    // ---- B on the same address, the same tab: nothing of A's carries over ----------------------------
    await browser.go(s, 'about:blank')
    await stopDev(dev, PORT); dev = null
    dev = await startDev(rootB, PORT)
    await openCanvas(browser, s)
    expect(await browser.eval(s, notesOff)).toBe(false)
    expect(await browser.eval(s, folderOpen)).toBe(true)
    expect(await browser.eval(s, `__mvStore.getState().viewTheme`)).toBe('light')
    expect(Object.keys(await keys(browser, s)).filter((k) => k.endsWith(`:${wsB}`) && !k.startsWith('mv-jam-'))).toEqual([])
    await browser.press(s, 'n')
    await browser.until(s, notesOff)
    const inB = await keys(browser, s)
    expect(JSON.parse(inB[`mv-notes:${wsB}`]).all).toBe(false)
    expect(inB[`mv-notes:${wsA}`]).toBe(inA[`mv-notes:${wsA}`])                       // A's, untouched
    expect(inB[`mv-folders-closed:${wsA}`]).toBe(inA[`mv-folders-closed:${wsA}`])
    expect(inB[`mv-view-theme:${wsA}`]).toBe('dark')
    for (const [k, v] of Object.entries(SEEDED)) expect(inB[k], k).toBe(v)

    // ---- A again: its own choices come back -------------------------------------------------------------
    await browser.go(s, 'about:blank')
    await stopDev(dev, PORT); dev = null
    dev = await startDev(rootA, PORT)
    await openCanvas(browser, s)
    expect(await browser.eval(s, notesOff)).toBe(true)
    expect(await browser.eval(s, folderOpen)).toBe(false)
    expect(await browser.eval(s, `__mvStore.getState().viewTheme`)).toBe('dark')
  }, 180_000)
})
