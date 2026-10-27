import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'
import { modelsReady } from '../src/server/jam/speech-models.ts'

/**
 * Words on this Mac (spec 27 Part 4) where a person speaks: a REAL dev server with the model, a REAL
 * browser whose microphone is `test/fixtures/speech/en.wav` (Chrome's fake capture device). The first S
 * asks once; yes opens the microphone; the words stream over the capture tile; E cuts the audio and the
 * read-back holds them, each with its time. Skips without Chrome or without the model (MARVER_MODELS).
 */

const PORT = 7800 + Math.floor(Math.random() * 150)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const WAV = join(import.meta.dirname, 'fixtures', 'speech', 'en.wav')
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
/** with MARVER_SHOT_DIR set, a picture of the page */
const pic = async (name: string) => {
  if (!process.env.MARVER_SHOT_DIR) return
  await sleep(300)
  const out = await browser!.send('Page.captureScreenshot', { format: 'png' }, s)
  writeFileSync(join(process.env.MARVER_SHOT_DIR, `voice-${name}.png`), Buffer.from(out.data, 'base64'))
}
const click = async (selector: string) => {
  const at = await browser!.eval(s, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await browser!.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 }, s)
}

const haveModel = await modelsReady().catch(() => false)

/** The recording as Chrome's fake microphone plays it: a plain RIFF/fmt/data WAV, after one second of
 *  silence - the file starts the instant the microphone opens, and a person starts speaking after that. */
function plainWav(src: string, dest: string) {
  const b = readFileSync(src)
  let o = 12, fmt: Buffer | null = null, data: Buffer | null = null
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4)
    if (id === 'fmt ') fmt = b.subarray(o + 8, o + 8 + n)
    if (id === 'data') data = b.subarray(o + 8, o + 8 + n)
    o += 8 + n + (n % 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + data!.length, 4); head.write('WAVE', 8)
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); fmt!.copy(head, 20, 0, 16)
  const lead = Buffer.alloc(fmt!.readUInt32LE(8))   // one second (the format's bytes per second)
  head.write('data', 36); head.writeUInt32LE(lead.length + data!.length, 40)
  head.writeUInt32LE(36 + lead.length + data!.length, 4)
  writeFileSync(dest, Buffer.concat([head, lead, data!]))
}

beforeAll(async () => {
  if (!haveModel) return
  root = mkdtempSync(join(tmpdir(), 'mv-jam-voice-'))
  bin = mkdtempSync(join(tmpdir(), 'mv-jam-voice-bin-'))
  writeFileSync(join(bin, 'claude'), '#!/usr/bin/env node\nprocess.exit(1)\n')
  chmodSync(join(bin, 'claude'), 0o755)
  put('package.json', { name: 'jam-voice-fixture', private: true, type: 'module' })
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver' && e !== '@marver-design') symlinkSync(join(repoNm, e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  put('design/config.ts', "export default { jam: { agent: 'claude', concurrency: 1 } }\n")
  put('design/scenes/spec/alpha.tsx', 'export default () => <main><h1>alpha</h1></main>\n')
  put('design/boards/main.json', { version: 1, name: 'main', auto: false, order: 0, nodes: [{ frame: 'spec/alpha' }] })
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d; const m = log.match(/→ (http:\/\/localhost:\d+)\//); if (m) ORIGIN = m[1] })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !/→ http:\/\/localhost:\d+\//.test(log)) await sleep(100)
  while (Date.now() - t0 < 60_000) { if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break; await sleep(200) }
  // the microphone is the recording, played once; the browser grants it as a person's Allow would
  const wav = join(root, 'mic.wav')
  plainWav(WAV, wav)
  // (the audio service runs in the browser's process: sandboxed apart, it cannot read the file and hears silence)
  browser = await Browser.launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`,
    '--disable-features=AudioServiceOutOfProcess', '--autoplay-policy=no-user-gesture-required'])
  if (!browser) return
  s = await browser.tab({ width: 1400, height: 900 })
  await browser.go(s, `${ORIGIN}/#/b/main`)
  await until(`window.__mvStore?.getState().nodes.length === 1 && window.__mvStore.getState().nodes.every((n) => n.status === 'ready') && !!window.__mvJamVoice`, 45_000)
}, 120_000)

afterAll(async () => {
  browser?.close()
  if (server && server.exitCode === null) {
    const gone = new Promise((r) => server!.once('exit', r))
    try { server.kill('SIGTERM') } catch { /* gone */ }
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))])
  }
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  if (bin) rmSync(bin, { recursive: true, force: true })
})

describe.skipIf(!haveModel)('words in the browser', () => {
  it('the first S asks once; yes opens the microphone; the words stream over the tile and E puts them in the read-back with their times', async (ctx) => {
    if (!browser) return ctx.skip()
    await key('s')
    await until(`!!window.__mvJamCapture.getState().current`)
    const id = await browser.eval(s, `window.__mvJamCapture.getState().current`)
    // asked once, over the capture tile
    await until(`document.querySelector('[data-jam-voiceask]')?.getAttribute('data-jam-voiceask') === 'ask'`, 10_000)
    await pic('1-ask')
    await browser.eval(s, `[...document.querySelectorAll('[data-jam-voiceask] .jm-btn')].find((b) => /Use the microphone/.test(b.textContent)).click(), 1`)
    await until(`window.__mvJamVoice.getState().hearing === ${JSON.stringify(id)} && document.querySelector('[data-jam-mic]')?.getAttribute('data-jam-mic') === 'on'`, 20_000)
    expect(await browser.eval(s, `localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('mv-jam-voice:')))`)).toBe('yes')
    // the words come as phrases end, over the tile
    await until(`/plan badge/.test(document.querySelector('[data-jam-caption]')?.textContent ?? '')`, 30_000)
    await pic('2-caption')
    await sleep(1000)
    await key('e', true)
    await until(`(window.__mvJamQueue.getState().cards ?? []).some((c) => c.id === ${JSON.stringify(id)} && c.state === 'draft')`, 30_000)
    const rec = await browser.eval(s, `fetch('/__mv/api/jam/capture?id=${id}', { headers: { 'x-mv-c': (/(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie) || [])[1] || '' } }).then((r) => r.json())`)
    const words = rec.record.timeline.filter((x: any) => x.event === 'words')
    expect(words.length).toBeGreaterThan(0)
    const text = words.map((x: any) => x.text).join(' ')
    expect(text).toMatch(/This badge should match the plan badge/)
    // each word has its time, in order, inside the capture
    const all = words.flatMap((x: any) => x.words)
    const start = rec.record.timeline[0].at, end = rec.record.timeline[rec.record.timeline.length - 1].at
    expect(all.every((w: any, i: number) => w.at >= start && w.at <= end && (i === 0 || w.at >= all[i - 1].at))).toBe(true)
    await until(`/plan badge/.test(document.querySelector('.jm-focus')?.textContent ?? '')`, 10_000)
    await pic('3-readback')
    expect(await browser.eval(s, `document.querySelector('.jm-focus .meta')?.textContent ?? ''`)).not.toMatch(/point/)   // no click, no point (a picture is not one)
    // the microphone is closed between captures
    expect(await browser.eval(s, `window.__mvJamVoice.getState().hearing`)).toBeNull()
    await browser.eval(s, `(() => { const q = window.__mvJamQueue.getState(); return q.act(q.cards.find((c) => c.id === ${JSON.stringify(id)}), 'drop') })()`)
    await browser.eval(s, `window.__mvJamUi.getState().close(), 1`)
  }, 120_000)

  it('asked once: the next S opens the microphone without asking; "Typed notes only" is remembered and the tile shows the microphone off - a click asks again', async (ctx) => {
    if (!browser) return ctx.skip()
    await key('s')
    await until(`!!window.__mvJamCapture.getState().current`)
    await until(`document.querySelector('[data-jam-mic]')?.getAttribute('data-jam-mic') === 'on'`, 20_000)
    expect(await browser.eval(s, `!!document.querySelector('[data-jam-voiceask]')`)).toBe(false)
    // no, during the capture: the microphone closes at once (the tile shows it off)
    await browser.eval(s, `window.__mvJamVoice.getState().setChoice('no'), 1`)
    await until(`window.__mvJamVoice.getState().hearing === null && document.querySelector('[data-jam-mic]')?.getAttribute('data-jam-mic') === 'off'`, 5000)
    await browser.eval(s, `window.__mvJamVoice.getState().setChoice('yes'), 1`)
    await until(`document.querySelector('[data-jam-mic]')?.getAttribute('data-jam-mic') === 'on'`, 20_000)
    const esc = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', ...esc }, s); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...esc }, s)
    await until(`!window.__mvJamCapture.getState().current && window.__mvJamVoice.getState().hearing === null`, 5000)
    // no
    await browser.eval(s, `window.__mvJamVoice.getState().setChoice('no'), 1`)
    await key('s')
    await until(`!!window.__mvJamCapture.getState().current`)
    await until(`document.querySelector('[data-jam-mic]')?.getAttribute('data-jam-mic') === 'off'`, 5000)
    expect(await browser.eval(s, `window.__mvJamVoice.getState().hearing`)).toBeNull()
    await click('[data-jam-mic]')
    await until(`document.querySelector('[data-jam-voiceask]')?.getAttribute('data-jam-voiceask') === 'ask'`, 5000)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', ...esc }, s); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...esc }, s)
    await until(`!window.__mvJamCapture.getState().current`, 5000)
  }, 60_000)
})
