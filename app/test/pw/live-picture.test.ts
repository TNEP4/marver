/**
 * Live pictures on a REAL canvas (spec 28 A4.6 #35, #52's pw case): `marver dev` from this branch's dist/, with Jam on,
 * in a real tab of the app (real trust). In play on a device preset, a button opens a red panel on the stage, then I:
 * the capture's picture is the app's (`source: 'live'`), its PNG at the stage's on-screen size times the display's
 * scale, and the red panel is in it - what a render of the frame, its panel closed, never shows. The recorder is on (its
 * default), and the I is taken inside a gesture, as one of the white-out detector's own full-view readbacks starts
 * (whiteout.ts reads back only from a gesture's start to 500 ms after its end): main's journal shows that readback in
 * flight while the live one runs, and the live picture still lands. A tab that is not the active one is answered
 * `hidden`. The rules themselves are unit cases (live-picture, bridge-capture, preload-canvas) and the shell's the
 * package's live-picture-browser.test.ts.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtureRoot, startDev, type Dev } from '../../../test/dev-server.ts'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const MENU = `import { useState } from 'react'
export const meta = { title: 'Menu', viewport: 'mobile' }
export default function Menu() {
  const [open, setOpen] = useState(false)
  return (
    <main style={{ padding: 24, background: '#ffffff', minHeight: '100vh', position: 'relative' }}>
      <button id="open" onClick={() => setOpen(true)}>Open the menu</button>
      {open && <div id="panel" style={{ position: 'absolute', left: 0, right: 0, top: 120, height: 420, background: '#e00000' }} />}
    </main>
  )
}
`
/** no agent runs here: a capture is stopped to review and dropped */
const FAKE_CLAUDE = '#!/usr/bin/env node\nprocess.exit(1)\n'

let w: WindowRun
let dev: Dev | null = null
let root = ''
let bin = ''
let id = ''
const exec = <T = unknown>(js: string, target = id) => w.run.call<T>('exec', { target, js })
async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f().catch(() => null)
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

/** A PNG's pixels (8-bit RGB or RGBA, not interlaced: what toPNG writes), its filters undone. */
function pixels(png: Buffer): { w: number; h: number; ch: number; data: Buffer } {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20), ch = png[25] === 6 ? 4 : 3
  const idat: Buffer[] = []
  for (let o = 8; o < png.length;) { const len = png.readUInt32BE(o); if (png.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len)); o += 12 + len }
  const raw = inflateSync(Buffer.concat(idat)), stride = w * ch, out = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!, line = raw.subarray(y * (stride + 1) + 1), cur = out.subarray(y * stride), prev = y ? out.subarray((y - 1) * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch]! : 0, b = prev ? prev[x]! : 0, c = prev && x >= ch ? prev[x - ch]! : 0
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      cur[x] = (line[x]! + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255
    }
  }
  return { w, h, ch, data: out }
}

beforeAll(async () => {
  // the package's dist/ from this branch: the shell the app meets is the one these commits ship
  const b = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'tsdown', 'dist', 'run.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 })
  if (b.status !== 0) throw new Error(`the package build failed: ${b.stderr || b.stdout}`)
  w = await launchWindow('pw', { extraEnv: { MARVER_APP_FAKE_TRUST: '0' } })
  bin = mkdtempSync(join(tmpdir(), 'mv-app-live-bin-'))
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  root = fixtureRoot('mv-app-live-', {
    'design/config.ts': `export default { share: { name: 'Live canvas' }, jam: { agent: 'claude', concurrency: 1 } }\n`,
    'design/scenes/demo/menu.tsx': MENU,
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [{ key: 'n-menu', frame: 'demo/menu', x: 0, y: 0, w: 390, h: 844 }] }),
  })
  dev = await startDev(root, { env: { MARVER_HOME: w.env.home, MARVER_SLOT_BASE: String(w.slotBase), PATH: `${bin}:${process.env.PATH}` } })
  const s = await w.until((x) => x.tabs.some((t) => t.reg?.port === dev!.port && t.reg.state === 'ready'), 20_000, 'the canvas tab')
  id = s.tabs.find((t) => t.reg?.port === dev!.port)!.id
  await w.run.call('activate', { id })
  await w.until((x) => { const t = x.tabs.find((q) => q.id === id); return x.active === id && !!t?.doc?.trusted && !!t.doc.lifted }, 20_000, 'the canvas lifted')
  await until('the shell and its frame', () => exec<boolean>(`!!window.__mvStore && !!window.__mvJamCapture && window.__mvStore.getState().nodes.length === 1 && window.__mvStore.getState().nodes.every((n) => n.status === 'ready')`), 60_000)
  await exec(`window.__mvJamVoice.getState().setChoice('no'), 1`)   // no microphone question over the stage
}, 300_000)

afterAll(async () => {
  await dev?.stop()
  await w?.close()
  if (root) rmSync(root, { recursive: true, force: true })
  if (bin) rmSync(bin, { recursive: true, force: true })
})

describe('a live picture on a real canvas (A4.6 #35)', () => {
  it('in play, a red panel opened on the stage, then I: the app\'s picture, at the stage\'s size times the display\'s scale, the panel in it', async () => {
    expect(await exec(`typeof window.marverApp?.capture`)).toBe('function')
    await exec(`window.__mvStore.getState().setPlay({ at: 'demo/menu', device: 'mobile', theme: 'light' }), 1`)
    await until('the stage settled on the menu', () => exec<boolean>(`(() => { try { const r = document.querySelector('.sh-play-stage iframe').contentWindow.__mvStage; return r.at === 'demo/menu' && Date.now() - r.t > 1200 } catch { return false } })()`), 30_000)
    await exec(`document.querySelector('.sh-play-stage iframe').contentDocument.getElementById('open').click(), 1`)
    await until('the panel open', () => exec<boolean>(`!!document.querySelector('.sh-play-stage iframe').contentDocument.getElementById('panel')`))
    await sleep(300)
    const geo = await exec<{ x: number; y: number; width: number; height: number; dpr: number }>(`(() => { const r = document.querySelector('.sh-play-stage .dev').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: devicePixelRatio } })()`)
    await exec(`window.__mvJamCapture.getState().start(), 1`)
    const cap = await until('a capture', () => exec<string | null>(`window.__mvJamCapture.getState().current`))
    // a gesture opens the white-out detector's window (a full-view readback every 250 ms, each after the shell answers
    // its probes ask), and I is pressed in that ask, just after the shell's answer: main starts its readback, then ours
    const since = (await w.log()).length
    await exec(`window.marverApp.perf({ kind: 'gesture', on: true, seq: 4242 }), 1`)
    await until('the white-out window', async () => (await w.log('whiteout', since)).some((l) => l.data.window === 'open'), 5_000)
    await exec(`(() => { window.__mvArmed = true; window.__mvArmOff = window.marverApp.onPerfAsk((a) => { if (a.kind === 'probes' && a.at === 'before' && window.__mvArmed) { window.__mvArmed = false; window.__mvJamCapture.getState().picture() } }); return 1 })()`)
    await until('its picture', () => exec<boolean>(`window.__mvJamCapture.getState().caps[${JSON.stringify(cap)}]?.pictures.length === 1`), 30_000)
    await exec(`(() => { window.__mvArmOff(); window.marverApp.perf({ kind: 'gesture', on: false, seq: 4242 }); return 1 })()`)
    await exec(`window.__mvJamCapture.getState().end(true), 1`)
    await until('the draft', () => exec<boolean>(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(cap)} && c.state === 'draft')`), 30_000)
    const rec = await exec<{ timeline: { event: string; id?: string; source?: string }[] }>(`fetch('/__mv/api/jam/capture?id=${cap}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json()).then((b) => b.record)`)
    const step = rec.timeline.find((x) => x.event === 'picture')!
    expect(step.source).toBe('live')
    const ix = JSON.parse(readFileSync(join(root, 'design', '.local', 'jam', 'pictures.json'), 'utf8'))
    expect(ix[step.id!]).toMatchObject({ frame: 'demo/menu', capture: cap, source: 'live' })
    const png = readFileSync(join(root, 'design', '.local', 'jam', ix[step.id!].file))
    const p = pixels(png)
    // the stage's rect, rounded out, times the display's scale (devicePixelRatio: the scale times the page's zoom, 1 here)
    const wantW = (Math.ceil(geo.x + geo.width) - Math.floor(geo.x)) * geo.dpr, wantH = (Math.ceil(geo.y + geo.height) - Math.floor(geo.y)) * geo.dpr
    expect(Math.abs(p.w - wantW)).toBeLessThanOrEqual(2)
    expect(Math.abs(p.h - wantH)).toBeLessThanOrEqual(2)
    // the open panel - a fifth of the stage and more - is there; a render (its panel closed) has none
    let red = 0
    for (let i = 0; i < p.w * p.h; i++) { const o = i * p.ch; if (p.data[o]! > 200 && p.data[o + 1]! < 50 && p.data[o + 2]! < 50) red++ }
    expect(red / (p.w * p.h)).toBeGreaterThan(0.2)
    // main's journal: the readback it answered, and a white-out readback of the same view in flight beside it - one
    // that started before ours ended and ended after ours started (journal order is main's own order)
    const ls = (await w.log(undefined, since)).map((l, i) => ({ ...l, i }))
    expect(ls.some((l) => l.topic === 'live-picture' && l.data.tab === id && l.data.ok === true)).toBe(true)
    const read = (k: string) => ls.find((l) => l.topic === 'live-picture' && l.data.tab === id && l.data.read === k)
    const r0 = read('start'), r1 = read('end')
    expect(!!r0 && !!r1).toBe(true)
    const wo = ls.filter((l) => l.topic === 'whiteout' && typeof l.data.capture === 'string')
    const beside = wo.filter((s) => s.data.capture === 'start' && s.i < r1!.i
      && (wo.find((e) => e.data.capture === 'end' && e.data.tick === s.data.tick && e.i > s.i)?.i ?? Infinity) > r0!.i)
    // spec 30 #39: a play stage covers the canvas, so a 0.30 shell's `before` answer says so and the detector takes no capture
    // here, in a gesture's window too: the picture stands alone (a 0.29 shell still overlaps it, main's code unchanged)
    expect(beside.length, JSON.stringify(ls.filter((l) => l.topic === 'live-picture' || l.data.capture).map((l) => [l.i, l.topic, l.data]))).toBe(0)
    expect(ls.some((l) => l.topic === 'whiteout' && l.data.window === 'open')).toBe(true)
    await exec(`(async () => { const q = window.__mvJamQueue.getState(); const c = (q.cards ?? []).find((x) => x.id === ${JSON.stringify(cap)}); if (c) await q.act(c, 'drop'); window.__mvJamUi.getState().close(); return 1 })()`)
    await exec(`window.__mvStore.getState().setPlay(null), 1`)
  }, 120_000)

  it('asked from a tab that is not the active one: hidden', async () => {
    await w.run.call('activate', { id: 'home' })
    await w.until((x) => x.active === 'home', 10_000, 'Home active')
    expect(await exec(`window.marverApp.capture({ rect: { x: 0, y: 0, width: 10, height: 10 } })`)).toEqual({ ok: false, why: 'hidden' })
    await w.run.call('activate', { id })
    await w.until((x) => x.active === id, 10_000, 'the canvas active')
    // shown again: an answer with bytes (they cross back as an object here; only ok matters)
    expect(await exec(`window.marverApp.capture({ rect: { x: 0, y: 60, width: 10, height: 10 } }).then((a) => a.ok)`)).toBe(true)
  }, 60_000)
})
