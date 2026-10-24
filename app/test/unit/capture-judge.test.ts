/**
 * The capture harness's judging (spec 28 A3.8 #36, #37, r1 #10), pure: a transition's bad refreshes and bad interval,
 * the case's p95, and what makes a run inconclusive - never a pass.
 */
import { describe, expect, it } from 'vitest'
import { MAX_IDLE_RUN, Palette, blindOf, judgeCase, judgeTransition, retried, type CaptureFrame, type FrameVerdict, type TransitionVerdict } from '../harness/capture.ts'

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

  it('still bad at the window\'s end with no good frame after it, past the threshold: inconclusive - how long it lasted is not known (code review r1 #2)', () => {
    const v = judge(frames(T0, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), T0, T0 + 30 * R)
    expect(v).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('no verified good frame') })
  })

  it('an exact case allows no bad refresh', () => {
    expect(judge(frames(T0, 'bgggggggggggggggggggggggggggggggg'), T0, T0 + 30 * R, { maxN: 0 }).kind).toBe('fail')
  })
})

/** a frame `k` refreshes after T0, complete, good or bad, with an optional gap */
const at = (k: number, c: 'g' | 'b', gap?: number): CaptureFrame => ({
  hostNs: String(Math.round(T0 + k * R)), status: 'complete', regions: { r: [c === 'g' ? 'e7e9ef' : 'ff00ff'] }, ...(gap ? { gap } : {}),
})

describe('judgeTransition: the window\'s tail and head are evidence too (A3.8 #36, #37; review of a3-native, blocker)', () => {
  it('six good frames, then nothing until a frame 40 refreshes later carrying gap 34, with the stream still running: inconclusive, never a pass', () => {
    const fs = [...frames(T0 - R, 'ggggggg'), at(40, 'g', 34), at(41, 'g')]
    expect(judge(fs, T0, T0 + 30 * R)).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('gap of 34') })
  })

  it('bad at 1-2, good at 3, then a 36-refresh hole before the window\'s end: inconclusive (the tail was never seen)', () => {
    const fs = [...frames(T0, 'gbbg'), at(40, 'g', 36), at(41, 'g')]
    expect(judge(fs, T0, T0 + 30 * R).kind).toBe('inconclusive')
  })

  it('the same hole with no gap flag is read from the display times', () => {
    const fs = [...frames(T0, 'gggggg'), at(40, 'g'), at(41, 'g')]
    expect(judge(fs, T0, T0 + 30 * R)).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('at the window\'s end') })
  })

  it('no frame yet at or after the window\'s end: inconclusive (its last refreshes unseen)', () => {
    expect(judge(frames(T0, 'gggggggggg'), T0, T0 + 10 * R).kind).toBe('inconclusive')
    expect(judge(frames(T0, 'gggggggggggg'), T0, T0 + 10 * R).kind).toBe('pass')
  })

  it('the head: no frame before the decision and the first one 5 refreshes after it is inconclusive', () => {
    const fs = frames(T0 + 5 * R, 'gggggggggggggggggggggggggggggggg')
    expect(judge(fs, T0, T0 + 30 * R)).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('no frame before the decision') })
  })

  it('a bad interval open at the window\'s end is closed by the first frame after it when that frame is complete and good', () => {
    const v = judge(frames(T0, 'ggggggggbbg'), T0, T0 + 10 * R)
    expect(v).toEqual({ kind: 'pass', n: 2, ms: Math.round((2 * R) / 1e5) / 10 })
    // that frame idle: it repeats the bad one, so no verified good frame
    const idle = frames(T0, 'ggggggggbbi')
    expect(judge(idle, T0, T0 + 10 * R).kind).toBe('inconclusive')
  })

  it('past the threshold on what was seen, with the tail unseen: inconclusive - more bad refreshes may be in it (code review r1 #2)', () => {
    expect(judge(frames(T0, 'gbbbbg'), T0, T0 + 10 * R).kind).toBe('inconclusive')
  })

  it('three bad frames and then the stream stops: inconclusive, never a fail on a lower bound that 39 good transitions pool into a pass (code review r1 #2)', () => {
    const v = judge(frames(T0 - R, 'gggbbb'), T0, T0 + 30 * R)
    expect(v).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('3 bad refreshes') })
    const good = Array.from({ length: 39 }, () => judge(frames(T0 - R, 'g'.repeat(34))))
    expect(good.every((g) => g.kind === 'pass')).toBe(true)
    expect(judgeCase([...good, v]).kind).toBe('inconclusive')
    // three such runs leave the transition unresolved, which fails the case: never a pass
    expect(judgeCase([...good, retried([v, v, v])]).kind).toBe('fail')
  })

  it('a bad interval closed by a verified good frame and already past maxMs fails whatever follows: it can only grow', () => {
    const v = judge(frames(T0, 'gbbbbbbbbbbbbbg'), T0, T0 + 30 * R)   // 13 bad refreshes, about 108 ms, then nothing
    expect(v).toMatchObject({ kind: 'fail', n: 13 })
  })
})

describe('judgeTransition: an idle sample is the held frame judged at its own time, and a long idle run is not evidence (review of a3-native, blocker)', () => {
  /** what may show changes at the decision: the old document (\'o\') is allowed before T0, only ground after it */
  const old = (f: CaptureFrame): FrameVerdict => {
    const x = f.regions?.r?.[0]
    if (x === 'e7e9ef') return 'good'
    if (x === 'aa00aa') return BigInt(f.hostNs) < BigInt(T0) ? 'good' : 'bad'
    return 'bad'
  }
  const oldFrame = (k: number): CaptureFrame => ({ hostNs: String(Math.round(T0 + k * R)), status: 'complete', regions: { r: ['aa00aa'] } })
  const idles = (from: number, n: number): CaptureFrame[] => Array.from({ length: n }, (_, i) => ({ hostNs: String(Math.round(T0 + (from + i) * R)), status: 'idle' as const }))
  const j = (fs: CaptureFrame[], to = T0 + 30 * R, extra = {}) => judgeTransition(fs, { t0: BigInt(T0), t1: BigInt(Math.round(to)), refreshHz: HZ, verdict: old, ...extra })

  it('one complete good frame, then 200 idle samples (the screen locked or the display asleep mid-run): inconclusive, never a pass', () => {
    const fs = [...frames(T0 - R, 'g'), ...idles(0, 200)]
    expect(j(fs)).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('idle samples in a row') })
  })

  it('the old document\'s frame just before the decision (allowed then), held by 11 idle samples after it: never a pass', () => {
    const fs = [oldFrame(-1), ...idles(0, 11), ...frames(T0 + 11 * R, 'gggggggggggggggggggggggg')]
    const v = j(fs)
    expect(v.kind).not.toBe('pass')
    expect(v).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('idle samples in a row') })
  })

  it('a few idle samples holding the old document after the decision are its refreshes, judged then: bad', () => {
    // held 3 refreshes past the decision, then the cover: n 3, past A2.2's 2
    const fs = [oldFrame(-1), ...idles(0, 3), ...frames(T0 + 3 * R, 'ggggggggggggggggggggggggggggggg')]
    expect(j(fs)).toMatchObject({ kind: 'fail', n: 3 })
    // the same held 2 refreshes: n 2, ended by the first complete good frame
    const two = [oldFrame(-1), ...idles(0, 2), ...frames(T0 + 2 * R, 'gggggggggggggggggggggggggggggggg')]
    expect(j(two)).toEqual({ kind: 'pass', n: 2, ms: Math.round((2 * R) / 1e5) / 10 })
  })

  it('exactly MAX_IDLE_RUN idle samples in a row are evidence; one more is not', () => {
    const ok = [...frames(T0 - R, 'g'), ...idles(0, MAX_IDLE_RUN), ...frames(T0 + MAX_IDLE_RUN * R, 'ggggggggggggggggggggggggggggggggg')]
    expect(j(ok)).toEqual({ kind: 'pass', n: 0, ms: 0 })
    const over = [...frames(T0 - R, 'g'), ...idles(0, MAX_IDLE_RUN + 1), ...frames(T0 + (MAX_IDLE_RUN + 1) * R, 'gggggggggggggggggggggggggggggggg')]
    expect(j(over).kind).toBe('inconclusive')
  })

  it('past the threshold on complete frames before a long idle run, the interval open: inconclusive, never a fail on a lower bound (code review r1 #2)', () => {
    const fs = [...frames(T0, 'gbbbb'), ...idles(5, 20), ...frames(T0 + 25 * R, 'gggggggg')]
    expect(j(fs)).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('idle samples in a row') })
    // closed by a verified good frame and already past 100 ms before the run: a fail, the run can only lengthen it
    const long = [...frames(T0, 'gbbbbbbbbbbbbbg'), ...idles(15, 20), ...frames(T0 + 35 * R, 'gggggggg')]
    expect(j(long, T0 + 40 * R)).toMatchObject({ kind: 'fail', n: 13 })
    // closed but short, past the threshold in n only: the run may hide more, so inconclusive
    const short = [...frames(T0, 'gbbbbg'), ...idles(6, 20), ...frames(T0 + 26 * R, 'gggggggg')]
    expect(j(short)).toMatchObject({ kind: 'inconclusive' })
  })

  it('a window with no complete frame of its own is inconclusive, even when its idle samples are good', () => {
    const fs = [...frames(T0 - R, 'g'), ...idles(0, 3), ...frames(T0 + 3 * R, 'g')]
    expect(j(fs, T0 + 3 * R)).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('no complete frame inside') })
  })

  it('a frame with no display time is never evidence, inside the window or at its end (minor #19)', () => {
    const fs = frames(T0 - R, 'gggggggggggggggggggggggggggggggggg')
    fs[6] = { ...fs[6]!, untimed: true }
    expect(j(fs)).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('no display time') })
    const tail = frames(T0 - R, 'gggggggggggg')
    tail[11] = { ...tail[11]!, untimed: true }
    expect(j(tail, T0 + 10 * R)).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('no display time') })
  })

  it('a frame that does not carry what the case reads is never good (minor #10)', () => {
    const fs = frames(T0 - R, 'gggggggggggggggggggggggggggggggggg')
    fs[5] = { hostNs: fs[5]!.hostNs, status: 'complete' }
    const unread = (f: CaptureFrame): FrameVerdict => (f.regions?.r?.length ? old(f) : 'unread')
    expect(judgeTransition(fs, { t0: BigInt(T0), t1: BigInt(Math.round(T0 + 30 * R)), refreshHz: HZ, verdict: unread })).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('does not carry') })
  })
})

describe('retried: three inconclusive runs fail the case (A3.8 #37)', () => {
  const inc = (why: string): TransitionVerdict => ({ kind: 'inconclusive', why })
  it('the first conclusive run is the verdict', () => {
    expect(retried([inc('gap'), { kind: 'pass', n: 0, ms: 0 }])).toEqual({ kind: 'pass', n: 0, ms: 0 })
  })
  it('fewer than three inconclusive runs stay inconclusive; three are unresolved, which fails the case', () => {
    expect(retried([inc('a'), inc('b')]).kind).toBe('inconclusive')
    const u = retried([inc('a'), inc('b'), inc('c')])
    expect(u).toMatchObject({ kind: 'unresolved', why: expect.stringContaining('a; b; c') })
    expect(judgeCase([{ kind: 'pass', n: 0, ms: 0 }, u])).toMatchObject({ kind: 'fail', unresolved: 1, inconclusive: 0 })
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
