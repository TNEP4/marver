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
    await key('e')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 15_000)
    const rec = await browser!.eval(s, `fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)
    const events = rec.record.timeline.map((x: any) => x.event)
    expect(events[0]).toBe('view')
    expect(events.indexOf('click')).toBeLessThan(events.indexOf('note'))
    expect(rec.record.timeline.find((x: any) => x.event === 'click').frame).toBe('spec/clicky')
    expect(JSON.stringify(rec.record)).not.toContain('"kind"')
  }, 120_000)

  skippable('confirm writes the capture\'s comment and queues it; the agent\'s run turns it to review; Looks good resolves its thread', async () => {
    agentMode({})
    const draft = (await cardsNow()).find((c: any) => c.kind === 'capture' && c.state === 'draft')
    expect(draft).toBeTruthy()
    await browser!.eval(s, `window.__mvJamQueue.getState().act(window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(draft.id)}), 'confirm')`)
    await until(`window.__mvComments.getState().threads.some((t) => t.id === 'cap-${draft.id}' && t.capture === ${JSON.stringify(draft.id)})`, 15_000)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(draft.id)} && c.state === 'review')`, 30_000)
    await browser!.eval(s, `window.__mvJamQueue.getState().act(window.__mvJamQueue.getState().cards.find((c) => c.id === ${JSON.stringify(draft.id)}), 'good')`)
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
})
