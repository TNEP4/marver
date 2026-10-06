import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Board types and status (spec 20), proven where a person sees them: a REAL dev server, a REAL
 * browser, the sidebar's icons and tooltips - and the files changing underneath them. Skips,
 * never fails, without Chrome - the rule of every browser suite here. MARVER_SHOT_DIR=<dir>
 * keeps a screenshot of the sidebar for a human to look at.
 */

const PORT = 6100 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const ORIGIN = `http://localhost:${PORT}`

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let log = ''

const put = (rel: string, body: string | object) => {
  const f = join(root, rel)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}
const board = (name: string, extra: Record<string, unknown> = {}) =>
  put(`design/boards/${name}.json`, { version: 1, name, auto: false, nodes: [{ frame: 'app/home' }], ...extra })
const SHIPPED = (level: string) => `| Capability | Implemented | Available |
|---|---|---|
| \`checkout\` | \`src/checkout.ts\` | production - \`${level}\` - \`CHANGELOG.md:1\` |
`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-status-'))
  put('package.json', { name: 'status-fixture', private: true, type: 'module' })
  put('CHANGELOG.md', '# Changelog\n')
  const repoRoot = join(import.meta.dirname, '..')
  const repoNm = join(repoRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  put('design/scenes/app/home.tsx', `export const meta = { title: 'Home', viewport: 'mobile' }\nexport default () => <main><h1>Home</h1></main>\n`)
  put('design/boards/_folders.json', { version: 1, folders: [
    { name: 'start-here', order: 0, title: 'Start here', type: 'start' },
    { name: 'features', order: 1, type: 'feature' },
    { name: 'decks', order: 2, type: 'deck' },
  ] })
  board('home', { folder: 'start-here', order: 0 })
  board('checkout', { folder: 'features', order: 0 })
  board('refunds', { folder: 'features', order: 1, status: 'blocked', reason: 'waiting on the payment provider' })
  board('pricing', { folder: 'features', order: 2 })
  board('pitch', { folder: 'decks', order: 0 })
  board('scratch', { order: 3 })
  put('context/shipped.md', SHIPPED('reported'))
  put('context/plans/pricing.md', '---\nstate: proposed\ncapability: pricing\n---\n# Pricing v1\n')
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000) {
    if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break
    await new Promise((r) => setTimeout(r, 200))
  }
  browser = await Browser.launch()
}, 120_000)

afterAll(() => {
  browser?.close()
  try { server?.kill('SIGTERM') } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true })
})

const ICONS = `Object.fromEntries(Array.from(document.querySelectorAll('.sh-boards [data-board-row]')).map((el) => [el.dataset.board, {
  type: el.querySelector('[data-type-icon]')?.getAttribute('data-type-icon') ?? null,
  status: el.querySelector('[data-status-icon]')?.getAttribute('data-status-icon') ?? null,
  tip: el.querySelector('.st')?.getAttribute('title') ?? null,
}]))`

async function open(b: Browser): Promise<string> {
  const s = await b.tab({ width: 1400, height: 900 })
  await b.go(s, `${ORIGIN}/`)
  await b.until(s, `document.querySelectorAll('.sh-boards [data-board-row]').length >= 6`, 30_000)
  await b.until(s, `!!document.querySelector('[data-board="checkout"] [data-status-icon]')`, 15_000)
  return s
}

const skippable = (name: string, fn: () => Promise<void>, ms = 60_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)

describe('board types and status in the sidebar (spec 20)', () => {
  skippable('each board wears its type; feature boards wear their status, its evidence in the tooltip', async () => {
    const s = await open(browser!)
    const icons = await browser!.eval(s, ICONS)
    expect(icons.home).toMatchObject({ type: 'start', status: null })
    expect(icons.pitch).toMatchObject({ type: 'deck', status: null })
    expect(icons.scratch).toMatchObject({ type: null, status: null })
    expect(icons.checkout).toMatchObject({ type: 'feature', status: 'done-reported' })
    expect(icons.checkout.tip).toMatch(/^Done, reported\ncontext\/shipped\.md:3: available, `reported` only$/)
    expect(icons.refunds).toMatchObject({ status: 'blocked' })
    expect(icons.refunds.tip).toMatch(/^Blocked\nwaiting on the payment provider/)
    expect(icons.pricing).toMatchObject({ status: 'in-progress' })
    if (process.env.MARVER_SHOT_DIR) {
      const shot = await browser!.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 340, height: 520, scale: 2 } }, s)
      writeFileSync(join(process.env.MARVER_SHOT_DIR, 'sidebar-types-status.png'), Buffer.from(shot.data, 'base64'))
    }
  })

  skippable('the record changes on disk: the status follows without a reload', async () => {
    const s = await open(browser!)
    await browser!.eval(s, `window.__noReload = true`)
    put('context/shipped.md', SHIPPED('confirmed'))
    await browser!.until(s, `document.querySelector('[data-board="checkout"] [data-status-icon]')?.getAttribute('data-status-icon') === 'done'`, 15_000)
    expect(await browser!.eval(s, `window.__noReload === true`)).toBe(true)
    put('context/shipped.md', SHIPPED('reported'))
    await browser!.until(s, `document.querySelector('[data-board="checkout"] [data-status-icon]')?.getAttribute('data-status-icon') === 'done-reported'`, 15_000)
  })

  skippable('a board moved into a typed folder takes the folder\'s type', async () => {
    const s = await open(browser!)
    board('scratch', { folder: 'features', order: 3 })
    await browser!.until(s, `document.querySelector('[data-board="scratch"] [data-type-icon]')?.getAttribute('data-type-icon') === 'feature'`, 15_000)
    expect(await browser!.eval(s, `document.querySelector('[data-board="scratch"] [data-status-icon]')?.getAttribute('data-status-icon')`)).toBe('backlog')
    board('scratch', { order: 3 })
  })
})
