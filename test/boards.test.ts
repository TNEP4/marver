import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiMiddleware } from '../src/server/api.ts'
import { ROUTE } from '../src/cli/name.ts'

// A minimal Connect req/res harness: drives apiMiddleware directly so the new
// boards/rename + boards/reorder routes are tested end to end (gate, validation,
// atomic move, comment guard) without standing up a real HTTP server.
function drive(root: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const mw = apiMiddleware(root)
  const req: any = {
    method,
    url: `${ROUTE}/api/${path}`,
    headers: { host: 'localhost:5200', ...headers },
    _cbs: {} as Record<string, (arg?: unknown) => void>,
    on(ev: string, cb: (arg?: unknown) => void) { this._cbs[ev] = cb; return this },
    destroy() { /* body limit path - unused here */ },
  }
  const res: any = { statusCode: 0, headers: {} as Record<string, string>, body: '', setHeader(k: string, v: string) { this.headers[k] = v }, end(s?: string) { this.body = s ?? ''; this._done?.() } }
  const done = new Promise<{ status: number; json: any }>((resolve) => {
    res._done = () => resolve({ status: res.statusCode, json: safeParse(res.body) })
    void mw(req, res, () => { res.statusCode = 404; resolve({ status: 404, json: null }) })
  })
  // feed the POST body through the mocked stream after the handler subscribed
  if (method === 'POST') {
    // preserve a literal `null` body (JSON.stringify(null) === "null") - only a MISSING body defaults to {}
    const raw = Buffer.from(JSON.stringify(body === undefined ? {} : body))
    queueMicrotask(() => { req._cbs.data?.(raw); req._cbs.end?.() })
  }
  return done
}
const safeParse = (s: string) => { try { return JSON.parse(s) } catch { return null } }

// the owner cookie both routes require (double-submit: cookie value echoed in x-mv-c)
const OWNER = { cookie: 'mv_c=tok', 'x-mv-c': 'tok', origin: 'http://localhost:5200' }

describe('boards/rename + boards/reorder routes', () => {
  let root = ''
  const boardsDir = () => join(root, 'design', 'boards')
  const writeBoard = (name: string, obj: unknown = { version: 1, nodes: [] }) => writeFileSync(join(boardsDir(), `${name}.json`), JSON.stringify(obj))

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mv-boards-'))
    mkdirSync(boardsDir(), { recursive: true })
  })
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  it('rename without the owner cookie → 403, file untouched', async () => {
    writeBoard('alpha')
    const r = await drive(root, 'POST', 'boards/rename', { from: 'alpha', to: 'beta' })
    expect(r.status).toBe(403)
    expect(existsSync(join(boardsDir(), 'alpha.json'))).toBe(true)
  })

  it('rename → 200 moves the file atomically', async () => {
    writeBoard('alpha', { version: 1, order: 3, nodes: [] })
    const r = await drive(root, 'POST', 'boards/rename', { from: 'alpha', to: 'beta' }, OWNER)
    expect(r.status).toBe(200)
    expect(existsSync(join(boardsDir(), 'alpha.json'))).toBe(false)
    expect(existsSync(join(boardsDir(), 'beta.json'))).toBe(true)
    // content preserved byte-for-byte (order field survives)
    expect(JSON.parse(readFileSync(join(boardsDir(), 'beta.json'), 'utf8')).order).toBe(3)
  })

  it('rename onto an existing board → 409, neither file lost', async () => {
    writeBoard('alpha'); writeBoard('beta')
    const r = await drive(root, 'POST', 'boards/rename', { from: 'alpha', to: 'beta' }, OWNER)
    expect(r.status).toBe(409)
    expect(existsSync(join(boardsDir(), 'alpha.json'))).toBe(true)
    expect(existsSync(join(boardsDir(), 'beta.json'))).toBe(true)
  })

  it('rename a board that has a comment log → 409, file untouched', async () => {
    writeBoard('alpha')
    mkdirSync(join(root, 'design', 'comments'), { recursive: true })
    writeFileSync(join(root, 'design', 'comments', 'alpha.jsonl'), '{"id":"1","type":"create","board":"alpha"}\n')
    const r = await drive(root, 'POST', 'boards/rename', { from: 'alpha', to: 'beta' }, OWNER)
    expect(r.status).toBe(409)
    expect(existsSync(join(boardsDir(), 'alpha.json'))).toBe(true)
    expect(existsSync(join(boardsDir(), 'beta.json'))).toBe(false)
  })

  it('rename rejects reserved / invalid / non-string / over-long names → 400', async () => {
    writeBoard('alpha')
    for (const b of [
      { from: 'alpha', to: 'all-scenes' },
      { from: 'all-scenes', to: 'x' },
      { from: 'alpha', to: 'Bad Name' },
      { from: 'alpha', to: 42 },
      { from: 'alpha', to: 'a'.repeat(65) },
      { from: 'alpha', to: 'alpha' },
    ]) {
      const r = await drive(root, 'POST', 'boards/rename', b, OWNER)
      expect(r.status, JSON.stringify(b)).toBe(400)
    }
    expect(existsSync(join(boardsDir(), 'alpha.json'))).toBe(true)
  })

  it('rename a missing board → 404', async () => {
    const r = await drive(root, 'POST', 'boards/rename', { from: 'ghost', to: 'beta' }, OWNER)
    expect(r.status).toBe(404)
  })

  it('reorder writes each board its index as `order`', async () => {
    writeBoard('one'); writeBoard('two'); writeBoard('three')
    const r = await drive(root, 'POST', 'boards/reorder', { order: ['three', 'one', 'two'] }, OWNER)
    expect(r.status).toBe(200)
    const orderOf = (n: string) => JSON.parse(readFileSync(join(boardsDir(), `${n}.json`), 'utf8')).order
    expect(orderOf('three')).toBe(0)
    expect(orderOf('one')).toBe(1)
    expect(orderOf('two')).toBe(2)
  })

  it('reorder rejects all-scenes, duplicates, and non-arrays → 400', async () => {
    writeBoard('one')
    for (const order of [['all-scenes', 'one'], ['one', 'one'], 'nope' as unknown as string[]]) {
      const r = await drive(root, 'POST', 'boards/reorder', { order }, OWNER)
      expect(r.status, JSON.stringify(order)).toBe(400)
    }
  })

  it('a JSON null / non-object body → 400, never 500', async () => {
    writeBoard('alpha')
    // body is literally `null` (valid JSON, not an object)
    const mw = drive
    for (const [path, body] of [['boards/rename', null], ['boards/reorder', null]] as const) {
      const r = await mw(root, 'POST', path, body, OWNER)
      expect(r.status, path).toBe(400)
    }
  })

  it('rename onto a DANGLING destination symlink → 409 (no-clobber holds)', async () => {
    const { symlinkSync } = await import('node:fs')
    writeBoard('alpha')
    symlinkSync(join(root, 'nowhere.json'), join(boardsDir(), 'beta.json'))   // dangling: target does not exist
    const r = await drive(root, 'POST', 'boards/rename', { from: 'alpha', to: 'beta' }, OWNER)
    expect(r.status).toBe(409)
    expect(existsSync(join(boardsDir(), 'alpha.json'))).toBe(true)
  })

  it('reorder without the owner cookie → 403', async () => {
    writeBoard('one')
    const r = await drive(root, 'POST', 'boards/reorder', { order: ['one'] })
    expect(r.status).toBe(403)
  })

  it("reorder skips a name with no file, still 200", async () => {
    writeBoard('one')
    const r = await drive(root, 'POST', 'boards/reorder', { order: ['one', 'missing'] }, OWNER)
    expect(r.status).toBe(200)
    expect(JSON.parse(readFileSync(join(boardsDir(), 'one.json'), 'utf8')).order).toBe(0)
  })
})
