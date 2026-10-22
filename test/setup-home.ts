import { homedir } from 'node:os'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { inject } from 'vitest'

/**
 * Every test file runs against the suite's own registry (test/global-setup.ts), never ~/.marver
 * and never the slot ports 4805-4824 - checked here, before the file imports any server code. A
 * vitest that stopped handing the main process's env to its workers fails every file at once,
 * instead of one suite quietly writing into the owner's registry or taking a real canvas's port.
 */
const home = inject('marverHome')
const base = inject('marverSlotBase')
const real = join(homedir(), '.marver')
const within = (p: string, dir: string) => { const r = relative(dir, resolve(p)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }

if (!home || !base) throw new Error('the suite has no registry of its own - test/global-setup.ts did not run')
if (process.env.MARVER_HOME !== home || process.env.MARVER_SLOT_BASE !== base) {
  throw new Error(`MARVER_HOME / MARVER_SLOT_BASE did not reach this worker (${process.env.MARVER_HOME || 'unset'}, ${process.env.MARVER_SLOT_BASE || 'unset'}) - see test/global-setup.ts`)
}
if (within(home, real) || within(real, home)) throw new Error(`MARVER_HOME is ~/.marver (${home}) - the suite must never touch the real registry`)
const n = Number(base)
if (!Number.isInteger(n) || (n + 20 >= 4805 && n + 1 <= 4824)) throw new Error(`MARVER_SLOT_BASE ${base} puts the suite's slots on the real ones (4805-4824)`)
