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
  })
  it('when the reply asked something, every note answers it - "yes, thanks" is the footer request, never a verdict', () => {
    const asked = 'Done - the header is blue. Want me to apply this to the footer?'
    for (const t of ['yes, thanks', 'yes please', 'ok thanks', 'perfect', 'great, thanks', 'looks good, thanks', 'love it']) expect(isApproval(t, asked), t).toBe(false)
    expect(isApproval('yes, thanks', 'Done - the header is blue.')).toBe(true)
  })
  it('approval words joined by "and" still settle it', () => {
    for (const t of ['Looks good and works well', 'great and thanks', 'perfect and thank you']) expect(isApproval(t), t).toBe(true)
    for (const t of ['looks good and make the footer blue', 'good and now the footer']) expect(isApproval(t), t).toBe(false)
  })
  it('words it cannot read are never dropped to leave "looks good" behind - another script, a number, a symbol', () => {
    // "改成蓝色" is "change it to blue": stripped away, the note read as approval and the request was lost
    for (const t of ['Looks good, 改成蓝色', 'looks good, сделай синим', 'いいね、青にして', 'looks good, 24', 'looks good +10%', 'perfect 🔵']) expect(isApproval(t, 'Done'), t).toBe(false)
    // a skin tone or a variation selector on an approving emoji is not a word
    for (const t of ['👍🏽', 'looks good 👌🏻', 'great, thanks!', '"looks good" - thanks', 'Looks good :)']) expect(isApproval(t, 'Done'), t).toBe(true)
  })
})

describe('the brief of a capture sent back', () => {
  it('leads with the newest words; the capture is context', () => {
    const p: any = { batchId: 'b-1', frames: ['d/a'], members: [{ id: 'm1', kind: 'capture', frames: ['d/a'], brief: { asks: [{ id: 'mw-cap-1-4', body: '@marver the title smaller' }], history: [], capture: { record: { timeline: [{ at: 0, event: 'words', text: 'Redo the intro slide' }] } } } }] }
    const t = sessionBrief(p, 'r-1.1')
    expect(t).toMatch(/more work on d\/a, the owner's newest words: "the title smaller"/)
    expect(t.indexOf('the title smaller')).toBeLessThan(t.indexOf('the capture it follows'))
    expect(t).toContain('(the capture it follows, done before: "Redo the intro slide")')
  })
  it('a capture that never ran, with tags joined while it waited, is never "done before" - and every tag is asked', () => {
    // stopped while its frame was reserved, then two @marver clarifications in its thread joined the queued capture
    const p: any = { batchId: 'b-4', frames: ['d/a'], members: [{ id: 'm1', kind: 'capture', frames: ['d/a'], brief: { asks: [{ id: 'e-1', body: '@marver use the brand blue' }, { id: 'e-2', body: '@marver and keep the icon' }], history: [], capture: { record: { timeline: [{ at: 0, event: 'words', text: 'Redo the intro slide' }] } } } }] }
    const t = sessionBrief(p, 'r-4.1')
    expect(t).not.toMatch(/done before|more work/)
    expect(t).toMatch(/the owner's newest words: "and keep the icon"/)
    expect(t).toContain('use the brand blue')
    expect(t).toMatch(/not run yet[^\n]*"Redo the intro slide"/)
  })
  it('sent back again: only the note not run yet leads; the one already run is not asked again', () => {
    const p: any = { batchId: 'b-5', frames: ['d/a'], members: [{ id: 'm1', kind: 'capture', frames: ['d/a'], brief: { asks: [{ id: 'mw-cap-1-4', body: '@marver the title smaller' }, { id: 'mw-cap-1-9', body: '@marver now the subtitle' }], history: [], follows: { asks: [{ id: 'mw-cap-1-4', body: '@marver the title smaller' }], result: 'Done' }, capture: { record: { timeline: [{ at: 0, event: 'words', text: 'Redo the intro slide' }] } } } }] }
    const t = sessionBrief(p, 'r-5.1')
    expect(t).toMatch(/more work on d\/a, the owner's newest words: "now the subtitle"/)
    expect(t).not.toContain('the title smaller')
  })
  it('a tag on a capture that was kept, never run, says so', () => {
    const p: any = { batchId: 'b-6', frames: ['d/a'], members: [{ id: 'm1', kind: 'comment', frames: ['d/a'], brief: { asks: [{ id: 'e-3', body: '@marver do it after all' }], history: [], capture: { note: 'kept - not an ask', record: { timeline: [{ at: 0, event: 'words', text: 'Redo the intro slide' }] } } } }] }
    expect(sessionBrief(p, 'r-6.1')).not.toContain('done before')
  })
})

describe('the brief of a tag', () => {
  it('a later correction leads - never clipped away behind a long first request', () => {
    const long = `@marver ${'make the pricing table denser and align every column to the grid, '.repeat(6)}`
    const p: any = { batchId: 'b-7', frames: ['d/a'], members: [{ id: 'm1', kind: 'comment', frames: ['d/a'], brief: { asks: [{ id: 'e-1', body: long }, { id: 'e-2', body: '@marver Correction: use blue instead' }], history: [] } }] }
    const t = sessionBrief(p, 'r-7.1')
    expect(t).toMatch(/a tag on d\/a, the owner's newest words: "Correction: use blue instead"/)
    expect(t).toContain('make the pricing table denser')
  })
  it('one tag reads as before', () => {
    const p: any = { batchId: 'b-8', frames: ['d/a'], members: [{ id: 'm1', kind: 'comment', frames: ['d/a'], brief: { asks: [{ id: 'e-1', body: '@marver the title smaller' }], history: [] } }] }
    expect(sessionBrief(p, 'r-8.1')).toContain('- a tag on d/a: "the title smaller"')
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
  it('a run your session let go, or one whose Jam session ended, says that - never "busy"', () => {
    const c: any = { id: 'c', state: 'working', at: Date.now(), runner: { kind: 'fork', agent: 'claude', why: "your session didn't take it - it let it go" } }
    expect(laneLine(c)).toMatch(/^Yours let it go · a copy is on it/)
    expect(laneLine({ ...c, runner: { kind: 'fork', agent: 'claude', why: 'the Jam session had ended' } })).toMatch(/^Jam session ended · a copy is on it/)
  })
})
