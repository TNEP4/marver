/**
 * Main's error policy (errors.ts): an error nothing caught is one bounded line in perf/app.jsonl (600), at most 20 a
 * run, and stderr - never a modal box. The listeners themselves are the prod case's (test/prod/errors.test.ts).
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorRecord, MAX_RECORDS, recordError, resetErrorPolicy, setErrorHome } from '../../src/main/errors.ts'

const dirs: string[] = []
afterEach(() => { resetErrorPolicy(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

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
  })
})

describe('recordError', () => {
  it('appends to <home>/perf/app.jsonl with mode 600, says it on stderr, and stops writing after 20 a run', () => {
    const home = mkdtempSync(join(tmpdir(), 'mv-errors-'))
    dirs.push(home)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    setErrorHome({ dir: home, writable: true })
    for (let i = 0; i < MAX_RECORDS + 5; i++) recordError(i % 2 ? 'rejection' : 'exception', new Error(`boom ${i}`))
    const file = join(home, 'perf', 'app.jsonl')
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(MAX_RECORDS)
    expect(lines[0]).toMatchObject({ kind: 'main-error', what: 'exception', message: 'boom 0' })
    expect(lines[1]).toMatchObject({ what: 'rejection', message: 'boom 1' })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(err.mock.calls.length).toBe(MAX_RECORDS + 5)   // stderr hears every one
  })

  it('an unwritable home: stderr alone, and it never throws', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    setErrorHome({ dir: '/nonexistent/never', writable: false })
    expect(() => recordError('exception', new Error('x'))).not.toThrow()
    setErrorHome({ dir: '/dev/null/not-a-dir', writable: true })
    expect(() => recordError('exception', { toString() { throw new Error('unprintable') } })).not.toThrow()
  })
})
