/**
 * A launch's own world (spec 28 A2.10, A2.14 #23, v1.12 r1 #9): MARVER_HOME, MARVER_APP_USER_DATA and
 * MARVER_SLOT_BASE on temporary folders and the run's own ports, so no case reads or writes ~/.marver, Nic's
 * profiles (~/Library/Application Support/Marver, Marver Dev) or a real canvas's slot. Refuses anything else.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface TestEnv {
  dir: string
  /** MARVER_HOME */
  home: string
  /** MARVER_APP_USER_DATA */
  userData: string
  /** MARVER_SLOT_BASE: slot n is slotBase + n */
  slotBase: number
  /** MARVER_APP_CONTROL: the production-switch harness's socket (a short path: macOS caps them at 104 bytes) */
  control: string
  env: Record<string, string>
  cleanup(): void
}

/** This run's slot base (test/global-setup.ts): twenty fake-canvas slots at base + 1..20, the rest of the block free. */
export function runSlotBase(): number {
  const b = Number(process.env.MVAPP_TEST_SLOT_BASE)
  if (!Number.isInteger(b) || b <= 0) throw new Error('no MVAPP_TEST_SLOT_BASE: test/global-setup.ts did not run')
  return b
}

const within = (p: string, dir: string) => { const r = relative(dir, resolve(p)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }
export const NIC_PROFILES = [join(homedir(), 'Library', 'Application Support', 'Marver'), join(homedir(), 'Library', 'Application Support', 'Marver Dev')]

export function testEnv(slotBase: number, extra: Record<string, string> = {}): TestEnv {
  if (!Number.isInteger(slotBase) || slotBase < 1024 || (slotBase + 20 >= 4805 && slotBase + 1 <= 4824) || (slotBase < 5298 && slotBase + 200 >= 5298)) {
    throw new Error(`slot base ${slotBase} would reach a real canvas's port (4805-4824, 5298)`)
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-')))
  const home = join(dir, 'home')
  const userData = join(dir, 'ud')
  mkdirSync(home, { mode: 0o700 })
  for (const p of [home, userData]) {
    if (within(p, join(homedir(), '.marver')) || NIC_PROFILES.some((n) => within(p, n))) throw new Error(`${p} is one of Nic's folders`)
  }
  const control = join(dir, 'c.sock')
  return {
    dir, home, userData, slotBase, control,
    env: { MARVER_APP_TEST: '1', MARVER_HOME: home, MARVER_APP_USER_DATA: userData, MARVER_SLOT_BASE: String(slotBase), ...extra },
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  }
}

/** A folder's listing and modification times, or 'absent' - to show a run left Nic's profiles as they were. */
export function snapshot(dir: string): string {
  if (!existsSync(dir)) return 'absent'
  return JSON.stringify({ mtime: statSync(dir).mtimeMs, entries: readdirSync(dir).sort().map((n) => { const s = lstatSync(join(dir, n)); return [n, s.mtimeMs, s.size] }) })
}
