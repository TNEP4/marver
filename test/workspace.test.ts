import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiMiddleware } from '../src/server/api.ts'
import { dev } from '../src/server/dev.ts'
import { marverHome, readRunning } from '../src/server/slots.ts'
import { ROUTE } from '../src/cli/name.ts'
import { legacyWorkspace, runIdentity, workspaceId } from '../src/server/workspace.ts'

/**
 * One workspace identity (spec 28 A1.6): sha256 of the REAL path, so a project reached through a
 * symlink is the same project - for the capture upload's check as for CONFIG.workspace - and for every
 * canvas the CLI starts (it resolves the root's real path first) the key 0.26 used.
 */

let base = '', real = '', link = ''
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'mv-ws-'))
  real = join(base, 'project')
  mkdirSync(join(real, 'design'), { recursive: true })
  link = join(base, 'linked')
  symlinkSync(real, link)
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

const sha16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** apiMiddleware driven directly, as boards.test.ts drives it. */
function capture(root: string, body: unknown, opts: { workspace?: string } = {}) {
  const mw = apiMiddleware(root, opts)
  const req: any = {
    method: 'POST', url: `${ROUTE}/api/jam/capture`,
    headers: { host: 'localhost:5200', cookie: 'mv_c=tok', 'x-mv-c': 'tok', origin: 'http://localhost:5200' },
    _cbs: {} as Record<string, (arg?: unknown) => void>,
    on(ev: string, cb: (arg?: unknown) => void) { this._cbs[ev] = cb; return this },
    destroy() { /* unused */ },
  }
  const res: any = { statusCode: 0, body: '', setHeader() { /* unused */ }, end(s?: string) { this.body = s ?? ''; this._done?.() } }
  const done = new Promise<{ status: number; json: any }>((resolve) => {
    res._done = () => resolve({ status: res.statusCode, json: JSON.parse(res.body || 'null') })
    void mw(req, res, () => resolve({ status: 404, json: null }))
  })
  queueMicrotask(() => { req._cbs.data?.(Buffer.from(JSON.stringify(body))); req._cbs.end?.() })
  return done
}

describe('one workspace identity (A1.6)', () => {
  it('a symlinked root is the same project', () => {
    expect(workspaceId(link)).toBe(workspaceId(real))
    expect(workspaceId(real)).toBe(sha16(realpathSync(real)))
    expect(workspaceId(real)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('a CLI start (a real path) keeps the key 0.26 gave it', () => {
    const r = realpathSync(real)
    expect(legacyWorkspace(r)).toBe(workspaceId(r))
    // the root exactly as given: what 0.26 hashed for a caller that passed a link
    expect(legacyWorkspace(link)).toBe(sha16(link))
  })

  it('one run, two values: the canonical id, and the workspace a --recover run serves under', () => {
    expect(runIdentity(link)).toEqual({ root: realpathSync(real), id: workspaceId(real), ws: workspaceId(real) })
    expect(runIdentity(link, 'feedfacefeedface')).toEqual({ root: realpathSync(real), id: workspaceId(real), ws: 'feedfacefeedface' })
  })

  it('the capture upload through a symlinked root: its own key passes, another is refused', async () => {
    // jam is off here, so a capture that passes the workspace check is turned away one step later
    expect(await capture(link, { workspace: workspaceId(real), record: {} })).toEqual({ status: 409, json: { error: 'jam is not running here' } })
    expect(await capture(link, { workspace: 'feedfacefeedface', record: {} })).toEqual({ status: 409, json: { error: 'this capture was made in another workspace' } })
  })

  it('a --recover run checks captures against the workspace it serves under', async () => {
    expect(await capture(real, { workspace: 'feedfacefeedface', record: {} }, { workspace: 'feedfacefeedface' })).toEqual({ status: 409, json: { error: 'jam is not running here' } })
    expect(await capture(real, { workspace: workspaceId(real), record: {} }, { workspace: 'feedfacefeedface' })).toEqual({ status: 409, json: { error: 'this capture was made in another workspace' } })
  })
})

describe('the same workspace everywhere (A1.6)', () => {
  it('a canvas started through a symlink: the page, the slot file and the preference file all name the real path\'s key', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const repo = join(import.meta.dirname, '..')
    const nm = join(real, 'node_modules')
    mkdirSync(nm, { recursive: true })
    for (const e of readdirSync(join(repo, 'node_modules'))) if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver') symlinkSync(join(repo, 'node_modules', e), join(nm, e))
    writeFileSync(join(real, 'package.json'), JSON.stringify({ name: 'ws-fixture', private: true, type: 'module' }))
    writeFileSync(join(real, 'design', 'config.ts'), 'export default { jam: false }\n')
    const server = await dev(link)   // the suite's own registry and slots (test/global-setup.ts)
    try {
      const port = (server.httpServer!.address() as { port: number }).port
      const id = workspaceId(real)
      expect(await (await fetch(`http://localhost:${port}/@id/__x00__virtual:sh-config`)).text()).toContain(`"workspace":"${id}"`)
      const mine = readRunning().find((r) => r.pid === process.pid && r.port === port)
      expect(mine).toMatchObject({ ws: id, root: realpathSync(real), name: 'project', state: 'ready' })
      expect(existsSync(join(marverHome(), 'prefer', `${id}.json`))).toBe(true)
    } finally {
      await server.close()
      log.mockRestore()
    }
    expect(readRunning().filter((r) => r.pid === process.pid)).toEqual([])
  }, 120_000)
})
