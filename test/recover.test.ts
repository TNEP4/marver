import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureRoot, runDev, startDev, type Dev } from './dev-server.ts'
import { portInUse } from '../src/server/exclusive.ts'
import { legacyPort } from '../src/server/slots.ts'
import { workspaceId } from '../src/server/workspace.ts'

/**
 * `marver dev --recover` (spec 28 A1.6): a capture left unsent waits at an address, in a browser, under
 * a workspace key. --recover lists the addresses a project ran on - newest first, then the one 0.26 gave
 * the folder - and starts on exactly one of them: its port, its workspace key, never another address; it
 * never rewrites the preference file. Real `marver dev` starts from dist/, a registry of their own and
 * the slots on the suite's own twenty in the run's block (test/global-setup.ts).
 */

const BASE = inject('marverSlotBases').recover
let home = ''
const env = () => ({ MARVER_HOME: home, MARVER_SLOT_BASE: String(BASE) })
const roots: string[] = []
const devs: Dev[] = []
const children: ChildProcess[] = []
beforeAll(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'mv-recover-home-'))) })
afterEach(async () => {
  for (const d of devs.splice(0)) await d.stop('SIGKILL')
  for (const c of children.splice(0)) { try { c.kill('SIGKILL') } catch { /* gone */ } }
})
afterAll(() => { for (const r of [home, ...roots]) rmSync(r, { recursive: true, force: true }) })

const project = () => { const r = fixtureRoot('mv-recover-', { 'design/config.ts': 'export default { jam: false }\n' }); roots.push(r); return r }
const start = async (root: string, args: string[] = []) => { const d = await startDev(root, { args, env: env() }); devs.push(d); return d }
const stop = async (d: Dev) => { await d.stop('SIGINT'); devs.splice(devs.indexOf(d), 1) }
const running = (f = '') => join(home, 'running', f)
const preferOf = (root: string) => join(home, 'prefer', `${workspaceId(root)}.json`)
const sleeper = () => { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); children.push(c); return c.pid! }
/** Another canvas holding slot n (a live pid). */
const hold = (n: number, pid = sleeper()) => {
  mkdirSync(running(), { recursive: true })
  writeFileSync(running(`slot-${n}.json`), JSON.stringify({ v: 1, state: 'ready', pid, instance: `fake-${n}`, slot: n, port: BASE + n, origin: `http://[::1]:${BASE + n}`,
    url: `http://localhost:${BASE + n}/`, root: `/tmp/other-${n}`, name: `other-${n}`, version: '0.27.0', features: [], ws: 'c'.repeat(16), startedAt: Date.now(), key: 'k'.repeat(43) }))
}
const entries = (out: string) => [...out.matchAll(/^\s+(\d+)\s+(http:\/\/localhost:\d+\/)(.*)$/gm)].map((m) => ({ n: Number(m[1]), url: m[2], rest: m[3] }))
const config = async (d: Dev) => (await fetch(`${d.origin}/@id/__x00__virtual:sh-config`)).text()
const capture = (d: Dev, workspace: string) => fetch(`${d.origin}/__mv/api/jam/capture`, {
  method: 'POST', body: JSON.stringify({ workspace, record: {} }),
  headers: { 'content-type': 'application/json', cookie: 'mv_c=tok', 'x-mv-c': 'tok', origin: d.origin },
}).then(async (r) => ({ status: r.status, json: await r.json() }))
const sha16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
/** Does anything accept a connection at host:port? */
const connects = (host: string, port: number) => new Promise<boolean>((resolve) => {
  const s = connect({ host, port })
  s.once('connect', () => { s.destroy(); resolve(true) })
  s.once('error', () => resolve(false))
})

describe('--recover: the addresses a project ran on (A1.6)', () => {
  let p = ''
  beforeAll(async () => {
    p = project()
    // slot 1 taken: the project lands on slot 2 ...
    hold(1)
    const first = await start(p)
    expect(first.port).toBe(BASE + 2)
    await stop(first)
    // ... then slot 2 taken too: on slot 3
    hold(2)
    const second = await start(p)
    expect(second.port).toBe(BASE + 3)
    // where it ran last, who holds it now, and --recover's own number for it (this run is 1)
    expect(second.out()).toContain(`last run was at http://localhost:${BASE + 2}/ - "other-2" runs there now`)
    expect(second.out()).toContain('stop "other-2" and this canvas, then `npx marver dev --recover 2`')
    await stop(second)
    unlinkSync(running('slot-1.json'))
    unlinkSync(running('slot-2.json'))
  }, 120_000)

  it('a normal run records the link people open and the address it bound', () => {
    const pref = JSON.parse(readFileSync(preferOf(p), 'utf8'))
    expect(pref.slot).toBe(3)
    expect(pref.history.map((a: any) => a.url)).toEqual([`http://localhost:${BASE + 3}/`, `http://localhost:${BASE + 2}/`])
    for (const a of pref.history) expect(a.bind).toMatch(new RegExp(`^http://(\\[::1\\]|127\\.0\\.0\\.1):${a.url.match(/:(\d+)\//)[1]}$`))
    expect(pref.history[1].until).toBeGreaterThan(pref.history[1].from)   // its stop was recorded
  })

  it('alone, it lists them newest first, then the address 0.26 gave the folder - and starts nothing', async () => {
    const { code, out } = await runDev(p, { args: ['--recover'], env: env() })
    expect(code).toBe(0)
    expect(entries(out).map((e) => [e.n, e.url])).toEqual([[1, `http://localhost:${BASE + 3}/`], [2, `http://localhost:${BASE + 2}/`], [3, `http://localhost:${legacyPort(p)}/`]])
    expect(entries(out)[2].rest).toContain('the address 0.26 gave it')
    expect(out).not.toMatch(/→ http:\/\/localhost:/)
    expect(existsSync(join(p, 'design', '.local', 'dev.lock'))).toBe(false)
    expect(readdirSync(running())).toEqual([])
  }, 60_000)

  it('--recover 2 binds exactly that address - its port and its bound address - and leaves the preference file as it was', async () => {
    // the entry recorded on the other loopback family: a recovery that dropped the bound address (Vite's
    // default, `localhost`) would bind the family this Mac resolves first
    const pref = JSON.parse(readFileSync(preferOf(p), 'utf8'))
    const recorded: string = pref.history[1].bind
    const v6 = recorded.startsWith('http://[::1]:')
    const other = v6 ? `http://127.0.0.1:${BASE + 2}` : `http://[::1]:${BASE + 2}`
    writeFileSync(preferOf(p), JSON.stringify({ ...pref, history: pref.history.map((a: any, i: number) => i === 1 ? { ...a, bind: other } : a) }))
    const before = readFileSync(preferOf(p), 'utf8')
    const d = await start(p, ['--recover', '2'])
    expect(d.port).toBe(BASE + 2)
    expect(d.out()).toContain(`recovering: open http://localhost:${BASE + 2}/ in the browser that made the capture (the app loads ${other})`)
    expect(JSON.parse(readFileSync(running('slot-2.json'), 'utf8'))).toMatchObject({ slot: 2, state: 'ready', ws: workspaceId(p), origin: other })
    // ...and only there: the family it was not given answers nothing on that port
    expect(await connects(v6 ? '::1' : '127.0.0.1', BASE + 2)).toBe(false)
    expect(await connects(v6 ? '127.0.0.1' : '::1', BASE + 2)).toBe(true)
    await stop(d)
    expect(readFileSync(preferOf(p), 'utf8')).toBe(before)
    writeFileSync(preferOf(p), JSON.stringify(pref))
  }, 60_000)

  it('...under the workspace key that address used: the page, the registry and the capture check all read it', async () => {
    const pref = JSON.parse(readFileSync(preferOf(p), 'utf8'))
    pref.history[1].ws = 'feedfacefeedface'
    writeFileSync(preferOf(p), JSON.stringify(pref))
    const listed = await runDev(p, { args: ['--recover'], env: env() })
    expect(entries(listed.out)[1].rest).toContain('(another workspace key)')
    const d = await start(p, ['--recover', '2'])
    expect(await config(d)).toContain('"workspace":"feedfacefeedface"')
    expect(JSON.parse(readFileSync(running('slot-2.json'), 'utf8')).ws).toBe('feedfacefeedface')
    // jam is off here: a capture that passes the workspace check is turned away one step later
    expect(await capture(d, 'feedfacefeedface')).toEqual({ status: 409, json: { error: 'jam is not running here' } })
    expect(await capture(d, workspaceId(p))).toEqual({ status: 409, json: { error: 'this capture was made in another workspace' } })
    await stop(d)
    pref.history[1].ws = workspaceId(p)
    writeFileSync(preferOf(p), JSON.stringify(pref))
  }, 60_000)

  it('never takes another address: with its slot held, it stops and says who holds it', async () => {
    hold(2)
    const { code, out } = await runDev(p, { args: ['--recover', '2'], env: env() })
    expect(code).toBe(1)
    expect(out).toContain(`port ${BASE + 2} is held by "other-2" (/tmp/other-2) - --recover never takes another address`)
    expect(out).not.toMatch(/→ http:\/\/localhost:/)
    expect(readdirSync(running())).toEqual(['slot-2.json'])
    unlinkSync(running('slot-2.json'))
    const none = await runDev(p, { args: ['--recover', '9'], env: env() })
    expect(none.code).toBe(1)
    expect(none.out).toContain('no address 9 - npx marver dev --recover lists them')
  }, 60_000)
})

describe('--recover from 0.26: no history yet (A1.6)', () => {
  /** A project whose 0.26 port is free on this Mac (5200-5399 holds real 0.26 canvases). */
  const fresh = async () => {
    for (let i = 0; i < 20; i++) { const r = project(); if (!(await portInUse(legacyPort(r)))) return r }
    throw new Error('no fixture whose 0.26 port is free')
  }

  it('offers one address - 0.26\'s hash port and key - and serves it, through the real path and a symlink alike', async () => {
    const q = await fresh()
    const link = join(mkdtempSync(join(tmpdir(), 'mv-recover-link-')), 'linked')
    roots.push(link)
    symlinkSync(q, link)
    for (const root of [q, link]) {
      const { code, out } = await runDev(root, { args: ['--recover'], env: env() })
      expect(code).toBe(0)
      expect(entries(out).map((e) => e.url)).toEqual([`http://localhost:${legacyPort(q)}/`])
      const d = await start(root, ['--recover', '1'])
      expect(d.port).toBe(legacyPort(q))
      expect(await config(d)).toContain(`"workspace":"${sha16(q)}"`)
      expect(JSON.parse(readFileSync(running(`port-${legacyPort(q)}.json`), 'utf8'))).toMatchObject({ slot: null, ws: sha16(q), root: q })
      await stop(d)
    }
    expect(existsSync(preferOf(q))).toBe(false)   // a recovery records nothing
  }, 120_000)

  it('--recover --port <p>: the port 0.26 moved to, with 0.26\'s key; with an entry too, refused', async () => {
    const q = await fresh()
    let port = 47_000 + Math.floor(Math.random() * 1000)
    while (await portInUse(port)) port++
    const d = await start(q, ['--recover', '--port', String(port)])
    expect(d.port).toBe(port)
    expect(await config(d)).toContain(`"workspace":"${sha16(q)}"`)
    await stop(d)
    const both = await runDev(q, { args: ['--recover', '1', '--port', String(port)], env: env() })
    expect(both.code).toBe(1)
    expect(both.out).toContain('give --recover <n>, or --recover --port <p> - not both')
  }, 120_000)
})
