import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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
 */
export default function setup() {
  const root = join(import.meta.dirname, '..')
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore', timeout: 180_000 })
  if (!existsSync(join(root, 'dist', 'cli.mjs'))) {
    throw new Error('build produced no dist/cli.mjs - the gate tests cannot verify anything')
  }
}
