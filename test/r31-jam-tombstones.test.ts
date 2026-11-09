import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendEvents, readLog, type CommentEvent } from '../src/server/comments.ts'
import { createJam } from '../src/server/jam/daemon.ts'
import { claudeAdapter } from '../src/server/jam/adapter/claude.ts'
import { record } from '../src/server/jam/ledger.ts'
import { read as readJournal, write as writeJournal } from '../src/server/jam/journal.ts'
import { buildPacket, packetPath } from '../src/server/jam/packet.ts'
import type { Card, JamAdapter } from '../src/server/jam/types.ts'
import type { JamConfig } from '../src/server/config.ts'

/**
 * Spec 31 C.5: a deleted message never becomes agent input - filtered per message at the hand-off (a card is
 * `working` while its run is set up, and still not handed), at recovery (a frozen packet holding one is rebuilt), and a
 * card with no request left is dropped. The fake agent (fixtures/jam-agent.cjs) writes each packet it reads.
 */

const CFG: JamConfig = { agent: 'claude', concurrency: 3, subagents: true, proactive: false, chime: true, capture: 'confirm', loc: true, names: false, runner: 'background', session: false, context: 'fresh', mcp: true, skills: true, others: true, sessionMax: 3 }
const AGENT = fileURLToPath(new URL('./fixtures/jam-agent.cjs', import.meta.url))
const OWNER = { email: 'nic@local', name: 'Nic' }
const agent = (): JamAdapter => ({
  name: 'claude', supportsSubagents: true,
  spawnArgs(goal) {
    const file = /design\/\.local\/jam\/packets\/[\w-]+\.json/.exec(goal)![0]
    return { cmd: process.execPath, args: [AGENT, file], env: { MODE: JSON.stringify('ok'), OPTS: JSON.stringify({}) } }
  },
  parse: claudeAdapter.parse,
})
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'mv-r31-jam-'))
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify(OWNER))
  return { root, dir: join(root, 'design', 'comments'), done: () => rmSync(root, { recursive: true, force: true }) }
}
let clock = Date.now()
const tick = () => (clock = Math.max(clock + 10, Date.now()))
function say(root: string, dir: string, body: string, o: { thread?: string; id?: string } = {}): CommentEvent {
  const id = o.id ?? `e${Math.random().toString(36).slice(2, 10)}`
  const ev: CommentEvent = o.thread
    ? { id, ts: tick(), type: 'reply', commentId: `rc-${id}`, parentId: o.thread, board: 'home', author: OWNER, body }
    : { id, ts: tick(), type: 'create', commentId: id, frame: 'demo/hero', board: 'home', author: OWNER, body }
  appendEvents(dir, 'home', [ev])
  record(root, 'home', id)
  return ev
}
const remove = (dir: string, of: CommentEvent) => appendEvents(dir, 'home', [{ id: `del-${of.id}`, ts: tick(), type: 'delete', commentId: of.commentId, board: 'home', author: OWNER }])
const packets = (root: string) => existsSync(join(root, 'packets-seen.jsonl'))
  ? readFileSync(join(root, 'packets-seen.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const cardOf = (jam: { snapshot(): { cards: Card[] } }, ev: CommentEvent) => jam.snapshot().cards.find((c) => c.id === `c-${ev.id}` || c.events.includes(ev.id))
const settle = async (jam: { snapshot(): { cards: Card[] } }) => { for (let i = 0; i < 100 && jam.snapshot().cards.some((c) => c.state === 'working' || c.state === 'queued'); i++) await wait(100) }

describe('Jam never reads a deleted message (spec 31 C.5)', () => {
  it('deleted after the claim, before the hand-off: out of the packet, per message - its card dropped, the other still runs as m1', async () => {
    const { root, dir, done } = setup()
    let deleted = false
    let a: CommentEvent, ctx: CommentEvent
    // the run lights its frames before it hands the packet to the agent: the deletes land right then
    const jam = createJam(root, CFG, agent(), undefined, { work: (_f, on) => { if (on && !deleted) { deleted = true; remove(dir, a); remove(dir, ctx) } } })
    a = say(root, dir, '@marver make the wallet first')
    ctx = say(root, dir, 'some context that gets deleted', { thread: a.commentId })
    const b = say(root, dir, '@marver tighten the header')
    await jam.tick(); await settle(jam); jam.stop()
    expect(deleted).toBe(true)
    const seen = packets(root)
    expect(seen).toHaveLength(1)
    expect(seen[0].members.map((m: any) => [m.id, m.card])).toEqual([['m1', `c-${b.id}`]])
    const text = JSON.stringify(seen[0])
    expect(text).not.toContain('wallet first')
    expect(text).not.toContain('context that gets deleted')
    expect(cardOf(jam, a!)).toMatchObject({ state: 'dropped', note: 'deleted' })
    expect(cardOf(jam, b)!.state).toBe('done')
    done()
  }, 30_000)

  it('every request deleted before the hand-off: no agent runs, the card is dropped, the run ends', async () => {
    const { root, dir, done } = setup()
    let deleted = false
    let a: CommentEvent
    const jam = createJam(root, CFG, agent(), undefined, { work: (_f, on) => { if (on && !deleted) { deleted = true; remove(dir, a) } } })
    a = say(root, dir, '@marver only this')
    await jam.tick(); await settle(jam); jam.stop()
    expect(packets(root)).toEqual([])
    expect(cardOf(jam, a)).toMatchObject({ state: 'dropped', note: 'deleted' })
    expect(jam.snapshot().batches.every((x) => x.state !== 'claimed')).toBe(true)
    done()
  }, 30_000)

  it('deleted after a failed attempt: the next attempt\'s packet leaves it out', async () => {
    const { root, dir, done } = setup()
    let n = 0
    let a: CommentEvent, b: CommentEvent
    // the first attempt deletes a's message (as if you did, while it ran) and fails; the second is the real fake agent
    const flaky: JamAdapter = { ...agent(), spawnArgs(goal) {
      if (n++ === 0) return { cmd: process.execPath, args: ['-e', `require('fs').appendFileSync('design/comments/home.jsonl', JSON.stringify({ id: 'del-x1', ts: Date.now(), type: 'delete', commentId: ${JSON.stringify('PLACEHOLDER')}, board: 'home', author: { email: 'nic@local', name: 'Nic' } }) + '\\n'); process.exit(1)`] }
      return agent().spawnArgs(goal)
    } }
    const jam = createJam(root, CFG, { ...flaky, spawnArgs(goal) { const r = flaky.spawnArgs(goal); return { ...r, args: r.args.map((x) => x.replace('"PLACEHOLDER"', JSON.stringify(a.commentId))) } } })
    a = say(root, dir, '@marver first ask, deleted mid-run')
    b = say(root, dir, '@marver second ask stays')
    await jam.tick(); await settle(jam); jam.stop()
    expect(n).toBeGreaterThanOrEqual(2)
    const seen = packets(root)
    expect(seen).toHaveLength(1)
    expect(JSON.stringify(seen[0])).not.toContain('deleted mid-run')
    expect(seen[0].members.map((m: any) => [m.id, m.card])).toEqual([['m1', `c-${b.id}`]])
    expect(cardOf(jam, a)).toMatchObject({ state: 'dropped', note: 'deleted' })
    done()
  }, 30_000)

  it('at recovery: a frozen packet holding a deleted message is rebuilt, never reused', async () => {
    const { root, dir, done } = setup()
    const a = say(root, dir, '@marver one gone')
    const b = say(root, dir, '@marver two stays')
    const h = say(root, dir, 'history gone too', { thread: b.commentId })
    const j = readJournal(root)
    j.baselined = true
    j.seen = readLog(dir, 'home').map((e) => `home|${e.id}`)
    const now = Date.now()
    const brief = (e: CommentEvent, history: CommentEvent[] = []) => ({ asks: [{ id: e.id, owner: true, rev: e.id, body: e.body!, ts: e.ts }], history: history.map((x) => ({ id: x.id, owner: true, rev: x.id, body: x.body!, ts: x.ts })) })
    const card = (e: CommentEvent, history: CommentEvent[] = []): Card => ({ id: `c-${e.id}`, kind: 'comment', board: 'home', frames: ['demo/hero'], thread: e.commentId, events: [e.id], state: 'working', batch: 'b-2', made: e.ts, order: e.ts, rev: 2, at: now, brief: brief(e, history) })
    j.cards.push(card(a), card(b, [h]))
    j.batches.push({ batchId: 'b-2', members: [{ id: 'm1', card: `c-${a.id}`, board: 'home', brief: brief(a) }, { id: 'm2', card: `c-${b.id}`, board: 'home', brief: brief(b, [h]) }], frames: ['demo/hero'], state: 'claimed', leaseUntil: 0, attempts: 1, at: now })
    mkdirSync(join(root, 'design', '.local', 'jam', 'packets'), { recursive: true })
    const pm = (e: CommentEvent, id: string, history: CommentEvent[] = []) => ({ id, card: `c-${e.id}`, kind: 'comment' as const, board: 'home', thread: e.commentId, frames: ['demo/hero'], brief: brief(e, history) })
    writeFileSync(join(root, packetPath('b-2')), JSON.stringify(buildPacket('b-2', [pm(a, 'm1'), pm(b, 'm2', [h])], ['demo/hero'])))
    writeJournal(root, j)
    // deleted while the server was down
    remove(dir, a); remove(dir, h)
    const jam = createJam(root, CFG, agent())
    await jam.tick(); await settle(jam); jam.stop()
    expect(cardOf(jam, a)).toMatchObject({ state: 'dropped', note: 'deleted' })
    const seen = packets(root)
    expect(seen[0].members.map((m: any) => [m.id, m.card])).toEqual([['m1', `c-${b.id}`]])
    expect(JSON.stringify(seen[0])).not.toMatch(/one gone|history gone/)
    expect(JSON.stringify(cardOf(jam, b)!.brief)).not.toMatch(/history gone/)
    expect(cardOf(jam, b)!.state).toBe('done')
    done()
  }, 30_000)
})
