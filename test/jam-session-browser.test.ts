import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'

/**
 * The Jam session (spec 27 Part 5 - M4) where a person runs one: a REAL dev server, a fake `claude` on
 * PATH (it answers every member and writes a session record where the content says), a REAL browser.
 * J opens the start sheet, Start begins the session (the Jam button reads its minutes; a teal dot only
 * while a capture records), captures carry it, J ends it with the wrap-up sheet - your instructions,
 * the session's captures - and Write the record queues the record job, reviewed in the focus panel.
 * Skips without Chrome.
 */

const PORT = 8000 + Math.floor(Math.random() * 300)
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = (expr: string, ms = 20_000) => browser!.until(s, expr, ms)
const key = (k: string, shift = false) => browser!.press(s, k, { shift })
const enter = async () => { const b = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }; await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...b }, s); await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...b }, s) }
const esc = async () => { const b = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }; await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...b }, s); await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...b }, s) }
const click = async (selector: string) => {
  const at = await browser!.eval(s, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await browser!.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
}
const hover = async (selector: string) => {
  const at = await browser!.eval(s, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  await browser!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 450 }, s)
  await browser!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y }, s)
}
/** with MARVER_SHOT_DIR set, a picture of the page */
const pic = async (name: string) => {
  if (!process.env.MARVER_SHOT_DIR) return
  await sleep(300)
  const out = await browser!.send('Page.captureScreenshot', { format: 'png' }, s)
  writeFileSync(join(process.env.MARVER_SHOT_DIR, `session-${name}.png`), Buffer.from(out.data, 'base64'))
}
const cards = () => browser!.eval(s, `window.__mvJamQueue.getState().cards ?? []`)

/** A fake `claude -p <goal>`: answers every member; a session record is written where its content says. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const goal = process.argv[process.argv.indexOf('-p') + 1] || ''
const file = (/design\\/\\.local\\/jam\\/packets\\/[\\w-]+\\.json/.exec(goal) || [])[0]
if (!file) process.exit(1)
const p = JSON.parse(fs.readFileSync(file, 'utf8'))
if (p.members.some((m) => m.brief.wrapup && /FAIL-RECORD/.test(m.brief.wrapup.content.instructions))) process.exit(1)
for (const m of p.members) if (m.brief.wrapup) {
  const c = m.brief.wrapup.content
  fs.mkdirSync(path.dirname(c.file), { recursive: true })
  fs.writeFileSync(c.file, '# Session record\\n\\nInstructions: ' + c.instructions + '\\n\\n' + c.captures.map((x) => '- ' + x.title + ' (' + x.state + ')').join('\\n') + (c.more ? '\\n\\nMore: ' + c.more : '') + '\\n')
}
const F = '\`\`\`'
const out = p.members.map((m) => F + 'marver-reply ' + m.id + '\\n' + (m.brief.wrapup ? 'The record lists ' + m.brief.wrapup.content.captures.length + ' captures.' : 'Done: ' + m.brief.asks.map((a) => a.body).join(' + ')) + '\\n' + F).join('\\n')
process.stdout.write(JSON.stringify({ type: 'result', result: out }) + '\\n')
`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-jam-ses-'))
  bin = mkdtempSync(join(tmpdir(), 'mv-jam-ses-bin-'))
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  put('package.json', { name: 'jam-session-fixture', private: true, type: 'module' })
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  put('design/config.ts', "export default { jam: { agent: 'claude', concurrency: 1 } }\n")
  for (const f of ['alpha', 'bravo']) put(`design/scenes/spec/${f}.tsx`, `export default () => <main><h1>${f}</h1><button>Save</button></main>\n`)
  put('design/boards/main.json', { version: 1, name: 'main', auto: false, order: 0, nodes: [{ frame: 'spec/alpha' }, { frame: 'spec/bravo' }] })
  mkdirSync(join(root, 'context'), { recursive: true })
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BROWSER: 'none', CI: '1', MARVER_MODELS: join(root, 'no-models') } })
  server.stdout?.on('data', (d) => { log += d; const m = log.match(/→ (http:\/\/localhost:\d+)\//); if (m) ORIGIN = m[1] })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !/→ http:\/\/localhost:\d+\//.test(log)) await sleep(100)
  while (Date.now() - t0 < 60_000) { if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break; await sleep(200) }
  browser = await Browser.launch()
  if (!browser) return
  s = await browser.tab({ width: 1400, height: 900 })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs=[];addEventListener('error',e=>__errs.push(String(e.message)));const ce=console.error;console.error=(...a)=>{__errs.push(a.map(String).join(' ').slice(0,400));ce(...a)}` }, s)
  await browser.go(s, `${ORIGIN}/#/b/main`)
  await until(`window.__mvStore?.getState().nodes.length === 2 && window.__mvStore.getState().nodes.every((n) => n.status === 'ready') && !!window.__mvJamQueue && !!window.__mvJamVoice && window.__mvJamQueue.getState().agent === 'claude'`, 45_000)
  // typed notes only here (no model): the microphone is not asked about
  await browser.eval(s, `window.__mvJamVoice.getState().setChoice('no'), 1`)
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

const skippable = (name: string, fn: () => Promise<void>, ms = 120_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)

describe('the Jam session in the browser', () => {
  skippable('J opens the start sheet (the agent it hands work to, the keys in one tooltip); Esc closes it; ⏎ starts - the Jam button reads the session\'s minutes, a teal dot only while a capture records', async () => {
    expect(await browser!.eval(s, `document.querySelector('[data-jam-button]')?.getAttribute('data-jam-button')`)).toBe('idle')
    await key('j')
    await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
    expect(await browser!.eval(s, `document.querySelector('[data-jam-sheet="start"]').textContent`)).toMatch(/Hands work to.*Claude Code/)
    await hover('[data-jam-shortcuts]')
    await until(`/End the session\\s*J/.test(document.querySelector('.jm-sctip')?.textContent ?? '')`, 3000)
    await pic('1-start')
    await esc()
    await until(`!document.querySelector('[data-jam-sheet]')`, 3000)
    expect(await browser!.eval(s, `window.__mvJamQueue.getState().session`)).toBeNull()
    await key('j')
    await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 3000)
    await enter()
    await until(`!!window.__mvJamQueue.getState().session && !document.querySelector('[data-jam-sheet]')`, 5000)
    await until(`document.querySelector('[data-jam-button]')?.getAttribute('data-jam-button') === 'live' && /\\d+m/.test(document.querySelector('[data-jam-button]').textContent)`, 3000)
    // a capture records: the dot, then back to the minutes
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    await until(`document.querySelector('[data-jam-button]')?.getAttribute('data-jam-button') === 'rec' && !!document.querySelector('[data-jam-button] .jm-live-dot')`, 3000)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('the save button is too quiet'), 1`)
    await key('e')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    expect((await cards()).find((c: any) => c.id === id).session).toBe(await browser!.eval(s, `window.__mvJamQueue.getState().session.id`))
    await until(`document.querySelector('[data-jam-button]')?.getAttribute('data-jam-button') === 'live'`, 3000)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)}`, 10_000)
    await enter()                                                              // confirm: the agent takes it
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'review')`, 30_000)
  })

  skippable('J during a capture ends it first and waits for its read-back; the wrap-up lists the session\'s captures with where they stand, says what was answered in threads, takes your instructions - ⏎ writes the record, the session ends', async () => {
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const k = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('an idea for later'), 1`)
    await key('j')                                                              // ends the capture first
    await until(`!window.__mvJamCapture.getState().current && window.__mvJamUi.getState().sheet === 'wrap-pending'`, 5000)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(k)}`, 30_000)
    expect(await browser!.eval(s, `!!document.querySelector('[data-jam-sheet="wrap"]')`)).toBe(false)
    await key('k')                                                              // kept, for the record
    await until(`!!document.querySelector('[data-jam-sheet="wrap"]')`, 10_000)
    const rows = await browser!.eval(s, `[...document.querySelectorAll('[data-jam-wrap-row]')].map((r) => r.getAttribute('data-jam-wrap-row'))`)
    expect(rows.sort()).toEqual(['kept', 'review'])
    // it names where the record goes, as the server picks it (this project has context/)
    await until(`/one page in context\\/sessions\\//.test(document.querySelector('[data-jam-sheet="wrap"]').textContent)`, 5000)
    // the field has the focus; it grows past three lines
    expect(await browser!.eval(s, `document.activeElement?.hasAttribute('data-jam-wrap-field')`)).toBe(true)
    const h0 = await browser!.eval(s, `document.querySelector('[data-jam-wrap-field]').getBoundingClientRect().height`)
    expect(h0).toBeGreaterThanOrEqual(60)
    await browser!.send('Input.insertText', { text: 'lead with the save button\nfile the idea as backlog\nkeep it short\nand name the frames' }, s)
    await sleep(150)
    expect(await browser!.eval(s, `document.querySelector('[data-jam-wrap-field]').getBoundingClientRect().height`)).toBeGreaterThan(h0)
    await pic('2-wrap')
    await enter()                                                               // write the record
    await until(`!window.__mvJamQueue.getState().session && !document.querySelector('[data-jam-sheet]')`, 10_000)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.kind === 'wrapup')`, 10_000)
    // the record job: the run's last tile; it comes back to review
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.kind === 'wrapup' && c.state === 'review')`, 30_000)
    const w = (await cards()).find((c: any) => c.kind === 'wrapup')
    const tiles = await browser!.eval(s, `[...document.querySelectorAll('.jm-lane [data-tile]')].map((t) => t.dataset.tile)`)
    expect(tiles[tiles.length - 1]).toBe(w.id)
    expect(existsSync(join(root, w.file))).toBe(true)
    expect(w.file).toMatch(/^context\/sessions\//)
    expect(readFileSync(join(root, w.file), 'utf8')).toMatch(/lead with the save button/)
  })

  skippable('the record opens in the focus panel - the page the agent wrote, its reply; ⇧⏎ More work writes it again with your note; ⏎ Looks good', async () => {
    const w = (await cards()).find((c: any) => c.kind === 'wrapup' && c.state === 'review')
    await click(`.jm-lane [data-tile="${w.id}"]`)
    await until(`/Session record/.test(document.querySelector('[data-jam-record]')?.textContent ?? '') && /lead with the save button/.test(document.querySelector('[data-jam-record] .jm-record')?.textContent ?? '')`, 10_000)
    expect(await browser!.eval(s, `document.querySelector('[data-jam-record] .jm-reply')?.textContent ?? ''`)).toMatch(/The record lists 2 captures/)
    await pic('3-record')
    { const b = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 }; await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...b }, s); await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...b }, s) }   // ⇧⏎ More work
    await until(`!!document.querySelector('[data-jam-record] .jm-more textarea')`, 3000)
    await browser!.send('Input.insertText', { text: 'add the open questions' }, s)
    await enter()
    await until(`(window.__mvJamQueue.getState().cards ?? []).filter((c) => c.kind === 'wrapup').length === 2`, 10_000)
    await until(`(window.__mvJamQueue.getState().cards ?? []).filter((c) => c.kind === 'wrapup' && c.state === 'review').length === 1 && (window.__mvJamQueue.getState().cards ?? []).find((c) => c.id === ${JSON.stringify(w.id)})?.state === 'done'`, 30_000)
    const next = (await cards()).find((c: any) => c.kind === 'wrapup' && c.state === 'review')
    expect(readFileSync(join(root, next.file), 'utf8')).toMatch(/More: add the open questions/)
    // V walks the reviews oldest first (the session's capture comes before it): the record's own tile
    await click(`.jm-lane [data-tile="${next.id}"]`)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(next.id)} && !!document.querySelector('[data-jam-record]')`, 5000)
    await enter()                                                                // Looks good
    await until(`(window.__mvJamQueue.getState().cards ?? []).find((c) => c.id === ${JSON.stringify(next.id)})?.state === 'done'`, 10_000)
  })

  skippable('End without a record ends the session and writes nothing; in play the Jam button sits in the play pill and the lane folds to a counter (Q opens it)', async () => {
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 3000)
    await enter(); await until(`!!window.__mvJamQueue.getState().session`, 5000)
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('try it in play'), 1`)
    await key('e')
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)}`, 30_000)
    await enter()
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'review')`, 30_000)
    // play
    await browser!.eval(s, `window.__mvStore.getState().enterPlay?.() ?? document.querySelector('.sh-pill .sh-pill-btn svg')?.closest('button') , 1`)
    await key('p')
    await until(`!!window.__mvStore.getState().play && !!document.querySelector('.sh-play-pill [data-jam-button]')`, 10_000)
    await until(`!!document.querySelector('[data-jam-counter]') && !document.querySelector('.jm-lane .jm-card')`, 5000)
    await pic('4-play')
    await key('q')
    await until(`!!document.querySelector('.jm-lane .jm-card')`, 3000)
    await esc(); await esc()
    await until(`!window.__mvStore.getState().play`, 5000)
    // end without a record
    const before = (await cards()).filter((c: any) => c.kind === 'wrapup').length
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="wrap"]')`, 5000)
    await browser!.eval(s, `[...document.querySelectorAll('[data-jam-sheet="wrap"] .jm-btn')].find((b) => /End without a record/.test(b.textContent)).click(), 1`)
    await until(`!window.__mvJamQueue.getState().session && !document.querySelector('[data-jam-sheet]')`, 5000)
    expect((await cards()).filter((c: any) => c.kind === 'wrapup').length).toBe(before)
    expect(await browser!.eval(s, `document.querySelector('[data-jam-button]')?.getAttribute('data-jam-button')`)).toBe('idle')
  })

  skippable('a record job that failed says so in the focus panel, with why, Retry and Drop - never "queued"', async () => {
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
    await enter()
    await until(`!!window.__mvJamQueue.getState().session && !document.querySelector('[data-jam-sheet]')`, 5000)
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="wrap"]') && document.activeElement?.hasAttribute('data-jam-wrap-field')`, 5000)
    await browser!.send('Input.insertText', { text: 'FAIL-RECORD please' }, s)
    await enter()
    await until(`!window.__mvJamQueue.getState().session`, 10_000)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.kind === 'wrapup' && c.state === 'failed')`, 60_000)
    const f = (await cards()).find((c: any) => c.kind === 'wrapup' && c.state === 'failed')
    await until(`!!document.querySelector('.jm-lane [data-tile="${f.id}"]')`, 5000)
    await click(`.jm-lane [data-tile="${f.id}"]`)
    await until(`!!document.querySelector('[data-jam-record] [data-jam-record-failed]')`, 5000)
    const text = await browser!.eval(s, `document.querySelector('[data-jam-record]').textContent`)
    expect(text).toMatch(/The record was not written/)
    expect(text).not.toMatch(/Queued/)
    expect(await browser!.eval(s, `[...document.querySelectorAll('[data-jam-record] .jm-btn')].map((b) => b.textContent)`)).toEqual(['Retry', 'Drop'])
    await pic('5-record-failed')
    await browser!.eval(s, `[...document.querySelectorAll('[data-jam-record] .jm-btn')].find((b) => b.textContent === 'Drop').click(), 1`)
    await until(`(window.__mvJamQueue.getState().cards ?? []).find((c) => c.id === ${JSON.stringify(f.id)})?.state === 'dropped' && !document.querySelector('[data-jam-record]')`, 5000)
  })

  skippable('a session ended in another tab while this one was still starting it: this tab never hears its talk', async () => {
    // the start lands, then (before this page hears back) another tab ends it
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch0 = f; window.fetch = async (u, o) => {
      const r = await f(u, o)
      if (String(u).includes('/api/jam/session') && o?.method === 'POST' && JSON.parse(o.body).action === 'start') {
        window.__startId = JSON.parse(o.body).id
        await f(u, { ...o, body: JSON.stringify({ action: 'end', id: window.__startId }) })
      }
      return r
    }; return 1 })()`)
    try {
      await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
      await enter()
      await until(`!document.querySelector('[data-jam-sheet]')`, 5000)
      await sleep(500)
      expect(await browser!.eval(s, `window.__mvJamQueue.getState().session`)).toBeNull()
      expect(await browser!.eval(s, `window.__startId`)).toMatch(/^ses-/)
      expect(await browser!.eval(s, `window.__mvJamVoiceSession()`)).toBeNull()
    } finally { await browser!.eval(s, `(window.fetch = window.__fetch0), 1`) }
  })

  skippable('a slow queue answer overtaken by the push of the session ending never brings the session (or its microphone) back', async () => {
    // the start lands; the queue's answer (with the session) is held while another tab ends it and the push
    // of that arrives - then the old answer comes in
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch0 = f; window.__race = 0; window.fetch = async (u, o) => {
      if (String(u).includes('/api/jam/session') && o?.method === 'POST' && JSON.parse(o.body).action === 'start') { window.__startId = JSON.parse(o.body).id; window.__race = 1 }
      if (window.__race === 1 && String(u).includes('/api/jam/queue') && !(o?.method)) {
        window.__race = 2
        const r = await f(u, o)
        await f('/__mv/api/jam/session', { method: 'POST', headers: { ...(o?.headers ?? {}), 'content-type': 'application/json' }, body: JSON.stringify({ action: 'end', id: window.__startId }) })
        await new Promise((r) => setTimeout(r, 600))
        window.__afterPush = window.__mvJamQueue.getState().session
        return r
      }
      return f(u, o)
    }; return 1 })()`)
    try {
      await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
      await enter()
      await until(`window.__race === 2 && !document.querySelector('[data-jam-sheet]')`, 5000)
      await sleep(1200)
      expect(await browser!.eval(s, `window.__afterPush`)).toBeNull()          // the push of the end came first
      expect(await browser!.eval(s, `window.__mvJamQueue.getState().session`)).toBeNull()
      expect(await browser!.eval(s, `window.__mvJamVoiceSession()`)).toBeNull()
    } finally { await browser!.eval(s, `(window.fetch = window.__fetch0), 1`) }
  })

  skippable('a session started while the queue answers slowly: its talk begins with the push, before that answer', async () => {
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch0 = f; window.__race = 0; window.__release = null; window.fetch = async (u, o) => {
      if (String(u).includes('/api/jam/session') && o?.method === 'POST' && JSON.parse(o.body).action === 'start') { window.__startId = JSON.parse(o.body).id; window.__race = 1 }
      if (window.__race === 1 && String(u).includes('/api/jam/queue') && !(o?.method)) { window.__race = 2; await new Promise((r) => { window.__release = r }) }
      return f(u, o)
    }; return 1 })()`)
    try {
      await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
      await enter()
      await until(`window.__race === 2`, 5000)
      await until(`window.__mvJamQueue.getState().session?.id === window.__startId`, 5000)   // the push
      await until(`window.__mvJamVoiceSession() === window.__startId`, 5000)                // its talk, the answer still held
      expect(await browser!.eval(s, `typeof window.__release`)).toBe('function')
      await browser!.eval(s, `window.__release(), 1`)
    } finally { await browser!.eval(s, `(window.fetch = window.__fetch0), 1`) }
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="wrap"]')`, 5000)
    await browser!.eval(s, `[...document.querySelectorAll('[data-jam-sheet="wrap"] .jm-btn')].find((b) => /End without a record/.test(b.textContent)).click(), 1`)
    await until(`!window.__mvJamQueue.getState().session && !window.__mvJamVoiceSession()`, 5000)
  })

  skippable('a session started while the queue cannot be read: its talk begins when the push of it comes', async () => {
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch0 = f; window.__race = 0; window.fetch = async (u, o) => {
      if (String(u).includes('/api/jam/session') && o?.method === 'POST' && JSON.parse(o.body).action === 'start') { window.__startId = JSON.parse(o.body).id; window.__race = 1 }
      if (window.__race === 1 && String(u).includes('/api/jam/queue') && !(o?.method)) { window.__race = 2; throw new TypeError('offline') }
      return f(u, o)
    }; return 1 })()`)
    try {
      await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
      await enter()
      await until(`window.__race === 2`, 5000)
      await until(`window.__mvJamQueue.getState().session?.id === window.__startId`, 5000)   // the push
      await until(`window.__mvJamVoiceSession() === window.__startId`, 5000)                // its talk
    } finally { await browser!.eval(s, `(window.fetch = window.__fetch0), 1`) }
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="wrap"]')`, 5000)
    await browser!.eval(s, `[...document.querySelectorAll('[data-jam-sheet="wrap"] .jm-btn')].find((b) => /End without a record/.test(b.textContent)).click(), 1`)
    await until(`!window.__mvJamQueue.getState().session && !window.__mvJamVoiceSession()`, 5000)
    // and no component broke along the way
    expect((await browser!.eval(s, `window.__errs`)).filter((e: string) => /error occurred in|Rendered (fewer|more) hooks|Minified React error/.test(e))).toEqual([])
  })
})
