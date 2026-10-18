import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendEvents, readLog, replay, type CommentEvent } from '../src/server/comments.ts'
import { createJam } from '../src/server/jam/daemon.ts'
import { claudeAdapter } from '../src/server/jam/adapter/claude.ts'
import { has, record } from '../src/server/jam/ledger.ts'
import { read as readJournal, write as writeJournal } from '../src/server/jam/journal.ts'
import { addPicture, checkRecord, factsOf, picturePath, readCapture } from '../src/server/jam/capture.ts'
import { payloadKey } from '../src/server/jam/queue.ts'
import type { CaptureRecord, JamAdapter } from '../src/server/jam/types.ts'
import type { JamConfig } from '../src/server/config.ts'

const CFG: JamConfig = { agent: 'claude', concurrency: 3, subagents: true, proactive: false, chime: true, capture: 'confirm', loc: true }
const AGENT = fileURLToPath(new URL('./fixtures/jam-agent.cjs', import.meta.url))
const OWNER = { email: 'nic@local', name: 'Nic' }
const agent = (mode: unknown = 'ok', opts: Record<string, unknown> = {}): JamAdapter => ({
  name: 'claude', supportsSubagents: true,
  spawnArgs(goal) {
    const file = /design\/\.local\/jam\/packets\/[\w-]+\.json/.exec(goal)![0]
    return { cmd: process.execPath, args: [AGENT, file], env: { MODE: JSON.stringify(mode), OPTS: JSON.stringify(opts) } }
  },
  parse: claudeAdapter.parse,
})
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'mv-jamc-'))
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify(OWNER))
  return { root, dir: join(root, 'design', 'comments'), done: () => rmSync(root, { recursive: true, force: true }) }
}
let n = 0
const capId = () => `cap-${Date.now() + n++}-${Math.random().toString(36).slice(2, 8)}`
/** A capture as the shell seals it: words, a pick on demo/a, a note, a UI step. */
const rec = (o: Partial<CaptureRecord> & { words?: string } = {}): CaptureRecord => {
  const id = o.id ?? capId()
  const t0 = 1_000_000
  return {
    format: 'marver.jam.capture', v: 1, id,
    context: { canvas: 'test', board: 'home', ...(o.context ?? {}) },
    view: { board: 'home', frames: ['demo/a'], theme: 'light' },
    timeline: o.timeline ?? [
      { at: t0, event: 'view', view: { frames: ['demo/a'] } },
      { at: t0 + 1000, event: 'words', text: o.words ?? 'this badge should match the plan badge' },
      { at: t0 + 2000, frame: 'demo/a', event: 'pick', point: 1, mode: 'canvas', bundle: { tag: 'span', quote: 'Save 20%', source: 'design/scenes/demo/a.tsx:4:7' } },
      { at: t0 + 3000, event: 'note', text: 'the outline one' },
      { at: t0 + 4000, event: 'theme', theme: 'dark' },
    ],
    pictures: o.pictures ?? [],
  }
}
const packets = (root: string) => existsSync(join(root, 'packets-seen.jsonl'))
  ? readFileSync(join(root, 'packets-seen.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
const card = (jam: { snapshot(): any }, id: string) => jam.snapshot().cards.find((c: any) => c.id === id)
const agentReplies = (dir: string) => replay(readLog(dir, 'home')).flatMap((t) => t.replies.filter((r) => r.agent))
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
let clock = Date.now()
const tick = () => (clock = Math.max(clock + 10, Date.now()))

describe('captures: the sealed record', () => {
  it('a record is checked: shape, id, board; a category anywhere is refused; steps are typed', () => {
    expect(typeof checkRecord(rec())).toBe('object')
    expect(checkRecord({ ...rec(), kind: 'issue' })).toBe('a capture has no category')
    expect(checkRecord({ ...rec(), id: 'cap-../x' })).toBe('bad capture id')
    expect(checkRecord({ ...rec(), context: { canvas: 'x', board: '../etc' } })).toBe('bad board')
    const r = checkRecord({ ...rec(), timeline: [{ at: 1, event: 'evil', x: 1 }, { at: 2, event: 'note', text: 'kept' }] }) as CaptureRecord
    expect(r.timeline).toEqual([{ at: 2, event: 'note', text: 'kept' }])
    expect(factsOf(rec())).toBe('0:04 · 1 point · 1 note')
  })

  it('posting a capture stores it once and makes a draft; a different record under its id is refused; an edit is kept through a restart', async () => {
    const { root, done } = setup()
    const jam = createJam(root, CFG, agent())
    const r = rec()
    const a = await jam.capture(r)
    expect([a.ok, a.card?.state, a.card?.kind]).toEqual([true, 'draft', 'capture'])
    expect(a.card?.frames).toEqual(['demo/a'])
    expect((await jam.capture(r)).card?.rev).toBe(a.card?.rev)                       // the same post twice: one card
    expect((await jam.capture({ ...r, timeline: [] })).error).toMatch(/different capture/)
    expect((await jam.act(r.id, a.card!.rev, 'edit', 'make the badge outlined')).ok).toBe(true)
    jam.stop()
    const again = createJam(root, CFG, agent())
    expect(card(again, r.id).payload.edited).toBe('make the badge outlined')
    expect(card(again, r.id).events).toEqual([])
    again.stop()
    done()
  })
})

describe('captures: confirm, and the thread it becomes', () => {
  it('confirm writes one owner comment pinned on the first pick - a capture block that never makes a card of its own - and queues the capture; the job reviews', async () => {
    const { root, dir, done } = setup()
    const shots: string[] = []
    const jam = createJam(root, CFG, agent(), undefined, {
      anchor: async (frame, target) => ({ ok: true, anchor: { el: { semantics: { quote: target.on } } }, holders: [], viewport: 'laptop', theme: 'light' }),
      shoot: async (frame, theme, entry) => { shots.push(`${frame}:${theme}:${entry.batch ? 'batch' : 'cap'}`); return `p-${'0'.repeat(15)}${shots.length}` },
    })
    const r = rec({ words: 'please @marver make this match' })
    const a = await jam.capture(r)
    const c = await jam.act(r.id, a.card!.rev, 'confirm')
    expect(c.ok).toBe(true)
    const ev = readLog(dir, 'home').find((e) => e.id === `cap-${r.id}-e`)!
    expect(ev.capture).toBe(r.id)
    expect(ev.facts).toBe('0:04 · 1 point · 1 note')
    expect(ev.frame).toBe('demo/a')
    expect(ev.anchor).toEqual({ el: { semantics: { quote: 'Save 20%' } } })
    expect(ev.body).toBe('please @marver make this match (note) the outline one')
    expect(has(root, 'home', ev.id)).toBe(true)
    await jam.tick(); jam.stop()
    // the comment made no card of its own, though its words tag @marver
    expect(jam.snapshot().cards.filter((x: any) => x.kind === 'comment')).toEqual([])
    const k = card(jam, r.id)
    expect([k.state, k.thread]).toEqual(['review', `cap-${r.id}`])
    const p = packets(root)[0]
    expect(p.members[0].kind).toBe('capture')
    expect(p.members[0].brief.capture.record.id).toBe(r.id)
    expect(JSON.stringify(p)).not.toContain('"kind":"issue"')
    expect(shots).toEqual(['demo/a:light:batch', 'demo/a:light:batch'])         // before and after, while it held the frame
    expect(jam.snapshot().batches[0].shots).toEqual([{ frame: 'demo/a', before: 'p-0000000000000001', after: 'p-0000000000000002' }])
    expect(agentReplies(dir)[0].body).toContain('Done:')
    done()
  })

  it('a long capture\'s comment is cut at 600 characters; the full text stays in the record', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent())
    const r = rec({ words: 'word '.repeat(300) })
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'confirm')
    jam.stop()
    const ev = readLog(dir, 'home').find((e) => e.id === `cap-${r.id}-e`)!
    expect(ev.body!.length).toBe(600)
    expect(readCapture(root, r.id)!.record.timeline.find((s) => s.event === 'words')).toBeTruthy()
    done()
  })

  it('confirm is idempotent: a crash after the step began resumes to one comment and one queued card; a retried request answers with the card', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent())
    const r = rec()
    const a = await jam.capture(r)
    jam.stop()
    // a crash between "step recorded" and "comment written": the journal holds the pending comment
    const j = readJournal(root)
    const c = j.cards.find((x) => x.id === r.id)!
    c.state = 'confirming'; c.rev += 1
    c.pending = { op: 'confirm', end: 'queued', event: { id: `cap-${r.id}-e`, ts: 5, type: 'create', commentId: `cap-${r.id}`, board: 'home', author: OWNER, body: 'resumed', capture: r.id } }
    writeJournal(root, j)
    const again = createJam(root, CFG, agent('ok', { delay: 2000 }))
    void again.tick()
    await wait(400)
    expect(card(again, r.id).state).toMatch(/queued|working/)
    expect(readLog(dir, 'home').filter((e) => e.id === `cap-${r.id}-e`).length).toBe(1)
    const retried = await again.act(r.id, a.card!.rev, 'confirm')                          // the lost answer, asked again
    expect([retried.ok, retried.card?.thread]).toEqual([true, `cap-${r.id}`])
    expect(readLog(dir, 'home').filter((e) => e.id === `cap-${r.id}-e`).length).toBe(1)
    again.stop()
    done()
  })

  it('confirm fails closed when another comment already holds its id: nothing ledgered, the draft stays a draft and says so', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent())
    const r = rec()
    const a = await jam.capture(r)
    appendEvents(dir, 'home', [{ id: `cap-${r.id}-e`, ts: tick(), type: 'create', commentId: `cap-${r.id}`, board: 'home', author: { name: 'Mallory' }, body: 'not yours' }])
    const c = await jam.act(r.id, a.card!.rev, 'confirm')
    jam.stop()
    expect(c.ok).toBe(false)
    expect(card(jam, r.id).state).toBe('draft')
    expect(card(jam, r.id).note).toMatch(/conflicting comment/)
    expect(has(root, 'home', `cap-${r.id}-e`)).toBe(false)
    done()
  })

  it('Keep from the read-back: its comment posts, it is kept, never queued; a capture file edited after confirm stops the job', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent())
    const k = rec()
    const a = await jam.capture(k)
    const kept = await jam.act(k.id, a.card!.rev, 'keep')
    expect([kept.ok, kept.card?.state]).toEqual([true, 'kept'])
    expect(readLog(dir, 'home').some((e) => e.id === `cap-${k.id}-e`)).toBe(true)
    // edited after confirm: refused at claim
    const x = rec()
    const b = await jam.capture(x)
    jam.stop()
    const j2 = createJam(root, { ...CFG, concurrency: 1 }, agent())
    const conf = await j2.act(x.id, b.card!.rev, 'confirm')
    expect(conf.ok).toBe(true)
    const file = join(root, 'design', '.local', 'jam', 'captures', `${x.id}.json`)
    writeFileSync(file, readFileSync(file, 'utf8').replace('Save 20%', 'Save 90%'))
    await j2.tick(); j2.stop()
    expect(card(j2, x.id).state).toBe('failed')
    expect(packets(root)).toEqual([])
    expect(card(j2, k.id).state).toBe('kept')
    done()
  })
})

describe('captures: review', () => {
  const reviewed = async (root: string) => {
    const jam = createJam(root, CFG, agent())
    const r = rec()
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'confirm')
    await jam.tick()
    return { jam, r }
  }

  it('Looks good: done and its thread resolved; with a plain answer written after its brief, the thread stays open', async () => {
    const { root, dir, done } = setup()
    const { jam, r } = await reviewed(root)
    const c = card(jam, r.id)
    expect(c.state).toBe('review')
    expect((await jam.act(r.id, c.rev, 'good')).ok).toBe(true)
    expect(replay(readLog(dir, 'home')).find((t) => t.id === `cap-${r.id}`)!.resolved).toBe(true)
    expect(card(jam, r.id).state).toBe('done')
    // a second one, answered plainly after its brief
    const s = rec()
    const b = await jam.capture(s)
    await jam.act(s.id, b.card!.rev, 'confirm')
    await jam.tick()
    const id = `pl-${Math.random()}`
    appendEvents(dir, 'home', [{ id, ts: Date.now() + 5, type: 'reply', commentId: `c-${id}`, parentId: `cap-${s.id}`, board: 'home', author: OWNER, body: 'also the footer' }])
    record(root, 'home', id)
    await jam.act(s.id, card(jam, s.id).rev, 'good')
    jam.stop()
    expect(card(jam, s.id).state).toBe('done')
    expect(replay(readLog(dir, 'home')).find((t) => t.id === `cap-${s.id}`)!.resolved).toBe(false)
    done()
  })

  it('More work posts one @marver reply that mints no tag card: the SAME capture card goes first again, its finished run in `ran`; a queued tag merges into it', async () => {
    const { root, dir, done } = setup()
    const { jam, r } = await reviewed(root)
    // a tag written in the capture's thread since the review: queued (one slot, busy elsewhere)
    const rev = card(jam, r.id).rev                                  // the snapshot is live: keep the number
    const more = await jam.act(r.id, rev, 'more', 'and the hover state')
    expect(more.ok).toBe(true)
    const mw = readLog(dir, 'home').find((e) => e.id === `mw-${r.id}-${rev}`)!
    expect(mw.body).toBe('@marver and the hover state')
    expect(has(root, 'home', mw.id)).toBe(true)
    await jam.tick(); jam.stop()
    expect(jam.snapshot().cards.filter((x: any) => x.kind === 'comment')).toEqual([])
    const k = card(jam, r.id)
    expect(k.ran.length).toBe(1)
    expect(k.state).toBe('review')
    const p = packets(root)[1].members[0]
    expect(p.brief.asks.map((x: any) => x.body)).toEqual(['@marver and the hover state'])
    expect(p.brief.follows.result).toContain('Done:')
    expect(p.brief.capture.record.id).toBe(r.id)
    done()
  })

  it('a capture made during a review binds the run on screen: confirming it sends that review back as More work, with no @marver reply; its payload keeps the reviewed ask and result', async () => {
    const { root, dir, done } = setup()
    const { jam, r } = await reviewed(root)
    const c = card(jam, r.id)
    const during = rec({ context: { canvas: 'test', board: 'home', reviewing: { card: r.id, batch: c.batch, rev: c.rev } } })
    const a = await jam.capture(during)
    expect(a.card?.follows).toBe(r.id)
    await jam.act(during.id, a.card!.rev, 'confirm')
    jam.stop()
    expect([card(jam, r.id).state, card(jam, r.id).note]).toEqual(['done', 'more work'])
    expect(readLog(dir, 'home').some((e) => e.id.startsWith('mw-'))).toBe(false)
    const d = card(jam, during.id)
    expect(d.payload.reviewed.result).toContain('Done:')
    expect(d.payload.reviewed.asks).toEqual([])                                                     // a capture's asks are its payload
    done()
  })

  it('a tag in a capture\'s thread carries the capture - every frame, its payload; a kept capture is context, "kept - not an ask"', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent())
    const r = rec({ timeline: [
      { at: 1, event: 'words', text: 'both' },
      { at: 2, frame: 'demo/a', event: 'pick', mode: 'canvas', bundle: { quote: 'A' } },
      { at: 3, frame: 'demo/b', event: 'click', mode: 'canvas', bundle: { quote: 'B' } },
    ] })
    const a = await jam.capture(r)
    expect(a.card?.frames).toEqual(['demo/a', 'demo/b'])
    await jam.act(r.id, a.card!.rev, 'keep')
    const id = `t-${Math.random().toString(36).slice(2)}`
    appendEvents(dir, 'home', [{ id, ts: Date.now(), type: 'reply', commentId: `c-${id}`, parentId: `cap-${r.id}`, board: 'home', author: OWNER, body: '@marver do this one after all' }])
    record(root, 'home', id)
    await jam.tick(); jam.stop()
    const p = packets(root)[0]
    expect(p.frames).toEqual(['demo/a', 'demo/b'])
    expect(p.members[0].brief.capture.note).toBe('kept - not an ask')
    expect(p.members[0].brief.capture.record.id).toBe(r.id)
    done()
  })

  it('the lane\'s run starts with the first capture and ends once every one is done, kept or dropped', async () => {
    const { root, done } = setup()
    const jam = createJam(root, CFG, agent())
    expect(jam.view().run).toBeUndefined()
    const r = rec()
    const a = await jam.capture(r)
    expect(jam.view().run).toBeTruthy()
    expect(jam.view().cards.find((c) => c.id === r.id)?.inRun).toBe(true)
    expect((await jam.act(r.id, a.card!.rev, 'drop')).ok).toBe(true)
    await jam.poke()
    expect(jam.view().run).toBeUndefined()
    jam.stop()
    done()
  })
})

describe('captures: pictures', () => {
  it('a picture is served by its id only from inside design/.local/jam; unknown ids and climbing entries are refused', () => {
    const { root, done } = setup()
    mkdirSync(join(root, 'design', '.local', 'shots'), { recursive: true })
    writeFileSync(join(root, 'design', '.local', 'shots', 'x.png'), 'png')
    const id = addPicture(root, 'design/.local/shots/x.png', { frame: 'demo/a', capture: 'cap-1700000000000-abcd' })
    expect(picturePath(root, id)?.entry.frame).toBe('demo/a')
    expect(picturePath(root, 'p-0000000000000000')).toBeNull()
    expect(picturePath(root, '../jam-jobs')).toBeNull()
    const ix = JSON.parse(readFileSync(join(root, 'design', '.local', 'jam', 'pictures.json'), 'utf8'))
    ix['p-1111111111111111'] = { file: '../../jam-ledger', frame: 'x', when: 1 }
    writeFileSync(join(root, 'design', '.local', 'jam', 'pictures.json'), JSON.stringify(ix))
    expect(picturePath(root, 'p-1111111111111111')).toBeNull()
    done()
  })
})

describe('captures: the payload is ledgered', () => {
  it('confirm ledgers the payload key; an edit changed after confirm stops the claim', async () => {
    const { root, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent())
    const r = rec()
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'edit', 'my words')
    await jam.act(r.id, card(jam, r.id).rev, 'confirm')
    jam.stop()
    const j = readJournal(root)
    const c = j.cards.find((x) => x.id === r.id)!
    expect(has(root, 'home', payloadKey(c))).toBe(true)
    expect((await createJam(root, CFG, agent()).act(r.id, c.rev, 'edit', 'later edit')).ok).toBe(false)   // refused once confirmed
    c.payload!.edited = 'changed behind its back'
    writeJournal(root, j)
    const again = createJam(root, CFG, agent())
    await again.tick(); again.stop()
    expect(card(again, r.id).state).toBe('failed')
    done()
  })
})
