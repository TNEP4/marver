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
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
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
  /** what you asked after it (More work), in order, with what came of each - the last may still be open */
  more?: { ask: string; result?: string }[]
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

/** The record's file: `context/sessions/<date>-<hhmm>-<session>.md`, or `design/sessions/` with no
 *  `context/` - the session's own id in it, so two sessions never write one file. */
export function recordFile(root: string, since: number, session = 'ses-0-session'): string {
  const d = new Date(since)
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const tail = (/^ses-\d+-([a-z0-9]+)$/.exec(session)?.[1] ?? 'session').slice(0, 12)
  const name = `${date}-${pad(d.getHours())}${pad(d.getMinutes())}-session-${tail}.md`
  return existsSync(join(root, 'context')) ? `context/sessions/${name}` : `design/sessions/${name}`
}

/** Why a record path is not safe to write or read, or null: it must be a plain `.md` under
 *  `context/sessions/` or `design/sessions/`, and no part of it that exists - the folders or the file -
 *  may be a link (a link would send the agent's write, or the panel's read, somewhere else). */
export function recordPathProblem(root: string, file: string): string | null {
  if (!/^(context|design)\/sessions\/[a-z0-9][a-z0-9-]*\.md$/.test(file)) return 'not a session record path'
  let rootReal: string
  try { rootReal = realpathSync(root) } catch { return 'the project folder is not there' }
  let at = root
  for (const part of file.split('/')) {
    at = join(at, part)
    let st: ReturnType<typeof lstatSync>
    try { st = lstatSync(at) } catch { break }          // not there yet: the agent makes it
    if (st.isSymbolicLink()) return `${relative(root, at)} is a link`
  }
  // and where the folders that exist really are: inside the project
  let probe = join(root, file)
  while (!existsSync(probe) && probe !== root) probe = dirname(probe)
  try { const real = realpathSync(probe); if (real !== rootReal && !real.startsWith(rootReal + sep)) return 'it leads outside the project' } catch { return 'it cannot be checked' }
  return null
}

/** What the wrap-up says of the session, at this moment ("as of"). */
export function buildWrapup(j: Journal, root: string, o: { session: string; since: number; instructions: string; includeTalk: boolean; tags: number; title?: (c: Card) => string; reply?: (c: Card) => string | undefined; intact?: (c: Card) => boolean; more?: (c: Card) => { ask: string; result?: string }[]; now?: number }): Wrapup | { error: string } {
  const now = o.now ?? Date.now()
  const caps: WrapupCapture[] = []
  for (const c of j.cards.filter((x) => x.kind === 'capture' && x.session === o.session).sort((a, b) => a.made - b.made)) {
    // drafts and dropped captures are left out: they were never sent, nor kept
    if (c.state === 'draft' || c.state === 'dropped' || c.state === 'confirming') continue
    // only what was confirmed (or kept) as it was: a capture changed since is never sealed into the record
    if (o.intact && !o.intact(c)) return { error: 'a capture of the session changed after it was confirmed - capture it again, then write the record' }
    const cap = readCapture(root, c.id)
    if (!cap) return { error: 'a capture of the session is gone - write the record again without it' }
    const verdict = c.verdict
    caps.push({
      id: c.id, title: o.title?.(c) ?? c.name ?? c.id, state: c.state, ...(c.state === 'kept' ? { kept: true as const } : {}),
      record: cap.record, ...(c.payload?.edited !== undefined ? { edited: c.payload.edited } : {}),
      ...(o.reply?.(c) ? { reply: o.reply(c) } : {}), ...(verdict ? { verdict } : {}),
      ...(o.more?.(c).length ? { more: o.more(c) } : {}),
    })
  }
  const talk = o.includeTalk ? readTalk(root, o.session) : undefined
  const id = `wrap-${now}-${randomBytes(4).toString('hex').slice(0, 6)}`
  return {
    format: 'marver.jam.wrapup', v: 1, id, session: o.session, since: o.since, until: now,
    instructions: o.instructions.slice(0, 20_000), file: recordFile(root, o.since, o.session), captures: caps, tags: o.tags,
    ...(talk ? { talk } : {}),
  }
}

/** More work on a record: the same content - its captures, talk and file - with your note, as a wrap-up of
 *  its own (sealed and ledgered like the first). */
export function moreOf(prev: Wrapup, note: string, now = Date.now()): Wrapup {
  return { ...prev, id: `wrap-${now}-${randomBytes(4).toString('hex').slice(0, 6)}`, more: note.slice(0, 20_000) }
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
