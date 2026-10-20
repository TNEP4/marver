import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Jam, from the owner's first real session (0.26.1, spec 27b): the review shows before and after at once, laid out by
 * the frame's shape and as wide as that needs; the lane's tiles keep their blur when the lane is full; two or more done
 * tiles fold into one; the laser points (one element lit), inspect (⌥L) outlines everything. A REAL dev server with
 * jam on, a fake `claude`, a REAL browser. Skips without Chrome.
 */

const PORT = 7800 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
let ORIGIN = `http://localhost:${PORT}`
let root = '', bin = '', log = '', s = ''
let server: ChildProcess | null = null
let browser: Browser | null = null

const put = (rel: string, body: string | object) => {
  const f = join(root, rel)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = (expr: string, ms = 20_000) => browser!.until(s, expr, ms)
const ev = (expr: string) => browser!.eval(s, expr)
/** with MARVER_SHOT_DIR set, a picture of the page */
const pic = async (name: string) => {
  if (!process.env.MARVER_SHOT_DIR) return
  const out = await browser!.send('Page.captureScreenshot', { format: 'png' }, s)
  writeFileSync(join(process.env.MARVER_SHOT_DIR, `polish-${name}.png`), Buffer.from(out.data, 'base64'))
}

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs')
const goal = process.argv[process.argv.indexOf('-p') + 1] || ''
const file = (/design\\/\\.local\\/jam\\/packets\\/[\\w-]+\\.json/.exec(goal) || [])[0]
if (!file) process.exit(1)
const p = JSON.parse(fs.readFileSync(file, 'utf8'))
const F = '\`\`\`'
process.stdout.write(JSON.stringify({ type: 'result', result: p.members.map((m) => F + 'marver-reply ' + m.id + '\\nDone.\\n' + F).join('\\n') }) + '\\n')
`
const frame = (name: string, viewport: string) => `export const meta = { title: '${name}', viewport: '${viewport}' }
export default () => <main style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #fde, #def)' }}><h1 id="h">${name}</h1><p id="p">A line</p><button id="b">Go</button></main>
`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-jam-polish-'))
  bin = mkdtempSync(join(tmpdir(), 'mv-jam-polish-bin-'))
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  put('package.json', { name: 'jam-polish', private: true, type: 'module' })
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  put('design/config.ts', "export default { jam: { agent: 'claude', concurrency: 2 } }\n")
  put('design/scenes/spec/phone.tsx', frame('Phone', 'mobile'))
  put('design/scenes/spec/laptop.tsx', frame('Laptop', 'laptop'))
  put('design/boards/main.json', { version: 1, name: 'main', auto: false, order: 0, nodes: [{ frame: 'spec/phone' }, { frame: 'spec/laptop' }] })
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BROWSER: 'none', CI: '1', MARVER_MODELS: join(root, 'no-models') } })
  server.stdout?.on('data', (d) => { log += d; const m = log.match(/→ (http:\/\/localhost:\d+)\//); if (m) ORIGIN = m[1] })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !/→ http:\/\/localhost:\d+\//.test(log)) await sleep(100)
  while (Date.now() - t0 < 60_000) { if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break; await sleep(200) }
  browser = await Browser.launch()
  if (!browser) return
  s = await browser.tab({ width: 1600, height: 1000 })
  await browser.go(s, `${ORIGIN}/#/b/main`)
  await until(`window.__mvStore?.getState().nodes.length === 2 && window.__mvStore.getState().nodes.every((n) => n.status === 'ready') && !!window.__mvJamQueue && !!window.__mvJamVoice`, 45_000)
  await ev(`window.__mvJamVoice.getState().setChoice('no'), 1`)
}, 120_000)

afterAll(async () => {
  browser?.close()
  if (server && server.exitCode === null) {
    const gone = new Promise((r) => server!.once('exit', r))
    try { server.kill('SIGTERM') } catch { /* gone */ }
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))])
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(bin, { recursive: true, force: true })
})

const skippable = (name: string, fn: () => Promise<void>, ms = 180_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)
const key = (k: string, mods: { shift?: boolean } = {}) => browser!.press(s, k, mods)
const keyEvent = async (base: Record<string, unknown>) => {
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, s)
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, s)
}
const enter = () => keyEvent({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
const escape = () => keyEvent({ key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
/** ⌥L as a Mac sends it: the key is "¬", the physical key L */
const optL = () => keyEvent({ key: '¬', code: 'KeyL', modifiers: 1, windowsVirtualKeyCode: 76, text: '¬' })
const cards = () => ev(`window.__mvJamQueue.getState().cards ?? []`)
const mouse = async (x: number, y: number, click = false) => {
  await browser!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, s)
  if (click) {
    await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, s)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, s)
  }
}

/** A capture of one frame (selected, so it is the capture's frame) - confirmed, run, and in review. */
async function reviewOf(frameId: string): Promise<string> {
  // nothing open: a capture made over an open review would follow that review
  await ev(`(window.__mvJamUi.getState().close(), window.__mvStore.getState().select([]), 1)`)
  await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
  const id = await ev(`window.__mvJamCapture.getState().current`)
  // a click on it while it records: the frame it is about (its pictures, its review) - in view first
  await ev(`(() => { const st = window.__mvStore.getState(); window.__mvJamCanvas.fitNodes([st.nodes.find((n) => n.frame === ${JSON.stringify(frameId)}).key]); return 1 })()`)
  await sleep(500)
  const at = await ev(`(() => { const st = window.__mvStore.getState(); const k = st.nodes.find((n) => n.frame === ${JSON.stringify(frameId)}).key; const r = document.querySelector('.sh-node[data-node="' + k + '"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 120) } })()`)
  await mouse(at.x, at.y, true)
  await until(`(window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.steps ?? []).some((x) => x.event === 'click' && x.frame === ${JSON.stringify(frameId)})`, 5000)
  await key('e')
  await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 60_000)
  await ev(`(() => { const q = window.__mvJamQueue.getState(); return q.act(q.cards.find((c) => c.id === ${JSON.stringify(id)}), 'confirm') })()`)
  await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'review')`, 90_000)
  await ev(`window.__mvJamUi.getState().close(), 1`)
  return id
}
const openReview = async (id: string) => {
  await ev(`window.__mvJamUi.getState().open({ kind: 'review', id: ${JSON.stringify(id)} }), 1`)
  await until(`!!document.querySelector('[data-jam-review] .jm-big img')`, 10_000)
}
const rect = (sel: string) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null })()`)

describe('the review shows before and after at once, by the frame\'s shape (0.26.1)', () => {
  let phone = '', laptop = ''
  skippable('a phone frame: side by side, the panel wider than 580 px - as wide as two pictures at the well\'s height', async () => {
    phone = await reviewOf('spec/phone')
    await openReview(phone)
    await until(`document.querySelector('[data-jam-pair]')?.getAttribute('data-jam-pair') === 'side'`, 10_000)
    await sleep(400)   // the panel takes its width
    const shots = await ev(`[...document.querySelectorAll('[data-jam-review] .jm-big .jm-shot')].map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y } })`)
    expect(shots.length).toBe(2)
    expect(Math.abs(shots[0].y - shots[1].y)).toBeLessThan(2)            // one row
    expect(shots[1].x).toBeGreaterThan(shots[0].x)                        // Before left, After right
    await pic('review-phone')
    const caps = await ev(`[...document.querySelectorAll('[data-jam-review] .jm-big .cap')].map((e) => e.textContent)`)
    expect(caps).toEqual(['Before', 'After'])
    const panel = await rect('[data-jam-focus]')
    expect(panel.w).toBeGreaterThan(580)
    expect(panel.x + panel.w).toBeLessThanOrEqual(1600)
    // the width two pictures need at the well's height (390x844 at 2x), give or take the rounding
    const well = await rect('[data-jam-review] .jm-big')
    const want = (panel.w - well.w) + 2 * (well.h - 20 - 18) * (390 / 844) + 10 + 20
    expect(Math.abs(panel.w - Math.min(1600 - panel.x - 12, Math.max(580, want)))).toBeLessThan(24)
  })

  skippable('a laptop frame: stacked, Before above After, the panel as wide as half the well\'s height allows', async () => {
    laptop = await reviewOf('spec/laptop')
    await openReview(laptop)
    await until(`document.querySelector('[data-jam-pair]')?.getAttribute('data-jam-pair') === 'stack'`, 10_000)
    await sleep(400)
    const shots = await ev(`[...document.querySelectorAll('[data-jam-review] .jm-big .jm-shot')].map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y } })`)
    expect(Math.abs(shots[0].x - shots[1].x)).toBeLessThan(2)            // one column
    expect(shots[1].y).toBeGreaterThan(shots[0].y)                        // Before above, After below
    await pic('review-laptop')
    const panel = await rect('[data-jam-focus]'), well = await rect('[data-jam-review] .jm-big')
    const want = (panel.w - well.w) + ((well.h - 20 - 10 - 36) / 2) * (1280 / 800) + 20
    expect(Math.abs(panel.w - Math.min(1600 - panel.x - 12, Math.max(580, want)))).toBeLessThan(24)
  })

  skippable('the switch: Both, Before and After each chosen from each other; B steps Both -> Before -> After -> Both', async () => {
    await openReview(laptop)
    const view = () => ev(`window.__mvJamUi.getState().view`)
    const choose = (label: string) => ev(`[...document.querySelectorAll('[data-jam-flip] button')].find((b) => b.textContent === ${JSON.stringify(label)}).click(), 1`)
    for (const [from, to] of [['Both', 'After'], ['After', 'Before'], ['Before', 'Both'], ['Both', 'Before'], ['Before', 'After'], ['After', 'Both']]) {
      await choose(from); await choose(to)
      expect(await view()).toBe(to.toLowerCase())
    }
    expect(await ev(`document.querySelectorAll('[data-jam-review] .jm-big .jm-shot').length`)).toBe(2)
    await key('b'); expect(await view()).toBe('before')
    expect(await ev(`document.querySelectorAll('[data-jam-review] .jm-big .jm-shot').length`)).toBe(1)
    await key('b'); expect(await view()).toBe('after')
    await key('b'); expect(await view()).toBe('both')
  })

  skippable('a picture that cannot load is "No picture" - never a broken image', async () => {
    await openReview(phone)
    // its After picture made to fail
    await ev(`(() => { const img = [...document.querySelectorAll('[data-jam-review] .jm-big img')][1]; img.src = '/__mv/api/jam/picture?id=p-0000000000000000'; return 1 })()`)
    await until(`/No picture/.test(document.querySelector('[data-jam-review] .jm-big')?.textContent ?? '')`, 10_000)
    await ev(`window.__mvJamUi.getState().close(), 1`)
  })

  skippable('two or more done captures fold into one Done tile; a click opens them behind a collapse tile; Q walks the fold', async () => {
    // a session keeps the lane up as captures finish
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
    await enter(); await until(`!!window.__mvJamQueue.getState().session && !!window.__mvJamCapture.getState().current`, 10_000)
    await ev(`window.__mvJamCapture.getState().drop(), 1`)
    for (const id of [phone, laptop]) await ev(`(() => { const q = window.__mvJamQueue.getState(); return q.act(q.cards.find((c) => c.id === ${JSON.stringify(id)}), 'good') })()`)
    const third = await reviewOf('spec/phone')
    await ev(`(() => { const q = window.__mvJamQueue.getState(); return q.act(q.cards.find((c) => c.id === ${JSON.stringify(third)}), 'good') })()`)
    await until(`(window.__mvJamQueue.getState().cards ?? []).filter((c) => c.state === 'done').length >= 3`, 20_000)
    await until(`!!document.querySelector('[data-jam-done="folded"]')`, 5000)
    await pic('done-folded')
    expect(await ev(`document.querySelector('[data-jam-done="folded"] .t').textContent`)).toBe('Done')
    // three captures that changed nothing (the fake agent edits no file): no frames counted
    expect(await ev(`document.querySelector('[data-jam-done="folded"] .m').textContent`)).toBe('3 captures')
    for (const id of [phone, laptop, third]) expect(await ev(`!!document.querySelector('.jm-lane [data-tile="${id}"]')`)).toBe(false)
    // open, then fold back
    await ev(`document.querySelector('[data-jam-done="folded"]').click(), 1`)
    await until(`!!document.querySelector('[data-jam-done="open"]')`, 3000)
    await sleep(300); await pic('done-open')
    for (const id of [phone, laptop, third]) expect(await ev(`!!document.querySelector('.jm-lane [data-tile="${id}"]')`)).toBe(true)
    await ev(`document.querySelector('[data-jam-done="open"]').click(), 1`)
    await until(`!!document.querySelector('[data-jam-done="folded"]')`, 3000)
    // the lane's keys: the folded group is one stop, ⏎ opens it
    await key('q')
    await ev(`window.__mvJamUi.getState().select('jam-done-group'), 1`)
    await enter()
    await until(`!!document.querySelector('[data-jam-done="open"]')`, 3000)
    await escape()
    await ev(`window.__mvJamUi.getState().setDoneOpen(false), 1`)
    // the session ends (no record)
    await ev(`(async () => { const ses = window.__mvJamQueue.getState().session; const csrf = (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || ''; if (ses) { await fetch('/__mv/api/jam/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf }, body: JSON.stringify({ action: 'end', id: ses.id }) }); window.__mvJamQueue.getState().forget(ses.id) } await window.__mvJamQueue.getState().load(); return 1 })()`)
    await until(`!window.__mvJamQueue.getState().session`, 10_000)
  })
})

describe('the lane is readable over whatever is under it (0.26.1)', () => {
  skippable('full, it keeps its tiles frosted: no mask above a tile, edge strips instead - and stripes under a tile come out blurred', async () => {
    // a full lane: a narrow window and a few drafts
    await browser!.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false }, s)
    try {
    await sleep(300)
    for (let i = 0; i < 4; i++) { await key('s'); await until(`!!window.__mvJamCapture.getState().current`); await key('e'); await until(`!window.__mvJamCapture.getState().current && Object.keys(window.__mvJamCapture.getState().caps).length === 0`, 60_000) }
    await until(`document.querySelector('.jm-lane-in').scrollWidth > document.querySelector('.jm-lane-in').clientWidth + 10`, 10_000)
    // nothing above a tile carries a mask (a mask would make it the tiles' backdrop root: no blur)
    const masked = await ev(`(() => { let el = document.querySelector('.jm-lane .jm-card'); const out = []; while (el) { const c = getComputedStyle(el); if ((c.maskImage && c.maskImage !== 'none') || (c.webkitMaskImage && c.webkitMaskImage !== 'none')) out.push(el.className); el = el.parentElement } return out })()`)
    expect(masked).toEqual([])
    expect(await ev(`!!document.querySelector('.jm-lane-edge')`)).toBe(true)
    // contrasting stripes under the lane (above the canvas, below the lane), then a picture of one tile and of open stripes
    // (in the lane's own stacking context, just under it: z-index 30 beside its 31)
    await ev(`(() => { const d = document.createElement('div'); d.id = 'stripes'; d.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:260px;z-index:30;background:repeating-linear-gradient(90deg,#000 0 3px,#fff 3px 6px)'; document.querySelector('.jm-lane').parentElement.appendChild(d); return 1 })()`)
    await sleep(200)
    const tile = await ev(`(() => { const r = [...document.querySelectorAll('.jm-lane .jm-card')].find((e) => { const b = e.getBoundingClientRect(); return b.left > 70 && b.right < innerWidth - 70 }).getBoundingClientRect(); return { x: r.x + 20, y: r.y + 10, width: r.width - 40, height: r.height - 20 } })()`)
    const spread = async (clip: { x: number; y: number; width: number; height: number }) => {
      const shot = await browser!.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } }, s)
      const lum = grey(Buffer.from(shot.data, 'base64'))
      const mean = lum.reduce((a, b) => a + b, 0) / lum.length
      return Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length)
    }
    await pic('lane-stripes')
    const under = await spread(tile)
    const open = await spread({ x: tile.x, y: (await ev(`innerHeight`)) - 240, width: tile.width, height: 6 })
    expect(open).toBeGreaterThan(80)          // the stripes themselves: black and white
    expect(under).toBeLessThan(open / 4)      // through a tile: blurred
    await ev(`(document.getElementById('stripes').remove(), 1)`)
    for (const c of await cards()) if (c.state === 'draft') await ev(`(() => { const q = window.__mvJamQueue.getState(); return q.act(q.cards.find((x) => x.id === ${JSON.stringify(c.id)}), 'drop') })()`)
    } finally { await browser!.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, s) }
  })
})

describe('the laser points; inspect is its own mode (0.26.1)', () => {
  const inFrame = (frameId: string, expr: string) => ev(`(() => { const st = window.__mvStore.getState(); const k = st.nodes.find((n) => n.frame === ${JSON.stringify(frameId)}).key; const f = document.querySelector('.sh-node[data-node="' + k + '"] iframe') || [...document.querySelectorAll('iframe')].find((x) => x.src.includes(${JSON.stringify(frameId)})); const d = f.contentDocument; return (${expr})(d, f.getBoundingClientRect()) })()`)
  const hoverIn = async (frameId: string, sel: string) => {
    const at = await inFrame(frameId, `(d, fr) => { const r = d.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); const z = fr.width / d.documentElement.clientWidth; return { x: fr.x + (r.x + r.width / 2) * z, y: fr.y + (r.y + r.height / 2) * z } }`)
    await mouse(at.x, at.y)
    return at
  }
  /** the phone frame in view, nothing selected, no laser, nothing open */
  const phoneInView = async () => {
    await ev(`(() => { const st = window.__mvStore.getState(); st.setLaser(false); st.select([]); window.__mvJamUi.getState().close(); window.__mvJamCanvas.fitNodes([st.nodes.find((n) => n.frame === 'spec/phone').key]); return 1 })()`)
    await sleep(500)
  }
  const outline = (frameId: string, sel: string) => inFrame(frameId, `(d) => getComputedStyle(d.querySelector(${JSON.stringify(sel)})).outlineStyle`)

  skippable('L: only the element under the cursor is lit; ⌥L: every element outlined; L from inspect goes back to the pointer; Esc turns it off', async () => {
    await phoneInView()
    await key('l')
    await until(`window.__mvStore.getState().laser && !window.__mvStore.getState().laserInspect`, 3000)
    await sleep(200)
    await hoverIn('spec/phone', '#h')
    await until(`(() => { const st = window.__mvStore.getState(); const k = st.nodes.find((n) => n.frame === 'spec/phone').key; const d = document.querySelector('.sh-node[data-node="' + k + '"] iframe')?.contentDocument; return !!d && d.querySelectorAll('[data-mv-hover]').length === 1 })()`, 5000)
    expect(await outline('spec/phone', '#p')).toBe('none')          // a sibling: not outlined
    await pic('laser-pointer')
    // a click copies its path (outside a capture)
    await ev(`(window.__copies = [], window.addEventListener('message', (e) => { if (e.data && e.data.type === 'sh:laser-copy') window.__copies.push(e.data.path) }), 1)`)
    const at = await hoverIn('spec/phone', '#h')
    await mouse(at.x, at.y, true)
    await until(`window.__copies.length === 1 && window.__copies[0] === '#h'`, 5000)
    await optL()
    await sleep(300)
    await until(`window.__mvStore.getState().laser && window.__mvStore.getState().laserInspect`, 3000)
    await sleep(200)
    expect(await outline('spec/phone', '#p')).toBe('solid')         // inspect: everything outlined
    await pic('laser-inspect')
    await key('l')
    await sleep(200)
    await until(`window.__mvStore.getState().laser && !window.__mvStore.getState().laserInspect`, 3000)
    await sleep(200)
    expect(await outline('spec/phone', '#p')).toBe('none')
    await escape()
    await until(`!window.__mvStore.getState().laser`, 3000)
  })

  skippable('in a capture: the pointer laser\'s click is the capture\'s pick, and Esc turns the laser off before it ever drops the capture', async () => {
    await phoneInView()
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await ev(`window.__mvJamCapture.getState().current`)
    await key('l')
    await until(`window.__mvStore.getState().laser && !window.__mvStore.getState().laserInspect`, 3000)
    await sleep(200)
    const at = await hoverIn('spec/phone', '#b')
    await mouse(at.x, at.y, true)
    await until(`(window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.steps ?? []).some((x) => x.event === 'pick')`, 5000)
    await escape()
    await until(`!window.__mvStore.getState().laser`, 3000)
    expect(await ev(`window.__mvJamCapture.getState().current`)).toBe(id)     // still recording
    await ev(`window.__mvJamCapture.getState().drop(), 1`)
  })

  skippable('a shell from before 0.26.1 (no `inspect` in its message) gets the outlined laser in the frame', async () => {
    await inFrame('spec/phone', `(d, fr) => { d.defaultView.postMessage({ type: 'sh:laser', on: true }, location.origin); return 1 }`)
    // (a message from the frame's own window is not the shell's: post it as the parent does)
    await ev(`(() => { const st = window.__mvStore.getState(); const k = st.nodes.find((n) => n.frame === 'spec/phone').key; document.querySelector('.sh-node[data-node="' + k + '"] iframe').contentWindow.postMessage({ type: 'sh:laser', on: true }, location.origin); return 1 })()`)
    await sleep(300)
    expect(await outline('spec/phone', '#p')).toBe('solid')
    await ev(`(() => { const st = window.__mvStore.getState(); const k = st.nodes.find((n) => n.frame === 'spec/phone').key; document.querySelector('.sh-node[data-node="' + k + '"] iframe').contentWindow.postMessage({ type: 'sh:laser', on: false }, location.origin); return 1 })()`)
  })
})

/** The luminance of every pixel of a non-interlaced 8-bit RGB/RGBA PNG (what Chrome writes). */
function grey(b: Buffer): number[] {
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), bpp = b[25] === 6 ? 4 : 3
  let pos = 8; const idat: Buffer[] = []
  while (pos < b.length) { const len = b.readUInt32BE(pos), type = b.toString('ascii', pos + 4, pos + 8); if (type === 'IDAT') idat.push(b.subarray(pos + 8, pos + 8 + len)); pos += 12 + len }
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, out: number[] = []
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, u = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      if (f === 1) line[i] = (line[i] + a) & 255
      else if (f === 2) line[i] = (line[i] + u) & 255
      else if (f === 3) line[i] = (line[i] + ((a + u) >> 1)) & 255
      else if (f === 4) { const p = a + u - c, pa = Math.abs(p - a), pb = Math.abs(p - u), pc = Math.abs(p - c); line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c)) & 255 }
    }
    for (let x = 0; x < w; x++) out.push(0.3 * line[x * bpp] + 0.59 * line[x * bpp + 1] + 0.11 * line[x * bpp + 2])
    prev = line
  }
  return out
}
