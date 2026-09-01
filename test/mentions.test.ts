import { describe, expect, it } from 'vitest'
import { mentionPeople, mentionQueryAt, mentionsIn, parseBody } from '../src/client/shell/mentions.ts'
import { activityJobs, transitionId } from '../src/server/notify.ts'
import { validateEvents } from '../src/server/collab.ts'
import type { CommentEvent } from '../src/shared/events.ts'

/** Sharing v1.1 - the pure halves: body segmentation (one segmentation drives
 *  highlight AND the mentions a send derives), the fan-out rules, and the
 *  validator's mention/body tightenings. */

const ev = (over: Partial<CommentEvent>): CommentEvent =>
  ({ id: crypto.randomUUID(), ts: Date.now(), type: 'create', commentId: crypto.randomUUID(), body: 'x', ...over }) as CommentEvent

describe('mentionPeople - the mentionable set', () => {
  const events: CommentEvent[] = [
    ev({ author: { id: 'a'.repeat(24), name: 'Dana' } }),
    ev({ type: 'reply', parentId: 'r', author: { id: 'b'.repeat(24), name: 'Sam' } }),
    ev({ type: 'reply', parentId: 'r', author: { id: 'a'.repeat(24), name: 'Dana' } }),          // dedupe
    ev({ author: { id: 'c'.repeat(24), name: 'Marver' } }),                                      // reserved name
    ev({ agent: true, author: { id: 'd'.repeat(24), name: 'Agent' } } as any),                   // agent events never mention-source
    ev({ type: 'resolve' }),                                                                     // no author leg
    ev({ author: { id: 'e'.repeat(24), name: 'Quiet' }, mentions: [{ id: 'f'.repeat(24), label: 'Named Once' }] }),
  ]
  it('collects distinct named humans, past mention targets, skips agent/reserved/self', () => {
    const people = mentionPeople(events, { id: 'b'.repeat(24) })
    expect(people.map((p) => p.label)).toEqual(['Dana', 'Quiet', 'Named Once'])
  })
  it('keys dev people by email', () => {
    const dev = mentionPeople([ev({ author: { email: 'n@x.co', name: 'Nic' } })])
    expect(dev).toEqual([{ label: 'Nic', id: undefined, email: 'n@x.co', avatar: undefined }])
    expect(mentionPeople([ev({ author: { email: 'n@x.co', name: 'Nic' } })], { email: 'n@x.co' })).toEqual([])
  })
})

describe('parseBody + mentionsIn - one segmentation, two consumers', () => {
  const people = [
    { label: 'Sam', id: '1'.repeat(24) },
    { label: 'Sam Altman', id: '2'.repeat(24) },
    { label: 'Aña (QA)', email: 'ana@x.co' },
  ]
  it('longest label wins at a position; boundaries hold; @marver survives', () => {
    const segs = parseBody('hey @Sam Altman and @Sam and @Samuel, ask @marver', people)
    expect(segs.filter((s) => s.person).map((s) => s.text)).toEqual(['@Sam Altman', '@Sam'])
    expect(segs.find((s) => s.marver)?.text).toBe('@marver')
    expect(segs.map((s) => s.text).join('')).toBe('hey @Sam Altman and @Sam and @Samuel, ask @marver')
  })
  it('is case-insensitive and regex-safe', () => {
    expect(parseBody('ping @aña (qa)!', people).find((s) => s.person)?.person?.email).toBe('ana@x.co')
  })
  it('derives the event mentions from the same segmentation, deduped and capped', () => {
    expect(mentionsIn('@Sam @Sam again', people)).toEqual([{ id: '1'.repeat(24), label: 'Sam' }])
    expect(mentionsIn('no one here', people)).toBeUndefined()
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `P${i}x`, id: String(i).repeat(2).padEnd(24, 'f').slice(0, 24) }))
    const body = many.map((p) => `@${p.label}`).join(' ')
    expect(mentionsIn(body, many)!.length).toBe(8)
  })
  it('a label longer than the agent trigger beats it at its position', () => {
    const crew = [{ label: 'Marver Team', id: '3'.repeat(24) }]
    const segs = parseBody('cc @Marver Team and @marver', crew)
    expect(segs.find((s) => s.person)?.text).toBe('@Marver Team')
    expect(segs.find((s) => s.marver)?.text).toBe('@marver')
    expect(mentionsIn('@Marver Team please', crew)).toEqual([{ id: '3'.repeat(24), label: 'Marver Team' }])
  })
  it('with nobody known, only @marver segments', () => {
    const segs = parseBody('hi @marver and @Sam', [])
    expect(segs.find((s) => s.marver)?.text).toBe('@marver')
    expect(segs.some((s) => s.person)).toBe(false)
  })
})

describe('mentionQueryAt - the token under the caret', () => {
  it('finds an open @-token, not completed or absent ones', () => {
    expect(mentionQueryAt('hey @Da', 7)).toEqual({ start: 4, query: 'Da' })
    expect(mentionQueryAt('hey @', 5)).toEqual({ start: 4, query: '' })
    expect(mentionQueryAt('hey', 3)).toBeNull()
    expect(mentionQueryAt('a@b.co', 6)).toBeNull()                       // mid-word @ is an email, not a mention
    expect(mentionQueryAt('line\n@Q', 7)).toEqual({ start: 5, query: 'Q' })
  })
})

describe('activityJobs - who a fresh batch mails', () => {
  const now = Date.now()
  const A = 'a@x.co', B = 'b@x.co', C = 'c@x.co', D = 'd@x.co'
  const thread = (id: string, authors: string[]): CommentEvent[] => [
    ev({ commentId: id, author: { email: authors[0] }, ts: now - 60_000 }),
    ...authors.slice(1).map((email, i) => ev({ type: 'reply', parentId: id, commentId: `${id}-r${i}`, author: { email }, ts: now - 30_000 + i })),
  ]
  const all = () => true

  it('a fresh reply mails prior participants, never the author, throttled per window', () => {
    const log = thread('t1', [A, B])
    const reply = ev({ type: 'reply', parentId: 't1', commentId: 't1-new', author: { email: B }, ts: now })
    const jobs = activityJobs('main', [reply], [...log, reply], all, now)
    expect([...jobs.values()]).toEqual([{ template: 'reply', recipient: A }])
    const window = String(Math.floor(now / (6 * 3600_000)))
    expect([...jobs.keys()]).toEqual([transitionId('reply', A, 'main', 't1', window)])
  })
  it('mentioned participants get the mention, not the reply; resolver filter holds', () => {
    const log = thread('t1', [A, C])
    const reply = ev({
      type: 'reply', parentId: 't1', commentId: 't1-new', author: { email: B }, ts: now,
      mentions: [{ email: A, label: 'A' }, { email: D, label: 'D' }, { email: B, label: 'Self' }],
    })
    const jobs = activityJobs('main', [reply], [...log, reply], (e) => e !== D, now)
    const byRecipient = Object.fromEntries([...jobs.values()].map((j) => [j.recipient, j.template]))
    expect(byRecipient).toEqual({ [A]: 'mentioned', [C]: 'reply' })     // D refused by resolver, B is the author
  })
  it('history imports never mail; roots mail only their mentions', () => {
    const stale = ev({ type: 'reply', parentId: 't1', commentId: 'old', author: { email: B }, ts: now - 16 * 60_000 })
    expect(activityJobs('main', [stale], thread('t1', [A]), all, now).size).toBe(0)
    const root = ev({ author: { email: A }, ts: now, mentions: [{ email: C, label: 'C' }] })
    expect([...activityJobs('main', [root], [root], all, now).values()]).toEqual([{ template: 'mentioned', recipient: C }])
  })
  it('caps a deep thread at the 10 most recent distinct participants', () => {
    const authors = Array.from({ length: 14 }, (_, i) => `p${i}@x.co`)
    const log = thread('big', authors)
    const reply = ev({ type: 'reply', parentId: 'big', commentId: 'big-new', author: { email: 'z@x.co' }, ts: now })
    const jobs = activityJobs('main', [reply], [...log, reply], all, now)
    expect(jobs.size).toBe(10)
    const recipients = [...jobs.values()].map((j) => j.recipient)
    expect(recipients).toContain(authors.at(-1))                        // most recent participant is in
    expect(recipients).not.toContain(authors[0])                        // the oldest fell off the cap
  })
})

describe('validateEvents - v1.1 tightenings', () => {
  const me = { email: 'nic@x.com', name: 'Nic', role: 'member' } as any
  const mine = { email: 'nic@x.com', name: 'Nic' }
  const log: CommentEvent[] = [
    ev({ id: 'L1', ts: 1755000000000, commentId: 'c-exists', author: { email: 'other@x.com', name: 'Other' } }),
    ev({ id: 'L2', ts: 1755000001000, type: 'reply', commentId: 'c-reply01', parentId: 'c-exists', author: { email: 'other@x.com' } }),
  ]
  const base = { id: 'e-aaaaaaaa', ts: Date.now(), author: mine }

  it('requires a non-blank body on create and reply', () => {
    expect(validateEvents([{ ...base, type: 'create', commentId: 'c-n10000', body: '  ' } as any], log, me, 'main')).toMatch(/body/)
    expect(validateEvents([{ ...base, type: 'reply', commentId: 'c-n10000', parentId: 'c-exists' } as any], log, me, 'main')).toMatch(/body/)
  })
  it('refuses a reply reusing ANY existing comment id (replay would discard it)', () => {
    expect(validateEvents([{ ...base, type: 'reply', commentId: 'c-reply01', parentId: 'c-exists', body: 'x' } as any], log, me, 'main')).toMatch(/already exists/)
  })
  it('binds profile events to the session author (the HMAC-oracle fix)', () => {
    expect(validateEvents([{ id: 'e-aaaaaaaa', ts: Date.now(), type: 'profile', author: { email: 'guess@x.com' } } as any], log, me, 'main')).toMatch(/signed-in account/)
    expect(validateEvents([{ id: 'e-aaaaaaaa', ts: Date.now(), type: 'profile', author: mine } as any], log, me, 'main')).toBeNull()
  })
  it('browser mentions: opaque id only, capped, deduped, labels sane', () => {
    const reply = (mentions: any) => [{ ...base, type: 'reply', commentId: 'c-n10000', parentId: 'c-exists', body: 'x', mentions } as any]
    expect(validateEvents(reply([{ id: 'f'.repeat(24), label: 'Ok' }]), log, me, 'main')).toBeNull()
    expect(validateEvents(reply([{ email: 'guess@x.com', label: 'Probe' }]), log, me, 'main')).toBe('invalid mentions')
    expect(validateEvents(reply([{ id: 'f'.repeat(24), label: 'marver' }]), log, me, 'main')).toBe('invalid mentions')
    expect(validateEvents(reply([{ id: 'f'.repeat(24), label: 'A', extra: 1 }]), log, me, 'main')).toBe('invalid mentions')
    expect(validateEvents(reply([{ id: 'f'.repeat(24), label: 'A' }, { id: 'f'.repeat(24), label: 'A' }]), log, me, 'main')).toBe('invalid mentions')
    expect(validateEvents(reply(Array.from({ length: 9 }, (_, i) => ({ id: String(i).repeat(24).slice(0, 24), label: `P${i}` }))), log, me, 'main')).toBe('invalid mentions')
    expect(validateEvents([{ ...base, type: 'resolve', commentId: 'c-exists', mentions: [{ id: 'f'.repeat(24), label: 'A' }] } as any], log, me, 'main')).toBe('invalid mentions')
  })
  it('operator mentions: canonical email only', () => {
    const reply = (mentions: any) => [{ ...base, type: 'reply', commentId: 'c-n10000', parentId: 'c-exists', body: 'x', mentions } as any]
    expect(validateEvents(reply([{ email: 'dana@x.co', label: 'Dana' }]), log, me, 'main', { operator: true })).toBeNull()
    expect(validateEvents(reply([{ id: 'f'.repeat(24), label: 'Dana' }]), log, me, 'main', { operator: true })).toBe('invalid mentions')
  })
})
