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
/** Start begins a capture at once: dropped here, for a test about the session between captures */
const dropAuto = async () => {
  await until(`!!window.__mvJamCapture.getState().current`, 5000)
  await browser!.eval(s, `window.__mvJamCapture.getState().drop(), 1`)
  await until(`!window.__mvJamCapture.getState().current && !Object.keys(window.__mvJamCapture.getState().caps).length`, 5000)
}

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
// MV_FAKE_AGENT_DELAY_MS: a slow agent, to prove the waits hold a run that takes its time
setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', result: out }) + '\\n'), Number(process.env.MV_FAKE_AGENT_DELAY_MS) || 0)
`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-jam-ses-'))
  bin = mkdtempSync(join(tmpdir(), 'mv-jam-ses-bin-'))
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  put('package.json', { name: 'jam-session-fixture', private: true, type: 'module' })
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e)) }
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
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__realFetch=window.fetch;window.__errs=[];addEventListener('error',e=>__errs.push(String(e.message)));const ce=console.error;console.error=(...a)=>{__errs.push(a.map(String).join(' ').slice(0,400));ce(...a)}` }, s)
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

const skippable = (name: string, fn: () => Promise<void>, ms = 240_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)

/** The first four tests are one journey: each uses the session, capture, review and record the one before left. When
 *  one fails, the rest of it is skipped - one failure reported as one, not as four. */
let journeyBroken: string | null = null
const journey = (name: string, fn: () => Promise<void>, ms = Number(process.env.MV_JOURNEY_MS) || 240_000) =>
  it(name, async (ctx) => {
    if (!browser) return ctx.skip()
    if (journeyBroken) return ctx.skip(`the journey stopped at: ${journeyBroken}`)
    // however it fails - a throw, or the test's own timeout while something hangs - the journey stops here
    ctx.onTestFailed(() => { journeyBroken ??= name })
    // MV_BREAK_JOURNEY: its first test made to fail (`throw`) or to hang past its timeout (`hang`, with MV_JOURNEY_MS),
    // to prove the rest is skipped rather than failed
    if (process.env.MV_BREAK_JOURNEY === 'hang') await new Promise(() => {})
    if (process.env.MV_BREAK_JOURNEY) throw new Error('broken on purpose (MV_BREAK_JOURNEY)')
    await fn()
  }, ms)

/** A test that stands on its own starts from a clean page: no capture recording, no sheet or panel open, the page's
 *  fetch its own again, and no session running (ended on the server as End without a record does). */
const fresh = async () => {
  await browser!.eval(s, `(async () => {
    if (window.__realFetch) { window.fetch = window.__realFetch }
    const c = window.__mvJamCapture.getState(); if (c.current) c.drop()
    window.__mvJamUi.getState().close(); window.__mvJamUi.getState().setSheet(null)
    const q = window.__mvJamQueue.getState(); const ses = q.session
    if (ses) {
      const csrf = (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || ''
      await fetch('/__mv/api/jam/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf }, body: JSON.stringify({ action: 'end', id: ses.id }) }).catch(() => null)
      q.forget(ses.id)
    }
    await q.load()
    return 1
  })()`)
  await until(`!window.__mvJamQueue.getState().session && !window.__mvJamCapture.getState().current && !document.querySelector('[data-jam-sheet]')`, 10_000)
}
const alone = (name: string, fn: () => Promise<void>, ms = 240_000) => skippable(name, async () => { await fresh(); await fn() }, ms)

describe('the Jam session in the browser', () => {
  journey('J opens the start sheet (the agent it hands work to, the keys in one tooltip); Esc closes it; ⏎ starts the session AND its first capture - the dot pulses and the edges glow for the whole session, its clock counts seconds, then minutes; between captures the lane says it is still on', async () => {
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
    // ⏎: the session, and its first capture under way at once
    await until(`!!window.__mvJamQueue.getState().session && !document.querySelector('[data-jam-sheet]') && !!window.__mvJamCapture.getState().current`, 5000)
    await until(`document.querySelector('[data-jam-button]')?.getAttribute('data-jam-button') === 'rec' && !!document.querySelector('[data-jam-button] .jm-live-dot') && /\\d+s/.test(document.querySelector('[data-jam-button]').textContent)`, 3000)
    expect(await browser!.eval(s, `!!document.querySelector('[data-jam-edge]')`)).toBe(true)
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    // the clock ticks by the second in the first minute
    const c0 = await browser!.eval(s, `document.querySelector('[data-jam-button] .jm-clock').textContent`)
    await until(`document.querySelector('[data-jam-button] .jm-clock').textContent !== ${JSON.stringify(c0)}`, 3000)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('the save button is too quiet'), 1`)
    await key('e')
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    expect((await cards()).find((c: any) => c.id === id).session).toBe(await browser!.eval(s, `window.__mvJamQueue.getState().session.id`))
    // between captures: still on - the dot, the edges, and the lane's own tile (Capture S)
    await until(`document.querySelector('[data-jam-button]')?.getAttribute('data-jam-button') === 'live' && !!document.querySelector('[data-jam-button] .jm-live-dot')`, 3000)
    expect(await browser!.eval(s, `!!document.querySelector('[data-jam-edge]')`)).toBe(true)
    await until(`/Jam on/.test(document.querySelector('.jm-lane [data-tile="between"]')?.textContent ?? '')`, 3000)
    await pic('1b-between')
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)}`, 10_000)
    await enter()                                                              // confirm: the agent takes it
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'review')`, 90_000)
  })

  journey('J during a capture ends it first and waits for its read-back; the wrap-up lists the session\'s captures with where they stand, says what was answered in threads, takes your instructions - ⏎ writes the record, the session ends', async () => {
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
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.kind === 'wrapup' && c.state === 'review')`, 90_000)
    const w = (await cards()).find((c: any) => c.kind === 'wrapup')
    const tiles = await browser!.eval(s, `[...document.querySelectorAll('.jm-lane [data-tile]')].map((t) => t.dataset.tile)`)
    expect(tiles[tiles.length - 1]).toBe(w.id)
    expect(existsSync(join(root, w.file))).toBe(true)
    expect(w.file).toMatch(/^context\/sessions\//)
    expect(readFileSync(join(root, w.file), 'utf8')).toMatch(/lead with the save button/)
  })

  journey('a capture under review: Review and Capture tabs - the capture as it was read back, its pictures and timeline; Before/After keeps its key in a tooltip', async () => {
    const c = (await cards()).find((x: any) => x.kind === 'capture' && x.state === 'review')
    await click(`.jm-lane [data-tile="${c.id}"]`)
    await until(`!!document.querySelector('[data-jam-review] [data-jam-panes]')`, 5000)
    expect(await browser!.eval(s, `document.querySelector('[data-jam-review] .jm-fbar kbd')`)).toBeNull()
    await browser!.eval(s, `[...document.querySelectorAll('[data-jam-panes] button')].find((b) => b.textContent === 'Capture').click(), 1`)
    await until(`!!document.querySelector('[data-jam-readback] [data-jam-panes]') && !document.querySelector('[data-jam-review]')`, 3000)
    expect(await browser!.eval(s, `document.querySelector('[data-jam-readback]').textContent`)).toMatch(/the save button is too quiet/)
    await pic('3a-capture-tab')
    await browser!.eval(s, `[...document.querySelectorAll('[data-jam-panes] button')].find((b) => b.textContent === 'Review').click(), 1`)
    await until(`!!document.querySelector('[data-jam-review]')`, 3000)
    await browser!.eval(s, `window.__mvJamUi.getState().close(), 1`)
  })

  journey('the record opens in the focus panel - the page the agent wrote, its reply; ⇧⏎ More work writes it again with your note; ⏎ Looks good', async () => {
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
    await until(`(window.__mvJamQueue.getState().cards ?? []).filter((c) => c.kind === 'wrapup' && c.state === 'review').length === 1 && (window.__mvJamQueue.getState().cards ?? []).find((c) => c.id === ${JSON.stringify(w.id)})?.state === 'done'`, 90_000)
    const next = (await cards()).find((c: any) => c.kind === 'wrapup' && c.state === 'review')
    expect(readFileSync(join(root, next.file), 'utf8')).toMatch(/More: add the open questions/)
    // V walks the reviews oldest first (the session's capture comes before it): the record's own tile
    await click(`.jm-lane [data-tile="${next.id}"]`)
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(next.id)} && !!document.querySelector('[data-jam-record]')`, 5000)
    await enter()                                                                // Looks good
    await until(`(window.__mvJamQueue.getState().cards ?? []).find((c) => c.id === ${JSON.stringify(next.id)})?.state === 'done'`, 10_000)
  })

  alone('End without a record ends the session and writes nothing; in play the Jam button sits in the play pill and the lane folds to a counter (Q opens it)', async () => {
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 3000)
    await enter(); await until(`!!window.__mvJamQueue.getState().session`, 5000)
    await until(`!!window.__mvJamCapture.getState().current`)                     // its first capture, at once
    const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('try it in play'), 1`)
    await key('e')
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(id)}`, 30_000)
    await enter()
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'review')`, 90_000)
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

  alone('a record job that failed says so in the focus panel, with why, Retry and Drop - never "queued"', async () => {
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
    await enter()
    await until(`!!window.__mvJamQueue.getState().session && !document.querySelector('[data-jam-sheet]')`, 5000)
    await dropAuto()
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

  alone('a session ended in another tab while this one was still starting it: this tab never hears its talk', async () => {
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
    await dropAuto()   // (Start began a capture all the same - it goes on its own; dropped here)
  })

  alone('a slow queue answer overtaken by the push of the session ending never brings the session (or its microphone) back', async () => {
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
    await dropAuto()   // (Start began a capture all the same - it goes on its own; dropped here)
  })

  alone('a session started while the queue answers slowly: its talk begins with the push, before that answer', async () => {
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
    await dropAuto()
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="wrap"]')`, 5000)
    await browser!.eval(s, `[...document.querySelectorAll('[data-jam-sheet="wrap"] .jm-btn')].find((b) => /End without a record/.test(b.textContent)).click(), 1`)
    await until(`!window.__mvJamQueue.getState().session && !window.__mvJamVoiceSession()`, 5000)
  })

  alone('the push of a session before its start\'s answer, and the refresh held: its talk begins at the answer', async () => {
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch0 = f; window.__race = 0; window.__release = null; window.fetch = async (u, o) => {
      if (String(u).includes('/api/jam/session') && o?.method === 'POST' && JSON.parse(o.body).action === 'start') {
        window.__startId = JSON.parse(o.body).id
        const r = await f(u, o)
        // the answer waits until the push has shown the session here
        const t0 = Date.now(); while (window.__mvJamQueue.getState().session?.id !== window.__startId && Date.now() - t0 < 5000) await new Promise((x) => setTimeout(x, 20))
        window.__pushFirst = window.__mvJamQueue.getState().session?.id === window.__startId && window.__mvJamVoiceSession() !== window.__startId
        window.__race = 1
        return r
      }
      if (window.__race === 1 && String(u).includes('/api/jam/queue') && !(o?.method)) { window.__race = 2; await new Promise((r) => { window.__release = r }) }
      return f(u, o)
    }; return 1 })()`)
    try {
      await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
      await enter()
      await until(`window.__race === 2`, 8000)
      expect(await browser!.eval(s, `window.__pushFirst`)).toBe(true)            // the push came first, with no talk yet
      await until(`window.__mvJamVoiceSession() === window.__startId`, 3000)     // the answer starts it, the refresh still held
      await browser!.eval(s, `window.__release(), 1`)
    } finally { await browser!.eval(s, `(window.fetch = window.__fetch0), 1`) }
    await dropAuto()
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="wrap"]')`, 5000)
    await browser!.eval(s, `[...document.querySelectorAll('[data-jam-sheet="wrap"] .jm-btn')].find((b) => /End without a record/.test(b.textContent)).click(), 1`)
    await until(`!window.__mvJamQueue.getState().session && !window.__mvJamVoiceSession()`, 5000)
  })

  alone('a record refused while the queue answers slowly: at once the session goes on - its talk again, captures allowed, the reason said, Write again', async () => {
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
    await enter()
    await until(`!!window.__mvJamQueue.getState().session && window.__mvJamVoiceSession() === window.__mvJamQueue.getState().session.id`, 5000)
    const id = await browser!.eval(s, `window.__mvJamQueue.getState().session.id`)
    await dropAuto()
    // the record is refused (as when a capture is open in another tab), and the refresh after it is held
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch0 = f; window.__race = 0; window.__release = null; window.fetch = async (u, o) => {
      if (String(u).includes('/api/jam/session') && o?.method === 'POST' && JSON.parse(o.body).action === 'wrapup') { window.__race = 1; return new Response(JSON.stringify({ ok: false, error: 'a capture of the session is still recording or being sent in another tab' }), { status: 409, headers: { 'content-type': 'application/json' } }) }
      if (window.__race === 1 && String(u).includes('/api/jam/queue') && !(o?.method)) { window.__race = 2; await new Promise((r) => { window.__release = r }) }
      return f(u, o)
    }; return 1 })()`)
    try {
      await key('j'); await until(`!!document.querySelector('[data-jam-sheet="wrap"]') && document.activeElement?.hasAttribute('data-jam-wrap-field')`, 5000)
      await browser!.send('Input.insertText', { text: 'short' }, s)
      await enter()
      await until(`window.__race === 2`, 5000)                                   // refused; the refresh held
      await until(`window.__mvJamVoiceSession() === ${JSON.stringify(id)}`, 3000)  // its talk again
      await until(`/could not be written - a capture of the session is still recording/.test(document.body.textContent)`, 3000)
      expect(await browser!.eval(s, `[...document.querySelectorAll('[data-jam-sheet="wrap"] .jm-btn')].find((b) => /Write the record/.test(b.textContent))?.disabled`)).toBe(false)
      await esc(); await until(`!document.querySelector('[data-jam-sheet]')`, 3000)
      await key('s'); await until(`!!window.__mvJamCapture.getState().current`, 3000)   // captures start again
      await browser!.eval(s, `window.__mvJamCapture.getState().drop?.() ?? window.__mvJamCapture.getState().end(), 1`)
      await until(`!window.__mvJamCapture.getState().current`, 5000)
      await browser!.eval(s, `window.__release(), 1`)
    } finally { await browser!.eval(s, `(window.fetch = window.__fetch0), 1`) }
    await sleep(300)
    await until(`!window.__mvJamCapture.getState().current && !Object.keys(window.__mvJamCapture.getState().caps).length && !window.__mvJamCapture.getState().unsent.length`, 30_000)
    await esc(); await esc()
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="wrap"]')`, 10_000)
    await browser!.eval(s, `[...document.querySelectorAll('[data-jam-sheet="wrap"] .jm-btn')].find((b) => /End without a record/.test(b.textContent)).click(), 1`)
    await until(`!window.__mvJamQueue.getState().session && !window.__mvJamVoiceSession()`, 5000)
  })

  alone('Write again while the first refused try still refreshes: the first finishing late never frees the second', async () => {
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
    await enter()
    await until(`!!window.__mvJamQueue.getState().session`, 5000)
    await dropAuto()
    // try 1: refused at once, its refresh held; try 2: its answer held
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch0 = f; window.__n = 0; window.__rel1 = null; window.__rel2 = null; window.fetch = async (u, o) => {
      if (String(u).includes('/api/jam/session') && o?.method === 'POST' && JSON.parse(o.body).action === 'wrapup') {
        window.__n += 1
        if (window.__n === 2) await new Promise((r) => { window.__rel2 = r })
        return new Response(JSON.stringify({ ok: false, error: 'not yet' }), { status: 409, headers: { 'content-type': 'application/json' } })
      }
      if (window.__n === 1 && !window.__held1 && String(u).includes('/api/jam/queue') && !(o?.method)) { window.__held1 = true; await new Promise((r) => { window.__rel1 = r }) }
      return f(u, o)
    }; return 1 })()`)
    const writeBtn = `[...document.querySelectorAll('[data-jam-sheet="wrap"] .jm-btn')].find((b) => /Write the record/.test(b.textContent))`
    try {
      await key('j'); await until(`!!document.querySelector('[data-jam-sheet="wrap"]') && document.activeElement?.hasAttribute('data-jam-wrap-field')`, 5000)
      await browser!.send('Input.insertText', { text: 'twice' }, s)
      await enter()
      await until(`typeof window.__rel1 === 'function' && ${writeBtn}?.disabled === false`, 5000)   // try 1 refused; its refresh held
      await browser!.eval(s, `${writeBtn}.click(), 1`)
      await until(`typeof window.__rel2 === 'function'`, 5000)                                     // try 2 sent, unanswered
      await browser!.eval(s, `window.__rel1(), 1`)                                                // try 1 finishes late
      await sleep(400)
      expect(await browser!.eval(s, `${writeBtn}?.disabled`)).toBe(true)                          // still try 2's
      await browser!.eval(s, `window.__mvJamCapture.getState().start(), 1`)
      await sleep(200)
      expect(await browser!.eval(s, `window.__mvJamCapture.getState().current`)).toBeNull()       // no capture while it is out
      await browser!.eval(s, `window.__rel2(), 1`)
      await until(`${writeBtn}?.disabled === false`, 5000)
    } finally { await browser!.eval(s, `(window.fetch = window.__fetch0), 1`) }
    await browser!.eval(s, `[...document.querySelectorAll('[data-jam-sheet="wrap"] .jm-btn')].find((b) => /End without a record/.test(b.textContent)).click(), 1`)
    await until(`!window.__mvJamQueue.getState().session && !window.__mvJamVoiceSession()`, 5000)
  })

  alone('a session ended from here is gone at once - before any refresh or push, a capture started is not its', async () => {
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
    await enter()
    await until(`!!window.__mvJamQueue.getState().session`, 5000)
    await dropAuto()
    // no view reaches the page from here (the refresh is held, pushes are not applied)
    await browser!.eval(s, `(() => { const q = window.__mvJamQueue; window.__apply0 = q.getState().apply; q.setState({ apply: () => {} }); const f = window.fetch; window.__fetch0 = f; window.__release = null; window.__held = false; window.fetch = async (u, o) => {
      if (!window.__held && String(u).includes('/api/jam/queue') && !(o?.method)) { window.__held = true; await new Promise((r) => { window.__release = r }) }
      return f(u, o)
    }; return 1 })()`)
    try {
      await key('j'); await until(`!!document.querySelector('[data-jam-sheet="wrap"]')`, 5000)
      await browser!.eval(s, `[...document.querySelectorAll('[data-jam-sheet="wrap"] .jm-btn')].find((b) => /End without a record/.test(b.textContent)).click(), 1`)
      await until(`window.__held && !window.__mvJamQueue.getState().session`, 5000)
      await browser!.eval(s, `window.__mvJamCapture.getState().start(), 1`)
      await until(`!!window.__mvJamCapture.getState().current`, 3000)
      expect(await browser!.eval(s, `window.__mvJamCapture.getState().caps[window.__mvJamCapture.getState().current].session ?? null`)).toBeNull()
      await browser!.eval(s, `window.__mvJamCapture.getState().drop(), 1`)
    } finally {
      await browser!.eval(s, `(() => { window.__mvJamQueue.setState({ apply: window.__apply0 }); window.fetch = window.__fetch0; window.__release?.(); return 1 })()`)
    }
    await until(`!window.__mvJamCapture.getState().current`, 5000)
    expect(await browser!.eval(s, `window.__mvJamQueue.getState().session`)).toBeNull()
  })

  alone('a capture the server first hears of after the session ended (in another tab) goes on as a capture of its own, and says so', async () => {
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
    await enter()
    await until(`!!window.__mvJamQueue.getState().session`, 5000)
    await dropAuto()
    // the capture's registration is answered "ended" (another tab wrote the record first)
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch0 = f; window.fetch = async (u, o) => {
      if (String(u).includes('/api/jam/capture-open') && JSON.parse(o.body).on) return new Response(JSON.stringify({ ok: false, ended: true, error: 'the session has ended' }), { status: 409, headers: { 'content-type': 'application/json' } })
      return f(u, o)
    }; return 1 })()`)
    try {
      await key('s'); await until(`!!window.__mvJamCapture.getState().current`, 3000)
      await until(`!window.__mvJamCapture.getState().caps[window.__mvJamCapture.getState().current].session`, 3000)
      await until(`/the session ended in another tab - this capture is on its own/.test(document.body.textContent)`, 3000)
      await browser!.eval(s, `window.__mvJamCapture.getState().drop(), 1`)
    } finally { await browser!.eval(s, `(window.fetch = window.__fetch0), 1`) }
    await until(`!window.__mvJamCapture.getState().current`, 5000)
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="wrap"]')`, 5000)
    await browser!.eval(s, `[...document.querySelectorAll('[data-jam-sheet="wrap"] .jm-btn')].find((b) => /End without a record/.test(b.textContent)).click(), 1`)
    await until(`!window.__mvJamQueue.getState().session && !window.__mvJamVoiceSession()`, 5000)
  })

  alone('a capture whose upload says it landed outside its session (it overtook its registration) says so too, once', async () => {
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
    await enter()
    await until(`!!window.__mvJamQueue.getState().session`, 5000)
    await dropAuto()
    // its registration is never answered; its upload answers "outside"
    await browser!.eval(s, `(() => { const f = window.fetch; window.__fetch0 = f; window.__toasts = 0; window.fetch = async (u, o) => {
      if (String(u).includes('/api/jam/capture-open')) return new Promise(() => {})
      if (String(u).endsWith('/api/jam/capture') && o?.method === 'POST') { const r = await f(u, o); const b = await r.json(); return new Response(JSON.stringify({ ...b, outside: true }), { status: r.status, headers: { 'content-type': 'application/json' } }) }
      return f(u, o)
    }; const t = window.__mvStore.getState().toast; window.__toast0 = t; window.__mvStore.setState({ toast: (m) => { if (/on its own/.test(m)) window.__toasts += 1; return t(m) } }); return 1 })()`)
    try {
      await key('s'); await until(`!!window.__mvJamCapture.getState().current`, 3000)
      const id = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
      await browser!.eval(s, `window.__mvJamCapture.getState().note('outside'), 1`)
      await key('e')
      await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)})`, 30_000)
      await until(`window.__toasts === 1`, 5000)
      await sleep(300)
      expect(await browser!.eval(s, `window.__toasts`)).toBe(1)
    } finally { await browser!.eval(s, `(() => { window.fetch = window.__fetch0; window.__mvStore.setState({ toast: window.__toast0 }); return 1 })()`) }
    await esc(); await esc()
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="wrap"]')`, 10_000)
    await browser!.eval(s, `[...document.querySelectorAll('[data-jam-sheet="wrap"] .jm-btn')].find((b) => /End without a record/.test(b.textContent)).click(), 1`)
    await until(`!window.__mvJamQueue.getState().session && !window.__mvJamVoiceSession()`, 5000)
  })

  alone('a session started while the queue cannot be read: its talk begins when the push of it comes', async () => {
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
    await dropAuto()
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="wrap"]')`, 5000)
    await browser!.eval(s, `[...document.querySelectorAll('[data-jam-sheet="wrap"] .jm-btn')].find((b) => /End without a record/.test(b.textContent)).click(), 1`)
    await until(`!window.__mvJamQueue.getState().session && !window.__mvJamVoiceSession()`, 5000)
    // and no component broke along the way
    expect((await browser!.eval(s, `window.__errs`)).filter((e: string) => /error occurred in|Rendered (fewer|more) hooks|Minified React error/.test(e))).toEqual([])
  })

  alone('a capture with no session shows the dot too; Capture on the Jam on tile, over an open review, follows that review as S does', async () => {
    // no session: the dot while it records
    await key('s'); await until(`!!window.__mvJamCapture.getState().current`, 3000)
    await until(`document.querySelector('[data-jam-button]')?.getAttribute('data-jam-button') === 'rec' && !!document.querySelector('[data-jam-button] .jm-live-dot')`, 3000)
    const c1 = await browser!.eval(s, `window.__mvJamCapture.getState().current`)
    await browser!.eval(s, `window.__mvJamCapture.getState().note('make it louder'), 1`)
    await key('e')
    await until(`window.__mvJamUi.getState().panel?.id === ${JSON.stringify(c1)}`, 30_000)
    await enter()                                                                   // confirm: the agent takes it
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(c1)} && c.state === 'review')`, 90_000)
    // its review open, a session started: its first capture follows that review, as S would
    await click(`.jm-lane [data-tile="${c1}"]`)
    await until(`window.__mvJamUi.getState().panel?.kind === 'review' && window.__mvJamUi.getState().panel?.id === ${JSON.stringify(c1)}`, 5000)
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="start"]')`, 5000)
    await enter(); await until(`!!window.__mvJamQueue.getState().session && !!window.__mvJamCapture.getState().current`, 5000)
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().caps[window.__mvJamCapture.getState().current].reviewing?.card ?? null`)).toBe(c1)
    await dropAuto()
    // its review open again, then Capture on the Jam on tile
    await click(`.jm-lane [data-tile="${c1}"]`)
    await until(`window.__mvJamUi.getState().panel?.kind === 'review' && window.__mvJamUi.getState().panel?.id === ${JSON.stringify(c1)}`, 5000)
    await click('.jm-lane [data-tile="between"] .go')
    await until(`!!window.__mvJamCapture.getState().current`, 3000)
    expect(await browser!.eval(s, `window.__mvJamCapture.getState().caps[window.__mvJamCapture.getState().current].reviewing?.card ?? null`)).toBe(c1)
    await browser!.eval(s, `window.__mvJamCapture.getState().drop(), 1`)
    await until(`!window.__mvJamCapture.getState().current && !Object.keys(window.__mvJamCapture.getState().caps).length`, 5000)
    await esc()
    await key('j'); await until(`!!document.querySelector('[data-jam-sheet="wrap"]')`, 5000)
    await browser!.eval(s, `[...document.querySelectorAll('[data-jam-sheet="wrap"] .jm-btn')].find((b) => /End without a record/.test(b.textContent)).click(), 1`)
    await until(`!window.__mvJamQueue.getState().session`, 5000)
  })
})
