/**
 * The budgets' launches (spec 28 A3.8 #47): every one on temporary `MARVER_HOME`, `MARVER_SLOT_BASE` and
 * `MARVER_APP_USER_DATA`, with the production switches (never Playwright's loader, which changes backgrounding, paint
 * holding and `beforeunload`), and Chromium's mock keychain so no launch touches the login keychain (as the packaged
 * smoke does). **A narrowing, stated** (A3.8 #50): with the mock keychain a launch never does the real "<name> Safe
 * Storage" read, which #50's "one first launch makes the keychain item" counts on. A real-keychain launch of a bundle
 * named Marver would read, or make, "Marver Safe Storage" in the login keychain - the item of the person's own app on
 * that Mac - and a separate default keychain can only be set for the whole user. So `realKeychain` exists for a Mac
 * set up for acceptance (no Marver of the person's own on it), never by default. Two kinds:
 *
 * - `--app <Marver.app>`: the signed bundle's own binary, spawned directly, no test hook - the acceptance run, last,
 *   on the signed build. It is driven with keypost (⌘1-⌘3, ⇧⌘W), which needs Accessibility;
 * - otherwise the dev build (`app/dist`, the pinned Electron) - with `drive: true` in test mode with its control
 *   socket (production switches still: no Playwright), so a case can switch tabs and read roles without keys.
 *
 * Never a real canvas's port (4805-4824, 5298: the slot block is the suites' own), never ~/.marver, never Nic's
 * profiles, never a process this did not start.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { takeBlock } from '../../../test/slot-block.ts'
import { APP_DIR, ELECTRON_BIN } from '../harness/app.ts'
import { socketControl, type Control } from '../harness/control.ts'

export interface World { dir: string; home: string; ud: string; slotBase: number; control: string; release(): void }

/** A temporary world: home, profile, control socket, and a block of ports of its own. */
export async function world(): Promise<World> {
  const block = await takeBlock()
  if (block.base + 20 >= 4805 && block.base + 1 <= 4824) throw new Error('the slot block would reach a real canvas')
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mvbudget-')))
  const home = join(dir, 'home')
  mkdirSync(join(home, 'state'), { recursive: true, mode: 0o700 })
  return { dir, home, ud: join(dir, 'ud'), slotBase: block.base, control: join(dir, 'c.sock'), release: () => { block.release(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } }
}

export interface Launch {
  pid: number
  t0: number
  /** process.hrtime.bigint() at spawn: the capture helper's clock */
  spawnNs: bigint
  child: ChildProcess
  out(): string
  alive(): boolean
  control?: Control
  call<T = unknown>(name: string, args?: unknown): Promise<T>
  stop(): Promise<void>
}

export const MOCK_KEYCHAIN = '--use-mock-keychain'

export async function launch(w: World, o: { app?: string; drive?: boolean; env?: Record<string, string>; realKeychain?: boolean } = {}): Promise<Launch> {
  const bin = o.app ? join(o.app, 'Contents', 'MacOS', 'Marver') : ELECTRON_BIN
  if (o.app && !existsSync(bin)) throw new Error(`no binary at ${bin}`)
  if (o.app && o.drive) throw new Error('the signed build has no test hook: it is driven with keypost')
  if (!o.app && !existsSync(join(APP_DIR, 'dist', 'main.cjs'))) throw new Error('no dist/main.cjs: node scripts/build.mjs --js')
  const args = [...(o.app ? [] : [APP_DIR]), ...(o.realKeychain ? [] : [MOCK_KEYCHAIN])]
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    MARVER_HOME: w.home, MARVER_APP_USER_DATA: w.ud, MARVER_SLOT_BASE: String(w.slotBase),
    ...(o.drive ? { MARVER_APP_TEST: '1', MARVER_APP_CONTROL: w.control } : {}),
    ...o.env,
  }
  if (!o.drive) delete env.MARVER_APP_TEST
  const spawnNs = process.hrtime.bigint()
  const t0 = Date.now()
  const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let out = ''
  child.stdout?.on('data', (c) => { out += c })
  child.stderr?.on('data', (c) => { out += c })
  let code: number | null | undefined
  const exited = new Promise<void>((r) => child.on('exit', (c) => { code = c; r() }))
  let control: Control | undefined
  if (o.drive) {
    const end = Date.now() + 30_000
    while (!control && Date.now() < end && code === undefined) {
      if (existsSync(w.control)) { try { control = await socketControl(w.control) } catch { /* not yet */ } }
      if (!control) await new Promise((r) => setTimeout(r, 50))
    }
    if (!control) { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } throw new Error(`no control socket: ${out.slice(-400)}`) }
    const end2 = Date.now() + 20_000
    for (;;) {
      const log = await control.call<{ topic: string; data: { step?: string } }[]>('log').catch(() => [])
      if (log.some((l) => l.topic === 'startup' && l.data.step === 'ready')) break
      if (Date.now() > end2) throw new Error('the app never reached ready')
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  return {
    pid: child.pid!, t0, spawnNs, child, out: () => out, alive: () => code === undefined, control,
    call: (n, a) => { if (!control) throw new Error('not driven'); return control.call(n, a) },
    async stop() {
      if (code !== undefined) return
      // a page that never reported would hold the quit with a sheet: confirm it in a test build
      // (3 s at most: a main that no longer answers must not hold the run, nor its report, forever)
      if (control) await Promise.race([control.call('sheet', { mode: 'confirm' }).catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
      try { process.kill(child.pid!, 'SIGTERM') } catch { /* gone */ }
      const done = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))])
      if (!done) { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } await exited }
      control?.close()
    },
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const mb = (x: number) => Math.round(x * 10) / 10
