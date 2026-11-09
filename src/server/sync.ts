/**
 * Dev ↔ published comment sync - one merge rule, run from the dev side.
 *
 * The published serve is the canonical home; the repo's design/comments/ is the
 * mirror the agent reads. Each exchange is: pull remote events → union into local
 * files; push the local events the remote lacks (chunked - the server unions too).
 * Idempotent and retry-safe by construction, so a dropped exchange costs nothing.
 *
 * Credentials: ~/.marver/canvases/<hash-of-project-path>.json {url, token},
 * written by `comments connect`. Deliberately OUTSIDE the repository - a dev
 * server serves the repository, and no amount of path guarding makes a secret
 * inside a published tree safe. The token is always a server SESSION - expiring,
 * and ended by rotating MARVER_CLI_TOKEN - never the operator's secret itself,
 * which is traded for one and then forgotten.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { appendEvents, diffEvents, listBoards, readLog, type CommentEvent } from './comments.ts'
import { deletedMessages } from '../shared/events.ts'
import { CLI_TOKEN_CHARS, MIN_CLI_TOKEN } from './auth.ts'
import { marverHome } from './slots.ts'

export interface Collab { url: string; token: string; email?: string; name?: string; avatar?: string }

/**
 * The credential does not live in the repository.
 *
 * It used to, at `design/.local/collab.json`, and `marver dev` puts the
 * repository on the web so frames can import from it. Two rounds of guards -
 * a deny list, then a realpath check - each closed a way to read it and each was
 * followed by another: a symlink, then `public/`, then Vite's derived
 * `index`/`.html` candidates. Enumerating every path a bundler might resolve is
 * not a thing anyone can finish.
 *
 * So the file moved out of reach instead. Under the user's home, keyed by the
 * absolute path of the project it belongs to, one file per canvas per machine.
 * Nothing serves that directory, so there is no path to guard. (MARVER_HOME moves
 * it with the registry: the test suite's, so no test writes the owner's.)
 *
 * The old location is still read once, moved, and removed - a credential left
 * behind in a repo is exactly the thing being fixed.
 */
const legacyCollabFile = (root: string) => join(root, 'design', '.local', 'collab.json')

const collabDir = () => join(marverHome(), 'canvases')

export const collabFileFor = (root: string) => collabFile(root)

const collabFile = (root: string) => {
  // The project's own path, resolved and then hashed: two checkouts of the same
  // repo are two canvases, and the name gives away nothing about where they live.
  // Resolved first so that reaching the same project through a symlink, or from a
  // different working directory, does not silently select a different credential.
  let canonical = root
  try { canonical = realpathSync(root) } catch { /* not yet on disk: the raw path is the key */ }
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 32)
  return join(collabDir(), `${key}.json`)
}

/** Move a credential written by an older marver out of the repository. Best
 *  effort in one direction only: if anything here fails the old file is left
 *  alone and `loadCollab` still reads it, so nobody is locked out by a tidy-up. */
function migrateLegacy(root: string): void {
  const from = legacyCollabFile(root)
  if (!existsSync(from)) return
  // A USABLE credential at the destination means the move already happened and
  // this is a leftover; remove it, because leaving it is the exposure this whole
  // change is about. A destination that merely EXISTS is not enough - a truncated
  // or half-written file there would turn the tidy-up into a lockout.
  if (readCollab(collabFile(root))) { try { unlinkSync(from) } catch { /* not ours to remove */ } ; return }
  const collab = readCollab(from)
  if (!collab) return
  // Copy through saveCollab rather than rename: /tmp and $HOME are routinely on
  // different filesystems, and renameSync answers EXDEV there - which, swallowed,
  // left the credential in the repository for ever.
  try { saveCollab(root, collab) } catch { /* a home we cannot write: leave it where it is */ }
}

/** A credential file, or null if it is missing, unreadable or not one. */
function readCollab(file: string): Collab | null {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'))
    return typeof c?.url === 'string' && typeof c?.token === 'string' ? c : null
  } catch { return null }
}

export function loadCollab(root: string): Collab | null {
  migrateLegacy(root)
  return readCollab(collabFile(root)) ?? readCollab(legacyCollabFile(root))
}

export function saveCollab(root: string, collab: Collab) {
  const dir = collabDir()
  const file = collabFile(root)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // An existing directory keeps whatever mode it was created with - `mode` on
  // mkdirSync applies to creation only, exactly like writeFileSync's.
  try { chmodSync(dir, 0o700) } catch { /* not POSIX, or not ours: the file mode still holds */ }

  /**
   * Written through a temp file created O_EXCL at 0600, then renamed.
   *
   * Writing in place and fixing the mode afterwards leaves a window - and, after
   * a crash, no window at all but a token sitting under the previous file's
   * permissions. Creating the temp file with the mode means the credential is
   * never on disk readable, not even briefly, and rename is atomic so a reader
   * sees the old file or the new one.
   */
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try { writeSync(fd, JSON.stringify(collab, null, 2) + '\n') } finally { closeSync(fd) }
  try { renameSync(tmp, file) } catch (err) {
    try { unlinkSync(tmp) } catch { /* nothing more to do */ }
    throw err
  }

  // ONLY now: the new credential exists and is readable. Removing the old copy
  // before proving that could have destroyed the only usable one - a home
  // directory that is read-only, or full, turns a tidy-up into a lockout.
  try { unlinkSync(legacyCollabFile(root)) } catch { /* nothing there */ }
}

/** One full exchange. Returns per-board counts, or throws on auth/network failure. */
export async function syncOnce(root: string, collab: Collab): Promise<Record<string, { pulled: number; pushed: number; held?: number }>> {
  const dir = join(root, 'design', 'comments')
  const auth = { authorization: `Bearer ${collab.token}` }
  const base = collab.url.replace(/\/+$/, '')

  const bres = await fetch(`${base}/__mv/api/boards`, { headers: auth })
  if (bres.status === 401) throw new Error('the connect token was rejected - run `comments connect` again')
  if (!bres.ok) throw new Error(`published canvas answered ${bres.status} - is it up?`)
  // `legacy`: the old all-scenes log (spec 26), served for the threads on frames a commentable
  // published board shows - a canvas built before 0.25 names none
  const { rights, legacy } = await bres.json() as { rights: Record<string, 'read' | 'comment'>; legacy?: { board: string; frames: string[] } }

  // what the server takes (spec 31 C.6): an older one has no `delete` - its validator refuses the type and with it the
  // whole batch, so a delete is held back here (never sent) until the server says it takes them
  const caps = await serverCapabilities(base, auth)

  const boards = [...new Set([...Object.keys(rights), ...listBoards(dir), ...(legacy ? [legacy.board] : [])])]
  const out: Record<string, { pulled: number; pushed: number; held?: number }> = {}
  const failures: string[] = []
  const held: Record<string, Held[]> = {}
  for (const board of boards) {
    const old = legacy?.board === board
    if (!(board in rights) && !old) continue  // local-only board: nothing published to sync with
    const res = await fetch(`${base}/__mv/api/comments/${board}`, { headers: auth })
    if (!res.ok) { failures.push(`${board}: pull ${res.status}`); continue }
    const { events: remote } = await res.json() as { events: CommentEvent[] }
    const pulled = appendEvents(dir, board, admitted(readLog(dir, board), remote)).length
    let pushed = 0
    if (rights[board] === 'comment' || old) {
      // Live Jam: agent-authored events are dev-local in v1 - never pushed to the published canvas
      // (the published client validator rejects agent provenance; publishing them is a P3 feature
      // needing a trusted path). Filter them out of the push set - and with them every event in a
      // thread Marver STARTED (a note an agent pinned, `comments new`): the owner's reply in it, a
      // resolve, a reaction would reach a server that never saw the thread, which rejects the batch.
      const local = readLog(dir, board)
      const marverThreads = localOnlyThreads(local)
      const shipped = old ? threadIds(local, (e) => legacy!.frames.includes(e.frame ?? '')) : null
      // an edit of a message deleted since (here or there) is never sent: the server refuses it, and with it the batch
      const gone = deletedMessages([...local, ...remote])
      const candidates = diffEvents(local, remote.map((e) => e.id)).filter((e) => !(e as { agent?: boolean }).agent && !marverThreads.has(threadOf(e)) && (!shipped || shipped.has(threadOf(e))) && (caps.delete || e.type !== 'delete') && !(e.type === 'edit' && gone.has(e.commentId ?? '')))
      // what the server would refuse - and with it the whole batch, every exchange - is kept here, said, never sent
      const keptHere = unauthorized(candidates, [...local, ...remote], collab.email)
      if (keptHere.length) held[board] = keptHere
      const keep = new Set(keptHere.map((h) => h.id))
      const missing = candidates.filter((e) => !keep.has(e.id))
      for (let i = 0; i < missing.length; i += 100) {
        const r = await fetch(`${base}/__mv/api/comments/${board}`, {
          method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ events: missing.slice(i, i + 100) }),
        })
        if (r.ok) pushed += (await r.json() as any).accepted ?? 0
        else failures.push(`${board}: push ${r.status} ${((await r.json().catch(() => null)) as any)?.error ?? ''}`.trim())
      }
    }
    out[board] = { pulled, pushed, ...(held[board]?.length ? { held: held[board].length } : {}) }
  }
  saveHeld(root, held)
  // a partial exchange must never read as a clean one - the caller decides retry vs surface
  if (failures.length) throw new Error(`sync incomplete - ${failures.join(' · ')}`)
  return out
}

/** Why an event stays on this machine (Codex r6): the published server checks every author against the signed-in
 *  account and every edit, delete or re-pin against the original message's author. After connecting under another
 *  address, an event written under the old one - or a change to a message the old one wrote, which this machine still
 *  lets you make (own.json) - would be refused there, and with it every comment in its batch, every 30 s. */
export interface Held { id: string; type: string; why: 'another-account' | 'message-of-another-account' | 'thread-kept-here' }
export function unauthorized(events: CommentEvent[], log: CommentEvent[], account?: string): Held[] {
  const me = (account ?? '').toLowerCase()
  if (!me) return []
  const authorOf = new Map<string, string>()
  for (const e of log) if ((e.type === 'create' || e.type === 'reply') && e.commentId && !authorOf.has(e.commentId)) authorOf.set(e.commentId, (e.author?.email ?? '').toLowerCase())
  const out: Held[] = []
  const heldThreads = new Set<string>()
  const byAuthor = new Set(['create', 'reply', 'react', 'edit', 'reanchor', 'profile', 'delete'])
  for (const e of events) {
    let why: Held['why'] | null = null
    if (byAuthor.has(e.type) && (e.author?.email ?? '').toLowerCase() !== me) why = 'another-account'
    else if ((e.type === 'edit' || e.type === 'delete') && authorOf.get(e.commentId ?? '') !== me) why = 'message-of-another-account'
    else if (e.type === 'reanchor' && (authorOf.get(e.commentId ?? '') ?? me) !== me) why = 'message-of-another-account'
    else if (heldThreads.has(threadOf(e))) why = 'thread-kept-here'
    if (!why) continue
    out.push({ id: e.id, type: e.type, why })
    if (e.type === 'create' && e.commentId) heldThreads.add(e.commentId)
  }
  return out
}
const heldFile = (root: string) => join(root, 'design', '.local', 'sync-held.json')
/** The last exchange's kept events, per board - what `marver comments sync` says, and what stays until you change it. */
function saveHeld(root: string, held: Record<string, Held[]>): void {
  try {
    if (!Object.keys(held).length) { if (existsSync(heldFile(root))) unlinkSync(heldFile(root)); return }
    mkdirSync(join(root, 'design', '.local'), { recursive: true })
    writeFileSync(heldFile(root), JSON.stringify({ at: Date.now(), boards: held }, null, 1) + '\n')
  } catch { /* the status is a convenience; the events stay in the log either way */ }
}
/** "1 edit kept local: written under another account" - one line per board and reason. */
export function heldWords(held: Held[]): string[] {
  const by = new Map<string, Held[]>()
  for (const h of held) by.set(h.why, [...(by.get(h.why) ?? []), h])
  const what = (hs: Held[]) => { const types = [...new Set(hs.map((h) => h.type))]; const n = hs.length; return types.length === 1 ? `${n} ${types[0]}${n === 1 ? '' : 's'}` : `${n} events` }
  const words = { 'another-account': 'written under another account', 'message-of-another-account': 'its comment was written under another account', 'thread-kept-here': 'its thread is kept local' } as const
  return [...by].map(([why, hs]) => `${what(hs)} kept local: ${words[why as Held['why']]}`)
}
export function readHeld(root: string): Record<string, Held[]> {
  try { return JSON.parse(readFileSync(heldFile(root), 'utf8')).boards ?? {} } catch { return {} }
}

/** What a server's comment API takes (`GET /__mv/api/capabilities`, 0.31): anything but a JSON answer that says so
 *  (an older server's 404, its gate page) is an older server - nothing new is sent to it. */
export async function serverCapabilities(base: string, headers: Record<string, string> = {}): Promise<{ delete: boolean }> {
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/__mv/api/capabilities`, { headers })
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('application/json')) return { delete: false }
    const b = await r.json() as { delete?: unknown }
    return { delete: b?.delete === true }
  } catch { return { delete: false } }
}

/** What of a pull may join the local log (spec 31, Codex r4): the server validated each event against ITS log, which
 *  never held this machine's own messages (Marver's notes, captures - never pushed). So a message id already here is
 *  one message's: another event claiming it as a new message is refused, and an edit or a delete of it must come from
 *  its original author - never touching Marver's or a local-only message at all. */
export function admitted(local: CommentEvent[], remote: CommentEvent[]): CommentEvent[] {
  const msgs = new Map<string, CommentEvent>()
  for (const e of local) if ((e.type === 'create' || e.type === 'reply') && e.commentId && !msgs.has(e.commentId)) msgs.set(e.commentId, e)
  const localIds = new Set(local.map((e) => e.id))
  const offLimits = localOnlyThreads(local)
  const out: CommentEvent[] = []
  for (const e of remote) {
    if (!e || typeof e.id !== 'string' || localIds.has(e.id)) { out.push(e); continue }   // already here: appendEvents keeps one
    if ((e.type === 'create' || e.type === 'reply') && e.commentId) {
      if (msgs.has(e.commentId)) continue
      msgs.set(e.commentId, e)
    } else if ((e.type === 'edit' || e.type === 'delete') && e.commentId) {
      const orig = msgs.get(e.commentId)
      if (!orig) continue
      if (orig.agent || offLimits.has(e.commentId)) continue
      const by = (e.author?.email ?? '').toLowerCase(), was = (orig.author?.email ?? '').toLowerCase()
      if (!by || by !== was) continue
    }
    out.push(e)
  }
  return out
}

/** The account endpoints live BEHIND the canvas gate (the outer READ boundary), so
 *  connecting passes the gate first when a canvas password is set. */
async function gateCookie(base: string, canvasPassword?: string): Promise<string> {
  if (!canvasPassword) return ''
  const res = await fetch(`${base}/__mv/auth`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(canvasPassword)}&next=`,
  })
  const cookie = res.headers.getSetCookie?.().find((c) => c.startsWith('mv_a=')) ?? ''
  const tok = /^mv_a=([^;]+)/.exec(cookie)?.[1]
  if (!tok) throw new Error('the canvas password was not accepted')
  return `mv_a=${tok}`
}

async function sessionFrom(res: Response, ctx: string): Promise<string> {
  if (!res.ok) {
    const err = (await res.json().catch(() => null) as any)?.error
    throw new Error(err ?? `${ctx} failed (${res.status})`)
  }
  const cookie = res.headers.getSetCookie?.().find((c) => c.startsWith('mv_s=')) ?? ''
  const token = /^mv_s=([\w-]+)/.exec(cookie)?.[1]
  if (!token) throw new Error('the canvas did not issue a session - is collaboration enabled on it (MARVER_DATA_DIR)?')
  return token
}

/** Sign in against a published canvas and persist the device credential. The account's
 *  identity rides along: locally-born events carry it as their author snapshot (the
 *  server validates the claim against the session - it never rewrites events). */
export async function connect(root: string, url: string, email: string, password: string, canvasPassword?: string): Promise<void> {
  const base = url.replace(/\/+$/, '')
  const gate = await gateCookie(base, canvasPassword)
  const res = await fetch(`${base}/__mv/api/auth/signin`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(gate ? { cookie: gate } : {}) },
    body: JSON.stringify({ email, password }),
  })
  // An identity-mode canvas does not let this endpoint through its gate at all,
  // so what comes back is the gate PAGE. Read that for what it is rather than
  // reporting "sign-in failed" at somebody whose password was never the problem.
  if ((res.headers.get('content-type') ?? '').includes('text/html'))
    throw new Error(
      'this canvas signs people in with Marver ID, so there is no password to use here.\n' +
      '  Set MARVER_CLI_TOKEN=$(openssl rand -hex 24) on the canvas, then run:\n' +
      `    npx marver comments connect ${base} --token <that same value>`)
  const token = await sessionFrom(res, 'sign-in')
  const user = (await res.clone().json().catch(() => null) as any)?.user
  saveCollab(root, { url: base, token, email: user?.email ?? email, name: user?.name, avatar: user?.avatar })
}

/** Claim an invite from the CLI (the dev-first path - no published UI needed). */
export async function connectClaim(root: string, url: string, invite: string, profile: { password: string; name: string }, canvasPassword?: string): Promise<void> {
  const base = url.replace(/\/+$/, '')
  const gate = await gateCookie(base, canvasPassword)
  const res = await fetch(`${base}/__mv/api/auth/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(gate ? { cookie: gate } : {}) },
    body: JSON.stringify({ token: invite, ...profile }),
  })
  const token = await sessionFrom(res, 'claim')
  const user = (await res.clone().json().catch(() => null) as any)?.user
  saveCollab(root, { url: base, token, email: user?.email, name: user?.name ?? profile.name, avatar: user?.avatar })
}

/**
 * Connect with the canvas's `MARVER_CLI_TOKEN` - the operator's own credential.
 *
 * The path that works whatever the canvas gates on, and the only one that works
 * when it gates on Marver ID: an identity account has no password for `connect`
 * to present, and the session its sign-in produced lives in an HttpOnly cookie
 * the terminal cannot read. The token is set in the deployment environment
 * rather than handed out by a page, because a page that mints CLI credentials is
 * a page an authored frame can drive - see the note on `operatorUser`.
 *
 * Checked before it is written, so a mistyped token fails here, once, in front
 * of somebody - rather than being persisted and failing on every sync from now
 * on. No canvas password is needed: the token IS gate passage.
 */
export async function connectToken(root: string, url: string, token: string): Promise<void> {
  const base = url.replace(/\/+$/, '')
  if (!token.trim()) throw new Error('that token is empty - is MARVER_CLI_TOKEN set in your shell?')
  // The same floor the canvas enforces at boot, applied here so a too-short value
  // is a sentence rather than a 401 that reads like the canvas is misconfigured.
  if (token.length < MIN_CLI_TOKEN)
    throw new Error(
      `that token is ${token.length} characters and the canvas will not honour anything under ${MIN_CLI_TOKEN}.\n` +
      '  Generate one: MARVER_CLI_TOKEN=$(openssl rand -hex 24), set it on the canvas, and use the same value here.')
  // Refused here rather than sent, because a token the header grammar cannot
  // carry produces an opaque TypeError from `fetch` and, on the canvas, nothing
  // at all. `openssl rand -base64` output lands here often enough to name it.
  if (!CLI_TOKEN_CHARS.test(token))
    throw new Error(
      'that token has characters an Authorization header cannot carry (letters, digits, _ and - only).\n' +
      "  If it came from `openssl rand -base64`, regenerate it with `openssl rand -hex 24`\n" +
      '  and set the same value as MARVER_CLI_TOKEN on the canvas.')

  const res = await fetch(`${base}/__mv/api/cli-session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  })
  // The gate answers HTML to anything it does not recognise, and a REFUSED
  // operator token is exactly that - it never becomes a caller the gate knows.
  // So an html body here is the ordinary wrong-token case, not a broken canvas,
  // and saying "is collaboration enabled?" at somebody who mistyped a secret
  // sends them to check the wrong thing entirely.
  const html = (res.headers.get('content-type') ?? '').includes('text/html')
  if (res.status === 404)
    throw new Error(`${base} has no CLI sign-in - it is running a marver older than 0.11.0`)
  if (res.status === 401 || html)
    // A gate page and a 401 are the same answer wearing different clothes, and an
    // OLDER identity-gated canvas produces the gate page too - it has no such
    // route, so its gate simply does not recognise the caller and answers with
    // HTML and a 200. Nothing in the response distinguishes the three, so the
    // message owns all of them rather than guessing one and sending somebody to
    // check the wrong thing.
    throw new Error(
      'the canvas would not accept that token.\n' +
      `  - is it the same value as MARVER_CLI_TOKEN on ${base}?\n` +
      '  - has the owner signed in yet? the token acts as the owner, so it does nothing until one exists\n' +
      '  - is MARVER_DATA_DIR set on the canvas? without it there are no accounts at all\n' +
      '  - is the canvas running marver 0.11.0 or newer? older ones have no CLI sign-in at all')
  if (!res.ok) throw new Error(`the canvas answered ${res.status} - is it up?`)

  // What gets persisted is the SESSION, never the operator secret: this file
  // lives in a repo for the life of the project, and a credential that cannot be
  // revoked or expired is the wrong thing to leave lying in one.
  const body = await res.json().catch(() => null) as any
  if (!body?.token || !body?.user?.email)
    throw new Error('the canvas accepted the token but issued nothing - is it running a current marver?')
  saveCollab(root, { url: base, token: body.token, email: body.user.email, name: body.user.name, avatar: body.user.avatar })
}

/** The thread an event belongs to: a reply names its root; everything else names its comment. */
const threadOf = (e: CommentEvent): string => e.parentId ?? e.commentId ?? ''

/** Threads that live on this machine only: started by Marver (an agent's `comments new`) or by a Jam
 *  capture (its words, spoken or typed - 0.26). Every id that resolves to one - the thread, and each reply
 *  in it (an edit or reaction names the reply) - is in the set, so `threadOf` of any event in such a
 *  thread hits it. */
export function localOnlyThreads(events: CommentEvent[]): Set<string> {
  return threadIds(events, (e) => !!e.agent || !!e.capture)
}

/** Every id that resolves to a thread whose root passes `root` - the thread, and each reply in it. */
function threadIds(events: CommentEvent[], root: (create: CommentEvent) => boolean): Set<string> {
  const roots = new Set(events.filter((e) => e.type === 'create' && e.commentId && root(e)).map((e) => e.commentId!))
  const out = new Set(roots)
  for (const e of events) if (e.type === 'reply' && e.parentId && roots.has(e.parentId) && e.commentId) out.add(e.commentId)
  return out
}
