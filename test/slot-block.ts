import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { portInUse, takeExclusive } from '../src/server/exclusive.ts'

/**
 * A block of ports of a test run's own (spec 28 A1.10), shared by the package's suite (test/global-setup.ts)
 * and the Mac app's (app/test/global-setup.ts, its packaged smoke).
 *
 * A registry of its own isolates the files and not the machine's ports: two worktrees running a suite at once
 * would each see the other's canvases as "another program" on its slots, and every suite that asserts an exact
 * port would fail. Each run takes two hundred ports in 40000-46999 - clear of the owner's slots (4805-4824),
 * of the ports the browser suites and the free-port probes use (4400-8300, 47000-49000) and below macOS's
 * ephemeral range (49152+) - checked free when taken and held, while the run lasts, by a lock in the temp
 * folder (the exclusive-file rules: a block whose run was killed is taken back).
 */
export const BLOCKS = { from: 40_000, to: 47_000, size: 200 }

export async function takeBlock(): Promise<{ base: number; release: () => void }> {
  const dir = join(tmpdir(), 'marver-test-ports')
  mkdirSync(dir, { recursive: true })
  const count = (BLOCKS.to - BLOCKS.from) / BLOCKS.size
  const first = Math.floor(Math.random() * count)
  for (let k = 0; k < count; k++) {
    const base = BLOCKS.from + ((first + k) % count) * BLOCKS.size
    const me = { pid: process.pid, instance: randomUUID(), at: Date.now() }
    const lock = await takeExclusive(join(dir, `${base}.lock`), me, JSON.stringify(me), { reclaimWaitMs: 100 })
    if (!lock.ok) continue   // another run's
    let busy = false
    for (let p = base + 1; p <= base + BLOCKS.size && !busy; p++) busy = await portInUse(p)
    if (!busy) return { base, release: lock.release }
    lock.release()   // something else on this machine listens in it
  }
  throw new Error(`no free block of ${BLOCKS.size} ports in ${BLOCKS.from}-${BLOCKS.to - 1} for the suite's slots`)
}
