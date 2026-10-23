/**
 * Main's error policy (errors.ts): an error nothing caught is one bounded `main-error` line through the recorder's
 * writer (perflog.ts: perf/app.jsonl for the release, app-dev.jsonl for Marver Dev, 600, the envelope), at most 20 a
 * run, and stderr - never a modal box. The listeners themselves are the prod case's (test/prod/errors.test.ts).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorBody, errorRecord, MAX_RECORDS, recordError, resetErrorPolicy, setErrorHome } from '../../src/main/errors.ts'
import { flushNow, idle, resetPerflog, startPerflog } from '../../src/main/perflog.ts'
import { parseAppLine } from '../../../src/shared/app-perf.ts'
import type { Config } from '../../src/main/config.ts'

const dirs: string[] = []
afterEach(async () => { resetErrorPolicy(); await idle(); resetPerflog(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const config = { restoreTabs: true, unloadUnderPressure: true, recorder: false, dockBadge: false, keepPerfDays: 14 } as Config

describe('the record', () => {
  it('kind, what, name, message and the first five stack lines, each bounded; a thrown non-Error too', () => {
    const e = new TypeError('Render frame was disposed before WebFrameMain could be accessed')
    const r = JSON.parse(errorRecord('exception', e, 42))
    expect(r).toMatchObject({ v: 1, ts: 42, kind: 'main-error', what: 'exception', name: 'TypeError', message: e.message })
    expect(r.stack.length).toBeGreaterThan(0)
    expect(r.stack.length).toBeLessThanOrEqual(5)
    expect(JSON.parse(errorRecord('rejection', 'just a string', 1))).toMatchObject({ what: 'rejection', name: 'string', message: 'just a string', stack: [] })
    const long = new Error('x'.repeat(10_000))
    long.stack = `Error: x\n${'    at y\n'.repeat(50)}`
    const line = errorRecord('exception', long, 1)
    expect(line.length).toBeLessThanOrEqual(2048)
    expect(JSON.parse(line).message.length).toBe(500)
    expect(JSON.stringify(errorBody('exception', long)).length).toBeLessThan(1848)
  })
})

describe('recordError', () => {
  it('a line in <home>/perf/app-dev.jsonl for Marver Dev (the envelope, mode 600), whatever `recorder` says; stderr hears every one; 20 a run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mv-errors-'))
    dirs.push(home)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    startPerflog({ home: { dir: home, writable: true, state: '', crashpad: '', ms: 0 }, flavour: 'dev', config: () => config, machine: () => '0123456789abcdef' })
    setErrorHome({ dir: home, writable: true })
    for (let i = 0; i < MAX_RECORDS + 5; i++) recordError(i % 2 ? 'rejection' : 'exception', new Error(`boom ${i}`))
    flushNow()
    expect(existsSync(join(home, 'perf', 'app.jsonl'))).toBe(false)
    const file = join(home, 'perf', 'app-dev.jsonl')
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => parseAppLine(l) as unknown as Record<string, unknown>)
    expect(lines).toHaveLength(MAX_RECORDS)
    expect(lines[0]).toMatchObject({ kind: 'main-error', flavour: 'dev', seq: 0, what: 'exception', message: 'boom 0' })
    expect(lines[1]).toMatchObject({ what: 'rejection', message: 'boom 1', seq: 1 })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(err.mock.calls.length).toBe(MAX_RECORDS + 5)
  })

  it('an unwritable home, or no writer: stderr alone, and it never throws', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    setErrorHome({ dir: '/nonexistent/never', writable: false })
    expect(() => recordError('exception', new Error('x'))).not.toThrow()
    setErrorHome({ dir: '/dev/null/not-a-dir', writable: true })
    expect(() => recordError('exception', { toString() { throw new Error('unprintable') } })).not.toThrow()
  })
})
