import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncOnce } from '../src/server/sync.ts'

/**
 * Spec 36 on the server, over HTTP against a real `marver serve` (password mode with a data dir, port 4815): the API
 * is told it is signed out and never handed the sign-in page; a redeploy signs no guest out; a guest cookie near its
 * end is renewed; a store the gate cannot read answers 500 and the canvas stays up; `comments sync` names an ended
 * session instead of failing on the page's HTML.
 */

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const PORT = 4815
const ORIGIN = `http://localhost:${PORT}`
let root = ''
let data = ''
let server: ChildProcess | null = null
let log = ''

function start() {
  log = ''
  server = spawn(process.execPath, [CLI, 'serve', '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: {
    ...process.env, MARVER_DATA_DIR: data, MARVER_PASSWORD: 'open sesame', MARVER_ID_ISSUER: '', MARVER_CLI_TOKEN: '', MARVER_OWNER_EMAIL: '',
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
/** Through the password gate: the guest cookie it sets. */
async function enter(): Promise<string> {
  const r = await fetch(`${ORIGIN}/__mv/auth`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=open+sesame' })
  expect(r.status).toBe(303)
  return /^(mv_a=[^;]+)/.exec(r.headers.getSetCookie().find((c) => c.startsWith('mv_a=')) ?? '')![1]
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-survive-srv-'))
  data = join(root, 'data')
  mkdirSync(data)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'survive-srv', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..'), repoNm = join(repoRoot, 'node_modules'), nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver') symlinkSync(join(repoNm, e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  mkdirSync(join(root, 'design', 'scenes', 'app'), { recursive: true })
  writeFileSync(join(root, 'design', 'scenes', 'app', 'plain.tsx'), `export default () => <main>Plain</main>\n`)
  mkdirSync(join(root, 'design', 'boards'), { recursive: true })
  writeFileSync(join(root, 'design', 'boards', 'main.json'), JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [{ key: 'p1', frame: 'app/plain', x: 0, y: 0, w: 800, h: 500 }] }))
  writeFileSync(join(root, 'design', 'publish.json'), JSON.stringify({ version: 2, boards: { main: 'comment' } }))
  execFileSync(process.execPath, [CLI, 'build', '--root', root], { stdio: 'pipe', encoding: 'utf8' })
  await start()
}, 300_000)

afterAll(async () => {
  await stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('spec 36 on the server: told, kept, renewed', () => {
  it('a call with no session is told so in JSON - a write, a read, /me - and a person navigating still gets the gate page', async () => {
    const post = await fetch(`${ORIGIN}/__mv/api/comments/main`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"events":[]}' })
    expect(post.status).toBe(401)
    expect(post.headers.get('content-type')).toMatch(/json/)
    expect(await post.json()).toEqual({ error: 'signed out', signIn: 'password' })
    expect(log).toMatch(/POST \/__mv\/api\/comments\/main refused: signed out/)
    for (const p of ['comments/main', 'me', 'events']) {
      const r = await fetch(`${ORIGIN}/__mv/api/${p}`)
      expect([p, r.status, r.headers.get('content-type')]).toEqual([p, 401, 'application/json'])
    }
    const page = await fetch(`${ORIGIN}/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toMatch(/canvas password/)
  })

  it('a redeploy signs no guest out: the cookie is signed with a key kept on the volume', async () => {
    const guest = await enter()
    expect((await fetch(`${ORIGIN}/__mv/api/boards`, { headers: { cookie: guest } })).status).toBe(200)
    await stop()
    await start()
    const r = await fetch(`${ORIGIN}/__mv/api/boards`, { headers: { cookie: guest } })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/json/)
  })

  it('a guest cookie used past half its life is renewed; a fresh one is left alone', async () => {
    const fresh = await enter()
    expect((await fetch(`${ORIGIN}/`, { headers: { cookie: fresh } })).headers.getSetCookie()).toEqual([])
    // a cookie with 5 days left, signed with the key the server keeps on the volume (the canvas secret's derivation)
    const secret = Buffer.from(readFileSync(join(data, 'canvas.secret'), 'utf8').trim(), 'hex')
    const key = createHmac('sha256', secret).update('mv_a gate cookie v1').digest()
    const old = Math.floor(Date.now() / 1000) + 5 * 86_400
    const aging = `mv_a=${old}.${createHmac('sha256', key).update(`v1.${old}`).digest('hex')}`
    const r = await fetch(`${ORIGIN}/`, { headers: { cookie: aging } })
    expect(await r.text()).not.toMatch(/canvas password/)   // genuine: let in
    const renewed = r.headers.getSetCookie().find((c) => c.startsWith('mv_a='))!
    expect(renewed).toMatch(/Max-Age=2592000/)
    expect(Number(/^mv_a=(\d+)\./.exec(renewed)![1]) * 1000 - Date.now()).toBeGreaterThan(29 * 86_400_000)
  })

  it('a store the gate cannot read answers 500 JSON, and the canvas stays up', async () => {
    writeFileSync(join(data, 'auth.json'), '{ not json')
    const r = await fetch(`${ORIGIN}/__mv/api/boards`, { headers: { cookie: 'mv_s=abcdefgh' } })
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ error: 'internal' })
    expect(server?.exitCode).toBe(null)
    writeFileSync(join(data, 'auth.json'), JSON.stringify({ users: [], invites: [], sessions: [] }))
    expect((await fetch(`${ORIGIN}/`)).status).toBe(200)
  })

  it('comments sync with an ended session says so, and how to mend it', async () => {
    await expect(syncOnce(root, { url: ORIGIN, token: 'no-such-session-token-00' } as any)).rejects.toThrow(/session ended - run `marver comments connect <url>` again/)
  })
})
