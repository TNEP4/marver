import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvents, readLog, replay, type CommentEvent } from '../src/server/comments.ts'
import { validateEvents } from '../src/server/collab.ts'
import { migrateOwnership, ownsMessage, recordOwn } from '../src/server/own.ts'
import { record } from '../src/server/jam/ledger.ts'
import { parseScope, resolveAll, undoResolveAll, type Receipt, type UndoReceipt } from '../src/server/comment-actions.ts'
import { fresh, write as writeJournal } from '../src/server/jam/journal.ts'
import { ctxFor, form, freezeBrief, ingest, liveThreads } from '../src/server/jam/queue.ts'
import { syncOnce } from '../src/server/sync.ts'
import { markSlot } from '../app/pages/strip/needs.ts'
import type { Card } from '../src/server/jam/types.ts'

/**
 * Spec 31 parts B and C, below the browser: tombstones in replay, who owns a message, the published validator, resolve
 * all and its Undo, Jam's skip rule and its tombstone filter, sync against old and new servers, the app tab's dot.
 */

const OWNER = { email: 'nic@local', name: 'Nic' }
const OTHER = { email: 'ana@else', name: 'Ana' }
let clock = 1_700_000_000_000
const t = () => (clock += 10)
const create = (id: string, o: Partial<CommentEvent> = {}): CommentEvent => ({ id: `ev-${id}`, ts: t(), type: 'create', commentId: id, frame: 'demo/hero', board: 'main', author: OWNER, body: `about ${id}`, ...o })
const reply = (id: string, parent: string, o: Partial<CommentEvent> = {}): CommentEvent => ({ id: `ev-${id}`, ts: t(), type: 'reply', commentId: id, parentId: parent, board: 'main', author: OWNER, body: `re ${id}`, ...o })
const del = (id: string, o: Partial<CommentEvent> = {}): CommentEvent => ({ id: `del-${id}-${Math.random().toString(36).slice(2, 8)}`, ts: t(), type: 'delete', commentId: id, board: 'main', author: OWNER, ...o })
const edit = (id: string, body: string, o: Partial<CommentEvent> = {}): CommentEvent => ({ id: `ed-${id}-${Math.random().toString(36).slice(2, 8)}`, ts: t(), type: 'edit', commentId: id, board: 'main', author: OWNER, body, ...o })
const shuffle = <T,>(a: T[]): T[] => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]] } return b }
const temp = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  return { root, dir: join(root, 'design', 'comments'), done: () => rmSync(root, { recursive: true, force: true }) }
}

describe('tombstones (spec 31 C.4)', () => {
  it('a deleted reply is gone; a deleted first comment keeps its replies under a placeholder; with none the thread is gone', () => {
    const evs = [create('a'), reply('a1', 'a'), reply('a2', 'a'), del('a2'), create('b'), reply('b1', 'b'), del('b'), create('c'), del('c')]
    const th = replay(evs)
    expect(th.map((x) => x.id)).toEqual(['a', 'b'])
    expect(th[0].replies.map((r) => r.id)).toEqual(['a1'])
    expect(th[1]).toMatchObject({ id: 'b', deleted: true, body: undefined, author: undefined })
    expect(th[1].replies.map((r) => r.id)).toEqual(['b1'])
    // its last reply deleted too: the thread is gone
    expect(replay([...evs, del('b1')]).map((x) => x.id)).toEqual(['a'])
  })

  it('terminal: a later edit is ignored, an edit marks "edited", a reply after the delete still shows, duplicates are idempotent', () => {
    const a = create('a')
    const e1 = edit('a', 'about a, sharper')
    expect(replay([a, e1])[0]).toMatchObject({ body: 'about a, sharper', edited: e1.ts })
    // an edit that only re-flags `asks` (Jam's) is not "edited"
    expect(replay([a, { ...edit('a', 'x'), body: undefined, asks: true }])[0].edited).toBeUndefined()
    const evs = [a, reply('a1', 'a'), del('a'), edit('a', 'resurrected?'), reply('a2', 'a'), del('a'), del('a')]
    const th = replay(evs)[0]
    expect(th).toMatchObject({ deleted: true, body: undefined })
    expect(th.replies.map((r) => r.id)).toEqual(['a1', 'a2'])
  })

  it('shuffled delivery, clock skew and repeated sync derive the same state', () => {
    const base = [create('a'), reply('a1', 'a'), reply('a2', 'a'), create('b'), reply('b1', 'b')]
    // the delete's clock ran BEHIND the messages it deletes (skew): it applies all the same
    const skewed = [del('a1', { ts: 1_600_000_000_000 }), del('b', { ts: 1_600_000_000_001 }), edit('a2', 'later words')]
    const want = JSON.stringify(replay([...base, ...skewed]))
    for (let i = 0; i < 20; i++) expect(JSON.stringify(replay(shuffle([...base, ...skewed])))).toBe(want)
    const { dir, done } = temp('mv-r31-sync-')
    try {
      appendEvents(dir, 'main', shuffle([...base, ...skewed]))
      appendEvents(dir, 'main', shuffle([...base, ...skewed]))   // the same events again: one of each kept
      appendEvents(dir, 'main', [...skewed])
      expect(JSON.stringify(replay(readLog(dir, 'main')))).toBe(want)
    } finally { done() }
  })
})

describe('who owns a message (spec 31 C.2)', () => {
  it('migration: the ledger, the profile email or (both empty) no email - never a collaborator, never Marver; then the file decides', () => {
    const { root, dir, done } = temp('mv-r31-own-')
    try {
      writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify(OWNER))
      const mine = create('mine')
      const ledgered = create('ledgered', { author: { email: 'old@addr', name: 'Nic before' } })
      const theirs = create('theirs', { author: OTHER })
      const marver = create('marver', { agent: true })
      const myReply = reply('myreply', 'theirs')
      appendEvents(dir, 'main', [mine, ledgered, theirs, marver, myReply])
      record(root, 'main', ledgered.id)
      migrateOwnership(root)
      for (const [id, want] of [['mine', true], ['ledgered', true], ['theirs', false], ['marver', false], ['myreply', true]] as const) expect(ownsMessage(root, 'main', id), id).toBe(want)
      expect(ownsMessage(root, 'other-board', 'mine')).toBe(false)
      // the profile changes (a connect): ownership does not move
      writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify({ name: 'Nic', email: 'ana@else' }))
      migrateOwnership(root)
      expect(ownsMessage(root, 'main', 'theirs')).toBe(false)
      expect(ownsMessage(root, 'main', 'mine')).toBe(true)
      recordOwn(root, 'main', ['later'])
      expect(ownsMessage(root, 'main', 'later')).toBe(true)
      expect(JSON.parse(readFileSync(join(root, 'design', '.local', 'own.json'), 'utf8'))).toMatchObject({ v: 1, migrated: true })
    } finally { done() }
  })

  it('no profile email: a message with no author email is mine, one with an email is not', () => {
    const { root, dir, done } = temp('mv-r31-own2-')
    try {
      appendEvents(dir, 'main', [create('anon', { author: { name: 'You' } }), create('mailed', { author: OTHER })])
      migrateOwnership(root)
      expect(ownsMessage(root, 'main', 'anon')).toBe(true)
      expect(ownsMessage(root, 'main', 'mailed')).toBe(false)
    } finally { done() }
  })
})

describe('the published validator (spec 31 C.4, B.3)', () => {
  const me = { email: OWNER.email, name: 'Nic', role: 'member' as const, createdAt: 0 } as never
  const now = () => Date.now()
  const log: CommentEvent[] = [{ ...create('c-mine01'), ts: now() - 1000 }, { ...create('c-them01', { author: OTHER }), ts: now() - 900 }]
  const ev = (o: Partial<CommentEvent>): CommentEvent => ({ id: `id-${Math.random().toString(36).slice(2, 12)}`, ts: now(), board: 'main', ...o } as CommentEvent)
  it('a delete is the author\'s, carries no words, and makes the message un-editable', () => {
    expect(validateEvents([ev({ type: 'delete', commentId: 'c-mine01', author: { email: OWNER.email } })], log, me, 'main')).toBeNull()
    expect(validateEvents([ev({ type: 'delete', commentId: 'c-them01', author: { email: OWNER.email } })], log, me, 'main')).toMatch(/only the author/)
    expect(validateEvents([ev({ type: 'delete', commentId: 'c-none01', author: { email: OWNER.email } })], log, me, 'main')).toMatch(/does not exist/)
    expect(validateEvents([ev({ type: 'delete', commentId: 'c-mine01', author: { email: OWNER.email }, body: 'x' })], log, me, 'main')).toMatch(/no words/)
    expect(validateEvents([ev({ type: 'delete', commentId: 'c-mine01' })], log, me, 'main')).toMatch(/signed-in account/)
    const gone = [...log, ev({ type: 'delete', commentId: 'c-mine01', author: { email: OWNER.email } })]
    expect(validateEvents([ev({ type: 'edit', commentId: 'c-mine01', author: { email: OWNER.email }, body: 'again' })], gone, me, 'main')).toMatch(/deleted/)
    expect(validateEvents([ev({ type: 'edit', commentId: 'c-mine01', author: { email: OWNER.email }, body: 'again' })], log, me, 'main')).toBeNull()
  })
  it('a resolve-all\'s op rides resolves and reopens only', () => {
    expect(validateEvents([ev({ type: 'resolve', commentId: 'c-them01', op: 'op-12345678' })], log, me, 'main')).toBeNull()
    expect(validateEvents([ev({ type: 'reopen', commentId: 'c-them01', op: 'op-12345678' })], log, me, 'main')).toBeNull()
    expect(validateEvents([ev({ type: 'create', commentId: 'c-new0001', author: { email: OWNER.email }, body: 'hi', op: 'op-12345678' })], log, me, 'main')).toMatch(/op/)
    expect(validateEvents([ev({ type: 'resolve', commentId: 'c-them01', op: 'bad op!' })], log, me, 'main')).toMatch(/op/)
  })
})

/** A canvas on disk: frames, boards (two with route-like names), a folder with a sub-folder, threads on each. */
function canvas() {
  const c = temp('mv-r31-ra-')
  const put = (rel: string, body: string | object) => { const f = join(c.root, rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body)) }
  for (const f of ['spec/alpha', 'spec/bravo', 'lofi/delta', 'lofi/echo', 'other/zulu']) put(`design/scenes/${f}.tsx`, 'export default () => <main />\n')
  put('design/boards/_folders.json', { version: 2, folders: [{ name: 'work' }, { name: 'inner', parent: 'work' }] })
  put('design/boards/main.json', { version: 1, name: 'main', nodes: [{ frame: 'spec/alpha' }, { frame: 'spec/bravo' }] })
  put('design/boards/resolve-all.json', { version: 1, name: 'resolve-all', folder: 'work', nodes: [{ frame: 'lofi/delta' }] })
  put('design/boards/undo.json', { version: 1, name: 'undo', folder: 'inner', nodes: [{ frame: 'lofi/echo' }] })
  writeFileSync(join(c.root, 'design', '.local', 'profile.json'), JSON.stringify(OWNER))
  const th = (board: string, id: string, frame: string, o: Partial<CommentEvent> = {}) => appendEvents(c.dir, board, [create(id, { board, frame, ...o })])
  th('main', 'alpha1', 'spec/alpha'); th('main', 'bravo1', 'spec/bravo', { agent: true })
  th('resolve-all', 'delta1', 'lofi/delta'); th('undo', 'echo1', 'lofi/echo')
  // a thread in one board's log on a frame another board shows: scope is what you see, never a log
  th('main', 'delta2', 'lofi/delta')
  th('main', 'zulu1', 'other/zulu')
  return c
}
const open = (dir: string, board: string) => replay(readLog(dir, board)).filter((x) => !x.resolved).map((x) => x.id).sort()
const ok = <T,>(r: T): Exclude<T, { error: string; status: number }> => { if (r && typeof r === 'object' && 'error' in r) throw new Error((r as { error: string }).error); return r as Exclude<T, { error: string; status: number }> }

describe('resolve all (spec 31 B.1-B.4)', () => {
  it('scopes are exactly one, validated - never the whole canvas by default', () => {
    expect(parseScope({})).toMatch(/exactly one/)
    expect(parseScope(null)).toMatch(/scope/)
    expect(parseScope({ board: 'main', folder: 'work' })).toMatch(/exactly one/)
    expect(parseScope({ board: '../x' })).toMatch(/invalid/)
    expect(parseScope({ canvas: 'yes' })).toMatch(/canvas: true/)
    expect(parseScope({ canvas: true })).toEqual({ canvas: true })
    expect(parseScope({ folder: 'work' })).toEqual({ folder: 'work' })
  })

  it('board, folder (sub-folders included), scene and canvas: what each shows; each resolve in its thread\'s own log, carrying the op', () => {
    const { root, dir, done } = canvas()
    try {
      const r = ok(resolveAll(root, 'op-board-01', { board: 'resolve-all' }))
      expect(r.resolved.map((x) => `${x.board}/${x.thread}`).sort()).toEqual(['main/delta2', 'resolve-all/delta1'])
      expect(open(dir, 'main')).toEqual(['alpha1', 'bravo1', 'zulu1'])
      expect(readLog(dir, 'main').find((e) => e.type === 'resolve' && e.commentId === 'delta2')).toMatchObject({ op: 'op-board-01', board: 'main' })
      const f = ok(resolveAll(root, 'op-folder-1', { folder: 'work' }))
      expect(f.resolved.map((x) => x.thread)).toEqual(['echo1'])     // the sub-folder's board; delta's already resolved
      const s = ok(resolveAll(root, 'op-scene-01', { scene: 'spec' }))
      expect(s.resolved.map((x) => x.thread).sort()).toEqual(['alpha1', 'bravo1'])
      const c = ok(resolveAll(root, 'op-canvas-1', { canvas: true }))
      expect(c.resolved.map((x) => x.thread)).toEqual(['zulu1'])     // on no board, still on the canvas
      expect(resolveAll(root, 'op-nothing1', { board: 'nope' })).toMatchObject({ status: 404 })
      expect(resolveAll(root, 'op-nothing2', { folder: 'nope' })).toMatchObject({ status: 404 })
    } finally { done() }
  })

  it('a retry returns the same receipt and writes nothing twice; a dry run writes nothing', () => {
    const { root, dir, done } = canvas()
    try {
      const dry = ok(resolveAll(root, 'op-dry-0001', { canvas: true }, { dryRun: true }))
      expect(dry.resolved).toHaveLength(6)
      expect(open(dir, 'main')).toHaveLength(4)
      const a = ok(resolveAll(root, 'op-retry-01', { canvas: true }))
      const lines = readFileSync(join(dir, 'main.jsonl'), 'utf8')
      const b = ok(resolveAll(root, 'op-retry-01', { canvas: true }))
      expect(b).toEqual(a)
      expect(readFileSync(join(dir, 'main.jsonl'), 'utf8')).toBe(lines)
      expect(resolveAll(root, 'op-retry-01', { board: 'main' })).toMatchObject({ status: 409 })
      // a crash between its appends and its end: the pending receipt is finished on the same ids
      const p = JSON.parse(readFileSync(join(root, 'design', '.local', 'comment-ops', 'op-retry-01.json'), 'utf8')) as Receipt
      writeFileSync(join(root, 'design', '.local', 'comment-ops', 'op-retry-01.json'), JSON.stringify({ ...p, state: 'pending' }))
      expect(ok(resolveAll(root, 'op-retry-01', { canvas: true })).resolved).toEqual(a.resolved)
      expect(readFileSync(join(dir, 'main.jsonl'), 'utf8')).toBe(lines)
    } finally { done() }
  })

  it('Undo reopens what is unchanged, reports what changed since, and is idempotent', () => {
    const { root, dir, done } = canvas()
    try {
      ok(resolveAll(root, 'op-undo-001', { canvas: true }))
      expect(open(dir, 'main')).toEqual([])
      // since: someone reopened alpha and resolved it again by hand - a different resolve is its latest
      appendEvents(dir, 'main', [{ id: 'by-hand-ro', ts: Date.now() + 100, type: 'reopen', commentId: 'alpha1', board: 'main' }, { id: 'by-hand-rs', ts: Date.now() + 200, type: 'resolve', commentId: 'alpha1', board: 'main' }])
      // ...and bravo was reopened and left open: its latest is a reopen, not the op's resolve
      appendEvents(dir, 'main', [{ id: 'by-hand-r2', ts: Date.now() + 300, type: 'reopen', commentId: 'bravo1', board: 'main' }])
      const u = ok(undoResolveAll(root, 'op-undo-001'))
      expect(u.reopened.map((x) => x.thread).sort()).toEqual(['delta1', 'delta2', 'echo1', 'zulu1'])
      expect(u.changed.map((x) => x.thread).sort()).toEqual(['alpha1', 'bravo1'])
      expect(open(dir, 'main')).toEqual(['bravo1', 'delta2', 'zulu1'])
      expect(readLog(dir, 'main').find((e) => e.type === 'reopen' && e.commentId === 'zulu1')).toMatchObject({ op: 'op-undo-001' })
      const again = ok(undoResolveAll(root, 'op-undo-001'))
      expect(again).toEqual(u)
      expect(undoResolveAll(root, 'op-never-01')).toMatchObject({ status: 404 })
    } finally { done() }
  })

  it('a log copied from another board\'s: the resolve names the board its thread\'s events name, so every reader applies it', () => {
    const { root, dir, done } = canvas()
    try {
      appendEvents(dir, 'undo', [create('copied1', { board: 'elsewhere', frame: 'lofi/echo' })])
      // the shell replays by each event's own board (comments-store derive), the server by the file
      const shell = () => { const by = new Map<string, CommentEvent[]>(); for (const e of readLog(dir, 'undo')) by.set(e.board ?? 'undo', [...(by.get(e.board ?? 'undo') ?? []), e]); return [...by.values()].flatMap((evs) => replay(evs)) }
      const r = ok(resolveAll(root, 'op-copied-1', { board: 'undo' }))
      expect(r.resolved.find((x) => x.thread === 'copied1')).toMatchObject({ board: 'undo', stamp: 'elsewhere' })
      expect(shell().find((x) => x.id === 'copied1')!.resolved).toBe(true)
      expect(open(dir, 'undo')).not.toContain('copied1')
      ok(undoResolveAll(root, 'op-copied-1'))
      expect(shell().find((x) => x.id === 'copied1')!.resolved).toBe(false)
      expect(open(dir, 'undo')).toContain('copied1')
    } finally { done() }
  })

  it('a log that cannot be written is reported with its threads; the other logs still land', () => {
    const { root, dir, done } = canvas()
    try {
      chmodSync(join(dir, 'undo.jsonl'), 0o444)
      const r = ok(resolveAll(root, 'op-partial1', { folder: 'work' }))
      expect(r.failed).toEqual([{ board: 'undo', threads: ['echo1'], error: expect.stringMatching(/EACCES|permission/i) }])
      expect(r.resolved.map((x) => `${x.board}/${x.thread}`).sort()).toEqual(['main/delta2', 'resolve-all/delta1'])
      expect(open(dir, 'resolve-all')).toEqual([])
      chmodSync(join(dir, 'undo.jsonl'), 0o644)
      expect(open(dir, 'undo')).toEqual(['echo1'])
    } finally { done() }
  })

  it('never what Jam is at work on: a queued or working card, or a tag not ingested yet - from the journal on disk too', () => {
    const { root, dir, done } = canvas()
    try {
      const j = fresh()
      const card = (id: string, board: string, thread: string, state: Card['state']): Card => ({ id, kind: 'comment', board, frames: [], thread, events: [], state, made: 1, order: 1, rev: 1, at: 1 })
      j.cards.push(card('c1', 'main', 'alpha1', 'queued'), card('c2', 'main', 'bravo1', 'working'), card('c3', 'main', 'zulu1', 'review'))
      j.seen = readLog(dir, 'main').map((e) => `main|${e.id}`)
      // a tag the page wrote a moment ago: in the log and ledgered, not ingested yet
      const tag = reply('tag1', 'delta2', { body: '@marver make it blue' })
      appendEvents(dir, 'main', [tag]); record(root, 'main', tag.id)
      writeJournal(root, j)
      expect([...liveThreads(j, ctxFor(root))].sort()).toEqual(['main\talpha1', 'main\tbravo1', 'main\tdelta2'])
      const r = ok(resolveAll(root, 'op-jamskip1', { board: 'main' }))
      expect(r.skipped.map((x) => x.thread).sort()).toEqual(['alpha1', 'bravo1'])
      expect(r.resolved.map((x) => x.thread)).toEqual([])     // main shows alpha and bravo only
      const c = ok(resolveAll(root, 'op-jamskip2', { canvas: true }))
      expect(c.skipped.map((x) => x.thread).sort()).toEqual(['alpha1', 'bravo1', 'delta2'])
      expect(c.resolved.map((x) => x.thread).sort()).toEqual(['delta1', 'echo1', 'zulu1'])   // a review card's thread is resolved
      // the running daemon's own answer wins over the file
      const live = ok(resolveAll(root, 'op-jamskip3', { board: 'main' }, { busy: () => new Set() }))
      expect(live.resolved.map((x) => x.thread).sort()).toEqual(['alpha1', 'bravo1'])
    } finally { done() }
  })
})

describe('Jam never reads a deleted message (spec 31 C.5)', () => {
  it('a queued card lets go of a deleted request and is dropped with none left; a brief never carries one', () => {
    const { root, dir, done } = canvas()
    try {
      const ctx = () => ctxFor(root)
      const j = fresh()
      const a = reply('ask1', 'alpha1', { body: '@marver first ask' }), b = reply('ask2', 'alpha1', { body: '@marver second ask' })
      const hist = reply('hist1', 'alpha1', { body: 'context that gets deleted' })
      for (const e of [a, hist, b]) { appendEvents(dir, 'main', [e]); record(root, 'main', e.id) }
      ingest(j, ctx())
      const c = j.cards.find((x) => x.thread === 'alpha1')!
      expect(c.events).toEqual([a.id, b.id])
      appendEvents(dir, 'main', [del('hist1'), del('ask1')])
      ingest(j, ctx())
      expect(c).toMatchObject({ state: 'queued', events: [b.id] })
      const brief = freezeBrief(j, ctx(), c, readLog(dir, 'main'))
      const text = JSON.stringify(brief)
      expect(text).not.toContain('first ask')
      expect(text).not.toContain('context that gets deleted')
      expect(text).toContain('second ask')
      appendEvents(dir, 'main', [del('ask2')])
      ingest(j, ctx())
      expect(c).toMatchObject({ state: 'dropped', note: 'deleted' })
    } finally { done() }
  })

  it('deleted after the claim: the card is dropped at claim time when nothing of it is left', () => {
    const { root, dir, done } = canvas()
    try {
      const j = fresh()
      const a = reply('ask3', 'alpha1', { body: '@marver only ask' })
      appendEvents(dir, 'main', [a]); record(root, 'main', a.id)
      ingest(j, ctxFor(root))
      // the delete lands but is not ingested yet (the claim's own read of the log sees it)
      appendEvents(dir, 'main', [del('ask3')])
      const out = form(j, ctxFor(root), { free: 3, running: new Set(), exclusiveRunning: false, held: () => false, anyHold: () => false })
      expect(out.batches).toEqual([])
      expect(j.cards.find((x) => x.thread === 'alpha1')).toMatchObject({ state: 'dropped', note: 'deleted' })
    } finally { done() }
  })
})

describe('sync against old and new servers (spec 31 C.6)', () => {
  /** A published server, enough of one: `old` has no capabilities route and refuses the type `delete` - the whole batch. */
  async function server(old: boolean) {
    const store: CommentEvent[] = [{ ...create('pub1'), ts: Date.now() - 5000 }]
    const got: CommentEvent[][] = []
    const srv: Server = createServer((req, res) => {
      const send = (status: number, body: unknown, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)) }
      const p = (req.url ?? '').replace(/^\/__mv\/api\//, '')
      if (p === 'capabilities') return old ? send(404, '<html>not found</html>', 'text/html') : send(200, { delete: true })
      if (p === 'boards') return send(200, { rights: { main: 'comment' }, stored: ['main'] })
      if (p === 'comments/main' && req.method === 'GET') return send(200, { events: store })
      if (p === 'comments/main' && req.method === 'POST') {
        let raw = ''
        req.on('data', (c) => { raw += c })
        req.on('end', () => {
          const { events } = JSON.parse(raw) as { events: CommentEvent[] }
          got.push(events)
          if (old && events.some((e) => e.type === 'delete')) return send(400, { error: 'unknown event type "delete"' })
          store.push(...events)
          send(200, { accepted: events.length })
        })
        return
      }
      send(404, { error: 'unknown' })
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as { port: number }).port
    return { url: `http://127.0.0.1:${port}`, got, store, close: () => new Promise<void>((r) => srv.close(() => r())) }
  }

  it('to an older server a delete is held back - never sent, never blocking the batch; to a new one it goes; once upgraded, it follows', async () => {
    const { root, dir, done } = temp('mv-r31-syncold-')
    const old = await server(true), neu = await server(false)
    try {
      const mine = create('mine1'), r1 = reply('mine1r', 'pub1')
      appendEvents(dir, 'main', [mine, r1, del('mine1')])
      const a = await syncOnce(root, { url: old.url, token: 't' })
      expect(a.main.pushed).toBe(2)
      expect(old.got.flat().some((e) => e.type === 'delete')).toBe(false)
      expect(old.store.map((e) => e.id)).toEqual(expect.arrayContaining([mine.id, r1.id]))
      const b = await syncOnce(root, { url: neu.url, token: 't' })
      expect(neu.got.flat().filter((e) => e.type === 'delete')).toHaveLength(1)
      expect(b.main.pushed).toBe(3)
      // the old server pulled into a new client: its events land, nothing is lost or invented
      expect(replay(readLog(dir, 'main')).map((x) => x.id)).toEqual(['pub1'])
    } finally { await old.close(); await neu.close(); done() }
  })
})

describe('the app tab\'s marks (spec 31 B.7)', () => {
  it('needs you: the orange count (99+); new since you looked: a blue dot, no number', () => {
    expect(markSlot({ needs: 3, unseen: 40, working: false, session: false })).toEqual({ cls: 'mk ask', text: '3' })
    expect(markSlot({ needs: 120, unseen: 0, working: false, session: false })).toEqual({ cls: 'mk ask', text: '99+' })
    expect(markSlot({ needs: 0, unseen: 72, working: false, session: false })).toEqual({ cls: 'mk new dot' })
    expect(markSlot({ needs: 0, unseen: 0, working: true, session: false })).toBeNull()
    expect(markSlot(undefined)).toBeNull()
  })
})

// keep the types honest: the receipts as the routes return them
export type { Receipt, UndoReceipt }
