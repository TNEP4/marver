import { describe, expect, it } from 'vitest'
import { decodeCmds, encodeCmds, PAGE_KINDS, parseSegmentName, segmentName, SEGMENTS, type SegmentedFile } from '../src/shared/perf-records.ts'
import { KINDS } from '../src/client/shell/recorder-core.ts'
import { DROP_REASONS, PAGE_KINDS as SERVER_KINDS } from '../src/server/perf.ts'
import { COMMANDS, type CmdName } from '../src/client/shell/commands.ts'

/**
 * Spec 30's contracts, frozen before its streams split: the pure helpers both sides of a contract call (the
 * `x-mv-cmds` header, a segment's name), one list of page kinds for the page and the server, and the command
 * vocabulary's declared shape (R12's lifecycle note and its silence note).
 */

const A = 'aaaaaaaaaaaa', B = 'bbbbbbbbbbbb'

describe('x-mv-cmds (#18)', () => {
  it('round-trips at most 8 ids and their count', () => {
    expect(encodeCmds({ ids: [], n: 0 })).toBe('')
    expect(decodeCmds('')).toEqual({ ids: [], n: 0 })
    expect(decodeCmds(encodeCmds({ ids: [A, B], n: 2 }))).toEqual({ ids: [A, B], n: 2 })
    const ten = Array.from({ length: 10 }, (_, i) => i.toString(16).repeat(12))
    expect(encodeCmds({ ids: ten, n: 10 })).toBe(`${ten.slice(0, 8).join(',')};n=10`)
    expect(decodeCmds(encodeCmds({ ids: ten, n: 10 }))).toEqual({ ids: ten.slice(0, 8), n: 10 })
  })
  it('never passes free text as an id', () => {
    expect(encodeCmds({ ids: ['not an id', A], n: 2 })).toBe(`${A};n=2`)
    for (const bad of ['x', `${A},`, `${A};n=`, `${A};n=0`, `${A.toUpperCase()}`, Array(9).fill(A).join(','), 42, null]) expect(decodeCmds(bad)).toBe(null)
  })
})

describe('segment names (#42)', () => {
  it('carry openedAt and the conservative bound, and name only their own file', () => {
    for (const file of Object.keys(SEGMENTS) as SegmentedFile[]) {
      const name = segmentName(file, 1_730_700_000_000, 1_730_786_400_000)
      expect(parseSegmentName(file, name)).toEqual({ openedAt: 1_730_700_000_000, bound: 1_730_786_400_000 })
      expect(parseSegmentName(file, file)).toBe(null)   // the live file
    }
    expect(segmentName('page.jsonl', 1, 2)).toBe('page.1-2.jsonl')
    expect(parseSegmentName('app.jsonl', segmentName('app-dev.jsonl', 1_730_700_000_000, 1_730_700_000_001))).toBe(null)
    expect(parseSegmentName('samples.jsonl', segmentName('samples-dev.jsonl', 1_730_700_000_000, 1_730_700_000_001))).toBe(null)
  })
})

describe('one list of page kinds', () => {
  it('the page records and the server cleans the same kinds, 0.29\'s first', () => {
    expect(KINDS).toBe(PAGE_KINDS)
    expect(SERVER_KINDS).toBe(PAGE_KINDS)
    expect(PAGE_KINDS.slice(0, 11)).toEqual(['load', 'commit', 'visible', 'frame', 'move', 'quiet', 'settled', 'cut', 'gesture', 'error', 'dropped'])
    expect(DROP_REASONS[0]).toBe('errors')
  })
})

describe('the command vocabulary (R12)', () => {
  const names = Object.keys(COMMANDS) as CmdName[]
  it('`once` only for what is decided in the input\'s own turn', () => {
    expect(names.filter((n) => COMMANDS[n].life === 'once').sort()).toEqual(['mention-dismiss', 'mention-pick'])
  })
  it('silence covers only the three incidental inputs', () => {
    expect(names.filter((n) => 'silent' in COMMANDS[n]).sort()).toEqual(['deselect', 'jam-close', 'thread-close'])
  })
  it('every deadline is 10 s or longer, and the long ones are the table\'s', () => {
    for (const n of names) expect(COMMANDS[n].deadlineMs, n).toBeGreaterThanOrEqual(10_000)
    expect(names.filter((n) => COMMANDS[n].deadlineMs === 120_000).sort()).toEqual(['board-open', 'history-nav', 'jam-voice'])
    expect(COMMANDS['copy-image'].deadlineMs).toBe(60_000)
  })
})
