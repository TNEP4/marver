import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLI, fixtureRoot, startDev, type Dev } from './dev-server.ts'
import { appProof, liveProof } from '../src/server/proof.ts'
import { LIVE_WIRE, type LiveEvent } from '../src/shared/app-api.ts'
import { liveId, liveSnapshot } from '../src/server/app-live.ts'
import { liveSources } from '../src/server/plugin.ts'
import { appendEvents, type CommentEvent } from '../src/server/comments.ts'
import { createJam, type JamHooks } from '../src/server/jam/daemon.ts'
import { claudeAdapter } from '../src/server/jam/adapter/claude.ts'
import { record } from '../src/server/jam/ledger.ts'
import { endConn, readConn, readOffers, upsertConn } from '../src/server/jam/conn.ts'
import { request } from '../src/server/jam/transport.ts'
import { STALL_MS } from '../src/server/jam/runs.ts'
import { jamLive } from '../src/server/jam/live.ts'
import { workActivity } from '../src/server/work.ts'
import type { CaptureRecord, JamAdapter } from '../src/server/jam/types.ts'
import type { JamConfig } from '../src/server/config.ts'

/**
 * The live stream in a running canvas (spec 28 A4.6 #5-#14; the dev cases of #52 and r2 #3). A REAL `marver dev` from
 * dist/, under a registry of its own: the slot file lists `live` and `open`; the app's request proved and answered with
 * `liveProof`; an asking reply appended to a log reaches a client within a second and an owner reply removes it;
 * `marver work start` lights `working`; marks/seen lowers `unseen`; another workspace is a 409; a close with a client
 * connected ends within 2 s; an .env edit restarts Vite, the stream ends, and a reconnect gets the same ids, `seq`
 * higher. Then Jam in this process through the real adapters (plugin.ts `liveSources`, the process's `workActivity`):
 * a finished capture run a review, two failed attempts a failed item, a claim past the stall time a stalled item that
 * Give it back removes, and Jam's own leases never lighting `working` - only `marver work`'s and the runs at work do.
 */

const home = realpathSync(mkdtempSync(join(tmpdir(), 'mv-live-home-')))
const env = () => ({ MARVER_HOME: home })
const roots: string[] = [home]
const devs: Dev[] = []
afterAll(async () => {
  for (const d of devs.splice(0)) await d.stop('SIGKILL')
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const FRAME = (t: string) => `export const meta = { title: '${t}', viewport: 'mobile' }\nexport default () => <main style={{ padding: 24 }}><h1>${t}</h1></main>\n`
const project = (prefix: string) => {
  const r = fixtureRoot(prefix, {
    'design/config.ts': 'export default { jam: false }\n',
    'design/scenes/demo/one.tsx': FRAME('One'),
    'design/scenes/demo/two.tsx': FRAME('Two'),
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [{ key: 'n-one', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 }, { key: 'n-two', frame: 'demo/two', x: 600, y: 0, w: 390, h: 844 }] }),
  })
  roots.push(r)
  return r
}
const start = async (root: string) => { const d = await startDev(root, { env: env() }); devs.push(d); return d }
/** this canvas's slot file: its key, port, instance, workspace and features */
const slotOf = (root: string) => {
  for (const f of readdirSync(join(home, 'running'))) {
    try { const r = JSON.parse(readFileSync(join(home, 'running', f), 'utf8')); if (r.root === root && r.state === 'ready') return r } catch { /* mid-write */ }
  }
  throw new Error('no slot file')
}
const cli = (args: string[], root: string) => new Promise<{ code: number; out: string }>((resolve) => {
  execFile(process.execPath, [CLI, ...args, '--root', root], { cwd: root, env: { ...process.env, ...env(), CI: '1' }, timeout: 60_000 }, (err, stdout, stderr) =>
    resolve({ code: err ? Number((err as { code?: number }).code) || 1 : 0, out: stdout + stderr }))
})

/** The app's request (A4.6 #16): `x-mv-ws`, a fresh nonce, `x-mv-app`; and a reader of whole events. */
async function connect(root: string, o: { ws?: string } = {}) {
  const slot = slotOf(root)
  const key = Buffer.from(slot.key, 'base64url')
  const nonce = randomBytes(24).toString('base64url')
  const ac = new AbortController()
  const res = await fetch(`${slot.origin}${LIVE_WIRE.path}`, { headers: { accept: LIVE_WIRE.type, 'x-mv-ws': o.ws ?? slot.ws, 'x-mv-nonce': nonce, 'x-mv-app': appProof(key, slot.port) }, signal: ac.signal, redirect: 'error' })
  const reader = res.status === 200 ? res.body!.getReader() : null
  let buf = ''
  const events: LiveEvent[] = []
  let ended = false
  // read in the background: every event kept, in order
  void (async () => {
    if (!reader) return
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (r.done) { ended = true; return }
      buf += new TextDecoder().decode(r.value)
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        if (block.startsWith('event: live\ndata: ')) events.push(JSON.parse(block.slice('event: live\ndata: '.length)))
      }
    }
  })()
  return {
    res, key, nonce, slot, events, ended: () => ended, last: () => events.at(-1),
    /** the first event (from now on) that satisfies `ok`, and how long it took */
    async until(ok: (e: LiveEvent) => boolean, ms = 5000) {
      const from = events.length, t = Date.now()
      for (;;) {
        const hit = events.slice(from).find(ok) ?? (from && ok(events[from - 1]) ? events[from - 1] : undefined)
        if (hit) return { e: hit, ms: Date.now() - t }
        if (Date.now() - t > ms) throw new Error(`no such event in ${ms} ms: ${JSON.stringify(events.at(-1))}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    },
    close: () => ac.abort(),
  }
}

const event = (o: Partial<CommentEvent> & { id: string; type: CommentEvent['type'] }): CommentEvent => ({ ts: Date.now(), board: 'main', ...o })

describe('a real marver dev (A4.6 #52 dev)', () => {
  let root = '', dev: Dev
  it('the slot file lists `live` and `open`; the app\'s request is answered 200 with liveProof and a snapshot at once', async () => {
    root = project('mv-live-dev-')
    dev = await start(root)
    const slot = slotOf(root)
    expect(slot.features).toEqual(expect.arrayContaining(['bridge', 'inset', 'live', 'open']))
    const c = await connect(root)
    expect(c.res.status).toBe(200)
    expect(c.res.headers.get('x-mv-instance')).toBe(slot.instance)
    expect(c.res.headers.get('x-mv-proof')).toBe(liveProof(c.key, c.nonce, slot.port))
    const { e } = await c.until(() => true)
    expect(e).toMatchObject({ v: 1, instance: slot.instance, jam: 'off', items: [], counts: { ask: 0, review: 0, failed: 0, stalled: 0 }, unseen: 0, working: false, session: false })
    c.close()
  }, 120_000)

  it('another workspace\'s x-mv-ws is a 409 before anything is read; a wrong x-mv-app a 403', async () => {
    const c = await connect(root, { ws: '0123456789abcdef' })
    expect([c.res.status, c.res.headers.get('x-mv-elsewhere')]).toEqual([409, '1'])
    const slot = slotOf(root)
    const r = await fetch(`${slot.origin}${LIVE_WIRE.path}`, { headers: { 'x-mv-ws': slot.ws, 'x-mv-nonce': 'n'.repeat(32), 'x-mv-app': appProof(randomBytes(32), slot.port) } })
    expect(r.status).toBe(403)
  })

  it('an asking reply appended to a log reaches a client within a second; an owner reply removes it', async () => {
    const c = await connect(root)
    await c.until(() => true)
    const dir = join(root, 'design', 'comments')
    appendEvents(dir, 'main', [event({ id: 'e1', type: 'create', commentId: 't1', frame: 'demo/one', nodeKey: 'n-one', body: '@marver which colour?', author: { name: 'Nic' } })])
    appendEvents(dir, 'main', [event({ id: 'e2', type: 'reply', commentId: 'r1', parentId: 't1', agent: true, asks: true, body: 'Blue or green?' })])
    const asked = await c.until((e) => e.counts.ask === 1)
    expect(asked.ms).toBeLessThan(1000)
    expect(asked.e.items[0]).toMatchObject({ kind: 'ask', board: 'main', thread: 't1', msg: 'r1', frame: 'demo/one', title: 'Blue or green?' })
    appendEvents(dir, 'main', [event({ id: 'e3', type: 'reply', commentId: 'r2', parentId: 't1', body: 'green', author: { name: 'Nic' } })])
    const answered = await c.until((e) => e.counts.ask === 0)
    expect(answered.ms).toBeLessThan(1000)
    expect(answered.e.seq).toBeGreaterThan(asked.e.seq)
    c.close()
  })

  it('`marver work start` lights `working` within a second; `work done` puts it out and marks the frame new; marks/seen lowers `unseen`', async () => {
    const c = await connect(root)
    await c.until(() => true)
    // the CLI end to end, then the request it makes timed from the server's answer (a CLI process's own exit is no
    // part of the stream's latency, and a loaded machine can take a while over it)
    expect((await cli(['work', 'start', 'demo/two'], root)).code).toBe(0)
    await c.until((e) => e.working)
    expect((await cli(['work', 'done', 'demo/two'], root)).code).toBe(0)
    await c.until((e) => !e.working)
    const { token } = JSON.parse(readFileSync(join(root, 'design', '.local', 'dev.json'), 'utf8')) as { token: string }
    const work = (on: boolean) => fetch(`${dev.origin}/__mv/api/work`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-work': token }, body: JSON.stringify({ frames: ['demo/two'], on }) })
    expect((await work(true)).status).toBe(200)
    expect((await c.until((e) => e.working)).ms).toBeLessThan(1000)
    expect((await work(false)).status).toBe(200)
    expect((await c.until((e) => !e.working)).ms).toBeLessThan(1000)
    expect((await c.until((e) => e.unseen === 1)).e.unseen).toBe(1)   // the agent said it changed it: new to you
    const owner = { cookie: 'mv_c=tok', 'x-mv-c': 'tok', 'content-type': 'application/json' }
    const marks = await (await fetch(`${dev.origin}/__mv/api/marks`, { headers: owner })).json() as { epoch: string; changed: Record<string, number> }
    const seen = await fetch(`${dev.origin}/__mv/api/marks/seen`, { method: 'POST', headers: owner, body: JSON.stringify({ epoch: marks.epoch, frames: { 'demo/two': marks.changed['demo/two'] } }) })
    expect(seen.status).toBe(200)
    expect((await c.until((e) => e.unseen === 0)).ms).toBeLessThan(1000)
    c.close()
  })

  it('an .env edit restarts Vite: the stream ends, and a reconnect gets the same ids with a higher seq', async () => {
    const dir = join(root, 'design', 'comments')
    appendEvents(dir, 'main', [event({ id: 'e4', type: 'create', commentId: 't2', frame: 'demo/two', body: 'a note', author: { name: 'Nic' } }), event({ id: 'e5', type: 'reply', commentId: 'r3', parentId: 't2', agent: true, asks: true, body: 'Which size?' })])
    const c = await connect(root)
    const before = (await c.until((e) => e.counts.ask === 1)).e
    writeFileSync(join(root, '.env'), 'MV_RESTART=1\n')
    for (let by = Date.now() + 30_000; Date.now() < by && !c.ended(); await new Promise((r) => setTimeout(r, 50)));
    expect(c.ended()).toBe(true)
    for (let by = Date.now() + 30_000; Date.now() < by && !/server restarted/.test(dev.out()); await new Promise((r) => setTimeout(r, 100)));
    const again = await connect(root)
    const after = (await again.until(() => true)).e
    expect(after.items.map((i) => i.id)).toEqual(before.items.map((i) => i.id))
    expect(after.seq).toBeGreaterThan(before.seq)
    again.close()
  }, 60_000)

  it('a close with a client connected ends within 2 s', async () => {
    const c = await connect(root)
    await c.until(() => true)
    const t = Date.now()
    await dev.stop('SIGINT')
    devs.splice(devs.indexOf(dev), 1)
    expect(Date.now() - t).toBeLessThan(2000)
    for (let by = Date.now() + 2000; Date.now() < by && !c.ended(); await new Promise((r) => setTimeout(r, 20)));
    expect(c.ended()).toBe(true)
  }, 30_000)
})

// ---- Jam, in this process, through the real adapters ------------------------------------------------------------

const CFG: JamConfig = { agent: 'claude', concurrency: 3, subagents: true, proactive: false, chime: false, capture: 'confirm', loc: true, names: false, runner: 'auto', session: true, context: 'fork', mcp: true, skills: true, others: false, sessionMax: 3 }
const AGENT = fileURLToPath(new URL('./fixtures/jam-agent.cjs', import.meta.url))
/** an agent that answers (the capture fixture), fails, or takes its time */
const agent = (how: 'ok' | 'fail' | 'slow'): JamAdapter => ({
  name: 'claude', supportsSubagents: true,
  spawnArgs(goal) {
    if (how === 'fail') return { cmd: process.execPath, args: ['-e', 'process.exit(1)'] }
    if (how === 'slow') return { cmd: process.execPath, args: ['-e', `setTimeout(() => process.stdout.write(JSON.stringify({ result: 'done slowly' })), 4000)`] }
    const file = /design\/\.local\/jam\/packets\/[\w-]+\.json/.exec(goal)![0]
    return { cmd: process.execPath, args: [AGENT, file], env: { MODE: JSON.stringify('ok'), OPTS: '{}' } }
  },
  parse: claudeAdapter.parse,
})
/** the daemon's own leases, as startJam keeps them: through the process's workActivity, source `jam` */
const work: JamHooks['work'] = (f, on) => (on ? workActivity.mark(f ?? '', undefined, 'jam') : workActivity.clear(f ?? '', 'jam'))
const FRAMES = [{ id: 'demo/hero', file: 'design/scenes/demo/hero.tsx', kind: 'tsx' as const }, { id: 'demo/other', file: 'design/scenes/demo/other.tsx', kind: 'tsx' as const }]

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-live-jam-')))
  roots.push(root)
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  mkdirSync(join(root, 'design', 'scenes', 'demo'), { recursive: true })
  writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify({ name: 'Nic', email: 'nic@local' }))
  writeFileSync(join(root, 'design', 'scenes', 'demo', 'hero.tsx'), 'export default () => <h1>Hi</h1>\n')
  const src = liveSources(root)
  return { root, dir: join(root, 'design', 'comments'), live: () => liveSnapshot(src.read(FRAMES)) }
}
const tag = (root: string, dir: string, body = '@marver make it say Hello') => {
  const id = randomUUID()
  appendEvents(dir, 'home', [{ id, ts: Date.now(), type: 'create', commentId: id, frame: 'demo/hero', nodeKey: 'demo/hero', author: { email: 'nic@local', name: 'Nic' }, body }])
  record(root, 'home', id)
  return id
}
const until = async (ok: () => boolean, ms = 10_000, step?: () => unknown) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (ok()) return true; await step?.(); await new Promise((r) => setTimeout(r, 25)) }
  return ok()
}

describe('Jam through the real adapters, in this process (A4.6 #52 dev, r2 #3)', () => {
  afterEach(() => { delete jamLive.view; workActivity.clearAll('jam'); workActivity.clearAll('cli') })

  it('a finished capture run gives a review; Jam off gives `jam: off`', async () => {
    const w = workspace()
    expect(w.live().jam).toBe('off')
    const jam = createJam(w.root, { ...CFG, runner: 'background', session: false, context: 'fresh' }, agent('ok'), undefined, {
      work, anchor: async (_f, target) => ({ ok: true, anchor: { el: { semantics: { quote: target.on } } }, holders: [], viewport: 'laptop', theme: 'light' }),
      shoot: async () => `p-${randomBytes(8).toString('hex')}`,
    })
    jamLive.view = () => jam.view()
    const id = `cap-${Date.now()}-abcdef`
    const rec: CaptureRecord = { format: 'marver.jam.capture', v: 1, id, context: { canvas: 'test', board: 'home', review: true }, view: { board: 'home', frames: ['demo/a'], theme: 'light' },
      timeline: [{ at: 1, event: 'view', view: { frames: ['demo/a'] } }, { at: 2, event: 'words', text: 'make the badge match' }, { at: 3, frame: 'demo/a', event: 'pick', point: 1, mode: 'canvas', bundle: { tag: 'span', quote: 'Save 20%', source: 'design/scenes/demo/a.tsx:4:7' } }], pictures: [] }
    const made = await jam.capture(rec)
    expect((await jam.act(id, made.card!.rev, 'confirm')).ok).toBe(true)
    await jam.tick(); jam.stop()
    const b = w.live()
    expect(b.jam).toBe('on')
    expect(b.counts.review).toBe(1)
    expect(b.items.find((i) => i.kind === 'review')).toMatchObject({ cards: [id], occ: 1, board: 'home' })
  }, 30_000)

  it('two failed attempts give one failed item, by its batch and its failures', async () => {
    const w = workspace()
    const jam = createJam(w.root, { ...CFG, runner: 'background', session: false, context: 'fresh' }, agent('fail'), undefined, { work })
    jamLive.view = () => jam.view()
    const thread = tag(w.root, w.dir, '@marver make it blue')
    await jam.tick(); jam.stop()
    const failed = jam.snapshot().batches[0]
    expect([failed.attempts, failed.failures]).toEqual([2, 1])
    const i = w.live().items.find((x) => x.kind === 'failed')!
    expect(i).toMatchObject({ batch: failed.batchId, occ: 1, thread, title: '@marver make it blue' })
  }, 30_000)

  it('a failed batch of two cards in a journal from before the counters - no `failures`, no `att` - is one item listing both (A4.6 #9, #10)', async () => {
    const w = workspace()
    const jam = createJam(w.root, { ...CFG, runner: 'background', session: false, context: 'fresh' }, agent('fail'), undefined, { work })
    // two tags on one frame, queued together: one run
    const first = tag(w.root, w.dir, '@marver make it blue'), second = tag(w.root, w.dir, '@marver and the border')
    await jam.tick(); jam.stop()
    const { batches } = jam.snapshot()
    // (each card failing counts one: an id is compared, never counted - A4.6 #9)
    expect([batches.length, batches[0].members.length, batches[0].failures]).toEqual([1, 2, 2])
    // the same journal as a 0.28 canvas wrote it
    const file = join(w.root, 'design', '.local', 'jam-jobs.json')
    const j = JSON.parse(readFileSync(file, 'utf8'))
    for (const b of j.batches) delete b.failures
    for (const c of j.cards) delete c.att
    writeFileSync(file, JSON.stringify(j))
    const older = createJam(w.root, { ...CFG, runner: 'background', session: false, context: 'fresh' }, agent('fail'), undefined, { work })
    jamLive.view = () => older.view()
    const b = w.live()
    expect(b.items.filter((x) => x.kind === 'failed')).toEqual([expect.objectContaining({ id: liveId('failed', batches[0].batchId, 0), batch: batches[0].batchId, occ: 0, cards: expect.arrayContaining([j.cards.find((c: { thread: string }) => c.thread === first).id, j.cards.find((c: { thread: string }) => c.thread === second).id]) })])
    expect(b.counts.failed).toBe(1)
    older.stop()
  }, 30_000)

  /** A daemon with a Jam session and one Claude Code session connected (this process), as jam-runs.test.ts runs them. */
  async function session(cfg: Partial<JamConfig> = {}) {
    const w = workspace()
    const jam = createJam(w.root, { ...CFG, ...cfg }, agent('ok'), undefined, { work })
    jamLive.view = () => jam.view()
    const conn = upsertConn(w.root, 'claude', randomUUID(), { pid: process.pid, cwd: w.root }, Date.now(), true)
    await jam.session({ action: 'start', id: `ses-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
    const ask = async (op: Parameters<typeof request>[2], args: Record<string, unknown> = {}, c = conn) => {
      let out: Record<string, unknown> | undefined
      const p = request(w.root, readConn(w.root, c.id) ?? c, op, args, 20_000).then((r) => { out = r })
      await until(() => !!out, 15_000, () => jam.runs.tick())
      await p
      return out!
    }
    return { ...w, jam, conn, ask }
  }

  it('a claim past the stall time is a stalled item; Give it back removes it; a second stall is a new id', async () => {
    const s = await session()
    tag(s.root, s.dir)
    const t = s.jam.tick()
    await until(() => (readOffers(s.root, s.conn.id)?.n ?? 0) === 1, 8_000, () => s.jam.runs.tick())
    const handle = String((await s.ask('next')).handle)
    expect(s.live().counts.stalled).toBe(0)
    await s.jam.runs.tick(Date.now() + STALL_MS + 1_000)
    const first = s.live().items.find((i) => i.kind === 'stalled')!
    expect(first).toMatchObject({ occ: 1, gen: expect.any(Number) })
    expect((await s.jam.runs.act(first.batch!, first.gen!, 'again')).ok).toBe(true)
    expect(s.live().counts.stalled).toBe(0)
    await s.jam.runs.tick(Date.now() + STALL_MS + 1_000)
    const second = s.live().items.find((i) => i.kind === 'stalled')!
    expect([second.gen, second.occ, second.id === first.id]).toEqual([first.gen, 2, false])
    expect((await s.ask('done', { handle, text: '```marver-reply m1\nDone.\n```' })).ok).toBe(true)
    await t
    s.jam.stop()
  }, 60_000)

  it('Jam\'s own leases never light `working`: waiting, offered, stalled and stopping are not at work; claimed is; `marver work` alone is (r2 #3)', async () => {
    const s = await session({ runner: 'session' })
    endConn(s.root, s.conn.id)
    tag(s.root, s.dir)
    const t = s.jam.tick()
    const lease = () => workActivity.mark('demo/hero', 60_000, 'jam')   // as the daemon's 2 s heartbeat keeps it
    await until(() => s.jam.view().cards.some((c) => c.runner?.state === 'waiting'), 8_000, () => s.jam.runs.tick())
    lease()
    expect([s.live().working, workActivity.active()]).toEqual([false, ['demo/hero']])
    const next = upsertConn(s.root, 'claude', randomUUID(), { pid: process.pid, cwd: s.root }, Date.now(), true)
    await until(() => (readOffers(s.root, next.id)?.n ?? 0) === 1, 8_000, () => s.jam.runs.tick())
    lease()
    expect([s.jam.view().cards.find((c) => c.state === 'working')?.runner?.state, s.live().working]).toEqual(['offered', false])
    const handle = String((await s.ask('next', {}, next)).handle)
    lease()
    expect([s.jam.view().cards.find((c) => c.state === 'working')?.runner?.state, s.live().working]).toEqual(['claimed', true])
    await s.jam.runs.tick(Date.now() + STALL_MS + 1_000)
    lease()
    expect([s.jam.view().cards.find((c) => c.state === 'working')?.runner?.state, s.live().working]).toEqual(['stalled', false])
    // your agent in chat starts on another frame beside the stalled run: at work, and back to rest at its done
    workActivity.mark('demo/other', 60_000, 'cli')
    expect(s.live().working).toBe(true)
    workActivity.clear('demo/other', 'cli')
    expect([s.live().working, workActivity.has('demo/hero', 'jam')]).toEqual([false, true])
    const r = s.jam.view().cards.find((c) => c.state === 'working')!.runner!
    expect((await s.jam.runs.act(r.batch, r.gen!, 'background')).ok).toBe(true)
    lease()
    expect([s.jam.view().cards.find((c) => c.state === 'working')?.runner?.state, s.live().working]).toEqual(['stopping', false])
    await s.ask('release', { handle }, next)
    s.jam.stop()
    await t.catch(() => {})
  }, 60_000)

  it('a background run (a runner with no state) is at work while it runs', async () => {
    const w = workspace()
    const jam = createJam(w.root, { ...CFG, runner: 'background', session: false, context: 'fresh' }, agent('slow'), undefined, { work })
    jamLive.view = () => jam.view()
    tag(w.root, w.dir)
    const t = jam.tick()
    expect(await until(() => jam.view().cards.some((c) => c.state === 'working' && !!c.runner && !c.runner.state))).toBe(true)
    expect(w.live().working).toBe(true)
    await t
    jam.stop()
    expect(w.live().working).toBe(false)
  }, 30_000)
})
