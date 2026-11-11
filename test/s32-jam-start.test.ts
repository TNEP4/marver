import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendEvents, type CommentEvent } from '../src/server/comments.ts'
import { createJam } from '../src/server/jam/daemon.ts'
import { claudeAdapter } from '../src/server/jam/adapter/claude.ts'
import { record } from '../src/server/jam/ledger.ts'
import { readConn, readOffers, upsertConn } from '../src/server/jam/conn.ts'
import { request } from '../src/server/jam/transport.ts'
import { STALL_MS } from '../src/server/jam/runs.ts'
import { liveSnapshot } from '../src/server/app-live.ts'
import type { Batch, JamAdapter } from '../src/server/jam/types.ts'
import type { JamConfig } from '../src/server/config.ts'

/**
 * Spec 32 F2, Jam's half of "Agent working on X · N min": a run's start is when its execution began - `Batch.runAt`,
 * stamped at a session's claim (with `claim.at`) and when a background runner is set to run it - never while its batch
 * forms or is offered (queue.ts sets a card `working` while its batch forms, so a card's own clock would count the
 * wait). The daemon's view gives each working card that start as `startedAt` (an older batch with no `runAt` reads its
 * claim's `at`), a card's `at` never: resolving a working thread rewrites it. The live stream's `work.since` reads it.
 */

const CFG: JamConfig = { agent: 'claude', concurrency: 3, subagents: true, proactive: false, chime: false, capture: 'confirm', loc: true, names: false, runner: 'auto', session: true, context: 'fork', mcp: true, skills: true, others: false, sessionMax: 3 }

/** A stand-in for a spawned agent that takes `ms` before it answers like claude -p. */
const slow = (ms: number): JamAdapter => ({
  name: 'claude', supportsSubagents: true,
  spawnArgs() { return { cmd: process.execPath, args: ['-e', `setTimeout(()=>process.stdout.write(JSON.stringify({result:'A background agent did it.'})),${ms})`] } },
  parse: claudeAdapter.parse,
})

const workspace = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-s32-jam-')))
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  mkdirSync(join(root, 'design', 'scenes', 'demo'), { recursive: true })
  writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify({ name: 'Nic', email: 'nic@local' }))
  writeFileSync(join(root, 'design', 'scenes', 'demo', 'hero.tsx'), 'export default () => <h1>Hi</h1>\n')
  return { root, dir: join(root, 'design', 'comments'), done: () => rmSync(root, { recursive: true, force: true }) }
}
const tag = (root: string, dir: string) => {
  const id = randomUUID()
  const ev: CommentEvent = { id, ts: Date.now(), type: 'create', commentId: id, frame: 'demo/hero', nodeKey: 'demo/hero', author: { email: 'nic@local', name: 'Nic' }, body: '@marver make it say Hello' }
  appendEvents(dir, 'home', [ev])
  record(root, 'home', id)
  return ev
}
const until = async (ok: () => boolean, ms = 8_000, step?: () => unknown) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (ok()) return true; await step?.(); await new Promise((r) => setTimeout(r, 25)) }
  return ok()
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const REPLY = (text: string) => `\`\`\`marver-reply m1\n${text}\n\`\`\``

async function setup(o: { session?: boolean; adapter?: JamAdapter; cfg?: Partial<JamConfig> } = {}) {
  const w = workspace()
  const jam = createJam(w.root, { ...CFG, ...o.cfg }, o.adapter ?? slow(0))
  const conn = upsertConn(w.root, 'claude', randomUUID(), { pid: process.pid, cwd: w.root }, Date.now(), true)
  if (o.session !== false) await jam.session({ action: 'start', id: `ses-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
  const ask = async (op: Parameters<typeof request>[2], args: Record<string, unknown> = {}) => {
    let out: Record<string, unknown> | undefined
    const p = request(w.root, readConn(w.root, conn.id) ?? conn, op, args, 20_000).then((r) => { out = r })
    await until(() => !!out, 15_000, () => jam.runs.tick())
    await p
    return out!
  }
  const batch = (): Batch | undefined => jam.snapshot().batches.find((b) => b.state !== 'done') ?? jam.snapshot().batches.at(-1)
  const working = () => jam.view().cards.find((c) => c.state === 'working')
  return { ...w, jam, conn, ask, batch, working }
}

describe('a Jam run\'s start (spec 32 F2: Batch.runAt, the view\'s startedAt)', () => {
  it('an offered then claimed run: no start while it forms or waits on the offer; the claim stamps runAt = claim.at, the view and work.since read it, a stall and its resume keep it', { timeout: 60_000 }, async () => {
    const s = await setup()
    tag(s.root, s.dir)
    const t = s.jam.tick()
    expect(await until(() => (readOffers(s.root, s.conn.id)?.n ?? 0) === 1, 8_000, () => s.jam.runs.tick())).toBe(true)
    // formed and offered: its card is `working` already, its run has not begun
    const offered = s.batch()!
    expect(offered.offer).toBeTruthy()
    expect(offered.runAt).toBeUndefined()
    expect(s.working()?.startedAt).toBeUndefined()
    expect(s.working()?.runner?.state).toBe('offered')
    const formedAt = offered.at
    await wait(60)
    const n = await s.ask('next')
    const handle = String(n.handle)
    const b = s.batch()!
    expect(b.claim?.at).toBeGreaterThan(formedAt)
    expect(b.runAt).toBe(b.claim!.at)
    expect(s.working()?.startedAt).toBe(b.claim!.at)
    // the live stream: since when it has been at work - the claim's time, not the batch's forming
    const live = liveSnapshot({ boards: [], fresh: [], jam: s.jam.view(), cli: [] })
    expect(live.work).toEqual({ board: 'home', since: b.claim!.at })
    // persisted: a restart reads the same start
    const journal = JSON.parse(readFileSync(join(s.root, 'design', '.local', 'jam-jobs.json'), 'utf8'))
    expect(journal.batches.find((x: Batch) => x.batchId === b.batchId).runAt).toBe(b.claim!.at)
    // a stall and its resume under one claim keep it (Default, F2)
    await s.jam.runs.tick(Date.now() + STALL_MS + 1_000)
    const r = s.working()!.runner!
    expect(r.state).toBe('stalled')
    expect((await s.jam.runs.act(r.batch, r.gen!, 'again')).ok).toBe(true)
    expect(s.batch()!.runAt).toBe(b.claim!.at)
    expect(s.working()?.startedAt).toBe(b.claim!.at)
    expect((await s.ask('done', { handle, text: REPLY('ok') })).ok).toBe(true)
    await t
    s.jam.stop(); s.done()
  })

  it('resolving the thread of a working run rewrites the card\'s `at` and leaves its startedAt as it was', { timeout: 60_000 }, async () => {
    const s = await setup()
    const ev = tag(s.root, s.dir)
    const t = s.jam.tick()
    await until(() => (readOffers(s.root, s.conn.id)?.n ?? 0) === 1, 8_000, () => s.jam.runs.tick())
    const handle = String((await s.ask('next')).handle)
    const started = s.working()!.startedAt!
    const at0 = s.working()!.at
    expect(started).toBe(s.batch()!.claim!.at)
    await wait(30)
    appendEvents(s.dir, 'home', [{ id: `rs-${randomUUID()}`, ts: Date.now(), type: 'resolve', commentId: ev.commentId, author: { email: 'nic@local', name: 'Nic' } }])
    await s.jam.poke()
    const c = s.jam.view().cards.find((x) => x.state === 'working')!
    expect(c.at).toBeGreaterThan(at0)
    expect(c.startedAt).toBe(started)
    expect((await s.ask('done', { handle, text: REPLY('ok') })).ok).toBe(true)
    await t
    s.jam.stop(); s.done()
  })

  it('a background run: runAt is stamped when its runner is set to run it (fork or fresh), and the view reads it while it runs', { timeout: 60_000 }, async () => {
    const s = await setup({ session: false, adapter: slow(1500) })
    tag(s.root, s.dir)
    const before = Date.now()
    const t = s.jam.tick()
    expect(await until(() => typeof s.working()?.startedAt === 'number', 10_000)).toBe(true)
    const b = s.batch()!
    expect(b.runner?.kind).toMatch(/fresh|fork/)
    expect(b.runAt).toBeGreaterThanOrEqual(before)
    expect(b.runAt).toBeGreaterThanOrEqual(b.at - 1_000)
    expect(s.working()!.startedAt).toBe(b.runAt)
    expect(liveSnapshot({ boards: [], fresh: [], jam: s.jam.view(), cli: [] }).work?.since).toBe(b.runAt)
    await t
    s.jam.stop(); s.done()
  })

  it('a session run let go to the background: the background start stamps runAt again, after the claim', { timeout: 60_000 }, async () => {
    const s = await setup({ adapter: slow(1500) })
    tag(s.root, s.dir)
    const t = s.jam.tick()
    await until(() => (readOffers(s.root, s.conn.id)?.n ?? 0) === 1, 8_000, () => s.jam.runs.tick())
    const handle = String((await s.ask('next')).handle)
    const claimAt = s.batch()!.claim!.at
    await wait(40)
    expect((await s.ask('release', { handle })).ok).toBe(true)
    expect(await until(() => { const b = s.batch(); return !!b && b.runner?.kind !== 'session' && (b.runAt ?? 0) > claimAt }, 10_000, () => s.jam.runs.tick())).toBe(true)
    await t
    s.jam.stop(); s.done()
  })

  it('a new claim (a new gen) stamps runAt again: released under session-only, offered again and claimed again, its start is the second claim\'s', { timeout: 60_000 }, async () => {
    const s = await setup({ cfg: { runner: 'session' } })
    tag(s.root, s.dir)
    const t = s.jam.tick()
    expect(await until(() => (readOffers(s.root, s.conn.id)?.n ?? 0) === 1, 8_000, () => s.jam.runs.tick())).toBe(true)
    const h1 = String((await s.ask('next')).handle)
    const first = s.batch()!
    const gen1 = first.claim!.gen, at1 = first.claim!.at
    expect(first.runAt).toBe(at1)
    await wait(40)
    expect((await s.ask('release', { handle: h1 })).ok).toBe(true)
    // session-only: it waits for a session again, offered again, never spawned
    expect(await until(() => !!s.batch()?.offer, 10_000, () => s.jam.runs.tick())).toBe(true)
    expect(s.batch()!.runAt).toBe(at1)                // not yet begun again: the last start stands until a claim
    const h2 = String((await s.ask('next')).handle)
    const b = s.batch()!
    expect(h2).not.toBe(h1)
    expect(b.claim!.gen).toBeGreaterThan(gen1)
    expect(b.claim!.at).toBeGreaterThan(at1)
    expect(b.runAt).toBe(b.claim!.at)
    expect(s.working()?.startedAt).toBe(b.claim!.at)
    expect(liveSnapshot({ boards: [], fresh: [], jam: s.jam.view(), cli: [] }).work).toEqual({ board: 'home', since: b.claim!.at })
    expect((await s.ask('done', { handle: h2, text: REPLY('ok') })).ok).toBe(true)
    await t
    s.jam.stop(); s.done()
  })

  it('a batch from an older journal (no runAt) reads its claim\'s at; one never claimed reads nothing from the view', { timeout: 60_000 }, async () => {
    const s = await setup()
    tag(s.root, s.dir)
    const t = s.jam.tick()
    await until(() => (readOffers(s.root, s.conn.id)?.n ?? 0) === 1, 8_000, () => s.jam.runs.tick())
    const handle = String((await s.ask('next')).handle)
    const b = s.batch()!
    const at = b.claim!.at
    delete b.runAt                                  // as a journal written before 0.32 holds it
    expect(s.working()!.startedAt).toBe(at)
    expect((await s.ask('done', { handle, text: REPLY('ok') })).ok).toBe(true)
    await t
    s.jam.stop(); s.done()
  })
})
