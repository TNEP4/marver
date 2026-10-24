/**
 * The capture harness's judging (spec 28 A3.8 #36, #37, r1 #10), pure: a transition's bad refreshes and bad interval,
 * the case's p95, and what makes a run inconclusive - never a pass.
 */
import { describe, expect, it } from 'vitest'
import { Palette, blindOf, judgeCase, judgeTransition, type CaptureFrame } from '../harness/capture.ts'

const HZ = 120
const R = 1e9 / HZ
/** frames every refresh from t (ns), each 'g' (good), 'b' (bad), 'i' (idle) or 'x' (a blank sample) */
function frames(t0: number, s: string): CaptureFrame[] {
  return [...s].map((c, i) => ({
    hostNs: String(Math.round(t0 + i * R)),
    status: c === 'i' ? 'idle' : c === 'x' ? 'blank' : 'complete',
    ...(c === 'g' || c === 'b' ? { regions: { r: [c === 'g' ? 'e7e9ef' : 'ff00ff'] } } : {}),
  }))
}
const verdict = (f: CaptureFrame) => f.regions?.r?.[0] === 'e7e9ef' ? 'good' as const : 'bad' as const
const T0 = 1_000_000_000
const judge = (fs: CaptureFrame[], from = T0, to = T0 + 30 * R, extra = {}) =>
  judgeTransition(fs, { t0: BigInt(from), t1: BigInt(Math.round(to)), refreshHz: HZ, verdict, ...extra })

describe('judgeTransition', () => {
  it('counts the bad refreshes from the decision, an idle sample repeating the frame before it', () => {
    // one bad frame before t0 (not counted), then bad, idle (still bad), good
    const v = judge(frames(T0 - R, 'bbiggggggggggggggggggggggggggggg'))
    expect(v).toEqual({ kind: 'pass', n: 2, ms: Math.round((2 * R) / 1e5) / 10 })
  })

  it('ends the bad interval at the first verified good frame after the last bad one (r1 #10), so seven bad refreshes at 120 Hz run past their own span', () => {
    const v = judge(frames(T0, 'bbbbbbbgggggggggggggggggggggggggg'))
    expect(v.kind).toBe('fail')
    if (v.kind !== 'fail') return
    expect(v.n).toBe(7)
    expect(v.ms).toBeCloseTo((7 * R) / 1e6, 0)
  })

  it('an idle sample after a bad frame is bad; a good frame needs to be complete', () => {
    const v = judge(frames(T0, 'biiigggggggggggggggggggggggggggg'))
    expect(v.kind === 'fail' && v.n).toBe(4)
  })

  it('a clean transition passes with n 0', () => {
    expect(judge(frames(T0 - R, 'gggggggggggggggggggggggggggggggggg'))).toEqual({ kind: 'pass', n: 0, ms: 0 })
  })

  it('inconclusive, never passed: a blank sample, a gap, display times past 1.5 refreshes, no frame, a short bad tail with no good frame', () => {
    expect(judge(frames(T0, 'ggxggggggggggggggggggggggggggggg')).kind).toBe('inconclusive')
    const gap = frames(T0, 'gggggggggggggggggggggggggggggggg'); gap[5] = { ...gap[5]!, gap: 1 }
    expect(judge(gap).kind).toBe('inconclusive')
    const late = frames(T0, 'gggggggggggggggggggggggggggggggg').filter((_, i) => i !== 6)
    expect(judge(late)).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('apart') })
    expect(judge([], T0).kind).toBe('inconclusive')
    // two bad refreshes at the very end, nothing after them in the window: missing evidence
    expect(judge(frames(T0, 'ggggbb'), T0, T0 + 6 * R).kind).toBe('inconclusive')
  })

  it('still bad at the end without a gap, past the threshold, is a fail on what was seen', () => {
    const v = judge(frames(T0, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), T0, T0 + 30 * R)
    expect(v.kind).toBe('fail')
  })

  it('an exact case allows no bad refresh', () => {
    expect(judge(frames(T0, 'bgggggggggggggggggggggggggggggggg'), T0, T0 + 30 * R, { maxN: 0 }).kind).toBe('fail')
  })
})

describe('judgeCase', () => {
  it('p95 of n at most 2 and every ms at most 100', () => {
    const pass = Array.from({ length: 40 }, (_, i) => ({ kind: 'pass' as const, n: i === 0 ? 3 : 1, ms: 20 }))
    expect(judgeCase(pass)).toMatchObject({ kind: 'pass', p95n: 1 })
    const slow = [...pass.slice(1), { kind: 'fail' as const, n: 2, ms: 117 }]
    expect(judgeCase(slow).kind).toBe('fail')
    const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'pass' as const, n: i < 4 ? 3 : 0, ms: 30 }))
    expect(judgeCase(many)).toMatchObject({ kind: 'fail', p95n: 3 })
  })

  it('an inconclusive transition left in the case leaves it inconclusive; an exact case needs every n 0', () => {
    expect(judgeCase([{ kind: 'pass', n: 0, ms: 0 }, { kind: 'inconclusive', why: 'gap' }]).kind).toBe('inconclusive')
    expect(judgeCase([{ kind: 'pass', n: 1, ms: 8 }], { exact: true }).kind).toBe('fail')
    expect(judgeCase([]).kind).toBe('inconclusive')
  })
})

describe('Palette', () => {
  it('classifies by the calibrated colours, and colours on the line from ground to dot as ground', () => {
    const p = new Palette(20).add('ground', ['e6e9ee']).add('a', ['ff00fe', '03ff00']).between('ground', '#e7e9ef', '#c9cbd5')
    expect(p.classify('e7e9ef')).toBe('ground')
    expect(p.classify('d8dae2')).toBe('ground')   // half way to the dot
    expect(p.classify('fe01fd')).toBe('a')
    expect(p.classify('ffffff')).toBe('other')
    expect(p.classify('')).toBe('none')
  })
})

describe('blind, never a pass (A3.8 #37)', () => {
  it('reads the helper check: the permission first, then a locked screen, then a sleeping display', () => {
    expect(blindOf('{"access":true,"locked":false,"asleep":false}')).toBeNull()
    expect(blindOf('{"access":false,"locked":false,"asleep":false}')?.why).toBe('permission')
    expect(blindOf('{"access":false,"locked":true,"asleep":true}')?.why).toBe('permission')
    expect(blindOf('{"access":true,"locked":true,"asleep":false}')?.why).toBe('locked')
    expect(blindOf('{"access":true,"locked":false,"asleep":true}')?.why).toBe('asleep')
  })
  it('an old helper line (access only) and an unreadable one', () => {
    expect(blindOf('{"access":true}')).toBeNull()
    expect(blindOf('garbage')?.why).toBe('permission')
  })
  it('a stream of idle frames only is never a pass', () => {
    const fs = frames(0, 'iiiiiiiiii')
    expect(judgeTransition(fs, { t0: BigInt(Math.round(2 * R)), t1: BigInt(Math.round(9 * R)), refreshHz: HZ, verdict: () => 'good' }).kind).toBe('inconclusive')
  })
})
