/**
 * Mention parsing - pure, so the rendering is unit-testable without
 * pulling the whole comment UI (and its virtual:sh-config) into the test.
 *
 * Two kinds live in a body: `@marver` (the Live Jam trigger, reserved) and
 * person mentions (`@Display Name`, sharing v1.1). ONE segmentation drives
 * highlighting AND the mentions array a send derives - what lights up is
 * exactly what notifies.
 */
import type { CommentEvent, Mention } from '../../shared/events.ts'

/** Split a comment body into plain text and @marver mention segments (case-insensitive, word-bounded). */
export function parseMentions(body: string): { text: string; mention: boolean }[] {
  const out: { text: string; mention: boolean }[] = []
  let last = 0
  for (const m of body.matchAll(/@marver\b/gi)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: body.slice(last, i), mention: false })
    out.push({ text: m[0], mention: true })
    last = i + m[0].length
  }
  if (last < body.length) out.push({ text: body.slice(last), mention: false })
  return out.length ? out : [{ text: body, mention: false }]
}

/** Someone the composer may name: a distinct author (or past mention target)
 *  seen in this canvas's events. `id` on a published canvas (the projected
 *  transport), `email` in dev (canonical) - exactly what the event will carry. */
export interface MentionPerson { label: string; id?: string; email?: string; avatar?: string }

const personKey = (p: { id?: string; email?: string }) => p.id ? `i:${p.id}` : `e:${p.email?.toLowerCase()}`

/** The mentionable set: named humans from the event log, first-seen order,
 *  minus the viewer themself and the reserved agent NAMESPACE - any label
 *  STARTING with the word "marver" is out, because the Live Jam daemon's own
 *  watcher sees `@marver` inside `@Marver Team` and would run the agent. */
export function mentionPeople(events: CommentEvent[], self?: { id?: string; email?: string }): MentionPerson[] {
  const seen = new Map<string, MentionPerson>()
  const selfKey = self && (self.id || self.email) ? personKey(self) : null
  const add = (a?: { id?: string; email?: string; name?: string; avatar?: string }, label?: string) => {
    const name = (label ?? a?.name)?.trim()
    if (!a || (!a.id && !a.email) || !name || /^marver\b/i.test(name)) return
    const k = personKey(a)
    if (k !== selfKey && !seen.has(k)) seen.set(k, { label: name, id: a.id, email: a.email, avatar: a.avatar })
  }
  for (const ev of events) {
    if (!ev.agent && (ev.type === 'create' || ev.type === 'reply')) add(ev.author)
    for (const m of ev.mentions ?? []) add(m, m.label)
  }
  return [...seen.values()]
}

export type BodySegment = { text: string; marver?: boolean; person?: MentionPerson }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Segment a body against the known people: `@Label` runs (longest label wins
 *  at each position, case-insensitive, trailing-boundary-guarded, and only at
 *  a mention START - after whitespace, an opener, or the beginning; `foo@Sam`
 *  is an address shape, not a mention, exactly the rule the typeahead uses)
 *  plus `@marver` (whose namespace mentionPeople already reserves). */
export function parseBody(body: string, people: MentionPerson[]): BodySegment[] {
  if (!people.length) return parseMentions(body).map((s) => (s.mention ? { text: s.text, marver: true } : { text: s.text }))
  const byLength = [...people].sort((a, b) => b.label.length - a.label.length)
  const alts = byLength.map((p) => `${escapeRe(p.label)}(?![\\w])`)
  alts.push('marver\\b')
  const pattern = new RegExp(`(?<=^|[\\s(])@(?:${alts.join('|')})`, 'gim')
  const out: BodySegment[] = []
  let last = 0
  for (const m of body.matchAll(pattern)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: body.slice(last, i) })
    const hit = m[0].slice(1)
    if (/^marver$/i.test(hit)) out.push({ text: m[0], marver: true })
    else out.push({ text: m[0], person: byLength.find((p) => p.label.toLowerCase() === hit.toLowerCase()) })
    last = i + m[0].length
  }
  if (last < body.length) out.push({ text: body.slice(last) })
  return out.length ? out : [{ text: body }]
}

/** The mentions a body carries, in event form - derived from the SAME
 *  segmentation the highlight uses: what lights up is what notifies. ≤ 8,
 *  the validator's cap. An ambiguous label (two people wearing the same
 *  display name) mentions EVERY bearer - deterministic and stateless, where
 *  remembering which twin was picked would depend on hidden composer state. */
export function mentionsIn(body: string, people: MentionPerson[]): Mention[] | undefined {
  const out = new Map<string, Mention>()
  const hit = new Set([...parseBody(body, people)].flatMap((s) => (s.person ? [s.person.label.toLowerCase()] : [])))
  for (const p of people) {
    if (out.size >= 8) break
    if (hit.has(p.label.toLowerCase()))
      out.set(personKey(p), p.id ? { id: p.id, label: p.label } : { email: p.email, label: p.label })
  }
  return out.size ? [...out.values()] : undefined
}

/** The @-token the caret sits in, for the typeahead: `@` + a partial name
 *  (letters, spaces) immediately before `caret`, not already a completed
 *  mention. Null when the caret is not in one. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret)
  const m = /(^|[\s(])@([^@\n]{0,40})$/.exec(upto)
  if (!m) return null
  return { start: (m.index ?? 0) + m[1].length, query: m[2] }
}

/** Thread ids holding a mention of ME newer than my seen mark - what the pin
 *  pulse and unread ring key on. Pure; the store persists `seen` per thread. */
export function mentionAlerts(
  events: CommentEvent[], me: { id?: string; email?: string } | null | undefined,
  seen: Record<string, number>,
): string[] {
  if (!me || (!me.id && !me.email)) return []
  const mine = (m: Mention) =>
    (!!m.id && m.id === me.id) || (!!m.email && !!me.email && m.email.toLowerCase() === me.email.toLowerCase())
  const out = new Set<string>()
  for (const ev of events) {
    if (ev.type !== 'create' && ev.type !== 'reply') continue
    if (!(ev.mentions ?? []).some(mine)) continue
    const thread = ev.type === 'reply' ? ev.parentId : ev.commentId
    if (thread && ev.ts > (seen[thread] ?? 0)) out.add(thread)
  }
  return [...out]
}
