import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `marver ls` (spec 28 A1.5): the canvases running on this Mac, from the registry - live holders only,
 * slots by number then ports of their own, folders with `~`; `--json` with the public fields only, never
 * a canvas's key or instance. Run from a folder that is no repo, on a registry of its own.
 */

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
let cwd = ''
const homes: string[] = []
const children: ChildProcess[] = []
beforeAll(() => { cwd = realpathSync(mkdtempSync(join(tmpdir(), 'mv-ls-cwd-'))) })
afterEach(() => { for (const c of children.splice(0)) { try { c.kill('SIGKILL') } catch { /* gone */ } } })
afterAll(() => { for (const h of [cwd, ...homes]) rmSync(h, { recursive: true, force: true }) })

const freshHome = () => { const h = realpathSync(mkdtempSync(join(tmpdir(), 'mv-ls-home-'))); homes.push(h); return h }
const ls = (home: string, ...args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
  execFile(process.execPath, [CLI, 'ls', ...args], { cwd, env: { ...process.env, MARVER_HOME: home } }, (err, stdout, stderr) =>
    resolve({ code: err ? (err as any).code ?? 1 : 0, out: stdout + stderr }))
})
const sleeper = () => { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); children.push(c); return c.pid! }
const deadPid = async () => { const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); await new Promise((r) => c.once('exit', r)); return c.pid! }
const record = (o: { pid: number; slot: number | null; port: number; root: string; state?: string; startedAt?: number }) => JSON.stringify({
  v: 1, state: o.state ?? 'ready', pid: o.pid, instance: `instance-${o.port}`, slot: o.slot, port: o.port, origin: `http://[::1]:${o.port}`, url: `http://localhost:${o.port}/`,
  root: o.root, name: o.root.split('/').pop(), version: '0.27.0', features: [], ws: 'b'.repeat(16), startedAt: o.startedAt ?? Date.now() - 125_000, key: 'SECRET'.repeat(7) + 'x',
})

describe('marver ls (A1.5)', () => {
  it('lists the live canvases - slots by number, then ports - and hides the dead and what is not a canvas', async () => {
    const home = freshHome()
    const run = join(home, 'running')
    mkdirSync(run, { recursive: true })
    const live = sleeper()
    writeFileSync(join(run, 'port-5298.json'), record({ pid: live, slot: null, port: 5298, root: '/tmp/platform/canvas' }))
    writeFileSync(join(run, 'slot-2.json'), record({ pid: live, slot: 2, port: 4806, root: join(homedir(), 'atlas-app') }))
    writeFileSync(join(run, 'slot-1.json'), record({ pid: await deadPid(), slot: 1, port: 4805, root: '/tmp/dead' }))
    writeFileSync(join(run, 'slot-3.json'), '{"v":1,')
    writeFileSync(join(run, 'slot-4.json.reclaim'), JSON.stringify({ pid: live, instance: 'r', at: 1 }))
    writeFileSync(join(run, 'slot-5.json.abc123.tmp'), record({ pid: live, slot: 5, port: 4809, root: '/tmp/half' }))
    const { code, out } = await ls(home)
    expect(code).toBe(0)
    const rows = out.split('\n').map((l) => l.trim()).filter(Boolean)
    expect(rows).toHaveLength(3)
    // the folder last, with ~ for the home folder: the columns before it stay on the line however long it is
    expect(rows[0]).toMatch(/^slot\s+link\s+name\s+version\s+state\s+up\s+folder$/)
    expect(rows[1]).toMatch(/^2\s+http:\/\/localhost:4806\/\s+atlas-app\s+0\.27\.0\s+ready\s+2m\s+~\/atlas-app$/)
    expect(rows[2]).toMatch(/^-\s+http:\/\/localhost:5298\/\s+canvas\s+0\.27\.0\s+ready\s+2m\s+\/tmp\/platform\/canvas$/)
    // a row before its folder is the same width on every line - the folder starts in one column
    const at = out.split('\n').filter((l) => /^\s+(slot|\d|-)\s/.test(l)).map((l) => l.search(/(folder|~\/atlas-app|\/tmp\/platform)/))
    expect(new Set(at).size).toBe(1)
    expect(out).not.toContain('SECRET')
  }, 30_000)

  it('--json: the public fields, never a key or an instance', async () => {
    const home = freshHome()
    mkdirSync(join(home, 'running'), { recursive: true })
    const pid = sleeper()
    writeFileSync(join(home, 'running', 'slot-1.json'), record({ pid, slot: 1, port: 4805, root: '/tmp/one', state: 'starting', startedAt: 1_000 }))
    const { code, out } = await ls(home, '--json')
    expect(code).toBe(0)
    const v = JSON.parse(out)
    expect(v.canvases).toHaveLength(1)
    expect(v.canvases[0]).toMatchObject({ slot: 1, port: 4805, url: 'http://localhost:4805/', origin: 'http://[::1]:4805', name: 'one', folder: '/tmp/one', version: '0.27.0', state: 'starting', pid, startedAt: 1_000 })
    expect(v.canvases[0].uptimeMs).toBeGreaterThan(0)
    expect(Object.keys(v.canvases[0]).sort()).toEqual(['folder', 'name', 'origin', 'pid', 'port', 'slot', 'startedAt', 'state', 'uptimeMs', 'url', 'version'])
    expect(out).not.toContain('SECRET')
    expect(out).not.toContain('instance')
  }, 30_000)

  it('a canvas that is closing is listed, closing - it holds its slot until it has gone', async () => {
    const home = freshHome()
    mkdirSync(join(home, 'running'), { recursive: true })
    writeFileSync(join(home, 'running', 'slot-3.json'), record({ pid: sleeper(), slot: 3, port: 4807, root: '/tmp/leaving', state: 'closing' }))
    const rows = (await ls(home)).out.split('\n').map((l) => l.trim()).filter(Boolean)
    expect(rows[1]).toMatch(/^3\s+http:\/\/localhost:4807\/\s+leaving\s+0\.27\.0\s+closing\s+2m\s+\/tmp\/leaving$/)
    expect(JSON.parse((await ls(home, '--json')).out).canvases.map((c: { state: string }) => c.state)).toEqual(['closing'])
  }, 30_000)

  it('no registry, or an empty one: says so, and makes none', async () => {
    const home = join(freshHome(), 'not-there')
    for (const h of [home, freshHome()]) {
      const { code, out } = await ls(h)
      expect(code).toBe(0)
      expect(out.trim()).toBe('no canvas runs on this Mac - npx marver dev starts one')
      expect(JSON.parse((await ls(h, '--json')).out)).toEqual({ canvases: [] })
    }
    expect(() => realpathSync(home)).toThrow()
  }, 30_000)
})
