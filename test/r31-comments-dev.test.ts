import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CLI, fixtureRoot, startDev, type Dev } from './dev-server.ts'
import { appendEvents, readLog, replay, type CommentEvent } from '../src/server/comments.ts'

/**
 * Spec 31 B and C through a real `marver dev` (port 5631): the routes that cannot collide with a board name (boards
 * called `resolve-all` and `undo`), the owner gate, capabilities, who owns a message (the migration at start, the
 * record of every write), edit and delete held to it, and the CLI's `resolve --all` with and without the dev server.
 */

const OWNER = { email: 'nic@local', name: 'Nic' }
let root = ''
let dev: Dev | null = null
const C = 'r31testtoken'
const gate = { cookie: `mv_c=${C}`, 'x-mv-c': C, 'content-type': 'application/json' }
const put = (rel: string, body: string | object) => { const f = join(root, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2)) }
const api = async (path: string, body?: unknown, headers: Record<string, string> = gate) => {
  const r = await fetch(`${dev!.origin}/__mv/api/${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: r.status, data: await r.json().catch(() => null) as any }
}
const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, 'comments', ...args, '--root', root], { encoding: 'utf8', env: { ...process.env, CI: '1' } })
const dir = () => join(root, 'design', 'comments')
const open = (board: string) => replay(readLog(dir(), board)).filter((t) => !t.resolved).map((t) => t.id).sort()
let n = 0
const id = (p: string) => `${p}-${Date.now().toString(36)}-${++n}`

beforeAll(async () => {
  root = fixtureRoot('mv-r31-dev-')
  put('design/config.ts', 'export default { jam: false }\n')
  for (const f of ['spec/alpha', 'spec/bravo', 'lofi/delta']) put(`design/scenes/${f}.tsx`, 'export default () => <main><h1>x</h1></main>\n')
  put('design/boards/main.json', { version: 1, name: 'main', nodes: [{ frame: 'spec/alpha' }, { frame: 'spec/bravo' }] })
  put('design/boards/resolve-all.json', { version: 1, name: 'resolve-all', nodes: [{ frame: 'lofi/delta' }] })
  put('design/boards/undo.json', { version: 1, name: 'undo', nodes: [{ frame: 'spec/bravo' }] })
  put('design/.local/profile.json', OWNER)
  // written before 0.31: the owner's own note (by its email), and a collaborator's that synced in
  const t0 = Date.now() - 60_000
  appendEvents(dir(), 'main', [
    { id: 'old-mine-e', ts: t0, type: 'create', commentId: 'old-mine', board: 'main', frame: 'spec/alpha', author: OWNER, body: 'mine from before' },
    { id: 'old-theirs-e', ts: t0 + 1, type: 'create', commentId: 'old-theirs', board: 'main', frame: 'spec/alpha', author: { email: 'ana@else', name: 'Ana' }, body: 'theirs' },
  ])
  dev = await startDev(root, { args: ['--port', '5631'], env: { MARVER_NO_UPDATE_CHECK: '1' } })
}, 90_000)

afterAll(async () => {
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('the dev server (spec 31 B.4, C.2-C.6)', () => {
  it('says what it takes, and who wrote what here: the migration at start, then every write', async () => {
    expect((await api('capabilities', undefined, {})).data).toEqual({ delete: true, resolveAll: true })
    expect((await api('comment-ownership', undefined, {})).status).toBe(403)
    // the profile changes after the start (a connect, a new email): what the start recorded stands
    put('design/.local/profile.json', { email: 'someone@new', name: 'Nic' })
    const own = (await api('comment-ownership')).data.boards
    put('design/.local/profile.json', OWNER)
    expect(own.main).toEqual(['old-mine'])
    const c = id('c')
    expect((await api('comments/main', { events: [{ id: id('e'), ts: Date.now(), type: 'create', commentId: c, frame: 'spec/alpha', body: 'new one' }] })).status).toBe(200)
    expect((await api('comment-ownership')).data.boards.main).toEqual(expect.arrayContaining(['old-mine', c]))
    // a board called `own` is just a board
    expect((await api('comments/own')).status).toBe(200)
  })

  it('edit and delete: yours only, a deleted message is not edited, the edit needs words', async () => {
    const edit = (commentId: string, body: string) => api('comments/main', { events: [{ id: id('ed'), ts: Date.now(), type: 'edit', commentId, body }] })
    const del = (commentId: string) => api('comments/main', { events: [{ id: id('dl'), ts: Date.now(), type: 'delete', commentId }] })
    expect((await edit('old-mine', 'mine, sharper')).status).toBe(200)
    expect(replay(readLog(dir(), 'main')).find((t) => t.id === 'old-mine')).toMatchObject({ body: 'mine, sharper', edited: expect.any(Number) })
    expect((await edit('old-theirs', 'hijack')).status).toBe(403)
    // an event naming another board's log is refused (it would pass these checks here and be read as that board's)
    expect((await api('comments/main', { events: [{ id: id('xb'), ts: Date.now(), type: 'delete', commentId: 'old-mine', board: 'resolve-all' }] })).status).toBe(400)
    expect((await del('old-theirs')).status).toBe(403)
    expect((await edit('old-mine', '   ')).status).toBe(400)
    expect((await del('old-mine')).status).toBe(200)
    expect(readLog(dir(), 'main').find((e) => e.type === 'delete')).toMatchObject({ commentId: 'old-mine', author: { email: OWNER.email } })
    expect((await edit('old-mine', 'back?')).status).toBe(409)
    // the page never gets the deleted words back
    expect(JSON.stringify((await api('comments/main')).data)).not.toContain('mine, sharper')
    expect(JSON.stringify((await api('comments/main')).data)).not.toContain('mine from before')
    // a new message reusing another's id is refused - it would make theirs "mine"
    expect((await api('comments/main', { events: [{ id: id('dup'), ts: Date.now(), type: 'reply', commentId: 'old-theirs', parentId: 'old-theirs', body: 'mine now' }] })).status).toBe(409)
    expect((await api('comment-ownership')).data.boards.main).not.toContain('old-theirs')
    expect((await edit('old-theirs', 'hijack')).status).toBe(403)
    expect(replay(readLog(dir(), 'main')).some((t) => t.id === 'old-mine')).toBe(false)
  })

  it('a capture\'s own comment is never edited here - Jam holds its words; it can still be deleted', async () => {
    const c = id('capc')
    expect((await api('comments/main', { events: [{ id: id('e'), ts: Date.now(), type: 'create', commentId: c, frame: 'spec/alpha', capture: 'cap-1700000000001-beef', body: 'what I said' }] })).status).toBe(200)
    expect(readLog(dir(), 'main').find((e) => e.commentId === c && e.type === 'create')).toMatchObject({ capture: 'cap-1700000000001-beef' })
    const r = await api('comments/main', { events: [{ id: id('ed'), ts: Date.now(), type: 'edit', commentId: c, body: 'not what the agent gets' }] })
    expect(r.status).toBe(409)
    expect(replay(readLog(dir(), 'main')).find((t) => t.id === c)?.body).toBe('what I said')
    expect((await api('comments/main', { events: [{ id: id('dl'), ts: Date.now(), type: 'delete', commentId: c }] })).status).toBe(200)
  })

  it('with Jam off, a withdrawn capture\'s record is not served (its own comment deleted - read from the files)', async () => {
    const capId = 'cap-1700000000000-abcd'
    put(`design/.local/jam/captures/${capId}.json`, { format: 'marver.jam.capture', v: 1, id: capId, context: { canvas: 'x', board: 'main' }, view: {}, timeline: [{ at: 1, event: 'words', text: 'the withdrawn words' }], pictures: [] })
    appendEvents(dir(), 'main', [{ id: 'capc-ev-1', ts: Date.now(), type: 'create', commentId: 'capc-th-1', board: 'main', frame: 'spec/alpha', author: OWNER, capture: capId, body: 'the withdrawn words' }])
    expect((await api(`jam/capture?id=${capId}`)).status).toBe(200)
    appendEvents(dir(), 'main', [{ id: 'capc-del-1', ts: Date.now(), type: 'delete', commentId: 'capc-th-1', board: 'main', author: OWNER }])
    const r = await api(`jam/capture?id=${capId}`)
    expect(r.status).toBe(410)
    expect(JSON.stringify(r.data)).not.toContain('withdrawn words')
  })

  it('resolve-all routes cannot collide with boards named resolve-all and undo; scopes validated; owner-gated', async () => {
    const thread = async (board: string, frame: string) => { const c = id('t'); expect((await api(`comments/${board}`, { events: [{ id: id('e'), ts: Date.now(), type: 'create', commentId: c, frame, body: 'x' }] })).status).toBe(200); return c }
    const ra = await thread('resolve-all', 'lofi/delta'), un = await thread('undo', 'spec/bravo'), mb = await thread('main', 'spec/bravo')
    expect((await api(`comments/resolve-all`)).data.events.length).toBeGreaterThan(0)
    expect((await api(`comments/undo`)).data.events.length).toBeGreaterThan(0)
    expect((await api('comment-actions/resolve-all', { op: id('op'), scope: {} })).status).toBe(400)
    expect((await api('comment-actions/resolve-all', { op: id('op') })).status).toBe(400)
    expect((await api('comment-actions/resolve-all', { op: id('op'), scope: { board: 'main', scene: 'spec' } })).status).toBe(400)
    expect((await api('comment-actions/resolve-all', { op: 'x', scope: { board: 'main' } })).status).toBe(400)
    expect((await api('comment-actions/resolve-all', { op: id('op'), scope: { board: 'undo' } }, { 'content-type': 'application/json' })).status).toBe(403)
    const op = id('op')
    const r = await api('comment-actions/resolve-all', { op, scope: { board: 'undo' } })
    expect(r.status).toBe(200)
    // board `undo` shows spec/bravo: its own thread and the one in main's log on that frame - nothing else
    expect(r.data.resolved.map((x: any) => x.thread).sort()).toEqual([mb, un].sort())
    expect(r.data.summary).toBe('Resolved 2 conversations')
    expect(open('resolve-all')).toEqual([ra])
    // the same op again: the same receipt
    expect((await api('comment-actions/resolve-all', { op, scope: { board: 'undo' } })).data.resolved).toEqual(r.data.resolved)
    const u = await api('comment-actions/undo', { op })
    expect(u.status).toBe(200)
    expect(u.data.summary).toBe('Reopened 2 (finished Jam items stay finished)')
    expect(open('undo')).toEqual([un])
    expect((await api('comment-actions/undo', { op: id('never') })).status).toBe(404)
  })

  it('the CLI: --dry-run counts, --all goes through dev with the dev token, --undo reopens; without dev it works alone', async () => {
    const before = open('main')
    expect(before.length).toBeGreaterThan(0)
    const dry = cli('resolve', '--all', '--board', 'main', '--dry-run')
    expect(dry).toMatch(/board main: \d+ open conversations? would be resolved/)
    expect(open('main')).toEqual(before)
    expect(() => cli('resolve', '--all')).toThrow(/exactly one scope/)
    expect(() => cli('resolve', '--all', '--board', 'main', '--canvas')).toThrow(/exactly one scope/)
    const out = cli('resolve', '--all', '--canvas')
    expect(out).toMatch(/Resolved \d+ conversations?/)
    const op = /resolve --undo ([\w-]+)/.exec(out)![1]
    expect(readFileSync(join(root, 'design', '.local', 'comment-ops', `${op}.json`), 'utf8')).toContain('"state": "done"')
    expect(open('main')).toEqual([])
    expect(cli('resolve', '--undo', op)).toMatch(/Reopened \d+/)
    expect(open('main')).toEqual(before)
    await dev!.stop()
    // a dev that says it runs but does not answer: refused, never worked around from here
    put('design/.local/dev.json', { port: 5639, token: 'x', pid: process.pid })
    expect(() => cli('resolve', '--all', '--board', 'main')).toThrow(/did not answer/)
    expect(replay(readLog(dir(), 'main')).filter((t) => t.frame === 'spec/alpha' || t.frame === 'spec/bravo').some((t) => !t.resolved)).toBe(true)
    rmSync(join(root, 'design', '.local', 'dev.json'))
    const alone = cli('resolve', '--all', '--board', 'main')
    expect(alone).toMatch(/Resolved \d+ conversations? .*\(board main\)/)
    expect(replay(readLog(dir(), 'main')).filter((t) => t.frame === 'spec/alpha' || t.frame === 'spec/bravo').every((t) => t.resolved)).toBe(true)
  }, 60_000)
})

export type { CommentEvent }
