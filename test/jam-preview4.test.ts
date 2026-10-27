import { describe, expect, it } from 'vitest'
import { isApproval } from '../src/shared/approval.ts'
import { sessionBrief } from '../src/server/jam/session-brief.ts'
import { laneLine, runnerLine } from '../src/client/shell/jam-lines.ts'
import { finalWait, FINAL_MAX, FINAL_MS, wordsWhole } from '../src/client/shell/jam-voice-wait.ts'

describe('a More-work note that only approves', () => {
  it('is one phrase of the list, whole - its case, trailing punctuation and approving emoji aside', () => {
    for (const t of ['looks good', 'Looks good!', 'LGTM', 'looks good to me.', 'Perfect', 'great job', 'nice work', 'love it', 'Thanks!', 'thank you',
      'looks good thanks', 'Looks good, thanks!', 'approved', 'good', '👍', '👍🏽', '👌', '✅', 'looks good 👍', '  looks   good  '])
      expect(isApproval(t), t).toBe(true)
  })
  it('anything more goes to the agent: an extra word, a question, another script, a digit, an answer to a question', () => {
    for (const t of ['looks good but make it bigger', 'Looks good, look again', 'looks good, now the footer', 'looks good?', 'is it done?', 'not good',
      'great, now this', 'Looks good, 改成蓝色', 'perfect 🔵', 'looks good +10%', 'looks good 2', '@marver looks good', 'yes', 'ok', 'sure', 'yes, thanks',
      'yes please', 'ok thanks', '', '   ', '!!!'])
      expect(isApproval(t), t).toBe(false)
  })
})

describe('the brief of a run (jam next)', () => {
  const capture = (asks: { id: string; body: string }[], timeline: unknown[], added?: { at: number; text: string }[]): any =>
    ({ batchId: 'b-1', frames: ['d/a'], members: [{ id: 'm1', kind: 'capture', frames: ['d/a'], brief: { asks, history: [], capture: { record: { timeline }, ...(added ? { added } : {}) } } }] })
  const LABELS = /done before|not run yet|run failed|only asked|not done|do it too|kept - not an ask/

  it('lists the owner\'s words newest first, each by its kind, and never labels what became of them', () => {
    const t = sessionBrief(capture([{ id: 'e-1', body: '@marver use the brand blue' }, { id: 'mw-cap-1-4', body: '@marver the title smaller' }],
      [{ at: 0, event: 'words', text: 'Redo the intro slide' }], [{ at: 9, text: 'keep the icon' }]), 'r-1.1')
    expect(t).toContain(`- on d/a, the owner's words, newest first:
  a More-work note: "the title smaller"
  a tag: "use the brand blue"
  a read-back note: "keep the icon"
  the capture: "Redo the intro slide"`)
    expect(t).not.toMatch(LABELS)
    expect(t).toContain('and what earlier runs did: ')
  })
  it('one ask is one line', () => {
    const p: any = { batchId: 'b-8', frames: ['d/a'], members: [{ id: 'm1', kind: 'comment', frames: ['d/a'], brief: { asks: [{ id: 'e-1', body: '@marver the title smaller' }], history: [] } }] }
    expect(sessionBrief(p, 'r-8.1')).toContain('- on d/a, a tag: "the title smaller"')
    expect(sessionBrief(capture([], [{ at: 0, event: 'words', text: 'Make it calmer' }]), 'r-2.1')).toContain('- on d/a, the capture: "Make it calmer"')
  })
  it('a long first request never pushes a correction out: the newest leads whole, an earlier one is clipped', () => {
    const said = `Make the background red, ${'and tighten the spacing between every card of the pricing grid, '.repeat(8)}`
    const t = sessionBrief(capture([], [{ at: 0, event: 'words', text: said }], [{ at: 9, text: 'Correction: use blue, not red' }]), 'r-9.1')
    expect(t).toMatch(/newest first:\n  a read-back note: "Correction: use blue, not red"\n  the capture: "Make the background red, /)
    expect(t.split('\n').find((l) => l.startsWith('  the capture'))!.length).toBeLessThan(230)
    // the newest is whole up to ~1200 characters
    const long = sessionBrief(capture([{ id: 'mw-cap-1-4', body: said }], [{ at: 0, event: 'words', text: 'Redo the intro slide' }]), 'r-9.2')
    expect(long).toContain(said.trim())
  })
})

describe('the brief of a session record', () => {
  it('names the one file to write and the owner\'s instructions - no frames, no early line, a short reply', () => {
    const content = { format: 'marver.jam.wrapup', v: 1, id: 'abc', session: 's', since: 0, until: 1, instructions: 'Lead with decisions; backlog the rest', file: 'context/sessions/2026-10-27-1500-abc.md', captures: [], tags: 0, more: 'shorter, please' }
    const p: any = { batchId: 'b-3', frames: [], members: [{ id: 'm1', frames: [], brief: { asks: [], history: [], wrapup: { content, hash: 'h' } } }] }
    const t = sessionBrief(p, 'r-3.1')
    expect(t).toContain('write it to context/sessions/2026-10-27-1500-abc.md - that file only, no design work')
    expect(t).toContain('"Lead with decisions; backlog the rest"')
    expect(t).toContain('"shorter, please"')
    expect(t).toContain('ONE or TWO plain sentences')
    expect(t).not.toMatch(/jam say|Frames you may edit|Edit only those frames/)
    expect(t.split('\n').length).toBeLessThan(20)
  })
})

describe('a capture\'s last words', () => {
  it('are waited for 15 s after the cut, longer while the engine answers, never past a minute', () => {
    expect(finalWait(0, 0, FINAL_MS)).toBe(0)
    expect(finalWait(0, 10_000, FINAL_MS)).toBe(10_000)             // the engine answered 10 s in: 15 s more from then
    expect(finalWait(0, 59_000, 59_500)).toBe(FINAL_MAX - 59_500)    // still answering: a minute at most
  })
  it('are whole only when every segment came back - and, with the microphone on, when there was one', () => {
    expect(wordsWhole([true, true], false, true)).toBe(true)
    expect(wordsWhole([], false, true)).toBe(false)                  // yes to the microphone, nothing heard: incomplete
    expect(wordsWhole([], false, false)).toBe(true)                  // no microphone: nothing was expected
    expect(wordsWhole([true, false], false, true)).toBe(false)
    expect(wordsWhole([true], true, true)).toBe(false)
  })
})

describe('a draft the queue would not take', () => {
  it('reads Not queued on the lane, never To confirm', () => {
    const d: any = { id: 'cap-1-a', kind: 'capture', state: 'draft', at: Date.now(), made: 1, order: 1, rev: 1, events: [], frames: [] }
    expect(laneLine(d)).toBe('To confirm')
    expect(laneLine({ ...d, note: "a conflicting comment took this one's place - write it again" })).toBe('Not queued')
  })
})

describe('a copy that runs what your session did not take', () => {
  it('says why on the tile and in its detail', () => {
    const c: any = { id: 'c', state: 'working', at: Date.now(), runner: { kind: 'fork', agent: 'claude', why: "your session didn't take it - it was busy or away" } }
    expect(laneLine(c)).toMatch(/^Yours was busy · a copy is on it/)
    expect(runnerLine(c, () => 'Claude Code')!.detail).toMatch(/^Your session didn't take it/)
    expect(laneLine({ ...c, runner: { kind: 'fork', agent: 'claude' } })).toMatch(/^A copy of your session/)
    expect(laneLine({ ...c, runner: { kind: 'fork', agent: 'claude', why: "your session didn't take it - it already holds 3 runs" } })).toMatch(/^Yours was busy · a copy is on it/)
    expect(laneLine({ ...c, runner: { kind: 'fork', agent: 'codex', why: 'your session was idle - Codex takes a run only while it works' } })).toMatch(/^Yours was idle · a copy is on it/)
  })
  it('a run your session let go, or one whose Jam session ended, says that - never "busy"', () => {
    const c: any = { id: 'c', state: 'working', at: Date.now(), runner: { kind: 'fork', agent: 'claude', why: "your session didn't take it - it let it go" } }
    expect(laneLine(c)).toMatch(/^Yours let it go · a copy is on it/)
    expect(laneLine({ ...c, runner: { kind: 'fork', agent: 'claude', why: 'the Jam session had ended' } })).toMatch(/^Jam session ended · a copy is on it/)
  })
})
