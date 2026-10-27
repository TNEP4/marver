import { describe, expect, it } from 'vitest'
import { isApproval } from '../src/shared/approval.ts'
import { sessionBrief } from '../src/server/jam/session-brief.ts'
import { laneLine, runnerLine } from '../src/client/shell/jam-lines.ts'

describe('a More-work note that only approves', () => {
  it('reads as Looks good; anything asking for a change does not', () => {
    for (const t of ['looks good', 'Looks good!', 'LGTM', 'perfect, thanks', 'great', 'ok thanks', '@marver looks good', 'love it', 'nice work'.replace('work', '')]) expect(isApproval(t), t).toBe(true)
    for (const t of ['looks good but make it bigger', 'not good', 'make it blue', 'good start, now the footer', '', 'ok']) expect(isApproval(t), t).toBe(t === 'ok')
  })
})

describe('the brief of a capture sent back', () => {
  it('leads with the newest words; the capture is context', () => {
    const p: any = { batchId: 'b-1', frames: ['d/a'], members: [{ id: 'm1', frames: ['d/a'], brief: { asks: [{ body: '@marver the title smaller' }], capture: { record: { timeline: [{ at: 0, event: 'said', text: 'Redo the intro slide' }] } } } }] }
    const t = sessionBrief(p, 'r-1.1')
    expect(t).toMatch(/more work on d\/a, the owner's newest words: "@marver the title smaller"/)
    expect(t.indexOf('the title smaller')).toBeLessThan(t.indexOf('the capture it follows'))
  })
})

describe('a copy that runs what your session did not take', () => {
  it('says why on the tile and in its detail', () => {
    const c: any = { id: 'c', state: 'working', at: Date.now(), runner: { kind: 'fork', agent: 'claude', why: "your session didn't take it - it was busy or away" } }
    expect(laneLine(c)).toMatch(/^Yours was busy · a copy is on it/)
    expect(runnerLine(c, () => 'Claude Code')!.detail).toMatch(/^Your session didn't take it/)
    expect(laneLine({ ...c, runner: { kind: 'fork', agent: 'claude' } })).toMatch(/^A copy of your session/)
  })
})
