/**
 * Spec 39 A5 - the people invited to a published board comment on a drawing's elements: a real `marver build` + `serve`
 * (Marver ID roster), a real Chrome signed in as an invited reviewer. At rest and in drawing play the reviewer pins a
 * comment to an element, the server stores it with its drawing anchor; the right-click keeps only read-only rows; a
 * view-only board asks to comment; an anchor naming a frame the board does not show is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { findChrome, } from '../src/server/cdp.ts'
import { portInUse } from '../src/server/exclusive.ts'

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const REVIEWER = 'ana@client.test'
const el = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id, type: 'rectangle', x, y, width: 180, height: 90, angle: 0, strokeColor: '#2f9e44', backgroundColor: 'transparent', fillStyle: 'solid',
  strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 }, seed: 1, version: 1,
  versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, ...extra,
})
const DRAWING = {
  type: 'excalidraw', version: 2, source: 'marver', marver: { rev: 3, epoch: 'pub1', title: 'Flow', size: { w: 960, h: 640 }, view: { x: 0, y: 0, zoom: 1 } },
  elements: [el('cart', 80, 200, { index: 'a0' }), el('pay', 420, 200, { index: 'a1', seed: 2, versionNonce: 2 })],
  appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {},
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('comments on a published drawing (spec 39 A5), in a real browser', () => {
  let root = '', data = '', server: ChildProcess | null = null, log = '', b: Browser | null = null, tab = '', ORIGIN = ''
  const authFile = () => join(data, 'auth.json')
  const stored = (board = 'main') => { try { return readFileSync(join(data, 'comments', `${board}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }

  beforeAll(async () => {
    if (!findChrome()) return
    root = mkdtempSync(join(tmpdir(), 'mv-draw-pub-'))
    data = join(root, 'data')
    mkdirSync(data)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'draw-pub-fixture', private: true, type: 'module' }))
    const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules'), nm = join(root, 'node_modules')
    mkdirSync(nm)
    for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver') symlinkSync(join(repoNm, e), join(nm, e)) }
    mkdirSync(join(nm, '@marver-design'))
    symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
    mkdirSync(join(root, 'design', 'scenes', 'sketches'), { recursive: true })
    writeFileSync(join(root, 'design', 'scenes', 'sketches', 'flow.excalidraw'), JSON.stringify(DRAWING))
    mkdirSync(join(root, 'design', 'boards'), { recursive: true })
    writeFileSync(join(root, 'design', 'boards', 'main.json'), JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [{ key: 'd1', frame: 'sketches/flow', x: 0, y: 0, w: 960, h: 640 }] }))
    writeFileSync(join(root, 'design', 'boards', 'look.json'), JSON.stringify({ version: 1, name: 'look', order: 1, auto: false, nodes: [{ key: 'd2', frame: 'sketches/flow', x: 0, y: 0, w: 960, h: 640 }] }))
    writeFileSync(join(root, 'design', 'publish.json'), JSON.stringify({ version: 2, boards: { main: 'comment', look: 'read' } }))
    execFileSync(process.execPath, [CLI, 'build', '--root', root], { stdio: 'pipe', encoding: 'utf8' })
    writeFileSync(authFile(), JSON.stringify({ users: [
      { email: 'owner@studio.test', name: 'Owner', role: 'owner', auth: 'marver-id', createdAt: Date.now() },
      { email: REVIEWER, name: 'Ana', role: 'member', auth: 'marver-id', createdAt: Date.now() },
    ], invites: [], sessions: [] }, null, 2), { mode: 0o600 })
    // a port of this run's own block, past the ones other suites take
    const base = Number(process.env.MARVER_SLOT_BASE)
    let port = Number.isFinite(base) && base > 0 ? base + 186 : 47_620
    while (await portInUse(port)) port++
    ORIGIN = `http://localhost:${port}`
    server = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], { cwd: root, stdio: 'pipe', env: {
      ...process.env, MARVER_DATA_DIR: data, MARVER_PASSWORD: '', MARVER_CLI_TOKEN: '', MARVER_ID_ISSUER: `http://localhost:${port + 1}`, MARVER_PUBLIC_ORIGIN: ORIGIN,
    } })
    server.stdout?.on('data', (d) => { log += d })
    server.stderr?.on('data', (d) => { log += d })
    for (let i = 0; i < 120 && !log.includes('serving design/.dist'); i++) await sleep(100)
    b = await Browser.launch()
    if (!b) return
    tab = await b.tab({ width: 1440, height: 900 })
    // signed in as the invited reviewer
    const tok = randomBytes(24).toString('base64url')
    const a = JSON.parse(readFileSync(authFile(), 'utf8'))
    a.sessions.push({ tokenHash: sha(tok), emailNorm: REVIEWER, exp: Date.now() + 30 * 86_400_000 })
    writeFileSync(authFile(), JSON.stringify(a, null, 2), { mode: 0o600 })
    await b.send('Network.setCookie', { name: 'mv_s', value: tok, url: ORIGIN, httpOnly: true }, tab)
    await b.send('Network.setCookie', { name: 'mv_c', value: randomBytes(12).toString('base64url'), url: ORIGIN }, tab)
  }, 300_000)
  afterAll(async () => {
    if (b && tab) await b.closeTab(tab).catch(() => {})
    if (server && server.exitCode === null) await new Promise<void>((r) => { server!.once('exit', () => r()); server!.kill('SIGTERM') })
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const ev = async (x: string): Promise<any> => { for (let i = 0; i < 8; i++) { try { return await b!.eval(tab, x) } catch { await sleep(300) } } throw new Error(`eval kept failing: ${x}`) }
  const until = async (x: string, ms = 20_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(x).catch(() => false)) return true; await sleep(150) } throw new Error(`timed out: ${x}`) }
  const mouse = (type: string, x: number, y: number, button = 'left') =>
    b!.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : button, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0, clickCount: 1 }, tab)
  const click = async (x: number, y: number, button = 'left') => { await mouse('mouseMoved', x, y); await sleep(40); await mouse('mousePressed', x, y, button); await mouse('mouseReleased', x, y, button) }
  const key = async (k: string, code: string, vk: number) => {
    const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await b!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, tab)
    if (k.length === 1) await b!.send('Input.dispatchKeyEvent', { type: 'char', text: k, ...base }, tab)
    await b!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, tab)
  }
  const page = (frameSel: string, x: number, y: number) => ev(`(() => { const f = document.querySelector(${JSON.stringify(frameSel)}); const r = f.getBoundingClientRect(); const p = f.contentWindow.__mvDraw.engine.toView(${x}, ${y}); const k = r.width / f.offsetWidth; return { x: r.x + p.x * k, y: r.y + p.y * k } })()`)
  const send = async (words: string) => {
    await until(`!!document.querySelector('.cm-draft textarea, .cm-draft [contenteditable]')`)
    await b!.send('Input.insertText', { text: words }, tab)
    await key('Enter', 'Enter', 13)
  }
  const CANVAS = 'iframe[data-kind="draw"]'

  it('an invited reviewer comments on an element of the published drawing, at rest', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    await b.go(tab, `${ORIGIN}/#/b/main`)
    await until(`(() => { try { return !!document.querySelector('${CANVAS}').contentWindow.__mvDraw?.ready } catch { return false } })()`, 60_000)
    await until(`!!document.querySelector('.sh-pill-btn') && !document.querySelector('.sh-pill-btn[aria-disabled]')`, 20_000)
    await key('c', 'KeyC', 67)
    await until(`document.querySelector('${CANVAS}').contentWindow.__mvAnchorProvider?.ready()`)
    const at = await page(CANVAS, 80 + 150, 200 + 30)
    await click(at.x, at.y)
    await send('the cart needs a total')
    await until(`(() => { return true })()`)
    for (let i = 0; i < 80 && !stored().some((e) => e.type === 'create' && e.body === 'the cart needs a total'); i++) await sleep(150)
    const ev1 = stored().find((e) => e.type === 'create' && e.body === 'the cart needs a total')
    expect(ev1, log).toBeTruthy()
    expect(ev1.anchor.el.draw).toMatchObject({ id: 'cart', type: 'rectangle', epoch: 'pub1' })
    expect(ev1.frame).toBe('sketches/flow')
    expect(ev1.nodeKey).toBe('d1')
  }, 120_000)

  it('in drawing play: the comment button sits beside the X, a pick lands on the element, the right-click keeps read-only rows', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    await ev(`document.querySelector('.cm-card') && window.__mvComments?.getState?.().setActive?.(null); true`)
    await ev(`(() => { const s = window.__mvStore?.getState?.(); if (s) s.select('d1'); return true })()`)
    // select the drawing by its head, then P
    const head = await ev(`(() => { const r = document.querySelector('.sh-node.dk-draw .sh-node-head')?.getBoundingClientRect(); return r ? { x: r.x + 30, y: r.y + r.height / 2 } : null })()`)
    if (head) await click(head.x, head.y)
    await key('p', 'KeyP', 80)
    await until(`(() => { try { return !!document.querySelector('.dk-playhost iframe').contentWindow.__mvDraw?.ready } catch { return false } })()`, 20_000)
    await until(`!!document.querySelector('.dk-playhost .dk-pair button[aria-label="Comment"]')`, 5000)
    await ev(`document.querySelector('.dk-playhost .dk-pair button[aria-label="Comment"]').click()`)
    await until(`document.querySelector('.dk-playhost iframe').contentWindow.__mvAnchorProvider?.ready()`)
    const at = await page('.dk-playhost iframe', 420 + 90, 200 + 45)
    await click(at.x, at.y)
    await send('pay button colour')
    for (let i = 0; i < 80 && !stored().some((e) => e.type === 'create' && e.body === 'pay button colour'); i++) await sleep(150)
    const ev2 = stored().find((e) => e.type === 'create' && e.body === 'pay button colour')
    expect(ev2?.anchor?.el?.draw?.id).toBe('pay')
    expect(ev2.nodeKey).toBe('d1')
    // the right-click on a view-only drawing: Comment and the read-only rows only
    const at2 = await page('.dk-playhost iframe', 80 + 90, 200 + 45)
    await click(at2.x, at2.y, 'right')
    await until(`!!document.querySelector('.dk-ctxmenu')`, 5000)
    const rows: string[] = await ev(`[...document.querySelectorAll('.dk-ctxmenu button span')].map((s) => s.textContent)`)
    expect(rows[0]).toBe('Comment')
    for (const r of rows.slice(1)) expect(['Copy selection as image', 'Copy as text', 'Copy as image']).toContain(r)
    await key('Escape', 'Escape', 27)
  }, 120_000)

  it('a view-only board asks to comment; an anchor naming a frame the board does not show is refused', async (ctx) => {
    if (!b) return ctx.skip('no Chrome')
    await b.go(tab, `${ORIGIN}/#/b/look`)
    await until(`(() => { try { return !!document.querySelector('${CANVAS}').contentWindow.__mvDraw?.ready } catch { return false } })()`, 60_000)
    // the comment button is the locked one there (the board is read-only for everyone)
    const locked = await ev(`!!document.querySelector('.sh-pill-btn[style*="opacity"]') || [...document.querySelectorAll('.sh-pill-btn')].length === 0`)
    expect(locked).toBe(true)
    // straight to the server: a drawing anchor on a frame main does not show
    const res = await ev(`(async () => {
      const csrf = /(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie)?.[1] ?? ''
      const me = await (await fetch('/__mv/api/me')).json()
      const ev = { id: 'forged-anchor-1', ts: me.now ?? Date.now(), type: 'create', commentId: 'forged-thread-1', board: 'main', nodeKey: 'd1', frame: 'private/elsewhere',
        anchor: { el: { draw: { id: 'cart', type: 'rectangle' } } }, author: { id: me.id }, body: 'smuggled' }
      const r = await fetch('/__mv/api/comments/main', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf }, body: JSON.stringify({ events: [ev], as: me.id }) })
      return r.status
    })()`)
    expect(res).toBeGreaterThanOrEqual(400)
    expect(stored().some((e) => e.body === 'smuggled')).toBe(false)
    // the right frame, but a node that is not the board's (the build's node map is checked - review r1 #1)
    const res2 = await ev(`(async () => {
      const csrf = /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
      const me = await (await fetch('/__mv/api/me')).json()
      const ev = { id: 'forged-node-1', ts: me.now ?? Date.now(), type: 'create', commentId: 'forged-thread-2', board: 'main', nodeKey: 'not-a-node', frame: 'sketches/flow',
        anchor: { el: { draw: { id: 'cart', type: 'rectangle' } } }, author: { id: me.id }, body: 'wrong node' }
      const r = await fetch('/__mv/api/comments/main', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf }, body: JSON.stringify({ events: [ev], as: me.id }) })
      return r.status
    })()`)
    expect(res2).toBeGreaterThanOrEqual(400)
    expect(stored().some((e) => e.body === 'wrong node')).toBe(false)
  }, 120_000)
})
