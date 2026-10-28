import { describe, expect, it } from 'vitest'
import { laneLine, lineText, runnerLine, statusLines, timelineLines, type LaneCard } from '../src/client/shell/jam-lines.ts'
import type { CaptureRecord } from '../src/server/jam/types.ts'

const card = (o: Partial<LaneCard>): LaneCard => ({ id: 'cap-1', kind: 'capture', board: 'home', frames: [], events: [], state: 'queued', rev: 1, made: 0, order: 0, at: 0, ...o })

describe('the lane: a tile\'s status line', () => {
  it('says where each capture stands, with the queue position counting every queued card', () => {
    expect(laneLine(card({ state: 'draft' }))).toBe('To confirm')
    expect(laneLine(card({ state: 'confirming' }))).toBe('Confirming')
    expect(laneLine(card({ state: 'queued', position: 1 }))).toBe('Queued · next')
    // waiting on a frame another run holds: which one (its name without its scene), never a place in line
    expect(laneLine(card({ state: 'queued', waitsFor: { frame: 'test-deck/01-slide', by: 'Icon labels' } }))).toBe('Waits for 01-slide')
    expect(laneLine(card({ state: 'queued', position: 2 }))).toBe('Queued · 2nd')
    expect(laneLine(card({ state: 'queued', position: 13 }))).toBe('Queued · 13th')
    expect(laneLine(card({ state: 'working', at: 1000 }), 42_000)).toBe('Agent working · 0:41')
    expect(laneLine(card({ state: 'asks' }))).toBe('Asks you')
    expect(laneLine(card({ state: 'review' }))).toBe('Ready to review')
    expect(laneLine(card({ state: 'done' }))).toBe('Done')
    expect(laneLine(card({ state: 'done', shots: [{ frame: 'a' }, { frame: 'b' }] }))).toBe('Done · 2 frames')
    expect(laneLine(card({ state: 'kept' }))).toBe('Kept, not sent')
    expect(laneLine(card({ state: 'failed' }))).toBe('Failed · Retry')
  })

  it('a queued card that waits for more than its place says why, the tooltip too - never "Queued · next" (Nic, 28 Oct: a capture on an empty board sat "Queued · next" while it waited to run alone)', () => {
    expect(laneLine(card({ state: 'queued', position: 1, waiting: 'alone' }))).toBe('Waits to run alone')
    expect(laneLine(card({ state: 'queued', position: 1, waiting: 'behind', frames: ['deck/02-slide'] }))).toBe('Waits · a run goes alone first')
    expect(statusLines(card({ state: 'queued', position: 1, waiting: 'alone' }), 'claude', {})).toEqual({ head: 'Queued · waits to run alone', detail: 'It names no frame and runs on its own - it starts once the other work is done' })
    expect(statusLines(card({ state: 'queued', position: 1, waiting: 'alone', exclusive: true, frames: ['deck/01-slide'] }), 'claude', {}).detail).toBe('It changes a shared file and runs on its own - it starts once the other work is done')
    expect(statusLines(card({ state: 'queued', position: 1, waiting: 'behind' }), 'claude', {})).toEqual({ head: 'Queued · waits - a run goes alone first', detail: 'A request that runs on its own goes first - this one starts after it' })
  })

  it('one that runs alone and holds a frame another run works on (a shared-file job) says it waits to run alone - that run ending is not enough - and names the frame\'s run after (Codex\'s review: it read "Waits for first", and the tooltip said it starts when that run is done)', () => {
    const w = { frames: ['menu/first'], waitsFor: { frame: 'menu/first', by: 'Icon labels' } }
    expect(laneLine(card({ state: 'queued', waiting: 'alone', exclusive: true, ...w }))).toBe('Waits to run alone')
    expect(statusLines(card({ state: 'queued', waiting: 'alone', exclusive: true, ...w }), 'claude', {})).toEqual({ head: 'Queued · waits to run alone', detail: 'It changes a shared file and runs on its own - it starts once the other work is done; "Icon labels" is working on menu/first' })
    expect(laneLine(card({ state: 'queued', waiting: 'behind', ...w, waitsFor: { frame: 'menu/first', by: 'chat' } }))).toBe('Waits · a run goes alone first')
    expect(statusLines(card({ state: 'queued', waiting: 'behind', ...w, waitsFor: { frame: 'menu/first', by: 'chat' } }), 'claude', {}).detail).toBe('A request that runs on its own goes first - this one starts after it; your agent in chat is working on menu/first')
  })

  it('one with no frame while your session holds all the runs it can says so - a request after it may start first (Codex\'s review: it read "Queued · next")', () => {
    expect(laneLine(card({ state: 'queued', waiting: 'session' }))).toBe('Waits · your session is full')
    expect(statusLines(card({ state: 'queued', waiting: 'session' }), 'claude', {})).toEqual({ head: 'Queued · waits - your session is full', detail: 'Your session holds all the runs it can - this one goes to it when one of them ends' })
  })
})

describe('the read-back: a capture\'s merged timeline', () => {
  const t0 = 1_000_000
  const rec: CaptureRecord = {
    format: 'marver.jam.capture', v: 1, id: 'cap-1700000000000-abcd',
    context: { canvas: 'c', board: 'pricing' }, view: {}, pictures: ['p-0000000000000001'],
    timeline: [
      { at: t0, event: 'view', view: { board: 'pricing', frames: ['pricing/checkout'], viewport: 'laptop', width: 1280, height: 800, theme: 'light' } },
      { at: t0 + 1000, event: 'select', frames: ['pricing/checkout'] },
      { at: t0 + 4000, event: 'words', text: 'this badge' },
      { at: t0 + 5000, frame: 'pricing/checkout', event: 'pick', point: 1, mode: 'canvas', bundle: { tag: 'span', quote: 'Save 20%', source: 'design/scenes/pricing/checkout.tsx:48:7' } },
      { at: t0 + 9000, event: 'note', text: 'the outline one, not the filled pill' },
      { at: t0 + 10000, event: 'device', frame: 'pricing/checkout', viewport: 'Phone', width: 390, height: 844 },
      { at: t0 + 12000, event: 'theme', theme: 'dark' },
      { at: t0 + 13000, event: 'interact', on: true },
      { at: t0 + 15000, frame: 'pricing/checkout', event: 'click', point: 3, mode: 'interact', bundle: { tag: 'button', quote: 'Upgrade', source: 'design/scenes/pricing/checkout.tsx:62:9' } },
      { at: t0 + 16000, event: 'interact', on: false },
      { at: t0 + 17000, event: 'copied', what: 'path', frame: 'pricing/checkout' },
      { at: t0 + 18000, frame: 'pricing/checkout', event: 'field', bundle: { tag: 'input', quote: '•••' }, value: 'changed (12 characters)' },
      { at: t0 + 19000, frame: 'pricing/checkout', event: 'picture', id: 'p-0000000000000001', why: 'end' },
      { at: t0 + 19500, event: 'missing', what: 'a probe that never answered' },
    ],
  }

  it('reads in the spec\'s format: words and notes among every step, at the moment each happened', () => {
    expect(timelineLines(rec).map(lineText)).toEqual([
      '[0:00] (view) pricing / Checkout · laptop 1280×800 · light',
      '[0:01] (select) Checkout',
      '[0:04] "this badge"',
      '[0:05] (pick 1) <span> "Save 20%" · design/scenes/pricing/checkout.tsx:48',
      '[0:09] (note) "the outline one, not the filled pill"',
      '[0:10] (device) Checkout · Phone 390',
      '[0:12] (theme) dark',
      '[0:13] (interact on)',
      '[0:15] (click 3) <button> "Upgrade" · interact · design/scenes/pricing/checkout.tsx:62',
      '[0:16] (interact off)',
      '[0:17] (copied) path of Checkout',
      '[0:18] (field) <input> "•••" → changed (12 characters)',
      '[0:19] (picture 1) checkout at E',
      '[0:19] (missing) a probe that never answered',
    ])
  })

  it('your edit stands in for the words and the notes; every other step stays; an empty edit says so', () => {
    const lines = timelineLines(rec, 'make the badge the outline style')
    expect(lines[0]).toEqual({ t: '0:00', kind: 'words', text: '"make the badge the outline style"' })
    expect(lines.filter((l) => l.kind === 'words')).toHaveLength(1)
    expect(lines.filter((l) => l.kind === 'note')).toHaveLength(0)
    expect(timelineLines(rec, '')[0].text).toMatch(/no words/)
    expect(lines.find((l) => l.kind === 'pick')?.source).toBe('design/scenes/pricing/checkout.tsx:48')
  })
})

describe('who runs it, in words (spec 29b)', () => {
  const base = { id: 'c1', kind: 'comment' as const, board: 'b', frames: ['s/f'], events: ['e'], state: 'working' as const, rev: 1, made: 0, order: 0, at: Date.now() - 41_000 }
  const name = (a: string) => ({ claude: 'Claude Code', codex: 'Codex' } as Record<string, string>)[a] ?? a
  it('your session: offered, on it, stalled, stopping; a copy; a fresh agent', () => {
    const run = (r: object) => ({ ...base, runner: { batch: 'x', agent: 'claude', kind: 'session' as const, ...r } })
    expect(runnerLine(run({ state: 'offered' }), name)?.head).toMatch(/^Waiting for your Claude Code session · 0:4\d$/)
    expect(runnerLine(run({ state: 'claimed', gen: 1 }), name)?.head).toMatch(/^Your Claude Code session is on it · 0:4\d$/)
    expect(runnerLine(run({ state: 'stalled', gen: 1 }), name)?.detail).toBe('Give it back, run it in the background, or drop it')
    expect(runnerLine(run({ state: 'stopping', gen: 1 }), name)?.head).toContain('waiting for your Claude Code session to let go')
    expect(runnerLine({ ...base, runner: { batch: 'x', agent: 'codex', kind: 'fork' } }, name)?.head).toMatch(/^A copy of your Codex session is on it/)
    expect(runnerLine({ ...base, runner: { batch: 'x', agent: 'claude', kind: 'fresh', why: 'your session is too long to copy - a fresh agent took it' } }, name)?.detail).toContain('too long to copy')
    expect(runnerLine({ ...base, state: 'queued' }, name)).toBeNull()
    expect(laneLine({ ...base, runner: { batch: 'x', agent: 'claude', kind: 'session', state: 'stalled', gen: 1 } })).toBe('Stalled · choose')
    expect(laneLine({ ...base, runner: { batch: 'x', agent: 'claude', kind: 'fork' } })).toMatch(/^A copy of your session · /)
  })
})
