/**
 * The capture matrix's judging, pure (spec 28 A3.8 #34-#37; review of a3-native, majors #2-#4, minor #11): the size
 * tag allowed only where a view of the uncovered width draws it, the calibration's clash check, main's decision and
 * the settle read from the journal by time, and the clock control.
 */
import { describe, expect, it } from 'vitest'
import { clockControl, type CaptureFrame } from '../harness/capture.ts'
import { clash, decisionOf, frameVerdict, mode, samplePoint, settleOf, shownAt, sizeTagRect, type Classify, type LogLine, type Rect } from '../capture/matrix-judge.ts'

const GRID = [12, 2] as const
const W = 1280
const classify: Classify = (hex) => hex === 'e7e9ef' || hex === 'c9cbd5' ? 'ground' : hex === '202020' ? 'size' : hex === 'ff0080' || hex === '00c0ff' ? `tag:${hex}` : hex === 'aaaaaa' ? 'band' : 'other'
/** a region of 12 x 2 samples, all ground but sample k */
const one = (k: number, hex: string) => Array.from({ length: 24 }, (_, i) => (i === k ? hex : 'e7e9ef'))
/** a frame with every judged region read, all ground but what `regions` names */
const ground24 = one(-1, '')
const frame = (regions: Record<string, string[]>, judged: readonly string[] = ['strip', 'size@1280', 'size@1160']): CaptureFrame =>
  ({ hostNs: '1', status: 'complete', regions: { ...Object.fromEntries(judged.map((n) => [n, ground24])), ...regions } })

describe('samplePoint: capture.swift\'s grid, cell centres row by row', () => {
  it('maps a sample index to its window point', () => {
    const r: Rect = { x: 100, y: 6, w: 120, h: 32 }
    expect(samplePoint(r, 0, GRID)).toEqual({ x: 105, y: 14 })
    expect(samplePoint(r, 11, GRID)).toEqual({ x: 215, y: 14 })
    expect(samplePoint(r, 12, GRID)).toEqual({ x: 105, y: 30 })
  })
})

describe('frameVerdict: the size tag only where a view of the uncovered width draws it (A3.8 #34, #4, #11)', () => {
  const at = (width: number): Rect => ({ x: width - 260 + 2, y: 16, w: 8, h: 12 })
  const regions = { strip: { x: 300, y: 6, w: 900, h: 32 }, 'size@1280': at(1280), 'size@1160': at(1160) }
  const shown = { tag: 'ff0080', width: 1280 }
  it('the size tag in the region of the current width is good; in the region of an older width it is bad', () => {
    expect(frameVerdict(frame({ 'size@1280': one(3, '202020') }), { regions, grid: GRID, classify, shown })).toBe('good')
    expect(frameVerdict(frame({ 'size@1160': one(3, '202020') }), { regions, grid: GRID, classify, shown })).toBe('bad')
    // after a resize to 1160 the same frame reads the other way round
    const narrow = { tag: 'ff0080', width: 1160 }
    expect(frameVerdict(frame({ 'size@1160': one(3, '202020') }), { regions, grid: GRID, classify, shown: narrow })).toBe('good')
    expect(frameVerdict(frame({ 'size@1280': one(3, '202020') }), { regions, grid: GRID, classify, shown: narrow })).toBe('bad')
  })
  it('in the strip region, a size-tag sample is good only at the current tag\'s x', () => {
    const r = sizeTagRect(1280)
    const strip = regions.strip
    // the sample whose centre falls in [1020, 1032]: x = 300 + 75 * (i + .5) -> i = 9 gives 1012.5, outside; none inside
    const k = [...Array(12).keys()].find((i) => { const p = samplePoint(strip, i, GRID); return p.x >= r.x0 - 1 && p.x <= r.x1 + 1 })
    expect(k).toBeUndefined()
    expect(frameVerdict(frame({ strip: one(9, '202020') }), { regions, grid: GRID, classify, shown })).toBe('bad')
    const wide = { strip: { x: 1020, y: 6, w: 12, h: 32 } }
    expect(frameVerdict(frame({ strip: one(0, '202020') }, ['strip']), { regions: wide, grid: GRID, classify, shown })).toBe('good')
  })
  it('a document\'s own tag and band are good only while it is shown; another\'s tag, white or anything else is bad', () => {
    expect(frameVerdict(frame({ strip: one(5, 'ff0080') }), { regions, grid: GRID, classify, shown })).toBe('good')
    expect(frameVerdict(frame({ strip: one(5, 'aaaaaa') }), { regions, grid: GRID, classify, shown })).toBe('good')
    expect(frameVerdict(frame({ strip: one(5, '00c0ff') }), { regions, grid: GRID, classify, shown })).toBe('bad')
    expect(frameVerdict(frame({ strip: one(5, 'ffffff') }), { regions, grid: GRID, classify, shown })).toBe('bad')
    expect(frameVerdict(frame({ strip: one(5, 'ff0080') }), { regions, grid: GRID, classify, shown: null })).toBe('bad')
    expect(frameVerdict(frame({ strip: one(5, 'aaaaaa') }), { regions, grid: GRID, classify, shown: null })).toBe('bad')
    expect(frameVerdict(frame({ strip: one(5, '') }), { regions, grid: GRID, classify, shown: null })).toBe('good')
  })
  it('a frame missing a judged region, or with none of its samples read, is unread - never good (review of a3-native, minor #10)', () => {
    const f = frame({})
    delete f.regions!['size@1160']
    expect(frameVerdict(f, { regions, grid: GRID, classify, shown })).toBe('unread')
    expect(frameVerdict(frame({ strip: Array(24).fill('') }), { regions, grid: GRID, classify, shown })).toBe('unread')
    expect(frameVerdict({ hostNs: '1', status: 'complete' }, { regions, grid: GRID, classify, shown })).toBe('unread')
  })
})

describe('calibration', () => {
  it('two classes within the tolerance clash; one class\'s own colours never do', () => {
    expect(clash([{ name: 'ground', hex: 'e7e9ef' }, { name: 'ground', hex: 'e6e8ee' }, { name: 'tag:ff0080', hex: 'fe0281' }], 30)).toBeNull()
    expect(clash([{ name: 'ground', hex: 'e7e9ef' }, { name: 'size', hex: 'd0d2d8' }], 30)).toMatch(/ground .* and size .* 23 apart/)
  })
  it('a region\'s colour is its most common sample', () => {
    expect(mode(['ff0080', 'ff0080', 'e01070', ''])).toBe('ff0080')
    expect(mode([''])).toBeNull()
  })
})

const L = (t: number, topic: string, data: Record<string, unknown>): LogLine => ({ topic, t: String(t), data })
const MS = 1_000_000

describe('the journal, read by time (A3.8 #35; review of a3-native, major #4)', () => {
  it('the decision is the first compose at or after the action that makes the target active - not an earlier one', () => {
    const lines = [L(90 * MS, 'compose', { active: 'tA' }), L(110 * MS, 'compose', { active: 'tB' }), L(120 * MS, 'compose', { active: 'tA' })]
    expect(decisionOf(lines, 100n * BigInt(MS), 'tA')).toBe(120n * BigInt(MS))
    expect(decisionOf(lines, 130n * BigInt(MS), 'tA')).toBeNull()
  })

  it('settles once quiet with the target active; a see-through target needs its uncover; segments covered, then the document at the uncovered width', () => {
    const t0 = 100n * BigInt(MS)
    const lines = [
      L(100 * MS, 'compose', { active: 'tA', w: 1280, cover: { visible: true } }),
      L(300 * MS, 'present', { op: 'answer', tab: 'tA' }),
      L(310 * MS, 'compose', { active: 'tA', w: 1280, cover: { visible: false } }),
      L(310 * MS, 'present', { op: 'uncover', tab: 'tA' }),
    ]
    const o = { t0, target: 'tA', seeThrough: true, quietNs: 150n * BigInt(MS), tagAt: () => 'ff0080' }
    expect(settleOf(lines, { ...o, now: 400n * BigInt(MS) })).toBeNull()   // not yet quiet
    const s = settleOf(lines, { ...o, now: 500n * BigInt(MS) })!
    expect(s.at).toBe(310n * BigInt(MS))
    expect(s.segments).toEqual([{ from: t0, shown: null }, { from: 310n * BigInt(MS), shown: { tag: 'ff0080', width: 1280 } }])
    expect(shownAt(s.segments, 200n * BigInt(MS))).toBeNull()
    expect(shownAt(s.segments, 320n * BigInt(MS))).toEqual({ tag: 'ff0080', width: 1280 })
    // no uncover: a see-through target has not settled; a covered one has
    const covered = lines.slice(0, 1)
    expect(settleOf(covered, { ...o, now: 500n * BigInt(MS) })).toBeNull()
    expect(settleOf(covered, { ...o, seeThrough: false, now: 500n * BigInt(MS) })).toMatchObject({ at: t0, uncovered: false })
  })

  it('covered again by a later compose; and an uncover of no qualifying document allows nothing', () => {
    const t0 = 0n
    const lines = [
      L(0, 'compose', { active: 'tA', w: 1160, cover: { visible: true } }),
      L(50 * MS, 'present', { op: 'uncover', tab: 'tA' }),
      L(60 * MS, 'compose', { active: 'tA', w: 1160, cover: { visible: true } }),
      L(90 * MS, 'present', { op: 'uncover', tab: 'tA' }),
    ]
    const s = settleOf(lines, { t0, target: 'tA', seeThrough: true, now: 400n * BigInt(MS), quietNs: 150n * BigInt(MS), tagAt: (t) => (t > 80n * BigInt(MS) ? 'ff0080' : null) })!
    expect(s.segments.map((g) => [Number(g.from / BigInt(MS)), g.shown?.tag ?? null, g.shown?.width ?? null])).toEqual([[0, null, null], [50, null, null], [90, 'ff0080', 1160]])
  })
})

describe('the clock control (A3.8 #36; review of a3-native, minor #16)', () => {
  const R = 1e9 / 120
  /** a frame every refresh from 0; the marker on in [a, b) refreshes */
  const run = (on: [number, number][], n = 120): CaptureFrame[] => Array.from({ length: n }, (_, i) => ({ hostNs: String(Math.round(i * R)), status: 'complete' as const, regions: { marker: [on.some(([a, b]) => i >= a && i < b) ? 'ff0000' : '808080'] } }))
  const isOn = (f: CaptureFrame) => f.regions?.marker?.[0] === 'ff0000'
  const ns = (k: number) => BigInt(Math.round(k * R))
  it('every change on the screen 0 to 3 refreshes after main made it: ok, with each lag', () => {
    const c = clockControl(run([[11, 31], [51, 71]]), [{ ns: ns(10), on: true }, { ns: ns(30), on: false }, { ns: ns(50), on: true }, { ns: ns(70), on: false }], 120, isOn)
    expect(c).toEqual({ ok: true, lags: [1, 1, 1, 1] })
  })
  it('a change shown before main made it (a wrong base), or more than 3 refreshes late, or never: not ok', () => {
    expect(clockControl(run([[5, 31]]), [{ ns: ns(10), on: true }], 120, isOn)).toMatchObject({ ok: false, why: expect.stringContaining('before main made it') })
    expect(clockControl(run([[15, 31]]), [{ ns: ns(10), on: true }], 120, isOn)).toMatchObject({ ok: false, why: expect.stringContaining('5.0 refreshes') })
    expect(clockControl(run([]), [{ ns: ns(10), on: true }], 120, isOn)).toMatchObject({ ok: false, why: expect.stringContaining('never') })
  })
  it('a stream that skipped refreshes between the change and its first frame checks nothing: inconclusive, never ok', () => {
    const holed = run([[11, 31]]).filter((_, i) => i < 9 || i > 20)
    expect(clockControl(holed, [{ ns: ns(10), on: true }], 120, isOn)).toMatchObject({ ok: false, inconclusive: true, lags: [null] })
  })
  it('with minMeasured (a display stream): a change on a hole is skipped, enough clean ones are ok, too few are inconclusive, a late one still fails', () => {
    const marks = [{ ns: ns(10), on: true }, { ns: ns(30), on: false }, { ns: ns(50), on: true }, { ns: ns(70), on: false }]
    // the frames around change 1 missing
    const holed = run([[11, 31], [51, 71]]).filter((_, i) => i < 28 || i > 33)
    expect(clockControl(holed, marks, 120, isOn, { minMeasured: 3 })).toEqual({ ok: true, lags: [1, null, 1, 1] })
    expect(clockControl(holed, marks, 120, isOn, { minMeasured: 4 })).toMatchObject({ ok: false, inconclusive: true, why: expect.stringContaining('only 3 of 4') })
    // change 2 five refreshes late: a fail whatever the holes
    const late = run([[11, 31], [55, 71]]).filter((_, i) => i < 28 || i > 33)
    expect(clockControl(late, marks, 120, isOn, { minMeasured: 2 })).toMatchObject({ ok: false, why: expect.stringContaining('5.0 refreshes') })
  })
})
