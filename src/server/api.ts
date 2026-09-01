import type { Connect } from 'vite'
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { ROUTE } from '../cli/name.ts'
import { hash } from './manifest.ts'
import { isConnected, localProfile } from './profile.ts'

const BOARD_NAME = /^[a-z0-9][a-z0-9-]*$/
const BODY_LIMIT = 1_000_000
const CSRF_MAX_AGE = 30 * 24 * 3600

/** Read one cookie value off the request. */
function cookie(req: any, name: string): string {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(String(req.headers.cookie ?? ''))
  return m ? m[1] : ''
}

/** The owner gate. The dev server is 127.0.0.1-only, so the live threat is a
 *  cross-origin drive-by page firing a POST at localhost. Two defenses, mirroring the published
 *  side (collab.ts:206): a double-submit cookie (mv_c is JS-readable same-origin, so a cross-origin
 *  page cannot read it to echo x-mv-c), plus an Origin allowlist. Only a POST that passes this is
 *  eligible to be ledgered, so a forged @marver can never authorize the local agent. */
export function ownerGated(req: any): boolean {
  const c = cookie(req, 'mv_c')
  if (!c || req.headers['x-mv-c'] !== c) return false
  const origin = req.headers.origin
  if (origin) {
    // Full same-origin: the Origin's host:port must equal the request's Host. Cookies are not
    // port-scoped, so a hostname-only check would let another localhost port read mv_c and pass.
    try {
      if (new URL(String(origin)).host !== String(req.headers.host ?? '')) return false
    } catch { return false }
  }
  return true
}

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

export function apiMiddleware(root: string, opts: { viewports?: Record<string, { width: number; height: number }>; origin?: () => string | null } = {}): Connect.NextHandleFunction {
  const boardsDir = join(root, 'design', 'boards')

  const boardPath = (name: string): string | null => {
    if (!BOARD_NAME.test(name)) return null
    mkdirSync(boardsDir, { recursive: true })
    const p = resolve(boardsDir, `${name}.json`)
    return contained(p, boardsDir) ? p : null
  }

  // A board name off the wire: a string, bounded, and matching the on-disk grammar. The
  // length bound caps a pathological rewrite/filename; BOARD_NAME already blocks separators.
  const validName = (n: unknown): n is string => typeof n === 'string' && n.length >= 1 && n.length <= 64 && BOARD_NAME.test(n)
  // realpath(dir) must stay inside realpath(root) - a symlinked design/boards can't escape.
  const underRoot = (dir: string): boolean => {
    try {
      const rr = realpathSync(root); const rd = realpathSync(dir)
      return rd === rr || rd.startsWith(rr + sep)
    } catch { return false }
  }
  // a symlinked board FILE could redirect a follow-through write; contained() only vets the
  // resolved target's directory, not the link itself, so check the link node directly.
  const notSymlink = (p: string): boolean => { try { return !existsSync(p) || !lstatSync(p).isSymbolicLink() } catch { return false } }
  // Does a filesystem NODE exist at p? lstat (not existsSync) so a DANGLING symlink counts as
  // present - else the no-clobber check misses it and renameSync would silently replace it.
  const nodeExists = (p: string): boolean => { try { lstatSync(p); return true } catch { return false } }

  // boot: sweep temp files abandoned by a killed process
  try {
    for (const f of readdirSync(boardsDir)) if (f.endsWith('.tmp')) rmSync(join(boardsDir, f), { force: true })
  } catch { /* boards dir may not exist yet */ }

  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (!url.pathname.startsWith(`${ROUTE}/api/`)) return next()
    const path = url.pathname.slice(`${ROUTE}/api/`.length)

    // Prime the double-submit cookie on the shell's first GET so csrf() has a value to echo
    // (the published side sets mv_c at sign-in; dev has no sign-in, so we set it here). JS-readable
    // by design - a same-origin page can read it, a cross-origin page cannot.
    if (req.method === 'GET' && !cookie(req, 'mv_c')) {
      res.setHeader('set-cookie', `mv_c=${randomBytes(16).toString('base64url')}; Path=/; Max-Age=${CSRF_MAX_AGE}; SameSite=Lax`)
    }

    try {
      if (path === 'policy' && req.method === 'GET') {
        // dev-only policy preview (v1.5): the shell hydrates BOARD_POLICY from
        // the repo's publish.json so an author sees slides mode exactly as
        // viewers will. Lenient by design - dev preview, not enforcement.
        try {
          const raw = JSON.parse(readFileSync(join(root, 'design', 'publish.json'), 'utf8'))
          const boards: Record<string, unknown> = {}
          for (const [n, level] of Object.entries(raw?.boards ?? {})) {
            if (typeof level !== 'object' || level === null) continue
            const p2 = level as Record<string, unknown>
            boards[n] = {
              ...(typeof p2.type === 'string' ? { type: p2.type } : {}),
              ...(typeof p2.open === 'string' ? { open: p2.open } : {}),
              ...(p2.lock === true ? { lock: true } : {}),
              ...(typeof p2.transition === 'string' ? { transition: p2.transition } : {}),
              ...(typeof p2.chrome === 'string' ? { chrome: p2.chrome } : {}),
            }
          }
          return json(res, 200, { boards })
        } catch { return json(res, 200, { boards: {} }) }
      }
      if (path === 'boards' && req.method === 'GET') {
        mkdirSync(boardsDir, { recursive: true })
        const list = readdirSync(boardsDir)
          .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
          .map((f) => {
            const content = readFileSync(join(boardsDir, f), 'utf8')
            // `order` (a number in the board file) lets the agent rank boards logically; the switcher
            // sorts by it, so the FIRST board is the landing board and all-scenes always sinks last.
            let order: number | undefined
            try { const o = (JSON.parse(content) as { order?: unknown })?.order; if (typeof o === 'number' && Number.isFinite(o)) order = o } catch { /* malformed board */ }
            return { name: f.replace(/\.json$/, ''), sha256: hash(content), order }
          })
        return json(res, 200, list)
      }

      // Rename a board file. Owner-gated (a mutation). Placed BEFORE the boards/<name> regex
      // so 'rename'/'reorder' are never captured as ordinary board names.
      if (path === 'boards/rename' && req.method === 'POST') {
        if (!ownerGated(req)) return json(res, 403, { error: 'forbidden' })
        const raw = await readBody(req)
        if (raw == null) return json(res, 400, { error: 'body too large or unreadable' })
        let parsed: unknown
        try { parsed = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
        if (!parsed || typeof parsed !== 'object') return json(res, 400, { error: 'expected an object' })
        const { from, to } = parsed as { from?: unknown; to?: unknown }
        if (!validName(from) || !validName(to)) return json(res, 400, { error: 'invalid board name' })
        if (to === 'all-scenes' || from === 'all-scenes' || to === from) return json(res, 400, { error: 'invalid rename' })
        if (!underRoot(boardsDir)) return json(res, 400, { error: 'boards directory escapes the project' })
        const fromPath = boardPath(from), toPath = boardPath(to)
        if (!fromPath || !toPath) return json(res, 400, { error: 'invalid board name' })
        if (!existsSync(fromPath)) return json(res, 404, { error: `board "${from}" does not exist` })
        if (!notSymlink(fromPath)) return json(res, 400, { error: 'refusing to rename a symlinked board file' })
        // Persisted comments are board-keyed in three places a file move can't follow (the
        // local JSONL, the client's in-memory union, and the remote-canonical sync). Rename is
        // only safe on a board with no threads and no live connection.
        if (isConnected(root)) return json(res, 409, { error: 'disconnect before renaming boards - comment sync is board-keyed' })
        if (existsSync(join(root, 'design', 'comments', `${from}.jsonl`))) return json(res, 409, { error: 'rename a board before commenting on it - this board has threads' })
        if (nodeExists(toPath)) return json(res, 409, { error: `a board named "${to}" already exists` })   // lstat: a dangling symlink counts
        // Atomic no-clobber: link() refuses (EEXIST) if the destination name exists - closing the
        // check->rename TOCTOU. Then drop the old name. A crash between leaves both names on one
        // inode (identical content), never a clobbered board. Filesystems without hardlinks fall
        // back to the checked rename (the nodeExists guard above already covered the common race).
        try { linkSync(fromPath, toPath) }
        catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'EEXIST') return json(res, 409, { error: `a board named "${to}" already exists` })
          // ONLY a filesystem that genuinely lacks hardlinks falls back to a checked rename; any
          // other error (ENOSPC, EACCES, ...) rethrows to the outer 500 rather than silently
          // taking the clobber-prone path.
          if (code !== 'EPERM' && code !== 'ENOSYS' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw err
          if (nodeExists(toPath)) return json(res, 409, { error: `a board named "${to}" already exists` })
          renameSync(fromPath, toPath)
          return json(res, 200, { name: to })
        }
        rmSync(fromPath)
        return json(res, 200, { name: to })
      }

      // Reorder boards: write each named board's `order` field to its position. Advisory sort
      // key, so per-file writes (not batch-atomic) are non-corrupting. Owner-gated.
      if (path === 'boards/reorder' && req.method === 'POST') {
        if (!ownerGated(req)) return json(res, 403, { error: 'forbidden' })
        const raw = await readBody(req)
        if (raw == null) return json(res, 400, { error: 'body too large or unreadable' })
        let parsed: unknown
        try { parsed = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
        if (!parsed || typeof parsed !== 'object') return json(res, 400, { error: 'expected an object' })
        const order = (parsed as { order?: unknown }).order
        if (!Array.isArray(order) || order.length < 1 || order.length > 200) return json(res, 400, { error: 'invalid order' })
        if (!order.every(validName) || order.some((n) => n === 'all-scenes')) return json(res, 400, { error: 'invalid board name in order' })
        if (new Set(order as string[]).size !== order.length) return json(res, 400, { error: 'duplicate board in order' })
        if (!underRoot(boardsDir)) return json(res, 400, { error: 'boards directory escapes the project' })
        for (let i = 0; i < order.length; i++) {
          const p = boardPath(order[i] as string)
          if (!p || !existsSync(p) || !notSymlink(p)) continue
          let obj: Record<string, unknown>
          try { obj = JSON.parse(readFileSync(p, 'utf8')) } catch { continue }
          if (!obj || typeof obj !== 'object') continue
          obj.order = i
          atomicWrite(p, JSON.stringify(obj, null, 2) + '\n')
        }
        return json(res, 200, { ok: true })
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
          // Preserve author-owned fields the shell does not manage. `order` (the board's rank in the
          // switcher) lives in the file but never rides the shell's save shape, so a routine autosave
          // would otherwise strip it. Carry it over from disk when the incoming board omits it.
          const incoming = body.board as Record<string, unknown> | null
          if (incoming && typeof incoming === 'object' && incoming.order === undefined && current) {
            try { const o = (JSON.parse(current) as { order?: unknown }).order; if (typeof o === 'number' && Number.isFinite(o)) incoming.order = o } catch { /* malformed disk */ }
          }
          const next2 = JSON.stringify(body.board, null, 2) + '\n'
          atomicWrite(p, next2)
          return json(res, 200, { sha256: hash(next2) })
        }
      }

      // ---- shot: render one frame headless and hand back a PNG path. Exists for the
      // Live Jam verify loop: shell-ful agents and humans reach the renderer here; no-shell
      // jam agents use the file-drop inbox (plugin.ts) instead, so this endpoint is never
      // their path. Owner-gated like `work`: it SPAWNS a browser and writes a file, so a
      // cross-origin drive-by must not be able to trigger it - the owner cookie (shell) or
      // the dev-session token (CLI) is required, both unreachable cross-origin.
      if (path === 'shot' && req.method === 'GET') {
        const { readDevInfo } = await import('./work.ts')
        const token = readDevInfo(root)?.token
        if (!ownerGated(req) && !(token && req.headers['x-mv-work'] === token)) return json(res, 403, { error: 'forbidden' })
        const frameId = url.searchParams.get('frame') ?? ''
        const theme = url.searchParams.get('theme') ?? 'light'
        // Origin from the ACTUAL listening socket, never the client-controlled Host header - so a
        // spoofed Host can't point the headless render at another server. Falls back to Host only
        // if the socket address is unavailable (the request already passed the owner/token gate).
        const origin = opts.origin?.() ?? `http://${req.headers.host ?? 'localhost'}`
        const { shootFrame } = await import('./shot.ts')
        const r = await shootFrame({ root, viewports: opts.viewports ?? {}, frameId, theme, origin })
        if (!r.ok) return json(res, r.error.startsWith('unknown frame') ? 404 : r.error === 'invalid theme' ? 400 : 503, { error: r.error })
        return json(res, 200, { path: r.path, frame: frameId, theme, width: r.width, height: r.height, scale: r.scale, ...(r.truncated ? { truncated: true, note: r.note } : {}) })
      }

      // ---- comments: the dev mirror of serve's collab API - same shapes,
      // so the shell ships ONE client. Identity is the local profile (it's the
      // designer's machine); rights are 'comment' everywhere locally.
      if (path === 'me' && req.method === 'GET') {
        const prof = localProfile(root)
        return json(res, 200, { user: prof, role: 'owner', local: true, connected: isConnected(root) })
      }
      if (path === 'profile' && req.method === 'POST') {
        // same gate as the comments POST: identity feeds the published push author, so a
        // drive-by page must never be able to rewrite it
        if (!ownerGated(req)) return json(res, 403, { error: 'forbidden' })
        const raw = await readBody(req)
        if (raw == null) return json(res, 400, { error: 'body too large' })
        let b: any; try { b = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
        const dir = join(root, 'design', '.local')
        mkdirSync(dir, { recursive: true })
        // patch over profile.json ONLY (never bake the connect identity into the local file);
        // avatars must be small raster data-URIs - same bar the published server holds
        const { validAvatar } = await import('./collab.ts')
        let cur: Record<string, unknown> = {}
        try { cur = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')) } catch { /* first save */ }
        const prof = {
          ...cur,
          ...(typeof b.name === 'string' && b.name.trim() ? { name: b.name.trim() } : {}),
          ...(typeof b.email === 'string' ? { email: b.email.trim() } : {}),
          ...(b.avatar === '' ? { avatar: undefined } : validAvatar(b.avatar) ? { avatar: b.avatar } : {}),
        }
        atomicWrite(join(dir, 'profile.json'), JSON.stringify(prof, null, 2) + '\n')
        return json(res, 200, { user: localProfile(root) })
      }
      if (path === 'work') {
        // The working-state rail (work.ts): chat-driven agents mark the frames they are
        // building so the canvas glows before the first component exists. Auth is the
        // owner cookie (a browser surface) OR the dev.json token (the CLI/agent path -
        // readable only by processes that can already read the repo).
        const { workActivity, readDevInfo, WORK_TTL_DEFAULT, WORK_TTL_MAX } = await import('./work.ts')
        const tokenOk = () => {
          const t = readDevInfo(root)?.token
          return !!t && req.headers['x-mv-work'] === t
        }
        if (req.method === 'GET') {
          if (!ownerGated(req) && !tokenOk()) return json(res, 403, { error: 'forbidden' })
          return json(res, 200, { frames: workActivity.active() })
        }
        if (req.method === 'POST') {
          if (!ownerGated(req) && !tokenOk()) return json(res, 403, { error: 'forbidden' })
          const raw = await readBody(req)
          if (raw == null) return json(res, 400, { error: 'body too large' })
          let b: any; try { b = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
          const frames: string[] = Array.isArray(b.frames) ? b.frames.filter((f: unknown) => typeof f === 'string' && f) : []
          const on = b.on !== false
          // this endpoint only ever touches CLI-scoped leases - jam jobs keep their own
          if (!on && b.all === true) { workActivity.clearAll('cli'); return json(res, 200, { frames: workActivity.active() }) }
          if (!frames.length) return json(res, 400, { error: 'frames required' })
          const ttl = Math.min(Math.max(Number(b.ttlMs) || WORK_TTL_DEFAULT, 10_000), WORK_TTL_MAX)
          for (const f of frames) on ? workActivity.mark(f, ttl, 'cli') : workActivity.clear(f, 'cli')
          return json(res, 200, { frames: workActivity.active() })
        }
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
          // Owner gate: only a same-origin, cookie-proving POST may write - and be ledgered as
          // an authorization for the Live Jam daemon.
          if (!ownerGated(req)) return json(res, 403, { error: 'forbidden' })
          const raw = await readBody(req)
          if (raw == null) return json(res, 400, { error: 'body too large' })
          let b: any; try { b = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
          const incoming = Array.isArray(b.events) ? b.events : []
          const me = localProfile(root)
          // fill-at-origin, never rewrite: this endpoint is where dev-born events are
          // CREATED, so completing them here is fine - but an event that already
          // carries board/author must pass through byte-identical, or the id-keyed
          // sync would hold two versions of "the same" event forever
          const stamped = incoming.map((ev: any) => {
            // Live Jam: the public POST is never allowed to set agent provenance - only the
            // daemon's in-process writer stamps agent/agentMeta. Strip any client-supplied
            // agent/agentMeta/origin so a same-origin page cannot forge a Marver-authored event.
            const { agent: _a, agentMeta: _am, origin: _o, ...clean } = ev
            return {
              ...clean,
              board: clean.board ?? cm[1],
              author: clean.author ?? (['create', 'reply', 'react', 'edit'].includes(clean.type) ? me : undefined),
            }
          })
          const fresh = appendEvents(dir, cm[1], stamped)
          // Authorize the owner's fresh create/reply events for the Live Jam daemon. Order is the
          // contract: appendEvents fsync'd the event FIRST (above), then we ledger it - a crash
          // between leaves the event present-but-unauthorized (won't trigger), the safe direction.
          // Agent events never reach here (they go through the daemon's in-process writer), so the
          // ledger only ever holds owner input - the fail-closed direction of atomicity.
          const { record } = await import('./jam/ledger.ts')
          for (const ev of fresh) if (ev.type === 'create' || ev.type === 'reply') record(root, cm[1], ev.id)
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
