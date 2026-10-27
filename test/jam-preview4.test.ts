import { describe, expect, it } from 'vitest'
import { isApproval } from '../src/shared/approval.ts'
import { sessionBrief } from '../src/server/jam/session-brief.ts'
import { laneLine, runnerLine } from '../src/client/shell/jam-lines.ts'
import { finalWait, FINAL_MAX, FINAL_MS, wordsWhole } from '../src/client/shell/jam-voice-wait.ts'

describe('a More-work note that only approves', () => {
  it('reads as Looks good; anything asking for a change does not', () => {
    for (const t of ['looks good', 'Looks good!', 'LGTM', 'perfect, thanks', 'great', 'ok thanks', '@marver looks good', 'love it', 'nice work'.replace('work', '')]) expect(isApproval(t), t).toBe(true)
    for (const t of ['looks good but make it bigger', 'not good', 'make it blue', 'good start, now the footer', '', 'ok']) expect(isApproval(t), t).toBe(t === 'ok')
  })
  it('the common ways to say it settle too - contractions, "to me", "work", "job", emoji, a longer thanks', () => {
    for (const t of ['looks good to me', 'Looks good to me', 'nice work', 'great work', 'good job', 'great job', "that's great", "that's perfect", 'That’s perfect',
      "it's perfect", "it's great", "that's it, thanks", 'I love it', 'I like it', 'exactly', 'nailed it', 'good stuff', 'this is great work', '👍',
      "Perfect, that's exactly what I wanted", 'that looks really good, thanks a lot', 'This looks really good now, thank you so much!']) expect(isApproval(t), t).toBe(true)
  })
  it('a question is never one; nor a bare yes or ok answering the reply\'s own question', () => {
    for (const t of ['is this better?', 'is it done?', 'done?', 'it works?', 'really good?', 'is this done', 'looks like a lot', 'what I wanted', 'again']) expect(isApproval(t), t).toBe(false)
    const asked = 'Done - the header is blue. Want me to apply the same to the footer?'
    for (const t of ['yes', 'ok', 'yep']) { expect(isApproval(t, asked), t).toBe(false); expect(isApproval(t, 'Done - the header is blue.'), t).toBe(true) }
    expect(isApproval('looks good, thanks', asked)).toBe(true)
  })
})

describe('the brief of a capture sent back', () => {
  it('leads with the newest words; the capture is context', () => {
    const p: any = { batchId: 'b-1', frames: ['d/a'], members: [{ id: 'm1', frames: ['d/a'], brief: { asks: [{ body: '@marver the title smaller' }], capture: { record: { timeline: [{ at: 0, event: 'words', text: 'Redo the intro slide' }] } } } }] }
    const t = sessionBrief(p, 'r-1.1')
    expect(t).toMatch(/more work on d\/a, the owner's newest words: "the title smaller"/)
    expect(t.indexOf('the title smaller')).toBeLessThan(t.indexOf('the capture it follows'))
    expect(t).toContain('(the capture it follows, done before: "Redo the intro slide")')
  })
  it('a capture\'s notes added in its read-back are the owner\'s words too - after what was said, or alone', () => {
    const cap = (timeline: unknown[]) => ({ batchId: 'b-2', frames: ['d/a'], members: [{ id: 'm1', frames: ['d/a'], brief: { asks: [], capture: { record: { timeline }, added: [{ at: 9, text: 'and use the brand blue for the headline' }] } } }] }) as any
    expect(sessionBrief(cap([{ at: 0, event: 'words', text: 'Make the intro slide calmer' }]), 'r-2.1')).toContain('a voice capture on d/a: "Make the intro slide calmer / and use the brand blue for the headline"')
    expect(sessionBrief(cap([]), 'r-2.1')).toContain('a voice capture on d/a: "and use the brand blue for the headline"')
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
})
