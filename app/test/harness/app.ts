/**
 * The two launchers of the dev build (spec 28 A2.10, A2.14 #27), both on a TestEnv of their own:
 *
 * - `launchPW`: Playwright's Electron driver. Its loader adds Chromium's test switches - the hang monitor, paint
 *   holding, renderer and timer backgrounding and the back-forward cache off, a beforeunload check off, a mock
 *   keychain - so what depends on those runs in the other launcher. For the wiring and the DOM.
 * - `launchProd`: the real Electron binary with the app folder and nothing else - the production switches -
 *   driven over the control socket (MARVER_APP_CONTROL, mode 600). For the hang, one copy of each guard case,
 *   hidden tabs and the memory budget.
 *
 * Both answer the same `call(hook, args)`. `close()` asks the app to quit and, when it does not within 10 s,
 * ends the process it started - never another. Neither launches a bundle whose Mach-O parts carry more than one
 * Team ID (scripts/team-id.mjs, spec 28 A2.8): such a bundle crashes at once, with a macOS dialog.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication } from 'playwright-core'
import { assertOneTeam } from '../../scripts/team-id.mjs'
import { playwrightControl, socketControl, type Control } from './control.ts'
import type { TestEnv } from './env.ts'

export const APP_DIR = resolve(import.meta.dirname, '..', '..')
const require = createRequire(join(APP_DIR, 'package.json'))
/** The Electron binary of the pinned version (its path lookup downloads it when missing). */
export const ELECTRON_BIN: string = require('electron') as unknown as string

export interface AppRun {
  kind: 'pw' | 'prod'
  pid: number
  env: TestEnv
  call<T = unknown>(name: string, args?: unknown): Promise<T>
  /** quits the app; resolves with its exit code (null when it had to be killed) */
  close(): Promise<number | null>
  pw?: ElectronApplication
  child?: ChildProcess
  /** what the process wrote, for a failing case's message */
  output(): string
}

function checkBuilt() {
  if (!existsSync(join(APP_DIR, 'dist', 'main.cjs'))) throw new Error('no dist/main.cjs: run `node scripts/build.mjs --js` (the global setup does)')
  assertOneTeam(ELECTRON_BIN)   // throws "refusing to launch ...", naming each Team ID and its parts
}

export async function launchPW(env: TestEnv, opts: { args?: string[]; extraEnv?: Record<string, string> } = {}): Promise<AppRun> {
  checkBuilt()
  // no executablePath: Playwright then finds electron itself (the one pinned version in the store) and adds its
  // loader, which turns on Chromium's test switches - the launch the spec calls Playwright's (A2.14 #27). With an
  // executablePath it adds neither, only --inspect=0 and --remote-debugging-port=0.
  const pw = await _electron.launch({
    args: [APP_DIR, ...(opts.args ?? [])],
    env: { ...process.env as Record<string, string>, ...env.env, ...opts.extraEnv },
    timeout: 30_000,
  })
  const control = playwrightControl(pw)
  const proc = pw.process()
  let out = ''
  proc.stdout?.on('data', (c) => { out += c })
  proc.stderr?.on('data', (c) => { out += c })
  const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)))
  await waitReady(control)
  let closing: Promise<number | null> | undefined
  return {
    kind: 'pw', pid: proc.pid ?? -1, env, pw,
    call: (n, a) => control.call(n, a),
    output: () => out,
    close: () => closing ??= (async () => {
      try { await control.call('quit') } catch { /* already gone */ }
      const code = await Promise.race([exited, new Promise<'late'>((r) => setTimeout(() => r('late'), 10_000))])
      if (code === 'late') { proc.kill('SIGKILL'); return null }
      return code
    })(),
  }
}

export async function launchProd(env: TestEnv, opts: { args?: string[]; extraEnv?: Record<string, string> } = {}): Promise<AppRun> {
  checkBuilt()
  const child = spawn(ELECTRON_BIN, [APP_DIR, ...(opts.args ?? [])], {
    env: { ...process.env, ...env.env, MARVER_APP_CONTROL: env.control, ...opts.extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout?.on('data', (c) => { out += c })
  child.stderr?.on('data', (c) => { out += c })
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
  const end = Date.now() + 30_000
  let control: Control | undefined
  while (!control && Date.now() < end && child.exitCode === null) {
    if (existsSync(env.control)) { try { control = await socketControl(env.control) } catch { /* not listening yet */ } }
    if (!control) await new Promise((r) => setTimeout(r, 50))
  }
  if (!control) { child.kill('SIGKILL'); throw new Error(`the app never opened its control socket: ${out.slice(-500)}`) }
  const ctl = control
  await waitReady(ctl)
  let closing: Promise<number | null> | undefined
  return {
    kind: 'prod', pid: child.pid ?? -1, env, child,
    call: (n, a) => ctl.call(n, a),
    output: () => out,
    close: () => closing ??= (async () => {
      try { await ctl.call('quit') } catch { /* already gone */ }
      ctl.close()
      const code = await Promise.race([exited, new Promise<'late'>((r) => setTimeout(() => r('late'), 10_000))])
      if (code === 'late') { child.kill('SIGKILL'); return null }
      return code
    })(),
  }
}

/** The app's `whenReady` work done: the startup journal's `ready` line. */
async function waitReady(control: Control, ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const log = await control.call<{ topic: string; data: { step?: string } }[]>('log')
      if (log.some((l) => l.topic === 'startup' && l.data.step === 'ready')) return
    } catch { /* hooks not up yet */ }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('the app never reached ready')
}
