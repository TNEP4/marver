import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Acceptance 5: a locked-present canvas serves no canvas shell - not hidden,
 * ABSENT. When every published board is locked to a stage mode the build swaps
 * the locked entry in for App.tsx, so the sidebar/canvas/toolbar code never
 * enters the bundle, and the served page boots straight into the locked mode.
 */

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const PORT = 4771
let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-locked-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'locked-fixture', private: true, type: 'module' }))
  symlinkSync(join(import.meta.dirname, '..', 'node_modules'), join(root, 'node_modules'))
  const scenes = join(root, 'design', 'scenes', 'deck')
  mkdirSync(scenes, { recursive: true })
  writeFileSync(join(scenes, 'one.tsx'), `export default function F() { return <div>slide one</div> }\n`)
  writeFileSync(join(scenes, 'two.tsx'), `export default function F() { return <div>slide two</div> }\n`)
  mkdirSync(join(root, 'design', 'boards'), { recursive: true })
  writeFileSync(join(root, 'design', 'boards', 'deck.json'), JSON.stringify({
    version: 1, name: 'deck',
    nodes: [
      { key: 'n1', frame: 'deck/one', x: 0, y: 0, w: 400, h: 300 },
      { key: 'n2', frame: 'deck/two', x: 500, y: 0, w: 400, h: 300 },
    ],
  }))
  writeFileSync(join(root, 'design', 'publish.json'), JSON.stringify({
    version: 2, boards: { deck: { max: 'read', open: 'present', lock: true } },
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

describe('the all-boards-locked bundle', () => {
  it('ships no canvas shell code - the sidebar and canvas surface are absent from the JS', () => {
    const dist = join(root, 'design', '.dist')
    const js = walk(dist).filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('')
    // markers that exist ONLY in the canvas shell (App.tsx / Canvas.tsx JSX)
    expect(js).not.toContain('sh-panel-top')       // the sidebar header
    expect(js).not.toContain('sh-world')           // the canvas world element
    expect(js).not.toContain('Prototype view')     // the canvas toolbar's play affordance
    // and the locked surface IS there
    expect(js).toContain('sh-play')
  })

  it('boots straight into the locked present mode with no door out', async (ctx) => {
    if (!browser) return ctx.skip()
    const tab = await browser.tab({ width: 1280, height: 800 })
    await browser.go(tab, `http://localhost:${PORT}/`)
    await browser.until(tab, `!!document.querySelector('.sh-play')`)
    expect(await browser.eval(tab, `!!document.querySelector('.sh-panel')`)).toBe(false)
    const labels = await browser.eval(tab, `[...document.querySelectorAll('.sh-play-pill button, .sh-play-pill a')].map((b) => b.getAttribute('aria-label') ?? '').join('|')`)
    expect(labels).not.toContain('Open in canvas')
    // Escape stays put - there is nothing to exit into
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }, tab)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' }, tab)
    await new Promise((r) => setTimeout(r, 300))
    expect(await browser.eval(tab, `!!document.querySelector('.sh-play')`)).toBe(true)
  }, 60_000)
})
