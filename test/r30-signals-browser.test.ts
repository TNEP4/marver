import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Spec 30's signals (R3-R6), proven where they happen: a REAL dev server, a REAL browser and the records in
 * design/.local/perf/page.jsonl. Theme switches by transition; modes and when they were shown; every new error source,
 * its bounds and its counted drops; a gesture's scale and what held it; a minute's re-renders. Skips, never fails,
 * without Chrome.
 */

const PORT = 7800 + Math.floor(Math.random() * 300)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
let ORIGIN = `http://localhost:${PORT}`
let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let log = ''

const put = (rel: string, body: string | object) => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}
const board = (name: string, nodes: object[], extra: object = {}) => put(`design/boards/${name}.json`, { version: 1, name, auto: false, ...extra, nodes })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- the log ----------------------------------------------------------------------------------------------------
const pageLog = () => join(root, 'design', '.local', 'perf', 'page.jsonl')
const lines = (): Record<string, any>[] => {
  try { return readFileSync(pageLog(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
const of = (page: string, kind: string) => lines().filter((r) => r.page === page && r.kind === kind).sort((a, b) => a.seq - b.seq)
async function until<T>(fn: () => T | undefined | null | false, ms = 20_000, what = 'a condition'): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const v = fn(); if (v) return v; await wait(100) }
  throw new Error(`timed out waiting for ${what}\nlog tail:\n${lines().slice(-20).map((l) => JSON.stringify(l)).join('\n')}\n${log.slice(-1200)}`)
}
const modeRec = (page: string, mode: string, phase: string) => of(page, 'mode').filter((r) => r.mode === mode && r.phase === phase)
const errorsOf = (page: string, source: string) => of(page, 'error').filter((r) => r.source === source)
const droppedOf = (page: string, reason: string) => of(page, 'dropped').filter((r) => r.reason === reason).reduce((n, r) => n + r.n, 0)
/** Everything waiting goes now. */
const sendNow = (s: string) => browser!.eval(s, 'window.__mvRecorder.send()')

// ---- the page -----------------------------------------------------------------------------------------------------
const opened: string[] = []
/** A fresh tab on a board, its load settled and every frame ready. `pre`: scripts run in every document before its own. */
async function open(name: string, pre: string[] = []): Promise<{ s: string; page: string }> {
  for (const t of opened.splice(0)) await browser!.closeTab(t).catch(() => {})
  const s = await browser!.tab({ width: 1440, height: 900 })
  opened.push(s)
  for (const source of pre) await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source }, s)
  await browser!.go(s, `${ORIGIN}/#/b/${name}`)
  const page = await browser!.until(s, 'window.__mvRecorder?.page', 30_000)
  await until(() => lines().some((r) => r.page === page && (r.kind === 'settled' || (r.kind === 'cut' && !r.request))), 45_000, `${name} to settle`)
  await browser!.until(s, `window.__mvStore.getState().nodes.every((n) => n.missing || n.status !== 'loading')`, 20_000)
  return { s, page }
}
const FRAME = (key: string) => `document.querySelector('[data-node="${key}"] iframe')`
/** Run in a frame's own realm, as the document there would. */
const inFrame = (s: string, key: string, code: string) => browser!.eval(s, `${FRAME(key)}.contentWindow.eval(${JSON.stringify(code)})`)
const inStage = (s: string, code: string) => browser!.eval(s, `document.querySelector('.sh-play-stage iframe').contentWindow.eval(${JSON.stringify(code)})`)
/** This document's animation frames come `ms` later: its acks too. */
const lateFrames = (ms: number) => `(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => setTimeout(() => raf(cb), ${ms}); return true })()`
/** This document's animation frames wait to be released, one at a time (`__raf`). */
const HOLD_FRAMES = `(() => { window.__raf = []; window.requestAnimationFrame = (cb) => { window.__raf.push(cb); return 0 }; return true })()`
const key = async (s: string, k: string, code = k) => {
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code }, s)
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code }, s)
}
const shellError = (s: string, message: string) => browser!.eval(s, `setTimeout(() => { throw new Error(${JSON.stringify(message)}) }), 1`)
/** A module of the shell's own, the instance the page runs (Vite serves it at one URL). */
const shellModule = (name: string) => `import(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/shell/${name}.ts')))`

const SHORT = (ms: number) => `window.__mvSignalsPeriodMs = ${ms}`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-r30-signals-'))
  put('package.json', { name: 'r30-signals-fixture', private: true, type: 'module' })
  const repoRoot = join(import.meta.dirname, '..')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(join(repoRoot, 'node_modules'))) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver' && e !== '@marver-design') symlinkSync(join(repoRoot, 'node_modules', e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  put('design/config.ts', 'export default { jam: false }\n')
  put('design/scenes/kit/a.tsx', 'export default () => <main><h1>a</h1></main>\n')
  put('design/scenes/kit/b.tsx', 'export default () => <main><h1>b</h1></main>\n')
  put('design/scenes/kit/c.tsx', 'export default () => <main><h1>c</h1></main>\n')
  put('design/scenes/kit/broken.tsx', 'export default () => <main><h1>not broken yet</h1></main>\n')
  // a frame whose own module holds the main thread for 120 ms when asked
  put('design/scenes/kit/blocker.tsx', `import { useEffect } from 'react'
export default function Blocker() {
  useEffect(() => { (window as any).__block = () => setTimeout(function block120() { const t = performance.now(); while (performance.now() - t < 120); }, 0) }, [])
  return <main><h1>blocker</h1></main>
}
`)
  // a frame with a button that re-renders it
  put('design/scenes/kit/rerender.tsx', `import { useState } from 'react'
export default function Rerender() {
  const [n, setN] = useState(0)
  return <main><button id="bump" onClick={() => setN((x) => x + 1)}>bump {n}</button></main>
}
`)
  put('design/scenes/deck/s1.tsx', 'export const meta = { slide: true }\nexport default () => <main><h1>one</h1></main>\n')
  put('design/scenes/deck/s2.tsx', 'export const meta = { slide: true }\nexport default () => <main><h1>two</h1></main>\n')
  const at = (key: string, frame: string, x: number, y = 0) => ({ key, frame, x, y, w: 320, h: 240 })
  board('three', [at('k-a', 'kit/a', 0), at('k-b', 'kit/b', 400), at('k-c', 'kit/c', 800)])
  board('offscreen', [at('k-on', 'kit/a', 0), at('k-far', 'kit/b', 60_000)])
  board('pins', [at('k-pa', 'kit/a', 0), at('k-pb', 'kit/b', 400)])
  board('deck', [at('k-s1', 'deck/s1', 0), at('k-s2', 'deck/s2', 400)])
  board('blocker', [at('k-block', 'kit/blocker', 0)])
  board('rerender', [at('k-re', 'kit/rerender', 0)])
  board('broken', [at('k-broken', 'kit/broken', 0)])
  board('thirty', Array.from({ length: 30 }, (_, i) => at(`k-${i}`, 'kit/a', (i % 6) * 360, Math.floor(i / 6) * 280)))
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d; const m = log.match(/→ (http:\/\/localhost:\d+)\//); if (m) ORIGIN = m[1] })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !/→ http:\/\/localhost:\d+\//.test(log)) await wait(100)
  while (Date.now() - t0 < 60_000) { if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break; await wait(200) }
  browser = await Browser.launch()
}, 120_000)

afterAll(async () => {
  browser?.close()
  if (server && server.exitCode === null) {
    const gone = new Promise((r) => server!.once('exit', r))
    try { server.kill('SIGTERM') } catch { /* gone */ }
    await Promise.race([gone, wait(5000)])
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('R3: a theme switch', () => {
  it('D over three visible frames, one of them late: one `theme`, three applied, its slowest what it took', async () => {
    if (!browser) return
    const { s, page } = await open('three')
    await inFrame(s, 'k-b', lateFrames(400))
    await key(s, 'd')
    const t = await until(() => of(page, 'theme')[0], 15_000, 'the theme record')
    expect(t).toMatchObject({ scope: 'view', to: 'dark', frames: 3, applied: 3, outcome: 'done' })
    expect(t.t).toMatch(/^[0-9a-f]{12}$/)
    expect(t.maxMs).toBeGreaterThanOrEqual(400)
    expect(t.p50Ms).toBeLessThan(t.maxMs)
    expect(t.late).toBeUndefined()
    await wait(300)
    await sendNow(s)
    await wait(300)
    expect(of(page, 'theme')).toHaveLength(1)
    // the frames really changed, and their sleep logic still has its ack (`themeOn`)
    expect(await inFrame(s, 'k-b', `document.documentElement.dataset.theme`)).toBe('dark')
    await browser.until(s, `window.__mvStore.getState().nodes.find((n) => n.key === 'k-b').themeOn === 'dark'`, 5_000)
  }, 90_000)

  it('an off-screen frame whose theme changes is not waited for', async () => {
    if (!browser) return
    const { s, page } = await open('offscreen')
    // the camera on the near node: the far one stays off screen, its rAF never runs an ack
    await browser.eval(s, `window.__mvStore.getState().select('k-on')`)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '@', code: 'Digit2', modifiers: 8 }, s)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '@', code: 'Digit2', modifiers: 8 }, s)
    await wait(800)
    expect(await browser.eval(s, `(() => { const r = ${FRAME('k-far')}.getBoundingClientRect(); return r.left > innerWidth })()`), 'the far frame is off screen').toBe(true)
    await browser.eval(s, `window.__mvStore.getState().select(null)`)   // (with a selection, D is that selection's)
    await key(s, 'd')
    const t = await until(() => of(page, 'theme')[0], 15_000, 'the theme record')
    expect(t).toMatchObject({ scope: 'view', frames: 1, applied: 1, outcome: 'done' })
  }, 90_000)

  it('a selection pin is `selection`, over the selected frames', async () => {
    if (!browser) return
    const { s, page } = await open('pins')   // (a pin persists: a board of its own)
    await browser.eval(s, `(() => { const st = window.__mvStore.getState(); st.select('k-pb'); st.setSelectedTheme('dark') })()`)
    const t = await until(() => of(page, 'theme')[0], 15_000, 'the theme record')
    expect(t).toMatchObject({ scope: 'selection', to: 'dark', frames: 1, applied: 1, outcome: 'done' })
  }, 90_000)

  it('a late ack from the previous switch does not finish the next, and a switch during a switch is `superseded` with what it had', async () => {
    if (!browser) return
    const { s, page } = await open('three')
    await inFrame(s, 'k-b', HOLD_FRAMES)
    await key(s, 'd')   // t1: k-a and k-c answer; k-b's first frame waits
    await wait(400)
    await key(s, 'd')   // t2: t1 ends here, with two of three
    const first = await until(() => { void sendNow(s); return of(page, 'theme')[0] }, 3_000, 'the superseded record')
    expect(first).toMatchObject({ to: 'dark', frames: 3, applied: 2, outcome: 'superseded' })
    expect(first.late).toBeUndefined()
    // k-b answers t1 now: t1's two frames, nothing else
    await inFrame(s, 'k-b', `(() => { const [t1a, t2a] = window.__raf.splice(0, 2); t1a(0); window.__raf.unshift(t2a); const t1b = window.__raf.pop(); t1b(0); return true })()`)
    await wait(300)
    await sendNow(s)
    await wait(300)
    expect(of(page, 'theme'), 'the next switch still waits for its own ack').toHaveLength(1)
    // then its own
    await inFrame(s, 'k-b', `(() => { const a = window.__raf.shift(); a(0); const b = window.__raf.shift(); b(0); return true })()`)
    const next = await until(() => { void sendNow(s); return of(page, 'theme')[1] }, 3_000, 'the second record')
    expect(next).toMatchObject({ to: 'light', frames: 3, applied: 3, outcome: 'done' })
    expect(next.t).not.toBe(first.t)
  }, 90_000)

  it('a frame that never acks makes `timeout` at 5 s, with `late: 1`', async () => {
    if (!browser) return
    const { s, page } = await open('three')
    await inFrame(s, 'k-c', HOLD_FRAMES)
    await key(s, 'd')
    const t = await until(() => of(page, 'theme')[0], 12_000, 'the timeout')
    expect(t).toMatchObject({ frames: 3, applied: 2, late: 1, outcome: 'timeout' })
  }, 90_000)

  it('an ack from a document no longer the live one does not count', async () => {
    if (!browser) return
    const { s, page } = await open('three')
    await inFrame(s, 'k-b', HOLD_FRAMES)
    await key(s, 'd')
    // k-b's ack, said by a document that is not the one there now
    await inFrame(s, 'k-b', `(() => { const t = window.__raf.length; window.__mvBoot = 'someone-else'; for (let i = 0; i < 4; i++) { const a = window.__raf.shift(); if (a) a(0) } return t })()`)
    const t = await until(() => of(page, 'theme')[0], 12_000, 'the timeout')
    expect(t).toMatchObject({ frames: 3, applied: 2, late: 1, outcome: 'timeout' })
  }, 90_000)

  it('`by` names the command behind it, when one is', async () => {
    if (!browser) return
    const { s, page } = await open('three')
    const id = await browser.eval(s, `${shellModule('commands')}.then((m) => { const h = m.cmd('theme', { via: 'key', in: 'shell' }); window.__mvStore.getState().setTheme('dark'); return h.id })`)
    const t = await until(() => of(page, 'theme')[0], 15_000, 'the theme record')
    expect(t.by).toBe(id)
    expect(t.by).toMatch(/^[0-9a-f]{12}$/)
  }, 90_000)
})

describe('R4: modes', () => {
  it('C: `mode comments enter` with `shownMs` at the last visible frame\'s ack; C again: `exit` with how long and what broke', async () => {
    if (!browser) return
    const { s, page } = await open('three')
    await inFrame(s, 'k-c', lateFrames(350))
    await key(s, 'c')
    const e = await until(() => modeRec(page, 'comments', 'enter')[0], 15_000, 'the enter')
    expect(e).toMatchObject({ frames: 3, outcome: 'done' })
    expect(e.shownMs).toBeGreaterThanOrEqual(350)
    expect(e.t).toMatch(/^[0-9a-f]{12}$/)
    expect(await inFrame(s, 'k-c', `!!document.getElementById('mv-laser-style')`)).toBe(true)
    // #27: an error says which modes were on, and the exit counts it
    await shellError(s, 'broke while commenting')
    const err = await until(() => errorsOf(page, 'shell').find((r) => r.message === 'broke while commenting'), 10_000, 'the error')
    expect(err.modes).toEqual(['comments'])
    await key(s, 'c')
    const x = await until(() => modeRec(page, 'comments', 'exit')[0], 15_000, 'the exit')
    expect(x.errors).toBe(1)
    expect(x.heldMs).toBeGreaterThan(0)
    expect(x.t).not.toBe(e.t)
    expect(x.shownMs).toBeUndefined()
    // off: an error says none
    await shellError(s, 'broke after')
    const after = await until(() => errorsOf(page, 'shell').find((r) => r.message === 'broke after'), 10_000, 'the second error')
    expect(after.modes).toBeUndefined()
  }, 90_000)

  it('an enter left before its acks came is `superseded`, then its exit', async () => {
    if (!browser) return
    const { s, page } = await open('three')
    await inFrame(s, 'k-a', HOLD_FRAMES)
    await key(s, 'c')
    await wait(200)
    await key(s, 'c')
    const e = await until(() => modeRec(page, 'comments', 'enter')[0], 15_000, 'the enter')
    expect(e).toMatchObject({ frames: 3, outcome: 'superseded' })
    expect(e.shownMs).toBeUndefined()
    await until(() => modeRec(page, 'comments', 'exit')[0], 10_000, 'the exit')
  }, 90_000)

  it('a frame that never answers makes the enter a `timeout` at 5 s', async () => {
    if (!browser) return
    const { s, page } = await open('three')
    await inFrame(s, 'k-a', HOLD_FRAMES)
    await key(s, 'c')
    const e = await until(() => modeRec(page, 'comments', 'enter')[0], 12_000, 'the timeout')
    expect(e).toMatchObject({ frames: 3, outcome: 'timeout' })
  }, 90_000)

  it('L and ⌥L: one out, the other in, each shown by the cohort; `by` names the command', async () => {
    if (!browser) return
    const { s, page } = await open('three')
    await key(s, 'l', 'KeyL')
    const laser = await until(() => modeRec(page, 'laser', 'enter')[0], 15_000, 'laser')
    expect(laser).toMatchObject({ frames: 3, outcome: 'done' })
    const id = await browser.eval(s, `${shellModule('commands')}.then((m) => { const h = m.cmd('inspect', { via: 'key', in: 'shell' }); window.__mvStore.getState().toggleLaser(true); return h.id })`)
    const inspect = await until(() => modeRec(page, 'inspect', 'enter')[0], 15_000, 'inspect')
    expect(inspect).toMatchObject({ frames: 3, outcome: 'done', by: id })
    const out = await until(() => modeRec(page, 'laser', 'exit')[0], 10_000, 'laser out')
    expect(out.seq).toBeLessThan(inspect.seq)
  }, 90_000)

  it('hide-ui, interact and the Jam modes: two animation frames after the change', async () => {
    if (!browser) return
    const { s, page } = await open('three')
    await key(s, 'h')
    const h = await until(() => modeRec(page, 'hide-ui', 'enter')[0], 15_000, 'hide-ui')
    expect(h.outcome).toBe('done')
    expect(h.shownMs).toBeGreaterThanOrEqual(0)
    expect(h.frames).toBeUndefined()
    await key(s, 'h')
    await until(() => modeRec(page, 'hide-ui', 'exit')[0], 10_000, 'hide-ui out')
    await browser.eval(s, `window.__mvStore.getState().setInteract('k-a')`)
    await until(() => modeRec(page, 'interact', 'enter').find((r) => r.outcome === 'done'), 10_000, 'interact')
    await browser.eval(s, `window.__mvStore.getState().setInteract(null)`)
    await until(() => modeRec(page, 'interact', 'exit')[0], 10_000, 'interact out')
    await browser.eval(s, `window.__mvJamUi.setState({ laneKeys: true })`)
    await until(() => modeRec(page, 'jam-lane', 'enter').find((r) => r.outcome === 'done'), 10_000, 'the lane')
    await browser.eval(s, `window.__mvJamUi.setState({ laneKeys: false, panel: { kind: 'review', id: 'c1' } })`)
    await until(() => modeRec(page, 'jam-lane', 'exit')[0], 10_000, 'the lane out')
    await until(() => modeRec(page, 'jam-review', 'enter').find((r) => r.outcome === 'done'), 10_000, 'the review')
    await browser.eval(s, `${shellModule('jam-queue')}.then((m) => { m.useJamQueue.setState({ session: { id: 's1', since: 1 } }); return true })`)
    await until(() => modeRec(page, 'jam-session', 'enter').find((r) => r.outcome === 'done'), 10_000, 'the session')
    await browser.eval(s, `${shellModule('jam-capture')}.then((m) => { m.useJamCapture.setState({ current: 'c1' }); return true })`)
    await until(() => modeRec(page, 'jam-capture', 'enter').find((r) => r.outcome === 'done'), 10_000, 'the capture')
    await browser.eval(s, `${shellModule('jam-capture')}.then((m) => { m.useJamCapture.setState({ current: null }); return true })`)
    await until(() => modeRec(page, 'jam-capture', 'exit')[0], 10_000, 'the capture out')
  }, 90_000)

  it('P: `firstFrameMs` at the stage\'s first shown frame; D waits for the stage alone; a stage error counts on the exit', async () => {
    if (!browser) return
    const { s, page } = await open('three', [SHORT(2500)])
    // a covered frame that never answers holds nothing up
    await inFrame(s, 'k-a', HOLD_FRAMES)
    await key(s, 'p')
    const e = await until(() => modeRec(page, 'play', 'enter')[0], 20_000, 'play')
    expect(e).toMatchObject({ frames: 1, outcome: 'done' })
    expect(e.firstFrameMs).toBeGreaterThan(0)
    expect(e.shownMs).toBeUndefined()
    await browser.until(s, `!!document.querySelector('.sh-play-stage iframe')?.contentWindow?.__mvStage?.at`, 15_000)
    // the stage's ack comes late: that is what the switch took
    await inStage(s, lateFrames(300))
    await key(s, 'd')
    const t = await until(() => of(page, 'theme')[0], 15_000, 'the theme record')
    expect(t).toMatchObject({ scope: 'play', to: 'dark', frames: 1, applied: 1, outcome: 'done' })
    expect(t.maxMs).toBeGreaterThanOrEqual(300)
    expect(await inStage(s, `document.documentElement.dataset.theme`)).toBe('dark')
    // comments in play: the stage's ack
    await inStage(s, `window.__noop = 1`)
    await key(s, 'c')
    const c = await until(() => modeRec(page, 'comments', 'enter')[0], 15_000, 'comments in play')
    expect(c).toMatchObject({ frames: 1, outcome: 'done' })
    await key(s, 'c')
    await until(() => modeRec(page, 'comments', 'exit')[0], 10_000, 'comments out')
    // the stage's own minute of commits
    const row = await until(() => of(page, 'renders').flatMap((r) => r.rows).find((r: Record<string, any>) => r.who === 'stage'), 10_000, 'the stage\'s renders')
    expect(row.commits).toBeGreaterThan(0)
    // a stage error, and the way out
    await inStage(s, `setTimeout(() => { throw new Error('stage boom') }, 0)`)
    const err = await until(() => errorsOf(page, 'stage')[0], 10_000, 'the stage error')
    expect(err.modes).toEqual(['play'])
    await key(s, 'Escape', 'Escape')
    const x = await until(() => modeRec(page, 'play', 'exit')[0], 10_000, 'the exit')
    expect(x.errors).toBe(1)
    expect(x.heldMs).toBeGreaterThan(0)
  }, 120_000)

  it('slides: `firstFrameMs` too', async () => {
    if (!browser) return
    const { s, page } = await open('deck')
    await browser.eval(s, `window.__mvStore.getState().setPlay({ at: 'deck/s1', device: 'slide', theme: 'light', slides: true })`)
    const e = await until(() => modeRec(page, 'slides', 'enter')[0], 20_000, 'slides')
    expect(e).toMatchObject({ frames: 1, outcome: 'done' })
    expect(e.firstFrameMs).toBeGreaterThan(0)
    expect(modeRec(page, 'play', 'enter')).toEqual([])
  }, 90_000)
})

describe('R5: more bugs', () => {
  it('a frame\'s console error: its message as produced, the frame not failed for it; warnings counted, never their text', async () => {
    if (!browser) return
    const { s, page } = await open('three', [SHORT(2500)])
    await inFrame(s, 'k-a', `console.error('frame console %s', 'boom', new Error('inner'))`)
    const e = await until(() => errorsOf(page, 'console').find((r) => r.frame === 'kit/a'), 10_000, 'the console error')
    expect(e.message).toBe('frame console boom inner')
    expect(e.stack?.length).toBeGreaterThan(0)
    expect(await browser.eval(s, `window.__mvStore.getState().nodes.find((n) => n.key === 'k-a').status`)).toBe('ready')
    // the shell's own
    await browser.eval(s, `console.error('shell console boom')`)
    const sh = await until(() => errorsOf(page, 'console').find((r) => r.message === 'shell console boom'), 10_000, 'the shell\'s console error')
    expect(sh.frame).toBeUndefined()
    // warnings: seven in a frame, two in the shell; a minute's count by node, no text
    await inFrame(s, 'k-b', `for (let i = 0; i < 7; i++) console.warn('WARNING-SENTINEL ' + i)`)
    await browser.eval(s, `console.warn('WARNING-SENTINEL shell'); console.warn('WARNING-SENTINEL shell')`)
    const sum = () => of(page, 'warnings').reduce((acc: Record<string, number>, r) => { for (const t of r.top) acc[t.node] = (acc[t.node] ?? 0) + t.n; return acc }, {})
    await until(() => sum()['k-b'] === 7 && sum().shell === 2, 12_000, 'the warnings')
    expect(of(page, 'warnings').reduce((n, r) => n + r.n, 0)).toBe(9)
    expect(readFileSync(pageLog(), 'utf8')).not.toContain('WARNING-SENTINEL')
  }, 90_000)

  it('a refused route, a timeout and a dead network, none with a query; a caller\'s own abort, `perf/*` and a save\'s 409 are not errors', async () => {
    if (!browser) return
    const { s, page } = await open('three')
    // the network, as this test wants it
    const off = browser.on((m) => {
      if (m.method !== 'Fetch.requestPaused' || m.sessionId !== s) return
      const { requestId, request } = m.params
      if (/fail-route/.test(request.url)) void browser!.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }, s).catch(() => {})
      else if (/\/boards\/conflicted/.test(request.url)) void browser!.send('Fetch.fulfillRequest', { requestId, responseCode: 409, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from('{"error":"conflict"}').toString('base64') }, s).catch(() => {})
      // held-route: never answered
    })
    await browser.send('Fetch.enable', { patterns: ['*/api/held-route*', '*/api/fail-route*', '*/api/boards/conflicted*'].map((urlPattern) => ({ urlPattern, requestStage: 'Request' })) }, s)
    const status = await browser.eval(s, `${shellModule('api')}.then((m) => m.api('nope/ROUTE-SENTINEL?q=ROUTE-SENTINEL').then((r) => r.status))`)
    expect(status).toBe(404)
    const refused = await until(() => errorsOf(page, 'api').find((r) => r.status === 404), 10_000, 'the refusal')
    expect(refused).toMatchObject({ route: 'nope/:id', method: 'GET', status: 404 })
    expect(refused.ms).toBeGreaterThanOrEqual(0)
    expect(refused.message).toBe('GET nope/:id 404')

    await browser.eval(s, `${shellModule('api')}.then((m) => m.api('held-route', { signal: AbortSignal.timeout(100) }).catch((e) => e.name))`)
    const timedOut = await until(() => errorsOf(page, 'api').find((r) => r.status === 'timeout'), 10_000, 'the timeout')
    expect(timedOut).toMatchObject({ route: 'held-route', method: 'GET' })

    await browser.eval(s, `${shellModule('api')}.then((m) => m.api('fail-route', { method: 'POST' }).catch((e) => e.name))`)
    const dead = await until(() => errorsOf(page, 'api').find((r) => r.status === 0), 10_000, 'the dead network')
    expect(dead).toMatchObject({ route: 'fail-route', method: 'POST' })

    // a caller's own abort is nothing; a perf route is nothing; a save's 409 is a conflict, a POST's is not
    await browser.eval(s, `${shellModule('api')}.then(async (m) => {
      const c = new AbortController(); const p = m.api('held-route/aborted', { signal: c.signal }).catch(() => {}); c.abort(); await p
      await m.api('perf/nope').catch(() => {})
      await m.api('boards/conflicted', { method: 'PUT', body: '{}' }).catch(() => {})
      await new Promise((r) => setTimeout(r, 1100))
      await m.api('boards/conflicted', { method: 'POST', body: '{}' }).catch(() => {})
      return true
    })`)
    const conflict = await until(() => errorsOf(page, 'api').find((r) => r.status === 409), 10_000, 'the POST\'s 409')
    expect(conflict).toMatchObject({ route: 'boards/:board', method: 'POST' })
    const routes = errorsOf(page, 'api').map((r) => `${r.method} ${r.route} ${r.status}`)
    expect(routes).not.toContain('PUT boards/:board 409')
    expect(routes.filter((r) => r.includes('perf'))).toEqual([])
    expect(routes.filter((r) => r.includes('aborted') || r.endsWith(' 0') && r.includes('held'))).toEqual([])
    expect(readFileSync(pageLog(), 'utf8')).not.toContain('ROUTE-SENTINEL')
    off()
    await browser.send('Fetch.disable', {}, s).catch(() => {})
  }, 90_000)

  it('the shell limits a source to 5 a second before anything else, and what it refuses is counted under that source', async () => {
    if (!browser) return
    const { s, page } = await open('three')
    await sendNow(s)
    await wait(400)
    const before = droppedOf(page, 'api'), kept = errorsOf(page, 'api').length
    // twelve refusals in one turn, each its own message
    await browser.eval(s, `${shellModule('api')}.then(async (m) => {
      const { perfSeams } = await ${shellModule('recorder-seams')}
      for (let i = 0; i < 12; i++) perfSeams.answered.emit({ url: '/__mv/api/route' + i, init: {}, headers: undefined, status: 500, ms: 1 })
      return true
    })`)
    await until(() => errorsOf(page, 'api').length - kept + droppedOf(page, 'api') - before === 12, 10_000, 'twelve accounted for')
    const got = errorsOf(page, 'api').length - kept
    expect(got).toBeGreaterThanOrEqual(1)
    expect(got).toBeLessThanOrEqual(10)   // two wall seconds at most
    expect(droppedOf(page, 'api') - before).toBeGreaterThanOrEqual(2)
  }, 90_000)

  it('a missing image: its path with no query; another origin: its origin alone; the shell\'s own too', async () => {
    if (!browser) return
    const { s, page } = await open('three')
    await inFrame(s, 'k-a', `(() => { const i = document.createElement('img'); i.src = '/design/assets/nope.png?secret=URL-SENTINEL'; document.body.appendChild(i); return true })()`)
    const e = await until(() => errorsOf(page, 'resource').find((r) => r.url === '/design/assets/nope.png'), 10_000, 'the frame\'s image')
    expect(e).toMatchObject({ tag: 'img', frame: 'kit/a' })
    await inFrame(s, 'k-b', `(() => { const i = document.createElement('img'); i.src = 'http://localhost:9/x.png?token=URL-SENTINEL'; document.body.appendChild(i); return true })()`)
    await until(() => errorsOf(page, 'resource').find((r) => r.url === 'http://localhost:9'), 10_000, 'another origin')
    await browser.eval(s, `(() => { const i = document.createElement('img'); i.src = '/shell-nope.png?secret=URL-SENTINEL'; document.body.appendChild(i); return true })()`)
    const sh = await until(() => errorsOf(page, 'resource').find((r) => r.url === '/shell-nope.png'), 10_000, 'the shell\'s image')
    expect(sh.frame).toBeUndefined()
    expect(readFileSync(pageLog(), 'utf8')).not.toContain('URL-SENTINEL')
  }, 90_000)

  it('a broken import: one `vite` record with its repo-relative file and plugin, not an echo in every console', async () => {
    if (!browser) return
    const { s, page } = await open('broken')
    put('design/scenes/kit/broken.tsx', 'export default () => <main><h1>broken</h1></main\n')
    try {
      const v = await until(() => errorsOf(page, 'vite')[0], 25_000, 'the vite error')
      expect(v.file).toBe('design/scenes/kit/broken.tsx')
      expect(typeof v.plugin).toBe('string')
      expect(v.message.length).toBeGreaterThan(0)
      await wait(600)
      await sendNow(s)
      await wait(400)
      expect(errorsOf(page, 'console').filter((r) => /Internal Server Error/.test(r.message))).toEqual([])
    } finally { put('design/scenes/kit/broken.tsx', 'export default () => <main><h1>not broken yet</h1></main>\n') }
  }, 90_000)

  it('Vite\'s socket lost and the canvas back: `hmr lost`, then `back` with how long, before the page reloads itself', async () => {
    if (!browser) return
    const { s, page } = await open('three', [`(() => { if (window.parent !== window) return; const W = window.WebSocket; window.__ws = []; window.WebSocket = new Proxy(W, { construct(t, a) { const x = new t(...a); window.__ws.push(x); return x } }) })()`])
    await browser.eval(s, `window.__ws.filter((x) => x.protocol === 'vite-hmr').forEach((x) => x.close())`)
    const back = await until(() => of(page, 'hmr').find((r) => r.phase === 'back'), 20_000, 'hmr back')
    expect(back.downMs).toBeGreaterThanOrEqual(0)
    const lost = of(page, 'hmr').find((r) => r.phase === 'lost')
    expect(lost).toBeTruthy()
    expect(lost!.seq).toBeLessThan(back.seq)
    // the page reloaded itself on the way: a new document
    await browser.until(s, `window.__mvRecorder?.page && window.__mvRecorder.page !== ${JSON.stringify(page)}`, 20_000)
  }, 90_000)

  it('30 frames logging 100 errors a second are limited in the frame: the shell gets at most the budget, and the counts add up exactly, a frame reloaded mid-burst included', async () => {
    if (!browser) return
    const { s, page } = await open('thirty')
    // what reaches the shell, per document, from a listener of its own
    await browser.eval(s, `(() => {
      window.__got = { console: 0, dropped: 0, perDoc: {} , over: 0, lastFinal: 0 }
      addEventListener('message', (e) => {
        const d = e.data
        if (d?.type === 'sh:console') { __got.console++; __got.perDoc[d.boot] = (__got.perDoc[d.boot] ?? 0) + 1 }
        if (d?.type === 'sh:dropped') { __got.dropped += d.counts.console ?? 0; if (d.final) __got.lastFinal++ }
      })
      window.__calls = 0
      return true
    })()`)
    const burst = `(() => { let i = 0; const started = performance.now(); const go = () => { for (let n = 0; n < 2; n++) { window.parent.__calls++; console.error('burst ' + (window.__mvBoot) + ' ' + (i++)) } if (performance.now() - started < 1500) setTimeout(go, 20) }; go(); return true })()`
    const keys = Array.from({ length: 30 }, (_, i) => `k-${i}`)
    for (const k of keys) await inFrame(s, k, burst)
    // a frame reloaded mid-burst: its old document's last counts go at its teardown
    await wait(400)
    await browser.eval(s, `${FRAME('k-3')}.contentWindow.location.reload()`)
    await browser.until(s, `${FRAME('k-3')}.contentWindow.__mvBoot && document.readyState === 'complete'`, 15_000)
    // the bursts end, and the last counts come
    await wait(4000)
    const got = await browser.eval(s, `window.__got`)
    const calls = await browser.eval(s, `window.__calls`)
    expect(calls).toBeGreaterThan(1500)
    const docs = Object.values(got.perDoc) as number[]
    expect(Math.max(...docs)).toBeLessThanOrEqual(50)
    // at most 5 a second per document: 1.5 s of burst spans at most three wall seconds
    expect(Math.max(...docs)).toBeLessThanOrEqual(15)
    expect(got.console).toBeLessThanOrEqual(docs.length * 15)
    expect(got.lastFinal).toBeGreaterThanOrEqual(1)
    expect(got.console + got.dropped, 'every call either reached the shell or was counted in a sh:dropped').toBe(calls)
    // and the log says the same: recorded + dropped for the source = every call
    await sendNow(s)
    const counted = () => errorsOf(page, 'console').filter((r) => r.frame).length + droppedOf(page, 'console') + droppedOf(page, 'errors')
    await until(() => counted() === calls, 15_000, 'the log to add up').catch(() => expect(counted()).toBe(calls))
    // the shell's own limit for the source: 5 a second, over the burst's few seconds
    expect(errorsOf(page, 'console').length).toBeLessThanOrEqual(30)
    expect(errorsOf(page, 'console').length).toBeLessThan(calls)
    expect(droppedOf(page, 'console')).toBeGreaterThan(0)
  }, 180_000)

  it('the budget comes before formatting or posting: past it, a frame reads no argument and posts nothing', async () => {
    if (!browser) return
    const { s } = await open('three')
    await browser.eval(s, `(() => { window.__posted = 0; addEventListener('message', (e) => { if (e.data?.type === 'sh:console') __posted++ }); return true })()`)
    // forty calls in one turn; only formatting reads the message more than Chrome's own console does
    const reads = await inFrame(s, 'k-b', `(() => {
      let reads = 0
      const e = new Error('y')
      Object.defineProperty(e, 'message', { get() { reads++; return 'formatted' } })
      const perCall = []
      for (let i = 0; i < 40; i++) { const r0 = reads; console.error(e); perCall.push(reads - r0) }
      return perCall
    })()`) as number[]
    await wait(300)
    const posted = await browser.eval(s, `window.__posted`)
    expect(posted).toBeLessThanOrEqual(5)
    expect(posted).toBeGreaterThan(0)
    // the calls past the budget read less than the ones it formatted, and each of them the same
    const past = reads.slice(-5)
    expect(new Set(past).size).toBe(1)
    expect(reads[0]).toBeGreaterThan(past[0])
    expect(reads.filter((r) => r > past[0]).length).toBe(posted)
  }, 90_000)

  it('60 errors in one load: every source shares the load\'s 50, the rest counted; a document\'s first window error always goes', async () => {
    if (!browser) return
    const { s, page } = await open('thirty')
    // twelve frames, five distinct window errors each: within each frame's budget, and no rate of the shell's own
    const keys = Array.from({ length: 12 }, (_, i) => `k-${i}`)
    for (const k of keys) await inFrame(s, k, `(() => { for (let i = 0; i < 5; i++) setTimeout(() => { throw new Error('sixty ${k} ' + i) }, 0); return true })()`)
    await until(() => errorsOf(page, 'frame').length === 50 && droppedOf(page, 'errors') === 10, 20_000, '50 kept, 10 counted')
    // a frame that used its whole budget on the console still fails on its first window error
    const flooded = 'k-20'
    const out = await inFrame(s, flooded, `(() => { for (let i = 0; i < 80; i++) console.error('flood ' + i); setTimeout(() => { throw new Error('the real one') }, 0); return true })()`)
    expect(out).toBe(true)
    await browser.until(s, `window.__mvStore.getState().nodes.find((n) => n.key === '${flooded}').status === 'error'`, 8_000)
  }, 120_000)

  it('the `core` level adds nothing: no console hook, no ack, no `theme`, no `mode`', async () => {
    if (!browser) return
    const { s, page } = await (async () => {
      for (const t of opened.splice(0)) await browser!.closeTab(t).catch(() => {})
      const tab = await browser!.tab({ width: 1440, height: 900 })
      opened.push(tab)
      await browser!.go(tab, `${ORIGIN}/?mvrecorder=core#/b/three`)
      const p = await browser!.until(tab, 'window.__mvRecorder?.page', 30_000)
      await until(() => lines().some((r) => r.page === p && r.kind === 'settled'), 45_000, 'three to settle')
      return { s: tab, page: p }
    })()
    expect(await browser.eval(s, `/mvrecorder=core/.test(${FRAME('k-a')}.src)`)).toBe(true)
    await browser.eval(s, `(() => { window.__said = []; addEventListener('message', (e) => { if (/^sh:(console|warnings|mode-applied|renders|dropped|resource-error)$/.test(e.data?.type)) __said.push(e.data.type) }); return true })()`)
    await key(s, 'd')
    await key(s, 'c')
    await inFrame(s, 'k-a', `console.error('core level'); console.warn('core level'); document.body.appendChild(Object.assign(document.createElement('img'), { src: '/core-nope.png' }))`)
    await wait(1500)
    await sendNow(s)
    await wait(600)
    expect(await browser.eval(s, `window.__said`)).toEqual([])
    // the switch's ack carries no transition
    expect(await browser.eval(s, `window.__mvStore.getState().nodes.find((n) => n.key === 'k-a').themeOn`)).toBe('dark')
    for (const kind of ['theme', 'mode', 'warnings', 'renders', 'hmr']) expect(of(page, kind), kind).toEqual([])
    expect(errorsOf(page, 'console')).toEqual([])
  }, 90_000)
})

describe('R6: zoom, pan and re-renders', () => {
  it('a zoom over a frame that blocks 120 ms names that frame, with the scale it went through and what was awake', async () => {
    if (!browser) return
    const { s, page } = await open('blocker')
    await browser.until(s, `!!${FRAME('k-block')}.contentWindow.__block`, 10_000)
    const wheel = (dy: number) => browser!.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 450, deltaX: 0, deltaY: dy, modifiers: 2 }, s)
    const before = of(page, 'gesture').length
    for (let i = 0; i < 6; i++) {
      await wheel(-40)
      if (i === 2) await inFrame(s, 'k-block', '__block()')
      await wait(40)
    }
    const g = await until(() => { const all = of(page, 'gesture').slice(before); return all.find((x) => x.loaf?.some((l: any) => l.script?.frame === 'kit/blocker')) }, 15_000, 'a gesture naming the frame')
    const l = g.loaf.find((x: any) => x.script?.frame === 'kit/blocker')
    expect(l.ms).toBeGreaterThanOrEqual(100)
    expect(l.script.src).toBe('/design/scenes/kit/blocker.tsx')
    expect(l.script.fn).toBe('block120')
    expect(l.script.ms).toBeGreaterThanOrEqual(100)
    expect(g.loaf.length).toBeLessThanOrEqual(3)
    expect(g.longFrames).toBeGreaterThanOrEqual(1)
    expect(g.scale.to).toBeGreaterThan(g.scale.from)
    expect(g.scale.max).toBeGreaterThanOrEqual(g.scale.to)
    expect(g.scale.min).toBeLessThanOrEqual(g.scale.from)
    expect(g.visible).toBeGreaterThanOrEqual(1)
    expect(g.awake).toBeGreaterThanOrEqual(0)
  }, 90_000)

  it('`by` names the command that started a layout animation', async () => {
    if (!browser) return
    const { s, page } = await open('three')
    const id = await browser.eval(s, `Promise.all([${shellModule('commands')}, ${shellModule('canvas/Canvas')}]).then(([c, v]) => { const h = c.cmd('tidy', { via: 'key', in: 'shell' }); v.animateLayout(500); return h.id })`)
    expect(id).toMatch(/^[0-9a-f]{12}$/)
    const g = await until(() => of(page, 'gesture')[0], 15_000, 'the gesture')
    expect(g).toMatchObject({ type: 'layout', by: id })
    // and a gesture no command started names none
    await wait(100)
    await browser.eval(s, `document.getElementById('sh-world').classList.add('sh-preset')`)
    await wait(400)
    await browser.eval(s, `document.getElementById('sh-world').classList.remove('sh-preset')`)
    const next = await until(() => of(page, 'gesture')[1], 15_000, 'the second gesture')
    expect(next.by).toBeUndefined()
  }, 90_000)

  it('a button that re-renders a frame 10 times gives `commits: 10` in that minute, and none in a still one; a gesture\'s commits count `inGesture`', async () => {
    if (!browser) return
    const PERIOD = 4000
    const { s, page } = await open('rerender', [SHORT(PERIOD)])
    // a fresh period
    const boundary = await browser.eval(s, `(() => { const p = ${PERIOD}; return p - (Date.now() % p) })()`)
    await wait(boundary + 100)
    const minute = await browser.eval(s, `Math.floor(Date.now() / ${PERIOD}) * ${PERIOD}`)
    for (let i = 0; i < 10; i++) await inFrame(s, 'k-re', `document.getElementById('bump').click()`)
    await browser.until(s, `${FRAME('k-re')}.contentDocument.getElementById('bump').textContent === 'bump 10'`, 3_000)
    const rowOf = (m: number) => of(page, 'renders').filter((r) => r.minute === m).flatMap((r) => r.rows).filter((r: Record<string, any>) => r.who === 'k-re')
    const rows = await until(() => { const x = rowOf(minute); return x.length ? x : null }, PERIOD + 8000, 'that minute\'s renders')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ who: 'k-re', frame: 'kit/rerender', commits: 10, inGesture: 0 })
    expect(rows[0].ms).toBeGreaterThan(0)
    expect(rows[0].maxMs).toBeGreaterThan(0)
    expect(rows[0].maxMs).toBeLessThanOrEqual(rows[0].ms)
    // the next two minutes hold still: nothing of this frame in them
    await wait(PERIOD * 2 + 3000)
    await sendNow(s)
    await wait(300)
    const later = of(page, 'renders').filter((r) => r.minute > minute).flatMap((r) => r.rows).filter((r: Record<string, any>) => r.who === 'k-re')
    expect(later).toEqual([])
    // a gesture: the frame heard it start, and its commits count in it
    await browser.eval(s, `document.getElementById('sh-world').classList.add('sh-preset')`)
    await wait(150)
    for (let i = 0; i < 3; i++) await inFrame(s, 'k-re', `document.getElementById('bump').click()`)
    await wait(150)
    await browser.eval(s, `document.getElementById('sh-world').classList.remove('sh-preset')`)
    await wait(150)
    await inFrame(s, 'k-re', `document.getElementById('bump').click()`)
    const moved = await until(() => { const x = of(page, 'renders').filter((r) => r.minute > minute).flatMap((r) => r.rows).filter((r: Record<string, any>) => r.who === 'k-re'); return x.reduce((n: number, r: any) => n + r.commits, 0) >= 4 ? x : null }, PERIOD * 2 + 8000, 'the gesture\'s minute')
    expect(moved.reduce((n: number, r: any) => n + r.inGesture, 0)).toBe(3)
    // the shell's own row
    expect(of(page, 'renders').flatMap((r) => r.rows).some((r: Record<string, any>) => r.who === 'shell')).toBe(true)
  }, 120_000)
})
