/**
 * The fake canvas (test/harness/fake-canvas.ts; spec 28 A2.14 #27) is a Marver canvas as far as the app can tell:
 * its slot file in A1's shape, and a document proof the app's check - A1's own formula - accepts, or refuses. From
 * A4, its live stream (A4.6 #5, #6, #11, #14): proved both ways, whole snapshots, driven by setLive, dropLive and
 * acceptLive.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { appProof, docProof } from '../../../src/server/proof.ts'
import { LIVE_WIRE, type LiveEvent, type LiveItem } from '../../../src/shared/app-api.ts'
import { checkProof, oneHeaders } from '../../src/main/proof.ts'
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

describe('A4\'s live stream (spec 28 A4.6 #5, #6, #11, #14, #56)', () => {
  const ask = (n: number): LiveItem => ({ id: `ask:${n.toString(16).padStart(20, '0')}`, kind: 'ask', board: 'home', title: `Which one, ${n}?`, at: n, thread: `t${n}`, msg: `m${n}` })
  /** a live request as main makes it (A4.6 #16): its proof headers checked as main checks them */
  async function connect(f: FakeCanvas, o: { app?: string | null; nonce?: string | null; ws?: string; method?: string } = {}) {
    const n = o.nonce === undefined ? nonce() : o.nonce
    const headers: Record<string, string> = { accept: LIVE_WIRE.type, 'x-mv-ws': o.ws ?? f.ws }
    if (n !== null) headers['x-mv-nonce'] = n
    const app = o.app === undefined ? appProof(f.key, f.port) : o.app
    if (app !== null) headers['x-mv-app'] = app
    const ac = new AbortController()
    const res = await fetch(`${f.origin}${LIVE_WIRE.path}`, { method: o.method ?? 'GET', headers, signal: ac.signal, redirect: 'error' })
    const h = oneHeaders(Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k, [v]])))
    const proved = n !== null ? checkProof({ headers: h, nonce: n, key: f.key, port: f.port, instance: f.instance, kind: 'live' }) : 'proof'
    const reader = res.status === 200 ? res.body!.getReader() : null
    let buf = ''
    /** the next whole block (an event or a comment), or null once the stream ended */
    const next = async (): Promise<string | null> => {
      for (;;) {
        const i = buf.indexOf('\n\n')
        if (i >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); return block }
        const r = await reader!.read().catch(() => ({ done: true as const, value: undefined }))
        if (r.done) return null
        buf += new TextDecoder().decode(r.value)
      }
    }
    const event = async (): Promise<LiveEvent | null> => {
      const block = await next()
      if (block === null) return null
      const lines = block.split('\n')
      expect(lines[0]).toBe(`event: ${LIVE_WIRE.event}`)
      expect(lines).toHaveLength(2)
      expect(lines[1].startsWith('data: ')).toBe(true)
      return JSON.parse(lines[1].slice(6)) as LiveEvent
    }
    return { res, proved, event, close: () => ac.abort() }
  }

  it('without the option the route is a 404, as before 0.29; it does not list `live` by itself', async () => {
    const f = await start({ slot: 13 })
    expect((await connect(f)).res.status).toBe(404)
    const g = await start({ slot: 14, live: true })
    expect(g.record().features).toEqual(['bridge'])
  })

  it('the request is proved first: no or a wrong x-mv-app 403, no nonce 400, another method 405, another workspace 409 - nothing streamed', async () => {
    const f = await start({ slot: 15, live: true })
    expect((await connect(f, { app: null })).res.status).toBe(403)
    expect((await connect(f, { app: appProof(f.key, f.port + 1) })).res.status).toBe(403)
    expect((await connect(f, { app: appProof(randomBytes(32), f.port) })).res.status).toBe(403)
    expect((await connect(f, { nonce: null })).res.status).toBe(400)
    expect((await connect(f, { nonce: 'short' })).res.status).toBe(400)
    expect((await connect(f, { method: 'POST' })).res.status).toBe(405)
    const other = await connect(f, { ws: '0123456789abcdef' })
    expect([other.res.status, other.res.headers.get('x-mv-elsewhere')]).toEqual([409, '1'])
    expect(f.liveClients()).toBe(0)
  })

  it('the answer: an event stream signed with liveProof, which main\'s check kind live accepts; a whole snapshot at once', async () => {
    const f = await start({ slot: 16, live: { items: [ask(2), ask(1)], unseen: 3, session: true } })
    const c = await connect(f)
    expect(c.res.status).toBe(200)
    expect(c.res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(c.res.headers.get('cache-control')).toBe('no-store')
    expect(c.res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(c.proved).toBe('ok')
    expect(await c.event()).toEqual({ v: 1, instance: f.instance, seq: 1, jam: 'on', items: [ask(2), ask(1)], cut: 0,
      counts: { ask: 2, review: 0, failed: 0, stalled: 0 }, unseen: 3, working: false, session: true })
    c.close()
  })

  it('a wrong key\'s answer fails main\'s check (proof invalid), and none carries no proof (proof none)', async () => {
    const f = await start({ slot: 17, live: true, proof: 'invalid' })
    const c = await connect(f)
    expect([c.res.status, c.proved]).toEqual([200, 'proof'])
    c.close()
    const g = await start({ slot: 18, live: true, proof: 'none' })
    const d = await connect(g)
    expect([d.res.headers.get('x-mv-proof'), d.proved]).toEqual([null, 'proof'])
    d.close()
  })

  it('setLive: a changed snapshot to every client with seq one higher; the same again writes nothing; a new client gets it at once', async () => {
    const f = await start({ slot: 19, live: true })
    const a = await connect(f), b = await connect(f)
    expect((await a.event())!.seq).toBe(1)
    expect((await b.event())!.seq).toBe(1)
    f.setLive({ items: [ask(1)], working: true })
    f.setLive({ items: [ask(1)], working: true })
    f.setLive({ items: [], counts: { ask: 0, review: 1, failed: 0, stalled: 0 }, jam: 'off' })
    for (const c of [a, b]) {
      expect(await c.event()).toMatchObject({ seq: 2, items: [ask(1)], counts: { ask: 1 }, working: true })
      expect(await c.event()).toMatchObject({ seq: 3, items: [], counts: { review: 1 }, jam: 'off' })
    }
    const late = await connect(f)
    expect(await late.event()).toMatchObject({ seq: 3, jam: 'off' })
    for (const c of [a, b, late]) c.close()
  })

  it('dropLive ends every response; a reconnect gets the same snapshot and seq. acceptLive answers the next requests', async () => {
    const f = await start({ slot: 20, live: { items: [ask(7)] } })
    const a = await connect(f)
    expect((await a.event())!.seq).toBe(1)
    await expect.poll(() => f.liveClients()).toBe(1)
    f.dropLive()
    expect(await a.event()).toBe(null)
    const b = await connect(f)
    expect(await b.event()).toMatchObject({ seq: 1, items: [ask(7)] })
    b.close()
    for (const how of [404, 403, 405, 409] as const) {
      f.acceptLive(how)
      expect((await connect(f)).res.status).toBe(how)
    }
    f.acceptLive('ok')
    const c = await connect(f)
    expect(c.res.status).toBe(200)
    c.close()
  })

  it('at most four clients: a fifth that passes the proof ends the oldest', async () => {
    const f = await start({ slot: 1, live: true })
    const cs = []
    for (let i = 0; i < 5; i++) { const c = await connect(f); await c.event(); cs.push(c) }
    expect(await cs[0].event()).toBe(null)
    await expect.poll(() => f.liveClients()).toBe(LIVE_WIRE.clients)
    for (const c of cs) c.close()
  })

  it('as a child: driven by JSON lines on stdin', async () => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '..', 'harness', 'fake-canvas.ts'),
      JSON.stringify({ home: env.home, slotBase, slot: 2, live: true })], { stdio: ['pipe', 'pipe', 'pipe'] })
    const line = await new Promise<string>((ok, fail) => {
      createInterface({ input: child.stdout! }).once('line', ok)
      child.once('exit', (c) => fail(new Error(`exited ${c}`)))
    })
    const { ready } = JSON.parse(line) as { ready: { port: number; origin: string; instance: string; ws: string; slotFile: string } }
    const key = Buffer.from(JSON.parse(readFileSync(ready.slotFile, 'utf8')).key, 'base64url')
    const f = { ...ready, key } as unknown as FakeCanvas
    const c = await connect(f)
    expect([c.res.status, c.proved]).toEqual([200, 'ok'])
    expect((await c.event())!.seq).toBe(1)
    child.stdin!.write(`${JSON.stringify({ setLive: { items: [ask(3)] } })}\n`)
    expect(await c.event()).toMatchObject({ seq: 2, items: [ask(3)] })
    child.stdin!.write(`${JSON.stringify({ acceptLive: 404 })}\n${JSON.stringify({ dropLive: true })}\n`)
    expect(await c.event()).toBe(null)
    expect((await connect(f)).res.status).toBe(404)
    child.kill('SIGTERM')
    await new Promise((r) => child.once('exit', r))
  })
})
