import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { segmentName } from '../src/shared/perf-records.ts'

/**
 * Spec 30 #42: `marver perf`'s app reader against a writer that rotates while it reads. The list of files is made, then
 * they are opened in turn; a rename in between leaves the closed segment under a name the list lacks. Its lines are
 * still read, each once. The report's reader: app/test/unit/r30-store-rotation.test.ts.
 */

const hook = vi.hoisted(() => ({ before: null as ((path: string) => void) | null }))
vi.mock('node:fs', async (actual) => {
  const fs = await actual<typeof import('node:fs')>()
  return { ...fs, readFileSync: ((p: never, o: never) => { hook.before?.(String(p)); return fs.readFileSync(p, o) }) as typeof fs.readFileSync }
})

const T0 = 1_800_000_000_000
const line = (seq: number) => JSON.stringify({ v: 1, ts: T0 + seq, kind: 'dropped', app: 'aaaaaaaaaaaa', seq, flavour: 'release', machine: null, n: 1 }) + '\n'
let home = '', perf = ''
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mv-r30-rotation-')))
  perf = join(home, 'perf')
  mkdirSync(perf, { recursive: true })
})
afterEach(() => { hook.before = null; rmSync(home, { recursive: true, force: true }) })

const closed = (name: string, from: number, to: number) => join(perf, segmentName(name as never, from, to))
const seqs = async () => (await import('../src/cli/perf-app.ts')).readAppLog(home).map((r) => r.seq)

describe('a rotation while `marver perf` reads the app\'s log (#42)', () => {
  it('between the list and the open: the segment it made is read, whole', async () => {
    writeFileSync(closed('app.jsonl', T0, T0 + 1), line(0))
    const live = join(perf, 'app.jsonl')
    writeFileSync(live, line(1) + line(2))
    hook.before = () => {
      hook.before = null
      renameSync(live, closed('app.jsonl', T0 + 1, T0 + 3))
      writeFileSync(live, line(3))
    }
    expect(await seqs()).toEqual([0, 1, 2, 3])
  })

  it('after the live file\'s read: what was read counts once, what came after it counts too', async () => {
    const live = join(perf, 'app.jsonl')
    writeFileSync(live, line(0) + line(1))
    // the samples file is next: by then the live file has grown and closed
    writeFileSync(join(perf, 'samples.jsonl'), '')
    hook.before = (p) => {
      if (!p.endsWith('samples.jsonl')) return
      hook.before = null
      appendFileSync(live, line(2))
      renameSync(live, closed('app.jsonl', T0, T0 + 3))
    }
    expect(await seqs()).toEqual([0, 1, 2])
  })

  it('two in a row: each segment found in its turn (a line written since the last read is the next read\'s)', async () => {
    const live = join(perf, 'app.jsonl')
    writeFileSync(live, line(0))
    let n = 0
    hook.before = () => {
      if (n++ >= 2) return
      renameSync(live, closed('app.jsonl', T0 + n, T0 + n + 1))
      writeFileSync(live, line(n))
    }
    expect(await seqs()).toEqual([0, 1])
  })
})
