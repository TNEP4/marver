import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * Jam V2 (spec 27) where a person sees it: a REAL dev server with jam on, a fake `claude` on PATH
 * that answers from the packet file it is given, and a REAL browser. A tag's thread shows where its
 * work stands as one icon right of the tag's time - queued, working, failed - and nothing once
 * Marver replied; the icon's one move is Drop or Retry; only a failure raises a notice here.
 * Skips without Chrome.
 */

const PORT = 7000 + Math.floor(Math.random() * 400)
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
  root = mkdtempSync(join(tmpdir(), 'mv-jam-b-'))
  bin = mkdtempSync(join(tmpdir(), 'mv-jam-bin-'))
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  put('package.json', { name: 'jam-fixture', private: true, type: 'module' })
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  put('design/config.ts', "export default { jam: { agent: 'claude', concurrency: 1 } }\n")
  for (const f of ['alpha', 'bravo', 'charlie']) put(`design/scenes/spec/${f}.tsx`, frame(f))
  put('design/boards/main.json', { version: 1, name: 'main', auto: false, order: 0, nodes: [{ frame: 'spec/alpha' }, { frame: 'spec/bravo' }, { frame: 'spec/charlie' }] })
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
  await until(`window.__mvStore?.getState().nodes.length === 3 && !!window.__mvComments`, 30_000)
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

describe('Jam V2 in the browser: a tag\'s card in its thread', () => {
  skippable('queued, then working by the tag\'s time - the pin wears the working ring - and no icon once Marver replied; no notice', async () => {
    agentMode({ delay: 3000 })
    await browser!.eval(s, `window.__mvStore.getState().clearJamToasts(), 1`)
    const a = await browser!.eval(s, `window.__tag('spec/alpha', '@marver make it green')`)
    const b = await browser!.eval(s, `window.__tag('spec/bravo', '@marver make it blue')`)
    await open(b)
    await until(`window.__icon() === 'queued'`)
    // the icon names its state (its tooltip says the same, with the detail - jam-lines.ts, unit-tested)
    expect(await browser!.eval(s, `document.querySelector('.cm-card .cm-tstat-btn').getAttribute('aria-label')`)).toBe('Queued · next')
    await shot('queued')
    await open(a)
    await until(`window.__icon() === 'working'`)
    expect(await browser!.eval(s, `document.querySelector('.cm-pin[data-thread="${a}"]')?.classList.contains('working') ?? 'no pin'`)).toBe(true)
    await shot('working')
    // the reply lands: the icon goes, the reply says it
    await until(`window.__mvComments.getState().threads.find((t) => t.id === ${JSON.stringify(a)})?.replies.some((r) => r.agent && /^Done:/.test(r.body))`, 30_000)
    await until(`window.__icon() === 'none'`)
    expect(await browser!.eval(s, `window.__mvStore.getState().toasts.filter((t) => t.jam).length`)).toBe(0)
    await open(b)
    await until(`window.__icon() === 'working'`, 10_000)
    await until(`window.__icon() === 'none'`, 30_000)
    await open(null as unknown as string)
  }, 120_000)

  skippable('Drop from a queued tag\'s icon: it never runs, and the icon goes', async () => {
    agentMode({ delay: 2500 })
    const a = await browser!.eval(s, `window.__tag('spec/alpha', '@marver first')`)
    const c = await browser!.eval(s, `window.__tag('spec/charlie', '@marver second')`)
    await open(c)
    await until(`window.__icon() === 'queued'`)
    await click('.cm-card .cm-tstat-btn')
    await until(`document.querySelector('.cm-tstat-pop')?.textContent.includes('Drop')`, 3000)
    await shot('drop')
    await click('.cm-tstat-act')
    await until(`window.__icon() === 'none'`)
    const card = journal().cards.find((x: any) => x.thread === c)
    expect(card.state).toBe('dropped')
    await open(a)
    await until(`window.__icon() === 'none'`, 30_000)                       // the first one still finished
    await sleep(500)
    expect(journal().batches.some((x: any) => x.members.some((m: any) => m.card === card.id))).toBe(false)
    await open(null as unknown as string)
  }, 120_000)

  skippable('a failure: ✕ by the time and one notice with Retry; Retry from the icon runs it again', async () => {
    agentMode({ fail: true })
    await browser!.eval(s, `window.__mvStore.getState().clearJamToasts(), 1`)
    const f = await browser!.eval(s, `window.__tag('spec/bravo', '@marver this will fail')`)
    await open(f)
    await until(`window.__icon() === 'failed'`, 30_000)
    await until(`window.__mvStore.getState().toasts.filter((t) => t.jam?.failed).length === 1`)
    expect(await browser!.eval(s, `[...document.querySelectorAll('.sh-jam-view')].map((b) => b.textContent).join()`)).toContain('Retry')
    agentMode({})
    await click('.cm-card .cm-tstat-btn')
    await until(`document.querySelector('.cm-tstat-pop')?.textContent.includes('Retry')`, 3000)
    await shot('retry')
    if (process.env.MARVER_SHOT_DIR) {
      const out = await browser!.send('Page.captureScreenshot', { format: 'png', clip: { x: 900, y: 600, width: 500, height: 300, scale: 2 } }, s)
      writeFileSync(join(process.env.MARVER_SHOT_DIR, 'jam-failed-notice.png'), Buffer.from(out.data, 'base64'))
    }
    await click('.cm-tstat-act')
    await until(`window.__mvComments.getState().threads.find((t) => t.id === ${JSON.stringify(f)})?.replies.some((r) => r.agent && /^Done:/.test(r.body))`, 30_000)
    await until(`window.__icon() === 'none'`)
    expect(journal().cards.find((x: any) => x.thread === f).ran.length).toBe(1)
  }, 120_000)

  skippable('two asks on one frame fail together: one notice for the batch, and its Retry retries both', async () => {
    agentMode({ fail: true })
    await browser!.eval(s, `window.__mvStore.getState().clearJamToasts(), 1`)
    // one write, so both are queued before a slot takes them: one batch (a tag alone on a free slot runs alone)
    const [x, y] = await browser!.eval(s, `window.__tags('spec/charlie', ['@marver one thing', '@marver another thing'])`)
    await until(`(window.__mvJamQueue.getState().cards ?? []).filter((c) => [${JSON.stringify(x)}, ${JSON.stringify(y)}].includes(c.thread) && c.state === 'failed').length === 2`, 30_000)
    await sleep(500)
    const notes = await browser!.eval(s, `window.__mvStore.getState().toasts.filter((t) => t.jam?.failed).map((t) => [t.jam.failed.length, t.jam.preview])`)
    expect(notes.length).toBe(1)
    expect(notes[0][0]).toBe(2)
    expect(notes[0][1]).toMatch(/^2 asks - /)
    agentMode({})
    await click('.sh-jam-view')                                              // Retry comes first on a failure notice
    await until(`(window.__mvJamQueue.getState().cards ?? []).filter((c) => [${JSON.stringify(x)}, ${JSON.stringify(y)}].includes(c.thread) && c.state === 'failed').length === 0`, 30_000)
    await until(`[${JSON.stringify(x)}, ${JSON.stringify(y)}].every((id) => window.__mvComments.getState().threads.find((t) => t.id === id)?.replies.some((r) => r.agent))`, 30_000)
  }, 120_000)

  skippable('a batch\'s questions arriving in two updates (a restart between them) fold into one notice', async () => {
    await browser!.eval(s, `window.__mvStore.getState().clearJamToasts(), 1`)
    const thread = (body: string) => browser!.eval(s, `window.__tag('spec/alpha', ${JSON.stringify(body)})`)
    const t1 = await thread('first'), t2 = await thread('second')
    // the daemon's questions for one batch: m1's now, m2's after a restart - two separate updates
    await browser!.eval(s, `window.__mvStore.getState().jamToast({ threadId: ${JSON.stringify(t1)}, board: 'main', ts: Date.now(), preview: 'Which one?', batch: 'b-split' }), 1`)
    await browser!.eval(s, `window.__mvStore.getState().jamToast({ threadId: ${JSON.stringify(t2)}, board: 'main', ts: Date.now(), preview: 'And this?', batch: 'b-split' }), 1`)
    const notes = await browser!.eval(s, `window.__mvStore.getState().toasts.filter((t) => t.jam?.batch === 'b-split').map((t) => [t.jam.preview, t.jam.stack?.length ?? 0])`)
    expect(notes).toEqual([['And this?', 1]])
  })
})
