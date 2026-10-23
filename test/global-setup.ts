import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { takeBlock } from './slot-block.ts'

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
 * temporary folder) and MARVER_SLOT_BASE (the twenty slots moved into this
 * run's own block of ports, below). Set here in the main process before any
 * worker exists - each worker starts with a copy of this env, and a test's
 * children inherit the worker's - and provided as well, so test/setup-home.ts
 * can check that they arrived instead of trusting it.
 *
 * A block of ports of its own, because a registry of its own isolates the files
 * and not the machine's ports: two worktrees running the suite at once would
 * each see the other's canvases as "another program" on its slots, and every
 * suite that asserts an exact port would fail. Each run takes two hundred ports
 * (test/slot-block.ts, shared with the Mac app's suite). The suite's slots are its
 * first twenty; the suites that assert exact ports each have twenty more (SUITES;
 * room for nine).
 */
/** Each suite that asserts exact ports: its twenty, after the suite's own. */
const SUITES = ['startup', 'slots', 'slotsDev', 'recover'] as const

export default async function setup(project: TestProject) {
  const root = join(import.meta.dirname, '..')
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore', timeout: 180_000 })
  if (!existsSync(join(root, 'dist', 'cli.mjs'))) {
    throw new Error('build produced no dist/cli.mjs - the gate tests cannot verify anything')
  }
  // after the build, so a failed build leaves nothing behind; realpath, so paths read back from the
  // registry compare equal
  const block = await takeBlock()
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mv-home-')))
  process.env.MARVER_HOME = home
  process.env.MARVER_SLOT_BASE = String(block.base)
  project.provide('marverHome', home)
  project.provide('marverSlotBase', String(block.base))
  project.provide('marverSlotBases', Object.fromEntries(SUITES.map((s, i) => [s, block.base + 20 * (i + 1)])) as Record<typeof SUITES[number], number>)
  return () => {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    block.release()
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    marverHome: string
    marverSlotBase: string
    /** the slot base of each suite that asserts exact ports - twenty ports each, in this run's block */
    marverSlotBases: Record<typeof SUITES[number], number>
  }
}
