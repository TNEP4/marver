import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * The five view modes and one precedence chain (01-sharing §6.1, acceptance
 * 10/13), proven in a real browser against a real published build.
 *
 * One fixture, four boards:
 *   memo   - type doc                 → lands in Focus at reading width
 *   flow   - type design, 3 frames    → lands on the board surface
 *   forced - type doc, open canvas    → explicit open beats the type default
 *   deck   - open present, lock       → present with no way out
 */

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const PORT = 4763
const base = `http://localhost:${PORT}`

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null

const frame = (body: string, tall = false) =>
  `export default function F() { return <div style={{ padding: 40${tall ? ", height: '300vh'" : ''} }}>${body}</div> }\n`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-modes-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'modes-fixture', private: true, type: 'module' }))
  symlinkSync(join(import.meta.dirname, '..', 'node_modules'), join(root, 'node_modules'))
  const scenes = join(root, 'design', 'scenes')
  mkdirSync(join(scenes, 'memo'), { recursive: true })
  mkdirSync(join(scenes, 'flow'), { recursive: true })
  writeFileSync(join(scenes, 'memo', 'q3-findings.tsx'), frame('the memo', true))
  writeFileSync(join(scenes, 'flow', 'one.tsx'), frame('one'))
  writeFileSync(join(scenes, 'flow', 'two.tsx'), frame('two'))
  writeFileSync(join(scenes, 'flow', 'three.tsx'), frame('three'))
  const boards = join(root, 'design', 'boards')
  mkdirSync(boards, { recursive: true })
  const node = (frame: string, i = 0) => ({ key: `n${i}${frame.replace(/\W/g, '')}`, frame, x: i * 500, y: 0, w: 400, h: 300 })
  writeFileSync(join(boards, 'memo.json'), JSON.stringify({ version: 1, name: 'memo', order: 1, nodes: [node('memo/q3-findings')] }))
  writeFileSync(join(boards, 'flow.json'), JSON.stringify({ version: 1, name: 'flow', order: 2, nodes: ['one', 'two', 'three'].map((n, i) => node(`flow/${n}`, i)) }))
  writeFileSync(join(boards, 'forced.json'), JSON.stringify({ version: 1, name: 'forced', order: 3, nodes: [node('memo/q3-findings')] }))
  writeFileSync(join(boards, 'deck.json'), JSON.stringify({ version: 1, name: 'deck', order: 4, nodes: ['one', 'two'].map((n, i) => node(`flow/${n}`, i)) }))
  writeFileSync(join(root, 'design', 'publish.json'), JSON.stringify({
    version: 2,
    boards: {
      memo: { max: 'comment', type: 'doc' },
      flow: { max: 'comment', type: 'design' },
      forced: { max: 'read', type: 'doc', open: 'canvas' },
      deck: { max: 'read', open: 'present', lock: true },
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

const skippable = (name: string, fn: () => Promise<void>, ms = 60_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)

describe('landing modes + the focus chrome, in a real browser', () => {
  skippable('a doc board lands its viewer in Focus at reading width (acceptance 10)', async () => {
    const tab = await browser!.tab({ width: 1400, height: 900 })
    await browser!.go(tab, `${base}/#/b/memo`)
    await browser!.until(tab, `!!document.querySelector('.sh-play.doc')`)
    // reading width: the stage iframe is capped, not the window's 1400
    const w = await browser!.eval(tab, `document.querySelector('.sh-play .dev iframe')?.getBoundingClientRect().width`)
    expect(w).toBeLessThanOrEqual(860)
    // single frame: no walker, no stepper
    expect(await browser!.eval(tab, `!!document.querySelector('.sh-play-nav')`)).toBe(false)
    // the brand pill names the document
    const title = await browser!.eval(tab, `document.querySelector('.sh-play-title')?.textContent`)
    expect(title?.toLowerCase()).toContain('q3')
  })

  skippable('a frame deep link lands in Focus with no board name and no canvas door (acceptance 10)', async () => {
    const tab = await browser!.tab({ width: 1400, height: 900 })
    await browser!.go(tab, `${base}/#/f/flow/two`)
    await browser!.until(tab, `!!document.querySelector('.sh-play')`)
    const title = await browser!.eval(tab, `document.querySelector('.sh-play-title')?.textContent`)
    expect(title?.toLowerCase()).toContain('two')
    expect(title?.toLowerCase()).not.toContain('flow')
    // no "Open in canvas" door on a deep-link visit - the aria labels tell
    const labels = await browser!.eval(tab, `[...document.querySelectorAll('.sh-play-pill button, .sh-play-pill a')].map((b) => b.getAttribute('aria-label') ?? b.textContent).join('|')`)
    expect(labels).not.toContain('Open in canvas')
  })

  skippable('explicit open beats the type default (acceptance 10)', async () => {
    const tab = await browser!.tab({ width: 1400, height: 900 })
    await browser!.go(tab, `${base}/#/b/forced`)
    // doc type would say focus; open: canvas wins - the canvas shell renders
    await browser!.until(tab, `!!document.querySelector('.sh-panel')`)
    expect(await browser!.eval(tab, `!!document.querySelector('.sh-play')`)).toBe(false)
  })

  skippable('a locked board opens in present with no door, and Escape does not exit', async () => {
    const tab = await browser!.tab({ width: 1400, height: 900 })
    await browser!.go(tab, `${base}/#/b/deck`)
    await browser!.until(tab, `!!document.querySelector('.sh-play')`)
    const labels = await browser!.eval(tab, `[...document.querySelectorAll('.sh-play-pill button, .sh-play-pill a')].map((b) => b.getAttribute('aria-label') ?? '').join('|')`)
    expect(labels).not.toContain('Open in canvas')
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }, tab)
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' }, tab)
    await new Promise((r) => setTimeout(r, 300))
    expect(await browser!.eval(tab, `!!document.querySelector('.sh-play')`)).toBe(true)
  })

  skippable('the design board lands on the board surface, not in a stage mode', async () => {
    const tab = await browser!.tab({ width: 1400, height: 900 })
    await browser!.go(tab, `${base}/#/b/flow`)
    await browser!.until(tab, `!!document.querySelector('.sh-panel')`)
    expect(await browser!.eval(tab, `!!document.querySelector('.sh-play')`)).toBe(false)
  })

  skippable('the chrome holds at 390px - no horizontal scroll (acceptance 13)', async () => {
    const tab = await browser!.tab({ width: 390, height: 844 })
    await browser!.go(tab, `${base}/#/b/memo`)
    await browser!.until(tab, `!!document.querySelector('.sh-play.doc')`)
    const over = await browser!.eval(tab, `document.documentElement.scrollWidth - document.documentElement.clientWidth`)
    expect(over).toBeLessThanOrEqual(0)
  })
})
