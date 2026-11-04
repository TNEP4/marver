/**
 * Spec 30 #42: the performance report against a writer that rotates while it reads. The list of files is made, then they
 * are opened in turn; a rename in between leaves the closed segment under a name the list lacks. Its lines still count,
 * each once: PerfReport's counts are the proof, the fold keeps no identity of its own.
 */
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { segmentName, type SegmentedFile } from '../../../src/shared/perf-records.ts'
import { buildReport, type ReportInput } from '../../src/main/report.ts'

const hook = vi.hoisted(() => ({ before: null as ((path: string) => void) | null }))
vi.mock('node:fs/promises', async (actual) => {
  const fs = await actual<typeof import('node:fs/promises')>()
  return { ...fs, open: ((p: never, ...a: never[]) => { hook.before?.(String(p)); return (fs.open as (...x: unknown[]) => unknown)(p, ...a) }) as typeof fs.open }
})

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const T0 = NOW - 3_600_000
const line = (seq: number) => JSON.stringify({ v: 1, ts: T0 + seq, kind: 'dropped', app: 'a1b2c3d4e5f6', seq, flavour: 'release', machine: null, n: 1 }) + '\n'
let dir = '', perf = ''
const input = (): ReportInput => ({ perfDir: perf, flavour: 'release', now: NOW, keepPerfDays: 14, version: '1.0.1', electron: '45.0.0', macos: '26.0' })
const closed = (name: SegmentedFile, from: number, to: number) => join(perf, segmentName(name, from, to))
/** The `dropped` lines the report saw, each line once or not. */
const counted = async () => (await buildReport(input())).report.events.counts.dropped

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-r30-rotation-')))
  perf = join(dir, 'perf')
  mkdirSync(perf, { recursive: true })
})
afterEach(() => { hook.before = null; rmSync(dir, { recursive: true, force: true }) })

describe('a rotation while the report reads (#42)', () => {
  it('between the list and the open: the segment it made is read, whole', async () => {
    writeFileSync(closed('app.jsonl', T0, T0 + 1), line(0))
    const live = join(perf, 'app.jsonl')
    writeFileSync(live, line(1) + line(2))
    hook.before = () => {
      hook.before = null
      renameSync(live, closed('app.jsonl', T0 + 1, T0 + 3))
      writeFileSync(live, line(3))
    }
    expect(await counted()).toBe(4)
  })

  it('after the live file\'s read: what was read counts once, what came after it counts too', async () => {
    const live = join(perf, 'app.jsonl')
    writeFileSync(live, line(0) + line(1))
    writeFileSync(join(perf, 'samples.jsonl'), '')
    hook.before = (p) => {
      if (!p.endsWith('samples.jsonl')) return
      hook.before = null
      appendFileSync(live, line(2))
      renameSync(live, closed('app.jsonl', T0, T0 + 3))
    }
    expect(await counted()).toBe(3)
  })

  it('no rotation: each file once, as ever', async () => {
    writeFileSync(closed('app.jsonl', T0, T0 + 1), line(0))
    writeFileSync(join(perf, 'app.jsonl'), line(1))
    expect(await counted()).toBe(2)
  })
})
