import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frameMark, isNew, nextToLook, questions, rollup, type Marks } from '../src/shared/marks.ts'
import { markSeen, readMarks, readSeen, recordChanged } from '../src/server/marks.ts'
import { scanFrames } from '../src/server/manifest.ts'
import type { Thread } from '../src/shared/events.ts'

const T = (id: string, frame: string, agentLast: boolean, extra: Partial<Thread> = {}): Thread => ({
  id, frame, ts: 1, resolved: false, agent: true, reactions: {},
  replies: agentLast ? [] : [{ id: `${id}-r`, ts: 2, body: 'my answer' }], ...extra,
})

describe('sidebar marks: the rules (spec 25)', () => {
  const m: Marks = { changed: { a: 200, b: 50, c: 300, d: 300 }, seen: { c: 400 }, baseline: 100, boards: {} }

  it('new = changed after both the baseline and your last look', () => {
    expect(isNew(m, 'a')).toBe(true)      // after the baseline, never seen
    expect(isNew(m, 'b')).toBe(false)     // before the baseline: already there the day marks arrived
    expect(isNew(m, 'c')).toBe(false)     // seen after it changed
    expect(isNew(null, 'a')).toBe(false)  // a published canvas has no marks
  })

  it("a question's state is read from its thread: Marver's word last needs you; yours last, answered", () => {
    const q = questions([
      T('t1', 'a', true),                                                    // Marver asked
      T('t2', 'a', true),                                                    // and again
      T('t3', 'b', false),                                                   // you answered
      T('t4', 'c', true, { resolved: true }),                                // closed: gone
      T('t5', 'd', true, { agent: false, replies: [] }),                     // a person's thread, no Marver: not a question
      T('t6', 'd', true, { agent: false, replies: [{ id: 'x', ts: 3, agent: true }] }),   // Marver's follow-up in it: needs you
    ])
    expect(q.get('a')).toEqual({ ask: 2, answered: 0 })
    expect(q.get('b')).toEqual({ ask: 0, answered: 1 })
    expect(q.has('c')).toBe(false)
    expect(q.get('d')).toEqual({ ask: 1, answered: 0 })
  })

  it('one slot: a question outranks answered, answered outranks new', () => {
    const q = questions([T('t1', 'a', true), T('t2', 'd', false)])
    expect(frameMark(m, q, 'a')).toEqual({ kind: 'ask', n: 1 })           // new AND a question: the question
    expect(frameMark(m, q, 'd')).toEqual({ kind: 'answered', n: 1 })
    expect(frameMark(m, new Map(), 'a')).toEqual({ kind: 'new' })
    expect(frameMark(m, new Map(), 'b')).toBe(null)
  })

  it('a roll-up counts open questions and new frames once each; answered questions do not count', () => {
    const q = questions([T('t1', 'a', true), T('t2', 'b', false)])
    expect(rollup(m, q, ['a', 'b', 'c', 'd', 'a'])).toEqual({ asks: 1, fresh: 2 })
  })

  it('U: the next frame that needs you, else the next new one, after the current one, wrapping', () => {
    const q = questions([T('t1', 'd', true)])
    const order = ['a', 'b', 'c', 'd']
    expect(nextToLook(m, q, order, null)).toBe('d')                        // a question first
    expect(nextToLook(m, new Map(), order, 'a')).toBe('d')                  // after a: d is new
    expect(nextToLook(m, new Map(), order, 'd')).toBe('a')                  // wraps
    expect(nextToLook({ ...m, seen: { a: 999, c: 999, d: 999 } }, new Map(), order, null)).toBe(null)
    expect(nextToLook(m, questions([T('t2', 'a', false)]), order, null)).toBe('d')   // a is new but answered: U skips it
  })
})

describe('sidebar marks: the dev server (spec 25)', () => {
  let root = ''
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })
  const mk = (p: string, c = 'export default () => null\n') => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), c) }
  const at = (p: string, ms: number) => utimesSync(join(root, p), ms / 1000, ms / 1000)

  it('the first read sets the baseline: everything already there counts as seen', () => {
    root = mkdtempSync(join(tmpdir(), 'mv-marks-'))
    const before = Date.now()
    const s = readSeen(root)
    expect(s.baseline).toBeGreaterThanOrEqual(before)
    expect(readSeen(root).baseline).toBe(s.baseline)                       // read again: the same line
  })

  it("changed = the latest of the frame's file, its sticky note, and work done; seen is the stamp you saw", async () => {
    root = mkdtempSync(join(tmpdir(), 'mv-marks-'))
    mk('design/scenes/s/a.tsx'); mk('design/scenes/s/a.note.md', 'a note'); mk('design/scenes/s/b.tsx')
    mk('design/boards/b1.json', JSON.stringify({ version: 1, name: 'b1', nodes: [{ frame: 's/a' }, { frame: 'gone/x' }] }))
    mk('design/boards/auto.json', JSON.stringify({ version: 1, name: 'auto', auto: true, nodes: [] }))
    at('design/scenes/s/a.tsx', 1_000_000); at('design/scenes/s/a.note.md', 2_000_000); at('design/scenes/s/b.tsx', 1_000_000)
    const manifest = scanFrames(root)
    const known = new Set(manifest.frames.map((f) => f.id))
    let m = readMarks(root, manifest)
    expect(m.changed['s/a']).toBe(2_000_000)                                // the note is newer than the frame
    expect(m.changed['s/b']).toBe(1_000_000)
    expect(m.boards.b1).toEqual(['s/a'])                                    // a pinned frame that no longer exists is dropped
    expect(m.boards.auto.sort()).toEqual(['s/a', 's/b'])                    // an auto board holds every frame
    expect(m.boards['all-scenes']).toBeUndefined()                         // no built-in everything-board (spec 26)
    await new Promise((r) => setTimeout(r, 5))                              // the baseline was set a moment ago
    recordChanged(root, ['s/b'])                                            // an agent named it in work done
    m = readMarks(root, manifest)
    const stamp = m.changed['s/b']
    expect(stamp).toBeGreaterThan(2_000_000)
    expect(isNew(m, 's/b')).toBe(true)
    markSeen(root, { 's/b': stamp, 'gone/frame': 5 }, known)               // you saw that change
    m = readMarks(root, manifest)
    expect(isNew(m, 's/b')).toBe(false)
    expect(Object.keys(JSON.parse(readFileSync(join(root, 'design', '.local', 'seen.json'), 'utf8')).frames)).toEqual(['s/b'])   // unknown ids dropped
    markSeen(root, { 's/b': 1 }, known)                                     // an older acknowledgement never lowers it
    expect(isNew(readMarks(root, manifest), 's/b')).toBe(false)
    await new Promise((r) => setTimeout(r, 5))
    recordChanged(root, ['s/b'])                                            // a change after you looked: new again
    expect(isNew(readMarks(root, manifest), 's/b')).toBe(true)
  })

  it('an empty canvas is still a started one: a frame moved in later, with an old mtime, counts as new', async () => {
    root = mkdtempSync(join(tmpdir(), 'mv-marks-'))
    mkdirSync(join(root, 'design', 'scenes'), { recursive: true })
    readMarks(root, scanFrames(root))                                       // marks start on an empty canvas
    await new Promise((r) => setTimeout(r, 5))
    mk('design/scenes/s/old.tsx'); at('design/scenes/s/old.tsx', 1_000_000)
    expect(isNew(readMarks(root, scanFrames(root)), 's/old')).toBe(true)
  })

  it('a sticky note deleted while dev was off is a change; a deleted frame leaves nothing behind', async () => {
    root = mkdtempSync(join(tmpdir(), 'mv-marks-'))
    mk('design/scenes/s/a.tsx'); mk('design/scenes/s/a.note.md', 'note'); mk('design/scenes/s/b.tsx')
    for (const p of ['design/scenes/s/a.tsx', 'design/scenes/s/a.note.md', 'design/scenes/s/b.tsx']) at(p, 1_000_000)
    let m = readMarks(root, scanFrames(root))
    markSeen(root, { 's/a': m.changed['s/a'], 's/b': m.changed['s/b'] }, new Set(['s/a', 's/b']))
    await new Promise((r) => setTimeout(r, 5))
    rmSync(join(root, 'design/scenes/s/a.note.md'))                         // a git pull while dev was off
    rmSync(join(root, 'design/scenes/s/b.tsx'))
    m = readMarks(root, scanFrames(root))
    expect(isNew(m, 's/a')).toBe(true)
    const seenFile = JSON.parse(readFileSync(join(root, 'design', '.local', 'seen.json'), 'utf8'))
    expect(Object.keys(seenFile.frames)).toEqual(['s/a'])                     // b's mark is gone with b
  })

  it('a frame under a new id - added, or renamed with its old mtime - counts as new', async () => {
    root = mkdtempSync(join(tmpdir(), 'mv-marks-'))
    mk('design/scenes/s/a.tsx'); at('design/scenes/s/a.tsx', 1_000_000)
    readMarks(root, scanFrames(root))                                       // the first read: everything seen, the ids recorded
    await new Promise((r) => setTimeout(r, 5))
    rmSync(join(root, 'design/scenes/s/a.tsx'))
    mk('design/scenes/s/renamed.tsx'); at('design/scenes/s/renamed.tsx', 1_000_000)   // a rename keeps the old mtime
    const m = readMarks(root, scanFrames(root))
    expect(isNew(m, 's/renamed')).toBe(true)
    expect(m.changed['s/a']).toBeUndefined()
  })
})
