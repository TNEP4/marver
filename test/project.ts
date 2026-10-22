/**
 * A throwaway marver project and its dev server, for suites that start, stop and swap canvases on one
 * port (spec 28 A1.11). The project resolves the package from this repo; each server is the built CLI,
 * so a test proves what ships. A server that could not take the port it was given is an error, never a
 * fallback: the suite must not drive whatever answers there instead.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO = join(import.meta.dirname, '..')
const CLI = join(REPO, 'dist', 'cli.mjs')

/** A project with these files (paths relative to its root), resolving `@marver-design/marver` here. */
export function makeProject(prefix: string, files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: prefix.replace(/\W/g, '') || 'fixture', private: true, type: 'module' }))
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  // .vite stays out: each fixture's dev server keeps its own dependency cache
  for (const e of readdirSync(join(REPO, 'node_modules'))) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver') symlinkSync(join(REPO, 'node_modules', e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(REPO, join(nm, '@marver-design', 'marver'))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}

/** The workspace key a canvas started with `npx marver dev` serves for this root (the CLI resolves it). */
export const workspaceOf = (root: string) => createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 16)

export interface Dev { proc: ChildProcess; log: () => string; origin: string }

/** `marver dev` on exactly this port; resolves once the canvas answers there. */
export async function startDev(root: string, port: number): Promise<Dev> {
  let log = ''
  const proc = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(port)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  proc.stdout?.on('data', (d) => { log += d })
  proc.stderr?.on('data', (d) => { log += d })
  const origin = `http://localhost:${port}`
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000) {
    if (/is in use/.test(log)) { proc.kill('SIGTERM'); throw new Error(`port ${port} is taken - not driving whatever answers there\n${log}`) }
    if (proc.exitCode !== null) throw new Error(`marver dev exited (${proc.exitCode})\n${log}`)
    if (log.includes(`http://localhost:${port}/`) && await fetch(`${origin}/`).then((r) => r.ok, () => false)) return { proc, log: () => log, origin }
    await new Promise((r) => setTimeout(r, 200))
  }
  proc.kill('SIGTERM')
  throw new Error(`marver dev did not answer on ${port}\n${log}`)
}

/** Stop a canvas and wait until nothing listens on its port any more. */
export async function stopDev(dev: Dev | null, port: number): Promise<void> {
  if (!dev) return
  if (dev.proc.exitCode === null && dev.proc.signalCode === null) {
    const gone = new Promise<void>((r) => dev.proc.once('exit', () => r()))
    dev.proc.kill('SIGTERM')
    const late = setTimeout(() => dev.proc.kill('SIGKILL'), 10_000)
    await gone
    clearTimeout(late)
  }
  const t0 = Date.now()
  while (Date.now() - t0 < 10_000) {
    const open = await Promise.all(['::1', '127.0.0.1'].map((host) => new Promise<boolean>((r) => {
      const s = connect({ host, port }, () => { s.destroy(); r(true) })
      s.on('error', () => r(false))
    })))
    if (!open.some(Boolean)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`port ${port} still answers after its canvas stopped`)
}
