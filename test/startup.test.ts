import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { init } from '../src/cli/init.ts'
import { portInUse } from '../src/server/exclusive.ts'

/**
 * Startup as one transaction (spec 28 A1.1): a start that fails at any step - inside Vite's environment
 * initialisation, in configureServer, between createServer and listen, after listening - or is stopped
 * by a signal while it is there, leaves no dev.lock, no slot file, no dev.json, no listening server and
 * nothing of Marver's still running (watchers, sweeps, timers). `dev()` rejects with a DevStartError and
 * never ends the process itself; the CLI does, with a message. A Vite restart (an .env edit) is no way out: it
 * keeps all of that, and replaces only the server and the watchers that belong to it.
 *
 * Each start runs in a child of its own (they hold process-wide hooks and get signals), on a registry of
 * its own and the suite's own twenty slots in the run's block (test/global-setup.ts); the child preloads a
 * recorder of the handles Marver's code opens (fixtures/marver-handles.mjs) and is stepped through the
 * `at` seam.
 */

const repo = join(import.meta.dirname, '..')
const BASE = String(inject('marverSlotBases').startup)
const STEPS = ['locked', 'claimed', 'env', 'configure', 'created', 'listening', 'published'] as const
let root = ''
const homes: string[] = []
const children: ChildProcess[] = []

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-startup-')))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'startup-fixture', private: true, type: 'module' }))
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(join(repo, 'node_modules'))) if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver') symlinkSync(join(repo, 'node_modules', e), join(nm, e))
  init(root, { mode: 'studio', demo: true })
  // no Live Jam: its daemon is not what is under test, and an agent CLI on this Mac's PATH would arm it
  writeFileSync(join(root, 'design', 'config.ts'), 'export default { jam: false }\n')
  vi.restoreAllMocks()
}, 60_000)
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL') } catch { /* gone */ } }
})
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

const freshHome = () => { const h = realpathSync(mkdtempSync(join(tmpdir(), 'mv-startup-home-'))); homes.push(h); return h }
const local = (f: string) => join(root, 'design', '.local', f)
const runningIn = (home: string) => existsSync(join(home, 'running')) ? readdirSync(join(home, 'running')) : []

interface State { lock: boolean; devJson: boolean; running: string[]; inUse: boolean | null; live: string[] }
interface Report { ok: boolean; typed?: boolean; message?: string; port: number | null; steps: string[]; after?: State; restarted?: boolean; before?: State; now?: State }

const CHILD = `import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
const o = JSON.parse(process.env.MV_START)
const { dev, DevStartError } = await import(o.devModule)
const { portInUse } = await import(o.exclusiveModule)
const home = process.env.MARVER_HOME
let port = null
const steps = [], blockers = []
const at = async (step, info) => {
  steps.push(step)
  if (info && info.port) port = info.port
  // another program takes the port between the check and the bind - on both loopbacks, so whichever Vite binds is taken
  if (o.race && step === 'claimed') for (const h of ['127.0.0.1', '::1']) await new Promise((r, j) => { const s = createServer(); blockers.push(s); s.once('error', j); s.listen(port, h, () => r()) })
  if (step === o.fail) throw new Error('injected at ' + step)
  if (step === o.pause) { writeFileSync(join(home, 'at-' + step), String(port)); await new Promise(() => { setInterval(() => {}, 1000) }) }   // paused, alive: before Vite, nothing else holds the process
}
const state = async () => ({
  lock: existsSync(join(o.root, 'design', '.local', 'dev.lock')), devJson: existsSync(join(o.root, 'design', '.local', 'dev.json')),
  running: existsSync(join(home, 'running')) ? readdirSync(join(home, 'running')) : [], inUse: port ? await portInUse(port) : null, live: globalThis.__marverLive(),
})
const say = (v) => process.stdout.write('@@' + JSON.stringify(v) + '\\n')
try {
  const server = await dev(o.root, { at })
  let restart = {}
  if (o.restart) {
    // an .env edit: Vite restarts in place - a new HTTP server on this same object, listening on the same port
    const before = await state(), http = server.httpServer
    if (o.restartFails) {
      // the new server's listen fails: another program took the port as the old server let it go
      const { Server } = await import('node:net')
      const listen = Server.prototype.listen
      Server.prototype.listen = function () {
        Server.prototype.listen = listen
        process.nextTick(() => this.emit('error', Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE' })))
        return this
      }
    }
    writeFileSync(join(o.root, '.env'), 'MV_RESTART=' + Date.now() + '\\n')
    const lock = join(o.root, 'design', '.local', 'dev.lock')
    for (let i = 0; i < 600 && !(server.httpServer !== http && (server.httpServer.listening || !existsSync(lock))); i++) await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 500))   // the old server's watchers closed, the wraps back on
    restart = { restarted: server.httpServer !== http, before, now: await state() }
  }
  if (o.hold) { say({ ok: true, port, steps, ...restart }); await new Promise(() => {}) }
  await server.close()
  say({ ok: true, port, steps, ...restart, after: await state() })
} catch (err) {
  for (const s of blockers) await new Promise((r) => s.close(r))
  say({ ok: false, typed: err instanceof DevStartError, message: err.message, port, steps, after: await state() })
}
process.exit(0)`

/** A start in a child of its own. Resolves with its first report; `exited` with how it ended. */
function start(o: { fail?: string; pause?: string; race?: boolean; hold?: boolean; restart?: boolean; restartFails?: boolean }, home = freshHome()) {
  const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', pathToFileURL(join(repo, 'test', 'fixtures', 'marver-handles.mjs')).href, '--input-type=module', '-e', CHILD], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MARVER_HOME: home, MARVER_SLOT_BASE: BASE, MARVER_NO_UPDATE_CHECK: '1', CI: '1', BROWSER: 'none', MV_HANDLES_SRC: join(repo, 'src') + '/',
      MV_START: JSON.stringify({ ...o, root, devModule: join(repo, 'src', 'server', 'dev.ts'), exclusiveModule: join(repo, 'src', 'server', 'exclusive.ts') }) },
  })
  children.push(c)
  let out = '', err = ''
  c.stderr!.on('data', (d) => { err += d })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => c.once('exit', (code, signal) => r({ code, signal })))
  const report = new Promise<Report>((res, rej) => {
    c.stdout!.on('data', (d) => {
      out += d
      const line = out.split('\n').find((l) => l.startsWith('@@'))
      if (line) res(JSON.parse(line.slice(2)))
    })
    void exited.then(({ code, signal }) => rej(new Error(`the start exited (${code ?? signal}) without a report\n${out}\n${err}`)))
  })
  report.catch(() => { /* a start stopped by a signal never reports */ })
  return { child: c, home, report, exited, out: () => out + err }
}

const waitFor = async (ok: () => boolean, ms = 30_000) => {
  for (const by = Date.now() + ms; Date.now() < by; await new Promise((r) => setTimeout(r, 50))) if (ok()) return
  throw new Error('timed out')
}
const clean = { lock: false, devJson: false, running: [], live: [] }

describe('a start that fails leaves nothing behind (A1.1)', () => {
  for (const step of STEPS) {
    it(`a failure at "${step}": dev() rejects, typed, after closing what it made and giving back what it held`, async () => {
      const { report } = start({ fail: step })
      const r = await report
      expect(r.ok).toBe(false)
      expect(r.typed).toBe(true)
      expect(r.message).toMatch(new RegExp(`^the canvas could not start: .*injected at ${step}`))
      expect(r.steps.at(-1)).toBe(step)
      expect(r.after).toEqual({ ...clean, inUse: step === 'locked' ? null : false })
    }, 60_000)
  }

  it('another program takes the port between the check and the bind: named, and nothing is left', async () => {
    const r = await start({ race: true }).report
    expect(r.ok).toBe(false)
    expect(r.typed).toBe(true)
    expect(r.message).toBe(`port ${r.port} was just taken by another program - start again`)
    expect(r.steps).toEqual(['locked', 'claimed', 'env', 'configure', 'created'])
    expect(r.after).toEqual({ ...clean, inUse: false })
  }, 60_000)

  it('a full start, then close: the same - nothing of Marver\'s still runs', async () => {
    const r = await start({}).report
    expect(r.ok).toBe(true)
    expect(r.steps).toEqual([...STEPS])
    expect(r.after).toEqual({ ...clean, inUse: false })
  }, 60_000)
})

describe('a signal at any step gives back what is held (A1.1)', () => {
  for (const step of STEPS) {
    it(`SIGTERM while "${step}"`, async () => {
      const s = start({ pause: step })
      const marker = join(s.home, `at-${step}`)
      await waitFor(() => existsSync(marker))
      const port = Number(readFileSync(marker, 'utf8')) || null
      if (step !== 'locked') {
        expect(port).toBeTruthy()
        expect(runningIn(s.home)).toHaveLength(1)
      }
      expect(existsSync(local('dev.lock'))).toBe(true)
      s.child.kill('SIGTERM')
      await Promise.race([s.exited, new Promise((_, j) => setTimeout(() => j(new Error(`still running after SIGTERM\n${s.out()}`)), 15_000))])
      expect(existsSync(local('dev.lock'))).toBe(false)
      expect(existsSync(local('dev.json'))).toBe(false)
      expect(runningIn(s.home)).toEqual([])
      if (port) expect(await portInUse(port)).toBe(false)
    }, 60_000)
  }

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    it(`${sig} after a full start`, async () => {
      const s = start({ hold: true })
      const r = await s.report
      expect(r.ok).toBe(true)
      expect(runningIn(s.home)).toEqual([`slot-${r.port! - Number(BASE)}.json`])
      expect(JSON.parse(readFileSync(join(s.home, 'running', `slot-${r.port! - Number(BASE)}.json`), 'utf8')).state).toBe('ready')
      expect(existsSync(local('dev.json'))).toBe(true)
      s.child.kill(sig)
      await Promise.race([s.exited, new Promise((_, j) => setTimeout(() => j(new Error(`still running after ${sig}\n${s.out()}`)), 15_000))])
      expect(existsSync(local('dev.lock'))).toBe(false)
      expect(existsSync(local('dev.json'))).toBe(false)
      expect(runningIn(s.home)).toEqual([])
      expect(await portInUse(r.port!)).toBe(false)
    }, 60_000)
  }
})

describe('a Vite restart is no way out (A1.1)', () => {
  /** What of Marver's own keeps running: its watchers and its sweeps (a timeout comes and goes). */
  const kept = (s: State) => s.live.filter((l) => /^(fs\.watch|setInterval)/.test(l)).sort()
  afterEach(() => rmSync(join(root, '.env'), { force: true }))

  it('an .env edit: the claims, dev.json, the slot file and Marver\'s watchers stay, a frame edit still reaches the pages, and a SIGTERM still gives everything back', async () => {
    const s = start({ restart: true, hold: true })
    const r = await s.report
    expect(r.ok).toBe(true)
    expect(r.restarted).toBe(true)
    const slot = `slot-${r.port! - Number(BASE)}.json`
    for (const st of [r.before!, r.now!]) expect({ ...st, live: [] }).toEqual({ lock: true, devJson: true, running: [slot], inUse: true, live: [] })
    expect(JSON.parse(readFileSync(join(s.home, 'running', slot), 'utf8')).state).toBe('ready')
    // the new server's watchers in place of the old one's, the start's own untouched: board sync, the shot inbox,
    // the comment watcher, and the sweeps
    expect(kept(r.now!)).toEqual(kept(r.before!))
    for (const w of [['design', 'boards'], ['design', '.local', 'shots'], ['design', 'comments']]) expect(kept(r.now!).some((l) => l.startsWith(`fs.watch ${join(root, ...w)} `)), w.join('/')).toBe(true)
    // calm updates still flow: the change that restarted Vite never lands, and never holds the next one for good
    const token = (await (await fetch(`http://localhost:${r.port}/@vite/client`)).text()).match(/const wsToken = "([^"]+)"/)?.[1]
    expect(token).toBeTruthy()
    const ws = new WebSocket(`ws://localhost:${r.port}/?token=${token}`, 'vite-hmr', { headers: { origin: `http://localhost:${r.port}` } })
    const invalidated = new Promise<string[]>((res) => ws.on('message', (m) => {
      const p = JSON.parse(String(m))
      if (p.type === 'custom' && p.event === 'sh:frame-invalidated') res(p.data.frameIds)
    }))
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
    const frame = join(root, 'design', 'scenes', 'demo', 'welcome.tsx')
    writeFileSync(frame, `${readFileSync(frame, 'utf8')}\n// edited after a restart ${Date.now()}\n`)
    expect(await Promise.race([invalidated, new Promise<never>((_, j) => setTimeout(() => j(new Error('no sh:frame-invalidated after the restart')), 25_000))])).toContain('demo/welcome')
    ws.close()
    s.child.kill('SIGTERM')
    await Promise.race([s.exited, new Promise((_, j) => setTimeout(() => j(new Error(`still running after SIGTERM\n${s.out()}`)), 15_000))])
    expect(existsSync(local('dev.lock'))).toBe(false)
    expect(existsSync(local('dev.json'))).toBe(false)
    expect(runningIn(s.home)).toEqual([])
    expect(await portInUse(r.port!)).toBe(false)
  }, 90_000)

  it('a close after a restart: nothing of Marver\'s still runs, the new server\'s watchers included', async () => {
    const r = await start({ restart: true }).report
    expect(r.ok).toBe(true)
    expect(r.restarted).toBe(true)
    expect(kept(r.before!).length).toBeGreaterThan(0)
    expect(kept(r.now!)).toEqual(kept(r.before!))
    expect(r.after).toEqual({ ...clean, inUse: false })
  }, 60_000)

  it('a restart that cannot listen ends the start: said, and everything given back', async () => {
    const s = start({ restart: true, restartFails: true })
    const r = await s.report
    expect(r.ok).toBe(true)
    expect(r.restarted).toBe(true)
    expect(r.now).toEqual({ ...clean, inUse: false })
    expect(s.out()).toContain(`the canvas stopped: it could not restart on port ${r.port}`)
  }, 60_000)
})

describe('the CLI ends the process (A1.1, A1.3)', () => {
  it('all twenty slots taken: `marver dev` stops before Vite starts, with the list, and exits 1', async () => {
    const home = freshHome()
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    children.push(sleeper)
    mkdirSync(join(home, 'running'), { recursive: true })
    for (let n = 1; n <= 20; n++) {
      const port = Number(BASE) + n
      writeFileSync(join(home, 'running', `slot-${n}.json`), JSON.stringify({ v: 1, state: 'ready', pid: sleeper.pid, instance: `i${n}`, slot: n, port, origin: `http://[::1]:${port}`,
        url: `http://localhost:${port}/`, root: `/tmp/canvas-${n}`, name: `canvas-${n}`, version: '0.27.0', features: [], ws: 'a'.repeat(16), startedAt: Date.now(), key: 'k'.repeat(43) }))
    }
    const c = spawn(process.execPath, [join(repo, 'dist', 'cli.mjs'), 'dev', '--root', root], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MARVER_HOME: home, MARVER_SLOT_BASE: BASE, MARVER_NO_UPDATE_CHECK: '1', CI: '1', BROWSER: 'none' },
    })
    children.push(c)
    let out = '', err = ''
    c.stdout!.on('data', (d) => { out += d })
    c.stderr!.on('data', (d) => { err += d })
    const t0 = Date.now()
    const code = await new Promise<number | null>((r) => c.once('exit', (n) => r(n)))
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(code).toBe(1)
    expect(err).toContain('all 20 slots are taken:')
    for (let n = 1; n <= 20; n++) expect(err).toContain(`http://localhost:${Number(BASE) + n}/  canvas-${n}`)
    expect(err).toContain('stop one (Ctrl-C in its terminal), or start this one with --port <n>')
    expect(out).not.toMatch(/→ http:\/\/localhost:/)
    expect(existsSync(local('dev.lock'))).toBe(false)
    expect(runningIn(home).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `slot-${i + 1}.json`).sort())
  }, 30_000)
})
