import type { Connect } from 'vite'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { ROUTE } from '../cli/name.ts'
import { hash } from './manifest.ts'

const BOARD_NAME = /^[a-z0-9][a-z0-9-]*$/
const BODY_LIMIT = 1_000_000

function json(res: any, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function readBody(req: any): Promise<string | null> {
  return new Promise((done) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > BODY_LIMIT) { done(null); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => done(null))
  })
}

/** Atomic write: random temp name (no predictable symlink target), rename, and a
 *  copy-fallback only for the Windows rename errors - anything else rethrows. */
function atomicWrite(file: string, content: string) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, content, { flag: 'wx' })
  try {
    renameSync(tmp, file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') { rmSync(tmp, { force: true }); throw err }
    copyFileSync(tmp, file)
    rmSync(tmp, { force: true })
  }
}

/** Containment beyond string prefixes: the realpath of the parent dir must stay inside base. */
function contained(target: string, base: string): boolean {
  try {
    const realBase = realpathSync(base)
    const parent = realpathSync(resolve(target, '..'))
    if (parent !== realBase && !parent.startsWith(realBase + sep)) return false
    // if the file itself exists, it must not be a symlink escaping base
    if (existsSync(target)) {
      const real = realpathSync(target)
      return real === realBase || real.startsWith(realBase + sep)
    }
    return true
  } catch { return false }
}

export function apiMiddleware(root: string): Connect.NextHandleFunction {
  const boardsDir = join(root, 'design', 'boards')

  const boardPath = (name: string): string | null => {
    if (!BOARD_NAME.test(name)) return null
    mkdirSync(boardsDir, { recursive: true })
    const p = resolve(boardsDir, `${name}.json`)
    return contained(p, boardsDir) ? p : null
  }

  // boot: sweep temp files abandoned by a killed process
  try {
    for (const f of readdirSync(boardsDir)) if (f.endsWith('.tmp')) rmSync(join(boardsDir, f), { force: true })
  } catch { /* boards dir may not exist yet */ }

  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (!url.pathname.startsWith(`${ROUTE}/api/`)) return next()
    const path = url.pathname.slice(`${ROUTE}/api/`.length)

    try {
      if (path === 'boards' && req.method === 'GET') {
        mkdirSync(boardsDir, { recursive: true })
        const list = readdirSync(boardsDir)
          .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
          .map((f) => {
            const content = readFileSync(join(boardsDir, f), 'utf8')
            return { name: f.replace(/\.json$/, ''), sha256: hash(content) }
          })
        return json(res, 200, list)
      }

      const boardMatch = /^boards\/([^/]+)$/.exec(path)
      if (boardMatch) {
        const p = boardPath(boardMatch[1])
        if (!p) return json(res, 400, { error: 'invalid board name' })
        if (req.method === 'GET') {
          // a board that does not exist yet is a normal state (all-scenes before first
          // save), not an error: 200 + board:null keeps the devtools console clean
          if (!existsSync(p)) return json(res, 200, { board: null })
          const content = readFileSync(p, 'utf8')
          try {
            return json(res, 200, { board: JSON.parse(content), sha256: hash(content) })
          } catch {
            return json(res, 422, { error: `board "${boardMatch[1]}" is not valid JSON - fix the file` })
          }
        }
        if (req.method === 'PUT') {
          const raw = await readBody(req)
          if (raw == null) return json(res, 400, { error: 'body too large or unreadable' })
          let body: { board: unknown; baseHash?: string; mustExist?: boolean }
          try { body = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
          // A9: an autosave of a previously-loaded board must never RESURRECT it. If the file
          // was renamed or deleted out from under the shell (agent, git, another tab), reject
          // instead of creating a ghost. Genuine board creation comes without mustExist.
          if (body.mustExist && !existsSync(p)) return json(res, 409, { error: 'board no longer exists on disk', gone: true })
          const current = existsSync(p) ? readFileSync(p, 'utf8') : ''
          if (current && body.baseHash !== hash(current)) {
            let disk: unknown = null
            try { disk = JSON.parse(current) } catch { /* malformed on disk; hash still tells the truth */ }
            return json(res, 409, { error: 'board changed on disk', board: disk, sha256: hash(current) })
          }
          mkdirSync(boardsDir, { recursive: true })
          const next2 = JSON.stringify(body.board, null, 2) + '\n'
          atomicWrite(p, next2)
          return json(res, 200, { sha256: hash(next2) })
        }
      }

      // ---- comments (SPEC-M3): the dev mirror of serve's collab API - same shapes,
      // so the shell ships ONE client. Identity is the local profile (it's the
      // designer's machine); rights are 'comment' everywhere locally.
      if (path === 'me' && req.method === 'GET') {
        const prof = localProfile(root)
        return json(res, 200, { user: prof, role: 'owner', local: true })
      }
      if (path === 'profile' && req.method === 'POST') {
        const raw = await readBody(req)
        if (raw == null) return json(res, 400, { error: 'body too large' })
        let b: any; try { b = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
        const dir = join(root, 'design', '.local')
        mkdirSync(dir, { recursive: true })
        const prof = { ...localProfile(root), ...(typeof b.name === 'string' && b.name.trim() ? { name: b.name.trim() } : {}), ...(typeof b.email === 'string' ? { email: b.email.trim() } : {}), ...(typeof b.avatar === 'string' ? { avatar: b.avatar || undefined } : {}) }
        atomicWrite(join(dir, 'profile.json'), JSON.stringify(prof, null, 2) + '\n')
        return json(res, 200, { user: prof })
      }
      if (path === 'boards.rights' && req.method === 'GET') {
        // every board is commentable in dev; the published policy applies out there
        const { listBoards } = await import('./comments.ts')
        const stored = listBoards(join(root, 'design', 'comments'))
        return json(res, 200, { local: true, stored })
      }
      const cm = /^comments\/([a-z0-9][a-z0-9-]*)$/.exec(path)
      if (cm) {
        const { appendEvents, readLog } = await import('./comments.ts')
        const dir = join(root, 'design', 'comments')
        if (req.method === 'GET') return json(res, 200, { events: readLog(dir, cm[1]) })
        if (req.method === 'POST') {
          const raw = await readBody(req)
          if (raw == null) return json(res, 400, { error: 'body too large' })
          let b: any; try { b = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
          const incoming = Array.isArray(b.events) ? b.events : []
          const me = localProfile(root)
          // fill-at-origin, never rewrite: this endpoint is where dev-born events are
          // CREATED, so completing them here is fine - but an event that already
          // carries board/author must pass through byte-identical, or the id-keyed
          // sync would hold two versions of "the same" event forever
          const stamped = incoming.map((ev: any) => ({
            ...ev,
            board: ev.board ?? cm[1],
            author: ev.author ?? (['create', 'reply', 'react', 'edit'].includes(ev.type) ? me : undefined),
          }))
          const fresh = appendEvents(dir, cm[1], stamped)
          // push in the background - the periodic sync catches anything this drops
          void backgroundPush(root)
          return json(res, 200, { accepted: fresh.length })
        }
      }
      if (path === 'sync' && req.method === 'POST') {
        const { loadCollab, syncOnce } = await import('./sync.ts')
        const collab = loadCollab(root)
        if (!collab) return json(res, 200, { connected: false })
        try { return json(res, 200, { connected: true, boards: await syncOnce(root, collab) }) }
        catch (err) { return json(res, 502, { connected: true, error: (err as Error).message }) }
      }

      json(res, 404, { error: 'unknown endpoint' })
    } catch (err) {
      json(res, 500, { error: (err as Error).message })
    }
  }
}

function localProfile(root: string): { email: string; name: string; avatar?: string } {
  // the connect account IS the dev identity once connected - events born here must
  // carry an author the published server will accept (it validates author == session)
  try {
    const c = JSON.parse(readFileSync(join(root, 'design', '.local', 'collab.json'), 'utf8'))
    if (typeof c?.email === 'string' && c.email) return { email: c.email, name: c.name ?? 'Designer' }
  } catch { /* not connected */ }
  try {
    const p = JSON.parse(readFileSync(join(root, 'design', '.local', 'profile.json'), 'utf8'))
    if (typeof p?.name === 'string') return { email: p.email ?? '', name: p.name, avatar: p.avatar }
  } catch { /* no profile yet */ }
  return { email: '', name: 'Designer' }
}

let pushTimer: ReturnType<typeof setTimeout> | null = null
/** Debounced fire-and-forget push after a local write; failures are silent - the
 *  30s sync loop is the reliability layer, this is just latency. */
function backgroundPush(root: string) {
  if (pushTimer) return
  pushTimer = setTimeout(async () => {
    pushTimer = null
    try {
      const { loadCollab, syncOnce } = await import('./sync.ts')
      const collab = loadCollab(root)
      if (collab) await syncOnce(root, collab)
    } catch { /* the loop will retry */ }
  }, 1500)
}
