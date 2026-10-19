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
import { addPicture, captureWords, checkRecord, factsOf, picturePath, readCapture } from '../src/server/jam/capture.ts'
import { speechLines } from '../src/shared/speech.ts'
import { addCapture, merge, payloadKey, prune, sameComment, touchRun } from '../src/server/jam/queue.ts'
import { captureFrames } from '../src/server/jam/capture.ts'
import type { CaptureRecord, JamAdapter } from '../src/server/jam/types.ts'
import type { JamConfig } from '../src/server/config.ts'

const CFG: JamConfig = { agent: 'claude', concurrency: 3, subagents: true, proactive: false, chime: true, capture: 'confirm', loc: true, names: false }
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
    expect(ev.body).toBe('please @marver make this match\nthe outline one')   // a note is its own line
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
    // the reviewed capture's own instructions survive: its record (words, notes, points) and edit
    expect(d.payload.reviewed.capture.record.id).toBe(r.id)
    expect(JSON.stringify(d.payload.reviewed.capture.record.timeline)).toContain('the outline one')
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

describe('captures: review round 1 fixes', () => {
  it('a tag on a kept capture\'s thread never carries a record changed since confirm', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent())
    const r = rec()
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'keep')
    const file = join(root, 'design', '.local', 'jam', 'captures', `${r.id}.json`)
    writeFileSync(file, readFileSync(file, 'utf8').replace('Save 20%', 'rm -rf'))
    const id = `t-${Math.random().toString(36).slice(2)}`
    appendEvents(dir, 'home', [{ id, ts: Date.now(), type: 'reply', commentId: `c-${id}`, parentId: `cap-${r.id}`, board: 'home', author: OWNER, body: '@marver go' }])
    record(root, 'home', id)
    await jam.tick(); jam.stop()
    expect(packets(root)).toEqual([])
    expect(jam.snapshot().cards.find((c: any) => c.events.includes(id))!.state).toBe('failed')
    done()
  })

  it('a capture changed after its claim and before a restart is not run again', async () => {
    const { root, done } = setup()
    const jam = createJam(root, CFG, agent('ok', { delay: 4000 }))
    const r = rec()
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'confirm')
    void jam.tick()
    for (let i = 0; i < 40 && card(jam, r.id).state !== 'working'; i++) await wait(50)
    jam.stop()
    const file = join(root, 'design', '.local', 'jam', 'captures', `${r.id}.json`)
    writeFileSync(file, readFileSync(file, 'utf8').replace('Save 20%', 'Save 99%'))
    const before = packets(root).length
    const again = createJam(root, CFG, agent())
    await again.tick(); again.stop()
    expect(card(again, r.id).state).toBe('failed')
    expect(packets(root).length).toBe(before)
    done()
  }, 20_000)

  it('a comment already under the step\'s id with the same words but another frame or capture fails closed', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent())
    const r = rec()
    const a = await jam.capture(r)
    const body = 'this badge should match the plan badge\nthe outline one'
    appendEvents(dir, 'home', [{ id: `cap-${r.id}-e`, ts: tick(), type: 'create', commentId: `cap-${r.id}`, board: 'home', author: OWNER, body, frame: 'demo/elsewhere', capture: 'cap-0000000000-other' }])
    expect((await jam.act(r.id, a.card!.rev, 'confirm')).ok).toBe(false)
    jam.stop()
    expect(card(jam, r.id).state).toBe('draft')
    expect(has(root, 'home', `cap-${r.id}-e`)).toBe(false)
    done()
  })

  it('the merge keeps the capture\'s own card, not a tag that carries the capture', () => {
    const j = readJournal(mkdtempSync(join(tmpdir(), 'mv-jamc-m-')))
    const now = Date.now()
    const capCard: any = { id: 'cap-1', kind: 'capture', board: 'home', frames: ['demo/a'], thread: 't', capture: 'cap-1', events: [], state: 'review', made: 100, order: 100, rev: 1, at: now, batch: 'b' }
    const tag: any = { id: 'c-t', kind: 'comment', board: 'home', frames: ['demo/a'], thread: 't', capture: 'cap-1', events: ['t1'], state: 'queued', made: 200, order: 200, rev: 1, at: now }
    j.cards.push(capCard, tag)
    expect(merge(j, tag, capCard, now).id).toBe('cap-1')
    expect(tag.state).toBe('done')
    expect(capCard.events).toEqual(['t1'])
  })

  it('an older capture sealing after a newer one moves the run\'s start back, so it stays on the lane', () => {
    const j = readJournal(mkdtempSync(join(tmpdir(), 'mv-jamc-r-')))
    const now = Date.now()
    j.cards.push({ id: 'cap-new', kind: 'capture', board: 'home', frames: [], events: [], state: 'draft', made: 2000, order: 2000, rev: 1, at: now } as any)
    touchRun(j)
    expect(j.run).toEqual({ since: 2000 })
    j.cards.push({ id: 'cap-old', kind: 'capture', board: 'home', frames: [], events: [], state: 'draft', made: 1000, order: 1000, rev: 1, at: now } as any)
    touchRun(j)
    expect(j.run).toEqual({ since: 1000 })
  })

  it('Looks good still resolves when an unrelated comment elsewhere on the board was edited', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent())
    const r = rec()
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'confirm')
    await jam.tick()
    const other = `o-${Math.random().toString(36).slice(2)}`
    appendEvents(dir, 'home', [{ id: other, ts: tick(), type: 'create', commentId: other, board: 'home', frame: 'demo/z', author: OWNER, body: 'elsewhere' }])
    record(root, 'home', other)
    const ed = `ed-${Math.random().toString(36).slice(2)}`
    appendEvents(dir, 'home', [{ id: ed, ts: Date.now() + 10, type: 'edit', commentId: other, author: OWNER, body: 'elsewhere, edited' }])
    record(root, 'home', ed)
    await jam.act(r.id, card(jam, r.id).rev, 'good')
    jam.stop()
    expect(replay(readLog(dir, 'home')).find((t) => t.id === `cap-${r.id}`)!.resolved).toBe(true)
    done()
  })

  it('More work while a tag waits on the capture\'s thread: the capture card survives, the tag is merged into it', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent())
    const r = rec()
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'confirm')
    await jam.tick()
    // a tag written in the thread since the review - held queued by a busy slot (a long job elsewhere)
    const busy = createJam(root, { ...CFG, concurrency: 1 }, agent('ok', { delay: 3000 }))
    jam.stop()
    const z = `z-${Math.random().toString(36).slice(2)}`
    appendEvents(dir, 'home', [{ id: z, ts: tick(), type: 'create', commentId: z, board: 'home', frame: 'demo/zz', author: OWNER, body: '@marver slow one' }])
    record(root, 'home', z)
    void busy.tick()
    await wait(300)
    const id = `t-${Math.random().toString(36).slice(2)}`
    appendEvents(dir, 'home', [{ id, ts: tick(), type: 'reply', commentId: `c-${id}`, parentId: `cap-${r.id}`, board: 'home', author: OWNER, body: '@marver also the border' }])
    record(root, 'home', id)
    await busy.poke()
    const tagCard = busy.snapshot().cards.find((c: any) => c.events.includes(id))!
    expect(tagCard.state).toBe('queued')
    const more = await busy.act(r.id, card(busy, r.id).rev, 'more', 'and the hover')
    expect(more.ok).toBe(true)
    expect(card(busy, r.id).state).toBe('queued')
    expect(tagCard.state).toBe('done')
    expect(card(busy, r.id).events).toContain(id)
    busy.stop()
    done()
  }, 20_000)
})

describe('captures: review round 2 fixes', () => {
  it('a step\'s comment must match in every field - another node, origin or mention is a conflict', () => {
    const a: CommentEvent = { id: 'cap-x-e', ts: 1, type: 'create', commentId: 'cap-x', board: 'home', author: OWNER, body: 'b', capture: 'x', frame: 'demo/a' }
    expect(sameComment(a, { ...a, ts: 99 })).toBe(true)
    expect(sameComment(a, { ...a, nodeKey: 'other-node' })).toBe(false)
    expect(sameComment(a, { ...a, origin: 'local' })).toBe(false)
    expect(sameComment(a, { ...a, mentions: [{ label: 'Sam', email: 's@x' }] })).toBe(false)
  })

  it('frames visited without a click are the capture\'s frames: a screen reached in play, a later view, a picture', () => {
    const r = rec({ timeline: [
      { at: 1, event: 'view', view: { frames: ['demo/a'] } },
      { at: 2, event: 'screen', to: 'demo/b' },
      { at: 3, event: 'note', text: 'this one' },
      { at: 4, frame: 'demo/c', event: 'picture', id: 'p-0000000000000001', why: 'key' },
      { at: 5, event: 'view', view: { frames: ['demo/d'] } },
    ] })
    expect(captureFrames(r).sort()).toEqual(['demo/a', 'demo/b', 'demo/c', 'demo/d'])
  })

  it('a frame merely on screen is not the capture\'s: views of several frames name none - the frames touched do; with none touched, the first view\'s (three at most)', () => {
    const r = rec({ timeline: [
      { at: 1, event: 'view', view: { frames: ['demo/a', 'demo/b', 'demo/c', 'demo/d'] } },
      { at: 2, frame: 'demo/b', event: 'pick', point: 1, bundle: { tag: 'button' }, mode: 'canvas' },
      { at: 3, frame: 'demo/c', event: 'picture', id: 'p-0000000000000002', why: 'end' },   // automatic: names nothing
      { at: 4, event: 'view', view: { frames: ['demo/a', 'demo/d'] } },
    ] as any })
    expect(captureFrames(r)).toEqual(['demo/b'])
    const none = rec({ timeline: [{ at: 1, event: 'view', view: { frames: ['demo/a', 'demo/b', 'demo/c', 'demo/d'] } }, { at: 2, event: 'note', text: 'hm' }] as any })
    expect(captureFrames(none)).toEqual(['demo/a', 'demo/b', 'demo/c'])
  })

  it('a resumed capture keeps the frames its first part was about, beside the new part\'s; one begun over empty canvas falls back on the first view that showed frames', () => {
    const first = [
      { at: 1, event: 'view', view: { frames: ['demo/a', 'demo/b'] } },
      { at: 2, event: 'words', text: 'fix the header on a' },
    ]
    const r = rec({ timeline: [...first, { at: 10, event: 'view', view: { frames: ['demo/c'] } }, { at: 11, frame: 'demo/c', event: 'pick', point: 1, bundle: { tag: 'h1' }, mode: 'canvas' }] as any })
    ;(r.context as any).resumes = { id: 'cap-1792399514739-first1', at: 10 }
    expect(captureFrames(r)).toEqual(['demo/a', 'demo/b', 'demo/c'])
    const blank = rec({ timeline: [
      { at: 1, event: 'view', view: { frames: [] } },
      { at: 2, event: 'view', view: { frames: ['demo/a', 'demo/b'] } },
      { at: 3, event: 'words', text: 'these two' },
    ] as any, view: { frames: [] } as any })
    expect(captureFrames(blank)).toEqual(['demo/a', 'demo/b'])
  })

  it('a chain of resumes keeps every frame each recording was about (the card it continues names them)', () => {
    const j = readJournal(mkdtempSync(join(tmpdir(), 'mv-jamc-rs-')))
    const a = rec({ timeline: [{ at: 1, event: 'view', view: { frames: ['demo/a', 'demo/b'] } }, { at: 2, event: 'note', text: 'both of these' }] as any })
    expect(addCapture(j, a, 'h1').frames).toEqual(['demo/a', 'demo/b'])
    const b = rec({ context: { resumes: { id: a.id, at: 10 } } as any, timeline: [...a.timeline, { at: 10, event: 'view', view: { frames: ['demo/c'] } }, { at: 11, frame: 'demo/c', event: 'pick', point: 1, bundle: { tag: 'h1' }, mode: 'canvas' }] as any })
    expect(addCapture(j, b, 'h2').frames).toEqual(['demo/a', 'demo/b', 'demo/c'])
    const c = rec({ context: { resumes: { id: b.id, at: 20 } } as any, timeline: [...b.timeline, { at: 20, frame: 'demo/d', event: 'pick', point: 2, bundle: { tag: 'p' }, mode: 'canvas' }] as any })
    expect(addCapture(j, c, 'h3').frames).toEqual(['demo/a', 'demo/b', 'demo/c', 'demo/d'])
  })

  it('pruning keeps the capture a waiting follow-up carries', () => {
    const j = readJournal(mkdtempSync(join(tmpdir(), 'mv-jamc-p-')))
    const long = Date.now() - 30 * 24 * 3600_000
    j.cards.push({ id: 'cap-old', kind: 'capture', board: 'home', frames: [], events: [], state: 'kept', made: long, order: long, rev: 1, at: long } as any)
    j.cards.push({ id: 'c-f', kind: 'comment', board: 'home', frames: [], events: ['f'], capture: 'cap-old', state: 'queued', made: Date.now(), order: Date.now(), rev: 1, at: Date.now() } as any)
    prune(j)
    expect(j.cards.map((c) => c.id).sort()).toEqual(['c-f', 'cap-old'])
  })

  it('a revoked More work ask is dropped from a capture card at recovery - the capture still runs on its payload', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent())
    const r = rec()
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'confirm')
    await jam.tick()
    const rev = card(jam, r.id).rev
    await jam.act(r.id, rev, 'more', 'and the hover')
    jam.stop()
    // simulate the job claimed and the device's ledger losing the mw- line before a restart
    const j = readJournal(root)
    const c = j.cards.find((x) => x.id === r.id)!
    const mw = `mw-${r.id}-${rev}`
    const ledger = join(root, 'design', '.local', 'jam-ledger')
    writeFileSync(ledger, readFileSync(ledger, 'utf8').split('\n').filter((l) => !l.endsWith(`\t${mw}`)).join('\n'))
    c.state = 'working'; c.batch = 'b-mw'
    c.brief = { asks: [{ id: mw, owner: true, rev: mw, body: '@marver and the hover', ts: 1 }], history: [] }
    j.batches.push({ batchId: 'b-mw', members: [{ id: 'm1', card: r.id, board: 'home', brief: c.brief }], frames: c.frames, state: 'claimed', leaseUntil: 0, attempts: 1, at: Date.now() })
    mkdirSync(join(root, 'design', '.local', 'jam', 'packets'), { recursive: true })
    writeFileSync(join(root, 'design', '.local', 'jam', 'packets', 'b-mw.json'), JSON.stringify({ v: 2, kind: 'marver.jam.job', batchId: 'b-mw', frames: c.frames, members: [{ id: 'm1', card: r.id, kind: 'capture', board: 'home', thread: c.thread, frames: c.frames, brief: c.brief }] }))
    writeJournal(root, j)
    const again = createJam(root, CFG, agent())
    await again.tick(); again.stop()
    const seen = packets(root).at(-1)
    expect(seen.batchId).toBe('b-mw')
    expect(seen.members[0].brief.asks).toEqual([])
    expect(card(again, r.id).events).not.toContain(mw)
    done()
  })

  it('Looks good resolves after a message was edited twice before the claim - the brief copied its latest revision', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent())
    const r = rec()
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'confirm')
    jam.stop()
    // an owner reply in the capture's thread, edited twice, all before the claim
    const id = `rp-${Math.random().toString(36).slice(2)}`
    appendEvents(dir, 'home', [{ id, ts: tick(), type: 'reply', commentId: `c-${id}`, parentId: `cap-${r.id}`, board: 'home', author: OWNER, body: 'one' }])
    record(root, 'home', id)
    for (const body of ['two', 'three']) { const e = `ed-${Math.random().toString(36).slice(2)}`; appendEvents(dir, 'home', [{ id: e, ts: tick(), type: 'edit', commentId: `c-${id}`, author: OWNER, body }]); record(root, 'home', e) }
    const again = createJam(root, CFG, agent())
    await again.tick()
    await again.act(r.id, card(again, r.id).rev, 'good')
    again.stop()
    expect(replay(readLog(dir, 'home')).find((t) => t.id === `cap-${r.id}`)!.resolved).toBe(true)
    done()
  })
})

describe('captures: review round 3 fixes', () => {
  it('a capture\'s own card outlives the retention window, so a later tag on its thread still carries it', () => {
    const j = readJournal(mkdtempSync(join(tmpdir(), 'mv-jamc-p2-')))
    const long = Date.now() - 60 * 24 * 3600_000
    j.cards.push({ id: 'cap-kept', kind: 'capture', board: 'home', frames: ['demo/a', 'demo/b'], thread: 'cap-cap-kept', events: [], state: 'kept', made: long, order: long, rev: 1, at: long } as any)
    j.cards.push({ id: 'c-old', kind: 'comment', board: 'home', frames: [], events: ['x'], state: 'done', made: long, order: long, rev: 1, at: long } as any)
    prune(j)
    expect(j.cards.map((c) => c.id)).toEqual(['cap-kept'])
  })

  it('Looks good keeps the thread open when the More work reply was edited after its run was claimed', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent())
    const r = rec()
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'confirm')
    await jam.tick()
    const rev = card(jam, r.id).rev
    await jam.act(r.id, rev, 'more', 'the hover')
    await jam.tick()                                                   // the rerun: claimed with the mw- reply frozen
    expect(card(jam, r.id).state).toBe('review')
    const e = `ed-${Math.random().toString(36).slice(2)}`
    appendEvents(dir, 'home', [{ id: e, ts: Date.now() + 10, type: 'edit', commentId: `mw-c-${r.id}-${rev}`, author: OWNER, body: '@marver the hover AND the focus ring' }])
    record(root, 'home', e)
    await jam.act(r.id, card(jam, r.id).rev, 'good')
    jam.stop()
    expect(replay(readLog(dir, 'home')).find((t) => t.id === `cap-${r.id}`)!.resolved).toBe(false)
    done()
  })
})

describe('captures: review round 6 fixes', () => {
  it('an empty edit means you deleted everything: the comment says so, the brief carries the empty edit - also after a restart', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent())
    const r = rec()
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'edit', '')
    await jam.act(r.id, card(jam, r.id).rev, 'confirm')
    jam.stop()
    expect(readLog(dir, 'home').find((e) => e.id === `cap-${r.id}-e`)!.body).toBe('(a capture with no words)')
    const again = createJam(root, CFG, agent())
    await again.tick(); again.stop()
    const p = packets(root)[0].members[0]
    expect(p.brief.capture.edited).toBe('')
    expect(card(again, r.id).state).toBe('review')
    done()
  })
})

describe('captures: the first trial (Resume, Rename, the words)', () => {
  it('Resume: a record that continues a draft takes its place - its spot, its name, your edit with the new words after it - and the draft leaves', async () => {
    const { root, done } = setup()
    const jam = createJam(root, CFG, agent())
    const a = rec()
    const ca = await jam.capture(a)
    await jam.act(a.id, ca.card!.rev, 'edit', 'make the badge outline')
    await jam.act(a.id, card(jam, a.id).rev, 'rename', 'Badge')
    const at = 1_010_000
    const b = rec({
      context: { canvas: 'test', board: 'home', resumes: { id: a.id, at } } as any,
      timeline: [...a.timeline, { at: at + 500, event: 'note', text: 'and the footer link' }],
    })
    const cb = await jam.capture(b)
    jam.stop()
    expect(cb.ok).toBe(true)
    expect(card(jam, a.id).state).toBe('dropped')
    const nb = card(jam, b.id)
    expect(nb.state).toBe('draft')
    expect(nb.made).toBe(card(jam, a.id).made)
    expect(nb.payload.edited).toBe('make the badge outline\nand the footer link')
    expect(jam.view().cards.find((c) => c.id === b.id)?.title).toBe('Badge')
    expect(readCapture(root, b.id)!.record.context.resumes).toEqual({ id: a.id, at })
    done()
  })

  it('Resume of a draft already decided (or on another board) is a capture of its own: the earlier card is left as it is', async () => {
    const { root, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent())
    const a = rec()
    const ca = await jam.capture(a)
    await jam.act(a.id, ca.card!.rev, 'keep')
    const kept = card(jam, a.id).state
    const b = rec({ context: { canvas: 'test', board: 'home', resumes: { id: a.id, at: 1_010_000 } } as any })
    await jam.capture(b)
    jam.stop()
    expect(card(jam, a.id).state).toBe(kept)
    expect(card(jam, b.id).state).toBe('draft')
    expect(card(jam, b.id).made).not.toBe(card(jam, a.id).made)
    done()
  })

  it('Resume is refused from a record changed after its seal, and for a record that does not continue it', async () => {
    const { root, done } = setup()
    const jam = createJam(root, CFG, agent())
    const a = rec()
    await jam.capture(a)
    const at = 1_010_000
    // not a continuation: a step of the draft is missing
    const gap = rec({ context: { canvas: 'test', board: 'home', resumes: { id: a.id, at } } as any, timeline: [...a.timeline.slice(1), { at: at + 5, event: 'note', text: 'x' }] })
    expect((await jam.capture(gap)).error).toMatch(/does not continue/)
    // moved by two different offsets
    const skew = rec({ context: { canvas: 'test', board: 'home', resumes: { id: a.id, at } } as any, timeline: a.timeline.map((x, i) => ({ ...x, at: x.at + (i ? 10 : 0) })) })
    expect((await jam.capture(skew)).error).toMatch(/does not continue/)
    expect(jam.sealed(a.id)).toBe(true)
    // the draft's file changed on disk after its seal
    const f = join(root, 'design', '.local', 'jam', 'captures', `${a.id}.json`)
    writeFileSync(f, readFileSync(f, 'utf8').replace('the outline one', 'the filled one'))
    expect(jam.sealed(a.id)).toBe(false)
    const b = rec({ context: { canvas: 'test', board: 'home', resumes: { id: a.id, at } } as any, timeline: [...a.timeline, { at: at + 5, event: 'note', text: 'more' }] })
    expect((await jam.capture(b)).error).toMatch(/changed after it was sealed/)
    jam.stop()
    expect(card(jam, a.id).state).toBe('draft')
    done()
  })

  it('the edit carried on takes only what came after the resume - a note you deleted at the end of the draft stays deleted; a draft decided meanwhile still gives its edit', async () => {
    const { root, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent())
    const a0 = rec()
    const a = rec({ timeline: a0.timeline.filter((x) => x.event !== 'theme') })   // it ends on its note
    expect(a.timeline[a.timeline.length - 1].event).toBe('note')
    const ca = await jam.capture(a)
    await jam.act(a.id, ca.card!.rev, 'edit', 'only the badge')   // the trailing note deleted
    await jam.act(a.id, card(jam, a.id).rev, 'keep')               // decided in another tab while this one resumes
    const last = a.timeline[a.timeline.length - 1].at
    const at = last + 1   // the client puts everything carried over strictly before the resume
    const b = rec({ context: { canvas: 'test', board: 'home', resumes: { id: a.id, at } } as any, timeline: [...a.timeline, { at: at + 5, event: 'note', text: 'and the footer' }] })
    expect((await jam.capture(b)).ok).toBe(true)
    jam.stop()
    expect(card(jam, b.id).payload.edited).toBe('only the badge\nand the footer')
    expect(card(jam, a.id).state).not.toBe('dropped')
    done()
  })

  it('Resume carries a phrase\'s words moved with it (each word by the same offset, to fractions of a millisecond)', async () => {
    const { root, done } = setup()
    const jam = createJam(root, CFG, agent())
    const t0 = 1_000_000.123
    const a = rec({ timeline: [{ at: t0, event: 'view', view: { frames: ['demo/a'] } }, { at: t0 + 500.25, event: 'words', text: 'make it blue', words: [{ w: 'make', at: t0 + 500.25 }, { w: 'it', at: t0 + 700.5 }, { w: 'blue', at: t0 + 900.75 }] }] })
    await jam.capture(a)
    const d = 61_234.567
    const at = t0 + 900.75 + d + 1
    const moved = a.timeline.map((x: any) => ({ ...x, at: x.at + d, ...(x.words ? { words: x.words.map((w: any) => ({ ...w, at: w.at + d })) } : {}) }))
    const b = rec({ context: { canvas: 'test', board: 'home', resumes: { id: a.id, at } } as any, timeline: [...moved, { at: at + 5, event: 'note', text: 'and bold' }] })
    expect((await jam.capture(b)).ok).toBe(true)
    // a word of the carried phrase after the resume is not a continuation (it would overlap new speech)
    const over = rec({ context: { canvas: 'test', board: 'home', resumes: { id: a.id, at: t0 + 600 + d } } as any, timeline: [...moved, { at: t0 + 600 + d + 5, event: 'note', text: 'x' }] })
    expect((await jam.capture(over)).ok).toBe(false)
    // a word left on the old clock is not a continuation
    const stale = rec({ context: { canvas: 'test', board: 'home', resumes: { id: a.id, at } } as any, timeline: [...a.timeline.map((x: any) => ({ ...x, at: x.at + d })), { at: at + 5, event: 'note', text: 'x' }] })
    expect((await jam.capture(stale)).error).toMatch(/does not continue/)
    jam.stop()
    done()
  })

  it('a record that names itself as the draft it resumes, or a bad id, carries no resume', () => {
    const r = rec()
    const self = checkRecord({ ...r, context: { ...r.context, resumes: { id: r.id, at: 5 } } }) as CaptureRecord
    expect(self.context.resumes).toBeUndefined()
    const bad = checkRecord({ ...r, context: { ...r.context, resumes: { id: '../x', at: 5 } } }) as CaptureRecord
    expect(bad.context.resumes).toBeUndefined()
  })

  it('Rename names the tile (empty gives back its first words); a dropped capture is not renamed; the agent never reads the name', async () => {
    const { root, done } = setup()
    const jam = createJam(root, CFG, agent())
    const r = rec()
    const c = await jam.capture(r)
    expect((await jam.act(r.id, c.card!.rev, 'rename', '  Checkout   badge ')).ok).toBe(true)
    expect(jam.view().cards.find((x) => x.id === r.id)?.title).toBe('Checkout badge')
    expect((await jam.act(r.id, card(jam, r.id).rev, 'rename', '')).ok).toBe(true)
    expect(jam.view().cards.find((x) => x.id === r.id)?.title).toBe('this badge should match the plan badge the outline one')
    await jam.act(r.id, card(jam, r.id).rev, 'drop')
    expect((await jam.act(r.id, card(jam, r.id).rev, 'rename', 'late')).ok).toBe(false)
    jam.stop()
    done()
  })

  it('the words read as written: what was said runs on, every note is its own line - no "(note)"', () => {
    const r = rec()
    expect(captureWords(r)).toBe('this badge should match the plan badge\nthe outline one')
    expect(speechLines([{ kind: 'note', text: ' a ' }, { kind: 'words', text: 'b' }, { kind: 'words', text: ' c ' }, { kind: 'note', text: '' }])).toBe('a\nb c')
  })
})

describe('captures: trial 2 (sizes, new frames, notes added after, names)', () => {
  const png = (root: string, name: string, bytes: string) => { const f = join(root, name); writeFileSync(f, bytes); return name }

  it('the run pictures each frame at the size it was captured; a frame the run made is pictured as new, and a capture that left its own frames as they were moves its thread onto it', async () => {
    const { root, dir, done } = setup()
    mkdirSync(join(root, 'design', 'boards'), { recursive: true })
    writeFileSync(join(root, 'design', 'boards', 'home.json'), JSON.stringify({ version: 1, name: 'home', auto: true, nodes: [] }))
    mkdirSync(join(root, 'design', 'scenes', 'demo'), { recursive: true })
    writeFileSync(join(root, 'design', 'scenes', 'demo', 'a.tsx'), 'export default () => null\n')
    const calls: { frame: string; size?: { w: number; h: number } }[] = []
    const jam = createJam(root, CFG, agent('ok', { touch: 'design/scenes/demo/fresh.tsx' }), undefined, {
      anchor: async (_f, target) => ({ ok: true, anchor: { el: { semantics: { quote: target.on } } }, holders: [], viewport: 'laptop', theme: 'light' }),
      // the same pixels for demo/a before and after (the run left it as it was)
      shoot: async (frame, _theme, _entry, size) => { calls.push({ frame, ...(size ? { size } : {}) }); return addPicture(root, png(root, `shot-${frame.replace('/', '-')}.png`, `pixels of ${frame}`), { frame }) },
    })
    const r = { ...rec({ words: 'a brand new frame to the right of this one' }), sizes: { 'demo/a': { w: 411, h: 900 } } }
    expect((checkRecord(r) as CaptureRecord).sizes).toEqual({ 'demo/a': { w: 411, h: 900 } })
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'confirm')
    await jam.tick(); jam.stop()
    expect(calls.filter((c) => c.frame === 'demo/a')).toEqual([{ frame: 'demo/a', size: { w: 411, h: 900 } }, { frame: 'demo/a', size: { w: 411, h: 900 } }])
    const shots: any[] = jam.snapshot().batches[0].shots ?? []
    expect(shots.find((s: any) => s.frame === 'demo/a').same).toBe(true)
    expect(shots.find((s: any) => s.frame === 'demo/fresh')).toMatchObject({ frame: 'demo/fresh', new: true })
    expect(shots.find((s: any) => s.frame === 'demo/fresh').after).toMatch(/^p-/)
    // hosted on the new frame: the thread moved there, the card names it
    const t = replay(readLog(dir, 'home')).find((x) => x.id === `cap-${r.id}`)!
    expect(t.frame).toBe('demo/fresh')
    expect(card(jam, r.id).frames).toContain('demo/fresh')
    done()
  })

  const freshBoard = (root: string) => {
    mkdirSync(join(root, 'design', 'boards'), { recursive: true })
    writeFileSync(join(root, 'design', 'boards', 'home.json'), JSON.stringify({ version: 1, name: 'home', auto: true, nodes: [] }))
    mkdirSync(join(root, 'design', 'scenes', 'demo'), { recursive: true })
    writeFileSync(join(root, 'design', 'scenes', 'demo', 'a.tsx'), 'export default () => null\n')
  }
  const sameShot = (root: string) => async (frame: string) => addPicture(root, png(root, `shot-${frame.replace('/', '-')}-${Date.now()}.png`, `pixels of ${frame}`), { frame })
  const anchorOk = async (_f: string, target: any) => ({ ok: true as const, anchor: { el: { semantics: { quote: target.on } } }, holders: [], viewport: 'laptop', theme: 'light' })

  it('a crash while the new frame is pictured: the rerun pictures it again and still moves the thread onto it', async () => {
    const { root, dir, done } = setup()
    freshBoard(root)
    let jam: ReturnType<typeof createJam>
    const shoot1 = sameShot(root)
    jam = createJam(root, CFG, agent('ok', { touch: 'design/scenes/demo/fresh.tsx' }), undefined, {
      anchor: anchorOk as any,
      shoot: async (frame) => { if (frame === 'demo/fresh') { jam.stop(); return null } return shoot1(frame) },
    })
    const r = rec({ words: 'a brand new frame to the right of this one' })
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'confirm')
    await jam.tick()
    await wait(300)
    // restarted: the frame is already there - the batch remembers it was this run's
    const again = createJam(root, CFG, agent('ok', { touch: 'design/scenes/demo/fresh.tsx' }), undefined, { anchor: anchorOk as any, shoot: (f) => sameShot(root)(f) })
    await again.tick(); again.stop()
    const b: any = again.snapshot().batches.find((x: any) => x.members.some((m: any) => m.card === r.id))
    expect(b.created).toEqual(['demo/fresh'])
    expect(b.frames).toContain('demo/fresh')                              // held like its other frames
    expect(b.shots.find((x: any) => x.frame === 'demo/fresh')?.after).toMatch(/^p-/)
    expect(replay(readLog(dir, 'home')).find((t) => t.id === `cap-${r.id}`)?.frame).toBe('demo/fresh')
    done()
  })

  it('a crash before the new frame was found (picturing its own frame after the run): the rerun still knows the frame was its run\'s', async () => {
    const { root, dir, done } = setup()
    freshBoard(root)
    let jam: ReturnType<typeof createJam>
    let shotsOfA = 0
    const shoot1 = sameShot(root)
    jam = createJam(root, CFG, agent('ok', { touch: 'design/scenes/demo/fresh.tsx' }), undefined, {
      anchor: anchorOk as any,
      shoot: async (frame) => { if (frame === 'demo/a' && ++shotsOfA === 2) { jam.stop(); return null } return shoot1(frame) },
    })
    const r = rec({ words: 'a brand new frame to the right of this one' })
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'confirm')
    await jam.tick()
    await wait(300)
    const again = createJam(root, CFG, agent('ok', { touch: 'design/scenes/demo/fresh.tsx' }), undefined, { anchor: anchorOk as any, shoot: (f) => sameShot(root)(f) })
    await again.tick(); again.stop()
    const b: any = again.snapshot().batches.find((x: any) => x.members.some((m: any) => m.card === r.id))
    expect(b.created).toEqual(['demo/fresh'])
    expect(replay(readLog(dir, 'home')).find((t) => t.id === `cap-${r.id}`)?.frame).toBe('demo/fresh')
    done()
  })

  it('a terminal hold seen while it ran is kept at once: after a crash, the rerun claims no new frame', async () => {
    const { root, dir, done } = setup()
    freshBoard(root)
    let jam: ReturnType<typeof createJam>
    let shotsOfA = 0
    const shoot1 = sameShot(root)
    jam = createJam(root, CFG, agent('ok', { touch: 'design/scenes/demo/fresh.tsx', delay: 300 }), undefined, {
      anchor: anchorOk as any, anyHold: () => false, held: () => false,
      watchHolds: (fn: () => void) => { const t = setTimeout(fn, 80); return () => clearTimeout(t) },
      shoot: async (frame: string) => { if (frame === 'demo/a' && ++shotsOfA === 2) { jam.stop(); return null } return shoot1(frame) },
    } as any)
    const r = rec({ words: 'a brand new frame to the right of this one' })
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'confirm')
    await jam.tick()
    await wait(300)
    const again = createJam(root, CFG, agent('ok', { touch: 'design/scenes/demo/fresh.tsx' }), undefined, { anchor: anchorOk as any, shoot: (f) => sameShot(root)(f) })
    await again.tick(); again.stop()
    const b: any = again.snapshot().batches.find((x: any) => x.members.some((m: any) => m.card === r.id))
    expect(b.crowded).toBe(true)
    expect(b.created ?? []).toEqual([])
    expect(replay(readLog(dir, 'home')).find((t) => t.id === `cap-${r.id}`)?.frame).toBe('demo/a')
    done()
  })

  it('a tag queued on the thread while its capture ran holds the new frame too when it runs', async () => {
    const { root, dir, done } = setup()
    freshBoard(root)
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent('ok', { touch: 'design/scenes/demo/fresh.tsx', delay: 600 }), undefined, { anchor: anchorOk as any, shoot: (f) => sameShot(root)(f) })
    const r = rec({ words: 'a brand new frame to the right of this one' })
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'confirm')
    const running = jam.tick()
    await wait(200)
    // a tag on its thread while it works: queued behind it
    appendEvents(dir, 'home', [{ id: 'etag-f1', ts: tick(), type: 'reply', commentId: 'rc-etag-f1', parentId: `cap-${r.id}`, board: 'home', author: OWNER, body: '@marver and make it blue' }])
    record(root, 'home', 'etag-f1')
    await jam.poke()
    const follower = () => jam.snapshot().cards.find((c: any) => c.events?.includes('etag-f1'))
    expect(follower()?.state).toBe('queued')
    await running
    for (let i = 0; i < 60 && !follower()?.frames.includes('demo/fresh'); i++) await wait(50)
    expect(follower()?.frames).toContain('demo/fresh')
    jam.stop()
    done()
  })

  it('a note sent again under its id is kept once; another note is its own', async () => {
    const { root, done } = setup()
    const jam = createJam(root, CFG, agent())
    const r = rec()
    await jam.capture(r)
    const n = (id: string, text: string) => jam.act(r.id, card(jam, r.id).rev, 'note', JSON.stringify({ id, text }))
    expect((await n('n-aaaaaaaa', 'one')).ok).toBe(true)
    expect((await n('n-aaaaaaaa', 'one')).ok).toBe(true)                  // its answer was lost: sent again
    expect((await n('n-bbbbbbbb', 'two')).ok).toBe(true)
    expect(card(jam, r.id).payload.added.map((x: any) => x.text)).toEqual(['one', 'two'])
    expect((await n('n-aaaaaaaa', 'one, edited')).ok).toBe(true)            // edited in the field after its answer was lost
    expect(card(jam, r.id).payload.added.map((x: any) => x.text)).toEqual(['one, edited', 'two'])
    jam.stop()
    done()
  })

  it('frames a run made go to the capture even when its thread stays (it changed its own frame too); nothing is claimed while a terminal holds a frame', async () => {
    const { root, done } = setup()
    freshBoard(root)
    let k = 0
    const jam = createJam(root, CFG, agent('ok', { touch: 'design/scenes/demo/fresh.tsx' }), undefined, {
      anchor: anchorOk as any,
      shoot: async (frame) => addPicture(root, png(root, `shot-${k}.png`, `pixels ${k++}`), { frame }),   // every picture differs: demo/a changed
    })
    const r = rec({ words: 'change this and add one' })
    const a = await jam.capture(r)
    await jam.act(r.id, a.card!.rev, 'confirm')
    await jam.tick(); jam.stop()
    expect(card(jam, r.id).frames).toEqual(['demo/a', 'demo/fresh'])
    expect(card(jam, r.id).thread).toBe(`cap-${r.id}`)
    // with a terminal agent holding a frame meanwhile, a new frame is no one's
    const { root: root2, done: done2 } = setup()
    freshBoard(root2)
    const jam2 = createJam(root2, CFG, agent('ok', { touch: 'design/scenes/demo/fresh.tsx' }), undefined, { anchor: anchorOk as any, shoot: (f: string) => sameShot(root2)(f), anyHold: () => true, held: () => false } as any)
    const r2 = rec({ words: 'a new frame please' })
    const a2 = await jam2.capture(r2)
    await jam2.act(r2.id, a2.card!.rev, 'confirm')
    await jam2.tick(); jam2.stop()
    expect(card(jam2, r2.id).frames).toEqual(['demo/a'])
    // a hold that came and went between two looks still counts (the activity is watched, not polled)
    const { root: root3, done: done3 } = setup()
    freshBoard(root3)
    const jam3 = createJam(root3, CFG, agent('ok', { touch: 'design/scenes/demo/fresh.tsx', delay: 300 }), undefined, {
      anchor: anchorOk as any, shoot: (f: string) => sameShot(root3)(f), anyHold: () => false, held: () => false,
      watchHolds: (fn: () => void) => { const t = setTimeout(fn, 100); return () => clearTimeout(t) },
    } as any)
    const r3 = rec({ words: 'a new frame please' })
    const a3 = await jam3.capture(r3)
    await jam3.act(r3.id, a3.card!.rev, 'confirm')
    await jam3.tick(); jam3.stop()
    expect(card(jam3, r3.id).frames).toEqual(['demo/a'])
    done(); done2(); done3()
  })

  it('a note added in a draft\'s read-back goes with it: in its thread comment, in what the agent reads, bound at confirm; never once it is sent', async () => {
    const { root, dir, done } = setup()
    const jam = createJam(root, CFG, agent())
    const r = rec({ words: 'make the badge match' })
    const a = await jam.capture(r)
    const n = await jam.act(r.id, a.card!.rev, 'note', 'and the outline too')
    expect(n.ok).toBe(true)
    expect(card(jam, r.id).payload.added.map((x: any) => x.text)).toEqual(['and the outline too'])
    expect(jam.view().cards.find((c) => c.id === r.id)?.added?.[0].text).toBe('and the outline too')
    await jam.act(r.id, card(jam, r.id).rev, 'confirm')
    expect(readLog(dir, 'home').find((e) => e.id === `cap-${r.id}-e`)!.body).toMatch(/make the badge match[\s\S]*and the outline too$/)
    expect((await jam.act(r.id, card(jam, r.id).rev, 'note', 'too late')).ok).toBe(false)
    await jam.tick(); jam.stop()
    expect(packets(root)[0].members[0].brief.capture.added.map((x: any) => x.text)).toEqual(['and the outline too'])
    done()
  })

  it('the Claude namer runs Haiku with no tools, no MCP servers and no hooks', () => {
    const a = claudeAdapter.namerArgs!('the words')
    expect(a.cmd).toBe('claude')
    expect(a.args).toEqual(expect.arrayContaining(['--model', 'haiku', '--tools', '', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}']))
    expect(a.args[a.args.indexOf('-p') + 1]).toBe('the words')
  })

  it('a capture is named by the small model as it lands - never over your own name, never with names off', async () => {
    const namer = (name: string): JamAdapter => ({ ...agent(), namerArgs: () => ({ cmd: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(name + '\n')})`] }) })
    const { root, done } = setup()
    const jam = createJam(root, { ...CFG, names: true }, namer('"Quieter save button."'))
    const r = rec({ words: 'the save button is too loud, tone it down' })
    await jam.capture(r)
    for (let i = 0; i < 100 && !card(jam, r.id).autoName; i++) await wait(50)
    expect(card(jam, r.id).autoName).toBe('Quieter save button')
    expect(card(jam, r.id).rev).toBe(1)                                    // a name binds nothing: its revision stays
    expect(jam.view().cards.find((c) => c.id === r.id)?.title).toBe('Quieter save button')
    // renamed by you: yours wins
    await jam.act(r.id, card(jam, r.id).rev, 'rename', 'Save button')
    expect(jam.view().cards.find((c) => c.id === r.id)?.title).toBe('Save button')
    jam.stop()
    const off = createJam(root, { ...CFG, names: false }, namer('Should not be'))
    const r2 = rec({ words: 'another one' })
    await off.capture(r2)
    await wait(600)
    expect(card(off, r2.id).autoName).toBeUndefined()
    off.stop()
    done()
  })
})
