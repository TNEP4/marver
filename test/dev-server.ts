import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * One way for the 0.27 suites to start a real `marver dev` from dist/ and wait for it, instead of a
 * nineteenth copy of the spawn-and-wait boilerplate (the older suites keep theirs). Not a test file:
 * vitest collects only `*.test.ts`.
 */

const repo = join(import.meta.dirname, '..')
export const CLI = join(repo, 'dist', 'cli.mjs')
/** The boot line every suite follows (dev.ts: `marver · <name> → http://localhost:<port>/`). */
export const BOOT = /→ (http:\/\/localhost:(\d+))\//

/** A temp project wired the way the browser suites wire theirs: package.json, the repo's node_modules
 *  linked in (never .bin, .vite, .vite-marver), the package itself as @marver-design/marver, then
 *  `files` (path -> content). Its real path. */
export function fixtureRoot(prefix: string, files: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: prefix.replace(/[^a-z0-9-]/g, '') || 'fixture', private: true, type: 'module' }))
  const nm = join(root, 'node_modules')
  mkdirSync(join(nm, '@marver-design'), { recursive: true })
  for (const e of readdirSync(join(repo, 'node_modules'))) if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver' && e !== '@marver-design') symlinkSync(join(repo, 'node_modules', e), join(nm, e))
  symlinkSync(repo, join(nm, '@marver-design', 'marver'))
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true })
    writeFileSync(join(root, f), body)
  }
  return root
}

export interface Dev {
  proc: ChildProcess
  origin: string
  port: number
  /** stdout + stderr so far */
  out(): string
  /** the signal (default SIGTERM), then up to 5 s, then SIGKILL; the exit code */
  stop(signal?: NodeJS.Signals): Promise<number | null>
}

const env = (extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...process.env, BROWSER: 'none', CI: '1', MARVER_NO_UPDATE_CHECK: '1', ...extra })

function launch(root: string, opts: { args?: string[]; env?: NodeJS.ProcessEnv }) {
  const proc = spawn(process.execPath, [CLI, 'dev', '--root', root, ...(opts.args ?? [])], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: env(opts.env) })
  let out = ''
  proc.stdout!.on('data', (d) => { out += d })
  proc.stderr!.on('data', (d) => { out += d })
  const exited = new Promise<number | null>((r) => proc.once('exit', (code) => r(code)))
  return { proc, out: () => out, exited }
}

/** `marver dev --root <root> ...args`, waited for until it prints its boot line AND answers `/`. Rejects
 *  with the output when the process exits first. Tries once more when the port "was just taken by another
 *  program" - the product's own advice, and the one race two suites in two worktrees can hit (their
 *  registries are their own; the machine's ports are not). */
export async function startDev(root: string, opts: { args?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<Dev> {
  for (let attempt = 0; ; attempt++) {
    const l = launch(root, opts)
    let ended: number | null | undefined
    void l.exited.then((c) => { ended = c })
    const by = Date.now() + (opts.timeoutMs ?? 60_000)
    let m: RegExpMatchArray | null = null
    while (Date.now() < by && ended === undefined && !(m = l.out().match(BOOT))) await new Promise((r) => setTimeout(r, 50))
    if (m) {
      const origin = m[1]
      while (Date.now() < by && ended === undefined && !(await fetch(`${origin}/`).then((r) => r.ok, () => false))) await new Promise((r) => setTimeout(r, 100))
      if (ended === undefined) {
        const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
          if (l.proc.exitCode !== null || l.proc.signalCode !== null) return l.proc.exitCode
          try { l.proc.kill(signal) } catch { /* gone */ }
          const code = await Promise.race([l.exited, new Promise<'late'>((r) => setTimeout(() => r('late'), 5_000))])
          if (code !== 'late') return code
          try { l.proc.kill('SIGKILL') } catch { /* gone */ }
          return l.exited
        }
        return { proc: l.proc, origin, port: Number(m[2]), out: l.out, stop }
      }
    }
    if (ended === undefined) { try { l.proc.kill('SIGKILL') } catch { /* gone */ } await l.exited }
    if (attempt === 0 && /was just taken by another program/.test(l.out())) continue
    throw new Error(`marver dev did not start (exit ${ended ?? 'timeout'}):\n${l.out()}`)
  }
}

/** For starts that must stop (all twenty taken, a held in-range port, a refused --recover) or that end on
 *  their own (`--recover` alone lists and returns): waits for the exit. */
export async function runDev(root: string, opts: { args?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ code: number | null; out: string }> {
  const l = launch(root, opts)
  const code = await Promise.race([l.exited, new Promise<'late'>((r) => setTimeout(() => r('late'), opts.timeoutMs ?? 30_000))])
  if (code === 'late') { try { l.proc.kill('SIGKILL') } catch { /* gone */ } throw new Error(`marver dev did not end:\n${l.out()}`) }
  return { code, out: l.out() }
}
