import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { takeBlock } from '../../test/slot-block.ts'

/**
 * Once per project: the dev flavour built (dist/ is gitignored, and a stale one from another branch would let
 * a case pass against code that is not in this commit), and a block of two hundred ports of the run's own -
 * the fake canvases' slots, never the owner's 4805-4824 (test/slot-block.ts, shared with the package's suite).
 */
export default async function setup(project: TestProject) {
  const app = join(import.meta.dirname, '..')
  execFileSync(process.execPath, [join(app, 'scripts', 'build.mjs'), '--js'], { cwd: app, stdio: 'ignore', timeout: 180_000 })
  if (!existsSync(join(app, 'dist', 'main.cjs'))) throw new Error('build.mjs --js produced no dist/main.cjs')
  // one block for the whole run: set before any worker exists, so every project's workers inherit it
  // (test/harness/env.ts `runSlotBase()`); a project's own provide() would not reach the others
  if (!process.env.MVAPP_TEST_SLOT_BASE) {
    const block = await takeBlock()
    process.env.MVAPP_TEST_SLOT_BASE = String(block.base)
    return () => { block.release(); delete process.env.MVAPP_TEST_SLOT_BASE }
  }
  void project
}
