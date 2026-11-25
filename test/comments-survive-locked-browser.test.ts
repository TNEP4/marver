import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { findChrome } from '../src/server/cdp.ts'

/**
 * Spec 36 on the LOCKED stage: a published canvas whose every board is locked to present boots the stage shell
 * (LockedApp.tsx), not the canvas. The reviewer is told there too when the session ends, with Sign in again, and a
 * refused comment is said with its reason, Retry and Discard (no canvas to Show it on). Port 4816. Skips without Chrome.
 */

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const PORT = 4816
const ORIGIN = `http://localhost:${PORT}`
const REVIEWER = 'ana@client.test'
let root = ''
let data = ''
let server: ChildProcess | null = null
let log = ''
let browser: Browser | null = null
let tab = ''
const asked: string[] = []

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const authFile = () => join(data, 'auth.json')
const auth = () => JSON.parse(readFileSync(authFile(), 'utf8'))
const writeAuth = (a: unknown) => writeFileSync(authFile(), JSON.stringify(a, null, 2), { mode: 0o600 })
/** A fresh session for the reviewer, as a Marver ID sign-in would leave it: in the store and in the browser. */
async function signIn(): Promise<string> {
  const tok = randomBytes(24).toString('base64url')
  const a = auth()
  a.sessions.push({ tokenHash: sha(tok), emailNorm: REVIEWER, exp: Date.now() + 30 * 86_400_000 })
  writeAuth(a)
  await browser!.send('Network.setCookie', { name: 'mv_s', value: tok, url: ORIGIN, httpOnly: true }, tab)
  await browser!.send('Network.setCookie', { name: 'mv_c', value: randomBytes(12).toString('base64url'), url: ORIGIN }, tab)
  return tok
}
/** The session ends on the server - its 30 days ran out, or the owner's access date passed. */
function endSessions() { const a = auth(); a.sessions = []; writeAuth(a) }
const stored = () => {
  try { return readFileSync(join(data, 'comments', 'main.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) } catch { return [] }
}
const replies = (body: string) => stored().filter((e) => e.type === 'reply' && e.body === body)

function start() {
  server = spawn(process.execPath, [CLI, 'serve', '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: {
    ...process.env, MARVER_DATA_DIR: data, MARVER_PASSWORD: '', MARVER_CLI_TOKEN: '',
    MARVER_ID_ISSUER: 'http://localhost:4817', MARVER_PUBLIC_ORIGIN: ORIGIN,
  } })
  server.stdout?.on('data', (d) => { log += d })
  server.stderr?.on('data', (d) => { log += d })
  return new Promise<void>((resolve) => { const t = setInterval(() => { if (log.includes('serving design/.dist')) { clearInterval(t); resolve() } }, 50) })
}
async function stop() {
  const s = server
  server = null
  if (!s || s.exitCode !== null) return
  await new Promise<void>((r) => { s.once('exit', () => r()); s.kill('SIGTERM') })
}

beforeAll(async () => {
  if (!findChrome()) return
  root = mkdtempSync(join(tmpdir(), 'mv-survive-locked-'))
  data = join(root, 'data')
  mkdirSync(data)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'survive-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules'), nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver') symlinkSync(join(repoNm, e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  mkdirSync(join(root, 'design', 'scenes', 'app'), { recursive: true })
  writeFileSync(join(root, 'design', 'scenes', 'app', 'plain.tsx'), `export const meta = { title: 'Plain' }
export default () => <main style={{ margin: 0, padding: 24, font: '16px system-ui' }}><h1 style={{ margin: 0 }}>Plain</h1><p>Pay now with card</p></main>
`)
  mkdirSync(join(root, 'design', 'boards'), { recursive: true })
  writeFileSync(join(root, 'design', 'boards', 'main.json'), JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
    { key: 'p1', frame: 'app/plain', x: 0, y: 0, w: 800, h: 500 },
  ] }))
  writeFileSync(join(root, 'design', 'publish.json'), JSON.stringify({ version: 2, boards: { main: { max: 'comment', open: 'present', lock: true } } }))
  // two threads the owner left: the reviewer answers them
  mkdirSync(join(root, 'design', 'comments'), { recursive: true })
  const seed = (n: number) => JSON.stringify({ id: `seed-0000${n}`, ts: Date.now() - 3_600_000 + n, type: 'create', commentId: `thread-000${n}`, board: 'main',
    nodeKey: 'p1', frame: 'app/plain', anchor: { el: { semantics: { quote: 'Pay now with card' } } },
    author: { email: 'owner@studio.test', name: 'Owner' }, body: `Question ${n}` })
  writeFileSync(join(root, 'design', 'comments', 'main.jsonl'), [seed(1), seed(2), seed(3)].join('\n') + '\n')
  execFileSync(process.execPath, [CLI, 'build', '--root', root], { stdio: 'pipe', encoding: 'utf8' })
  // the accounts a Marver ID canvas holds: the owner, and the client reviewer invited to comment
  writeAuth({ users: [
    { email: 'owner@studio.test', name: 'Owner', role: 'owner', auth: 'marver-id', createdAt: Date.now() },
    { email: REVIEWER, name: 'Ana', role: 'member', auth: 'marver-id', createdAt: Date.now() },
  ], invites: [], sessions: [] })
  await start()
  browser = await Browser.launch()
  tab = await browser!.tab()
  await browser!.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, tab)
  await browser!.send('Network.enable', {}, tab)
  await browser!.send('Page.enable', {}, tab)
  // the leave-page question: counted, and answered "leave" as a person might
  browser!.on((m) => {
    if (m.method !== 'Page.javascriptDialogOpening' || m.sessionId !== tab) return
    asked.push(m.params.type)
    void browser!.send('Page.handleJavaScriptDialog', { accept: true }, tab)
  })
  // the reviewer's clock runs five minutes fast
  await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const n = Date.now; Date.now = () => n() + 300000 })()` }, tab)
  await signIn()
}, 300_000)

afterAll(async () => {
  browser?.close()
  await stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

const skippable = (name: string, fn: () => Promise<void>, ms = 120_000) =>
  it(name, async (ctx) => { if (!browser) return ctx.skip(); await fn() }, ms)
const ev = (expr: string) => browser!.eval(tab, expr)
const until = (expr: string, ms = 20_000) => browser!.until(tab, expr, ms)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** The outbox as storage holds it: one key per waiting write. */
const OUTBOX = `Object.keys(localStorage).filter((k) => k.startsWith('mv-ob:')).map((k) => JSON.parse(localStorage.getItem(k)))`

/** Open a thread on the published canvas, its reply box ready. */
async function openThread(n: number) {
  await browser!.go(tab, 'about:blank')   // a real load: a hash change alone keeps the page
  await browser!.go(tab, `${ORIGIN}/#/b/main?c=thread-000${n}`)
  await until(`!!document.querySelector('.cm-card[data-thread="thread-000${n}"] .cm-compose textarea')`, 45_000)
}
/** Type into the open card's reply box, then Enter - as a person does. */
async function reply(words: string, send = true) {
  await ev(`document.querySelector('.cm-card .cm-compose textarea').focus()`)
  await browser!.send('Input.insertText', { text: words }, tab)
  if (!send) return
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, tab)
  await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, tab)
}

describe('spec 36 on a locked stage (every board locked to present)', () => {
  skippable('the session ends: the stage says so, and Sign in again goes through Marver ID', async () => {
    await browser!.go(tab, 'about:blank')
    await browser!.go(tab, `${ORIGIN}/#/b/main`)
    await until(`!!document.querySelector('.sh-play')`, 45_000)
    expect(await ev(`!!document.querySelector('.sh-panel')`)).toBe(false)   // the canvas shell is not here
    endSessions()
    await ev(`window.dispatchEvent(new Event('focus'))`)
    await until(`!!document.querySelector('.sh-signedout[data-signed-out]')`)
    const went: string[] = []
    const off = browser!.on((m) => { if (m.method === 'Network.requestWillBeSent' && m.sessionId === tab) went.push(m.params.request.url) })
    await ev(`document.querySelector('.sh-signedout .sh-banner-act').click()`)
    await wait(1500)
    off()
    expect(went.some((u) => u.startsWith(`${ORIGIN}/__mv/id/start`))).toBe(true)
    await signIn()
  })

  skippable('a refused comment waiting from an earlier visit: said on the stage with its reason, Retry and Discard', async () => {
    await browser!.go(tab, 'about:blank')
    await browser!.go(tab, `${ORIGIN}/#/b/main`)
    await until(`!!document.querySelector('.sh-play')`, 45_000)
    // a comment kept from before, too long for the server: refused for good when it is sent
    await ev(`localStorage.setItem('mv-ob:locked-00000001', JSON.stringify({ key: 'locked-00000001', board: 'main', account: '${REVIEWER}', at: 1,
      events: [{ id: 'locked-ev-0001', ts: Date.now() - 900000, type: 'reply', commentId: 'locked-reply-1', parentId: 'thread-0001', board: 'main', author: { email: '${REVIEWER}', name: 'Ana' }, body: '${'x'.repeat(10_050)}' }] }))`)
    await browser!.go(tab, 'about:blank')
    await browser!.go(tab, `${ORIGIN}/#/b/main`)
    await until(`document.querySelector('.sh-signedout')?.dataset.refused === '1'`, 45_000)
    expect(await ev(`document.querySelector('.sh-signedout').textContent`)).toMatch(/could not be sent - body too long/)
    const acts = await ev(`[...document.querySelectorAll('.sh-signedout .sh-banner-act')].map((b) => b.textContent)`)
    expect(acts).toEqual(['Retry', 'Discard'])
    await ev(`[...document.querySelectorAll('.sh-signedout .sh-banner-act')].find((b) => b.textContent === 'Discard').click()`)
    await until(`${OUTBOX}.length === 0 && !document.querySelector('.sh-signedout')`)
  })
})
