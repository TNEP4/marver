import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { findChrome } from '../src/server/cdp.ts'

/**
 * Spec 36 where a reviewer meets it: a real `marver build` + `marver serve` behind Marver ID (port 4813), headless
 * Chrome, the page's clock five minutes FAST (the server refuses events from the future - the shell stamps on the
 * server's time). The reviewer's session ends while they read; they are told at once, the reply they write is kept
 * and shown as not sent yet, Sign in again goes through Marver ID's pages, and back on the canvas the reply sends
 * itself - stored once. A server that is down keeps what is written until it is back; a reload keeps a draft; a
 * refused write keeps its words. Skips without Chrome.
 */

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const PORT = 4813
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
    MARVER_ID_ISSUER: 'http://localhost:4814', MARVER_PUBLIC_ORIGIN: ORIGIN,
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
  root = mkdtempSync(join(tmpdir(), 'mv-survive-'))
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
  writeFileSync(join(root, 'design', 'publish.json'), JSON.stringify({ version: 2, boards: { main: 'comment' } }))
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

describe('a comment is never lost (spec 36), on a published Marver ID canvas', () => {
  skippable('signed in, with a clock five minutes fast: a reply is stored and reads as sent', async () => {
    await openThread(1)
    await reply('First answer')
    await until(`[...document.querySelectorAll('.cm-msg')].some((m) => m.textContent.includes('First answer'))`)
    await until(`!document.querySelector('.cm-unsent') && ${OUTBOX}.length === 0`)
    expect(replies('First answer')).toHaveLength(1)
    expect(replies('First answer')[0].author.email).toBe(REVIEWER)
  })

  skippable('the session ends mid-visit: said at once; the reply written after is kept, shown not sent, and sent once after signing in again', async () => {
    await openThread(2)
    endSessions()
    // the next read of the comments (here: the window's focus; else the 30 s poll) hears the 401
    await ev(`window.dispatchEvent(new Event('focus'))`)
    await until(`!!document.querySelector('.sh-signedout')`)
    // the API never gets the sign-in page: a 401 that says how to come back
    const r = await ev(`fetch('/__mv/api/me').then(async (r) => [r.status, r.headers.get('content-type'), await r.text()])`)
    expect(r[0]).toBe(401)
    expect(r[1]).toMatch(/json/)
    expect(JSON.parse(r[2])).toMatchObject({ error: 'signed out', signIn: 'marver-id' })

    await reply('Written after the session ended')
    await until(`document.querySelector('.cm-unsent')?.dataset.unsent === 'signed-out'`)
    expect(await ev(`[...document.querySelectorAll('.cm-msg')].some((m) => m.textContent.includes('Written after the session ended'))`)).toBe(true)
    await until(`document.querySelector('.cm-card .cm-compose textarea').value === ''`)   // taken - not to be typed twice
    expect(await ev(`${OUTBOX}.length`)).toBe(1)
    expect(await ev(`document.querySelector('.sh-signedout').dataset.signedOut`)).toBe('1')
    expect(replies('Written after the session ended')).toHaveLength(0)
    expect(log).toMatch(/POST \/__mv\/api\/comments\/main refused: signed out/)

    // Sign in again: through Marver ID's own pages, the board in `next`
    const went: string[] = []
    const off = browser!.on((m) => { if (m.method === 'Network.requestWillBeSent' && m.sessionId === tab) went.push(m.params.request.url) })
    await ev(`document.querySelector('.sh-signedout .sh-banner-act').click()`)
    await wait(1500)
    off()
    expect(went.some((u) => u.startsWith(`${ORIGIN}/__mv/id/start?next=${encodeURIComponent('#/b/main')}`))).toBe(true)   // the board the reviewer is on

    // ...and back on the canvas, signed in: the reply sends itself, once
    await signIn()
    await openThread(2)
    await until(`${OUTBOX}.length === 0 && !document.querySelector('.cm-unsent') && !document.querySelector('.sh-signedout')`)
    expect(replies('Written after the session ended')).toHaveLength(1)
    await wait(1500)
    expect(replies('Written after the session ended')).toHaveLength(1)
  })

  skippable('the server is down: what is written waits, shown sending, and is stored when it is back - the session survives the restart', async () => {
    await openThread(3)
    await stop()
    await reply('Written while the canvas was down')
    await until(`document.querySelector('.cm-unsent')?.dataset.unsent === 'sending'`)
    expect(await ev(`${OUTBOX}.length`)).toBe(1)
    // a reload while it waits: the words are on disk, and the page asks before leaving
    await start()
    await until(`${OUTBOX}.length === 0`, 30_000)
    expect(replies('Written while the canvas was down')).toHaveLength(1)
    expect(await ev(`!!document.querySelector('.sh-signedout')`)).toBe(false)
  })

  skippable('a reply typed and not sent survives a reload, and comes back in its thread', async () => {
    await openThread(1)
    await reply('Half a thought', false)
    asked.length = 0
    await openThread(1)
    expect(asked).toEqual(['beforeunload'])   // asked before the words could go
    expect(await ev(`document.querySelector('.cm-card .cm-compose textarea').value`)).toBe('Half a thought')
    // sent, it leaves the drafts
    await reply('', true)
    await until(`${OUTBOX}.length === 0 && [...document.querySelectorAll('.cm-msg')].some((m) => m.textContent.includes('Half a thought'))`)
    expect(await ev(`localStorage.getItem('mv-draft:r:thread-0001')`)).toBe(null)
  })

  skippable('a write the server refuses for good keeps its words - under its message, with the reason, Retry and Discard, and said in the bar', async () => {
    await openThread(1)
    // over the server's body limit: a 400 that will not change on retry
    await reply('x'.repeat(10_050))
    await until(`document.querySelector('.cm-unsent')?.dataset.unsent === 'refused'`)
    expect(await ev(`document.querySelector('.cm-unsent').textContent`)).toMatch(/Not sent - body too long/)
    expect(await ev(`document.querySelector('.sh-signedout')?.dataset.refused`)).toBe('1')
    expect(await ev(`${OUTBOX}.length`)).toBe(1)
    // kept across a reload, Show in the bar opens its thread
    await browser!.go(tab, 'about:blank')
    await browser!.go(tab, `${ORIGIN}/#/b/main`)
    await until(`document.querySelector('.sh-signedout')?.dataset.refused === '1'`, 45_000)
    await ev(`document.querySelector('.sh-signedout .sh-banner-act').click()`)
    await until(`!!document.querySelector('.cm-card[data-thread="thread-0001"] .cm-unsent.refused')`)
    // only the person lets it go
    await ev(`[...document.querySelectorAll('.cm-unsent-acts button')].find((b) => b.textContent === 'Discard').click()`)
    await until(`${OUTBOX}.length === 0 && !document.querySelector('.cm-unsent') && !document.querySelector('.sh-signedout')`)
  })

  skippable('a resend of a stored write is stored (accepted 0), the same id with other words is refused, and a write made as another account waits', async () => {
    await openThread(1)
    const post = (body: object) => ev(`fetch('/__mv/api/comments/main', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': document.cookie.match(/mv_c=([\\w-]+)/)[1] }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async (r) => [r.status, await r.json()])`)
    const e = { id: 'resend-00001', ts: Date.now(), type: 'reply', commentId: 'resend-reply-1', parentId: 'thread-0001', board: 'main', author: { email: REVIEWER, name: 'Ana' }, body: 'once' }
    expect(await post({ events: [e], as: REVIEWER })).toEqual([200, { accepted: 1 }])
    expect(await post({ events: [e], as: REVIEWER })).toEqual([200, { accepted: 0 }])
    expect((await post({ events: [{ ...e, body: 'other words' }], as: REVIEWER }))[0]).toBe(400)
    expect(await post({ events: [{ ...e, id: 'resend-00002', commentId: 'resend-reply-2' }], as: 'bob@client.test' })).toEqual([409, { error: 'written as bob@client.test - signed in as someone else now', code: 'account' }])
    expect(replies('once')).toHaveLength(1)
  })

  skippable('a session used near its end gets its full life back, cookie and store', async () => {
    const tok = await signIn()
    const a = auth()
    a.sessions.find((s: { tokenHash: string }) => s.tokenHash === sha(tok)).exp = Date.now() + 86_400_000
    writeAuth(a)
    const res = await fetch(`${ORIGIN}/__mv/api/me`, { headers: { cookie: `mv_s=${tok}; mv_c=abc` } })
    expect(res.status).toBe(200)
    const cookies = res.headers.getSetCookie()
    expect(cookies.some((c) => c.startsWith(`mv_s=${tok};`) && /Max-Age=2592000/.test(c))).toBe(true)
    expect(cookies.some((c) => c.startsWith('mv_c=abc;'))).toBe(true)
    expect(auth().sessions.find((s: { tokenHash: string }) => s.tokenHash === sha(tok)).exp).toBeGreaterThan(Date.now() + 29 * 86_400_000)
  })
})
