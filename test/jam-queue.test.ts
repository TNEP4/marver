import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendEvents, readLog, replay, type CommentEvent } from '../src/server/comments.ts'
import { spawn } from 'node:child_process'
import { canonicalShared, createJam } from '../src/server/jam/daemon.ts'
import { claudeAdapter } from '../src/server/jam/adapter/claude.ts'
import { record } from '../src/server/jam/ledger.ts'
import { deviceId } from '../src/server/jam/device.ts'
import { read as readJournal, write as writeJournal } from '../src/server/jam/journal.ts'
import { act, answers, ctxFor, form, freezeBrief, ingest, merge, settle, writePacket } from '../src/server/jam/queue.ts'
import { buildPacket, goalText, packetPath, parseMembers, sharedFile } from '../src/server/jam/packet.ts'
import { jamReservations, refuseHold, restoreHolds, saveHolds } from '../src/server/jam/reserve.ts'
import { createActivity } from '../src/server/jam/activity.ts'
import type { Batch, Card, JamAdapter, Journal, JournalV1 } from '../src/server/jam/types.ts'
import type { JamConfig } from '../src/server/config.ts'
import { statusLines } from '../src/client/shell/jam-lines.ts'

const CFG: JamConfig = { agent: 'claude', concurrency: 3, subagents: true, proactive: false, chime: true, capture: 'confirm', loc: true, names: false }
const AGENT = fileURLToPath(new URL('./fixtures/jam-agent.cjs', import.meta.url))
const OWNER = { email: 'nic@local', name: 'Nic' }

/** The fake agent (fixtures/jam-agent.cjs): answers every member of the packet the prompt names. */
const agent = (mode: unknown = 'ok', opts: Record<string, unknown> = {}): JamAdapter => ({
  name: 'claude', supportsSubagents: true,
  spawnArgs(goal) {
    const file = /design\/\.local\/jam\/packets\/[\w-]+\.json/.exec(goal)![0]
    return { cmd: process.execPath, args: [AGENT, file], env: { MODE: JSON.stringify(mode), OPTS: JSON.stringify(opts) } }
  },
  parse: claudeAdapter.parse,
})

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'mv-jamq-'))
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify(OWNER))
  return { root, dir: join(root, 'design', 'comments'), done: () => rmSync(root, { recursive: true, force: true }) }
}

let clock = Date.now()
const tick = () => (clock = Math.max(clock + 10, Date.now()))
/** An owner comment through the gated POST: appended and ledgered. `ledger: false` = synced in. */
function say(root: string, dir: string, body: string, o: { board?: string; thread?: string; frame?: string; id?: string; ledger?: boolean; agent?: boolean } = {}): CommentEvent {
  const board = o.board ?? 'home'
  const id = o.id ?? `e${Math.random().toString(36).slice(2, 10)}`
  const ev: CommentEvent = o.thread
    ? { id, ts: tick(), type: 'reply', commentId: `rc-${id}`, parentId: o.thread, board, author: OWNER, body, ...(o.agent ? { agent: true } : {}) }
    : { id, ts: tick(), type: 'create', commentId: id, frame: o.frame ?? 'demo/hero', board, author: OWNER, body, ...(o.agent ? { agent: true } : {}) }
  appendEvents(dir, board, [ev])
  if (o.ledger !== false && !o.agent) record(root, board, id)
  return ev
}
const edit = (root: string, dir: string, of: CommentEvent, body: string, ledger = true) => {
  const id = `ed${Math.random().toString(36).slice(2, 10)}`
  appendEvents(dir, of.board ?? 'home', [{ id, ts: tick(), type: 'edit', commentId: of.commentId, body, author: OWNER }])
  if (ledger) record(root, of.board ?? 'home', id)
  return id
}
const resolve = (dir: string, thread: string, board = 'home') => appendEvents(dir, board, [{ id: `rs${Math.random()}`, ts: tick(), type: 'resolve', commentId: thread, author: OWNER }])
const agentReplies = (dir: string, board = 'home') => replay(readLog(dir, board)).flatMap((t) => t.replies.filter((r) => r.agent))
const packets = (root: string) => existsSync(join(root, 'packets-seen.jsonl'))
  ? readFileSync(join(root, 'packets-seen.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
const cardOf = (jam: { snapshot(): Journal }, ev: CommentEvent) => jam.snapshot().cards.find((c) => c.events.includes(ev.id))
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Jam V2: only a tag starts work', () => {
  it('a plain owner reply in a thread where Marver spoke makes no card - through a restart; a tagged one does; a non-owner tag never does', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent())
    const note = say(root, dir, 'Kept the card first - right call?', { agent: true })
    const plain = say(root, dir, 'no, wallet first', { thread: note.commentId })
    await jam.tick(); jam.stop()
    expect(jam.snapshot().cards).toEqual([])
    const again = createJam(root, CFG, agent())       // a restart reads the same logs
    await again.tick()
    expect(again.snapshot().cards).toEqual([])
    say(root, dir, '@marver fix this', { ledger: false })   // synced from a collaborator
    await again.tick()
    expect(again.snapshot().cards).toEqual([])
    const tagged = say(root, dir, '@marver do it', { thread: note.commentId })
    await again.tick(); again.stop()
    const c = cardOf(again, tagged)!
    expect(c.state).toBe('done')
    expect(c.note).toBe('replied')
    // the plain answer was history in the brief - and so it is taken in
    expect(packets(root)[0].members[0].brief.history.map((m: any) => m.body)).toContain('no, wallet first')
    expect(c.brief?.asks.map((m) => m.id)).toEqual([tagged.id])
    expect(plain.id).toBeTruthy()
    done()
  })

  it('tags join: two tags in one thread before the claim make one card; a tag while it works makes a second card that follows it', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent('ok', { delay: 500 }))
    const a = say(root, dir, '@marver make it green')
    const b = say(root, dir, '@marver and bigger', { thread: a.commentId })
    const run = jam.tick()
    await wait(150)
    const c1 = cardOf(jam, a)!
    expect(c1.events).toEqual([a.id, b.id])
    expect(c1.state).toBe('working')
    const later = say(root, dir, '@marver also round the corners', { thread: a.commentId })
    await jam.poke()
    const c2 = cardOf(jam, later)!
    expect(c2.state).toBe('queued')
    expect(c2.follows).toBe(c1.id)
    await run; await jam.tick(); jam.stop()
    expect(cardOf(jam, later)!.state).toBe('done')
    // the follow-up's brief holds the card it follows: its asks and its result
    const p2 = packets(root)[1].members[0]
    expect(p2.brief.follows.asks.map((m: any) => m.body)).toEqual(['@marver make it green', '@marver and bigger'])
    expect(p2.brief.follows.result).toContain('Done:')
    expect(packets(root)[0].members.length).toBe(1)
    done()
  })

  it('an edit that adds a tag starts nothing; one that removes a tag cancels nothing', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent('ok', { delay: 300 }))
    const first = say(root, dir, '@marver one', { frame: 'demo/a' })
    const plain = say(root, dir, 'just a note', { frame: 'demo/b' })
    const queued = say(root, dir, '@marver two', { frame: 'demo/c' })
    const run = jam.tick()
    await wait(100)
    edit(root, dir, plain, '@marver now do it')
    edit(root, dir, queued, 'never mind the tag')
    await jam.poke()
    expect(jam.snapshot().cards.some((c) => c.events.includes(plain.id))).toBe(false)
    expect(cardOf(jam, queued)!.state).toBe('queued')
    await run; jam.stop()
    expect(cardOf(jam, first)!.state).toBe('done')
    done()
  })
})

describe('Jam V2: a tag\'s card in its thread', () => {
  it('queued → working → done ("replied"), never review; no notice; the queue view gives the position and the agent', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent('ok', { delay: 300 }))
    const a = say(root, dir, '@marver one', { frame: 'demo/a' })
    const b = say(root, dir, '@marver two', { frame: 'demo/b' })
    const c = say(root, dir, '@marver three', { frame: 'demo/c' })
    const run = jam.tick()
    await wait(120)
    const v = jam.view()
    expect(v.agent).toBe('claude')
    expect(v.cards.find((x) => x.events.includes(a.id))?.state).toBe('working')
    expect(v.cards.find((x) => x.events.includes(b.id))?.position).toBe(1)
    expect(v.cards.find((x) => x.events.includes(c.id))?.position).toBe(2)
    await run; jam.stop()
    for (const e of [a, b, c]) { const x = cardOf(jam, e)!; expect([x.state, x.note]).toEqual(['done', 'replied']) }
    expect(agentReplies(dir).length).toBe(3)
    done()
  })

  it('drop on an unclaimed queued tag; refused on a working card, on a stale rev; keep, first and the verdicts are refused on a tag', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent('ok', { delay: 300 }))
    const a = say(root, dir, '@marver one', { frame: 'demo/a' })
    const b = say(root, dir, '@marver two', { frame: 'demo/b' })
    const run = jam.tick()
    await wait(120)
    const working = cardOf(jam, a)!, queued = cardOf(jam, b)!
    expect((await jam.act(working.id, working.rev, 'drop')).ok).toBe(false)
    expect((await jam.act(queued.id, queued.rev - 1, 'drop')).error).toMatch(/changed/)
    for (const action of ['keep', 'first', 'good', 'more', 'later', 'confirm', 'edit']) {
      const r = await jam.act(queued.id, queued.rev, action)
      expect(r.ok).toBe(false)
      expect((r.card as Card).id).toBe(queued.id)
    }
    expect((await jam.act(queued.id, queued.rev, 'move')).ok).toBe(false)
    expect((await jam.act(queued.id, queued.rev, 'drop')).ok).toBe(true)
    await run; jam.stop()
    expect(cardOf(jam, b)!.state).toBe('dropped')
    expect(packets(root).length).toBe(1)
    done()
  })

  it('a question raises asks; a plain answer makes it done ("answered"); a failure turns failed, Retry queues it, a new tag follows it', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent('ask'))
    const q = say(root, dir, '@marver change the badge')
    await jam.tick()
    expect(cardOf(jam, q)!.state).toBe('asks')
    expect(agentReplies(dir).at(-1)?.asks).toBe(true)
    say(root, dir, 'the pill', { thread: q.commentId })
    await jam.tick(); jam.stop()
    expect([cardOf(jam, q)!.state, cardOf(jam, q)!.note]).toEqual(['done', 'answered'])

    const f = createJam(root, CFG, agent('ok', { fail: true }))
    const t = say(root, dir, '@marver break', { frame: 'demo/x' })
    await f.tick()
    const failed = cardOf(f, t)!
    expect(failed.state).toBe('failed')
    expect(agentReplies(dir).filter((r) => r.body?.includes('could')).length).toBe(0)   // no failure reply - the icon says it
    const retried = await f.act(failed.id, failed.rev, 'retry')
    expect([retried.ok, retried.card?.state]).toEqual([true, 'queued'])
    await f.tick(); f.stop()
    // it failed again; this time a new tag follows it
    expect(cardOf(f, t)!.state).toBe('failed')
    expect(cardOf(f, t)!.ran?.length).toBe(1)
    const h = createJam(root, CFG, agent())
    const again = say(root, dir, '@marver try again', { thread: t.commentId })
    await h.tick(); h.stop()
    expect([cardOf(h, t)!.state, cardOf(h, t)!.note]).toEqual(['done', 'retried by a new tag'])
    const p = packets(root).at(-1).members[0]
    expect(p.brief.follows.asks.map((m: any) => m.body)).toEqual(['@marver break'])
    expect(cardOf(h, again)!.state).toBe('done')
    done()
  })

  it('a question answered early: the owner replies while the job runs and the result asks - done, posted as not asking, no re-flag', async () => {
    const { root, dir, done } = setup()
    const q = 'Card number or CVC?'
    const line1 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: q }] } })
    const line2 = JSON.stringify({ type: 'result', result: '```marver-reply ask\n' + q + '\n```' })
    const script = `const L=${JSON.stringify([line1, line2])};process.stdout.write(L[0]+'\\n');setTimeout(()=>process.stdout.write(L[1]+'\\n'),500)`
    const early: JamAdapter = { name: 'claude', supportsSubagents: true, spawnArgs: () => ({ cmd: process.execPath, args: ['-e', script] }), parse: claudeAdapter.parse, earlyText: claudeAdapter.earlyText }
    const jam = createJam(root, CFG, early)
    const t = say(root, dir, '@marver fix the field')
    const run = jam.tick()
    await wait(300)
    say(root, dir, 'card number', { thread: t.commentId })
    await run; jam.stop()
    expect([cardOf(jam, t)!.state, cardOf(jam, t)!.note]).toEqual(['done', 'answered'])
    expect(readLog(dir, 'home').some((e) => e.type === 'edit' && e.agent)).toBe(false)
    expect(agentReplies(dir).map((r) => [r.body, !!r.asks])).toEqual([[q, false]])
    done()
  })

  it('resolve: a queued card is dropped, a working one runs to its end and is done, a failed one is done', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent('ok', { delay: 300 }))
    const w = say(root, dir, '@marver one', { frame: 'demo/a' })
    const q = say(root, dir, '@marver two', { frame: 'demo/b' })
    const run = jam.tick()
    await wait(120)
    resolve(dir, w.commentId!); resolve(dir, q.commentId!)
    await jam.poke()
    expect(cardOf(jam, q)!.state).toBe('dropped')
    expect(cardOf(jam, w)!.resolved).toBe(true)
    await run; jam.stop()
    expect([cardOf(jam, w)!.state, cardOf(jam, w)!.note]).toEqual(['done', 'replied'])
    expect(agentReplies(dir).length).toBe(1)
    const f = createJam(root, CFG, agent('ok', { fail: true }))
    const x = say(root, dir, '@marver three', { frame: 'demo/c' })
    await f.tick()
    resolve(dir, x.commentId!)
    await f.poke(); f.stop()
    expect(cardOf(f, x)!.state).toBe('done')
    done()
  })
})

describe('Jam V2: the brief is frozen at claim', () => {
  it('asks are the card\'s events; history is the rest of the thread - owner answers, agent replies, others as context, a dropped tag marked; an unledgered edit is not the owner\'s text', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent('ok', { delay: 300 }))
    const blocker = say(root, dir, '@marver first', { frame: 'demo/z' })
    const root1 = say(root, dir, 'this button')
    const synced = say(root, dir, 'from a teammate', { thread: root1.commentId, ledger: false })
    const answer = say(root, dir, 'the green one', { thread: root1.commentId })
    const dropped = say(root, dir, '@marver old ask', { thread: root1.commentId })
    edit(root, dir, answer, 'SPOOFED', false)          // synced edit: never the owner's words
    const run = jam.tick()
    await wait(120)
    const old = cardOf(jam, dropped)!
    expect((await jam.act(old.id, old.rev, 'drop')).ok).toBe(true)
    const ask = say(root, dir, '@marver do it now', { thread: root1.commentId })
    await jam.poke()
    await run; await jam.tick()
    const p = packets(root).find((x) => x.members[0].brief.asks[0].id === ask.id).members[0]
    // a reply, an edit after the claim never reach this job
    say(root, dir, 'after the claim', { thread: root1.commentId })
    expect(p.brief.asks.map((m: any) => m.body)).toEqual(['@marver do it now'])
    const hist = p.brief.history
    expect(hist.map((m: any) => m.body)).toEqual(['this button', 'from a teammate', 'the green one', '@marver old ask'])
    expect(hist.find((m: any) => m.id === synced.id).note).toBe('someone else - context only')
    expect(hist.find((m: any) => m.id === dropped.id).note).toBe('dropped - not an ask')
    expect(JSON.stringify(p)).not.toContain('nearby')
    expect(JSON.stringify(p)).not.toContain('after the claim')
    jam.stop()
    expect(cardOf(jam, blocker)!.state).toBe('done')
    done()
  })

  it('the prompt names the packet file, keeps the untrusted framing, and never sends the agent to the comment logs', () => {
    const packet = { v: 2 as const, kind: 'marver.jam.job' as const, batchId: 'b-1', frames: ['demo/a'], members: [] }
    const g = goalText(packet)
    expect(g).toContain(packetPath('b-1'))
    expect(g).toMatch(/UNTRUSTED/)
    expect(g).toContain('do not read design/comments/')
    expect(g).not.toMatch(/Read design\/comments\/<board>\.jsonl/)
    expect(goalText({ ...packet, exclusive: { files: ['design/scenes/demo/_kit.tsx'] } })).toContain('RUNS ALONE')
  })

  it('a packet over 1 MB (8 members, long threads) reaches the agent through its file; the prompt stays small', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent())
    const long = 'x'.repeat(4000)
    for (let i = 0; i < 8; i++) {
      const t = say(root, dir, `thread ${i}`)
      for (let k = 0; k < 40; k++) say(root, dir, long, { thread: t.commentId })
      say(root, dir, `@marver do ${i}`, { thread: t.commentId })
    }
    await jam.tick(); jam.stop()
    const p = packets(root)
    expect(p.length).toBe(1)
    expect(p[0].members.length).toBe(8)
    expect(JSON.stringify(p[0]).length).toBeGreaterThan(1_000_000)
    expect(goalText(p[0]).length).toBeLessThan(20_000)
    expect(jam.snapshot().cards.every((c) => c.state === 'done')).toBe(true)
    done()
  }, 30_000)
})

describe('Jam V2: one job per frame', () => {
  it('one batch per board and frame, up to 8 - a ninth waits; every member gets its own reply', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent())
    const tags = Array.from({ length: 9 }, (_, i) => say(root, dir, `@marver ask ${i}`))
    await jam.tick(); jam.stop()
    const p = packets(root)
    expect(p.map((x) => x.members.length)).toEqual([8, 1])
    expect(p[0].frames).toEqual(['demo/hero'])
    for (const t of tags) expect(cardOf(jam, t)!.state).toBe('done')
    expect(agentReplies(dir).length).toBe(9)
    expect(new Set(agentReplies(dir).map((r) => r.id)).size).toBe(9)
    done()
  })

  it('two boards sharing a frame never run at once', async () => {
    const { root, dir, done } = setup()
    const seq: boolean[] = []
    const jam = createJam(root, { ...CFG, concurrency: 4 }, agent('ok', { delay: 150 }), undefined, { work: (f, on) => { if (f === 'demo/hero') seq.push(on) } })
    say(root, dir, '@marver on home')
    say(root, dir, '@marver on other', { board: 'other' })
    await jam.tick(); jam.stop()
    expect(packets(root).length).toBe(2)
    expect(seq).toEqual([true, false, true, false])
    done()
  })

  it('a batch waits for a frame a `work start` holds, and runs once it is free', async () => {
    const { root, dir, done } = setup()
    let held = true
    const jam = createJam(root, CFG, agent(), undefined, { held: (f) => held && f === 'demo/hero', anyHold: () => held })
    const t = say(root, dir, '@marver go')
    await jam.tick()
    expect(cardOf(jam, t)!.state).toBe('queued')
    expect(jam.view().cards[0].waiting).toMatch(/held by your agent/)
    held = false
    await jam.tick(); jam.stop()
    expect(cardOf(jam, t)!.state).toBe('done')
    done()
  })

  it('work start: refused on a frame a batch holds, and for any new hold while an exclusive job waits; a hold renews', () => {
    const r = { frames: new Map([['demo/a', 'b1']]), exclusive: null as null | 'waiting' | 'running' }
    expect(refuseHold('demo/a', false, r)).toMatch(/Marver is working on this frame/)
    expect(refuseHold('demo/b', false, r)).toBeNull()
    r.exclusive = 'waiting'
    expect(refuseHold('demo/b', false, r)).toMatch(/shared file/)
    expect(refuseHold('demo/b', true, r)).toBeNull()
  })

  it('a CLI hold survives a restart: written with its expiry, restored - an expired one is not', () => {
    const { root, done } = setup()
    const a = createActivity()
    a.mark('demo/a', 60_000, 'cli')
    a.mark('demo/b', 60_000, 'jam')
    saveHolds(root, a)
    const b = createActivity()
    expect(restoreHolds(root, b)).toBe(1)
    expect(b.has('demo/a', 'cli')).toBe(true)
    expect(b.has('demo/b', 'jam')).toBe(false)
    writeFileSync(join(root, 'design', '.local', 'work-holds.json'), JSON.stringify({ 'demo/c': Date.now() - 1 }))
    expect(restoreHolds(root, createActivity())).toBe(0)
    done()
  })
})

describe('Jam V2: shared files and exclusive jobs', () => {
  it('a `shared` answer re-queues the member as exclusive - its rerun says so and names the file; a second `shared` fails visibly', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent('shared'))
    const t = say(root, dir, '@marver restyle every button')
    await jam.tick(); jam.stop()
    const p = packets(root)
    expect(p.length).toBe(2)
    expect(p[0].exclusive).toBeUndefined()
    expect(p[1].exclusive).toEqual({ files: ['design/scenes/demo/_kit.tsx'] })
    expect(goalText(p[1])).toContain('design/scenes/demo/_kit.tsx')
    expect([cardOf(jam, t)!.state, cardOf(jam, t)!.note]).toEqual(['failed', 'needed more shared files than it was given'])
    done()
  })

  it('a job that changed a shared file anyway says so under its reply; comment logs, the journal, boards and the manifest are not shared files', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent('ok', { touch: 'design/scenes/demo/_kit.tsx' }))
    say(root, dir, '@marver tweak')
    await jam.tick()
    expect(agentReplies(dir).at(-1)?.alsoChanged).toEqual(['design/scenes/demo/_kit.tsx'])
    for (const f of ['design/boards/home.json', 'design/manifest.json', 'design/.local/x.json']) {
      const j2 = createJam(root, CFG, agent('ok', { touch: f }))
      say(root, dir, '@marver again', { frame: `demo/${f.length}` })
      await j2.tick(); j2.stop()
      expect(agentReplies(dir).at(-1)?.alsoChanged).toBeUndefined()
    }
    jam.stop()
    done()
  })

  it('a board-level comment runs exclusive: it waits for every hold, and nothing new starts while it waits', async () => {
    const { root, dir, done } = setup()
    let held = true
    const jam = createJam(root, CFG, agent(), undefined, { held: (f) => held && f === 'demo/other', anyHold: () => held })
    const id = 'board-1'
    appendEvents(dir, 'home', [{ id, ts: tick(), type: 'create', commentId: id, board: 'home', author: OWNER, body: '@marver tidy the whole board' }])
    record(root, 'home', id)
    const framed = say(root, dir, '@marver small fix', { frame: 'demo/free' })
    await jam.tick()
    expect(jam.snapshot().cards.find((c) => c.events.includes(id))!.state).toBe('queued')
    expect(cardOf(jam, framed)!.state).toBe('queued')    // held back behind the exclusive job
    held = false
    await jam.tick(); jam.stop()
    const p = packets(root)
    expect(p[0].exclusive).toBeTruthy()
    expect(p[0].members[0].card).toBe(`c-${id}`)
    expect(cardOf(jam, framed)!.state).toBe('done')
    done()
  })

  it('a `shared` answer while the thread has a queued card merges into it - exclusive, rev bumped - also across a restart', () => {
    const { root, dir, done } = setup()
    const ctx = ctxFor(root)
    const j = readJournal(root)
    const now = Date.now()
    const base = { kind: 'comment' as const, board: 'home', frames: ['demo/hero'], thread: 't1', made: now, order: now, at: now }
    const failed: Card = { ...base, id: 'c-a', events: ['a'], state: 'failed', rev: 3, batch: 'b1' }
    const queued: Card = { ...base, id: 'c-b', events: ['b'], state: 'queued', rev: 1, exclusive: ['design/x.tsx'] }
    j.cards.push(failed, queued)
    expect(act(j, 'c-a', 3, 'retry').ok).toBe(true)
    expect(queued.events).toEqual(['a', 'b'])                 // the failed card's ask first: it was there first
    expect(queued.rev).toBe(2)
    expect(queued.exclusive).toEqual(['design/x.tsx'])
    expect([failed.state, failed.note]).toEqual(['done', 'merged into c-b'])
    expect(queued.follows).toBe('c-a')
    // a capture card always survives the merge, whichever was queued
    const cap: Card = { ...base, id: 'cap-1', kind: 'capture', capture: 'cap-1', events: [], state: 'failed', rev: 1, thread: 't1' }
    const q2: Card = { ...base, id: 'c-q', events: ['q'], state: 'queued', rev: 1, thread: 't1' }
    const k = merge(j, q2, cap, Date.now())
    expect(k.id).toBe('cap-1')
    expect(q2.state).toBe('done')
    writeJournal(root, j)
    expect(readJournal(root).cards.find((c) => c.id === 'c-b')?.events).toEqual(['a', 'b'])
    expect(ctx.root).toBe(root)
    done()
  })
})

describe('Jam V2: results first, then replies', () => {
  it('per-member parsing: missing members, unknown and duplicate blocks, a one-member job\'s unfenced reply', () => {
    const r = parseMembers('```marver-reply m2\nsecond\n```\n```marver-reply m9\nnobody\n```\n```marver-reply m2\nduplicate\n```', ['m1', 'm2'])
    expect(r).toEqual({ m1: { missing: true }, m2: { body: 'second', asks: false } })
    expect(parseMembers('```marver-reply m1 asks\nWhich?\n```', ['m1'])).toEqual({ m1: { body: 'Which?', asks: true } })
    expect(parseMembers('```marver-reply m1 shared design/a.tsx design/b.tsx\n```', ['m1'])).toEqual({ m1: { shared: ['design/a.tsx', 'design/b.tsx'] } })
    expect(parseMembers('Just done.', ['m1'])).toEqual({ m1: { body: 'Just done.', asks: false } })
    expect(parseMembers('```marver-reply ask\nCard or CVC?\n```', ['m1'])).toEqual({ m1: { body: 'Card or CVC?', asks: true } })
    expect(parseMembers('Just done.', ['m1', 'm2'])).toEqual({ m1: { missing: true }, m2: { missing: true } })
  })

  it('a member with no block fails with a note; Retry queues it', async () => {
    const { root, dir, done } = setup()
    const ids = ['ma', 'mb']
    const jam = createJam(root, CFG, agent({ [`c-${ids[1]}`]: 'missing' }))
    const a = say(root, dir, '@marver one', { id: ids[0] })
    const b = say(root, dir, '@marver two', { id: ids[1] })
    await jam.tick(); jam.stop()
    expect(cardOf(jam, a)!.state).toBe('done')
    const cb = cardOf(jam, b)!
    expect([cb.state, cb.note]).toEqual(['failed', 'the agent did not answer this one'])
    const again = createJam(root, CFG, agent())
    expect((await again.act(cb.id, cb.rev, 'retry')).ok).toBe(true)
    await again.tick(); again.stop()
    expect(cardOf(again, b)!.state).toBe('done')
    done()
  })

  const crashed = (root: string, dir: string) => {
    const a = say(root, dir, '@marver one')
    const b = say(root, dir, '@marver two')
    const j = readJournal(root)
    j.baselined = true
    j.seen = readLog(dir, 'home').map((e) => `home|${e.id}`)
    const now = Date.now()
    const card = (e: CommentEvent, m: string): Card => ({ id: `c-${e.id}`, kind: 'comment', board: 'home', frames: ['demo/hero'], thread: e.commentId, events: [e.id], state: 'working', batch: 'b-crash', made: e.ts, order: e.ts, rev: 2, at: now, brief: { asks: [], history: [] } })
    j.cards.push(card(a, 'm1'), card(b, 'm2'))
    const batch: Batch = { batchId: 'b-crash', members: [{ id: 'm1', card: `c-${a.id}`, board: 'home' }, { id: 'm2', card: `c-${b.id}`, board: 'home' }], frames: ['demo/hero'], state: 'claimed', leaseUntil: 0, attempts: 1, at: now }
    j.batches.push(batch)
    mkdirSync(join(root, 'design', '.local', 'jam', 'packets'), { recursive: true })
    writeFileSync(join(root, packetPath('b-crash')), JSON.stringify({ v: 2, kind: 'marver.jam.job', batchId: 'b-crash', frames: ['demo/hero'], members: [
      { id: 'm1', card: `c-${a.id}`, kind: 'comment', board: 'home', thread: a.commentId, frames: ['demo/hero'], brief: { asks: [{ id: a.id, body: '@marver one', ts: a.ts }], history: [] } },
      { id: 'm2', card: `c-${b.id}`, kind: 'comment', board: 'home', thread: b.commentId, frames: ['demo/hero'], brief: { asks: [{ id: b.id, body: '@marver two', ts: b.ts }], history: [] } },
    ] }))
    return { a, b, j, batch }
  }

  it('a crash after the results are written and one reply posted resumes by posting the rest - the agent never runs again', async () => {
    const { root, dir, done } = setup()
    const { a, b, j, batch } = crashed(root, dir)
    batch.results = { m1: { body: 'one done', asks: false, reanchors: [] }, m2: { body: 'two done', asks: false, reanchors: [] } }
    writeJournal(root, j)
    appendEvents(dir, 'home', [{ id: 'jam-b-crash-m1', ts: tick(), type: 'reply', commentId: 'jam-c-b-crash-m1', parentId: a.commentId, board: 'home', author: OWNER, body: 'one done', agent: true }])
    const jam = createJam(root, CFG, agent('ok', { touch: 'ran.marker' }))
    await jam.tick(); jam.stop()
    expect(existsSync(join(root, 'ran.marker'))).toBe(false)
    expect(agentReplies(dir).map((r) => r.body).sort()).toEqual(['one done', 'two done'])
    expect(cardOf(jam, a)!.state).toBe('done')
    expect(cardOf(jam, b)!.state).toBe('done')
    done()
  })

  it('a crash before the results reruns the agent on the same packet; a member whose ask is no longer ledgered is dropped at resume', async () => {
    const { root, dir, done } = setup()
    const { a, b, j } = crashed(root, dir)
    // b's ledger line never existed on this device (rewrite the ledger without it)
    const ledger = join(root, 'design', '.local', 'jam-ledger')
    writeFileSync(ledger, readFileSync(ledger, 'utf8').split('\n').filter((l) => !l.endsWith(`\t${b.id}`)).join('\n'))
    writeJournal(root, j)
    const jam = createJam(root, CFG, agent())
    await jam.tick(); jam.stop()
    expect(cardOf(jam, a)!.state).toBe('done')
    expect([cardOf(jam, b)!.state, cardOf(jam, b)!.note]).toEqual(['dropped', 'no longer authorized'])
    expect(packets(root).length).toBe(1)                     // the same packet file, rerun
    expect(packets(root)[0].batchId).toBe('b-crash')
    // ...holding only what is still the owner's: the dropped member never reaches the agent
    expect(packets(root)[0].members.map((m: any) => m.card)).toEqual([`c-${a.id}`])
    expect(agentReplies(dir).length).toBe(1)
    done()
  })
})

describe('Jam V2: marver marks - answered by you', () => {
  it('a plain reply after Marver spoke is listed until a brief covers it or the coding agent answers after it; an edit lists it again; a resolved thread never is', async () => {
    const { root, dir, done } = setup()
    const note = say(root, dir, 'Which badge?', { agent: true })
    const ans = say(root, dir, 'the pill', { thread: note.commentId })
    expect(answers(root).answered.map((a) => a.event)).toEqual([ans.id])
    // a done card on the thread does not hide it; a brief that copies it does
    const jam = createJam(root, CFG, agent())
    say(root, dir, '@marver go', { thread: note.commentId })
    await jam.tick(); jam.stop()
    expect(answers(root).answered).toEqual([])
    edit(root, dir, ans, 'the outline, actually')
    expect(answers(root).answered.map((a) => a.body)).toEqual(['the outline, actually'])
    // the coding agent answers after it (a CLI reply, not a jam job's)
    appendEvents(dir, 'home', [{ id: 'cli-1', ts: tick(), type: 'reply', commentId: 'cli-c1', parentId: note.commentId, board: 'home', author: OWNER, body: 'Done.', agent: true }])
    expect(answers(root).answered).toEqual([])
    const n2 = say(root, dir, 'Another?', { agent: true })
    say(root, dir, 'no', { thread: n2.commentId })
    expect(answers(root).answered.length).toBe(1)
    resolve(dir, n2.commentId!)
    expect(answers(root).answered).toEqual([])
    done()
  })

  it('a plain answer posted while the job runs and the job then finishing - still listed, also after a restart', async () => {
    const { root, dir, done } = setup()
    const note = say(root, dir, 'Ready?', { agent: true })
    const jam = createJam(root, CFG, agent('ok', { delay: 300 }))
    say(root, dir, '@marver go', { thread: note.commentId })
    const run = jam.tick()
    await wait(120)
    const mid = say(root, dir, 'also the footer', { thread: note.commentId })
    await run; jam.stop()
    expect(answers(root).answered.map((a) => a.event)).toEqual([mid.id])
    await createJam(root, CFG, agent()).tick()
    expect(answers(root).answered.map((a) => a.event)).toEqual([mid.id])
    done()
  })
})

describe('Jam V2: the v1 journal upgrade', () => {
  const v1 = (batches: JournalV1['batches'], seen: string[]): JournalV1 => ({ version: 1, device: deviceId(), baselined: true, seen, batches })
  const writeV1 = (root: string, j: JournalV1) => writeFileSync(join(root, 'design', '.local', 'jam-jobs.json'), JSON.stringify(j))

  it('a batch whose final reply is logged is reconciled (done or asks, never review); one with only an early reply, and one with none, turn failed with Retry', async () => {
    const { root, dir, done } = setup()
    const a = say(root, dir, '@marver one'), b = say(root, dir, '@marver two'), c = say(root, dir, '@marver three'), d = say(root, dir, '@marver four')
    appendEvents(dir, 'home', [
      { id: 'jam-v1a', ts: tick(), type: 'reply', commentId: 'jam-c-v1a', parentId: a.commentId, board: 'home', author: OWNER, body: 'Done.', agent: true },
      { id: 'jam-v1d', ts: tick(), type: 'reply', commentId: 'jam-c-v1d', parentId: d.commentId, board: 'home', author: OWNER, body: 'Which one?', asks: true, agent: true },
      { id: 'jam-e1-v1b', ts: tick(), type: 'reply', commentId: 'jam-c-e1-v1b', parentId: b.commentId, board: 'home', author: OWNER, body: 'On it.', agent: true },
    ])
    writeV1(root, v1([
      { batchId: 'v1a', board: 'home', memberEventIds: [a.id], state: 'claimed', leaseUntil: 0, attempts: 1 },
      { batchId: 'v1b', board: 'home', memberEventIds: [b.id], state: 'claimed', leaseUntil: 0, attempts: 1 },
      { batchId: 'v1c', board: 'home', memberEventIds: [c.id], state: 'pending', leaseUntil: 0, attempts: 0 },
      { batchId: 'v1d', board: 'home', memberEventIds: [d.id], state: 'claimed', leaseUntil: 0, attempts: 1 },
    ], [a.id, b.id, c.id, d.id]))
    const logs: string[] = []
    const jam = createJam(root, CFG, agent('ok', { touch: 'ran.marker' }), (m) => logs.push(m))
    await jam.tick(); jam.stop()
    expect(existsSync(join(root, 'ran.marker'))).toBe(false)
    expect([cardOf(jam, a)!.state, cardOf(jam, a)!.note]).toEqual(['done', 'replied'])
    expect(cardOf(jam, d)!.state).toBe('asks')
    for (const e of [b, c]) expect([cardOf(jam, e)!.state, cardOf(jam, e)!.note]).toEqual(['failed', 'interrupted by the upgrade - Retry'])
    expect(logs.some((l) => l.includes('only comments that tag @marver start work now'))).toBe(true)
    expect(jam.snapshot().version).toBe(2)
    done()
  })

  it('a v1 plain reply claimed behind another job becomes no card and stays on the answered list; one v1 took in is listed only as earlier, maybe handled', async () => {
    const { root, dir, done } = setup()
    const note = say(root, dir, 'Which?', { agent: true })
    const waiting = say(root, dir, 'the pill', { thread: note.commentId })
    const n2 = say(root, dir, 'And this?', { agent: true })
    const old = say(root, dir, 'yes', { thread: n2.commentId })
    writeV1(root, v1([{ batchId: 'v1w', board: 'home', memberEventIds: [waiting.id], state: 'claimed', leaseUntil: 0, attempts: 0 }], [note.id, waiting.id, n2.id, old.id]))
    const jam = createJam(root, CFG, agent())
    await jam.tick(); jam.stop()
    expect(jam.snapshot().cards).toEqual([])
    const out = answers(root)
    expect(out.answered.map((a) => a.event)).toEqual([waiting.id])
    expect(out.earlier.map((a) => a.event)).toEqual([old.id])
    done()
  })

  it('a journal from another machine starts fresh - everything already logged is seen, nothing runs', async () => {
    const { root, dir, done } = setup()
    const t = say(root, dir, '@marver old ask')
    writeV1(root, { ...v1([{ batchId: 'x', board: 'home', memberEventIds: [t.id], state: 'pending', leaseUntil: 0, attempts: 0 }], []), device: 'someone-else' })
    const jam = createJam(root, CFG, agent())
    await jam.tick(); jam.stop()
    expect(jam.snapshot().cards).toEqual([])
    expect(packets(root)).toEqual([])
    done()
  })
})

describe('Jam V2: the queue rules, unit', () => {
  it('ingest at claim: a tag and a resolve written just before a claim, before any watcher, are both seen', () => {
    const { root, dir, done } = setup()
    const ctx = ctxFor(root)
    const j = readJournal(root)
    j.baselined = true
    const a = say(root, dir, '@marver one', { frame: 'demo/a' })
    const b = say(root, dir, '@marver two', { frame: 'demo/b' })
    resolve(dir, b.commentId!)
    const fresh = ctxFor(root)
    ingest(j, fresh)
    const { batches } = form(j, fresh, { free: 4, running: new Set(), exclusiveRunning: false, held: () => false, anyHold: () => false })
    expect(batches.length).toBe(1)
    expect(batches[0].members[0].card).toBe(`c-${a.id}`)
    expect(j.cards.find((c) => c.id === `c-${b.id}`)?.state).toBe('dropped')
    expect(ctx.dir).toBe(dir)
    done()
  })
})

describe('Jam V2: what the status icon says', () => {
  const base = { id: 'c-1', kind: 'comment' as const, board: 'home', frames: ['demo/a'], events: ['e1'], rev: 1, made: 0, order: 0, at: 0 }
  const H = { claude: 'Claude Code' }
  it('queued: the position counts every queued card, the first reads next; joined tags and a held card say so', () => {
    expect(statusLines({ ...base, state: 'queued', position: 1 }, 'claude', H).head).toBe('Queued · next')
    expect(statusLines({ ...base, state: 'queued', position: 4 }, 'claude', H).head).toBe('Queued · 4th - runs after 3 others')
    expect(statusLines({ ...base, state: 'queued', position: 2, events: ['e1', 'e2'] }, 'claude', H).head).toBe('Queued · 2nd · 2 tags - runs after 1 other')
    expect(statusLines({ ...base, state: 'queued', position: 1, waiting: 'waiting - demo/a is held by your agent' }, 'claude', H).detail).toBe('waiting - demo/a is held by your agent')
  })
  it('working gives the clock and the agent; asks points at the question; failed gives why and the way back', () => {
    expect(statusLines({ ...base, state: 'working', at: 1000 }, 'claude', H, 42_000).head).toBe('Agent working · 0:41 - Claude Code')
    expect(statusLines({ ...base, state: 'asks' }, 'claude', H).head).toBe('Asks you - see the question below')
    const f = statusLines({ ...base, state: 'failed', note: 'the agent did not answer this one' }, 'claude', H)
    expect(f).toEqual({ head: 'Failed - the agent did not answer this one', detail: 'Retry here, or tag @marver again' })
  })
})

describe('Jam V2: review round 1 fixes', () => {
  it('a `shared` answer names only design source that is not a frame - never local state, logs, boards, the manifest, or a path out', () => {
    expect(sharedFile('design/scenes/pricing/_kit.tsx')).toBe('design/scenes/pricing/_kit.tsx')
    expect(sharedFile('./design/providers.tsx')).toBe('design/providers.tsx')
    for (const bad of ['design/.local/jam-ledger', '../../outside.txt', 'design/../x', 'design/comments/home.jsonl', 'design/boards/home.json',
      'design/manifest.json', 'design/scenes/pricing/hero.tsx', '/etc/passwd', 'src/app.ts', 'design//x'])
      expect(sharedFile(bad)).toBeNull()
    expect(parseMembers('```marver-reply m1 shared design/.local/jam-ledger ../x\n```', ['m1'])).toEqual({ m1: { missing: true } })
  })

  it('a resumed delivery posts no second copy of an early question, keeps the re-pins, and finds an answer written before the restart', async () => {
    const { root, dir, done } = setup()
    const t = say(root, dir, '@marver which?')
    const j = readJournal(root)
    j.baselined = true
    j.seen = readLog(dir, 'home').map((e) => `home|${e.id}`)
    const now = Date.now()
    j.cards.push({ id: `c-${t.id}`, kind: 'comment', board: 'home', frames: ['demo/hero'], thread: t.commentId, events: [t.id], state: 'working', batch: 'b-e', made: t.ts, order: t.ts, rev: 2, at: now })
    appendEvents(dir, 'home', [{ id: 'jam-e1-b-e', ts: tick(), type: 'reply', commentId: 'jam-c-e1-b-e', parentId: t.commentId, board: 'home', author: OWNER, body: 'Card or CVC?', agent: true }])
    const earlyTs = readLog(dir, 'home').find((e) => e.id === 'jam-e1-b-e')!.ts
    say(root, dir, 'card', { thread: t.commentId })                       // answered before the restart
    j.batches.push({ batchId: 'b-e', members: [{ id: 'm1', card: `c-${t.id}`, board: 'home' }], frames: ['demo/hero'], state: 'claimed', leaseUntil: 0, attempts: 1, at: now,
      results: { m1: { body: 'Card or CVC?', asks: true, reanchors: [] } }, early: { body: 'Card or CVC?', asks: false, commentId: 'jam-c-e1-b-e', ts: earlyTs },
      reanchors: [{ thread: t.commentId!, target: { on: 'Pay' } }] })
    writeJournal(root, j)
    const jam = createJam(root, CFG, agent('ok', { touch: 'ran.marker' }))
    await jam.tick(); jam.stop()
    expect(existsSync(join(root, 'ran.marker'))).toBe(false)
    expect(agentReplies(dir).map((r) => r.body)).toEqual(['Card or CVC?'])
    expect(readLog(dir, 'home').some((e) => e.type === 'reanchor' && e.commentId === t.commentId)).toBe(true)
    expect([cardOf(jam, t)!.state, cardOf(jam, t)!.note]).toEqual(['done', 'answered'])
    done()
  })

  it('an early ack that is already a fenced `m1 asks` block posts its words once, asking', async () => {
    const { root, dir, done } = setup()
    const block = '```marver-reply m1 asks\nPill or outline?\n```'
    const line1 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: block }] } })
    const line2 = JSON.stringify({ type: 'result', result: block })
    const script = `const L=${JSON.stringify([line1, line2])};process.stdout.write(L[0]+'\\n');setTimeout(()=>process.stdout.write(L[1]+'\\n'),100)`
    const a: JamAdapter = { name: 'claude', supportsSubagents: true, spawnArgs: () => ({ cmd: process.execPath, args: ['-e', script] }), parse: claudeAdapter.parse, earlyText: claudeAdapter.earlyText }
    const jam = createJam(root, CFG, a)
    const t = say(root, dir, '@marver the badge')
    await jam.tick(); jam.stop()
    expect(agentReplies(dir).map((r) => [r.body, r.asks])).toEqual([['Pill or outline?', true]])
    expect(cardOf(jam, t)!.state).toBe('asks')
    done()
  })

  it('a merge keeps what the failed run said; a brief keeps long text and long threads whole', () => {
    const { root, dir, done } = setup()
    const ctx = ctxFor(root)
    const j = readJournal(root)
    const now = Date.now()
    const base = { kind: 'comment' as const, board: 'home', frames: ['demo/hero'], thread: 't9', made: now, order: now, at: now }
    j.batches.push({ batchId: 'b-f', members: [{ id: 'm1', card: 'c-f', board: 'home', brief: { asks: [], history: [] } }], frames: [], state: 'failed', leaseUntil: 0, attempts: 2, at: now, note: 'the agent could not finish' })
    const failed: Card = { ...base, id: 'c-f', events: ['f'], state: 'failed', rev: 1, batch: 'b-f', brief: { asks: [{ id: 'f', body: '@marver x', ts: 1 }], history: [] } }
    const queued: Card = { ...base, id: 'c-q', events: ['q'], state: 'queued', rev: 1 }
    j.cards.push(failed, queued)
    act(j, 'c-f', 1, 'retry')
    const root1 = say(root, dir, 'root', { id: 't9' })
    const long = 'a'.repeat(9000) + ' ONLY IN RED'
    const ans = say(root, dir, long, { thread: root1.commentId })
    for (let i = 0; i < 50; i++) say(root, dir, `line ${i}`, { thread: root1.commentId })
    const brief = freezeBrief(j, ctxFor(root), queued, readLog(dir, 'home'))
    expect(brief.follows?.result).toBe('the agent could not finish')
    expect(brief.history.length).toBe(52)
    expect(brief.history.find((m) => m.id === ans.id)!.body.endsWith('ONLY IN RED')).toBe(true)
    expect(j.covered[ans.id]).toBe(ans.id)
    expect(ctx.root).toBe(root)
    done()
  })

  it('packet cleanup never removes the packet an unfinished batch needs', () => {
    const { root, done } = setup()
    writePacket(root, buildPacket('old-running', [], []))
    for (let i = 0; i < 55; i++) writePacket(root, buildPacket(`p-${i}`, [], []), new Set(['old-running']))
    expect(existsSync(join(root, packetPath('old-running')))).toBe(true)
    expect(existsSync(join(root, packetPath('p-0')))).toBe(false)
    done()
  })

  it('a card resolved while it ran and answering `shared` (or nothing) is done - it never runs again', () => {
    const j = readJournal(mkdtempSync(join(tmpdir(), 'mv-jamq-r-')))
    const now = Date.now()
    const c: Card = { id: 'c-r', kind: 'comment', board: 'home', frames: ['demo/a'], thread: 't', events: ['r'], state: 'working', batch: 'b-r', resolved: true, made: now, order: now, rev: 1, at: now }
    const b: Batch = { batchId: 'b-r', members: [{ id: 'm1', card: 'c-r', board: 'home' }], frames: ['demo/a'], state: 'claimed', leaseUntil: 0, attempts: 1, at: now, results: { m1: { shared: ['design/x.tsx'] } } }
    j.cards.push(c); j.batches.push(b)
    settle(j, b, {})
    expect([c.state, c.note, c.exclusive]).toEqual(['done', 'resolved', undefined])
  })

  it('the startup barrier: an orphan left running by a dead server is fenced before its batch runs again', async () => {
    const { root, dir, done } = setup()
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    orphan.unref()
    const t = say(root, dir, '@marver go')
    const j = readJournal(root)
    j.baselined = true
    j.seen = readLog(dir, 'home').map((e) => `home|${e.id}`)
    const now = Date.now()
    j.cards.push({ id: `c-${t.id}`, kind: 'comment', board: 'home', frames: ['demo/hero'], thread: t.commentId, events: [t.id], state: 'working', batch: 'b-o', made: t.ts, order: t.ts, rev: 2, at: now })
    j.batches.push({ batchId: 'b-o', members: [{ id: 'm1', card: `c-${t.id}`, board: 'home' }], frames: ['demo/hero'], state: 'claimed', leaseUntil: 0, attempts: 0, pgid: orphan.pid, at: now })
    mkdirSync(join(root, 'design', '.local', 'jam', 'packets'), { recursive: true })
    writeFileSync(join(root, packetPath('b-o')), JSON.stringify(buildPacket('b-o', [{ id: 'm1', card: `c-${t.id}`, kind: 'comment', board: 'home', thread: t.commentId, frames: ['demo/hero'], brief: { asks: [{ id: t.id, body: '@marver go', ts: t.ts }], history: [] } }], ['demo/hero'])))
    writeJournal(root, j)
    const jam = createJam(root, CFG, agent('ok', { orphan: orphan.pid }))
    await jam.tick(); jam.stop()
    expect(readFileSync(join(root, 'orphan.txt'), 'utf8')).toBe('dead')
    expect(cardOf(jam, t)!.state).toBe('done')
    done()
  })
})

describe('Jam V2: review round 2 fixes', () => {
  const crashed2 = (root: string, dir: string) => {
    const a = say(root, dir, '@marver one')
    const b = say(root, dir, '@marver two')
    const j = readJournal(root)
    j.baselined = true
    j.seen = readLog(dir, 'home').map((e) => `home|${e.id}`)
    const now = Date.now()
    const brief = (e: CommentEvent, rev = e.id) => ({ asks: [{ id: e.id, owner: true, rev, body: e.body!, ts: e.ts }], history: [] })
    const card = (e: CommentEvent): Card => ({ id: `c-${e.id}`, kind: 'comment', board: 'home', frames: ['demo/hero'], thread: e.commentId, events: [e.id], state: 'working', batch: 'b-2', made: e.ts, order: e.ts, rev: 2, at: now, brief: brief(e) })
    j.cards.push(card(a), card(b))
    j.batches.push({ batchId: 'b-2', members: [{ id: 'm1', card: `c-${a.id}`, board: 'home', brief: brief(a) }, { id: 'm2', card: `c-${b.id}`, board: 'home', brief: brief(b) }], frames: ['demo/hero'], state: 'claimed', leaseUntil: 0, attempts: 1, at: now })
    mkdirSync(join(root, 'design', '.local', 'jam', 'packets'), { recursive: true })
    const pm = (e: CommentEvent, id: string, rev = e.id) => ({ id, card: `c-${e.id}`, kind: 'comment' as const, board: 'home', thread: e.commentId, frames: ['demo/hero'], brief: brief(e, rev) })
    return { a, b, j, pm }
  }

  it('recovery checks each frozen revision too: an ask whose revision is not ledgered never reaches the agent, nor the journal briefs; the survivor is m1 again and answers as m1', async () => {
    const { root, dir, done } = setup()
    const { a, b, j, pm } = crashed2(root, dir)
    // a's packet copy names a revision that was never ledgered (a synced edit)
    writeFileSync(join(root, packetPath('b-2')), JSON.stringify(buildPacket('b-2', [pm(a, 'm1', 'synced-edit'), pm(b, 'm2')], ['demo/hero'])))
    j.cards[0].brief!.asks[0].rev = 'synced-edit'
    j.batches[0].members[0].brief!.asks[0].rev = 'synced-edit'
    writeJournal(root, j)
    const jam = createJam(root, CFG, agent())
    await jam.tick(); jam.stop()
    expect([cardOf(jam, a)!.state, cardOf(jam, a)!.note]).toEqual(['dropped', 'no longer authorized'])
    expect(cardOf(jam, a)!.brief!.asks).toEqual([])
    const seen = packets(root)
    expect(seen[0].members.map((m: any) => [m.id, m.card])).toEqual([['m1', `c-${b.id}`]])
    expect(cardOf(jam, b)!.state).toBe('done')
    done()
  })

  it('shared paths are checked on disk: a case alias of the board files, or a symlink into local state, is refused', () => {
    const { root, done } = setup()
    mkdirSync(join(root, 'design', 'boards'), { recursive: true })
    mkdirSync(join(root, 'design', 'scenes', 'demo'), { recursive: true })
    writeFileSync(join(root, 'design', 'scenes', 'demo', '_kit.tsx'), '')
    symlinkSync(join(root, 'design', '.local'), join(root, 'design', 'scenes', 'demo', '_link'))
    symlinkSync(tmpdir(), join(root, 'design', '_out'))
    expect(canonicalShared(root, 'design/scenes/demo/_kit.tsx')).toBe('design/scenes/demo/_kit.tsx')
    expect(canonicalShared(root, 'design/scenes/demo/_new-kit.tsx')).toBe('design/scenes/demo/_new-kit.tsx')   // not there yet: its folder decides
    expect(canonicalShared(root, 'design/BOARDS/home.json')).toBeNull()
    expect(canonicalShared(root, 'design/scenes/demo/_link/jam-ledger')).toBeNull()
    expect(canonicalShared(root, 'design/_out/x.ts')).toBeNull()
    done()
  })

  it('a delivery that breaks after the results are written is posted again - the agent never runs twice', async () => {
    const { root, dir, done } = setup()
    let broke = false
    const jam = createJam(root, CFG, agent('ok', { touch: 'runs.marker' }), undefined, { changed: () => { if (!broke) { broke = true; throw new Error('push failed') } } })
    const t = say(root, dir, '@marver go')
    await jam.tick()
    expect(cardOf(jam, t)!.state).toBe('working')
    for (let i = 0; i < 80 && cardOf(jam, t)!.state === 'working'; i++) await wait(100)
    jam.stop()
    expect(cardOf(jam, t)!.state).toBe('done')
    expect(packets(root).length).toBe(1)
    expect(agentReplies(dir).length).toBe(1)
    done()
  }, 20_000)

  it('an early ack that is the whole reply still says which shared file the job changed', async () => {
    const { root, dir, done } = setup()
    const script = `require('fs').mkdirSync('design/scenes/demo',{recursive:true});require('fs').writeFileSync('design/scenes/demo/_kit.tsx','x'+Date.now());process.stdout.write('FINAL\\n')`
    const oneShot: JamAdapter = {
      name: 'codex', supportsSubagents: false,
      spawnArgs: () => ({ cmd: process.execPath, args: ['-e', script] }),
      earlyText: (line) => (line.includes('FINAL') ? { text: '```marver-reply\nRestyled it.\n```' } : null),
      parse: () => ({ reply: 'Restyled it.', said: '```marver-reply\nRestyled it.\n```', asks: false, ok: true, reanchors: [] }),
    }
    const jam = createJam(root, { ...CFG, agent: 'codex' }, oneShot)
    say(root, dir, '@marver restyle')
    await jam.tick(); jam.stop()
    const replies = agentReplies(dir)
    expect(replies.length).toBe(1)
    expect(replies[0].alsoChanged).toEqual(['design/scenes/demo/_kit.tsx'])
    done()
  })

  it('the startup barrier: the orphan is fenced, a resumed batch waits for a restored hold, and the exclusive rerun of a `shared` result waits for every hold', async () => {
    const { root, dir, done } = setup()
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    orphan.unref()
    const held = new Set(['demo/b'])
    const s1 = say(root, dir, '@marver shared one', { frame: 'demo/a' })
    const o1 = say(root, dir, '@marver resume me', { frame: 'demo/b' })
    const j = readJournal(root)
    j.baselined = true
    j.seen = readLog(dir, 'home').map((e) => `home|${e.id}`)
    const now = Date.now()
    const card = (e: CommentEvent, batch: string, frame: string): Card => ({ id: `c-${e.id}`, kind: 'comment', board: 'home', frames: [frame], thread: e.commentId, events: [e.id], state: 'working', batch, made: e.ts, order: e.ts, rev: 2, at: now, brief: { asks: [{ id: e.id, owner: true, rev: e.id, body: e.body!, ts: e.ts }], history: [] } })
    j.cards.push(card(s1, 'b-s', 'demo/a'), card(o1, 'b-o', 'demo/b'))
    j.batches.push({ batchId: 'b-s', members: [{ id: 'm1', card: `c-${s1.id}`, board: 'home' }], frames: ['demo/a'], state: 'claimed', leaseUntil: 0, attempts: 1, at: now, results: { m1: { shared: ['design/scenes/demo/_kit.tsx'] } } })
    j.batches.push({ batchId: 'b-o', members: [{ id: 'm1', card: `c-${o1.id}`, board: 'home' }], frames: ['demo/b'], state: 'claimed', leaseUntil: 0, attempts: 0, pgid: orphan.pid, at: now })
    mkdirSync(join(root, 'design', '.local', 'jam', 'packets'), { recursive: true })
    writeFileSync(join(root, packetPath('b-o')), JSON.stringify(buildPacket('b-o', [{ id: 'm1', card: `c-${o1.id}`, kind: 'comment', board: 'home', thread: o1.commentId, frames: ['demo/b'], brief: { asks: [{ id: o1.id, owner: true, rev: o1.id, body: '@marver resume me', ts: o1.ts }], history: [] } }], ['demo/b'])))
    writeJournal(root, j)
    const jam = createJam(root, CFG, agent('ok', { orphan: orphan.pid }), undefined, { held: (f) => held.has(f), anyHold: () => held.size > 0 })
    await jam.tick()
    const gone = async () => { for (let i = 0; i < 40; i++) { try { process.kill(orphan.pid!, 0) } catch { return true } await wait(50) } return false }
    expect(await gone()).toBe(true)                                // fenced at boot, before anything
    expect(packets(root)).toEqual([])                              // the resumed batch waits for the hold; the exclusive rerun too
    expect(cardOf(jam, s1)!.exclusive).toEqual(['design/scenes/demo/_kit.tsx'])
    expect(cardOf(jam, s1)!.state).toBe('queued')
    held.clear()
    await jam.tick(); await jam.tick(); jam.stop()
    const order = packets(root).map((p) => p.members[0].card)
    expect(order).toEqual([`c-${o1.id}`, `c-${s1.id}`])            // the resumed one first, then the exclusive rerun alone
    expect(packets(root)[1].exclusive).toEqual({ files: ['design/scenes/demo/_kit.tsx'] })
    done()
  })
})

describe('Jam V2: review round 3 fixes', () => {
  it('a follow-up copies only earlier asks that are still the owner\'s - a lost ledger line, or a revision from another message, never comes through', () => {
    const { root, dir, done } = setup()
    const t = say(root, dir, 'root')
    const good = say(root, dir, '@marver keep me', { thread: t.commentId })
    const other = say(root, dir, 'another message', { thread: t.commentId })
    const otherEdit = edit(root, dir, other, 'its edit')
    const lost = say(root, dir, '@marver lost', { thread: t.commentId, ledger: false })
    const j = readJournal(root)
    const now = Date.now()
    j.cards.push({ id: 'c-old', kind: 'comment', board: 'home', frames: ['demo/hero'], thread: t.commentId, events: [good.id], state: 'done', made: now, order: now, rev: 1, at: now,
      brief: { asks: [{ id: good.id, rev: good.id, body: 'keep', ts: 1 }, { id: good.id, rev: otherEdit, body: 'stolen rev', ts: 1 }, { id: lost.id, rev: lost.id, body: 'lost', ts: 1 }], history: [] } })
    const next: Card = { id: 'c-new', kind: 'comment', board: 'home', frames: ['demo/hero'], thread: t.commentId, events: [], follows: 'c-old', state: 'queued', made: now, order: now, rev: 1, at: now }
    const brief = freezeBrief(j, ctxFor(root), next, readLog(dir, 'home'))
    expect(brief.follows!.asks.map((a) => a.body)).toEqual(['keep'])
    done()
  })

  it('a dangling symlink is never a shared file', () => {
    const { root, done } = setup()
    mkdirSync(join(root, 'design'), { recursive: true })
    symlinkSync(join(root, '.env.local'), join(root, 'design', '_kit.tsx'))
    expect(canonicalShared(root, 'design/_kit.tsx')).toBeNull()
    done()
  })

  it('a recovered batch whose posting fails at boot is posted again, and what it requeued (a `shared` rerun) then runs', async () => {
    const { root, dir, done } = setup()
    const t = say(root, dir, '@marver kit change', { frame: 'demo/a' })
    const j = readJournal(root)
    j.baselined = true
    j.seen = readLog(dir, 'home').map((e) => `home|${e.id}`)
    const now = Date.now()
    j.cards.push({ id: `c-${t.id}`, kind: 'comment', board: 'home', frames: ['demo/a'], thread: t.commentId, events: [t.id], state: 'working', batch: 'b-s', made: t.ts, order: t.ts, rev: 2, at: now })
    j.batches.push({ batchId: 'b-s', members: [{ id: 'm1', card: `c-${t.id}`, board: 'home' }], frames: ['demo/a'], state: 'claimed', leaseUntil: 0, attempts: 1, at: now, results: { m1: { shared: ['design/scenes/demo/_kit.tsx'] } } })
    // another job waiting on another frame: it must not start before the exclusive rerun exists
    const other = say(root, dir, '@marver unrelated', { frame: 'demo/z' })
    j.cards.push({ id: `c-${other.id}`, kind: 'comment', board: 'home', frames: ['demo/z'], thread: other.commentId, events: [other.id], state: 'queued', made: other.ts, order: other.ts, rev: 1, at: now })
    j.seen.push(`home|${other.id}`)
    writeJournal(root, j)
    let broke = false
    const jam = createJam(root, CFG, agent(), undefined, { changed: () => { if (!broke) { broke = true; throw new Error('push failed') } } })
    await jam.tick()
    for (let i = 0; i < 100 && packets(root).length === 0; i++) await wait(100)
    await jam.tick(); jam.stop()
    expect(packets(root).map((p) => [p.members[0].card, p.exclusive ?? null])).toEqual([[`c-${t.id}`, { files: ['design/scenes/demo/_kit.tsx'] }], [`c-${other.id}`, null]])
    expect(cardOf(jam, t)!.state).toBe('done')
    expect(cardOf(jam, other)!.state).toBe('done')
    done()
  }, 20_000)
})

describe('Jam V2: review round 4 fixes', () => {
  it('an exclusive card that is no longer the owner\'s is dropped and does not hold the queue back - ordinary cards run in the same pass', () => {
    const { root, dir, done } = setup()
    const j = readJournal(root)
    j.baselined = true
    const now = Date.now()
    appendEvents(dir, 'home', [{ id: 'gone-1', ts: tick(), type: 'create', commentId: 'gone-1', board: 'home', author: OWNER, body: '@marver whole board' }])   // never ledgered
    j.cards.push({ id: 'c-gone-1', kind: 'comment', board: 'home', frames: [], thread: 'gone-1', events: ['gone-1'], state: 'queued', made: now, order: now, rev: 1, at: now })
    const ok = say(root, dir, '@marver small', { frame: 'demo/a' })
    const ctx = ctxFor(root)
    ingest(j, ctx)
    const { batches, exclusiveWaiting } = form(j, ctx, { free: 3, running: new Set(), exclusiveRunning: false, held: () => false, anyHold: () => false })
    expect(j.cards.find((c) => c.id === 'c-gone-1')!.state).toBe('dropped')
    expect(batches.map((b) => b.members[0].card)).toEqual([`c-${ok.id}`])
    expect(exclusiveWaiting).toBe(false)
    done()
  })

  it('a merge keeps asks in the order they were made - the newest tag keeps the icon', () => {
    const j = readJournal(mkdtempSync(join(tmpdir(), 'mv-jamq-m-')))
    const now = Date.now()
    const older: Card = { id: 'c-old', kind: 'comment', board: 'home', frames: ['demo/a'], thread: 't', events: ['old'], state: 'failed', batch: 'b1', made: 100, order: 100, rev: 1, at: now }
    const newer: Card = { id: 'c-new', kind: 'comment', board: 'home', frames: ['demo/a'], thread: 't', events: ['new'], state: 'queued', made: 200, order: 200, rev: 1, at: now }
    j.cards.push(older, newer)
    const keep = merge(j, newer, older, now)
    expect(keep.id).toBe('c-new')
    expect(keep.events).toEqual(['old', 'new'])
  })
})

describe('Jam V2: review round 5 fixes', () => {
  const withResults = (root: string, dir: string) => {
    const t = say(root, dir, '@marver go', { frame: 'demo/a' })
    const j = readJournal(root)
    j.baselined = true
    j.seen = readLog(dir, 'home').map((e) => `home|${e.id}`)
    const now = Date.now()
    j.cards.push({ id: `c-${t.id}`, kind: 'comment', board: 'home', frames: ['demo/a'], thread: t.commentId, events: [t.id], state: 'working', batch: 'b-u', made: t.ts, order: t.ts, rev: 2, at: now })
    j.batches.push({ batchId: 'b-u', members: [{ id: 'm1', card: `c-${t.id}`, board: 'home' }], frames: ['demo/a'], state: 'claimed', leaseUntil: 0, attempts: 1, at: now, results: { m1: { body: 'Done, saved.', asks: false, reanchors: [] } } })
    writeJournal(root, j)
    return t
  }

  it('a post that keeps failing at boot fails its cards with the results kept; no new hold meanwhile; a restart posts them, and so does Retry - the agent never runs', async () => {
    const { root, dir, done } = setup()
    const t = withResults(root, dir)
    let failing = true
    const jam = createJam(root, CFG, agent('ok', { touch: 'ran.marker' }), undefined, { changed: () => { if (failing) throw new Error('push failed') } })
    const run = jam.tick()
    await wait(300)
    expect(refuseHold('demo/other', false)).toMatch(/finishing a job/)       // the barrier: no new hold while it settles
    await run
    const c = cardOf(jam, t)!
    expect([c.state, c.note]).toEqual(['failed', 'its replies could not be posted - Retry posts them'])
    expect(jam.snapshot().batches[0].state).toBe('claimed')
    failing = false
    const r = await jam.act(c.id, c.rev, 'retry')
    expect(r.ok).toBe(true)
    for (let i = 0; i < 40 && cardOf(jam, t)!.state !== 'done'; i++) await wait(100)
    jam.stop()
    expect(cardOf(jam, t)!.state).toBe('done')
    expect(existsSync(join(root, 'ran.marker'))).toBe(false)
    expect(agentReplies(dir).map((x) => x.body)).toEqual(['Done, saved.'])
    // and a restart reconciles one a previous boot gave up on
    const { root: r2, dir: d2, done: done2 } = setup()
    const t2 = withResults(r2, d2)
    const g = createJam(r2, CFG, agent(), undefined, { changed: () => { throw new Error('push failed') } })
    await g.tick(); g.stop()
    expect(cardOf(g, t2)!.state).toBe('failed')
    const h = createJam(r2, CFG, agent('ok', { touch: 'ran.marker' }))
    await h.tick(); h.stop()
    expect(cardOf(h, t2)!.state).toBe('done')
    expect(existsSync(join(r2, 'ran.marker'))).toBe(false)
    done(); done2()
  }, 30_000)

  it('a live batch whose post fails keeps its frames and holds back every new job and hold until it is posted', async () => {
    const { root, dir, done } = setup()
    let broke = false
    const jam = createJam(root, CFG, agent(), undefined, { changed: () => { if (!broke) { broke = true; throw new Error('push failed') } } })
    const a = say(root, dir, '@marver first', { frame: 'demo/a' })
    await jam.tick()
    expect(cardOf(jam, a)!.state).toBe('working')
    const b = say(root, dir, '@marver second', { frame: 'demo/b' })
    await jam.poke()
    expect(packets(root).length).toBe(1)                                       // the second waits for the first's post
    expect(jamReservations.frames.has('demo/a')).toBe(true)
    expect(refuseHold('demo/c', false)).toMatch(/finishing a job/)
    for (let i = 0; i < 100 && cardOf(jam, b)!.state !== 'done'; i++) { await wait(100); if (cardOf(jam, a)!.state === 'done') await jam.tick() }
    jam.stop()
    expect(cardOf(jam, a)!.state).toBe('done')
    expect(cardOf(jam, b)!.state).toBe('done')
    expect(packets(root).length).toBe(2)
    done()
  }, 20_000)

  it('asks merged across several cards stay in the order they were made, by each ask\'s own time', () => {
    const j = readJournal(mkdtempSync(join(tmpdir(), 'mv-jamq-m2-')))
    const now = Date.now()
    const card = (id: string, ev: string, t: number, state: Card['state']): Card => ({ id, kind: 'comment', board: 'home', frames: ['demo/a'], thread: 't', events: [ev], when: { [ev]: t }, state, batch: state === 'failed' ? 'b' : undefined, made: t, order: t, rev: 1, at: now })
    const A = card('c-a', 'a', 100, 'failed'), B = card('c-b', 'b', 200, 'failed'), C = card('c-c', 'c', 300, 'queued')
    j.cards.push(A, B, C)
    merge(j, C, A, now)
    merge(j, C, B, now)
    expect(C.events).toEqual(['a', 'b', 'c'])
  })
})

describe('Jam V2: review round 6 fixes', () => {
  it('a stopped daemon\'s pending retry never writes over the journal of the one that replaced it', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent(), undefined, { changed: () => { throw new Error('push failed') } })
    const a = say(root, dir, '@marver first', { frame: 'demo/a' })
    await jam.tick()                                                   // posting failed: a retry is pending
    jam.stop()
    const next = createJam(root, CFG, agent('ok', { delay: 3000 }))
    const b = say(root, dir, '@marver second', { frame: 'demo/b' })
    void next.tick()
    await wait(300)
    const cb = cardOf(next, b)!
    await next.act(cb.id, cb.rev, 'drop')                              // a no-op on a working card; just a write
    await wait(6000)                                                   // past the old daemon's first retry
    expect(readJournal(root).cards.find((c) => c.events.includes(b.id))?.state).toBe(cardOf(next, b)!.state)
    next.stop()
    expect(a.id).toBeTruthy()
    done()
  }, 20_000)

  it('when posting gives up, a `shared` answer still settles - its exclusive rerun exists before anything else may start', async () => {
    const { root, dir, done } = setup()
    const s1 = say(root, dir, '@marver kit', { frame: 'demo/a' })
    const t2 = say(root, dir, '@marver reply', { frame: 'demo/a' })
    const j = readJournal(root)
    j.baselined = true
    j.seen = readLog(dir, 'home').map((e) => `home|${e.id}`)
    const now = Date.now()
    const card = (e: CommentEvent): Card => ({ id: `c-${e.id}`, kind: 'comment', board: 'home', frames: ['demo/a'], thread: e.commentId, events: [e.id], state: 'working', batch: 'b-x', made: e.ts, order: e.ts, rev: 2, at: now })
    j.cards.push(card(s1), card(t2))
    j.batches.push({ batchId: 'b-x', members: [{ id: 'm1', card: `c-${s1.id}`, board: 'home' }, { id: 'm2', card: `c-${t2.id}`, board: 'home' }], frames: ['demo/a'], state: 'claimed', leaseUntil: 0, attempts: 1, at: now,
      results: { m1: { shared: ['design/scenes/demo/_kit.tsx'] }, m2: { body: 'Done.', asks: false, reanchors: [] } } })
    writeJournal(root, j)
    const jam = createJam(root, CFG, agent(), undefined, { changed: () => { throw new Error('push failed') }, held: () => false, anyHold: () => false })
    await jam.tick()
    await jam.tick(); jam.stop()
    expect(cardOf(jam, t2)!.state).toBe('failed')                        // its reply waits for Retry
    expect(cardOf(jam, s1)!.exclusive).toEqual(['design/scenes/demo/_kit.tsx'])
    expect(packets(root).map((p) => p.exclusive)).toEqual([{ files: ['design/scenes/demo/_kit.tsx'] }])   // the rerun ran, alone
    done()
  }, 20_000)
})

describe('Jam V2: review round 7 fixes', () => {
  it('a delivery in flight when the daemon stops never writes over its successor\'s journal', async () => {
    const { root, dir, done } = setup()
    const envelope = JSON.stringify({ result: 'Moved it.\n```marver-reanchor\n[{"thread":"T-1","on":"Pay"}]\n```' })
    const a: JamAdapter = { name: 'claude', supportsSubagents: true, spawnArgs: () => ({ cmd: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(envelope)})`] }), parse: claudeAdapter.parse }
    let release!: () => void
    let asked = false
    const old = createJam(root, CFG, a, undefined, { anchor: () => { asked = true; return new Promise((r) => { release = () => r({ ok: false, unchecked: 'later' }) }) } })
    appendEvents(dir, 'home', [{ id: 'T-1', ts: tick(), type: 'create', commentId: 'T-1', frame: 'demo/a', board: 'home', author: OWNER, body: '@marver move it' }])
    record(root, 'home', 'T-1')
    const run = old.tick()
    for (let i = 0; i < 50 && !asked; i++) await wait(100)
    old.stop()
    const next = createJam(root, CFG, agent('ok', { delay: 5000 }))
    const q = say(root, dir, '@marver queued one', { frame: 'demo/q' })
    const z = say(root, dir, '@marver another', { frame: 'demo/q2' })
    await next.poke()
    const cz = cardOf(next, z)!
    if (cz.state === 'queued') await next.act(cz.id, cz.rev, 'drop')
    const want = JSON.stringify(readJournal(root).cards.map((c) => [c.id, c.state]))
    release()
    await run.catch(() => {})
    await wait(300)
    expect(JSON.stringify(readJournal(root).cards.map((c) => [c.id, c.state]))).toBe(want)
    expect(readLog(dir, 'home').some((e) => e.type === 'reanchor')).toBe(false)   // nor the comment log
    next.stop()
    expect(q.id).toBeTruthy()
    done()
  }, 20_000)

  it('a recovery waiting between post attempts stops with its daemon - it never touches the reservations after', async () => {
    const { root, dir, done } = setup()
    const t = say(root, dir, '@marver go', { frame: 'demo/a' })
    const j = readJournal(root)
    j.baselined = true
    j.seen = readLog(dir, 'home').map((e) => `home|${e.id}`)
    const now = Date.now()
    j.cards.push({ id: `c-${t.id}`, kind: 'comment', board: 'home', frames: ['demo/a'], thread: t.commentId, events: [t.id], state: 'working', batch: 'b-n', made: t.ts, order: t.ts, rev: 2, at: now })
    j.batches.push({ batchId: 'b-n', members: [{ id: 'm1', card: `c-${t.id}`, board: 'home' }], frames: ['demo/a'], state: 'claimed', leaseUntil: 0, attempts: 1, at: now, results: { m1: { body: 'x', asks: false, reanchors: [] } } })
    writeJournal(root, j)
    const old = createJam(root, CFG, agent(), undefined, { changed: () => { throw new Error('push failed') } })
    const run = old.tick()
    await wait(300)
    old.stop()
    jamReservations.settling = true; jamReservations.frames.set('demo/z', 'successor')   // what a successor holds
    await run
    await wait(1500)
    expect(jamReservations.settling).toBe(true)
    expect(jamReservations.frames.get('demo/z')).toBe('successor')
    jamReservations.settling = false; jamReservations.frames.clear()
    done()
  }, 20_000)

  it('Retry on a member that never answered runs again - only a saved reply is posted again', async () => {
    const { root, dir, done } = setup()
    const a = say(root, dir, '@marver one', { frame: 'demo/a' })
    const b = say(root, dir, '@marver two', { frame: 'demo/a' })
    const j = readJournal(root)
    j.baselined = true
    j.seen = readLog(dir, 'home').map((e) => `home|${e.id}`)
    const now = Date.now()
    const card = (e: CommentEvent): Card => ({ id: `c-${e.id}`, kind: 'comment', board: 'home', frames: ['demo/a'], thread: e.commentId, events: [e.id], state: 'working', batch: 'b-mx', made: e.ts, order: e.ts, rev: 2, at: now, brief: { asks: [{ id: e.id, owner: true, rev: e.id, body: e.body!, ts: e.ts }], history: [] } })
    j.cards.push(card(a), card(b))
    j.batches.push({ batchId: 'b-mx', members: [{ id: 'm1', card: `c-${a.id}`, board: 'home' }, { id: 'm2', card: `c-${b.id}`, board: 'home' }], frames: ['demo/a'], state: 'claimed', leaseUntil: 0, attempts: 1, at: now,
      results: { m1: { body: 'one done', asks: false, reanchors: [] }, m2: { missing: true } } })
    writeJournal(root, j)
    let failing = true
    const jam = createJam(root, CFG, agent(), undefined, { changed: () => { if (failing) throw new Error('push failed') } })
    await jam.tick()
    expect(cardOf(jam, b)!.state).toBe('failed')
    expect(cardOf(jam, b)!.note).toBe('the agent did not answer this one')
    failing = false
    const cb = cardOf(jam, b)!
    await jam.act(cb.id, cb.rev, 'retry')
    await jam.tick(); jam.stop()
    expect(cardOf(jam, b)!.state).toBe('done')
    expect(packets(root).map((p) => p.members.map((m: any) => m.card))).toEqual([[`c-${b.id}`]])   // it really ran
    done()
  }, 30_000)

  it('an early question answered while the job runs is recognised whatever words the final question uses', async () => {
    const { root, dir, done } = setup()
    const line1 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Pill or outline?' }] } })
    const line2 = JSON.stringify({ type: 'result', result: '```marver-reply ask\nShould I use the pill style?\n```' })
    const script = `const L=${JSON.stringify([line1, line2])};process.stdout.write(L[0]+'\\n');setTimeout(()=>process.stdout.write(L[1]+'\\n'),500)`
    const a: JamAdapter = { name: 'claude', supportsSubagents: true, spawnArgs: () => ({ cmd: process.execPath, args: ['-e', script] }), parse: claudeAdapter.parse, earlyText: claudeAdapter.earlyText }
    const jam = createJam(root, CFG, a)
    const t = say(root, dir, '@marver the badge')
    const run = jam.tick()
    await wait(300)
    say(root, dir, 'pill', { thread: t.commentId })
    await run; jam.stop()
    expect([cardOf(jam, t)!.state, cardOf(jam, t)!.note]).toEqual(['done', 'answered'])
    expect(agentReplies(dir).map((r) => !!r.asks)).toEqual([false, false])
    done()
  })
})

describe('Jam V2: review round 8 fixes', () => {
  it('the upgrade keeps finished and failed v1 batches: a logged question still asks, a failed tag keeps Retry', async () => {
    const { root, dir, done } = setup()
    const a = say(root, dir, '@marver one'), b = say(root, dir, '@marver two')
    appendEvents(dir, 'home', [{ id: 'jam-vd', ts: tick(), type: 'reply', commentId: 'jam-c-vd', parentId: a.commentId, board: 'home', author: OWNER, body: 'Which?', asks: true, agent: true }])
    writeFileSync(join(root, 'design', '.local', 'jam-jobs.json'), JSON.stringify({ version: 1, device: deviceId(), baselined: true, seen: [a.id, b.id], batches: [
      { batchId: 'vd', board: 'home', memberEventIds: [a.id], state: 'done', leaseUntil: 0, attempts: 1 },
      { batchId: 'vf', board: 'home', memberEventIds: [b.id], state: 'failed', leaseUntil: 0, attempts: 2 },
    ] }))
    const jam = createJam(root, CFG, agent('ok', { touch: 'ran.marker' }))
    await jam.tick(); jam.stop()
    expect(cardOf(jam, a)!.state).toBe('asks')
    expect([cardOf(jam, b)!.state, cardOf(jam, b)!.note]).toEqual(['failed', 'the agent could not finish - Retry'])
    expect(existsSync(join(root, 'ran.marker'))).toBe(false)
    done()
  })

  it('Retry on a follow-up reads its own failed run, not the card it follows', () => {
    const { root, dir, done } = setup()
    const t = say(root, dir, 'root')
    const qa = say(root, dir, '@marver first', { thread: t.commentId })
    const qb = say(root, dir, '@marver second', { thread: t.commentId })
    const j = readJournal(root)
    const now = Date.now()
    j.batches.push({ batchId: 'bA', members: [{ id: 'm1', card: 'cA', board: 'home', brief: { asks: [{ id: qa.id, rev: qa.id, body: 'first', ts: 1 }], history: [] } }], frames: [], state: 'done', leaseUntil: 0, attempts: 1, at: now, results: { m1: { body: 'A says', asks: false, reanchors: [] } } })
    j.batches.push({ batchId: 'bB', members: [{ id: 'm1', card: 'cB', board: 'home', brief: { asks: [{ id: qb.id, rev: qb.id, body: 'second', ts: 2 }], history: [] } }], frames: [], state: 'failed', leaseUntil: 0, attempts: 2, at: now, note: 'boom' })
    j.cards.push({ id: 'cA', kind: 'comment', board: 'home', frames: [], thread: t.commentId, events: [qa.id], state: 'done', batch: 'bA', made: 1, order: 1, rev: 1, at: now, brief: { asks: [{ id: qa.id, rev: qa.id, body: 'first', ts: 1 }], history: [] } })
    j.cards.push({ id: 'cB', kind: 'comment', board: 'home', frames: [], thread: t.commentId, events: [qb.id], follows: 'cA', state: 'failed', batch: 'bB', made: 2, order: 2, rev: 1, at: now })
    act(j, 'cB', 1, 'retry')
    const brief = freezeBrief(j, ctxFor(root), j.cards.find((c) => c.id === 'cB')!, readLog(dir, 'home'))
    expect(brief.follows).toEqual({ asks: [{ id: qb.id, rev: qb.id, body: 'second', ts: 2 }], result: 'boom' })
    done()
  })

  it('a tag that joins a queued follow-up still answers the card that asks (and retries one that failed)', () => {
    const { root, dir, done } = setup()
    const t = say(root, dir, 'root')
    const j = readJournal(root)
    j.baselined = true
    j.seen = readLog(dir, 'home').map((e) => `home|${e.id}`)
    const now = Date.now()
    j.cards.push({ id: 'cA', kind: 'comment', board: 'home', frames: ['demo/hero'], thread: t.commentId, events: ['x'], state: 'asks', batch: 'b', made: 1, order: 1, rev: 1, at: now })
    j.cards.push({ id: 'cB', kind: 'comment', board: 'home', frames: ['demo/hero'], thread: t.commentId, events: ['y'], follows: 'cA', state: 'queued', made: 2, order: 2, rev: 1, at: now })
    const c = say(root, dir, '@marver the pill', { thread: t.commentId })
    ingest(j, ctxFor(root))
    expect([j.cards[0].state, j.cards[0].note]).toEqual(['done', 'answered'])
    expect(j.cards[1].events).toEqual(['y', c.id])
    expect(j.cards.length).toBe(2)
    done()
  })
})

describe('Jam V2: review round 9 fixes', () => {
  it('the upgrade reads an early reply as the final of a finished v1 batch, and a question already answered is done', async () => {
    const { root, dir, done } = setup()
    const a = say(root, dir, '@marver one'), b = say(root, dir, '@marver two')
    appendEvents(dir, 'home', [
      // as v1 wrote it: the early line not asking, then an edit that flags it a question
      { id: 'jam-e1-va', ts: tick(), type: 'reply', commentId: 'jam-c-e1-va', parentId: a.commentId, board: 'home', author: OWNER, body: 'Card or CVC?', asks: false, agent: true },
      { id: 'jam-f-e1-va', ts: tick(), type: 'edit', commentId: 'jam-c-e1-va', asks: true, board: 'home', author: OWNER, agent: true },
      { id: 'jam-vb', ts: tick(), type: 'reply', commentId: 'jam-c-vb', parentId: b.commentId, board: 'home', author: OWNER, body: 'Which one?', asks: true, agent: true },
    ])
    const ans = say(root, dir, 'the first', { thread: b.commentId })
    writeFileSync(join(root, 'design', '.local', 'jam-jobs.json'), JSON.stringify({ version: 1, device: deviceId(), baselined: true, seen: [a.id, b.id, ans.id], batches: [
      { batchId: 'va', board: 'home', memberEventIds: [a.id], state: 'done', leaseUntil: 0, attempts: 1 },
      { batchId: 'vb', board: 'home', memberEventIds: [b.id], state: 'done', leaseUntil: 0, attempts: 1 },
    ] }))
    const jam = createJam(root, CFG, agent())
    await jam.tick(); jam.stop()
    expect(cardOf(jam, a)!.state).toBe('asks')
    expect([cardOf(jam, b)!.state, cardOf(jam, b)!.note]).toEqual(['done', 'answered'])
    done()
  })

  it('an early line streamed after stop() is never posted', async () => {
    const { root, dir, done } = setup()
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } })
    const script = `setTimeout(()=>process.stdout.write(${JSON.stringify(line)}+'\\n'),400);setTimeout(()=>{},2000)`
    const a: JamAdapter = { name: 'claude', supportsSubagents: true, spawnArgs: () => ({ cmd: process.execPath, args: ['-e', script] }), parse: claudeAdapter.parse, earlyText: claudeAdapter.earlyText }
    const jam = createJam(root, CFG, a)
    say(root, dir, '@marver go')
    void jam.tick()
    await wait(150)
    jam.stop()
    await wait(800)
    expect(agentReplies(dir)).toEqual([])
    done()
  })
})
