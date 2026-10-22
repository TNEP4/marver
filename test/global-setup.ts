import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'

/**
 * Build the CLI once, before any suite runs.
 *
 * Two suites spawn a real server from dist/cli.mjs, and both used to build it
 * in their own beforeAll. Vitest runs files in parallel, so those builds
 * overlapped: one suite read the CLI while the other was part-way through
 * rewriting it, and the result was a whole suite skipping with no failure to
 * read. A flake that reports as "skipped" is worse than one that reports as
 * failed, because a green run hides it.
 *
 * Unconditional, because dist/ is gitignored and a stale build from another
 * branch would let the gate tests pass against code that is not in this commit
 * - which is the one thing those tests exist to prevent.
 *
 * And a registry of its own (0.27, spec 28 A1.10). `marver dev` records every
 * running canvas in ~/.marver/running/ and each project's slot in
 * ~/.marver/prefer/, and listens on the slot ports 4805-4824 - on the machine
 * the suite runs on, beside the owner's real canvases. No test may touch them:
 * every server a test starts, in a worker or as its child, reads MARVER_HOME (a
 * temporary folder) and MARVER_SLOT_BASE (the twenty slots moved to
 * 48805-48824, below macOS's ephemeral range). Set here in the main process
 * before any worker exists - each worker starts with a copy of this env, and a
 * test's children inherit the worker's - and provided as well, so
 * test/setup-home.ts can check that they arrived instead of trusting it.
 */
const SUITE_SLOT_BASE = '48804'

export default function setup(project: TestProject) {
  const root = join(import.meta.dirname, '..')
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore', timeout: 180_000 })
  if (!existsSync(join(root, 'dist', 'cli.mjs'))) {
    throw new Error('build produced no dist/cli.mjs - the gate tests cannot verify anything')
  }
  // after the build, so a failed build leaves nothing behind; realpath, so paths read back from the
  // registry compare equal
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mv-home-')))
  process.env.MARVER_HOME = home
  process.env.MARVER_SLOT_BASE = SUITE_SLOT_BASE
  project.provide('marverHome', home)
  project.provide('marverSlotBase', SUITE_SLOT_BASE)
  return () => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

declare module 'vitest' {
  export interface ProvidedContext { marverHome: string; marverSlotBase: string }
}
