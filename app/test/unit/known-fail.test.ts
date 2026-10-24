/**
 * The build's named known failures (scripts/build.mjs `--known-fail`; Nic, 24 Oct: app 0.2 ships with the no-canvas
 * memory gate failing at its measured value, the limit unchanged): only a check named on the command line and listed
 * in KNOWN_FAILABLE, failing at a measured number, lets a build into out/ - never another check, never an
 * inconclusive gate, never a name that is not listed, never a smoke whose report does not add up.
 */
import { describe, expect, it } from 'vitest'
import { KNOWN_FAILABLE, judgeSmoke, parseKnownFail } from '../../scripts/build.mjs'

const PASS = (name: string) => ({ verdict: 'PASS', name, detail: '' })
const memFail = (totalMB: number) => ({
  verdict: 'FAIL', name: 'memory-no-canvas',
  detail: `${totalMB} MB footprint, mean of 3 reads 10 s apart: ...; over the 200 MB budget - the limit stays (Nic, 23 Oct): the numbers go to Nic`,
  memory: { totalMB, budgetMB: 200, gpuMB: 80, countGpu: true, samples: [] },
})
const report = (results: { verdict: string; name: string; detail?: string }[]) => ({ failures: results.filter((r) => r.verdict === 'FAIL').length, results })

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
