import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * A frame at rest costs nothing (sleep.ts): on a real dev canvas,
 *  - an SVG animation (SMIL: <animateTransform>, <animate>) pauses with the CSS ones while its frame sleeps - one left
 *    running repainted and committed the whole page every frame (272 frames: a third of the main thread at rest) - and
 *    resumes where it stood on wake; an <svg> its author paused stays paused through both;
 *  - a frame whose compile the server refuses for the frame's own reason (a looping animation) asks once and then
 *    rests: no ask on a timer (it was every 4 s, forever); it asks again when the source generation moves - a change
 *    anywhere the server watches - and when its own document changes.
 */

const PORT = 5700 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const ORIGIN = `http://localhost:${PORT}`

let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let log = ''
let tab = ''

const SMIL = `import { useEffect, useRef } from 'react'
export const meta = { title: 'Smil' }
export default () => {
  const held = useRef(null)
  useEffect(() => { held.current?.pauseAnimations() }, [])
  return (
    <main style={{ margin: 0, padding: 24, font: '16px system-ui' }}>
      <svg id="spin" width="200" height="200">
        <defs>
          <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="200" y2="200">
            <stop offset="0" stopColor="#f60" /><stop offset="1" stopColor="#06f" />
            <animateTransform attributeName="gradientTransform" type="rotate" from="0 100 100" to="360 100 100" dur="3s" repeatCount="indefinite" />
          </linearGradient>
        </defs>
        <rect width="200" height="200" fill="url(#g)" />
      </svg>
      <svg id="held" ref={held} width="100" height="100">
        <circle cx="50" cy="50" r="20" fill="#333"><animate attributeName="r" values="20;40;20" dur="2s" repeatCount="indefinite" /></circle>
      </svg>
    </main>
  )
}
`
// glass over a looping animation: the compiler refuses it at once (bake.ts LOOPING) and keeps the refusal
const LOOP = (label: string) => `export const meta = { title: 'Loop' }
export default () => (
  <main>
    <style>{\`
      html, body, main { margin: 0; min-height: 100vh }
      main { position: relative; background: linear-gradient(135deg, #ff7a59, #7b61ff); font: 600 18px system-ui }
      .g { position: absolute; left: 40px; top: 40px; width: 300px; padding: 18px; border-radius: 16px; background: rgba(255,255,255,.35); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px) }
      .dot { position: absolute; left: 60px; top: 200px; width: 20px; height: 20px; border-radius: 10px; background: #fff; animation: spin 1s linear infinite }
      @keyframes spin { to { transform: translateX(200px) } }
    \`}</style>
    <div className="g">${label}</div>
    <div className="dot" />
  </main>
)
`
const loopFile = () => join(root, 'design', 'scenes', 'app', 'loop.tsx')
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-sleep-rest-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sleep-rest-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..')
  const repoNm = join(repoRoot, 'node_modules')
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver') symlinkSync(join(repoNm, e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  const scenes = join(root, 'design', 'scenes', 'app')
  mkdirSync(scenes, { recursive: true })
  writeFileSync(join(scenes, 'smil.tsx'), SMIL)
  writeFileSync(loopFile(), LOOP('Looping'))
  const boards = join(root, 'design', 'boards')
  mkdirSync(boards, { recursive: true })
  writeFileSync(join(boards, 'main.json'), JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
    { key: 's1', frame: 'app/smil', x: 0, y: 0, w: 500, h: 300 },
    { key: 'l1', frame: 'app/loop', x: 600, y: 0, w: 500, h: 300 },
  ] }))
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000) {
    const ok = await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)
    if (ok) break
    await wait(200)
  }
  browser = await Browser.launch()
  if (browser) {
    tab = await browser.tab()
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false }, tab)
  }
}, 120_000)

afterAll(() => {
  browser?.close()
  try { server?.kill('SIGTERM') } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true })
})

const skippable = (name: string, fn: () => Promise<void>, ms = 120_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)

const DOC = (frame: string) => `document.querySelector('iframe.sh-live[title="${frame}"]')?.contentDocument`
const ASLEEP = (frame: string) => `!!${DOC(frame)}?.getElementById('mv-sleep')`
const SVG = (id: string) => `${DOC('app/smil')}?.getElementById('${id}')`
const ST = `window.__mvStore.getState()`
const ev = (expr: string) => browser!.eval(tab, expr)
const until = (expr: string, ms = 60_000) => browser!.until(tab, expr, ms)
async function onBoard(): Promise<void> {
  if (await ev(`location.hash === '#/b/main' && !!window.__mvStore`)) return
  await browser!.go(tab, `${ORIGIN}/#/b/main`)
  await until(`${ST}.nodes.length === 2 && ${ST}.nodes.every((n) => n.status === 'ready')`)
}
/** A timeline's clock, read twice `ms` apart: did it move? */
const moves = async (id: string, ms = 400) => { const a = await ev(`${SVG(id)}.getCurrentTime()`); await wait(ms); return (await ev(`${SVG(id)}.getCurrentTime()`)) > a }
/** The bake asks this page sent since the last `asksReset()` (resource timing: every fetch, ours included). */
const asksReset = () => ev(`(performance.clearResourceTimings(), 1)`)
const asks = () => ev(`performance.getEntriesByType('resource').filter((e) => e.name.includes('/__mv/api/bakes')).length`)

describe('a frame at rest costs nothing', () => {
  skippable('an SVG animation pauses while its frame sleeps and resumes on wake; one its author paused stays paused', async () => {
    await onBoard()
    await until(ASLEEP('app/smil'))
    expect(await ev(`${SVG('spin')}.animationsPaused()`)).toBe(true)
    expect(await moves('spin'), 'the rotating gradient holds still asleep').toBe(false)
    // nothing in the page lays out at rest: the paused gradient invalidates no style, no layout
    const layouts = async () => (await browser!.send('Performance.getMetrics', {}, tab)).metrics.find((m: { name: string }) => m.name === 'LayoutCount').value
    await browser!.send('Performance.enable', {}, tab)
    const l0 = await layouts(); await wait(1000); const l1 = await layouts()
    expect(l1 - l0, 'layouts in a second at rest').toBeLessThan(5)
    const at = await ev(`${SVG('spin')}.getCurrentTime()`)
    // the author's own pause is theirs: held asleep, and still held awake
    expect(await ev(`${SVG('held')}.animationsPaused()`)).toBe(true)
    await ev(`${ST}.setInteract('s1')`)
    await until(`!${ASLEEP('app/smil')}`, 5000)
    expect(await ev(`${SVG('spin')}.animationsPaused()`)).toBe(false)
    // resumed where it stood - not jumped ahead by the time it slept
    expect(await ev(`${SVG('spin')}.getCurrentTime()`) - at).toBeLessThan(0.5)
    expect(await moves('spin'), 'the gradient turns again awake').toBe(true)
    expect(await ev(`${SVG('held')}.animationsPaused()`)).toBe(true)
    expect(await moves('held')).toBe(false)
    await ev(`${ST}.setInteract(null)`)
  })

  skippable('a refused frame asks once, then rests: again when the source generation moves, and when its document changes', async () => {
    await onBoard()
    await until(ASLEEP('app/loop'))
    // the refusal landed (the compiler logs it once - kept for the generation) and the frame rests paused, glass live
    await until(`${DOC('app/loop')}.querySelectorAll('[data-mv-sleep]').length === 0 && performance.getEntriesByType('resource').some((e) => e.name.includes('/__mv/api/bakes'))`, 60_000)
    for (let i = 0; i < 100 && !/app\/loop .*stays live: a looping animation/.test(log); i++) await wait(300)
    expect(log).toMatch(/app\/loop .*stays live: a looping animation/)
    await wait(1500)   // an ask already in flight lands
    await asksReset()
    await wait(9000)   // two of the old 4 s retries
    expect(await asks(), 'no ask on a timer at rest').toBe(0)
    expect(await ev(ASLEEP('app/loop'))).toBe(true)
    // the generation moves (a file the server watches, imported by nothing): the parked frame asks again - the same
    // document, never reloaded
    await ev(`(() => { const d = ${DOC('app/loop')}; d.defaultView.__same = 1; return 1 })()`)
    writeFileSync(join(root, 'design', 'touch.txt'), String(Date.now()))
    await until(`performance.getEntriesByType('resource').some((e) => e.name.includes('/__mv/api/bakes'))`, 10_000)
    expect(await ev(`${DOC('app/loop')}.defaultView.__same`)).toBe(1)
    await wait(2500)
    await asksReset()
    await wait(5000)
    expect(await asks(), 'and rests again').toBe(0)
    // its own document changes: it wakes, sleeps again under the new revision, and asks
    writeFileSync(loopFile(), LOOP('Looping, edited'))
    await until(`${DOC('app/loop')}?.body?.textContent.includes('Looping, edited') && performance.getEntriesByType('resource').some((e) => e.name.includes('/__mv/api/bakes'))`, 30_000)
    await until(ASLEEP('app/loop'))
    expect(readFileSync(loopFile(), 'utf8')).toContain('edited')
  })
})
