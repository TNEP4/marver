// The Jam session (spec 27 Part 5 - M4), the server: a session holds the run, its captures carry it; the
// wrap-up seals what the session was (confirmed and kept captures, not drafts or dropped ones; the talk
// only if you leave it on), is checked at claim, comes back as a record to review; More work writes it
// again with your note.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJam } from '../src/server/jam/daemon.ts'
import { claudeAdapter } from '../src/server/jam/adapter/claude.ts'
import { appendTalk, readTalk, recordFile, recordPathProblem, talkMinutes } from '../src/server/jam/session.ts'
import { symlinkSync } from 'node:fs'
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
  const root = mkdtempSync(join(tmpdir(), 'mv-jams-'))
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify(OWNER))
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}
let n = 0
const SES = 'ses-1792399514739-abcd12'
const capId = () => `cap-${Date.now() + n++}-${Math.random().toString(36).slice(2, 8)}`
const rec = (words: string, session?: string): CaptureRecord => ({
  format: 'marver.jam.capture', v: 1, id: capId(),
  context: { canvas: 'test', board: 'home', ...(session ? { session } : {}) },
  view: { board: 'home', frames: ['demo/a'], theme: 'light' },
  timeline: [{ at: 1_000_000, event: 'view', view: { frames: ['demo/a'] } }, { at: 1_001_000, event: 'note', text: words }],
  pictures: [],
})
const card = (jam: { snapshot(): any }, id: string) => jam.snapshot().cards.find((c: any) => c.id === id)
const packets = (root: string) => existsSync(join(root, 'packets-seen.jsonl')) ? readFileSync(join(root, 'packets-seen.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []

describe('sessions: review fixes', () => {
  it('a capture changed after it was confirmed is never sealed into a record: the wrap-up is refused, the session goes on', async () => {
    const { root, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent('ok', { hang: true }))
    await jam.session({ action: 'start', id: SES })
    const r = rec('the outline', SES)
    await jam.capture(r)
    await jam.act(r.id, card(jam, r.id).rev, 'keep')
    const f = join(root, 'design', '.local', 'jam', 'captures', `${r.id}.json`)
    writeFileSync(f, readFileSync(f, 'utf8').replace('the outline', 'the filled'))
    const w = await jam.session({ action: 'wrapup', id: SES, instructions: 'x', includeTalk: false, tags: 0, board: 'home' })
    expect(w.ok).toBe(false)
    expect(w.error).toMatch(/changed after it was confirmed/)
    expect(jam.view().session?.id).toBe(SES)
    jam.stop()
    done()
  })

  it('a record job\'s packet is made from the journal and the seal before each run - a packet changed on disk (its kind, its file) never reaches the agent', async () => {
    const { root, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent('ok', { hang: true }))
    await jam.session({ action: 'start', id: SES })
    const w = await jam.session({ action: 'wrapup', id: SES, instructions: 'x', includeTalk: false, tags: 0, board: 'home' })
    void jam.tick()
    await new Promise((r) => setTimeout(r, 800))
    jam.stop()
    const sealedFile = jam.record(w.card!.id)!.file
    const pk = join(root, 'design', '.local', 'jam', 'packets', `${card(jam, w.card!.id).batch}.json`)
    const p = JSON.parse(readFileSync(pk, 'utf8'))
    p.members[0].kind = 'capture'
    p.members[0].brief.wrapup.content.file = 'design/config.ts'
    writeFileSync(pk, JSON.stringify(p))
    const again = createJam(root, CFG, agent())
    await again.tick()
    const seen = packets(root).filter((x) => x.members.some((m: any) => m.card === w.card!.id))
    const last = seen[seen.length - 1]
    expect(last.members[0].kind).toBe('wrapup')
    expect(last.members[0].brief.wrapup.content.file).toBe(sealedFile)
    expect(existsSync(join(root, 'design', 'config.ts'))).toBe(false)
    again.stop()
    done()
  })

  it('the record holds a capture\'s More work asks, in order, with what came of each', async () => {
    const { root, dir: _d, done } = { ...setup(), dir: '' }
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent('ok', { hang: true }))
    await jam.session({ action: 'start', id: SES })
    const r = rec('make it blue', SES)
    await jam.capture(r)
    jam.stop()
    // run it to review with an agent that answers, then ask for more work - left queued (the agent hangs again)
    const a2 = createJam(root, { ...CFG, concurrency: 1 }, agent())
    await a2.act(r.id, card(a2, r.id).rev, 'confirm')
    await a2.tick()
    expect(card(a2, r.id).state).toBe('review')
    a2.stop()
    const a3 = createJam(root, { ...CFG, concurrency: 1 }, agent('ok', { hang: true }))
    expect((await a3.act(r.id, card(a3, r.id).rev, 'more', 'actually make it red')).ok).toBe(true)
    const w = await a3.session({ action: 'wrapup', id: SES, instructions: 'x', includeTalk: false, tags: 0, board: 'home' })
    expect(w.ok).toBe(true)
    const stored = JSON.parse(readFileSync(join(root, 'design', '.local', 'jam', 'wrapups', `${w.card!.id}.json`), 'utf8'))
    expect(stored.captures[0].more).toEqual([{ ask: 'actually make it red' }])
    expect(stored.captures[0].verdict).toBe('more work')
    a3.stop()
    done()
  })

  it('the session survives a restart of the dev server', async () => {
    const { root, done } = setup()
    const jam = createJam(root, CFG, agent())
    await jam.session({ action: 'start', id: SES })
    jam.stop()
    const again = createJam(root, CFG, agent())
    expect(again.view().session?.id).toBe(SES)
    expect((await again.session({ action: 'wrapup', id: SES, instructions: 'x', includeTalk: false, tags: 0, board: 'home' })).ok).toBe(true)
    again.stop()
    done()
  })

  it('a record path through a link is refused - at the wrap-up, never written or read through it', async () => {
    const { root, done } = setup()
    mkdirSync(join(root, 'context'))
    const outside = mkdtempSync(join(tmpdir(), 'mv-outside-'))
    symlinkSync(outside, join(root, 'context', 'sessions'))
    expect(recordPathProblem(root, 'context/sessions/2026-10-19-1405-session-abcd12.md')).toMatch(/link/)
    expect(recordPathProblem(root, '../x.md')).toMatch(/not a session record path/)
    const jam = createJam(root, CFG, agent())
    await jam.session({ action: 'start', id: SES })
    const w = await jam.session({ action: 'wrapup', id: SES, instructions: 'x', includeTalk: false, tags: 0, board: 'home' })
    expect(w.ok).toBe(false)
    expect(w.error).toMatch(/not safe/)
    jam.stop()
    rmSync(outside, { recursive: true, force: true })
    done()
  })

  it('a failed record can be dropped, and the run lets go; verdicts are what you said, not guessed from reruns', async () => {
    const { root, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent('ok', { fail: true }))
    await jam.session({ action: 'start', id: SES })
    const w = await jam.session({ action: 'wrapup', id: SES, instructions: 'x', includeTalk: false, tags: 0, board: 'home' })
    await jam.tick()
    expect(card(jam, w.card!.id).state).toBe('failed')
    expect((await jam.act(w.card!.id, card(jam, w.card!.id).rev, 'drop')).ok).toBe(true)
    expect(jam.view().run).toBeUndefined()
    jam.stop()
    done()
  })
})

describe('sessions: the server', () => {
  it('a session holds the run from its start; its captures carry it; one session at a time; ending it lets the run go when nothing is pending', async () => {
    const { root, done } = setup()
    const jam = createJam(root, CFG, agent())
    expect((await jam.session({ action: 'start', id: SES })).ok).toBe(true)
    expect(jam.view().session?.id).toBe(SES)
    expect(jam.view().run).toBeTruthy()                                   // the run holds, no capture yet
    expect((await jam.session({ action: 'start', id: 'ses-1792399514740-other1' })).ok).toBe(false)
    const r = rec('make it blue', SES)
    await jam.capture(r)
    expect(card(jam, r.id).session).toBe(SES)
    await jam.act(r.id, card(jam, r.id).rev, 'drop')
    expect((await jam.session({ action: 'end', id: SES })).ok).toBe(true)
    expect(jam.view().session).toBeUndefined()
    expect(jam.view().run).toBeUndefined()
    jam.stop()
    done()
  })

  it('the wrap-up seals what the session was: confirmed and kept captures (not drafts or dropped ones), your instructions first, the talk only if you leave it on; the session ends and the record job is queued', async () => {
    const { root, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent('ok', { hang: true }))
    await jam.session({ action: 'start', id: SES })
    const sent = rec('the badge outline', SES), kept = rec('an idea for later', SES), draft = rec('half said', SES), dropped = rec('never mind', SES), other = rec('not in the session')
    for (const x of [sent, kept, draft, dropped, other]) await jam.capture(x)
    await jam.act(sent.id, card(jam, sent.id).rev, 'confirm')
    await jam.act(kept.id, card(jam, kept.id).rev, 'keep')
    await jam.act(dropped.id, card(jam, dropped.id).rev, 'drop')
    appendTalk(root, SES, [{ w: 'and', at: 5 }, { w: 'the', at: 6 }, { w: 'footer', at: 7 }])
    expect(readTalk(root, SES).map((l) => l.text)).toEqual(['and the footer'])
    const w = await jam.session({ action: 'wrapup', id: SES, instructions: 'lead with the checkout fixes', includeTalk: false, tags: 2, board: 'home' })
    expect(w.ok).toBe(true)
    const wc = w.card!
    expect(wc.kind).toBe('wrapup')
    expect(['queued', 'working']).toContain(card(jam, wc.id).state)
    expect(jam.view().session).toBeUndefined()
    const stored = JSON.parse(readFileSync(join(root, 'design', '.local', 'jam', 'wrapups', `${wc.id}.json`), 'utf8'))
    expect(stored.instructions).toBe('lead with the checkout fixes')
    expect(stored.captures.map((c: any) => c.id).sort()).toEqual([sent.id, kept.id].sort())
    expect(stored.captures.find((c: any) => c.id === kept.id).kept).toBe(true)
    expect(stored.talk).toBeUndefined()
    expect(stored.tags).toBe(2)
    expect(stored.file).toBe(recordFile(root, stored.since, SES))
    jam.stop()
    done()
  })

  it('the record job writes the file and comes back to review (never "asks", it has no thread); the packet carries the sealed content; Looks good is done', async () => {
    const { root, done } = setup()
    mkdirSync(join(root, 'context'), { recursive: true })
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent())
    await jam.session({ action: 'start', id: SES })
    const r = rec('the badge outline', SES)
    await jam.capture(r)
    await jam.act(r.id, card(jam, r.id).rev, 'keep')
    appendTalk(root, SES, [{ w: 'and', at: 5 }, { w: 'more', at: 6 }])
    const w = await jam.session({ action: 'wrapup', id: SES, instructions: 'file it as backlog', includeTalk: true, tags: 0, board: 'home' })
    await jam.tick()
    expect(card(jam, w.card!.id).state).toBe('review')
    const pk = packets(root).find((p) => p.members.some((m: any) => m.brief.wrapup))
    expect(pk.members[0].brief.wrapup.content.talk.map((l: any) => l.text)).toEqual(['and more'])
    const record = jam.record(w.card!.id)!
    expect(record.file).toMatch(/^context\/sessions\/\d{4}-\d{2}-\d{2}-\d{4}-session-abcd12\.md$/)
    expect(record.text).toMatch(/file it as backlog/)
    expect((await jam.act(w.card!.id, card(jam, w.card!.id).rev, 'good')).ok).toBe(true)
    expect(card(jam, w.card!.id).state).toBe('done')
    jam.stop()
    done()
  })

  it('More work on a record writes it again from the same content with your note, following the first; a record changed after its seal never reaches the agent', async () => {
    const { root, done } = setup()
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent())
    await jam.session({ action: 'start', id: SES })
    const w = await jam.session({ action: 'wrapup', id: SES, instructions: 'short please', includeTalk: false, tags: 0, board: 'home' })
    await jam.tick()
    const first = w.card!.id
    expect(card(jam, first).state).toBe('review')
    const m = await jam.act(first, card(jam, first).rev, 'more', 'add the open questions')
    expect(m.ok).toBe(true)
    const next = (m.card as any).id
    // the note is sealed in a wrap-up of its own, the same file as the first
    const sealed = JSON.parse(readFileSync(join(root, 'design', '.local', 'jam', 'wrapups', `${next}.json`), 'utf8'))
    expect(sealed.more).toBe('add the open questions')
    expect(jam.record(next)!.file).toBe(jam.record(first)!.file)
    expect(card(jam, first).state).toBe('done')
    await jam.tick()
    expect(card(jam, next).state).toBe('review')
    const pk = packets(root).filter((p) => p.members.some((x: any) => x.card === next))[0]
    expect(pk.members[0].brief.wrapup.content.more).toBe('add the open questions')
    expect(pk.members[0].brief.follows).toBeTruthy()
    expect(readFileSync(join(root, jam.record(next)!.file), 'utf8')).toMatch(/More: add the open questions/)
    jam.stop()
    done()
  })

  it('a record whose sealed content changed never reaches the agent: refused at claim, and when its run resumes after a restart', async () => {
    const { root, done } = setup()
    // claimed and running (the agent hangs), then the dev server stops and the content is changed
    const jam = createJam(root, { ...CFG, concurrency: 1 }, agent('ok', { hang: true }))
    await jam.session({ action: 'start', id: SES })
    const w = await jam.session({ action: 'wrapup', id: SES, instructions: 'x', includeTalk: false, tags: 0, board: 'home' })
    void jam.tick()
    await new Promise((r) => setTimeout(r, 800))
    expect(card(jam, w.card!.id).state).toBe('working')                    // running when the server stops
    jam.stop()
    const f = join(root, 'design', '.local', 'jam', 'wrapups', `${w.card!.id}.json`)
    writeFileSync(f, readFileSync(f, 'utf8').replace('"x"', '"y"'))
    const again = createJam(root, CFG, agent())
    await again.tick()
    expect(card(again, w.card!.id).state).toBe('failed')
    expect(card(again, w.card!.id).note).toMatch(/changed after it was written/)
    again.stop()
    done()
  })

  it('the record file: context/sessions/ when there is a context, else design/sessions/, named for its session (two sessions in one minute never share one); the talk\'s length in minutes', () => {
    const { root, done } = setup()
    const t = new Date(2026, 9, 19, 14, 5).getTime()
    expect(recordFile(root, t, SES)).toBe('design/sessions/2026-10-19-1405-session-abcd12.md')
    mkdirSync(join(root, 'context'))
    expect(recordFile(root, t, SES)).toBe('context/sessions/2026-10-19-1405-session-abcd12.md')
    expect(recordFile(root, t, 'ses-1792399514739-zzzz99')).not.toBe(recordFile(root, t, SES))
    expect(talkMinutes([{ at: 0, text: 'a' }, { at: 26 * 60_000, text: 'b' }])).toBe(26)
    done()
  })
})
