import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'
import { appendEvents, type CommentEvent } from '../src/server/comments.ts'

/**
 * Captures (spec 27 Part 3) where a person makes them: a REAL dev server with jam on, a fake `claude`
 * on PATH, a REAL browser. S starts a capture, a canvas click is recorded (and clicks nothing), a
 * note joins the timeline, E seals it into a draft; confirm writes its comment and queues it; the
 * agent's run turns it to review; Looks good resolves its thread.
 * Skips without Chrome.
 */

const PORT = 7400 + Math.floor(Math.random() * 400)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
let ORIGIN = `http://localhost:${PORT}`

let root = ''
let bin = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let s = ''
let log = ''

const put = (rel: string, body: string | object) => {
  const f = join(root, rel)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}
const frame = (name: string) => `export default () => <main><h1>${name}</h1></main>\n`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = (expr: string, ms = 20_000) => browser!.until(s, expr, ms)
/** how the fake agent behaves next: { delay, fail } */
const agentMode = (m: { delay?: number; fail?: boolean; create?: string; question?: string; asks?: boolean }) => put('fake-agent.json', m)
/** with MARVER_SHOT_DIR set, a picture of the open thread card (and what hangs off it) */
const shot = async (name: string) => {
  if (!process.env.MARVER_SHOT_DIR) return
  await sleep(250)   // past the fade-in
  const r = await browser!.eval(s, `(() => { const b = document.querySelector('.cm-card').getBoundingClientRect(); return { x: Math.max(0, b.x - 20), y: Math.max(0, b.y - 20), width: Math.min(b.width + 260, innerWidth - b.x + 20), height: b.height + 120 } })()`)
  const out = await browser!.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 2 } }, s)
  writeFileSync(join(process.env.MARVER_SHOT_DIR, `jam-${name}.png`), Buffer.from(out.data, 'base64'))
}
const journal = () => JSON.parse(readFileSync(join(root, 'design', '.local', 'jam-jobs.json'), 'utf8'))

/** A fake `claude -p <goal>`: finds the packet file the goal names, answers every member, prints a
 *  stream-json result line - or exits 1 when told to fail. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs')
const goal = process.argv[process.argv.indexOf('-p') + 1] || ''
const file = (/design\\/\\.local\\/jam\\/packets\\/[\\w-]+\\.json/.exec(goal) || [])[0]
let mode = {}; try { mode = JSON.parse(fs.readFileSync('fake-agent.json', 'utf8')) } catch {}
if (!file || mode.fail) process.exit(1)
const p = JSON.parse(fs.readFileSync(file, 'utf8'))
// told to make a frame: a scene file, and its node on the main board
if (mode.create) {
  fs.writeFileSync('design/scenes/spec/' + mode.create + '.tsx', 'export default () => <main><h1>' + mode.create + '</h1></main>\\n')
  const b = JSON.parse(fs.readFileSync('design/boards/main.json', 'utf8'))
  if (!b.nodes.some((n) => n.frame === 'spec/' + mode.create)) b.nodes.push({ frame: 'spec/' + mode.create, w: 411, h: 700 })
  fs.writeFileSync('design/boards/main.json', JSON.stringify(b, null, 2))
}
const F = '\`\`\`'
const out = p.members.map((m) => F + 'marver-reply ' + m.id + (mode.asks ? ' asks' : '') + '\\nDone: ' + m.brief.asks.map((a) => a.body).join(' + ') + (mode.question ? ' ' + mode.question : '') + '\\n' + F).join('\\n')
setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', result: out }) + '\\n'), mode.delay || 0)
`

// page-side helpers
const HELPERS = `(() => {
  window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); const ce = console.error; console.error = (...a) => { window.__errs.push(a.map(String).join(' ').slice(0, 300)); ce(...a) }
  window.__tag = async (frame, body, thread) => {
    const id = crypto.randomUUID()
    const ev = thread
      ? { id, ts: Date.now(), type: 'reply', commentId: crypto.randomUUID(), parentId: thread, body }
      : { id, ts: Date.now(), type: 'create', commentId: id, frame, nodeKey: window.__mvStore.getState().nodes.find((n) => n.frame === frame).key, body }
    await window.__mvComments.getState().send([ev], 'main')
    return ev.commentId
  }
  window.__tags = async (frame, bodies) => {
    const nodeKey = window.__mvStore.getState().nodes.find((n) => n.frame === frame).key
    const evs = bodies.map((body, i) => { const id = crypto.randomUUID(); return { id, ts: Date.now() + i, type: 'create', commentId: id, frame, nodeKey, body } })
    await window.__mvComments.getState().send(evs, 'main')
    return evs.map((e) => e.commentId)
  }
  window.__icon = () => document.querySelector('.cm-card .cm-tstat')?.getAttribute('data-jam-state') ?? 'none'
})()`

/** Every test starts with the page's own fetch: one that failed with its fetch patched (an upload made to fail, a picture
 *  held) would otherwise fail every test after it. (Some tests carry on from the one before - a capture left recording,
 *  a panel left open - so nothing else is reset.) */
beforeEach(async () => {
  if (!browser || !s) return
  await browser.eval(s, `(() => {
    // the page's fetch as first seen by a test, kept (a reload brings a fresh one, kept again)
    if (!window.__baseFetch) window.__baseFetch = window.fetch
    else window.fetch = window.__baseFetch
    return 1
  })()`).catch(() => null)
})

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-jam-cap-'))
  bin = mkdtempSync(join(tmpdir(), 'mv-jam-cap-bin-'))
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  put('package.json', { name: 'jam-fixture', private: true, type: 'module' })
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  put('design/config.ts', "export default { jam: { agent: 'claude', concurrency: 1 } }\n")
  for (const f of ['alpha', 'bravo', 'charlie']) put(`design/scenes/spec/${f}.tsx`, frame(f))
  put('design/scenes/spec/clicky.tsx', `export default () => <main><button onClick={() => { (window as any).__clicked = ((window as any).__clicked ?? 0) + 1 }}>Save 20%</button><input id="email" defaultValue="" style={{ display: 'block', marginTop: 40, width: 200, height: 30 }} /><div id="rich" contentEditable suppressContentEditableWarning style={{ marginTop: 20, width: 200, height: 30 }}><span id="richspan">Rich text</span></div></main>\n`)
  put('design/boards/main.json', { version: 1, name: 'main', auto: false, order: 0, nodes: [{ frame: 'spec/alpha' }, { frame: 'spec/bravo' }, { frame: 'spec/charlie' }, { frame: 'spec/clicky' }] })
  agentMode({})
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d; const m = log.match(/→ (http:\/\/localhost:\d+)\//); if (m) ORIGIN = m[1] })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !/→ http:\/\/localhost:\d+\//.test(log)) await sleep(100)
  while (Date.now() - t0 < 60_000) { if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break; await sleep(200) }
  browser = await Browser.launch()
  if (!browser) return
  s = await browser.tab({ width: 1400, height: 900 })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS }, s)
  await browser.go(s, `${ORIGIN}/#/b/main`)
  await until(`window.__mvStore?.getState().nodes.length === 4 && !!window.__mvComments && window.__mvStore.getState().nodes.every((n) => n.status === 'ready')`, 45_000)
  // and the board's first fit landed: its frames start as the fit sets off (0.27.1), and four small ones are all ready
  // a quarter of a second before the camera's 0.32 s flight ends - a click aimed at a button aims at the board at rest
  await until(`!!window.__mvJamCanvas && !window.__mvJamCanvas.cameraBusy()`, 5_000)
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

const skippable = (name: string, fn: () => Promise<void>, ms = 90_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)
const open = (thread: string) => browser!.eval(s, `window.__mvComments.getState().setActive(${JSON.stringify(thread)}), 1`)
const click = async (selector: string) => {
  const at = await browser!.eval(s, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  await browser!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y }, s)
  await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
  await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
}
const hover = async (selector: string) => {
  const at = await browser!.eval(s, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  await browser!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y }, s)
}


const key = (k: string, shift = false) => browser!.press(s, k, { shift })
const enter = async () => {
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, s)
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, s)
}
const pic = async (name: string, clip?: { x: number; y: number; width: number; height: number }) => {
  if (!process.env.MARVER_SHOT_DIR) return
  await sleep(300)
  const out = await browser!.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, s)
  writeFileSync(join(process.env.MARVER_SHOT_DIR, `cap-${name}.png`), Buffer.from(out.data, 'base64'))
}
const cardsNow = () => browser!.eval(s, `window.__mvJamQueue.getState().cards ?? []`)
/** Drop (or decide) a capture's card through the queue, and close whatever panel is open. */
const decide = async (id: string, action: string) => { await browser!.eval(s, `(() => { const q = window.__mvJamQueue.getState(); const c = (q.cards ?? []).find((x) => x.id === ${JSON.stringify(id)}); return c ? q.act(c, ${JSON.stringify(action)}) : 1 })()`); await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`) }

describe('captures in the browser', () => {
  skippable('S, a canvas click on a button (recorded, not clicked), a note, E - a draft whose record holds them in time order', async () => {
    await key('s')
    await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    // the overlay keeps the click: find the button's place on screen and click the canvas there
    const at = await browser!.eval(s, `(() => { const n = window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/clicky'); const f = document.querySelector('.sh-node[data-node="' + n.key + '"] iframe'); const b = f.contentDocument.querySelector('button').getBoundingClientRect(); const r = f.getBoundingClientRect(); const sx = r.width / f.clientWidth; return { x: r.left + (b.left + b.width / 2) * sx, y: r.top + (b.top + b.height / 2) * sx } })()`)
    await click(`.sh-node[data-node="${await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/clicky').key`)}"] .sh-overlay`)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
    await until(`(window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.steps ?? []).some((x) => x.event === 'click' && x.bundle?.quote === 'Save 20%')`)
    expect(await browser!.eval(s, `(() => { const n = window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/clicky'); return document.querySelector('.sh-node[data-node="' + n.key + '"] iframe').contentWindow.__clicked ?? 0 })()`)).toBe(0)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('the outline one'), 1`)
    // the lane shows the capture recording as its last tile; the edge ring is teal
    await until(`!!document.querySelector('.jm-lane') && !!document.querySelector('[data-jam-edge]')`, 5000)
    await pic('recording')
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    const rec = await browser!.eval(s, `fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)
    const events = rec.record.timeline.map((x: any) => x.event)
    expect(events[0]).toBe('view')
    expect(events.indexOf('click')).toBeLessThan(events.indexOf('note'))
    expect(rec.record.timeline.find((x: any) => x.event === 'click').frame).toBe('spec/clicky')
    expect(JSON.stringify(rec.record)).not.toContain('"kind"')
    // its read-back opens in the focus panel when capturing stops, its tile selected
    await until(`!!document.querySelector('.jm-focus') && /the outline one/.test(document.querySelector('.jm-focus')?.textContent ?? '')`, 10_000)
    await pic('readback')
  }, 120_000)

  skippable('confirm writes the capture\'s comment and queues it; the agent\'s run turns it to review; Looks good resolves its thread', async () => {
    agentMode({})
    const draft = (await cardsNow()).find((c: any) => c.kind === 'capture' && c.state === 'draft')
    expect(draft).toBeTruthy()
    await enter()
    await until(`window.__mvComments.getState().threads.some((t) => t.id === 'cap-${draft.id}' && t.capture === ${JSON.stringify(draft.id)})`, 40_000)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(draft.id)} && c.state === 'review')`, 30_000)
    await pic('lane-review')
    await key('v')                                                             // the oldest capture to review
    await until(`window.__mvJamUi.getState().panel?.kind === 'review' && !!document.querySelector('.jm-focus')`, 5000)
    await pic('review')
    await enter()                                                  // Looks good
    await until(`window.__mvComments.getState().threads.find((t) => t.id === 'cap-${draft.id}')?.resolved === true`, 40_000)
  }, 120_000)

  skippable('an owned key pressed inside an interacting frame starts and ends a capture there', async () => {
    const k = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/alpha').key`)
    await browser!.eval(s, `window.__mvStore.getState().setInteract?.(${JSON.stringify(k)}) ?? window.__mvStore.setState({ interact: ${JSON.stringify(k)} }), 1`)
    await sleep(300)
    await browser!.eval(s, `(() => { const f = document.querySelector('.sh-node[data-node="${k}"] iframe'); f.contentWindow.focus(); f.contentDocument.body.focus(); return 1 })()`)
    await browser!.eval(s, `(() => { const f = document.querySelector('.sh-node[data-node="${k}"] iframe'); f.contentWindow.dispatchEvent(new f.contentWindow.KeyboardEvent('keydown', { key: 's', bubbles: true })); return 1 })()`)
    await until(`!!window.__mvJamCapture.getState().current`, 5000)
    await browser!.eval(s, `(() => { const f = document.querySelector('.sh-node[data-node="${k}"] iframe'); f.contentWindow.dispatchEvent(new f.contentWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1 })()`)
    await until(`!window.__mvJamCapture.getState().current`, 5000)
  }, 60_000)

  skippable('the notes card: N opens it, E and S typed in it are letters, ⏎ adds a note and keeps it open, Esc closes it - only a second Esc drops the capture', async () => {
    await key('s')
    await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await key('n')
    await until(`!!document.querySelector('.jm-notes textarea, .jm-notes input')`, 3000)
    await browser!.eval(s, `document.querySelector('.jm-notes textarea, .jm-notes input').focus(), 1`)
    for (const ch of 'see E S') await browser!.send('Input.insertText', { text: ch }, s)
    await enter()
    await until(`(window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.steps ?? []).some((x) => x.event === 'note' && x.text === 'see E S')`, 3000)
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().current`)).toBe(id)            // E and S never fired
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().noteOpen`)).toBe(true)
    await browser!.send('Input.insertText', { text: 'left in the field' }, s)
    const esc = async () => { const b = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }; await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...b }, s); await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...b }, s) }
    await esc()
    await until(`!window.__mvJamCapture.getState().noteOpen`, 3000)
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().current`)).toBe(id)            // closing the card never drops
    await key('e', true)                                                                           // text never added is the last note
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    const rec = await browser!.eval(s, `fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)
    expect(rec.record.timeline.filter((x: any) => x.event === 'note').map((x: any) => x.text)).toEqual(['see E S', 'left in the field'])
    // its read-back is open; closed, a click on its tile opens it again, the tile selected
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)}`, 5000)
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    await click(`.jm-lane [data-tile="${id}"]`)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)} && window.__mvJamUi.getState().selected === ${JSON.stringify(id)}`, 5000)
    // K keeps it - its comment posts, it is never queued, and with nothing else pending the lane leaves
    await key('k')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'kept')`, 10_000)
    await until(`window.__mvComments.getState().threads.some((t) => t.capture === ${JSON.stringify(id)})`, 10_000)
    await until(`!document.querySelector('.jm-lane')`, 5000)
  }, 120_000)

  skippable('S while a capture records starts nothing and says so - one at a time; Esc with no notes card open drops it', async () => {
    await key('s')
    await until(`!!window.__mvJamCapture.getState().current`)
    const first = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await sleep(200)
    await key('s')
    await until(`[...document.querySelectorAll('.sh-toast')].some((t) => /press E to end it first/.test(t.textContent))`, 3000)
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().current`)).toBe(first)
    expect(await browser!.eval(s, `Object.keys(window.__mvJamCapture.getState().caps).length`)).toBe(1)
    const b = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...b }, s); await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...b }, s)
    await until(`!window.__mvJamCapture.getState().current`, 3000)
    expect(await browser!.eval(s, `(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(first)})`)).toBe(false)
  }, 60_000)

  skippable('during a review: S, a note, E - the draft binds the review; its read-back opens over it and ⏎ confirms that draft, not the review', async () => {
    agentMode({})
    // a capture to review first
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const r0 = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('first ask'), 1`)
    await key('e', true)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(r0)}`, 30_000)
    await enter()
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(r0)} && c.state === 'review')`, 30_000)
    await key('v')
    await until(`window.__mvJamUi.getState().panel?.kind === 'review' && window.__mvJamUi.getState().panel?.id === ${JSON.stringify(r0)}`, 5000)
    // S during the review, a note, E: the draft binds the review
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const a = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('use your second idea'), 1`)
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(a)} && c.state === 'draft' && c.reviewing?.card === ${JSON.stringify(r0)})`, 40_000)
    await until(`window.__mvJamUi.getState().panel?.kind === 'capture' && window.__mvJamUi.getState().panel?.id === ${JSON.stringify(a)}`, 5000)
    await enter()
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(a)} && c.state !== 'draft')`, 10_000)
    // the review was not approved by that ⏎: confirming the capture sent it back as more work instead
    expect(await browser!.eval(s, `window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(r0)})?.note`)).toBe('more work')
    // clean up the other draft
    await browser!.eval(s, `(() => { const q = window.__mvJamQueue.getState(); const c = q.cards.find((x) => x.state === 'draft'); return c ? q.act(c, 'drop') : 1 })()`)
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
  }, 120_000)

  skippable('an edit then Add to queue: the edit saves first and the capture queues with it', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('raw words'), 1`)
    await key('e', true)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)}`, 30_000)
    // open the editor, type, then click Add to queue (the blur saves the edit)
    await sleep(300); await click('.jm-focus .jm-editable')
    await until(`!!document.querySelector('.jm-focus textarea')`, 3000)
    await browser!.eval(s, `(() => { const t = document.querySelector('.jm-focus textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'make the badge outlined'); t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
    await click('.jm-focus .jm-btn.primary')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state !== 'draft')`, 10_000)
    expect(await browser!.eval(s, `window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(id)})?.edited`)).toBe('make the badge outlined')
    await until(`window.__mvComments.getState().threads.find((t) => t.capture === ${JSON.stringify(id)})?.body === 'make the badge outlined'`, 10_000)
  }, 120_000)

  skippable('in play the stage is the surface: with another frame selected on the canvas, S, I and E record the stage\'s screen, picture it, and never the canvas selection', async () => {
    const clicky = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/clicky').key`)
    await browser!.eval(s, `window.__mvStore.getState().select(${JSON.stringify(clicky)}), 1`)
    await browser!.eval(s, `window.__mvStore.getState().setPlay({ at: 'spec/alpha', device: Object.keys(window.__mvStore.getState().nodes.length ? { mobile: 1 } : {})[0] ?? 'mobile', theme: 'light' }), 1`)
    await until(`!!document.querySelector('iframe[title="play"]')`, 10_000)
    // the stage has mounted its screen (its recorder is installed then)
    await until(`window.__mvStore.getState().stageShown?.at === 'spec/alpha'`, 20_000)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`, 5000)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await sleep(300)                                    // the stage takes the capture's start (a message) before the next input
    await key('i')
    // the stage binds (its recorder answers the hello, however late it mounted): a click in it is recorded
    const hp = await browser!.eval(s, `(() => { const f = document.querySelector('iframe[title="play"]'); const r = f.getBoundingClientRect(); const h = f.contentDocument.querySelector('h1').getBoundingClientRect(); const k = r.width / f.clientWidth; return { x: r.left + (h.left + 10) * k, y: r.top + (h.top + h.height / 2) * k } })()`)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hp.x, y: hp.y }, s)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hp.x, y: hp.y, button: 'left', clickCount: 1 }, s)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hp.x, y: hp.y, button: 'left', clickCount: 1 }, s)
    await until(`(window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.steps ?? []).some((x) => x.event === 'click' && x.mode === 'play')`, 5000)
    // the shell's own navigation, quick revisits included: A -> B -> A -> B, each a line
    for (const at of ['spec/bravo', 'spec/alpha', 'spec/bravo']) await browser!.eval(s, `window.__mvStore.getState().setPlay({ ...window.__mvStore.getState().play, at: ${JSON.stringify(at)} }), 1`)
    // play is left before E: what was seen on the stage keeps the stage's size
    const stageVp = await browser!.eval(s, `window.__mvStore.getState().play.device`)
    await browser!.eval(s, `window.__mvStore.getState().setPlay(null), 1`)
    await sleep(300)
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 20_000)
    const rec = await browser!.eval(s, `fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)
    const tl = rec.record.timeline
    expect(tl[0].view.frames).toEqual(['spec/alpha'])
    expect(tl[0].view.mode).toBe('play')
    expect(tl.some((x: any) => x.event === 'select')).toBe(false)
    const pics = tl.filter((x: any) => x.event === 'picture' && x.why === 'key')
    expect(pics.length).toBeGreaterThan(0)
    expect(pics.every((x: any) => x.frame === 'spec/alpha')).toBe(true)
    expect(tl.filter((x: any) => x.event === 'screen').map((x: any) => x.to)).toEqual(['spec/bravo', 'spec/alpha', 'spec/bravo'])
    // every screen visited keeps the stage's device size, not only the one it ended on
    expect(stageVp).toBeTruthy()
    expect(rec.record.sizes?.['spec/alpha']?.play).toBe(true)
    expect(rec.record.sizes?.['spec/alpha']).toEqual(rec.record.sizes?.['spec/bravo'])
    await browser!.eval(s, `window.__mvStore.getState().setPlay(null), 1`)
    await browser!.eval(s, `(() => { const q = window.__mvJamQueue.getState(); const c = q.cards.find((x) => x.id === ${JSON.stringify(id)}); return c ? q.act(c, 'drop') : 1 })()`)
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
  }, 90_000)

  skippable('a failed edit keeps blocking: Add to queue twice after a rejected save sends nothing, until the edit saves', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('raw'), 1`)
    await key('e', true)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)}`, 30_000)
    // edits fail for now
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch0 = f; window.fetch = (u, o) => (o && o.body && String(o.body).includes('"action":"edit"')) ? Promise.resolve(new Response('{"ok":false}', { status: 409 })) : f(u, o); return 1 })()`)
    await sleep(300); await click('.jm-focus .jm-editable')
    await until(`!!document.querySelector('.jm-focus textarea')`, 3000)
    await browser!.eval(s, `(() => { const t = document.querySelector('.jm-focus textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'my real words'); t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
    await click('.jm-focus .jm-btn.primary')
    await sleep(600)
    await click('.jm-focus .jm-btn.primary')                                        // the second try
    await sleep(600)
    expect(await browser!.eval(s, `window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(id)}).state`)).toBe('draft')
    // edits work again: the next try saves the words first, then queues
    await browser!.eval(s, `(window.fetch = window.__fetch0), 1`)
    await click('.jm-focus .jm-btn.primary')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state !== 'draft' && c.edited === 'my real words')`, 10_000)
  }, 120_000)

  skippable('no capture on Not on a board: S says a board is needed', async () => {
    await browser!.eval(s, `window.__mvStore.setState({ board: '~unplaced' }), 1`)
    await key('s')
    await sleep(300)
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().current`)).toBe(null)
    expect(await browser!.eval(s, `window.__mvStore.getState().toasts.map((t) => t.text).join('|')`)).toMatch(/captures need a board/)
    await browser!.eval(s, `window.__mvStore.setState({ board: 'main' }), 1`)
  }, 30_000)

  skippable('a sealed capture that cannot be sent is kept and sent again with the same id once the dev server answers', async () => {
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch1 = f; window.__fail = 1; window.fetch = (u, o) => (String(u).includes('/api/jam/capture') && o && o.method === 'POST' && window.__fail) ? (window.__fail === 1 ? Promise.reject(new TypeError('offline')) : window.__fail === 3 ? Promise.resolve(new Response('<html>not json</html>', { status: 200 })) : Promise.resolve(new Response('{"ok":false,"error":"jam is not running here"}', { status: 409 }))) : f(u, o); return 1 })()`)
    const kept = (expr: string) => `(() => { const k = Object.keys(localStorage).find((x) => x.startsWith('mv-jam-sealed:')); const all = k ? JSON.parse(localStorage.getItem(k) || '{}') : {}; return ${expr} })()`
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('do not lose me'), 1`)
    await key('e', true)
    // sealed (after its end pictures) and refused by the network: kept here, nothing lost
    await until(kept(`!!all[${JSON.stringify(id)}]?.timeline.some((x) => x.text === 'do not lose me')`), 40_000)
    // the server answers but jam is not running yet (409): still kept, still retried
    await browser!.eval(s, `(window.__fail = 2), 1`)
    await sleep(6000)
    expect(await browser!.eval(s, kept(`!!all[${JSON.stringify(id)}]`))).toBe(true)
    // an answer that cannot be read (a 200 with an HTML fallback) is no acknowledgement either
    await browser!.eval(s, `(window.__fail = 3), 1`)
    await sleep(6000)
    expect(await browser!.eval(s, kept(`!!all[${JSON.stringify(id)}]`))).toBe(true)
    expect(await browser!.eval(s, `(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)})`)).toBe(false)
    await browser!.eval(s, `(window.__fail = 0), 1`)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    expect(await browser!.eval(s, kept(`all[${JSON.stringify(id)}] ?? null`))).toBe(null)
    await browser!.eval(s, `(window.fetch = window.__fetch1), 1`)
    await browser!.eval(s, `(() => { const q = window.__mvJamQueue.getState(); const c = q.cards.find((x) => x.id === ${JSON.stringify(id)}); return c ? q.act(c, 'drop') : 1 })()`)
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
  }, 60_000)

  skippable('a selection is the focus at S, not what the capture keeps seeing: a settled pan and a settled zoom are view steps', async () => {
    const clicky = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/clicky').key`)
    const alpha = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/alpha').key`)
    await browser!.eval(s, `window.__mvStore.getState().select(${JSON.stringify(clicky)}), 1`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().caps[${JSON.stringify(id)}].steps[0].view.frames`)).toEqual(['spec/clicky'])
    // the canvas moves to alpha (clicky stays selected), and settles
    await browser!.eval(s, `window.__mvJamCanvas.fitNodes([${JSON.stringify(alpha)}]), 1`)
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}].steps.some((x) => x.event === 'view' && x !== window.__mvJamCapture.getState().caps[${JSON.stringify(id)}].steps[0] && x.view.frames.includes('spec/alpha'))`, 8000)
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 20_000)
    await browser!.eval(s, `(() => { const q = window.__mvJamQueue.getState(); const c = q.cards.find((x) => x.id === ${JSON.stringify(id)}); return c ? q.act(c, 'drop') : 1 })()`)
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
  }, 60_000)

  skippable('overlapping saves: an older edit saving late never clears a newer one that failed - confirm sends nothing', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('raw'), 1`)
    await key('e', true)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)}`, 30_000)
    // "A" saves slowly and succeeds; "B" fails at once
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch2 = f; window.fetch = (u, o) => { const b = o && o.body ? String(o.body) : ''; if (b.includes('"action":"edit"') && b.includes('"body":"A"')) return new Promise((r) => setTimeout(() => r(f(u, o)), 900)); if (b.includes('"action":"edit"') && b.includes('"body":"B"')) return Promise.resolve(new Response('{"ok":false}', { status: 409 })); return f(u, o) }; return 1 })()`)
    const typeAndBlur = async (text: string) => {
      await sleep(300); await click('.jm-focus .jm-editable')
      await until(`!!document.querySelector('.jm-focus textarea')`, 3000)
      await browser!.eval(s, `(() => { const t = document.querySelector('.jm-focus textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(text)}); t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`); await sleep(150); await browser!.eval(s, `(document.querySelector('.jm-focus textarea')?.blur(), 1)`)
      await until(`!document.querySelector('.jm-focus textarea')`, 3000)
    }
    await typeAndBlur('A')
    await typeAndBlur('B')
    await click('.jm-focus .jm-btn.primary')
    await sleep(2500)
    expect(await browser!.eval(s, `window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(id)}).state`)).toBe('draft')
    await browser!.eval(s, `(window.fetch = window.__fetch2), 1`)
    await browser!.eval(s, `(() => { const q = window.__mvJamQueue.getState(); const c = q.cards.find((x) => x.id === ${JSON.stringify(id)}); return c ? q.act(c, 'drop') : 1 })()`)
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
  }, 90_000)

  skippable('a picture whose body never reads is a missing picture - the capture still seals', async () => {
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch3 = f; window.fetch = (u, o) => String(u).includes('/api/jam/picture') && o && o.method === 'POST' ? Promise.resolve(new Response('not json', { status: 200 })) : f(u, o); return 1 })()`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await key('i')
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    await browser!.eval(s, `(window.fetch = window.__fetch3), 1`)
    const rec = await browser!.eval(s, `fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)
    expect(rec.record.timeline.some((x: any) => x.event === 'missing' && /picture/.test(x.what))).toBe(true)
    // lane K on a draft whose edit failed to save sends nothing
    await browser!.eval(s, `(() => { const f = window.fetch; window.fetch = (u, o) => (o && o.body && String(o.body).includes('"action":"edit"')) ? Promise.resolve(new Response('{"ok":false}', { status: 409 })) : f(u, o); return 1 })()`)
    await sleep(300); await click('.jm-focus .jm-editable')
    await until(`!!document.querySelector('.jm-focus textarea')`, 3000)
    await browser!.eval(s, `(() => { const t = document.querySelector('.jm-focus textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'unsaved words'); t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`); await sleep(150); await browser!.eval(s, `(document.querySelector('.jm-focus textarea')?.blur(), 1)`)
    await sleep(400)
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    await key('q')
    await browser!.eval(s, `window.__mvJamUi.getState().select(${JSON.stringify(id)}), 1`)
    await key('k')
    await sleep(800)
    expect(await browser!.eval(s, `window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(id)}).state`)).toBe('draft')
    await browser!.eval(s, `(window.fetch = window.__fetch3), 1`)
    await browser!.eval(s, `window.__mvJamUi.getState().setLaneKeys(false), 1`)
    await browser!.eval(s, `(() => { const q = window.__mvJamQueue.getState(); const c = q.cards.find((x) => x.id === ${JSON.stringify(id)}); return c ? q.act(c, 'drop') : 1 })()`)
  }, 90_000)

  skippable('a capture from another workspace is refused by this one; going back to the saved words while a save is out still wins', async () => {
    const st = await browser!.eval(s, `fetch('/__mv/api/jam/capture', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' }, body: JSON.stringify({ workspace: 'someone-else', record: { format: 'marver.jam.capture', v: 1, id: 'cap-1700000000000-abcdef', context: { canvas: 'x', board: 'main' }, view: {}, timeline: [], pictures: [] } }) }).then((r) => r.status)`)
    expect(st).toBe(409)
    // revert during a pending save
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('original'), 1`)
    await key('e', true)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)}`, 30_000)
    const typeAndBlur = async (text: string) => {
      await sleep(300); await click('.jm-focus .jm-editable')
      await sleep(300)
      await until(`!!document.querySelector('.jm-focus textarea')`, 3000)
      await browser!.eval(s, `(() => { const t = document.querySelector('.jm-focus textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(text)}); t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`); await sleep(150); await browser!.eval(s, `(document.querySelector('.jm-focus textarea')?.blur(), 1)`)
      await until(`!document.querySelector('.jm-focus textarea')`, 3000)
    }
    await typeAndBlur('saved words')
    await until(`window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(id)})?.edited === 'saved words'`, 5000)
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch4 = f; window.fetch = (u, o) => { const b = o && o.body ? String(o.body) : ''; return b.includes('"action":"edit"') && b.includes('"body":"A"') ? new Promise((r) => setTimeout(() => r(f(u, o)), 900)) : f(u, o) }; return 1 })()`)
    await typeAndBlur('A')
    await typeAndBlur('saved words')                                                  // back, while A is still out
    await click('.jm-focus .jm-btn.primary')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state !== 'draft')`, 10_000)
    expect(await browser!.eval(s, `window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(id)}).edited`)).toBe('saved words')
    await browser!.eval(s, `(window.fetch = window.__fetch4), 1`)
  }, 90_000)

  skippable('two drafts: A\'s failed save never suppresses B\'s edit; an empty edit comes back as empty; a dropped tile leaves while the other keeps the run', async () => {
    const make = async (note: string) => {
      await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
      const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
      await browser!.eval(s, `window.__mvJamCapture.getState().note(${JSON.stringify(note)}), 1`)
      await key('e', true)
      await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
      return id as string
    }
    const a = await make('first'), b = await make('second')
    const edit = async (id: string, text: string) => {
      await browser!.eval(s, `window.__mvJamUi.getState().open({ kind: 'capture', id: ${JSON.stringify(id)} }), 1`)
      await sleep(300); await click('.jm-focus .jm-editable')
      await until(`!!document.querySelector('.jm-focus textarea')`, 3000)
      await browser!.eval(s, `(() => { const t = document.querySelector('.jm-focus textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(text)}); t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`); await sleep(150); await browser!.eval(s, `(document.querySelector('.jm-focus textarea')?.blur(), 1)`)
      await sleep(400)
    }
    // A's save of "X" fails
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch5 = f; window.fetch = (u, o) => (o && o.body && String(o.body).includes('"action":"edit"') && String(o.body).includes(${JSON.stringify(a)})) ? Promise.resolve(new Response('{"ok":false}', { status: 409 })) : f(u, o); return 1 })()`)
    await edit(a, 'X')
    await edit(b, 'X')                                                                   // the same words on B save
    await until(`window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(b)})?.edited === 'X'`, 5000)
    await browser!.eval(s, `(window.fetch = window.__fetch5), 1`)
    // an empty edit is returned as empty, not as no edit
    await edit(b, '')
    await until(`window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(b)})?.edited === ''`, 5000)
    const got = await browser!.eval(s, `fetch('/__mv/api/jam/capture?id=${b}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)
    expect(got.edited).toBe('')
    // drop A while B keeps the run: A's tile leaves at once
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    await browser!.eval(s, `window.__mvJamQueue.getState().act(window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(a)}), 'drop')`)
    await until(`!document.querySelector('.jm-lane [data-tile="${a}"]') && !!document.querySelector('.jm-lane [data-tile="${b}"]')`, 5000)
    await browser!.eval(s, `window.__mvJamQueue.getState().act(window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(b)}), 'drop')`)
  }, 120_000)

  skippable('a canvas dwell belongs to its capture: E then S inside the 0.8 s leaves the next capture without that hover', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const first = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    const k = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/bravo').key`)
    const at = await browser!.eval(s, `(() => { const r = document.querySelector('.sh-node[data-node="${k}"] .sh-overlay').getBoundingClientRect(); return { x: r.x + 40, y: r.y + 60 } })()`)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y }, s)
    await sleep(300)
    await key('e', true)
    await key('s')                                                             // the next capture, before the dwell completes
    await until(`window.__mvJamCapture.getState().current && window.__mvJamCapture.getState().current !== ${JSON.stringify(first)}`, 3000)
    const second = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await sleep(1200)
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().caps[${JSON.stringify(second)}].steps.filter((x) => x.event === 'hover').length`)).toBe(0)
    const esc = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...esc }, s); await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...esc }, s)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(first)})`, 40_000)
    await browser!.eval(s, `window.__mvJamQueue.getState().act(window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(first)}), 'drop')`)
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
  }, 60_000)

  skippable('a click inside a dwell cancels its hover; the lane stays while a capture is still sealing; a failed capture retries from its detail', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    const k = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/bravo').key`)
    const at = await browser!.eval(s, `(() => { const r = document.querySelector('.sh-node[data-node="${k}"] .sh-overlay').getBoundingClientRect(); return { x: r.x + 40, y: r.y + 60 } })()`)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y }, s)
    await sleep(300)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
    await sleep(1200)
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().caps[${JSON.stringify(id)}].steps.filter((x) => x.event === 'hover').length`)).toBe(0)
    // E: while it seals (its end pictures are still out) the lane stays, its tile finishing
    agentMode({ fail: true })
    await key('e', true)
    expect(await browser!.eval(s, `!!document.querySelector('.jm-lane')`)).toBe(true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)}`, 5000)
    await enter()                                                            // confirm: the agent fails it
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'failed')`, 30_000)
    agentMode({})
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    await click(`.jm-lane [data-tile="${id}"]`)
    await until(`[...document.querySelectorAll('.jm-focus .jm-btn')].some((b) => b.textContent === 'Retry')`, 5000)
    await browser!.eval(s, `[...document.querySelectorAll('.jm-focus .jm-btn')].find((b) => b.textContent === 'Retry').click(), 1`)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'review')`, 30_000)
    await browser!.eval(s, `window.__mvJamQueue.getState().act(window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(id)}), 'good')`)
  }, 120_000)
})

describe('captures in the browser: the first trial', () => {
  const esc = async () => { const b = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }; await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...b }, s); await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...b }, s) }
  const clickyKey = () => browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/clicky').key`)

  skippable('a click on a field during a capture puts the caret in it: E, S and N typed there are letters, never capture keys; no numbered badge is drawn; Esc leaves the field, then E ends', async () => {
    await browser!.eval(s, `window.__mvStore.getState().setInteract(null), 1`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await sleep(300)
    const k = await clickyKey()
    const at = await browser!.eval(s, `(() => { const f = document.querySelector('.sh-node[data-node="${k}"] iframe'); const b = f.contentDocument.querySelector('#email').getBoundingClientRect(); const r = f.getBoundingClientRect(); const sx = r.width / f.clientWidth; return { x: r.left + (b.left + b.width / 2) * sx, y: r.top + (b.top + b.height / 2) * sx } })()`)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y }, s)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
    // the click is recorded (with its number), the frame turns interactive and the field has the caret
    await until(`(window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.steps ?? []).some((x) => x.event === 'click' && x.point >= 1)`)
    await until(`window.__mvStore.getState().interact === ${JSON.stringify(k)} && document.querySelector('.sh-node[data-node="${k}"] iframe').contentDocument.activeElement?.id === 'email'`, 5000)
    expect(await browser!.eval(s, `document.querySelectorAll('.jm-pt').length`)).toBe(0)
    for (const ch of ['e', 's', 'n', 'e']) await browser!.press(s, ch)
    await sleep(300)
    expect(await browser!.eval(s, `document.querySelector('.sh-node[data-node="${k}"] iframe').contentDocument.querySelector('#email').value`)).toBe('esne')
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().current`)).toBe(id)
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().noteOpen`)).toBe(false)
    // rich text: a click on a span inside an editable area puts the caret in its editing host
    await esc()
    await until(`window.__mvStore.getState().interact === null`, 3000)
    const at2 = await browser!.eval(s, `(() => { const f = document.querySelector('.sh-node[data-node="${k}"] iframe'); const b = f.contentDocument.querySelector('#richspan').getBoundingClientRect(); const r = f.getBoundingClientRect(); const sx = r.width / f.clientWidth; return { x: r.left + (b.left + b.width / 2) * sx, y: r.top + (b.top + b.height / 2) * sx } })()`)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at2.x, y: at2.y, button: 'left', clickCount: 1 }, s)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at2.x, y: at2.y, button: 'left', clickCount: 1 }, s)
    await until(`window.__mvStore.getState().interact === ${JSON.stringify(k)} && document.querySelector('.sh-node[data-node="${k}"] iframe').contentDocument.activeElement?.id === 'rich'`, 5000)
    await browser!.press(s, 'e')
    await sleep(300)
    expect(await browser!.eval(s, `document.querySelector('.sh-node[data-node="${k}"] iframe').contentDocument.querySelector('#rich').textContent`)).toBe('Rich texte')
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().current`)).toBe(id)
    // Esc leaves the field and interact - the capture still records; E now ends it
    await esc()
    await until(`window.__mvStore.getState().interact === null`, 3000)
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().current`)).toBe(id)
    await sleep(200)
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    await decide(id, 'drop')
  }, 90_000)

  skippable('Resume: R in a read-back records on where it stopped - the draft steps aside, and the new end takes its place with both parts; Esc on a resumed capture gives the draft back', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const a = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('first part'), 1`)
    await key('e', true)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(a)}`, 30_000)
    await sleep(200)
    await key('r')
    await until(`!!window.__mvJamCapture.getState().current && window.__mvJamCapture.getState().current !== ${JSON.stringify(a)}`, 5000)
    const b1 = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    expect(await browser!.eval(s, `window.__mvJamUi.getState().panel`)).toBeNull()
    await until(`!document.querySelector('.jm-lane [data-tile="${a}"]')`, 3000)
    // the lane's keys never reach the draft that stepped aside
    expect(await browser!.eval(s, `window.__mvJamUi.getState().selected`)).not.toBe(a)
    await key('q'); await sleep(100)
    expect(await browser!.eval(s, `window.__mvJamUi.getState().selected`)).not.toBe(a)
    await browser!.eval(s, `window.__mvJamUi.getState().setLaneKeys(false), 1`)
    // the resumed capture carries the first part already, then what is on screen as it resumes
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().caps[${JSON.stringify(b1)}].steps.filter((x) => x.event === 'note').map((x) => x.text)`)).toEqual(['first part'])
    expect(await browser!.eval(s, `(() => { const c = window.__mvJamCapture.getState().caps[${JSON.stringify(b1)}]; const v = c.steps.filter((x) => x.event === 'view'); return v.length >= 2 && v[v.length - 1].at > c.resumes.at })()`)).toBe(true)
    // Esc: the resumed capture goes, the draft is back as it was
    await esc()
    await until(`!window.__mvJamCapture.getState().current && !!document.querySelector('.jm-lane [data-tile="${a}"]')`, 5000)
    expect(await browser!.eval(s, `window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(a)}).state`)).toBe('draft')
    // again, this time to the end: the Resume button in its read-back
    await click(`.jm-lane [data-tile="${a}"]`)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(a)}`, 5000)
    await browser!.eval(s, `[...document.querySelectorAll('.jm-focus .jm-btn')].find((b) => /Resume/.test(b.textContent)).click(), 1`)
    await until(`!!window.__mvJamCapture.getState().current`, 5000)
    const b = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('second part'), 1`)
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(b)} && c.state === 'draft') && (window.__mvJamQueue.getState().cards ?? []).find((c) => c.id === ${JSON.stringify(a)})?.state !== 'draft'`, 30_000)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(b)} && /first part/.test(document.querySelector('.jm-focus').textContent) && /second part/.test(document.querySelector('.jm-focus').textContent)`, 10_000)
    expect(await browser!.eval(s, `!!document.querySelector('.jm-lane [data-tile="${a}"]')`)).toBe(false)
    await decide(b, 'drop')
  }, 120_000)

  skippable('the lane: one tile width, selected or not, 10 px apart; a title cut short shows whole in the shell\'s tooltip; a right-click opens the tile\'s menu and Rename names it', async () => {
    const long = 'make the checkout badge outlined and move the footer link under the price, with more room above'
    const ids: string[] = []
    for (const note of [long, 'short']) {
      await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
      ids.push(await browser!.eval(s, `window.__mvJamCapture.getState().current`))
      await browser!.eval(s, `window.__mvJamCapture.getState().note(${JSON.stringify(note)}), 1`)
      await key('e', true)
      await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(ids[ids.length - 1])} && c.state === 'draft')`, 30_000)
      await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
      await sleep(150)
    }
    const [a, b] = ids
    const width = (id: string) => browser!.eval(s, `document.querySelector('.jm-lane [data-tile="${id}"]').getBoundingClientRect().width`)
    const wa = await width(a), wb = await width(b)
    expect(wa).toBe(wb)
    await browser!.eval(s, `window.__mvJamUi.getState().select(${JSON.stringify(a)}), 1`)
    await sleep(100)
    expect(await width(a)).toBe(wa)
    const gap = await browser!.eval(s, `(() => { const x = document.querySelector('.jm-lane [data-tile="${a}"]').getBoundingClientRect(), y = document.querySelector('.jm-lane [data-tile="${b}"]').getBoundingClientRect(); return Math.round(y.left - x.right) })()`)
    expect(gap).toBe(10)
    // the tooltip: the shell's own, the whole title - only for the title cut short (the pointer comes in
    // from elsewhere: it may already rest where the tile now is)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 300 }, s)
    await hover(`.jm-lane [data-tile="${a}"] .t`)
    await until(`/move the footer link under the price, with more room above/.test(document.querySelector('.sh-tip')?.textContent ?? '')`, 3000)
    expect(await browser!.eval(s, `document.querySelector('.jm-lane [data-tile="${a}"]').getAttribute('title')`)).toBeNull()
    await hover(`.jm-lane [data-tile="${b}"] .t`)
    await sleep(400)
    expect(await browser!.eval(s, `document.querySelector('.sh-tip')?.textContent ?? ''`)).toBe('')
    // right-click: the draft's menu; Rename names the tile
    const at = await browser!.eval(s, `(() => { const r = document.querySelector('.jm-lane [data-tile="${b}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'right', clickCount: 1 }, s)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'right', clickCount: 1 }, s)
    await until(`!!document.querySelector('.sh-ctxmenu')`, 3000)
    const items = await browser!.eval(s, `[...document.querySelectorAll('.sh-ctxmenu button')].map((b) => b.textContent)`)
    expect(items).toEqual(['Open read-back', 'Resume capture', 'Rename', 'Add to queue', 'Keep, do not send', 'Drop'])
    // one icon per action: no two alike
    const icons = await browser!.eval(s, `[...document.querySelectorAll('.sh-ctxmenu button svg')].map((x) => x.innerHTML)`)
    expect(new Set(icons).size).toBe(items.length)
    await browser!.eval(s, `[...document.querySelectorAll('.sh-ctxmenu button')].find((b) => b.textContent === 'Rename').click(), 1`)
    await until(`!!document.querySelector('.jm-rename input')`, 3000)
    await browser!.eval(s, `document.querySelector('.jm-rename input').focus(), 1`)
    await browser!.eval(s, `(() => { const t = document.querySelector('.jm-rename input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(t, 'Badge fix'); t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
    await enter()
    await until(`document.querySelector('.jm-lane [data-tile="${b}"] .t')?.textContent === 'Badge fix'`, 5000)
    expect(await browser!.eval(s, `!!document.querySelector('.sh-ctxmenu')`)).toBe(false)
    // (every frame on screen first: where the canvas last fitted depends on the frames the captures touched)
    { const b = { key: '!', code: 'Digit1', windowsVirtualKeyCode: 49, modifiers: 8 }; await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...b }, s); await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...b }, s) }
    await sleep(700)
    // a click anywhere else on the canvas - empty space or a frame - lets a selected tile go (no panel open)
    for (const where of ['empty', 'frame']) {
      await browser!.eval(s, `(window.__mvJamUi.getState().close(), window.__mvJamUi.getState().select(${JSON.stringify(a)}), 1)`)
      await sleep(100)
      const p = await browser!.eval(s, where === 'empty'
        ? `(() => { const r = document.querySelector('.sh-canvas').getBoundingClientRect(); for (let y = r.top + 120; y < r.bottom - 120; y += 20) for (let x = r.left + 300; x < r.right - 20; x += 20) { const e = document.elementFromPoint(x, y); if (e && e.closest('.sh-canvas') && !e.closest('.sh-node, .sh-pill, .sh-pill-fab, .jm-lane, .sh-toasts, .sh-banner')) return { x, y } } return null })()`
        : `(() => { const r = document.querySelector('.sh-node .sh-overlay').getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20 } })()`)
      await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }, s)
      await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }, s)
      await until(`window.__mvJamUi.getState().selected === null && !document.querySelector('.jm-lane .jm-card.focus')`, 3000)
    }
    // inside an interactive frame too (its clicks never reach the shell's document - the frame says so)
    const k = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/clicky').key`)
    await browser!.eval(s, `(window.__mvStore.getState().setInteract(${JSON.stringify(k)}), window.__mvJamUi.getState().select(${JSON.stringify(a)}), 1)`)
    await sleep(300)
    const inside = await browser!.eval(s, `(() => { const f = document.querySelector('.sh-node[data-node="${k}"] iframe'); const b = f.contentDocument.querySelector('button').getBoundingClientRect(); const r = f.getBoundingClientRect(); const sx = r.width / f.clientWidth; return { x: r.left + (b.left + b.width / 2) * sx, y: r.top + (b.top + b.height / 2) * sx } })()`)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: inside.x, y: inside.y, button: 'left', clickCount: 1 }, s)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: inside.x, y: inside.y, button: 'left', clickCount: 1 }, s)
    await until(`window.__mvJamUi.getState().selected === null`, 3000)
    await browser!.eval(s, `window.__mvStore.getState().setInteract(null), 1`)
    // the lane's keys with nothing selected act on nothing: ⌫ drops no fallback tile
    await browser!.eval(s, `(window.__mvJamUi.getState().select(null), window.__mvJamUi.getState().setLaneKeys(true), 1)`)
    const bs = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...bs }, s); await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...bs }, s)
    await sleep(300)
    expect(await browser!.eval(s, `[${JSON.stringify(a)}, ${JSON.stringify(b)}].map((id) => window.__mvJamQueue.getState().cards.find((c) => c.id === id).state)`)).toEqual(['draft', 'draft'])
    await browser!.eval(s, `window.__mvJamUi.getState().setLaneKeys(false), 1`)
    for (const id of ids) await decide(id, 'drop')
  }, 120_000)

  skippable('the panel: wide enough for its footer on one line, the close button clear of the arrows; a click anywhere else on the canvas, or a comment opening, closes it and lets its tile go', async () => {
    const ids: string[] = []
    for (const note of ['first one', 'second one']) {
      await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
      ids.push(await browser!.eval(s, `window.__mvJamCapture.getState().current`))
      await browser!.eval(s, `window.__mvJamCapture.getState().note(${JSON.stringify(note)}), 1`)
      await key('e', true)
      await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(ids[ids.length - 1])}`, 30_000)
    }
    const [a, b] = ids
    // the read-back of b: "2 of 2", the arrows and the X never overlap; "For Claude Code" on one line
    const geo = await browser!.eval(s, `(() => { const r = (el) => el.getBoundingClientRect(); const x = r(document.querySelector('.jm-focus-x')); const arrows = [...document.querySelectorAll('.jm-focus .top .jm-iconbtn')].map(r); const dim = document.querySelector('.jm-focus .actions .dim'); return { overlap: arrows.some((q) => q.right > x.left && q.left < x.right && q.bottom > x.top && q.top < x.bottom), lines: new Set([...(() => { const g = document.createRange(); g.selectNodeContents(dim); return g.getClientRects() })()].map((q) => Math.round(q.top))).size, width: r(document.querySelector('.jm-focus')).width } })()`)
    expect(geo.overlap).toBe(false)
    expect(geo.lines).toBeLessThanOrEqual(1)
    expect(geo.width).toBeGreaterThanOrEqual(580)
    // a click inside the panel keeps it; on another tile switches it; on the canvas closes it and lets go
    await click('.jm-focus .meta')
    await sleep(150)
    expect(await browser!.eval(s, `window.__mvJamUi.getState().panel?.id`)).toBe(b)
    await click(`.jm-lane [data-tile="${a}"]`)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(a)} && window.__mvJamUi.getState().selected === ${JSON.stringify(a)}`, 3000)
    const empty = await browser!.eval(s, `(() => { const r = document.querySelector('.sh-canvas').getBoundingClientRect(); for (let y = r.top + 120; y < r.bottom - 120; y += 20) for (let x = r.right - 40; x > r.left + 300; x -= 20) { const e = document.elementFromPoint(x, y); if (e && e.closest('.sh-canvas') && !e.closest('.sh-node, .sh-pill, .sh-pill-fab, .jm-lane, .jm-focus, .sh-toasts, .sh-banner')) return { x, y } } return null })()`)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: empty.x, y: empty.y, button: 'left', clickCount: 1 }, s)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: empty.x, y: empty.y, button: 'left', clickCount: 1 }, s)
    await until(`window.__mvJamUi.getState().panel === null && window.__mvJamUi.getState().selected === null && !document.querySelector('.jm-focus')`, 3000)
    // a frame click too
    await click(`.jm-lane [data-tile="${b}"]`)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(b)}`, 3000)
    const f = await browser!.eval(s, `(() => { const r = [...document.querySelectorAll('.sh-node .sh-overlay')].map((x) => x.getBoundingClientRect()).find((q) => q.left > document.querySelector('.jm-focus').getBoundingClientRect().right + 10); return r ? { x: r.x + 20, y: r.y + 20 } : null })()`)
    if (f) {
      await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: f.x, y: f.y, button: 'left', clickCount: 1 }, s)
      await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: f.x, y: f.y, button: 'left', clickCount: 1 }, s)
      await until(`window.__mvJamUi.getState().panel === null && window.__mvJamUi.getState().selected === null`, 3000)
    }
    // a comment opening takes the panel's place
    await click(`.jm-lane [data-tile="${a}"]`)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(a)}`, 3000)
    const t = await browser!.eval(s, `window.__tag('spec/alpha', 'a plain note')`)
    await until(`window.__mvComments.getState().threads.some((x) => x.id === ${JSON.stringify(t)})`, 5000)
    await browser!.eval(s, `window.__mvComments.getState().setActive(${JSON.stringify(t)}), 1`)
    await until(`window.__mvJamUi.getState().panel === null && window.__mvJamUi.getState().selected === null`, 3000)
    await browser!.eval(s, `window.__mvComments.getState().setActive(null), 1`)
    for (const id of ids) await decide(id, 'drop')
    // More work words survive a click elsewhere: back on the review, the composer is open with them
    agentMode({})
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const r = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('make it blue'), 1`)
    await key('e', true)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(r)}`, 30_000)
    await enter()
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(r)} && c.state === 'review')`, 30_000)
    await key('v')
    await until(`window.__mvJamUi.getState().panel?.kind === 'review'`, 5000)
    await browser!.eval(s, `window.__mvJamUi.getState().setMoreOpen(true), 1`)
    await until(`!!document.querySelector('.jm-more textarea')`, 3000)
    await browser!.eval(s, `(() => { const t = document.querySelector('.jm-more textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'and a bit darker'); t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
    await sleep(100)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: empty.x, y: empty.y, button: 'left', clickCount: 1 }, s)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: empty.x, y: empty.y, button: 'left', clickCount: 1 }, s)
    await until(`window.__mvJamUi.getState().panel === null`, 3000)
    await key('v')
    await until(`window.__mvJamUi.getState().panel?.kind === 'review' && document.querySelector('.jm-more textarea')?.value === 'and a bit darker'`, 5000)
    await browser!.eval(s, `window.__mvJamQueue.getState().act(window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(r)}), 'good')`)
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
  }, 150_000)

  skippable('a capture is about the frames you touched: with four on screen and one selected, E pictures that one alone, once - its card names it alone; with none touched, one picture', async () => {
    const getRec = (id: string) => browser!.eval(s, `fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)
    // one frame selected as it starts
    const k = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/bravo').key`)
    await browser!.eval(s, `(window.__mvStore.getState().select(${JSON.stringify(k)}), 1)`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('just this one'), 1`)
    // dragged to another width after it was touched: pictured as it is now
    await browser!.eval(s, `window.__mvStore.getState().resizeNode(${JSON.stringify(k)}, 411, 777), 1`)
    await sleep(200)
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    const rec = await getRec(id)
    const pics = rec.record.timeline.filter((x: any) => x.event === 'picture')
    expect(pics.map((x: any) => x.frame)).toEqual(['spec/bravo'])
    expect((await cardsNow()).find((c: any) => c.id === id).frames).toEqual(['spec/bravo'])
    // its size as it was on screen, for the run's pictures
    expect(rec.record.sizes?.['spec/bravo']).toMatchObject({ w: 411, h: 777 })
    // a note added in its read-back, after it ended: under a divider; what is typed there is never a capture key
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)} && !!document.querySelector('[data-jam-addnote]')`, 10_000)
    await click('[data-jam-addnote]')
    await browser!.send('Input.insertText', { text: 'see the edges' }, s)
    for (const ch of ['s', 'e']) await browser!.press(s, ch)
    await enter()
    await until(`(window.__mvJamQueue.getState().cards ?? []).find((c) => c.id === ${JSON.stringify(id)})?.added?.[0]?.text === 'see the edgesse'`, 5000)
    await until(`/Added after/.test(document.querySelector('[data-jam-added]')?.textContent ?? '') && !!document.querySelector('[data-jam-added-note]')`, 5000)
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().current`)).toBeNull()
    await decide(id, 'drop')
    // nothing touched: one picture, of where it began
    await browser!.eval(s, `(window.__mvStore.getState().select(null), 1)`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id2 = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('somewhere here'), 1`)
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id2)} && c.state === 'draft')`, 30_000)
    const rec2 = await getRec(id2)
    expect(rec2.record.timeline.filter((x: any) => x.event === 'picture')).toHaveLength(1)
    await decide(id2, 'drop')
  })

  skippable('a capture at its picture limit still seals: E waits only for pictures actually under way', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    const ka = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/alpha').key`)
    // twelve pictures of alpha (the limit)
    // (one at a time, each awaited - a picture that fails is asked for again)
    for (let i = 0; i < 30; i++) {
      const n = await browser!.eval(s, `window.__mvJamCapture.getState().caps[${JSON.stringify(id)}].pictures.length`)
      if (n >= 12) break
      await browser!.eval(s, `window.__mvJamCapture.getState().picture('spec/alpha'), 1`)
      await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}].shots === 0`, 20_000)
    }
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().caps[${JSON.stringify(id)}].pictures.length`)).toBe(12)
    // then bravo touched (selected) - its end picture is refused at the limit
    const kb = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/bravo').key`)
    await browser!.eval(s, `(window.__mvStore.getState().select(${JSON.stringify(kb)}), 1)`)
    await sleep(300)
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    void ka
    await decide(id, 'drop')
    await browser!.eval(s, `(window.__mvStore.getState().select(null), 1)`)
  })

  skippable('a capture whose run made a new frame and left its own as it was: its review shows the new frame as New (no Before), and its thread moves onto it', async () => {
    agentMode({ create: 'fresh' })
    const ka = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/alpha').key`)
    await browser!.eval(s, `(window.__mvStore.getState().select(${JSON.stringify(ka)}), 1)`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('a brand new frame to the right of this one'), 1`)
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    await decide(id, 'confirm')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'review')`, 60_000)
    agentMode({})
    const c = (await cardsNow()).find((x: any) => x.id === id)
    expect(c.shots.find((x: any) => x.frame === 'spec/fresh')?.new).toBe(true)
    expect(c.frames).toContain('spec/fresh')
    // the review: the new frame, tagged New, no Before/After
    await click(`.jm-lane [data-tile="${id}"]`)
    await until(`!!document.querySelector('[data-jam-review]') && /New/.test(document.querySelector('[data-jam-review] .jm-fbar')?.textContent ?? '')`, 10_000)
    expect(await browser!.eval(s, `!!document.querySelector('[data-jam-review] [data-jam-new]') && !document.querySelector('[data-jam-review] [data-jam-flip]')`)).toBe(true)
    // its thread is on the new frame now
    await until(`(window.__mvComments.getState().threads ?? []).some((t) => t.id === ${JSON.stringify('cap-' + id)} && t.frame === 'spec/fresh')`, 30_000)
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    await decide(id, 'good')
  })

  skippable('a note still saving when the capture is added to the queue goes with it (the decision waits for it)', async () => {
    // a clean start: nothing recording, no panel open (a test before it that failed may have left one)
    await browser!.eval(s, `(() => { const c = window.__mvJamCapture.getState(); if (c.current) c.drop(); window.__mvJamUi.getState().close(); return 1 })()`)
    await until(`!window.__mvJamCapture.getState().current && !window.__mvJamUi.getState().panel`, 5000)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('slow note test'), 1`)
    await key('e', true)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)} && !!document.querySelector('[data-jam-addnote]')`, 30_000)
    // the note's save is held for a moment
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch5 = f; window.fetch = async (u, o) => { if (String(u).includes('/api/jam/card') && o?.body && String(o.body).includes('"action":"note"')) await new Promise((r) => setTimeout(r, 1500)); return f(u, o) }; return 1 })()`)
    try {
      await click('[data-jam-addnote]')
      await browser!.send('Input.insertText', { text: 'the late note' }, s)
      await enter()
      await sleep(100)
      await click('[data-jam-readback] .actions .jm-btn.primary')                  // Add to queue, the note still out
      await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state !== 'draft')`, 10_000)
    } finally { await browser!.eval(s, `(window.fetch = window.__fetch5), 1`) }
    expect((await cardsNow()).find((c: any) => c.id === id).added?.map((x: any) => x.text)).toEqual(['the late note'])
    agentMode({})
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'review')`, 60_000)
    await decide(id, 'good')
  })

  skippable('a note that failed to save: sent again by Add note (one copy, never two); Resume waits for it and the resumed capture carries it', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('retry note test'), 1`)
    await key('e', true)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)} && !!document.querySelector('[data-jam-addnote]')`, 30_000)
    // the note's save fails, once
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch6 = f; window.__noteFail = 1; window.fetch = async (u, o) => { if (window.__noteFail && String(u).includes('/api/jam/card') && o?.body && String(o.body).includes('"action":"note"')) { window.__noteFail -= 1; return new Response('{"ok":false}', { status: 409 }) } return f(u, o) }; return 1 })()`)
    try {
      await click('[data-jam-addnote]')
      await browser!.send('Input.insertText', { text: 'keep this once' }, s)
      await enter()
      await until(`window.__noteFail === 0 && document.querySelector('[data-jam-addnote]')?.value === 'keep this once' && !document.querySelector('[data-jam-addnote]').readOnly`, 5000)   // failed: its words stay in the field
      await enter()                                                                // sent again from the field
      await until(`(window.__mvJamQueue.getState().cards ?? []).find((c) => c.id === ${JSON.stringify(id)})?.added?.length === 1`, 5000)
      // Resume: the draft's notes go on with it
      await browser!.eval(s, `document.activeElement?.blur?.(), 1`)
      await key('r')
      await until(`!!window.__mvJamCapture.getState().current`, 10_000)
      const id2 = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
      await key('e', true)
      await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id2)} && c.state === 'draft')`, 30_000)
      expect((await cardsNow()).find((c: any) => c.id === id2).added?.map((x: any) => x.text)).toEqual(['keep this once'])
      await decide(id2, 'drop')
    } finally { await browser!.eval(s, `(window.fetch = window.__fetch6), 1`) }
  })

  skippable('a failed note is never lost to a different one: added after the panel reopened, both go with the capture', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('two notes test'), 1`)
    await key('e', true)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)} && !!document.querySelector('[data-jam-addnote]')`, 30_000)
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch7 = f; window.__noteFail = 1; window.fetch = async (u, o) => { if (window.__noteFail && String(u).includes('/api/jam/card') && o?.body && String(o.body).includes('"action":"note"')) { window.__noteFail -= 1; return new Response('{"ok":false}', { status: 409 }) } return f(u, o) }; return 1 })()`)
    try {
      await click('[data-jam-addnote]')
      await browser!.send('Input.insertText', { text: 'note A' }, s)
      await enter()
      await until(`window.__noteFail === 0 && !document.querySelector('[data-jam-addnote]').readOnly`, 5000)
      // the panel closes and opens again: a fresh field
      await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
      await sleep(200)
      await click(`.jm-lane [data-tile="${id}"]`)
      await until(`!!document.querySelector('[data-jam-addnote]') && document.querySelector('[data-jam-addnote]').value === ''`, 5000)
      await click('[data-jam-addnote]')
      await browser!.send('Input.insertText', { text: 'note B' }, s)
      await enter()
      await until(`(window.__mvJamQueue.getState().cards ?? []).find((c) => c.id === ${JSON.stringify(id)})?.added?.length === 1`, 5000)
      await click('[data-jam-readback] .actions .jm-btn.primary')                   // Add to queue: A is sent first
      await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state !== 'draft')`, 10_000)
    } finally { await browser!.eval(s, `(window.fetch = window.__fetch7), 1`) }
    expect((await cardsNow()).find((c: any) => c.id === id).added?.map((x: any) => x.text).sort()).toEqual(['note A', 'note B'])
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'review')`, 60_000)
    await decide(id, 'good')
  })

  skippable('play entered mid-capture: the stage\'s size is what the frame is pictured at, after play is left too (one frame on screen)', async () => {
    const ka = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/alpha').key`)
    await browser!.eval(s, `(window.__mvStore.getState().select(${JSON.stringify(ka)}), 1)`)
    // only alpha on screen: leaving play then makes a one-frame view of it
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvStore.getState().setPlay({ at: 'spec/alpha', device: 'mobile', theme: 'light' }), 1`)
    await until(`!!document.querySelector('iframe[title="play"]')`, 10_000)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('on the phone'), 1`)
    await sleep(300)
    // the board shows alpha alone as play is left: the view it comes back to is of that one frame
    await browser!.eval(s, `(() => { const st = window.__mvStore.getState(); window.__nodes0 = st.nodes; window.__mvStore.setState({ nodes: st.nodes.filter((n) => n.frame === 'spec/alpha') }); return 1 })()`)
    await browser!.eval(s, `window.__mvStore.getState().setPlay(null), 1`)
    await sleep(400)
    const views = await browser!.eval(s, `(window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.steps ?? []).filter((x) => x.event === 'view').map((x) => (x.view.frames ?? []).length)`)
    await browser!.eval(s, `(window.__mvStore.getState().select(null), 1)`)
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    const rec = await browser!.eval(s, `fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)
    expect(views[views.length - 1]).toBe(1)                                      // the exit view was of alpha alone
    expect(rec.record.sizes?.['spec/alpha']?.play).toBe(true)
    await browser!.eval(s, `(window.__mvStore.setState({ nodes: window.__nodes0 }), 1)`)
    await decide(id, 'drop')
  })

  skippable('play left by its own exit (it selects the frame it ended on): that frame keeps the stage size; Fill window is pictured at the window', async () => {
    const ka = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/alpha').key`)
    await browser!.eval(s, `(window.__mvStore.getState().select(${JSON.stringify(ka)}), 1)`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvStore.getState().setPlay({ at: 'spec/alpha', device: 'mobile', theme: 'light' }), 1`)
    await until(`!!document.querySelector('iframe[title="play"]')`, 10_000)
    await browser!.eval(s, `window.__mvStore.getState().setPlay({ ...window.__mvStore.getState().play, at: 'spec/bravo' }), 1`)
    await sleep(400)
    // bravo on Fill window: pictured at the window's size
    await browser!.eval(s, `window.__mvStore.getState().setPlay({ ...window.__mvStore.getState().play, device: 'fill' }), 1`)
    await sleep(400)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('fills the window'), 1`)
    // the window resized while it fills it: measured again
    await browser!.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false }, s)
    await sleep(600)
    const win = await browser!.eval(s, `({ w: innerWidth, h: innerHeight })`)
    expect(win).toEqual({ w: 1000, h: 760 })
    // the play's own way out (it lands on bravo, selected)
    await browser!.eval(s, `document.querySelector('[data-play-exit]').click(), 1`)
    await until(`!window.__mvStore.getState().play`, 5000)
    expect(await browser!.eval(s, `window.__mvStore.getState().selection.map((k) => window.__mvStore.getState().nodes.find((n) => n.key === k)?.frame)`)).toEqual(['spec/bravo'])
    await sleep(300)
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    const rec = await browser!.eval(s, `fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)
    await browser!.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, s)
    await sleep(400)
    expect(rec.record.sizes?.['spec/bravo']).toEqual({ w: win.w, h: win.h, play: true })
    expect(rec.record.sizes?.['spec/alpha']?.play).toBe(true)
    await decide(id, 'drop')
  })

  skippable('a frame resized on the canvas after play is that size; a resize while the capture finishes is not part of it', async () => {
    const ka = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/alpha').key`)
    await browser!.eval(s, `(window.__mvStore.getState().select(${JSON.stringify(ka)}), 1)`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvStore.getState().setPlay({ at: 'spec/alpha', device: 'mobile', theme: 'light' }), 1`)
    await until(`!!document.querySelector('iframe[title="play"]')`, 10_000)
    await sleep(300)
    await browser!.eval(s, `document.querySelector('[data-play-exit]').click(), 1`)
    await until(`!window.__mvStore.getState().play`, 5000)
    await sleep(300)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('drag it'), 1`)
    // a frame that grows by itself (a measurement, not a person) is not touched
    await browser!.eval(s, `(() => { const st = window.__mvStore.getState(); window.__mvStore.setState({ nodes: st.nodes.map((n) => n.frame === 'spec/charlie' ? { ...n, h: n.h + 57 } : n) }); return 1 })()`)
    await sleep(200)
    expect(await browser!.eval(s, `(window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.steps ?? []).some((x) => x.frame === 'spec/charlie')`)).toBe(false)
    const k2 = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/alpha').key`)
    await browser!.eval(s, `window.__mvStore.getState().resizeNode(${JSON.stringify(k2)}, 600, 1100), 1`)
    await sleep(300)
    // what the end picture asks for
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch8 = f; window.__picReq = []; window.fetch = (u, o) => { if (String(u).includes('/api/jam/picture') && o?.method === 'POST') window.__picReq.push(JSON.parse(o.body)); return f(u, o) }; return 1 })()`)
    await key('e', true)
    // while it finishes, the frame is resized again
    await browser!.eval(s, `window.__mvStore.getState().resizeNode(${JSON.stringify(k2)}, 1000, 900), 1`)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    const rec = await browser!.eval(s, `fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)
    expect(rec.record.sizes?.['spec/alpha']).toEqual({ w: 600, h: 1100 })
    const req = await browser!.eval(s, `window.__picReq.find((x) => x.frame === 'spec/alpha')`)
    await browser!.eval(s, `(window.fetch = window.__fetch8), 1`)
    expect(req).toMatchObject({ w: 600, h: 1100 })
    await decide(id, 'drop')
  })

  // ---- 0.26.1 C1: a capture outlives its page -------------------------------------------------------------
  const getRecord = (id: string) => browser!.eval(s, `fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)
  const reload = async () => {
    // the leave prompt (a capture is unsealed) is answered "leave", as a person who means it would
    const off = browser!.on((m) => { if (m.method === 'Page.javascriptDialogOpening' && m.sessionId === s) void browser!.send('Page.handleJavaScriptDialog', { accept: true }, s) })
    try {
      await browser!.send('Page.reload', {}, s)
      await until(`(window.__mvStore?.getState().nodes.length ?? 0) >= 4 && window.__mvStore.getState().nodes.every((n) => n.status === 'ready') && !!window.__mvJamQueue`, 45_000)
    } finally { off() }
  }

  skippable('a capture still recording when the page reloads is sealed as it stood - its note, a missing step - and comes back as a draft', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('the header overlaps the logo'), 1`)
    await reload()
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    const rec = await getRecord(id)
    expect(rec.record.context.interrupted).toBe(true)
    expect(rec.record.timeline.some((x: any) => x.event === 'note' && x.text === 'the header overlaps the logo')).toBe(true)
    expect(rec.record.timeline.some((x: any) => x.event === 'missing' && /closed while it recorded/.test(x.what))).toBe(true)
    // nothing records in the new page
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().current`)).toBeNull()
    await decide(id, 'drop')
  }, 120_000)

  skippable('a capture finishing when the page reloads (a picture still out) keeps the pictures it had and says it did not finish', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().picture('spec/alpha'), 1`)
    await until(`(window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length ?? 0) === 1`, 30_000)
    // the next picture never answers: the capture cannot seal on its own
    await browser!.eval(s, `(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/api/jam/picture') && o && o.method === 'POST' ? new Promise(() => {}) : f(u, o); return 1 })()`)
    await browser!.eval(s, `window.__mvJamCapture.getState().picture('spec/bravo'), 1`)
    await key('e', true)
    await until(`window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.state === 'draining'`, 5000)
    await reload()
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    const rec = await getRecord(id)
    expect(rec.record.pictures.length).toBe(1)
    expect(rec.record.timeline.some((x: any) => x.event === 'missing' && /closed before it finished/.test(x.what))).toBe(true)
    await decide(id, 'drop')
  }, 120_000)

  skippable('leaving for the back-forward cache seals it for good: nothing records on return, the kept record goes out once, Resume is a new capture', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('kept as it was'), 1`)
    await browser!.eval(s, `window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })), 1`)
    // torn down at once: no capture, nothing of it left to change
    expect(await browser!.eval(s, `JSON.stringify([window.__mvJamCapture.getState().current, Object.keys(window.__mvJamCapture.getState().caps).length])`)).toBe('[null,0]')
    await browser!.eval(s, `window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })), 1`)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    const rec = await getRecord(id)
    expect(rec.record.context.interrupted).toBe(true)
    expect(rec.record.timeline.filter((x: any) => x.event === 'missing').length).toBe(1)
    // carrying on is Resume: a new capture, the draft kept as it was
    await browser!.eval(s, `window.__mvJamUi.getState().open({ kind: 'capture', id: ${JSON.stringify(id)} }), 1`)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)}`, 5000)
    await sleep(200)
    await key('r')
    await until(`!!window.__mvJamCapture.getState().current && window.__mvJamCapture.getState().current !== ${JSON.stringify(id)}`, 5000)
    await browser!.eval(s, `window.__mvJamCapture.getState().drop(), 1`)
    await until(`!window.__mvJamCapture.getState().current`, 5000)
    await decide(id, 'drop')
  }, 120_000)

  skippable('a sealed capture still uploading when the page goes is left as it is - the next page sends it, once', async () => {
    // its upload never answers in this page
    await browser!.eval(s, `(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/api/jam/capture') && o && o.method === 'POST' ? new Promise(() => {}) : f(u, o); return 1 })()`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('sealed, then the page went'), 1`)
    await key('e', true)
    await until(`window.__mvJamCapture.getState().unsent.includes(${JSON.stringify(id)})`, 30_000)
    await reload()
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    const rec = await getRecord(id)
    // sealed before the page went: a whole capture, not an interrupted one
    expect(rec.record.context.interrupted).toBeUndefined()
    expect((await cardsNow()).filter((c: any) => c.id === id).length).toBe(1)
    await decide(id, 'drop')
  }, 120_000)

  skippable('a resumed capture still recording when the page goes is sealed as it stood and takes its draft\'s place', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const a = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('first part'), 1`)
    await key('e', true)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(a)}`, 30_000)
    await sleep(200)
    await key('r')
    await until(`!!window.__mvJamCapture.getState().current && window.__mvJamCapture.getState().current !== ${JSON.stringify(a)}`, 5000)
    const b = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('second part'), 1`)
    await reload()
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(b)} && c.state === 'draft') && !(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(a)} && c.state === 'draft')`, 30_000)
    const rec = await getRecord(b)
    expect(rec.record.context.resumes?.id).toBe(a)
    expect(rec.record.context.interrupted).toBe(true)
    const notes = rec.record.timeline.filter((x: any) => x.event === 'note').map((x: any) => x.text)
    expect(notes).toEqual(['first part', 'second part'])
    await decide(b, 'drop')
  }, 120_000)

  skippable('after the page sealed it: the microphone and the frames are let go, a late picture changes nothing, a failed first send is sent again once', async () => {
    let posts = 0
    // count this capture's uploads; the first one fails (the network went with the page)
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetchC = f; window.__posts = 0; window.__failFirst = true; window.__holdPic = null; window.fetch = (u, o) => {
      if (String(u).includes('/api/jam/capture') && o && o.method === 'POST') { window.__posts++; if (window.__failFirst) { window.__failFirst = false; return Promise.reject(new TypeError('network gone')) } }
      if (String(u).includes('/api/jam/picture') && o && o.method === 'POST') return new Promise((r) => { window.__holdPic = () => r(f(u, o)) })
      return f(u, o) }; return 1 })()`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().picture('spec/alpha'), 1`)
    await until(`!!window.__holdPic`, 5000)
    await browser!.eval(s, `window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })), 1`)
    // let go at once: no capture, the microphone hears nothing for it, the frames record nothing
    expect(await browser!.eval(s, `JSON.stringify([window.__mvJamCapture.getState().current, Object.keys(window.__mvJamCapture.getState().caps).length, window.__mvJamVoice.getState().hearing])`)).toBe('[null,0,null]')
    await click('[data-node-key] iframe').catch(() => {})
    // the picture answers late: nothing of it lands anywhere
    await browser!.eval(s, `(window.__holdPic(), 1)`)
    await sleep(500)
    expect(await browser!.eval(s, `Object.keys(window.__mvJamCapture.getState().caps).length`)).toBe(0)
    // back: what is kept goes out again, once
    await browser!.eval(s, `window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })), 1`)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    await sleep(6_000)   // past the retry timer: no third send
    posts = await browser!.eval(s, `window.__posts`)
    expect(posts).toBe(2)
    const rec = await getRecord(id)
    expect(rec.record.pictures.length).toBe(0)
    await browser!.eval(s, `(window.fetch = window.__fetchC, 1)`)
    await decide(id, 'drop')
  }, 120_000)

  // ---- 0.26.1 D: Jam timings ------------------------------------------------------------------------------
  skippable('a capture and its run each leave their timing - numbers and codes only, in design/.local/perf/jam.jsonl', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('TIMING-SENTINEL words'), 1`)
    await browser!.eval(s, `window.__mvJamCapture.getState().picture('spec/alpha'), 1`)
    await until(`(window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.pictures.length ?? 0) === 1`, 30_000)
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    await decide(id, 'confirm')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'review')`, 90_000)
    const card = (await cardsNow()).find((c: any) => c.id === id)
    const file = join(root, 'design', '.local', 'perf', 'jam.jsonl')
    const lines = async () => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
    let evs: any[] = []
    for (let t0 = Date.now(); Date.now() - t0 < 10_000; await sleep(200)) { evs = await lines(); if (evs.some((e) => e.kind === 'run' && e.batch === card.batch)) break }
    const cap = evs.find((e) => e.kind === 'capture' && e.capture === id)
    expect(cap).toMatchObject({ v: 1, pictures: { count: 1 } })
    expect(typeof cap.sealMs).toBe('number')
    expect(evs.some((e) => e.kind === 'upload' && e.capture === id && typeof e.ms === 'number')).toBe(true)
    const run = evs.find((e) => e.kind === 'run' && e.batch === card.batch)
    expect(run).toMatchObject({ members: [{ kind: 'capture', outcome: 'review' }] })
    expect(run.agentMs.length).toBeGreaterThanOrEqual(1)
    expect(typeof run.beforeMs).toBe('number'); expect(typeof run.afterMs).toBe('number'); expect(typeof run.deliverMs).toBe('number')
    expect(typeof run.members[0].waitMs).toBe('number')
    expect(evs.some((e) => e.kind === 'shot' && e.frame === 'spec/alpha' && e.outcome === 'ok')).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain('TIMING-SENTINEL')
    await decide(id, 'good')
  }, 150_000)

  skippable('E: Capturing, Sending, then queued or working - never To confirm, no read-back, the canvas stays put; ⇧E: To confirm and its read-back', async () => {
    agentMode({})
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    // the clicky frame on screen, at rest, on the canvas (the tests before may leave the camera anywhere)
    const clicky = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/clicky').key`)
    await browser!.eval(s, `(window.__mvStore.getState().setPlay(null), window.__mvStore.getState().setInteract(null), window.__mvJamCanvas.fitNodes([${JSON.stringify(clicky)}]), 1)`)
    await sleep(100)
    await until(`!window.__mvJamCanvas.cameraBusy()`, 5000)
    await key('s')
    await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    // a point on the button: its comment's pin is a render - the window the draft used to show in (27 Oct)
    const at = await browser!.eval(s, `(() => { const f = document.querySelector('.sh-node[data-node="${clicky}"] iframe'); const b = f.contentDocument.querySelector('button').getBoundingClientRect(); const r = f.getBoundingClientRect(); const sx = r.width / f.clientWidth; return { x: r.left + (b.left + b.width / 2) * sx, y: r.top + (b.top + b.height / 2) * sx } })()`)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
    await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
    await until(`(window.__mvJamCapture.getState().caps[${JSON.stringify(id)}]?.steps ?? []).some((x) => x.event === 'click')`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('straight to work'), 1`)
    await until(`!window.__mvJamCanvas.cameraBusy()`, 5000)
    // everything a person would see from here: the tile's state and line, the queue's card, the panel, a fit, a thread
    await browser!.eval(s, `(() => {
      const id = ${JSON.stringify(id)}
      const w = window.__eWatch = { tiles: [], lines: [], panels: [], cards: [], fits: 0, threads: [], cam: window.__mvJamCanvas.transform(), seen: false, gaps: 0 }
      // once its tile is on the lane it never leaves it - not between the canvas's answer and the queued card arriving
      const lane = () => { const t = document.querySelector('.jm-lane [data-tile="' + id + '"]'); if (t) { w.seen = true; w.tiles.push(t.getAttribute('data-state')); w.lines.push(t.querySelector('.m')?.textContent ?? '') } else if (w.seen && !window.__mvJamCapture.getState().current) w.gaps++ }
      w.mo = new MutationObserver(lane); w.mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
      w.u1 = window.__mvJamUi.subscribe((st) => { if (st.panel) w.panels.push(st.panel.kind + ':' + st.panel.id) })
      w.u2 = window.__mvJamQueue.subscribe((st) => { const c = (st.cards ?? []).find((x) => x.id === id); if (c) w.cards.push(c.state) })
      w.u3 = window.__mvComments.subscribe((st, p) => { if (st.active !== p.active) w.threads.push(st.active) })
      const ctl = window.__mvJamCanvas, fit = ctl.fitNodes; ctl.fitNodes = (...a) => { w.fits++; return fit.apply(ctl, a) }; w.unfit = () => { ctl.fitNodes = fit }
      return 1 })()`)
    await key('e')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && (c.state === 'queued' || c.state === 'working' || c.state === 'review'))`, 40_000)
    await sleep(1500)   // past a late push, a load, an effect
    const w = await browser!.eval(s, `(() => { const w = window.__eWatch; w.mo.disconnect(); w.u1(); w.u2(); w.u3(); w.unfit(); const cam = window.__mvJamCanvas.transform()
      return { tiles: [...new Set(w.tiles)], lines: [...new Set(w.lines)], panels: w.panels, cards: [...new Set(w.cards)], fits: w.fits, threads: w.threads, selected: window.__mvJamUi.getState().selected, gaps: w.gaps,
        moved: !!(w.cam && cam) && (Math.abs(w.cam.x - cam.x) > 2 || Math.abs(w.cam.y - cam.y) > 2 || Math.abs(w.cam.s - cam.s) > 0.001) } })()`)
    expect(w.tiles).not.toContain('draft')
    expect(w.cards.filter((x: string) => x === 'draft' || x === 'confirming')).toEqual([])
    expect(w.lines.filter((x: string) => /confirm/i.test(x))).toEqual([])
    expect(w.lines).toContain('Sending')                        // the sealing tile, while it finishes and goes
    expect(w.gaps).toBe(0)                                      // and it stays until its queued card takes its place
    expect(w.panels).toEqual([])                                // no read-back, no capture card
    expect([w.fits, w.moved, w.threads.length, w.selected === id]).toEqual([0, false, 0, false])   // the canvas never moved, nothing opened, its tile not selected
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'review')`, 90_000)
    await decide(id, 'good')

    // ⇧E: it finishes, shows To confirm and opens its read-back - as before
    await key('s')
    await until(`!!window.__mvJamCapture.getState().current`)
    const id2 = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('look first'), 1`)
    await browser!.eval(s, `(() => { const id = ${JSON.stringify(id2)}; const w = window.__eWatch2 = { lines: [] }; w.mo = new MutationObserver(() => { const t = document.querySelector('.jm-lane [data-tile="' + id + '"] .m'); if (t) w.lines.push(t.textContent) }); w.mo.observe(document.body, { subtree: true, childList: true, characterData: true }); return 1 })()`)
    await key('e', true)
    await until(`window.__mvJamUi.getState().panel?.kind === 'capture' && window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id2)} && !!document.querySelector('.jm-focus')`, 30_000)
    await until(`document.querySelector('.jm-lane [data-tile="${id2}"]')?.getAttribute('data-state') === 'draft'`, 5000)
    const lines2 = await browser!.eval(s, `(() => { window.__eWatch2.mo.disconnect(); return [...new Set(window.__eWatch2.lines)] })()`)
    expect(lines2).toContain('Finishing')
    expect(lines2).not.toContain('Sending')
    expect(lines2).not.toContain('Waiting to send')             // the canvas answers: never the offline line
    expect(await browser!.eval(s, `document.querySelector('.jm-lane [data-tile="${id2}"] .m')?.textContent`)).toBe('To confirm')
    await decide(id2, 'drop')
  }, 180_000)

  skippable('E that the queue will not take stays a draft on the lane and says why in one line - its read-back still never opens', async () => {
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    await key('s')
    await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('held back'), 1`)
    // another comment already under the id its comment would take: the confirm fails closed
    appendEvents(join(root, 'design', 'comments'), 'main', [{ id: `cap-${id}-e`, ts: Date.now(), type: 'create', commentId: `cap-${id}`, board: 'main', author: { email: 'someone@else', name: 'Someone' }, body: 'not this capture' } as CommentEvent])
    await browser!.eval(s, `(() => { window.__eHeld = []; window.__eHeldU = window.__mvJamUi.subscribe((st) => { if (st.panel) window.__eHeld.push(st.panel.id) }); return 1 })()`)
    await key('e')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    await until(`[...document.querySelectorAll('.sh-toast')].some((t) => /was not queued - it waits on the lane as a draft/.test(t.textContent))`, 5000)
    await sleep(1000)
    expect(await browser!.eval(s, `(() => { window.__eHeldU(); return window.__eHeld })()`)).toEqual([])
    await decide(id, 'drop')
  }, 120_000)

  skippable('⇧E then a capture stopped with E before it finished: the ⇧E read-back still opens; E over a review closes the review; E finishing as the page goes is queued', async () => {
    agentMode({})
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    // ⇧E on A, and at once S - A still finishing - then E on B: A's read-back opens all the same
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const a = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('look at this one first'), 1`)
    await key('e', true)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current && window.__mvJamCapture.getState().current !== ${JSON.stringify(a)}`)
    const b = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('this one straight on'), 1`)
    await key('e')
    await until(`window.__mvJamUi.getState().panel?.kind === 'capture' && window.__mvJamUi.getState().panel?.id === ${JSON.stringify(a)}`, 40_000)
    await decide(a, 'drop')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(b)} && c.state === 'review')`, 90_000)

    // a review open on B, S, a note, E: B is sent back as more work - its panel closes, nothing else opens
    await browser!.eval(s, `window.__mvJamUi.getState().open({ kind: 'review', id: ${JSON.stringify(b)} }), 1`)
    await until(`window.__mvJamUi.getState().panel?.kind === 'review'`, 5000)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const c = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().caps[${JSON.stringify(c)}].reviewing?.card ?? null`)).toBe(b)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('and the footer too'), 1`)
    await browser!.eval(s, `(() => { window.__cPanels = []; window.__cU = window.__mvJamUi.subscribe((st) => window.__cPanels.push(st.panel ? st.panel.kind + ':' + st.panel.id : null)); return 1 })()`)
    await key('e')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((x) => x.id === ${JSON.stringify(b)} && x.state === 'done')`, 40_000)
    await until(`window.__mvJamUi.getState().panel === null`, 5000)
    expect(await browser!.eval(s, `(() => { window.__cU(); return window.__cPanels.filter((x) => x && !x.startsWith('review:')) })()`)).toEqual([])
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((x) => x.id === ${JSON.stringify(c)} && x.state === 'review')`, 90_000)
    await decide(c, 'good')

    // E, and the page goes while it is still finishing: it is queued, as E does - never a draft to confirm
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const d = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('sent as the page went'), 1`)
    await browser!.eval(s, `(() => { window.__mvJamCapture.getState().end(); window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })); return 1 })()`)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((x) => x.id === ${JSON.stringify(d)})`, 30_000)
    expect(await browser!.eval(s, `(window.__mvJamQueue.getState().cards ?? []).find((x) => x.id === ${JSON.stringify(d)}).state`)).not.toBe('draft')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((x) => x.id === ${JSON.stringify(d)} && x.state === 'review')`, 90_000)
    await decide(d, 'good')
  }, 300_000)

  skippable('E on a resumed draft whose queue refresh fails for over half a minute: its Sending tile stays - never given up on - and the draft it continues never comes back as To confirm', async () => {
    agentMode({})
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const a = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('first part'), 1`)
    await key('e', true)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(a)}`, 30_000)
    await sleep(200)
    await key('r')
    await until(`!!window.__mvJamCapture.getState().current && window.__mvJamCapture.getState().current !== ${JSON.stringify(a)}`, 5000)
    const b = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('second part'), 1`)
    // from here the queue tells the page nothing: its refresh answers 500 and no push is applied
    await browser!.eval(s, `(() => {
      const a = ${JSON.stringify(a)}
      const q = window.__mvJamQueue, real = q.getState().apply
      const w = window.__qWatch = { real, block: true, aLines: [] }
      q.setState({ apply: (v) => { if (!w.block) real(v) } })
      const f = window.fetch
      window.fetch = (u, init) => (w.block && String(u).includes('/api/jam/queue') && !(init && init.method && init.method !== 'GET') ? Promise.resolve(new Response('{}', { status: 500 })) : f(u, init))
      w.mo = new MutationObserver(() => { const t = document.querySelector('.jm-lane [data-tile="' + a + '"] .m'); if (t) w.aLines.push(t.textContent) })
      w.mo.observe(document.body, { subtree: true, childList: true, characterData: true })
      return 1 })()`)
    try {
      await key('e')
      // the canvas took it (its answer names the card); the page's refreshes after it fail - past half a minute
      await until(`!!window.__mvJamCapture.getState().sealed.find((x) => x.id === ${JSON.stringify(b)})?.card`, 40_000)
      await sleep(33_000)
      const mid = await browser!.eval(s, `({ a: [...new Set(window.__qWatch.aLines)], b: document.querySelector('.jm-lane [data-tile="${b}"] .m')?.textContent ?? null, unsent: window.__mvJamCapture.getState().unsent })`)
      expect(mid.a).toEqual([])                     // the resumed draft never came back (as To confirm)
      expect(mid.b).toBe('Sending')                  // and the capture still reads Sending until its card is here
      expect(mid.unsent).toContain(b)
    } finally {
      await browser!.eval(s, `(() => { const w = window.__qWatch; w.block = false; window.__mvJamQueue.setState({ apply: w.real }); return 1 })()`)
    }
    // the queue answers again (the next refresh, or a push): the queued card takes the Sending tile's place; the
    // draft it continued stays gone
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(b)} && c.state !== 'draft') && !window.__mvJamCapture.getState().unsent.length`, 15_000)
    await sleep(500)
    expect(await browser!.eval(s, `(() => { window.__qWatch.mo.disconnect(); return [...new Set(window.__qWatch.aLines)] })()`)).toEqual([])
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((x) => x.id === ${JSON.stringify(b)} && x.state === 'review')`, 90_000)
    await decide(b, 'good')
  }, 180_000)

  skippable('an E capture the canvas took whose card this page never saw (another tab finished it while the refreshes failed, and it left the lane): its Sending tile goes at the first answer - it never stays for good', async () => {
    agentMode({})
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const b = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('finished in another tab'), 1`)
    // down: the refreshes answer 500 and no push is applied. gone: they answer, without this card - as the canvas shows
    // the queue a minute after another tab settled it. live: as it is
    await browser!.eval(s, `(() => {
      const b = ${JSON.stringify(b)}
      const q = window.__mvJamQueue, real = q.getState().apply
      const w = window.__qGone = { real, mode: 'down' }
      const strip = (v) => (v && Array.isArray(v.cards) ? { ...v, cards: v.cards.filter((c) => c.id !== b) } : v)
      q.setState({ apply: (v) => { if (w.mode !== 'down') real(w.mode === 'gone' ? strip(v) : v) } })
      const f = window.fetch
      window.fetch = async (u, init) => {
        if (w.mode === 'live' || !String(u).includes('/api/jam/queue') || (init && init.method && init.method !== 'GET')) return f(u, init)
        if (w.mode === 'down') return new Response('{}', { status: 500 })
        const res = await f(u, init)
        return new Response(JSON.stringify(strip(await res.json())), { status: res.status, headers: { 'content-type': 'application/json' } })
      }
      return 1 })()`)
    try {
      await key('e')
      await until(`!!window.__mvJamCapture.getState().sealed.find((x) => x.id === ${JSON.stringify(b)})?.card`, 40_000)
      await sleep(3_000)
      expect(await browser!.eval(s, `({ unsent: window.__mvJamCapture.getState().unsent, m: document.querySelector('.jm-lane [data-tile="${b}"] .m')?.textContent ?? null })`))
        .toEqual({ unsent: [b], m: 'Sending' })
      await browser!.eval(s, `window.__qGone.mode = 'gone', 1`)
      // the next refresh answers (10 s at most): nothing holds the card any more, so nothing waits for it
      await until(`!window.__mvJamCapture.getState().unsent.length && !document.querySelector('.jm-lane [data-tile="${b}"]')`, 15_000)
    } finally {
      // live again, and loaded once: its run may have reached review while the views left it out (no push follows)
      await browser!.eval(s, `(() => { const w = window.__qGone; w.mode = 'live'; window.__mvJamQueue.setState({ apply: w.real }); void window.__mvJamQueue.getState().load(); return 1 })()`)
    }
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((x) => x.id === ${JSON.stringify(b)} && x.state === 'review')`, 90_000)
    await decide(b, 'good')
  }, 180_000)

  skippable('an E capture whose queue refresh hangs: a push that brings its card ends the wait - Sending never outlives it', async () => {
    agentMode({})
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const b = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('a refresh that never answers'), 1`)
    // the page's queue refreshes hang (never answered); the pushes are held back, the last one kept
    await browser!.eval(s, `(() => {
      const q = window.__mvJamQueue, real = q.getState().apply
      const w = window.__qHang = { real, hold: true, last: null }
      q.setState({ apply: (v) => { if (w.hold) w.last = v; else real(v) } })
      const f = window.fetch
      window.fetch = (u, init) => (w.hold && String(u).includes('/api/jam/queue') && !(init && init.method && init.method !== 'GET') ? new Promise(() => {}) : f(u, init))
      return 1 })()`)
    try {
      await key('e')
      await until(`!!window.__mvJamCapture.getState().sealed.find((x) => x.id === ${JSON.stringify(b)})?.card`, 40_000)
      await until(`!!window.__qHang.last?.cards?.some((c) => c.id === ${JSON.stringify(b)})`, 10_000)
      await sleep(1_000)
      expect(await browser!.eval(s, `window.__mvJamCapture.getState().unsent`)).toContain(b)
      // the push that carries the card lands while the refresh still hangs: the wait ends on it
      await browser!.eval(s, `(() => { const w = window.__qHang; w.hold = false; window.__mvJamQueue.setState({ apply: w.real }); w.real(w.last); return 1 })()`)
      await until(`!window.__mvJamCapture.getState().unsent.length && document.querySelector('.jm-lane [data-tile="${b}"] .m')?.textContent !== 'Sending'`, 5_000)
    } finally {
      await browser!.eval(s, `(() => { const w = window.__qHang; w.hold = false; window.__mvJamQueue.setState({ apply: w.real }); void window.__mvJamQueue.getState().load(); return 1 })()`)
    }
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((x) => x.id === ${JSON.stringify(b)} && x.state === 'review')`, 90_000)
    await decide(b, 'good')
  }, 150_000)

  skippable('a refresh that hangs never stops the retries: the next one answers without the card (another tab finished it) and the Sending tile goes', async () => {
    agentMode({})
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const b = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('first refresh hangs'), 1`)
    // pushes held back; the first queue refresh never answers, the ones after answer without this card
    await browser!.eval(s, `(() => {
      const b = ${JSON.stringify(b)}
      const q = window.__mvJamQueue, real = q.getState().apply
      const w = window.__qHung = { real, mode: 'hang', gets: 0 }
      const strip = (v) => (v && Array.isArray(v.cards) ? { ...v, cards: v.cards.filter((c) => c.id !== b) } : v)
      q.setState({ apply: (v) => { if (w.mode === 'live') real(v) } })
      const f = window.fetch
      window.fetch = async (u, init) => {
        if (w.mode === 'live' || !String(u).includes('/api/jam/queue') || (init && init.method && init.method !== 'GET')) return f(u, init)
        if (w.gets++ === 0) return new Promise(() => {})
        const res = await f(u, init)
        return new Response(JSON.stringify(strip(await res.json())), { status: res.status, headers: { 'content-type': 'application/json' } })
      }
      return 1 })()`)
    try {
      await key('e')
      await until(`!!window.__mvJamCapture.getState().sealed.find((x) => x.id === ${JSON.stringify(b)})?.card`, 40_000)
      // the hung refresh is let go after 10 s; the next one answers (without the card): nothing left to wait for
      await until(`window.__qHung.gets >= 2 && !window.__mvJamCapture.getState().unsent.length && !document.querySelector('.jm-lane [data-tile="${b}"]')`, 30_000)
    } finally {
      await browser!.eval(s, `(() => { const w = window.__qHung; w.mode = 'live'; window.__mvJamQueue.setState({ apply: w.real }); void window.__mvJamQueue.getState().load(); return 1 })()`)
    }
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((x) => x.id === ${JSON.stringify(b)} && x.state === 'review')`, 90_000)
    await decide(b, 'good')
  }, 150_000)

  skippable('refreshes that hang are cancelled when given up on - they never pile up on the browser\'s connections', async () => {
    agentMode({})
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const b = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('every refresh hangs'), 1`)
    // pushes held back; every queue refresh hangs until it is cancelled
    await browser!.eval(s, `(() => {
      const q = window.__mvJamQueue, real = q.getState().apply
      const w = window.__qPile = { real, hang: true, pending: 0, aborted: 0, last: null }
      q.setState({ apply: (v) => { if (w.hang) w.last = v; else real(v) } })
      const f = window.fetch
      window.fetch = (u, init) => {
        if (!w.hang || !String(u).includes('/api/jam/queue') || (init && init.method && init.method !== 'GET')) return f(u, init)
        w.pending++
        return new Promise((_, rej) => init?.signal?.addEventListener('abort', () => { w.pending--; w.aborted++; rej(new DOMException('aborted', 'AbortError')) }))
      }
      return 1 })()`)
    try {
      await key('e')
      await until(`!!window.__mvJamCapture.getState().sealed.find((x) => x.id === ${JSON.stringify(b)})?.card`, 40_000)
      // two refreshes given up on (10 s each): cancelled, one at most still out
      await until(`window.__qPile.aborted >= 2`, 40_000)
      expect(await browser!.eval(s, `window.__qPile.pending`)).toBeLessThanOrEqual(1)
      expect(await browser!.eval(s, `window.__mvJamCapture.getState().unsent`)).toContain(b)
    } finally {
      await browser!.eval(s, `(() => { const w = window.__qPile; w.hang = false; window.__mvJamQueue.setState({ apply: w.real }); if (w.last) w.real(w.last); void window.__mvJamQueue.getState().load(); return 1 })()`)
    }
    await until(`!window.__mvJamCapture.getState().unsent.length`, 20_000)
    expect(await browser!.eval(s, `window.__qPile.pending`)).toBe(0)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((x) => x.id === ${JSON.stringify(b)} && x.state === 'review')`, 90_000)
    await decide(b, 'good')
  }, 180_000)

  skippable('a capture the canvas took is never sent again while it waits for its card - a retry for another capture leaves it alone', async () => {
    agentMode({})
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    // pushes held back, queue refreshes hang (until cancelled); capture posts are counted, and B's are refused for now
    await browser!.eval(s, `(() => {
      const q = window.__mvJamQueue, real = q.getState().apply
      const w = window.__qDup = { real, on: true, last: null, posts: {}, failB: null, slowA: null }
      q.setState({ apply: (v) => { if (w.on) w.last = v; else real(v) } })
      const f = window.fetch
      window.fetch = (u, init) => {
        const url = String(u), get = !(init && init.method && init.method !== 'GET')
        if (w.on && url.includes('/api/jam/queue') && get) return new Promise((_, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))
        if (url.includes('/api/jam/capture') && init?.body) {
          const id = JSON.parse(init.body).record?.id
          w.posts[id] = (w.posts[id] ?? 0) + 1
          if (w.on && id && id === w.failB) return Promise.resolve(new Response('{}', { status: 503 }))
          // A's first post answers late (its answer still out while B's retries run)
          if (w.on && id && id === w.slowA && w.posts[id] === 1) return new Promise((res) => setTimeout(() => res(f(u, init)), 12_000))
        }
        return f(u, init)
      }
      return 1 })()`)
    let a = '', b = ''
    try {
      await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
      a = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
      await browser!.eval(s, `window.__mvJamCapture.getState().note('taken, waiting for its card'), 1`)
      await key('e')
      await until(`!!window.__mvJamCapture.getState().sealed.find((x) => x.id === ${JSON.stringify(a)})?.card`, 40_000)
      await key('s'); await until(`!!window.__mvJamCapture.getState().current && window.__mvJamCapture.getState().current !== ${JSON.stringify(a)}`, 5_000)
      b = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
      await browser!.eval(s, `(window.__qDup.failB = ${JSON.stringify(b)}, window.__mvJamCapture.getState().note('its posts fail for now'), 1)`)
      await key('e')
      // two rounds of the 5 s retry for B: A was taken - it is not posted again
      await until(`(window.__qDup.posts[${JSON.stringify(b)}] ?? 0) >= 3`, 30_000)
      expect(await browser!.eval(s, `window.__qDup.posts[${JSON.stringify(a)}]`)).toBe(1)
    } finally {
      await browser!.eval(s, `(() => { const w = window.__qDup; w.on = false; window.__mvJamQueue.setState({ apply: w.real }); if (w.last) w.real(w.last); void window.__mvJamQueue.getState().load(); return 1 })()`)
    }
    await until(`!window.__mvJamCapture.getState().unsent.length`, 30_000)
    for (const id of [a, b]) {
      await until(`(window.__mvJamQueue.getState().cards ?? []).some((x) => x.id === ${JSON.stringify(id)} && x.state === 'review')`, 120_000)
      await decide(id, 'good')
    }
  }, 300_000)

  skippable('a capture whose post is still out is never posted again alongside it - a retry for another capture leaves it alone', async () => {
    agentMode({})
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    // pushes held back, queue refreshes hang (until cancelled); capture posts are counted, and B's are refused for now
    await browser!.eval(s, `(() => {
      const q = window.__mvJamQueue, real = q.getState().apply
      const w = window.__qDup = { real, on: true, last: null, posts: {}, failB: null, slowA: null }
      q.setState({ apply: (v) => { if (w.on) w.last = v; else real(v) } })
      const f = window.fetch
      window.fetch = (u, init) => {
        const url = String(u), get = !(init && init.method && init.method !== 'GET')
        if (w.on && url.includes('/api/jam/queue') && get) return new Promise((_, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))
        if (url.includes('/api/jam/capture') && init?.body) {
          const id = JSON.parse(init.body).record?.id
          w.posts[id] = (w.posts[id] ?? 0) + 1
          if (w.on && id && id === w.failB) return Promise.resolve(new Response('{}', { status: 503 }))
          // A's first post answers late (its answer still out while B's retries run)
          if (w.on && id && id === w.slowA && w.posts[id] === 1) return new Promise((res) => setTimeout(() => res(f(u, init)), 12_000))
        }
        return f(u, init)
      }
      return 1 })()`)
    let a = '', b = ''
    try {
      await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
      a = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
      await browser!.eval(s, `(window.__qDup.slowA = ${JSON.stringify(a)}, window.__mvJamCapture.getState().note('its post answers late'), 1)`)
      await key('e')
      await until(`(window.__qDup.posts[${JSON.stringify(a)}] ?? 0) >= 1`, 40_000)
      await key('s'); await until(`!!window.__mvJamCapture.getState().current && window.__mvJamCapture.getState().current !== ${JSON.stringify(a)}`, 5_000)
      b = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
      await browser!.eval(s, `(window.__qDup.failB = ${JSON.stringify(b)}, window.__mvJamCapture.getState().note('its posts fail for now'), 1)`)
      await key('e')
      // two rounds of the 5 s retry for B: A was taken - it is not posted again
      await until(`(window.__qDup.posts[${JSON.stringify(b)}] ?? 0) >= 3`, 30_000)
      expect(await browser!.eval(s, `window.__qDup.posts[${JSON.stringify(a)}]`)).toBe(1)
    } finally {
      await browser!.eval(s, `(() => { const w = window.__qDup; w.on = false; window.__mvJamQueue.setState({ apply: w.real }); if (w.last) w.real(w.last); void window.__mvJamQueue.getState().load(); return 1 })()`)
    }
    await until(`!window.__mvJamCapture.getState().unsent.length`, 30_000)
    for (const id of [a, b]) {
      await until(`(window.__mvJamQueue.getState().cards ?? []).some((x) => x.id === ${JSON.stringify(id)} && x.state === 'review')`, 120_000)
      await decide(id, 'good')
    }
  }, 300_000)

  skippable('the canvas\'s stand-in answer while its queue is not up is never applied: the lane and the session stay as the last view left them', async () => {
    await until(`Array.isArray(window.__mvJamQueue.getState().cards)`, 10_000)
    // what a push just brought: a card on the lane and a session under way
    const kept = await browser!.eval(s, `(() => { const q = window.__mvJamQueue, st = q.getState(); const was = { cards: st.cards, session: st.session }; window.__qKept = was
      q.setState({ cards: [...(st.cards ?? []), { id: 'cap-1-standin', kind: 'capture', state: 'queued', board: 'home', frames: [], made: 1, order: 1, rev: 1, at: 1 }], session: st.session ?? { id: 'ses-standin', started: 1 } }); return 1 })()`)
    expect(kept).toBe(1)
    const before = await browser!.eval(s, `JSON.stringify({ cards: (window.__mvJamQueue.getState().cards ?? []).map((c) => c.id), session: window.__mvJamQueue.getState().session?.id ?? null })`)
    const r = await browser!.eval(s, `(async () => {
      const f = window.fetch
      window.fetch = (u, init) => (String(u).includes('/api/jam/queue') ? Promise.resolve(new Response(JSON.stringify({ agent: null, cards: [], unavailable: true }), { status: 200, headers: { 'content-type': 'application/json' } })) : f(u, init))
      try { return await window.__mvJamQueue.getState().load() } finally { window.fetch = f }
    })()`)
    expect(r).toBe(false)
    expect(await browser!.eval(s, `JSON.stringify({ cards: (window.__mvJamQueue.getState().cards ?? []).map((c) => c.id), session: window.__mvJamQueue.getState().session?.id ?? null })`)).toBe(before)
    expect(before).toContain('cap-1-standin')
    await browser!.eval(s, `(() => { window.__mvJamQueue.setState(window.__qKept); return 1 })()`)
  }, 30_000)

  skippable('a More-work note always goes to the canvas as More work: "yes, thanks" after a reply that asked runs again - never settled as Looks good', async () => {
    agentMode({ question: 'Want me to apply this to the footer?' })
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const r = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('make the header blue'), 1`)
    await key('e')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(r)} && c.state === 'review' && c.reply)`, 60_000)
    agentMode({})
    const reply = await browser!.eval(s, `window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(r)}).reply`)
    await until(`window.__mvComments.getState().threads.some((t) => t.replies.some((x) => x.id === ${JSON.stringify(reply)}))`, 10_000)
    await sleep(500)
    // the page has the review but not its reply (the thread's fetch slow, or failed); the card actions are watched
    await browser!.eval(s, `(() => {
      const c = window.__mvComments
      c.setState({ threads: c.getState().threads.map((t) => ({ ...t, replies: t.replies.filter((x) => x.id !== ${JSON.stringify(reply)}) })) })
      const f = window.fetch; window.__acts = []
      window.fetch = (u, init) => { if (String(u).includes('/api/jam/card') && init && init.body) window.__acts.push(JSON.parse(init.body).action); return f(u, init) }
      return 1 })()`)
    await browser!.eval(s, `window.__mvJamUi.getState().open({ kind: 'review', id: ${JSON.stringify(r)} }), 1`)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(r)} && !!document.querySelector('.jm-review')`, 5000)
    await browser!.eval(s, `window.__mvJamUi.getState().setMoreOpen(true), 1`)
    await until(`!!document.querySelector('.jm-more textarea')`, 3000)
    expect(await browser!.eval(s, `document.querySelector('.jm-review .jm-reply p')?.textContent ?? null`)).toBe('')
    await browser!.eval(s, `(() => { const t = document.querySelector('.jm-more textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'yes, thanks'); t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
    await sleep(100)
    await browser!.eval(s, `document.querySelector('.jm-send').click(), 1`)
    await until(`window.__acts.length > 0`, 5000)
    // sent as More work, and not on the canvas's list of approvals: the footer request runs
    expect(await browser!.eval(s, `window.__acts`)).toEqual(['more'])
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(r)} && c.state === 'review' && c.reply && c.reply !== ${JSON.stringify(reply)})`, 60_000)
    await decide(r, 'good')
  }, 150_000)

  /** A pick on a frame during a capture - the frame brought into view first, so the click lands on it whatever the
   *  tests before left on screen. */
  const pickOn = async (frame: string) => {
    const k = await browser!.eval(s, `window.__mvStore.getState().nodes.find((x) => x.frame === ${JSON.stringify(frame)}).key`)
    await browser!.eval(s, `window.__mvJamCanvas.fitNode(${JSON.stringify(k)}), 1`)
    await until(`!window.__mvJamCanvas.cameraBusy()`, 5000)
    await sleep(300)
    await click(`.sh-node[data-node="${k}"] .sh-overlay`)
    await sleep(300)
  }
  /** S, a pick on bravo (the capture's comment is pinned there), a note, E - the fake agent asks back. */
  const askingCapture = async () => {
    agentMode({ asks: true, question: 'Navy or teal?' })
    await browser!.eval(s, `window.__mvJamUi.getState().close(), window.__mvComments.getState().setActive(null), 1`)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const r = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await pickOn('spec/bravo')
    await browser!.eval(s, `window.__mvJamCapture.getState().note('make the header blue'), 1`)
    await key('e')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(r)} && c.state === 'asks')`, 60_000)
    agentMode({})
    const thread = await browser!.eval(s, `window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(r)}).thread`)
    await until(`window.__mvComments.getState().threads.some((t) => t.id === ${JSON.stringify(thread)} && t.replies.some((x) => x.agent))`, 15_000)
    await until(`!!document.querySelector('.jm-lane [data-tile="${r}"]')`, 5000)
    return { r, thread: thread as string }
  }
  /** the owner looked elsewhere since (another frame, zoomed in) - after E nothing brought the canvas to the capture */
  const lookElsewhere = async () => {
    await browser!.eval(s, `(() => { const k = window.__mvStore.getState().nodes.find((x) => x.frame === 'spec/clicky').key; window.__mvJamCanvas.fitNode(k); return 1 })()`)
    await sleep(600)
    await browser!.eval(s, `window.__mvJamCanvas.zoomTo(3), 1`)
    await until(`!window.__mvJamCanvas.cameraBusy()`, 5000)
    await sleep(300)
  }
  const cardOnScreen = `(() => { const c = document.querySelector('.cm-card'); if (!c) return false; const b = c.getBoundingClientRect(); return b.width > 0 && b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight })()`

  skippable('an Asks you tile opens its thread where you can see it: the canvas comes to its frame (after E nothing moved it there)', async () => {
    const { r, thread } = await askingCapture()
    await lookElsewhere()
    // the thread's card is not on screen now: opening it in place shows nothing (the 0.28 regression)
    expect(await browser!.eval(s, `window.__mvComments.getState().active`)).toBe(null)
    await click(`.jm-lane [data-tile="${r}"]`)
    await until(`window.__mvComments.getState().active === ${JSON.stringify(thread)} && window.__mvJamUi.getState().selected === ${JSON.stringify(r)} && ${cardOnScreen}`, 8000)
    // its question is there to read
    expect(await browser!.eval(s, `document.querySelector('.cm-card')?.textContent ?? ''`)).toContain('Navy or teal?')
    await browser!.eval(s, `window.__mvComments.getState().setActive(null), 1`)
  }, 150_000)

  skippable('an Asks you tile whose thread this board cannot show (its frame is on no node here) opens its panel: the question, and an answer sent with @marver to its thread', async () => {
    const { r, thread } = await askingCapture()
    // the thread's frame leaves the board as the page holds it (it is on no node here now)
    await browser!.eval(s, `(() => { const st = window.__mvStore.getState(); const f = window.__mvComments.getState().threads.find((t) => t.id === ${JSON.stringify(thread)}).frame; window.__keptNodes = st.nodes; window.__mvStore.setState({ nodes: st.nodes.filter((n) => n.frame !== f) }); return 1 })()`)
    try {
    await click(`.jm-lane [data-tile="${r}"]`)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(r)} && !!document.querySelector('.jm-asks textarea')`, 8000)
    expect(await browser!.eval(s, `document.querySelector('.jm-asks .jm-reply')?.textContent ?? ''`)).toContain('Navy or teal?')
    await browser!.eval(s, `(() => { const t = document.querySelector('.jm-asks textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'navy, please'); t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
    await sleep(100)
    await browser!.eval(s, `document.querySelector('.jm-asks .jm-send').click(), 1`)
    // the answer is in its thread, tagged: the agent goes on with it
    await until(`window.__mvComments.getState().threads.some((t) => t.id === ${JSON.stringify(thread)} && t.replies.some((x) => !x.agent && x.body === '@marver navy, please'))`, 10_000)
    await until(`!window.__mvJamUi.getState().panel`, 5000)
    } finally { await browser!.eval(s, `(() => { if (window.__keptNodes) window.__mvStore.setState({ nodes: window.__keptNodes }); window.__keptNodes = null; return 1 })()`) }
    // the follow-up runs and settles before the next test
    await until(`(window.__mvJamQueue.getState().cards ?? []).every((c) => c.state !== 'queued' && c.state !== 'working')`, 60_000)
  }, 150_000)

  skippable('a capture waiting on a frame another run holds says so on its tile - "Waits for bravo", never "Queued · next" (F2)', async () => {
    // the first run lasts long enough for the second capture to seal and land beside it
    agentMode({ delay: 25_000 })
    await browser!.eval(s, `window.__mvJamUi.getState().close(), window.__mvComments.getState().setActive(null), 1`)
    const capOn = async (frame: string, words: string) => {
      await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
      const r = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
      await pickOn(frame)
      await browser!.eval(s, `window.__mvJamCapture.getState().note(${JSON.stringify(words)}), 1`)
      await key('e')
      return r as string
    }
    const one = await capOn('spec/bravo', 'icon labels')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(one)} && c.state === 'working')`, 30_000)
    const two = await capOn('spec/bravo', 'redesign the images')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(two)} && c.state === 'queued')`, 30_000)
    await until(`/Waits for bravo/.test(document.querySelector('.jm-lane [data-tile="${two}"]')?.textContent ?? '')`, 10_000)
    expect(await browser!.eval(s, `document.querySelector('.jm-lane [data-tile="${two}"]')?.textContent ?? ''`)).not.toMatch(/Queued · next/)
    agentMode({})
    // once the first is done, it runs
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(two)} && c.state !== 'queued')`, 60_000)
    await until(`(window.__mvJamQueue.getState().cards ?? []).every((c) => c.state !== 'queued' && c.state !== 'working')`, 60_000)
  }, 180_000)
})
