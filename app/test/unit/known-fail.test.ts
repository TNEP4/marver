/**
 * The build's named known failures (scripts/build.mjs `--known-fail`; Nic, 24 Oct: app 0.2 ships with the no-canvas
 * memory gate failing at its measured value, the limit unchanged): only a check named on the command line and listed
 * in KNOWN_FAILABLE, failing at a measured number, lets a build into out/ - never another check, never an
 * inconclusive gate, never a name that is not listed, never a smoke whose report does not add up.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KNOWN_FAILABLE, judgeSmoke, parseKnownFail } from '../../scripts/build.mjs'
import { finalize, HARNESS_ERROR, MAX_FAIL_STATUS } from '../smoke/report.mjs'

const PASS = (name: string) => ({ verdict: 'PASS', name, detail: '' })
const memFail = (totalMB: number) => ({
  verdict: 'FAIL', name: 'memory-no-canvas',
  detail: `${totalMB} MB footprint, mean of 3 reads 10 s apart: ...; over the 200 MB budget - the limit stays (Nic, 23 Oct): the numbers go to Nic`,
  memory: { totalMB, budgetMB: 200, gpuMB: 80, countGpu: true, samples: [] },
})
const report = (results: { verdict: string; name: string; detail?: string }[]) => ({ failures: results.filter((r) => r.verdict === 'FAIL').length, results, completed: true })

describe('--known-fail', () => {
  it('names only the checks KNOWN_FAILABLE lists: memory-no-canvas, nothing else', () => {
    expect(Object.keys(KNOWN_FAILABLE)).toEqual(['memory-no-canvas'])
    expect(parseKnownFail(['--known-fail=memory-no-canvas'])).toEqual({ names: ['memory-no-canvas'] })
    expect(parseKnownFail([])).toEqual({ names: [] })
    expect(parseKnownFail(['--known-fail=memory-canvas-open'])).toMatchObject({ error: expect.stringContaining('memory-canvas-open') })
    expect(parseKnownFail(['--known-fail=no-crash-dialogs'])).toMatchObject({ error: expect.stringContaining('cannot be a known failure') })
    expect(parseKnownFail(['--known-fail='])).toMatchObject({ error: expect.any(String) })
    expect(parseKnownFail(['--known-fail'])).toMatchObject({ error: expect.any(String) })
  })

  it('a smoke whose one failure is the named one, measured, is let through - loudly, with its number', () => {
    const r = report([PASS('launch-warm'), memFail(214.3), PASS('no-crash-dialogs')])
    const j = judgeSmoke(r, 1, ['memory-no-canvas'])
    expect(j).toMatchObject({ ok: true, known: [{ name: 'memory-no-canvas', measured: 214.3, unit: 'MB', budget: 200 }], other: [] })
    expect(j.known[0]!.line).toMatch(/KNOWN FAILURE memory-no-canvas: 214\.3 MB measured against the 200 MB budget/)
  })

  it('never without the option, never for another check, never an inconclusive gate, never a report that does not add up', () => {
    const r = report([memFail(214.3)])
    expect(judgeSmoke(r, 1, []).ok).toBe(false)
    const other = report([memFail(214.3), { verdict: 'FAIL', name: 'no-crash-dialogs', detail: '1 crash report' }])
    expect(judgeSmoke(other, 2, ['memory-no-canvas'])).toMatchObject({ ok: false, other: ['no-crash-dialogs'] })
    const inconclusive = report([{ verdict: 'FAIL', name: 'memory-no-canvas', detail: 'inconclusive: a footprint could not be read' }])
    expect(judgeSmoke(inconclusive, 1, ['memory-no-canvas'])).toMatchObject({ ok: false, other: ['memory-no-canvas'] })
    // the exit status and the report disagree, or there is no report: never through
    expect(judgeSmoke(r, 2, ['memory-no-canvas']).ok).toBe(false)
    expect(judgeSmoke(null, 1, ['memory-no-canvas']).ok).toBe(false)
  })

  it('the named check passing this time is said too, and the build goes on as any', () => {
    const r = report([PASS('memory-no-canvas')])
    expect(judgeSmoke(r, 0, ['memory-no-canvas'])).toMatchObject({ ok: true, known: [], passed: ['memory-no-canvas'] })
  })
})

describe('a harness error is never a known failure (code review r2 #2)', () => {
  const results = [PASS('launch-warm'), memFail(214.3), PASS('no-crash-dialogs')]

  it('one measured memory-no-canvas failure plus a cleanup that throws: HARNESS_ERROR, the report not completed - refused under --known-fail', () => {
    let written: Record<string, unknown> | null = null
    const end = finalize({ results, base: { app: '/x/Marver.app' }, cleanup: () => { throw new Error('EBUSY: resource busy or locked, rmdir \'/tmp/mv-smoke-x\'') }, write: (r: Record<string, unknown>) => { written = r } })
    expect(end.status).toBe(HARNESS_ERROR)
    expect(written).toMatchObject({ failures: 1, completed: false, harnessErrors: [expect.stringMatching(/^cleanup: Error: EBUSY/)] })
    const j = judgeSmoke(written, end.status, ['memory-no-canvas'])
    expect(j).toMatchObject({ ok: false, why: expect.stringMatching(/did not complete normally.*cleanup: Error: EBUSY/) })
  })

  it('the old smoke\'s way to that: the report written before a cleanup that threw, Node\'s exit 1 matching its one failure - refused, no completion marker', () => {
    // smoke.mjs before: the report with failures 1, then rmSync(RUN) threw and Node exited 1 - judgeSmoke let it through
    const old = { failures: 1, results }
    expect(judgeSmoke(old, 1, ['memory-no-canvas'])).toMatchObject({ ok: false, why: expect.stringContaining('did not complete normally') })
  })

  it('HARNESS_ERROR is refused whatever the report says, and a run that completed is judged as before', () => {
    expect(judgeSmoke(report(results), HARNESS_ERROR, ['memory-no-canvas']).ok).toBe(false)
    let written: unknown = null
    const end = finalize({ results, cleanup: () => {}, write: (r: unknown) => { written = r } })
    expect(end.status).toBe(1)
    expect(written).toMatchObject({ completed: true, failures: 1 })
    expect(judgeSmoke(written, end.status, ['memory-no-canvas'])).toMatchObject({ ok: true, known: [{ name: 'memory-no-canvas', measured: 214.3 }] })
  })

  it('an error met before the end, or a report that cannot be written: HARNESS_ERROR; a failure count never reaches it', () => {
    expect(finalize({ results, harnessErrors: ['a case threw'], write: () => {} }).status).toBe(HARNESS_ERROR)
    expect(finalize({ results, write: () => { throw new Error('ENOSPC') } }).status).toBe(HARNESS_ERROR)
    const many = Array.from({ length: 300 }, (_, i) => ({ verdict: 'FAIL', name: `c${i}`, detail: '' }))
    expect(finalize({ results: many, write: () => {} }).status).toBe(MAX_FAIL_STATUS)
    expect(MAX_FAIL_STATUS).toBeLessThan(HARNESS_ERROR)
  })

  it('a process that throws outside a check, or ends without the smoke\'s own end, exits HARNESS_ERROR - never 1, never 0', () => {
    const mod = JSON.stringify(join(import.meta.dirname, '..', 'smoke', 'report.mjs'))
    const run = (body: string) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { guardProcess, finalize } from ${mod}; let ended = false; ${body}`], { encoding: 'utf8' }).status
    // a throw with the net installed and no end of its own: the exit fallback
    expect(run(`guardProcess(() => {}, () => ended); throw new Error('a case threw')`)).toBe(HARNESS_ERROR)
    // the loop simply empties before the end ran
    expect(run(`guardProcess(() => {}, () => ended); setTimeout(() => {}, 10)`)).toBe(HARNESS_ERROR)
    // the smoke's end: finalize with a cleanup that throws, its status the exit
    expect(run(`guardProcess(() => {}, () => ended); const e = finalize({ results: [{ verdict: 'FAIL', name: 'memory-no-canvas' }], cleanup: () => { throw new Error('EBUSY') }, write: () => {} }); ended = true; process.exit(e.status)`)).toBe(HARNESS_ERROR)
    expect(run(`guardProcess(() => {}, () => ended); const e = finalize({ results: [{ verdict: 'FAIL', name: 'memory-no-canvas' }], write: () => {} }); ended = true; process.exit(e.status)`)).toBe(1)
  })
})
