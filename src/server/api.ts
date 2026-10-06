import type { Connect } from 'vite'
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { ROUTE } from '../cli/name.ts'
import { hash, scanFrames, setSceneTitle } from './manifest.ts'
import { isConnected, localProfile } from './profile.ts'
import { BOARD_NAME, buildTree, folderMap, FOLDERS_FILE, readDescription, readTitle, REGISTRY_VERSION_FLAT, REGISTRY_VERSION_NESTED, TITLE_MAX, TREE_PROTOCOL, validateWire, wireKids, type WireItem } from '../shared/board-tree.ts'
import { AUTHOR_FIELDS, boardFields, checkBoardsDir, isRegularFile, listBoardFiles, nodeExists as nodeAt, readRegistry, withRegistryLock } from './boards.ts'
import { HAS_STATUS, readCapability, readReason, readStatusWord, readType, resolveType, settableStatuses } from '../shared/board-types.ts'
import { annotateBoards, planWithStage, readContextFacts } from './board-status.ts'
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

export function apiMiddleware(root: string, opts: { viewports?: Record<string, { width: number; height: number }>; origin?: () => string | null; bakeGen?: () => number } = {}): Connect.NextHandleFunction {
  const boardsDir = join(root, 'design', 'boards')
  const foldersPath = join(boardsDir, FOLDERS_FILE)

  const boardPath = (name: string): string | null => {
    if (!validName(name)) return null                   // the grammar AND the 64 bound - a longer file would hide from every lister
    if (checkBoardsDir(root, boardsDir)) return null     // a symlinked design/ or boards/ is refused on EVERY path, before the mkdir could follow it
    mkdirSync(boardsDir, { recursive: true })
    const p = resolve(boardsDir, `${name}.json`)
    return contained(p, boardsDir) ? p : null
  }

  // A board name off the wire: a string, bounded, and matching the on-disk grammar. The
  // length bound caps a pathological rewrite/filename; BOARD_NAME already blocks separators.
  const validName = (n: unknown): n is string => typeof n === 'string' && n.length >= 1 && n.length <= 64 && BOARD_NAME.test(n)
  // design/boards itself: never a symlink, always inside the root (boards.ts) - checked before
  // every read and write of the directory
  const dirError = (): string | null => checkBoardsDir(root, boardsDir)
  // a symlinked board FILE could redirect a follow-through write; contained() only vets the
  // resolved target's directory, not the link itself, so check the link node directly. lstat,
  // so a DANGLING symlink is refused too (existsSync would call it absent).
  const notSymlink = (p: string): boolean => !nodeAt(p) || isRegularFile(p)
  // Does a filesystem NODE exist at p? lstat (not existsSync) so a DANGLING symlink counts as
  // present - else the no-clobber check misses it and renameSync would silently replace it.
  const nodeExists = nodeAt

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
        const de = dirError(); if (de) return json(res, 422, { error: de })
        mkdirSync(boardsDir, { recursive: true })
        // regular files on the board grammar only (boards.ts): never `_folders.json`, a temp
        // file, or a symlink. `order` ranks the board among its siblings; `folder` names the
        // sidebar folder it sits in - both author-owned, both read leniently. `sha256` is the
        // CAS token a tree write echoes for every board it touches.
        // spec 20: each board's resolved type (its own, else its folder's, else that folder's
        // parent's) and its status read from context/ - computed per read, so a change to the
        // shipped record shows on the next `sh:boards` refetch. Owner-only dev data: the
        // evidence lines ride along for the tooltip; a published build never carries them.
        const files = listBoardFiles(boardsDir).boards
        const rows = files.map((b) => ({ name: b.name, ...boardFields(b.json, validName) }))
        const reg = readRegistry(boardsDir)
        const regFolders = reg.state === 'ok' ? reg.folders : []
        const tree = buildTree(rows, regFolders)
        const fm = folderMap(tree)
        const facts = readContextFacts(root)
        const notes = annotateBoards(root, files, regFolders, (n) => fm.get(n) ?? null, facts)
        // what the sidebar's status picker may offer (dev only - nothing a build reads carries it)
        // per board: with context/, In progress and Building are offered where an open plan names its capability
        const settableFor = (cap: string) => settableStatuses(facts.present, !!facts.plans.get(cap)?.length)
        const list = files.map((b, i) => { const n = notes.get(b.name); return { ...rows[i], sha256: b.sha256, ...(n ?? {}), ...(n?.status ? { settable: settableFor(n.status.capability) } : {}) } })
        return json(res, 200, list)
      }

      // A board's status, decided by a person (the sidebar's picker): `status` one of the statuses
      // this board may be set to (settableStatuses - never Done, and never what context/ decides),
      // or null to clear the decision; a blocked board says why (`reason`). Only the board's
      // `status` and `reason` change - every other field is kept, and `baseHash` (the file as the
      // caller last saw it) turns a concurrent edit into a 409, nothing written. Owner-gated.
      if (path === 'boards/status' && req.method === 'POST') {
        if (!ownerGated(req)) return json(res, 403, { error: 'forbidden' })
        const raw = await readBody(req)
        if (raw == null) return json(res, 400, { error: 'body too large or unreadable' })
        let parsed: unknown
        try { parsed = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
        if (!parsed || typeof parsed !== 'object') return json(res, 400, { error: 'expected an object' })
        const { name, status: statusRaw, reason: reasonRaw, baseHash } = parsed as { name?: unknown; status?: unknown; reason?: unknown; baseHash?: unknown }
        if (!validName(name) || name === 'all-scenes') return json(res, 400, { error: 'invalid board name' })
        if (baseHash !== undefined && typeof baseHash !== 'string') return json(res, 400, { error: 'invalid baseHash' })
        const status = statusRaw === null ? null : readStatusWord(statusRaw)
        if (status === undefined) return json(res, 400, { error: 'invalid status' })
        const reason = readReason(reasonRaw)
        if (status === 'blocked' && !reason) return json(res, 400, { error: 'a blocked board says why - give a reason' })
        { const de = dirError(); if (de) return json(res, 400, { error: de }) }
        const file = boardPath(name)
        if (!file) return json(res, 400, { error: 'invalid board name' })
        if (!existsSync(file)) return json(res, 404, { error: `board "${name}" does not exist` })
        if (!notSymlink(file)) return json(res, 400, { error: 'refusing to write a symlinked board file' })
        const current = readFileSync(file, 'utf8')
        if (baseHash !== undefined && baseHash !== hash(current)) return json(res, 409, { error: 'board changed on disk', sha256: hash(current) })
        let obj: Record<string, unknown>
        try { obj = JSON.parse(current) } catch { return json(res, 422, { error: `board "${name}" is not valid JSON - fix the file` }) }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return json(res, 422, { error: `board "${name}" is not a JSON object - fix the file` })
        // the board's type as the sidebar resolves it: its own, else its folder's, else that folder's parent's
        const reg = readRegistry(boardsDir)
        const regFolders = reg.state === 'ok' ? reg.folders : []
        const all = listBoardFiles(boardsDir).boards
        const fm = folderMap(buildTree(all.map((b) => ({ name: b.name, ...boardFields(b.json, validName) })), regFolders))
        const folder = regFolders.find((f) => f.name === fm.get(name))
        const parent = folder?.parent ? regFolders.find((f) => f.name === folder.parent) : undefined
        const type = resolveType(obj.type, folder?.type, parent?.type)
        if (!HAS_STATUS.includes(type)) return json(res, 422, { error: `a ${type} board carries no status - only feature and project boards do` })
        const facts = readContextFacts(root)
        const capability = readCapability(obj.capability) ?? name
        const plans = facts.present ? (facts.plans.get(capability) ?? []) : []
        if (status !== null && !settableStatuses(facts.present, plans.length > 0).includes(status)) {
          return json(res, 422, { error: status === 'done'
            ? 'Done is never set by hand - it comes from context/shipped.md'
            : status === 'building' || status === 'in-progress'
              ? `${status === 'building' ? 'Building' : 'In progress'} needs an open plan naming ${capability} - context/plans/`
              : `with context/, ${status} is read from the evidence - a plan, a contract, the shipped record` })
        }
        if (facts.present && (status === 'building' || status === 'in-progress')) {
          // with context/ the evidence is the plan: Building writes its `stage: build`, In progress takes
          // it away - every open plan naming the capability, so they never disagree. The board's own
          // decision gives way (a board picked Building is no longer paused), as with any status picked.
          const writes: { file: string; next: string; raw: string }[] = []
          for (const p of plans) {
            const file = join(root, p.where)
            if (!notSymlink(file)) return json(res, 400, { error: `refusing to write a symlinked plan (${p.where})` })
            const raw = readFileSync(file, 'utf8')
            const next = planWithStage(raw, status === 'building' ? 'build' : null)
            if (next === null) return json(res, 422, { error: `${p.where} has no front matter to write its stage into - fix the file` })
            writes.push({ file, next, raw })
          }
          for (const w of writes) if (w.next !== w.raw) atomicWrite(w.file, w.next)
          delete obj.status; delete obj.reason
        } else {
          if (status === null) delete obj.status; else obj.status = status
          if (status === 'blocked') obj.reason = reason; else delete obj.reason
        }
        const next = JSON.stringify(obj, null, 2) + '\n'
        if (next !== current) atomicWrite(file, next)
        return json(res, 200, { name, sha256: hash(next) })
      }

      // The folder registry: which folders exist and where they rank at the root. A separate
      // resource (not boards/<name>) so it can never shadow a board named "folders". Malformed
      // is a 422 the sidebar shows - never a silently empty registry the next drag overwrites.
      if (path === 'folders' && req.method === 'GET') {
        const de = dirError(); if (de) return json(res, 422, { error: de })
        const reg = readRegistry(boardsDir)
        if (reg.state === 'malformed') return json(res, 422, { error: reg.error })
        return json(res, 200, { folders: reg.folders, sha256: reg.sha256 })
      }

      // Rename a board: its title (what humans see - free text, written into the file) and/or
      // its file name (`to`; omitted or equal to `from` = title only - the sidebar's path: a
      // board's file name is its identity for agents, publish.json, URLs and comment threads, so
      // the sidebar never moves it; an agent may). `baseHash` = the file as the caller last saw
      // it: a 409 (`sha256` answered) when it changed since, nothing written - a title never
      // overwrites an agent's concurrent edit. Order: the move first (a refused move changes
      // nothing), then the title into the file under its final name, every other field kept.
      // Answers the name and, when the file was rewritten, its new hash. Owner-gated (a
      // mutation). Placed BEFORE the boards/<name> regex so 'rename'/'reorder' are never
      // captured as ordinary board names.
      if (path === 'boards/rename' && req.method === 'POST') {
        if (!ownerGated(req)) return json(res, 403, { error: 'forbidden' })
        const raw = await readBody(req)
        if (raw == null) return json(res, 400, { error: 'body too large or unreadable' })
        let parsed: unknown
        try { parsed = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
        if (!parsed || typeof parsed !== 'object') return json(res, 400, { error: 'expected an object' })
        const { from, to: toRaw, title: titleRaw, baseHash } = parsed as { from?: unknown; to?: unknown; title?: unknown; baseHash?: unknown }
        const to = toRaw === undefined ? from : toRaw
        if (!validName(from) || !validName(to)) return json(res, 400, { error: 'invalid board name' })
        if (titleRaw !== undefined && (typeof titleRaw !== 'string' || Array.from(titleRaw).length > TITLE_MAX)) return json(res, 400, { error: 'invalid title' })
        if (baseHash !== undefined && typeof baseHash !== 'string') return json(res, 400, { error: 'invalid baseHash' })
        if (to === 'all-scenes' || from === 'all-scenes') return json(res, 400, { error: 'invalid rename' })
        if (to === from && titleRaw === undefined) return json(res, 400, { error: 'invalid rename' })
        { const de = dirError(); if (de) return json(res, 400, { error: de }) }
        const fromPath = boardPath(from), toPath = boardPath(to)
        if (!fromPath || !toPath) return json(res, 400, { error: 'invalid board name' })
        if (!existsSync(fromPath)) return json(res, 404, { error: `board "${from}" does not exist` })
        if (!notSymlink(fromPath)) return json(res, 400, { error: 'refusing to rename a symlinked board file' })
        const current = readFileSync(fromPath, 'utf8')
        if (baseHash !== undefined && baseHash !== hash(current)) return json(res, 409, { error: 'board changed on disk', sha256: hash(current) })
        let obj: Record<string, unknown> | null = null
        if (titleRaw !== undefined) {
          // the title goes into the file it names, everything else untouched (a malformed file
          // is the human's to fix first - never rewritten from a guess)
          let parsedBoard: unknown
          try { parsedBoard = JSON.parse(current) } catch { return json(res, 422, { error: `board "${from}" is not valid JSON - fix the file` }) }
          if (!parsedBoard || typeof parsedBoard !== 'object' || Array.isArray(parsedBoard)) return json(res, 422, { error: `board "${from}" is not a JSON object - fix the file` })
          obj = parsedBoard as Record<string, unknown>
        }
        let next: string | undefined
        if (obj) {
          const title = readTitle(titleRaw)
          if (title) obj.title = title; else delete obj.title
          next = JSON.stringify(obj, null, 2) + '\n'
        }
        if (to !== from) {
          // Persisted comments are board-keyed in three places a file move can't follow (the
          // local JSONL, the client's in-memory union, and the remote-canonical sync). A move is
          // only safe on a board with no threads and no live connection.
          if (isConnected(root)) return json(res, 409, { error: 'disconnect before renaming boards - comment sync is board-keyed' })
          if (existsSync(join(root, 'design', 'comments', `${from}.jsonl`))) return json(res, 409, { error: 'rename a board before commenting on it - this board has threads' })
          if (nodeExists(toPath)) return json(res, 409, { error: `a board named "${to}" already exists` })   // lstat: a dangling symlink counts
          // Atomic no-clobber: the destination is created with `wx` (a title rides in it) or
          // link()ed (EEXIST if the name exists) - closing the check->move TOCTOU - then the old
          // name is dropped. A crash between leaves both names, never a clobbered board and never
          // a moved-but-untitled one. Filesystems without hardlinks fall back to the checked
          // rename (the nodeExists guard above already covered the common race).
          try { if (next !== undefined) writeFileSync(toPath, next, { flag: 'wx' }); else linkSync(fromPath, toPath) }
          catch (err) {
            const code = (err as NodeJS.ErrnoException).code
            if (code === 'EEXIST') return json(res, 409, { error: `a board named "${to}" already exists` })
            // ONLY a filesystem that genuinely lacks hardlinks falls back to a checked rename; any
            // other error (ENOSPC, EACCES, ...) rethrows to the outer 500 rather than silently
            // taking the clobber-prone path.
            if (next !== undefined || (code !== 'EPERM' && code !== 'ENOSYS' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP')) throw err
            if (nodeExists(toPath)) return json(res, 409, { error: `a board named "${to}" already exists` })
            renameSync(fromPath, toPath)
            return json(res, 200, { name: to })
          }
          rmSync(fromPath)
          return json(res, 200, { name: to, ...(next !== undefined ? { sha256: hash(next) } : {}) })
        }
        atomicWrite(toPath, next!)
        return json(res, 200, { name: to, sha256: hash(next!) })
      }

      // A scene's title - what humans see in the sidebar. Written into the YAML front matter of
      // the scene's `_brief.md` (created front-matter-only when there is no brief); the directory
      // never moves from here - a scene rename changes every frame id, an agent's refactor.
      if (path === 'scenes/rename' && req.method === 'POST') {
        if (!ownerGated(req)) return json(res, 403, { error: 'forbidden' })
        const raw = await readBody(req)
        if (raw == null) return json(res, 400, { error: 'body too large or unreadable' })
        let parsed: unknown
        try { parsed = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
        if (!parsed || typeof parsed !== 'object') return json(res, 400, { error: 'expected an object' })
        const { scene, title } = parsed as { scene?: unknown; title?: unknown }
        // a scene is what the manifest scan calls one: a directory under design/scenes with
        // frames in it - no other grammar, and never a path
        if (typeof scene !== 'string' || !scene || scene.length > 128 || /[\\/]/.test(scene) || scene === '.' || scene === '..') return json(res, 400, { error: 'invalid scene name' })
        if (typeof title !== 'string' || Array.from(title).length > TITLE_MAX) return json(res, 400, { error: 'invalid title' })
        if (!scanFrames(root).scenes.some((sc) => sc.name === scene)) return json(res, 400, { error: `scene "${scene}" does not exist (no frames under design/scenes/${scene}/)` })
        const e = setSceneTitle(root, scene, readTitle(title) ?? '')
        if (e) return json(res, 400, { error: e })
        return json(res, 200, { ok: true })
      }

      // Arrange the sidebar: the body is the WHOLE tree - boards as strings, folders as
      // `{ folder, items }` (a top-level folder's items may hold folders: its sub-folders) - plus `base`, the sha256 the client last saw for every board it
      // names and for the registry (null = no file). Every mutation (drag, new/rename/delete
      // folder, move) is this one write: each named board gets its sibling index as `order`
      // and its `folder` set or deleted (the folder it sits in directly, at either level); the
      // registry becomes exactly the folders in the tree, a sub-folder carrying its `parent`
      // (an absent one is gone) - version 2 only when one does, so a flat registry stays
      // readable by an older Marver. Boards the tree does not name are untouched.
      // PREFLIGHT before any write: every named board must exist as a regular, well-formed
      // file whose hash matches `base` - else 409 with the stale names (the client refetches
      // and replays its intent) and NOTHING is written. So a concurrent agent edit of a board's
      // `folder` or a second tab's drag is never silently overwritten. The per-file writes that
      // follow are each atomic; a crash between them leaves a valid (partly moved) tree, never a
      // corrupt file. Answers the new hash of every file written so the shell's autosave of the
      // active board keeps its CAS token current. Owner-gated.
      if (path === 'boards/reorder' && req.method === 'POST') {
        if (!ownerGated(req)) return json(res, 403, { error: 'forbidden' })
        const raw = await readBody(req)
        if (raw == null) return json(res, 400, { error: 'body too large or unreadable' })
        let parsed: unknown
        try { parsed = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
        if (!parsed || typeof parsed !== 'object') return json(res, 400, { error: 'expected an object' })
        const { tree, base } = parsed as { tree?: unknown; base?: unknown }
        const bad = validateWire(tree)
        if (bad) return json(res, 400, { error: bad })
        const b = base as { boards?: Record<string, unknown>; folders?: unknown } | null
        if (!b || typeof b !== 'object' || !b.boards || typeof b.boards !== 'object' || (b.folders !== null && typeof b.folders !== 'string')) return json(res, 400, { error: 'expected base hashes' })
        { const de = dirError(); if (de) return json(res, 400, { error: de }) }
        const reply = (status: number, body: unknown) => ({ status, body })
        // one writer at a time with `folders add` and `init --kind` (another process): never block the
        // event loop on it - a held lock is a 409 the shell already answers by reloading and replaying
        mkdirSync(boardsDir, { recursive: true })   // the lock lives beside the registry - the first folder creates both
        const locked = withRegistryLock(boardsDir, 0, () => {
          // preflight the registry, and the LIST: a board that appeared since the client looked is
          // stale too (a folder it names would outlive the client's "delete folder"; the replay
          // sees it and moves it with the rest)
          const reg = readRegistry(boardsDir)
          if (reg.state === 'malformed') return reply(422, { error: reg.error })
          // a shell that predates nesting reads a nested registry flat and would post it back flat,
          // with a current hash: refuse it, and say what to do (never a 409 - it would only replay)
          if (reg.state === 'ok' && reg.folders.some((f) => f.parent) && (parsed as { protocol?: unknown }).protocol !== TREE_PROTOCOL) {
            return reply(422, { error: 'this tab predates folders in folders - reload the canvas, then try again' })
          }
          if (reg.sha256 !== b.folders) return reply(409, { error: 'folders changed on disk', stale: [FOLDERS_FILE] })
          const unseen = listBoardFiles(boardsDir).boards.map((x) => x.name).filter((n) => !(n in b.boards!))
          if (unseen.length) return reply(409, { error: 'boards changed on disk', stale: unseen })
          // preflight every named board: present, regular, well-formed, unchanged since the client looked
          const plan: { name: string; path: string; obj: Record<string, unknown>; order: number; folder: string | null }[] = []
          const stale: string[] = []
          const consider = (name: string, order: number, folder: string | null): string | null => {
            const p = boardPath(name)
            if (!p || !isRegularFile(p)) { stale.push(name); return null }
            const content = readFileSync(p, 'utf8')
            if (b.boards![name] !== hash(content)) { stale.push(name); return null }
            let obj: unknown
            try { obj = JSON.parse(content) } catch { return `board "${name}" is not valid JSON - fix the file` }
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return `board "${name}" is not a JSON object - fix the file`
            plan.push({ name, path: p, obj: obj as Record<string, unknown>, order, folder })
            return null
          }
          // what the registry holds beyond what a tree write manages - a folder's type when the shell
          // that posted predates types (a 0.21 tab), and any field a newer Marver wrote - survives the
          // rewrite: a write never drops what it did not understand
          const onDisk = new Map<string, Record<string, unknown>>()
          try {
            const raw = JSON.parse(readFileSync(join(boardsDir, FOLDERS_FILE), 'utf8')) as { folders?: unknown }
            if (Array.isArray(raw.folders)) for (const r of raw.folders) if (r && typeof r === 'object' && typeof (r as { name?: unknown }).name === 'string') onDisk.set((r as { name: string }).name, r as Record<string, unknown>)
          } catch { /* absent - nothing to keep */ }
          const MANAGED = new Set(['name', 'order', 'parent', 'title', 'description', 'type'])
          const folders: Record<string, unknown>[] = []
          const walk = (list: WireItem[], parent: string | null): string | null => {
            for (const [i, it] of list.entries()) {
              if (typeof it === 'string') { const e = consider(it, i, parent); if (e) return e; continue }
              const title = readTitle(it.title), description = readDescription(it.description)
              const disk = onDisk.get(it.folder)
              const type = readType(it.type) ?? readType(disk?.type)
              const kept = disk ? Object.fromEntries(Object.entries(disk).filter(([k]) => !MANAGED.has(k))) : {}
              folders.push({ ...kept, name: it.folder, order: i, ...(parent ? { parent } : {}), ...(title ? { title } : {}), ...(description ? { description } : {}), ...(type ? { type } : {}) })
              const e = walk(wireKids(it) as WireItem[], it.folder)
              if (e) return e
            }
            return null
          }
          { const e = walk(tree as WireItem[], null); if (e) return reply(422, { error: e }) }
          if (stale.length) return reply(409, { error: 'boards changed on disk', stale })
          // write: only the files whose fields actually change (an untouched board keeps its hash)
          const sha256: Record<string, string> = {}
          for (const w of plan) {
            const same = w.obj.order === w.order && (w.folder ? w.obj.folder === w.folder : w.obj.folder === undefined)
            if (same) continue
            // re-checked at the moment of writing, not only at preflight: an author's save landing
            // while an earlier board in this batch was written is never overwritten
            if (hash(readFileSync(w.path, 'utf8')) !== b.boards![w.name]) return reply(409, { error: 'boards changed on disk', stale: [w.name] })
            w.obj.order = w.order
            if (w.folder) w.obj.folder = w.folder; else delete w.obj.folder
            const next = JSON.stringify(w.obj, null, 2) + '\n'
            atomicWrite(w.path, next)
            sha256[w.name] = hash(next)
          }
          mkdirSync(boardsDir, { recursive: true })
          // the registry too, at the moment of writing: an editor's save since the preflight wins
          const regNow = nodeAt(foldersPath) ? hash(readFileSync(foldersPath, 'utf8')) : null
          if (regNow !== b.folders) return reply(409, { error: 'folders changed on disk', stale: [FOLDERS_FILE] })
          let foldersSha: string | null = null
          if (folders.length) {
            const version = folders.some((f) => f.parent) ? REGISTRY_VERSION_NESTED : REGISTRY_VERSION_FLAT
            const next = JSON.stringify({ version, folders }, null, 2) + '\n'
            atomicWrite(foldersPath, next)
            foldersSha = hash(next)
          }
          else rmSync(foldersPath, { force: true })                 // no folders = no registry file

          return reply(200, { ok: true, sha256: { boards: sha256, folders: foldersSha } })
        })
        if (!locked) return json(res, 409, { error: 'folders changed on disk', stale: [FOLDERS_FILE] })
        return json(res, locked.status, locked.body)

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
          // Preserve author-owned fields the shell does not manage (AUTHOR_FIELDS): the board's
          // rank, its folder, title and description, and spec 20's type, capability, status and
          // reason live in the file but never ride the shell's save shape, so a routine autosave
          // would otherwise strip them. Carry each over from disk when the incoming board omits
          // it - and only a well-formed one (boardFields reads leniently).
          const incoming = body.board as Record<string, unknown> | null
          if (incoming && typeof incoming === 'object' && current) {
            try {
              const disk = JSON.parse(current) as Record<string, unknown>
              const valid = boardFields(disk, validName) as Record<string, unknown>
              for (const k of AUTHOR_FIELDS) if (incoming[k] === undefined && valid[k] !== undefined) incoming[k] = disk[k]
            } catch { /* malformed disk */ }
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
        // scale 1-4 (default 2); w/h = the canvas node's size when the shell asks for "what the
        // node shows" (planShot clamps); format=png streams the bytes back (the shell's copy-as-
        // image) with the JSON summary riding in x-mv-shot - the file still lands in .local/shots.
        const scale = url.searchParams.has('scale') ? Number(url.searchParams.get('scale')) : undefined
        const dim = (k: string) => { const v = Math.round(Number(url.searchParams.get(k))); return url.searchParams.has(k) && Number.isFinite(v) ? v : undefined }   // CDP wants integers
        const size = { w: dim('w'), h: dim('h') }
        const asPng = url.searchParams.get('format') === 'png'
        // Origin from the ACTUAL listening socket, never the client-controlled Host header - so a
        // spoofed Host can't point the headless render at another server. Falls back to Host only
        // if the socket address is unavailable (the request already passed the owner/token gate).
        const origin = opts.origin?.() ?? `http://${req.headers.host ?? 'localhost'}`
        const { shootFrame } = await import('./shot.ts')
        const r = await shootFrame({ root, viewports: opts.viewports ?? {}, frameId, theme, origin, scale, size })
        if (!r.ok) return json(res, r.error.startsWith('unknown frame') ? 404 : r.error.startsWith('invalid ') ? 400 : 503, { error: r.error })
        const summary = { path: r.path, frame: frameId, theme, width: r.width, height: r.height, scale: r.scale, ...(r.truncated ? { truncated: true } : {}), ...(r.unsettled ? { unsettled: true } : {}), ...(r.note ? { note: r.note } : {}) }
        if (!asPng) return json(res, 200, summary)
        const png = readFileSync(join(root, r.path))
        // base64url: a header must be ASCII, a frame id or note need not be
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'no-store', 'x-mv-shot': Buffer.from(JSON.stringify(summary)).toString('base64url') })
        return res.end(png)
      }

      // ---- shots: many frames as ONE operation - one browser, several frames at a time inside
      // it, one entry per frame in the order asked. The verify loop's "show me the scene". Same
      // gate as `shot`. 400 for a malformed ask, 404 for an empty scene, 503 when no browser could
      // start; once work has begun the answer is 200 and every entry speaks for itself.
      if (path === 'shots' && req.method === 'POST') {
        const { readDevInfo } = await import('./work.ts')
        const token = readDevInfo(root)?.token
        if (!ownerGated(req) && !(token && req.headers['x-mv-work'] === token)) return json(res, 403, { error: 'forbidden' })
        const raw = await readBody(req)
        if (raw == null) return json(res, 400, { error: 'body too large or unreadable' })
        let parsed: unknown
        try { parsed = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json(res, 400, { error: 'expected an object' })
        const body = parsed as Record<string, unknown>
        const theme = body.theme === undefined ? 'light' : body.theme
        if (typeof theme !== 'string' || !/^[a-z0-9-]+$/i.test(theme)) return json(res, 400, { error: 'invalid theme' })
        const scale = body.scale === undefined ? undefined : body.scale
        if (scale !== undefined && !(Number.isInteger(scale) && (scale as number) >= 1 && (scale as number) <= 4)) return json(res, 400, { error: 'invalid scale' })
        const { resolveFrames, shootBatch } = await import('./shot.ts')
        const sel = resolveFrames(root, body)
        if (!sel.ok) return json(res, sel.status, { error: sel.error })
        const origin = opts.origin?.() ?? `http://${req.headers.host ?? 'localhost'}`
        try {
          const results = await shootBatch({ root, viewports: opts.viewports ?? {}, frames: sel.frames, theme, origin, scale: scale as number | undefined })
          return json(res, 200, { results })
        } catch (err) {
          return json(res, 503, { error: (err as Error).message })
        }
      }

      // ---- bakes: compile frames so they can SLEEP on the canvas (spec 16) - the textures that replace
      // their backdrop-filters, computed and certified by headless Chrome at each node's own width/theme.
      // Many frames, one browser; the disk cache first. Owner-gated like shot (spawns a browser).
      if (path === 'bakes' && req.method === 'POST') {
        if (!ownerGated(req)) return json(res, 403, { error: 'forbidden' })
        const raw = await readBody(req)
        if (raw == null) return json(res, 400, { error: 'body too large or unreadable' })
        let body: { asks?: unknown } | null
        try { body = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
        if (!body || typeof body !== 'object' || !Array.isArray(body.asks) || !body.asks.length || body.asks.length > 200) return json(res, 400, { error: 'asks must list 1-200 frames' })
        const { bakeBatch, ASK_MAX } = await import('./bake.ts')
        let manifest: { frames?: { id: string; file: string; kind: string }[] } = {}
        try { manifest = JSON.parse(readFileSync(join(root, 'design', 'manifest.json'), 'utf8')) } catch { /* no manifest yet */ }
        const frames = new Map((manifest.frames ?? []).map((f) => [f.id, f]))
        const asks: { frame: string; theme: string; w: number; h: number }[] = []
        for (const a of body.asks as Record<string, unknown>[]) {
          const frame = typeof a?.frame === 'string' ? a.frame : ''
          const theme = typeof a?.theme === 'string' && /^[a-z0-9-]{1,32}$/i.test(a.theme) ? a.theme : ''
          const w = Math.round(Number(a?.w)), h = Math.round(Number(a?.h))
          if (!frames.has(frame) || !theme || !(w >= 120 && h >= 80 && w <= ASK_MAX.side && h <= ASK_MAX.side && w * h <= ASK_MAX.area)) return json(res, 400, { error: `invalid ask for "${frame}"` })
          asks.push({ frame, theme, w, h })
        }
        const origin = opts.origin?.() ?? `http://${req.headers.host ?? 'localhost'}`
        const { ROUTE } = await import('../cli/name.ts')
        const gen = opts.bakeGen?.() ?? 0
        const answers = await bakeBatch({
          root, gen, asks, live: () => opts.bakeGen?.() ?? 0,
          log: (a) => { if (a.ok) console.log(`  bake: ${a.frame} ${a.theme} ${a.w}x${a.h} - ${a.targets.length} effects, ${a.rejected} stay live, ${a.ms} ms`); else console.log(`  bake: ${a.frame} ${a.theme} ${a.w}x${a.h} - stays live: ${a.error}`) },
          urlFor: (ask) => { const f = frames.get(ask.frame)!; return f.kind === 'html' ? `${origin}/${f.file}?theme=${encodeURIComponent(ask.theme)}` : `${origin}${ROUTE}/frame/?id=${encodeURIComponent(ask.frame)}&theme=${encodeURIComponent(ask.theme)}` },
          urlBase: `${ROUTE}/bakes`,
        })
        return json(res, 200, { gen, answers })
      }

      // ---- poster: render `<clip>.poster.png` for a local video that has none (the Video
      // primitive asks when its conventional poster 404s). Owner-gated like shot: it spawns a
      // browser and writes into design/assets/. Idempotent - an existing file is never redone.
      if (path === 'poster' && req.method === 'GET') {
        if (!ownerGated(req)) return json(res, 403, { error: 'forbidden' })
        const src = url.searchParams.get('src') ?? ''
        const { ensurePoster, isLocalClip } = await import('./poster.ts')
        const { isLocalAssetRef } = await import('./build.ts')
        if (!isLocalAssetRef(src) || !isLocalClip(src)) return json(res, 400, { error: 'src must be a clip under design/assets/' })
        const r = await ensurePoster(join(root, 'design', 'assets'), src)
        if (!r.ok) return json(res, r.error.includes('does not exist') ? 404 : 503, { error: r.error })
        return json(res, 200, { path: `design/assets/${src}.poster.png`, generated: r.generated })
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
