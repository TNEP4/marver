import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { commentRequest } from './comment-http.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimInvite, createInvite, issueDeviceSession } from '../src/server/auth.ts'
import { collabHandler } from '../src/server/collab.ts'
import { appendEvents, readLog, type CommentEvent } from '../src/server/comments.ts'

let root: string, data: string, handler: ReturnType<typeof collabHandler>, owner: string, member: string, operator: string
const tokenWas = process.env.MARVER_CLI_TOKEN
const ownerAuthor = { email: 'owner@test.dev', name: 'Owner' }
const memberAuthor = { email: 'member@test.dev', name: 'Member' }
const id = () => crypto.randomUUID()
const event = (overrides: Partial<CommentEvent> = {}): CommentEvent => ({ id: id(), ts: Date.now(), type: 'create', commentId: id(), board: 'main', author: memberAuthor, body: 'Submit', frame: 'checkout/flow', nodeKey: 'drawing01', ...overrides })
const anchor = { el: { draw: { id: 'checkout:submit', type: 'rectangle' } } }
const request = (session: string, path: string, body?: unknown, browser = false) => commentRequest(handler, path, body, {
  ...(browser ? { cookie: `mv_s=${session}; mv_c=csrf`, 'x-mv-c': 'csrf' } : { authorization: `Bearer ${session}` }), 'content-type': 'application/json',
})
const post = (session: string, events: CommentEvent[], browser = false) => request(session, 'comments/main', { events }, browser)

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-draw-comments-collab-')); data = join(root, 'data')
  const dist = join(root, 'dist')
  mkdirSync(join(dist, '__mv/draw-data/checkout'), { recursive: true })
  writeFileSync(join(dist, '__mv/draw-data/checkout/flow.excalidraw'), '{}')
  writeFileSync(join(dist, 'meta.json'), JSON.stringify({ rights: { main: 'comment' }, shows: { main: ['checkout/flow', 'checkout/missing'] }, boards: { main: { nodes: { drawing01: { frame: 'checkout/flow' } } } } }))
  owner = claimInvite(data, createInvite(data, ownerAuthor.email).token, { password: 'password-long-enough', name: ownerAuthor.name }).session
  member = claimInvite(data, createInvite(data, memberAuthor.email).token, { password: 'password-long-enough', name: memberAuthor.name }).session
  process.env.MARVER_CLI_TOKEN = 't'.repeat(48)
  operator = issueDeviceSession(data, process.env.MARVER_CLI_TOKEN)!.token
  handler = collabHandler(data, dist)
}, 15_000)
afterAll(async () => {
  if (tokenWas === undefined) delete process.env.MARVER_CLI_TOKEN; else process.env.MARVER_CLI_TOKEN = tokenWas
  rmSync(root, { recursive: true, force: true })
})

describe('published drawing comments and the operator boundary', () => {
  it('advertises the new capabilities only to the operator bearer transport', async () => {
    expect(await (await request(operator, 'capabilities')).json()).toEqual({ delete: true, agentEvents: true, drawAnchors: true })
    for (const [session, browser] of [[owner, false], [owner, true], [member, false], [operator, true]] as const) expect(await (await request(session, 'capabilities', undefined, browser)).json()).toEqual({ delete: true })
  })
  it('binds a create to a drawing published on that board, and its node where metadata is available', async () => {
    expect((await post(member, [event({ anchor })])).status).toBe(200)
    for (const overrides of [{ frame: 'checkout/elsewhere' }, { frame: 'checkout/missing' }, { nodeKey: 'wrong-node' }, { nodeKey: undefined }, { anchor: { el: { draw: { id: 'x'.repeat(257), type: 'rectangle' } } } }]) expect((await post(member, [event({ anchor, ...overrides })])).status).toBe(400)
  })
  it('refuses a reviewer’s reserved id, then accepts Marver’s reply with it; browser agents and edits never land', async () => {
    const rootEvent = event()
    expect((await post(member, [rootEvent])).status).toBe(200)
    const reserved = `jam-${id()}`
    expect((await post(member, [event({ id: reserved })])).status).toBe(400)
    expect((await post(member, [event({ commentId: reserved })])).status).toBe(400)
    const reply = event({ id: reserved, commentId: reserved, type: 'reply', parentId: rootEvent.commentId, author: ownerAuthor, agent: true, frame: undefined, nodeKey: undefined })
    for (const [session, browser] of [[owner, false], [owner, true], [operator, true]] as const) expect((await post(session, [reply], browser)).status).toBe(400)
    expect((await post(operator, [reply])).status).toBe(200)
    expect((await post(operator, [reply])).status).toBe(200)
    expect((await post(owner, [reply], true)).status).toBe(400)
    for (const type of ['edit', 'delete'] as const) expect((await post(owner, [event({ type, commentId: reserved, author: ownerAuthor, body: type === 'edit' ? 'oops' : undefined })], true)).status).toBe(400)
    const edit = event({ type: 'edit', commentId: reserved, author: ownerAuthor, agent: true, body: 'Corrected' })
    expect((await post(operator, [edit])).status).toBe(200)
    expect((await post(operator, [event({ type: 'reanchor', commentId: rootEvent.commentId, author: ownerAuthor, agent: true, frame: undefined, anchor })])).status).toBe(200)
    expect(readLog(join(data, 'comments'), 'main').find((e) => e.id === reserved)?.agent).toBe(true)
  })
  it('refuses posed author, claim and profile names', async () => {
    expect((await post(member, [event({ author: { ...memberAuthor, name: '@Marver team' } })])).status).toBe(400)
    expect((await request(owner, 'profile', { name: 'Marver' }, true)).status).toBe(400)
    const invite = createInvite(data, 'poser@test.dev')
    expect((await request('', 'auth/claim', { token: invite.token, password: 'password-long-enough', name: 'MARVER bot' })).status).toBe(400)
    // A page can change accounts without reloading: the sign-in answer must reset who may see questions.
    for (const [email, role] of [[ownerAuthor.email, 'owner'], [memberAuthor.email, 'member']]) {
      const signedIn = await request('', 'auth/signin', { email, password: 'password-long-enough' })
      expect((await signedIn.json() as { role: string }).role).toBe(role)
    }
  })
  it('projects historical agent metadata without devUser, excess fields or alsoChanged', async () => {
    const e = event({ agent: true, agentMeta: { devUser: 'Private machine', harness: 'h'.repeat(90), model: 'model', runner: 'fresh' }, alsoChanged: ['/private/source'] })
    appendEvents(join(data, 'comments'), 'main', [e])
    const { events } = await (await request(member, 'comments/main')).json() as { events: CommentEvent[] }
    const got = events.find((m) => m.id === e.id)!
    expect(got.agentMeta).toEqual({ harness: 'h'.repeat(80), model: 'model', runner: 'fresh' })
    expect(JSON.stringify(got)).not.toMatch(/devUser|Private machine|alsoChanged|private\/source/)
    const forged = event({ author: { ...memberAuthor, agent: true } as CommentEvent['author'] })
    expect((await post(member, [forged])).status).toBe(400)
    appendEvents(join(data, 'comments'), 'main', [forged])
    const historical = await (await request(member, 'comments/main')).json() as { events: CommentEvent[] }
    expect(historical.events.find((m) => m.id === forged.id)?.author).not.toHaveProperty('agent')
  })
})
