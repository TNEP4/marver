import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { init } from '../src/cli/init.ts'
import { portInUse } from '../src/server/exclusive.ts'

/**
 * Startup as one transaction (spec 28 A1.1): a start that fails at any step - inside Vite's environment
 * initialisation, in configureServer, between createServer and listen, after listening - or is stopped
 * by a signal while it is there, leaves no dev.lock, no slot file, no dev.json, no listening server and
 * nothing of Marver's still running (watchers, sweeps, timers). `dev()` rejects with a DevStartError and
 * never ends the process itself; the CLI does, with a message.
 *
 * Each start runs in a child of its own (they hold process-wide hooks and get signals), on a registry of
 * its own and the slots moved to 48705-48724; the child preloads a recorder of the handles Marver's code
 * opens (fixtures/marver-handles.mjs) and is stepped through the `at` seam.
 */

const repo = join(import.meta.dirname, '..')
const BASE = '48704'
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

interface Report { ok: boolean; typed?: boolean; message?: string; port: number | null; steps: string[]; after?: { lock: boolean; devJson: boolean; running: string[]; inUse: boolean | null; live: string[] } }

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
  if (o.hold) { say({ ok: true, port, steps }); await new Promise(() => {}) }
  await server.close()
  say({ ok: true, port, steps, after: await state() })
} catch (err) {
  for (const s of blockers) await new Promise((r) => s.close(r))
  say({ ok: false, typed: err instanceof DevStartError, message: err.message, port, steps, after: await state() })
}
process.exit(0)`

/** A start in a child of its own. Resolves with its first report; `exited` with how it ended. */
function start(o: { fail?: string; pause?: string; race?: boolean; hold?: boolean }, home = freshHome()) {
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
