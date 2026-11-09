/**
 * Who owns a message on this machine (spec 31 C.2) - the local provenance that decides who may edit or delete
 * one in `marver dev`. Kept OUTSIDE the shared log, in `design/.local/own.json` (gitignored, watch-ignored,
 * never synced), so no new field ever reaches a published server: there the original message's author email
 * decides, as it always has (collab.ts validateEvents).
 *
 * The dev server records the comment id of every create and reply it writes for the local human - the page's
 * gated POST (api.ts), and the Jam steps that write the owner's own words (a capture's comment, a More work
 * reply). Never an agent's message, never one that arrived by sync.
 *
 * Migration, once, on the first 0.31 start: every create or reply the Jam ledger records as written here by the
 * owner (jam/ledger.ts - local provenance older than any connect or profile change), plus every create or reply
 * with no agent provenance whose author email is the local profile's - or, with no profile email, whose author has
 * none. From then on the file decides, so connecting an account or changing the profile never moves ownership.
 *
 * Shape: `{ "v": 1, "migrated": true, "boards": { "<board>": ["<comment id>", ...] } }`, written atomically.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { listBoards, readLog } from './comments.ts'
import { localProfile } from './profile.ts'
import { owned as ledgerOwned } from './jam/ledger.ts'

interface OwnFile { v: 1; migrated: boolean; boards: Record<string, string[]> }

const fileOf = (root: string) => join(root, 'design', '.local', 'own.json')
const commentsOf = (root: string) => join(root, 'design', 'comments')

/** One parsed copy per root, keyed by the file's mtime and size - a check per edit costs a stat. */
const cache = new Map<string, { key: string; own: OwnFile; sets: Map<string, Set<string>> }>()

function read(root: string): OwnFile | null {
  const f = fileOf(root)
  if (!existsSync(f)) return null
  try {
    const v = JSON.parse(readFileSync(f, 'utf8'))
    if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.boards !== 'object' || !v.boards || Array.isArray(v.boards)) return null
    const boards: Record<string, string[]> = Object.create(null)
    for (const [b, ids] of Object.entries(v.boards)) if (Array.isArray(ids)) boards[b] = ids.filter((x): x is string => typeof x === 'string' && !!x)
    return { v: 1, migrated: v.migrated === true, boards }
  } catch { return null }
}

function write(root: string, own: OwnFile): void {
  const f = fileOf(root)
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  const tmp = `${f}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(own) + '\n', { mode: 0o600 })
  renameSync(tmp, f)
  cache.delete(root)
}

/** The first 0.31 start's migration (idempotent: a file that says `migrated` is left as it is). */
export function migrateOwnership(root: string): void {
  const have = read(root)
  if (have?.migrated) return
  // (a dictionary without a prototype: a board may be called `constructor`)
  const boards: Record<string, string[]> = Object.assign(Object.create(null), have?.boards ?? {})
  const ledger = ledgerOwned(root)
  const me = localProfile(root).email.toLowerCase()
  for (const board of listBoards(commentsOf(root))) {
    const ids = new Set(Object.hasOwn(boards, board) ? boards[board] : [])
    for (const e of readLog(commentsOf(root), board)) {
      if ((e.type !== 'create' && e.type !== 'reply') || !e.commentId || e.agent || e.agentMeta) continue
      const theirs = (e.author?.email ?? '').toLowerCase()
      if (ledger.has(`${board}\t${e.id}`) || (me ? theirs === me : !theirs)) ids.add(e.commentId)
    }
    if (ids.size) boards[board] = [...ids]
  }
  write(root, { v: 1, migrated: true, boards })
}

function sets(root: string): Map<string, Set<string>> {
  const f = fileOf(root)
  let key = ''
  try { const st = statSync(f); key = `${st.mtimeMs}:${st.size}` } catch { /* none yet */ }
  const hit = cache.get(root)
  if (hit && hit.key === key && key) return hit.sets
  if (!key || !read(root)?.migrated) migrateOwnership(root)
  const own = read(root) ?? { v: 1 as const, migrated: true, boards: Object.create(null) as Record<string, string[]> }
  const out = new Map(Object.entries(own.boards).map(([b, ids]) => [b, new Set(ids)]))
  try { const st = statSync(f); cache.set(root, { key: `${st.mtimeMs}:${st.size}`, own, sets: out }) } catch { /* unwritable: no cache */ }
  return out
}

/** Record messages written here for the local human (create or reply comment ids on `board`). */
export function recordOwn(root: string, board: string, ids: readonly string[]): void {
  const fresh = ids.filter((x) => typeof x === 'string' && !!x)
  if (!board || !fresh.length) return
  sets(root)   // migrated first: a fresh file never skips the migration
  const own = read(root) ?? { v: 1 as const, migrated: true, boards: Object.create(null) as Record<string, string[]> }
  const list = new Set(Object.hasOwn(own.boards, board) ? own.boards[board] : [])
  const before = list.size
  for (const id of fresh) list.add(id)
  if (list.size === before) return
  own.boards[board] = [...list]
  write(root, own)
}

/** Is this message (a create or reply comment id on `board`) the local human's? */
export function ownsMessage(root: string, board: string, commentId: string): boolean {
  return !!commentId && !!sets(root).get(board)?.has(commentId)
}

/** Every message this machine's human owns, per board - what the shell asks (`GET comment-ownership`). */
export function ownership(root: string): Record<string, string[]> {
  return Object.fromEntries([...sets(root)].map(([b, ids]) => [b, [...ids]]))
}
