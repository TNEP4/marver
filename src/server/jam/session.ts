/**
 * The Jam session (spec 27, Part 5): `J` starts one, `J` again ends it with a wrap-up.
 *
 * While a session runs, the microphone is live and what is said BETWEEN captures - its talk - is kept in
 * `design/.local/jam/sessions/<id>.jsonl` (local, never committed, sent to no agent unless you say so at
 * the end). Every capture made in it carries the session.
 *
 * "Write the record" seals a wrap-up into `design/.local/jam/wrapups/<id>.json` - your instructions
 * first, every confirmed capture of the session (its record, your edit, its card's state and reply), the
 * kept ones (as kept), the verdicts, and the talk if you left that on - ledgered with its hash and checked
 * again at claim, like a capture. Drafts and dropped captures are left out; tags are answered in their
 * threads and are not in it. The agent writes the record to `context/sessions/<date>-<slug>.md` (or
 * `design/sessions/` with no `context/`) and nothing else.
 */
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { readCapture } from './capture.ts'
import { speechLines } from '../../shared/speech.ts'
import type { Card, CaptureRecord, Journal } from './types.ts'

export const SESSION_ID = /^ses-\d{10,16}-[a-z0-9]{4,12}$/
export const WRAPUP_ID = /^wrap-\d{10,16}-[a-z0-9]{4,12}$/
const jamDir = (root: string) => join(root, 'design', '.local', 'jam')
const sessionsDir = (root: string) => join(jamDir(root), 'sessions')
const wrapupsDir = (root: string) => join(jamDir(root), 'wrapups')
const hashOf = (s: string) => createHash('sha256').update(s).digest('hex')

// ---- the talk ----------------------------------------------------------------------------------------

export interface TalkLine { at: number; text: string; words?: { w: string; at: number }[] }

/** Words said between captures: one line per phrase, appended to the session's transcript. */
export function appendTalk(root: string, session: string, words: { w: string; at: number; lost?: true }[]) {
  if (!SESSION_ID.test(session) || !words.length) return
  mkdirSync(sessionsDir(root), { recursive: true })
  const line: TalkLine = { at: words[0].at, text: words.map((w) => w.w).join(' '), words: words.map((w) => ({ w: w.w, at: w.at })) }
  appendFileSync(join(sessionsDir(root), `${session}.jsonl`), JSON.stringify(line) + '\n', { mode: 0o600 })
}

export function readTalk(root: string, session: string): TalkLine[] {
  if (!SESSION_ID.test(session)) return []
  try {
    return readFileSync(join(sessionsDir(root), `${session}.jsonl`), 'utf8').split('\n').flatMap((l) => { try { const x = JSON.parse(l); return typeof x?.text === 'string' && Number.isFinite(x.at) ? [x as TalkLine] : [] } catch { return [] } })
  } catch { return [] }
}

/** How long the talk runs, for the sheet ("26 min"): from its first line to its last. */
export const talkMinutes = (talk: TalkLine[]): number => talk.length ? Math.max(1, Math.round((talk[talk.length - 1].at - talk[0].at) / 60_000)) : 0

// ---- the wrap-up ---------------------------------------------------------------------------------------

export interface WrapupCapture {
  id: string
  title: string
  /** where its card stands: done, review, working, queued, asks, failed - or kept (for the record only) */
  state: string
  kept?: true
  record: CaptureRecord
  edited?: string
  /** the agent's reply, when there is one */
  reply?: string
  /** your verdict on its review: looks good, more work */
  verdict?: string
}
export interface Wrapup {
  format: 'marver.jam.wrapup'; v: 1
  id: string
  session: string
  since: number
  until: number
  /** your instructions to the agent, first */
  instructions: string
  /** where the agent writes the record (relative to the project) */
  file: string
  captures: WrapupCapture[]
  /** tags written during the session - answered in their threads, not in this record */
  tags: number
  /** what was said between captures - only if you left it on */
  talk?: TalkLine[]
  /** More work on an earlier record: your note on it */
  more?: string
}

/** The record's file: `context/sessions/<date>-<slug>.md`, or `design/sessions/` with no `context/`. */
export function recordFile(root: string, since: number, slug = 'session'): string {
  const d = new Date(since)
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const s = (slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session')
  const name = `${date}-${s}-${pad(d.getHours())}${pad(d.getMinutes())}.md`
  return existsSync(join(root, 'context')) ? `context/sessions/${name}` : `design/sessions/${name}`
}

/** What the wrap-up says of the session, at this moment ("as of"). */
export function buildWrapup(j: Journal, root: string, o: { session: string; since: number; instructions: string; includeTalk: boolean; tags: number; title?: (c: Card) => string; reply?: (c: Card) => string | undefined; now?: number }): Wrapup {
  const now = o.now ?? Date.now()
  const caps: WrapupCapture[] = []
  for (const c of j.cards.filter((x) => x.kind === 'capture' && x.session === o.session).sort((a, b) => a.made - b.made)) {
    // drafts and dropped captures are left out: they were never sent, nor kept
    if (c.state === 'draft' || c.state === 'dropped' || c.state === 'confirming') continue
    const cap = readCapture(root, c.id)
    if (!cap) continue
    const verdict = c.state === 'done' && c.note === 'looks good' ? 'looks good' : c.ran?.length ? 'more work' : undefined
    caps.push({
      id: c.id, title: o.title?.(c) ?? c.name ?? c.id, state: c.state, ...(c.state === 'kept' ? { kept: true as const } : {}),
      record: cap.record, ...(c.payload?.edited !== undefined ? { edited: c.payload.edited } : {}),
      ...(o.reply?.(c) ? { reply: o.reply(c) } : {}), ...(verdict ? { verdict } : {}),
    })
  }
  const talk = o.includeTalk ? readTalk(root, o.session) : undefined
  const id = `wrap-${now}-${randomBytes(4).toString('hex').slice(0, 6)}`
  return {
    format: 'marver.jam.wrapup', v: 1, id, session: o.session, since: o.since, until: now,
    instructions: o.instructions.slice(0, 20_000), file: recordFile(root, o.since), captures: caps, tags: o.tags,
    ...(talk ? { talk } : {}),
  }
}

/** Seal a wrap-up once (a second store of the same id is refused). Returns its hash. */
export function storeWrapup(root: string, w: Wrapup): string {
  mkdirSync(wrapupsDir(root), { recursive: true })
  const file = join(wrapupsDir(root), `${w.id}.json`)
  if (existsSync(file)) throw new Error('a wrap-up is already stored under this id')
  const body = JSON.stringify(w)
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try { writeSync(fd, body); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
  return hashOf(body)
}

/** A stored wrap-up and the hash of its bytes as they are now (changed after the seal: refused at claim). */
export function readWrapup(root: string, id: string): { wrapup: Wrapup; hash: string } | null {
  if (!WRAPUP_ID.test(id)) return null
  try { const body = readFileSync(join(wrapupsDir(root), `${id}.json`), 'utf8'); return { wrapup: JSON.parse(body) as Wrapup, hash: hashOf(body) } } catch { return null }
}

/** The words of a capture in the record, as you read them (the same rule as its thread comment). */
export const captureText = (c: WrapupCapture): string => c.edited ?? speechLines(c.record.timeline.flatMap((s) => (s.event === 'words' || s.event === 'note' ? [{ kind: s.event, text: s.text }] : [])))
