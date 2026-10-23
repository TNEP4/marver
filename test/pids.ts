import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Real processes for the files that name a holder (dev.lock, the slot files): a live pid and a dead one, never
 * fakes - one copy for the 0.27 suites (dev-lock.test.ts keeps its own, as it was). Not a test file: vitest
 * collects only `*.test.ts`.
 */

/** A process alive until killed: its pid. It goes on `children`, which the suite kills after each test. */
export function sleeper(children: ChildProcess[]): number {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(c)
  return c.pid!
}

/** The pid of a process that has already exited. */
export async function deadPid(): Promise<number> {
  const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((r) => c.once('exit', r))
  return c.pid!
}
