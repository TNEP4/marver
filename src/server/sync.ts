/**
 * Dev ↔ published comment sync - one merge rule, run from the dev side.
 *
 * The published serve is the canonical home; the repo's design/comments/ is the
 * mirror the agent reads. Each exchange is: pull remote events → union into local
 * files; push the local events the remote lacks (chunked - the server unions too).
 * Idempotent and retry-safe by construction, so a dropped exchange costs nothing.
 *
 * Credentials: design/.local/collab.json {url, token} written by `comments connect`.
 * The token is a server session held by the DEV PROCESS only - pages never see it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvents, diffEvents, listBoards, readLog, type CommentEvent } from './comments.ts'

export interface Collab { url: string; token: string; email?: string; name?: string; avatar?: string }

const collabFile = (root: string) => join(root, 'design', '.local', 'collab.json')

export function loadCollab(root: string): Collab | null {
  try {
    const c = JSON.parse(readFileSync(collabFile(root), 'utf8'))
    return typeof c?.url === 'string' && typeof c?.token === 'string' ? c : null
  } catch { return null }
}

export function saveCollab(root: string, collab: Collab) {
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  writeFileSync(collabFile(root), JSON.stringify(collab, null, 2) + '\n', { mode: 0o600 })
}

/** One full exchange. Returns per-board counts, or throws on auth/network failure. */
export async function syncOnce(root: string, collab: Collab): Promise<Record<string, { pulled: number; pushed: number }>> {
  const dir = join(root, 'design', 'comments')
  const auth = { authorization: `Bearer ${collab.token}` }
  const base = collab.url.replace(/\/+$/, '')

  const bres = await fetch(`${base}/__mv/api/boards`, { headers: auth })
  if (bres.status === 401) throw new Error('the connect token was rejected - run `comments connect` again')
  if (!bres.ok) throw new Error(`published canvas answered ${bres.status} - is it up?`)
  const { rights } = await bres.json() as { rights: Record<string, 'read' | 'comment'> }

  const boards = [...new Set([...Object.keys(rights), ...listBoards(dir)])]
  const out: Record<string, { pulled: number; pushed: number }> = {}
  const failures: string[] = []
  for (const board of boards) {
    if (!(board in rights)) continue          // local-only board: nothing published to sync with
    const res = await fetch(`${base}/__mv/api/comments/${board}`, { headers: auth })
    if (!res.ok) { failures.push(`${board}: pull ${res.status}`); continue }
    const { events: remote } = await res.json() as { events: CommentEvent[] }
    const pulled = appendEvents(dir, board, remote).length
    let pushed = 0
    if (rights[board] === 'comment') {
      // Live Jam: agent-authored events are dev-local in v1 - never pushed to the published canvas
      // (the published client validator rejects agent provenance; publishing them is a P3 feature
      // needing a trusted path). Filter them out of the push set.
      const missing = diffEvents(readLog(dir, board), remote.map((e) => e.id)).filter((e) => !(e as { agent?: boolean }).agent)
      for (let i = 0; i < missing.length; i += 100) {
        const r = await fetch(`${base}/__mv/api/comments/${board}`, {
          method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ events: missing.slice(i, i + 100) }),
        })
        if (r.ok) pushed += (await r.json() as any).accepted ?? 0
        else failures.push(`${board}: push ${r.status} ${((await r.json().catch(() => null)) as any)?.error ?? ''}`.trim())
      }
    }
    out[board] = { pulled, pushed }
  }
  // a partial exchange must never read as a clean one - the caller decides retry vs surface
  if (failures.length) throw new Error(`sync incomplete - ${failures.join(' · ')}`)
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
