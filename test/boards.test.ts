import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
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
  if (method === 'POST' || (method === 'PUT' && body !== undefined)) {
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
    // CRLF briefs keep their line endings; a BOM stays where it was and never hides the block
    writeFileSync(brief, '# Title\r\n\r\nBody\r\n')
    await drive(root, 'POST', 'scenes/rename', { scene: 'checkout', title: 'T' }, OWNER)
    expect(readFileSync(brief, 'utf8')).toBe('---\r\ntitle: "T"\r\n---\r\n\r\n# Title\r\n\r\nBody\r\n')
    writeFileSync(brief, '\uFEFF---\ntitle: Old\n---\nbody\n')
    await drive(root, 'POST', 'scenes/rename', { scene: 'checkout', title: 'New' }, OWNER)
    expect(readFileSync(brief, 'utf8')).toBe('\uFEFF---\ntitle: "New"\n---\nbody\n')
    expect((await import('../src/server/manifest.ts')).sceneBrief(root, 'checkout').title).toBe('New')
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
    // a scene is whatever the scanner lists - an underscore directory included
    mkdirSync(join(root, 'design', 'scenes', '_draft')); writeFileSync(join(root, 'design', 'scenes', '_draft', 'home.tsx'), 'export default () => null\n')
    expect((await drive(root, 'POST', 'scenes/rename', { scene: '_draft', title: 'Draft' }, OWNER)).status).toBe(200)
    expect(readFileSync(join(root, 'design', 'scenes', '_draft', '_brief.md'), 'utf8')).toBe('---\ntitle: "Draft"\n---\n')
    // a symlinked design/scenes would land the write outside the project: refused, nothing written
    const outside = join(root, 'outside'); mkdirSync(join(outside, 'far'), { recursive: true }); writeFileSync(join(outside, 'far', 'x.tsx'), 'export default () => null\n')
    const linked = mkdtempSync(join(tmpdir(), 'mv-linked-')); mkdirSync(join(linked, 'design')); symlinkSync(outside, join(linked, 'design', 'scenes'))
    try {
      expect((await drive(linked, 'POST', 'scenes/rename', { scene: 'far', title: 'T' }, OWNER)).status).toBe(400)
      expect(existsSync(join(outside, 'far', '_brief.md'))).toBe(false)
    } finally { rmSync(linked, { recursive: true, force: true }) }
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
  /** A tree write as the shell sends it; `protocol: null` = what a shell that predates nesting sends (no marker). */
  const post = (tree: unknown, b: unknown, protocol: number | null = 2) => drive(root, 'POST', 'boards/reorder', { tree, base: b, ...(protocol === null ? {} : { protocol }) }, OWNER)

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

  it('two levels: a sub-folder lands in the registry with `parent` and version 2; its boards name it; flat stays version 1', async () => {
    writeBoard('a'); writeBoard('x'); writeBoard('p'); writeBoard('q')
    const r = await post(['a', { folder: 'features', items: ['x', { folder: 'shipper', items: ['p', 'q'] }] }], base('a', 'x', 'p', 'q'))
    expect(r.status).toBe(200)
    expect(read(REG)).toEqual({ version: 2, folders: [{ name: 'features', order: 1 }, { name: 'shipper', parent: 'features', order: 1 }] })
    expect(read('x')).toMatchObject({ order: 0, folder: 'features' })
    expect(read('p')).toMatchObject({ order: 0, folder: 'shipper' })
    expect(read('q')).toMatchObject({ order: 1, folder: 'shipper' })
    const f = await drive(root, 'GET', 'folders')
    expect(f.json.folders).toEqual([{ name: 'features', order: 1 }, { name: 'shipper', parent: 'features', order: 1 }])
    // the sub-folder moves out to the root: no parent left, so the registry goes back to version 1
    const r2 = await post(['a', { folder: 'features', items: ['x'] }, { folder: 'shipper', items: ['p', 'q'] }], base('a', 'x', 'p', 'q'))
    expect(r2.status).toBe(200)
    expect(read(REG)).toEqual({ version: 1, folders: [{ name: 'features', order: 1 }, { name: 'shipper', order: 2 }] })
    expect(read('p')).toMatchObject({ folder: 'shipper' })
  })

  it('two levels: a sub-folder keeps its title and agent-facing description through every tree write', async () => {
    writeBoard('p'); writeBoard('q')
    const r = await post([{ folder: 'features', items: [{ folder: 'shipper', title: 'Shipper', description: 'The shipper desk: posting loads', items: ['p'] }, 'q'] }], base('p', 'q'))
    expect(r.status).toBe(200)
    expect(read(REG).folders).toContainEqual({ name: 'shipper', parent: 'features', order: 0, title: 'Shipper', description: 'The shipper desk: posting loads' })
    // a drag that only reorders (the shell sends back what it read) keeps it
    const r2 = await post([{ folder: 'features', items: ['q', { folder: 'shipper', title: 'Shipper', description: 'The shipper desk: posting loads', items: ['p'] }] }], base('p', 'q'))
    expect(r2.status).toBe(200)
    expect(read(REG).folders).toContainEqual({ name: 'shipper', parent: 'features', order: 1, title: 'Shipper', description: 'The shipper desk: posting loads' })
    expect((await drive(root, 'GET', 'folders')).json.folders).toContainEqual({ name: 'shipper', parent: 'features', order: 1, title: 'Shipper', description: 'The shipper desk: posting loads' })
  })

  it('two levels: three levels are refused (400) and nothing is written; a version-2 file an older shell posted over stays stale-protected', async () => {
    writeBoard('a')
    const before = readFileSync(file('a'), 'utf8')
    const r = await post([{ folder: 'f', items: [{ folder: 'g', items: [{ folder: 'h', items: ['a'] }] }] }], base('a'))
    expect(r.status).toBe(400); expect(r.json.error).toMatch(/one level/)
    expect(readFileSync(file('a'), 'utf8')).toBe(before); expect(existsSync(file(REG))).toBe(false)
    // an older shell's one-level body still writes over a FLAT registry (its `boards` shape is read)
    const old = await post([{ folder: 'f', boards: ['a'] }], base('a'), null)
    expect(old.status).toBe(200); expect(read('a')).toMatchObject({ folder: 'f' })
  })

  it('two levels: a tab that predates nesting cannot flatten a nested registry, even with a current hash', async () => {
    writeBoard('p')
    const nested = await post([{ folder: 'features', items: [{ folder: 'shipper', items: ['p'] }] }], base('p'))
    expect(nested.status).toBe(200)
    const before = readFileSync(file(REG), 'utf8')
    // what a 0.20 shell would post: the registry read flat (parent ignored), the right hashes, no protocol
    const flat = await post([{ folder: 'features', boards: [] }, { folder: 'shipper', boards: ['p'] }], base('p'), null)
    expect(flat.status).toBe(422); expect(flat.json.error).toMatch(/reload the canvas/)
    expect(readFileSync(file(REG), 'utf8')).toBe(before)
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
    writeFileSync(file(REG), JSON.stringify({ version: 3, folders: [] }))
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
    w('overview', { version: 1, nodes: [{ frame: 's/on' }], order: 0, description: 'The first thing we show' }); w('spec', { version: 1, nodes: [], order: 0, folder: 'research', title: 'The Spec' }); w('old', { version: 1, nodes: [], folder: 'implied' }); w('all-scenes', { version: 1, nodes: [{ frame: 's/loose' }] })
    mkdirSync(join(root, 'design', 'scenes', 's'), { recursive: true })
    for (const f of ['on', 'loose']) writeFileSync(join(root, 'design', 'scenes', 's', `${f}.tsx`), 'export default () => <main />\n')
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
      expect(text).not.toMatch(/all-scenes/)                                // a leftover file is no board
      expect(text).toMatch(/landing board: overview/)
      expect(text).toMatch(/not on a board \(1\): s\/loose\n  every frame goes on the board it belongs to: npx marver boards pin <board> <scene\/frame \.\.\.>/)
      lines.length = 0
      boardsCommand(root, { json: true })
      const j = JSON.parse(lines.join('\n'))
      expect(j.landing).toBe('overview')
      expect(j.unplaced).toEqual(['s/loose'])
      expect(j.boards.map((b: any) => b.name)).not.toContain('all-scenes')
      expect(j.tree.map((t: any) => t.name)).toEqual(['overview', 'research', 'empty', 'implied'])
    } finally { console.log = orig; rmSync(root, { recursive: true, force: true }) }
  })
  it('prints a sub-folder indented under its parent, its boards under it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-boards-cli2-'))
    const dir = join(root, 'design', 'boards')
    mkdirSync(dir, { recursive: true })
    const w = (n: string, o: unknown) => writeFileSync(join(dir, `${n}.json`), JSON.stringify(o))
    w('x', { version: 1, nodes: [], order: 0, folder: 'features' }); w('p', { version: 1, nodes: [], order: 0, folder: 'shipper' })
    writeFileSync(join(dir, '_folders.json'), JSON.stringify({ version: 2, folders: [{ name: 'features', order: 0 }, { name: 'shipper', parent: 'features', order: 1 }, { name: 'phone', parent: 'features', order: 2 }] }))
    const { boardsCommand } = await import('../src/cli/boards.ts')
    const lines: string[] = []
    const orig = console.log; console.log = (s: string) => { lines.push(String(s)) }
    try {
      boardsCommand(root, {})
      const text = lines.join('\n')
      expect(text).toMatch(/^features\/  \(folder, 1 board, 2 folders\)\n  x  order 0\n  shipper\/  \(sub-folder of features, 1 board\)\n    p  order 0\n  phone\/  \(sub-folder of features, 0 boards\)\n    \(empty\)/m)
      expect(text).toMatch(/landing board: x/)
    } finally { console.log = orig; rmSync(root, { recursive: true, force: true }) }
  })
})

describe('no more All Scenes (spec 26, Part 7) - one meaning of "on a board", boards pin, the leftover file', () => {
  let root = ''
  const dir = () => join(root, 'design', 'boards')
  const w = (n: string, o: unknown) => writeFileSync(join(dir(), `${n}.json`), typeof o === 'string' ? o : JSON.stringify(o))
  const read = (n: string) => JSON.parse(readFileSync(join(dir(), `${n}.json`), 'utf8'))
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mv-no-all-'))
    mkdirSync(dir(), { recursive: true })
    for (const [scene, frames] of Object.entries({ shop: ['cart', 'pay', 'new'], notes: ['idea'] })) {
      mkdirSync(join(root, 'design', 'scenes', scene), { recursive: true })
      for (const f of frames) writeFileSync(join(root, 'design', 'scenes', scene, `${f}.tsx`), 'export default () => <main />\n')
    }
    w('archive', { version: 1, order: 0, type: 'archive', nodes: [{ frame: 'shop/cart' }] })
    w('flow', { version: 1, order: 1, nodes: [{ frame: 'shop/cart' }, { frame: 'shop/pay' }, { frame: 'gone/x' }] })
  })
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  it('membership: every board in sidebar order with archive boards last, its live frames, and the frames on none', async () => {
    const r = await drive(root, 'GET', 'membership')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ boards: [{ name: 'flow', frames: ['shop/cart', 'shop/pay'] }, { name: 'archive', frames: ['shop/cart'] }], unplaced: ['notes/idea', 'shop/new'] })
    w('everything', { version: 1, order: 2, auto: true, nodes: [] })              // an auto board holds every live frame
    expect((await drive(root, 'GET', 'membership')).json.unplaced).toEqual([])
  })

  it('boards pin appends nodes, skips what the board shows, expands a scene, never makes a board', async () => {
    const { boardsPin } = await import('../src/cli/boards.ts')
    expect(boardsPin(root, 'flow', ['shop/new', 'shop/cart'])).toEqual({ added: ['shop/new'], already: ['shop/cart'] })
    expect(read('flow').nodes).toEqual([{ frame: 'shop/cart' }, { frame: 'shop/pay' }, { frame: 'gone/x' }, { frame: 'shop/new' }])
    expect(boardsPin(root, 'archive', ['shop'])).toEqual({ added: ['shop/new', 'shop/pay'], already: ['shop/cart'] })
    expect(() => boardsPin(root, 'nope', ['shop/new'])).toThrow(/no board "nope".*boards new nope/)
    expect(() => boardsPin(root, 'all-scenes', ['shop/new'])).toThrow(/not a board name/)
    expect(() => boardsPin(root, 'flow', ['shop/ghost'])).toThrow(/no frame or scene "shop\/ghost"/)
    expect(() => boardsPin(root, 'flow', [])).toThrow(/name the frames/)
    w('broken', '{ "nodes": [')
    expect(() => boardsPin(root, 'broken', ['shop/new'])).toThrow(/broken\.json is not a board object/)
    w('everything', { version: 1, auto: true, nodes: [] })
    expect(boardsPin(root, 'everything', ['notes/idea'])).toEqual({ added: [], already: ['notes/idea'] })
    expect(read('everything').nodes).toEqual([])
  })

  it('Add to board from the canvas: the same pin, owner-gated', async () => {
    expect((await drive(root, 'POST', 'boards/pin', { board: 'flow', frames: ['notes/idea'] })).status).toBe(403)
    const r = await drive(root, 'POST', 'boards/pin', { board: 'flow', frames: ['notes/idea'] }, OWNER)
    expect(r).toMatchObject({ status: 200, json: { added: ['notes/idea'], already: [] } })
    expect(read('flow').nodes.at(-1)).toEqual({ frame: 'notes/idea' })
    expect((await drive(root, 'POST', 'boards/pin', { board: 'flow', frames: ['nowhere/x'] }, OWNER)).status).toBe(400)
    expect((await drive(root, 'POST', 'boards/pin', { board: 'ghost', frames: ['notes/idea'] }, OWNER)).status).toBe(409)
  })

  it('all-scenes is reserved: never created, renamed to or autosaved; a leftover file is read only for its node keys', async () => {
    expect((await drive(root, 'PUT', 'boards/all-scenes')).status).toBe(400)
    expect(existsSync(join(dir(), 'all-scenes.json'))).toBe(false)
    expect((await drive(root, 'POST', 'boards/rename', { from: 'flow', to: 'all-scenes' }, OWNER)).status).toBe(400)
    const { boardsNew } = await import('../src/cli/boards.ts')
    expect(() => boardsNew(root, 'all-scenes', {})).toThrow(/not a board name/)
    w('all-scenes', { version: 1, auto: true, nodes: [{ key: 'k-old', frame: 'shop/pay' }] })
    expect((await drive(root, 'GET', 'boards/all-scenes')).json.board.nodes).toEqual([{ key: 'k-old', frame: 'shop/pay' }])
  })

  it('a leftover all-scenes.json, valid or malformed, is set aside: no board, no membership, folder moves still work', async () => {
    for (const leftover of ['{ "version": 1, "nodes": [', JSON.stringify({ version: 1, auto: true, nodes: [] })]) {
      w('all-scenes', leftover)
      const list = await drive(root, 'GET', 'boards')
      expect(list.json.map((b: any) => b.name)).toEqual(['archive', 'flow'])
      expect((await drive(root, 'GET', 'membership')).json.unplaced).toEqual(['notes/idea', 'shop/new'])   // an auto leftover holds nothing
      // a folder move: the tree names every board the client saw - the leftover is never one it missed
      const base = { boards: Object.fromEntries(list.json.map((b: any) => [b.name, b.sha256])), folders: null }
      const r = await drive(root, 'POST', 'boards/reorder', { tree: [{ folder: 'past', items: ['archive'] }, 'flow'], base, protocol: 2 }, OWNER)
      expect(r.status, JSON.stringify(r.json)).toBe(200)
      expect(read('archive').folder).toBe('past')
      const { readBoards } = await import('../src/server/build.ts')
      expect(Object.keys(readBoards(root)).sort()).toEqual(['archive', 'flow'])   // the build never fails on it either
      w('archive', { version: 1, order: 0, type: 'archive', nodes: [{ frame: 'shop/cart' }] })
      rmSync(join(dir(), '_folders.json'), { force: true })
    }
  })
})

describe('boards place (F1): a frame next to another, through Marver - "put this variant next to slide 01"', () => {
  let root = ''
  const dir = () => join(root, 'design', 'boards')
  const w = (n: string, o: unknown) => writeFileSync(join(dir(), `${n}.json`), typeof o === 'string' ? o : JSON.stringify(o, null, 2))
  const raw = (n: string) => readFileSync(join(dir(), `${n}.json`), 'utf8')
  const read = (n: string) => JSON.parse(raw(n))
  const slide = (n: string) => `export const meta = { title: '${n}', slide: true }\nexport default () => <main>${n}</main>\n`
  const doc = `import { Doc } from '@marver-design/marver/content'\nexport default () => <Doc><p>notes</p></Doc>\n`
  const S = (x: number, frame: string, y = 0, key = frame.split('/')[1]) => ({ key, frame, x, y, w: 1280, h: 720 })
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mv-place-'))
    mkdirSync(dir(), { recursive: true })
    mkdirSync(join(root, 'design', 'scenes', 'deck'), { recursive: true })
    for (const f of ['01-slide', '02-slide', '03-slide', '01b-variant', '09-later']) writeFileSync(join(root, 'design', 'scenes', 'deck', `${f}.tsx`), slide(f))
    mkdirSync(join(root, 'design', 'scenes', 'notes'), { recursive: true })
    writeFileSync(join(root, 'design', 'scenes', 'notes', 'idea.tsx'), doc)
    // a row of three slides, and one below it
    w('deck', { version: 1, name: 'deck', auto: false, layout: { rows: [['deck']] }, laidOut: { k: '1x1' },
      nodes: [S(0, 'deck/01-slide'), S(1500, 'deck/02-slide'), S(3000, 'deck/03-slide'), S(0, 'deck/09-later', 2000)] })
  })
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })
  const place = async (board: string, frame: string, o: { after?: string; before?: string }) => (await import('../src/cli/boards.ts')).boardsPlace(root, board, [frame], o)

  it('after: the new frame goes right of the anchor in its row, the frames after it move right to make room - the row below and the board\'s own fields stay', async () => {
    const p = await place('deck', 'deck/01b-variant', { after: 'deck/01-slide' })
    expect(p).toMatchObject({ added: true, shifted: 2, laidOut: true })
    const b = read('deck')
    const at = (f: string) => b.nodes.find((n: any) => n.frame === f)
    // the shell's sibling gap: max(140, 12% of the width) - a slide is 1280 wide
    expect(at('deck/01b-variant')).toEqual({ frame: 'deck/01b-variant', x: 1434, y: 0, w: 1280, h: 720 })
    expect([at('deck/01-slide').x, at('deck/02-slide').x, at('deck/03-slide').x]).toEqual([0, 2934, 4434])
    expect(at('deck/09-later')).toEqual(S(0, 'deck/09-later', 2000))
    expect(b.layout).toEqual({ rows: [['deck']] })
    expect(b.laidOut).toEqual({ k: '1x1' })
    // reading order is play order: it plays right after slide 01
    const order = [...b.nodes].sort((p: any, q: any) => p.y - q.y || p.x - q.x).map((n: any) => n.frame)
    expect(order.slice(0, 4)).toEqual(['deck/01-slide', 'deck/01b-variant', 'deck/02-slide', 'deck/03-slide'])
    // asked again: already there, nothing written
    const before = raw('deck')
    expect(await place('deck', 'deck/01b-variant', { after: 'deck/01-slide' })).toMatchObject({ already: true, shifted: 0 })
    expect(raw('deck')).toBe(before)
  })

  it('before, and a move: a frame already on the board keeps its node (key, size) and only moves', async () => {
    expect(await place('deck', 'deck/03-slide', { before: 'deck/02-slide' })).toMatchObject({ added: false, shifted: 1 })
    const at = (f: string) => read('deck').nodes.find((n: any) => n.frame === f)
    expect(at('deck/03-slide')).toEqual(S(1500, 'deck/03-slide'))
    expect(at('deck/02-slide').x).toBe(1500 + 1434)
    expect(read('deck').nodes.length).toBe(4)
  })

  it('a content (Doc) frame is written with no size - the canvas measures it, as it saves one; an auto anchor is sized as the canvas sizes it', async () => {
    w('mix', { version: 1, nodes: [{ key: 'n1', frame: 'notes/idea', x: 0, y: 0 }, S(2000, 'deck/02-slide')] })
    await place('mix', 'deck/01b-variant', { after: 'notes/idea' })
    const n = read('mix').nodes
    // a document Doc is 760 wide: the slide goes 760 + 153.6 (its gap, from the wider of the two) to the right
    expect(n.find((x: any) => x.frame === 'deck/01b-variant')).toMatchObject({ x: 914, y: 0 })
    await place('mix', 'notes/idea', { after: 'deck/02-slide' })
    // (02 moved right to 3434 to make room for the slide above): the Doc keeps its node and its no-size, and moves
    expect(read('mix').nodes.find((x: any) => x.frame === 'notes/idea')).toEqual({ key: 'n1', frame: 'notes/idea', x: 3434 + 1434, y: 0 })
    w('mix2', { version: 1, nodes: [S(0, 'deck/02-slide')] })
    await place('mix2', 'notes/idea', { after: 'deck/02-slide' })
    expect(read('mix2').nodes.find((x: any) => x.frame === 'notes/idea')).toEqual({ frame: 'notes/idea', x: 1434, y: 0 })
  })

  it('a board not laid out yet: the node goes next to the anchor in its list, no position - the canvas lays it out when it opens it', async () => {
    w('fresh', { version: 1, nodes: [{ frame: 'deck/01-slide' }, { frame: 'deck/02-slide' }] })
    expect(await place('fresh', 'deck/01b-variant', { after: 'deck/01-slide' })).toMatchObject({ laidOut: false, added: true })
    expect(read('fresh').nodes).toEqual([{ frame: 'deck/01-slide' }, { frame: 'deck/01b-variant' }, { frame: 'deck/02-slide' }])
    expect(await place('fresh', 'deck/01b-variant', { after: 'deck/01-slide' })).toMatchObject({ already: true })
  })

  it('refused, never guessed: the anchor not on the board, a frame on it twice, a device view, a scene, no side or both, the same frame twice', async () => {
    await expect(place('deck', 'deck/01b-variant', { after: 'notes/idea' })).rejects.toThrow(/notes\/idea is not on deck - put it there first: npx marver boards pin deck notes\/idea/)
    w('twice', { version: 1, nodes: [S(0, 'deck/01-slide', 0, 'a'), S(1500, 'deck/01-slide', 0, 'b')] })
    await expect(place('twice', 'deck/01b-variant', { after: 'deck/01-slide' })).rejects.toThrow(/more than once - place deck\/01b-variant by hand/)
    w('dup', { version: 1, nodes: [S(0, 'deck/01-slide'), S(1500, 'deck/02-slide', 0, 'x'), S(3000, 'deck/02-slide', 0, 'y')] })
    await expect(place('dup', 'deck/02-slide', { after: 'deck/01-slide' })).rejects.toThrow(/more than once - move it by hand/)
    w('device', { version: 1, deviceView: 'mobile', baseLayout: { a: { x: 0, y: 0 } }, nodes: [S(0, 'deck/01-slide')] })
    await expect(place('device', 'deck/01b-variant', { after: 'deck/01-slide' })).rejects.toThrow(/device view \(mobile\) - switch it back to Default/)
    expect(read('device').nodes.length).toBe(1)
    await expect(place('deck', 'deck', { after: 'deck/01-slide' })).rejects.toThrow(/"deck" is not one frame/)
    await expect(place('deck', 'deck/01b-variant', {})).rejects.toThrow(/--after <scene\/frame> or --before/)
    await expect(place('deck', 'deck/01b-variant', { after: 'deck/01-slide', before: 'deck/02-slide' })).rejects.toThrow(/one of them/)
    await expect(place('deck', 'deck/01-slide', { after: 'deck/01-slide' })).rejects.toThrow(/two different frames/)
    await expect(place('nope', 'deck/01b-variant', { after: 'deck/01-slide' })).rejects.toThrow(/no board "nope"/)
  })

  it('one writer at a time: placements from two processes at once both land; the canvas\'s save waits for the board\'s lock (503 while it is held, never the 409 that reloads)', async () => {
    const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
    for (const f of ['04-slide', '05-slide']) writeFileSync(join(root, 'design', 'scenes', 'deck', `${f}.tsx`), slide(f))
    const run = (args: string[]) => new Promise<string>((res) => execFile(process.execPath, [CLI, 'boards', 'place', 'deck', ...args, '--root', root], (err, out, errOut) => res(err ? `ERR ${errOut}` : out)))
    const outs = await Promise.all([run(['deck/04-slide', '--after', 'deck/02-slide']), run(['deck/05-slide', '--after', 'deck/03-slide']), run(['deck/01b-variant', '--before', 'deck/01-slide'])])
    for (const o of outs) expect(o).not.toMatch(/^ERR/)
    const frames = read('deck').nodes.map((n: any) => n.frame)
    for (const f of ['deck/04-slide', 'deck/05-slide', 'deck/01b-variant']) expect(frames).toContain(f)
    // the canvas's autosave while a writer holds the lock: it waits, then says try again (the shell retries a 503)
    writeFileSync(join(dir(), '.deck.lock'), `${process.pid} ${Date.now()}\n`)
    const current = raw('deck')
    const t0 = Date.now()
    const busy = await drive(root, 'PUT', 'boards/deck', { board: { version: 1, nodes: [] }, baseHash: hash(current), mustExist: true })
    expect(busy.status).toBe(503)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_900)
    expect(raw('deck')).toBe(current)
    rmSync(join(dir(), '.deck.lock'))
    expect((await drive(root, 'PUT', 'boards/deck', { board: { version: 1, nodes: [] }, baseHash: hash(current), mustExist: true })).status).toBe(200)
    expect(existsSync(join(dir(), '.deck.lock'))).toBe(false)
  }, 30_000)

  it('the sidebar\'s writers take the board\'s lock too - a rename, a status and a drag never write a board under a placement, so the placed frame is never written away (Codex review: a rename that read the board before a placement committed erased the frame)', async () => {
    const lock = join(dir(), '.deck.lock')
    const frames = () => read('deck').nodes.map((n: any) => n.frame)
    // a placement under way: it holds the lock (it has read the board), and commits its node before letting go
    const placing = () => writeFileSync(lock, `${process.pid} ${Date.now()}\n`)
    const commit = (frame: string, x: number) => { const b = read('deck'); b.nodes.push(S(x, frame)); w('deck', b); rmSync(lock) }
    const during = async (send: () => Promise<{ status: number; json: any }>, frame: string, x: number) => {
      placing()
      const seen = raw('deck')
      let out: { status: number; json: any } | undefined
      const p = send().then((r) => { out = r })
      await new Promise((r) => setTimeout(r, 300))
      expect(out, 'it waits for the placement').toBeUndefined()
      expect(raw('deck'), 'nothing written under the lock').toBe(seen)
      commit(frame, x)
      await p
      expect(frames()).toContain(frame)
      expect(existsSync(lock)).toBe(false)
      return out!
    }
    // a rename against the board as the sidebar saw it: the placement landed since - 409, nothing lost
    let seen = raw('deck')
    expect((await during(() => drive(root, 'POST', 'boards/rename', { from: 'deck', title: 'Deck', baseHash: hash(seen) }, OWNER), 'deck/01b-variant', 4500)).status).toBe(409)
    // one with no base: the title goes over what is on disk now - the placed frame with it
    const r = await during(() => drive(root, 'POST', 'boards/rename', { from: 'deck', title: 'Deck' }, OWNER), 'notes/idea', 6000)
    expect(r.status).toBe(200)
    expect(read('deck').title).toBe('Deck')
    expect(frames()).toEqual(expect.arrayContaining(['deck/01b-variant', 'notes/idea']))
    // the status picker: the same
    const b = read('deck'); b.type = 'feature'; w('deck', b)
    expect((await during(() => drive(root, 'POST', 'boards/status', { name: 'deck', status: 'paused' }, OWNER), 'deck/09-later', 7500)).status).toBe(200)
    expect(read('deck').status).toBe('paused')
    // a drag in the sidebar (the board's order changes): refused while a placement holds the board - the shell
    // reloads and replays a 409 - and nothing it would write is written
    seen = raw('deck')
    placing()
    const drag = await drive(root, 'POST', 'boards/reorder', { tree: [{ folder: 'decks', items: ['deck'] }], base: { boards: { deck: hash(seen) }, folders: null }, protocol: 2 }, OWNER)
    expect(drag.status).toBe(409)
    expect(drag.json.stale).toEqual(['deck'])
    expect(raw('deck')).toBe(seen)
    expect(existsSync(join(dir(), '_folders.json'))).toBe(false)
    rmSync(lock)
    const again = await drive(root, 'POST', 'boards/reorder', { tree: [{ folder: 'decks', items: ['deck'] }], base: { boards: { deck: hash(seen) }, folders: null }, protocol: 2 }, OWNER)
    expect(again.status, JSON.stringify(again.json)).toBe(200)
    expect(read('deck').folder).toBe('decks')
    expect(existsSync(lock)).toBe(false)
  }, 30_000)
})
