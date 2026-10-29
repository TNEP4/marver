/**
 * Main's live streams against the fake canvas (spec 28 A4.6 #6, #16, #17, #52's app fake cases): live.ts with the real
 * registry reading the fake's slot files, and notify.ts over the tab model, no Electron. A signed stream applied and
 * an unsigned one not; port reuse - a canvas killed with its slot file left, its port taken by a plain server that
 * answers a stream with no proof - gives no marks and no posts; a restart in the same slot under a new instance is
 * streamed only once the registry shows it; a canvas answering 404 is asked once until its instance changes; and a
 * question raising one notice, a reconnect posting nothing old, an item born in the gap posting.
 *
 * The fake serves the live route with its own few lines until src/server/app-live.ts lands (A4.6 #56); the
 * live-stream stream then serves the real `liveRoute` here over a scripted `read()`, behind the same three names.
 */
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { LIVE_WIRE, type LiveItem } from '../../../src/shared/app-api.ts'
import { createLive, type Live } from '../../src/main/live.ts'
import { createNotify, type Notify } from '../../src/main/notify.ts'
import { createRegistry, type Registry, type RegistryEntry } from '../../src/main/registry.ts'
import { allTabs, onRegistry, setMarksSource } from '../../src/main/tabs.ts'
import { T } from '../../src/main/timings.ts'
import { startFakeCanvas, type FakeCanvas, type FakeOptions } from '../harness/fake-canvas.ts'
import { runSlotBase, testEnv, type TestEnv } from '../harness/env.ts'
import { show, world } from '../unit/window-fakes.ts'

const slotBase = runSlotBase()
let env: TestEnv
const saved = { backoff: T.liveBackoffMs, max: T.liveBackoffMaxMs, idle: T.liveIdleMs, every: T.noticeEveryMs, base: process.env.MARVER_SLOT_BASE }
beforeAll(() => { env = testEnv(slotBase); process.env.MARVER_SLOT_BASE = String(slotBase) })
afterAll(() => {
  env.cleanup()
  if (saved.base === undefined) delete process.env.MARVER_SLOT_BASE
  else process.env.MARVER_SLOT_BASE = saved.base
})
beforeEach(() => { T.liveBackoffMs = [50, 100]; T.liveBackoffMaxMs = 150; T.liveIdleMs = 5000; T.noticeEveryMs = 0 })

const fakes: FakeCanvas[] = []
const lives: Live[] = []
const regs: Registry[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const l of lives.splice(0)) l.close()
  for (const r of regs.splice(0)) r.stop()
  for (const f of fakes.splice(0)) await f.close()
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise((r) => s.close(r)) }
  T.liveBackoffMs = saved.backoff; T.liveBackoffMaxMs = saved.max; T.liveIdleMs = saved.idle; T.noticeEveryMs = saved.every
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<V>(fn: () => V, ok: (v: V) => boolean, ms = 3000): Promise<V> {
  const end = Date.now() + ms
  for (;;) { const v = fn(); if (ok(v) || Date.now() > end) return v; await wait(20) }
}
let k = 0
const ask = (title: string): LiveItem => { k += 1; return { id: `ask:${k.toString(16).padStart(20, '0')}`, kind: 'ask', board: 'main', title, at: 1000 + k, thread: `t${k}`, msg: `m${k}` } }
const liveReqs = (f: { requests: { path: string }[] }) => f.requests.filter((r) => r.path === LIVE_WIRE.path).length

async function fake(o: Partial<FakeOptions>): Promise<FakeCanvas> {
  const f = await startFakeCanvas({ home: env.home, slotBase, features: ['bridge', 'inset', 'live', 'open'], ...o })
  fakes.push(f)
  await f.ready
  return f
}
const entryOf = (f: FakeCanvas): RegistryEntry => ({ ...f.record(), file: f.slotFile, key: f.key }) as RegistryEntry

/** live.ts on the real registry of the run's home, as main.ts wires it (the tabs hear each event first). */
async function wired() {
  const reg = createRegistry({ dir: join(env.home, 'running') })
  regs.push(reg)
  const changes: string[] = []
  let n: Notify | null = null
  const live = createLive({ changed: (i, why) => { changes.push(`${why}:${i}`); n?.onLive(i, why) } })
  lives.push(live)
  await reg.start()
  reg.on((e) => { onRegistry(e); live.onRegistry(e); n?.onRegistry(e) })
  for (const e of reg.entries()) onRegistry({ kind: 'entry', entry: e })
  live.start(reg.entries())
  return { reg, live, changes, notify: (x: Notify) => { n = x } }
}

describe('the stream against the fake canvas (A4.6 #6, #16)', () => {
  beforeEach(() => { world() })

  it('a signed stream is applied; the same canvas signing with another key, or not at all, applies nothing', async () => {
    const f = await fake({ slot: 5, live: { items: [ask('Which logo?')], unseen: 2 } })
    const bad = await fake({ slot: 6, live: { items: [ask('forged')] }, proof: 'invalid' })
    const none = await fake({ slot: 7, live: { items: [ask('forged')] }, proof: 'none' })
    const { live } = await wired()
    await until(() => live.held(f.instance), (h) => !!h)
    expect(live.held(f.instance)!.event).toMatchObject({ instance: f.instance, unseen: 2, items: [{ title: 'Which logo?' }] })
    await until(() => liveReqs(bad) + liveReqs(none), (n) => n >= 4)
    expect(live.held(bad.instance)).toBeUndefined()
    expect(live.held(none.instance)).toBeUndefined()
    // what main sends: the app's proof, the workspace, a fresh nonce
    const r = f.requests.find((x) => x.path === LIVE_WIRE.path)!
    expect(r.headers).toMatchObject({ 'x-mv-ws': f.ws, accept: 'text/event-stream' })
    expect(typeof r.headers['x-mv-app']).toBe('string')
  })

  it('port reuse: a canvas killed with its slot file left and its port taken by a plain server gives no marks; the registry then drops it', async () => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '..', 'harness', 'fake-canvas.ts'),
      JSON.stringify({ home: env.home, slotBase, slot: 8, live: true, features: ['bridge', 'inset', 'live'] })], { stdio: ['pipe', 'pipe', 'pipe'] })
    const line = await new Promise<string>((ok, fail) => { createInterface({ input: child.stdout! }).once('line', ok); child.once('exit', (c) => fail(new Error(`exited ${c}`))) })
    const ready = (JSON.parse(line) as { ready: { port: number; instance: string; slotFile: string } }).ready
    const rec = JSON.parse(readFileSync(ready.slotFile, 'utf8')) as RegistryEntry & { key: string }
    const entry = { ...rec, file: ready.slotFile, key: Buffer.from(rec.key, 'base64url') } as RegistryEntry
    // the stream holds the entry as the registry listed it until its reconcile (A2.3: every 5 s, the pid looked at)
    const changes: string[] = []
    const live = createLive({ changed: (i, why) => changes.push(`${why}:${i}`) })
    lives.push(live)
    live.start([entry])
    await until(() => live.held(ready.instance), (h) => !!h)
    child.kill('SIGKILL')
    await new Promise((r) => child.once('exit', r))
    // the port taken at once by a plain server, which streams words with the old instance and no proof
    let asked = 0
    const s = createServer((req, res) => {
      if (req.url !== LIVE_WIRE.path) { res.writeHead(404); res.end(); return }
      asked += 1
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-mv-instance': ready.instance })
      res.end(`event: live\ndata: ${JSON.stringify({ v: 1, instance: ready.instance, seq: 99, jam: 'on', items: [ask('Click here')], cut: 0, counts: { ask: 1, review: 0, failed: 0, stalled: 0 }, unseen: 0, working: false, session: false })}\n\n`)
    })
    servers.push(s)
    await new Promise<void>((r) => s.listen(ready.port, '::1', r))
    // answered at least twice: the first answer was read, refused, and a reconnect followed it
    await until(() => asked, (n) => n >= 2, 4000)
    expect(asked).toBeGreaterThanOrEqual(2)
    expect(live.held(ready.instance)!.event.seq).toBe(1)
    expect(changes).toEqual([`applied:${ready.instance}`])
    // the stale file still lists live; the registry's read finds its pid dead and lists nothing; its gone drops the snapshot
    expect(readFileSync(ready.slotFile, 'utf8')).toContain(ready.instance)
    const reg = createRegistry({ dir: join(env.home, 'running') })
    regs.push(reg)
    await reg.start()
    expect(reg.entries().map((e) => e.instance)).not.toContain(ready.instance)
    live.onRegistry({ kind: 'gone', file: ready.slotFile, instance: ready.instance, why: 'pid' })
    expect(live.held(ready.instance)).toBeUndefined()
    expect(changes).toEqual([`applied:${ready.instance}`, `dropped:${ready.instance}`])
  }, 20_000)

  it('a restart in the same slot under a new instance: streamed only once the registry shows it', async () => {
    const a = await fake({ slot: 9, live: { items: [ask('Before')] } })
    const live = createLive({ changed: () => {} })
    lives.push(live)
    live.start([entryOf(a)])
    await until(() => live.held(a.instance), (h) => !!h)
    const aEntry = entryOf(a)
    fakes.splice(fakes.indexOf(a), 1)
    await a.close()
    const b = await fake({ slot: 9, live: { items: [ask('After')] } })
    // the old stream reconnects to the port: the new canvas refuses another key's proof, and nothing of it is applied
    await until(() => liveReqs(b), (n) => n >= 1)
    await wait(400)
    expect(liveReqs(b)).toBe(1)
    expect(live.held(b.instance)).toBeUndefined()
    expect(live.held(a.instance)!.event.items[0]!.title).toBe('Before')
    // the registry shows the new instance in that slot file: the old stream ends, the new one opens
    live.onRegistry({ kind: 'entry', entry: entryOf(b) })
    await until(() => live.held(b.instance), (h) => !!h)
    expect(live.held(b.instance)!.event.items[0]!.title).toBe('After')
    expect(live.held(aEntry.instance)).toBeUndefined()
  })

  it('a canvas answering 404 (a slot file listing live, a server without it) is asked once until its instance changes', async () => {
    const f = await fake({ slot: 10 })   // no live option: the route is a 404
    const live = createLive({ changed: () => {} })
    lives.push(live)
    live.start([entryOf(f)])
    await until(() => liveReqs(f), (n) => n >= 1)
    await wait(600)
    live.resume()
    await wait(100)
    expect(liveReqs(f)).toBe(1)
    live.onRegistry({ kind: 'entry', entry: { ...entryOf(f), instance: 'a-new-instance-1234' } })
    await until(() => liveReqs(f), (n) => n >= 2)
    expect(liveReqs(f)).toBe(2)
  })
})

describe('marks and notices from the fake canvas (A4.6 #17, #19, #23)', () => {
  it('an ask raises the tab\'s count and one notice; a reconnect posts nothing old; an item born in the gap posts', async () => {
    const w = world()
    const f = await fake({ slot: 11, live: true, name: 'Pilot' })
    const posts: string[] = []
    const { live, notify } = await wired()
    const n = createNotify({
      now: () => Date.now(), held: (i) => live.held(i), config: () => ({ notifications: true, dockBadge: true }), turnOn: async () => true,
      presenter: () => ({ create: () => {}, post: (x) => { posts.push(`${x.title}: ${x.body}`); return {} }, badge: () => {} }),
      inFront: () => false, state: () => ({ v: 1 }), setState: () => {}, offer: () => {}, missed: () => {}, refresh: () => {}, open: () => {},
    })
    notify(n)
    setMarksSource((t) => n.marksOf(t))
    show('home')
    const t = allTabs().find((x) => x.reg?.instance === f.instance)!
    await until(() => live.held(f.instance), (h) => !!h)   // the workspace's first snapshot: nothing waits
    f.setLive({ items: [ask('Which logo?')] })
    await until(() => posts.length, (x) => x === 1)
    expect(posts).toEqual(['Pilot: Asks you: Which logo?'])
    expect(n.marksOf(t)).toMatchObject({ needs: 1 })
    const first = ask('Which blue?')
    f.dropLive()                                  // the connection drops; the canvas moves on meanwhile
    f.setLive({ items: [first, ...live.held(f.instance)!.event.items] })
    await until(() => live.held(f.instance)?.event.items.length, (x) => x === 2)
    expect(posts).toEqual(['Pilot: Asks you: Which logo?', 'Pilot: Asks you: Which blue?'])
    f.dropLive()                                  // and again, nothing new: nothing posts
    await wait(400)
    expect(posts).toHaveLength(2)
    expect(n.marksOf(t)).toMatchObject({ needs: 2 })
    void w
  })
})
