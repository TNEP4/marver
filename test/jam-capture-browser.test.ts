import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'

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
const agentMode = (m: { delay?: number; fail?: boolean }) => put('fake-agent.json', m)
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
const F = '\`\`\`'
const out = p.members.map((m) => F + 'marver-reply ' + m.id + '\\nDone: ' + m.brief.asks.map((a) => a.body).join(' + ') + '\\n' + F).join('\\n')
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

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-jam-cap-'))
  bin = mkdtempSync(join(tmpdir(), 'mv-jam-cap-bin-'))
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  put('package.json', { name: 'jam-fixture', private: true, type: 'module' })
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  put('design/config.ts', "export default { jam: { agent: 'claude', concurrency: 1 } }\n")
  for (const f of ['alpha', 'bravo', 'charlie']) put(`design/scenes/spec/${f}.tsx`, frame(f))
  put('design/scenes/spec/clicky.tsx', `export default () => <main><button onClick={() => { (window as any).__clicked = ((window as any).__clicked ?? 0) + 1 }}>Save 20%</button></main>\n`)
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
    await key('e')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 15_000)
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
    await until(`window.__mvComments.getState().threads.some((t) => t.id === 'cap-${draft.id}' && t.capture === ${JSON.stringify(draft.id)})`, 15_000)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(draft.id)} && c.state === 'review')`, 30_000)
    await pic('lane-review')
    await key('v')                                                             // the oldest capture to review
    await until(`window.__mvJamUi.getState().panel?.kind === 'review' && !!document.querySelector('.jm-focus')`, 5000)
    await pic('review')
    await enter()                                                  // Looks good
    await until(`window.__mvComments.getState().threads.find((t) => t.id === 'cap-${draft.id}')?.resolved === true`, 15_000)
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
    await key('e')                                                                           // text never added is the last note
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 15_000)
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

  skippable('Esc with no notes card open drops the capture; S with one open seals it and starts the next', async () => {
    await key('s')
    await until(`!!window.__mvJamCapture.getState().current`)
    const first = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await key('s')
    await until(`window.__mvJamCapture.getState().current && window.__mvJamCapture.getState().current !== ${JSON.stringify(first)}`, 3000)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(first)} && c.state === 'draft')`, 15_000)
    const b = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...b }, s); await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...b }, s)
    await until(`!window.__mvJamCapture.getState().current`, 3000)
    // leave nothing behind: the first one's draft is dropped
    await browser!.eval(s, `window.__mvJamQueue.getState().act(window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(first)}), 'drop')`)
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
  }, 60_000)

  skippable('during a review: S, a note, S again, a note, E - both drafts bind the review; the newest draft\'s read-back opens over it and ⏎ confirms that draft, not the review', async () => {
    agentMode({})
    // a capture to review first
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const r0 = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('first ask'), 1`)
    await key('e')
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(r0)}`, 15_000)
    await enter()
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(r0)} && c.state === 'review')`, 30_000)
    await key('v')
    await until(`window.__mvJamUi.getState().panel?.kind === 'review' && window.__mvJamUi.getState().panel?.id === ${JSON.stringify(r0)}`, 5000)
    // S during the review, S -> S, E
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const a = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('use your second idea'), 1`)
    await key('s'); await until(`window.__mvJamCapture.getState().current && window.__mvJamCapture.getState().current !== ${JSON.stringify(a)}`, 3000)
    const b = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('and the border'), 1`)
    await key('e')
    await until(`[${JSON.stringify(a)}, ${JSON.stringify(b)}].every((id) => (window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === id && c.state === 'draft' && c.reviewing?.card === ${JSON.stringify(r0)}))`, 15_000)
    await until(`window.__mvJamUi.getState().panel?.kind === 'capture'`, 5000)
    const opened = await browser!.eval(s, `window.__mvJamUi.getState().panel.id`)
    await enter()
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(opened)} && c.state !== 'draft')`, 10_000)
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
    await key('e')
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)}`, 15_000)
    // open the editor, type, then click Add to queue (the blur saves the edit)
    await click('.jm-focus .jm-editable')
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
    await sleep(1500)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`, 5000)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await key('i')
    // the shell's own navigation, quick revisits included: A -> B -> A -> B, each a line
    for (const at of ['spec/bravo', 'spec/alpha', 'spec/bravo']) await browser!.eval(s, `window.__mvStore.getState().setPlay({ ...window.__mvStore.getState().play, at: ${JSON.stringify(at)} }), 1`)
    await key('e')
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
    await browser!.eval(s, `window.__mvStore.getState().setPlay(null), 1`)
    await browser!.eval(s, `(() => { const q = window.__mvJamQueue.getState(); const c = q.cards.find((x) => x.id === ${JSON.stringify(id)}); return c ? q.act(c, 'drop') : 1 })()`)
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
  }, 90_000)

  skippable('a failed edit keeps blocking: Add to queue twice after a rejected save sends nothing, until the edit saves', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('raw'), 1`)
    await key('e')
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)}`, 15_000)
    // edits fail for now
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch0 = f; window.fetch = (u, o) => (o && o.body && String(o.body).includes('"action":"edit"')) ? Promise.resolve(new Response('{"ok":false}', { status: 409 })) : f(u, o); return 1 })()`)
    await click('.jm-focus .jm-editable')
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
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch1 = f; window.__fail = 1; window.fetch = (u, o) => (String(u).includes('/api/jam/capture') && o && o.method === 'POST' && window.__fail) ? (window.__fail === 1 ? Promise.reject(new TypeError('offline')) : Promise.resolve(new Response('{"ok":false,"error":"jam is not running here"}', { status: 409 }))) : f(u, o); return 1 })()`)
    const kept = (expr: string) => `(() => { const k = Object.keys(localStorage).find((x) => x.startsWith('mv-jam-sealed:')); const all = k ? JSON.parse(localStorage.getItem(k) || '{}') : {}; return ${expr} })()`
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('do not lose me'), 1`)
    await key('e')
    // sealed (after its end pictures) and refused by the network: kept here, nothing lost
    await until(kept(`!!all[${JSON.stringify(id)}]?.timeline.some((x) => x.text === 'do not lose me')`), 15_000)
    // the server answers but jam is not running yet (409): still kept, still retried
    await browser!.eval(s, `(window.__fail = 2), 1`)
    await sleep(6000)
    expect(await browser!.eval(s, kept(`!!all[${JSON.stringify(id)}]`))).toBe(true)
    expect(await browser!.eval(s, `(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)})`)).toBe(false)
    await browser!.eval(s, `(window.__fail = 0), 1`)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 15_000)
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
    await key('e')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 20_000)
    await browser!.eval(s, `(() => { const q = window.__mvJamQueue.getState(); const c = q.cards.find((x) => x.id === ${JSON.stringify(id)}); return c ? q.act(c, 'drop') : 1 })()`)
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
  }, 60_000)

  skippable('overlapping saves: an older edit saving late never clears a newer one that failed - confirm sends nothing', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('raw'), 1`)
    await key('e')
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)}`, 15_000)
    // "A" saves slowly and succeeds; "B" fails at once
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch2 = f; window.fetch = (u, o) => { const b = o && o.body ? String(o.body) : ''; if (b.includes('"action":"edit"') && b.includes('"body":"A"')) return new Promise((r) => setTimeout(() => r(f(u, o)), 900)); if (b.includes('"action":"edit"') && b.includes('"body":"B"')) return Promise.resolve(new Response('{"ok":false}', { status: 409 })); return f(u, o) }; return 1 })()`)
    const typeAndBlur = async (text: string) => {
      await click('.jm-focus .jm-editable')
      await until(`!!document.querySelector('.jm-focus textarea')`, 3000)
      await browser!.eval(s, `(() => { const t = document.querySelector('.jm-focus textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(text)}); t.dispatchEvent(new Event('input', { bubbles: true })); t.blur(); return 1 })()`)
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
    await key('e')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 15_000)
    await browser!.eval(s, `(window.fetch = window.__fetch3), 1`)
    const rec = await browser!.eval(s, `fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)
    expect(rec.record.timeline.some((x: any) => x.event === 'missing' && /picture/.test(x.what))).toBe(true)
    // lane K on a draft whose edit failed to save sends nothing
    await browser!.eval(s, `(() => { const f = window.fetch; window.fetch = (u, o) => (o && o.body && String(o.body).includes('"action":"edit"')) ? Promise.resolve(new Response('{"ok":false}', { status: 409 })) : f(u, o); return 1 })()`)
    await click('.jm-focus .jm-editable')
    await until(`!!document.querySelector('.jm-focus textarea')`, 3000)
    await browser!.eval(s, `(() => { const t = document.querySelector('.jm-focus textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'unsaved words'); t.dispatchEvent(new Event('input', { bubbles: true })); t.blur(); return 1 })()`)
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
})
