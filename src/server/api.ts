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
  const localDir = join(root, 'design', '.local')

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
          if (!existsSync(p)) return json(res, 404, { error: 'not found' })
          const content = readFileSync(p, 'utf8')
          return json(res, 200, { board: JSON.parse(content), sha256: hash(content) })
        }
        if (req.method === 'PUT') {
          const raw = await readBody(req)
          if (raw == null) return json(res, 400, { error: 'body too large or unreadable' })
          let body: { board: unknown; baseHash?: string }
          try { body = JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
          const current = existsSync(p) ? readFileSync(p, 'utf8') : ''
          if (current && body.baseHash !== hash(current)) {
            return json(res, 409, { error: 'board changed on disk', board: JSON.parse(current), sha256: hash(current) })
          }
          mkdirSync(boardsDir, { recursive: true })
          const next2 = JSON.stringify(body.board, null, 2) + '\n'
          atomicWrite(p, next2)
          return json(res, 200, { sha256: hash(next2) })
        }
      }

      if (path === 'local') {
        const p = join(localDir, 'view.json')
        if (req.method === 'GET') {
          return json(res, 200, existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {})
        }
        if (req.method === 'PUT') {
          const raw = await readBody(req)
          if (raw == null) return json(res, 400, { error: 'body too large' })
          try { JSON.parse(raw) } catch { return json(res, 400, { error: 'malformed JSON' }) }
          mkdirSync(localDir, { recursive: true })
          atomicWrite(p, raw)
          return json(res, 200, { ok: true })
        }
      }

      json(res, 404, { error: 'unknown endpoint' })
    } catch (err) {
      json(res, 500, { error: (err as Error).message })
    }
  }
}
