/**
 * The fake canvas (test/harness/fake-canvas.ts; spec 28 A2.14 #27) is a Marver canvas as far as the app can tell:
 * its slot file in A1's shape, and a document proof the app's check - A1's own formula - accepts, or refuses.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { docProof } from '../../../src/server/proof.ts'
import { startFakeCanvas, type FakeCanvas } from '../harness/fake-canvas.ts'
import { runSlotBase, testEnv, type TestEnv } from '../harness/env.ts'

const slotBase = runSlotBase()
let env: TestEnv
const open: FakeCanvas[] = []
beforeAll(() => { env = testEnv(slotBase) })
afterEach(async () => { for (const f of open.splice(0)) await f.close() })
afterAll(() => env.cleanup())

const nonce = () => randomBytes(24).toString('base64url')
async function start(o: Partial<Parameters<typeof startFakeCanvas>[0]> = {}) {
  const f = await startFakeCanvas({ home: env.home, slotBase, ...o })
  open.push(f)
  await f.ready
  return f
}

describe('the slot file', () => {
  it('is A1\'s record, ready with its bound origin, mode 600 in a 700 folder', async () => {
    const f = await start({ slot: 3, name: 'TMS broker' })
    const rec = JSON.parse(readFileSync(f.slotFile, 'utf8'))
    expect(f.slotFile).toBe(join(env.home, 'running', 'slot-3.json'))
    expect(statSync(f.slotFile).mode & 0o777).toBe(0o600)
    expect(statSync(join(env.home, 'running')).mode & 0o777).toBe(0o700)
    expect(rec).toMatchObject({ v: 1, state: 'ready', pid: process.pid, slot: 3, port: slotBase + 3, origin: `http://[::1]:${slotBase + 3}`,
      url: `http://localhost:${slotBase + 3}/`, name: 'TMS broker', features: ['bridge'], instance: f.instance })
    expect(rec.ws).toMatch(/^[0-9a-f]{16}$/)
    expect(Buffer.from(rec.key, 'base64url')).toHaveLength(32)
  })

  it('says starting until it is ready', async () => {
    const f = await startFakeCanvas({ home: env.home, slotBase, slot: 4, startingMs: 300 })
    open.push(f)
    expect(JSON.parse(readFileSync(f.slotFile, 'utf8'))).toMatchObject({ state: 'starting', origin: null })
    await f.ready
    expect(JSON.parse(readFileSync(f.slotFile, 'utf8'))).toMatchObject({ state: 'ready', origin: f.origin })
  })

  it('is removed on close', async () => {
    const f = await start({ slot: 5 })
    await f.close()
    expect(existsSync(f.slotFile)).toBe(false)
  })
})

describe('the document proof', () => {
  it('valid: the app\'s check (A1\'s docProof over the slot file\'s key) passes', async () => {
    const f = await start({ slot: 6 })
    const n = nonce()
    const res = await fetch(`${f.origin}/`, { headers: { 'x-mv-nonce': n } })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-mv-instance')).toBe(f.instance)
    const key = Buffer.from(JSON.parse(readFileSync(f.slotFile, 'utf8')).key, 'base64url')
    expect(res.headers.get('x-mv-proof')).toBe(docProof(key, n, f.port))
    expect(await res.text()).toContain('<title>Fake canvas</title>')
  })

  it('invalid: signed with another key, so the check fails', async () => {
    const f = await start({ slot: 7, proof: 'invalid' })
    const n = nonce()
    const res = await fetch(`${f.origin}/index.html`, { headers: { 'x-mv-nonce': n } })
    expect(res.headers.get('x-mv-proof')).toBeTruthy()
    expect(res.headers.get('x-mv-proof')).not.toBe(docProof(f.key, n, f.port))
  })

  it('none, or no nonce: no proof headers at all', async () => {
    const f = await start({ slot: 8, proof: 'none' })
    expect((await fetch(`${f.origin}/`, { headers: { 'x-mv-nonce': nonce() } })).headers.get('x-mv-proof')).toBeNull()
    const g = await start({ slot: 9 })
    expect((await fetch(`${g.origin}/`)).headers.get('x-mv-proof')).toBeNull()
  })

  it('binds IPv4 when asked', async () => {
    const f = await start({ slot: 10, bind: '127.0.0.1' })
    expect(f.origin).toBe(`http://127.0.0.1:${slotBase + 10}`)
    const n = nonce()
    expect((await fetch(`${f.origin}/`, { headers: { 'x-mv-nonce': n } })).headers.get('x-mv-proof')).toBe(docProof(f.key, n, f.port))
  })
})

describe('A1\'s guard, as the canvas answers it', () => {
  it('refuses a service worker script, answers hello, says another workspace, logs every request', async () => {
    const f = await start({ slot: 11 })
    expect((await fetch(`${f.origin}/sw.js`, { headers: { 'service-worker': 'script' } })).status).toBe(403)
    expect(await (await fetch(`${f.origin}/__mv/api/hello`)).json()).toEqual({ ok: true, ws: f.ws })
    const other = await fetch(`${f.origin}/`, { headers: { 'x-mv-ws': '0123456789abcdef' } })
    expect(other.status).toBe(409)
    expect(other.headers.get('x-mv-elsewhere')).toBe('1')
    expect(f.requests.map((r) => r.path)).toEqual(['/sw.js', '/__mv/api/hello', '/'])
  })
})

describe('as a child process', () => {
  it('prints its ready line, and kill -9 leaves the stale slot file', async () => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '..', 'harness', 'fake-canvas.ts'),
      JSON.stringify({ home: env.home, slotBase, slot: 12 })], { stdio: ['ignore', 'pipe', 'pipe'] })
    const line = await new Promise<string>((ok, fail) => {
      createInterface({ input: child.stdout! }).once('line', ok)
      child.once('exit', (c) => fail(new Error(`exited ${c}`)))
    })
    const { ready } = JSON.parse(line) as { ready: { pid: number; port: number; slotFile: string } }
    expect(ready.pid).toBe(child.pid)
    expect((await fetch(`http://[::1]:${ready.port}/__mv/api/hello`)).status).toBe(200)
    child.kill('SIGKILL')
    await new Promise((r) => child.once('exit', r))
    expect(existsSync(ready.slotFile)).toBe(true)
    expect(JSON.parse(readFileSync(ready.slotFile, 'utf8')).pid).toBe(ready.pid)
    await expect(fetch(`http://[::1]:${ready.port}/`)).rejects.toThrow()
  })
})

describe('A3\'s options (spec 28 A3.8 #34, #45, #49, #50)', () => {
  const page = async (f: FakeCanvas, q = '') => (await fetch(`${f.url}${q}`)).text()

  it('ground mode: the ground under the tabs, a document tag unique to each load (or the URL\'s), the size tag at innerWidth - 260, the content at half luminance; it offers the inset', async () => {
    const f = await start({ slot: 3, ground: true })
    expect(f.record().features).toEqual(['bridge', 'inset'])
    const a = await page(f)
    const b = await page(f)
    const c = await page(f, '?mvtag=12AB34')
    expect(f.tags.map((t) => t.tag)).toEqual(['ff0080', '00c0ff', '12ab34'])
    expect(a).toContain('id="mv-band" style="position:fixed;left:0;top:0;right:0;height:44px;background:#e7e9ef"')
    expect(a).toContain('id="mv-doc-tag"')
    expect(a).toContain('background:#ff0080')
    expect(b).toContain('background:#00c0ff')
    expect(c).toContain('background:#12ab34')
    expect(a).toContain('left:calc(100% - 260px);width:12px;height:20px;background:#202020')
    expect(a).toContain('background:#800040')   // ff0080 at half luminance
    expect(a).toContain('A.onPresent(function (r)')
  })

  it('ground mode: every document load a tag of its own - a reload of a ?mvtag= URL included - and the app\'s proof probes are not loads (review of a3-native, major #6)', async () => {
    const f = await start({ slot: 6, ground: true })
    const get = (q: string, headers: Record<string, string> = {}) => fetch(`${f.url}${q}`, { headers }).then((r) => r.text())
    await get('?mvtag=ff0080')
    // the same URL again (a reload): the next of DOC_TAGS, never the tag the document before it showed
    await get('?mvtag=ff0080')
    // main's proof probe: a GET of / with a nonce and no fetch metadata - answered, never counted, never a new tag
    await get('', { 'x-mv-nonce': 'abc' })
    // a navigation carries the nonce too (proof.ts), and says it is a document
    await get('?mvtag=00c0ff', { 'x-mv-nonce': 'def', 'sec-fetch-dest': 'document' })
    // a fetch() of / from a page (sec-fetch-dest empty) is no load either
    await get('', { 'sec-fetch-dest': 'empty' })
    expect(f.tags.map((t) => t.tag)).toEqual(['ff0080', '00c0ff', 'ffb000'])
  })

  it('the ballasts and the sentinel are in the page only when asked', async () => {
    const plain = await page(await start({ slot: 4 }))
    expect(plain).not.toMatch(/__mvBallast|__mvGpu|cpu-ballast|mv-doc-tag/)
    const f = await page(await start({ slot: 5, ballastMB: 400, gpuBallast: 32, cpuBallast: true, sentinel: '00c853' }))
    expect(f).toContain('new Uint8Array(400 * 1048576)')
    expect(f).toContain('for (var g = 0; g < 32; g++)')
    expect(f).toContain("say('cpu-ballast')")
    expect(f).toContain('background:#00c853')
  })
})
