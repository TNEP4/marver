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
 *  minus the viewer themself and the reserved agent. */
export function mentionPeople(events: CommentEvent[], self?: { id?: string; email?: string }): MentionPerson[] {
  const seen = new Map<string, MentionPerson>()
  const selfKey = self && (self.id || self.email) ? personKey(self) : null
  const add = (a?: { id?: string; email?: string; name?: string; avatar?: string }, label?: string) => {
    const name = (label ?? a?.name)?.trim()
    if (!a || (!a.id && !a.email) || !name || /^marver$/i.test(name)) return
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
 *  at each position, case-insensitive, boundary-guarded) plus `@marver`. The
 *  agent trigger competes at ITS length too - a person labelled "Marver Team"
 *  must beat the bare trigger, or they could never be mentioned at all. */
export function parseBody(body: string, people: MentionPerson[]): BodySegment[] {
  if (!people.length) return parseMentions(body).map((s) => (s.mention ? { text: s.text, marver: true } : { text: s.text }))
  const byLength = [...people].sort((a, b) => b.label.length - a.label.length)
  const alts = byLength.map((p) => ({ len: p.label.length, pat: `${escapeRe(p.label)}(?![\\w])` }))
  alts.push({ len: 'marver'.length, pat: 'marver\\b' })
  alts.sort((a, b) => b.len - a.len)
  const pattern = new RegExp(`@(?:${alts.map((a) => a.pat).join('|')})`, 'gi')
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
 *  the validator's cap. */
export function mentionsIn(body: string, people: MentionPerson[]): Mention[] | undefined {
  const out = new Map<string, Mention>()
  for (const seg of parseBody(body, people)) {
    const p = seg.person
    if (!p || out.size >= 8) continue
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
