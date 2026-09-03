import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiMiddleware } from '../src/server/api.ts'
import { ROUTE } from '../src/cli/name.ts'
import { hash } from '../src/server/manifest.ts'

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

  it('rename with a title: title only (file stays, hash answered, CAS on baseHash), title + move, a refused move writes nothing', async () => {
    writeBoard('mvp', { version: 1, order: 1, nodes: [] })
    const sha = () => hash(readFileSync(join(boardsDir(), 'mvp.json'), 'utf8'))
    // a stale baseHash: 409 with the hash now on disk, nothing written
    let r = await drive(root, 'POST', 'boards/rename', { from: 'mvp', title: 'MVP', baseHash: 'stale' }, OWNER)
    expect(r.status).toBe(409)
    expect(r.json.sha256).toBe(sha())
    expect(JSON.parse(readFileSync(join(boardsDir(), 'mvp.json'), 'utf8')).title).toBeUndefined()
    // title only: `to` omitted, the hash the caller saw
    r = await drive(root, 'POST', 'boards/rename', { from: 'mvp', title: '  MVP  ', baseHash: sha() }, OWNER)
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ name: 'mvp', sha256: sha() })
    expect(JSON.parse(readFileSync(join(boardsDir(), 'mvp.json'), 'utf8'))).toEqual({ version: 1, order: 1, nodes: [], title: 'MVP' })
    // title + move (an agent's path): the file moves first, the title lands in it
    r = await drive(root, 'POST', 'boards/rename', { from: 'mvp', to: 'mvp-launch', title: 'MVP launch 🚀' }, OWNER)
    expect(r.status).toBe(200)
    expect(r.json.name).toBe('mvp-launch')
    expect(existsSync(join(boardsDir(), 'mvp.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(boardsDir(), 'mvp-launch.json'), 'utf8'))).toMatchObject({ title: 'MVP launch 🚀', order: 1 })
    // an empty title clears it; `to === from` with no title is not a rename; a move alone answers no hash (bytes unchanged)
    r = await drive(root, 'POST', 'boards/rename', { from: 'mvp-launch', to: 'mvp-launch', title: '' }, OWNER)
    expect(r.status).toBe(200)
    expect(JSON.parse(readFileSync(join(boardsDir(), 'mvp-launch.json'), 'utf8')).title).toBeUndefined()
    expect((await drive(root, 'POST', 'boards/rename', { from: 'mvp-launch', to: 'mvp-launch' }, OWNER)).status).toBe(400)
    expect((await drive(root, 'POST', 'boards/rename', { from: 'mvp-launch', title: 'x'.repeat(121) }, OWNER)).status).toBe(400)
    expect((await drive(root, 'POST', 'boards/rename', { from: 'mvp-launch', title: 'x', baseHash: 5 }, OWNER)).status).toBe(400)
    r = await drive(root, 'POST', 'boards/rename', { from: 'mvp-launch', to: 'launch' }, OWNER)
    expect(r.status).toBe(200); expect(r.json).toEqual({ name: 'launch' })
    // a refused move (comment threads) with a title: 409, and the title is NOT written either - nothing changes
    mkdirSync(join(root, 'design', 'comments'), { recursive: true })
    writeFileSync(join(root, 'design', 'comments', 'launch.jsonl'), '{}\n')
    r = await drive(root, 'POST', 'boards/rename', { from: 'launch', to: 'go', title: 'Go' }, OWNER)
    expect(r.status).toBe(409)
    expect(r.json.error).toMatch(/threads/)
    expect(existsSync(join(boardsDir(), 'go.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(boardsDir(), 'launch.json'), 'utf8')).title).toBeUndefined()
    // a malformed file is never rewritten from a guess
    writeFileSync(join(boardsDir(), 'bad.json'), '{ nope')
    expect((await drive(root, 'POST', 'boards/rename', { from: 'bad', title: 'Bad' }, OWNER)).status).toBe(422)
    expect(readFileSync(join(boardsDir(), 'bad.json'), 'utf8')).toBe('{ nope')
  })

  it('scenes/rename writes the title into the brief’s front matter and nothing else', async () => {
    const scene = join(root, 'design', 'scenes', 'checkout')
    mkdirSync(scene, { recursive: true })
    writeFileSync(join(scene, 'cart.tsx'), 'export default () => null\n')   // a scene is a directory WITH frames
    const brief = join(scene, '_brief.md')
    // no brief: a front-matter-only brief appears
    let r = await drive(root, 'POST', 'scenes/rename', { scene: 'checkout', title: 'Checkout (v2)' }, OWNER)
    expect(r.status).toBe(200)
    expect(readFileSync(brief, 'utf8')).toBe('---\ntitle: "Checkout (v2)"\n---\n')
    // clearing it removes the file we made
    expect((await drive(root, 'POST', 'scenes/rename', { scene: 'checkout', title: '' }, OWNER)).status).toBe(200)
    expect(existsSync(brief)).toBe(false)
    // a brief with a body: the block goes on top, the body is byte-identical
    const body = '# Checkout - the buyer\'s path\n\nAudience: everyone\n'
    writeFileSync(brief, body)
    await drive(root, 'POST', 'scenes/rename', { scene: 'checkout', title: 'Checkout 🛒' }, OWNER)
    expect(readFileSync(brief, 'utf8')).toBe('---\ntitle: "Checkout 🛒"\n---\n\n' + body)
    // an existing block: only the title line changes, other fields stay, retitling replaces
    writeFileSync(brief, '---\nstatus: draft\ntitle: Old\n---\n' + body)
    await drive(root, 'POST', 'scenes/rename', { scene: 'checkout', title: 'New "quoted"' }, OWNER)
    expect(readFileSync(brief, 'utf8')).toBe('---\ntitle: "New \\"quoted\\""\nstatus: draft\n---\n' + body)
    // clearing with other fields present keeps the block; clearing the only field drops the block
    await drive(root, 'POST', 'scenes/rename', { scene: 'checkout', title: '' }, OWNER)
    expect(readFileSync(brief, 'utf8')).toBe('---\nstatus: draft\n---\n' + body)
    writeFileSync(brief, '---\ntitle: Old\n---\n' + body)
    await drive(root, 'POST', 'scenes/rename', { scene: 'checkout', title: '' }, OWNER)
    expect(readFileSync(brief, 'utf8')).toBe(body)
    // CRLF briefs keep their line endings
    writeFileSync(brief, '# Title\r\n\r\nBody\r\n')
    await drive(root, 'POST', 'scenes/rename', { scene: 'checkout', title: 'T' }, OWNER)
    expect(readFileSync(brief, 'utf8')).toBe('---\r\ntitle: "T"\r\n---\r\n\r\n# Title\r\n\r\nBody\r\n')
    // an unclosed front matter block is refused untouched - the brief is the agent's document
    writeFileSync(brief, '---\ntitle: Old\nbody without a closing delimiter\n')
    r = await drive(root, 'POST', 'scenes/rename', { scene: 'checkout', title: 'T' }, OWNER)
    expect(r.status).toBe(400); expect(r.json.error).toMatch(/never closes/)
    expect(readFileSync(brief, 'utf8')).toBe('---\ntitle: Old\nbody without a closing delimiter\n')
    // a symlinked brief is refused; a directory without frames is not a scene
    rmSync(brief); symlinkSync(join(root, 'elsewhere.md'), brief)
    expect((await drive(root, 'POST', 'scenes/rename', { scene: 'checkout', title: 'T' }, OWNER)).status).toBe(400)
    rmSync(brief)
    mkdirSync(join(root, 'design', 'scenes', 'empty'))
    expect((await drive(root, 'POST', 'scenes/rename', { scene: 'empty', title: 'x' }, OWNER)).status).toBe(400)
    // gate + validation
    expect((await drive(root, 'POST', 'scenes/rename', { scene: 'checkout', title: 'x' })).status).toBe(403)
    expect((await drive(root, 'POST', 'scenes/rename', { scene: '../etc', title: 'x' }, OWNER)).status).toBe(400)
    expect((await drive(root, 'POST', 'scenes/rename', { scene: 'ghost', title: 'x' }, OWNER)).status).toBe(400)
    expect((await drive(root, 'POST', 'scenes/rename', { scene: 'checkout', title: 5 }, OWNER)).status).toBe(400)
  })

  it('rename a missing board → 404', async () => {
    const r = await drive(root, 'POST', 'boards/rename', { from: 'ghost', to: 'beta' }, OWNER)
    expect(r.status).toBe(404)
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

})

// ---- folders: the tree write (order + membership + registry in one CAS-guarded call) ----
describe('boards/reorder as a tree + GET boards/folders', () => {
  let root = ''
  const boardsDir = () => join(root, 'design', 'boards')
  const file = (n: string) => join(boardsDir(), `${n}.json`)
  const read = (n: string) => JSON.parse(readFileSync(file(n), 'utf8'))
  const writeBoard = (name: string, obj: unknown = { version: 1, nodes: [] }) => writeFileSync(file(name), JSON.stringify(obj))
  const REG = '_folders'
  /** The hashes a client would have seen: every board file + the registry (null = absent). */
  const base = (...names: string[]) => ({
    boards: Object.fromEntries(names.map((n) => [n, hash(readFileSync(file(n), 'utf8'))])),
    folders: existsSync(file(REG)) ? hash(readFileSync(file(REG), 'utf8')) : null,
  })
  const post = (tree: unknown, b: unknown) => drive(root, 'POST', 'boards/reorder', { tree, base: b }, OWNER)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mv-folders-'))
    mkdirSync(boardsDir(), { recursive: true })
  })
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  it('writes order + folder per board and the registry; root boards lose `folder`', async () => {
    writeBoard('one', { version: 1, nodes: [], folder: 'old' }); writeBoard('two'); writeBoard('three')
    const r = await post(['three', { folder: 'research', boards: ['one', 'two'] }], base('one', 'two', 'three'))
    expect(r.status).toBe(200)
    expect(read('three')).toMatchObject({ order: 0 }); expect(read('three').folder).toBeUndefined()
    expect(read('one')).toMatchObject({ order: 0, folder: 'research' })
    expect(read('two')).toMatchObject({ order: 1, folder: 'research' })
    expect(read(REG)).toEqual({ version: 1, folders: [{ name: 'research', order: 1 }] })
    // the answer carries the new hash of every file written, so a client can keep its CAS tokens true
    expect(r.json.sha256.boards.one).toBe(hash(readFileSync(file('one'), 'utf8')))
    expect(r.json.sha256.folders).toBe(hash(readFileSync(file(REG), 'utf8')))
  })

  it('GET boards exposes `folder` and never lists the registry; GET folders reads it with its hash', async () => {
    writeBoard('one', { version: 1, nodes: [], order: 3, folder: 'research' }); writeBoard('two', { version: 1, nodes: [], folder: 'Bad Name' })
    writeFileSync(file(REG), JSON.stringify({ version: 1, folders: [{ name: 'research', order: 0 }] }))
    const b = await drive(root, 'GET', 'boards')
    expect(b.json.map((x: any) => x.name).sort()).toEqual(['one', 'two'])
    expect(b.json.find((x: any) => x.name === 'one')).toMatchObject({ order: 3, folder: 'research' })
    expect(b.json.find((x: any) => x.name === 'two').folder).toBeUndefined()   // off-grammar = top level
    const f = await drive(root, 'GET', 'folders')
    expect(f.status).toBe(200)
    expect(f.json).toEqual({ folders: [{ name: 'research', order: 0 }], sha256: hash(readFileSync(file(REG), 'utf8')) })
  })

  it('GET folders: absent → empty + null hash; malformed → 422 with the file named', async () => {
    let f = await drive(root, 'GET', 'folders')
    expect(f.json).toEqual({ folders: [], sha256: null })
    writeFileSync(file(REG), '{ nope')
    f = await drive(root, 'GET', 'folders')
    expect(f.status).toBe(422); expect(f.json.error).toMatch(/_folders\.json/)
    writeFileSync(file(REG), JSON.stringify({ version: 2, folders: [] }))
    expect((await drive(root, 'GET', 'folders')).status).toBe(422)
  })

  it('stale base → 409 naming the boards, and NOTHING is written (preflight before any write)', async () => {
    writeBoard('one'); writeBoard('two')
    const b = base('one', 'two')
    writeBoard('two', { version: 1, nodes: [], folder: 'agent-put-me-here' })   // an agent wrote after the client looked
    const before = readFileSync(file('one'), 'utf8')
    const r = await post(['two', { folder: 'x', boards: ['one'] }], b)
    expect(r.status).toBe(409)
    expect(r.json.stale).toEqual(['two'])
    expect(readFileSync(file('one'), 'utf8')).toBe(before)      // `one` would have moved - it did not
    expect(existsSync(file(REG))).toBe(false)                    // no registry appeared
    expect(read('two').folder).toBe('agent-put-me-here')         // the agent's edit survived
  })

  it('a changed registry → 409; a missing board → 409; a malformed named board → 422', async () => {
    writeBoard('one')
    const b = base('one')
    writeFileSync(file(REG), JSON.stringify({ version: 1, folders: [{ name: 'k', order: 0 }] }))
    expect((await post(['one'], b)).status).toBe(409)
    expect((await post(['one', 'ghost'], { ...base('one'), boards: { ...base('one').boards, ghost: 'x' } })).status).toBe(409)
    writeBoard('broken'); writeFileSync(file('broken'), '{')
    const b2 = { boards: { one: base('one').boards.one, broken: hash('{') }, folders: base().folders }
    expect((await post(['one', 'broken'], b2)).status).toBe(422)
  })

  it('without the owner cookie → 403, nothing written', async () => {
    writeBoard('one')
    const r = await drive(root, 'POST', 'boards/reorder', { tree: [{ folder: 'f', boards: ['one'] }], base: base('one') })
    expect(r.status).toBe(403)
    expect(read('one').folder).toBeUndefined()
    expect(existsSync(file(REG))).toBe(false)
  })

  it('a board the tree does not name is untouched; a folder the tree drops leaves the registry', async () => {
    writeBoard('one', { version: 1, nodes: [], order: 7, folder: 'keep' }); writeBoard('two')
    writeFileSync(file(REG), JSON.stringify({ version: 1, folders: [{ name: 'gone', order: 0 }, { name: 'keep', order: 1 }] }))
    const r = await post([{ folder: 'keep', boards: ['two'] }], base('one', 'two'))   // seen both, names only `two`
    expect(r.status).toBe(200)
    expect(read('one')).toMatchObject({ order: 7, folder: 'keep' })
    expect(read(REG).folders).toEqual([{ name: 'keep', order: 0 }])
  })

  it('no folders left = the registry file is removed', async () => {
    writeBoard('one', { version: 1, nodes: [], folder: 'f' })
    writeFileSync(file(REG), JSON.stringify({ version: 1, folders: [{ name: 'f', order: 0 }] }))
    const r = await post(['one'], base('one'))
    expect(r.status).toBe(200)
    expect(existsSync(file(REG))).toBe(false)
    expect(read('one').folder).toBeUndefined()
  })

  it('rejects: the legacy {order} body, all-scenes anywhere, a board twice, a nested folder, bad names, missing base → 400', async () => {
    writeBoard('one')
    const cases: [string, unknown][] = [
      ['legacy body', { order: ['one'] }],
      ['all-scenes at root', { tree: ['all-scenes'], base: base('one') }],
      ['all-scenes in a folder', { tree: [{ folder: 'f', boards: ['all-scenes'] }], base: base('one') }],
      ['board twice', { tree: ['one', { folder: 'f', boards: ['one'] }], base: base('one') }],
      ['folder twice', { tree: [{ folder: 'f', boards: [] }, { folder: 'f', boards: [] }], base: base('one') }],
      ['nested', { tree: [{ folder: 'f', boards: [{ folder: 'g', boards: [] }] }], base: base('one') }],
      ['bad folder name', { tree: [{ folder: 'Bad Name', boards: ['one'] }], base: base('one') }],
      ['bad board name', { tree: ['../x'], base: base('one') }],
      ['no base', { tree: ['one'] }],
      ['base folders not a hash', { tree: ['one'], base: { boards: {}, folders: 5 } }],
    ]
    for (const [label, body] of cases) {
      const r = await drive(root, 'POST', 'boards/reorder', body, OWNER)
      expect(r.status, label).toBe(400)
    }
  })

  it('an unchanged board keeps its bytes (and hash); only files whose fields move are rewritten', async () => {
    writeBoard('one', { version: 1, nodes: [], order: 0 }); writeBoard('two', { version: 1, nodes: [], order: 1 })
    const before = readFileSync(file('one'), 'utf8')
    const r = await post(['one', 'two'], base('one', 'two'))
    expect(r.status).toBe(200)
    expect(readFileSync(file('one'), 'utf8')).toBe(before)
    expect(r.json.sha256.boards).toEqual({})
  })

  it('symlinks: a symlinked board is not listed and cannot be named; a symlinked registry is refused', async () => {
    writeFileSync(join(root, 'outside.json'), JSON.stringify({ version: 1, nodes: [], order: 0 }))
    symlinkSync(join(root, 'outside.json'), file('link'))
    writeBoard('one')
    const b = await drive(root, 'GET', 'boards')
    expect(b.json.map((x: any) => x.name)).toEqual(['one'])
    const r = await post(['link', 'one'], { boards: { link: hash(readFileSync(join(root, 'outside.json'), 'utf8')), ...base('one').boards }, folders: null })
    expect(r.status).toBe(409)                                   // named but not a regular file = stale, nothing written
    expect(JSON.parse(readFileSync(join(root, 'outside.json'), 'utf8')).order).toBe(0)
    symlinkSync(join(root, 'nowhere.json'), file(REG))            // dangling registry symlink
    const f = await drive(root, 'GET', 'folders')
    expect(f.status).toBe(422)
    const r2 = await post(['one'], { ...base('one'), folders: null })
    expect(r2.status).toBe(422)
  })

  it('a symlinked design/boards DIRECTORY is refused everywhere: list 422, folders 422, write 400, build throws', async () => {
    const real = join(root, 'elsewhere')
    mkdirSync(real)
    writeFileSync(join(real, 'one.json'), JSON.stringify({ version: 1, nodes: [] }))
    rmSync(boardsDir(), { recursive: true, force: true })
    symlinkSync(real, boardsDir())                                 // inside the root, still refused: a link to the root would list package.json as a board
    expect((await drive(root, 'GET', 'boards')).status).toBe(422)
    expect((await drive(root, 'GET', 'folders')).status).toBe(422)
    const r = await drive(root, 'POST', 'boards/reorder', { tree: ['one'], base: { boards: { one: hash(readFileSync(join(real, 'one.json'), 'utf8')) }, folders: null } }, OWNER)
    expect(r.status).toBe(400)
    expect(JSON.parse(readFileSync(join(real, 'one.json'), 'utf8')).order).toBeUndefined()
    const { readBoards } = await import('../src/server/build.ts')
    expect(() => readBoards(root)).toThrow(/symlink/)
    // the per-board routes too: nothing reads or writes through the link
    expect((await drive(root, 'GET', 'boards/one')).status).toBe(400)
    expect((await drive(root, 'POST', 'boards/rename', { from: 'one', to: 'two' }, OWNER)).status).toBe(400)
    expect(existsSync(join(real, 'one.json'))).toBe(true); expect(existsSync(join(real, 'two.json'))).toBe(false)
  })

  it('a symlinked design/ with no boards dir yet is refused before any mkdir could follow it', async () => {
    const outside = join(root, '..', `mv-outside-${Date.now()}`)
    mkdirSync(outside)
    try {
      rmSync(join(root, 'design'), { recursive: true, force: true })
      symlinkSync(outside, join(root, 'design'))
      expect((await drive(root, 'GET', 'boards')).status).toBe(422)
      expect((await drive(root, 'GET', 'boards/one')).status).toBe(400)
      expect(existsSync(join(outside, 'boards'))).toBe(false)
    } finally { rmSync(outside, { recursive: true, force: true }) }
  })

  it('a board that appeared since the client looked makes the write stale (409) - a deleted folder cannot outlive the delete', async () => {
    writeBoard('one', { version: 1, nodes: [], folder: 'f' })
    writeFileSync(file(REG), JSON.stringify({ version: 1, folders: [{ name: 'f', order: 0 }] }))
    const b = base('one')
    writeBoard('late', { version: 1, nodes: [], folder: 'f' })       // the agent adds a board into the folder
    const r = await post(['one'], b)                                  // the human deletes the folder (stale tree)
    expect(r.status).toBe(409)
    expect(r.json.stale).toEqual(['late'])
    expect(read('one').folder).toBe('f')
  })

  it('a board name over 64 chars is refused on every path (it could never be listed)', async () => {
    const long = 'a'.repeat(65)
    expect((await drive(root, 'GET', `boards/${long}`)).status).toBe(400)
    const r = await drive(root, 'POST', 'boards/rename', { from: 'x', to: long }, OWNER)
    expect(r.status).toBe(400)
  })

  it('a folder description rides the tree write (and a rename keeps it); a stray one is validated', async () => {
    writeBoard('one')
    writeFileSync(file(REG), JSON.stringify({ version: 1, folders: [{ name: 'research', order: 0, description: 'The thinking' }] }))
    const f = await drive(root, 'GET', 'folders')
    expect(f.json.folders).toEqual([{ name: 'research', order: 0, description: 'The thinking' }])
    // the shell posts what it read - renamed, description along
    let r = await post([{ folder: 'thinking', boards: ['one'], description: 'The thinking' }], base('one'))
    expect(r.status).toBe(200)
    expect(read(REG).folders).toEqual([{ name: 'thinking', order: 0, description: 'The thinking' }])
    expect((await post([{ folder: 'x', boards: [], description: 'y'.repeat(301) }], base('one'))).status).toBe(400)
    expect((await post([{ folder: 'x', boards: [], description: 5 }], base('one'))).status).toBe(400)
    r = await post([{ folder: 'x', boards: ['one'], description: '   ' }], base('one'))   // blank = none
    expect(r.status).toBe(200)
    expect(read(REG).folders).toEqual([{ name: 'x', order: 0 }])
  })

  it('a folder title rides the tree write into the registry, cleaned; GET folders and the tree read it back', async () => {
    writeBoard('one')
    let r = await post([{ folder: 'ui', boards: ['one'], title: '  UI 🚀 ' }], base('one'))
    expect(r.status).toBe(200)
    expect(read(REG).folders).toEqual([{ name: 'ui', order: 0, title: 'UI 🚀' }])
    expect((await drive(root, 'GET', 'folders')).json.folders).toEqual([{ name: 'ui', order: 0, title: 'UI 🚀' }])
    expect((await post([{ folder: 'ui', boards: ['one'], title: 'x'.repeat(121) }], base('one'))).status).toBe(400)
    r = await post([{ folder: 'ui', boards: ['one'], title: '' }], base('one'))   // empty = none
    expect(r.status).toBe(200)
    expect(read(REG).folders).toEqual([{ name: 'ui', order: 0 }])
  })

  it('a board title is the board’s own: a tree write never touches it, GET boards exposes it', async () => {
    writeBoard('one', { version: 1, nodes: [], title: 'MVP' })
    const r = await post([{ folder: 'f', boards: ['one'] }], base('one'))
    expect(r.status).toBe(200)
    expect(read('one')).toMatchObject({ folder: 'f', order: 0, title: 'MVP' })
    expect((await drive(root, 'GET', 'boards')).json[0]).toMatchObject({ name: 'one', title: 'MVP' })
  })

  it('a board description survives a tree write (untouched field) and GET boards exposes it', async () => {
    writeBoard('one', { version: 1, nodes: [], description: 'The primary flow' })
    const r = await post([{ folder: 'f', boards: ['one'] }], base('one'))
    expect(r.status).toBe(200)
    expect(read('one')).toMatchObject({ folder: 'f', order: 0, description: 'The primary flow' })
    expect((await drive(root, 'GET', 'boards')).json[0]).toMatchObject({ name: 'one', description: 'The primary flow' })
  })

  it('the autosave PUT carries `folder` (and `order`) over from disk when the shell omits them', async () => {
    writeBoard('one', { version: 1, nodes: [], order: 2, folder: 'research', title: 'One!', description: 'kept too' })
    const sha = hash(readFileSync(file('one'), 'utf8'))
    const put = await new Promise<{ status: number; json: any }>((resolve) => {
      const mw = apiMiddleware(root)
      const req: any = { method: 'PUT', url: `${ROUTE}/api/boards/one`, headers: { host: 'localhost:5200' }, _cbs: {}, on(ev: string, cb: any) { this._cbs[ev] = cb; return this }, destroy() {} }
      const res: any = { statusCode: 0, headers: {}, body: '', setHeader() {}, end(s?: string) { this.body = s ?? ''; resolve({ status: this.statusCode, json: JSON.parse(this.body) }) } }
      void mw(req, res, () => resolve({ status: 404, json: null }))
      const raw = Buffer.from(JSON.stringify({ board: { version: 1, name: 'one', nodes: [] }, baseHash: sha, mustExist: true }))
      queueMicrotask(() => { req._cbs.data?.(raw); req._cbs.end?.() })
    })
    expect(put.status).toBe(200)
    expect(read('one')).toMatchObject({ order: 2, folder: 'research', title: 'One!', description: 'kept too' })
  })
})

describe('marver boards - the tree as the files say it is', () => {
  it('prints folders (implied or registered, empty ones too), boards with their order, the landing board; --json gives the tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-boards-cli-'))
    const dir = join(root, 'design', 'boards')
    mkdirSync(dir, { recursive: true })
    const w = (n: string, o: unknown) => writeFileSync(join(dir, `${n}.json`), JSON.stringify(o))
    w('overview', { version: 1, nodes: [], order: 0, description: 'The first thing we show' }); w('spec', { version: 1, nodes: [], order: 0, folder: 'research', title: 'The Spec' }); w('old', { version: 1, nodes: [], folder: 'implied' }); w('all-scenes', { version: 1, nodes: [] })
    writeFileSync(join(dir, '_folders.json'), JSON.stringify({ version: 1, folders: [{ name: 'research', order: 1, title: 'R&D', description: 'The thinking' }, { name: 'empty', order: 2 }] }))
    const { boardsCommand } = await import('../src/cli/boards.ts')
    const lines: string[] = []
    const orig = console.log; console.log = (s: string) => { lines.push(String(s)) }
    try {
      boardsCommand(root, {})
      const text = lines.join('\n')
      expect(text).toMatch(/^overview  order 0  - The first thing we show/m)
      expect(text).toMatch(/^research\/  "R&D"  \(folder, 1 board\)  - The thinking\n  spec  "The Spec"  order 0/m)
      expect(text).toMatch(/^empty\/ .*\n  \(empty\)/m)
      expect(text).toMatch(/^implied\/ .*implied by its boards/m)
      expect(text).toMatch(/all-scenes  \(auto, always last\)/)
      expect(text).toMatch(/landing board: overview/)
      lines.length = 0
      boardsCommand(root, { json: true })
      const j = JSON.parse(lines.join('\n'))
      expect(j.landing).toBe('overview')
      expect(j.tree.map((t: any) => t.name)).toEqual(['overview', 'research', 'empty', 'implied'])
    } finally { console.log = orig; rmSync(root, { recursive: true, force: true }) }
  })
})
