import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  // a start board's frame renders context/INDEX.md - the file any edit to context/ may touch
  put('context/INDEX.md', '---\naudience: team\n---\n\n# The index\n\nFirst version.\n')
  put('design/scenes/front/index.tsx', `import text from '../../../context/INDEX.md?raw'\nexport const meta = { title: 'Index' }\nexport default () => <main><pre id="idx">{text}</pre></main>\n`)
  board('front', { order: 4, nodes: [{ frame: 'front/index' }] })
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

afterAll(async () => {
  browser?.close()
  // the dev server may still be writing (a manifest regen) as it dies: wait for it to exit, and let
  // the delete retry - a fixture removed mid-write fails with ENOTEMPTY on a loaded machine
  if (server && server.exitCode === null) {
    const gone = new Promise((r) => server!.once('exit', r))
    try { server.kill('SIGTERM') } catch { /* gone */ }
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))])
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

  skippable('a person sets a status from the board\'s menu: the picker writes the file, the icon follows; Done is never offered', async () => {
    const s = await open(browser!)
    const readBoard = (n: string) => JSON.parse(readFileSync(join(root, 'design', 'boards', `${n}.json`), 'utf8'))
    const icon = (n: string) => browser!.eval(s, `document.querySelector('[data-board="${n}"] [data-status-icon]')?.getAttribute('data-status-icon')`)
    const rightClick = async (n: string) => {
      const c = await browser!.eval(s, `(() => { const el = document.querySelector('.sh-boards [data-board-row][data-board="${n}"]'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
      await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'right', buttons: 2, clickCount: 1 }, s)
      await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'right', buttons: 0, clickCount: 1 }, s)
      await browser!.until(s, `!!document.querySelector('.sh-ctxmenu')`)
    }
    const menu = () => browser!.eval(s, `Array.from(document.querySelectorAll('.sh-ctxmenu button')).map((b) => b.textContent).join('|')`)
    const openPicker = async (n: string) => {
      await rightClick(n)
      await browser!.eval(s, `Array.from(document.querySelectorAll('.sh-ctxmenu button')).find((b) => b.textContent === 'Change status…').click()`)
      await browser!.until(s, `!!document.querySelector('[data-status-picker="list"]')`)
    }
    const options = () => browser!.eval(s, `Array.from(document.querySelectorAll('[data-status-option]')).map((b) => b.dataset.statusOption).join()`)
    const key = async (k: string, text?: string) => {
      const code = k === 'Enter' ? 13 : k === 'Escape' ? 27 : k.charCodeAt(0)
      await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, ...(text ? { text } : {}), windowsVirtualKeyCode: code }, s)
      await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: code }, s)
    }

    // checkout's Done, reported is the evidence's: the picker shows it read-only, offers the decisions only
    await openPicker('checkout')
    expect(await options()).toBe('blocked,paused,archived')
    expect(await browser!.eval(s, `document.querySelector('.sp-now')?.textContent`)).toMatch(/^Done, reportedshipped\.md:3$/)
    await key('2', '2')                                                                         // 2 = Paused
    await browser!.until(s, `document.querySelector('[data-board="checkout"] [data-status-icon]')?.getAttribute('data-status-icon') === 'paused'`, 15_000)
    expect(readBoard('checkout')).toMatchObject({ status: 'paused', folder: 'features', order: 0, nodes: [{ frame: 'app/home' }] })

    // Blocked asks why before it writes; the reason reaches the tooltip
    await openPicker('checkout')
    expect(await options()).toBe('blocked,paused,archived,clear')                              // a decision can be undone
    await key('1', '1')
    await browser!.until(s, `!!document.querySelector('[data-status-picker="reason"]')`)
    await browser!.send('Input.insertText', { text: 'waiting on legal' }, s)
    await key('Enter')
    await browser!.until(s, `document.querySelector('[data-board="checkout"] [data-status-icon]')?.getAttribute('data-status-icon') === 'blocked'`, 15_000)
    expect(readBoard('checkout')).toMatchObject({ status: 'blocked', reason: 'waiting on legal' })
    await browser!.until(s, `/waiting on legal/.test(document.querySelector('[data-board="checkout"] .st')?.getAttribute('title') ?? '')`, 15_000)

    // Back to the evidence: the decision leaves the file, the record decides again
    await openPicker('checkout')
    await browser!.eval(s, `document.querySelector('[data-status-option="clear"]').click()`)
    await browser!.until(s, `document.querySelector('[data-board="checkout"] [data-status-icon]')?.getAttribute('data-status-icon') === 'done-reported'`, 15_000)
    expect(readBoard('checkout').status).toBeUndefined()
    expect(readBoard('checkout').reason).toBeUndefined()
    expect(await icon('checkout')).toBe('done-reported')

    // a board without a status - a deck, an untyped board - offers no picker
    for (const n of ['pitch', 'scratch']) {
      await rightClick(n)
      expect(await menu()).not.toMatch(/Change status/)
      await key('Escape')
      await browser!.until(s, `!document.querySelector('.sh-ctxmenu')`)
    }
    board('checkout', { folder: 'features', order: 0 })
  })

  skippable('the open board changed on disk under it: a status and a rename still land, and keep the agent\'s edit', async () => {
    const s = await browser!.tab({ width: 1400, height: 900 })
    await browser!.go(s, `${ORIGIN}/#/b/pricing`)
    await browser!.until(s, `window.__mvStore?.getState().board === 'pricing' && !!window.__mvStore.getState().boardHash`, 30_000)
    // an agent rewrites the open board; the canvas has not reloaded it, so its hash is behind
    board('pricing', { folder: 'features', order: 2, description: 'written by an agent' })
    const r = await browser!.eval(s, `window.__mvStore.getState().setBoardStatus('pricing', 'paused')`)
    expect(r).toEqual({ ok: true })
    const after = JSON.parse(readFileSync(join(root, 'design', 'boards', 'pricing.json'), 'utf8'))
    expect(after).toMatchObject({ status: 'paused', description: 'written by an agent' })
    board('pricing', { folder: 'features', order: 2, description: 'and again' })
    expect(await browser!.eval(s, `window.__mvStore.getState().renameBoard('pricing', 'Pricing v1')`)).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(join(root, 'design', 'boards', 'pricing.json'), 'utf8'))).toMatchObject({ title: 'Pricing v1', description: 'and again' })
    board('pricing', { folder: 'features', order: 2 })
  })

  skippable('that reload never lands over an edit, a drag or a board switch made while the request was out', async () => {
    const s = await browser!.tab({ width: 1400, height: 900 })
    await browser!.go(s, `${ORIGIN}/#/b/pricing`)
    await browser!.until(s, `window.__mvStore?.getState().board === 'pricing' && !!window.__mvStore.getState().boardHash`, 30_000)
    // every status write waits 400 ms on its way out, so something can happen meanwhile
    await browser!.eval(s, `(() => { const f = window.fetch; window.fetch = async (u, i) => { if (/boards\\/status$/.test(String(u))) await new Promise((r) => setTimeout(r, 400)); return f(u, i) } })()`)
    for (const race of ['edit', 'drag', 'switch']) {
      await browser!.eval(s, `window.__mvStore.getState().switchBoard('pricing')`)
      await browser!.until(s, `window.__mvStore.getState().board === 'pricing' && !!window.__mvStore.getState().boardHash && !window.__mvStore.getState().dirty`, 15_000)
      board('pricing', { folder: 'features', order: 2, description: `the agent, before the ${race}` })   // the store's hash is now behind
      const r = await browser!.eval(s, `(async () => {
        const st = window.__mvStore
        const p = st.getState().setBoardStatus('pricing', 'paused')
        await new Promise((r) => setTimeout(r, 150))
        let moved = null
        if (${JSON.stringify(race)} === 'edit') { const s0 = st.getState(); const n = s0.nodes[0]; moved = n.x + 120; s0.moveSelectedBy(120, 80, { [n.key]: { x: n.x, y: n.y } }) }
        if (${JSON.stringify(race)} === 'drag') st.getState().setGesture(true)
        if (${JSON.stringify(race)} === 'switch') await st.getState().switchBoard('checkout')
        const out = await p
        const now = st.getState()
        const res = { out, board: now.board, x: now.nodes[0]?.x, moved }
        if (${JSON.stringify(race)} === 'drag') st.getState().setGesture(false)
        return res
      })()`)
      // the reload was not this write's to do: it reports the conflict instead of erasing anything
      expect(r.out).toMatchObject({ ok: false, stale: true })
      if (race === 'edit') expect(r.x).toBe(r.moved)                                              // the edit is still there
      if (race === 'switch') expect(r.board).toBe('checkout')
      expect(JSON.parse(readFileSync(join(root, 'design', 'boards', 'pricing.json'), 'utf8')).status).toBeUndefined()
    }
    board('pricing', { folder: 'features', order: 2 })
  })

  skippable('the autosave\'s own conflict path is unchanged: a 409 mid-drag still reloads, nothing stays dirty', async () => {
    const s = await browser!.tab({ width: 1400, height: 900 })
    await browser!.go(s, `${ORIGIN}/#/b/pricing`)
    await browser!.until(s, `window.__mvStore?.getState().board === 'pricing' && !!window.__mvStore.getState().boardHash && !window.__mvStore.getState().dirty`, 30_000)
    board('pricing', { folder: 'features', order: 2, description: 'the agent, mid-drag' })               // the store's hash is now behind
    // an edit schedules the autosave; a drag starts before it fires; the save meets the 409
    await browser!.eval(s, `(() => { const st = window.__mvStore.getState(); const n = st.nodes[0]; st.moveSelectedBy(40, 0, { [n.key]: { x: n.x, y: n.y } }); window.__mvStore.getState().setGesture(true) })()`)
    await browser!.until(s, `!window.__mvStore.getState().dirty`, 15_000)                              // reloaded - disk wins, as it always has
    await browser!.eval(s, `window.__mvStore.getState().setGesture(false)`)
    expect(JSON.parse(readFileSync(join(root, 'design', 'boards', 'pricing.json'), 'utf8')).description).toBe('the agent, mid-drag')
    board('pricing', { folder: 'features', order: 2 })
  })

  skippable('an edit to a context file a frame renders updates the frame - the canvas never reloads', async () => {
    const s = await browser!.tab({ width: 1400, height: 900 })
    await browser!.go(s, `${ORIGIN}/#/b/front`)
    const FRAME_TEXT = `Array.from(document.querySelectorAll('iframe')).map((f) => { try { return f.contentDocument?.getElementById('idx')?.textContent ?? '' } catch { return '' } }).join('|')`
    await browser!.until(s, `${FRAME_TEXT}.includes('First version.')`, 30_000)
    await browser!.eval(s, `window.__noReload = true`)
    put('context/INDEX.md', '---\naudience: team\n---\n\n# The index\n\nSecond version.\n')
    await browser!.until(s, `${FRAME_TEXT}.includes('Second version.')`, 20_000)
    expect(await browser!.eval(s, `window.__noReload === true`)).toBe(true)
  })
})
