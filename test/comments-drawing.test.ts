import { describe, expect, it } from 'vitest'
import { DRAW_ELEMENT_TYPES, isDrawAnchor, validDrawAnchor, validElementId } from '../src/shared/anchor.ts'
import { publicCommentEvent, publishableAgentEvent } from '../src/shared/agent-events.ts'
import { commentNotice } from '../src/shared/comment-notices.ts'
import { replay, type CommentEvent } from '../src/shared/events.ts'
import { validateEvents } from '../src/server/collab.ts'
import { shareable } from '../src/server/comments.ts'
import { admitted, unauthorized } from '../src/server/sync.ts'
import { activityJobs } from '../src/server/notify.ts'
import { deriveThreads, unreadCount } from '../src/server/summary.ts'

const owner = { email: 'nic@test.dev', name: 'Nic', role: 'owner' as const, createdAt: 0 }
const reviewer = { email: 'ana@test.dev', name: 'Ana' }
const participant = { email: 'kim@test.dev', name: 'Kim' }
const now = Date.now()
const root: CommentEvent = { id: 'event-root01', type: 'create', ts: now - 1000, commentId: 'thread01', author: reviewer, body: 'Fix this', board: 'main' }
const human: CommentEvent = { id: 'event-human1', type: 'reply', ts: now - 500, commentId: 'message-human1', parentId: root.commentId, author: participant, body: 'Yes', board: 'main' }
const reply: CommentEvent = { id: 'jam-reply01', type: 'reply', ts: now, commentId: 'jam-message01', parentId: root.commentId, author: owner, body: 'Fixed', agent: true, asks: false, board: 'main' }
const edit: CommentEvent = { ...reply, id: 'jam-edit001', type: 'edit', parentId: undefined, body: 'Fixed the flow' }
const anchor = (id = 'checkout:submit'): any => ({ el: { draw: { id, type: 'rectangle', label: 'Submit', rev: 0, epoch: 'test' }, semantics: { tag: 'excalidraw:rectangle', quote: 'Submit' }, hue: 210 }, pos: { fx: 0, fy: 1 } })
const move: CommentEvent = { ...reply, id: 'jam-repin01', type: 'reanchor', parentId: undefined, commentId: root.commentId, body: undefined, asks: undefined, anchor: anchor() }
const caps = { operator: true, agentEvents: true, drawAnchors: true }

describe('drawing anchors (B3)', () => {
  it('accepts opaque ids and every commentable element type, including paper and anchors without pos', () => {
    for (const id of ['checkout:submit', 'x'.repeat(65), 'x'.repeat(256), 'é']) {
      expect(validElementId(id)).toBe(true)
      for (const type of DRAW_ELEMENT_TYPES) expect(validDrawAnchor({ el: { draw: { id, type } } })).toBe(true)
    }
    expect(validDrawAnchor({ el: { draw: { at: { x: -1e6, y: 1e6 }, rev: 0, epoch: 'x'.repeat(32) } } })).toBe(true)
    expect(isDrawAnchor(anchor())).toBe(true)
    expect(isDrawAnchor({ el: { cssPath: '#submit' } })).toBe(false)
  })
  it('refuses every limit without altering the input', () => {
    for (const id of ['', 'x'.repeat(257), 'a\nb', 'a\u007fb', 'a\u0085b']) expect(validElementId(id)).toBe(false)
    const cases = [
      anchor('x'.repeat(257)), anchor('bad\nid'), { el: { draw: null } },
      { el: { draw: { id: 'ok', type: 'selection' } } },
      { el: { draw: { id: 'ok', type: 'rectangle', at: { x: 1, y: 2 } } } },
      ...[-1, 0.1, Infinity, '1'].map((rev) => ({ el: { draw: { id: 'ok', type: 'rectangle', rev } } })),
      { el: { draw: { id: 'ok', type: 'rectangle', epoch: 'x'.repeat(33) } } },
      { el: { draw: { id: 'ok', type: 'rectangle', label: 'x'.repeat(201) } } },
      { el: { draw: { id: 'ok', type: 'rectangle' }, semantics: { quote: 'x'.repeat(201) } } },
      ...['cssPath', 'source'].map((key) => ({ el: { ...anchor().el, [key]: '' } })),
      ...[-0.1, 1.1, Infinity, NaN, '0.2'].map((fx) => ({ ...anchor(), pos: { fx, fy: 0 } })),
      ...[1e6 + 1, Infinity, NaN, '1'].map((x) => ({ el: { draw: { at: { x, y: 0 } } } })),
      { el: { ...anchor().el, hue: '210' } }, { ...anchor(), extra: 'é'.repeat(1024) },
    ]
    for (const a of cases) {
      expect(validDrawAnchor(a), JSON.stringify(a)).toBe(false)
      const e = { ...root, anchor: a }
      expect(validateEvents([e], [], { ...owner, ...reviewer }, 'main')).toMatch(/anchor/)
      expect(unauthorized([e], [], reviewer, caps)).toMatchObject([{ why: 'anchor-refused' }])
      expect(validateEvents([{ ...move, anchor: a }], [root], owner, 'main', { operator: true })).toMatch(/anchor/)
    }
    const boundary = anchor()
    boundary.el.draw.label = 'x'.repeat(200); boundary.el.semantics.quote = 'x'.repeat(200)
    const padding = 2048 - new TextEncoder().encode(JSON.stringify({ ...boundary, pad: '' })).length
    expect(validDrawAnchor({ ...boundary, pad: 'x'.repeat(padding) })).toBe(true)
    expect(validDrawAnchor({ ...boundary, pad: 'x'.repeat(padding + 1) })).toBe(false)
  })
})

describe('one published agent rule (B7)', () => {
  it('agrees at intake, sync and build seeds; re-pins can move another person’s thread', () => {
    const log = [root, human, reply]
    for (const e of [reply, edit, move, { ...edit, type: 'delete' as const, body: undefined, asks: undefined }]) {
      expect(publishableAgentEvent(e, log)).toBe(true)
      expect(validateEvents([e], log.filter((m) => m.id !== e.id), owner, 'main', { operator: true })).toBeNull()
      expect(unauthorized([e], log, owner, caps)).toEqual([])
    }
    expect(shareable([...log, edit, move]).map((e) => e.id)).toEqual([...log, edit, move].map((e) => e.id))
    for (const e of [{ ...root, agent: true }, { ...move, frame: 'other/drawing' }, { ...edit, commentId: human.commentId }, { ...reply, parentId: 'absent-thread' }]) expect(publishableAgentEvent(e, log)).toBe(false)
    for (const flags of [{ agent: true }, { capture: 'capture01' }]) {
      const privateRoot = { ...root, ...flags }
      expect(publishableAgentEvent(reply, [privateRoot])).toBe(false)
      expect(shareable([privateRoot, human, reply, edit, move])).toEqual([])
    }
  })
  it('refuses browser agents, poses, reserved ids, and browser edits/deletes of agent messages', () => {
    expect(validateEvents([reply], [root], owner, 'main')).toBeTruthy()
    for (const type of ['edit', 'delete'] as const) {
      const e = { ...edit, type, id: 'ordinary-event', commentId: 'ordinary-message', agent: undefined, body: type === 'edit' ? 'oops' : undefined, asks: undefined }
      expect(validateEvents([e], [root, { ...reply, commentId: e.commentId }], owner, 'main')).toMatch(/operator agent/)
    }
    for (const name of ['Marver', '@Marver', 'MARVER team', ' Marver bot ']) expect(validateEvents([{ ...root, author: { ...reviewer, name } }], [], { ...owner, ...reviewer }, 'main')).toMatch(/reserved name/)
    for (const e of [{ ...root, id: 'jam-future01' }, { ...root, commentId: 'jam-future01' }]) expect(validateEvents([e], [], { ...owner, ...reviewer }, 'main')).toMatch(/reserved/)
  })
  it('intake keeps remote agent corrections only on the same published message and identity', () => {
    expect(admitted([root, reply], [root, reply, edit])).toContainEqual(edit)
    expect(admitted([root, reply], [root, { ...reply, id: 'different-event' }, edit])).not.toContainEqual(edit)
    expect(admitted([root, reply], [root, { ...reply, author: reviewer }, edit])).not.toContainEqual(edit)
    expect(admitted([root, reply], [root, reply, { ...edit, author: reviewer }])).not.toContainEqual({ ...edit, author: reviewer })
    const humanEdit = { ...edit, id: 'ordinary-edit01', commentId: human.commentId, author: participant }
    expect(admitted([root, human], [root, human, humanEdit])).not.toContainEqual(humanEdit)
    const projected = { ...reply, author: { id: 'a'.repeat(24) } }
    const projectedEdit = { ...edit, author: projected.author }
    expect(admitted([root, reply], [root, projected, projectedEdit], { [owner.email]: projected.author.id })).toContainEqual(projectedEdit)
    expect(admitted([root, reply], [root, projected, projectedEdit])).not.toContainEqual(projectedEdit)
    const forged = { ...root, id: 'jam-claim01' }
    expect(admitted([], [forged])).toEqual([])
    const privateRoot = { ...root, agent: true }
    expect(admitted([privateRoot, reply], [privateRoot, reply, edit])).not.toContainEqual(edit)
  })
  it('publishes only bounded public provenance and never alsoChanged', () => {
    const local = { ...reply, agentMeta: { devUser: 'private machine', harness: 'h'.repeat(81), model: 'M', effort: 'high', runner: 'fork' as const }, alsoChanged: ['/private/file'] }
    const published = publicCommentEvent(local)
    expect(published.agentMeta).toEqual({ harness: 'h'.repeat(80), model: 'M', effort: 'high', runner: 'fork' })
    expect(JSON.stringify(shareable([root, local]))).not.toMatch(/private machine|private\/file|devUser|alsoChanged/)
    expect(local.agentMeta.devUser).toBe('private machine')
  })
})

describe('published notices, unread and mail (A5)', () => {
  const log = [root, human, reply], thread = replay(log)[0]
  it('notifies the author and repliers, never a bystander; only the owner receives a question', () => {
    for (const me of [reviewer, participant]) {
      expect(commentNotice(reply, thread, me, false, false)).toBe('reply')
      expect(commentNotice({ ...reply, asks: true }, thread, me, false, false)).toBe('reply')
      expect(commentNotice(move, thread, me, false, false)).toBeNull()
      expect(commentNotice(edit, thread, me, false, false)).toBeNull()
    }
    expect(commentNotice(reply, thread, owner, false, true)).toBeNull()
    const own = replay([{ ...root, author: owner }, reply])[0]
    expect(commentNotice({ ...reply, asks: true }, own, owner, false, true)).toBe('question')
    expect(commentNotice(reply, own, owner, false, true)).toBe('reply')
    expect(commentNotice({ ...reply, asks: true }, thread, owner, true, true)).toBe('question')
    const state = deriveThreads([...log, edit, move])
    expect(unreadCount(state, human.id, reviewer.email)).toBe(1)
    expect(unreadCount(state, human.id, participant.email)).toBe(1)
    expect(unreadCount(state, human.id, owner.email)).toBe(0)
  })
  it('mails only participants as Marver, excluding early acks, edits, re-pins and historical backfills', () => {
    const jobs = [...activityJobs('main', [reply], log, () => true, now).values()]
    expect(jobs.map((j) => j.recipient).sort()).toEqual([reviewer.email, participant.email].sort())
    expect(jobs.every((j) => j.actor === 'Marver' && j.template === 'reply')).toBe(true)
    for (const e of [edit, move, { ...reply, id: 'jam-early-ack' }, { ...reply, ts: now - 16 * 60_000 }]) expect(activityJobs('main', [e], log, () => true, now).size).toBe(0)
    const owned = [{ ...root, author: owner }, reply]
    expect([...activityJobs('main', [reply], owned, () => true, now).values()].map((j) => j.recipient)).toEqual([owner.email])
  })
})
